import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { getStateDir } from "../config/paths.js";
import { DesktopError } from "./store.js";
import type { DesktopResultReceipt } from "./result-schema.js";
import {
  RECEIPT_FINALIZER_POLL_MS,
  type ReceiptFinalizationAlert,
  type ReceiptFinalizationDraft,
} from "./receipt-finalizer-schema.js";
import {
  acquireReceiptFinalizationClaim,
  releaseReceiptFinalizationClaim,
  removeReceiptFinalizationAlert,
  removeReceiptFinalizationDraft,
  writeReceiptFinalizationAlert,
  writeReceiptFinalizationWorkerFailureAlert,
} from "./receipt-finalizer-store.js";
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
  if (!acquireReceiptFinalizationClaim(stateDir, draft)) return null;
  const now = options.nowMs ?? (() => Date.now());
  const pollMs = Math.max(1_000, options.pollMs ?? RECEIPT_FINALIZER_POLL_MS);
  let attemptedObservation = false;
  try {
    // 即使 draft 刚过期也做一次 target/delivery/identity 观察，保证已有 pending
    // draft 能收敛为 bounded alert，而不是因过期直接静默退出。
    while (!attemptedObservation || now() < Date.parse(draft.expiresAt)) {
      attemptedObservation = true;
      try {
        const target = resolveReceiptFinalizationTarget(draft);
        if (draft.version === 2 || draft.version === 3) {
          const fence = await inspectReceiptFinalizationFence(target, draft);
          if (fence.fence === "post_record_activity") {
            return writeReceiptFinalizationAlert(draft, "post_record_activity", { stateDir });
          }
          if (fence.fence === "unprovable") {
            return writeReceiptFinalizationAlert(draft, "post_record_activity_unprovable", { stateDir });
          }
          if (fence.resultTurnId !== draft.resultTurnId) {
            return writeReceiptFinalizationAlert(draft, "identity_drift", { stateDir });
          }
          if (fence.fence === "inProgress") {
            await new Promise(resolve => setTimeout(resolve, pollMs));
            continue;
          }
          if (fence.fence !== "safe_terminal") {
            return writeReceiptFinalizationAlert(draft, "terminality_unknown", { stateDir });
          }
          try {
            const { finalizeReceiptFinalizationDraft } = await import("./result-finalization.js");
            const receipt = await finalizeReceiptFinalizationDraft(draft, target, fence, options.beforeReceiptCommit);
            removeReceiptFinalizationDraft(stateDir, draft);
            removeReceiptFinalizationAlert(stateDir, draft);
            return receipt;
          } catch (error) {
            if (error instanceof DesktopError &&
                ["DESKTOP_RESULT_CURRENT_EXECUTION", "DESKTOP_RESULT_THREAD"].includes(error.code)) {
              return writeReceiptFinalizationAlert(draft, "identity_drift", { stateDir });
            }
            return writeReceiptFinalizationAlert(draft, "terminality_unknown", { stateDir });
          }
        }
        const context = await inspectLegacyReceiptFinalizationContext(target, draft);
        if (context.resultTurnId !== draft.resultTurnId) {
          return writeReceiptFinalizationAlert(draft, "post_record_activity", { stateDir });
        }
        if (context.resultTurnStatus === "inProgress") {
          await new Promise(resolve => setTimeout(resolve, pollMs));
          continue;
        }
        // Legacy v1 drafts have no activity marker, so terminal ordering remains
        // unprovable; v2 drafts use the strict marker fence above.
        return writeReceiptFinalizationAlert(draft, "post_record_activity_unprovable", { stateDir });
      } catch (error) {
        if (!(error instanceof DesktopError) ||
            !["DESKTOP_STATE_UNAVAILABLE", "DESKTOP_IPC_UNAVAILABLE", "DESKTOP_IPC_TIMEOUT"].includes(error.code)) {
          return writeReceiptFinalizationAlert(draft, "identity_drift", { stateDir });
        }
        await new Promise(resolve => setTimeout(resolve, pollMs));
      }
    }
    return writeReceiptFinalizationAlert(draft, "timeout", { stateDir });
  } finally {
    releaseReceiptFinalizationClaim(stateDir, draft);
  }
}

export function spawnReceiptFinalizerWorker(
  draft: ReceiptFinalizationDraft,
  options: { stateDir?: string; spawnImpl?: typeof spawn; entry?: string } = {},
): ChildProcess {
  const stateDir = options.stateDir ?? getStateDir();
  const spawnFn = options.spawnImpl ?? spawn;
  const entry = options.entry ?? process.argv[1];
  if (!entry) throw new Error("无法确定 receipt finalizer worker entry");
  const env = { ...process.env };
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_SESSION_ID;
  delete env.C2C_STARTUP_LEASE;
  env.C2C_RECEIPT_FINALIZER_STATE_DIR = path.resolve(stateDir);
  env.C2C_STATE_DIR = path.resolve(stateDir);
  const runtimeArgs = path.extname(entry).toLowerCase() === ".ts" ? ["--import", "tsx"] : [];
  const child = spawnFn(process.execPath, [...runtimeArgs, entry, "desktop-receipt-finalizer", "run", "-w", draft.workspaceRoot, "--draft", draft.draftId], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env,
  });
  child.once("error", () => { try { writeReceiptFinalizationAlert(draft, "worker_spawn_failed", { stateDir }); } catch { /* bounded fallback */ } });
  child.once("exit", (code, signal) => {
    if (code === 0 && signal === null) return;
    try { writeReceiptFinalizationWorkerFailureAlert(draft, { stateDir }); } catch { /* bounded fallback */ }
  });
  child.unref();
  return child;
}
