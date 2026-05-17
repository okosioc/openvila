import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  discoverDatabaseTargets,
  listDatabaseTableColumns,
  listDatabaseTables,
  resolveDatabaseTarget,
  runDatabaseJsonQuery,
  stringifyDbRow,
  quoteDatabaseIdentifier,
} from "../utils/db.js";
import { cleanTextForPrompt, listFilesRecursive, readTextSafe, toPosixPath, writeText } from "../utils/fs.js";
import { chatCompletion, extractJsonObject } from "./llm.js";
import { ensureRuntime, loadConfig, resolveLlmSettings, runtimePaths } from "./runtime.js";

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
  ".css",
  ".scss",
  ".vue",
  ".njk",
  ".jinja",
  ".j2",
  ".php",
  ".xml",
];

function zhLocale(locale) {
  return String(locale || "").toLowerCase().startsWith("zh");
}

function t(locale, zhText, enText) {
  return zhLocale(locale) ? zhText : enText;
}

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

function parseBooleanLike(value) {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return false;
  }
  return ["true", "1", "yes", "y", "是", "高频", "常见"].includes(normalized);
}

function limitText(value, maxLen) {
  return cleanTextForPrompt(String(value || ""), maxLen);
}

function normalizeOrigin(origin, source = "") {
  const normalized = String(origin || "").trim().toLowerCase();
  if (normalized === "database" || String(source).startsWith("db:")) {
    return "database";
  }
  if (normalized === "remote" || /^https?:\/\//i.test(String(source || ""))) {
    return "remote";
  }
  return "filesystem";
}

function docPrefixByOrigin(origin) {
  if (origin === "database") {
    return "db";
  }
  if (origin === "remote") {
    return "url";
  }
  return "fs";
}

function docBaseNameNoHash(source) {
  const normalizedSource = toPosixPath(String(source || "").trim()).toLowerCase();
  return (
    normalizedSource
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 170) || "source"
  );
}

function docStoredPathForDoc(doc) {
  const source = String(doc?.source || doc?.id || "doc").trim();
  const origin = normalizeOrigin(doc?.origin, source);
  const prefix = docPrefixByOrigin(origin);
  let sourceForName = source;
  if (origin === "database") {
    sourceForName = sourceForName.replace(/^db:/i, "");
  } else if (origin === "remote") {
    sourceForName = sourceForName.replace(/^https?:\/\//i, "");
  }
  const base = docBaseNameNoHash(sourceForName);
  return `docs/${prefix}-${base}.md`;
}

function sourceHashForDoc(doc) {
  return crypto
    .createHash("sha1")
    .update(`${doc.origin}\n${doc.source}\n${doc.content}`)
    .digest("hex");
}

function ensureLlmReady(config) {
  const llm = resolveLlmSettings(config, process.env);
  if (!llm.endpoint || !llm.apiKey || !llm.model) {
    throw new Error(
      `LLM is required for /scan. Set ${llm.endpointEnvNames[0]} / ${llm.apiKeyEnvNames[0]} / ${llm.modelEnvNames[0]} or save llm.endpoint / llm.api_key / llm.model in .openvila/config.yaml`,
    );
  }
  return llm;
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function formatTableCandidatesForPrompt(tableCandidates) {
  if (!Array.isArray(tableCandidates) || tableCandidates.length === 0) {
    return "(none)";
  }
  return tableCandidates
    .map((item) => {
      const columns = toArray(item.columns)
        .map((column) => {
          const name = String(column?.name || "").trim();
          const type = String(column?.type || "").trim();
          if (!name) return "";
          return type ? `${name}(${type})` : name;
        })
        .filter(Boolean)
        .join(", ");
      return [
        `- key: ${item.key}`,
        `  engine: ${item.engine}`,
        `  target: ${item.target_label}`,
        `  table: ${item.table_name}`,
        `  columns: ${columns || "(none)"}`,
      ].join("\n");
    })
    .join("\n");
}

// 核心逻辑! 根据候选源列表，调用 LLM 进行框架推断和知识源筛选。
async function pickKnowledgesByLlm(config, options = {}) {
  const candidatePaths = Array.isArray(options.candidatePaths) ? options.candidatePaths : [];
  const tableCandidates = Array.isArray(options.tableCandidates) ? options.tableCandidates : [];
  const llm = ensureLlmReady(config);
  if (candidatePaths.length === 0 && tableCandidates.length === 0) {
    return {
      framework: "unknown",
      framework_signals: [],
      knowledge_files: [],
      knowledge_tables: [],
      model: llm.model,
    };
  }

  const llmCandidateLimit = Math.max(60, Math.min(Number(config?.scan?.llm_candidate_limit || 420) || 420, 900));
  const llmTableCandidateLimit = Math.max(
    20,
    Math.min(Number(config?.scan?.llm_table_candidate_limit || 260) || 260, 800),
  );
  const fileSample = candidatePaths.slice(0, llmCandidateLimit);
  const tableSample = tableCandidates.slice(0, llmTableCandidateLimit);

  const messages = [
    {
      role: "system",
      content:
        'You are a knowledge scan planner. Infer framework from candidate file paths and pick knowledge-relevant database tables. Return JSON only: {"framework":"...","framework_signals":["..."],"knowledge_files":["..."],"knowledge_tables":["..."]}. framework: project framework (flask/nextjs/wordpress/etc). framework_signals: specific file/dir signals. knowledge_files: files with user-visible factual content. knowledge_tables: table keys with user-facing factual content.',
    },
    {
      role: "user",
      content: [
        `Candidate file count: ${fileSample.length}`,
        "Candidates:",
        fileSample.join("\n") || "(none)",
        "",
        `Candidate table count: ${tableSample.length}`,
        "Table candidates:",
        formatTableCandidatesForPrompt(tableSample),
        "",
        "Constraints:",
        "- Choose knowledge_files from candidates only.",
        "- Choose knowledge_tables from table candidate keys only.",
        "- Prioritize business text pages: pricing, terms, privacy, refund, faq/help, about/contact, product docs, support, policy pages, blog index/posts.",
        "- Prioritize tables holding user-visible business knowledge: pages/posts/articles/faq/policies/pricing/help/docs content.",
        "- Exclude static/code-only files: assets/**, static/**, public/**, dist/**, build/**, vendor/**, node_modules/**.",
        "- Exclude style/script/media files: *.css, *.scss, *.sass, *.less, *.js.map, *.css.map, *.min.js, *.min.css, images/fonts/videos.",
        "- Exclude lock/generated files: package-lock.json, pnpm-lock.yaml, yarn.lock, bun.lockb, poetry.lock, composer.lock.",
        "- Exclude infra/system tables by default: migrations, alembic_version, sessions, cache, jobs, logs, audit tables.",
        "- Do NOT pad file count. It is valid to return fewer than 12 if fewer relevant files exist.",
        "- If uncertain whether a file/table carries user-facing business knowledge, exclude it.",
      ].join("\n"),
    },
  ];

  const completion = await chatCompletion(config, messages, {
    temperature: 0,
    maxTokens: 1600,
    trace: "scan:file_planning",
  });
  if (!completion.ok) {
    throw new Error(`LLM file planning failed: ${completion.error}`);
  }

  const parsed = extractJsonObject(completion.content);
  const framework = String(parsed?.framework || "")
    .trim()
    .toLowerCase() || "unknown";
  const frameworkSignals = unique(
    (Array.isArray(parsed?.framework_signals) ? parsed.framework_signals : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean),
  );

  const available = new Set(candidatePaths);
  const knowledgeFiles = unique(
    (Array.isArray(parsed?.knowledge_files) ? parsed.knowledge_files : [])
      .map((item) => toPosixPath(String(item || "").trim().replace(/^\.\//, "")))
      .filter((item) => available.has(item)),
  );
  const tableKeyMap = new Map();
  const tableNameMap = new Map();
  for (const item of tableCandidates) {
    const key = String(item.key || "").trim();
    const tableName = String(item.table_name || "").trim().toLowerCase();
    if (!key) continue;
    tableKeyMap.set(key.toLowerCase(), key);
    if (tableName) {
      if (tableNameMap.has(tableName)) {
        tableNameMap.set(tableName, "");
      } else {
        tableNameMap.set(tableName, key);
      }
    }
  }
  const rawKnowledgeTables = Array.isArray(parsed?.knowledge_tables)
    ? parsed.knowledge_tables
    : Array.isArray(parsed?.knowleadge_tables)
      ? parsed.knowleadge_tables
      : [];
  const knowledgeTables = unique(
    rawKnowledgeTables
      .map((item) => {
        const normalized = String(item || "").trim().toLowerCase();
        if (!normalized) return "";
        return tableKeyMap.get(normalized) || tableNameMap.get(normalized) || "";
      })
      .filter(Boolean),
  );

  if (knowledgeFiles.length === 0 && knowledgeTables.length === 0) {
    throw new Error("LLM file planning returned no knowledge_files/knowledge_tables.");
  }

  return {
    framework,
    framework_signals: frameworkSignals,
    knowledge_files: knowledgeFiles,
    knowledge_tables: knowledgeTables,
    model: llm.model,
  };
}

function normalizeDbQueryConfig(cwd, rawQueries) {
  return rawQueries
    .map((item, idx) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const name = String(item.name || `query_${idx + 1}`).trim();
      const query = String(item.query || item.sql || "").trim();
      const limit = Math.max(1, Math.min(Number(item.limit || 50) || 50, 300));

      const target = resolveDatabaseTarget(cwd, item);
      if (!target) {
        return null;
      }

      let normalizedQuery = query;
      if (!normalizedQuery && target.engine === "mongodb") {
        const collection = String(item.collection || item.mongo_collection || "").trim();
        if (!collection) {
          return null;
        }
        const spec = {
          collection,
          filter: item.filter && typeof item.filter === "object" ? item.filter : {},
          sort: item.sort && typeof item.sort === "object" ? item.sort : undefined,
          projection: item.projection && typeof item.projection === "object" ? item.projection : undefined,
          limit,
        };
        normalizedQuery = JSON.stringify(spec);
      }
      if (!normalizedQuery) {
        return null;
      }

      return {
        name,
        engine: target.engine,
        target,
        target_label: target.label,
        query: normalizedQuery,
        limit,
      };
    })
    .filter(Boolean);
}

function configuredDatabaseQueries(cwd, config) {
  const rawQueries = [
    ...toArray(config?.scan?.database_queries),
    ...toArray(config?.scan?.database?.queries),
  ];
  return normalizeDbQueryConfig(cwd, rawQueries);
}

function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(Math.floor(parsed), max));
}

function sanitizeQueryName(value) {
  return (
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 96) || "auto_query"
  );
}

function tableCandidateKey(targetKey, tableName) {
  return `${targetKey}::${tableName}`;
}

function normalizeSelectedKnowledgeTables(values) {
  return unique(toArray(values).map((item) => String(item || "").trim()));
}

async function collectAutoDatabaseCandidates(cwd, config) {
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
        key: tableCandidateKey(target.key, tableName),
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
    auto_discovery: {
      database_count: targets.length,
      table_count: totalTables,
      candidate_tables: tableCandidates.length,
      discovered_files: discovered.discovered_files || [],
      mentioned_tokens: discovered.mentioned_tokens || [],
      unresolved_tokens: discovered.unresolved_tokens || [],
      by_engine: discovered.by_engine || {
        sqlite: 0,
        mysql: 0,
        postgresql: 0,
        mongodb: 0,
      },
    },
  };
}

async function buildAutoDatabasePlan(cwd, config, knowledgeTables = [], autoDbCandidates = null) {
  const candidateBundle = autoDbCandidates || (await collectAutoDatabaseCandidates(cwd, config));
  const tableCandidates = Array.isArray(candidateBundle?.table_candidates) ? candidateBundle.table_candidates : [];
  const selectedTableKeys = new Set(normalizeSelectedKnowledgeTables(knowledgeTables));

  const selectedTables = tableCandidates.filter((item) => selectedTableKeys.has(item.key));
  const maxTables = clampInt(config?.scan?.db_auto_max_tables, 1, 40, 6);
  const limit = clampInt(config?.scan?.db_auto_query_limit, 1, 300, 80);
  const queries = selectedTables
    .slice(0, maxTables)
    .map((item) => {
      const targetBase =
        String(item.target_key || item.target_label || item.engine || "db")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "")
          .slice(0, 40) || "db";
      const queryName = sanitizeQueryName(`auto_${item.engine}_${targetBase}_${item.table_name}`);
      const query =
        item.engine === "mongodb"
          ? JSON.stringify({
              collection: item.table_name,
              filter: {},
              sort: { _id: -1 },
              limit,
            })
          : `SELECT * FROM ${quoteDatabaseIdentifier(item.engine, item.table_name)} LIMIT ${limit}`;
      return {
        name: queryName,
        engine: item.engine,
        target: item.target,
        target_label: item.target_label,
        query,
        limit,
      };
    })
    .filter(Boolean);

  return {
    queries,
    source: queries.length > 0 ? "auto" : "none",
    auto_discovery: {
      ...(candidateBundle?.auto_discovery || {
        database_count: 0,
        table_count: 0,
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
      }),
      selected_tables: queries.length,
    },
  };
}

function inferLocale(config) {
  return String(config?.language || "en");
}

export async function prepareKnowledgeScanPlan(cwd, options = {}) {
  const config =
    options.config ||
    (await loadConfig(cwd, {
      createIfMissing: false,
    }).catch(() => ({})));

  const configuredQueries = configuredDatabaseQueries(cwd, config);
  const autoDbEnabled = config?.scan?.db_auto !== false;
  const autoDbCandidates =
    autoDbEnabled && configuredQueries.length === 0
      ? await collectAutoDatabaseCandidates(cwd, config)
      : {
          table_candidates: [],
          auto_discovery: {
            database_count: 0,
            table_count: 0,
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

  const maxFiles = Number(config?.scan?.max_files || 1200) || 1200;
  const allFiles = await listFilesRecursive(cwd, {
    onlyExt: KNOWLEDGE_EXTENSIONS,
    maxFileSize: 300 * 1024,
    maxFiles,
  });
  const relatives = allFiles.map((fullPath) => toPosixPath(path.relative(cwd, fullPath))).sort();

  const llmResult = await pickKnowledgesByLlm(config, {
    candidatePaths: relatives,
    tableCandidates: autoDbCandidates.table_candidates || [],
  });

  const filesystem = {
    framework: llmResult.framework || "unknown",
    framework_signals: llmResult.framework_signals || [],
    total_candidates: relatives.length,
    matched_paths: llmResult.knowledge_files,
    knowledge_tables: llmResult.knowledge_tables || [],
    llm_assist: {
      used: true,
      model: llmResult.model,
      selected: llmResult.knowledge_files.length,
    },
  };

  let database = null;
  if (configuredQueries.length > 0) {
    database = {
      queries: configuredQueries,
      source: "configured",
      auto_discovery: {
        database_count: 0,
        table_count: 0,
        selected_tables: configuredQueries.length,
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
  } else if (!autoDbEnabled) {
    database = {
      queries: [],
      source: "none",
      auto_discovery: {
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
  } else {
    database = await buildAutoDatabasePlan(
      cwd,
      config,
      filesystem.knowledge_tables || [],
      autoDbCandidates,
    );
  }

  const remoteUrl = String(config?.scan?.sitemap_url || config?.scan?.remote?.sitemap_url || "").trim();
  const remoteMaxPagesRaw = Number(config?.scan?.remote_max_pages || config?.scan?.remote?.max_pages || 20) || 20;
  const remoteMaxPages = Math.max(1, Math.min(remoteMaxPagesRaw, 80));
  const remote = {
    sitemap_url: remoteUrl,
    max_pages: remoteMaxPages,
    enabled: Boolean(remoteUrl),
  };

  return {
    generated_at: new Date().toISOString(),
    framework: filesystem.framework || "unknown",
    framework_signals: filesystem.framework_signals || [],
    filesystem,
    database,
    remote,
    locale: inferLocale(config),
  };
}

function normalizeStringMap(raw) {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const output = {};
  for (const [key, value] of Object.entries(raw)) {
    const normalizedKey = String(key || "").trim();
    const normalizedValue = String(value || "").trim();
    if (!normalizedKey || !normalizedValue) {
      continue;
    }
    output[normalizedKey] = normalizedValue;
  }
  return output;
}

function normalizeIndexMap(raw) {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const output = {};
  for (const [source, item] of Object.entries(raw)) {
    const sourceText = String(source || "").trim();
    if (!sourceText || !item || typeof item !== "object") {
      continue;
    }

    const docPath = String(item.doc_path || "").trim();
    if (!docPath) {
      continue;
    }

    const title = String(item.title || "").trim();
    const summary = String(item.summary || "").trim();
    const tags = unique(toArray(item.tags).map((tag) => String(tag || "").trim())).slice(0, 18);
    const updatedAt = String(item.updated_at || "").trim();
    const isFrequentlyAsked = parseBooleanLike(item.is_frequently_asked);

    output[sourceText] = {
      doc_path: docPath,
      title,
      summary,
      tags,
      updated_at: updatedAt,
      is_frequently_asked: isFrequentlyAsked,
    };
  }
  return output;
}

async function loadPreviousKnowledgeState(paths) {
  const manifestRaw = await readTextSafe(paths.knowledgeManifest);
  let manifest = {};
  if (manifestRaw) {
    try {
      manifest = JSON.parse(manifestRaw);
    } catch {
      manifest = {};
    }
  }

  return {
    sourceHashes: normalizeStringMap(manifest?.source_hashes),
    sourceDocMap: normalizeStringMap(manifest?.source_doc_map),
    indexMap: normalizeIndexMap(manifest?.index_map),
  };
}

async function cleanKnowledgeFolder(paths, options = {}) {
  const reset = Boolean(options.reset);
  if (reset) {
    await fs.rm(paths.knowledgeDocs, { recursive: true, force: true });
  }
  await fs.mkdir(paths.knowledgeDocs, { recursive: true });
}

async function collectFilesystemDocs(cwd, matchedPaths) {
  const docs = [];
  for (const relative of matchedPaths) {
    const fullPath = path.join(cwd, relative);
    const content = await readTextSafe(fullPath);
    if (!content || !content.trim()) {
      continue;
    }

    const cleaned = limitText(content, 28000);
    docs.push({
      id: `file:${relative}`,
      source: relative,
      origin: "filesystem",
      content: cleaned,
    });
  }
  return docs;
}

async function collectDatabaseDocs(cwd, databasePlan, options = {}) {
  const docs = [];
  const warnings = [];
  const log = typeof options.log === "function" ? options.log : () => undefined;
  const limiter = typeof options.limitText === "function" ? options.limitText : (value) => String(value ?? "");

  for (const queryItem of databasePlan.queries) {
    try {
      const target = queryItem.target || resolveDatabaseTarget(cwd, queryItem);
      if (!target) {
        throw new Error("database target is missing");
      }

      const rows = await runDatabaseJsonQuery(target, queryItem.query, {
        busyTimeoutMs: 6000,
        statementTimeoutMs: 15000,
        serverSelectionTimeoutMs: 12000,
        limit: queryItem.limit,
      });
      for (let i = 0; i < rows.length && i < queryItem.limit; i += 1) {
        const row = rows[i];
        const source = `db:${queryItem.name}#${i + 1}`;
        const text = limiter(stringifyDbRow(row), 16000);
        docs.push({
          id: source,
          source,
          origin: "database",
          content: text,
        });
      }
    } catch (error) {
      const message = `database query failed (${queryItem.name}): ${error.message}`;
      warnings.push(message);
      log(message);
    }
  }

  return { docs, warnings };
}

async function fetchText(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseSitemapLocs(xmlText) {
  const urls = [];
  const re = /<loc>([^<]+)<\/loc>/gi;
  let match = re.exec(xmlText);
  while (match) {
    const value = String(match[1] || "").trim();
    if (value) {
      urls.push(value);
    }
    match = re.exec(xmlText);
  }
  return unique(urls);
}

async function collectRemoteDocs(remotePlan, log) {
  if (!remotePlan.enabled || !remotePlan.sitemap_url) {
    return { docs: [], warnings: [] };
  }

  const warnings = [];
  const docs = [];

  let sitemapText = "";
  try {
    sitemapText = await fetchText(remotePlan.sitemap_url, 15000);
  } catch (error) {
    warnings.push(`sitemap fetch failed: ${error.message}`);
    if (typeof log === "function") {
      log(`sitemap fetch failed: ${error.message}`);
    }
    return { docs, warnings };
  }

  const urls = parseSitemapLocs(sitemapText).slice(0, remotePlan.max_pages);
  for (const url of urls) {
    try {
      const html = await fetchText(url, 15000);
      const text = limitText(stripHtml(html), 16000);
      if (!text) continue;

      docs.push({
        id: `remote:${url}`,
        source: url,
        origin: "remote",
        content: text,
      });
    } catch (error) {
      warnings.push(`remote page failed (${url}): ${error.message}`);
      if (typeof log === "function") {
        log(`remote page failed (${url}): ${error.message}`);
      }
    }
  }

  return { docs, warnings };
}

function intRange(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(Math.floor(parsed), max));
}

function compileConfig(config) {
  return {
    batchChars: intRange(config?.scan?.llm_compile_batch_chars, 30000, 900000, 100000),
    maxTokens: intRange(config?.scan?.llm_compile_max_tokens, 1000, 16000, 4800),
    docContentChars: intRange(config?.scan?.llm_compile_doc_chars, 4000, 60000, 18000),
  };
}

function buildDocCompileBatchItems(changeDocs, compileDocsMap, config) {
  const settings = compileConfig(config);

  const items = changeDocs.map((item, idx) => {
    const doc = compileDocsMap.get(item.source);
    const promptId = `d${idx + 1}`;
    const payload = [
      `Id: ${promptId}`,
      `Source: ${doc.source}`,
      `Origin: ${doc.origin}`,
      `Change Type: ${item.change_type}`,
      `Old Doc Path: ${item.old_doc_path || ""}`,
      "",
      "Content:",
      limitText(doc.content, settings.docContentChars),
    ].join("\n");

    return {
      promptId,
      source: doc.source,
      payload,
      payloadChars: payload.length,
    };
  });

  const batches = [];
  let current = [];
  let used = 0;

  for (const item of items) {
    if (current.length > 0 && used + item.payloadChars > settings.batchChars) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += item.payloadChars;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return {
    items,
    batches,
    settings,
  };
}

function parseCompiledDocs(json) {
  if (!json || typeof json !== "object" || !Array.isArray(json.docs)) {
    return [];
  }

  return json.docs
    .map((item) => {
      const id = String(item?.id || "").trim();
      const title = String(item?.title || "").trim();
      const summary = String(item?.summary || "").trim();
      const tags = unique(toArray(item?.tags).map((tag) => String(tag || "").trim())).slice(0, 18);
      const body = String(item?.body || item?.content || item?.markdown || "").trim();
      const isFrequentlyAsked = parseBooleanLike(item?.is_frequently_asked);
      if (!id || !title || !summary || !body) {
        return null;
      }
      return {
        id,
        title,
        summary,
        tags,
        body,
        is_frequently_asked: isFrequentlyAsked,
      };
    })
    .filter(Boolean);
}

function stripAllHtmlTags(text) {
  return String(text || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function renderCompiledDocMarkdown(docPath, title, tags, summary, body, locale, isFrequentlyAsked = false) {
  const safeTitle = title || path.posix.basename(docPath, ".md") || t(locale, "未命名文档", "Untitled Document");
  const safeSummary = summary || t(locale, "暂无摘要", "No summary");
  const safeTags = unique((tags || []).map((tag) => String(tag || "").trim())).slice(0, 18);
  const safeBody = stripAllHtmlTags(body);

  return [
    `# ${safeTitle}`,
    "",
    `**Tags**: ${safeTags.join(", ") || "-"}`,
    `**Summary**: ${safeSummary}`,
    `**${t(locale, "高频客户关注", "Frequent Customer Concern")}**: ${isFrequentlyAsked ? "yes" : "no"}`,
    "",
    `## ${t(locale, "正文", "Content")}`,
    "",
    safeBody || t(locale, "（无可用内容）", "(no available content)"),
    "",
  ].join("\n");
}

// 核心逻辑! 调用LLM编译知识文档。
async function compileDocsBatchByLlm(config, locale, batchItems) {
  ensureLlmReady(config);
  if (batchItems.length === 0) {
    return new Map();
  }

  const settings = compileConfig(config);
  const messages = [
    {
      role: "system",
      content:
        'You are a website knowledge document compiler. For each input document, produce structured markdown-ready fields. Return JSON only: {"docs":[{"id":"d1","title":"...","tags":["..."],"summary":"...","body":"...","is_frequently_asked":true}]}. Requirements: remove all HTML tags; preserve user-visible factual information; redact unsafe/executable snippets; body should be concise but complete for support Q&A; set is_frequently_asked=true when this document addresses common customer concerns (pricing, payment, plan, trial, refund, terms, privacy, shipping, support, account, troubleshooting, onboarding, FAQ).',
    },
    {
      role: "user",
      content: [
        `Locale: ${locale}`,
        `Document count: ${batchItems.length}`,
        "",
        "Input documents:",
        ...batchItems.map((item) => [`## ${item.promptId}`, item.payload].join("\n")),
        "",
        "Output constraints:",
        "- Every input id must appear exactly once in docs.",
        "- tags should be short keywords.",
        "- summary should be 1-2 sentences.",
        "- body must be plain markdown text without HTML tags.",
        "- is_frequently_asked must be boolean true/false.",
      ].join("\n"),
    },
  ];

  const completion = await chatCompletion(config, messages, {
    temperature: 0.1,
    maxTokens: settings.maxTokens,
    trace: "scan:doc_compile_batch",
  });

  if (!completion.ok) {
    throw new Error(`LLM doc compile batch failed: ${completion.error}`);
  }

  const parsed = extractJsonObject(completion.content);
  const docs = parseCompiledDocs(parsed);
  if (docs.length === 0) {
    throw new Error("LLM doc compile batch returned empty docs.");
  }

  const byId = new Map(docs.map((item) => [item.id, item]));
  const output = new Map();
  for (const batchItem of batchItems) {
    const compiled = byId.get(batchItem.promptId);
    if (!compiled) {
      throw new Error(`LLM doc compile batch missing id: ${batchItem.promptId}`);
    }
    output.set(batchItem.source, compiled);
  }

  return output;
}

function sectionForEntry(heading, item) {
  return [
    `### ${heading}`,
    item.title || "-",
    `**Keywords**: ${(item.tags || []).join(", ") || "-"}`,
    `**Summary**: ${item.summary || "-"}`,
    `**Frequent Customer Concern**: ${item.is_frequently_asked ? "yes" : "no"}`,
    `**Doc**: ${item.doc_path}`,
    "",
  ].join("\n");
}

function renderIndexMarkdown({ locale, generatedAt, scanMode, indexMap }) {
  const entries = Object.entries(indexMap || {}).map(([source, item]) => ({ source, ...item }));
  entries.sort((a, b) => String(a.doc_path || "").localeCompare(String(b.doc_path || "")));

  const frequentItems = entries.filter((item) => Boolean(item.is_frequently_asked));

  const lines = [
    "# Knowledge Index",
    "",
    t(locale, "这是知识库目录。LLM 应先阅读此文件，再按需加载对应文档。", "This is the knowledge directory. LLM should read this index first, then load selected documents on demand."),
    "",
    `- generated_at: ${generatedAt}`,
    `- total_docs: ${entries.length}`,
    `- scan_mode: ${scanMode}`,
    `- frequent_docs: ${frequentItems.length}`,
    "",
    "## Frequent Customer Concerns",
    "",
  ];

  if (frequentItems.length === 0) {
    lines.push("(none)", "");
  } else {
    for (const item of frequentItems) {
      const heading = path.posix.basename(item.doc_path || item.source || "document.md");
      lines.push(sectionForEntry(heading, item));
    }
  }

  lines.push("## All Documents", "");
  if (entries.length === 0) {
    lines.push("(none)", "");
  } else {
    for (const item of entries) {
      const heading = path.posix.basename(item.doc_path || item.source || "document.md");
      lines.push(sectionForEntry(heading, item));
    }
  }

  return lines.join("\n");
}

function normalizeStoredPath(value, prefix) {
  const normalized = toPosixPath(String(value || "").trim()).replace(/^\/+/, "");
  if (!normalized) {
    return "";
  }
  if (normalized.startsWith(`${prefix}/`)) {
    return normalized;
  }
  return `${prefix}/${normalized}`;
}

function storedPathToAbsolute(paths, storedPath) {
  return path.join(paths.knowledges, storedPath);
}

async function writeCompiledDocs(paths, compiledBySource, options = {}) {
  const reset = Boolean(options.reset);
  const previousDocMap = options.previousDocMap || {};
  const deletedSources = (options.deletedSources || []).map((item) => String(item || "").trim()).filter(Boolean);

  for (const [source, item] of compiledBySource.entries()) {
    const docPath = normalizeStoredPath(item.doc_path, "docs");
    if (!docPath) {
      continue;
    }
    const fullPath = storedPathToAbsolute(paths, docPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await writeText(fullPath, item.markdown || "");

    const previousDocPath = normalizeStoredPath(previousDocMap[source], "docs");
    if (!reset && previousDocPath && previousDocPath !== docPath) {
      await fs.rm(storedPathToAbsolute(paths, previousDocPath), { force: true });
    }
  }

  if (!reset) {
    for (const source of deletedSources) {
      const previousDocPath = normalizeStoredPath(previousDocMap[source], "docs");
      if (!previousDocPath) continue;
      await fs.rm(storedPathToAbsolute(paths, previousDocPath), { force: true });
    }
  }
}

function defaultSelections(plan, override = {}) {
  return {
    filesystem: override.filesystem !== undefined ? Boolean(override.filesystem) : true,
    database: override.database !== undefined ? Boolean(override.database) : plan.database.queries.length > 0,
    remote: override.remote !== undefined ? Boolean(override.remote) : plan.remote.enabled,
  };
}

export async function buildKnowledgeBase(cwd, options = {}) {
  const paths = await ensureRuntime(cwd);
  const config =
    options.config ||
    (await loadConfig(cwd, {
      createIfMissing: false,
    }).catch(() => ({})));
  const locale = inferLocale(config);
  const plan =
    options.plan ||
    (await prepareKnowledgeScanPlan(cwd, {
      config,
    }));
  const selections = defaultSelections(plan, options.selections || {});
  const log = typeof options.log === "function" ? options.log : () => undefined;
  const reset = Boolean(options.reset);

  const previous = reset
    ? {
        manifest: {},
        sourceHashes: {},
        sourceDocMap: {},
        indexMap: {},
      }
    : await loadPreviousKnowledgeState(paths);

  await cleanKnowledgeFolder(paths, { reset });

  const docs = [];
  const warnings = [];
  let scannedFiles = 0;
  let scannedDbRows = 0;
  let scannedRemotePages = 0;

  if (selections.filesystem) {
    log(t(locale, "扫描文件系统中...", "Scanning file system..."));
    const fsDocs = await collectFilesystemDocs(cwd, plan.filesystem.matched_paths);
    docs.push(...fsDocs);
    scannedFiles = fsDocs.length;
  }

  if (selections.database) {
    log(t(locale, "执行数据库查询中...", "Running database queries..."));
    const dbResult = await collectDatabaseDocs(cwd, plan.database, { log, limitText });
    docs.push(...dbResult.docs);
    warnings.push(...dbResult.warnings);
    scannedDbRows = dbResult.docs.length;
  }

  if (selections.remote) {
    log(t(locale, "抓取远程 sitemap 中...", "Fetching remote sitemap..."));
    const remoteResult = await collectRemoteDocs(plan.remote, log);
    docs.push(...remoteResult.docs);
    warnings.push(...remoteResult.warnings);
    scannedRemotePages = remoteResult.docs.length;
  }

  if (docs.length === 0) {
    throw new Error("No documents collected from selected scan sources.");
  }

  const nowIso = new Date().toISOString();

  const previousSourceHashes = previous.sourceHashes || {};
  const previousSourceDocMap = previous.sourceDocMap || {};
  const previousIndexMap = previous.indexMap || {};

  const currentDocMap = new Map(docs.map((doc) => [doc.source, doc]));
  const currentSourceHashes = {};
  const currentSourceDocMap = {};

  for (const doc of docs) {
    currentSourceHashes[doc.source] = sourceHashForDoc(doc);
    currentSourceDocMap[doc.source] = docStoredPathForDoc(doc);
  }

  const previousSourceSet = new Set([
    ...Object.keys(previousSourceHashes),
    ...Object.keys(previousSourceDocMap),
    ...Object.keys(previousIndexMap),
  ]);

  const addedSources = [];
  const changedSources = [];
  const unchangedSources = [];

  for (const doc of docs) {
    const source = doc.source;
    const previousHash = previousSourceHashes[source];
    const previousDocPath = previousSourceDocMap[source];
    const currentDocPath = currentSourceDocMap[source];
    const previousIndex = previousIndexMap[source];

    if (reset || !previousHash || !previousDocPath || !previousIndex) {
      addedSources.push(source);
      continue;
    }

    if (previousHash !== currentSourceHashes[source]) {
      changedSources.push(source);
      continue;
    }

    if (previousDocPath !== currentDocPath) {
      changedSources.push(source);
      continue;
    }

    unchangedSources.push(source);
  }

  const deletedSources = [...previousSourceSet].filter((source) => !currentDocMap.has(source));
  const compileSources = [...addedSources, ...changedSources];

  const compileDocsMap = new Map(compileSources.map((source) => [source, currentDocMap.get(source)]).filter(([, doc]) => Boolean(doc)));

  const compileItems = compileSources.map((source) => ({
    source,
    change_type: addedSources.includes(source) ? "added" : "changed",
    old_doc_path: previousSourceDocMap[source] || "",
  }));

  const compiledMetaBySource = new Map();
  const compiledMarkdownBySource = new Map();
  let docCompileBatchCount = 0;

  if (compileItems.length > 0) {
    const compilePlan = buildDocCompileBatchItems(compileItems, compileDocsMap, config);
    log(
      t(
        locale,
        `5/6 LLM 批量编译变更文档，共 ${compilePlan.batches.length} 批（batch_chars=${compilePlan.settings.batchChars}）...`,
        `5/6 LLM compiling changed docs in batches: ${compilePlan.batches.length} (batch_chars=${compilePlan.settings.batchChars})...`,
      ),
    );

    for (let i = 0; i < compilePlan.batches.length; i += 1) {
      const batch = compilePlan.batches[i];
      log(
        t(
          locale,
          `编译批次 ${i + 1}/${compilePlan.batches.length}（docs=${batch.length}）`,
          `Compile batch ${i + 1}/${compilePlan.batches.length} (docs=${batch.length})`,
        ),
      );

      const batchResult = await compileDocsBatchByLlm(config, locale, batch);
      docCompileBatchCount += 1;

      for (const [source, compiled] of batchResult.entries()) {
        const docPath = currentSourceDocMap[source];
        const tags = compiled.tags;
        const summary = compiled.summary;
        const title = compiled.title;

        compiledMetaBySource.set(source, {
          doc_path: docPath,
          title,
          tags,
          summary,
          updated_at: nowIso,
          is_frequently_asked: Boolean(compiled.is_frequently_asked),
        });

        compiledMarkdownBySource.set(
          source,
          renderCompiledDocMarkdown(
            docPath,
            title,
            tags,
            summary,
            compiled.body,
            locale,
            Boolean(compiled.is_frequently_asked),
          ),
        );
      }
    }
  } else {
    log(t(locale, "5/6 无新增或变更文档，跳过文档编译。", "5/6 No added/changed docs. Skipping compile."));
  }

  const finalIndexMap = {};
  for (const doc of docs) {
    const source = doc.source;
    if (compiledMetaBySource.has(source)) {
      finalIndexMap[source] = compiledMetaBySource.get(source);
      continue;
    }

    const previousItem = previousIndexMap[source];
    if (previousItem) {
      finalIndexMap[source] = {
        ...previousItem,
        doc_path: currentSourceDocMap[source],
        is_frequently_asked: parseBooleanLike(previousItem.is_frequently_asked),
      };
      continue;
    }

    throw new Error(`Missing compiled metadata for source: ${source}`);
  }

  await writeCompiledDocs(
    paths,
    new Map(
      [...compiledMarkdownBySource.entries()].map(([source, markdown]) => [source, {
        doc_path: currentSourceDocMap[source],
        markdown,
      }]),
    ),
    {
      reset,
      previousDocMap: previousSourceDocMap,
      deletedSources,
    },
  );

  const addedCount = addedSources.length;
  const changedCount = changedSources.length;
  const deletedCount = deletedSources.length;
  const unchangedCount = unchangedSources.length;

  log(
    t(
      locale,
      "6/6 重建 index.md（并写入 manifest.json）...",
      "6/6 Rebuilding index.md (and writing manifest.json) ...",
    ),
  );
  const indexMarkdown = renderIndexMarkdown({
    locale,
    generatedAt: nowIso,
    scanMode: reset ? "reset" : "incremental",
    indexMap: finalIndexMap,
  });

  const allSourcesOrder = Object.entries(finalIndexMap)
    .sort((a, b) => String(a[1]?.doc_path || "").localeCompare(String(b[1]?.doc_path || "")))
    .map(([source]) => source);
  const frequentSources = allSourcesOrder.filter((source) => Boolean(finalIndexMap[source]?.is_frequently_asked));

  const manifest = {
    generated_at: nowIso,
    scan_mode: reset ? "reset" : "incremental",
    framework: plan.framework,
    framework_signals: plan.framework_signals || [],
    source_stats: {
      filesystem: scannedFiles,
      database: scannedDbRows,
      remote: scannedRemotePages,
    },
    total_files: docs.length,
    changes: {
      added: addedCount,
      changed: changedCount,
      deleted: deletedCount,
      unchanged: unchangedCount,
      frequent_doc_count: frequentSources.length,
    },
    llm_calls: {
      file_planning: 1,
      doc_compile_batches: docCompileBatchCount,
      total: 1 + docCompileBatchCount,
      doc_compile_batch_chars: compileConfig(config).batchChars,
    },
    source_hashes: currentSourceHashes,
    source_doc_map: currentSourceDocMap,
    index_map: finalIndexMap,
    frequent_sources: frequentSources,
    all_sources_order: allSourcesOrder,
    warnings,
  };

  await writeText(paths.knowledgeIndex, indexMarkdown.endsWith("\n") ? indexMarkdown : `${indexMarkdown}\n`);

  await writeText(paths.knowledgeManifest, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    framework: plan.framework,
    scanned: docs.length,
    compiled: compileSources.length,
    paths,
    plan,
    source_stats: manifest.source_stats,
    llm_calls: manifest.llm_calls,
    changes: manifest.changes,
    warnings,
  };
}

export async function loadKnowledgeIndex(cwd) {
  const paths = runtimePaths(cwd);
  const raw = await readTextSafe(paths.knowledgeManifest);
  if (!raw) {
    return {
      index_map: {},
      frequent_sources: [],
      all_sources_order: [],
    };
  }
  try {
    return JSON.parse(raw);
  } catch {
    return {
      index_map: {},
      frequent_sources: [],
      all_sources_order: [],
    };
  }
}

export async function loadDocContents(cwd, docPaths) {
  const paths = runtimePaths(cwd);
  const output = [];

  for (const docPathRaw of docPaths || []) {
    const docPath = normalizeStoredPath(docPathRaw, "docs");
    if (!docPath) {
      continue;
    }
    const content = await readTextSafe(storedPathToAbsolute(paths, docPath));
    if (content) {
      output.push({
        doc_path: docPath,
        content,
      });
    }
  }

  return output;
}
