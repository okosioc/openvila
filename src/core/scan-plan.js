import path from "node:path";
import ignore from "ignore";
import {
  discoverDatabaseTargets,
  listDatabaseTableColumns,
  listDatabaseTables,
  quoteDatabaseIdentifier,
  resolveDatabaseTarget,
} from "../utils/db.js";
import { listFilesRecursive, readTextSafe, toPosixPath, writeText } from "../utils/fs.js";
import { runtimePaths } from "./runtime.js";

const KNOWLEDGE_EXTENSIONS = [
  ".md",
  ".txt",
  ".html",
  ".htm",
  ".py",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".vue",
  ".njk",
  ".jinja",
  ".j2",
  ".php",
  ".xml",
  ".astro",
];

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim().length > 0))];
}

function toArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(Math.floor(parsed), max));
}

function sanitizeNamePart(value, maxLen = 24) {
  return (
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, maxLen)
  );
}

function sanitizeQueryName(value) {
  return (
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 96) || "scan_query"
  );
}

async function loadGitignoreMatcher(cwd) {
  const content = await readTextSafe(path.join(cwd, ".gitignore"));
  if (content === null) {
    return null;
  }
  const matcher = ignore().add(content);
  return (relativePath, isDirectory) =>
    matcher.ignores(relativePath) || (isDirectory && matcher.ignores(`${relativePath}/`));
}

export async function loadKnowledgeScanPlan(cwd) {
  const planPath = runtimePaths(cwd).scanPlan;
  const raw = await readTextSafe(planPath);
  if (raw === null) {
    return null;
  }
  return parseKnowledgeScanPlan(raw, planPath);
}

export function parseKnowledgeScanPlan(raw, planPath = "") {
  const files = [];
  const databasesByUrl = new Map();
  const lines = String(raw ?? "").split(/\r?\n/);

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("file://")) {
      const filePattern = line.slice("file://".length).trim();
      if (filePattern) {
        files.push(filePattern);
        continue;
      }
    } else {
      const separator = line.lastIndexOf("::");
      const connectionUrl = line.slice(0, separator).trim();
      const tableName = line.slice(separator + 2).trim();
      if (separator > 0 && connectionUrl && tableName) {
        if (!databasesByUrl.has(connectionUrl)) {
          databasesByUrl.set(connectionUrl, { connection_url: connectionUrl, tables: [] });
        }
        databasesByUrl.get(connectionUrl).tables.push(tableName);
        continue;
      }
    }
    throw new Error(`Invalid scan plan line ${index + 1}${planPath ? `: ${planPath}` : ""}`);
  }

  const databases = [...databasesByUrl.values()].map((entry) => ({ ...entry, tables: unique(entry.tables) }));
  return {
    files: unique(files),
    ...(databases.length === 1 ? { database: databases[0] } : databases.length > 1 ? { databases } : {}),
  };
}

export function stringifyKnowledgeScanPlan(plan) {
  const fileLines = unique(toArray(plan?.files)).map((filePattern) => `file://${filePattern}`);
  const databaseLines = scanPlanDatabaseEntries(plan).flatMap((entry) => {
    const connectionUrl = String(entry?.connection_url || "").trim();
    if (!connectionUrl) {
      return [];
    }
    return unique(toArray(entry.tables)).map((tableName) => `${connectionUrl}::${tableName}`);
  });
  const lines = [...fileLines, ...databaseLines];
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export async function saveKnowledgeScanPlan(cwd, plan) {
  const generatedPlan = plan?.generated_scan_plan;
  if (!generatedPlan) {
    return null;
  }
  const planPath = runtimePaths(cwd).scanPlan;
  await writeText(planPath, stringifyKnowledgeScanPlan(generatedPlan));
  return planPath;
}

export async function collectFilesystemCandidates(cwd, config) {
  const maxFiles = Number(config?.scan?.max_files || 1200) || 1200;
  const gitignoreMatcher = await loadGitignoreMatcher(cwd);
  const allFiles = await listFilesRecursive(cwd, {
    onlyExt: KNOWLEDGE_EXTENSIONS,
    maxFileSize: 300 * 1024,
    maxFiles,
    shouldIgnore: gitignoreMatcher,
  });
  return allFiles.map((fullPath) => toPosixPath(path.relative(cwd, fullPath))).sort();
}

function scanPlanPatterns(scanPlan) {
  return unique(
    toArray(scanPlan?.files)
      .map((pattern) => toPosixPath(String(pattern || "").trim().replace(/^\.\//, "")).replace(/^\/+/, ""))
      .filter(Boolean),
  );
}

function scanPlanPatternRegex(pattern) {
  let regex = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          regex += "(?:.*/)?";
        } else {
          regex += ".*";
        }
      } else {
        regex += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      regex += "[^/]";
      continue;
    }
    regex += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${regex}$`);
}

export function expandScanPlanFiles(candidatePaths, scanPlan) {
  const patterns = scanPlanPatterns(scanPlan).map(scanPlanPatternRegex);
  if (patterns.length === 0) {
    return [];
  }
  return candidatePaths.filter((candidatePath) => patterns.some((pattern) => pattern.test(candidatePath)));
}

function queryTargetBase(target, engine) {
  if (engine === "sqlite") {
    const sqlitePath = String(target?.sqlite_path || target?.db_path || "").trim();
    const base = sqlitePath ? path.basename(sqlitePath).replace(/\.[^.]+$/, "") : "";
    return sanitizeNamePart(base, 28) || "sqlite";
  }

  let host = "";
  let port = "";
  let database = "";
  const connectionUrl = String(target?.connection_url || "").trim();
  if (connectionUrl) {
    try {
      const parsed = new URL(connectionUrl);
      host = parsed.hostname || "";
      port = parsed.port || "";
      database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    } catch {}
  }

  host = host || String(target?.host || "").trim();
  port = port || String(target?.port || "").trim();
  database = database || String(target?.database || "").trim();
  const parts = [
    sanitizeNamePart(host, 22),
    port ? sanitizeNamePart(`p${port}`, 10) : "",
    sanitizeNamePart(database, 22),
  ].filter(Boolean);
  return parts.join("_") || engine;
}

function scanPlanDatabaseEntries(scanPlan) {
  const entries = [];
  if (scanPlan?.database && typeof scanPlan.database === "object" && !Array.isArray(scanPlan.database)) {
    entries.push(scanPlan.database);
  }
  if (Array.isArray(scanPlan?.databases)) {
    entries.push(...scanPlan.databases);
  }
  return entries.filter((entry) => entry && typeof entry === "object");
}

export function emptyDatabasePlan() {
  return {
    queries: [],
    selected_table_keys: [],
    discovery: {
      database_count: 0,
      table_count: 0,
      selected_tables: 0,
      candidate_tables: 0,
      discovered_files: [],
      mentioned_tokens: [],
      unresolved_tokens: [],
      by_engine: {
        sqlite: 0,
        mysql: 0,
        postgresql: 0,
        mongodb: 0,
      },
    },
  };
}

export function databasePlanFromScanPlan(cwd, config, scanPlan) {
  const queries = [];
  const selectedTableKeys = [];
  const byEngine = {
    sqlite: 0,
    mysql: 0,
    postgresql: 0,
    mongodb: 0,
  };
  const databaseEntries = scanPlanDatabaseEntries(scanPlan);

  for (const entry of databaseEntries) {
    const target = resolveDatabaseTarget(cwd, entry);
    if (!target) {
      continue;
    }
    byEngine[target.engine] = (byEngine[target.engine] || 0) + 1;
    const limit = clampInt(config?.scan?.db_auto_query_limit, 1, 300, 80);
    const tableNames = unique(toArray(entry.tables).map((tableName) => String(tableName || "").trim()));
    for (const tableName of tableNames) {
      const targetBase = queryTargetBase(target, target.engine);
      const name = sanitizeQueryName(`plan_${target.engine}_${targetBase}_${tableName}`);
      const query =
        target.engine === "mongodb"
          ? JSON.stringify({ collection: tableName, filter: {}, sort: { _id: -1 }, limit })
          : `SELECT * FROM ${quoteDatabaseIdentifier(target.engine, tableName)} LIMIT ${limit}`;
      queries.push({
        name,
        engine: target.engine,
        target,
        target_label: target.label,
        table_name: tableName,
        query,
        limit,
      });
      selectedTableKeys.push(`${target.key}::${tableName}`);
    }
  }

  return {
    queries,
    selected_table_keys: selectedTableKeys,
    discovery: {
      database_count: databaseEntries.length,
      table_count: queries.length,
      candidate_tables: queries.length,
      selected_tables: queries.length,
      discovered_files: [],
      mentioned_tokens: [],
      unresolved_tokens: [],
      by_engine: byEngine,
    },
  };
}

export async function collectAutoDatabaseCandidates(cwd, config) {
  const discovered = await discoverDatabaseTargets(cwd, {
    maxFiles: clampInt(config?.scan?.db_auto_max_files, 20, 500, 220),
    maxSourceFiles: clampInt(config?.scan?.db_auto_max_source_files, 300, 3000, 1600),
    maxSourceFileSize: clampInt(config?.scan?.db_auto_max_source_file_size, 16 * 1024, 256 * 1024, 96 * 1024),
  });
  const targets = (discovered.targets || []).slice().sort((a, b) => String(a?.key || "").localeCompare(String(b?.key || "")));
  const maxCandidates = clampInt(config?.scan?.db_auto_max_candidate_tables, 20, 1200, 360);
  const tableCandidates = [];
  let totalTables = 0;

  for (const target of targets) {
    const tables = await listDatabaseTables(target).catch(() => []);
    totalTables += tables.length;
    for (const tableName of tables) {
      const columns = await listDatabaseTableColumns(target, tableName).catch(() => []);
      tableCandidates.push({
        key: `${target.key}::${tableName}`,
        engine: target.engine,
        target_key: target.key,
        target_label: target.label,
        target,
        table_name: tableName,
        columns,
      });
      if (tableCandidates.length >= maxCandidates) {
        break;
      }
    }
    if (tableCandidates.length >= maxCandidates) {
      break;
    }
  }

  return {
    table_candidates: tableCandidates,
    discovery: {
      database_count: targets.length,
      table_count: totalTables,
      candidate_tables: tableCandidates.length,
      discovered_files: discovered.discovered_files || [],
      mentioned_tokens: discovered.mentioned_tokens || [],
      unresolved_tokens: discovered.unresolved_tokens || [],
      by_engine: discovered.by_engine || emptyDatabasePlan().discovery.by_engine,
    },
  };
}

export function buildAutoDatabasePlan(config, selectedTableKeys = [], autoDbCandidates = null) {
  const candidateBundle = autoDbCandidates || {
    table_candidates: [],
    discovery: emptyDatabasePlan().discovery,
  };
  const tableCandidates = Array.isArray(candidateBundle.table_candidates) ? candidateBundle.table_candidates : [];
  const selectedKeySet = new Set(unique(toArray(selectedTableKeys).map((item) => String(item || "").trim())));
  const maxTables = clampInt(config?.scan?.db_auto_max_tables, 1, 40, 6);
  const limit = clampInt(config?.scan?.db_auto_query_limit, 1, 300, 80);
  const selectedCandidates = tableCandidates
    .filter((item) => selectedKeySet.has(item.key))
    .slice(0, maxTables);
  const queries = selectedCandidates.map((item) => {
      const targetBase = queryTargetBase(item.target, item.engine);
      const name = sanitizeQueryName(`auto_${item.engine}_${targetBase}_${item.table_name}`);
      const query =
        item.engine === "mongodb"
          ? JSON.stringify({ collection: item.table_name, filter: {}, sort: { _id: -1 }, limit })
          : `SELECT * FROM ${quoteDatabaseIdentifier(item.engine, item.table_name)} LIMIT ${limit}`;
      return {
        name,
        engine: item.engine,
        target: item.target,
        target_label: item.target_label,
        table_name: item.table_name,
        query,
        limit,
      };
    });

  return {
    queries,
    selected_table_keys: selectedCandidates.map((item) => item.key),
    discovery: {
      ...(candidateBundle.discovery || emptyDatabasePlan().discovery),
      selected_tables: queries.length,
    },
  };
}

function generatedDatabasePlan(queries) {
  const entriesByTarget = new Map();
  for (const query of queries) {
    if (!query?.target || !query.table_name) {
      continue;
    }
    const target = query.target;
    const key = String(target.key || `${query.engine}:${query.target_label || query.name}`);
    if (!entriesByTarget.has(key)) {
      const entry = { connection_url: target.connection_url, tables: [] };
      entriesByTarget.set(key, entry);
    }
    entriesByTarget.get(key).tables.push(query.table_name);
  }

  const entries = [...entriesByTarget.values()].map((entry) => ({ ...entry, tables: unique(entry.tables) }));
  if (entries.length === 1) {
    return { database: entries[0] };
  }
  return entries.length > 1 ? { databases: entries } : {};
}

export function generatedScanPlan(filesystem, database) {
  return {
    files: filesystem.matched_paths,
    ...generatedDatabasePlan(database?.queries || []),
  };
}
