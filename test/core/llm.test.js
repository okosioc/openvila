import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { chatCompletion, chatCompletionStream } from "../../src/core/llm.js";
import { setGlobalLogWriter } from "../../src/core/logging.js";

async function startEmptyContentServer() {
  const responseBody = {
    id: "request-1",
    model: "deepseek-v4-flash",
    choices: [
      {
        finish_reason: "content_filter",
        message: {
          role: "assistant",
          content: null,
          refusal: "The provider blocked this response.",
        },
      },
    ],
    diagnostic: `${"x".repeat(2200)}-diagnostic-end`,
  };
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(responseBody));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("LLM test server did not expose a TCP port");
  }

  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function startProviderErrorServer() {
  const responseBody = {
    error: {
      message: "Provider returned error",
      code: "model_not_available",
      details: "deepseek-v4-flash is temporarily unavailable",
    },
    request_id: "deepinfra-request-123",
  };
  const server = http.createServer((request, response) => {
    response.writeHead(503, "Service Unavailable", { "Content-Type": "application/json" });
    response.end(JSON.stringify(responseBody));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("LLM test server did not expose a TCP port");
  }

  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function startContentServer(content, finishReason = "stop") {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: finishReason,
            message: { role: "assistant", content },
          },
        ],
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("LLM test server did not expose a TCP port");
  }

  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function startSlowServer() {
  const server = http.createServer((request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "Too late" } }] }));
    }, 80);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("LLM test server did not expose a TCP port");
  }

  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

for (const [name, completion] of [
  ["chatCompletion", chatCompletion],
  ["chatCompletionStream JSON fallback", chatCompletionStream],
]) {
  test(`${name} logs the provider response when content is empty`, async (context) => {
    const server = await startEmptyContentServer();
    const logs = [];
    setGlobalLogWriter((text) => logs.push(text));
    context.after(async () => {
      setGlobalLogWriter(null);
      await server.close();
    });

    const result = await completion(
      {
        llm: {
          endpoint: server.endpoint,
          api_key: "test-key",
          model: "deepseek-v4-flash",
        },
      },
      [{ role: "user", content: "Plan files" }],
    );

    assert.equal(result.ok, false);
    assert.match(result.error, /content_filter/);
    assert.match(result.error, /The provider blocked this response/);
    assert.match(logs.join("\n"), /response: .*content_filter/);
    assert.match(logs.join("\n"), /The provider blocked this response/);
    assert.match(logs.join("\n"), /diagnostic-end/);
    assert.doesNotMatch(result.error, /diagnostic-end/);
  });
}

test("chatCompletion keeps a successful response longer than 20000 characters", async (context) => {
  const content = JSON.stringify({ knowledge_files: ["x".repeat(21000)] });
  const server = await startContentServer(content);
  context.after(() => server.close());

  const result = await chatCompletion(
    {
      llm: {
        endpoint: server.endpoint,
        api_key: "test-key",
        model: "test-model",
      },
    },
    [{ role: "user", content: "Plan files" }],
  );

  assert.equal(result.ok, true);
  assert.equal(result.content, content);
});

for (const [name, completion] of [
  ["chatCompletion", chatCompletion],
  ["chatCompletionStream JSON fallback", chatCompletionStream],
]) {
  test(`${name} rejects responses cut off by the output token limit`, async (context) => {
    const server = await startContentServer("partial response", "length");
    const logs = [];
    setGlobalLogWriter((text) => logs.push(text));
    context.after(async () => {
      setGlobalLogWriter(null);
      await server.close();
    });

    const result = await completion(
      {
        llm: {
          endpoint: server.endpoint,
          api_key: "test-key",
          model: "deepseek-v4-flash",
        },
      },
      [{ role: "user", content: "Plan files" }],
      { maxTokens: 1234 },
    );

    assert.equal(result.ok, false);
    assert.equal(result.error, "LLM output reached max_tokens (1234); finish_reason: length");
    assert.match(logs.join("\n"), /\[error\] output token limit reached/);
    assert.match(logs.join("\n"), /finish_reason: length/);
    assert.match(logs.join("\n"), /max_tokens: 1234/);
  });
}

for (const [name, completion] of [
  ["chatCompletion", chatCompletion],
  ["chatCompletionStream", chatCompletionStream],
]) {
  test(`${name} identifies local request timeouts`, async (context) => {
    const server = await startSlowServer();
    const logs = [];
    setGlobalLogWriter((text) => logs.push(text));
    context.after(async () => {
      setGlobalLogWriter(null);
      await server.close();
    });

    const result = await completion(
      {
        llm: {
          endpoint: server.endpoint,
          api_key: "test-key",
          model: "deepseek-v4-flash",
          timeout_ms: 10,
        },
      },
      [{ role: "user", content: "Plan files" }],
    );

    assert.equal(result.ok, false);
    assert.equal(result.error, "LLM request timed out after 10ms");
    assert.match(logs.join("\n"), /\[error\] request timeout/);
    assert.match(logs.join("\n"), /timeout_ms: 10/);
    assert.match(logs.join("\n"), /provider_response: unavailable/);
  });
}

for (const [name, completion] of [
  ["chatCompletion", chatCompletion],
  ["chatCompletionStream", chatCompletionStream],
]) {
  test(`${name} logs the full provider error response`, async (context) => {
    const server = await startProviderErrorServer();
    const logs = [];
    setGlobalLogWriter((text) => logs.push(text));
    context.after(async () => {
      setGlobalLogWriter(null);
      await server.close();
    });

    const result = await completion(
      {
        llm: {
          endpoint: server.endpoint,
          api_key: "test-key",
          model: "deepseek-v4-flash",
        },
      },
      [{ role: "user", content: "Plan files" }],
    );

    assert.equal(result.ok, false);
    assert.match(result.error, /503/);
    assert.match(result.error, /model_not_available/);
    assert.match(logs.join("\n"), /\[error\] HTTP 503 Service Unavailable/);
    assert.match(logs.join("\n"), /response: .*model_not_available/);
    assert.match(logs.join("\n"), /deepinfra-request-123/);
  });
}
