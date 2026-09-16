/**
 * C2C Browser Companion service worker (E1b2 review-fix).
 * All Bridge HTTP + credential storage lives here.
 * Identity always from MessageSender. Secrets never in content script.
 * No begin-send. No Send.
 */

import {
  emptyOwnerState,
  bindOwner,
  invalidateOnTabRemoved,
  isOwner,
  ownerStatus,
  resetSessionOwnership,
  resolveSenderDocumentIdentity,
  applyObserveOwnership,
  OWNERSHIP_SCHEMA_VERSION,
} from "./ownership.js";
import { parseChatgptConversationRoute } from "./route-esm.js";
import { parseBridgeOrigin, companionApiUrl, BridgeOriginError } from "./bridge-origin.js";
import {
  emptyJournal,
  markReserveRequested,
  markReserved,
  markReservationRecovery,
  clearJournal,
  evaluateReserveEligibility,
  validateStateIdentity,
  assertNoForbiddenFields,
  journalActive,
  reconcileReservedJournal,
  pairAllowedWithJournal,
  applyStorageProtectionPolicy,
  wrapFetchResponse,
} from "./reservation-journal.js";
import {
  mintOwnerProof,
  consumeOwnerProof,
  markProofUsed,
  journalBlocksTransportMutation,
} from "./owner-proof.js";

const LOCAL_KEY = "c2c_companion_local_v1";
const TRANSPORT_KEY = "c2c_companion_transport_v1";
const JOURNAL_KEY = "c2c_companion_journal_v1";
const SESSION_OWNER_KEY = "c2c_companion_owner_v1";
const SESSION_REG_KEY = "c2c_companion_registry_v1";
const SESSION_EVIDENCE_KEY = "c2c_companion_evidence_v1";

let localState = { schemaVersion: 1, targetRoute: null, paired: false };
let ownerState = emptyOwnerState();
let transport = null;
let journal = emptyJournal();
let evidence = null;
/** @type {null | ReturnType<typeof mintOwnerProof>} */
let ownerProof = null;
let hydrated = false;
/** Fail closed if TRUSTED_CONTEXTS cannot be established. */
let storageProtected = false;

const initPromise = (async () => {
  await hydrate();
})();

async function restrictStorageLocal() {
  try {
    if (!chrome.storage?.local?.setAccessLevel) return false;
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    return true;
  } catch {
    return false;
  }
}

async function hydrate() {
  if (hydrated) return;
  storageProtected = await restrictStorageLocal();
  const stored = await chrome.storage.local.get([LOCAL_KEY, TRANSPORT_KEY, JOURNAL_KEY]);
  const row = stored[LOCAL_KEY];
  localState = row && typeof row === "object"
    ? {
        schemaVersion: 1,
        targetRoute: typeof row.targetRoute === "string" ? row.targetRoute : null,
        paired: row.paired === true,
      }
    : { schemaVersion: 1, targetRoute: null, paired: false };
  if (!row) await chrome.storage.local.set({ [LOCAL_KEY]: localState });

  const t = stored[TRANSPORT_KEY];
  const policy = applyStorageProtectionPolicy(storageProtected, t);
  if (policy.mustDeleteStoredKey) {
    await chrome.storage.local.remove(TRANSPORT_KEY);
  }
  transport = policy.transport;

  const j = stored[JOURNAL_KEY];
  journal = j && typeof j === "object" && typeof j.state === "string" ? j : emptyJournal();

  const live = await chrome.storage.session.get([
    SESSION_OWNER_KEY,
    SESSION_REG_KEY,
    SESSION_EVIDENCE_KEY,
  ]);
  ownerState = {
    schemaVersion: OWNERSHIP_SCHEMA_VERSION,
    targetRoute: localState.targetRoute,
    owner: live[SESSION_OWNER_KEY] && typeof live[SESSION_OWNER_KEY] === "object"
      ? live[SESSION_OWNER_KEY]
      : null,
    registry: Array.isArray(live[SESSION_REG_KEY]) ? live[SESSION_REG_KEY] : [],
  };
  evidence = live[SESSION_EVIDENCE_KEY] && typeof live[SESSION_EVIDENCE_KEY] === "object"
    ? live[SESSION_EVIDENCE_KEY]
    : null;
  hydrated = true;
}

async function persistLocal() {
  await chrome.storage.local.set({ [LOCAL_KEY]: localState });
}

async function persistTransport() {
  if (!storageProtected) {
    // Never write credential without protection.
    await chrome.storage.local.remove(TRANSPORT_KEY);
    return;
  }
  if (!transport) {
    await chrome.storage.local.remove(TRANSPORT_KEY);
    return;
  }
  await chrome.storage.local.set({ [TRANSPORT_KEY]: transport });
}

async function persistJournal() {
  await chrome.storage.local.set({ [JOURNAL_KEY]: journal });
}

async function persistSessionOwnership() {
  await chrome.storage.session.set({
    [SESSION_OWNER_KEY]: ownerState.owner,
    [SESSION_REG_KEY]: ownerState.registry,
    [SESSION_EVIDENCE_KEY]: evidence,
  });
}

function parseRouteSafe(href) {
  try {
    return parseChatgptConversationRoute(href, {
      allowQueryOrHash: false,
      conversationIdPolicy: "uuid",
    });
  } catch {
    return null;
  }
}

function safeTransportSummary() {
  if (!transport) {
    return {
      connected: false,
      authStale: false,
      storageProtected,
      bridgeOrigin: null,
      workspaceId: null,
      companionId: null,
      bindingId: null,
      epoch: null,
      routeCanonical: null,
      pairedAt: null,
    };
  }
  return {
    connected: !transport.authStale && storageProtected,
    authStale: transport.authStale === true,
    storageProtected,
    bridgeOrigin: transport.bridgeOrigin,
    workspaceId: transport.workspaceId,
    companionId: transport.companionId,
    bindingId: transport.bindingId,
    epoch: transport.epoch,
    routeCanonical: transport.routeCanonical,
    pairedAt: transport.pairedAt,
  };
}

function statusPayload(tabId, documentId, extra = {}) {
  return {
    ok: true,
    targetRoute: localState.targetRoute,
    paired: localState.paired,
    hydrated,
    storageProtected,
    isOwner: documentId != null ? isOwner(ownerState, tabId, documentId) : false,
    ownership: documentId != null
      ? ownerStatus(ownerState, tabId, documentId)
      : ownerStatus(ownerState, -1, ""),
    transport: safeTransportSummary(),
    journal: journalActive(journal)
      ? {
          state: journal.state,
          eventId: journal.eventId,
          reservationId: journal.reservationId,
          routeCanonical: journal.routeCanonical,
        }
      : { state: "NONE" },
    evidence: evidence
      ? {
          observedAt: evidence.observedAt,
          composer: evidence.composer,
          generation: evidence.generation,
          safe: evidence.safe,
          canonicalRoute: evidence.canonicalRoute,
          documentId: evidence.documentId,
          tabId: evidence.tabId,
        }
      : null,
    ...extra,
  };
}

async function fetchCompanion(path, init = {}) {
  if (!storageProtected) throw new Error("storage_unprotected");
  const origin = transport?.bridgeOrigin;
  if (!origin) throw new Error("transport_missing");
  const url = companionApiUrl(origin, path);
  const headers = {
    ...(init.body ? { "content-type": "application/json" } : {}),
    ...(transport ? { authorization: `Bearer ${transport.credential}` } : {}),
    ...(init.headers || {}),
  };
  const res = await fetch(url, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  return wrapFetchResponse(res, body);
}

/** Persist authStale before returning (survives SW restart). */
async function markAuthStale(reason) {
  if (transport) {
    transport = { ...transport, authStale: true };
    await persistTransport();
  }
  return { ok: false, reason, authStale: true };
}

async function unbindAll() {
  localState = { schemaVersion: 1, targetRoute: null, paired: false };
  ownerState = {
    schemaVersion: OWNERSHIP_SCHEMA_VERSION,
    targetRoute: null,
    owner: null,
    registry: [],
  };
  evidence = null;
  ownerProof = null;
  await persistLocal();
  await persistSessionOwnership();
  return statusPayload(-1, null);
}

function requireProtectedTransport() {
  if (!storageProtected) return { ok: false, reason: "storage_unprotected" };
  if (!transport) return { ok: false, reason: "transport_missing" };
  if (transport.authStale) return { ok: false, reason: "auth_stale" };
  return { ok: true };
}

/**
 * Atomically apply current page observation before any owner-gated action.
 * Uses MessageSender + message.href (not stale 800ms poll).
 */
async function refreshPageObservation(sender, message) {
  const identity = resolveSenderDocumentIdentity(sender);
  if (!identity.ok && identity.reason !== "document_id_unavailable") {
    return { ok: false, reason: identity.reason };
  }
  const tabId = identity.ok || identity.reason === "document_id_unavailable" ? identity.tabId : null;
  const documentId = identity.ok ? identity.documentId : null;
  const href = typeof message?.href === "string" ? message.href : sender?.url;
  const parsed = parseRouteSafe(href ?? "");
  const canonical = parsed ? parsed.canonical : null;
  const generation = Number.isFinite(message?.generation) ? Number(message.generation) : 1;

  ownerState = applyObserveOwnership(ownerState, {
    tabId: tabId ?? -1,
    documentId,
    canonicalRoute: canonical,
    generation,
    now: Date.now(),
  });

  if (
    documentId
    && tabId != null
    && isOwner(ownerState, tabId, documentId)
    && message?.safety
  ) {
    evidence = {
      tabId,
      documentId,
      canonicalRoute: canonical,
      observedAt: Date.now(),
      composer: message.safety.composer,
      generation: message.safety.generation,
      safe: message.safety.safe === true,
    };
  } else if (evidence && tabId != null && evidence.tabId === tabId) {
    if (!documentId || evidence.documentId !== documentId || !isOwner(ownerState, tabId, documentId)) {
      evidence = null;
    }
  }

  if (
    ownerProof
    && tabId != null
    && (!documentId || documentId !== ownerProof.documentId || tabId !== ownerProof.tabId)
  ) {
    ownerProof = null;
  }

  await persistSessionOwnership();
  return {
    ok: true,
    tabId,
    documentId,
    canonicalRoute: canonical,
    isOwnerExact: Boolean(
      documentId
      && tabId != null
      && isOwner(ownerState, tabId, documentId)
      && canonical
      && ownerState.owner?.canonicalRoute === canonical,
    ),
  };
}

async function handleMintOwnerProof(sender, message) {
  const refresh = await refreshPageObservation(sender, message);
  if (!refresh.ok) return { ok: false, reason: refresh.reason };
  if (!refresh.isOwnerExact || !refresh.canonicalRoute) {
    return { ok: false, reason: "not_exact_owner" };
  }
  const route = refresh.canonicalRoute;
  ownerProof = mintOwnerProof({
    tabId: refresh.tabId,
    documentId: refresh.documentId,
    routeCanonical: route,
  });
  return {
    ok: true,
    proof: {
      id: ownerProof.id,
      expiresAt: ownerProof.expiresAt,
      routeCanonical: route,
    },
  };
}

async function handlePair(message) {
  if (!storageProtected) return { ok: false, reason: "storage_unprotected" };
  const authStale = transport?.authStale === true;
  if (!pairAllowedWithJournal(journal, authStale)) {
    return { ok: false, reason: "journal_active" };
  }
  if (!ownerState.owner) return { ok: false, reason: "not_exact_owner" };
  const routeCanonical = ownerState.owner.canonicalRoute;

  // Owner proof minted from real MessageSender of owner document.
  const proofCheck = consumeOwnerProof(ownerProof, {
    tabId: ownerState.owner.tabId,
    documentId: ownerState.owner.documentId,
    routeCanonical,
  });
  if (!proofCheck.ok) return { ok: false, reason: proofCheck.reason };
  if (message.ownerProofId !== ownerProof.id) {
    return { ok: false, reason: "owner_proof_mismatch" };
  }
  ownerProof = markProofUsed(ownerProof);

  let origin;
  try {
    origin = parseBridgeOrigin(message.bridgeOrigin, { allowLoopbackHttp: true });
  } catch (e) {
    return { ok: false, reason: e instanceof BridgeOriginError ? "bridge_origin_invalid" : "origin_error" };
  }
  if (typeof message.intentId !== "string" || typeof message.secret !== "string" || !message.secret) {
    return { ok: false, reason: "pairing_input_invalid" };
  }
  try {
    const res = await fetch(companionApiUrl(origin, "/pair"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intentId: message.intentId,
        secret: message.secret,
        routeCanonical,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, reason: body.error || `http_${res.status}`, status: res.status };
    }
    assertNoForbiddenFields(body);
    if (
      body.routeCanonical !== routeCanonical
      || typeof body.credential !== "string"
      || typeof body.workspaceId !== "string"
      || typeof body.companionId !== "string"
      || typeof body.bindingId !== "string"
      || typeof body.epoch !== "number"
    ) {
      return { ok: false, reason: "pair_response_invalid" };
    }
    transport = {
      schemaVersion: 1,
      bridgeOrigin: origin,
      workspaceId: body.workspaceId,
      companionId: body.companionId,
      bindingId: body.bindingId,
      epoch: body.epoch,
      routeCanonical: body.routeCanonical,
      pairedAt: new Date().toISOString(),
      credential: body.credential,
      authStale: false,
    };
    localState = { ...localState, paired: true, targetRoute: routeCanonical };
    await persistTransport();
    await persistLocal();
    return { ok: true, transport: safeTransportSummary() };
  } catch {
    return { ok: false, reason: "network_unreachable" };
  }
}

async function handleFetchState() {
  const gate = requireProtectedTransport();
  if (!gate.ok) return gate;
  try {
    const res = await fetchCompanion("/state", { method: "GET" });
    if (res.status === 401) {
      return markAuthStale(res.body?.error || "COMPANION_UNAUTHORIZED");
    }
    if (res.status === 409 && res.body?.error === "COMPANION_REPAIR_BLOCKED") {
      return { ok: false, reason: "COMPANION_REPAIR_BLOCKED", status: 409 };
    }
    if (!res.ok) {
      return { ok: false, reason: res.body?.error || `http_${res.status}` };
    }
    assertNoForbiddenFields(res.body);
    const idCheck = validateStateIdentity(transport, res.body);
    if (!idCheck.ok) {
      return markAuthStale(idCheck.reason);
    }
    return {
      ok: true,
      status: {
        pendingReady: res.body.pendingReady,
        reserved: res.body.reserved,
        claimed: res.body.claimed,
        outcomeUnknown: res.body.outcomeUnknown,
        inFlight: res.body.inFlight ?? null,
        enabled: res.body.enabled,
      },
    };
  } catch {
    return { ok: false, reason: "network_unreachable" };
  }
}

/** Reserve only from page MessageSender (content → SW) after atomic route refresh. */
async function handleReservePage(sender, message) {
  const gate = requireProtectedTransport();
  if (!gate.ok) return gate;
  const refresh = await refreshPageObservation(sender, message);
  if (!refresh.ok) return { ok: false, reason: refresh.reason };
  if (!refresh.isOwnerExact || !refresh.documentId) {
    return { ok: false, reason: "not_exact_owner" };
  }
  const eligibility = evaluateReserveEligibility({
    transportValid: true,
    authStale: false,
    isOwner: true,
    ownerRoute: ownerState.owner?.canonicalRoute,
    pairedRoute: transport.routeCanonical,
    documentId: refresh.documentId,
    evidence,
    now: Date.now(),
    journal,
  });
  if (!eligibility.ok) return { ok: false, reason: eligibility.reason };

  const routeCanonical = eligibility.routeCanonical;
  journal = markReserveRequested(journal, {
    routeCanonical,
    bindingId: transport.bindingId,
    epoch: transport.epoch,
  });
  await persistJournal();

  let res;
  try {
    res = await fetchCompanion("/reserve", {
      method: "POST",
      body: JSON.stringify({ routeCanonical }),
    });
  } catch {
    journal = markReservationRecovery(journal, { routeCanonical });
    await persistJournal();
    return { ok: false, reason: "network_unreachable", journalState: journal.state };
  }
  if (res.status === 401) {
    journal = markReservationRecovery(journal, { routeCanonical });
    await persistJournal();
    return markAuthStale(res.body?.error || "COMPANION_UNAUTHORIZED");
  }
  if (!res.ok) {
    if (res.status === 404 || res.status === 409) {
      journal = clearJournal();
      await persistJournal();
    } else {
      journal = markReservationRecovery(journal, { routeCanonical });
      await persistJournal();
    }
    return { ok: false, reason: res.body?.error || `http_${res.status}`, status: res.status };
  }
  assertNoForbiddenFields(res.body);
  const eventId = res.body?.delivery?.eventId;
  const reservationId = res.body?.reservationId;
  if (
    typeof eventId !== "string"
    || typeof reservationId !== "string"
    || res.body.delivery?.status !== "reserved"
  ) {
    journal = markReservationRecovery(journal, { routeCanonical });
    await persistJournal();
    return { ok: false, reason: "reserve_response_invalid", journalState: journal.state };
  }
  journal = markReserved(journal, {
    eventId,
    reservationId,
    routeCanonical,
    bindingId: transport.bindingId,
    epoch: transport.epoch,
  });
  await persistJournal();
  return {
    ok: true,
    eventId,
    reservationId,
    journal: { state: journal.state, eventId, reservationId },
  };
}

async function handleRelease() {
  const gate = requireProtectedTransport();
  if (!gate.ok) return gate;
  if (journal.state !== "RESERVED" || !journal.eventId || !journal.reservationId) {
    return { ok: false, reason: "no_local_reservation" };
  }
  let res;
  try {
    res = await fetchCompanion("/release", {
      method: "POST",
      body: JSON.stringify({
        routeCanonical: journal.routeCanonical,
        eventId: journal.eventId,
        reservationId: journal.reservationId,
      }),
    });
  } catch {
    return { ok: false, reason: "network_unreachable" };
  }
  if (res.status === 401) return markAuthStale(res.body?.error || "COMPANION_UNAUTHORIZED");
  if (res.ok) {
    journal = clearJournal();
    await persistJournal();
    return { ok: true, journal: { state: "NONE" } };
  }
  return { ok: false, reason: res.body?.error || `http_${res.status}`, status: res.status };
}

async function handleRecover() {
  const stateRes = await handleFetchState();
  if (!stateRes.ok) return stateRes;
  const inFlight = stateRes.status.inFlight;

  // RESERVED: server is authority for whether reservation still exists.
  if (journal.state === "RESERVED") {
    const rec = reconcileReservedJournal(journal, inFlight);
    if (rec.action === "clear") {
      journal = rec.journal;
      await persistJournal();
      return { ok: true, recovered: true, journal: { state: "NONE" } };
    }
    if (rec.action === "keep") {
      return {
        ok: true,
        recovered: false,
        journal: {
          state: journal.state,
          eventId: journal.eventId,
          reservationId: journal.reservationId,
        },
        inFlight,
      };
    }
    return { ok: false, reason: rec.reason || "inflight_conflict", journalState: journal.state };
  }

  if (journal.state === "RESERVATION_RECOVERY" || journal.state === "RESERVE_REQUESTED") {
    if (inFlight?.status === "reserved" && inFlight.reservationId && inFlight.eventId) {
      journal = markReserved(journal, {
        eventId: inFlight.eventId,
        reservationId: inFlight.reservationId,
        routeCanonical: transport.routeCanonical,
        bindingId: transport.bindingId,
        epoch: transport.epoch,
      });
      await persistJournal();
      return {
        ok: true,
        recovered: true,
        journal: {
          state: journal.state,
          eventId: journal.eventId,
          reservationId: journal.reservationId,
        },
      };
    }
    if (!inFlight) {
      journal = clearJournal();
      await persistJournal();
      return { ok: true, recovered: false, journal: { state: "NONE" } };
    }
  }
  return { ok: true, recovered: false, journal: { state: journal.state }, inFlight };
}

async function handleClearTransport() {
  if (journalBlocksTransportMutation(journal)) {
    return { ok: false, reason: "journal_active", journalState: journal.state };
  }
  transport = null;
  await persistTransport();
  return { ok: true, journal: { state: journal.state } };
}

async function handleMessage(message, sender) {
  await initPromise;
  if (!message || typeof message !== "object") return { ok: false, reason: "bad_message" };

  if (message.type === "c2c.unbind") return unbindAll();
  if (message.type === "c2c.owner-proof.request") return handleMintOwnerProof(sender, message);
  if (message.type === "c2c.pair") return handlePair(message);
  if (message.type === "c2c.transport.status") {
    return {
      ok: true,
      storageProtected,
      transport: safeTransportSummary(),
      journal: journalActive(journal)
        ? {
            state: journal.state,
            eventId: journal.eventId,
            reservationId: journal.reservationId,
            routeCanonical: journal.routeCanonical,
          }
        : { state: "NONE" },
    };
  }
  if (message.type === "c2c.fetch.state") return handleFetchState();
  if (message.type === "c2c.reserve.page") return handleReservePage(sender, message);
  if (message.type === "c2c.release") return handleRelease();
  if (message.type === "c2c.recover") return handleRecover();
  if (message.type === "c2c.transport.clear") return handleClearTransport();

  const identity = resolveSenderDocumentIdentity(sender);
  const tabId =
    identity.ok || identity.reason === "document_id_unavailable" ? identity.tabId : null;
  const documentId = identity.ok ? identity.documentId : null;
  const href = typeof message.href === "string" ? message.href : sender?.url;
  const parsed = parseRouteSafe(href ?? "");
  const canonical = parsed ? parsed.canonical : null;
  const generation = Number.isFinite(message.generation) ? Number(message.generation) : 1;

  if (
    message.type === "c2c.status.page"
    || message.type === "c2c.observe"
    || message.type === "c2c.heartbeat"
  ) {
    if (!identity.ok && identity.reason !== "document_id_unavailable") {
      return { ok: false, reason: identity.reason };
    }
    ownerState = applyObserveOwnership(ownerState, {
      tabId: tabId ?? -1,
      documentId,
      canonicalRoute: canonical,
      generation,
      now: Date.now(),
    });
    if (
      documentId
      && tabId != null
      && isOwner(ownerState, tabId, documentId)
      && message.safety
    ) {
      evidence = {
        tabId,
        documentId,
        canonicalRoute: canonical,
        observedAt: Date.now(),
        composer: message.safety.composer,
        generation: message.safety.generation,
        safe: message.safety.safe === true,
      };
    } else if (evidence && tabId != null && evidence.tabId === tabId) {
      if (!documentId || evidence.documentId !== documentId || !isOwner(ownerState, tabId, documentId)) {
        evidence = null;
      }
    }
    // Invalidate owner proof when document changes.
    if (
      ownerProof
      && tabId != null
      && (!documentId || documentId !== ownerProof.documentId || tabId !== ownerProof.tabId)
    ) {
      ownerProof = null;
    }
    await persistSessionOwnership();
    return statusPayload(tabId ?? -1, documentId, {
      canonicalRoute: canonical,
      documentIdAvailable: Boolean(documentId),
      source: message.type,
    });
  }

  if (message.type === "c2c.bind") {
    if (!identity.ok) {
      return { ok: false, reason: identity.reason, canonicalRoute: canonical };
    }
    if (!canonical) return { ok: false, reason: "invalid_route" };
    const result = bindOwner(
      ownerState,
      {
        tabId: identity.tabId,
        documentId: identity.documentId,
        canonicalRoute: canonical,
        generation,
        frameId: 0,
        lastSeen: Date.now(),
      },
      canonical,
    );
    ownerState = result.state;
    if (result.ok) {
      localState = { ...localState, targetRoute: canonical, paired: true };
      await persistLocal();
    }
    await persistSessionOwnership();
    return statusPayload(identity.tabId, identity.documentId, {
      reason: result.reason,
      canonicalRoute: canonical,
    });
  }

  return { ok: false, reason: "unknown_type" };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false, reason: "internal" }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    await initPromise;
    ownerState = invalidateOnTabRemoved(ownerState, tabId);
    if (evidence?.tabId === tabId) evidence = null;
    if (ownerProof?.tabId === tabId) ownerProof = null;
    await persistSessionOwnership();
  })();
});

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await initPromise;
    const stored = await chrome.storage.local.get(LOCAL_KEY);
    if (!stored[LOCAL_KEY]) {
      localState = { schemaVersion: 1, targetRoute: null, paired: false };
      await persistLocal();
    }
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await initPromise;
    ownerState = resetSessionOwnership(emptyOwnerState());
    ownerState.targetRoute = localState.targetRoute;
    evidence = null;
    ownerProof = null;
    await persistSessionOwnership();
  })();
});
