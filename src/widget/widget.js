(function () {
  if (document.getElementById("openvila-launcher")) return;

  function resolveConfig() {
    var host = "";
    var port = "";

    var script = document.currentScript;
    if (!script) {
      var scripts = document.getElementsByTagName("script");
      script = scripts.length > 0 ? scripts[scripts.length - 1] : null;
    }

    if (script) {
      host = String(script.getAttribute("data-host") || "").trim();
      port = String(script.getAttribute("data-port") || "").trim();

      var src = String(script.getAttribute("src") || "").trim();
      if (src) {
        try {
          var srcUrl = new URL(src, window.location.href);
          var queryHost = String(srcUrl.searchParams.get("host") || "").trim();
          var queryPort = String(srcUrl.searchParams.get("port") || "").trim();
          if (queryHost) host = queryHost;
          if (queryPort) port = queryPort;
        } catch (error) {
          // ignore malformed src url
        }
      }
    }

    if (!host) {
      host = window.location.hostname || "127.0.0.1";
    }

    if (!port) {
      port = "9394";
    }

    return { host: host, port: port };
  }

  function buildApiBase(config) {
    var host = String(config.host || "").trim();
    var port = String(config.port || "").trim();

    if (/^https?:\/\//i.test(host)) {
      return host.replace(/\/+$/, "");
    }

    var protocol = window.location.protocol === "https:" ? "https:" : "http:";
    return protocol + "//" + host + (port ? ":" + port : "");
  }

  var widgetConfig = resolveConfig();
  var apiBase = buildApiBase(widgetConfig);
  var SESSION_ID_KEY = "openvila_session_id";
  var CHAT_HISTORY_LIMIT = 200;
  var CHAT_HISTORY_REFRESH_MS = 3000;
  var renderedMessageIds = Object.create(null);
  var renderedClientMessageIds = Object.create(null);
  var chatEvents = null;

  function generateId(prefix) {
    var value = "";
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      value = window.crypto.randomUUID().replace(/-/g, "");
    } else {
      value = String(Date.now()) + String(Math.random()).slice(2, 12);
    }
    return prefix + "-" + value.slice(0, 24);
  }

  function readStorage(storage, key) {
    try {
      return String(storage.getItem(key) || "").trim();
    } catch (error) {
      return "";
    }
  }

  function writeStorage(storage, key, value) {
    try {
      storage.setItem(key, value);
    } catch (error) {
      // ignore storage write failure
    }
  }

  function getOrCreateIdentity() {
    var sessionId = readStorage(window.localStorage, SESSION_ID_KEY);
    if (!sessionId) {
      sessionId = generateId("session");
      writeStorage(window.localStorage, SESSION_ID_KEY, sessionId);
    }

    return {
      sessionId: sessionId
    };
  }

  function roleLabel(role) {
    if (role === "user") return "You";
    if (role === "assistant") return "Vila";
    if (role === "handoff") return "System";
    if (role === "support") return "Support";
    return "System";
  }

  function scrollMessagesToBottom() {
    var list = document.getElementById("openvila-messages");
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }

  var panel = document.createElement("div");
  panel.id = "openvila-panel";
  panel.style.position = "fixed";
  panel.style.right = "20px";
  panel.style.bottom = "84px";
  panel.style.width = "360px";
  panel.style.maxWidth = "calc(100vw - 24px)";
  panel.style.height = "520px";
  panel.style.background = "#ffffff";
  panel.style.border = "1px solid #dbeafe";
  panel.style.borderRadius = "14px";
  panel.style.boxShadow = "0 24px 64px rgba(15, 23, 42, 0.2)";
  panel.style.display = "none";
  panel.style.overflow = "hidden";
  panel.style.zIndex = "2147483647";

  panel.innerHTML =
    "" +
    '<div style="padding:10px 12px;border-bottom:1px solid #e2e8f0;background:#f8fafc;font:600 14px/1.4 sans-serif">OpenVila</div>' +
    '<div id="openvila-messages" style="height:400px;overflow:auto;padding:12px;font:14px/1.5 sans-serif;background:#ffffff"></div>' +
    '<form id="openvila-form" style="display:flex;gap:8px;padding:10px;border-top:1px solid #e2e8f0;background:#f8fafc">' +
    '<input id="openvila-input" placeholder="Ask anything..." style="flex:1;padding:8px;border:1px solid #cbd5e1;border-radius:8px" />' +
    '<button style="padding:8px 12px;border:none;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer">Send</button>' +
    "</form>";

  var button = document.createElement("button");
  button.id = "openvila-launcher";
  button.textContent = "V";
  button.style.position = "fixed";
  button.style.right = "20px";
  button.style.bottom = "20px";
  button.style.width = "52px";
  button.style.height = "52px";
  button.style.borderRadius = "50%";
  button.style.border = "none";
  button.style.background = "linear-gradient(135deg,#2563eb,#0ea5e9)";
  button.style.color = "#fff";
  button.style.font = "700 20px/1 sans-serif";
  button.style.cursor = "pointer";
  button.style.zIndex = "2147483647";
  button.style.boxShadow = "0 12px 28px rgba(37,99,235,.4)";

  function append(role, text) {
    var list = document.getElementById("openvila-messages");
    if (!list) return null;
    var item = document.createElement("div");
    item.style.marginBottom = "10px";
    var roleNode = document.createElement("div");
    roleNode.style.fontSize = "12px";
    roleNode.style.color = "#64748b";
    roleNode.textContent = role;
    var bodyNode = document.createElement("div");
    bodyNode.style.background = "#f8fafc";
    bodyNode.style.border = "1px solid #e2e8f0";
    bodyNode.style.padding = "8px";
    bodyNode.style.borderRadius = "8px";
    bodyNode.style.whiteSpace = "pre-wrap";
    bodyNode.textContent = text;
    item.appendChild(roleNode);
    item.appendChild(bodyNode);
    list.appendChild(item);
    list.scrollTop = list.scrollHeight;

    return {
      setText: function (nextText) {
        bodyNode.textContent = String(nextText || "");
        list.scrollTop = list.scrollHeight;
      }
    };
  }

  async function requestChatHistory(identity) {
    var query = new URLSearchParams({
      session_id: identity.sessionId,
      limit: String(CHAT_HISTORY_LIMIT)
    });
    var res = await fetch(apiBase + "/chat/history?" + query.toString(), {
      method: "GET"
    });
    if (!res.ok) {
      throw new Error("history request failed: HTTP " + res.status);
    }
    var payload = await res.json().catch(function () {
      return {};
    });
    return Array.isArray(payload.messages) ? payload.messages : [];
  }

  function appendChatMessage(item) {
    if (!item || typeof item !== "object") return;
    var content = String(item.content || "").trim();
    var messageId = String(item.id || "").trim();
    var clientMessageId = String(item.client_message_id || "").trim();
    if (!content || (messageId && renderedMessageIds[messageId]) || (clientMessageId && renderedClientMessageIds[clientMessageId])) {
      if (messageId) renderedMessageIds[messageId] = true;
      return;
    }
    if (messageId) renderedMessageIds[messageId] = true;
    if (clientMessageId) renderedClientMessageIds[clientMessageId] = true;
    append(roleLabel(item.role), content);
  }

  function openChatEvents() {
    if (!window.EventSource || chatEvents) return;

    var query = new URLSearchParams({ session_id: chatIdentity.sessionId });
    var source = new window.EventSource(apiBase + "/chat/events?" + query.toString());
    chatEvents = source;
    source.addEventListener("open", function () {
      refreshChatHistory();
    });
    source.addEventListener("message", function (event) {
      try {
        appendChatMessage(JSON.parse(String(event.data || "{}")));
      } catch (error) {}
    });
    source.addEventListener("error", function () {
      if (source.readyState === window.EventSource.CLOSED && chatEvents === source) {
        chatEvents = null;
      }
    });
  }

  function closeChatEvents() {
    if (!chatEvents) return;
    chatEvents.close();
    chatEvents = null;
  }

  function isChatEventsOpen() {
    return Boolean(chatEvents && chatEvents.readyState === window.EventSource.OPEN);
  }

  async function submitChatMessage(message, identity, clientMessageId) {
    var res = await fetch(apiBase + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: message,
        session_id: identity.sessionId,
        client_message_id: clientMessageId
      })
    });

    if (!res.ok) {
      var errorPayload = await res.json().catch(function () {
        return {};
      });
      throw new Error(String(errorPayload.error || ("HTTP " + res.status)));
    }
  }

  button.addEventListener("click", function () {
    panel.style.display = panel.style.display === "none" ? "block" : "none";
    if (panel.style.display === "block") {
      scrollMessagesToBottom();
      openChatEvents();
      refreshChatHistory();
    } else {
      closeChatEvents();
    }
  });

  var chatIdentity = getOrCreateIdentity();

  panel.querySelector("#openvila-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var input = panel.querySelector("#openvila-input");
    var text = (input.value || "").trim();
    if (!text) return;
    input.value = "";
    var clientMessageId = generateId("message");
    appendChatMessage({
      id: "local-" + clientMessageId,
      client_message_id: clientMessageId,
      role: "user",
      content: text
    });

    try {
      await submitChatMessage(text, chatIdentity, clientMessageId);
    } catch (err) {
      append("System", "Request failed: " + err.message);
    }
  });

  document.body.appendChild(panel);
  document.body.appendChild(button);

  async function refreshChatHistory() {
    try {
      var messages = await requestChatHistory(chatIdentity);
      for (var i = 0; i < messages.length; i += 1) {
        appendChatMessage(messages[i]);
      }
    } catch (error) {}
  }

  (async function restoreChatHistory() {
    try {
      var messages = await requestChatHistory(chatIdentity);
      if (!Array.isArray(messages) || messages.length === 0) {
        return;
      }
      for (var i = 0; i < messages.length; i += 1) {
        var item = messages[i];
        if (!item || typeof item !== "object") continue;
        var content = String(item.content || "").trim();
        if (!content) continue;
        appendChatMessage(item);
      }
      scrollMessagesToBottom();
    } catch (error) {
      // ignore history restore failures
    }
  })();

  setInterval(function () {
    if (panel.style.display === "block" && !isChatEventsOpen()) {
      openChatEvents();
      refreshChatHistory();
    }
  }, CHAT_HISTORY_REFRESH_MS);
})();
