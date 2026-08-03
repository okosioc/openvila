import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startChatService } from "../core/chat-service.js";
import { ensureWidgetPreview } from "../core/install.js";
import { loadKnowledgeIndex } from "../core/knowledge.js";
import { loadConfig } from "../core/runtime.js";
import { startRunSchedules } from "../core/scheduler.js";
import { listSkills } from "../core/skill.js";
import { pick } from "../i18n/messages.js";
import { cliVersion } from "../utils/version.js";
import { runScan } from "./scan.js";

const CLI_ENTRY_PATH = fileURLToPath(new URL("../index.js", import.meta.url));

function forkedRunArgs(argv) {
  const args = ["run"];
  if (argv.options.port) {
    args.push("--port", String(argv.options.port));
  }
  return args;
}

export async function runRun(ctx, argv, dependencies = {}) {
  const loadRuntimeConfig = dependencies.loadConfig || loadConfig;
  const startService = dependencies.startChatService || startChatService;
  const ensurePreview = dependencies.ensureWidgetPreview || ensureWidgetPreview;
  const getCliVersion = dependencies.cliVersion || cliVersion;
  const loadKnowledge = dependencies.loadKnowledgeIndex || loadKnowledgeIndex;
  const listEnabledSkills = dependencies.listSkills || listSkills;
  const startSchedules = dependencies.startRunSchedules || startRunSchedules;
  const runScheduledScan = dependencies.runScan || runScan;
  const runtimeProcess = dependencies.process || process;
  const spawnProcess = dependencies.spawn || spawn;

  if (argv.options.fork) {
    const child = spawnProcess(
      runtimeProcess.execPath || process.execPath,
      [dependencies.cliEntryPath || CLI_ENTRY_PATH, ...forkedRunArgs(argv)],
      {
        cwd: ctx.cwd,
        env: runtimeProcess.env || process.env,
        detached: true,
        stdio: "ignore",
      },
    );
    child.unref();
    ctx.log(
      pick(
        ctx.locale,
        [`OpenVila 已在后台启动: PID ${child.pid}`, "日志: .openvila/logs/debug-YYYY-MM-DD.log", `停止: kill ${child.pid}`].join("\n"),
        [`OpenVila started in background: PID ${child.pid}`, "Logs: .openvila/logs/debug-YYYY-MM-DD.log", `Stop: kill ${child.pid}`].join("\n"),
      ),
    );
    return;
  }

  const config = await loadRuntimeConfig(ctx.cwd);
  const port = Number(argv.options.port || config.run.port || 9394);

  await ensurePreview(ctx.cwd);
  const service = await startService(ctx.cwd, config, { port });
  let scheduler = null;
  let knowledgeIndex = null;
  let enabledSkills = [];
  try {
    knowledgeIndex = await loadKnowledge(ctx.cwd);
    enabledSkills = await listEnabledSkills(ctx.cwd, { enabledOnly: true });
    scheduler = startSchedules(ctx.cwd, config, {
      log: ctx.log,
      scan: () => runScheduledScan(ctx, { options: { yes: true } }),
    });
  } catch (error) {
    await service.close().catch(() => undefined);
    throw error;
  }
  const version = await getCliVersion();
  const knowledgeStats = knowledgeIndex?.source_stats || {};
  const knowledgeFiles = Number(knowledgeStats.filesystem || 0);
  const knowledgeDatabase = Number(knowledgeStats.database || 0);
  const knowledgeRemote = Number(knowledgeStats.remote || 0);
  const skillNames = enabledSkills.map((skill) => skill.name).join(", ") || "none";

  ctx.log(
    pick(
      ctx.locale,
      [
        `OpenVila ${version}`,
        `聊天服务已启动: http://127.0.0.1:${service.port}`,
        `健康检查: http://127.0.0.1:${service.port}/health`,
        `预览: http://127.0.0.1:${service.port}/widget`,
        `聊天接口: POST http://127.0.0.1:${service.port}/openvila/chat`,
        `Telegram 人工接管轮询: ${service.telegram_polling ? "已启用" : "未启用"}`,
        `知识库文档：文件=${knowledgeFiles}, 数据库=${knowledgeDatabase}, 远程=${knowledgeRemote}`,
        `已激活技能: ${skillNames}`,
        `定时任务: ${scheduler.schedules.length > 0 ? scheduler.schedules.map((item) => `${item.task}@${item.at}`).join(", ") : "未配置"}`,
        "按 Ctrl+C 退出",
      ].join("\n"),
      [
        `OpenVila ${version}`,
        `Chat service started: http://127.0.0.1:${service.port}`,
        `Health: http://127.0.0.1:${service.port}/health`,
        `Preview: http://127.0.0.1:${service.port}/widget`,
        `Chat API: POST http://127.0.0.1:${service.port}/openvila/chat`,
        `Telegram handoff polling: ${service.telegram_polling ? "enabled" : "disabled"}`,
        `Knowledge documents: files=${knowledgeFiles}, database=${knowledgeDatabase}, remote=${knowledgeRemote}`,
        `Enabled skills: ${skillNames}`,
        `Scheduled tasks: ${scheduler.schedules.length > 0 ? scheduler.schedules.map((item) => `${item.task}@${item.at}`).join(", ") : "none"}`,
        "Press Ctrl+C to stop",
      ].join("\n"),
    ),
  );

  await new Promise((resolve) => {
    const stop = async () => {
      runtimeProcess.off("SIGINT", stop);
      runtimeProcess.off("SIGTERM", stop);
      await scheduler.close().catch(() => undefined);
      await service.close().catch(() => undefined);
      resolve();
    };

    runtimeProcess.on("SIGINT", stop);
    runtimeProcess.on("SIGTERM", stop);
  });
}
