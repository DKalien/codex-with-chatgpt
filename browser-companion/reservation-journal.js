/**
 * Pure reservation eligibility gates + durable journal reducer (E1b2).
 * Browser-safe; no Chrome APIs; no Send; no begin-send.
 */

export const EVIDENCE_MAX_AGE_MS = 12_000;

export const JOURNAL_STATES = /** @type {const} */ ([
  "NONE",
  "RESERVE_REQUESTED",
  "RESERVED",
  "RESERVATION_RECOVERY",
]);

/** @returns {{ state: string, eventId: string|null, reservationId: string|null, routeCanonical: string|null, bindingId: string|null, epoch: number|null, createdAt: string|null, updatedAt: string|null }} */
export function emptyJournal() {
  return {
    state: "NONE",
    eventId: null,
    reservationId: null,
    routeCanonical: null,
    bindingId: null,
    epoch: null,
    createdAt: null,
    updatedAt: null,
  };
}

/**
 * @param {object} journal
 * @param {object} patch
 */
export function patchJournal(journal, patch) {
  return { ...journal, ...patch, updatedAt: new Date().toISOString() };
}

export function markReserveRequested(journal, input) {
  return patchJournal(journal, {
    state: "RESERVE_REQUESTED",
    eventId: null,
    reservationId: null,
    routeCanonical: input.routeCanonical,
    bindingId: input.bindingId,
    epoch: input.epoch,
    createdAt: journal.createdAt ?? new Date().toISOString(),
  });
}

export function markReserved(journal, input) {
  return patchJournal(journal, {
    state: "RESERVED",
    eventId: input.eventId,
    reservationId: input.reservationId,
    routeCanonical: input.routeCanonical,
    bindingId: input.bindingId,
    epoch: input.epoch,
    createdAt: journal.createdAt ?? new Date().toISOString(),
  });
}

export function markReservationRecovery(journal, input) {
  return patchJournal(journal, {
    state: "RESERVATION_RECOVERY",
    routeCanonical: input?.routeCanonical ?? journal.routeCanonical,
    bindingId: input?.bindingId ?? journal.bindingId,
    epoch: input?.epoch ?? journal.epoch,
  });
}

export function clearJournal() {
  return emptyJournal();
}

export function journalActive(journal) {
  return journal && journal.state !== "NONE";
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
  if (!ownerRoute || !pairedRoute || ownerRoute !== pairedRoute) {
    return { ok: false, reason: "route_mismatch" };
  }
  if (!evidence || typeof evidence.observedAt !== "number") {
    return { ok: false, reason: "evidence_missing" };
  }
  if (evidence.documentId !== documentId) {
    return { ok: false, reason: "evidence_document_mismatch" };
  }
  if (evidence.canonicalRoute !== ownerRoute) {
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

/** Validate authenticated /state identity vs persisted transport. */
export function validateStateIdentity(persisted, body) {
  if (!persisted || !body) return { ok: false, reason: "identity_missing" };
  const keys = ["workspaceId", "bindingId", "epoch", "companionId", "routeCanonical"];
  for (const key of keys) {
    if (persisted[key] !== body[key]) {
      return { ok: false, reason: `identity_mismatch:${key}` };
    }
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


