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
  emptyOutcomeUnknownArchive,
  parseOutcomeUnknownArchive,
  appendOutcomeUnknownArchive,
  findOutcomeUnknownArchiveEntry,
  findServerIsolatedAttempt,
  markOutcomeUnknownArchiveIsolated,
  markOutcomeUnknownArchiveTerminalGone,
  parseServerIsolatedAttempts,
  canParkOutcomeUnknown,
  hasSafeUnknownRecoveryProof,
  validateIsolationResponse,
  validateTerminalGoneResponse,
  summarizeOutcomeUnknownArchive,
} from "./outcome-unknown-isolation.js";
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
  JOURNAL_STATES,
  validateSendJournalShape,
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
  isRecoverySendDisabled,
  commitJournalDurably,
  findExactObservedEvent,
  evaluateServerObservedCloseout,
  evaluateTerminalGoneCloseout,
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
  connectTakeoverRecoveryStage,
  beginConnectAttestation,
  requestConnectCompletion,
  finishConnectFlow,
  connectFlowOwnerWitnessMatches,
  refreshExplicitConnectOwnerWitness,
  verifiedConnectFlowMatchesTransport,
  deriveConnectionReadiness,
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

import {
  createProjectChrome,
  createProjectContextRouter,
} from "./project-context.js";

const LEGACY_LOCAL_KEYS = [
  "c2c_companion_local_v1",
  "c2c_companion_local_route_request_v1",
  "c2c_companion_transport_v1",
  "c2c_companion_journal_v1",
  "c2c_companion_outcome_unknown_archive_v1",
  AUTONOMY_STORAGE_KEY,
  ROUTE_ATTEST_FENCE_KEY,
  CONNECT_FLOW_KEY,
  "c2c.panel.action.v1",
];
const LEGACY_SESSION_KEYS = [
  "c2c_companion_owner_v1",
  "c2c_companion_registry_v1",
  "c2c_companion_evidence_v1",
  SEND_PROBE_LATCH_KEY,
  ROUTE_ATTEST_LATCH_KEY,
  "c2c_companion_pair_intent_v1",
];

// 浏览器消息抵达即记录文档变化，先于project的同tab串行锁，防止await使用旧文档。
const pageArrivals = new Map();

export function createWorkspaceContext(project, isSelected = () => false, withPageSendLock = null) {
const chrome = createProjectChrome(globalThis.chrome, project.workspaceId, isSelected, withPageSendLock);

function isOwnOperationsPanel(sender) {
  if (sender?.id !== chrome.runtime.id || !Number.isSafeInteger(sender?.tab?.id)) return false;
  const expected = new URL(chrome.runtime.getURL("operations/operations.html"));
  const parsePanelUrl = value => {
    try {
      const url = new URL(value);
      const ids = url.searchParams.getAll("workspaceId");
      if (url.protocol !== expected.protocol || url.hostname !== expected.hostname || url.port !== expected.port
        || url.pathname !== expected.pathname || url.hash) return null;
      if (url.search === "" && project.legacy === true) return url.href;
      if (url.searchParams.size !== 1 || ids.length !== 1 || ids[0] !== project.workspaceId) return null;
      return url.href;
    } catch { return null; }
  };
  const source = parsePanelUrl(sender.url);
  const tab = parsePanelUrl(sender.tab.url);
  return source != null && source === tab;
}

const LOCAL_KEY = "c2c_companion_local_v1";
const LOCAL_ROUTE_KEY = "c2c_companion_local_route_request_v1";
const TRANSPORT_KEY = "c2c_companion_transport_v1";
const JOURNAL_KEY = "c2c_companion_journal_v1";
const OUTCOME_UNKNOWN_ARCHIVE_KEY = "c2c_companion_outcome_unknown_archive_v1";
const SESSION_OWNER_KEY = "c2c_companion_owner_v1";
const SESSION_REG_KEY = "c2c_companion_registry_v1";
const SESSION_EVIDENCE_KEY = "c2c_companion_evidence_v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === "string" && UUID.test(value);

let localState = { schemaVersion: 1, targetRoute: null, paired: false };
let ownerState = emptyOwnerState();
let transport = null;
let transportIdentityBlocked = false;
let journal = emptyJournal();
let outcomeUnknownArchive = emptyOutcomeUnknownArchive();
let outcomeUnknownArchiveValid = true;
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
/** Last explicit connect Web Sink binding; never mutated by navigation alone. */
/** Bridge-authoritative Web Sink projection cache (read-only sync). */
let activeWebSinkProjection = { binding: null, available: false, synced: false };
let connectInFlight = false;
let localRouteRequest = null;
let lastLocalRoutePollAt = 0;
let transportMutationInFlight = false;
/** E1b3d3b concurrent production send gate (memory only; durable truth is journal). */
let productionSendInFlight = false;
/** Serializes manual and autonomous recovery so native production cannot overlap its proof. */
let productionRecoveryInFlight = false;
/** 仅显式 Connect 的观察恢复；不能用于续发或接管旧目标。 */
let connectRecoveryCurrent = null;
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
    OUTCOME_UNKNOWN_ARCHIVE_KEY,
    AUTONOMY_STORAGE_KEY,
    ROUTE_ATTEST_FENCE_KEY,
    CONNECT_FLOW_KEY,
    LOCAL_ROUTE_KEY,
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
  const transportIdentityMatches = t == null || (
    t && typeof t === "object" && !Array.isArray(t)
    && t.workspaceId === project.workspaceId
    && typeof t.bridgeOrigin === "string"
    && (() => {
      try { return parseBridgeOrigin(t.bridgeOrigin, { allowLoopbackHttp: true }) === project.bridgeOrigin; }
      catch { return false; }
    })()
  );
  transportIdentityBlocked = !transportIdentityMatches;
  const policy = applyStorageProtectionPolicy(storageProtected, transportIdentityBlocked ? null : t);
  if (policy.mustDeleteStoredKey && transportIdentityMatches) {
    await chrome.storage.local.remove(TRANSPORT_KEY);
  }
  transport = policy.transport;

  const j = stored[JOURNAL_KEY];
  journal = j && typeof j === "object" && typeof j.state === "string" ? j : emptyJournal();
  const archivedUnknown = parseOutcomeUnknownArchive(stored[OUTCOME_UNKNOWN_ARCHIVE_KEY]);
  outcomeUnknownArchiveValid = archivedUnknown.ok;
  outcomeUnknownArchive = archivedUnknown.ok ? archivedUnknown.archive : null;

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
  localRouteRequest = parseLocalRouteRequest(stored[LOCAL_ROUTE_KEY]);
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

/**
 * R3q review-fix (FIX_2): the managed written-unsent rollback commits the
 * durable route-attest fence and the managed connectFlow in ONE
 * chrome.storage.local.set — a half-cleared or half-hardened pair must never
 * become durable. A cleared fence is stored as an explicit NONE object in the
 * same commit (parseRouteAttestFence treats it identically to a missing key);
 * the key-absent convention is restored best-effort afterwards.
 */
async function commitWrittenUnsentDurable(nextConnectFlow, nextFence) {
  try {
    await chrome.storage.local.set({
      [CONNECT_FLOW_KEY]: nextConnectFlow,
      [ROUTE_ATTEST_FENCE_KEY]: nextFence,
    });
    if (nextFence.state === "NONE" && !nextFence.challengeId) {
      await chrome.storage.local.remove(ROUTE_ATTEST_FENCE_KEY).catch(() => undefined);
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

async function persistOutcomeUnknownArchive(next) {
  if (!storageProtected) throw new Error("storage_unprotected");
  const parsed = parseOutcomeUnknownArchive(next);
  if (!parsed.ok) throw new Error(parsed.reason);
  await chrome.storage.local.set({ [OUTCOME_UNKNOWN_ARCHIVE_KEY]: parsed.archive });
  outcomeUnknownArchive = parsed.archive;
  outcomeUnknownArchiveValid = true;
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
    if (autonomyPolicy !== previous) {
      // 用户在持久化期间关闭回流时，以更新后的偏好为准。
      await persistAutonomyPolicy();
      return { ok: false, reason: "autonomy_policy_changed", policy: autonomyPolicy };
    }
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

function connectionReadiness(tabId = ownerState.owner?.tabId, documentId = ownerState.owner?.documentId) {
  return deriveConnectionReadiness({
    transport, storageProtected, transportIdentityBlocked, transportMutationInFlight, routeAttestFence, connectFlow, connectReason,
    owner: documentId != null && isOwner(ownerState, tabId, documentId) ? ownerState.owner : null,
    webSink: activeWebSinkProjection,
  });
}

function safeTransportSummary(readiness = connectionReadiness()) {
  if (!transport) {
    return {
      connected: false,
      connectionReadiness: readiness,
      webSinkConverged: readiness.ready,
      r5cConnected: readiness.ready,
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
    authStaleReason: transport.authStale ? boundedAuthReason(transport.authStaleReason) : null,
    storageProtected,
    bridgeOrigin: transport.bridgeOrigin,
    workspaceId: transport.workspaceId,
    companionId: transport.companionId,
    bindingId: transport.bindingId,
    epoch: transport.epoch,
    routeCanonical: transport.routeCanonical,
    routeVerification: transport.routeVerification === "VERIFIED" ? "VERIFIED" : "PENDING",
    productionEligible: storageProtected && !transport.authStale && transport.routeVerification === "VERIFIED",
    rebindPending: transport.rebindPending === true,
    connectState: connectFlow.state,
    takeoverRecovery: currentTakeoverRecoveryStage(),
    connectionReadiness: readiness,
    webSinkConverged: readiness.ready,
    r5cConnected: readiness.ready,
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

function deliveryRecoverySummary(result = null) {
  const blocked = journal.state !== "NONE" && parseAutonomyPolicy(autonomyPolicy).mode === "off";
  return {
    blocked,
    journalState: journal.state,
    reason: blocked ? result?.reason || "delivery_journal_requires_recovery" : null,
    action: result?.action ?? null,
    recovered: result?.recovered === true,
  };
}

function statusPayload(tabId, documentId, extra = {}) {
  const readiness = connectionReadiness(tabId, documentId);
  const summary = safeTransportSummary(readiness);
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
    transport: summary,
    journal: summarizeProductionJournal(journal),
    deliveryRecovery: deliveryRecoverySummary(),
    localRoute: localRouteSummary(),
    sendProbeLatch: sendProbeLatch.state,
    routeAttestLatch: routeAttestLatch.state,
    routeAttestFence: routeAttestFence.state,
    connectState: connectFlow.state,
    connectReason: connectReason ?? connectFlow.failureReason ?? null,
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
      transport: summary,
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

// Private request witness: never returned through extension messages or persisted.
const requestTransports = new WeakMap();
let authFailureRevision = 0;
function isCurrentTransportResponse(response) {
  const sent = requestTransports.get(response);
  return !!sent && !!transport && ["bridgeOrigin", "workspaceId", "companionId", "bindingId", "epoch", "routeCanonical", "credential", "pairedAt"]
    .every(key => sent[key] === transport[key]);
}

async function fetchCompanion(path, init = {}) {
  if (!storageProtected) throw new Error("storage_unprotected");
  const requestTransport = transport ? { ...transport } : null;
  const requestAuthRevision = authFailureRevision;
  const origin = requestTransport?.bridgeOrigin;
  if (!origin) throw new Error("transport_missing");
  const url = companionApiUrl(origin, path);
  const headers = {
    ...(init.body ? { "content-type": "application/json" } : {}),
    ...(requestTransport ? { authorization: `Bearer ${requestTransport.credential}` } : {}),
    ...(init.headers || {}),
  };
  const res = await fetch(url, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  const response = wrapFetchResponse(res, body);
  requestTransports.set(response, { ...requestTransport, requestAuthRevision });
  return response;
}

/**
 * Explicit-connect convergence only:
 * exact explicit owner identity + transport route + authenticated VERIFIED
 *   -> POST /web-sink/bind-current
 *   -> fail-closed validate generic binding
 * Periodic GET /state must never call this. Navigation alone never mutates sink.
 */
async function convergeExplicitVerifiedConnect(expectedOwner) {
  if (!storageProtected || !transport?.credential || typeof transport.routeCanonical !== "string") {
    return { ok: false, reason: "web_sink_transport_unready" };
  }
  if (transport.routeVerification !== "VERIFIED") {
    return { ok: false, reason: "web_sink_route_unverified" };
  }
  if (expectedOwner) {
    if (!ownerStillMatches(expectedOwner)) {
      return { ok: false, reason: "web_sink_owner_mismatch" };
    }
    if (!areChatgptConversationRoutesEquivalent(expectedOwner.canonicalRoute, transport.routeCanonical)) {
      return { ok: false, reason: "web_sink_owner_mismatch" };
    }
  } else if (!ownerState?.owner?.canonicalRoute
    || !areChatgptConversationRoutesEquivalent(ownerState.owner.canonicalRoute, transport.routeCanonical)) {
    return { ok: false, reason: "web_sink_owner_mismatch" };
  }
  try {
    const res = await fetchCompanion("/web-sink/bind-current", {
      method: "POST",
      body: JSON.stringify({ routeCanonical: transport.routeCanonical }),
    });
    if (!isCurrentTransportResponse(res)) return { ok: false, reason: "stale_transport_response" };
    if (expectedOwner && !ownerStillMatches(expectedOwner)) return { ok: false, reason: "web_sink_owner_mismatch" };
    if (!res.ok || !res.body || typeof res.body !== "object") {
      return { ok: false, reason: "web_sink_bind_failed", status: res.status };
    }
    const b = res.body.activeBinding;
    const created = res.body.created;
    if (!b || typeof b !== "object") {
      return { ok: false, reason: "web_sink_response_invalid" };
    }
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    // Align with Endpoint endpointInstantSchema (z.string().datetime()): ISO-8601 with Z only.
    const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
    const epochOk = Number.isInteger(b.epoch) && b.epoch >= 1 && b.epoch <= 2147483647;
    const boundAtOk = typeof b.boundAt === "string" && ISO_INSTANT.test(b.boundAt) && !Number.isNaN(Date.parse(b.boundAt));
    if (
      res.body.workspaceId !== transport.workspaceId
      || b.workspaceId !== transport.workspaceId
      || b.pluginId !== "browser-companion"
      || b.surfaceId !== "chatgpt-web"
      || b.canonicalUrl !== transport.routeCanonical
      || typeof b.bindingId !== "string"
      || !UUID.test(b.bindingId)
      || !epochOk
      || !boundAtOk
      || typeof created !== "boolean"
    ) {
      return { ok: false, reason: "web_sink_response_invalid" };
    }
    activeWebSinkProjection = {
      binding: {
        bindingId: b.bindingId,
        pluginId: b.pluginId,
        surfaceId: b.surfaceId,
        workspaceId: b.workspaceId,
        canonicalUrl: b.canonicalUrl,
        epoch: b.epoch,
        boundAt: b.boundAt,
        created,
      },
      available: true,
      synced: true,
    };
    return { ok: true, binding: activeWebSinkProjection.binding };
  } catch (error) {
    return { ok: false, reason: "web_sink_bind_error", error: String(error?.message || error) };
  }
}

/**
 * Read-only Bridge Web Sink status sync (GET /web-sink/status).
 * Bridge remains authority; never mutates Web Sink from this path.
 */
async function syncActiveWebSinkFromBridge() {
  if (!storageProtected || !transport?.credential) {
    return { ok: false, reason: "web_sink_transport_unready" };
  }
  try {
    const res = await fetchCompanion("/web-sink/status", { method: "GET" });
    if (!isCurrentTransportResponse(res)) return { ok: false, reason: "stale_transport_response" };
    if (!res.ok || !res.body || typeof res.body !== "object") {
      activeWebSinkProjection = { binding: null, available: false, synced: false, checkedAt: Date.now() };
      return { ok: false, reason: "web_sink_status_unavailable" };
    }
    const b = res.body.activeBinding;
    const available = res.body.availability?.available === true;
    if (!b || typeof b !== "object") {
      // Successful authoritative read with no binding: still a successful sync.
      activeWebSinkProjection = { binding: null, available: false, synced: true, checkedAt: Date.now() };
      return { ok: true, binding: null, available: false };
    }
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
    if (
      res.body.workspaceId !== transport.workspaceId
      || b.workspaceId !== transport.workspaceId
      || b.pluginId !== "browser-companion"
      || b.surfaceId !== "chatgpt-web"
      || typeof b.bindingId !== "string"
      || !UUID.test(b.bindingId)
      || !Number.isInteger(b.epoch)
      || b.epoch < 1
      || b.epoch > 2147483647
      || typeof b.canonicalUrl !== "string"
      || typeof b.boundAt !== "string"
      || !ISO_INSTANT.test(b.boundAt)
    ) {
      activeWebSinkProjection = { binding: null, available: false, synced: false, checkedAt: Date.now() };
      return { ok: false, reason: "web_sink_response_invalid" };
    }
    // Bridge is authority: assign the whole projection atomically.
    activeWebSinkProjection = {
      binding: {
        bindingId: b.bindingId,
        pluginId: b.pluginId,
        surfaceId: b.surfaceId,
        workspaceId: b.workspaceId,
        canonicalUrl: b.canonicalUrl,
        epoch: b.epoch,
        boundAt: b.boundAt,
        created: false,
      },
      available,
      synced: true,
      checkedAt: Date.now(),
    };
    return { ok: true, binding: activeWebSinkProjection.binding, available };
  } catch {
    activeWebSinkProjection = { binding: null, available: false, synced: false, checkedAt: Date.now() };
    return { ok: false, reason: "web_sink_status_error" };
  }
}

/** Persist authStale before returning (survives SW restart). */
function boundedAuthReason(reason) {
  return ["COMPANION_UNAUTHORIZED", "COMPANION_EPOCH_STALE", "identity_missing",
    ...["workspaceId", "bindingId", "epoch", "companionId", "routeCanonical"].map(key => `identity_mismatch:${key}`)]
    .includes(reason) ? reason : "auth_revalidation_required";
}

async function markAuthStale(reason, response) {
  if (!isCurrentTransportResponse(response)) return { ok: false, reason: "stale_transport_response" };
  if (transport) {
    authFailureRevision += 1;
    transport = { ...transport, authStale: true, authStaleReason: boundedAuthReason(reason) };
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
  if (transportIdentityBlocked) return { ok: false, reason: "transport_identity_mismatch" };
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
  if (localRouteActive()) return { ok: false, reason: "local_route_pending" };
  if (transportIdentityBlocked) return { ok: false, reason: "transport_identity_mismatch" };
  let origin;
  try {
    origin = parseBridgeOrigin(message.bridgeOrigin, { allowLoopbackHttp: true });
  } catch (e) {
    return { ok: false, reason: e instanceof BridgeOriginError ? "bridge_origin_invalid" : "origin_error" };
  }
  if (origin !== project.bridgeOrigin) return { ok: false, reason: "project_origin_conflict" };
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
    || body.workspaceId !== project.workspaceId
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
  if (localRouteActive()) return { ok: false, reason: "local_route_pending" };
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
  // Do NOT mark R5c DONE before Web Sink convergence; keep a retryable pending state.
  const nextConnectFlow = identity
    ? { ...connectFlow, state: "COMPLETE_REQUESTED", updatedAt: Date.now() }
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
  let webSink = { ok: false, reason: "not_verified" };
  if (verified) {
    const witness = connectFlow.ownerWitness
      ? {
          tabId: connectFlow.ownerWitness.tabId,
          documentId: connectFlow.ownerWitness.documentId,
          generation: connectFlow.ownerWitness.generation,
          canonicalRoute: connectFlow.ownerWitness.canonicalRoute,
        }
      : null;
    if (!witness || !connectFlowOwnerWitnessMatches(connectFlow, ownerState.owner)) {
      webSink = { ok: false, reason: "owner_witness_required" };
    } else {
      webSink = await convergeExplicitVerifiedConnect(witness);
      if (webSink.ok && identity) {
        const doneFlow = finishConnectFlow(connectFlow, identity, "DONE");
        const prevFlow = connectFlow;
        connectFlow = doneFlow;
        if (!await persistConnectFlow()) {
          connectFlow = prevFlow;
          await persistConnectFlow().catch(() => false);
          return {
            ok: false,
            reason: "connect_done_persist_failed",
            routeVerification: stateRes?.status?.routeVerification ?? "PENDING",
            retryAllowed: true,
            webSink: null,
          };
        }
      }
    }
  }
  const autonomy = managed && verified && webSink.ok === true
    ? await rearmAutonomyAfterVerifiedConnect()
    : { ok: true, mode: parseAutonomyPolicy(autonomyPolicy).mode };
  return {
    ok: verified && webSink.ok === true,
    reason: stateRes?.ok ? (webSink.ok ? undefined : webSink.reason) : stateRes?.reason,
    routeVerification: stateRes?.status?.routeVerification ?? "PENDING",
    productionEligible: stateRes?.status?.productionEligible === true,
    autonomy: autonomy.mode,
    webSink: webSink.ok ? webSink.binding : null,
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
  if (!isCurrentTransportResponse(res)) return { ok: false, reason: "stale_transport_response" };
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
      workspaceId: transport.workspaceId,
      expectedRoute: owner.canonicalRoute,
      expectedGeneration: owner.generation,
    }, { documentId: owner.documentId });
  } catch {
    connectFlow = finishConnectFlow(connectFlow, identity, "OUTCOME_UNKNOWN");
    connectFlow.failureReason = "bootstrap_response_unavailable";
    await persistConnectFlow().catch(() => false);
    return { ok: false, reason: "bootstrap_outcome_unknown", state: "OUTCOME_UNKNOWN", retryAllowed: false };
  }

  const responseIdentityMatches = response?.type === "c2c.feedback.bootstrap.result"
    && response.mode === "feedback_bootstrap_send"
    && response.workspaceId === transport.workspaceId
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

  // R3p review-fix: "proven no mutation" must be provable on every axis. A
  // positive wrote === true already disproves no-mutation, so a missing
  // mutationAttempted alongside wrote === true can never land here — it falls
  // through to the OUTCOME_UNKNOWN fail-closed below. Only explicit
  // mutationAttempted !== true AND wrote !== true (and no click/observe) is
  // retryable without a dirty composer.
  const provenNoMutation = responseIdentityMatches
    && response.ok === false
    && response.mutationAttempted !== true
    && response.wrote !== true
    && response.clickAttempted !== true
    && response.observed !== true;
  if (provenNoMutation) {
    connectFlow = previous;
    if (await persistConnectFlow()) {
      return { ok: false, reason: response.reason || "bootstrap_not_dispatched", state: connectFlow.state, retryAllowed: true };
    }
  }
  // R3p (review-tightened): a PROVEN composer write that never reached the
  // irreversible click boundary is recoverable — never upgrade it to
  // OUTCOME_UNKNOWN. "Proven" requires positive mutationAttempted === true AND
  // wrote === true; missing/malformed booleans can never enter this recoverable
  // branch (they fall through to OUTCOME_UNKNOWN fail-closed). The fence rolls
  // back to its pre-dispatch state; nothing is auto-resent; the user clears the
  // dirty composer and Connects again explicitly.
  const writtenUnsent = responseIdentityMatches
    && response.ok === false
    && response.mutationAttempted === true
    && response.wrote === true
    && response.clickAttempted !== true
    && response.observed !== true;
  if (writtenUnsent) {
    const reason = response.reason === "bootstrap_send_not_ready"
      || response.reason === "bootstrap_written_unsent"
      ? response.reason
      : "bootstrap_written_unsent";
    connectFlow = previous;
    if (await persistConnectFlow()) {
      return {
        ok: false,
        reason,
        responseReason: response.reason ?? null,
        state: connectFlow.state,
        retryAllowed: true,
        composerDirty: true,
      };
    }
  }
  connectFlow = finishConnectFlow(connectFlow, identity, "OUTCOME_UNKNOWN");
  connectFlow.failureReason = typeof response?.reason === "string"
    && /^[a-zA-Z][a-zA-Z0-9_]{0,95}$/.test(response.reason)
    ? response.reason : "bootstrap_response_invalid";
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
  const ownerWitness = ownerState.owner
    ? {
        tabId: ownerState.owner.tabId,
        documentId: ownerState.owner.documentId,
        generation: ownerState.owner.generation,
        canonicalRoute: ownerState.owner.canonicalRoute,
      }
    : null;
  let begun;
  if (connectFlow.state === "ATTEST_REQUESTED" && connectFlowMatches(connectFlow, flowIdentity)) {
    if (!resumeExisting || connectFlow.bootstrapAutoResume !== true || routeAttestFence.state !== "NONE") {
      return { ok: false, reason: "connect_active", state: connectFlow.state, retryAllowed: false };
    }
    begun = { ok: true, flow: connectFlow };
  } else {
    begun = beginConnectAttestation(connectFlow, flowIdentity, ownerWitness);
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

  const managedFlow = connectFlow;
  const prevRouteAttestFence = routeAttestFence;
  const prevRouteAttestLatch = routeAttestLatch;
  const attested = await handleMessage(
    { type: ROUTE_ATTEST_SEND_TYPE },
    {},
    { transportMutationHeld: true, managedAttestRollback: true },
  );
  if (!attested?.ok) {
    // R3q: written-unsent route-attest is recoverable — the managed connectFlow
    // and the durable route-attest fence roll back together in ONE commit
    // (review-fix FIX_2: never a half-cleared pair); nothing is auto-resent.
    if (attested?.writtenUnsent === true) {
      routeAttestLatch = emptyRouteAttestLatch();
      routeAttestFence = emptyRouteAttestFence();
      connectFlow = emptyConnectFlow();
      if (await commitWrittenUnsentDurable(connectFlow, routeAttestFence)
        && await persistRouteAttestLatch()) {
        return { ...attested, state: "NONE", retryAllowed: true };
      }
      // Fail closed TOGETHER, with the exact managed identity: finishing the
      // EMPTY flow here would persist a null-identity OUTCOME_UNKNOWN that no
      // abandon path can ever clear. The hardened fence is minted from THIS
      // transport/challenge identity so the route-attest abandon stays a
      // complete recovery path.
      connectFlow = finishConnectFlow(managedFlow, flowIdentity, "OUTCOME_UNKNOWN");
      routeAttestFence = markRouteAttestFenceState({
        ...emptyRouteAttestFence(),
        companionId: transport?.companionId ?? null,
        challengeId: flowIdentity.challengeId,
        routeCanonical: flowIdentity.routeCanonical,
        challengeExpiresAt: typeof transport?.routeAttestationExpiresAt === "string"
          ? transport.routeAttestationExpiresAt
          : null,
      }, "OUTCOME_UNKNOWN");
      routeAttestLatch = { ...prevRouteAttestLatch, state: "OUTCOME_UNKNOWN" };
      await commitWrittenUnsentDurable(connectFlow, routeAttestFence);
      await persistRouteAttestLatch();
      return {
        ok: false,
        reason: "connect_fence_persist_failed",
        state: connectFlow.state,
        retryAllowed: false,
      };
    }
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
    // Keep ATTEST_REQUESTED until Web Sink convergence succeeds.
    const witness = connectFlow.ownerWitness
      ? {
          tabId: connectFlow.ownerWitness.tabId,
          documentId: connectFlow.ownerWitness.documentId,
          generation: connectFlow.ownerWitness.generation,
          canonicalRoute: connectFlow.ownerWitness.canonicalRoute,
        }
      : null;
    if (!witness || !connectFlowOwnerWitnessMatches(connectFlow, ownerState.owner)) {
      return {
        ok: false,
        state: connectFlow.state === "ATTEST_REQUESTED" ? "AWAITING_CONFIRMATION" : connectFlow.state,
        routeVerification: attested.routeVerification,
        reason: "owner_witness_required",
        retryAllowed: true,
      };
    }
    const sink = await convergeExplicitVerifiedConnect(witness);
    if (!sink.ok) {
      return {
        ok: false,
        state: connectFlow.state === "ATTEST_REQUESTED" ? "AWAITING_CONFIRMATION" : connectFlow.state,
        routeVerification: attested.routeVerification,
        reason: sink.reason || "web_sink_bind_failed",
        retryAllowed: true,
      };
    }
    connectFlow = finishConnectFlow(connectFlow, flowIdentity, "DONE");
    if (!await persistConnectFlow()) {
      connectFlow = finishConnectFlow(connectFlow, flowIdentity, "OUTCOME_UNKNOWN");
      await persistConnectFlow().catch(() => false);
      return { ok: false, reason: "connect_done_persist_failed", retryAllowed: false };
    }
    const autonomy = await rearmAutonomyAfterVerifiedConnect();
    return {
      ok: true,
      state: "CONNECTED",
      routeVerification: attested.routeVerification,
      autonomy: autonomy.mode,
      autonomyReason: autonomy.ok ? undefined : autonomy.reason,
      webSink: sink.binding,
    };
  }
  return {
    ok: true,
    state: "AWAITING_CONFIRMATION",
    routeVerification: attested.routeVerification,
    autonomy: "off",
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

function currentTakeoverRecoveryStage() {
  const stage = connectTakeoverRecoveryStage(connectFlow, transport, ownerState.owner?.canonicalRoute);
  if (!stage) return null;
  // A previous route Send or uncertain rebind cannot be erased by this recovery.
  // An exact VERIFIED old challenge can be retired by the normal new-pair path.
  const priorIdentity = connectFlowIdentity(transport);
  // Authenticated VERIFIED deliberately removes the one-time message. Its
  // durable VERIFIED fence retains the challenge; do not require erased text.
  const priorChallenge = priorIdentity?.challengeId
    ?? (transport.routeVerification === "VERIFIED" && isUuid(routeAttestFence.challengeId)
      ? routeAttestFence.challengeId : null);
  const fenceSafe = routeAttestFence.state === "NONE"
    || (stage === "verify_takeover" && routeAttestFence.state === "VERIFIED"
      && routeAttestFence.companionId === transport.companionId
      && priorChallenge !== null && routeAttestFence.challengeId === priorChallenge
      && areChatgptConversationRoutesEquivalent(routeAttestFence.routeCanonical, transport.routeCanonical));
  const latchSafe = routeAttestLatch.state === "NONE"
    || (stage === "verify_takeover" && routeAttestLatch.state === "VERIFIED"
      && priorChallenge !== null && routeAttestLatch.challengeId === priorChallenge
      && areChatgptConversationRoutesEquivalent(routeAttestLatch.canonicalRoute, transport.routeCanonical));
  return fenceSafe && latchSafe ? stage : null;
}

// Only an explicit Connect may resolve a bootstrap observation gap. Neither
// heartbeat nor popup status calls this; no bootstrap runner is invoked here.
async function recoverConnectTakeover() {
  const stage = currentTakeoverRecoveryStage();
  const blocked = { ok: false, reason: "connect_outcome_unknown", state: connectFlow.state, retryAllowed: false };
  if (!stage) return blocked;
  if (stage === "verify_takeover") {
    ownerProof = mintOwnerProof({
      tabId: ownerState.owner.tabId,
      documentId: ownerState.owner.documentId,
      routeCanonical: ownerState.owner.canonicalRoute,
    });
    const started = await handleRebindStart({ ownerProofId: ownerProof.id });
    if (!started.ok) return { ...started, state: connectFlow.state };
  }
  if (connectTakeoverRecoveryStage(connectFlow, transport, ownerState.owner?.canonicalRoute) !== "verify_page") {
    return blocked;
  }
  const previous = connectFlow;
  connectFlow = { ...connectFlow, state: "WAITING_TAKEOVER", updatedAt: Date.now() };
  if (!await persistConnectFlow()) {
    connectFlow = previous;
    return { ...blocked, reason: "connect_fence_persist_failed" };
  }
  return dispatchConnectRouteAttestation();
}

async function restoreSameTabOwnerReadOnly(sender, message, previousOwner) {
  const identity = resolveCurrentDocumentBindingIdentity(sender, message?.canonicalRoute ?? null);
  const currentOwner = ownerState.owner;
  if (!identity.ok || identity.identity.tabId !== previousOwner.tabId
    || (currentOwner && (identity.identity.documentId !== previousOwner.documentId
      || currentOwner.generation !== (Number.isFinite(message?.generation) ? Number(message.generation) : 1)
      || !isOwner(ownerState, identity.identity.tabId, identity.identity.documentId)))) return;
  const transportSnapshot = () => JSON.stringify({ ...localTransportIdentity(), credential: transport?.credential });
  const before = transportSnapshot();
  const beforeFlow = connectFlow;
  const documents = () => JSON.stringify(ownerState.registry.filter(doc => doc.tabId === identity.identity.tabId));
  const beforeDocuments = documents();
  const arrival = pageArrivals.get(identity.identity.tabId);
  const valid = () => !!arrival && arrival.documentId === identity.identity.documentId
    && arrival.generation === (Number.isFinite(message?.generation) ? Number(message.generation) : 1)
    && areChatgptConversationRoutesEquivalent(arrival.url, identity.identity.canonicalRoute)
    && ownerState.owner === currentOwner && journal.state === "NONE" && connectFlow === beforeFlow
    && transportSnapshot() === before && documents() === beforeDocuments && pageArrivals.get(identity.identity.tabId) === arrival && !localRouteActive();
  if (!valid() || !await localRoutePermission()) return;
  const state = await handleFetchState();
  if (!valid() || !state.ok || state.status.routeVerification !== "VERIFIED") return;
  const active = await syncActiveWebSinkFromBridge();
  if (!valid() || !active.ok || !active.available || active.binding?.canonicalUrl !== transport.routeCanonical) return;
  const bound = bindCurrentDocument(ownerState, identity.identity, { generation: message.generation });
  if (!bound.ok) return;
  const refreshed = refreshExplicitConnectOwnerWitness(connectFlow, bound.state.owner);
  if (!refreshed.ok) return;
  // 同tab重载或同document等价URL变化只读复核原授权；跨tab和新对话不能继承。
  await chrome.storage.local.set({ [CONNECT_FLOW_KEY]: refreshed.flow });
  if (!valid()) {
    await chrome.storage.local.set({ [CONNECT_FLOW_KEY]: connectFlow });
    return;
  }
  ownerState = bound.state; connectFlow = refreshed.flow; connectReason = null;
  await persistSessionOwnership();
}

// 本机确认候选凭据只暂存在受保护请求记录，生效后立即移入主 transport。
function localTransportIdentity(value = transport) {
  if (!value) return null;
  return Object.fromEntries(["bridgeOrigin", "workspaceId", "companionId", "bindingId", "epoch", "routeCanonical", "pairedAt"]
    .map(key => [key, value[key]]));
}

function parseLocalRouteRequest(value) {
  if (value == null) return null;
  if (!value || value.schemaVersion !== 1 || !isUuid(value.requestId)
    || value.workspaceId !== project.workspaceId || typeof value.routeCanonical !== "string"
    || !areChatgptConversationRoutesEquivalent(value.routeCanonical, value.routeCanonical)
    || !["REQUESTED", "PENDING", "COMMIT_REQUESTED", "COMMITTED", "DONE", "CANCELLED", "EXPIRED", "NOT_FOUND", "UPGRADE_REQUIRED", "RECOVERY_EXPIRED", "CHANGED"].includes(value.stage)
    || !value.originalIdentity || value.originalIdentity.workspaceId !== project.workspaceId
    || value.originalIdentity.bridgeOrigin !== project.bridgeOrigin
    || !isUuid(value.originalIdentity.companionId) || !isUuid(value.originalIdentity.bindingId)
    || !Number.isSafeInteger(value.originalIdentity.epoch)
    || !Number.isSafeInteger(value.ownerWitness?.tabId) || value.ownerWitness.tabId < 0
    || typeof value.ownerWitness?.documentId !== "string" || !value.ownerWitness.documentId
    || !Number.isSafeInteger(value.ownerWitness.generation) || value.ownerWitness.generation < 1
    || value.ownerWitness.canonicalRoute !== value.routeCanonical) return { stage: "INVALID" };
  return value;
}

function localRouteActive() {
  return !!localRouteRequest && !["DONE", "CANCELLED", "EXPIRED", "NOT_FOUND", "UPGRADE_REQUIRED", "RECOVERY_EXPIRED", "CHANGED"].includes(localRouteRequest.stage);
}

function localRouteSummary() {
  if (!localRouteRequest) return null;
  return { state: localRouteRequest.stage, requestId: localRouteRequest.requestId ?? null,
    routeCanonical: localRouteRequest.routeCanonical ?? null, expiresAt: localRouteRequest.expiresAt ?? null };
}

async function saveLocalRouteRequest(next) {
  await chrome.storage.local.set({ [LOCAL_ROUTE_KEY]: next });
  localRouteRequest = next;
}

function localRouteCurrent(request) {
  const expected = request?.stage === "COMMITTED" ? request.successorIdentity : request?.originalIdentity;
  const arrival = pageArrivals.get(request?.ownerWitness?.tabId);
  return request === localRouteRequest && storageProtected && !transportIdentityBlocked
    && expected && JSON.stringify(localTransportIdentity()) === JSON.stringify(expected)
    && journal.state === "NONE" && ownerStillMatches(request.ownerWitness)
    && (!arrival || (arrival.documentId === request.ownerWitness.documentId && arrival.generation === request.ownerWitness.generation
      && areChatgptConversationRoutesEquivalent(arrival.url, request.routeCanonical)))
    && !["OUTCOME_UNKNOWN", "TAKEOVER_DISPATCH", "WAITING_TAKEOVER"].includes(connectFlow.state)
    && ["NONE", "VERIFIED"].includes(routeAttestFence.state);
}

async function localRoutePermission() {
  try {
    return await chrome.permissions?.contains?.({ origins: [`${project.bridgeOrigin}/*`] }) === true;
  } catch { return false; }
}

async function startLocalRouteRequest(owner) {
  if (journal.state !== "NONE") return { ok: false, reason: "journal_active" };
  if (!["NONE", "DONE"].includes(connectFlow.state)
    || !["NONE", "VERIFIED"].includes(routeAttestFence.state)) {
    return { ok: false, reason: "local_route_fence_blocked", retryAllowed: false };
  }
  const request = { schemaVersion: 1, requestId: crypto.randomUUID(), workspaceId: project.workspaceId,
    routeCanonical: owner.canonicalRoute, originalIdentity: localTransportIdentity(),
    ownerWitness: { tabId: owner.tabId, documentId: owner.documentId, generation: owner.generation, canonicalRoute: owner.canonicalRoute },
    stage: "REQUESTED", expiresAt: null, updatedAt: Date.now() };
  await saveLocalRouteRequest(request);
  if (!localRouteCurrent(request) || !await localRoutePermission() || !localRouteCurrent(request)) return { ok: false, reason: "local_route_owner_changed" };
  // 持久化 REQUESTED 后仅一次 POST；任何未知结果都只 GET/status。
  let response;
  try {
    response = await fetchCompanion("/route/local/request", { method: "POST", body: JSON.stringify({
      requestId: request.requestId, routeCanonical: request.routeCanonical,
    }) });
  } catch { return { ok: true, state: "LOCAL_CONFIRM_PENDING", localRoute: localRouteSummary() }; }
  return applyLocalRouteResponse(request, response);
}

async function resumeLocalRouteExplicit(owner) {
  const request = localRouteRequest;
  const committed = request?.stage === "COMMITTED";
  const unknownCommit = request?.stage === "COMMIT_REQUESTED";
  const expected = committed ? request.successorIdentity : request?.originalIdentity;
  const arrival = pageArrivals.get(owner.tabId);
  const beforeFlow = connectFlow;
  const exact = () => !!arrival && arrival.documentId === owner.documentId && arrival.generation === owner.generation
    && areChatgptConversationRoutesEquivalent(arrival.url, owner.canonicalRoute)
    && request === localRouteRequest && ownerStillMatches(owner) && journal.state === "NONE"
    && pageArrivals.get(owner.tabId) === arrival && connectFlow === beforeFlow
    && JSON.stringify(localTransportIdentity()) === JSON.stringify(expected)
    && ["NONE", "DONE"].includes(connectFlow.state) && ["NONE", "VERIFIED"].includes(routeAttestFence.state);
  // 仅显式同目标Connect重建见证；未知commit先只读查证，绝不再次POST。
  if ((committed || unknownCommit) && expected && owner.canonicalRoute === request.routeCanonical && exact()) {
    if (!await localRoutePermission() || !exact()) return { ok: false, reason: "local_route_owner_changed" };
    let response;
    if (committed) {
      const state = await handleFetchState();
      if (!state.ok || !exact() || state.status.routeVerification !== "VERIFIED") return { ok: false, reason: "local_route_owner_changed" };
    } else {
      try { response = await fetchCompanion(`/route/local/status?requestId=${encodeURIComponent(request.requestId)}`, { method: "GET", cache: "no-store" }); }
      catch { return { ok: false, reason: "local_route_result_unverified" }; }
      if (!exact() || !isCurrentTransportResponse(response)) return { ok: false, reason: "local_route_owner_changed" };
      const body = response.body;
      const knownResult = response.ok && body?.requestId === request.requestId && body.workspaceId === request.workspaceId
        && body.routeCanonical === request.routeCanonical && ["COMMITTED", "EXPIRED"].includes(body.state);
      const ended = !response.ok && ["LOCAL_ROUTE_EXPIRED", "LOCAL_ROUTE_CHANGED"].includes(body?.error);
      if (!knownResult && !ended) return observeLocalRouteTerminal(request);
    }
    const witness = { tabId: owner.tabId, documentId: owner.documentId, generation: owner.generation, canonicalRoute: owner.canonicalRoute };
    const refreshed = committed ? refreshExplicitConnectOwnerWitness(connectFlow, witness) : { ok: true, flow: connectFlow };
    if (!refreshed.ok) return { ok: false, reason: "owner_witness_required" };
    const next = { ...request, ownerWitness: witness, updatedAt: Date.now() };
    await chrome.storage.local.set({ [LOCAL_ROUTE_KEY]: next, [CONNECT_FLOW_KEY]: refreshed.flow });
    if (!exact()) {
      await chrome.storage.local.set({ [LOCAL_ROUTE_KEY]: localRouteRequest, [CONNECT_FLOW_KEY]: connectFlow });
      return { ok: false, reason: "local_route_owner_changed" };
    }
    localRouteRequest = next; connectFlow = refreshed.flow;
    if (response) return applyLocalRouteResponse(next, response);
  }
  return progressLocalRouteRequest();
}

async function progressLocalRouteRequest() {
  const request = localRouteRequest;
  if (!localRouteCurrent(request)) return observeLocalRouteTerminal(request);
  if (!await localRoutePermission() || !localRouteCurrent(request)) return { ok: false, reason: "bridge_permission_missing" };
  if (request.stage === "COMMITTED") return finishLocalRouteConnection(request);
  let response;
  try { response = await fetchCompanion(`/route/local/status?requestId=${encodeURIComponent(request.requestId)}`, { method: "GET", cache: "no-store" }); }
  catch { return { ok: true, state: "LOCAL_CONFIRM_PENDING", localRoute: localRouteSummary() }; }
  return applyLocalRouteResponse(request, response);
}

async function observeLocalRouteTerminal(request) {
  // owner 丢失只可查询终态；不能提交或应用配对，也不以本机时钟推断未提交。
  const exact = () => request === localRouteRequest && request?.originalIdentity
    && JSON.stringify(localTransportIdentity()) === JSON.stringify(request.originalIdentity) && journal.state === "NONE";
  if (!exact() || !await localRoutePermission() || !exact()) return { ok: false, reason: "local_route_owner_changed" };
  let response;
  try { response = await fetchCompanion(`/route/local/status?requestId=${encodeURIComponent(request.requestId)}`, { method: "GET", cache: "no-store" }); }
  catch { return { ok: false, reason: "local_route_owner_changed" }; }
  if (!exact() || !isCurrentTransportResponse(response)) return { ok: false, reason: "local_route_owner_changed" };
  const body = response.body;
  const terminal = response.ok && body?.requestId === request.requestId && body.workspaceId === request.workspaceId
    && body.routeCanonical === request.routeCanonical && ["CANCELLED", "EXPIRED"].includes(body.state)
    ? body.state : body?.error === "LOCAL_ROUTE_EXPIRED" ? "EXPIRED" : body?.error === "LOCAL_ROUTE_UNKNOWN" ? "NOT_FOUND" : body?.error === "LOCAL_ROUTE_CHANGED" ? "CHANGED" : null;
  if (terminal || (response.status === 401 && request.stage === "COMMIT_REQUESTED")) {
    const stage = request.stage === "COMMIT_REQUESTED" ? "RECOVERY_EXPIRED" : terminal;
    await saveLocalRouteRequest({ ...request, stage, updatedAt: Date.now() });
    return { ok: false, reason: stage === "RECOVERY_EXPIRED" ? "local_route_repair_required" : "local_route_request_ended", localRoute: localRouteSummary() };
  }
  return { ok: false, reason: "local_route_owner_changed", localRoute: localRouteSummary() };
}

async function applyLocalRouteResponse(request, response) {
  if (!localRouteCurrent(request) || !isCurrentTransportResponse(response)) return { ok: false, reason: "local_route_owner_changed" };
  if (!response.ok) {
    if (response.status === 401) {
      if (request.stage === "COMMIT_REQUESTED") {
        await saveLocalRouteRequest({ ...request, stage: "RECOVERY_EXPIRED", updatedAt: Date.now() });
        return { ok: false, reason: "local_route_repair_required", localRoute: localRouteSummary() };
      }
      return markAuthStale(response.body?.error || "COMPANION_UNAUTHORIZED", response);
    }
    let stage = response.status === 404 || response.status === 405 ? "UPGRADE_REQUIRED"
      : response.body?.error === "LOCAL_ROUTE_UNKNOWN" ? "NOT_FOUND"
      : response.body?.error === "LOCAL_ROUTE_EXPIRED" ? "EXPIRED"
      : response.body?.error === "LOCAL_ROUTE_CHANGED" ? "CHANGED" : null;
    if (["EXPIRED", "CHANGED"].includes(stage) && request.stage === "COMMIT_REQUESTED" && request.stagedPairing) return recoverStagedLocalRoute(request);
    if (stage && request.stage === "COMMIT_REQUESTED") stage = "RECOVERY_EXPIRED";
    if (stage) await saveLocalRouteRequest({ ...request, stage, updatedAt: Date.now() });
    if (stage === "RECOVERY_EXPIRED") return { ok: false, reason: "local_route_repair_required", localRoute: localRouteSummary() };
    return { ok: false, reason: stage === "UPGRADE_REQUIRED" ? "local_route_upgrade_required" : response.body?.error || "local_route_unavailable",
      localRoute: localRouteSummary() };
  }
  const body = response.body;
  if (!body || body.requestId !== request.requestId || body.workspaceId !== request.workspaceId
    || body.routeCanonical !== request.routeCanonical || typeof body.expiresAt !== "string" || !Number.isFinite(Date.parse(body.expiresAt))
    || !["PENDING", "CONFIRMED", "CANCELLED", "EXPIRED", "COMMITTED"].includes(body.state)) {
    return { ok: false, reason: "local_route_response_invalid" };
  }
  if (body.state === "COMMITTED") return adoptLocalRoutePairing(request, body);
  if (body.state === "EXPIRED" && request.stage === "COMMIT_REQUESTED" && request.stagedPairing) {
    return recoverStagedLocalRoute(request);
  }
  if (["CANCELLED", "EXPIRED"].includes(body.state)) {
    const stage = request.stage === "COMMIT_REQUESTED" ? "RECOVERY_EXPIRED" : body.state;
    await saveLocalRouteRequest({ ...request, stage, expiresAt: body.expiresAt, updatedAt: Date.now() });
    if (stage === "RECOVERY_EXPIRED") return { ok: false, reason: "local_route_repair_required", localRoute: localRouteSummary() };
    return { ok: true, state: `LOCAL_CONFIRM_${body.state}`, localRoute: localRouteSummary() };
  }
  if (body.state === "CONFIRMED" && request.stage !== "COMMIT_REQUESTED") {
    if (!validLocalPairing(request, body.candidatePairing)) return { ok: false, reason: "local_route_candidate_invalid" };
    const committing = { ...request, stage: "COMMIT_REQUESTED", stagedPairing: body.candidatePairing,
      expiresAt: body.expiresAt, updatedAt: Date.now() };
    await saveLocalRouteRequest(committing);
    if (!localRouteCurrent(committing) || !await localRoutePermission() || !localRouteCurrent(committing)) {
      return { ok: false, reason: "local_route_owner_changed" };
    }
    let committed;
    try { committed = await fetchCompanion("/route/local/commit", { method: "POST", body: JSON.stringify({
      requestId: committing.requestId, routeCanonical: committing.routeCanonical,
    }) }); }
    catch { return { ok: true, state: "LOCAL_CONFIRM_PENDING", localRoute: localRouteSummary() }; }
    return applyLocalRouteResponse(committing, committed);
  }
  if (request.stage !== "COMMIT_REQUESTED") await saveLocalRouteRequest({ ...request, stage: "PENDING", expiresAt: body.expiresAt, updatedAt: Date.now() });
  return { ok: true, state: "LOCAL_CONFIRM_PENDING", localRoute: localRouteSummary() };
}

function validLocalPairing(request, pairing) {
  return !!pairing && pairing.workspaceId === project.workspaceId
    && pairing.routeCanonical === request.routeCanonical && pairing.routeVerification === "VERIFIED"
    && isUuid(pairing.companionId) && isUuid(pairing.bindingId) && isUuid(pairing.challengeId)
    && pairing.companionId !== transport?.companionId && pairing.bindingId === transport?.bindingId
    && pairing.challengeId !== connectFlowIdentity(transport)?.challengeId
    && pairing.epoch === transport?.epoch && typeof pairing.credential === "string" && pairing.credential.length > 0
    && pairing.credential.length <= 4096 && pairing.credential !== transport?.credential;
}

async function recoverStagedLocalRoute(request) {
  if (!localRouteCurrent(request) || !validLocalPairing(request, request.stagedPairing)
    || !await localRoutePermission() || !localRouteCurrent(request)) return { ok: false, reason: "local_route_repair_required" };
  let response, body;
  try {
    response = await fetch(companionApiUrl(project.bridgeOrigin, "/state"), { method: "GET", cache: "no-store",
      headers: { authorization: `Bearer ${request.stagedPairing.credential}` }, signal: AbortSignal.timeout(15_000) });
    body = await response.json();
  } catch { return { ok: false, reason: "local_route_result_unverified" }; }
  if (!localRouteCurrent(request)) return { ok: false, reason: "local_route_owner_changed" };
  if (!response.ok || !validateStateIdentity(request.stagedPairing, body).ok || body.routeVerification !== "VERIFIED") {
    if (response.status === 401) {
      // candidate未启用且原credential仍认证原identity，才可证明过期请求未切换主transport。
      const original = await handleFetchState();
      if (original.ok && localRouteCurrent(request)) {
        const ended = { ...request, stage: "EXPIRED", updatedAt: Date.now() };
        delete ended.stagedPairing;
        await saveLocalRouteRequest(ended);
        return { ok: false, reason: "local_route_request_ended", localRoute: localRouteSummary() };
      }
    }
    return { ok: false, reason: "local_route_result_unverified" };
  }
  return adoptLocalRoutePairing(request, { pairing: request.stagedPairing, expiresAt: request.expiresAt });
}

async function adoptLocalRoutePairing(request, body) {
  const pairing = body.pairing;
  if (!localRouteCurrent(request) || !validLocalPairing(request, pairing)
    || (request.stagedPairing && ["credential", "companionId", "bindingId", "epoch", "challengeId", "routeCanonical", "workspaceId"]
      .some(key => request.stagedPairing[key] !== pairing[key]))) return { ok: false, reason: "local_route_pairing_invalid" };
  const nextTransport = { schemaVersion: 1, bridgeOrigin: project.bridgeOrigin, workspaceId: project.workspaceId,
    companionId: pairing.companionId, bindingId: pairing.bindingId, epoch: pairing.epoch,
    routeCanonical: pairing.routeCanonical, pairedAt: new Date().toISOString(), credential: pairing.credential,
    authStale: false, rebindPending: false, routeVerification: "VERIFIED", challengeId: pairing.challengeId,
    routeAttestationMessage: null, routeAttestationExpiresAt: null };
  const resolved = resolvePairFenceAfterSuccess({ prevFence: routeAttestFence, companionId: pairing.companionId,
    challengeId: pairing.challengeId, routeCanonical: pairing.routeCanonical, now: Date.now() });
  if (!resolved.ok) return { ok: false, reason: "local_route_fence_blocked" };
  const nextFence = { ...resolved.fence, state: "VERIFIED" };
  const nextFlow = { ...connectFlowIdentity(nextTransport), state: "DONE", ownerWitness: request.ownerWitness,
    bootstrapAutoResume: false, updatedAt: Date.now() };
  const nextRequest = { ...request, stage: "COMMITTED", successorIdentity: localTransportIdentity(nextTransport), expiresAt: body.expiresAt, updatedAt: Date.now() };
  delete nextRequest.stagedPairing;
  const nextLocal = { ...localState, paired: true, targetRoute: request.routeCanonical };
  if (!localRouteCurrent(request)) return { ok: false, reason: "local_route_owner_changed" };
  // 配对和请求收据一次落盘；失败仍用原 credential 只读查询已提交结果。
  await chrome.storage.local.set({ [TRANSPORT_KEY]: nextTransport, [LOCAL_KEY]: nextLocal,
    [CONNECT_FLOW_KEY]: nextFlow, [ROUTE_ATTEST_FENCE_KEY]: nextFence, [LOCAL_ROUTE_KEY]: nextRequest });
  transport = nextTransport; localState = nextLocal; connectFlow = nextFlow;
  routeAttestFence = nextFence; routeAttestLatch = emptyRouteAttestLatch(); localRouteRequest = nextRequest;
  activeWebSinkProjection = { binding: null, available: false, synced: false };
  if (!localRouteCurrent(nextRequest)) return { ok: false, reason: "local_route_owner_changed" };
  return finishLocalRouteConnection(nextRequest);
}

async function finishLocalRouteConnection(request) {
  if (!localRouteCurrent(request)) return { ok: false, reason: "local_route_owner_changed" };
  const state = await handleFetchState();
  if (!state.ok) return state;
  if (!localRouteCurrent(request) || state.status.routeVerification !== "VERIFIED") return { ok: false, reason: "local_route_owner_changed" };
  const sink = await convergeExplicitVerifiedConnect(request.ownerWitness);
  if (!sink.ok) return sink;
  if (!localRouteCurrent(request)) return { ok: false, reason: "local_route_owner_changed" };
  await saveLocalRouteRequest({ ...request, stage: "DONE", updatedAt: Date.now() });
  if (!ownerStillMatches(request.ownerWitness) || journal.state !== "NONE"
    || JSON.stringify(localTransportIdentity()) !== JSON.stringify(request.successorIdentity)) return { ok: false, reason: "local_route_owner_changed" };
  const autonomy = await rearmAutonomyAfterVerifiedConnect();
  if (!ownerStillMatches(request.ownerWitness)) {
    await forceAutonomyOff("local_route_owner_changed");
    return { ok: false, reason: "local_route_owner_changed" };
  }
  connectReason = null;
  return { ok: true, state: "CONNECTED", r5cConnected: true, routeVerification: "VERIFIED", webSink: sink.binding,
    autonomy: autonomy.mode, deliveryRecovery: deliveryRecoverySummary(), localRoute: localRouteSummary() };
}

async function handleConnectPage(sender, message) {
  if (connectInFlight) return { ok: false, reason: "connect_in_flight", retryAllowed: false };
  if (productionSendInFlight || productionRecoveryInFlight || autonomyTickInFlight) {
    return { ok: false, reason: "production_recovery_busy", retryAllowed: true };
  }
  connectInFlight = true;
  try {
    if (!storageProtected) return { ok: false, reason: "storage_unprotected" };
    const currentDocument = resolveCurrentDocumentBindingIdentity(sender, message?.canonicalRoute ?? null);
    if (!currentDocument.ok) return { ok: false, reason: currentDocument.reason };
    const identity = currentDocument.identity;
    const canonicalRoute = identity.canonicalRoute;
    const journalAtConnect = exactJournalSnapshot(journal);
    const hasDelivery = journal.state !== "NONE";
    const originalTransport = transport ? { ...transport } : null;
    const sameTransport = () => !!transport && !!originalTransport
      && ["bridgeOrigin", "workspaceId", "companionId", "bindingId", "epoch", "routeCanonical", "credential", "pairedAt"]
        .every(key => transport[key] === originalTransport[key]);
    // 旧消息只允许恢复原 VERIFIED 对话，不放宽 Pair/Rebind/未知连接 fence。
    if (hasDelivery && (!sameTransport() || transport.rebindPending === true
      || transport.routeVerification !== "VERIFIED"
      || !areChatgptConversationRoutesEquivalent(transport.routeCanonical, canonicalRoute)
      || journal.bindingId !== transport.bindingId || journal.epoch !== transport.epoch
      || !areChatgptConversationRoutesEquivalent(journal.routeCanonical, canonicalRoute)
      || !["NONE", "DONE"].includes(connectFlow.state)
      || !["NONE", "VERIFIED"].includes(routeAttestFence.state)
      || (connectFlow.state === "DONE" && !verifiedConnectFlowMatchesTransport(connectFlow, transport)))) {
      return { ok: false, reason: "journal_active" };
    }
    const checkPermission = async () => {
      if (!transport?.bridgeOrigin || !transport?.credential) return { ok: false, reason: "cold_pair_required" };
      try {
        const origin = parseBridgeOrigin(transport.bridgeOrigin, { allowLoopbackHttp: true });
        if (await chrome.permissions?.contains?.({ origins: [`${origin}/*`] }) === true) return { ok: true };
      } catch {}
      return { ok: false, reason: "bridge_permission_missing" };
    };

    let verifiedState = null;
    if (hasDelivery) {
      const permission = await checkPermission();
      if (!permission.ok) return permission;
      verifiedState = await handleFetchState();
      if (!verifiedState.ok) return verifiedState;
      if (!sameTransport() || exactJournalSnapshot(journal) !== journalAtConnect) {
        return { ok: false, reason: "connect_identity_changed", retryAllowed: false };
      }
      if (verifiedState.status.routeVerification !== "VERIFIED") {
        return { ok: false, reason: "route_not_verified", retryAllowed: false };
      }
    }
    const autonomyOff = await forceAutonomyOff("connect");
    if (!autonomyOff.ok) {
      return { ok: false, reason: "autonomy_persist_failed", autonomy: "off", retryAllowed: true };
    }
    const generation = Number.isFinite(message?.generation) ? Number(message.generation) : 1;
    const bound = bindCurrentDocument(ownerState, identity, { generation });
    if (!bound.ok) return { ok: false, reason: bound.reason };
    ownerState = bound.state;
    const explicitOwner = { ...ownerState.owner };
    const connectCurrent = () => sameTransport() && ownerStillMatches(explicitOwner)
      && transport?.authStale !== true && transport?.routeVerification === "VERIFIED";
    const connectUnchanged = () => connectCurrent() && exactJournalSnapshot(journal) === journalAtConnect;
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
    if (!hasDelivery) {
      const permission = await checkPermission();
      if (!permission.ok) return permission;
    }

    if (localRouteRequest?.stage === "RECOVERY_EXPIRED") return { ok: false, reason: "local_route_repair_required" };
    if (localRouteActive()) return resumeLocalRouteExplicit(explicitOwner);
    const freshLocalFlow = ["NONE", "DONE"].includes(connectFlow.state);
    if (freshLocalFlow && (transport.rebindPending === true || transport.routeVerification !== "VERIFIED"
      || !areChatgptConversationRoutesEquivalent(transport.routeCanonical, canonicalRoute))) {
      return startLocalRouteRequest(explicitOwner);
    }
    if (connectFlow.state === "TAKEOVER_DISPATCH" || connectFlow.state === "OUTCOME_UNKNOWN") {
      return await recoverConnectTakeover();
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
      const current = verifiedState ?? await handleFetchState();
      if (!sameTransport() || !ownerStillMatches(explicitOwner)
        || exactJournalSnapshot(journal) !== journalAtConnect) {
        return { ok: false, reason: "connect_identity_changed", retryAllowed: false };
      }
      if (current?.ok && current.status?.routeVerification === "VERIFIED") {
        if (!ownerState.owner) {
          return { ok: false, reason: "not_exact_owner", retryAllowed: false };
        }
        const currentOwner = {
          tabId: ownerState.owner.tabId,
          documentId: ownerState.owner.documentId,
          generation: ownerState.owner.generation,
          canonicalRoute: ownerState.owner.canonicalRoute,
        };
        // Explicit Connect only: rebase stale owner witness for this exact transport.
        if (connectFlow.state === "DONE"
          && !verifiedConnectFlowMatchesTransport(connectFlow, transport)) {
          return { ok: false, reason: "connect_identity_conflict", retryAllowed: false };
        }
        if (["ATTEST_REQUESTED", "COMPLETE_REQUESTED", "DONE"].includes(connectFlow.state)) {
          const refreshed = refreshExplicitConnectOwnerWitness(connectFlow, currentOwner);
          if (refreshed.ok) {
            const prev = connectFlow;
            connectFlow = refreshed.flow;
            if (!await persistConnectFlow()) {
              connectFlow = prev;
              await persistConnectFlow().catch(() => false);
              return { ok: false, reason: "connect_witness_persist_failed", retryAllowed: true };
            }
          }
        }
        // Establish local R5c DONE flow when none exists (legacy VERIFIED bootstrap).
        if (connectFlow.state === "NONE") {
          const fi = connectFlowIdentity(transport);
          if (!fi) {
            return { ok: false, reason: "connect_identity_invalid", retryAllowed: false };
          }
          connectFlow = {
            state: "ATTEST_REQUESTED",
            ...fi,
            ownerWitness: currentOwner,
            bootstrapAutoResume: false,
            updatedAt: Date.now(),
          };
          if (!await persistConnectFlow()) {
            connectFlow = emptyConnectFlow();
            await persistConnectFlow().catch(() => false);
            return { ok: false, reason: "connect_witness_persist_failed", retryAllowed: true };
          }
        }
        const witness = connectFlow.ownerWitness
          ? {
              tabId: connectFlow.ownerWitness.tabId,
              documentId: connectFlow.ownerWitness.documentId,
              generation: connectFlow.ownerWitness.generation,
              canonicalRoute: connectFlow.ownerWitness.canonicalRoute,
            }
          : null;
        if (!witness || !connectFlowOwnerWitnessMatches(connectFlow, currentOwner)) {
          return { ok: false, reason: "owner_witness_required", retryAllowed: true };
        }
        let previousSink = null;
        if (hasDelivery) {
          const active = await syncActiveWebSinkFromBridge();
          if (!connectUnchanged()) return { ok: false, reason: "connect_identity_changed", retryAllowed: false };
          if (!active.ok || !active.available || !active.binding
            || active.binding.canonicalUrl !== transport.routeCanonical) {
            return { ok: false, reason: "delivery_web_sink_mismatch", retryAllowed: false };
          }
          previousSink = active.binding;
        }
        if (!connectUnchanged()) return { ok: false, reason: "connect_identity_changed", retryAllowed: false };
        // 有旧记录时只复用现役目标；GET/POST 间目标变化不能造成新绑定。
        const sink = previousSink ? { ok: true, binding: previousSink } : await convergeExplicitVerifiedConnect(witness);
        if (!connectUnchanged()) return { ok: false, reason: "connect_identity_changed", retryAllowed: false };
        if (!sink.ok) {
          return { ok: false, reason: sink.reason || "web_sink_bind_failed", retryAllowed: true };
        }
        const fiDone = [connectFlowIdentity(transport), {
          workspaceId: connectFlow.workspaceId,
          bindingId: connectFlow.bindingId,
          epoch: connectFlow.epoch,
          companionId: connectFlow.companionId,
          routeCanonical: connectFlow.routeCanonical,
          challengeId: connectFlow.challengeId,
        }].find((c) => c && connectFlowMatches(connectFlow, c));
        if (!fiDone) {
          return { ok: false, reason: "connect_identity_invalid", retryAllowed: true };
        }
        const doneFlow = finishConnectFlow(connectFlow, fiDone, "DONE");
        const prevFlow = connectFlow;
        connectFlow = doneFlow;
        if (!await persistConnectFlow()) {
          connectFlow = prevFlow;
          await persistConnectFlow().catch(() => false);
          return { ok: false, reason: "connect_done_persist_failed", retryAllowed: true };
        }
        if (!connectUnchanged()) return { ok: false, reason: "connect_identity_changed", retryAllowed: false };
        const recovery = hasDelivery
          ? await handleRecover({ observeOnly: true, isCurrent: connectCurrent })
          : null;
        if (!connectCurrent()) return { ok: false, reason: "connect_identity_changed", retryAllowed: false };
        if (recovery?.status === 403) return { ok: false, reason: recovery.reason || "http_403" };
        const deliveryRecovery = deliveryRecoverySummary(recovery);
        const autonomy = deliveryRecovery.blocked
          ? { ok: true, mode: "off" }
          : await rearmAutonomyAfterVerifiedConnect();
        if (!connectCurrent()) {
          await forceAutonomyOff("connect_identity_changed");
          return { ok: false, reason: "connect_identity_changed", retryAllowed: false };
        }
        return {
          ok: true,
          state: "CONNECTED",
          routeVerification: "VERIFIED",
          autonomy: autonomy.mode,
          autonomyReason: autonomy.ok ? undefined : autonomy.reason,
          webSink: sink.binding,
          r5cConnected: true,
          deliveryRecovery,
        };
      }
      currentPairPending = current?.ok === true
        && current.status?.routeVerification === "PENDING";
      if (current?.ok !== true && current?.authStale !== true) {
        return { ok: false, reason: current?.reason || "state_unavailable" };
      }
    }

    if (hasDelivery) return { ok: false, reason: "journal_active", retryAllowed: false };
    if (freshLocalFlow) return startLocalRouteRequest(explicitOwner);
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
  // A stale observation blocks writes, not a fresh read with the SAME credential.
  // Otherwise a transient rejection permanently disables its own recovery path.
  if (!storageProtected) return { ok: false, reason: "storage_unprotected" };
  if (transportIdentityBlocked) return { ok: false, reason: "transport_identity_mismatch" };
  if (!transport?.credential) return { ok: false, reason: "transport_missing" };
  try {
    const res = await fetchCompanion("/state", { method: "GET" });
    if (!isCurrentTransportResponse(res)) return { ok: false, reason: "stale_transport_response" };
    if (requestTransports.get(res).requestAuthRevision !== authFailureRevision) {
      return { ok: false, reason: "stale_transport_response" };
    }
    if (res.status === 401 && transport?.rebindPending === true) {
      return { ok: false, reason: "rebind_pending", authStale: false };
    }
    if (res.status === 401) {
      return markAuthStale(res.body?.error || "COMPANION_UNAUTHORIZED", res);
    }
    if (res.status === 409 && res.body?.error === "COMPANION_REPAIR_BLOCKED") {
      return { ok: false, reason: "COMPANION_REPAIR_BLOCKED", status: 409 };
    }
    if (!res.ok) {
      return { ok: false, reason: res.body?.error || `http_${res.status}`, ...(res.status === 403 ? { status: 403 } : {}) };
    }
    assertNoForbiddenFields(res.body);
    if (!res.body || typeof res.body !== "object" || Array.isArray(res.body)
      || !["workspaceId", "bindingId", "epoch", "companionId", "routeCanonical"].every(key => key in res.body)) {
      return { ok: false, reason: "state_response_invalid" };
    }
    const isolatedAttempts = parseServerIsolatedAttempts(res.body.isolatedAttempts);
    if (!isolatedAttempts.ok) return { ok: false, reason: "state_response_invalid" };
    const idCheck = validateStateIdentity(transport, res.body);
    if (!idCheck.ok) {
      return markAuthStale(idCheck.reason, res);
    }
    // Authenticated /state is the ONLY route-verification authority.
    const sync = syncTransportRouteVerification(transport, res.body);
    if (sync.ok) {
      if (sync.downgraded) {
        await forceAutonomyOff("route_verification_downgrade");
      }
      if (!isCurrentTransportResponse(res)
        || requestTransports.get(res).requestAuthRevision !== authFailureRevision) {
        return { ok: false, reason: "stale_transport_response" };
      }
      const nextTransport = { ...sync.transport, authStale: false };
      delete nextTransport.authStaleReason;
      // Keep writes blocked in memory until the exact successful recheck is durable.
      await chrome.storage.local.set({ [TRANSPORT_KEY]: nextTransport });
      if (!isCurrentTransportResponse(res)
        || requestTransports.get(res).requestAuthRevision !== authFailureRevision) {
        await persistTransport();
        return { ok: false, reason: "stale_transport_response" };
      }
      transport = nextTransport;
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
        inFlight: res.body.inFlight && typeof res.body.inFlight === "object"
          ? { ...res.body.inFlight, routeCanonical: res.body.routeCanonical }
          : null,
        isolatedAttempts: isolatedAttempts.attempts,
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
  if (connectInFlight || productionRecoveryInFlight) return { ok: false, reason: "production_recovery_busy" };
  const gate = requireProtectedTransport();
  if (!gate.ok) return gate;
  const refresh = await refreshPageObservation(sender, message);
  if (!refresh.ok) return { ok: false, reason: refresh.reason };
  if (!refresh.isOwnerExact || !refresh.documentId) {
    return { ok: false, reason: "not_exact_owner" };
  }
  const readiness = connectionReadiness(refresh.tabId, refresh.documentId);
  if (!readiness.ready) return { ok: false, reason: readiness.reason };
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

  const requestIdentity = JSON.stringify({ ...localTransportIdentity(), credential: transport.credential });
  const requestOwner = { ...ownerState.owner };
  const requestAuthRevision = authFailureRevision;
  const routeCanonical = eligibility.routeCanonical;
  journal = markReserveRequested(journal, {
    routeCanonical,
    bindingId: transport.bindingId,
    epoch: transport.epoch,
  });
  const requestedJournal = journal;
  await persistJournal();
  // 落盘等待不能把旧预约继承到新身份；尚未发出请求时只撤回本次 journal。
  if (journal !== requestedJournal || productionRecoveryInFlight
    || requestIdentity !== JSON.stringify({ ...localTransportIdentity(), credential: transport?.credential })
    || requestAuthRevision !== authFailureRevision || !ownerStillMatches(requestOwner)
    || !connectionReadiness(refresh.tabId, refresh.documentId).ready) {
    if (journal === requestedJournal) journal = clearJournal();
    // 较早的异步写可能覆盖已完成的 recovery；重新持久化当前 journal。
    await persistJournal();
    return { ok: false, reason: "connection_changed", journalState: journal.state };
  }

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
  if (!isCurrentTransportResponse(res)) return { ok: false, reason: "stale_transport_response" };
  if (res.status === 401) {
    journal = markReservationRecovery(journal, { routeCanonical });
    await persistJournal();
    return markAuthStale(res.body?.error || "COMPANION_UNAUTHORIZED", res);
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
  if (!isCurrentTransportResponse(res)) return { ok: false, reason: "stale_transport_response" };
  if (res.status === 401) return markAuthStale(res.body?.error || "COMPANION_UNAUTHORIZED", res);
  if (res.ok) {
    journal = clearJournal();
    await persistJournal();
    return { ok: true, journal: { state: "NONE" } };
  }
  return { ok: false, reason: res.body?.error || `http_${res.status}`, status: res.status };
}

function exactJournalSnapshot(journal) {
  return JSON.stringify(journal);
}

async function unknownJournalMessageHashMatches(journal) {
  if (typeof journal?.message !== "string" || typeof journal?.messageSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(journal.messageSha256)) return false;
  try {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(journal.message)));
    const hex = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
    return hex === journal.messageSha256;
  } catch { return false; }
}

function unknownIsolationResult(reason, extra = {}) {
  return {
    ok: false,
    reason,
    action: "block",
    journal: summarizeProductionJournal(journal),
    zeroWrite: true,
    zeroClick: true,
    beginSendCalled: false,
    ackCalled: false,
    ...extra,
  };
}

async function clearIsolatedUnknownFromState(serverAttempt) {
  if (!outcomeUnknownArchiveValid) return unknownIsolationResult("isolation_archive_invalid");
  const archived = findOutcomeUnknownArchiveEntry(outcomeUnknownArchive, journal);
  if (!archived) return unknownIsolationResult("isolation_archive_missing");
  if (!serverAttempt || serverAttempt.isolated !== true) return unknownIsolationResult("isolated_attempt_unverified");
  const snapshot = exactJournalSnapshot(journal);
  if (!await unknownJournalMessageHashMatches(journal)
    || !await unknownJournalMessageHashMatches(archived.journal)
    || exactJournalSnapshot(journal) !== snapshot) return unknownIsolationResult("isolation_message_hash_mismatch");
  if (archived.status !== "isolated") {
    const marked = markOutcomeUnknownArchiveIsolated(outcomeUnknownArchive, journal);
    if (!marked.ok) return unknownIsolationResult(marked.reason);
    try { await persistOutcomeUnknownArchive(marked.archive); }
    catch { return unknownIsolationResult("isolation_archive_persist_failed", { serverIsolated: true }); }
  }
  if (connectRecoveryCurrent && !connectRecoveryCurrent()) return unknownIsolationResult("recovery_identity_changed");
  if (exactJournalSnapshot(journal) !== snapshot) return unknownIsolationResult("journal_identity_changed");
  const previous = journal;
  journal = clearJournal();
  try { await persistJournal(); }
  catch {
    journal = previous;
    return unknownIsolationResult("journal_persist_failed", { serverIsolated: true });
  }
  productionClaimProof = null;
  productionAckProof = null;
  return {
    ok: true,
    recovered: true,
    action: "isolated_unknown_clear",
    isolated: true,
    observed: false,
    archived: true,
    journal: { state: "NONE" },
    zeroWrite: true,
    zeroClick: true,
    beginSendCalled: false,
    ackCalled: false,
  };
}

async function requestUnknownTerminalGone(journalAtStart) {
  if (!outcomeUnknownArchiveValid) return unknownIsolationResult("isolation_archive_invalid");
  if (journalAtStart?.state !== "OUTCOME_UNKNOWN" || typeof journalAtStart.terminalWitness !== "string"
    || !journalAtStart.terminalWitness || journalAtStart.terminalWitness.length > 4096) {
    return unknownIsolationResult("terminal_witness_missing");
  }
  if (!await unknownJournalMessageHashMatches(journalAtStart)) return unknownIsolationResult("isolation_message_hash_mismatch");
  const snapshot = exactJournalSnapshot(journalAtStart);
  let archived = findOutcomeUnknownArchiveEntry(outcomeUnknownArchive, journalAtStart);
  if (!archived) {
    const next = appendOutcomeUnknownArchive(outcomeUnknownArchive, journalAtStart);
    if (!next.ok) return unknownIsolationResult(next.reason);
    try { await persistOutcomeUnknownArchive(next.archive); }
    catch { return unknownIsolationResult("isolation_archive_persist_failed"); }
    archived = findOutcomeUnknownArchiveEntry(outcomeUnknownArchive, journalAtStart);
  }
  if (!archived) return unknownIsolationResult("terminal_gone_archive_missing");
  if (journal.state !== "OUTCOME_UNKNOWN" || exactJournalSnapshot(journal) !== snapshot) {
    return unknownIsolationResult("journal_identity_changed");
  }
  if (!storageProtected || transport?.routeVerification !== "VERIFIED"
    || transport.routeCanonical !== journalAtStart.routeCanonical) {
    return unknownIsolationResult("route_not_verified");
  }

  if (connectRecoveryCurrent && !connectRecoveryCurrent()) return unknownIsolationResult("recovery_identity_changed");
  let response;
  try {
    response = await fetchCompanion("/operations/terminal-gone", {
      method: "POST",
      body: JSON.stringify({
        routeCanonical: journalAtStart.routeCanonical,
        eventId: journalAtStart.eventId,
        attemptId: journalAtStart.attemptId,
        terminalWitness: journalAtStart.terminalWitness,
      }),
    });
  } catch { return unknownIsolationResult("network_unreachable", { archiveStatus: archived.status }); }
  if (!isCurrentTransportResponse(response)
    || requestTransports.get(response)?.requestAuthRevision !== authFailureRevision) {
    return unknownIsolationResult("stale_transport_response", { archiveStatus: archived.status });
  }
  if (response.status === 401) {
    markAuthStale(response.body?.error || "COMPANION_UNAUTHORIZED", response);
    return unknownIsolationResult("COMPANION_UNAUTHORIZED", { archiveStatus: archived.status });
  }
  const proof = validateTerminalGoneResponse(response.body, journalAtStart);
  if (response.status === 409 && proof.ok && proof.status === "still_present") {
    return { ok: true, terminalGone: false, stillPresent: true, archived: true, status: "still_present" };
  }
  if (!response.ok || !proof.ok || proof.status !== "terminal_gone") {
    return unknownIsolationResult(proof.ok ? "terminal_gone_response_invalid" : proof.reason, {
      status: response.status,
      archiveStatus: archived.status,
    });
  }
  if (journal.state !== "OUTCOME_UNKNOWN" || exactJournalSnapshot(journal) !== snapshot) {
    return unknownIsolationResult("journal_identity_changed", { serverTerminalGone: true, archiveStatus: archived.status });
  }
  const marked = markOutcomeUnknownArchiveTerminalGone(outcomeUnknownArchive, journalAtStart);
  if (!marked.ok) return unknownIsolationResult(marked.reason, { serverTerminalGone: true, archiveStatus: archived.status });
  if (archived.status !== "terminal_gone") {
    try { await persistOutcomeUnknownArchive(marked.archive); }
    catch { return unknownIsolationResult("isolation_archive_persist_failed", { serverTerminalGone: true, archiveStatus: archived.status }); }
  }
  if (journal.state !== "OUTCOME_UNKNOWN" || exactJournalSnapshot(journal) !== snapshot) {
    return unknownIsolationResult("journal_identity_changed", { serverTerminalGone: true, archiveStatus: "terminal_gone" });
  }
  if (connectRecoveryCurrent && !connectRecoveryCurrent()) return unknownIsolationResult("recovery_identity_changed");
  const previous = journal;
  journal = clearJournal();
  try { await persistJournal(); }
  catch {
    journal = previous;
    return unknownIsolationResult("journal_persist_failed", { serverTerminalGone: true, archiveStatus: "terminal_gone" });
  }
  productionClaimProof = null;
  productionAckProof = null;
  return {
    ok: true,
    recovered: true,
    action: "terminal_gone_clear",
    terminalGone: true,
    isolated: false,
    observed: false,
    archived: true,
    journal: { state: "NONE" },
    zeroWrite: true,
    zeroClick: true,
    beginSendCalled: false,
    ackCalled: false,
  };
}

async function requestUnknownIsolation(journalAtStart) {
  if (!outcomeUnknownArchiveValid) return unknownIsolationResult("isolation_archive_invalid");
  if (!await unknownJournalMessageHashMatches(journalAtStart)) return unknownIsolationResult("isolation_message_hash_mismatch");
  const existing = findOutcomeUnknownArchiveEntry(outcomeUnknownArchive, journalAtStart);
  if (!existing) {
    const next = appendOutcomeUnknownArchive(outcomeUnknownArchive, journalAtStart);
    if (!next.ok) return unknownIsolationResult(next.reason);
    try { await persistOutcomeUnknownArchive(next.archive); }
    catch { return unknownIsolationResult("isolation_archive_persist_failed"); }
  }
  const archived = findOutcomeUnknownArchiveEntry(outcomeUnknownArchive, journalAtStart);
  if (archived?.status === "terminal_gone") return unknownIsolationResult("isolation_terminal_gone_conflict");
  if (journal.state !== "OUTCOME_UNKNOWN" || exactJournalSnapshot(journal) !== exactJournalSnapshot(journalAtStart)) {
    return unknownIsolationResult("journal_identity_changed");
  }
  if (!storageProtected || transport?.routeVerification !== "VERIFIED"
    || transport.routeCanonical !== journalAtStart.routeCanonical) {
    return unknownIsolationResult("route_not_verified");
  }

  if (connectRecoveryCurrent && !connectRecoveryCurrent()) return unknownIsolationResult("recovery_identity_changed");
  let response;
  try {
    response = await fetchCompanion("/isolate-attempt", {
      method: "POST",
      body: JSON.stringify({
        routeCanonical: journalAtStart.routeCanonical,
        eventId: journalAtStart.eventId,
        reservationId: journalAtStart.reservationId,
        attemptId: journalAtStart.attemptId,
        messageSha256: journalAtStart.messageSha256,
      }),
    });
  } catch {
    return unknownIsolationResult("network_unreachable", { archiveStatus: "pending" });
  }
  if (!isCurrentTransportResponse(response)
    || requestTransports.get(response)?.requestAuthRevision !== authFailureRevision) {
    return unknownIsolationResult("stale_transport_response", { archiveStatus: "pending" });
  }
  if (response.status === 401) {
    markAuthStale(response.body?.error || "COMPANION_UNAUTHORIZED", response);
    return unknownIsolationResult("COMPANION_UNAUTHORIZED", { archiveStatus: "pending" });
  }
  if (!response.ok) {
    return unknownIsolationResult(response.body?.error || `http_${response.status}`, {
      status: response.status,
      archiveStatus: "pending",
    });
  }
  try { assertNoForbiddenFields(response.body); }
  catch { return unknownIsolationResult("isolation_response_invalid", { archiveStatus: "pending" }); }
  const proof = validateIsolationResponse(response.body, journalAtStart);
  if (!proof.ok) return unknownIsolationResult(proof.reason, { archiveStatus: "pending" });
  if (journal.state !== "OUTCOME_UNKNOWN" || exactJournalSnapshot(journal) !== exactJournalSnapshot(journalAtStart)) {
    return unknownIsolationResult("journal_identity_changed", { serverIsolated: true, archiveStatus: "pending" });
  }

  const marked = markOutcomeUnknownArchiveIsolated(outcomeUnknownArchive, journalAtStart);
  if (!marked.ok) return unknownIsolationResult(marked.reason, { serverIsolated: true, archiveStatus: "pending" });
  try { await persistOutcomeUnknownArchive(marked.archive); }
  catch { return unknownIsolationResult("isolation_archive_persist_failed", { serverIsolated: true, archiveStatus: "pending" }); }

  if (connectRecoveryCurrent && !connectRecoveryCurrent()) return unknownIsolationResult("recovery_identity_changed");
  if (exactJournalSnapshot(journal) !== exactJournalSnapshot(journalAtStart)) return unknownIsolationResult("journal_identity_changed");
  const previous = journal;
  journal = clearJournal();
  try { await persistJournal(); }
  catch {
    journal = previous;
    return unknownIsolationResult("journal_persist_failed", { serverIsolated: true, archiveStatus: "isolated" });
  }
  productionClaimProof = null;
  productionAckProof = null;
  return {
    ok: true,
    recovered: true,
    action: "isolated_unknown_clear",
    isolated: true,
    observed: false,
    archived: true,
    journal: { state: "NONE" },
    zeroWrite: true,
    zeroClick: true,
    beginSendCalled: false,
    ackCalled: false,
  };
}

async function handleRecover({ observeOnly = false, isCurrent = () => true } = {}) {
  if (productionRecoveryInFlight || productionSendInFlight || (connectInFlight && !observeOnly)) {
    return unknownIsolationResult("production_recovery_busy", { retryAllowed: true });
  }
  productionRecoveryInFlight = true;
  connectRecoveryCurrent = observeOnly ? isCurrent : null;
  try { return await handleRecoverOnce({ observeOnly, isCurrent }); }
  finally { productionRecoveryInFlight = false; connectRecoveryCurrent = null; }
}

async function handleRecoverOnce({ observeOnly = false, isCurrent = () => true } = {}) {
  // Connect 只观察已跨过发送边界的记录，绝不清理或续发 pre-send 阶段。
  if (observeOnly && journal.state === "NONE") return { ok: true, recovered: false };
  if (observeOnly && !["OUTCOME_UNKNOWN", "OBSERVED_PENDING_ACK"].includes(journal.state)) {
    return unknownIsolationResult("delivery_recovery_requires_manual_action");
  }
  const beforeState = exactJournalSnapshot(journal);
  const stateRes = await handleFetchState();
  if (!stateRes.ok) return stateRes;
  if (observeOnly && (!isCurrent() || exactJournalSnapshot(journal) !== beforeState
    || !["OUTCOME_UNKNOWN", "OBSERVED_PENDING_ACK"].includes(journal.state))) {
    return unknownIsolationResult("recovery_identity_changed");
  }
  const inFlight = stateRes.status.inFlight;

  // Isolation proof takes precedence over legacy !inFlight -> /ack closeout.
  // Clearing requires both the exact durable local archive and authenticated /state evidence.
  if (journal.state === "OUTCOME_UNKNOWN") {
    const serverIsolated = findServerIsolatedAttempt(stateRes.status.isolatedAttempts, journal);
    if (serverIsolated) return clearIsolatedUnknownFromState(serverIsolated);
  }

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
    // Unknown + no inFlight must never use /ack. Legacy explicit terminal
    // witnesses get a read-only source check; only still_present proceeds to
    // exact-attempt isolation, while terminal_gone is durably archived first.
    if (journal.state === "OUTCOME_UNKNOWN" && !inFlight) {
      const archived = outcomeUnknownArchiveValid
        ? findOutcomeUnknownArchiveEntry(outcomeUnknownArchive, journal)
        : null;
      // A durable archive proves the zero-write/zero-click recovery gate already
      // passed. It permits an idempotent retry after a crash or lost response.
      // Without one, observe-only recovery below must get its late-positive chance
      // before terminal-gone or isolation can release the journal.
      if (!archived) {
        // Fall through to the exact-document, observe-only recovery below.
      } else if (journal.terminalWitness) {
        const terminal = await requestUnknownTerminalGone(journal);
        if (terminal.terminalGone === true || terminal.serverTerminalGone === true) return terminal;
        if (!terminal.ok || terminal.stillPresent !== true) return terminal;
        if (archived.status === "terminal_gone") return unknownIsolationResult("terminal_gone_archive_conflict");
        return requestUnknownIsolation(journal);
      } else if (archived.status === "pending" || archived.status === "isolated") {
        return requestUnknownIsolation(journal);
      } else {
        return unknownIsolationResult("terminal_gone_archive_conflict");
      }
    }
    // Legacy terminal-witness ACK applies only to non-unknown send-side states.
    if (journal.state !== "OUTCOME_UNKNOWN" && !inFlight && journal.terminalWitness) {
      const previous = journal;
      const snapshot = exactJournalSnapshot(previous);
      if (observeOnly && !isCurrent()) return unknownIsolationResult("recovery_identity_changed");
      let terminal;
      try {
        terminal = await fetchCompanion("/ack", { method: "POST", body: JSON.stringify({
          routeCanonical: previous.routeCanonical, eventId: previous.eventId,
          attemptId: previous.attemptId, terminalWitness: previous.terminalWitness,
        }) });
      } catch { return { ok: false, reason: "network_unreachable", zeroWrite: true, zeroClick: true }; }
      if (!isCurrentTransportResponse(terminal)) return { ok: false, reason: "stale_transport_response" };
      if (terminal.status === 401) return markAuthStale(terminal.body?.error || "COMPANION_UNAUTHORIZED", terminal);
      if (observeOnly && !isCurrent()) return unknownIsolationResult("recovery_identity_changed");
      if (exactJournalSnapshot(journal) !== snapshot) return { ok: false, reason: "journal_identity_changed", zeroWrite: true, zeroClick: true };
      if (terminal.ok && evaluateTerminalGoneCloseout({ journal, inFlight, serverTerminal: terminal.body }).ok) {
        journal = clearJournal();
        try { await persistJournal(); }
        catch { journal = previous; return { ok: false, reason: "terminal_gone_persist_failed", zeroWrite: true, zeroClick: true }; }
        productionClaimProof = null; productionAckProof = null;
        return { ok: true, recovered: true, action: "terminal_gone_clear", journal: { state: "NONE" }, zeroWrite: true, zeroClick: true };
      }
    }
    const recovery = await recoverProductionSendSide(inFlight);
    if (observeOnly && !isCurrent()) return unknownIsolationResult("recovery_identity_changed");
    if (journal.state === "OUTCOME_UNKNOWN" && recovery?.reason === "outcome_unknown") {
      const proof = {
        journal,
        probe: recovery.isolationProbe,
        owner: ownerState.owner,
        ownerExact: !!ownerState.owner && isOwner(ownerState, ownerState.owner.tabId, ownerState.owner.documentId)
          && Number.isFinite(ownerState.owner.lastSeen) && Date.now() - ownerState.owner.lastSeen <= 12_000
          && ownerState.owner.generation === recovery.isolationProbe?.generation,
        concurrentNativeProduction: productionSendInFlight,
      };
      if (canParkOutcomeUnknown({ ...proof, inFlight })) return requestUnknownIsolation(journal);
      if (!inFlight && hasSafeUnknownRecoveryProof(proof)) {
        if (journal.terminalWitness) {
          const terminal = await requestUnknownTerminalGone(journal);
          if (terminal.terminalGone === true || terminal.serverTerminalGone === true) return terminal;
          if (!terminal.ok || terminal.stillPresent !== true) return terminal;
        }
        return requestUnknownIsolation(journal);
      }
    }
    return recovery;
  }

  return { ok: true, recovered: false, journal: { state: journal.state }, inFlight };
}

async function handleClearTransport() {
  if (localRouteActive()) return { ok: false, reason: "local_route_pending" };
  if (journalBlocksTransportMutation(journal)) {
    return { ok: false, reason: "journal_active", journalState: journal.state };
  }
  transport = null;
  connectReason = null;
  await forceAutonomyOff("transport_clear", { clearRearmPreference: true });
  const persisted = await persistTransport();
  if (persisted) transportIdentityBlocked = false;
  // Durable route-attest fence is NOT cleared here. Transport clear must not
  // silently authorize the same challenge again; only re-pair with a new
  // companionId + challengeId may reset the fence.
  return {
    ok: true,
    journal: { state: journal.state },
    routeAttestFence: routeAttestFence.state,
  };
}

let operationsReadInFlight = null;
async function readOperations() {
  const local = () => ({
    autonomy: autonomyPolicy.mode,
    web: {
      observedAt: evidence?.observedAt ?? null,
      ownerAvailable: !!ownerState.owner && !!evidence && isOwner(ownerState, evidence.tabId, evidence.documentId),
      routeMatches: !!evidence && !!transport && areChatgptConversationRoutesEquivalent(evidence.canonicalRoute, transport.routeCanonical),
      composer: evidence?.composer ?? "unknown", generation: evidence?.generation ?? "unknown", safe: evidence?.safe === true,
      verified: transport?.routeVerification === "VERIFIED",
      connectionReadiness: connectionReadiness(),
    },
    journal: { state: journal.state, eventId: journal.eventId ?? null, attemptId: journal.attemptId ?? null },
    isolationArchive: outcomeUnknownArchiveValid
      ? summarizeOutcomeUnknownArchive(outcomeUnknownArchive)
      : { available: false, entries: [] },
  });
  if (!storageProtected || !transport?.credential) return { ok: false, reason: "transport_unavailable", ...local() };
  try {
    const response = await fetchCompanion("/operations", { method: "GET", cache: "no-store" });
    if (!isCurrentTransportResponse(response) || requestTransports.get(response)?.requestAuthRevision !== authFailureRevision) {
      return { ok: false, reason: "stale_transport_response", ...local() };
    }
    if (!response.ok) return { ok: false, reason: response.body?.error ?? "bridge_unavailable", ...local() };
    assertNoForbiddenFields(response.body);
    const identity = validateStateIdentity(transport, response.body);
    if (!identity.ok) return { ok: false, reason: identity.reason, ...local() };
    if (response.body?.schemaVersion !== 1 || response.body?.readOnly !== true || !Array.isArray(response.body.commands)) {
      return { ok: false, reason: "operations_protocol_mismatch", ...local() };
    }
    return { ok: true, snapshot: response.body, ...local() };
  } catch { return { ok: false, reason: "bridge_unavailable", ...local() }; }
}

async function readOperationResult(message) {
  if (!storageProtected || !transport?.credential) return { ok: false, reason: "transport_unavailable" };
  if (transport.routeVerification !== "VERIFIED") return { ok: false, reason: "route_not_verified" };
  if (typeof message.commandId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(message.commandId)
    || !Number.isSafeInteger(message.iteration) || message.iteration < 1) {
    return { ok: false, reason: "bad_message" };
  }
  const expected = { commandId: message.commandId, iteration: message.iteration };
  const path = `/operations/result?commandId=${encodeURIComponent(message.commandId)}&iteration=${message.iteration}`;
  let response;
  try { response = await fetchCompanion(path, { method: "GET", cache: "no-store" }); }
  catch { return { ok: false, reason: "bridge_unavailable" }; }
  if (!isCurrentTransportResponse(response)
    || requestTransports.get(response)?.requestAuthRevision !== authFailureRevision) {
    return { ok: false, reason: "stale_transport_response" };
  }
  if (response.status === 401) return markAuthStale(response.body?.error || "COMPANION_UNAUTHORIZED", response);
  if (!response.ok) {
    const reason = response.status === 404 && response.body?.error === "COMPANION_RESULT_NOT_FOUND"
      ? "COMPANION_RESULT_NOT_FOUND"
      : response.status === 409 && response.body?.error === "COMPANION_RESULT_HISTORICAL_REFUSED"
        ? "COMPANION_RESULT_HISTORICAL_REFUSED"
        : response.body?.error || `http_${response.status}`;
    return { ok: false, reason };
  }
  try { assertNoForbiddenFields(response.body); }
  catch { return { ok: false, reason: "result_response_invalid" }; }
  const body = response.body;
  const keys = ["commandId", "iteration", "resultId", "resultSha256", "status", "deliveryStatus", "rawSummary", "testsSummary"];
  const lifecycle = ["queued", "reserved", "claimed", "observed", "outcome_unknown", "retired_unknown", "cancelled"];
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).length !== keys.length || keys.some(key => !Object.hasOwn(body, key))
    || body.commandId !== expected.commandId || body.iteration !== expected.iteration
    || typeof body.resultId !== "string" || !UUID.test(body.resultId)
    || typeof body.resultSha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.resultSha256)
    || !["ok", "failed", "blocked"].includes(body.status) || !lifecycle.includes(body.deliveryStatus)
    || typeof body.rawSummary !== "string" || body.rawSummary.length === 0
    || new TextEncoder().encode(body.rawSummary).byteLength > 8192
    || typeof body.testsSummary !== "string" || body.testsSummary.length === 0 || body.testsSummary.length > 16_384) {
    return { ok: false, reason: "result_response_invalid" };
  }
  return { ok: true, result: body };
}

const PANEL_ACTION_KEY = "c2c.panel.action.v1";
async function panelAction(message) {
  if (!storageProtected || !transport?.credential) return { ok: false, reason: "transport_unavailable" };
  const workspaceId = transport.workspaceId;
  if (!/^[a-f0-9]{12}$/.test(workspaceId ?? "")) return { ok: false, reason: "transport_unavailable" };
  if (!["preview", "confirm", "check", "reconcile"].includes(message.phase)) return { ok: false, reason: "bad_message" };
  const stored = (await chrome.storage.local.get(PANEL_ACTION_KEY))[PANEL_ACTION_KEY];
  if (stored && (stored.version !== 1 || !Array.isArray(stored.operations) || stored.operations.length > 100
    || stored.operations.some(item => !/^[a-f0-9]{12}$/.test(item?.workspaceId ?? "") || !["pending", "completed", "rejected"].includes(item?.status)
      || !/^[a-f0-9-]{36}$/.test(item?.request?.requestId ?? "") || !/^[A-Za-z0-9_-]{1,128}$/.test(item?.request?.commandId ?? ""))))
    return { ok: false, reason: "panel_journal_corrupt" };
  let operations = stored?.operations ?? [];
  const save = async entry => {
    const remaining = operations.filter(item => item.workspaceId !== workspaceId || item.request.requestId !== entry.request.requestId);
    const next = [...remaining.filter(item => item.status === "pending"), ...remaining.filter(item => item.status !== "pending").slice(-20), { ...entry, workspaceId }];
    if (next.length > 100) throw new Error("panel_journal_full");
    await chrome.storage.local.set({ [PANEL_ACTION_KEY]: { version: 1, operations: next } });
    operations = next;
  };
  if (transport?.workspaceId !== workspaceId) return { ok: false, reason: "stale_transport_response" };
  const scoped = operations.filter(item => item.workspaceId === workspaceId);
  const saved = message.phase === "check" ? scoped.filter(item => !message.commandId || item.request.commandId === message.commandId).at(-1)
    : scoped.find(item => item.status === "pending" && item.request.commandId === message.request?.commandId);
  if (message.phase === "check") {
    if (!saved?.request?.requestId) return { ok: true, status: "none" };
    const response = await fetchCompanion(`/operations/result?requestId=${encodeURIComponent(saved.request.requestId)}`, { method: "GET", cache: "no-store" });
    if (!isCurrentTransportResponse(response) || requestTransports.get(response)?.requestAuthRevision !== authFailureRevision || !response.ok) return { ok: false, reason: "operation_status_unavailable" };
    if (response.body?.requestId !== saved.request.requestId) return { ok: false, reason: "operation_status_mismatch" };
    if (response.body.status === "completed") await save({ ...saved, status: "completed" });
    return { ok: true, ...response.body };
  }
  if (message.phase === "reconcile") {
    if (!/^[a-f0-9-]{36}$/.test(message.requestId ?? "")) return { ok: false, reason: "bad_message" };
    const response = await fetchCompanion("/operations/reconcile", { method: "POST", body: JSON.stringify({ requestId: message.requestId }) });
    if (!isCurrentTransportResponse(response) || requestTransports.get(response)?.requestAuthRevision !== authFailureRevision || !response.ok || response.body?.requestId !== message.requestId)
      return { ok: false, reason: response.body?.error ?? "operation_status_unavailable" };
    const prior = scoped.find(item => item.request.requestId === message.requestId);
    if (response.body.status === "completed" && prior) await save({ ...prior, status: "completed" });
    return { ok: true, ...response.body };
  }
  if (saved?.status === "pending") return { ok: false, reason: "panel_operation_unknown", requestId: saved.request.requestId };
  if (autonomyPolicy.mode === "armed" || productionSendInFlight || autonomyTickInFlight || connectInFlight) return { ok: false, reason: "pause_autonomy_before_manual_action" };
  const request = message.request;
  if (!request || Object.keys(request).some(key => !["requestId", "commandId", "action", "eventId"].includes(key))
    || !/^[a-f0-9-]{36}$/.test(request.requestId ?? "") || !/^[A-Za-z0-9_-]{1,128}$/.test(request.commandId ?? "")) return { ok: false, reason: "bad_message" };
  const reservationOnly = request.action === "requeue_return" && journal.state === "RESERVED" && journal.eventId === request.eventId;
  if (journal.state !== "NONE" && !reservationOnly) return { ok: false, reason: "delivery_journal_requires_recovery" };
  const beforeJournal = journal;
  if (message.phase === "confirm") {
    if (message.confirmed !== true || !/^[a-f0-9]{64}$/.test(message.confirmationSha256 ?? "")) return { ok: false, reason: "explicit_confirmation_required" };
    await save({ status: "pending", request, confirmationSha256: message.confirmationSha256 });
  }
  productionSendInFlight = true;
  try {
    const response = await fetchCompanion(`/operations/${message.phase}`, { method: "POST", body: JSON.stringify({ request,
      ...(message.phase === "confirm" ? { confirmationSha256: message.confirmationSha256 } : {}) }) });
    if (!isCurrentTransportResponse(response) || requestTransports.get(response)?.requestAuthRevision !== authFailureRevision)
      return { ok: false, reason: "stale_transport_response" };
    if (!response.ok) {
      if (message.phase === "confirm" && response.body?.noMutation === true && response.body.requestId === request.requestId)
        await save({ status: "rejected", request });
      return { ok: false, reason: response.body?.error ?? "panel_action_failed" };
    }
    assertNoForbiddenFields(response.body);
    if (message.phase === "preview" && (!response.body?.request || ["requestId", "commandId", "action", "eventId"].some(key => response.body.request[key] !== request[key])
      || !/^[a-f0-9]{64}$/.test(response.body.confirmationSha256 ?? "") || typeof response.body.notice !== "string" || response.body.notice.length > 2048))
      return { ok: false, reason: "panel_preview_identity_mismatch" };
    if (message.phase === "confirm" && response.body?.requestId === request.requestId && response.body.status === "completed") {
      await save({ status: "completed", request });
      if (reservationOnly && journal === beforeJournal && journal.state === "RESERVED") {
        journal = clearJournal();
        try { await persistJournal(); } catch (error) { journal = beforeJournal; throw error; }
      }
    }
    return { ok: true, ...response.body };
  } catch { return { ok: false, reason: message.phase === "confirm" ? "panel_operation_unknown" : "network_unreachable" }; }
  finally { productionSendInFlight = false; }
}

async function handleMessage(message, sender, { transportMutationHeld = false, managedAttestRollback = false } = {}) {
  await initPromise;
  if (!message || typeof message !== "object") return { ok: false, reason: "bad_message" };

  if (message.type === "c2c.operations.action") {
    const ownPanel = isOwnOperationsPanel(sender);
    if (!ownPanel || sender?.tab?.url?.startsWith("https://")) return { ok: false, reason: "extension_panel_required" };
    if (Object.keys(message).some(key => !["type", "phase", "request", "requestId", "commandId", "confirmationSha256", "confirmed"].includes(key))) return { ok: false, reason: "bad_message" };
    return runTransportMutation(() => panelAction(message));
  }

  if (message.type === "c2c.operations.read") {
    const ownPanel = isOwnOperationsPanel(sender);
    if (!isExtensionInternalSender(sender) && !ownPanel) return { ok: false, reason: "extension_sender_required" };
    if (Object.keys(message).length !== 1) return { ok: false, reason: "bad_message" };
    if (!operationsReadInFlight) operationsReadInFlight = readOperations().finally(() => { operationsReadInFlight = null; });
    return operationsReadInFlight;
  }

  if (message.type === "c2c.operations.result.read") {
    const ownPanel = isOwnOperationsPanel(sender);
    if (!ownPanel || sender?.tab?.url?.startsWith("https://")) return { ok: false, reason: "extension_panel_required" };
    if (Object.keys(message).some(key => !["type", "commandId", "iteration"].includes(key))) return { ok: false, reason: "bad_message" };
    return readOperationResult(message);
  }

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
    await syncActiveWebSinkFromBridge().catch(() => undefined);
    return {
      ok: true,
      storageProtected,
      transport: safeTransportSummary(),
      journal: summarizeProductionJournal(journal),
      deliveryRecovery: deliveryRecoverySummary(),
    localRoute: localRouteSummary(),
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
    // R3q: a PROVEN composer write that never reached the irreversible click
    // boundary is recoverable — never upgrade it to OUTCOME_UNKNOWN. "Proven"
    // requires response.ok === false (an ok=true response that claims wrote=true
    // without observed is inconsistent, not safe) plus positive
    // mutationAttempted === true AND wrote === true; missing/malformed booleans
    // fall through to the OUTCOME_UNKNOWN fail-closed below, and a real
    // clickAttempted=true can never land here. Clears latch+fence to NONE; the
    // managed connectFlow is cleared by the dispatch caller; nothing is
    // auto-resent — the user clears the dirty composer and Connects again.
    const routeAttestWrittenUnsent = response.ok === false
      && response.mutationAttempted === true
      && response.wrote === true
      && response.clickAttempted !== true
      && response.observed !== true;
    if (routeAttestWrittenUnsent) {
      if (managedAttestRollback === true) {
        // R3q review-fix (FIX_2): the managed rollback must commit the durable
        // route-attest fence and the managed connectFlow ATOMICALLY (one
        // chrome.storage.local.set). The dispatch caller owns that combined
        // commit, so no durable write happens here — memory is rolled back
        // provisionally and the caller hardens everything together on failure.
        // (transportMutationHeld alone cannot distinguish this caller: the
        // direct wrapper recurses with it set to true as well.)
        routeAttestLatch = emptyRouteAttestLatch();
        routeAttestFence = emptyRouteAttestFence();
        return {
          ok: false,
          reason: classified.reason,
          writtenUnsent: true,
          latchState: "NONE",
          fenceState: "NONE",
          retryAllowed: true,
          composerDirty: true,
          mutationAttempted: true,
          clickAttempted: false,
        };
      }
      routeAttestLatch = emptyRouteAttestLatch();
      routeAttestFence = emptyRouteAttestFence();
      if (!await persistRouteAttestBoth()) {
        // Fail closed: durable clear failed — harden both stores instead.
        routeAttestLatch = { ...intentLatch, state: "OUTCOME_UNKNOWN" };
        routeAttestFence = markRouteAttestFenceState(intentFence, "OUTCOME_UNKNOWN");
        await persistRouteAttestBoth();
        return {
          ok: false,
          reason: "route_attest_written_unsent_persist_failed",
          latchState: "OUTCOME_UNKNOWN",
          fenceState: "OUTCOME_UNKNOWN",
          retryAllowed: false,
          mutationAttempted: true,
          clickAttempted: false,
        };
      }
      return {
        ok: false,
        reason: classified.reason,
        writtenUnsent: true,
        latchState: "NONE",
        fenceState: "NONE",
        retryAllowed: true,
        composerDirty: true,
        mutationAttempted: true,
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
    return handleReservePage(sender, {
      generation: Number.isFinite(message.generation) ? Number(message.generation) : 1,
      safety: message?.safety, canonicalRoute: message?.canonicalRoute ?? null,
    });
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
  if (message.type === "c2c.connect.abandon.unknown") {
    // Manual popup-only advanced recovery. Content scripts must never trigger it.
    if (!isExtensionInternalSender(sender)) {
      return { ok: false, reason: "popup_sender_required" };
    }
    // R3p review-fix: Abandon mutates durable connectFlow, so it must share the
    // same transport mutation gate as pair/rebind/attest/connect.page/transport.clear
    // — it can never interleave with an in-flight Connect/Rebind/Attest transition.
    return runTransportMutation(() =>
      handleAbandonConnectUnknown(sender, message)
    );
  }
  if (message.type === "c2c.route-attest.abandon.unknown") {
    // Manual popup-only advanced recovery (R3q). Content scripts must never
    // trigger it, and it must share the transport mutation gate like every
    // other durable-state mutation.
    if (!isExtensionInternalSender(sender)) {
      return { ok: false, reason: "popup_sender_required" };
    }
    return runTransportMutation(() =>
      handleAbandonRouteAttestUnknown(sender, message)
    );
  }
  if (message.type === "c2c.connect.page") {
    return runTransportMutation(async () => {
      const result = await handleConnectPage(sender, message);
      if (!result?.ok) activeWebSinkProjection = { binding: null, available: false, synced: false };
      connectReason = !result?.ok && typeof result?.reason === "string"
        && /^[a-zA-Z][a-zA-Z0-9_]{0,95}$/.test(result.reason) ? result.reason : null;
      return result;
    });
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

  if (message.type === "c2c.status.read") {
    if (!identity.ok) return { ok: false, reason: identity.reason };
    const exact = canonical != null && isOwner(ownerState, tabId, documentId)
      && areChatgptConversationRoutesEquivalent(canonical, ownerState.owner?.canonicalRoute);
    return statusPayload(tabId, exact ? documentId : null, { isOwner: exact, canonicalRoute: canonical });
  }

  if (
    message.type === "c2c.status.page"
    || message.type === "c2c.observe"
    || message.type === "c2c.heartbeat"
  ) {
    if (!identity.ok && identity.reason !== "document_id_unavailable") {
      return { ok: false, reason: identity.reason };
    }
    if (message.type === "c2c.status.page") {
      await syncActiveWebSinkFromBridge().catch(() => undefined);
    }
    const previousOwner = ownerState.owner;
    const reloadCandidate = message.type === "c2c.heartbeat" && !localRouteActive()
      && journal.state === "NONE" && connectFlow.state === "DONE" && verifiedConnectFlowMatchesTransport(connectFlow, transport)
      && ["NONE", "VERIFIED"].includes(routeAttestFence.state)
      && previousOwner?.tabId === tabId
      && (previousOwner.documentId !== documentId || connectFlow.ownerWitness?.generation !== generation)
      && connectFlow.ownerWitness?.tabId === tabId && connectFlow.ownerWitness.documentId === previousOwner.documentId
      && areChatgptConversationRoutesEquivalent(connectFlow.ownerWitness.canonicalRoute, transport?.routeCanonical)
      && canonical != null && areChatgptConversationRoutesEquivalent(canonical, transport?.routeCanonical);
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
    if (reloadCandidate && (!ownerState.owner || isOwner(ownerState, tabId, documentId)) && !productionSendInFlight && !productionRecoveryInFlight && !autonomyTickInFlight) {
      await runTransportMutation(async () => {
        connectInFlight = true;
        try { await restoreSameTabOwnerReadOnly(sender, message, previousOwner); }
        finally { connectInFlight = false; }
      });
      return statusPayload(tabId ?? -1, documentId, { canonicalRoute: canonical });
    }
    if (message.type === "c2c.heartbeat" && localRouteActive()) {
      if (localRouteCurrent(localRouteRequest) && canonical === localRouteRequest.routeCanonical
        && tabId === localRouteRequest.ownerWitness.tabId && documentId === localRouteRequest.ownerWitness.documentId
        && generation === localRouteRequest.ownerWitness.generation && Date.now() - lastLocalRoutePollAt >= 2_000
        && !productionSendInFlight && !productionRecoveryInFlight && !autonomyTickInFlight) {
        lastLocalRoutePollAt = Date.now();
        const result = await runTransportMutation(async () => {
          connectInFlight = true;
          try { return await progressLocalRouteRequest(); }
          finally { connectInFlight = false; }
        });
        connectReason = result?.ok ? null : result?.reason || "local_route_unavailable";
      }
      return statusPayload(tabId ?? -1, documentId, { canonicalRoute: canonical });
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
                  const currentFlowIdentity = connectFlowIdentity(transport);
                  const witness = connectFlow.ownerWitness;
                  const witnessOk = ownerExact === true
                    && currentFlowIdentity
                    && connectFlowMatches(connectFlow, currentFlowIdentity)
                    && witness
                    && connectFlowOwnerWitnessMatches(connectFlow, ownerState.owner);
                  if (witnessOk) {
                    const sink = await convergeExplicitVerifiedConnect({
                      tabId: witness.tabId,
                      documentId: witness.documentId,
                      generation: witness.generation,
                      canonicalRoute: witness.canonicalRoute,
                    });
                    if (sink.ok) {
                      const doneFlow = finishConnectFlow(connectFlow, flowIdentity, "DONE");
                      const prevFlow = connectFlow;
                      connectFlow = doneFlow;
                      if (await persistConnectFlow()) {
                        const autonomy = await rearmAutonomyAfterVerifiedConnect();
                        if (!autonomy.ok) lastAutonomyReason = autonomy.reason;
                      } else {
                        connectFlow = prevFlow;
                        await persistConnectFlow().catch(() => false);
                        lastAutonomyReason = "connect_done_persist_failed";
                      }
                    } else {
                      lastAutonomyReason = sink.reason || "web_sink_bind_failed";
                    }
                  } else {
                    lastAutonomyReason = "owner_witness_required";
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
    if (connectInFlight) return { ok: false, reason: "connect_in_flight" };
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
  if (connectInFlight && (!connectRecoveryCurrent || !connectRecoveryCurrent()
    || !["OUTCOME_UNKNOWN", "OBSERVED_PENDING_ACK"].includes(journal.state)
    || !["OUTCOME_UNKNOWN", "OBSERVED_PENDING_ACK", "NONE"].includes(proposed.state))) {
    return { ok: false, reason: "production_recovery_busy" };
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
  if (connectInFlight) return { ok: false, reason: "production_recovery_busy" };
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
  if (!isCurrentTransportResponse(res)) return { ok: false, reason: "stale_transport_response" };
  if (res.status === 401) {
    return markAuthStale(res.body?.error || "COMPANION_UNAUTHORIZED", res);
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
    ...(body.terminalWitness === undefined ? {} : { terminalWitness: body.terminalWitness }),
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
    ...(body.terminalWitness === undefined ? {} : { terminalWitness: body.terminalWitness }),
  };
}

/**
 * E1b3d3b /ack adapter. Only from OBSERVED_PENDING_ACK.
 * Success must prove eventId + status=observed before CS may clear.
 */
async function handleProductionAck(sender, message) {
  await initPromise;
  if (connectInFlight && (!connectRecoveryCurrent || !connectRecoveryCurrent())) return { ok: false, reason: "recovery_identity_changed" };
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
        ...(journal.terminalWitness ? { terminalWitness: journal.terminalWitness } : {}),
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
  if (!isCurrentTransportResponse(res)) return { ok: false, reason: "stale_transport_response" };
  if (connectRecoveryCurrent && !connectRecoveryCurrent()) return { ok: false, reason: "recovery_identity_changed" };
  if (res.status === 401) {
    return markAuthStale(res.body?.error || "COMPANION_UNAUTHORIZED", res);
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
  if (body.eventId !== journal.eventId || (body.status !== "observed" && !(body.status === "terminal_gone" && journal.terminalWitness && body.attemptId === journal.attemptId))) {
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
    ...(body.status === "terminal_gone" ? { terminalWitness: journal.terminalWitness } : {}),
  });
  if (!productionAckProof) {
    return {
      ok: false,
      reason: "ack_proof_mint_failed",
      retryAck: true,
      journal: summarizeProductionJournal(journal),
    };
  }
  return { ok: true, eventId: body.eventId, status: body.status, ...(body.status === "terminal_gone" ? { attemptId: body.attemptId } : {}) };
}

/**
 * E1b3d3b2 autonomous tick. Exact-owner heartbeat only. Default OFF.
 * Journal-first recovery. One event max per tick. Never auto-retire.
 */
async function maybeRunAutonomyTick(ctx = {}) {
  if (autonomyTickInFlight || connectInFlight || productionRecoveryInFlight) return;
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
      // SW 重建或投影失败时复用只读同步；正常 tick 不增加请求，失败每 2 秒可重查。
      if (connectionReadiness().reason === "web_sink_not_ready"
        && Date.now() - (activeWebSinkProjection.checkedAt ?? 0) >= 2_000) {
        await syncActiveWebSinkFromBridge();
      }
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
      connectionReadiness: connectionReadiness(),
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
  if (productionSendInFlight || productionRecoveryInFlight || connectInFlight) {
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

  // 新的 authenticated 禁发事实只允许保留 attempt 后观察/ACK，不能续发旧 journal。
  if (isRecoverySendDisabled(safeInFlight)) {
    productionClaimProof = null;
    productionAckProof = null;
    if (["SEND_INTENT", "CLAIMED"].includes(journal.state)) {
      const claimed = journal.state === "CLAIMED" ? reconcileClaimedAgainstServer(journal, safeInFlight) : null;
      if (safeInFlight.eventId !== journal.eventId || safeInFlight.reservationId !== journal.reservationId ||
          (claimed && claimed.action !== "adopt_outcome_unknown") ||
          !["claimed", "outcome_unknown"].includes(safeInFlight.status) || !safeInFlight.attemptId) {
        return { ok: false, reason: "recovery_send_disabled", action: "block",
          journal: summarizeProductionJournal(journal), zeroWrite: true, zeroClick: true };
      }
      const previous = journal;
      try {
        journal = markOutcomeUnknown(journal, {
          attemptId: safeInFlight.attemptId, message: safeInFlight.message, messageSha256: safeInFlight.messageSha256,
          ...(safeInFlight.terminalWitness === undefined ? {} : { terminalWitness: safeInFlight.terminalWitness }),
        });
        await persistJournal();
      } catch {
        journal = previous;
        return { ok: false, reason: "outcome_unknown_persist_failed", action: "block",
          journal: summarizeProductionJournal(journal), zeroWrite: true, zeroClick: true };
      }
    }
  }

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
      ...(safeInFlight.terminalWitness === undefined ? {} : { terminalWitness: safeInFlight.terminalWitness }),
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
      ...(journal.state === "OUTCOME_UNKNOWN" ? {
        isolationProbe: {
          reason: response.reason,
          journalState: response.journalState,
          zeroWrite: response.zeroWrite === true,
          zeroClick: response.zeroClick === true,
          ownerFresh: response.ownerFresh === true,
          routeCanonical: response.canonicalRoute,
          generation: response.generation,
          composerEmpty: response.composerEmpty === true,
          generationIdle: response.generationIdle === true,
          nativeProductionInFlight: response.nativeProductionInFlight,
        },
      } : {}),
    };
  } finally {
    productionSendInFlight = false;
    void refreshActionIndicator();
  }
}

/**
 * R3p manual advanced recovery for a proven OUTCOME_UNKNOWN connect fence.
 * Popup-only, explicit-confirm in the popup UI. Clears ONLY the connect
 * bootstrap fence: zero composer write, zero click, zero bridge mutation —
 * feedback journal, transport, binding and route-attest fence are untouched.
 * It never marks connect successful and never retries anything.
 * Identity (tab/document/route) always comes from durable SW state; the popup
 * never supplies it. R3p review-fix: an internal popup sender alone proves
 * nothing about WHICH page the user is on, so the popup must first relay a
 * fresh one-use c2c.owner-proof.request through the CURRENT owner document
 * (same mint/consume pattern as pair/rebind) and pass the resulting
 * ownerProofId. The proof is consumed against the exact durable owner, so a
 * popup opened from any other Chat can never clear this fence.
 */
async function handleAbandonConnectUnknown(sender, message) {
  if (!isExtensionInternalSender(sender)) {
    return { ok: false, reason: "popup_sender_required" };
  }
  await initPromise;
  const abandoned = connectFlow;
  if (abandoned.state !== "OUTCOME_UNKNOWN") {
    return { ok: false, reason: "connect_not_outcome_unknown", state: abandoned.state };
  }
  const owner = ownerState.owner;
  if (!owner || !isOwner(ownerState, owner.tabId, owner.documentId)) {
    return { ok: false, reason: "not_exact_owner", state: abandoned.state };
  }
  if (!areChatgptConversationRoutesEquivalent(abandoned.routeCanonical, owner.canonicalRoute)) {
    return { ok: false, reason: "connect_identity_mismatch", state: abandoned.state };
  }
  // One-use proof must have been minted from the real MessageSender of this
  // exact owner document (fresh + unused + matching tab/document/route).
  const proofCheck = consumeOwnerProof(ownerProof, {
    tabId: owner.tabId,
    documentId: owner.documentId,
    routeCanonical: owner.canonicalRoute,
  });
  if (!proofCheck.ok) {
    return { ok: false, reason: proofCheck.reason, state: abandoned.state };
  }
  if (message?.ownerProofId !== ownerProof.id) {
    return { ok: false, reason: "owner_proof_mismatch", state: abandoned.state };
  }
  ownerProof = markProofUsed(ownerProof);
  connectFlow = emptyConnectFlow();
  if (!await persistConnectFlow()) {
    // Never leave memory/durable disagreeing: restore the unknown fence.
    connectFlow = abandoned;
    await persistConnectFlow().catch(() => false);
    return { ok: false, reason: "connect_fence_persist_failed", state: abandoned.state };
  }
  return {
    ok: true,
    abandoned: true,
    // Explicitly NOT a connect success: the fence was cleared for manual recovery.
    connectOutcome: "abandoned",
    state: "NONE",
    zeroWrite: true,
    zeroClick: true,
    zeroBridgeMutation: true,
  };
}

/**
 * R3q: manual-only recovery for a hardened route-attest OUTCOME_UNKNOWN
 * (attestation written but never clicked, or ambiguous). Zero DOM mutation.
 * Requires: popup-only sender, exact current owner (via one-use owner proof),
 * an in-flight rebind transport, and route/challenge/companion identity that
 * exactly matches the durable OUTCOME_UNKNOWN fence. Success clears ONLY the
 * route-attest latch + fence and the managed connectFlow; the epoch transport,
 * rebind intent/challenge, credential, binding and journal are byte-identical.
 * This is NOT attestation success and never calls route confirm.
 */
async function handleAbandonRouteAttestUnknown(sender, message) {
  await initPromise;
  const transportGate = requireProtectedTransport();
  if (!transportGate.ok) return { ...transportGate, fenceState: routeAttestFence.state };
  if (transport?.rebindPending !== true) {
    return { ok: false, reason: "route_attest_not_rebind_pending", fenceState: routeAttestFence.state };
  }
  const fence = routeAttestFence;
  if (fence.state !== "OUTCOME_UNKNOWN") {
    return { ok: false, reason: "route_attest_not_outcome_unknown", fenceState: fence.state, latchState: routeAttestLatch.state };
  }
  const owner = ownerState.owner;
  if (!owner || !isOwner(ownerState, owner.tabId, owner.documentId)) {
    return { ok: false, reason: "not_exact_owner", fenceState: fence.state };
  }
  if (!fence.routeCanonical
    || !areChatgptConversationRoutesEquivalent(fence.routeCanonical, owner.canonicalRoute)) {
    return { ok: false, reason: "route_attest_identity_mismatch", fenceState: fence.state };
  }
  if ((transport.companionId ?? null) !== (fence.companionId ?? null)) {
    return { ok: false, reason: "route_attest_identity_mismatch", fenceState: fence.state };
  }
  if (!fence.challengeId
    || fence.challengeId !== extractRouteChallengeId(transport?.routeAttestationMessage)) {
    return { ok: false, reason: "route_attest_identity_mismatch", fenceState: fence.state };
  }
  // R3q review-fix (FIX_1): a non-NONE managed connectFlow must be THIS
  // transport's hardened attestation flow (OUTCOME_UNKNOWN + exact identity).
  // Abandon never clears a foreign or still-live flow, and rejects BEFORE
  // consuming the one-use proof — zero mutation on mismatch.
  const prevConnectFlow = connectFlow;
  if (prevConnectFlow.state !== "NONE") {
    const flowIdentity = connectFlowIdentity(transport);
    if (prevConnectFlow.state !== "OUTCOME_UNKNOWN"
      || !flowIdentity
      || !connectFlowMatches(prevConnectFlow, flowIdentity)) {
      return {
        ok: false,
        reason: "connect_identity_mismatch",
        fenceState: fence.state,
        latchState: routeAttestLatch.state,
      };
    }
  }
  // One-use proof must have been minted from the real MessageSender of this
  // exact owner document (fresh + unused + matching tab/document/route).
  const proofCheck = consumeOwnerProof(ownerProof, {
    tabId: owner.tabId,
    documentId: owner.documentId,
    routeCanonical: owner.canonicalRoute,
  });
  if (!proofCheck.ok) {
    return { ok: false, reason: proofCheck.reason, fenceState: fence.state };
  }
  if (message?.ownerProofId !== ownerProof.id) {
    return { ok: false, reason: "owner_proof_mismatch", fenceState: fence.state };
  }
  ownerProof = markProofUsed(ownerProof);
  const prevLatch = routeAttestLatch;
  const prevFence = routeAttestFence;
  routeAttestLatch = emptyRouteAttestLatch();
  routeAttestFence = emptyRouteAttestFence();
  if (!await persistRouteAttestBoth()) {
    routeAttestLatch = prevLatch;
    routeAttestFence = prevFence;
    await persistRouteAttestBoth();
    return { ok: false, reason: "route_attest_fence_persist_failed", fenceState: routeAttestFence.state };
  }
  if (prevConnectFlow.state !== "NONE") {
    connectFlow = emptyConnectFlow();
    if (!await persistConnectFlow()) {
      // Restore the hardened attest fence and the managed flow together.
      routeAttestLatch = prevLatch;
      routeAttestFence = prevFence;
      await persistRouteAttestBoth();
      connectFlow = prevConnectFlow;
      await persistConnectFlow().catch(() => false);
      return { ok: false, reason: "connect_fence_persist_failed", fenceState: prevFence.state };
    }
  }
  return {
    ok: true,
    abandoned: true,
    // Explicitly NOT attestation success; no route confirm is called.
    connectOutcome: "abandoned",
    state: "NONE",
    zeroWrite: true,
    zeroClick: true,
    zeroBridgeMutation: true,
  };
}

/**
 * Manual-only outcome_unknown retirement. Zero DOM mutation.
 * Identity always from durable local journal; popup/CS never supply replaceable identity.
 * Local clear only after exact server retirement success.
 */
async function handleRetireUnknown() {
  if (connectInFlight || productionRecoveryInFlight || productionSendInFlight) {
    return { ok: false, reason: "production_recovery_busy" };
  }
  productionRecoveryInFlight = true;
  try { return await handleRetireUnknownOnce(); }
  finally { productionRecoveryInFlight = false; }
}

async function handleRetireUnknownOnce() {
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
  if (!isCurrentTransportResponse(res)) return { ok: false, reason: "stale_transport_response" };
  if (res.status === 401) {
    return markAuthStale(res.body?.error || "COMPANION_UNAUTHORIZED", res);
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

async function handleTabRemoved(tabId) {
  await initPromise;
  ownerState = invalidateOnTabRemoved(ownerState, tabId);
  if (evidence?.tabId === tabId) evidence = null;
  if (ownerProof?.tabId === tabId) ownerProof = null;
  await persistSessionOwnership();
  await syncWakeWatchdog();
  await refreshActionIndicator();
}

async function handleInstalled() {
  await initPromise;
  const stored = await chrome.storage.local.get(LOCAL_KEY);
  if (!stored[LOCAL_KEY]) {
    localState = { schemaVersion: 1, targetRoute: null, paired: false };
    await persistLocal();
  }
  await syncWakeWatchdog();
  await refreshActionIndicator();
}

async function handleStartup() {
  await initPromise;
  ownerState = resetSessionOwnership(emptyOwnerState());
  ownerState.targetRoute = localState.targetRoute;
  evidence = null;
  ownerProof = null;
  await persistSessionOwnership();
  await syncWakeWatchdog();
  await refreshActionIndicator();
}

async function summary() {
  await initPromise;
  return {
    workspaceId: project.workspaceId,
    bridgeOrigin: project.bridgeOrigin,
    paired: localState.paired === true,
    connected: safeTransportSummary()?.connected === true,
    routeCanonical: transport?.routeCanonical ?? null,
    routeVerification: transport?.routeVerification === "VERIFIED" ? "VERIFIED" : "PENDING",
    authStale: transport?.authStale === true,
    journal: summarizeProductionJournal(journal).state,
    routeAttestFence: routeAttestFence.state,
  };
}

async function matchesOwner(sender, message) {
  await initPromise;
  const identity = resolveSenderDocumentIdentity(sender);
  if (!identity.ok || !isOwner(ownerState, identity.tabId, identity.documentId)) return false;
  const route = ownerState.owner?.canonicalRoute;
  if (!areChatgptConversationRoutesEquivalent(route, sender?.url)) return false;
  return typeof message?.canonicalRoute !== "string"
    || areChatgptConversationRoutesEquivalent(route, message.canonicalRoute);
}

async function matchesDocument(sender) {
  await initPromise;
  const identity = resolveSenderDocumentIdentity(sender);
  return identity.ok && isOwner(ownerState, identity.tabId, identity.documentId);
}

async function ownsTabRoute(tabId, route) {
  await initPromise;
  return (ownerState.owner?.tabId === tabId
      && areChatgptConversationRoutesEquivalent(ownerState.owner?.canonicalRoute, route))
    || (ownerState.targetRoute != null
      && areChatgptConversationRoutesEquivalent(ownerState.targetRoute, route)
      && ownerState.owner?.tabId === tabId);
}

async function ownerTabId() {
  await initPromise;
  return ownerState.owner?.tabId ?? null;
}

async function afterMessage(type) {
  if (type !== "c2c.operations.read" && type !== "c2c.status.read") {
    await Promise.all([refreshActionIndicator(), syncWakeWatchdog()]);
  }
}

return {
  initialize: () => initPromise,
  refreshSelectedIndicator: async () => {
    await initPromise;
    applyActionIndicator.invalidate();
    await refreshActionIndicator();
  },
  handleAlarm: alarm => handleWakeWatchdogAlarm(alarm),
  handleTabRemoved,
  handleActiveOwnerRefresh: tabId => requestActiveOwnerRefresh(tabId),
  handleInstalled,
  handleStartup,
  handleMessage,
  summary,
  matchesOwner,
  matchesDocument,
  ownsTabRoute,
  ownerTabId,
  afterMessage,
};
}

function exactOperationsPanelWorkspaceId(sender, browser) {
  if (sender?.id !== browser?.runtime?.id || !Number.isSafeInteger(sender?.tab?.id)) return null;
  let expected;
  try { expected = new URL(browser.runtime.getURL("operations/operations.html")); } catch { return null; }
  const parse = value => {
    try {
      const url = new URL(value);
      const ids = url.searchParams.getAll("workspaceId");
      return url.protocol === expected.protocol && url.hostname === expected.hostname && url.port === expected.port
        && url.pathname === expected.pathname && !url.hash
        && url.searchParams.size === 1 && ids.length === 1 && /^[a-f0-9]{12}$/.test(ids[0])
        ? ids[0]
        : null;
    } catch { return null; }
  };
  const sourceWorkspaceId = parse(sender.url);
  return sourceWorkspaceId != null && sourceWorkspaceId === parse(sender.tab.url)
    ? sourceWorkspaceId
    : null;
}

const projectRouter = createProjectContextRouter({
  browser: globalThis.chrome,
  createContext: (project, isSelected, withPageSendLock) => createWorkspaceContext(project, isSelected, withPageSendLock),
  localKeys: LEGACY_LOCAL_KEYS,
  sessionKeys: LEGACY_SESSION_KEYS,
  transportKey: "c2c_companion_transport_v1",
  localIdentityKey: "c2c_companion_local_v1",
  journalKey: "c2c_companion_journal_v1",
  journalStates: JOURNAL_STATES,
  isInternalSender: (sender, workspaceId) => isExtensionInternalSender(sender)
    || (typeof workspaceId === "string"
      && exactOperationsPanelWorkspaceId(sender, globalThis.chrome) === workspaceId),
  validateLegacyJournal: ({ journal, transport }) => {
    const shape = validateSendJournalShape(journal);
    return shape.ok && (journal.state === "NONE"
      || (areChatgptConversationRoutesEquivalent(journal.routeCanonical, transport.routeCanonical)
        && journal.bindingId === transport.bindingId && journal.epoch === transport.epoch));
  },
  routesEquivalent: areChatgptConversationRoutesEquivalent,
});

const dispatchProjectLifecycle = operation => {
  Promise.resolve(operation).catch(() => {});
};

// Register wake listeners before registry hydration so a cold MV3 worker cannot
// miss an alarm while project contexts are being created.
globalThis.chrome.alarms?.onAlarm?.addListener(alarm => {
  dispatchProjectLifecycle(projectRouter.handleAlarm(alarm));
});
globalThis.chrome.tabs?.onRemoved?.addListener(tabId => {
  pageArrivals.delete(tabId);
  dispatchProjectLifecycle(projectRouter.handleTabRemoved(tabId));
});
globalThis.chrome.tabs?.onActivated?.addListener(activeInfo => {
  dispatchProjectLifecycle(projectRouter.handleActiveOwnerRefresh(activeInfo?.tabId));
});
globalThis.chrome.windows?.onFocusChanged?.addListener(windowId => {
  if (windowId !== globalThis.chrome.windows.WINDOW_ID_NONE && windowId !== -1) {
    dispatchProjectLifecycle(projectRouter.handleActiveOwnerRefresh());
  }
});
globalThis.chrome.runtime.onInstalled?.addListener(details => {
  dispatchProjectLifecycle(projectRouter.handleInstalled(details));
});
globalThis.chrome.runtime.onStartup?.addListener(() => {
  pageArrivals.clear();
  dispatchProjectLifecycle(projectRouter.handleStartup());
});
dispatchProjectLifecycle(projectRouter.initialize());

globalThis.chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (Number.isSafeInteger(sender?.tab?.id) && sender.frameId === 0 && typeof sender.documentId === "string"
    && ["c2c.bind", "c2c.connect.page", "c2c.observe", "c2c.heartbeat", "c2c.status.page", "c2c.owner-proof.request"].includes(message?.type)) {
    const route = resolveObservationRouteVerdict(sender, message?.canonicalRoute ?? null);
    const next = { documentId: sender.documentId, url: route.verdict === "match" ? route.canonicalRoute : null,
      generation: Number.isFinite(message.generation) ? message.generation : 1 };
    if (JSON.stringify(pageArrivals.get(sender.tab.id)) !== JSON.stringify(next)) pageArrivals.set(sender.tab.id, next);
  }
  projectRouter.handle(message, sender)
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false, reason: "internal" }));
  return true;
});
