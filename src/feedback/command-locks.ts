import { withCommandOperation } from "../command-cleanup/fence.js";
import { FeedbackError } from "./schema.js";

/** Acquire workspace command lifecycle locks in a stable order before any feedback store lock. */
export function withFeedbackCommandLocks<T>(
  workspaceId: string,
  commandIds: Iterable<string>,
  stateDir: string,
  action: () => T,
): T {
  const ids = [...new Set(commandIds)].sort();
  const acquire = (index: number): T => index === ids.length
    ? action()
    : withCommandOperation(workspaceId, ids[index]!, () => acquire(index + 1), stateDir);
  return acquire(0);
}

export function assertFeedbackCommandSnapshot(lockedIds: Iterable<string>, currentIds: Iterable<string>): void {
  const locked = new Set(lockedIds);
  if ([...currentIds].some(id => !locked.has(id))) {
    throw new FeedbackError("FEEDBACK_COMMAND_SNAPSHOT_CHANGED", "feedback source 在获取 command lifecycle locks 期间变化；保留状态并安全重试。");
  }
}
