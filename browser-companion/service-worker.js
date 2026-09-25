/**
 * C2C Browser Companion service worker (E1b2 + E1b3d3b production one-shot).
 * All Bridge HTTP + credential storage lives here.
 * Identity always from MessageSender. Secrets never in content script.
 * Production Send only via explicit popup request + durable journal CAS.
 */

import {
  emptyOwnerState,
  bindCurrentDocument,
  invalidateOnTabRemoved,
  isOwner,
  ownerStatus,
  resetSessionOwnership,
  resolveSenderDocumentIdentity,
  resolveCurrentDocumentBindingIdentity,
  resolveObservationRouteVerdict,
  applyObservationRouteVerdict,
  OWNERSHIP_SCHEMA_VERSION,
} from "./ownership.js";
import { areChatgptConversationRoutesEquivalent } from "./route-esm.js";
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
  buildOwnerLocalShadowInspectRequest,
  validateOwnerLocalShadowInspectResponse,
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
  ROUTE_ATTEST_SEND_TYPE,
  ROUTE_ATTEST_LATCH_KEY,
  ROUTE_ATTEST_FENCE_KEY,
  emptyRouteAttestLatch,
  emptyRouteAttestFence,
  parseRouteAttestLatch,
  parseRouteAttestFence,
  isRouteAttestationMessage,
  extractRouteChallengeId,
  validateRouteAttestPopupRequest,
  canStartRouteAttestSend,
  buildRouteAttestExecuteRequest,
  classifyRouteAttestRpcResult,
  syncTransportRouteVerification,
  applyRouteAttestServerVerification,
  applyRouteAttestServerVerificationToFence,
  shouldPollRouteAttestConfirm,
  markRouteAttestFenceDispatch,
  markRouteAttestFenceState,
  nextRouteAttestFenceAfterPair,
  markPairingTransitionBarrier,
  resolvePairFenceAfterSuccess,
  shouldRestorePairFenceAfterHttpError,
  reconcileRouteAttestAfterHydrate,
} from "./route-attestation.js";
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
import {
  CONNECT_FLOW_KEY,
  emptyConnectFlow,
  parseConnectFlow,
  connectFlowIdentity,
  connectFlowMatches,
  connectFlowTargetMatches,
  takeoverConnectFlowIdentity,
  beginConnectTakeover,
  observeConnectTakeover,
  beginConnectAttestation,
  requestConnectCompletion,
  finishConnectFlow,
} from "./connect-flow.js";
import {
  deriveCompanionIndicator,
  createCompanionIndicatorApplier,
} from "./action-indicator.js";
import {
  WAKE_WATCHDOG_ALARM_NAME,
  wakeWatchdogEligible,
  normalizeWakeReason,
  createWakeWatchdogController,
} from "./wake-watchdog.js";

const LOCAL_KEY = "c2c_companion_local_v1";
const TRANSPORT_KEY = "c2c_companion_transport_v1";
const JOURNAL_KEY = "c2c_companion_journal_v1";
const SESSION_OWNER_KEY = "c2c_companion_owner_v1";
const SESSION_REG_KEY = "c2c_companion_registry_v1";
const SESSION_EVIDENCE_KEY = "c2c_companion_evidence_v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === "string" && UUID.test(value);

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
/** G3 route-attestation session latch (tab/document/generation). Cleared by browser restart. */
let routeAttestLatch = emptyRouteAttestLatch();
/** G3 route-attestation durable fence (chrome.storage.local). Survives browser restart. */
let routeAttestFence = emptyRouteAttestFence();
/** G4c one-click orchestration fence (durable local). */
let connectFlow = emptyConnectFlow();
let connectInFlight = false;
let transportMutationInFlight = false;
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
let connectReason = null;
let lastEvaluatedEvidence = null;
let lastRecoveryAt = null;
let lastRecoveryResult = null;
let actionIndicatorRefreshSerial = 0;
const applyActionIndicator = createCompanionIndicatorApplier(() => chrome.action);
const wakeWatchdogController = createWakeWatchdogController(() => chrome.alarms);

const initPromise = (async () => {
  await hydrate();
})();

void initPromise.then(() => syncWakeWatchdog());

async function runTransportMutation(operation) {
  if (transportMutationInFlight) {
    return { ok: false, reason: "transport_mutation_in_flight", retryAllowed: true };
  }
  transportMutationInFlight = true;
  try {
    return await operation();
  } finally {
    transportMutationInFlight = false;
  }
}

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
    ROUTE_ATTEST_FENCE_KEY,
    CONNECT_FLOW_KEY,
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
    autonomyPolicy = disarmed.policy;
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
    ROUTE_ATTEST_LATCH_KEY,
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
  routeAttestLatch = parseRouteAttestLatch(live[ROUTE_ATTEST_LATCH_KEY]);
  // Durable fence is restart-safe authority. Session latch alone cannot authorize resend.
  const hydratedFence = parseRouteAttestFence(stored[ROUTE_ATTEST_FENCE_KEY]);
  const reconciled = reconcileRouteAttestAfterHydrate({
    fence: hydratedFence,
    sessionLatch: routeAttestLatch,
    transport,
  });
  routeAttestFence = reconciled.fence;
  routeAttestLatch = reconciled.sessionLatch;
  connectFlow = parseConnectFlow(stored[CONNECT_FLOW_KEY]);
  hydrated = true;
  void refreshActionIndicator();
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

async function persistRouteAttestLatch() {
  try {
    if (routeAttestLatch.state === "NONE") {
      await chrome.storage.session.remove(ROUTE_ATTEST_LATCH_KEY);
    } else {
      await chrome.storage.session.set({ [ROUTE_ATTEST_LATCH_KEY]: routeAttestLatch });
    }
    return true;
  } catch {
    return false;
  }
}

/** Durable challenge fence — chrome.storage.local. Fail closed on write error. */
async function persistRouteAttestFence() {
  try {
    if (routeAttestFence.state === "NONE" && !routeAttestFence.challengeId) {
      await chrome.storage.local.remove(ROUTE_ATTEST_FENCE_KEY);
    } else {
      await chrome.storage.local.set({ [ROUTE_ATTEST_FENCE_KEY]: routeAttestFence });
    }
    return true;
  } catch {
    return false;
  }
}

/** Persist session latch + durable fence together. Durable must succeed before mutation RPC. */
async function persistRouteAttestBoth() {
  const fenceOk = await persistRouteAttestFence();
  const latchOk = await persistRouteAttestLatch();
  return fenceOk && latchOk;
}

/**
 * Atomic pair durable commit: TRANSPORT + LOCAL + FENCE in one chrome.storage.local.set.
 * Returns false on any write failure — caller must keep PAIRING_TRANSITION barrier.
 */
async function commitPairDurableLocals({ nextTransport, nextLocal, nextFence, nextConnectFlow }) {
  if (!storageProtected) return false;
  try {
    const row = {
      [LOCAL_KEY]: nextLocal,
      [ROUTE_ATTEST_FENCE_KEY]: nextFence,
    };
    if (nextTransport) row[TRANSPORT_KEY] = nextTransport;
    if (nextConnectFlow) row[CONNECT_FLOW_KEY] = nextConnectFlow;
    await chrome.storage.local.set(row);
    return true;
  } catch {
    return false;
  }
}

async function persistConnectFlow() {
  try {
    await chrome.storage.local.set({ [CONNECT_FLOW_KEY]: connectFlow });
    return true;
  } catch {
    return false;
  }
}

async function persistConnectAndRouteFence() {
  try {
    await chrome.storage.local.set({
      [CONNECT_FLOW_KEY]: connectFlow,
      [ROUTE_ATTEST_FENCE_KEY]: routeAttestFence,
    });
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
    return true;
  }
  if (!transport) {
    await chrome.storage.local.remove(TRANSPORT_KEY);
    return true;
  }
  await chrome.storage.local.set({ [TRANSPORT_KEY]: transport });
  return true;
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
async function forceAutonomyOff(reason, { clearRearmPreference = false } = {}) {
  const previous = autonomyPolicy;
  const parsedPrevious = parseAutonomyPolicy(previous);
  autonomyPolicy = {
    ...emptyAutonomyPolicy(),
    lastProductionAttemptAt: parsedPrevious.lastProductionAttemptAt,
    rearmOnConnect: clearRearmPreference ? false : parsedPrevious.rearmOnConnect,
  };
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

async function rearmAutonomyAfterVerifiedConnect() {
  const current = parseAutonomyPolicy(autonomyPolicy);
  if (!current.rearmOnConnect) return { ok: true, mode: current.mode };
  const routeVerified = storageProtected === true
    && transport?.authStale !== true
    && transport?.rebindPending !== true
    && transport?.routeVerification === "VERIFIED"
    && typeof transport.bindingId === "string"
    && Number.isInteger(transport.epoch)
    && typeof transport.routeCanonical === "string"
    && ownerState.owner != null
    && areChatgptConversationRoutesEquivalent(ownerState.owner.canonicalRoute, transport.routeCanonical);
  if (!routeVerified) {
    lastAutonomyDecision = "off";
    lastAutonomyReason = "route_unverified";
    return { ok: false, mode: "off", reason: lastAutonomyReason };
  }
  const proposed = {
    ...emptyAutonomyPolicy(),
    mode: "armed",
    bindingId: transport.bindingId,
    epoch: transport.epoch,
    routeCanonical: transport.routeCanonical,
    armedAt: Date.now(),
    lastProductionAttemptAt: current.lastProductionAttemptAt,
    rearmOnConnect: true,
  };
  const commit = await commitAutonomyPolicy(proposed);
  if (!commit.ok) {
    lastAutonomyDecision = "off";
    lastAutonomyReason = "autonomy_rearm_persist_failed";
    return { ok: false, mode: "off", reason: lastAutonomyReason };
  }
  lastAutonomyDecision = null;
  lastAutonomyReason = null;
  return { ok: true, mode: "armed" };
}

async function persistSessionOwnership() {
  await chrome.storage.session.set({
    [SESSION_OWNER_KEY]: ownerState.owner,
    [SESSION_REG_KEY]: ownerState.registry,
    [SESSION_EVIDENCE_KEY]: evidence,
  });
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
    routeVerification: transport.routeVerification === "VERIFIED" ? "VERIFIED" : "PENDING",
    productionEligible: transport.routeVerification === "VERIFIED",
    rebindPending: transport.rebindPending === true,
    connectState: connectFlow.state,
    pairedAt: transport.pairedAt,
  };
}

function actionIndicatorInput(bridgePermissionGranted, bridgeOriginInvalid = false) {
  const summary = safeTransportSummary();
  return {
    hydrated,
    storageProtected,
    transportPresent: Boolean(transport),
    bridgePermissionGranted,
    bridgeOriginInvalid,
    transport: summary,
    owner: ownerState.owner
      ? { available: true, canonicalRoute: ownerState.owner.canonicalRoute }
      : { available: false, canonicalRoute: null },
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
    journal: summarizeProductionJournal(journal),
    routeAttestFence: { state: routeAttestFence.state },
    connectFlow: { state: connectFlow.state },
    productionSendInFlight,
  };
}

async function refreshActionIndicator() {
  const serial = ++actionIndicatorRefreshSerial;
  const currentTransport = transport;
  let bridgePermissionGranted = false;
  let bridgeOriginInvalid = false;
  const bridgeOrigin = currentTransport?.bridgeOrigin;
  if (bridgeOrigin) {
    let canonical = null;
    try {
      canonical = parseBridgeOrigin(bridgeOrigin, {
        allowLoopbackHttp: bridgeOrigin.startsWith("http://"),
      });
    } catch {
      bridgeOriginInvalid = true;
    }
    if (canonical) {
      try {
        bridgePermissionGranted = await chrome.permissions?.contains?.({
          origins: [`${canonical}/*`],
        }) === true;
      } catch {
        bridgePermissionGranted = false;
      }
    }
  }
  if (serial !== actionIndicatorRefreshSerial) return;
  await applyActionIndicator(deriveCompanionIndicator(
    actionIndicatorInput(bridgePermissionGranted, bridgeOriginInvalid),
  ));
}

function wakeWatchdogInput() {
  return {
    storageProtected,
    transport: transport
      ? { bridgeOrigin: transport.bridgeOrigin, authStale: transport.authStale === true }
      : null,
    autonomyMode: parseAutonomyPolicy(autonomyPolicy).mode,
    journalState: journal?.state ?? "NONE",
  };
}

/**
 * MV3 wake watchdog is discovery-only. It never owns a page sender or a
 * production tick; /state reconciliation remains the only network action.
 */
async function syncWakeWatchdog({ verify = false } = {}) {
  await initPromise;
  const result = await wakeWatchdogController.sync(
    wakeWatchdogEligible(wakeWatchdogInput()),
    { verify },
  ).catch(() => null);
  return result?.ok === true;
}

async function handleWakeWatchdogAlarm(alarm) {
  if (!alarm || alarm.name !== WAKE_WATCHDOG_ALARM_NAME) {
    return { ok: false, reason: "alarm_ignored" };
  }
  await initPromise;
  if (!wakeWatchdogEligible(wakeWatchdogInput())) {
    await syncWakeWatchdog({ verify: true });
    return { ok: false, reason: "watchdog_ineligible" };
  }
  const state = await handleFetchState();
  await syncWakeWatchdog({ verify: true });
  await refreshActionIndicator();
  return {
    ok: state?.ok === true,
    reason: state?.ok === true ? undefined : normalizeWakeReason(state?.reason),
    discoveryOnly: true,
  };
}

/** Ask only the known active owner tab for a real content-script heartbeat. */
async function requestActiveOwnerRefresh(expectedTabId = null) {
  await initPromise;
  const owner = ownerState.owner;
  if (
    !owner
    || typeof owner.documentId !== "string"
    || owner.documentId.length === 0
    || (expectedTabId != null && owner.tabId !== expectedTabId)
  ) return false;
  if (typeof chrome.tabs?.query !== "function" || typeof chrome.tabs?.sendMessage !== "function") return false;
  let tabs;
  try {
    tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch {
    return false;
  }
  const active = Array.isArray(tabs) && tabs.find((tab) => tab?.id === owner.tabId);
  if (!active || active.id !== owner.tabId) return false;
  try {
    await chrome.tabs.sendMessage(owner.tabId, {
      type: "c2c.wake.refresh",
      reason: "resume",
    }, { documentId: owner.documentId });
    return true;
  } catch {
    return false;
  }
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
    routeAttestLatch: routeAttestLatch.state,
    routeAttestFence: routeAttestFence.state,
    connectState: connectFlow.state,
    connectReason,
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
  await forceAutonomyOff("unbind", { clearRearmPreference: true });
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
 * Atomically apply sender identity plus runtime freshness/safety before any
 * owner-gated action; route authority is the browser tab URL, with the
 * content-script canonicalRoute as a mandatory-equivalence witness (R3o).
 */
async function refreshPageObservation(sender, message) {
  const identity = resolveSenderDocumentIdentity(sender);
  if (!identity.ok && identity.reason !== "document_id_unavailable") {
    return { ok: false, reason: identity.reason };
  }
  const tabId = identity.ok || identity.reason === "document_id_unavailable" ? identity.tabId : null;
  const documentId = identity.ok ? identity.documentId : null;
  const generation = Number.isFinite(message?.generation) ? Number(message.generation) : 1;
  const verdict = resolveObservationRouteVerdict(sender, message?.canonicalRoute ?? null);
  const applied = applyObservationRouteVerdict(ownerState, {
    tabId: tabId ?? -1,
    documentId,
    verdict: verdict.verdict,
    canonicalRoute: verdict.canonicalRoute ?? null,
    generation,
    now: Date.now(),
  });

  if (applied.applied === "dropped") {
    // Non-owner document failed the authority/witness check (R3o): preserve the
    // current owner, evidence and owner proof untouched (stale-document guard).
    return { ok: false, reason: "route_witness_mismatch", tabId, documentId };
  }
  ownerState = applied.state;
  if (applied.applied === "owner_invalidated") {
    // Exact owner document contradicted the browser authority (R3o): the owner
    // goes away together with its runtime evidence and outstanding proof.
    evidence = null;
    ownerProof = null;
    await persistSessionOwnership();
    return { ok: false, reason: "route_witness_mismatch", tabId, documentId };
  }
  const canonical = verdict.verdict === "match" ? verdict.canonicalRoute : null;

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
      && areChatgptConversationRoutesEquivalent(ownerState.owner?.canonicalRoute, canonical),
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

  // Capture TRUE previous state BEFORE any global mutation or server call.
  const prevTransport = transport;
  const prevLocal = localState;
  const prevFence = routeAttestFence;
  const prevLatch = routeAttestLatch;
  const prevConnectFlow = connectFlow;

  // Barrier-first: durable PAIRING_TRANSITION before any server mutation.
  // Blocks all route-attestation DOM Send, including old PENDING challenge.
  const barrier = markPairingTransitionBarrier(prevFence, Date.now());
  routeAttestFence = barrier;
  const barrierOk = await persistRouteAttestFence();
  if (!barrierOk) {
    routeAttestFence = prevFence;
    return {
      ok: false,
      reason: "pair_barrier_persist_failed",
      routeAttestFence: prevFence?.state ?? "NONE",
      retryAllowed: true,
    };
  }

  let res;
  try {
    res = await fetch(companionApiUrl(origin, "/pair"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intentId: message.intentId,
        secret: message.secret,
        routeCanonical,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Network timeout / connection loss: server may already have superseded companion.
    // Keep barrier — zero route-attestation DOM Send for old or new challenge.
    return {
      ok: false,
      reason: "pair_outcome_unknown",
      routeAttestFence: "PAIRING_TRANSITION",
      retryAllowed: false,
    };
  }

  let body = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }

  if (!res.ok) {
    // Clear 4xx: companion contract — request rejected, no pair mutation. Restore prev fence.
    // 5xx / other: outcome unknown — keep barrier.
    if (shouldRestorePairFenceAfterHttpError(res.status)) {
      routeAttestFence = prevFence;
      await persistRouteAttestFence().catch(() => false);
      return {
        ok: false,
        reason: body.error || `http_${res.status}`,
        status: res.status,
        routeAttestFence: prevFence?.state ?? "NONE",
      };
    }
    return {
      ok: false,
      reason: body.error || `http_${res.status}`,
      status: res.status,
      routeAttestFence: "PAIRING_TRANSITION",
      retryAllowed: false,
    };
  }

  assertNoForbiddenFields(body);
  if (
    !areChatgptConversationRoutesEquivalent(body.routeCanonical, routeCanonical)
    || typeof body.credential !== "string"
    || typeof body.workspaceId !== "string"
    || typeof body.companionId !== "string"
    || typeof body.bindingId !== "string"
    || typeof body.epoch !== "number"
  ) {
    // 2xx but invalid body — server may have mutated. Keep barrier.
    return {
      ok: false,
      reason: "pair_response_invalid",
      routeAttestFence: "PAIRING_TRANSITION",
      retryAllowed: false,
    };
  }

  // Build next* locals — never mutate transport/localState/fence before durable commit.
  const nextTransport = {
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
    routeVerification: body.routeVerification === "VERIFIED" ? "VERIFIED" : "PENDING",
    routeAttestationMessage: typeof body.routeAttestation?.message === "string"
      ? body.routeAttestation.message
      : null,
    routeAttestationExpiresAt: typeof body.routeAttestation?.expiresAt === "string"
      ? body.routeAttestation.expiresAt
      : null,
  };
  const nextLocal = { ...prevLocal, paired: true, targetRoute: routeCanonical };
  const newChallengeId = extractRouteChallengeId(body.routeAttestation?.message);
  const fenceResolved = resolvePairFenceAfterSuccess({
    prevFence: barrier,
    companionId: body.companionId,
    challengeId: newChallengeId,
    routeCanonical,
    now: Date.now(),
  });
  let nextFence;
  if (fenceResolved.ok) {
    nextFence = fenceResolved.fence;
  } else {
    // Missing new identity after 2xx: fail closed OUTCOME_UNKNOWN, never NONE.
    nextFence = markRouteAttestFenceState(barrier, "OUTCOME_UNKNOWN");
  }
  const nextLatch = emptyRouteAttestLatch();
  const nextConnectFlow = emptyConnectFlow();

  // Atomic durable commit: TRANSPORT_KEY + LOCAL_KEY + ROUTE_ATTEST_FENCE_KEY.
  const commitOk = await commitPairDurableLocals({
    nextTransport,
    nextLocal,
    nextFence,
    nextConnectFlow,
  });
  if (!commitOk) {
    // Keep barrier. Do not switch memory to new transport. Zero DOM Send.
    transport = prevTransport;
    localState = prevLocal;
    routeAttestFence = barrier;
    routeAttestLatch = prevLatch;
    connectFlow = prevConnectFlow;
    try {
      await persistRouteAttestFence();
    } catch {
      // barrier may already be durable from pre-fetch write
    }
    return {
      ok: false,
      reason: "pair_durable_commit_failed",
      routeAttestFence: "PAIRING_TRANSITION",
      retryAllowed: false,
    };
  }

  // Durable success — switch memory only now.
  transport = nextTransport;
  connectReason = null;
  localState = nextLocal;
  routeAttestFence = nextFence;
  routeAttestLatch = nextLatch;
  connectFlow = nextConnectFlow;

  try {
    await persistRouteAttestLatch();
  } catch {
    // Session latch write failure only multi-blocks; durable fence already NONE/matching.
  }

  const disarmed = disarmOnIdentityChange(autonomyPolicy, transport);
  if (disarmed.changed) {
    await forceAutonomyOff("identity_disarm");
  }

  return { ok: true, transport: safeTransportSummary() };
}

async function handleRebindStart(message) {
  if (!storageProtected) return { ok: false, reason: "storage_unprotected" };
  if (!transport?.bridgeOrigin || !transport?.credential) {
    return { ok: false, reason: "transport_missing" };
  }
  if (!pairAllowedWithJournal(journal, false)) {
    return { ok: false, reason: "journal_active" };
  }
  if (!ownerState.owner) return { ok: false, reason: "not_exact_owner" };
  const routeCanonical = ownerState.owner.canonicalRoute;
  const ownerAtStart = { ...ownerState.owner };
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
  const prevTransport = transport;
  const prevLocal = localState;
  const prevFence = routeAttestFence;
  const prevLatch = routeAttestLatch;
  const barrier = markPairingTransitionBarrier(prevFence, Date.now());
  routeAttestFence = barrier;
  if (!await persistRouteAttestFence()) {
    routeAttestFence = prevFence;
    return { ok: false, reason: "rebind_barrier_persist_failed", retryAllowed: true };
  }

  let res;
  try {
    res = await fetch(companionApiUrl(prevTransport.bridgeOrigin, "/rebind/init"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${prevTransport.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ routeCanonical }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return {
      ok: false,
      reason: "rebind_init_outcome_unknown",
      routeAttestFence: "PAIRING_TRANSITION",
      retryAllowed: false,
    };
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (shouldRestorePairFenceAfterHttpError(res.status)) {
      routeAttestFence = prevFence;
      await persistRouteAttestFence().catch(() => false);
    }
    return {
      ok: false,
      reason: body.error || `http_${res.status}`,
      status: res.status,
      routeAttestFence: res.status >= 400 && res.status < 500
        ? prevFence?.state ?? "NONE"
        : "PAIRING_TRANSITION",
      retryAllowed: res.status >= 400 && res.status < 500,
    };
  }
  if (!isOwner(ownerState, ownerAtStart.tabId, ownerAtStart.documentId)
    || !areChatgptConversationRoutesEquivalent(ownerState.owner?.canonicalRoute, ownerAtStart.canonicalRoute)
    || ownerState.owner?.generation !== ownerAtStart.generation) {
    routeAttestFence = markRouteAttestFenceState(barrier, "OUTCOME_UNKNOWN");
    await persistRouteAttestFence().catch(() => false);
    return {
      ok: false,
      reason: "owner_identity_changed",
      routeAttestFence: "OUTCOME_UNKNOWN",
      retryAllowed: false,
    };
  }
  assertNoForbiddenFields(body);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      reason: "rebind_init_response_invalid",
      routeAttestFence: "PAIRING_TRANSITION",
      retryAllowed: false,
    };
  }
  const challengeId = extractRouteChallengeId(body.routeAttestation?.message);
  const responseIdentityValid = typeof prevTransport.workspaceId === "string"
    && prevTransport.workspaceId.length > 0
    && body.workspaceId === prevTransport.workspaceId
    && typeof routeCanonical === "string"
    && routeCanonical.length > 0
    && areChatgptConversationRoutesEquivalent(body.routeCanonical, routeCanonical)
    && Number.isInteger(prevTransport.epoch)
    && prevTransport.epoch >= 0
    && Number.isInteger(body.epoch)
    && body.epoch >= 0
    && body.epoch === prevTransport.epoch + 1
    && isUuid(prevTransport.companionId)
    && isUuid(body.companionId)
    && body.companionId !== prevTransport.companionId
    && isUuid(prevTransport.bindingId)
    && isUuid(body.bindingId)
    && body.bindingId !== prevTransport.bindingId
    && isUuid(body.routeAttestation?.challengeId)
    && body.routeAttestation.challengeId === challengeId
    && typeof body.routeAttestation?.message === "string";
  if (!responseIdentityValid) {
    return {
      ok: false,
      reason: "rebind_init_response_invalid",
      routeAttestFence: "PAIRING_TRANSITION",
      retryAllowed: false,
    };
  }
  const fenceResolved = resolvePairFenceAfterSuccess({
    prevFence: barrier,
    companionId: body.companionId,
    challengeId,
    routeCanonical,
    now: Date.now(),
  });
  if (!fenceResolved.ok) {
    routeAttestFence = markRouteAttestFenceState(barrier, "OUTCOME_UNKNOWN");
    await persistRouteAttestFence().catch(() => false);
    return {
      ok: false,
      reason: "rebind_init_response_invalid",
      routeAttestFence: "OUTCOME_UNKNOWN",
      retryAllowed: false,
    };
  }
  const nextFence = fenceResolved.fence;
  const nextTransport = {
    ...prevTransport,
    workspaceId: body.workspaceId,
    companionId: body.companionId,
    bindingId: body.bindingId,
    epoch: body.epoch,
    routeCanonical,
    pairedAt: new Date().toISOString(),
    authStale: false,
    routeVerification: "PENDING",
    routeAttestationMessage: body.routeAttestation.message,
    routeAttestationExpiresAt: typeof body.routeAttestation.expiresAt === "string"
      ? body.routeAttestation.expiresAt
      : null,
    rebindPending: true,
  };
  const nextLocal = { ...prevLocal, paired: true, targetRoute: routeCanonical };
  if (!await commitPairDurableLocals({ nextTransport, nextLocal, nextFence })) {
    transport = prevTransport;
    localState = prevLocal;
    routeAttestFence = barrier;
    routeAttestLatch = prevLatch;
    await persistRouteAttestFence().catch(() => false);
    return {
      ok: false,
      reason: "rebind_init_durable_commit_failed",
      routeAttestFence: "PAIRING_TRANSITION",
      retryAllowed: false,
    };
  }
  transport = nextTransport;
  connectReason = null;
  localState = nextLocal;
  routeAttestFence = nextFence;
  routeAttestLatch = emptyRouteAttestLatch();
  await persistRouteAttestLatch().catch(() => false);
  await forceAutonomyOff("identity_disarm");
  return { ok: true, transport: safeTransportSummary() };
}

async function handleRebindComplete({ managed = false } = {}) {
  if (!storageProtected) return { ok: false, reason: "storage_unprotected" };
  if (!transport?.rebindPending || !transport.bridgeOrigin || !transport.credential) {
    return { ok: false, reason: "rebind_not_pending" };
  }
  if (!pairAllowedWithJournal(journal, false)) {
    return { ok: false, reason: "journal_active" };
  }
  if (!ownerState.owner || !areChatgptConversationRoutesEquivalent(ownerState.owner.canonicalRoute, transport.routeCanonical)) {
    return { ok: false, reason: "not_exact_owner" };
  }
  const challengeId = extractRouteChallengeId(transport.routeAttestationMessage);
  if (!challengeId) return { ok: false, reason: "rebind_challenge_missing", retryAllowed: false };
  const identity = connectFlowIdentity(transport);
  if (managed) {
    if (!identity || !connectFlowMatches(connectFlow, identity)
      || connectFlow.state !== "COMPLETE_REQUESTED") {
      return { ok: false, reason: "connect_completion_not_requested", retryAllowed: false };
    }
  } else if (["ATTEST_REQUESTED", "COMPLETE_REQUESTED", "OUTCOME_UNKNOWN"].includes(connectFlow.state)) {
    return { ok: false, reason: "connect_managed", retryAllowed: false };
  }
  let res;
  try {
    res = await fetch(companionApiUrl(transport.bridgeOrigin, "/rebind/complete"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${transport.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ challengeId, routeCanonical: transport.routeCanonical }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    routeAttestFence = markRouteAttestFenceState(routeAttestFence, "OUTCOME_UNKNOWN");
    if (identity) connectFlow = finishConnectFlow(connectFlow, identity, "OUTCOME_UNKNOWN");
    await persistConnectAndRouteFence().catch(() => false);
    return { ok: false, reason: "rebind_complete_outcome_unknown", retryAllowed: false };
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const deterministicNoMutation = managed
      && ["COMPANION_REPAIR_BLOCKED", "COMPANION_REBIND_NOT_CONFIRMED"].includes(body.error);
    if (deterministicNoMutation && identity) {
      connectFlow = { ...connectFlow, state: "ATTEST_REQUESTED", updatedAt: Date.now() };
      if (!await persistConnectFlow()) {
        connectFlow = finishConnectFlow(connectFlow, identity, "OUTCOME_UNKNOWN");
        await persistConnectFlow().catch(() => false);
        return { ok: false, reason: "connect_completion_fence_persist_failed", retryAllowed: false };
      }
      return {
        ok: false,
        reason: body.error,
        status: res.status,
        state: "ATTEST_REQUESTED",
        retryAllowed: true,
      };
    }
    if (managed || res.status >= 500) {
      routeAttestFence = markRouteAttestFenceState(routeAttestFence, "OUTCOME_UNKNOWN");
      if (identity) connectFlow = finishConnectFlow(connectFlow, identity, "OUTCOME_UNKNOWN");
      await persistConnectAndRouteFence().catch(() => false);
    }
    return {
      ok: false,
      reason: body.error || `http_${res.status}`,
      status: res.status,
      retryAllowed: !managed && res.status === 409 && body.error === "COMPANION_REBIND_NOT_CONFIRMED",
    };
  }
  assertNoForbiddenFields(body);
  if (body.workspaceId !== transport.workspaceId
    || body.companionId !== transport.companionId
    || body.bindingId !== transport.bindingId
    || body.epoch !== transport.epoch
    || !areChatgptConversationRoutesEquivalent(body.routeCanonical, transport.routeCanonical)
    || body.challengeId !== challengeId
    || typeof body.credential !== "string"
    || !body.credential.startsWith("c2c_comp_")
    || body.credential.length > 256) {
    routeAttestFence = markRouteAttestFenceState(routeAttestFence, "OUTCOME_UNKNOWN");
    if (identity) connectFlow = finishConnectFlow(connectFlow, identity, "OUTCOME_UNKNOWN");
    await persistConnectAndRouteFence().catch(() => false);
    return { ok: false, reason: "rebind_complete_response_invalid", retryAllowed: false };
  }
  const nextTransport = {
    ...transport,
    credential: body.credential,
    authStale: false,
    routeVerification: "PENDING",
    rebindPending: false,
  };
  const nextConnectFlow = identity
    ? finishConnectFlow(connectFlow, identity, "DONE")
    : connectFlow;
  if (!await commitPairDurableLocals({
    nextTransport,
    nextLocal: localState,
    nextFence: routeAttestFence,
    nextConnectFlow,
  })) {
    routeAttestFence = markRouteAttestFenceState(routeAttestFence, "OUTCOME_UNKNOWN");
    if (identity) connectFlow = finishConnectFlow(connectFlow, identity, "OUTCOME_UNKNOWN");
    await persistConnectAndRouteFence().catch(() => false);
    return { ok: false, reason: "rebind_complete_durable_commit_failed", retryAllowed: false };
  }
  transport = nextTransport;
  connectFlow = nextConnectFlow;
  await forceAutonomyOff("identity_disarm");
  const stateRes = await handleFetchState();
  const verified = stateRes?.ok === true && stateRes?.status?.routeVerification === "VERIFIED";
  const autonomy = managed && verified
    ? await rearmAutonomyAfterVerifiedConnect()
    : { ok: true, mode: parseAutonomyPolicy(autonomyPolicy).mode };
  return {
    ok: verified,
    reason: stateRes?.ok ? undefined : stateRes?.reason,
    routeVerification: stateRes?.status?.routeVerification ?? "PENDING",
    productionEligible: stateRes?.status?.productionEligible === true,
    autonomy: autonomy.mode,
    autonomyReason: autonomy.ok ? undefined : autonomy.reason,
    retryAllowed: false,
  };
}

async function fetchRebindStatus(identity) {
  let res;
  try {
    const query = `?routeCanonical=${encodeURIComponent(identity.routeCanonical)}`
      + `&challengeId=${encodeURIComponent(identity.challengeId)}`;
    res = await fetchCompanion(`/rebind/status${query}`, { method: "GET" });
  } catch {
    return { ok: false, reason: "rebind_status_unreachable" };
  }
  if (!res.ok) {
    return { ok: false, reason: res.body?.error || `http_${res.status}`, status: res.status };
  }
  assertNoForbiddenFields(res.body);
  const body = res.body || {};
  const valid = Object.keys(body).sort().join(",")
      === "bindingId,challengeId,companionId,epoch,routeCanonical,state,workspaceId"
    && body.workspaceId === identity.workspaceId
    && body.bindingId === identity.bindingId
    && body.epoch === identity.epoch
    && body.companionId === identity.companionId
    && areChatgptConversationRoutesEquivalent(body.routeCanonical, identity.routeCanonical)
    && body.challengeId === identity.challengeId
    && ["PENDING", "CONFIRMED", "EXPIRED"].includes(body.state);
  return valid
    ? { ok: true, state: body.state }
    : { ok: false, reason: "rebind_status_response_invalid" };
}

async function maybeCompleteConnectedRebind(ownerExact) {
  if (ownerExact !== true || !transport?.rebindPending) return { ok: false, reason: "not_pending" };
  const identity = connectFlowIdentity(transport);
  if (!identity || !connectFlowMatches(connectFlow, identity)
    || connectFlow.state !== "ATTEST_REQUESTED") {
    return { ok: false, reason: "connect_not_pollable" };
  }
  if (routeAttestFence.state !== "OBSERVED_PENDING_CONFIRM") {
    return { ok: false, reason: "attestation_not_observed" };
  }
  const status = await fetchRebindStatus(identity);
  if (!status.ok || status.state !== "CONFIRMED") return status;

  const requested = requestConnectCompletion(connectFlow, identity);
  if (!requested.ok) return requested;
  connectFlow = requested.flow;
  if (!await persistConnectFlow()) {
    connectFlow = finishConnectFlow(connectFlow, identity, "OUTCOME_UNKNOWN");
    await persistConnectFlow().catch(() => false);
    return { ok: false, reason: "connect_completion_fence_persist_failed", retryAllowed: false };
  }
  return handleRebindComplete({ managed: true });
}

function ownerStillMatches(owner) {
  return Boolean(
    owner
    && ownerState.owner
    && isOwner(ownerState, owner.tabId, owner.documentId)
    && ownerState.owner.generation === owner.generation
    && areChatgptConversationRoutesEquivalent(ownerState.owner.canonicalRoute, owner.canonicalRoute),
  );
}

async function dispatchFeedbackBootstrap(identity) {
  const owner = ownerState.owner ? { ...ownerState.owner } : null;
  if (!owner || !isOwner(ownerState, owner.tabId, owner.documentId)
    || !areChatgptConversationRoutesEquivalent(owner.canonicalRoute, identity.routeCanonical)) {
    return { ok: false, reason: "not_exact_owner", retryAllowed: false };
  }
  const previous = connectFlow;
  connectReason = null;
  const begun = beginConnectTakeover(connectFlow, identity);
  if (!begun.ok) return { ok: false, reason: begun.reason, state: begun.flow.state, retryAllowed: false };
  connectFlow = begun.flow;
  if (!await persistConnectFlow()) {
    connectFlow = finishConnectFlow(connectFlow, identity, "OUTCOME_UNKNOWN");
    await persistConnectFlow().catch(() => false);
    return { ok: false, reason: "bootstrap_fence_persist_failed", state: "OUTCOME_UNKNOWN", retryAllowed: false };
  }

  let response;
  try {
    response = await chrome.tabs.sendMessage(owner.tabId, {
      type: "c2c.feedback.bootstrap.execute",
      expectedRoute: owner.canonicalRoute,
      expectedGeneration: owner.generation,
    }, { documentId: owner.documentId });
  } catch {
    connectFlow = finishConnectFlow(connectFlow, identity, "OUTCOME_UNKNOWN");
    await persistConnectFlow().catch(() => false);
    return { ok: false, reason: "bootstrap_outcome_unknown", state: "OUTCOME_UNKNOWN", retryAllowed: false };
  }

  const responseIdentityMatches = response?.type === "c2c.feedback.bootstrap.result"
    && response.mode === "feedback_bootstrap_send"
    && response.generation === owner.generation
    && areChatgptConversationRoutesEquivalent(response.canonicalRoute, owner.canonicalRoute)
    && ownerStillMatches(owner);
  if (responseIdentityMatches && response.ok === true
    && response.mutationAttempted === true
    && response.clickAttempted === true
    && response.clicked === true
    && response.observed === true) {
    connectFlow = observeConnectTakeover(connectFlow, identity);
    if (!await persistConnectFlow()) {
      connectFlow = finishConnectFlow(connectFlow, identity, "OUTCOME_UNKNOWN");
      await persistConnectFlow().catch(() => false);
      return { ok: false, reason: "bootstrap_observation_fence_persist_failed", state: "OUTCOME_UNKNOWN", retryAllowed: false };
    }
    return { ok: true, state: "WAITING_TAKEOVER", retryAllowed: false };
  }

  const provenNoMutation = responseIdentityMatches
    && response.ok === false
    && response.mutationAttempted !== true
    && response.clickAttempted !== true
    && response.observed !== true;
  if (provenNoMutation) {
    connectFlow = previous;
    if (await persistConnectFlow()) {
      return { ok: false, reason: response.reason || "bootstrap_not_dispatched", state: connectFlow.state, retryAllowed: true };
    }
  }
  connectFlow = finishConnectFlow(connectFlow, identity, "OUTCOME_UNKNOWN");
  await persistConnectFlow().catch(() => false);
  return { ok: false, reason: response?.reason || "bootstrap_outcome_unknown", state: "OUTCOME_UNKNOWN", retryAllowed: false };
}

async function dispatchConnectRouteAttestation({ resumeExisting = false } = {}) {
  if (!ownerState.owner
    || !areChatgptConversationRoutesEquivalent(ownerState.owner.canonicalRoute, transport?.routeCanonical)) {
    return { ok: false, reason: "not_exact_owner", retryAllowed: false };
  }
  const flowIdentity = connectFlowIdentity(transport);
  if (!flowIdentity) return { ok: false, reason: "connect_identity_invalid", retryAllowed: false };
  let begun;
  if (connectFlow.state === "ATTEST_REQUESTED" && connectFlowMatches(connectFlow, flowIdentity)) {
    if (!resumeExisting || connectFlow.bootstrapAutoResume !== true || routeAttestFence.state !== "NONE") {
      return { ok: false, reason: "connect_active", state: connectFlow.state, retryAllowed: false };
    }
    begun = { ok: true, flow: connectFlow };
  } else {
    begun = beginConnectAttestation(connectFlow, flowIdentity);
  }
  if (!begun.ok) {
    return {
      ok: begun.reason === "already_connected",
      reason: begun.reason,
      state: connectFlow.state,
      retryAllowed: false,
    };
  }
  connectFlow = begun.flow;
  if (!await persistConnectFlow()) {
    connectFlow = finishConnectFlow(connectFlow, flowIdentity, "OUTCOME_UNKNOWN");
    await persistConnectFlow().catch(() => false);
    return { ok: false, reason: "connect_fence_persist_failed", state: "OUTCOME_UNKNOWN", retryAllowed: false };
  }

  const attested = await handleMessage(
    { type: ROUTE_ATTEST_SEND_TYPE },
    {},
    { transportMutationHeld: true },
  );
  if (!attested?.ok) {
    const noMutation = attested?.mutationAttempted !== true
      && attested?.clickAttempted !== true
      && routeAttestLatch.state === "NONE"
      && routeAttestFence.state === "NONE";
    if (noMutation && connectFlow.bootstrapAutoResume !== true) {
      connectFlow = emptyConnectFlow();
      if (!await persistConnectFlow()) {
        connectFlow = finishConnectFlow(connectFlow, flowIdentity, "OUTCOME_UNKNOWN");
        await persistConnectFlow().catch(() => false);
        return { ok: false, reason: "connect_fence_persist_failed", state: "OUTCOME_UNKNOWN", retryAllowed: false };
      }
      return { ...attested, state: "NONE", retryAllowed: true };
    }
    if (noMutation && connectFlow.bootstrapAutoResume === true) {
      // The takeover already succeeded. Keep the exact successor identity so an
      // exact owner heartbeat may retry only this proven pre-dispatch route check.
      if (!await persistConnectFlow()) {
        connectFlow = finishConnectFlow(connectFlow, flowIdentity, "OUTCOME_UNKNOWN");
        await persistConnectFlow().catch(() => false);
        return { ok: false, reason: "connect_fence_persist_failed", state: "OUTCOME_UNKNOWN", retryAllowed: false };
      }
      return { ok: true, state: "AWAITING_CONFIRMATION", routeVerification: "PENDING", autonomy: "off" };
    }
    if (attested?.mutationAttempted === true
      || attested?.clickAttempted === true
      || attested?.fenceState === "OUTCOME_UNKNOWN") {
      connectFlow = finishConnectFlow(connectFlow, flowIdentity, "OUTCOME_UNKNOWN");
      await persistConnectFlow().catch(() => false);
    }
    return { ...attested, state: connectFlow.state };
  }
  if (attested.serverConfirmed === true) {
    connectFlow = finishConnectFlow(connectFlow, flowIdentity, "DONE");
    if (!await persistConnectFlow()) {
      connectFlow = finishConnectFlow(connectFlow, flowIdentity, "OUTCOME_UNKNOWN");
      await persistConnectFlow().catch(() => false);
      return { ok: false, reason: "connect_done_persist_failed", retryAllowed: false };
    }
  }
  const autonomy = attested.serverConfirmed === true
    ? await rearmAutonomyAfterVerifiedConnect()
    : { ok: true, mode: parseAutonomyPolicy(autonomyPolicy).mode };
  return {
    ok: true,
    state: attested.serverConfirmed === true ? "CONNECTED" : "AWAITING_CONFIRMATION",
    routeVerification: attested.routeVerification,
    autonomy: autonomy.mode,
    autonomyReason: autonomy.ok ? undefined : autonomy.reason,
  };
}

async function resumeConnectAfterTakeover(ownerExact) {
  if (ownerExact !== true || connectFlow.state !== "WAITING_TAKEOVER") {
    if (ownerExact === true && connectFlow.state === "ATTEST_REQUESTED"
      && connectFlow.bootstrapAutoResume === true) {
      return dispatchConnectRouteAttestation({ resumeExisting: true });
    }
    return { ok: false, reason: "takeover_not_waiting" };
  }
  if (!connectFlowTargetMatches(connectFlow, transport?.workspaceId, ownerState.owner?.canonicalRoute)) {
    return { ok: false, reason: "takeover_target_mismatch", retryAllowed: false };
  }
  if (transport?.rebindPending === true
    && areChatgptConversationRoutesEquivalent(transport.routeCanonical, connectFlow.routeCanonical)) {
    return dispatchConnectRouteAttestation();
  }
  ownerProof = mintOwnerProof({
    tabId: ownerState.owner.tabId,
    documentId: ownerState.owner.documentId,
    routeCanonical: ownerState.owner.canonicalRoute,
  });
  const started = await handleRebindStart({ ownerProofId: ownerProof.id });
  if (!started.ok) {
    if (started.reason === "COMPANION_REBIND_NOT_SUCCESSOR") {
      return { ok: true, state: "WAITING_TAKEOVER", reason: "waiting_for_takeover", retryAllowed: true };
    }
    if (started.reason === "COMPANION_UNAUTHORIZED" || started.reason === "transport_missing") {
      return { ok: false, reason: "cold_pair_required", retryAllowed: false };
    }
    if (started.retryAllowed === false) {
      const identity = takeoverConnectFlowIdentity(transport, connectFlow.routeCanonical);
      if (identity) {
        connectFlow = finishConnectFlow(connectFlow, identity, "OUTCOME_UNKNOWN");
        await persistConnectFlow().catch(() => false);
      }
    }
    return { ...started, state: connectFlow.state };
  }
  connectReason = null;
  return dispatchConnectRouteAttestation();
}

async function handleConnectPage(sender, message) {
  if (connectInFlight) return { ok: false, reason: "connect_in_flight", retryAllowed: false };
  connectInFlight = true;
  try {
    if (!storageProtected) return { ok: false, reason: "storage_unprotected" };
    if (!pairAllowedWithJournal(journal, transport?.authStale === true)) {
      return { ok: false, reason: "journal_active" };
    }
    const autonomyOff = await forceAutonomyOff("connect");
    if (!autonomyOff.ok) {
      return { ok: false, reason: "autonomy_persist_failed", autonomy: "off", retryAllowed: true };
    }
    const currentDocument = resolveCurrentDocumentBindingIdentity(sender, message?.canonicalRoute ?? null);
    if (!currentDocument.ok) return { ok: false, reason: currentDocument.reason };
    const identity = currentDocument.identity;
    const canonicalRoute = identity.canonicalRoute;
    const generation = Number.isFinite(message?.generation) ? Number(message.generation) : 1;
    const bound = bindCurrentDocument(ownerState, identity, { generation });
    if (!bound.ok) return { ok: false, reason: bound.reason };
    ownerState = bound.state;
    localState = { ...localState, targetRoute: canonicalRoute, paired: true };
    evidence = message?.safety && typeof message.safety === "object"
      ? {
          tabId: identity.tabId,
          documentId: identity.documentId,
          canonicalRoute,
          observedAt: Date.now(),
          composer: message.safety.composer,
          generation: message.safety.generation,
          safe: message.safety.safe === true,
        }
      : null;
    await persistLocal();
    await persistSessionOwnership();
    if (!transport?.bridgeOrigin || !transport?.credential) {
      return { ok: false, reason: "cold_pair_required" };
    }
    let permission;
    try {
      const origin = parseBridgeOrigin(transport.bridgeOrigin, { allowLoopbackHttp: true });
      permission = await chrome.permissions?.contains?.({ origins: [`${origin}/*`] });
    } catch {
      permission = false;
    }
    if (permission !== true) return { ok: false, reason: "bridge_permission_missing" };

    if (connectFlow.state === "TAKEOVER_DISPATCH" || connectFlow.state === "OUTCOME_UNKNOWN") {
      return { ok: false, reason: "connect_outcome_unknown", state: "OUTCOME_UNKNOWN", retryAllowed: false };
    }
    if (connectFlow.state === "WAITING_TAKEOVER"
      && !connectFlowTargetMatches(connectFlow, transport.workspaceId, canonicalRoute)) {
      return { ok: false, reason: "connect_identity_conflict", state: connectFlow.state, retryAllowed: false };
    }
    if (["ATTEST_REQUESTED", "COMPLETE_REQUESTED"].includes(connectFlow.state)
      && !connectFlowTargetMatches(connectFlow, transport.workspaceId, canonicalRoute)) {
      return { ok: false, reason: "connect_identity_conflict", state: connectFlow.state, retryAllowed: false };
    }
    if (connectFlowTargetMatches(connectFlow, transport.workspaceId, canonicalRoute)) {
      if (connectFlow.state === "WAITING_TAKEOVER") {
        if (transport.rebindPending === true
          && areChatgptConversationRoutesEquivalent(transport.routeCanonical, canonicalRoute)) {
          return dispatchConnectRouteAttestation();
        }
        return { ok: true, state: "WAITING_TAKEOVER", reason: "waiting_for_takeover", retryAllowed: false };
      }
    }

    let currentPairPending = false;
    if (!transport.rebindPending && areChatgptConversationRoutesEquivalent(transport.routeCanonical, canonicalRoute)) {
      const current = await handleFetchState();
      if (current?.ok && current.status?.routeVerification === "VERIFIED") {
        const autonomy = await rearmAutonomyAfterVerifiedConnect();
        return {
          ok: true,
          state: "CONNECTED",
          routeVerification: "VERIFIED",
          autonomy: autonomy.mode,
          autonomyReason: autonomy.ok ? undefined : autonomy.reason,
        };
      }
      currentPairPending = current?.ok === true
        && current.status?.routeVerification === "PENDING";
      if (current?.ok !== true && current?.authStale !== true) {
        return { ok: false, reason: current?.reason || "state_unavailable" };
      }
    }

    if (!transport.rebindPending && !currentPairPending) {
      ownerProof = mintOwnerProof({
        tabId: identity.tabId,
        documentId: identity.documentId,
        routeCanonical: canonicalRoute,
      });
      const started = await handleRebindStart({ ownerProofId: ownerProof.id });
      if (!started.ok) {
        if (started.reason === "COMPANION_REBIND_NOT_SUCCESSOR") {
          const takeoverIdentity = takeoverConnectFlowIdentity(transport, canonicalRoute);
          if (!takeoverIdentity) return { ok: false, reason: "connect_identity_invalid", retryAllowed: false };
          return dispatchFeedbackBootstrap(takeoverIdentity);
        }
        if (started.reason === "COMPANION_UNAUTHORIZED" || started.reason === "transport_missing") {
          return { ...started, reason: "cold_pair_required" };
        }
        return started;
      }
    }

    if (!ownerState.owner
      || !isOwner(ownerState, identity.tabId, identity.documentId)
      || !areChatgptConversationRoutesEquivalent(ownerState.owner.canonicalRoute, canonicalRoute)
      || !areChatgptConversationRoutesEquivalent(transport.routeCanonical, canonicalRoute)) {
      return { ok: false, reason: "owner_identity_changed", retryAllowed: false };
    }
    return dispatchConnectRouteAttestation();
  } finally {
    connectInFlight = false;
  }
}

async function handleFetchState() {
  const gate = requireProtectedTransport();
  if (!gate.ok) return gate;
  try {
    const res = await fetchCompanion("/state", { method: "GET" });
    if (res.status === 401 && transport?.rebindPending === true) {
      return { ok: false, reason: "rebind_pending", authStale: false };
    }
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
    // Authenticated /state is the ONLY route-verification authority.
    const sync = syncTransportRouteVerification(transport, res.body);
    if (sync.ok) {
      if (sync.downgraded) {
        await forceAutonomyOff("route_verification_downgrade");
      }
      transport = sync.transport;
      await persistTransport();
      // Latch + durable fence terminal only from authenticated /state VERIFIED.
      const appliedLatch = applyRouteAttestServerVerification(routeAttestLatch, sync.routeVerification);
      if (appliedLatch.ok && appliedLatch.transitioned) {
        routeAttestLatch = appliedLatch.latch;
      }
      const appliedFence = applyRouteAttestServerVerificationToFence(routeAttestFence, sync.routeVerification, {
        companionId: transport?.companionId ?? null,
        challengeId: extractRouteChallengeId(transport?.routeAttestationMessage)
          ?? routeAttestFence.challengeId,
      });
      if (appliedFence.ok && appliedFence.transitioned) {
        routeAttestFence = appliedFence.fence;
      }
      if (
        (appliedLatch.ok && appliedLatch.transitioned)
        || (appliedFence.ok && appliedFence.transitioned)
      ) {
        await persistRouteAttestBoth();
      }
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
        routeVerification: transport?.routeVerification === "VERIFIED" ? "VERIFIED" : "PENDING",
        productionEligible: transport?.routeVerification === "VERIFIED",
        // Attestation payload stays SW-only; never expose challenge message on /state.
        routeAttestationPending: transport?.routeVerification !== "VERIFIED"
          && isRouteAttestationMessage(transport?.routeAttestationMessage),
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
  connectReason = null;
  await forceAutonomyOff("transport_clear", { clearRearmPreference: true });
  await persistTransport();
  // Durable route-attest fence is NOT cleared here. Transport clear must not
  // silently authorize the same challenge again; only re-pair with a new
  // companionId + challengeId may reset the fence.
  return {
    ok: true,
    journal: { state: journal.state },
    routeAttestFence: routeAttestFence.state,
  };
}

async function handleMessage(message, sender, { transportMutationHeld = false } = {}) {
  await initPromise;
  if (!message || typeof message !== "object") return { ok: false, reason: "bad_message" };

  if (message.type === "c2c.unbind") return unbindAll();
  if (message.type === "c2c.owner-proof.request") return handleMintOwnerProof(sender, message);
  if (message.type === "c2c.pair") return runTransportMutation(() => handlePair(message));
  if (message.type === "c2c.rebind.start") {
    if (!isExtensionInternalSender(sender)) return { ok: false, reason: "popup_sender_required" };
    return runTransportMutation(() => handleRebindStart(message));
  }
  if (message.type === "c2c.rebind.complete") {
    if (!isExtensionInternalSender(sender)) return { ok: false, reason: "popup_sender_required" };
    return runTransportMutation(() => handleRebindComplete());
  }
  if (message.type === "c2c.transport.status") {
    return {
      ok: true,
      storageProtected,
      transport: safeTransportSummary(),
      journal: summarizeProductionJournal(journal),
      sendProbeLatch: sendProbeLatch.state,
      routeAttestLatch: routeAttestLatch.state,
      routeAttestFence: routeAttestFence.state,
      productionSendInFlight,
    };
  }
  if (message.type === "c2c.fetch.state") return handleFetchState();

  // G3 route attestation: popup sends no payload; SW owns server message.
  if (message.type === ROUTE_ATTEST_SEND_TYPE) {
    if (!transportMutationHeld) {
      return runTransportMutation(() => handleMessage(message, sender, { transportMutationHeld: true }));
    }
    if (!isExtensionInternalSender(sender)) {
      return { ok: false, reason: "popup_sender_required" };
    }
    const payloadCheck = validateRouteAttestPopupRequest(message);
    if (!payloadCheck.ok) return payloadCheck;
    const transportGate = requireProtectedTransport();
    if (!transportGate.ok) return transportGate;
    const start = canStartRouteAttestSend({
      owner: ownerState.owner,
      transport,
      journal,
      evidence,
      productionSendInFlight,
      autonomyMode: parseAutonomyPolicy(autonomyPolicy).mode,
      latch: routeAttestLatch,
      fence: routeAttestFence,
      companionId: transport?.companionId ?? null,
      challengeId: extractRouteChallengeId(transport?.routeAttestationMessage),
    });
    if (!start.ok) {
      return {
        ok: false,
        reason: start.reason,
        latchState: routeAttestLatch.state,
        fenceState: routeAttestFence.state,
        retryAllowed: false,
      };
    }
    const request = buildRouteAttestExecuteRequest(ownerState.owner, transport);
    if (!request.ok) return { ok: false, reason: request.reason, retryAllowed: false };
    const challengeId = request.message.challengeId;
    const owner = ownerState.owner;
    const prevLatch = routeAttestLatch;
    const prevFence = routeAttestFence;
    const now = Date.now();
    const intentLatch = {
      state: "ROUTE_ATTEST_DISPATCH",
      tabId: owner.tabId,
      documentId: owner.documentId,
      canonicalRoute: owner.canonicalRoute,
      generation: owner.generation,
      challengeId,
      challengeExpiresAt: transport.routeAttestationExpiresAt ?? null,
      createdAt: now,
    };
    const intentFence = markRouteAttestFenceDispatch({
      companionId: transport.companionId ?? null,
      challengeId,
      routeCanonical: transport.routeCanonical,
      challengeExpiresAt: transport.routeAttestationExpiresAt ?? null,
      now,
    });
    // Durable fence FIRST, then session latch — both before any mutation RPC.
    routeAttestFence = intentFence;
    routeAttestLatch = intentLatch;
    const bothOk = await persistRouteAttestBoth();
    if (!bothOk) {
      // Fail closed. If durable fence write failed, restore previous and abort RPC.
      routeAttestLatch = prevLatch;
      routeAttestFence = prevFence;
      await persistRouteAttestBoth();
      return {
        ok: false,
        reason: "route_attest_fence_persist_failed",
        retryAllowed: false,
        mutationAttempted: false,
        clickAttempted: false,
        latchState: routeAttestLatch.state,
        fenceState: routeAttestFence.state,
      };
    }

    let response = null;
    let rpcLost = false;
    try {
      response = await chrome.tabs.sendMessage(request.tabId, request.message, request.sendOptions);
    } catch {
      rpcLost = true;
      response = null;
    }

    // RPC lost after durable DISPATCH → OUTCOME_UNKNOWN on BOTH stores; same challenge never re-Send.
    if (rpcLost || response == null) {
      routeAttestLatch = { ...intentLatch, state: "OUTCOME_UNKNOWN" };
      routeAttestFence = markRouteAttestFenceState(intentFence, "OUTCOME_UNKNOWN");
      await persistRouteAttestBoth();
      return {
        ok: false,
        reason: "route_attest_outcome_unknown",
        latchState: "OUTCOME_UNKNOWN",
        fenceState: "OUTCOME_UNKNOWN",
        retryAllowed: false,
        mutationAttempted: true,
        clickAttempted: true,
      };
    }

    const classified = classifyRouteAttestRpcResult(response);
    if (classified.ok && classified.observed) {
      // Exact USER turn observed. Server VERIFIED still requires authenticated /state.
      // Local DOM observation NEVER sets VERIFIED on latch or durable fence.
      routeAttestLatch = { ...intentLatch, state: "OBSERVED_PENDING_CONFIRM" };
      routeAttestFence = markRouteAttestFenceState(intentFence, "OBSERVED_PENDING_CONFIRM");
      await persistRouteAttestBoth();
      const stateRes = await handleFetchState();
      return {
        ok: true,
        observed: true,
        latchState: routeAttestLatch.state,
        fenceState: routeAttestFence.state,
        routeVerification: stateRes?.status?.routeVerification ?? transport.routeVerification,
        productionEligible: stateRes?.status?.productionEligible === true,
        serverConfirmed: stateRes?.status?.routeVerification === "VERIFIED",
        retryAllowed: false,
      };
    }

    // Pre-mutation failure before any dispatch can clear latch+fence; after dispatch → OUTCOME_UNKNOWN.
    if (response.mutationAttempted !== true && response.clickAttempted !== true) {
      routeAttestLatch = emptyRouteAttestLatch();
      // Only clear durable fence when nothing was attempted AND this was still DISPATCH.
      routeAttestFence = emptyRouteAttestFence();
      await persistRouteAttestBoth();
      return {
        ok: false,
        reason: classified.reason,
        latchState: "NONE",
        fenceState: "NONE",
        retryAllowed: true,
        mutationAttempted: false,
        clickAttempted: false,
      };
    }
    routeAttestLatch = { ...intentLatch, state: "OUTCOME_UNKNOWN" };
    routeAttestFence = markRouteAttestFenceState(intentFence, "OUTCOME_UNKNOWN");
    await persistRouteAttestBoth();
    return {
      ok: false,
      reason: classified.reason,
      latchState: "OUTCOME_UNKNOWN",
      fenceState: "OUTCOME_UNKNOWN",
      retryAllowed: false,
      mutationAttempted: response.mutationAttempted === true,
      clickAttempted: response.clickAttempted === true,
    };
  }
  if (message.type === "c2c.reserve.page") {
    // Manual reserve competes with autonomy — block while ARMED.
    if (parseAutonomyPolicy(autonomyPolicy).mode === "armed") {
      return { ok: false, reason: "autonomy_armed" };
    }
    return handleReservePage(sender, { generation, safety: message?.safety, canonicalRoute: message?.canonicalRoute ?? null });
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
  if (message.type === "c2c.transport.clear") {
    return runTransportMutation(() => handleClearTransport());
  }
  if (message.type === "c2c.connect.page") {
    return runTransportMutation(() => handleConnectPage(sender, message));
  }
  if (message.type === "c2c.bind") {
    const currentDocument = resolveCurrentDocumentBindingIdentity(sender, message?.canonicalRoute ?? null);
    if (!currentDocument.ok) return { ok: false, reason: currentDocument.reason };
    const { tabId, documentId, canonicalRoute } = currentDocument.identity;
    const generation = Number.isFinite(message.generation) ? Number(message.generation) : 1;
    const result = bindCurrentDocument(ownerState, currentDocument.identity, { generation });
    ownerState = result.state;
    if (result.ok) {
      localState = { ...localState, targetRoute: canonicalRoute, paired: true };
      await persistLocal();
    }
    await persistSessionOwnership();
    return statusPayload(tabId, documentId, { reason: result.reason, canonicalRoute });
  }

  const identity = resolveSenderDocumentIdentity(sender);
  const tabId =
    identity.ok || identity.reason === "document_id_unavailable" ? identity.tabId : null;
  const documentId = identity.ok ? identity.documentId : null;
  const generation = Number.isFinite(message.generation) ? Number(message.generation) : 1;
  // R3o: authority is the browser tab URL; the content-script canonicalRoute is a
  // mandatory-equivalence witness. A non-matching canonical is never trusted below.
  const observationVerdict = resolveObservationRouteVerdict(sender, message?.canonicalRoute ?? null);
  const canonical = observationVerdict.verdict === "match" ? observationVerdict.canonicalRoute : null;

  if (
    message.type === "c2c.status.page"
    || message.type === "c2c.observe"
    || message.type === "c2c.heartbeat"
  ) {
    if (!identity.ok && identity.reason !== "document_id_unavailable") {
      return { ok: false, reason: identity.reason };
    }
    const applied = applyObservationRouteVerdict(ownerState, {
      tabId: tabId ?? -1,
      documentId,
      verdict: observationVerdict.verdict,
      canonicalRoute: observationVerdict.canonicalRoute ?? null,
      generation,
      now: Date.now(),
    });
    if (applied.applied !== "dropped") {
      ownerState = applied.state;
      if (applied.applied === "owner_invalidated") {
        // Exact owner document contradicted the browser authority (R3o): the
        // owner goes away with its runtime evidence and outstanding proof.
        evidence = null;
        ownerProof = null;
      } else if (
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
    }
    // dropped (R3o): stale/non-owner observation failed the authority/witness
    // check — zero mutation; diagnostics below still run with canonical=null.
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
      const bootstrapConnectWaiting = connectFlow.state === "WAITING_TAKEOVER"
        || (connectFlow.state === "ATTEST_REQUESTED" && connectFlow.bootstrapAutoResume === true);
      const bootstrapOwnerExact = bootstrapConnectWaiting && connectFlowTargetMatches(
        connectFlow,
        transport?.workspaceId,
        canonical,
      ) && isExactOwnerHeartbeat({
        identityOk: identity.ok === true,
        tabId,
        documentId,
        canonicalRoute: canonical,
        owner: ownerState.owner,
        transportRoute: connectFlow.routeCanonical,
      });
      if (bootstrapOwnerExact && connectFlow.state === "WAITING_TAKEOVER"
        && message.feedbackBootstrapToolMissing === true) {
        connectReason = "bootstrap_tool_missing";
      }
      if (bootstrapOwnerExact && connectFlow.state === "WAITING_TAKEOVER") {
        try {
          await runTransportMutation(() => resumeConnectAfterTakeover(true));
        } catch {
          // A failed bounded attempt never causes the fixed bootstrap message to be resent.
        }
      } else if (bootstrapOwnerExact && connectFlow.state === "ATTEST_REQUESTED"
        && routeAttestFence.state === "NONE") {
        try {
          await runTransportMutation(() => resumeConnectAfterTakeover(true));
        } catch {
          // Only a proven pre-dispatch failure may be retried on a later exact heartbeat.
        }
      }
      // Route attestation confirmation poll: read-only /state, independent of autonomy.
      // Bounded by shouldPollRouteAttestConfirm (owner exact + identity + challenge + expiry).
      if (routeAttestLatch.state === "OBSERVED_PENDING_CONFIRM"
        || routeAttestFence.state === "OBSERVED_PENDING_CONFIRM") {
        const flowIdentity = connectFlowIdentity(transport);
        if (transport?.rebindPending === true
          && connectFlow.state === "ATTEST_REQUESTED"
          && flowIdentity
          && connectFlowMatches(connectFlow, flowIdentity)) {
          try {
            const completed = await runTransportMutation(
              () => maybeCompleteConnectedRebind(ownerExact),
            );
            if (completed?.ok) {
              lastAutonomyReason = completed.autonomyReason || "connect_rebind_verified";
            }
          } catch {
            // Read-only status or fenced completion failure never resends attestation/complete.
          }
        } else {
          const pollGate = shouldPollRouteAttestConfirm({
            latch: routeAttestLatch,
            ownerExact,
            owner: ownerState.owner,
            transport,
            now: Date.now(),
          });
          const restartSafeConnectPoll = ownerExact === true
            && ["ATTEST_REQUESTED", "DONE"].includes(connectFlow.state)
            && flowIdentity
            && connectFlowMatches(connectFlow, flowIdentity)
            && routeAttestFence.state === "OBSERVED_PENDING_CONFIRM";
          if (pollGate.ok || restartSafeConnectPoll) {
            try {
              const attestState = await handleFetchState();
              if (attestState?.ok && attestState.status?.routeVerification === "VERIFIED") {
                lastAutonomyReason = "route_attest_server_verified";
                if (restartSafeConnectPoll || connectFlow.state === "ATTEST_REQUESTED") {
                  connectFlow = finishConnectFlow(connectFlow, flowIdentity, "DONE");
                  if (await persistConnectFlow()) {
                    const currentFlowIdentity = connectFlowIdentity(transport);
                    if (connectFlow.state === "DONE"
                      && currentFlowIdentity
                      && connectFlowMatches(connectFlow, currentFlowIdentity)) {
                      const autonomy = await rearmAutonomyAfterVerifiedConnect();
                      if (!autonomy.ok) lastAutonomyReason = autonomy.reason;
                    }
                  }
                }
              }
            } catch {
              // read-only poll failure must never send/resend
            }
          }
        }
      }
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
      const off = await forceAutonomyOff("manual_disable", { clearRearmPreference: true });
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
    if (!areChatgptConversationRoutesEquivalent(ownerState.owner.canonicalRoute, transport.routeCanonical)) {
      return { ok: false, reason: "owner_route_mismatch" };
    }
    const mode = message.type === "c2c.autonomy.arm" ? "armed" : "shadow";
    // ARMED production requires authenticated route VERIFIED. Shadow allowed while PENDING.
    if (mode === "armed" && transport.routeVerification !== "VERIFIED") {
      return {
        ok: false,
        reason: "route_unverified",
        mode: parseAutonomyPolicy(autonomyPolicy).mode,
        policy: autonomyPolicy,
        journal: summarizeProductionJournal(journal),
      };
    }
    const previousMode = parseAutonomyPolicy(autonomyPolicy).mode;
    const proposed = {
      schemaVersion: 1,
      mode,
      bindingId: transport.bindingId,
      epoch: transport.epoch,
      routeCanonical: transport.routeCanonical,
      armedAt: Date.now(),
      lastProductionAttemptAt: autonomyPolicy.lastProductionAttemptAt,
      rearmOnConnect: mode === "armed" ? true : parseAutonomyPolicy(autonomyPolicy).rearmOnConnect,
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
  if (!ownerState.owner) {
    return { ok: false, reason: "owner_missing" };
  }
  const owner = ownerState.owner;

  const request = buildOwnerLocalShadowInspectRequest(owner);
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

  const check = validateOwnerLocalShadowInspectResponse(response, owner);
  if (!check.ok) {
    return { ok: false, reason: check.reason };
  }

  // Safe summary only — no DOM nodes / HTML / credentials.
  return {
    ok: true,
    mode: "read_only",
    scope: "owner_local",
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
      && !areChatgptConversationRoutesEquivalent(proposed.routeCanonical, transport.routeCanonical)
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
  if (message?.routeCanonical != null && !areChatgptConversationRoutesEquivalent(message.routeCanonical, journal.routeCanonical)) {
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
    let routeVerified = transport?.routeVerification === "VERIFIED";
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
      routeVerified = stateRes.status.routeVerification === "VERIFIED"
        || stateRes.status.productionEligible === true;
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
        evidence && transport && areChatgptConversationRoutesEquivalent(evidence.canonicalRoute, transport.routeCanonical),
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
      routeVerified,
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
    void refreshActionIndicator();
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
    void refreshActionIndicator();
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
    void refreshActionIndicator();
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
    .then((response) => {
      void refreshActionIndicator();
      void syncWakeWatchdog();
      sendResponse(response);
    })
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
    await syncWakeWatchdog();
    await refreshActionIndicator();
  })();
});

if (chrome.alarms?.onAlarm?.addListener) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    void handleWakeWatchdogAlarm(alarm);
  });
}

if (chrome.tabs?.onActivated?.addListener) {
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    void requestActiveOwnerRefresh(tabId);
  });
}

if (chrome.windows?.onFocusChanged?.addListener) {
  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE || windowId === -1) return;
    void requestActiveOwnerRefresh();
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await initPromise;
    const stored = await chrome.storage.local.get(LOCAL_KEY);
    if (!stored[LOCAL_KEY]) {
      localState = { schemaVersion: 1, targetRoute: null, paired: false };
      await persistLocal();
    }
    await syncWakeWatchdog();
    await refreshActionIndicator();
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
    await syncWakeWatchdog();
    await refreshActionIndicator();
  })();
});
