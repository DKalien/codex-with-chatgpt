import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";
import { appendResult, createCommand, registerRoute } from "../src/routing/store.js";
import { enqueueResultBusEntry, readResultBus } from "../src/result-bus/store.js";
import {
  ackResultBusObserved,
  beginResultBusSend,
  markResultBusOutcomeUnknown,
  reserveNextResultBusEntry,
  retireResultBusOutcomeUnknown,
} from "../src/result-bus/delivery-lifecycle.js";
import {
  bindCurrentWebSink,
  projectChatgptRouteToWebSinkCandidate,
  readActiveWebSinkBinding,
} from "../src/web-sink-control/index.js";
import { acquireEndpointSwitchLock, endpointSwitchLockFile } from "../src/endpoint-switch/lock.js";

let stateDir: string;
let wsRoot: string;
let workspace: Workspace;

const ROUTE_A = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const ROUTE_B = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";
const PLANNER_CONV = "planner-conv-r5e-sink";
const EXECUTOR = "01a00000-0000-7000-8000-00000000e5d1";
const BINDING = "01a00000-0000-7000-8000-00000000e5d2";
const HEX64 = "c".repeat(64);

beforeEach(() => {
  stateDir = isolateStateDir();
  wsRoot = makeTmpDir("r5e-sink-switch-ws");
  workspace = new Workspace(wsRoot);
});

afterEach(() => {
  cleanup(stateDir);
  cleanup(wsRoot);
});

function seedBusEntry(commandId: string) {
  const planner = registerRoute(workspace, {
    role: "planner", platform: "chatgpt_web", conversationId: PLANNER_CONV, locator: {},
  }, stateDir);
  const executor = registerRoute(workspace, {
    role: "executor", platform: "codex_desktop", conversationId: EXECUTOR,
    locator: { hostId: "local", executorProjectId: "r5e" },
  }, stateDir);
  createCommand(workspace, {
    commandId, plannerRouteId: planner.routeId, executorRouteId: executor.routeId,
    intent: "development_plan", payloadBytes: 1, payloadSha256: HEX64,
  }, stateDir);
  const result = appendResult(workspace, {
    commandId, executorRouteId: executor.routeId, iteration: 1, status: "ok",
    rawSummary: `R5e sink-switch result ${commandId}`,
    machineEvidence: {
      version: 1, source: "codex_desktop_receipt", desktopReceiptSha256: HEX64,
      taskId: `desktop_${commandId}`, iteration: 1, status: "ok", threadId: EXECUTOR,
      originTurnId: EXECUTOR, resultTurnId: EXECUTOR, bindingId: BINDING,
      changedFiles: ["src/r5e.ts"], testsSummary: "r5e passed",
    },
  }, stateDir);
  return enqueueResultBusEntry(workspace, result, stateDir).entry;
}

function bindSink(route: string) {
  return bindCurrentWebSink(workspace.id, projectChatgptRouteToWebSinkCandidate({
    workspaceId: workspace.id, routeCanonical: route,
  })).binding;
}

function reserve() {
  return reserveNextResultBusEntry(workspace, {}, stateDir);
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`expected throw ${code}`);
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
  }
}

describe("R5e Web Sink switch serialization", () => {
  it("A: reserve(A) → switch B → begin → stale_reservation，entry 安全回 queued 无 attemptId", () => {
    const sinkA = bindSink(ROUTE_A);
    const entry = seedBusEntry("r5e-sink-a");
    const reserved = reserve();
    expect(reserved.status).toBe("reserved");
    if (reserved.status !== "reserved") return;
    expect(reserved.sink.bindingId).toBe(sinkA.bindingId);
    bindSink(ROUTE_B);
    const begun = beginResultBusSend(workspace, {
      busEntryId: entry.busEntryId, reservationId: reserved.entry.reservation!.reservationId,
    }, {}, stateDir);
    expect(begun.status).toBe("stale_reservation");
    const stored = readResultBus(workspace, stateDir)!.entries.find(e => e.busEntryId === entry.busEntryId)!;
    expect(stored.deliveryStatus).toBe("queued");
    expect(stored.reservation).toBeNull();
    expect(stored.attempt).toBeNull();
    expect(stored.sendTarget).toBeNull();
  });

  it("B: 先 switch B → reserve → reservation 盖章 B", () => {
    bindSink(ROUTE_A);
    const sinkB = bindSink(ROUTE_B);
    seedBusEntry("r5e-sink-b");
    const reserved = reserve();
    expect(reserved.status).toBe("reserved");
    if (reserved.status !== "reserved") return;
    expect(reserved.sink.bindingId).toBe(sinkB.bindingId);
    expect(reserved.entry.reservation!.bindingId).toBe(sinkB.bindingId);
    expect(reserved.entry.reservation!.epoch).toBe(sinkB.epoch);
  });

  it("C: claimed(A) 后 switch B → 冻结 sendTarget 仍 A", () => {
    const sinkA = bindSink(ROUTE_A);
    const entry = seedBusEntry("r5e-sink-c");
    const reserved = reserve();
    const begun = beginResultBusSend(workspace, {
      busEntryId: entry.busEntryId, reservationId: (reserved as { entry: { reservation: { reservationId: string } } }).entry.reservation.reservationId,
    }, {}, stateDir);
    expect(begun.status).toBe("claimed");
    bindSink(ROUTE_B);
    const stored = readResultBus(workspace, stateDir)!.entries.find(e => e.busEntryId === entry.busEntryId)!;
    expect(stored.deliveryStatus).toBe("claimed");
    expect(stored.sendTarget!.bindingId).toBe(sinkA.bindingId);
    expect(stored.sendTarget!.canonicalUrl).toBe(ROUTE_A);
  });

  it("D: stale requeue 后可用新 sink 重新 reserve/begin（safe requeue 周期）", () => {
    bindSink(ROUTE_A);
    const entry = seedBusEntry("r5e-sink-d");
    const first = reserve();
    bindSink(ROUTE_B);
    const begun = beginResultBusSend(workspace, {
      busEntryId: entry.busEntryId, reservationId: (first as { entry: { reservation: { reservationId: string } } }).entry.reservation.reservationId,
    }, {}, stateDir);
    expect(begun.status).toBe("stale_reservation");
    const sinkB = readActiveWebSinkBinding(workspace.id)!;
    const second = reserve();
    expect(second.status).toBe("reserved");
    if (second.status !== "reserved") return;
    expect(second.sink.bindingId).toBe(sinkB.bindingId);
    const claimed = beginResultBusSend(workspace, {
      busEntryId: entry.busEntryId, reservationId: second.entry.reservation!.reservationId,
    }, {}, stateDir);
    expect(claimed.status).toBe("claimed");
    if (claimed.status !== "claimed") return;
    expect(claimed.sendTarget.canonicalUrl).toBe(ROUTE_B);
  });

  it("E: outcome_unknown(A) + switch B → target 仍 A，永不自动 retarget", () => {
    const sinkA = bindSink(ROUTE_A);
    const entry = seedBusEntry("r5e-sink-e");
    const reserved = reserve();
    const begun = beginResultBusSend(workspace, {
      busEntryId: entry.busEntryId, reservationId: (reserved as { entry: { reservation: { reservationId: string } } }).entry.reservation.reservationId,
    }, {}, stateDir);
    if (begun.status !== "claimed") throw new Error("expected claimed");
    markResultBusOutcomeUnknown(workspace, {
      busEntryId: entry.busEntryId, attemptId: begun.attemptId,
    }, {}, stateDir);
    bindSink(ROUTE_B);
    const stored = readResultBus(workspace, stateDir)!.entries.find(e => e.busEntryId === entry.busEntryId)!;
    expect(stored.deliveryStatus).toBe("outcome_unknown");
    expect(stored.sendTarget!.bindingId).toBe(sinkA.bindingId);
    expect(stored.sendTarget!.canonicalUrl).toBe(ROUTE_A);
  });

  it("F: observed/retired(A) + switch B → 历史 target 不变且终态稳定", () => {
    const sinkA = bindSink(ROUTE_A);
    const observedEntry = seedBusEntry("r5e-sink-f1");
    const retiredEntry = seedBusEntry("r5e-sink-f2");
    // observed 路径
    const r1 = reserve();
    const b1 = beginResultBusSend(workspace, {
      busEntryId: observedEntry.busEntryId, reservationId: (r1 as { entry: { reservation: { reservationId: string } } }).entry.reservation.reservationId,
    }, {}, stateDir);
    if (b1.status !== "claimed") throw new Error("expected claimed");
    ackResultBusObserved(workspace, {
      busEntryId: observedEntry.busEntryId, attemptId: b1.attemptId,
    }, {}, stateDir);
    // retired 路径
    const r2 = reserve();
    const b2 = beginResultBusSend(workspace, {
      busEntryId: retiredEntry.busEntryId, reservationId: (r2 as { entry: { reservation: { reservationId: string } } }).entry.reservation.reservationId,
    }, {}, stateDir);
    if (b2.status !== "claimed") throw new Error("expected claimed");
    markResultBusOutcomeUnknown(workspace, {
      busEntryId: retiredEntry.busEntryId, attemptId: b2.attemptId,
    }, {}, stateDir);
    retireResultBusOutcomeUnknown(workspace, {
      busEntryId: retiredEntry.busEntryId, attemptId: b2.attemptId,
    }, {}, stateDir);
    // 双双切换后历史冻结 target 不变
    bindSink(ROUTE_B);
    const entries = readResultBus(workspace, stateDir)!.entries;
    expect(entries.find(e => e.busEntryId === observedEntry.busEntryId)!.sendTarget!.bindingId).toBe(sinkA.bindingId);
    expect(entries.find(e => e.busEntryId === observedEntry.busEntryId)!.deliveryStatus).toBe("observed");
    expect(entries.find(e => e.busEntryId === retiredEntry.busEntryId)!.sendTarget!.bindingId).toBe(sinkA.bindingId);
    expect(entries.find(e => e.busEntryId === retiredEntry.busEntryId)!.deliveryStatus).toBe("retired_unknown");
  });

  it("lock-hook: 手动持 web-sink switch lock → bind/reserve 均 LOCK_BUSY，释放后成功", () => {
    seedBusEntry("r5e-sink-lock");
    const lock = acquireEndpointSwitchLock("web-sink", workspace.id, stateDir);
    expectCode(
      () => bindSink(ROUTE_A),
      "ENDPOINT_SWITCH_LOCK_BUSY",
    );
    expectCode(() => reserve(), "ENDPOINT_SWITCH_LOCK_BUSY");
    lock.release();
    const sink = bindSink(ROUTE_A);
    expect(sink.canonicalUrl).toBe(ROUTE_A);
    const reserved = reserve();
    expect(reserved.status).toBe("reserved");
    // 锁文件位于 endpoint-switch 目录（release 后已删除）
    expect(endpointSwitchLockFile("web-sink", workspace.id, stateDir).includes("endpoint-switch")).toBe(true);
  });
});
