import { areChatgptConversationRoutesEquivalent } from "./route-esm.js";

/**
 * E1b3d1 pure shadow RPC contract helpers (SW-only, not content-script).
 * Browser-safe ESM. No Chrome APIs, no DOM, no fetch.
 */

/** Popup / extension-internal sender: no tab (content scripts always have sender.tab). */
export function isExtensionInternalSender(sender) {
  if (!sender || typeof sender !== "object") return false;
  return sender.tab == null;
}

/**
 * Exact document-targeted RPC payload.
 * sendOptions.documentId must be passed as chrome.tabs.sendMessage third argument.
 */
export function buildShadowInspectRequest(owner, transport) {
  if (!owner || typeof owner.tabId !== "number" || !owner.documentId) {
    return { ok: false, reason: "owner_document_invalid" };
  }
  if (!transport || typeof transport.routeCanonical !== "string") {
    return { ok: false, reason: "auth_stale" };
  }
  if (transport.authStale) {
    return { ok: false, reason: "auth_stale" };
  }
  if (!areChatgptConversationRoutesEquivalent(owner.canonicalRoute, transport.routeCanonical)) {
    return { ok: false, reason: "owner_route_mismatch" };
  }
  return {
    ok: true,
    tabId: owner.tabId,
    message: {
      type: "c2c.send.shadow.inspect",
      expectedRoute: transport.routeCanonical,
      expectedDocumentId: owner.documentId,
    },
    // Chromium document-targeted delivery — not a plain payload field.
    sendOptions: {
      documentId: owner.documentId,
    },
  };
}

/** Validate CS shadow evidence against exact owner identity + transport route. */
export function validateShadowInspectResponse(response, owner, transport) {
  if (!response || typeof response !== "object") {
    return { ok: false, reason: "malformed_shadow_response" };
  }
  if (response.mode !== "read_only") {
    return { ok: false, reason: "shadow_response_invalid" };
  }
  const route = transport?.routeCanonical;
  if (!route) return { ok: false, reason: "auth_stale" };
  if (!areChatgptConversationRoutesEquivalent(response.canonicalRoute, route)) {
    return { ok: false, reason: "shadow_route_mismatch" };
  }
  if (response.documentCanonicalRoute && !areChatgptConversationRoutesEquivalent(response.documentCanonicalRoute, route)) {
    return { ok: false, reason: "shadow_route_mismatch" };
  }
  if (typeof owner?.generation === "number") {
    if (!Number.isFinite(response.generation) || Number(response.generation) !== owner.generation) {
      return { ok: false, reason: "shadow_generation_mismatch" };
    }
  }
  return { ok: true };
}
