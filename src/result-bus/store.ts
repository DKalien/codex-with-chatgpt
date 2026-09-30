import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDir, getStateDir } from "../config/paths.js";
import { resolveWorkspaceIdentity, type RoutingWorkspaceIdentity } from "../routing/store.js";
import { canonicalRoutingResultDigest } from "../routing/execution-result-digest.js";
import { routingCommandIdSchema, routingWorkspaceIdSchema, type RoutingResult } from "../routing/schema.js";
import { resultBusEntryId, resultBusEntrySchema, resultBusStateSchema, type ResultBusEntry, type ResultBusState } from "./schema.js";

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

function withLock<T>(identity: RoutingWorkspaceIdentity, stateDir: string, fn: (state: ResultBusState | null) => { state: ResultBusState; result: T; noWrite?: boolean }): T {
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
      if (!previous || JSON.stringify(next.state) !== JSON.stringify(previous)) throw corrupt();
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

function canonicalEntry(identity: RoutingWorkspaceIdentity, result: RoutingResult): ResultBusEntry {
  const parsedCommandId = routingCommandIdSchema.parse(result.commandId);
  const digest = canonicalRoutingResultDigest(result);
  const now = new Date().toISOString();
  return resultBusEntrySchema.parse({
    version: 1,
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

export function listResultBusEntries(identity: RoutingWorkspaceIdentity, stateDir = getStateDir()): ResultBusEntry[] {
  return readResultBus(identity, stateDir)?.entries ?? [];
}

export function enqueueResultBusEntry(identity: RoutingWorkspaceIdentity, result: RoutingResult, stateDir = getStateDir()): { entry: ResultBusEntry; replayed: boolean } {
  const resolved = resolveWorkspaceIdentity(identity);
  const expected = canonicalEntry(resolved, result);
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
  const expected = results.map(result => canonicalEntry(resolved, result));
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
}
