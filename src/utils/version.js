import fs from "node:fs/promises";

let cachedCliVersion = null;

export async function cliVersion() {
  if (cachedCliVersion) {
    return cachedCliVersion;
  }

  try {
    const packagePath = new URL("../../package.json", import.meta.url);
    const raw = await fs.readFile(packagePath, "utf8");
    const parsed = JSON.parse(raw);
    cachedCliVersion = `v${parsed.version || "0.0.0"}`;
  } catch {
    cachedCliVersion = "v0.0.0";
  }

  return cachedCliVersion;
}
