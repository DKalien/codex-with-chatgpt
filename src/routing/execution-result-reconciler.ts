import { isTrustedDesktopReceipt, readExecutionRecordsStrict, withExecutionRecordsLock } from "../execution/records.js";
import { appendResultWithReplay, readRouting, type RoutingWorkspaceIdentity } from "./store.js";
import { projectTrustedDesktopExecutionResult } from "./execution-result-projector.js";
import {
  clearResultReconciliationNeeded,
  enqueueResultOutboxEntry,
  listResultOutboxEntries,
  markResultReconciliationNeeded,
} from "./result-outbox-store.js";
import { RoutingError, routingCommandIdSchema } from "./schema.js";

export type DesktopExecutionResultReconciliation =
  | { status: "not_applicable"; reason: "routing_command_missing" }
  | { status: "not_canonical"; reason: "receipt_not_trusted_or_legacy" }
  | { status: "reconciled"; resultId: string; plannerRouteId: string; resultReplayed: boolean; outboxEntryId: string; outboxReplayed: boolean }
  | { status: "reconciliation_needed"; reasonCode: string; issuePersisted: boolean };

function reasonCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : "RESULT_RECONCILIATION_FAILED";
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : "RESULT_RECONCILIATION_FAILED";
}

function recordFailure(
  identity: RoutingWorkspaceIdentity,
  commandId: string,
  error: unknown,
): DesktopExecutionResultReconciliation {
  const code = reasonCode(error);
  try {
    markResultReconciliationNeeded(identity, { commandId, reasonCode: code });
    return { status: "reconciliation_needed", reasonCode: code, issuePersisted: true };
  } catch {
    return { status: "reconciliation_needed", reasonCode: code, issuePersisted: false };
  }
}

/**
 * Local post-receipt seam: use only the accepted Command captured at delivery time and its
 * trusted local receipt. Receipt, RoutingResult and Result Outbox are separate durable commits;
 * this function is deliberately idempotent so a retry repairs result-only partial progress.
 */
export function reconcileTrustedDesktopExecutionResult(
  identity: RoutingWorkspaceIdentity,
  commandId: string,
): DesktopExecutionResultReconciliation {
  const parsedCommandId = routingCommandIdSchema.safeParse(commandId);
  if (!parsedCommandId.success) {
    return { status: "not_canonical", reason: "receipt_not_trusted_or_legacy" };
  }

  try {
    const state = readRouting(identity);
    const command = state?.commands.find(item => item.commandId === parsedCommandId.data);
    if (!command) return { status: "not_applicable", reason: "routing_command_missing" };
    if (command.deliveryStatus !== "accepted") {
      throw new RoutingError("ROUTING_COMMAND_NOT_ACCEPTED", "canonical result 只接受已确认 Desktop delivery 的 Command。");
    }
    const planner = state!.routes.find(route => route.routeId === command.plannerRouteId);
    if (!planner || planner.role !== "planner") {
      throw new RoutingError("ROUTING_RESULT_PLANNER_INVALID", "persisted Command.plannerRouteId 未解析为本 workspace planner route。");
    }

    return withExecutionRecordsLock(identity.id, () => {
      try {
        const records = readExecutionRecordsStrict(identity.id);
        const taskId = `desktop_${command.commandId}`;
        const matches = records.filter(item => item.commandId === command.commandId || item.taskId === taskId);
        if (matches.length > 1) {
          throw new RoutingError("ROUTING_RESULT_RECEIPT_AMBIGUOUS", "同一 Desktop Command 存在多个 execution record，不能安全选择可信 receipt。");
        }
        if (matches.length === 0) {
          const hasResult = state!.results.some(item => item.commandId === command.commandId && item.iteration === 1);
          const hasOutboxEntry = listResultOutboxEntries(identity).some(
            item => item.commandId === command.commandId && item.iteration === 1,
          );
          // The intent may have been committed before a receipt write failed. This check
          // is under the execution-record lock: a concurrent writer must publish a new
          // intent before its own receipt, so clearing this orphan cannot reopen a gap.
          if (!hasResult && !hasOutboxEntry) clearResultReconciliationNeeded(identity, command.commandId);
          return { status: "not_canonical", reason: "receipt_not_trusted_or_legacy" };
        }
        if (!isTrustedDesktopReceipt(matches[0]!, command.commandId) ||
            matches[0]!.rawSummary === undefined) {
          return { status: "not_canonical", reason: "receipt_not_trusted_or_legacy" };
        }

        // Projector verifies the exact receipt digest, accepted delivery, executor/thread/turn,
        // output index and canonical machine evidence. It does not consult Browser/feedback state.
        const candidate = projectTrustedDesktopExecutionResult(identity, {
          commandId: command.commandId,
          desktopReceiptSha256: matches[0]!.desktopReceiptSha256!,
        });
        const hasResult = readRouting(identity)?.results.some(
          item => item.commandId === command.commandId && item.iteration === candidate.iteration,
        ) ?? false;
        const hasOutboxEntry = listResultOutboxEntries(identity).some(
          item => item.commandId === command.commandId && item.iteration === candidate.iteration,
        );
        if (!hasResult || !hasOutboxEntry) {
          // Publish before the first semantic commit. A crash after appendResult remains discoverable.
          markResultReconciliationNeeded(identity, {
            commandId: command.commandId,
            reasonCode: "RESULT_RECONCILIATION_PENDING",
          });
        }
        const { result, replayed: resultReplayed } = appendResultWithReplay(identity, candidate);
        if (!("rawSummary" in result) || !("machineEvidence" in result)) {
          throw new RoutingError("ROUTING_RESULT_LEGACY_CONFLICT", "既有 legacy RoutingResult 不能升级为 canonical result。");
        }

        // The outbox store cross-checks this reference against the persisted result and command.
        const queued = enqueueResultOutboxEntry(identity, {
          commandId: command.commandId,
          iteration: result.iteration,
        });
        clearResultReconciliationNeeded(identity, command.commandId);
        return {
          status: "reconciled",
          resultId: result.resultId,
          plannerRouteId: command.plannerRouteId,
          resultReplayed,
          outboxEntryId: queued.entry.outboxEntryId,
          outboxReplayed: queued.replayed,
        };
      } catch (error) {
        return recordFailure(identity, command.commandId, error);
      }
    });
  } catch (error) {
    return recordFailure(identity, parsedCommandId.data, error);
  }
}
