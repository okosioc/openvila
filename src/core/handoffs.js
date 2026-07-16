import { getTelegramUpdates, hasTelegramChannel } from "./channels.js";
import { writeGlobalLog } from "./logging.js";
import { ensureRuntime, runtimePaths } from "./runtime.js";
import { readTextSafe, writeText } from "../utils/fs.js";

const telegramStateWriteQueues = new Map();

function telegramReplyMapKey(chatId, messageId) {
  return `${String(chatId)}:${String(messageId)}`;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function enqueueTelegramStateWrite(cwd, task) {
  const previous = telegramStateWriteQueues.get(cwd) || Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(task)
    .finally(() => {
      if (telegramStateWriteQueues.get(cwd) === current) {
        telegramStateWriteQueues.delete(cwd);
      }
    });
  telegramStateWriteQueues.set(cwd, current);
  return current;
}

async function loadTelegramState(cwd) {
  const paths = await ensureRuntime(cwd);
  const raw = await readTextSafe(paths.telegramState);
  try {
    const parsed = JSON.parse(raw || "{}");
    const lastUpdateId = Number(parsed?.last_update_id);
    const replyMap = parsed?.reply_map && typeof parsed.reply_map === "object" && !Array.isArray(parsed.reply_map) ? parsed.reply_map : {};
    return {
      last_update_id: Number.isFinite(lastUpdateId) ? lastUpdateId : 0,
      reply_map: Object.fromEntries(
        Object.entries(replyMap)
          .filter(([key, value]) => key && typeof value === "string" && value)
          .map(([key, value]) => [key, value]),
      ),
    };
  } catch {
    return { last_update_id: 0, reply_map: {} };
  }
}

async function saveTelegramState(cwd, state) {
  const paths = runtimePaths(cwd);
  await writeText(paths.telegramState, `${JSON.stringify(state, null, 2)}\n`);
}

async function updateTelegramState(cwd, update) {
  return enqueueTelegramStateWrite(cwd, async () => {
    const state = await loadTelegramState(cwd);
    const next = await update(state);
    await saveTelegramState(cwd, next);
    return next;
  });
}

export async function addTelegramReplyMapping(cwd, chatId, messageId, sessionId) {
  if (!messageId || !sessionId) {
    return;
  }

  await updateTelegramState(cwd, (state) => ({
    ...state,
    reply_map: {
      ...state.reply_map,
      [telegramReplyMapKey(chatId, messageId)]: sessionId,
    },
  }));
}

async function findTelegramReplySession(cwd, chatId, messageId) {
  if (!messageId) {
    return "";
  }
  const state = await loadTelegramState(cwd);
  return String(state.reply_map[telegramReplyMapKey(chatId, messageId)] || "");
}

export function startTelegramHandoffPolling(cwd, config, handlers = {}) {
  if (!hasTelegramChannel(config)) {
    return {
      enabled: false,
      close: async () => undefined,
    };
  }

  let stopped = false;
  let controller = null;
  const onReply = typeof handlers.onReply === "function" ? handlers.onReply : async () => undefined;
  const onClose = typeof handlers.onClose === "function" ? handlers.onClose : async () => undefined;

  const task = (async () => {
    const initialState = await loadTelegramState(cwd);
    let lastUpdateId = initialState.last_update_id;
    while (!stopped) {
      controller = new AbortController();
      try {
        const updates = await getTelegramUpdates(config, lastUpdateId + 1, {
          timeoutSeconds: 25,
          signal: controller.signal,
        });
        for (const update of updates) {
          const updateId = Number(update?.update_id);
          if (!Number.isFinite(updateId) || updateId <= lastUpdateId) {
            continue;
          }

          const message = update?.message;
          const chatId = message?.chat?.id;
          const replyToMessageId = message?.reply_to_message?.message_id;
          const text = String(message?.text || "").trim();
          if (String(chatId) === String(config.channels.telegram.chat_id) && replyToMessageId && text) {
            const sessionId = await findTelegramReplySession(cwd, chatId, replyToMessageId);
            if (sessionId) {
              if (text === "/close") {
                await onClose(sessionId, chatId, replyToMessageId, message);
              } else {
                await onReply(sessionId, chatId, replyToMessageId, text, message);
              }
            }
          }

          lastUpdateId = updateId;
          await updateTelegramState(cwd, (state) => ({
            ...state,
            last_update_id: Math.max(state.last_update_id, lastUpdateId),
          }));
        }
      } catch (error) {
        if (!stopped && error?.name !== "AbortError") {
          writeGlobalLog(`[telegram] polling failed\nerror: ${String(error?.message || error)}`);
          await wait(1000);
        }
      } finally {
        controller = null;
      }
    }
  })();

  return {
    enabled: true,
    close: async () => {
      stopped = true;
      controller?.abort();
      await task.catch(() => undefined);
    },
  };
}
