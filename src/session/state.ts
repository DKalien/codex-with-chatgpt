import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";
import { CONTROL_KINDS } from "./control-protocol.js";

const controlId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const messageId = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const controlCommandSchema = z.object({
  state: z.literal("COMMAND"), controlSessionId: controlId, workspaceId: controlId, commandId: controlId,
  kind: z.enum(CONTROL_KINDS), goal: z.string().min(1).max(8192),
  instructions: z.string().min(1).max(8192), successCriteria: z.string().min(1).max(8192),
}).strict();
export const webControlStateSchema = z.object({
  version: z.literal(1), enabled: z.boolean(), controlSessionId: controlId, workspaceId: controlId,
  codexSessionId: controlId, conversationUrl: z.string().url(),
  createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
  idleTimeoutMinutes: z.number().int().min(1).max(240),
  status: z.enum(["starting", "waiting", "accepted", "executing", "review", "disabled", "expired"]),
  bootMessageId: messageId.optional(),
  // 不丢弃旧 ID；达到上限时停止接单，避免历史淘汰重新打开 replay 窗口。
  seenCommands: z.array(z.object({
    commandId: controlId, controlSessionId: controlId,
    status: z.enum(["accepted", "executing", "completed", "rejected"]),
    updatedAt: z.string().datetime(), reason: z.string().max(500).optional(),
    userMessageId: messageId.optional(), assistantMessageId: messageId.optional(),
    feedbackMessageId: messageId.optional(),
  }).strict()).max(10000),
  generatedMessageIds: z.array(messageId).max(20000),
  activeCommand: z.object({
    command: controlCommandSchema, taskId: controlId, iteration: z.number().int().nonnegative(),
    rootGoal: z.string().min(1).max(8192), userMessageId: messageId,
  }).strict().optional(),
}).strict();
export type WebControlState = z.infer<typeof webControlStateSchema>;

function validateWebControl(session: SavedSession): void {
  if (session.webControl !== undefined && !webControlStateSchema.safeParse(session.webControl).success) {
    throw new Error("网页控制状态损坏，拒绝操作；请保留会话文件并人工恢复防重放历史。");
  }
}

export type ConversationMode = "long-chat" | "project";

export type ConversationReason = "existing-long-chat" | "project" | "new-workspace";

export type ProtocolState =
  | "INIT"
  | "PLAN_RECEIVED"
  | "EXECUTING"
  | "EXECUTED_LOCAL"
  | "EXECUTED_SENT"
  | "DONE"
  | "BLOCKED";

export type WaitingFor = "none" | "GPT_PLAN" | "GPT_REVIEW" | "USER";

export const PROTOCOL_STATES: readonly ProtocolState[] = [
  "INIT",
  "PLAN_RECEIVED",
  "EXECUTING",
  "EXECUTED_LOCAL",
  "EXECUTED_SENT",
  "DONE",
  "BLOCKED",
];

export const WAITING_FOR: readonly WaitingFor[] = ["none", "GPT_PLAN", "GPT_REVIEW", "USER"];

export interface TaskCheckpoint {
  taskId: string;
  iteration: number;
  protocolState: ProtocolState;
  waitingFor: WaitingFor;
  originalGoal?: string;
  completedSubtasks?: string;
  knownIssues?: string;
  nextExpectedStep?: string;
  chatUrl?: string;
  projectUrl?: string;
  updatedAt: string;
}

export interface SavedSession {
  url?: string;
  title?: string;
  taskId?: string;
  iteration?: number;
  lastState?: string;
  savedAt: string;
  conversationMode?: ConversationMode;
  projectUrl?: string;
  connectorName?: string;
  checkpoint?: TaskCheckpoint;
  webControl?: WebControlState;
}

export interface SessionPatch {
  url?: string;
  title?: string;
  taskId?: string;
  iteration?: number;
  lastState?: string;
  conversationMode?: ConversationMode;
  projectUrl?: string;
  connectorName?: string;
  checkpoint?: Partial<TaskCheckpoint> & { protocolState?: ProtocolState };
  clearCheckpoint?: boolean;
}

export interface ConversationView {
  mode: ConversationMode;
  reason: ConversationReason;
  projectUrl: string | null;
  projectReady: boolean;
  chatUrl: string | null;
  connectorName: string | null;
  /** long-chat: Skill may goto chatUrl. project: only if THIS Codex thread already bound it. */
  reuseSavedChat: boolean;
}

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

export function normalizeProjectUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.hostname !== "chatgpt.com" && parsed.hostname !== "www.chatgpt.com") return null;
    const match = parsed.pathname.match(/^\/g\/(g-p-[a-zA-Z0-9]+)\/project\/?$/);
    if (!match) return null;
    return `https://chatgpt.com/g/${match[1]}/project`;
  } catch {
    return null;
  }
}

export function projectIdFromUrl(url: string): string | null {
  const normalized = normalizeProjectUrl(url);
  if (!normalized) return null;
  return normalized.match(/\/g\/(g-p-[a-zA-Z0-9]+)\/project/)?.[1] ?? null;
}

export function resolveConversation(session: SavedSession | null): ConversationView {
  if (!session) {
    return {
      mode: "project",
      reason: "new-workspace",
      projectUrl: null,
      projectReady: false,
      chatUrl: null,
      connectorName: null,
      reuseSavedChat: false,
    };
  }

  const projectUrl = session.projectUrl ? normalizeProjectUrl(session.projectUrl) : null;
  const projectReady = Boolean(projectUrl);

  if (session.conversationMode === "long-chat") {
    return {
      mode: "long-chat",
      reason: "existing-long-chat",
      projectUrl: null,
      projectReady: false,
      chatUrl: session.url ?? null,
      connectorName: session.connectorName ?? null,
      reuseSavedChat: Boolean(session.url),
    };
  }

  if (session.conversationMode === "project" || projectReady) {
    return {
      mode: "project",
      reason: "project",
      projectUrl,
      projectReady,
      chatUrl: session.url ?? null,
      connectorName: session.connectorName ?? null,
      reuseSavedChat: false,
    };
  }

  return {
    mode: "long-chat",
    reason: "existing-long-chat",
    projectUrl: null,
    projectReady: false,
    chatUrl: session.url ?? null,
    connectorName: session.connectorName ?? null,
    reuseSavedChat: Boolean(session.url),
  };
}

const CHECKPOINT_LIMITS = {
  originalGoal: 500,
  completedSubtasks: 800,
  knownIssues: 800,
  nextExpectedStep: 400,
} as const;

function capCheckpointText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export function mergeSession(previous: SavedSession | null, patch: SessionPatch): SavedSession {
  const conversationMode = patch.conversationMode ?? previous?.conversationMode;
  const rawProjectUrl = patch.projectUrl ?? previous?.projectUrl;
  let projectUrl = rawProjectUrl;
  if (rawProjectUrl) {
    const normalized = normalizeProjectUrl(rawProjectUrl);
    if (!normalized) {
      throw new Error("project URL must look like https://chatgpt.com/g/g-p-…/project");
    }
    projectUrl = normalized;
  }

  if (conversationMode === "project" && !projectUrl && !previous?.projectUrl) {
    throw new Error("project mode requires --project-url");
  }

  const url = patch.url ?? previous?.url;
  const hasChat = Boolean(url);
  const hasProject = Boolean(projectUrl);
  const hasTask = Boolean(patch.taskId ?? previous?.taskId);
  const hasCheckpoint = Boolean(patch.checkpoint || patch.clearCheckpoint || previous?.checkpoint);
  if (!hasChat && !hasProject && conversationMode !== "long-chat" && !hasTask && !hasCheckpoint) {
    throw new Error("nothing to save: pass --url, --project-url, or --mode");
  }

  let checkpoint = previous?.checkpoint;
  if (patch.clearCheckpoint) {
    checkpoint = undefined;
  } else if (patch.checkpoint) {
    const taskId = patch.checkpoint.taskId ?? patch.taskId ?? previous?.checkpoint?.taskId ?? previous?.taskId;
    const iteration =
      patch.checkpoint.iteration ??
      patch.iteration ??
      previous?.checkpoint?.iteration ??
      previous?.iteration ??
      0;
    const protocolState = patch.checkpoint.protocolState ?? previous?.checkpoint?.protocolState;
    if (!taskId || !protocolState) {
      throw new Error("checkpoint requires task id and protocol state");
    }
    if (!PROTOCOL_STATES.includes(protocolState)) {
      throw new Error(`protocol-state must be one of ${PROTOCOL_STATES.join(", ")}`);
    }
    const waitingFor = patch.checkpoint.waitingFor ?? previous?.checkpoint?.waitingFor ?? "none";
    if (!WAITING_FOR.includes(waitingFor)) {
      throw new Error(`waiting-for must be one of ${WAITING_FOR.join(", ")}`);
    }
    checkpoint = {
      taskId,
      iteration,
      protocolState,
      waitingFor,
      originalGoal: capCheckpointText(
        patch.checkpoint.originalGoal ?? previous?.checkpoint?.originalGoal,
        CHECKPOINT_LIMITS.originalGoal
      ),
      completedSubtasks: capCheckpointText(
        patch.checkpoint.completedSubtasks ?? previous?.checkpoint?.completedSubtasks,
        CHECKPOINT_LIMITS.completedSubtasks
      ),
      knownIssues: capCheckpointText(
        patch.checkpoint.knownIssues ?? previous?.checkpoint?.knownIssues,
        CHECKPOINT_LIMITS.knownIssues
      ),
      nextExpectedStep: capCheckpointText(
        patch.checkpoint.nextExpectedStep ?? previous?.checkpoint?.nextExpectedStep,
        CHECKPOINT_LIMITS.nextExpectedStep
      ),
      chatUrl: patch.checkpoint.chatUrl ?? previous?.checkpoint?.chatUrl ?? url,
      projectUrl: patch.checkpoint.projectUrl ?? previous?.checkpoint?.projectUrl ?? projectUrl,
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    url,
    title: patch.title ?? previous?.title,
    taskId: patch.taskId ?? previous?.taskId,
    iteration: patch.iteration ?? previous?.iteration,
    lastState: patch.lastState ?? previous?.lastState,
    conversationMode: conversationMode === "project" && projectUrl ? "project" : conversationMode,
    projectUrl,
    connectorName: patch.connectorName ?? previous?.connectorName,
    checkpoint,
    webControl: previous?.webControl,
    savedAt: new Date().toISOString(),
  };
}

/** Drop the current chat pointer. Keep Project binding so the collection stays. */
export function clearChatPointer(workspaceId: string): { cleared: boolean; keptProject: boolean } {
  let result = { cleared: false, keptProject: false };
  updateSession(workspaceId, (previous) => {
    if (!previous) return null;
    const view = resolveConversation(previous);
    result = { cleared: true, keptProject: view.mode === "project" && Boolean(view.projectUrl) };
    if (!result.keptProject && !previous.webControl) return null;
    return {
      ...(result.keptProject ? {
        conversationMode: "project" as const,
        projectUrl: view.projectUrl!, connectorName: previous.connectorName, checkpoint: previous.checkpoint,
      } : {}),
      webControl: previous.webControl ? { ...previous.webControl, enabled: false, status: "disabled" } : undefined,
      savedAt: new Date().toISOString(),
    };
  });
  return result;
}
