import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI_PATH = fileURLToPath(new URL("../src/index.js", import.meta.url));

function runCli(cwd, command) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, command], { cwd });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("scan and run require prior UI initialization", async (testContext) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-ui-required-"));
  testContext.after(() => fs.rm(cwd, { recursive: true, force: true }));

  for (const command of ["scan", "run"]) {
    const result = await runCli(cwd, command);

    assert.equal(result.code, 1);
    assert.match(result.stdout, /openvila/i);
    assert.equal(result.stderr, "");
  }

  await assert.rejects(fs.access(path.join(cwd, ".openvila")));
});
