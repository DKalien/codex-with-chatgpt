import type { Command } from "commander";
import path from "node:path";
import { Workspace } from "../workspace/manager.js";
import { getStateDir } from "../config/paths.js";
import {
  FINALIZER_RETIRED,
  readActiveFinalizer,
  readFinalizerResult,
  readFinalizerRetirement,
} from "../core/post-turn-finalizer.js";
import { say } from "./shared.js";

export function registerPostTurnFinalizerCommands(program: Command): void {
  const ptf = program.command("post-turn-finalizer").description("历史 post-turn finalizer 状态（已退役，只读）");
  ptf.command("status")
    .requiredOption("-w, --workspace <path>")
    .option("--json")
    .action((opts: { workspace: string }) => {
      const workspace = new Workspace(path.resolve(opts.workspace));
      const stateDir = getStateDir();
      const active = readActiveFinalizer(stateDir, workspace.id);
      const latest = readFinalizerResult(stateDir, workspace.id);
      const retirement = readFinalizerRetirement(stateDir, workspace.id);
      say(JSON.stringify({
        mode: "retired",
        retired: true,
        retirement: retirement ? { retiredAt: retirement.retiredAt, jobId: retirement.active.jobId, targetBuildId: retirement.active.targetBuildId, completed: !active } : null,
        active: Boolean(active),
        jobId: active?.jobId ?? null,
        targetBuildId: active?.targetBuildId ?? null,
        status: active?.status ?? null,
        expiresAt: active?.expiresAt ?? null,
        latestResult: latest,
      }));
    });
  ptf.command("run")
    .requiredOption("-w, --workspace <path>")
    .action((opts: { workspace: string }) => {
      const workspace = new Workspace(path.resolve(opts.workspace));
      const stateDir = getStateDir();
      const active = readActiveFinalizer(stateDir, workspace.id);
      const latest = readFinalizerResult(stateDir, workspace.id);
      const retirement = readFinalizerRetirement(stateDir, workspace.id);
      say(JSON.stringify({
        mode: "retired",
        retired: true,
        retirement: retirement ? { retiredAt: retirement.retiredAt, jobId: retirement.active.jobId, targetBuildId: retirement.active.targetBuildId, completed: !active } : null,
        code: FINALIZER_RETIRED,
        active: Boolean(active),
        latestResult: latest,
      }));
      process.exitCode = 1;
    });
}
