import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";
import { CONTROL_KINDS } from "../session/control-protocol.js";
import type { Workspace } from "../workspace/manager.js";
import { withCommandOperation } from "../command-cleanup/fence.js";
import { readRouting } from "../routing/store.js";
import { readDesktop } from "../desktop/store.js";
import { readExecutorDispatchEntry } from "../executor-control/dispatch-service.js";
import { readResultBus } from "../result-bus/store.js";
import { readExecutionRecordsStrict } from "../execution/records.js";
import { readExecutionOutputMetadataStrict } from "../execution/output.js";
import { readAbandonedCommandIds } from "../desktop/abandonment.js";
import { readLegacyRetirements } from "../desktop/legacy-retirement.js";
import { readLegacyReconciliations } from "../desktop/legacy-reconciliation.js";
import { readOutcomeResolutions } from "../desktop/outcome-resolution.js";
import { listResultOutboxEntries, listResultReconciliationNeeded } from "../routing/result-outbox-store.js";
import { readFeedbackStatusState } from "../feedback/state-store.js";
import { repairPaths } from "../command-cleanup/abandonment-repair-store.js";
import { assertNoLegacyHistoryCleanup } from "../command-cleanup/legacy-history-fence.js";

export const remoteId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const targetIdSchema = z.string().uuid();
const text = z.string().min(1).max(8192);
export const createInput = z.object({ workspaceId: remoteId, requestId: remoteId, purpose: text.optional() }).strict();
const taskFields = { workspaceId: remoteId, targetId: targetIdSchema.optional(), threadId: remoteId.optional(), commandId: remoteId,
  kind: z.enum(CONTROL_KINDS), goal: text, instructions: text.optional(), successCriteria: text.optional() };
export const taskInput = z.object(taskFields).strict();
const status = z.enum(["queued", "starting", "running", "completed", "failed", "cancelled", "awaiting_approval", "needs_reconciliation"]);
const targetSchema = z.object({ targetId: targetIdSchema, hostId: z.literal("local"), workspaceId: remoteId, workspaceRoot: z.string(),
  threadId: remoteId, createdAt: z.string(), source: z.enum(["created", "selected"]), clientId: z.string() }).strict();
export const remoteControllerSchema = z.object({ pid: z.number().int(), instanceId: z.string(), heartbeatAt: z.number(),
  appServer: z.enum(["starting", "running", "offline", "unknown"]), buildId: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  error: z.string().optional(), stopRequested: z.boolean().optional() }).strict();
const threadSchema = createInput.extend({ clientId: z.string(), status, source: z.enum(["created", "selected"]).optional(),
  targetId: targetIdSchema.optional(), threadId: remoteId.optional(), createdAt: z.string(), updatedAt: z.string(), error: z.string().optional() });
const taskSchema = z.object({ workspaceId: remoteId, targetId: targetIdSchema.optional(), threadId: remoteId, commandId: remoteId,
  kind: z.enum(CONTROL_KINDS), goal: text, instructions: text.optional(), successCriteria: text.optional(), clientId: z.string(),
  taskId: remoteId, status, createdAt: z.string(), updatedAt: z.string(), startedAt: z.string().optional(), completedAt: z.string().optional(),
  turnId: remoteId.optional(), error: z.string().optional(), summary: z.string().optional(), recorded: z.boolean().optional(),
  finalResponse: z.object({ text: z.string().max(64 * 1024), truncated: z.boolean(), restrictedReason: z.string().max(128).optional() }).strict().optional(),
  outputId: z.number().int().positive().optional(), outputAvailable: z.boolean().optional(), resultProjected: z.boolean().optional() }).strict();
export const remoteStateSchema = z.object({ version: z.literal(1), workspaceId: remoteId, workspaceRoot: z.string(), enabled: z.boolean(),
  deliveryMode: z.literal("official").optional(), targets: z.array(targetSchema).max(10000).optional(),
  threads: z.array(threadSchema).max(10000), tasks: z.array(taskSchema).max(10000),
  controller: remoteControllerSchema.optional(),
  audit: z.array(z.object({ timestamp: z.string(), clientId: z.string(), action: z.string(), id: z.string(), result: z.string(), threadId: z.string().optional() })).max(40000),
}).strict();
export type RemoteState = z.infer<typeof remoteStateSchema>;
export type RemoteTask = z.infer<typeof taskSchema>;
export type RemoteThread = z.infer<typeof threadSchema>;
export type RemoteTarget = z.infer<typeof targetSchema>;
export class RemoteError extends Error {
  constructor(public code: string, message = code) { super(message); }
}
export function remoteFile(workspaceId: string, stateDir = getStateDir()): string {
  return path.join(stateDir, "remote-control", `${remoteId.parse(workspaceId)}.json`);
}
export function readRemote(workspaceId: string, stateDir = getStateDir()): RemoteState | null {
  try {
    const state = remoteStateSchema.parse(JSON.parse(fs.readFileSync(remoteFile(workspaceId, stateDir), "utf8")));
    if (state.workspaceId !== workspaceId) throw new Error("workspace mismatch");
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new RemoteError("STATE_CORRUPT", "远程控制状态损坏；保留文件和防重放历史，停止操作并人工核对。");
  }
}
// ponytail: 每个工作区一个短锁和 JSON；达到历史容量就停止接单，未来可迁移 SQLite，不能淘汰幂等 ID。
export function updateRemote<T>(workspaceId: string, change: (state: RemoteState | null) => { state: RemoteState; result: T }, stateDir = getStateDir()): T {
  const file = remoteFile(workspaceId, stateDir);
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
    const next = change(readRemote(workspaceId, stateDir));
    const valid = remoteStateSchema.parse(next.state);
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(valid)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    return next.result;
  } finally {
    fs.rmSync(temporary, { force: true }); fs.closeSync(lock); fs.unlinkSync(`${file}.lock`);
  }
}
export function setRemoteEnabled(workspace: Pick<Workspace, "id" | "root">, enabled: boolean,
  options: { deliveryMode?: "official" } = {}): void {
  updateRemote(workspace.id, previous => {
    const state = previous ?? { version: 1 as const, workspaceId: workspace.id, workspaceRoot: workspace.root, enabled: false, threads: [], tasks: [], audit: [] };
    if (state.workspaceRoot !== workspace.root) throw new RemoteError("UNKNOWN_WORKSPACE");
    state.enabled = enabled;
    if (options.deliveryMode) state.deliveryMode = options.deliveryMode;
    return { state, result: undefined };
  });
}
export function isOfficialRemoteMode(workspaceId: string): boolean {
  return readRemote(workspaceId)?.deliveryMode === "official";
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
export function taskTargetForThread(state: RemoteState, threadId: string, clientId: string): RemoteTarget {
  const targets = state.targets ?? [];
  const all = targets.filter(target => target.threadId === threadId);
  const accessible = all.filter(target => target.clientId === clientId || target.clientId === "local");
  if (accessible.length === 1) return accessible[0]!;
  if (accessible.length > 1) throw new RemoteError("TARGET_REQUIRED", "threadId 对应多个已授权 target；请显式传 targetId。");
  if (all.length) throw new RemoteError("TARGET_ACCESS_DENIED");
  const legacy = state.threads.find(thread => thread.threadId === threadId && thread.status === "completed" &&
    thread.clientId === clientId && (thread.source ?? "created") === "created");
  if (!legacy) throw new RemoteError("UNKNOWN_THREAD");
  const target: RemoteTarget = { targetId: randomUUID(), hostId: "local", workspaceId: state.workspaceId,
    workspaceRoot: state.workspaceRoot, threadId, createdAt: new Date().toISOString(), source: "created", clientId };
  (state.targets ??= []).push(target);
  legacy.targetId = target.targetId;
  return target;
}
/** Caller holds the command lifecycle fence; these checks are read-only. */
export function assertRemoteCommandIdAvailable(workspace: Pick<Workspace, "id" | "root">, commandId: string): void {
  assertNoLegacyHistoryCleanup(workspace.id, getStateDir());
  const routing = readRouting(workspace);
  const desktop = readDesktop(workspace.id);
  const dispatch = readExecutorDispatchEntry(workspace.id, commandId);
  const bus = readResultBus(workspace);
  const records = readExecutionRecordsStrict(workspace.id);
  const outputs = readExecutionOutputMetadataStrict(workspace.id);
  const abandoned = readAbandonedCommandIds(workspace.id);
  const retirements = readLegacyRetirements(workspace.id);
  const reconciliations = readLegacyReconciliations(workspace.id);
  const resolutions = readOutcomeResolutions(workspace.id);
  const outbox = listResultOutboxEntries(workspace);
  const outboxReconciliation = listResultReconciliationNeeded(workspace);
  const feedback = readFeedbackStatusState(workspace.id);
  const repair = repairPaths(workspace.id, commandId);
  const repairAuthorityExists = [repair.fence, repair.reclaim, repair.journal, `${repair.fence}.tmp`, `${repair.journal}.tmp`]
    .some(file => fs.existsSync(file));
  if (routing?.commands.some(item => item.commandId === commandId) || routing?.results.some(item => item.commandId === commandId) ||
      desktop?.deliveries.some(item => item.commandId === commandId) || dispatch ||
      bus?.entries.some(item => item.commandId === commandId) || records.some(item => item.commandId === commandId) ||
      outputs.some(item => item.commandId === commandId || item.taskId === commandId || item.taskId === `desktop_${commandId}`) ||
      records.some(item => item.taskId === commandId || item.taskId === `desktop_${commandId}`) ||
      abandoned.has(commandId) || retirements.some(item => item.commandId === commandId) ||
      reconciliations.some(item => item.commandId === commandId) || resolutions.some(item => item.commandId === commandId) ||
      outbox.some(item => item.commandId === commandId) || outboxReconciliation.some(item => item.commandId === commandId) ||
      feedback.events.some(item => "commandId" in item && item.commandId === commandId) || repairAuthorityExists) {
    throw new RemoteError("COMMAND_IDENTITY_CONFLICT", "commandId 已属于其他投递生命周期；拒绝派发或复用其 cleanup authority。");
  }
}
export function enqueueThread(workspaceId: string, raw: z.infer<typeof createInput>, clientId: string): RemoteThread {
  const input = createInput.parse(raw);
  if (input.workspaceId !== workspaceId) throw new RemoteError("UNKNOWN_WORKSPACE");
  return updateRemote(workspaceId, old => {
    const state = authorized(old);
    const prior = state.threads.find(t => t.requestId === input.requestId);
    if (prior) {
      if (prior.purpose !== input.purpose || prior.clientId !== clientId || (prior.source ?? "created") !== "created") throw new RemoteError("REQUEST_ALREADY_EXISTS");
      return { state, result: prior };
    }
    assertController(state);
    if (state.audit.length >= 20000 || state.threads.length >= 10000 || state.threads.filter(t => t.status === "queued").length >= 100) throw new RemoteError("TASK_QUEUE_FULL");
    const now = new Date().toISOString();
    const thread: RemoteThread = { ...input, clientId, source: "created", status: "queued", createdAt: now, updatedAt: now };
    audit(state, clientId, "codex_create_thread", input.requestId, "queued");
    state.threads.push(thread);
    return { state, result: thread };
  });
}
export function enqueueTargetSelection(workspaceId: string,
  raw: { workspaceId: string; threadId: string; requestId: string }, clientId = "local"): RemoteThread {
  const input = z.object({ workspaceId: remoteId, threadId: remoteId, requestId: remoteId }).strict().parse(raw);
  if (input.workspaceId !== workspaceId) throw new RemoteError("UNKNOWN_WORKSPACE");
  return updateRemote(workspaceId, old => {
    const state = authorized(old);
    const prior = state.threads.find(t => t.requestId === input.requestId);
    if (prior) {
      if (prior.source !== "selected" || prior.threadId !== input.threadId || prior.clientId !== clientId) throw new RemoteError("REQUEST_ALREADY_EXISTS");
      return { state, result: prior };
    }
    assertController(state);
    if (state.audit.length >= 20000 || state.threads.length >= 10000 || state.threads.filter(t => t.status === "queued").length >= 100) throw new RemoteError("TASK_QUEUE_FULL");
    const now = new Date().toISOString();
    const thread: RemoteThread = { workspaceId, requestId: input.requestId, threadId: input.threadId, clientId,
      source: "selected", status: "queued", createdAt: now, updatedAt: now };
    audit(state, clientId, "codex_select_thread", input.requestId, "queued", input.threadId);
    state.threads.push(thread);
    return { state, result: thread };
  });
}
export function enqueueTask(workspaceId: string, raw: z.infer<typeof taskInput>, clientId: string): RemoteTask {
  const input = taskInput.parse(raw);
  if (input.workspaceId !== workspaceId) throw new RemoteError("UNKNOWN_WORKSPACE");
  if (!input.targetId && !input.threadId) throw new RemoteError("TARGET_REQUIRED", "targetId 或 threadId 至少提供一个。");
  authorized(readRemote(workspaceId)); // Validate without creating a command-lifecycle fence for a disabled/unknown workspace.
  return withCommandOperation(workspaceId, input.commandId, () => updateRemote(workspaceId, old => {
    const state = authorized(old);
    const targets = state.targets ?? [];
    const target = input.targetId
      ? targets.find(t => t.targetId === input.targetId)
      : taskTargetForThread(state, input.threadId!, clientId);
    if (!target) throw new RemoteError(input.targetId ? "UNKNOWN_TARGET" : "UNKNOWN_THREAD");
    if (target.workspaceId !== workspaceId || target.workspaceRoot !== state.workspaceRoot || target.hostId !== "local") throw new RemoteError("UNKNOWN_TARGET");
    if (input.threadId && input.threadId !== target.threadId) throw new RemoteError("TARGET_THREAD_MISMATCH");
    if (target.clientId !== clientId && target.clientId !== "local") throw new RemoteError("TARGET_ACCESS_DENIED");
    const canonical = { ...input, targetId: target.targetId, threadId: target.threadId };
    const prior = state.tasks.find(t => t.commandId === input.commandId);
    if (prior) {
      const keys: Array<keyof typeof canonical> = ["workspaceId", "targetId", "threadId", "commandId", "kind", "goal", "instructions", "successCriteria"];
      if (prior.clientId !== clientId || keys.some(key => prior[key] !== canonical[key])) throw new RemoteError("TASK_ALREADY_EXISTS");
      return { state, result: prior };
    }
    assertRemoteCommandIdAvailable({ id: state.workspaceId, root: state.workspaceRoot }, input.commandId);
    assertController(state);
    if (state.audit.length >= 20000 || state.tasks.length >= 10000 || state.tasks.filter(t => t.status === "queued").length >= 100) throw new RemoteError("TASK_QUEUE_FULL");
    const now = new Date().toISOString();
    const task: RemoteTask = { ...canonical, clientId, taskId: randomUUID(), status: "queued", createdAt: now, updatedAt: now };
    audit(state, clientId, "codex_submit_task", input.commandId, "queued", target.threadId);
    state.tasks.push(task);
    return { state, result: task };
  }));
}
export function cancelRemoteTask(workspaceId: string, selector: { taskId?: string; commandId?: string }, clientId: string): RemoteTask {
  const input = z.object({ taskId: remoteId.optional(), commandId: remoteId.optional() }).strict()
    .refine(value => !!value.taskId || !!value.commandId, { message: "taskId 或 commandId 至少提供一个。" }).parse(selector);
  return updateRemote(workspaceId, old => {
    const state = old;
    if (!state) throw new RemoteError("UNKNOWN_TASK");
    if (state.workspaceId !== workspaceId) throw new RemoteError("UNKNOWN_WORKSPACE");
    const matches = state.tasks.filter(t => (input.taskId ? t.taskId === input.taskId : true) &&
      (input.commandId ? t.commandId === input.commandId : true));
    if (matches.length !== 1) throw new RemoteError(matches.length ? "AMBIGUOUS_TASK" : "UNKNOWN_TASK");
    const task = matches[0]!;
    if (task.clientId !== clientId) throw new RemoteError("TASK_ACCESS_DENIED");
    if (task.status === "cancelled") return { state, result: task };
    if (task.status !== "queued") throw new RemoteError("TASK_NOT_CANCELLABLE", "任务已开始派发或已结束，不能从队列取消。");
    task.status = "cancelled";
    task.error = "CANCELLED_BEFORE_DISPATCH";
    task.completedAt = task.updatedAt = new Date().toISOString();
    audit(state, clientId, "codex_cancel_task", task.commandId, task.status, task.threadId);
    return { state, result: task };
  });
}
export function publicTask(t: RemoteTask) {
  const { taskId, commandId, workspaceId, targetId, threadId, turnId, status, createdAt, updatedAt, startedAt, completedAt, error, summary, outputId } = t;
  return { taskId, commandId, workspaceId, targetId, threadId, turnId, status, createdAt, updatedAt, startedAt, completedAt, error, summary, outputId };
}
export function publicTaskResult(t: RemoteTask) {
  const { taskId, commandId, workspaceId, targetId, threadId, turnId, status, finalResponse, outputId, outputAvailable } = t;
  return { taskId, commandId, workspaceId, targetId, threadId, turnId, status, finalResponse, outputId, outputAvailable };
}
export function publicThread(t: RemoteThread) {
  const { workspaceId, requestId, targetId, threadId, source, status, createdAt, updatedAt, error } = t;
  return { workspaceId, requestId, targetId, threadId, source, status, createdAt, updatedAt, error };
}
