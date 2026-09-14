import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { legacyRolloutLockPath } from "./maintenance-lock.js";

export type RolloutFenceHandle = {
  readonly path: string;
  readonly token: string;
  release(): boolean;
};

/**
 * maintenance 之后原子创建 rollout.lock。
 * legacy 已存在文件只视为 busy，不解析、不 steal。
 */
export function tryAcquireRolloutFence(stateDir: string): { ok: true; handle: RolloutFenceHandle } | { ok: false } {
  const file = legacyRolloutLockPath(stateDir);
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { ok: false };
    throw error;
  }
  const token = randomUUID();
  try {
    fs.writeFileSync(fd, JSON.stringify({ version: 1, operation: "gc-or-rollout", token, pid: process.pid, createdAt: new Date().toISOString() }));
    fs.fsyncSync(fd);
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    throw error;
  }
  let released = false;
  return {
    ok: true,
    handle: {
      path: file,
      token,
      release() {
        if (released) return true;
        try {
          const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { token?: string };
          if (raw.token !== token) return false;
          fs.closeSync(fd);
          fs.unlinkSync(file);
        } catch {
          return false;
        }
        released = true;
        return true;
      },
    },
  };
}

export type FenceCleanupReport = {
  rolloutReleased: boolean;
  issues: string[];
};

/** close/unlink 分步记录，失败不覆盖原始 action error。 */
export function releaseRolloutFence(handle: RolloutFenceHandle | null | undefined): FenceCleanupReport {
  if (!handle) return { rolloutReleased: true, issues: [] };
  const ok = handle.release();
  return ok
    ? { rolloutReleased: true, issues: [] }
    : { rolloutReleased: false, issues: ["rollout_fence_release_failed: rollout.lock 未能安全释放"] };
}
