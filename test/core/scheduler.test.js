import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeRuntime, runtimePaths } from "../../src/core/runtime.js";
import { nextRunAt, pruneRuntimeLogs, sendDailyReport, startRunSchedules } from "../../src/core/scheduler.js";

test("nextRunAt selects today or tomorrow at the configured local time", () => {
  const schedule = { hour: 1, minute: 0 };
  assert.deepEqual(nextRunAt(schedule, new Date(2026, 7, 2, 0, 30, 0)), new Date(2026, 7, 2, 1, 0, 0));
  assert.deepEqual(nextRunAt(schedule, new Date(2026, 7, 2, 1, 30, 0)), new Date(2026, 7, 3, 1, 0, 0));
});

test("sendDailyReport includes visitor, Vila, and human messages from yesterday", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-schedule-report-"));
  await initializeRuntime(cwd);
  const paths = runtimePaths(cwd);
  const now = new Date(2026, 7, 2, 1, 0, 0);
  const yesterday = new Date(2026, 7, 1, 12, 0, 0);
  const today = new Date(2026, 7, 2, 0, 30, 0);
  const sessionPath = path.join(paths.chats, "session-report.json");
  await fs.writeFile(
    sessionPath,
    `${JSON.stringify({
      session_id: "session-report",
      messages: [
        { role: "system", content: "Welcome", ts: yesterday.toISOString() },
        { role: "user", content: "Question", ts: yesterday.toISOString() },
        { role: "assistant", content: "Vila answer", ts: new Date(yesterday.getTime() + 60_000).toISOString() },
        { role: "support", content: "Human answer", ts: new Date(yesterday.getTime() + 120_000).toISOString() },
        { role: "handoff", content: "Handoff", ts: new Date(yesterday.getTime() + 180_000).toISOString() },
        { role: "user", content: "Today question", ts: today.toISOString() },
      ],
    }, null, 2)}\n`,
    "utf8",
  );
  await fs.utimes(sessionPath, now, now);
  await fs.writeFile(
    path.join(paths.chats, "session-welcome-only.json"),
    `${JSON.stringify({
      session_id: "session-welcome-only",
      messages: [{ role: "assistant", content: "Hello, I'm Vila.", ts: yesterday.toISOString() }],
    }, null, 2)}\n`,
    "utf8",
  );
  await fs.utimes(path.join(paths.chats, "session-welcome-only.json"), now, now);

  const sent = [];
  const result = await sendDailyReport(cwd, { language: "en" }, {
    now,
    notifyChannels: async (_config, text) => {
      sent.push(text);
      return [{ channel: "telegram", ok: true }];
    },
  });

  assert.equal(result.date, "2026-08-01");
  assert.equal(result.sessions, 1);
  assert.equal(result.messages, 3);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Visitor: Question/);
  assert.match(sent[0], /Vila: Vila answer/);
  assert.match(sent[0], /Human support: Human answer/);
  assert.doesNotMatch(sent[0], /Welcome|Handoff|Today question/);
  assert.doesNotMatch(sent[0], /Hello, I'm Vila|session-welcome-only/);
});

test("pruneRuntimeLogs removes log files older than 30 days", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-schedule-logs-"));
  await initializeRuntime(cwd);
  const paths = runtimePaths(cwd);
  const now = new Date(2026, 7, 2, 1, 0, 0);
  const oldLog = path.join(paths.logs, "debug-old.log");
  const recentLog = path.join(paths.logs, "debug-recent.log");
  await Promise.all([fs.writeFile(oldLog, "old\n"), fs.writeFile(recentLog, "recent\n")]);
  await fs.utimes(oldLog, new Date(2026, 5, 1), new Date(2026, 5, 1));
  await fs.utimes(recentLog, new Date(2026, 6, 31), new Date(2026, 6, 31));

  const result = await pruneRuntimeLogs(cwd, { now });

  assert.equal(result.removed, 1);
  await assert.rejects(fs.access(oldLog));
  await fs.access(recentLog);
});

test("startRunSchedules schedules configured tasks and clears timers on close", async () => {
  const timers = [];
  const cleared = [];
  const logs = [];
  const scheduler = startRunSchedules(
    "/tmp/openvila-schedule-test",
    { run: { schedules: [{ task: "scan", at: "01:00" }] } },
    {
      now: () => new Date(2026, 7, 2, 0, 0, 0),
      setTimeout: (callback, delay) => {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => cleared.push(timer),
      log: (line) => logs.push(line),
      scan: async () => undefined,
    },
  );

  assert.deepEqual(scheduler.schedules, [{ task: "scan", at: "01:00", hour: 1, minute: 0 }]);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 60 * 60 * 1000);
  assert.deepEqual(logs, []);

  await scheduler.close();
  assert.deepEqual(cleared, [timers[0]]);
});
