import { cleanTextForPrompt } from "../utils/fs.js";
import { writeGlobalLog } from "./logging.js";
import { resolveLlmSettings } from "./runtime.js";

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, timer };
}

function trimSlash(value) {
  return value.replace(/\/+$/, "");
}

function modelLogPrefix(model) {
  const raw = String(model || "").trim();
  if (!raw) {
    return "unknown";
  }
  const tail = raw.split("/").filter(Boolean).pop() || raw;
  return tail.replace(/\s+/g, "-");
}

function decodeEscapedNewlines(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n");
}

function sanitizeForLogContent(value, maxLen = 30000) {
  return cleanTextForPrompt(decodeEscapedNewlines(String(value ?? "")), maxLen);
}

function serializeLlmResponse(response) {
  try {
    return decodeEscapedNewlines(JSON.stringify(response)) || "{}";
  } catch {
    return decodeEscapedNewlines(response) || "[unserializable response]";
  }
}

function parseLlmResponse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function providerError(llmPrefix, response, status, statusText = "") {
  const fullResponse = serializeLlmResponse(response);
  const summary = sanitizeForLogContent(fullResponse, 2000);
  const statusLabel = `${status}${statusText ? ` ${statusText}` : ""}`;
  return {
    log: `${llmPrefix}> [error] HTTP ${statusLabel}\nresponse: ${fullResponse}`,
    error: `LLM error ${status}: ${summary}`,
  };
}

function emptyContentError(llmPrefix, response, reason = "no content in choices[0].message.content") {
  const fullResponse = serializeLlmResponse(response);
  const summary = sanitizeForLogContent(fullResponse, 2000);
  return {
    log: `${llmPrefix}> [error] ${reason}\nresponse: ${fullResponse}`,
    error: `LLM response has no content: ${summary}`,
  };
}

function messageContentToText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object") {
          if (typeof item.text === "string") {
            return item.text;
          }
          try {
            return JSON.stringify(item);
          } catch {
            return String(item);
          }
        }
        return String(item ?? "");
      })
      .join("\n");
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") {
      return content.text;
    }
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return String(content ?? "");
}

function prefixedContentBlock(prefix, content) {
  const normalized = sanitizeForLogContent(content, 60000);
  if (!normalized) {
    return `${prefix}>`;
  }
  return `${prefix}> ${normalized}`;
}

function createLlmLogEmitters(trace, messages) {
  const inputBlock = formatLlmMessagesBlock(messages);
  const emitInputLog = () => {
    const sections = [`[llm] ${trace} input:`];
    if (inputBlock) {
      sections.push(inputBlock);
    }
    writeGlobalLog(sections.join("\n\n"));
  };
  const emitOutputLog = (outputBlock) => {
    const sections = ["[llm] output:"];
    if (outputBlock) {
      sections.push(String(outputBlock));
    }
    writeGlobalLog(sections.join("\n\n"));
  };
  return { emitInputLog, emitOutputLog };
}

function extractStreamDeltaText(payload) {
  const choice = payload?.choices?.[0];
  if (!choice || typeof choice !== "object") {
    return "";
  }

  const delta = choice.delta || {};
  const deltaContent = delta.content;
  if (typeof deltaContent === "string") {
    return deltaContent;
  }
  if (Array.isArray(deltaContent)) {
    return deltaContent
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && typeof item.text === "string") return item.text;
        return "";
      })
      .join("");
  }

  const text = choice.text;
  if (typeof text === "string") {
    return text;
  }

  const messageContent = choice?.message?.content;
  if (typeof messageContent === "string") {
    return messageContent;
  }

  return "";
}

function formatLlmMessagesBlock(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "";
  }
  const blocks = [];
  for (const message of messages) {
    const role = String(message?.role || "user").toLowerCase();
    const prefix = role === "system" ? "system" : role === "assistant" ? "assistant" : "user";
    blocks.push(prefixedContentBlock(prefix, messageContentToText(message?.content)));
  }
  return blocks.join("\n\n");
}

export function resolveChatCompletionsUrl(endpoint) {
  if (!endpoint) {
    return null;
  }

  const normalized = trimSlash(endpoint.trim());
  if (/\/chat\/completions$/i.test(normalized)) {
    return normalized;
  }

  if (/\/v\d+$/i.test(normalized)) {
    return `${normalized}/chat/completions`;
  }

  if (/\/v\d+\//i.test(normalized)) {
    return `${normalized}/chat/completions`;
  }

  return `${normalized}/v1/chat/completions`;
}

export async function chatCompletion(config, messages, overrides = {}) {
  const trace = String(overrides.trace || "chat_completion");
  const { emitInputLog, emitOutputLog } = createLlmLogEmitters(trace, messages);

  const llm = resolveLlmSettings(config, process.env);
  const endpoint = llm.endpoint;
  const apiKey = llm.apiKey;
  const model = llm.model;
  const llmPrefix = modelLogPrefix(model);
  const requestTemperature = overrides.temperature ?? 0.2;
  const requestMaxTokens = overrides.maxTokens ?? 700;
  const timeoutMs = config?.llm?.timeout_ms || 45000;

  emitInputLog();

  if (!endpoint || !apiKey || !model) {
    emitOutputLog(`${llmPrefix}> [error] missing endpoint/api_key/model`);
    return {
      ok: false,
      error: `Missing LLM endpoint, API key, or model. Set ${llm.endpointEnvNames[0]} / ${llm.apiKeyEnvNames[0]} / ${llm.modelEnvNames[0]} or save llm.endpoint / llm.api_key / llm.model in .openvila/config.yaml`,
    };
  }

  const url = resolveChatCompletionsUrl(endpoint);
  const { controller, timer } = withTimeout(timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: requestTemperature,
        max_tokens: requestMaxTokens,
      }),
      signal: controller.signal,
    });

    const responseText = await response.text();
    const json = parseLlmResponse(responseText);
    if (!response.ok) {
      const failure = providerError(llmPrefix, json ?? responseText, response.status, response.statusText);
      emitOutputLog(failure.log);
      return {
        ok: false,
        error: failure.error,
      };
    }

    if (!json) {
      const failure = emptyContentError(llmPrefix, responseText, "provider response is not valid JSON");
      emitOutputLog(failure.log);
      return {
        ok: false,
        error: failure.error,
      };
    }

    const content = json?.choices?.[0]?.message?.content;
    if (!content) {
      const failure = emptyContentError(llmPrefix, json);
      emitOutputLog(failure.log);
      return {
        ok: false,
        error: failure.error,
      };
    }

    emitOutputLog(prefixedContentBlock(llmPrefix, content));

    return {
      ok: true,
      content: cleanTextForPrompt(String(content), 20000),
      raw: json,
    };
  } catch (error) {
    emitOutputLog(`${llmPrefix}> [error] ${error.message}`);
    return {
      ok: false,
      error: `LLM request failed: ${error.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function chatCompletionStream(config, messages, overrides = {}) {
  const trace = String(overrides.trace || "chat_completion_stream");
  const { emitInputLog, emitOutputLog } = createLlmLogEmitters(trace, messages);

  const llm = resolveLlmSettings(config, process.env);
  const endpoint = llm.endpoint;
  const apiKey = llm.apiKey;
  const model = llm.model;
  const llmPrefix = modelLogPrefix(model);
  const requestTemperature = overrides.temperature ?? 0.2;
  const requestMaxTokens = overrides.maxTokens ?? 700;
  const timeoutMs = config?.llm?.timeout_ms || 45000;
  const onDelta = typeof overrides.onDelta === "function" ? overrides.onDelta : () => undefined;

  emitInputLog();

  if (!endpoint || !apiKey || !model) {
    emitOutputLog(`${llmPrefix}> [error] missing endpoint/api_key/model`);
    return {
      ok: false,
      error: `Missing LLM endpoint, API key, or model. Set ${llm.endpointEnvNames[0]} / ${llm.apiKeyEnvNames[0]} / ${llm.modelEnvNames[0]} or save llm.endpoint / llm.api_key / llm.model in .openvila/config.yaml`,
    };
  }

  const url = resolveChatCompletionsUrl(endpoint);
  const { controller, timer } = withTimeout(timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: requestTemperature,
        max_tokens: requestMaxTokens,
        stream: true,
      }),
      signal: controller.signal,
    });

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();

    if (!response.ok) {
      const responseText = await response.text();
      const json = parseLlmResponse(responseText);
      const failure = providerError(llmPrefix, json ?? responseText, response.status, response.statusText);
      emitOutputLog(failure.log);
      return {
        ok: false,
        error: failure.error,
      };
    }

    // Some providers ignore stream=true and still return a full JSON payload.
    if (!contentType.includes("text/event-stream")) {
      const responseText = await response.text();
      const json = parseLlmResponse(responseText);
      if (!json) {
        const failure = emptyContentError(llmPrefix, responseText, "provider response is not valid JSON");
        emitOutputLog(failure.log);
        return {
          ok: false,
          error: failure.error,
        };
      }
      const content = json?.choices?.[0]?.message?.content;
      if (!content) {
        const failure = emptyContentError(llmPrefix, json);
        emitOutputLog(failure.log);
        return {
          ok: false,
          error: failure.error,
        };
      }

      const normalized = cleanTextForPrompt(String(content), 20000);
      onDelta(normalized);
      emitOutputLog(prefixedContentBlock(llmPrefix, normalized));
      return {
        ok: true,
        content: normalized,
        raw: json,
      };
    }

    if (!response.body || typeof response.body.getReader !== "function") {
      emitOutputLog(`${llmPrefix}> [error] response body is not stream-readable`);
      return {
        ok: false,
        error: "LLM stream body unavailable",
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let accumulated = "";
    let done = false;
    let lastPayload = null;

    while (!done) {
      const { value, done: readDone } = await reader.read();
      if (readDone) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith(":")) {
          continue;
        }
        if (!line.startsWith("data:")) {
          continue;
        }
        const data = line.slice(5).trim();
        if (!data) {
          continue;
        }
        if (data === "[DONE]") {
          done = true;
          break;
        }

        let payload = null;
        try {
          payload = JSON.parse(data);
        } catch {
          payload = null;
        }
        if (!payload) {
          continue;
        }

        lastPayload = payload;

        const delta = extractStreamDeltaText(payload);
        if (!delta) {
          continue;
        }

        accumulated += delta;
        onDelta(delta);
      }
    }

    if (!accumulated) {
      const failure = emptyContentError(llmPrefix, lastPayload, "empty stream content");
      emitOutputLog(failure.log);
      return {
        ok: false,
        error: failure.error,
      };
    }

    const finalText = cleanTextForPrompt(accumulated, 20000);
    emitOutputLog(prefixedContentBlock(llmPrefix, finalText));
    return {
      ok: true,
      content: finalText,
      raw: null,
    };
  } catch (error) {
    emitOutputLog(`${llmPrefix}> [error] ${error.message}`);
    return {
      ok: false,
      error: `LLM request failed: ${error.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function extractJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    return null;
  }
  const maybe = text.slice(start, end + 1);
  try {
    return JSON.parse(maybe);
  } catch {
    return null;
  }
}
