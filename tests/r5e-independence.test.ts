import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";
import { appendResult, createCommand, registerRoute } from "../src/routing/store.js";
import { enqueueResultBusEntry, readResultBus } from "../src/result-bus/store.js";
import {
  ackResultBusObserved,
  beginResultBusSend,
  reserveNextResultBusEntry,
} from "../src/result-bus/delivery-lifecycle.js";
import {
  beginExecutorDispatch,
  bindCurrentExecutor,
  hashRequestAuthority,
  readActiveExecutorBinding,
  readExecutorDispatchEntry,
  readExecutorDispatchState,
} from "../src/executor-control/index.js";
import {
  bindCurrentWebSink,
  projectChatgptRouteToWebSinkCandidate,
  readActiveWebSinkBinding,
} from "../src/web-sink-control/index.js";
import type { ExecutorBindingCandidate } from "../src/endpoints/schema.js";

let stateDir: string;
let wsRoot: string;
let workspace: Workspace;

const ROUTE_W1 = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const ROUTE_W2 = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";
const PLANNER_CONV = "planner-conv-r5e-indep";
const EXECUTOR = "01a00000-0000-7000-8000-00000000e6a1";
const RECEIPT_BINDING = "01a00000-0000-7000-8000-00000000e6a2";
const HEX64 = "c".repeat(64);

beforeEach(() => {
  stateDir = isolateStateDir();
  wsRoot = makeTmpDir("r5e-indep-ws");
  workspace = new Workspace(wsRoot);
});

afterEach(() => {
  cleanup(stateDir);
  cleanup(wsRoot);
});

function executorCandidate(sessionId: string): ExecutorBindingCandidate {
  return {
    pluginId: "codex-desktop",
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    instanceId: "local",
    sessionId,
    locator: { executorProjectId: "proj-indep" },
  };
}

function bindSink(route: string) {
  return bindCurrentWebSink(workspace.id, projectChatgptRouteToWebSinkCandidate({
    workspaceId: workspace.id, routeCanonical: route,
  })).binding;
}

function seedBusEntry(commandId: string) {
  const planner = registerRoute(workspace, {
    role: "planner", platform: "chatgpt_web", conversationId: PLANNER_CONV, locator: {},
  }, stateDir);
  const executor = registerRoute(workspace, {
    role: "executor", platform: "codex_desktop", conversationId: EXECUTOR,
    locator: { hostId: "local", executorProjectId: "indep" },
  }, stateDir);
  createCommand(workspace, {
    commandId, plannerRouteId: planner.routeId, executorRouteId: executor.routeId,
    intent: "development_plan", payloadBytes: 1, payloadSha256: HEX64,
  }, stateDir);
  const result = appendResult(workspace, {
    commandId, executorRouteId: executor.routeId, iteration: 1, status: "ok",
    rawSummary: `R5e independence result ${commandId}`,
    machineEvidence: {
      version: 1, source: "codex_desktop_receipt", desktopReceiptSha256: HEX64,
      taskId: `desktop_${commandId}`, iteration: 1, status: "ok", threadId: EXECUTOR,
      originTurnId: EXECUTOR, resultTurnId: EXECUTOR, bindingId: RECEIPT_BINDING,
      changedFiles: ["src/indep.ts"], testsSummary: "indep passed",
    },
  }, stateDir);
  return enqueueResultBusEntry(workspace, result, stateDir).entry;
}

describe("R5e Executor/Web Sink switching independence", () => {
  it("双域切换互不越界：Executor target 冻结 + Web Sink 冻结各自独立", () => {
    // 1. Executor A + Sink W1
    const a = bindCurrentExecutor(workspace.id, workspace.root, executorCandidate("sess-A"));
    const w1 = bindSink(ROUTE_W1);
    // 2. 命令 X pin A
    const pinnedX = beginExecutorDispatch({
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      bindingId: a.binding.bindingId,
      commandId: "cmd-x",
      intent: "development_plan",
      message: "task-x",
      requestAuthoritySha256: hashRequestAuthority("fp-indep"),
      stateDir,
    });
    expect(pinnedX.phase).toBe("pinned");
    // 3. Result E1 在 W1 上 reserve + begin（冻结 W1）
    const e1 = seedBusEntry("indep-e1");
    const r1 = reserveNextResultBusEntry(workspace, {}, stateDir);
    if (r1.status !== "reserved") throw new Error("expected reserved");
    expect(r1.sink.bindingId).toBe(w1.bindingId);
    const b1 = beginResultBusSend(workspace, {
      busEntryId: e1.busEntryId, reservationId: r1.entry.reservation!.reservationId,
    }, {}, stateDir);
    if (b1.status !== "claimed") throw new Error("expected claimed");
    // E1 先 ack 到终态 observed（保留冻结 W1 target），释放单飞后 E2 才可预约
    const a1 = ackResultBusObserved(workspace, {
      busEntryId: e1.busEntryId, attemptId: b1.entry.attempt!.attemptId,
    }, {}, stateDir);
    if (a1.status !== "observed") throw new Error("expected observed");
    // 4. 切换 Executor → B、Sink → W2
    const w1BeforeExecutorSwitch = readActiveWebSinkBinding(workspace.id)!.bindingId;
    const b = bindCurrentExecutor(workspace.id, workspace.root, executorCandidate("sess-B"));
    // Executor switch 不改 Web Sink control 状态
    expect(readActiveWebSinkBinding(workspace.id)!.bindingId).toBe(w1BeforeExecutorSwitch);
    const dispatchRevisionBeforeSinkSwitch = readExecutorDispatchState(workspace.id, stateDir)!.revision;
    const xTargetBefore = readExecutorDispatchEntry(workspace.id, "cmd-x", stateDir)!.target;
    const w2 = bindSink(ROUTE_W2);
    // WebSink switch 不改 executor binding 与 dispatch ledger
    expect(readActiveExecutorBinding(workspace.id, workspace.root)?.bindingId).toBe(b.binding.bindingId);
    expect(readExecutorDispatchState(workspace.id, stateDir)!.revision).toBe(dispatchRevisionBeforeSinkSwitch);
    expect(readExecutorDispatchEntry(workspace.id, "cmd-x", stateDir)!.target).toEqual(xTargetBefore);
    // 5. 断言双域冻结语义
    // X 仍 A
    expect(readExecutorDispatchEntry(workspace.id, "cmd-x", stateDir)!.target.bindingId).toBe(a.binding.bindingId);
    // 新 Y → B
    const pinnedY = beginExecutorDispatch({
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      bindingId: b.binding.bindingId,
      commandId: "cmd-y",
      intent: "development_plan",
      message: "task-y",
      requestAuthoritySha256: hashRequestAuthority("fp-indep"),
      stateDir,
    });
    expect(pinnedY.phase).toBe("pinned");
    expect(pinnedY.target.bindingId).toBe(b.binding.bindingId);
    // 未预约的 queued E2 → reserve 得 W2
    const e2 = seedBusEntry("indep-e2");
    const r2 = reserveNextResultBusEntry(workspace, {}, stateDir);
    expect(r2.status).toBe("reserved");
    if (r2.status !== "reserved") return;
    expect(r2.sink.bindingId).toBe(w2.bindingId);
    expect(r2.entry.reservation!.bindingId).toBe(w2.bindingId);
    // 已 observed W1 终态仍保留冻结 W1 target
    const e1Stored = readResultBus(workspace, stateDir)!.entries.find(e => e.busEntryId === e1.busEntryId)!;
    expect(e1Stored.deliveryStatus).toBe("observed");
    expect(e1Stored.sendTarget!.bindingId).toBe(w1.bindingId);
    expect(e1Stored.sendTarget!.canonicalUrl).toBe(ROUTE_W1);
  });
});
