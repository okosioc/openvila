import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

class FakeElement {
  constructor(document) {
    this.document = document;
    this.children = [];
    this.listeners = new Map();
    this.style = {};
    this.value = "";
    this.disabled = false;
    this.placeholder = "";
    this.textContent = "";
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }

  set id(value) {
    this._id = value;
    this.document.elements.set(value, this);
  }

  get id() {
    return this._id;
  }

  set innerHTML(value) {
    this._innerHTML = value;
    if (!String(value).includes("openvila-form")) {
      return;
    }
    for (const id of ["openvila-close", "openvila-messages", "openvila-form", "openvila-input", "openvila-submit"]) {
      const element = new FakeElement(this.document);
      element.id = id;
      this.children.push(element);
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this[name] = String(value);
  }

  querySelector(selector) {
    return this.document.getElementById(selector.replace(/^#/, ""));
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  async emit(type, event = {}) {
    const listeners = this.listeners.get(type) || [];
    await Promise.all(listeners.map((listener) => listener(event)));
  }
}

class FakeDocument {
  constructor(scriptAttributes = {}) {
    this.elements = new Map();
    this.body = new FakeElement(this);
    this.currentScript = {
      getAttribute: (name) => scriptAttributes[name] || "",
    };
  }

  getElementById(id) {
    return this.elements.get(id) || null;
  }

  getElementsByTagName() {
    return [this.currentScript];
  }

  createElement() {
    return new FakeElement(this);
  }
}

function createWidgetHarness(options = {}) {
  const document = new FakeDocument(options.scriptAttributes);
  const eventSources = [];
  const storage = new Map();
  const fetchCalls = [];

  class FakeEventSource {
    static OPEN = 1;

    static CLOSED = 2;

    constructor(url) {
      this.url = url;
      this.readyState = FakeEventSource.OPEN;
      this.listeners = new Map();
      eventSources.push(this);
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }

    close() {
      this.readyState = FakeEventSource.CLOSED;
    }

    emit(type, event) {
      for (const listener of this.listeners.get(type) || []) {
        listener(event);
      }
    }
  }

  const fetch = async (url, request = {}) => {
    fetchCalls.push({ url, request });
    if (String(url).includes("/chat/history")) {
      return {
        ok: true,
        json: async () => ({ messages: [] }),
      };
    }
    if (options.failPost) {
      return {
        ok: false,
        status: 503,
        json: async () => ({ error: "Service unavailable" }),
      };
    }
    return {
      ok: true,
      json: async () => ({}),
    };
  };

  const window = {
    EventSource: FakeEventSource,
    crypto: { randomUUID: () => "00000000-0000-0000-0000-000000000000" },
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    location: {
      hostname: "127.0.0.1",
      protocol: "http:",
      href: "http://127.0.0.1/",
    },
  };

  return {
    document,
    eventSources,
    fetchCalls,
    context: {
      Date,
      URL,
      URLSearchParams,
      document,
      fetch,
      setInterval: () => 0,
      window,
    },
  };
}

async function loadWidget(options = {}) {
  const widgetPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/widget/widget.js");
  const source = await fs.readFile(widgetPath, "utf8");
  const harness = createWidgetHarness(options);
  vm.runInNewContext(source, harness.context, { filename: widgetPath });
  await Promise.resolve();
  await harness.document.getElementById("openvila-launcher").emit("click");
  return harness;
}

function submitEvent() {
  return {
    preventDefault() {},
  };
}

test("widget uses a visitor-facing title with OpenVila attribution", async () => {
  const harness = await loadWidget();
  const markup = harness.document.getElementById("openvila-panel").innerHTML;
  const launcher = harness.document.getElementById("openvila-launcher");

  assert.match(markup, />Chat with us</);
  assert.match(markup, /Powered by OpenVila/);
  assert.match(markup, /href="https:\/\/openvila\.com"/);
  assert.match(markup, /OpenVila website \(opens in a new tab\)/);
  assert.match(markup, /text-align:right/);
  assert.match(markup, /<svg/);
  assert.match(launcher.innerHTML, /M4 5h16v12H9l-5 3V5Z/);
  assert.match(launcher.innerHTML, /<svg/);
  assert.equal(launcher["aria-label"], "Open chat");
  assert.match(markup, /id="openvila-close"[^>]*><svg/);
  assert.match(markup, /id="openvila-close"[^>]*aria-label="Close chat"/);
});

test("widget applies the configured launcher color", async () => {
  const harness = await loadWidget({ scriptAttributes: { "data-color": "#0f766e" } });
  const launcher = harness.document.getElementById("openvila-launcher");
  const submit = harness.document.getElementById("openvila-submit");

  assert.equal(launcher.style.background, "#0f766e");
  assert.equal(submit.style.background, "#0f766e");
});

test("widget query color overrides the script attribute", async () => {
  const harness = await loadWidget({
    scriptAttributes: {
      "data-color": "#0f766e",
      src: "/openvila/widget.js?color=%23be123c",
    },
  });
  const launcher = harness.document.getElementById("openvila-launcher");
  const submit = harness.document.getElementById("openvila-submit");

  assert.equal(launcher.style.background, "#be123c");
  assert.equal(submit.style.background, "#be123c");
});

test("widget close button hides the panel and closes the event stream", async () => {
  const harness = await loadWidget();
  const panel = harness.document.getElementById("openvila-panel");
  const close = harness.document.getElementById("openvila-close");
  const eventSource = harness.eventSources[0];

  assert.equal(panel.style.display, "block");
  await close.emit("click");

  assert.equal(panel.style.display, "none");
  assert.equal(eventSource.readyState, harness.context.window.EventSource.CLOSED);
});

test("widget renders streamed replies once and unlocks after the completed message", async () => {
  const harness = await loadWidget();
  const form = harness.document.getElementById("openvila-form");
  const input = harness.document.getElementById("openvila-input");
  const submit = harness.document.getElementById("openvila-submit");
  const eventSource = harness.eventSources[0];

  input.value = "What is the refund policy?";
  await form.emit("submit", submitEvent());

  assert.equal(input.disabled, true);
  assert.equal(submit.disabled, true);
  assert.equal(submit.textContent, "Waiting...");
  assert.equal(harness.fetchCalls.filter((call) => String(call.url).endsWith("/chat")).length, 1);

  eventSource.emit("delta", {
    data: JSON.stringify({
      id: "stream-answer",
      role: "assistant",
      delta: "Refunds are ",
    }),
  });
  assert.equal(input.disabled, true);
  assert.equal(harness.document.getElementById("openvila-messages").children.length, 2);

  eventSource.emit("delta", {
    data: JSON.stringify({
      id: "stream-answer",
      role: "assistant",
      delta: "available within 14 days.",
    }),
  });

  eventSource.emit("message", {
    data: JSON.stringify({
      id: "stream-answer",
      role: "assistant",
      content: "Refunds are available within 14 days.",
      ts: new Date(Date.now() + 10).toISOString(),
    }),
  });

  assert.equal(input.disabled, false);
  assert.equal(submit.disabled, false);
  assert.equal(submit.textContent, "Send");
  assert.equal(harness.document.getElementById("openvila-messages").children.length, 2);
});

test("widget restores the form when submitting a message fails", async () => {
  const harness = await loadWidget({ failPost: true });
  const form = harness.document.getElementById("openvila-form");
  const input = harness.document.getElementById("openvila-input");
  const submit = harness.document.getElementById("openvila-submit");

  input.value = "Can you help me?";
  await form.emit("submit", submitEvent());

  assert.equal(input.disabled, false);
  assert.equal(submit.disabled, false);
  assert.equal(submit.textContent, "Send");
});
