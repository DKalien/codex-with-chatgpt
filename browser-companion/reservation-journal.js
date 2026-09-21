/**
 * Pure reservation / send eligibility gates + durable journal reducer (E1b2 + E1b3a review-fix).
 * Browser-safe; no Chrome APIs; no DOM mutation; no native Send; no beginSend network call.
 *
 * E1b3a adds SEND-side durable fences only. Orchestration (SW/CS) must NOT call
 * beginSend / ack / composer write / Send click in this phase.
 */

export const EVIDENCE_MAX_AGE_MS = 12_000;

export const JOURNAL_STATES = /** @type {const} */ ([
  "NONE",
  "RESERVE_REQUESTED",
  "RESERVED",
  "RESERVATION_RECOVERY",
  "SEND_INTENT",
  "CLAIMED",
  "COMPOSER_WRITE_INTENT",
  "SEND_DISPATCH_INTENT",
  "OBSERVED_PENDING_ACK",
  "OUTCOME_UNKNOWN",
]);

/** States that mean "may still affect delivery / must not auto-resend". */
export const SEND_SIDE_STATES = new Set([
  "SEND_INTENT",
  "CLAIMED",
  "COMPOSER_WRITE_INTENT",
  "SEND_DISPATCH_INTENT",
  "OBSERVED_PENDING_ACK",
  "OUTCOME_UNKNOWN",
]);

/** Once journal reaches COMPOSER_WRITE_INTENT or later, recovery must not offer DOM/Send actions. */
export const POST_MUTATION_FENCE_STATES = new Set([
  "COMPOSER_WRITE_INTENT",
  "SEND_DISPATCH_INTENT",
  "OBSERVED_PENDING_ACK",
  "OUTCOME_UNKNOWN",
]);

/** States that require claimed attempt identity (attemptId + message + hash). */
const CLAIMED_SHAPE_STATES = new Set([
  "CLAIMED",
  "COMPOSER_WRITE_INTENT",
  "SEND_DISPATCH_INTENT",
  "OBSERVED_PENDING_ACK",
  "OUTCOME_UNKNOWN",
]);

const HEX64 = /^[a-f0-9]{64}$/i;
const HEX32 = /^[a-f0-9]{32}$/i;

/**
 * Allowed from → to transitions. Reverse / illegal moves fail closed.
 * NONE may only enter via RESERVE_REQUESTED (or explicit hydrateJournal).
 * RESERVED cannot re-enter RESERVATION_RECOVERY (identity would become mutable).
 * RESERVATION_RECOVERY only from RESERVE_REQUESTED; then recover to RESERVED.
 */
const ALLOWED_TRANSITIONS = {
  NONE: new Set(["RESERVE_REQUESTED"]),
  RESERVE_REQUESTED: new Set(["RESERVED", "RESERVATION_RECOVERY", "NONE"]),
  RESERVED: new Set(["SEND_INTENT", "NONE"]),
  RESERVATION_RECOVERY: new Set(["RESERVED", "NONE"]),
  SEND_INTENT: new Set(["CLAIMED", "OUTCOME_UNKNOWN", "SEND_INTENT", "NONE"]),
  CLAIMED: new Set([
    "COMPOSER_WRITE_INTENT",
    "OUTCOME_UNKNOWN",
    "OBSERVED_PENDING_ACK",
    "CLAIMED",
    "NONE",
  ]),
  COMPOSER_WRITE_INTENT: new Set([
    "SEND_DISPATCH_INTENT",
    "OBSERVED_PENDING_ACK",
    "OUTCOME_UNKNOWN",
    "NONE",
  ]),
  SEND_DISPATCH_INTENT: new Set(["OBSERVED_PENDING_ACK", "OUTCOME_UNKNOWN", "NONE"]),
  OBSERVED_PENDING_ACK: new Set(["NONE", "OUTCOME_UNKNOWN"]),
  // Late-positive only: never resend / CLAIMED / SEND_DISPATCH. Ordinary mark* stay closed.
  OUTCOME_UNKNOWN: new Set(["OBSERVED_PENDING_ACK"]),
};

/** @returns {{ state: string, eventId: string|null, reservationId: string|null, attemptId: string|null, routeCanonical: string|null, bindingId: string|null, epoch: number|null, message: string|null, messageSha256: string|null, createdAt: string|null, updatedAt: string|null }} */
export function emptyJournal() {
  return {
    state: "NONE",
    eventId: null,
    reservationId: null,
    attemptId: null,
    routeCanonical: null,
    bindingId: null,
    epoch: null,
    message: null,
    messageSha256: null,
    createdAt: null,
    updatedAt: null,
  };
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {object} journal
 * @param {object} patch
 */
export function patchJournal(journal, patch) {
  return { ...journal, ...patch, updatedAt: nowIso() };
}

function requireTransition(fromState, toState) {
  if (!isLegalJournalTransition(fromState, toState)) {
    const err = new Error(`illegal journal transition: ${fromState} → ${toState}`);
    err.code = "JOURNAL_TRANSITION_ILLEGAL";
    throw err;
  }
}

/** Pure legality check for CAS commit validation (E1b3d3b). */
export function isLegalJournalTransition(fromState, toState) {
  const allowed = ALLOWED_TRANSITIONS[fromState];
  return Boolean(allowed && allowed.has(toState));
}

function transitionJournal(journal, toState, patch) {
  const from = journal?.state ?? "NONE";
  // No NONE hydrate bypass: only legal transitions (or explicit hydrateJournal).
  requireTransition(from, toState);
  const next = patchJournal(journal, {
    ...patch,
    state: toState,
    createdAt: journal.createdAt ?? nowIso(),
  });
  return assertShape(next);
}

/**
 * Pure shape validation. Unknown state / missing required fields fail closed.
 * @param {object} journal
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateSendJournalShape(journal) {
  if (!journal || typeof journal !== "object") {
    return { ok: false, reason: "journal_missing" };
  }
  if (!JOURNAL_STATES.includes(journal.state)) {
    return { ok: false, reason: "unknown_state" };
  }
  if (journal.state === "NONE") {
    return { ok: true };
  }
  if (journal.state === "RESERVE_REQUESTED" || journal.state === "RESERVATION_RECOVERY") {
    if (!journal.routeCanonical || journal.bindingId == null || journal.epoch == null) {
      return { ok: false, reason: "pre_send_identity_missing" };
    }
    return { ok: true };
  }
  if (!journal.eventId || !HEX32.test(journal.eventId)) {
    return { ok: false, reason: "event_id_invalid" };
  }
  if (!journal.reservationId) {
    return { ok: false, reason: "reservation_id_missing" };
  }
  if (!journal.routeCanonical || !journal.bindingId || journal.epoch == null) {
    return { ok: false, reason: "transport_identity_missing" };
  }
  if (journal.state === "RESERVED" || journal.state === "SEND_INTENT") {
    return { ok: true };
  }
  if (CLAIMED_SHAPE_STATES.has(journal.state)) {
    if (!journal.attemptId) {
      return { ok: false, reason: "attempt_id_missing" };
    }
    if (typeof journal.message !== "string" || journal.message.length === 0) {
      return { ok: false, reason: "message_missing" };
    }
    if (typeof journal.messageSha256 !== "string" || !HEX64.test(journal.messageSha256)) {
      return { ok: false, reason: "message_sha256_invalid" };
    }
    return { ok: true };
  }
  return { ok: false, reason: "unknown_state" };
}

function throwShapeError(reason) {
  const err = new Error(`invalid journal shape: ${reason}`);
  err.code = "JOURNAL_SHAPE_INVALID";
  err.reason = reason;
  throw err;
}

function assertShape(journal) {
  const result = validateSendJournalShape(journal);
  if (!result.ok) {
    throwShapeError(result.reason);
  }
  return journal;
}

/**
 * Explicit constructor for recovery hydration / tests.
 * Validates shape; does NOT go through mark* transition graph.
 */
export function hydrateJournal(fields) {
  const journal = {
    ...emptyJournal(),
    ...fields,
    createdAt: fields?.createdAt ?? nowIso(),
    updatedAt: fields?.updatedAt ?? nowIso(),
  };
  return assertShape(journal);
}

function throwIdentityError(field) {
  const err = new Error(`journal identity immutable: ${field}`);
  err.code = "JOURNAL_IDENTITY_MISMATCH";
  return err;
}

/** Assert optional input fields exact-match durable journal identity; never overwrite. */
function assertImmutableFields(journal, input, fields) {
  if (!input) return;
  for (const field of fields) {
    if (input[field] !== undefined && input[field] !== null && input[field] !== journal[field]) {
      throw throwIdentityError(field);
    }
  }
}

const RESERVATION_IDENTITY_FIELDS = [
  "eventId",
  "reservationId",
  "routeCanonical",
  "bindingId",
  "epoch",
];

const CLAIMED_IDENTITY_FIELDS = [
  ...RESERVATION_IDENTITY_FIELDS,
  "attemptId",
  "message",
  "messageSha256",
];

export function markReserveRequested(journal, input) {
  return transitionJournal(journal, "RESERVE_REQUESTED", {
    eventId: null,
    reservationId: null,
    attemptId: null,
    message: null,
    messageSha256: null,
    routeCanonical: input.routeCanonical,
    bindingId: input.bindingId,
    epoch: input.epoch,
  });
}

export function markReserved(journal, input) {
  const from = journal?.state ?? "NONE";
  if (from === "RESERVED") {
    assertImmutableFields(journal, input, RESERVATION_IDENTITY_FIELDS);
    return journal;
  }
  // RESERVATION_RECOVERY → RESERVED: first eventId/reservationId from server;
  // transport identity must inherit the original reserve request.
  if (from === "RESERVATION_RECOVERY") {
    assertImmutableFields(journal, input, ["routeCanonical", "bindingId", "epoch"]);
    return transitionJournal(journal, "RESERVED", {
      eventId: input.eventId,
      reservationId: input.reservationId,
      attemptId: null,
      message: null,
      messageSha256: null,
      routeCanonical: journal.routeCanonical,
      bindingId: journal.bindingId,
      epoch: journal.epoch,
    });
  }
  return transitionJournal(journal, "RESERVED", {
    eventId: input.eventId,
    reservationId: input.reservationId,
    attemptId: null,
    message: null,
    messageSha256: null,
    routeCanonical: input.routeCanonical ?? journal.routeCanonical,
    bindingId: input.bindingId ?? journal.bindingId,
    epoch: input.epoch ?? journal.epoch,
  });
}

/** Only from RESERVE_REQUESTED (uncertain /reserve response). Transport identity immutable. */
export function markReservationRecovery(journal, input) {
  assertImmutableFields(journal, input, ["routeCanonical", "bindingId", "epoch"]);
  return transitionJournal(journal, "RESERVATION_RECOVERY", {
    routeCanonical: journal.routeCanonical,
    bindingId: journal.bindingId,
    epoch: journal.epoch,
  });
}

/** Durable fence: ready to call beginSend. From RESERVED (or retry SEND_INTENT). */
export function markSendIntent(journal, input) {
  const from = journal?.state ?? "NONE";
  // From RESERVED: inherit identity; optional input must exact-match if present.
  if (from === "RESERVED") {
    assertImmutableFields(journal, input, RESERVATION_IDENTITY_FIELDS);
    return transitionJournal(journal, "SEND_INTENT", {
      eventId: journal.eventId,
      reservationId: journal.reservationId,
      attemptId: null,
      message: null,
      messageSha256: null,
      routeCanonical: journal.routeCanonical,
      bindingId: journal.bindingId,
      epoch: journal.epoch,
    });
  }
  // Idempotent retry: never overwrite durable identity.
  if (from === "SEND_INTENT") {
    assertImmutableFields(journal, input, RESERVATION_IDENTITY_FIELDS);
    return journal;
  }
  return transitionJournal(journal, "SEND_INTENT", {
    eventId: input.eventId,
    reservationId: input.reservationId,
    attemptId: null,
    message: null,
    messageSha256: null,
    routeCanonical: input.routeCanonical ?? journal.routeCanonical,
    bindingId: input.bindingId ?? journal.bindingId,
    epoch: input.epoch ?? journal.epoch,
  });
}

/** Durable: server claimed + attemptId/message persisted locally. No DOM mutation yet. */
export function markClaimed(journal, input) {
  const from = journal?.state ?? "NONE";
  // Idempotent CLAIMED: same attempt only; reservation/message/hash must also match.
  if (from === "CLAIMED") {
    assertImmutableFields(journal, input, CLAIMED_IDENTITY_FIELDS);
    if (input.eventId !== journal.eventId || input.attemptId !== journal.attemptId) {
      throw throwIdentityError("attemptId");
    }
    return journal;
  }
  // SEND_INTENT → CLAIMED: exact event+reservation; transport identity inherited.
  if (from === "SEND_INTENT") {
    if (input.eventId !== journal.eventId || input.reservationId !== journal.reservationId) {
      throw throwIdentityError(input.eventId !== journal.eventId ? "eventId" : "reservationId");
    }
    assertImmutableFields(journal, input, ["routeCanonical", "bindingId", "epoch"]);
    return transitionJournal(journal, "CLAIMED", {
      eventId: journal.eventId,
      reservationId: journal.reservationId,
      routeCanonical: journal.routeCanonical,
      bindingId: journal.bindingId,
      epoch: journal.epoch,
      attemptId: input.attemptId,
      message: input.message ?? null,
      messageSha256: input.messageSha256 ?? null,
    });
  }
  return transitionJournal(journal, "CLAIMED", {
    eventId: input.eventId,
    reservationId: input.reservationId ?? journal.reservationId,
    attemptId: input.attemptId,
    message: input.message ?? null,
    messageSha256: input.messageSha256 ?? null,
    routeCanonical: input.routeCanonical ?? journal.routeCanonical,
    bindingId: input.bindingId ?? journal.bindingId,
    epoch: input.epoch ?? journal.epoch,
  });
}

/** Durable fence immediately before composer text mutation. Identity immutable. */
export function markComposerWriteIntent(journal, input) {
  assertImmutableFields(journal, input, CLAIMED_IDENTITY_FIELDS);
  return transitionJournal(journal, "COMPOSER_WRITE_INTENT", {});
}

/** Durable fence immediately before native Send click. Identity immutable. */
export function markSendDispatchIntent(journal, input) {
  assertImmutableFields(journal, input, CLAIMED_IDENTITY_FIELDS);
  return transitionJournal(journal, "SEND_DISPATCH_INTENT", {});
}

/** Reliable user-turn observation exists; only ACK/recovery allowed — no Send. */
export function markObservedPendingAck(journal, input) {
  if ((journal?.state ?? "NONE") === "OUTCOME_UNKNOWN") {
    const err = new Error("illegal journal transition: OUTCOME_UNKNOWN → OBSERVED_PENDING_ACK via markObservedPendingAck");
    err.code = "JOURNAL_TRANSITION_ILLEGAL";
    throw err;
  }
  assertImmutableFields(journal, input, CLAIMED_IDENTITY_FIELDS);
  return transitionJournal(journal, "OBSERVED_PENDING_ACK", {});
}

/**
 * Late-positive observe only: OUTCOME_UNKNOWN → OBSERVED_PENDING_ACK.
 * Requires exact durable identity; never opens resend / claimed / dispatch.
 */
export function markLateObservedPendingAck(journal, input) {
  const from = journal?.state ?? "NONE";
  if (from !== "OUTCOME_UNKNOWN") {
    const err = new Error(`late-positive observe requires OUTCOME_UNKNOWN, got ${from}`);
    err.code = "JOURNAL_TRANSITION_ILLEGAL";
    throw err;
  }
  assertImmutableFields(journal, input, CLAIMED_IDENTITY_FIELDS);
  return transitionJournal(journal, "OBSERVED_PENDING_ACK", {});
}

/**
 * Fail closed. Allowed from send-side states only.
 * Never returns to a resendable state. Never overwrites durable identity.
 */
export function markOutcomeUnknown(journal, input) {
  const from = journal?.state ?? "NONE";
  if (from === "OUTCOME_UNKNOWN") {
    assertImmutableFields(journal, input, CLAIMED_IDENTITY_FIELDS);
    return journal;
  }
  if (from !== "NONE" && !SEND_SIDE_STATES.has(from)) {
    requireTransition(from, "OUTCOME_UNKNOWN");
  }
  // SEND_INTENT may first adopt attempt/message/hash from server; CLAIMED+ must exact-match.
  if (CLAIMED_SHAPE_STATES.has(from)) {
    assertImmutableFields(journal, input, CLAIMED_IDENTITY_FIELDS);
  } else {
    assertImmutableFields(journal, input, ["eventId", "reservationId", "routeCanonical", "bindingId", "epoch"]);
  }
  const next = patchJournal(journal, {
    state: "OUTCOME_UNKNOWN",
    // Only fill attempt/message/hash when local journal does not already hold them.
    ...(input?.attemptId && !journal.attemptId ? { attemptId: input.attemptId } : {}),
    ...(input?.message !== undefined && journal.message == null
      ? { message: input.message }
      : {}),
    ...(input?.messageSha256 !== undefined && journal.messageSha256 == null
      ? { messageSha256: input.messageSha256 }
      : {}),
  });
  return assertShape(next);
}

/**
 * Explicit clear only after server-authoritative success (release / observed).
 * Does NOT silently clear illegal transitions.
 */
export function clearJournal() {
  return emptyJournal();
}

export function journalActive(journal) {
  return Boolean(journal && journal.state && journal.state !== "NONE");
}

export function journalIsSendSide(journal) {
  return Boolean(journal && SEND_SIDE_STATES.has(journal.state));
}

export function journalInPostMutationFence(journal) {
  return Boolean(journal && POST_MUTATION_FENCE_STATES.has(journal.state));
}

/**
 * Reserve eligibility: paired + exact owner + fresh safe DOM evidence.
 * @param {object} input
 */
export function evaluateReserveEligibility(input) {
  const {
    transportValid,
    authStale = false,
    isOwner,
    ownerRoute,
    pairedRoute,
    documentId,
    evidence,
    now = Date.now(),
    maxAgeMs = EVIDENCE_MAX_AGE_MS,
    journal,
  } = input;

  if (authStale || !transportValid) {
    return { ok: false, reason: "transport_invalid" };
  }
  if (journalActive(journal)) {
    return { ok: false, reason: "journal_active" };
  }
  if (!isOwner) return { ok: false, reason: "not_owner" };
  if (!documentId) return { ok: false, reason: "document_id_unavailable" };
  if (!ownerRoute || !pairedRoute || !areChatgptConversationRoutesEquivalent(ownerRoute, pairedRoute)) {
    return { ok: false, reason: "route_mismatch" };
  }
  if (!evidence || typeof evidence.observedAt !== "number") {
    return { ok: false, reason: "evidence_missing" };
  }
  if (evidence.documentId !== documentId) {
    return { ok: false, reason: "evidence_document_mismatch" };
  }
  if (!areChatgptConversationRoutesEquivalent(evidence.canonicalRoute, ownerRoute)) {
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
  return { ok: true, routeCanonical: ownerRoute };
}

import { areChatgptConversationRoutesEquivalent } from "./route-esm.js";

/** Validate authenticated /state identity vs persisted transport. */
export function validateStateIdentity(persisted, body) {
  if (!persisted || !body) return { ok: false, reason: "identity_missing" };
  const keys = ["workspaceId", "bindingId", "epoch", "companionId", "routeCanonical"];
  for (const key of keys) {
    if (key === "routeCanonical") continue;
    if (persisted[key] !== body[key]) {
      return { ok: false, reason: `identity_mismatch:${key}` };
    }
  }
  if (!areChatgptConversationRoutesEquivalent(persisted.routeCanonical, body.routeCanonical)) {
    return { ok: false, reason: "identity_mismatch:routeCanonical" };
  }
  return { ok: true };
}

/** Forbidden fields must never appear in companion API responses. */
export function assertNoForbiddenFields(obj, path = "") {
  const forbidden = new Set([
    "principalFingerprint",
    "reservedBy",
    "credentialHash",
    "secretHash",
    "openai/session",
  ]);
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => assertNoForbiddenFields(item, `${path}[${i}]`));
    return;
  }
  for (const [key, value] of Object.entries(obj)) {
    if (forbidden.has(key)) {
      throw new Error(`forbidden field: ${path}${key}`);
    }
    assertNoForbiddenFields(value, `${path}${key}.`);
  }
}

/**
 * Reconcile local journal against authenticated /state.inFlight.
 * RESERVED + server no inFlight => clear (server authoritative).
 * RESERVED + same eventId/reservationId => keep.
 * RESERVED + different/claimed inFlight => conflict (keep journal).
 */
export function reconcileReservedJournal(journal, inFlight) {
  if (!journal || journal.state !== "RESERVED") {
    return { action: "noop", journal };
  }
  if (!inFlight) {
    return { action: "clear", journal: emptyJournal() };
  }
  if (
    inFlight.status === "reserved"
    && inFlight.eventId === journal.eventId
    && inFlight.reservationId === journal.reservationId
  ) {
    return { action: "keep", journal };
  }
  return { action: "conflict", journal, reason: "inflight_mismatch" };
}

/** Exact eventId + reservationId. Missing reservationId is never a wildcard. */
function exactEventReservation(journal, inFlight) {
  return Boolean(
    inFlight
    && journal
    && journal.eventId
    && journal.reservationId
    && inFlight.eventId === journal.eventId
    && inFlight.reservationId === journal.reservationId,
  );
}

/** Exact event + reservation + attempt. */
function exactAttemptIdentity(journal, inFlight) {
  return Boolean(
    exactEventReservation(journal, inFlight)
    && journal.attemptId
    && inFlight.attemptId === journal.attemptId,
  );
}

function adoptClaimedFromServer(journal, inFlight) {
  if (!exactEventReservation(journal, inFlight) || !inFlight.attemptId) {
    const err = new Error("adopt claimed requires exact event+reservation+attempt");
    err.code = "JOURNAL_IDENTITY_MISMATCH";
    throw err;
  }
  // CLAIMED already holds durable message/hash: server must match exactly.
  if (journal.message != null || journal.messageSha256 != null) {
    if (inFlight.message !== undefined && inFlight.message !== journal.message) {
      throw throwIdentityError("message");
    }
    if (inFlight.messageSha256 !== undefined && inFlight.messageSha256 !== journal.messageSha256) {
      throw throwIdentityError("messageSha256");
    }
  }
  return markClaimed(journal, {
    eventId: journal.eventId,
    reservationId: journal.reservationId,
    routeCanonical: journal.routeCanonical,
    bindingId: journal.bindingId,
    epoch: journal.epoch,
    attemptId: inFlight.attemptId,
    message: inFlight.message ?? journal.message ?? null,
    messageSha256: inFlight.messageSha256 ?? journal.messageSha256 ?? null,
  });
}

function adoptOutcomeUnknownFromServer(journal, inFlight) {
  if (journal.attemptId && inFlight.attemptId && inFlight.attemptId !== journal.attemptId) {
    const err = new Error("outcome_unknown attemptId mismatch");
    err.code = "JOURNAL_ATTEMPT_MISMATCH";
    throw err;
  }
  if (
    journal.message != null
    && inFlight.message !== undefined
    && inFlight.message !== journal.message
  ) {
    throw throwIdentityError("message");
  }
  if (
    journal.messageSha256 != null
    && inFlight.messageSha256 !== undefined
    && inFlight.messageSha256 !== journal.messageSha256
  ) {
    throw throwIdentityError("messageSha256");
  }
  if (!exactEventReservation(journal, inFlight)) {
    throw throwIdentityError("reservationId");
  }
  return markOutcomeUnknown(journal, {
    attemptId: inFlight.attemptId && !journal.attemptId
      ? inFlight.attemptId
      : journal.attemptId,
    message: journal.message ?? inFlight.message ?? null,
    messageSha256: journal.messageSha256 ?? inFlight.messageSha256 ?? null,
  });
}

function safeAdopt(journal, fn, action, reason) {
  try {
    return { action, journal: fn() };
  } catch (error) {
    return {
      action: "conflict",
      journal,
      reason: error?.code || reason || "adopt_failed",
    };
  }
}

/**
 * Pure durable send-journal recovery against authenticated /state.inFlight.
 *
 * Core invariant: once journal reaches COMPOSER_WRITE_INTENT or later,
 * recovery must NEVER return an action that could cause a second DOM mutation / native Send.
 *
 * Actions:
 * - noop | keep | clear | retry_begin_send | adopt_claimed | adopt_outcome_unknown
 * | retry_ack | block | conflict
 */
export function reconcileSendJournal(journal, inFlight) {
  if (!journal || !journal.state || journal.state === "NONE") {
    return { action: "noop", journal };
  }

  // Malformed / unknown durable state: fail closed, never send-side actions.
  const shape = validateSendJournalShape(journal);
  if (!shape.ok) {
    return { action: "conflict", journal, reason: `journal_shape_invalid:${shape.reason}` };
  }

  // Pre-send reservation states keep the E1b2 contract.
  if (
    journal.state === "RESERVED"
    || journal.state === "RESERVE_REQUESTED"
    || journal.state === "RESERVATION_RECOVERY"
  ) {
    if (journal.state === "RESERVED") {
      return reconcileReservedJournal(journal, inFlight);
    }
    if (journal.state === "RESERVATION_RECOVERY" && !inFlight) {
      return { action: "clear", journal: emptyJournal() };
    }
    return { action: "keep", journal };
  }

  if (journal.state === "OUTCOME_UNKNOWN") {
    return { action: "block", journal, reason: "outcome_unknown" };
  }

  if (journal.state === "OBSERVED_PENDING_ACK") {
    // Real contract: server ACK success → observed → inFlight === null.
    // Local journal already holds exact eventId+attemptId; companion ACK is idempotent.
    // retry_ack never causes DOM mutation / native Send.
    if (!inFlight) {
      return { action: "retry_ack", journal };
    }
    if (inFlight.status === "observed") {
      // Real API rarely exposes observed inFlight; if present, require exact identity.
      if (!exactAttemptIdentity(journal, inFlight)) {
        return { action: "conflict", journal, reason: "observed_identity_mismatch" };
      }
      return { action: "clear", journal: emptyJournal() };
    }
    if (exactAttemptIdentity(journal, inFlight)) {
      return { action: "retry_ack", journal };
    }
    return { action: "conflict", journal, reason: "observed_ack_identity_mismatch" };
  }

  // COMPOSER_WRITE_INTENT / SEND_DISPATCH_INTENT: may have already mutated DOM.
  if (journalInPostMutationFence(journal)) {
    if (inFlight && inFlight.status === "outcome_unknown") {
      if (!exactAttemptIdentity(journal, inFlight)) {
        return { action: "conflict", journal, reason: "post_mutation_attempt_mismatch" };
      }
      return safeAdopt(
        journal,
        () => adoptOutcomeUnknownFromServer(journal, inFlight),
        "adopt_outcome_unknown",
      );
    }
    if (inFlight && inFlight.status === "observed") {
      if (!exactAttemptIdentity(journal, inFlight)) {
        return { action: "conflict", journal, reason: "post_mutation_attempt_mismatch" };
      }
      return { action: "clear", journal: emptyJournal() };
    }
    return { action: "block", journal, reason: "post_mutation_fence" };
  }

  if (journal.state === "SEND_INTENT") {
    if (!inFlight) {
      return { action: "clear", journal: emptyJournal() };
    }
    // Missing reservationId is never a wildcard.
    if (!exactEventReservation(journal, inFlight)) {
      return { action: "conflict", journal, reason: "inflight_identity_mismatch" };
    }
    if (inFlight.status === "reserved") {
      return { action: "retry_begin_send", journal };
    }
    if (inFlight.status === "claimed" && inFlight.attemptId) {
      return safeAdopt(
        journal,
        () => adoptClaimedFromServer(journal, inFlight),
        "adopt_claimed",
      );
    }
    if (inFlight.status === "outcome_unknown") {
      return safeAdopt(
        journal,
        () => adoptOutcomeUnknownFromServer(journal, inFlight),
        "adopt_outcome_unknown",
      );
    }
    return { action: "conflict", journal, reason: "inflight_mismatch" };
  }

  if (journal.state === "CLAIMED") {
    if (!inFlight) {
      return { action: "conflict", journal, reason: "claimed_without_server_inflight" };
    }
    if (!exactEventReservation(journal, inFlight)) {
      return { action: "conflict", journal, reason: "claimed_identity_mismatch" };
    }
    if (inFlight.status === "outcome_unknown") {
      if (!exactAttemptIdentity(journal, inFlight)) {
        return { action: "conflict", journal, reason: "outcome_unknown_attempt_mismatch" };
      }
      return safeAdopt(
        journal,
        () => adoptOutcomeUnknownFromServer(journal, inFlight),
        "adopt_outcome_unknown",
      );
    }
    if (inFlight.status === "observed") {
      if (!exactAttemptIdentity(journal, inFlight)) {
        return { action: "conflict", journal, reason: "observed_attempt_mismatch" };
      }
      return { action: "clear", journal: emptyJournal() };
    }
    if (inFlight.status === "claimed" && exactAttemptIdentity(journal, inFlight)) {
      // Server-provided message/hash must match durable local canonical values.
      if (
        inFlight.message !== undefined
        && inFlight.message !== journal.message
      ) {
        return { action: "conflict", journal, reason: "claimed_message_mismatch" };
      }
      if (
        inFlight.messageSha256 !== undefined
        && inFlight.messageSha256 !== journal.messageSha256
      ) {
        return { action: "conflict", journal, reason: "claimed_message_sha_mismatch" };
      }
      return { action: "keep", journal };
    }
    return { action: "conflict", journal, reason: "claimed_identity_mismatch" };
  }

  return { action: "block", journal, reason: "unknown_state" };
}

/** Pair may proceed with active journal only when credential is explicitly stale. */
export function pairAllowedWithJournal(journal, authStale) {
  if (!journal || !journal.state || journal.state === "NONE") return true;
  return authStale === true;
}

/**
 * Normalize fetch Response for companion clients.
 * HTTP 2xx must be ok=true so 200 is never treated as failure.
 */
export function wrapFetchResponse(res, body) {
  if (!res || typeof res !== "object") {
    return { ok: false, status: 0, body: body ?? {} };
  }
  const status = Number.isFinite(res.status) ? res.status : 0;
  const ok = res.ok === true || (status >= 200 && status < 300);
  return { ok, status, body: body ?? {} };
}

/**
 * Hydrate policy for durable transport credential.
 * Fail-closed: without storage protection, credential must be absent on disk.
 */
export function applyStorageProtectionPolicy(storageProtected, storedTransport) {
  const hasStored = Boolean(storedTransport && typeof storedTransport.credential === "string");
  if (!storageProtected) {
    return {
      transport: null,
      mustDeleteStoredKey: hasStored,
    };
  }
  return {
    transport: hasStored
      ? { ...storedTransport, authStale: storedTransport.authStale === true }
      : null,
    mustDeleteStoredKey: false,
  };
}
