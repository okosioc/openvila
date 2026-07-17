import assert from "node:assert/strict";
import test from "node:test";
import { runRun } from "../../src/commands/run.js";

function createContext() {
  const logs = [];
  return {
    cwd: "/tmp/openvila-run-test",
    locale: "en",
    log: (message) => logs.push(String(message)),
    logs,
  };
}

function createRuntimeProcess() {
  const listeners = new Map();
  const listenerWaiters = new Map();

  return {
    on(signal, listener) {
      listeners.set(signal, listener);
      listenerWaiters.get(signal)?.();
      return this;
    },
    off(signal, listener) {
      if (listeners.get(signal) === listener) {
        listeners.delete(signal);
      }
      return this;
    },
    emit(signal) {
      return listeners.get(signal)?.();
    },
    waitFor(signal) {
      if (listeners.has(signal)) {
        return Promise.resolve();
      }
      return new Promise((resolve) => listenerWaiters.set(signal, resolve));
    },
  };
}

test("runRun uses the configured port and closes the service on SIGTERM", async () => {
  const context = createContext();
  const runtimeProcess = createRuntimeProcess();
  const startCalls = [];
  const previewCalls = [];
  let closeCalls = 0;

  const runPromise = runRun(
    context,
    { options: {} },
    {
      loadConfig: async () => ({ run: { port: 9460 } }),
      ensureWidgetPreview: async (cwd) => {
        previewCalls.push(cwd);
      },
      startChatService: async (cwd, config, options) => {
        startCalls.push({ cwd, config, options });
        return {
          port: options.port,
          owner_token: "owner-token",
          telegram_polling: false,
          close: async () => {
            closeCalls += 1;
          },
        };
      },
      process: runtimeProcess,
    },
  );

  await runtimeProcess.waitFor("SIGTERM");
  await runtimeProcess.emit("SIGTERM");
  await runPromise;

  assert.deepEqual(startCalls, [
    {
      cwd: "/tmp/openvila-run-test",
      config: { run: { port: 9460 } },
      options: { port: 9460 },
    },
  ]);
  assert.deepEqual(previewCalls, ["/tmp/openvila-run-test"]);
  assert.equal(closeCalls, 1);
  assert.ok(context.logs.some((line) => line.includes("Widget preview: http://127.0.0.1:9460/widget")));
  assert.ok(context.logs.some((line) => line.includes("http://127.0.0.1:9460")));
  assert.ok(context.logs.some((line) => line.includes("Telegram handoff polling: disabled")));
});

test("runRun lets the command port override the runtime configuration", async () => {
  const context = createContext();
  const runtimeProcess = createRuntimeProcess();
  let selectedPort = null;
  let previewCwd = "";

  const runPromise = runRun(
    context,
    { options: { port: "9510" } },
    {
      loadConfig: async () => ({ run: { port: 9460 } }),
      ensureWidgetPreview: async (cwd) => {
        previewCwd = cwd;
      },
      startChatService: async (cwd, config, options) => {
        selectedPort = options.port;
        return {
          port: options.port,
          owner_token: "owner-token",
          telegram_polling: true,
          close: async () => undefined,
        };
      },
      process: runtimeProcess,
    },
  );

  await runtimeProcess.waitFor("SIGINT");
  await runtimeProcess.emit("SIGINT");
  await runPromise;

  assert.equal(selectedPort, 9510);
  assert.equal(previewCwd, "/tmp/openvila-run-test");
  assert.ok(context.logs.some((line) => line.includes("Telegram handoff polling: enabled")));
});
