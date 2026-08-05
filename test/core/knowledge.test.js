import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sqlite3 from "sqlite3";
import { buildKnowledgeBase, loadDocContents, prepareKnowledgeScanPlan, saveKnowledgeScanPlan } from "../../src/core/knowledge.js";
import { defaultConfig, initializeRuntime, runtimePaths } from "../../src/core/runtime.js";
import { collectAutoDatabaseCandidates, generatedScanPlan, parseKnowledgeScanPlan, stringifyKnowledgeScanPlan } from "../../src/core/scan-plan.js";
import { resolveDatabaseTarget } from "../../src/utils/db.js";

async function readRequestBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
  }
  return body ? JSON.parse(body) : {};
}

async function createSqliteDatabase(filePath) {
  await new Promise((resolve, reject) => {
    const database = new sqlite3.Database(filePath, (openError) => {
      if (openError) {
        reject(openError);
        return;
      }
      database.exec("CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT)", (createError) => {
        database.close((closeError) => {
          if (createError) {
            reject(createError);
          } else if (closeError) {
            reject(closeError);
          } else {
            resolve();
          }
        });
      });
    });
  });
}

async function insertSqlitePost(filePath, title) {
  await new Promise((resolve, reject) => {
    const database = new sqlite3.Database(filePath, (openError) => {
      if (openError) {
        reject(openError);
        return;
      }
      database.run("INSERT INTO posts (title) VALUES (?)", [title], (insertError) => {
        database.close((closeError) => {
          if (insertError) {
            reject(insertError);
          } else if (closeError) {
            reject(closeError);
          } else {
            resolve();
          }
        });
      });
    });
  });
}

async function startLlmServer(options = {}) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const body = await readRequestBody(request);
    requests.push(body);
    const isDocCompiler = String(body?.messages?.[0]?.content || "").includes("website knowledge document compiler");
    response.writeHead(200, { "Content-Type": "application/json" });
    const input = String(body?.messages?.[1]?.content || "");
    const documentIds = [...input.matchAll(/^##\s+(d\d+)\s*$/gm)].map((match) => match[1]);
    const content = isDocCompiler
      ? {
          docs: (documentIds.length > 0 ? documentIds : ["d1"]).map((id) => ({
            id,
            title: "FAQ",
            tags: ["vip"],
            summary: "VIP information.",
            body: options.compilerBody || "Read the VIP information.",
            is_frequently_asked: true,
          })),
        }
      : {
          framework: "static",
          framework_signals: ["faq.html"],
          knowledge_files: ["faq.html", "guide.md", "app.ts", "visible.draft.md"],
          knowledge_tables: [],
        };
    response.end(JSON.stringify({ choices: [{ finish_reason: options.finishReason || "stop", message: { content: JSON.stringify(content) } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("LLM test server did not expose a TCP port");
  }

  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function startRemotePageServer() {
  const server = http.createServer((request, response) => {
    if (request.url !== "/faq") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<h1>Remote FAQ</h1><p>Remote support information.</p>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Remote page test server did not expose a TCP port");
  }

  return {
    url: `http://127.0.0.1:${address.port}/faq`,
    close: () => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

test("default scan config has no db_auto toggle", () => {
  assert.equal("db_auto" in defaultConfig().scan, false);
  assert.equal(defaultConfig().scan.llm_plan_max_tokens, 4800);
  assert.equal(defaultConfig().scan.llm_compile_batch_chars, 50000);
  assert.equal(defaultConfig().scan.llm_compile_doc_chars, 20000);
  assert.equal(defaultConfig().scan.llm_compile_max_tokens, 20000);
});

test("default config has a language setting", () => {
  assert.equal(typeof defaultConfig().language, "string");
});

test("prepareKnowledgeScanPlan excludes gitignored styles and multimedia candidates before LLM planning", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-knowledge-test-"));
  const llm = await startLlmServer();
  context.after(async () => {
    await llm.close();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  await fs.mkdir(path.join(cwd, "ignored"));
  await Promise.all([
    fs.writeFile(path.join(cwd, ".gitignore"), "ignored/\nprivate.md\n*.draft.md\n!visible.draft.md\n"),
    fs.writeFile(path.join(cwd, "faq.html"), "<h1>FAQ</h1>"),
    fs.writeFile(path.join(cwd, "guide.md"), "# Guide"),
    fs.writeFile(path.join(cwd, "site.css"), "body {}"),
    fs.writeFile(path.join(cwd, "theme.scss"), "$color: red;"),
    fs.writeFile(path.join(cwd, "app.ts"), "export const app = true;"),
    fs.writeFile(path.join(cwd, "hero.jpg"), "image"),
    fs.writeFile(path.join(cwd, "intro.mp4"), "video"),
    fs.writeFile(path.join(cwd, "private.md"), "Private"),
    fs.writeFile(path.join(cwd, "notes.draft.md"), "Draft"),
    fs.writeFile(path.join(cwd, "visible.draft.md"), "Visible draft"),
    fs.writeFile(path.join(cwd, "ignored", "private.md"), "Ignored"),
  ]);

  const plan = await prepareKnowledgeScanPlan(cwd, {
    config: {
      llm: {
        endpoint: llm.endpoint,
        api_key: "test-key",
        model: "test-model",
      },
      scan: { llm_plan_max_tokens: 3600 },
    },
  });

  const prompt = llm.requests[0].messages[1].content;
  const candidates = prompt.split("Candidates:\n")[1].split("\n\nCandidate table count:")[0];
  assert.equal(llm.requests[0].max_tokens, 3600);
  assert.match(prompt, /at most 12 knowledge_files and at most 6 knowledge_tables/);
  assert.equal(plan.filesystem.total_candidates, 4);
  assert.equal(plan.planning_mode, "auto");
  assert.equal(plan.llm_model, "test-model");
  assert.equal("llm_assist" in plan.filesystem, false);
  assert.equal("knowledge_tables" in plan.filesystem, false);
  assert.match(candidates, /faq\.html/);
  assert.match(candidates, /guide\.md/);
  assert.match(candidates, /app\.ts/);
  assert.match(candidates, /visible\.draft\.md/);
  assert.doesNotMatch(
    candidates,
    /site\.css|theme\.scss|hero\.jpg|intro\.mp4|private\.md|notes\.draft\.md|ignored\/private\.md/,
  );
  assert.deepEqual(plan.generated_scan_plan, {
    files: ["faq.html", "guide.md", "app.ts", "visible.draft.md"],
  });
  const scanPlanPath = await saveKnowledgeScanPlan(cwd, plan);
  assert.equal(path.basename(scanPlanPath), "scan-plan");
  assert.match(await fs.readFile(scanPlanPath, "utf8"), /^file:\/\/faq\.html/m);
});

test("prepareKnowledgeScanPlan skips filesystem candidates when requested", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-knowledge-test-"));
  context.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.writeFile(path.join(cwd, "faq.html"), "<h1>FAQ</h1>");

  const plan = await prepareKnowledgeScanPlan(cwd, {
    config: {
      llm: {
        endpoint: "http://127.0.0.1:1",
        api_key: "test-key",
        model: "test-model",
      },
      scan: {},
    },
    skipFilesystem: true,
  });

  assert.equal(plan.filesystem.total_candidates, 0);
  assert.deepEqual(plan.filesystem.matched_paths, []);
  assert.deepEqual(plan.generated_scan_plan, { files: [] });
});

test("prepareKnowledgeScanPlan reports a truncated planning response", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-knowledge-test-"));
  const llm = await startLlmServer({ finishReason: "length" });
  context.after(async () => {
    await llm.close();
    await fs.rm(cwd, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(cwd, "faq.html"), "<h1>FAQ</h1>");

  await assert.rejects(
    prepareKnowledgeScanPlan(cwd, {
      config: {
        llm: {
          endpoint: llm.endpoint,
          api_key: "test-key",
          model: "test-model",
        },
        scan: {},
      },
    }),
    /LLM file planning failed: LLM output reached max_tokens \(4800\); finish_reason: length/,
  );
});

test("prepareKnowledgeScanPlan uses an editable scan plan without LLM planning", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-knowledge-test-"));
  context.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await Promise.all([
    fs.mkdir(path.join(cwd, ".openvila")),
    fs.mkdir(path.join(cwd, "www", "posts"), { recursive: true }),
    fs.mkdir(path.join(cwd, "docs"), { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(
      path.join(cwd, ".openvila", "scan-plan"),
      [
        "file://www/posts/*",
        "file://docs/**/*.md",
        "https://example.com/help",
        "sqlite://data/site.db::posts",
        "",
      ].join("\n"),
    ),
    fs.writeFile(path.join(cwd, "www", "posts", "first.html"), "<h1>First</h1>"),
    fs.writeFile(path.join(cwd, "www", "posts", "second.md"), "# Second"),
    fs.writeFile(path.join(cwd, "docs", "guide.md"), "# Guide"),
  ]);

  const plan = await prepareKnowledgeScanPlan(cwd, { config: { scan: { db_auto_query_limit: 12 } } });

  assert.equal(plan.planning_mode, "plan");
  assert.equal(plan.framework, "unknown");
  assert.equal(plan.llm_model, "");
  assert.equal("llm_assist" in plan.filesystem, false);
  assert.deepEqual(plan.filesystem.matched_paths, ["docs/guide.md", "www/posts/first.html", "www/posts/second.md"]);
  assert.equal(plan.database.queries[0].table_name, "posts");
  assert.deepEqual(plan.database.selected_table_keys, ["sqlite://data/site.db::posts"]);
  assert.equal(plan.database.queries[0].limit, 12);
  assert.equal(plan.database.queries[0].target.connection_url, "sqlite://data/site.db");
  assert.deepEqual(plan.remote, {
    sitemap_url: "",
    urls: ["https://example.com/help"],
    max_pages: 20,
    enabled: true,
  });
});

test("buildKnowledgeBase records no planning call when reusing an unchanged scan plan", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-knowledge-test-"));
  context.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const content = '<h1>FAQ</h1><a href="/dash/buy-vip">Buy VIP</a>';
  const sourceHash = crypto
    .createHash("sha1")
    .update("filesystem\nfaq.html\n<h1>FAQ</h1><a href=\"/dash/buy-vip\">Buy VIP</a>")
    .digest("hex");
  const knowledges = path.join(cwd, ".openvila", "knowledges");

  await fs.mkdir(path.join(knowledges, "docs"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(cwd, "faq.html"), content),
    fs.writeFile(path.join(cwd, ".openvila", "config.yaml"), "language: en\n"),
    fs.writeFile(path.join(knowledges, "docs", "fs-faq-html.md"), "# FAQ\n"),
    fs.writeFile(path.join(knowledges, "docs", ".fs-faq-html.md.scan-a4f9e.tmp"), "interrupted scan\n"),
    fs.writeFile(
      path.join(knowledges, "manifest.json"),
      `${JSON.stringify({
        source_hashes: { "faq.html": sourceHash },
        source_doc_map: { "faq.html": "docs/fs-faq-html.md" },
        index_map: {
          "faq.html": {
            doc_path: "docs/fs-faq-html.md",
            title: "FAQ",
            summary: "Frequently asked questions.",
            tags: ["faq"],
            updated_at: "2026-01-01T00:00:00.000Z",
            is_frequently_asked: false,
          },
        },
      }, null, 2)}\n`,
    ),
  ]);

  const result = await buildKnowledgeBase(cwd, {
    config: { scan: {} },
    plan: {
      planning_mode: "plan",
      framework: "unknown",
      framework_signals: [],
      filesystem: { matched_paths: ["faq.html"] },
      database: { queries: [] },
      remote: { enabled: false },
    },
  });

  assert.equal(result.compiled, 0);
  assert.deepEqual(result.llm_calls, {
    file_planning: 0,
    doc_compile_batches: 0,
    total: 0,
    doc_compile_batch_chars: 50000,
  });
  await assert.rejects(fs.access(path.join(knowledges, "docs", ".fs-faq-html.md.scan-a4f9e.tmp")), { code: "ENOENT" });
});

test("buildKnowledgeBase recompiles an unchanged source when its compiled document is missing", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-knowledge-test-"));
  const llm = await startLlmServer();
  context.after(async () => {
    await llm.close();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  await initializeRuntime(cwd);
  const paths = runtimePaths(cwd);
  const content = "<h1>FAQ</h1>";
  const sourceHash = crypto.createHash("sha1").update(`filesystem\nfaq.html\n${content}`).digest("hex");
  await fs.writeFile(path.join(cwd, "faq.html"), content);
  await fs.writeFile(
    paths.knowledgeManifest,
    `${JSON.stringify({
      source_hashes: { "faq.html": sourceHash },
      source_doc_map: { "faq.html": "docs/fs-faq-html.md" },
      index_map: {
        "faq.html": {
          doc_path: "docs/fs-faq-html.md",
          title: "FAQ",
          summary: "Frequently asked questions.",
          tags: ["faq"],
          updated_at: "2026-01-01T00:00:00.000Z",
          is_frequently_asked: false,
        },
      },
    }, null, 2)}\n`,
  );

  const result = await buildKnowledgeBase(cwd, {
    config: {
      llm: {
        endpoint: llm.endpoint,
        api_key: "test-key",
        model: "test-model",
      },
      scan: {},
    },
    plan: {
      planning_mode: "plan",
      framework: "unknown",
      framework_signals: [],
      filesystem: { matched_paths: ["faq.html"] },
      database: { queries: [] },
      remote: { enabled: false },
    },
  });

  assert.equal(result.compiled, 1);
  assert.match(await fs.readFile(path.join(paths.knowledgeDocs, "fs-faq-html.md"), "utf8"), /Read the VIP information/);
});

test("buildKnowledgeBase reuses scan plan and recompiles unchanged sources when reset is set", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-knowledge-test-"));
  const llm = await startLlmServer();
  context.after(async () => {
    await llm.close();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  await initializeRuntime(cwd);
  const paths = runtimePaths(cwd);
  await fs.writeFile(path.join(cwd, "faq.html"), "<h1>FAQ</h1>");
  await fs.writeFile(paths.scanPlan, "file://faq.html\n");
  const config = {
    llm: {
      endpoint: llm.endpoint,
      api_key: "test-key",
      model: "test-model",
    },
    scan: {},
  };
  const plan = {
    planning_mode: "plan",
    framework: "unknown",
    framework_signals: [],
    filesystem: { matched_paths: ["faq.html"] },
    database: { queries: [] },
    remote: { enabled: false },
  };

  await buildKnowledgeBase(cwd, { config, plan });
  const result = await buildKnowledgeBase(cwd, { config, reset: true });
  const compilerRequests = llm.requests.filter((request) =>
    String(request?.messages?.[0]?.content || "").includes("website knowledge document compiler"),
  );

  assert.equal(result.compiled, 1);
  assert.equal(result.changes.added, 1);
  assert.equal(result.changes.unchanged, 0);
  assert.equal(compilerRequests.length, 2);
  assert.equal(llm.requests.length, 2);
});

test("buildKnowledgeBase preserves the previous knowledge base when reset compilation fails", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-knowledge-test-"));
  const llm = await startLlmServer({ finishReason: "length" });
  context.after(async () => {
    await llm.close();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  await initializeRuntime(cwd);
  const paths = runtimePaths(cwd);
  const previousManifest = `${JSON.stringify({
    source_hashes: { "previous.html": "previous-hash" },
    source_doc_map: { "previous.html": "docs/fs-previous-html.md" },
    index_map: {
      "previous.html": {
        doc_path: "docs/fs-previous-html.md",
        title: "Previous FAQ",
        summary: "Previous knowledge.",
        tags: ["previous"],
        updated_at: "2026-08-03T00:00:00.000Z",
        is_frequently_asked: true,
      },
    },
  }, null, 2)}\n`;

  await Promise.all([
    fs.writeFile(path.join(cwd, "faq.html"), "<h1>New FAQ</h1>"),
    fs.writeFile(path.join(paths.knowledgeDocs, "fs-previous-html.md"), "# Previous FAQ\n"),
    fs.writeFile(paths.knowledgeIndex, "# Previous Index\n"),
    fs.writeFile(paths.knowledgeManifest, previousManifest),
  ]);

  await assert.rejects(
    buildKnowledgeBase(cwd, {
      reset: true,
      config: {
        llm: {
          endpoint: llm.endpoint,
          api_key: "test-key",
          model: "test-model",
        },
        scan: {},
      },
      plan: {
        planning_mode: "plan",
        framework: "unknown",
        framework_signals: [],
        filesystem: { matched_paths: ["faq.html"] },
        database: { queries: [] },
        remote: { enabled: false },
      },
    }),
    /LLM doc compile batch failed: LLM output reached max_tokens/,
  );

  assert.equal(await fs.readFile(path.join(paths.knowledgeDocs, "fs-previous-html.md"), "utf8"), "# Previous FAQ\n");
  assert.equal(await fs.readFile(paths.knowledgeIndex, "utf8"), "# Previous Index\n");
  assert.equal(await fs.readFile(paths.knowledgeManifest, "utf8"), previousManifest);
});

test("buildKnowledgeBase forwards raw source content to the document compiler", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-knowledge-test-"));
  const llm = await startLlmServer();
  context.after(async () => {
    await llm.close();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  await initializeRuntime(cwd);
  await fs.writeFile(
    path.join(cwd, "faq.html"),
    '<h1>FAQ</h1><p>Use <name>. Read <a href="/dash/buy-vip">Buy VIP</a>.</p>',
  );
  const config = defaultConfig();
  config.llm = {
    endpoint: llm.endpoint,
    api_key: "test-key",
    model: "test-model",
  };

  const result = await buildKnowledgeBase(cwd, {
    config,
    plan: {
      planning_mode: "plan",
      framework: "unknown",
      framework_signals: [],
      filesystem: { matched_paths: ["faq.html"] },
      database: { queries: [] },
      remote: { enabled: false },
    },
  });

  const compilerRequest = llm.requests.find((request) =>
    String(request?.messages?.[0]?.content || "").includes("website knowledge document compiler"),
  );
  assert.equal(result.compiled, 1);
  assert.match(compilerRequest.messages[1].content, /<name>/);
  assert.match(compilerRequest.messages[1].content, /<a href="\/dash\/buy-vip">Buy VIP<\/a>/);
  assert.match(compilerRequest.messages[1].content, /summary should be 2-3 sentences stating the document purpose and key facts/);
});

test("buildKnowledgeBase preserves Markdown formatting returned by the LLM", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-knowledge-test-"));
  const llm = await startLlmServer({ compilerBody: "## Details\n\n- First item\n- Second item" });
  context.after(async () => {
    await llm.close();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  await initializeRuntime(cwd);
  await fs.writeFile(path.join(cwd, "faq.html"), "<h1>FAQ</h1>");
  const config = defaultConfig();
  config.llm = {
    endpoint: llm.endpoint,
    api_key: "test-key",
    model: "test-model",
  };

  await buildKnowledgeBase(cwd, {
    config,
    plan: {
      planning_mode: "plan",
      framework: "unknown",
      framework_signals: [],
      filesystem: { matched_paths: ["faq.html"] },
      database: { queries: [] },
      remote: { enabled: false },
    },
  });

  const compiled = await fs.readFile(path.join(runtimePaths(cwd).knowledgeDocs, "fs-faq-html.md"), "utf8");
  assert.match(compiled, /## Details\n\n- First item\n- Second item/);
});

test("buildKnowledgeBase limits a long file to the configured compiler input size", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-knowledge-test-"));
  const llm = await startLlmServer();
  context.after(async () => {
    await llm.close();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  await initializeRuntime(cwd);
  const tail = "END-OF-LONG-KNOWLEDGE-DOCUMENT";
  await fs.writeFile(path.join(cwd, "long.md"), `${"a".repeat(50000 - tail.length)}${tail}`);
  const config = defaultConfig();
  config.llm = {
    endpoint: llm.endpoint,
    api_key: "test-key",
    model: "test-model",
  };

  await buildKnowledgeBase(cwd, {
    config,
    plan: {
      planning_mode: "plan",
      framework: "unknown",
      framework_signals: [],
      filesystem: { matched_paths: ["long.md"] },
      database: { queries: [] },
      remote: { enabled: false },
    },
  });

  const compilerRequest = llm.requests.find((request) =>
    String(request?.messages?.[0]?.content || "").includes("website knowledge document compiler"),
  );
  assert.equal(compilerRequest.max_tokens, 20000);
  assert.doesNotMatch(compilerRequest.messages[1].content, new RegExp(tail));
  assert.match(compilerRequest.messages[1].content, /\.\.\.\[truncated\]/);
});

test("buildKnowledgeBase fetches remote URLs from a scan plan", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-knowledge-test-"));
  const llm = await startLlmServer();
  const remotePage = await startRemotePageServer();
  context.after(async () => {
    await remotePage.close();
    await llm.close();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  await initializeRuntime(cwd);
  const config = defaultConfig();
  config.llm = {
    endpoint: llm.endpoint,
    api_key: "test-key",
    model: "test-model",
  };
  const plan = await prepareKnowledgeScanPlan(cwd, {
    config,
    scanPlan: { remote_urls: [remotePage.url] },
  });

  const result = await buildKnowledgeBase(cwd, {
    config,
    plan,
    selections: { filesystem: false, database: false, remote: true },
  });
  const compilerRequest = llm.requests.find((request) =>
    String(request?.messages?.[0]?.content || "").includes("website knowledge document compiler"),
  );

  assert.equal(result.source_stats.remote, 1);
  assert.match(compilerRequest.messages[1].content, /Remote FAQ/);
});

test("buildKnowledgeBase preserves remote documents when fetching fails", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-knowledge-test-"));
  const remotePage = await startRemotePageServer();
  const remoteUrl = remotePage.url;
  context.after(() => fs.rm(cwd, { recursive: true, force: true }));

  await initializeRuntime(cwd);
  const paths = runtimePaths(cwd);
  await remotePage.close();
  await Promise.all([
    fs.writeFile(path.join(paths.knowledgeDocs, "remote-example-faq.md"), "# Remote FAQ\n"),
    fs.writeFile(
      paths.knowledgeManifest,
      `${JSON.stringify({
        source_hashes: { [remoteUrl]: "remote-hash" },
        source_doc_map: { [remoteUrl]: "docs/remote-example-faq.md" },
        index_map: {
          [remoteUrl]: {
            doc_path: "docs/remote-example-faq.md",
            title: "Remote FAQ",
            summary: "Remote support information.",
            tags: ["faq"],
            updated_at: "2026-01-01T00:00:00.000Z",
            is_frequently_asked: false,
          },
        },
      }, null, 2)}\n`,
    ),
  ]);

  const result = await buildKnowledgeBase(cwd, {
    config: { scan: {} },
    plan: {
      planning_mode: "plan",
      framework: "unknown",
      framework_signals: [],
      filesystem: { matched_paths: [] },
      database: { queries: [] },
      remote: { enabled: true, sitemap_url: "", urls: [remoteUrl], max_pages: 1 },
    },
    selections: { filesystem: false, database: false, remote: true },
  });

  assert.equal(result.compiled, 0);
  assert.equal(result.changes.deleted, 0);
  assert.equal(result.changes.unchanged, 1);
  assert.match(result.warnings[0], /remote page failed/);
  assert.equal(await fs.readFile(path.join(paths.knowledgeDocs, "remote-example-faq.md"), "utf8"), "# Remote FAQ\n");
});

test("loadDocContents rejects paths outside the knowledge docs folder", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-knowledge-test-"));
  context.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const paths = runtimePaths(cwd);
  await fs.mkdir(paths.knowledgeDocs, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(paths.knowledgeDocs, "allowed.md"), "Allowed knowledge."),
    fs.writeFile(path.join(paths.base, "secret.md"), "Secret runtime data."),
  ]);

  const docs = await loadDocContents(cwd, ["docs/allowed.md", "docs/../../secret.md"]);

  assert.deepEqual(docs, [{ doc_path: "docs/allowed.md", content: "Allowed knowledge." }]);
});

test("prepareKnowledgeScanPlan previews an in-memory edited scan plan", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-knowledge-test-"));
  context.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.mkdir(path.join(cwd, "docs"));
  await fs.writeFile(path.join(cwd, "docs", "guide.md"), "# Guide");
  const scanPlan = {
    files: ["docs/**"],
  };

  const plan = await prepareKnowledgeScanPlan(cwd, {
    config: { scan: {} },
    scanPlan,
  });

  assert.deepEqual(plan.filesystem.matched_paths, ["docs/guide.md"]);
  assert.equal(plan.planning_mode, "plan");
  assert.deepEqual(plan.generated_scan_plan, scanPlan);
});

test("plain scan plans serialize file and database lines", () => {
  const raw = [
    "file://www/posts/*",
    "file://docs/**/*.md",
    "https://example.com/faq",
    "mongodb://[::1]:27017/demo::posts",
    "mongodb://[::1]:27017/demo::tags",
    "",
  ].join("\n");

  const plan = parseKnowledgeScanPlan(raw);

  assert.deepEqual(plan, {
    files: ["www/posts/*", "docs/**/*.md"],
    remote_urls: ["https://example.com/faq"],
    database: {
      connection_url: "mongodb://[::1]:27017/demo",
      tables: ["posts", "tags"],
    },
  });
  assert.equal(stringifyKnowledgeScanPlan(plan), raw);
});

test("auto database candidates use the target key directly", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-knowledge-test-"));
  context.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await fs.mkdir(path.join(cwd, "data"));
  await createSqliteDatabase(path.join(cwd, "data", "site.db"));

  const candidates = await collectAutoDatabaseCandidates(cwd, { scan: {} });
  const posts = candidates.table_candidates.find((item) => item.table_name === "posts");

  assert.equal(posts.engine, "sqlite");
  assert.equal(posts.target_key, "sqlite://data/site.db");
  assert.equal(posts.key, "sqlite://data/site.db::posts");
});

test("SQLite scan plans use connection URLs for relative and absolute paths", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-knowledge-test-"));
  context.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const absolutePath = path.join(os.tmpdir(), "openvila-external-site.db");

  const relativeTarget = resolveDatabaseTarget(cwd, {
    engine: "sqlite",
    connection_url: "sqlite://data/site.db",
  });
  const absoluteTarget = resolveDatabaseTarget(cwd, {
    engine: "sqlite",
    connection_url: `sqlite://${absolutePath}`,
  });
  const generated = generatedScanPlan(
    { matched_paths: [] },
    {
      queries: [
        {
          engine: "sqlite",
          target: relativeTarget,
          target_label: relativeTarget.label,
          table_name: "posts",
          limit: 80,
        },
      ],
    },
  );

  assert.equal(relativeTarget.db_path, path.join(cwd, "data", "site.db"));
  assert.equal(relativeTarget.connection_url, "sqlite://data/site.db");
  assert.equal(relativeTarget.key, "sqlite://data/site.db");
  assert.equal(absoluteTarget.db_path, absolutePath);
  assert.equal(absoluteTarget.connection_url, `sqlite://${absolutePath}`);
  assert.equal(resolveDatabaseTarget(cwd, { sqlite_path: "data/site.db" }), null);
  assert.deepEqual(generated.database, {
    connection_url: "sqlite://data/site.db",
    tables: ["posts"],
  });
});

test("database targets retain a connection URL and normalized key", () => {
  const target = resolveDatabaseTarget(process.cwd(), {
    engine: "mysql",
    host: "127.0.0.1",
    port: 3306,
    user: "openvila",
    password: "secret",
    database: "site",
  });

  assert.equal(target.connection_url, "mysql://openvila:secret@127.0.0.1:3306/site");
  assert.equal(target.key, "mysql://openvila@127.0.0.1:3306/site");

  const mongoTarget = resolveDatabaseTarget(process.cwd(), {
    connection_url: "mongodb://localhost:27017/girlatlas",
  });

  assert.equal(mongoTarget.key, "mongodb://localhost:27017/girlatlas");
});

test("buildKnowledgeBase keeps same-id rows from separate database targets", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-knowledge-test-"));
  const llm = await startLlmServer();
  context.after(async () => {
    await llm.close();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  const firstPath = path.join(cwd, "first.db");
  const secondPath = path.join(cwd, "second.db");
  await initializeRuntime(cwd);
  await createSqliteDatabase(firstPath);
  await createSqliteDatabase(secondPath);
  await insertSqlitePost(firstPath, "First database post");
  await insertSqlitePost(secondPath, "Second database post");

  const firstTarget = resolveDatabaseTarget(cwd, { connection_url: "sqlite://first.db" });
  const secondTarget = resolveDatabaseTarget(cwd, { connection_url: "sqlite://second.db" });
  const result = await buildKnowledgeBase(cwd, {
    config: {
      llm: {
        endpoint: llm.endpoint,
        api_key: "test-key",
        model: "test-model",
      },
      scan: {},
    },
    plan: {
      planning_mode: "plan",
      framework: "unknown",
      framework_signals: [],
      filesystem: { matched_paths: [] },
      database: {
        queries: [
          {
            table_key: "sqlite://first.db::posts",
            engine: "sqlite",
            target: firstTarget,
            table_name: "posts",
            query: "SELECT * FROM \"posts\" LIMIT 80",
            limit: 80,
          },
          {
            table_key: "sqlite://second.db::posts",
            engine: "sqlite",
            target: secondTarget,
            table_name: "posts",
            query: "SELECT * FROM \"posts\" LIMIT 80",
            limit: 80,
          },
        ],
      },
      remote: { enabled: false },
    },
    selections: { filesystem: false, database: true, remote: false },
  });

  const manifest = JSON.parse(await fs.readFile(result.paths.knowledgeManifest, "utf8"));
  assert.equal(result.scanned, 2);
  assert.equal(result.compiled, 2);
  assert.equal(Object.keys(manifest.source_doc_map).length, 2);
  assert.equal(new Set(Object.values(manifest.source_doc_map)).size, 2);
});

test("prepareKnowledgeScanPlan disables sitemap and scan-plan remote pages when skipRemote is set", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-knowledge-test-"));
  const llm = await startLlmServer();
  context.after(async () => {
    await llm.close();
    await fs.rm(cwd, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(cwd, "faq.html"), "<h1>FAQ</h1>");

  const plan = await prepareKnowledgeScanPlan(cwd, {
    config: {
      llm: {
        endpoint: llm.endpoint,
        api_key: "test-key",
        model: "test-model",
      },
      scan: {
        remote_sitemap_url: "https://example.com/sitemap.xml",
      },
    },
    scanPlan: { remote_urls: ["https://example.com/faq"] },
    skipRemote: true,
  });

  assert.equal(plan.remote.enabled, false);
  assert.equal(plan.remote.sitemap_url, "");
  assert.deepEqual(plan.remote.urls, []);
});

test("prepareKnowledgeScanPlan ignores legacy remote configuration", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-knowledge-test-"));
  const llm = await startLlmServer();
  context.after(async () => {
    await llm.close();
    await fs.rm(cwd, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(cwd, "faq.html"), "<h1>FAQ</h1>");

  const plan = await prepareKnowledgeScanPlan(cwd, {
    config: {
      llm: {
        endpoint: llm.endpoint,
        api_key: "test-key",
        model: "test-model",
      },
      scan: {
        sitemap_url: "https://example.com/legacy-sitemap.xml",
        remote: {
          sitemap_url: "https://example.com/sitemap.xml",
          max_pages: 3,
        },
      },
    },
  });

  assert.equal(plan.remote.enabled, false);
  assert.equal(plan.remote.sitemap_url, "");
  assert.equal(plan.remote.max_pages, 20);
});

test("prepareKnowledgeScanPlan uses flat remote configuration", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-knowledge-test-"));
  const llm = await startLlmServer();
  context.after(async () => {
    await llm.close();
    await fs.rm(cwd, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(cwd, "faq.html"), "<h1>FAQ</h1>");

  const plan = await prepareKnowledgeScanPlan(cwd, {
    config: {
      llm: {
        endpoint: llm.endpoint,
        api_key: "test-key",
        model: "test-model",
      },
      scan: {
        remote_sitemap_url: "https://example.com/sitemap.xml",
        remote_max_pages: 3,
      },
    },
  });

  assert.equal(plan.remote.enabled, true);
  assert.equal(plan.remote.sitemap_url, "https://example.com/sitemap.xml");
  assert.equal(plan.remote.max_pages, 3);
});

test("prepareKnowledgeScanPlan ignores legacy database query configuration", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-knowledge-test-"));
  const llm = await startLlmServer();
  context.after(async () => {
    await llm.close();
    await fs.rm(cwd, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(cwd, "faq.html"), "<h1>FAQ</h1>");

  const plan = await prepareKnowledgeScanPlan(cwd, {
    config: {
      llm: {
        endpoint: llm.endpoint,
        api_key: "test-key",
        model: "test-model",
      },
      scan: {
        database_queries: [{ sqlite_path: "data/legacy.db", query: "SELECT * FROM posts" }],
      },
    },
  });

  assert.equal("source" in plan.database, false);
  assert.equal(plan.database.queries.length, 0);
});
