import { startChatService } from "../core/chat-service.js";
import { loadConfig } from "../core/runtime.js";
import { pick } from "../i18n/messages.js";

export async function runRun(ctx, argv, dependencies = {}) {
  const loadRuntimeConfig = dependencies.loadConfig || loadConfig;
  const startService = dependencies.startChatService || startChatService;
  const runtimeProcess = dependencies.process || process;
  const config = await loadRuntimeConfig(ctx.cwd);
  const port = Number(argv.options.port || config.run.port || 9394);

  const service = await startService(ctx.cwd, config, { port });

  ctx.log(
    pick(
      ctx.locale,
      [
        `OpenVila 聊天服务已启动: http://127.0.0.1:${service.port}`,
        `健康检查: http://127.0.0.1:${service.port}/health`,
        `聊天接口: POST http://127.0.0.1:${service.port}/chat`,
        `Telegram 人工接管轮询: ${service.telegram_polling ? "已启用" : "未启用"}`,
        `站长审核 token: ${service.owner_token}`,
        `站长审核接口: GET /owner/requests, POST /owner/approve`,
        "按 Ctrl+C 退出",
      ].join("\n"),
      [
        `OpenVila chat service started: http://127.0.0.1:${service.port}`,
        `Health: http://127.0.0.1:${service.port}/health`,
        `Chat API: POST http://127.0.0.1:${service.port}/chat`,
        `Telegram handoff polling: ${service.telegram_polling ? "enabled" : "disabled"}`,
        `Owner token: ${service.owner_token}`,
        `Owner APIs: GET /owner/requests, POST /owner/approve`,
        "Press Ctrl+C to stop",
      ].join("\n"),
    ),
  );

  await new Promise((resolve) => {
    const stop = async () => {
      runtimeProcess.off("SIGINT", stop);
      runtimeProcess.off("SIGTERM", stop);
      await service.close().catch(() => undefined);
      resolve();
    };

    runtimeProcess.on("SIGINT", stop);
    runtimeProcess.on("SIGTERM", stop);
  });
}
