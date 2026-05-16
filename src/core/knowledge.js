import fs from "node:fs/promises";
import path from "node:path";
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

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim().length > 0))];
}

function briefSummary(content) {
  const lines = String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return "(empty)";
  }
  return lines[0].slice(0, 120);
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

function normalizeGlob(glob) {
  return toPosixPath(String(glob || "").trim().replace(/^\.\//, ""));
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

function guessTopicTags(source, framework, content) {
  const tags = new Set();
  if (framework) {
    tags.add(`framework:${framework}`);
  }

  const pathText = String(source || "").toLowerCase();
  if (pathText.includes("template")) tags.add("template");
  if (pathText.includes("pricing") || pathText.includes("price")) tags.add("pricing");
  if (pathText.includes("privacy")) tags.add("privacy");
  if (pathText.includes("term") || pathText.includes("agreement")) tags.add("terms");
  if (pathText.includes("faq")) tags.add("faq");
  if (pathText.includes("blog") || pathText.includes("post")) tags.add("blog");

  const lower = String(content || "").toLowerCase();
  if (lower.includes("telegram") || lower.includes("feishu")) tags.add("channel");
  if (lower.includes("license") || lower.includes("agreement")) tags.add("agreement");

  return [...tags];
}

function scanGlobsFromConfig(config) {
  const configured = [
    ...toArray(config?.scan?.filesystem_globs),
    ...toArray(config?.scan?.filesystem?.globs),
  ].map(normalizeGlob);
  return unique(configured);
}

// 核心逻辑! 调用LLM从备选文件列表中选择知识库所需的文件并识别框架
async function pickKnowledgeFilesByLlm(config, candidatePaths) {
  const llm = ensureLlmReady(config);
  if (candidatePaths.length === 0) {
    return {
      framework: "unknown",
      framework_signals: [],
      knowledge_files: [],
      key_files: [],
      model: llm.model,
    };
  }

  const llmCandidateLimit = Math.max(60, Math.min(Number(config?.scan?.llm_candidate_limit || 420) || 420, 900));
  const sample = candidatePaths.slice(0, llmCandidateLimit);

  const messages = [
    {
      role: "system",
      content:
        'You are a knowledge scan planner. Infer framework from file paths and select only user-facing business-knowledge files. Return JSON only: {"framework":"...","framework_signals":["..."],"knowledge_files":["..."],"key_files":["..."]}. framework: project framework (flask/nextjs/wordpress/etc). framework_signals: specific files/dirs proving framework. knowledge_files: files with user-visible factual content. key_files: highest-priority subset for review.'
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
        "- key_files must be subset of knowledge_files, choose up to 18 and prefer highest business value files.",
        "- If uncertain whether a file carries user-facing business knowledge, exclude it.",
        "- Example: assets/styles.css should be excluded.",
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

  const knowledgeSet = new Set(knowledgeFiles);
  const keyFiles = unique(
    (Array.isArray(parsed?.key_files) ? parsed.key_files : [])
      .map((item) => normalizeGlob(item))
      .filter((item) => knowledgeSet.has(item)),
  );

  return {
    framework,
    framework_signals: frameworkSignals,
    knowledge_files: knowledgeFiles,
    key_files: keyFiles.length > 0 ? keyFiles : knowledgeFiles.slice(0, Math.min(12, knowledgeFiles.length)),
    model: llm.model,
  };
}

async function planFilesystemScan(cwd, config, options = {}) {
  void options;
  const maxFiles = Number(config?.scan?.max_files || 1200) || 1200;
  const allFiles = await listFilesRecursive(cwd, {
    onlyExt: KNOWLEDGE_EXTENSIONS,
    maxFileSize: 300 * 1024,
    maxFiles,
  });
  const relatives = allFiles.map((fullPath) => toPosixPath(path.relative(cwd, fullPath))).sort();
  const llmResult = await pickKnowledgeFilesByLlm(config, relatives);
  const globs = scanGlobsFromConfig(config);

  return {
    framework: llmResult.framework || "unknown",
    framework_signals: llmResult.framework_signals || [],
    globs,
    total_candidates: relatives.length,
    matched_paths: llmResult.knowledge_files,
    key_files: llmResult.key_files,
    llm_assist: {
      used: true,
      model: llmResult.model,
      selected: llmResult.knowledge_files.length,
      key_count: llmResult.key_files.length,
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

  const filesystem = await planFilesystemScan(cwd, config, options);
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

function scoreByKeywords(queryWords, fileMeta) {
  const blob = `${fileMeta.path} ${fileMeta.summary} ${fileMeta.tags.join(" ")}`.toLowerCase();
  let score = 0;
  for (const w of queryWords) {
    if (w.length < 2) continue;
    if (blob.includes(w)) score += 1;
  }
  return score;
}

export function chooseTopicsLocally(indexItems, userQuestion, limit = 4) {
  const words = userQuestion
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);

  return [...indexItems]
    .map((item) => ({ item, score: scoreByKeywords(words, item) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.item.id);
}

async function cleanKnowledgeFolder(paths) {
  await fs.rm(paths.knowledgeTopics, { recursive: true, force: true });
  await fs.rm(paths.knowledgeRaw, { recursive: true, force: true });
  await fs.mkdir(paths.knowledgeTopics, { recursive: true });
  await fs.mkdir(paths.knowledgeRaw, { recursive: true });
}

function limitText(value, maxLen) {
  return cleanTextForPrompt(String(value || ""), maxLen);
}

async function collectFilesystemDocs(cwd, framework, matchedPaths) {
  const docs = [];
  for (const relative of matchedPaths) {
    const fullPath = path.join(cwd, relative);
    const content = await readTextSafe(fullPath);
    if (!content || !content.trim()) {
      continue;
    }

    const cleaned = limitText(content, 18000);
    docs.push({
      id: `file:${relative}`,
      source: relative,
      origin: "filesystem",
      summary: briefSummary(cleaned),
      tags: guessTopicTags(relative, framework, cleaned),
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

async function collectDatabaseDocs(cwd, framework, databasePlan, log) {
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
        const text = limitText(rowToText(row), 8000);
        docs.push({
          id: source,
          source,
          origin: "database",
          summary: briefSummary(text),
          tags: unique(["database", `query:${slugify(queryItem.name)}`, `framework:${framework}`]),
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

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

async function collectRemoteDocs(framework, remotePlan, log) {
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
      const text = limitText(stripHtml(html), 10000);
      if (!text) continue;

      docs.push({
        id: `remote:${url}`,
        source: url,
        origin: "remote",
        summary: briefSummary(text),
        tags: unique(["remote", "sitemap", `framework:${framework}`]),
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

function sanitizeTopicFile(fileName) {
  const normalized = toPosixPath(String(fileName || "").trim())
    .replace(/^\/+/, "")
    .replace(/\.\.+/g, "");

  let safe = normalized
    .split("/")
    .map((part) => part.replace(/[^a-zA-Z0-9._-]/g, "-"))
    .filter(Boolean)
    .join("/");

  if (!safe) {
    safe = "misc.md";
  }

  if (!safe.endsWith(".md")) {
    safe = `${safe}.md`;
  }

  return safe;
}

// 核心逻辑! 调用LLM给文件分类
async function classifyDocsWithLlm(config, docs, locale) {
  ensureLlmReady(config);
  if (docs.length === 0) {
    return [];
  }

  const promptDocs = docs.map((doc, idx) => ({
    id: `d${idx + 1}`,
    source: doc.source,
    summary: doc.summary,
    tags: doc.tags.slice(0, 7),
  }));

  const messages = [
    {
      role: "system",
      content:
        'Group documents into topic markdown files. Return JSON only: {"topics":[{"file":"pricing.md","description":"...","keywords":["..."],"doc_ids":["d1","d2"]}]}. Must assign every doc id exactly once.',
    },
    {
      role: "user",
      content: [
        `Locale: ${locale}`,
        "Document catalog:",
        JSON.stringify(promptDocs, null, 2),
        "",
        "Constraints:",
        "- Use 3-14 topics.",
        "- Every topic must contain at least one doc id.",
        "- Every doc id must appear exactly once across all topics.",
        "- topic file must end with .md",
      ].join("\n"),
    },
  ];

  const completion = await chatCompletion(config, messages, {
    temperature: 0.1,
    maxTokens: 2600,
    trace: "scan:topic_grouping",
  });
  if (!completion.ok) {
    throw new Error(`LLM topic grouping failed: ${completion.error}`);
  }

  const parsed = extractJsonObject(completion.content);
  const topics = Array.isArray(parsed?.topics) ? parsed.topics : [];
  if (topics.length === 0) {
    throw new Error("LLM topic grouping returned no topics.");
  }

  const allowedDocIds = new Set(promptDocs.map((item) => item.id));
  const mappedTopics = [];
  const assignedDocIds = [];
  for (const rawTopic of topics) {
    const file = sanitizeTopicFile(rawTopic?.file || "");
    const description = String(rawTopic?.description || "").trim();
    const keywords = Array.isArray(rawTopic?.keywords) ? rawTopic.keywords.map((kw) => String(kw || "").trim()) : [];
    const docIds = Array.isArray(rawTopic?.doc_ids)
      ? rawTopic.doc_ids.map((id) => String(id || "").trim()).filter((id) => allowedDocIds.has(id))
      : [];
    if (docIds.length === 0) {
      continue;
    }

    mappedTopics.push({
      file,
      description: description || t(locale, "LLM 自动聚合主题", "LLM auto grouped topic"),
      keywords: unique(keywords).slice(0, 12),
      doc_ids: unique(docIds),
      from_llm: true,
    });
    assignedDocIds.push(...unique(docIds));
  }

  if (mappedTopics.length === 0) {
    throw new Error("LLM topic grouping returned empty valid topics.");
  }

  const promptMap = new Map(promptDocs.map((item, idx) => [item.id, docs[idx]?.id]));
  const assignedUnique = new Set(assignedDocIds);
  if (assignedDocIds.length !== assignedUnique.size) {
    throw new Error("LLM topic grouping produced duplicate doc assignment.");
  }
  if (assignedUnique.size !== promptDocs.length) {
    const missing = promptDocs.filter((doc) => !assignedUnique.has(doc.id)).map((doc) => doc.id);
    throw new Error(`LLM topic grouping missing doc assignment: ${missing.slice(0, 20).join(", ")}`);
  }

  for (const topic of mappedTopics) {
    topic.doc_ids = topic.doc_ids
      .map((id) => promptMap.get(id))
      .filter((id) => typeof id === "string" && id.length > 0);
  }

  return mappedTopics.filter((topic) => topic.doc_ids.length > 0);
}

function makeTopicId(fileName, usedIds) {
  let base = slugify(fileName.replace(/\.md$/i, "").replace(/\//g, "-")) || "topic";
  if (!usedIds.has(base)) {
    usedIds.add(base);
    return base;
  }
  let idx = 2;
  while (usedIds.has(`${base}-${idx}`)) {
    idx += 1;
  }
  const id = `${base}-${idx}`;
  usedIds.add(id);
  return id;
}

function rawFileNameForDoc(doc) {
  const stamp = Buffer.from(String(doc.source || doc.id || "doc")).toString("base64url").slice(0, 12);
  const base = slugify(String(doc.source || doc.id || "doc")) || "source";
  return `${base}-${stamp}.txt`;
}

async function writeRawSnapshots(paths, docs) {
  for (const doc of docs) {
    const rawName = rawFileNameForDoc(doc);
    const payload = [
      "# Raw Source Snapshot",
      "",
      `- id: ${doc.id}`,
      `- source: ${doc.source}`,
      `- origin: ${doc.origin}`,
      "",
      "```text",
      String(doc.content || ""),
      "```",
      "",
    ].join("\n");
    await writeText(path.join(paths.knowledgeRaw, rawName), payload);
  }
}

function topicExtractionDocsPayload(docs, maxDocs = 22, maxChars = 52000) {
  const chunks = [];
  let used = 0;
  for (const doc of docs.slice(0, maxDocs)) {
    const chunk = [
      `### Source: ${doc.source}`,
      `Origin: ${doc.origin}`,
      "",
      limitText(doc.content, 2600),
      "",
    ].join("\n");

    if (chunks.length > 0 && used + chunk.length > maxChars) {
      break;
    }
    chunks.push(chunk);
    used += chunk.length;
  }
  return chunks.join("\n");
}

function intRange(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(Math.floor(parsed), max));
}

function extractionConfig(config) {
  return {
    batchChars: intRange(config?.scan?.llm_extract_batch_chars, 30000, 900000, 100000),
    topicChars: intRange(config?.scan?.llm_extract_topic_chars, 8000, 90000, 18000),
    topicMaxDocs: intRange(config?.scan?.llm_extract_topic_max_docs, 3, 60, 18),
    maxTokens: intRange(config?.scan?.llm_extract_max_tokens, 1000, 12000, 4200),
  };
}

function buildExtractionBatchItems(extractionItems, config) {
  const settings = extractionConfig(config);
  const items = extractionItems.map((item, idx) => {
    const docsPayload = topicExtractionDocsPayload(item.topicDocs, settings.topicMaxDocs, settings.topicChars);
    const payload = [
      `Topic File: ${item.topicFile}`,
      `Topic Description: ${item.description || ""}`,
      `Topic Keywords: ${(item.keywords || []).join(", ")}`,
      `Topic Source Count: ${item.topicDocs.length}`,
      "",
      "Source Contents:",
      docsPayload || "(empty)",
    ].join("\n");

    return {
      ...item,
      promptId: `t${idx + 1}`,
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

function parseBatchTopicResult(json) {
  if (!json || typeof json !== "object" || !Array.isArray(json.topics)) {
    return [];
  }
  return json.topics
    .map((topic) => {
      const id = String(topic?.id || "").trim();
      const file = sanitizeTopicFile(topic?.file || "");
      const markdown = String(topic?.markdown || topic?.content || "").trim();
      if (!markdown) return null;
      return { id, file, markdown };
    })
    .filter(Boolean);
}

// 核心逻辑! 分批次调用LLM提取Topics
async function extractTopicKnowledgeBatchByLlm(config, batchItems, locale) {
  ensureLlmReady(config);
  if (batchItems.length === 0) {
    return new Map();
  }
  const settings = extractionConfig(config);

  const messages = [
    {
      role: "system",
      content:
        'You are a knowledge extraction engine for website support knowledge bases. Return JSON only: {"topics":[{"id":"t1","file":"pricing.md","markdown":"..."}]}. Extract stable facts, policies, prices, procedures, and user-facing rules. Do not dump raw source text.',
    },
    {
      role: "user",
      content: [
        `Locale: ${locale}`,
        `Topics in this batch: ${batchItems.length}`,
        "",
        "Output requirements:",
        '- For each topic id, output one entry: {"id":"...","file":"...","markdown":"..."}',
        "- markdown should use concise sections: Overview, Key Points, FAQ Candidates (if available), Edge Cases/Limitations.",
        "- Prefer extraction/synthesis over verbatim copy.",
        "- If information conflicts, call it out explicitly.",
        "",
        "Batch topic payloads:",
        ...batchItems.map((item) =>
          [
            `## Topic Id: ${item.promptId}`,
            item.payload,
          ].join("\n"),
        ),
        "",
      ].join("\n"),
    },
  ];

  const completion = await chatCompletion(config, messages, {
    temperature: 0.15,
    maxTokens: settings.maxTokens,
    trace: "scan:topic_extraction_batch",
  });
  if (!completion.ok) {
    throw new Error(`LLM topic extraction batch failed: ${completion.error}`);
  }

  const parsed = extractJsonObject(completion.content);
  const extractedTopics = parseBatchTopicResult(parsed);
  if (extractedTopics.length === 0) {
    throw new Error("LLM topic extraction batch returned empty topics.");
  }

  const byId = new Map(extractedTopics.map((item) => [item.id, item]));
  const byFile = new Map(extractedTopics.map((item) => [item.file, item]));

  const output = new Map();
  for (const batchItem of batchItems) {
    const matched = byId.get(batchItem.promptId) || byFile.get(batchItem.topicFile);
    if (!matched || !matched.markdown) {
      throw new Error(`LLM topic extraction batch missing content for ${batchItem.topicFile}`);
    }
    output.set(batchItem.topicFile, matched.markdown);
  }

  return output;
}

function formatTopicMarkdown(topic, docs, locale, extractedKnowledge) {
  const lines = [
    `# ${topic.file}`,
    "",
    `> ${topic.description}`,
    "",
    `**Keywords**: ${topic.keywords.join(", ") || "-"}`,
    `**Source Count**: ${docs.length}`,
    "",
    `## ${t(locale, "提炼知识", "Extracted Knowledge")}`,
    "",
    extractedKnowledge,
    "",
    `## ${t(locale, "来源引用", "Source References")} (${docs.length})`,
  ];

  for (const doc of docs.slice(0, 200)) {
    lines.push(`- ${doc.source} (${doc.origin})`);
  }
  return lines.join("\n");
}

function topicSummary(topic, locale, sourceCount) {
  void locale;
  void sourceCount;
  return topic.description;
}

function topicFileFromManifestItem(item) {
  if (item.file) {
    return sanitizeTopicFile(item.file);
  }

  if (item.path && String(item.path).startsWith("topics/")) {
    return sanitizeTopicFile(String(item.path).slice("topics/".length));
  }

  return sanitizeTopicFile(`${item.id}.md`);
}

function renderIndex(manifest, locale) {
  const lines = [
    "# Knowledge Index",
    "",
    t(locale, "> 这是知识库目录。LLM 应先阅读此文件，再按需加载对应主题。", "> This is the knowledge directory. LLM should read this index first, then load selected topics on demand."),
    "",
    `- generated_at: ${manifest.generated_at}`,
    `- framework: ${manifest.framework || "unknown"}`,
    `- topic_count: ${manifest.topics.length}`,
    "",
    "## Topics",
    "",
  ];

  for (const topic of manifest.topics) {
    lines.push(`### ${topic.file}`);
    lines.push(topic.summary || t(locale, "暂无说明", "No summary"));
    lines.push(`**Keywords**: ${(topic.keywords || []).join(", ") || "-"}`);
    lines.push("");
  }

  return lines.join("\n");
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

  await cleanKnowledgeFolder(paths);

  const docs = [];
  const warnings = [];
  let scannedFiles = 0;
  let scannedDbRows = 0;
  let scannedRemotePages = 0;

  if (selections.filesystem) {
    log(t(locale, "扫描文件系统中...", "Scanning file system..."));
    const fsDocs = await collectFilesystemDocs(cwd, plan.framework, plan.filesystem.matched_paths);
    docs.push(...fsDocs);
    scannedFiles = fsDocs.length;
  }

  if (selections.database) {
    log(t(locale, "执行数据库查询中...", "Running database queries..."));
    const dbResult = await collectDatabaseDocs(cwd, plan.framework, plan.database, log);
    docs.push(...dbResult.docs);
    warnings.push(...dbResult.warnings);
    scannedDbRows = dbResult.docs.length;
  }

  if (selections.remote) {
    log(t(locale, "抓取远程 sitemap 中...", "Fetching remote sitemap..."));
    const remoteResult = await collectRemoteDocs(plan.framework, plan.remote, log);
    docs.push(...remoteResult.docs);
    warnings.push(...remoteResult.warnings);
    scannedRemotePages = remoteResult.docs.length;
  }

  if (docs.length === 0) {
    throw new Error("No documents collected from selected scan sources.");
  }

  log(t(locale, "写入原始快照到 raw/ ...", "Writing raw source snapshots into raw/ ..."));
  await writeRawSnapshots(paths, docs);

  log(t(locale, "5/8 LLM 分类与聚合 topics ...", "5/8 LLM topic classification and aggregation ..."));
  const topics = await classifyDocsWithLlm(config, docs, locale);
  if (topics.length === 0) {
    throw new Error("LLM topic grouping produced no topics.");
  }

  const docMap = new Map(docs.map((doc) => [doc.id, doc]));
  const usedTopicIds = new Set();
  const manifestTopics = [];
  const extractionItems = [];

  for (const topic of topics) {
    const topicFile = sanitizeTopicFile(topic.file);
    const topicDocs = topic.doc_ids.map((id) => docMap.get(id)).filter(Boolean);
    if (topicDocs.length === 0) {
      continue;
    }

    const keywords = unique((topic.keywords || []).map((item) => String(item || "").trim())).slice(0, 14);
    const description = topicSummary(topic, locale, topicDocs.length);

    extractionItems.push({
      topic,
      topicFile,
      topicDocs,
      keywords,
      description,
    });
  }

  const extractionPlan = buildExtractionBatchItems(extractionItems, config);
  log(
    t(
      locale,
      `按批提炼主题，共 ${extractionPlan.batches.length} 批（batch_chars=${extractionPlan.settings.batchChars}）...`,
      `Extracting topics in batches: ${extractionPlan.batches.length} batch(es) (batch_chars=${extractionPlan.settings.batchChars})...`,
    ),
  );

  const extractedByTopicFile = new Map();
  for (let i = 0; i < extractionPlan.batches.length; i += 1) {
    const batch = extractionPlan.batches[i];
    log(
      t(
        locale,
        `提炼批次 ${i + 1}/${extractionPlan.batches.length}（topics=${batch.length}）`,
        `Extract batch ${i + 1}/${extractionPlan.batches.length} (topics=${batch.length})`,
      ),
    );
    const batchResult = await extractTopicKnowledgeBatchByLlm(config, batch, locale);
    for (const [topicFile, markdown] of batchResult.entries()) {
      extractedByTopicFile.set(topicFile, markdown);
    }
  }

  for (const item of extractionItems) {
    const extractedKnowledge = extractedByTopicFile.get(item.topicFile);
    if (!extractedKnowledge) {
      throw new Error(`Missing extracted topic content for ${item.topicFile}`);
    }

    const topicText = formatTopicMarkdown(
      {
        ...item.topic,
        file: item.topicFile,
        description: item.description,
        keywords: item.keywords,
      },
      item.topicDocs,
      locale,
      extractedKnowledge,
    );

    await writeText(path.join(paths.knowledgeTopics, item.topicFile), topicText);

    const topicId = makeTopicId(item.topicFile, usedTopicIds);
    manifestTopics.push({
      id: topicId,
      file: item.topicFile,
      path: `topics/${item.topicFile}`,
      summary: item.description,
      tags: item.keywords,
      keywords: item.keywords,
      source_count: item.topicDocs.length,
      sources: item.topicDocs.map((doc) => doc.source),
      raw_sources: item.topicDocs.map((doc) => ({
        source: doc.source,
        raw: `raw/${rawFileNameForDoc(doc)}`,
      })),
      from_llm: Boolean(item.topic.from_llm),
    });
  }

  const manifest = {
    generated_at: new Date().toISOString(),
    framework: plan.framework,
    framework_signals: plan.framework_signals || [],
    source_stats: {
      filesystem: scannedFiles,
      database: scannedDbRows,
      remote: scannedRemotePages,
    },
    llm_calls: {
      file_planning: 1,
      topic_grouping: 1,
      topic_extraction_batches: extractionPlan.batches.length,
      total: 2 + extractionPlan.batches.length,
      extraction_batch_chars: extractionPlan.settings.batchChars,
    },
    total_files: docs.length,
    topics: manifestTopics,
    warnings,
  };

  log(t(locale, "6/8 生成 index.md ...", "6/8 Generating index.md ..."));
  await writeText(paths.knowledgeIndex, renderIndex(manifest, locale));
  log(t(locale, "7/8 写入 manifest.json ...", "7/8 Writing manifest.json ..."));
  await writeText(paths.knowledgeManifest, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    framework: plan.framework,
    scanned: docs.length,
    compiled: manifestTopics.length,
    paths,
    plan,
    source_stats: manifest.source_stats,
    llm_calls: manifest.llm_calls,
    warnings,
    llm_topic_grouping: true,
  };
}

export async function loadKnowledgeIndex(cwd) {
  const paths = runtimePaths(cwd);
  const raw = await readTextSafe(paths.knowledgeManifest);
  if (!raw) {
    return { topics: [] };
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { topics: [] };
  }
}

export async function loadTopicContents(cwd, topicIds) {
  const paths = runtimePaths(cwd);
  const manifest = await loadKnowledgeIndex(cwd);
  const topicMap = new Map(
    (manifest.topics || []).map((topic) => [
      topic.id,
      topicFileFromManifestItem(topic),
    ]),
  );

  const topics = [];
  for (const id of topicIds) {
    const topicFile = topicMap.get(id) || sanitizeTopicFile(`${id}.md`);
    const content = await readTextSafe(path.join(paths.knowledgeTopics, topicFile));
    if (content) {
      topics.push({ id, content });
    }
  }

  return topics;
}
