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
  assert.ok(context.logs.some((line) => line.includes("LLM matched file list (1 / 2):\n  - faq.html")));
  assert.ok(context.logs.some((line) => line.includes("dry-run completed")));
});

test("runScan limits matched file paths in scan plan logs", async () => {
  const context = createContext();
  const matchedPaths = Array.from({ length: 31 }, (_, index) => `docs/page-${index + 1}.md`);
  const plan = createPlan({
    filesystem: {
      llm_assist: { model: "test-model", selected: 31 },
      knowledge_tables: [],
      total_candidates: 80,
      matched_paths: matchedPaths,
    },
  });

  await runScan(
    context,
    { options: { "dry-run": true } },
    {
      loadConfig: async () => ({ scan: {} }),
      prepareKnowledgeScanPlan: async () => plan,
    },
  );

  const scopeLog = context.logs.find((line) => line.includes("LLM matched file list"));
  assert.match(scopeLog, /docs\/page-30\.md/);
  assert.doesNotMatch(scopeLog, /docs\/page-31\.md/);
  assert.match(scopeLog, /\.\.\. 1 more files/);
});

test("runScan applies selected scan sources and reset mode", async () => {
  const context = createContext();
  const buildCalls = [];
  let planOptions = null;
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
      prepareKnowledgeScanPlan: async (cwd, options) => {
        planOptions = { cwd, options };
        return plan;
      },
      buildKnowledgeBase: async (cwd, options) => {
        buildCalls.push({ cwd, options });
        return createBuildResult();
      },
    },
  );

  assert.equal(buildCalls.length, 1);
  assert.deepEqual(planOptions, {
    cwd: "/tmp/openvila-scan-test",
    options: { config: { scan: {} }, skipDatabase: true, skipRemote: true },
  });
  assert.equal(buildCalls[0].cwd, "/tmp/openvila-scan-test");
  assert.deepEqual(buildCalls[0].options.config, { scan: {} });
  assert.equal(buildCalls[0].options.plan, plan);
  assert.deepEqual(buildCalls[0].options.selections, { filesystem: true, database: false, remote: false });
  assert.equal(buildCalls[0].options.reset, true);
  assert.equal(typeof buildCalls[0].options.log, "function");
  const analysisLog = context.logs.find((line) => line.includes("LLM Analysis Result"));
  const scopeLog = context.logs.find((line) => line.includes("Scan Scope To Confirm"));
  assert.match(analysisLog, /database source: configured/);
  assert.match(analysisLog, /database discovery:/);
  assert.match(analysisLog, /database engines:/);
  const scopeSection = scopeLog.split("[scan] 2/6 Scan Scope To Confirm\n")[1];
  assert.ok(scopeSection);
  assert.doesNotMatch(scopeSection, /database source:|database discovery:|database engines:/);
  assert.match(scopeSection, /database query list \(1\):\n  - posts \(sqlite\)/);
  assert.ok(context.logs.some((line) => line.includes("scan_mode: reset")));
});

test("runScan limits database queries in scan plan logs", async () => {
  const context = createContext();
  const queries = Array.from({ length: 31 }, (_, index) => ({ name: `query_${index + 1}`, engine: "sqlite" }));
  const plan = createPlan({
    database: {
      queries,
      source: "configured",
      auto_discovery: { by_engine: {} },
    },
  });

  await runScan(
    context,
    { options: { "dry-run": true } },
    {
      loadConfig: async () => ({ scan: {} }),
      prepareKnowledgeScanPlan: async () => plan,
    },
  );

  const scopeLog = context.logs.find((line) => line.includes("database query list"));
  assert.match(scopeLog, /query_30 \(sqlite\)/);
  assert.doesNotMatch(scopeLog, /query_31 \(sqlite\)/);
  assert.match(scopeLog, /\.\.\. 1 more queries/);
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
