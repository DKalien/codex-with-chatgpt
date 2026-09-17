/**
 * E1b3d3a explicit real Send probe contract (pure helpers).
 * Browser-safe. No DOM mutation, no Chrome API, no production journal.
 * Message template lives in send-probe-message.js (single source).
 */

export { SEND_PROBE_TOKEN, buildSendProbeMessage } from "./send-probe-message.js";
import { buildSendProbeMessage } from "./send-probe-message.js";

export const SEND_PROBE_LATCH_KEY = "c2c_send_probe_latch_v1";

/** Latch states: NONE | EXECUTION_INTENT | COMPLETED | OUTCOME_UNKNOWN */
export function emptySendProbeLatch() {
  return {
    state: "NONE",
    tabId: null,
    documentId: null,
    canonicalRoute: null,
    generation: null,
    attemptId: null,
    createdAt: null,
  };
}

export function parseSendProbeLatch(raw) {
  if (!raw || typeof raw !== "object") return emptySendProbeLatch();
  if (raw.state == null) return emptySendProbeLatch();
  const state = typeof raw.state === "string" ? raw.state : "__INVALID__";
  const known = new Set(["NONE", "EXECUTION_INTENT", "COMPLETED", "OUTCOME_UNKNOWN"]);
  if (state === "NONE") return emptySendProbeLatch();
  // Unknown/corrupt persisted state must fail closed — never treat as NONE.
  if (!known.has(state)) {
    return { ...emptySendProbeLatch(), state: "OUTCOME_UNKNOWN" };
  }
  return {
    state,
    tabId: typeof raw.tabId === "number" ? raw.tabId : null,
    documentId: typeof raw.documentId === "string" ? raw.documentId : null,
    canonicalRoute: typeof raw.canonicalRoute === "string" ? raw.canonicalRoute : null,
    generation: Number.isFinite(raw.generation) ? raw.generation : null,
    attemptId: typeof raw.attemptId === "string" ? raw.attemptId : null,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : null,
  };
}

/** Preconditions before EXECUTION_INTENT. */
export function canStartSendProbe({ owner, transport, journalIsNone, latch }) {
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
  if (journalIsNone !== true) {
    return { ok: false, reason: "send_probe_journal_active" };
  }
  const latchState = latch?.state ?? "NONE";
  if (latchState !== "NONE") {
    return { ok: false, reason: "send_probe_latch_active", latchState };
  }
  return { ok: true };
}

export function buildSendProbeExecuteRequest(owner, transport, attemptId) {
  if (!attemptId || typeof attemptId !== "string") {
    return { ok: false, reason: "send_probe_attempt_missing" };
  }
  // Always construct the fixed template internally — never accept caller message.
  const built = buildSendProbeMessage(attemptId);
  if (!built) return { ok: false, reason: "send_probe_message_missing" };
  return {
    ok: true,
    tabId: owner.tabId,
    message: {
      type: "c2c.send.probe.execute",
      expectedRoute: transport.routeCanonical,
      expectedGeneration: owner.generation,
      expectedDocumentId: owner.documentId,
      attemptId,
      probeMessage: built,
    },
    sendOptions: {
      documentId: owner.documentId,
    },
  };
}

/**
 * Exact COMPLETED contract. Every field must be proven by the CS response.
 * Inconsistent success DTO → unknown (never COMPLETED).
 */
export function validateSendProbeCompletedResponse(response, latch) {
  if (!response || typeof response !== "object") {
    return { ok: false, reason: "send_probe_response_invalid" };
  }
  if (response.mode !== "send_probe_real") {
    return { ok: false, reason: "send_probe_response_invalid" };
  }
  const requiredTrue = [
    "ok",
    "mutationAttempted",
    "wrote",
    "verified",
    "clickAttempted",
    "clicked",
    "observed",
  ];
  for (const k of requiredTrue) {
    if (response[k] !== true) {
      return { ok: false, reason: "send_probe_response_inconsistent" };
    }
  }
  if (!latch || typeof latch !== "object") {
    return { ok: false, reason: "send_probe_latch_invalid" };
  }
  if (response.attemptId !== latch.attemptId) {
    return { ok: false, reason: "send_probe_attempt_mismatch" };
  }
  if (response.canonicalRoute !== latch.canonicalRoute) {
    return { ok: false, reason: "send_probe_route_mismatch" };
  }
  if (
    !Number.isFinite(response.generation)
    || !Number.isFinite(latch.generation)
    || Number(response.generation) !== Number(latch.generation)
  ) {
    return { ok: false, reason: "send_probe_generation_mismatch" };
  }
  return { ok: true };
}

/**
 * After mutation RPC: classify completion vs outcome unknown vs known failure.
 * COMPLETED only when validateSendProbeCompletedResponse fully succeeds.
 * Pre-mutation only if both mutationAttempted and clickAttempted are strictly false.
 */
export function classifySendProbeRpcResult(response, latch) {
  if (response == null || typeof response !== "object") {
    return { outcome: "unknown", reason: "send_probe_outcome_unknown" };
  }
  if (response.mode !== "send_probe_real") {
    return { outcome: "unknown", reason: "send_probe_response_invalid" };
  }
  const completed = validateSendProbeCompletedResponse(response, latch);
  if (completed.ok) {
    return { outcome: "completed" };
  }
  const mutationAttempted = response.mutationAttempted === true;
  const clickAttempted = response.clickAttempted === true;
  if (!mutationAttempted && !clickAttempted) {
    return { outcome: "pre_mutation", reason: response.reason || completed.reason || "send_probe_failed" };
  }
  // Mutation/click may have happened — never treat partial success as COMPLETED.
  return {
    outcome: "unknown",
    reason: response.reason || completed.reason || "send_probe_outcome_unknown",
    mutationAttempted,
    clickAttempted,
  };
}

/**
 * Durable EXECUTION_INTENT then mutation RPC. Persist failure → zero RPC.
 * @param {{
 *   intentLatch: object,
 *   persistLatch: (latch: object) => Promise<boolean>,
 *   invokeRpc: () => Promise<object|null>,
 * }} deps
 */
export async function executeSendProbeMutationRpc(deps) {
  const intentLatch = deps?.intentLatch;
  const persistLatch = deps?.persistLatch;
  const invokeRpc = deps?.invokeRpc;
  if (!intentLatch || typeof persistLatch !== "function" || typeof invokeRpc !== "function") {
    return { ok: false, reason: "send_probe_deps_invalid", mutationAttempted: false, clickAttempted: false };
  }
  let persisted = false;
  try {
    persisted = await persistLatch(intentLatch);
  } catch {
    persisted = false;
  }
  if (!persisted) {
    return {
      ok: false,
      reason: "send_probe_latch_persist_failed",
      mutationAttempted: false,
      clickAttempted: false,
      persisted: false,
    };
  }
  let response;
  let rpcThrew = false;
  try {
    response = await invokeRpc();
  } catch {
    rpcThrew = true;
    response = null;
  }
  if (rpcThrew || response == null) {
    return {
      ok: false,
      reason: "send_probe_outcome_unknown",
      mutationAttempted: true,
      clickAttempted: true,
      persisted: true,
      response: null,
    };
  }
  const classified = classifySendProbeRpcResult(response, intentLatch);
  return {
    ok: classified.outcome === "completed",
    outcome: classified.outcome,
    reason: classified.outcome === "completed" ? undefined : classified.reason,
    mutationAttempted: classified.mutationAttempted === true,
    clickAttempted: classified.clickAttempted === true,
    persisted: true,
    response,
  };
}
