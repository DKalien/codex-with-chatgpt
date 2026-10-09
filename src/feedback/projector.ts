import {
  readExecutionRecordsStrict,
  type StoredExecutionRecord,
} from "../execution/records.js";
import { applyProjection } from "./projection-store.js";
import {
  ensureFeedbackState,
  feedbackStateFile,
  readFeedbackState,
  recoverStaleFeedback,
} from "./state-store.js";
import { finalReceiptRequiredEventId } from "./projection-store.js";
import {
  FINAL_RECEIPT_REQUIRED_EVENT_KIND,
  feedbackEventSchema,
  FeedbackError,
  type FinalReceiptRequiredEvent,
  type FeedbackEvent,
  type FeedbackState,
} from "./schema.js";
import { listReceiptFinalizationAlerts } from "../desktop/receipt-finalizer.js";
import { resolveWorkspaceIdentity } from "../routing/store.js";
import { getStateDir } from "../config/paths.js";
import { assertFeedbackCommandSnapshot, withFeedbackCommandLocks } from "./command-locks.js";
import fs from "node:fs";
import { createHash } from "node:crypto";

/** 仅生成 FINAL_RECEIPT_REQUIRED；execution records 保留本机读取，cursor 继续按原事务推进。 */
export function reconcileFeedbackOutbox(
  workspaceId: string,
  stateDir?: string,
  workspaceRoot?: string,
  batchSize = 50,
): { state: FeedbackState; projected: number } {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new FeedbackError("FEEDBACK_BATCH_INVALID", "维护批量必须在 1–1000 之间。");
  const resolvedStateDir = stateDir ?? getStateDir();
  if (workspaceRoot) resolveWorkspaceIdentity({ id: workspaceId, root: workspaceRoot });
  const initialRecords = readExecutionRecordsStrict(workspaceId, resolvedStateDir);
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
  const collectIds = (records: readonly StoredExecutionRecord[], alerts: typeof initialAlerts, state: FeedbackState | null) => [
    ...pendingRecords(records, state).flatMap(record => record.commandId ? [record.commandId] : []),
    ...pendingAlerts(alerts, state).map(alert => alert.commandId),
  ];
  const lockedIds = collectIds(initialRecords, initialAlerts, initialState);
  return withFeedbackCommandLocks(workspaceId, lockedIds, resolvedStateDir, () => {
    const records = readExecutionRecordsStrict(workspaceId, resolvedStateDir);
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
    assertFeedbackCommandSnapshot(lockedIds, collectIds(records, alerts, currentState));
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
    const newEvents: FeedbackEvent[] = [];
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
