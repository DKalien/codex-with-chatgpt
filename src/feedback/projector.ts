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
  feedbackStateFile,
  readFeedbackState,
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
import { getStateDir } from "../config/paths.js";
import { assertFeedbackCommandSnapshot, withFeedbackCommandLocks } from "./command-locks.js";
import fs from "node:fs";
import { createHash } from "node:crypto";

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
  batchSize = 50,
): { state: FeedbackState; projected: number } {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new FeedbackError("FEEDBACK_BATCH_INVALID", "维护批量必须在 1–1000 之间。");
  const resolvedStateDir = stateDir ?? getStateDir();
  const identity = workspaceRoot ? resolveWorkspaceIdentity({ id: workspaceId, root: workspaceRoot }) : null;
  const initialRecords = readExecutionRecordsStrict(workspaceId, resolvedStateDir);
  const initialRouting = identity ? readRouting(identity, resolvedStateDir) : null;
  const initialAlerts = listReceiptFinalizationAlerts(resolvedStateDir).filter(item => item.workspaceId === workspaceId);
  const feedbackFile = feedbackStateFile(workspaceId, resolvedStateDir);
  let initialState: FeedbackState | null = null;
  try {
    const stat = fs.lstatSync(feedbackFile);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new FeedbackError("FEEDBACK_STATE_CORRUPT", "feedback state 不是普通文件");
    initialState = readFeedbackState(workspaceId, resolvedStateDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof FeedbackError && error.code === "FEEDBACK_STATE_UNINITIALIZED")) throw error;
  }
  if (initialState) initialState = recoverStaleFeedback(workspaceId, resolvedStateDir);
  const pendingRecords = (records: readonly StoredExecutionRecord[], state: FeedbackState | null) =>
    records.slice(state?.projectionCursor ?? records.length, (state?.projectionCursor ?? records.length) + batchSize);
  const pendingAlerts = (alerts: typeof initialAlerts, state: FeedbackState | null) => alerts
    .filter(alert => !state?.events.some(event => event.eventId === finalReceiptRequiredEventId({ workspaceId, commandId: alert.commandId, alertId: alert.alertId })))
    .slice(0, batchSize);
  const collectIds = (records: readonly StoredExecutionRecord[], _routing: ReturnType<typeof readRouting>, alerts: typeof initialAlerts, state: FeedbackState | null) => [
    ...pendingRecords(records, state).flatMap(record => record.commandId ? [record.commandId] : []),
    ...pendingAlerts(alerts, state).map(alert => alert.commandId),
  ];
  const lockedIds = collectIds(initialRecords, initialRouting, initialAlerts, initialState);
  return withFeedbackCommandLocks(workspaceId, lockedIds, resolvedStateDir, () => {
    const records = readExecutionRecordsStrict(workspaceId, resolvedStateDir);
    const routing = identity ? readRouting(identity, resolvedStateDir) : null;
    const alerts = listReceiptFinalizationAlerts(resolvedStateDir).filter(item => item.workspaceId === workspaceId);
    let currentState: FeedbackState | null = null;
    try {
      const stat = fs.lstatSync(feedbackFile);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new FeedbackError("FEEDBACK_STATE_CORRUPT", "feedback state 不是普通文件");
      currentState = readFeedbackState(workspaceId, resolvedStateDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" &&
          !(error instanceof FeedbackError && error.code === "FEEDBACK_STATE_UNINITIALIZED")) throw error;
    }
    assertFeedbackCommandSnapshot(lockedIds, collectIds(records, routing, alerts, currentState));
    if (currentState?.cleanupAdjustments?.length) {
      throw new FeedbackError("FEEDBACK_CURSOR_CLEANUP_PENDING", "command cleanup cursor adjustment 仍 active；拒绝推进全局 projection cursor。");
    }

    ensureFeedbackState(workspaceId, records.length, resolvedStateDir);
    // Explicit maintenance only; read-only queries never call this projector.
    const state = readFeedbackState(workspaceId, resolvedStateDir);
    if (state.projectionCursor > records.length) {
      throw new FeedbackError("FEEDBACK_CURSOR_CONFLICT", "execution JSONL 短于 projection cursor；拒绝重置 cursor");
    }
    const slice = pendingRecords(records, state);
    const desktop = readDesktop(workspaceId, resolvedStateDir);
    const routedCommandIds = new Set(routing?.commands.map(command => command.commandId) ?? []);
    const canonicalByIdentity = new Set((routing?.results ?? [])
      .filter(result => "rawSummary" in result)
      .map(result => `${result.commandId}\u0000${result.iteration}`));
    const newEvents: FeedbackEvent[] = [];
    for (const record of slice) {
      if (!claimsDesktopReceipt(record)) continue;
      assertTrustedDesktopReceipt(record, desktop);
      if (record.commandId && routedCommandIds.has(record.commandId)) continue;
      if (canonicalByIdentity.has(`${record.commandId}\u0000${record.iteration}`)) continue;
      if (!(TERMINAL_EXECUTION_STATUSES as readonly string[]).includes(record.exitStatus)) continue;
      const eventId = feedbackEventId({ workspaceId, commandId: record.commandId!, taskId: record.taskId,
        iteration: record.iteration, desktopReceiptSha256: record.desktopReceiptSha256! });
      const occurredAt = record.timestamp;
      newEvents.push(feedbackEventSchema.parse({
        version: 1, eventId, kind: "C2C_EXECUTED", workspaceId, source: "desktop", commandId: record.commandId!,
        taskId: record.taskId, iteration: record.iteration, result: record.exitStatus as "ok" | "failed" | "blocked",
        changedFilesSummary: changedFilesSummary(record), testsSummary: truncateSummary(record.tests ?? ""),
        outputAvailable: record.outputAvailable === true,
        ...(record.outputId !== undefined ? { outputId: record.outputId } : {}), occurredAt,
        createdAt: occurredAt, updatedAt: occurredAt, targetBindingId: null, targetEpoch: null,
        targetPrincipalFingerprint: null, status: "queued",
      }));
    }
    for (const alert of pendingAlerts(alerts, state)) {
      const eventId = finalReceiptRequiredEventId({ workspaceId, commandId: alert.commandId, alertId: alert.alertId });
      if (state.events.some(event => event.eventId === eventId)) continue;
      const occurredAt = alert.occurredAt;
      newEvents.push(feedbackEventSchema.parse({
        version: 1, eventId, kind: FINAL_RECEIPT_REQUIRED_EVENT_KIND, workspaceId, source: "control",
        commandId: alert.commandId, taskId: `desktop_finalization_${alert.commandId}`, iteration: 1,
        result: "blocked", changedFilesSummary: [], testsSummary: "", outputAvailable: false, reason: alert.reason,
        occurredAt, createdAt: occurredAt, updatedAt: occurredAt, targetBindingId: null, targetEpoch: null,
        targetPrincipalFingerprint: null, status: "queued",
      } as FinalReceiptRequiredEvent));
    }
    if (newEvents.length === 0 && slice.length === 0) return { state, projected: 0 };
    const next = applyProjection({ workspaceId, stateDir: resolvedStateDir, nextCursor: state.projectionCursor + slice.length, newEvents,
      source: { recordsSha256: createHash("sha256").update(JSON.stringify(records)).digest("hex"), cursor: state.projectionCursor } });
    return { state: next, projected: newEvents.length };
  });
}

function truncateSummary(text: string, max = 2000): string {
  return text.length > max ? text.slice(0, max) : text;
}
