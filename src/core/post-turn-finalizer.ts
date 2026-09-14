import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";
import { isRuntimeBuildId } from "../build-id.js";
import { Workspace } from "../workspace/manager.js";
import { desktopIpc } from "../desktop/ipc.js";
import { appendExecutionRecord } from "../execution/records.js";
import { assessRolloutIdle, type SelfBusyProof } from "./rollout-idle.js";
import { readCurrentInstall } from "./install.js";
import { readPending } from "./upgrade.js";
import { findBridgeObservation, type RuntimeState } from "../bridge/runtime.js";

const HEX64 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKSPACE_ID = /^[a-f0-9]{12}$/;

export const FINALIZER_POLL_MS = 10_000;
export const FINALIZER_MAX_LIFETIME_MS = 15 * 60_000;

export class FinalizerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FinalizerError";
  }
}

export const activeFinalizerSchema = z.object({
  version: z.literal(1),
  jobId: z.string().regex(UUID),
  token: z.string().regex(UUID),
  workspaceId: z.string().regex(WORKSPACE_ID),
  workspaceRoot: z.string().refine(path.isAbsolute),
  targetBuildId: z.string().regex(HEX64),
  originThreadId: z.string().regex(UUID),
  originHostId: z.string().min(1),
  originProjectId: z.string().min(1),
  expectedRuntime: z.object({
    runtimeBuildId: z.string().regex(HEX64).optional(),
    pid: z.number().int().positive().optional(),
    startedAt: z.string().datetime().optional(),
  }).strict(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  status: z.enum(["scheduled", "waiting", "running"]),
}).strict();

const resultSchema = z.object({
  version: z.literal(1),
  jobId: z.string().regex(UUID),
  workspaceId: z.string().regex(WORKSPACE_ID),
  targetBuildId: z.string().regex(HEX64),
  status: z.enum(["ok", "blocked", "failed"]),
  reason: z.string().min(1).max(200),
  scheduledAt: z.string().datetime(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  rollout: z.object({
    targetBuildId: z.string().regex(HEX64),
    workspaceStatus: z.string(),
    reason: z.string().optional(),
  }).strict().optional(),
}).strict();

const workerClaimSchema = z.object({
  version: z.literal(1),
  jobId: z.string().regex(UUID),
  jobToken: z.string().regex(UUID),
  workerToken: z.string().regex(UUID),
  pid: z.number().int().positive(),
  claimedAt: z.string().datetime(),
}).strict();

export type ActiveFinalizer = z.infer<typeof activeFinalizerSchema>;
export type FinalizerResult = z.infer<typeof resultSchema>;
export type WorkerClaim = z.infer<typeof workerClaimSchema>;

export function activeFinalizerPath(stateDir: string, workspaceId: string): string {
  return path.join(path.resolve(stateDir), "post-turn-finalizers", `${workspaceId}.json`);
}

export function finalizerResultPath(stateDir: string, workspaceId: string): string {
  return path.join(path.resolve(stateDir), "post-turn-finalizer-results", `${workspaceId}.json`);
}

export function workerClaimPath(stateDir: string, workspaceId: string): string {
  return path.join(path.resolve(stateDir), "post-turn-finalizer-workers", `${workspaceId}.claim`);
}

function readRegularJson<T>(file: string, schema: z.ZodType<T>): T | "missing" | "corrupt" {
  try {
    if (!fs.existsSync(file)) return "missing";
    const lstat = fs.lstatSync(file);
    if (!lstat.isFile() || lstat.isSymbolicLink()) return "corrupt";
    if (fs.realpathSync(file) !== file) return "corrupt";
    return schema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return "corrupt";
  }
}

export function readActiveFinalizer(stateDir: string, workspaceId: string): ActiveFinalizer | null {
  const raw = readRegularJson(activeFinalizerPath(stateDir, workspaceId), activeFinalizerSchema);
  if (raw === "missing") return null;
  if (raw === "corrupt") throw new FinalizerError("FINALIZER_STATE_CORRUPT", "active finalizer 状态损坏或 schema 无效");
  if (raw.workspaceId !== workspaceId) throw new FinalizerError("FINALIZER_STATE_CORRUPT", "finalizer workspace identity 不匹配");
  const resolved = new Workspace(raw.workspaceRoot);
  if (resolved.id !== workspaceId) throw new FinalizerError("FINALIZER_STATE_CORRUPT", "workspaceRoot 与 workspaceId 不匹配");
  return raw;
}

export function readFinalizerResult(stateDir: string, workspaceId: string): FinalizerResult | null {
  const raw = readRegularJson(finalizerResultPath(stateDir, workspaceId), resultSchema);
  if (raw === "missing") return null;
  if (raw === "corrupt") throw new FinalizerError("FINALIZER_RESULT_CORRUPT", "finalizer result 损坏");
  if (raw.workspaceId !== workspaceId) {
    throw new FinalizerError("FINALIZER_RESULT_CORRUPT", "finalizer result workspaceId 不匹配");
  }
  return raw;
}

function writeJsonExclusive(file: string, value: unknown): boolean {
  ensureDir(path.dirname(file));
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function atomicWriteJson(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function sameSchedulingIdentity(a: ActiveFinalizer, b: {
  workspaceId: string; workspaceRoot: string; targetBuildId: string;
  originThreadId: string; originHostId: string; originProjectId: string;
  expectedRuntime: ActiveFinalizer["expectedRuntime"];
}): boolean {
  return a.workspaceId === b.workspaceId && a.workspaceRoot === b.workspaceRoot &&
    a.targetBuildId === b.targetBuildId &&
    a.originThreadId === b.originThreadId && a.originHostId === b.originHostId &&
    a.originProjectId === b.originProjectId &&
    JSON.stringify(a.expectedRuntime) === JSON.stringify(b.expectedRuntime);
}

export type ScheduleResult =
  | { ok: true; job: ActiveFinalizer; status: "scheduled" | "existing" }
  | { ok: false; code: string; reason: string };

export class FinalizerActiveReleaseError extends FinalizerError {
  readonly result: FinalizerResult;
  constructor(result: FinalizerResult) {
    super("FINALIZER_ACTIVE_RELEASE_FAILED", "result 已 durable，但 active finalizer 未能安全释放");
    this.result = result;
  }
}

export async function schedulePostTurnFinalizer(
  workspace: Workspace,
  targetBuildId: string,
  options: {
    stateDir?: string;
    /** 必填：调用方必须传入已用真实 info 计算的 assessment。 */
    assessment: Awaited<ReturnType<typeof assessRolloutIdle>>;
    runtime?: RuntimeState | null;
    spawnImpl?: typeof spawn;
  },
): Promise<ScheduleResult> {
  const stateDir = path.resolve(options.stateDir ?? getStateDir());
  if (!isRuntimeBuildId(targetBuildId)) {
    return { ok: false, code: "FINALIZER_INVALID_TARGET", reason: "targetBuildId 无效" };
  }
  const assessment = options.assessment;
  if (!assessment.selfBusyProof || assessment.blockers.length !== 1 || assessment.blockers[0]!.kind !== "self_turn") {
    return { ok: false, code: "FINALIZER_NOT_SELF_BUSY", reason: "blockers 不是唯一已证明 self-turn" };
  }
  const proof: SelfBusyProof = assessment.selfBusyProof;
  const desired = {
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    targetBuildId,
    originThreadId: proof.threadId,
    originHostId: proof.hostId,
    originProjectId: proof.projectId,
    expectedRuntime: {
      ...(options.runtime?.runtimeBuildId ? { runtimeBuildId: options.runtime.runtimeBuildId } : {}),
      ...(options.runtime?.pid ? { pid: options.runtime.pid } : {}),
      ...(options.runtime?.startedAt ? { startedAt: options.runtime.startedAt } : {}),
    } as ActiveFinalizer["expectedRuntime"],
  };

  const existing = readActiveFinalizer(stateDir, workspace.id);
  if (existing) {
    if (sameSchedulingIdentity(existing, desired)) return { ok: true, job: existing, status: "existing" };
    return { ok: false, code: "FINALIZER_CONFLICT", reason: "已有 active finalizer 与本次 scheduling identity 不一致" };
  }

  const now = Date.now();
  const job: ActiveFinalizer = {
    version: 1,
    jobId: randomUUID(),
    token: randomUUID(),
    ...desired,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + FINALIZER_MAX_LIFETIME_MS).toISOString(),
    status: "scheduled",
  };
  const file = activeFinalizerPath(stateDir, workspace.id);
  if (!writeJsonExclusive(file, job)) {
    const raced = readActiveFinalizer(stateDir, workspace.id);
    if (raced && sameSchedulingIdentity(raced, desired)) return { ok: true, job: raced, status: "existing" };
    return { ok: false, code: "FINALIZER_CONFLICT", reason: "并发创建了不兼容的 active finalizer" };
  }

  try {
    spawnFinalizerWorker(job, { stateDir, spawnImpl: options.spawnImpl });
  } catch (error) {
    // spawn 失败仍走 ownership-checked commit；无 bypass。
    try {
      const failed = commitFinalizerResult(stateDir, job, {
        status: "failed",
        reason: "worker_spawn_failed",
        scheduledAt: job.createdAt,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
      projectFinalizerExecution(workspace.id, job, failed);
    } catch {
      // owner-lost 或 cleanup failure：active/result 可能不完整，仍返回 spawn failed
    }
    return { ok: false, code: "FINALIZER_SPAWN_FAILED", reason: error instanceof Error ? error.message : "spawn failed" };
  }
  return { ok: true, job, status: "scheduled" };
}

export function claimFinalizerWorker(stateDir: string, job: ActiveFinalizer): WorkerClaim {
  const claim: WorkerClaim = {
    version: 1,
    jobId: job.jobId,
    jobToken: job.token,
    workerToken: randomUUID(),
    pid: process.pid,
    claimedAt: new Date().toISOString(),
  };
  if (!writeJsonExclusive(workerClaimPath(stateDir, job.workspaceId), claim)) {
    throw new FinalizerError("FINALIZER_WORKER_CLAIMED", "已有 worker claim，禁止重复启动");
  }
  return claim;
}

export function releaseFinalizerWorkerClaim(stateDir: string, job: ActiveFinalizer, claim: WorkerClaim): boolean {
  const file = workerClaimPath(stateDir, job.workspaceId);
  try {
    const raw = readRegularJson(file, workerClaimSchema);
    if (raw === "missing") return true;
    if (raw === "corrupt") return false;
    if (raw.jobId !== job.jobId || raw.jobToken !== job.token || raw.workerToken !== claim.workerToken) return false;
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** 先确认 exact active ownership，再 durable result，再 owner-safe 删 active。 */
export function commitFinalizerResult(
  stateDir: string,
  job: ActiveFinalizer,
  result: Omit<FinalizerResult, "version" | "jobId" | "workspaceId" | "targetBuildId">,
): FinalizerResult {
  const current = readActiveFinalizer(stateDir, job.workspaceId);
  if (!current || current.jobId !== job.jobId || current.token !== job.token) {
    throw new FinalizerError("FINALIZER_OWNER_LOST", "active finalizer ownership 已丢失，拒绝覆盖 result");
  }
  const full: FinalizerResult = {
    version: 1,
    jobId: job.jobId,
    workspaceId: job.workspaceId,
    targetBuildId: job.targetBuildId,
    ...result,
  };
  const parsed = resultSchema.parse(full);
  atomicWriteJson(finalizerResultPath(stateDir, job.workspaceId), parsed);
  try {
    const still = readActiveFinalizer(stateDir, job.workspaceId);
    if (!still || still.jobId !== job.jobId || still.token !== job.token) {
      throw new FinalizerActiveReleaseError(parsed);
    }
    fs.unlinkSync(activeFinalizerPath(stateDir, job.workspaceId));
  } catch (error) {
    if (error instanceof FinalizerActiveReleaseError) throw error;
    throw new FinalizerActiveReleaseError(parsed);
  }
  return parsed;
}

export function projectFinalizerExecution(workspaceId: string, job: ActiveFinalizer, result: FinalizerResult): void {
  try {
    appendExecutionRecord(workspaceId, {
      taskId: `post_turn_${job.jobId}`,
      iteration: 1,
      changedFiles: [],
      tests: `finalizer ${result.status}: ${result.reason}`,
      exitStatus: result.status === "ok" ? "ok" : result.status === "blocked" ? "blocked" : "failed",
      timestamp: result.finishedAt,
      notes: `target=${job.targetBuildId} workspace=${job.workspaceRoot}`,
    });
  } catch {
    // projection 失败不导致重跑
  }
}

export function stripWorkerEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_SESSION_ID;
  delete env.C2C_STARTUP_LEASE;
  return env;
}

export function targetReleaseEntry(stateDir: string, targetBuildId: string): string {
  return path.join(path.resolve(stateDir), "releases", targetBuildId, "dist", "cli", "index.js");
}

export function assertCanonicalTargetEntry(stateDir: string, targetBuildId: string): string {
  const releaseRoot = path.join(path.resolve(stateDir), "releases", targetBuildId);
  const entry = targetReleaseEntry(stateDir, targetBuildId);
  try {
    const rootLstat = fs.lstatSync(releaseRoot);
    if (!rootLstat.isDirectory() || rootLstat.isSymbolicLink()) throw new Error("release root 无效");
    if (fs.realpathSync(releaseRoot) !== releaseRoot) throw new Error("release root 非 canonical");
    const entryLstat = fs.lstatSync(entry);
    if (!entryLstat.isFile() || entryLstat.isSymbolicLink()) throw new Error("entry 非 regular file");
    if (fs.realpathSync(entry) !== entry) throw new Error("entry 非 canonical");
  } catch (error) {
    throw new FinalizerError("FINALIZER_TARGET_MISSING", error instanceof Error ? error.message : "target entry 无效");
  }
  const installed = readCurrentInstall(stateDir, "fast");
  if (!installed || installed.runtimeBuildId !== targetBuildId) {
    throw new FinalizerError("FINALIZER_TARGET_CHANGED", "current install 与 targetBuildId 不一致");
  }
  return entry;
}

export function spawnFinalizerWorker(job: ActiveFinalizer, options: { stateDir?: string; spawnImpl?: typeof spawn } = {}): number {
  const stateDir = path.resolve(options.stateDir ?? getStateDir());
  const entry = assertCanonicalTargetEntry(stateDir, job.targetBuildId);
  const spawnFn = options.spawnImpl ?? spawn;
  const child = spawnFn(process.execPath, [entry, "post-turn-finalizer", "run", "--workspace", job.workspaceRoot], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: stripWorkerEnv(),
  });
  child.unref();
  return child.pid ?? 0;
}

export type WorkerGateCheck =
  | { proceed: true }
  | { proceed: false; status: "ok" | "blocked" | "failed"; reason: string };

export function assertActiveJobOwnership(stateDir: string, expected: ActiveFinalizer): ActiveFinalizer {
  const current = readActiveFinalizer(stateDir, expected.workspaceId);
  if (!current || current.jobId !== expected.jobId || current.token !== expected.token) {
    throw new FinalizerError("FINALIZER_OWNER_LOST", "active finalizer ownership 已丢失");
  }
  return current;
}

export async function verifyFinalizerPreconditions(job: ActiveFinalizer, stateDir: string): Promise<WorkerGateCheck> {
  const workspace = new Workspace(job.workspaceRoot);
  if (workspace.id !== job.workspaceId) return { proceed: false, status: "blocked", reason: "runtime_replaced" };
  const installed = readCurrentInstall(stateDir, "fast");
  if (!installed || installed.runtimeBuildId !== job.targetBuildId) {
    return { proceed: false, status: "blocked", reason: "target_changed" };
  }
  let pending;
  try { pending = readPending(workspace); }
  catch { return { proceed: false, status: "failed", reason: "pending_corrupt" }; }
  const observation = await findBridgeObservation(workspace.id);
  if (observation.state === "healthy") {
    const runtime = observation.runtime;
    if (runtime.runtimeBuildId === job.targetBuildId) {
      return { proceed: false, status: "ok", reason: "already_converged" };
    }
    const exp = job.expectedRuntime;
    if ((exp.runtimeBuildId && runtime.runtimeBuildId !== exp.runtimeBuildId) ||
        (exp.pid && runtime.pid !== exp.pid) ||
        (exp.startedAt && runtime.startedAt !== exp.startedAt)) {
      return { proceed: false, status: "blocked", reason: "runtime_replaced" };
    }
  }
  if (!pending) return { proceed: false, status: "blocked", reason: "pending_changed" };
  if (pending.targetBuildId !== job.targetBuildId) {
    return { proceed: false, status: "blocked", reason: "pending_changed" };
  }
  if (pending.reason !== "busy") {
    return { proceed: false, status: "blocked", reason: "pending_changed" };
  }
  return { proceed: true };
}

export type FinalizerAttemptOutcome =
  | { kind: "wait"; reason: "origin_still_active" }
  | { kind: "terminal"; result: Omit<FinalizerResult, "version" | "jobId" | "workspaceId" | "targetBuildId"> };

export async function runFinalizerAttempt(
  job: ActiveFinalizer,
  stateDir: string,
  deps: {
    inspect?: typeof desktopIpc.inspect;
    rollout?: (opts: { workspaceRoot?: string }) => Promise<{
      targetBuildId: string;
      workspaces: Array<{ workspaceId: string; status: string; reason?: string }>;
    }>;
    now?: () => number;
  } = {},
): Promise<FinalizerAttemptOutcome> {
  const inspect = deps.inspect ?? desktopIpc.inspect.bind(desktopIpc);
  const doRollout = deps.rollout ?? (await import("./rollout.js")).rollout;
  const now = deps.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();

  // 每次 poll 前确认 ownership
  try {
    assertActiveJobOwnership(stateDir, job);
  } catch (error) {
    return {
      kind: "terminal",
      result: {
        status: "failed",
        reason: error instanceof FinalizerError ? error.code.toLowerCase() : "owner_lost",
        scheduledAt: job.createdAt, startedAt, finishedAt: new Date(now()).toISOString(),
      },
    };
  }

  if (Date.parse(job.expiresAt) <= now()) {
    return {
      kind: "terminal",
      result: {
        status: "blocked", reason: "timeout_self_busy",
        scheduledAt: job.createdAt, startedAt, finishedAt: new Date(now()).toISOString(),
      },
    };
  }

  let observed;
  try {
    observed = await inspect({
      threadId: job.originThreadId,
      hostId: job.originHostId,
      projectId: job.originProjectId,
      workspaceRoot: job.workspaceRoot,
    });
  } catch (error) {
    if (error && typeof error === "object" && (error as { code?: unknown }).code === "DESKTOP_BUSY") {
      return { kind: "wait", reason: "origin_still_active" };
    }
    return {
      kind: "terminal",
      result: {
        status: "blocked", reason: "origin_unknown",
        scheduledAt: job.createdAt, startedAt, finishedAt: new Date(now()).toISOString(),
      },
    };
  }
  if (observed.runtimeStatus === "active" || observed.runtimeStatus === "inProgress") {
    return { kind: "wait", reason: "origin_still_active" };
  }
  if (observed.runtimeStatus !== "idle") {
    return {
      kind: "terminal",
      result: {
        status: "blocked", reason: "origin_unknown",
        scheduledAt: job.createdAt, startedAt, finishedAt: new Date(now()).toISOString(),
      },
    };
  }

  // origin idle 后、rollout 前再次确认 ownership
  try {
    assertActiveJobOwnership(stateDir, job);
  } catch {
    return {
      kind: "terminal",
      result: {
        status: "failed", reason: "owner_lost",
        scheduledAt: job.createdAt, startedAt, finishedAt: new Date(now()).toISOString(),
      },
    };
  }

  const gate = await verifyFinalizerPreconditions(job, stateDir);
  if (!gate.proceed) {
    return {
      kind: "terminal",
      result: {
        status: gate.status, reason: gate.reason,
        scheduledAt: job.createdAt, startedAt, finishedAt: new Date(now()).toISOString(),
      },
    };
  }

  // precondition await 期间 ownership 可能丢失：rollout 前最终门禁。
  try {
    assertActiveJobOwnership(stateDir, job);
  } catch {
    return {
      kind: "terminal",
      result: {
        status: "failed", reason: "owner_lost",
        scheduledAt: job.createdAt, startedAt, finishedAt: new Date(now()).toISOString(),
      },
    };
  }

  let rolloutResult;
  try {
    rolloutResult = await doRollout({ workspaceRoot: job.workspaceRoot });
  } catch (error) {
    return {
      kind: "terminal",
      result: {
        status: "failed", reason: error instanceof Error ? error.message.slice(0, 200) : "rollout_error",
        scheduledAt: job.createdAt, startedAt, finishedAt: new Date(now()).toISOString(),
      },
    };
  }
  const item = rolloutResult.workspaces.find(w => w.workspaceId === job.workspaceId);
  const workspaceStatus = item?.status ?? "error";
  const reason = item?.reason;
  const okStatuses = new Set(["upgraded", "current", "stopped"]);
  return {
    kind: "terminal",
    result: {
      status: okStatuses.has(workspaceStatus) ? "ok" : workspaceStatus === "error" ? "failed" : "blocked",
      reason: reason ?? workspaceStatus,
      scheduledAt: job.createdAt, startedAt, finishedAt: new Date(now()).toISOString(),
      rollout: { targetBuildId: rolloutResult.targetBuildId, workspaceStatus, ...(reason ? { reason } : {}) },
    },
  };
}

export type { SelfBusyProof };
