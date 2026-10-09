import fs from "node:fs";
import path from "node:path";

/**
 * durable store 事务共享原语（零业务依赖）。
 *
 * 固定模板（安全关键写纪律的唯一实现点）：
 *   mkdir(0o700) → wx 锁 + payload + fsyncSync → 锁内重读 → 语义回调（change/parse/
 *   identity/noWrite/revision，顺序由 sequence 决定）→ initialized marker →
 *   tmp 写(wx 0600) + fsyncSync → beforeRename 钩子 → rename 原子替换 →
 *   失败清 tmp → 锁清理（吞错策略可注入，清理失败不得掩盖主结果/主错误）。
 *
 * 所有域错误码与文案必须由调用方注入并保持逐字不变；本模块不定义业务错误。
 * 各 store 的 noWrite byte-equality、revision 校验/派生语义由回调精确保留。
 */

export interface SimpleLockHandle {
  release(): void;
}

export interface DurableLockProvider {
  /** 获取写锁；失败（含占用）必须抛调用方的 busy 错误。 */
  acquire(lockPath: string): SimpleLockHandle;
}

/** 通用 wx 写锁：payload 格式、open mode、busy 映射、清理策略可注入。 */
export function simpleWxLock(options: {
  payload: () => string | Buffer;
  openMode?: number;
  busyError: (cause: unknown) => Error;
  /**
   * 锁清理策略：
   * - "swallow"：close+unlink 合并吞错（不得掩盖主结果/主错误）；
   * - "swallow-independent"：close 吞错，但 unlink 必定尝试（rmSync force 语义，避免残留锁）；
   * - "propagate"：close/unlink 错误原样外溢。
   */
  cleanup: "swallow" | "swallow-independent" | "propagate";
}): DurableLockProvider {
  return {
    acquire(lockPath: string): SimpleLockHandle {
      let fd: number | null = null;
      try {
        fd = options.openMode === undefined
          ? fs.openSync(lockPath, "wx")
          : fs.openSync(lockPath, "wx", options.openMode);
      } catch (error) {
        throw options.busyError(error);
      }
      try {
        fs.writeFileSync(fd, options.payload());
        fs.fsyncSync(fd);
      } catch (error) {
        try { fs.closeSync(fd); } catch { /* keep primary error */ }
        try { fs.unlinkSync(lockPath); } catch { /* keep primary error */ }
        throw error;
      }
      return {
        release(): void {
          if (options.cleanup === "propagate") {
            if (fd !== null) fs.closeSync(fd);
            fs.unlinkSync(lockPath);
            return;
          }
          if (options.cleanup === "swallow-independent") {
            try { if (fd !== null) fs.closeSync(fd); } catch { /* cleanup failure must not hide the primary result/error */ }
            fs.rmSync(lockPath, { force: true });
            return;
          }
          try {
            if (fd !== null) fs.closeSync(fd);
            fs.unlinkSync(lockPath);
          } catch {
            // lock cleanup failure must not hide the primary result/error
          }
        },
      };
    },
  };
}

export type DurableNoWritePolicy =
  | { mode: "disabled" }
  | {
      /** 幂等无写：previous 必须存在且状态 byte-equality 一致。 */
      mode: "require-previous";
      onMissingPrevious: () => Error;
      onChanged: () => Error;
    }
  | {
      /** absent-state 空操作：previous 为 null 时只接受 state 为 null（不建文件/marker）。 */
      mode: "allow-absent-null";
      onChanged: () => Error;
    };

export interface DurableTransactionConfig<S, R> {
  file: string;
  marker: string;
  markerContent: string;
  markerOpenMode?: number;
  lockPath: string;
  lock: DurableLockProvider;
  tmpName: (file: string) => string;
  serialize: (state: S) => string;
  /** 锁内重读后的 change 前置校验（如 previous.workspaceRoot 比对）。 */
  afterRead?: (previous: S | null) => void;
  /** initialized marker 写入前的路径硬化断言钩子。 */
  beforeMarker?: () => void;
  /** tmp 写入前的路径硬化断言钩子。 */
  beforeTmp?: () => void;
  beforeRename?: () => void;
  noWrite: DurableNoWritePolicy;
  /**
   * 语义管线：
   * - "identity-first"：parse → identity → noWrite(与 parse 归一态比对) → revision 校验（调用方提供 revision）。
   * - "assign-first"：noWrite(与 change 原始返回比对) → store 派生 revision 并 parse → identity。
   */
  sequence: "identity-first" | "assign-first";
  /** identity-first：change 之后的 parse + 写前身份校验。 */
  parseAndCheckIdentity?: (state: unknown) => S;
  /** identity-first：revision 校验（previous+1 / 首次 1）。 */
  verifyRevision?: (validated: S, previous: S | null) => void;
  /** assign-first：noWrite 判定后的 revision 派生 + parse + 写前身份校验。 */
  assignParseAndCheckIdentity?: (state: unknown, previous: S | null) => S;
}

export type DurableChange<S, R> = (previous: S | null) => {
  state: S | null;
  result: R;
  noWrite?: boolean;
};

export function runDurableStoreTransaction<S, R>(
  config: DurableTransactionConfig<S, R>,
  change: DurableChange<S, R>,
  readState: () => S | null,
): { result: R; noWrite: boolean; state: S | null } {
  fs.mkdirSync(path.dirname(config.file), { recursive: true, mode: 0o700 });
  const lock = config.lock.acquire(config.lockPath);
  try {
    const previous = readState();
    config.afterRead?.(previous);
    const next = change(previous);

    // 幂等 noWrite 分支（顺序与比较对象由 sequence 决定，语义与各 store 原实现一致）。
    if (next.noWrite && config.noWrite.mode !== "disabled") {
      if (!previous) {
        if (config.noWrite.mode === "allow-absent-null") {
          if (next.state === null) return { result: next.result, noWrite: true, state: null };
          throw config.noWrite.onChanged();
        }
        // require-previous：identity-first 家族先 parse+身份校验再报缺 previous（保持原顺序）。
        if (config.sequence === "identity-first") config.parseAndCheckIdentity!(next.state);
        throw config.noWrite.onMissingPrevious();
      }
      const baseline = config.sequence === "identity-first"
        ? config.parseAndCheckIdentity!(next.state)
        : next.state;
      if (baseline === null || JSON.stringify(baseline) !== JSON.stringify(previous)) {
        throw config.noWrite.onChanged();
      }
      return { result: next.result, noWrite: true, state: baseline as S };
    }

    let validated: S;
    if (config.sequence === "identity-first") {
      validated = config.parseAndCheckIdentity!(next.state);
      config.verifyRevision!(validated, previous);
    } else {
      validated = config.assignParseAndCheckIdentity!(next.state, previous);
    }

    // initialized marker（先于数据 rename 落盘）。
    config.beforeMarker?.();
    if (!fs.existsSync(config.marker)) {
      const markerFd = config.markerOpenMode === undefined
        ? fs.openSync(config.marker, "wx")
        : fs.openSync(config.marker, "wx", config.markerOpenMode);
      try {
        fs.writeFileSync(markerFd, config.markerContent);
        fs.fsyncSync(markerFd);
      } finally {
        fs.closeSync(markerFd);
      }
    }

    // tmp 写 + fsync + rename（失败清 tmp，保留主错误）。
    config.beforeTmp?.();
    const tmp = config.tmpName(config.file);
    try {
      const fd = fs.openSync(tmp, "wx", 0o600);
      try {
        fs.writeFileSync(fd, config.serialize(validated));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      config.beforeRename?.();
      fs.renameSync(tmp, config.file);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch { /* keep primary error */ }
      throw error;
    }
    return { result: next.result, noWrite: false, state: validated };
  } finally {
    lock.release();
  }
}
