import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "../config/paths.js";
import { runDurableStoreTransaction, simpleWxLock } from "../core/durable-store.js";
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

/**
 * Durable update with bounded lock + fsyncSync + initialized marker（.initialized）。
 * change 回调在锁内重读状态；可返回 noWrite 表示幂等无写（byte-equality 校验）。
 * 写纪律模板统一由 src/core/durable-store.ts 保证：wx 锁、tmp wx 0600、
 * fsyncSync、initialized marker 先于 rename、原子 rename、失败清 tmp、锁清理吞错。
 */
export function updateExecutorControlDetailed<T>(
  workspaceId: string,
  workspaceRoot: string,
  change: (state: ExecutorControlState | null) =>
    | { state: ExecutorControlState; result: T; noWrite?: boolean },
): ExecutorControlUpdateResult<T> {
  assertWorkspaceId(workspaceId);
  const file = executorControlFile(workspaceId);
  const outcome = runDurableStoreTransaction<ExecutorControlState, T>({
    file,
    marker: executorControlInitializedFile(workspaceId),
    markerContent: `${workspaceId}\n`,
    lockPath: `${file}.lock`,
    lock: simpleWxLock({
      payload: () => `${process.pid}\n${new Date().toISOString()}\n`,
      busyError: () => new ExecutorControlError("EXECUTOR_CONTROL_LOCK_BUSY", "executor binding 状态锁被占用。"),
      cleanup: "swallow",
    }),
    tmpName: (target) => `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    serialize: (state) => `${JSON.stringify(state, null, 2)}\n`,
    noWrite: {
      mode: "require-previous",
      onMissingPrevious: () => new ExecutorControlError(
        "EXECUTOR_CONTROL_STATE_CORRUPT",
        "noWrite 要求已存在 durable state；拒绝无状态成功。",
      ),
      onChanged: () => new ExecutorControlError(
        "EXECUTOR_CONTROL_STATE_CORRUPT",
        "noWrite 状态与 previous 不一致。",
      ),
    },
    afterRead: (previous) => {
      if (previous && previous.workspaceRoot !== workspaceRoot) {
        throw new ExecutorControlError(
          "EXECUTOR_CONTROL_WORKSPACE_MISMATCH",
          "executor binding 状态 workspaceRoot 不匹配。",
        );
      }
    },
    sequence: "identity-first",
    // 每次写入前 runtime parse + workspace identity 校验。
    parseAndCheckIdentity: (state) => {
      const validated = parseExecutorControlState(state);
      if (validated.workspaceId !== workspaceId || validated.workspaceRoot !== workspaceRoot) {
        throw corrupt();
      }
      return validated;
    },
    verifyRevision: (validated, previous) => {
      if (previous && validated.revision !== previous.revision + 1) throw corrupt();
      if (!previous && validated.revision !== 1) throw corrupt();
    },
  }, change, () => readExecutorControl(workspaceId));
  return { result: outcome.result, noWrite: outcome.noWrite, state: outcome.state as ExecutorControlState };
}

export function nextEpoch(current: number): number {
  if (current >= MAX_EPOCH) {
    throw new ExecutorControlError("EXECUTOR_CONTROL_EPOCH_OVERFLOW", "binding epoch 已达上限。");
  }
  return current + 1;
}

export { MAX_EPOCH };
