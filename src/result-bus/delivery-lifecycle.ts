import { randomUUID } from "node:crypto";
import { resolveWorkspaceIdentity, type RoutingWorkspaceIdentity } from "../routing/store.js";
import { freezeActiveWebSinkTarget, readActiveWebSinkBinding } from "../web-sink-control/service.js";
import type { WebSinkBinding, WebSinkSendTargetSnapshot } from "../endpoints/schema.js";
import {
  resultBusReasonCodeSchema,
  type ResultBusAttempt,
  type ResultBusEntry,
  type ResultBusReservation,
  type ResultBusSinkStamp,
  type ResultBusState,
} from "./schema.js";
import { ResultBusError, compareResultBusEntries, withResultBusTransaction } from "./store.js";

/**
 * R5d2 Result Bus delivery lifecycle（Bridge-owned，generic Web Sink only）。
 *
 * 单飞（single-flight）：
 * - reserved / claimed / outcome_unknown 任一存在时不得预约新 entry；
 * - observed / retired_unknown 是终态，不再阻塞后续 entry。
 *
 * 冻结边界：
 * - reserve 只盖章当前 Active Web Sink binding（bindingId/epoch/boundAt），不冻结 sendTarget；
 * - begin-send（reserved → claimed）是唯一冻结点：以当时 Active Web Sink 冻结精确
 *   WebSinkSendTargetSnapshot；此后 Active Web Sink 变化不改写已冻结 target。
 *
 * 安全恢复（bounded）：
 * - stale reserved → queued（begin-send 意图未持久化，可安全释放）；
 * - stale claimed → outcome_unknown（保留 attemptId 与冻结 target，绝不回 queued）。
 *
 * 本模块是核心 lifecycle；不提供 HTTP/MCP 端点，不接入任何插件前端投递路径，
 * 不读取反馈投影、planner 或 executor 身份。
 */

/** stale reserved 可安全回退 queued 的时限。 */
export const RESULT_BUS_RESERVED_STALE_MS = 5 * 60_000;
/** stale claimed 只能降级 outcome_unknown 的时限。 */
export const RESULT_BUS_CLAIMED_STALE_MS = 30 * 60_000;

export type ReserveNextResultBusEntryOutcome =
  | { status: "reserved"; entry: ResultBusEntry; sink: WebSinkBinding }
  | { status: "in_flight"; entry: ResultBusEntry }
  | { status: "empty" };

export type ReleaseResultBusReservationOutcome = { status: "released"; entry: ResultBusEntry };

export type BeginResultBusSendOutcome =
  | { status: "claimed"; entry: ResultBusEntry; attemptId: string; sendTarget: WebSinkSendTargetSnapshot; noWrite: boolean }
  | { status: "stale_reservation"; entry: ResultBusEntry };

export type AckResultBusObservedOutcome = { status: "observed"; entry: ResultBusEntry; noWrite: boolean };
export type MarkOutcomeUnknownResult = { status: "outcome_unknown"; entry: ResultBusEntry; noWrite: boolean };
export type RetireOutcomeUnknownResult = { status: "retired_unknown"; entry: ResultBusEntry; noWrite: boolean };
export type RecoverStaleResultBusOutcome = { requeued: number; outcomeUnknown: number };

export type ResultBusLifecycleOptions = {
  /** 确定性测试注入的当前时间（epoch ms）。 */
  readonly nowMs?: number;
};

function requireEntry(previous: ResultBusState | null, busEntryId: string): { state: ResultBusState; index: number; entry: ResultBusEntry } {
  if (!previous) throw new ResultBusError("RESULT_BUS_ENTRY_NOT_FOUND", "Workspace Result Bus 尚未初始化。 ");
  const index = previous.entries.findIndex(item => item.busEntryId === busEntryId);
  if (index < 0) throw new ResultBusError("RESULT_BUS_ENTRY_NOT_FOUND", `Result Bus 不存在 busEntryId=${busEntryId}。`);
  return { state: previous, index, entry: previous.entries[index]! };
}

function replaceEntry(state: ResultBusState, index: number, entry: ResultBusEntry): ResultBusState {
  return { ...state, entries: state.entries.map((item, i) => (i === index ? entry : item)) };
}

function sameSinkStamp(binding: WebSinkBinding, stamp: ResultBusSinkStamp): boolean {
  return binding.bindingId === stamp.bindingId && binding.epoch === stamp.epoch && binding.boundAt === stamp.boundAt;
}

function isoNow(nowMs: number | undefined): string {
  return new Date(nowMs ?? Date.now()).toISOString();
}

/**
 * reserve-next：按 createdAt 升序 + busEntryId 决胜预约最早的 queued entry，
 * 盖章当前 Active Web Sink binding stamp（不冻结 sendTarget）。
 * 存在 reserved/claimed/outcome_unknown 时返回该 in-flight entry（skip/noWrite 幂等）。
 */
export function reserveNextResultBusEntry(
  identity: RoutingWorkspaceIdentity,
  options: ResultBusLifecycleOptions = {},
): ReserveNextResultBusEntryOutcome {
  const resolved = resolveWorkspaceIdentity(identity);
  const active = readActiveWebSinkBinding(resolved.id);
  if (!active) {
    throw new ResultBusError("RESULT_BUS_NO_ACTIVE_SINK", "当前没有 Active Web Sink binding，不能预约 Result Bus entry。 ");
  }
  if (active.workspaceId !== resolved.id) {
    throw new ResultBusError("RESULT_BUS_NO_ACTIVE_SINK", "Active Web Sink workspace 与请求不一致。 ");
  }
  const reservedAt = isoNow(options.nowMs);
  return withResultBusTransaction<ReserveNextResultBusEntryOutcome>(resolved, previous => {
    const entries = previous?.entries ?? [];
    const inFlight = entries
      .filter(entry => entry.deliveryStatus === "reserved" || entry.deliveryStatus === "claimed" || entry.deliveryStatus === "outcome_unknown")
      .sort(compareResultBusEntries)[0];
    if (inFlight) {
      return { state: previous, noWrite: true, result: { status: "in_flight", entry: inFlight } };
    }
    const queued = entries.filter(entry => entry.deliveryStatus === "queued").sort(compareResultBusEntries)[0];
    if (!queued) {
      // previous 为 null（bus 未初始化）时由 store 的 null-state 只读路径处理，不创建文件。
      return { state: previous, noWrite: true, result: { status: "empty" as const } };
    }
    const reservation: ResultBusReservation = {
      reservationId: randomUUID(),
      reservedAt,
      bindingId: active.bindingId,
      epoch: active.epoch,
      boundAt: active.boundAt,
    };
    const entry: ResultBusEntry = { ...queued, deliveryStatus: "reserved", reservation };
    return {
      state: replaceEntry(previous!, previous!.entries.indexOf(queued), entry),
      result: { status: "reserved" as const, entry, sink: active },
    };
  });
}

/** reserved → queued（仅 begin-send 前）：清除 reservation 元数据；claimed/outcome_unknown 永不可释放回 queued。 */
export function releaseResultBusReservation(
  identity: RoutingWorkspaceIdentity,
  input: { busEntryId: string; reservationId: string },
): ReleaseResultBusReservationOutcome {
  const resolved = resolveWorkspaceIdentity(identity);
  return withResultBusTransaction<ReleaseResultBusReservationOutcome>(resolved, previous => {
    const { state, index, entry } = requireEntry(previous, input.busEntryId);
    if (entry.deliveryStatus !== "reserved") {
      throw new ResultBusError("RESULT_BUS_INVALID_TRANSITION", `只有 reserved 可以释放回 queued；当前为 ${entry.deliveryStatus}。`);
    }
    if (entry.reservation?.reservationId !== input.reservationId) {
      throw new ResultBusError("RESULT_BUS_RESERVATION_MISMATCH", "reservationId 与 entry 预约不一致。 ");
    }
    const requeued: ResultBusEntry = { ...entry, deliveryStatus: "queued", reservation: null };
    return { state: replaceEntry(state, index, requeued), result: { status: "released", entry: requeued } };
  });
}

/**
 * begin-send：reserved → claimed 的唯一冻结点。
 * - 当前 Active Web Sink 仍匹配 reservation stamp → 冻结精确 sendTarget、铸造 attemptId；
 * - 不匹配（期间发生 Web Sink 切换）→ 不冻结旧 target、不铸造 attemptId，
 *   entry 安全回 queued 并返回 bounded stale_reservation；
 * - 已 claimed 且 reservationId 精确一致 → 幂等 noWrite，返回同一 attemptId/sendTarget；
 *   任何其他 reservation/state 一律 fail closed。
 */
export function beginResultBusSend(
  identity: RoutingWorkspaceIdentity,
  input: { busEntryId: string; reservationId: string },
  options: ResultBusLifecycleOptions = {},
): BeginResultBusSendOutcome {
  const resolved = resolveWorkspaceIdentity(identity);
  return withResultBusTransaction<BeginResultBusSendOutcome>(resolved, previous => {
    const { state, index, entry } = requireEntry(previous, input.busEntryId);
    if (entry.deliveryStatus === "claimed") {
      if (entry.reservation?.reservationId !== input.reservationId || !entry.attempt || !entry.sendTarget) {
        throw new ResultBusError("RESULT_BUS_RESERVATION_MISMATCH", "claimed entry 与提供 reservation 不一致；拒绝重放。 ");
      }
      return {
        state: previous,
        noWrite: true,
        result: { status: "claimed", entry, attemptId: entry.attempt.attemptId, sendTarget: entry.sendTarget, noWrite: true },
      };
    }
    if (entry.deliveryStatus !== "reserved") {
      throw new ResultBusError("RESULT_BUS_INVALID_TRANSITION", `begin-send 只接受 reserved；当前为 ${entry.deliveryStatus}。`);
    }
    if (!entry.reservation || entry.reservation.reservationId !== input.reservationId) {
      throw new ResultBusError("RESULT_BUS_RESERVATION_MISMATCH", "reservationId 与 entry 预约不一致。 ");
    }
    const active = readActiveWebSinkBinding(resolved.id);
    if (!active || active.workspaceId !== resolved.id || !sameSinkStamp(active, entry.reservation)) {
      // Safe retarget boundary：预约目的地已切换；未冻结任何 target，未铸造 attempt。
      const requeued: ResultBusEntry = { ...entry, deliveryStatus: "queued", reservation: null };
      return {
        state: replaceEntry(state, index, requeued),
        result: { status: "stale_reservation", entry: requeued },
      };
    }
    const sendTarget = freezeActiveWebSinkTarget(active);
    if (sendTarget.workspaceId !== resolved.id) {
      throw new ResultBusError("RESULT_BUS_SINK_MISMATCH", "冻结 sendTarget workspace 与 entry 不一致。 ");
    }
    const attempt: ResultBusAttempt = { attemptId: randomUUID(), claimedAt: isoNow(options.nowMs) };
    const claimed: ResultBusEntry = { ...entry, deliveryStatus: "claimed", attempt, sendTarget };
    return {
      state: replaceEntry(state, index, claimed),
      result: { status: "claimed", entry: claimed, attemptId: attempt.attemptId, sendTarget, noWrite: false },
    };
  });
}

/**
 * ACK：claimed/outcome_unknown + 精确 attemptId → observed（late-positive 允许）；
 * observed + 精确 attemptId → noWrite 幂等。绝不改写 sendTarget。
 */
export function ackResultBusObserved(
  identity: RoutingWorkspaceIdentity,
  input: { busEntryId: string; attemptId: string },
  options: ResultBusLifecycleOptions = {},
): AckResultBusObservedOutcome {
  const resolved = resolveWorkspaceIdentity(identity);
  return withResultBusTransaction<AckResultBusObservedOutcome>(resolved, previous => {
    const { state, index, entry } = requireEntry(previous, input.busEntryId);
    if (entry.deliveryStatus === "observed") {
      if (entry.attempt?.attemptId !== input.attemptId) {
        throw new ResultBusError("RESULT_BUS_ATTEMPT_MISMATCH", "attemptId 与 entry attempt 不一致。 ");
      }
      return { state: previous, noWrite: true, result: { status: "observed", entry, noWrite: true } };
    }
    if (entry.deliveryStatus !== "claimed" && entry.deliveryStatus !== "outcome_unknown") {
      throw new ResultBusError("RESULT_BUS_INVALID_TRANSITION", `ack 只接受 claimed/outcome_unknown；当前为 ${entry.deliveryStatus}。`);
    }
    if (!entry.attempt || entry.attempt.attemptId !== input.attemptId) {
      throw new ResultBusError("RESULT_BUS_ATTEMPT_MISMATCH", "attemptId 与 entry attempt 不一致。 ");
    }
    const observed: ResultBusEntry = {
      ...entry,
      deliveryStatus: "observed",
      observedAt: isoNow(options.nowMs),
      outcomeUnknownAt: null,
      outcomeReasonCode: null,
    };
    return { state: replaceEntry(state, index, observed), result: { status: "observed", entry: observed, noWrite: false } };
  });
}

/**
 * claimed + 精确 attemptId → outcome_unknown：保留 reservation/attempt/冻结 target。
 * outcome_unknown 永不自动回 queued，也永不采纳当前 Active Web Sink；继续单飞 fence。
 */
export function markResultBusOutcomeUnknown(
  identity: RoutingWorkspaceIdentity,
  input: { busEntryId: string; attemptId: string; reasonCode?: string },
  options: ResultBusLifecycleOptions = {},
): MarkOutcomeUnknownResult {
  const resolved = resolveWorkspaceIdentity(identity);
  const reasonCode = input.reasonCode === undefined ? undefined : resultBusReasonCodeSchema.parse(input.reasonCode);
  return withResultBusTransaction<MarkOutcomeUnknownResult>(resolved, previous => {
    const { state, index, entry } = requireEntry(previous, input.busEntryId);
    if (entry.deliveryStatus === "outcome_unknown") {
      if (entry.attempt?.attemptId !== input.attemptId) {
        throw new ResultBusError("RESULT_BUS_ATTEMPT_MISMATCH", "attemptId 与 entry attempt 不一致。 ");
      }
      return { state: previous, noWrite: true, result: { status: "outcome_unknown", entry, noWrite: true } };
    }
    if (entry.deliveryStatus !== "claimed") {
      throw new ResultBusError("RESULT_BUS_INVALID_TRANSITION", `outcome_unknown 只接受 claimed；当前为 ${entry.deliveryStatus}。`);
    }
    if (!entry.attempt || entry.attempt.attemptId !== input.attemptId) {
      throw new ResultBusError("RESULT_BUS_ATTEMPT_MISMATCH", "attemptId 与 entry attempt 不一致。 ");
    }
    const outcome: ResultBusEntry = {
      ...entry,
      deliveryStatus: "outcome_unknown",
      outcomeUnknownAt: isoNow(options.nowMs),
      outcomeReasonCode: reasonCode ?? null,
    };
    return { state: replaceEntry(state, index, outcome), result: { status: "outcome_unknown", entry: outcome, noWrite: false } };
  });
}

/**
 * 手动 retire：outcome_unknown + 精确 attemptId → retired_unknown（终态）。
 * 保留原始冻结 target 与 outcomeUnknownAt；终态释放单飞 fence。
 */
export function retireResultBusOutcomeUnknown(
  identity: RoutingWorkspaceIdentity,
  input: { busEntryId: string; attemptId: string },
  options: ResultBusLifecycleOptions = {},
): RetireOutcomeUnknownResult {
  const resolved = resolveWorkspaceIdentity(identity);
  return withResultBusTransaction<RetireOutcomeUnknownResult>(resolved, previous => {
    const { state, index, entry } = requireEntry(previous, input.busEntryId);
    if (entry.deliveryStatus === "retired_unknown") {
      if (entry.attempt?.attemptId !== input.attemptId) {
        throw new ResultBusError("RESULT_BUS_ATTEMPT_MISMATCH", "attemptId 与 entry attempt 不一致。 ");
      }
      return { state: previous, noWrite: true, result: { status: "retired_unknown", entry, noWrite: true } };
    }
    if (entry.deliveryStatus !== "outcome_unknown") {
      throw new ResultBusError("RESULT_BUS_INVALID_TRANSITION", `retire 只接受 outcome_unknown；当前为 ${entry.deliveryStatus}。`);
    }
    if (!entry.attempt || entry.attempt.attemptId !== input.attemptId) {
      throw new ResultBusError("RESULT_BUS_ATTEMPT_MISMATCH", "attemptId 与 entry attempt 不一致。 ");
    }
    const retired: ResultBusEntry = { ...entry, deliveryStatus: "retired_unknown", retiredAt: isoNow(options.nowMs) };
    return { state: replaceEntry(state, index, retired), result: { status: "retired_unknown", entry: retired, noWrite: false } };
  });
}

/**
 * bounded stale 恢复（显式常量 + 可注入 nowMs）：
 * - stale reserved → queued（安全侧：begin-send 意图未持久化）；
 * - stale claimed → outcome_unknown（不安全侧：保留 attemptId 与冻结 target，绝不回 queued）。
 * 不导入既有反馈恢复代码；不自动 retarget。
 */
export function recoverStaleResultBusEntries(
  identity: RoutingWorkspaceIdentity,
  options: { nowMs?: number; reservedStaleMs?: number; claimedStaleMs?: number } = {},
): RecoverStaleResultBusOutcome {
  const resolved = resolveWorkspaceIdentity(identity);
  const reservedStaleMs = options.reservedStaleMs ?? RESULT_BUS_RESERVED_STALE_MS;
  const claimedStaleMs = options.claimedStaleMs ?? RESULT_BUS_CLAIMED_STALE_MS;
  const nowMs = options.nowMs ?? Date.now();
  const now = isoNow(nowMs);
  const outcomeUnknownReason = "CLAIMED_STALE";
  return withResultBusTransaction<RecoverStaleResultBusOutcome>(resolved, previous => {
    if (!previous) {
      // absent-state 只读空操作：不创建文件/marker。
      return { state: null, noWrite: true, result: { requeued: 0, outcomeUnknown: 0 } };
    }
    let requeued = 0;
    let outcomeUnknown = 0;
    const entries = previous.entries.map(entry => {
      if (entry.deliveryStatus === "reserved" && entry.reservation) {
        const reservedAt = Date.parse(entry.reservation.reservedAt);
        if (Number.isFinite(reservedAt) && nowMs - reservedAt > reservedStaleMs) {
          requeued += 1;
          return { ...entry, deliveryStatus: "queued" as const, reservation: null };
        }
      }
      if (entry.deliveryStatus === "claimed" && entry.attempt) {
        const claimedAt = Date.parse(entry.attempt.claimedAt);
        if (Number.isFinite(claimedAt) && nowMs - claimedAt > claimedStaleMs) {
          outcomeUnknown += 1;
          return {
            ...entry,
            deliveryStatus: "outcome_unknown" as const,
            outcomeUnknownAt: now,
            outcomeReasonCode: outcomeUnknownReason,
          };
        }
      }
      return entry;
    });
    if (requeued + outcomeUnknown === 0) {
      return { state: previous, noWrite: true, result: { requeued: 0, outcomeUnknown: 0 } };
    }
    return { state: { ...previous, entries }, result: { requeued, outcomeUnknown } };
  });
}
