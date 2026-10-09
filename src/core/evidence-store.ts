/**
 * 行政证据 store 的共享 readState→corrupt→writeState 模板。
 * 仅依赖 node 内置模块；各 store 的错误类/错误码/文案与容错差异通过参数注入，
 * 业务校验（锁、schema superRefine、资格判断）留在各 store 模块。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** 与 zod schema 结构兼容的最小 codec 面；避免共享原语依赖 zod。 */
export interface EvidenceStateCodec<S> {
  parse(value: unknown): S;
  safeParse(value: unknown): { success: true; data: S } | { success: false };
}

export interface EvidenceReadMessages {
  /** 证据目录 readdir 失败（非 ENOENT） */
  directoryUnreadable: string;
  /** 存在 `${file}.*.tmp` 未完成临时残片 */
  temporaryFiles: string;
  /** 主文件缺失但初始化标记存在 */
  missingMainFile: string;
  /** 主文件存在但初始化标记缺失 */
  missingMarker: string;
  /** 主文件 JSON 解析失败 */
  bodyCorrupt: string;
  /** schema 校验失败或 workspaceId 不一致 */
  schemaMismatch: string;
}

export interface EvidenceReadParams<S extends { workspaceId: string }> {
  file: string;
  marker: string;
  workspaceId: string;
  schema: EvidenceStateCodec<S>;
  emptyState: () => S;
  /** 各店 corrupt 码族构造器（含 readSnapshot 外部分码保留在各店） */
  corrupt: (message: string) => never;
  messages: EvidenceReadMessages;
}

export interface EvidenceWriteParams<S> {
  file: string;
  marker: string;
  schema: EvidenceStateCodec<S>;
  /** schema.parse 放进 prepare try 内，ZodError 会被 onWriteError 映射；否则原样外溢 */
  wrapParseErrors: boolean;
  /** prepare 阶段的目录创建；缺省不创建（legacy-reconciliation 旧行为） */
  ensureDir?: (dir: string) => void;
  /** openSync(tmp) 放进 prepare try 内；否则 open 失败原样外溢 */
  openTmpInsideTry: boolean;
  /** prepare 失败时移除 tmp 残片；否则保留残片让后续读取 fail-closed */
  cleanupTmpOnPrepareFailure: boolean;
  /** writeFileSync 与 marker 写入编码；缺省沿用 Node 默认 */
  writeEncoding?: BufferEncoding;
  /** 写失败映射策略（STORE_WRITE / STORE_CORRUPT 等）；缺省错误原样外溢 */
  onWriteError?: (phase: "prepare" | "commit") => never;
}

function hasTemporaryResidue(
  file: string,
  corrupt: (message: string) => never,
  messages: EvidenceReadMessages,
): boolean {
  try {
    return fs.readdirSync(path.dirname(file)).some(name =>
      name.startsWith(`${path.basename(file)}.`) && name.endsWith(".tmp"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return corrupt(messages.directoryUnreadable);
  }
}

export function readEvidenceState<S extends { workspaceId: string }>(params: EvidenceReadParams<S>): S {
  const { file, marker, schema, messages, corrupt, workspaceId } = params;
  if (hasTemporaryResidue(file, corrupt, messages)) return corrupt(messages.temporaryFiles);
  const exists = fs.existsSync(file);
  const initialized = fs.existsSync(marker);
  if (!exists) {
    if (initialized) return corrupt(messages.missingMainFile);
    return params.emptyState();
  }
  if (!initialized) return corrupt(messages.missingMarker);
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return corrupt(messages.bodyCorrupt); }
  const state = schema.safeParse(parsed);
  if (!state.success || state.data.workspaceId !== workspaceId) return corrupt(messages.schemaMismatch);
  return state.data;
}

export function writeEvidenceState<S>(params: EvidenceWriteParams<S>, state: S): void {
  const { file, marker, schema, writeEncoding, onWriteError } = params;
  const validate = (): S => schema.parse(state);
  const preParsed = params.wrapParseErrors ? undefined : validate();
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let prepared = false;
  if (!params.openTmpInsideTry) fd = fs.openSync(temporary, "wx", 0o600);
  try {
    const parsed = preParsed ?? validate();
    params.ensureDir?.(path.dirname(file));
    if (params.openTmpInsideTry) fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd!, JSON.stringify(parsed), writeEncoding);
    fs.fsyncSync(fd!);
    prepared = true;
  } catch (error) {
    if (!onWriteError) throw error;
    return onWriteError("prepare");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (params.cleanupTmpOnPrepareFailure && !prepared) fs.rmSync(temporary, { force: true });
  }
  try {
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
    if (!fs.existsSync(marker)) {
      const markerFd = fs.openSync(marker, "wx", 0o600);
      try {
        fs.writeFileSync(markerFd, "1\n", writeEncoding);
        fs.fsyncSync(markerFd);
      } finally { fs.closeSync(markerFd); }
    }
  } catch (error) {
    if (!onWriteError) throw error;
    return onWriteError("commit");
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
