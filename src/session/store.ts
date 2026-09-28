import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { ensureDir, getStateDir } from "../config/paths.js";
import {
  validateProjectChatState,
  validateWebControl,
  type SavedSession,
} from "./schema.js";

export function sessionFile(workspaceId: string): string {
  return path.join(getStateDir(), "sessions", `${workspaceId}.json`);
}

export function readSession(workspaceId: string): SavedSession | null {
  let session: SavedSession;
  try {
    const text = fs.readFileSync(sessionFile(workspaceId), "utf8");
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        typeof (value as SavedSession).savedAt !== "string") throw new Error("invalid session");
    session = value as SavedSession;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("会话状态无法读取或已损坏，已停止操作。请保留原文件并人工恢复，不能清空防重放记录。");
  }
  validateWebControl(session);
  validateProjectChatState(session);
  return session;
}

export function writeSession(workspaceId: string, session: SavedSession): SavedSession {
  return updateSession(workspaceId, (previous) => ({
    ...session, webControl: previous?.webControl ?? session.webControl,
  }))!;
}

/** 同一个 session 的所有写入共享短锁，避免旧快照覆盖 COMMAND 防重放记录。 */
export function updateSession(
  workspaceId: string,
  change: (previous: SavedSession | null) => SavedSession | null
): SavedSession | null {
  const file = sessionFile(workspaceId);
  ensureDir(path.dirname(file));
  const lock = `${file}.lock`;
  let lockFd: number;
  try {
    lockFd = fs.openSync(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error("会话写锁已存在，拒绝并发操作。异常退出后请先核对 .lock 中的 PID，再人工清除遗留锁；不要删除会话 JSON。");
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    const previous = readSession(workspaceId);
    const next = change(previous);
    if (previous?.webControl && !next?.webControl) throw new Error("不能删除网页控制的防重放历史。");
    if (next) {
      validateWebControl(next);
      validateProjectChatState(next);
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(next, null, 2));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, file);
    } else {
      fs.rmSync(file, { force: true });
    }
    return next;
  } finally {
    try { fs.rmSync(temporary, { force: true }); }
    finally {
      fs.closeSync(lockFd);
      fs.unlinkSync(lock);
    }
  }
}
