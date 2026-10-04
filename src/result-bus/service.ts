import { listResults, resolveWorkspaceIdentity, type RoutingWorkspaceIdentity } from "../routing/store.js";
import { enqueueResultBusEntries, readResultBus } from "./store.js";
import { isCanonicalRoutingResult } from "./schema.js";
import { readCleanupJournal, withCommandOperation } from "../command-cleanup/fence.js";
import { getStateDir } from "../config/paths.js";
import { CommandCleanupError } from "../command-cleanup/schema.js";

export type ResultBusReconciliation = {
  projected: number;
  replayed: number;
};

/**
 * Shadow/backfill only: reconcile every persisted canonical RoutingResult into the
 * Result Bus, planner- and sink-independent. Legacy results are never promoted.
 * Single-lock, idempotent; safe to retry from production reconciliation at any time.
 */
export function reconcileWorkspaceResultBus(identity: RoutingWorkspaceIdentity, stateDir?: string): ResultBusReconciliation {
  const { projected, replayed } = reconcileResults(identity, stateDir, false);
  return { projected, replayed };
}

/** Delivery preparation only: isolate unavailable command lifecycle authority.
 * Store/source/immutable failures still abort; this is never a lock-recovery API.
 */
export function projectAvailableResultBusCommands(identity: RoutingWorkspaceIdentity, stateDir?: string, batch?: { limit: number; after?: string }) {
  return reconcileResults(identity, stateDir, true, batch);
}

function reconcileResults(identity: RoutingWorkspaceIdentity, stateDir: string | undefined, isolateUnavailable: boolean, batch?: { limit: number; after?: string }) {
  if (batch && (!Number.isInteger(batch.limit) || batch.limit < 1 || batch.limit > 100)) throw new Error("Invalid maintenance batch");
  const resolved = resolveWorkspaceIdentity(identity);
  const directory = stateDir ?? getStateDir();
  // Even if every command is fenced, an unreadable Bus is not a degraded success.
  if (isolateUnavailable) readResultBus(resolved, directory);
  const commandIds = [...new Set(listResults(resolved, directory).filter(isCanonicalRoutingResult).map(result => result.commandId))].sort();
  let projected = 0, replayed = 0;
  const skipped: Array<{ commandId: string; code: "COMMAND_CLEANUP_BUSY" | "COMMAND_CLEANUP_IN_PROGRESS" }> = [];
  const start = batch?.after ? commandIds.findIndex(id => id > batch.after!) : 0;
  const ordered = start > 0 ? [...commandIds.slice(start), ...commandIds.slice(0, start)] : commandIds;
  const selected = ordered.slice(0, batch?.limit ?? commandIds.length);
  for (const commandId of selected) {
    if (readCleanupJournal(resolved.id, commandId, directory)) {
      if (isolateUnavailable) skipped.push({ commandId, code: "COMMAND_CLEANUP_IN_PROGRESS" });
      continue;
    }
    try {
      const outcome = withCommandOperation(resolved.id, commandId, () => {
        // Re-read under lifecycle authority: stale pre-cleanup sources cannot backfill.
        return enqueueResultBusEntries(resolved, listResults(resolved, directory).filter(result => result.commandId === commandId && isCanonicalRoutingResult(result)), directory);
      }, directory);
      projected += outcome.projected; replayed += outcome.replayed;
    } catch (error) {
      if (!isolateUnavailable || !(error instanceof CommandCleanupError)
        || (error.commandId !== undefined && error.commandId !== commandId)
        || (error.code !== "COMMAND_CLEANUP_BUSY" && error.code !== "COMMAND_CLEANUP_IN_PROGRESS")) throw error;
      skipped.push({ commandId, code: error.code });
    }
  }
  return { projected, replayed, skipped, ...(batch && selected.length ? { next: selected.at(-1)! } : {}) };
}
