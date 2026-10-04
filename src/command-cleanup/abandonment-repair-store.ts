import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { getStateDir } from "../config/paths.js";
import { processProbeSchema, probeProcess, isProcessProvenMissing, type ProcessProbe } from "../process/process-probe.js";
import { resolveDaemonSpawnHelperPath, resolveDaemonSpawnPython } from "../process/daemon-spawn.js";
import { assertMaintenanceHandle, type MaintenanceLockHandle } from "../core/maintenance-lock.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), hex = z.string().regex(/^[a-f0-9]{64}$/);
const ids = z.array(id).min(1).max(100).refine(v => new Set(v).size === v.length && [...v].sort().join() === v.join());
const fingerprintSchema = z.object({ dev: z.string().max(128).regex(/^\d+$/), ino: z.string().max(128).regex(/^\d+$/),
  size: z.number().int().nonnegative().max(262144), mtime: z.string().max(128).regex(/^\d+$/), ctime: z.string().max(128).regex(/^\d+$/), sha256: hex }).strict();
export const repairProofSchema = z.object({
  version: z.literal(1), workspaceId: z.string().regex(/^[a-f0-9]{12}$/), workspaceRoot: z.string().min(1),
  commandIds: ids, repairCommandIds: ids.refine(v => v.length <= 10),
  confirmationSha256: hex, bindingSha256: hex, deliveriesSha256: hex, contextSha256: hex,
  observations: z.array(z.object({ commandId: id, fingerprint: fingerprintSchema,
    observedAt: z.string().datetime(), confirmedAt: z.string().datetime(), reason: z.literal("ZERO_BYTE_OWNER_UNKNOWN") }).strict()).min(1).max(10),
}).strict().superRefine((v, ctx) => {
  if (v.repairCommandIds.some(x => !v.commandIds.includes(x)) || v.observations.length !== v.repairCommandIds.length ||
      v.observations.some((x, i) => x.commandId !== v.repairCommandIds[i] || x.fingerprint.size !== 0 ||
        Date.parse(x.confirmedAt) - Date.parse(x.observedAt) < 100 || Date.parse(x.confirmedAt) - Date.parse(x.observedAt) > 10000))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid bounded repair observation" });
});
export type RepairProof = z.infer<typeof repairProofSchema>;
type Fingerprint = z.infer<typeof fingerprintSchema>;
const identitySchema = z.object({ pid: z.number().int().positive().max(0xffffffff), creationTime: z.string().min(1).max(128), executable: z.string().min(1).max(32768) }).strict();
const normalOwnerSchema = z.object({ pid: z.number().int().positive(), nonce: z.string().uuid() }).strict();
const intentSchema = z.object({ version: z.literal(1), repairId: z.string().uuid(), commandId: id, proof: repairProofSchema,
  repairConfirmationSha256: hex, normalOwner: normalOwnerSchema }).strict();
const fenceSchema = intentSchema.extend({ owner: identitySchema }).strict();
const reclaimSchema = z.object({ version: z.literal(1), workspaceId: z.string().regex(/^[a-f0-9]{12}$/),
  commandId: id, repairId: z.string().uuid(), owner: identitySchema, nonce: z.string().uuid(),
  target: fingerprintSchema, createdAt: z.string().max(32).datetime() }).strict();
const journalSchema = intentSchema.extend({ state: z.enum(["prepared", "adopted_pending", "completed"]),
  quarantine: fingerprintSchema.nullable(), abandonmentBatchSha256: hex.nullable() }).strict().refine(v =>
  v.state === "prepared" ? v.quarantine === null && v.abandonmentBatchSha256 === null :
    v.quarantine !== null && (v.state === "completed" ? v.abandonmentBatchSha256 !== null : v.abandonmentBatchSha256 === null));
type Fence = z.infer<typeof fenceSchema>;
type Journal = z.infer<typeof journalSchema>;
export type RepairOptions = {
  probe?: (pid: number, creation?: string) => Promise<ProcessProbe>;
  sleep?: (ms: number) => Promise<void>;
  /** Deterministic crash/race injection; no CLI/environment switch exposes it. */
  checkpoint?: (point: string, commandId: string) => void;
};
export class AbandonmentRepairError extends Error {
  readonly code = "DESKTOP_ABANDONMENT_REPAIR_BLOCKED";
  constructor() { super("历史损坏锁修复无法安全确认；保留所有证据并停止。"); }
}
export function repairAssert(value: unknown): asserts value { if (!value) throw new AbandonmentRepairError(); }
export const repairDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function present(file: string): boolean {
  try { fs.lstatSync(file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}
function canonical(file: string): void {
  const resolved = path.resolve(file); repairAssert(resolved === file);
  for (let p = resolved; ; p = path.dirname(p)) {
    if (present(p)) {
      const s = fs.lstatSync(p); repairAssert(!s.isSymbolicLink() && fs.realpathSync.native(p) === p);
      if (p !== resolved) repairAssert(s.isDirectory());
    }
    if (path.dirname(p) === p) break;
  }
}
export function repairPaths(workspaceId: string, commandId: string, stateDir = getStateDir()) {
  repairAssert(/^[a-f0-9]{12}$/.test(workspaceId) && id.safeParse(commandId).success);
  const state = path.resolve(stateDir), lock = path.join(state, "command-cleanup", workspaceId, `${commandId}.json.lock`);
  return { lock, fence: `${lock}.repair`, reclaim: `${lock}.repair.reclaim`,
    directory: path.join(state, "desktop-lock-repairs", workspaceId),
    journal: path.join(state, "desktop-lock-repairs", workspaceId, `${commandId}.json`) };
}
export function repairSnapshot(file: string): { bytes: Buffer; fingerprint: Fingerprint } {
  canonical(file);
  const before = fs.lstatSync(file, { bigint: true });
  repairAssert(before.isFile() && before.nlink === 1n && before.size <= 262144n);
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd, { bigint: true }), bytes = fs.readFileSync(fd), after = fs.lstatSync(file, { bigint: true });
    for (const x of [before, after]) repairAssert(x.dev === stat.dev && x.ino === stat.ino && x.size === stat.size && x.mtimeNs === stat.mtimeNs && x.ctimeNs === stat.ctimeNs);
    return { bytes, fingerprint: { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size),
      mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs), sha256: createHash("sha256").update(bytes).digest("hex") } };
  } finally { fs.closeSync(fd); }
}
function equalFile(file: string, expected: ReturnType<typeof repairSnapshot>): void { repairAssert(isDeepStrictEqual(repairSnapshot(file), expected)); }
function exactUnlink(file: string, expected: ReturnType<typeof repairSnapshot>): void { equalFile(file, expected); fs.unlinkSync(file); }
function exclusive(file: string, value: unknown): ReturnType<typeof repairSnapshot> {
  canonical(file); const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return repairSnapshot(file);
}
function replace(file: string, value: unknown, expected: ReturnType<typeof repairSnapshot>): ReturnType<typeof repairSnapshot> {
  const temp = `${file}.tmp`; exclusive(temp, value); equalFile(file, expected); fs.renameSync(temp, file); return repairSnapshot(file);
}
function parseFile<T>(file: string, schema: z.ZodType<T>): { value: T; snapshot: ReturnType<typeof repairSnapshot> } {
  const snapshot = repairSnapshot(file), parsed = schema.safeParse(JSON.parse(snapshot.bytes.toString("utf8")));
  repairAssert(parsed.success); return { value: parsed.data, snapshot };
}
function intent(value: Fence | Journal): z.infer<typeof intentSchema> {
  const { version, repairId, commandId, proof, repairConfirmationSha256, normalOwner } = value;
  return intentSchema.parse({ version, repairId, commandId, proof, repairConfirmationSha256, normalOwner });
}
function validateIntent(value: z.infer<typeof intentSchema>, workspaceId: string, commandId: string): void {
  repairAssert(value.commandId === commandId && value.proof.workspaceId === workspaceId && value.proof.repairCommandIds.includes(commandId) &&
    repairDigest(value.proof) === value.repairConfirmationSha256);
}
function quarantineFile(value: z.infer<typeof intentSchema>): string { return path.join(repairPaths(value.proof.workspaceId, value.commandId).directory, `${value.repairId}.lock`); }
function assertResidue(workspaceId: string, commandId: string): void {
  const p = repairPaths(workspaceId, commandId), journal = p.lock.slice(0, -5);
  canonical(p.lock); canonical(p.journal);
  repairAssert(!present(journal) && !present(`${p.lock}.reclaim`) && !present(`${p.fence}.tmp`) && !present(`${p.journal}.tmp`));
  if (present(path.dirname(journal))) repairAssert(!fs.readdirSync(path.dirname(journal)).some(n => n.startsWith(`${path.basename(journal)}.`) && n.endsWith(".tmp")));
}
function probe(options: RepairOptions) { return options.probe ?? ((pid: number, creation?: string) => probeProcess(pid, resolveDaemonSpawnPython(), resolveDaemonSpawnHelperPath(), creation)); }
async function missing(owner: Fence["owner"], options: RepairOptions): Promise<void> {
  const p = processProbeSchema.parse(await probe(options)(owner.pid, owner.creationTime));
  repairAssert(p.pid === owner.pid && isProcessProvenMissing(p));
}
async function self(options: RepairOptions): Promise<Fence["owner"]> {
  const p = processProbeSchema.parse(await probe(options)(process.pid));
  repairAssert(p.pid === process.pid && p.status === "identified" && p.creationTime && p.executable && !p.errors.creationTime && !p.errors.executable);
  return { pid: p.pid, creationTime: p.creationTime, executable: p.executable };
}

function readReclaim(workspaceId: string, commandId: string, fence: ReturnType<typeof parseFile<Fence>>) {
  const file = repairPaths(workspaceId, commandId).reclaim;
  const claim = parseFile(file, reclaimSchema);
  repairAssert(claim.value.workspaceId === workspaceId && claim.value.commandId === commandId &&
    claim.value.repairId === fence.value.repairId && isDeepStrictEqual(claim.value.target, fence.snapshot.fingerprint));
  return claim;
}

// Adapt the supervisor's strict Windows ACL pattern; never alter a pre-existing ordinary lifecycle directory ACL.
function privateAudit(target: string, directory: boolean): void {
  canonical(target);
  if (process.platform !== "win32") { fs.chmodSync(target, directory ? 0o700 : 0o600); return; }
  const ps = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = String.raw`$ErrorActionPreference='Stop'
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$target=$env:C2C_REPAIR_ACL_TARGET
$sections=[System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner
$acl=if($env:C2C_REPAIR_ACL_DIRECTORY -eq '1'){[System.IO.Directory]::GetAccessControl($target,$sections)}else{[System.IO.File]::GetAccessControl($target,$sections)}
if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'ACL_OWNER_UNKNOWN'}
$inheritance=if($env:C2C_REPAIR_ACL_DIRECTORY -eq '1'){[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[System.Security.AccessControl.InheritanceFlags]::None}
function Test-PrivateAcl($candidate){
  $rules=@($candidate.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))
  return ($candidate.AreAccessRulesProtected -and $candidate.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $sid.Value -and $rules.Count -eq 1 -and $rules[0].IdentityReference.Value -eq $sid.Value -and -not $rules[0].IsInherited -and $rules[0].AccessControlType -eq 'Allow' -and [int64]$rules[0].FileSystemRights -eq [int64][System.Security.AccessControl.FileSystemRights]::FullControl -and $rules[0].InheritanceFlags -eq $inheritance -and $rules[0].PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None)
}
# Reapplying even the same directory DACL can change child journal ctime on Windows.
if(Test-PrivateAcl $acl){[Console]::Write('OK');exit 0}
$acl.SetAccessRuleProtection($true,$false)
foreach($r in @($acl.Access)){[void]$acl.RemoveAccessRuleSpecific($r)}
$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::FullControl,$inheritance,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)
[void]$acl.AddAccessRule($rule)
if($env:C2C_REPAIR_ACL_DIRECTORY -eq '1'){[System.IO.Directory]::SetAccessControl($target,$acl)}else{[System.IO.File]::SetAccessControl($target,$acl)}
$check=Get-Acl -LiteralPath $target
if(-not (Test-PrivateAcl $check)){throw 'ACL_VERIFY_FAILED'}
[Console]::Write('OK')`;
  repairAssert(execFileSync(ps, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true,
    timeout: 8000, maxBuffer: 16384, env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
      WINDIR: process.env.WINDIR ?? "C:\\Windows", PATH: process.env.PATH ?? "", TEMP: process.env.TEMP ?? "", TMP: process.env.TMP ?? "",
      USERPROFILE: process.env.USERPROFILE ?? "", C2C_REPAIR_ACL_TARGET: target, C2C_REPAIR_ACL_DIRECTORY: directory ? "1" : "0" } }) === "OK");
  canonical(target);
}

/** Ordinary writers never reclaim administrative fences, even when their owner is missing. */
export function assertNoAbandonmentRepair(lock: string): void {
  repairAssert(!present(`${lock}.repair`) && !present(`${lock}.repair.reclaim`) && !present(`${lock}.repair.tmp`));
  const commandId = path.basename(lock).replace(/\.json\.lock$/, ""), workspaceId = path.basename(path.dirname(lock));
  if (!/^[a-f0-9]{12}$/.test(workspaceId)) return;
  const p = repairPaths(workspaceId, commandId, path.dirname(path.dirname(path.dirname(lock))));
  if (present(p.journal)) {
    const j = parseFile(p.journal, journalSchema).value; validateIntent(j, workspaceId, commandId);
    repairAssert(j.state === "completed" && j.abandonmentBatchSha256 !== null && !present(`${p.journal}.tmp`));
    repairAssert(isDeepStrictEqual(repairSnapshot(path.join(p.directory, `${j.repairId}.lock`)).fingerprint, j.quarantine));
  }
}

/** Read only; a journal alone is never permission to discard an unexplained lock. */
export async function inspectRepair(workspaceId: string, commandId: string, options: RepairOptions = {}) {
  assertResidue(workspaceId, commandId);
  const p = repairPaths(workspaceId, commandId);
  const journal = present(p.journal) ? parseFile(p.journal, journalSchema).value : null;
  if (journal) validateIntent(journal, workspaceId, commandId);
  const fence = present(p.fence) ? parseFile(p.fence, fenceSchema) : null;
  // Preview recognizes a valid dead reclaim without mutating it; only maintenance-owned confirm may consume it.
  let reclaimFingerprint: Fingerprint | undefined;
  if (present(p.reclaim)) {
    repairAssert(fence);
    const claim = readReclaim(workspaceId, commandId, fence);
    await missing(claim.value.owner, options);
    equalFile(p.reclaim, claim.snapshot); equalFile(p.fence, fence.snapshot);
    reclaimFingerprint = claim.snapshot.fingerprint;
  }
  if (fence) {
    validateIntent(fence.value, workspaceId, commandId);
    if (journal) repairAssert(isDeepStrictEqual(intent(fence.value), intent(journal)));
    await missing(fence.value.owner, options); equalFile(p.fence, fence.snapshot);
    const q = quarantineFile(fence.value), original = fence.value.proof.observations.find(x => x.commandId === commandId)!.fingerprint;
    if (present(q)) {
      const s = repairSnapshot(q).fingerprint;
      repairAssert(s.dev === original.dev && s.ino === original.ino && s.size === 0 && s.sha256 === original.sha256);
      if (journal?.quarantine) repairAssert(isDeepStrictEqual(s, journal.quarantine));
      if (present(p.lock)) repairAssert(repairSnapshot(p.lock).bytes.toString() === JSON.stringify(fence.value.normalOwner));
      else repairAssert(journal?.state !== "prepared" || present(q));
    } else repairAssert(!journal || journal.state === "prepared");
    if (!present(q)) repairAssert(isDeepStrictEqual(repairSnapshot(p.lock).fingerprint, original));
    return { proof: fence.value.proof, completed: journal?.state === "completed", fence: true, batchSha256: journal?.abandonmentBatchSha256, reclaimFingerprint };
  }
  if (journal) {
    repairAssert(journal.state === "completed" && journal.quarantine && journal.abandonmentBatchSha256);
    repairAssert(isDeepStrictEqual(repairSnapshot(quarantineFile(journal)).fingerprint, journal.quarantine));
    return { proof: journal.proof, completed: true, fence: false, batchSha256: journal.abandonmentBatchSha256 };
  }
  const fingerprint = repairSnapshot(p.lock).fingerprint; repairAssert(fingerprint.size === 0);
  return { proof: null, completed: false, fence: false, fingerprint };
}

type Authority = { workspaceId: string; commandId: string; assertOwned: () => void };
const capabilities = new WeakMap<object, Authority>();
/** @internal Unforgeable, transaction-local handoff; ordinary callers cannot mint it. */
export function assertRepairCapability(capability: object, workspaceId: string, commandId: string): void {
  const value = capabilities.get(capability); repairAssert(value?.workspaceId === workspaceId && value.commandId === commandId); value.assertOwned();
}

/** Only desktop/abandonment-repair may acquire this authority, after both digests and eligibility checks. */
export async function acquireAbandonmentRepair(proof: RepairProof, commandId: string, revalidate: () => Promise<void>, maintenance: MaintenanceLockHandle, options: RepairOptions = {}) {
  const p = repairPaths(proof.workspaceId, commandId), checkpoint = (point: string) => options.checkpoint?.(point, commandId);
  const assertMaintenance = () => assertMaintenanceHandle(getStateDir(), maintenance);
  assertMaintenance();
  await inspectRepair(proof.workspaceId, commandId, options);
  const owner = await self(options);
  let fence: Fence, fenceSnapshot: ReturnType<typeof repairSnapshot>;
  if (present(p.fence)) {
    const previous = parseFile(p.fence, fenceSchema); repairAssert(isDeepStrictEqual(previous.value.proof, proof));
    if (present(p.reclaim)) {
      const stale = readReclaim(proof.workspaceId, commandId, previous);
      await missing(stale.value.owner, options);
      checkpoint("after_stale_reclaim_owner_proof");
      await missing(stale.value.owner, options);
      assertMaintenance(); equalFile(p.fence, previous.snapshot); exactUnlink(p.reclaim, stale.snapshot);
    }
    assertMaintenance(); equalFile(p.fence, previous.snapshot);
    const guard = exclusive(p.reclaim, { version: 1, workspaceId: proof.workspaceId, commandId, repairId: previous.value.repairId,
      owner, nonce: randomUUID(), target: previous.snapshot.fingerprint, createdAt: new Date().toISOString() });
    // Failure retains the strict sidecar. No finally-unlink that would hide interrupted takeover evidence.
    checkpoint("after_reclaim_created");
    await missing(previous.value.owner, options);
    checkpoint("after_reclaim_owner_proof");
    await missing(previous.value.owner, options);
    assertMaintenance(); equalFile(p.fence, previous.snapshot); exactUnlink(p.reclaim, guard);
    // Maintenance still excludes contenders. Consume before publish so a crash cannot leave a guard targeting the old fence.
    checkpoint("after_reclaim_consumed");
    assertMaintenance(); equalFile(p.fence, previous.snapshot);
    fence = { ...previous.value, owner }; fenceSnapshot = replace(p.fence, fence, previous.snapshot);
  } else {
    repairAssert(!present(p.journal));
    fence = { version: 1, repairId: randomUUID(), commandId, proof, repairConfirmationSha256: repairDigest(proof),
      normalOwner: { pid: process.pid, nonce: randomUUID() }, owner };
    assertMaintenance(); fenceSnapshot = exclusive(p.fence, fence);
  }
  const assertFence = () => { assertMaintenance(); repairAssert(!present(p.reclaim)); equalFile(p.fence, fenceSnapshot); };
  // Any failure from here deliberately retains the fence. It is NOT a finally-release lock.
  checkpoint("after_repair_fence");
  await revalidate(); assertFence();
  fs.mkdirSync(p.directory, { recursive: true, mode: 0o700 }); canonical(p.directory); privateAudit(p.directory, true);
  let journal: Journal, journalSnapshot: ReturnType<typeof repairSnapshot>;
  if (present(p.journal)) {
    const read = parseFile(p.journal, journalSchema); journal = read.value; journalSnapshot = read.snapshot;
    repairAssert(isDeepStrictEqual(intent(journal), intent(fence)));
  } else {
    journal = { ...intent(fence), state: "prepared", quarantine: null, abandonmentBatchSha256: null };
    journalSnapshot = exclusive(p.journal, journal);
  }
  const persist = () => { assertFence(); journalSnapshot = replace(p.journal, journal, journalSnapshot); };
  const q = quarantineFile(fence), original = proof.observations.find(x => x.commandId === commandId)!.fingerprint;
  if (!present(q)) {
    repairAssert(journal.state === "prepared");
    await revalidate(); assertFence(); assertResidue(proof.workspaceId, commandId);
    repairAssert(isDeepStrictEqual(repairSnapshot(p.lock).fingerprint, original));
    canonical(q); repairAssert(!present(q)); fs.renameSync(p.lock, q);
    checkpoint("after_quarantine_rename");
  }
  const adopted = repairSnapshot(q).fingerprint;
  repairAssert(adopted.dev === original.dev && adopted.ino === original.ino && adopted.size === 0 && adopted.sha256 === original.sha256);
  if (journal.quarantine) repairAssert(isDeepStrictEqual(adopted, journal.quarantine));
  else { privateAudit(q, false); journal.quarantine = repairSnapshot(q).fingerprint; journal.state = "adopted_pending"; persist(); }
  checkpoint("after_adopted_pending");
  let normal: ReturnType<typeof repairSnapshot> | null = null;
  if (!present(p.lock) && journal.state !== "completed") normal = exclusive(p.lock, fence.normalOwner);
  else if (present(p.lock)) {
    normal = repairSnapshot(p.lock); repairAssert(normal.bytes.toString() === JSON.stringify(fence.normalOwner));
  }
  checkpoint("after_new_lifecycle_lock");
  const assertOwned = () => {
    assertFence(); equalFile(p.journal, journalSnapshot);
    repairAssert(isDeepStrictEqual(repairSnapshot(q).fingerprint, journal.quarantine));
    if (normal) equalFile(p.lock, normal);
  };
  assertOwned();
  const capability = Object.freeze({}); capabilities.set(capability, { workspaceId: proof.workspaceId, commandId, assertOwned });
  return { capability,
    complete(batchSha256: string) {
      assertOwned(); repairAssert(hex.safeParse(batchSha256).success);
      if (journal.state === "completed") repairAssert(journal.abandonmentBatchSha256 === batchSha256);
      else { journal.state = "completed"; journal.abandonmentBatchSha256 = batchSha256; persist(); }
      checkpoint("after_completed_evidence");
    },
    release() {
      assertOwned(); repairAssert(journal.state === "completed"); capabilities.delete(capability);
      if (normal) { exactUnlink(p.lock, normal); normal = null; }
      assertFence(); exactUnlink(p.fence, fenceSnapshot);
    },
    invalidate() { capabilities.delete(capability); },
  };
}
