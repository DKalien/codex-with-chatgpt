import { describe, expect, it } from "vitest";
import {
  emptyJournal,
  hydrateJournal,
  markClaimed,
  markComposerWriteIntent,
  markObservedPendingAck,
  markLateObservedPendingAck,
  markOutcomeUnknown,
  markReserveRequested,
  markReservationRecovery,
  markReserved,
  markSendDispatchIntent,
  markSendIntent,
  journalActive,
  journalInPostMutationFence,
  journalIsSendSide,
  reconcileSendJournal,
  validateSendJournalShape,
  clearJournal,
} from "../browser-companion/reservation-journal.js";

const ROUTE = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const EVENT_ID = "e".repeat(32);
const RES_ID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT = "22222222-2222-4222-8222-222222222222";
const ATTEMPT_B = "99999999-9999-4999-8999-999999999999";
const MESSAGE = "[C2C_CONTROL]\nSTATE: EXECUTED\n...";
const MESSAGE_SHA = "a".repeat(64);

function baseJournal() {
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

function sendIntentJournal() {
  return markSendIntent(baseJournal(), {
    eventId: EVENT_ID,
    reservationId: RES_ID,
    routeCanonical: ROUTE,
    bindingId: "b",
    epoch: 1,
  });
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

describe("E1b3 pure durable journal state machine", () => {
  it("NONE → RESERVE_REQUESTED → RESERVED → SEND_INTENT → CLAIMED", () => {
    const j = claimedJournal();
    expect(j.state).toBe("CLAIMED");
    expect(j.attemptId).toBe(ATTEMPT);
    expect(j.message).toBe(MESSAGE);
    expect(j.messageSha256).toBe(MESSAGE_SHA);
    expect(journalActive(j)).toBe(true);
    expect(journalIsSendSide(j)).toBe(true);
    expect(journalInPostMutationFence(j)).toBe(false);
  });

  it("CLAIMED → COMPOSER_WRITE_INTENT → SEND_DISPATCH_INTENT → OBSERVED_PENDING_ACK", () => {
    let j = claimedJournal();
    j = markComposerWriteIntent(j, { attemptId: ATTEMPT });
    expect(j.state).toBe("COMPOSER_WRITE_INTENT");
    expect(journalInPostMutationFence(j)).toBe(true);
    j = markSendDispatchIntent(j, { attemptId: ATTEMPT });
    expect(j.state).toBe("SEND_DISPATCH_INTENT");
    j = markObservedPendingAck(j, { attemptId: ATTEMPT });
    expect(j.state).toBe("OBSERVED_PENDING_ACK");
    expect(journalIsSendSide(j)).toBe(true);
  });

  it("illegal reverse transitions fail closed", () => {
    const claimed = claimedJournal();
    expect(() => markReserved(claimed, {
      eventId: EVENT_ID,
      reservationId: RES_ID,
      routeCanonical: ROUTE,
      bindingId: "b",
      epoch: 1,
    })).toThrow(/illegal journal transition/);

    const unknown = markOutcomeUnknown(claimedJournal(), {
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    });
    expect(() => markClaimed(unknown, {
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    })).toThrow(/illegal journal transition/);
    expect(() => markSendIntent(unknown, {
      eventId: EVENT_ID,
      reservationId: RES_ID,
    })).toThrow(/illegal journal transition/);
    expect(() => markComposerWriteIntent(unknown, {})).toThrow(/illegal journal transition/);

    const composer = markComposerWriteIntent(claimedJournal(), {});
    expect(() => markClaimed(composer, {
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    })).toThrow(/illegal journal transition/);
  });

  it("NONE may not jump into send states; markClaimed(empty) rejected", () => {
    expect(() => markSendIntent(emptyJournal(), {
      eventId: EVENT_ID,
      reservationId: RES_ID,
    })).toThrow(/illegal journal transition/);
    expect(() => markClaimed(emptyJournal(), {
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    })).toThrow(/illegal journal transition/);
  });

  it("RESERVATION_RECOVERY cannot go directly to SEND_INTENT", () => {
    let j = markReserveRequested(emptyJournal(), {
      routeCanonical: ROUTE,
      bindingId: "b",
      epoch: 1,
    });
    j = markReservationRecovery(j, {});
    expect(j.state).toBe("RESERVATION_RECOVERY");
    expect(() => markSendIntent(j, {
      eventId: EVENT_ID,
      reservationId: RES_ID,
    })).toThrow(/illegal journal transition/);
    // Must recover to RESERVED first.
    const reserved = markReserved(j, {
      eventId: EVENT_ID,
      reservationId: RES_ID,
      routeCanonical: ROUTE,
      bindingId: "b",
      epoch: 1,
    });
    expect(reserved.state).toBe("RESERVED");
    expect(() => markSendIntent(reserved, {
      eventId: EVENT_ID,
      reservationId: RES_ID,
    })).not.toThrow();
  });

  it("markClaimed requires attempt + message + sha256; invalid hash rejected", () => {
    const intent = sendIntentJournal();
    expect(() => markClaimed(intent, {
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
    })).toThrow(/invalid journal shape/);
    expect(() => markClaimed(intent, {
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE,
    })).toThrow(/invalid journal shape/);
    expect(() => markClaimed(intent, {
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: "not-hex",
    })).toThrow(/invalid journal shape/);
  });

  it("validateSendJournalShape rejects malformed send states", () => {
    expect(validateSendJournalShape(emptyJournal()).ok).toBe(true);
    expect(validateSendJournalShape({
      state: "SEND_INTENT",
      eventId: null,
      reservationId: null,
      routeCanonical: ROUTE,
      bindingId: "b",
      epoch: 1,
    }).ok).toBe(false);
    expect(validateSendJournalShape({
      state: "CLAIMED",
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: "zz",
      routeCanonical: ROUTE,
      bindingId: "b",
      epoch: 1,
    }).reason).toBe("message_sha256_invalid");
    expect(validateSendJournalShape({ state: "NOT_A_STATE" }).reason).toBe("unknown_state");
  });

  it("hydrateJournal builds validated send states for recovery", () => {
    const j = hydrateJournal({
      state: "OBSERVED_PENDING_ACK",
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
      routeCanonical: ROUTE,
      bindingId: "b",
      epoch: 1,
    });
    expect(j.state).toBe("OBSERVED_PENDING_ACK");
    expect(() => hydrateJournal({ state: "CLAIMED", eventId: EVENT_ID })).toThrow(
      /invalid journal shape/,
    );
  });

  it("OUTCOME_UNKNOWN is terminal for resend; late-positive observe is the only exit", () => {
    const unknown = markOutcomeUnknown(claimedJournal(), {
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    });
    expect(unknown.state).toBe("OUTCOME_UNKNOWN");
    const again = markOutcomeUnknown(unknown, {
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    });
    expect(again.state).toBe("OUTCOME_UNKNOWN");
    expect(reconcileSendJournal(unknown, null).action).toBe("block");
    expect(reconcileSendJournal(unknown, {
      status: "reserved",
      eventId: EVENT_ID,
      reservationId: RES_ID,
    }).action).toBe("block");
    expect(() => markObservedPendingAck(unknown, {})).toThrow(/illegal journal transition/);
    const late = markLateObservedPendingAck(unknown, {});
    expect(late.state).toBe("OBSERVED_PENDING_ACK");
    expect(late.eventId).toBe(EVENT_ID);
    expect(late.attemptId).toBe(ATTEMPT);
    expect(late.message).toBe(MESSAGE);
    expect(late.messageSha256).toBe(MESSAGE_SHA);
  });

  it("markOutcomeUnknown never overwrites different local attemptId", () => {
    expect(() => markOutcomeUnknown(claimedJournal(), {
      attemptId: ATTEMPT_B,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    })).toThrow(/attemptId/);
  });
});

describe("E1b3 recovery reducer semantics", () => {
  it("SEND_INTENT + server still same reserved → retry_begin_send", () => {
    const rec = reconcileSendJournal(sendIntentJournal(), {
      status: "reserved",
      eventId: EVENT_ID,
      reservationId: RES_ID,
    });
    expect(rec.action).toBe("retry_begin_send");
    expect(rec.journal.state).toBe("SEND_INTENT");
  });

  it("SEND_INTENT + server same claimed + attemptId → adopt CLAIMED", () => {
    const rec = reconcileSendJournal(sendIntentJournal(), {
      status: "claimed",
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    });
    expect(rec.action).toBe("adopt_claimed");
    expect(rec.journal.state).toBe("CLAIMED");
    expect(rec.journal.attemptId).toBe(ATTEMPT);
    expect(rec.journal.message).toBe(MESSAGE);
  });

  it("CLAIMED + same server claimed/attempt → keep", () => {
    const rec = reconcileSendJournal(claimedJournal(), {
      status: "claimed",
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
    });
    expect(rec.action).toBe("keep");
    expect(rec.journal.state).toBe("CLAIMED");
  });

  it("any send-side + same server outcome_unknown → OUTCOME_UNKNOWN / never resend", () => {
    const server = {
      status: "outcome_unknown",
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    };
    const fromIntent = reconcileSendJournal(sendIntentJournal(), server);
    expect(fromIntent.action).toBe("adopt_outcome_unknown");
    expect(fromIntent.journal.state).toBe("OUTCOME_UNKNOWN");

    const fromClaimed = reconcileSendJournal(claimedJournal(), server);
    expect(fromClaimed.action).toBe("adopt_outcome_unknown");
    expect(fromClaimed.journal.state).toBe("OUTCOME_UNKNOWN");

    const fromComposer = reconcileSendJournal(
      markComposerWriteIntent(claimedJournal(), {}),
      server,
    );
    expect(fromComposer.action).toBe("adopt_outcome_unknown");
    expect(fromComposer.journal.state).toBe("OUTCOME_UNKNOWN");
  });

  it("CLAIMED + different attempt/event/reservation → conflict / fail closed", () => {
    expect(reconcileSendJournal(claimedJournal(), {
      status: "claimed",
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT_B,
    }).action).toBe("conflict");
    expect(reconcileSendJournal(claimedJournal(), {
      status: "claimed",
      eventId: "f".repeat(32),
      reservationId: RES_ID,
      attemptId: ATTEMPT,
    }).action).toBe("conflict");
    expect(reconcileSendJournal(claimedJournal(), {
      status: "claimed",
      eventId: EVENT_ID,
      reservationId: "33333333-3333-4333-8333-333333333333",
      attemptId: ATTEMPT,
    }).action).toBe("conflict");
  });

  it("outcome_unknown wrong attempt → conflict, not adopt", () => {
    const rec = reconcileSendJournal(claimedJournal(), {
      status: "outcome_unknown",
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT_B,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    });
    expect(rec.action).toBe("conflict");
    expect(rec.journal.state).toBe("CLAIMED");
    expect(rec.journal.attemptId).toBe(ATTEMPT);
  });

  it("missing / wrong reservationId → conflict (no wildcard)", () => {
    const recMissing = reconcileSendJournal(sendIntentJournal(), {
      status: "reserved",
      eventId: EVENT_ID,
      // reservationId missing
    });
    expect(recMissing.action).toBe("conflict");

    const recWrong = reconcileSendJournal(sendIntentJournal(), {
      status: "claimed",
      eventId: EVENT_ID,
      reservationId: "33333333-3333-4333-8333-333333333333",
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    });
    expect(recWrong.action).toBe("conflict");
  });

  it("COMPOSER_WRITE_INTENT reload → no auto re-write", () => {
    const j = markComposerWriteIntent(claimedJournal(), {});
    const rec = reconcileSendJournal(j, {
      status: "claimed",
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    });
    expect(rec.action).toBe("block");
    expect(rec.journal.state).toBe("COMPOSER_WRITE_INTENT");
  });

  it("SEND_DISPATCH_INTENT reload → no auto re-click Send", () => {
    let j = claimedJournal();
    j = markComposerWriteIntent(j, {});
    j = markSendDispatchIntent(j, {});
    const rec = reconcileSendJournal(j, {
      status: "claimed",
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
    });
    expect(rec.action).toBe("block");
    expect(rec.journal.state).toBe("SEND_DISPATCH_INTENT");
  });

  it("post-mutation wrong attempt outcome_unknown → conflict", () => {
    const j = markComposerWriteIntent(claimedJournal(), {});
    const rec = reconcileSendJournal(j, {
      status: "outcome_unknown",
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT_B,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    });
    expect(rec.action).toBe("conflict");
    expect(rec.journal.state).toBe("COMPOSER_WRITE_INTENT");
  });

  it("OBSERVED_PENDING_ACK reload → only retry_ack", () => {
    let j = claimedJournal();
    j = markComposerWriteIntent(j, {});
    j = markSendDispatchIntent(j, {});
    j = markObservedPendingAck(j, { attemptId: ATTEMPT });
    const rec = reconcileSendJournal(j, {
      status: "claimed",
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
    });
    expect(rec.action).toBe("retry_ack");
    expect(rec.journal.state).toBe("OBSERVED_PENDING_ACK");
  });

  it("FIX1: OBSERVED_PENDING_ACK + inFlight=null → retry_ack (ACK already observed)", () => {
    let j = claimedJournal();
    j = markComposerWriteIntent(j, {});
    j = markSendDispatchIntent(j, {});
    j = markObservedPendingAck(j, { attemptId: ATTEMPT });
    const rec = reconcileSendJournal(j, null);
    expect(rec.action).toBe("retry_ack");
    expect(rec.journal.state).toBe("OBSERVED_PENDING_ACK");
    expect(rec.journal.attemptId).toBe(ATTEMPT);
    // Never a send-side action.
    expect(rec.action).not.toBe("retry_begin_send");
    expect(rec.action).not.toBe("adopt_claimed");
  });

  it("OBSERVED_PENDING_ACK wrong attempt → conflict, never begin-send", () => {
    let j = claimedJournal();
    j = markComposerWriteIntent(j, {});
    j = markSendDispatchIntent(j, {});
    j = markObservedPendingAck(j, { attemptId: ATTEMPT });
    const rec = reconcileSendJournal(j, {
      status: "claimed",
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT_B,
    });
    expect(rec.action).toBe("conflict");
  });

  it("core invariant: post-mutation fence never offers resend actions", () => {
    const postStates = [
      markComposerWriteIntent(claimedJournal(), {}),
      markSendDispatchIntent(markComposerWriteIntent(claimedJournal(), {}), {}),
      markObservedPendingAck(
        markSendDispatchIntent(markComposerWriteIntent(claimedJournal(), {}), {}),
        {},
      ),
    ];
    for (const j of postStates) {
      const a = reconcileSendJournal(j, {
        status: "claimed",
        eventId: EVENT_ID,
        reservationId: RES_ID,
        attemptId: ATTEMPT,
      });
      expect(a.action).not.toBe("retry_begin_send");
    }
  });

  it("SEND_INTENT + server no inFlight → clear (never claimed)", () => {
    const rec = reconcileSendJournal(sendIntentJournal(), null);
    expect(rec.action).toBe("clear");
    expect(rec.journal.state).toBe("NONE");
  });

  it("server observed clears claimed journal only with exact attempt", () => {
    expect(reconcileSendJournal(claimedJournal(), {
      status: "observed",
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
    }).action).toBe("clear");
    expect(reconcileSendJournal(claimedJournal(), {
      status: "observed",
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT_B,
    }).action).toBe("conflict");
  });

  it("clearJournal returns empty", () => {
    expect(clearJournal().state).toBe("NONE");
    expect(journalActive(clearJournal())).toBe(false);
  });
});

describe("E1b3a identity immutability", () => {
  const EVENT_B = "b".repeat(32);
  const RES_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const MESSAGE_B = "[C2C_CONTROL]\nSTATE: EXECUTED\nother";
  const MESSAGE_SHA_B = "b".repeat(64);
  const ROUTE_B = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";

  function expectIdentity(fn: () => unknown, field?: string): void {
    try {
      fn();
      expect.unreachable("expected JOURNAL_IDENTITY_MISMATCH");
    } catch (e) {
      const err = e as { code?: string; message?: string };
      expect(err.code).toBe("JOURNAL_IDENTITY_MISMATCH");
      if (field) expect(err.message).toContain(field);
    }
  }

  it("1. RESERVED(A/resA) → markSendIntent(B/resB) rejected", () => {
    expectIdentity(() => markSendIntent(baseJournal(), {
      eventId: EVENT_B,
      reservationId: RES_B,
    }), "eventId");
    expectIdentity(() => markSendIntent(baseJournal(), {
      eventId: EVENT_ID,
      reservationId: RES_B,
    }), "reservationId");
    expectIdentity(() => markSendIntent(baseJournal(), {
      eventId: EVENT_ID,
      reservationId: RES_ID,
      routeCanonical: ROUTE_B,
    }), "routeCanonical");
  });

  it("2/3. SEND_INTENT → markClaimed wrong event/reservation rejected", () => {
    const intent = sendIntentJournal();
    expectIdentity(() => markClaimed(intent, {
      eventId: EVENT_B,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    }), "eventId");
    expectIdentity(() => markClaimed(intent, {
      eventId: EVENT_ID,
      reservationId: RES_B,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    }), "reservationId");
  });

  it("4/5. CLAIMED → composer/dispatch markers cannot overwrite attempt/message/hash", () => {
    const claimed = claimedJournal();
    expectIdentity(() => markComposerWriteIntent(claimed, { attemptId: ATTEMPT_B }), "attemptId");
    expectIdentity(() => markComposerWriteIntent(claimed, { message: MESSAGE_B }), "message");
    expectIdentity(() =>
      markSendDispatchIntent(claimed, { messageSha256: MESSAGE_SHA_B }), "messageSha256");
    expectIdentity(() =>
      markObservedPendingAck(claimed, { attemptId: ATTEMPT_B }), "attemptId");
  });

  it("6. idempotent markClaimed same attempt but different message/hash rejected", () => {
    const claimed = claimedJournal();
    expectIdentity(() => markClaimed(claimed, {
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE_B,
      messageSha256: MESSAGE_SHA,
    }), "message");
    expectIdentity(() => markClaimed(claimed, {
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA_B,
    }), "messageSha256");
    expectIdentity(() => markClaimed(claimed, {
      eventId: EVENT_ID,
      reservationId: RES_B,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    }), "reservationId");
    // Exact duplicate remains idempotent.
    const again = markClaimed(claimed, {
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    });
    expect(again).toBe(claimed);
  });

  it("7. reconcile CLAIMED exact attempt but different server messageSha256 → conflict", () => {
    const rec = reconcileSendJournal(claimedJournal(), {
      status: "claimed",
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA_B,
    });
    expect(rec.action).toBe("conflict");
    expect(rec.reason).toBe("claimed_message_sha_mismatch");
    expect(rec.journal.messageSha256).toBe(MESSAGE_SHA);

    const recMsg = reconcileSendJournal(claimedJournal(), {
      status: "claimed",
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE_B,
      messageSha256: MESSAGE_SHA,
    });
    expect(recMsg.action).toBe("conflict");
    expect(recMsg.reason).toBe("claimed_message_mismatch");
  });

  it("8. OBSERVED_PENDING_ACK + observed wrong attempt → conflict", () => {
    let j = claimedJournal();
    j = markComposerWriteIntent(j, {});
    j = markSendDispatchIntent(j, {});
    j = markObservedPendingAck(j, {});
    const rec = reconcileSendJournal(j, {
      status: "observed",
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT_B,
    });
    expect(rec.action).toBe("conflict");
    expect(rec.journal.state).toBe("OBSERVED_PENDING_ACK");
    // Exact observed still clears.
    const ok = reconcileSendJournal(j, {
      status: "observed",
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
    });
    expect(ok.action).toBe("clear");
  });

  it("9. normal full forward path still succeeds", () => {
    let j = emptyJournal();
    j = markReserveRequested(j, { routeCanonical: ROUTE, bindingId: "b", epoch: 1 });
    j = markReserved(j, {
      eventId: EVENT_ID,
      reservationId: RES_ID,
      routeCanonical: ROUTE,
      bindingId: "b",
      epoch: 1,
    });
    j = markSendIntent(j, {});
    expect(j.state).toBe("SEND_INTENT");
    expect(j.eventId).toBe(EVENT_ID);
    expect(j.reservationId).toBe(RES_ID);
    j = markClaimed(j, {
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    });
    expect(j.state).toBe("CLAIMED");
    expect(j.routeCanonical).toBe(ROUTE);
    expect(j.bindingId).toBe("b");
    expect(j.epoch).toBe(1);
    j = markComposerWriteIntent(j, {});
    j = markSendDispatchIntent(j, {});
    j = markObservedPendingAck(j, {});
    expect(j.state).toBe("OBSERVED_PENDING_ACK");
    expect(j.attemptId).toBe(ATTEMPT);
    expect(j.message).toBe(MESSAGE);
    expect(j.messageSha256).toBe(MESSAGE_SHA);
  });

  it("10. ACK-response-loss remains retry_ack on inFlight=null", () => {
    let j = claimedJournal();
    j = markComposerWriteIntent(j, {});
    j = markSendDispatchIntent(j, {});
    j = markObservedPendingAck(j, {});
    const rec = reconcileSendJournal(j, null);
    expect(rec.action).toBe("retry_ack");
  });

  it("markSendIntent retry does not overwrite identity", () => {
    const intent = sendIntentJournal();
    const again = markSendIntent(intent, {
      eventId: EVENT_ID,
      reservationId: RES_ID,
      routeCanonical: ROUTE,
      bindingId: "b",
      epoch: 1,
    });
    expect(again).toBe(intent);
    expectIdentity(() => markSendIntent(intent, {
      eventId: EVENT_ID,
      reservationId: RES_B,
    }), "reservationId");
  });

  it("malformed durable journal → reconcile conflict, no send actions", () => {
    const malformed = {
      ...claimedJournal(),
      messageSha256: "not-hex",
    };
    const rec = reconcileSendJournal(malformed, {
      status: "claimed",
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
    });
    expect(rec.action).toBe("conflict");
    expect(rec.reason).toContain("journal_shape_invalid");

    const unknownState = { ...claimedJournal(), state: "NOT_A_STATE" };
    expect(reconcileSendJournal(unknownState, null).action).toBe("conflict");
  });

  it("markOutcomeUnknown does not overwrite CLAIMED message/hash", () => {
    expectIdentity(() => markOutcomeUnknown(claimedJournal(), {
      attemptId: ATTEMPT,
      message: MESSAGE_B,
      messageSha256: MESSAGE_SHA,
    }), "message");
    // SEND_INTENT may first-adopt attempt+message from server.
    const adopted = markOutcomeUnknown(sendIntentJournal(), {
      eventId: EVENT_ID,
      reservationId: RES_ID,
      attemptId: ATTEMPT,
      message: MESSAGE,
      messageSha256: MESSAGE_SHA,
    });
    expect(adopted.state).toBe("OUTCOME_UNKNOWN");
    expect(adopted.attemptId).toBe(ATTEMPT);
    expect(adopted.message).toBe(MESSAGE);
  });
});

describe("E1b3a recovery identity closeout", () => {
  const EVENT_B = "b".repeat(32);
  const RES_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ROUTE_B = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";

  function expectCode(fn: () => unknown, code: string): void {
    try {
      fn();
      expect.unreachable(`expected ${code}`);
    } catch (e) {
      expect((e as { code?: string }).code).toBe(code);
    }
  }

  it("A. RESERVED cannot enter RESERVATION_RECOVERY", () => {
    expectCode(() => markReservationRecovery(baseJournal(), {
      routeCanonical: ROUTE,
      bindingId: "b",
      epoch: 1,
    }), "JOURNAL_TRANSITION_ILLEGAL");
  });

  it("B. RESERVE_REQUESTED → RESERVATION_RECOVERY cannot rewrite route/binding/epoch", () => {
    let j = markReserveRequested(emptyJournal(), {
      routeCanonical: ROUTE,
      bindingId: "b",
      epoch: 1,
    });
    expectCode(() => markReservationRecovery(j, { routeCanonical: ROUTE_B }), "JOURNAL_IDENTITY_MISMATCH");
    expectCode(() => markReservationRecovery(j, { bindingId: "other" }), "JOURNAL_IDENTITY_MISMATCH");
    expectCode(() => markReservationRecovery(j, { epoch: 2 }), "JOURNAL_IDENTITY_MISMATCH");
    // Exact match / omitted is fine.
    const rec = markReservationRecovery(j, {
      routeCanonical: ROUTE,
      bindingId: "b",
      epoch: 1,
    });
    expect(rec.state).toBe("RESERVATION_RECOVERY");
    expect(rec.routeCanonical).toBe(ROUTE);
    expect(rec.bindingId).toBe("b");
    expect(rec.epoch).toBe(1);
  });

  it("C. RESERVATION_RECOVERY → RESERVED inherits original transport identity", () => {
    let j = markReserveRequested(emptyJournal(), {
      routeCanonical: ROUTE,
      bindingId: "b",
      epoch: 1,
    });
    j = markReservationRecovery(j, {});
    expectCode(() => markReserved(j, {
      eventId: EVENT_B,
      reservationId: RES_B,
      routeCanonical: ROUTE_B,
    }), "JOURNAL_IDENTITY_MISMATCH");
    expectCode(() => markReserved(j, {
      eventId: EVENT_B,
      reservationId: RES_B,
      bindingId: "other",
    }), "JOURNAL_IDENTITY_MISMATCH");
    expectCode(() => markReserved(j, {
      eventId: EVENT_B,
      reservationId: RES_B,
      epoch: 9,
    }), "JOURNAL_IDENTITY_MISMATCH");

    const reserved = markReserved(j, {
      eventId: EVENT_B,
      reservationId: RES_B,
    });
    expect(reserved.state).toBe("RESERVED");
    expect(reserved.eventId).toBe(EVENT_B);
    expect(reserved.reservationId).toBe(RES_B);
    expect(reserved.routeCanonical).toBe(ROUTE);
    expect(reserved.bindingId).toBe("b");
    expect(reserved.epoch).toBe(1);
  });
});
