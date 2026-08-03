import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileSkillMarkdown, readSkill } from "../../src/core/skill.js";
import { initializeRuntime, runtimePaths } from "../../src/core/runtime.js";

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
              when_to_use: "Search site models by name or alias.",
              input_schema: [{ name: "query", description: "Requested name", required: true }],
              process: {
                method: "GET",
                url: "http://127.0.0.1:5001/api/search",
                query: { q: "{{query}}" },
                body: {},
              },
              output_instruction: "For each result object, use its name as the link text and /tag/ followed by its _id as the Markdown link URL. Return no more than five links. If there are no results, say no matching girls were found.",
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
    "",
    "## Output",
    "The API returns [{_id, name}, ...]. Use [name](/tag/_id) as a Markdown link for each girl, up to five results. If there are no results, say no matching girls were found.",
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
  assert.equal(skill.source_path, ".openvila/skills/search.md");
  assert.deepEqual(skill.process.query, { q: "{{query}}" });
  assert.match(llm.requests[0].messages[0].content, /output_instruction preserves the returned fields and visitor-facing transformation/);
  assert.match(llm.requests[0].messages[1].content, /visitor searches for a model by name or alias/);
  assert.match(llm.requests[0].messages[1].content, /Use \[name\]\(\/tag\/_id\) as a Markdown link/);
  assert.match(skill.output_instruction, /name as the link text and \/tag\/ followed by its _id/);
});

test("readSkill adapts legacy fields to the four-section definition", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-skill-legacy-test-"));
  context.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await initializeRuntime(cwd);
  await fs.writeFile(
    path.join(runtimePaths(cwd).skills, "search.json"),
    `${JSON.stringify({
      name: "search",
      enabled: true,
      description: "Search site models by name.",
      inputs: [{ name: "query", description: "Requested name", required: true }],
      request: { method: "GET", url: "http://127.0.0.1:5001/api/search", query: { q: "{{query}}" }, body: {} },
      result_instruction: "Return matches as Markdown links.",
      source_path: ".openvila/skills/search.md",
      updated_at: "2026-07-31T00:00:00.000Z",
    }, null, 2)}\n`,
    "utf8",
  );

  const skill = await readSkill(cwd, "search");

  assert.equal(skill.when_to_use, "Search site models by name.");
  assert.deepEqual(skill.input_schema, [{ name: "query", description: "Requested name", required: true }]);
  assert.deepEqual(skill.process.query, { q: "{{query}}" });
  assert.equal(skill.output_instruction, "Return matches as Markdown links.");
});
