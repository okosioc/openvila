import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { compileSkillMarkdown } from "../../src/core/skill.js";

async function readRequestBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
  }
  return JSON.parse(body);
}

async function createCompilerLlm() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    requests.push(await readRequestBody(request));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              description: "Search site models by name or alias.",
              inputs: [{ name: "query", description: "Requested name", required: true }],
              request: {
                method: "GET",
                url: "http://127.0.0.1:5001/api/search",
                query: { q: "{{query}}" },
                body: {},
              },
              result_instruction: "Return matching items as Markdown links.",
            }),
          },
        }],
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Compiler LLM did not expose a TCP port");
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

test("compileSkillMarkdown converts a natural-language skill into a validated runtime definition", async (context) => {
  const llm = await createCompilerLlm();
  context.after(() => llm.close());
  const source = [
    "# search",
    "",
    "## When to use",
    "Use when a visitor searches for a model by name or alias.",
    "",
    "## Process",
    "Call GET http://127.0.0.1:5001/api/search with q set to the requested name.",
  ].join("\n");

  const skill = await compileSkillMarkdown(
    {
      llm: {
        endpoint: llm.endpoint,
        api_key: "test-key",
        model: "test-model",
      },
    },
    "search",
    source,
  );

  assert.equal(skill.name, "search");
  assert.equal(skill.enabled, true);
  assert.deepEqual(skill.request.query, { q: "{{query}}" });
  assert.match(llm.requests[0].messages[0].content, /Never invent an API endpoint/);
  assert.match(llm.requests[0].messages[1].content, /visitor searches for a model by name or alias/);
});
