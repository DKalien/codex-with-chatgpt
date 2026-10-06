import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDir, getStateDir } from "../config/paths.js";
import { resolveWorkspaceIdentity, type RoutingWorkspaceIdentity } from "../routing/store.js";
import { resultBusResultDigest, type OfficialResult } from "./official-result.js";
import { routingCommandIdSchema, routingWorkspaceIdSchema, type RoutingResult } from "../routing/schema.js";
import { resultBusEntryId, resultBusEntrySchema, resultBusStateSchema, type ResultBusEntry, type ResultBusState } from "./schema.js";
import { isEphemeralCommand } from "../command-cleanup/ownership.js";
import { assertCleanupStoreFile, readCleanupJournal, withCommandOperation } from "../command-cleanup/fence.js";
import { assertCleanupArtifacts, cleanupArtifact, CommandCleanupError, type CleanupArtifact, type CommandCleanupTarget } from "../command-cleanup/schema.js";

export class ResultBusError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ResultBusError";
  }
}

const MAX_ENTRIES = 10_000;

export function resultBusFile(workspaceId: string, stateDir = getStateDir()): string {
  return path.join(path.resolve(stateDir), "result-bus", `${routingWorkspaceIdSchema.parse(workspaceId)}.json`);
}

export function resultBusInitializedFile(workspaceId: string, stateDir = getStateDir()): string {
  return `${resultBusFile(workspaceId, stateDir)}.initialized`;
}

function corrupt(): ResultBusError {
  return new ResultBusError("RESULT_BUS_STATE_CORRUPT", "Workspace Result Bus 状态损坏或 workspace identity 不匹配；保留原文件。 ");
}

function readState(identity: RoutingWorkspaceIdentity, stateDir: string): ResultBusState | null {
  const file = resultBusFile(identity.id, stateDir);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw corrupt();
    const state = resultBusStateSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (state.workspaceId !== identity.id || state.workspaceRoot !== identity.root || state.revision < 1) throw corrupt();
    return state;
  } catch (error) {
    if (error instanceof ResultBusError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (fs.existsSync(resultBusInitializedFile(identity.id, stateDir))) throw corrupt();
      return null;
    }
    throw corrupt();
  }
}

function emptyState(identity: RoutingWorkspaceIdentity): ResultBusState {
  return { version: 1, workspaceId: identity.id, workspaceRoot: identity.root, revision: 0, entries: [] };
}

function writeAtomic(file: string, state: ResultBusState): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(resultBusStateSchema.parse(state)));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/**
 * Result Bus 事务变更描述。
 * - 无 noWrite：语义写；revision +1、fsync + atomic rename。
 * - noWrite + previous 非 null：必须与 previous 字节等价（精确重放），否则 corrupt。
 * - noWrite + previous === null + state === null：absent-state 只读空操作，
 *   不创建文件/marker。caller 不能借 noWrite 注入已变更的非空 state。
 */
type ResultBusChange<T> = { state: ResultBusState | null; result: T; noWrite?: boolean };

function withLock<T>(identity: RoutingWorkspaceIdentity, stateDir: string, fn: (state: ResultBusState | null) => ResultBusChange<T>): T {
  const file = resultBusFile(identity.id, stateDir);
  ensureDir(path.dirname(file));
  let lock: number;
  try {
    lock = fs.openSync(`${file}.lock`, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ResultBusError("RESULT_BUS_BUSY", "Workspace Result Bus 写锁繁忙。 ");
    throw error;
  }
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    fs.fsyncSync(lock);
    const previous = readState(identity, stateDir);
    const next = fn(previous);
    if (next.noWrite) {
      if (!previous) {
        // 唯一合法的 null-state 只读路径：noWrite + state null；注入非空 state 即 corrupt。
        if (next.state !== null) throw corrupt();
        return next.result;
      }
      if (JSON.stringify(next.state) !== JSON.stringify(previous)) throw corrupt();
      return next.result;
    }
    const revision = previous ? previous.revision + 1 : 1;
    if (revision > Number.MAX_SAFE_INTEGER) throw new ResultBusError("RESULT_BUS_REVISION_EXHAUSTED", "Result Bus revision 已到上限。 ");
    const valid = resultBusStateSchema.parse({ ...next.state, revision });
    if (!fs.existsSync(resultBusInitializedFile(identity.id, stateDir))) {
      const marker = fs.openSync(resultBusInitializedFile(identity.id, stateDir), "wx", 0o600);
      try { fs.writeFileSync(marker, `${identity.id}\n`); fs.fsyncSync(marker); } finally { fs.closeSync(marker); }
    }
    writeAtomic(file, valid);
    return next.result;
  } finally {
    try { fs.closeSync(lock); } finally { fs.rmSync(`${file}.lock`, { force: true }); }
  }
}

function canonicalEntry(identity: RoutingWorkspaceIdentity, result: RoutingResult | OfficialResult, stateDir: string): ResultBusEntry {
  const parsedCommandId = routingCommandIdSchema.parse(result.commandId);
  const digest = resultBusResultDigest(result);
  const now = new Date().toISOString();
  return resultBusEntrySchema.parse({
    version: 1,
    ...(isEphemeralCommand(identity.id, result.commandId, stateDir) ? { lifecycle: "ephemeral" } : {}),
    busEntryId: resultBusEntryId(identity.id, parsedCommandId, result.iteration),
    workspaceId: identity.id,
    commandId: parsedCommandId,
    iteration: result.iteration,
    resultId: result.resultId,
    resultSha256: digest,
    result,
    createdAt: now,
    deliveryStatus: "queued",
    sendTarget: null,
    reservation: null,
    attempt: null,
    observedAt: null,
    outcomeUnknownAt: null,
    retiredAt: null,
    outcomeReasonCode: null,
  });
}

function sameImmutable(left: ResultBusEntry, right: ResultBusEntry): boolean {
  return left.busEntryId === right.busEntryId && left.workspaceId === right.workspaceId && left.commandId === right.commandId &&
    left.iteration === right.iteration && left.resultId === right.resultId && left.resultSha256 === right.resultSha256 &&
    JSON.stringify(left.result) === JSON.stringify(right.result);
}

export function readResultBus(identity: RoutingWorkspaceIdentity, stateDir = getStateDir()): ResultBusState | null {
  const resolved = resolveWorkspaceIdentity(identity);
  return readState(resolved, stateDir);
}

/**
 * R5d2 transactional mutation boundary：Result Bus 的唯一写路径。
 * - 每 workspace 一把 durable 锁；写前 strict parse（损坏 fail closed）；
 * - 语义写 revision +1 恰好一次；noWrite 必须与 previous 字节等价；
 * - fsync + atomic rename + initialized marker 语义保持。
 * delivery lifecycle 服务不得绕开本原语直接改写 Result Bus JSON。
 */
export function withResultBusTransaction<T>(
  identity: RoutingWorkspaceIdentity,
  change: (state: ResultBusState | null) => ResultBusChange<T>,
  stateDir = getStateDir(),
): T {
  const resolved = resolveWorkspaceIdentity(identity);
  return withLock(resolved, stateDir, change);
}

/** createdAt 升序 + busEntryId 稳定决胜；不使用 planner route 顺序。 */
export function compareResultBusEntries(a: ResultBusEntry, b: ResultBusEntry): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.busEntryId !== b.busEntryId) return a.busEntryId < b.busEntryId ? -1 : 1;
  return 0;
}

export function listResultBusEntries(identity: RoutingWorkspaceIdentity, stateDir = getStateDir()): ResultBusEntry[] {
  return readResultBus(identity, stateDir)?.entries ?? [];
}

export function enqueueResultBusEntry(identity: RoutingWorkspaceIdentity, result: RoutingResult | OfficialResult, stateDir = getStateDir()): { entry: ResultBusEntry; replayed: boolean } {
  const resolved = resolveWorkspaceIdentity(identity);
  return withCommandOperation(resolved.id, result.commandId, () => {
  const expected = canonicalEntry(resolved, result, stateDir);
  return withLock(resolved, stateDir, previous => {
    const current = previous ?? emptyState(resolved);
    const existing = current.entries.find(item => item.commandId === expected.commandId && item.iteration === expected.iteration);
    if (existing) {
      if (!sameImmutable(existing, expected)) throw new ResultBusError("RESULT_BUS_CONFLICT", "同一 command+iteration 的 canonical result 已漂移。 ");
      return { state: current, result: { entry: existing, replayed: true } as { entry: ResultBusEntry; replayed: boolean }, noWrite: true };
    }
    if (current.entries.length >= MAX_ENTRIES) throw new ResultBusError("RESULT_BUS_FULL", "Workspace Result Bus 已达到 10000 条上限。 ");
    return { state: { ...current, entries: [...current.entries, expected] }, result: { entry: expected, replayed: false } as { entry: ResultBusEntry; replayed: boolean } };
  });
  }, stateDir);
}

/**
 * Shadow reconcile primitive：单锁批量比对 persisted canonical results 与 Bus entries。
 * - 缺失 → 幂等补建（crash gap / pre-R5d backfill）；
 * - 已存在 → 只比对不可变 canonical identity（busEntryId/resultId/digest/result bytes），
 *   绝不触碰 deliveryStatus/sendTarget 等未来投递状态；
 * - 同 (commandId, iteration) 内容漂移 → fail closed。
 * 调用方须传入 canonical results；legacy result 由上层过滤，不在此静默跳过。
 */
export function enqueueResultBusEntries(
  identity: RoutingWorkspaceIdentity,
  results: readonly RoutingResult[],
  stateDir = getStateDir(),
): { projected: number; replayed: number } {
  const resolved = resolveWorkspaceIdentity(identity);
  const commandIds = [...new Set(results.map(result => result.commandId))].sort();
  const locked = (index: number): { projected: number; replayed: number } => index < commandIds.length
    ? withCommandOperation(resolved.id, commandIds[index]!, () => locked(index + 1), stateDir)
    : enqueueLocked();
  const enqueueLocked = (): { projected: number; replayed: number } => {
  const expected = results.map(result => canonicalEntry(resolved, result, stateDir));
  if (expected.length === 0) return { projected: 0, replayed: 0 };
  return withLock(resolved, stateDir, previous => {
    const current = previous ?? emptyState(resolved);
    const entries = [...current.entries];
    const byKey = new Map<string, ResultBusEntry>(entries.map(entry => [`${entry.commandId}\u0000${entry.iteration}`, entry]));
    let projected = 0;
    let replayed = 0;
    for (const candidate of expected) {
      const key = `${candidate.commandId}\u0000${candidate.iteration}`;
      const existing = byKey.get(key);
      if (existing) {
        if (!sameImmutable(existing, candidate)) throw new ResultBusError("RESULT_BUS_CONFLICT", "同一 command+iteration 的 canonical result 已漂移。 ");
        replayed += 1;
        continue;
      }
      if (entries.length >= MAX_ENTRIES) throw new ResultBusError("RESULT_BUS_FULL", "Workspace Result Bus 已达到 10000 条上限。 ");
      entries.push(candidate);
      byKey.set(key, candidate);
      projected += 1;
    }
    if (projected === 0) {
      if (!previous) throw corrupt();
      return { state: previous, result: { projected, replayed }, noWrite: true };
    }
    return { state: { ...current, entries }, result: { projected, replayed } };
  });
  };
  return locked(0);
}

export function inspectResultBusCleanupArtifacts(target: CommandCleanupTarget): CleanupArtifact[] {
  assertCleanupStoreFile(resultBusFile(target.workspaceId, target.stateDir), target.stateDir ?? getStateDir());
  const entries = listResultBusEntries({ id: target.workspaceId, root: target.workspaceRoot }, target.stateDir)
    .filter(entry => entry.commandId === target.commandId);
  if (entries.some(entry => entry.iteration !== target.iteration)) throw new CommandCleanupError("COMMAND_CLEANUP_AMBIGUOUS", "command 有其他 iteration，禁止部分清理。");
  return entries.map(entry => cleanupArtifact("result_bus", entry.busEntryId, entry));
}

export function deleteResultBusCleanupArtifacts(target: CommandCleanupTarget, expected: readonly CleanupArtifact[]): void {
  const stateDir = target.stateDir ?? getStateDir();
  const journal = readCleanupJournal(target.workspaceId, target.commandId, stateDir);
  if (!journal || journal.workspaceRoot !== target.workspaceRoot || JSON.stringify(journal.artifacts) !== JSON.stringify(expected))
    throw new CommandCleanupError("COMMAND_CLEANUP_REQUIRED", "删除 Result Bus 必须持有 exact cleanup journal。");
  withResultBusTransaction({ id: target.workspaceId, root: target.workspaceRoot }, previous => {
    const current = inspectResultBusCleanupArtifacts(target);
    assertCleanupArtifacts(current, expected);
    if (current.length === 0) return { state: previous, noWrite: true, result: undefined };
    return { state: { ...previous!, entries: previous!.entries.filter(entry => entry.commandId !== target.commandId) }, result: undefined };
  }, stateDir);
}
