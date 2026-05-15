import { approveReviewItem, createAction, listActions, listReviewQueue, rejectReviewItem, runAction } from "../core/actions.js";
import { parseJsonArg } from "../utils/args.js";
import { pick } from "../i18n/messages.js";

function usage(locale) {
  return pick(
    locale,
    [
      "用法:",
      "  /action list",
      "  /action create <name>",
      "  /action test <name> --payload '{\"k\":\"v\"}'",
      "  /action pending",
      "  /action approve <request_id>",
      "  /action reject <request_id> [--reason xxx]",
    ].join("\n"),
    [
      "Usage:",
      "  /action list",
      "  /action create <name>",
      "  /action test <name> --payload '{\"k\":\"v\"}'",
      "  /action pending",
      "  /action approve <request_id>",
      "  /action reject <request_id> [--reason xxx]",
    ].join("\n"),
  );
}

export async function runActionCommand(ctx, argv) {
  const [sub, ...rest] = argv.positionals;

  if (!sub) {
    ctx.log(usage(ctx.locale));
    return;
  }

  if (sub === "list") {
    const items = await listActions(ctx.cwd);
    if (items.length === 0) {
      ctx.log(pick(ctx.locale, "暂无 action", "No actions"));
      return;
    }
    ctx.log(items.join("\n"));
    return;
  }

  if (sub === "create") {
    const name = rest[0];
    if (!name) {
      ctx.log(usage(ctx.locale));
      return;
    }

    const created = await createAction(ctx.cwd, name);
    ctx.log(
      pick(
        ctx.locale,
        `Action 已创建:\n- script: ${created.scriptPath}\n- meta: ${created.metaPath}`,
        `Action created:\n- script: ${created.scriptPath}\n- meta: ${created.metaPath}`,
      ),
    );
    return;
  }

  if (sub === "test" || sub === "run") {
    const name = rest[0];
    if (!name) {
      ctx.log(usage(ctx.locale));
      return;
    }

    const payload = parseJsonArg(argv.options.payload, {});
    const result = await runAction(ctx.cwd, name, payload);
    ctx.log(JSON.stringify(result.output, null, 2));
    return;
  }

  if (sub === "pending") {
    const queue = await listReviewQueue(ctx.cwd, "pending");
    ctx.log(JSON.stringify(queue, null, 2));
    return;
  }

  if (sub === "approve") {
    const id = rest[0];
    if (!id) {
      ctx.log(usage(ctx.locale));
      return;
    }

    const item = await approveReviewItem(ctx.cwd, id);
    ctx.log(JSON.stringify(item, null, 2));
    return;
  }

  if (sub === "reject") {
    const id = rest[0];
    if (!id) {
      ctx.log(usage(ctx.locale));
      return;
    }

    const item = await rejectReviewItem(ctx.cwd, id, String(argv.options.reason || "rejected by owner"));
    ctx.log(JSON.stringify(item, null, 2));
    return;
  }

  ctx.log(usage(ctx.locale));
}
