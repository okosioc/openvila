import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureRuntime } from "./runtime.js";

const WIDGET_ASSET_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../widget");
const WIDGET_HTML_ASSET = path.join(WIDGET_ASSET_DIR, "widget.html");
const WIDGET_SCRIPT_ASSET = path.join(WIDGET_ASSET_DIR, "widget.js");

async function copyWidgetAssets(paths) {
  await fs.copyFile(WIDGET_HTML_ASSET, paths.widget);
  await fs.copyFile(WIDGET_SCRIPT_ASSET, paths.widgetScript);
}

export async function ensureWidgetPreview(cwd) {
  const paths = await ensureRuntime(cwd);
  await copyWidgetAssets(paths);

  return {
    preview: paths.widget,
    script: paths.widgetScript,
  };
}
