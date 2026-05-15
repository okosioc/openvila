import { buildKnowledgeBase } from "../core/knowledge.js";
import { pick } from "../i18n/messages.js";

export async function runScan(ctx) {
  const result = await buildKnowledgeBase(ctx.cwd);

  ctx.log(
    pick(
      ctx.locale,
      [
        `扫描完成: framework=${result.framework || "unknown"}`,
        `扫描文件: ${result.scanned}`,
        `编译 topic: ${result.compiled}`,
        `索引文件: ${result.paths.knowledgeIndex}`,
      ].join("\n"),
      [
        `Scan finished: framework=${result.framework || "unknown"}`,
        `Files scanned: ${result.scanned}`,
        `Topics compiled: ${result.compiled}`,
        `Index file: ${result.paths.knowledgeIndex}`,
      ].join("\n"),
    ),
  );
}
