import process from "node:process";
import readline from "node:readline";
import { buildKnowledgeBase, prepareKnowledgeScanPlan } from "../core/knowledge.js";
import { loadConfig } from "../core/runtime.js";
import { pick } from "../i18n/messages.js";

const SCAN_PLAN_PREVIEW_LIMIT = 30;

function askLine(rl, promptText) {
  return new Promise((resolve) => {
    rl.question(promptText, (answer) => resolve(String(answer || "").trim()));
  });
}

function isYes(answer, defaultYes = true) {
  const normalized = String(answer || "")
    .trim()
    .toLowerCase();
  if (!normalized) return defaultYes;
  return normalized === "y" || normalized === "yes";
}

function renderMatchedPaths(plan, locale) {
  const matchedPaths = plan.filesystem.matched_paths || [];
  const previewPaths = matchedPaths.slice(0, SCAN_PLAN_PREVIEW_LIMIT);
  const remaining = matchedPaths.length - previewPaths.length;
  const title = pick(
    locale,
    `- LLM命中文件列表（${matchedPaths.length} / ${plan.filesystem.total_candidates}）：`,
    `- LLM matched file list (${matchedPaths.length} / ${plan.filesystem.total_candidates}):`,
  );
  const remainingLine =
    remaining > 0
      ? pick(locale, `  ... 其余 ${remaining} 个文件`, `  ... ${remaining} more files`)
      : null;
  return [title, ...previewPaths.map((filePath) => `  ${filePath}`), remainingLine].filter(Boolean);
}

function renderDatabaseQueries(plan, locale) {
  const queries = plan.database.queries || [];
  if (queries.length === 0) {
    return [pick(locale, "- 数据库查询：none", "- database queries: none")];
  }
  const previewQueries = queries.slice(0, SCAN_PLAN_PREVIEW_LIMIT);
  const remaining = queries.length - previewQueries.length;
  const title = pick(locale, `- 数据库查询列表（${queries.length}）：`, `- database query list (${queries.length}):`);
  const remainingLine =
    remaining > 0
      ? pick(locale, `  ... 其余 ${remaining} 条查询`, `  ... ${remaining} more queries`)
      : null;
  return [
    title,
    ...previewQueries.map((item) => `  ${item.name} (${item.target_label || item.target?.label || item.engine || "db"})`),
    remainingLine,
  ].filter(Boolean);
}

function renderScanPlan(ctx, plan) {
  const llmAssist = plan.filesystem.llm_assist;
  const llmSelectedTables = (plan.filesystem.knowledge_tables || []).length;
  const dbSource = String(plan.database.source || "none");
  const dbAuto = plan.database.auto_discovery || {};

  return pick(
    ctx.locale,
    [
      "[scan] 1/6 LLM分析结果（框架识别 + 知识文件和数据表识别）",
      `- framework: ${plan.framework || "unknown"}`,
      `- 识别信号: ${(plan.framework_signals || []).join(", ") || "none"}`,
      `- LLM模型: ${llmAssist.model || "unknown"}`,
      `- LLM命中文件: ${plan.filesystem.matched_paths.length} / ${plan.filesystem.total_candidates}`,
      `- 数据库来源: ${dbSource}`,
      `- 数据库发现: db=${dbAuto.database_count ?? 0}, tables=${dbAuto.table_count ?? 0}, candidates=${dbAuto.candidate_tables ?? 0}, selected=${dbAuto.selected_tables ?? 0}`,
      `- 数据库引擎: sqlite=${dbAuto.by_engine?.sqlite ?? 0}, mysql=${dbAuto.by_engine?.mysql ?? 0}, postgresql=${dbAuto.by_engine?.postgresql ?? 0}, mongodb=${dbAuto.by_engine?.mongodb ?? 0}`,
      `- LLM命中数据表: ${llmSelectedTables}`,
      "",
      "[scan] 2/6 待确认扫描范围",
      ...renderMatchedPaths(plan, ctx.locale),
      ...renderDatabaseQueries(plan, ctx.locale),
      `- 远程 sitemap: ${plan.remote.enabled ? `${plan.remote.sitemap_url} (max=${plan.remote.max_pages})` : "disabled"}`,
    ].join("\n"),
    [
      "[scan] 1/6 LLM Analysis Result (framework + knowledge files and tables)",
      `- framework: ${plan.framework || "unknown"}`,
      `- signals: ${(plan.framework_signals || []).join(", ") || "none"}`,
      `- LLM model: ${llmAssist.model || "unknown"}`,
      `- LLM-selected knowledge files: ${plan.filesystem.matched_paths.length} from ${plan.filesystem.total_candidates}`,
      `- database source: ${dbSource}`,
      `- database discovery: db=${dbAuto.database_count ?? 0}, tables=${dbAuto.table_count ?? 0}, candidates=${dbAuto.candidate_tables ?? 0}, selected=${dbAuto.selected_tables ?? 0}`,
      `- database engines: sqlite=${dbAuto.by_engine?.sqlite ?? 0}, mysql=${dbAuto.by_engine?.mysql ?? 0}, postgresql=${dbAuto.by_engine?.postgresql ?? 0}, mongodb=${dbAuto.by_engine?.mongodb ?? 0}`,
      `- LLM-selected knowledge tables: ${llmSelectedTables}`,
      "",
      "[scan] 2/6 Scan Scope To Confirm",
      ...renderMatchedPaths(plan, ctx.locale),
      ...renderDatabaseQueries(plan, ctx.locale),
      `- remote sitemap: ${plan.remote.enabled ? `${plan.remote.sitemap_url} (max=${plan.remote.max_pages})` : "disabled"}`,
    ].join("\n"),
  );
}

async function confirmSelections(ctx, plan, defaults) {
  if (typeof ctx.ask === "function") {
    const proceed = isYes(
      await ctx.ask(
        pick(
          ctx.locale,
          "确认该扫描计划并继续？[Y/n]",
          "Confirm this scan plan and continue? [Y/n]",
        ),
      ),
      true,
    );
    if (!proceed) {
      return null;
    }
    return { ...defaults };
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    ctx.log(
      pick(
        ctx.locale,
        "非交互终端，使用默认扫描范围。可加 --dry-run 仅查看计划。",
        "Non-interactive terminal; using default scan selections. Use --dry-run to preview plan only.",
      ),
    );
    return defaults;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const proceed = isYes(
      await askLine(
        rl,
        pick(
          ctx.locale,
          "确认该扫描计划并继续？[Y/n] ",
          "Confirm this scan plan and continue? [Y/n] ",
        ),
      ),
      true,
    );
    if (!proceed) {
      return null;
    }
    return { ...defaults };
  } finally {
    rl.close();
  }
}

export async function runScan(ctx, argv, dependencies = {}) {
  const log = (line) => ctx.log(String(line ?? ""));
  const loadRuntimeConfig = dependencies.loadConfig || loadConfig;
  const prepareScanPlan = dependencies.prepareKnowledgeScanPlan || prepareKnowledgeScanPlan;
  const buildKnowledge = dependencies.buildKnowledgeBase || buildKnowledgeBase;

  try {
    const dryRun = Boolean(argv.options["dry-run"]);
    const assumeYes = Boolean(argv.options.yes);
    const reset = Boolean(argv.options.reset);
    const skipDatabase = Boolean(argv.options["no-db"]);
    const skipRemote = Boolean(argv.options["no-remote"]);
    const config = await loadRuntimeConfig(ctx.cwd, { createIfMissing: false });

    if (typeof ctx.logFilePath === "string" && ctx.logFilePath) {
      log(pick(ctx.locale, `[scan] 日志文件: ${ctx.logFilePath}`, `[scan] Log file: ${ctx.logFilePath}`));
    }

    log(
      pick(
        ctx.locale,
        "[scan] 1/6 生成扫描计划中...",
        "[scan] 1/6 Building scan plan...",
      ),
    );
    const plan = await prepareScanPlan(ctx.cwd, { config, skipDatabase, skipRemote });
    log(renderScanPlan(ctx, plan));

    if (dryRun) {
      log(pick(ctx.locale, "[scan] dry-run完成，未写入知识库文件。", "[scan] dry-run completed. No knowledge files were written."));
      return;
    }

    const defaults = {
      filesystem: !Boolean(argv.options["no-filesystem"]),
      database: plan.database.queries.length > 0 && !skipDatabase,
      remote: plan.remote.enabled && !skipRemote,
    };

    const selections = assumeYes ? defaults : await confirmSelections(ctx, plan, defaults);
    if (!selections) {
      log(pick(ctx.locale, "[scan] 已取消。", "[scan] Cancelled."));
      return;
    }

    if (!selections.filesystem && !selections.database && !selections.remote) {
      log(pick(ctx.locale, "[scan] 未选择任何扫描源，已取消。", "[scan] No scan source selected; cancelled."));
      return;
    }

    log(
      pick(
        ctx.locale,
        `[scan] 3/6 开始扫描（filesystem=${selections.filesystem}, db=${selections.database}, remote=${selections.remote}）`,
        `[scan] 3/6 Start scanning (filesystem=${selections.filesystem}, db=${selections.database}, remote=${selections.remote})`,
      ),
    );

    const result = await buildKnowledge(ctx.cwd, {
      config,
      plan,
      selections,
      reset,
      log: (line) => log(`[scan] ${line}`),
    });

    log(
      pick(
        ctx.locale,
        [
          "[scan] 3/6-5/6 已执行：扫描 → 文档编译 → 更新索引",
          "[scan] 6/6 汇总",
          `- framework: ${result.framework || "unknown"}`,
          `- 扫描文档数: ${result.scanned}`,
          `- 编译文档数: ${result.compiled}`,
          `- scan_mode: ${reset ? "reset" : "incremental"}`,
          `- changes: added=${result.changes?.added ?? 0}, changed=${result.changes?.changed ?? 0}, deleted=${result.changes?.deleted ?? 0}, unchanged=${result.changes?.unchanged ?? 0}`,
          `- frequent_docs: ${result.changes?.frequent_doc_count ?? 0}`,
          `- source_stats: fs=${result.source_stats.filesystem}, db=${result.source_stats.database}, remote=${result.source_stats.remote}`,
          `- llm_calls: planning=${result.llm_calls?.file_planning ?? 0}, doc_compile_batches=${result.llm_calls?.doc_compile_batches ?? 0}, total=${result.llm_calls?.total ?? 0}`,
          `- index: ${result.paths.knowledgeIndex}`,
          `- manifest: ${result.paths.knowledgeManifest}`,
        ].join("\n"),
        [
          "[scan] 3/6-5/6 Completed: scan -> doc compile -> index update",
          "[scan] 6/6 Summary",
          `- framework: ${result.framework || "unknown"}`,
          `- scanned docs: ${result.scanned}`,
          `- compiled docs: ${result.compiled}`,
          `- scan_mode: ${reset ? "reset" : "incremental"}`,
          `- changes: added=${result.changes?.added ?? 0}, changed=${result.changes?.changed ?? 0}, deleted=${result.changes?.deleted ?? 0}, unchanged=${result.changes?.unchanged ?? 0}`,
          `- frequent_docs: ${result.changes?.frequent_doc_count ?? 0}`,
          `- source_stats: fs=${result.source_stats.filesystem}, db=${result.source_stats.database}, remote=${result.source_stats.remote}`,
          `- llm_calls: planning=${result.llm_calls?.file_planning ?? 0}, doc_compile_batches=${result.llm_calls?.doc_compile_batches ?? 0}, total=${result.llm_calls?.total ?? 0}`,
          `- index: ${result.paths.knowledgeIndex}`,
          `- manifest: ${result.paths.knowledgeManifest}`,
        ].join("\n"),
      ),
    );
  } catch (error) {
    log(pick(ctx.locale, `[scan] 执行失败: ${error.message}`, `[scan] Failed: ${error.message}`));
    throw error;
  }
}
