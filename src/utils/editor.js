import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { splitArgs } from "./args.js";

function configuredEditor() {
  return String(process.env.VISUAL || process.env.EDITOR || "vi").trim();
}

export async function editTextInEditor(text, fileName = "scan-plan") {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-editor-"));
  const filePath = path.join(tempDir, fileName);
  await fs.writeFile(filePath, String(text ?? ""), "utf8");

  try {
    const [editor, ...editorArgs] = splitArgs(configuredEditor());
    if (!editor) {
      throw new Error("EDITOR is not configured");
    }

    const result = spawnSync(editor, [...editorArgs, filePath], { stdio: "inherit" });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`Editor exited with status ${result.status}`);
    }

    return fs.readFile(filePath, "utf8");
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
