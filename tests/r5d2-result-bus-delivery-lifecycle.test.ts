import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { appendResult, createCommand, registerRoute } from "../src/routing/store.js";
import { canonicalRoutingResultDigest } from "../src/routing/execution-result-digest.js";
import { bindCurrentWebSink, readActiveWebSinkBinding } from "../src/web-sink-control/index.js";
import { projectChatgptRouteToWebSinkCandidate } from "../src/web-sink-control/index.js";
import {
  RESULT_BUS_CLAIMED_STALE_MS,
  RESULT_BUS_RESERVED_STALE_MS,
  ackResultBusObserved,
  beginResultBusSend,
  markResultBusOutcomeUnknown,
  recoverStaleResultBusEntries,
  releaseResultBusReservation,
  reserveNextResultBusEntry,
  retireResultBusOutcomeUnknown,
} from "../src/result-bus/delivery-lifecycle.js";
import { resultBusEntryId, resultBusStateSchema } from "../src/result-bus/schema.js";
import {
  ResultBusError,
  enqueueResultBusEntry,
  readResultBus,
  resultBusFile,
  withResultBusTransaction,
} from "../src/result-bus/store.js";
import { resultBusDeliveryMessage, resultBusCompanionDeliveryId } from "../src/bridge/result-bus-delivery.js";
import { renderCompletionNotification } from "../src/browser/completion-notification.js";
import { formatCanonicalExecutedMessage, productionFeedbackMessageSha256 } from "../src/feedback/message.js";
import { reconcileWorkspaceResultBus } from "../src/result-bus/service.js";

const HEX64 = "c".repeat(64);
const PLANNER = "018c0000-0000-7000-8000-00000000c2d1";
const EXECUTOR = "01a00000-0000-7000-8000-0000000002d1";
const BINDING = "01a00000-0000-7000-8000-0000000002d2";
const URL_A = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const URL_B = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";

let stateDir: string;
let root: string;
let identity: { id: string; root: string };
let previousStateDir: string | undefined;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-r5d2-lifecycle-"));
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "c2c-r5d2-lifecycle-root-")));
  previousStateDir = process.env.C2C_STATE_DIR;
  process.env.C2C_STATE_DIR = stateDir;
  identity = { id: new Workspace(root).id, root };
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

function canonicalResult(commandId: string, iteration = 1, status: "ok" | "failed" | "blocked" = "ok") {
  const planner = registerRoute(identity, {
    role: "planner", platform: "chatgpt_web", conversationId: PLANNER, locator: {},
  }, stateDir);
  const executor = registerRoute(identity, {
    role: "executor", platform: "codex_desktop", conversationId: EXECUTOR,
    locator: { hostId: "local", executorProjectId: "r5d2" },
  }, stateDir);
  createCommand(identity, {
    commandId, plannerRouteId: planner.routeId, executorRouteId: executor.routeId,
    intent: "development_plan", payloadBytes: 1, payloadSha256: HEX64,
  }, stateDir);
  return appendResult(identity, {
    commandId, executorRouteId: executor.routeId, iteration, status,
    rawSummary: `R5d2 canonical result ${commandId}`,
    machineEvidence: {
      version: 1, source: "codex_desktop_receipt", desktopReceiptSha256: HEX64,
      taskId: `desktop_${commandId}`, iteration, status, threadId: EXECUTOR,
      originTurnId: EXECUTOR, resultTurnId: EXECUTOR, bindingId: BINDING,
      changedFiles: [], testsSummary: "r5d2 passed",
    },
  }, stateDir);
}

function queueEntry(commandId: string, iteration = 1) {
  return enqueueResultBusEntry(identity, canonicalResult(commandId, iteration), stateDir).entry;
}

function bindSink(url: string) {
  return bindCurrentWebSink(identity.id, projectChatgptRouteToWebSinkCandidate({
    workspaceId: identity.id,
    routeCanonical: url,
  })).binding;
}

function busFilePath(): string {
  return resultBusFile(identity.id, stateDir);
}

function busErrorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ResultBusError);
    return (error as ResultBusError).code;
  }
  throw new Error("expected ResultBusError");
}

/** 将指定 entry 的 createdAt 重写为固定时间（schema 合法），用于确定性排序验证。 */
function rewriteCreatedAt(busEntryId: string, createdAt: string): void {
  const file = busFilePath();
  const state = JSON.parse(fs.readFileSync(file, "utf8")) as { entries: Array<{ busEntryId: string; createdAt: string }> };
  state.entries.find(entry => entry.busEntryId === busEntryId)!.createdAt = createdAt;
  fs.writeFileSync(file, JSON.stringify(state));
}

describe("R5d2 Result Bus delivery lifecycle", () => {
  it("A: queued -> reserved 盖章当前 Active Sink A，不冻结 sendTarget", () => {
    const binding = bindSink(URL_A);
    const entry = queueEntry("r5d2-a");
    const outcome = reserveNextResultBusEntry(identity);
    expect(outcome).toMatchObject({ status: "reserved" });
    if (outcome.status !== "reserved") return;
    expect(outcome.sink.bindingId).toBe(binding.bindingId);
    expect(outcome.entry).toMatchObject({
      busEntryId: entry.busEntryId,
      deliveryStatus: "reserved",
      sendTarget: null,
      attempt: null,
    });
    expect(outcome.entry.reservation).toMatchObject({
      bindingId: binding.bindingId,
      epoch: binding.epoch,
      boundAt: binding.boundAt,
    });
    expect(typeof outcome.entry.reservation!.reservationId).toBe("string");
  });

  it("B: 无 Active Sink 时 fail closed，不产生 reservation", () => {
    const entry = queueEntry("r5d2-b");
    expect(busErrorCode(() => reserveNextResultBusEntry(identity))).toBe("RESULT_BUS_NO_ACTIVE_SINK");
    expect(readResultBus(identity, stateDir)?.entries[0]).toMatchObject({
      busEntryId: entry.busEntryId, deliveryStatus: "queued", reservation: null,
    });
  });

  it("C: 预约顺序确定性——createdAt 升序 + busEntryId 决胜", () => {
    bindSink(URL_A);
    const first = queueEntry("r5d2-c1");
    const second = queueEntry("r5d2-c2");
    const third = queueEntry("r5d2-c3");
    rewriteCreatedAt(first.busEntryId, "2026-01-02T00:00:00.000Z");
    rewriteCreatedAt(second.busEntryId, "2026-01-02T00:00:00.000Z");
    rewriteCreatedAt(third.busEntryId, "2026-01-03T00:00:00.000Z");
    const outcome = reserveNextResultBusEntry(identity);
    const expected = [first.busEntryId, second.busEntryId].sort()[0]!;
    expect(outcome).toMatchObject({ status: "reserved", entry: { busEntryId: expected } });
  });

  it("D: 单飞 fence——reserved 存在时不再预约，返回 in-flight 且不写盘", () => {
    bindSink(URL_A);
    queueEntry("r5d2-d1");
    queueEntry("r5d2-d2");
    const first = reserveNextResultBusEntry(identity);
    expect(first.status).toBe("reserved");
    const file = busFilePath();
    const before = fs.readFileSync(file, "utf8");
    const second = reserveNextResultBusEntry(identity);
    expect(second).toMatchObject({ status: "in_flight", entry: { busEntryId: first.status === "reserved" ? first.entry.busEntryId : "" } });
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    const state = readResultBus(identity, stateDir)!;
    expect(state.entries.filter(entry => entry.deliveryStatus === "queued")).toHaveLength(1);
    expect(state.revision).toBe(3);
  });

  it("E: 精确 release reserved -> queued 并清除 reservation", () => {
    bindSink(URL_A);
    const entry = queueEntry("r5d2-e");
    const reserved = reserveNextResultBusEntry(identity);
    expect(reserved.status).toBe("reserved");
    if (reserved.status !== "reserved") return;
    const revisionBefore = readResultBus(identity, stateDir)!.revision;
    const released = releaseResultBusReservation(identity, {
      busEntryId: entry.busEntryId,
      reservationId: reserved.entry.reservation!.reservationId,
    });
    expect(released).toMatchObject({ status: "released", entry: { deliveryStatus: "queued", reservation: null, sendTarget: null } });
    expect(readResultBus(identity, stateDir)!.revision).toBe(revisionBefore + 1);
  });

  it("F: 错误 reservationId 释放拒绝；claimed 永不可释放", () => {
    bindSink(URL_A);
    const entry = queueEntry("r5d2-f");
    const reserved = reserveNextResultBusEntry(identity);
    if (reserved.status !== "reserved") throw new Error("expected reserved");
    expect(busErrorCode(() => releaseResultBusReservation(identity, {
      busEntryId: entry.busEntryId, reservationId: "01a00000-0000-7000-8000-0000000000ff",
    }))).toBe("RESULT_BUS_RESERVATION_MISMATCH");
    const claimed = beginResultBusSend(identity, {
      busEntryId: entry.busEntryId,
      reservationId: reserved.entry.reservation!.reservationId,
    });
    if (claimed.status !== "claimed") throw new Error("expected claimed");
    expect(busErrorCode(() => releaseResultBusReservation(identity, {
      busEntryId: entry.busEntryId,
      reservationId: reserved.entry.reservation!.reservationId,
    }))).toBe("RESULT_BUS_INVALID_TRANSITION");
    expect(readResultBus(identity, stateDir)?.entries[0]!.deliveryStatus).toBe("claimed");
  });

  it("G: reserve A -> 切换 B -> begin-send 安全回 queued，不冻结旧 A、不铸造 attempt", () => {
    bindSink(URL_A);
    const entry = queueEntry("r5d2-g");
    const reserved = reserveNextResultBusEntry(identity);
    if (reserved.status !== "reserved") throw new Error("expected reserved");
    const reservationId = reserved.entry.reservation!.reservationId;
    bindSink(URL_B);
    const outcome = beginResultBusSend(identity, { busEntryId: entry.busEntryId, reservationId });
    expect(outcome).toMatchObject({ status: "stale_reservation", entry: {
      busEntryId: entry.busEntryId, deliveryStatus: "queued", sendTarget: null, attempt: null, reservation: null,
    } });
    const state = readResultBus(identity, stateDir)!;
    expect(state.entries[0]!.deliveryStatus).toBe("queued");
    expect(state.entries[0]!.sendTarget).toBeNull();
  });

  it("H: 切换后重新预约指向 B", () => {
    bindSink(URL_A);
    const entry = queueEntry("r5d2-h");
    const reserved = reserveNextResultBusEntry(identity);
    if (reserved.status !== "reserved") throw new Error("expected reserved");
    bindSink(URL_B);
    beginResultBusSend(identity, {
      busEntryId: entry.busEntryId,
      reservationId: reserved.entry.reservation!.reservationId,
    });
    const rebound = reserveNextResultBusEntry(identity);
    expect(rebound).toMatchObject({ status: "reserved" });
    if (rebound.status !== "reserved") return;
    const activeB = readActiveWebSinkBinding(identity.id)!;
    expect(rebound.entry.reservation).toMatchObject({ bindingId: activeB.bindingId, epoch: activeB.epoch });
  });

  it("I: reserve A -> begin-send -> claimed 冻结 A snapshot", () => {
    const binding = bindSink(URL_A);
    const entry = queueEntry("r5d2-i");
    const reserved = reserveNextResultBusEntry(identity);
    if (reserved.status !== "reserved") throw new Error("expected reserved");
    const outcome = beginResultBusSend(identity, {
      busEntryId: entry.busEntryId,
      reservationId: reserved.entry.reservation!.reservationId,
    });
    expect(outcome.status).toBe("claimed");
    if (outcome.status !== "claimed") return;
    expect(outcome.sendTarget).toMatchObject({
      bindingId: binding.bindingId,
      canonicalUrl: URL_A,
      epoch: binding.epoch,
      workspaceId: identity.id,
    });
    expect(outcome.entry.deliveryStatus).toBe("claimed");
    expect(outcome.entry.attempt?.attemptId).toBe(outcome.attemptId);
  });

  it("J: begin-send 精确重试 noWrite，返回同一 attemptId/sendTarget", () => {
    bindSink(URL_A);
    const entry = queueEntry("r5d2-j");
    const reserved = reserveNextResultBusEntry(identity);
    if (reserved.status !== "reserved") throw new Error("expected reserved");
    const input = { busEntryId: entry.busEntryId, reservationId: reserved.entry.reservation!.reservationId };
    const first = beginResultBusSend(identity, input);
    if (first.status !== "claimed") throw new Error("expected claimed");
    const file = busFilePath();
    const before = fs.readFileSync(file, "utf8");
    const retry = beginResultBusSend(identity, input);
    expect(retry).toMatchObject({ status: "claimed", noWrite: true, attemptId: first.attemptId });
    if (retry.status !== "claimed") return;
    expect(retry.sendTarget).toEqual(first.sendTarget);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(readResultBus(identity, stateDir)!.revision).toBe(3);
  });

  it("K: begin-send 后 Active Sink 切到 B，claimed 仍保留冻结 A", () => {
    const binding = bindSink(URL_A);
    const entry = queueEntry("r5d2-k");
    const reserved = reserveNextResultBusEntry(identity);
    if (reserved.status !== "reserved") throw new Error("expected reserved");
    beginResultBusSend(identity, {
      busEntryId: entry.busEntryId,
      reservationId: reserved.entry.reservation!.reservationId,
    });
    bindSink(URL_B);
    const state = readResultBus(identity, stateDir)!;
    expect(state.entries[0]).toMatchObject({
      deliveryStatus: "claimed",
      sendTarget: { bindingId: binding.bindingId, canonicalUrl: URL_A, epoch: binding.epoch },
    });
  });

  it("L+M: claimed + 精确 ack -> observed；observed 重放 noWrite", () => {
    bindSink(URL_A);
    const entry = queueEntry("r5d2-lm");
    const reserved = reserveNextResultBusEntry(identity);
    if (reserved.status !== "reserved") throw new Error("expected reserved");
    const claimed = beginResultBusSend(identity, {
      busEntryId: entry.busEntryId,
      reservationId: reserved.entry.reservation!.reservationId,
    });
    if (claimed.status !== "claimed") throw new Error("expected claimed");
    const acked = ackResultBusObserved(identity, { busEntryId: entry.busEntryId, attemptId: claimed.attemptId });
    expect(acked).toMatchObject({ status: "observed", noWrite: false, entry: { deliveryStatus: "observed" } });
    expect(acked.entry.observedAt).toBeTruthy();
    expect(acked.entry.sendTarget).toEqual(claimed.sendTarget);
    expect(acked.entry.attempt).toEqual(claimed.entry.attempt);
    const file = busFilePath();
    const before = fs.readFileSync(file, "utf8");
    const replay = ackResultBusObserved(identity, { busEntryId: entry.busEntryId, attemptId: claimed.attemptId });
    expect(replay).toMatchObject({ status: "observed", noWrite: true });
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("N: 错误 attemptId 的 ack/outcome/retire 全部拒绝", () => {
    bindSink(URL_A);
    const entry = queueEntry("r5d2-n");
    const other = queueEntry("r5d2-n2");
    const reserved = reserveNextResultBusEntry(identity);
    if (reserved.status !== "reserved") throw new Error("expected reserved");
    const claimed = beginResultBusSend(identity, {
      busEntryId: entry.busEntryId,
      reservationId: reserved.entry.reservation!.reservationId,
    });
    if (claimed.status !== "claimed") throw new Error("expected claimed");
    const wrong = "01a00000-0000-7000-8000-0000000000fe";
    expect(busErrorCode(() => ackResultBusObserved(identity, { busEntryId: entry.busEntryId, attemptId: wrong })))
      .toBe("RESULT_BUS_ATTEMPT_MISMATCH");
    expect(busErrorCode(() => markResultBusOutcomeUnknown(identity, { busEntryId: entry.busEntryId, attemptId: wrong })))
      .toBe("RESULT_BUS_ATTEMPT_MISMATCH");
    expect(busErrorCode(() => ackResultBusObserved(identity, { busEntryId: other.busEntryId, attemptId: claimed.attemptId })))
      .toBe("RESULT_BUS_INVALID_TRANSITION");
    expect(readResultBus(identity, stateDir)!.entries.find(item => item.busEntryId === entry.busEntryId)!.deliveryStatus)
      .toBe("claimed");
  });

  it("O: claimed -> outcome_unknown 保留冻结 A 与 attempt", () => {
    const binding = bindSink(URL_A);
    const entry = queueEntry("r5d2-o");
    const reserved = reserveNextResultBusEntry(identity);
    if (reserved.status !== "reserved") throw new Error("expected reserved");
    const claimed = beginResultBusSend(identity, {
      busEntryId: entry.busEntryId,
      reservationId: reserved.entry.reservation!.reservationId,
    });
    if (claimed.status !== "claimed") throw new Error("expected claimed");
    const outcome = markResultBusOutcomeUnknown(identity, {
      busEntryId: entry.busEntryId, attemptId: claimed.attemptId, reasonCode: "SEND_TIMEOUT",
    });
    expect(outcome).toMatchObject({ status: "outcome_unknown", noWrite: false, entry: {
      deliveryStatus: "outcome_unknown",
      sendTarget: { bindingId: binding.bindingId, canonicalUrl: URL_A },
      attempt: claimed.entry.attempt,
      reservation: reserved.entry.reservation,
      outcomeReasonCode: "SEND_TIMEOUT",
    } });
    expect(outcome.entry.outcomeUnknownAt).toBeTruthy();
  });

  it("P: outcome_unknown 遇 Active Sink B 绝不 retarget，且继续单飞 fence", () => {
    const binding = bindSink(URL_A);
    const entry = queueEntry("r5d2-p");
    const reserved = reserveNextResultBusEntry(identity);
    if (reserved.status !== "reserved") throw new Error("expected reserved");
    const claimed = beginResultBusSend(identity, {
      busEntryId: entry.busEntryId,
      reservationId: reserved.entry.reservation!.reservationId,
    });
    if (claimed.status !== "claimed") throw new Error("expected claimed");
    markResultBusOutcomeUnknown(identity, { busEntryId: entry.busEntryId, attemptId: claimed.attemptId });
    bindSink(URL_B);
    const state = readResultBus(identity, stateDir)!;
    expect(state.entries[0]).toMatchObject({
      deliveryStatus: "outcome_unknown",
      sendTarget: { bindingId: binding.bindingId, canonicalUrl: URL_A },
    });
    expect(recoverStaleResultBusEntries(identity, { nowMs: Date.now() + RESULT_BUS_CLAIMED_STALE_MS * 10 }))
      .toEqual({ requeued: 0, outcomeUnknown: 0 });
    const next = reserveNextResultBusEntry(identity);
    expect(next).toMatchObject({ status: "in_flight", entry: { busEntryId: entry.busEntryId } });
  });

  it("Q: late-positive——outcome_unknown + 精确 ack -> observed，清除 outcome 时间戳", () => {
    bindSink(URL_A);
    const entry = queueEntry("r5d2-q");
    const reserved = reserveNextResultBusEntry(identity);
    if (reserved.status !== "reserved") throw new Error("expected reserved");
    const claimed = beginResultBusSend(identity, {
      busEntryId: entry.busEntryId,
      reservationId: reserved.entry.reservation!.reservationId,
    });
    if (claimed.status !== "claimed") throw new Error("expected claimed");
    markResultBusOutcomeUnknown(identity, {
      busEntryId: entry.busEntryId, attemptId: claimed.attemptId, reasonCode: "SEND_TIMEOUT",
    });
    const acked = ackResultBusObserved(identity, { busEntryId: entry.busEntryId, attemptId: claimed.attemptId });
    expect(acked.entry).toMatchObject({
      deliveryStatus: "observed",
      outcomeUnknownAt: null,
      outcomeReasonCode: null,
    });
    expect(acked.entry.observedAt).toBeTruthy();
  });

  it("R: outcome_unknown -> retired_unknown 精确迁移 + 幂等重试", () => {
    bindSink(URL_A);
    const entry = queueEntry("r5d2-r");
    const reserved = reserveNextResultBusEntry(identity);
    if (reserved.status !== "reserved") throw new Error("expected reserved");
    const claimed = beginResultBusSend(identity, {
      busEntryId: entry.busEntryId,
      reservationId: reserved.entry.reservation!.reservationId,
    });
    if (claimed.status !== "claimed") throw new Error("expected claimed");
    markResultBusOutcomeUnknown(identity, {
      busEntryId: entry.busEntryId, attemptId: claimed.attemptId, reasonCode: "SEND_TIMEOUT",
    });
    const retired = retireResultBusOutcomeUnknown(identity, { busEntryId: entry.busEntryId, attemptId: claimed.attemptId });
    expect(retired).toMatchObject({ status: "retired_unknown", noWrite: false, entry: {
      deliveryStatus: "retired_unknown",
      outcomeReasonCode: "SEND_TIMEOUT",
      attempt: claimed.entry.attempt,
    } });
    expect(retired.entry.retiredAt).toBeTruthy();
    expect(retired.entry.outcomeUnknownAt).toBeTruthy();
    const file = busFilePath();
    const before = fs.readFileSync(file, "utf8");
    const retry = retireResultBusOutcomeUnknown(identity, { busEntryId: entry.busEntryId, attemptId: claimed.attemptId });
    expect(retry).toMatchObject({ status: "retired_unknown", noWrite: true });
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("S: retired_unknown 是终态并释放单飞，后续 queued 可预约", () => {
    bindSink(URL_A);
    const first = queueEntry("r5d2-s1");
    queueEntry("r5d2-s2");
    const reserved = reserveNextResultBusEntry(identity);
    if (reserved.status !== "reserved") throw new Error("expected reserved");
    const claimed = beginResultBusSend(identity, {
      busEntryId: first.busEntryId,
      reservationId: reserved.entry.reservation!.reservationId,
    });
    if (claimed.status !== "claimed") throw new Error("expected claimed");
    markResultBusOutcomeUnknown(identity, { busEntryId: first.busEntryId, attemptId: claimed.attemptId });
    retireResultBusOutcomeUnknown(identity, { busEntryId: first.busEntryId, attemptId: claimed.attemptId });
    const next = reserveNextResultBusEntry(identity);
    expect(next.status).toBe("reserved");
    if (next.status !== "reserved") return;
    expect(next.entry.busEntryId).not.toBe(first.busEntryId);
    expect(next.entry.deliveryStatus).toBe("reserved");
  });

  it("T: stale reserved -> queued（安全侧恢复）", () => {
    bindSink(URL_A);
    const entry = queueEntry("r5d2-t");
    const t0 = 1_700_000_000_000;
    const reserved = reserveNextResultBusEntry(identity, { nowMs: t0 });
    if (reserved.status !== "reserved") throw new Error("expected reserved");
    expect(recoverStaleResultBusEntries(identity, { nowMs: t0 + RESULT_BUS_RESERVED_STALE_MS - 1 }))
      .toEqual({ requeued: 0, outcomeUnknown: 0 });
    expect(readResultBus(identity, stateDir)?.entries[0]!.deliveryStatus).toBe("reserved");
    const recovered = recoverStaleResultBusEntries(identity, { nowMs: t0 + RESULT_BUS_RESERVED_STALE_MS + 1 });
    expect(recovered).toEqual({ requeued: 1, outcomeUnknown: 0 });
    expect(readResultBus(identity, stateDir)?.entries[0]).toMatchObject({
      deliveryStatus: "queued", reservation: null, sendTarget: null,
    });
  });

  it("U: stale claimed -> outcome_unknown（不安全侧：绝不回 queued，保留 attempt/target）", () => {
    const binding = bindSink(URL_A);
    const entry = queueEntry("r5d2-u");
    const reserved = reserveNextResultBusEntry(identity);
    if (reserved.status !== "reserved") throw new Error("expected reserved");
    const t0 = 1_700_000_100_000;
    const claimed = beginResultBusSend(identity, {
      busEntryId: entry.busEntryId,
      reservationId: reserved.entry.reservation!.reservationId,
    }, { nowMs: t0 });
    if (claimed.status !== "claimed") throw new Error("expected claimed");
    const recovered = recoverStaleResultBusEntries(identity, { nowMs: t0 + RESULT_BUS_CLAIMED_STALE_MS + 1 });
    expect(recovered).toEqual({ requeued: 0, outcomeUnknown: 1 });
    const state = readResultBus(identity, stateDir)!;
    expect(state.entries[0]).toMatchObject({
      deliveryStatus: "outcome_unknown",
      sendTarget: { bindingId: binding.bindingId, canonicalUrl: URL_A },
      attempt: claimed.entry.attempt,
      outcomeReasonCode: "CLAIMED_STALE",
    });
    expect(state.entries[0]!.deliveryStatus).not.toBe("queued");
  });

  it("V: shadow reconciliation 在所有 lifecycle 状态下保真重放", () => {
    bindSink(URL_A);
    // 非终态（claimed/outcome_unknown）会单飞 fence 后续预约：每个用例重放断言后
    // 先清理到终态，reserved 用例置于最后。
    const cases: Array<{ commandId: string; advance: (busEntryId: string) => { lifecycle: string; cleanup?: (busEntryId: string) => void } }> = [
      { commandId: "r5d2-v-claimed", advance: busEntryId => {
          const reserved = reserveNextResultBusEntry(identity);
          if (reserved.status !== "reserved") throw new Error("expected reserved");
          const claimed = beginResultBusSend(identity, { busEntryId, reservationId: reserved.entry.reservation!.reservationId });
          if (claimed.status !== "claimed") throw new Error("expected claimed");
          return {
            lifecycle: "claimed",
            cleanup: id => {
              const acked = ackResultBusObserved(identity, { busEntryId: id, attemptId: claimed.attemptId });
              if (acked.status !== "observed") throw new Error("cleanup expected observed");
            },
          };
        } },
      { commandId: "r5d2-v-observed", advance: busEntryId => {
          const reserved = reserveNextResultBusEntry(identity);
          if (reserved.status !== "reserved") throw new Error("expected reserved");
          const claimed = beginResultBusSend(identity, { busEntryId, reservationId: reserved.entry.reservation!.reservationId });
          if (claimed.status !== "claimed") throw new Error("expected claimed");
          const acked = ackResultBusObserved(identity, { busEntryId, attemptId: claimed.attemptId });
          if (acked.status !== "observed") throw new Error("expected observed");
          return { lifecycle: "observed" };
        } },
      { commandId: "r5d2-v-outcome", advance: busEntryId => {
          const reserved = reserveNextResultBusEntry(identity);
          if (reserved.status !== "reserved") throw new Error("expected reserved");
          const claimed = beginResultBusSend(identity, { busEntryId, reservationId: reserved.entry.reservation!.reservationId });
          if (claimed.status !== "claimed") throw new Error("expected claimed");
          const outcome = markResultBusOutcomeUnknown(identity, { busEntryId, attemptId: claimed.attemptId });
          if (outcome.status !== "outcome_unknown") throw new Error("expected outcome_unknown");
          return {
            lifecycle: "outcome_unknown",
            cleanup: id => {
              const retired = retireResultBusOutcomeUnknown(identity, { busEntryId: id, attemptId: claimed.attemptId });
              if (retired.status !== "retired_unknown") throw new Error("cleanup expected retired_unknown");
            },
          };
        } },
      { commandId: "r5d2-v-retired", advance: busEntryId => {
          const reserved = reserveNextResultBusEntry(identity);
          if (reserved.status !== "reserved") throw new Error("expected reserved");
          const claimed = beginResultBusSend(identity, { busEntryId, reservationId: reserved.entry.reservation!.reservationId });
          if (claimed.status !== "claimed") throw new Error("expected claimed");
          markResultBusOutcomeUnknown(identity, { busEntryId, attemptId: claimed.attemptId });
          const retired = retireResultBusOutcomeUnknown(identity, { busEntryId, attemptId: claimed.attemptId });
          if (retired.status !== "retired_unknown") throw new Error("expected retired_unknown");
          return { lifecycle: "retired_unknown" };
        } },
      { commandId: "r5d2-v-reserved", advance: busEntryId => {
          const reserved = reserveNextResultBusEntry(identity);
          if (reserved.status !== "reserved" || reserved.entry.busEntryId !== busEntryId) throw new Error("expected reserved");
          return { lifecycle: "reserved" };
        } },
    ];
    for (const testCase of cases) {
      const entry = queueEntry(testCase.commandId);
      const outcome = testCase.advance(entry.busEntryId);
      const file = busFilePath();
      const before = fs.readFileSync(file, "utf8");
      const stateBefore = readResultBus(identity, stateDir)!;
      expect(reconcileWorkspaceResultBus(identity, stateDir))
        .toEqual({ projected: 0, replayed: stateBefore.entries.length });
      expect(fs.readFileSync(file, "utf8")).toBe(before);
      expect(readResultBus(identity, stateDir)!.revision).toBe(stateBefore.revision);
      expect(readResultBus(identity, stateDir)!.entries.find(item => item.busEntryId === entry.busEntryId)!.deliveryStatus)
        .toBe(outcome.lifecycle);
      outcome.cleanup?.(entry.busEntryId);
    }
  });

  it("W: schema 拒绝不可能的 metadata/state 组合", () => {
    const result = canonicalResult("r5d2-w");
    const now = new Date().toISOString();
    const target = {
      version: 1 as const, bindingId: "binding-w", pluginId: "chatgpt-web", surfaceId: "chatgpt-web",
      workspaceId: identity.id, canonicalUrl: URL_A, epoch: 1, frozenAt: now,
    };
    const reserve = {
      reservationId: "01a00000-0000-7000-8000-0000000004d1", reservedAt: now,
      bindingId: "binding-w", epoch: 1, boundAt: now,
    };
    const claim = { attemptId: "01a00000-0000-7000-8000-0000000004d2", claimedAt: now };
    const base = {
      version: 1,
      busEntryId: resultBusEntryId(identity.id, result.commandId, 1),
      workspaceId: identity.id,
      commandId: result.commandId,
      iteration: 1,
      resultId: result.resultId,
      resultSha256: canonicalRoutingResultDigest(result),
      result,
      createdAt: now,
      sendTarget: null,
      reservation: null,
      attempt: null,
      observedAt: null,
      outcomeUnknownAt: null,
      retiredAt: null,
      outcomeReasonCode: null,
    };
    expect(() => resultBusStateSchema.parse({ version: 1, workspaceId: identity.id, workspaceRoot: identity.root, revision: 1,
      entries: [{ ...base, deliveryStatus: "queued", reservation: reserve }] })).toThrow();
    expect(() => resultBusStateSchema.parse({ version: 1, workspaceId: identity.id, workspaceRoot: identity.root, revision: 1,
      entries: [{ ...base, deliveryStatus: "reserved", reservation: reserve, attempt: claim }] })).toThrow();
    expect(() => resultBusStateSchema.parse({ version: 1, workspaceId: identity.id, workspaceRoot: identity.root, revision: 1,
      entries: [{ ...base, deliveryStatus: "claimed", sendTarget: target, reservation: reserve, attempt: claim, outcomeUnknownAt: now }] })).toThrow();
    expect(() => resultBusStateSchema.parse({ version: 1, workspaceId: identity.id, workspaceRoot: identity.root, revision: 1,
      entries: [{ ...base, deliveryStatus: "observed", sendTarget: target, reservation: reserve, attempt: claim, observedAt: now, outcomeUnknownAt: now }] })).toThrow();
    expect(() => resultBusStateSchema.parse({ version: 1, workspaceId: identity.id, workspaceRoot: identity.root, revision: 1,
      entries: [{ ...base, deliveryStatus: "outcome_unknown", sendTarget: target, reservation: reserve, attempt: claim, outcomeUnknownAt: now, observedAt: now }] })).toThrow();
    expect(() => resultBusStateSchema.parse({ version: 1, workspaceId: identity.id, workspaceRoot: identity.root, revision: 1,
      entries: [{ ...base, deliveryStatus: "retired_unknown", sendTarget: target, reservation: reserve, attempt: claim, outcomeUnknownAt: now, retiredAt: now, observedAt: now }] })).toThrow();
    expect(() => resultBusStateSchema.parse({ version: 1, workspaceId: identity.id, workspaceRoot: identity.root, revision: 1,
      entries: [{ ...base, deliveryStatus: "retired_unknown", sendTarget: target, reservation: reserve, attempt: claim, retiredAt: now }] })).toThrow();
    expect(resultBusStateSchema.parse({ version: 1, workspaceId: identity.id, workspaceRoot: identity.root, revision: 1,
      entries: [{ ...base, deliveryStatus: "retired_unknown", sendTarget: target, reservation: reserve, attempt: claim,
        outcomeUnknownAt: now, retiredAt: now, outcomeReasonCode: "SEND_TIMEOUT" }] })).toBeTruthy();
  });

  it("X: 持久化 Bus JSON 不含 planner/principal/companion/executor 身份字段", () => {
    bindSink(URL_A);
    const entry = queueEntry("r5d2-x");
    const reserved = reserveNextResultBusEntry(identity);
    if (reserved.status !== "reserved") throw new Error("expected reserved");
    const claimed = beginResultBusSend(identity, {
      busEntryId: entry.busEntryId,
      reservationId: reserved.entry.reservation!.reservationId,
    });
    if (claimed.status !== "claimed") throw new Error("expected claimed");
    ackResultBusObserved(identity, { busEntryId: entry.busEntryId, attemptId: claimed.attemptId });
    const state = JSON.parse(fs.readFileSync(busFilePath(), "utf8")) as { entries: Array<{ result?: unknown }> };
    for (const persisted of state.entries) {
      delete persisted.result;
    }
    const serialized = JSON.stringify(state);
    expect(serialized).not.toMatch(/plannerRouteId|principalFingerprint|companionId|credential|executorRouteId|executorBindingId/);
  });
});

describe("R5d2 review-fix: persisted invariants", () => {
  const NOW = "2026-09-30T03:00:00.000Z";
  const STAMP_A = { bindingId: "binding-a", epoch: 1, boundAt: NOW };
  const STAMP_B = { bindingId: "binding-b", epoch: 2, boundAt: NOW };
  const RESERVE_A = { reservationId: "01a00000-0000-7000-8000-0000000005d1", reservedAt: NOW, ...STAMP_A };
  const RESERVE_B = { reservationId: "01a00000-0000-7000-8000-0000000005d2", reservedAt: NOW, ...STAMP_B };
  const CLAIM = { attemptId: "01a00000-0000-7000-8000-0000000005d3", claimedAt: NOW };
  const targetFor = (bindingId: string, epoch: number) => ({
    version: 1 as const, bindingId, pluginId: "chatgpt-web", surfaceId: "chatgpt-web",
    workspaceId: identity.id, canonicalUrl: "https://chatgpt.com/", epoch, frozenAt: NOW,
  });

  function fixtureEntry(result: ReturnType<typeof canonicalResult>, overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      busEntryId: resultBusEntryId(identity.id, result.commandId, 1),
      workspaceId: identity.id,
      commandId: result.commandId,
      iteration: 1,
      resultId: result.resultId,
      resultSha256: canonicalRoutingResultDigest(result),
      result,
      createdAt: NOW,
      deliveryStatus: "queued",
      sendTarget: null,
      reservation: null,
      attempt: null,
      observedAt: null,
      outcomeUnknownAt: null,
      retiredAt: null,
      outcomeReasonCode: null,
      ...overrides,
    };
  }

  function parseState(entries: unknown[]) {
    return resultBusStateSchema.parse({ version: 1, workspaceId: identity.id, workspaceRoot: identity.root, revision: 1, entries });
  }

  it("review-1a: claimed 冻结 provenance 漂移 → readResultBus fail closed（RESULT_BUS_STATE_CORRUPT）", () => {
    const binding = bindSink(URL_A);
    const entry = queueEntry("r5d2-rf1");
    const reserved = reserveNextResultBusEntry(identity);
    if (reserved.status !== "reserved") throw new Error("expected reserved");
    beginResultBusSend(identity, {
      busEntryId: entry.busEntryId,
      reservationId: reserved.entry.reservation!.reservationId,
    });
    const file = busFilePath();
    const originalText = fs.readFileSync(file, "utf8");
    const tamper = (mutate: (state: { entries: Array<{ sendTarget: { bindingId: string; epoch: number } }> }) => void) => {
      fs.writeFileSync(file, originalText);
      const state = JSON.parse(originalText);
      mutate(state);
      fs.writeFileSync(file, JSON.stringify(state));
      expect(busErrorCode(() => readResultBus(identity, stateDir))).toBe("RESULT_BUS_STATE_CORRUPT");
    };
    // 同 epoch 但 bindingId 漂移
    tamper(state => { state.entries[0]!.sendTarget.bindingId = "binding-tampered"; });
    // 同 bindingId 但 epoch 漂移
    tamper(state => { state.entries[0]!.sendTarget.epoch = binding.epoch + 1; });
    // 恢复一致 → 接受
    fs.writeFileSync(file, originalText);
    expect(readResultBus(identity, stateDir)!.entries[0]).toMatchObject({
      deliveryStatus: "claimed", busEntryId: entry.busEntryId,
      reservation: { bindingId: binding.bindingId, epoch: binding.epoch },
      sendTarget: { bindingId: binding.bindingId, epoch: binding.epoch },
    });
  });

  it("review-1b: 四个冻结状态均强制 reservation/target binding stamp 一致", () => {
    const r1 = canonicalResult("r5d2-rf-p1");
    const r2 = canonicalResult("r5d2-rf-p2");
    const r3 = canonicalResult("r5d2-rf-p3");
    const r4 = canonicalResult("r5d2-rf-p4");
    const frozenStates = [
      { deliveryStatus: "claimed", result: r1, extra: {} },
      { deliveryStatus: "observed", result: r2, extra: { observedAt: NOW } },
      { deliveryStatus: "outcome_unknown", result: r3, extra: { outcomeUnknownAt: NOW } },
      { deliveryStatus: "retired_unknown", result: r4, extra: { outcomeUnknownAt: NOW, retiredAt: NOW } },
    ] as const;
    for (const testCase of frozenStates) {
      const matching = fixtureEntry(testCase.result, {
        deliveryStatus: testCase.deliveryStatus, sendTarget: targetFor("binding-a", 1),
        reservation: RESERVE_A, attempt: CLAIM, ...testCase.extra,
      });
      expect(parseState([matching])).toBeTruthy();
      // 同 epoch 但 bindingId 不一致
      const bindingDrift = fixtureEntry(testCase.result, {
        deliveryStatus: testCase.deliveryStatus, sendTarget: targetFor("binding-b", 1),
        reservation: RESERVE_A, attempt: CLAIM, ...testCase.extra,
      });
      expect(() => parseState([bindingDrift])).toThrow();
      // 同 bindingId 但 epoch 不一致
      const epochDrift = fixtureEntry(testCase.result, {
        deliveryStatus: testCase.deliveryStatus, sendTarget: targetFor("binding-a", 2),
        reservation: RESERVE_A, attempt: CLAIM, ...testCase.extra,
      });
      expect(() => parseState([epochDrift])).toThrow();
    }
  });

  it("review-2a: schema 拒绝两个 durable in-flight；单 in-flight + 终态/queued 可接受", () => {
    const r1 = canonicalResult("r5d2-rf-s1");
    const r2 = canonicalResult("r5d2-rf-s2");
    const r3 = canonicalResult("r5d2-rf-s3");
    const reserved1 = fixtureEntry(r1, { deliveryStatus: "reserved", reservation: RESERVE_A });
    const reserved2 = fixtureEntry(r2, { deliveryStatus: "reserved", reservation: RESERVE_B });
    const claimed = fixtureEntry(r2, {
      deliveryStatus: "claimed", sendTarget: targetFor("binding-b", 2), reservation: RESERVE_B, attempt: CLAIM,
    });
    const outcomeUnknown = fixtureEntry(r3, {
      deliveryStatus: "outcome_unknown", sendTarget: targetFor("binding-a", 1), reservation: RESERVE_A, attempt: CLAIM, outcomeUnknownAt: NOW,
    });
    const observed = fixtureEntry(r2, {
      deliveryStatus: "observed", sendTarget: targetFor("binding-a", 1), reservation: RESERVE_A, attempt: CLAIM, observedAt: NOW,
    });
    const retired = fixtureEntry(r3, {
      deliveryStatus: "retired_unknown", sendTarget: targetFor("binding-a", 1), reservation: RESERVE_A, attempt: CLAIM,
      outcomeUnknownAt: NOW, retiredAt: NOW,
    });
    expect(() => parseState([reserved1, reserved2])).toThrow();
    expect(() => parseState([reserved1, claimed])).toThrow();
    expect(() => parseState([claimed, outcomeUnknown])).toThrow();
    expect(parseState([reserved1, observed, retired])).toBeTruthy();
    expect(parseState([observed, retired, fixtureEntry(r1)])).toBeTruthy();
  });

  it("review-2b: readResultBus 将双 in-flight 持久化状态映射为 RESULT_BUS_STATE_CORRUPT", () => {
    const r1 = canonicalResult("r5d2-rf-b1");
    const r2 = canonicalResult("r5d2-rf-b2");
    const file = busFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      version: 1, workspaceId: identity.id, workspaceRoot: identity.root, revision: 2,
      entries: [
        fixtureEntry(r1, { deliveryStatus: "reserved", reservation: RESERVE_A }),
        fixtureEntry(r2, { deliveryStatus: "reserved", reservation: RESERVE_B }),
      ],
    }));
    expect(busErrorCode(() => readResultBus(identity, stateDir))).toBe("RESULT_BUS_STATE_CORRUPT");
  });

  it("review-3: absent-state 只读空操作不创建文件；noWrite 注入非空 state → corrupt", () => {
    bindSink(URL_A);
    const outcome = withResultBusTransaction(identity, previous => {
      expect(previous).toBeNull();
      return { state: null, result: "noop", noWrite: true };
    });
    expect(outcome).toBe("noop");
    expect(fs.existsSync(busFilePath())).toBe(false);
    expect(fs.existsSync(`${busFilePath()}.initialized`)).toBe(false);
    const injected = { version: 1 as const, workspaceId: identity.id, workspaceRoot: identity.root, revision: 1, entries: [] };
    expect(() => withResultBusTransaction(identity, previous => {
      expect(previous).toBeNull();
      return { state: injected, result: null, noWrite: true };
    })).toThrowError(ResultBusError);
    expect(fs.existsSync(busFilePath())).toBe(false);
    // 空 bus 上的 reserve / recover 保留只读空操作语义
    expect(reserveNextResultBusEntry(identity)).toEqual({ status: "empty" });
    expect(recoverStaleResultBusEntries(identity)).toEqual({ requeued: 0, outcomeUnknown: 0 });
    expect(fs.existsSync(busFilePath())).toBe(false);
  });

  it("review-3b: 既有 state + noWrite 同 state 不变；changed noWrite → corrupt 且不写盘", () => {
    const entry = queueEntry("r5d2-rf-3b");
    const file = busFilePath();
    const before = fs.readFileSync(file, "utf8");
    const same = withResultBusTransaction(identity, previous => ({ state: previous, result: previous!.revision, noWrite: true }));
    expect(same).toBe(1);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(() => withResultBusTransaction(identity, previous => ({
      state: { ...previous!, revision: previous!.revision + 5 },
      result: null,
      noWrite: true,
    }))).toThrowError(ResultBusError);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(readResultBus(identity, stateDir)!.entries[0]!.busEntryId).toBe(entry.busEntryId);
    expect(entry.busEntryId).toBeTruthy();
  });
});


describe("Result Bus 短通知与历史消息兼容", () => {
  it.each(["ok", "failed", "blocked"] as const)("%s 仅通知结束，持久读取、claimed 重放及 unknown 重建保持信号和 hash", status => {
    bindSink(URL_A);
    const result = canonicalResult(`signal-${status}`, 1, status);
    if (!("rawSummary" in result)) throw new Error("expected canonical");
    const entry = enqueueResultBusEntry(identity, result, stateDir).entry;
    const reserved = reserveNextResultBusEntry(identity);
    if (reserved.status !== "reserved") throw new Error("expected reserved");
    expect(reserved.entry.attempt).toBeNull();
    const input = { busEntryId: entry.busEntryId, reservationId: reserved.entry.reservation!.reservationId };
    const begun = beginResultBusSend(identity, input);
    if (begun.status !== "claimed") throw new Error("expected claimed");
    expect(begun.entry.attempt?.messageFormat).toBe("signal-v1");
    const delivery = resultBusDeliveryMessage(begun.entry, begun.attemptId);
    expect(delivery).toEqual({ signal: { type: "execution_ended", version: 1, workspaceId: identity.id,
      commandId: result.commandId, taskId: `desktop_${result.commandId}`, attemptId: begun.attemptId },
      messageSha256: productionFeedbackMessageSha256(renderCompletionNotification(delivery.signal)) });
    expect(delivery).not.toHaveProperty("message");
    expect(JSON.stringify(delivery)).not.toContain(result.rawSummary!);
    expect(JSON.stringify(delivery)).not.toContain("r5d2 passed");
    const file = busFilePath(), bytes = fs.readFileSync(file, "utf8");
    const loaded = readResultBus(identity, stateDir)!.entries[0]!;
    expect(resultBusDeliveryMessage(loaded, begun.attemptId)).toEqual(delivery);
    expect(() => resultBusDeliveryMessage(loaded, PLANNER)).toThrow("attemptId");
    const replay = beginResultBusSend(identity, input);
    if (replay.status !== "claimed") throw new Error("expected claimed");
    expect(replay.noWrite).toBe(true);
    expect(resultBusDeliveryMessage(replay.entry, replay.attemptId)).toEqual(delivery);
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    markResultBusOutcomeUnknown(identity, { busEntryId: entry.busEntryId, attemptId: begun.attemptId });
    expect(resultBusDeliveryMessage(readResultBus(identity, stateDir)!.entries[0]!, begun.attemptId)).toEqual(delivery);
    expect(ackResultBusObserved(identity, { busEntryId: entry.busEntryId, attemptId: begun.attemptId }).status).toBe("observed");
  });

  it("缺失 messageFormat 的历史 canonical attempt 不补写，保持原消息/hash 与 exact ACK", () => {
    bindSink(URL_A);
    const entry = queueEntry("legacy-notification");
    const reserved = reserveNextResultBusEntry(identity);
    if (reserved.status !== "reserved") throw new Error("expected reserved");
    const input = { busEntryId: entry.busEntryId, reservationId: reserved.entry.reservation!.reservationId };
    const begun = beginResultBusSend(identity, input);
    if (begun.status !== "claimed") throw new Error("expected claimed");
    const file = busFilePath(), state = JSON.parse(fs.readFileSync(file, "utf8"));
    delete state.entries[0].attempt.messageFormat;
    fs.writeFileSync(file, JSON.stringify(state));
    const bytes = fs.readFileSync(file, "utf8");
    const canonical = entry.result;
    if (!("rawSummary" in canonical) || !("machineEvidence" in canonical)) throw new Error("expected canonical");
    const evidence = canonical.machineEvidence;
    const oldMessage = formatCanonicalExecutedMessage({ workspaceId: identity.id,
      commandId: entry.commandId, taskId: evidence.taskId, iteration: entry.iteration, result: "ok",
      eventId: resultBusCompanionDeliveryId(entry.busEntryId), attemptId: begun.attemptId,
      changedFilesSummary: [], testsSummary: evidence.testsSummary, outputAvailable: false,
      rawSummary: canonical.rawSummary, machineEvidence: { version: 1, source: "codex_desktop_receipt",
        status: "ok", changedFiles: [], testsSummary: evidence.testsSummary, output: undefined } });
    const replay = beginResultBusSend(identity, input);
    if (replay.status !== "claimed") throw new Error("expected claimed");
    expect(replay.entry.attempt).not.toHaveProperty("messageFormat");
    expect(replay.noWrite).toBe(true);
    expect(resultBusDeliveryMessage(replay.entry, replay.attemptId)).toEqual({ message: oldMessage,
      messageSha256: productionFeedbackMessageSha256(oldMessage) });
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    markResultBusOutcomeUnknown(identity, { busEntryId: entry.busEntryId, attemptId: begun.attemptId });
    expect(resultBusDeliveryMessage(readResultBus(identity, stateDir)!.entries[0]!, begun.attemptId).message).toBe(oldMessage);
    expect(ackResultBusObserved(identity, { busEntryId: entry.busEntryId, attemptId: begun.attemptId }).status).toBe("observed");
  });

  it.each(["legacy", "future", null])("非法 messageFormat %s 损坏状态 fail closed 且不写盘", messageFormat => {
    bindSink(URL_A); queueEntry("invalid-format");
    const reserved = reserveNextResultBusEntry(identity);
    if (reserved.status !== "reserved") throw new Error("expected reserved");
    beginResultBusSend(identity, { busEntryId: reserved.entry.busEntryId, reservationId: reserved.entry.reservation!.reservationId });
    const file = busFilePath(), state = JSON.parse(fs.readFileSync(file, "utf8"));
    state.entries[0].attempt.messageFormat = messageFormat;
    fs.writeFileSync(file, JSON.stringify(state));
    const bytes = fs.readFileSync(file, "utf8");
    expect(busErrorCode(() => readResultBus(identity, stateDir))).toBe("RESULT_BUS_STATE_CORRUPT");
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
  });
});
