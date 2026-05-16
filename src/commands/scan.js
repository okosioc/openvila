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
  const keyFiles = plan.filesystem.key_files.slice(0, 10);
  const dbQueries = plan.database.queries.map((item) => `${item.name} (${item.sqlite_path})`).slice(0, 6);

  return pick(
    ctx.locale,
    [
      "[scan] 1/8-2/8 LLM分析结果（框架识别 + 关键文件识别）",
      `- framework: ${plan.framework || "unknown"}`,
      `- 识别信号: ${(plan.framework_signals || []).join(", ") || "none"}`,
      `- LLM模型: ${llmAssist.model || "unknown"}`,
      `- LLM选择知识文件数: ${llmAssist.selected || plan.filesystem.matched_paths.length}`,
      `- 关键文件: ${keyFiles.length > 0 ? keyFiles.join(", ") : "none"}`,
      "",
      "[scan] 3/8 待确认扫描范围",
      `- 文件候选数: ${plan.filesystem.total_candidates}, 命中数: ${plan.filesystem.matched_paths.length}`,
      `- 数据库 queries: ${dbQueries.length > 0 ? dbQueries.join(", ") : "none"}`,
      `- 远程 sitemap: ${plan.remote.enabled ? `${plan.remote.sitemap_url} (max=${plan.remote.max_pages})` : "disabled"}`,
    ].join("\n"),
    [
      "[scan] 1/8-2/8 LLM Analysis Result (framework + key files)",
      `- framework: ${plan.framework || "unknown"}`,
      `- signals: ${(plan.framework_signals || []).join(", ") || "none"}`,
      `- LLM model: ${llmAssist.model || "unknown"}`,
      `- LLM-selected knowledge files: ${llmAssist.selected || plan.filesystem.matched_paths.length}`,
      `- key files: ${keyFiles.length > 0 ? keyFiles.join(", ") : "none"}`,
      "",
      "[scan] 3/8 Scan Scope To Confirm",
      `- file candidates: ${plan.filesystem.total_candidates}, matched: ${plan.filesystem.matched_paths.length}`,
      `- database queries: ${dbQueries.length > 0 ? dbQueries.join(", ") : "none"}`,
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
    const disableLlm = Boolean(argv.options["no-llm"]);
    const config = await loadConfig(ctx.cwd, { createIfMissing: false });

    if (typeof ctx.logFilePath === "string" && ctx.logFilePath) {
      log(pick(ctx.locale, `[scan] 日志文件: ${ctx.logFilePath}`, `[scan] Log file: ${ctx.logFilePath}`));
    }

    if (disableLlm) {
      log(
        pick(
          ctx.locale,
          "[scan] 当前版本为 LLM-only 模式，不支持 --no-llm。",
          "[scan] Current scan mode is LLM-only; --no-llm is not supported.",
        ),
      );
      return;
    }

    log(
      pick(
        ctx.locale,
        "[scan] 1/8-3/8 生成扫描计划中（LLM识别框架与关键文件 + 预览扫描范围）...",
        "[scan] 1/8-3/8 Building scan plan (LLM framework/key-file analysis + scope preview)...",
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
        `[scan] 4/8 开始扫描（filesystem=${selections.filesystem}, db=${selections.database}, remote=${selections.remote}）`,
        `[scan] 4/8 Start scanning (filesystem=${selections.filesystem}, db=${selections.database}, remote=${selections.remote})`,
      ),
    );

    const result = await buildKnowledgeBase(ctx.cwd, {
      config,
      plan,
      selections,
      log: (line) => log(`[scan] ${line}`),
    });

    log(
      pick(
        ctx.locale,
        [
          "[scan] 4/8-7/8 已执行：扫描 → 聚合 topics → 生成 index.md → 写入 manifest.json",
          "[scan] 8/8 汇总",
          `- framework: ${result.framework || "unknown"}`,
          `- 扫描文档数: ${result.scanned}`,
          `- topics: ${result.compiled}`,
          `- source_stats: fs=${result.source_stats.filesystem}, db=${result.source_stats.database}, remote=${result.source_stats.remote}`,
          `- llm_calls: planning=${result.llm_calls?.file_planning ?? 0}, grouping=${result.llm_calls?.topic_grouping ?? 0}, extraction_batches=${result.llm_calls?.topic_extraction_batches ?? 0}, total=${result.llm_calls?.total ?? 0}`,
          `- index: ${result.paths.knowledgeIndex}`,
          `- manifest: ${result.paths.knowledgeManifest}`,
        ].join("\n"),
        [
          "[scan] 4/8-7/8 Completed: scan -> topic aggregation -> index.md -> manifest.json",
          "[scan] 8/8 Summary",
          `- framework: ${result.framework || "unknown"}`,
          `- scanned docs: ${result.scanned}`,
          `- topics: ${result.compiled}`,
          `- source_stats: fs=${result.source_stats.filesystem}, db=${result.source_stats.database}, remote=${result.source_stats.remote}`,
          `- llm_calls: planning=${result.llm_calls?.file_planning ?? 0}, grouping=${result.llm_calls?.topic_grouping ?? 0}, extraction_batches=${result.llm_calls?.topic_extraction_batches ?? 0}, total=${result.llm_calls?.total ?? 0}`,
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
