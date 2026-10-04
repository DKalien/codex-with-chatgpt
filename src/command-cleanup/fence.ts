import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { getStateDir } from "../config/paths.js";
import { CommandCleanupError, cleanupJournalSchema, type CleanupJournal } from "./schema.js";
import { assertNoAbandonmentRepair, assertRepairCapability } from "./abandonment-repair-store.js";
import { assertNoLegacyHistoryCleanup } from "./legacy-history-fence.js";

const context = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean; assertOwned?: () => void }>>();
// Shared producer stores historically accept desktopId; actual cleanup targets still resolve the canonical 12-hex workspace.
const workspaceIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const commandIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

export function cleanupJournalFile(workspaceId: string, commandId: string, stateDir = getStateDir()): string {
  if (!workspaceIdPattern.test(workspaceId) || !commandIdPattern.test(commandId))
    throw new CommandCleanupError("COMMAND_CLEANUP_INVALID", "cleanup workspace/command identity 非法。");
  return path.join(path.resolve(stateDir), "command-cleanup", workspaceId, `${commandId}.json`);
}

export function assertCleanupPath(file: string, stateDir: string): void {
  const root = path.resolve(stateDir);
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "cleanup path 越界。");
  const absolute = path.resolve(file);
  const volumeRoot = path.parse(absolute).root;
  let current = volumeRoot;
  for (const part of absolute.slice(volumeRoot.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (current !== absolute && !stat.isDirectory())) throw new Error("unsafe path");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "cleanup path 非 canonical regular path。");
    }
  }
}

export function assertCleanupStoreFile(file: string, stateDir: string): void {
  for (const candidate of [file, `${file}.initialized`]) {
    assertCleanupPath(candidate, stateDir);
    try { if (!fs.lstatSync(candidate).isFile()) throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "cleanup store 非 regular file。"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const directory = path.dirname(file);
  if (fs.existsSync(directory) && fs.readdirSync(directory).some(name => name.startsWith(`${path.basename(file)}.`) && name.endsWith(".tmp")))
    throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "shared store 有未收敛 atomic-write residue；保留 cleanup_pending，禁止伪称 cleaned。");
}

export function readCleanupJournal(workspaceId: string, commandId: string, stateDir = getStateDir()): CleanupJournal | null {
  const file = cleanupJournalFile(workspaceId, commandId, stateDir);
  assertCleanupPath(file, stateDir);
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error("not regular");
    const value = cleanupJournalSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (value.workspaceId !== workspaceId || value.commandId !== commandId) throw new Error("identity");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "cleanup_pending journal 损坏；保留状态并停止写入。");
  }
}

function operationKey(workspaceId: string, commandId: string, stateDir: string): string {
  return cleanupJournalFile(workspaceId, commandId, stateDir);
}
export function assertCommandWritable(workspaceId: string, commandId: string, stateDir = getStateDir()): void {
  if (readCleanupJournal(workspaceId, commandId, stateDir))
    throw new CommandCleanupError("COMMAND_CLEANUP_IN_PROGRESS", "command 正在 cleanup；不得投递、记录或重新投影。");
}

/** Atomic-write leftovers are not authority. Remove only strict matching temps under the command lock. */
function discardJournalTemps(workspaceId: string, commandId: string, stateDir: string): void {
  const journalFile = cleanupJournalFile(workspaceId, commandId, stateDir);
  const directory = path.dirname(journalFile);
  const prefix = `${path.basename(journalFile)}.`;
  for (const name of fs.readdirSync(directory)) {
    if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(name.slice(prefix.length, -4)))
      throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "cleanup temp identity 非法。");
    const file = path.join(directory, name);
    assertCleanupPath(file, stateDir);
    try {
      if (!fs.lstatSync(file).isFile()) throw new Error("not regular");
      const value = cleanupJournalSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
      if (value.workspaceId !== workspaceId || value.commandId !== commandId) throw new Error("identity");
    } catch { throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "cleanup temp 损坏；拒绝推断或删除。"); }
    fs.unlinkSync(file);
  }
}

type LockIdentity = { dev: number; ino: number };
type OwnedLock = { file: string; raw: string; identity: LockIdentity };
const lockNoncePattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function lockBusy(label: string): CommandCleanupError {
  return new CommandCleanupError("COMMAND_CLEANUP_BUSY", `${label} lock live/unknown/corrupt；不抢占。`);
}
function lockLost(label: string): CommandCleanupError {
  return new CommandCleanupError("COMMAND_CLEANUP_LOCK_LOST", `${label} lock ownership 已变化。`);
}
function sameIdentity(left: LockIdentity, right: LockIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function createOwnedLock(file: string, stateDir: string, label: string): OwnedLock {
  assertCleanupPath(file, stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  assertCleanupPath(file, stateDir);
  let fd: number;
  try { fd = fs.openSync(file, "wx", 0o600); } catch { throw lockBusy(label); }
  try {
    const { dev, ino } = fs.fstatSync(fd);
    const raw = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
    fs.writeFileSync(fd, raw);
    fs.fsyncSync(fd);
    return { file, raw, identity: { dev, ino } };
  } finally { fs.closeSync(fd); }
}

function readLock(file: string, stateDir: string, label: string): { owner: { pid: number; nonce: string }; raw: string; identity: LockIdentity } {
  try {
    assertCleanupPath(file, stateDir);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe lock");
    const raw = fs.readFileSync(file, "utf8");
    const owner = JSON.parse(raw) as { pid?: unknown; nonce?: unknown };
    if (Object.keys(owner).sort().join(",") !== "nonce,pid" || !Number.isSafeInteger(owner.pid) || (owner.pid as number) < 1 || typeof owner.nonce !== "string" || !lockNoncePattern.test(owner.nonce)) throw new Error("invalid lock");
    return { owner: { pid: owner.pid as number, nonce: owner.nonce }, raw, identity: { dev: stat.dev, ino: stat.ino } };
  } catch { throw lockBusy(label); }
}

function unlinkOwnedLock(lock: OwnedLock, stateDir: string, label: string): void {
  try {
    assertCleanupPath(lock.file, stateDir);
    const stat = fs.lstatSync(lock.file);
    if (!stat.isFile() || stat.isSymbolicLink() || !sameIdentity(lock.identity, stat) || fs.readFileSync(lock.file, "utf8") !== lock.raw) throw new Error("ownership changed");
    fs.unlinkSync(lock.file);
  } catch { throw lockLost(label); }
}

function reclaimSidecar(file: string, stateDir: string, label: string): OwnedLock {
  return createOwnedLock(`${file}.reclaim`, stateDir, `${label} reclamation`);
}

function releaseLock(lock: OwnedLock, stateDir: string, label: string): void {
  unlinkOwnedLock(lock, stateDir, label);
}

function acquireLock(file: string, stateDir: string, label: string): () => void {
  const noRepair = () => { try { assertNoAbandonmentRepair(file); } catch { throw lockBusy(label); } };
  noRepair();
  assertCleanupPath(file, stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  assertCleanupPath(file, stateDir);
  if (fs.existsSync(file)) {
    const reclaim = reclaimSidecar(file, stateDir, label);
    try {
      const stale = readLock(file, stateDir, label);
      try { process.kill(stale.owner.pid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw lockBusy(label);
        const fresh = readLock(file, stateDir, label);
        if (!sameIdentity(stale.identity, fresh.identity) || stale.raw !== fresh.raw) throw lockBusy(label);
        noRepair();
        fs.unlinkSync(file);
      }
      if (fs.existsSync(file)) throw lockBusy(label);
    } catch { throw lockBusy(label); }
    finally { unlinkOwnedLock(reclaim, stateDir, `${label} reclamation`); }
  }
  const owned = createOwnedLock(file, stateDir, label);
  // Closes the check/create race with an explicit administrative fence.
  try { noRepair(); } catch (error) { releaseLock(owned, stateDir, label); throw error; }
  return () => releaseLock(owned, stateDir, label);
}

/** @internal Administrative maintenance must start outside any inherited lower-order lifecycle authority. */
export function assertNoCommandOperationInherited(): void {
  if (context.getStore()?.size) throw lockBusy("maintenance must precede command/workspace lifecycle");
}

/** @internal Only a live private repair capability can inherit the adopted lifecycle lock. */
export async function withRepairedCommandOperation<T>(workspaceId: string, commandId: string, capability: object, fn: () => Promise<T>): Promise<T> {
  assertRepairCapability(capability, workspaceId, commandId);
  const key = `command:${operationKey(workspaceId, commandId, getStateDir())}`;
  if (context.getStore()?.has(key)) throw lockBusy("nested repair");
  const lease = { active: true, assertOwned: () => assertRepairCapability(capability, workspaceId, commandId) }, next = new Map(context.getStore()); next.set(key, lease);
  try { return await context.run(next, fn); }
  finally { lease.active = false; }
}

/** Recheck private adopted authority immediately before the abandonment evidence write. */
export function assertCommandOperationOwned(workspaceId: string, commandId: string): void {
  const inherited = context.getStore()?.get(`command:${operationKey(workspaceId, commandId, getStateDir())}`);
  if (!inherited?.active) throw lockLost("command lifecycle");
  inherited.assertOwned?.();
}

function acquireCommandOperation(workspaceId: string, commandId: string, maintenance: boolean, stateDir: string): () => void {
  let release: () => void;
  try { release = acquireLock(`${cleanupJournalFile(workspaceId, commandId, stateDir)}.lock`, stateDir, "command lifecycle"); }
  catch (error) { if (error instanceof CommandCleanupError) error.commandId = commandId; throw error; }
  try { discardJournalTemps(workspaceId, commandId, stateDir); if (!maintenance) assertCommandWritable(workspaceId, commandId, stateDir); }
  catch (error) { release(); throw error; }
  return release;
}

export function workspaceCleanupLockFile(workspaceId: string, stateDir = getStateDir()): string {
  if (!workspaceIdPattern.test(workspaceId)) throw new CommandCleanupError("COMMAND_CLEANUP_INVALID", "cleanup workspace identity 非法。");
  return path.join(path.resolve(stateDir), "command-cleanup-workspace", `${workspaceId}.lock`);
}

export function assertWorkspaceCleanupNotInherited(workspaceId: string, stateDir = getStateDir()): void {
  const inherited = context.getStore()?.get(`workspace:${workspaceCleanupLockFile(workspaceId, stateDir)}`);
  if (!inherited) return;
  if (!inherited.active) throw new CommandCleanupError("COMMAND_CLEANUP_LOCK_LOST", "detached cleanup 的 workspace authority 已结束。");
  throw new CommandCleanupError("COMMAND_CLEANUP_BUSY", "nested workspace cleanup 不允许获取锁。");
}

/** Lock order: command lifecycle -> endpoint/store locks; async send owns it through commit. */
export function withCommandOperation<T>(workspaceId: string, commandId: string, fn: () => T, stateDir = getStateDir(), maintenance = false): T {
  const key = `command:${operationKey(workspaceId, commandId, stateDir)}`;
  const inherited = context.getStore()?.get(key);
  if (inherited) {
    if (!inherited.active) throw new CommandCleanupError("COMMAND_CLEANUP_LOCK_LOST", "detached writer 的 lifecycle authority 已结束。");
    inherited.assertOwned?.();
    if (!maintenance) assertCommandWritable(workspaceId, commandId, stateDir); return fn();
  }
  const release = acquireCommandOperation(workspaceId, commandId, maintenance, stateDir);
  const lease = { active: true };
  const next = new Map(context.getStore()); next.set(key, lease);
  try { return context.run(next, fn); } finally { lease.active = false; release(); }
}

/** Lock order: command lifecycle -> workspace cleanup -> endpoint/store locks. */
export function withWorkspaceCleanupOperation<T>(workspaceId: string, stateDir: string, fn: () => T): T {
  assertNoLegacyHistoryCleanup(workspaceId, stateDir);
  const file = workspaceCleanupLockFile(workspaceId, stateDir);
  const key = `workspace:${file}`;
  assertWorkspaceCleanupNotInherited(workspaceId, stateDir);
  const release = acquireLock(file, stateDir, "workspace cleanup");
  const lease = { active: true };
  const next = new Map(context.getStore()); next.set(key, lease);
  try { assertNoLegacyHistoryCleanup(workspaceId, stateDir); return context.run(next, fn); } finally { lease.active = false; release(); }
}

export async function withCommandOperationAsync<T>(workspaceId: string, commandId: string, fn: () => Promise<T>, stateDir = getStateDir()): Promise<T> {
  const key = `command:${operationKey(workspaceId, commandId, stateDir)}`;
  const inherited = context.getStore()?.get(key);
  if (inherited) {
    if (!inherited.active) throw new CommandCleanupError("COMMAND_CLEANUP_LOCK_LOST", "detached writer 的 lifecycle authority 已结束。");
    inherited.assertOwned?.();
    assertCommandWritable(workspaceId, commandId, stateDir); return fn();
  }
  // A queued old writer must not acquire authority after cleanup removed its fence.
  // Busy is fail-closed; callers may submit a fresh request after rereading current state.
  const release = acquireCommandOperation(workspaceId, commandId, false, stateDir);
  const lease = { active: true };
  const next = new Map(context.getStore()); next.set(key, lease);
  try { return await context.run(next, fn); } finally { lease.active = false; release(); }
}

export function writeCleanupJournal(journal: CleanupJournal, stateDir = getStateDir()): void {
  const valid = cleanupJournalSchema.parse(journal);
  const file = cleanupJournalFile(valid.workspaceId, valid.commandId, stateDir);
  assertCleanupPath(file, stateDir); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(valid)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export function removeCleanupJournal(journal: CleanupJournal, stateDir = getStateDir()): void {
  const current = readCleanupJournal(journal.workspaceId, journal.commandId, stateDir);
  if (!current || JSON.stringify(current) !== JSON.stringify(journal)) throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "cleanup journal 已变化。");
  discardJournalTemps(journal.workspaceId, journal.commandId, stateDir);
  fs.unlinkSync(cleanupJournalFile(journal.workspaceId, journal.commandId, stateDir));
}
