import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  ".openvila",
  "node_modules",
  "dist",
  "build",
  "venv",
  ".venv",
  "__pycache__",
]);

export async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function readTextSafe(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function writeText(filePath, content) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  await fs.writeFile(filePath, content, "utf8");
}

export async function listFilesRecursive(rootDir, opts = {}) {
  const ignoredDirs = opts.ignoredDirs || DEFAULT_IGNORED_DIRS;
  const maxFileSize = opts.maxFileSize || 256 * 1024;
  const maxFiles = opts.maxFiles || 600;
  const onlyExt = opts.onlyExt || null;
  const result = [];

  async function walk(current) {
    if (result.length >= maxFiles) {
      return;
    }

    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (result.length >= maxFiles) {
        return;
      }

      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name)) {
          continue;
        }
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (onlyExt && onlyExt.length > 0) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!onlyExt.includes(ext)) {
          continue;
        }
      }

      const stat = await fs.stat(fullPath);
      if (stat.size > maxFileSize) {
        continue;
      }

      result.push(fullPath);
    }
  }

  await walk(rootDir);
  return result;
}

export function cleanTextForPrompt(text, maxLen = 12000) {
  const normalized = text.replace(/\u0000/g, "").trim();
  if (normalized.length <= maxLen) {
    return normalized;
  }
  return `${normalized.slice(0, maxLen)}\n\n...[truncated]`;
}

export function toPosixPath(p) {
  return p.split(path.sep).join("/");
}

export function sanitizeDocNamePart(value, fallback = "part", maxLen = 48) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, maxLen);
  return normalized || fallback;
}

export function docBaseNameNoHash(source) {
  const normalizedSource = toPosixPath(String(source || "").trim()).toLowerCase();
  return (
    normalizedSource
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 170) || "source"
  );
}

export function normalizeStoredPath(value, prefix) {
  const normalized = toPosixPath(String(value || "").trim()).replace(/^\/+/, "");
  if (!normalized) {
    return "";
  }
  if (normalized.startsWith(`${prefix}/`)) {
    return normalized;
  }
  return `${prefix}/${normalized}`;
}

export function storedPathToAbsolute(baseDir, storedPath) {
  return path.join(baseDir, storedPath);
}
