import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runSkill } from "../../src/commands/skill.js";
import { initializeRuntime, runtimePaths } from "../../src/core/runtime.js";

function compiledSkill() {
  return {
    name: "search",
    enabled: true,
    when_to_use: "Search site items by name.",
    input_schema: [{ name: "query", description: "Item name", required: true }],
    process: {
      method: "GET",
      url: "http://127.0.0.1:5001/api/search",
      query: { q: "{{query}}" },
      body: {},
    },
    output_instruction: "Return matching items as Markdown links.",
    source_path: ".openvila/skills/search.md",
    updated_at: "2026-07-29T00:00:00.000Z",
  };
}

test("runSkill manages a compiled natural-language skill", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-skill-test-"));
  context.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await initializeRuntime(cwd);

  const logs = [];
  const ctx = {
    cwd,
    locale: "en",
    log: (line) => logs.push(String(line)),
    ask: async () => "y",
    editSkillText: async () => [
      "# search",
      "",
      "## When to use",
      "Use for item searches.",
      "",
      "## Process",
      "Call GET http://127.0.0.1:5001/api/search.",
    ].join("\n"),
  };
  const dependencies = {
    compileSkillMarkdown: async () => compiledSkill(),
  };

  await runSkill(ctx, { positionals: ["add", "search"], options: {} }, dependencies);

  const paths = runtimePaths(cwd);
  const stored = JSON.parse(await fs.readFile(path.join(paths.skills, "search.json"), "utf8"));
  assert.equal(stored.enabled, true);
  assert.match(await fs.readFile(path.join(paths.skills, "search.md"), "utf8"), /Use for item searches/);
  assert.ok(logs.some((line) => line.includes("Runtime definition to confirm")));

  await runSkill(ctx, { positionals: ["disable", "search"], options: {} });
  assert.equal(JSON.parse(await fs.readFile(path.join(paths.skills, "search.json"), "utf8")).enabled, false);

  await runSkill(ctx, { positionals: ["enable", "search"], options: {} });
  assert.equal(JSON.parse(await fs.readFile(path.join(paths.skills, "search.json"), "utf8")).enabled, true);

  await runSkill(ctx, { positionals: ["list"], options: {} });
  assert.ok(logs.some((line) => line.includes("search\tenabled\tSearch site items by name.")));

  await runSkill(ctx, { positionals: ["delete", "search"], options: { yes: true } });
  await assert.rejects(fs.access(path.join(paths.skills, "search.json")), { code: "ENOENT" });
  await assert.rejects(fs.access(path.join(paths.skills, "search.md")), { code: "ENOENT" });
});
