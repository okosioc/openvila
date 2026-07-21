import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { URL } from "node:url";
import { approveReviewItem, listActions, listReviewQueue, queueActionReview, rejectReviewItem } from "./actions.js";
import { hasTelegramChannel, notifyChannels, sendTelegramMessage } from "./channels.js";
import {
  addTelegramReplyMapping,
  startTelegramHandoffPolling,
} from "./handoffs.js";
import { chatCompletion, chatCompletionStream, extractJsonObject } from "./llm.js";
import { loadDocContents, loadKnowledgeIndex } from "./knowledge.js";
import { writeGlobalLog } from "./logging.js";
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

function openSseStream(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

function allowSameHostCors(req, res) {
  const origin = String(req.headers.origin || "").trim();
  const host = String(req.headers.host || "").trim();
  if (!origin || !host) {
    return false;
  }

  try {
    const originUrl = new URL(origin);
    const requestUrl = new URL(`http://${host}`);
    const sameHostname = originUrl.hostname === requestUrl.hostname;
    const bothLoopback = LOOPBACK_HOSTNAMES.has(originUrl.hostname) && LOOPBACK_HOSTNAMES.has(requestUrl.hostname);
    if (!sameHostname && !bothLoopback) {
      return false;
    }
  } catch {
    return false;
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-OpenVila-Owner-Token");
  res.setHeader("Vary", "Origin");
  return true;
}

function writeSseEvent(res, eventName, payload) {
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
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
const DOC_SELECT_HISTORY_LIMIT = 20;
const DOC_SELECT_HISTORY_ITEM_MAX_CHARS = 400;
const DOC_SELECT_FREQUENT_SECTION_MAX_CHARS = 180000;
const DOC_SELECT_DIRECT_ANSWER_MIN_CONFIDENCE = 0.85;
const HANDOFF_TRANSCRIPT_LIMIT = 12;
const HANDOFF_MESSAGE_MAX_CHARS = 800;
const HANDOFF_TELEGRAM_TRANSCRIPT_MAX_CHARS = 3400;
const OPEN_HANDOFF_STATUSES = new Set(["pending_send", "waiting_owner", "active"]);
const RESERVED_CHAT_SESSION_IDS = new Set(["telegram"]);
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const CHAT_API_PATH = "/openvila/chat";
const SSE_HEARTBEAT_INTERVAL_MS = 20000;
const chatWriteQueues = new Map();
const chatProcessQueues = new Map();
const MAX_LOG_FIELD_LENGTH = 260;

function oneLine(value) {
  return String(value ?? "")
    .replace(/\r\n/g, " ")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .trim();
}

function sanitizeLogField(value, maxLen = MAX_LOG_FIELD_LENGTH) {
  const normalized = oneLine(value);
  if (!normalized) {
    return "-";
  }
  if (normalized.length <= maxLen) {
    return normalized;
  }
  return `${normalized.slice(0, maxLen)}...`;
}

function fullLogText(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n") || "(empty)";
}

function readRequestMeta(req) {
  const headers = req?.headers || {};
  return {
    remote: sanitizeLogField(req?.socket?.remoteAddress || ""),
    forwarded_for: sanitizeLogField(headers["x-forwarded-for"] || ""),
    user_agent: sanitizeLogField(headers["user-agent"] || ""),
    referer: sanitizeLogField(headers.referer || ""),
  };
}

function writeChatSessionLog(eventName, req, identity, extra = {}) {
  const safeIdentity = identity && typeof identity === "object" ? identity : {};
  const meta = readRequestMeta(req);
  const lines = [
    `[chat] ${sanitizeLogField(eventName, 64)}`,
    `session_id: ${sanitizeLogField(safeIdentity.session_id || "")}`,
    `remote: ${meta.remote}`,
    `x_forwarded_for: ${meta.forwarded_for}`,
    `user_agent: ${meta.user_agent}`,
    `referer: ${meta.referer}`,
  ];

  for (const [key, value] of Object.entries(extra)) {
    lines.push(`${sanitizeLogField(key, 64)}: ${sanitizeLogField(value)}`);
  }

  writeGlobalLog(lines.join("\n"));
}

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
  const sessionId = normalizeIdentityValue(source.session_id, 96);
  return {
    session_id: RESERVED_CHAT_SESSION_IDS.has(sessionId) ? "" : sessionId,
  };
}

function normalizeChatRole(role) {
  if (role === "user" || role === "assistant" || role === "handoff" || role === "support" || role === "system") {
    return role;
  }
  return "system";
}

function normalizeStoredHandoff(item) {
  if (!item || typeof item !== "object" || String(item.channel || "") !== "telegram") {
    return null;
  }

  const messageIds = Array.isArray(item.telegram_message_ids)
    ? item.telegram_message_ids.map((value) => Number(value)).filter(Number.isFinite)
    : [];
  return {
    status: String(item.status || ""),
    channel: "telegram",
    telegram_chat_id: String(item.telegram_chat_id || ""),
    telegram_message_ids: messageIds,
    requested_at: typeof item.requested_at === "string" ? item.requested_at : "",
    updated_at: typeof item.updated_at === "string" ? item.updated_at : "",
    activated_at: typeof item.activated_at === "string" ? item.activated_at : "",
    closed_at: typeof item.closed_at === "string" ? item.closed_at : "",
    error: typeof item.error === "string" ? item.error : "",
  };
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

function chatLocale(value) {
  return String(value || "").trim().toLowerCase().startsWith("zh") ? "zh" : "en";
}

function chatWelcomeMessage(config, visitorLocale = "") {
  const message = chatLocale(visitorLocale) === "zh" ? config?.chat?.welcome_message?.zh : config?.chat?.welcome_message?.en;
  return normalizeChatContent(message);
}

function chatHandoffText(locale, key) {
  const messages =
    chatLocale(locale) === "zh"
      ? {
          requested: "已请求人工客服支持。",
          started: "人工客服已接入。",
          closed: "人工客服服务已结束，您可以继续与 Vila 对话。",
          notification_failed: "人工客服通知发送失败。",
          forwarded: "您的消息已转发给人工客服，请等待回复。",
          request_sent: "您的请求已转发给站长，请等待人工客服回复。",
          unavailable: "人工客服暂时不可用，请稍后再试。",
        }
      : {
          requested: "Manual support requested.",
          started: "Manual support started.",
          closed: "Manual support has ended. You can continue chatting with Vila.",
          notification_failed: "Manual support notification failed.",
          forwarded: "Your message has been forwarded to manual support. Please wait for a reply.",
          request_sent: "Your request has been forwarded to the owner. Please wait for manual support.",
          unavailable: "Manual support is temporarily unavailable. Please try again later.",
        };
  return messages[key] || "";
}

function normalizeMessageId(value) {
  const normalized = String(value || "").trim().slice(0, 128);
  return normalized || "";
}

function normalizeClientMessageId(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128);
  return normalized;
}

function legacyMessageId(role, content, timestamp) {
  const hash = crypto.createHash("sha256").update(`${role}\u0000${timestamp}\u0000${content}`).digest("hex");
  return `legacy-${hash}`;
}

function createChatMessage(role, content, options = {}) {
  const normalizedContent = normalizeChatContent(content);
  if (!normalizedContent) {
    return null;
  }

  const timestamp = typeof options.ts === "string" && options.ts ? options.ts : new Date().toISOString();
  return {
    id: normalizeMessageId(options.id) || crypto.randomUUID(),
    client_message_id: normalizeClientMessageId(options.client_message_id),
    role: normalizeChatRole(role),
    content: normalizedContent,
    ts: timestamp,
  };
}

function normalizeStoredMessage(item) {
  if (!item || typeof item !== "object") {
    return null;
  }
  const content = normalizeChatContent(item.content);
  if (!content) {
    return null;
  }
  const role = normalizeChatRole(item.role);
  const timestamp = typeof item.ts === "string" && item.ts ? item.ts : new Date().toISOString();
  return {
    id: normalizeMessageId(item.id) || legacyMessageId(role, content, timestamp),
    client_message_id: normalizeClientMessageId(item.client_message_id),
    role,
    content,
    ts: timestamp,
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

function enqueueSessionProcess(sessionId, task) {
  const previous = chatProcessQueues.get(sessionId) || Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(task)
    .finally(() => {
      if (chatProcessQueues.get(sessionId) === current) {
        chatProcessQueues.delete(sessionId);
      }
    });
  chatProcessQueues.set(sessionId, current);
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
    locale: chatLocale(parsed.locale),
    created_at: typeof parsed.created_at === "string" && parsed.created_at ? parsed.created_at : "",
    updated_at: typeof parsed.updated_at === "string" && parsed.updated_at ? parsed.updated_at : "",
    handoff: normalizeStoredHandoff(parsed.handoff),
    messages: messages.slice(-MAX_CHAT_MESSAGES_PER_SESSION),
  };
}

async function appendChatMessages(paths, identity, entries, context = {}) {
  const contextSafe = context && typeof context === "object" ? context : {};
  const route = contextSafe.route || "-";
  const mode = contextSafe.mode || "-";
  const sessionId = identity.session_id;
  if (!sessionId) {
    return null;
  }

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
          return createChatMessage(entry.role, content, entry);
        })
        .filter(Boolean)
    : [];

  if (normalizedEntries.length === 0) {
    return null;
  }

  return enqueueSessionWrite(sessionId, async () => {
    const now = new Date().toISOString();
    const existing = await readChatSession(paths, sessionId);
    if (contextSafe.onlyIfNew && existing) {
      return {
        session: existing,
        appended: [],
      };
    }
    const current = existing || {
      session_id: sessionId,
      locale: chatLocale(contextSafe.locale),
      created_at: now,
      updated_at: now,
      handoff: null,
      messages: [],
    };

    if (!current.created_at) {
      current.created_at = now;
    }
    current.updated_at = now;
    current.messages = [...current.messages, ...normalizedEntries].slice(-MAX_CHAT_MESSAGES_PER_SESSION);

    const targetPath = sessionFilePath(paths, sessionId);
    if (!existing) {
      const firstUser = normalizedEntries.find((item) => item.role === "user");
      writeChatSessionLog("chat_session_started", contextSafe.req, identity, {
        route,
        mode,
        file: path.basename(targetPath),
        first_user_len: firstUser ? firstUser.content.length : 0,
        first_user_preview: firstUser ? firstUser.content.slice(0, 120) : "",
      });
    }
    await fs.writeFile(targetPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    return {
      session: current,
      appended: normalizedEntries,
    };
  });
}

async function submitUserMessage(paths, identity, content, clientMessageId, context = {}) {
  const sessionId = identity.session_id;
  const normalizedClientMessageId = normalizeClientMessageId(clientMessageId);
  if (!sessionId) {
    return null;
  }

  return enqueueSessionWrite(sessionId, async () => {
    const now = new Date().toISOString();
    const existing = await readChatSession(paths, sessionId);
    const current = existing || {
      session_id: sessionId,
      locale: chatLocale(context.locale),
      created_at: now,
      updated_at: now,
      handoff: null,
      messages: [],
    };
    if (normalizedClientMessageId) {
      const duplicate = current.messages.find(
        (item) => item.role === "user" && item.client_message_id === normalizedClientMessageId,
      );
      if (duplicate) {
        return {
          session: current,
          message: duplicate,
          duplicate: true,
        };
      }
    }

    const message = createChatMessage("user", content, {
      client_message_id: normalizedClientMessageId,
      ts: now,
    });
    if (!message) {
      return null;
    }
    current.updated_at = now;
    current.messages = [...current.messages, message].slice(-MAX_CHAT_MESSAGES_PER_SESSION);
    if (!existing) {
      writeChatSessionLog("chat_session_started", context.req, identity, {
        route: context.route || "-",
        mode: context.mode || "-",
        file: path.basename(sessionFilePath(paths, sessionId)),
        first_user_len: message.content.length,
        first_user_preview: message.content.slice(0, 120),
      });
    }
    await fs.writeFile(sessionFilePath(paths, sessionId), `${JSON.stringify(current, null, 2)}\n`, "utf8");
    return {
      session: current,
      message,
      duplicate: false,
    };
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

function isOpenTelegramHandoff(handoff) {
  return Boolean(handoff && handoff.channel === "telegram" && OPEN_HANDOFF_STATUSES.has(handoff.status));
}

async function readTelegramHandoff(paths, sessionId) {
  const session = await readChatSession(paths, sessionId);
  return session?.handoff?.channel === "telegram" ? session.handoff : null;
}

async function createTelegramHandoff(paths, sessionId) {
  return enqueueSessionWrite(sessionId, async () => {
    const session = await readChatSession(paths, sessionId);
    if (!session) {
      return null;
    }
    if (isOpenTelegramHandoff(session.handoff)) {
      return session.handoff;
    }

    const requestedAt = new Date().toISOString();
    session.handoff = {
      status: "pending_send",
      channel: "telegram",
      telegram_chat_id: "",
      telegram_message_ids: [],
      requested_at: requestedAt,
      updated_at: requestedAt,
      activated_at: "",
      closed_at: "",
      error: "",
    };
    session.updated_at = requestedAt;
    session.messages = [
      ...session.messages,
      { role: "handoff", content: chatHandoffText(session.locale, "requested"), ts: requestedAt },
    ].slice(-MAX_CHAT_MESSAGES_PER_SESSION);
    await fs.writeFile(sessionFilePath(paths, sessionId), `${JSON.stringify(session, null, 2)}\n`, "utf8");
    return session.handoff;
  });
}

async function updateTelegramHandoff(paths, sessionId, patch, eventText = "") {
  return enqueueSessionWrite(sessionId, async () => {
    const session = await readChatSession(paths, sessionId);
    if (!session?.handoff || session.handoff.channel !== "telegram") {
      return null;
    }

    const updatedAt = new Date().toISOString();
    session.handoff = normalizeStoredHandoff({
      ...session.handoff,
      ...patch,
      channel: "telegram",
      updated_at: updatedAt,
    });
    session.updated_at = updatedAt;
    if (eventText) {
      session.messages = [
        ...session.messages,
        { role: "handoff", content: eventText, ts: updatedAt },
      ].slice(-MAX_CHAT_MESSAGES_PER_SESSION);
    }
    await fs.writeFile(sessionFilePath(paths, sessionId), `${JSON.stringify(session, null, 2)}\n`, "utf8");
    return session.handoff;
  });
}

async function addTelegramHandoffMessageId(paths, sessionId, messageId) {
  if (!messageId) {
    return null;
  }

  return enqueueSessionWrite(sessionId, async () => {
    const session = await readChatSession(paths, sessionId);
    if (!session?.handoff || session.handoff.channel !== "telegram") {
      return null;
    }

    const messageIds = [...session.handoff.telegram_message_ids];
    if (messageIds.includes(messageId)) {
      return session.handoff;
    }

    const updatedAt = new Date().toISOString();
    session.handoff = normalizeStoredHandoff({
      ...session.handoff,
      telegram_message_ids: [...messageIds, messageId],
      updated_at: updatedAt,
    });
    session.updated_at = updatedAt;
    await fs.writeFile(sessionFilePath(paths, sessionId), `${JSON.stringify(session, null, 2)}\n`, "utf8");
    return session.handoff;
  });
}

async function activateTelegramHandoff(paths, sessionId, chatId, replyToMessageId) {
  const session = await readChatSession(paths, sessionId);
  const handoff = session?.handoff?.channel === "telegram" ? session.handoff : null;
  if (
    !isOpenTelegramHandoff(handoff) ||
    handoff.telegram_chat_id !== String(chatId) ||
    !handoff.telegram_message_ids.includes(replyToMessageId)
  ) {
    return null;
  }
  if (handoff.status === "active") {
    return handoff;
  }

  const updated = await updateTelegramHandoff(
    paths,
    sessionId,
    {
      status: "active",
      activated_at: handoff.activated_at || new Date().toISOString(),
    },
    chatHandoffText(session.locale, "started"),
  );
  if (!updated) {
    return null;
  }
  const refreshed = await readChatSession(paths, sessionId);
  const systemMessage = refreshed?.messages.at(-1);
  return {
    ...updated,
    system_message: systemMessage?.role === "handoff" ? systemMessage : null,
  };
}

async function closeTelegramHandoff(paths, sessionId) {
  return updateTelegramHandoff(
    paths,
    sessionId,
    {
      status: "closed",
      closed_at: new Date().toISOString(),
    },
  );
}

function renderHandoffTranscript(messages) {
  const items = Array.isArray(messages) ? messages.slice(-HANDOFF_TRANSCRIPT_LIMIT) : [];
  if (items.length === 0) {
    return "(no messages)";
  }

  return items
    .map((item) => {
      const content = truncateText(normalizeChatContent(item?.content || ""), HANDOFF_MESSAGE_MAX_CHARS);
      return content ? `${handoffRoleLabel(item?.role)}: ${content}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

async function notifyTelegramHandoff(cwd, config, paths, sessionId) {
  if (!hasTelegramChannel(config)) {
    return null;
  }

  const existing = await readTelegramHandoff(paths, sessionId);
  if (isOpenTelegramHandoff(existing)) {
    return existing;
  }

  const handoff = await createTelegramHandoff(paths, sessionId);
  if (!handoff) {
    return null;
  }
  const history = await loadChatHistory(paths, sessionId, HANDOFF_TRANSCRIPT_LIMIT);
  const transcript = truncateText(renderHandoffTranscript(history), HANDOFF_TELEGRAM_TRANSCRIPT_MAX_CHARS);
  const message = [
    "OpenVila human support requested",
    `Session: ${sessionId}`,
    "Reply to this message to answer the visitor. Reply /close to end manual support.",
    "",
    "Recent conversation:",
    transcript,
  ].join("\n");

  try {
    const sent = await sendTelegramMessage(config, message);
    if (!sent.message_id) {
      throw new Error("Telegram did not return a message ID");
    }
    const notified = await updateTelegramHandoff(paths, sessionId, {
      status: "waiting_owner",
      telegram_chat_id: String(config.channels.telegram.chat_id),
      telegram_message_ids: [sent.message_id],
      error: "",
    });
    await addTelegramReplyMapping(cwd, config.channels.telegram.chat_id, sent.message_id, sessionId);
    writeGlobalLog(
      `[telegram] handoff notification sent\nsession_id: ${sanitizeLogField(sessionId)}\nmessage_id: ${sanitizeLogField(sent.message_id)}\ntranscript_length: ${transcript.length}`,
    );
    return notified;
  } catch (error) {
    const session = await readChatSession(paths, sessionId);
    await updateTelegramHandoff(paths, sessionId, {
      status: "notify_failed",
      error: error.message,
    }, chatHandoffText(session?.locale, "notification_failed")).catch(() => undefined);
    writeGlobalLog(`[telegram] handoff notification failed\nsession_id: ${sanitizeLogField(sessionId)}\nerror: ${sanitizeLogField(error.message)}`);
    return null;
  }
}

async function forwardVisitorMessageToTelegram(cwd, config, sessionId, message) {
  const handoff = await readTelegramHandoff(runtimePaths(cwd), sessionId);
  const replyToMessageId = handoff?.telegram_message_ids?.[0];
  if (!isOpenTelegramHandoff(handoff) || !replyToMessageId) {
    return null;
  }

  try {
    const sent = await sendTelegramMessage(config, `Visitor:\n${truncateText(message, 3600)}`, { replyToMessageId });
    if (sent.message_id) {
      const updated = await addTelegramHandoffMessageId(runtimePaths(cwd), sessionId, sent.message_id);
      if (!updated) {
        throw new Error("Telegram handoff is no longer available");
      }
      await addTelegramReplyMapping(cwd, config.channels.telegram.chat_id, sent.message_id, sessionId);
    }
    writeGlobalLog(
      `[telegram] handoff visitor message forwarded\nsession_id: ${sanitizeLogField(sessionId)}\nmessage_length: ${message.length}\nvisitor_message:\n${fullLogText(message)}\ndelivered: true`,
    );
    return { handoff, delivered: true };
  } catch (error) {
    writeGlobalLog(`[telegram] handoff visitor message failed\nsession_id: ${sanitizeLogField(sessionId)}\nerror: ${sanitizeLogField(error.message)}`);
    return { handoff, delivered: false };
  }
}

async function replyDuringHumanSupport(cwd, config, paths, identity, message, req, route) {
  void req;
  void route;
  const forwarded = await forwardVisitorMessageToTelegram(cwd, config, identity.session_id, message);
  if (!forwarded) {
    return null;
  }

  const session = await readChatSession(paths, identity.session_id);
  const answer = chatHandoffText(session?.locale, forwarded.delivered ? "forwarded" : "unavailable");
  return answer;
}

async function requestHumanSupport(cwd, config, paths, identity, message, req, route) {
  writeGlobalLog(
    `[chat] human support requested\nsession_id: ${sanitizeLogField(identity.session_id)}\nmessage_length: ${message.length}\nvisitor_message:\n${fullLogText(message)}\nroute: ${sanitizeLogField(route)}`,
  );
  const handoff = await notifyTelegramHandoff(cwd, config, paths, identity.session_id);
  const session = await readChatSession(paths, identity.session_id);
  const systemMessage = session?.messages.at(-1);
  const answer = chatHandoffText(session?.locale, handoff ? "request_sent" : "unavailable");
  writeGlobalLog(
    `[chat] human support handoff result\nsession_id: ${sanitizeLogField(identity.session_id)}\nstatus: ${sanitizeLogField(handoff?.status || "unavailable")}`,
  );

  if (config.channels?.feishu?.webhook) {
    await notifyChannels(
      {
        ...config,
        channels: { telegram: null, feishu: config.channels.feishu },
      },
      `OpenVila human support requested\n- message: ${message.slice(0, 400)}`,
    ).catch(() => undefined);
  }

  return { answer, handoff, system_message: systemMessage?.role === "handoff" ? systemMessage : null };
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

function handoffRoleLabel(role) {
  if (role === "user") {
    return "Visitor";
  }
  if (role === "support") {
    return "Owner";
  }
  if (role === "handoff") {
    return "System";
  }
  return "Vila";
}

function getAuthToken(req) {
  const auth = req.headers.authorization || "";
  const matched = auth.match(/^bearer\s+(.+)$/i);
  return matched ? matched[1] : null;
}

function truncateText(value, maxChars) {
  const text = String(value || "");
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    return text;
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n...[truncated]`;
}

function extractFrequentSection(indexMarkdown) {
  const raw = String(indexMarkdown || "");
  if (!raw.trim()) {
    return "";
  }

  const startTitle = "## Frequent Customer Concerns";
  const endTitle = "## All Documents";
  const start = raw.indexOf(startTitle);
  if (start < 0) {
    return "";
  }

  const fromStart = raw.slice(start);
  const endOffset = fromStart.indexOf(endTitle);
  const section = endOffset >= 0 ? fromStart.slice(0, endOffset) : fromStart;
  return truncateText(section.trim(), DOC_SELECT_FREQUENT_SECTION_MAX_CHARS);
}

function renderDocSelectHistory(chatHistory, limit = DOC_SELECT_HISTORY_LIMIT) {
  const items = Array.isArray(chatHistory) ? chatHistory.slice(-limit) : [];
  if (items.length === 0) {
    return "(none)";
  }

  return items
    .map((item) => {
      let role = "user";
      if (item?.role === "handoff") {
        role = "system";
      } else if (["assistant", "support", "system"].includes(item?.role)) {
        role = item.role;
      }
      const content = normalizeChatContent(item?.content || "");
      if (!content) {
        return null;
      }
      const preview =
        content.length > DOC_SELECT_HISTORY_ITEM_MAX_CHARS
          ? `${content.slice(0, DOC_SELECT_HISTORY_ITEM_MAX_CHARS)}...`
          : content;
      return `[${role}] ${preview}`;
    })
    .filter(Boolean)
    .join("\n");
}

async function selectDocs(cwd, config, index, question, chatHistory = []) {
  void cwd;
  const map = index.index_map || {};
  const entries = Object.entries(map);
  const listing = entries
    .slice(0, 220)
    .map(([source, item]) => `${item.doc_path} | ${source} | ${(item.tags || []).join(",")} | ${item.summary}`)
    .join("\n");
  const historyText = renderDocSelectHistory(chatHistory, DOC_SELECT_HISTORY_LIMIT);

  const frequentContext = extractFrequentSection(index.index_markdown || "");
  const frequentText = frequentContext || "(none)";
  const listingText = listing || "(none)";
  const messages = [
    {
      role: "system",
      content:
        "You are a retrieval planner and optional direct responder. Return JSON only with this schema: {\"can_answer_directly\":boolean,\"confidence\":number,\"direct_answer\":\"\",\"doc_paths\":[\"docs/...md\"]}. Rules: (1) If this is small talk (for example greeting/thanks/goodbye), set can_answer_directly=true and provide a short, polite direct_answer in the user's language, with doc_paths=[]. (2) If the user's question can be answered confidently and completely using Frequent Customer Concerns context, set can_answer_directly=true, provide direct_answer in the user's language, and doc_paths=[]. (3) Otherwise set can_answer_directly=false, keep direct_answer empty, and choose at most 4 doc_paths from the document index list. (4) If Frequent Customer Concerns and document index are both empty and this is not small talk, set can_answer_directly=false with doc_paths=[].",
    },
    {
      role: "user",
      content: `Question:\n${question}\n\nRecent chat history:\n${historyText}\n\nFrequent Customer Concerns context:\n${frequentText}\n\nDocument index:\n${listingText}`,
    },
  ];

  const picked = await chatCompletion(config, messages, { temperature: 0, maxTokens: 1100, trace: "chat:doc_select" });
  if (picked.ok) {
    const maybe = extractJsonObject(picked.content);
    const canAnswerDirectly = Boolean(maybe?.can_answer_directly);
    const directAnswer = String(maybe?.direct_answer || "").trim();
    const confidenceRaw = Number(maybe?.confidence);
    const confidence = Number.isFinite(confidenceRaw) ? confidenceRaw : 0;
    if (canAnswerDirectly && directAnswer && confidence >= DOC_SELECT_DIRECT_ANSWER_MIN_CONFIDENCE) {
      return {
        mode: "direct",
        direct_answer: directAnswer,
        confidence,
      };
    }

    if (maybe && Array.isArray(maybe.doc_paths)) {
      const available = new Set(entries.map(([, item]) => item.doc_path));
      const finalPaths = maybe.doc_paths.filter((p) => available.has(p)).slice(0, 4);
      if (finalPaths.length > 0) {
        return {
          mode: "docs",
          doc_paths: finalPaths,
        };
      }
    }
  }

  return {
    mode: "docs",
    doc_paths: entries.slice(0, 4).map(([, item]) => item.doc_path).filter(Boolean),
  };
}

// 核心逻辑！分两步调用LLM。
async function answerFromKnowledge(cwd, config, message, chatHistory = [], options = {}) {
  const onDelta = typeof options.onDelta === "function" ? options.onDelta : () => undefined;
  const index = await loadKnowledgeIndex(cwd);
  const paths = runtimePaths(cwd);
  const indexMarkdown = (await readTextSafe(paths.knowledgeIndex)) || "";
  if (indexMarkdown) {
    index.index_markdown = indexMarkdown;
  }
  const map = index.index_map || {};
  const entries = Object.entries(map);

  //
  // 1. 选择文档：基于用户问题和知识库索引，选择最相关的文档路径；如果是打招呼等Small Talk或者能命中索引文档中的Frequent Customer Concerns部分，则直接返回，减少用户等待时间。
  // e.g,
  // - {"doc_paths":["docs/fs-pricing-html.md","docs/fs-faq-html.md","docs/fs-user-agreement-html.md"]}
  //
  const docSelection = await selectDocs(cwd, config, index, message, chatHistory);
  if (docSelection.mode === "direct" && docSelection.direct_answer) {
    onDelta(docSelection.direct_answer);
    return {
      ok: true,
      answer: docSelection.direct_answer,
      doc_paths: [],
      answered_by: "doc_select",
    };
  }

  if (entries.length === 0) {
    return {
      ok: false,
      error: "Knowledge base is empty. Run /scan first.",
    };
  }

  const docPaths = Array.isArray(docSelection.doc_paths) ? docSelection.doc_paths : [];
  const selectedDocs = await loadDocContents(cwd, docPaths);

  //
  // 2. 生成答案：将用户问题、知识库索引和选中文档内容一起发送给语言模型，生成基于知识库的回答。
  //
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
        "You are assistant for site owners. Use knowledge index first, then selected documents. If unsure, say what information is missing. Reply in the same language as user input.",
    },
    {
      role: "user",
      content: `User question:\n${message}\n\nKnowledge index:\n${indexText}\n\nSelected documents:\n${docsText}`,
    },
  ];

  const completion = await chatCompletionStream(config, messages, {
    temperature: 0.35,
    maxTokens: 900,
    trace: "chat:answer",
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
  const chatEventSubscribers = new Map();

  function removeChatEventSubscriber(sessionId, subscriber) {
    const subscribers = chatEventSubscribers.get(sessionId);
    if (!subscribers || !subscribers.delete(subscriber)) {
      return;
    }
    clearInterval(subscriber.heartbeat);
    if (subscribers.size === 0) {
      chatEventSubscribers.delete(sessionId);
    }
  }

  function addChatEventSubscriber(sessionId, req, res) {
    const subscribers = chatEventSubscribers.get(sessionId) || new Set();
    const subscriber = {
      res,
      heartbeat: setInterval(() => {
        try {
          if (res.writableEnded) {
            removeChatEventSubscriber(sessionId, subscriber);
            return;
          }
          res.write(": keep-alive\n\n");
        } catch {
          removeChatEventSubscriber(sessionId, subscriber);
        }
      }, SSE_HEARTBEAT_INTERVAL_MS),
    };
    subscribers.add(subscriber);
    chatEventSubscribers.set(sessionId, subscribers);

    const remove = () => removeChatEventSubscriber(sessionId, subscriber);
    req.once("close", remove);
    res.once("close", remove);
    return subscriber;
  }

  function publishChatEvent(sessionId, eventName, payload) {
    const subscribers = chatEventSubscribers.get(sessionId);
    if (!subscribers) {
      return;
    }
    for (const subscriber of subscribers) {
      if (subscriber.res.writableEnded) {
        removeChatEventSubscriber(sessionId, subscriber);
        continue;
      }
      try {
        writeSseEvent(subscriber.res, eventName, payload);
      } catch {
        removeChatEventSubscriber(sessionId, subscriber);
      }
    }
  }

  function closeChatEventSubscribers() {
    for (const [sessionId, subscribers] of chatEventSubscribers) {
      for (const subscriber of subscribers) {
        clearInterval(subscriber.heartbeat);
        subscriber.res.end();
      }
      chatEventSubscribers.delete(sessionId);
    }
  }

  async function appendAndPublish(identity, entries, context = {}) {
    const result = await appendChatMessages(paths, identity, entries, context);
    for (const message of result?.appended || []) {
      publishChatEvent(identity.session_id, "message", message);
    }
    return result;
  }

  async function appendAssistantReply(identity, content, context = {}, messageOptions = {}) {
    return appendAndPublish(identity, [{ ...messageOptions, role: "assistant", content }], context);
  }

  async function ensureChatWelcome(identity, req, route, visitorLocale = "") {
    const content = chatWelcomeMessage(config, visitorLocale);
    if (!content) {
      return null;
    }
    return appendAssistantReply(identity, content, { req, route, mode: "welcome", locale: visitorLocale, onlyIfNew: true });
  }

  async function processSubmittedMessage(identity, userMessage, req, route) {
    const message = userMessage.content;
    const manualSupportAnswer = await replyDuringHumanSupport(cwd, config, paths, identity, message, req, route);
    if (manualSupportAnswer) {
      await appendAssistantReply(identity, manualSupportAnswer, { req, route, mode: "human_support" });
      return;
    }

    const actionReq = parseActionRequest(message);
    if (actionReq) {
      const actions = await listActions(cwd);
      if (!actions.includes(actionReq.actionName)) {
        await appendAssistantReply(identity, `Action ${actionReq.actionName} does not exist.`, { req, route, mode: "action" });
        return;
      }

      const queued = await queueActionReview(cwd, actionReq.actionName, actionReq.payload, {
        source: "chat",
        remote: req?.socket?.remoteAddress,
      });
      const notifyText = `OpenVila action pending approval\n- id: ${queued.id}\n- action: ${queued.action}`;
      await notifyChannels(config, notifyText).catch(() => undefined);
      const actionAnswerText = `Action request submitted for owner approval. request_id=${queued.id}`;
      await appendAssistantReply(identity, actionAnswerText, { req, route, mode: "action" });
      return;
    }

    if (isHumanSupportRequest(message)) {
      const support = await requestHumanSupport(cwd, config, paths, identity, message, req, route);
      if (support.system_message) {
        publishChatEvent(identity.session_id, "message", support.system_message);
      }
      await appendAssistantReply(identity, support.answer, { req, route, mode: "human_support" });
      return;
    }

    const recentHistory = (await loadChatHistory(paths, identity.session_id, DOC_SELECT_HISTORY_LIMIT + 1))
      .filter((item) => item.id !== userMessage.id)
      .slice(-DOC_SELECT_HISTORY_LIMIT);
    const answerMessageId = crypto.randomUUID();
    const answer = await answerFromKnowledge(cwd, config, message, recentHistory, {
      onDelta: (delta) => {
        publishChatEvent(identity.session_id, "delta", {
          id: answerMessageId,
          role: "assistant",
          delta: String(delta || ""),
        });
      },
    });
    const answerText = answer.ok
      ? answer.answer
      : `Service temporarily unavailable: ${answer.error}`;
    await appendAssistantReply(
      identity,
      answerText,
      { req, route, mode: "knowledge_answer" },
      { id: answerMessageId },
    );
  }

  function queueSubmittedMessage(identity, message, clientMessageId, req, route, visitorLocale) {
    const task = enqueueSessionProcess(identity.session_id, async () => {
      await ensureChatWelcome(identity, req, route, visitorLocale);
      const submitted = await submitUserMessage(paths, identity, message, clientMessageId, {
        req,
        route,
        mode: "chat",
        locale: visitorLocale,
      });
      if (!submitted || submitted.duplicate) {
        return;
      }

      publishChatEvent(identity.session_id, "message", submitted.message);
      try {
        await processSubmittedMessage(identity, submitted.message, req, route);
      } catch (error) {
        writeGlobalLog(
          `[chat] message processing failed\nsession_id: ${sanitizeLogField(identity.session_id)}\nerror: ${sanitizeLogField(error.message)}`,
        );
        await appendAssistantReply(identity, `Service temporarily unavailable: ${error.message}`, {
          req,
          route,
          mode: "chat_error",
        });
      }
    });
    task.catch(() => undefined);
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        sendJson(res, 400, { error: "Missing URL" });
        return;
      }

      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const corsAllowed = allowSameHostCors(req, res);

      if (req.method === "OPTIONS") {
        if (req.headers.origin && !corsAllowed) {
          sendJson(res, 403, { error: "Cross-host CORS is not allowed" });
          return;
        }
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, { ok: true, service: "openvila", time: new Date().toISOString() });
        return;
      }

      if (req.method === "GET" && url.pathname === "/widget") {
        const content = (await readTextSafe(paths.widget)) || "<h1>Widget preview is unavailable. Run /run first.</h1>";
        const serviceHost = String(req.headers.host || `127.0.0.1:${port}`);
        const serviceUrl = new URL(`http://${serviceHost}`);
        const widgetUrl = new URL("/openvila/widget.js", serviceUrl);
        widgetUrl.searchParams.set("host", serviceUrl.hostname);
        widgetUrl.searchParams.set("port", serviceUrl.port || String(port));
        widgetUrl.searchParams.set("color", "#0f766e");
        const embedUrl = new URL("/openvila/widget.js", serviceUrl);
        embedUrl.searchParams.set("color", "#0f766e");
        const escapedWidgetUrl = widgetUrl.toString().replace(/&/g, "&amp;").replace(/"/g, "&quot;");
        const escapedEmbedUrl = embedUrl.toString().replace(/&/g, "&amp;").replace(/"/g, "&quot;");
        const preview = content
          .replaceAll("{{OPENVILA_WIDGET_URL}}", escapedWidgetUrl)
          .replaceAll("{{OPENVILA_EMBED_SNIPPET}}", `&lt;script src=&quot;${escapedEmbedUrl}&quot; defer&gt;&lt;/script&gt;`);
        sendText(res, 200, preview, "text/html; charset=utf-8");
        return;
      }

      if (req.method === "GET" && url.pathname === "/openvila/widget.js") {
        if (!(await exists(paths.widgetScript))) {
          sendText(res, 404, "Widget script not found. Run /run first.\n");
          return;
        }
        const js = await fs.readFile(paths.widgetScript, "utf8");
        sendText(res, 200, js, "application/javascript; charset=utf-8");
        return;
      }

      if (req.method === "GET" && url.pathname === `${CHAT_API_PATH}/history`) {
        const identity = resolveChatIdentity({
          session_id: url.searchParams.get("session_id") || "",
        });
        const limit = parseHistoryLimit(url.searchParams.get("limit"));
        const visitorLocale = url.searchParams.get("locale") || "";
        if (!identity.session_id) {
          sendJson(res, 400, { error: "session_id is required" });
          return;
        }

        await ensureChatWelcome(identity, req, `${CHAT_API_PATH}/history`, visitorLocale);
        const messages = await loadChatHistory(paths, identity.session_id, limit);
        sendJson(res, 200, {
          ok: true,
          session_id: identity.session_id,
          messages,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === `${CHAT_API_PATH}/events`) {
        const identity = resolveChatIdentity({
          session_id: url.searchParams.get("session_id") || "",
        });
        if (!identity.session_id) {
          sendJson(res, 400, { error: "session_id is required" });
          return;
        }

        openSseStream(res);
        addChatEventSubscriber(identity.session_id, req, res);
        writeSseEvent(res, "ready", { session_id: identity.session_id });
        return;
      }

      if (req.method === "POST" && url.pathname === CHAT_API_PATH) {
        const body = await parseBody(req);
        const message = String(body.message || "").trim();
        const visitorLocale = String(body.locale || "").trim();
        const identity = resolveChatIdentity(body);

        if (!message || !identity.session_id) {
          sendJson(res, 400, { error: !message ? "message is required" : "session_id is required" });
          return;
        }

        const clientMessageId = normalizeClientMessageId(body.client_message_id) || crypto.randomUUID();
        queueSubmittedMessage(identity, message, clientMessageId, req, CHAT_API_PATH, visitorLocale);
        sendJson(res, 202, {
          ok: true,
          accepted: true,
          session_id: identity.session_id,
          client_message_id: clientMessageId,
        });
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
          res.end();
        } catch {
          // Ignore response-close errors on broken connections.
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

  const telegramPolling = startTelegramHandoffPolling(cwd, config, {
    onReply: async (sessionId, chatId, replyToMessageId, text) => {
      const handoff = await activateTelegramHandoff(paths, sessionId, chatId, replyToMessageId);
      if (!handoff) {
        return;
      }
      if (handoff.system_message) {
        publishChatEvent(sessionId, "message", handoff.system_message);
      }
      const identity = { session_id: sessionId };
      const appended = await appendChatMessages(paths, identity, [{ role: "support", content: text }], {
        route: "telegram",
        mode: "human_support",
      });
      const message = appended?.appended?.[0];
      if (message?.role === "support") {
        publishChatEvent(sessionId, "message", message);
      }
      writeGlobalLog(`[telegram] handoff reply\nsession_id: ${sanitizeLogField(sessionId)}\nmessage_length: ${text.length}`);
    },
    onClose: async (sessionId, chatId, replyToMessageId) => {
      const handoff = await activateTelegramHandoff(paths, sessionId, chatId, replyToMessageId);
      if (!handoff) {
        return;
      }
      if (handoff.system_message) {
        publishChatEvent(sessionId, "message", handoff.system_message);
      }
      const session = await readChatSession(paths, sessionId);
      const closed = await closeTelegramHandoff(paths, sessionId);
      if (!closed) {
        return;
      }
      const identity = { session_id: sessionId };
      const appended = await appendChatMessages(paths, identity, [
        { role: "handoff", content: chatHandoffText(session?.locale, "closed") },
      ], {
        route: "telegram",
        mode: "human_support_closed",
      });
      const message = appended?.appended?.[0];
      if (message?.role === "handoff") {
        publishChatEvent(sessionId, "message", message);
      }
      writeGlobalLog(`[telegram] handoff closed\nsession_id: ${sanitizeLogField(sessionId)}`);
    },
  });

  return {
    port,
    owner_token: config.run.owner_token,
    telegram_polling: telegramPolling.enabled,
    close: async () => {
      await telegramPolling.close();
      closeChatEventSubscribers();
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
