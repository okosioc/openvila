import { installWidget } from "../core/install.js";
import { pick } from "../i18n/messages.js";

export async function runInstall(ctx, argv) {
  const apply = Boolean(argv.options.apply);
  const all = Boolean(argv.options.all);
  const attachStart = Boolean(argv.options["attach-start"]);

  const result = await installWidget(ctx.cwd, {
    apply,
    all,
    attachStart,
  });

  const linesZh = [
    `预览已生成: ${result.preview}`,
    `脚本已生成: ${result.script}`,
    "",
    "嵌入片段:",
    result.snippet,
  ];

  const linesEn = [
    `Preview generated: ${result.preview}`,
    `Script generated: ${result.script}`,
    "",
    "Embed snippet:",
    result.snippet,
  ];

  if (result.injected.length > 0) {
    linesZh.push("", `已注入文件: ${result.injected.join(", ")}`);
    linesEn.push("", `Injected files: ${result.injected.join(", ")}`);
  } else if (apply) {
    linesZh.push("", "未找到可注入文件，或文件已包含 widget 脚本");
    linesEn.push("", "No inject target found or snippet already exists");
  }

  if (result.startup) {
    linesZh.push("", `启动脚本处理: ${JSON.stringify(result.startup)}`);
    linesEn.push("", `Startup script update: ${JSON.stringify(result.startup)}`);
  }

  ctx.log(pick(ctx.locale, linesZh.join("\n"), linesEn.join("\n")));
}
