import assert from "node:assert/strict";
import crypto from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sqlite3 from "sqlite3";
import { buildKnowledgeBase, prepareKnowledgeScanPlan, saveKnowledgeScanPlan } from "../../src/core/knowledge.js";
import { defaultConfig } from "../../src/core/runtime.js";
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

async function startLlmServer() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    requests.push(await readRequestBody(request));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                framework: "static",
                framework_signals: ["faq.html"],
                knowledge_files: ["faq.html", "guide.md", "app.ts", "visible.draft.md"],
                knowledge_tables: [],
              }),
            },
          },
        ],
      }),
    );
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

test("default scan config has no db_auto toggle", () => {
  assert.equal("db_auto" in defaultConfig().scan, false);
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
      scan: {},
    },
  });

  const prompt = llm.requests[0].messages[1].content;
  const candidates = prompt.split("Candidates:\n")[1].split("\n\nCandidate table count:")[0];
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
});

test("buildKnowledgeBase records no planning call when reusing an unchanged scan plan", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-knowledge-test-"));
  context.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const content = "<h1>FAQ</h1>";
  const sourceHash = crypto.createHash("sha1").update(`filesystem\nfaq.html\n${content}`).digest("hex");
  const knowledges = path.join(cwd, ".openvila", "knowledges");

  await fs.mkdir(path.join(knowledges, "docs"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(cwd, "faq.html"), content),
    fs.writeFile(path.join(cwd, ".openvila", "config.yaml"), "language: en\n"),
    fs.writeFile(path.join(knowledges, "docs", "fs-faq-html.md"), "# FAQ\n"),
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
    doc_compile_batch_chars: 100000,
  });
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
    "mongodb://[::1]:27017/demo::posts",
    "mongodb://[::1]:27017/demo::tags",
    "",
  ].join("\n");

  const plan = parseKnowledgeScanPlan(raw);

  assert.deepEqual(plan, {
    files: ["www/posts/*", "docs/**/*.md"],
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

test("prepareKnowledgeScanPlan disables the sitemap plan when skipRemote is set", async (context) => {
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
        sitemap_url: "https://example.com/sitemap.xml",
      },
    },
    skipRemote: true,
  });

  assert.equal(plan.remote.enabled, false);
  assert.equal(plan.remote.sitemap_url, "");
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
