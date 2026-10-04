import path from "node:path";
import os from "node:os";
import { buildDaemonEnv, spawnDetachedDaemon, type DaemonSpawnResult } from "../process/daemon-spawn.js";
import { getStateDir } from "../config/paths.js";
import { DesktopError } from "./store.js";
import { isTrustedDesktopReceipt, readExecutionRecordsStrict } from "../execution/records.js";
import { readExecutionOutputMetadataStrict } from "../execution/output.js";
import type { DesktopResultReceipt } from "./result-schema.js";
import {
  RECEIPT_FINALIZER_POLL_MS,
  type ReceiptFinalizationAlert,
  type ReceiptFinalizationDraft,
} from "./receipt-finalizer-schema.js";
import {
  acquireReceiptFinalizationClaim,
  readReceiptFinalizationDraft,
  releaseReceiptFinalizationClaim,
  removeReceiptFinalizationAlert,
  removeReceiptFinalizationDraft,
  writeReceiptFinalizationAlert,
} from "./receipt-finalizer-store.js";
import { withCommandOperationAsync } from "../command-cleanup/fence.js";
import { CommandCleanupError } from "../command-cleanup/schema.js";
import { existingRecord, outputForRecord, prepareReceiptCommit, receiptHash } from "./result-commit.js";
import {
  inspectLegacyReceiptFinalizationContext,
  inspectReceiptFinalizationFence,
  resolveReceiptFinalizationTarget,
} from "./result-evidence.js";

export async function runReceiptFinalizer(
  draft: ReceiptFinalizationDraft,
  options: {
    stateDir?: string;
    pollMs?: number;
    nowMs?: () => number;
    beforeReceiptCommit?: (receiptAlreadyExists: boolean) => void;
  } = {},
): Promise<ReceiptFinalizationAlert | DesktopResultReceipt | null> {
  const stateDir = options.stateDir ?? getStateDir();
  const now = options.nowMs ?? (() => Date.now());
  const pollMs = Math.max(1_000, options.pollMs ?? RECEIPT_FINALIZER_POLL_MS);
  // The spawner still owns the command lock until record returns. Each retry
  // re-reads the durable draft under that lock, so cleanup cannot resurrect it.
  const lockDeadline = Math.max(now() + 10_000, Date.parse(draft.expiresAt));
  async function operation<T>(fn: () => Promise<T>): Promise<T> {
    for (;;) {
      try { return await withCommandOperationAsync(draft.workspaceId, draft.commandId, fn, stateDir); }
      catch (error) {
        if (!(error instanceof CommandCleanupError) || error.code !== "COMMAND_CLEANUP_BUSY" || now() >= lockDeadline) throw error;
        await new Promise(resolve => setTimeout(resolve, pollMs));
      }
    }
  }
  type Startup = { kind: "acquired"; acquired: boolean } | { kind: "replay"; receipt: DesktopResultReceipt | null };
  let startup: Startup;
  try {
    startup = await operation(async (): Promise<Startup> => {
      const current = readReceiptFinalizationDraft(stateDir, draft.workspaceId, draft.commandId);
      if (current?.draftId === draft.draftId) {
        return { kind: "acquired", acquired: acquireReceiptFinalizationClaim(stateDir, draft) };
      }
      const receipt = replayCommittedReceipt(draft, stateDir);
      if (receipt) prepareReceiptCommit(options.beforeReceiptCommit, true);
      return { kind: "replay", receipt };
    });
  } catch (error) {
    if (error instanceof CommandCleanupError && error.code === "COMMAND_CLEANUP_IN_PROGRESS") return null;
    throw error;
  }
  if (startup.kind === "replay") return startup.receipt;
  if (!startup.acquired) return null;
  type TickResult = { done: ReceiptFinalizationAlert | DesktopResultReceipt | null } | { wait: true };
  let attemptedObservation = false;
  try {
    // 即使 draft 刚过期也做一次 target/delivery/identity 观察，保证已有 pending
    // draft 能收敛为 bounded alert，而不是因过期直接静默退出。
    while (!attemptedObservation || now() < Date.parse(draft.expiresAt)) {
      attemptedObservation = true;
      const tick = await operation<TickResult>(async (): Promise<TickResult> => {
        const current = readReceiptFinalizationDraft(stateDir, draft.workspaceId, draft.commandId);
        if (current?.draftId !== draft.draftId) return { done: null as null };
        try {
          const target = resolveReceiptFinalizationTarget(draft);
          if (draft.version === 2 || draft.version === 3) {
            const fence = await inspectReceiptFinalizationFence(target, draft);
            if (fence.fence === "post_record_activity") return { done: writeReceiptFinalizationAlert(draft, "post_record_activity", { stateDir }) };
            if (fence.fence === "unprovable") return { done: writeReceiptFinalizationAlert(draft, "post_record_activity_unprovable", { stateDir }) };
            if (fence.resultTurnId !== draft.resultTurnId) return { done: writeReceiptFinalizationAlert(draft, "identity_drift", { stateDir }) };
            if (fence.fence === "inProgress") return { wait: true as const };
            if (fence.fence !== "safe_terminal") return { done: writeReceiptFinalizationAlert(draft, "terminality_unknown", { stateDir }) };
            try {
              const { finalizeReceiptFinalizationDraft } = await import("./result-finalization.js");
              const receipt = await finalizeReceiptFinalizationDraft(draft, target, fence, options.beforeReceiptCommit, stateDir);
              removeReceiptFinalizationDraft(stateDir, draft);
              removeReceiptFinalizationAlert(stateDir, draft);
              return { done: receipt };
            } catch (error) {
              const reason = error instanceof DesktopError &&
                ["DESKTOP_RESULT_CURRENT_EXECUTION", "DESKTOP_RESULT_THREAD"].includes(error.code)
                ? "identity_drift" : "terminality_unknown";
              return { done: writeReceiptFinalizationAlert(draft, reason, { stateDir }) };
            }
          }
          const context = await inspectLegacyReceiptFinalizationContext(target, draft);
          if (context.resultTurnId !== draft.resultTurnId) return { done: writeReceiptFinalizationAlert(draft, "post_record_activity", { stateDir }) };
          if (context.resultTurnStatus === "inProgress") return { wait: true as const };
          // Legacy v1 drafts have no activity marker, so terminal ordering remains unprovable.
          return { done: writeReceiptFinalizationAlert(draft, "post_record_activity_unprovable", { stateDir }) };
        } catch (error) {
          if (error instanceof DesktopError &&
              ["DESKTOP_STATE_UNAVAILABLE", "DESKTOP_IPC_UNAVAILABLE", "DESKTOP_IPC_TIMEOUT"].includes(error.code)) {
            return { wait: true as const };
          }
          return { done: writeReceiptFinalizationAlert(draft, "identity_drift", { stateDir }) };
        }
      }).catch(error => {
        if (error instanceof CommandCleanupError && error.code === "COMMAND_CLEANUP_IN_PROGRESS") return { done: null };
        throw error;
      });
      if ("done" in tick) return tick.done;
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    return await withCommandOperationAsync<ReceiptFinalizationAlert | null>(draft.workspaceId, draft.commandId, async () => {
      const current = readReceiptFinalizationDraft(stateDir, draft.workspaceId, draft.commandId);
      return current?.draftId === draft.draftId ? writeReceiptFinalizationAlert(draft, "timeout", { stateDir }) : null;
    }, stateDir).catch(error => {
      if (error instanceof CommandCleanupError && error.code === "COMMAND_CLEANUP_IN_PROGRESS") return null;
      throw error;
    });
  } finally {
    try { releaseReceiptFinalizationClaim(stateDir, draft); }
    catch (error) {
      if (!(error instanceof CommandCleanupError) || error.code !== "COMMAND_CLEANUP_IN_PROGRESS") throw error;
    }
  }
}

function replayCommittedReceipt(draft: ReceiptFinalizationDraft, stateDir: string): DesktopResultReceipt | null {
  if (draft.version !== 2 && draft.version !== 3) return null;
  const digest = receiptHash(draft.input);
  if (digest !== draft.inputDigest) throw new DesktopError("DESKTOP_RESULT_CONFLICT", "pending receipt digest changed; refusing replay");
  const taskId = `desktop_${draft.commandId}`;
  const records = readExecutionRecordsStrict(draft.workspaceId, stateDir);
  const record = existingRecord(records, draft.commandId, taskId, digest);
  if (!record) return null;
  if (!isTrustedDesktopReceipt(record, draft.commandId)) {
    throw new DesktopError("DESKTOP_RESULT_CONFLICT", "existing receipt is not trusted; refusing replay");
  }
  const outputs = readExecutionOutputMetadataStrict(draft.workspaceId, stateDir)
    .filter(output => output.taskId === taskId && output.iteration === 1);
  if ((record.outputId === undefined && outputs.length !== 0) ||
      (record.outputId !== undefined && (outputs.length !== 1 || outputs[0]?.id !== record.outputId))) {
    throw new DesktopError("DESKTOP_RESULT_PARTIAL", "existing receipt output identity is incomplete or ambiguous");
  }
  return { record, output: outputForRecord(draft.workspaceId, record, stateDir) };
}

export async function spawnReceiptFinalizerWorker(
  draft: ReceiptFinalizationDraft,
  options: { stateDir?: string; spawnImpl?: typeof spawnDetachedDaemon; entry?: string } = {},
): Promise<DaemonSpawnResult> {
  const stateDir = options.stateDir ?? getStateDir();
  const spawnFn = options.spawnImpl ?? spawnDetachedDaemon;
  const entry = options.entry ?? process.argv[1];
  if (!entry) throw new Error("无法确定 receipt finalizer worker entry");
  const env = buildDaemonEnv(process.env);
  env.C2C_RECEIPT_FINALIZER_STATE_DIR = path.resolve(stateDir);
  env.C2C_STATE_DIR = path.resolve(stateDir);
  const runtimeArgs = path.extname(entry).toLowerCase() === ".ts" ? ["--import", "tsx"] : [];
  // Node detached alone does not escape a Windows host Job. Reuse the same
  // fail-closed helper as Bridge; worker failures are persisted by the worker.
  // No transcript log: CLI output may contain command-scoped receipt content.
  try {
    return await spawnFn({ cmd: process.execPath,
      args: [...runtimeArgs, entry, "desktop-receipt-finalizer", "run", "-w", draft.workspaceRoot, "--draft", draft.draftId],
      logFile: os.devNull, env });
  } catch (error) {
    writeReceiptFinalizationAlert(draft, "worker_spawn_failed", { stateDir });
    throw error;
  }
}
