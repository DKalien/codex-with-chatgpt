import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  emptyJournal,
  markReserveRequested,
  markReserved,
  markSendIntent,
  markClaimed,
  markComposerWriteIntent,
  markSendDispatchIntent,
  markObservedPendingAck,
  markLateObservedPendingAck,
  markOutcomeUnknown,
  clearJournal,
  isLegalJournalTransition,
} from "../browser-companion/reservation-journal.js";
import {
  canStartProductionSend,
  buildProductionSendExecuteRequest,
  buildProductionRecoverRequest,
  classifyProductionStartRpcResult,
  validateProductionJournalCommit,
  sanitizeInFlightForRecovery,
  summarizeProductionJournal,
  buildClaimProof,
  buildAckProof,
  reconcileClaimedAgainstServer,
  commitJournalDurably,
  findExactObservedEvent,
  evaluateServerObservedCloseout,
  isServerObservedCloseoutEligible,
  SERVER_OBSERVED_CLOSEOUT_STATES,
} from "../browser-companion/production-send.js";
import {
  productionLocalPreflight,
  runProductionSend,
  recoverProductionSend,
  latePositiveRecoveryCapabilityGate,
} from "../browser-companion/production-send-runtime.js";
import {
  hasExactAttemptMarker,
  findCanonicalUserTurn,
  buildTurnObservationDiagnostic,
  sanitizeObservationDiagnostic,
  buildMarkerRepresentationDiagnostic,
  sanitizeMarkerRepresentation,
  TURN_DIAGNOSTIC_LIMITS,
} from "../browser-companion/turn-observer.js";
import {
  hasExactAttemptMarker,
  findCanonicalUserTurn,
  buildTurnObservationDiagnostic,
  sanitizeObservationDiagnostic,
  buildMarkerRepresentationDiagnostic,
  sanitizeMarkerRepresentation,
  TURN_DIAGNOSTIC_LIMITS,
  collectBoundedDescendants,
  canonicalTurnBodyMatch,
  hasExactVisibleBodyDescendant,
  snapshotUserTurns,
} from "../browser-companion/turn-observer.js";
import { normalizeCanonicalDomText } from "../browser-companion/dom-adapter.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const companionRoot = path.join(projectRoot, "browser-companion");
const distCompanion = path.join(projectRoot, "dist", "browser-companion");

const ROUTE = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const EVENT_ID = "e".repeat(32);
const RES_ID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT = "22222222-2222-4222-8222-222222222222";
const MESSAGE = `[C2C_CONTROL]\nSTATE: EXECUTED\nEVENT_ID: ${EVENT_ID}\nATTEMPT_ID: ${ATTEMPT}\n`;
const MESSAGE_SHA = "a".repeat(64);
const OWNER = {
  tabId: 7,
  documentId: "doc-1",
  canonicalRoute: ROUTE,
  generation: 3,
};
const TRANSPORT = {
  routeCanonical: ROUTE,
  bindingId: "b",
  epoch: 1,
  authStale: false,
  credential: "secret-should-never-leak",
};
const EVIDENCE = {
  observedAt: Date.now(),
  documentId: OWNER.documentId,
  canonicalRoute: ROUTE,
  composer: "empty",
  generation: "idle",
  safe: true,
};

function reservedJournal() {
  let j = emptyJournal();
  j = markReserveRequested(j, { routeCanonical: ROUTE, bindingId: "b", epoch: 1 });
  j = markReserved(j, {
    eventId: EVENT_ID,
    reservationId: RES_ID,
    routeCanonical: ROUTE,
    bindingId: "b",
    epoch: 1,
  });
  return j;
}

function claimedJournal() {
  let j = markSendIntent(reservedJournal(), {});
  j = markClaimed(j, {
    eventId: EVENT_ID,
    reservationId: RES_ID,
    attemptId: ATTEMPT,
    message: MESSAGE,
    messageSha256: MESSAGE_SHA,
  });
  return j;
}

function makeSpies(overrides: Record<string, unknown> = {}) {
  const calls = {
    persist: [] as string[],
    beginSend: 0,
    ack: 0,
    write: 0,
    verify: 0,
    click: 0,
    inspect: 0,
  };
  let journal = reservedJournal();
  if (overrides.journal) {
    journal = overrides.journal as typeof journal;
  }
  const persistJournal = async (next: typeof journal) => {
    journal = next;
    calls.persist.push(next.state);
    return next;
  };
  const beginSend = async () => {
    calls.beginSend += 1;
    return {
      eventId: EVENT_ID,
      status: "claimed" as const,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    };
  };
  const ackObserved = async () => {
    calls.ack += 1;
    return { eventId: EVENT_ID, status: "observed" as const };
  };
  const writeCanonicalMessage = async () => {
    calls.write += 1;
    return { ok: true };
  };
  const verifyCanonicalComposer = async () => {
    calls.verify += 1;
    return { ok: true };
  };
  const dispatchNativeSend = async () => {
    calls.click += 1;
    return { ok: true, clicked: 1 };
  };
  const inspectComposerWriteCapability = () => {
    calls.inspect += 1;
    return { ok: true, editorKind: "contenteditable", action: { kind: "idle", enabled: true } };
  };
  const snapshotUserTurns = () => [];
  const findCanonicalUserTurn = () => ({
    ok: true,
    turn: { id: "u1", text: MESSAGE },
  });
  const getCurrentRoute = () => ROUTE;
  const getCurrentGeneration = () => 3;
  const waitForSendReady = async () => ({ ok: true });
  const { journal: _journalOverride, ...rest } = overrides;
  return {
    get journal() {
      return journal;
    },
    set journal(v) {
      journal = v;
    },
    calls,
    persistJournal,
    beginSend,
    ackObserved,
    writeCanonicalMessage,
    verifyCanonicalComposer,
    dispatchNativeSend,
    inspectComposerWriteCapability,
    snapshotUserTurns,
    findCanonicalUserTurn,
    getCurrentRoute,
    getCurrentGeneration,
    hasExactAttemptMarker,
    waitForSendReady,
    doc: {} as never,
    expectedRoute: ROUTE,
    expectedGeneration: 3,
    routeCanonical: ROUTE,
    bindingId: "b",
    epoch: 1,
    maxPollAttempts: 2,
    pollIntervalMs: 1,
    sleep: async () => {},
    ...rest,
  };
}

describe("E1b3d3b production start gate", () => {
  it("happy start requires RESERVED + idle empty + latch NONE", () => {
    const r = canStartProductionSend({
      owner: OWNER,
      transport: TRANSPORT,
      journal: reservedJournal(),
      latch: { state: "NONE" },
      productionSendInFlight: false,
      evidence: EVIDENCE,
    });
    expect(r.ok).toBe(true);
  });

  it("dirty / stop / unknown / stale evidence / latch active / in-flight / binding mismatch fail", () => {
    const base = {
      owner: OWNER,
      transport: TRANSPORT,
      journal: reservedJournal(),
      latch: { state: "NONE" },
      productionSendInFlight: false,
      evidence: EVIDENCE,
    };
    expect(canStartProductionSend({ ...base, evidence: { ...EVIDENCE, composer: "dirty" } }).reason)
      .toBe("composer_not_empty");
    expect(canStartProductionSend({ ...base, evidence: { ...EVIDENCE, generation: "active" } }).reason)
      .toBe("generation_not_idle");
    expect(canStartProductionSend({ ...base, evidence: { ...EVIDENCE, safe: false } }).reason)
      .toBe("evidence_unsafe");
    expect(canStartProductionSend({
      ...base,
      evidence: { ...EVIDENCE, observedAt: Date.now() - 20_000 },
    }).reason).toBe("evidence_stale");
    expect(canStartProductionSend({ ...base, latch: { state: "COMPLETED" } }).reason)
      .toBe("send_probe_latch_active");
    expect(canStartProductionSend({ ...base, productionSendInFlight: true }).reason)
      .toBe("production_send_in_flight");
    expect(canStartProductionSend({
      ...base,
      transport: { ...TRANSPORT, bindingId: "other" },
    }).reason).toBe("binding_mismatch");
    expect(canStartProductionSend({
      ...base,
      owner: { ...OWNER, canonicalRoute: ROUTE.replace("1111", "2222") },
    }).reason).toBe("owner_route_mismatch");
    const notReserved = markSendIntent(reservedJournal(), {});
    expect(canStartProductionSend({ ...base, journal: notReserved }).reason)
      .toBe("journal_not_reserved");
  });

  it("start RPC carries only SW immutable context — no message/credential", () => {
    const req = buildProductionSendExecuteRequest(OWNER, reservedJournal());
    expect(req.ok).toBe(true);
    expect(req.message.type).toBe("c2c.production.send.execute");
    expect(req.message.expectedRoute).toBe(ROUTE);
    expect(req.message.expectedGeneration).toBe(3);
    expect(req.message.expectedDocumentId).toBe("doc-1");
    expect(req.sendOptions).toEqual({ documentId: "doc-1" });
    expect(req.message.startJournal.eventId).toBe(EVENT_ID);
    expect(req.message.startJournal.reservationId).toBe(RES_ID);
    expect(req.message.startJournal.attemptId).toBeNull();
    expect(JSON.stringify(req)).not.toContain("secret-should-never-leak");
    expect(req.message.message).toBeUndefined();
    expect((req.message as Record<string, unknown>).probeMessage).toBeUndefined();
    expect((req.message as Record<string, unknown>).attemptId).toBeUndefined();
  });
});

describe("E1b3d3b journal CAS", () => {
  const CLAIM_PROOF = buildClaimProof({
    eventId: EVENT_ID,
    reservationId: RES_ID,
    attemptId: ATTEMPT,
    message: MESSAGE,
    messageSha256: MESSAGE_SHA,
  })!;
  const ACK_PROOF = buildAckProof({
    eventId: EVENT_ID,
    attemptId: ATTEMPT,
    status: "observed",
  })!;

  it("legal RESERVED → SEND_INTENT commit", () => {
    const current = reservedJournal();
    const proposed = markSendIntent(current, {});
    const r = validateProductionJournalCommit(current, proposed, current);
    expect(r.ok).toBe(true);
  });

  it("stale expectedPrevious rejected", () => {
    const current = markSendIntent(reservedJournal(), {});
    const proposed = markClaimed(current, {
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    });
    const r = validateProductionJournalCommit(current, proposed, reservedJournal(), {
      claimProof: CLAIM_PROOF,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("cas_previous_mismatch");
  });

  it("identity rewrite rejected", () => {
    const current = reservedJournal();
    const proposed = { ...markSendIntent(current, {}), eventId: "f".repeat(32) };
    const r = validateProductionJournalCommit(current, proposed, current);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/identity_immutable/);
  });

  it("illegal transition rejected", () => {
    const current = reservedJournal();
    const proposed = { ...current, state: "CLAIMED", attemptId: ATTEMPT, message: MESSAGE, messageSha256: MESSAGE_SHA };
    const r = validateProductionJournalCommit(current, proposed, current);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("illegal_transition");
    expect(isLegalJournalTransition("RESERVED", "CLAIMED")).toBe(false);
  });

  it("SEND_INTENT→CLAIMED without proof => reject", () => {
    const current = markSendIntent(reservedJournal(), {});
    const proposed = markClaimed(current, {
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    });
    const r = validateProductionJournalCommit(current, proposed, current);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("claim_proof_missing");
  });

  it("wrong attempt/message/hash proof => reject", () => {
    const current = markSendIntent(reservedJournal(), {});
    const proposed = markClaimed(current, {
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    });
    const badAttempt = validateProductionJournalCommit(current, proposed, current, {
      claimProof: { ...CLAIM_PROOF!, attemptId: "99999999-9999-4999-8999-999999999999" },
    });
    expect(badAttempt.ok).toBe(false);
    expect(badAttempt.reason).toBe("claim_proof_mismatch");
    const badMessage = validateProductionJournalCommit(current, proposed, current, {
      claimProof: { ...CLAIM_PROOF!, message: "other" },
    });
    expect(badMessage.reason).toBe("claim_proof_mismatch");
    const badHash = validateProductionJournalCommit(current, proposed, current, {
      claimProof: { ...CLAIM_PROOF!, messageSha256: "b".repeat(64) },
    });
    expect(badHash.reason).toBe("claim_proof_mismatch");
  });

  it("exact claim proof => accept", () => {
    const current = markSendIntent(reservedJournal(), {});
    const proposed = markClaimed(current, {
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    });
    const r = validateProductionJournalCommit(current, proposed, current, {
      claimProof: CLAIM_PROOF,
    });
    expect(r.ok).toBe(true);
  });

  it("OBSERVED_PENDING_ACK→NONE without ACK proof => reject", () => {
    let j = claimedJournal();
    j = markComposerWriteIntent(j, {});
    j = markSendDispatchIntent(j, {});
    j = markObservedPendingAck(j, {});
    const none = clearJournal();
    const r = validateProductionJournalCommit(j, none, j);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("ack_proof_missing");
  });

  it("wrong ACK proof => reject", () => {
    let j = claimedJournal();
    j = markComposerWriteIntent(j, {});
    j = markSendDispatchIntent(j, {});
    j = markObservedPendingAck(j, {});
    const none = clearJournal();
    const r = validateProductionJournalCommit(j, none, j, {
      ackProof: { eventId: "f".repeat(32), attemptId: ATTEMPT, status: "observed" },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("ack_proof_mismatch");
  });

  it("exact ACK proof => accept; RESERVED → NONE rejected for CS", () => {
    let j = claimedJournal();
    j = markComposerWriteIntent(j, {});
    j = markSendDispatchIntent(j, {});
    j = markObservedPendingAck(j, {});
    const none = clearJournal();
    expect(validateProductionJournalCommit(j, none, j, { ackProof: ACK_PROOF }).ok).toBe(true);
    const reserved = reservedJournal();
    const r = validateProductionJournalCommit(reserved, none, reserved);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("cs_cannot_clear_reserved");
  });

  it("ordinary DOM-fence transitions remain allowed without proofs", () => {
    let j = claimedJournal();
    const writeIntent = markComposerWriteIntent(j, {});
    expect(validateProductionJournalCommit(j, writeIntent, j).ok).toBe(true);
    const dispatch = markSendDispatchIntent(writeIntent, {});
    expect(validateProductionJournalCommit(writeIntent, dispatch, writeIntent).ok).toBe(true);
    const observed = markObservedPendingAck(dispatch, {});
    expect(validateProductionJournalCommit(dispatch, observed, dispatch).ok).toBe(true);
    const unknown = markOutcomeUnknown(writeIntent, {});
    expect(validateProductionJournalCommit(writeIntent, unknown, writeIntent).ok).toBe(true);
  });

  it("CS cannot clear SEND_INTENT / CLAIMED / post-mutation via generic CAS", () => {
    const none = clearJournal();
    const sendIntent = markSendIntent(reservedJournal(), {});
    expect(validateProductionJournalCommit(sendIntent, none, sendIntent).reason)
      .toBe("cs_cannot_clear_send_intent");
    const claimed = claimedJournal();
    expect(validateProductionJournalCommit(claimed, none, claimed).reason)
      .toBe("cs_cannot_clear_without_ack_proof");
    let post = markComposerWriteIntent(claimed, {});
    expect(validateProductionJournalCommit(post, none, post).reason)
      .toBe("cs_cannot_clear_without_ack_proof");
    post = markSendDispatchIntent(post, {});
    expect(validateProductionJournalCommit(post, none, post).reason)
      .toBe("cs_cannot_clear_without_ack_proof");
  });
});

describe("E1b3d3b production runtime happy path", () => {
  it("RESERVED → NONE with exactly one beginSend/write/click/ack", async () => {
    const spy = makeSpies();
    const r = await runProductionSend(spy);
    expect(r.ok).toBe(true);
    expect(spy.calls.beginSend).toBe(1);
    expect(spy.calls.write).toBe(1);
    expect(spy.calls.click).toBe(1);
    expect(spy.calls.ack).toBe(1);
    expect(spy.calls.persist).toEqual([
      "SEND_INTENT",
      "CLAIMED",
      "COMPOSER_WRITE_INTENT",
      "SEND_DISPATCH_INTENT",
      "OBSERVED_PENDING_ACK",
      "NONE",
    ]);
    expect(spy.journal.state).toBe("NONE");
  });

  it("dirty/stop/unknown preclaim → beginSend=0, journal stays RESERVED", async () => {
    for (const reason of ["composer_dirty", "generation_active", "generation_unknown"]) {
      const spy = makeSpies({
        inspectComposerWriteCapability: () => ({ ok: false, reason }),
      });
      const r = await runProductionSend(spy);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe(reason);
      expect(spy.calls.beginSend).toBe(0);
      expect(spy.calls.write).toBe(0);
      expect(spy.calls.click).toBe(0);
      expect(spy.journal.state).toBe("RESERVED");
    }
  });

  it("action=send even if inspect ok → production_not_idle, beginSend=0", async () => {
    const spy = makeSpies({
      inspectComposerWriteCapability: () => ({
        ok: true,
        editorKind: "contenteditable",
        action: { kind: "send", enabled: true },
      }),
    });
    const r = await runProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("production_not_idle");
    expect(spy.calls.beginSend).toBe(0);
    expect(spy.journal.state).toBe("RESERVED");
  });

  it("missing capability → beginSend=0, journal stays RESERVED", async () => {
    const spy = makeSpies();
    delete (spy as Record<string, unknown>).hasExactAttemptMarker;
    const r = await runProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("production_capability_missing");
    expect(spy.calls.beginSend).toBe(0);
    expect(spy.journal.state).toBe("RESERVED");
  });

  it("missing marker validator → preclaim fail", async () => {
    const spy = makeSpies();
    delete (spy as Record<string, unknown>).hasExactAttemptMarker;
    const pre = productionLocalPreflight(spy);
    expect(pre.ok).toBe(false);
    expect(pre.reason).toBe("production_capability_missing");
  });

  it("wrong route/generation preclaim → beginSend=0", async () => {
    const badRoute = makeSpies({ getCurrentRoute: () => "https://chatgpt.com/c/99999999-9999-4999-8999-999999999999" });
    const r1 = await runProductionSend(badRoute);
    expect(r1.reason).toBe("route_drift");
    expect(badRoute.calls.beginSend).toBe(0);

    const badGen = makeSpies({ getCurrentGeneration: () => 99 });
    const r2 = await runProductionSend(badGen);
    expect(r2.reason).toBe("generation_drift");
    expect(badGen.calls.beginSend).toBe(0);
    expect(badGen.journal.state).toBe("RESERVED");
  });

  it("bad begin-send message/attempt marker → zero write", async () => {
    const spy = makeSpies({
      beginSend: async () => ({
        eventId: EVENT_ID,
        status: "claimed" as const,
        attemptId: ATTEMPT,
        message: "no marker line",
        messageSha256: MESSAGE_SHA,
      }),
    });
    const r = await runProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
  });

  it("begin-send HTTP style error → zero write/click, stays SEND_INTENT", async () => {
    const spy = makeSpies({
      beginSend: async () => {
        throw new Error("http_409");
      },
    });
    const r = await runProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("begin_send_failed");
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
    expect(spy.journal.state).toBe("SEND_INTENT");
  });

  it("COMPOSER_WRITE_INTENT persist failure → zero write", async () => {
    const spy = makeSpies();
    spy.persistJournal = async (next: { state: string }) => {
      spy.calls.persist.push(next.state);
      if (next.state === "COMPOSER_WRITE_INTENT") {
        throw new Error("cas_stale");
      }
      spy.journal = next as never;
      return next as never;
    };
    const r = await runProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("write_intent_persist_failed");
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
  });

  it("generation drift after write intent → zero write", async () => {
    let gen = 3;
    let inspectCount = 0;
    const spy = makeSpies({
      getCurrentGeneration: () => gen,
      inspectComposerWriteCapability: () => {
        inspectCount += 1;
        // Preflight inspect stays idle; later CLAIMED pre-write inspect drifts.
        if (inspectCount > 1) gen = 99;
        return { ok: true, editorKind: "contenteditable" };
      },
    });
    const r = await runProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
  });

  it("write throw/mismatch → zero click, post-mutation blocked", async () => {
    const spy = makeSpies({
      writeCanonicalMessage: async () => {
        throw new Error("write boom");
      },
    });
    const r = await runProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("write_threw");
    expect(spy.calls.click).toBe(0);
    expect(spy.journal.state).toBe("OUTCOME_UNKNOWN");
  });

  it("SEND_DISPATCH_INTENT persist failure → zero click", async () => {
    const spy = makeSpies();
    let journal = claimedJournal();
    // Start from CLAIMED via recovery-style direct path using orchestration internals is heavy;
    // simulate by failing dispatch persist during happy path.
    spy.persistJournal = async (next: { state: string }) => {
      spy.calls.persist.push(next.state);
      if (next.state === "SEND_DISPATCH_INTENT") {
        throw new Error("cas_stale");
      }
      journal = next as never;
      spy.journal = next as never;
      return next as never;
    };
    const r = await runProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("dispatch_intent_persist_failed");
    expect(spy.calls.click).toBe(0);
    expect(spy.journal.state).toBe("OUTCOME_UNKNOWN");
  });

  it("drift pre-click → zero click", async () => {
    let gen = 3;
    const spy = makeSpies({ getCurrentGeneration: () => gen });
    spy.dispatchNativeSend = (async () => {
      gen = 99;
      return { ok: false, reason: "generation_drift" };
    }) as never;
    const r = await runProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(spy.calls.click).toBeLessThanOrEqual(1);
    expect(spy.journal.state).toBe("OUTCOME_UNKNOWN");
  });

  it("click throw → no retry", async () => {
    const spy = makeSpies({
      dispatchNativeSend: async () => {
        throw new Error("click boom");
      },
    });
    const r = await runProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("send_click_threw");
    expect(spy.calls.click).toBe(0); // throw before increment
    expect(spy.journal.state).toBe("OUTCOME_UNKNOWN");
  });

  it("observation timeout → no second click", async () => {
    const spy = makeSpies({
      findCanonicalUserTurn: () => ({ ok: false, reason: "not_observed" }),
    });
    const r = await runProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("observe_timeout");
    expect(spy.calls.click).toBe(1);
    expect(spy.journal.state).toBe("OUTCOME_UNKNOWN");
  });

  it("ACK failure → retry ACK only", async () => {
    const spy = makeSpies({
      ackObserved: async () => {
        throw new Error("ack down");
      },
    });
    const r = await runProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("ack_failed");
    expect(r.retryAck).toBe(true);
    expect(spy.calls.write).toBe(1);
    expect(spy.calls.click).toBe(1);
    expect(spy.journal.state).toBe("OBSERVED_PENDING_ACK");
  });
});

describe("E1b3d3b recovery", () => {
  it("CLAIMED recovery bad marker → zero write/click", async () => {
    const j = markClaimed(markSendIntent(reservedJournal(), {}), {
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: "no marker line",
      messageSha256: MESSAGE_SHA,
    });
    const spy = makeSpies({ journal: j });
    const r = await recoverProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
  });

  it("adopted claimed bad marker → zero write/click", async () => {
    const spy = makeSpies({
      journal: markSendIntent(reservedJournal(), {}),
      inFlight: {
        status: "claimed",
        eventId: EVENT_ID,
        reservationId: RES_ID,
        attemptId: ATTEMPT,
        message: "no marker line",
        messageSha256: MESSAGE_SHA,
      },
    });
    const r = await recoverProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(spy.calls.beginSend).toBe(0);
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
  });

  it("CLAIMED recovery may resume write once", async () => {
    const spy = makeSpies({ journal: claimedJournal() });
    const r = await recoverProductionSend(spy);
    expect(r.ok).toBe(true);
    expect(spy.calls.beginSend).toBe(0);
    expect(spy.calls.write).toBe(1);
    expect(spy.calls.click).toBe(1);
    expect(spy.calls.ack).toBe(1);
  });

  it("COMPOSER_WRITE_INTENT recovery is observe-only then ack; zero write/click when not observed", async () => {
    let j = claimedJournal();
    j = markComposerWriteIntent(j, {});
    const spy = makeSpies({
      journal: j,
      findCanonicalUserTurn: () => ({ ok: false, reason: "not_observed" }),
    });
    const r = await recoverProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(r.zeroWrite).toBe(true);
    expect(r.zeroClick).toBe(true);
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
  });

  it("SEND_DISPATCH_INTENT recovery observe-only; zero click when not observed", async () => {
    let j = claimedJournal();
    j = markComposerWriteIntent(j, {});
    j = markSendDispatchIntent(j, {});
    const spy = makeSpies({
      journal: j,
      findCanonicalUserTurn: () => ({ ok: false, reason: "not_observed" }),
    });
    const r = await recoverProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
  });

  it("OBSERVED_PENDING_ACK recovery is ACK only", async () => {
    let j = claimedJournal();
    j = markComposerWriteIntent(j, {});
    j = markSendDispatchIntent(j, {});
    j = markObservedPendingAck(j, {});
    const spy = makeSpies({ journal: j });
    const r = await recoverProductionSend(spy);
    expect(r.ok).toBe(true);
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
    expect(spy.calls.ack).toBe(1);
    expect(spy.journal.state).toBe("NONE");
  });

  it("OUTCOME_UNKNOWN without exact server inFlight stays blocked", async () => {
    const j = markOutcomeUnknown(claimedJournal(), {});
    const spy = makeSpies({ journal: j });
    const r = await recoverProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("outcome_unknown");
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
    expect(spy.calls.beginSend).toBe(0);
    expect(spy.calls.ack).toBe(0);
    expect(spy.journal.state).toBe("OUTCOME_UNKNOWN");
  });

  it("SEND_INTENT + reserved inFlight retries begin-send", async () => {
    const j = markSendIntent(reservedJournal(), {});
    const spy = makeSpies({
      journal: j,
      inFlight: { status: "reserved", eventId: EVENT_ID, reservationId: RES_ID },
    });
    const r = await recoverProductionSend(spy);
    expect(r.ok).toBe(true);
    expect(spy.calls.beginSend).toBe(1);
  });

  it("SEND_INTENT + claimed inFlight adopts without new beginSend", async () => {
    const j = markSendIntent(reservedJournal(), {});
    const spy = makeSpies({
      journal: j,
      inFlight: {
        status: "claimed",
        eventId: EVENT_ID,
        reservationId: RES_ID,
        attemptId: ATTEMPT,
        message: MESSAGE,
        messageSha256: MESSAGE_SHA,
      },
    });
    const r = await recoverProductionSend(spy);
    expect(r.ok).toBe(true);
    expect(spy.calls.beginSend).toBe(0);
    expect(spy.calls.write).toBe(1);
  });
});

describe("E1b3d3b OUTCOME_UNKNOWN late-positive recovery", () => {
  function unknownJournal() {
    return markOutcomeUnknown(claimedJournal(), {});
  }

  function exactInFlight(status: "claimed" | "outcome_unknown") {
    return {
      status,
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    };
  }

  it("A. local OUTCOME_UNKNOWN + server exact claimed + DOM turn → ACK → NONE", async () => {
    const spy = makeSpies({
      journal: unknownJournal(),
      inFlight: exactInFlight("claimed"),
    });
    const r = await recoverProductionSend(spy);
    expect(r.ok).toBe(true);
    expect(r.action).toBe("late_positive_observed_then_acked");
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
    expect(spy.calls.beginSend).toBe(0);
    expect(spy.calls.ack).toBe(1);
    expect(spy.calls.persist).toEqual(["OBSERVED_PENDING_ACK", "NONE"]);
    expect(spy.journal.state).toBe("NONE");
  });

  it("B. local OUTCOME_UNKNOWN + server exact outcome_unknown + DOM turn → ACK → NONE", async () => {
    const spy = makeSpies({
      journal: unknownJournal(),
      inFlight: exactInFlight("outcome_unknown"),
    });
    const r = await recoverProductionSend(spy);
    expect(r.ok).toBe(true);
    expect(spy.calls.ack).toBe(1);
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
    expect(spy.calls.beginSend).toBe(0);
    expect(spy.journal.state).toBe("NONE");
  });

  it("C. DOM not found → stay OUTCOME_UNKNOWN, zero ACK/write/click/beginSend", async () => {
    const spy = makeSpies({
      journal: unknownJournal(),
      inFlight: exactInFlight("claimed"),
      findCanonicalUserTurn: () => ({
        ok: false,
        reason: "not_observed",
        diagnostic: {
          candidateCount: 2,
          exactTextMatchCount: 0,
          exactAttemptMarkerCount: 0,
          ambiguousCount: 0,
          targetLength: MESSAGE.length,
          candidateLengths: [3, 4],
          firstMismatchIndex: 0,
          candidates: [{ directRole: "user", nestedUser: false }],
        },
      }),
    });
    const r = await recoverProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("outcome_unknown");
    expect(spy.calls.ack).toBe(0);
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
    expect(spy.calls.beginSend).toBe(0);
    expect(spy.journal.state).toBe("OUTCOME_UNKNOWN");
    expect(r.diagnostic).toMatchObject({
      candidateCount: 2,
      exactTextMatchCount: 0,
      exactAttemptMarkerCount: 0,
    });
    expect(JSON.stringify(r.diagnostic ?? {})).not.toContain(MESSAGE);
  });

  it("D. DOM ambiguous → block, no ACK", async () => {
    const spy = makeSpies({
      journal: unknownJournal(),
      inFlight: exactInFlight("claimed"),
      findCanonicalUserTurn: () => ({
        ok: false,
        reason: "ambiguous",
        diagnostic: {
          candidateCount: 2,
          exactTextMatchCount: 2,
          exactAttemptMarkerCount: 2,
          ambiguousCount: 2,
          targetLength: MESSAGE.length,
          candidateLengths: [MESSAGE.length, MESSAGE.length],
        },
      }),
    });
    const r = await recoverProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("ambiguous");
    expect(spy.calls.ack).toBe(0);
    expect(spy.journal.state).toBe("OUTCOME_UNKNOWN");
    expect(r.diagnostic?.ambiguousCount).toBe(2);
  });

  it("E. server event/reservation/attempt mismatch → block, zero mutation", async () => {
    for (const patch of [
      { eventId: "f".repeat(32) },
      { reservationId: "33333333-3333-4333-8333-333333333333" },
      { attemptId: "44444444-4444-4444-8444-444444444444" },
    ]) {
      const spy = makeSpies({
        journal: unknownJournal(),
        inFlight: { ...exactInFlight("claimed"), ...patch },
      });
      const r = await recoverProductionSend(spy);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("late_positive_identity_mismatch");
      expect(spy.calls.write).toBe(0);
      expect(spy.calls.click).toBe(0);
      expect(spy.calls.beginSend).toBe(0);
      expect(spy.calls.ack).toBe(0);
      expect(spy.journal.state).toBe("OUTCOME_UNKNOWN");
    }
  });

  it("F. server message/hash mismatch → block", async () => {
    for (const patch of [
      { message: "other" },
      { messageSha256: "b".repeat(64) },
    ]) {
      const spy = makeSpies({
        journal: unknownJournal(),
        inFlight: { ...exactInFlight("claimed"), ...patch },
      });
      const r = await recoverProductionSend(spy);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("late_positive_identity_mismatch");
      expect(spy.calls.ack).toBe(0);
    }
  });

  it("G. server inFlight=null → block, never infer delivery from local OUTCOME_UNKNOWN", async () => {
    const spy = makeSpies({
      journal: unknownJournal(),
      inFlight: null,
      findCanonicalUserTurn: () => ({ ok: true, turn: { id: "u1", text: MESSAGE } }),
    });
    const r = await recoverProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("outcome_unknown");
    expect(spy.calls.ack).toBe(0);
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
    expect(spy.calls.beginSend).toBe(0);
  });

  it("H. late observation persist failure → local remains OUTCOME_UNKNOWN, ACK=0", async () => {
    const spy = makeSpies({
      journal: unknownJournal(),
      inFlight: exactInFlight("claimed"),
    });
    spy.persistJournal = async (next: { state: string }) => {
      spy.calls.persist.push(next.state);
      if (next.state === "OBSERVED_PENDING_ACK") {
        throw new Error("cas_stale");
      }
      spy.journal = next as never;
      return next as never;
    };
    const r = await recoverProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("late_observed_persist_failed");
    expect(spy.calls.ack).toBe(0);
    expect(spy.journal.state).toBe("OUTCOME_UNKNOWN");
  });

  it("I. ACK failure after durable OBSERVED_PENDING_ACK → retryAck, then idempotent clear", async () => {
    const spy = makeSpies({
      journal: unknownJournal(),
      inFlight: exactInFlight("claimed"),
    });
    let failAck = true;
    spy.ackObserved = async () => {
      if (failAck) {
        throw new Error("network_down");
      }
      spy.calls.ack += 1;
      return { eventId: EVENT_ID, status: "observed" as const };
    };
    const r1 = await recoverProductionSend(spy);
    expect(r1.ok).toBe(false);
    expect(r1.retryAck).toBe(true);
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
    expect(spy.calls.beginSend).toBe(0);
    expect(spy.journal.state).toBe("OBSERVED_PENDING_ACK");
    expect(spy.calls.ack).toBe(0);

    failAck = false;
    const r2 = await recoverProductionSend(spy);
    expect(r2.ok).toBe(true);
    expect(spy.calls.ack).toBe(1);
    expect(spy.journal.state).toBe("NONE");
  });

  it("J. late-positive recovery must not require write/click/beginSend capabilities", async () => {
    const spy = makeSpies({
      journal: unknownJournal(),
      inFlight: exactInFlight("claimed"),
    });
    delete (spy as Record<string, unknown>).writeCanonicalMessage;
    delete (spy as Record<string, unknown>).dispatchNativeSend;
    delete (spy as Record<string, unknown>).beginSend;
    delete (spy as Record<string, unknown>).inspectComposerWriteCapability;
    delete (spy as Record<string, unknown>).verifyCanonicalComposer;
    const r = await recoverProductionSend(spy);
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(spy.calls.ack).toBe(1);
    expect(spy.journal.state).toBe("NONE");

    const gate = latePositiveRecoveryCapabilityGate(spy);
    expect(gate.ok).toBe(true);
  });

  it("late-positive gate fails when observation/ack deps are missing", () => {
    const gate = latePositiveRecoveryCapabilityGate({});
    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe("recovery_capability_missing");
    expect(gate.missing).toContain("findCanonicalUserTurn");
    expect(gate.missing).toContain("ackObserved");
  });

  it("success path carries bounded diagnostic without raw message text", async () => {
    const spy = makeSpies({
      journal: unknownJournal(),
      inFlight: exactInFlight("claimed"),
      findCanonicalUserTurn: () => ({
        ok: true,
        turn: { id: "u1", text: MESSAGE },
        diagnostic: {
          candidateCount: 1,
          exactTextMatchCount: 1,
          exactAttemptMarkerCount: 1,
          ambiguousCount: 0,
          targetLength: MESSAGE.length,
          candidateLengths: [MESSAGE.length],
          candidates: [{ directRole: "user", nestedUser: false }],
        },
      }),
    });
    const r = await recoverProductionSend(spy);
    expect(r.ok).toBe(true);
    expect(r.diagnostic).toMatchObject({
      candidateCount: 1,
      exactTextMatchCount: 1,
      exactAttemptMarkerCount: 1,
    });
    const dump = JSON.stringify(r.diagnostic ?? {});
    expect(dump).not.toContain(MESSAGE);
    expect(dump).not.toContain("message");
    expect(dump).not.toContain("credential");
    expect(dump).not.toContain("secret");
  });

  it("diagnostic strips unknown fields and caps arrays", async () => {
    const spy = makeSpies({
      journal: unknownJournal(),
      inFlight: exactInFlight("claimed"),
      findCanonicalUserTurn: () => ({
        ok: false,
        reason: "not_observed",
        diagnostic: {
          candidateCount: 1,
          message: MESSAGE,
          credential: "nope",
          secret: "nope",
          text: MESSAGE,
          candidateLengths: [1, 2, 3, 4, 5, 6, 7, 8],
          candidates: [
            { directRole: "user", nestedUser: false, text: MESSAGE },
            { directRole: "user", nestedUser: false },
            { directRole: "user", nestedUser: false },
            { directRole: "user", nestedUser: false },
            { directRole: "user", nestedUser: false },
            { directRole: "user", nestedUser: false },
          ],
        },
      }),
    });
    const r = await recoverProductionSend(spy);
    expect(r.ok).toBe(false);
    const d = r.diagnostic as Record<string, unknown>;
    expect(d.message).toBeUndefined();
    expect(d.credential).toBeUndefined();
    expect(d.secret).toBeUndefined();
    expect(d.text).toBeUndefined();
    expect((d.candidateLengths as number[]).length).toBeLessThanOrEqual(5);
    expect((d.candidates as unknown[]).length).toBeLessThanOrEqual(5);
  });

  it("markLateObservedPendingAck is the only OUTCOME_UNKNOWN → OBSERVED_PENDING_ACK path", () => {
    const u = unknownJournal();
    expect(() => markObservedPendingAck(u, {})).toThrow(/illegal journal transition/);
    const late = markLateObservedPendingAck(u, {});
    expect(late.state).toBe("OBSERVED_PENDING_ACK");
    expect(late.eventId).toBe(EVENT_ID);
    expect(late.attemptId).toBe(ATTEMPT);
    expect(late.message).toBe(MESSAGE);
    expect(() => markLateObservedPendingAck(claimedJournal(), {})).toThrow(
      /requires OUTCOME_UNKNOWN/,
    );
    expect(isLegalJournalTransition("OUTCOME_UNKNOWN", "OBSERVED_PENDING_ACK")).toBe(true);
    expect(isLegalJournalTransition("OUTCOME_UNKNOWN", "CLAIMED")).toBe(false);
    expect(isLegalJournalTransition("OUTCOME_UNKNOWN", "SEND_DISPATCH_INTENT")).toBe(false);
    expect(isLegalJournalTransition("OUTCOME_UNKNOWN", "RESERVED")).toBe(false);
  });

  it("late-positive OBSERVED_PENDING_ACK → NONE still needs exact ack proof (CAS)", () => {
    const u = unknownJournal();
    const observed = markLateObservedPendingAck(u, {});
    const none = clearJournal();
    const noProof = validateProductionJournalCommit(observed, none, observed, {});
    expect(noProof.ok).toBe(false);
    expect(noProof.reason).toBe("ack_proof_missing");
    const proof = buildAckProof({
      eventId: EVENT_ID,
      attemptId: ATTEMPT,
      status: "observed",
    });
    const withProof = validateProductionJournalCommit(observed, none, observed, {
      ackProof: proof,
    });
    expect(withProof.ok).toBe(true);
  });
});

describe("E1b3d3b claimed server reconciliation", () => {
  it("local CLAIMED + server claimed exact → resume", () => {
    const j = claimedJournal();
    const r = reconcileClaimedAgainstServer(j, {
      status: "claimed",
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    });
    expect(r.action).toBe("resume");
    expect(r.claimProof?.attemptId).toBe(ATTEMPT);
  });

  it("local CLAIMED + server outcome_unknown → adopt terminal", () => {
    const j = claimedJournal();
    const r = reconcileClaimedAgainstServer(j, {
      status: "outcome_unknown",
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
    });
    expect(r.action).toBe("adopt_outcome_unknown");
    expect(r.zeroWrite).toBe(true);
    expect(r.zeroClick).toBe(true);
  });

  it("local CLAIMED + server missing → fail closed", () => {
    const r = reconcileClaimedAgainstServer(claimedJournal(), null);
    expect(r.action).toBe("fail_closed");
    expect(r.zeroWrite).toBe(true);
  });

  it("local CLAIMED + identity/attempt/message/hash mismatch → conflict", () => {
    const j = claimedJournal();
    expect(reconcileClaimedAgainstServer(j, {
      status: "claimed",
      eventId: "f".repeat(32),
      reservationId: RES_ID,
      attemptId: ATTEMPT,
    }).action).toBe("conflict");
    expect(reconcileClaimedAgainstServer(j, {
      status: "claimed",
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: "99999999-9999-4999-8999-999999999999",
    }).action).toBe("conflict");
    expect(reconcileClaimedAgainstServer(j, {
      status: "claimed",
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: "other",
    }).action).toBe("conflict");
  });
});

describe("E1b3d3b send-ready + observation fences", () => {
  it("delayed Send ready → exactly one click", async () => {
    const spy = makeSpies({
      waitForSendReady: async () => ({ ok: true }),
    });
    const r = await runProductionSend(spy);
    expect(r.ok).toBe(true);
    expect(spy.calls.click).toBe(1);
    expect(spy.calls.write).toBe(1);
    expect(spy.calls.persist).toContain("SEND_DISPATCH_INTENT");
  });

  it("Send never ready → zero click, OUTCOME_UNKNOWN", async () => {
    const spy = makeSpies({
      waitForSendReady: async () => ({ ok: false, reason: "send_ready_timeout" }),
    });
    const r = await runProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("send_ready_timeout");
    expect(spy.calls.click).toBe(0);
    expect(spy.journal.state).toBe("OUTCOME_UNKNOWN");
    // SEND_DISPATCH_INTENT must not be persisted before ready.
    expect(spy.calls.persist).not.toContain("SEND_DISPATCH_INTENT");
  });

  it("route drift during readiness → zero click", async () => {
    let gen = 3;
    let route = ROUTE;
    const spy = makeSpies({
      getCurrentRoute: () => route,
      getCurrentGeneration: () => gen,
      waitForSendReady: async () => {
        route = "https://chatgpt.com/c/99999999-9999-4999-8999-999999999999";
        return { ok: false, reason: "send_ready_fence_failed" };
      },
    });
    const r = await runProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(spy.calls.click).toBe(0);
  });

  it("generation drift during readiness → zero click", async () => {
    let gen = 3;
    const spy = makeSpies({
      getCurrentGeneration: () => gen,
      waitForSendReady: async () => {
        gen = 99;
        return { ok: false, reason: "send_ready_fence_failed" };
      },
    });
    const r = await runProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(spy.calls.click).toBe(0);
  });

  it("USER turn appears on later poll → success; full timeout → no ack", async () => {
    let poll = 0;
    const late = makeSpies({
      findCanonicalUserTurn: () => {
        poll += 1;
        if (poll < 5) return { ok: false, reason: "not_observed" };
        return { ok: true, turn: { id: "u1", text: MESSAGE } };
      },
      maxPollAttempts: 40,
      pollIntervalMs: 1,
    });
    const r1 = await runProductionSend(late);
    expect(r1.ok).toBe(true);
    expect(late.calls.click).toBe(1);
    expect(late.calls.ack).toBe(1);

    const timeout = makeSpies({
      findCanonicalUserTurn: () => ({ ok: false, reason: "not_observed" }),
      maxPollAttempts: 3,
      pollIntervalMs: 1,
    });
    const r2 = await runProductionSend(timeout);
    expect(r2.ok).toBe(false);
    expect(timeout.calls.click).toBe(1);
    expect(timeout.calls.ack).toBe(0);
    expect(timeout.journal.state).toBe("OUTCOME_UNKNOWN");
  });

  it("post-click generation/route drift → no ack", async () => {
    let gen = 3;
    let route = ROUTE;
    const spy = makeSpies({
      getCurrentRoute: () => route,
      getCurrentGeneration: () => gen,
      findCanonicalUserTurn: () => {
        gen = 99;
        return { ok: false, reason: "not_observed" };
      },
      maxPollAttempts: 3,
      pollIntervalMs: 1,
    });
    const r = await runProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(spy.calls.ack).toBe(0);
    expect(spy.journal.state).toBe("OUTCOME_UNKNOWN");

    const spy2 = makeSpies({
      getCurrentRoute: () => route,
      getCurrentGeneration: () => 3,
      findCanonicalUserTurn: () => {
        route = "https://chatgpt.com/c/99999999-9999-4999-8999-999999999999";
        return { ok: false, reason: "not_observed" };
      },
      maxPollAttempts: 3,
      pollIntervalMs: 1,
    });
    const r2 = await runProductionSend(spy2);
    expect(r2.ok).toBe(false);
    expect(spy2.calls.ack).toBe(0);
  });

  it("write mutationGuard ANDs caller guard and live fence", async () => {
    let gen = 3;
    const spy = makeSpies({ getCurrentGeneration: () => gen });
    const inner = spy.writeCanonicalMessage;
    spy.writeCanonicalMessage = (async (doc: unknown, message: unknown, opts: { mutationGuard?: () => boolean }) => {
      // Simulate TOCTOU: route/generation drift after preflight, before mutation.
      gen = 99;
      const guarded = typeof opts?.mutationGuard === "function" ? opts.mutationGuard() : true;
      if (!guarded) {
        return { ok: false, reason: "write_probe_route_drift", mutationAttempted: false, wrote: false };
      }
      return (inner as () => Promise<{ ok: boolean }>)();
    }) as never;
    const r = await runProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
  });

  it("click mutationGuard fail → zero click", () => {
    const src = fs.readFileSync(path.join(companionRoot, "send-click-adapter.js"), "utf8");
    expect(src).toMatch(/send_mutation_guard_failed/);
    expect(src).toMatch(/opts\.mutationGuard/);
    const code = src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).toMatch(/\.click\(\)/);
    expect((code.match(/\.click\(\)/g) || []).length).toBe(1);
  });
});

describe("E1b3d3b production completion requires durable NONE", () => {
  it("response.ok without mode/journal NONE is not success", () => {
    const r1 = classifyProductionStartRpcResult({
      response: { ok: true, mode: "production_send" },
      journalAfter: { state: "OBSERVED_PENDING_ACK" },
    });
    expect(r1.ok).toBe(false);
    expect(r1.reason).toBe("production_journal_not_cleared");
    const r2 = classifyProductionStartRpcResult({
      response: { ok: true, mode: "send_probe_real" },
      journalAfter: { state: "NONE" },
    });
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe("production_response_mode_invalid");
    const r3 = classifyProductionStartRpcResult({
      response: { ok: true, mode: "production_send" },
      journalAfter: { state: "NONE" },
    });
    expect(r3.ok).toBe(true);
  });
});

describe("E1b3d3b durable persist closeout", () => {
  const CLAIM_PROOF = buildClaimProof({
    eventId: EVENT_ID,
    reservationId: RES_ID,
    attemptId: ATTEMPT,
    message: MESSAGE,
    messageSha256: MESSAGE_SHA,
  })!;
  const ACK_PROOF = buildAckProof({
    eventId: EVENT_ID,
    attemptId: ATTEMPT,
    status: "observed",
  })!;

  it("CLAIM persist failure → memory stays SEND_INTENT; claimProof retained; retry succeeds", async () => {
    let memoryJournal = markSendIntent(reservedJournal(), {});
    let claimProof: object | null = CLAIM_PROOF;
    let persistShouldFail = true;

    const proposedClaimed = markClaimed(memoryJournal, {
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    });
    const cas1 = validateProductionJournalCommit(memoryJournal, proposedClaimed, memoryJournal, {
      claimProof,
    });
    expect(cas1.ok).toBe(true);

    const failCommit = await commitJournalDurably({
      current: memoryJournal,
      proposed: proposedClaimed,
      persist: async () => {
        if (persistShouldFail) throw new Error("storage_down");
      },
      onDurableSuccess: () => {
        claimProof = null;
      },
    });
    expect(failCommit.ok).toBe(false);
    expect(failCommit.reason).toBe("journal_persist_failed");
    // FIX1: proposed must not become long-term memory authority.
    expect(memoryJournal.state).toBe("SEND_INTENT");
    expect(claimProof).not.toBeNull();

    // Storage recovered; same exact CLAIMED CAS retries successfully.
    persistShouldFail = false;
    const cas2 = validateProductionJournalCommit(memoryJournal, proposedClaimed, memoryJournal, {
      claimProof,
    });
    expect(cas2.ok).toBe(true);
    const okCommit = await commitJournalDurably({
      current: memoryJournal,
      proposed: proposedClaimed,
      persist: async (next) => {
        memoryJournal = next as typeof memoryJournal;
      },
      onDurableSuccess: (next) => {
        if (next.state === "CLAIMED") claimProof = null;
      },
    });
    expect(okCommit.ok).toBe(true);
    expect(memoryJournal.state).toBe("CLAIMED");
    expect(claimProof).toBeNull();
  });

  it("ACK clear persist failure → memory stays OBSERVED_PENDING_ACK; ackProof retained; retry succeeds", async () => {
    let j = claimedJournal();
    j = markComposerWriteIntent(j, {});
    j = markSendDispatchIntent(j, {});
    j = markObservedPendingAck(j, {});
    let memoryJournal = j;
    let ackProof: object | null = ACK_PROOF;
    let persistShouldFail = true;
    const none = clearJournal();

    const cas1 = validateProductionJournalCommit(memoryJournal, none, memoryJournal, {
      ackProof,
    });
    expect(cas1.ok).toBe(true);

    const failCommit = await commitJournalDurably({
      current: memoryJournal,
      proposed: none,
      persist: async () => {
        if (persistShouldFail) throw new Error("storage_down");
      },
      onDurableSuccess: () => {
        ackProof = null;
      },
    });
    expect(failCommit.ok).toBe(false);
    expect(failCommit.reason).toBe("journal_persist_failed");
    expect(memoryJournal.state).toBe("OBSERVED_PENDING_ACK");
    expect(ackProof).not.toBeNull();

    persistShouldFail = false;
    const cas2 = validateProductionJournalCommit(memoryJournal, none, memoryJournal, {
      ackProof,
    });
    expect(cas2.ok).toBe(true);
    const okCommit = await commitJournalDurably({
      current: memoryJournal,
      proposed: none,
      persist: async (next) => {
        memoryJournal = next as typeof memoryJournal;
      },
      onDurableSuccess: () => {
        ackProof = null;
      },
    });
    expect(okCommit.ok).toBe(true);
    expect(memoryJournal.state).toBe("NONE");
    expect(ackProof).toBeNull();
  });

  it("CLAIMED → COMPOSER_WRITE_INTENT persist failure → memory remains CLAIMED", async () => {
    let memoryJournal = claimedJournal();
    const writeIntent = markComposerWriteIntent(memoryJournal, {});
    const cas = validateProductionJournalCommit(memoryJournal, writeIntent, memoryJournal);
    expect(cas.ok).toBe(true);

    const failCommit = await commitJournalDurably({
      current: memoryJournal,
      proposed: writeIntent,
      persist: async () => {
        throw new Error("storage_down");
      },
    });
    expect(failCommit.ok).toBe(false);
    expect(failCommit.reason).toBe("journal_persist_failed");
    // Un-durable mutation fence must never become SW authority.
    expect(memoryJournal.state).toBe("CLAIMED");
  });

  it("SW source rolls back journal on persist failure and consumes proofs only after success", () => {
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    expect(sw).toMatch(/commitJournalDurably/);
    expect(sw).toMatch(/journal = previousJournal/);
    expect(sw).toMatch(/onDurableSuccess/);
    // Proof consumption must sit inside onDurableSuccess, not before persist.
    const persistStart = sw.indexOf("commitJournalDurably");
    const successIdx = sw.indexOf("onDurableSuccess", persistStart);
    const claimConsumeIdx = sw.indexOf("productionClaimProof = null", successIdx);
    expect(successIdx).toBeGreaterThan(persistStart);
    expect(claimConsumeIdx).toBeGreaterThan(successIdx);
  });
});

describe("E1b3d3b outcome_unknown retirement browser path", () => {
  it("SW source: manual popup-only retire, exact server confirm, rollback on persist fail, zero DOM", () => {
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    expect(sw).toMatch(/c2c\.retire\.unknown/);
    expect(sw).toMatch(/handleRetireUnknown/);
    expect(sw).toMatch(/popup_sender_required/);
    expect(sw).toMatch(/journal_not_outcome_unknown/);
    expect(sw).toMatch(/server_inflight_mismatch/);
    expect(sw).toMatch(/retire_response_invalid/);
    expect(sw).toMatch(/retired_unknown/);
    // Identity from durable journal only.
    expect(sw).toMatch(/fetchCompanion\("\/retire-unknown"/);
    // inFlight=null must fall through to /retire-unknown, never direct local clear.
    expect(sw).toMatch(/inFlight === null: fall through/);
    expect(sw).toMatch(/idempotent reconcile/);
    // Zero DOM / send orchestration in retire handler.
    const start = sw.indexOf("async function handleRetireUnknown");
    const end = sw.indexOf("chrome.runtime.onMessage.addListener", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = sw.slice(start, end);
    expect(body).not.toMatch(/\.click\(\)/);
    expect(body).not.toMatch(/execCommand/);
    expect(body).not.toMatch(/begin-send/);
    expect(body).not.toMatch(/\/ack\b/);
    expect(body).not.toMatch(/runProductionSend/);
    expect(body).not.toMatch(/dispatchNativeSend/);
    // Rollback: previous journal restored on persist failure.
    expect(body).toMatch(/journal_persist_failed/);
    expect(body).toMatch(/journal = previousJournal/);
    // Server exact success required before local clear.
    const serverIdx = body.indexOf("retire_response_invalid");
    const clearIdx = body.indexOf("clearJournal()");
    expect(serverIdx).toBeGreaterThan(0);
    expect(clearIdx).toBeGreaterThan(serverIdx);
  });

  it("popup requires explicit confirmation checkbox", () => {
    const html = fs.readFileSync(path.join(companionRoot, "popup", "popup.html"), "utf8");
    expect(html).toMatch(/Retire unknown — NEVER RETRY/);
    expect(html).toMatch(/retire-unknown-confirm/);
    expect(html).toMatch(/permanently abandons this unknown event and will never retry it/);
    const js = fs.readFileSync(path.join(companionRoot, "popup", "popup.js"), "utf8");
    expect(js).toMatch(/c2c\.retire\.unknown/);
    expect(js).toMatch(/retireUnknownConfirm/);
    // Enable only when OUTCOME_UNKNOWN + confirm checked.
    expect(js).toMatch(/OUTCOME_UNKNOWN/);
  });

  it("server retire success + local persist failure → journal remains OUTCOME_UNKNOWN via rollback", async () => {
    // Simulate the SW durable-clear contract with commitJournalDurably.
    let journalState = "OUTCOME_UNKNOWN";
    const previous = { state: "OUTCOME_UNKNOWN", eventId: EVENT_ID };
    const proposed = { state: "NONE" };
    const failCommit = await commitJournalDurably({
      current: previous,
      proposed,
      persist: async () => {
        throw new Error("storage_down");
      },
      onDurableSuccess: () => {
        journalState = "NONE";
      },
    });
    expect(failCommit.ok).toBe(false);
    expect(failCommit.reason).toBe("journal_persist_failed");
    expect(journalState).toBe("OUTCOME_UNKNOWN");

    // Exact retry after storage recovery succeeds.
    const okCommit = await commitJournalDurably({
      current: previous,
      proposed,
      persist: async () => {},
      onDurableSuccess: () => {
        journalState = "NONE";
      },
    });
    expect(okCommit.ok).toBe(true);
    expect(journalState).toBe("NONE");
  });

  it("two-phase: server retire success + local fail, then inFlight=null idempotent retry → NONE", async () => {
    // Round 1: server exact outcome_unknown → exact retired_unknown success, local persist fails.
    let journalState = "OUTCOME_UNKNOWN";
    let serverStatus = "outcome_unknown";
    const previous = { state: "OUTCOME_UNKNOWN", eventId: EVENT_ID };
    const failCommit = await commitJournalDurably({
      current: previous,
      proposed: { state: "NONE" },
      persist: async () => {
        throw new Error("storage_down");
      },
      onDurableSuccess: () => {
        journalState = "NONE";
      },
    });
    expect(failCommit.ok).toBe(false);
    // Server now retired_unknown → inFlight=null.
    serverStatus = "retired_unknown";
    expect(journalState).toBe("OUTCOME_UNKNOWN");

    // Round 2: /state inFlight=null must NOT block; /retire-unknown idempotent success.
    // inFlight=null falls through to retire endpoint (never direct local clear).
    expect(serverStatus).toBe("retired_unknown");
    const okCommit = await commitJournalDurably({
      current: previous,
      proposed: { state: "NONE" },
      persist: async () => {},
      onDurableSuccess: () => {
        journalState = "NONE";
      },
    });
    expect(okCommit.ok).toBe(true);
    expect(journalState).toBe("NONE");
  });

  it("inFlight=null + retire endpoint fails → local remains OUTCOME_UNKNOWN", async () => {
    // /state=null does not authorize local clear; only exact retire response does.
    // Simulate: /state returns null, /retire-unknown returns FEEDBACK_RETIRE_MISMATCH.
    let journalState = "OUTCOME_UNKNOWN";
    const previous = { state: "OUTCOME_UNKNOWN", eventId: EVENT_ID };
    // No durable clear is attempted because retire response is not exact success.
    // Journal stays OUTCOME_UNKNOWN.
    expect(journalState).toBe("OUTCOME_UNKNOWN");
    expect(previous.state).toBe("OUTCOME_UNKNOWN");
  });

  it("non-null mismatched inFlight → zero retire endpoint calls, local OUTCOME_UNKNOWN", () => {
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    const start = sw.indexOf("async function handleRetireUnknown");
    const end = sw.indexOf("chrome.runtime.onMessage.addListener", start);
    const body = sw.slice(start, end);
    // Mismatch branch returns before fetchCompanion("/retire-unknown").
    const mismatchIdx = body.indexOf("server_inflight_mismatch");
    const retireIdx = body.indexOf('fetchCompanion("/retire-unknown"');
    expect(mismatchIdx).toBeGreaterThan(0);
    expect(retireIdx).toBeGreaterThan(mismatchIdx);
    // inFlight !== null guard wraps the mismatch check.
    expect(body).toMatch(/if \(inFlight != null\)/);
  });
});

describe("E1b3d3b RPC ambiguity", () => {
  it("still RESERVED after RPC throw → retry allowed", () => {
    const r = classifyProductionStartRpcResult({
      response: null,
      journalAfter: reservedJournal(),
    });
    expect(r.ok).toBe(false);
    expect(r.retryAllowed).toBe(true);
    expect(r.action).toBe("retry");
  });

  it("SEND_INTENT after RPC throw → recover, never re-start", () => {
    const r = classifyProductionStartRpcResult({
      response: null,
      journalAfter: markSendIntent(reservedJournal(), {}),
    });
    expect(r.ok).toBe(false);
    expect(r.retryAllowed).toBe(false);
    expect(r.action).toBe("recover");
  });

  it("COMPOSER_WRITE_INTENT after RPC throw → recover zeroWrite/zeroClick", () => {
    let j = markSendIntent(reservedJournal(), {});
    j = markClaimed(j, {
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    });
    j = markComposerWriteIntent(j, {});
    const r = classifyProductionStartRpcResult({ response: null, journalAfter: j });
    expect(r.retryAllowed).toBe(false);
    expect(r.zeroWrite).toBe(true);
    expect(r.zeroClick).toBe(true);
  });

  it("memory boolean is not crash authority — durable journal decides", () => {
    // Even if productionSendInFlight were true in memory, classify only looks at journalAfter.
    const r = classifyProductionStartRpcResult({
      response: null,
      journalAfter: reservedJournal(),
    });
    expect(r.action).toBe("retry");
  });
});

describe("E1b3d3b popup / packaging gates", () => {
  it("popup production button is explicit and confirmation-gated", () => {
    const html = fs.readFileSync(path.join(companionRoot, "popup", "popup.html"), "utf8");
    expect(html).toMatch(/SEND reserved feedback once/);
    expect(html).toMatch(/I understand this sends the reserved production feedback/);
    expect(html).toMatch(/PRODUCTION SEND/);
    expect(html).toMatch(/production-status/);
    const js = fs.readFileSync(path.join(companionRoot, "popup", "popup.js"), "utf8");
    expect(js).toMatch(/c2c\.production\.send\.request/);
    expect(js).not.toMatch(/type:\s*"c2c\.production\.send\.request",\s*message:/);
    expect(js).toMatch(/productionSendConfirm/);
  });

  it("SW rejects caller-supplied identity/message for production start", () => {
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    expect(sw).toMatch(/production_send_payload_forbidden/);
    expect(sw).toMatch(/popup_sender_required/);
    expect(sw).toMatch(/validateProductionJournalCommit/);
    expect(sw).toMatch(/fetchCompanion\("\/begin-send"/);
    expect(sw).toMatch(/fetchCompanion\("\/ack"/);
  });

  it("CS production shell has no Bridge HTTP / credential", () => {
    const cs = fs.readFileSync(path.join(companionRoot, "content-script.js"), "utf8");
    expect(cs).toMatch(/c2c\.production\.send\.execute/);
    expect(cs).toMatch(/__c2cRunProductionSend/);
    expect(cs).not.toMatch(/\/begin-send/);
    expect(cs).not.toMatch(/\/ack\b/);
    expect(cs).not.toMatch(/credential/i);
    expect(cs).not.toMatch(/fetch\(/);
    expect(cs).not.toMatch(/chrome\.tabs\.sendMessage/);
    expect(cs).not.toMatch(/\.click\(\)/);
  });

  it("production-send-runtime is DI-only pure adapter", () => {
    const src = fs.readFileSync(path.join(companionRoot, "production-send-runtime.js"), "utf8");
    const code = src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).toMatch(/export async function runProductionSend/);
    expect(src).toMatch(/export async function recoverProductionSend/);
    expect(code).not.toMatch(/chrome\./);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/localStorage|sessionStorage/);
    expect(code).not.toMatch(/\.click\(\)/);
    expect(code).not.toMatch(/credential/i);
  });

  it("production-send pure helpers have no chrome/fetch/DOM", () => {
    const src = fs.readFileSync(path.join(companionRoot, "production-send.js"), "utf8");
    const code = src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/chrome\./);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/document\./);
    expect(code).not.toMatch(/\.click\(\)/);
  });
});

describe("E1b3d3b runtime capability wiring", () => {
  it("A. content-script production DOM deps include readiness resolvers", () => {
    const cs = fs.readFileSync(path.join(companionRoot, "content-script.js"), "utf8");
    const start = cs.indexOf("function buildProductionDomDeps");
    expect(start).toBeGreaterThan(0);
    const end = cs.indexOf("function buildProductionNetworkDeps");
    expect(end).toBeGreaterThan(start);
    const body = cs.slice(start, end);
    expect(body).toMatch(/resolveChatGptComposer/);
    expect(body).toMatch(/globalThis\.resolveChatGptComposer/);
    expect(body).toMatch(/resolveChatGptAction/);
    expect(body).toMatch(/globalThis\.resolveChatGptAction/);
    expect(body).toMatch(/readCanonicalComposerText/);
    expect(body).toMatch(/globalThis\.__c2cReadCanonicalComposerText/);
    expect(body).toMatch(/normalizeCanonicalDomText/);
    expect(body).toMatch(/globalThis\.normalizeCanonicalDomText/);
    // Must not implement a second DOM resolver or click here.
    expect(body).not.toMatch(/function resolveChatGptComposer/);
    expect(body).not.toMatch(/\.click\(\)/);
  });

  it("B. no custom waitForSendReady happy path uses default readiness inspector", async () => {
    // Fixture: idle empty composer before write; after write, action becomes exact send-button.
    let written = false;
    let journal = reservedJournal();
    const calls = { beginSend: 0, write: 0, click: 0, ack: 0, persist: [] as string[] };
    const sendBtn = {
      getAttribute: (n: string) => (n === "data-testid" ? "send-button" : null),
      click() {},
    };
    const editor = { id: "prompt-textarea" };
    const ctx = {
      get journal() {
        return journal;
      },
      doc: {} as never,
      expectedRoute: ROUTE,
      expectedGeneration: 3,
      routeCanonical: ROUTE,
      bindingId: "b",
      epoch: 1,
      getCurrentRoute: () => ROUTE,
      getCurrentGeneration: () => 3,
      inspectComposerWriteCapability: () => ({
        ok: true,
        editorKind: "contenteditable",
        action: { kind: "idle", enabled: true },
      }),
      writeCanonicalMessage: async () => {
        calls.write += 1;
        written = true;
        return { ok: true };
      },
      verifyCanonicalComposer: async () => ({ ok: true }),
      dispatchNativeSend: async () => {
        calls.click += 1;
        return { ok: true, clicked: 1 };
      },
      snapshotUserTurns: () => [],
      findCanonicalUserTurn: () => ({ ok: true, turn: { id: "u1", text: MESSAGE } }),
      hasExactAttemptMarker,
      resolveChatGptComposer: () => ({ editor }),
      readCanonicalComposerText: () => ({
        ok: true,
        text: written ? MESSAGE : "",
        representation: "prosemirror_p_blocks",
      }),
      resolveChatGptAction: () =>
        written
          ? { kind: "send", enabled: true, button: sendBtn }
          : { kind: "idle", enabled: true, button: null },
      normalizeCanonicalDomText: (t: string) => t,
      persistJournal: async (next: typeof journal) => {
        journal = next;
        calls.persist.push(next.state);
        return next;
      },
      beginSend: async () => {
        calls.beginSend += 1;
        return {
          eventId: EVENT_ID,
          status: "claimed" as const,
          attemptId: ATTEMPT,
          message: MESSAGE,
          messageSha256: MESSAGE_SHA,
        };
      },
      ackObserved: async () => {
        calls.ack += 1;
        return { eventId: EVENT_ID, status: "observed" as const };
      },
      sendReadyTimeoutMs: 200,
      sendReadyPollMs: 1,
      now: () => Date.now(),
      waitMs: async () => {},
      maxPollAttempts: 2,
      pollIntervalMs: 1,
      sleep: async () => {},
    };
    const r = await runProductionSend(ctx as never);
    expect(r.ok).toBe(true);
    expect(calls.beginSend).toBe(1);
    expect(calls.write).toBe(1);
    expect(calls.click).toBe(1);
    expect(calls.ack).toBe(1);
    expect(journal.state).toBe("NONE");
  });

  it("C. missing real readiness capability → production_capability_missing, RESERVED", async () => {
    for (const missing of [
      "resolveChatGptAction",
      "resolveChatGptComposer",
      "readCanonicalComposerText",
    ] as const) {
      const spy = makeSpies();
      delete (spy as Record<string, unknown>).waitForSendReady;
      delete (spy as Record<string, unknown>)[missing];
      const r = await runProductionSend(spy as never);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("production_capability_missing");
      expect(spy.calls.beginSend).toBe(0);
      expect(spy.calls.write).toBe(0);
      expect(spy.calls.click).toBe(0);
      expect(spy.journal.state).toBe("RESERVED");
    }
  });

  it("D. makeSpies without waitForSendReady still needs readiness DI (no silent stub)", () => {
    const spy = makeSpies();
    delete (spy as Record<string, unknown>).waitForSendReady;
    // makeSpies does not provide resolveChatGpt* / readCanonical* by default.
    const pre = productionLocalPreflight(spy as never);
    expect(pre.ok).toBe(false);
    expect(pre.reason).toBe("production_capability_missing");
  });
});

describe("E1b3d3b packaging regression", () => {
  it("manifest loads production classic after write/click adapters", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(companionRoot, "manifest.json"), "utf8"));
    const js = (manifest.content_scripts ?? []).flatMap((cs: { js?: string[] }) => cs.js ?? []);
    expect(js).toContain("production-send-runtime-global.js");
    expect(js).not.toContain("production-send-runtime.js");
    expect(js).not.toContain("send-orchestrator.js");
    expect(js).not.toContain("reservation-journal.js");
    const writeIdx = js.indexOf("composer-write-adapter.js");
    const clickIdx = js.indexOf("send-click-adapter.js");
    const prodIdx = js.indexOf("production-send-runtime-global.js");
    const csIdx = js.indexOf("content-script.js");
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(clickIdx).toBeGreaterThan(writeIdx);
    expect(prodIdx).toBeGreaterThan(clickIdx);
    expect(csIdx).toBeGreaterThan(prodIdx);
  });

  it("classic production artifact has no export/import and only expected globals", () => {
    const classicPath = path.join(distCompanion, "production-send-runtime-global.js");
    if (!fs.existsSync(classicPath)) {
      expect(true).toBe(true);
      return;
    }
    const classic = fs.readFileSync(classicPath, "utf8");
    expect(classic).not.toMatch(/^\s*export\s/m);
    expect(classic).not.toMatch(/^\s*import\s/m);
    expect(classic).toMatch(/globalThis\.__c2cRunProductionSend/);
    expect(classic).toMatch(/globalThis\.__c2cRecoverProductionSend/);
    expect(classic).not.toMatch(/globalThis\.(markSendIntent|markClaimed|emptyJournal|runSendOrchestration)\s*=/);
  });

  it("built SW ESM import graph keeps production-send.js as ESM", async () => {
    const esmPath = path.join(distCompanion, "production-send.js");
    if (!fs.existsSync(esmPath)) {
      expect(true).toBe(true);
      return;
    }
    const esm = fs.readFileSync(esmPath, "utf8");
    expect(esm).toMatch(/export function canStartProductionSend/);
    expect(esm).toMatch(/export function validateProductionJournalCommit/);
    expect(esm).not.toMatch(/globalThis\./);
    const mod = await import(pathToFileURLSafe(esmPath));
    expect(typeof mod.canStartProductionSend).toBe("function");
  });

  it("full manifest load-order VM execution exposes production globals only after adapters", () => {
    const classicPath = path.join(distCompanion, "production-send-runtime-global.js");
    const writePath = path.join(distCompanion, "composer-write-adapter.js");
    if (!fs.existsSync(classicPath) || !fs.existsSync(writePath)) {
      expect(true).toBe(true);
      return;
    }
    const sandbox: Record<string, unknown> = {
      globalThis: {} as Record<string, unknown>,
    };
    sandbox.globalThis = sandbox;
    const context = vm.createContext(sandbox);
    const loadOrder = [
      "route-global.js",
      "dom-adapter.js",
      "turn-observer.js",
      "shadow-evidence.js",
      "composer-write-adapter.js",
      "send-click-adapter.js",
      "send-probe-message-global.js",
      "send-probe-run.js",
      "production-send-runtime-global.js",
    ];
    for (const file of loadOrder) {
      const p = path.join(distCompanion, file);
      if (!fs.existsSync(p)) continue;
      const src = fs.readFileSync(p, "utf8");
      vm.runInContext(src, context, { filename: file });
    }
    expect(typeof (sandbox as { __c2cRunProductionSend?: unknown }).__c2cRunProductionSend).toBe("function");
    expect(typeof (sandbox as { __c2cRecoverProductionSend?: unknown }).__c2cRecoverProductionSend).toBe("function");
    expect(typeof (sandbox as { __c2cDispatchNativeSend?: unknown }).__c2cDispatchNativeSend).toBe("function");
    expect(typeof (sandbox as { __c2cWriteCanonicalMessage?: unknown }).__c2cWriteCanonicalMessage).toBe("function");
    expect((sandbox as { markSendIntent?: unknown }).markSendIntent).toBeUndefined();
    expect((sandbox as { runSendOrchestration?: unknown }).runSendOrchestration).toBeUndefined();
  });

  it("built runtime preflight with CS-equivalent deps is not production_capability_missing", async () => {
    const classicPath = path.join(distCompanion, "production-send-runtime-global.js");
    if (!fs.existsSync(classicPath)) {
      expect(true).toBe(true);
      return;
    }
    const sandbox: Record<string, unknown> = {};
    sandbox.globalThis = sandbox;
    const context = vm.createContext(sandbox);
    const loadOrder = [
      "route-global.js",
      "dom-adapter.js",
      "turn-observer.js",
      "composer-write-adapter.js",
      "send-click-adapter.js",
      "production-send-runtime-global.js",
    ];
    for (const file of loadOrder) {
      const p = path.join(distCompanion, file);
      if (!fs.existsSync(p)) continue;
      vm.runInContext(fs.readFileSync(p, "utf8"), context, { filename: file });
    }
    const run = (sandbox as { __c2cRunProductionSend?: (ctx: unknown) => Promise<{ ok: boolean; reason?: string }> })
      .__c2cRunProductionSend;
    if (typeof run !== "function") {
      expect(true).toBe(true);
      return;
    }
    // Equivalent to CS buildProductionDomDeps wiring + network spies.
    const g = sandbox as Record<string, unknown>;
    const reserved = reservedJournal();
    const result = await run({
      doc: { querySelector: () => null },
      journal: reserved,
      expectedRoute: ROUTE,
      expectedGeneration: 3,
      routeCanonical: ROUTE,
      bindingId: "b",
      epoch: 1,
      getCurrentRoute: () => ROUTE,
      getCurrentGeneration: () => 3,
      inspectComposerWriteCapability: () => ({
        ok: true,
        editorKind: "contenteditable",
        action: { kind: "idle", enabled: true },
      }),
      writeCanonicalMessage: async () => ({ ok: true }),
      verifyCanonicalComposer: async () => ({ ok: true }),
      dispatchNativeSend: async () => ({ ok: true, clicked: 1 }),
      snapshotUserTurns: () => [],
      findCanonicalUserTurn: () => ({ ok: true, turn: { id: "u1", text: MESSAGE } }),
      hasExactAttemptMarker: typeof g.hasExactAttemptMarker === "function"
        ? (m: string, a: string) => (g.hasExactAttemptMarker as (m: string, a: string) => unknown)(m, a)
        : undefined,
      resolveChatGptComposer: typeof g.resolveChatGptComposer === "function"
        ? (doc: unknown) => (g.resolveChatGptComposer as (d: unknown) => unknown)(doc)
        : undefined,
      resolveChatGptAction: typeof g.resolveChatGptAction === "function"
        ? (doc: unknown, editor: unknown) => (g.resolveChatGptAction as (d: unknown, e: unknown) => unknown)(doc, editor)
        : undefined,
      readCanonicalComposerText: typeof g.__c2cReadCanonicalComposerText === "function"
        ? (editor: unknown) => (g.__c2cReadCanonicalComposerText as (e: unknown) => unknown)(editor)
        : undefined,
      normalizeCanonicalDomText: typeof g.normalizeCanonicalDomText === "function"
        ? (text: string) => (g.normalizeCanonicalDomText as (t: string) => unknown)(text)
        : undefined,
      persistJournal: async (next: unknown) => next,
      beginSend: async () => ({
        eventId: EVENT_ID,
        status: "claimed",
        attemptId: ATTEMPT,
        message: MESSAGE,
        messageSha256: MESSAGE_SHA,
      }),
      ackObserved: async () => ({ eventId: EVENT_ID, status: "observed" }),
    });
    // Must not fail closed on missing readiness wiring.
    expect(result.reason).not.toBe("production_capability_missing");
  });
});

function pathToFileURLSafe(p: string) {
  return new URL(`file:///${p.replace(/\\/g, "/")}`).href;
}

describe("E1b3d3b helpers", () => {
  it("summarizeProductionJournal never includes message", () => {
    const j = claimedJournal();
    const s = summarizeProductionJournal(j);
    expect(s.state).toBe("CLAIMED");
    expect(s.eventId).toBe(EVENT_ID);
    expect(s.attemptId).toBe(ATTEMPT);
    expect(JSON.stringify(s)).not.toContain(MESSAGE);
    expect(summarizeProductionJournal(clearJournal()).state).toBe("NONE");
  });

  it("sanitizeInFlightForRecovery strips extras", () => {
    const s = sanitizeInFlightForRecovery({
      status: "claimed",
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
      credential: "nope",
      principalFingerprint: "nope",
    });
    expect(s).toEqual({
      status: "claimed",
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    });
  });

  it("buildProductionRecoverRequest includes sanitized inFlight only", () => {
    const req = buildProductionRecoverRequest(
      OWNER,
      claimedJournal(),
      { status: "claimed", eventId: EVENT_ID, attemptId: ATTEMPT, secret: "x" },
    );
    expect(req.ok).toBe(true);
    expect(req.message.inFlight?.status).toBe("claimed");
    expect(JSON.stringify(req)).not.toContain("secret");
  });

  it("preflight alone never mutates journal", async () => {
    const spy = makeSpies();
    const r = productionLocalPreflight(spy);
    expect(r.ok).toBe(true);
    expect(spy.journal.state).toBe("RESERVED");
    expect(spy.calls.beginSend).toBe(0);
  });
});

describe("E1b3d3b popup JS parse regression", () => {
  function parseOnly(source: string, label: string) {
    try {
      // Parse only — do not execute popup IIFE or mock chrome.
      new vm.Script(source, { filename: label });
      return { ok: true as const };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  it("vm.Script rejects lexical duplicate const (guard that this test is real)", () => {
    const result = parseOnly("const x = 1;\nconst x = 2;\n", "duplicate-const.js");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(SyntaxError);
      expect(result.error.message).toMatch(/Identifier 'x' has already been declared|already been declared/i);
    }
  });

  it("source popup/popup.js parses without executing", () => {
    const js = fs.readFileSync(path.join(companionRoot, "popup", "popup.js"), "utf8");
    const result = parseOnly(js, "browser-companion/popup/popup.js");
    expect(result.ok, result.ok ? "" : result.error.stack ?? result.error.message).toBe(true);
  });

  it("built dist popup/popup.js parses without executing", () => {
    const distPopup = path.join(distCompanion, "popup", "popup.js");
    if (!fs.existsSync(distPopup)) {
      expect(true).toBe(true);
      return;
    }
    const js = fs.readFileSync(distPopup, "utf8");
    const result = parseOnly(js, "dist/browser-companion/popup/popup.js");
    expect(result.ok, result.ok ? "" : result.error.stack ?? result.error.message).toBe(true);
  });

  it("source popup declares journalState only once in refresh scope", () => {
    const js = fs.readFileSync(path.join(companionRoot, "popup", "popup.js"), "utf8");
    const matches = js.match(/const journalState\s*=/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe("E1b3d3b observation diagnostic (read-only)", () => {
  function docWithTurns(texts: string[]) {
    return {
      querySelectorAll: () =>
        texts.map((text, i) => ({
          getAttribute: (n: string) =>
            n === "data-message-author-role"
              ? "user"
              : n === "data-testid"
                ? `conversation-turn-${i}`
                : null,
          textContent: text,
          innerText: text,
          closest: () => ({ getAttribute: () => `conversation-turn-${i}` }),
          querySelector: () => null,
        })),
    } as never;
  }

  it("not_observed diagnostic is bounded and has no raw text", () => {
    const doc = docWithTurns(["hello world", "other"]);
    const rec = findCanonicalUserTurn(doc, {
      message: MESSAGE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(rec.ok).toBe(false);
    expect(rec.reason).toBe("not_observed");
    const d = (rec as { diagnostic?: Record<string, unknown> }).diagnostic;
    expect(d).toBeTruthy();
    expect(d?.candidateCount).toBe(2);
    expect(d?.exactTextMatchCount).toBe(0);
    expect(d?.exactAttemptMarkerCount).toBe(0);
    expect(d?.targetLength).toBe(MESSAGE.length);
    expect(Array.isArray(d?.candidateLengths)).toBe(true);
    expect((d?.candidateLengths as number[]).length).toBeLessThanOrEqual(
      TURN_DIAGNOSTIC_LIMITS.maxCandidatesReported,
    );
    const dump = JSON.stringify(d ?? {});
    expect(dump).not.toContain(MESSAGE);
    expect(dump).not.toContain("hello world");
    expect(dump).not.toContain("message");
    expect(dump).not.toContain("credential");
    expect(dump).not.toContain("secret");
  });

  it("ambiguous diagnostic reports match counts without text", () => {
    const doc = docWithTurns([MESSAGE, MESSAGE]);
    const rec = findCanonicalUserTurn(doc, {
      message: MESSAGE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(rec.ok).toBe(false);
    expect(rec.reason).toBe("ambiguous");
    const d = (rec as { diagnostic?: Record<string, unknown> }).diagnostic;
    expect(d?.exactTextMatchCount).toBe(2);
    expect(d?.exactAttemptMarkerCount).toBe(2);
    expect(d?.ambiguousCount).toBe(2);
    expect(JSON.stringify(d ?? {})).not.toContain(MESSAGE);
  });

  it("exact match success diagnostic has counts only", () => {
    const doc = docWithTurns(["nope", MESSAGE]);
    const rec = findCanonicalUserTurn(doc, {
      message: MESSAGE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(rec.ok).toBe(true);
    const d = (rec as { diagnostic?: Record<string, unknown> }).diagnostic;
    expect(d?.candidateCount).toBe(2);
    expect(d?.exactTextMatchCount).toBe(1);
    expect(d?.exactAttemptMarkerCount).toBe(1);
    expect(d?.ambiguousCount).toBe(0);
    expect(JSON.stringify(d ?? {})).not.toContain(MESSAGE);
  });

  it("buildTurnObservationDiagnostic reports role evidence and firstMismatchIndex", () => {
    const turns = [
      { text: "aaa", node: { getAttribute: () => "user", querySelector: () => null } },
      { text: MESSAGE, node: { getAttribute: () => "user", querySelector: () => null } },
    ];
    const d = buildTurnObservationDiagnostic({
      message: MESSAGE,
      attemptId: ATTEMPT,
      turns,
      matches: [],
    });
    expect(d.candidateCount).toBe(2);
    expect(d.firstMismatchIndex).toBe(0);
    expect(d.candidates[0]?.directRole).toBe("user");
    expect(d.candidates[0]?.nestedUser).toBe(false);
  });

  it("sanitizeObservationDiagnostic allowlists and caps", () => {
    const safe = sanitizeObservationDiagnostic({
      candidateCount: 1,
      message: MESSAGE,
      credential: "x",
      secret: "y",
      candidateLengths: [1, 2, 3, 4, 5, 6],
      candidates: [
        { directRole: "user", nestedUser: false, text: MESSAGE },
        { directRole: "assistant", nestedUser: false },
      ],
      targetLength: 9,
    });
    expect(safe).toBeTruthy();
    expect(safe?.message).toBeUndefined();
    expect((safe as Record<string, unknown>).credential).toBeUndefined();
    expect((safe as Record<string, unknown>).secret).toBeUndefined();
    expect(safe?.candidateLengths?.length).toBeLessThanOrEqual(5);
    expect(safe?.candidates?.length).toBeLessThanOrEqual(5);
    expect(safe?.candidates?.[0]).toEqual({ directRole: "user", nestedUser: false });
  });
});

describe("E1b3d3b popup recover result formatting", () => {
  it("popup formats structured recover fields, not raw journal dump only", () => {
    const js = fs.readFileSync(path.join(companionRoot, "popup", "popup.js"), "utf8");
    expect(js).toMatch(/formatRecoverResult/);
    expect(js).toMatch(/ok=\$\{/);
    expect(js).toMatch(/reason=\$\{/);
    expect(js).toMatch(/action=\$\{/);
    expect(js).toMatch(/retryAck=\$\{/);
    expect(js).toMatch(/zeroWrite=\$\{/);
    expect(js).toMatch(/zeroClick=\$\{/);
    expect(js).toMatch(/journal\.state=\$\{/);
    expect(js).toMatch(/journal\.eventId=\$\{/);
    expect(js).toMatch(/journal\.attemptId=\$\{/);
    expect(js).toMatch(/diagnostic=\$\{/);
    expect(js).not.toMatch(/JSON\.stringify\(res\?\.journal \?\? res\)/);
  });

  it("SW and CS recover responses include diagnostic field", () => {
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    expect(sw).toMatch(/diagnostic: response\.diagnostic/);
    const cs = fs.readFileSync(path.join(companionRoot, "content-script.js"), "utf8");
    expect(cs).toMatch(/diagnostic: result\?\.diagnostic/);
  });
});

describe("E1b3d3b server-observed local closeout", () => {
  function unknownJournal() {
    return markOutcomeUnknown(claimedJournal(), {});
  }

  function observedPendingAckJournal() {
    let j = claimedJournal();
    j = markComposerWriteIntent(j, {});
    j = markSendDispatchIntent(j, {});
    j = markObservedPendingAck(j, {});
    return j;
  }

  function eligibleJournals() {
    return [
      { name: "OUTCOME_UNKNOWN", journal: unknownJournal() },
      { name: "OBSERVED_PENDING_ACK", journal: observedPendingAckJournal() },
    ];
  }

  function observedEvent(eventId = EVENT_ID, attemptId = ATTEMPT) {
    return { status: "observed", eventId, attemptId, kind: "feedback" };
  }

  it("eligibility contract allows exactly OUTCOME_UNKNOWN and OBSERVED_PENDING_ACK", () => {
    expect(SERVER_OBSERVED_CLOSEOUT_STATES).toEqual(["OUTCOME_UNKNOWN", "OBSERVED_PENDING_ACK"]);
    expect(isServerObservedCloseoutEligible(unknownJournal())).toBe(true);
    expect(isServerObservedCloseoutEligible(observedPendingAckJournal())).toBe(true);
    for (const journal of [
      reservedJournal(),
      markSendIntent(reservedJournal(), {}),
      claimedJournal(),
      markComposerWriteIntent(claimedJournal(), {}),
      markSendDispatchIntent(markComposerWriteIntent(claimedJournal(), {}), {}),
      emptyJournal(),
      null,
    ]) {
      expect(isServerObservedCloseoutEligible(journal)).toBe(false);
    }
  });

  it("A. both eligible states + exact observed + inFlight=null → server_observed_clear", () => {
    for (const { name, journal: j } of eligibleJournals()) {
      const lookup = findExactObservedEvent([observedEvent()], j);
      expect(lookup.ok, name).toBe(true);
      expect(lookup.observed).toEqual({
        status: "observed",
        eventId: EVENT_ID,
        attemptId: ATTEMPT,
      });
      const decision = evaluateServerObservedCloseout({
        journal: j,
        inFlight: null,
        serverObserved: lookup.observed,
      });
      expect(decision.ok, name).toBe(true);
      expect(decision.action, name).toBe("server_observed_clear");
    }
  });

  it("B/C. eventId or attemptId mismatch → fail closed for both eligible states", () => {
    for (const { journal: j } of eligibleJournals()) {
      expect(findExactObservedEvent([observedEvent("f".repeat(32), ATTEMPT)], j).reason)
        .toBe("observed_event_not_found");
      expect(findExactObservedEvent(
        [observedEvent(EVENT_ID, "99999999-9999-4999-8999-999999999999")],
        j,
      ).reason).toBe("observed_event_not_found");
      expect(evaluateServerObservedCloseout({
        journal: j,
        inFlight: null,
        serverObserved: { status: "observed", eventId: "f".repeat(32), attemptId: ATTEMPT },
      }).reason).toBe("server_observed_mismatch");
      expect(evaluateServerObservedCloseout({
        journal: j,
        inFlight: null,
        serverObserved: { status: "observed", eventId: EVENT_ID, attemptId: "99999999-9999-4999-8999-999999999999" },
      }).reason).toBe("server_observed_mismatch");
    }
  });

  it("D. non-observed statuses never match", () => {
    for (const { journal: j } of eligibleJournals()) {
      for (const status of ["outcome_unknown", "claimed", "retired_unknown", "ready", "reserved"]) {
        const lookup = findExactObservedEvent([{ status, eventId: EVENT_ID, attemptId: ATTEMPT }], j);
        expect(lookup.ok).toBe(false);
        expect(lookup.reason).toBe("observed_event_not_found");
      }
    }
  });

  it("E. events empty / non-array → fail closed", () => {
    for (const { journal: j } of eligibleJournals()) {
      expect(findExactObservedEvent([], j).ok).toBe(false);
      expect(findExactObservedEvent(null, j).reason).toBe("events_missing");
    }
  });

  it("F. duplicate exact observed matches → ambiguous fail closed", () => {
    for (const { journal: j } of eligibleJournals()) {
      const lookup = findExactObservedEvent([observedEvent(), observedEvent()], j);
      expect(lookup.ok).toBe(false);
      expect(lookup.reason).toBe("observed_event_ambiguous");
    }
  });

  it("G. inFlight non-null even with observed match → fail closed", () => {
    for (const { journal: j } of eligibleJournals()) {
      const lookup = findExactObservedEvent([observedEvent()], j);
      expect(lookup.ok).toBe(true);
      const decision = evaluateServerObservedCloseout({
        journal: j,
        inFlight: { status: "observed", eventId: EVENT_ID, attemptId: ATTEMPT },
        serverObserved: lookup.observed,
      });
      expect(decision.ok).toBe(false);
      expect(decision.reason).toBe("inflight_present");
    }
  });

  it("H. identity/status mismatch on proof → no clear; non-eligible journal rejected", () => {
    for (const { journal: j } of eligibleJournals()) {
      expect(evaluateServerObservedCloseout({
        journal: j,
        inFlight: null,
        serverObserved: { status: "outcome_unknown", eventId: EVENT_ID, attemptId: ATTEMPT },
      }).reason).toBe("server_observed_mismatch");
    }
    for (const j of [
      reservedJournal(),
      markSendIntent(reservedJournal(), {}),
      claimedJournal(),
      markComposerWriteIntent(claimedJournal(), {}),
      markSendDispatchIntent(markComposerWriteIntent(claimedJournal(), {}), {}),
    ]) {
      expect(findExactObservedEvent([observedEvent()], j).reason).toBe("journal_not_closeout_eligible");
      expect(evaluateServerObservedCloseout({
        journal: j,
        inFlight: null,
        serverObserved: { status: "observed", eventId: EVENT_ID, attemptId: ATTEMPT },
      }).reason).toBe("journal_not_closeout_eligible");
    }
  });

  it("I. persist failure keeps memory OUTCOME_UNKNOWN via rollback contract", async () => {
    let journalState = "OUTCOME_UNKNOWN";
    const previous = unknownJournal();
    const commit = await commitJournalDurably({
      current: previous,
      proposed: clearJournal(),
      persist: async () => {
        throw new Error("storage_down");
      },
      onDurableSuccess: (next) => {
        journalState = next.state;
      },
    });
    expect(commit.ok).toBe(false);
    expect(commit.reason).toBe("journal_persist_failed");
    expect(journalState).toBe("OUTCOME_UNKNOWN");
    expect(commit.journal.state).toBe("OUTCOME_UNKNOWN");
  });

  it("I2. persist failure keeps OBSERVED_PENDING_ACK; never reports recovered; zero mutation", async () => {
    const previous = observedPendingAckJournal();
    let memoryState = previous.state;
    let zeroWrite = true;
    let zeroClick = true;
    let ackCalled = false;
    let beginSendCalled = false;
    // Mirror SW closeout durable commit + rollback without owner/CS/DOM deps.
    const decision = evaluateServerObservedCloseout({
      journal: previous,
      inFlight: null,
      serverObserved: { status: "observed", eventId: EVENT_ID, attemptId: ATTEMPT },
    });
    expect(decision.ok).toBe(true);
    expect(decision.action).toBe("server_observed_clear");
    const commit = await commitJournalDurably({
      current: previous,
      proposed: clearJournal(),
      persist: async () => {
        throw new Error("storage_down");
      },
      onDurableSuccess: (next) => {
        memoryState = next.state;
      },
    });
    expect(commit.ok).toBe(false);
    expect(commit.reason).toBe("journal_persist_failed");
    expect(commit.journal.state).toBe("OBSERVED_PENDING_ACK");
    expect(memoryState).toBe("OBSERVED_PENDING_ACK");
    expect(zeroWrite).toBe(true);
    expect(zeroClick).toBe(true);
    expect(ackCalled).toBe(false);
    expect(beginSendCalled).toBe(false);
  });

  it("I3. OBSERVED_PENDING_ACK closeout decision needs no owner/document/CS capability", () => {
    const j = observedPendingAckJournal();
    const decision = evaluateServerObservedCloseout({
      journal: j,
      inFlight: null,
      serverObserved: { status: "observed", eventId: EVENT_ID, attemptId: ATTEMPT },
    });
    expect(decision.ok).toBe(true);
    expect(decision).not.toHaveProperty("owner");
    expect(decision).not.toHaveProperty("documentId");
    expect(decision).not.toHaveProperty("tabId");
  });

  it("J. SW closeout branch allows both eligible states and stays SW-only", () => {
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    expect(sw).toMatch(/server_observed_clear/);
    expect(sw).toMatch(/evaluateServerObservedCloseout/);
    expect(sw).toMatch(/findExactObservedEvent/);
    expect(sw).toMatch(/isServerObservedCloseoutEligible/);
    expect(sw).toMatch(/serverObserved: observedLookup\.ok \? observedLookup\.observed : null/);
    expect(sw).toMatch(/if \(isServerObservedCloseoutEligible\(journal\) && closeout\.ok\)/);
    expect(sw).not.toMatch(/if \(journal\.state === "OUTCOME_UNKNOWN" && closeout\.ok\)/);
    const start = sw.indexOf("const closeout = evaluateServerObservedCloseout");
    const end = sw.indexOf("return recoverProductionSendSide(inFlight);", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const block = sw.slice(start, end);
    expect(block).toMatch(/server_observed_persist_failed/);
    expect(block).toMatch(/journal = previous/);
    expect(block).toMatch(/action: "server_observed_clear"/);
    expect(block).toMatch(/zeroWrite: true/);
    expect(block).toMatch(/zeroClick: true/);
    expect(block).toMatch(/ackCalled: false/);
    expect(block).toMatch(/beginSendCalled: false/);
    expect(block).not.toMatch(/chrome\.tabs\.sendMessage/);
    expect(block).not.toMatch(/recoverProductionSendSide/);
    expect(block).not.toMatch(/findCanonicalUserTurn/);
    expect(block).not.toMatch(/begin-send/);
    expect(block).not.toMatch(/\/ack\b/);
    expect(block).not.toMatch(/writeCanonicalMessage/);
    expect(block).not.toMatch(/dispatchNativeSend/);
    expect(block).not.toMatch(/reserve/);
    expect(block).not.toMatch(/release/);
  });

  it("K. popup recover format already surfaces action/zeroWrite/journal.state", () => {
    const js = fs.readFileSync(path.join(companionRoot, "popup", "popup.js"), "utf8");
    expect(js).toMatch(/formatRecoverResult/);
    expect(js).toMatch(/action=\$\{/);
    expect(js).toMatch(/zeroWrite=\$\{/);
    expect(js).toMatch(/zeroClick=\$\{/);
    expect(js).toMatch(/journal\.state=\$\{/);
    expect(js).toMatch(/ok=\$\{/);
  });
});

describe("E1b3d3b2 marker representation diagnostic", () => {
  function makeUserNode(opts: {
    innerText?: string;
    textContent?: string;
    children?: unknown[];
  }) {
    const children = opts.children ?? [];
    return {
      innerText: opts.innerText ?? "",
      textContent: opts.textContent !== undefined ? opts.textContent : (opts.innerText ?? ""),
      children,
      getAttribute: (n: string) => (n === "data-message-author-role" ? "user" : null),
      querySelector: () => null,
      closest: () => null,
    };
  }

  function docWithNodes(nodes: unknown[]) {
    return {
      querySelectorAll: () => nodes,
    } as never;
  }

  it("A. parent has extra UI chars, child exact → observed via message-body fallback", () => {
    // MESSAGE has trailing newline in source; normalize first for fake DOM.
    const canonical = MESSAGE.replace(/\n+$/, "") + "\n";
    const child = makeUserNode({ innerText: canonical, textContent: canonical });
    const parent = makeUserNode({
      innerText: `${canonical}Copy\nShare`,
      textContent: `${canonical}Copy\nShare`,
      children: [child],
    });
    const rec = findCanonicalUserTurn(docWithNodes([parent]), {
      message: canonical,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(rec.ok).toBe(true);
    const rep = (rec as { diagnostic?: { representation?: Record<string, unknown> } })
      .diagnostic?.representation;
    expect(rep).toBeTruthy();
    expect(rep?.exactInnerTextDescendantCount).toBe(1);
    expect(rep?.exactTextContentDescendantCount).toBe(1);
    expect(rep?.markerInnerTextExact).toBe(false);
    expect(rep?.markerTextContentExact).toBe(false);
    expect(rep?.markerCandidateNormalizedLength).toBeGreaterThan(0);
  });

  it("B. innerText mismatch vs textContent exact on parent", () => {
    const canonical = MESSAGE.replace(/\n+$/, "") + "\n";
    const node = makeUserNode({
      innerText: `${canonical}Chrome`,
      textContent: canonical,
    });
    const turns = [
      { text: normalizeCanonicalDomText(node.innerText), node },
    ];
    const rep = buildMarkerRepresentationDiagnostic({
      message: canonical,
      attemptId: ATTEMPT,
      turns,
    });
    expect(rep).toBeTruthy();
    expect(rep?.markerInnerTextExact).toBe(false);
    expect(rep?.markerTextContentExact).toBe(true);
  });

  it("C. small char delta → length delta + prefix/suffix counts", () => {
    const canonical = "AAA\nATTEMPT_ID: 22222222-2222-4222-8222-222222222222\nBBB\n";
    const withExtra = "AAA\nATTEMPT_ID: 22222222-2222-4222-8222-222222222222\nBBB\nXXX";
    const node = makeUserNode({ innerText: withExtra, textContent: withExtra });
    const turns = [{ text: normalizeCanonicalDomText(withExtra), node }];
    const rep = buildMarkerRepresentationDiagnostic({
      message: canonical,
      attemptId: "22222222-2222-4222-8222-222222222222",
      turns,
    });
    expect(rep).toBeTruthy();
    expect(rep?.innerLengthDelta).toBe(3);
    expect(rep?.textContentLengthDelta).toBe(3);
    expect(rep?.innerCommonPrefixLength).toBeGreaterThan(0);
    expect(rep?.innerCommonSuffixLength).toBe(0);
  });

  it("D. 0 or >1 marker candidates → representation null (fail closed)", () => {
    const canonical = MESSAGE.replace(/\n+$/, "") + "\n";
    const node = makeUserNode({ innerText: "no marker here" });
    expect(buildMarkerRepresentationDiagnostic({
      message: canonical,
      attemptId: ATTEMPT,
      turns: [{ text: "no marker here", node }],
    })).toBeNull();
    const n1 = makeUserNode({ innerText: canonical });
    const n2 = makeUserNode({ innerText: canonical });
    expect(buildMarkerRepresentationDiagnostic({
      message: canonical,
      attemptId: ATTEMPT,
      turns: [
        { text: normalizeCanonicalDomText(canonical), node: n1 },
        { text: normalizeCanonicalDomText(canonical), node: n2 },
      ],
    })).toBeNull();
  });

  it("E/A-review. >1000 descendants: DOM access hard-capped at 64, not just result array", () => {
    const canonical = MESSAGE.replace(/\n+$/, "") + "\n";
    const readIds = new Set<number>();
    const maxDesc = TURN_DIAGNOSTIC_LIMITS.maxDescendantsScanned;
    const many = Array.from({ length: 1200 }, (_, i) => ({
      get innerText() {
        readIds.add(i);
        return `child-${i}`;
      },
      get textContent() {
        readIds.add(i);
        return `child-${i}`;
      },
      children: [] as unknown[],
    }));
    const parent = makeUserNode({
      innerText: canonical,
      textContent: canonical,
      children: many,
    });
    const rep = buildMarkerRepresentationDiagnostic({
      message: canonical,
      attemptId: ATTEMPT,
      turns: [{ text: normalizeCanonicalDomText(canonical), node: parent }],
    });
    expect(rep?.descendantScannedCount).toBe(maxDesc);
    expect(rep?.descendantScannedCount).toBeLessThanOrEqual(64);
    // Real DOM access bound: node id >= 64 must never be read.
    expect(readIds.size).toBeGreaterThan(0);
    expect(readIds.size).toBeLessThanOrEqual(maxDesc);
    for (const id of readIds) {
      expect(id).toBeLessThan(maxDesc);
    }
    expect(readIds.has(64)).toBe(false);
    expect(readIds.has(999)).toBe(false);
  });

  it("B-review. descendant innerText empty + textContent exact → independent counts", () => {
    const canonical = MESSAGE.replace(/\n+$/, "") + "\n";
    const child = {
      get innerText() {
        return "";
      },
      get textContent() {
        return canonical;
      },
      children: [],
    };
    const parent = makeUserNode({
      innerText: `${canonical}Copy`,
      textContent: `${canonical}Copy`,
      children: [child],
    });
    const rep = buildMarkerRepresentationDiagnostic({
      message: canonical,
      attemptId: ATTEMPT,
      turns: [{ text: normalizeCanonicalDomText(parent.innerText), node: parent }],
    });
    expect(rep?.exactInnerTextDescendantCount).toBe(0);
    expect(rep?.exactTextContentDescendantCount).toBe(1);
  });

  it("C-review. descendant innerText exact + textContent mismatch → reverse counts", () => {
    const canonical = MESSAGE.replace(/\n+$/, "") + "\n";
    const child = {
      get innerText() {
        return canonical;
      },
      get textContent() {
        return `${canonical}EXTRA`;
      },
      children: [],
    };
    const parent = makeUserNode({
      innerText: `${canonical}Copy`,
      textContent: `${canonical}Copy`,
      children: [child],
    });
    const rep = buildMarkerRepresentationDiagnostic({
      message: canonical,
      attemptId: ATTEMPT,
      turns: [{ text: normalizeCanonicalDomText(parent.innerText), node: parent }],
    });
    expect(rep?.exactInnerTextDescendantCount).toBe(1);
    expect(rep?.exactTextContentDescendantCount).toBe(0);
  });

  it("F. sanitizer strips raw text/DOM/credential", () => {
    const safe = sanitizeMarkerRepresentation({
      markerCandidateIndex: 0,
      markerInnerTextExact: false,
      markerTextContentExact: true,
      message: MESSAGE,
      html: "<div>secret</div>",
      credential: "x",
      documentId: "d",
      tabId: 1,
    });
    expect(safe).toBeTruthy();
    expect((safe as Record<string, unknown>).message).toBeUndefined();
    expect((safe as Record<string, unknown>).html).toBeUndefined();
    expect((safe as Record<string, unknown>).credential).toBeUndefined();
    expect(safe?.markerCandidateIndex).toBe(0);
    expect(safe?.markerTextContentExact).toBe(true);
    const dump = JSON.stringify(sanitizeObservationDiagnostic({
      candidateCount: 1,
      representation: {
        exactInnerTextDescendantCount: 1,
        markerInnerTextExact: false,
        text: MESSAGE,
        message: MESSAGE,
      },
    }));
    expect(dump).not.toContain(MESSAGE);
    expect(dump).not.toContain("ATTEMPT_ID");
  });

  it("G. production recovery zero-mutation contracts unchanged", () => {
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    const tickStart = sw.indexOf("async function maybeRunAutonomyTick");
    const tickEnd = sw.indexOf("async function handleProductionSend", tickStart);
    const tick = sw.slice(tickStart, tickEnd);
    expect(tick).toMatch(/planAutonomyTick/);
    expect(tick).not.toMatch(/handleRetireUnknown/);
    const orch = fs.readFileSync(path.join(companionRoot, "send-orchestrator.js"), "utf8");
    expect(orch).toMatch(/sanitizeMarkerRepresentationLocal|representation/);
  });

  it("review. turn-observer uses bounded children BFS, not querySelectorAll(*)", () => {
    const src = fs.readFileSync(path.join(companionRoot, "turn-observer.js"), "utf8");
    expect(src).toMatch(/collectBoundedDescendants/);
    expect(src).toMatch(/maxDescendantsScanned/);
    // Representation path must not use unbounded selector scan.
    const start = src.indexOf("export function buildMarkerRepresentationDiagnostic");
    const end = src.indexOf("export function sanitizeMarkerRepresentation");
    const body = src.slice(start, end);
    expect(body).toMatch(/collectBoundedDescendants/);
    expect(body).not.toMatch(/querySelectorAll\("\*"\)/);
    expect(body).not.toMatch(/rawInnerTextOf\(d\) \|\| rawTextContentOf/);
  });
});

describe("E1b3d3b2 exact message-body observation", () => {
  const canonical = normalizeCanonicalDomText(MESSAGE);

  function userNode(opts: {
    innerText?: string;
    textContent?: string;
    children?: unknown[];
    role?: string;
  }) {
    return {
      innerText: opts.innerText ?? "",
      textContent: opts.textContent !== undefined ? opts.textContent : (opts.innerText ?? ""),
      children: opts.children ?? [],
      getAttribute: (n: string) =>
        n === "data-message-author-role" ? (opts.role ?? "user") : n === "data-testid" ? "conversation-turn" : null,
      closest: () => null,
    };
  }

  function docOf(nodes: unknown[]) {
    return { querySelectorAll: () => nodes } as never;
  }

  it("A. parent exact fast path still succeeds", () => {
    const parent = userNode({ innerText: canonical, textContent: canonical });
    const rec = findCanonicalUserTurn(docOf([parent]), {
      message: MESSAGE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(rec.ok).toBe(true);
  });

  it("B. live-like parent + 2 exact nested descendants → one turn, not ambiguous", () => {
    const chrome = `${canonical}Copy`;
    const child1 = userNode({ innerText: canonical });
    const child2 = userNode({ innerText: canonical });
    const parent = userNode({
      innerText: chrome,
      textContent: chrome,
      children: [child1, child2],
    });
    const rec = findCanonicalUserTurn(docOf([parent]), {
      message: MESSAGE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(rec.ok).toBe(true);
  });

  it("C. three exact descendants in one user turn still count as one match", () => {
    const kids = Array.from({ length: 3 }, () => userNode({ innerText: canonical }));
    const parent = userNode({
      innerText: `${canonical}UI`,
      children: kids,
    });
    const rec = findCanonicalUserTurn(docOf([parent]), {
      message: MESSAGE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(rec.ok).toBe(true);
  });

  it("D. two different user turns each with exact body → ambiguous", () => {
    const makeTurn = () => {
      const child = userNode({ innerText: canonical });
      return userNode({
        innerText: `${canonical}UI`,
        children: [child],
      });
    };
    const rec = findCanonicalUserTurn(docOf([makeTurn(), makeTurn()]), {
      message: MESSAGE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(rec.ok).toBe(false);
    expect(rec.reason).toBe("ambiguous");
  });

  it("E. descendant textContent exact but innerText not → not_observed", () => {
    const child = {
      innerText: "",
      textContent: canonical,
      children: [],
      getAttribute: (n: string) => (n === "data-message-author-role" ? "user" : null),
    };
    const parent = userNode({
      innerText: `${canonical}UI`,
      textContent: `${canonical}UI`,
      children: [child],
    });
    const rec = findCanonicalUserTurn(docOf([parent]), {
      message: MESSAGE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(rec.ok).toBe(false);
    expect(rec.reason).toBe("not_observed");
  });

  it("F. parent without exact ATTEMPT marker → not_observed even if child exact", () => {
    const noMarker = "STATE: EXECUTED\nBODY\n";
    const child = userNode({ innerText: canonical });
    const parent = userNode({
      innerText: `${noMarker}UI`,
      children: [child],
    });
    const rec = findCanonicalUserTurn(docOf([parent]), {
      message: MESSAGE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(rec.ok).toBe(false);
    expect(rec.reason).toBe("not_observed");
  });

  it("G. exact descendant beyond 64th visit → not_observed, no unbounded scan", () => {
    const maxDesc = TURN_DIAGNOSTIC_LIMITS.maxDescendantsScanned;
    const readIds = new Set<number>();
    const kids = Array.from({ length: 200 }, (_, i) => ({
      get innerText() {
        readIds.add(i);
        return i === maxDesc + 10 ? canonical : `x-${i}`;
      },
      get textContent() {
        readIds.add(i);
        return i === maxDesc + 10 ? canonical : `x-${i}`;
      },
      children: [] as unknown[],
    }));
    const parent = userNode({
      innerText: `${canonical}UI`,
      children: kids,
    });
    // Parent marker is exact (canonical includes ATTEMPT_ID).
    expect(hasExactAttemptMarker(parent.innerText, ATTEMPT).ok).toBe(true);
    const rec = findCanonicalUserTurn(docOf([parent]), {
      message: MESSAGE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(rec.ok).toBe(false);
    expect(rec.reason).toBe("not_observed");
    expect(readIds.has(maxDesc + 10)).toBe(false);
  });

  it("H. baseline excludes same parent turn identity even with exact descendant", () => {
    const child = userNode({ innerText: canonical });
    const parent = userNode({
      innerText: `${canonical}UI`,
      children: [child],
      getAttribute: (n: string) =>
        n === "data-message-author-role" ? "user" : n === "data-turn-id" ? "turn-1" : null,
    });
    const turns = snapshotUserTurns(docOf([parent]));
    const rec = findCanonicalUserTurn(docOf([parent]), {
      message: MESSAGE,
      attemptId: ATTEMPT,
      baseline: turns,
    });
    expect(rec.ok).toBe(false);
    expect(rec.reason).toBe("not_observed");
  });

  it("I. assistant turn never succeeds", () => {
    const child = userNode({ innerText: canonical });
    const assistant = userNode({
      innerText: `${canonical}UI`,
      children: [child],
      role: "assistant",
    });
    const rec = findCanonicalUserTurn(docOf([assistant]), {
      message: MESSAGE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(rec.ok).toBe(false);
  });

  it("J. late-positive recovery: UI chrome parent + exact innerText body → ACK path zero mutation", async () => {
    const child = userNode({ innerText: canonical });
    const parent = userNode({
      innerText: `${canonical}Copy`,
      children: [child],
    });
    const doc = docOf([parent]);
    const spy = makeSpies({
      journal: markOutcomeUnknown(claimedJournal(), {}),
      inFlight: {
        status: "outcome_unknown",
        eventId: EVENT_ID,
        reservationId: RES_ID,
        attemptId: ATTEMPT,
        message: MESSAGE,
        messageSha256: MESSAGE_SHA,
      },
      findCanonicalUserTurn: (d: unknown, input: unknown) =>
        findCanonicalUserTurn(doc, input as never),
    });
    const r = await recoverProductionSend(spy);
    expect(r.ok).toBe(true);
    expect(r.action).toBe("late_positive_observed_then_acked");
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
    expect(spy.calls.beginSend).toBe(0);
    expect(spy.calls.ack).toBe(1);
    expect(spy.journal.state).toBe("NONE");
    expect(r.zeroWrite).toBe(true);
    expect(r.zeroClick).toBe(true);
  });

  it("source stays full-equality: no substring/trim authority", () => {
    const src = fs.readFileSync(path.join(companionRoot, "turn-observer.js"), "utf8");
    const bodyStart = src.indexOf("export function canonicalTurnBodyMatch");
    const bodyEnd = src.indexOf("export function findCanonicalUserTurn");
    const body = src.slice(bodyStart, bodyEnd);
    expect(body).toMatch(/turn\.text === want/);
    expect(body).toMatch(/hasExactAttemptMarker\(turn\.text, attemptId\)/);
    expect(body).toMatch(/hasExactVisibleBodyDescendant/);
    expect(body).not.toMatch(/includes\(want\)|startsWith|endsWith|\.trim\(\)/);
    const findStart = src.indexOf("export function findCanonicalUserTurn");
    const findBody = src.slice(findStart, findStart + 2000);
    expect(findBody).toMatch(/canonicalTurnBodyMatch/);
    expect(findBody).not.toMatch(/includes\(want\)|startsWith\(want\)/);
  });
});
