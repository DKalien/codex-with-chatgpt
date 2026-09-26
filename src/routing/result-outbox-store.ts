import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";
import {
  RoutingError,
  resultSchema,
  routingCommandIdSchema,
  routingWorkspaceIdSchema,
  type RoutingResult,
} from "./schema.js";
import {
  readRouting,
  resolveWorkspaceIdentity,
  type RoutingWorkspaceIdentity,
} from "./store.js";
import {
  resultOutboxEntryId,
  resultOutboxEntrySchema,
  resultOutboxReconciliationNeededSchema,
  resultOutboxStateSchema,
  resultReconciliationQueueSchema,
  type ResultOutboxEntry,
  type ResultOutboxReconciliationInput,
  type ResultOutboxReconciliationNeeded,
  type ResultOutboxState,
  type ResultReconciliationQueue,
} from "./result-outbox-schema.js";
export type {
  ResultOutboxEntry,
  ResultOutboxReconciliationInput,
  ResultOutboxReconciliationNeeded,
  ResultOutboxState,
  ResultReconciliationQueue,
} from "./result-outbox-schema.js";

const enqueueInputSchema = z.object({
  commandId: routingCommandIdSchema,
  iteration: z.number().int().positive(),
}).strict();
const reconciliationInputSchema = z.object({
  commandId: routingCommandIdSchema,
  reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
}).strict();

function outboxError(code: string, message: string): RoutingError {
  return new RoutingError(code, message);
}

function corrupt(): RoutingError {
  return outboxError(
    "RESULT_OUTBOX_CORRUPT",
    "Routing Result Outbox 损坏、身份不匹配或初始化不完整；保留原文件并人工核对。",
  );
}

export function resultOutboxFile(workspaceId: string, stateDir = getStateDir()): string {
  return path.join(
    path.resolve(stateDir),
    "routing",
    `${routingWorkspaceIdSchema.parse(workspaceId)}.result-outbox.json`,
  );
}

export function resultReconciliationQueueFile(workspaceId: string, stateDir = getStateDir()): string {
  return path.join(
    path.resolve(stateDir),
    "routing",
    `${routingWorkspaceIdSchema.parse(workspaceId)}.result-reconciliation.json`,
  );
}

function readOutboxState(
  identity: RoutingWorkspaceIdentity,
  file: string,
): ResultOutboxState | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw corrupt();
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw corrupt();
  try {
    const state = resultOutboxStateSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (state.revision < 1 || state.workspaceId !== identity.id || state.workspaceRoot !== identity.root) throw corrupt();
    return state;
  } catch (error) {
    if (error instanceof RoutingError) throw error;
    throw corrupt();
  }
}

function readReconciliationQueue(
  identity: RoutingWorkspaceIdentity,
  file: string,
): ResultReconciliationQueue | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw outboxError("RESULT_RECONCILIATION_STATE_CORRUPT", "R4 reconciliation queue 不可读取；保留原文件。");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw outboxError("RESULT_RECONCILIATION_STATE_CORRUPT", "R4 reconciliation queue 不是普通文件；保留原文件。");
  }
  try {
    const queue = resultReconciliationQueueSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (queue.revision < 1 || queue.workspaceId !== identity.id || queue.workspaceRoot !== identity.root) {
      throw outboxError("RESULT_RECONCILIATION_STATE_CORRUPT", "R4 reconciliation queue 身份不匹配或版本无效；保留原文件。");
    }
    return queue;
  } catch (error) {
    if (error instanceof RoutingError) throw error;
    throw outboxError("RESULT_RECONCILIATION_STATE_CORRUPT", "R4 reconciliation queue 损坏；保留原文件。");
  }
}

function emptyState(identity: RoutingWorkspaceIdentity): ResultOutboxState {
  return {
    version: 1,
    workspaceId: identity.id,
    workspaceRoot: identity.root,
    revision: 0,
    entries: [],
  };
}

function emptyReconciliationQueue(identity: RoutingWorkspaceIdentity): ResultReconciliationQueue {
  return { version: 1, workspaceId: identity.id, workspaceRoot: identity.root, revision: 0, entries: [] };
}

function validateReferences(
  state: ResultOutboxState | null,
  routing: ReturnType<typeof readRouting>,
): void {
  if (!state?.entries.length) return;
  for (const entry of state.entries) {
    const command = routing?.commands.find((item) => item.commandId === entry.commandId);
    const result = routing?.results.find(
      (item) => item.commandId === entry.commandId && item.iteration === entry.iteration,
    );
    if (!command || !result) {
      throw outboxError("RESULT_OUTBOX_DANGLING", "Outbox entry 引用的 Routing Command 或 Result 已不存在。保留状态并人工核对。");
    }
    const expected = canonicalEntryFields(routing, entry.commandId, entry.iteration, true);
    if (!sameReference(entry, expected)) {
      throw outboxError("RESULT_OUTBOX_CONFLICT", "同一 command+iteration 的 canonical result 或 planner route 已漂移；拒绝覆盖 Outbox。");
    }
  }
}

type EntryReference = Omit<ResultOutboxEntry, "createdAt">;

function canonicalEntryFields(
  routing: ReturnType<typeof readRouting>,
  commandId: string,
  iteration: number,
  validatingStoredEntry = false,
): EntryReference {
  if (!routing) {
    throw outboxError(
      validatingStoredEntry ? "RESULT_OUTBOX_DANGLING" : "RESULT_OUTBOX_COMMAND_NOT_FOUND",
      "Routing state 尚未初始化，不能解析 Command 和 canonical Result。",
    );
  }
  const command = routing.commands.find((item) => item.commandId === commandId);
  if (!command) {
    throw outboxError(
      validatingStoredEntry ? "RESULT_OUTBOX_DANGLING" : "RESULT_OUTBOX_COMMAND_NOT_FOUND",
      "Routing state 中不存在对应 Command。",
    );
  }
  const planner = routing.routes.find((route) => route.routeId === command.plannerRouteId);
  if (!planner || planner.role !== "planner") {
    throw outboxError(
      validatingStoredEntry ? "RESULT_OUTBOX_DANGLING" : "RESULT_OUTBOX_PLANNER_INVALID",
      "Command.plannerRouteId 未解析到本 workspace 持久化的 planner route。",
    );
  }
  const result = routing.results.find(
    (item) => item.commandId === commandId && item.iteration === iteration,
  );
  if (!result) {
    throw outboxError(
      validatingStoredEntry ? "RESULT_OUTBOX_DANGLING" : "RESULT_OUTBOX_RESULT_NOT_FOUND",
      "Routing state 中不存在对应 canonical Result。",
    );
  }
  if (result.executorRouteId !== command.executorRouteId) {
    throw outboxError("RESULT_OUTBOX_CONFLICT", "canonical Result.executorRouteId 与 Command 不一致。");
  }
  const resultSha256 = canonicalRoutingResultDigest(result);
  return {
    version: 1,
    outboxEntryId: resultOutboxEntryId(routing.workspaceId, commandId, iteration),
    workspaceId: routing.workspaceId,
    plannerRouteId: command.plannerRouteId,
    commandId,
    resultId: result.resultId,
    executorRouteId: result.executorRouteId,
    iteration,
    status: result.status,
    resultSha256,
    deliveryStatus: "pending",
  };
}

function sameReference(entry: ResultOutboxEntry, expected: EntryReference): boolean {
  return Object.entries(expected).every(([key, value]) => entry[key as keyof ResultOutboxEntry] === value);
}

/** Digest the strict, canonical RoutingResult envelope, including its evidence and immutable identity. */
export function canonicalRoutingResultDigest(result: RoutingResult): string {
  const parsed = resultSchema.parse(result);
  if (!("rawSummary" in parsed) || !("machineEvidence" in parsed)) {
    throw outboxError("RESULT_OUTBOX_LEGACY_RESULT", "legacy RoutingResult 缺少 summary/evidence，不能进入 Result Outbox。");
  }
  return createHash("sha256").update(JSON.stringify(parsed), "utf8").digest("hex");
}

function withRoutingFileLock<T>(file: string, busyCode: string, busyMessage: string, action: () => T): T {
  ensureDir(path.dirname(file));
  let fd: number;
  try {
    fd = fs.openSync(`${file}.lock`, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw outboxError(busyCode, busyMessage);
    }
    throw error;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    fs.fsyncSync(fd);
    return action();
  } finally {
    try {
      fs.closeSync(fd);
    } finally {
      fs.unlinkSync(`${file}.lock`);
    }
  }
}

function writeAtomicJson(file: string, state: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify(state));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function writeState(file: string, state: ResultOutboxState): void {
  writeAtomicJson(file, resultOutboxStateSchema.parse(state));
}

function writeReconciliationQueue(file: string, state: ResultReconciliationQueue): void {
  writeAtomicJson(file, resultReconciliationQueueSchema.parse(state));
}

function bumpedRevision(state: { revision: number }): number {
  if (state.revision >= Number.MAX_SAFE_INTEGER) {
    throw outboxError("RESULT_OUTBOX_REVISION_EXHAUSTED", "Result Outbox revision 已到安全整数上限，拒绝覆盖状态。");
  }
  return state.revision + 1;
}

function validatedExistingState(
  identity: RoutingWorkspaceIdentity,
  file: string,
  stateDir: string,
): { state: ResultOutboxState | null; routing: ReturnType<typeof readRouting> } {
  const state = readOutboxState(identity, file);
  const routing = state?.entries.length ? readRouting(identity, stateDir) : null;
  validateReferences(state, routing);
  return { state, routing };
}

export function listResultOutboxEntries(
  identity: RoutingWorkspaceIdentity,
  stateDir = getStateDir(),
): ResultOutboxEntry[] {
  const resolved = resolveWorkspaceIdentity(identity);
  const file = resultOutboxFile(resolved.id, stateDir);
  const state = readOutboxState(resolved, file);
  if (!state) return [];
  const routing = state.entries.length ? readRouting(resolved, stateDir) : null;
  validateReferences(state, routing);
  return state.entries;
}

/** Independent discovery surface: unlike the outbox writer, this queue uses its own file and lock. */
export function listResultReconciliationNeeded(
  identity: RoutingWorkspaceIdentity,
  stateDir = getStateDir(),
): ResultOutboxReconciliationNeeded[] {
  const resolved = resolveWorkspaceIdentity(identity);
  const queue = readReconciliationQueue(resolved, resultReconciliationQueueFile(resolved.id, stateDir));
  return queue?.entries ?? [];
}

/**
 * Persist the recovery intent before a canonical Desktop receipt is committed.
 * No Routing Command means this is a legacy/generic Desktop receipt, not R4 work.
 */
export function prepareResultReconciliation(
  identity: RoutingWorkspaceIdentity,
  commandId: string,
  receiptAlreadyExists = false,
  stateDir = getStateDir(),
): void {
  const parsedCommandId = routingCommandIdSchema.parse(commandId);
  const resolved = resolveWorkspaceIdentity(identity);
  let routing: ReturnType<typeof readRouting>;
  try {
    routing = readRouting(resolved, stateDir);
  } catch {
    // Keep the crash discoverable even when Routing itself is corrupt; reconciliation
    // will report the exact corruption without treating this marker as a result.
    markResultReconciliationNeeded(resolved, {
      commandId: parsedCommandId,
      reasonCode: "RESULT_RECONCILIATION_PENDING",
    }, stateDir);
    return;
  }
  if (!routing?.commands.some(item => item.commandId === parsedCommandId)) return;

  if (receiptAlreadyExists) {
    const result = routing.results.find(item => item.commandId === parsedCommandId && item.iteration === 1);
    if (result && "rawSummary" in result && "machineEvidence" in result) {
      try {
        if (listResultOutboxEntries(resolved, stateDir).some(item =>
          item.commandId === parsedCommandId && item.iteration === 1 && item.resultId === result.resultId)) return;
      } catch {
        // Leave an explicit recovery item; the reconciler will preserve the outbox
        // file and replace this generic pending reason with the concrete failure.
      }
    }
  }

  markResultReconciliationNeeded(resolved, {
    commandId: parsedCommandId,
    reasonCode: "RESULT_RECONCILIATION_PENDING",
  }, stateDir);
}

export function enqueueResultOutboxEntry(
  identity: RoutingWorkspaceIdentity,
  input: { commandId: string; iteration: number },
  stateDir = getStateDir(),
): { entry: ResultOutboxEntry; replayed: boolean } {
  const parsed = enqueueInputSchema.parse(input);
  const resolved = resolveWorkspaceIdentity(identity);
  const file = resultOutboxFile(resolved.id, stateDir);
  return withRoutingFileLock(file, "RESULT_OUTBOX_BUSY", "Result Outbox 写锁繁忙；保留状态并稍后重试。", () => {
    const { state: stored } = validatedExistingState(resolved, file, stateDir);
    const current = stored ?? emptyState(resolved);
    const routing = readRouting(resolved, stateDir);
    const expected = canonicalEntryFields(routing, parsed.commandId, parsed.iteration);
    const existing = current.entries.find(
      (entry) => entry.commandId === parsed.commandId && entry.iteration === parsed.iteration,
    );
    if (existing) {
      if (!sameReference(existing, expected)) {
        throw outboxError("RESULT_OUTBOX_CONFLICT", "同一 command+iteration 的 digest/planner/result/status 已漂移；拒绝覆盖 Outbox。");
      }
      return { entry: existing, replayed: true };
    }
    if (current.entries.length >= 10_000) {
      throw outboxError("RESULT_OUTBOX_FULL", "Result Outbox 已达到 10000 条上限，拒绝丢弃或覆盖历史 entry。");
    }
    const entry = resultOutboxEntrySchema.parse({ ...expected, createdAt: new Date().toISOString() });
    writeState(file, {
      ...current,
      revision: bumpedRevision(current),
      entries: [...current.entries, entry],
    });
    return { entry, replayed: false };
  });
}

export function markResultReconciliationNeeded(
  identity: RoutingWorkspaceIdentity,
  input: ResultOutboxReconciliationInput,
  stateDir = getStateDir(),
): ResultOutboxReconciliationNeeded {
  const parsed = reconciliationInputSchema.parse(input);
  const resolved = resolveWorkspaceIdentity(identity);
  const file = resultReconciliationQueueFile(resolved.id, stateDir);
  return withRoutingFileLock(file, "RESULT_RECONCILIATION_BUSY", "R4 reconciliation queue 写锁繁忙；稍后重试。", () => {
    const stored = readReconciliationQueue(resolved, file);
    const current = stored ?? emptyReconciliationQueue(resolved);
    const existing = current.entries.find((item) => item.commandId === parsed.commandId);
    if (existing?.reasonCode === parsed.reasonCode) return existing;
    if (!existing && current.entries.length >= 10_000) {
      throw outboxError("RESULT_RECONCILIATION_QUEUE_FULL", "R4 reconciliation queue 已达到 10000 条上限，拒绝丢弃历史诊断。");
    }
    const issue = resultOutboxReconciliationNeededSchema.parse({ ...parsed, createdAt: new Date().toISOString() });
    writeReconciliationQueue(file, {
      ...current,
      revision: bumpedRevision(current),
      entries: existing
        ? current.entries.map((item) => item.commandId === parsed.commandId ? issue : item)
        : [...current.entries, issue],
    });
    return issue;
  });
}

export function clearResultReconciliationNeeded(
  identity: RoutingWorkspaceIdentity,
  commandId: string,
  stateDir = getStateDir(),
): boolean {
  const parsedCommandId = routingCommandIdSchema.parse(commandId);
  const resolved = resolveWorkspaceIdentity(identity);
  const file = resultReconciliationQueueFile(resolved.id, stateDir);
  return withRoutingFileLock(file, "RESULT_RECONCILIATION_BUSY", "R4 reconciliation queue 写锁繁忙；稍后重试。", () => {
    const stored = readReconciliationQueue(resolved, file);
    if (!stored) return false;
    if (!stored.entries.some((item) => item.commandId === parsedCommandId)) return false;
    writeReconciliationQueue(file, {
      ...stored,
      revision: bumpedRevision(stored),
      entries: stored.entries.filter((item) => item.commandId !== parsedCommandId),
    });
    return true;
  });
}
