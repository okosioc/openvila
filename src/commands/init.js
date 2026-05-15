import { initializeRuntime } from "../core/runtime.js";
import { pick } from "../i18n/messages.js";

export async function runInit(ctx, argv) {
  const force = Boolean(argv.options.force);
  const result = await initializeRuntime(ctx.cwd, { force });

  if (result.created || force) {
    ctx.log(
      pick(
        ctx.locale,
        [
          `已初始化运行目录: ${result.paths.base}`,
          `配置文件: ${result.paths.config}`,
          `运行时 gitignore: ${result.paths.runtimeGitignore}`,
          "下一步: 先执行 /scan，再执行 /run。",
        ].join("\n"),
        [
          `Runtime initialized: ${result.paths.base}`,
          `Config: ${result.paths.config}`,
          `Runtime gitignore: ${result.paths.runtimeGitignore}`,
          "Next: run /scan first, then /run.",
        ].join("\n"),
      ),
    );
    return;
  }

  ctx.log(
    pick(
      ctx.locale,
      [
        `运行目录已存在: ${result.paths.base}`,
        "如果要重置配置，可执行: /init --force",
      ].join("\n"),
      [
        `Runtime already initialized: ${result.paths.base}`,
        "Run /init --force to reset config.",
      ].join("\n"),
    ),
  );
}
