import { createHash } from "node:crypto";
import { getStateDir } from "../config/paths.js";
import { listReceiptFinalizationAlerts } from "../desktop/receipt-finalizer.js";
import {
  FINAL_RECEIPT_REQUIRED_EVENT_KIND,
  FeedbackError,
  legacyFeedbackStateSchema,
  type FeedbackBinding,
  type FeedbackEvent,
  type FeedbackState,
} from "./schema.js";
import {
  recoverStaleInMemory,
  readFeedbackState,
  requireInitializedState,
  withFeedbackLock,
  writeState,
} from "./state-store.js";

export function feedbackEventId(parts: {
  workspaceId: string;
  commandId: string;
  taskId: string;
  iteration: number;
  desktopReceiptSha256: string;
}): string {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex").slice(0, 32);
}

export function finalReceiptRequiredEventId(input: {
  workspaceId: string;
  commandId: string;
  alertId: string;
}): string {
  return createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex").slice(0, 32);
}

export interface FinalReceiptRepairResult {
  state: FeedbackState;
  removedEventIds: string[];
}

export function repairFinalReceiptRequired(
  workspaceId: string,
  stateDir = getStateDir(),
): FinalReceiptRepairResult {
  return withFeedbackLock(workspaceId, stateDir, (read) => {
    const previous = requireInitializedState(read(), workspaceId);
    const alerts = listReceiptFinalizationAlerts(stateDir).filter((a) => a.workspaceId === workspaceId);
    const byCommand = new Map<string, typeof alerts>();
    for (const alert of alerts) byCommand.set(alert.commandId, [...(byCommand.get(alert.commandId) ?? []), alert]);
    for (const [commandId, entries] of byCommand) {
      if (entries.length > 1) throw new FeedbackError("FEEDBACK_FINALIZATION_CONFLICT", `同一 commandId 存在多个 durable finalization alert: ${commandId}`);
    }
    const seen = new Set<string>();
    const controlCommands = new Set<string>();
    const removedEventIds: string[] = [];
    for (const event of previous.events) {
      if (seen.has(event.eventId)) throw new FeedbackError("FEEDBACK_FINALIZATION_CONFLICT", `feedback state 存在重复 eventId: ${event.eventId}`);
      seen.add(event.eventId);
      if (event.kind !== FINAL_RECEIPT_REQUIRED_EVENT_KIND) continue;
      if (controlCommands.has(event.commandId)) throw new FeedbackError("FEEDBACK_FINALIZATION_CONFLICT", `存在重复的 FINAL_RECEIPT_REQUIRED: ${event.commandId}`);
      controlCommands.add(event.commandId);
      const entries = byCommand.get(event.commandId) ?? [];
      if (entries.length === 0) throw new FeedbackError("FEEDBACK_FINALIZATION_UNSUPPORTED", `FINAL_RECEIPT_REQUIRED 缺少 durable alert: ${event.commandId}`);
      const [alert] = entries;
      const expected = finalReceiptRequiredEventId({ workspaceId, commandId: alert.commandId, alertId: alert.alertId });
      if (event.workspaceId !== alert.workspaceId || event.workspaceId !== workspaceId
        || event.commandId !== alert.commandId || event.eventId !== expected
        || event.taskId !== `desktop_finalization_${alert.commandId}` || event.iteration !== 1
        || event.result !== "blocked" || event.reason !== alert.reason || event.occurredAt !== alert.occurredAt
        || event.changedFilesSummary.length !== 0 || event.testsSummary !== "" || event.outputAvailable !== false) {
        throw new FeedbackError("FEEDBACK_FINALIZATION_CONFLICT", `FINAL_RECEIPT_REQUIRED 与 durable alert 身份冲突: ${event.commandId}`);
      }
      if (["reserved", "claimed", "outcome_unknown"].includes(event.status)) {
        throw new FeedbackError("FEEDBACK_FINALIZATION_CONFLICT", `FINAL_RECEIPT_REQUIRED 仍在投递中: ${event.commandId}`);
      }
      removedEventIds.push(event.eventId);
    }
    if (removedEventIds.length === 0) {
      legacyFeedbackStateSchema.parse(previous);
      return { state: previous, removedEventIds };
    }
    const removed = new Set(removedEventIds);
    const next = { ...previous, events: previous.events.filter((event) => !removed.has(event.eventId)) };
    legacyFeedbackStateSchema.parse(next);
    writeState(workspaceId, stateDir, next);
    const reread = requireInitializedState(readFeedbackState(workspaceId, stateDir), workspaceId);
    if (reread.events.some((event) => event.kind === FINAL_RECEIPT_REQUIRED_EVENT_KIND)) {
      throw new FeedbackError("FEEDBACK_FINALIZATION_CONFLICT", "兼容修复后仍残留控制事件");
    }
    legacyFeedbackStateSchema.parse(reread);
    return { state: reread, removedEventIds };
  });
}

export const repairForwardFeedbackControlEvents = repairFinalReceiptRequired;

/** 投影到 store：与 cursor 原子前进。 */
export function applyProjection(input: {
  workspaceId: string;
  stateDir?: string;
  nextCursor: number;
  newEvents: FeedbackEvent[];
}): FeedbackState {
  const stateDir = input.stateDir ?? getStateDir();
  return withFeedbackLock(input.workspaceId, stateDir, (read) => {
    const previous = requireInitializedState(read(), input.workspaceId);
    if (input.nextCursor < previous.projectionCursor) {
      throw new FeedbackError("FEEDBACK_CURSOR_REGRESSION", "projection cursor 不得回退");
    }
    const now = new Date().toISOString();
    const existing = new Set(previous.events.map((e) => e.eventId));
    const binding = previous.binding && previous.binding.status === "active" ? previous.binding : null;
    const added = input.newEvents
      .filter((event) => !existing.has(event.eventId))
      .map((event) => {
        const pinned = "plannerPrincipalFingerprint" in event ? event.plannerPrincipalFingerprint : undefined;
        if (binding && (!pinned || pinned === binding.principalFingerprint)) {
          return {
            ...event,
            status: "ready" as const,
            targetBindingId: binding.bindingId,
            targetEpoch: binding.epoch,
            targetPrincipalFingerprint: binding.principalFingerprint,
            updatedAt: now,
          };
        }
        return {
          ...event,
          status: "queued" as const,
          targetBindingId: null,
          targetEpoch: null,
          targetPrincipalFingerprint: null,
          updatedAt: now,
        };
      });
    const next: FeedbackState = {
      ...previous,
      projectionCursor: input.nextCursor,
      events: [...previous.events, ...added],
    };
    writeState(input.workspaceId, stateDir, next);
    return next;
  });
}

export function publicFeedbackEvent(event: FeedbackEvent): Record<string, unknown> {
  return {
    eventId: event.eventId,
    kind: event.kind,
    commandId: event.commandId,
    taskId: event.taskId,
    iteration: event.iteration,
    result: event.result,
    status: event.status,
    outputAvailable: event.outputAvailable,
    ...(event.outputId !== undefined ? { outputId: event.outputId } : {}),
    ...(event.attemptId ? { attemptId: event.attemptId } : {}),
    ...(event.reservationId ? { reservationId: event.reservationId } : {}),
    targetEpoch: event.targetEpoch,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

/**
 * Companion 公网 delivery DTO：只含生成固定 C2C 消息所需字段。
 * 禁止 principalFingerprint / targetBindingId / reservedBy / secret 等内部身份。
 */
export function publicCompanionDeliveryEvent(event: FeedbackEvent): Record<string, unknown> {
  return {
    eventId: event.eventId,
    kind: event.kind,
    commandId: event.commandId,
    taskId: event.taskId,
    iteration: event.iteration,
    result: event.result,
    status: event.status,
    changedFilesSummary: event.changedFilesSummary,
    testsSummary: event.testsSummary,
    outputAvailable: event.outputAvailable,
    ...(event.outputId !== undefined ? { outputId: event.outputId } : {}),
    ...(event.attemptId ? { attemptId: event.attemptId } : {}),
    occurredAt: event.occurredAt,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

export function feedbackStatusSummary(state: FeedbackState, callerFingerprint?: string): Record<string, unknown> {
  const binding = state.binding && state.binding.status === "active" ? state.binding : null;
  const owns = Boolean(
    binding
    && callerFingerprint
    && binding.principalFingerprint === callerFingerprint,
  );
  // 仅当前 active binding/epoch/fingerprint 可见 companion route；旧 companion 不泄露。
  const companion = owns && state.companion && !state.companion.supersededAt
    && binding
    && state.companion.bindingId === binding.bindingId
    && state.companion.epoch === binding.epoch
    && state.companion.principalFingerprint === binding.principalFingerprint
    ? state.companion
    : null;
  return {
    workspaceId: state.workspaceId,
    enabled: Boolean(binding),
    ownsBinding: owns,
    projectionCursor: state.projectionCursor,
    binding: state.binding
      ? {
          bindingId: state.binding.bindingId,
          epoch: state.binding.epoch,
          status: state.binding.status,
          principalFingerprint: state.binding.principalFingerprint,
          widgetId: state.binding.widgetId,
        }
      : null,
    companion: companion
      ? {
          companionId: companion.companionId,
          bindingId: companion.bindingId,
          epoch: companion.epoch,
          routeCanonical: companion.routeCanonical,
          pairedAt: companion.pairedAt,
        }
      : null,
    events: state.events.map((e) => publicFeedbackEvent(e)),
  };
}
