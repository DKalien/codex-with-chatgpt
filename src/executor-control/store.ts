import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "../config/paths.js";
import {
  ExecutorControlError,
  parseExecutorControlState,
  type ExecutorControlState,
} from "./schema.js";

const MAX_EPOCH = 2_147_483_647;

function assertWorkspaceId(workspaceId: string): void {
  if (!/^[a-f0-9]{12}$/.test(workspaceId)) {
    throw new ExecutorControlError("EXECUTOR_CONTROL_WORKSPACE_MISMATCH", "workspaceId 非法。");
  }
}

export function executorControlFile(workspaceId: string): string {
  assertWorkspaceId(workspaceId);
  return path.join(getStateDir(), "executor-control", `${workspaceId}.json`);
}

export function executorControlInitializedFile(workspaceId: string): string {
  return `${executorControlFile(workspaceId)}.initialized`;
}

function corrupt(): ExecutorControlError {
  return new ExecutorControlError("EXECUTOR_CONTROL_STATE_CORRUPT", "active executor binding 状态损坏。");
}

export function readExecutorControl(workspaceId: string): ExecutorControlState | null {
  const file = executorControlFile(workspaceId);
  const marker = executorControlInitializedFile(workspaceId);
  const hasFile = fs.existsSync(file);
  const hasMarker = fs.existsSync(marker);
  if (!hasFile && !hasMarker) return null;
  if (!hasFile && hasMarker) throw corrupt();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const state = parseExecutorControlState(raw);
    if (state.workspaceId !== workspaceId) throw corrupt();
    return state;
  } catch (error) {
    if (error instanceof ExecutorControlError) throw error;
    throw corrupt();
  }
}

export type ExecutorControlUpdateResult<T> = {
  result: T;
  noWrite: boolean;
  state: ExecutorControlState;
};

/**
 * Durable update with bounded lock + fsync + initialized marker.
 * change 回调在锁内重读状态；可返回 noWrite 表示幂等无写。
 */
export function updateExecutorControl<T>(
  workspaceId: string,
  workspaceRoot: string,
  change: (state: ExecutorControlState | null) =>
    | { state: ExecutorControlState; result: T; noWrite?: boolean }
    | { state: ExecutorControlState; result: T; noWrite: true },
): T {
  return updateExecutorControlDetailed(workspaceId, workspaceRoot, change).result;
}

export function updateExecutorControlDetailed<T>(
  workspaceId: string,
  workspaceRoot: string,
  change: (state: ExecutorControlState | null) =>
    | { state: ExecutorControlState; result: T; noWrite?: boolean },
): ExecutorControlUpdateResult<T> {
  assertWorkspaceId(workspaceId);
  const file = executorControlFile(workspaceId);
  const marker = executorControlInitializedFile(workspaceId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  let lockFd: number | null = null;
  try {
    lockFd = fs.openSync(lock, "wx");
  } catch {
    throw new ExecutorControlError("EXECUTOR_CONTROL_LOCK_BUSY", "executor binding 状态锁被占用。");
  }
  try {
    const lockPayload = `${process.pid}\n${new Date().toISOString()}\n`;
    fs.writeFileSync(lockFd, lockPayload);
    fs.fsyncSync(lockFd);

    const previous = readExecutorControl(workspaceId);
    if (previous && previous.workspaceRoot !== workspaceRoot) {
      throw new ExecutorControlError(
        "EXECUTOR_CONTROL_WORKSPACE_MISMATCH",
        "executor binding 状态 workspaceRoot 不匹配。",
      );
    }
    const next = change(previous);
    // 每次写入前 runtime parse + workspace identity 校验。
    const validated = parseExecutorControlState(next.state);
    if (validated.workspaceId !== workspaceId || validated.workspaceRoot !== workspaceRoot) {
      throw corrupt();
    }
    if (next.noWrite) {
      if (!previous) {
        throw new ExecutorControlError(
          "EXECUTOR_CONTROL_STATE_CORRUPT",
          "noWrite 要求已存在 durable state；拒绝无状态成功。",
        );
      }
      if (JSON.stringify(validated) !== JSON.stringify(previous)) {
        throw new ExecutorControlError(
          "EXECUTOR_CONTROL_STATE_CORRUPT",
          "noWrite 状态与 previous 不一致。",
        );
      }
      return { result: next.result, noWrite: true, state: validated };
    }
    if (previous && validated.revision !== previous.revision + 1) {
      throw corrupt();
    }
    if (!previous && validated.revision !== 1) {
      throw corrupt();
    }
    if (!fs.existsSync(marker)) {
      const markerFd = fs.openSync(marker, "wx");
      try {
        fs.writeFileSync(markerFd, `${workspaceId}\n`);
        fs.fsyncSync(markerFd);
      } finally {
        fs.closeSync(markerFd);
      }
    }
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      const fd = fs.openSync(tmp, "wx", 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(validated, null, 2)}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch { /* keep primary error */ }
      throw error;
    }
    return { result: next.result, noWrite: false, state: validated };
  } finally {
    try {
      if (lockFd !== null) fs.closeSync(lockFd);
      fs.unlinkSync(lock);
    } catch {
      // lock cleanup failure must not hide the primary result/error
    }
  }
}

export function nextEpoch(current: number): number {
  if (current >= MAX_EPOCH) {
    throw new ExecutorControlError("EXECUTOR_CONTROL_EPOCH_OVERFLOW", "binding epoch 已达上限。");
  }
  return current + 1;
}

export { MAX_EPOCH };
