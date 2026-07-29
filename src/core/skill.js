import fs from "node:fs/promises";
import path from "node:path";
import { chatCompletion, extractJsonObject } from "./llm.js";
import { ensureRuntime, runtimePaths } from "./runtime.js";
import { exists, readTextSafe, writeText } from "../utils/fs.js";

const SKILL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const SKILL_RESPONSE_MAX_CHARS = 60000;

function normalizeSkillName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error("Skill name must use lowercase letters, numbers, _ or -, and start with a letter");
  }
  return name;
}

function normalizeInputs(value) {
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

function normalizeRequest(value) {
  if (!value || typeof value !== "object") {
    throw new Error("Skill compiler did not return a request definition");
  }

  const method = String(value.method || "GET").trim().toUpperCase();
  const url = String(value.url || "").trim();
  if (method !== "GET" && method !== "POST") {
    throw new Error("Skill request method must be GET or POST");
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new Error("Skill request URL must be an absolute http(s) URL");
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

function validateRequestInputs(request, inputs) {
  const available = new Set(inputs.map((input) => input.name));
  const values = [request.url, ...Object.values(request.query), ...Object.values(request.body)];
  for (const value of values) {
    for (const name of templateInputs(value)) {
      if (!available.has(name)) {
        throw new Error(`Skill request references undeclared input: ${name}`);
      }
    }
  }
  if (request.method === "GET" && Object.keys(request.body).length > 0) {
    throw new Error("GET Skill requests cannot define a body");
  }
}

function normalizeSkillDefinition(name, value, options = {}) {
  const description = String(value?.description || "").trim();
  const resultInstruction = String(value?.result_instruction || "").trim();
  if (!description) {
    throw new Error("Skill compiler did not return a description");
  }
  if (!resultInstruction) {
    throw new Error("Skill compiler did not return result_instruction");
  }

  const inputs = normalizeInputs(value?.inputs);
  const request = normalizeRequest(value?.request);
  validateRequestInputs(request, inputs);

  return {
    name: normalizeSkillName(name),
    enabled: options.enabled !== undefined ? Boolean(options.enabled) : Boolean(value?.enabled),
    description,
    inputs,
    request,
    result_instruction: resultInstruction,
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
  for (const field of skill.inputs) {
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
  return path.join(runtimePaths(cwd).skillSources, `${normalizeSkillName(name)}.md`);
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
    "Describe how to present a successful result, an empty result, and any visitor-facing limits.",
    "",
  ].join("\n");
}

export async function compileSkillMarkdown(config, name, source) {
  const skillName = normalizeSkillName(name);
  const messages = [
    {
      role: "system",
      content: [
        "You compile a site owner's natural-language Skill document into a confirmed runtime definition.",
        'Return JSON only: {"description":"...","inputs":[{"name":"query","description":"...","required":true}],"request":{"method":"GET","url":"https://...","query":{"q":"{{query}}"},"body":{}},"result_instruction":"..."}.',
        "Use only HTTP method, URL, parameters, and result behavior explicitly stated in the source document. Never invent an API endpoint, parameter, or result field.",
        "description must state when the skill should be used. inputs must contain only values needed by the request. request supports GET or POST only. result_instruction must describe visitor-facing output without mentioning the skill or API.",
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
    sourcePath: `skills/${skillName}.md`,
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
  if (!skill || !skill.request) {
    throw new Error("Skill call is invalid");
  }

  const url = new URL(applyTemplate(skill.request.url, input, true));
  for (const [key, value] of Object.entries(skill.request.query || {})) {
    url.searchParams.set(key, applyTemplate(value, input));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const options = {
      method: skill.request.method,
      signal: controller.signal,
      headers: {},
    };
    if (skill.request.method === "POST") {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(
        Object.fromEntries(
          Object.entries(skill.request.body || {}).map(([key, value]) => [key, applyTemplate(value, input)]),
        ),
      );
    }
    const response = await fetch(url, options);
    const raw = trimResponseText(await response.text());
    if (!response.ok) {
      throw new Error(`Skill request failed: HTTP ${response.status}${raw ? `: ${raw.slice(0, 500)}` : ""}`);
    }
    let data = raw;
    try {
      data = JSON.parse(raw);
    } catch {}
    return {
      name: skill.name,
      result_instruction: skill.result_instruction,
      data,
    };
  } finally {
    clearTimeout(timer);
  }
}
