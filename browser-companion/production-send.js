/**
 * E1b3d3b production one-shot send contract (pure helpers).
 * Browser-safe. No DOM mutation, no Chrome API, no fetch, no credentials.
 * SW is the only journal writer / Bridge HTTP authority.
 */

import {
  EVIDENCE_MAX_AGE_MS,
  validateSendJournalShape,
  isLegalJournalTransition,
} from "./reservation-journal.js";

export const PRODUCTION_START_TYPE = "c2c.production.send.execute";
export const PRODUCTION_RECOVER_TYPE = "c2c.production.send.recover";
export const PRODUCTION_JOURNAL_PERSIST_TYPE = "c2c.production.journal.persist";
export const PRODUCTION_BEGIN_SEND_TYPE = "c2c.production.begin.send";
export const PRODUCTION_ACK_TYPE = "c2c.production.ack";
export const PRODUCTION_SEND_REQUEST_TYPE = "c2c.production.send.request";

const IDENTITY_FIELDS = [
  "state",
  "eventId",
  "reservationId",
  "attemptId",
  "routeCanonical",
  "bindingId",
  "epoch",
  "message",
  "messageSha256",
];

function sameNull(a, b) {
  return (a ?? null) === (b ?? null);
}

/**
 * CAS commit for production journal. Fail closed on any mismatch.
 * Protected transitions require SW-issued short-lived proofs.
 * @param {object} current durable SW journal
 * @param {object} proposed CS-proposed next journal
 * @param {object} expectedPrevious CS-claimed previous journal
 * @param {{ claimProof?: object|null, ackProof?: object|null }} [proofs]
 */
export function validateProductionJournalCommit(current, proposed, expectedPrevious, proofs = {}) {
  if (!current || !proposed || !expectedPrevious) {
    return { ok: false, reason: "cas_input_missing" };
  }
  for (const field of IDENTITY_FIELDS) {
    if (!sameNull(current[field], expectedPrevious[field])) {
      return { ok: false, reason: "cas_previous_mismatch" };
    }
  }
  const shape = validateSendJournalShape(proposed);
  if (!shape.ok) {
    return { ok: false, reason: `proposed_shape_invalid:${shape.reason}` };
  }
  if (!isLegalJournalTransition(current.state, proposed.state)) {
    return { ok: false, reason: "illegal_transition" };
  }
  // RESERVED → NONE is SW release-only; CS production persist must never clear a live reservation.
  if (current.state === "RESERVED" && proposed.state === "NONE") {
    return { ok: false, reason: "cs_cannot_clear_reserved" };
  }
  // SEND_INTENT + no-inFlight clear is SW recovery-only.
  if (current.state === "SEND_INTENT" && proposed.state === "NONE") {
    return { ok: false, reason: "cs_cannot_clear_send_intent" };
  }
  // Post-CLAIMED → NONE is only legal from OBSERVED_PENDING_ACK with exact ack proof.
  if (proposed.state === "NONE" && current.state !== "OBSERVED_PENDING_ACK") {
    if (
      current.state === "CLAIMED"
      || current.state === "COMPOSER_WRITE_INTENT"
      || current.state === "SEND_DISPATCH_INTENT"
    ) {
      return { ok: false, reason: "cs_cannot_clear_without_ack_proof" };
    }
  }

  // SEND_INTENT → CLAIMED requires exact SW claim proof from real /begin-send.
  if (current.state === "SEND_INTENT" && proposed.state === "CLAIMED") {
    const proof = proofs?.claimProof;
    if (!proof || typeof proof !== "object") {
      return { ok: false, reason: "claim_proof_missing" };
    }
    if (
      proof.eventId !== proposed.eventId
      || proof.reservationId !== proposed.reservationId
      || proof.attemptId !== proposed.attemptId
      || proof.message !== proposed.message
      || proof.messageSha256 !== proposed.messageSha256
    ) {
      return { ok: false, reason: "claim_proof_mismatch" };
    }
    if (
      proof.eventId !== current.eventId
      || proof.reservationId !== current.reservationId
    ) {
      return { ok: false, reason: "claim_proof_mismatch" };
    }
  }

  // OBSERVED_PENDING_ACK → NONE requires exact SW ack proof from real /ack.
  if (current.state === "OBSERVED_PENDING_ACK" && proposed.state === "NONE") {
    const proof = proofs?.ackProof;
    if (!proof || typeof proof !== "object") {
      return { ok: false, reason: "ack_proof_missing" };
    }
    if (
      proof.eventId !== current.eventId
      || proof.attemptId !== current.attemptId
      || proof.status !== "observed"
    ) {
      return { ok: false, reason: "ack_proof_mismatch" };
    }
  }

  if (proposed.state !== "NONE") {
    for (const field of ["eventId", "reservationId", "routeCanonical", "bindingId", "epoch"]) {
      if (current[field] != null && proposed[field] !== current[field]) {
        return { ok: false, reason: `identity_immutable:${field}` };
      }
    }
    if (current.attemptId && proposed.attemptId && proposed.attemptId !== current.attemptId) {
      return { ok: false, reason: "identity_immutable:attemptId" };
    }
    if (current.message != null && proposed.message != null && proposed.message !== current.message) {
      return { ok: false, reason: "identity_immutable:message" };
    }
    if (
      current.messageSha256 != null
      && proposed.messageSha256 != null
      && proposed.messageSha256 !== current.messageSha256
    ) {
      return { ok: false, reason: "identity_immutable:messageSha256" };
    }
  }
  return { ok: true };
}

/** Build a short-lived claim proof from a fully validated /begin-send DTO. */
export function buildClaimProof({ eventId, reservationId, attemptId, message, messageSha256 }) {
  if (
    !eventId
    || !reservationId
    || !attemptId
    || typeof message !== "string"
    || !message
    || typeof messageSha256 !== "string"
    || !messageSha256
  ) {
    return null;
  }
  return { eventId, reservationId, attemptId, message, messageSha256 };
}

/** Build a short-lived ack proof from a fully validated /ack DTO. */
export function buildAckProof({ eventId, attemptId, status }) {
  if (!eventId || !attemptId || status !== "observed") return null;
  return { eventId, attemptId, status: "observed" };
}

/**
 * Reconcile local CLAIMED against authenticated /state.inFlight.
 * Server is the upper fact: never resume write when server is missing/mismatched/outcome_unknown.
 */
export function reconcileClaimedAgainstServer(journal, inFlight) {
  if (!journal || journal.state !== "CLAIMED") {
    return { action: "noop" };
  }
  if (!journal.eventId || !journal.reservationId || !journal.attemptId) {
    return { action: "fail_closed", reason: "claimed_identity_missing", zeroWrite: true, zeroClick: true };
  }
  if (!inFlight || typeof inFlight !== "object") {
    return { action: "fail_closed", reason: "claimed_without_server_inflight", zeroWrite: true, zeroClick: true };
  }
  if (inFlight.eventId !== journal.eventId || inFlight.reservationId !== journal.reservationId) {
    return { action: "conflict", reason: "claimed_identity_mismatch", zeroWrite: true, zeroClick: true };
  }
  if (inFlight.status === "outcome_unknown") {
    if (inFlight.attemptId && inFlight.attemptId !== journal.attemptId) {
      return { action: "conflict", reason: "claimed_attempt_mismatch", zeroWrite: true, zeroClick: true };
    }
    return {
      action: "adopt_outcome_unknown",
      reason: "server_outcome_unknown",
      zeroWrite: true,
      zeroClick: true,
      attemptId: inFlight.attemptId ?? journal.attemptId,
      message: journal.message,
      messageSha256: journal.messageSha256,
    };
  }
  if (inFlight.status === "observed") {
    if (inFlight.attemptId && inFlight.attemptId !== journal.attemptId) {
      return { action: "conflict", reason: "claimed_attempt_mismatch", zeroWrite: true, zeroClick: true };
    }
    return { action: "ack_only", zeroWrite: true, zeroClick: true };
  }
  if (inFlight.status === "claimed" && inFlight.attemptId) {
    if (inFlight.attemptId !== journal.attemptId) {
      return { action: "conflict", reason: "claimed_attempt_mismatch", zeroWrite: true, zeroClick: true };
    }
    if (inFlight.message !== undefined && inFlight.message !== journal.message) {
      return { action: "conflict", reason: "claimed_message_mismatch", zeroWrite: true, zeroClick: true };
    }
    if (inFlight.messageSha256 !== undefined && inFlight.messageSha256 !== journal.messageSha256) {
      return { action: "conflict", reason: "claimed_message_sha_mismatch", zeroWrite: true, zeroClick: true };
    }
    return {
      action: "resume",
      claimProof: buildClaimProof({
        eventId: journal.eventId,
        reservationId: journal.reservationId,
        attemptId: journal.attemptId,
        message: journal.message,
        messageSha256: journal.messageSha256,
      }),
    };
  }
  return { action: "conflict", reason: "claimed_inflight_mismatch", zeroWrite: true, zeroClick: true };
}

/**
 * SW pre-claim gate. Must fail while journal is still RESERVED.
 * Caller cannot supply message / event / reservation / attempt / route / documentId.
 */
export function canStartProductionSend(input) {
  const {
    owner,
    transport,
    journal,
    latch,
    productionSendInFlight = false,
    evidence,
    now = Date.now(),
    maxAgeMs = EVIDENCE_MAX_AGE_MS,
  } = input || {};

  if (productionSendInFlight) {
    return { ok: false, reason: "production_send_in_flight" };
  }
  if (!owner || typeof owner.tabId !== "number" || !owner.documentId) {
    return { ok: false, reason: "owner_document_invalid" };
  }
  if (!transport || typeof transport.routeCanonical !== "string" || transport.authStale) {
    return { ok: false, reason: "auth_stale" };
  }
  if (owner.canonicalRoute !== transport.routeCanonical) {
    return { ok: false, reason: "owner_route_mismatch" };
  }
  if (typeof owner.generation !== "number" || !Number.isFinite(owner.generation)) {
    return { ok: false, reason: "owner_generation_missing" };
  }
  if (!journal || journal.state !== "RESERVED") {
    return { ok: false, reason: "journal_not_reserved", journalState: journal?.state ?? "NONE" };
  }
  if (!journal.eventId || !journal.reservationId) {
    return { ok: false, reason: "journal_identity_missing" };
  }
  if (journal.routeCanonical !== transport.routeCanonical) {
    return { ok: false, reason: "route_mismatch" };
  }
  if (journal.bindingId !== transport.bindingId || journal.epoch !== transport.epoch) {
    return { ok: false, reason: "binding_mismatch" };
  }
  const latchState = latch?.state ?? "NONE";
  if (latchState !== "NONE") {
    return { ok: false, reason: "send_probe_latch_active", latchState };
  }
  if (!evidence || typeof evidence.observedAt !== "number") {
    return { ok: false, reason: "evidence_missing" };
  }
  if (evidence.documentId !== owner.documentId) {
    return { ok: false, reason: "evidence_document_mismatch" };
  }
  if (evidence.canonicalRoute !== owner.canonicalRoute) {
    return { ok: false, reason: "evidence_route_mismatch" };
  }
  const age = now - evidence.observedAt;
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) {
    return { ok: false, reason: "evidence_stale" };
  }
  if (evidence.composer !== "empty") {
    return { ok: false, reason: "composer_not_empty" };
  }
  if (evidence.generation !== "idle") {
    return { ok: false, reason: "generation_not_idle" };
  }
  if (evidence.safe !== true) {
    return { ok: false, reason: "evidence_unsafe" };
  }
  return { ok: true };
}

/**
 * Exact-document start RPC. Payload carries only SW-authority immutable context.
 * Never message / attemptId / credential / caller eventId.
 */
export function buildProductionSendExecuteRequest(owner, journal) {
  if (!owner || typeof owner.tabId !== "number" || !owner.documentId) {
    return { ok: false, reason: "owner_document_invalid" };
  }
  if (!journal || journal.state !== "RESERVED" || !journal.eventId || !journal.reservationId) {
    return { ok: false, reason: "journal_not_reserved" };
  }
  if (typeof owner.generation !== "number" || !Number.isFinite(owner.generation)) {
    return { ok: false, reason: "owner_generation_missing" };
  }
  return {
    ok: true,
    tabId: owner.tabId,
    message: {
      type: PRODUCTION_START_TYPE,
      expectedRoute: journal.routeCanonical,
      expectedGeneration: owner.generation,
      expectedDocumentId: owner.documentId,
      startJournal: {
        state: journal.state,
        eventId: journal.eventId,
        reservationId: journal.reservationId,
        routeCanonical: journal.routeCanonical,
        bindingId: journal.bindingId,
        epoch: journal.epoch,
        attemptId: null,
        message: null,
        messageSha256: null,
      },
    },
    sendOptions: { documentId: owner.documentId },
  };
}

/**
 * Exact-document recovery RPC. CS never invents identity.
 */
export function buildProductionRecoverRequest(owner, journal, inFlight) {
  if (!owner || typeof owner.tabId !== "number" || !owner.documentId) {
    return { ok: false, reason: "owner_document_invalid" };
  }
  if (!journal || !journal.state || journal.state === "NONE") {
    return { ok: false, reason: "journal_not_active" };
  }
  if (typeof owner.generation !== "number" || !Number.isFinite(owner.generation)) {
    return { ok: false, reason: "owner_generation_missing" };
  }
  const safeInFlight = inFlight && typeof inFlight === "object"
    ? {
        status: inFlight.status ?? null,
        eventId: inFlight.eventId ?? null,
        reservationId: inFlight.reservationId ?? null,
        attemptId: inFlight.attemptId ?? null,
        message: typeof inFlight.message === "string" ? inFlight.message : null,
        messageSha256: typeof inFlight.messageSha256 === "string" ? inFlight.messageSha256 : null,
      }
    : null;
  return {
    ok: true,
    tabId: owner.tabId,
    message: {
      type: PRODUCTION_RECOVER_TYPE,
      expectedRoute: journal.routeCanonical ?? owner.canonicalRoute,
      expectedGeneration: owner.generation,
      expectedDocumentId: owner.documentId,
      startJournal: {
        state: journal.state,
        eventId: journal.eventId ?? null,
        reservationId: journal.reservationId ?? null,
        attemptId: journal.attemptId ?? null,
        routeCanonical: journal.routeCanonical ?? owner.canonicalRoute,
        bindingId: journal.bindingId ?? null,
        epoch: journal.epoch ?? null,
        message: typeof journal.message === "string" ? journal.message : null,
        messageSha256: typeof journal.messageSha256 === "string" ? journal.messageSha256 : null,
      },
      inFlight: safeInFlight,
    },
    sendOptions: { documentId: owner.documentId },
  };
}

/**
 * After start RPC throw/empty: durable journal is the only authority.
 * Never re-start once SEND_INTENT or later may have been persisted.
 * Production success requires response.mode + ok AND durable journal NONE.
 */
export function classifyProductionStartRpcResult(input) {
  const { response, journalAfter } = input || {};
  const state = journalAfter?.state ?? "NONE";
  if (response != null && typeof response === "object") {
    if (response.ok === true) {
      if (response.mode !== "production_send") {
        return {
          ok: false,
          reason: "production_response_mode_invalid",
          retryAllowed: false,
          action: state === "RESERVED" ? "retry" : "recover",
          journalState: state,
        };
      }
      if (state !== "NONE") {
        return {
          ok: false,
          reason: "production_journal_not_cleared",
          retryAllowed: false,
          action: "recover",
          journalState: state,
          zeroWrite: state !== "SEND_INTENT",
          zeroClick: state !== "SEND_INTENT",
        };
      }
      return { ok: true, response, journalState: state };
    }
    if (response.retryAllowed === true && state === "RESERVED") {
      return {
        ok: false,
        reason: response.reason || "production_start_failed",
        retryAllowed: true,
        action: "retry",
        journalState: state,
      };
    }
    if (state === "RESERVED") {
      return {
        ok: false,
        reason: response.reason || "production_start_failed",
        retryAllowed: true,
        action: "retry",
        journalState: state,
        zeroWrite: response.zeroWrite === true,
        zeroClick: response.zeroClick === true,
      };
    }
    return {
      ok: false,
      reason: response.reason || "production_start_failed",
      retryAllowed: false,
      action: "recover",
      journalState: state,
      zeroWrite: response.zeroWrite === true || state !== "SEND_INTENT",
      zeroClick: response.zeroClick === true || state !== "SEND_INTENT",
      retryAck: response.retryAck === true,
    };
  }
  // RPC throw / empty response.
  if (state === "RESERVED") {
    return {
      ok: false,
      reason: "production_start_rpc_failed",
      retryAllowed: true,
      action: "retry",
      journalState: state,
    };
  }
  if (state === "SEND_INTENT" || state === "CLAIMED") {
    return {
      ok: false,
      reason: "production_start_rpc_failed",
      retryAllowed: false,
      action: "recover",
      journalState: state,
    };
  }
  return {
    ok: false,
    reason: "production_start_rpc_failed",
    retryAllowed: false,
    action: "recover",
    journalState: state,
    zeroWrite: true,
    zeroClick: true,
  };
}

/** Strip secret-bearing fields from /state inFlight before CS recovery. */
export function sanitizeInFlightForRecovery(inFlight) {
  if (!inFlight || typeof inFlight !== "object") return null;
  return {
    status: inFlight.status ?? null,
    eventId: inFlight.eventId ?? null,
    reservationId: inFlight.reservationId ?? null,
    attemptId: inFlight.attemptId ?? null,
    message: typeof inFlight.message === "string" ? inFlight.message : null,
    messageSha256: typeof inFlight.messageSha256 === "string" ? inFlight.messageSha256 : null,
  };
}

/** Safe popup/status journal summary — never message body / credential. */
export function summarizeProductionJournal(journal) {
  if (!journal || !journal.state || journal.state === "NONE") {
    return { state: "NONE" };
  }
  return {
    state: journal.state,
    eventId: journal.eventId ?? null,
    reservationId: journal.reservationId ?? null,
    attemptId: journal.attemptId ?? null,
    routeCanonical: journal.routeCanonical ?? null,
  };
}

/**
 * Narrow durable commit helper.
 * success → memory = proposed
 * failure → memory = previous (proposed never becomes long-term authority)
 * proofs are only consumed after durable success.
 *
 * @param {{
 *   current: object,
 *   proposed: object,
 *   persist: (journal: object) => Promise<void>,
 *   onDurableSuccess?: (proposed: object) => void,
 * }} input
 * @returns {Promise<{ ok: true, journal: object } | { ok: false, reason: "journal_persist_failed", error: string, journal: object }>}
 */
export async function commitJournalDurably(input) {
  const { current, proposed, persist, onDurableSuccess } = input || {};
  if (!current || !proposed || typeof persist !== "function") {
    return {
      ok: false,
      reason: "journal_persist_failed",
      error: "commit_deps_invalid",
      journal: current ?? null,
    };
  }
  try {
    await persist(proposed);
  } catch (error) {
    return {
      ok: false,
      reason: "journal_persist_failed",
      error: String(error?.message || error),
      journal: current,
    };
  }
  if (typeof onDurableSuccess === "function") {
    onDurableSuccess(proposed);
  }
  return { ok: true, journal: proposed };
}

/**
 * Exact server-observed proof against local OUTCOME_UNKNOWN journal.
 * 0 or >1 matches fail closed. Never returns message/credential/principal.
 */
export function findExactObservedEvent(events, journal) {
  if (!journal || journal.state !== "OUTCOME_UNKNOWN") {
    return { ok: false, reason: "journal_not_outcome_unknown" };
  }
  if (!journal.eventId || !journal.attemptId) {
    return { ok: false, reason: "journal_identity_missing" };
  }
  if (!Array.isArray(events)) {
    return { ok: false, reason: "events_missing" };
  }
  const matches = events.filter(
    (event) =>
      event
      && event.status === "observed"
      && event.eventId === journal.eventId
      && event.attemptId === journal.attemptId,
  );
  if (matches.length === 0) {
    return { ok: false, reason: "observed_event_not_found" };
  }
  if (matches.length > 1) {
    return { ok: false, reason: "observed_event_ambiguous" };
  }
  const match = matches[0];
  return {
    ok: true,
    observed: {
      status: "observed",
      eventId: match.eventId,
      attemptId: match.attemptId,
    },
  };
}

/**
 * SW-only local closeout decision: OUTCOME_UNKNOWN + no inFlight + exact observed proof.
 * Fail closed on any mismatch. Zero DOM / ACK / Send implication.
 */
export function evaluateServerObservedCloseout(input) {
  const { journal, inFlight, serverObserved } = input || {};
  if (!journal || journal.state !== "OUTCOME_UNKNOWN") {
    return { ok: false, reason: "journal_not_outcome_unknown" };
  }
  if (inFlight) {
    return { ok: false, reason: "inflight_present" };
  }
  if (!serverObserved || typeof serverObserved !== "object") {
    return { ok: false, reason: "server_observed_missing" };
  }
  if (
    serverObserved.status !== "observed"
    || serverObserved.eventId !== journal.eventId
    || serverObserved.attemptId !== journal.attemptId
  ) {
    return { ok: false, reason: "server_observed_mismatch" };
  }
  return { ok: true, action: "server_observed_clear" };
}
