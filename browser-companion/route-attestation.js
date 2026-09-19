/**
 * G3 route-principal attestation browser contract (pure, browser-safe).
 * SW owns server-supplied attestation message; popup/content never free-write.
 * This path must NOT touch production journal / reserve / begin-send / ack.
 */
import { collectBoundedDescendants } from "./turn-observer.js";
import { normalizeCanonicalDomText } from "./dom-adapter.js";

export const ROUTE_ATTEST_EXECUTE_TYPE = "c2c.route.attest.execute";
export const ROUTE_ATTEST_SEND_TYPE = "c2c.route.attest.send";
export const ROUTE_ATTEST_MESSAGE_PREFIX = "[C2C_ROUTE_ATTEST]";
/** Session latch: tab/document/generation identity. Cleared by browser restart. */
export const ROUTE_ATTEST_LATCH_KEY = "c2c_route_attest_latch_v1";
/** Durable chrome.storage.local fence: survives browser restart. Challenge authority. */
export const ROUTE_ATTEST_FENCE_KEY = "c2c_route_attest_fence_v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FENCE_STATES = new Set([
  "NONE",
  "PAIRING_TRANSITION",
  "ROUTE_ATTEST_DISPATCH",
  "OBSERVED_PENDING_CONFIRM",
  "VERIFIED",
  "OUTCOME_UNKNOWN",
]);

/** Latch states: NONE | ROUTE_ATTEST_DISPATCH | OBSERVED_PENDING_CONFIRM | VERIFIED | OUTCOME_UNKNOWN
 * Distinct from production journal vocabulary — route attestation only.
 * Session-only identity cache. Durable fence is the restart-safe resend authority.
 */
export function emptyRouteAttestLatch() {
  return {
    state: "NONE",
    tabId: null,
    documentId: null,
    canonicalRoute: null,
    generation: null,
    challengeId: null,
    challengeExpiresAt: null,
    createdAt: null,
  };
}

export function parseRouteAttestLatch(raw) {
  if (!raw || typeof raw !== "object") return emptyRouteAttestLatch();
  if (raw.state == null) return emptyRouteAttestLatch();
  const state = typeof raw.state === "string" ? raw.state : "__INVALID__";
  if (state === "NONE") return emptyRouteAttestLatch();
  if (!FENCE_STATES.has(state)) {
    return { ...emptyRouteAttestLatch(), state: "OUTCOME_UNKNOWN" };
  }
  return {
    state,
    tabId: typeof raw.tabId === "number" ? raw.tabId : null,
    documentId: typeof raw.documentId === "string" ? raw.documentId : null,
    canonicalRoute: typeof raw.canonicalRoute === "string" ? raw.canonicalRoute : null,
    generation: Number.isFinite(raw.generation) ? raw.generation : null,
    challengeId: typeof raw.challengeId === "string" ? raw.challengeId : null,
    challengeExpiresAt: typeof raw.challengeExpiresAt === "string" ? raw.challengeExpiresAt : null,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : null,
  };
}

export function emptyRouteAttestFence() {
  return {
    state: "NONE",
    companionId: null,
    challengeId: null,
    routeCanonical: null,
    challengeExpiresAt: null,
    createdAt: null,
    updatedAt: null,
  };
}

/** Corrupt/unknown durable fence always fails closed → OUTCOME_UNKNOWN. */
export function parseRouteAttestFence(raw) {
  if (raw == null) return emptyRouteAttestFence();
  if (typeof raw !== "object") {
    return { ...emptyRouteAttestFence(), state: "OUTCOME_UNKNOWN" };
  }
  const companionId = typeof raw.companionId === "string" ? raw.companionId : null;
  const challengeId = typeof raw.challengeId === "string" ? raw.challengeId : null;
  const routeCanonical = typeof raw.routeCanonical === "string" ? raw.routeCanonical : null;
  const challengeExpiresAt = typeof raw.challengeExpiresAt === "string" ? raw.challengeExpiresAt : null;
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : null;
  const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : null;
  const base = {
    companionId,
    challengeId,
    routeCanonical,
    challengeExpiresAt,
    createdAt,
    updatedAt,
  };
  if (raw.state == null) {
    return { state: "OUTCOME_UNKNOWN", ...base };
  }
  const state = typeof raw.state === "string" ? raw.state : "__INVALID__";
  if (state === "NONE") return { state: "NONE", ...base };
  if (!FENCE_STATES.has(state)) {
    return { state: "OUTCOME_UNKNOWN", ...base };
  }
  return { state, ...base };
}

export function routeAttestLatchBlocksResend(latch) {
  // Any non-NONE latch blocks a new real Send, including VERIFIED (already attested).
  return Boolean(latch && latch.state && latch.state !== "NONE");
}

/**
 * Durable fence gate. Survives browser restart; session latch clear is not enough.
 * - corrupt/unknown → blocked
 * - pristine NONE (no companionId/challengeId) → allowed
 * - NONE with identity → current companionId/challengeId MUST match exactly,
 *   otherwise fail closed route_attest_fence_identity_mismatch
 * - ANY non-NONE fence (including PAIRING_TRANSITION and different identity) → blocked
 *   Legal new re-pair must explicitly persist matching NONE for the new companion+challenge.
 */
export function routeAttestFenceBlocksResend(fence, input = {}) {
  const parsed = parseRouteAttestFence(fence);
  if (parsed.state === "OUTCOME_UNKNOWN" && fence != null && typeof fence === "object"
    && typeof fence.state === "string" && !FENCE_STATES.has(fence.state)) {
    return { ok: false, reason: "route_attest_fence_corrupt", fenceState: "OUTCOME_UNKNOWN" };
  }
  if (fence != null && (typeof fence !== "object" || fence.state == null)) {
    return { ok: false, reason: "route_attest_fence_corrupt", fenceState: "OUTCOME_UNKNOWN" };
  }
  const { companionId, challengeId } = input;
  if (parsed.state === "NONE") {
    // Pristine NONE (no identity) is the only unconditional allow.
    if (!parsed.companionId && !parsed.challengeId) {
      return { ok: true, fenceState: "NONE" };
    }
    // Identity-anchored NONE: authorizes ONLY its own companion+challenge.
    if (parsed.companionId && companionId && parsed.companionId !== companionId) {
      return {
        ok: false,
        reason: "route_attest_fence_identity_mismatch",
        fenceState: "NONE",
        fenceCompanionId: parsed.companionId,
        fenceChallengeId: parsed.challengeId,
      };
    }
    if (parsed.challengeId && challengeId && parsed.challengeId !== challengeId) {
      return {
        ok: false,
        reason: "route_attest_fence_identity_mismatch",
        fenceState: "NONE",
        fenceCompanionId: parsed.companionId,
        fenceChallengeId: parsed.challengeId,
      };
    }
    if (parsed.companionId && !companionId) {
      return { ok: false, reason: "route_attest_fence_identity_mismatch", fenceState: "NONE" };
    }
    if (parsed.challengeId && !challengeId) {
      return { ok: false, reason: "route_attest_fence_identity_mismatch", fenceState: "NONE" };
    }
    return { ok: true, fenceState: "NONE" };
  }
  // Non-NONE: always block. Identity difference does NOT authorize a new Send.
  if (parsed.state === "PAIRING_TRANSITION") {
    return { ok: false, reason: "route_attest_pairing_transition", fenceState: parsed.state };
  }
  return { ok: false, reason: "route_attest_fence_active", fenceState: parsed.state };
}

/**
 * Barrier written BEFORE server /pair mutation.
 * Blocks all route-attestation DOM Send until a complete successful pair
 * replaces it with matching NONE, or a clear 4xx restores the previous fence.
 */
export function markPairingTransitionBarrier(prevFence, now = Date.now()) {
  const parsed = parseRouteAttestFence(prevFence);
  return {
    state: "PAIRING_TRANSITION",
    companionId: parsed.companionId,
    challengeId: parsed.challengeId,
    routeCanonical: parsed.routeCanonical,
    challengeExpiresAt: parsed.challengeExpiresAt,
    createdAt: parsed.createdAt ?? now,
    updatedAt: now,
  };
}

/**
 * Companion /pair contract: 4xx means request rejected with no pair mutation.
 * 5xx / network / timeout / missing response are outcome-unknown — keep barrier.
 */
export function shouldRestorePairFenceAfterHttpError(status) {
  return Number.isFinite(status) && status >= 400 && status < 500;
}

/**
 * Pure post-/pair fence resolution for successful 2xx + valid body.
 * Never invents NONE without new companionId + new challengeId.
 */
export function resolvePairFenceAfterSuccess(input = {}) {
  const { prevFence, companionId, challengeId, routeCanonical, now = Date.now() } = input;
  if (!companionId || !challengeId) {
    return {
      ok: false,
      reason: "route_attest_fence_pair_identity_missing",
      fence: markPairingTransitionBarrier(prevFence, now),
    };
  }
  return nextRouteAttestFenceAfterPair({
    fence: prevFence,
    newCompanionId: companionId,
    newChallengeId: challengeId,
    routeCanonical,
    now,
  });
}

export function markRouteAttestFenceDispatch(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  return {
    state: "ROUTE_ATTEST_DISPATCH",
    companionId: typeof input.companionId === "string" ? input.companionId : null,
    challengeId: typeof input.challengeId === "string" ? input.challengeId : null,
    routeCanonical: typeof input.routeCanonical === "string" ? input.routeCanonical : null,
    challengeExpiresAt: typeof input.challengeExpiresAt === "string" ? input.challengeExpiresAt : null,
    createdAt: now,
    updatedAt: now,
  };
}

export function markRouteAttestFenceState(fence, nextState, now = Date.now()) {
  const parsed = parseRouteAttestFence(fence);
  if (!FENCE_STATES.has(nextState)) {
    return { ...parsed, state: "OUTCOME_UNKNOWN", updatedAt: now };
  }
  return { ...parsed, state: nextState, updatedAt: now };
}

/**
 * Re-pair is the ONLY path that clears a non-NONE durable fence for a new send.
 * Requires new companionId AND new challengeId. Same challenge never clears.
 * Transport clear must NOT call this.
 */
export function nextRouteAttestFenceAfterPair(input = {}) {
  const { fence, newCompanionId, newChallengeId, routeCanonical, now = Date.now() } = input;
  const parsed = parseRouteAttestFence(fence);
  if (!newCompanionId || !newChallengeId) {
    return { ok: false, reason: "route_attest_fence_pair_identity_missing", fence: parsed };
  }
  if (parsed.companionId === newCompanionId && parsed.challengeId === newChallengeId) {
    return { ok: false, reason: "route_attest_fence_same_challenge", fence: parsed };
  }
  return {
    ok: true,
    fence: {
      state: "NONE",
      companionId: newCompanionId,
      challengeId: newChallengeId,
      routeCanonical: typeof routeCanonical === "string" ? routeCanonical : null,
      challengeExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    },
  };
}

/**
 * Authenticated /state VERIFIED may converge a matching durable fence to VERIFIED.
 * Matching includes OUTCOME_UNKNOWN (server confirmed without local resend).
 * Never invents VERIFIED; never touches a different challenge's fence.
 */
export function applyRouteAttestServerVerificationToFence(fence, routeVerification, identity = {}) {
  const parsed = parseRouteAttestFence(fence);
  if (routeVerification !== "VERIFIED") {
    return { ok: true, fence: parsed, transitioned: false };
  }
  if (parsed.state === "NONE" || parsed.state === "VERIFIED") {
    return { ok: true, fence: parsed, transitioned: false };
  }
  const { companionId, challengeId } = identity;
  if (parsed.challengeId && challengeId && parsed.challengeId !== challengeId) {
    return { ok: true, fence: parsed, transitioned: false };
  }
  if (parsed.companionId && companionId && parsed.companionId !== companionId) {
    return { ok: true, fence: parsed, transitioned: false };
  }
  if (
    parsed.state === "ROUTE_ATTEST_DISPATCH"
    || parsed.state === "OBSERVED_PENDING_CONFIRM"
    || parsed.state === "OUTCOME_UNKNOWN"
  ) {
    return {
      ok: true,
      fence: { ...parsed, state: "VERIFIED", updatedAt: Date.now() },
      transitioned: true,
    };
  }
  return { ok: true, fence: parsed, transitioned: false };
}

/**
 * After browser restart: session latch may be empty while local transport + fence remain.
 * Rebuild session latch from durable fence when it binds the current companion/challenge.
 * Durable fence remains the resend authority even if session latch stays NONE.
 */
export function reconcileRouteAttestAfterHydrate(input = {}) {
  const fence = parseRouteAttestFence(input.fence);
  const sessionLatch = parseRouteAttestLatch(input.sessionLatch);
  const transport = input.transport || null;
  const transportChallengeId = extractRouteChallengeId(transport?.routeAttestationMessage);
  const transportCompanionId = typeof transport?.companionId === "string" ? transport.companionId : null;

  const fenceMatchesTransport = fence.state !== "NONE"
    && Boolean(fence.challengeId)
    && Boolean(transportChallengeId)
    && fence.challengeId === transportChallengeId
    && (!fence.companionId || !transportCompanionId || fence.companionId === transportCompanionId);

  if (fenceMatchesTransport) {
    return {
      ok: true,
      fence,
      sessionLatch: {
        state: fence.state,
        tabId: null,
        documentId: null,
        canonicalRoute: transport?.routeCanonical ?? fence.routeCanonical ?? null,
        generation: null,
        challengeId: fence.challengeId,
        challengeExpiresAt: fence.challengeExpiresAt ?? transport?.routeAttestationExpiresAt ?? null,
        createdAt: fence.createdAt,
      },
      resendBlocked: true,
    };
  }

  // Corrupt / non-NONE fence without matching transport challenge still blocks via fence gate.
  const resendBlocked = fence.state !== "NONE";
  return {
    ok: true,
    fence,
    sessionLatch,
    resendBlocked,
  };
}

function defaultNormalize(text) {
  try {
    return normalizeCanonicalDomText(text);
  } catch {
    return String(text ?? "");
  }
}

/** Extract server-owned challengeId from fixed attestation body. */
export function extractRouteChallengeId(message) {
  if (typeof message !== "string" || !isRouteAttestationMessage(message)) return null;
  const lines = message.split("\n").map((l) => l.replace(/\r$/, ""));
  const hits = lines.filter((line) => /^challengeId=[0-9a-fA-F-]{36}$/.test(line));
  if (hits.length !== 1) return null;
  const id = hits[0].slice("challengeId=".length);
  return UUID.test(id) ? id : null;
}

/**
 * Exact challenge marker proof — production ATTEMPT_ID semantics are NOT weakened.
 * Requires exactly one line `challengeId=<uuid>` in the server-owned body.
 */
export function hasExactRouteChallengeMarker(message, challengeId) {
  if (typeof message !== "string" || message.length === 0) {
    return { ok: false, reason: "message_missing" };
  }
  if (typeof challengeId !== "string" || !UUID.test(challengeId)) {
    return { ok: false, reason: "challenge_missing" };
  }
  const lines = message.split("\n").map((l) => l.replace(/\r$/, ""));
  const expected = `challengeId=${challengeId}`;
  const hits = lines.filter((line) => line === expected);
  if (hits.length === 1) return { ok: true };
  if (hits.length === 0) return { ok: false, reason: "challenge_marker_mismatch" };
  return { ok: false, reason: "challenge_marker_duplicate" };
}

function baselineHasTurn(baseline, turn) {
  if (!baseline || baseline.length === 0) return false;
  for (const b of baseline) {
    if (!b) continue;
    if (b === turn) return true;
    if (b.id != null && b.id === turn.id) return true;
    if (typeof b.text === "string" && b.text.length > 0 && b.text === turn.text) return true;
  }
  return false;
}

const ROUTE_ATTEST_DESCENDANT_LIMIT = 64;

function routeAttInnerTextOf(node) {
  if (!node) return "";
  if (typeof node.innerText === "string") return node.innerText;
  return "";
}

/**
 * Live-DOM exact-body authority for route attestation (no ATTEMPT_ID).
 * Mirrors production bounded-descendant semantics without weakening production observer:
 * - parent exact body + exact challenge marker
 * - else parent visible text must carry exact challengeId=<uuid>
 * - ≤64 descendants; only descendant innerText full canonical equality counts
 * - multiple exact descendants inside ONE user turn = one match
 * - ambiguity is per USER turn
 */
function routeAttTurnBodyMatch(turn, want, challengeId, normalizeText) {
  if (!turn || typeof turn.text !== "string" || typeof want !== "string" || want.length === 0) {
    return false;
  }
  const norm = typeof normalizeText === "function" ? normalizeText : defaultNormalize;
  const wantNorm = norm(want);
  const parentNorm = norm(turn.text);

  // 1) Parent exact fast path (canonical normalization).
  if (parentNorm === wantNorm && hasExactRouteChallengeMarker(parentNorm, challengeId).ok) {
    return true;
  }
  // 2) Parent visible representation must carry the exact challenge marker first.
  if (!hasExactRouteChallengeMarker(parentNorm, challengeId).ok) return false;

  // 3) Bounded descendant innerText full-equality authority (canonical normalization).
  // collectBoundedDescendants only — no unbounded DOM scan fallback.
  let descendants = [];
  try {
    descendants = collectBoundedDescendants(turn.node, ROUTE_ATTEST_DESCENDANT_LIMIT);
  } catch {
    descendants = [];
  }
  if (!Array.isArray(descendants)) descendants = [];
  for (const d of descendants) {
    const inner = norm(routeAttInnerTextOf(d));
    if (inner !== wantNorm) continue;
    if (!hasExactRouteChallengeMarker(inner, challengeId).ok) continue;
    return true;
  }
  return false;
}

/**
 * Exact unique USER-turn observation for route attestation.
 * Uses server challengeId marker + full canonical body.
 * Never uses production ATTEMPT_ID semantics; never returns truthy failure objects as success.
 */
export function findRouteAttestationUserTurn(input = {}) {
  const message = input.message;
  const challengeId = input.challengeId;
  const baseline = Array.isArray(input.baseline) ? input.baseline : null;
  const turns = Array.isArray(input.turns) ? input.turns : null;
  const normalizeText = input.normalizeText || defaultNormalize;

  const marker = hasExactRouteChallengeMarker(message, challengeId);
  if (!marker.ok) {
    return { ok: false, reason: marker.reason };
  }
  if (!turns) {
    return { ok: false, reason: "turns_missing" };
  }

  const want = normalizeText(message);
  const matches = turns.filter((turn) => {
    if (!routeAttTurnBodyMatch(turn, want, challengeId, normalizeText)) return false;
    if (baselineHasTurn(baseline, turn)) return false;
    return true;
  });

  if (matches.length === 0) {
    return { ok: false, reason: "not_observed" };
  }
  if (matches.length > 1) {
    return { ok: false, reason: "ambiguous" };
  }
  return { ok: true, turn: matches[0] };
}

export { ROUTE_ATTEST_DESCENDANT_LIMIT, routeAttTurnBodyMatch };

/** Parse exact tool-call args from server-owned attestation body. */
export function extractRouteAttestToolCallArgs(message) {
  if (typeof message !== "string") return null;
  const m = message.match(
    /feedback_companion_route_confirm\(challengeId=([0-9a-fA-F-]{36}), challengeDigest=([0-9a-f]{64})\)/,
  );
  if (!m) return null;
  return { challengeId: m[1].toLowerCase(), challengeDigest: m[2].toLowerCase() };
}

/** Header lines challengeId/challengeDigest from server-owned body. */
export function extractRouteAttestHeaderArgs(message) {
  if (typeof message !== "string") return null;
  const lines = message.split("\n").map((l) => l.replace(/\r$/, ""));
  const idLine = lines.find((l) => /^challengeId=[0-9a-fA-F-]{36}$/.test(l));
  const digestLine = lines.find((l) => /^challengeDigest=[0-9a-f]{64}$/.test(l));
  if (!idLine || !digestLine) return null;
  return {
    challengeId: idLine.slice("challengeId=".length).toLowerCase(),
    challengeDigest: digestLine.slice("challengeDigest=".length).toLowerCase(),
  };
}

/**
 * Authenticated /state is the only authority that may move latch → VERIFIED.
 * Accepts OBSERVED_PENDING_CONFIRM, ROUTE_ATTEST_DISPATCH, and OUTCOME_UNKNOWN
 * (server confirmed a challenge we may have lost the RPC result for).
 * Never derives VERIFIED from local DOM observation.
 */
export function applyRouteAttestServerVerification(latch, routeVerification) {
  if (!latch || typeof latch !== "object") {
    return { ok: false, reason: "latch_missing", latch: emptyRouteAttestLatch(), transitioned: false };
  }
  const state = typeof latch.state === "string" ? latch.state : "NONE";
  if (
    routeVerification === "VERIFIED"
    && (state === "OBSERVED_PENDING_CONFIRM"
      || state === "ROUTE_ATTEST_DISPATCH"
      || state === "OUTCOME_UNKNOWN")
  ) {
    return { ok: true, latch: { ...latch, state: "VERIFIED" }, transitioned: true };
  }
  return { ok: true, latch, transitioned: false };
}

/**
 * Bounded read-only /state polling gate for OBSERVED_PENDING_CONFIRM.
 * Never a resend gate. Stops on: not pollable latch, non-owner, auth stale,
 * identity drift, challenge mismatch, challenge expiry, already VERIFIED.
 * Re-pair mints a new challenge and resets latch to NONE (see SW handlePair).
 */
export function shouldPollRouteAttestConfirm(input = {}) {
  const { latch, ownerExact, owner, transport, now = Date.now() } = input;
  if (!latch || latch.state !== "OBSERVED_PENDING_CONFIRM") {
    return { ok: false, reason: "latch_not_pollable" };
  }
  if (ownerExact !== true) {
    return { ok: false, reason: "not_exact_owner" };
  }
  if (!transport || transport.authStale === true) {
    return { ok: false, reason: "auth_stale" };
  }
  if (
    !owner
    || typeof owner.tabId !== "number"
    || owner.tabId !== latch.tabId
    || !owner.documentId
    || owner.documentId !== latch.documentId
  ) {
    return { ok: false, reason: "identity_drift" };
  }
  if (latch.canonicalRoute && owner.canonicalRoute !== latch.canonicalRoute) {
    return { ok: false, reason: "identity_drift" };
  }
  if (transport.routeVerification === "VERIFIED") {
    return { ok: false, reason: "already_verified" };
  }
  if (transport.routeVerification != null && transport.routeVerification !== "PENDING") {
    return { ok: false, reason: "route_verification_invalid" };
  }
  const messageChallengeId = extractRouteChallengeId(transport.routeAttestationMessage);
  if (!messageChallengeId || !latch.challengeId || messageChallengeId !== latch.challengeId) {
    return { ok: false, reason: "challenge_mismatch" };
  }
  const expiresAt = transport.routeAttestationExpiresAt || latch.challengeExpiresAt;
  if (expiresAt && Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) <= now) {
    return { ok: false, reason: "challenge_expired" };
  }
  return { ok: true, challengeId: messageChallengeId };
}

/** Popup → SW: no arbitrary payload. SW owns message from authenticated pair/state. */
export function validateRouteAttestPopupRequest(message) {
  if (!message || typeof message !== "object") {
    return { ok: false, reason: "route_attest_payload_invalid" };
  }
  if (
    message.message != null
    || message.probeMessage != null
    || message.attestationMessage != null
    || message.payload != null
    || message.route != null
    || message.routeCanonical != null
    || message.documentId != null
    || message.tabId != null
    || message.generation != null
  ) {
    return { ok: false, reason: "route_attest_payload_forbidden" };
  }
  return { ok: true };
}

export function isRouteAttestationMessage(message) {
  return typeof message === "string"
    && message.startsWith(ROUTE_ATTEST_MESSAGE_PREFIX)
    && message.length > ROUTE_ATTEST_MESSAGE_PREFIX.length
    && message.length <= 2048;
}

/** Preconditions before SW issues mutation RPC. */
export function canStartRouteAttestSend(input = {}) {
  const {
    owner,
    transport,
    journal,
    evidence,
    productionSendInFlight,
    autonomyMode,
    latch,
    fence,
    companionId,
    challengeId,
  } = input;
  if (!owner || typeof owner.tabId !== "number" || !owner.documentId) {
    return { ok: false, reason: "owner_document_invalid" };
  }
  if (!transport || transport.authStale !== false && transport.authStale != null) {
    return { ok: false, reason: "auth_stale" };
  }
  if (!transport || typeof transport.routeCanonical !== "string" || !transport.routeCanonical) {
    return { ok: false, reason: "transport_invalid" };
  }
  if (owner.canonicalRoute !== transport.routeCanonical) {
    return { ok: false, reason: "owner_route_mismatch" };
  }
  if (typeof owner.generation !== "number" || !Number.isFinite(owner.generation)) {
    return { ok: false, reason: "owner_generation_missing" };
  }
  if (transport.routeVerification === "VERIFIED") {
    return { ok: false, reason: "route_already_verified" };
  }
  if (transport.routeVerification !== "PENDING" && transport.routeVerification != null) {
    return { ok: false, reason: "route_verification_invalid" };
  }
  if (!isRouteAttestationMessage(transport.routeAttestationMessage)) {
    return { ok: false, reason: "route_attestation_message_missing" };
  }
  const messageChallengeId = extractRouteChallengeId(transport.routeAttestationMessage);
  if (challengeId && messageChallengeId && challengeId !== messageChallengeId) {
    return { ok: false, reason: "challenge_mismatch" };
  }
  // Session latch: only NONE may dispatch. Session may be empty after browser restart.
  if (latch && latch.state && latch.state !== "NONE") {
    return { ok: false, reason: "route_attest_latch_active", latchState: latch.state };
  }
  // Durable fence: survives browser restart. Session latch NONE is NOT enough.
  const fenceGate = routeAttestFenceBlocksResend(fence, {
    companionId: companionId ?? transport.companionId ?? null,
    challengeId: messageChallengeId ?? challengeId ?? null,
  });
  if (!fenceGate.ok) {
    return {
      ok: false,
      reason: fenceGate.reason,
      fenceState: fenceGate.fenceState,
      latchState: latch?.state ?? "NONE",
    };
  }
  if (journal && journal.state && journal.state !== "NONE") {
    return { ok: false, reason: "route_attest_journal_active" };
  }
  if (productionSendInFlight === true) {
    return { ok: false, reason: "production_send_in_flight" };
  }
  if (autonomyMode === "armed") {
    return { ok: false, reason: "autonomy_armed" };
  }
  if (!evidence || evidence.safe !== true || evidence.composer !== "empty" || evidence.generation !== "idle") {
    return { ok: false, reason: "evidence_unsafe" };
  }
  return { ok: true, attestationMessage: transport.routeAttestationMessage, challengeId: messageChallengeId };
}

/** SW → CS: identity + fixed SW-owned message only. */
export function buildRouteAttestExecuteRequest(owner, transport) {
  const message = transport?.routeAttestationMessage;
  if (!isRouteAttestationMessage(message)) {
    return { ok: false, reason: "route_attestation_message_missing" };
  }
  const challengeId = extractRouteChallengeId(message);
  if (!challengeId) {
    return { ok: false, reason: "challenge_missing" };
  }
  if (!owner || typeof owner.tabId !== "number" || !owner.documentId) {
    return { ok: false, reason: "owner_document_invalid" };
  }
  return {
    ok: true,
    tabId: owner.tabId,
    message: {
      type: ROUTE_ATTEST_EXECUTE_TYPE,
      expectedRoute: transport.routeCanonical,
      expectedGeneration: owner.generation,
      expectedDocumentId: owner.documentId,
      attestationMessage: message,
      challengeId,
    },
    sendOptions: { documentId: owner.documentId },
  };
}

/**
 * CS result classification. Never auto-retry ambiguous send.
 * observed=true means exact attestation user-turn seen — local observation only.
 * Server VERIFIED still requires authenticated /state.
 */
export function classifyRouteAttestRpcResult(response) {
  if (!response || typeof response !== "object") {
    return { ok: false, reason: "route_attest_response_missing", retryAllowed: false };
  }
  if (response.ok === true && response.observed === true) {
    return {
      ok: true,
      observed: true,
      retryAllowed: false,
      // SW must still poll authenticated /state for VERIFIED.
      serverVerified: false,
    };
  }
  if (response.observed === true) {
    return { ok: false, reason: "route_attest_inconsistent", retryAllowed: false, observed: true };
  }
  if (response.clickAttempted === true || response.mutationAttempted === true) {
    // Ambiguous click/send without exact observation — fail closed, no retry.
    return {
      ok: false,
      reason: typeof response.reason === "string" && response.reason
        ? response.reason
        : "route_attest_outcome_ambiguous",
      retryAllowed: false,
      observed: false,
    };
  }
  return {
    ok: false,
    reason: typeof response.reason === "string" && response.reason
      ? response.reason
      : "route_attest_failed",
    retryAllowed: false,
    observed: false,
  };
}

/**
 * Synchronize durable transport routeVerification from authenticated /state only.
 * Never derive VERIFIED from a local send result.
 */
export function syncTransportRouteVerification(persisted, serverBody) {
  if (!persisted || !serverBody) {
    return { ok: false, reason: "identity_missing" };
  }
  const serverVerified = serverBody.routeVerification === "VERIFIED"
    || serverBody.productionEligible === true;
  const nextVerification = serverVerified ? "VERIFIED" : "PENDING";
  const wasVerified = persisted.routeVerification === "VERIFIED";
  const next = { ...persisted, routeVerification: nextVerification };
  if (typeof serverBody.routeAttestation?.expiresAt === "string") {
    next.routeAttestationExpiresAt = serverBody.routeAttestation.expiresAt;
  }
  if (nextVerification === "VERIFIED") {
    delete next.routeAttestationMessage;
  } else if (
    typeof serverBody.routeAttestation?.message === "string"
    && isRouteAttestationMessage(serverBody.routeAttestation.message)
  ) {
    next.routeAttestationMessage = serverBody.routeAttestation.message;
  }
  return {
    ok: true,
    transport: next,
    routeVerification: nextVerification,
    productionEligible: nextVerification === "VERIFIED",
    downgraded: wasVerified && nextVerification === "PENDING",
  };
}
