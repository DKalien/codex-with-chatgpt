import { describe, expect, it } from "vitest";
import {
  beginConnectAttestation,
  beginConnectTakeover,
  connectFlowIdentity,
  connectFlowMatches,
  connectFlowTargetMatches,
  emptyConnectFlow,
  finishConnectFlow,
  observeConnectTakeover,
  parseConnectFlow,
  requestConnectCompletion,
  takeoverConnectFlowIdentity,
} from "../browser-companion/connect-flow.js";

const identity = {
  workspaceId: "workspace-g4c",
  bindingId: "22222222-2222-4222-8222-222222222222",
  epoch: 2,
  companionId: "33333333-3333-4333-8333-333333333333",
  routeCanonical: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111",
  challengeId: "44444444-4444-4444-8444-444444444444",
};

describe("G4c durable connect flow", () => {
  it("moves once through attestation and completion fences", () => {
    const started = beginConnectAttestation(emptyConnectFlow(), identity, 1);
    expect(started.ok).toBe(true);
    expect(started.flow.state).toBe("ATTEST_REQUESTED");
    expect(connectFlowMatches(started.flow, identity)).toBe(true);

    const requested = requestConnectCompletion(started.flow, identity, 2);
    expect(requested).toMatchObject({ ok: true, flow: { state: "COMPLETE_REQUESTED" } });
    expect(requestConnectCompletion(requested.flow, identity)).toMatchObject({
      ok: false,
      reason: "connect_not_ready",
    });

    const done = finishConnectFlow(requested.flow, identity, "DONE", 3);
    expect(done.state).toBe("DONE");
    expect(beginConnectAttestation(done, identity)).toMatchObject({
      ok: false,
      reason: "already_connected",
    });
  });

  it("fails closed on corrupt or mismatched durable identity", () => {
    expect(parseConnectFlow({ state: "COMPLETE_REQUESTED", workspaceId: "credential_like" }).state)
      .toBe("OUTCOME_UNKNOWN");
    const started = beginConnectAttestation(emptyConnectFlow(), identity).flow;
    const other = { ...identity, challengeId: "55555555-5555-4555-8555-555555555555" };
    expect(requestConnectCompletion(started, other)).toMatchObject({
      ok: false,
      reason: "connect_not_ready",
    });
    expect(finishConnectFlow(started, other, "DONE").state).toBe("OUTCOME_UNKNOWN");
    expect(parseConnectFlow({ ...started, bindingId: "not-a-uuid" }).state)
      .toBe("OUTCOME_UNKNOWN");
  });

  it("derives identity only from durable transport fields", () => {
    const derived = connectFlowIdentity({
      ...identity,
      routeAttestationMessage: `[C2C_ROUTE_ATTEST]\nchallengeId=${identity.challengeId}`,
      credential: "must-not-enter-flow",
    });
    expect(derived).toEqual(identity);
    expect(JSON.stringify(derived)).not.toContain("must-not-enter-flow");
  });

  it("keeps a VERIFIED connect flow connected across strict Project route aliases", () => {
    const persisted = {
      ...identity,
      routeCanonical: "https://chatgpt.com/g/g-p-6aa296e634348191b441d56fdab23b7b-codex-with-chatgpt/c/6aae79f7-d174-83ec-a704-2e3e4c662b47",
    };
    const current = {
      ...identity,
      routeCanonical: "https://chatgpt.com/g/g-p-6aa296e634348191b441d56fdab23b7b/c/6aae79f7-d174-83ec-a704-2e3e4c662b47",
    };
    expect(connectFlowMatches(persisted, current)).toBe(true);
  });

  it("persists one takeover bootstrap and accepts only the exact immediate successor", () => {
    const oldTransport = {
      workspaceId: identity.workspaceId,
      bindingId: identity.bindingId,
      epoch: identity.epoch,
      companionId: identity.companionId,
    };
    const bootstrap = takeoverConnectFlowIdentity(oldTransport, identity.routeCanonical);
    expect(bootstrap).toMatchObject({ challengeId: null, routeCanonical: identity.routeCanonical });
    const dispatch = beginConnectTakeover(emptyConnectFlow(), bootstrap, 10);
    expect(dispatch).toMatchObject({ ok: true, flow: { state: "TAKEOVER_DISPATCH" } });
    expect(beginConnectTakeover(dispatch.flow, bootstrap)).toMatchObject({
      ok: false,
      reason: "takeover_dispatch_active",
    });

    const waiting = observeConnectTakeover(dispatch.flow, bootstrap, 11);
    expect(parseConnectFlow(waiting)).toMatchObject({ state: "WAITING_TAKEOVER", challengeId: null });
    expect(connectFlowTargetMatches(waiting, identity.workspaceId, identity.routeCanonical)).toBe(true);

    const successor = {
      ...identity,
      epoch: identity.epoch + 1,
      bindingId: "66666666-6666-4666-8666-666666666666",
      companionId: "77777777-7777-4777-8777-777777777777",
    };
    const attestation = beginConnectAttestation(waiting, successor, 12);
    expect(attestation).toMatchObject({
      ok: true,
      flow: { state: "ATTEST_REQUESTED", bootstrapAutoResume: true },
    });
    expect(beginConnectAttestation(waiting, { ...successor, epoch: successor.epoch + 1 })).toMatchObject({
      ok: false,
      reason: "connect_identity_conflict",
    });
    expect(finishConnectFlow(attestation.flow, successor, "DONE").bootstrapAutoResume).toBe(false);
  });

  it("corrupt or unknown bootstrap flow fails closed and cannot be redispatched", () => {
    const bootstrap = { ...identity, challengeId: null };
    const dispatch = beginConnectTakeover(emptyConnectFlow(), bootstrap, 1).flow;
    const unknown = finishConnectFlow(dispatch, bootstrap, "OUTCOME_UNKNOWN", 2);
    expect(parseConnectFlow(unknown)).toMatchObject({ state: "OUTCOME_UNKNOWN", challengeId: null });
    expect(beginConnectTakeover(unknown, bootstrap)).toMatchObject({
      ok: false,
      reason: "connect_outcome_unknown",
    });
    expect(parseConnectFlow({ ...dispatch, epoch: "not-an-epoch" }).state).toBe("OUTCOME_UNKNOWN");
  });
});
