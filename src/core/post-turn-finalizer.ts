import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Workspace } from "../workspace/manager.js";
import { assertMaintenanceHandle, type MaintenanceLockHandle } from "./maintenance-lock.js";

import { HEX64 } from "./hex.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKSPACE_ID = /^[a-f0-9]{12}$/;

export const FINALIZER_RETIRED = "FINALIZER_RETIRED";

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

export const workerClaimSchema = z.object({
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
    canonicalNames(path.dirname(file), path.extname(file) === ".claim" ? /^[a-f0-9]{12}\.claim$/ : /^[a-f0-9]{12}\.json$/);
    const lstat = fs.lstatSync(file);
    if (!lstat.isFile() || lstat.isSymbolicLink()) return "corrupt";
    if (fs.realpathSync(file) !== file) return "corrupt";
    return schema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return "corrupt";
  }
}

export function readActiveFinalizer(stateDir: string, workspaceId: string): ActiveFinalizer | null {
  const raw = readRegularJson(activeFinalizerPath(stateDir, workspaceId), activeFinalizerSchema);
  if (raw === "missing") return null;
  if (raw === "corrupt") throw new FinalizerError("FINALIZER_STATE_CORRUPT", "active finalizer 状态损坏或 schema 无效");
  if (raw.workspaceId !== workspaceId) throw new FinalizerError("FINALIZER_STATE_CORRUPT", "finalizer workspace identity 不匹配");
  const resolved = new Workspace(raw.workspaceRoot);
  if (resolved.id !== workspaceId || resolved.root !== raw.workspaceRoot) throw new FinalizerError("FINALIZER_STATE_CORRUPT", "workspaceRoot 与 workspaceId 不匹配");
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


const fileIdentitySchema = z.object({ dev: z.number().int().nonnegative().finite(), ino: z.number().int().nonnegative().finite(), sha256: z.string().regex(HEX64) }).strict();
export const finalizerRetirementSchema = z.object({
  version: z.literal(1), workspaceId: z.string().regex(WORKSPACE_ID), active: activeFinalizerSchema,
  claim: workerClaimSchema, activeFile: fileIdentitySchema, claimFile: fileIdentitySchema, retiredAt: z.string().datetime(),
}).strict();
export type FinalizerRetirement = z.infer<typeof finalizerRetirementSchema>;
export function finalizerRetirementPath(stateDir: string, workspaceId: string): string {
  return path.join(path.resolve(stateDir), "post-turn-finalizer-retirements", `${workspaceId}.json`);
}
function canonicalNames(folder: string, pattern = /^[a-f0-9]{12}\.json$/): string[] {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(folder); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(folder) !== folder) throw new FinalizerError("FINALIZER_STATE_CORRUPT", "finalizer directory is not canonical");
  const names = fs.readdirSync(folder).sort();
  if (names.some(name => !pattern.test(name))) throw new FinalizerError("FINALIZER_STATE_CORRUPT", "finalizer filename is not canonical");
  return names;
}
function snapshot<T>(file: string, schema: z.ZodType<T>): { value: T; identity: z.infer<typeof fileIdentitySchema> } {
  canonicalNames(path.dirname(file), path.extname(file) === ".claim" ? /^[a-f0-9]{12}\.claim$/ : /^[a-f0-9]{12}\.json$/);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file) throw new FinalizerError("FINALIZER_STATE_CORRUPT", "finalizer file is not canonical");
  const bytes = fs.readFileSync(file), after = fs.lstatSync(file);
  if (stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new FinalizerError("FINALIZER_OWNER_LOST", "finalizer replaced during read");
  return { value: schema.parse(JSON.parse(bytes.toString("utf8"))), identity: { dev: stat.dev, ino: stat.ino, sha256: createHash("sha256").update(bytes).digest("hex") } };
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function validateIdentity(active: ActiveFinalizer, claim: WorkerClaim, workspaceId: string): void {
  const workspace = new Workspace(active.workspaceRoot);
  if (active.workspaceId !== workspaceId || workspace.id !== workspaceId || workspace.root !== active.workspaceRoot || claim.jobId !== active.jobId || claim.jobToken !== active.token) throw new FinalizerError("FINALIZER_STATE_CORRUPT", "retirement identity mismatch");
}
export function readFinalizerRetirement(stateDir: string, workspaceId: string): FinalizerRetirement | null {
  canonicalNames(path.dirname(finalizerRetirementPath(stateDir, workspaceId)));
  const raw = readRegularJson(finalizerRetirementPath(stateDir, workspaceId), finalizerRetirementSchema);
  if (raw === "missing") return null;
  if (raw === "corrupt") throw new FinalizerError("FINALIZER_STATE_CORRUPT", "retirement ledger corrupt");
  if (raw.workspaceId !== workspaceId) throw new FinalizerError("FINALIZER_STATE_CORRUPT", "retirement filename identity mismatch");
  validateIdentity(raw.active, raw.claim, workspaceId);
  if (Date.parse(raw.active.expiresAt) > Date.parse(raw.retiredAt)) throw new FinalizerError("FINALIZER_STATE_CORRUPT", "retirement not expired");
  const claim = snapshot(workerClaimPath(stateDir, workspaceId), workerClaimSchema);
  if (!same(claim.value, raw.claim) || !same(claim.identity, raw.claimFile)) throw new FinalizerError("FINALIZER_OWNER_LOST", "retirement claim replaced");
  if (readActiveFinalizer(stateDir, workspaceId)) {
    const active = snapshot(activeFinalizerPath(stateDir, workspaceId), activeFinalizerSchema);
    if (!same(active.value, raw.active) || !same(active.identity, raw.activeFile)) throw new FinalizerError("FINALIZER_OWNER_LOST", "retirement active replaced");
  }
  return raw;
}
/** Historical committed dead proof must not be reprobed after PID reuse. */
export function validateFinalizerRetirements(stateDir: string): void {
  for (const name of canonicalNames(path.join(path.resolve(stateDir), "post-turn-finalizers"))) readActiveFinalizer(stateDir, name.slice(0, -5));
  for (const name of canonicalNames(path.join(path.resolve(stateDir), "post-turn-finalizer-retirements"))) readFinalizerRetirement(stateDir, name.slice(0, -5));
  for (const name of canonicalNames(path.join(path.resolve(stateDir), "post-turn-finalizer-workers"), /^[a-f0-9]{12}\.claim$/)) {
    const workspaceId = name.slice(0, -6);
    const claim = snapshot(workerClaimPath(stateDir, workspaceId), workerClaimSchema).value;
    const active = readActiveFinalizer(stateDir, workspaceId);
    if (active) validateIdentity(active, claim, workspaceId);
    else if (!readFinalizerRetirement(stateDir, workspaceId)) throw new FinalizerError("FINALIZER_STATE_CORRUPT", "orphan worker claim has no retirement proof");
  }
}
export interface FinalizerRetirementOptions {
  now?: () => number;
  /** Test only: only ESRCH proves death. */
  probeProcess?: (pid: number) => void;
  hooks?: {
    beforeLedger?: (job: ActiveFinalizer) => void;
    afterLedger?: (job: ActiveFinalizer) => void;
    beforeActiveRemoval?: (job: ActiveFinalizer) => void;
  };
}
export function retireLegacyFinalizers(stateDir: string, handle: MaintenanceLockHandle, options: FinalizerRetirementOptions = {}): ActiveFinalizer[] {
  stateDir = path.resolve(stateDir);
  assertMaintenanceHandle(stateDir, handle);
  validateFinalizerRetirements(stateDir);
  const retired: ActiveFinalizer[] = [];
  for (const name of canonicalNames(path.join(stateDir, "post-turn-finalizers"))) {
    const workspaceId = name.slice(0, -5), activePath = activeFinalizerPath(stateDir, workspaceId);
    const active = snapshot(activePath, activeFinalizerSchema), job = active.value;
    readActiveFinalizer(stateDir, workspaceId);
    const claimPath = workerClaimPath(stateDir, workspaceId);
    let claim: ReturnType<typeof snapshot<WorkerClaim>>;
    try { claim = snapshot(claimPath, workerClaimSchema); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    validateIdentity(job, claim.value, workspaceId);
    if (Date.parse(job.expiresAt) > (options.now ?? Date.now)()) continue;
    const existing = readFinalizerRetirement(stateDir, workspaceId);
    const existingLedgerSnapshot = existing ? snapshot(finalizerRetirementPath(stateDir, workspaceId), finalizerRetirementSchema) : null;
    if (!existing) {
      try { (options.probeProcess ?? (pid => { process.kill(pid, 0); }))(claim.value.pid); continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; }
    }
    const assertExact = () => {
      assertMaintenanceHandle(stateDir, handle);
      if (!same(snapshot(activePath, activeFinalizerSchema), active) || !same(snapshot(claimPath, workerClaimSchema), claim)) throw new FinalizerError("FINALIZER_OWNER_LOST", "active/claim replaced during retirement");
    };
    options.hooks?.beforeLedger?.(job);
    assertExact();
    if (!existing) {
      const ledgerPath = finalizerRetirementPath(stateDir, workspaceId), folder = path.dirname(ledgerPath);
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      canonicalNames(folder);
      assertExact();
      const ledger: FinalizerRetirement = { version: 1, workspaceId, active: job, claim: claim.value, activeFile: active.identity, claimFile: claim.identity, retiredAt: new Date((options.now ?? Date.now)()).toISOString() };
      const fd = fs.openSync(ledgerPath, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(finalizerRetirementSchema.parse(ledger))); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    }
    const ledgerSnapshot = existingLedgerSnapshot ?? snapshot(finalizerRetirementPath(stateDir, workspaceId), finalizerRetirementSchema);
    const assertLedger = () => {
      if (!same(snapshot(finalizerRetirementPath(stateDir, workspaceId), finalizerRetirementSchema), ledgerSnapshot)) throw new FinalizerError("FINALIZER_OWNER_LOST", "retirement ledger replaced");
      if (!readFinalizerRetirement(stateDir, workspaceId)) throw new FinalizerError("FINALIZER_STATE_CORRUPT", "retirement ledger missing");
    };
    options.hooks?.afterLedger?.(job);
    assertExact();
    assertLedger();
    options.hooks?.beforeActiveRemoval?.(job);
    assertExact();
    assertLedger();
    fs.unlinkSync(activePath);
    assertMaintenanceHandle(stateDir, handle);
    readFinalizerRetirement(stateDir, workspaceId);
    retired.push(job);
  }
  return retired;
}
