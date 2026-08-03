import fs from "node:fs/promises";
import path from "node:path";
import { chatCompletion, extractJsonObject } from "./llm.js";
import { ensureRuntime, runtimePaths } from "./runtime.js";
import { exists, readTextSafe, writeText } from "../utils/fs.js";

const SKILL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const SKILL_RESPONSE_MAX_CHARS = 60000;
const SKILL_REQUEST_TIMEOUT_MS = 10000;

function normalizeSkillName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error("Skill name must use lowercase letters, numbers, _ or -, and start with a letter");
  }
  return name;
}

function normalizeInputSchema(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  return value
    .map((item) => {
      const name = String(item?.name || "").trim();
      const description = String(item?.description || "").trim();
      if (!/^[a-z][a-z0-9_]{0,63}$/i.test(name) || seen.has(name)) {
        return null;
      }
      seen.add(name);
      return {
        name,
        description,
        required: Boolean(item?.required),
      };
    })
    .filter(Boolean);
}

function normalizeTemplateMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) continue;
    output[normalizedKey] = String(item ?? "");
  }
  return output;
}

function normalizeProcess(value) {
  if (!value || typeof value !== "object") {
    throw new Error("Skill compiler did not return a process definition");
  }

  const method = String(value.method || "GET").trim().toUpperCase();
  const url = String(value.url || "").trim();
  if (method !== "GET" && method !== "POST") {
    throw new Error("Skill process method must be GET or POST");
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new Error("Skill process URL must be an absolute http(s) URL");
  }

  return {
    method,
    url,
    query: normalizeTemplateMap(value.query),
    body: normalizeTemplateMap(value.body),
  };
}

function templateInputs(value) {
  const inputs = new Set();
  const pattern = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi;
  let match = pattern.exec(String(value || ""));
  while (match) {
    inputs.add(match[1]);
    match = pattern.exec(String(value || ""));
  }
  return inputs;
}

function validateProcessInputs(process, inputSchema) {
  const available = new Set(inputSchema.map((input) => input.name));
  const values = [process.url, ...Object.values(process.query), ...Object.values(process.body)];
  for (const value of values) {
    for (const name of templateInputs(value)) {
      if (!available.has(name)) {
        throw new Error(`Skill process references undeclared input: ${name}`);
      }
    }
  }
  if (process.method === "GET" && Object.keys(process.body).length > 0) {
    throw new Error("GET Skill processes cannot define a body");
  }
}

function normalizeSkillDefinition(name, value, options = {}) {
  const whenToUse = String(value?.when_to_use || value?.description || "").trim();
  const outputInstruction = String(value?.output_instruction || value?.result_instruction || "").trim();
  if (!whenToUse) {
    throw new Error("Skill compiler did not return when_to_use");
  }
  if (!outputInstruction) {
    throw new Error("Skill compiler did not return output_instruction");
  }

  const inputSchema = normalizeInputSchema(value?.input_schema || value?.inputs);
  const process = normalizeProcess(value?.process || value?.request);
  validateProcessInputs(process, inputSchema);

  return {
    name: normalizeSkillName(name),
    enabled: options.enabled !== undefined ? Boolean(options.enabled) : Boolean(value?.enabled),
    when_to_use: whenToUse,
    input_schema: inputSchema,
    process,
    output_instruction: outputInstruction,
    source_path: String(options.sourcePath || value?.source_path || "").trim(),
    updated_at: String(options.updatedAt || value?.updated_at || new Date().toISOString()),
  };
}

function applyTemplate(value, input, encode = false) {
  return String(value || "").replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi, (matched, name) => {
    if (!Object.hasOwn(input, name)) {
      throw new Error(`Skill input is missing: ${name}`);
    }
    const text = String(input[name] ?? "");
    return encode ? encodeURIComponent(text) : text;
  });
}

function normalizeSkillInput(skill, value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const input = {};
  for (const field of skill.input_schema) {
    const text = String(raw[field.name] ?? "").trim();
    if (field.required && !text) {
      return null;
    }
    if (text) {
      input[field.name] = text;
    }
  }
  return input;
}

function trimResponseText(value) {
  const text = String(value || "");
  return text.length > SKILL_RESPONSE_MAX_CHARS ? `${text.slice(0, SKILL_RESPONSE_MAX_CHARS)}\n...[truncated]` : text;
}

export function skillSourcePath(cwd, name) {
  return path.join(runtimePaths(cwd).skills, `${normalizeSkillName(name)}.md`);
}

export function skillRuntimePath(cwd, name) {
  return path.join(runtimePaths(cwd).skills, `${normalizeSkillName(name)}.json`);
}

export function skillTemplate(name) {
  const safeName = normalizeSkillName(name);
  return [
    `# ${safeName}`,
    "",
    "## When to use",
    "Describe which visitor requests should use this skill.",
    "",
    "## Input",
    "Describe the values to extract from the visitor message.",
    "",
    "## Process",
    "Describe the HTTP method, complete API URL, request parameters, and how input values are used.",
    "",
    "## Output",
    "Describe returned fields, exact visitor-facing transformations or links, empty-result behavior, and any limits.",
    "",
  ].join("\n");
}

// 核心逻辑! 将用户输入的md文件编译为可以被代码处理的json格式
export async function compileSkillMarkdown(config, name, source) {
  const skillName = normalizeSkillName(name);
  const messages = [
    {
      role: "system",
      content: [
        "You compile a site owner's natural-language Skill document into a confirmed runtime definition.",
        'Return JSON only: {"when_to_use":"...","input_schema":[{"name":"query","description":"...","required":true}],"process":{"method":"GET","url":"https://...","query":{"q":"{{query}}"},"body":{}},"output_instruction":"..."}.',
        "Use only HTTP method, URL, parameters, and result behavior explicitly stated in the source document. Never invent an API endpoint, parameter, or result field.",
        "when_to_use must state when the Skill should be used. input_schema must contain only values needed by process. process supports GET or POST only. output_instruction preserves the returned fields and visitor-facing transformation.",
      ].join("\n"),
    },
    {
      role: "user",
      content: `Skill name: ${skillName}\n\nSource document:\n${String(source || "").trim()}`,
    },
  ];
  const completion = await chatCompletion(config, messages, {
    temperature: 0,
    maxTokens: 2400,
    trace: "skill:compile",
  });
  if (!completion.ok) {
    throw new Error(`Skill compilation failed: ${completion.error}`);
  }

  return normalizeSkillDefinition(skillName, extractJsonObject(completion.content), {
    enabled: true,
    sourcePath: `.openvila/skills/${skillName}.md`,
  });
}

export async function saveSkill(cwd, skill) {
  const paths = await ensureRuntime(cwd);
  const normalized = normalizeSkillDefinition(skill?.name, skill, {
    enabled: skill?.enabled,
    sourcePath: skill?.source_path,
    updatedAt: skill?.updated_at,
  });
  await writeText(path.join(paths.skills, `${normalized.name}.json`), `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

export async function readSkill(cwd, name) {
  const target = skillRuntimePath(cwd, name);
  const raw = await readTextSafe(target);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return normalizeSkillDefinition(name, parsed, {
      enabled: parsed?.enabled,
      sourcePath: parsed?.source_path,
      updatedAt: parsed?.updated_at,
    });
  } catch {
    return null;
  }
}

export async function listSkills(cwd, options = {}) {
  const paths = await ensureRuntime(cwd);
  const enabledOnly = Boolean(options.enabledOnly);
  const entries = await fs.readdir(paths.skills, { withFileTypes: true });
  const skills = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const name = entry.name.replace(/\.json$/, "");
    const skill = await readSkill(cwd, name);
    if (skill && (!enabledOnly || skill.enabled)) {
      skills.push(skill);
    }
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

export async function setSkillEnabled(cwd, name, enabled) {
  const skill = await readSkill(cwd, name);
  if (!skill) {
    throw new Error(`Skill not found: ${normalizeSkillName(name)}`);
  }
  return saveSkill(cwd, { ...skill, enabled: Boolean(enabled), updated_at: new Date().toISOString() });
}

export async function deleteSkill(cwd, name) {
  const source = skillSourcePath(cwd, name);
  const runtime = skillRuntimePath(cwd, name);
  const sourceExists = await exists(source);
  const runtimeExists = await exists(runtime);
  if (!sourceExists && !runtimeExists) {
    return false;
  }
  await fs.rm(source, { force: true });
  await fs.rm(runtime, { force: true });
  return true;
}

export function normalizeSkillCalls(rawCalls, skills) {
  const byName = new Map((skills || []).map((skill) => [skill.name, skill]));
  const calls = [];
  const used = new Set();
  for (const raw of Array.isArray(rawCalls) ? rawCalls : []) {
    const name = String(raw?.name || "").trim().toLowerCase();
    const skill = byName.get(name);
    if (!skill || used.has(name)) continue;
    const input = normalizeSkillInput(skill, raw?.input);
    if (!input) continue;
    used.add(name);
    calls.push({ skill, input });
  }
  return calls.slice(0, 2);
}

export async function executeSkillCall(call) {
  const skill = call?.skill;
  const input = call?.input || {};
  if (!skill || !skill.process) {
    throw new Error("Skill call is invalid");
  }

  const url = new URL(applyTemplate(skill.process.url, input, true));
  for (const [key, value] of Object.entries(skill.process.query || {})) {
    url.searchParams.set(key, applyTemplate(value, input));
  }

  const request = {
    method: skill.process.method,
    url: url.toString(),
    query: Object.fromEntries(url.searchParams),
    body: null,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SKILL_REQUEST_TIMEOUT_MS);
  try {
    const options = {
      method: request.method,
      signal: controller.signal,
      headers: {},
    };
    if (request.method === "POST") {
      options.headers["Content-Type"] = "application/json";
      request.body = Object.fromEntries(
        Object.entries(skill.process.body || {}).map(([key, value]) => [key, applyTemplate(value, input)]),
      );
      options.body = JSON.stringify(request.body);
    }
    const response = await fetch(url, options);
    const raw = trimResponseText(await response.text());
    const responseInfo = {
      status: response.status,
      status_text: response.statusText,
      content_type: response.headers.get("content-type") || "",
    };
    if (!response.ok) {
      const error = new Error(`Skill request failed: HTTP ${response.status}${raw ? `: ${raw.slice(0, 500)}` : ""}`);
      error.skill_response = { ...responseInfo, body: raw.slice(0, 1000) };
      throw error;
    }
    let data = raw;
    try {
      data = JSON.parse(raw);
    } catch {}
    return {
      name: skill.name,
      output_instruction: skill.output_instruction,
      data,
      request,
      response: responseInfo,
    };
  } catch (error) {
    if (error && typeof error === "object") {
      error.skill_request = request;
      if (controller.signal.aborted) {
        error.skill_timeout_ms = SKILL_REQUEST_TIMEOUT_MS;
      }
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
