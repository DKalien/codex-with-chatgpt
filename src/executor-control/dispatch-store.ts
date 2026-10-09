import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getStateDir } from "../config/paths.js";
import { type DurableLockProvider, runDurableStoreTransaction } from "../core/durable-store.js";
import {
  EXECUTOR_DISPATCH_MAX_ENTRIES,
  ExecutorDispatchError,
  type ExecutorDispatchEntry,
  parseExecutorDispatchState,
  type ExecutorDispatchState,
} from "./dispatch-schema.js";
import { assertCleanupArtifacts, cleanupArtifact, type CleanupArtifact, type CommandCleanupTarget, CommandCleanupError } from "../command-cleanup/schema.js";
import { readCleanupJournal, withCommandOperation } from "../command-cleanup/fence.js";

function assertWorkspaceId(workspaceId: string): void {
  if (!/^[a-f0-9]{12}$/.test(workspaceId)) {
    throw new ExecutorDispatchError("EXECUTOR_DISPATCH_WORKSPACE_MISMATCH", "workspaceId 非法。");
  }
}

/** Ensure every component stays beneath stateDir and contains no symlink/reparse point. */
export function assertExecutorDispatchArtifactPath(
  file: string,
  stateDir: string,
  final: "file" | "directory",
): fs.Stats | null {
  const root = path.resolve(stateDir);
  const resolved = path.resolve(file);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "executor dispatch path 越界。");
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
      throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "executor dispatch path 无法核验。");
    }
    if (stat.isSymbolicLink()) throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "executor dispatch path 含 symlink/reparse point。");
    const isFinal = index === parts.length - 1;
    if (!isFinal && !stat.isDirectory()) throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "executor dispatch path 父级不是普通目录。");
    if (isFinal && !(final === "file" ? stat.isFile() : stat.isDirectory())) {
      throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "executor dispatch artifact 类型不正确。");
    }
    if (isFinal) result = stat;
  }
  return result;
}

export function executorDispatchFile(workspaceId: string, stateDir: string = getStateDir()): string {
  assertWorkspaceId(workspaceId);
  return path.join(stateDir, "executor-dispatch", `${workspaceId}.json`);
}

export function executorDispatchInitializedFile(
  workspaceId: string,
  stateDir: string = getStateDir(),
): string {
  return `${executorDispatchFile(workspaceId, stateDir)}.initialized`;
}

function corrupt(): ExecutorDispatchError {
  return new ExecutorDispatchError("EXECUTOR_DISPATCH_STATE_CORRUPT", "executor dispatch ledger 状态损坏。");
}

function assertCanonicalLockDirectory(directory: string): void {
  const resolved = path.resolve(directory);
  const root = path.parse(resolved).root;
  let current = root;
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "executor dispatch lock path 无法核验。");
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "executor dispatch lock path 含 symlink/reparse point 或非目录。");
    }
  }
}

export function readExecutorDispatchState(
  workspaceId: string,
  stateDir: string = getStateDir(),
): ExecutorDispatchState | null {
  const file = executorDispatchFile(workspaceId, stateDir);
  const marker = executorDispatchInitializedFile(workspaceId, stateDir);
  let hasFile: boolean;
  let hasMarker: boolean;
  try {
    assertExecutorDispatchArtifactPath(path.dirname(file), stateDir, "directory");
    hasFile = !!assertExecutorDispatchArtifactPath(file, stateDir, "file");
    hasMarker = !!assertExecutorDispatchArtifactPath(marker, stateDir, "file");
  } catch {
    throw corrupt();
  }
  if (!hasFile && !hasMarker) return null;
  if (!hasFile && hasMarker) throw corrupt();
  // R5E_DISPATCH_STORE_HARDENING：durable authority 必须是普通非 symlink 文件。
  // initialized marker 一致性：写入顺序保证 file ⇒ marker（marker 先于 rename 落盘）。
  if (!hasMarker) throw corrupt();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const state = parseExecutorDispatchState(raw);
    if (state.workspaceId !== workspaceId) throw corrupt();
    return state;
  } catch (error) {
    if (error instanceof ExecutorDispatchError) throw error;
    throw corrupt();
  }
}

export type ExecutorDispatchUpdateResult<T> = {
  result: T;
  noWrite: boolean;
  state: ExecutorDispatchState;
};

/** release 结果：ownershipLost=true 表示归属无法证明或清理未完成；除幂等二次释放外未删除任何文件。 */
export type ExecutorDispatchLockReleaseOutcome = {
  ownershipLost: boolean;
  reason?: "missing" | "unreadable" | "nonce-mismatch" | "unlink-failed";
};

export interface ExecutorDispatchLedgerLock {
  release(): ExecutorDispatchLockReleaseOutcome;
  /** 提交点归属校验：重读 lock path 并比对 nonce；无法证明归属即抛 OWNERSHIP_LOST。 */
  verifyOwnership(): void;
}

interface DispatchLockPayload {
  pid: number;
  nonce: string;
  createdAt: string;
}

/** pid 存活检查（EPERM = 进程存在但无权限），与 process/daemon-spawn.isPidAlive 同语义。 */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** lock payload strict schema：exact keys + 正整数 pid + UUID nonce + canonical createdAt。 */
const DISPATCH_LOCK_NONCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parseDispatchLockPayload(raw: string): DispatchLockPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "createdAt,nonce,pid") return null;
  const { pid, nonce, createdAt } = record;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof nonce !== "string" || !DISPATCH_LOCK_NONCE_RE.test(nonce)) return null;
  if (
    typeof createdAt !== "string" ||
    Number.isNaN(Date.parse(createdAt)) ||
    new Date(createdAt).toISOString() !== createdAt
  ) {
    return null;
  }
  return { pid, nonce, createdAt };
}

function readDispatchLockPayload(lockFile: string): { raw: string; parsed: DispatchLockPayload } | null {
  let raw: string;
  try {
    const stat = fs.lstatSync(lockFile);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    raw = fs.readFileSync(lockFile, "utf8");
  } catch {
    return null; // missing
  }
  // 结构损坏（JSON 可解析但 schema 不符）→ 未知 owner：绝不视为可信 stale lock。
  const parsed = parseDispatchLockPayload(raw);
  return parsed ? { raw, parsed } : null;
}

/**
 * Generation-numbered wx 仲裁原语：锁路径为 `<base>.<gen>`（gen 严格单调递增）。
 * 所有 acquire/reclaim 的唯一破坏性动作都是 openSync(next, "wx")——path 级
 * create-if-not-exists 原子仲裁；本协议不存在任何 rename，也绝不 unlink 同代
 * 或更高代的锁文件，因此"验证旧 stale lock 后还能动 live owner 锁"的协议路径
 * 不存在：live owner 的代文件在其进程存活期间不可能被任何协议参与者移除或替换。
 */
function dispatchLockGenPath(lockBase: string, gen: number): string {
  return `${lockBase}.${gen}`;
}

/** 列出现存 lock 代数（只认 `.<正整数>` 后缀；忽略 legacy/异物名）。升序返回。 */
function scanDispatchLockGenerations(lockBase: string): number[] {
  const dir = path.dirname(lockBase);
  const base = path.basename(lockBase);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const gens: number[] = [];
  for (const name of names) {
    if (!name.startsWith(`${base}.`)) continue;
    const suffix = name.slice(base.length + 1);
    if (!/^\d+$/.test(suffix)) continue;
    const gen = Number(suffix);
    if (Number.isSafeInteger(gen) && gen > 0) gens.push(gen);
  }
  return gens.sort((a, b) => a - b);
}

/**
 * 获取 executor dispatch ledger 事务锁（generation-numbered wx 仲裁）：
 * 锁路径 `<base>.<gen>`；acquire 扫描最大代并 strict 校验其 payload——
 * 不可解析/结构损坏 → 未知 owner fail closed BUSY；pid 存活 → BUSY（绝不等待/抢占）；
 * 仅 pid 确证死亡才以 openSync(gen+1, "wx") 取代（EEXIST = 并发接管者赢得该代 →
 * 重扫再仲裁）。成功后清理全部更旧代（此前已证明 stale/被取代）。
 * 本函数绝无 rename、绝不 unlink 同代或更高代 → live owner 的锁不可能被移除/替换，
 * "verify → durable commit"窗口在协议层面不存在。
 * release 凭 nonce 校验归属：missing/unreadable/nonce-mismatch/unlink-failed
 * 一律以 bounded ownership-lost 结果上报，绝不删除他方锁、绝不抛错。
 * verifyOwnership 供事务提交点：own-gen nonce 校验 + 更高代出现即拒绝提交
 *（防御纵深：即使协议被违反，同一 previous revision 也最多一个 durable commit）。
 */
const DISPATCH_LOCK_MAX_ATTEMPTS = 16;

export function acquireExecutorDispatchLedgerLock(lockBase: string): ExecutorDispatchLedgerLock {
  assertCanonicalLockDirectory(path.dirname(lockBase));
  fs.mkdirSync(path.dirname(lockBase), { recursive: true, mode: 0o700 });
  assertCanonicalLockDirectory(path.dirname(lockBase));
  for (let attempt = 0; attempt < DISPATCH_LOCK_MAX_ATTEMPTS; attempt += 1) {
    const gens = scanDispatchLockGenerations(lockBase);
    const maxGen = gens.length > 0 ? gens[gens.length - 1]! : 0;
    if (maxGen > 0) {
      // 当前代 payload 不可解析（结构损坏/半写入）→ 未知 owner，fail closed；
      // 只有 strict 有效且 pid 确证死亡才允许被更高代取代。
      const current = readDispatchLockPayload(dispatchLockGenPath(lockBase, maxGen));
      if (!current) {
        throw new ExecutorDispatchError(
          "EXECUTOR_DISPATCH_LOCK_BUSY",
          `executor dispatch ledger 锁被占用（gen=${maxGen} payload 不可解析，未知 owner fail closed）。`,
        );
      }
      if (pidAlive(current.parsed.pid)) {
        throw new ExecutorDispatchError(
          "EXECUTOR_DISPATCH_LOCK_BUSY",
          `executor dispatch ledger 锁被占用（gen=${maxGen} owner pid=${current.parsed.pid} 存活）。`,
        );
      }
    }
    const gen = maxGen + 1;
    const genPath = dispatchLockGenPath(lockBase, gen);
    let fd: number;
    try {
      fd = fs.openSync(genPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") continue; // 并发接管者赢得此代 → 重扫仲裁
      // 其他 errno（EACCES/…）是环境错误，fail closed BUSY。
      throw new ExecutorDispatchError(
        "EXECUTOR_DISPATCH_LOCK_BUSY",
        `executor dispatch ledger 锁不可用（gen=${gen} errno=${(error as NodeJS.ErrnoException)?.code ?? "unknown"}）。`,
      );
    }
    const payload: DispatchLockPayload = {
      pid: process.pid,
      nonce: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`);
      fs.fsyncSync(fd);
    } catch (error) {
      try {
        fs.closeSync(fd);
      } catch {
        // 保留主错误
      }
      try {
        fs.unlinkSync(genPath);
      } catch {
        // 保留主错误
      }
      throw error;
    }
    // 取代完成：清理全部更旧代。它们的 payload 在本代创建前已被证明 stale/被取代，
    // 且本协议任何参与者都不会创建"比已验证 live 锁更高"的代 → 此处不可能触碰
    // live owner 的锁。失败仅留残留（不阻塞：后续 acquire 只认最大代）。
    for (const staleGen of gens) {
      try {
        fs.unlinkSync(dispatchLockGenPath(lockBase, staleGen));
      } catch {
        // 残留不阻塞接管。
      }
    }
    let released = false;
    return {
      verifyOwnership(): void {
        const own = readDispatchLockPayload(genPath);
        if (!own || own.parsed.nonce !== payload.nonce) {
          // own-gen missing / 结构损坏 / 已被替换 → 无法证明归属，拒绝提交。
          throw new ExecutorDispatchError(
            "EXECUTOR_DISPATCH_LOCK_OWNERSHIP_LOST",
            `commit 前 dispatch ledger 锁 ownership 校验失败（gen=${gen} missing/unreadable/nonce-mismatch）；拒绝提交事务。`,
          );
        }
        const higher = scanDispatchLockGenerations(lockBase).some((candidate) => candidate > gen);
        if (higher) {
          // 更高代出现 = authority 已被接管（协议违规或 os liveness 撒谎）→ 拒绝提交，
          // 保证同一 previous revision 最多一个 durable commit。
          throw new ExecutorDispatchError(
            "EXECUTOR_DISPATCH_LOCK_OWNERSHIP_LOST",
            `commit 前发现更高代 dispatch ledger 锁（gen > ${gen}）；锁 authority 已被接管，拒绝提交事务。`,
          );
        }
      },
      release(): ExecutorDispatchLockReleaseOutcome {
        if (released) return { ownershipLost: false };
        released = true;
        try {
          fs.closeSync(fd);
        } catch {
          // fd 清理失败不阻断 ownership 校验
        }
        let raw: string | null = null;
        try {
          raw = fs.readFileSync(genPath, "utf8");
        } catch {
          // missing → 无法证明归属
        }
        if (raw === null) {
          return { ownershipLost: true, reason: "missing" };
        }
        const own = readDispatchLockPayload(genPath);
        if (!own) {
          return { ownershipLost: true, reason: "unreadable" };
        }
        if (own.parsed.nonce !== payload.nonce) {
          // 已被替代（或非本 handle 内容）→ 绝不删除他方锁。
          return { ownershipLost: true, reason: "nonce-mismatch" };
        }
        try {
          fs.unlinkSync(genPath);
        } catch {
          // nonce 匹配但最终删除失败：清理责任未完成，不得声称归属未丢失。
          return { ownershipLost: true, reason: "unlink-failed" };
        }
        return { ownershipLost: false };
      },
    };
  }
  throw new ExecutorDispatchError(
    "EXECUTOR_DISPATCH_LOCK_BUSY",
    `executor dispatch ledger 锁竞争超过 ${DISPATCH_LOCK_MAX_ATTEMPTS} 轮仲裁，fail closed。`,
  );
}

/** 把有界 lock ownership-loss 证据附加到原始错误对象上（不替换主错误）。 */
function attachDispatchLockOwnershipLoss(
  error: unknown,
  outcome: ExecutorDispatchLockReleaseOutcome,
): void {
  if (error instanceof Error) {
    const target = error as Error & {
      executorDispatchLockOwnershipLost?: boolean;
      executorDispatchLockOwnershipLostReason?: string;
    };
    target.executorDispatchLockOwnershipLost = true;
    target.executorDispatchLockOwnershipLostReason = outcome.reason ?? "unknown";
  }
}

/**
 * Durable update（仿 executor-control/store 模式）：bounded wx lock + metadata fsync
 * + runtime parse + revision 校验 + noWrite byte-equality + tmp wx 0o600 + fsync + rename。
 * change 回调在锁内重读状态；可返回 noWrite 表示幂等无写。
 * 写纪律模板统一由 src/core/durable-store.ts 保证：wx 锁、tmp wx 0o600、
 * fsyncSync、initialized marker（.initialized）先于 rename、原子 rename、失败清 tmp、锁清理。
 *
 * 锁 ownership（R5e）：事务锁带随机 nonce；release 前重新验证 nonce，绝不删除
 * 替代锁；成功事务后 ownership lost / cleanup 失败一律抛
 * EXECUTOR_DISPATCH_LOCK_OWNERSHIP_LOST（成功 mutation 不静默伪装为成功）；
 * change 抛错时原始错误仍是主错误，ownership 证据有界附加（不替换主错误）。
 * 事务提交点（durable rename 前）做 ownership recheck（own-gen nonce + 更高代
 * 缺席）：stale reclaimer 无法移除/替换 live owner 的代文件（协议无 rename、
 * 不碰他方锁），即使协议被违反也会拒绝提交，守住 ledger 单写者假设。
 */
export function updateExecutorDispatchDetailed<T>(
  workspaceId: string,
  workspaceRoot: string,
  change: (state: ExecutorDispatchState | null) =>
    | { state: ExecutorDispatchState; result: T; noWrite?: boolean },
  stateDir: string = getStateDir(),
): ExecutorDispatchUpdateResult<T> {
  assertWorkspaceId(workspaceId);
  const file = executorDispatchFile(workspaceId, stateDir);
  assertExecutorDispatchArtifactPath(path.dirname(file), stateDir, "directory");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  assertExecutorDispatchArtifactPath(path.dirname(file), stateDir, "directory");
  // 锁协议适配引擎 DurableLockProvider：acquire 原样走 generation 仲裁；
  // release 调原 lock.release() 并把 bounded outcome 记入外层闭包变量。
  let heldLock: ExecutorDispatchLedgerLock | null = null;
  let releaseOutcome: ExecutorDispatchLockReleaseOutcome = { ownershipLost: false };
  const lockProvider: DurableLockProvider = {
    acquire(lockPath: string) {
      const held = acquireExecutorDispatchLedgerLock(lockPath);
      heldLock = held;
      return {
        release(): void {
          releaseOutcome = held.release();
        },
      };
    },
  };
  let action: { ok: true; value: ExecutorDispatchUpdateResult<T> } | { ok: false; error: unknown };
  try {
    action = {
      ok: true,
      value: runDispatchUpdate(
        workspaceId,
        workspaceRoot,
        stateDir,
        change,
        () => heldLock!.verifyOwnership(),
        lockProvider,
      ),
    };
  } catch (error) {
    action = { ok: false, error };
  }
  if (!action.ok) {
    if (releaseOutcome.ownershipLost) {
      attachDispatchLockOwnershipLoss(action.error, releaseOutcome);
    }
    throw action.error;
  }
  if (releaseOutcome.ownershipLost) {
    throw new ExecutorDispatchError(
      "EXECUTOR_DISPATCH_LOCK_OWNERSHIP_LOST",
      `executor dispatch ledger 锁 release 无法证明归属（reason=${releaseOutcome.reason ?? "unknown"}）；事务结果不得在失去锁归属后静默返回成功。`,
    );
  }
  return action.value;
}

function runDispatchUpdate<T>(
  workspaceId: string,
  workspaceRoot: string,
  stateDir: string,
  change: (state: ExecutorDispatchState | null) =>
    | { state: ExecutorDispatchState; result: T; noWrite?: boolean },
  verifyCommitOwnership: () => void,
  lock: DurableLockProvider,
): ExecutorDispatchUpdateResult<T> {
  const file = executorDispatchFile(workspaceId, stateDir);
  const marker = executorDispatchInitializedFile(workspaceId, stateDir);
  // tmp 名惰性派生并记忆：保持原实现"marker 落盘后才生成"的顺序，
  // beforeTmp/beforeRename 钩子与引擎 tmp 写入共用同一路径。
  let tmpPath: string | null = null;
  const tmpNameFor = (target: string): string => {
    if (tmpPath === null) {
      tmpPath = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
    return tmpPath;
  };
  const outcome = runDurableStoreTransaction<ExecutorDispatchState, T>({
    file,
    marker,
    markerContent: `${workspaceId}\n`,
    lockPath: `${file}.lock`,
    lock,
    tmpName: tmpNameFor,
    serialize: (state) => `${JSON.stringify(state, null, 2)}\n`,
    noWrite: {
      mode: "require-previous",
      onMissingPrevious: () => new ExecutorDispatchError(
        "EXECUTOR_DISPATCH_STATE_CORRUPT",
        "noWrite 要求已存在 durable state；拒绝无状态成功。",
      ),
      onChanged: () => new ExecutorDispatchError(
        "EXECUTOR_DISPATCH_STATE_CORRUPT",
        "noWrite 状态与 previous 不一致。",
      ),
    },
    afterRead: (previous) => {
      // 读阶段路径硬化断言 + workspaceRoot 身份校验。
      assertExecutorDispatchArtifactPath(path.dirname(file), stateDir, "directory");
      if (previous && previous.workspaceRoot !== workspaceRoot) {
        throw new ExecutorDispatchError(
          "EXECUTOR_DISPATCH_WORKSPACE_MISMATCH",
          "executor dispatch ledger workspaceRoot 不匹配。",
        );
      }
    },
    sequence: "identity-first",
    // 每次写入前 runtime parse + workspace identity 校验。
    parseAndCheckIdentity: (state) => {
      const validated = parseExecutorDispatchState(state);
      if (validated.workspaceId !== workspaceId || validated.workspaceRoot !== workspaceRoot) {
        throw corrupt();
      }
      return validated;
    },
    verifyRevision: (validated, previous) => {
      if (previous && validated.revision !== previous.revision + 1) {
        throw corrupt();
      }
      if (!previous && validated.revision !== 1) {
        throw corrupt();
      }
    },
    beforeMarker: () => {
      assertExecutorDispatchArtifactPath(path.dirname(marker), stateDir, "directory");
      assertExecutorDispatchArtifactPath(marker, stateDir, "file");
    },
    beforeTmp: () => {
      const tmp = tmpNameFor(file);
      assertExecutorDispatchArtifactPath(path.dirname(tmp), stateDir, "directory");
      assertExecutorDispatchArtifactPath(tmp, stateDir, "file");
    },
    beforeRename: () => {
      assertExecutorDispatchArtifactPath(path.dirname(file), stateDir, "directory");
      assertExecutorDispatchArtifactPath(tmpNameFor(file), stateDir, "file");
      assertExecutorDispatchArtifactPath(marker, stateDir, "file");
      assertExecutorDispatchArtifactPath(file, stateDir, "file");
      // 提交点 ownership recheck：durable rename 前最后确认锁归属；
      // 被并发 stale reclaimer 掠走即拒绝提交（tmp 由引擎 catch 清理）。
      verifyCommitOwnership();
    },
  }, change, () => readExecutorDispatchState(workspaceId, stateDir));
  return { result: outcome.result, noWrite: outcome.noWrite, state: outcome.state as ExecutorDispatchState };
}

/** append/replace 共用的 entries 容量门禁（store 层 fail closed）。 */
export function assertDispatchEntriesWithinLimit(entries: readonly unknown[]): void {
  if (entries.length > EXECUTOR_DISPATCH_MAX_ENTRIES) {
    throw new ExecutorDispatchError(
      "EXECUTOR_DISPATCH_ENTRY_LIMIT",
      `executor dispatch ledger 已达 ${EXECUTOR_DISPATCH_MAX_ENTRIES} 条上限。`,
    );
  }
}

function validateCleanupTarget(target: CommandCleanupTarget): string {
  if (!/^[a-f0-9]{12}$/.test(target.workspaceId) || !/^[A-Za-z0-9_-]{1,128}$/.test(target.commandId) ||
      target.iteration !== 1 || !target.workspaceRoot) {
    throw new CommandCleanupError("COMMAND_CLEANUP_INVALID", "executor dispatch cleanup identity 非法。");
  }
  return path.resolve(target.stateDir ?? getStateDir());
}

function dispatchArtifact(entry: ExecutorDispatchEntry): CleanupArtifact {
  return cleanupArtifact("executor_dispatch", entry.commandId, entry);
}

function exactJournal(target: CommandCleanupTarget, expected: readonly CleanupArtifact[], stateDir: string): void {
  const journal = readCleanupJournal(target.workspaceId, target.commandId, stateDir);
  if (!journal || journal.phase === "snapshot_pending" || journal.workspaceRoot !== target.workspaceRoot || journal.iteration !== 1) {
    throw new CommandCleanupError("COMMAND_CLEANUP_REQUIRED", "缺少完整匹配的 cleanup_pending journal；拒绝删除 dispatch entry。");
  }
  const sort = (items: readonly CleanupArtifact[]) => [...items].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  if (JSON.stringify(sort(expected)) !== JSON.stringify(sort(journal.artifacts))) {
    throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "cleanup expected artifacts 与 journal 不一致。");
  }
}

export type ExecutorDispatchCleanupMode = "manual_force" | "auto_observed";

/** Read-only exact snapshot; automatic collection accepts only new ephemeral pins, manual previews include legacy. */
export function inspectExecutorDispatchCleanupArtifacts(
  target: CommandCleanupTarget,
  mode: ExecutorDispatchCleanupMode = "manual_force",
): CleanupArtifact[] {
  const stateDir = validateCleanupTarget(target);
  const journal = readCleanupJournal(target.workspaceId, target.commandId, stateDir);
  const file = executorDispatchFile(target.workspaceId, stateDir);
  assertExecutorDispatchArtifactPath(path.dirname(file), stateDir, "directory");
  assertExecutorDispatchArtifactPath(executorDispatchInitializedFile(target.workspaceId, stateDir), stateDir, "file");
  assertExecutorDispatchArtifactPath(file, stateDir, "file");
  const state = readExecutorDispatchState(target.workspaceId, stateDir);
  if (state && state.workspaceRoot !== target.workspaceRoot) {
    throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "executor dispatch workspaceRoot 与 cleanup target 不一致。");
  }
  const entry = state?.entries.find(item => item.commandId === target.commandId);
  const expectedDispatch = journal?.artifacts.some(item => item.kind === "executor_dispatch" && item.id === target.commandId) ?? false;
  if (mode === "auto_observed" && entry && entry.lifecycle !== "ephemeral" && expectedDispatch) {
    throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "auto cleanup 不得包含 legacy dispatch entry。");
  }
  const artifacts = entry && (mode === "manual_force" || entry.lifecycle === "ephemeral") ? [dispatchArtifact(entry)] : [];
  if (journal && journal.phase !== "snapshot_pending") assertCleanupArtifacts(artifacts, journal.artifacts);
  return artifacts;
}

/** Exact physical deletion for a complete cleanup journal; preserves ledger markers and other entries. */
export function deleteExecutorDispatchCleanupArtifacts(
  target: CommandCleanupTarget,
  expected: readonly CleanupArtifact[],
): void {
  const stateDir = validateCleanupTarget(target);
  exactJournal(target, expected, stateDir);
  const journal = readCleanupJournal(target.workspaceId, target.commandId, stateDir)!;
  withCommandOperation(target.workspaceId, target.commandId, () => {
    const file = executorDispatchFile(target.workspaceId, stateDir);
    assertExecutorDispatchArtifactPath(path.dirname(file), stateDir, "directory");
    const current = readExecutorDispatchState(target.workspaceId, stateDir);
    if (!current) return;
    if (current.workspaceRoot !== target.workspaceRoot) {
      throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "executor dispatch workspaceRoot 与 cleanup target 不一致。");
    }
    updateExecutorDispatchDetailed<{ deleted: boolean }>(target.workspaceId, target.workspaceRoot, previous => {
      const entry = previous?.entries.find(item => item.commandId === target.commandId);
      if (!previous || !entry) {
        if (!previous) throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "dispatch ledger 在精确删除事务中消失。");
        return { state: previous, result: { deleted: false }, noWrite: true };
      }
      const artifact = dispatchArtifact(entry);
      if (entry.lifecycle !== "ephemeral" && journal.mode === "auto_observed") {
        if (expected.some(item => item.kind === "executor_dispatch" && item.id === target.commandId)) {
          throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "auto cleanup journal 不得包含 legacy dispatch entry。");
        }
        return { state: previous, result: { deleted: false }, noWrite: true };
      }
      assertCleanupArtifacts([artifact], expected);
      const entries = previous.entries.filter(item => item.commandId !== target.commandId);
      return {
        state: { ...previous, revision: previous.revision + 1, entries },
        result: { deleted: true },
      };
    }, stateDir);
    exactJournal(target, expected, stateDir);
    const after = readExecutorDispatchState(target.workspaceId, stateDir);
    const remaining = after?.entries.find(item => item.commandId === target.commandId);
    const expectedDispatch = expected.some(item => item.kind === "executor_dispatch" && item.id === target.commandId);
    if (remaining && !(journal.mode === "auto_observed" && remaining.lifecycle !== "ephemeral" && !expectedDispatch)) {
      throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "executor dispatch entry 物理删除未完成。");
    }
  }, stateDir, true);
}
