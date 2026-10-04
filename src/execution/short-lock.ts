/**
 * Only classify a failed openSync(lock, "wx"): no write authority was acquired.
 * Windows can report EPERM/EACCES during short create/unlink contention. Retry
 * under the caller's existing 500ms budget, then BUSY; never inspect/reclaim a lock.
 * Action/close/unlink errors must never pass through this acquisition policy.
 */
export function isExecutionLockAcquisitionContention(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EEXIST" || (process.platform === "win32" && (code === "EPERM" || code === "EACCES"));
}
