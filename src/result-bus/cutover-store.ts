import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDir, getStateDir } from "../config/paths.js";
import { resolveWorkspaceIdentity, type RoutingWorkspaceIdentity } from "../routing/store.js";
import { routingWorkspaceIdSchema } from "../routing/schema.js";
import {
  resultBusCutoverEntrySchema,
  resultBusCutoverStateSchema,
  type ResultBusCutoverDisposition,
  type ResultBusCutoverEntry,
  type ResultBusCutoverState,
} from "./cutover-schema.js";

export class ResultBusCutoverError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ResultBusCutoverError";
  }
}

export function resultBusCutoverFile(workspaceId: string, stateDir = getStateDir()): string {
  return path.join(path.resolve(stateDir), "result-bus-cutover", `${routingWorkspaceIdSchema.parse(workspaceId)}.json`);
}

export function resultBusCutoverInitializedFile(workspaceId: string, stateDir = getStateDir()): string {
  return `${resultBusCutoverFile(workspaceId, stateDir)}.initialized`;
}

function corrupt(): ResultBusCutoverError {
  return new ResultBusCutoverError("RESULT_BUS_CUTOVER_STATE_CORRUPT", "Result Bus cutover ledger 损坏或 workspace identity 不匹配；保留原文件。");
}

function readState(identity: RoutingWorkspaceIdentity, stateDir: string): ResultBusCutoverState | null {
  const file = resultBusCutoverFile(identity.id, stateDir);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw corrupt();
    const state = resultBusCutoverStateSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (state.workspaceId !== identity.id || state.workspaceRoot !== identity.root || state.revision < 1) throw corrupt();
    return state;
  } catch (error) {
    if (error instanceof ResultBusCutoverError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (fs.existsSync(resultBusCutoverInitializedFile(identity.id, stateDir))) throw corrupt();
      return null;
    }
    throw corrupt();
  }
}

function writeAtomic(file: string, state: ResultBusCutoverState): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(resultBusCutoverStateSchema.parse(state)));
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

type CutoverChange<T> = { state: ResultBusCutoverState | null; result: T; noWrite?: boolean };

function withCutoverLock<T>(identity: RoutingWorkspaceIdentity, stateDir: string, fn: (state: ResultBusCutoverState | null) => CutoverChange<T>): T {
  const file = resultBusCutoverFile(identity.id, stateDir);
  ensureDir(path.dirname(file));
  let lock: number;
  try {
    lock = fs.openSync(`${file}.lock`, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ResultBusCutoverError("RESULT_BUS_CUTOVER_BUSY", "Result Bus cutover ledger 写锁繁忙。");
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
    const valid = resultBusCutoverStateSchema.parse({ ...next.state, revision });
    if (!fs.existsSync(resultBusCutoverInitializedFile(identity.id, stateDir))) {
      const marker = fs.openSync(resultBusCutoverInitializedFile(identity.id, stateDir), "wx", 0o600);
      try { fs.writeFileSync(marker, `${identity.id}\n`); fs.fsyncSync(marker); } finally { fs.closeSync(marker); }
    }
    writeAtomic(file, valid);
    return next.result;
  } finally {
    try { fs.closeSync(lock); } finally { fs.rmSync(`${file}.lock`, { force: true }); }
  }
}

export function readResultBusCutover(identity: RoutingWorkspaceIdentity, stateDir = getStateDir()): ResultBusCutoverState | null {
  const resolved = resolveWorkspaceIdentity(identity);
  return readState(resolved, stateDir);
}

export function listResultBusCutoverDispositions(identity: RoutingWorkspaceIdentity, stateDir = getStateDir()): ResultBusCutoverEntry[] {
  return readResultBusCutover(identity, stateDir)?.entries ?? [];
}

/** 幂等记录终局处置：同 busEntryId + 同 disposition 精确重放 noWrite；disposition 漂移 fail closed。 */
export function recordResultBusCutoverDisposition(
  identity: RoutingWorkspaceIdentity,
  input: { busEntryId: string; resultSha256: string; legacyEventId: string; disposition: ResultBusCutoverDisposition },
  stateDir = getStateDir(),
): { entry: ResultBusCutoverEntry; replayed: boolean } {
  const resolved = resolveWorkspaceIdentity(identity);
  return withCutoverLock<{ entry: ResultBusCutoverEntry; replayed: boolean }>(resolved, stateDir, previous => {
    const current = previous ?? { version: 1 as const, workspaceId: resolved.id, workspaceRoot: resolved.root, revision: 0, entries: [] };
    const existing = current.entries.find(item => item.busEntryId === input.busEntryId);
    if (existing) {
      if (existing.disposition !== input.disposition || existing.legacyEventId !== input.legacyEventId || existing.resultSha256 !== input.resultSha256) {
        throw new ResultBusCutoverError("RESULT_BUS_CUTOVER_CONFLICT", "同一 busEntryId 的 cutover disposition 已漂移。");
      }
      return { state: previous, noWrite: true, result: { entry: existing, replayed: true } };
    }
    const entry = resultBusCutoverEntrySchema.parse({
      ...input,
      recordedAt: new Date().toISOString(),
    });
    return {
      state: { ...current, entries: [...current.entries, entry] },
      result: { entry, replayed: false },
    };
  });
}
