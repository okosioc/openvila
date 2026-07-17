import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureWidgetPreview } from "../../src/core/install.js";
import { initializeRuntime, runtimePaths } from "../../src/core/runtime.js";

test("ensureWidgetPreview refreshes preview assets on every run", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-preview-test-"));
  await initializeRuntime(cwd);
  const paths = runtimePaths(cwd);

  try {
    await ensureWidgetPreview(cwd);
    assert.match(await fs.readFile(paths.widget, "utf8"), /OpenVila Widget Preview/);
    assert.match(await fs.readFile(paths.widgetScript, "utf8"), /openvila-launcher/);

    await fs.writeFile(paths.widget, "custom widget preview", "utf8");
    await ensureWidgetPreview(cwd);
    assert.match(await fs.readFile(paths.widget, "utf8"), /OpenVila Widget Preview/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
