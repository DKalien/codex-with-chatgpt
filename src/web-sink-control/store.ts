import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "../config/paths.js";
import {
  WebSinkControlError,
  parseWebSinkControlState,
  type WebSinkControlState,
} from "./schema.js";

const MAX_EPOCH = 2_147_483_647;

function assertWorkspaceId(workspaceId: string): void {
  if (!/^[a-f0-9]{12}$/.test(workspaceId)) {
    throw new WebSinkControlError("WEB_SINK_WORKSPACE_MISMATCH", "workspaceId 非法。");
  }
}

export function webSinkControlFile(workspaceId: string): string {
  assertWorkspaceId(workspaceId);
  return path.join(getStateDir(), "web-sink-control", `${workspaceId}.json`);
}

export function webSinkControlInitializedFile(workspaceId: string): string {
  return `${webSinkControlFile(workspaceId)}.initialized`;
}

function corrupt(): WebSinkControlError {
  return new WebSinkControlError("WEB_SINK_STATE_CORRUPT", "active web sink binding 状态损坏。");
}

export function readWebSinkControl(workspaceId: string): WebSinkControlState | null {
  const file = webSinkControlFile(workspaceId);
  const marker = webSinkControlInitializedFile(workspaceId);
  const hasFile = fs.existsSync(file);
  const hasMarker = fs.existsSync(marker);
  if (!hasFile && !hasMarker) return null;
  if (!hasFile && hasMarker) throw corrupt();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const state = parseWebSinkControlState(raw);
    if (state.workspaceId !== workspaceId) throw corrupt();
    return state;
  } catch (error) {
    if (error instanceof WebSinkControlError) throw error;
    throw corrupt();
  }
}

export type WebSinkControlUpdateResult<T> = {
  result: T;
  noWrite: boolean;
  state: WebSinkControlState;
};

export function updateWebSinkControlDetailed<T>(
  workspaceId: string,
  change: (state: WebSinkControlState | null) => {
    state: WebSinkControlState;
    result: T;
    noWrite?: boolean;
  },
): WebSinkControlUpdateResult<T> {
  assertWorkspaceId(workspaceId);
  const file = webSinkControlFile(workspaceId);
  const marker = webSinkControlInitializedFile(workspaceId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  let lockFd: number | null = null;
  try {
    lockFd = fs.openSync(lock, "wx");
  } catch {
    throw new WebSinkControlError("WEB_SINK_LOCK_BUSY", "web sink binding 状态锁被占用。");
  }
  try {
    fs.writeFileSync(lockFd, `${process.pid}\n${new Date().toISOString()}\n`);
    fs.fsyncSync(lockFd);

    const previous = readWebSinkControl(workspaceId);
    const next = change(previous);
    const validated = parseWebSinkControlState(next.state);
    if (validated.workspaceId !== workspaceId) throw corrupt();

    if (next.noWrite) {
      if (!previous) {
        throw new WebSinkControlError(
          "WEB_SINK_STATE_CORRUPT",
          "noWrite 要求已存在 durable state；拒绝无状态成功。",
        );
      }
      if (JSON.stringify(validated) !== JSON.stringify(previous)) {
        throw new WebSinkControlError("WEB_SINK_STATE_CORRUPT", "noWrite 状态与 previous 不一致。");
      }
      return { result: next.result, noWrite: true, state: validated };
    }
    if (previous && validated.revision !== previous.revision + 1) throw corrupt();
    if (!previous && validated.revision !== 1) throw corrupt();

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

export function nextWebSinkEpoch(current: number): number {
  if (current >= MAX_EPOCH) {
    throw new WebSinkControlError("WEB_SINK_EPOCH_OVERFLOW", "web sink binding epoch 已达上限。");
  }
  return current + 1;
}

export { MAX_EPOCH as WEB_SINK_MAX_EPOCH };
