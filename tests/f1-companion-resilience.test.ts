/**
 * F1b Browser Companion resilience matrix.
 * Test-first: prove exactly-once / fail-closed under SW restart, crash,
 * network/auth faults, owner loss, route drift, cooldown, and corrupt durable state.
 * Reuses pure modules; does not duplicate large production-send fixtures.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
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
  markOutcomeUnknown,
  markLateObservedPendingAck,
  hydrateJournal,
  validateSendJournalShape,
  reconcileReservedJournal,
  journalIsSendSide,
  journalActive,
  journalInPostMutationFence,
  isLegalJournalTransition,
  JOURNAL_STATES,
} from "../browser-companion/reservation-journal.js";
import {
  planAutonomyTick,
  parseAutonomyPolicy,
  emptyAutonomyPolicy,
  withProductionAttemptStamp,
  operationalHealthSummary,
  disarmOnIdentityChange,
  isTransportUsable,
  isExactOwnerHeartbeat,
  AUTONOMY_PRODUCTION_COOLDOWN_MS,
} from "../browser-companion/autonomy.js";
import {
  canStartProductionSend,
  evaluateServerObservedCloseout,
  findExactObservedEvent,
  classifyProductionStartRpcResult,
  isServerObservedCloseoutEligible,
} from "../browser-companion/production-send.js";
import { recoverSendOrchestration } from "../browser-companion/send-orchestrator.js";
import { recoverProductionSend } from "../browser-companion/production-send-runtime.js";
import {
  evaluateReserveEligibility,
  pairAllowedWithJournal,
} from "../browser-companion/reservation-journal.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const companionRoot = path.join(projectRoot, "browser-companion");

const ROUTE = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const BINDING = "b".repeat(36);
const EVENT_ID = "e".repeat(32);
const RES_ID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT = "22222222-2222-4222-8222-222222222222";
const MESSAGE = `[C2C_CONTROL]\nSTATE: EXECUTED\nEVENT_ID: ${EVENT_ID}\nATTEMPT_ID: ${ATTEMPT}\n`;
const MESSAGE_SHA = "a".repeat(64);

const TRANSPORT = {
  authStale: false,
  bindingId: BINDING,
  epoch: 1,
  routeCanonical: ROUTE,
  workspaceId: "2582910bf0d2",
  companionId: "c".repeat(36),
  credential: "secret-should-never-leak",
};
const OWNER = { tabId: 7, documentId: "doc-1", canonicalRoute: ROUTE, generation: 3 };
const EVIDENCE = {
  observedAt: Date.now(),
  documentId: OWNER.documentId,
  canonicalRoute: ROUTE,
  composer: "empty" as const,
  generation: "idle" as const,
  safe: true,
};

function armedPolicy(overrides: Record<string, unknown> = {}) {
  return {
    ...emptyAutonomyPolicy(),
    mode: "armed" as const,
    bindingId: BINDING,
    epoch: 1,
    routeCanonical: ROUTE,
    armedAt: Date.now(),
    ...overrides,
  };
}

function baseState(overrides: Record<string, unknown> = {}) {
  return {
    policy: armedPolicy(),
    storageProtected: true,
    transport: TRANSPORT,
    owner: OWNER,
    evidence: { ...EVIDENCE, observedAt: Date.now() },
    journal: { state: "NONE" },
    sendProbeLatch: "NONE",
    productionSendInFlight: false,
    autonomyTickInFlight: false,
    inFlight: null,
    pendingReady: 1,
    now: Date.now(),
    ...overrides,
  };
}

function reservedJournal() {
  let j = emptyJournal();
  j = markReserveRequested(j, { routeCanonical: ROUTE, bindingId: BINDING, epoch: 1 });
  j = markReserved(j, {
    eventId: EVENT_ID,
    reservationId: RES_ID,
    routeCanonical: ROUTE,
    bindingId: BINDING,
    epoch: 1,
  });
  return j;
}

function sendIntentJournal() {
  return markSendIntent(reservedJournal(), {});
}

function claimedJournal() {
  return markClaimed(sendIntentJournal(), {
    eventId: EVENT_ID,
    reservationId: RES_ID,
    attemptId: ATTEMPT,
    message: MESSAGE,
    messageSha256: MESSAGE_SHA,
  });
}

function makeRecoverSpies(overrides: Record<string, unknown> = {}) {
  const calls = {
    persist: [] as string[],
    beginSend: 0,
    ack: 0,
    write: 0,
    click: 0,
  };
  let journal = sendIntentJournal();
  if (overrides.journal) journal = overrides.journal as typeof journal;
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
  const dispatchNativeSend = async () => {
    calls.click += 1;
    return { ok: true, clicked: 1 };
  };
  const findCanonicalUserTurn = () => ({ ok: true, turn: { id: "u1", text: MESSAGE } });
  const { journal: _j, ...rest } = overrides;
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
    dispatchNativeSend,
    inspectComposerWriteCapability: () => ({ ok: true, editorKind: "contenteditable", action: { kind: "idle", enabled: true } }),
    verifyCanonicalComposer: async () => ({ ok: true }),
    snapshotUserTurns: () => [],
    findCanonicalUserTurn,
    hasExactAttemptMarker: () => ({ ok: true }),
    getCurrentRoute: () => ROUTE,
    getCurrentGeneration: () => 3,
    waitForSendReady: async () => ({ ok: true }),
    doc: {} as never,
    expectedRoute: ROUTE,
    expectedGeneration: 3,
    routeCanonical: ROUTE,
    bindingId: BINDING,
    epoch: 1,
    maxPollAttempts: 2,
    pollIntervalMs: 1,
    sleep: async () => {},
    ...rest,
  };
}

function healthBase(overrides: Record<string, unknown> = {}) {
  return {
    policy: armedPolicy(),
    identityExact: true,
    ownerAvailable: true,
    storageProtected: true,
    transport: { ...TRANSPORT, connected: true },
    journalState: "NONE",
    lastHeartbeatAt: Date.now() - 100,
    lastTickAt: Date.now() - 200,
    now: Date.now(),
    ...overrides,
  };
}

function swSource() {
  return fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
}

describe("F1b 1. SW restart / hydrate durability", () => {
  it("autonomy policy + cooldown + journal survive parse/hydrate; RESERVED continues same reservation", () => {
    const stamp = withProductionAttemptStamp(armedPolicy(), 12_345);
    const hydratedPolicy = parseAutonomyPolicy(JSON.parse(JSON.stringify(stamp)));
    expect(hydratedPolicy.mode).toBe("armed");
    expect(hydratedPolicy.lastProductionAttemptAt).toBe(12_345);

    const journal = reservedJournal();
    const hydrateShape = validateSendJournalShape(journal);
    expect(hydrateShape.ok).toBe(true);
    expect(hydrateJournal({ ...journal }).state).toBe("RESERVED");

    const now = 12_345 + 1_000;
    const plan = planAutonomyTick(baseState({
      now,
      policy: hydratedPolicy,
      journal,
      pendingReady: 9,
      evidence: { ...EVIDENCE, observedAt: now },
    }));
    expect(plan.decision).toBe("recovering");
    expect(plan.journalState).toBe("RESERVED");

    const rec = reconcileReservedJournal(journal, {
      status: "reserved",
      eventId: EVENT_ID,
      reservationId: RES_ID,
    });
    expect(rec.action).toBe("keep");
    expect(rec.journal.eventId).toBe(EVENT_ID);
    expect(rec.journal.reservationId).toBe(RES_ID);
  });

  it("SW hydrate keeps durable journal/autonomy keys and defaults autonomy OFF", () => {
    const sw = swSource();
    expect(sw).toMatch(/JOURNAL_KEY/);
    expect(sw).toMatch(/AUTONOMY_STORAGE_KEY/);
    expect(sw).toMatch(/parseAutonomyPolicy\(stored\[AUTONOMY_STORAGE_KEY\]\)/);
    expect(sw).toMatch(/Default OFF\. Never auto-arm on hydrate/);
  });
});

describe("F1b 2. SEND_INTENT crash recovery", () => {
  it("local SEND_INTENT + server no inFlight → safe clear, beginSend=0 write=0 click=0", async () => {
    const spy = makeRecoverSpies({ journal: sendIntentJournal(), inFlight: null });
    const r = await recoverProductionSend(spy);
    expect(r.ok).toBe(true);
    expect(r.action).toBe("clear");
    expect(spy.journal.state).toBe("NONE");
    expect(spy.calls.beginSend).toBe(0);
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
  });

  it("local SEND_INTENT + exact server claimed → adopt/continue without second reserve", async () => {
    const spy = makeRecoverSpies({
      journal: sendIntentJournal(),
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
    expect(spy.calls.persist).toContain("CLAIMED");
  });

  it("local SEND_INTENT + exact server reserved → retry same reservation beginSend once", async () => {
    const spy = makeRecoverSpies({
      journal: sendIntentJournal(),
      inFlight: { status: "reserved", eventId: EVENT_ID, reservationId: RES_ID },
    });
    const r = await recoverProductionSend(spy);
    expect(r.ok).toBe(true);
    expect(spy.calls.beginSend).toBe(1);
  });

  it("local SEND_INTENT + mismatched server identity → fail closed, zero mutation", async () => {
    for (const inFlight of [
      { status: "reserved", eventId: "f".repeat(32), reservationId: RES_ID },
      { status: "reserved", eventId: EVENT_ID, reservationId: "33333333-3333-4333-8333-333333333333" },
      { status: "claimed", eventId: EVENT_ID, reservationId: RES_ID, attemptId: "44444444-4444-4444-8444-444444444444" },
    ]) {
      const spy = makeRecoverSpies({ journal: sendIntentJournal(), inFlight });
      const r = await recoverProductionSend(spy);
      expect(r.ok).toBe(false);
      expect(["inflight_mismatch", "adopt_claimed_failed"]).toContain(r.reason);
      expect(spy.calls.beginSend).toBe(0);
      expect(spy.calls.write).toBe(0);
      expect(spy.calls.click).toBe(0);
      expect(spy.journal.state).toBe("SEND_INTENT");
    }
  });

  it("planAutonomyTick never reserves again while SEND_INTENT durable", () => {
    const plan = planAutonomyTick(baseState({
      journal: sendIntentJournal(),
      pendingReady: 5,
      policy: armedPolicy({ lastProductionAttemptAt: Date.now() }),
    }));
    expect(plan.decision).toBe("recovering");
    expect(plan.journalState).toBe("SEND_INTENT");
  });
});

describe("F1b 3. Post-mutation crash fence", () => {
  it("COMPOSER_WRITE_INTENT restart: write=0 click=0 beginSend=0; observe-only when not observed", async () => {
    const j = markComposerWriteIntent(claimedJournal(), {});
    const spy = makeRecoverSpies({
      journal: j,
      findCanonicalUserTurn: () => ({ ok: false, reason: "not_observed" }),
    });
    const r = await recoverProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(r.zeroWrite).toBe(true);
    expect(r.zeroClick).toBe(true);
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
    expect(spy.calls.beginSend).toBe(0);
  });

  it("SEND_DISPATCH_INTENT restart: write=0 click=0 beginSend=0; ACK-safe continuation only when observed", async () => {
    let j = markComposerWriteIntent(claimedJournal(), {});
    j = markSendDispatchIntent(j, {});
    const blocked = makeRecoverSpies({
      journal: j,
      findCanonicalUserTurn: () => ({ ok: false, reason: "not_observed" }),
    });
    const rBlocked = await recoverProductionSend(blocked);
    expect(rBlocked.ok).toBe(false);
    expect(blocked.calls.write).toBe(0);
    expect(blocked.calls.click).toBe(0);
    expect(blocked.calls.beginSend).toBe(0);

    const observed = makeRecoverSpies({ journal: j });
    const rObs = await recoverProductionSend(observed);
    expect(rObs.ok).toBe(true);
    expect(observed.calls.write).toBe(0);
    expect(observed.calls.click).toBe(0);
    expect(observed.calls.beginSend).toBe(0);
    expect(observed.calls.ack).toBe(1);
    expect(observed.journal.state).toBe("NONE");
  });

  it("post-mutation fence states stay post-mutation under legality and health recovery-required", () => {
    expect(journalInPostMutationFence(markComposerWriteIntent(claimedJournal(), {}))).toBe(true);
    expect(journalIsSendSide(markComposerWriteIntent(claimedJournal(), {}))).toBe(true);
    const h = operationalHealthSummary(healthBase({
      journalState: "COMPOSER_WRITE_INTENT",
      policy: armedPolicy(),
    }));
    expect(h.state).toBe("journal_recovery");
    expect(h.reason).toBe("journal_active");
  });
});

describe("F1b 4. OBSERVED_PENDING_ACK", () => {
  function observedPendingAckJournal() {
    let j = claimedJournal();
    j = markComposerWriteIntent(j, {});
    j = markSendDispatchIntent(j, {});
    j = markObservedPendingAck(j, {});
    return j;
  }

  it("only ACK retry or exact server-observed closeout; never write/click/beginSend", async () => {
    const spy = makeRecoverSpies({ journal: observedPendingAckJournal() });
    const r = await recoverProductionSend(spy);
    expect(r.ok).toBe(true);
    expect(spy.calls.ack).toBe(1);
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
    expect(spy.calls.beginSend).toBe(0);
    expect(spy.journal.state).toBe("NONE");
  });

  it("ACK failure keeps OBSERVED_PENDING_ACK for retry; health recovery_required", async () => {
    const spy = makeRecoverSpies({ journal: observedPendingAckJournal() });
    spy.ackObserved = async () => {
      throw new Error("bridge_offline");
    };
    const r = await recoverProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(r.retryAck).toBe(true);
    expect(spy.journal.state).toBe("OBSERVED_PENDING_ACK");
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
    expect(spy.calls.beginSend).toBe(0);

    const h = operationalHealthSummary(healthBase({ journalState: "OBSERVED_PENDING_ACK" }));
    expect(h.state).toBe("journal_recovery");
    expect(h.reason).toBe("recovery_required");
  });

  it("OBSERVED_PENDING_ACK + exact server-observed + inFlight=null → server_observed_clear", () => {
    // True OBSERVED_PENDING_ACK coverage (not OUTCOME_UNKNOWN stand-in).
    // Restart closeout when server already observed after lost ACK response/local clear.
    const j = observedPendingAckJournal();
    expect(j.state).toBe("OBSERVED_PENDING_ACK");
    const lookup = findExactObservedEvent(
      [{ status: "observed", eventId: EVENT_ID, attemptId: ATTEMPT }],
      j,
    );
    expect(lookup.ok).toBe(true);
    const good = evaluateServerObservedCloseout({
      journal: j,
      inFlight: null,
      serverObserved: lookup.observed,
    });
    expect(good.ok).toBe(true);
    expect(good.action).toBe("server_observed_clear");

    expect(evaluateServerObservedCloseout({
      journal: j,
      inFlight: { status: "observed", eventId: EVENT_ID, attemptId: ATTEMPT },
      serverObserved: lookup.observed,
    }).ok).toBe(false);

    expect(evaluateServerObservedCloseout({
      journal: j,
      inFlight: null,
      serverObserved: { status: "observed", eventId: "f".repeat(32), attemptId: ATTEMPT },
    }).ok).toBe(false);

    expect(evaluateServerObservedCloseout({
      journal: j,
      inFlight: null,
      serverObserved: { status: "observed", eventId: EVENT_ID, attemptId: "99999999-9999-4999-8999-999999999999" },
    }).ok).toBe(false);
  });

  it("OBSERVED_PENDING_ACK owner-loss closeout needs no owner/content-script", () => {
    const j = observedPendingAckJournal();
    const decision = evaluateServerObservedCloseout({
      journal: j,
      inFlight: null,
      serverObserved: { status: "observed", eventId: EVENT_ID, attemptId: ATTEMPT },
    });
    expect(decision.ok).toBe(true);
    expect(isServerObservedCloseoutEligible(j)).toBe(true);
    // Decision object carries no owner/document authority.
    expect(Object.keys(decision).sort()).toEqual(["action", "ok"]);

    const sw = swSource();
    const start = sw.indexOf("const closeout = evaluateServerObservedCloseout");
    const end = sw.indexOf("return recoverProductionSendSide(inFlight);", start);
    const block = sw.slice(start, end);
    expect(block).toMatch(/isServerObservedCloseoutEligible\(journal\) && closeout\.ok/);
    expect(block).not.toMatch(/ownerState/);
    expect(block).not.toMatch(/isOwner/);
    expect(block).not.toMatch(/chrome\.tabs\.sendMessage/);
  });

  it("OBSERVED_PENDING_ACK non-eligible peers still fail closed on closeout", () => {
    for (const j of [
      reservedJournal(),
      sendIntentJournal(),
      claimedJournal(),
      markComposerWriteIntent(claimedJournal(), {}),
      markSendDispatchIntent(markComposerWriteIntent(claimedJournal(), {}), {}),
    ]) {
      expect(isServerObservedCloseoutEligible(j)).toBe(false);
      expect(evaluateServerObservedCloseout({
        journal: j,
        inFlight: null,
        serverObserved: { status: "observed", eventId: EVENT_ID, attemptId: ATTEMPT },
      }).reason).toBe("journal_not_closeout_eligible");
    }
  });
});

describe("F1b 5. OUTCOME_UNKNOWN never resend", () => {
  function unknownJournal() {
    return markOutcomeUnknown(claimedJournal(), {});
  }

  it("zero resend/write/click/beginSend unless exact server identity + exact canonical turn", async () => {
    const spy = makeRecoverSpies({ journal: unknownJournal(), inFlight: null });
    const r = await recoverProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("outcome_unknown");
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
    expect(spy.calls.beginSend).toBe(0);
    expect(spy.calls.ack).toBe(0);
    expect(spy.journal.state).toBe("OUTCOME_UNKNOWN");
  });

  it("exact late-positive path OUTCOME_UNKNOWN → OBSERVED_PENDING_ACK → ACK → NONE", async () => {
    const spy = makeRecoverSpies({
      journal: unknownJournal(),
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
    expect(r.action).toBe("late_positive_observed_then_acked");
    expect(spy.calls.persist).toEqual(["OBSERVED_PENDING_ACK", "NONE"]);
    expect(spy.journal.state).toBe("NONE");
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
    expect(spy.calls.beginSend).toBe(0);
    expect(spy.calls.ack).toBe(1);
  });

  it("OUTCOME_UNKNOWN + exact server-observed + inFlight=null → server_observed_clear", () => {
    const j = unknownJournal();
    const lookup = findExactObservedEvent(
      [{ status: "observed", eventId: EVENT_ID, attemptId: ATTEMPT }],
      j,
    );
    expect(lookup.ok).toBe(true);
    const decision = evaluateServerObservedCloseout({
      journal: j,
      inFlight: null,
      serverObserved: lookup.observed,
    });
    expect(decision.ok).toBe(true);
    expect(decision.action).toBe("server_observed_clear");
  });

  it("mismatched identity or non-exact turn blocks late-positive", async () => {
    const mismatch = makeRecoverSpies({
      journal: unknownJournal(),
      inFlight: {
        status: "claimed",
        eventId: "f".repeat(32),
        reservationId: RES_ID,
        attemptId: ATTEMPT,
        message: MESSAGE,
        messageSha256: MESSAGE_SHA,
      },
    });
    const r1 = await recoverProductionSend(mismatch);
    expect(r1.ok).toBe(false);
    expect(r1.reason).toBe("late_positive_identity_mismatch");
    expect(mismatch.calls.ack).toBe(0);
    expect(mismatch.calls.beginSend).toBe(0);

    const noTurn = makeRecoverSpies({
      journal: unknownJournal(),
      inFlight: {
        status: "claimed",
        eventId: EVENT_ID,
        reservationId: RES_ID,
        attemptId: ATTEMPT,
        message: MESSAGE,
        messageSha256: MESSAGE_SHA,
      },
      findCanonicalUserTurn: () => ({ ok: false, reason: "not_observed" }),
    });
    const r2 = await recoverProductionSend(noTurn);
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe("outcome_unknown");
    expect(noTurn.calls.write).toBe(0);
    expect(noTurn.calls.click).toBe(0);
    expect(noTurn.calls.beginSend).toBe(0);
  });

  it("OUTCOME_UNKNOWN health is recovery_required; planner recovering not reserve", () => {
    const h = operationalHealthSummary(healthBase({ journalState: "OUTCOME_UNKNOWN" }));
    expect(h.state).toBe("journal_recovery");
    expect(h.reason).toBe("recovery_required");
    const plan = planAutonomyTick(baseState({ journal: unknownJournal(), pendingReady: 4 }));
    expect(plan.decision).toBe("recovering");
    expect(plan.journalState).toBe("OUTCOME_UNKNOWN");
  });

  it("markObservedPendingAck cannot legally leave OUTCOME_UNKNOWN; only late-positive path", () => {
    const j = unknownJournal();
    expect(() => markObservedPendingAck(j, {})).toThrow(/OUTCOME_UNKNOWN/);
    expect(isLegalJournalTransition("OUTCOME_UNKNOWN", "OBSERVED_PENDING_ACK")).toBe(true);
    expect(isLegalJournalTransition("OUTCOME_UNKNOWN", "RESERVED")).toBe(false);
    expect(isLegalJournalTransition("OUTCOME_UNKNOWN", "CLAIMED")).toBe(false);
    expect(markLateObservedPendingAck(j, {}).state).toBe("OBSERVED_PENDING_ACK");
  });
});

describe("F1b 6. ChatGPT tab reload / owner loss", () => {
  it("same tabId different documentId is NOT the same owner", () => {
    const owner = OWNER;
    expect(isExactOwnerHeartbeat({
      identityOk: true,
      tabId: owner.tabId,
      documentId: "other-doc",
      canonicalRoute: ROUTE,
      owner,
      transportRoute: ROUTE,
    })).toBe(false);
  });

  it("owner loss → health waiting_owner / production start blocked until exact owner", () => {
    const h = operationalHealthSummary(healthBase({ ownerAvailable: false }));
    expect(h.state).toBe("waiting_owner");
    expect(h.reason).toBe("owner_unavailable");

    const start = canStartProductionSend({
      owner: null,
      transport: TRANSPORT,
      journal: reservedJournal(),
      latch: { state: "NONE" },
      evidence: EVIDENCE,
    });
    expect(start.ok).toBe(false);
    expect(start.reason).toBe("owner_document_invalid");

    // Pure planner fail-closes when evidence document ≠ owner document.
    // Same tabId is never enough — SW re-validates exact documentId heartbeat.
    const plan = planAutonomyTick(baseState({
      owner: { tabId: 7, documentId: "doc-1", canonicalRoute: ROUTE },
      evidence: { ...EVIDENCE, documentId: "other-doc" },
    }));
    expect(plan.decision).toBe("gate_failed");

    const sw = swSource();
    const tickStart = sw.indexOf("async function maybeRunAutonomyTick");
    const tick = sw.slice(tickStart, tickStart + 1200);
    expect(tick).toMatch(/isExactOwnerHeartbeat/);
    expect(tick).toMatch(/not_exact_owner_heartbeat/);
  });
});

describe("F1b 7. SPA route / conversation drift", () => {
  it("route/binding/epoch drift disarms or fails closed; never cross-conversation send", () => {
    const armed = armedPolicy();
    expect(disarmOnIdentityChange(armed, { ...TRANSPORT, epoch: 2 }).policy.mode).toBe("off");
    expect(disarmOnIdentityChange(armed, { ...TRANSPORT, routeCanonical: "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222" }).changed).toBe(true);

    for (const patch of [
      { transport: { ...TRANSPORT, routeCanonical: "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222" } },
      { transport: { ...TRANSPORT, bindingId: "x" } },
      { transport: { ...TRANSPORT, epoch: 9 } },
    ]) {
      const plan = planAutonomyTick(baseState(patch));
      expect(plan.decision).toBe("gate_failed");
      expect(plan.reason).toBe("policy_identity_mismatch");
    }

    const start = canStartProductionSend({
      owner: OWNER,
      transport: { ...TRANSPORT, routeCanonical: "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222" },
      journal: reservedJournal(),
      latch: { state: "NONE" },
      evidence: EVIDENCE,
    });
    expect(start.ok).toBe(false);
  });

  it("CLAIMED continuation rejects journal vs current route/binding/epoch", async () => {
    const spy = makeRecoverSpies({
      journal: claimedJournal(),
      routeCanonical: "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222",
    });
    const r = await recoverSendOrchestration({
      journal: claimedJournal(),
      doc: {} as never,
      persistJournal: spy.persistJournal,
      beginSend: spy.beginSend,
      ackObserved: spy.ackObserved,
      writeCanonicalMessage: spy.writeCanonicalMessage,
      dispatchNativeSend: spy.dispatchNativeSend,
      inspectComposerWriteCapability: spy.inspectComposerWriteCapability,
      verifyCanonicalComposer: spy.verifyCanonicalComposer,
      snapshotUserTurns: spy.snapshotUserTurns,
      findCanonicalUserTurn: spy.findCanonicalUserTurn,
      getCurrentRoute: spy.getCurrentRoute,
      routeCanonical: "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222",
      bindingId: BINDING,
      epoch: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("route_mismatch");
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
  });
});

describe("F1b 8. Bridge temporary offline", () => {
  it("SW recover fetch failure must not clear durable journal", () => {
    const sw = swSource();
    const idx = sw.indexOf("async function handleRecover()");
    expect(idx).toBeGreaterThan(-1);
    const body = sw.slice(idx, idx + 400);
    expect(body).toMatch(/const stateRes = await handleFetchState\(\);/);
    expect(body).toMatch(/if \(!stateRes\.ok\) return stateRes;/);
  });

  it("beginSend network throw keeps SEND_INTENT; zero write/click; no auto-clear", async () => {
    // inFlight must be exact reserved so recovery attempts the same-reservation continuation.
    const spy = makeRecoverSpies({
      journal: sendIntentJournal(),
      inFlight: { status: "reserved", eventId: EVENT_ID, reservationId: RES_ID },
    });
    spy.beginSend = async () => {
      spy.calls.beginSend += 1;
      throw new Error("network_unreachable");
    };
    const r = await recoverProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("begin_send_failed");
    expect(spy.journal.state).toBe("SEND_INTENT");
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
  });

  it("recovery after reconnect only continues current journal-allowed action", async () => {
    // Offline: ACK fails, journal stays OBSERVED_PENDING_ACK.
    let j = markComposerWriteIntent(claimedJournal(), {});
    j = markSendDispatchIntent(j, {});
    j = markObservedPendingAck(j, {});
    const offline = makeRecoverSpies({ journal: j });
    offline.ackObserved = async () => {
      throw new Error("network_unreachable");
    };
    const r1 = await recoverProductionSend(offline);
    expect(r1.ok).toBe(false);
    expect(offline.journal.state).toBe("OBSERVED_PENDING_ACK");

    // Online: only ACK continuation — never write/click/beginSend.
    const online = makeRecoverSpies({ journal: offline.journal });
    const r2 = await recoverProductionSend(online);
    expect(r2.ok).toBe(true);
    expect(online.journal.state).toBe("NONE");
    expect(online.calls.ack).toBe(1);
    expect(online.calls.write).toBe(0);
    expect(online.calls.click).toBe(0);
    expect(online.calls.beginSend).toBe(0);
  });

  it("OUTCOME_UNKNOWN stays blocked across simulated offline/online without resend", async () => {
    const j = markOutcomeUnknown(claimedJournal(), {});
    const offline = makeRecoverSpies({ journal: j, inFlight: null });
    const r1 = await recoverProductionSend(offline);
    expect(r1.ok).toBe(false);
    expect(offline.journal.state).toBe("OUTCOME_UNKNOWN");

    const onlineStillNoServer = makeRecoverSpies({ journal: offline.journal, inFlight: null });
    const r2 = await recoverProductionSend(onlineStillNoServer);
    expect(r2.ok).toBe(false);
    expect(onlineStillNoServer.calls.beginSend).toBe(0);
    expect(onlineStillNoServer.calls.write).toBe(0);
    expect(onlineStillNoServer.calls.click).toBe(0);
    expect(onlineStillNoServer.calls.ack).toBe(0);
  });
});

describe("F1b 9. authStale", () => {
  it("health auth_stale; no new reserve/send while transport unusable", () => {
    const h = operationalHealthSummary(healthBase({
      transport: { ...TRANSPORT, connected: true, authStale: true },
    }));
    expect(h.state).toBe("auth_stale");
    expect(h.authStale).toBe(true);

    expect(isTransportUsable({ ...TRANSPORT, authStale: true })).toBe(false);
    const plan = planAutonomyTick(baseState({
      transport: { ...TRANSPORT, authStale: true },
    }));
    expect(plan.decision).toBe("gate_failed");
    expect(plan.reason).toBe("transport_invalid");

    const reserve = evaluateReserveEligibility({
      transportValid: false,
      authStale: true,
      isOwner: true,
      ownerRoute: ROUTE,
      pairedRoute: ROUTE,
      documentId: OWNER.documentId,
      evidence: EVIDENCE,
      journal: emptyJournal(),
    });
    expect(reserve.ok).toBe(false);
    expect(reserve.reason).toBe("transport_invalid");

    const start = canStartProductionSend({
      owner: OWNER,
      transport: { ...TRANSPORT, authStale: true },
      journal: reservedJournal(),
      latch: { state: "NONE" },
      evidence: EVIDENCE,
    });
    expect(start.ok).toBe(false);
    expect(start.reason).toBe("auth_stale");
  });

  it("active durable journal not bypassed by re-pair gate", () => {
    const active = markReserveRequested(emptyJournal(), {
      routeCanonical: ROUTE,
      bindingId: BINDING,
      epoch: 1,
    });
    expect(pairAllowedWithJournal(active, false)).toBe(false);
    expect(pairAllowedWithJournal(active, true)).toBe(true);
    expect(pairAllowedWithJournal(emptyJournal(), false)).toBe(true);
    // authStale allows explicit re-pair, but journal remains active and journal-first recovery still applies.
    expect(journalActive(active)).toBe(true);
    const plan = planAutonomyTick(baseState({
      journal: active,
      transport: { ...TRANSPORT, authStale: true },
      pendingReady: 3,
    }));
    // Journal-first path still requires usable transport before recovery mutation.
    expect(plan.decision).toBe("gate_failed");
    expect(plan.reason).toBe("transport_invalid");
  });
});

describe("F1b 10. Durable cooldown", () => {
  it("SW restart cooldown still blocks second ready event in the same window", () => {
    const now = 100_000;
    const stamped = withProductionAttemptStamp(armedPolicy(), now - 1_000);
    const hydrated = parseAutonomyPolicy(JSON.parse(JSON.stringify(stamped)));
    const plan = planAutonomyTick(baseState({
      now,
      policy: hydrated,
      pendingReady: 2,
      evidence: { ...EVIDENCE, observedAt: now },
    }));
    expect(plan.decision).toBe("cooldown");
    expect(plan.reason).toBe("production_cooldown");
  });

  it("cooldown must not block already-reserved continuation", () => {
    const now = 100_000;
    const stamped = withProductionAttemptStamp(armedPolicy(), now - 100);
    const plan = planAutonomyTick(baseState({
      now,
      policy: stamped,
      journal: reservedJournal(),
      pendingReady: 9,
    }));
    expect(plan.decision).toBe("recovering");
    expect(plan.journalState).toBe("RESERVED");
  });

  it("health cooldown shows production_cooldown only when journal is NONE", () => {
    const now = 200_000;
    const hCool = operationalHealthSummary(healthBase({
      now,
      policy: armedPolicy({ lastProductionAttemptAt: now - 500 }),
      journalState: "NONE",
      lastHeartbeatAt: now - 10,
      lastTickAt: now - 20,
    }));
    expect(hCool.state).toBe("cooldown");
    expect(hCool.reason).toBe("production_cooldown");

    const hJournal = operationalHealthSummary(healthBase({
      now,
      policy: armedPolicy({ lastProductionAttemptAt: now - 500 }),
      journalState: "RESERVED",
      lastHeartbeatAt: now - 10,
      lastTickAt: now - 20,
    }));
    expect(hJournal.state).toBe("journal_recovery");
    expect(hJournal.reason).toBe("journal_active");
  });
});

describe("F1b 11. Corrupt / unknown durable state", () => {
  it("unknown journal phase → health blocked_gate/UNKNOWN, never ready", () => {
    const h = operationalHealthSummary(healthBase({ journalState: "credential123" }));
    expect(h.state).toBe("blocked_gate");
    expect(h.reason).toBe("journal_state_unknown");
    expect(h.journalPhase).toBe("UNKNOWN");
    expect(h.state).not.toBe("ready");
  });

  it("hydrateJournal / shape validator reject unknown state", () => {
    expect(validateSendJournalShape({ state: "NOT_A_STATE" }).reason).toBe("unknown_state");
    expect(() => hydrateJournal({ state: "CORRUPT" })).toThrow(/unknown_state/);
    expect(JOURNAL_STATES.includes("CORRUPT" as never)).toBe(false);
  });

  it("unknown durable journal never yields production ready / mutation", async () => {
    const corrupt = { state: "CORRUPT", eventId: EVENT_ID, reservationId: RES_ID } as never;
    const plan = planAutonomyTick(baseState({ journal: corrupt, pendingReady: 8 }));
    expect(plan.decision).not.toBe("would_reserve_and_send");
    expect(plan.decision).not.toBe("ready");

    const start = canStartProductionSend({
      owner: OWNER,
      transport: TRANSPORT,
      journal: corrupt,
      latch: { state: "NONE" },
      evidence: EVIDENCE,
    });
    expect(start.ok).toBe(false);
    expect(start.reason).toBe("journal_not_reserved");

    const spy = makeRecoverSpies({ journal: corrupt, inFlight: null });
    const r = await recoverProductionSend(spy);
    expect(r.ok).toBe(false);
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
    expect(spy.calls.beginSend).toBe(0);
    expect(spy.calls.ack).toBe(0);
  });

  it("SW hydrate keeps corrupt journal visible to health as blocked, not ready", () => {
    // SW hydrate accepts any string state into memory; health must fail closed.
    const sw = swSource();
    expect(sw).toMatch(/journal = j && typeof j === "object" && typeof j\.state === "string" \? j : emptyJournal\(\);/);
    const h = operationalHealthSummary(healthBase({ journalState: "HACKED" }));
    expect(h.state).toBe("blocked_gate");
    expect(h.reason).toBe("journal_state_unknown");
  });
});

describe("F1b SW production-path source contracts (exactly-once / fail-closed)", () => {
  it("autonomy tick is journal-first, one event, no auto-retire, no second reserve after clear", () => {
    const sw = swSource();
    const docStart = sw.indexOf("E1b3d3b2 autonomous tick");
    const start = sw.indexOf("async function maybeRunAutonomyTick");
    const end = sw.indexOf("async function handleProductionSend", start);
    const tickDoc = sw.slice(docStart, start);
    const tick = sw.slice(start, end);
    expect(tickDoc).toMatch(/Journal-first recovery/);
    expect(tickDoc).toMatch(/Never auto-retire/);
    expect(tick).toMatch(/No second reserve/);
    expect(tick).toMatch(/Same tick must NOT reserve next event/);
    expect(tick).toMatch(/commitAutonomyPolicy\(stamped\)/);
  });

  it("production send requires durable RESERVED; authStale and journal_not_reserved fail closed", () => {
    const r = canStartProductionSend({
      owner: OWNER,
      transport: TRANSPORT,
      journal: { state: "OUTCOME_UNKNOWN", eventId: EVENT_ID, reservationId: RES_ID, attemptId: ATTEMPT } as never,
      latch: { state: "NONE" },
      evidence: EVIDENCE,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("journal_not_reserved");
  });

  it("classifyProductionStartRpcResult uses durable journal, never memory-only success", () => {
    const blocked = classifyProductionStartRpcResult({
      response: { ok: true, mode: "production_send" },
      journalAfter: { state: "SEND_INTENT" },
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe("production_journal_not_cleared");
    expect(blocked.action).toBe("recover");
  });

  it("findExactObservedEvent fail-closed on 0 or >1 matches for eligible states", () => {
    const unknown = markOutcomeUnknown(claimedJournal(), {});
    let pending = claimedJournal();
    pending = markComposerWriteIntent(pending, {});
    pending = markSendDispatchIntent(pending, {});
    pending = markObservedPendingAck(pending, {});
    for (const j of [unknown, pending]) {
      expect(findExactObservedEvent([], j).ok).toBe(false);
      const one = findExactObservedEvent(
        [{ status: "observed", eventId: EVENT_ID, attemptId: ATTEMPT }],
        j,
      );
      expect(one.ok).toBe(true);
      expect(findExactObservedEvent(
        [
          { status: "observed", eventId: EVENT_ID, attemptId: ATTEMPT },
          { status: "observed", eventId: EVENT_ID, attemptId: ATTEMPT },
        ],
        j,
      ).reason).toBe("observed_event_ambiguous");
    }
  });

  it("autonomy defaults OFF and operational health is not an authorization input in SW status", () => {
    const sw = swSource();
    expect(sw).toMatch(/Default OFF/);
    expect(sw).toMatch(/operationalHealth: operationalHealthSummary\(/);
    // Health payload is status-only; production gates still call canStartProductionSend / planAutonomyTick.
    const statusIdx = sw.indexOf("operationalHealth: operationalHealthSummary(");
    const after = sw.slice(statusIdx, statusIdx + 800);
    expect(after).not.toMatch(/canStartProductionSend\(/);
  });
});
