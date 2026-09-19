import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseChatgptConversationRoute } from "../src/chatgpt/route.js";
import {
  applyRouteAttestServerVerification,
  applyRouteAttestServerVerificationToFence,
  canStartRouteAttestSend,
  classifyRouteAttestRpcResult,
  emptyRouteAttestFence,
  emptyRouteAttestLatch,
  extractRouteAttestHeaderArgs,
  extractRouteAttestToolCallArgs,
  findRouteAttestationUserTurn,
  isRouteAttestationMessage,
  markPairingTransitionBarrier,
  markRouteAttestFenceDispatch,
  markRouteAttestFenceState,
  nextRouteAttestFenceAfterPair,
  parseRouteAttestFence,
  parseRouteAttestLatch,
  reconcileRouteAttestAfterHydrate,
  resolvePairFenceAfterSuccess,
  routeAttestFenceBlocksResend,
  routeAttestLatchBlocksResend,
  shouldPollRouteAttestConfirm,
  shouldRestorePairFenceAfterHttpError,
  syncTransportRouteVerification,
  validateRouteAttestPopupRequest,
} from "../browser-companion/route-attestation.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const companionRoot = path.join(projectRoot, "browser-companion");
const CHALLENGE = "11111111-1111-4111-8111-111111111111";
const DIGEST = "a".repeat(64);
const CHALLENGE_B = "22222222-2222-4222-8222-222222222222";
const DIGEST_B = "b".repeat(64);
const COMPANION = "comp-aaaaaaaa-1111-4111-8111-111111111111";
const COMPANION_B = "comp-bbbbbbbb-2222-4222-8222-222222222222";

function buildAttest(challengeId: string, digest: string): string {
  return [
    "[C2C_ROUTE_ATTEST]",
    `challengeId=${challengeId}`,
    `challengeDigest=${digest}`,
    "",
    "这是 C2C delivery-route verification，不是新开发任务。",
    "请在本对话调用 MCP 工具（参数必须与上方两行完全一致）：",
    `feedback_companion_route_confirm(challengeId=${challengeId}, challengeDigest=${digest})`,
  ].join("\n");
}

const ATTEST = buildAttest(CHALLENGE, DIGEST);
const ATTEST_B = buildAttest(CHALLENGE_B, DIGEST_B);
const ROUTE = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const EXPIRES = new Date(Date.now() + 10 * 60_000).toISOString();
const EXPIRED = new Date(Date.now() - 1000).toISOString();

function pendingTransport(overrides: Record<string, unknown> = {}) {
  return {
    authStale: false,
    routeCanonical: ROUTE,
    routeVerification: "PENDING",
    routeAttestationMessage: ATTEST,
    routeAttestationExpiresAt: EXPIRES,
    companionId: COMPANION,
    bindingId: "b",
    epoch: 1,
    ...overrides,
  };
}

function owner(overrides: Record<string, unknown> = {}) {
  return {
    tabId: 7,
    documentId: "doc-1",
    canonicalRoute: ROUTE,
    generation: 3,
    ...overrides,
  };
}

function safeEvidence() {
  return { safe: true, composer: "empty", generation: "idle" };
}

function observedLatch(overrides: Record<string, unknown> = {}) {
  return {
    state: "OBSERVED_PENDING_CONFIRM",
    tabId: 7,
    documentId: "doc-1",
    canonicalRoute: ROUTE,
    generation: 3,
    challengeId: CHALLENGE,
    challengeExpiresAt: EXPIRES,
    createdAt: Date.now(),
    ...overrides,
  };
}

function fenceFor(state: string, overrides: Record<string, unknown> = {}) {
  return {
    state,
    companionId: COMPANION,
    challengeId: CHALLENGE,
    routeCanonical: ROUTE,
    challengeExpiresAt: EXPIRES,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

/** Shared canStart base: session latch NONE — fence is the variable under test. */
function canStartBase(overrides: Record<string, unknown> = {}) {
  return {
    owner: owner(),
    transport: pendingTransport(),
    journal: { state: "NONE" },
    evidence: safeEvidence(),
    latch: emptyRouteAttestLatch(),
    fence: emptyRouteAttestFence(),
    companionId: COMPANION,
    challengeId: CHALLENGE,
    ...overrides,
  };
}

describe("route-attestation pure contract", () => {
  it("popup cannot supply message payload", () => {
    expect(validateRouteAttestPopupRequest({ type: "c2c.route.attest.send" }).ok).toBe(true);
    expect(validateRouteAttestPopupRequest({ type: "c2c.route.attest.send", message: ATTEST }).ok).toBe(false);
    expect(validateRouteAttestPopupRequest({ attestationMessage: ATTEST }).ok).toBe(false);
  });

  it("SW-owned pending message required; dirty journal/generation blocked", () => {
    expect(isRouteAttestationMessage(ATTEST)).toBe(true);
    expect(canStartRouteAttestSend(canStartBase()).ok).toBe(true);
    expect(canStartRouteAttestSend(canStartBase({
      transport: pendingTransport({ routeAttestationMessage: undefined }),
    })).reason).toBe("route_attestation_message_missing");
    expect(canStartRouteAttestSend(canStartBase({
      journal: { state: "RESERVED" },
    })).reason).toBe("route_attest_journal_active");
    expect(canStartRouteAttestSend(canStartBase({
      owner: owner({ canonicalRoute: "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222" }),
    })).reason).toBe("owner_route_mismatch");
    expect(canStartRouteAttestSend(canStartBase({
      evidence: { safe: false, composer: "dirty", generation: "idle" },
    })).reason).toBe("evidence_unsafe");
  });

  it("ambiguous send fail-closed; observed does not locally set VERIFIED", () => {
    expect(classifyRouteAttestRpcResult(null).retryAllowed).toBe(false);
    expect(classifyRouteAttestRpcResult({
      ok: false,
      clickAttempted: true,
      clicked: true,
      observed: false,
    }).reason).toBe("route_attest_outcome_ambiguous");
    expect(classifyRouteAttestRpcResult({ ok: true, observed: true }).serverVerified).toBe(false);
  });

  it("server /state is sole VERIFIED authority; downgrade flagged", () => {
    const pending = pendingTransport();
    const stayPending = syncTransportRouteVerification(pending, { routeVerification: "PENDING" });
    expect(stayPending.transport.routeVerification).toBe("PENDING");

    const verified = syncTransportRouteVerification(pending, { routeVerification: "VERIFIED" });
    expect(verified.transport.routeVerification).toBe("VERIFIED");
    expect(verified.transport.routeAttestationMessage).toBeUndefined();
    expect(verified.productionEligible).toBe(true);

    const alreadyVerified = pendingTransport({ routeVerification: "VERIFIED", routeAttestationMessage: undefined });
    const down = syncTransportRouteVerification(alreadyVerified, { routeVerification: "PENDING" });
    expect(down.downgraded).toBe(true);
  });

  it("sync carries challenge expiresAt from authenticated /state", () => {
    const pending = pendingTransport({ routeAttestationExpiresAt: undefined });
    const synced = syncTransportRouteVerification(pending, {
      routeVerification: "PENDING",
      routeAttestation: { message: ATTEST, expiresAt: EXPIRES },
    });
    expect(synced.transport.routeAttestationExpiresAt).toBe(EXPIRES);
  });

  it("attestation message tool-call args equal header lines (actual values, not placeholders)", async () => {
    const { formatRouteAttestationMessage } = await import("../src/feedback/store.js");
    const msg = formatRouteAttestationMessage(CHALLENGE, DIGEST);
    expect(msg).not.toMatch(/challengeId=\.\.\./);
    expect(msg).not.toMatch(/challengeDigest=\.\.\./);
    const header = extractRouteAttestHeaderArgs(msg);
    const call = extractRouteAttestToolCallArgs(msg);
    expect(header).toEqual({ challengeId: CHALLENGE, challengeDigest: DIGEST });
    expect(call).toEqual(header);
  });
});

describe("route-attestation session latch fence", () => {
  it("latch parse fail-closed; blocks resend outside NONE", () => {
    expect(parseRouteAttestLatch(undefined).state).toBe("NONE");
    expect(parseRouteAttestLatch({ state: "__junk__" }).state).toBe("OUTCOME_UNKNOWN");
    expect(routeAttestLatchBlocksResend(emptyRouteAttestLatch())).toBe(false);
    expect(routeAttestLatchBlocksResend({ state: "ROUTE_ATTEST_DISPATCH" })).toBe(true);
    expect(routeAttestLatchBlocksResend({ state: "OUTCOME_UNKNOWN" })).toBe(true);
    expect(routeAttestLatchBlocksResend({ state: "OBSERVED_PENDING_CONFIRM" })).toBe(true);
    expect(routeAttestLatchBlocksResend({ state: "VERIFIED" })).toBe(true);
  });

  it("non-NONE session latch blocks canStart", () => {
    for (const state of ["ROUTE_ATTEST_DISPATCH", "OUTCOME_UNKNOWN", "OBSERVED_PENDING_CONFIRM", "VERIFIED"]) {
      const res = canStartRouteAttestSend(canStartBase({ latch: { state, challengeId: CHALLENGE } }));
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("route_attest_latch_active");
    }
  });
});

describe("durable route-attest fence (survives browser restart)", () => {
  it("parse: missing → NONE; corrupt/unknown → OUTCOME_UNKNOWN fail closed", () => {
    expect(parseRouteAttestFence(undefined).state).toBe("NONE");
    expect(parseRouteAttestFence(null).state).toBe("NONE");
    expect(parseRouteAttestFence("junk").state).toBe("OUTCOME_UNKNOWN");
    expect(parseRouteAttestFence({}).state).toBe("OUTCOME_UNKNOWN");
    expect(parseRouteAttestFence({ state: "__junk__", challengeId: CHALLENGE }).state).toBe("OUTCOME_UNKNOWN");
    expect(parseRouteAttestFence({ state: 123 }).state).toBe("OUTCOME_UNKNOWN");
  });

  it("OUTCOME_UNKNOWN fence + session latch empty after restart → Verify blocked", () => {
    const restartLatch = emptyRouteAttestLatch();
    const fence = fenceFor("OUTCOME_UNKNOWN");
    const res = canStartRouteAttestSend(canStartBase({
      latch: restartLatch,
      fence,
    }));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("route_attest_fence_active");
    expect(res.fenceState).toBe("OUTCOME_UNKNOWN");
  });

  it("ROUTE_ATTEST_DISPATCH fence + browser restart → blocked", () => {
    const res = canStartRouteAttestSend(canStartBase({
      latch: emptyRouteAttestLatch(),
      fence: fenceFor("ROUTE_ATTEST_DISPATCH"),
    }));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("route_attest_fence_active");
  });

  it("OBSERVED_PENDING_CONFIRM fence + browser restart → blocked", () => {
    const res = canStartRouteAttestSend(canStartBase({
      latch: emptyRouteAttestLatch(),
      fence: fenceFor("OBSERVED_PENDING_CONFIRM"),
    }));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("route_attest_fence_active");
  });

  it("VERIFIED fence blocks resend for same challenge", () => {
    const res = canStartRouteAttestSend(canStartBase({
      latch: emptyRouteAttestLatch(),
      fence: fenceFor("VERIFIED"),
    }));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("route_attest_fence_active");
  });

  it("corrupt durable fence → blocked fail closed", () => {
    const res = canStartRouteAttestSend(canStartBase({
      latch: emptyRouteAttestLatch(),
      fence: { state: "__corrupt__", challengeId: CHALLENGE },
    }));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("route_attest_fence_corrupt");

    const missingState = canStartRouteAttestSend(canStartBase({
      latch: emptyRouteAttestLatch(),
      fence: { challengeId: CHALLENGE },
    }));
    expect(missingState.ok).toBe(false);
    expect(missingState.reason).toBe("route_attest_fence_corrupt");
  });

  it("re-pair new companionId + new challenge → fence NONE / allowed", () => {
    const next = nextRouteAttestFenceAfterPair({
      fence: fenceFor("OUTCOME_UNKNOWN"),
      newCompanionId: COMPANION_B,
      newChallengeId: CHALLENGE_B,
      routeCanonical: ROUTE,
    });
    expect(next.ok).toBe(true);
    expect(next.fence.state).toBe("NONE");
    expect(next.fence.companionId).toBe(COMPANION_B);
    expect(next.fence.challengeId).toBe(CHALLENGE_B);

    const allowed = canStartRouteAttestSend(canStartBase({
      latch: emptyRouteAttestLatch(),
      fence: next.fence,
      transport: pendingTransport({
        companionId: COMPANION_B,
        routeAttestationMessage: ATTEST_B,
      }),
      companionId: COMPANION_B,
      challengeId: CHALLENGE_B,
    }));
    expect(allowed.ok).toBe(true);
  });

  it("re-pair same companion+challenge never clears fence", () => {
    const next = nextRouteAttestFenceAfterPair({
      fence: fenceFor("OUTCOME_UNKNOWN"),
      newCompanionId: COMPANION,
      newChallengeId: CHALLENGE,
    });
    expect(next.ok).toBe(false);
    expect(next.reason).toBe("route_attest_fence_same_challenge");
    expect(next.fence.state).toBe("OUTCOME_UNKNOWN");
  });

  it("re-pair without new identity does not clear fence", () => {
    const next = nextRouteAttestFenceAfterPair({
      fence: fenceFor("OUTCOME_UNKNOWN"),
      newCompanionId: null,
      newChallengeId: CHALLENGE_B,
    });
    expect(next.ok).toBe(false);
    expect(next.reason).toBe("route_attest_fence_pair_identity_missing");
  });

  it("transport clear alone does NOT authorize same challenge again", () => {
    // Simulate: transport cleared then same challenge restored without re-pair.
    const fence = fenceFor("OUTCOME_UNKNOWN");
    const res = canStartRouteAttestSend(canStartBase({
      latch: emptyRouteAttestLatch(),
      fence,
      // same transport/challenge after "clear + restore"
      transport: pendingTransport(),
      companionId: COMPANION,
      challengeId: CHALLENGE,
    }));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("route_attest_fence_active");
  });

  it("server VERIFIED for matching OUTCOME_UNKNOWN fence → VERIFIED without resend", () => {
    const fence = fenceFor("OUTCOME_UNKNOWN");
    const applied = applyRouteAttestServerVerificationToFence(fence, "VERIFIED", {
      companionId: COMPANION,
      challengeId: CHALLENGE,
    });
    expect(applied.ok).toBe(true);
    expect(applied.transitioned).toBe(true);
    expect(applied.fence.state).toBe("VERIFIED");
    // Still blocks resend — VERIFIED is terminal, not a free pass to re-Send.
    expect(canStartRouteAttestSend(canStartBase({
      latch: emptyRouteAttestLatch(),
      fence: applied.fence,
    })).reason).toBe("route_attest_fence_active");
  });

  it("server VERIFIED does not touch a different challenge's fence", () => {
    const fence = fenceFor("OUTCOME_UNKNOWN", { challengeId: CHALLENGE_B, companionId: COMPANION_B });
    const applied = applyRouteAttestServerVerificationToFence(fence, "VERIFIED", {
      companionId: COMPANION,
      challengeId: CHALLENGE,
    });
    expect(applied.transitioned).toBe(false);
    expect(applied.fence.state).toBe("OUTCOME_UNKNOWN");
    expect(applied.fence.challengeId).toBe(CHALLENGE_B);
  });

  it("server PENDING never invents fence VERIFIED", () => {
    const applied = applyRouteAttestServerVerificationToFence(
      fenceFor("OBSERVED_PENDING_CONFIRM"),
      "PENDING",
      { companionId: COMPANION, challengeId: CHALLENGE },
    );
    expect(applied.transitioned).toBe(false);
    expect(applied.fence.state).toBe("OBSERVED_PENDING_CONFIRM");
  });

  it("hydrate: session empty + durable OUTCOME_UNKNOWN for current challenge → blocked + latch restored", () => {
    const transport = pendingTransport();
    const fence = fenceFor("OUTCOME_UNKNOWN");
    const rec = reconcileRouteAttestAfterHydrate({
      fence,
      sessionLatch: emptyRouteAttestLatch(),
      transport,
    });
    expect(rec.ok).toBe(true);
    expect(rec.resendBlocked).toBe(true);
    expect(rec.sessionLatch.state).toBe("OUTCOME_UNKNOWN");
    expect(rec.sessionLatch.challengeId).toBe(CHALLENGE);
    expect(rec.fence.state).toBe("OUTCOME_UNKNOWN");

    const res = canStartRouteAttestSend(canStartBase({
      latch: rec.sessionLatch,
      fence: rec.fence,
      transport,
    }));
    expect(res.ok).toBe(false);
  });

  it("hydrate: DISPATCH / OBSERVED_PENDING_CONFIRM durable fence blocks after restart", () => {
    for (const state of ["ROUTE_ATTEST_DISPATCH", "OBSERVED_PENDING_CONFIRM"]) {
      const rec = reconcileRouteAttestAfterHydrate({
        fence: fenceFor(state),
        sessionLatch: emptyRouteAttestLatch(),
        transport: pendingTransport(),
      });
      expect(rec.sessionLatch.state).toBe(state);
      const res = canStartRouteAttestSend(canStartBase({
        latch: emptyRouteAttestLatch(),
        fence: rec.fence,
      }));
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("route_attest_fence_active");
    }
  });

  it("hydrate: corrupt durable fence → blocked", () => {
    const rec = reconcileRouteAttestAfterHydrate({
      fence: { state: "__bad__" },
      sessionLatch: emptyRouteAttestLatch(),
      transport: pendingTransport(),
    });
    expect(rec.fence.state).toBe("OUTCOME_UNKNOWN");
    expect(rec.resendBlocked).toBe(true);
    const res = canStartRouteAttestSend(canStartBase({
      latch: emptyRouteAttestLatch(),
      fence: rec.fence,
    }));
    expect(res.ok).toBe(false);
    // Parsed corrupt fence is OUTCOME_UNKNOWN without challengeId → active/corrupt both block.
    expect(["route_attest_fence_corrupt", "route_attest_fence_active"]).toContain(res.reason);

    // Raw malformed objects still report corrupt explicitly.
    const raw = canStartRouteAttestSend(canStartBase({
      latch: emptyRouteAttestLatch(),
      fence: { challengeId: CHALLENGE },
    }));
    expect(raw.ok).toBe(false);
    expect(raw.reason).toBe("route_attest_fence_corrupt");
  });

  it("hydrate: fresh NONE fence + empty session → allowed", () => {
    const rec = reconcileRouteAttestAfterHydrate({
      fence: emptyRouteAttestFence(),
      sessionLatch: emptyRouteAttestLatch(),
      transport: pendingTransport(),
    });
    expect(rec.resendBlocked).toBe(false);
    expect(canStartRouteAttestSend(canStartBase({
      latch: rec.sessionLatch,
      fence: rec.fence,
    })).ok).toBe(true);
  });

  it("A. partial re-pair crash: new NONE fence B durable + old transport A → old challenge BLOCKED", () => {
    // Simulated restart durable state after buggy order (fence written, transport not).
    const crashFence = {
      state: "NONE",
      companionId: COMPANION_B,
      challengeId: CHALLENGE_B,
      routeCanonical: ROUTE,
    };
    const oldTransport = pendingTransport({
      companionId: COMPANION,
      routeAttestationMessage: ATTEST,
    });
    const rec = reconcileRouteAttestAfterHydrate({
      fence: crashFence,
      sessionLatch: emptyRouteAttestLatch(),
      transport: oldTransport,
    });
    expect(rec.fence.state).toBe("NONE");
    const res = canStartRouteAttestSend(canStartBase({
      latch: emptyRouteAttestLatch(),
      fence: rec.fence,
      transport: oldTransport,
      companionId: COMPANION,
      challengeId: CHALLENGE,
    }));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("route_attest_fence_identity_mismatch");
  });

  it("B. NONE fence B/B + transport A/A → identity mismatch blocked", () => {
    const res = canStartRouteAttestSend(canStartBase({
      latch: emptyRouteAttestLatch(),
      fence: {
        state: "NONE",
        companionId: COMPANION_B,
        challengeId: CHALLENGE_B,
      },
      transport: pendingTransport({ companionId: COMPANION, routeAttestationMessage: ATTEST }),
      companionId: COMPANION,
      challengeId: CHALLENGE,
    }));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("route_attest_fence_identity_mismatch");
  });

  it("C. pristine empty NONE fence + fresh transport → allowed", () => {
    const res = canStartRouteAttestSend(canStartBase({
      latch: emptyRouteAttestLatch(),
      fence: emptyRouteAttestFence(),
      transport: pendingTransport({ companionId: COMPANION, routeAttestationMessage: ATTEST }),
      companionId: COMPANION,
      challengeId: CHALLENGE,
    }));
    expect(res.ok).toBe(true);
  });

  it("D. matching NONE fence B/B + transport B/B → allowed", () => {
    const res = canStartRouteAttestSend(canStartBase({
      latch: emptyRouteAttestLatch(),
      fence: {
        state: "NONE",
        companionId: COMPANION_B,
        challengeId: CHALLENGE_B,
        routeCanonical: ROUTE,
      },
      transport: pendingTransport({
        companionId: COMPANION_B,
        routeAttestationMessage: ATTEST_B,
      }),
      companionId: COMPANION_B,
      challengeId: CHALLENGE_B,
    }));
    expect(res.ok).toBe(true);
  });

  it("E. pair durable commit / barrier failure must not report success", () => {
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    const pairIdx = sw.indexOf("async function handlePair");
    const pairEnd = sw.indexOf("\nasync function ", pairIdx + 1);
    const pairBlock = sw.slice(pairIdx, pairEnd > pairIdx ? pairEnd : pairIdx + 9000);
    expect(pairBlock).toMatch(/markPairingTransitionBarrier/);
    expect(pairBlock).toMatch(/commitPairDurableLocals/);
    expect(pairBlock).toMatch(/pair_barrier_persist_failed/);
    expect(pairBlock).toMatch(/pair_durable_commit_failed/);
    expect(pairBlock).toMatch(/pair_outcome_unknown/);
    // Success only after durable commit.
    const failIdx = pairBlock.indexOf("pair_durable_commit_failed");
    const okIdx = pairBlock.indexOf("return { ok: true, transport: safeTransportSummary() }");
    expect(okIdx).toBeGreaterThan(failIdx);
    // Memory switch of transport only after commit.
    const commitIdx = pairBlock.indexOf("commitPairDurableLocals");
    const switchIdx = pairBlock.indexOf("transport = nextTransport");
    expect(switchIdx).toBeGreaterThan(commitIdx);
  });

  it("non-NONE fence ALWAYS blocks — even different companion/challenge identity", () => {
    // Old OUTCOME_UNKNOWN A must block a hypothetical new challenge B send
    // until a complete successful re-pair writes matching NONE for B.
    const oldUnknownA = fenceFor("OUTCOME_UNKNOWN");
    const newTransportB = pendingTransport({
      companionId: COMPANION_B,
      routeAttestationMessage: ATTEST_B,
    });
    const res = canStartRouteAttestSend(canStartBase({
      latch: emptyRouteAttestLatch(),
      fence: oldUnknownA,
      transport: newTransportB,
      companionId: COMPANION_B,
      challengeId: CHALLENGE_B,
    }));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("route_attest_fence_active");

    for (const state of ["ROUTE_ATTEST_DISPATCH", "OBSERVED_PENDING_CONFIRM", "VERIFIED", "PAIRING_TRANSITION"]) {
      const r = canStartRouteAttestSend(canStartBase({
        latch: emptyRouteAttestLatch(),
        fence: { ...oldUnknownA, state },
        transport: newTransportB,
        companionId: COMPANION_B,
        challengeId: CHALLENGE_B,
      }));
      expect(r.ok).toBe(false);
    }
  });

  it("PAIRING_TRANSITION barrier blocks all route-attest Send", () => {
    const barrier = markPairingTransitionBarrier(fenceFor("NONE"), Date.now());
    expect(barrier.state).toBe("PAIRING_TRANSITION");
    expect(routeAttestFenceBlocksResend(barrier, { companionId: COMPANION, challengeId: CHALLENGE }).reason)
      .toBe("route_attest_pairing_transition");
    const res = canStartRouteAttestSend(canStartBase({
      latch: emptyRouteAttestLatch(),
      fence: barrier,
    }));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("route_attest_pairing_transition");
  });

  it("failure injection: barrier after /pair network loss blocks old PENDING challenge", () => {
    // Server may have superseded; local still has old transport + barrier.
    const oldTransport = pendingTransport({ companionId: COMPANION, routeAttestationMessage: ATTEST });
    const barrier = markPairingTransitionBarrier(fenceFor("NONE"), Date.now());
    const res = canStartRouteAttestSend(canStartBase({
      latch: emptyRouteAttestLatch(),
      fence: barrier,
      transport: oldTransport,
      companionId: COMPANION,
      challengeId: CHALLENGE,
    }));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("route_attest_pairing_transition");
  });

  it("failure injection: durable commit fail keeps barrier — new transport not usable for Verify", () => {
    // Memory incorrectly holding new transport + barrier (commit failed before memory switch
    // in fixed code; simulate worst case if memory had new transport + barrier).
    const barrier = markPairingTransitionBarrier(fenceFor("NONE"), Date.now());
    const res = canStartRouteAttestSend(canStartBase({
      latch: emptyRouteAttestLatch(),
      fence: barrier,
      transport: pendingTransport({
        companionId: COMPANION_B,
        routeAttestationMessage: ATTEST_B,
      }),
      companionId: COMPANION_B,
      challengeId: CHALLENGE_B,
    }));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("route_attest_pairing_transition");
  });

  it("success path: complete pair writes matching anchored NONE for new identity → Verify allowed", () => {
    const prev = fenceFor("OUTCOME_UNKNOWN");
    const barrier = markPairingTransitionBarrier(prev, Date.now());
    const resolved = resolvePairFenceAfterSuccess({
      prevFence: barrier,
      companionId: COMPANION_B,
      challengeId: CHALLENGE_B,
      routeCanonical: ROUTE,
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.fence.state).toBe("NONE");
    expect(resolved.fence.companionId).toBe(COMPANION_B);
    expect(resolved.fence.challengeId).toBe(CHALLENGE_B);

    const allowed = canStartRouteAttestSend(canStartBase({
      latch: emptyRouteAttestLatch(),
      fence: resolved.fence,
      transport: pendingTransport({
        companionId: COMPANION_B,
        routeAttestationMessage: ATTEST_B,
      }),
      companionId: COMPANION_B,
      challengeId: CHALLENGE_B,
    }));
    expect(allowed.ok).toBe(true);
  });

  it("4xx restores prev fence; 5xx/network keeps barrier", () => {
    expect(shouldRestorePairFenceAfterHttpError(400)).toBe(true);
    expect(shouldRestorePairFenceAfterHttpError(401)).toBe(true);
    expect(shouldRestorePairFenceAfterHttpError(409)).toBe(true);
    expect(shouldRestorePairFenceAfterHttpError(422)).toBe(true);
    expect(shouldRestorePairFenceAfterHttpError(500)).toBe(false);
    expect(shouldRestorePairFenceAfterHttpError(502)).toBe(false);
    expect(shouldRestorePairFenceAfterHttpError(undefined)).toBe(false);
  });

  it("pair source: barrier before /pair; prev* before mutation; atomic local.set; no early transport assign", () => {
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    const pairIdx = sw.indexOf("async function handlePair");
    const pairEnd = sw.indexOf("\nasync function ", pairIdx + 1);
    const pairBlock = sw.slice(pairIdx, pairEnd > pairIdx ? pairEnd : pairIdx + 9000);

    // prev* captured before any transport/localState assignment of new values.
    const prevIdx = pairBlock.indexOf("const prevTransport = transport");
    const assignIdx = pairBlock.indexOf("transport = {");
    expect(prevIdx).toBeGreaterThan(0);
    // nextTransport is a local — global assign of new transport must be after commit.
    const commitIdx = pairBlock.indexOf("commitPairDurableLocals");
    const memSwitchIdx = pairBlock.indexOf("transport = nextTransport");
    expect(commitIdx).toBeGreaterThan(prevIdx);
    expect(memSwitchIdx).toBeGreaterThan(commitIdx);
    // Barrier persisted before fetch.
    const barrierIdx = pairBlock.indexOf("markPairingTransitionBarrier");
    const barrierPersistIdx = pairBlock.indexOf("await persistRouteAttestFence()");
    const fetchIdx = pairBlock.indexOf("await fetch(");
    expect(barrierIdx).toBeGreaterThan(0);
    expect(barrierPersistIdx).toBeGreaterThan(barrierIdx);
    expect(fetchIdx).toBeGreaterThan(barrierPersistIdx);
    expect(pairBlock).toMatch(/pair_outcome_unknown/);
    expect(pairBlock).toMatch(/pair_durable_commit_failed/);
    expect(pairBlock).toMatch(/pair_barrier_persist_failed/);
    expect(pairBlock).toMatch(/shouldRestorePairFenceAfterHttpError/);
    // Atomic commit helper uses single set with three keys.
    const swFull = sw;
    const commitFnIdx = swFull.indexOf("async function commitPairDurableLocals");
    const commitFn = swFull.slice(commitFnIdx, commitFnIdx + 700);
    expect(commitFn).toMatch(/TRANSPORT_KEY/);
    expect(commitFn).toMatch(/LOCAL_KEY/);
    expect(commitFn).toMatch(/ROUTE_ATTEST_FENCE_KEY/);
    expect(commitFn).toMatch(/chrome\.storage\.local\.set/);
  });

  it("NONE fence identity: incomplete current identity vs anchored fence fail closed", () => {
    const res = canStartRouteAttestSend(canStartBase({
      latch: emptyRouteAttestLatch(),
      fence: { state: "NONE", companionId: COMPANION_B, challengeId: CHALLENGE_B },
      transport: pendingTransport({ companionId: COMPANION, routeAttestationMessage: ATTEST }),
      companionId: null,
      challengeId: CHALLENGE,
    }));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("route_attest_fence_identity_mismatch");
  });

  it("markRouteAttestFenceDispatch binds companion+challenge", () => {
    const fence = markRouteAttestFenceDispatch({
      companionId: COMPANION,
      challengeId: CHALLENGE,
      routeCanonical: ROUTE,
      challengeExpiresAt: EXPIRES,
      now: 1000,
    });
    expect(fence.state).toBe("ROUTE_ATTEST_DISPATCH");
    expect(fence.companionId).toBe(COMPANION);
    expect(fence.challengeId).toBe(CHALLENGE);
    const unknown = markRouteAttestFenceState(fence, "OUTCOME_UNKNOWN", 2000);
    expect(unknown.state).toBe("OUTCOME_UNKNOWN");
    expect(unknown.challengeId).toBe(CHALLENGE);
  });
});

describe("route-attestation heartbeat poll + server convergence", () => {
  it("observed + server still PENDING → heartbeat may poll read-only", () => {
    const poll = shouldPollRouteAttestConfirm({
      latch: observedLatch(),
      ownerExact: true,
      owner: owner(),
      transport: pendingTransport(),
      now: Date.now(),
    });
    expect(poll.ok).toBe(true);
    expect(poll.challengeId).toBe(CHALLENGE);
  });

  it("poll blocked on identity drift / non-owner / auth stale / challenge mismatch / expiry", () => {
    expect(shouldPollRouteAttestConfirm({
      latch: observedLatch(),
      ownerExact: false,
      owner: owner(),
      transport: pendingTransport(),
    }).reason).toBe("not_exact_owner");

    expect(shouldPollRouteAttestConfirm({
      latch: observedLatch(),
      ownerExact: true,
      owner: owner({ documentId: "doc-other" }),
      transport: pendingTransport(),
    }).reason).toBe("identity_drift");

    expect(shouldPollRouteAttestConfirm({
      latch: observedLatch(),
      ownerExact: true,
      owner: owner(),
      transport: pendingTransport({ authStale: true }),
    }).reason).toBe("auth_stale");

    expect(shouldPollRouteAttestConfirm({
      latch: observedLatch({ challengeId: CHALLENGE_B }),
      ownerExact: true,
      owner: owner(),
      transport: pendingTransport(),
    }).reason).toBe("challenge_mismatch");

    expect(shouldPollRouteAttestConfirm({
      latch: observedLatch({ challengeExpiresAt: EXPIRED }),
      ownerExact: true,
      owner: owner(),
      transport: pendingTransport({ routeAttestationExpiresAt: EXPIRED }),
      now: Date.now(),
    }).reason).toBe("challenge_expired");

    expect(shouldPollRouteAttestConfirm({
      latch: emptyRouteAttestLatch(),
      ownerExact: true,
      owner: owner(),
      transport: pendingTransport(),
    }).reason).toBe("latch_not_pollable");
  });

  it("later MCP confirm → /state VERIFIED → latch terminal; wrong-principal stays pending", () => {
    const stillPending = applyRouteAttestServerVerification(observedLatch(), "PENDING");
    expect(stillPending.transitioned).toBe(false);
    expect(stillPending.latch.state).toBe("OBSERVED_PENDING_CONFIRM");
    expect(canStartRouteAttestSend(canStartBase({
      latch: stillPending.latch,
      fence: fenceFor("OBSERVED_PENDING_CONFIRM"),
    })).ok).toBe(false);

    const confirmed = applyRouteAttestServerVerification(observedLatch(), "VERIFIED");
    expect(confirmed.transitioned).toBe(true);
    expect(confirmed.latch.state).toBe("VERIFIED");

    const fromDispatch = applyRouteAttestServerVerification(
      { state: "ROUTE_ATTEST_DISPATCH", challengeId: CHALLENGE },
      "VERIFIED",
    );
    expect(fromDispatch.transitioned).toBe(true);

    const fromUnknown = applyRouteAttestServerVerification(
      { state: "OUTCOME_UNKNOWN", challengeId: CHALLENGE },
      "VERIFIED",
    );
    expect(fromUnknown.transitioned).toBe(true);
    expect(fromUnknown.latch.state).toBe("VERIFIED");
  });

  it("poll stop after already VERIFIED transport", () => {
    const poll = shouldPollRouteAttestConfirm({
      latch: observedLatch(),
      ownerExact: true,
      owner: owner(),
      transport: pendingTransport({ routeVerification: "VERIFIED", routeAttestationMessage: undefined }),
    });
    expect(poll.ok).toBe(false);
    expect(poll.reason).toBe("already_verified");
  });
});

describe("G3 route attestation browser contract (source)", () => {
  it("popup.html contains Verify this conversation route control", () => {
    const html = fs.readFileSync(path.join(companionRoot, "popup", "popup.html"), "utf8");
    expect(html).toMatch(/verify-route/);
    expect(html).toMatch(/Verify this conversation route/i);
  });

  it("popup.js wires verify RPC without message payload; Arm requires productionEligible; fence gate", () => {
    const js = fs.readFileSync(path.join(companionRoot, "popup", "popup.js"), "utf8");
    expect(js).toMatch(/c2c\.route\.attest\.send/);
    const verifyBlock = js.slice(js.indexOf("els.verifyRoute.onclick"), js.indexOf("els.verifyRoute.onclick") + 500);
    expect(verifyBlock).not.toMatch(/message:/);
    expect(verifyBlock).not.toMatch(/attestationMessage/);
    expect(js).toMatch(/productionEligible === true/);
    expect(js).toMatch(/routeAttestLatch/);
    expect(js).toMatch(/routeAttestFence/);
  });

  it("SW owns attestation message; durable fence survives restart; no querySelectorAll fallback", () => {
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    const ra = fs.readFileSync(path.join(companionRoot, "route-attestation.js"), "utf8");
    expect(ra).not.toMatch(/querySelectorAll\("\*"\)/);
    expect(ra).toMatch(/collectBoundedDescendants/);
    expect(ra).toMatch(/route_attest_fence_identity_mismatch/);
    expect(ra).toMatch(/PAIRING_TRANSITION/);
    expect(ra).toMatch(/route_attest_pairing_transition/);
    expect(sw).toMatch(/ROUTE_ATTEST_FENCE_KEY/);
    expect(sw).toMatch(/persistRouteAttestFence/);
    expect(sw).toMatch(/routeAttestFence/);
    expect(sw).toMatch(/markPairingTransitionBarrier/);
    expect(sw).toMatch(/commitPairDurableLocals/);
    expect(sw).toMatch(/applyRouteAttestServerVerificationToFence/);
    expect(sw).toMatch(/reconcileRouteAttestAfterHydrate/);
  });

  it("SW one-shot: durable fence persist before RPC; pair barrier-first; clear transport keeps fence", () => {
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    expect(sw).not.toMatch(/ROUTE_SEND_INTENT/);
    const sendIdx = sw.indexOf('if (message.type === ROUTE_ATTEST_SEND_TYPE)');
    expect(sendIdx).toBeGreaterThan(0);
    const sendBlock = sw.slice(sendIdx, sendIdx + 5500);
    const persistIdx = sendBlock.indexOf("persistRouteAttestBoth");
    const rpcIdx = sendBlock.indexOf("chrome.tabs.sendMessage");
    expect(persistIdx).toBeGreaterThan(0);
    expect(rpcIdx).toBeGreaterThan(persistIdx);
    expect(sendBlock).toMatch(/OUTCOME_UNKNOWN/);
    expect(sendBlock).toMatch(/route_attest_fence_persist_failed/);

    const pairIdx = sw.indexOf("async function handlePair");
    const pairEnd = sw.indexOf("\nasync function ", pairIdx + 1);
    const pairBlock = sw.slice(pairIdx, pairEnd > pairIdx ? pairEnd : pairIdx + 9000);
    expect(pairBlock).toMatch(/markPairingTransitionBarrier/);
    expect(pairBlock).toMatch(/resolvePairFenceAfterSuccess|nextRouteAttestFenceAfterPair/);
    expect(pairBlock).toMatch(/pair_outcome_unknown/);
    expect(pairBlock).toMatch(/pair_durable_commit_failed/);
    expect(pairBlock).toMatch(/PAIRING_TRANSITION/);

    const clearIdx = sw.indexOf("async function handleClearTransport");
    const clearBlock = sw.slice(clearIdx, clearIdx + 800);
    expect(clearBlock).toMatch(/routeAttestFence/);
    expect(clearBlock).not.toMatch(/routeAttestFence = emptyRouteAttestFence/);
    expect(clearBlock).toMatch(/NOT cleared|not cleared|is NOT cleared/i);

    const statusIdx = sw.indexOf("function statusPayload");
    const statusBlock = sw.slice(statusIdx, statusIdx + 1000);
    expect(statusBlock).toMatch(/routeAttestLatch/);
    expect(statusBlock).toMatch(/routeAttestFence/);
  });

  it("content script uses dedicated attest path, not production execute", () => {
    const cs = fs.readFileSync(path.join(companionRoot, "content-script.js"), "utf8");
    expect(cs).toMatch(/c2c\.route\.attest\.execute/);
    expect(cs).toMatch(/__c2cRunRouteAttestationSend/);
    const start = cs.indexOf("c2c.route.attest.execute");
    const block = cs.slice(start, start + 1800);
    expect(block).not.toMatch(/c2c\.production\.begin\.send/);
    expect(block).not.toMatch(/\/reserve/);
    expect(block).toMatch(/normalizeText/);
  });

  it("manifest ships classic route-attestation scripts, not ESM content_scripts", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(companionRoot, "manifest.json"), "utf8"));
    const js = (manifest.content_scripts ?? []).flatMap((cs: { js?: string[] }) => cs.js ?? []);
    expect(js).toContain("route-attestation-global.js");
    expect(js).toContain("route-attestation-run-global.js");
    expect(js).not.toContain("route-attestation.js");
    expect(js).not.toContain("route-attestation-run.js");
    expect(js).toEqual([
      "route-global.js",
      "dom-adapter.js",
      "turn-observer.js",
      "shadow-evidence.js",
      "composer-write-adapter.js",
      "send-click-adapter.js",
      "send-probe-message-global.js",
      "send-probe-run.js",
      "route-attestation-global.js",
      "route-attestation-run-global.js",
      "production-send-runtime-global.js",
      "content-script.js",
    ]);
    // Dependency order: dom/turn before attest-global; write/click before run-global; attest before run.
    expect(js.indexOf("dom-adapter.js")).toBeLessThan(js.indexOf("route-attestation-global.js"));
    expect(js.indexOf("turn-observer.js")).toBeLessThan(js.indexOf("route-attestation-global.js"));
    expect(js.indexOf("composer-write-adapter.js")).toBeLessThan(js.indexOf("route-attestation-run-global.js"));
    expect(js.indexOf("send-click-adapter.js")).toBeLessThan(js.indexOf("route-attestation-run-global.js"));
    expect(js.indexOf("route-attestation-global.js")).toBeLessThan(js.indexOf("route-attestation-run-global.js"));
    expect(js.indexOf("route-attestation-run-global.js")).toBeLessThan(js.indexOf("content-script.js"));
  });

  it("build script generates classic route-attestation artifacts with fail-fast gates", () => {
    const build = fs.readFileSync(path.join(projectRoot, "scripts", "build-browser-companion.mjs"), "utf8");
    expect(build).toMatch(/route-attestation-global\.js/);
    expect(build).toMatch(/route-attestation-run-global\.js/);
    expect(build).toMatch(/__c2cRunRouteAttestationSend/);
    expect(build).toMatch(/must not contain top-level import\/export|must not load ESM route-attestation/);
    expect(build).toMatch(/must keep ESM exports for SW\/tests/);
  });

  it("packaged classic chain can load: no import/export; ESM retained for SW/tests", () => {
    const distCompanion = path.join(projectRoot, "dist", "browser-companion");
    if (!fs.existsSync(path.join(distCompanion, "manifest.json"))) {
      expect(true).toBe(true);
      return;
    }
    const distManifest = JSON.parse(fs.readFileSync(path.join(distCompanion, "manifest.json"), "utf8"));
    const js = (distManifest.content_scripts ?? []).flatMap((cs: { js?: string[] }) => cs.js ?? []);
    expect(js).not.toContain("route-attestation.js");
    expect(js).not.toContain("route-attestation-run.js");
    expect(js).toContain("route-attestation-global.js");
    expect(js).toContain("route-attestation-run-global.js");

    for (const f of js) {
      const p = path.join(distCompanion, f);
      expect(fs.existsSync(p)).toBe(true);
      const text = fs.readFileSync(p, "utf8");
      expect(text).not.toMatch(/^\s*import\s/m);
      expect(text).not.toMatch(/^\s*export\s/m);
      expect(() => {
        // eslint-disable-next-line no-new-func
        new Function(text);
      }).not.toThrow();
    }

    const classicRun = fs.readFileSync(path.join(distCompanion, "route-attestation-run-global.js"), "utf8");
    expect(classicRun).toMatch(/globalThis\.__c2cRunRouteAttestationSend\s*=\s*runRouteAttestationSend/);
    expect(classicRun).toMatch(/globalThis\.__c2cResolveMutationCanonicalRoute/);
    expect(classicRun).not.toMatch(/globalThis\.resolveMutationCanonicalRoute\s*=/);
    const classicAttest = fs.readFileSync(path.join(distCompanion, "route-attestation-global.js"), "utf8");
    expect(classicAttest).toMatch(/globalThis\.(extractRouteChallengeId|findRouteAttestationUserTurn|isRouteAttestationMessage)/);

    const writeClassic = fs.readFileSync(path.join(distCompanion, "composer-write-adapter.js"), "utf8");
    expect(writeClassic).toMatch(/globalThis\.__c2cResolveMutationCanonicalRoute\s*=/);
    expect(writeClassic).not.toMatch(/globalThis\.resolveMutationCanonicalRoute\s*=/);

    const esmAttest = fs.readFileSync(path.join(distCompanion, "route-attestation.js"), "utf8");
    const esmRun = fs.readFileSync(path.join(distCompanion, "route-attestation-run.js"), "utf8");
    expect(esmAttest).toMatch(/^export\s/m);
    expect(esmRun).toMatch(/^export\s/m);
    expect(esmAttest).toMatch(/export function findRouteAttestationUserTurn/);
    expect(esmRun).toMatch(/export async function runRouteAttestationSend/);

    const cs = fs.readFileSync(path.join(distCompanion, "content-script.js"), "utf8");
    expect(cs).toMatch(/c2c\.route\.attest\.execute/);
    expect(cs).toMatch(/__c2cRunRouteAttestationSend/);

    // Existing production/send-probe classic artifacts remain classic.
    for (const f of [
      "send-probe-run.js",
      "production-send-runtime-global.js",
      "composer-write-adapter.js",
      "send-click-adapter.js",
    ]) {
      const text = fs.readFileSync(path.join(distCompanion, f), "utf8");
      expect(text).not.toMatch(/^\s*import\s/m);
      expect(text).not.toMatch(/^\s*export\s/m);
    }
  });

  it("build fails fast when runner deps or namespaced resolveMutation are missing", () => {
    const build = fs.readFileSync(path.join(projectRoot, "scripts", "build-browser-companion.mjs"), "utf8");
    expect(build).toMatch(/__c2cResolveMutationCanonicalRoute/);
    expect(build).toMatch(/must not expose unnamespaced resolveMutationCanonicalRoute/);
    expect(build).toMatch(/route-attest run dep/);
    expect(build).toMatch(/send-probe run dep/);
    expect(build).toMatch(/new Function\(text\)/);
    expect(build).toMatch(/send-probe-run\.js classic must be wrapped in IIFE/);
    for (const sym of [
      "resolveChatGptComposer",
      "resolveChatGptAction",
      "normalizeCanonicalDomText",
      "__c2cReadCanonicalComposerText",
      "__c2cWriteCanonicalMessage",
      "__c2cVerifyCanonicalComposer",
      "__c2cDispatchNativeSend",
      "__c2cResolveMutationCanonicalRoute",
      "extractRouteChallengeId",
      "findRouteAttestationUserTurn",
      "isRouteAttestationMessage",
      "snapshotUserTurns",
      "buildSendProbeMessage",
    ]) {
      expect(build).toContain(sym);
    }
  });

  it("packaged content-script chain loads in order and exposes attest runtime wiring", async () => {
    const distCompanion = path.join(projectRoot, "dist", "browser-companion");
    const distManifestPath = path.join(distCompanion, "manifest.json");
    if (!fs.existsSync(distManifestPath)) {
      expect(true).toBe(true);
      return;
    }
    const vm = await import("node:vm");
    const distManifest = JSON.parse(fs.readFileSync(distManifestPath, "utf8"));
    const js = (distManifest.content_scripts ?? []).flatMap((cs: { js?: string[] }) => cs.js ?? []);

    const listeners: unknown[] = [];
    const sandbox: Record<string, unknown> = {
      console,
      setTimeout: () => 0,
      setInterval: () => 0,
      clearTimeout: () => {},
      clearInterval: () => {},
    };
    const location = { href: "https://chatgpt.com/c/aaaaaaaa-1111-4111-8111-111111111111" };
    const windowObj: Record<string, unknown> = {
      addEventListener: () => {},
    };
    const documentObj = {
      hidden: false,
      addEventListener: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    const chrome = {
      runtime: {
        lastError: null,
        sendMessage: (_msg: unknown, cb?: (r: unknown) => void) => {
          if (typeof cb === "function") cb({ ok: true });
        },
        onMessage: {
          addListener: (fn: unknown) => {
            listeners.push(fn);
          },
        },
      },
    };
    sandbox.window = windowObj;
    sandbox.location = location;
    sandbox.document = documentObj;
    sandbox.chrome = chrome;
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    for (const f of js) {
      const text = fs.readFileSync(path.join(distCompanion, f), "utf8");
      expect(() => {
        // eslint-disable-next-line no-new-func
        new Function(text);
      }).not.toThrow();
      vm.runInContext(text, sandbox, { filename: f });
    }

    const g = sandbox as Record<string, unknown>;
    expect(typeof g.__c2cRunRouteAttestationSend).toBe("function");
    expect(typeof g.__c2cRunRealSendProbe).toBe("function");
    for (const sym of [
      "resolveChatGptComposer",
      "resolveChatGptAction",
      "normalizeCanonicalDomText",
      "__c2cReadCanonicalComposerText",
      "__c2cWriteCanonicalMessage",
      "__c2cVerifyCanonicalComposer",
      "__c2cDispatchNativeSend",
      "__c2cResolveMutationCanonicalRoute",
      "extractRouteChallengeId",
      "findRouteAttestationUserTurn",
      "isRouteAttestationMessage",
      "snapshotUserTurns",
      "buildSendProbeMessage",
    ]) {
      expect(typeof g[sym], `missing classic global ${sym}`).toBe("function");
    }
    expect(g.resolveMutationCanonicalRoute).toBeUndefined();
    expect(g.writeCanonicalMessage).toBeUndefined();
    expect(g.readCanonicalComposerText).toBeUndefined();
    expect(g.verifyCanonicalComposer).toBeUndefined();
    expect(listeners.length).toBeGreaterThan(0);

    // Exercise packaged classic send-probe runner through write/read/verify/route
    // without real click/network (send button stays not ready).
    const buildProbe = g.buildSendProbeMessage as (attemptId: string) => string;
    const runProbe = g.__c2cRunRealSendProbe as (
      doc: unknown,
      opts: Record<string, unknown>,
    ) => Promise<{ ok: boolean; reason?: string; wrote?: boolean; verified?: boolean; mutationAttempted?: boolean }>;
    const attemptId = "22222222-2222-4222-8222-222222222222";
    const probeMessage = buildProbe(attemptId);
    const route = "https://chatgpt.com/c/aaaaaaaa-1111-4111-8111-111111111111";

    const blocks = [""];
    const sendBtn = {
      tagName: "BUTTON",
      className: "composer-submit-btn composer-submit-button-color",
      getAttribute: (n: string) =>
        n === "data-testid" ? "send-button" : n === "type" ? "submit" : n === "aria-label" ? "发送提示词" : null,
      hasAttribute: (n: string) => n === "data-testid",
      disabled: false,
      click: () => {
        throw new Error("classic smoke must not click");
      },
    };
    const voice = {
      className: "composer-submit-button-color text-submit-btn-text",
      getAttribute: (n: string) => (n === "aria-label" ? "启动语音功能" : null),
      hasAttribute: () => false,
      disabled: false,
      click: () => {
        throw new Error("classic smoke must not click");
      },
    };
    const form = {
      querySelector(selector: string) {
        if (selector === 'button[data-testid="send-button"]') return null;
        if (selector === "button.composer-submit-button-color") return voice;
        return null;
      },
      querySelectorAll(selector: string) {
        return selector === "button" ? [voice] : [];
      },
    };
    const editor = {
      tagName: "DIV",
      id: "prompt-textarea",
      className: "ProseMirror",
      getAttribute: (n: string) => (n === "contenteditable" ? "true" : null),
      hasAttribute: () => false,
      closest: (s: string) => (s === "form" ? form : null),
      focus: () => {},
      get children() {
        return {
          length: blocks.length,
          ...Object.fromEntries(blocks.map((t, i) => [String(i), { tagName: "P", textContent: t }])),
        };
      },
      textContent: blocks.join(""),
    };
    const probeDoc = {
      defaultView: {
        getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
        Event: class Event {
          type: string;
          bubbles: boolean;
          constructor(type: string, init: { bubbles?: boolean } = {}) {
            this.type = type;
            this.bubbles = Boolean(init.bubbles);
          }
        },
      },
      createRange: () => ({ selectNodeContents() {} }),
      execCommand: (_c: string, _u: boolean, v: string) => {
        blocks.splice(0, blocks.length, ...String(v).split("\n"));
        return true;
      },
      queryCommandSupported: () => true,
      querySelector(selector: string) {
        if (selector === "#prompt-textarea" || selector.includes("ProseMirror") || selector.includes("contenteditable")) {
          return editor;
        }
        return null;
      },
      querySelectorAll: () => [],
    };

    const probeResult = await runProbe(probeDoc, {
      probeMessage,
      attemptId,
      expectedRoute: route,
      expectedGeneration: 1,
      locationHref: route,
      parseRoute: (href: string) => parseChatgptConversationRoute(href, {
        allowQueryOrHash: false,
        conversationIdPolicy: "uuid",
      }),
      getCurrentHref: () => route,
      getCurrentGeneration: () => 1,
      waitMs: async () => {},
      readyTimeoutMs: 200,
      pollMs: 10,
    });
    expect(probeResult.ok).toBe(false);
    // Far enough to use write/read/verify/route resolve; stop before click.
    expect(probeResult.reason).toBe("send_button_not_ready");
    expect(probeResult.mutationAttempted).toBe(true);
    expect(probeResult.wrote).toBe(true);
    expect(probeResult.verified).toBe(true);
  });
});

describe("route observer has no querySelectorAll fallback", () => {
  function makeDescendant(innerText: string) {
    return { innerText };
  }

  it("node with only querySelectorAll (no children) is not observed via wildcard scan", () => {
    // collectBoundedDescendants uses children BFS only. querySelectorAll must be ignored.
    const turn = {
      id: "qsa-only",
      text: `${ATTEST}\nCopy`,
      node: {
        children: [],
        querySelectorAll: () => [makeDescendant(ATTEST)],
      },
    };
    const found = findRouteAttestationUserTurn({
      turns: [turn],
      message: ATTEST,
      challengeId: CHALLENGE,
    });
    expect(found.ok).toBe(false);
    expect(found.reason).toBe("not_observed");
  });

  it("children BFS still observes exact descendant within ≤64", () => {
    const turn = {
      id: "bfs",
      text: `${ATTEST}\nCopy`,
      node: {
        children: [makeDescendant("Copy"), makeDescendant(ATTEST)],
      },
    };
    const found = findRouteAttestationUserTurn({
      turns: [turn],
      message: ATTEST,
      challengeId: CHALLENGE,
    });
    expect(found.ok).toBe(true);
  });
});
