import process from "node:process";
import readline from "node:readline";
import { buildKnowledgeBase, prepareKnowledgeScanPlan, saveKnowledgeScanPlan } from "../core/knowledge.js";
import { loadConfig } from "../core/runtime.js";
import { parseKnowledgeScanPlan, stringifyKnowledgeScanPlan } from "../core/scan-plan.js";
import { pick } from "../i18n/messages.js";
import { editTextInEditor } from "../utils/editor.js";

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
    `- 文件列表（${matchedPaths.length} / ${plan.filesystem.total_candidates}）：`,
    `- file list (${matchedPaths.length} / ${plan.filesystem.total_candidates}):`,
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
    return [pick(locale, "- 数据表：none", "- database tables: none")];
  }
  const previewQueries = queries.slice(0, SCAN_PLAN_PREVIEW_LIMIT);
  const remaining = queries.length - previewQueries.length;
  const title = pick(locale, `- 数据表 key 列表（${queries.length}）：`, `- database table keys (${queries.length}):`);
  const remainingLine =
    remaining > 0
      ? pick(locale, `  ... 其余 ${remaining} 个数据表`, `  ... ${remaining} more tables`)
      : null;
  return [
    title,
    ...previewQueries.map((item) => `  ${item.target.key}::${item.table_name}`),
    remainingLine,
  ].filter(Boolean);
}

function renderScanPlan(ctx, plan) {
  const planningMode = plan.planning_mode === "plan" ? "plan" : "auto";
  const editedDraft = planningMode === "plan" && Boolean(plan.generated_scan_plan);
  const selectedTableKeys = plan.database.selected_table_keys || [];
  const databaseDiscovery = plan.database.discovery || {};
  const framework = plan.framework || "unknown";
  const frameworkSignals = (plan.framework_signals || []).join(", ") || "none";
  const analysisHeading = pick(
    ctx.locale,
    planningMode === "auto"
      ? `[scan] 1/6 LLM分析结果（框架: ${framework}；识别信号: ${frameworkSignals}）`
      : editedDraft
        ? "[scan] 1/6 Scan Plan（编辑后的草稿范围）"
        : "[scan] 1/6 Scan Plan（读取已确认的扫描范围）",
    planningMode === "auto"
      ? `[scan] 1/6 LLM Analysis Result (framework: ${framework}; signals: ${frameworkSignals})`
      : editedDraft
        ? "[scan] 1/6 Scan Plan (edited draft scope)"
        : "[scan] 1/6 Scan Plan (using confirmed scan scope)",
  );

  return pick(
    ctx.locale,
    [
      analysisHeading,
      `- 规划模式: ${planningMode}`,
      `- 文件选择: ${plan.filesystem.matched_paths.length} / ${plan.filesystem.total_candidates}`,
      `- 数据表选择: ${selectedTableKeys.length} / ${databaseDiscovery.candidate_tables ?? 0}`,
      "",
      "[scan] 2/6 待确认扫描范围",
      ...renderMatchedPaths(plan, ctx.locale),
      ...renderDatabaseQueries(plan, ctx.locale),
      `- 远程 sitemap: ${plan.remote.enabled ? `${plan.remote.sitemap_url} (max=${plan.remote.max_pages})` : "disabled"}`,
    ].join("\n"),
    [
      analysisHeading,
      `- planning mode: ${planningMode}`,
      `- selected knowledge files: ${plan.filesystem.matched_paths.length} from ${plan.filesystem.total_candidates}`,
      `- selected database tables: ${selectedTableKeys.length} / ${databaseDiscovery.candidate_tables ?? 0}`,
      "",
      "[scan] 2/6 Scan Scope To Confirm",
      ...renderMatchedPaths(plan, ctx.locale),
      ...renderDatabaseQueries(plan, ctx.locale),
      `- remote sitemap: ${plan.remote.enabled ? `${plan.remote.sitemap_url} (max=${plan.remote.max_pages})` : "disabled"}`,
    ].join("\n"),
  );
}

async function confirmSelections(ctx, plan, defaults) {
  const allowEdit = Boolean(plan.generated_scan_plan);
  const promptText = pick(
    ctx.locale,
    allowEdit ? "确认该扫描计划并继续？[Y/e/n]（e=编辑计划）" : "确认该扫描计划并继续？[Y/n]",
    allowEdit ? "Confirm this scan plan and continue? [Y/e/n] (e=edit plan)" : "Confirm this scan plan and continue? [Y/n]",
  );
  const selectionFromAnswer = (answer) => {
    const normalized = String(answer || "")
      .trim()
      .toLowerCase();
    if (allowEdit && (normalized === "e" || normalized === "edit")) {
      return { edit: true };
    }
    return isYes(normalized, true) ? { ...defaults } : null;
  };

  if (typeof ctx.ask === "function") {
    return selectionFromAnswer(await ctx.ask(promptText));
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
    return selectionFromAnswer(await askLine(rl, `${promptText} `));
  } finally {
    rl.close();
  }
}

async function editGeneratedScanPlan(ctx, plan, config, options, prepareScanPlan, editPlanText) {
  const generatedPlan = plan.generated_scan_plan;
  if (!generatedPlan) {
    throw new Error("Scan plan is not available for editing");
  }

  ctx.log(pick(ctx.locale, "[scan] 正在打开编辑器修改 scan plan...", "[scan] Opening editor for scan plan..."));
  const editedText = await editPlanText(stringifyKnowledgeScanPlan(generatedPlan));
  const editedPlan = parseKnowledgeScanPlan(editedText);
  const refreshedPlan = await prepareScanPlan(ctx.cwd, {
    config,
    skipDatabase: options.skipDatabase,
    skipRemote: options.skipRemote,
    resetPlan: false,
    scanPlan: editedPlan,
  });

  ctx.log(pick(ctx.locale, "[scan] 已重新生成编辑后的扫描范围，请再次确认。", "[scan] Edited scan scope regenerated. Please confirm it again."));
  return refreshedPlan;
}

export async function runScan(ctx, argv, dependencies = {}) {
  const log = (line) => ctx.log(String(line ?? ""));
  const loadRuntimeConfig = dependencies.loadConfig || loadConfig;
  const prepareScanPlan = dependencies.prepareKnowledgeScanPlan || prepareKnowledgeScanPlan;
  const buildKnowledge = dependencies.buildKnowledgeBase || buildKnowledgeBase;
  const saveScanPlan = dependencies.saveKnowledgeScanPlan || saveKnowledgeScanPlan;
  const editPlanText = dependencies.editScanPlanText || ctx.editScanPlanText || editTextInEditor;

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
    let plan = await prepareScanPlan(ctx.cwd, { config, skipDatabase, skipRemote, resetPlan: reset });

    if (dryRun) {
      log(renderScanPlan(ctx, plan));
      log(pick(ctx.locale, "[scan] dry-run完成，未写入知识库文件。", "[scan] dry-run completed. No knowledge files were written."));
      return;
    }

    let selections = null;
    let cancelled = false;
    while (!selections && !cancelled) {
      log(renderScanPlan(ctx, plan));
      const defaults = {
        filesystem: !Boolean(argv.options["no-filesystem"]),
        database: plan.database.queries.length > 0 && !skipDatabase,
        remote: plan.remote.enabled && !skipRemote,
      };
      const confirmed = assumeYes ? defaults : await confirmSelections(ctx, plan, defaults);
      if (!confirmed) {
        cancelled = true;
      } else if (confirmed.edit) {
        plan = await editGeneratedScanPlan(ctx, plan, config, { skipDatabase, skipRemote }, prepareScanPlan, editPlanText);
      } else {
        selections = confirmed;
      }
    }

    if (cancelled) {
      log(pick(ctx.locale, "[scan] 已取消。", "[scan] Cancelled."));
      return;
    }

    if (!selections.filesystem && !selections.database && !selections.remote) {
      log(pick(ctx.locale, "[scan] 未选择任何扫描源，已取消。", "[scan] No scan source selected; cancelled."));
      return;
    }

    const scanPlanPath = await saveScanPlan(ctx.cwd, plan);
    if (scanPlanPath) {
      log(pick(ctx.locale, `[scan] 扫描计划已写入: ${scanPlanPath}`, `[scan] Scan plan written: ${scanPlanPath}`));
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
          `- 扫描文档数: ${result.scanned}`,
          `- 编译文档数: ${result.compiled}`,
          `- 扫描模式: ${reset ? "重建" : "增量"}`,
          `- 变更: 新增=${result.changes?.added ?? 0}, 修改=${result.changes?.changed ?? 0}, 删除=${result.changes?.deleted ?? 0}, 未变=${result.changes?.unchanged ?? 0}`,
          `- 高频文档数: ${result.changes?.frequent_doc_count ?? 0}`,
          `- 来源统计: 文件=${result.source_stats.filesystem}, 数据库=${result.source_stats.database}, 远程=${result.source_stats.remote}`,
          `- LLM 调用: 规划=${result.llm_calls?.file_planning ?? 0}, 文档编译批次=${result.llm_calls?.doc_compile_batches ?? 0}, 合计=${result.llm_calls?.total ?? 0}`,
          `- 索引: ${result.paths.knowledgeIndex}`,
          `- 清单: ${result.paths.knowledgeManifest}`,
        ].join("\n"),
        [
          "[scan] 3/6-5/6 Completed: scan -> doc compile -> index update",
          "[scan] 6/6 Summary",
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
    throw error;
  }
}
