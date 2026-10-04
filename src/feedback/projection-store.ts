import { createHash } from "node:crypto";
import { readExecutionRecordsStrict } from "../execution/records.js";
import fs from "node:fs";
import { getStateDir } from "../config/paths.js";
import { assertCleanupStoreFile, readCleanupJournal, withCommandOperation } from "../command-cleanup/fence.js";
import { assertCleanupArtifacts, cleanupArtifact, CommandCleanupError, type CleanupArtifact, type CommandCleanupTarget } from "../command-cleanup/schema.js";
import { listReceiptFinalizationAlerts } from "../desktop/receipt-finalizer.js";
import { canonicalRoutingResultDigest } from "../routing/execution-result-digest.js";
import { readRouting, resolveWorkspaceIdentity } from "../routing/store.js";
import { withFeedbackCommandLocks } from "./command-locks.js";
import {
  FINAL_RECEIPT_REQUIRED_EVENT_KIND,
  FeedbackError,
  legacyFeedbackStateSchema,
  type FeedbackBinding,
  type FeedbackEvent,
  type C2CExecutedFeedbackEvent,
  type FinalReceiptRequiredEvent,
  type FeedbackState,
} from "./schema.js";
export { applyFeedbackCursorCleanup, finishFeedbackCursorCleanup, prepareFeedbackCursorCleanup } from "./cursor-cleanup.js";
import {
  recoverStaleInMemory,
  feedbackStateFile,
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
  source?: { recordsSha256: string; cursor: number };
}): FeedbackState {
  const stateDir = input.stateDir ?? getStateDir();
  return withFeedbackCommandLocks(input.workspaceId, input.newEvents.map(event => event.commandId), stateDir, () => withFeedbackLock(input.workspaceId, stateDir, (read) => {
    const previous = requireInitializedState(read(), input.workspaceId);
    // Cleanup can remove the source after a projector reads it. Revalidate while
    // holding the Feedback lock, which cleanup must own before removing records.
    if (input.source && (previous.projectionCursor !== input.source.cursor ||
        createHash("sha256").update(JSON.stringify(readExecutionRecordsStrict(input.workspaceId, stateDir))).digest("hex") !== input.source.recordsSha256)) {
      throw new FeedbackError("FEEDBACK_SOURCE_CHANGED", "执行记录或游标已变化；拒绝投影旧快照。");
    }
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
  }));
}

function cleanupFeedbackTarget(target: CommandCleanupTarget): { identity: { id: string; root: string }; stateDir: string } {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(target.commandId)) {
    throw new CommandCleanupError("COMMAND_CLEANUP_INVALID", "cleanup commandId 格式无效。");
  }
  if (target.iteration !== 1) throw new CommandCleanupError("COMMAND_CLEANUP_INVALID", "只支持 cleanup iteration=1。");
  const identity = resolveWorkspaceIdentity({ id: target.workspaceId, root: target.workspaceRoot });
  const stateDir = target.stateDir ?? getStateDir();
  assertCleanupStoreFile(feedbackStateFile(identity.id, stateDir), stateDir);
  return { identity, stateDir };
}

function requireCleanupSnapshot(target: CommandCleanupTarget, expected: readonly CleanupArtifact[], stateDir: string): void {
  const journal = readCleanupJournal(target.workspaceId, target.commandId, stateDir);
  const keys = (items: readonly CleanupArtifact[]) => items.map(item => `${item.kind}\0${item.id}\0${item.sha256}`).sort();
  if (!journal || journal.workspaceRoot !== target.workspaceRoot || journal.iteration !== target.iteration ||
      journal.phase === "snapshot_pending" ||
      JSON.stringify(keys(expected)) !== JSON.stringify(keys(journal.artifacts))) {
    throw new CommandCleanupError("COMMAND_CLEANUP_REQUIRED", "Feedback 删除要求匹配的完整 journal snapshot。");
  }
}

function truncateCleanupSummary(value: string, max = 2000): string {
  return value.length > max ? value.slice(0, max) : value;
}

function feedbackCleanupArtifacts(
  target: CommandCleanupTarget,
  stateDir: string,
  events: readonly FeedbackEvent[],
): CleanupArtifact[] {
  const scoped = events.filter(event => event.commandId === target.commandId);
  const executed = scoped.filter((event): event is C2CExecutedFeedbackEvent => event.kind === "C2C_EXECUTED");
  const controls = scoped.filter((event): event is FinalReceiptRequiredEvent => event.kind === FINAL_RECEIPT_REQUIRED_EVENT_KIND);
  if (executed.some(event => event.iteration !== target.iteration)) {
    throw new CommandCleanupError("COMMAND_CLEANUP_AMBIGUOUS", "Feedback 存在同 command 的 sibling iteration；保留状态。");
  }
  if (executed.length > 1) throw new CommandCleanupError("COMMAND_CLEANUP_AMBIGUOUS", "Feedback 同 command+iteration 存在多个事件；保留状态。");
  if (controls.length > 1) throw new CommandCleanupError("COMMAND_CLEANUP_AMBIGUOUS", "Feedback 同 command 存在多个 FINAL_RECEIPT_REQUIRED 事件；保留状态。");
  const artifacts: CleanupArtifact[] = [];
  const event = executed[0];
  if (event) {
    if (event.taskId !== `desktop_${target.commandId}`) {
      throw new CommandCleanupError("COMMAND_CLEANUP_UNOWNED", "Feedback event taskId 与精确 command identity 不符。");
    }

    // A canonical projection must agree with the exact persisted Routing result whenever
    // that producer remains. Manual confirmation authorizes an exact legacy event hash.
    const routing = readRouting({ id: target.workspaceId, root: target.workspaceRoot }, stateDir);
    const result = routing?.results.find(item => item.commandId === target.commandId && item.iteration === target.iteration);
    const command = routing?.commands.find(item => item.commandId === target.commandId);
    const planner = command && routing?.routes.find(item => item.routeId === command.plannerRouteId);
    const evidence = event.machineEvidence;
    const canonicalResult = result && "rawSummary" in result && "machineEvidence" in result ? result : null;
    const receiptEvidence = evidence ?? canonicalResult?.machineEvidence;
    const expectedEventId = receiptEvidence && feedbackEventId({
      workspaceId: target.workspaceId,
      commandId: target.commandId,
      taskId: event.taskId,
      iteration: target.iteration,
      desktopReceiptSha256: receiptEvidence.desktopReceiptSha256,
    });
    if (receiptEvidence && event.eventId !== expectedEventId) {
      throw new CommandCleanupError("COMMAND_CLEANUP_UNOWNED", "Feedback event receipt identity 无法绑定到当前 command。");
    }
    if ("plannerRouteId" in event) {
      if (!evidence || !canonicalResult || !command || !planner || planner.role !== "planner" ||
          event.resultId !== canonicalResult.resultId || event.resultSha256 !== canonicalRoutingResultDigest(canonicalResult) ||
          event.rawSummary !== canonicalResult.rawSummary || JSON.stringify(event.machineEvidence) !== JSON.stringify(canonicalResult.machineEvidence) ||
          event.plannerRouteId !== command.plannerRouteId || event.plannerPrincipalFingerprint !== planner.conversationId ||
          event.result !== canonicalResult.status ||
          JSON.stringify(event.changedFilesSummary) !== JSON.stringify(evidence.changedFiles.slice(0, 200)) ||
          event.testsSummary !== truncateCleanupSummary(evidence.testsSummary) ||
          event.outputAvailable !== (evidence.output?.outputAvailable ?? false) || event.outputId !== evidence.output?.outputId) {
        throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "canonical Feedback event 与 Routing result 不一致。");
      }
    } else if (canonicalResult && (!receiptEvidence || event.eventId !== expectedEventId || event.result !== canonicalResult.status ||
        JSON.stringify(event.changedFilesSummary) !== JSON.stringify(canonicalResult.machineEvidence.changedFiles.slice(0, 200)) ||
        event.testsSummary !== truncateCleanupSummary(canonicalResult.machineEvidence.testsSummary) ||
        event.outputAvailable !== (canonicalResult.machineEvidence.output?.outputAvailable ?? false) ||
        event.outputId !== canonicalResult.machineEvidence.output?.outputId)) {
      throw new CommandCleanupError("COMMAND_CLEANUP_AMBIGUOUS", "legacy Feedback 与同 command canonical result 不匹配；拒绝选择性删除。");
    }
    artifacts.push(cleanupArtifact("feedback_event", event.eventId, event));
  }

  const control = controls[0];
  if (control) {
    const alerts = listReceiptFinalizationAlerts(stateDir).filter(alert =>
      alert.workspaceId === target.workspaceId && alert.commandId === target.commandId);
    const alert = alerts[0];
    const expectedEventId = alert && finalReceiptRequiredEventId({
      workspaceId: target.workspaceId, commandId: target.commandId, alertId: alert.alertId,
    });
    if (alerts.length !== 1 || !alert || target.iteration !== 1 ||
        control.workspaceId !== target.workspaceId || control.eventId !== expectedEventId ||
        control.taskId !== `desktop_finalization_${target.commandId}` || control.iteration !== 1 ||
        control.source !== "control" || control.result !== "blocked" || control.reason !== alert.reason ||
        control.occurredAt !== alert.occurredAt || control.createdAt !== alert.occurredAt ||
        control.changedFilesSummary.length !== 0 || control.testsSummary !== "" || control.outputAvailable !== false) {
      throw new CommandCleanupError("COMMAND_CLEANUP_AMBIGUOUS", "FINAL_RECEIPT_REQUIRED 无法绑定到唯一 exact receipt-finalization alert；保留状态。");
    }
    artifacts.push(cleanupArtifact("feedback_event", control.eventId, control));
  }
  return artifacts;
}

/** Snapshot only the target command's pinned/legacy execution event; binding and cursor are never cleanup artifacts. */
export function inspectFeedbackCleanupArtifacts(target: CommandCleanupTarget): CleanupArtifact[] {
  const { identity, stateDir } = cleanupFeedbackTarget(target);
  const file = feedbackStateFile(identity.id, stateDir);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "Feedback state 不是普通文件；保留并停止 cleanup。");
  const state = readFeedbackState(identity.id, stateDir);
  return feedbackCleanupArtifacts(target, stateDir, state.events);
}

/** Remove the exact feedback event under the feedback store lock while preserving binding, cursor and companion state. */
export function deleteFeedbackCleanupArtifacts(
  target: CommandCleanupTarget,
  expected: readonly CleanupArtifact[],
): { events: number } {
  const { identity, stateDir } = cleanupFeedbackTarget(target);
  return withCommandOperation(identity.id, target.commandId, () => {
    requireCleanupSnapshot(target, expected, stateDir);
    return withFeedbackLock(identity.id, stateDir, read => {
      const previous = read();
      if (!previous) return { events: 0 };
      const current = feedbackCleanupArtifacts(target, stateDir, previous.events);
      assertCleanupArtifacts(current, expected);
      if (!current.length) return { events: 0 };
      const eventIds = new Set(current.map(item => item.id));
      const next = { ...previous, events: previous.events.filter(event => !eventIds.has(event.eventId)) };
      writeState(identity.id, stateDir, next);
      if (read()?.events.some(event => eventIds.has(event.eventId))) {
        throw new CommandCleanupError("COMMAND_CLEANUP_PENDING", "Feedback event 删除后仍可见；保留 cleanup_pending。");
      }
      return { events: current.length };
    });
  }, stateDir, true);
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
