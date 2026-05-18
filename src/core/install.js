import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureRuntime } from "./runtime.js";
import { listFilesRecursive, readTextSafe } from "../utils/fs.js";

const INJECT_SNIPPET = "<!-- OpenVila Widget -->\n<script src=\"/openvila/widget.js\" defer></script>";
const WIDGET_ASSET_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../widget");
const WIDGET_HTML_ASSET = path.join(WIDGET_ASSET_DIR, "widget.html");
const WIDGET_SCRIPT_ASSET = path.join(WIDGET_ASSET_DIR, "widget.js");

async function copyWidgetAssets(paths) {
  await fs.copyFile(WIDGET_HTML_ASSET, paths.widget);
  await fs.copyFile(WIDGET_SCRIPT_ASSET, paths.widgetScript);
}

async function injectSnippetToFile(targetPath) {
  const raw = await readTextSafe(targetPath);
  if (!raw) {
    return false;
  }
  if (raw.includes("openvila/widget.js")) {
    return false;
  }

  let next;
  if (raw.includes("</body>")) {
    next = raw.replace("</body>", `${INJECT_SNIPPET}\n</body>`);
  } else {
    next = `${raw}\n${INJECT_SNIPPET}\n`;
  }

  await fs.writeFile(targetPath, next, "utf8");
  return true;
}

async function findHtmlCandidates(cwd) {
  const files = await listFilesRecursive(cwd, {
    maxFiles: 400,
    onlyExt: [".html", ".htm"],
  });

  return files.sort((a, b) => {
    const score = (p) => {
      const rel = path.relative(cwd, p).toLowerCase();
      if (rel.startsWith("templates/")) return 0;
      if (rel.includes("index")) return 1;
      return 5;
    };
    return score(a) - score(b);
  });
}

async function attachRunScript(cwd) {
  const packagePath = path.join(cwd, "package.json");
  const raw = await readTextSafe(packagePath);
  if (!raw) {
    return { changed: false, reason: "package.json not found" };
  }

  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return { changed: false, reason: "package.json parse failed" };
  }

  pkg.scripts = pkg.scripts || {};
  if (!pkg.scripts["openvila:run"]) {
    pkg.scripts["openvila:run"] = "openvila run";
  }

  await fs.writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  return { changed: true };
}

export async function installWidget(cwd, options = {}) {
  const paths = await ensureRuntime(cwd);
  await copyWidgetAssets(paths);

  const result = {
    preview: paths.widget,
    script: paths.widgetScript,
    injected: [],
    snippet: INJECT_SNIPPET,
    startup: null,
  };

  if (options.apply) {
    const candidates = await findHtmlCandidates(cwd);
    const targets = options.all ? candidates : candidates.slice(0, 1);

    for (const target of targets) {
      const changed = await injectSnippetToFile(target);
      if (changed) {
        result.injected.push(path.relative(cwd, target));
      }
    }
  }

  if (options.attachStart) {
    result.startup = await attachRunScript(cwd);
  }

  return result;
}
