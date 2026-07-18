import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareKnowledgeScanPlan, saveKnowledgeScanPlan } from "../../src/core/knowledge.js";

async function readRequestBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
  }
  return body ? JSON.parse(body) : {};
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
      scan: {
        db_auto: false,
      },
    },
  });

  const prompt = llm.requests[0].messages[1].content;
  const candidates = prompt.split("Candidates:\n")[1].split("\n\nCandidate table count:")[0];
  assert.equal(plan.filesystem.total_candidates, 4);
  assert.match(candidates, /faq\.html/);
  assert.match(candidates, /guide\.md/);
  assert.match(candidates, /app\.ts/);
  assert.match(candidates, /visible\.draft\.md/);
  assert.doesNotMatch(
    candidates,
    /site\.css|theme\.scss|hero\.jpg|intro\.mp4|private\.md|notes\.draft\.md|ignored\/private\.md/,
  );
  assert.deepEqual(plan.generated_scan_plan, {
    version: 1,
    files: ["faq.html", "guide.md", "app.ts", "visible.draft.md"],
  });
  const scanPlanPath = await saveKnowledgeScanPlan(cwd, plan);
  assert.match(await fs.readFile(scanPlanPath, "utf8"), /files:\n  - faq\.html/);
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
      path.join(cwd, ".openvila", "scan-plan.yaml"),
      [
        "version: 1",
        "files:",
        "  - www/posts/*",
        "  - docs/**/*.md",
        "database:",
        "  engine: sqlite",
        "  sqlite_path: data/site.db",
        "  tables:",
        "    - posts",
        "  limit: 12",
        "",
      ].join("\n"),
    ),
    fs.writeFile(path.join(cwd, "www", "posts", "first.html"), "<h1>First</h1>"),
    fs.writeFile(path.join(cwd, "www", "posts", "second.md"), "# Second"),
    fs.writeFile(path.join(cwd, "docs", "guide.md"), "# Guide"),
  ]);

  const plan = await prepareKnowledgeScanPlan(cwd, { config: { scan: {} } });

  assert.equal(plan.filesystem.llm_assist.used, false);
  assert.deepEqual(plan.filesystem.matched_paths, ["docs/guide.md", "www/posts/first.html", "www/posts/second.md"]);
  assert.equal(plan.database.queries[0].table_name, "posts");
  assert.equal(plan.database.queries[0].limit, 12);
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
        db_auto: false,
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
        db_auto: false,
        database_queries: [{ sqlite_path: "data/legacy.db", query: "SELECT * FROM posts" }],
      },
    },
  });

  assert.equal("source" in plan.database, false);
  assert.equal(plan.database.queries.length, 0);
});
