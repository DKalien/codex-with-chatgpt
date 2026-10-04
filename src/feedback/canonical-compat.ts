import {
  FeedbackError,
  type FeedbackEvent,
  type FeedbackState,
} from "./schema.js";
import { recoverStaleFeedback } from "./state-store.js";
import { feedbackEventId, applyProjection } from "./projection-store.js";
import { resolveResultOutboxEntries } from "../routing/result-outbox-store.js";
import { resolveWorkspaceIdentity } from "../routing/store.js";
import type { RoutingResult } from "../routing/schema.js";
import { getStateDir } from "../config/paths.js";
import { readFeedbackState } from "./state-store.js";
import { assertFeedbackCommandSnapshot, withFeedbackCommandLocks } from "./command-locks.js";

/**
 * R4 canonical Feedback projection —— R5d3 起 compatibility-only。
 *
 * 历史（pre-cutover）canonical Feedback 事件由此路径产生；R5d3 cutover 后
 * production canonical delivery 改由 Workspace Result Bus 承担，
 * reconcileFeedbackOutbox 不再调用本模块。保留为显式兼容读侧（审计/回滚/测试），
 * 不得重新接入 production canonical 投递路径。
 */

function truncateSummary(text: string, max = 2000): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Legacy feedback 与 canonical result 共享的不可变事件事实。
 * 时间戳和 receiver lifecycle 属于各自投影，不参与迁移匹配。
 */
function sameLegacyCanonicalIdentity(
  legacy: FeedbackEvent,
  canonical: FeedbackEvent,
): boolean {
  return legacy.kind === canonical.kind
    && legacy.source === canonical.source
    && legacy.workspaceId === canonical.workspaceId
    && legacy.eventId === canonical.eventId
    && legacy.commandId === canonical.commandId
    && legacy.taskId === canonical.taskId
    && legacy.iteration === canonical.iteration
    && legacy.result === canonical.result
    && JSON.stringify(legacy.changedFilesSummary) === JSON.stringify(canonical.changedFilesSummary)
    && legacy.testsSummary === canonical.testsSummary
    && legacy.outputAvailable === canonical.outputAvailable
    && legacy.outputId === canonical.outputId;
}

function sameCanonicalImmutableIdentity(a: FeedbackEvent, b: FeedbackEvent): boolean {
  const keys = [
    "kind", "source", "workspaceId", "eventId", "commandId", "taskId", "iteration", "result",
    "changedFilesSummary", "testsSummary", "outputAvailable", "outputId", "plannerRouteId",
    "plannerPrincipalFingerprint", "resultId", "resultSha256", "rawSummary", "machineEvidence",
  ] as const;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  return keys.every((key) => JSON.stringify(left[key]) === JSON.stringify(right[key]));
}

export function canonicalFeedbackEvent(input: {
  workspaceId: string;
  result: RoutingResult;
  plannerRouteId: string;
  plannerPrincipalFingerprint: string;
  resultSha256: string;
  occurredAt: string;
}): FeedbackEvent {
  if (!("rawSummary" in input.result) || !("machineEvidence" in input.result)) {
    throw new FeedbackError("FEEDBACK_CANONICAL_RESULT_INVALID", "legacy RoutingResult 不能投影为 canonical feedback");
  }
  const evidence = input.result.machineEvidence;
  const eventId = feedbackEventId({
    workspaceId: input.workspaceId,
    commandId: input.result.commandId,
    taskId: evidence.taskId,
    iteration: input.result.iteration,
    desktopReceiptSha256: evidence.desktopReceiptSha256,
  });
  return {
    version: 1, eventId, kind: "C2C_EXECUTED", workspaceId: input.workspaceId, source: "desktop",
    commandId: input.result.commandId, taskId: evidence.taskId, iteration: input.result.iteration,
    result: input.result.status, changedFilesSummary: evidence.changedFiles.slice(0, 200),
    testsSummary: truncateSummary(evidence.testsSummary), outputAvailable: evidence.output?.outputAvailable ?? false,
    ...(evidence.output?.outputId !== undefined ? { outputId: evidence.output.outputId } : {}),
    occurredAt: input.occurredAt, createdAt: input.occurredAt, updatedAt: input.occurredAt,
    targetBindingId: null, targetEpoch: null, targetPrincipalFingerprint: null, status: "queued",
    plannerRouteId: input.plannerRouteId, plannerPrincipalFingerprint: input.plannerPrincipalFingerprint,
    resultId: input.result.resultId, resultSha256: input.resultSha256,
    rawSummary: input.result.rawSummary, machineEvidence: evidence,
  } as FeedbackEvent;
}

export function reconcileCanonicalResultOutbox(
  workspaceRoot: string,
  workspaceId: string,
  stateDir?: string,
): { state: FeedbackState; projected: number } {
  const identity = resolveWorkspaceIdentity({ id: workspaceId, root: workspaceRoot });
  const resolvedStateDir = stateDir ?? getStateDir();
  const initialResolved = resolveResultOutboxEntries(identity, resolvedStateDir);
  const initialState = readFeedbackState(workspaceId, resolvedStateDir);
  const lockedIds = [
    ...initialResolved.map(item => item.entry.commandId),
    ...initialState.events.map(event => event.commandId),
  ];
  return withFeedbackCommandLocks(workspaceId, lockedIds, resolvedStateDir, () => {
    const resolved = resolveResultOutboxEntries(identity, resolvedStateDir);
    const current = readFeedbackState(workspaceId, resolvedStateDir);
    assertFeedbackCommandSnapshot(lockedIds, [
      ...resolved.map(item => item.entry.commandId),
      ...current.events.map(event => event.commandId),
    ]);
    const state = recoverStaleFeedback(workspaceId, resolvedStateDir);
    const candidates = resolved.map(({ entry, result, plannerRoute }) => ({
      entry,
      result,
      event: canonicalFeedbackEvent({
        workspaceId, result, plannerRouteId: plannerRoute.routeId, plannerPrincipalFingerprint: plannerRoute.conversationId,
        resultSha256: entry.resultSha256,
        occurredAt: result.createdAt,
      }),
    }));
    const events = candidates
      .filter(({ result, event }) => {
        const matches = state.events.filter((item) => item.commandId === result.commandId && item.iteration === result.iteration);
        if (matches.length > 1) throw new FeedbackError("FEEDBACK_CANONICAL_ROUTE_CONFLICT", "同一 commandId/iteration 存在多个 feedback 事件；拒绝选择性投影");
        const existing = matches[0];
        if (!existing) return true;
        if ("plannerRouteId" in existing) {
          if (!sameCanonicalImmutableIdentity(existing, event)) throw new FeedbackError("FEEDBACK_CANONICAL_ROUTE_CONFLICT", "canonical feedback 身份已漂移；拒绝覆盖");
          return false;
        }
        if (!sameLegacyCanonicalIdentity(existing, event)) throw new FeedbackError("FEEDBACK_CANONICAL_ROUTE_CONFLICT", "历史 feedback 事件与 canonical result 冲突；拒绝静默重定向");
        return false;
      });
    if (!events.length) return { state, projected: 0 };
    const newEvents = events.map(({ event }) => event);
    return { state: applyProjection({ workspaceId, stateDir: resolvedStateDir, nextCursor: state.projectionCursor, newEvents }), projected: newEvents.length };
  });
}
