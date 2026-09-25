import { parseChatgptConversationRoute } from "./route-esm.js";

/**
 * Bridge origin parser (browser-safe).
 * Production: HTTPS origin only. Dev: loopback HTTP only.
 */

export class BridgeOriginError extends Error {
  constructor(message) {
    super(message);
    this.name = "BridgeOriginError";
    this.code = "BRIDGE_ORIGIN_INVALID";
  }
}

/** Mounted Bridge companion router prefix. Keep in sync with src/bridge/server.ts. */
export const COMPANION_API_PREFIX = "/api/companion/v1";

const FEEDBACK_ENDPOINTS = new Set([
  "/pair",
  "/rebind/init",
  "/rebind/complete",
  "/rebind/status",
  "/state",
  "/reserve",
  "/release",
  "/begin-send",
  "/ack",
  "/retire-unknown",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function feedbackEndpointPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096 || /[#\\]/.test(path)) {
    throw new BridgeOriginError("仅允许 Browser Companion feedback API endpoint");
  }
  const raw = path.startsWith("/") ? path : `/${path}`;
  const queryAt = raw.indexOf("?");
  const pathname = queryAt < 0 ? raw : raw.slice(0, queryAt);
  const query = queryAt < 0 ? "" : raw.slice(queryAt);
  const endpoint = pathname.startsWith(`${COMPANION_API_PREFIX}/`)
    ? pathname.slice(COMPANION_API_PREFIX.length)
    : pathname;

  if (pathname.includes("%") || !FEEDBACK_ENDPOINTS.has(endpoint)) {
    throw new BridgeOriginError("仅允许 Browser Companion feedback API endpoint");
  }
  if (endpoint !== "/rebind/status") {
    if (query) throw new BridgeOriginError("feedback API endpoint 不接受 query");
    return `${COMPANION_API_PREFIX}${endpoint}`;
  }
  if (!query) throw new BridgeOriginError("rebind/status query 无效");

  const match = /^\?routeCanonical=([^&]+)&challengeId=([^&]+)$/.exec(query);
  if (!match) throw new BridgeOriginError("rebind/status query 无效");
  let routeCanonical;
  let challengeId;
  try {
    routeCanonical = decodeURIComponent(match[1]);
    challengeId = decodeURIComponent(match[2]);
  } catch {
    throw new BridgeOriginError("rebind/status query 无效");
  }
  if (!UUID.test(challengeId)
      || encodeURIComponent(routeCanonical) !== match[1]
      || encodeURIComponent(challengeId) !== match[2]) {
    throw new BridgeOriginError("rebind/status query 无效");
  }
  let parsedRouteCanonical;
  try {
    parsedRouteCanonical = parseChatgptConversationRoute(routeCanonical, {
      allowQueryOrHash: false,
      conversationIdPolicy: "uuid",
    }).canonical;
  } catch {
    throw new BridgeOriginError("rebind/status query 无效");
  }
  if (parsedRouteCanonical !== routeCanonical) {
    throw new BridgeOriginError("rebind/status query 无效");
  }
  return `${COMPANION_API_PREFIX}${endpoint}${query}`;
}

/**
 * @param {string} raw
 * @param {{ allowLoopbackHttp?: boolean }} [opts]
 * @returns {string} canonical origin https://host[:port] or http://127.0.0.1:port
 */
export function parseBridgeOrigin(raw, opts = {}) {
  if (typeof raw !== "string" || !raw || raw.length > 512) {
    throw new BridgeOriginError("Bridge origin 无效");
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new BridgeOriginError("Bridge origin 无效");
  }
  if (url.username || url.password) {
    throw new BridgeOriginError("Bridge origin 不得包含凭据");
  }
  if (url.search || url.hash) {
    throw new BridgeOriginError("Bridge origin 不得包含 query/hash");
  }
  if (url.pathname && url.pathname !== "/") {
    throw new BridgeOriginError("Bridge origin 仅允许 origin，不得包含 path");
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol === "https:") {
    return url.port
      ? `https://${host}:${url.port}`
      : `https://${host}`;
  }
  if (url.protocol === "http:") {
    const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
    if (!loopback || !opts.allowLoopbackHttp) {
      throw new BridgeOriginError("仅允许 HTTPS Bridge origin（开发可显式允许 loopback HTTP）");
    }
    return url.port
      ? `http://${host}:${url.port}`
      : `http://${host}`;
  }
  throw new BridgeOriginError("Bridge origin 协议无效");
}

/**
 * Build an allowlisted feedback Companion API URL under /api/companion/v1.
 * Callers pass fixed endpoints; /rebind/status accepts only its existing bounded query.
 * Idempotent if path already includes the prefix.
 */
export function companionApiUrl(origin, path) {
  const base = parseBridgeOrigin(origin, {
    allowLoopbackHttp: typeof origin === "string" && origin.startsWith("http://"),
  });
  return `${base}${feedbackEndpointPath(path)}`;
}
