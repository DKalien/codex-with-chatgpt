import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { desktopIpc } from "../src/desktop/ipc.js";
import { bindCurrentDesktop, bindDesktop, desktopStatus, enableDesktop, sendDesktop } from "../src/desktop/service.js";
import {
  CODEX_DESKTOP_EXECUTOR_ID,
  codexDesktopAdapter,
  createExecutorRegistry,
  type ExecutorAdapter,
} from "../src/executor/index.js";
import { DesktopError, readDesktop, updateDesktop } from "../src/desktop/store.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const workspace = { id: "executor_core_test", root: process.cwd() };
const target = { threadId: "01a00000-0000-7000-8000-000000000011", hostId: "local" as const, projectId: "executor_project" };
const info = { ...target, workspaceRoot: workspace.root, title: "Executor Core 测试会话" };
let stateDirectory: string;

afterEach(() => {
  vi.restoreAllMocks();
  cleanup(stateDirectory);
});

function fakeAdapter(overrides: Partial<ExecutorAdapter> = {}): ExecutorAdapter {
  return {
    descriptor: codexDesktopAdapter.descriptor,
    inspect: vi.fn().mockResolvedValue(info),
    currentIdentity: vi.fn().mockResolvedValue(info),
    confirmCurrent: vi.fn().mockResolvedValue(info),
    prepare: vi.fn(),
    inspectActiveExecution: vi.fn().mockResolvedValue({ ...info, activeTurnId: randomUUID() }),
    ...overrides,
  };
}

it("registry 只注册 Codex Desktop，并对未知 executor fail closed", () => {
  const registry = createExecutorRegistry();
  expect(registry.list().map(item => item.id)).toEqual([CODEX_DESKTOP_EXECUTOR_ID]);
  expect(registry.get(CODEX_DESKTOP_EXECUTOR_ID)).toBe(codexDesktopAdapter);
  expect(() => registry.get("claude-code")).toThrow("Unknown executor");
});

it("Codex Desktop capabilities 是有限描述，不宣称创建会话或取消支持", () => {
  expect(codexDesktopAdapter.descriptor).toEqual({
    id: "codex-desktop",
    kind: "codex-desktop",
    name: "Codex Desktop",
    capabilities: {
      existingSessionBinding: true,
      createSession: false,
      delivery: true,
      busyActiveInspection: true,
      approvalVisibility: true,
      trustedTerminalReceipt: true,
      cancellationInterrupt: false,
    },
  });
});

it("CodexDesktopAdapter 只委托现有 desktopIpc，不复制协议逻辑", async () => {
  const connection = { send: vi.fn(), close: vi.fn() };
  const inspect = vi.spyOn(desktopIpc, "inspect").mockResolvedValue(info as never);
  const currentIdentity = vi.spyOn(desktopIpc, "currentIdentity").mockResolvedValue(info as never);
  const confirmCurrent = vi.spyOn(desktopIpc, "confirmCurrent").mockResolvedValue(info as never);
  const prepare = vi.spyOn(desktopIpc, "prepare").mockResolvedValue(connection as never);
  const inspectActiveExecution = vi.spyOn(desktopIpc, "inspectActiveExecution")
    .mockResolvedValue({ ...info, activeTurnId: randomUUID() } as never);

  await expect(codexDesktopAdapter.inspect({ ...target, workspaceRoot: workspace.root })).resolves.toMatchObject(info);
  await expect(codexDesktopAdapter.currentIdentity(workspace.root)).resolves.toMatchObject(info);
  await expect(codexDesktopAdapter.confirmCurrent(workspace.root)).resolves.toMatchObject(info);
  await expect(codexDesktopAdapter.prepare({ ...target, workspaceRoot: workspace.root })).resolves.toBe(connection);
  await expect(codexDesktopAdapter.inspectActiveExecution({ ...target, workspaceRoot: workspace.root }))
    .resolves.toMatchObject({ activeTurnId: expect.any(String) });
  expect(inspect).toHaveBeenCalledOnce();
  expect(currentIdentity).toHaveBeenCalledOnce();
  expect(confirmCurrent).toHaveBeenCalledOnce();
  expect(prepare).toHaveBeenCalledOnce();
  expect(inspectActiveExecution).toHaveBeenCalledOnce();
});

it("Desktop service 通过注入的 adapter 保持绑定、确认、status 与 prepare/send 语义", async () => {
  stateDirectory = isolateStateDir();
  const connection = {
    send: vi.fn().mockResolvedValue({ threadId: target.threadId, turnId: randomUUID() }),
    close: vi.fn(),
  };
  const adapter = fakeAdapter({ prepare: vi.fn().mockResolvedValue(connection) });

  const first = await bindDesktop(workspace, target, adapter);
  expect(first).toMatchObject({ threadId: target.threadId, title: info.title });
  const current = await bindCurrentDesktop(workspace, adapter);
  expect(current).toMatchObject({ enabled: true, binding: { bindingId: first.bindingId } });
  const status = await desktopStatus(workspace, undefined, adapter);
  expect(status).toMatchObject({ enabled: true, availability: { available: true } });

  const delivery = await sendDesktop(workspace, {
    workspaceId: workspace.id,
    bindingId: current.binding.bindingId,
    commandId: "adapter-send-1",
    intent: "development_plan",
    userConfirmed: true,
    message: "已确认的测试计划",
  }, "test-client", undefined, undefined, adapter);
  expect(delivery).toMatchObject({ deliveryStatus: "accepted", threadId: target.threadId });
  expect(adapter.prepare).toHaveBeenCalledOnce();
  expect(connection.send).toHaveBeenCalledOnce();
  expect(connection.close).toHaveBeenCalledOnce();
});

it("capability 元数据不会绕过 service 的启用门禁", async () => {
  stateDirectory = isolateStateDir();
  const adapter = fakeAdapter({
    descriptor: {
      ...codexDesktopAdapter.descriptor,
      capabilities: {
        existingSessionBinding: true,
        createSession: true,
        delivery: true,
        busyActiveInspection: true,
        approvalVisibility: true,
        trustedTerminalReceipt: true,
        cancellationInterrupt: true,
      },
    },
  });
  await expect(sendDesktop(workspace, {
    workspaceId: workspace.id,
    bindingId: randomUUID(),
    commandId: "metadata-must-not-authorize",
    intent: "revision",
    userConfirmed: true,
    message: "不应发送",
  }, "test-client", undefined, undefined, adapter)).rejects.toMatchObject({
    code: "DESKTOP_DISABLED",
  } satisfies Partial<DesktopError>);
  expect(adapter.prepare).not.toHaveBeenCalled();
});

it("注入 adapter 的 accepted exact replay 返回原记录且不重复 prepare/send，冲突 commandId 仍拒绝", async () => {
  stateDirectory = isolateStateDir();
  const send = vi.fn().mockResolvedValue({ threadId: target.threadId, turnId: randomUUID() });
  const close = vi.fn();
  const adapter = fakeAdapter({ prepare: vi.fn().mockResolvedValue({ send, close }) });
  const binding = await bindDesktop(workspace, target, adapter);
  enableDesktop(workspace, binding.bindingId);
  const request = {
    workspaceId: workspace.id, bindingId: binding.bindingId, commandId: "executor-replay",
    intent: "development_plan" as const, userConfirmed: true as const, message: "注入式 replay 测试",
  };

  const first = await sendDesktop(workspace, request, "executor-client", undefined, undefined, adapter);
  await expect(sendDesktop(workspace, request, "executor-client", undefined, undefined, adapter)).resolves.toEqual(first);
  await expect(sendDesktop(workspace, { ...request, message: "冲突正文" }, "executor-client", undefined, undefined, adapter))
    .rejects.toMatchObject({ code: "DESKTOP_COMMAND_CONFLICT" });
  expect(first.deliveryStatus).toBe("accepted");
  expect(adapter.prepare).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

it("注入 adapter 的 DESKTOP_BUSY receipt-backed tail 先 inspectActiveExecution 再有界重试，并保留授权、replay、unknown 门禁", async () => {
  stateDirectory = isolateStateDir();
  const activeTurnId = randomUUID();
  const tailCommandId = "executor-tail";
  const timestamp = new Date().toISOString();
  const connection = {
    send: vi.fn().mockResolvedValue({ threadId: target.threadId, turnId: randomUUID() }),
    close: vi.fn(),
  };
  const events: string[] = [];
  const prepare = vi.fn()
    .mockImplementationOnce(async () => { events.push("prepare"); throw new DesktopError("DESKTOP_BUSY", "busy"); })
    .mockImplementationOnce(async () => { events.push("prepare"); return connection; });
  const inspectActiveExecution = vi.fn().mockImplementation(async () => {
    events.push("inspectActiveExecution");
    return { ...info, activeTurnId };
  });
  const adapter = fakeAdapter({ prepare, inspectActiveExecution });
  const binding = await bindDesktop(workspace, target, adapter);
  enableDesktop(workspace, binding.bindingId);
  updateDesktop(workspace.id, state => {
    if (!state) throw new Error("Desktop state missing");
    state.deliveries.push({
      commandId: tailCommandId, clientId: "tail-client", bindingId: binding.bindingId, threadId: target.threadId,
      intent: "development_plan", messageSha256: "a".repeat(64), messageBytes: 1,
      deliveryStatus: "accepted", turnId: activeTurnId, createdAt: timestamp, updatedAt: timestamp,
    });
    return { state, result: undefined };
  });
  const recordsDir = path.join(stateDirectory, "executions");
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.writeFileSync(path.join(recordsDir, `${workspace.id}.jsonl`), JSON.stringify({
    taskId: `desktop_${tailCommandId}`, iteration: 1, changedFiles: [], tests: "not run", exitStatus: "ok",
    timestamp, commandId: tailCommandId, desktopReceiptSha256: "b".repeat(64),
  }) + "\n");

  const authorize = vi.fn();
  const request = {
    workspaceId: workspace.id, bindingId: binding.bindingId, commandId: "executor-after-tail",
    intent: "development_plan" as const, userConfirmed: true as const, message: "tail settle 测试",
  };
  const result = await sendDesktop(workspace, request, "executor-client", authorize, {
    timeoutMs: 100, pollMs: 1, sleep: async () => {}, now: () => 0,
  }, adapter);

  expect(result.deliveryStatus).toBe("accepted");
  expect(events).toEqual(["prepare", "inspectActiveExecution", "prepare"]);
  expect(authorize).toHaveBeenCalledTimes(3);
  expect(inspectActiveExecution).toHaveBeenCalledOnce();
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(connection.send).toHaveBeenCalledOnce();
  await expect(sendDesktop(workspace, request, "executor-client", undefined, undefined, adapter)).resolves.toEqual(result);
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(connection.send).toHaveBeenCalledOnce();

  updateDesktop(workspace.id, state => {
    if (!state) throw new Error("Desktop state missing");
    state.deliveries.push({
      commandId: "executor-unknown", clientId: "tail-client", bindingId: binding.bindingId, threadId: target.threadId,
      intent: "development_plan", messageSha256: "c".repeat(64), messageBytes: 1,
      deliveryStatus: "outcome_unknown", createdAt: timestamp, updatedAt: timestamp,
    });
    return { state, result: undefined };
  });
  await expect(sendDesktop(workspace, {
    ...request, commandId: "executor-after-unknown",
  }, "executor-client", undefined, undefined, adapter)).rejects.toMatchObject({ code: "DESKTOP_OUTCOME_UNRESOLVED" });
  expect(readDesktop(workspace.id)?.deliveries.find(item => item.commandId === "executor-after-unknown")).toBeUndefined();
  expect(prepare).toHaveBeenCalledTimes(2);
});

it("注入 adapter 的 ambiguous send 保持 outcome_unknown，同 commandId 不重发", async () => {
  stateDirectory = isolateStateDir();
  const send = vi.fn().mockRejectedValue(new Error("ambiguous send"));
  const close = vi.fn();
  const adapter = fakeAdapter({
    descriptor: {
      ...codexDesktopAdapter.descriptor,
      capabilities: {
        existingSessionBinding: true,
        createSession: true,
        delivery: true,
        busyActiveInspection: true,
        approvalVisibility: true,
        trustedTerminalReceipt: true,
        cancellationInterrupt: true,
      },
    },
    prepare: vi.fn().mockResolvedValue({ send, close }),
  });
  const binding = await bindDesktop(workspace, target, adapter);
  enableDesktop(workspace, binding.bindingId);
  const request = {
    workspaceId: workspace.id, bindingId: binding.bindingId, commandId: "executor-ambiguous",
    intent: "revision" as const, userConfirmed: true as const, message: "ambiguous send 测试",
  };

  const first = await sendDesktop(workspace, request, "executor-client", undefined, undefined, adapter);
  const replay = await sendDesktop(workspace, request, "executor-client", undefined, undefined, adapter);
  expect(first.deliveryStatus).toBe("outcome_unknown");
  expect(replay).toEqual(first);
  expect(readDesktop(workspace.id)?.deliveries).toMatchObject([{ commandId: request.commandId, deliveryStatus: "outcome_unknown" }]);
  expect(adapter.prepare).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
