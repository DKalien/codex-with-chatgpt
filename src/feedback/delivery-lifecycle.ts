import { randomUUID } from "node:crypto";
import { getStateDir } from "../config/paths.js";
import {
  requireConversationPrincipal,
  type ConversationPrincipal,
} from "../mcp/conversation-principal.js";
import {
  FeedbackError,
  type FeedbackBinding,
  type FeedbackEvent,
  type FeedbackState,
} from "./schema.js";
import {
  recoverStaleInMemory,
  withFeedbackCommandSnapshotLock,
  writeState,
} from "./state-store.js";
import { requireActiveBinding } from "./receiver.js";

export function claimNext(input: {
  workspaceId: string;
  principal: ConversationPrincipal;
  bindingId: string;
  epoch: number;
  stateDir?: string;
  /** R5d3 cutover：永久不可预约的 legacy eventId 集（如已归属 Result Bus 的历史事件）。 */
  excludeEventIds?: ReadonlySet<string>;
}): { event: FeedbackEvent; attemptId: string } {
  requireConversationPrincipal(input.principal);
  const stateDir = input.stateDir ?? getStateDir();
  return withRecoveredFeedbackState(input.workspaceId, stateDir, recovered => {
    const binding = requireActiveBinding(recovered, input.principal);
    if (binding.bindingId !== input.bindingId || binding.epoch !== input.epoch) {
      throw new FeedbackError("FEEDBACK_EPOCH_STALE", "旧绑定不能领取事件");
    }
    const ready = recovered.events
      .filter((e) => e.status === "ready"
        && !("plannerRouteId" in e)
        && !(input.excludeEventIds?.has(e.eventId) ?? false)
        && e.targetBindingId === input.bindingId
        && e.targetEpoch === input.epoch
        && e.targetPrincipalFingerprint === input.principal.fingerprint)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (ready.length === 0) {
      throw new FeedbackError("FEEDBACK_NO_READY_EVENT", "没有可领取的 ready 事件");
    }
    const target = ready[0]!;
    const attemptId = randomUUID();
    const claimedAt = new Date().toISOString();
    const next: FeedbackState = {
      ...recovered,
      events: recovered.events.map((e) =>
        e.eventId === target.eventId
          ? { ...e, status: "claimed" as const, attemptId, claimedAt, updatedAt: claimedAt }
          : e,
      ),
    };
    writeState(input.workspaceId, stateDir, next);
    return { event: next.events.find((e) => e.eventId === target.eventId)!, attemptId };
  });
}

type AckObservedInput = {
  bindingId: string;
  epoch: number;
  principalFingerprint: string;
  eventId: string;
  attemptId: string;
  companionId?: string;
};

function applyAckObserved(
  state: FeedbackState,
  input: AckObservedInput,
): { state: FeedbackState; result: FeedbackEvent } {
  const event = state.events.find((e) => e.eventId === input.eventId);
  if (!event) throw new FeedbackError("FEEDBACK_EVENT_NOT_FOUND", "feedback 事件不存在");
  // 先完整校验 target/attempt，再处理 observed 幂等。
  if (event.targetBindingId !== input.bindingId
    || event.targetEpoch !== input.epoch
    || event.targetPrincipalFingerprint !== input.principalFingerprint) {
    throw new FeedbackError("FEEDBACK_ACK_MISMATCH", "ack 目标绑定不匹配");
  }
  // companion 只能 ACK 自己 reservedBy 发起的 attempt；MCP 直接 claim 的事件不可冒充 ACK。
  if (input.companionId !== undefined
    && (event.status === "claimed" || event.status === "observed" || event.status === "outcome_unknown")
    && event.reservedBy !== input.companionId) {
    throw new FeedbackError("FEEDBACK_ACK_MISMATCH", "ack attempt 不属于当前 companion");
  }
  if (event.status === "observed") {
    if (event.attemptId === input.attemptId) return { state, result: event };
    throw new FeedbackError("FEEDBACK_ACK_MISMATCH", "observed 事件 attempt 不匹配");
  }
  // retired_unknown 是人工终态：一旦 retire，后续 ACK 必须拒绝，绝不能 resurrect。
  if (event.status === "retired_unknown") {
    throw new FeedbackError("FEEDBACK_ACK_MISMATCH", "retired 事件不可 ACK");
  }
  // Late-positive：stale recovery 后的 outcome_unknown 仍可在 exact attempt 下闭环。
  // ready / reserved / queued 及其它非 claimed/outcome_unknown 状态全部拒绝。
  const isExactClaimAttempt =
    event.attemptId === input.attemptId
    && (event.status === "claimed" || event.status === "outcome_unknown");
  if (!isExactClaimAttempt) {
    throw new FeedbackError(
      "FEEDBACK_ACK_MISMATCH",
      input.companionId === undefined
        ? "ack 身份与 claimed/outcome_unknown 事件不匹配"
        : "ack 身份与 claimed 事件不匹配",
    );
  }
  const observed: FeedbackEvent = {
    ...event,
    status: "observed",
    updatedAt: new Date().toISOString(),
  };
  return {
    state: {
      ...state,
      events: state.events.map((e) => (e.eventId === input.eventId ? observed : e)),
    },
    result: observed,
  };
}

function withRecoveredFeedbackState<T>(
  workspaceId: string,
  stateDir: string,
  fn: (state: FeedbackState) => T,
): T {
  return withFeedbackCommandSnapshotLock(workspaceId, stateDir, previous => {
    const recovered = recoverStaleInMemory(previous, Date.now());
    if (recovered !== previous) {
      writeState(workspaceId, stateDir, recovered);
    }
    return fn(recovered);
  });
}

export function ackObserved(input: {
  workspaceId: string;
  principal: ConversationPrincipal;
  bindingId: string;
  epoch: number;
  eventId: string;
  attemptId: string;
  stateDir?: string;
}): FeedbackEvent {
  requireConversationPrincipal(input.principal);
  const stateDir = input.stateDir ?? getStateDir();
  return withRecoveredFeedbackState(input.workspaceId, stateDir, (recovered) => {
    const binding = requireActiveBinding(recovered, input.principal);
    if (binding.bindingId !== input.bindingId || binding.epoch !== input.epoch) {
      throw new FeedbackError("FEEDBACK_EPOCH_STALE", "旧绑定不能确认事件");
    }
    const acked = applyAckObserved(recovered, {
      bindingId: binding.bindingId,
      epoch: binding.epoch,
      principalFingerprint: input.principal.fingerprint,
      eventId: input.eventId,
      attemptId: input.attemptId,
    });
    if (acked.state !== recovered) {
      writeState(input.workspaceId, stateDir, acked.state);
    }
    return acked.result;
  });
}

/** companion ACK 复用同一状态机；companionId 仅用于 reservedBy 归属校验。 */
export function ackObservedForCompanion(input: {
  workspaceId: string;
  bindingId: string;
  epoch: number;
  principalFingerprint: string;
  companionId: string;
  eventId: string;
  attemptId: string;
  stateDir?: string;
}): FeedbackEvent {
  const stateDir = input.stateDir ?? getStateDir();
  return withRecoveredFeedbackState(input.workspaceId, stateDir, (recovered) => {
    const acked = applyAckObserved(recovered, input);
    if (acked.state !== recovered) {
      writeState(input.workspaceId, stateDir, acked.state);
    }
    return acked.result;
  });
}

function requireActiveCompanionBinding(
  state: FeedbackState,
  input: {
    bindingId: string;
    epoch: number;
    principalFingerprint: string;
  },
): FeedbackBinding {
  if (!state.binding || state.binding.status !== "active") {
    throw new FeedbackError("FEEDBACK_NOT_ENABLED", "production feedback 未启用");
  }
  if (
    state.binding.bindingId !== input.bindingId
    || state.binding.epoch !== input.epoch
    || state.binding.principalFingerprint !== input.principalFingerprint
  ) {
    throw new FeedbackError("FEEDBACK_EPOCH_STALE", "companion 绑定代次已失效");
  }
  return state.binding;
}

const INFLIGHT_FENCE_STATUSES = new Set(["reserved", "claimed", "outcome_unknown"]);

/** ready → reserved；binding 范围内任一 reserved/claimed/outcome_unknown 时 single-flight fence。 */
export function reserveNext(input: {
  workspaceId: string;
  bindingId: string;
  epoch: number;
  principalFingerprint: string;
  companionId: string;
  stateDir?: string;
  /** R5d3 cutover：永久不可预约的 legacy eventId 集（如已归属 Result Bus 的历史事件）。 */
  excludeEventIds?: ReadonlySet<string>;
}): { event: FeedbackEvent; reservationId: string } {
  const stateDir = input.stateDir ?? getStateDir();
  return withRecoveredFeedbackState(input.workspaceId, stateDir, recovered => {
    requireActiveCompanionBinding(recovered, input);
    // Companion delivery 严格 single-flight：未解决 reserved/claimed/outcome_unknown 不得越过继续消费 ready。
    if (recovered.events.some((e) => INFLIGHT_FENCE_STATUSES.has(e.status))) {
      throw new FeedbackError(
        "FEEDBACK_INFLIGHT_FENCE",
        "存在 reserved/claimed/outcome_unknown 事件；禁止并发预占",
      );
    }
    // R5d3 cutover：canonical-pinned（planner route）事件不再经 legacy 通道投递；
    // 其 canonical delivery 由 Workspace Result Bus 承担。历史 canonical
    // ready/queued 事件在此成为不可预约的兼容只读记录。
    const ready = recovered.events
      .filter((e) => e.status === "ready"
        && !("plannerRouteId" in e)
        && !(input.excludeEventIds?.has(e.eventId) ?? false)
        && e.targetBindingId === input.bindingId
        && e.targetEpoch === input.epoch
        && e.targetPrincipalFingerprint === input.principalFingerprint)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (ready.length === 0) {
      throw new FeedbackError("FEEDBACK_NO_READY_EVENT", "没有可预占的 ready 事件");
    }
    const target = ready[0]!;
    const reservationId = randomUUID();
    const reservedAt = new Date().toISOString();
    const next: FeedbackState = {
      ...recovered,
      events: recovered.events.map((e) =>
        e.eventId === target.eventId
          ? {
              ...e,
              status: "reserved" as const,
              reservationId,
              reservedAt,
              reservedBy: input.companionId,
              updatedAt: reservedAt,
            }
          : e,
      ),
    };
    writeState(input.workspaceId, stateDir, next);
    return {
      event: next.events.find((e) => e.eventId === target.eventId)!,
      reservationId,
    };
  });
}

/** reserved → ready；exact reservationId + companionId。 */
export function releaseReservation(input: {
  workspaceId: string;
  bindingId: string;
  epoch: number;
  principalFingerprint: string;
  companionId: string;
  eventId: string;
  reservationId: string;
  stateDir?: string;
}): FeedbackEvent {
  const stateDir = input.stateDir ?? getStateDir();
  return withRecoveredFeedbackState(input.workspaceId, stateDir, recovered => {
    requireActiveCompanionBinding(recovered, input);
    const event = recovered.events.find((e) => e.eventId === input.eventId);
    if (!event) throw new FeedbackError("FEEDBACK_EVENT_NOT_FOUND", "feedback 事件不存在");
    if (event.status === "ready") {
      if (event.reservationId) {
        throw new FeedbackError("FEEDBACK_RESERVATION_MISMATCH", "reservation 状态不一致");
      }
      return event;
    }
    if (event.status !== "reserved" || event.reservationId !== input.reservationId) {
      throw new FeedbackError("FEEDBACK_RESERVATION_MISMATCH", "reservation 身份不匹配");
    }
    if (
      event.reservedBy !== input.companionId
      || event.targetBindingId !== recovered.binding!.bindingId
      || event.targetEpoch !== recovered.binding!.epoch
      || event.targetPrincipalFingerprint !== input.principalFingerprint
    ) {
      throw new FeedbackError("FEEDBACK_RESERVATION_MISMATCH", "reservation 目标绑定不匹配");
    }
    const {
      reservationId: _rid,
      reservedAt: _rat,
      reservedBy: _rby,
      ...rest
    } = event;
    const released: FeedbackEvent = {
      ...rest,
      status: "ready",
      updatedAt: new Date().toISOString(),
    };
    const next: FeedbackState = {
      ...recovered,
      events: recovered.events.map((e) => (e.eventId === input.eventId ? released : e)),
    };
    writeState(input.workspaceId, stateDir, next);
    return released;
  });
}

/** reserved → claimed：不可逆 send-intent 边界。companionId 必须是 reservation 归属。 */
export function beginSend(input: {
  workspaceId: string;
  bindingId: string;
  epoch: number;
  principalFingerprint: string;
  companionId: string;
  eventId: string;
  reservationId: string;
  stateDir?: string;
}): { event: FeedbackEvent; attemptId: string } {
  const stateDir = input.stateDir ?? getStateDir();
  return withRecoveredFeedbackState(input.workspaceId, stateDir, recovered => {
    const binding = requireActiveCompanionBinding(recovered, input);
    const event = recovered.events.find((e) => e.eventId === input.eventId);
    if (!event) throw new FeedbackError("FEEDBACK_EVENT_NOT_FOUND", "feedback 事件不存在");
    // claimed 幂等也必须绑定 reservedBy：其它 companion 不得继承本 attempt。
    if (event.status === "claimed" && event.reservationId === input.reservationId) {
      if (event.reservedBy !== input.companionId) {
        throw new FeedbackError(
          "FEEDBACK_RESERVATION_MISMATCH",
          "claimed attempt 不属于当前 companion",
        );
      }
      if (!event.attemptId) {
        throw new FeedbackError("FEEDBACK_RESERVATION_MISMATCH", "claimed 事件缺少 attemptId");
      }
      return { event, attemptId: event.attemptId };
    }
    if (event.status !== "reserved" || event.reservationId !== input.reservationId) {
      throw new FeedbackError("FEEDBACK_RESERVATION_MISMATCH", "begin-send 需要 exact reserved 事件");
    }
    if (
      event.reservedBy !== input.companionId
      || event.targetBindingId !== binding.bindingId
      || event.targetEpoch !== binding.epoch
      || event.targetPrincipalFingerprint !== input.principalFingerprint
    ) {
      throw new FeedbackError("FEEDBACK_RESERVATION_MISMATCH", "reservation 归属不匹配");
    }
    const attemptId = randomUUID();
    const claimedAt = new Date().toISOString();
    const claimed: FeedbackEvent = {
      ...event,
      status: "claimed",
      attemptId,
      claimedAt,
      updatedAt: claimedAt,
    };
    const next: FeedbackState = {
      ...recovered,
      events: recovered.events.map((e) => (e.eventId === input.eventId ? claimed : e)),
    };
    writeState(input.workspaceId, stateDir, next);
    return { event: claimed, attemptId };
  });
}

/**
 * outcome_unknown → retired_unknown：人工显式放弃，永不重发。
 * 不是“证明未发送”，也不是 ACK；仅表示永久退出 single-flight。
 * 幂等：同 exact event/attempt/reservation/companion 重复 retire 返回现有成功。
 */
export function retireOutcomeUnknown(input: {
  workspaceId: string;
  bindingId: string;
  epoch: number;
  principalFingerprint: string;
  companionId: string;
  eventId: string;
  reservationId: string;
  attemptId: string;
  stateDir?: string;
}): FeedbackEvent {
  const stateDir = input.stateDir ?? getStateDir();
  return withRecoveredFeedbackState(input.workspaceId, stateDir, recovered => {
    const binding = requireActiveCompanionBinding(recovered, input);
    const event = recovered.events.find((e) => e.eventId === input.eventId);
    if (!event) throw new FeedbackError("FEEDBACK_EVENT_NOT_FOUND", "feedback 事件不存在");
    if (
      event.targetBindingId !== binding.bindingId
      || event.targetEpoch !== binding.epoch
      || event.targetPrincipalFingerprint !== input.principalFingerprint
    ) {
      throw new FeedbackError("FEEDBACK_RETIRE_MISMATCH", "retire 目标绑定不匹配");
    }
    // Idempotent exact retry.
    if (event.status === "retired_unknown") {
      if (
        event.attemptId === input.attemptId
        && event.reservationId === input.reservationId
        && event.reservedBy === input.companionId
      ) {
        return event;
      }
      throw new FeedbackError("FEEDBACK_RETIRE_MISMATCH", "retired 事件 attempt 不匹配");
    }
    if (event.status !== "outcome_unknown") {
      throw new FeedbackError("FEEDBACK_RETIRE_MISMATCH", "仅 outcome_unknown 事件可 retire");
    }
    if (
      event.attemptId !== input.attemptId
      || event.reservationId !== input.reservationId
      || event.reservedBy !== input.companionId
    ) {
      throw new FeedbackError("FEEDBACK_RETIRE_MISMATCH", "retire 身份与 outcome_unknown 事件不匹配");
    }
    const retiredAt = new Date().toISOString();
    const retired: FeedbackEvent = {
      ...event,
      status: "retired_unknown",
      retiredAt,
      updatedAt: retiredAt,
    };
    const next: FeedbackState = {
      ...recovered,
      events: recovered.events.map((e) => (e.eventId === input.eventId ? retired : e)),
    };
    writeState(input.workspaceId, stateDir, next);
    return retired;
  });
}
