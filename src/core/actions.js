import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import YAML from "yaml";
import { ensureDir, exists, readTextSafe, writeText } from "../utils/fs.js";
import { ensureRuntime, runtimePaths } from "./runtime.js";

function validActionName(name) {
  return /^[a-zA-Z_][a-zA-Z0-9_\-]*$/.test(name);
}

function actionScriptTemplate(name) {
  return `#!/usr/bin/env python3
"""
OpenVila action: ${name}
Only site owner should create/modify this file.
"""

import argparse
import json
from typing import Any, Dict


def run(payload: Dict[str, Any]) -> Dict[str, Any]:
    # TODO: replace with your own business logic.
    return {
        "ok": True,
        "action": "${name}",
        "echo": payload,
        "message": "Action executed"
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload", default="{}")
    args = parser.parse_args()

    try:
        payload = json.loads(args.payload)
    except Exception:
        payload = {}

    result = run(payload)
    print(json.dumps(result, ensure_ascii=False))
`;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        reject(new Error(`Exit ${code}: ${stderr || stdout}`));
      }
    });
  });
}

export async function ensureActionVenv(cwd) {
  const paths = await ensureRuntime(cwd);
  const venvDir = path.join(paths.actions, ".venv");
  const pythonPath = process.platform === "win32" ? path.join(venvDir, "Scripts", "python.exe") : path.join(venvDir, "bin", "python");

  if (await exists(pythonPath)) {
    return { venvDir, pythonPath, created: false };
  }

  await ensureDir(paths.actions);
  await runCommand("python3", ["-m", "venv", venvDir], { cwd });

  return { venvDir, pythonPath, created: true };
}

export async function createAction(cwd, name) {
  if (!validActionName(name)) {
    throw new Error("Invalid action name. Use letters/numbers/_/- and start with letter or _");
  }

  const paths = await ensureRuntime(cwd);
  await ensureActionVenv(cwd);

  const scriptPath = path.join(paths.actions, `${name}.py`);
  if (await exists(scriptPath)) {
    throw new Error(`Action already exists: ${name}`);
  }

  await writeText(scriptPath, actionScriptTemplate(name));

  const metaPath = path.join(paths.actions, `${name}.yaml`);
  const meta = {
    name,
    requires_owner_review: true,
    created_at: new Date().toISOString(),
  };
  await writeText(metaPath, YAML.stringify(meta));

  return { scriptPath, metaPath };
}

export async function listActions(cwd) {
  const paths = await ensureRuntime(cwd);
  const entries = await fs.readdir(paths.actions, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".py"))
    .map((entry) => entry.name.slice(0, -3))
    .sort();
}

export async function runAction(cwd, name, payload = {}) {
  const paths = await ensureRuntime(cwd);
  const { pythonPath } = await ensureActionVenv(cwd);

  const scriptPath = path.join(paths.actions, `${name}.py`);
  if (!(await exists(scriptPath))) {
    throw new Error(`Action not found: ${name}`);
  }

  const result = await runCommand(pythonPath, [scriptPath, "--payload", JSON.stringify(payload)], { cwd });
  const output = (result.stdout || "").trim();

  try {
    return { ok: true, output: JSON.parse(output || "{}"), raw: output };
  } catch {
    return { ok: true, output: { raw: output }, raw: output };
  }
}

async function loadQueue(queuePath) {
  const text = (await readTextSafe(queuePath)) || "[]";
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveQueue(queuePath, items) {
  await writeText(queuePath, `${JSON.stringify(items, null, 2)}\n`);
}

export async function queueActionReview(cwd, actionName, payload, meta = {}) {
  const paths = await ensureRuntime(cwd);
  const queue = await loadQueue(paths.reviewQueue);

  const item = {
    id: crypto.randomUUID(),
    action: actionName,
    payload,
    status: "pending",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    meta,
  };

  queue.push(item);
  await saveQueue(paths.reviewQueue, queue);
  return item;
}

export async function listReviewQueue(cwd, status = null) {
  const paths = await ensureRuntime(cwd);
  const queue = await loadQueue(paths.reviewQueue);
  if (!status) {
    return queue;
  }
  return queue.filter((item) => item.status === status);
}

export async function updateReviewItem(cwd, id, patch) {
  const paths = await ensureRuntime(cwd);
  const queue = await loadQueue(paths.reviewQueue);
  const idx = queue.findIndex((item) => item.id === id);
  if (idx < 0) {
    return null;
  }

  queue[idx] = {
    ...queue[idx],
    ...patch,
    updated_at: new Date().toISOString(),
  };

  await saveQueue(paths.reviewQueue, queue);
  return queue[idx];
}

export async function approveReviewItem(cwd, id) {
  const pending = await listReviewQueue(cwd);
  const target = pending.find((item) => item.id === id);
  if (!target) {
    throw new Error(`Review item not found: ${id}`);
  }
  if (target.status !== "pending") {
    throw new Error(`Review item is not pending: ${target.status}`);
  }

  const execution = await runAction(cwd, target.action, target.payload || {});
  const updated = await updateReviewItem(cwd, id, {
    status: "approved",
    execution,
  });

  return updated;
}

export async function rejectReviewItem(cwd, id, reason = "rejected by owner") {
  const target = await updateReviewItem(cwd, id, {
    status: "rejected",
    reason,
  });

  if (!target) {
    throw new Error(`Review item not found: ${id}`);
  }
  return target;
}
