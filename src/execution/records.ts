import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";
import { assertCleanupArtifacts, cleanupArtifact, CommandCleanupError, type CleanupArtifact, type CommandCleanupTarget } from "../command-cleanup/schema.js";
import { assertCleanupStoreFile, assertCommandWritable, readCleanupJournal, withCommandOperation } from "../command-cleanup/fence.js";
import { assertExecutionArtifactPath, deleteExecutionOutputCleanupArtifacts, inspectExecutionOutputCleanupArtifacts } from "./output.js";
import { sanitizeExecutionOutput } from "./sanitize.js";
import { isExecutionLockAcquisitionContention } from "./short-lock.js";
import { applyFeedbackCursorCleanup, prepareFeedbackCursorCleanup } from "../feedback/cursor-cleanup.js";
import { assertNoLegacyHistoryCleanup } from "../command-cleanup/legacy-history-fence.js";
import { HEX64 } from "../core/hex.js";

export const MAX_EXECUTION_SUMMARY_BYTES = 8 * 1024;
export const executionSummarySchema = z.string().min(1).refine(
  value => value.trim().length > 0,
  "rawSummary 不能为空。",
).refine(
  value => Buffer.byteLength(value, "utf8") <= MAX_EXECUTION_SUMMARY_BYTES,
  "rawSummary 不能为空且 UTF-8 编码不得超过 8192 bytes。",
);

export function sanitizeExecutionSummary(value: string): string {
  const summary = executionSummarySchema.parse(value);
  const sanitized = sanitizeExecutionOutput(summary);
  if (!sanitized.allowed || sanitized.truncated || Buffer.byteLength(sanitized.text, "utf8") > MAX_EXECUTION_SUMMARY_BYTES) {
    throw new Error("rawSummary 包含不允许的内容或超过 8192 bytes；请提交简短摘要，不要包含 transcript 或私钥。");
  }
  return executionSummarySchema.parse(sanitized.text);
}

/**
 * Lightweight execution records written by the Codex harness after each
 * iteration (via `c2c record`). ChatGPT reads them through the
 * `execution_summary` and `test_status` MCP tools.
 */
export const executionRecordSchema = z.object({
  taskId: z.string(),
  iteration: z.number().int().nonnegative(),
  changedFiles: z.union([z.array(z.string()), z.number().int().nonnegative()]),
  tests: z.string().nullable(),
  exitStatus: z.string(),
  timestamp: z.string(),
  notes: z.string().optional(),
  rawSummary: executionSummarySchema.optional(),
  outputId: z.number().int().positive().optional(),
  outputAvailable: z.boolean().optional(),
  controlSessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  commandId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
});

export type ExecutionRecord = z.infer<typeof executionRecordSchema>;
// Desktop receipt 的防重放摘要只存在本机 JSONL；不加入公开 execution_summary schema。
const storedExecutionRecordSchema = executionRecordSchema.extend({
  desktopReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  desktopThreadId: z.string().uuid().optional(),
  desktopOriginTurnId: z.string().uuid().optional(),
  desktopResultTurnId: z.string().uuid().optional(),
  desktopBindingId: z.string().uuid().optional(),
}).strict();
export type StoredExecutionRecord = z.infer<typeof storedExecutionRecordSchema>;

export const TERMINAL_EXECUTION_STATUSES = ["ok", "failed", "blocked"] as const;

export interface TerminalExecutionIdentity {
  controlSessionId: string;
  commandId: string;
  taskId: string;
  iteration: number;
}

/**
 * status 轮询用的分类结果：missing/not_terminal 是正常 no-op，
 * corrupt、重复、partial identity 一律 throw fail closed，不靠错误文案分支。
 */
export type TerminalExecutionLookup =
  | { status: "terminal"; record: StoredExecutionRecord }
  | { status: "not_terminal" }
  | { status: "missing" };

export function tryResolveTerminalExecutionRecord(
  workspaceId: string,
  expected: TerminalExecutionIdentity,
): TerminalExecutionLookup {
  const records = readExecutionRecordsStrict(workspaceId);
  const byCommand = records.filter((record) => record.commandId === expected.commandId);
  const byTaskIteration = records.filter((record) =>
    record.taskId === expected.taskId && record.iteration === expected.iteration);
  if (byCommand.length > 1 || byTaskIteration.length > 1) {
    throw new Error("执行终态记录重复或冲突；拒绝猜测或重复回流。");
  }
  const candidates = [...new Set([...byCommand, ...byTaskIteration])];
  if (candidates.length === 0) return { status: "missing" };
  if (candidates.length !== 1) {
    throw new Error("执行终态记录重复或冲突；拒绝猜测或重复回流。");
  }
  const record = candidates[0];
  if (record.commandId !== expected.commandId || record.controlSessionId !== expected.controlSessionId ||
      record.taskId !== expected.taskId || record.iteration !== expected.iteration) {
    throw new Error("执行终态记录的 workspace/session/command/task/iteration 身份不匹配；拒绝回流。");
  }
  if (!(TERMINAL_EXECUTION_STATUSES as readonly string[]).includes(record.exitStatus)) {
    return { status: "not_terminal" };
  }
  return { status: "terminal", record };
}

/**
 * 严格解析指定 command 的唯一终态。commandId 与 taskId/iteration 都是身份键；
 * 任一键重复、冲突、缺失或历史 JSONL 损坏都拒绝猜测，供 Web Control 恢复复用。
 */
export function resolveTerminalExecutionRecord(
  workspaceId: string,
  expected: TerminalExecutionIdentity,
): StoredExecutionRecord {
  const lookup = tryResolveTerminalExecutionRecord(workspaceId, expected);
  if (lookup.status === "terminal") return lookup.record;
  if (lookup.status === "not_terminal") {
    throw new Error("执行记录尚未进入 ok/failed/blocked 终态；accepted 或其他状态不能视为完成。");
  }
  throw new Error("缺少唯一匹配的执行终态记录；不能把其他任务或历史 test_status 当作本次完成。");
}

/**
 * trusted Desktop receipt 的 8 项信任谓词（与原手工判定逐条等价的唯一权威表达）：
 * 1. commandId 等于调用方期望的运行时 commandId；
 * 2. taskId 固定为 `desktop_<commandId>`；
 * 3. iteration 恰为 1；
 * 4. changedFiles 为字符串数组（窄于 base schema 的 union）；
 * 5. tests 为非空白字符串（base 允许 nullable）；
 * 6. exitStatus 为 ok/failed/blocked 三种终态之一；
 * 7. timestamp 可解析且规范 ISO 往返相等（new Date(ms).toISOString() === 原值）；
 * 8. desktopReceiptSha256 为 64 位小写 hex。
 * 独立声明并 passthrough：本 gate 只判定这 8 项，不重复 storedExecutionRecordSchema
 * 读取路径的 strict 形状校验，也不因多余键拒绝（与旧手工谓词语义一致）。
 */
export function trustedDesktopReceiptSchema(commandId: string) {
  return z.object({
    commandId: z.literal(commandId),
    taskId: z.literal(`desktop_${commandId}`),
    iteration: z.literal(1),
    changedFiles: z.array(z.string()),
    tests: z.string().refine(value => value.trim().length > 0),
    exitStatus: z.enum(TERMINAL_EXECUTION_STATUSES),
    timestamp: z.string().refine((value) => {
      const ms = Date.parse(value);
      return Number.isFinite(ms) && new Date(ms).toISOString() === value;
    }),
    desktopReceiptSha256: z.string().regex(HEX64),
  }).passthrough();
}

/** 本机 Desktop receipt 的严格终态条件；调用方必须先拒绝重复或冲突记录。 */
export function isTrustedDesktopReceipt(record: StoredExecutionRecord, commandId: string): boolean {
  return trustedDesktopReceiptSchema(commandId).safeParse(record).success;
}

export class ExecutionRecordsBusyError extends Error {
  readonly code = "EXECUTION_RECORDS_BUSY";
  constructor() { super("执行记录写锁繁忙；稍后重试。遗留锁须核对后人工恢复，不要删除历史。"); }
}

const waitCell = new Int32Array(new SharedArrayBuffer(4));

function recordsFile(workspaceId: string, stateDir = getStateDir()): string {
  const dir = ensureDir(path.join(stateDir, "executions"));
  return path.join(dir, `${workspaceId}.jsonl`);
}

/** 对 execution JSONL 的短跨进程锁；Desktop 结果需要在此锁内查重并追加。 */
export function withExecutionRecordsLock<T>(workspaceId: string, action: () => T, stateDir = getStateDir()): T {
  assertNoLegacyHistoryCleanup(workspaceId, stateDir);
  const file = `${recordsFile(workspaceId, stateDir)}.lock`;
  const deadline = Date.now() + 500;
  let lock: number;
  for (;;) {
    try {
      lock = fs.openSync(file, "wx", 0o600);
      break;
    } catch (error) {
      if (!isExecutionLockAcquisitionContention(error)) throw error;
      if (Date.now() >= deadline) throw new ExecutionRecordsBusyError();
      Atomics.wait(waitCell, 0, 0, 10);
    }
  }
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    fs.fsyncSync(lock);
    assertNoLegacyHistoryCleanup(workspaceId, stateDir);
    return action();
  } finally {
    try { fs.closeSync(lock); }
    finally { fs.unlinkSync(file); }
  }
}

/** 对需要在 execution 锁内再次读取 Desktop 状态的结果写入提供 async 事务。 */
export async function withExecutionRecordsLockAsync<T>(workspaceId: string, action: () => Promise<T>, stateDir = getStateDir()): Promise<T> {
  assertNoLegacyHistoryCleanup(workspaceId, stateDir);
  const file = `${recordsFile(workspaceId, stateDir)}.lock`;
  const deadline = Date.now() + 500;
  let lock: number;
  for (;;) {
    try {
      lock = fs.openSync(file, "wx", 0o600);
      break;
    } catch (error) {
      if (!isExecutionLockAcquisitionContention(error)) throw error;
      if (Date.now() >= deadline) throw new ExecutionRecordsBusyError();
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
  }
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    fs.fsyncSync(lock);
    assertNoLegacyHistoryCleanup(workspaceId, stateDir);
    return await action();
  } finally {
    try { fs.closeSync(lock); }
    finally { fs.unlinkSync(file); }
  }
}

/** 仅供已持有 withExecutionRecordsLock 的事务追加；普通调用请用 appendExecutionRecord。 */
export function appendExecutionRecordLocked(workspaceId: string, record: StoredExecutionRecord, stateDir = getStateDir()): void {
  assertNoLegacyHistoryCleanup(workspaceId, stateDir);
  const parsed = storedExecutionRecordSchema.parse(record);
  const safe = parsed.rawSummary === undefined
    ? parsed
    : { ...parsed, rawSummary: sanitizeExecutionSummary(parsed.rawSummary) };
  if (safe.commandId && safe.iteration === 1) assertCommandWritable(workspaceId, safe.commandId, stateDir);
  const serialized = JSON.stringify(safe) + "\n";
  const fd = fs.openSync(recordsFile(workspaceId, stateDir), "a", 0o600);
  try {
    fs.writeFileSync(fd, serialized, "utf8");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

export function appendExecutionRecord(workspaceId: string, record: ExecutionRecord, stateDir = getStateDir()): void {
  const parsed = executionRecordSchema.parse(record);
  const append = () => withExecutionRecordsLock(workspaceId, () => appendExecutionRecordLocked(workspaceId, parsed, stateDir), stateDir);
  if (parsed.commandId && parsed.iteration === 1) withCommandOperation(workspaceId, parsed.commandId, append, stateDir);
  else append();
}

/**
 * 在已持有 execution 锁时严格读取全部 JSONL。任何空文件、缺少尾换行、坏 JSON
 * 或 schema 不合法都停止调用方，避免把部分落盘当作可继续追加的历史。
 */
export function readExecutionRecordsStrict(workspaceId: string, stateDir = getStateDir()): StoredExecutionRecord[] {
  const file = path.join(path.resolve(stateDir), "executions", `${workspaceId}.jsonl`);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("执行记录无法读取；请保留原文件并人工核对。");
  }
  if (raw.length === 0 || !raw.endsWith("\n")) {
    throw new Error("执行记录 JSONL 不完整；请保留原文件并人工核对。");
  }
  const lines = raw.slice(0, -1).split("\n");
  const records: StoredExecutionRecord[] = [];
  for (const line of lines) {
    if (!line) throw new Error("执行记录 JSONL 含空行；请保留原文件并人工核对。");
    let parsed: unknown;
    try { parsed = JSON.parse(line); }
    catch { throw new Error("执行记录 JSONL 损坏；请保留原文件并人工核对。"); }
    const record = storedExecutionRecordSchema.safeParse(parsed);
    if (!record.success) throw new Error("执行记录 schema 损坏；请保留原文件并人工核对。");
    records.push(record.data);
  }
  return records;
}

export function readExecutionRecords(workspaceId: string, limit = 10): ExecutionRecord[] {
  const file = recordsFile(workspaceId);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const records: ExecutionRecord[] = [];
  const requestedLimit = Math.max(1, Math.floor(limit));
  for (let index = lines.length - 1; index >= 0 && records.length < requestedLimit; index--) {
    try {
      const record = executionRecordSchema.safeParse(JSON.parse(lines[index]));
      if (record.success) records.push(record.data);
    } catch {
      // skip corrupt lines
    }
  }
  return records.reverse();
}

export function latestExecutionRecord(workspaceId: string): ExecutionRecord | null {
  const records = readExecutionRecords(workspaceId, 1);
  return records[records.length - 1] ?? null;
}

function validateCleanupTarget(target: CommandCleanupTarget): string {
  if (!/^[a-f0-9]{12}$/.test(target.workspaceId) || !/^[A-Za-z0-9_-]{1,128}$/.test(target.commandId) ||
      target.iteration !== 1 || target.workspaceRoot.length === 0) {
    throw new CommandCleanupError("COMMAND_CLEANUP_INVALID", "execution cleanup identity 非法。");
  }
  return path.resolve(target.stateDir ?? getStateDir());
}

function recordArtifact(target: CommandCleanupTarget, record: StoredExecutionRecord): CleanupArtifact {
  return cleanupArtifact("execution_record", `${target.commandId}:1`, record);
}

function requireRecordCleanupJournal(target: CommandCleanupTarget, expected: readonly CleanupArtifact[], stateDir: string): void {
  const journal = readCleanupJournal(target.workspaceId, target.commandId, stateDir);
  if (!journal || journal.phase === "snapshot_pending" || journal.workspaceRoot !== target.workspaceRoot || journal.iteration !== 1) {
    throw new CommandCleanupError("COMMAND_CLEANUP_REQUIRED", "缺少匹配的 cleanup_pending journal；拒绝删除 execution record。");
  }
  const sort = (items: readonly CleanupArtifact[]) => [...items].sort((a, b) => `${a.kind}\0${a.id}`.localeCompare(`${b.kind}\0${b.id}`));
  if (JSON.stringify(sort(expected)) !== JSON.stringify(sort(journal.artifacts))) {
    throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "cleanup expected artifacts 与 journal 不一致。");
  }
}

function recordsPath(workspaceId: string, stateDir: string): string {
  return path.join(stateDir, "executions", `${workspaceId}.jsonl`);
}

function targetRecords(target: CommandCleanupTarget, records: readonly StoredExecutionRecord[]): StoredExecutionRecord[] {
  return records.filter(record => record.commandId === target.commandId && record.iteration === 1);
}

/** 只报告 exact commandId+iteration=1 的记录及其精确关联输出。 */
export function inspectExecutionCleanupArtifacts(target: CommandCleanupTarget): CleanupArtifact[] {
  const stateDir = validateCleanupTarget(target);
  const journal = readCleanupJournal(target.workspaceId, target.commandId, stateDir);
  const file = recordsPath(target.workspaceId, stateDir);
  assertCleanupStoreFile(file, stateDir);
  assertExecutionArtifactPath(path.join(stateDir, "executions"), stateDir, "directory");
  if (assertExecutionArtifactPath(file + ".lock", stateDir, "file")) {
    throw new CommandCleanupError("COMMAND_CLEANUP_BUSY", "execution records 正在写入；拒绝取得不完整快照。");
  }
  const stat = assertExecutionArtifactPath(file, stateDir, "file");
  const selected = stat ? targetRecords(target, readExecutionRecordsStrict(target.workspaceId, stateDir)) : [];
  if (selected.length > 1) throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "execution record commandId+iteration 重复；拒绝猜测。");
  const records = selected.map(record => recordArtifact(target, record));
  const outputs = inspectExecutionOutputCleanupArtifacts(target, selected.flatMap(record => record.outputId === undefined ? [] : [record.outputId]));
  if (journal && journal.phase !== "snapshot_pending") assertCleanupArtifacts([...records, ...outputs], journal.artifacts);
  return [...records, ...outputs];
}

/** 在 cleanup journal 与完整 expected 快照约束下，按 output → JSONL 顺序物理删除。 */
export function deleteExecutionCleanupArtifacts(
  target: CommandCleanupTarget,
  expected: readonly CleanupArtifact[],
  stageHook?: (stage: "cursor_prepared" | "record_deleted" | "cursor_applied") => void,
): void {
  const stateDir = validateCleanupTarget(target);
  requireRecordCleanupJournal(target, expected, stateDir);
  withCommandOperation(target.workspaceId, target.commandId, () => {
    deleteExecutionOutputCleanupArtifacts(target, expected);
    const file = recordsPath(target.workspaceId, stateDir);
    assertCleanupStoreFile(file, stateDir);
    assertExecutionArtifactPath(path.join(stateDir, "executions"), stateDir, "directory");
    const deleteRecord = () => {
      requireRecordCleanupJournal(target, expected, stateDir);
      assertExecutionArtifactPath(path.join(stateDir, "executions"), stateDir, "directory");
      const stat = assertExecutionArtifactPath(file, stateDir, "file");
      const records = stat ? readExecutionRecordsStrict(target.workspaceId, stateDir) : [];
      const selected = targetRecords(target, records);
      if (selected.length > 1) throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "execution record commandId+iteration 重复；拒绝猜测。");
      assertCleanupArtifacts(selected.map(record => recordArtifact(target, record)), expected);
      if (selected.length === 1) {
        const index = records.findIndex(record => record.commandId === target.commandId && record.iteration === target.iteration);
        if (index < 0) throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "execution record target index 已变化。");
        const retained = records.filter((_record, position) => position !== index);
        prepareFeedbackCursorCleanup(target, records, retained, index, expected);
        stageHook?.("cursor_prepared");
        assertExecutionArtifactPath(file, stateDir, "file");
        if (retained.length === 0) {
          fs.unlinkSync(file);
        } else {
          const temporary = `${file}.${randomUUID()}.tmp`;
          const fd = fs.openSync(temporary, "wx", 0o600);
          try {
            fs.writeFileSync(fd, `${retained.map(record => JSON.stringify(record)).join("\n")}\n`, "utf8");
            fs.fsyncSync(fd);
          } finally { fs.closeSync(fd); }
          try { fs.renameSync(temporary, file); }
          finally { fs.rmSync(temporary, { force: true }); }
        }
      }
      stageHook?.("record_deleted");
      const after = readExecutionRecordsStrict(target.workspaceId, stateDir);
      if (targetRecords(target, after).length) throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "execution record 物理删除未完成。");
      applyFeedbackCursorCleanup(target, after, expected);
      stageHook?.("cursor_applied");
    };
    withExecutionRecordsLock(target.workspaceId, deleteRecord, stateDir);
  }, stateDir, true);
}
