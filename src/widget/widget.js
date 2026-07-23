(function () {
  if (document.getElementById("openvila-launcher")) return;

  var CHAT_API_PATH = "/openvila/chat";
  var VISITOR_LOCALE = String((window.navigator && window.navigator.language) || "").trim();

  function resolveConfig() {
    var host = "";
    var port = "";
    var color = "";
    var scriptUrl = null;

    var script = document.currentScript;
    if (!script) {
      var scripts = document.getElementsByTagName("script");
      script = scripts.length > 0 ? scripts[scripts.length - 1] : null;
    }

    if (script) {
      host = String(script.getAttribute("data-host") || "").trim();
      port = String(script.getAttribute("data-port") || "").trim();
      color = String(script.getAttribute("data-color") || "").trim();

      var src = String(script.getAttribute("src") || "").trim();
      if (src) {
        try {
          scriptUrl = new URL(src, window.location.href);
          var queryHost = String(scriptUrl.searchParams.get("host") || "").trim();
          var queryPort = String(scriptUrl.searchParams.get("port") || "").trim();
          var queryColor = String(scriptUrl.searchParams.get("color") || "").trim();
          if (queryHost) host = queryHost;
          if (queryPort) port = queryPort;
          if (queryColor) color = queryColor;
        } catch (error) {
          // ignore malformed src url
        }
      }
    }

    if (!host && !port && scriptUrl) {
      host = scriptUrl.origin;
    }

    if (!host) {
      host = window.location.hostname || "127.0.0.1";
    }

    if (!port) {
      port = "9394";
    }

    return { host: host, port: port, color: color };
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

  function thirdOpacityColor(value) {
    var color = String(value || "").trim();
    var matched = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!matched) {
      return "rgba(37, 99, 235, 0.33)";
    }

    var hex = matched[1];
    if (hex.length === 3) {
      hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
    }

    return "rgba(" + parseInt(hex.slice(0, 2), 16) + ", " + parseInt(hex.slice(2, 4), 16) + ", " + parseInt(hex.slice(4, 6), 16) + ", 0.33)";
  }

  var widgetConfig = resolveConfig();
  var apiBase = buildApiBase(widgetConfig);
  var visitorBubbleBackground = thirdOpacityColor(widgetConfig.color || "#2563eb");
  var SESSION_ID_KEY = "openvila_session_id";
  var CHAT_HISTORY_LIMIT = 200;
  var CHAT_HISTORY_REFRESH_MS = 3000;
  var renderedMessageIds = Object.create(null);
  var renderedClientMessageIds = Object.create(null);
  var streamingMessageViews = Object.create(null);
  var chatEvents = null;
  var waitingForReply = false;
  var replyWaitStartedAt = 0;
  var CHAT_ICON_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true" style="display:block;width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round">' +
    '<path d="M4 5h16v12H9l-5 3V5Z"></path>' +
    "</svg>";
  var CLOSE_ICON_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true" style="display:block;width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round">' +
    '<path d="m6 6 12 12"></path><path d="m18 6-12 12"></path>' +
    "</svg>";

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
    var chinese = VISITOR_LOCALE.toLowerCase().startsWith("zh");
    if (role === "user") return chinese ? "你" : "You";
    if (role === "assistant") return "Vila";
    if (role === "handoff") return chinese ? "系统" : "System";
    if (role === "support") return chinese ? "人工客服" : "Support";
    return chinese ? "系统" : "System";
  }

  function formatMessageTime(timestamp) {
    var date = new Date(timestamp || Date.now());
    if (!Number.isFinite(date.getTime())) return "";
    return String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
  }

  function messageHeading(role, timestamp) {
    var time = formatMessageTime(timestamp);
    return time ? role + " · " + time : role;
  }

  function appendPlainText(node, text) {
    if (!text) return;
    var span = document.createElement("span");
    span.textContent = text;
    node.appendChild(span);
  }

  function appendLink(node, label, value) {
    var url;
    try {
      url = new URL(value, window.location.href);
    } catch (error) {
      return false;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return false;
    }

    var link = document.createElement("a");
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.style.color = "#2563eb";
    link.style.textDecoration = "underline";
    link.textContent = label;
    node.appendChild(link);
    return true;
  }

  function renderMessageText(node, value) {
    var text = String(value || "");
    node.textContent = "";
    var pattern = /\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<]+)/g;
    var cursor = 0;
    var matched = pattern.exec(text);

    while (matched) {
      appendPlainText(node, text.slice(cursor, matched.index));

      if (matched[1]) {
        var bold = document.createElement("strong");
        bold.textContent = matched[1];
        node.appendChild(bold);
      } else if (matched[2]) {
        if (!appendLink(node, matched[2], matched[3])) {
          appendPlainText(node, matched[0]);
        }
      } else if (!appendLink(node, matched[4], matched[4])) {
        appendPlainText(node, matched[0]);
      }

      cursor = matched.index + matched[0].length;
      matched = pattern.exec(text);
    }

    appendPlainText(node, text.slice(cursor));
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
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px 8px 12px;border-bottom:1px solid #e2e8f0;background:#f8fafc;font:600 14px/1.4 sans-serif">' +
    '<div style="display:flex;align-items:center;gap:7px">' +
    CHAT_ICON_SVG +
    "<span>Chat with us</span></div>" +
    '<button id="openvila-close" type="button" aria-label="Close chat" title="Close chat" style="display:grid;place-items:center;width:28px;height:28px;border:none;border-radius:6px;background:transparent;color:#64748b;cursor:pointer">' +
    CLOSE_ICON_SVG +
    "</button></div>" +
    '<div id="openvila-messages" style="height:382px;overflow:auto;padding:12px;font:14px/1.5 sans-serif;background:#ffffff"></div>' +
    '<form id="openvila-form" style="padding:10px;border-top:1px solid #e2e8f0;background:#f8fafc">' +
    '<div style="display:flex;gap:8px">' +
    '<input id="openvila-input" placeholder="Ask anything..." style="flex:1;padding:8px;border:1px solid #cbd5e1;border-radius:8px" />' +
    '<button id="openvila-submit" style="padding:8px 12px;border:none;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer">Send</button>' +
    "</div>" +
    '<div style="margin-top:6px;text-align:right;color:#94a3b8;font:11px/1.2 sans-serif"><a href="https://openvila.com" target="_blank" rel="noopener noreferrer" aria-label="OpenVila website (opens in a new tab)" style="display:inline-flex;align-items:center;gap:3px;color:inherit;text-decoration:none">Powered by OpenVila<svg viewBox="0 0 24 24" aria-hidden="true" style="width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><path d="M14 3h7v7"></path><path d="M10 14 21 3"></path><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"></path></svg></a></div>' +
    "</form>";
  panel.querySelector("#openvila-submit").style.background = widgetConfig.color || "#2563eb";

  var button = document.createElement("button");
  button.id = "openvila-launcher";
  button.innerHTML = CHAT_ICON_SVG;
  button.setAttribute("aria-label", "Open chat");
  button.title = "Open chat";
  button.style.position = "fixed";
  button.style.right = "20px";
  button.style.bottom = "20px";
  button.style.width = "52px";
  button.style.height = "52px";
  button.style.borderRadius = "50%";
  button.style.border = "none";
  button.style.background = widgetConfig.color || "linear-gradient(135deg,#2563eb,#0ea5e9)";
  button.style.color = "#fff";
  button.style.display = "grid";
  button.style.placeItems = "center";
  button.style.cursor = "pointer";
  button.style.zIndex = "2147483647";
  button.style.boxShadow = "0 12px 28px rgba(37,99,235,.4)";

  function append(role, text, options) {
    var messageOptions = options || {};
    var list = document.getElementById("openvila-messages");
    if (!list) return null;
    var item = document.createElement("div");
    item.style.marginBottom = "10px";
    var roleNode = document.createElement("div");
    roleNode.style.fontSize = "12px";
    roleNode.style.color = "#64748b";
    var bodyNode = document.createElement("div");
    var isVisitor = messageOptions.role === "user";
    bodyNode.style.background = isVisitor ? visitorBubbleBackground : "#f8fafc";
    bodyNode.style.border = isVisitor ? "1px solid " + visitorBubbleBackground : "1px solid #e2e8f0";
    bodyNode.style.padding = "8px";
    bodyNode.style.borderRadius = "8px";
    bodyNode.style.whiteSpace = "pre-wrap";
    roleNode.textContent = messageHeading(role, messageOptions.ts);
    renderMessageText(bodyNode, text);
    item.appendChild(roleNode);
    item.appendChild(bodyNode);
    list.appendChild(item);
    list.scrollTop = list.scrollHeight;

    return {
      setText: function (nextText) {
        renderMessageText(bodyNode, nextText);
        list.scrollTop = list.scrollHeight;
      },
      setTimestamp: function (nextTimestamp) {
        roleNode.textContent = messageHeading(role, nextTimestamp);
      }
    };
  }

  function setWaitingForReply(waiting) {
    waitingForReply = waiting;
    replyWaitStartedAt = waiting ? Date.now() : 0;
    var input = panel.querySelector("#openvila-input");
    var submit = panel.querySelector("#openvila-submit");
    if (input) {
      input.disabled = waiting;
      input.placeholder = waiting ? "Waiting for reply..." : "Ask anything...";
    }
    if (submit) {
      submit.disabled = waiting;
      submit.textContent = waiting ? "Waiting..." : "Send";
      submit.style.cursor = waiting ? "not-allowed" : "pointer";
      submit.style.opacity = waiting ? "0.65" : "1";
    }
  }

  async function requestChatHistory(identity) {
    var query = new URLSearchParams({
      session_id: identity.sessionId,
      limit: String(CHAT_HISTORY_LIMIT),
      locale: VISITOR_LOCALE
    });
    var res = await fetch(apiBase + CHAT_API_PATH + "/history?" + query.toString(), {
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
    var role = String(item.role || "").trim();
    var streamed = messageId ? streamingMessageViews[messageId] : null;
    if (streamed) {
      streamed.setText(content);
      streamed.setTimestamp(item.ts);
      delete streamingMessageViews[messageId];
      if (messageId) renderedMessageIds[messageId] = true;
      if (clientMessageId) renderedClientMessageIds[clientMessageId] = true;
      completeReplyWait(item, role);
      return;
    }
    if (!content || (messageId && renderedMessageIds[messageId]) || (clientMessageId && renderedClientMessageIds[clientMessageId])) {
      if (messageId) renderedMessageIds[messageId] = true;
      return;
    }
    if (messageId) renderedMessageIds[messageId] = true;
    if (clientMessageId) renderedClientMessageIds[clientMessageId] = true;
    append(roleLabel(item.role), content, { role: role, ts: item.ts });

    completeReplyWait(item, role);
  }

  function completeReplyWait(item, role) {
    var replyTime = Date.parse(String(item.ts || ""));
    if (
      waitingForReply &&
      (role === "assistant" || role === "support") &&
      Number.isFinite(replyTime) &&
      replyTime >= replyWaitStartedAt
    ) {
      setWaitingForReply(false);
    }
  }

  function appendChatDelta(item) {
    if (!item || typeof item !== "object") return;
    var messageId = String(item.id || "").trim();
    var delta = String(item.delta || "");
    if (!messageId || !delta) return;

    var streamed = streamingMessageViews[messageId];
    if (!streamed) {
      var view = append(roleLabel(item.role || "assistant"), "", {
        role: String(item.role || "assistant"),
        ts: new Date().toISOString(),
      });
      if (!view) return;
      streamed = {
        content: "",
        setText: view.setText,
        setTimestamp: view.setTimestamp,
      };
      streamingMessageViews[messageId] = streamed;
    }
    streamed.content += delta;
    streamed.setText(streamed.content);
  }

  function openChatEvents() {
    if (!chatIdentity || !window.EventSource || chatEvents) return;

    var query = new URLSearchParams({ session_id: chatIdentity.sessionId });
    var source = new window.EventSource(apiBase + CHAT_API_PATH + "/events?" + query.toString());
    chatEvents = source;
    source.addEventListener("open", function () {
      refreshChatHistory();
    });
    source.addEventListener("message", function (event) {
      try {
        appendChatMessage(JSON.parse(String(event.data || "{}")));
      } catch (error) {}
    });
    source.addEventListener("delta", function (event) {
      try {
        appendChatDelta(JSON.parse(String(event.data || "{}")));
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
    var res = await fetch(apiBase + CHAT_API_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: message,
        session_id: identity.sessionId,
        client_message_id: clientMessageId,
        locale: VISITOR_LOCALE
      })
    });

    if (!res.ok) {
      var errorPayload = await res.json().catch(function () {
        return {};
      });
      throw new Error(String(errorPayload.error || ("HTTP " + res.status)));
    }
  }

  button.addEventListener("click", function (event) {
    if (event && event.isTrusted === false) return;

    panel.style.display = panel.style.display === "none" ? "block" : "none";
    if (panel.style.display === "block") {
      chatIdentity = chatIdentity || getOrCreateIdentity();
      scrollMessagesToBottom();
      openChatEvents();
      refreshChatHistory();
    } else {
      closeChatEvents();
    }
  });

  panel.querySelector("#openvila-close").addEventListener("click", function () {
    panel.style.display = "none";
    closeChatEvents();
  });

  var chatIdentity = null;

  panel.querySelector("#openvila-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    if (waitingForReply) return;
    var input = panel.querySelector("#openvila-input");
    var text = (input.value || "").trim();
    if (!text || !chatIdentity) return;
    setWaitingForReply(true);
    input.value = "";
    var clientMessageId = generateId("message");
    appendChatMessage({
      id: "local-" + clientMessageId,
      client_message_id: clientMessageId,
      role: "user",
      content: text,
      ts: new Date().toISOString()
    });

    try {
      await submitChatMessage(text, chatIdentity, clientMessageId);
    } catch (err) {
      setWaitingForReply(false);
      var chinese = VISITOR_LOCALE.toLowerCase().startsWith("zh");
      append(chinese ? "系统" : "System", (chinese ? "请求失败：" : "Request failed: ") + err.message, { ts: new Date().toISOString() });
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

  setInterval(function () {
    if (panel.style.display === "block" && !isChatEventsOpen()) {
      openChatEvents();
      refreshChatHistory();
    }
  }, CHAT_HISTORY_REFRESH_MS);
})();
