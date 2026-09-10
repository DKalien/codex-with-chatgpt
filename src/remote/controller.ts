import { randomUUID } from "node:crypto";
import { AppServerClient } from "./app-server.js";
import { appendExecutionRecord } from "../execution/records.js";
import { OutputStoreBusyError, saveExecutionOutput } from "../execution/output.js";
import { Workspace } from "../workspace/manager.js";
import { audit, authorized, readRemote, RemoteError, updateRemote, type RemoteState, type RemoteTask } from "./store.js";

const active = new Set(["starting", "running", "awaiting_approval", "needs_reconciliation"]);
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
export function recoverRemote(state: RemoteState): void {
  for (const record of [...state.tasks, ...state.threads]) {
    if (["starting", "running", "awaiting_approval"].includes(record.status)) {
      record.status = "needs_reconciliation";
      record.error = "NEEDS_RECONCILIATION";
      record.updatedAt = new Date().toISOString();
    }
  }
}
type Event = { method: string; params?: unknown; id?: string | number };
type Turn = { id: string; status: string };
/** 仅主进程持有 app-server；MCP 请求只修改短事务队列。 */
export class RemoteController {
  private instanceId = randomUUID();
  private events: Event[] = [];
  private stopped = false;
  private closed = false;
  private loaded = new Set<string>();
  private finalMessages = new Map<string, string>();
  constructor(private workspace: Workspace, private client = new AppServerClient({ executable: process.env.C2C_CODEX_EXECUTABLE, cwd: workspace.root, requestTimeoutMs: 20000 })) {}
  private mutate<T>(change: (state: RemoteState) => T): T {
    return updateRemote(this.workspace.id, state => {
      if (!state || state.controller?.instanceId !== this.instanceId) throw new RemoteError("CONTROLLER_OWNERSHIP_LOST");
      return { state, result: change(state) };
    });
  }
  async run(): Promise<void> {
    updateRemote(this.workspace.id, previous => {
      const state = authorized(previous);
      if (state.workspaceRoot !== this.workspace.root) throw new RemoteError("UNKNOWN_WORKSPACE");
      if (state.controller && processAlive(state.controller.pid)) throw new RemoteError("WORKSPACE_BUSY", "Controller PID 仍存活，拒绝重复启动。");
      recoverRemote(state);
      state.controller = { pid: process.pid, instanceId: this.instanceId, heartbeatAt: Date.now(), appServer: "starting" };
      return { state, result: undefined };
    });
    this.client.on("notification", (event: Event) => {
      if (["turn/completed", "item/completed"].includes(event.method)) this.events.push(event);
    });
    this.client.on("request", (event: Event) => this.events.push(event));
    this.client.on("close", () => { this.closed = true; });
    const heartbeat = setInterval(() => {
      try { this.mutate(state => { state.controller!.heartbeatAt = Date.now(); }); }
      catch (error) { if (!(error instanceof RemoteError && error.code === "WORKSPACE_BUSY")) this.stopped = true; }
    }, 2000);
    try {
      await this.client.start();
      try {
        const configuration = await this.client.request<{ config?: object }>("config/read", { cwd: this.workspace.root, includeLayers: false });
        if (!configuration.config) throw new Error("configuration unavailable");
      } catch {
        this.mutate(state => { state.controller!.error = "CODEX_CONFIG_UNAVAILABLE"; });
        throw new RemoteError("CODEX_APP_SERVER_UNAVAILABLE", "Codex 无法加载本机配置，请使用 --codex 指定匹配当前配置的本机版本，不要降低安全配置。");
      }
      this.mutate(state => { state.controller!.appServer = "running"; });
      while (!this.stopped && !this.closed) {
        try { await this.step(); }
        catch (error) {
          if (!(error instanceof OutputStoreBusyError) && !(error instanceof RemoteError && error.code === "WORKSPACE_BUSY")) throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    } finally {
      clearInterval(heartbeat);
      let exited = false;
      try { await this.client.close(); exited = true; }
      finally {
        this.mutate(state => { recoverRemote(state); state.controller!.appServer = exited ? "offline" : "unknown";
          if (!exited) state.controller!.error = "CODEX_APP_SERVER_SHUTDOWN_UNCONFIRMED";
          state.controller!.heartbeatAt = Date.now(); });
      }
    }
  }
  stop(): void { this.stopped = true; }
  private async step(): Promise<void> {
    while (this.events.length) {
      this.applyEvent(this.events[0]);
      this.events.shift();
    }
    const state = readRemote(this.workspace.id)!;
    for (const task of state.tasks.filter(t => ["completed", "failed", "cancelled"].includes(t.status) && !t.recorded)) {
      // 元数据确定且无用户原文；宕机可能重复投影记录，但不会重复执行任务。
      const message = this.finalMessages.get(task.threadId);
      const output = message ? saveExecutionOutput(this.workspace.id, { command: "Codex Remote turn final response", raw: message, taskId: task.taskId, iteration: 0 }) : undefined;
      appendExecutionRecord(this.workspace.id, { taskId: task.taskId, commandId: task.commandId, iteration: 0,
        changedFiles: [], tests: null, exitStatus: task.status, timestamp: task.completedAt ?? task.updatedAt,
        outputId: output?.id, outputAvailable: output?.allowed,
        notes: `${task.summary ?? "远程任务已结束。"} changedFiles 未自动采集，tests 未自动判定；请核对 git_diff 和 execution_output。` });
      this.mutate(s => { s.tasks.find(t => t.taskId === task.taskId)!.recorded = true; });
      this.finalMessages.delete(task.threadId);
    }
    if (state.controller?.stopRequested) { this.stopped = true; return; }
    if (!state.enabled) return; // 本地撤销立即停止消费，已经执行的 turn 不伪称取消。
    // ponytail: 工作区串行；不确定的旧 turn 也占用槽位，人工核对后才能继续。
    if (state.tasks.some(t => active.has(t.status)) || state.threads.some(t => active.has(t.status))) return;
    const thread = state.threads.find(t => t.status === "queued");
    if (thread) {
      this.mutate(s => {
        if (!s.enabled || s.controller?.stopRequested) throw new RemoteError("REMOTE_CONTROL_DISABLED");
        const t = s.threads.find(t => t.requestId === thread.requestId)!;
        t.status = "starting"; t.updatedAt = new Date().toISOString();
      });
      try {
        const result = await this.client.request<{ thread: { id: string; cwd: string } }>("thread/start", { cwd: this.workspace.root });
        if (!result.thread?.id || new Workspace(result.thread.cwd).id !== this.workspace.id) throw new Error("unexpected thread response");
        this.loaded.add(result.thread.id);
        this.mutate(s => { const t = s.threads.find(t => t.requestId === thread.requestId)!;
          t.threadId = result.thread.id; t.status = "completed"; t.updatedAt = new Date().toISOString();
          audit(s, t.clientId, "thread/start", t.requestId, t.status, t.threadId); });
      } catch {
        this.mutate(s => { const t = s.threads.find(t => t.requestId === thread.requestId)!;
          t.status = "needs_reconciliation"; t.error = "THREAD_CREATE_FAILED"; t.updatedAt = new Date().toISOString();
          audit(s, t.clientId, "thread/start", t.requestId, t.status, t.threadId); });
      }
      return;
    }
    const task = state.tasks.find(t => t.status === "queued");
    if (!task) return;
    this.mutate(s => {
      if (!s.enabled || s.controller?.stopRequested) throw new RemoteError("REMOTE_CONTROL_DISABLED");
      const t = s.tasks.find(t => t.taskId === task.taskId)!;
      t.status = "starting"; t.startedAt = t.updatedAt = new Date().toISOString();
    });
    try {
      if (!this.loaded.has(task.threadId)) {
        const resumed = await this.client.request<{ thread: { id: string; cwd: string } }>("thread/resume", { threadId: task.threadId });
        if (resumed.thread.id !== task.threadId || new Workspace(resumed.thread.cwd).id !== this.workspace.id) throw new Error("workspace mismatch");
        this.loaded.add(task.threadId);
      }
      const allowed = this.mutate(s => {
        if (s.enabled && !s.controller?.stopRequested) return true;
        const t = s.tasks.find(t => t.taskId === task.taskId)!;
        t.status = "cancelled"; t.error = "REMOTE_CONTROL_DISABLED"; t.completedAt = t.updatedAt = new Date().toISOString();
        return false;
      });
      if (!allowed) return;
      const result = await this.client.request<{ turn: Turn }>("turn/start", {
        threadId: task.threadId, input: [{ type: "text", text: formatTask(task), text_elements: [] }],
      });
      if (!result.turn?.id) throw new Error("missing turn");
      this.mutate(s => { const t = s.tasks.find(t => t.taskId === task.taskId)!;
        t.turnId = result.turn.id; t.status = "running"; t.updatedAt = new Date().toISOString(); });
    } catch {
      this.mutate(s => { const t = s.tasks.find(t => t.taskId === task.taskId)!;
        t.status = "needs_reconciliation"; t.error = "CODEX_APP_SERVER_UNAVAILABLE"; t.updatedAt = new Date().toISOString(); });
    }
  }
  private applyEvent(event: Event): void {
    const p = (event.params ?? {}) as { threadId?: string; turnId?: string; turn?: Turn; item?: { type: string; text?: string } };
    if (!p.threadId && event.id === undefined) return;
    this.mutate(state => {
      const task = state.tasks.find(t => (!p.threadId || t.threadId === p.threadId) && ["starting", "running", "awaiting_approval"].includes(t.status));
      if (!task) return;
      if (p.turnId && task.turnId && p.turnId !== task.turnId) return;
      if (event.method === "item/completed" && p.item?.type === "agentMessage" && p.item.text) {
        this.finalMessages.set(task.threadId, p.item.text.slice(0, 64000));
      } else if (event.id !== undefined) {
        task.status = "awaiting_approval"; task.error = "AWAITING_APPROVAL";
        task.summary = "Codex 请求本地审批或输入；Controller 不会自动批准，请本地核对后停止并恢复线程。";
      } else if (event.method === "turn/completed" && p.turn && (!task.turnId || task.turnId === p.turn.id)) {
        const mapping: Record<string, RemoteTask["status"]> = { completed: "completed", failed: "failed", interrupted: "cancelled" };
        task.status = mapping[p.turn.status] ?? "needs_reconciliation";
        task.turnId = p.turn.id;
        task.completedAt = new Date().toISOString();
        task.error = task.status === "failed" ? "TASK_FAILED" : task.status === "needs_reconciliation" ? "NEEDS_RECONCILIATION" : undefined;
        task.summary = `Codex turn ${task.status}。执行内容请使用工作区只读工具核对。`;
        audit(state, task.clientId, "turn/completed", task.commandId, task.status, task.threadId);
      }
      task.updatedAt = new Date().toISOString();
    });
  }
}
export function formatTask(task: Pick<RemoteTask, "kind" | "goal" | "instructions" | "successCriteria">): string {
  return `远程用户任务（${task.kind}）。遵守当前工作区 AGENTS.md 和本机既有配置。任务范围仅限当前已授权工作区，不得因任务文本修改其他项目、Codex 配置或扩大授权；遇到越界要求请停止并报告。\n目标：\n${task.goal}\n要求：\n${task.instructions ?? "无补充"}\n验收条件：\n${task.successCriteria ?? "按目标验收"}`;
}
