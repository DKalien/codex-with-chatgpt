import { areChatgptConversationRoutesEquivalent } from "./route-esm.js";

/** Durable G4c connect/rebind fence. Browser-safe and side-effect free. */

export const CONNECT_FLOW_KEY = "c2c_companion_connect_flow_v1";

const STATES = new Set([
  "NONE",
  "ATTEST_REQUESTED",
  "COMPLETE_REQUESTED",
  "DONE",
  "OUTCOME_UNKNOWN",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function emptyConnectFlow() {
  return {
    state: "NONE",
    workspaceId: null,
    bindingId: null,
    epoch: null,
    companionId: null,
    routeCanonical: null,
    challengeId: null,
    updatedAt: null,
  };
}

function validIdentity(value) {
  return Boolean(
    value
    && typeof value.workspaceId === "string"
    && value.workspaceId.length > 0
    && value.workspaceId.length <= 128
    && UUID.test(value.bindingId)
    && Number.isInteger(value.epoch)
    && value.epoch >= 0
    && UUID.test(value.companionId)
    && typeof value.routeCanonical === "string"
    && value.routeCanonical.length > 0
    && value.routeCanonical.length <= 512
    && UUID.test(value.challengeId),
  );
}

export function parseConnectFlow(value) {
  if (!value || typeof value !== "object" || value.state === "NONE") {
    return emptyConnectFlow();
  }
  if (!STATES.has(value.state) || !validIdentity(value)) {
    return { ...emptyConnectFlow(), state: "OUTCOME_UNKNOWN", updatedAt: Date.now() };
  }
  return {
    state: value.state,
    workspaceId: value.workspaceId,
    bindingId: value.bindingId,
    epoch: value.epoch,
    companionId: value.companionId,
    routeCanonical: value.routeCanonical,
    challengeId: value.challengeId,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : null,
  };
}

export function connectFlowIdentity(transport) {
  const challengeId = typeof transport?.routeAttestationMessage === "string"
    ? /challengeId=([0-9a-fA-F-]{36})/.exec(transport.routeAttestationMessage)?.[1] ?? null
    : null;
  const identity = {
    workspaceId: transport?.workspaceId,
    bindingId: transport?.bindingId,
    epoch: transport?.epoch,
    companionId: transport?.companionId,
    routeCanonical: transport?.routeCanonical,
    challengeId,
  };
  return validIdentity(identity) ? identity : null;
}

export function connectFlowMatches(flow, identity) {
  return Boolean(
    validIdentity(flow)
    && validIdentity(identity)
    && flow.workspaceId === identity.workspaceId
    && flow.bindingId === identity.bindingId
    && flow.epoch === identity.epoch
    && flow.companionId === identity.companionId
    && areChatgptConversationRoutesEquivalent(flow.routeCanonical, identity.routeCanonical)
    && flow.challengeId === identity.challengeId,
  );
}

export function beginConnectAttestation(current, identity, now = Date.now()) {
  const parsed = parseConnectFlow(current);
  if (!validIdentity(identity)) return { ok: false, reason: "connect_identity_invalid", flow: parsed };
  if (parsed.state === "OUTCOME_UNKNOWN") {
    return { ok: false, reason: "connect_outcome_unknown", flow: parsed };
  }
  if (connectFlowMatches(parsed, identity)) {
    return { ok: false, reason: parsed.state === "DONE" ? "already_connected" : "connect_active", flow: parsed };
  }
  if (parsed.state !== "NONE" && parsed.state !== "DONE") {
    return { ok: false, reason: "connect_identity_conflict", flow: parsed };
  }
  return {
    ok: true,
    flow: { state: "ATTEST_REQUESTED", ...identity, updatedAt: now },
  };
}

export function requestConnectCompletion(current, identity, now = Date.now()) {
  const parsed = parseConnectFlow(current);
  if (!connectFlowMatches(parsed, identity) || parsed.state !== "ATTEST_REQUESTED") {
    return { ok: false, reason: "connect_not_ready", flow: parsed };
  }
  return { ok: true, flow: { ...parsed, state: "COMPLETE_REQUESTED", updatedAt: now } };
}

export function finishConnectFlow(current, identity, state, now = Date.now()) {
  const parsed = parseConnectFlow(current);
  if (!connectFlowMatches(parsed, identity) || !["DONE", "OUTCOME_UNKNOWN"].includes(state)) {
    return { ...parsed, state: "OUTCOME_UNKNOWN", updatedAt: now };
  }
  return { ...parsed, state, updatedAt: now };
}
