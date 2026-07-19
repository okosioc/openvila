import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  runDatabaseJsonQuery,
  stringifyDbRow,
} from "../utils/db.js";
import {
  cleanTextForPrompt,
  docBaseNameNoHash,
  normalizeStoredPath,
  readTextSafe,
  sanitizeDocNamePart,
  storedPathToAbsolute,
  toPosixPath,
  writeText,
} from "../utils/fs.js";
import { fetchText, parseSitemapLocs, stripHtml } from "../utils/net.js";
import { chatCompletion, extractJsonObject } from "./llm.js";
import { ensureRuntime, loadConfig, resolveLlmSettings, runtimePaths } from "./runtime.js";
import {
  buildAutoDatabasePlan,
  collectAutoDatabaseCandidates,
  collectFilesystemCandidates,
  databasePlanFromScanPlan,
  emptyDatabasePlan,
  expandScanPlanFiles,
  generatedScanPlan,
  loadKnowledgeScanPlan,
  saveKnowledgeScanPlan,
} from "./scan-plan.js";

export { saveKnowledgeScanPlan } from "./scan-plan.js";

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
    return "remote";
  }
  return "fs";
}

function parseDbSourceParts(source) {
  const matched = /^db:([^:]+):([^:]+):(.+)$/.exec(String(source || "").trim());
  if (!matched) {
    return null;
  }
  return {
    engine: matched[1],
    table: matched[2],
    id: matched[3],
  };
}

function docStoredPathForDoc(doc) {
  const source = String(doc?.source || doc?.id || "doc").trim();
  const origin = normalizeOrigin(doc?.origin, source);
  if (origin === "database") {
    const dbParts = parseDbSourceParts(source);
    if (dbParts) {
      const engine = sanitizeDocNamePart(dbParts.engine, "db", 20);
      const table = sanitizeDocNamePart(dbParts.table, "table", 56);
      const id = sanitizeDocNamePart(dbParts.id, "id", 56);
      return `docs/db_${engine}_${table}_${id}.md`;
    }
    const fallbackId = sanitizeDocNamePart(source.replace(/^db:/i, ""), "id", 72);
    return `docs/db_unknown_table_${fallbackId}.md`;
  }
  const prefix = docPrefixByOrigin(origin);
  let sourceForName = source;
  if (origin === "remote") {
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
      selected_table_keys: [],
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
        "- Exclude style/script/media files: *.css, *.scss, *.sass, *.less, *.js.map, *.css.map, *.min.js, *.min.css, icons/svgs/images/fonts/videos.",
        "- Exclude lock/generated files: package-lock.json, pnpm-lock.yaml, yarn.lock, bun.lockb, poetry.lock, composer.lock.",
        "- Exclude infra/system/test tables by default: migrations, alembic_version, sessions, cache, jobs, logs, audit tables.",
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
  const selectedTableKeys = unique(
    (Array.isArray(parsed?.knowledge_tables) ? parsed.knowledge_tables : [])
      .map((item) => {
        const normalized = String(item || "").trim().toLowerCase();
        if (!normalized) return "";
        return tableKeyMap.get(normalized) || tableNameMap.get(normalized) || "";
      })
      .filter(Boolean),
  );

  if (knowledgeFiles.length === 0 && selectedTableKeys.length === 0) {
    throw new Error("LLM file planning returned no knowledge_files/knowledge_tables.");
  }

  return {
    framework,
    framework_signals: frameworkSignals,
    knowledge_files: knowledgeFiles,
    selected_table_keys: selectedTableKeys,
    model: llm.model,
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

  const skipDatabase = Boolean(options.skipDatabase);
  const skipRemote = Boolean(options.skipRemote);
  const scanPlanOverride = options.scanPlan;
  const scanPlan = options.resetPlan ? null : scanPlanOverride || (await loadKnowledgeScanPlan(cwd));
  const relatives = await collectFilesystemCandidates(cwd, config);

  if (scanPlan) {
    const database = skipDatabase ? emptyDatabasePlan() : databasePlanFromScanPlan(cwd, config, scanPlan);
    const remoteUrl = skipRemote ? "" : String(config?.scan?.sitemap_url || config?.scan?.remote?.sitemap_url || "").trim();
    const remoteMaxPagesRaw = Number(config?.scan?.remote_max_pages || config?.scan?.remote?.max_pages || 20) || 20;
    const remoteMaxPages = Math.max(1, Math.min(remoteMaxPagesRaw, 80));
    const filesystem = {
      total_candidates: relatives.length,
      matched_paths: expandScanPlanFiles(relatives, scanPlan),
    };

    return {
      generated_at: new Date().toISOString(),
      planning_mode: "plan",
      framework: "scan-plan",
      framework_signals: [],
      llm_model: "",
      filesystem,
      database,
      remote: {
        sitemap_url: remoteUrl,
        max_pages: remoteMaxPages,
        enabled: Boolean(remoteUrl),
      },
      locale: inferLocale(config),
      scan_plan_path: runtimePaths(cwd).scanPlan,
      generated_scan_plan: scanPlanOverride || undefined,
    };
  }

  const autoDbCandidates =
    skipDatabase
      ? { table_candidates: [], discovery: emptyDatabasePlan().discovery }
      : await collectAutoDatabaseCandidates(cwd, config);

  const llmResult = await pickKnowledgesByLlm(config, {
    candidatePaths: relatives,
    tableCandidates: autoDbCandidates.table_candidates || [],
  });

  const filesystem = {
    total_candidates: relatives.length,
    matched_paths: llmResult.knowledge_files,
  };

  const database = skipDatabase
    ? emptyDatabasePlan()
    : buildAutoDatabasePlan(config, llmResult.selected_table_keys || [], autoDbCandidates);

  const remoteUrl = skipRemote ? "" : String(config?.scan?.sitemap_url || config?.scan?.remote?.sitemap_url || "").trim();
  const remoteMaxPagesRaw = Number(config?.scan?.remote_max_pages || config?.scan?.remote?.max_pages || 20) || 20;
  const remoteMaxPages = Math.max(1, Math.min(remoteMaxPagesRaw, 80));
  const remote = {
    sitemap_url: remoteUrl,
    max_pages: remoteMaxPages,
    enabled: Boolean(remoteUrl),
  };

  return {
    generated_at: new Date().toISOString(),
    planning_mode: "auto",
    framework: llmResult.framework || "unknown",
    framework_signals: llmResult.framework_signals || [],
    llm_model: llmResult.model,
    filesystem,
    database,
    remote,
    locale: inferLocale(config),
    generated_scan_plan: generatedScanPlan(filesystem, database),
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

    const cleaned = cleanTextForPrompt(String(content || ""), 28000);
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
  const limiter =
    typeof options.limitText === "function"
      ? options.limitText
      : (value, maxLen) => cleanTextForPrompt(String(value ?? ""), maxLen);
  const usedSources = new Set();

  function pickRowId(row, index) {
    if (row && typeof row === "object") {
      const direct = row.id ?? row._id ?? row.post_id ?? row.uid;
      if (direct !== undefined && direct !== null && String(direct).trim()) {
        return String(direct);
      }

      for (const [key, value] of Object.entries(row)) {
        if (!/_id$/i.test(String(key))) continue;
        if (value === undefined || value === null) continue;
        if (!String(value).trim()) continue;
        return String(value);
      }
    }
    return String(index);
  }

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
      const engineToken = sanitizeDocNamePart(queryItem.engine || target.engine || "db", "db", 20);
      const tableName = String(queryItem.table_name || queryItem.name || "table").trim();
      const tableToken = sanitizeDocNamePart(tableName, "table", 56);
      for (let i = 0; i < rows.length && i < queryItem.limit; i += 1) {
        const row = rows[i];
        const rowIdRaw = pickRowId(row, i + 1);
        let rowIdToken = sanitizeDocNamePart(rowIdRaw, String(i + 1), 56);
        let source = `db:${engineToken}:${tableToken}:${rowIdToken}`;
        if (usedSources.has(source)) {
          rowIdToken = sanitizeDocNamePart(`${rowIdToken}_${i + 1}`, String(i + 1), 56);
          source = `db:${engineToken}:${tableToken}:${rowIdToken}`;
        }
        usedSources.add(source);
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
      const text = cleanTextForPrompt(stripHtml(html), 16000);
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
      cleanTextForPrompt(String(doc.content || ""), settings.docContentChars),
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

function sectionForEntry(heading, item, options = {}) {
  const includeEmbeddedContent = Boolean(options.includeEmbeddedContent);
  const embeddedContent = String(options.embeddedContent || "").trim();
  const lines = [
    `### ${heading}`,
    item.title || "-",
    `**Keywords**: ${(item.tags || []).join(", ") || "-"}`,
    `**Summary**: ${item.summary || "-"}`,
    `**Frequent Customer Concern**: ${item.is_frequently_asked ? "yes" : "no"}`,
    `**Doc**: ${item.doc_path}`,
    "",
  ];

  if (includeEmbeddedContent) {
    lines.push("#### Embedded Content", "");
    lines.push(embeddedContent || "(content unavailable)", "");
  }

  return lines.join("\n");
}

function extractCompiledDocBody(markdown) {
  const text = String(markdown || "").replace(/\r\n?/g, "\n");
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  const lines = trimmed.split("\n");
  const contentHeadingPattern = /^##\s+(正文|content)\s*$/i;
  const startIndex = lines.findIndex((line) => contentHeadingPattern.test(line.trim()));
  if (startIndex < 0) {
    return trimmed;
  }

  const body = lines.slice(startIndex + 1).join("\n").trim();
  return body || trimmed;
}

async function loadFrequentDocContents(paths, frequentItems) {
  const output = new Map();
  for (const item of frequentItems) {
    const docPath = normalizeStoredPath(item?.doc_path, "docs");
    if (!docPath) {
      output.set(item?.doc_path || "", "");
      continue;
    }
    const absolute = storedPathToAbsolute(paths.knowledges, docPath);
    const content = (await readTextSafe(absolute)) || "";
    output.set(item.doc_path, extractCompiledDocBody(content));
  }
  return output;
}

async function renderIndexMarkdown({ locale, generatedAt, scanMode, indexMap, paths }) {
  const entries = Object.entries(indexMap || {}).map(([source, item]) => ({ source, ...item }));
  entries.sort((a, b) => String(a.doc_path || "").localeCompare(String(b.doc_path || "")));

  const frequentItems = entries.filter((item) => Boolean(item.is_frequently_asked));
  const frequentDocContents = await loadFrequentDocContents(paths, frequentItems);

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
      lines.push(
        sectionForEntry(heading, item, {
          includeEmbeddedContent: true,
          embeddedContent: frequentDocContents.get(item.doc_path) || "",
        }),
      );
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

async function writeCompiledDocs(paths, compiledBySource, options = {}) {
  const reset = Boolean(options.reset);
  const previousDocMap = options.previousDocMap || {};
  const deletedSources = (options.deletedSources || []).map((item) => String(item || "").trim()).filter(Boolean);

  for (const [source, item] of compiledBySource.entries()) {
    const docPath = normalizeStoredPath(item.doc_path, "docs");
    if (!docPath) {
      continue;
    }
    const fullPath = storedPathToAbsolute(paths.knowledges, docPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await writeText(fullPath, item.markdown || "");

    const previousDocPath = normalizeStoredPath(previousDocMap[source], "docs");
    if (!reset && previousDocPath && previousDocPath !== docPath) {
      await fs.rm(storedPathToAbsolute(paths.knowledges, previousDocPath), { force: true });
    }
  }

  if (!reset) {
    for (const source of deletedSources) {
      const previousDocPath = normalizeStoredPath(previousDocMap[source], "docs");
      if (!previousDocPath) continue;
      await fs.rm(storedPathToAbsolute(paths.knowledges, previousDocPath), { force: true });
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
      resetPlan: Boolean(options.reset),
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
    const dbResult = await collectDatabaseDocs(cwd, plan.database, { log, limitText: cleanTextForPrompt });
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
        `4/6 LLM 批量编译变更文档，共 ${compilePlan.batches.length} 批（batch_chars=${compilePlan.settings.batchChars}）...`,
        `4/6 LLM compiling changed docs in batches: ${compilePlan.batches.length} (batch_chars=${compilePlan.settings.batchChars})...`,
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
    log(t(locale, "4/6 无新增或变更文档，跳过文档编译。", "4/6 No added/changed docs. Skipping compile."));
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
      "5/6 重建 index.md（并写入 manifest.json）...",
      "5/6 Rebuilding index.md (and writing manifest.json) ...",
    ),
  );
  const indexMarkdown = await renderIndexMarkdown({
    locale,
    generatedAt: nowIso,
    scanMode: reset ? "reset" : "incremental",
    indexMap: finalIndexMap,
    paths,
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
    const content = await readTextSafe(storedPathToAbsolute(paths.knowledges, docPath));
    if (content) {
      output.push({
        doc_path: docPath,
        content,
      });
    }
  }

  return output;
}
