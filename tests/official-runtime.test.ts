import { EventEmitter } from "node:events";
import path from "node:path";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir } from "./helpers.js";
import { cleanupStrict } from "./strict-teardown.js";
import { Workspace } from "../src/workspace/manager.js";
import { cancelRemoteTask, enqueueTask, enqueueTargetSelection, isOfficialRemoteMode, readRemote, remoteFile, setRemoteEnabled, taskTargetForThread, updateRemote } from "../src/remote/store.js";
import { AppServerRpcError } from "../src/remote/app-server.js";
import { RemoteController } from "../src/remote/controller.js";
import { ResultBusError } from "../src/result-bus/store.js";
import { readExecutionOutput, readExecutionOutputMetadataStrict } from "../src/execution/output.js";
import { appendExecutionRecord, readExecutionRecords } from "../src/execution/records.js";
import { readResultBus } from "../src/result-bus/store.js";
import { resultBusResultDigest } from "../src/result-bus/official-result.js";
import { readFeedbackStatusState, writeState as writeFeedbackState } from "../src/feedback/state-store.js";

let root: string, stateDir: string, workspace: Workspace, oldStateDir: string | undefined;
beforeEach(() => {
  root = makeTmpDir("official-runtime-work"); stateDir = makeTmpDir("official-runtime-state");
  oldStateDir = process.env.C2C_STATE_DIR; process.env.C2C_STATE_DIR = stateDir; workspace = new Workspace(root);
});
afterEach(async () => {
  if (oldStateDir === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = oldStateDir;
  await cleanupStrict(root, stateDir);
});

function ready() {
  setRemoteEnabled(workspace, true, { deliveryMode: "official" });
  updateRemote(workspace.id, state => {
    state!.controller = { pid: 99999999, instanceId: "fixture", heartbeatAt: Date.now(), appServer: "running" };
    return { state: state!, result: undefined };
  });
}
function addTarget(threadId: string, clientId = "owner", source: "created" | "selected" = "created") {
  const targetId = threadId === "thread-1" ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222";
  updateRemote(workspace.id, state => {
    const target = { targetId, hostId: "local" as const, workspaceId: workspace.id, workspaceRoot: root, threadId,
      createdAt: new Date().toISOString(), source, clientId };
    (state!.targets ??= []).push(target);
    return { state: state!, result: undefined };
  });
  return targetId;
}
function taskInput(commandId: string, targetId: string, threadId: string, extra: Record<string, unknown> = {}) {
  return { workspaceId: workspace.id, targetId, threadId, commandId, kind: "ANALYZE" as const, goal: "检查指定目标", ...extra };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 6000;
  while (!check()) { if (Date.now() > deadline) throw new Error("timed out"); await new Promise(resolve => setTimeout(resolve, 20)); }
}

class FakeAppServer extends EventEmitter {
  calls: Array<{ method: string; params: any }> = [];
  autoComplete = false;
  resumeError: Error | undefined;
  selectedThreadId: string | undefined;
  async start() {}
  async close() { this.emit("close"); }
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === "config/read") return { config: {} };
    if (method === "thread/start") return { thread: { id: "created-thread", cwd: root } };
    if (method === "thread/read") return { thread: { id: this.selectedThreadId ?? params.threadId, cwd: root } };
    if (method === "thread/resume") {
      if (this.resumeError) throw this.resumeError;
      return { thread: { id: params.threadId, cwd: root } };
    }
    if (method === "turn/start") {
      const turnId = `turn-${params.threadId}`;
      if (this.autoComplete) setTimeout(() => this.emit("notification", { method: "turn/completed", params: {
        threadId: params.threadId, turn: { id: turnId, status: "completed" },
      } }), 10);
      return { turn: { id: turnId, status: "inProgress" } };
    }
    throw new Error(`unexpected method ${method}`);
  }
}

describe("official runtime target/store contracts", () => {
  it("读取旧 v1 不回写；显式旧 threadId submit 才在同 client completed created thread 上建 target", () => {
    const file = remoteFile(workspace.id, stateDir), now = new Date().toISOString();
    const old = { version: 1, workspaceId: workspace.id, workspaceRoot: root, enabled: true,
      threads: [{ workspaceId: workspace.id, requestId: "old-request", clientId: "client-a", status: "completed", threadId: "old-thread", createdAt: now, updatedAt: now }],
      tasks: [], controller: { pid: 99999999, instanceId: "old", heartbeatAt: Date.now(), appServer: "running" }, audit: [] };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(old));
    const before = fs.readFileSync(file, "utf8");
    expect(readRemote(workspace.id, stateDir)?.version).toBe(1);
    expect(readRemote(workspace.id, stateDir)?.targets).toBeUndefined();
    expect(readRemote(workspace.id, stateDir)?.deliveryMode).toBeUndefined();
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    const task = enqueueTask(workspace.id, { workspaceId: workspace.id, threadId: "old-thread", commandId: "legacy-submit", kind: "ANALYZE", goal: "继续同一线程" }, "client-a");
    expect(task.targetId).toMatch(/^[0-9a-f-]{36}$/);
    expect(readRemote(workspace.id, stateDir)!.targets).toMatchObject([{ hostId: "local", workspaceId: workspace.id, workspaceRoot: root, threadId: "old-thread", source: "created", clientId: "client-a" }]);
  });

  it("拒绝跨 workspace target、target/thread 冲突和其他 client 的 created target", () => {
    ready(); const targetId = addTarget("thread-1", "owner");
    expect(() => enqueueTask(workspace.id, taskInput("wrong-thread", targetId, "foreign-thread"), "owner")).toThrow("TARGET_THREAD_MISMATCH");
    expect(() => enqueueTask(workspace.id, taskInput("wrong-owner", targetId, "thread-1"), "other-client")).toThrow("TARGET_ACCESS_DENIED");
    const otherRoot = makeTmpDir("other-workspace");
    try {
      const other = new Workspace(otherRoot); setRemoteEnabled(other, true);
      updateRemote(other.id, state => {
        state!.targets = [{ ...readRemote(workspace.id)!.targets![0]!, workspaceId: workspace.id }];
        state!.controller = { pid: 99999999, instanceId: "other", heartbeatAt: Date.now(), appServer: "running" };
        return { state: state!, result: undefined };
      });
      expect(() => enqueueTask(other.id, { ...taskInput("cross-workspace", targetId, "thread-1"), workspaceId: other.id }, "owner")).toThrow("UNKNOWN_TARGET");
    } finally { fs.rmSync(otherRoot, { recursive: true, force: true }); }
  });

  it("本地显式选择只在 thread/read id 和 cwd 精确核验后登记；local grant 可供授权 MCP client 使用", async () => {
    ready();
    const selection = enqueueTargetSelection(workspace.id, { workspaceId: workspace.id, threadId: "selected-thread", requestId: "select-1" });
    const fake = new FakeAppServer();
    const controller = new RemoteController(workspace, fake as any);
    const running = controller.run();
    try {
      await until(() => readRemote(workspace.id)!.threads[0]!.status === "completed");
      const stored = readRemote(workspace.id)!;
      const target = stored.targets![0]!;
      expect(selection.source).toBe("selected");
      expect(target).toMatchObject({ hostId: "local", workspaceId: workspace.id, workspaceRoot: root, threadId: "selected-thread", source: "selected", clientId: "local" });
      expect(fake.calls.find(call => call.method === "thread/read")!.params).toEqual({ threadId: "selected-thread", includeTurns: false });
      const accepted = enqueueTask(workspace.id, taskInput("selected-task", target.targetId, "selected-thread"), "authorized-mcp-client");
      expect(accepted.targetId).toBe(target.targetId);
      controller.stop();
    } finally { controller.stop(); await running; }
  });

  it("thread/read 返回了其他 id 时不登记 selected target", async () => {
    ready(); enqueueTargetSelection(workspace.id, { workspaceId: workspace.id, threadId: "selected-thread", requestId: "select-bad" });
    const fake = new FakeAppServer(); fake.selectedThreadId = "different-thread";
    const controller = new RemoteController(workspace, fake as any), running = controller.run();
    try {
      await until(() => readRemote(workspace.id)!.threads[0]!.status === "needs_reconciliation");
      expect(readRemote(workspace.id)!.targets ?? []).toHaveLength(0);
      expect(fake.calls.some(call => call.method === "turn/start")).toBe(false);
    } finally { controller.stop(); await running; }
  });

  it("targetId 幂等提交比较完整字段，缺省 instructions 不能重放成同一任务", () => {
    ready(); const targetId = addTarget("thread-1", "owner");
    const original = enqueueTask(workspace.id, taskInput("same-command", targetId, "thread-1", { instructions: "保留这条要求" }), "owner");
    expect(enqueueTask(workspace.id, taskInput("same-command", targetId, "thread-1", { instructions: "保留这条要求" }), "owner").taskId).toBe(original.taskId);
    expect(() => enqueueTask(workspace.id, taskInput("same-command", targetId, "thread-1"), "owner")).toThrow("TASK_ALREADY_EXISTS");
  });

  it("撤权后仍可按 client 取消 queued task，重复取消幂等且官方模式不回退", () => {
    ready(); const targetId = addTarget("thread-1", "owner");
    const task = enqueueTask(workspace.id, taskInput("cancel-command", targetId, "thread-1"), "owner");
    setRemoteEnabled(workspace, false);
    expect(isOfficialRemoteMode(workspace.id)).toBe(true);
    expect(() => enqueueTask(workspace.id, taskInput("new-command", targetId, "thread-1"), "owner")).toThrow("REMOTE_CONTROL_DISABLED");
    expect(() => cancelRemoteTask(workspace.id, { taskId: task.taskId }, "other")).toThrow("TASK_ACCESS_DENIED");
    expect(cancelRemoteTask(workspace.id, { taskId: task.taskId }, "owner").status).toBe("cancelled");
    expect(cancelRemoteTask(workspace.id, { taskId: task.taskId }, "owner").status).toBe("cancelled");
  });

  it("existing execution commandId collision is rejected while identical remote task replay stays idempotent", () => {
    ready(); const targetId = addTarget("thread-1", "owner");
    const task = enqueueTask(workspace.id, taskInput("remote-replay", targetId, "thread-1"), "owner");
    expect(enqueueTask(workspace.id, taskInput("remote-replay", targetId, "thread-1"), "owner").taskId).toBe(task.taskId);
    appendExecutionRecord(workspace.id, { taskId: "legacy-task", commandId: "historical-command", iteration: 1,
      changedFiles: [], tests: null, exitStatus: "ok", timestamp: new Date().toISOString() });
    expect(() => enqueueTask(workspace.id, taskInput("historical-command", targetId, "thread-1"), "owner"))
      .toThrowError(expect.objectContaining({ code: "COMMAND_IDENTITY_CONFLICT" }));
  });

  it("legacy Feedback event commandId is treated as occupied", () => {
    ready(); const targetId = addTarget("thread-1", "owner");
    const state = readFeedbackStatusState(workspace.id);
    const now = new Date().toISOString();
    state.events = [{ version: 1, eventId: "abcdef0123456789abcdef0123456789", kind: "C2C_EXECUTED", workspaceId: workspace.id,
      source: "desktop", commandId: "old-feedback-command", taskId: "desktop_old-feedback-command", iteration: 1,
      result: "ok", changedFilesSummary: [], testsSummary: "", outputAvailable: false, occurredAt: now, createdAt: now, updatedAt: now,
      targetBindingId: null, targetEpoch: null, targetPrincipalFingerprint: null, status: "ready" }];
    writeFeedbackState(workspace.id, stateDir, state);
    expect(() => enqueueTask(workspace.id, taskInput("old-feedback-command", targetId, "thread-1"), "owner"))
      .toThrowError(expect.objectContaining({ code: "COMMAND_IDENTITY_CONFLICT" }));
  });
});

describe("official App Server controller", () => {
  it("active writer -32600 becomes REMOTE_THREAD_OWNED and never reaches turn/start", async () => {
    ready(); const targetId = addTarget("thread-1", "owner");
    const task = enqueueTask(workspace.id, taskInput("writer-conflict", targetId, "thread-1"), "owner");
    const fake = new FakeAppServer(); fake.resumeError = new AppServerRpcError("thread thread-1 already has an active writer", -32600);
    const controller = new RemoteController(workspace, fake as any), running = controller.run();
    try {
      await until(() => readRemote(workspace.id)!.tasks[0]!.status === "needs_reconciliation");
      expect(readRemote(workspace.id)!.tasks[0]).toMatchObject({ taskId: task.taskId, error: "REMOTE_THREAD_OWNED", targetId, threadId: "thread-1" });
      expect(fake.calls.some(call => call.method === "turn/start")).toBe(false);
    } finally { controller.stop(); await running; }
  });

  it("缺 thread/turn 与乱序旧 turn 不匹配活动 task；commentary 不覆盖 final_answer", async () => {
    ready(); const targetId = addTarget("thread-1", "owner");
    enqueueTask(workspace.id, taskInput("event-correlation", targetId, "thread-1"), "owner");
    const fake = new FakeAppServer(), controller = new RemoteController(workspace, fake as any), running = controller.run();
    try {
      await until(() => readRemote(workspace.id)!.tasks[0]!.status === "running");
      fake.emit("notification", { method: "item/completed", params: { turnId: "turn-thread-1", item: { type: "agentMessage", phase: "final_answer", text: "wrong thread" } } });
      fake.emit("notification", { method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", phase: "final_answer", text: "missing turn" } } });
      fake.emit("notification", { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "old-turn", status: "completed" } } });
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(readRemote(workspace.id)!.tasks[0]!.status).toBe("running");
      expect(readRemote(workspace.id)!.tasks[0]!.finalResponse).toBeUndefined();
      fake.emit("notification", { method: "item/completed", params: { threadId: "thread-1", turnId: "turn-thread-1",
        item: { type: "agentMessage", phase: "final_answer", text: "准确答案\napi_key=secret-value" } } });
      fake.emit("notification", { method: "item/completed", params: { threadId: "thread-1", turnId: "turn-thread-1",
        item: { type: "agentMessage", phase: "commentary", text: "COMMENTARY MUST NOT REPLACE FINAL" } } });
      fake.emit("notification", { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-thread-1", status: "completed",
        items: [{ type: "agentMessage", phase: "commentary", text: "later commentary" }] } } });
      await until(() => readRemote(workspace.id)!.tasks[0]!.status === "completed");
      const finalResponse = readRemote(workspace.id)!.tasks[0]!.finalResponse!;
      expect(finalResponse.text).toContain("准确答案");
      expect(finalResponse.text).toContain("[REDACTED]");
      expect(finalResponse.text).not.toContain("secret-value");
      expect(finalResponse.text).not.toContain("COMMENTARY");
    } finally { controller.stop(); await running; }
  });

  it("unphased agentMessage is accepted only from terminal items; explicit commentary remains excluded", async () => {
    ready(); const targetId = addTarget("thread-1", "owner");
    enqueueTask(workspace.id, taskInput("terminal-items", targetId, "thread-1"), "owner");
    const fake = new FakeAppServer(), controller = new RemoteController(workspace, fake as any), running = controller.run();
    try {
      await until(() => readRemote(workspace.id)!.tasks[0]!.status === "running");
      fake.emit("notification", { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-thread-1", status: "completed",
        items: [{ type: "agentMessage", phase: "commentary", text: "not final" }, { type: "agentMessage", text: "terminal final" }] } } });
      await until(() => readRemote(workspace.id)!.tasks[0]!.status === "completed");
      expect(readRemote(workspace.id)!.tasks[0]!.finalResponse?.text).toBe("terminal final");
    } finally { controller.stop(); await running; }
  });

  it("投影中断并确认关闭后重启从 task 持久正文投影一次，不重复 execution record/output", async () => {
    ready(); const targetId = addTarget("thread-1", "owner");
    const task = enqueueTask(workspace.id, taskInput("restart-project", targetId, "thread-1"), "owner");
    const fake = new FakeAppServer(), failed = new RemoteController(workspace, fake as any, { projectResult: () => { throw new Error("projection interrupted"); } });
    const firstRun = failed.run();
    await until(() => readRemote(workspace.id)!.tasks[0]!.status === "running");
    fake.emit("notification", { method: "item/completed", params: { threadId: "thread-1", turnId: "turn-thread-1",
      item: { type: "agentMessage", phase: "final_answer", text: "durable final body" } } });
    fake.emit("notification", { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-thread-1", status: "completed" } } });
    await expect(firstRun).rejects.toThrow("projection interrupted");
    let saved = readRemote(workspace.id)!.tasks[0]!;
    expect(saved).toMatchObject({ finalResponse: { text: "durable final body", truncated: false }, recorded: true });
    expect(saved.resultProjected).toBeUndefined();
    expect(readExecutionRecords(workspace.id, 100).filter(item => item.taskId === task.taskId)).toHaveLength(1);
    expect(readExecutionOutputMetadataStrict(workspace.id).filter(item => item.taskId === task.taskId)).toHaveLength(1);
    expect(readRemote(workspace.id)!.controller).toBeUndefined();
    let attempts = 0;
    const restarted = new RemoteController(workspace, new FakeAppServer() as any, { projectResult: (_workspace, projected) => {
      attempts++; expect(projected.finalResponse?.text).toBe("durable final body");
    } });
    const running = restarted.run();
    try {
      await until(() => readRemote(workspace.id)!.tasks[0]!.resultProjected === true);
      saved = readRemote(workspace.id)!.tasks[0]!;
      expect(saved.outputId).toBeTypeOf("number");
      expect(attempts).toBe(1);
      expect(readExecutionRecords(workspace.id, 100).filter(item => item.taskId === task.taskId)).toHaveLength(1);
      expect(readExecutionOutputMetadataStrict(workspace.id).filter(item => item.taskId === task.taskId)).toHaveLength(1);
      expect(readExecutionOutput(workspace.id, saved.outputId!)).toMatchObject({ ok: true, text: "durable final body" });
    } finally { restarted.stop(); await running; }
  });

  it("Result Bus busy 只延后当前 target 的投影，不退出 Controller", async () => {
    ready(); const targetId = addTarget("thread-1", "owner");
    enqueueTask(workspace.id, taskInput("bus-busy", targetId, "thread-1"), "owner");
    const fake = new FakeAppServer(), busy = new ResultBusError("RESULT_BUS_BUSY", "fixture lock");
    let attempts = 0;
    const controller = new RemoteController(workspace, fake as any, { projectResult: () => { if (++attempts === 1) throw busy; } });
    const running = controller.run();
    try {
      await until(() => readRemote(workspace.id)!.tasks[0]!.status === "running");
      fake.emit("notification", { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-thread-1", status: "completed" } } });
      await until(() => readRemote(workspace.id)!.tasks[0]!.resultProjected === true);
      expect(attempts).toBe(2);
      expect(readRemote(workspace.id)!.controller?.appServer).toBe("running");
    } finally { controller.stop(); await running; }
  });

  it("needs_reconciliation 只阻止同一 thread，其他明确 target 可以排队执行", async () => {
    ready(); const firstTarget = addTarget("thread-1", "owner"); const secondTarget = addTarget("thread-2", "owner");
    enqueueTask(workspace.id, taskInput("unknown-one", firstTarget, "thread-1"), "owner");
    enqueueTask(workspace.id, taskInput("independent-two", secondTarget, "thread-2"), "owner");
    updateRemote(workspace.id, state => { state!.tasks[0]!.status = "needs_reconciliation"; state!.tasks[0]!.error = "TURN_START_OUTCOME_UNKNOWN"; return { state: state!, result: undefined }; });
    const fake = new FakeAppServer(), controller = new RemoteController(workspace, fake as any), running = controller.run();
    try {
      await until(() => readRemote(workspace.id)!.tasks[1]!.status === "running");
      expect(readRemote(workspace.id)!.tasks[0]!.status).toBe("needs_reconciliation");
      expect(fake.calls.filter(call => call.method === "turn/start").map(call => call.params.threadId)).toEqual(["thread-2"]);
    } finally { controller.stop(); await running; }
  });

  it("派发期 commandId 历史碰撞只隔离该任务，其他 target 继续；不把无 turn 的行政 cancelled 投影", async () => {
    ready(); const firstTarget = addTarget("thread-1", "owner"); const secondTarget = addTarget("thread-2", "owner");
    enqueueTask(workspace.id, taskInput("late-collision", firstTarget, "thread-1"), "owner");
    enqueueTask(workspace.id, taskInput("safe-independent", secondTarget, "thread-2"), "owner");
    appendExecutionRecord(workspace.id, { taskId: "legacy-task", commandId: "late-collision", iteration: 1,
      changedFiles: [], tests: null, exitStatus: "ok", timestamp: new Date().toISOString() });
    const fake = new FakeAppServer(), controller = new RemoteController(workspace, fake as any), running = controller.run();
    try {
      await until(() => readRemote(workspace.id)!.tasks[1]!.status === "running");
      expect(readRemote(workspace.id)!.tasks[0]).toMatchObject({ status: "needs_reconciliation", error: "COMMAND_IDENTITY_CONFLICT" });
      expect(fake.calls.filter(call => call.method === "turn/start").map(call => call.params.threadId)).toEqual(["thread-2"]);
      updateRemote(workspace.id, state => {
        const task = state!.tasks[1]!; task.status = "cancelled"; task.turnId = "turn-thread-2"; delete task.completedAt;
        return { state: state!, result: undefined };
      });
    } finally { controller.stop(); await running; }

    expect(readRemote(workspace.id)!.controller).toBeUndefined();
    const restartedFake = new FakeAppServer(), restarted = new RemoteController(workspace, restartedFake as any), restartRun = restarted.run();
    try {
      await until(() => readRemote(workspace.id)!.controller?.appServer === "running");
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(readRemote(workspace.id)!.tasks[1]).toMatchObject({ status: "cancelled", turnId: "turn-thread-2" });
      expect(readRemote(workspace.id)!.tasks[1]!.completedAt).toBeUndefined();
      expect(readRemote(workspace.id)!.tasks[1]!.resultProjected).toBeUndefined();
      expect(readResultBus({ id: workspace.id, root })?.entries ?? []).toHaveLength(0);
      expect(restartedFake.calls.some(call => call.method === "turn/start")).toBe(false);
    } finally { restarted.stop(); await restartRun; }
  });

  it("默认 ResultBus hook 持久精确终态；controller restart 不重复 turn 或改变 digest", async () => {
    ready(); const targetId = addTarget("thread-1", "owner");
    const task = enqueueTask(workspace.id, taskInput("default-project", targetId, "thread-1"), "owner");
    const fake = new FakeAppServer(), controller = new RemoteController(workspace, fake as any), running = controller.run();
    try {
      await until(() => readRemote(workspace.id)!.tasks[0]!.status === "running");
      fake.emit("notification", { method: "item/completed", params: { threadId: "thread-1", turnId: "turn-thread-1",
        item: { type: "agentMessage", phase: "final_answer", text: "official final body" } } });
      fake.emit("notification", { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-thread-1", status: "completed" } } });
      await until(() => readRemote(workspace.id)!.tasks[0]!.resultProjected === true);
      const saved = readRemote(workspace.id)!.tasks[0]!;
      expect(saved).toMatchObject({ taskId: task.taskId, targetId, threadId: "thread-1", turnId: "turn-thread-1",
        status: "completed", finalResponse: { text: "official final body" }, recorded: true, outputAvailable: true });
      expect(readExecutionRecords(workspace.id, 100).filter(item => item.taskId === task.taskId)).toHaveLength(1);
      expect(readExecutionOutput(workspace.id, saved.outputId!)).toMatchObject({ ok: true, text: "official final body" });
      const entry = readResultBus({ id: workspace.id, root })!.entries[0]!;
      expect(entry.result).toMatchObject({ commandId: task.commandId, iteration: 1, resultId: task.taskId, status: "completed",
        machineEvidence: { source: "codex_app_server", targetId, taskId: task.taskId, threadId: "thread-1", turnId: "turn-thread-1", status: "completed" } });
      expect(entry.resultSha256).toBe(resultBusResultDigest(entry.result as any));
      controller.stop(); await running;

      expect(readRemote(workspace.id)!.controller).toBeUndefined();
      const restartedFake = new FakeAppServer(), restarted = new RemoteController(workspace, restartedFake as any), restartRun = restarted.run();
      try {
        await until(() => readRemote(workspace.id)!.controller?.appServer === "running");
        await new Promise(resolve => setTimeout(resolve, 250));
        expect(restartedFake.calls.some(call => call.method === "turn/start")).toBe(false);
        expect(readResultBus({ id: workspace.id, root })!.entries).toEqual([entry]);
        expect(readResultBus({ id: workspace.id, root })!.entries[0]!.resultSha256).toBe(entry.resultSha256);
      } finally { restarted.stop(); await restartRun; }
    } catch (error) {
      controller.stop(); await running; throw error;
    }
  });
});
