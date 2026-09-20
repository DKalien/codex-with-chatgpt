import { readExecutionRecordsStrict, isTrustedDesktopReceipt } from "../execution/records.js";
import { DesktopError, readDesktop } from "./store.js";
import { getReconciledLegacyCommandIds } from "./legacy-reconciliation.js";
import { getRetiredLegacyCommandIds, readLegacyRetirements } from "./legacy-retirement.js";
import { getAbandonedCommandIds } from "./abandonment.js";
import { getResolvedUnknownCommandIds } from "./outcome-resolution.js";

export type DesktopHistoryStatus = "receipted" | "reconciled" | "retired" | "abandoned" | "unresolved" | "resolved_unknown";

/** CLI 与 rollout 共用本机严格证据判定；不调用 IPC、不创建任何状态。 */
export function desktopHistory(workspace: { id: string; root: string }) {
  const desktop = readDesktop(workspace.id);
  if (desktop && desktop.workspaceRoot !== workspace.root)
    throw new DesktopError("DESKTOP_HISTORY_CONFLICT", "Desktop workspace 不匹配。");
  const records = readExecutionRecordsStrict(workspace.id);
  const reconciled = getReconciledLegacyCommandIds(workspace);
  const retired = getRetiredLegacyCommandIds(workspace);
  const abandoned = getAbandonedCommandIds(workspace);
  const ownerless = new Set(readLegacyRetirements(workspace.id)
    .filter(entry => "kind" in entry && entry.kind === "ownerless").map(entry => entry.commandId));
  const resolvedUnknown = getResolvedUnknownCommandIds(workspace);
  const accepted = desktop?.deliveries.filter(item => item.deliveryStatus === "accepted") ?? [];
  const statuses = new Map<string, DesktopHistoryStatus>();
  const skipHistory = new Set<string>();
  const unknown = desktop?.deliveries.filter(item => item.deliveryStatus === "outcome_unknown") ?? [];
  for (const delivery of unknown) {
    statuses.set(delivery.commandId, resolvedUnknown.has(delivery.commandId) ? "resolved_unknown" : "unresolved");
  }
  for (const delivery of accepted) {
    const matches = records.filter(record => record.commandId === delivery.commandId || record.taskId === `desktop_${delivery.commandId}`);
    if (matches.length > 1) throw new DesktopError("DESKTOP_HISTORY_CONFLICT", "Desktop execution 记录重复或冲突。");
    const evidence: DesktopHistoryStatus[] = [];
    if (matches.length === 1 && isTrustedDesktopReceipt(matches[0]!, delivery.commandId)) evidence.push("receipted");
    if (reconciled.has(delivery.commandId)) evidence.push("reconciled");
    if (retired.has(delivery.commandId)) evidence.push("retired");
    if (abandoned.has(delivery.commandId)) evidence.push("abandoned");
    if (evidence.length > 1) throw new DesktopError("DESKTOP_HISTORY_CONFLICT", "Desktop 历史存在多种冲突证据。");
    const status = evidence[0] ?? "unresolved";
    statuses.set(delivery.commandId, status);
    if (status === "receipted" || status === "reconciled" || status === "abandoned") skipHistory.add(delivery.commandId);
  }
  return { desktop, accepted, statuses, skipHistory, retired, ownerless };
}

export function listDesktopHistory(workspace: { id: string; root: string }): Array<{ commandId: string; status: DesktopHistoryStatus }> {
  return [...desktopHistory(workspace).statuses].map(([commandId, status]) => ({ commandId, status }));
}
