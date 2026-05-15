import { loadConfig, saveConfig } from "../core/runtime.js";
import { pick } from "../i18n/messages.js";

function usage(locale) {
  return pick(
    locale,
    [
      "用法:",
      "  /channel list",
      "  /channel set telegram --bot-token xxx --chat-id yyy",
      "  /channel set feishu --webhook https://...",
      "  /channel remove telegram|feishu",
    ].join("\n"),
    [
      "Usage:",
      "  /channel list",
      "  /channel set telegram --bot-token xxx --chat-id yyy",
      "  /channel set feishu --webhook https://...",
      "  /channel remove telegram|feishu",
    ].join("\n"),
  );
}

export async function runChannel(ctx, argv) {
  const [sub, target] = argv.positionals;
  if (!sub) {
    ctx.log(usage(ctx.locale));
    return;
  }

  const config = await loadConfig(ctx.cwd);

  if (sub === "list") {
    ctx.log(JSON.stringify(config.channels || {}, null, 2));
    return;
  }

  if (sub === "set") {
    if (target === "telegram") {
      const botToken = String(argv.options["bot-token"] || "");
      const chatId = String(argv.options["chat-id"] || "");
      if (!botToken || !chatId) {
        ctx.log(usage(ctx.locale));
        return;
      }

      config.channels.telegram = {
        bot_token: botToken,
        chat_id: chatId,
      };
      await saveConfig(ctx.cwd, config);
      ctx.log(pick(ctx.locale, "Telegram 已保存", "Telegram saved"));
      return;
    }

    if (target === "feishu") {
      const webhook = String(argv.options.webhook || "");
      if (!webhook) {
        ctx.log(usage(ctx.locale));
        return;
      }

      config.channels.feishu = { webhook };
      await saveConfig(ctx.cwd, config);
      ctx.log(pick(ctx.locale, "飞书已保存", "Feishu saved"));
      return;
    }

    ctx.log(usage(ctx.locale));
    return;
  }

  if (sub === "remove") {
    if (target !== "telegram" && target !== "feishu") {
      ctx.log(usage(ctx.locale));
      return;
    }

    config.channels[target] = null;
    await saveConfig(ctx.cwd, config);
    ctx.log(pick(ctx.locale, `已移除 ${target}`, `Removed ${target}`));
    return;
  }

  ctx.log(usage(ctx.locale));
}
