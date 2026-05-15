import { cleanTextForPrompt } from "../utils/fs.js";
import { resolveLlmSettings } from "./runtime.js";

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, timer };
}

function trimSlash(value) {
  return value.replace(/\/+$/, "");
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
  const llm = resolveLlmSettings(config, process.env);
  const endpoint = llm.endpoint;
  const apiKey = llm.apiKey;
  const model = llm.model;

  if (!endpoint || !apiKey) {
    return {
      ok: false,
      error: `Missing LLM endpoint or API key. Set ${llm.endpointEnvNames[0]} / ${llm.apiKeyEnvNames[0]} or save llm.endpoint / llm.api_key in .openvila/config.yaml`,
    };
  }

  const url = resolveChatCompletionsUrl(endpoint);
  const { controller, timer } = withTimeout(config.llm.timeout_ms || 45000);

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
        temperature: overrides.temperature ?? 0.2,
        max_tokens: overrides.maxTokens ?? 700,
      }),
      signal: controller.signal,
    });

    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        error: `LLM error ${response.status}: ${JSON.stringify(json).slice(0, 400)}`,
      };
    }

    const content = json?.choices?.[0]?.message?.content;
    if (!content) {
      return {
        ok: false,
        error: "LLM response has no content",
      };
    }

    return {
      ok: true,
      content: cleanTextForPrompt(String(content), 20000),
      raw: json,
    };
  } catch (error) {
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
