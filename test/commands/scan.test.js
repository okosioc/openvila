import assert from "node:assert/strict";
import test from "node:test";
import { runScan } from "../../src/commands/scan.js";

function createContext(options = {}) {
  const logs = [];
  return {
    cwd: "/tmp/openvila-scan-test",
    locale: "en",
    log: (message) => logs.push(String(message)),
    logs,
    ...options,
  };
}

function createPlan(options = {}) {
  return {
    framework: "static",
    framework_signals: ["index.html"],
    filesystem: {
      llm_assist: { model: "test-model", selected: 1 },
      knowledge_tables: [],
      total_candidates: 2,
      matched_paths: ["faq.html"],
    },
    database: {
      queries: [],
      source: "none",
      auto_discovery: { by_engine: {} },
    },
    remote: {
      enabled: false,
      sitemap_url: "",
      max_pages: 0,
    },
    ...options,
  };
}

function createBuildResult() {
  return {
    framework: "static",
    scanned: 2,
    compiled: 2,
    changes: {
      added: 1,
      changed: 1,
      deleted: 0,
      unchanged: 0,
      frequent_doc_count: 1,
    },
    source_stats: {
      filesystem: 2,
      database: 0,
      remote: 0,
    },
    llm_calls: {
      file_planning: 1,
      doc_compile_batches: 1,
      total: 2,
    },
    paths: {
      knowledgeIndex: "/tmp/openvila-scan-test/.openvila/knowledges/index.md",
      knowledgeManifest: "/tmp/openvila-scan-test/.openvila/knowledges/manifest.json",
    },
  };
}

test("runScan previews a plan without writing knowledge files in dry-run mode", async () => {
  const context = createContext();
  let buildCalled = false;

  await runScan(
    context,
    { options: { "dry-run": true } },
    {
      loadConfig: async () => ({ scan: {} }),
      prepareKnowledgeScanPlan: async () => createPlan(),
      buildKnowledgeBase: async () => {
        buildCalled = true;
      },
    },
  );

  assert.equal(buildCalled, false);
  assert.ok(context.logs.some((line) => line.includes("Scan Scope To Confirm")));
  assert.ok(context.logs.some((line) => line.includes("dry-run completed")));
});

test("runScan applies selected scan sources and reset mode", async () => {
  const context = createContext();
  const buildCalls = [];
  const plan = createPlan({
    database: {
      queries: [{ name: "posts", engine: "sqlite" }],
      source: "configured",
      auto_discovery: { by_engine: { sqlite: 1 } },
    },
    remote: {
      enabled: true,
      sitemap_url: "https://example.com/sitemap.xml",
      max_pages: 20,
    },
  });

  await runScan(
    context,
    { options: { yes: true, reset: true, "no-db": true, "no-remote": true } },
    {
      loadConfig: async () => ({ scan: {} }),
      prepareKnowledgeScanPlan: async () => plan,
      buildKnowledgeBase: async (cwd, options) => {
        buildCalls.push({ cwd, options });
        return createBuildResult();
      },
    },
  );

  assert.equal(buildCalls.length, 1);
  assert.equal(buildCalls[0].cwd, "/tmp/openvila-scan-test");
  assert.deepEqual(buildCalls[0].options.config, { scan: {} });
  assert.equal(buildCalls[0].options.plan, plan);
  assert.deepEqual(buildCalls[0].options.selections, { filesystem: true, database: false, remote: false });
  assert.equal(buildCalls[0].options.reset, true);
  assert.equal(typeof buildCalls[0].options.log, "function");
  assert.ok(context.logs.some((line) => line.includes("scan_mode: reset")));
});

test("runScan stops when the owner declines the scan plan", async () => {
  const context = createContext({ ask: async () => "n" });
  let buildCalled = false;

  await runScan(
    context,
    { options: {} },
    {
      loadConfig: async () => ({ scan: {} }),
      prepareKnowledgeScanPlan: async () => createPlan(),
      buildKnowledgeBase: async () => {
        buildCalled = true;
      },
    },
  );

  assert.equal(buildCalled, false);
  assert.ok(context.logs.some((line) => line.includes("Cancelled.")));
});
