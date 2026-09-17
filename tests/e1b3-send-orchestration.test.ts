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
} from "../browser-companion/reservation-journal.js";
import {
  runSendOrchestration,
  recoverSendOrchestration,
} from "../browser-companion/send-orchestrator.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const companionRoot = path.join(projectRoot, "browser-companion");

const ROUTE = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const EVENT_ID = "e".repeat(32);
const RES_ID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT = "22222222-2222-4222-8222-222222222222";
const MESSAGE =
  `[C2C_CONTROL]\nSTATE: EXECUTED\nEVENT_ID: ${EVENT_ID}\nATTEMPT_ID: ${ATTEMPT}\n`;
const MESSAGE_SHA = "a".repeat(64);

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

function makeSpies() {
  const calls = {
    persist: [] as string[],
    beginSend: 0,
    ack: 0,
    write: 0,
    verify: 0,
    click: 0,
  };
  let journal = reservedJournal();
  const persistJournal = async (next: typeof journal) => {
    journal = next;
    calls.persist.push(next.state);
    return next;
  };
  const beginSend = async () => {
    calls.beginSend += 1;
    // Real HTTP DTO: eventId + status + attemptId + message + messageSha256
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
  const inspectComposerWriteCapability = () => ({ ok: true, editorKind: "contenteditable" });
  const snapshotUserTurns = () => [];
  const findCanonicalUserTurn = () => ({
    ok: true,
    turn: { id: "u1", text: MESSAGE },
  });
  const getCurrentRoute = () => ROUTE;
  const sleep = async () => {};
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
    sleep,
  };
}

function baseCtx(spy: ReturnType<typeof makeSpies>, overrides: Record<string, unknown> = {}) {
  return {
    journal: spy.journal,
    doc: {} as never,
    routeCanonical: ROUTE,
    bindingId: "b",
    epoch: 1,
    persistJournal: spy.persistJournal,
    beginSend: spy.beginSend,
    ackObserved: spy.ackObserved,
    writeCanonicalMessage: spy.writeCanonicalMessage,
    verifyCanonicalComposer: spy.verifyCanonicalComposer,
    dispatchNativeSend: spy.dispatchNativeSend,
    inspectComposerWriteCapability: spy.inspectComposerWriteCapability,
    snapshotUserTurns: spy.snapshotUserTurns,
    findCanonicalUserTurn: spy.findCanonicalUserTurn,
    getCurrentRoute: spy.getCurrentRoute,
    sleep: spy.sleep,
    maxPollAttempts: 2,
    ...overrides,
  };
}

describe("E1b3c happy path", () => {
  it("RESERVED → NONE with exactly one beginSend/write/click/ack", async () => {
    const spy = makeSpies();
    const result = await runSendOrchestration(baseCtx(spy));
    expect(result.ok).toBe(true);
    expect(result.journal.state).toBe("NONE");
    expect(spy.calls.beginSend).toBe(1);
    expect(spy.calls.write).toBe(1);
    expect(spy.calls.click).toBe(1);
    expect(spy.calls.ack).toBe(1);
    // Durable fence order
    const order = spy.calls.persist;
    expect(order).toEqual([
      "SEND_INTENT",
      "CLAIMED",
      "COMPOSER_WRITE_INTENT",
      "SEND_DISPATCH_INTENT",
      "OBSERVED_PENDING_ACK",
      "NONE",
    ]);
  });
});

describe("E1b3c pre-Send fail closed", () => {
  it("route mismatch rejects", async () => {
    const spy = makeSpies();
    const r = await runSendOrchestration(
      baseCtx(spy, { routeCanonical: "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222" }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("route_mismatch");
    expect(spy.calls.beginSend).toBe(0);
  });

  it("beginSend eventId mismatch → no write/click", async () => {
    const spy = makeSpies();
    spy.beginSend = async () => ({
      eventId: "b".repeat(32),
      status: "claimed" as const,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    });
    const r = await runSendOrchestration(baseCtx(spy));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("event_id_mismatch");
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
    expect(r.journal.state).toBe("SEND_INTENT");
  });

  it("beginSend missing status or non-claimed → reject", async () => {
    const spy = makeSpies();
    spy.beginSend = async () => ({
      eventId: EVENT_ID,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    });
    const r = await runSendOrchestration(baseCtx(spy));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("begin_send_status_invalid");
    expect(spy.calls.write).toBe(0);
  });

  it("message/hash missing → fail closed", async () => {
    const spy = makeSpies();
    spy.beginSend = async () => ({
      eventId: EVENT_ID,
      status: "claimed" as const,
      attemptId: ATTEMPT,
      message: "",
      messageSha256: MESSAGE_SHA,
    });
    const r = await runSendOrchestration(baseCtx(spy));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("message_missing");
    expect(spy.calls.click).toBe(0);
  });

  it("stop/generation_unknown/dirty/missing editor → no write", async () => {
    for (const reason of ["generation_active", "generation_unknown", "composer_dirty", "composer_missing"]) {
      const spy = makeSpies();
      spy.inspectComposerWriteCapability = () => ({ ok: false, reason });
      const r = await runSendOrchestration(baseCtx(spy));
      expect(r.ok).toBe(false);
      expect(r.reason).toBe(reason);
      expect(spy.calls.write).toBe(0);
      expect(spy.calls.click).toBe(0);
      expect(r.journal.state).toBe("CLAIMED");
    }
  });
});

describe("E1b3c write fence", () => {
  it("COMPOSER_WRITE_INTENT persisted before write", async () => {
    const spy = makeSpies();
    let stateAtWrite = "";
    spy.writeCanonicalMessage = async () => {
      stateAtWrite = spy.journal.state;
      spy.calls.write += 1;
      return { ok: true };
    };
    const r = await runSendOrchestration(baseCtx(spy));
    expect(r.ok).toBe(true);
    expect(stateAtWrite).toBe("COMPOSER_WRITE_INTENT");
  });

  it("write throw/mismatch → no click + OUTCOME_UNKNOWN", async () => {
    const spy = makeSpies();
    spy.writeCanonicalMessage = async () => ({ ok: false, reason: "composer_write_mismatch" });
    const r = await runSendOrchestration(baseCtx(spy));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("composer_write_mismatch");
    expect(spy.calls.click).toBe(0);
    expect(r.journal.state).toBe("OUTCOME_UNKNOWN");
  });

  it("crash at COMPOSER_WRITE_INTENT → recovery zero write/zero click", async () => {
    const j = markComposerWriteIntent(claimedJournal(), {});
    const spy = makeSpies();
    const r = await recoverSendOrchestration({
      journal: j,
      doc: {} as never,
      persistJournal: spy.persistJournal,
      beginSend: spy.beginSend,
      ackObserved: spy.ackObserved,
      findCanonicalUserTurn: () => ({ ok: false, reason: "not_observed" }),
      inFlight: {
        status: "claimed",
        eventId: EVENT_ID,
        reservationId: RES_ID,
        attemptId: ATTEMPT,
      },
    });
    expect(r.ok).toBe(false);
    expect(r.action).toBe("block");
    expect(r.zeroWrite).toBe(true);
    expect(r.zeroClick).toBe(true);
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
    expect(spy.calls.beginSend).toBe(0);
  });
});

describe("E1b3c dispatch fence", () => {
  it("SEND_DISPATCH_INTENT persisted before click", async () => {
    const spy = makeSpies();
    let stateAtClick = "";
    spy.dispatchNativeSend = async () => {
      stateAtClick = spy.journal.state;
      spy.calls.click += 1;
      return { ok: true, clicked: 1 };
    };
    const r = await runSendOrchestration(baseCtx(spy));
    expect(r.ok).toBe(true);
    expect(stateAtClick).toBe("SEND_DISPATCH_INTENT");
  });

  it("click throw → one attempt, no retry, OUTCOME_UNKNOWN", async () => {
    const spy = makeSpies();
    spy.dispatchNativeSend = async () => {
      spy.calls.click += 1;
      throw new Error("boom");
    };
    const r = await runSendOrchestration(baseCtx(spy));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("send_click_threw");
    expect(spy.calls.click).toBe(1);
    expect(r.journal.state).toBe("OUTCOME_UNKNOWN");
  });

  it("dispatch fail (disabled/missing) → OUTCOME_UNKNOWN, zero resend", async () => {
    const spy = makeSpies();
    spy.dispatchNativeSend = async () => {
      spy.calls.click += 1; // invocation attempt (may fail before real .click)
      return { ok: false, reason: "send_disabled" };
    };
    const r = await runSendOrchestration(baseCtx(spy));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("send_disabled");
    expect(r.journal.state).toBe("OUTCOME_UNKNOWN");
    expect(spy.calls.click).toBe(1);
  });

  it("crash at SEND_DISPATCH_INTENT → recovery zero additional click", async () => {
    const j = markSendDispatchIntent(markComposerWriteIntent(claimedJournal(), {}), {});
    const spy = makeSpies();
    const r = await recoverSendOrchestration({
      journal: j,
      doc: {} as never,
      persistJournal: spy.persistJournal,
      beginSend: spy.beginSend,
      ackObserved: spy.ackObserved,
      findCanonicalUserTurn: () => ({ ok: false, reason: "not_observed" }),
      inFlight: {
        status: "claimed",
        eventId: EVENT_ID,
        reservationId: RES_ID,
        attemptId: ATTEMPT,
      },
    });
    expect(r.ok).toBe(false);
    expect(r.zeroClick).toBe(true);
    expect(spy.calls.click).toBe(0);
    expect(spy.calls.write).toBe(0);
  });
});

describe("E1b3c observe", () => {
  it("timeout / ambiguous / reject → OUTCOME_UNKNOWN, zero resend", async () => {
    for (const reason of ["not_observed", "ambiguous", "wrong_attempt"]) {
      const spy = makeSpies();
      spy.findCanonicalUserTurn = () => ({ ok: false, reason });
      const r = await runSendOrchestration(baseCtx(spy));
      expect(r.ok).toBe(false);
      expect(["observe_timeout", "ambiguous"]).toContain(r.reason);
      expect(r.journal.state).toBe("OUTCOME_UNKNOWN");
      expect(spy.calls.beginSend).toBe(1);
      expect(spy.calls.click).toBe(1);
      expect(spy.calls.ack).toBe(0);
    }
  });

  it("assistant / partial / baseline rejected by observer (injected)", async () => {
    const spy = makeSpies();
    spy.findCanonicalUserTurn = () => ({ ok: false, reason: "not_observed" });
    const r = await runSendOrchestration(baseCtx(spy));
    expect(r.ok).toBe(false);
    expect(r.journal.state).toBe("OUTCOME_UNKNOWN");
  });
});

describe("E1b3c ACK", () => {
  it("ACK only after OBSERVED_PENDING_ACK persisted", async () => {
    const spy = makeSpies();
    let stateAtAck = "";
    spy.ackObserved = async () => {
      stateAtAck = spy.journal.state;
      spy.calls.ack += 1;
      return { eventId: EVENT_ID, status: "observed" as const };
    };
    const r = await runSendOrchestration(baseCtx(spy));
    expect(r.ok).toBe(true);
    expect(stateAtAck).toBe("OBSERVED_PENDING_ACK");
  });

  it("ACK wrong status/eventId → do not clear, retryAck", async () => {
    const spy = makeSpies();
    spy.ackObserved = async () => {
      spy.calls.ack += 1;
      return { eventId: EVENT_ID, status: "claimed" };
    };
    const r = await runSendOrchestration(baseCtx(spy));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("ack_status_not_observed");
    expect(r.journal.state).toBe("OBSERVED_PENDING_ACK");
    expect(r.retryAck).toBe(true);

    const spy2 = makeSpies();
    spy2.ackObserved = async () => {
      spy2.calls.ack += 1;
      return { eventId: "b".repeat(32), status: "observed" };
    };
    const r2 = await runSendOrchestration(baseCtx(spy2));
    expect(r2.reason).toBe("ack_event_id_mismatch");
    expect(r2.journal.state).toBe("OBSERVED_PENDING_ACK");
  });

  it("ACK failure → no resend, retryAck=true, stay OBSERVED_PENDING_ACK", async () => {
    const spy = makeSpies();
    spy.ackObserved = async () => {
      spy.calls.ack += 1;
      throw new Error("net");
    };
    const r = await runSendOrchestration(baseCtx(spy));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("ack_failed");
    expect(r.retryAck).toBe(true);
    expect(r.journal.state).toBe("OBSERVED_PENDING_ACK");
    expect(spy.calls.beginSend).toBe(1);
    expect(spy.calls.click).toBe(1);
  });

  it("recovery from OBSERVED_PENDING_ACK can retry ACK only and clear", async () => {
    const j = markObservedPendingAck(
      markSendDispatchIntent(markComposerWriteIntent(claimedJournal(), {}), {}),
      {},
    );
    const spy = makeSpies();
    const r = await recoverSendOrchestration({
      journal: j,
      doc: {} as never,
      persistJournal: spy.persistJournal,
      beginSend: spy.beginSend,
      ackObserved: spy.ackObserved,
      findCanonicalUserTurn: spy.findCanonicalUserTurn,
      inFlight: null,
    });
    expect(r.ok).toBe(true);
    expect(r.journal.state).toBe("NONE");
    expect(spy.calls.ack).toBe(1);
    expect(spy.calls.click).toBe(0);
    expect(spy.calls.write).toBe(0);
  });
});

describe("E1b3c identity", () => {
  it("binding/epoch drift rejects", async () => {
    const spy = makeSpies();
    const r1 = await runSendOrchestration(baseCtx(spy, { bindingId: "other" }));
    expect(r1.reason).toBe("binding_mismatch");
    const spy2 = makeSpies();
    const r2 = await runSendOrchestration(baseCtx(spy2, { epoch: 2 }));
    expect(r2.reason).toBe("epoch_mismatch");
    expect(spy2.calls.beginSend).toBe(0);
  });

  it("beginSend does not need reservationId in response; local identity stays locked", async () => {
    // Real HTTP DTO has no reservationId; extra/missing reservationId in adapter is ignored.
    // Local journal reservationId is what gets persisted with CLAIMED.
    const spy = makeSpies();
    spy.beginSend = async () => ({
      eventId: EVENT_ID,
      status: "claimed" as const,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    });
    const r = await runSendOrchestration(baseCtx(spy));
    expect(r.ok).toBe(true);
    expect(r.journal.state).toBe("NONE");
  });
});

describe("E1b3c recovery SEND_INTENT", () => {
  it("same reserved inFlight → executes beginSend continuation", async () => {
    const j = markSendIntent(reservedJournal(), {});
    const spy = makeSpies();
    const r = await recoverSendOrchestration(baseCtx(spy, { journal: j, inFlight: { status: "reserved", eventId: EVENT_ID, reservationId: RES_ID } }));
    expect(r.ok).toBe(true);
    expect(r.action).toBe("retried_begin_send");
    expect(spy.calls.beginSend).toBe(1);
    expect(spy.calls.write).toBe(1);
    expect(spy.calls.click).toBe(1);
    expect(r.journal.state).toBe("NONE");
  });

  it("claimed inFlight → adopt CLAIMED then continue without new beginSend", async () => {
    const j = markSendIntent(reservedJournal(), {});
    const spy = makeSpies();
    const r = await recoverSendOrchestration(baseCtx(spy, {
      journal: j,
      inFlight: {
        status: "claimed",
        eventId: EVENT_ID,
        reservationId: RES_ID,
        attemptId: ATTEMPT,
        message: MESSAGE,
        messageSha256: MESSAGE_SHA,
      },
    }));
    expect(r.ok).toBe(true);
    expect(r.action).toBe("adopted_claimed_then_continue");
    expect(spy.calls.beginSend).toBe(0);
    expect(spy.calls.write).toBe(1);
    expect(r.journal.state).toBe("NONE");
  });
});

describe("E1b3c review-fix route freshness / ACK / recovery continuation", () => {
  it("route drift before write → no write/click, stay CLAIMED", async () => {
    const spy = makeSpies();
    spy.getCurrentRoute = () => "https://chatgpt.com/c/99999999-9999-4999-8999-999999999999";
    const r = await runSendOrchestration(baseCtx(spy));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("route_drift");
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
    expect(r.journal.state).toBe("CLAIMED");
  });

  it("route drift before click → OUTCOME_UNKNOWN, zero click", async () => {
    const spy = makeSpies();
    let calls = 0;
    spy.getCurrentRoute = () => {
      calls += 1;
      // pre-write + post-write-persist ok; pre-dispatch (3rd) drifts
      return calls <= 2 ? ROUTE : "https://chatgpt.com/c/99999999-9999-4999-8999-999999999999";
    };
    const r = await runSendOrchestration(baseCtx(spy));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("route_drift");
    expect(spy.calls.write).toBe(1);
    expect(spy.calls.click).toBe(0);
    expect(r.journal.state).toBe("OUTCOME_UNKNOWN");
  });

  it("CLAIMED recovery executes write/dispatch/ack continuation", async () => {
    const spy = makeSpies();
    const r = await recoverSendOrchestration(baseCtx(spy, {
      journal: claimedJournal(),
      inFlight: {
        status: "claimed",
        eventId: EVENT_ID,
        reservationId: RES_ID,
        attemptId: ATTEMPT,
      },
    }));
    expect(r.ok).toBe(true);
    expect(r.action).toBe("resumed_claimed");
    expect(spy.calls.beginSend).toBe(0);
    expect(spy.calls.write).toBe(1);
    expect(spy.calls.click).toBe(1);
    expect(spy.calls.ack).toBe(1);
    expect(r.journal.state).toBe("NONE");
  });

  it("ACK empty result does not clear", async () => {
    const spy = makeSpies();
    spy.ackObserved = async () => {
      spy.calls.ack += 1;
      return undefined;
    };
    const r = await runSendOrchestration(baseCtx(spy));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("ack_result_empty");
    expect(r.journal.state).toBe("OBSERVED_PENDING_ACK");
  });

  it("missing getCurrentRoute → fail closed, zero write/click", async () => {
    const spy = makeSpies();
    const ctx = baseCtx(spy);
    delete (ctx as Record<string, unknown>).getCurrentRoute;
    const r = await runSendOrchestration(ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("route_resolver_missing");
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
    expect(r.journal.state).toBe("CLAIMED");
  });

  it("TOCTOU: route drift during write-intent persist → OUTCOME_UNKNOWN, zero write", async () => {
    const spy = makeSpies();
    let calls = 0;
    spy.getCurrentRoute = () => {
      calls += 1;
      // 1) pre-write fence ok; 2) post-persist before write drifts
      return calls === 1 ? ROUTE : "https://chatgpt.com/c/99999999-9999-4999-8999-999999999999";
    };
    const r = await runSendOrchestration(baseCtx(spy));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("route_drift");
    expect(r.journal.state).toBe("OUTCOME_UNKNOWN");
    expect(spy.calls.write).toBe(0);
    expect(spy.calls.click).toBe(0);
  });

  it("TOCTOU: route drift during dispatch-intent persist → OUTCOME_UNKNOWN, zero click", async () => {
    const spy = makeSpies();
    let calls = 0;
    spy.getCurrentRoute = () => {
      calls += 1;
      // 1 pre-write, 2 post-write-persist, 3 pre-dispatch ok; 4 post-dispatch-persist drift
      return calls <= 3 ? ROUTE : "https://chatgpt.com/c/99999999-9999-4999-8999-999999999999";
    };
    const r = await runSendOrchestration(baseCtx(spy));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("route_drift");
    expect(r.journal.state).toBe("OUTCOME_UNKNOWN");
    expect(spy.calls.write).toBe(1);
    expect(spy.calls.click).toBe(0);
  });

  it("getCurrentRoute throw/empty → route_unavailable, fail closed", async () => {
    const spy = makeSpies();
    spy.getCurrentRoute = () => {
      throw new Error("gone");
    };
    const r = await runSendOrchestration(baseCtx(spy));
    expect(r.reason).toBe("route_unavailable");
    expect(spy.calls.write).toBe(0);

    const spy2 = makeSpies();
    spy2.getCurrentRoute = () => "";
    const r2 = await runSendOrchestration(baseCtx(spy2));
    expect(r2.reason).toBe("route_unavailable");
    expect(spy2.calls.write).toBe(0);
  });
});

describe("runtime unreachability", () => {
  it("manifest/CS do not load raw send-orchestrator; CS has no Bridge HTTP", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(companionRoot, "manifest.json"), "utf8"),
    );
    const js = (manifest.content_scripts ?? []).flatMap((cs: { js?: string[] }) => cs.js ?? []);
    expect(js).not.toContain("send-orchestrator.js");
    expect(js).not.toContain("send-adapter.js");
    expect(js).toContain("turn-observer.js"); // E1b3d1 read-only shadow
    expect(js).toContain("shadow-evidence.js");
    // E1b3d3b: production classic runtime is isolated; raw ESM orchestrator stays unloaded.
    expect(js).toContain("production-send-runtime-global.js");
    expect(js).not.toContain("production-send-runtime.js");
    expect(js).not.toContain("send-orchestrator.js");

    const cs = fs.readFileSync(path.join(companionRoot, "content-script.js"), "utf8");
    expect(cs).not.toMatch(/send-orchestrator/);
    expect(cs).not.toMatch(/runSendOrchestration/);
    expect(cs).not.toMatch(/recoverSendOrchestration/);
    expect(cs).not.toMatch(/function writeCanonicalMessage/);
    expect(cs).not.toMatch(/function dispatchNativeSend/);
    expect(cs).not.toMatch(/\/begin-send/);
    expect(cs).not.toMatch(/\/ack\b/);
    expect(cs).not.toMatch(/fetch\(/);
    expect(cs).not.toMatch(/chrome\.tabs\.sendMessage/);

    // SW owns production Bridge HTTP + journal CAS (E1b3d3b).
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    expect(sw).not.toMatch(/send-orchestrator/);
    expect(sw).not.toMatch(/runSendOrchestration/);
    expect(sw).not.toMatch(/recoverSendOrchestration/);
    expect(sw).not.toMatch(/function writeCanonicalMessage/);
    expect(sw).not.toMatch(/function dispatchNativeSend/);
    expect(sw).toMatch(/c2c\.production\.send\.request/);
    expect(sw).toMatch(/fetchCompanion\("\/begin-send"/);
    expect(sw).toMatch(/fetchCompanion\("\/ack"/);
  });

  it("orchestrator is pure DI: no chrome/fetch/storage", () => {
    const text = fs.readFileSync(
      path.join(companionRoot, "send-orchestrator.js"),
      "utf8",
    );
    expect(text).not.toMatch(/chrome\./);
    expect(text).not.toMatch(/\bfetch\s*\(/);
    expect(text).not.toMatch(/localStorage|sessionStorage/);
    expect(text).not.toMatch(/\.click\(\)/);
  });
});
