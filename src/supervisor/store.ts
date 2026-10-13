import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { getStateDir } from "../config/paths.js";
import { resolveDaemonSpawnHelperPath, resolveDaemonSpawnPython } from "../process/daemon-spawn.js";
import { processProbeSchema, probeProcess, isProcessProvenMissing, type ProcessProbe } from "../process/process-probe.js";
import { Workspace } from "../workspace/manager.js";
import { supervisorConfigSchema, supervisorRuntimeSchema, supervisorLaunchSchema, supervisorLaunchFileIdentitySchema, type SupervisorConfig, type SupervisorRuntime } from "./schema.js";

const WORKSPACE_ID = /^[a-f0-9]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CREATION_TIME = /^[a-zA-Z0-9:-]{1,128}$/;
const MAX_STATE_BYTES = 16 * 1024;

function absoluteNormalized(value: string): boolean {
  return path.isAbsolute(value) && path.normalize(value) === value;
}

const lockOwnerSchema = z.object({
  version: z.literal(1),
  workspaceId: z.string().regex(WORKSPACE_ID),
  workspaceRoot: z.string().min(1).max(32768).refine(absoluteNormalized),
  kind: z.enum(["operation", "supervisor", "reclaim"]),
  pid: z.number().int().positive().max(0xffffffff),
  creationTime: z.string().regex(CREATION_TIME),
  executable: z.string().min(1).max(32768).refine(absoluteNormalized),
  nonce: z.string().regex(UUID),
}).strict();
type LockOwner = z.infer<typeof lockOwnerSchema>;

export class SupervisorStoreError extends Error {
  constructor(readonly code: "SUPERVISOR_BUSY" | "SUPERVISOR_STORE_CORRUPT" | "SUPERVISOR_IDENTITY_UNAVAILABLE" | "SUPERVISOR_OWNERSHIP_LOST" | "SUPERVISOR_STORE_SECURITY", message: string) {
    super(message);
    this.name = "SupervisorStoreError";
  }
}

export const SUPERVISOR_BUSY = "SUPERVISOR_BUSY" as const;

export type SupervisorStoreOptions = {
  stateDir?: string;
  /** Test seam. Production callers use the existing bounded OS process probe. */
  probeProcess?: (pid: number, expectedCreationTime?: string) => Promise<ProcessProbe>;
};

export type SupervisorConfigPatch = Partial<Pick<SupervisorConfig, "desiredState" | "tunnel" | "registrationMode">>;

export type SupervisorOperation = {
  assertOwned(): void;
  readConfig(): SupervisorConfig | null;
  updateConfig(patch: SupervisorConfigPatch): SupervisorConfig;
};

export type SupervisorLeaseInfo = Pick<SupervisorRuntime, "launcherPath" | "buildId" | "registrationMode">;

export type SupervisorLease = {
  readonly runtime: SupervisorRuntime;
  readonly lockPath: string;
  assertOwned(): void;
  handoffLaunch(launch: SupervisorLaunch): void;
  release(): Promise<boolean>;
};

export type SupervisorLaunch = Readonly<{ launcherPath: string; buildId: string }>;
// Only a validated pin capability can be handed off; callers cannot supply an
// arbitrary filename or substitute a fresh snapshot after the lease is acquired.
const launchPins = new WeakMap<SupervisorLaunch, {
  file: string; snapshot: FileSnapshot; workspaceRoot: string; stateDir: string;
}>();

function fail(code: ConstructorParameters<typeof SupervisorStoreError>[0], message: string): never {
  throw new SupervisorStoreError(code, message);
}

function workspaceFor(root: string): Workspace {
  try { return new Workspace(root); }
  catch { return fail("SUPERVISOR_STORE_CORRUPT", "supervisor workspace root 无效或不可访问"); }
}

function normPath(value: string): string {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" || process.platform === "darwin" ? normalized.toLowerCase() : normalized;
}

function samePath(a: string, b: string): boolean { return normPath(a) === normPath(b); }

function stateRoot(options: SupervisorStoreOptions): string {
  const root = path.resolve(options.stateDir ?? getStateDir());
  return root;
}

function workspaceDir(workspaceId: string, stateDir = getStateDir()): string {
  if (!WORKSPACE_ID.test(workspaceId)) fail("SUPERVISOR_STORE_CORRUPT", "supervisor workspaceId 无效");
  return path.join(path.resolve(stateDir), "bridge-supervisor");
}

export function supervisorConfigFile(workspaceId: string, stateDir = getStateDir()): string {
  return path.join(workspaceDir(workspaceId, stateDir), `${workspaceId}.json`);
}

export function supervisorRuntimeFile(workspaceId: string, stateDir = getStateDir()): string {
  return path.join(workspaceDir(workspaceId, stateDir), `${workspaceId}.runtime.json`);
}

export function supervisorLeaseFile(workspaceId: string, stateDir = getStateDir()): string {
  return path.join(workspaceDir(workspaceId, stateDir), `${workspaceId}.lock`);
}

export function supervisorOperationLockFile(workspaceId: string, stateDir = getStateDir()): string {
  return path.join(workspaceDir(workspaceId, stateDir), `${workspaceId}.operation.lock`);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function assertCanonicalDirectory(dir: string): void {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync.native(dir), dir)) {
      fail("SUPERVISOR_STORE_SECURITY", "supervisor state directory is not canonical");
    }
  } catch (error) {
    if (error instanceof SupervisorStoreError) throw error;
    if (isMissing(error)) fail("SUPERVISOR_STORE_CORRUPT", "supervisor state directory is missing");
    fail("SUPERVISOR_STORE_SECURITY", "supervisor state directory cannot be verified");
  }
}

const ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($item in @((ConvertFrom-Json -InputObject $env:C2C_SUPERVISOR_ACL_TARGETS))) {
  $target = [string]$item.path
  $mode = [string]$item.mode
  $acl = Get-Acl -LiteralPath $target
  if ($mode -eq 'set-directory') {
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
    $identity = [System.Security.Principal.SecurityIdentifier]::new($sid)
    $acl.SetOwner($identity)
    $inheritance = [System.Security.AccessControl.InheritanceFlags]([int][System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [int][System.Security.AccessControl.InheritanceFlags]::ObjectInherit)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow)
    [void]$acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $target -AclObject $acl
    $acl = Get-Acl -LiteralPath $target
    $mode = 'verify-directory'
  }
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($ownerSid -ne $sid) { throw 'unexpected ACL owner' }
  if ($rules.Count -ne 1) { throw 'unexpected ACL rule count' }
  $entry = $rules[0]
  if ($entry.IdentityReference.Value -ne $sid -or
      $entry.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
      [int64]$entry.FileSystemRights -ne [int64][System.Security.AccessControl.FileSystemRights]::FullControl) { throw 'unexpected ACL owner or rights' }
  if ($mode -eq 'verify-directory') {
    $inheritance = [System.Security.AccessControl.InheritanceFlags]([int][System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [int][System.Security.AccessControl.InheritanceFlags]::ObjectInherit)
    if (-not $acl.AreAccessRulesProtected -or $entry.IsInherited -or
        $entry.InheritanceFlags -ne $inheritance -or
        $entry.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) { throw 'directory ACL is not owner-only' }
  } elseif ($mode -eq 'verify-file') {
    if (-not $entry.IsInherited -or $entry.InheritanceFlags -ne [System.Security.AccessControl.InheritanceFlags]::None) { throw 'file ACL is not inherited owner-only' }
  } else { throw 'invalid ACL mode' }
}
[Console]::Out.WriteLine('OK:' + $sid)
`;

function verifyWindowsAcls(targets: Array<{ path: string; mode: "set-directory" | "verify-directory" | "verify-file" }>): void {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const startedAt = performance.now();
  let output: string;
  try {
    output = execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ACL_SCRIPT], {
      // 预算包含 PowerShell 冷启动、ACL 校验与退出；超时仍拒绝本次操作。
      encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024,
      // 显式 pipe 防止 execFileSync 在抛错前将原始 PowerShell stderr 写到父进程。
      stdio: "pipe",
      env: {
        SystemRoot: systemRoot,
        WINDIR: process.env.WINDIR ?? systemRoot,
        PATH: process.env.PATH ?? "",
        TEMP: process.env.TEMP ?? "",
        TMP: process.env.TMP ?? "",
        USERPROFILE: process.env.USERPROFILE ?? "",
        C2C_SUPERVISOR_ACL_TARGETS: JSON.stringify(targets),
      },
    });
  } catch (error) {
    failWindowsAcl(classifyWindowsAclFailure(error), startedAt, error);
  }
  if (!/^OK:S-\d(?:-\d+)+\s*$/i.test(output)) failWindowsAcl("invalid_output", startedAt);
}

type WindowsAclFailure = "timeout" | "nonzero" | "spawn_failure" | "interrupted" | "execution_failure" | "invalid_output";
type WindowsAclSignal = "SIGBREAK" | "SIGINT" | "SIGTERM";
const WINDOWS_ACL_SPAWN_CODES = new Set(["EACCES", "EAGAIN", "EMFILE", "ENFILE", "ENOENT", "ENOMEM", "ENOBUFS", "ENOEXEC", "ENOTDIR", "EPERM"]);
const WINDOWS_ACL_SIGNALS: readonly WindowsAclSignal[] = ["SIGBREAK", "SIGINT", "SIGTERM"];

function classifyWindowsAclFailure(error: unknown): WindowsAclFailure {
  const detail = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = typeof detail.code === "string" ? detail.code : "";
  const status = typeof detail.status === "number" && Number.isInteger(detail.status) ? detail.status : undefined;
  const signal = typeof detail.signal === "string" ? detail.signal : "";
  if (code === "ETIMEDOUT") return "timeout";
  if (code === "EINTR" || WINDOWS_ACL_SIGNALS.includes(signal as WindowsAclSignal)) return "interrupted";
  if (status !== undefined && status !== 0) return "nonzero";
  if (WINDOWS_ACL_SPAWN_CODES.has(code)) return "spawn_failure";
  return "execution_failure";
}

function failWindowsAcl(classification: WindowsAclFailure, startedAt: number, error?: unknown): never {
  const elapsed = performance.now() - startedAt;
  const durationMs = Number.isFinite(elapsed) ? Math.max(0, Math.min(60_000, Math.trunc(elapsed))) : 0;
  const detail = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = typeof detail.status === "number" && Number.isInteger(detail.status) ? detail.status : undefined;
  const signal = typeof detail.signal === "string" && WINDOWS_ACL_SIGNALS.includes(detail.signal as WindowsAclSignal)
    ? detail.signal as WindowsAclSignal : undefined;
  const fields = {
    classification,
    durationMs,
    ...(status === undefined ? {} : { exitCode: Math.max(-0x80000000, Math.min(0xffffffff, status)) }),
    ...(signal === undefined ? {} : { signal }),
  };
  const details = Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(", ");
  const prefix = classification === "invalid_output"
    ? "supervisor owner-only Windows ACL verification failed"
    : "supervisor owner-only Windows ACL could not be established or verified";
  const failure = new SupervisorStoreError("SUPERVISOR_STORE_SECURITY", `${prefix} (${details})`);
  Object.assign(failure, fields);
  throw failure;
}

function verifyWindowsAcl(target: string, mode: "set-directory" | "verify-directory" | "verify-file"): void {
  verifyWindowsAcls([{ path: target, mode }]);
}

function assertSecureDirectory(dir: string): void {
  assertCanonicalDirectory(dir);
  if (process.platform === "win32") {
    verifyWindowsAcl(dir, "verify-directory");
    return;
  }
  const mode = fs.statSync(dir).mode & 0o7777;
  if (mode !== 0o700) fail("SUPERVISOR_STORE_SECURITY", "supervisor state directory permissions are not owner-only");
}

function assertCanonicalRegularFile(file: string): fs.Stats {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !samePath(fs.realpathSync.native(file), file)) {
      fail("SUPERVISOR_STORE_SECURITY", "supervisor state file is not canonical");
    }
    return stat;
  } catch (error) {
    if (error instanceof SupervisorStoreError) throw error;
    if (isMissing(error)) fail("SUPERVISOR_STORE_CORRUPT", "supervisor state file is missing");
    fail("SUPERVISOR_STORE_SECURITY", "supervisor state file cannot be verified");
  }
}

function assertSecureFile(file: string, stat = assertCanonicalRegularFile(file)): void {
  if (stat.size > MAX_STATE_BYTES) fail("SUPERVISOR_STORE_CORRUPT", "supervisor state file exceeds its size limit");
  if (process.platform === "win32") {
    verifyWindowsAcls([
      { path: path.dirname(file), mode: "verify-directory" },
      { path: file, mode: "verify-file" },
    ]);
    return;
  }
  assertSecureDirectory(path.dirname(file));
  if ((stat.mode & 0o7777) !== 0o600) fail("SUPERVISOR_STORE_SECURITY", "supervisor state file permissions are not owner-only");
}

function setNewDirectorySecurity(dir: string): void {
  if (process.platform === "win32") {
    verifyWindowsAcl(dir, "set-directory");
  } else {
    fs.chmodSync(dir, 0o700);
    assertSecureDirectory(dir);
  }
}

function ensureStoreDirectory(stateDir: string): string {
  const root = path.resolve(stateDir);
  try { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); }
  catch { fail("SUPERVISOR_STORE_SECURITY", "supervisor state root could not be created"); }
  assertCanonicalDirectory(root);
  const dir = path.join(root, "bridge-supervisor");
  let created = false;
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") fail("SUPERVISOR_STORE_SECURITY", "supervisor state directory could not be created");
  }
  if (created) setNewDirectorySecurity(dir);
  else assertSecureDirectory(dir);
  return dir;
}

function findExistingStoreDirectory(stateDir: string): string | null {
  const root = path.resolve(stateDir);
  try { fs.lstatSync(root); }
  catch (error) { if (isMissing(error)) return null; fail("SUPERVISOR_STORE_SECURITY", "supervisor state root cannot be inspected"); }
  assertCanonicalDirectory(root);
  const dir = path.join(root, "bridge-supervisor");
  try { fs.lstatSync(dir); }
  catch (error) { if (isMissing(error)) return null; fail("SUPERVISOR_STORE_SECURITY", "supervisor state directory cannot be inspected"); }
  assertCanonicalDirectory(dir);
  if (process.platform !== "win32") assertSecureDirectory(dir);
  return dir;
}

/** Presence check under the machine lifecycle fence, without ACL/process APIs. */
export function hasSupervisorState(workspaceRoot: string, stateDir = getStateDir()): boolean {
  const workspace = workspaceFor(workspaceRoot), dir = workspaceDir(workspace.id, stateDir);
  try { fs.lstatSync(dir); }
  catch (error) {
    if (isMissing(error)) return false;
    return fail("SUPERVISOR_STORE_SECURITY", "supervisor state cannot be inspected");
  }
  assertCanonicalDirectory(dir);
  return fs.readdirSync(dir).some(name => name.toLowerCase().startsWith(`${workspace.id}.`));
}

/** Capture the exact launch file before acquiring a runtime lease. Read-only. */
export function readSupervisorLaunch(workspaceRoot: string, pinPath: string, buildId: string, expectedIdentity: unknown,
  options: SupervisorStoreOptions = {}): SupervisorLaunch {
  const workspace = workspaceFor(workspaceRoot), stateDir = stateRoot(options);
  const dir = findExistingStoreDirectory(stateDir);
  if (!dir || path.dirname(pinPath) !== dir || path.resolve(pinPath) !== pinPath)
    return fail("SUPERVISOR_STORE_CORRUPT", "supervisor launch pin path is invalid");
  const entry = readStrictEntry(pinPath, dir, workspace.id, supervisorLaunchSchema);
  if (!entry) return fail("SUPERVISOR_STORE_CORRUPT", "supervisor launch pin is missing");
  const identity = supervisorLaunchFileIdentitySchema.safeParse(expectedIdentity);
  const snapshot = entry.snapshot;
  if (!identity.success || identity.data.dev !== snapshot.dev || identity.data.ino !== snapshot.ino ||
      identity.data.size !== snapshot.size || identity.data.mtimeMs !== snapshot.mtimeMs || identity.data.ctimeMs !== snapshot.ctimeMs ||
      identity.data.sha256 !== createHash("sha256").update(snapshot.bytes).digest("hex"))
    return fail("SUPERVISOR_OWNERSHIP_LOST", "supervisor launch pin differs from launcher identity");
  const pin = requireWorkspaceIdentity(entry.value, workspace);
  if (pin.buildId !== buildId || pin.launcherPath !== path.join(stateDir, "bin", "c2c.js") ||
      pinPath !== path.join(dir, `${workspace.id}.${pin.nonce}.launch.json`))
    return fail("SUPERVISOR_STORE_CORRUPT", "supervisor launch pin identity is invalid");
  const launch = Object.freeze({ launcherPath: pin.launcherPath, buildId: pin.buildId });
  launchPins.set(launch, { file: pinPath, snapshot: entry.snapshot, workspaceRoot: workspace.root, stateDir });
  return launch;
}

function assertNoInterruptedTemps(dir: string, workspaceId: string, allowedTemp?: string): void {
  let names: string[];
  try { names = fs.readdirSync(dir); }
  catch { fail("SUPERVISOR_STORE_SECURITY", "supervisor state directory cannot be read"); }
  if (names.some(name => name.startsWith(`${workspaceId}.`) && name.endsWith(".tmp") && name !== allowedTemp)) {
    fail("SUPERVISOR_STORE_CORRUPT", "supervisor state has an interrupted temporary write; preserve it for inspection");
  }
}

type FileSnapshot = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; bytes: Buffer };

function snapshotFile(file: string, allowMissing = false, verifyAccess = true): FileSnapshot | null {
  let stat: fs.Stats;
  try { fs.lstatSync(file); }
  catch (error) {
    if (allowMissing && isMissing(error)) return null;
    if (isMissing(error)) fail("SUPERVISOR_STORE_CORRUPT", "supervisor state file is missing");
    fail("SUPERVISOR_STORE_SECURITY", "supervisor state file cannot be inspected");
  }
  stat = assertCanonicalRegularFile(file);
  if (verifyAccess) assertSecureFile(file, stat);
  else if (stat.size > MAX_STATE_BYTES) fail("SUPERVISOR_STORE_CORRUPT", "supervisor state file exceeds its size limit");
  const bytes = fs.readFileSync(file);
  const after = assertCanonicalRegularFile(file);
  if (stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs || bytes.length !== stat.size) {
    fail("SUPERVISOR_STORE_CORRUPT", "supervisor state file changed while being read");
  }
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, bytes };
}

function sameSnapshot(a: FileSnapshot | null, b: FileSnapshot | null): boolean {
  if (a === null || b === null) return a === b;
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs && a.bytes.equals(b.bytes);
}

function sameSnapshotAfterAtomicRename(staged: FileSnapshot, committed: FileSnapshot): boolean {
  // Windows updates ctime on rename; file ID, content and mtime remain stable.
  return staged.dev === committed.dev && staged.ino === committed.ino && staged.size === committed.size &&
    staged.mtimeMs === committed.mtimeMs && staged.bytes.equals(committed.bytes);
}

const RUNTIME_FIELDS: readonly (keyof SupervisorRuntime)[] = [
  "version", "workspaceId", "workspaceRoot", "pid", "creationTime", "executable", "startedAt",
  "launcherPath", "buildId", "registrationMode", "nonce",
];

function sameRuntime(a: SupervisorRuntime, b: SupervisorRuntime): boolean {
  return RUNTIME_FIELDS.every(field => a[field] === b[field]);
}

/** Re-read immediately before unlink so a replaced path is preserved. */
function unlinkExactSnapshot(file: string, expected: FileSnapshot): boolean {
  // Callers verify the owner-only ACL at the operation boundary. This final
  // synchronous identity/content check avoids another PowerShell ACL roundtrip.
  const final = snapshotFile(file, false, false);
  if (!sameSnapshot(expected, final)) return false;
  fs.unlinkSync(file);
  return true;
}

function readStrictEntry<T>(file: string, dir: string, workspaceId: string, schema: z.ZodType<T>, directoryVerified = false): { value: T; snapshot: FileSnapshot } | null {
  assertNoInterruptedTemps(dir, workspaceId);
  const snapshot = snapshotFile(file, true);
  if (!snapshot) {
    if (!directoryVerified) assertSecureDirectory(dir);
    return null;
  }
  let parsed: T;
  try { parsed = schema.parse(JSON.parse(snapshot.bytes.toString("utf8"))); }
  catch { fail("SUPERVISOR_STORE_CORRUPT", "supervisor state schema or JSON is invalid; preserve the file for inspection"); }
  assertNoInterruptedTemps(dir, workspaceId);
  const after = snapshotFile(file, false, false);
  if (!sameSnapshot(snapshot, after)) fail("SUPERVISOR_STORE_CORRUPT", "supervisor state changed while being read");
  const identity = parsed as { workspaceId?: unknown; workspaceRoot?: unknown };
  if (identity.workspaceId !== workspaceId) fail("SUPERVISOR_STORE_CORRUPT", "supervisor state workspaceId does not match its filename");
  return { value: parsed, snapshot };
}

function readStrict<T>(file: string, dir: string, workspaceId: string, schema: z.ZodType<T>): T | null {
  return readStrictEntry(file, dir, workspaceId, schema)?.value ?? null;
}

function requireWorkspaceIdentity<T extends { workspaceId: string; workspaceRoot: string }>(value: T, workspace: Workspace): T {
  if (value.workspaceId !== workspace.id || !samePath(value.workspaceRoot, workspace.root)) {
    fail("SUPERVISOR_STORE_CORRUPT", "supervisor state does not match the canonical workspace identity");
  }
  return value;
}

function readConfigFor(workspace: Workspace, stateDir: string, directoryVerified = false, knownDir?: string): SupervisorConfig | null {
  const dir = knownDir ?? findExistingStoreDirectory(stateDir);
  if (!dir) return null;
  const value = readStrictEntry(supervisorConfigFile(workspace.id, stateDir), dir, workspace.id, supervisorConfigSchema, directoryVerified)?.value ?? null;
  return value ? requireWorkspaceIdentity(value, workspace) : null;
}

function readRuntimeFor(workspace: Workspace, stateDir: string): SupervisorRuntime | null {
  return readRuntimeEntryFor(workspace, stateDir)?.runtime ?? null;
}

function readRuntimeEntryFor(workspace: Workspace, stateDir: string): { runtime: SupervisorRuntime; snapshot: FileSnapshot } | null {
  const dir = findExistingStoreDirectory(stateDir);
  if (!dir) return null;
  const entry = readStrictEntry(supervisorRuntimeFile(workspace.id, stateDir), dir, workspace.id, supervisorRuntimeSchema);
  if (!entry) return null;
  return { runtime: requireWorkspaceIdentity(entry.value, workspace), snapshot: entry.snapshot };
}

export function readSupervisorConfig(workspaceRoot: string, options: SupervisorStoreOptions = {}): SupervisorConfig | null {
  return readConfigFor(workspaceFor(workspaceRoot), stateRoot(options));
}

export function readSupervisorRuntime(workspaceRoot: string, options: SupervisorStoreOptions = {}): SupervisorRuntime | null {
  return readRuntimeFor(workspaceFor(workspaceRoot), stateRoot(options));
}

function currentProbe(options: SupervisorStoreOptions): (pid: number, expected?: string) => Promise<ProcessProbe> {
  return options.probeProcess ?? ((pid, expected) => probeProcess(pid, resolveDaemonSpawnPython(), resolveDaemonSpawnHelperPath(), expected));
}

async function currentIdentity(options: SupervisorStoreOptions): Promise<Pick<LockOwner, "pid" | "creationTime" | "executable">> {
  const probe = currentProbe(options);
  let observed: ProcessProbe;
  try { observed = processProbeSchema.parse(await probe(process.pid)); }
  catch { return fail("SUPERVISOR_IDENTITY_UNAVAILABLE", "current supervisor process identity could not be proven"); }
  if (observed.pid !== process.pid || observed.status !== "identified" || !observed.creationTime || !observed.executable ||
      !CREATION_TIME.test(observed.creationTime) || !absoluteNormalized(observed.executable)) {
    return fail("SUPERVISOR_IDENTITY_UNAVAILABLE", "current supervisor process identity could not be proven");
  }
  return { pid: observed.pid, creationTime: observed.creationTime, executable: observed.executable };
}

function lockPaths(file: string): { reclaim: string } { return { reclaim: `${file}.reclaim.lock` }; }

function lockMetadata(workspace: Workspace, kind: LockOwner["kind"], identity: Pick<LockOwner, "pid" | "creationTime" | "executable">): LockOwner {
  return lockOwnerSchema.parse({ version: 1, workspaceId: workspace.id, workspaceRoot: workspace.root, kind, ...identity, nonce: randomUUID() });
}

function readLock(file: string, dir: string, workspace: Workspace, expectedKind: LockOwner["kind"]): { owner: LockOwner; snapshot: FileSnapshot } {
  const snapshot = snapshotFile(file, false)!;
  let owner: LockOwner;
  try { owner = lockOwnerSchema.parse(JSON.parse(snapshot.bytes.toString("utf8"))); }
  catch { return fail("SUPERVISOR_BUSY", "supervisor lock owner is ambiguous or corrupt"); }
  if (owner.workspaceId !== workspace.id || !samePath(owner.workspaceRoot, workspace.root) || owner.kind !== expectedKind) {
    return fail("SUPERVISOR_BUSY", "supervisor lock belongs to an unknown or replaced owner");
  }
  assertNoInterruptedTemps(dir, workspace.id);
  return { owner, snapshot };
}

function assertLockOwned(file: string, dir: string, workspace: Workspace, kind: "operation" | "supervisor", expected: LockOwner, snapshot: FileSnapshot): void {
  let fresh: ReturnType<typeof readLock>;
  try { fresh = readLock(file, dir, workspace, kind); }
  catch { return fail("SUPERVISOR_OWNERSHIP_LOST", "supervisor lock ownership is no longer provable"); }
  if (fresh.owner.nonce !== expected.nonce || fresh.owner.pid !== expected.pid ||
      fresh.owner.creationTime !== expected.creationTime || !samePath(fresh.owner.executable, expected.executable) ||
      !sameSnapshot(snapshot, fresh.snapshot)) {
    fail("SUPERVISOR_OWNERSHIP_LOST", "supervisor lock was replaced or changed");
  }
}

function assertLeaseOwned(workspace: Workspace, stateDir: string, dir: string, lockPath: string, owner: LockOwner, lockSnapshot: FileSnapshot, runtime: SupervisorRuntime, runtimeSnapshot: FileSnapshot): FileSnapshot {
  assertLockOwned(lockPath, dir, workspace, "supervisor", owner, lockSnapshot);
  const entry = readRuntimeEntryFor(workspace, stateDir);
  if (!entry || !sameRuntime(entry.runtime, runtime) || !sameSnapshot(runtimeSnapshot, entry.snapshot)) {
    fail("SUPERVISOR_OWNERSHIP_LOST", "supervisor runtime provenance is no longer owned by this process");
  }
  return entry.snapshot;
}

function createLockFile(file: string, dir: string, owner: LockOwner): { snapshot: FileSnapshot } {
  let fd: number;
  try { fd = fs.openSync(file, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return fail("SUPERVISOR_BUSY", "supervisor operation is already owned");
    fail("SUPERVISOR_STORE_SECURITY", "supervisor lock could not be created");
  }
  let fdOpen = true;
  try {
    fs.writeFileSync(fd, JSON.stringify(owner));
    fs.fsyncSync(fd);
    if (process.platform !== "win32") fs.fchmodSync(fd, 0o600);
    fs.closeSync(fd); fdOpen = false;
    assertNoInterruptedTemps(dir, owner.workspaceId);
    return { snapshot: snapshotFile(file, false)! };
  } catch (error) {
    if (fdOpen) try { fs.closeSync(fd); } catch { /* preserve primary failure */ }
    throw error;
  }
}

async function reclaimStaleLock(file: string, dir: string, workspace: Workspace, kind: LockOwner["kind"], options: SupervisorStoreOptions): Promise<void> {
  const initial = readLock(file, dir, workspace, kind);
  const expectedOwner = initial.owner;
  const probe = currentProbe(options);
  let observed: ProcessProbe;
  try { observed = processProbeSchema.parse(await probe(expectedOwner.pid, expectedOwner.creationTime)); }
  catch { return fail("SUPERVISOR_BUSY", "supervisor lock owner process identity is unknown"); }
  if (observed.pid !== expectedOwner.pid || !isProcessProvenMissing(observed)) return fail("SUPERVISOR_BUSY", "supervisor lock owner is live or cannot be proven stopped");
  const verifyPriorRuntime = (): void => {
    if (kind !== "supervisor") return;
    const runtime = readRuntimeFor(workspace, stateRoot(options));
    if (runtime && (runtime.nonce !== expectedOwner.nonce || runtime.pid !== expectedOwner.pid ||
        runtime.creationTime !== expectedOwner.creationTime || !samePath(runtime.executable, expectedOwner.executable))) {
      fail("SUPERVISOR_BUSY", "supervisor runtime and lease owner do not match");
    }
  };
  verifyPriorRuntime();

  const reclaimFile = lockPaths(file).reclaim;
  const identity = await currentIdentity(options);
  const guardOwner = lockMetadata(workspace, "reclaim", identity);
  let guard: { snapshot: FileSnapshot };
  try { guard = createLockFile(reclaimFile, dir, guardOwner); }
  catch { return fail("SUPERVISOR_BUSY", "supervisor stale-owner reclaim is already in progress"); }
  try {
    const fresh = readLock(file, dir, workspace, kind);
    if (fresh.owner.nonce !== expectedOwner.nonce || !sameSnapshot(initial.snapshot, fresh.snapshot)) {
      return fail("SUPERVISOR_BUSY", "supervisor lock changed during stale-owner reclaim");
    }
    let finalProbe: ProcessProbe;
    try { finalProbe = processProbeSchema.parse(await probe(expectedOwner.pid, expectedOwner.creationTime)); }
    catch { return fail("SUPERVISOR_BUSY", "supervisor lock owner process identity became unknown"); }
    if (finalProbe.pid !== expectedOwner.pid || !isProcessProvenMissing(finalProbe)) return fail("SUPERVISOR_BUSY", "supervisor lock owner is no longer proven stopped");
    verifyPriorRuntime();
    const beforeDelete = snapshotFile(file, false)!;
    if (!sameSnapshot(fresh.snapshot, beforeDelete)) return fail("SUPERVISOR_BUSY", "supervisor lock changed before stale-owner reclaim");
    if (!unlinkExactSnapshot(file, fresh.snapshot)) return fail("SUPERVISOR_BUSY", "supervisor lock changed before stale-owner reclaim");
  } finally {
    releaseOwnedLock(reclaimFile, guardOwner, guard.snapshot);
  }
}

async function acquireLock(file: string, dir: string, workspace: Workspace, kind: "operation" | "supervisor", identity: Pick<LockOwner, "pid" | "creationTime" | "executable">, options: SupervisorStoreOptions): Promise<{ owner: LockOwner; snapshot: FileSnapshot }> {
  const owner = lockMetadata(workspace, kind, identity);
  try { return { owner, ...createLockFile(file, dir, owner) }; }
  catch (error) {
    if (!(error instanceof SupervisorStoreError) || error.code !== "SUPERVISOR_BUSY") throw error;
    await reclaimStaleLock(file, dir, workspace, kind, options);
    return { owner, ...createLockFile(file, dir, owner) };
  }
}

function releaseOwnedLock(file: string, owner: LockOwner, expected: FileSnapshot): boolean {
  try {
    const fresh = snapshotFile(file, false, false)!;
    const parsed = lockOwnerSchema.parse(JSON.parse(fresh.bytes.toString("utf8")));
    if (parsed.nonce !== owner.nonce || parsed.pid !== owner.pid || parsed.creationTime !== owner.creationTime || !sameSnapshot(expected, fresh)) return false;
    return unlinkExactSnapshot(file, expected);
  } catch { return false; }
}

function writeAtomic<T>(file: string, dir: string, workspaceId: string, kind: "config" | "runtime", value: T, expectAbsent = false): FileSnapshot {
  assertNoInterruptedTemps(dir, workspaceId);
  const before = snapshotFile(file, true);
  if (before === null) assertSecureDirectory(dir);
  if (expectAbsent && before !== null) fail("SUPERVISOR_BUSY", "supervisor runtime already exists");
  const nonce = randomUUID();
  const temp = path.join(dir, `${workspaceId}.${kind}.${nonce}.tmp`);
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  let fd: number;
  try { fd = fs.openSync(temp, "wx", 0o600); }
  catch { fail("SUPERVISOR_STORE_SECURITY", "supervisor atomic temporary file could not be created"); }
  let closed = false;
  try {
    fs.writeFileSync(fd, payload);
    fs.fsyncSync(fd);
    if (process.platform !== "win32") fs.fchmodSync(fd, 0o600);
    fs.closeSync(fd); closed = true;
    const staged = snapshotFile(temp, false)!;
    assertNoInterruptedTemps(dir, workspaceId, path.basename(temp));
    const current = snapshotFile(file, true, false);
    if (!sameSnapshot(before, current)) fail("SUPERVISOR_STORE_CORRUPT", "supervisor target changed during atomic update");
    fs.renameSync(temp, file);
    if (process.platform !== "win32") {
      const dirFd = fs.openSync(dir, "r");
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    }
    assertCanonicalRegularFile(file);
    const committed = snapshotFile(file, false, false)!;
    if (!sameSnapshotAfterAtomicRename(staged, committed)) fail("SUPERVISOR_STORE_CORRUPT", "supervisor atomic rename changed file identity or content");
    return committed;
  } catch (error) {
    if (!closed) try { fs.closeSync(fd); } catch { /* preserve primary failure */ }
    throw error;
  }
}

function updateConfigLocked(workspace: Workspace, patch: SupervisorConfigPatch, stateDir: string, dir: string): SupervisorConfig {
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some(key =>
    !["desiredState", "tunnel", "registrationMode"].includes(key))) {
    fail("SUPERVISOR_STORE_CORRUPT", "supervisor config update contains unsupported fields");
  }
  const stored = readStrictEntry(supervisorConfigFile(workspace.id, stateDir), dir, workspace.id, supervisorConfigSchema, true)?.value ?? null;
  const previous = stored ? requireWorkspaceIdentity(stored, workspace) : null;
  const now = new Date().toISOString();
  const next = supervisorConfigSchema.parse({
    version: 1,
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    desiredState: patch.desiredState ?? previous?.desiredState ?? "stopped",
    tunnel: patch.tunnel ?? previous?.tunnel ?? false,
    registrationMode: patch.registrationMode ?? previous?.registrationMode ?? "none",
    revision: (previous?.revision ?? 0) + 1,
    updatedAt: now,
  });
  writeAtomic(supervisorConfigFile(workspace.id, stateDir), dir, workspace.id, "config", next);
  return next;
}

export async function withSupervisorOperation<T>(
  workspaceRoot: string,
  action: (operation: SupervisorOperation) => T | Promise<T>,
  options: SupervisorStoreOptions = {},
): Promise<T> {
  const workspace = workspaceFor(workspaceRoot);
  const stateDir = stateRoot(options);
  const dir = ensureStoreDirectory(stateDir);
  const identity = await currentIdentity(options);
  const file = supervisorOperationLockFile(workspace.id, stateDir);
  const acquired = await acquireLock(file, dir, workspace, "operation", identity, options);
  let active = true;
  const operation: SupervisorOperation = {
    assertOwned() {
      if (!active) fail("SUPERVISOR_OWNERSHIP_LOST", "supervisor operation handle is no longer active");
      assertLockOwned(file, dir, workspace, "operation", acquired.owner, acquired.snapshot);
    },
    readConfig() {
      operation.assertOwned();
      return readConfigFor(workspace, stateDir, true, dir);
    },
    updateConfig(patch) {
      operation.assertOwned();
      return updateConfigLocked(workspace, patch, stateDir, dir);
    },
  };
  let result: T | undefined;
  let actionError: unknown;
  let failed = false;
  try {
    result = await action(operation);
  }
  catch (error) { actionError = error; failed = true; }
  active = false;
  try { assertLockOwned(file, dir, workspace, "operation", acquired.owner, acquired.snapshot); }
  catch (error) {
    if (!failed) { actionError = error; failed = true; }
    else if (actionError && typeof actionError === "object") {
      const holder = actionError as { cleanupErrors?: Error[] };
      if (!Array.isArray(holder.cleanupErrors)) holder.cleanupErrors = [];
      holder.cleanupErrors.push(error instanceof Error ? error : new Error("supervisor lock ownership lost"));
    }
  }
  const released = releaseOwnedLock(file, acquired.owner, acquired.snapshot);
  if (failed) {
    if (!released && actionError && typeof actionError === "object") {
      const holder = actionError as { cleanupErrors?: Error[] };
      if (!Array.isArray(holder.cleanupErrors)) holder.cleanupErrors = [];
      holder.cleanupErrors.push(new SupervisorStoreError("SUPERVISOR_OWNERSHIP_LOST", "supervisor operation lock release failed"));
    }
    throw actionError;
  }
  if (!released) fail("SUPERVISOR_OWNERSHIP_LOST", "supervisor operation lock release failed");
  return result as T;
}

export function updateSupervisorConfig(workspaceRoot: string, patch: SupervisorConfigPatch, options: SupervisorStoreOptions = {}): Promise<SupervisorConfig> {
  return withSupervisorOperation(workspaceRoot, operation => operation.updateConfig(patch), options);
}

async function removeStaleRuntimeIfNeeded(workspace: Workspace, stateDir: string, options: SupervisorStoreOptions): Promise<void> {
  const initial = readRuntimeEntryFor(workspace, stateDir);
  if (!initial) return;
  const runtime = initial.runtime;
  let observed: ProcessProbe;
  try { observed = processProbeSchema.parse(await currentProbe(options)(runtime.pid, runtime.creationTime)); }
  catch { return fail("SUPERVISOR_BUSY", "existing supervisor runtime process identity is unknown"); }
  if (observed.pid !== runtime.pid || !isProcessProvenMissing(observed)) return fail("SUPERVISOR_BUSY", "existing supervisor runtime is live or cannot be proven stopped");
  const file = supervisorRuntimeFile(workspace.id, stateDir);
  const again = readRuntimeEntryFor(workspace, stateDir);
  if (!again || !sameRuntime(again.runtime, runtime) || !sameSnapshot(initial.snapshot, again.snapshot)) {
    return fail("SUPERVISOR_BUSY", "supervisor runtime changed while checking stale ownership");
  }
  if (!unlinkExactSnapshot(file, initial.snapshot)) return fail("SUPERVISOR_BUSY", "supervisor runtime changed before stale-owner reclaim");
}

export async function acquireSupervisorLease(
  workspaceRoot: string,
  info: SupervisorLeaseInfo,
  options: SupervisorStoreOptions = {},
): Promise<SupervisorLease> {
  const workspace = workspaceFor(workspaceRoot);
  const stateDir = stateRoot(options);
  const dir = ensureStoreDirectory(stateDir);
  const identity = await currentIdentity(options);
  const lockPath = supervisorLeaseFile(workspace.id, stateDir);
  const acquired = await acquireLock(lockPath, dir, workspace, "supervisor", identity, options);
  try {
    await removeStaleRuntimeIfNeeded(workspace, stateDir, options);
    const runtime = supervisorRuntimeSchema.parse({
      version: 1,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      ...identity,
      startedAt: new Date().toISOString(),
      launcherPath: info.launcherPath,
      buildId: info.buildId,
      registrationMode: info.registrationMode,
      nonce: acquired.owner.nonce,
    });
    const runtimeSnapshot = writeAtomic(supervisorRuntimeFile(workspace.id, stateDir), dir, workspace.id, "runtime", runtime, true);
    let released = false;
    const lease: SupervisorLease = {
      runtime,
      lockPath,
      assertOwned() {
        if (released) fail("SUPERVISOR_OWNERSHIP_LOST", "supervisor lease is no longer active");
        assertLeaseOwned(workspace, stateDir, dir, lockPath, acquired.owner, acquired.snapshot, runtime, runtimeSnapshot);
      },
      handoffLaunch(launch) {
        const pin = launchPins.get(launch);
        if (!pin || pin.stateDir !== stateDir || pin.workspaceRoot !== workspace.root ||
            launch.buildId !== runtime.buildId || launch.launcherPath !== runtime.launcherPath)
          fail("SUPERVISOR_OWNERSHIP_LOST", "supervisor launch capability does not match runtime");
        // Runtime was fsynced and atomically published by writeAtomic above.
        // Prove complete lease ownership before removing the startup reference.
        lease.assertOwned();
        const fresh = snapshotFile(pin.file);
        if (!sameSnapshot(pin.snapshot, fresh) || !unlinkExactSnapshot(pin.file, pin.snapshot))
          fail("SUPERVISOR_OWNERSHIP_LOST", "supervisor launch pin changed during handoff");
        launchPins.delete(launch);
      },
      async release() {
        if (released) return true;
        try {
          const file = supervisorRuntimeFile(workspace.id, stateDir);
          assertLeaseOwned(workspace, stateDir, dir, lockPath, acquired.owner, acquired.snapshot, runtime, runtimeSnapshot);
          if (!unlinkExactSnapshot(file, runtimeSnapshot)) return false;
          if (!releaseOwnedLock(lockPath, acquired.owner, acquired.snapshot)) return false;
          released = true;
          return true;
        } catch { return false; }
      },
    };
    return lease;
  } catch (error) {
    releaseOwnedLock(lockPath, acquired.owner, acquired.snapshot);
    throw error;
  }
}

/** Own the complete release session: handoff before work, exact release on exit. */
export async function withSupervisorLaunch<T>(workspaceRoot: string, launch: SupervisorLaunch,
  action: (lease: SupervisorLease) => Promise<T>, options: SupervisorStoreOptions = {}): Promise<T> {
  const lease = await acquireSupervisorLease(workspaceRoot, { ...launch, registrationMode: "windows-scheduled-task" }, options);
  try {
    lease.handoffLaunch(launch);
    return await action(lease);
  } finally {
    if (!await lease.release()) fail("SUPERVISOR_OWNERSHIP_LOST", "supervisor runtime lease release failed");
  }
}
