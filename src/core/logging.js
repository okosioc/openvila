import fs from "node:fs/promises";
import path from "node:path";
import { runtimePaths } from "./runtime.js";
import { ensureDir } from "../utils/fs.js";

let globalLogWriter = null;

function twoDigits(value) {
  return String(value).padStart(2, "0");
}

function formatLocalDate(date = new Date()) {
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
}

function formatLocalDateTime(date = new Date()) {
  return `${formatLocalDate(date)} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}`;
}

export function runtimeDailyLogPath(cwd, date = new Date()) {
  const paths = runtimePaths(cwd);
  return path.join(paths.logs, `openvila-${formatLocalDate(date)}.log`);
}

export async function createRuntimeFileLogger(cwd) {
  const paths = runtimePaths(cwd);
  await ensureDir(paths.logs);

  let writeQueue = Promise.resolve();
  let writeErrorPrinted = false;

  function append(text) {
    const now = new Date();
    const target = runtimeDailyLogPath(cwd, now);
    const stamp = formatLocalDateTime(now);
    const body = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const payload = body.endsWith("\n") ? `[${stamp}] ${body}` : `[${stamp}] ${body}\n`;

    writeQueue = writeQueue.then(() => fs.appendFile(target, payload, "utf8")).catch((error) => {
      if (writeErrorPrinted) {
        return;
      }
      writeErrorPrinted = true;
      process.stderr.write(`[openvila] log write failed: ${error.message}\n`);
    });
  }

  return {
    logFilePath: runtimeDailyLogPath(cwd),
    append,
    async flush() {
      await writeQueue;
    },
  };
}

export function setGlobalLogWriter(writer) {
  globalLogWriter = typeof writer === "function" ? writer : null;
}

export function writeGlobalLog(text) {
  if (typeof globalLogWriter !== "function") {
    return;
  }
  try {
    globalLogWriter(String(text ?? ""));
  } catch {
    // Ignore global logger errors.
  }
}
