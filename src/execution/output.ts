import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";
import { redact } from "../logger/index.js";
import { sanitizeExecutionOutput } from "./sanitize.js";

export const MAX_OUTPUT_RECORDS = 40;

export interface ExecutionOutputMeta {
  id: number;
  command: string;
  exitCode: number | null;
  timestamp: string;
  taskId?: string;
  iteration?: number;
  allowed: boolean;
  restrictedReason?: string;
  truncated: boolean;
  sizeBytes: number;
}

interface OutputIndex {
  nextId: number;
  items: ExecutionOutputMeta[];
}

export class OutputStoreBusyError extends Error {
  readonly code = "OUTPUT_STORE_BUSY";
  constructor() { super("输出状态写锁繁忙；稍后重试。遗留锁须核对 PID 后人工恢复，不要删除 index。"); }
}
const waitCell = new Int32Array(new SharedArrayBuffer(4));
/** 同步 API 保持兼容；文件锁跨进程串行化读写，短暂等待后由 Controller 下一轮重试。 */
function withOutputLock<T>(workspaceId: string, action: () => T): T {
  const file = `${indexFile(workspaceId)}.lock`;
  const deadline = Date.now() + 500;
  let fd: number;
  for (;;) {
    try { fd = fs.openSync(file, "wx", 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new OutputStoreBusyError();
      Atomics.wait(waitCell, 0, 0, 10);
    }
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    fs.fsyncSync(fd);
    return action();
  } finally { fs.closeSync(fd); fs.unlinkSync(file); }
}
const indexSchema = z.object({ nextId: z.number().int().positive().safe(), items: z.array(z.object({
  id: z.number().int().positive().safe(), command: z.string(), exitCode: z.number().nullable(), timestamp: z.string(),
  taskId: z.string().optional(), iteration: z.number().optional(), allowed: z.boolean(), restrictedReason: z.string().optional(),
  truncated: z.boolean(), sizeBytes: z.number().int().nonnegative(),
})).max(MAX_OUTPUT_RECORDS) });

function outputDir(workspaceId: string): string {
  return ensureDir(path.join(getStateDir(), "execution-outputs", workspaceId));
}

function indexFile(workspaceId: string): string {
  return path.join(outputDir(workspaceId), "index.json");
}

function bodyFile(workspaceId: string, id: number): string {
  return path.join(outputDir(workspaceId), "bodies", `${id}.txt`);
}

function readIndex(workspaceId: string): OutputIndex {
  const directory = path.join(getStateDir(), "execution-outputs", workspaceId);
  const file = path.join(directory, "index.json");
  let raw: string;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("输出 index 无法读取，已停止操作；请保留状态并人工恢复。");
    const bodies = path.join(directory, "bodies");
    if (fs.existsSync(`${file}.initialized`) || (fs.existsSync(bodies) && fs.readdirSync(bodies).length)) {
      throw new Error("已初始化的输出 index 缺失，拒绝重置 ID。");
    }
    return { nextId: 1, items: [] };
  }
  try {
    const index = indexSchema.parse(JSON.parse(raw));
    let previous = 0;
    for (const item of index.items) {
      if (item.id <= previous || item.id >= index.nextId) throw new Error("invalid IDs");
      previous = item.id;
    }
    return index;
  } catch { throw new Error("输出 index 损坏，拒绝重置 ID；请保留状态并人工恢复。"); }
}

/** 只读发现使用同一严格 index 校验，不创建目录或写锁。 */
export function readExecutionOutputMetadataStrict(workspaceId: string): ExecutionOutputMeta[] {
  return readIndex(workspaceId).items;
}

function writeIndex(workspaceId: string, index: OutputIndex): void {
  const file = indexFile(workspaceId), temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(index)); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}

export interface SaveOutputInput {
  command: string;
  raw: string;
  exitCode?: number | null;
  taskId?: string;
  iteration?: number;
}

export function saveExecutionOutput(workspaceId: string, input: SaveOutputInput): ExecutionOutputMeta {
  return withOutputLock(workspaceId, () => saveLocked(workspaceId, input));
}
function saveLocked(
  workspaceId: string,
  input: SaveOutputInput,
  sanitized = sanitizeExecutionOutput(input.raw),
): ExecutionOutputMeta {
  const index = readIndex(workspaceId);
  // 即使所有历史输出为空/受限，也能区分首次写入与意外丢失的 index。
  const initialized = `${indexFile(workspaceId)}.initialized`;
  if (!fs.existsSync(initialized)) {
    const fd = fs.openSync(initialized, "wx", 0o600);
    try { fs.writeFileSync(fd, "1\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  // 未提交 index 的崩溃可能留下 orphan body；不复用或覆盖它的 ID。
  let id = index.nextId;
  while (fs.existsSync(bodyFile(workspaceId, id))) id++;
  if (!Number.isSafeInteger(id + 1)) throw new Error("输出 ID 容量已满。");
  const timestamp = new Date().toISOString();
  const allowed = sanitized.allowed;
  const text = allowed ? sanitized.text : "";
  const truncated = allowed ? sanitized.truncated : false;
  const meta: ExecutionOutputMeta = {
    id,
    command: redact(input.command).slice(0, 200),
    exitCode: input.exitCode ?? null,
    timestamp,
    taskId: input.taskId,
    iteration: input.iteration,
    allowed,
    restrictedReason: allowed ? undefined : sanitized.reason,
    truncated,
    sizeBytes: Buffer.byteLength(text, "utf8"),
  };
  if (allowed && text) {
    const file = bodyFile(workspaceId, id);
    ensureDir(path.dirname(file));
    const fd = fs.openSync(file, "wx", 0o600);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  }
  index.nextId = id + 1;
  index.items.push(meta);
  const dropped = index.items.splice(0, Math.max(0, index.items.length - MAX_OUTPUT_RECORDS));
  writeIndex(workspaceId, index);
  // 先提交新 index，再回收不再引用的正文；清理失败仅留下 orphan，不能撤销已提交写入。
  for (const item of dropped) {
    try { fs.rmSync(bodyFile(workspaceId, item.id), { force: true }); } catch { /* 保留 orphan */ }
  }
  return meta;
}

/** Deferred finalization retains only a sanitizer decision, never rejected output. */
export function saveRestrictedExecutionOutput(
  workspaceId: string,
  input: Omit<SaveOutputInput, "raw"> & { reason: string },
): ExecutionOutputMeta {
  const reason = input.reason.trim().slice(0, 128) || "restricted";
  return withOutputLock(workspaceId, () => saveLocked(workspaceId, {
    command: input.command,
    exitCode: input.exitCode,
    taskId: input.taskId,
    iteration: input.iteration,
    raw: "",
  }, { allowed: false, reason }));
}

export function listExecutionOutputs(workspaceId: string, limit = 20): ExecutionOutputMeta[] {
  return withOutputLock(workspaceId, () => {
    const items = readIndex(workspaceId).items;
    return items.slice(-Math.max(1, Math.min(50, limit)));
  });
}

export function readExecutionOutput(
  workspaceId: string,
  id: number
):
  | { ok: true; meta: ExecutionOutputMeta; text: string }
  | { ok: false; error: "NOT_FOUND" | "OUTPUT_RESTRICTED" } {
  return withOutputLock(workspaceId, () => {
    const meta = readIndex(workspaceId).items.find((item) => item.id === id);
    if (!meta) return { ok: false, error: "NOT_FOUND" };
    if (!meta.allowed) return { ok: false, error: "OUTPUT_RESTRICTED" };
    const file = bodyFile(workspaceId, id);
    let text: string;
    try { text = meta.sizeBytes === 0 ? "" : fs.readFileSync(file, "utf8"); }
    catch { throw new Error("输出正文无法读取，停止返回结果；请保留 index 并人工核对。"); }
    if (Buffer.byteLength(text, "utf8") !== meta.sizeBytes) throw new Error("输出正文与 index 不一致，停止读取。");
    return { ok: true, meta, text };
  });
}
