import { z } from "zod";
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
    feedbackStatus: z.enum(["pending", "sent"]).optional(),
  }).strict()).max(10000),
  generatedMessageIds: z.array(messageId).max(20000),
  activeCommand: z.object({
    command: controlCommandSchema, taskId: controlId, iteration: z.number().int().nonnegative(),
    rootGoal: z.string().min(1).max(8192), userMessageId: messageId,
  }).strict().optional(),
}).strict().superRefine((state, ctx) => {
  for (const [i, receipt] of state.seenCommands.entries()) {
    if (receipt.feedbackMessageId && receipt.feedbackStatus !== undefined && receipt.feedbackStatus !== "sent") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["seenCommands", i, "feedbackStatus"], message: "feedbackMessageId 必须对应 sent" });
    }
    if (receipt.feedbackStatus === "sent" && !receipt.feedbackMessageId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["seenCommands", i, "feedbackMessageId"], message: "sent 必须有 feedbackMessageId" });
    }
  }
});
export type WebControlState = z.infer<typeof webControlStateSchema>;

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

export function validateWebControl(session: SavedSession): void {
  if (session.webControl !== undefined && !webControlStateSchema.safeParse(session.webControl).success) {
    throw new Error("网页控制状态损坏，拒绝操作；请保留会话文件并人工恢复防重放历史。");
  }
}

/** Structural fingerprint check shared by normalization and session operations. */
export function isProjectChatFingerprint(value: unknown): value is string {
  return typeof value === "string" && PROJECT_CHAT_FP.test(value);
}

export function normalizeProjectChatEntry(input: unknown): ProjectChatEntry | null {
  if (!input || typeof input !== "object") return null;
  const fp = (input as { ownerFingerprint?: unknown }).ownerFingerprint;
  const url = (input as { url?: unknown }).url;
  if (!isProjectChatFingerprint(fp)) return null;
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
    if (!entry || seen.has(entry.ownerFingerprint)) {
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
    if (!isProjectChatFingerprint(session.chatOwnerFingerprint)) {
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
