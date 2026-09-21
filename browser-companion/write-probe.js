import { areChatgptConversationRoutesEquivalent } from "./route-esm.js";

/**
 * E1b3d2a fixed write-probe contract (pure helpers).
 * Browser-safe. No DOM mutation, no Chrome API, no journal transitions.
 * SW + popup use this; CS runtime uses composer-write-adapter runWriteProbe.
 */

/** Single fixed multiline probe. Callers must never supply arbitrary message. */
export const WRITE_PROBE_MESSAGE = "[C2C_WRITE_PROBE]\nNO_SEND=1\nTOKEN=e1b3d2\n";

/** Popup / extension-internal sender: no tab (content scripts always have sender.tab). */
export function isExtensionInternalSender(sender) {
  if (!sender || typeof sender !== "object") return false;
  return sender.tab == null;
}

/**
 * Resolve mutation-fence canonical route using the companion shared parser.
 * Single semantic source: parseChatgptConversationRoute with uuid + no query/hash.
 * Never falls back to a looser regex. Parser missing → fail closed.
 *
 * @param {string} href
 * @param {((raw: string, opts: object) => { canonical: string })} [parseRoute]
 * @returns {{ ok: true, canonical: string } | { ok: false, reason: string }}
 */
export function resolveMutationCanonicalRoute(href, parseRoute) {
  const parser = typeof parseRoute === "function"
    ? parseRoute
    : (typeof globalThis !== "undefined" ? globalThis.parseChatgptConversationRoute : null);
  if (typeof parser !== "function") {
    return { ok: false, reason: "write_probe_route_parser_missing" };
  }
  try {
    const parsed = parser(href, {
      allowQueryOrHash: false,
      conversationIdPolicy: "uuid",
    });
    if (!parsed || typeof parsed.canonical !== "string" || !parsed.canonical) {
      return { ok: false, reason: "write_probe_route_drift" };
    }
    return { ok: true, canonical: parsed.canonical };
  } catch {
    return { ok: false, reason: "write_probe_route_drift" };
  }
}

/**
 * Thin test/compat helper over the shared parser (no independent pathname regex).
 * @returns {{ canonical: string } | null}
 */
export function parseChatgptRouteStrict(href, parseRoute) {
  const r = resolveMutationCanonicalRoute(href, parseRoute);
  return r.ok ? { canonical: r.canonical } : null;
}

/**
 * Exact-document write-probe request for SW.
 * journalMustBeIdle is enforced by SW before this is called.
 */
export function buildWriteProbeRequest(owner, transport) {
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
  if (typeof owner.generation !== "number" || !Number.isFinite(owner.generation)) {
    return { ok: false, reason: "owner_generation_missing" };
  }
  return {
    ok: true,
    tabId: owner.tabId,
    message: {
      type: "c2c.write.probe.execute",
      expectedRoute: transport.routeCanonical,
      expectedGeneration: owner.generation,
      // Identity for delivery only; payload field is not the documentId authority.
      expectedDocumentId: owner.documentId,
    },
    sendOptions: {
      documentId: owner.documentId,
    },
  };
}

/**
 * Validate CS write-probe response against owner + transport.
 * Success ONLY when ok===true AND wrote===true AND verified===true.
 * Explicit CS failure (ok!==true) is a known failure — preserve reason, never wrap as success.
 * ok===true with wrote/verified not both true is fail-closed inconsistent.
 */
export function validateWriteProbeResponse(response, owner, transport) {
  if (!response || typeof response !== "object") {
    return { ok: false, reason: "malformed_write_probe_response", knownFailure: false };
  }
  if (response.mode !== "write_probe_no_send") {
    return { ok: false, reason: "write_probe_response_invalid", knownFailure: false };
  }
  if (response.noSend !== true) {
    return { ok: false, reason: "write_probe_response_invalid", knownFailure: false };
  }
  const route = transport?.routeCanonical;
  if (!route) return { ok: false, reason: "auth_stale", knownFailure: false };
  if (!areChatgptConversationRoutesEquivalent(response.canonicalRoute, route)) {
    return { ok: false, reason: "write_probe_route_mismatch", knownFailure: false };
  }
  if (typeof owner?.generation === "number") {
    if (!Number.isFinite(response.generation) || Number(response.generation) !== owner.generation) {
      return { ok: false, reason: "write_probe_generation_mismatch", knownFailure: false };
    }
  }

  // Known CS failure: never success. Preserve concrete reason + mutation outcome.
  if (response.ok !== true) {
    const reason = typeof response.reason === "string" && response.reason
      ? response.reason
      : "write_probe_failed";
    return {
      ok: false,
      reason,
      knownFailure: true,
      wrote: response.wrote === true,
      verified: response.verified === true,
      mutationAttempted: response.mutationAttempted === true,
      readback: response.readback && typeof response.readback === "object"
        ? response.readback
        : null,
    };
  }

  // Inconsistent success DTO: fail closed.
  if (response.wrote !== true || response.verified !== true) {
    return {
      ok: false,
      reason: "write_probe_response_inconsistent",
      knownFailure: true,
      wrote: response.wrote === true,
      verified: response.verified === true,
      mutationAttempted: response.mutationAttempted === true,
      readback: response.readback && typeof response.readback === "object"
        ? response.readback
        : null,
    };
  }

  return {
    ok: true,
    knownFailure: false,
    wrote: true,
    verified: true,
    mutationAttempted: response.mutationAttempted === true,
    readback: null,
  };
}
