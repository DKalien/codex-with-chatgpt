import type { Command } from "commander";
import path from "node:path";
import { Workspace } from "../workspace/manager.js";
import { getStateDir } from "../config/paths.js";
import {
  claimFinalizerWorker,
  commitFinalizerResult,
  projectFinalizerExecution,
  readActiveFinalizer,
  readFinalizerResult,
  releaseFinalizerWorkerClaim,
  runFinalizerAttempt,
  FINALIZER_POLL_MS,
} from "../core/post-turn-finalizer.js";
import { say } from "./shared.js";

export function registerPostTurnFinalizerCommands(program: Command): void {
// ---------------------------------------------------------------- post-turn finalizer
const ptf = program.command("post-turn-finalizer").description("一次性 post-turn finalizer（非 generic scheduler）");
ptf.command("status").requiredOption("-w, --workspace <path>").option("--json").action((opts: { workspace: string; json?: boolean }) => {
  const workspace = new Workspace(path.resolve(opts.workspace));
  const stateDir = getStateDir();
  const active = readActiveFinalizer(stateDir, workspace.id);
  const latest = readFinalizerResult(stateDir, workspace.id);
  const payload = {
    active: Boolean(active),
    jobId: active?.jobId ?? null,
    targetBuildId: active?.targetBuildId ?? null,
    status: active?.status ?? null,
    expiresAt: active?.expiresAt ?? null,
    latestResult: latest,
  };
  say(JSON.stringify(payload));
});
ptf.command("run").requiredOption("-w, --workspace <path>").action(async (opts: { workspace: string }) => {
  const workspace = new Workspace(path.resolve(opts.workspace));
  const stateDir = getStateDir();
  delete process.env.CODEX_THREAD_ID;
  delete process.env.CODEX_SESSION_ID;
  delete process.env.C2C_STARTUP_LEASE;
  const job = readActiveFinalizer(stateDir, workspace.id);
  if (!job) {
    process.exitCode = 1;
    return;
  }
  let claim;
  try {
    claim = claimFinalizerWorker(stateDir, job);
  } catch {
    process.exitCode = 1;
    return;
  }
  const startedAt = new Date().toISOString();
  let cleanupFailed = false;
  let claimReleased = false;
  const releaseClaim = (): void => {
    if (claimReleased) return;
    claimReleased = true;
    if (!releaseFinalizerWorkerClaim(stateDir, job, claim)) cleanupFailed = true;
  };
  try {
    for (;;) {
      const attempt = await runFinalizerAttempt(job, stateDir);
      if (attempt.kind === "terminal") {
        let committed;
        try {
          committed = commitFinalizerResult(stateDir, job, {
            ...attempt.result,
            startedAt,
          });
        } catch (error) {
          if (error && typeof error === "object" && "result" in error) {
            committed = (error as { result: import("../core/post-turn-finalizer.js").FinalizerResult }).result;
            cleanupFailed = true;
          } else throw error;
        }
        releaseClaim();
        projectFinalizerExecution(workspace.id, job, committed);
        say(JSON.stringify(committed));
        process.exitCode = committed.status === "ok" && !cleanupFailed ? 0 : 1;
        return;
      }
      if (Date.now() >= Date.parse(job.expiresAt)) {
        let committed;
        try {
          committed = commitFinalizerResult(stateDir, job, {
            status: "blocked", reason: "timeout_self_busy",
            scheduledAt: job.createdAt, startedAt, finishedAt: new Date().toISOString(),
          });
        } catch (error) {
          if (error && typeof error === "object" && "result" in error) {
            committed = (error as { result: import("../core/post-turn-finalizer.js").FinalizerResult }).result;
            cleanupFailed = true;
          } else throw error;
        }
        releaseClaim();
        projectFinalizerExecution(workspace.id, job, committed);
        say(JSON.stringify(committed));
        process.exitCode = 1;
        return;
      }
      await new Promise(r => setTimeout(r, FINALIZER_POLL_MS));
    }
  } catch {
    process.exitCode = 1;
  } finally {
    // orderly exit（含 owner-lost）统一 owner-safe 清理 claim；仅 crash 允许残留。
    releaseClaim();
    if (cleanupFailed) process.exitCode = 1;
  }
});
}
