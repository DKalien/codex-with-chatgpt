import {
  isTrustedDesktopReceipt,
  readExecutionRecordsStrict,
  TERMINAL_EXECUTION_STATUSES,
  type StoredExecutionRecord,
} from "../execution/records.js";
import { readDesktop, type DesktopState } from "../desktop/store.js";
import { applyProjection } from "./projection-store.js";
import {
  ensureFeedbackState,
  recoverStaleFeedback,
} from "./state-store.js";
import { finalReceiptRequiredEventId, feedbackEventId } from "./projection-store.js";
import {
  FINAL_RECEIPT_REQUIRED_EVENT_KIND,
  feedbackEventSchema,
  FeedbackError,
  type FinalReceiptRequiredEvent,
  type FeedbackEvent,
  type FeedbackState,
} from "./schema.js";
import { listReceiptFinalizationAlerts } from "../desktop/receipt-finalizer.js";
import { readRouting, resolveWorkspaceIdentity } from "../routing/store.js";

function changedFilesSummary(record: StoredExecutionRecord): string[] {
  if (Array.isArray(record.changedFiles)) {
    return record.changedFiles.slice(0, 200);
  }
  return [`changedFiles=${record.changedFiles}`];
}

/**
 * Explicit Desktop receipt provenance only.
 * Accepted-delivery commandId match alone is NOT provenance — generic `c2c record`
 * may share commandId; only trusted Desktop writer markers qualify.
 */
function claimsDesktopReceipt(record: StoredExecutionRecord): boolean {
  if (record.desktopReceiptSha256) return true;
  if (typeof record.taskId === "string" && record.taskId.startsWith("desktop_")) return true;
  return false;
}

function assertTrustedDesktopReceipt(
  record: StoredExecutionRecord,
  desktop: DesktopState | null,
): asserts record is StoredExecutionRecord & { commandId: string } {
  if (!record.commandId) {
    throw new FeedbackError(
      "FEEDBACK_DESKTOP_IDENTITY_CONFLICT",
      "Desktop-like 记录缺少 commandId；拒绝静默投影",
    );
  }
  const accepted = desktop?.deliveries.filter(
    (d) => d.commandId === record.commandId && d.deliveryStatus === "accepted",
  ) ?? [];
  if (accepted.length !== 1) {
    throw new FeedbackError(
      "FEEDBACK_DESKTOP_IDENTITY_CONFLICT",
      "Desktop-like 记录缺少唯一 accepted delivery；拒绝静默投影",
    );
  }
  if (!accepted[0]!.turnId) {
    throw new FeedbackError(
      "FEEDBACK_DESKTOP_IDENTITY_CONFLICT",
      "accepted delivery 缺少 turnId；拒绝静默投影",
    );
  }
  if (record.taskId !== `desktop_${record.commandId}` || record.iteration !== 1) {
    throw new FeedbackError(
      "FEEDBACK_DESKTOP_IDENTITY_CONFLICT",
      "Desktop receipt taskId/iteration 身份不匹配；拒绝静默投影",
    );
  }
  if (!isTrustedDesktopReceipt(record, record.commandId)) {
    throw new FeedbackError(
      "FEEDBACK_DESKTOP_IDENTITY_CONFLICT",
      "Desktop-like 记录与 trusted receipt 证据冲突；拒绝静默投影",
    );
  }
}

/**
 * 只投影 cursor 之后的 strict records。
 * 首次 baseline cursor = 当前 record 数量，不投历史。
 * 每次 reconcile 先做 stale convergence，再处理 slice。
 *
 * R5d3 cutover：routed canonical results 不再投影为 Feedback canonical 投递事件
 * （canonical delivery 由 Workspace Result Bus 承担；R4 outbox 的兼容投影
 * 保留在 feedback 层独立的 canonical 投影兼容模块）。本函数只负责 legacy
 * 非 routed 投递与 FINAL_RECEIPT_REQUIRED 控制事件。
 */
export function reconcileFeedbackOutbox(
  workspaceId: string,
  stateDir?: string,
  workspaceRoot?: string,
): { state: FeedbackState; projected: number } {
  const records = readExecutionRecordsStrict(workspaceId);
  ensureFeedbackState(workspaceId, records.length, stateDir);
  // 即使 slice 为空也必须收敛 stale claimed，保证 status 即可恢复。
  let state = recoverStaleFeedback(workspaceId, stateDir);
  if (state.projectionCursor > records.length) {
    throw new FeedbackError(
      "FEEDBACK_CURSOR_CONFLICT",
      "execution JSONL 短于 projection cursor；拒绝重置 cursor",
    );
  }
  const slice = records.slice(state.projectionCursor);
  const desktop = readDesktop(workspaceId);
  const routingIdentity = workspaceRoot ? resolveWorkspaceIdentity({ id: workspaceId, root: workspaceRoot }) : null;
  // Routed commands are never eligible for the untargeted legacy projector,
  // even while their canonical result delivery is pending or unavailable.
  const routing = routingIdentity ? readRouting(routingIdentity, stateDir) : null;
  const routedCommandIds = new Set(routing?.commands.map(command => command.commandId) ?? []);
  const canonicalByIdentity = new Set(
    (routing?.results ?? [])
      .filter(result => "rawSummary" in result)
      .map(result => `${result.commandId}\u0000${result.iteration}`),
  );
  const newEvents: FeedbackEvent[] = [];
  for (const record of slice) {
    if (!claimsDesktopReceipt(record)) {
      // 无 Desktop provenance marker 的普通 record：安全 skip，cursor 随后前进。
      continue;
    }
    assertTrustedDesktopReceipt(record, desktop);
    if (record.commandId && routedCommandIds.has(record.commandId)) continue;
    if (canonicalByIdentity.has(`${record.commandId}\u0000${record.iteration}`)) continue;
    if (!(TERMINAL_EXECUTION_STATUSES as readonly string[]).includes(record.exitStatus)) {
      continue;
    }
    const eventId = feedbackEventId({
      workspaceId,
      commandId: record.commandId!,
      taskId: record.taskId,
      iteration: record.iteration,
      desktopReceiptSha256: record.desktopReceiptSha256!,
    });
    const occurredAt = record.timestamp;
    newEvents.push(feedbackEventSchema.parse({
      version: 1,
      eventId,
      kind: "C2C_EXECUTED",
      workspaceId,
      source: "desktop",
      commandId: record.commandId!,
      taskId: record.taskId,
      iteration: record.iteration,
      result: record.exitStatus as "ok" | "failed" | "blocked",
      changedFilesSummary: changedFilesSummary(record),
      testsSummary: truncateSummary(record.tests ?? ""),
      outputAvailable: record.outputAvailable === true,
      ...(record.outputId !== undefined ? { outputId: record.outputId } : {}),
      occurredAt,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      targetBindingId: null,
      targetEpoch: null,
      targetPrincipalFingerprint: null,
      status: "queued",
    }));
  }
  for (const alert of listReceiptFinalizationAlerts(stateDir).filter(item => item.workspaceId === workspaceId)) {
    const eventId = finalReceiptRequiredEventId({ workspaceId, commandId: alert.commandId, alertId: alert.alertId });
    if (state.events.some(event => event.eventId === eventId)) continue;
    const occurredAt = alert.occurredAt;
    newEvents.push(feedbackEventSchema.parse({
      version: 1,
      eventId,
      kind: FINAL_RECEIPT_REQUIRED_EVENT_KIND,
      workspaceId,
      source: "control",
      commandId: alert.commandId,
      taskId: `desktop_finalization_${alert.commandId}`,
      iteration: 1,
      result: "blocked",
      changedFilesSummary: [],
      testsSummary: "",
      outputAvailable: false,
      reason: alert.reason,
      occurredAt,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      targetBindingId: null,
      targetEpoch: null,
      targetPrincipalFingerprint: null,
      status: "queued",
    } as FinalReceiptRequiredEvent));
  }
  if (newEvents.length === 0 && slice.length === 0) {
    return { state, projected: 0 };
  }
  const next = applyProjection({
    workspaceId,
    stateDir,
    nextCursor: records.length,
    newEvents,
  });
  return { state: next, projected: newEvents.length };
}

function truncateSummary(text: string, max = 2000): string {
  return text.length > max ? text.slice(0, max) : text;
}
