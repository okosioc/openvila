async function postJson(url, body, options = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.description || `HTTP ${response.status}`);
  }
  return payload;
}

function telegramApiUrl(config, method) {
  const endpoint = String(config.channels?.telegram?.endpoint || "https://api.telegram.org")
    .trim()
    .replace(/\/+$/, "");
  const botToken = String(config.channels?.telegram?.bot_token || "").trim();
  if (!botToken) {
    throw new Error("Telegram is not configured");
  }
  return `${endpoint}/bot${botToken}/${method}`;
}

export function hasTelegramChannel(config) {
  return Boolean(config.channels?.telegram?.bot_token && config.channels?.telegram?.chat_id);
}

export async function sendTelegramMessage(config, text, options = {}) {
  if (!hasTelegramChannel(config)) {
    throw new Error("Telegram is not configured");
  }

  const body = {
    chat_id: config.channels.telegram.chat_id,
    text,
  };
  if (options.replyToMessageId) {
    body.reply_to_message_id = options.replyToMessageId;
  }

  const payload = await postJson(telegramApiUrl(config, "sendMessage"), body, options);
  if (payload?.ok === false) {
    throw new Error(payload.description || "Telegram sendMessage failed");
  }

  return {
    channel: "telegram",
    message_id: payload?.result?.message_id || null,
  };
}

export async function getTelegramUpdates(config, offset, options = {}) {
  if (!hasTelegramChannel(config)) {
    return [];
  }

  const payload = await postJson(
    telegramApiUrl(config, "getUpdates"),
    {
      offset,
      timeout: options.timeoutSeconds || 25,
      allowed_updates: ["message"],
    },
    options,
  );
  if (payload?.ok === false) {
    throw new Error(payload.description || "Telegram getUpdates failed");
  }
  return Array.isArray(payload?.result) ? payload.result : [];
}

export async function notifyChannels(config, message) {
  const tasks = [];

  if (hasTelegramChannel(config)) {
    tasks.push(
      sendTelegramMessage(config, message).then(
        () => ({ channel: "telegram", ok: true }),
        (error) => ({ channel: "telegram", ok: false, error: error.message }),
      ),
    );
  }

  if (config.channels?.feishu?.webhook) {
    tasks.push(
      postJson(config.channels.feishu.webhook, {
        msg_type: "text",
        content: { text: message },
      }).then(
        () => ({ channel: "feishu", ok: true }),
        (error) => ({ channel: "feishu", ok: false, error: error.message }),
      ),
    );
  }

  if (tasks.length === 0) {
    return [];
  }

  return Promise.all(tasks);
}
