import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getStateDir } from "../config/paths.js";
import { readRuntimeState, type RuntimeState } from "../bridge/runtime.js";
import { processProbeSchema, type ProcessProbe } from "./process-probe.js";
import type { DaemonSpawnResult } from "./daemon-spawn.js";

// Diagnostic only: never imported by delivery, GC/reference selection or maintenance gates.
const identitySchema = z.object({
  workspaceId: z.string().regex(/^[a-f0-9]{12}$/),
  workspaceRoot: z.string().max(32768).refine(value => path.isAbsolute(value) && path.normalize(value) === value),
  pid: z.number().int().positive(), startedAt: z.string().datetime(),
  runtimeBuildId: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict();
type Identity = z.infer<typeof identitySchema>;
const launchSchema = z.object({ entryPath: z.string().max(32768).refine(path.isAbsolute),
  buildId: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict();
export type LaunchIdentity = z.infer<typeof launchSchema>;
const spawnSchema = z.object({
  version: z.literal(1), runtime: identitySchema, spawnAttemptId: z.string().uuid(),
  mode: z.enum(["helper-breakaway", "helper-wmi", "posix", "direct", "unknown"]),
  helperInJob: z.boolean().nullable(), spawner: processProbeSchema,
  helper: processProbeSchema.nullable(), finalProcess: processProbeSchema, healthyProcess: processProbeSchema,
  launch: launchSchema, observedAt: z.string().datetime(),
}).strict().refine(value => value.finalProcess.pid === value.runtime.pid && value.healthyProcess.pid === value.runtime.pid &&
  (value.launch.buildId === null || value.launch.buildId === value.runtime.runtimeBuildId));
export type BridgeSpawnProvenance = z.infer<typeof spawnSchema>;
export const shutdownReasonSchema = z.enum(["admin_shutdown", "SIGINT", "SIGTERM", "restart", "rollout", "close"]);
export type ShutdownReason = z.infer<typeof shutdownReasonSchema>;
const shutdownSchema = z.object({ version: z.literal(1), runtime: identitySchema,
  reason: shutdownReasonSchema, observedAt: z.string().datetime() }).strict();

function identity(runtime: Pick<RuntimeState, "workspaceId" | "workspaceRoot" | "pid" | "startedAt" | "runtimeBuildId">): Identity {
  return identitySchema.parse({ workspaceId: runtime.workspaceId, workspaceRoot: runtime.workspaceRoot,
    pid: runtime.pid, startedAt: runtime.startedAt, runtimeBuildId: runtime.runtimeBuildId ?? null });
}
function exact(a: Identity, b: Identity): boolean {
  return a.workspaceId === b.workspaceId && a.workspaceRoot === b.workspaceRoot && a.pid === b.pid &&
    a.startedAt === b.startedAt && a.runtimeBuildId === b.runtimeBuildId;
}
function conflict(): never { throw new Error("BRIDGE_PROVENANCE_CONFLICT"); }

export function bridgeProvenanceFile(workspaceId: string, kind: "spawn" | "shutdown" = "spawn"): string {
  if (!/^[a-f0-9]{12}$/.test(workspaceId)) conflict();
  return path.join(getStateDir(), "bridge-spawn-provenance", `${workspaceId}${kind === "shutdown" ? ".shutdown" : ""}.json`);
}

/** Check every existing ancestor, including junctions; no state-dir creation on reads. */
function assertPath(file: string): void {
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (current === file ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()) ||
        fs.realpathSync.native(current) !== current) conflict();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
function read<T>(file: string, schema: z.ZodType<T>): T | null {
  assertPath(file);
  const directory = path.dirname(file);
  if (fs.existsSync(directory) && fs.readdirSync(directory).some(name => name.startsWith(`${path.basename(file)}.`) && name.endsWith(".tmp"))) conflict();
  try {
    if (fs.statSync(file).size > 512 * 1024) conflict();
    return schema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** One bounded file per kind. No stale-lock reclaim: diagnostic failure must not affect Bridge liveness. */
function write<T extends { runtime: Identity }>(file: string, schema: z.ZodType<T>, value: T): void {
  const current = readRuntimeState(value.runtime.workspaceId);
  if (!current || !exact(identity(current), value.runtime)) conflict();
  assertPath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  assertPath(file);
  const lock = `${file}.lock`;
  assertPath(lock);
  const nonce = randomUUID();
  const lockFd = fs.openSync(lock, "wx", 0o600);
  const held = fs.fstatSync(lockFd);
  const ownsLock = (): boolean => {
    assertPath(lock);
    const stat = fs.lstatSync(lock);
    return stat.dev === held.dev && stat.ino === held.ino && fs.readFileSync(lock, "utf8") === nonce;
  };
  try {
    fs.writeFileSync(lockFd, nonce); fs.fsyncSync(lockFd);
    const previous = read(file, schema);
    // A delayed old process cannot replace newer diagnostics, even after its PID is reused.
    if (previous && !exact(previous.runtime, value.runtime) &&
      (previous.runtime.workspaceId !== value.runtime.workspaceId || previous.runtime.workspaceRoot !== value.runtime.workspaceRoot ||
        Date.parse(previous.runtime.startedAt) >= Date.parse(value.runtime.startedAt))) conflict();
    const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
    const beforeStat = before === null ? null : fs.lstatSync(file);
    const temp = `${file}.${nonce}.tmp`;
    const fd = fs.openSync(temp, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(schema.parse(value))); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    // On failure leave temp evidence; never silently replace corrupt/replaced state.
    assertPath(file);
    const saved = readRuntimeState(value.runtime.workspaceId);
    if (!saved || !exact(identity(saved), value.runtime) || !ownsLock()) conflict();
    if (before ? !fs.readFileSync(file).equals(before) : fs.existsSync(file)) conflict();
    if (beforeStat) {
      const afterStat = fs.lstatSync(file);
      if (beforeStat.dev !== afterStat.dev || beforeStat.ino !== afterStat.ino) conflict();
    }
    fs.renameSync(temp, file);
    if (process.platform !== "win32") {
      const dirFd = fs.openSync(path.dirname(file), "r");
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    }
  } finally {
    fs.closeSync(lockFd);
    if (!ownsLock()) conflict();
    fs.unlinkSync(lock);
  }
}

export function persistSpawnProvenance(runtime: RuntimeState, workspace: { id: string; root: string },
  spawn: DaemonSpawnResult, launch: LaunchIdentity, healthyProcess: ProcessProbe): void {
  if (runtime.pid !== spawn.pid || runtime.workspaceId !== workspace.id || runtime.workspaceRoot !== workspace.root ||
    (launch.buildId !== null && launch.buildId !== runtime.runtimeBuildId)) conflict();
  if (spawn.finalProcess.creationTime !== null && healthyProcess.creationTime !== null &&
    (spawn.finalProcess.creationTime !== healthyProcess.creationTime || spawn.finalProcess.executable !== healthyProcess.executable)) conflict();
  if ([spawn.finalProcess, healthyProcess].some(value => value.status === "missing" || value.errors.process === "IDENTITY_CHANGED")) conflict();
  const value = spawnSchema.parse({ version: 1, runtime: identity(runtime), spawnAttemptId: spawn.spawnAttemptId,
    mode: spawn.mode, helperInJob: spawn.helperInJob, spawner: spawn.spawner, helper: spawn.helper,
    finalProcess: spawn.finalProcess, healthyProcess, launch, observedAt: new Date().toISOString() });
  write(bridgeProvenanceFile(runtime.workspaceId), spawnSchema, value);
}

export function recordShutdownIntent(runtime: RuntimeState, reason: ShutdownReason): void {
  const value = shutdownSchema.parse({ version: 1, runtime: identity(runtime), reason, observedAt: new Date().toISOString() });
  write(bridgeProvenanceFile(runtime.workspaceId, "shutdown"), shutdownSchema, value);
}

type Diagnostic<T> = { status: "matching"; record: T } | { status: "absent" | "conflict" };
function diagnostic<T extends { runtime: Identity }>(runtime: RuntimeState, file: string, schema: z.ZodType<T>): Diagnostic<T> {
  try {
    if (fs.existsSync(`${file}.lock`)) conflict();
    const value = read(file, schema);
    return value === null ? { status: "absent" } : exact(value.runtime, identity(runtime))
      ? { status: "matching", record: value } : { status: "conflict" };
  } catch { return { status: "conflict" }; }
}
export function readBridgeProvenance(runtime: RuntimeState) {
  try {
    return { spawn: diagnostic(runtime, bridgeProvenanceFile(runtime.workspaceId), spawnSchema),
      shutdown: diagnostic(runtime, bridgeProvenanceFile(runtime.workspaceId, "shutdown"), shutdownSchema) };
  } catch { return { spawn: { status: "conflict" as const }, shutdown: { status: "conflict" as const } }; }
}
