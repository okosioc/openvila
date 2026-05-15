import fs from "node:fs/promises";
import path from "node:path";
import { ensureRuntime, loadConfig, runtimePaths } from "../core/runtime.js";
import { exists, readTextSafe, writeText } from "../utils/fs.js";
import { pick } from "../i18n/messages.js";

function usage(locale) {
  return pick(
    locale,
    [
      "用法:",
      "  /vila list",
      "  /vila install <id>",
      "  /vila install <id> --file ./my-vila.json",
      "  /vila remove <id>",
    ].join("\n"),
    [
      "Usage:",
      "  /vila list",
      "  /vila install <id>",
      "  /vila install <id> --file ./my-vila.json",
      "  /vila remove <id>",
    ].join("\n"),
  );
}

async function installFromFile(cwd, id, filePath) {
  const source = await fs.readFile(path.resolve(cwd, filePath), "utf8");
  const parsed = JSON.parse(source);
  const paths = runtimePaths(cwd);
  const target = path.join(paths.vilas, `${id}.json`);
  await writeText(target, `${JSON.stringify(parsed, null, 2)}\n`);
  return target;
}

async function installFromMarketplace(cwd, config, id) {
  const endpoint = String(config.marketplace?.endpoint || "https://openvila.com/api/v1").replace(/\/+$/, "");
  const url = `${endpoint}/vilas/${encodeURIComponent(id)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Marketplace request failed: ${resp.status}`);
  }

  const data = await resp.json();
  const paths = runtimePaths(cwd);
  const target = path.join(paths.vilas, `${id}.json`);
  await writeText(target, `${JSON.stringify(data, null, 2)}\n`);
  return target;
}

export async function runVila(ctx, argv) {
  await ensureRuntime(ctx.cwd);
  const config = await loadConfig(ctx.cwd);
  const paths = runtimePaths(ctx.cwd);
  const [sub, id] = argv.positionals;

  if (!sub) {
    ctx.log(usage(ctx.locale));
    return;
  }

  if (sub === "list") {
    const files = await fs.readdir(paths.vilas, { withFileTypes: true });
    const ids = files
      .filter((f) => f.isFile() && f.name.endsWith(".json"))
      .map((f) => f.name.replace(/\.json$/, ""));

    if (ids.length === 0) {
      ctx.log(pick(ctx.locale, "暂无已安装精灵", "No installed vilas"));
      return;
    }
    ctx.log(ids.join("\n"));
    return;
  }

  if (sub === "install") {
    if (!id) {
      ctx.log(usage(ctx.locale));
      return;
    }

    let target;
    if (argv.options.file) {
      target = await installFromFile(ctx.cwd, id, String(argv.options.file));
    } else {
      target = await installFromMarketplace(ctx.cwd, config, id);
    }

    ctx.log(pick(ctx.locale, `精灵安装成功: ${target}`, `Vila installed: ${target}`));
    return;
  }

  if (sub === "remove") {
    if (!id) {
      ctx.log(usage(ctx.locale));
      return;
    }

    const filePath = path.join(paths.vilas, `${id}.json`);
    if (!(await exists(filePath))) {
      ctx.log(pick(ctx.locale, `精灵不存在: ${id}`, `Vila not found: ${id}`));
      return;
    }

    await fs.rm(filePath, { force: true });
    ctx.log(pick(ctx.locale, `已移除: ${id}`, `Removed: ${id}`));
    return;
  }

  ctx.log(usage(ctx.locale));
}
