/**
 * G3-0a `c2c runtime prune-stale` — explicit maintenance for proven-stale runtime files.
 * --plan is read-only; --apply requires --confirm and maintenance lock revalidation.
 */
import type { Command } from "commander";
import path from "node:path";
import { applyRuntimePrune, planRuntimePrune } from "../core/runtime-prune.js";

const say = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

export function registerRuntimePruneCommands(program: Command): void {
  const runtime = program.command("runtime").description("本机 runtime state 维护（不重启 Bridge）");
  runtime
    .command("prune-stale")
    .description("只清理已证明 stopped/stale 的 runtime state；不删 healthy/unknown")
    .requiredOption("-w, --workspace <path>", "workspace root（自动推导 workspaceId）")
    .option("--plan", "只读评估 eligibility 与 confirmation")
    .option("--apply", "destructive：maintenance lock 内重验后删除 stale runtime")
    .option("--confirm <confirmationSha256>", "apply 所需 confirmation（来自 --plan）")
    .option("--json", "machine-readable output", false)
    .action(async (opts: {
      workspace: string;
      plan?: boolean;
      apply?: boolean;
      confirm?: string;
      json: boolean;
    }) => {
      const modes = [opts.plan, opts.apply].filter(Boolean).length;
      if (modes !== 1) {
        if (opts.json) {
          say(JSON.stringify({ ok: false, removed: false, reason: "mode_required" }));
        } else {
          say("必须显式指定 --plan 或 --apply（不可组合）。");
        }
        process.exitCode = 1;
        return;
      }
      const root = path.resolve(opts.workspace);

      if (opts.plan) {
        const plan = await planRuntimePrune(root);
        if (!plan.ok || !plan.eligible) process.exitCode = 1;
        if (opts.json) {
          say(JSON.stringify(plan));
          return;
        }
        if (!plan.ok) {
          say(`plan 失败：${plan.error}`);
          return;
        }
        if (!plan.eligible) {
          say(`不可清理：${plan.blockedReason ?? "not_eligible"}`);
          return;
        }
        say(`eligible workspaceId=${plan.workspaceId} observation=${plan.observation?.reason}`);
        say(`confirmationSha256=${plan.confirmationSha256}`);
        return;
      }

      if (!opts.confirm) {
        if (opts.json) {
          say(JSON.stringify({ ok: false, removed: false, reason: "confirm_required" }));
        } else {
          say("--apply 必须提供 --confirm <confirmationSha256>。");
        }
        process.exitCode = 1;
        return;
      }

      const result = await applyRuntimePrune(root, opts.confirm);
      // ok=false → nonzero even when removed=true (mutation fact preserved).
      if (!result.ok) process.exitCode = 1;
      if (opts.json) {
        say(JSON.stringify(result));
        return;
      }
      if (result.ok && result.removed) {
        say(`removed workspaceId=${result.workspaceId} observation=${result.observation}`);
      } else if (result.removed) {
        say(`已删除但 maintenance 未完整确认：${result.reason ?? "unknown"} workspaceId=${result.workspaceId ?? ""}`);
      } else {
        say(`未删除：${result.reason ?? "unknown"}`);
      }
    });
}
