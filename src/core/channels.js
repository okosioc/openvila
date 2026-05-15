async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
}

export async function notifyChannels(config, message) {
  const tasks = [];

  if (config.channels?.telegram?.bot_token && config.channels?.telegram?.chat_id) {
    const url = `https://api.telegram.org/bot${config.channels.telegram.bot_token}/sendMessage`;
    tasks.push(
      postJson(url, {
        chat_id: config.channels.telegram.chat_id,
        text: message,
      }).then(
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
