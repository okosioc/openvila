import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runVila } from "../../src/commands/vila.js";
import { initializeRuntime, loadConfig, runtimePaths, saveConfig } from "../../src/core/runtime.js";

const PET_URL = "https://petdex.dev/pets/arcueid-dress";
const METADATA_URL = "https://assets.petdex.dev/pets/arcueid-dress/sprite.json";
const SPRITESHEET_URL = "https://assets.petdex.dev/pets/arcueid-dress/sprite.webp";

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function webpSpritesheet(width = 1536, height = 1872) {
  const content = Buffer.alloc(30);
  content.write("RIFF", 0, "ascii");
  content.writeUInt32LE(22, 4);
  content.write("WEBPVP8X", 8, "ascii");
  content.writeUInt32LE(10, 16);
  content[24] = (width - 1) & 0xff;
  content[25] = ((width - 1) >> 8) & 0xff;
  content[26] = ((width - 1) >> 16) & 0xff;
  content[27] = (height - 1) & 0xff;
  content[28] = ((height - 1) >> 8) & 0xff;
  content[29] = ((height - 1) >> 16) & 0xff;
  return content;
}

test("runVila downloads and activates a Petdex vila", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-vila-test-"));
  context.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await initializeRuntime(cwd);

  const fetched = [];
  const logs = [];
  const ctx = { cwd, locale: "en", log: (line) => logs.push(String(line)) };
  const fetch = async (url) => {
    fetched.push(String(url));
    if (url === "https://petdex.dev/api/manifest") {
      return jsonResponse({
        pets: [{ slug: "arcueid-dress", displayName: "Arcueid Dress", petJsonUrl: METADATA_URL, spritesheetUrl: SPRITESHEET_URL }],
      });
    }
    if (url === METADATA_URL) {
      return jsonResponse({ id: "arcueid-dress", displayName: "Arcueid Dress", description: "A Petdex Vila.", spritesheetPath: "spritesheet.webp" });
    }
    if (url === SPRITESHEET_URL) {
      return new Response(webpSpritesheet());
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await runVila(ctx, { positionals: ["install", PET_URL], options: {} }, { fetch });

  const paths = runtimePaths(cwd);
  const vilaDir = path.join(paths.vilas, "arcueid-dress");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(vilaDir, "pet.json"), "utf8")), {
    id: "arcueid-dress",
    displayName: "Arcueid Dress",
    description: "A Petdex Vila.",
    spritesheetPath: "spritesheet.webp",
  });
  assert.deepEqual(await fs.readFile(path.join(vilaDir, "spritesheet.webp")), webpSpritesheet());
  assert.equal((await loadConfig(cwd)).vila.active, "arcueid-dress");
  assert.deepEqual(fetched, ["https://petdex.dev/api/manifest", METADATA_URL, SPRITESHEET_URL]);
  assert.ok(logs.some((line) => line.includes("installed and activated: Arcueid Dress")));
});

test("runVila rejects an unknown Petdex pet", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-vila-test-"));
  context.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await initializeRuntime(cwd);

  await assert.rejects(
    runVila(
      { cwd, locale: "en", log: () => undefined },
      { positionals: ["install", "https://petdex.dev/pets/not-installed"], options: {} },
      { fetch: async () => jsonResponse({ pets: [] }) },
    ),
    /Petdex pet not found: not-installed/,
  );
});

test("runVila rejects a WebP spritesheet with an unsupported size", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-vila-test-"));
  context.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await initializeRuntime(cwd);

  const fetch = async (url) => {
    if (url === "https://petdex.dev/api/manifest") {
      return jsonResponse({
        pets: [{ slug: "arcueid-dress", displayName: "Arcueid Dress", petJsonUrl: METADATA_URL, spritesheetUrl: SPRITESHEET_URL }],
      });
    }
    if (url === METADATA_URL) {
      return jsonResponse({ displayName: "Arcueid Dress" });
    }
    if (url === SPRITESHEET_URL) {
      return new Response(webpSpritesheet(768, 936));
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await assert.rejects(
    runVila(
      { cwd, locale: "en", log: () => undefined },
      { positionals: ["install", PET_URL], options: {} },
      { fetch },
    ),
    /Petdex WebP spritesheet must be 1536x1872 pixels; received 768x936/,
  );

  const paths = runtimePaths(cwd);
  await assert.rejects(fs.access(path.join(paths.vilas, "arcueid-dress")));
  assert.equal((await loadConfig(cwd)).vila.active, "");
});

test("runVila deletes and deactivates an installed vila", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-vila-test-"));
  context.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await initializeRuntime(cwd);

  const paths = runtimePaths(cwd);
  const vilaDir = path.join(paths.vilas, "arcueid-dress");
  await fs.mkdir(vilaDir);
  await fs.writeFile(path.join(vilaDir, "pet.json"), '{"id":"arcueid-dress"}\n', "utf8");
  const config = await loadConfig(cwd);
  config.vila.active = "arcueid-dress";
  await saveConfig(cwd, config);

  await runVila(
    { cwd, locale: "en", log: () => undefined },
    { positionals: ["delete", "arcueid-dress"], options: {} },
  );

  await assert.rejects(fs.access(vilaDir));
  assert.equal((await loadConfig(cwd)).vila.active, "");
});

test("runVila disables the active vila without deleting it", async (context) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "openvila-vila-test-"));
  context.after(() => fs.rm(cwd, { recursive: true, force: true }));
  await initializeRuntime(cwd);

  const paths = runtimePaths(cwd);
  const vilaDir = path.join(paths.vilas, "arcueid-dress");
  await fs.mkdir(vilaDir);
  await fs.writeFile(path.join(vilaDir, "pet.json"), '{"id":"arcueid-dress"}\n', "utf8");
  const config = await loadConfig(cwd);
  config.vila.active = "arcueid-dress";
  await saveConfig(cwd, config);

  await runVila(
    { cwd, locale: "en", log: () => undefined },
    { positionals: ["disable"], options: {} },
  );

  await fs.access(vilaDir);
  assert.equal((await loadConfig(cwd)).vila.active, "");
});
