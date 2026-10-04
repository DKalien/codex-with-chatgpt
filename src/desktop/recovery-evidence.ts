import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir } from "../config/paths.js";
import { DesktopError, desktopId } from "./store.js";

/** Shared administrative evidence lock; domain stores remain separate. */
export class LegacyReconciliationError extends DesktopError {
  constructor(code: string, message: string, readonly discoveryStatus: "missing_execution" | "missing_output" | "conflict" = "conflict") {
    super(code, message);
    this.name = "LegacyReconciliationError";
  }
}

function lockFile(workspaceId: string, stateDir = getStateDir()): string {
  return path.join(path.resolve(stateDir), "desktop-legacy-reconciliation", `${desktopId.parse(workspaceId)}.json.lock`);
}

export function withEvidenceLock<T>(workspaceId: string, action: () => T, stateDir = getStateDir()): T {
  const file = lockFile(workspaceId, stateDir);
  ensureDir(path.dirname(file));
  let fd: number;
  try { fd = fs.openSync(file, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new LegacyReconciliationError("LEGACY_RECONCILIATION_BUSY", "遗留 reconciliation 写锁繁忙；请稍后重试。");
    }
    throw error;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    fs.fsyncSync(fd);
    return action();
  } finally {
    try { fs.closeSync(fd); }
    finally { fs.unlinkSync(file); }
  }
}
