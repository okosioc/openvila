import process from "node:process";
import readline from "node:readline";
import { buildKnowledgeBase, prepareKnowledgeScanPlan } from "../core/knowledge.js";
import { loadConfig } from "../core/runtime.js";
import { pick } from "../i18n/messages.js";

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

function renderScanPlan(ctx, plan) {
  const llmAssist = plan.filesystem.llm_assist;
  const llmSelectedTables = (plan.filesystem.knowledge_tables || []).length;
  const dbQueries = plan.database.queries.map((item) => `${item.name} (${item.sqlite_path})`).slice(0, 6);
  const dbSource = String(plan.database.source || "none");
  const dbAuto = plan.database.auto_discovery || {};

  return pick(
    ctx.locale,
    [
      "[scan] 1/6-2/6 LLM分析结果（框架识别 + 知识文件识别）",
      `- framework: ${plan.framework || "unknown"}`,
      `- 识别信号: ${(plan.framework_signals || []).join(", ") || "none"}`,
      `- LLM模型: ${llmAssist.model || "unknown"}`,
      `- LLM选择知识文件数: ${llmAssist.selected || plan.filesystem.matched_paths.length}`,
      `- LLM选择知识表数: ${llmSelectedTables}`,
      "",
      "[scan] 3/6 待确认扫描范围",
      `- 文件候选数: ${plan.filesystem.total_candidates}, 命中数: ${plan.filesystem.matched_paths.length}`,
      `- 数据库来源: ${dbSource}`,
      `- 数据库 queries: ${dbQueries.length > 0 ? dbQueries.join(", ") : "none"}`,
      `- 数据库发现: db=${dbAuto.database_count ?? 0}, tables=${dbAuto.table_count ?? 0}, candidates=${dbAuto.candidate_tables ?? 0}, selected=${dbAuto.selected_tables ?? 0}`,
      `- 远程 sitemap: ${plan.remote.enabled ? `${plan.remote.sitemap_url} (max=${plan.remote.max_pages})` : "disabled"}`,
    ].join("\n"),
    [
      "[scan] 1/6-2/6 LLM Analysis Result (framework + knowledge files)",
      `- framework: ${plan.framework || "unknown"}`,
      `- signals: ${(plan.framework_signals || []).join(", ") || "none"}`,
      `- LLM model: ${llmAssist.model || "unknown"}`,
      `- LLM-selected knowledge files: ${llmAssist.selected || plan.filesystem.matched_paths.length}`,
      `- LLM-selected knowledge tables: ${llmSelectedTables}`,
      "",
      "[scan] 3/6 Scan Scope To Confirm",
      `- file candidates: ${plan.filesystem.total_candidates}, matched: ${plan.filesystem.matched_paths.length}`,
      `- database source: ${dbSource}`,
      `- database queries: ${dbQueries.length > 0 ? dbQueries.join(", ") : "none"}`,
      `- database discovery: db=${dbAuto.database_count ?? 0}, tables=${dbAuto.table_count ?? 0}, candidates=${dbAuto.candidate_tables ?? 0}, selected=${dbAuto.selected_tables ?? 0}`,
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

export async function runScan(ctx, argv) {
  const log = (line) => ctx.log(String(line ?? ""));

  try {
    const dryRun = Boolean(argv.options["dry-run"]);
    const assumeYes = Boolean(argv.options.yes);
    const reset = Boolean(argv.options.reset);
    const config = await loadConfig(ctx.cwd, { createIfMissing: false });

    if (typeof ctx.logFilePath === "string" && ctx.logFilePath) {
      log(pick(ctx.locale, `[scan] 日志文件: ${ctx.logFilePath}`, `[scan] Log file: ${ctx.logFilePath}`));
    }

    log(
      pick(
        ctx.locale,
        "[scan] 1/6-3/6 生成扫描计划中（LLM识别框架与知识文件 + 预览扫描范围）...",
        "[scan] 1/6-3/6 Building scan plan (LLM framework/knowledge-file analysis + scope preview)...",
      ),
    );
    const plan = await prepareKnowledgeScanPlan(ctx.cwd, { config });
    log(renderScanPlan(ctx, plan));

    if (dryRun) {
      log(pick(ctx.locale, "[scan] dry-run完成，未写入知识库文件。", "[scan] dry-run completed. No knowledge files were written."));
      return;
    }

    const defaults = {
      filesystem: !Boolean(argv.options["no-filesystem"]),
      database: plan.database.queries.length > 0 && !Boolean(argv.options["no-db"]),
      remote: plan.remote.enabled && !Boolean(argv.options["no-remote"]),
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
        `[scan] 4/6 开始扫描（filesystem=${selections.filesystem}, db=${selections.database}, remote=${selections.remote}）`,
        `[scan] 4/6 Start scanning (filesystem=${selections.filesystem}, db=${selections.database}, remote=${selections.remote})`,
      ),
    );

    const result = await buildKnowledgeBase(ctx.cwd, {
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
          "[scan] 4/6-6/6 已执行：扫描 → 文档编译 → 更新索引 → 写入 manifest.json",
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
          "[scan] 4/6-6/6 Completed: scan -> doc compile -> index update -> manifest.json",
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
