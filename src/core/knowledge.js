import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cleanTextForPrompt, listFilesRecursive, readTextSafe, toPosixPath, writeText } from "../utils/fs.js";
import { chatCompletion, extractJsonObject } from "./llm.js";
import { ensureRuntime, loadConfig, resolveLlmSettings, runtimePaths } from "./runtime.js";

const execFileAsync = promisify(execFile);

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

function normalizeGlob(glob) {
  return toPosixPath(String(glob || "").trim().replace(/^\.\//, ""));
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
  const base = docBaseNameNoHash(source);
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

// 核心逻辑! 根据候选文件路径列表，调用 LLM 进行框架推断和知识文件筛选。
async function pickKnowledgeFilesByLlm(config, candidatePaths) {
  const llm = ensureLlmReady(config);
  if (candidatePaths.length === 0) {
    return {
      framework: "unknown",
      framework_signals: [],
      knowledge_files: [],
      model: llm.model,
    };
  }

  const llmCandidateLimit = Math.max(60, Math.min(Number(config?.scan?.llm_candidate_limit || 420) || 420, 900));
  const sample = candidatePaths.slice(0, llmCandidateLimit);

  const messages = [
    {
      role: "system",
      content:
        'You are a knowledge scan planner. Infer framework from file paths and select only user-facing business-knowledge files. Return JSON only: {"framework":"...","framework_signals":["..."],"knowledge_files":["..."]}. framework: project framework (flask/nextjs/wordpress/etc). framework_signals: specific files/dirs proving framework. knowledge_files: files with user-visible factual content.',
    },
    {
      role: "user",
      content: [
        `Candidate file count: ${sample.length}`,
        "Candidates:",
        sample.join("\n"),
        "",
        "Constraints:",
        "- Choose knowledge_files from candidates only.",
        "- Prioritize business text pages: pricing, terms, privacy, refund, faq/help, about/contact, product docs, support, policy pages, blog index/posts.",
        "- Exclude static/code-only files: assets/**, static/**, public/**, dist/**, build/**, vendor/**, node_modules/**.",
        "- Exclude style/script/media files: *.css, *.scss, *.sass, *.less, *.js.map, *.css.map, *.min.js, *.min.css, images/fonts/videos.",
        "- Exclude lock/generated files: package-lock.json, pnpm-lock.yaml, yarn.lock, bun.lockb, poetry.lock, composer.lock.",
        "- Do NOT pad file count. It is valid to return fewer than 12 if fewer relevant files exist.",
        "- If uncertain whether a file carries user-facing business knowledge, exclude it.",
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
      .map((item) => normalizeGlob(item))
      .filter((item) => available.has(item)),
  );
  if (knowledgeFiles.length === 0) {
    throw new Error("LLM file planning returned no knowledge_files.");
  }

  return {
    framework,
    framework_signals: frameworkSignals,
    knowledge_files: knowledgeFiles,
    model: llm.model,
  };
}

async function planFilesystemScan(cwd, config) {
  const maxFiles = Number(config?.scan?.max_files || 1200) || 1200;
  const allFiles = await listFilesRecursive(cwd, {
    onlyExt: KNOWLEDGE_EXTENSIONS,
    maxFileSize: 300 * 1024,
    maxFiles,
  });
  const relatives = allFiles.map((fullPath) => toPosixPath(path.relative(cwd, fullPath))).sort();
  const llmResult = await pickKnowledgeFilesByLlm(config, relatives);

  return {
    framework: llmResult.framework || "unknown",
    framework_signals: llmResult.framework_signals || [],
    total_candidates: relatives.length,
    matched_paths: llmResult.knowledge_files,
    llm_assist: {
      used: true,
      model: llmResult.model,
      selected: llmResult.knowledge_files.length,
    },
  };
}

function normalizeDbQueryConfig(rawQueries) {
  return rawQueries
    .map((item, idx) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const name = String(item.name || `query_${idx + 1}`).trim();
      const sqlitePath = String(item.sqlite_path || item.sqlitePath || item.database || item.db || "").trim();
      const query = String(item.query || item.sql || "").trim();
      const limit = Math.max(1, Math.min(Number(item.limit || 50) || 50, 300));
      if (!sqlitePath || !query) {
        return null;
      }
      return {
        name,
        sqlite_path: sqlitePath,
        query,
        limit,
      };
    })
    .filter(Boolean);
}

function planDatabaseScan(config) {
  const rawQueries = [
    ...toArray(config?.scan?.database_queries),
    ...toArray(config?.scan?.database?.queries),
  ];
  const queries = normalizeDbQueryConfig(rawQueries);
  return { queries };
}

function planRemoteScan(config) {
  const url = String(config?.scan?.sitemap_url || config?.scan?.remote?.sitemap_url || "").trim();
  const maxPagesRaw = Number(config?.scan?.remote_max_pages || config?.scan?.remote?.max_pages || 20) || 20;
  const maxPages = Math.max(1, Math.min(maxPagesRaw, 80));

  return {
    sitemap_url: url,
    max_pages: maxPages,
    enabled: Boolean(url),
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

  const filesystem = await planFilesystemScan(cwd, config);
  const database = planDatabaseScan(config);
  const remote = planRemoteScan(config);

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

function rowToText(row) {
  if (!row || typeof row !== "object") {
    return String(row);
  }
  return JSON.stringify(row, null, 2);
}

async function collectDatabaseDocs(cwd, databasePlan, log) {
  const docs = [];
  const warnings = [];

  for (const queryItem of databasePlan.queries) {
    const dbPath = path.isAbsolute(queryItem.sqlite_path)
      ? queryItem.sqlite_path
      : path.join(cwd, queryItem.sqlite_path);
    try {
      const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, queryItem.query], {
        maxBuffer: 8 * 1024 * 1024,
      });

      const rows = JSON.parse(stdout || "[]");
      if (!Array.isArray(rows)) {
        continue;
      }

      for (let i = 0; i < rows.length && i < queryItem.limit; i += 1) {
        const row = rows[i];
        const source = `db:${queryItem.name}#${i + 1}`;
        const text = limitText(rowToText(row), 16000);
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
      if (typeof log === "function") {
        log(message);
      }
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
    const dbResult = await collectDatabaseDocs(cwd, plan.database, log);
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
    const previousIndex = previousIndexMap[source];

    if (reset || !previousHash || !previousDocPath || !previousIndex) {
      addedSources.push(source);
      continue;
    }

    if (previousHash !== currentSourceHashes[source]) {
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
