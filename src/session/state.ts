import path from "node:path";
import fs from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";
import { CONTROL_KINDS } from "./control-protocol.js";
import { normalizeControlConversationUrl } from "../chatgpt/route.js";

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
    feedbackStatus: z.enum(["pending", "sent"]).optional(),
  }).strict()).max(10000),
  generatedMessageIds: z.array(messageId).max(20000),
  activeCommand: z.object({
    command: controlCommandSchema, taskId: controlId, iteration: z.number().int().nonnegative(),
    rootGoal: z.string().min(1).max(8192), userMessageId: messageId,
  }).strict().optional(),
}).strict().superRefine((state, ctx) => {
  for (const [i, receipt] of state.seenCommands.entries()) {
    if (receipt.feedbackMessageId && receipt.feedbackStatus !== undefined && receipt.feedbackStatus !== "sent") ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["seenCommands", i, "feedbackStatus"], message: "feedbackMessageId 必须对应 sent" });
    if (receipt.feedbackStatus === "sent" && !receipt.feedbackMessageId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["seenCommands", i, "feedbackMessageId"], message: "sent 必须有 feedbackMessageId" });
  }
});
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
  /**
   * Latest Project chat ownership fingerprint (legacy pointer).
   * Project readiness truth is projectChats[] — not this single field.
   * Not an authorization credential.
   */
  chatOwnerFingerprint?: string;
  /**
   * Thread-scoped Project chat map. Key = domain-separated fingerprint.
   * Never stores raw threadId. Bounded; capacity exhaustion fail-closed.
   */
  projectChats?: ProjectChatEntry[];
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
  /** Project-only ownership fingerprint for map upsert; long-chat ignores it. */
  chatOwnerFingerprint?: string;
  /** Explicit thread-scoped chat upsert. null/undefined = no map write. */
  projectChat?: ProjectChatEntry | null;
  checkpoint?: Partial<TaskCheckpoint> & { protocolState?: ProtocolState };
  clearCheckpoint?: boolean;
}

export interface ProjectChatEntry {
  ownerFingerprint: string;
  url: string;
}

export type ProjectChatBinding =
  | "same_thread"
  | "other_thread"
  | "unowned"
  | "none"
  | "current_thread_unknown";

export const PROJECT_CHATS_MAX = 128;
const PROJECT_CHAT_FP = /^[a-f0-9]{64}$/;
const UUID_THREAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAT_OWNER_DOMAIN = "c2c.project-chat-owner.v1";

function normalizeUuid(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return UUID_THREAD.test(trimmed) ? trimmed.toLowerCase() : null;
}

/** Domain-separated fingerprint. Never output raw threadId from readiness. */
export function projectChatOwnerFingerprint(workspaceId: string, threadId: string): string {
  return createHash("sha256")
    .update(CHAT_OWNER_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(workspaceId, "utf8")
    .update("\0", "utf8")
    .update(threadId.trim().toLowerCase(), "utf8")
    .digest("hex");
}

/** Identity-sensitive: invalid UUID or CODEX_SESSION_ID mismatch → null. */
export function currentCodexThreadId(): string | null {
  const thread = normalizeUuid(process.env.CODEX_THREAD_ID);
  if (!thread) return null;
  const sessionRaw = process.env.CODEX_SESSION_ID;
  if (typeof sessionRaw === "string" && sessionRaw.trim() !== "") {
    const session = normalizeUuid(sessionRaw);
    if (!session || session !== thread) return null;
  }
  return thread;
}

export function normalizeProjectChatEntry(input: unknown): ProjectChatEntry | null {
  if (!input || typeof input !== "object") return null;
  const fp = (input as { ownerFingerprint?: unknown }).ownerFingerprint;
  const url = (input as { url?: unknown }).url;
  if (typeof fp !== "string" || !PROJECT_CHAT_FP.test(fp)) return null;
  if (typeof url !== "string" || url.length === 0 || url.length > 512) return null;
  return { ownerFingerprint: fp.toLowerCase(), url };
}

export function normalizeProjectChats(raw: unknown): ProjectChatEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ProjectChatEntry[] = [];
  for (const item of raw) {
    const entry = normalizeProjectChatEntry(item);
    if (!entry || seen.has(entry.ownerFingerprint)) continue;
    seen.add(entry.ownerFingerprint);
    out.push(entry);
  }
  return out;
}

/**
 * Strict durable-state validator. Never silent-normalize.
 * Violations throw — readSession/updateSession must fail closed.
 */
export function parsePersistedProjectChats(raw: unknown): ProjectChatEntry[] | null {
  // Field absent / undefined = legacy no-map. Present null is NOT a valid array → corrupt.
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) {
    throw new Error("会话状态无法读取或已损坏，已停止操作。请保留原文件并人工恢复，不能清空防重放记录。");
  }
  if (raw.length > PROJECT_CHATS_MAX) {
    throw new Error("会话状态无法读取或已损坏，已停止操作。请保留原文件并人工恢复，不能清空防重放记录。");
  }
  const seen = new Set<string>();
  const out: ProjectChatEntry[] = [];
  for (const item of raw) {
    const entry = normalizeProjectChatEntry(item);
    if (!entry) {
      throw new Error("会话状态无法读取或已损坏，已停止操作。请保留原文件并人工恢复，不能清空防重放记录。");
    }
    if (seen.has(entry.ownerFingerprint)) {
      throw new Error("会话状态无法读取或已损坏，已停止操作。请保留原文件并人工恢复，不能清空防重放记录。");
    }
    seen.add(entry.ownerFingerprint);
    out.push(entry);
  }
  return out;
}

export function validateProjectChatState(session: SavedSession): void {
  parsePersistedProjectChats(session.projectChats);
  if (session.chatOwnerFingerprint !== undefined) {
    if (typeof session.chatOwnerFingerprint !== "string" || !PROJECT_CHAT_FP.test(session.chatOwnerFingerprint)) {
      throw new Error("会话状态无法读取或已损坏，已停止操作。请保留原文件并人工恢复，不能清空防重放记录。");
    }
  }
}

/**
 * Upsert one thread-scoped chat. Same fingerprint replaces; other threads kept.
 * Capacity exhaustion fail-closed — never silently drop valid mappings.
 */
export function upsertProjectChat(
  current: ProjectChatEntry[],
  entry: ProjectChatEntry,
): { ok: true; list: ProjectChatEntry[] } | { ok: false; reason: "capacity" | "invalid" } {
  const nextEntry = normalizeProjectChatEntry(entry);
  if (!nextEntry) return { ok: false, reason: "invalid" };
  const list = normalizeProjectChats(current);
  const idx = list.findIndex((item) => item.ownerFingerprint === nextEntry.ownerFingerprint);
  if (idx >= 0) {
    const copy = list.slice();
    copy[idx] = nextEntry;
    return { ok: true, list: copy };
  }
  if (list.length >= PROJECT_CHATS_MAX) return { ok: false, reason: "capacity" };
  return { ok: true, list: [...list, nextEntry] };
}

export function removeProjectChatForFingerprint(
  current: ProjectChatEntry[],
  ownerFingerprint: string,
): { list: ProjectChatEntry[]; removed: ProjectChatEntry | null } {
  const list = normalizeProjectChats(current);
  const idx = list.findIndex((item) => item.ownerFingerprint === ownerFingerprint);
  if (idx < 0) return { list, removed: null };
  const removed = list[idx];
  return { list: list.filter((_, i) => i !== idx), removed };
}

/**
 * Project chat for current Codex thread.
 * Truth is projectChats[] — never bare session.url across threads.
 * url is internal only; readiness JSON must not emit it.
 */
export function projectChatForCurrentThread(session: SavedSession | null, workspaceId: string): {
  binding: ProjectChatBinding;
  url: string | null;
} {
  const view = resolveConversation(session);
  if (view.mode !== "project") return { binding: "none", url: null };
  const maps = normalizeProjectChats(session?.projectChats);
  const legacyUrl = typeof session?.url === "string" && session.url ? session.url : null;
  const threadId = currentCodexThreadId();
  if (!threadId) {
    if (maps.length === 0 && !legacyUrl) return { binding: "none", url: null };
    return { binding: "current_thread_unknown", url: null };
  }
  const fp = projectChatOwnerFingerprint(workspaceId, threadId);
  const hit = maps.find((item) => item.ownerFingerprint === fp);
  if (hit) return { binding: "same_thread", url: hit.url };
  if (maps.length === 0 && !legacyUrl) return { binding: "none", url: null };
  if (maps.length === 0) return { binding: "unowned", url: null };
  return { binding: "other_thread", url: null };
}

/** Bounded binding state only. */
export function projectChatBinding(session: SavedSession | null, workspaceId: string): ProjectChatBinding {
  return projectChatForCurrentThread(session, workspaceId).binding;
}

/** Project chatKnown=true only when same_thread AND URL is a safe conversation route. */
export function conversationChatKnown(session: SavedSession | null, workspaceId: string): {
  mode: ConversationMode | "unknown";
  chatKnown: boolean;
  chatBinding: ProjectChatBinding;
  projectReady: boolean;
} {
  const view = resolveConversation(session);
  if (view.mode === "long-chat") {
    let chatKnown = false;
    if (view.chatUrl) {
      try {
        normalizeControlConversationUrl(view.chatUrl);
        chatKnown = true;
      } catch {
        chatKnown = false;
      }
    }
    return {
      mode: "long-chat",
      chatKnown,
      chatBinding: "none",
      projectReady: false,
    };
  }
  if (view.mode === "project") {
    const lookup = projectChatForCurrentThread(session, workspaceId);
    let chatKnown = false;
    if (lookup.binding === "same_thread" && typeof lookup.url === "string") {
      try {
        normalizeControlConversationUrl(lookup.url);
        chatKnown = true;
      } catch {
        chatKnown = false;
      }
    }
    return {
      mode: "project",
      chatKnown,
      chatBinding: lookup.binding,
      projectReady: view.projectReady,
    };
  }
  return { mode: "unknown", chatKnown: false, chatBinding: "none", projectReady: false };
}

/**
 * Thread-aware navigation projection for Skill/CLI.
 * Project chatUrl ONLY from projectChats same_thread — never session.url fallback.
 * No raw threadId / fingerprint / projectChats / credentials in output.
 */
export interface ThreadConversationProjection {
  mode: ConversationMode;
  projectReady: boolean;
  projectUrl: string | null;
  connectorName: string | null;
  chatBinding: ProjectChatBinding;
  chatUrl: string | null;
  reuseChat: boolean;
}

export function resolveThreadConversation(
  session: SavedSession | null,
  workspaceId: string,
): ThreadConversationProjection {
  const view = resolveConversation(session);
  const connectorName = session?.connectorName ?? view.connectorName ?? null;

  if (view.mode === "long-chat") {
    let chatUrl: string | null = view.chatUrl;
    let reuseChat = Boolean(view.reuseSavedChat && chatUrl);
    if (chatUrl) {
      try {
        chatUrl = normalizeControlConversationUrl(chatUrl);
      } catch {
        chatUrl = null;
        reuseChat = false;
      }
    } else {
      reuseChat = false;
    }
    return {
      mode: "long-chat",
      projectReady: false,
      projectUrl: null,
      connectorName,
      chatBinding: "none",
      chatUrl,
      reuseChat,
    };
  }

  const mode: ConversationMode = "project";
  const chatBinding = projectChatBinding(session, workspaceId);
  const lookup = projectChatForCurrentThread(session, workspaceId);
  let chatUrl: string | null = null;
  let reuseChat = false;
  if (chatBinding === "same_thread" && lookup.binding === "same_thread" && typeof lookup.url === "string") {
    try {
      chatUrl = normalizeControlConversationUrl(lookup.url);
      reuseChat = true;
    } catch {
      chatUrl = null;
      reuseChat = false;
    }
  }
  return {
    mode,
    projectReady: view.mode === "project" ? view.projectReady : false,
    projectUrl: view.projectUrl,
    connectorName,
    chatBinding,
    chatUrl,
    reuseChat,
  };
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

  const isProjectMode = conversationMode === "project" || (Boolean(projectUrl) && conversationMode !== "long-chat");
  // Strict: corrupt persisted projectChats must throw before any merge write.
  const projectChats = parsePersistedProjectChats(previous?.projectChats) ?? [];
  let nextProjectChats = projectChats;
  let chatOwnerFingerprint = previous?.chatOwnerFingerprint
    ? (PROJECT_CHAT_FP.test(previous.chatOwnerFingerprint) ? previous.chatOwnerFingerprint.toLowerCase() : undefined)
    : undefined;

  if (conversationMode === "long-chat") {
    chatOwnerFingerprint = undefined;
  } else if (isProjectMode) {
    const stampedFp = typeof patch.chatOwnerFingerprint === "string" && PROJECT_CHAT_FP.test(patch.chatOwnerFingerprint)
      ? patch.chatOwnerFingerprint.toLowerCase()
      : null;
    const mapEntry = patch.projectChat
      ? normalizeProjectChatEntry(patch.projectChat)
      : (stampedFp && typeof patch.url === "string" && patch.url
        ? { ownerFingerprint: stampedFp, url: patch.url }
        : null);

    if (mapEntry) {
      const upserted = upsertProjectChat(nextProjectChats, mapEntry);
      if (!upserted.ok) {
        throw new Error("project chat map capacity reached; maintenance required before saving another thread chat");
      }
      nextProjectChats = upserted.list;
      chatOwnerFingerprint = mapEntry.ownerFingerprint;
    } else if (patch.url !== undefined) {
      chatOwnerFingerprint = undefined;
    }
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
    chatOwnerFingerprint,
    projectChats: nextProjectChats.length > 0 ? nextProjectChats : undefined,
    checkpoint,
    webControl: previous?.webControl,
    savedAt: new Date().toISOString(),
  };
}

/**
 * Project + known current thread: remove only that thread's mapping.
 * Project + current thread unknown: never guess — clear only non-authoritative latest pointer.
 * Thread A clear must retain Thread B mappings.
 */
export function clearChatPointer(workspaceId: string): { cleared: boolean; keptProject: boolean } {
  let result = { cleared: false, keptProject: false };
  updateSession(workspaceId, (previous) => {
    if (!previous) return null;
    const view = resolveConversation(previous);
    const keptProject = view.mode === "project" && Boolean(view.projectUrl);
    result = { cleared: true, keptProject };
    const maps = normalizeProjectChats(previous.projectChats);
    let nextMaps = maps;
    let nextUrl: string | undefined;
    let nextLatestFp = previous.chatOwnerFingerprint;

    if (!keptProject && !previous.webControl) return null;

    if (keptProject) {
      const threadId = currentCodexThreadId();
      if (threadId) {
        const fp = projectChatOwnerFingerprint(workspaceId, threadId);
        const removal = removeProjectChatForFingerprint(maps, fp);
        nextMaps = removal.list;
        if (removal.removed) {
          // Clear compatibility pointer only if it pointed at this thread's chat.
          if (previous.url === removal.removed.url || previous.chatOwnerFingerprint === fp) {
            nextUrl = undefined;
            nextLatestFp = undefined;
          } else {
            nextUrl = previous.url;
          }
        } else {
          nextUrl = previous.url;
        }
      } else {
        // Unknown current thread: do not delete other threads' owner mappings.
        nextMaps = maps;
        nextUrl = undefined;
        nextLatestFp = undefined;
      }
    }

    return {
      conversationMode: keptProject ? ("project" as const) : previous.conversationMode,
      projectUrl: keptProject ? view.projectUrl! : previous.projectUrl,
      url: keptProject ? nextUrl : undefined,
      connectorName: previous.connectorName,
      checkpoint: keptProject ? previous.checkpoint : previous.checkpoint,
      chatOwnerFingerprint: keptProject ? nextLatestFp : undefined,
      projectChats: keptProject && nextMaps.length > 0 ? nextMaps : (keptProject ? undefined : previous.projectChats),
      webControl: previous.webControl ? { ...previous.webControl, enabled: false, status: "disabled" } : undefined,
      savedAt: new Date().toISOString(),
    };
  });
  return result;
}
