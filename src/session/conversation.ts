import { createHash } from "node:crypto";
import { normalizeControlConversationUrl } from "../chatgpt/route.js";
import {
  normalizeProjectChats,
  type ConversationMode,
  type ConversationReason,
  type ProjectChatBinding,
  type SavedSession,
} from "./schema.js";

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
