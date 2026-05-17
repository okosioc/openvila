import path from "node:path";
import sqlite3 from "sqlite3";
import mysql from "mysql2/promise";
import pg from "pg";
import { MongoClient } from "mongodb";
import { listFilesRecursive, readTextSafe, toPosixPath } from "./fs.js";

const { Client: PgClient } = pg;

const SQLITE_FILE_EXTENSIONS = [".db", ".sqlite", ".sqlite3"];
const CONFIG_SOURCE_EXTENSIONS = [".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".php", ".env"];
const MYSQL_URL_REGEX = /(mysql(?:\+[^:\s]+)?:\/\/[^\s"'`]+)/gi;
const POSTGRES_URL_REGEX = /(postgres(?:ql)?(?:\+[^:\s]+)?:\/\/[^\s"'`]+)/gi;
const MONGODB_URL_REGEX = /(mongodb(?:\+srv)?:\/\/[^\s"'`]+)/gi;

function unique(values) {
  return [...new Set(values.filter((item) => typeof item === "string" && item.trim().length > 0))];
}

function cleanToken(value) {
  return String(value || "")
    .trim()
    .replace(/[),;]+$/g, "");
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function lowerNoProto(urlText) {
  return String(urlText || "").toLowerCase().replace(/\/$/, "");
}

function isLikelySqlitePath(value) {
  return /\.(db|sqlite|sqlite3)$/i.test(String(value || "").trim());
}

export function normalizeDatabaseEngine(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/:$/, "");

  if (!normalized) {
    return "";
  }
  if (normalized === "sqlite" || normalized === "sqlite3" || normalized === "file" || normalized.startsWith("sqlite")) {
    return "sqlite";
  }
  if (normalized === "mysql" || normalized.startsWith("mysql+")) {
    return "mysql";
  }
  if (
    normalized === "postgres" ||
    normalized === "pg" ||
    normalized === "postgresql" ||
    normalized.startsWith("postgresql") ||
    normalized.startsWith("postgres+")
  ) {
    return "postgresql";
  }
  if (normalized === "mongodb" || normalized === "mongo" || normalized.startsWith("mongodb+")) {
    return "mongodb";
  }
  return "";
}

function engineFromConnectionUrl(connectionUrl) {
  try {
    const parsed = new URL(connectionUrl);
    return normalizeDatabaseEngine(parsed.protocol);
  } catch {
    return "";
  }
}

function sanitizeConnectionLabel(connectionUrl, fallbackEngine = "") {
  try {
    const parsed = new URL(connectionUrl);
    const engine = normalizeDatabaseEngine(parsed.protocol) || normalizeDatabaseEngine(fallbackEngine) || "db";
    const protocol =
      engine === "postgresql"
        ? "postgresql"
        : engine === "mysql"
          ? "mysql"
          : engine === "mongodb"
            ? "mongodb"
            : parsed.protocol.replace(/:$/, "");
    const username = parsed.username ? `${decodeURIComponent(parsed.username)}@` : "";
    const host = parsed.host;
    const pathname = parsed.pathname || "";
    return `${protocol}://${username}${host}${pathname}`;
  } catch {
    return String(connectionUrl || "");
  }
}

function splitHostPort(rawHost, defaultPort) {
  const hostText = String(rawHost || "").trim();
  if (!hostText) {
    return { host: "", port: defaultPort };
  }

  if (hostText.startsWith("[") && hostText.includes("]")) {
    const idx = hostText.lastIndexOf("]");
    const host = hostText.slice(1, idx);
    const portRaw = hostText.slice(idx + 1).replace(/^:/, "");
    return {
      host,
      port: toPositiveInt(portRaw, defaultPort),
    };
  }

  const lastColon = hostText.lastIndexOf(":");
  if (lastColon > 0 && /^\d+$/.test(hostText.slice(lastColon + 1))) {
    return {
      host: hostText.slice(0, lastColon),
      port: toPositiveInt(hostText.slice(lastColon + 1), defaultPort),
    };
  }

  return {
    host: hostText,
    port: defaultPort,
  };
}

function toSqliteLabel(cwd, dbPath) {
  const relative = toPosixPath(path.relative(cwd, dbPath));
  if (relative && !relative.startsWith("../") && relative !== "..") {
    return relative;
  }
  return dbPath;
}

function buildSqliteTarget(cwd, sqlitePath) {
  const dbPath = path.isAbsolute(sqlitePath) ? sqlitePath : path.join(cwd, sqlitePath);
  const labelPath = toSqliteLabel(cwd, dbPath);
  return {
    engine: "sqlite",
    sqlite_path: labelPath,
    db_path: dbPath,
    key: `sqlite:${labelPath.toLowerCase()}`,
    label: `sqlite:${labelPath}`,
  };
}

function buildNetworkTargetFromUrl(engine, connectionUrl) {
  const masked = sanitizeConnectionLabel(connectionUrl, engine);
  return {
    engine,
    connection_url: connectionUrl,
    key: `${engine}:${lowerNoProto(masked)}`,
    label: masked,
  };
}

function buildNetworkTargetFromFields(engine, raw) {
  const defaultPort = engine === "mysql" ? 3306 : engine === "postgresql" ? 5432 : engine === "mongodb" ? 27017 : 0;
  const split = splitHostPort(raw?.host || raw?.hostname, defaultPort);
  const host = split.host || "127.0.0.1";
  const port = toPositiveInt(raw?.port, split.port || defaultPort);
  const user = String(raw?.user || raw?.username || "").trim();
  const password = String(raw?.password || raw?.pass || "");
  const database = String(raw?.database || raw?.database_name || raw?.db_name || raw?.schema || "").trim();

  if (!database) {
    return null;
  }

  const auth = user ? `${user}@` : "";
  const label = `${engine}://${auth}${host}:${port}/${database}`;

  return {
    engine,
    host,
    port,
    user,
    password,
    database,
    key: `${engine}:${label.toLowerCase()}`,
    label,
  };
}

export function resolveSqlitePath(cwd, sqlitePath) {
  if (path.isAbsolute(sqlitePath)) {
    return sqlitePath;
  }
  return path.join(cwd, sqlitePath);
}

export function resolveDatabaseTarget(cwd, rawTarget) {
  if (!rawTarget || typeof rawTarget !== "object") {
    return null;
  }

  const explicitEngine = normalizeDatabaseEngine(rawTarget.engine || rawTarget.type || rawTarget.kind || "");

  const connectionUrl = cleanToken(
    rawTarget.connection_url ||
      rawTarget.connectionUrl ||
      rawTarget.connection ||
      rawTarget.uri ||
      rawTarget.url ||
      rawTarget.dsn ||
      rawTarget.database_url ||
      rawTarget.databaseUrl ||
      "",
  );

  if (connectionUrl) {
    const parsedEngine = engineFromConnectionUrl(connectionUrl);
    const engine = parsedEngine || explicitEngine;
    if (engine === "mysql" || engine === "postgresql" || engine === "mongodb") {
      return buildNetworkTargetFromUrl(engine, connectionUrl);
    }
    if (engine === "sqlite") {
      const sqlitePathFromUrl = connectionUrl.replace(/^sqlite:\/\//i, "").replace(/^\/+/, "/");
      if (sqlitePathFromUrl) {
        return buildSqliteTarget(cwd, sqlitePathFromUrl);
      }
    }
  }

  const sqlitePath = cleanToken(
    rawTarget.sqlite_path || rawTarget.sqlitePath || rawTarget.path || rawTarget.file || rawTarget.db_file || "",
  );
  if (sqlitePath && (explicitEngine === "sqlite" || !explicitEngine || isLikelySqlitePath(sqlitePath))) {
    return buildSqliteTarget(cwd, sqlitePath);
  }

  const databaseField = cleanToken(rawTarget.database || rawTarget.db || rawTarget.database_name || rawTarget.db_name || "");
  if (databaseField && !explicitEngine && isLikelySqlitePath(databaseField)) {
    return buildSqliteTarget(cwd, databaseField);
  }

  if (explicitEngine === "mysql" || explicitEngine === "postgresql") {
    return buildNetworkTargetFromFields(explicitEngine, rawTarget);
  }

  if (explicitEngine === "mongodb") {
    return buildNetworkTargetFromFields(explicitEngine, rawTarget);
  }

  if ((rawTarget.host || rawTarget.hostname) && databaseField) {
    const fallbackEngine = normalizeDatabaseEngine(rawTarget.driver || rawTarget.client || "");
    if (!fallbackEngine) {
      return null;
    }
    return buildNetworkTargetFromFields(fallbackEngine, {
      ...rawTarget,
      database: databaseField,
    });
  }

  return null;
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

async function runMysqlQuery(target, query) {
  const connection = target.connection_url
    ? await mysql.createConnection(target.connection_url)
    : await mysql.createConnection({
        host: target.host,
        port: target.port,
        user: target.user,
        password: target.password,
        database: target.database,
      });

  try {
    const [rows] = await connection.query(query);
    if (!Array.isArray(rows)) {
      return [];
    }
    return rows;
  } finally {
    await connection.end().catch(() => undefined);
  }
}

async function runPostgresQuery(target, query, options = {}) {
  const timeoutMs = Math.max(500, Math.min(Number(options.statementTimeoutMs || 15000) || 15000, 120000));
  const client = target.connection_url
    ? new PgClient({
        connectionString: target.connection_url,
        statement_timeout: timeoutMs,
      })
    : new PgClient({
        host: target.host,
        port: target.port,
        user: target.user,
        password: target.password,
        database: target.database,
        statement_timeout: timeoutMs,
      });

  await client.connect();
  try {
    const result = await client.query(query);
    if (!Array.isArray(result?.rows)) {
      return [];
    }
    return result.rows;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function parseMongoQuerySpec(query, fallbackLimit = 80) {
  let spec = null;
  if (typeof query === "string") {
    try {
      spec = JSON.parse(query);
    } catch {
      throw new Error("mongodb query must be JSON string");
    }
  } else if (query && typeof query === "object") {
    spec = query;
  } else {
    spec = {};
  }

  if (!spec || typeof spec !== "object") {
    throw new Error("mongodb query spec must be object");
  }

  const collection = String(spec.collection || spec.coll || "").trim();
  if (!collection) {
    throw new Error("mongodb query requires collection");
  }

  const filter = spec.filter && typeof spec.filter === "object" ? spec.filter : {};
  const projection = spec.projection && typeof spec.projection === "object" ? spec.projection : undefined;
  const sort = spec.sort && typeof spec.sort === "object" ? spec.sort : undefined;
  const limit = Math.max(1, Math.min(toPositiveInt(spec.limit, fallbackLimit), 300));

  return {
    collection,
    filter,
    projection,
    sort,
    limit,
  };
}

function buildMongoConnectionUrl(target) {
  if (target.connection_url) {
    return target.connection_url;
  }
  const user = String(target.user || "").trim();
  const password = String(target.password || "");
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@` : "";
  const host = String(target.host || "127.0.0.1").trim() || "127.0.0.1";
  const port = toPositiveInt(target.port, 27017);
  const database = String(target.database || "").trim();
  if (!database) {
    throw new Error("mongodb database is required");
  }
  return `mongodb://${auth}${host}:${port}/${encodeURIComponent(database)}`;
}

async function runMongoQuery(target, query, options = {}) {
  const fallbackLimit = Math.max(1, Math.min(toPositiveInt(options.limit, 80), 300));
  const spec = parseMongoQuerySpec(query, fallbackLimit);
  const connectionUrl = buildMongoConnectionUrl(target);
  const client = new MongoClient(connectionUrl, {
    maxPoolSize: 2,
    serverSelectionTimeoutMS: Math.max(500, Math.min(Number(options.serverSelectionTimeoutMs || 12000) || 12000, 120000)),
  });

  let dbName = String(target.database || "").trim();
  if (!dbName) {
    try {
      const parsed = new URL(connectionUrl);
      dbName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    } catch {
      dbName = "";
    }
  }
  if (!dbName) {
    throw new Error("mongodb database is required");
  }

  await client.connect();
  try {
    const collection = client.db(dbName).collection(spec.collection);
    let cursor = collection.find(spec.filter, spec.projection ? { projection: spec.projection } : undefined);
    if (spec.sort) {
      cursor = cursor.sort(spec.sort);
    }
    const rows = await cursor.limit(spec.limit).toArray();
    return Array.isArray(rows) ? rows : [];
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function runDatabaseJsonQuery(target, query, options = {}) {
  const engine = normalizeDatabaseEngine(target?.engine);
  if (!engine) {
    throw new Error("database engine is required");
  }

  if (engine === "sqlite") {
    const dbPath = String(target.db_path || target.sqlite_path || "").trim();
    if (!dbPath) {
      throw new Error("sqlite_path is required");
    }

    const busyTimeoutMs = Math.max(500, Math.min(Number(options.busyTimeoutMs || 6000) || 6000, 120000));
    const db = await openSqliteReadOnly(dbPath);
    try {
      db.configure("busyTimeout", busyTimeoutMs);
      const rows = await runSqliteAll(db, query);
      return Array.isArray(rows) ? rows : [];
    } finally {
      await closeSqliteDatabase(db);
    }
  }

  if (engine === "mysql") {
    return runMysqlQuery(target, query);
  }

  if (engine === "postgresql") {
    return runPostgresQuery(target, query, options);
  }

  if (engine === "mongodb") {
    return runMongoQuery(target, query, options);
  }

  throw new Error(`unsupported database engine: ${engine}`);
}

export async function runSqliteJsonQuery(dbPath, query, options = {}) {
  const rows = await runDatabaseJsonQuery(
    {
      engine: "sqlite",
      db_path: dbPath,
      sqlite_path: dbPath,
    },
    query,
    options,
  );
  return rows;
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

function extractDatabaseUrlCandidatesFromText(text) {
  const content = String(text || "");
  const mysqlUrls = [];
  const postgresUrls = [];
  const mongodbUrls = [];

  MYSQL_URL_REGEX.lastIndex = 0;
  POSTGRES_URL_REGEX.lastIndex = 0;
  MONGODB_URL_REGEX.lastIndex = 0;

  let hit = MYSQL_URL_REGEX.exec(content);
  while (hit) {
    mysqlUrls.push(cleanToken(hit[1] || ""));
    hit = MYSQL_URL_REGEX.exec(content);
  }

  hit = POSTGRES_URL_REGEX.exec(content);
  while (hit) {
    postgresUrls.push(cleanToken(hit[1] || ""));
    hit = POSTGRES_URL_REGEX.exec(content);
  }

  hit = MONGODB_URL_REGEX.exec(content);
  while (hit) {
    mongodbUrls.push(cleanToken(hit[1] || ""));
    hit = MONGODB_URL_REGEX.exec(content);
  }

  return {
    mysql: unique(mysqlUrls),
    postgresql: unique(postgresUrls),
    mongodb: unique(mongodbUrls),
  };
}

function extractWordPressMysqlTargetFromText(text) {
  const content = String(text || "");

  function pickDefine(key) {
    const re = new RegExp(`define\\(\\s*["']${key}["']\\s*,\\s*["']([^"']*)["']\\s*\\)`, "i");
    const matched = re.exec(content);
    return matched ? String(matched[1] || "").trim() : "";
  }

  const dbName = pickDefine("DB_NAME");
  const dbUser = pickDefine("DB_USER");
  const dbPassword = pickDefine("DB_PASSWORD");
  const dbHostRaw = pickDefine("DB_HOST") || "127.0.0.1";

  if (!dbName || !dbUser) {
    return null;
  }

  const split = splitHostPort(dbHostRaw, 3306);
  return {
    engine: "mysql",
    host: split.host || "127.0.0.1",
    port: split.port || 3306,
    user: dbUser,
    password: dbPassword,
    database: dbName,
  };
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
  if (base === "wp-config.php") {
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

export async function discoverDatabaseTargets(cwd, options = {}) {
  const sqliteDiscovery = await discoverSqliteDatabasePaths(cwd, options);
  const targetsByKey = new Map();
  const mentionedTokens = new Set(sqliteDiscovery.mentioned_tokens || []);
  const discoveredFiles = new Set(sqliteDiscovery.discovered_files || []);

  function addTarget(rawTarget) {
    const target = resolveDatabaseTarget(cwd, rawTarget);
    if (!target || !target.key) {
      return;
    }
    if (!targetsByKey.has(target.key)) {
      targetsByKey.set(target.key, target);
    }
  }

  for (const sqlitePath of sqliteDiscovery.paths || []) {
    addTarget({ engine: "sqlite", sqlite_path: sqlitePath });
  }

  const sourceFiles = await listFilesRecursive(cwd, {
    maxFiles: Number(options.maxSourceFiles || 1400) || 1400,
    maxFileSize: Number(options.maxSourceFileSize || 80 * 1024) || 80 * 1024,
  });

  for (const file of sourceFiles) {
    if (!isConfigSourceFile(file)) {
      continue;
    }

    const text = await readTextSafe(file);
    if (!text) {
      continue;
    }

    const relative = toPosixPath(path.relative(cwd, file));

    const urlCandidates = extractDatabaseUrlCandidatesFromText(text);
    for (const mysqlUrl of urlCandidates.mysql) {
      if (!mysqlUrl || /\$\{/.test(mysqlUrl)) continue;
      mentionedTokens.add(sanitizeConnectionLabel(mysqlUrl, "mysql"));
      addTarget({ engine: "mysql", connection_url: mysqlUrl });
      discoveredFiles.add(relative);
    }
    for (const pgUrl of urlCandidates.postgresql) {
      if (!pgUrl || /\$\{/.test(pgUrl)) continue;
      mentionedTokens.add(sanitizeConnectionLabel(pgUrl, "postgresql"));
      addTarget({ engine: "postgresql", connection_url: pgUrl });
      discoveredFiles.add(relative);
    }
    for (const mongoUrl of urlCandidates.mongodb) {
      if (!mongoUrl || /\$\{/.test(mongoUrl)) continue;
      mentionedTokens.add(sanitizeConnectionLabel(mongoUrl, "mongodb"));
      addTarget({ engine: "mongodb", connection_url: mongoUrl });
      discoveredFiles.add(relative);
    }

    if (path.basename(file).toLowerCase() === "wp-config.php") {
      const wpTarget = extractWordPressMysqlTargetFromText(text);
      if (wpTarget) {
        addTarget(wpTarget);
        const wpLabel = `mysql://${wpTarget.user ? `${wpTarget.user}@` : ""}${wpTarget.host}:${wpTarget.port}/${wpTarget.database}`;
        mentionedTokens.add(wpLabel);
        discoveredFiles.add(relative);
      }
    }
  }

  const targets = [...targetsByKey.values()];
  const byEngine = {
    sqlite: targets.filter((item) => item.engine === "sqlite").length,
    mysql: targets.filter((item) => item.engine === "mysql").length,
    postgresql: targets.filter((item) => item.engine === "postgresql").length,
    mongodb: targets.filter((item) => item.engine === "mongodb").length,
  };

  return {
    targets,
    discovered_files: [...discoveredFiles],
    mentioned_tokens: [...mentionedTokens],
    unresolved_tokens: sqliteDiscovery.unresolved_tokens || [],
    by_engine: byEngine,
  };
}

export function quoteSqliteIdentifier(identifier) {
  return `"${String(identifier || "").replace(/"/g, '""')}"`;
}

export function quoteDatabaseIdentifier(engine, identifier) {
  const normalized = normalizeDatabaseEngine(engine);
  const raw = String(identifier || "");
  if (normalized === "mysql") {
    return `\`${raw.replace(/`/g, "``")}\``;
  }
  return `"${raw.replace(/"/g, '""')}"`;
}

export async function listSqliteTables(dbPath) {
  const rows = await runSqliteJsonQuery(
    dbPath,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return unique(rows.map((row) => String(row?.name || "").trim()).filter(Boolean));
}

export async function listDatabaseTables(target) {
  const engine = normalizeDatabaseEngine(target?.engine);
  if (engine === "sqlite") {
    const dbPath = String(target.db_path || target.sqlite_path || "").trim();
    return listSqliteTables(dbPath);
  }

  if (engine === "mysql") {
    const rows = await runDatabaseJsonQuery(
      target,
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type='BASE TABLE' ORDER BY table_name",
    );
    return unique(rows.map((row) => String(row?.name || "").trim()).filter(Boolean));
  }

  if (engine === "postgresql") {
    const rows = await runDatabaseJsonQuery(
      target,
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name",
    );
    return unique(rows.map((row) => String(row?.name || "").trim()).filter(Boolean));
  }

  if (engine === "mongodb") {
    const client = new MongoClient(buildMongoConnectionUrl(target), {
      maxPoolSize: 2,
      serverSelectionTimeoutMS: 12000,
    });
    let dbName = String(target.database || "").trim();
    if (!dbName && target.connection_url) {
      try {
        const parsed = new URL(target.connection_url);
        dbName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
      } catch {
        dbName = "";
      }
    }
    if (!dbName) {
      throw new Error("mongodb database is required");
    }
    await client.connect();
    try {
      const rows = await client.db(dbName).listCollections({}, { nameOnly: true }).toArray();
      return unique(rows.map((row) => String(row?.name || "").trim()).filter(Boolean));
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  return [];
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

export async function listDatabaseTableColumns(target, tableName) {
  const engine = normalizeDatabaseEngine(target?.engine);
  if (!tableName) {
    return [];
  }

  if (engine === "sqlite") {
    const dbPath = String(target.db_path || target.sqlite_path || "").trim();
    return listSqliteTableColumns(dbPath, tableName);
  }

  const literal = `'${String(tableName).replace(/'/g, "''")}'`;

  if (engine === "mysql") {
    const rows = await runDatabaseJsonQuery(
      target,
      [
        "SELECT column_name AS name, data_type AS type,",
        "CASE WHEN column_key='PRI' THEN 1 ELSE 0 END AS pk",
        "FROM information_schema.columns",
        "WHERE table_schema = DATABASE()",
        `AND table_name = ${literal}`,
        "ORDER BY ordinal_position",
      ].join(" "),
    );

    return rows
      .map((row) => ({
        name: String(row?.name || "").trim(),
        type: String(row?.type || "").trim(),
        pk: Number(row?.pk || 0) || 0,
      }))
      .filter((row) => row.name);
  }

  if (engine === "postgresql") {
    const rows = await runDatabaseJsonQuery(
      target,
      [
        "SELECT c.column_name AS name, c.data_type AS type,",
        "CASE WHEN tc.constraint_type = 'PRIMARY KEY' THEN 1 ELSE 0 END AS pk",
        "FROM information_schema.columns c",
        "LEFT JOIN information_schema.key_column_usage kcu",
        "ON c.table_schema = kcu.table_schema",
        "AND c.table_name = kcu.table_name",
        "AND c.column_name = kcu.column_name",
        "LEFT JOIN information_schema.table_constraints tc",
        "ON kcu.constraint_name = tc.constraint_name",
        "AND kcu.table_schema = tc.table_schema",
        "WHERE c.table_schema = 'public'",
        `AND c.table_name = ${literal}`,
        "ORDER BY c.ordinal_position",
      ].join(" "),
    );

    return rows
      .map((row) => ({
        name: String(row?.name || "").trim(),
        type: String(row?.type || "").trim(),
        pk: Number(row?.pk || 0) || 0,
      }))
      .filter((row) => row.name);
  }

  if (engine === "mongodb") {
    const docs = await runMongoQuery(
      target,
      {
        collection: tableName,
        filter: {},
        limit: 1,
      },
      { limit: 1 },
    );
    const sample = docs[0];
    if (!sample || typeof sample !== "object") {
      return [];
    }
    return Object.entries(sample)
      .map(([name, value]) => ({
        name: String(name || "").trim(),
        type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
        pk: String(name || "") === "_id" ? 1 : 0,
      }))
      .filter((item) => item.name);
  }

  return [];
}
