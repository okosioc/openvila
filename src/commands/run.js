import { startChatService } from "../core/chat-service.js";
import { loadConfig } from "../core/runtime.js";
import { pick } from "../i18n/messages.js";

export async function runRun(ctx, argv) {
  const config = await loadConfig(ctx.cwd);
  const port = Number(argv.options.port || config.run.port || 3800);

  const service = await startChatService(ctx.cwd, config, { port });

  ctx.log(
    pick(
      ctx.locale,
      [
        `OpenVila 聊天服务已启动: http://127.0.0.1:${service.port}`,
        `健康检查: http://127.0.0.1:${service.port}/health`,
        `聊天接口: POST http://127.0.0.1:${service.port}/chat`,
        `站长审核 token: ${service.owner_token}`,
        `站长审核接口: GET /owner/requests, POST /owner/approve`,
        "按 Ctrl+C 退出",
      ].join("\n"),
      [
        `OpenVila chat service started: http://127.0.0.1:${service.port}`,
        `Health: http://127.0.0.1:${service.port}/health`,
        `Chat API: POST http://127.0.0.1:${service.port}/chat`,
        `Owner token: ${service.owner_token}`,
        `Owner APIs: GET /owner/requests, POST /owner/approve`,
        "Press Ctrl+C to stop",
      ].join("\n"),
    ),
  );

  await new Promise((resolve) => {
    const stop = async () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await service.close().catch(() => undefined);
      resolve();
    };

    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}
