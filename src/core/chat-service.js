import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { approveReviewItem, listActions, listReviewQueue, queueActionReview, rejectReviewItem } from "./actions.js";
import { notifyChannels } from "./channels.js";
import { chatCompletion, chatCompletionStream, extractJsonObject } from "./llm.js";
import { loadDocContents, loadKnowledgeIndex } from "./knowledge.js";
import { ensureRuntime, runtimePaths } from "./runtime.js";
import { exists, readTextSafe } from "../utils/fs.js";

function sendJson(res, statusCode, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, statusCode, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function openNdjsonStream(res) {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

function writeNdjsonLine(res, payload) {
  res.write(`${JSON.stringify(payload)}\n`);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += String(chunk);
      if (data.length > 2 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const DEFAULT_CHAT_HISTORY_LIMIT = 200;
const MAX_CHAT_HISTORY_LIMIT = 800;
const MAX_CHAT_MESSAGES_PER_SESSION = 800;
const chatWriteQueues = new Map();

function normalizeIdentityValue(value, maxLen = 96) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen);
  return normalized;
}

function resolveChatIdentity(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    visitor_id: normalizeIdentityValue(source.visitor_id, 96),
    session_id: normalizeIdentityValue(source.session_id, 96),
  };
}

function normalizeChatRole(role) {
  if (role === "user" || role === "assistant" || role === "system") {
    return role;
  }
  return "system";
}

function normalizeChatContent(value) {
  const normalized = String(value ?? "")
    .replace(/\u0000/g, "")
    .trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length > 32000) {
    return `${normalized.slice(0, 32000)}\n...[truncated]`;
  }
  return normalized;
}

function normalizeStoredMessage(item) {
  if (!item || typeof item !== "object") {
    return null;
  }
  const content = normalizeChatContent(item.content);
  if (!content) {
    return null;
  }
  return {
    role: normalizeChatRole(item.role),
    content,
    ts: typeof item.ts === "string" && item.ts ? item.ts : new Date().toISOString(),
  };
}

function parseHistoryLimit(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return DEFAULT_CHAT_HISTORY_LIMIT;
  }
  const normalized = Math.trunc(value);
  if (normalized <= 0) {
    return DEFAULT_CHAT_HISTORY_LIMIT;
  }
  return Math.min(normalized, MAX_CHAT_HISTORY_LIMIT);
}

function sessionFilePath(paths, sessionId) {
  return path.join(paths.chats, `${sessionId}.json`);
}

function enqueueSessionWrite(sessionId, task) {
  const previous = chatWriteQueues.get(sessionId) || Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(task)
    .finally(() => {
      if (chatWriteQueues.get(sessionId) === current) {
        chatWriteQueues.delete(sessionId);
      }
    });
  chatWriteQueues.set(sessionId, current);
  return current;
}

async function readChatSession(paths, sessionId) {
  if (!sessionId) {
    return null;
  }

  const raw = await readTextSafe(sessionFilePath(paths, sessionId));
  if (!raw) {
    return null;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const messages = Array.isArray(parsed.messages)
    ? parsed.messages.map((item) => normalizeStoredMessage(item)).filter(Boolean)
    : [];

  return {
    session_id: normalizeIdentityValue(parsed.session_id, 96) || sessionId,
    visitor_id: normalizeIdentityValue(parsed.visitor_id, 96),
    created_at: typeof parsed.created_at === "string" && parsed.created_at ? parsed.created_at : "",
    updated_at: typeof parsed.updated_at === "string" && parsed.updated_at ? parsed.updated_at : "",
    messages: messages.slice(-MAX_CHAT_MESSAGES_PER_SESSION),
  };
}

async function appendChatMessages(paths, identity, entries) {
  const sessionId = identity.session_id;
  if (!sessionId) {
    return null;
  }

  const visitorId = identity.visitor_id;
  const normalizedEntries = Array.isArray(entries)
    ? entries
        .map((entry) => {
          if (!entry || typeof entry !== "object") {
            return null;
          }
          const content = normalizeChatContent(entry.content);
          if (!content) {
            return null;
          }
          return {
            role: normalizeChatRole(entry.role),
            content,
            ts: new Date().toISOString(),
          };
        })
        .filter(Boolean)
    : [];

  if (normalizedEntries.length === 0) {
    return null;
  }

  return enqueueSessionWrite(sessionId, async () => {
    const now = new Date().toISOString();
    const current = (await readChatSession(paths, sessionId)) || {
      session_id: sessionId,
      visitor_id: "",
      created_at: now,
      updated_at: now,
      messages: [],
    };

    if (visitorId) {
      current.visitor_id = visitorId;
    }
    if (!current.created_at) {
      current.created_at = now;
    }
    current.updated_at = now;
    current.messages = [...current.messages, ...normalizedEntries].slice(-MAX_CHAT_MESSAGES_PER_SESSION);

    await fs.writeFile(sessionFilePath(paths, sessionId), `${JSON.stringify(current, null, 2)}\n`, "utf8");
    return current;
  });
}

async function loadChatHistory(paths, sessionId, limit = DEFAULT_CHAT_HISTORY_LIMIT) {
  if (!sessionId) {
    return [];
  }
  const record = await readChatSession(paths, sessionId);
  if (!record) {
    return [];
  }
  return record.messages.slice(-limit);
}

function parseActionRequest(message) {
  const matched = message.trim().match(/^\/action\s+([a-zA-Z_][a-zA-Z0-9_\-]*)(?:\s+(.*))?$/s);
  if (!matched) {
    return null;
  }

  const [, actionName, payloadText] = matched;
  let payload = {};
  if (payloadText && payloadText.trim()) {
    try {
      payload = JSON.parse(payloadText.trim());
    } catch {
      payload = { text: payloadText.trim() };
    }
  }

  return {
    actionName,
    payload,
  };
}

function isHumanSupportRequest(message) {
  const lower = message.toLowerCase();
  const keywords = ["人工", "客服", "站长", "human", "operator", "support"];
  return keywords.some((word) => lower.includes(word));
}

function getAuthToken(req) {
  const auth = req.headers.authorization || "";
  const matched = auth.match(/^bearer\s+(.+)$/i);
  return matched ? matched[1] : null;
}

async function selectDocs(cwd, config, index, question) {
  void cwd;
  const map = index.index_map || {};
  const entries = Object.entries(map);
  if (entries.length === 0) {
    return [];
  }

  const listing = entries
    .slice(0, 220)
    .map(([source, item]) => `${item.doc_path} | ${source} | ${(item.tags || []).join(",")} | ${item.summary}`)
    .join("\n");

  const messages = [
    {
      role: "system",
      content:
        "You are a retrieval planner. Return only JSON object like {\"doc_paths\":[\"docs/...md\"]}. Choose at most 4 doc paths.",
    },
    {
      role: "user",
      content: `Question:\n${question}\n\nDocument index:\n${listing}`,
    },
  ];

  const picked = await chatCompletion(config, messages, { temperature: 0, maxTokens: 180, trace: "chat:doc_select" });
  if (picked.ok) {
    const maybe = extractJsonObject(picked.content);
    if (maybe && Array.isArray(maybe.doc_paths)) {
      const available = new Set(entries.map(([, item]) => item.doc_path));
      const finalPaths = maybe.doc_paths.filter((p) => available.has(p)).slice(0, 4);
      if (finalPaths.length > 0) {
        return finalPaths;
      }
    }
  }

  return entries.slice(0, 4).map(([, item]) => item.doc_path).filter(Boolean);
}

async function answerFromKnowledge(cwd, config, message) {
  const index = await loadKnowledgeIndex(cwd);
  const map = index.index_map || {};
  const entries = Object.entries(map);
  if (entries.length === 0) {
    return {
      ok: false,
      error: "Knowledge base is empty. Run /scan first.",
    };
  }

  const docPaths = await selectDocs(cwd, config, index, message);
  const selectedDocs = await loadDocContents(cwd, docPaths);

  const indexText = entries
    .slice(0, 300)
    .map(([source, item]) => `- ${item.doc_path}: ${source} | ${(item.tags || []).join(",")} | ${item.summary}`)
    .join("\n");

  const docsText = selectedDocs
    .map((doc) => `\n### ${doc.doc_path}\n${doc.content}`)
    .join("\n\n");

  const messages = [
    {
      role: "system",
      content:
        "You are OpenVila assistant for site owners. Use knowledge index first, then selected documents. If unsure, say what information is missing. Reply in the same language as user input.",
    },
    {
      role: "user",
      content: `User question:\n${message}\n\nKnowledge index:\n${indexText}\n\nSelected documents:\n${docsText}`,
    },
  ];

  const completion = await chatCompletion(config, messages, { temperature: 0.35, maxTokens: 900, trace: "chat:answer" });
  if (!completion.ok) {
    return { ok: false, error: completion.error };
  }

  return {
    ok: true,
    answer: completion.content,
    doc_paths: docPaths,
  };
}

async function answerFromKnowledgeStream(cwd, config, message, handlers = {}) {
  const onDelta = typeof handlers.onDelta === "function" ? handlers.onDelta : () => undefined;
  const onStatus = typeof handlers.onStatus === "function" ? handlers.onStatus : () => undefined;
  const index = await loadKnowledgeIndex(cwd);
  const map = index.index_map || {};
  const entries = Object.entries(map);
  if (entries.length === 0) {
    return {
      ok: false,
      error: "Knowledge base is empty. Run /scan first.",
    };
  }

  onStatus("...");
  const docPaths = await selectDocs(cwd, config, index, message);
  const selectedDocs = await loadDocContents(cwd, docPaths);

  const indexText = entries
    .slice(0, 300)
    .map(([source, item]) => `- ${item.doc_path}: ${source} | ${(item.tags || []).join(",")} | ${item.summary}`)
    .join("\n");

  const docsText = selectedDocs
    .map((doc) => `\n### ${doc.doc_path}\n${doc.content}`)
    .join("\n\n");

  const messages = [
    {
      role: "system",
      content:
        "You are OpenVila assistant for site owners. Use knowledge index first, then selected documents. If unsure, say what information is missing. Reply in the same language as user input.",
    },
    {
      role: "user",
      content: `User question:\n${message}\n\nKnowledge index:\n${indexText}\n\nSelected documents:\n${docsText}`,
    },
  ];

  onStatus("......");
  const completion = await chatCompletionStream(config, messages, {
    temperature: 0.35,
    maxTokens: 900,
    trace: "chat:answer_stream",
    onDelta,
  });
  if (!completion.ok) {
    return { ok: false, error: completion.error };
  }

  return {
    ok: true,
    answer: completion.content,
    doc_paths: docPaths,
  };
}

export async function startChatService(cwd, config, options = {}) {
  await ensureRuntime(cwd);
  const paths = runtimePaths(cwd);
  const port = Number(options.port || config.run.port || 9394);

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        sendJson(res, 400, { error: "Missing URL" });
        return;
      }

      const url = new URL(req.url, `http://127.0.0.1:${port}`);

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, service: "openvila", time: new Date().toISOString() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/widget") {
        const content = (await readTextSafe(paths.widget)) || "<h1>Widget not installed. Run /install first.</h1>";
        sendText(res, 200, content, "text/html; charset=utf-8");
        return;
      }

      if (req.method === "GET" && url.pathname === "/openvila/widget.js") {
        if (!(await exists(paths.widgetScript))) {
          sendText(res, 404, "Widget script not found. Run /install first.\n");
          return;
        }
        const js = await fs.readFile(paths.widgetScript, "utf8");
        sendText(res, 200, js, "application/javascript; charset=utf-8");
        return;
      }

      if (req.method === "GET" && url.pathname === "/chat/history") {
        const identity = resolveChatIdentity({
          session_id: url.searchParams.get("session_id") || "",
          visitor_id: url.searchParams.get("visitor_id") || "",
        });
        if (!identity.session_id) {
          sendJson(res, 400, { error: "session_id is required" });
          return;
        }

        const limit = parseHistoryLimit(url.searchParams.get("limit"));
        const messages = await loadChatHistory(paths, identity.session_id, limit);
        sendJson(res, 200, {
          ok: true,
          session_id: identity.session_id,
          visitor_id: identity.visitor_id,
          messages,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/chat") {
        const body = await parseBody(req);
        const message = String(body.message || "").trim();
        const identity = resolveChatIdentity(body);

        if (!message) {
          sendJson(res, 400, { error: "message is required" });
          return;
        }

        const actionReq = parseActionRequest(message);
        if (actionReq) {
          const actions = await listActions(cwd);
          if (!actions.includes(actionReq.actionName)) {
            sendJson(res, 404, {
              error: `Action not found: ${actionReq.actionName}`,
              answer: `Action ${actionReq.actionName} does not exist.`,
            });
            return;
          }

          const queued = await queueActionReview(cwd, actionReq.actionName, actionReq.payload, {
            source: "chat",
            remote: req.socket.remoteAddress,
          });

          const notifyText = `OpenVila action pending approval\n- id: ${queued.id}\n- action: ${queued.action}`;
          await notifyChannels(config, notifyText).catch(() => undefined);
          const actionAnswerText = `Action request submitted for owner approval. request_id=${queued.id}`;
          await appendChatMessages(paths, identity, [
            { role: "user", content: message },
            { role: "assistant", content: actionAnswerText },
          ]).catch(() => undefined);

          sendJson(res, 200, {
            ok: true,
            answer: actionAnswerText,
            request_id: queued.id,
            status: queued.status,
            session_id: identity.session_id,
            visitor_id: identity.visitor_id,
          });
          return;
        }

        if (isHumanSupportRequest(message)) {
          const notifyText = `OpenVila human support requested\n- message: ${message.slice(0, 400)}`;
          await notifyChannels(config, notifyText).catch(() => undefined);
          const supportAnswerText = "Your request has been forwarded to the owner. Please wait for manual support.";
          await appendChatMessages(paths, identity, [
            { role: "user", content: message },
            { role: "assistant", content: supportAnswerText },
          ]).catch(() => undefined);
          sendJson(res, 200, {
            ok: true,
            answer: supportAnswerText,
            session_id: identity.session_id,
            visitor_id: identity.visitor_id,
          });
          return;
        }

        const answer = await answerFromKnowledge(cwd, config, message);
        if (!answer.ok) {
          sendJson(res, 500, {
            ok: false,
            error: answer.error,
            answer: `Service temporarily unavailable: ${answer.error}`,
          });
          return;
        }

        await appendChatMessages(paths, identity, [
          { role: "user", content: message },
          { role: "assistant", content: answer.answer },
        ]).catch(() => undefined);

        sendJson(res, 200, {
          ok: true,
          answer: answer.answer,
          doc_paths: answer.doc_paths,
          session_id: identity.session_id,
          visitor_id: identity.visitor_id,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/chat/stream") {
        const body = await parseBody(req);
        const message = String(body.message || "").trim();
        const identity = resolveChatIdentity(body);
        if (!message) {
          sendJson(res, 400, { error: "message is required" });
          return;
        }

        openNdjsonStream(res);
        writeNdjsonLine(res, {
          type: "start",
          session_id: identity.session_id,
          visitor_id: identity.visitor_id,
        });

        const actionReq = parseActionRequest(message);
        if (actionReq) {
          const actions = await listActions(cwd);
          if (!actions.includes(actionReq.actionName)) {
            writeNdjsonLine(res, {
              type: "error",
              error: `Action not found: ${actionReq.actionName}`,
            });
            writeNdjsonLine(res, { type: "done", ok: false });
            res.end();
            return;
          }

          const queued = await queueActionReview(cwd, actionReq.actionName, actionReq.payload, {
            source: "chat",
            remote: req.socket.remoteAddress,
          });

          const notifyText = `OpenVila action pending approval\n- id: ${queued.id}\n- action: ${queued.action}`;
          await notifyChannels(config, notifyText).catch(() => undefined);
          const actionAnswerText = `Action request submitted for owner approval. request_id=${queued.id}`;
          await appendChatMessages(paths, identity, [
            { role: "user", content: message },
            { role: "assistant", content: actionAnswerText },
          ]).catch(() => undefined);

          writeNdjsonLine(res, {
            type: "delta",
            text: actionAnswerText,
          });
          writeNdjsonLine(res, {
            type: "done",
            ok: true,
            request_id: queued.id,
            status: queued.status,
            session_id: identity.session_id,
            visitor_id: identity.visitor_id,
          });
          res.end();
          return;
        }

        if (isHumanSupportRequest(message)) {
          const notifyText = `OpenVila human support requested\n- message: ${message.slice(0, 400)}`;
          await notifyChannels(config, notifyText).catch(() => undefined);
          const supportAnswerText = "Your request has been forwarded to the owner. Please wait for manual support.";
          await appendChatMessages(paths, identity, [
            { role: "user", content: message },
            { role: "assistant", content: supportAnswerText },
          ]).catch(() => undefined);
          writeNdjsonLine(res, {
            type: "delta",
            text: supportAnswerText,
          });
          writeNdjsonLine(res, {
            type: "done",
            ok: true,
            session_id: identity.session_id,
            visitor_id: identity.visitor_id,
          });
          res.end();
          return;
        }

        const answer = await answerFromKnowledgeStream(cwd, config, message, {
          onStatus: (text) => writeNdjsonLine(res, { type: "status", text }),
          onDelta: (text) => writeNdjsonLine(res, { type: "delta", text }),
        });
        if (!answer.ok) {
          writeNdjsonLine(res, {
            type: "error",
            error: answer.error,
            text: `Service temporarily unavailable: ${answer.error}`,
          });
          writeNdjsonLine(res, { type: "done", ok: false });
          res.end();
          return;
        }

        await appendChatMessages(paths, identity, [
          { role: "user", content: message },
          { role: "assistant", content: answer.answer },
        ]).catch(() => undefined);

        writeNdjsonLine(res, {
          type: "done",
          ok: true,
          answer: answer.answer,
          doc_paths: answer.doc_paths,
          session_id: identity.session_id,
          visitor_id: identity.visitor_id,
        });
        res.end();
        return;
      }

      const token = getAuthToken(req);
      const ownerToken = config.run.owner_token;
      const ownerAuthorized = token && ownerToken && token === ownerToken;

      if (req.method === "GET" && url.pathname === "/owner/requests") {
        if (!ownerAuthorized) {
          sendJson(res, 401, { error: "Unauthorized" });
          return;
        }

        const status = url.searchParams.get("status") || null;
        const queue = await listReviewQueue(cwd, status);
        sendJson(res, 200, { ok: true, items: queue });
        return;
      }

      if (req.method === "POST" && url.pathname === "/owner/approve") {
        if (!ownerAuthorized) {
          sendJson(res, 401, { error: "Unauthorized" });
          return;
        }

        const body = await parseBody(req);
        if (!body.request_id) {
          sendJson(res, 400, { error: "request_id required" });
          return;
        }

        const updated = await approveReviewItem(cwd, body.request_id);
        sendJson(res, 200, { ok: true, item: updated });
        return;
      }

      if (req.method === "POST" && url.pathname === "/owner/reject") {
        if (!ownerAuthorized) {
          sendJson(res, 401, { error: "Unauthorized" });
          return;
        }

        const body = await parseBody(req);
        if (!body.request_id) {
          sendJson(res, 400, { error: "request_id required" });
          return;
        }

        const updated = await rejectReviewItem(cwd, body.request_id, body.reason || "rejected");
        sendJson(res, 200, { ok: true, item: updated });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      if (res.headersSent) {
        try {
          writeNdjsonLine(res, { type: "error", error: error.message });
          writeNdjsonLine(res, { type: "done", ok: false });
          res.end();
        } catch {
          // ignore stream write errors on broken connection
        }
        return;
      }
      sendJson(res, 500, { error: error.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });

  return {
    port,
    owner_token: config.run.owner_token,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
