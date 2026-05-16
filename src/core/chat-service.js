import fs from "node:fs/promises";
import http from "node:http";
import { URL } from "node:url";
import { approveReviewItem, listActions, listReviewQueue, queueActionReview, rejectReviewItem } from "./actions.js";
import { notifyChannels } from "./channels.js";
import { extractJsonObject, chatCompletion } from "./llm.js";
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

export async function startChatService(cwd, config, options = {}) {
  await ensureRuntime(cwd);
  const paths = runtimePaths(cwd);
  const port = Number(options.port || config.run.port || 3800);

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

      if (req.method === "POST" && url.pathname === "/chat") {
        const body = await parseBody(req);
        const message = String(body.message || "").trim();

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

          sendJson(res, 200, {
            ok: true,
            answer: `Action request submitted for owner approval. request_id=${queued.id}`,
            request_id: queued.id,
            status: queued.status,
          });
          return;
        }

        if (isHumanSupportRequest(message)) {
          const notifyText = `OpenVila human support requested\n- message: ${message.slice(0, 400)}`;
          await notifyChannels(config, notifyText).catch(() => undefined);
          sendJson(res, 200, {
            ok: true,
            answer: "Your request has been forwarded to the owner. Please wait for manual support.",
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

        sendJson(res, 200, {
          ok: true,
          answer: answer.answer,
          doc_paths: answer.doc_paths,
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
