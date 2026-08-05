(function () {
  if (document.getElementById("openvila-launcher")) return;

  var CHAT_API_PATH = "/openvila/chat";
  var VISITOR_LOCALE = String((window.navigator && window.navigator.language) || "").trim();

  function resolveConfig() {
    var host = "";
    var port = "";
    var color = "";
    var user = "";
    var side = "";
    var vilaSize = "";
    var vilaOffsetX = "";
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
      user = String(script.getAttribute("data-user") || "").trim();
      side = String(script.getAttribute("data-side") || "").trim();

      var src = String(script.getAttribute("src") || "").trim();
      if (src) {
        try {
          scriptUrl = new URL(src, window.location.href);
          var queryHost = String(scriptUrl.searchParams.get("host") || "").trim();
          var queryPort = String(scriptUrl.searchParams.get("port") || "").trim();
          var queryColor = String(scriptUrl.searchParams.get("color") || "").trim();
          var querySide = String(scriptUrl.searchParams.get("side") || "").trim();
          var queryVilaSize = String(scriptUrl.searchParams.get("vila-size") || scriptUrl.searchParams.get("vila_size") || "").trim();
          var queryVilaOffsetX = String(scriptUrl.searchParams.get("vila-offset-x") || "").trim();
          if (queryHost) host = queryHost;
          if (queryPort) port = queryPort;
          if (queryColor) color = queryColor;
          if (querySide) side = querySide;
          if (queryVilaSize) vilaSize = queryVilaSize;
          if (queryVilaOffsetX) vilaOffsetX = queryVilaOffsetX;
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

    var parsedVilaSize = Number(vilaSize);
    if (!Number.isFinite(parsedVilaSize) || parsedVilaSize < 0.25 || parsedVilaSize > 1) {
      parsedVilaSize = 0.5;
    }
    var parsedVilaOffsetX = Number(vilaOffsetX);
    if (!Number.isFinite(parsedVilaOffsetX)) {
      parsedVilaOffsetX = 0;
    }

    return {
      host: host,
      port: port,
      color: color,
      user: user,
      side: String(side || "right").toLowerCase() === "left" ? "left" : "right",
      vilaSize: parsedVilaSize,
      vilaOffsetX: Math.round(parsedVilaOffsetX),
    };
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
  var widgetColor = widgetConfig.color || "#2563eb";
  var visitorBubbleBackground = thirdOpacityColor(widgetColor);
  var vilaWidth = Math.round(192 * widgetConfig.vilaSize);
  var vilaHeight = Math.round(208 * widgetConfig.vilaSize);
  var SESSION_ID_KEY = "openvila_session_id";
  var HANDOFF_SESSION_ID_KEY = "openvila_handoff_session_id";
  var HANDOFF_READ_AT_KEY = "openvila_handoff_read_at";
  var CHAT_HISTORY_LIMIT = 200;
  var CHAT_HISTORY_REFRESH_MS = 3000;
  var renderedMessageIds = Object.create(null);
  var renderedClientMessageIds = Object.create(null);
  var streamingMessageViews = Object.create(null);
  var chatEvents = null;
  var handoffUpdatedAt = 0;
  var waitingForReply = false;
  var replyWaitStartedAt = 0;
  var handoffMessageQueue = Promise.resolve();
  var vilaSprite = null;
  var launcherHeight = 52;
  var RUNNING_VILA_STATES = ["running-left", "running-right", "jumping"];
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

  function hasSavedHandoffSession() {
    return Boolean(readStorage(window.localStorage, HANDOFF_SESSION_ID_KEY));
  }

  function shouldListenForReplies() {
    return panel.style.display === "block" || hasSavedHandoffSession();
  }

  function markSupportRepliesRead(timestamp) {
    writeStorage(window.localStorage, HANDOFF_READ_AT_KEY, timestamp || new Date().toISOString());
    unreadSupportIndicator.style.display = "none";
  }

  function isUnreadSupportReply(item) {
    var replyTime = Date.parse(String((item && item.ts) || ""));
    var readTime = Date.parse(readStorage(window.localStorage, HANDOFF_READ_AT_KEY));
    return !Number.isFinite(replyTime) || !Number.isFinite(readTime) || replyTime > readTime;
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
  panel.style[widgetConfig.side] = "20px";
  panel.style.bottom = String(20 + launcherHeight + 12) + "px";
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
  panel.querySelector("#openvila-submit").style.background = widgetColor;

  var button = document.createElement("button");
  button.id = "openvila-launcher";
  button.innerHTML = CHAT_ICON_SVG;
  button.setAttribute("aria-label", "Open chat");
  button.title = "Open chat";
  button.style.position = "fixed";
  button.style[widgetConfig.side] = "20px";
  button.style.bottom = "20px";
  button.style.width = "52px";
  button.style.height = "52px";
  button.style.boxSizing = "border-box";
  button.style.padding = "0";
  button.style.borderRadius = "50%";
  button.style.border = "none";
  button.style.background = widgetConfig.color || "linear-gradient(135deg,#2563eb,#0ea5e9)";
  button.style.color = "#fff";
  button.style.display = "grid";
  button.style.placeItems = "center";
  button.style.cursor = "pointer";
  button.style.zIndex = "2147483647";
  button.style.boxShadow = "0 12px 28px rgba(37,99,235,.4)";

  var unreadSupportIndicator = document.createElement("span");
  unreadSupportIndicator.setAttribute("aria-hidden", "true");
  unreadSupportIndicator.style.position = "absolute";
  unreadSupportIndicator.style.top = "3px";
  unreadSupportIndicator.style.right = "3px";
  unreadSupportIndicator.style.width = "9px";
  unreadSupportIndicator.style.height = "9px";
  unreadSupportIndicator.style.border = "2px solid #fff";
  unreadSupportIndicator.style.borderRadius = "50%";
  unreadSupportIndicator.style.background = "#ef4444";
  unreadSupportIndicator.style.display = "none";
  unreadSupportIndicator.style.pointerEvents = "none";
  button.appendChild(unreadSupportIndicator);

  function setVilaState(state) {
    if (!vilaSprite) return;
    vilaSprite.setAttribute("data-vila-state", state);
    button.setAttribute("data-vila-state", state);
  }

  function setDefaultVilaState() {
    setVilaState(panel.style.display === "block" ? "waiting" : "idle");
  }

  function setRunningVilaState() {
    var index = Math.floor(Math.random() * RUNNING_VILA_STATES.length);
    setVilaState(RUNNING_VILA_STATES[index]);
  }

  function activateVila(vila) {
    var spriteUrl;
    try {
      spriteUrl = new URL(String(vila.spritesheet_url || ""), apiBase).toString();
    } catch (error) {
      return;
    }
    if (!spriteUrl) return;

    var vilaStyles = document.getElementById("openvila-vila-styles");
    if (!vilaStyles) {
      vilaStyles = document.createElement("link");
      vilaStyles.id = "openvila-vila-styles";
      vilaStyles.rel = "stylesheet";
      vilaStyles.href = apiBase + "/openvila/widget.css";
      (document.head || document.body).appendChild(vilaStyles);
    }

    vilaSprite = document.createElement("span");
    vilaSprite.className = "openvila-vila-sprite";
    vilaSprite.style.display = "block";
    vilaSprite.style.width = String(vilaWidth) + "px";
    vilaSprite.style.height = String(vilaHeight) + "px";
    vilaSprite.style.backgroundImage = "url(" + JSON.stringify(spriteUrl) + ")";
    vilaSprite.style.transform = "translateX(" + String(widgetConfig.vilaOffsetX) + "px)";
    vilaSprite.style.pointerEvents = "none";
    button.innerHTML = "";
    button.appendChild(vilaSprite);
    button.appendChild(unreadSupportIndicator);
    button.style.width = String(vilaWidth) + "px";
    button.style.height = String(vilaHeight) + "px";
    button.style.borderRadius = "0";
    button.style.background = "transparent";
    button.style.boxShadow = "none";
    button.style.overflow = "visible";
    launcherHeight = vilaHeight;
    panel.style.bottom = String(20 + launcherHeight + 12) + "px";
    setDefaultVilaState();
  }

  async function loadActiveVila() {
    try {
      var res = await fetch(apiBase + "/openvila/vila", { method: "GET" });
      if (!res.ok) return;
      var vila = await res.json().catch(function () {
        return {};
      });
      if (vila && vila.active === true && vila.spritesheet_url) {
        activateVila(vila);
      }
    } catch (error) {}
  }

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
    return payload;
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

    if (role === "support") {
      if (panel.style.display === "none" && hasSavedHandoffSession() && isUnreadSupportReply(item)) {
        unreadSupportIndicator.style.display = "block";
      } else if (panel.style.display === "block") {
        markSupportRepliesRead(item.ts);
      }
    }

    completeReplyWait(item, role);
  }

  function startNewChatSession() {
    closeChatEvents();
    writeStorage(window.localStorage, SESSION_ID_KEY, "");
    writeStorage(window.localStorage, HANDOFF_SESSION_ID_KEY, "");
    writeStorage(window.localStorage, HANDOFF_READ_AT_KEY, "");
    chatIdentity = getOrCreateIdentity();
    handoffUpdatedAt = 0;
    var list = document.getElementById("openvila-messages");
    if (list) {
      list.textContent = "";
    }
    renderedMessageIds = Object.create(null);
    renderedClientMessageIds = Object.create(null);
    streamingMessageViews = Object.create(null);
    setWaitingForReply(false);
    setDefaultVilaState();
    openChatEvents();
    refreshChatHistory();
  }

  function setHandoffActive(active, updatedAt) {
    var nextUpdatedAt = Date.parse(String(updatedAt || ""));
    if (!active && !Number.isFinite(nextUpdatedAt) && handoffUpdatedAt > 0) {
      return;
    }
    if (Number.isFinite(nextUpdatedAt)) {
      if (nextUpdatedAt < handoffUpdatedAt) {
        return;
      }
      handoffUpdatedAt = nextUpdatedAt;
    }
    if (active === true && chatIdentity) {
      writeStorage(window.localStorage, HANDOFF_SESSION_ID_KEY, chatIdentity.sessionId);
    } else if (active !== true && chatIdentity && readStorage(window.localStorage, HANDOFF_SESSION_ID_KEY) === chatIdentity.sessionId) {
      writeStorage(window.localStorage, HANDOFF_SESSION_ID_KEY, "");
    }
    if (!hasSavedHandoffSession() && panel.style.display === "none") {
      closeChatEvents();
    }
    if (panel.style.display === "none") {
      setVilaState("idle");
    } else if (active === true) {
      setWaitingForReply(false);
    } else if (!waitingForReply) {
      setDefaultVilaState();
    }
  }

  function completeReplyWait(item, role) {
    var replyTime = Date.parse(String(item.ts || ""));
    if ((role === "assistant" || role === "support") && panel.style.display === "block") {
      setVilaState("waiting");
    }
    var completesReply = role === "support" || (role === "assistant" && !hasSavedHandoffSession());
    if (
      waitingForReply &&
      completesReply &&
      Number.isFinite(replyTime) &&
      replyTime >= replyWaitStartedAt
    ) {
      setWaitingForReply(false);
      if (panel.style.display === "block") {
        setVilaState("waiting");
      } else {
        setVilaState("idle");
      }
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
    source.addEventListener("handoff", function (event) {
      try {
        var payload = JSON.parse(String(event.data || "{}"));
        setHandoffActive(payload.active, payload.updated_at);
      } catch (error) {}
    });
    source.addEventListener("vila", function (event) {
      try {
        var payload = JSON.parse(String(event.data || "{}"));
        if (payload.state === "failed") {
          setVilaState(panel.style.display === "block" ? "failed" : "idle");
        }
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
        locale: VISITOR_LOCALE,
        page_url: String(window.location.href || ""),
        user: widgetConfig.user
      })
    });

    if (!res.ok) {
      var errorPayload = await res.json().catch(function () {
        return {};
      });
      throw new Error(String(errorPayload.error || ("HTTP " + res.status)));
    }
  }

  function queueHandoffMessage(message, identity, clientMessageId) {
    var queued = handoffMessageQueue.then(function () {
      return submitChatMessage(message, identity, clientMessageId);
    });
    handoffMessageQueue = queued.catch(function () {});
    return queued;
  }

  async function submitChatCommand(command, identity) {
    var res = await fetch(apiBase + CHAT_API_PATH + "/" + command, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: identity.sessionId,
        locale: VISITOR_LOCALE,
        page_url: String(window.location.href || ""),
        user: widgetConfig.user
      })
    });

    var payload = await res.json().catch(function () {
      return {};
    });
    if (!res.ok) {
      throw new Error(String(payload.error || ("HTTP " + res.status)));
    }
    return payload;
  }

  function hidePanel() {
    panel.style.display = "none";
    setVilaState("idle");
    if (!hasSavedHandoffSession()) {
      closeChatEvents();
    }
  }

  button.addEventListener("click", function (event) {
    if (event && event.isTrusted === false) return;

    panel.style.display = panel.style.display === "none" ? "block" : "none";
    if (panel.style.display === "block") {
      chatIdentity = chatIdentity || getOrCreateIdentity();
      markSupportRepliesRead();
      setVilaState("waiting");
      scrollMessagesToBottom();
      openChatEvents();
      refreshChatHistory();
    } else {
      hidePanel();
    }
  });

  panel.querySelector("#openvila-close").addEventListener("click", function () {
    hidePanel();
  });

  var chatIdentity = null;

  panel.querySelector("#openvila-input").addEventListener("input", function () {
    if (panel.style.display === "block" && !waitingForReply) {
      setVilaState("waiting");
    }
  });

  panel.querySelector("#openvila-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var input = panel.querySelector("#openvila-input");
    var text = (input.value || "").trim();
    if (!text || !chatIdentity) return;
    var command = text.toLowerCase();
    if (command === "/close") {
      input.value = "";
      hidePanel();
      return;
    }
    if (waitingForReply) return;

    if (command === "/reset" || command === "/human") {
      setWaitingForReply(true);
      setRunningVilaState();
      input.value = "";
      try {
        var result = await submitChatCommand(command.slice(1), chatIdentity);
        if (command === "/reset") {
          startNewChatSession();
        } else if (result.already_requested) {
          setWaitingForReply(false);
          setVilaState("waiting");
        }
      } catch (err) {
        setWaitingForReply(false);
        setVilaState(panel.style.display === "block" ? "failed" : "idle");
        var commandChinese = VISITOR_LOCALE.toLowerCase().startsWith("zh");
        append(commandChinese ? "系统" : "System", (commandChinese ? "请求失败：" : "Request failed: ") + err.message, { ts: new Date().toISOString() });
      }
      return;
    }

    var humanHandoff = hasSavedHandoffSession();
    if (humanHandoff) {
      setRunningVilaState();
    } else {
      setWaitingForReply(true);
      setRunningVilaState();
    }
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
      if (humanHandoff) {
        await queueHandoffMessage(text, chatIdentity, clientMessageId);
      } else {
        await submitChatMessage(text, chatIdentity, clientMessageId);
      }
    } catch (err) {
      if (!humanHandoff) {
        setWaitingForReply(false);
      }
      setVilaState(panel.style.display === "block" ? "failed" : "idle");
      var chinese = VISITOR_LOCALE.toLowerCase().startsWith("zh");
      append(chinese ? "系统" : "System", (chinese ? "请求失败：" : "Request failed: ") + err.message, { ts: new Date().toISOString() });
    }
  });

  document.body.appendChild(panel);
  document.body.appendChild(button);

  var savedHandoffSessionId = readStorage(window.localStorage, HANDOFF_SESSION_ID_KEY);
  if (savedHandoffSessionId) {
    chatIdentity = { sessionId: savedHandoffSessionId };
    openChatEvents();
    refreshChatHistory();
  }

  loadActiveVila();

  async function refreshChatHistory() {
    try {
      var payload = await requestChatHistory(chatIdentity);
      if (payload.handoff && typeof payload.handoff.active === "boolean") {
        setHandoffActive(payload.handoff.active, payload.handoff.updated_at);
      }
      var messages = Array.isArray(payload.messages) ? payload.messages : [];
      for (var i = 0; i < messages.length; i += 1) {
        appendChatMessage(messages[i]);
      }
    } catch (error) {}
  }

  setInterval(function () {
    if (shouldListenForReplies() && !isChatEventsOpen()) {
      openChatEvents();
      refreshChatHistory();
    }
  }, CHAT_HISTORY_REFRESH_MS);
})();
