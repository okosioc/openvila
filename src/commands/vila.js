import fs from "node:fs/promises";
import path from "node:path";
import { ensureRuntime, loadConfig, runtimePaths, saveConfig } from "../core/runtime.js";
import { readTextSafe } from "../utils/fs.js";
import { pick } from "../i18n/messages.js";

const PETDEX_MANIFEST_URL = "https://petdex.dev/api/manifest";
const VILA_SPRITESHEET_WIDTH = 1536;
const VILA_SPRITESHEET_HEIGHT = 1872;

function usage(locale) {
  return pick(
    locale,
    ["用法:", "  /vila list", "  /vila install https://petdex.dev/pets/<slug>", "  /vila disable", "  /vila delete <slug>"].join("\n"),
    ["Usage:", "  /vila list", "  /vila install https://petdex.dev/pets/<slug>", "  /vila disable", "  /vila delete <slug>"].join("\n"),
  );
}

function petdexSlugFromUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("Vila install URL must be a Petdex pet page URL.");
  }

  const match = url.protocol === "https:" && url.hostname === "petdex.dev" && url.pathname.match(/^\/pets\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/);
  if (!match) {
    throw new Error("Vila install URL must be https://petdex.dev/pets/<slug>.");
  }
  return match[1];
}

function petdexAssetUrl(value, label) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error(`Petdex ${label} URL is invalid.`);
  }

  if (url.protocol !== "https:" || url.hostname !== "assets.petdex.dev") {
    throw new Error(`Petdex ${label} URL is invalid.`);
  }
  return url.toString();
}

async function fetchJson(fetchImpl, url, label) {
  let response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new Error(`Petdex ${label} request failed: ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(`Petdex ${label} request failed: ${response.status}`);
  }

  try {
    return await response.json();
  } catch (error) {
    throw new Error(`Petdex ${label} response is not valid JSON: ${error.message}`);
  }
}

async function fetchBinary(fetchImpl, url) {
  let response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new Error(`Petdex spritesheet request failed: ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(`Petdex spritesheet request failed: ${response.status}`);
  }

  const content = Buffer.from(await response.arrayBuffer());
  if (content.length === 0) {
    throw new Error("Petdex spritesheet response is empty.");
  }
  return content;
}

function spritesheetPath(spritesheetUrl) {
  const extension = path.extname(new URL(spritesheetUrl).pathname).toLowerCase();
  if (extension !== ".webp" && extension !== ".png") {
    throw new Error("Petdex spritesheet format must be WebP or PNG.");
  }
  return `spritesheet${extension}`;
}

function webpDimensions(content) {
  if (content.length < 30 || content.toString("ascii", 0, 4) !== "RIFF" || content.toString("ascii", 8, 12) !== "WEBP") {
    return null;
  }

  const format = content.toString("ascii", 12, 16);
  if (format === "VP8X") {
    return {
      width: 1 + content[24] + (content[25] << 8) + (content[26] << 16),
      height: 1 + content[27] + (content[28] << 8) + (content[29] << 16),
    };
  }
  if (format === "VP8 ") {
    return {
      width: content.readUInt16LE(26) & 0x3fff,
      height: content.readUInt16LE(28) & 0x3fff,
    };
  }
  if (format === "VP8L" && content[20] === 0x2f) {
    return {
      width: 1 + content[21] + ((content[22] & 0x3f) << 8),
      height: 1 + (content[22] >> 6) + (content[23] << 2) + ((content[24] & 0x0f) << 10),
    };
  }
  return null;
}

function validateWebpSpritesheet(content) {
  const dimensions = webpDimensions(content);
  if (!dimensions) {
    throw new Error("Petdex WebP spritesheet is invalid.");
  }
  if (dimensions.width !== VILA_SPRITESHEET_WIDTH || dimensions.height !== VILA_SPRITESHEET_HEIGHT) {
    throw new Error(
      `Petdex WebP spritesheet must be ${VILA_SPRITESHEET_WIDTH}x${VILA_SPRITESHEET_HEIGHT} pixels; received ${dimensions.width}x${dimensions.height}.`,
    );
  }
}

async function installFromPetdex(cwd, slug, fetchImpl) {
  const manifest = await fetchJson(fetchImpl, PETDEX_MANIFEST_URL, "manifest");
  const pet = Array.isArray(manifest?.pets) ? manifest.pets.find((item) => item?.slug === slug) : null;
  if (!pet) {
    throw new Error(`Petdex pet not found: ${slug}`);
  }

  const metadataUrl = petdexAssetUrl(pet.petJsonUrl, "metadata");
  const assetUrl = petdexAssetUrl(pet.spritesheetUrl, "spritesheet");
  const [metadata, spritesheet] = await Promise.all([
    fetchJson(fetchImpl, metadataUrl, "metadata"),
    fetchBinary(fetchImpl, assetUrl),
  ]);
  const spritePath = spritesheetPath(assetUrl);
  if (spritePath === "spritesheet.webp") {
    validateWebpSpritesheet(spritesheet);
  }
  const vila = {
    id: slug,
    displayName: String(metadata?.displayName || pet.displayName || slug),
    description: String(metadata?.description || ""),
    spritesheetPath: spritePath,
  };

  const paths = runtimePaths(cwd);
  const target = path.join(paths.vilas, slug);
  const temporary = path.join(paths.vilas, `.install-${slug}-${process.pid}-${Date.now()}`);

  await fs.mkdir(temporary);
  try {
    await fs.writeFile(path.join(temporary, "pet.json"), `${JSON.stringify(vila, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(temporary, spritePath), spritesheet);
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }

  return { target, vila };
}

async function installedVilas(paths) {
  const entries = await fs.readdir(paths.vilas, { withFileTypes: true });
  const vilas = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const petJsonPath = path.join(paths.vilas, entry.name, "pet.json");
    if (await readTextSafe(petJsonPath)) {
      vilas.push(entry.name);
    }
  }
  return vilas.sort();
}

export async function runVila(ctx, argv, dependencies = {}) {
  await ensureRuntime(ctx.cwd);
  const config = await loadConfig(ctx.cwd);
  const paths = runtimePaths(ctx.cwd);
  const fetchImpl = dependencies.fetch || fetch;
  const [sub, value] = argv.positionals;

  if (!sub) {
    ctx.log(usage(ctx.locale));
    return;
  }

  if (sub === "list") {
    const vilas = await installedVilas(paths);
    if (vilas.length === 0) {
      ctx.log(pick(ctx.locale, "暂无已安装精灵", "No installed vilas"));
      return;
    }
    const active = String(config.vila?.active || "");
    ctx.log(vilas.map((id) => (id === active ? `* ${id}` : `  ${id}`)).join("\n"));
    return;
  }

  if (sub === "install") {
    if (!value) {
      ctx.log(usage(ctx.locale));
      return;
    }

    const slug = petdexSlugFromUrl(value);
    ctx.log(pick(ctx.locale, `[vila] 正在从 Petdex 下载: ${slug}`, `[vila] Downloading from Petdex: ${slug}`));
    const installed = await installFromPetdex(ctx.cwd, slug, fetchImpl);
    config.vila = { ...(config.vila || {}), active: slug };
    await saveConfig(ctx.cwd, config);
    ctx.log(
      pick(
        ctx.locale,
        `精灵已安装并激活: ${installed.vila.displayName}\n${installed.target}`,
        `Vila installed and activated: ${installed.vila.displayName}\n${installed.target}`,
      ),
    );
    return;
  }

  if (sub === "disable") {
    config.vila = { ...(config.vila || {}), active: "" };
    await saveConfig(ctx.cwd, config);
    ctx.log(pick(ctx.locale, "精灵已停用", "Vila disabled"));
    return;
  }

  if (sub === "delete") {
    if (!value) {
      ctx.log(usage(ctx.locale));
      return;
    }

    const slug = String(value);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      ctx.log(pick(ctx.locale, `精灵不存在: ${slug}`, `Vila not found: ${slug}`));
      return;
    }
    const target = path.join(paths.vilas, slug);
    if (!(await readTextSafe(path.join(target, "pet.json")))) {
      ctx.log(pick(ctx.locale, `精灵不存在: ${slug}`, `Vila not found: ${slug}`));
      return;
    }

    await fs.rm(target, { recursive: true, force: true });
    if (config.vila?.active === slug) {
      config.vila.active = "";
      await saveConfig(ctx.cwd, config);
    }
    ctx.log(pick(ctx.locale, `已移除: ${slug}`, `Removed: ${slug}`));
    return;
  }

  ctx.log(usage(ctx.locale));
}
