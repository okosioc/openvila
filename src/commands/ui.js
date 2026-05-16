import React, { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import { isRuntimeInitialized } from "../core/runtime.js";
import { pick } from "../i18n/messages.js";
import { normalizeCommandName, splitArgs } from "../utils/args.js";

const ASCII_LOGO = [
  " _______  _______  _______  __    _  __   __  ___   ___      _______ ",
  "|       ||       ||       ||  |  | ||  | |  ||   | |   |    |       |",
  "|   _   ||    _  ||    ___||   |_| ||  |_|  ||   | |   |    |   _   |",
  "|  | |  ||   |_| ||   |___ |       ||       ||   | |   |    |  |_|  |",
  "|  |_|  ||    ___||    ___||  _    ||       ||   | |   |___ |       |",
  "|       ||   |    |   |___ | | |   | |     | |   | |       ||   _   |",
  "|_______||___|    |_______||_|  |__|  |___|  |___| |_______||__| |__|"
];

function commandSuggestions(locale) {
  return [
    { cmd: "/init", desc: pick(locale, "初始化运行目录", "initialize runtime directory") },
    { cmd: "/scan", desc: pick(locale, "扫描并编译知识库", "scan and compile knowledge") },
    { cmd: "/install", desc: pick(locale, "生成 widget 预览", "generate widget preview") },
    { cmd: "/install --apply", desc: pick(locale, "注入 widget 到页面", "inject widget into page") },
    { cmd: "/action list", desc: pick(locale, "查看 actions", "list actions") },
    { cmd: "/action create <name>", desc: pick(locale, "创建 action", "create action") },
    { cmd: "/action pending", desc: pick(locale, "查看待审批请求", "list pending requests") },
    { cmd: "/vila list", desc: pick(locale, "查看精灵列表", "list installed vilas") },
    { cmd: "/channel list", desc: pick(locale, "查看通道配置", "show channel config") },
    { cmd: "/run --port 3800", desc: pick(locale, "启动聊天服务", "start chat service") },
    { cmd: "/help", desc: pick(locale, "显示帮助", "show help") },
    { cmd: "/exit", desc: pick(locale, "退出管理终端", "exit manager") },
  ];
}

function splitLogLines(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function statusText(locale, ready) {
  return ready
    ? pick(locale, "initialized", "initialized")
    : pick(locale, "not initialized (run /init)", "not initialized (run /init)");
}

function helpLines(locale) {
  return [
    pick(locale, "commands (prefix with /):", "commands (prefix with /):"),
    "  /init /scan /install /action ... /vila ... /channel ... /run",
    "  /help /exit",
  ];
}

function textInputResponse(locale, text) {
  const t = text.trim();
  if (!t) {
    return [];
  }

  return [
    pick(locale, `input: ${t}`, `input: ${t}`),
    pick(
      locale,
      "this is OpenVila manager UI. run commands with / prefix, e.g. /scan",
      "this is OpenVila manager UI. run commands with / prefix, e.g. /scan",
    ),
  ];
}

function parseCommandLine(line) {
  const rawTokens = splitArgs(line.trim());
  if (rawTokens.length === 0) {
    return null;
  }

  const command = normalizeCommandName(rawTokens[0]);
  if (!command) {
    return null;
  }

  return [command, ...rawTokens.slice(1)];
}

function currentCommandPrefix(value) {
  const trimmed = String(value || "").trimStart();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const token = trimmed.slice(1).split(/\s+/)[0] || "";
  return normalizeCommandName(token);
}

function filteredSuggestions(locale, inputValue) {
  const prefix = currentCommandPrefix(inputValue);
  if (prefix === null) {
    return [];
  }

  const all = commandSuggestions(locale);
  if (!prefix) {
    return all.slice(0, 8);
  }

  return all
    .filter((item) => normalizeCommandName(item.cmd).startsWith(prefix))
    .slice(0, 8);
}

function ManagerApp({ ctx, executeTokens, version, onExit }) {
  const { exit } = useApp();
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [logs, setLogs] = useState([]);
  const [inputValue, setInputValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState(null);
  const [cursorVisible, setCursorVisible] = useState(true);
  const inputRef = useRef("");
  const pendingQuestionRef = useRef(null);
  const pendingResolverRef = useRef(null);
  const suggestions = useMemo(() => {
    if (pendingQuestion) {
      return [];
    }
    return filteredSuggestions(ctx.locale, inputValue);
  }, [ctx.locale, inputValue, pendingQuestion]);

  const appendLog = useCallback((text) => {
    const lines = splitLogLines(text);
    if (lines.length === 0) {
      return;
    }

    setLogs((prev) => [...prev, ...lines].slice(-22));
  }, []);

  const refreshRuntime = useCallback(async () => {
    const ready = await isRuntimeInitialized(ctx.cwd);
    setRuntimeReady(Boolean(ready));
  }, [ctx.cwd]);

  const askInUi = useCallback(
    async (promptText) =>
      new Promise((resolve) => {
        const normalized = String(promptText || "")
          .replace(/\s+/g, " ")
          .trim();
        setPendingQuestion(normalized || pick(ctx.locale, "请输入", "Please enter"));
        pendingResolverRef.current = (answer) => {
          resolve(String(answer || ""));
        };
        setInputValue("");
        inputRef.current = "";
      }),
    [ctx.locale],
  );

  const headerLines = useMemo(() => ASCII_LOGO, []);

  useEffect(() => {
    inputRef.current = inputValue;
  }, [inputValue]);

  useEffect(() => {
    pendingQuestionRef.current = pendingQuestion;
  }, [pendingQuestion]);

  useEffect(() => {
    const timer = setInterval(() => {
      setCursorVisible((prev) => !prev);
    }, 500);
    return () => {
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    (async () => {
      const ready = await isRuntimeInitialized(ctx.cwd).catch(() => false);
      setRuntimeReady(Boolean(ready));
      if (!ready) {
        appendLog(pick(ctx.locale, "未发现 .openvila/，请先执行 /init", "No .openvila/ found. Run /init first"));
      }
      appendLog(pick(ctx.locale, "openvila manager ready. use /help", "openvila manager ready. use /help"));
    })().catch(() => undefined);
  }, [appendLog, ctx.cwd, ctx.locale]);

  const submitLine = useCallback(
    async (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      appendLog(`$ ${trimmed}`);

      if (!trimmed.startsWith("/")) {
        const messages = textInputResponse(ctx.locale, trimmed);
        for (const msg of messages) {
          appendLog(msg);
        }
        return;
      }

      if (trimmed === "/") {
        for (const lineText of helpLines(ctx.locale)) {
          appendLog(lineText);
        }
        return;
      }

      const tokens = parseCommandLine(trimmed);
      if (!tokens) {
        appendLog(pick(ctx.locale, "invalid command", "invalid command"));
        return;
      }

      const command = tokens[0];
      if (command === "help") {
        for (const lineText of helpLines(ctx.locale)) {
          appendLog(lineText);
        }
        return;
      }

      if (command === "exit" || command === "quit") {
        onExit();
        exit();
        return;
      }

      setBusy(true);
      try {
        const keepRunning = await executeTokens(
          tokens,
          (text) => {
            appendLog(text);
          },
          askInUi,
        );

        if (keepRunning === false) {
          onExit();
          exit();
          return;
        }
      } catch (error) {
        appendLog(pick(ctx.locale, `failed: ${error.message}`, `failed: ${error.message}`));
      } finally {
        await refreshRuntime().catch(() => undefined);
        setBusy(false);
      }
    },
    [appendLog, askInUi, ctx.locale, executeTokens, exit, onExit, refreshRuntime],
  );

  useInput((input, key) => {
    const activeQuestion = pendingQuestionRef.current;

    if (key.ctrl && input === "c") {
      onExit();
      exit();
      return;
    }

    if (busy && !activeQuestion) {
      return;
    }

    if (key.return) {
      const value = inputRef.current;
      setInputValue("");
      inputRef.current = "";

      if (activeQuestion) {
        appendLog(`${activeQuestion} ${value}`.trimEnd());
        const resolve = pendingResolverRef.current;
        pendingResolverRef.current = null;
        pendingQuestionRef.current = null;
        setPendingQuestion(null);
        if (typeof resolve === "function") {
          resolve(value);
        }
        return;
      }

      submitLine(value).catch(() => undefined);
      return;
    }

    if (key.backspace || key.delete) {
      setInputValue((prev) => {
        const next = prev.slice(0, -1);
        inputRef.current = next;
        return next;
      });
      return;
    }

    if (!key.ctrl && !key.meta && typeof input === "string" && input.length > 0) {
      if (input.includes("\n") || input.includes("\r")) {
        const normalized = input.replace(/\r/g, "\n");
        const parts = normalized.split("\n");
        let working = inputRef.current;
        const submitLines = [];

        for (let i = 0; i < parts.length; i += 1) {
          const segment = parts[i];
          if (i < parts.length - 1) {
            submitLines.push(`${working}${segment}`);
            working = "";
          } else {
            working = `${working}${segment}`;
          }
        }

        setInputValue(working);
        inputRef.current = working;

        (async () => {
          for (const line of submitLines) {
            await submitLine(line);
          }
        })().catch(() => undefined);

        return;
      }

      const printable = [...input].filter((ch) => ch >= " " && ch !== "\u007f").join("");
      if (!printable) {
        return;
      }

      setInputValue((prev) => {
        const next = `${prev}${printable}`;
        inputRef.current = next;
        return next;
      });
    }
  });

  const prompt = busy && !pendingQuestion ? pick(ctx.locale, "...", "...") : ">";
  const cursor = cursorVisible ? "▌" : " ";

  return h(
    Box,
    { flexDirection: "column", height: "100%" },
    h(
      Box,
      {
        borderStyle: "round",
        borderColor: "cyan",
        paddingX: 1,
        flexDirection: "column",
      },
      ...headerLines.map((line, idx) => h(Text, { key: `logo-${idx}`, color: "cyan" }, line)),
      h(Text, { color: "yellow" }, `OpenVila Manager ${version}`),
      h(Text, { dimColor: true }, `cwd: ${ctx.cwd}`),
      h(Text, { dimColor: true }, `runtime: ${statusText(ctx.locale, runtimeReady)}`),
      h(Text, { dimColor: true }, pick(ctx.locale, "type /help, /exit", "type /help, /exit")),
    ),
    h(
      Box,
      {
        marginTop: 1,
        borderStyle: "single",
        borderColor: "green",
        paddingX: 1,
        flexDirection: "column",
        flexGrow: 1,
      },
      ...(logs.length > 0
        ? logs.map((line, idx) => h(Text, { key: `log-${idx}` }, line))
        : [h(Text, { key: "log-empty", dimColor: true }, pick(ctx.locale, "no logs", "no logs"))]),
    ),
    suggestions.length > 0
      ? h(
          Box,
          {
            marginTop: 1,
            borderStyle: "single",
            borderColor: "blue",
            paddingX: 1,
            flexDirection: "column",
          },
          h(Text, { color: "blue" }, pick(ctx.locale, "可选命令", "available commands")),
          ...suggestions.map((item) =>
            h(Text, { key: item.cmd }, `${item.cmd.padEnd(22)}  ${item.desc}`),
          ),
        )
      : null,
    h(
      Box,
      {
        marginTop: 1,
        borderStyle: "single",
        borderColor: "yellow",
        paddingX: 1,
        flexDirection: "column",
      },
      pendingQuestion ? h(Text, { color: "yellow" }, pendingQuestion) : null,
      h(
        Box,
        null,
        h(Text, { color: "yellow" }, `${prompt} `),
        h(Text, null, inputValue),
        h(Text, { color: "yellow" }, cursor),
      ),
    ),
  );
}

export async function runUi(ctx, options = {}) {
  const executeTokens = options.executeTokens;
  if (typeof executeTokens !== "function") {
    throw new Error("runUi requires executeTokens callback");
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Ink UI requires a TTY terminal");
  }

  const version = options.version || "v0.1.0";

  const instance = render(
    h(ManagerApp, {
      ctx,
      executeTokens,
      version,
      onExit: options.onExit || (() => undefined),
    }),
  );

  await instance.waitUntilExit();
}
