import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startChatService } from "../../src/core/chat-service.js";
import { defaultConfig, initializeRuntime, runtimePaths } from "../../src/core/runtime.js";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(check, description) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) {
      return result;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server did not expose a TCP port");
  }
  return address.port;
}

async function closeServer(server) {
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function availablePort() {
  const server = http.createServer();
  const port = await listen(server);
  await closeServer(server);
  return port;
}

async function readRequestBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
  }
  return body ? JSON.parse(body) : {};
}

function sendJson(response, payload) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function createTelegramApi() {
  const messages = [];
  const pendingPolls = [];
  let nextMessageId = 100;

  const server = http.createServer(async (request, response) => {
    const body = await readRequestBody(request);
    if (request.method !== "POST") {
      response.writeHead(405);
      response.end();
      return;
    }

    if (request.url === "/bottest-token/sendMessage") {
      const message = { ...body, message_id: nextMessageId };
      nextMessageId += 1;
      messages.push(message);
      sendJson(response, { ok: true, result: { message_id: message.message_id } });
      return;
    }

    if (request.url === "/bottest-token/getUpdates") {
      pendingPolls.push(response);
      return;
    }

    response.writeHead(404);
    response.end();
  });
  const port = await listen(server);

  return {
    endpoint: `http://127.0.0.1:${port}`,
    messages,
    waitForPoll: async () => waitFor(() => pendingPolls.length > 0, "Telegram long poll"),
    deliverUpdate(update) {
      const response = pendingPolls.shift();
      if (!response) {
        throw new Error("No Telegram long poll is waiting for an update");
      }
      sendJson(response, { ok: true, result: [update] });
    },
    async close() {
      for (const response of pendingPolls.splice(0)) {
        response.end();
      }
      await closeServer(server);
    },
  };
}

async function createChatService(options = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-chat-test-"));
  await initializeRuntime(cwd);

  const config = defaultConfig();
  config.run.port = await availablePort();
  config.run.owner_token = "owner-test-token";
  config.channels.telegram = options.telegram || null;

  const service = await startChatService(cwd, config, { port: config.run.port });
  const baseUrl = `http://127.0.0.1:${service.port}`;

  return {
    cwd,
    baseUrl,
    async close() {
      await service.close();
      await fs.rm(cwd, { recursive: true, force: true });
    },
  };
}

async function requestJson(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: { Connection: "close", "Content-Type": "application/json", ...options.headers },
    ...options,
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function readSession(cwd, sessionId) {
  const sessionPath = path.join(runtimePaths(cwd).chats, `${sessionId}.json`);
  try {
    return JSON.parse(await fs.readFile(sessionPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

test("chat accepts a visitor message and keeps duplicate client messages out of history", async () => {
  const chat = await createChatService();

  try {
    const firstResponse = await requestJson(chat.baseUrl, "/chat", {
      method: "POST",
      body: JSON.stringify({
        session_id: "visitor-1",
        client_message_id: "message-1",
        message: "I need human support",
      }),
    });
    const duplicateResponse = await requestJson(chat.baseUrl, "/chat", {
      method: "POST",
      body: JSON.stringify({
        session_id: "visitor-1",
        client_message_id: "message-1",
        message: "I need human support",
      }),
    });

    assert.equal(firstResponse.status, 202);
    assert.equal(firstResponse.body.accepted, true);
    assert.equal(duplicateResponse.status, 202);

    const history = await waitFor(async () => {
      const response = await requestJson(chat.baseUrl, "/chat/history?session_id=visitor-1");
      return response.body.messages.length === 2 ? response.body : null;
    }, "chat response in history");

    assert.deepEqual(
      history.messages.map((message) => message.role),
      ["user", "assistant"],
    );
    assert.equal(history.messages[0].content, "I need human support");
    assert.match(history.messages[1].content, /Manual support is temporarily unavailable/);
  } finally {
    await chat.close();
  }
});

test("Telegram handoff routes owner replies, visitor follow-ups, and close events", async () => {
  const telegram = await createTelegramApi();
  const chat = await createChatService({
    telegram: {
      bot_token: "test-token",
      chat_id: "owner-chat",
      endpoint: telegram.endpoint,
    },
  });

  try {
    await telegram.waitForPoll();

    const initialResponse = await requestJson(chat.baseUrl, "/chat", {
      method: "POST",
      body: JSON.stringify({
        session_id: "visitor-2",
        client_message_id: "handoff-request",
        message: "Please connect me to a human operator",
      }),
    });
    assert.equal(initialResponse.status, 202);

    const waitingSession = await waitFor(async () => {
      const session = await readSession(chat.cwd, "visitor-2");
      return session?.handoff?.status === "waiting_owner" ? session : null;
    }, "Telegram handoff notification");
    const handoffMessage = telegram.messages[0];

    assert.match(handoffMessage.text, /Session: visitor-2/);
    assert.match(handoffMessage.text, /Recent conversation:/);
    assert.equal(waitingSession.handoff.telegram_message_ids[0], handoffMessage.message_id);

    telegram.deliverUpdate({
      update_id: 1,
      message: {
        chat: { id: "owner-chat" },
        reply_to_message: { message_id: handoffMessage.message_id },
        text: "I can help with that.",
      },
    });

    const activeSession = await waitFor(async () => {
      const session = await readSession(chat.cwd, "visitor-2");
      return session?.handoff?.status === "active" && session.messages.some((message) => message.content === "I can help with that.")
        ? session
        : null;
    }, "owner reply delivery");
    assert.ok(activeSession.messages.some((message) => message.role === "support"));

    const visitorResponse = await requestJson(chat.baseUrl, "/chat", {
      method: "POST",
      body: JSON.stringify({
        session_id: "visitor-2",
        client_message_id: "visitor-follow-up",
        message: "My order number is 42.",
      }),
    });
    assert.equal(visitorResponse.status, 202);

    await waitFor(() => telegram.messages.length === 2, "visitor message forwarded to Telegram");
    assert.equal(telegram.messages[1].reply_to_message_id, handoffMessage.message_id);
    assert.equal(telegram.messages[1].text, "Visitor:\nMy order number is 42.");

    await telegram.waitForPoll();
    telegram.deliverUpdate({
      update_id: 2,
      message: {
        chat: { id: "owner-chat" },
        reply_to_message: { message_id: handoffMessage.message_id },
        text: "/close",
      },
    });

    const closedSession = await waitFor(async () => {
      const session = await readSession(chat.cwd, "visitor-2");
      return session?.handoff?.status === "closed" ? session : null;
    }, "manual support close");
    assert.ok(closedSession.messages.some((message) => message.content.includes("Manual support has ended")));
  } finally {
    await chat.close();
    await telegram.close();
  }
});
