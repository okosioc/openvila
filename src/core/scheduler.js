import fs from "node:fs/promises";
import path from "node:path";
import { notifyChannels } from "./channels.js";
import { runtimePaths } from "./runtime.js";
import { pick } from "../i18n/messages.js";

const DAILY_REPORT_ROLES = new Set(["user", "assistant", "support"]);
const LOG_RETENTION_DAYS = 30;
const REPORT_CHUNK_CHARS = 3500;

function twoDigits(value) {
  return String(value).padStart(2, "0");
}

function formatLocalDate(date) {
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
}

function formatLocalTime(date) {
  return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

function parseScheduleTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

export function readRunSchedules(config, taskNames) {
  const configured = config?.run?.schedules;
  if (!configured) {
    return [];
  }
  if (!Array.isArray(configured)) {
    throw new Error("run.schedules must be a list");
  }

  const allowedTasks = new Set(taskNames);
  return configured.map((item, index) => {
    const task = String(item?.task || "").trim();
    const at = String(item?.at || "").trim();
    const time = parseScheduleTime(at);
    if (!allowedTasks.has(task)) {
      throw new Error(`run.schedules[${index}].task must be one of: ${[...allowedTasks].join(", ")}`);
    }
    if (!time) {
      throw new Error(`run.schedules[${index}].at must use HH:mm`);
    }
    return { task, at, ...time };
  });
}

export function nextRunAt(schedule, now = new Date()) {
  const next = new Date(now);
  next.setHours(schedule.hour, schedule.minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

function previousDayRange(now) {
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - 1);
  return { start, end };
}

function reportMessageTime(message) {
  const date = new Date(message.ts);
  return Number.isFinite(date.getTime()) ? formatLocalTime(date) : "--:--";
}

function splitReport(text) {
  const chunks = [];
  let current = "";
  for (const line of String(text || "").split("\n")) {
    let remaining = line;
    while (remaining.length > REPORT_CHUNK_CHARS) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(remaining.slice(0, REPORT_CHUNK_CHARS));
      remaining = remaining.slice(REPORT_CHUNK_CHARS);
    }
    const candidate = current ? `${current}\n${remaining}` : remaining;
    if (candidate.length > REPORT_CHUNK_CHARS && current) {
      chunks.push(current);
      current = remaining;
    } else {
      current = candidate;
    }
  }
  if (current || chunks.length === 0) {
    chunks.push(current);
  }
  return chunks;
}

function renderDailyReport(records, reportDate, locale) {
  const roleLabels = {
    user: pick(locale, "访客", "Visitor"),
    assistant: "Vila",
    support: pick(locale, "人工客服", "Human support"),
  };
  const messageCount = records.reduce((total, item) => total + item.messages.length, 0);
  const lines = [
    "━━━━━━━━━━━━━━━━━━━━",
    pick(locale, "OpenVila 每日对话报告", "OpenVila Daily Chat Report"),
    "━━━━━━━━━━━━━━━━━━━━",
    `${pick(locale, "日期", "Date")}: ${reportDate}`,
    `${pick(locale, "会话", "Sessions")}: ${records.length}`,
    `${pick(locale, "消息", "Messages")}: ${messageCount}`,
  ];

  if (records.length === 0) {
    lines.push("", pick(locale, "昨天没有访客对话。", "No visitor conversations yesterday."));
    return { text: lines.join("\n"), messageCount };
  }

  for (const record of records) {
    lines.push("", `[${record.sessionId}]`);
    for (const message of record.messages) {
      lines.push(`[${reportMessageTime(message)}] ${roleLabels[message.role]}: ${message.content}`);
    }
  }
  return { text: lines.join("\n"), messageCount };
}

async function readDailyChatRecords(cwd, start, end, dependencies = {}) {
  const filesystem = dependencies.fs || fs;
  const paths = runtimePaths(cwd);
  let entries = [];
  try {
    entries = await filesystem.readdir(paths.chats, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { records: [], skipped: 0 };
    }
    throw error;
  }

  const records = [];
  let skipped = 0;
  const sessionEntries = entries.filter((entry) => entry.isFile() && /^session-.+\.json$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sessionEntries) {
    const filePath = path.join(paths.chats, entry.name);
    const stat = await filesystem.stat(filePath);
    if (stat.mtime.getTime() < start.getTime()) {
      continue;
    }

    let session = null;
    try {
      session = JSON.parse(await filesystem.readFile(filePath, "utf8"));
    } catch {
      skipped += 1;
      continue;
    }
    const messages = Array.isArray(session?.messages)
      ? session.messages.filter((message) => {
          if (!DAILY_REPORT_ROLES.has(message?.role)) {
            return false;
          }
          const timestamp = new Date(message.ts).getTime();
          return Number.isFinite(timestamp) && timestamp >= start.getTime() && timestamp < end.getTime();
        })
      : [];
    if (messages.length === 0) {
      continue;
    }
    records.push({
      sessionId: String(session.session_id || entry.name.slice(0, -".json".length)),
      messages,
    });
  }
  return { records, skipped };
}

function deliverySummary(deliveries) {
  const status = new Map();
  for (const delivery of deliveries) {
    const current = status.get(delivery.channel) || { ok: 0, failed: 0 };
    if (delivery.ok) {
      current.ok += 1;
    } else {
      current.failed += 1;
    }
    status.set(delivery.channel, current);
  }
  return [...status.entries()]
    .map(([channel, result]) => `${channel}=ok:${result.ok},failed:${result.failed}`)
    .join(", ");
}

export async function sendDailyReport(cwd, config, options = {}) {
  const now = options.now || new Date();
  const locale = config?.language || "en";
  const send = options.notifyChannels || notifyChannels;
  const { start, end } = previousDayRange(now);
  const { records, skipped } = await readDailyChatRecords(cwd, start, end, options);
  const rendered = renderDailyReport(records, formatLocalDate(start), locale);
  const chunks = splitReport(rendered.text);
  const deliveries = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const prefix = chunks.length > 1 ? `(${index + 1}/${chunks.length})\n` : "";
    const result = await send(config, `${prefix}${chunks[index]}`);
    if (Array.isArray(result)) {
      deliveries.push(...result);
    }
  }

  return {
    date: formatLocalDate(start),
    sessions: records.length,
    messages: rendered.messageCount,
    skipped,
    parts: chunks.length,
    deliveries,
  };
}

export async function pruneRuntimeLogs(cwd, options = {}) {
  const filesystem = options.fs || fs;
  const now = options.now || new Date();
  const paths = runtimePaths(cwd);
  const cutoff = now.getTime() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let entries = [];
  try {
    entries = await filesystem.readdir(paths.logs, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { removed: 0 };
    }
    throw error;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".log")) {
      continue;
    }
    const filePath = path.join(paths.logs, entry.name);
    const stat = await filesystem.stat(filePath);
    if (stat.mtime.getTime() >= cutoff) {
      continue;
    }
    await filesystem.unlink(filePath);
    removed += 1;
  }
  return { removed };
}

export function startRunSchedules(cwd, config, options = {}) {
  const log = typeof options.log === "function" ? options.log : () => undefined;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const handlers = {
    "daily-report": async () => {
      const result = await sendDailyReport(cwd, config, options);
      log(
        `[schedule] daily-report completed\ndate: ${result.date}\nsessions: ${result.sessions}\nmessages: ${result.messages}\nskipped_sessions: ${result.skipped}\nparts: ${result.parts}\ndeliveries: ${deliverySummary(result.deliveries) || "none"}`,
      );
    },
    housekeeping: async () => {
      const result = await pruneRuntimeLogs(cwd, options);
      log(`[schedule] housekeeping completed\nremoved_logs: ${result.removed}\nretention_days: ${LOG_RETENTION_DAYS}`);
    },
  };
  if (typeof options.scan === "function") {
    handlers.scan = options.scan;
  }

  const schedules = readRunSchedules(config, Object.keys(handlers));
  const timers = new Set();
  let closed = false;
  let taskQueue = Promise.resolve();

  function scheduleNext(schedule) {
    if (closed) {
      return;
    }
    const current = now();
    const target = nextRunAt(schedule, current);
    const delay = Math.max(1, target.getTime() - current.getTime());
    const timer = setTimer(() => {
      timers.delete(timer);
      void runScheduledTask(schedule);
    }, delay);
    timers.add(timer);
  }

  async function runScheduledTask(schedule) {
    taskQueue = taskQueue
      .catch(() => undefined)
      .then(async () => {
        if (closed) {
          return;
        }
        log(`[schedule] started\ntask: ${schedule.task}\nat: ${schedule.at}`);
        try {
          await handlers[schedule.task]();
          log(`[schedule] completed\ntask: ${schedule.task}`);
        } catch (error) {
          log(`[schedule] failed\ntask: ${schedule.task}\nerror: ${error?.message || error}`);
        }
      });
    await taskQueue;
    scheduleNext(schedule);
  }

  for (const schedule of schedules) {
    scheduleNext(schedule);
  }

  return {
    schedules,
    close: async () => {
      closed = true;
      for (const timer of timers) {
        clearTimer(timer);
      }
      timers.clear();
      await taskQueue.catch(() => undefined);
    },
  };
}
