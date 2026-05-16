import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { detectLocaleFromEnv } from "../i18n/messages.js";
import { ensureDir, exists } from "../utils/fs.js";

export const OPENVILA_DIR_NAME = ".openvila";
export const LLM_ENDPOINT_ENV_CANDIDATES = ["openvila_llm_endpoint", "OPENVILA_LLM_ENDPOINT"];
export const LLM_API_KEY_ENV_CANDIDATES = ["openvila_llm_api_key", "OPENVILA_LLM_API_KEY"];
export const LLM_MODEL_ENV_CANDIDATES = ["openvila_llm_model", "OPENVILA_LLM_MODEL"];

function runtimeGitignoreTemplate() {
  return [
    "# OpenVila runtime local ignores",
    "logs/",
    "actions/.venv/",
    "**/__pycache__/",
    "*.pyc",
    "*.pyo",
    "*.pyd",
    "knowledges/raw/",
    "",
  ].join("\n");
}

export function runtimePaths(cwd) {
  const base = path.join(cwd, OPENVILA_DIR_NAME);
  return {
    base,
    config: path.join(base, "config.yaml"),
    runtimeGitignore: path.join(base, ".gitignore"),
    knowledges: path.join(base, "knowledges"),
    knowledgeTopics: path.join(base, "knowledges", "topics"),
    knowledgeRaw: path.join(base, "knowledges", "raw"),
    actions: path.join(base, "actions"),
    vilas: path.join(base, "vilas"),
    logs: path.join(base, "logs"),
    widget: path.join(base, "widget.html"),
    widgetScript: path.join(base, "widget.js"),
    reviewQueue: path.join(base, "logs", "review-queue.json"),
    knowledgeIndex: path.join(base, "knowledges", "index.md"),
    knowledgeManifest: path.join(base, "knowledges", "manifest.json"),
  };
}

function generateOwnerToken() {
  return crypto.randomBytes(20).toString("hex");
}

export function defaultConfig() {
  return {
    version: 1,
    language: detectLocaleFromEnv(),
    llm: {
      endpoint_env: "openvila_llm_endpoint",
      api_key_env: "openvila_llm_api_key",
      model_env: "openvila_llm_model",
      endpoint: "",
      api_key: "",
      model: "",
      timeout_ms: 45000,
    },
    channels: {
      telegram: null,
      feishu: null,
    },
    marketplace: {
      endpoint: "https://openvila.com/api/v1",
    },
    scan: {
      llm_candidate_limit: 420,
      llm_extract_batch_chars: 100000,
      llm_extract_topic_chars: 18000,
      llm_extract_topic_max_docs: 18,
      llm_extract_max_tokens: 4200,
    },
    run: {
      port: 3800,
      owner_token: generateOwnerToken(),
    },
    install: {
      conservative: true,
    },
  };
}

function uniqueNames(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim().length > 0))];
}

function firstEnvValue(env, names) {
  for (const name of names) {
    const value = String(env[name] || "").trim();
    if (value) {
      return {
        name,
        value,
      };
    }
  }
  return null;
}

export function resolveLlmSettings(config, env = {}) {
  const llm = config?.llm || {};
  const endpointEnvNames = uniqueNames([...LLM_ENDPOINT_ENV_CANDIDATES, llm.endpoint_env]);
  const apiKeyEnvNames = uniqueNames([...LLM_API_KEY_ENV_CANDIDATES, llm.api_key_env]);
  const modelEnvNames = uniqueNames([...LLM_MODEL_ENV_CANDIDATES, llm.model_env]);

  const endpointFromEnv = firstEnvValue(env, endpointEnvNames);
  const apiKeyFromEnv = firstEnvValue(env, apiKeyEnvNames);
  const modelFromEnv = firstEnvValue(env, modelEnvNames);

  const endpointFromConfig = String(llm.endpoint || "").trim();
  const apiKeyFromConfig = String(llm.api_key || "").trim();
  const modelFromConfig = String(llm.model || "").trim();

  return {
    endpoint: endpointFromEnv?.value || endpointFromConfig || "",
    apiKey: apiKeyFromEnv?.value || apiKeyFromConfig || "",
    model: modelFromEnv?.value || modelFromConfig || "",
    endpointFromEnv: endpointFromEnv?.name || "",
    apiKeyFromEnv: apiKeyFromEnv?.name || "",
    modelFromEnv: modelFromEnv?.name || "",
    endpointEnvNames,
    apiKeyEnvNames,
    modelEnvNames,
    modelFromConfig,
  };
}

function notInitializedError() {
  return "OpenVila runtime is not initialized in this directory. Run /init first.";
}

async function ensureRuntimeDirectories(paths) {
  await ensureDir(paths.base);
  await ensureDir(paths.knowledges);
  await ensureDir(paths.knowledgeTopics);
  await ensureDir(paths.knowledgeRaw);
  await ensureDir(paths.actions);
  await ensureDir(paths.vilas);
  await ensureDir(paths.logs);
}

async function ensureRuntimeFiles(cwd, paths, options = {}) {
  if (!(await exists(paths.reviewQueue))) {
    await fs.writeFile(paths.reviewQueue, "[]\n", "utf8");
  }

  if (!(await exists(paths.runtimeGitignore))) {
    await fs.writeFile(paths.runtimeGitignore, runtimeGitignoreTemplate(), "utf8");
  }

  if (options.forceConfigReset || !(await exists(paths.config))) {
    await saveConfig(cwd, defaultConfig());
  }
}

export async function isRuntimeInitialized(cwd) {
  const paths = runtimePaths(cwd);
  return exists(paths.config);
}

export async function initializeRuntime(cwd, options = {}) {
  const paths = runtimePaths(cwd);
  const alreadyInitialized = await isRuntimeInitialized(cwd);

  await ensureRuntimeDirectories(paths);
  await ensureRuntimeFiles(cwd, paths, { forceConfigReset: Boolean(options.force) });

  return {
    created: !alreadyInitialized,
    paths,
  };
}

export async function ensureRuntime(cwd, options = {}) {
  const createIfMissing = Boolean(options.createIfMissing);
  const initialized = await isRuntimeInitialized(cwd);

  if (!initialized) {
    if (!createIfMissing) {
      throw new Error(notInitializedError());
    }
    await initializeRuntime(cwd);
  }

  const paths = runtimePaths(cwd);
  await ensureRuntimeDirectories(paths);
  await ensureRuntimeFiles(cwd, paths);

  return paths;
}

function mergeDeep(base, extra) {
  if (!extra || typeof extra !== "object") {
    return structuredClone(base);
  }

  const output = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      key in output &&
      output[key] &&
      typeof output[key] === "object" &&
      !Array.isArray(output[key])
    ) {
      output[key] = mergeDeep(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

export async function loadConfig(cwd, options = {}) {
  const paths = await ensureRuntime(cwd, { createIfMissing: Boolean(options.createIfMissing) });
  const raw = await fs.readFile(paths.config, "utf8");
  const parsed = YAML.parse(raw) || {};
  const merged = mergeDeep(defaultConfig(), parsed);
  return merged;
}

export async function saveConfig(cwd, config) {
  const paths = runtimePaths(cwd);
  await ensureDir(paths.base);
  const yamlText = YAML.stringify(config);
  await fs.writeFile(paths.config, yamlText, "utf8");
}
