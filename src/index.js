#!/usr/bin/env node

import process from "node:process";
import readline from "node:readline";
import { runActionCommand } from "./commands/action.js";
import { runChannel } from "./commands/channel.js";
import { runInit } from "./commands/init.js";
import { runInstall } from "./commands/install.js";
import { runRun } from "./commands/run.js";
import { runScan } from "./commands/scan.js";
import { runUi } from "./commands/ui.js";
import { runVila } from "./commands/vila.js";
import { createRuntimeFileLogger, setGlobalLogWriter } from "./core/logging.js";
import {
  initializeRuntime,
  loadConfig,
  isRuntimeInitialized,
  resolveLlmSettings,
  runtimePaths,
  saveConfig,
} from "./core/runtime.js";
import { detectLocaleFromEnv, pick } from "./i18n/messages.js";
import { normalizeCommandName, parseOptionArgs, splitArgs } from "./utils/args.js";
import { exists } from "./utils/fs.js";
import { cliVersion } from "./utils/version.js";

const COMMANDS_NEED_INIT = new Set(["scan", "install", "action", "vila", "channel", "run"]);

function helpText(locale) {
  return pick(
    locale,
    [
      "OpenVila CLI",
      "",
      "命令:",
      "  /ui                         进入 Ink 交互管理终端",
      "  /init [--force]             初始化 .openvila 运行目录",
      "  /scan                       扫描并编译知识库",
      "  /install [--apply] [--all] [--attach-start]",
      "                              安装 widget（默认保守策略）",
      "  /action ...                 管理动作脚本",
      "  /vila ...                   安装/管理精灵",
      "  /channel ...                配置 Telegram/飞书",
      "  /run [--port 9394]          启动聊天服务",
      "  /help                       查看帮助",
      "  /exit                       退出",
      "",
      "你也可以直接执行: openvila ui",
    ].join("\n"),
    [
      "OpenVila CLI",
      "",
      "Commands:",
      "  /ui                         Open Ink interactive manager",
      "  /init [--force]             Initialize .openvila runtime directory",
      "  /scan                       Scan and compile knowledge base",
      "  /install [--apply] [--all] [--attach-start]",
      "                              Install widget (conservative by default)",
      "  /action ...                 Manage actions",
      "  /vila ...                   Manage vilas",
      "  /channel ...                Configure Telegram/Feishu",
      "  /run [--port 9394]          Start chat service",
      "  /help                       Show help",
      "  /exit                       Exit",
      "",
      "You can also run: openvila ui",
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
    logFilePath: "",
    fileLog: null,
    flushLogs: async () => undefined,
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

function missingRuntimeDirMessage(locale) {
  return pick(
    locale,
    "当前目录未发现 .openvila/ 运行目录。",
    "No .openvila/ runtime directory found in current path.",
  );
}

function runtimeConfirmCreatePrompt(locale, dirPath) {
  return pick(
    locale,
    `是否现在创建运行目录？[Y/n]\n${dirPath}\n> `,
    `Create runtime directory now? [Y/n]\n${dirPath}\n> `,
  );
}

function runtimeInitCancelledMessage(locale) {
  return pick(locale, "已取消创建，OpenVila 退出。", "Initialization cancelled. OpenVila exits.");
}

function runtimeInitCreatedMessage(locale, configPath) {
  return pick(
    locale,
    `已创建运行目录，配置文件: ${configPath}`,
    `Runtime created, config file: ${configPath}`,
  );
}

function nonInteractiveInitMessage(locale) {
  return pick(
    locale,
    "当前为非交互环境，无法确认是否创建 .openvila/，已退出。",
    "Non-interactive terminal: cannot confirm runtime creation, exiting.",
  );
}

function missingLlmConfigHint(locale, endpointEnv, apiKeyEnv, modelEnv, configPath) {
  return pick(
    locale,
    [
      "检测到 LLM 配置不完整。",
      `可通过环境变量设置: ${endpointEnv} / ${apiKeyEnv} / ${modelEnv}`,
      `也可以将其写入配置文件: ${configPath}`,
    ].join("\n"),
    [
      "LLM configuration is incomplete.",
      `Set environment vars: ${endpointEnv} / ${apiKeyEnv} / ${modelEnv}`,
      `Or save values into config file: ${configPath}`,
    ].join("\n"),
  );
}

function llmConfigSavedMessage(locale, configPath, endpointSaved, apiKeySaved, modelSaved) {
  return pick(
    locale,
    [
      "已保存 LLM 配置到本地运行目录。",
      `endpoint: ${endpointSaved ? "updated" : "unchanged"}`,
      `api_key: ${apiKeySaved ? "updated" : "unchanged"}`,
      `model: ${modelSaved ? "updated" : "unchanged"}`,
      `文件: ${configPath}`,
    ].join("\n"),
    [
      "Saved LLM settings into local runtime config.",
      `endpoint: ${endpointSaved ? "updated" : "unchanged"}`,
      `api_key: ${apiKeySaved ? "updated" : "unchanged"}`,
      `model: ${modelSaved ? "updated" : "unchanged"}`,
      `File: ${configPath}`,
    ].join("\n"),
  );
}

function askLine(rl, promptText) {
  return new Promise((resolve) => {
    rl.question(promptText, (answer) => resolve(String(answer || "").trim()));
  });
}

function isYes(answer) {
  const normalized = String(answer || "")
    .trim()
    .toLowerCase();
  return normalized === "" || normalized === "y" || normalized === "yes";
}

async function promptAndSaveLlmConfig(ctx, config) {
  const resolved = resolveLlmSettings(config, process.env);
  const needEndpoint = !resolved.endpoint;
  const needApiKey = !resolved.apiKey;
  const needModel = !resolved.modelFromEnv && !resolved.modelFromConfig;

  if (!needEndpoint && !needApiKey && !needModel) {
    return false;
  }

  const paths = runtimePaths(ctx.cwd);
  ctx.log(
    missingLlmConfigHint(
      ctx.locale,
      resolved.endpointEnvNames[0],
      resolved.apiKeyEnvNames[0],
      resolved.modelEnvNames[0],
      paths.config,
    ),
  );

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let endpointInput = "";
  let apiKeyInput = "";
  let modelInput = "";
  try {
    if (needEndpoint) {
      endpointInput = await askLine(
        rl,
        pick(
          ctx.locale,
          "请输入 LLM Endpoint（留空则跳过）: ",
          "Enter LLM endpoint (leave blank to skip): ",
        ),
      );
    }

    if (needApiKey) {
      apiKeyInput = await askLine(
        rl,
        pick(
          ctx.locale,
          "请输入 LLM API Key（留空则跳过）: ",
          "Enter LLM API key (leave blank to skip): ",
        ),
      );
    }

    if (needModel) {
      modelInput = await askLine(
        rl,
        pick(
          ctx.locale,
          "请输入 LLM Model（留空则跳过）: ",
          "Enter LLM model (leave blank to skip): ",
        ),
      );
    }
  } finally {
    rl.close();
  }

  let changed = false;
  let endpointSaved = false;
  let apiKeySaved = false;
  let modelSaved = false;

  if (needEndpoint && endpointInput) {
    config.llm = config.llm || {};
    config.llm.endpoint = endpointInput;
    changed = true;
    endpointSaved = true;
  }

  if (needApiKey && apiKeyInput) {
    config.llm = config.llm || {};
    config.llm.api_key = apiKeyInput;
    changed = true;
    apiKeySaved = true;
  }

  if (needModel && modelInput) {
    config.llm = config.llm || {};
    config.llm.model = modelInput;
    changed = true;
    modelSaved = true;
  }

  if (!changed) {
    return false;
  }

  await saveConfig(ctx.cwd, config);
  ctx.log(llmConfigSavedMessage(ctx.locale, paths.config, endpointSaved, apiKeySaved, modelSaved));
  return true;
}

async function ensureRuntimeReadyWithConfirm(ctx) {
  const paths = runtimePaths(ctx.cwd);
  const runtimeDirExists = await exists(paths.base);
  const initialized = await isRuntimeInitialized(ctx.cwd);
  if (runtimeDirExists && initialized) {
    return true;
  }

  ctx.log(missingRuntimeDirMessage(ctx.locale));

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    ctx.log(nonInteractiveInitMessage(ctx.locale));
    return false;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let answer = "";
  try {
    answer = await askLine(rl, runtimeConfirmCreatePrompt(ctx.locale, paths.base));
  } finally {
    rl.close();
  }

  if (!isYes(answer)) {
    ctx.log(runtimeInitCancelledMessage(ctx.locale));
    return false;
  }

  const result = await initializeRuntime(ctx.cwd);
  ctx.log(runtimeInitCreatedMessage(ctx.locale, result.paths.config));
  return true;
}

async function runStartupChecks(ctx) {
  const ready = await ensureRuntimeReadyWithConfirm(ctx);
  if (!ready) {
    return false;
  }

  try {
    const config = await loadConfig(ctx.cwd, { createIfMissing: false });
    ctx.locale = config.language || ctx.locale;
    await promptAndSaveLlmConfig(ctx, config);
  } catch (error) {
    ctx.log(pick(ctx.locale, `启动检查失败: ${error.message}`, `Startup check failed: ${error.message}`));
    return false;
  }

  return true;
}

async function enableRuntimeLogging(ctx) {
  try {
    const logger = await createRuntimeFileLogger(ctx.cwd);
    const stdoutLog = ctx.log;

    ctx.logFilePath = logger.logFilePath;
    ctx.fileLog = (text) => logger.append(String(text ?? ""));
    ctx.flushLogs = async () => {
      await logger.flush();
    };
    ctx.log = (text) => {
      const line = String(text ?? "");
      stdoutLog(line);
      ctx.fileLog(line);
    };

    setGlobalLogWriter((text) => {
      if (typeof ctx.fileLog === "function") {
        ctx.fileLog(text);
      }
    });
  } catch {
    setGlobalLogWriter(null);
  }
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

  if (command === "ui" || command === "cli") {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      ctx.log(pick(ctx.locale, "Ink UI 需要在 TTY 终端中运行。", "Ink UI requires a TTY terminal."));
      return true;
    }

    const version = await cliVersion();
    await runUi(ctx, {
      version,
      executeTokens: (innerTokens, logger, asker) => executeWithLogger(ctx, innerTokens, logger, asker),
    });
    return true;
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

async function executeWithLogger(ctx, tokens, logger, asker) {
  if (typeof logger !== "function" && typeof asker !== "function") {
    return executeCommand(ctx, tokens);
  }

  const originalLog = ctx.log;
  const originalAsk = ctx.ask;
  const fileLog = ctx.fileLog;
  if (typeof logger === "function") {
    ctx.log = (text) => {
      const line = String(text ?? "");
      logger(line);
      if (typeof fileLog === "function") {
        fileLog(line);
      }
    };
  }
  if (typeof asker === "function") {
    ctx.ask = asker;
  }
  try {
    return await executeCommand(ctx, tokens);
  } finally {
    ctx.log = originalLog;
    ctx.ask = originalAsk;
  }
}

async function runFallbackRepl(ctx) {
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
  const canContinue = await runStartupChecks(ctx);
  if (!canContinue) {
    setGlobalLogWriter(null);
    return;
  }
  await enableRuntimeLogging(ctx);

  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0) {
    try {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        const version = await cliVersion();
        await runUi(ctx, {
          version,
          executeTokens: (tokens, logger, asker) => executeWithLogger(ctx, tokens, logger, asker),
        });
      } else {
        await runFallbackRepl(ctx);
      }
    } finally {
      await ctx.flushLogs().catch(() => undefined);
      setGlobalLogWriter(null);
    }
    return;
  }

  try {
    await executeCommand(ctx, rawArgs);
  } catch (error) {
    ctx.log(pick(ctx.locale, `执行失败: ${error.message}`, `Failed: ${error.message}`));
    process.exitCode = 1;
  } finally {
    await ctx.flushLogs().catch(() => undefined);
    setGlobalLogWriter(null);
  }
}

main().catch((error) => {
  setGlobalLogWriter(null);
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
