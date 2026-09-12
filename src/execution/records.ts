import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";

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
  outputId: z.number().int().positive().optional(),
  outputAvailable: z.boolean().optional(),
  controlSessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  commandId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
});

export type ExecutionRecord = z.infer<typeof executionRecordSchema>;
// Desktop receipt 的防重放摘要只存在本机 JSONL；不加入公开 execution_summary schema。
const storedExecutionRecordSchema = executionRecordSchema.extend({
  desktopReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type StoredExecutionRecord = z.infer<typeof storedExecutionRecordSchema>;

export class ExecutionRecordsBusyError extends Error {
  readonly code = "EXECUTION_RECORDS_BUSY";
  constructor() { super("执行记录写锁繁忙；稍后重试。遗留锁须核对后人工恢复，不要删除历史。"); }
}

const waitCell = new Int32Array(new SharedArrayBuffer(4));

function recordsFile(workspaceId: string): string {
  const dir = ensureDir(path.join(getStateDir(), "executions"));
  return path.join(dir, `${workspaceId}.jsonl`);
}

/** 对 execution JSONL 的短跨进程锁；Desktop 结果需要在此锁内查重并追加。 */
export function withExecutionRecordsLock<T>(workspaceId: string, action: () => T): T {
  const file = `${recordsFile(workspaceId)}.lock`;
  const deadline = Date.now() + 500;
  let lock: number;
  for (;;) {
    try {
      lock = fs.openSync(file, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new ExecutionRecordsBusyError();
      Atomics.wait(waitCell, 0, 0, 10);
    }
  }
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    fs.fsyncSync(lock);
    return action();
  } finally {
    try { fs.closeSync(lock); }
    finally { fs.unlinkSync(file); }
  }
}

/** 仅供已持有 withExecutionRecordsLock 的事务追加；普通调用请用 appendExecutionRecord。 */
export function appendExecutionRecordLocked(workspaceId: string, record: StoredExecutionRecord): void {
  const file = recordsFile(workspaceId);
  const serialized = JSON.stringify(storedExecutionRecordSchema.parse(record)) + "\n";
  const fd = fs.openSync(file, "a", 0o600);
  try {
    fs.writeFileSync(fd, serialized, "utf8");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

export function appendExecutionRecord(workspaceId: string, record: ExecutionRecord): void {
  const parsed = executionRecordSchema.parse(record);
  withExecutionRecordsLock(workspaceId, () => appendExecutionRecordLocked(workspaceId, parsed));
}

/**
 * 在已持有 execution 锁时严格读取全部 JSONL。任何空文件、缺少尾换行、坏 JSON
 * 或 schema 不合法都停止调用方，避免把部分落盘当作可继续追加的历史。
 */
export function readExecutionRecordsStrict(workspaceId: string): StoredExecutionRecord[] {
  const file = recordsFile(workspaceId);
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
