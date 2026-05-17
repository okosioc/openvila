import path from "node:path";
import sqlite3 from "sqlite3";
import { listFilesRecursive, readTextSafe, toPosixPath } from "./fs.js";

const SQLITE_FILE_EXTENSIONS = [".db", ".sqlite", ".sqlite3"];
const CONFIG_SOURCE_EXTENSIONS = [".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf"];

function unique(values) {
  return [...new Set(values.filter((item) => typeof item === "string" && item.trim().length > 0))];
}

export function resolveSqlitePath(cwd, sqlitePath) {
  if (path.isAbsolute(sqlitePath)) {
    return sqlitePath;
  }
  return path.join(cwd, sqlitePath);
}

function openSqliteReadOnly(dbPath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(db);
    });
  });
}

function closeSqliteDatabase(db) {
  return new Promise((resolve, reject) => {
    db.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function runSqliteAll(db, query) {
  return new Promise((resolve, reject) => {
    db.all(query, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(rows);
    });
  });
}

export async function runSqliteJsonQuery(dbPath, query, options = {}) {
  const busyTimeoutMs = Math.max(500, Math.min(Number(options.busyTimeoutMs || 6000) || 6000, 120000));
  const db = await openSqliteReadOnly(dbPath);
  try {
    db.configure("busyTimeout", busyTimeoutMs);
    const rows = await runSqliteAll(db, query);
    if (!Array.isArray(rows)) {
      return [];
    }
    return rows;
  } finally {
    await closeSqliteDatabase(db);
  }
}

export function stringifyDbRow(row) {
  if (!row || typeof row !== "object") {
    return String(row);
  }
  return JSON.stringify(row, null, 2);
}

function extractSqlitePathCandidatesFromText(text) {
  const content = String(text || "");
  const matches = [];

  const quotedPathRegex = /["'`]([^"'`\n\r]+?\.(?:db|sqlite|sqlite3))["'`]/gi;
  let hit = quotedPathRegex.exec(content);
  while (hit) {
    matches.push(String(hit[1] || "").trim());
    hit = quotedPathRegex.exec(content);
  }

  const sqliteUrlRegex = /sqlite:\/\/\/([^\s"'`]+(?:\.db|\.sqlite|\.sqlite3))/gi;
  hit = sqliteUrlRegex.exec(content);
  while (hit) {
    matches.push(String(hit[1] || "").trim());
    hit = sqliteUrlRegex.exec(content);
  }

  return unique(
    matches
      .map((item) => String(item || "").replace(/\\/g, "/").trim())
      .filter(Boolean),
  );
}

function isConfigSourceFile(fullPath) {
  const ext = path.extname(fullPath).toLowerCase();
  const base = path.basename(fullPath).toLowerCase();
  if (CONFIG_SOURCE_EXTENSIONS.includes(ext)) {
    return true;
  }
  if (base === ".env" || base.startsWith(".env.")) {
    return true;
  }
  if (base === "docker-compose.yml" || base === "docker-compose.yaml") {
    return true;
  }
  return false;
}

export async function findSqliteDatabaseFiles(cwd, options = {}) {
  const maxFiles = Number(options.maxFiles || 200) || 200;
  const files = await listFilesRecursive(cwd, {
    onlyExt: SQLITE_FILE_EXTENSIONS,
    maxFiles,
    maxFileSize: Number(options.maxFileSize || 200 * 1024 * 1024) || 200 * 1024 * 1024,
  });
  return files.map((item) => path.resolve(item));
}

export async function discoverSqliteDatabasePaths(cwd, options = {}) {
  const dbFiles = await findSqliteDatabaseFiles(cwd, options);
  const dbSet = new Set(dbFiles.map((item) => path.resolve(item)));
  const byBaseName = new Map();
  for (const file of dbFiles) {
    const base = path.basename(file).toLowerCase();
    if (!byBaseName.has(base)) {
      byBaseName.set(base, []);
    }
    byBaseName.get(base).push(path.resolve(file));
  }

  const sourceFiles = await listFilesRecursive(cwd, {
    maxFiles: Number(options.maxSourceFiles || 1400) || 1400,
    maxFileSize: Number(options.maxSourceFileSize || 80 * 1024) || 80 * 1024,
  });

  const mentionedTokens = new Set();
  for (const file of sourceFiles) {
    if (!isConfigSourceFile(file)) {
      continue;
    }
    const text = await readTextSafe(file);
    if (!text) {
      continue;
    }
    const candidates = extractSqlitePathCandidatesFromText(text);
    for (const token of candidates) {
      mentionedTokens.add(token);
    }
  }

  const resolved = new Set(dbSet);
  const unresolved = [];
  for (const token of mentionedTokens) {
    const normalized = String(token || "").trim();
    if (!normalized) {
      continue;
    }

    const absoluteDirect = path.resolve(cwd, normalized);
    if (dbSet.has(absoluteDirect)) {
      resolved.add(absoluteDirect);
      continue;
    }

    if (path.isAbsolute(normalized) && dbSet.has(path.resolve(normalized))) {
      resolved.add(path.resolve(normalized));
      continue;
    }

    const base = path.basename(normalized).toLowerCase();
    const matchedByName = byBaseName.get(base) || [];
    if (matchedByName.length > 0) {
      for (const item of matchedByName) {
        resolved.add(item);
      }
      continue;
    }

    unresolved.push(normalized);
  }

  return {
    paths: [...resolved],
    discovered_files: dbFiles.map((file) => toPosixPath(path.relative(cwd, file))),
    mentioned_tokens: [...mentionedTokens],
    unresolved_tokens: unique(unresolved),
  };
}

export function quoteSqliteIdentifier(identifier) {
  return `"${String(identifier || "").replace(/"/g, '""')}"`;
}

export async function listSqliteTables(dbPath) {
  const rows = await runSqliteJsonQuery(
    dbPath,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return unique(rows.map((row) => String(row?.name || "").trim()).filter(Boolean));
}

export async function listSqliteTableColumns(dbPath, tableName) {
  const rows = await runSqliteJsonQuery(dbPath, `PRAGMA table_info(${quoteSqliteIdentifier(tableName)})`);
  return rows
    .map((row) => ({
      name: String(row?.name || "").trim(),
      type: String(row?.type || "").trim(),
      pk: Number(row?.pk || 0) || 0,
    }))
    .filter((row) => row.name);
}
