import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import path from "node:path";
import { Workspace } from "../workspace/manager.js";
import { getStateDir } from "../config/paths.js";
import { repairForwardFeedbackControlEvents } from "../feedback/store.js";
import { planGc } from "../core/gc-plan.js";
import { applyGc } from "../core/gc-apply.js";
import { say, cross } from "./shared.js";

export function registerFeedbackControlRepairCommand(program: Command): void {
// Hidden maintenance fence: quarantines only alert-backed forward control events.
program.command("feedback-control-repair", { hidden: true })
  .requiredOption("-w, --workspace <path>")
  .option("--json", "机器可读输出", false)
  .action((opts: { workspace: string; json?: boolean }) => {
    const workspace = new Workspace(path.resolve(opts.workspace));
    const result = repairForwardFeedbackControlEvents(workspace.id, getStateDir());
    const output = { ok: true, workspaceId: workspace.id, removedEventIds: result.removedEventIds };
    if (opts.json) say(JSON.stringify(output));
    else say(`已隔离 ${result.removedEventIds.length} 个不兼容控制事件`);
  });
}

export function registerGcCommand(program: Command): void {
program.command("gc").description("immutable Core release 回收：只读 plan/dry-run，或显式 apply")
  .option("--plan")
  .option("--dry-run")
  .option("--apply", "显式 destructive：maintenance lock 内重新校验后 tombstone+删除")
  .option("--json")
  .action((opts: { json?: boolean; plan?: boolean; dryRun?: boolean; apply?: boolean }) => {
    const modes = [opts.plan, opts.dryRun, opts.apply].filter(Boolean).length;
    if (modes !== 1) {
      throw new InvalidArgumentError("gc 必须显式指定 --plan、--dry-run 或 --apply 之一，且不可组合");
    }
    if (opts.apply) {
      const result = applyGc();
      if (!result.ok) process.exitCode = 1;
      if (opts.json) { say(JSON.stringify(result)); return; }
      say(`Release GC apply：deleted ${result.totals.deletedCount}，tombstoned ${result.totals.tombstonedCount}，bytesDeleted ${result.totals.bytesDeleted}`);
      for (const item of result.items) say(`${item.status} ${item.buildId}（${item.reason}）`);
      for (const issue of result.issues) cross(issue);
      return;
    }
    const plan = planGc();
    // exit contract 与输出形态无关：ok=false 时 text/--json 都必须非零退出。
    if (!plan.ok) process.exitCode = 1;
    if (opts.json) { say(JSON.stringify(plan)); return; }
    const mode = opts.dryRun ? "dry-run" : "plan";
    say(`Release GC ${mode}：${plan.releases.length} 项，候选回收 ${plan.totals.bytesCandidateReclaimable} bytes，issue ${plan.totals.issueCount}`);
    for (const item of plan.releases) say(`${item.disposition} ${item.buildId}（${item.reasons.join("、") || "无引用"}） ${item.logicalBytes}B`);
    for (const issue of plan.issues) cross(issue);
  });
}
