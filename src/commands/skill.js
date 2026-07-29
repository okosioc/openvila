import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import {
  compileSkillMarkdown,
  deleteSkill,
  listSkills,
  readSkill,
  saveSkill,
  setSkillEnabled,
  skillSourcePath,
  skillTemplate,
} from "../core/skill.js";
import { ensureRuntime, loadConfig } from "../core/runtime.js";
import { exists, readTextSafe, writeText } from "../utils/fs.js";
import { editTextInEditor } from "../utils/editor.js";
import { pick } from "../i18n/messages.js";

function usage(locale) {
  return pick(
    locale,
    [
      "用法:",
      "  /skill list",
      "  /skill add <name>",
      "  /skill edit <name>",
      "  /skill enable <name>",
      "  /skill disable <name>",
      "  /skill delete <name> [--yes]",
    ].join("\n"),
    [
      "Usage:",
      "  /skill list",
      "  /skill add <name>",
      "  /skill edit <name>",
      "  /skill enable <name>",
      "  /skill disable <name>",
      "  /skill delete <name> [--yes]",
    ].join("\n"),
  );
}

function isYes(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "" || normalized === "y" || normalized === "yes";
}

async function ask(ctx, promptText) {
  if (typeof ctx.ask === "function") {
    return String(await ctx.ask(promptText) || "").trim();
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("This command needs an interactive terminal");
  }
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => terminal.question(`${promptText} `, resolve));
  } finally {
    terminal.close();
  }
}

async function editAndCompile(ctx, name, source, dependencies) {
  const editSkillText = dependencies.editSkillText || ctx.editSkillText || ((text) => editTextInEditor(text, `${name}.md`));
  const compileSkill = dependencies.compileSkillMarkdown || compileSkillMarkdown;
  const loadRuntimeConfig = dependencies.loadConfig || loadConfig;
  const sourcePath = skillSourcePath(ctx.cwd, name);

  ctx.log(pick(ctx.locale, `[skill] 正在打开编辑器修改 ${name}...`, `[skill] Opening editor for ${name}...`));
  const edited = await editSkillText(source);
  if (!String(edited || "").trim()) {
    throw new Error("Skill source cannot be empty");
  }
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await writeText(sourcePath, edited);

  const config = await loadRuntimeConfig(ctx.cwd, { createIfMissing: false });
  const compiled = await compileSkill(config, name, edited);
  ctx.log(`${pick(ctx.locale, "[skill] 待确认运行定义:", "[skill] Runtime definition to confirm:")}\n${JSON.stringify(compiled, null, 2)}`);
  const confirmed = isYes(
    await ask(
      ctx,
      pick(ctx.locale, "确认启用此 Skill？[Y/n]", "Confirm and enable this Skill? [Y/n]"),
    ),
  );
  if (!confirmed) {
    ctx.log(pick(ctx.locale, "[skill] 未确认，已保留 Markdown 源文件。", "[skill] Not confirmed; Markdown source was kept."));
    return;
  }
  const saved = await saveSkill(ctx.cwd, { ...compiled, enabled: true });
  ctx.log(pick(ctx.locale, `[skill] 已启用: ${saved.name}`, `[skill] Enabled: ${saved.name}`));
}

export async function runSkill(ctx, argv, dependencies = {}) {
  await (dependencies.ensureRuntime || ensureRuntime)(ctx.cwd);
  const [subcommand, name] = argv.positionals;

  if (!subcommand) {
    ctx.log(usage(ctx.locale));
    return;
  }

  if (subcommand === "list") {
    const skills = await (dependencies.listSkills || listSkills)(ctx.cwd);
    if (skills.length === 0) {
      ctx.log(pick(ctx.locale, "暂无已编译 Skill", "No compiled skills"));
      return;
    }
    ctx.log(
      skills
        .map((skill) => `${skill.name}\t${skill.enabled ? "enabled" : "disabled"}\t${skill.description}`)
        .join("\n"),
    );
    return;
  }

  if (!name) {
    ctx.log(usage(ctx.locale));
    return;
  }

  if (subcommand === "add") {
    const sourcePath = skillSourcePath(ctx.cwd, name);
    if (await exists(sourcePath)) {
      throw new Error(`Skill source already exists: ${sourcePath}`);
    }
    await editAndCompile(ctx, name, skillTemplate(name), dependencies);
    return;
  }

  if (subcommand === "edit") {
    const sourcePath = skillSourcePath(ctx.cwd, name);
    const source = await readTextSafe(sourcePath);
    if (!source) {
      throw new Error(`Skill source not found: ${sourcePath}`);
    }
    await editAndCompile(ctx, name, source, dependencies);
    return;
  }

  if (subcommand === "enable" || subcommand === "disable") {
    const skill = await (dependencies.setSkillEnabled || setSkillEnabled)(ctx.cwd, name, subcommand === "enable");
    ctx.log(
      pick(
        ctx.locale,
        `[skill] ${skill.name} 已${skill.enabled ? "启用" : "禁用"}`,
        `[skill] ${skill.name} ${skill.enabled ? "enabled" : "disabled"}`,
      ),
    );
    return;
  }

  if (subcommand === "delete") {
    const existing = await (dependencies.readSkill || readSkill)(ctx.cwd, name);
    if (!existing && !(await exists(skillSourcePath(ctx.cwd, name)))) {
      throw new Error(`Skill not found: ${name}`);
    }
    const confirmed = Boolean(argv.options.yes) || isYes(
      await ask(ctx, pick(ctx.locale, `删除 Skill ${name}？[Y/n]`, `Delete Skill ${name}? [Y/n]`)),
    );
    if (!confirmed) {
      ctx.log(pick(ctx.locale, "[skill] 已取消删除。", "[skill] Delete cancelled."));
      return;
    }
    await (dependencies.deleteSkill || deleteSkill)(ctx.cwd, name);
    ctx.log(pick(ctx.locale, `[skill] 已删除: ${name}`, `[skill] Deleted: ${name}`));
    return;
  }

  ctx.log(usage(ctx.locale));
}
