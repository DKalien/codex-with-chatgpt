import { areChatgptConversationRoutesEquivalent } from "./route-esm.js";

/**
 * E1b3d3b2 autonomous trigger policy + pure tick planner.
 * Browser-safe. No Chrome API, no DOM, no network, no credentials.
 * Default OFF. Never auto-retire / auto-resend.
 */

export const AUTONOMY_STORAGE_KEY = "c2c_companion_autonomy_v1";
export const AUTONOMY_PRODUCTION_COOLDOWN_MS = 30_000;

export const AUTONOMY_MODES = ["off", "shadow", "armed"];

const OPERATIONAL_STATES = [
  "ready",
  "waiting_owner",
  "auth_stale",
  "journal_recovery",
  "cooldown",
  "blocked_gate",
  "off",
];
const JOURNAL_PHASES = new Set([
  "NONE", "RESERVE_REQUESTED", "RESERVED", "RESERVATION_RECOVERY", "SEND_" + "INTENT",
  "CLAIMED", "COMPOSER_WRITE_INTENT", "SEND_" + "DISPATCH_" + "INTENT", "OBSERVED_PENDING_ACK", "OUTCOME_UNKNOWN",
]);
const OPERATIONAL_REASONS = new Set([
  "recovery_required", "journal_active", "journal_state_unknown", "auth_stale", "owner_unavailable",
  "storage_unprotected", "transport_missing", "policy_identity_mismatch", "heartbeat_stale",
  "production_cooldown", "production_send_in_flight", "autonomy_tick_in_flight", "mode_off",
  "transport_invalid", "owner_missing", "owner_route_mismatch", "evidence_missing",
  "evidence_document_mismatch", "evidence_route_mismatch", "evidence_unsafe", "evidence_stale",
  "send_probe_latch_active", "server_inflight_without_local_journal", "shadow_keep_reserved",
  "reserved_recover_mismatch", "heartbeat_sender_missing", "autonomy_persist_failed", "reserve_failed",
  "production_send_failed", "not_exact_owner_heartbeat", "state_fetch_failed", "autonomy_tick_error",
  "recover_failed", "outcome_unknown", "observed_identity_mismatch", "post_mutation_attempt_mismatch",
  "inflight_mismatch", "claimed_server_conflict", "server_outcome_unknown", "server_inflight_mismatch",
  "production_recover_rpc_failed", "network_unreachable", "ack_response_invalid", "journal_not_pending_ack",
  "journal_not_outcome_unknown", "retired_unknown", "unknown_state",
  "late_positive_identity_mismatch", "late_observed_persist_failed", "post_mutation_fence",
  "observed_ack_identity_mismatch", "inflight_identity_mismatch", "claim_proof_mint_failed",
  "server_observed_persist_failed", "adopt_claimed_failed", "adopt_outcome_unknown",
  "retry_begin_send_failed", "resume_claimed_failed", "begin_send_failed", "ack_failed",
  "observed_ack_persist_failed", "send_intent_persist_failed", "dispatch_intent_persist_failed",
  "write_intent_persist_failed", "send_click_threw", "send_ready_wait_threw", "verify_threw",
  "write_threw", "claimed_payload_validator_missing", "claimed_payload_validator_threw",
  "journal_not_claimed", "journal_not_send_intent", "journal_not_reserved", "journal_not_active",
  "claimed_attempt_mismatch", "claimed_inflight_mismatch", "claimed_identity_missing",
  "claimed_without_server_inflight", "server_observed_mismatch", "server_observed_missing",
  "server_outcome_unknown", "production_journal_not_cleared", "journal_persist_failed",
  "ack_proof_mismatch", "ack_proof_missing", "claim_proof_mismatch", "claim_proof_missing",
  "cas_input_missing", "cas_previous_mismatch", "illegal_transition", "inflight_present",
  "journal_identity_missing", "events_missing", "observed_event_not_found", "observed_event_ambiguous",
  "owner_document_invalid", "owner_generation_missing", "binding_mismatch", "composer_not_empty",
  "autonomy_rearm_persist_failed",
  "generation_not_idle", "journal_active", "journal_missing", "message_missing", "message_sha256_invalid",
  "not_owner", "document_id_unavailable", "pre_send_identity_missing", "reservation_id_missing",
  "attempt_id_missing", "transport_identity_missing", "claimed_message_mismatch", "claimed_message_sha_mismatch",
  "outcome_unknown_attempt_mismatch", "observed_attempt_mismatch", "claimed_identity_mismatch",
  "retry_ack", "ack_cleared", "late_positive_observed_then_acked", "ambiguous",
  "route_unverified",
]);
const OPERATIONAL_ACTIONS = new Set([
  "noop", "clear", "keep", "conflict", "block", "retry_ack", "server_observed_clear", "recover",
  "late_positive_observed_then_acked", "ack_cleared", "observed_then_acked", "resumed_claimed",
  "adopted_claimed_then_continue", "adopt_outcome_unknown", "retried_begin_send", "retry_begin_send",
  "ack_only", "fail_closed", "resume", "retry", "adopt_claimed", "adopt_claimed_failed",
  "retry_begin_send_failed", "resume_claimed_failed", "adopted_claimed_failed",
]);

function boundedReason(value, allowlist) {
  return typeof value === "string" && allowlist.has(value) ? value : null;
}

/** Pure, bounded operator diagnostic. Never an authorization decision. */
export function operationalHealthSummary(input = {}) {
  const policy = parseAutonomyPolicy(input.policy);
  const transport = input.transport && typeof input.transport === "object" ? input.transport : {};
  const journalProvided = input.journalState != null;
  const journalKnown = !journalProvided || JOURNAL_PHASES.has(input.journalState);
  const journalState = !journalProvided ? "NONE" : (journalKnown ? input.journalState : "UNKNOWN");
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const heartbeatAt = Number.isFinite(input.lastHeartbeatAt) ? input.lastHeartbeatAt : null;
  const heartbeatAgeMs = heartbeatAt == null ? null : Math.max(0, now - heartbeatAt);
  const heartbeatFreshness = heartbeatAgeMs == null ? "never" : heartbeatAgeMs <= 30_000 ? "fresh" : "stale";
  const tickAt = Number.isFinite(input.lastTickAt) ? input.lastTickAt : null;
  const tickAgeMs = tickAt == null ? null : Math.max(0, now - tickAt);
  const tickFreshness = tickAgeMs == null ? "never" : tickAgeMs <= 30_000 ? "fresh" : "stale";
  const productionSendInFlight = input.productionSendInFlight === true;
  const autonomyTickInFlight = input.autonomyTickInFlight === true;
  const identityExact = input.identityExact === true;
  const ownerAvailable = input.ownerAvailable === true;
  const storageProtected = input.storageProtected === true;
  const authStale = transport.authStale === true;
  const transportPresent = transport.connected === true || isTransportUsable(transport);
  const cooldownActive = policy.lastProductionAttemptAt != null
    && now - policy.lastProductionAttemptAt >= 0
    && now - policy.lastProductionAttemptAt < AUTONOMY_PRODUCTION_COOLDOWN_MS;
  let state = "ready";
  let reason = null;
  if (!journalKnown) {
    state = "blocked_gate";
    reason = "journal_state_unknown";
  } else if (journalState !== "NONE") {
    state = "journal_recovery";
    reason = journalState === "OUTCOME_UNKNOWN" || journalState === "OBSERVED_PENDING_ACK"
      ? "recovery_required" : "journal_active";
  } else if (policy.mode === "off") {
    state = "off";
  } else if (authStale) {
    state = "auth_stale";
    reason = "auth_stale";
  } else if (!ownerAvailable) {
    state = "waiting_owner";
    reason = "owner_unavailable";
  } else if (!storageProtected || !transportPresent || !identityExact || heartbeatFreshness !== "fresh") {
    state = "blocked_gate";
    reason = !storageProtected ? "storage_unprotected"
      : !transportPresent ? "transport_missing"
        : !identityExact ? "policy_identity_mismatch" : "heartbeat_stale";
  } else if (cooldownActive) {
    state = "cooldown";
    reason = "production_cooldown";
  } else if (productionSendInFlight || autonomyTickInFlight) {
    state = "blocked_gate";
    reason = productionSendInFlight ? "production_send_in_flight" : "autonomy_tick_in_flight";
  }
  return {
    state: OPERATIONAL_STATES.includes(state) ? state : "blocked_gate",
    mode: policy.mode,
    identityExact,
    ownerAvailable,
    storageProtected,
    transportPresent,
    authStale,
    journalPhase: journalState,
    productionSendInFlight,
    autonomyTickInFlight,
    heartbeatFreshness,
    heartbeatAgeMs: heartbeatAgeMs == null ? null : Math.min(heartbeatAgeMs, 86_400_000),
    tickFreshness,
    tickAgeMs: tickAgeMs == null ? null : Math.min(tickAgeMs, 86_400_000),
    lastDecision: boundedReason(input.lastDecision, new Set(AUTONOMY_DECISIONS)),
    lastReason: boundedReason(input.lastReason, OPERATIONAL_REASONS),
    lastRecoveryAction: boundedReason(input.lastRecoveryAction, OPERATIONAL_ACTIONS),
    lastRecoveryReason: boundedReason(input.lastRecoveryReason, OPERATIONAL_REASONS),
    cooldownActive,
    reason,
  };
}

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
    rearmOnConnect: false,
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
    rearmOnConnect: raw.rearmOnConnect === true,
  };
}

export function autonomySummary(policy, extra = {}) {
  const p = parseAutonomyPolicy(policy);
  return {
    mode: p.mode,
    rearmOnConnect: p.rearmOnConnect,
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
  if (!canonicalRoute || !areChatgptConversationRoutesEquivalent(canonicalRoute, owner.canonicalRoute)) return false;
  if (transportRoute != null && !areChatgptConversationRoutesEquivalent(canonicalRoute, transportRoute)) return false;
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
    && areChatgptConversationRoutesEquivalent(p.routeCanonical, transport.routeCanonical)
  );
}

/**
 * Any identity change forces OFF. Never carry armed policy across conversations.
 */
export function disarmOnIdentityChange(policy, transport) {
  const p = parseAutonomyPolicy(policy);
  if (p.mode === "off") return { policy: p, changed: false };
  const disarmed = () => ({
    ...emptyAutonomyPolicy(),
    lastProductionAttemptAt: p.lastProductionAttemptAt,
    rearmOnConnect: p.rearmOnConnect,
  });
  if (!transport) {
    return { policy: disarmed(), changed: true };
  }
  if (
    p.bindingId !== transport.bindingId
    || p.epoch !== transport.epoch
    || !areChatgptConversationRoutesEquivalent(p.routeCanonical, transport.routeCanonical)
  ) {
    return { policy: disarmed(), changed: true };
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
    routeVerified,
    now = Date.now(),
    maxEvidenceAgeMs = 12_000,
  } = input || {};

  if (mode !== "shadow" && mode !== "armed") return failGate("mode_off");
  if (storageProtected !== true) return failGate("storage_unprotected");
  if (!isTransportUsable(transport)) {
    return failGate("transport_invalid");
  }
  // Paired ≠ origin conversation route attested. Production reserve requires verified.
  if (routeVerified !== true) return failGate("route_unverified");
  if (!policyIdentityExact(policy, transport)) {
    return failGate("policy_identity_mismatch");
  }
  if (!owner || owner.documentId == null || owner.tabId == null) {
    return failGate("owner_missing");
  }
  if (!areChatgptConversationRoutesEquivalent(owner.canonicalRoute, transport.routeCanonical)) {
    return failGate("owner_route_mismatch");
  }
  if (!evidence) return failGate("evidence_missing");
  if (evidence.documentId !== owner.documentId) {
    return failGate("evidence_document_mismatch");
  }
  if (!areChatgptConversationRoutesEquivalent(evidence.canonicalRoute, transport.routeCanonical)) {
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
    routeVerified,
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
    routeVerified,
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
