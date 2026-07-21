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
    planning_mode: "auto",
    framework: "static",
    framework_signals: ["index.html"],
    llm_model: "test-model",
    filesystem: {
      total_candidates: 2,
      matched_paths: ["faq.html"],
    },
    database: {
      queries: [],
      selected_table_keys: [],
      discovery: { by_engine: {} },
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
  let saveCalled = false;
  const plan = createPlan({ generated_scan_plan: { files: ["faq.html"] } });

  await runScan(
    context,
    { options: { "dry-run": true } },
    {
      loadConfig: async () => ({ scan: {} }),
      prepareKnowledgeScanPlan: async () => plan,
      buildKnowledgeBase: async () => {
        buildCalled = true;
      },
      saveKnowledgeScanPlan: async () => {
        saveCalled = true;
      },
    },
  );

  assert.equal(buildCalled, false);
  assert.equal(saveCalled, false);
  assert.ok(context.logs.some((line) => line.includes("LLM Analysis Result (framework: static; signals: index.html)")));
  assert.ok(context.logs.some((line) => line.includes("Scan Scope To Confirm")));
  assert.ok(context.logs.some((line) => line.includes("file list (1 / 2):\n  faq.html")));
  assert.ok(context.logs.some((line) => line.includes("dry-run completed")));
});

test("runScan hides framework details when reusing a scan plan", async () => {
  const context = createContext();
  const plan = createPlan({
    planning_mode: "plan",
    framework: "unknown",
    framework_signals: [],
    llm_model: "",
  });

  await runScan(
    context,
    { options: { "dry-run": true } },
    {
      loadConfig: async () => ({ scan: {} }),
      prepareKnowledgeScanPlan: async () => plan,
    },
  );

  const scanLog = context.logs.find((line) => line.includes("Scan Plan (using confirmed scan scope)"));
  assert.match(scanLog, /planning mode: plan/);
  assert.doesNotMatch(scanLog, /framework:|signals:/);
});

test("runScan limits matched file paths in scan plan logs", async () => {
  const context = createContext();
  const matchedPaths = Array.from({ length: 31 }, (_, index) => `docs/page-${index + 1}.md`);
  const plan = createPlan({
    filesystem: {
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

  const scopeLog = context.logs.find((line) => line.includes("file list"));
  assert.match(scopeLog, /docs\/page-30\.md/);
  assert.doesNotMatch(scopeLog, /docs\/page-31\.md/);
  assert.match(scopeLog, /\.\.\. 1 more files/);
});

test("runScan applies selected scan sources and reset mode", async () => {
  const context = createContext();
  const buildCalls = [];
  let planOptions = null;
  let savedPlan = null;
  const plan = createPlan({
    generated_scan_plan: { files: ["faq.html"] },
    database: {
      queries: [{ target: { key: "sqlite://data/site.db" }, table_name: "posts" }],
      selected_table_keys: ["sqlite://data/site.db::posts"],
      discovery: { by_engine: { sqlite: 1 } },
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
      saveKnowledgeScanPlan: async (cwd, scanPlan) => {
        savedPlan = { cwd, scanPlan };
        return "/tmp/openvila-scan-test/.openvila/scan-plan";
      },
    },
  );

  assert.equal(buildCalls.length, 1);
  assert.deepEqual(planOptions, {
    cwd: "/tmp/openvila-scan-test",
    options: { config: { scan: {} }, skipDatabase: true, skipRemote: true, resetPlan: true },
  });
  assert.deepEqual(savedPlan, { cwd: "/tmp/openvila-scan-test", scanPlan: plan });
  assert.equal(buildCalls[0].cwd, "/tmp/openvila-scan-test");
  assert.deepEqual(buildCalls[0].options.config, { scan: {} });
  assert.equal(buildCalls[0].options.plan, plan);
  assert.deepEqual(buildCalls[0].options.selections, { filesystem: true, database: false, remote: false });
  assert.equal(buildCalls[0].options.reset, true);
  assert.equal(typeof buildCalls[0].options.log, "function");
  const analysisLog = context.logs.find((line) => line.includes("LLM Analysis Result"));
  const scopeLog = context.logs.find((line) => line.includes("Scan Scope To Confirm"));
  const scopeSection = scopeLog.split("[scan] 2/6 Scan Scope To Confirm\n")[1];
  assert.ok(scopeSection);
  assert.match(scopeSection, /database table keys \(1\):\n  sqlite:\/\/data\/site\.db::posts/);
  const summaryLog = context.logs.find((line) => line.includes("[scan] 6/6 Summary"));
  assert.doesNotMatch(summaryLog, /framework:/);
  assert.ok(context.logs.some((line) => line.includes("scan_mode: reset")));
});

test("runScan lets the owner edit a generated scan plan before confirming", async () => {
  const answers = ["e", "y"];
  const context = createContext({ ask: async () => answers.shift() });
  const initialPlan = createPlan({
    generated_scan_plan: { files: ["faq.html"] },
  });
  const editedPlan = createPlan({
    planning_mode: "plan",
    framework: "scan-plan",
    llm_model: "",
    filesystem: {
      total_candidates: 2,
      matched_paths: ["docs/guide.md"],
    },
  });
  const prepareCalls = [];
  let savedPlan = null;
  let buildPlan = null;

  await runScan(
    context,
    { options: {} },
    {
      loadConfig: async () => ({ scan: {} }),
      prepareKnowledgeScanPlan: async (cwd, options) => {
        prepareCalls.push({ cwd, options });
        if (options.scanPlan) {
          return { ...editedPlan, generated_scan_plan: options.scanPlan };
        }
        return initialPlan;
      },
      editScanPlanText: async (text) => {
        assert.match(text, /^file:\/\/faq\.html\n$/);
        return "file://docs/**\n";
      },
      saveKnowledgeScanPlan: async (cwd, plan) => {
        savedPlan = { cwd, plan };
        return "/tmp/openvila-scan-test/.openvila/scan-plan";
      },
      buildKnowledgeBase: async (cwd, options) => {
        buildPlan = { cwd, plan: options.plan };
        return createBuildResult();
      },
    },
  );

  assert.equal(prepareCalls.length, 2);
  assert.deepEqual(prepareCalls[1].options.scanPlan, { files: ["docs/**"] });
  assert.equal(prepareCalls[1].options.resetPlan, false);
  assert.deepEqual(savedPlan.plan.generated_scan_plan, { files: ["docs/**"] });
  assert.equal(buildPlan.plan, savedPlan.plan);
  assert.ok(context.logs.some((line) => line.includes("Opening editor for scan plan")));
  assert.ok(context.logs.some((line) => line.includes("Edited scan scope regenerated")));
  assert.equal(context.logs.filter((line) => line.includes("Scan Scope To Confirm")).length, 2);
});

test("runScan lets the owner edit a reused scan plan before confirming", async () => {
  const answers = ["e", "y"];
  const prompts = [];
  const context = createContext({
    ask: async (prompt) => {
      prompts.push(prompt);
      return answers.shift();
    },
  });
  const existingPlan = createPlan({
    planning_mode: "plan",
    framework: "unknown",
    framework_signals: [],
    llm_model: "",
    confirmed_scan_plan: { files: ["faq.html"] },
  });
  const editedPlan = createPlan({
    planning_mode: "plan",
    framework: "unknown",
    framework_signals: [],
    llm_model: "",
    filesystem: {
      total_candidates: 2,
      matched_paths: ["docs/guide.md"],
    },
  });
  const prepareCalls = [];
  let savedPlan = null;

  await runScan(
    context,
    { options: {} },
    {
      loadConfig: async () => ({ scan: {} }),
      prepareKnowledgeScanPlan: async (cwd, options) => {
        prepareCalls.push({ cwd, options });
        if (options.scanPlan) {
          return {
            ...editedPlan,
            confirmed_scan_plan: options.scanPlan,
            generated_scan_plan: options.scanPlan,
          };
        }
        return existingPlan;
      },
      editScanPlanText: async (text) => {
        assert.match(text, /^file:\/\/faq\.html\n$/);
        return "file://docs/**\n";
      },
      saveKnowledgeScanPlan: async (cwd, plan) => {
        savedPlan = { cwd, plan };
        return "/tmp/openvila-scan-test/.openvila/scan-plan";
      },
      buildKnowledgeBase: async () => createBuildResult(),
    },
  );

  assert.match(prompts[0], /e=edit plan/);
  assert.equal(prepareCalls.length, 2);
  assert.deepEqual(prepareCalls[1].options.scanPlan, { files: ["docs/**"] });
  assert.deepEqual(savedPlan.plan.generated_scan_plan, { files: ["docs/**"] });
  assert.equal(context.logs.filter((line) => line.includes("Scan Scope To Confirm")).length, 2);
});

test("runScan limits database queries in scan plan logs", async () => {
  const context = createContext();
  const queries = Array.from({ length: 31 }, (_, index) => ({
    target: { key: "sqlite://data/site.db" },
    table_name: `query_${index + 1}`,
  }));
  const plan = createPlan({
    database: {
      queries,
      selected_table_keys: [],
      discovery: { by_engine: {} },
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

  const scopeLog = context.logs.find((line) => line.includes("database table keys"));
  assert.match(scopeLog, /sqlite:\/\/data\/site\.db::query_30/);
  assert.doesNotMatch(scopeLog, /sqlite:\/\/data\/site\.db::query_31/);
  assert.match(scopeLog, /\.\.\. 1 more tables/);
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

test("runScan propagates failures without logging them twice", async () => {
  const context = createContext();

  await assert.rejects(
    runScan(
      context,
      { options: {} },
      {
        loadConfig: async () => ({ scan: {} }),
        prepareKnowledgeScanPlan: async () => {
          throw new Error("planning failed");
        },
      },
    ),
    /planning failed/,
  );

  assert.equal(context.logs.filter((line) => line.includes("Failed:")).length, 0);
});
