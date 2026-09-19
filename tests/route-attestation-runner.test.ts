/**
 * Runner-level regression for G3 route attestation exact observation.
 * Production findCanonicalUserTurn ATTEMPT semantics are NOT used / not weakened.
 */
import { describe, expect, it, vi } from "vitest";
import { runRouteAttestationSend } from "../browser-companion/route-attestation-run.js";
import {
  canStartRouteAttestSend,
  emptyRouteAttestFence,
  emptyRouteAttestLatch,
  extractRouteChallengeId,
  extractRouteAttestHeaderArgs,
  extractRouteAttestToolCallArgs,
  findRouteAttestationUserTurn,
  hasExactRouteChallengeMarker,
  nextRouteAttestFenceAfterPair,
} from "../browser-companion/route-attestation.js";
import { normalizeCanonicalDomText } from "../browser-companion/dom-adapter.js";
import { formatRouteAttestationMessage } from "../src/feedback/store.js";

const CHALLENGE = "11111111-1111-4111-8111-111111111111";
const DIGEST = "a".repeat(64);
const ATTEST = formatRouteAttestationMessage(CHALLENGE, DIGEST);
const ROUTE = "https://chatgpt.com/c/aaaaaaaa-1111-4111-8111-111111111111";

function makeDoc() {
  return {};
}

function okDomDeps({ turnsAfterClick = [], extraSnapshots = [], normalizeText } = {}) {
  let snapCount = 0;
  return {
    expectedRoute: ROUTE,
    expectedGeneration: 3,
    attestationMessage: ATTEST,
    locationHref: ROUTE,
    getCurrentGeneration: () => 3,
    now: (() => {
      let t = 0;
      return () => {
        t += 200;
        return t;
      };
    })(),
    waitMs: async () => {},
    readyTimeoutMs: 2000,
    observeTimeoutMs: 400,
    ...(normalizeText ? { normalizeText } : {}),
    snapshotUserTurns: () => {
      snapCount += 1;
      // 1st call: baseline empty. Later calls: post-click turns.
      if (snapCount === 1) return [];
      if (extraSnapshots.length > 0 && snapCount - 2 < extraSnapshots.length) {
        return extraSnapshots[snapCount - 2];
      }
      return turnsAfterClick;
    },
  };
}

// Patch global write adapters used by runner via opts DI where possible.
async function runWithDom(opts) {
  const domAdapter = await import("../browser-companion/dom-adapter.js");
  const writeAdapter = await import("../browser-companion/composer-write-adapter.js");
  const clickAdapter = await import("../browser-companion/send-click-adapter.js");
  const writeProbe = await import("../browser-companion/write-probe.js");

  const editor = { __editor: true };
  vi.spyOn(domAdapter, "resolveChatGptComposer").mockReturnValue({ editor });
  vi.spyOn(domAdapter, "resolveChatGptAction").mockReturnValue({ kind: "idle", enabled: true });
  vi.spyOn(writeProbe, "resolveMutationCanonicalRoute").mockReturnValue({ ok: true, canonical: ROUTE });
  vi.spyOn(writeAdapter, "readCanonicalComposerText").mockReturnValue({ ok: true, text: "" });
  vi.spyOn(writeAdapter, "writeCanonicalMessage").mockImplementation(() => {
    if (opts.onWrite) opts.onWrite();
    return { ok: true, wrote: true, mutationAttempted: true };
  });
  vi.spyOn(writeAdapter, "verifyCanonicalComposer").mockReturnValue({ ok: true });
  vi.spyOn(clickAdapter, "dispatchNativeSend").mockImplementation(async () => {
    if (opts.onClick) opts.onClick();
    return { ok: true, clicked: true, reason: undefined };
  });

  try {
    return await runRouteAttestationSend(makeDoc(), opts.runner);
  } finally {
    vi.restoreAllMocks();
  }
}

function makeDescendant(innerText) {
  return { innerText };
}
function makeTurnNode({ children }) {
  // Production collectBoundedDescendants uses children BFS only — never querySelectorAll("*").
  return { children };
}

function ownerFixture() {
  return {
    tabId: 7,
    documentId: "doc-1",
    canonicalRoute: ROUTE,
    generation: 3,
  };
}

function transportFixture(overrides = {}) {
  return {
    authStale: false,
    routeCanonical: ROUTE,
    routeVerification: "PENDING",
    routeAttestationMessage: ATTEST,
    routeAttestationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function evidenceFixture() {
  return { safe: true, composer: "empty", generation: "idle" };
}

describe("route-attestation runner exact observation", () => {
  it("observer ok:false / missing challenge marker → never observed", async () => {
    const result = await runWithDom({
      onWrite: () => {},
      onClick: () => {},
      runner: {
        ...okDomDeps({ turnsAfterClick: [{ id: "x", text: "unrelated" }] }),
      },
    });
    expect(result.ok).toBe(false);
    expect(result.observed).toBe(false);
    expect(result.reason).toBe("route_attest_outcome_ambiguous");
    expect(result.clicked).toBe(true);
    expect(result.clickAttempted).toBe(true);
  });

  it("no new turn after click → ambiguous, no auto-retry", async () => {
    const result = await runWithDom({
      onWrite: () => {},
      onClick: () => {},
      runner: okDomDeps({ turnsAfterClick: [] }),
    });
    expect(result.ok).toBe(false);
    expect(result.observed).toBe(false);
    expect(result.reason).toBe("route_attest_outcome_ambiguous");
  });

  it("unique exact new USER turn with challengeId → observed", async () => {
    const result = await runWithDom({
      onWrite: () => {},
      onClick: () => {},
      runner: okDomDeps({
        turnsAfterClick: [{ id: "t1", text: ATTEST }],
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.observed).toBe(true);
    expect(result.clicked).toBe(true);
  });

  it("multiple matching turns → ambiguous fail closed", async () => {
    const result = await runWithDom({
      onWrite: () => {},
      onClick: () => {},
      runner: okDomDeps({
        turnsAfterClick: [
          { id: "t1", text: ATTEST },
          { id: "t2", text: ATTEST },
        ],
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.observed).toBe(false);
    expect(result.reason).toBe("route_attest_outcome_ambiguous");
  });

  it("route/generation drift after click → ambiguous", async () => {
    let gen = 3;
    const deps = okDomDeps({
      turnsAfterClick: [{ id: "t1", text: ATTEST }],
    });
    deps.getCurrentGeneration = () => {
      if (deps.__drift) return 99;
      return gen;
    };
    deps.now = (() => {
      let t = 0;
      return () => {
        t += 200;
        if (t > 200) deps.__drift = true;
        return t;
      };
    })();
    const result = await runWithDom({
      onWrite: () => {},
      onClick: () => {},
      runner: deps,
    });
    expect(result.ok).toBe(false);
    expect(result.observed).toBe(false);
  });

  it("pure observer: truthy {ok:false} is never success", () => {
    const failureLike = { ok: false, reason: "attempt_missing" };
    const found = findRouteAttestationUserTurn({
      turns: [{ id: "1", text: failureLike }],
      message: ATTEST,
      challengeId: CHALLENGE,
    });
    expect(found.ok).toBe(false);
    expect(extractRouteChallengeId(ATTEST)).toBe(CHALLENGE);
    expect(hasExactRouteChallengeMarker(ATTEST, CHALLENGE).ok).toBe(true);
    expect(hasExactRouteChallengeMarker(ATTEST, "22222222-2222-4222-8222-222222222222").ok).toBe(false);
  });

  it("live-like parent+chrome + 1 exact descendant → observed", () => {
    const parentText = `${ATTEST}\nCopy`;
    const turn = {
      id: "live1",
      text: parentText,
      node: makeTurnNode({ children: [makeDescendant("Copy"), makeDescendant(ATTEST)] }),
    };
    const found = findRouteAttestationUserTurn({
      turns: [turn],
      message: ATTEST,
      challengeId: CHALLENGE,
    });
    expect(found.ok).toBe(true);
  });

  it("same parent with 2–3 exact descendants → still one USER turn match", () => {
    const parentText = `${ATTEST}\nUI chrome`;
    const turn = {
      id: "live2",
      text: parentText,
      node: makeTurnNode({
        children: [makeDescendant(ATTEST), makeDescendant(ATTEST), makeDescendant(ATTEST), makeDescendant("Copy")],
      }),
    };
    const found = findRouteAttestationUserTurn({
      turns: [turn],
      message: ATTEST,
      challengeId: CHALLENGE,
    });
    expect(found.ok).toBe(true);
    expect(found.turn.id).toBe("live2");
  });

  it("two different USER turns each with exact descendant → ambiguous", () => {
    const parentText = `${ATTEST}\nchrome`;
    const t1 = {
      id: "u1",
      text: parentText,
      node: makeTurnNode({ children: [makeDescendant(ATTEST)] }),
    };
    const t2 = {
      id: "u2",
      text: parentText,
      node: makeTurnNode({ children: [makeDescendant(ATTEST)] }),
    };
    const found = findRouteAttestationUserTurn({
      turns: [t1, t2],
      message: ATTEST,
      challengeId: CHALLENGE,
    });
    expect(found.ok).toBe(false);
    expect(found.reason).toBe("ambiguous");
  });

  it("parent without challenge marker + descendant body → not observed (fail closed)", () => {
    const turn = {
      id: "live3",
      text: "some other user text without marker",
      node: makeTurnNode({
        children: [makeDescendant(ATTEST)],
      }),
    };
    const found = findRouteAttestationUserTurn({
      turns: [turn],
      message: ATTEST,
      challengeId: CHALLENGE,
    });
    expect(found.ok).toBe(false);
    expect(found.reason).toBe("not_observed");
  });

  it("descendant CRLF -> observed (canonical normalization, not raw innerText)", () => {
    const crlf = ATTEST.replace(/\n/g, "\r\n");
    const turn = {
      id: "crlf",
      text: `${ATTEST}\nCopy`,
      node: makeTurnNode({ children: [makeDescendant(crlf)] }),
    };
    // No custom normalizeText: default must be normalizeCanonicalDomText.
    const found = findRouteAttestationUserTurn({
      turns: [turn],
      message: ATTEST,
      challengeId: CHALLENGE,
    });
    expect(found.ok).toBe(true);
  });

  it("descendant NBSP -> observed", () => {
    const nbsp = ATTEST.replace(/ /g, "\u00a0");
    const turn = {
      id: "nbsp",
      text: `${ATTEST}\nCopy`,
      node: makeTurnNode({ children: [makeDescendant(nbsp)] }),
    };
    const found = findRouteAttestationUserTurn({
      turns: [turn],
      message: ATTEST,
      challengeId: CHALLENGE,
    });
    expect(found.ok).toBe(true);
  });

  it("parent text CRLF/NBSP also normalizes", () => {
    const parentCrlf = `${ATTEST.replace(/\n/g, "\r\n")}\nCopy`;
    const parentNbsp = `${ATTEST.replace(/ /g, "\u00a0")}\nCopy`;
    const t1 = {
      id: "p-crlf",
      text: parentCrlf,
      node: makeTurnNode({ children: [makeDescendant(ATTEST)] }),
    };
    const t2 = {
      id: "p-nbsp",
      text: parentNbsp,
      node: makeTurnNode({ children: [makeDescendant(ATTEST)] }),
    };
    expect(findRouteAttestationUserTurn({
      turns: [t1], message: ATTEST, challengeId: CHALLENGE,
    }).ok).toBe(true);
    expect(findRouteAttestationUserTurn({
      turns: [t2], message: ATTEST, challengeId: CHALLENGE,
    }).ok).toBe(true);
  });

  it("runner default normalizer handles descendant CRLF even without opts.normalizeText", async () => {
    const crlf = ATTEST.replace(/\n/g, "\r\n");
    const result = await runWithDom({
      onWrite: () => {},
      onClick: () => {},
      runner: okDomDeps({
        // Explicitly omit normalizeText — runner must default to normalizeCanonicalDomText.
        turnsAfterClick: [{
          id: "crlf-live",
          text: `${ATTEST}\nCopy`,
          node: makeTurnNode({ children: [makeDescendant(crlf)] }),
        }],
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.observed).toBe(true);
  });

  it("attestation body tool-call args match header lines exactly (actual values)", () => {
    expect(ATTEST).not.toMatch(/challengeId=\.\.\./);
    expect(ATTEST).not.toMatch(/challengeDigest=\.\.\./);
    const header = extractRouteAttestHeaderArgs(ATTEST);
    const call = extractRouteAttestToolCallArgs(ATTEST);
    expect(header).toEqual({ challengeId: CHALLENGE, challengeDigest: DIGEST });
    expect(call).toEqual(header);
    const lines = ATTEST.split("\n");
    expect(lines).toContain(`challengeId=${CHALLENGE}`);
    expect(lines).toContain(`challengeDigest=${DIGEST}`);
  });

  it("same challenge RPC loss after dispatch → second Verify blocked", () => {
    const blocked = canStartRouteAttestSend({
      owner: ownerFixture(),
      transport: transportFixture({ companionId: "comp-1" }),
      journal: { state: "NONE" },
      evidence: evidenceFixture(),
      latch: {
        state: "OUTCOME_UNKNOWN",
        challengeId: CHALLENGE,
        tabId: 7,
        documentId: "doc-1",
        canonicalRoute: ROUTE,
      },
      fence: {
        state: "OUTCOME_UNKNOWN",
        companionId: "comp-1",
        challengeId: CHALLENGE,
      },
      companionId: "comp-1",
      challengeId: CHALLENGE,
    });
    expect(blocked.ok).toBe(false);
    expect(["route_attest_latch_active", "route_attest_fence_active"]).toContain(blocked.reason);
  });

  it("ambiguous click → second Verify blocked", () => {
    const blocked = canStartRouteAttestSend({
      owner: ownerFixture(),
      transport: transportFixture({ companionId: "comp-1" }),
      journal: { state: "NONE" },
      evidence: evidenceFixture(),
      latch: emptyRouteAttestLatch(),
      fence: { state: "OUTCOME_UNKNOWN", companionId: "comp-1", challengeId: CHALLENGE },
      companionId: "comp-1",
      challengeId: CHALLENGE,
    });
    expect(blocked.ok).toBe(false);
  });

  it("re-pair new challenge after OUTCOME_UNKNOWN allows a fresh send path", () => {
    const nextChallenge = "33333333-3333-4333-8333-333333333333";
    const nextDigest = "c".repeat(64);
    const nextMsg = formatRouteAttestationMessage(nextChallenge, nextDigest);
    const fenceNext = nextRouteAttestFenceAfterPair({
      fence: {
        state: "OUTCOME_UNKNOWN",
        companionId: "comp-old",
        challengeId: CHALLENGE,
      },
      newCompanionId: "comp-new",
      newChallengeId: nextChallenge,
    });
    expect(fenceNext.ok).toBe(true);
    const allowed = canStartRouteAttestSend({
      owner: ownerFixture(),
      transport: transportFixture({
        routeAttestationMessage: nextMsg,
        companionId: "comp-new",
      }),
      journal: { state: "NONE" },
      evidence: evidenceFixture(),
      latch: emptyRouteAttestLatch(),
      fence: fenceNext.fence,
      companionId: "comp-new",
      challengeId: nextChallenge,
    });
    expect(allowed.ok).toBe(true);
  });

  it("durable fence blocks after simulated browser restart (session latch empty)", () => {
    for (const state of ["OUTCOME_UNKNOWN", "ROUTE_ATTEST_DISPATCH", "OBSERVED_PENDING_CONFIRM"]) {
      const blocked = canStartRouteAttestSend({
        owner: ownerFixture(),
        transport: transportFixture({ companionId: "comp-1" }),
        journal: { state: "NONE" },
        evidence: evidenceFixture(),
        latch: emptyRouteAttestLatch(),
        fence: {
          state,
          companionId: "comp-1",
          challengeId: CHALLENGE,
          routeCanonical: ROUTE,
        },
        companionId: "comp-1",
        challengeId: CHALLENGE,
      });
      expect(blocked.ok).toBe(false);
      expect(blocked.reason).toBe("route_attest_fence_active");
    }
  });

  it("identity normalizer override still works when explicitly provided", () => {
    const crlf = ATTEST.replace(/\n/g, "\r\n");
    const turn = {
      id: "raw",
      text: `${ATTEST}\nCopy`,
      node: makeTurnNode({ children: [makeDescendant(crlf)] }),
    };
    // Identity normalizer: raw inequality → false negative (proves default is NOT identity).
    const identity = findRouteAttestationUserTurn({
      turns: [turn],
      message: ATTEST,
      challengeId: CHALLENGE,
      normalizeText: (t) => (typeof t === "string" ? t : ""),
    });
    expect(identity.ok).toBe(false);
    // Canonical normalizer recovers.
    const canonical = findRouteAttestationUserTurn({
      turns: [turn],
      message: ATTEST,
      challengeId: CHALLENGE,
      normalizeText: normalizeCanonicalDomText,
    });
    expect(canonical.ok).toBe(true);
  });
});
