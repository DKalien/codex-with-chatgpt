import { areChatgptConversationRoutesEquivalent } from "./route-esm.js";

/**
 * Pure ownership reducer for Edge/Chromium MV3 companion.
 * Browser-safe: no Chrome APIs, no DOM. Injectable for unit tests.
 */

/**
 * @typedef {Object} DocumentIdentity
 * @property {number} tabId
 * @property {string} documentId
 * @property {string} canonicalRoute
 * @property {number} generation
 * @property {number} lastSeen
 */

/**
 * @typedef {Object} OwnerState
 * @property {number} schemaVersion
 * @property {string|null} targetRoute
 * @property {DocumentIdentity|null} owner
 * @property {DocumentIdentity[]} registry
 */

export const OWNERSHIP_SCHEMA_VERSION = 1;

/**
 * Resolve document identity from MessageSender only.
 * Missing documentId is fail-closed: observe-only, never bind/owner.
 * @param {{ tab?: { id?: number }, frameId?: number, documentId?: string }} sender
 */
export function resolveSenderDocumentIdentity(sender) {
  if (!sender || sender.tab == null || typeof sender.tab.id !== "number") {
    return { ok: false, reason: "no_tab" };
  }
  if (sender.frameId !== undefined && sender.frameId !== 0) {
    return { ok: false, reason: "subframe" };
  }
  const documentId = sender.documentId;
  if (typeof documentId !== "string" || documentId.length === 0) {
    return {
      ok: false,
      reason: "document_id_unavailable",
      tabId: sender.tab.id,
      // No synthetic identity — caller may observe but must not bind.
    };
  }
  return { ok: true, tabId: sender.tab.id, documentId, frameId: 0 };
}

/** @returns {OwnerState} */
export function emptyOwnerState() {
  return {
    schemaVersion: OWNERSHIP_SCHEMA_VERSION,
    targetRoute: null,
    owner: null,
    registry: [],
  };
}

/**
 * @param {OwnerState} state
 * @returns {OwnerState}
 */
export function resetSessionOwnership(state) {
  return {
    schemaVersion: OWNERSHIP_SCHEMA_VERSION,
    targetRoute: state.targetRoute,
    owner: null,
    registry: [],
  };
}

function identityKey(doc) {
  return `${doc.tabId}:${doc.documentId}`;
}

function sameDocument(a, b) {
  if (!a || !b) return false;
  return a.tabId === b.tabId && a.documentId === b.documentId;
}

function isLive(doc, now, ttlMs) {
  return now - doc.lastSeen <= ttlMs;
}

/**
 * @param {OwnerState} state
 * @param {DocumentIdentity} observation
 * @param {{ now?: number, ttlMs?: number }} [opts]
 */
export function observeDocument(state, observation, opts = {}) {
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? 30_000;
  const registry = state.registry.filter((d) => isLive(d, now, ttlMs));
  const nextDoc = {
    ...observation,
    lastSeen: now,
  };
  const idx = registry.findIndex((d) => sameDocument(d, nextDoc));
  if (idx >= 0) registry[idx] = nextDoc;
  else registry.push(nextDoc);

  let owner = state.owner;
  if (owner && !sameDocument(owner, nextDoc)) {
    // another document speaking; owner stays until invalidated
  }
  if (owner && sameDocument(owner, nextDoc)) {
    // same document route change invalidates
    if (!areChatgptConversationRoutesEquivalent(owner.canonicalRoute, nextDoc.canonicalRoute)) {
      owner = null;
    } else {
      owner = { ...nextDoc };
    }
  }
  return { ...state, owner, registry };
}

/**
 * Explicit bind of CURRENT document as owner for targetRoute.
 * Fails closed if observation is not a valid matching document.
 * @returns {{ ok: true, state: OwnerState } | { ok: false, reason: string, state: OwnerState }}
 */
export function bindOwner(state, observation, targetRoute) {
  if (!targetRoute || typeof targetRoute !== "string") {
    return { ok: false, reason: "target_route_required", state };
  }
  if (!observation || typeof observation.tabId !== "number" || observation.tabId < 0) {
    return { ok: false, reason: "invalid_tab", state };
  }
  if (!observation.documentId || typeof observation.documentId !== "string") {
    return { ok: false, reason: "document_id_required", state };
  }
  if (observation.frameId !== undefined && observation.frameId !== 0) {
    return { ok: false, reason: "subframe_forbidden", state };
  }
  if (!areChatgptConversationRoutesEquivalent(observation.canonicalRoute, targetRoute)) {
    return { ok: false, reason: "route_mismatch", state };
  }
  // second tab does not silently steal: require explicit bind which replaces owner
  const next = observeDocument(state, {
    tabId: observation.tabId,
    documentId: observation.documentId,
    canonicalRoute: observation.canonicalRoute,
    generation: observation.generation ?? 1,
    lastSeen: observation.lastSeen ?? Date.now(),
  }, { now: observation.lastSeen });
  return {
    ok: true,
    state: {
      ...next,
      targetRoute,
      owner: {
        tabId: observation.tabId,
        documentId: observation.documentId,
        canonicalRoute: targetRoute,
        generation: observation.generation ?? 1,
        lastSeen: observation.lastSeen ?? Date.now(),
      },
    },
  };
}

/**
 * Navigation / route change on a document invalidates ownership if it leaves target.
 */
export function invalidateOnRouteChange(state, tabId, documentId, newCanonicalRoute) {
  if (!state.owner) return state;
  if (state.owner.tabId !== tabId || state.owner.documentId !== documentId) {
    return state;
  }
  if (newCanonicalRoute && newCanonicalRoute !== state.targetRoute) {
    return { ...state, owner: null };
  }
  if (!newCanonicalRoute) {
    return { ...state, owner: null };
  }
  return state;
}

/** Tab removed → owner invalid; new tab id must never inherit. */
export function invalidateOnTabRemoved(state, tabId) {
  return {
    ...state,
    registry: state.registry.filter((d) => d.tabId !== tabId),
    owner: state.owner && state.owner.tabId === tabId ? null : state.owner,
  };
}

/** Document replaced (reload) → new documentId does not inherit old authorization. */
export function invalidateOnDocumentChanged(state, tabId, oldDocumentId, newDocumentId) {
  if (!state.owner) return state;
  if (state.owner.tabId !== tabId) return state;
  if (state.owner.documentId === oldDocumentId && newDocumentId && newDocumentId !== oldDocumentId) {
    return { ...state, owner: null };
  }
  return state;
}

/** Is this exact document currently the authorized owner? */
export function isOwner(state, tabId, documentId) {
  return Boolean(
    state.owner
    && state.owner.tabId === tabId
    && state.owner.documentId === documentId,
  );
}

/**
 * Apply a passive observe against ownership.
 * - same tab + different real documentId → invalidate old owner (reload)
 * - owner tab later missing documentId → fail closed, clear owner
 * - same document route change away from target → invalidate
 */
export function applyObserveOwnership(state, input) {
  const {
    tabId,
    documentId = null,
    canonicalRoute = null,
    generation = 1,
    now = Date.now(),
  } = input;
  let next = state;

  if (documentId == null) {
    // Fail closed: cannot trust a document-less sender on the owner tab.
    if (next.owner && next.owner.tabId === tabId) {
      next = { ...next, owner: null };
    }
    return next;
  }

  if (canonicalRoute) {
    next = observeDocument(next, {
      tabId,
      documentId,
      canonicalRoute,
      generation,
      lastSeen: now,
    });
    // Reload / new document on same tab must not leave a ghost owner.
    if (
      next.owner
      && next.owner.tabId === tabId
      && next.owner.documentId !== documentId
    ) {
      next = invalidateOnDocumentChanged(next, tabId, next.owner.documentId, documentId);
    }
    if (
      next.owner
      && next.owner.tabId === tabId
      && next.owner.documentId === documentId
      && !areChatgptConversationRoutesEquivalent(next.owner.canonicalRoute, canonicalRoute)
    ) {
      next = invalidateOnRouteChange(next, tabId, documentId, canonicalRoute);
    }
  } else if (next.owner && next.owner.tabId === tabId) {
    next = invalidateOnRouteChange(next, tabId, documentId, null);
  }
  return next;
}

export function ownerStatus(state, tabId, documentId) {
  return {
    targetRoute: state.targetRoute,
    hasOwner: Boolean(state.owner),
    isOwner: isOwner(state, tabId, documentId),
    owner: state.owner
      ? {
          tabId: state.owner.tabId,
          documentId: state.owner.documentId,
          canonicalRoute: state.owner.canonicalRoute,
          generation: state.owner.generation,
        }
      : null,
    registrySize: state.registry.length,
  };
}
