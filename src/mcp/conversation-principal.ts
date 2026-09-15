import { createHash } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

/** 缺 clientId。 */
export const CONVERSATION_PRINCIPAL_MISSING = "PROBE_PRINCIPAL_MISSING";
/** 缺官方 openai/session。 */
export const CHAT_IDENTITY_UNAVAILABLE = "PROBE_CHAT_IDENTITY_UNAVAILABLE";

export class ConversationPrincipalError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ConversationPrincipalError";
  }
}

/** 对话级可信主体；只来自 MCP request extra，不接受 tool args。 */
export interface ConversationPrincipal {
  clientId: string;
  /** 仅官方 `_meta["openai/session"]` 字符串。 */
  conversationKey?: string;
  sessionId?: string;
  fingerprint: string;
  diagnostics: {
    hasClientId: boolean;
    hasConversationKey: boolean;
    hasSessionId: boolean;
    hostMetaKeys: string[];
  };
}

/** fingerprint = hash(clientId + openai/session)；不 hash 整个 _meta。 */
function fingerprintPrincipal(parts: {
  clientId: string;
  conversationKey: string;
}): string {
  const material = JSON.stringify({
    clientId: parts.clientId,
    conversationKey: parts.conversationKey,
  });
  return createHash("sha256").update(material, "utf8").digest("hex").slice(0, 32);
}

function extractConversationKey(meta: Record<string, unknown> | undefined): string | undefined {
  if (!meta) return undefined;
  const value = meta["openai/session"];
  if (typeof value === "string" && value) return value;
  return undefined;
}

/**
 * 只接受官方 `_meta["openai/session"]` 字符串。
 * 禁止 conversationId/threadId/sessionId fallback 与整份 _meta hash。
 */
export function resolveConversationPrincipal(extra: {
  authInfo?: AuthInfo | undefined;
  sessionId?: string;
  _meta?: unknown;
}): ConversationPrincipal {
  const clientId = extra.authInfo?.clientId;
  if (!clientId || typeof clientId !== "string") {
    throw new ConversationPrincipalError(
      CONVERSATION_PRINCIPAL_MISSING,
      "缺少可信 OAuth clientId；拒绝探针操作",
    );
  }
  const sessionId = typeof extra.sessionId === "string" && extra.sessionId ? extra.sessionId : undefined;
  const meta = (extra._meta && typeof extra._meta === "object" && !Array.isArray(extra._meta))
    ? extra._meta as Record<string, unknown>
    : undefined;
  const hostMetaKeys = meta ? Object.keys(meta).sort() : [];
  const conversationKey = extractConversationKey(meta);
  const fingerprint = conversationKey
    ? fingerprintPrincipal({ clientId, conversationKey })
    : fingerprintPrincipal({ clientId, conversationKey: "" });
  return {
    clientId,
    ...(conversationKey ? { conversationKey } : {}),
    ...(sessionId ? { sessionId } : {}),
    fingerprint,
    diagnostics: {
      hasClientId: true,
      hasConversationKey: Boolean(conversationKey),
      hasSessionId: Boolean(sessionId),
      hostMetaKeys,
    },
  };
}

/** 缺 openai/session 时 fail closed；不得退化为仅 clientId。 */
export function requireConversationPrincipal(principal: ConversationPrincipal): void {
  if (!principal.conversationKey) {
    throw new ConversationPrincipalError(
      CHAT_IDENTITY_UNAVAILABLE,
      "缺少官方 _meta[\"openai/session\"]；拒绝探针主体操作",
    );
  }
}
