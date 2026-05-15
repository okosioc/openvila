import fs from "node:fs/promises";
import path from "node:path";
import { cleanTextForPrompt, listFilesRecursive, readTextSafe, toPosixPath, writeText } from "../utils/fs.js";
import { ensureRuntime, runtimePaths } from "./runtime.js";

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
];

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function briefSummary(content) {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return "(empty)";
  }
  return lines[0].slice(0, 120);
}

function tagTopic(relativePath, framework, content) {
  const tags = new Set();

  if (framework) {
    tags.add(`framework:${framework}`);
  }

  const pathText = relativePath.toLowerCase();
  if (pathText.includes("template")) tags.add("template");
  if (pathText.includes("pricing") || pathText.includes("price")) tags.add("pricing");
  if (pathText.includes("privacy")) tags.add("privacy");
  if (pathText.includes("term")) tags.add("terms");
  if (pathText.includes("refund")) tags.add("refund");

  const lower = content.toLowerCase();
  if (lower.includes("telegram") || lower.includes("feishu")) tags.add("channel");
  if (lower.includes("license") || lower.includes("agreement")) tags.add("agreement");

  return [...tags];
}

async function detectFramework(cwd) {
  const requirements = await readTextSafe(path.join(cwd, "requirements.txt"));
  if (requirements && /(^|\s)flask([=<>\[]|\s|$)/im.test(requirements)) {
    return "flask";
  }

  const pyproject = await readTextSafe(path.join(cwd, "pyproject.toml"));
  if (pyproject && /flask/im.test(pyproject)) {
    return "flask";
  }

  const packageRaw = await readTextSafe(path.join(cwd, "package.json"));
  if (packageRaw) {
    try {
      const pkg = JSON.parse(packageRaw);
      const deps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
      };
      if (deps.next) return "nextjs";
      if (deps.nuxt) return "nuxt";
      if (deps.express) return "express";
      return "node";
    } catch {
      return null;
    }
  }

  const appPy = await readTextSafe(path.join(cwd, "app.py"));
  if (appPy && /from\s+flask\s+import|import\s+flask/im.test(appPy)) {
    return "flask";
  }

  return null;
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

function makeTopicId(relativePath) {
  const normalized = toPosixPath(relativePath);
  const base = slugify(normalized);
  const stamp = Buffer.from(normalized).toString("base64url").slice(0, 10);
  return `${base}-${stamp}`;
}

export async function buildKnowledgeBase(cwd) {
  const paths = await ensureRuntime(cwd);
  const framework = await detectFramework(cwd);

  const files = await listFilesRecursive(cwd, {
    onlyExt: KNOWLEDGE_EXTENSIONS,
    maxFileSize: 300 * 1024,
    maxFiles: 700,
  });

  const prioritized = files.sort((a, b) => {
    const ar = toPosixPath(path.relative(cwd, a)).toLowerCase();
    const br = toPosixPath(path.relative(cwd, b)).toLowerCase();

    const priority = (val) => {
      if (framework === "flask" && val.startsWith("templates/")) return 0;
      if (val.includes("privacy") || val.includes("term") || val.includes("pricing")) return 1;
      return 5;
    };
    return priority(ar) - priority(br);
  });

  await cleanKnowledgeFolder(paths);

  const manifest = {
    generated_at: new Date().toISOString(),
    framework,
    total_files: 0,
    topics: [],
  };

  for (const fullPath of prioritized) {
    const content = await readTextSafe(fullPath);
    if (!content || content.trim().length === 0) {
      continue;
    }

    const relative = toPosixPath(path.relative(cwd, fullPath));
    const topicId = makeTopicId(relative);
    const cleaned = cleanTextForPrompt(content, 16000);
    const summary = briefSummary(cleaned);
    const tags = tagTopic(relative, framework, cleaned);

    const topicMd = [
      `# Topic ${topicId}`,
      "",
      `- source: ${relative}`,
      `- updated_at: ${new Date().toISOString()}`,
      `- tags: ${tags.join(", ") || "none"}`,
      "",
      "## Content",
      "",
      "```text",
      cleaned,
      "```",
      "",
    ].join("\n");

    await writeText(path.join(paths.knowledgeTopics, `${topicId}.md`), topicMd);
    await writeText(path.join(paths.knowledgeRaw, `${topicId}.txt`), cleaned);

    manifest.topics.push({
      id: topicId,
      path: relative,
      summary,
      tags,
    });
    manifest.total_files += 1;
  }

  const indexLines = [
    "# OpenVila Knowledge Index",
    "",
    `- generated_at: ${manifest.generated_at}`,
    `- framework: ${manifest.framework || "unknown"}`,
    `- topic_count: ${manifest.topics.length}`,
    "",
    "## Topics",
    "",
    "| id | source | tags | summary |",
    "|---|---|---|---|",
  ];

  for (const topic of manifest.topics) {
    indexLines.push(
      `| ${topic.id} | ${topic.path.replace(/\|/g, "\\|")} | ${(topic.tags.join(", ") || "-").replace(/\|/g, "\\|")} | ${topic.summary.replace(/\|/g, "\\|")} |`,
    );
  }

  indexLines.push("", "## Retrieval Rule", "", "Always read this index first, then load only selected topic files.");

  await writeText(paths.knowledgeIndex, indexLines.join("\n"));
  await writeText(paths.knowledgeManifest, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    framework,
    scanned: files.length,
    compiled: manifest.topics.length,
    paths,
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
  const topics = [];

  for (const id of topicIds) {
    const content = await readTextSafe(path.join(paths.knowledgeTopics, `${id}.md`));
    if (content) {
      topics.push({ id, content });
    }
  }

  return topics;
}
