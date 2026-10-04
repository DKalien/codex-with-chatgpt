import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDir, getStateDir } from "../config/paths.js";
import { assertFeedbackCommandSnapshot, withFeedbackCommandLocks } from "./command-locks.js";
import { assertNoLegacyHistoryCleanup } from "../command-cleanup/legacy-history-fence.js";
import {
  FEEDBACK_CLAIM_STALE_MS,
  FEEDBACK_RESERVATION_STALE_MS,
  WORKSPACE_ID,
  feedbackStateSchema,
  FeedbackError,
  type FeedbackState,
} from "./schema.js";

export function feedbackStateFile(workspaceId: string, stateDir = getStateDir()): string {
  if (!WORKSPACE_ID.test(workspaceId)) {
    throw new FeedbackError("FEEDBACK_WORKSPACE_MISMATCH", "workspaceId 无效");
  }
  return path.join(path.resolve(stateDir), "feedback", `${workspaceId}.json`);
}

function emptyState(workspaceId: string, projectionCursor = 0): FeedbackState {
  return {
    version: 1,
    workspaceId,
    projectionCursor,
    binding: null,
    events: [],
    pairingIntent: null,
    companion: null,
    rebindIntent: null,
    rebindPredecessor: null,
  };
}

function readState(workspaceId: string, stateDir: string): FeedbackState | null {
  const file = feedbackStateFile(workspaceId, stateDir);
  try {
    const parsed = feedbackStateSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (parsed.workspaceId !== workspaceId) {
      throw new FeedbackError("FEEDBACK_WORKSPACE_MISMATCH", "feedback 状态 workspace 身份不匹配");
    }
    return parsed;
  } catch (error) {
    if (error instanceof FeedbackError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new FeedbackError("FEEDBACK_STATE_CORRUPT", "production feedback 状态损坏；保留文件人工核对");
  }
}

export function writeState(
  workspaceId: string,
  stateDir: string,
  state: FeedbackState,
  options: { allowPreparedCleanupId?: string } = {},
): void {
  assertNoLegacyHistoryCleanup(workspaceId, stateDir);
  const file = feedbackStateFile(workspaceId, stateDir);
  const prepared = readState(workspaceId, stateDir)?.cleanupAdjustments?.find(item => item.state === "prepared");
  if (prepared && prepared.cleanupId !== options.allowPreparedCleanupId) {
    throw new FeedbackError("FEEDBACK_CURSOR_CLEANUP_PENDING", "command cleanup cursor adjustment 已 prepared；拒绝其它 Feedback state mutation。");
  }
  ensureDir(path.dirname(file));
  const tmp = `${file}.${randomUUID()}.tmp`;
  let fd = -1;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    const payload = JSON.stringify(feedbackStateSchema.parse(state), null, 2);
    fs.writeFileSync(fd, payload, { encoding: "utf8" });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = -1;
    fs.renameSync(tmp, file);
  } finally {
    if (fd >= 0) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* rename 后残留清理 */ }
  }
}

export function withFeedbackLock<T>(workspaceId: string, stateDir: string, fn: (read: () => FeedbackState | null) => T): T {
  assertNoLegacyHistoryCleanup(workspaceId, stateDir);
  const file = feedbackStateFile(workspaceId, stateDir);
  ensureDir(path.dirname(file));
  const lock = `${file}.lock`;
  let fd: number;
  try {
    fd = fs.openSync(lock, "wx", 0o600);
  } catch {
    throw new FeedbackError("FEEDBACK_BUSY", "feedback 状态锁繁忙；不清理遗留锁");
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    fs.fsyncSync(fd);
    assertNoLegacyHistoryCleanup(workspaceId, stateDir);
    return fn(() => readState(workspaceId, stateDir));
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(lock); } catch { /* ignore */ }
  }
}

/** binding API 不得隐式 baseline；必须已由 ensureFeedbackState 初始化。 */
export function requireInitializedState(
  previous: FeedbackState | null,
  workspaceId: string,
): FeedbackState {
  if (!previous) {
    throw new FeedbackError(
      "FEEDBACK_STATE_UNINITIALIZED",
      "production feedback state 尚未初始化；先 reconcile 建立 baseline cursor",
    );
  }
  return previous;
}

export function readFeedbackState(workspaceId: string, stateDir = getStateDir()): FeedbackState {
  const existing = readState(workspaceId, stateDir);
  if (!existing) {
    throw new FeedbackError(
      "FEEDBACK_STATE_UNINITIALIZED",
      "production feedback state 尚未初始化",
    );
  }
  return existing;
}

/** Status only: absence is disabled, never initialize a cursor or acquire lifecycle locks. */
export function readFeedbackStatusState(workspaceId: string, stateDir = getStateDir()): FeedbackState {
  return readState(workspaceId, stateDir) ?? emptyState(workspaceId);
}

/** 首次建立 state：cursor = 当前 execution record 数量（历史 baseline，不投影）。 */
export function ensureFeedbackState(
  workspaceId: string,
  baselineCursor: number,
  stateDir = getStateDir(),
): FeedbackState {
  return withFeedbackLock(workspaceId, stateDir, (read) => {
    const previous = read();
    if (previous) return previous;
    if (!Number.isInteger(baselineCursor) || baselineCursor < 0) {
      throw new FeedbackError("FEEDBACK_CURSOR_INVALID", "baseline cursor 无效");
    }
    const next = emptyState(workspaceId, baselineCursor);
    writeState(workspaceId, stateDir, next);
    return next;
  });
}

function recoverStaleClaimed(state: FeedbackState, nowMs: number): FeedbackState {
  let changed = false;
  const events = state.events.map((event) => {
    if (event.status !== "claimed" || !event.claimedAt) return event;
    const age = nowMs - Date.parse(event.claimedAt);
    if (Number.isFinite(age) && age >= FEEDBACK_CLAIM_STALE_MS) {
      changed = true;
      return { ...event, status: "outcome_unknown" as const, updatedAt: new Date(nowMs).toISOString() };
    }
    return event;
  });
  return changed ? { ...state, events } : state;
}

function recoverStaleReserved(state: FeedbackState, nowMs: number): FeedbackState {
  let changed = false;
  const events = state.events.map((event) => {
    if (event.status !== "reserved" || !event.reservedAt) return event;
    const age = nowMs - Date.parse(event.reservedAt);
    if (Number.isFinite(age) && age >= FEEDBACK_RESERVATION_STALE_MS) {
      changed = true;
      const {
        reservationId: _rid,
        reservedAt: _rat,
        reservedBy: _rby,
        ...rest
      } = event;
      return {
        ...rest,
        status: "ready" as const,
        updatedAt: new Date(nowMs).toISOString(),
      };
    }
    return event;
  });
  return changed ? { ...state, events } : state;
}

export function recoverStaleInMemory(state: FeedbackState, nowMs: number): FeedbackState {
  return recoverStaleReserved(recoverStaleClaimed(state, nowMs), nowMs);
}

/** Lock every command represented in the snapshot before taking the shared Feedback store lock. */
export function withFeedbackCommandSnapshotLock<T>(
  workspaceId: string,
  stateDir: string,
  action: (state: FeedbackState) => T,
): T {
  const snapshot = readFeedbackState(workspaceId, stateDir);
  const commandIds = snapshot.events.map(event => event.commandId);
  // ponytail: stale recovery scans the workspace event list; lock all IDs until recovery can target one event.
  return withFeedbackCommandLocks(workspaceId, commandIds, stateDir, () => withFeedbackLock(workspaceId, stateDir, read => {
    const current = requireInitializedState(read(), workspaceId);
    assertFeedbackCommandSnapshot(commandIds, current.events.map(event => event.commandId));
    return action(current);
  }));
}

/** Explicit stale maintenance locks only events whose durable status will change. */
export function recoverStaleFeedback(
  workspaceId: string,
  stateDir = getStateDir(),
  nowMs: number = Date.now(),
): FeedbackState {
  const changedIds = (state: FeedbackState) => recoverStaleInMemory(state, nowMs).events
    .filter((event, index) => event !== state.events[index]).map(event => event.commandId);
  const snapshot = readFeedbackState(workspaceId, stateDir);
  const ids = changedIds(snapshot);
  if (!ids.length) return snapshot;
  return withFeedbackCommandLocks(workspaceId, ids, stateDir, () => withFeedbackLock(workspaceId, stateDir, read => {
    const previous = requireInitializedState(read(), workspaceId);
    assertFeedbackCommandSnapshot(ids, changedIds(previous));
    const recovered = recoverStaleInMemory(previous, nowMs);
    if (recovered !== previous) writeState(workspaceId, stateDir, recovered);
    return recovered;
  }));
}
