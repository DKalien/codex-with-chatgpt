/**
 * C2C Browser Companion service worker (E1b2 + E1b3d3b production one-shot).
 * All Bridge HTTP + credential storage lives here.
 * Identity always from MessageSender. Secrets never in content script.
 * Production Send only via explicit popup request + durable journal CAS.
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
  markOutcomeUnknown,
  clearJournal,
  evaluateReserveEligibility,
  validateStateIdentity,
  assertNoForbiddenFields,
  journalActive,
  journalIsSendSide,
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
import {
  isExtensionInternalSender,
  buildShadowInspectRequest,
  validateShadowInspectResponse,
} from "./shadow-rpc.js";
import {
  buildWriteProbeRequest,
  validateWriteProbeResponse,
} from "./write-probe.js";
import {
  SEND_PROBE_LATCH_KEY,
  emptySendProbeLatch,
  parseSendProbeLatch,
  canStartSendProbe,
  buildSendProbeExecuteRequest,
  classifySendProbeRpcResult,
  executeSendProbeMutationRpc,
} from "./send-probe.js";
import {
  canStartProductionSend,
  buildProductionSendExecuteRequest,
  buildProductionRecoverRequest,
  classifyProductionStartRpcResult,
  validateProductionJournalCommit,
  sanitizeInFlightForRecovery,
  summarizeProductionJournal,
  buildClaimProof,
  buildAckProof,
  reconcileClaimedAgainstServer,
  commitJournalDurably,
  findExactObservedEvent,
  evaluateServerObservedCloseout,
  isServerObservedCloseoutEligible,
} from "./production-send.js";
import {
  AUTONOMY_STORAGE_KEY,
  AUTONOMY_PRODUCTION_COOLDOWN_MS,
  emptyAutonomyPolicy,
  parseAutonomyPolicy,
  autonomySummary,
  policyIdentityExact,
  disarmOnIdentityChange,
  withProductionAttemptStamp,
  planAutonomyTick,
  isExactOwnerHeartbeat,
  buildHeartbeatSafetySnapshot,
  buildEvaluatedEvidenceSnapshot,
  sanitizeRecoveryResult,
  operationalHealthSummary,
} from "./autonomy.js";

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
/** E1b3d2a concurrent write-probe gate (memory only, not production journal). */
let writeProbeInFlight = false;
/** E1b3d3a one-shot real Send probe latch (session, independent of production journal). */
let sendProbeLatch = emptySendProbeLatch();
let sendProbeInFlight = false;
/** E1b3d3b concurrent production send gate (memory only; durable truth is journal). */
let productionSendInFlight = false;
/** Short-lived SW transition proofs. Bound to current journal identity. Never from CS. */
let productionClaimProof = null;
let productionAckProof = null;
/** E1b3d3b2 autonomy policy (durable local). Default OFF. */
let autonomyPolicy = emptyAutonomyPolicy();
/** Memory concurrency gate for autonomous ticks. */
let autonomyTickInFlight = false;
let lastAutonomyTickAt = null;
let lastAutonomyDecision = null;
let lastAutonomyReason = null;
/** Memory-only shadow diagnostics. Never a security authority. */
let lastHeartbeatAt = null;
let lastHeartbeatOwnerExact = false;
let lastHeartbeatSafety = null;
let lastEvaluatedEvidence = null;
let lastRecoveryAt = null;
let lastRecoveryResult = null;

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
  const stored = await chrome.storage.local.get([
    LOCAL_KEY,
    TRANSPORT_KEY,
    JOURNAL_KEY,
    AUTONOMY_STORAGE_KEY,
  ]);
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

  // Default OFF. Never auto-arm on hydrate/pair/bind.
  autonomyPolicy = parseAutonomyPolicy(stored[AUTONOMY_STORAGE_KEY]);
  const disarmed = disarmOnIdentityChange(autonomyPolicy, transport);
  if (disarmed.changed) {
    // Memory OFF first; persist fault still leaves scheduler off.
    autonomyPolicy = emptyAutonomyPolicy();
    try {
      await chrome.storage.local.set({ [AUTONOMY_STORAGE_KEY]: autonomyPolicy });
    } catch {
      // stay OFF in memory
    }
  }

  const live = await chrome.storage.session.get([
    SESSION_OWNER_KEY,
    SESSION_REG_KEY,
    SESSION_EVIDENCE_KEY,
    SEND_PROBE_LATCH_KEY,
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
  sendProbeLatch = parseSendProbeLatch(live[SEND_PROBE_LATCH_KEY]);
  hydrated = true;
}

/** Durable latch persist. Fail closed — never swallow storage errors. */
async function persistSendProbeLatch() {
  try {
    if (sendProbeLatch.state === "NONE") {
      await chrome.storage.session.remove(SEND_PROBE_LATCH_KEY);
    } else {
      await chrome.storage.session.set({ [SEND_PROBE_LATCH_KEY]: sendProbeLatch });
    }
    return true;
  } catch {
    return false;
  }
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

async function persistAutonomyPolicy() {
  await chrome.storage.local.set({ [AUTONOMY_STORAGE_KEY]: autonomyPolicy });
}

/**
 * Durable-first policy commit. Memory authority changes only after persist success.
 * Persist failure keeps previous policy (never in-memory ARMED on failed arm).
 */
async function commitAutonomyPolicy(proposed) {
  const previous = autonomyPolicy;
  try {
    await chrome.storage.local.set({ [AUTONOMY_STORAGE_KEY]: proposed });
  } catch (error) {
    return {
      ok: false,
      reason: "autonomy_persist_failed",
      error: String(error?.message || error),
      policy: previous,
    };
  }
  autonomyPolicy = proposed;
  return { ok: true, policy: autonomyPolicy };
}

/**
 * Immediate in-memory OFF (scheduler fail closed). Persist after.
 * Persist fault still leaves memory OFF and is reported.
 */
async function forceAutonomyOff(reason) {
  const previous = autonomyPolicy;
  autonomyPolicy = emptyAutonomyPolicy();
  lastAutonomyDecision = "off";
  lastAutonomyReason = reason || "disarmed";
  try {
    await chrome.storage.local.set({ [AUTONOMY_STORAGE_KEY]: autonomyPolicy });
  } catch (error) {
    return {
      ok: false,
      reason: "autonomy_persist_failed",
      error: String(error?.message || error),
      policy: autonomyPolicy,
      previousMode: previous.mode,
    };
  }
  return { ok: true, policy: autonomyPolicy, reason: lastAutonomyReason };
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
    journal: summarizeProductionJournal(journal),
    sendProbeLatch: sendProbeLatch.state,
    productionSendInFlight,
    autonomy: autonomySummary(autonomyPolicy, {
      identityExact: policyIdentityExact(autonomyPolicy, transport),
      tickInFlight: autonomyTickInFlight,
      lastTickAt: lastAutonomyTickAt,
      lastDecision: lastAutonomyDecision,
      lastReason: lastAutonomyReason,
      lastHeartbeatAt,
      lastHeartbeatOwnerExact,
      lastHeartbeatSafety,
      lastEvaluatedEvidence,
      lastRecoveryAt,
      lastRecoveryResult,
    }),
    operationalHealth: operationalHealthSummary({
      policy: autonomyPolicy,
      identityExact: policyIdentityExact(autonomyPolicy, transport),
      ownerAvailable: documentId != null && isOwner(ownerState, tabId, documentId),
      storageProtected,
      transport: safeTransportSummary(),
      journalState: journal?.state,
      productionSendInFlight,
      autonomyTickInFlight,
      lastHeartbeatAt,
      lastTickAt: lastAutonomyTickAt,
      lastDecision: lastAutonomyDecision,
      lastReason: lastAutonomyReason,
      lastRecoveryAction: lastRecoveryResult?.action,
      lastRecoveryReason: lastRecoveryResult?.reason,
    }),
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
  await forceAutonomyOff("unbind");
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
    const disarmed = disarmOnIdentityChange(autonomyPolicy, transport);
    if (disarmed.changed) {
      await forceAutonomyOff("identity_disarm");
    }
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
    // Minimal observed proof from the same authenticated /state body only.
    // Never expose message / credential / principal / reservedBy.
    const observedLookup = findExactObservedEvent(res.body.events ?? [], journal);
    return {
      ok: true,
      status: {
        pendingReady: res.body.pendingReady,
        reserved: res.body.reserved,
        claimed: res.body.claimed,
        outcomeUnknown: res.body.outcomeUnknown,
        inFlight: res.body.inFlight ?? null,
        enabled: res.body.enabled,
        serverObserved: observedLookup.ok ? observedLookup.observed : null,
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

  // E1b3d3b: send-side durable states recover through exact-document production runtime.
  if (journalIsSendSide(journal)) {
    // Server-observed closeout: trusted ACK already moved server event to observed.
    // Eligible durable states (OUTCOME_UNKNOWN | OBSERVED_PENDING_ACK) + exact
    // identity proof + inFlight=null may SW-only clear. Zero DOM / ACK / Send / CS.
    const closeout = evaluateServerObservedCloseout({
      journal,
      inFlight,
      serverObserved: stateRes.status?.serverObserved,
    });
    if (isServerObservedCloseoutEligible(journal) && closeout.ok) {
      const previous = journal;
      journal = clearJournal();
      try {
        await persistJournal();
      } catch {
        journal = previous;
        return {
          ok: false,
          reason: "server_observed_persist_failed",
          recovered: false,
          action: "block",
          journal: summarizeProductionJournal(journal),
          zeroWrite: true,
          zeroClick: true,
          ackCalled: false,
          beginSendCalled: false,
        };
      }
      productionClaimProof = null;
      productionAckProof = null;
      return {
        ok: true,
        recovered: true,
        action: "server_observed_clear",
        journal: summarizeProductionJournal(journal),
        zeroWrite: true,
        zeroClick: true,
        ackCalled: false,
        beginSendCalled: false,
      };
    }
    return recoverProductionSendSide(inFlight);
  }

  return { ok: true, recovered: false, journal: { state: journal.state }, inFlight };
}

async function handleClearTransport() {
  if (journalBlocksTransportMutation(journal)) {
    return { ok: false, reason: "journal_active", journalState: journal.state };
  }
  transport = null;
  await forceAutonomyOff("transport_clear");
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
      journal: summarizeProductionJournal(journal),
      sendProbeLatch: sendProbeLatch.state,
      productionSendInFlight,
    };
  }
  if (message.type === "c2c.fetch.state") return handleFetchState();
  if (message.type === "c2c.reserve.page") {
    // Manual reserve competes with autonomy — block while ARMED.
    if (parseAutonomyPolicy(autonomyPolicy).mode === "armed") {
      return { ok: false, reason: "autonomy_armed" };
    }
    return handleReservePage(sender, message);
  }
  if (message.type === "c2c.release") return handleRelease();
  if (message.type === "c2c.recover") return handleRecover();
  if (message.type === "c2c.retire.unknown") {
    // Manual popup-only. Content scripts must never trigger retirement.
    if (!isExtensionInternalSender(sender)) {
      return { ok: false, reason: "popup_sender_required" };
    }
    return handleRetireUnknown();
  }
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
    // Only exact owner-document heartbeat may schedule autonomy.
    if (message.type === "c2c.heartbeat") {
      const ownerExact = isExactOwnerHeartbeat({
        identityOk: identity.ok === true,
        tabId,
        documentId,
        canonicalRoute: canonical,
        owner: ownerState.owner,
        transportRoute: transport?.routeCanonical ?? null,
      });
      // Bounded diagnostic for every heartbeat, including foreign ones.
      lastHeartbeatAt = Date.now();
      lastHeartbeatOwnerExact = ownerExact === true;
      lastHeartbeatSafety = buildHeartbeatSafetySnapshot(message.safety);
      if (ownerExact) {
        void maybeRunAutonomyTick({
          sender,
          message,
          identityOk: identity.ok === true,
          tabId,
          documentId,
          canonicalRoute: canonical,
        });
      }
    }
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

  // E1b3d1: popup/internal only (no sender.tab). Document-targeted RPC.
  if (message.type === "c2c.shadow.send.inspect") {
    if (!isExtensionInternalSender(sender)) {
      return { ok: false, reason: "popup_sender_required" };
    }
    return handleShadowInspect();
  }

  // E1b3d2a: popup-only write probe. Fixed message only. Zero Send. No journal.
  if (message.type === "c2c.write.probe.request") {
    if (!isExtensionInternalSender(sender)) {
      return { ok: false, reason: "popup_sender_required" };
    }
    // Reject any caller-supplied message payload — fixed probe only.
    if (message.message != null || message.payload != null) {
      return { ok: false, reason: "write_probe_payload_forbidden" };
    }
    return handleWriteProbe();
  }

  // E1b3d3a: popup-only one-shot REAL Send probe. SW mints attemptId + message.
  if (message.type === "c2c.send.probe.request") {
    if (!isExtensionInternalSender(sender)) {
      return { ok: false, reason: "popup_sender_required" };
    }
    if (
      message.message != null
      || message.attemptId != null
      || message.route != null
      || message.documentId != null
      || message.payload != null
    ) {
      return { ok: false, reason: "send_probe_payload_forbidden" };
    }
    return handleSendProbe();
  }

  // E1b3d3a: manual reset only when COMPLETED + journal NONE.
  if (message.type === "c2c.send.probe.reset") {
    if (!isExtensionInternalSender(sender)) {
      return { ok: false, reason: "popup_sender_required" };
    }
    return handleSendProbeReset();
  }

  // E1b3d3b: popup-only production one-shot send. Caller never supplies identity/message.
  if (message.type === "c2c.production.send.request") {
    if (!isExtensionInternalSender(sender)) {
      return { ok: false, reason: "popup_sender_required" };
    }
    if (
      message.message != null
      || message.eventId != null
      || message.reservationId != null
      || message.attemptId != null
      || message.route != null
      || message.routeCanonical != null
      || message.documentId != null
      || message.payload != null
    ) {
      return { ok: false, reason: "production_send_payload_forbidden" };
    }
    // Manual send competes with autonomy scheduler — block while ARMED.
    if (parseAutonomyPolicy(autonomyPolicy).mode === "armed") {
      return { ok: false, reason: "autonomy_armed" };
    }
    return handleProductionSend();
  }

  // E1b3d3b2 autonomy controls. Identity always from SW transport + bound owner.
  if (
    message.type === "c2c.autonomy.enable.shadow"
    || message.type === "c2c.autonomy.arm"
    || message.type === "c2c.autonomy.disable"
  ) {
    if (!isExtensionInternalSender(sender)) {
      return { ok: false, reason: "popup_sender_required" };
    }
    if (
      message.message != null
      || message.eventId != null
      || message.reservationId != null
      || message.attemptId != null
      || message.route != null
      || message.routeCanonical != null
      || message.documentId != null
      || message.bindingId != null
      || message.epoch != null
      || message.payload != null
    ) {
      return { ok: false, reason: "autonomy_payload_forbidden" };
    }
    if (message.type === "c2c.autonomy.disable") {
      const off = await forceAutonomyOff("manual_disable");
      return {
        ok: off.ok === true,
        mode: "off",
        policy: autonomyPolicy,
        reason: off.ok === true ? undefined : (off.reason || "autonomy_persist_failed"),
        persistenceFault: off.ok === true ? undefined : (off.reason || "autonomy_persist_failed"),
        journal: summarizeProductionJournal(journal),
      };
    }
    if (!storageProtected) return { ok: false, reason: "storage_unprotected" };
    if (!transport || transport.authStale) return { ok: false, reason: "transport_invalid" };
    if (!ownerState.owner) return { ok: false, reason: "not_exact_owner" };
    if (ownerState.owner.canonicalRoute !== transport.routeCanonical) {
      return { ok: false, reason: "owner_route_mismatch" };
    }
    const mode = message.type === "c2c.autonomy.arm" ? "armed" : "shadow";
    const previousMode = parseAutonomyPolicy(autonomyPolicy).mode;
    const proposed = {
      schemaVersion: 1,
      mode,
      bindingId: transport.bindingId,
      epoch: transport.epoch,
      routeCanonical: transport.routeCanonical,
      armedAt: Date.now(),
      lastProductionAttemptAt: autonomyPolicy.lastProductionAttemptAt,
    };
    const commit = await commitAutonomyPolicy(proposed);
    if (!commit.ok) {
      return {
        ok: false,
        reason: commit.reason || "autonomy_persist_failed",
        error: commit.error,
        mode: previousMode,
        policy: autonomyPolicy,
        journal: summarizeProductionJournal(journal),
      };
    }
    return {
      ok: true,
      mode: autonomyPolicy.mode,
      policy: autonomyPolicy,
      journal: summarizeProductionJournal(journal),
    };
  }

  // E1b3d3b CS CAS persist. Exact owner document only.
  if (message.type === "c2c.production.journal.persist") {
    return handleProductionJournalPersist(sender, message);
  }

  // E1b3d3b CS begin-send adapter. SW owns secret + durable identity.
  if (message.type === "c2c.production.begin.send") {
    return handleProductionBeginSend(sender, message);
  }

  // E1b3d3b CS ack adapter.
  if (message.type === "c2c.production.ack") {
    return handleProductionAck(sender, message);
  }

  return { ok: false, reason: "unknown_type" };
}

/**
 * E1b3d3a explicit one-shot real Send probe.
 * Durable latch EXECUTION_INTENT before mutation RPC. Journal stays NONE.
 * RPC throw/null → OUTCOME_UNKNOWN, no retry.
 */
async function handleSendProbe() {
  await initPromise;
  if (sendProbeInFlight) {
    return { ok: false, reason: "send_probe_in_flight", retryAllowed: false, latch: sendProbeLatch.state };
  }
  sendProbeInFlight = true;
  try {
    const gate = requireProtectedTransport();
    if (!gate.ok) return gate;
    if (!ownerState.owner) {
      return { ok: false, reason: "owner_missing" };
    }
    const owner = ownerState.owner;
    const start = canStartSendProbe({
      owner,
      transport,
      journalIsNone: !journalActive(journal),
      latch: sendProbeLatch,
    });
    if (!start.ok) {
      return {
        ok: false,
        reason: start.reason,
        latchState: start.latchState ?? sendProbeLatch.state,
        journalState: journal.state ?? "NONE",
        retryAllowed: false,
      };
    }

    const attemptId = crypto.randomUUID();
    const request = buildSendProbeExecuteRequest(owner, transport, attemptId);
    if (!request.ok) {
      return { ok: false, reason: request.reason, retryAllowed: false };
    }

    // Durable intent BEFORE mutation RPC. Must persist or abort with zero RPC.
    const prevLatch = sendProbeLatch;
    const intentLatch = {
      state: "EXECUTION_INTENT",
      tabId: owner.tabId,
      documentId: owner.documentId,
      canonicalRoute: owner.canonicalRoute,
      generation: owner.generation,
      attemptId,
      createdAt: Date.now(),
    };
    const mut = await executeSendProbeMutationRpc({
      intentLatch,
      persistLatch: async (latch) => {
        sendProbeLatch = latch;
        return persistSendProbeLatch();
      },
      invokeRpc: () => chrome.tabs.sendMessage(
        request.tabId,
        request.message,
        request.sendOptions,
      ),
    });

    if (mut.reason === "send_probe_latch_persist_failed") {
      sendProbeLatch = prevLatch;
      await persistSendProbeLatch();
      return {
        ok: false,
        reason: "send_probe_latch_persist_failed",
        retryAllowed: false,
        latch: sendProbeLatch.state,
        mutationAttempted: false,
        clickAttempted: false,
      };
    }

    if (mut.reason === "send_probe_outcome_unknown" && mut.response == null) {
      sendProbeLatch = { ...intentLatch, state: "OUTCOME_UNKNOWN" };
      await persistSendProbeLatch();
      return {
        ok: false,
        reason: "send_probe_outcome_unknown",
        retryAllowed: false,
        latch: "OUTCOME_UNKNOWN",
        attemptId,
        productionJournal: journal.state ?? "NONE",
      };
    }

    if (mut.outcome === "completed" && mut.response) {
      sendProbeLatch = { ...intentLatch, state: "COMPLETED" };
      const okPersist = await persistSendProbeLatch();
      if (!okPersist) {
        sendProbeLatch = { ...intentLatch, state: "OUTCOME_UNKNOWN" };
        await persistSendProbeLatch();
        return {
          ok: false,
          reason: "send_probe_latch_persist_failed",
          retryAllowed: false,
          latch: "OUTCOME_UNKNOWN",
          attemptId,
          productionJournal: journal.state ?? "NONE",
        };
      }
      const response = mut.response;
      return {
        ok: true,
        mode: "send_probe_real",
        attemptId,
        mutationAttempted: response.mutationAttempted === true,
        wrote: response.wrote === true,
        verified: response.verified === true,
        clickAttempted: response.clickAttempted === true,
        clicked: response.clicked === true,
        observed: response.observed === true,
        routeExact: true,
        documentIdExact: true,
        generationExact: true,
        productionJournal: journal.state ?? "NONE",
        latch: "COMPLETED",
        retryAllowed: false,
        canonicalRoute: response.canonicalRoute,
        generation: response.generation,
      };
    }
    if (mut.outcome === "pre_mutation") {
      sendProbeLatch = emptySendProbeLatch();
      await persistSendProbeLatch();
      return {
        ok: false,
        reason: mut.reason,
        retryAllowed: true,
        latch: "NONE",
        attemptId,
        mutationAttempted: false,
        clickAttempted: false,
        productionJournal: journal.state ?? "NONE",
      };
    }
    sendProbeLatch = { ...intentLatch, state: "OUTCOME_UNKNOWN" };
    await persistSendProbeLatch();
    return {
      ok: false,
      reason: mut.reason,
      retryAllowed: false,
      latch: "OUTCOME_UNKNOWN",
      attemptId,
      mutationAttempted: mut.mutationAttempted === true,
      clickAttempted: mut.clickAttempted === true,
      productionJournal: journal.state ?? "NONE",
    };
  } finally {
    sendProbeInFlight = false;
  }
}

async function handleSendProbeReset() {
  await initPromise;
  if (sendProbeLatch.state !== "COMPLETED") {
    return {
      ok: false,
      reason: "send_probe_latch_not_resettable",
      latch: sendProbeLatch.state,
      retryAllowed: false,
    };
  }
  if (journalActive(journal)) {
    return {
      ok: false,
      reason: "send_probe_journal_active",
      journalState: journal.state ?? null,
      retryAllowed: false,
    };
  }
  sendProbeLatch = emptySendProbeLatch();
  await persistSendProbeLatch();
  return { ok: true, latch: "NONE" };
}

/**
 * Read-only shadow inspect via exact owner document RPC.
 * Side-effect free: no journal change, no begin-send, no ack, no write/click.
 */
async function handleShadowInspect() {
  await initPromise;
  const gate = requireProtectedTransport();
  if (!gate.ok) return gate;
  if (!ownerState.owner) {
    return { ok: false, reason: "owner_missing" };
  }
  const owner = ownerState.owner;

  const request = buildShadowInspectRequest(owner, transport);
  if (!request.ok) {
    return { ok: false, reason: request.reason };
  }

  let response;
  try {
    // Exact document targeting: third argument is the delivery options object.
    response = await chrome.tabs.sendMessage(
      request.tabId,
      request.message,
      request.sendOptions,
    );
  } catch {
    return { ok: false, reason: "no_content_script" };
  }

  const check = validateShadowInspectResponse(response, owner, transport);
  if (!check.ok) {
    return { ok: false, reason: check.reason };
  }

  // Safe summary only — no DOM nodes / HTML / credentials.
  return {
    ok: true,
    mode: "read_only",
    routeExact: true,
    documentIdExact: true,
    owner: {
      tabId: owner.tabId,
      documentId: owner.documentId,
      canonicalRoute: owner.canonicalRoute,
      generation: owner.generation ?? null,
    },
    composer: response.composer ?? null,
    action: response.action ?? null,
    safety: response.safety ?? null,
    userTurnCount: typeof response.userTurnCount === "number" ? response.userTurnCount : null,
    observedAt: response.observedAt ?? Date.now(),
    journalUnchanged: true,
  };
}

/**
 * E1b3d2a write probe via exact owner document RPC.
 * Fixed WRITE_PROBE_MESSAGE only. Journal must stay NONE. No Send / begin-send / ack.
 * Mutation RPC failure → write_outcome_unknown, retryAllowed=false, no auto-retry.
 */
async function handleWriteProbe() {
  await initPromise;
  if (writeProbeInFlight) {
    return { ok: false, reason: "write_probe_in_flight", retryAllowed: false };
  }
  writeProbeInFlight = true;
  try {
    const gate = requireProtectedTransport();
    if (!gate.ok) return gate;
    if (!ownerState.owner) {
      return { ok: false, reason: "owner_missing" };
    }
    // Production send journal must remain NONE for this diagnostic probe.
    if (journalActive(journal)) {
      return {
        ok: false,
        reason: "write_probe_journal_active",
        journalState: journal.state ?? null,
        retryAllowed: false,
      };
    }
    const owner = ownerState.owner;
    const request = buildWriteProbeRequest(owner, transport);
    if (!request.ok) {
      return { ok: false, reason: request.reason, retryAllowed: false };
    }

    let response;
    let rpcThrew = false;
    try {
      response = await chrome.tabs.sendMessage(
        request.tabId,
        request.message,
        request.sendOptions,
      );
    } catch {
      rpcThrew = true;
      response = null;
    }
    if (rpcThrew || response == null) {
      // CS may have already mutated; never auto-retry a mutation RPC.
      return {
        ok: false,
        reason: "write_outcome_unknown",
        retryAllowed: false,
        mode: "write_probe_no_send",
        noSend: true,
      };
    }

    const check = validateWriteProbeResponse(response, owner, transport);
    if (!check.ok) {
      // Known CS failure OR contract mismatch — never success, never outcome_unknown.
      return {
        ok: false,
        reason: check.reason,
        wrote: check.wrote === true,
        verified: check.verified === true,
        mutationAttempted: check.mutationAttempted === true,
        readback: check.readback ?? null,
        mode: "write_probe_no_send",
        noSend: true,
        noSendPerformed: true,
        retryAllowed: false,
        journalUnchanged: true,
      };
    }

    return {
      ok: true,
      mode: "write_probe_no_send",
      routeExact: true,
      documentIdExact: true,
      generationExact: true,
      wrote: response.wrote === true,
      verified: response.verified === true,
      mutationAttempted: response.mutationAttempted === true,
      readback: response.readback ?? null,
      editorKind: response.editorKind ?? null,
      composerEvidence: response.composerEvidence ?? null,
      canonicalRoute: response.canonicalRoute,
      generation: response.generation,
      noSend: true,
      noSendPerformed: true,
      journalUnchanged: true,
      journalState: journal.state ?? "NONE",
      retryAllowed: false,
      owner: {
        tabId: owner.tabId,
        documentId: owner.documentId,
        canonicalRoute: owner.canonicalRoute,
        generation: owner.generation ?? null,
      },
    };
  } finally {
    writeProbeInFlight = false;
  }
}

/** Exact-owner document check for CS production RPCs. */
function requireExactOwnerSender(sender) {
  const identity = resolveSenderDocumentIdentity(sender);
  if (!identity.ok) {
    return { ok: false, reason: identity.reason };
  }
  if (
    !ownerState.owner
    || !isOwner(ownerState, identity.tabId, identity.documentId)
  ) {
    return { ok: false, reason: "not_exact_owner" };
  }
  return {
    ok: true,
    tabId: identity.tabId,
    documentId: identity.documentId,
    owner: ownerState.owner,
  };
}

/**
 * E1b3d3b production journal CAS. SW is the only writer.
 * CS cannot invent identity; stale expectedPrevious fails closed.
 */
async function handleProductionJournalPersist(sender, message) {
  await initPromise;
  const ownerCheck = requireExactOwnerSender(sender);
  if (!ownerCheck.ok) return ownerCheck;
  const proposed = message?.proposed;
  const expectedPrevious = message?.expectedPrevious;
  if (!proposed || typeof proposed !== "object" || !expectedPrevious || typeof expectedPrevious !== "object") {
    return { ok: false, reason: "production_persist_payload_invalid" };
  }
  const check = validateProductionJournalCommit(journal, proposed, expectedPrevious, {
    claimProof: productionClaimProof,
    ackProof: productionAckProof,
  });
  if (!check.ok) {
    return { ok: false, reason: check.reason, journal: summarizeProductionJournal(journal) };
  }
  // Binding/epoch must still match active transport for send-side states.
  if (proposed.state !== "NONE" && transport) {
    if (proposed.bindingId !== transport.bindingId || proposed.epoch !== transport.epoch) {
      return { ok: false, reason: "binding_mismatch", journal: summarizeProductionJournal(journal) };
    }
    if (
      proposed.routeCanonical
      && transport.routeCanonical
      && proposed.routeCanonical !== transport.routeCanonical
    ) {
      return { ok: false, reason: "route_mismatch", journal: summarizeProductionJournal(journal) };
    }
  }
  const previousJournal = journal;
  const committed = await commitJournalDurably({
    current: previousJournal,
    proposed,
    persist: async (next) => {
      journal = next;
      await persistJournal();
    },
    onDurableSuccess: (next) => {
      // Consume short-lived proofs only after a successful protected persist.
      if (next.state === "CLAIMED") {
        productionClaimProof = null;
      }
      if (next.state === "NONE") {
        productionAckProof = null;
        productionClaimProof = null;
      }
    },
  });
  if (!committed.ok) {
    journal = previousJournal;
    return {
      ok: false,
      reason: committed.reason,
      error: committed.error,
      journal: summarizeProductionJournal(journal),
    };
  }
  return { ok: true, journal: summarizeProductionJournal(journal) };
}

/**
 * E1b3d3b /begin-send adapter. Credential stays in SW.
 * Body always from durable journal — never caller-supplied identity.
 */
async function handleProductionBeginSend(sender, message) {
  await initPromise;
  const ownerCheck = requireExactOwnerSender(sender);
  if (!ownerCheck.ok) return ownerCheck;
  const gate = requireProtectedTransport();
  if (!gate.ok) return gate;
  if (journal.state !== "SEND_INTENT" || !journal.eventId || !journal.reservationId) {
    return { ok: false, reason: "journal_not_send_intent", journal: summarizeProductionJournal(journal) };
  }
  // Optional identity assertion from CS must exact-match durable journal.
  if (message?.eventId != null && message.eventId !== journal.eventId) {
    return { ok: false, reason: "event_id_mismatch" };
  }
  if (message?.reservationId != null && message.reservationId !== journal.reservationId) {
    return { ok: false, reason: "reservation_id_mismatch" };
  }
  if (message?.routeCanonical != null && message.routeCanonical !== journal.routeCanonical) {
    return { ok: false, reason: "route_mismatch" };
  }
  if (message?.bindingId != null && message.bindingId !== journal.bindingId) {
    return { ok: false, reason: "binding_mismatch" };
  }
  if (message?.epoch != null && message.epoch !== journal.epoch) {
    return { ok: false, reason: "epoch_mismatch" };
  }

  let res;
  try {
    res = await fetchCompanion("/begin-send", {
      method: "POST",
      body: JSON.stringify({
        routeCanonical: journal.routeCanonical,
        eventId: journal.eventId,
        reservationId: journal.reservationId,
      }),
    });
  } catch {
    return { ok: false, reason: "network_unreachable", journal: summarizeProductionJournal(journal) };
  }
  if (res.status === 401) {
    return markAuthStale(res.body?.error || "COMPANION_UNAUTHORIZED");
  }
  if (res.status === 409) {
    return {
      ok: false,
      reason: res.body?.error || "begin_send_conflict",
      status: 409,
      journal: summarizeProductionJournal(journal),
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      reason: res.body?.error || `http_${res.status}`,
      status: res.status,
      journal: summarizeProductionJournal(journal),
    };
  }
  assertNoForbiddenFields(res.body);
  const body = res.body || {};
  if (
    body.eventId !== journal.eventId
    || body.status !== "claimed"
    || typeof body.attemptId !== "string"
    || !body.attemptId
    || typeof body.message !== "string"
    || !body.message
    || typeof body.messageSha256 !== "string"
    || !body.messageSha256
  ) {
    return { ok: false, reason: "begin_send_response_invalid", journal: summarizeProductionJournal(journal) };
  }
  // Only a fully validated real /begin-send may mint the SEND_INTENT → CLAIMED proof.
  productionClaimProof = buildClaimProof({
    eventId: body.eventId,
    reservationId: journal.reservationId,
    attemptId: body.attemptId,
    message: body.message,
    messageSha256: body.messageSha256,
  });
  if (!productionClaimProof) {
    return { ok: false, reason: "claim_proof_mint_failed", journal: summarizeProductionJournal(journal) };
  }
  return {
    ok: true,
    eventId: body.eventId,
    status: body.status,
    attemptId: body.attemptId,
    message: body.message,
    messageSha256: body.messageSha256,
  };
}

/**
 * E1b3d3b /ack adapter. Only from OBSERVED_PENDING_ACK.
 * Success must prove eventId + status=observed before CS may clear.
 */
async function handleProductionAck(sender, message) {
  await initPromise;
  const ownerCheck = requireExactOwnerSender(sender);
  if (!ownerCheck.ok) return ownerCheck;
  const gate = requireProtectedTransport();
  if (!gate.ok) return gate;
  if (journal.state !== "OBSERVED_PENDING_ACK" || !journal.eventId || !journal.attemptId) {
    return { ok: false, reason: "journal_not_pending_ack", journal: summarizeProductionJournal(journal) };
  }
  if (message?.eventId != null && message.eventId !== journal.eventId) {
    return { ok: false, reason: "event_id_mismatch" };
  }
  if (message?.attemptId != null && message.attemptId !== journal.attemptId) {
    return { ok: false, reason: "attempt_id_mismatch" };
  }
  if (message?.reservationId != null && message.reservationId !== journal.reservationId) {
    return { ok: false, reason: "reservation_id_mismatch" };
  }

  let res;
  try {
    res = await fetchCompanion("/ack", {
      method: "POST",
      body: JSON.stringify({
        routeCanonical: journal.routeCanonical,
        eventId: journal.eventId,
        attemptId: journal.attemptId,
      }),
    });
  } catch {
    return {
      ok: false,
      reason: "network_unreachable",
      retryAck: true,
      journal: summarizeProductionJournal(journal),
    };
  }
  if (res.status === 401) {
    return markAuthStale(res.body?.error || "COMPANION_UNAUTHORIZED");
  }
  if (!res.ok) {
    return {
      ok: false,
      reason: res.body?.error || `http_${res.status}`,
      status: res.status,
      retryAck: true,
      journal: summarizeProductionJournal(journal),
    };
  }
  assertNoForbiddenFields(res.body);
  const body = res.body || {};
  if (body.eventId !== journal.eventId || body.status !== "observed") {
    return {
      ok: false,
      reason: "ack_response_invalid",
      retryAck: true,
      journal: summarizeProductionJournal(journal),
    };
  }
  // Only a fully validated real /ack may mint the OBSERVED_PENDING_ACK → NONE proof.
  productionAckProof = buildAckProof({
    eventId: body.eventId,
    attemptId: journal.attemptId,
    status: body.status,
  });
  if (!productionAckProof) {
    return {
      ok: false,
      reason: "ack_proof_mint_failed",
      retryAck: true,
      journal: summarizeProductionJournal(journal),
    };
  }
  return { ok: true, eventId: body.eventId, status: body.status };
}

/**
 * E1b3d3b2 autonomous tick. Exact-owner heartbeat only. Default OFF.
 * Journal-first recovery. One event max per tick. Never auto-retire.
 */
async function maybeRunAutonomyTick(ctx = {}) {
  if (autonomyTickInFlight) return;
  if (parseAutonomyPolicy(autonomyPolicy).mode === "off") return;
  autonomyTickInFlight = true;
  try {
    await initPromise;

    // Re-validate exact owner heartbeat at execution time (not just comments).
    const hb = isExactOwnerHeartbeat({
      identityOk: ctx.identityOk !== false,
      tabId: ctx.tabId,
      documentId: ctx.documentId,
      canonicalRoute: ctx.canonicalRoute,
      owner: ownerState.owner,
      transportRoute: transport?.routeCanonical ?? null,
    });
    if (!hb || !ownerState.owner) {
      lastAutonomyTickAt = Date.now();
      lastAutonomyDecision = "gate_failed";
      lastAutonomyReason = "not_exact_owner_heartbeat";
      return;
    }

    const disarmed = disarmOnIdentityChange(autonomyPolicy, transport);
    if (disarmed.changed) {
      // Immediate memory OFF; persist fault still blocks scheduler.
      const off = await forceAutonomyOff("identity_disarm");
      if (!off.ok) {
        lastAutonomyTickAt = Date.now();
        lastAutonomyDecision = "gate_failed";
        lastAutonomyReason = off.reason || "autonomy_persist_failed";
        return;
      }
    }
    if (autonomyPolicy.mode === "off") {
      lastAutonomyTickAt = Date.now();
      lastAutonomyDecision = "off";
      lastAutonomyReason = "disarmed";
      return;
    }

    let inFlight = null;
    let pendingReady = 0;
    if (journal.state === "NONE") {
      const stateRes = await handleFetchState();
      if (!stateRes.ok) {
        lastAutonomyTickAt = Date.now();
        lastAutonomyDecision = "gate_failed";
        lastAutonomyReason = stateRes.reason || "state_fetch_failed";
        return;
      }
      inFlight = stateRes.status.inFlight ?? null;
      pendingReady = Number(stateRes.status.pendingReady) || 0;
    }

    // Bounded diagnostic snapshot of evidence the planner will use.
    // Not a security authority.
    lastEvaluatedEvidence = buildEvaluatedEvidenceSnapshot({
      evidence,
      now: Date.now(),
      documentExact: Boolean(
        evidence && ownerState.owner && evidence.documentId === ownerState.owner.documentId,
      ),
      routeExact: Boolean(
        evidence && transport && evidence.canonicalRoute === transport.routeCanonical,
      ),
    });

    const plan = planAutonomyTick({
      policy: autonomyPolicy,
      storageProtected,
      transport,
      owner: ownerState.owner,
      evidence,
      journal,
      sendProbeLatch,
      productionSendInFlight,
      autonomyTickInFlight: false,
      inFlight,
      pendingReady,
      now: Date.now(),
    });
    lastAutonomyTickAt = Date.now();
    lastAutonomyDecision = plan.decision;
    lastAutonomyReason = plan.reason ?? null;

    if (plan.decision === "off" || plan.decision === "gate_failed"
      || plan.decision === "idle_no_ready" || plan.decision === "cooldown"
      || plan.decision === "server_inflight_without_local_journal") {
      return;
    }

    if (plan.decision === "recovering") {
      const journalBefore = journal.state;
      const rec = await handleRecover();
      const after = journal.state;
      // Bounded diagnostic only. Never changes recover/ACK/journal semantics.
      lastRecoveryAt = Date.now();
      lastRecoveryResult = sanitizeRecoveryResult({
        ok: rec?.ok === true,
        reason: rec?.reason ?? null,
        action: rec?.action ?? null,
        retryAck: rec?.retryAck === true,
        journalState: after,
        diagnostic: rec?.diagnostic ?? null,
      });

      if (journalBefore === "RESERVED" || after === "RESERVED") {
        if (after !== "RESERVED") {
          // Cleared / moved. Same tick must NOT reserve next event.
          lastAutonomyDecision = after === "NONE" ? "recovered" : "production_blocked";
          lastAutonomyReason = after === "NONE" ? null : (rec?.reason || "reserved_recover_mismatch");
          return;
        }
        if (parseAutonomyPolicy(autonomyPolicy).mode === "shadow") {
          // SHADOW: keep existing RESERVED only — never production send.
          lastAutonomyDecision = "production_blocked";
          lastAutonomyReason = "shadow_keep_reserved";
          return;
        }
        // ARMED: continue the SAME reserved event. No second reserve. No cooldown.
        const start = canStartProductionSend({
          owner: ownerState.owner,
          transport,
          journal,
          latch: sendProbeLatch,
          productionSendInFlight: false,
          evidence,
          now: Date.now(),
        });
        if (!start.ok) {
          lastAutonomyDecision = "production_blocked";
          lastAutonomyReason = start.reason;
          return;
        }
        lastAutonomyDecision = "production_started";
        const sendRes = await handleProductionSend();
        if (sendRes?.ok) {
          lastAutonomyDecision = "production_completed";
          lastAutonomyReason = null;
        } else {
          lastAutonomyDecision = "production_blocked";
          lastAutonomyReason = sendRes?.reason || "production_send_failed";
        }
        return;
      }

      if (rec?.ok && after === "NONE") {
        lastAutonomyDecision = "recovered";
        return;
      }
      if (!rec?.ok) {
        lastAutonomyDecision = "production_blocked";
        lastAutonomyReason = rec?.reason || "recover_failed";
      }
      return;
    }

    if (plan.decision !== "would_reserve_and_send") return;
    if (plan.mode === "shadow") {
      return;
    }

    // ARMED production: durable cooldown stamp BEFORE mutation attempts.
    const sender = ctx.sender;
    const heartbeatMessage = ctx.message;
    if (!sender || !heartbeatMessage) {
      lastAutonomyDecision = "gate_failed";
      lastAutonomyReason = "heartbeat_sender_missing";
      return;
    }

    const stamped = withProductionAttemptStamp(autonomyPolicy, Date.now());
    const stampCommit = await commitAutonomyPolicy(stamped);
    if (!stampCommit.ok) {
      // Persist failure → zero reserve / begin-send / DOM / click.
      lastAutonomyDecision = "production_blocked";
      lastAutonomyReason = stampCommit.reason || "autonomy_persist_failed";
      return;
    }

    const reserveRes = await handleReservePage(sender, heartbeatMessage);
    if (!reserveRes?.ok || journal.state !== "RESERVED") {
      lastAutonomyDecision = "production_blocked";
      lastAutonomyReason = reserveRes?.reason || "reserve_failed";
      return;
    }

    const start = canStartProductionSend({
      owner: ownerState.owner,
      transport,
      journal,
      latch: sendProbeLatch,
      productionSendInFlight: false,
      evidence,
      now: Date.now(),
    });
    if (!start.ok) {
      lastAutonomyDecision = "production_blocked";
      lastAutonomyReason = start.reason;
      return;
    }

    lastAutonomyDecision = "production_started";
    const sendRes = await handleProductionSend();
    if (sendRes?.ok) {
      lastAutonomyDecision = "production_completed";
      lastAutonomyReason = null;
    } else {
      lastAutonomyDecision = "production_blocked";
      lastAutonomyReason = sendRes?.reason || "production_send_failed";
    }
  } catch {
    lastAutonomyTickAt = Date.now();
    lastAutonomyDecision = "gate_failed";
    lastAutonomyReason = "autonomy_tick_error";
  } finally {
    autonomyTickInFlight = false;
  }
}

/**
 * E1b3d3b explicit production one-shot send.
 * Preflight happens on CS before SEND_INTENT. SW only dispatches exact-document RPC.
 * RPC ambiguity uses durable journal — never memory boolean as crash authority.
 */
async function handleProductionSend() {
  await initPromise;
  if (productionSendInFlight) {
    return {
      ok: false,
      reason: "production_send_in_flight",
      retryAllowed: false,
      journal: summarizeProductionJournal(journal),
    };
  }
  productionSendInFlight = true;
  try {
    const gate = requireProtectedTransport();
    if (!gate.ok) return gate;
    if (!ownerState.owner) {
      return { ok: false, reason: "owner_missing" };
    }
    const owner = ownerState.owner;
    const start = canStartProductionSend({
      owner,
      transport,
      journal,
      latch: sendProbeLatch,
      productionSendInFlight: false,
      evidence,
      now: Date.now(),
    });
    if (!start.ok) {
      return {
        ok: false,
        reason: start.reason,
        retryAllowed: false,
        journal: summarizeProductionJournal(journal),
        sendProbeLatch: sendProbeLatch.state,
      };
    }

    const request = buildProductionSendExecuteRequest(owner, journal);
    if (!request.ok) {
      return { ok: false, reason: request.reason, retryAllowed: false };
    }

    let response = null;
    let rpcThrew = false;
    try {
      response = await chrome.tabs.sendMessage(
        request.tabId,
        request.message,
        request.sendOptions,
      );
    } catch {
      rpcThrew = true;
      response = null;
    }

    const classified = classifyProductionStartRpcResult({
      response: rpcThrew ? null : response,
      journalAfter: journal,
    });
    if (classified.ok && classified.response) {
      const r = classified.response;
      return {
        ok: true,
        mode: "production_send",
        eventId: r.eventId ?? journal.eventId,
        attemptId: r.attemptId ?? null,
        journal: summarizeProductionJournal(journal),
        retryAllowed: false,
        productionJournal: journal.state,
      };
    }
    return {
      ok: false,
      reason: classified.reason,
      retryAllowed: classified.retryAllowed === true,
      action: classified.action,
      journal: summarizeProductionJournal(journal),
      zeroWrite: classified.zeroWrite === true,
      zeroClick: classified.zeroClick === true,
      retryAck: classified.retryAck === true,
      productionJournal: classified.journalState,
    };
  } finally {
    productionSendInFlight = false;
  }
}

/**
 * E1b3d3b recovery: send-side states go through exact-document production recovery.
 * Server /state is the upper fact for CLAIMED. Post-mutation fence never write/click.
 */
async function recoverProductionSendSide(inFlight) {
  if (!ownerState.owner) {
    return { ok: false, reason: "owner_missing", journal: summarizeProductionJournal(journal) };
  }
  if (productionSendInFlight) {
    return {
      ok: false,
      reason: "production_send_in_flight",
      journal: summarizeProductionJournal(journal),
    };
  }
  const owner = ownerState.owner;
  const safeInFlight = sanitizeInFlightForRecovery(inFlight);

  // Local SEND_INTENT + no server inFlight → SW clears itself; never CS generic CAS.
  if (journal.state === "SEND_INTENT" && !safeInFlight) {
    journal = clearJournal();
    await persistJournal();
    productionClaimProof = null;
    productionAckProof = null;
    return { ok: true, recovered: true, journal: summarizeProductionJournal(journal), action: "clear" };
  }

  // Local SEND_INTENT + server claimed → mint claim proof so CS adopt CAS has real authority.
  if (
    journal.state === "SEND_INTENT"
    && safeInFlight
    && safeInFlight.status === "claimed"
    && safeInFlight.eventId === journal.eventId
    && safeInFlight.reservationId === journal.reservationId
    && safeInFlight.attemptId
  ) {
    productionClaimProof = buildClaimProof({
      eventId: journal.eventId,
      reservationId: journal.reservationId,
      attemptId: safeInFlight.attemptId,
      message: safeInFlight.message,
      messageSha256: safeInFlight.messageSha256,
    });
    if (!productionClaimProof) {
      return {
        ok: false,
        reason: "claim_proof_mint_failed",
        journal: summarizeProductionJournal(journal),
        zeroWrite: true,
        zeroClick: true,
      };
    }
  }

  // Local CLAIMED: server is upper fact before any CS resume.
  if (journal.state === "CLAIMED") {
    const rec = reconcileClaimedAgainstServer(journal, safeInFlight);
    if (rec.action === "fail_closed" || rec.action === "conflict") {
      return {
        ok: false,
        reason: rec.reason || "claimed_server_conflict",
        journal: summarizeProductionJournal(journal),
        zeroWrite: true,
        zeroClick: true,
        action: "block",
      };
    }
    if (rec.action === "adopt_outcome_unknown") {
      try {
        journal = markOutcomeUnknown(journal, {
          attemptId: rec.attemptId,
          message: rec.message,
          messageSha256: rec.messageSha256,
        });
        await persistJournal();
      } catch {
        // already outcome unknown or identity mismatch — fail closed
      }
      productionClaimProof = null;
      productionAckProof = null;
      return {
        ok: false,
        reason: "server_outcome_unknown",
        journal: summarizeProductionJournal(journal),
        zeroWrite: true,
        zeroClick: true,
        action: "block",
      };
    }
    if (rec.action === "resume" && rec.claimProof) {
      productionClaimProof = rec.claimProof;
    }
    if (rec.action === "ack_only") {
      // Keep journal CLAIMED; CS recover observe path may still find the turn.
      // No write/click.
    }
  }

  const request = buildProductionRecoverRequest(owner, journal, safeInFlight);
  if (!request.ok) {
    return { ok: false, reason: request.reason, journal: summarizeProductionJournal(journal) };
  }
  productionSendInFlight = true;
  try {
    let response = null;
    try {
      response = await chrome.tabs.sendMessage(
        request.tabId,
        request.message,
        request.sendOptions,
      );
    } catch {
      response = null;
    }
    if (response == null) {
      return {
        ok: false,
        reason: "production_recover_rpc_failed",
        journal: summarizeProductionJournal(journal),
        zeroWrite: true,
        zeroClick: true,
      };
    }
    return {
      ok: response.ok === true,
      reason: response.reason,
      recovered: response.recovered === true,
      action: response.action,
      journal: summarizeProductionJournal(journal),
      retryAck: response.retryAck === true,
      zeroWrite: response.zeroWrite === true,
      zeroClick: response.zeroClick === true,
      diagnostic: response.diagnostic ?? null,
    };
  } finally {
    productionSendInFlight = false;
  }
}

/**
 * Manual-only outcome_unknown retirement. Zero DOM mutation.
 * Identity always from durable local journal; popup/CS never supply replaceable identity.
 * Local clear only after exact server retirement success.
 */
async function handleRetireUnknown() {
  await initPromise;
  const gate = requireProtectedTransport();
  if (!gate.ok) return gate;
  if (journal.state !== "OUTCOME_UNKNOWN") {
    return {
      ok: false,
      reason: "journal_not_outcome_unknown",
      journal: summarizeProductionJournal(journal),
      zeroWrite: true,
      zeroClick: true,
      beginSendCalled: false,
      ackCalled: false,
    };
  }
  if (!journal.eventId || !journal.reservationId || !journal.attemptId) {
    return {
      ok: false,
      reason: "journal_identity_missing",
      journal: summarizeProductionJournal(journal),
      zeroWrite: true,
      zeroClick: true,
      beginSendCalled: false,
      ackCalled: false,
    };
  }

  // Confirm server state before mutating.
  // - exact outcome_unknown → proceed to /retire-unknown
  // - inFlight=null → server may already be retired_unknown from a prior
  //   successful retire whose local clear failed; allow idempotent reconcile
  //   via /retire-unknown. Never clear local journal on null alone.
  // - any other non-null inFlight → fail closed.
  const stateRes = await handleFetchState();
  if (!stateRes.ok) {
    return {
      ok: false,
      reason: stateRes.reason || "state_fetch_failed",
      journal: summarizeProductionJournal(journal),
      zeroWrite: true,
      zeroClick: true,
      beginSendCalled: false,
      ackCalled: false,
    };
  }
  const inFlight = stateRes.status?.inFlight ?? null;
  if (inFlight != null) {
    if (
      inFlight.status !== "outcome_unknown"
      || inFlight.eventId !== journal.eventId
      || inFlight.reservationId !== journal.reservationId
      || inFlight.attemptId !== journal.attemptId
    ) {
      return {
        ok: false,
        reason: "server_inflight_mismatch",
        journal: summarizeProductionJournal(journal),
        zeroWrite: true,
        zeroClick: true,
        beginSendCalled: false,
        ackCalled: false,
      };
    }
  }
  // inFlight === null: fall through to /retire-unknown as idempotent reconcile.
  // Exact response validation below is the only authority for local clear.

  let res;
  try {
    res = await fetchCompanion("/retire-unknown", {
      method: "POST",
      body: JSON.stringify({
        routeCanonical: journal.routeCanonical,
        eventId: journal.eventId,
        reservationId: journal.reservationId,
        attemptId: journal.attemptId,
      }),
    });
  } catch {
    return {
      ok: false,
      reason: "network_unreachable",
      journal: summarizeProductionJournal(journal),
      zeroWrite: true,
      zeroClick: true,
      beginSendCalled: false,
      ackCalled: false,
    };
  }
  if (res.status === 401) {
    return markAuthStale(res.body?.error || "COMPANION_UNAUTHORIZED");
  }
  if (!res.ok) {
    return {
      ok: false,
      reason: res.body?.error || `http_${res.status}`,
      status: res.status,
      journal: summarizeProductionJournal(journal),
      zeroWrite: true,
      zeroClick: true,
      beginSendCalled: false,
      ackCalled: false,
    };
  }
  assertNoForbiddenFields(res.body);
  const body = res.body || {};
  if (
    body.eventId !== journal.eventId
    || body.reservationId !== journal.reservationId
    || body.attemptId !== journal.attemptId
    || body.status !== "retired_unknown"
  ) {
    return {
      ok: false,
      reason: "retire_response_invalid",
      journal: summarizeProductionJournal(journal),
      zeroWrite: true,
      zeroClick: true,
      beginSendCalled: false,
      ackCalled: false,
    };
  }

  // Server retirement proven. Clear durable local journal. Rollback on persist failure.
  const previousJournal = journal;
  try {
    journal = clearJournal();
    await persistJournal();
  } catch (error) {
    journal = previousJournal;
    return {
      ok: false,
      reason: "journal_persist_failed",
      error: String(error?.message || error),
      journal: summarizeProductionJournal(journal),
      serverRetired: true,
      zeroWrite: true,
      zeroClick: true,
      beginSendCalled: false,
      ackCalled: false,
    };
  }
  productionClaimProof = null;
  productionAckProof = null;
  return {
    ok: true,
    retired: true,
    eventId: previousJournal.eventId,
    reservationId: previousJournal.reservationId,
    attemptId: previousJournal.attemptId,
    journal: summarizeProductionJournal(journal),
    zeroWrite: true,
    zeroClick: true,
    beginSendCalled: false,
    ackCalled: false,
  };
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
