import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";
import {
  acquireEndpointSwitchLock,
  beginExecutorDispatch,
  bindCurrentExecutor,
  EndpointSwitchLockError,
  ExecutorDispatchError,
  executorControlFile,
  executorControlInitializedFile,
  executorDispatchFile,
  executorDispatchInitializedFile,
  finalizeExecutorDispatch,
  getProcessDispatchOwnerId,
  hashRequestAuthority,
  markExecutorDispatchOutcomeUnknown,
  readActiveExecutorBinding,
  readExecutorDispatchEntry,
  readExecutorDispatchState,
  type ExecutorProductionBackend,
  type ProductionSendResult,
} from "../src/executor-control/index.js";
import type { ExecutorBindingCandidate } from "../src/endpoints/schema.js";
import { DesktopError } from "../src/desktop/store.js";

let stateDir: string;
let wsRoot: string;
let workspace: Workspace;

beforeEach(() => {
  stateDir = isolateStateDir();
  wsRoot = makeTmpDir("r5e-exec-dispatch-ws");
  workspace = new Workspace(wsRoot);
});

afterEach(() => {
  cleanup(stateDir);
  cleanup(wsRoot);
});

function candidate(sessionId: string): ExecutorBindingCandidate {
  return {
    pluginId: "codex-desktop",
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    instanceId: "local",
    sessionId,
    locator: { executorProjectId: "proj-r5e" },
  };
}

function authority(): string {
  return hashRequestAuthority("planner-fp-r5e");
}

function begin(input: {
  bindingId: string;
  commandId: string;
  message?: string;
  intent?: "development_plan" | "revision";
  requestAuthoritySha256?: string;
  dispatchOwnerId?: string;
}) {
  return beginExecutorDispatch({
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    bindingId: input.bindingId,
    commandId: input.commandId,
    intent: input.intent ?? "development_plan",
    message: input.message ?? `task-${input.commandId}`,
    requestAuthoritySha256: input.requestAuthoritySha256 ?? authority(),
    ...(input.dispatchOwnerId !== undefined ? { dispatchOwnerId: input.dispatchOwnerId } : {}),
    stateDir,
  });
}

interface FakeBackendOptions {
  respond?: (request: ProductionSendRequest) => ProductionSendResult;
  throw?: Error;
}

function fakeBackend(options: FakeBackendOptions = {}): ExecutorProductionBackend & { calls: () => number } {
  let calls = 0;
  return {
    pluginId: "codex-desktop",
    async send(request) {
      calls += 1;
      if (options.throw) throw options.throw;
      if (options.respond) return options.respond(request);
      return {
        commandId: request.commandId,
        pluginId: request.target.pluginId,
        bindingId: request.target.bindingId,
        sessionId: request.target.sessionId,
        deliveryStatus: "accepted",
        deliveryId: `turn-${request.commandId}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        message: "accepted by fake backend",
      };
    },
    calls: () => calls,
  };
}

/** 复刻 executor-tools 的编排：begin → backend.send → 校验 → finalize/mark。 */
async function orchestratedSend(options: {
  bindingId: string;
  commandId: string;
  message?: string;
  intent?: "development_plan" | "revision";
  backend: ExecutorProductionBackend;
  dispatchOwnerId?: string;
}): Promise<Record<string, unknown>> {
  const begin = beginExecutorDispatch({
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    bindingId: options.bindingId,
    commandId: options.commandId,
    intent: options.intent ?? "development_plan",
    message: options.message ?? `task-${options.commandId}`,
    requestAuthoritySha256: authority(),
    ...(options.dispatchOwnerId !== undefined ? { dispatchOwnerId: options.dispatchOwnerId } : {}),
    stateDir,
  });
  const { entry, target } = begin;
  if (begin.phase === "replay") {
    return {
      phase: "replay",
      deliveryStatus: entry.deliveryStatus,
      pluginId: target.pluginId,
      bindingId: target.bindingId,
      sessionId: target.sessionId,
    };
  }
  let sent: ProductionSendResult;
  try {
    sent = await options.backend.send({
      workspace: { id: workspace.id, root: workspace.root } as never,
      plannerFingerprint: "planner-fp-r5e",
      commandId: options.commandId,
      intent: options.intent ?? "development_plan",
      message: options.message ?? `task-${options.commandId}`,
      userConfirmed: true,
      clientId: "client-r5e",
      target,
      authorize: () => {},
    });
  } catch (error) {
    try {
      markExecutorDispatchOutcomeUnknown({
        workspaceId: workspace.id,
        workspaceRoot: workspace.root,
        commandId: options.commandId,
        target,
        errorCode: error instanceof ExecutorDispatchError ? error.code : "EXECUTOR_SEND_FAILED",
        stateDir,
      });
    } catch {
      // 保留原始投递错误
    }
    throw error;
  }
  if (
    sent.commandId !== options.commandId ||
    sent.pluginId !== target.pluginId ||
    sent.bindingId !== target.bindingId ||
    sent.sessionId !== target.sessionId
  ) {
    try {
      markExecutorDispatchOutcomeUnknown({
        workspaceId: workspace.id,
        workspaceRoot: workspace.root,
        commandId: options.commandId,
        target,
        errorCode: "EXECUTOR_DISPATCH_RESULT_MISMATCH",
        stateDir,
      });
    } catch {
      // 保留主错误
    }
    throw new ExecutorDispatchError(
      "EXECUTOR_DISPATCH_RESULT_MISMATCH",
      "backend result 与冻结 target 不一致；已收敛 outcome_unknown。",
    );
  }
  const finalized = finalizeExecutorDispatch({
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    commandId: options.commandId,
    target,
    result: {
      deliveryStatus: sent.deliveryStatus,
      ...(sent.deliveryId !== undefined ? { deliveryId: sent.deliveryId } : {}),
      ...(sent.error !== undefined ? { errorCode: sent.error } : {}),
    },
    stateDir,
  });
  return {
    phase: "delivered",
    deliveryStatus: finalized.entry.deliveryStatus,
    bindingId: target.bindingId,
  };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`expected throw ${code}`);
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
  }
}

describe("R5e executor dispatch（durable target pin + replay）", () => {
  it("A: pin → target 冻结为当前 Active binding A", () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    const pinned = begin({ bindingId: a.binding.bindingId, commandId: "cmd-a" });
    expect(pinned.phase).toBe("pinned");
    expect(pinned.entry.deliveryStatus).toBe("started");
    expect(pinned.entry.commandId).toBe("cmd-a");
    expect(pinned.target.bindingId).toBe(a.binding.bindingId);
    expect(pinned.target.sessionId).toBe("sess-A");
    expect(pinned.target.epoch).toBe(a.binding.epoch);
    expect(pinned.entry.target.frozenAt).toBeTruthy();
    const stored = readExecutorDispatchEntry(workspace.id, "cmd-a", stateDir);
    expect(stored?.deliveryStatus).toBe("started");
    expect(stored?.target.bindingId).toBe(a.binding.bindingId);
    expect(stored?.payloadBytes).toBe(Buffer.byteLength("task-cmd-a", "utf8"));
    expect(stored?.payloadSha256).toHaveLength(64);
    expect(stored?.requestAuthoritySha256).toBe(authority());
    // R5E_DISPATCH_OWNER：pin 持久化进程 owner identity。
    expect(stored?.ownerId).toBe(getProcessDispatchOwnerId());
  });

  it("B: 同 candidate 重复 bind-current → noWrite 幂等（同 bindingId/epoch/boundAt）", () => {
    const first = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    const again = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    expect(again.created).toBe(false);
    expect(again.noWrite).toBe(true);
    expect(again.binding.boundAt).toBe(first.binding.boundAt);
    expect(again.binding.epoch).toBe(first.binding.epoch);
    expect(again.binding.bindingId).toBe(first.binding.bindingId);
  });

  it("C: switch B 后，已 pin 的 X target 仍 A", () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    begin({ bindingId: a.binding.bindingId, commandId: "cmd-x" });
    bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-B"));
    expect(readActiveExecutorBinding(workspace.id, workspace.root)?.sessionId).toBe("sess-B");
    const stored = readExecutorDispatchEntry(workspace.id, "cmd-x", stateDir);
    expect(stored?.target.bindingId).toBe(a.binding.bindingId);
    expect(stored?.target.sessionId).toBe("sess-A");
  });

  it("D: replay(X, bindingId=B) → EXECUTOR_COMMAND_PINNED 且 backend 零调用", async () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    begin({ bindingId: a.binding.bindingId, commandId: "cmd-x" });
    const b = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-B"));
    const backend = fakeBackend();
    expectCode(
      () => begin({ bindingId: b.binding.bindingId, commandId: "cmd-x" }),
      "EXECUTOR_COMMAND_PINNED",
    );
    // 不调用 backend（编排层在 begin 抛错时终止）；entry 仍 started 且 target A。
    expect(backend.calls()).toBe(0);
    expect(readExecutorDispatchEntry(workspace.id, "cmd-x", stateDir)?.deliveryStatus).toBe("started");
    await expect(orchestratedSend({
      bindingId: b.binding.bindingId,
      commandId: "cmd-x",
      backend,
    })).rejects.toMatchObject({ code: "EXECUTOR_COMMAND_PINNED" });
    expect(backend.calls()).toBe(0);
  });

  it("E: terminal replay(A) → durable accepted，backend 零额外调用", async () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    const backend = fakeBackend();
    const first = await orchestratedSend({ bindingId: a.binding.bindingId, commandId: "cmd-e", backend });
    expect(first).toMatchObject({ phase: "delivered", deliveryStatus: "accepted" });
    expect(backend.calls()).toBe(1);
    const replay = await orchestratedSend({ bindingId: a.binding.bindingId, commandId: "cmd-e", backend });
    expect(replay).toMatchObject({ phase: "replay", deliveryStatus: "accepted", bindingId: a.binding.bindingId });
    expect(backend.calls()).toBe(1);
    const stored = readExecutorDispatchEntry(workspace.id, "cmd-e", stateDir);
    expect(stored?.deliveryStatus).toBe("accepted");
    expect(stored?.deliveryId).toBe("turn-cmd-e");
    expect(stored?.terminalAt).toBeTruthy();
  });

  it("F: switch B 后新命令 Y → target B", () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-B"));
    const current = readActiveExecutorBinding(workspace.id, workspace.root)!;
    expect(current.bindingId).not.toBe(a.binding.bindingId);
    const pinned = begin({ bindingId: current.bindingId, commandId: "cmd-y" });
    expect(pinned.phase).toBe("pinned");
    expect(pinned.target.bindingId).toBe(current.bindingId);
    expect(pinned.target.sessionId).toBe("sess-B");
  });

  it("G: outcome_unknown + switch B → 仍 EXECUTOR_COMMAND_PINNED，不自动 retry", async () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    const pinned = begin({ bindingId: a.binding.bindingId, commandId: "cmd-g" });
    markExecutorDispatchOutcomeUnknown({
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      commandId: "cmd-g",
      target: pinned.target,
      errorCode: "EXECUTOR_SEND_FAILED",
      stateDir,
    });
    const b = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-B"));
    const backend = fakeBackend();
    // bindingId=B 不匹配冻结 target A → fail closed；bindingId=A → 幂等 replay，不重发。
    expectCode(() => begin({ bindingId: b.binding.bindingId, commandId: "cmd-g" }), "EXECUTOR_COMMAND_PINNED");
    const replay = await orchestratedSend({ bindingId: a.binding.bindingId, commandId: "cmd-g", backend });
    expect(replay).toMatchObject({ phase: "replay", deliveryStatus: "outcome_unknown" });
    expect(backend.calls()).toBe(0);
    const stored = readExecutorDispatchEntry(workspace.id, "cmd-g", stateDir);
    expect(stored?.target.sessionId).toBe("sess-A");
    expect(stored?.outcomeReasonCode).toBe("send_failed");
  });

  it("H: started 后进程重启（owner 变更）模拟 → replay 收敛 outcome_unknown(interrupted_after_target_pin)，backend 零调用", async () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    begin({ bindingId: a.binding.bindingId, commandId: "cmd-h" });
    const backend = fakeBackend();
    // 同 owner 的 live in-flight 重试必须 IN_FLIGHT（不误判 crash recovery）；
    // 重启后 owner 变更 → 才收敛 outcome_unknown。
    expectCode(() => begin({ bindingId: a.binding.bindingId, commandId: "cmd-h" }), "EXECUTOR_DISPATCH_IN_FLIGHT");
    expect(readExecutorDispatchEntry(workspace.id, "cmd-h", stateDir)?.deliveryStatus).toBe("started");
    const replay = await orchestratedSend({
      bindingId: a.binding.bindingId,
      commandId: "cmd-h",
      backend,
      dispatchOwnerId: "owner-b-restart-sim",
    });
    expect(replay).toMatchObject({ phase: "replay", deliveryStatus: "outcome_unknown" });
    expect(backend.calls()).toBe(0);
    const stored = readExecutorDispatchEntry(workspace.id, "cmd-h", stateDir);
    expect(stored?.deliveryStatus).toBe("outcome_unknown");
    expect(stored?.outcomeReasonCode).toBe("interrupted_after_target_pin");
    expect(stored?.terminalAt).toBeTruthy();
    expect(stored?.target.sessionId).toBe("sess-A");
  });

  it("I: 同 commandId 改 body/intent/authority → EXECUTOR_DISPATCH_IDENTITY_MISMATCH", () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    begin({ bindingId: a.binding.bindingId, commandId: "cmd-i", message: "task-i" });
    expectCode(
      () => begin({ bindingId: a.binding.bindingId, commandId: "cmd-i", message: "task-i-changed" }),
      "EXECUTOR_DISPATCH_IDENTITY_MISMATCH",
    );
    expectCode(
      () => begin({ bindingId: a.binding.bindingId, commandId: "cmd-i", intent: "revision" }),
      "EXECUTOR_DISPATCH_IDENTITY_MISMATCH",
    );
    expectCode(
      () => begin({ bindingId: a.binding.bindingId, commandId: "cmd-i", requestAuthoritySha256: "a".repeat(64) }),
      "EXECUTOR_DISPATCH_IDENTITY_MISMATCH",
    );
    const stored = readExecutorDispatchEntry(workspace.id, "cmd-i", stateDir);
    expect(stored?.deliveryStatus).toBe("started");
    expect(stored?.payloadSha256).toHaveLength(64);
  });

  it("J: backend result 与冻结 target 不一致 → outcome_unknown fail closed，target 不变", async () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    const backend = fakeBackend({
      respond: request => ({
        commandId: request.commandId,
        pluginId: request.target.pluginId,
        bindingId: "someone-else",
        sessionId: request.target.sessionId,
        deliveryStatus: "accepted",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        message: "drifted",
      }),
    });
    await expect(orchestratedSend({ bindingId: a.binding.bindingId, commandId: "cmd-j", backend }))
      .rejects.toMatchObject({ code: "EXECUTOR_DISPATCH_RESULT_MISMATCH" });
    const stored = readExecutorDispatchEntry(workspace.id, "cmd-j", stateDir);
    expect(stored?.deliveryStatus).toBe("outcome_unknown");
    expect(stored?.errorCode).toBe("EXECUTOR_DISPATCH_RESULT_MISMATCH");
    expect(stored?.target.bindingId).toBe(a.binding.bindingId);
    expect(stored?.deliveryId).toBeUndefined();
  });

  it("K: 确定性 interleave——手动持锁时 bind/pin 均 LOCK_BUSY，释放后成功", () => {
    // bind 持锁 → pin 抛 LOCK_BUSY → release → pin 成功
    const lock = acquireEndpointSwitchLock("executor", workspace.id, stateDir);
    expectCode(
      () => bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A")),
      "ENDPOINT_SWITCH_LOCK_BUSY",
    );
    expectCode(
      () => begin({ bindingId: "whatever", commandId: "cmd-k" }),
      "ENDPOINT_SWITCH_LOCK_BUSY",
    );
    lock.release();
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    const pinned = begin({ bindingId: a.binding.bindingId, commandId: "cmd-k" });
    expect(pinned.phase).toBe("pinned");
    // 反向：pin 期间 bind 被拒
    const lock2 = acquireEndpointSwitchLock("executor", workspace.id, stateDir);
    expectCode(
      () => bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-B")),
      "ENDPOINT_SWITCH_LOCK_BUSY",
    );
    lock2.release();
    expect(readActiveExecutorBinding(workspace.id, workspace.root)?.sessionId).toBe("sess-A");
  });

  it("L: EndpointSwitchLockError 类型与 lock 释放语义（二次 release 幂等）", () => {
    const lock = acquireEndpointSwitchLock("executor", workspace.id, stateDir);
    expect(lock).toBeTruthy();
    lock.release();
    expect(() => lock.release()).not.toThrow();
    // 释放后同域同 workspace 可再次获取
    const again = acquireEndpointSwitchLock("executor", workspace.id, stateDir);
    expect(() => (again as { release(): void }).release()).not.toThrow();
    void EndpointSwitchLockError;
  });

  // ---- R5E_REPLAY_INDEPENDENCE：replay 不依赖当前 Active Executor -----------

  /** 清除 Active Executor store（状态文件 + initialized marker）。 */
  function clearActiveExecutorStore(): void {
    fs.rmSync(executorControlFile(workspace.id), { force: true });
    fs.rmSync(executorControlInitializedFile(workspace.id), { force: true });
  }

  it("M: terminal entry 在清除 Active Executor 后 replay 成功，backend 零额外调用", async () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    const backend = fakeBackend();
    const first = await orchestratedSend({ bindingId: a.binding.bindingId, commandId: "cmd-m", backend });
    expect(first).toMatchObject({ phase: "delivered", deliveryStatus: "accepted" });
    expect(backend.calls()).toBe(1);
    clearActiveExecutorStore();
    expect(readActiveExecutorBinding(workspace.id, workspace.root)).toBeNull();
    const replay = await orchestratedSend({ bindingId: a.binding.bindingId, commandId: "cmd-m", backend });
    expect(replay).toMatchObject({
      phase: "replay",
      deliveryStatus: "accepted",
      bindingId: a.binding.bindingId,
    });
    expect(backend.calls()).toBe(1);
    const stored = readExecutorDispatchEntry(workspace.id, "cmd-m", stateDir);
    expect(stored?.deliveryStatus).toBe("accepted");
    expect(stored?.target.sessionId).toBe("sess-A");
  });

  it("N: started entry 在无 Active Executor 时 replay（owner 变更）→ outcome_unknown(interrupted_after_target_pin)；新命令 pin 仍 fail closed", async () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    begin({ bindingId: a.binding.bindingId, commandId: "cmd-n" });
    clearActiveExecutorStore();
    const backend = fakeBackend();
    const replay = await orchestratedSend({
      bindingId: a.binding.bindingId,
      commandId: "cmd-n",
      backend,
      dispatchOwnerId: "owner-b-restart-sim",
    });
    expect(replay).toMatchObject({ phase: "replay", deliveryStatus: "outcome_unknown" });
    expect(backend.calls()).toBe(0);
    const stored = readExecutorDispatchEntry(workspace.id, "cmd-n", stateDir);
    expect(stored?.deliveryStatus).toBe("outcome_unknown");
    expect(stored?.outcomeReasonCode).toBe("interrupted_after_target_pin");
    expect(stored?.terminalAt).toBeTruthy();
    expect(stored?.target.sessionId).toBe("sess-A");
    // 新 commandId 的 pin 路径仍要求当前 Active Executor（fail closed 不变）。
    expectCode(() => begin({ bindingId: a.binding.bindingId, commandId: "cmd-n-new" }), "EXECUTOR_CONTROL_NO_ACTIVE_BINDING");
  });

  it("O: Active Executor store 损坏/陈旧不得影响既有 entry 的 replay 目标", () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    begin({ bindingId: a.binding.bindingId, commandId: "cmd-o" });
    // 篡改 Active Executor store 为损坏内容：replay 分支不得读取它（旧实现会在此抛 STATE_CORRUPT）。
    fs.writeFileSync(executorControlFile(workspace.id), "{ not-json", "utf8");
    const replay = begin({ bindingId: a.binding.bindingId, commandId: "cmd-o", dispatchOwnerId: "owner-b-restart-sim" });
    expect(replay.phase).toBe("replay");
    expect(replay.entry.deliveryStatus).toBe("outcome_unknown");
    expect(replay.entry.outcomeReasonCode).toBe("interrupted_after_target_pin");
    expect(replay.target.bindingId).toBe(a.binding.bindingId);
    expect(replay.target.sessionId).toBe("sess-A");
    const stored = readExecutorDispatchEntry(workspace.id, "cmd-o", stateDir);
    expect(stored?.deliveryStatus).toBe("outcome_unknown");
    expect(stored?.target.bindingId).toBe(a.binding.bindingId);
  });

  // ---- R5E_DISPATCH_OWNER：live in-flight 与 crash recovery 的确定性区分 ----

  it("P1: pause backend 后同 owner 精确重试 → IN_FLIGHT、entry 保持 started、backend 零重试；释放后原请求 accepted；terminal replay 零调用", async () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    let calls = 0;
    let enterBackend!: () => void;
    const backendEntered = new Promise<void>((resolve) => { enterBackend = resolve; });
    let releaseBackend!: () => void;
    const backendGate = new Promise<void>((resolve) => { releaseBackend = resolve; });
    const backend: ExecutorProductionBackend & { calls: () => number } = {
      pluginId: "codex-desktop",
      async send(request) {
        calls += 1;
        enterBackend(); // 确定性屏障：pin 已持久化（begin 先于 send）且 send 已 in-flight
        await backendGate;
        return {
          commandId: request.commandId,
          pluginId: request.target.pluginId,
          bindingId: request.target.bindingId,
          sessionId: request.target.sessionId,
          deliveryStatus: "accepted",
          deliveryId: `turn-${request.commandId}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          message: "accepted by gated backend",
        };
      },
      calls: () => calls,
    };
    const first = orchestratedSend({ bindingId: a.binding.bindingId, commandId: "cmd-p1", backend });
    await backendEntered;
    // 同 owner 精确重试：live in-flight → IN_FLIGHT；绝不 poison 正常 accepted send。
    await expect(orchestratedSend({ bindingId: a.binding.bindingId, commandId: "cmd-p1", backend }))
      .rejects.toMatchObject({ code: "EXECUTOR_DISPATCH_IN_FLIGHT" });
    expect(readExecutorDispatchEntry(workspace.id, "cmd-p1", stateDir)?.deliveryStatus).toBe("started");
    expect(calls).toBe(1); // 重试未触发任何 backend 调用
    releaseBackend();
    expect(await first).toMatchObject({ phase: "delivered", deliveryStatus: "accepted" });
    expect(calls).toBe(1);
    // terminal replay：durable accepted，backend 零额外调用。
    const replay = await orchestratedSend({ bindingId: a.binding.bindingId, commandId: "cmd-p1", backend });
    expect(replay).toMatchObject({ phase: "replay", deliveryStatus: "accepted" });
    expect(calls).toBe(1);
    const stored = readExecutorDispatchEntry(workspace.id, "cmd-p1", stateDir);
    expect(stored?.deliveryStatus).toBe("accepted");
    expect(stored?.deliveryId).toBe("turn-cmd-p1");
  });

  it("P2: started X owner A → owner B replay → outcome_unknown(interrupted_after_target_pin)，backend 零调用", async () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    begin({ bindingId: a.binding.bindingId, commandId: "cmd-p2" });
    const backend = fakeBackend();
    const replay = await orchestratedSend({
      bindingId: a.binding.bindingId,
      commandId: "cmd-p2",
      backend,
      dispatchOwnerId: "owner-b-simulated-restart",
    });
    expect(replay).toMatchObject({ phase: "replay", deliveryStatus: "outcome_unknown" });
    expect(backend.calls()).toBe(0);
    const stored = readExecutorDispatchEntry(workspace.id, "cmd-p2", stateDir);
    expect(stored?.deliveryStatus).toBe("outcome_unknown");
    expect(stored?.outcomeReasonCode).toBe("interrupted_after_target_pin");
    expect(stored?.terminalAt).toBeTruthy();
    expect(stored?.target.bindingId).toBe(a.binding.bindingId);
  });

  it("P3: stale switch lock 不阻塞 existing replay/recovery；新命令仍 LOCK_BUSY，释放后可 pin", async () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    begin({ bindingId: a.binding.bindingId, commandId: "cmd-p3" });
    // crash window 模拟：pin 后 switch lock 未清理（stale）——手动持有同域锁。
    const stale = acquireEndpointSwitchLock("executor", workspace.id, stateDir);
    const backend = fakeBackend();
    // existing entry 的 replay/recovery 只走 dispatch-store transaction，不需要 switch lock。
    const replay = await orchestratedSend({
      bindingId: a.binding.bindingId,
      commandId: "cmd-p3",
      backend,
      dispatchOwnerId: "owner-b-restart-sim",
    });
    expect(replay).toMatchObject({ phase: "replay", deliveryStatus: "outcome_unknown" });
    expect(backend.calls()).toBe(0);
    // 新命令仍 fail closed 在 stale lock 后。
    expectCode(
      () => begin({ bindingId: a.binding.bindingId, commandId: "cmd-p3-new" }),
      "ENDPOINT_SWITCH_LOCK_BUSY",
    );
    stale.release();
    const pinned = begin({ bindingId: a.binding.bindingId, commandId: "cmd-p3-new" });
    expect(pinned.phase).toBe("pinned");
  });
});

// ---- R5E_DISPATCH_STORE_HARDENING：durable authority 加固 -------------------

type RawEntry = Record<string, unknown> & { target?: Record<string, unknown> };

function readRawDispatchState(file: string): { entries: RawEntry[] } {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

describe("R5e dispatch store hardening（R5E_DISPATCH_STORE_HARDENING）", () => {
  let stateDir: string;
  let wsRoot: string;
  let workspace: Workspace;

  beforeEach(() => {
    stateDir = isolateStateDir();
    wsRoot = makeTmpDir("r5e-dispatch-harden-ws");
    workspace = new Workspace(wsRoot);
  });

  afterEach(() => {
    cleanup(stateDir);
    cleanup(wsRoot);
  });

  function candidate(sessionId: string): ExecutorBindingCandidate {
    return {
      pluginId: "codex-desktop",
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      instanceId: "local",
      sessionId,
      locator: { executorProjectId: "proj-r5e" },
    };
  }

  function begin(input: { bindingId: string; commandId: string }) {
    return beginExecutorDispatch({
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      bindingId: input.bindingId,
      commandId: input.commandId,
      intent: "development_plan",
      message: `task-${input.commandId}`,
      requestAuthoritySha256: hashRequestAuthority("planner-fp-r5e"),
      stateDir,
    });
  }

  function dispatchFile(): string {
    return executorDispatchFile(workspace.id, stateDir);
  }

  function markerFile(): string {
    return executorDispatchInitializedFile(workspace.id, stateDir);
  }

  function expectCode(fn: () => unknown, code: string): void {
    try {
      fn();
      expect.unreachable(`expected throw ${code}`);
    } catch (error) {
      expect((error as { code?: string }).code).toBe(code);
    }
  }

  it("P: state 文件必须是普通文件——目录/符号链接替代 → STATE_CORRUPT", () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    begin({ bindingId: a.binding.bindingId, commandId: "cmd-p" });
    const file = dispatchFile();
    // 形态 1：用目录替换 state 文件（non-regular 等价形态；Windows symlink 通常需要特权）。
    fs.rmSync(file);
    fs.mkdirSync(file);
    expectCode(() => readExecutorDispatchState(workspace.id, stateDir), "EXECUTOR_DISPATCH_STATE_CORRUPT");
    expectCode(
      () => begin({ bindingId: a.binding.bindingId, commandId: "cmd-p2" }),
      "EXECUTOR_DISPATCH_STATE_CORRUPT",
    );
    fs.rmdirSync(file);
    // 形态 2：真 symlink（平台允许时才验证）。
    try {
      fs.symlinkSync(path.join(stateDir, "not-the-real-ledger.json"), file);
    } catch {
      return; // 平台拒绝创建 symlink；形态 1 已覆盖 non-regular
    }
    expectCode(() => readExecutorDispatchState(workspace.id, stateDir), "EXECUTOR_DISPATCH_STATE_CORRUPT");
  });

  it("Q: initialized marker 一致性双向 fail closed（file⇒marker、marker⇒file）", () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    begin({ bindingId: a.binding.bindingId, commandId: "cmd-q" });
    // file ⇒ marker：删除 marker → corrupt。
    fs.rmSync(markerFile());
    expectCode(() => readExecutorDispatchState(workspace.id, stateDir), "EXECUTOR_DISPATCH_STATE_CORRUPT");
    // marker ⇒ file：恢复 marker、删除文件 → corrupt。
    fs.writeFileSync(markerFile(), `${workspace.id}\n`, "utf8");
    fs.rmSync(dispatchFile());
    expectCode(() => readExecutorDispatchState(workspace.id, stateDir), "EXECUTOR_DISPATCH_STATE_CORRUPT");
  });

  it("R: duplicate commandId 被 schema 拒绝 → STATE_CORRUPT 且后续 update fail closed", () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    begin({ bindingId: a.binding.bindingId, commandId: "cmd-r1" });
    begin({ bindingId: a.binding.bindingId, commandId: "cmd-r2" });
    const raw = readRawDispatchState(dispatchFile());
    raw.entries = [raw.entries[0], raw.entries[1], { ...raw.entries[1], commandId: "cmd-r1" }];
    fs.writeFileSync(dispatchFile(), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    expectCode(() => readExecutorDispatchState(workspace.id, stateDir), "EXECUTOR_DISPATCH_STATE_CORRUPT");
    expectCode(
      () => begin({ bindingId: a.binding.bindingId, commandId: "cmd-r3" }),
      "EXECUTOR_DISPATCH_STATE_CORRUPT",
    );
  });

  it("S: entry.target workspaceId/workspaceRoot 与 state 漂移 → STATE_CORRUPT", () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    begin({ bindingId: a.binding.bindingId, commandId: "cmd-s" });
    // workspaceId 漂移。
    const raw1 = readRawDispatchState(dispatchFile());
    raw1.entries[0].target!.workspaceId = "ffffffffffff";
    fs.writeFileSync(dispatchFile(), `${JSON.stringify(raw1, null, 2)}\n`, "utf8");
    expectCode(() => readExecutorDispatchState(workspace.id, stateDir), "EXECUTOR_DISPATCH_STATE_CORRUPT");
    // workspaceRoot 漂移（在已漂移文件上继续叠加，两者均 fail closed）。
    const raw2 = readRawDispatchState(dispatchFile());
    raw2.entries[0].target!.workspaceRoot = path.join(wsRoot, "..", "other-root");
    fs.writeFileSync(dispatchFile(), `${JSON.stringify(raw2, null, 2)}\n`, "utf8");
    expectCode(() => readExecutorDispatchState(workspace.id, stateDir), "EXECUTOR_DISPATCH_STATE_CORRUPT");
  });

  it("T: started entry 携带 terminalAt/outcomeReasonCode 残留 → STATE_CORRUPT", () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    begin({ bindingId: a.binding.bindingId, commandId: "cmd-t" });
    const raw = readRawDispatchState(dispatchFile());
    raw.entries[0].terminalAt = new Date().toISOString();
    raw.entries[0].outcomeReasonCode = "interrupted_after_target_pin";
    fs.writeFileSync(dispatchFile(), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    expectCode(() => readExecutorDispatchState(workspace.id, stateDir), "EXECUTOR_DISPATCH_STATE_CORRUPT");
  });

  it("T2: terminal（accepted）缺 terminalAt → STATE_CORRUPT", async () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    const backend = fakeBackendForHardening();
    await orchestratedSendForHardening(a.binding.bindingId, "cmd-t2", backend);
    const raw = readRawDispatchState(dispatchFile());
    delete raw.entries[0].terminalAt;
    fs.writeFileSync(dispatchFile(), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    expectCode(() => readExecutorDispatchState(workspace.id, stateDir), "EXECUTOR_DISPATCH_STATE_CORRUPT");
  });

  it("T3: outcome_unknown 缺 outcomeReasonCode → STATE_CORRUPT", () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    const pinned = begin({ bindingId: a.binding.bindingId, commandId: "cmd-t3" });
    markExecutorDispatchOutcomeUnknown({
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      commandId: "cmd-t3",
      target: pinned.target,
      errorCode: "EXECUTOR_SEND_FAILED",
      stateDir,
    });
    const raw = readRawDispatchState(dispatchFile());
    delete raw.entries[0].outcomeReasonCode;
    fs.writeFileSync(dispatchFile(), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    expectCode(() => readExecutorDispatchState(workspace.id, stateDir), "EXECUTOR_DISPATCH_STATE_CORRUPT");
  });

  it("T4: started entry 携带 deliveryId/errorCode 残留 → STATE_CORRUPT（D 生命周期收紧）", () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    begin({ bindingId: a.binding.bindingId, commandId: "cmd-t4" });
    // deliveryId 残留。
    const raw1 = readRawDispatchState(dispatchFile());
    raw1.entries[0].deliveryId = "turn-ghost";
    fs.writeFileSync(dispatchFile(), `${JSON.stringify(raw1, null, 2)}\n`, "utf8");
    expectCode(() => readExecutorDispatchState(workspace.id, stateDir), "EXECUTOR_DISPATCH_STATE_CORRUPT");
    // errorCode 残留（在恢复后的文件上叠加）。
    const raw2 = readRawDispatchState(dispatchFile());
    delete raw2.entries[0].deliveryId;
    raw2.entries[0].errorCode = "EXECUTOR_SEND_FAILED";
    fs.writeFileSync(dispatchFile(), `${JSON.stringify(raw2, null, 2)}\n`, "utf8");
    expectCode(() => readExecutorDispatchState(workspace.id, stateDir), "EXECUTOR_DISPATCH_STATE_CORRUPT");
  });

  it("T5: accepted entry 携带 outcomeReasonCode → STATE_CORRUPT（D 生命周期收紧）", async () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    const backend = fakeBackendForHardening();
    await orchestratedSendForHardening(a.binding.bindingId, "cmd-t5", backend);
    const raw = readRawDispatchState(dispatchFile());
    raw.entries[0].outcomeReasonCode = "interrupted_after_target_pin";
    fs.writeFileSync(dispatchFile(), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    expectCode(() => readExecutorDispatchState(workspace.id, stateDir), "EXECUTOR_DISPATCH_STATE_CORRUPT");
  });

  it("U: backend result 为 outcome_unknown 时 finalize 仍写入 bounded outcomeReasonCode，replay 幂等", async () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    const backend = fakeBackendForHardening({
      respond: request => ({
        commandId: request.commandId,
        pluginId: request.target.pluginId,
        bindingId: request.target.bindingId,
        sessionId: request.target.sessionId,
        deliveryStatus: "outcome_unknown",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        message: "backend uncertain",
      }),
    });
    const delivered = await orchestratedSendForHardening(a.binding.bindingId, "cmd-u", backend);
    expect(delivered).toMatchObject({ phase: "delivered", deliveryStatus: "outcome_unknown" });
    const stored = readExecutorDispatchEntry(workspace.id, "cmd-u", stateDir);
    expect(stored?.deliveryStatus).toBe("outcome_unknown");
    expect(stored?.outcomeReasonCode).toBe("send_failed");
    expect(stored?.terminalAt).toBeTruthy();
    // terminal replay（noWrite）不被新 schema 拒绝。
    const replay = begin({ bindingId: a.binding.bindingId, commandId: "cmd-u" });
    expect(replay.phase).toBe("replay");
    expect(replay.entry.deliveryStatus).toBe("outcome_unknown");
    expect(replay.target.bindingId).toBe(a.binding.bindingId);
  });

  // 复用主 describe 的编排/后端 fixture（以 workspace 闭包参数化）。
  function fakeBackendForHardening(options: {
    respond?: (request: ProductionSendRequest) => ProductionSendResult;
  } = {}): ExecutorProductionBackend {
    return {
      pluginId: "codex-desktop",
      async send(request) {
        if (options.respond) return options.respond(request);
        return {
          commandId: request.commandId,
          pluginId: request.target.pluginId,
          bindingId: request.target.bindingId,
          sessionId: request.target.sessionId,
          deliveryStatus: "accepted",
          deliveryId: `turn-${request.commandId}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          message: "accepted by fake backend",
        };
      },
    };
  }

  async function orchestratedSendForHardening(
    bindingId: string,
    commandId: string,
    backend: ExecutorProductionBackend,
  ): Promise<Record<string, unknown>> {
    const pinned = beginExecutorDispatch({
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      bindingId,
      commandId,
      intent: "development_plan",
      message: `task-${commandId}`,
      requestAuthoritySha256: hashRequestAuthority("planner-fp-r5e"),
      stateDir,
    });
    const { entry, target } = pinned;
    if (pinned.phase === "replay") {
      return { phase: "replay", deliveryStatus: entry.deliveryStatus, bindingId: target.bindingId };
    }
    const sent = await backend.send({
      workspace: { id: workspace.id, root: workspace.root } as never,
      plannerFingerprint: "planner-fp-r5e",
      commandId,
      intent: "development_plan",
      message: `task-${commandId}`,
      userConfirmed: true,
      clientId: "client-r5e",
      target,
      authorize: () => {},
    });
    const finalized = finalizeExecutorDispatch({
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      commandId,
      target,
      result: {
        deliveryStatus: sent.deliveryStatus,
        ...(sent.deliveryId !== undefined ? { deliveryId: sent.deliveryId } : {}),
        ...(sent.error !== undefined ? { errorCode: sent.error } : {}),
      },
      stateDir,
    });
    return { phase: "delivered", deliveryStatus: finalized.entry.deliveryStatus, bindingId: target.bindingId };
  }
});

// ---- R5E_AUTH_BEFORE_PIN：durable pin 之前的 live OAuth 重验证（真实 handler）----

describe("R5e auth-before-pin（R5E_AUTH_BEFORE_PIN，真实 executor_send handler）", () => {
  let stateDir: string;
  let wsRoot: string;
  let workspace: Workspace;

  beforeEach(() => {
    stateDir = isolateStateDir();
    wsRoot = makeTmpDir("r5e-auth-pin-ws");
    workspace = new Workspace(wsRoot);
  });

  afterEach(() => {
    cleanup(stateDir);
    cleanup(wsRoot);
  });

  function candidate(sessionId: string): ExecutorBindingCandidate {
    return {
      pluginId: "codex-desktop",
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      instanceId: "local",
      sessionId,
      locator: { executorProjectId: "proj-r5e" },
    };
  }

  type SendHandler = (
    a: unknown,
    e: unknown,
  ) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

  async function loadExecutorSendHandler(executorAuthorize: (auth: unknown) => void): Promise<SendHandler> {
    const { createMcpServer } = await import("../src/mcp/server.js");
    const server = createMcpServer({
      workspace,
      logger: { info() {}, error() {}, warn() {}, debug() {} } as never,
      executorAuthorize: executorAuthorize as never,
    });
    return (server as unknown as {
      _registeredTools: Record<string, { handler: SendHandler }>;
    })._registeredTools.executor_send.handler;
  }

  function sendInput(bindingId: string, commandId: string): Record<string, unknown> {
    return {
      workspaceId: workspace.id,
      bindingId,
      commandId,
      intent: "development_plan",
      userConfirmed: true,
      message: `task-${commandId}`,
    };
  }

  function sendExtra(): Record<string, unknown> {
    return {
      authInfo: { token: "tok-r5e", clientId: "client-r5e", scopes: ["codex.executor.control"] },
      _meta: { "openai/session": "sess-r5e-mcp" },
    };
  }

  it("V: pre-pin executorAuthorize 拒绝 → UNAUTHORIZED 且无 dispatch state/marker、binding 状态字节不变", async () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    const controlFile = executorControlFile(workspace.id);
    const controlBefore = fs.readFileSync(controlFile, "utf8");
    let authorizeCalls = 0;
    const handler = await loadExecutorSendHandler(() => {
      authorizeCalls += 1;
      throw new DesktopError("UNAUTHORIZED", "OAuth 授权已失效（pre-pin revoked）。");
    });
    const res = await handler(sendInput(a.binding.bindingId, "cmd-v"), sendExtra());
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text)).toMatchObject({ error: "UNAUTHORIZED" });
    expect(authorizeCalls).toBe(1);
    // 无 executor-dispatch state/marker 创建（pin 从未发生）。
    expect(fs.existsSync(executorDispatchFile(workspace.id, stateDir))).toBe(false);
    expect(fs.existsSync(executorDispatchInitializedFile(workspace.id, stateDir))).toBe(false);
    // executor-control binding 状态 byte-identical（无 binding/routing 变更）。
    expect(fs.readFileSync(controlFile, "utf8")).toBe(controlBefore);
  });

  it("W: 对照组——executorAuthorize 接受时同一 handler 确实创建 durable pin（测试判别力）", async () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    const handler = await loadExecutorSendHandler(() => {});
    const res = await handler(sendInput(a.binding.bindingId, "cmd-w"), sendExtra());
    // backend 在无 Desktop 状态时 fail fast（EXECUTOR_BINDING_STALE）→ outcome_unknown 收敛；
    // 但 durable pin 必须已发生（这正是 pre-pin 拒绝路径要避免的）。
    expect(JSON.parse(res.content[0].text)).toMatchObject({ error: "EXECUTOR_BINDING_STALE" });
    expect(fs.existsSync(executorDispatchFile(workspace.id, stateDir))).toBe(true);
    const stored = readExecutorDispatchEntry(workspace.id, "cmd-w", stateDir);
    expect(stored).not.toBeNull();
    expect(stored?.target.bindingId).toBe(a.binding.bindingId);
  });

  it("X: replay DTO 不暴露 dispatch ownerId（R5E_DISPATCH_OWNER 内部字段）", async () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-A"));
    const handler = await loadExecutorSendHandler(() => {});
    // 第一发：pin + backend fail fast → durable outcome_unknown。
    await handler(sendInput(a.binding.bindingId, "cmd-dto"), sendExtra());
    // 第二发：terminal replay → DTO 从 durable entry 合成。
    const res2 = await handler(sendInput(a.binding.bindingId, "cmd-dto"), sendExtra());
    expect(res2.isError).toBeFalsy();
    const parsed = JSON.parse(res2.content[0].text) as Record<string, unknown>;
    expect(parsed).toMatchObject({ commandId: "cmd-dto", deliveryStatus: "outcome_unknown" });
    expect(Object.keys(parsed)).not.toContain("ownerId");
    expect(res2.content[0].text).not.toContain(getProcessDispatchOwnerId());
  });
});

describe("R5e dispatch ledger lock ownership（真实 crash/restart 回归）", () => {
  /** 构造 crash 残留的 dispatch ledger 事务锁：pid 确证死亡的 JSON payload（stale gen-1）。 */
  function writeDeadOwnerLock(deadOwnerPid: number): string {
    const staleLock = `${executorDispatchFile(workspace.id, stateDir)}.lock.1`;
    fs.mkdirSync(path.dirname(staleLock), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      staleLock,
      `${JSON.stringify({ pid: deadOwnerPid, nonce: "0a0b0c0d-dead-4ead-8ead-000000dead01", createdAt: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );
    return staleLock;
  }

  /** 断言 dispatch ledger 锁目录无任何 generation 残留。 */
  function expectNoLockResidues(): void {
    const dir = path.dirname(executorDispatchFile(workspace.id, stateDir));
    const residues = fs.readdirSync(dir).filter((name) => /\.lock\.\d+$/.test(name));
    expect(residues).toEqual([]);
  }

  function exitedPid(): number {
    const exited = spawnSync(process.execPath, ["-e", ""], { windowsHide: true });
    expect(exited.status).toBe(0);
    return exited.pid!;
  }

  it("dead-owner stale dispatch lock 可恢复：restart 后 started 异 owner 收敛 outcome_unknown，无 backend 调用", async () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-lock"));
    // crash 前的 pin（异 owner）；crash 时 dispatch ledger 事务锁残留（pid 已死）。
    begin({ bindingId: a.binding.bindingId, commandId: "cmd-lock-recover", dispatchOwnerId: "owner-crashed" });
    const staleLock = writeDeadOwnerLock(exitedPid());
    // restart 后（异 owner）同 commandId：stale lock 被安全 reclaim，started 异 owner
    // → durable outcome_unknown(interrupted_after_target_pin)，绝不二次 send。
    const backend = fakeBackend();
    const replay = await orchestratedSend({
      bindingId: a.binding.bindingId,
      commandId: "cmd-lock-recover",
      backend,
      dispatchOwnerId: "owner-restart",
    });
    expect(replay).toMatchObject({ phase: "replay", deliveryStatus: "outcome_unknown" });
    expect(backend.calls()).toBe(0);
    const entry = readExecutorDispatchEntry(workspace.id, "cmd-lock-recover", stateDir);
    expect(entry?.deliveryStatus).toBe("outcome_unknown");
    expect(entry?.outcomeReasonCode).toBe("interrupted_after_target_pin");
    // reclaim 后正常 release：stale 锁已被清理，不阻塞后续工作。
    expect(fs.existsSync(staleLock)).toBe(false);
    expectNoLockResidues();
  });

  it("dead-owner stale dispatch lock 可恢复：restart 后新命令 reclaim 锁并正常 pin", () => {
    const a = bindCurrentExecutor(workspace.id, workspace.root, candidate("sess-lock2"));
    const staleLock = writeDeadOwnerLock(exitedPid());
    const pinned = begin({ bindingId: a.binding.bindingId, commandId: "cmd-lock-fresh" });
    expect(pinned.phase).toBe("pinned");
    // reclaim 后正常 release：stale 锁已被清理，不阻塞后续新工作。
    expect(fs.existsSync(staleLock)).toBe(false);
    expectNoLockResidues();
  });
});
