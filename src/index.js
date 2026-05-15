#!/usr/bin/env node

import process from "node:process";
import readline from "node:readline";
import { runActionCommand } from "./commands/action.js";
import { runChannel } from "./commands/channel.js";
import { runInit } from "./commands/init.js";
import { runInstall } from "./commands/install.js";
import { runRun } from "./commands/run.js";
import { runScan } from "./commands/scan.js";
import { runVila } from "./commands/vila.js";
import { loadConfig, isRuntimeInitialized } from "./core/runtime.js";
import { detectLocaleFromEnv, pick } from "./i18n/messages.js";
import { normalizeCommandName, parseOptionArgs, splitArgs } from "./utils/args.js";

const COMMANDS_NEED_INIT = new Set(["scan", "install", "action", "vila", "channel", "run"]);

function helpText(locale) {
  return pick(
    locale,
    [
      "OpenVila CLI",
      "",
      "命令:",
      "  /init [--force]             初始化 .openvila 运行目录",
      "  /scan                       扫描并编译知识库",
      "  /install [--apply] [--all] [--attach-start]",
      "                              安装 widget（默认保守策略）",
      "  /action ...                 管理动作脚本",
      "  /vila ...                   安装/管理精灵",
      "  /channel ...                配置 Telegram/飞书",
      "  /run [--port 3800]          启动聊天服务",
      "  /help                       查看帮助",
      "  /exit                       退出 REPL",
      "",
      "你也可以直接执行: openvila init",
    ].join("\n"),
    [
      "OpenVila CLI",
      "",
      "Commands:",
      "  /init [--force]             Initialize .openvila runtime directory",
      "  /scan                       Scan and compile knowledge base",
      "  /install [--apply] [--all] [--attach-start]",
      "                              Install widget (conservative by default)",
      "  /action ...                 Manage actions",
      "  /vila ...                   Manage vilas",
      "  /channel ...                Configure Telegram/Feishu",
      "  /run [--port 3800]          Start chat service",
      "  /help                       Show help",
      "  /exit                       Exit REPL",
      "",
      "You can also run: openvila init",
    ].join("\n"),
  );
}

async function createContext(cwd) {
  let locale = detectLocaleFromEnv();

  if (await isRuntimeInitialized(cwd)) {
    try {
      const config = await loadConfig(cwd, { createIfMissing: false });
      locale = config.language || locale;
    } catch {
      // Fallback to env locale when runtime files are partially broken.
    }
  }

  return {
    cwd,
    locale,
    log: (text) => {
      process.stdout.write(`${String(text)}\n`);
    },
  };
}

function notInitializedMessage(locale) {
  return pick(
    locale,
    "当前目录尚未初始化 OpenVila。请先执行 /init。",
    "OpenVila is not initialized in this directory. Run /init first.",
  );
}

async function executeCommand(ctx, tokens) {
  if (!tokens || tokens.length === 0) {
    return true;
  }

  const command = normalizeCommandName(tokens[0]);
  const argv = parseOptionArgs(tokens.slice(1));

  if (!command || command === "help") {
    ctx.log(helpText(ctx.locale));
    return true;
  }

  if (command === "exit" || command === "quit") {
    return false;
  }

  if (command === "init") {
    await runInit(ctx, argv);
    try {
      const config = await loadConfig(ctx.cwd, { createIfMissing: false });
      ctx.locale = config.language || ctx.locale;
    } catch {
      // Ignore locale refresh errors.
    }
    return true;
  }

  if (COMMANDS_NEED_INIT.has(command) && !(await isRuntimeInitialized(ctx.cwd))) {
    ctx.log(notInitializedMessage(ctx.locale));
    return true;
  }

  if (command === "scan") {
    await runScan(ctx, argv);
    return true;
  }

  if (command === "install") {
    await runInstall(ctx, argv);
    return true;
  }

  if (command === "action") {
    await runActionCommand(ctx, argv);
    return true;
  }

  if (command === "vila") {
    await runVila(ctx, argv);
    return true;
  }

  if (command === "channel") {
    await runChannel(ctx, argv);
    return true;
  }

  if (command === "run") {
    await runRun(ctx, argv);
    return true;
  }

  ctx.log(
    pick(
      ctx.locale,
      `未知命令: ${tokens[0]}\n输入 /help 查看帮助`,
      `Unknown command: ${tokens[0]}\nUse /help for help`,
    ),
  );

  return true;
}

async function runRepl(ctx) {
  ctx.log(helpText(ctx.locale));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "openvila> ",
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const tokens = splitArgs(line.trim());
    try {
      const keepRunning = await executeCommand(ctx, tokens);
      if (!keepRunning) {
        rl.close();
        return;
      }
    } catch (error) {
      ctx.log(pick(ctx.locale, `执行失败: ${error.message}`, `Failed: ${error.message}`));
    }
    rl.prompt();
  });

  await new Promise((resolve) => {
    rl.on("close", resolve);
  });
}

async function main() {
  const cwd = process.cwd();
  const ctx = await createContext(cwd);

  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0) {
    await runRepl(ctx);
    return;
  }

  try {
    await executeCommand(ctx, rawArgs);
  } catch (error) {
    ctx.log(pick(ctx.locale, `执行失败: ${error.message}`, `Failed: ${error.message}`));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
