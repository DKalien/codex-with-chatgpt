import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";
import { assertCleanupArtifacts, cleanupArtifact, cleanupArtifactSchema, CommandCleanupError, type CleanupArtifact, type CommandCleanupTarget } from "../command-cleanup/schema.js";
import { assertCleanupStoreFile, readCleanupJournal, withCommandOperation } from "../command-cleanup/fence.js";
import { redact } from "../logger/index.js";
import { sanitizeExecutionOutput } from "./sanitize.js";
import { isExecutionLockAcquisitionContention } from "./short-lock.js";
import { assertNoLegacyHistoryCleanup } from "../command-cleanup/legacy-history-fence.js";

export const MAX_OUTPUT_RECORDS = 40;

export interface ExecutionOutputMeta {
  id: number;
  command: string;
  exitCode: number | null;
  timestamp: string;
  taskId?: string;
  iteration?: number;
  commandId?: string;
  allowed: boolean;
  restrictedReason?: string;
  truncated: boolean;
  sizeBytes: number;
}

export interface OutputIndex {
  nextId: number;
  /** Highest actually evicted unowned ID; optional for legacy indexes, preserved by cleanup. */
  retentionThrough?: number;
  items: ExecutionOutputMeta[];
}

export class OutputStoreBusyError extends Error {
  readonly code = "OUTPUT_STORE_BUSY";
  constructor() { super("输出状态写锁繁忙；稍后重试。遗留锁须核对 PID 后人工恢复，不要删除 index。"); }
}
const waitCell = new Int32Array(new SharedArrayBuffer(4));
/** 同步 API 保持兼容；文件锁跨进程串行化读写，短暂等待后由 Controller 下一轮重试。 */
export function withOutputLock<T>(workspaceId: string, action: () => T, stateDir = getStateDir()): T {
  assertNoLegacyHistoryCleanup(workspaceId, stateDir);
  const file = `${indexFile(workspaceId, stateDir)}.lock`;
  const deadline = Date.now() + 500;
  let fd: number;
  for (;;) {
    try { fd = fs.openSync(file, "wx", 0o600); break; }
    catch (error) {
      if (!isExecutionLockAcquisitionContention(error)) throw error;
      if (Date.now() >= deadline) throw new OutputStoreBusyError();
      Atomics.wait(waitCell, 0, 0, 10);
    }
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    fs.fsyncSync(fd);
    assertNoLegacyHistoryCleanup(workspaceId, stateDir);
    return action();
  } finally { fs.closeSync(fd); fs.unlinkSync(file); }
}
const outputMetaSchema = z.object({
  id: z.number().int().positive().safe(), command: z.string(), exitCode: z.number().nullable(), timestamp: z.string(),
  taskId: z.string().optional(), iteration: z.number().optional(),
  commandId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  allowed: z.boolean(), restrictedReason: z.string().optional(),
  truncated: z.boolean(), sizeBytes: z.number().int().nonnegative(),
});
const indexSchema = z.object({ nextId: z.number().int().positive().safe(),
  retentionThrough: z.number().int().positive().safe().optional(), items: z.array(outputMetaSchema).max(MAX_OUTPUT_RECORDS) });
const cleanupIndexSchema = z.object({
  nextId: z.number().int().positive().safe(),
  retentionThrough: z.number().int().positive().safe().optional(),
  items: z.array(outputMetaSchema.strict()).max(MAX_OUTPUT_RECORDS),
}).strict();

function outputDir(workspaceId: string, stateDir = getStateDir()): string {
  return ensureDir(path.join(stateDir, "execution-outputs", workspaceId));
}

function indexFile(workspaceId: string, stateDir = getStateDir()): string {
  return path.join(outputDir(workspaceId, stateDir), "index.json");
}

function bodyFile(workspaceId: string, id: number, stateDir = getStateDir()): string {
  return path.join(outputDir(workspaceId, stateDir), "bodies", `${id}.txt`);
}

function readIndex(workspaceId: string, stateDir = getStateDir(), cleanupStrict = false): OutputIndex {
  const directory = path.join(stateDir, "execution-outputs", workspaceId);
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
    const index = (cleanupStrict ? cleanupIndexSchema : indexSchema).parse(JSON.parse(raw));
    if (index.retentionThrough !== undefined && (index.retentionThrough >= index.nextId ||
      index.items.some(item => item.commandId === undefined && item.id <= index.retentionThrough!))) throw new Error("invalid retention horizon");
    let previous = 0;
    for (const item of index.items) {
      if (item.id <= previous || item.id >= index.nextId) throw new Error("invalid IDs");
      previous = item.id;
    }
    return index;
  } catch { throw new Error("输出 index 损坏，拒绝重置 ID；请保留状态并人工恢复。"); }
}

/** Strict allocation horizon + metadata from one read; never creates state or a lock. */
export function readExecutionOutputIndexStrict(workspaceId: string, stateDir = getStateDir()): OutputIndex {
  const file = path.join(stateDir, "execution-outputs", workspaceId, "index.json");
  const check = (): fs.Stats | null => {
    assertOutputCleanupPaths(workspaceId, stateDir);
    if (assertExecutionArtifactPath(`${file}.lock`, stateDir, "file")) throw new OutputStoreBusyError();
    return assertExecutionArtifactPath(file, stateDir, "file");
  };
  const before = check();
  const index = readIndex(workspaceId, stateDir, true);
  const after = check();
  if (!!before !== !!after || (before && after &&
    (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs))) {
    throw new Error("输出 index 在严格读取期间被替换或修改；拒绝复用快照。");
  }
  return index;
}

/** Coordinator already owns withOutputLock; retains strict schema/path validation. */
export function readExecutionOutputIndexLocked(workspaceId: string, stateDir = getStateDir()): OutputIndex {
  assertOutputCleanupPaths(workspaceId, stateDir);
  return readIndex(workspaceId, stateDir, true);
}

/** 只读发现使用同一严格 index 校验，不创建目录或写锁。 */
export function readExecutionOutputMetadataStrict(workspaceId: string, stateDir = getStateDir()): ExecutionOutputMeta[] {
  return readExecutionOutputIndexStrict(workspaceId, stateDir).items;
}

function writeIndex(workspaceId: string, index: OutputIndex, stateDir = getStateDir()): void {
  const file = indexFile(workspaceId, stateDir), temporary = `${file}.${randomUUID()}.tmp`;
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
  commandId?: string;
}

export function saveExecutionOutput(workspaceId: string, input: SaveOutputInput, stateDir = getStateDir()): ExecutionOutputMeta {
  const write = () => withOutputLock(workspaceId, () => saveLocked(workspaceId, input, undefined, stateDir), stateDir);
  return input.commandId && input.iteration === 1
    ? withCommandOperation(workspaceId, input.commandId, write, stateDir)
    : write();
}
function saveLocked(
  workspaceId: string,
  input: SaveOutputInput,
  sanitized = sanitizeExecutionOutput(input.raw),
  stateDir = getStateDir(),
): ExecutionOutputMeta {
  const index = readIndex(workspaceId, stateDir);
  const dropped: ExecutionOutputMeta[] = [];
  if (index.items.length === MAX_OUTPUT_RECORDS) {
    const unowned = index.items.findIndex(item => item.commandId === undefined);
    if (unowned < 0) {
      throw new Error("输出状态已满；所有输出仍由 command 所有，请先完成对应 cleanup 后重试。");
    }
    dropped.push(index.items.splice(unowned, 1)[0]!);
    index.retentionThrough = Math.max(index.retentionThrough ?? 0, dropped[0]!.id);
  }
  // 即使所有历史输出为空/受限，也能区分首次写入与意外丢失的 index。
  const initialized = `${indexFile(workspaceId, stateDir)}.initialized`;
  if (!fs.existsSync(initialized)) {
    const fd = fs.openSync(initialized, "wx", 0o600);
    try { fs.writeFileSync(fd, "1\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  // 未提交 index 的崩溃可能留下 orphan body；不复用或覆盖它的 ID。
  let id = index.nextId;
  while (fs.existsSync(bodyFile(workspaceId, id, stateDir))) id++;
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
    commandId: input.commandId,
    allowed,
    restrictedReason: allowed ? undefined : sanitized.reason,
    truncated,
    sizeBytes: Buffer.byteLength(text, "utf8"),
  };
  if (allowed && text) {
    const file = bodyFile(workspaceId, id, stateDir);
    ensureDir(path.dirname(file));
    const fd = fs.openSync(file, "wx", 0o600);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  }
  index.nextId = id + 1;
  index.items.push(meta);
  writeIndex(workspaceId, index, stateDir);
  // 先提交新 index，再回收不再引用的正文；清理失败仅留下 orphan，不能撤销已提交写入。
  for (const item of dropped) {
    try { fs.rmSync(bodyFile(workspaceId, item.id, stateDir), { force: true }); } catch { /* 保留 orphan */ }
  }
  return meta;
}

/** Deferred finalization retains only a sanitizer decision, never rejected output. */
export function saveRestrictedExecutionOutput(
  workspaceId: string,
  input: Omit<SaveOutputInput, "raw"> & { reason: string },
  stateDir = getStateDir(),
): ExecutionOutputMeta {
  const reason = input.reason.trim().slice(0, 128) || "restricted";
  const write = () => withOutputLock(workspaceId, () => saveLocked(workspaceId, {
    command: input.command,
    exitCode: input.exitCode,
    taskId: input.taskId,
    iteration: input.iteration,
    commandId: input.commandId,
    raw: "",
  }, { allowed: false, reason }, stateDir), stateDir);
  return input.commandId && input.iteration === 1
    ? withCommandOperation(workspaceId, input.commandId, write, stateDir)
    : write();
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

function validateCleanupTarget(target: CommandCleanupTarget): string {
  if (!/^[a-f0-9]{12}$/.test(target.workspaceId) || !/^[A-Za-z0-9_-]{1,128}$/.test(target.commandId) || target.iteration !== 1) {
    throw new CommandCleanupError("COMMAND_CLEANUP_INVALID", "execution output cleanup identity 非法。");
  }
  return path.resolve(target.stateDir ?? getStateDir());
}

export function assertExecutionArtifactPath(file: string, stateDir: string, final: "file" | "directory"): fs.Stats | null {
  const root = path.resolve(stateDir);
  const resolved = path.resolve(file);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "execution output path 越界。");
  }
  let current = root;
  const parts = relative.split(path.sep);
  let result: fs.Stats | null = null;
  for (let index = -1; index < parts.length; index += 1) {
    if (index >= 0) current = path.join(current, parts[index]!);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "execution output path 无法核验。");
    }
    if (stat.isSymbolicLink()) throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "execution output path 含 symlink/reparse point。");
    const isFinal = index === parts.length - 1;
    if (!isFinal && !stat.isDirectory()) throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "execution output path 父级不是普通目录。");
    if (isFinal && !(final === "file" ? stat.isFile() : stat.isDirectory())) {
      throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "execution output artifact 不是普通文件或目录。");
    }
    if (isFinal) result = stat;
  }
  return result;
}

function outputArtifact(meta: ExecutionOutputMeta): CleanupArtifact {
  return cleanupArtifact("execution_output", String(meta.id), meta);
}

function expectedOutputArtifacts(expected: readonly CleanupArtifact[]): Map<number, CleanupArtifact> {
  const result = new Map<number, CleanupArtifact>();
  for (const artifact of expected) {
    if (artifact.kind !== "execution_output") continue;
    const id = Number(artifact.id);
    if (!Number.isSafeInteger(id) || id <= 0 || String(id) !== artifact.id) {
      throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "cleanup output id 非法。");
    }
    if (result.has(id)) throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "cleanup output id 重复。");
    result.set(id, cleanupArtifactSchema.parse(artifact));
  }
  return result;
}

function requireOutputCleanupJournal(target: CommandCleanupTarget, expected: readonly CleanupArtifact[], stateDir: string): void {
  const journal = readCleanupJournal(target.workspaceId, target.commandId, stateDir);
  if (!journal || journal.phase === "snapshot_pending" || journal.workspaceRoot !== target.workspaceRoot || journal.iteration !== 1) {
    throw new CommandCleanupError("COMMAND_CLEANUP_REQUIRED", "缺少匹配的 cleanup_pending journal；拒绝删除 output。");
  }
  const sort = (items: readonly CleanupArtifact[]) => [...items].sort((a, b) => `${a.kind}\0${a.id}`.localeCompare(`${b.kind}\0${b.id}`));
  if (JSON.stringify(sort(expected)) !== JSON.stringify(sort(journal.artifacts))) {
    throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "cleanup expected artifacts 与 journal 不一致。");
  }
}

function assertOutputCleanupPaths(workspaceId: string, stateDir: string): void {
  assertCleanupStoreFile(path.join(stateDir, "execution-outputs", workspaceId, "index.json"), stateDir);
  const base = path.join(stateDir, "execution-outputs", workspaceId);
  for (const [file, kind] of [
    [path.join(stateDir, "execution-outputs"), "directory"],
    [base, "directory"],
    [path.join(base, "index.json"), "file"],
    [path.join(base, "index.json.initialized"), "file"],
    [path.join(base, "bodies"), "directory"],
  ] as const) assertExecutionArtifactPath(file, stateDir, kind);
}

/** 收集 exact command/iteration 输出及由严格 execution record 指向的 legacy output。 */
export function inspectExecutionOutputCleanupArtifacts(
  target: CommandCleanupTarget,
  linkedOutputIds: readonly number[] = [],
): CleanupArtifact[] {
  const stateDir = validateCleanupTarget(target);
  const linked = new Set(linkedOutputIds);
  if (linked.size !== linkedOutputIds.length || [...linked].some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "execution record outputId 重复或非法。");
  }
  const journal = readCleanupJournal(target.workspaceId, target.commandId, stateDir);
  assertOutputCleanupPaths(target.workspaceId, stateDir);
  const directory = path.join(stateDir, "execution-outputs", target.workspaceId);
  const lock = `${path.join(directory, "index.json")}.lock`;
  if (assertExecutionArtifactPath(lock, stateDir, "file")) {
    throw new CommandCleanupError("COMMAND_CLEANUP_BUSY", "execution output store 正在写入；拒绝取得不完整快照。");
  }
  const index = readIndex(target.workspaceId, stateDir, true);
  const indexExists = !!assertExecutionArtifactPath(path.join(directory, "index.json"), stateDir, "file");
  const expected = expectedOutputArtifacts(journal?.artifacts ?? []);
  if (!indexExists) {
    for (const id of expected.keys()) {
      if (assertExecutionArtifactPath(path.join(directory, "bodies", `${id}.txt`), stateDir, "file")) {
        throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "output index 缺失但 expected body 仍存在。");
      }
    }
    return [];
  }
  const selected = index.items.filter(meta =>
    (meta.commandId === target.commandId && meta.iteration === 1) || linked.has(meta.id) ||
    (meta.commandId === undefined && meta.taskId === `desktop_${target.commandId}` && meta.iteration === 1) || expected.has(meta.id),
  );
  if (selected.some(meta => meta.commandId !== undefined &&
      (meta.commandId !== target.commandId || meta.iteration !== 1))) {
    throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "record outputId 指向其他 commandId output。");
  }
  if (selected.some(meta => meta.commandId === undefined && meta.iteration !== undefined && meta.iteration !== 1)) {
    throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "legacy output iteration 与 cleanup target 不一致。");
  }
  const artifacts = selected.map(outputArtifact);
  if (journal && journal.phase !== "snapshot_pending") assertCleanupArtifacts(artifacts, journal.artifacts);
  for (const meta of selected) {
    const body = path.join(directory, "bodies", `${meta.id}.txt`);
    const stat = assertExecutionArtifactPath(body, stateDir, "file");
    const bodyExpected = meta.allowed && meta.sizeBytes > 0;
    if (!stat && bodyExpected) {
      const expectedMeta = expected.get(meta.id);
      if (!journal || journal.phase === "snapshot_pending" || !expectedMeta || expectedMeta.sha256 !== outputArtifact(meta).sha256) {
        throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "execution output body 缺失且没有 matching cleanup fence。");
      }
    } else if (stat && (!bodyExpected || stat.size !== meta.sizeBytes)) {
      throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "execution output body 与 metadata 不一致。");
    }
  }
  const selectedIds = new Set(selected.map(meta => meta.id));
  for (const id of linked) {
    if (!selectedIds.has(id) && assertExecutionArtifactPath(path.join(directory, "bodies", `${id}.txt`), stateDir, "file")) {
      throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "execution record 指向的 output metadata 缺失但 body 仍存在。");
    }
  }
  return artifacts;
}

/** 删除由 inspect/journal 精确记录的输出。body 先删，index 后提交，缺正文只允许 journal-backed resume。 */
export function deleteExecutionOutputCleanupArtifacts(
  target: CommandCleanupTarget,
  expected: readonly CleanupArtifact[],
): void {
  const stateDir = validateCleanupTarget(target);
  requireOutputCleanupJournal(target, expected, stateDir);
  const wanted = expectedOutputArtifacts(expected);
  if (wanted.size === 0) return;
  assertOutputCleanupPaths(target.workspaceId, stateDir);
  const directory = path.join(stateDir, "execution-outputs", target.workspaceId);
  const indexPath = path.join(directory, "index.json");
  const indexSnapshot = readIndex(target.workspaceId, stateDir, true);
  if (!assertExecutionArtifactPath(indexPath, stateDir, "file")) {
    for (const id of wanted.keys()) {
      if (assertExecutionArtifactPath(path.join(directory, "bodies", `${id}.txt`), stateDir, "file")) {
        throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "index 缺失但 expected body 仍存在。");
      }
    }
    if (indexSnapshot.items.length) throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "输出 index 缺失但严格快照非空。");
    return;
  }
  withCommandOperation(target.workspaceId, target.commandId, () => withOutputLock(target.workspaceId, () => {
    requireOutputCleanupJournal(target, expected, stateDir);
    assertOutputCleanupPaths(target.workspaceId, stateDir);
    const indexStat = assertExecutionArtifactPath(indexPath, stateDir, "file");
    if (!indexStat) {
      for (const id of wanted.keys()) {
        if (assertExecutionArtifactPath(path.join(directory, "bodies", `${id}.txt`), stateDir, "file")) {
          throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "index 缺失但 expected body 仍存在。");
        }
      }
      return;
    }
    const index = readIndex(target.workspaceId, stateDir, true);
    const selected = index.items.filter(meta => wanted.has(meta.id));
    assertCleanupArtifacts(selected.map(outputArtifact), expected);
    const byId = new Map(index.items.map(meta => [meta.id, meta]));
    for (const [id, artifact] of wanted) {
      const meta = byId.get(id);
      if (!meta) {
        if (assertExecutionArtifactPath(path.join(directory, "bodies", `${id}.txt`), stateDir, "file")) {
          throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "expected output metadata 已消失但 body 仍存在。");
        }
        continue;
      }
      if (outputArtifact(meta).sha256 !== artifact.sha256) {
        throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "execution output metadata 已变化。");
      }
      const body = path.join(directory, "bodies", `${id}.txt`);
      const stat = assertExecutionArtifactPath(body, stateDir, "file");
      if (meta.allowed && meta.sizeBytes > 0) {
        if (stat && stat.size !== meta.sizeBytes) throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "execution output body 与 metadata 不一致。");
        if (stat) fs.unlinkSync(body);
      } else if (stat) {
        throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "无正文 metadata 却存在 output body。");
      }
    }
    index.items = index.items.filter(meta => !wanted.has(meta.id));
    writeIndex(target.workspaceId, index, stateDir);
    const remaining = readIndex(target.workspaceId, stateDir, true).items.filter(meta => wanted.has(meta.id));
    if (remaining.length) throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "execution output metadata 物理删除未完成。");
  }, stateDir), stateDir, true);
}
