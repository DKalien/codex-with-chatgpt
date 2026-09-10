import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";
import { CONTROL_KINDS } from "../session/control-protocol.js";
import type { Workspace } from "../workspace/manager.js";

export const remoteId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const text = z.string().min(1).max(8192);
export const createInput = z.object({ workspaceId: remoteId, requestId: remoteId, purpose: text.optional() }).strict();
export const taskInput = z.object({ workspaceId: remoteId, threadId: remoteId, commandId: remoteId,
  kind: z.enum(CONTROL_KINDS), goal: text, instructions: text.optional(), successCriteria: text.optional() }).strict();
const status = z.enum(["queued", "starting", "running", "completed", "failed", "cancelled", "awaiting_approval", "needs_reconciliation"]);
const threadSchema = createInput.extend({ clientId: z.string(), status, threadId: remoteId.optional(), createdAt: z.string(), updatedAt: z.string(), error: z.string().optional() });
const taskSchema = taskInput.extend({ clientId: z.string(), taskId: remoteId, status, createdAt: z.string(), updatedAt: z.string(),
  startedAt: z.string().optional(), completedAt: z.string().optional(), turnId: z.string().optional(), error: z.string().optional(), summary: z.string().optional(), recorded: z.boolean().optional() });
const stateSchema = z.object({ version: z.literal(1), workspaceId: remoteId, workspaceRoot: z.string(), enabled: z.boolean(),
  threads: z.array(threadSchema).max(10000), tasks: z.array(taskSchema).max(10000),
  controller: z.object({ pid: z.number().int(), instanceId: z.string(), heartbeatAt: z.number(), appServer: z.enum(["starting", "running", "offline", "unknown"]), error: z.string().optional(), stopRequested: z.boolean().optional() }).optional(),
  audit: z.array(z.object({ timestamp: z.string(), clientId: z.string(), action: z.string(), id: z.string(), result: z.string(), threadId: z.string().optional() })).max(40000),
}).strict();
export type RemoteState = z.infer<typeof stateSchema>;
export type RemoteTask = z.infer<typeof taskSchema>;
export type RemoteThread = z.infer<typeof threadSchema>;
export class RemoteError extends Error {
  constructor(public code: string, message = code) { super(message); }
}
export function remoteFile(workspaceId: string): string {
  return path.join(getStateDir(), "remote-control", `${remoteId.parse(workspaceId)}.json`);
}
export function readRemote(workspaceId: string): RemoteState | null {
  try {
    const state = stateSchema.parse(JSON.parse(fs.readFileSync(remoteFile(workspaceId), "utf8")));
    if (state.workspaceId !== workspaceId) throw new Error("workspace mismatch");
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new RemoteError("STATE_CORRUPT", "远程控制状态损坏；保留文件和防重放历史，停止操作并人工核对。");
  }
}
// ponytail: 每个工作区一个短锁和 JSON；达到历史容量就停止接单，未来可迁移 SQLite，不能淘汰幂等 ID。
export function updateRemote<T>(workspaceId: string, change: (state: RemoteState | null) => { state: RemoteState; result: T }): T {
  const file = remoteFile(workspaceId);
  ensureDir(path.dirname(file));
  let lock: number;
  try { lock = fs.openSync(`${file}.lock`, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RemoteError("WORKSPACE_BUSY", "状态写锁存在；稍后重试，遗留锁需核对 PID 后人工恢复。");
    throw error;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    fs.fsyncSync(lock);
    const next = change(readRemote(workspaceId));
    const valid = stateSchema.parse(next.state);
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(valid)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    return next.result;
  } finally {
    fs.rmSync(temporary, { force: true }); fs.closeSync(lock); fs.unlinkSync(`${file}.lock`);
  }
}
export function setRemoteEnabled(workspace: Pick<Workspace, "id" | "root">, enabled: boolean): void {
  updateRemote(workspace.id, previous => {
    const state = previous ?? { version: 1 as const, workspaceId: workspace.id, workspaceRoot: workspace.root, enabled: false, threads: [], tasks: [], audit: [] };
    if (state.workspaceRoot !== workspace.root) throw new RemoteError("UNKNOWN_WORKSPACE");
    state.enabled = enabled;
    return { state, result: undefined };
  });
}
export function authorized(state: RemoteState | null): RemoteState {
  if (!state?.enabled) throw new RemoteError("REMOTE_CONTROL_DISABLED");
  return state;
}
export function controllerOnline(state: RemoteState): boolean {
  const c = state.controller;
  return !!c && !c.stopRequested && ["starting", "running"].includes(c.appServer) && Date.now() - c.heartbeatAt < 15000;
}
export function assertController(state: RemoteState): void {
  if (!controllerOnline(state)) throw new RemoteError("CONTROLLER_OFFLINE");
  if (state.controller?.appServer !== "running") throw new RemoteError("CODEX_APP_SERVER_UNAVAILABLE");
}
export function audit(state: RemoteState, clientId: string, action: string, id: string, result: string, threadId?: string): void {
  if (state.audit.length >= 40000) throw new RemoteError("TASK_QUEUE_FULL", "审计容量已满，需保留历史后迁移。");
  state.audit.push({ timestamp: new Date().toISOString(), clientId, action, id, result, threadId });
}
export function enqueueThread(workspaceId: string, raw: z.infer<typeof createInput>, clientId: string): RemoteThread {
  const input = createInput.parse(raw);
  if (input.workspaceId !== workspaceId) throw new RemoteError("UNKNOWN_WORKSPACE");
  return updateRemote(workspaceId, old => {
    const state = authorized(old);
    const prior = state.threads.find(t => t.requestId === input.requestId);
    if (prior) {
      if (prior.purpose !== input.purpose || prior.clientId !== clientId) throw new RemoteError("REQUEST_ALREADY_EXISTS");
      return { state, result: prior };
    }
    assertController(state);
    if (state.audit.length >= 20000 || state.threads.length >= 10000 || state.threads.filter(t => t.status === "queued").length >= 100) throw new RemoteError("TASK_QUEUE_FULL");
    const now = new Date().toISOString();
    const thread: RemoteThread = { ...input, clientId, status: "queued", createdAt: now, updatedAt: now };
    audit(state, clientId, "codex_create_thread", input.requestId, "queued");
    state.threads.push(thread);
    return { state, result: thread };
  });
}
export function enqueueTask(workspaceId: string, raw: z.infer<typeof taskInput>, clientId: string): RemoteTask {
  const input = taskInput.parse(raw);
  if (input.workspaceId !== workspaceId) throw new RemoteError("UNKNOWN_WORKSPACE");
  return updateRemote(workspaceId, old => {
    const state = authorized(old);
    const prior = state.tasks.find(t => t.commandId === input.commandId);
    if (prior) {
      if (prior.clientId !== clientId || Object.entries(input).some(([k,v]) => prior[k as keyof RemoteTask] !== v) || prior.instructions !== input.instructions || prior.successCriteria !== input.successCriteria) throw new RemoteError("TASK_ALREADY_EXISTS");
      return { state, result: prior };
    }
    assertController(state);
    if (!state.threads.some(t => t.threadId === input.threadId && t.status === "completed")) throw new RemoteError("UNKNOWN_THREAD");
    if (state.audit.length >= 20000 || state.tasks.length >= 10000 || state.tasks.filter(t => t.status === "queued").length >= 100) throw new RemoteError("TASK_QUEUE_FULL");
    const now = new Date().toISOString();
    const task: RemoteTask = { ...input, clientId, taskId: randomUUID(), status: "queued", createdAt: now, updatedAt: now };
    audit(state, clientId, "codex_submit_task", input.commandId, "queued", input.threadId);
    state.tasks.push(task);
    return { state, result: task };
  });
}
export function publicTask(t: RemoteTask) {
  const { taskId, commandId, workspaceId, threadId, status, createdAt, updatedAt, startedAt, completedAt, error, summary } = t;
  return { taskId, commandId, workspaceId, threadId, status, createdAt, updatedAt, startedAt, completedAt, error, summary };
}
export function publicThread(t: RemoteThread) {
  const { workspaceId, requestId, threadId, status, createdAt, updatedAt, error } = t;
  return { workspaceId, requestId, threadId, status, createdAt, updatedAt, error };
}
