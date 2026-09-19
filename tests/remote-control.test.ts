import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { cleanup, makeTmpDir } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";
import { getStateDir } from "../src/config/paths.js";
import { startBridge } from "../src/bridge/server.js";
import { enqueueTask, enqueueThread, publicTask, readRemote, remoteFile, setRemoteEnabled, updateRemote } from "../src/remote/store.js";
import { RemoteController, recoverRemote } from "../src/remote/controller.js";
import type { AppServerClient } from "../src/remote/app-server.js";
import { readExecutionOutput } from "../src/execution/output.js";
import { readExecutionRecords } from "../src/execution/records.js";
import { AuthStore, filterScopes, SUPPORTED_SCOPES } from "../src/auth/store.js";
import { remoteStatus, registerRemoteCommands } from "../src/cli/remote.js";
import { Command } from "commander";

let root: string, stateDir: string, workspace: Workspace;
let oldState: string | undefined;
beforeEach(() => {
  root = makeTmpDir("remote-work"); stateDir = makeTmpDir("remote-state");
  oldState = process.env.C2C_STATE_DIR; process.env.C2C_STATE_DIR = stateDir;
  workspace = new Workspace(root);
});
afterEach(() => {
  if (oldState === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = oldState;
  cleanup(root, stateDir);
});
function ready() {
  setRemoteEnabled(workspace, true);
  updateRemote(workspace.id, state => {
    state!.controller = { pid: 99999999, instanceId: "test", heartbeatAt: Date.now(), appServer: "running" };
    return { state: state!, result: undefined };
  });
}
function thread() {
  const t = enqueueThread(workspace.id, { workspaceId: workspace.id, requestId: "req" }, "client");
  updateRemote(workspace.id, state => {
    state!.threads[0].threadId = "thread-1"; state!.threads[0].status = "completed";
    return { state: state!, result: undefined };
  });
  return t;
}
const input = () => ({ workspaceId: workspace.id, threadId: "thread-1", commandId: "cmd", kind: "ANALYZE" as const, goal: "检查 README，不修改文件" });
async function until(check: () => boolean) {
  const deadline = Date.now() + 6000;
  while (!check()) { if (Date.now() > deadline) throw new Error("timed out"); await new Promise(r => setTimeout(r, 20)); }
}
class Fake extends EventEmitter {
  calls: { method: string; params: any }[] = [];
  outcome = "completed";
  autoComplete = true;
  async start() {}
  async close() { this.emit("close"); }
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === "config/read") return { config: {} };
    if (method === "thread/start" || method === "thread/resume") return { thread: { id: "thread-1", cwd: root } };
    if (this.autoComplete) setTimeout(() => this.emit("notification", { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: this.outcome } } }), 20);
    return { turn: { id: "turn-1", status: "inProgress" } };
  }
}
describe("远程持久化边界", () => {
  it("新增 scopes 必须显式授权，旧 refresh token 不升级", () => {
    expect(filterScopes(undefined)).toEqual([...SUPPORTED_SCOPES]);
    expect(filterScopes("codex.control codex.read")).toEqual(["codex.control", "codex.read"]);
    const auth = new AuthStore(workspace.id);
    const tokens = auth.issueTokens({ clientId: "client", scopes: [...SUPPORTED_SCOPES] });
    const refreshed = auth.refresh(tokens.refreshToken, "client");
    expect(refreshed.ok).toBe(true);
    if (refreshed.ok) expect(refreshed.tokens.scopes).toEqual([...SUPPORTED_SCOPES]);
  });
  it("默认关闭，无状态读取不创建目录；离线禁止接单", () => {
    expect(readRemote(workspace.id)).toBeNull();
    expect(fs.existsSync(path.dirname(remoteFile(workspace.id)))).toBe(false);
    expect(() => enqueueThread(workspace.id, { workspaceId: workspace.id, requestId: "r" }, "c")).toThrow("REMOTE_CONTROL_DISABLED");
    setRemoteEnabled(workspace, true);
    expect(() => enqueueThread(workspace.id, { workspaceId: workspace.id, requestId: "r" }, "c")).toThrow("CONTROLLER_OFFLINE");
  });
  it("初始化中的 Controller 不伪报 running 或启动成功", async () => {
    ready();
    updateRemote(workspace.id, s => { s!.controller!.appServer = "starting"; return { state: s!, result: undefined }; });
    expect(remoteStatus(workspace.id).controller).toBe("starting");
    const program = new Command(); registerRemoteCommands(program);
    await expect(program.parseAsync(["node", "c2c", "controller", "start", "-w", root, "--json"])).rejects.toThrow("Controller 仍在初始化");
  });
  it("requestId/commandId 持久幂等且不同参数冲突，不接受任意路径或线程", () => {
    ready(); thread();
    expect(enqueueThread(workspace.id, { workspaceId: workspace.id, requestId: "req" }, "client").threadId).toBe("thread-1");
    expect(() => enqueueThread(workspace.id, { workspaceId: workspace.id, requestId: "req", purpose: "different" }, "client")).toThrow("REQUEST_ALREADY_EXISTS");
    const task = enqueueTask(workspace.id, input(), "client");
    expect(enqueueTask(workspace.id, input(), "client").taskId).toBe(task.taskId);
    expect(readRemote(workspace.id)!.tasks).toHaveLength(1);
    expect(() => enqueueTask(workspace.id, { ...input(), goal: "different" }, "client")).toThrow("TASK_ALREADY_EXISTS");
    expect(() => enqueueTask(workspace.id, { ...input(), workspaceId: "wrong" }, "client")).toThrow("UNKNOWN_WORKSPACE");
    expect(() => enqueueTask(workspace.id, { ...input(), commandId: "c2", threadId: "foreign" }, "client")).toThrow("UNKNOWN_THREAD");
    expect(() => enqueueTask(workspace.id, { ...input(), cwd: "C:\\" } as any, "client")).toThrow();
    expect(JSON.stringify(publicTask(task))).not.toContain(task.goal);
    expect(JSON.stringify(readRemote(workspace.id)!.audit)).not.toContain(task.goal);
  });
  it("损坏/锁失败关闭并保留原数据", () => {
    ready(); const file = remoteFile(workspace.id); const original = fs.readFileSync(file, "utf8");
    fs.writeFileSync(`${file}.lock`, '{"pid":99999999}');
    expect(() => setRemoteEnabled(workspace, false)).toThrow("状态写锁");
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    fs.unlinkSync(`${file}.lock`); fs.writeFileSync(file, "broken");
    expect(() => setRemoteEnabled(workspace, true)).toThrow("远程控制状态损坏");
    expect(fs.readFileSync(file, "utf8")).toBe("broken");
  });
  it("撤销本地授权禁止写入，队列与历史保留", () => {
    ready(); thread(); enqueueTask(workspace.id, input(), "client"); setRemoteEnabled(workspace, false);
    expect(() => enqueueTask(workspace.id, input(), "client")).toThrow("REMOTE_CONTROL_DISABLED");
    expect(readRemote(workspace.id)!.tasks[0].status).toBe("queued");
  });
  it("恢复保留 queued，已开始标待核对，拒绝淘汰历史以腾出队列", () => {
    ready(); thread(); enqueueTask(workspace.id, input(), "client");
    const s = readRemote(workspace.id)!; recoverRemote(s); expect(s.tasks[0].status).toBe("queued");
    s.tasks[0].status = "running"; recoverRemote(s); expect(s.tasks[0].status).toBe("needs_reconciliation");
    for (let i=1;i<100;i++) enqueueTask(workspace.id, { ...input(), commandId: `c${i}` }, "client");
    expect(() => enqueueTask(workspace.id, { ...input(), commandId: "overflow" }, "client")).toThrow("TASK_QUEUE_FULL");
    expect(readRemote(workspace.id)!.tasks).toHaveLength(100);
  });
});
describe("Controller 状态机", () => {
  it("配置读取失败不报告 running，不消费任何请求", async () => {
    ready();
    const fake = new Fake();
    fake.request = async () => { throw new Error("configuration unavailable"); };
    await expect(new RemoteController(workspace, fake as unknown as AppServerClient).run()).rejects.toThrow("Codex 无法加载本机配置");
    expect(readRemote(workspace.id)!.controller).toMatchObject({ appServer: "offline", error: "CODEX_CONFIG_UNAVAILABLE" });
  });
  it("另一个仍存活的 Controller 不可抢占，即使心跳过期", async () => {
    ready();
    updateRemote(workspace.id, s => { s!.controller!.pid = process.pid; s!.controller!.heartbeatAt = 0; return { state: s!, result: undefined }; });
    const fake = new Fake();
    await expect(new RemoteController(workspace, fake as unknown as AppServerClient).run()).rejects.toThrow("Controller PID");
    expect(fake.calls).toHaveLength(0);
  });
  it("创建请求响应丢失保留 requestId，不会再次调用 thread/start", async () => {
    ready(); enqueueThread(workspace.id, { workspaceId: workspace.id, requestId: "req" }, "client");
    const fake = new Fake();
    fake.request = async (method, params) => { fake.calls.push({ method, params }); if (method === "config/read") return { config: {} }; throw new Error("lost response"); };
    const controller = new RemoteController(workspace, fake as unknown as AppServerClient), running = controller.run();
    try {
      await until(() => readRemote(workspace.id)!.threads[0].status === "needs_reconciliation");
      expect(enqueueThread(workspace.id, { workspaceId: workspace.id, requestId: "req" }, "client").status).toBe("needs_reconciliation");
      expect(fake.calls.filter(c => c.method === "thread/start")).toHaveLength(1);
    } finally { controller.stop(); await running; }
  });
  it("恢复线程期间本地撤权不会再派发 turn", async () => {
    ready(); thread(); enqueueTask(workspace.id, input(), "client");
    const fake = new Fake(), original = fake.request.bind(fake);
    fake.request = async (method, params) => { if (method === "thread/resume") setRemoteEnabled(workspace, false); return original(method, params); };
    const controller = new RemoteController(workspace, fake as unknown as AppServerClient), running = controller.run();
    try {
      await until(() => readRemote(workspace.id)!.tasks[0].status === "cancelled");
      expect(fake.calls.some(c => c.method === "turn/start")).toBe(false);
    } finally { controller.stop(); await running; }
  });
  for (const outcome of ["completed", "failed", "interrupted"]) it(`真实完成事件映射 ${outcome}`, async () => {
    ready(); thread(); const t = enqueueTask(workspace.id, input(), "client");
    const fake = new Fake(); fake.outcome = outcome;
    const controller = new RemoteController(workspace, fake as unknown as AppServerClient);
    const running = controller.run();
    try {
      await until(() => readRemote(workspace.id)!.tasks[0].status === (outcome === "interrupted" ? "cancelled" : outcome));
      await until(() => readExecutionRecords(workspace.id).some(r => r.taskId === t.taskId));
      expect(fake.calls.filter(c => c.method === "turn/start")).toHaveLength(1);
      expect(fake.calls.find(c => c.method === "turn/start")!.params).not.toHaveProperty("sandboxPolicy");
    } finally { controller.stop(); await running; }
  });
  it("撤权后仍投影已收到的终态，后续 queued 任务保持不变", async () => {
    ready(); thread();
    const first = enqueueTask(workspace.id, input(), "client");
    enqueueTask(workspace.id, { ...input(), commandId: "cmd2" }, "client");
    const fake = new Fake(); fake.autoComplete = false;
    const controller = new RemoteController(workspace, fake as unknown as AppServerClient);
    const running = controller.run();
    try {
      await until(() => readRemote(workspace.id)!.tasks[0].status === "running");
      setRemoteEnabled(workspace, false);
      fake.emit("notification", { method: "item/completed", params: {
        threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", text: "完成输出\nAuthorization: Bearer c2c_at_abcdefghijklmnopqrstuv" },
      } });
      fake.emit("notification", { method: "turn/completed", params: {
        threadId: "thread-1", turnId: "turn-1", turn: { id: "turn-1", status: "completed" },
      } });
      await until(() => readRemote(workspace.id)!.tasks[0].status === "completed");
      await until(() => readExecutionRecords(workspace.id).some(record => record.taskId === first.taskId));
      const record = readExecutionRecords(workspace.id).find(item => item.taskId === first.taskId)!;
      expect(record.outputId).toBeTypeOf("number");
      expect(record.outputAvailable).toBe(true);
      const output = readExecutionOutput(workspace.id, record.outputId!);
      expect(output.ok).toBe(true);
      if (output.ok) {
        expect(output.text).toContain("完成输出");
        expect(output.text).toContain("[REDACTED]");
        expect(output.text).not.toContain("c2c_at_abcdefghijklmnopqrstuv");
      }
      expect(readRemote(workspace.id)!.tasks[1].status).toBe("queued");
      expect(fake.calls.filter(call => call.method === "turn/start")).toHaveLength(1);
      expect(readRemote(workspace.id)!.enabled).toBe(false);
    } finally { controller.stop(); await running; }
  });
  it("输出锁竞争时保留终态正文并在下一轮重试", async () => {
    ready(); thread();
    const first = enqueueTask(workspace.id, input(), "client");
    const fake = new Fake(); fake.autoComplete = false;
    const controller = new RemoteController(workspace, fake as unknown as AppServerClient);
    const running = controller.run();
    const lockFile = path.join(getStateDir(), "execution-outputs", workspace.id, "index.json.lock");
    let unlocker: ReturnType<typeof spawn> | undefined;
    try {
      await until(() => readRemote(workspace.id)!.tasks[0].status === "running");
      fs.mkdirSync(path.dirname(lockFile), { recursive: true });
      fs.writeFileSync(lockFile, "{}");
      unlocker = spawn(process.execPath, ["-e", "const fs=require('node:fs'), file=process.argv[1]; setTimeout(() => { try { fs.unlinkSync(file); } catch {} }, 2000);", lockFile], { stdio: "ignore", windowsHide: true });
      const unlocked = new Promise<void>((resolve, reject) => {
        unlocker!.once("error", reject);
        unlocker!.once("exit", () => resolve());
      });
      fake.emit("notification", { method: "item/completed", params: {
        threadId: "thread-1", turnId: "turn-1", item: { type: "agentMessage", text: "锁竞争后的正文" },
      } });
      fake.emit("notification", { method: "turn/completed", params: {
        threadId: "thread-1", turnId: "turn-1", turn: { id: "turn-1", status: "completed" },
      } });
      await unlocked;
      await until(() => readExecutionRecords(workspace.id).some(record => record.taskId === first.taskId));
      const record = readExecutionRecords(workspace.id).find(item => item.taskId === first.taskId)!;
      expect(readExecutionOutput(workspace.id, record.outputId!)).toMatchObject({ ok: true, text: "锁竞争后的正文" });
    } finally {
      controller.stop(); await running;
      if (unlocker && !unlocker.killed) unlocker.kill();
      fs.rmSync(lockFile, { force: true });
    }
  });
  it("创建线程异步返回并使用本机 cwd，不覆盖安全或模型配置", async () => {
    ready(); enqueueThread(workspace.id, { workspaceId: workspace.id, requestId: "req" }, "client");
    const fake = new Fake(), controller = new RemoteController(workspace, fake as unknown as AppServerClient);
    const running = controller.run();
    try {
      await until(() => readRemote(workspace.id)!.threads[0].status === "completed");
      expect(fake.calls.filter(c => c.method === "thread/start")).toEqual([{ method: "thread/start", params: { cwd: root } }]);
      expect(enqueueThread(workspace.id, { workspaceId: workspace.id, requestId: "req" }, "client").threadId).toBe("thread-1");
    } finally { controller.stop(); await running; }
  });
  it("turn/start 返回仍 running，审批不自动应答，同工作区第二任务继续排队", async () => {
    ready(); thread(); enqueueTask(workspace.id, input(), "client");
    enqueueTask(workspace.id, { ...input(), commandId: "cmd2" }, "client");
    const fake = new Fake(); fake.autoComplete = false;
    const controller = new RemoteController(workspace, fake as unknown as AppServerClient), running = controller.run();
    try {
      await until(() => readRemote(workspace.id)!.tasks[0].status === "running");
      fake.emit("request", { id: 43, method: "account/chatgptAuthTokens/refresh", params: {} });
      await until(() => readRemote(workspace.id)!.tasks[0].status === "awaiting_approval");
      fake.emit("request", { id: 44, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1" } });
      await until(() => readRemote(workspace.id)!.tasks[0].status === "awaiting_approval");
      expect(readRemote(workspace.id)!.tasks[1].status).toBe("queued");
      expect(fake.calls.filter(c => c.method === "turn/start")).toHaveLength(1);
    } finally { controller.stop(); await running; }
    expect(readRemote(workspace.id)!.tasks[0].status).toBe("needs_reconciliation");
  });
  it("崩溃后的不确定任务占用槽位，重启不盲目重跑", async () => {
    ready(); thread(); enqueueTask(workspace.id, input(), "client");
    updateRemote(workspace.id, s => { s!.tasks[0].status = "starting"; return { state: s!, result: undefined }; });
    const fake = new Fake(), controller = new RemoteController(workspace, fake as unknown as AppServerClient), running = controller.run();
    try { await until(() => readRemote(workspace.id)!.controller?.appServer === "running" && readRemote(workspace.id)!.tasks[0].status === "needs_reconciliation"); expect(fake.calls.map(c => c.method)).toEqual(["config/read"]); }
    finally { controller.stop(); await running; }
  });
});
it("真实 MCP 传输校验 scopes、本地授权及工作区；默认包含九个只读基础工具和 Desktop 工具", async () => {
  const bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false });
  const clients: Client[] = [];
  const connect = async (scopes: string[]) => {
    const tokens = bridge.authStore.issueTokens({ clientId: "client", scopes });
    const client = new Client({ name: "test", version: "1" }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.accessToken}` } } }));
    return client;
  };
  const payload = (r: any) => JSON.parse(r.content[0].text);
  try {
    const read = await connect(["workspace.read"]);
    expect((await read.listTools()).tools).toHaveLength(22);
    ready();
    const tools = (await read.listTools()).tools;
    expect(tools).toHaveLength(26);
    expect(tools.find(t => t.name === "codex_submit_task")!.annotations!.readOnlyHint).toBe(false);
    expect(tools.some(t => t.name === "write_probe")).toBe(false);
    const args = { workspaceId: workspace.id, requestId: "req" };
    expect(payload(await read.callTool({ name: "codex_create_thread", arguments: args })).error).toBe("INSUFFICIENT_SCOPE");
    const write = await connect(["codex.control", "codex.read"]);
    expect(payload(await write.callTool({ name: "codex_create_thread", arguments: { ...args, workspaceId: "wrong" } })).error).toBe("UNKNOWN_WORKSPACE");
    expect(payload(await write.callTool({ name: "codex_create_thread", arguments: args })).status).toBe("queued");
    expect(payload(await write.callTool({ name: "codex_thread_status", arguments: args })).requestId).toBe("req");
    expect((await read.listTools()).tools.filter(t => !t.name.startsWith("codex_") && !t.name.startsWith("feedback_")).every(t => t.annotations!.readOnlyHint)).toBe(true);
    setRemoteEnabled(workspace, false);
    expect((await write.listTools()).tools).toHaveLength(22);
    fs.writeFileSync(remoteFile(workspace.id), "broken");
    expect((await read.listTools()).tools).toHaveLength(22);
  } finally { for (const client of clients) await client.close(); await bridge.close(); }
});
