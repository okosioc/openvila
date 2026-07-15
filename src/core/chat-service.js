import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { approveReviewItem, listActions, listReviewQueue, queueActionReview, rejectReviewItem } from "./actions.js";
import { notifyChannels } from "./channels.js";
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
const DOC_SELECT_HISTORY_LIMIT = 20;
const DOC_SELECT_HISTORY_ITEM_MAX_CHARS = 400;
const DOC_SELECT_FREQUENT_SECTION_MAX_CHARS = 180000;
const DOC_SELECT_DIRECT_ANSWER_MIN_CONFIDENCE = 0.85;
const chatWriteQueues = new Map();
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
  return {
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
    created_at: typeof parsed.created_at === "string" && parsed.created_at ? parsed.created_at : "",
    updated_at: typeof parsed.updated_at === "string" && parsed.updated_at ? parsed.updated_at : "",
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
    const existing = await readChatSession(paths, sessionId);
    const current = existing || {
      session_id: sessionId,
      created_at: now,
      updated_at: now,
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
      const role = item?.role === "assistant" ? "assistant" : item?.role === "system" ? "system" : "user";
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

async function answerFromKnowledge(cwd, config, message, chatHistory = []) {
  const index = await loadKnowledgeIndex(cwd);
  const paths = runtimePaths(cwd);
  const indexMarkdown = (await readTextSafe(paths.knowledgeIndex)) || "";
  if (indexMarkdown) {
    index.index_markdown = indexMarkdown;
  }
  const map = index.index_map || {};
  const entries = Object.entries(map);

  //
  // 1. 选择文档：基于用户问题和知识库索引，选择最相关的文档路径。
  // e.g,
  // - {"doc_paths":["docs/fs-pricing-html.md","docs/fs-faq-html.md","docs/fs-user-agreement-html.md"]}
  //
  const docSelection = await selectDocs(cwd, config, index, message, chatHistory);
  if (docSelection.mode === "direct" && docSelection.direct_answer) {
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

// 核心逻辑! 通过知识库索引选择相关文档，并基于索引和文档内容生成答案，同时支持流式返回增量结果和状态更新。
async function answerFromKnowledgeStream(cwd, config, message, chatHistory = [], handlers = {}) {
  const onDelta = typeof handlers.onDelta === "function" ? handlers.onDelta : () => undefined;
  const onStatus = typeof handlers.onStatus === "function" ? handlers.onStatus : () => undefined;
  const index = await loadKnowledgeIndex(cwd);
  const paths = runtimePaths(cwd);
  const indexMarkdown = (await readTextSafe(paths.knowledgeIndex)) || "";
  if (indexMarkdown) {
    index.index_markdown = indexMarkdown;
  }
  const map = index.index_map || {};
  const entries = Object.entries(map);

  onStatus("...");
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
        });
        const limit = parseHistoryLimit(url.searchParams.get("limit"));
        if (!identity.session_id) {
          sendJson(res, 400, { error: "session_id is required" });
          return;
        }

        const messages = await loadChatHistory(paths, identity.session_id, limit);
        sendJson(res, 200, {
          ok: true,
          session_id: identity.session_id,
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
          ], {
            req,
            route: "/chat",
            mode: "action",
          }).catch(() => undefined);

          sendJson(res, 200, {
            ok: true,
            answer: actionAnswerText,
            request_id: queued.id,
            status: queued.status,
            session_id: identity.session_id,
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
          ], {
            req,
            route: "/chat",
            mode: "human_support",
          }).catch(() => undefined);
          sendJson(res, 200, {
            ok: true,
            answer: supportAnswerText,
            session_id: identity.session_id,
          });
          return;
        }

        const recentHistory = await loadChatHistory(paths, identity.session_id, DOC_SELECT_HISTORY_LIMIT);
        const answer = await answerFromKnowledge(cwd, config, message, recentHistory);
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
        ], {
          req,
          route: "/chat",
          mode: "knowledge_answer",
        }).catch(() => undefined);

        sendJson(res, 200, {
          ok: true,
          answer: answer.answer,
          doc_paths: answer.doc_paths,
          session_id: identity.session_id,
        });
        return;
      }

      // 核心逻辑! 聊天接口, 支持流式返回增量结果和状态更新，同时处理基于知识库的问答、动作请求和人工支持请求。
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
          ], {
            req,
            route: "/chat/stream",
            mode: "action",
          }).catch(() => undefined);

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
          ], {
            req,
            route: "/chat/stream",
            mode: "human_support",
          }).catch(() => undefined);
          writeNdjsonLine(res, {
            type: "delta",
            text: supportAnswerText,
          });
          writeNdjsonLine(res, {
            type: "done",
            ok: true,
            session_id: identity.session_id,
          });
          res.end();
          return;
        }

        const recentHistory = await loadChatHistory(paths, identity.session_id, DOC_SELECT_HISTORY_LIMIT);
        const answer = await answerFromKnowledgeStream(cwd, config, message, recentHistory, {
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
        ], {
          req,
          route: "/chat/stream",
          mode: "knowledge_answer",
        }).catch(() => undefined);

        writeNdjsonLine(res, {
          type: "done",
          ok: true,
          answer: answer.answer,
          doc_paths: answer.doc_paths,
          session_id: identity.session_id,
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
