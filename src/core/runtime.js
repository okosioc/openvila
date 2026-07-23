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
    "chats/",
    "**/__pycache__/",
    "*.pyc",
    "*.pyo",
    "*.pyd",
    "",
  ].join("\n");
}

export function runtimePaths(cwd) {
  const base = path.join(cwd, OPENVILA_DIR_NAME);
  return {
    base,
    config: path.join(base, "config.yaml"),
    scanPlan: path.join(base, "scan-plan"),
    runtimeGitignore: path.join(base, ".gitignore"),
    knowledges: path.join(base, "knowledges"),
    knowledgeDocs: path.join(base, "knowledges", "docs"),
    vilas: path.join(base, "vilas"),
    logs: path.join(base, "logs"),
    chats: path.join(base, "chats"),
    telegramState: path.join(base, "chats", "telegram.json"),
    widget: path.join(base, "widget.html"),
    widgetScript: path.join(base, "widget.js"),
    knowledgeIndex: path.join(base, "knowledges", "index.md"),
    knowledgeManifest: path.join(base, "knowledges", "manifest.json"),
  };
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
    chat: {
      welcome_message: {
        zh: "您好，我是AI客服Vila，我可以根据网站的知识库回答您的问题。如果不满意我的答案，您可以直接召唤人工客服。",
        en: "Hello, I'm Vila, your AI customer service assistant. I can answer questions based on this website's knowledge base. If you're not satisfied with my answer, you can ask for human support.",
      },
    },
    marketplace: {
      endpoint: "https://openvila.com/api/v1",
    },
    scan: {
      llm_candidate_limit: 420,
      llm_table_candidate_limit: 260,
      llm_compile_batch_chars: 100000,
      llm_compile_doc_chars: 18000,
      llm_compile_max_tokens: 4800,
      db_auto_max_tables: 6,
      db_auto_max_candidate_tables: 360,
      db_auto_query_limit: 80,
    },
    run: {
      port: 9394,
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
  return "OpenVila runtime is not initialized in this directory.";
}

async function ensureRuntimeDirectories(paths) {
  await ensureDir(paths.base);
  await ensureDir(paths.knowledges);
  await ensureDir(paths.knowledgeDocs);
  await ensureDir(paths.vilas);
  await ensureDir(paths.logs);
  await ensureDir(paths.chats);
}

async function ensureRuntimeFiles(cwd, paths, options = {}) {
  if (!(await exists(paths.telegramState))) {
    await fs.writeFile(paths.telegramState, '{\n  "last_update_id": 0\n}\n', "utf8");
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
