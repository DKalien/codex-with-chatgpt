/**
 * E1b3d3b2 autonomous trigger policy + pure tick planner.
 * Browser-safe. No Chrome API, no DOM, no network, no credentials.
 * Default OFF. Never auto-retire / auto-resend.
 */

export const AUTONOMY_STORAGE_KEY = "c2c_companion_autonomy_v1";
export const AUTONOMY_PRODUCTION_COOLDOWN_MS = 30_000;

export const AUTONOMY_MODES = ["off", "shadow", "armed"];

/** Diagnostic only — not a security authority. */
export const AUTONOMY_DECISIONS = [
  "off",
  "shadow_idle",
  "would_reserve_and_send",
  "idle_no_ready",
  "cooldown",
  "recovering",
  "recovered",
  "production_started",
  "production_completed",
  "production_blocked",
  "gate_failed",
  "server_inflight_without_local_journal",
];

export function emptyAutonomyPolicy() {
  return {
    schemaVersion: 1,
    mode: "off",
    bindingId: null,
    epoch: null,
    routeCanonical: null,
    armedAt: null,
    lastProductionAttemptAt: null,
  };
}

export function parseAutonomyPolicy(raw) {
  if (!raw || typeof raw !== "object") return emptyAutonomyPolicy();
  const mode = AUTONOMY_MODES.includes(raw.mode) ? raw.mode : "off";
  return {
    schemaVersion: 1,
    mode,
    bindingId: typeof raw.bindingId === "string" ? raw.bindingId : null,
    epoch: Number.isFinite(raw.epoch) ? Number(raw.epoch) : null,
    routeCanonical: typeof raw.routeCanonical === "string" ? raw.routeCanonical : null,
    armedAt: Number.isFinite(raw.armedAt) ? Number(raw.armedAt) : null,
    lastProductionAttemptAt: Number.isFinite(raw.lastProductionAttemptAt)
      ? Number(raw.lastProductionAttemptAt)
      : null,
  };
}

export function autonomySummary(policy, extra = {}) {
  const p = parseAutonomyPolicy(policy);
  return {
    mode: p.mode,
    identityExact: extra.identityExact === true,
    tickInFlight: extra.tickInFlight === true,
    lastTickAt: Number.isFinite(extra.lastTickAt) ? extra.lastTickAt : null,
    lastDecision: typeof extra.lastDecision === "string" ? extra.lastDecision : null,
    lastReason: typeof extra.lastReason === "string" ? extra.lastReason : null,
    lastProductionAttemptAt: p.lastProductionAttemptAt,
    lastHeartbeatAt: Number.isFinite(extra.lastHeartbeatAt) ? extra.lastHeartbeatAt : null,
    lastHeartbeatOwnerExact: extra.lastHeartbeatOwnerExact === true,
    lastHeartbeatSafety: extra.lastHeartbeatSafety
      ? sanitizeHeartbeatSafetySnapshot(extra.lastHeartbeatSafety)
      : null,
    lastEvaluatedEvidence: extra.lastEvaluatedEvidence
      ? sanitizeEvaluatedEvidenceSnapshot(extra.lastEvaluatedEvidence)
      : null,
    lastRecoveryAt: Number.isFinite(extra.lastRecoveryAt) ? extra.lastRecoveryAt : null,
    lastRecoveryResult: extra.lastRecoveryResult
      ? sanitizeRecoveryResult(extra.lastRecoveryResult)
      : null,
  };
}

/**
 * Bounded observation diagnostic allowlist (same contract as send-orchestrator).
 * Never raw text / message / credential / principal / DOM.
 */
export function sanitizeRecoveryDiagnostic(diagnostic) {
  if (!diagnostic || typeof diagnostic !== "object") return null;
  const maxCandidates = 5;
  const repNumeric = [
    "markerCandidateIndex",
    "markerCandidateNormalizedLength",
    "markerInnerTextLength",
    "markerTextContentLength",
    "targetLineCount",
    "markerInnerTextLineCount",
    "markerTextContentLineCount",
    "innerLengthDelta",
    "textContentLengthDelta",
    "innerCommonPrefixLength",
    "innerCommonSuffixLength",
    "textCommonPrefixLength",
    "textCommonSuffixLength",
    "descendantScannedCount",
    "exactInnerTextDescendantCount",
    "exactTextContentDescendantCount",
    "attemptMarkerDescendantCount",
  ];
  const repBool = [
    "markerInnerTextExact",
    "markerTextContentExact",
    "markerInnerTextAttemptExact",
    "markerTextContentAttemptExact",
  ];
  const out = {};
  if (Number.isFinite(diagnostic.candidateCount)) out.candidateCount = diagnostic.candidateCount;
  if (Number.isFinite(diagnostic.exactTextMatchCount)) {
    out.exactTextMatchCount = diagnostic.exactTextMatchCount;
  }
  if (Number.isFinite(diagnostic.exactAttemptMarkerCount)) {
    out.exactAttemptMarkerCount = diagnostic.exactAttemptMarkerCount;
  }
  if (Number.isFinite(diagnostic.ambiguousCount)) out.ambiguousCount = diagnostic.ambiguousCount;
  if (Number.isFinite(diagnostic.targetLength)) out.targetLength = diagnostic.targetLength;
  if (Array.isArray(diagnostic.candidateLengths)) {
    out.candidateLengths = diagnostic.candidateLengths
      .slice(0, maxCandidates)
      .map((n) => (Number.isFinite(n) ? Number(n) : 0));
  }
  if (Number.isFinite(diagnostic.firstMismatchIndex)) {
    out.firstMismatchIndex = diagnostic.firstMismatchIndex;
  }
  if (Array.isArray(diagnostic.candidates)) {
    out.candidates = diagnostic.candidates.slice(0, maxCandidates).map((item) => ({
      directRole: typeof item?.directRole === "string" ? item.directRole : null,
      nestedUser: item?.nestedUser === true,
    }));
  }
  if (diagnostic.representation && typeof diagnostic.representation === "object") {
    const rep = {};
    for (const key of repNumeric) {
      if (Number.isFinite(diagnostic.representation[key])) rep[key] = diagnostic.representation[key];
    }
    for (const key of repBool) {
      if (typeof diagnostic.representation[key] === "boolean") rep[key] = diagnostic.representation[key];
    }
    if (Object.keys(rep).length) out.representation = rep;
  }
  return Object.keys(out).length ? out : null;
}

export function sanitizeRecoveryResult(input) {
  if (!input || typeof input !== "object") return null;
  return {
    ok: input.ok === true,
    reason: typeof input.reason === "string" ? input.reason : null,
    action: typeof input.action === "string" ? input.action : null,
    retryAck: input.retryAck === true,
    journalState: typeof input.journalState === "string" ? input.journalState : null,
    diagnostic: sanitizeRecoveryDiagnostic(input.diagnostic),
  };
}

/** Bounded heartbeat safety snapshot. Never reasons / DOM / message. */
export function sanitizeHeartbeatSafetySnapshot(safety) {
  if (!safety || typeof safety !== "object") return null;
  return {
    composer: typeof safety.composer === "string" ? safety.composer : null,
    generation: typeof safety.generation === "string" ? safety.generation : null,
    safe: safety.safe === true,
    routeValid: safety.routeValid === true,
    adapterSupported: safety.adapterSupported === true,
  };
}

/** Bounded planner evidence snapshot. Diagnostic only. */
export function sanitizeEvaluatedEvidenceSnapshot(input) {
  if (!input || typeof input !== "object") return null;
  return {
    composer: typeof input.composer === "string" ? input.composer : null,
    generation: typeof input.generation === "string" ? input.generation : null,
    safe: input.safe === true,
    observedAt: Number.isFinite(input.observedAt) ? input.observedAt : null,
    ageMs: Number.isFinite(input.ageMs) ? input.ageMs : null,
    documentExact: input.documentExact === true,
    routeExact: input.routeExact === true,
  };
}

export function buildHeartbeatSafetySnapshot(safety) {
  return sanitizeHeartbeatSafetySnapshot(safety) ?? {
    composer: null,
    generation: null,
    safe: false,
    routeValid: false,
    adapterSupported: false,
  };
}

export function buildEvaluatedEvidenceSnapshot(input = {}) {
  const { evidence, now = Date.now(), documentExact = false, routeExact = false } = input;
  if (!evidence || typeof evidence !== "object") {
    return {
      composer: null,
      generation: null,
      safe: false,
      observedAt: null,
      ageMs: null,
      documentExact: false,
      routeExact: false,
    };
  }
  const observedAt = Number.isFinite(evidence.observedAt) ? evidence.observedAt : null;
  const ageMs = observedAt != null && Number.isFinite(now) ? now - observedAt : null;
  return sanitizeEvaluatedEvidenceSnapshot({
    composer: evidence.composer,
    generation: evidence.generation,
    safe: evidence.safe,
    observedAt,
    ageMs,
    documentExact,
    routeExact,
  });
}

/**
 * Real SW internal transport shape (NOT presentation summary).
 * No `connected` boolean — that is popup-only.
 */
export function isTransportUsable(transport) {
  if (!transport || typeof transport !== "object") return false;
  if (transport.authStale === true) return false;
  if (typeof transport.bindingId !== "string" || transport.bindingId.length === 0) return false;
  if (!Number.isFinite(transport.epoch)) return false;
  if (typeof transport.routeCanonical !== "string" || transport.routeCanonical.length === 0) {
    return false;
  }
  return true;
}

/** Exact owner-document heartbeat. Foreign tab/document never schedules autonomy. */
export function isExactOwnerHeartbeat(input) {
  const {
    identityOk,
    tabId,
    documentId,
    canonicalRoute,
    owner,
    transportRoute,
  } = input || {};
  if (identityOk !== true) return false;
  if (!owner || owner.tabId == null || !owner.documentId) return false;
  if (tabId !== owner.tabId) return false;
  if (documentId !== owner.documentId) return false;
  if (!canonicalRoute || canonicalRoute !== owner.canonicalRoute) return false;
  if (transportRoute != null && canonicalRoute !== transportRoute) return false;
  return true;
}

export function policyIdentityExact(policy, transport) {
  const p = parseAutonomyPolicy(policy);
  if (p.mode === "off") return true;
  if (!p.bindingId || p.epoch == null || !p.routeCanonical) return false;
  if (!transport) return false;
  return (
    p.bindingId === transport.bindingId
    && p.epoch === transport.epoch
    && p.routeCanonical === transport.routeCanonical
  );
}

/**
 * Any identity change forces OFF. Never carry armed policy across conversations.
 */
export function disarmOnIdentityChange(policy, transport) {
  const p = parseAutonomyPolicy(policy);
  if (p.mode === "off") return { policy: p, changed: false };
  if (!transport) {
    return { policy: emptyAutonomyPolicy(), changed: true };
  }
  if (
    p.bindingId !== transport.bindingId
    || p.epoch !== transport.epoch
    || p.routeCanonical !== transport.routeCanonical
  ) {
    return { policy: emptyAutonomyPolicy(), changed: true };
  }
  return { policy: p, changed: false };
}

function failGate(reason) {
  return { ok: false, reason };
}

/**
 * Common hard gates for SHADOW / ARMED ticks.
 * Reuses production evidence + identity; never invents a looser gate.
 */
export function evaluateAutonomyGates(input) {
  const {
    mode,
    policy,
    storageProtected,
    transport,
    owner,
    evidence,
    journal,
    sendProbeLatch,
    productionSendInFlight,
    now = Date.now(),
    maxEvidenceAgeMs = 12_000,
  } = input || {};

  if (mode !== "shadow" && mode !== "armed") return failGate("mode_off");
  if (storageProtected !== true) return failGate("storage_unprotected");
  if (!isTransportUsable(transport)) {
    return failGate("transport_invalid");
  }
  if (!policyIdentityExact(policy, transport)) {
    return failGate("policy_identity_mismatch");
  }
  if (!owner || owner.documentId == null || owner.tabId == null) {
    return failGate("owner_missing");
  }
  if (owner.canonicalRoute !== transport.routeCanonical) {
    return failGate("owner_route_mismatch");
  }
  if (!evidence) return failGate("evidence_missing");
  if (evidence.documentId !== owner.documentId) {
    return failGate("evidence_document_mismatch");
  }
  if (evidence.canonicalRoute !== transport.routeCanonical) {
    return failGate("evidence_route_mismatch");
  }
  if (evidence.safe !== true || evidence.composer !== "empty" || evidence.generation !== "idle") {
    return failGate("evidence_unsafe");
  }
  const age = now - evidence.observedAt;
  if (!Number.isFinite(age) || age < 0 || age > maxEvidenceAgeMs) {
    return failGate("evidence_stale");
  }
  if (sendProbeLatch && sendProbeLatch !== "NONE" && sendProbeLatch.state !== "NONE") {
    return failGate("send_probe_latch_active");
  }
  if (productionSendInFlight === true) return failGate("production_send_in_flight");
  if (journal && journal.state && journal.state !== "NONE") {
    // Active journal is allowed — tick will recover, not reserve.
    return { ok: true, recovering: true };
  }
  return { ok: true, recovering: false };
}

/**
 * Pure planner. SW executes the returned decision; this never mutates.
 */
export function planAutonomyTick(state) {
  const {
    policy,
    storageProtected,
    transport,
    owner,
    evidence,
    journal,
    sendProbeLatch,
    productionSendInFlight,
    autonomyTickInFlight = false,
    inFlight = null,
    pendingReady = 0,
    now = Date.now(),
  } = state || {};

  const p = parseAutonomyPolicy(policy);
  if (p.mode === "off") {
    return { decision: "off", mode: "off", identityExact: true };
  }

  const identityExact = policyIdentityExact(p, transport);
  if (!identityExact) {
    return {
      decision: "gate_failed",
      mode: p.mode,
      identityExact: false,
      reason: "policy_identity_mismatch",
    };
  }

  if (autonomyTickInFlight) {
    return {
      decision: "gate_failed",
      mode: p.mode,
      identityExact: true,
      reason: "tick_in_flight",
    };
  }

  const journalState = journal?.state ?? "NONE";

  // Journal-first: recover existing durable state. Never reserve a second event.
  if (journalState !== "NONE") {
    if (storageProtected !== true) {
      return {
        decision: "gate_failed",
        mode: p.mode,
        identityExact: true,
        reason: "storage_unprotected",
      };
    }
    if (!isTransportUsable(transport)) {
      return {
        decision: "gate_failed",
        mode: p.mode,
        identityExact: true,
        reason: "transport_invalid",
      };
    }
    if (productionSendInFlight === true) {
      return {
        decision: "gate_failed",
        mode: p.mode,
        identityExact: true,
        reason: "production_send_in_flight",
      };
    }
    // Recovery may proceed without idle-empty composer (ACK/observe/closeout).
    // Cooldown never blocks continuation of an already-RESERVED event.
    return {
      decision: "recovering",
      mode: p.mode,
      identityExact: true,
      journalState,
    };
  }

  // NONE + server inFlight without local journal → fail closed.
  if (inFlight) {
    return {
      decision: "server_inflight_without_local_journal",
      mode: p.mode,
      identityExact: true,
      reason: "server_inflight_without_local_journal",
    };
  }

  const gates = evaluateAutonomyGates({
    mode: p.mode,
    policy: p,
    storageProtected,
    transport,
    owner,
    evidence,
    journal,
    sendProbeLatch,
    productionSendInFlight,
    now,
  });
  if (!gates.ok) {
    return {
      decision: "gate_failed",
      mode: p.mode,
      identityExact: true,
      reason: gates.reason,
    };
  }

  if (!Number.isFinite(pendingReady) || pendingReady <= 0) {
    return {
      decision: "idle_no_ready",
      mode: p.mode,
      identityExact: true,
    };
  }

  if (p.lastProductionAttemptAt != null
    && now - p.lastProductionAttemptAt < AUTONOMY_PRODUCTION_COOLDOWN_MS) {
    return {
      decision: "cooldown",
      mode: p.mode,
      identityExact: true,
      reason: "production_cooldown",
    };
  }

  if (p.mode === "shadow") {
    return {
      decision: "would_reserve_and_send",
      mode: "shadow",
      identityExact: true,
      pendingReady,
    };
  }

  return {
    decision: "would_reserve_and_send",
    mode: "armed",
    identityExact: true,
    pendingReady,
  };
}

export function withProductionAttemptStamp(policy, now = Date.now()) {
  const p = parseAutonomyPolicy(policy);
  return { ...p, lastProductionAttemptAt: now };
}
