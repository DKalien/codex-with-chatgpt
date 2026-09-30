import { listResults, resolveWorkspaceIdentity, type RoutingWorkspaceIdentity } from "../routing/store.js";
import { enqueueResultBusEntries } from "./store.js";
import { isCanonicalRoutingResult } from "./schema.js";

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
  const resolved = resolveWorkspaceIdentity(identity);
  const results = listResults(resolved, stateDir).filter(isCanonicalRoutingResult);
  return enqueueResultBusEntries(resolved, results, stateDir);
}
