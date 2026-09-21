/**
 * Browser-safe ChatGPT conversation route parser.
 * No Node-only imports — usable from extension content/service worker and Node.
 *
 * Route is a DELIVERY LOCATOR only. Never derive OAuth principal / openai/session from it.
 */

export type ChatGptConversationRoute = {
  /** Canonical https://chatgpt.com/... form */
  canonical: string;
  /** Conversation id from /c/<id> */
  conversationId: string;
  /** Optional GPT id (g-xxx) when path is /g/g-xxx/c/<id> */
  gptId?: string;
  kind: "conversation" | "gpt-conversation";
};

export class ChatGptRouteError extends Error {
  readonly code = "ROUTE_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "ChatGptRouteError";
  }
}

const LEGACY_CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID_CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GPT_ID = /^g-[A-Za-z0-9_-]+$/;
// ChatGPT Project routes may carry a UI slug after the stable 32-hex project id.
// Only this observed shape is canonicalized; ordinary g-* routes remain exact.
const PROJECT_GPT_ID = /^g-p-([0-9a-f]{32})(?:-[A-Za-z0-9_-]+)?$/i;
const HOSTS = new Set(["chatgpt.com", "www.chatgpt.com"]);
// /c/<id> or /g/g-<id>/c/<id>
const PATH_RE = /^\/(?:g\/(g-[A-Za-z0-9_-]+)\/)?c\/([A-Za-z0-9_-]+)\/?$/;

export type ChatGptConversationIdPolicy = "legacy" | "uuid";

export type ParseChatGptRouteOptions = {
  /**
   * When true, query/hash are stripped (web-control historical behavior).
   * When false (default), query/hash/credentials/port are rejected (companion).
   */
  allowQueryOrHash?: boolean;
  /**
   * legacy: web-control historical [A-Za-z0-9_-]+
   * uuid: E1b0 companion contract until real Project URL shape is verified
   */
  conversationIdPolicy?: ChatGptConversationIdPolicy;
  maxLength?: number;
};

/**
 * Parse and canonicalize a ChatGPT conversation URL.
 * Host canonicalized to chatgpt.com; trailing slash removed; never includes query/hash.
 */
export function parseChatgptConversationRoute(
  raw: string,
  options: ParseChatGptRouteOptions = {},
): ChatGptConversationRoute {
  const maxLength = options.maxLength ?? 2048;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > maxLength) {
    throw new ChatGptRouteError("ChatGPT conversation URL 无效");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ChatGptRouteError("ChatGPT conversation URL 无效");
  }
  if (url.protocol !== "https:") {
    throw new ChatGptRouteError("ChatGPT conversation URL 必须使用 https");
  }
  if (!HOSTS.has(url.hostname.toLowerCase())) {
    throw new ChatGptRouteError("ChatGPT conversation URL 仅支持 chatgpt.com");
  }
  if (url.username || url.password) {
    throw new ChatGptRouteError("ChatGPT conversation URL 不得包含凭据");
  }
  if (url.port) {
    throw new ChatGptRouteError("ChatGPT conversation URL 不得包含端口");
  }
  if (!options.allowQueryOrHash && (url.search || url.hash)) {
    throw new ChatGptRouteError("ChatGPT conversation URL 不得包含 query/hash");
  }
  const match = PATH_RE.exec(url.pathname);
  if (!match) {
    throw new ChatGptRouteError("ChatGPT conversation URL 路径无效");
  }
  const gptRaw = match[1];
  const conversationId = match[2]!;
  const policy = options.conversationIdPolicy ?? "legacy";
  const idOk = policy === "uuid"
    ? UUID_CONVERSATION_ID.test(conversationId)
    : LEGACY_CONVERSATION_ID.test(conversationId);
  if (!idOk) {
    throw new ChatGptRouteError(
      policy === "uuid"
        ? "conversation id 必须为 UUID（companion 合同；真实 Project URL 形态确认前不放宽）"
        : "conversation id 无效",
    );
  }
  if (gptRaw !== undefined && !GPT_ID.test(gptRaw)) {
    throw new ChatGptRouteError("GPT id 无效");
  }
  const projectMatch = gptRaw ? PROJECT_GPT_ID.exec(gptRaw) : undefined;
  const canonicalGptId = projectMatch ? `g-p-${projectMatch[1]!.toLowerCase()}` : gptRaw;
  const path = canonicalGptId
    ? `/g/${canonicalGptId}/c/${conversationId}`
    : `/c/${conversationId}`;
  const canonical = `https://chatgpt.com${path}`;
  return {
    canonical,
    conversationId,
    ...(canonicalGptId ? { gptId: canonicalGptId } : {}),
    kind: gptRaw ? "gpt-conversation" : "conversation",
  };
}

/** Canonical form or throw. Companion-facing: reject query/hash; UUID conversation ids only. */
export function normalizeChatgptConversationRoute(raw: string): string {
  return parseChatgptConversationRoute(raw, {
    allowQueryOrHash: false,
    conversationIdPolicy: "uuid",
  }).canonical;
}

/** Strict route identity comparison; invalid routes are never equivalent. */
export function areChatgptConversationRoutesEquivalent(left: string, right: string): boolean {
  try {
    return normalizeChatgptConversationRoute(left) === normalizeChatgptConversationRoute(right);
  } catch {
    return false;
  }
}

/** Web-control facing: preserve historical query/hash strip + legacy id charset. */
export function normalizeControlConversationUrl(raw: string): string {
  return parseChatgptConversationRoute(raw, {
    allowQueryOrHash: true,
    conversationIdPolicy: "legacy",
  }).canonical;
}

/** True if raw is a valid ChatGPT conversation route (companion-strict). */
export function isChatgptConversationRoute(raw: string): boolean {
  try {
    parseChatgptConversationRoute(raw, {
      allowQueryOrHash: false,
      conversationIdPolicy: "uuid",
    });
    return true;
  } catch {
    return false;
  }
}
