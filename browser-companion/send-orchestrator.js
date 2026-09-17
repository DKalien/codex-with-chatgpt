/**
 * E1b3c pure Send orchestration — NOT runtime-loaded.
 * Browser-safe ESM. No Chrome API, no fetch, no storage, no credentials.
 *
 * Review-fix:
 * - route freshness re-checked before COMPOSER_WRITE_INTENT and before click
 * - beginSend strong validation matches real HTTP DTO (eventId+status+attempt+message+hash)
 * - ACK result must prove eventId+status=observed before clear
 * - recovery executes allowed continuations via DI (not labels only)
 *
 * Retry policy:
 *   MAY retry: beginSend (pre-claim), ACK (post-observe)
 *   NEVER retry: composer write after COMPOSER_WRITE_INTENT,
 *                native Send click after SEND_DISPATCH_INTENT,
 *                beginSend after CLAIMED
 */

import {
  markSendIntent,
  markClaimed,
  markComposerWriteIntent,
  markSendDispatchIntent,
  markObservedPendingAck,
  markLateObservedPendingAck,
  markOutcomeUnknown,
  clearJournal,
  journalInPostMutationFence,
} from "./reservation-journal.js";

/** Local allowlist copy — classic production bundle must not import turn-observer. */
const OBSERVATION_DIAGNOSTIC_KEYS = [
  "candidateCount",
  "exactTextMatchCount",
  "exactAttemptMarkerCount",
  "ambiguousCount",
  "targetLength",
  "candidateLengths",
  "firstMismatchIndex",
  "candidates",
];

function sanitizeObservationDiagnostic(diagnostic) {
  if (!diagnostic || typeof diagnostic !== "object") return null;
  const maxCandidates = 5;
  const out = {};
  for (const key of OBSERVATION_DIAGNOSTIC_KEYS) {
    if (diagnostic[key] === undefined) continue;
    const value = diagnostic[key];
    if (key === "candidateLengths") {
      if (!Array.isArray(value)) continue;
      out[key] = value.slice(0, maxCandidates).map((n) => (Number.isFinite(n) ? Number(n) : 0));
      continue;
    }
    if (key === "candidates") {
      if (!Array.isArray(value)) continue;
      out[key] = value.slice(0, maxCandidates).map((item) => ({
        directRole: typeof item?.directRole === "string" ? item.directRole : null,
        nestedUser: item?.nestedUser === true,
      }));
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return out;
}

function fail(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

function ok(extra = {}) {
  return { ok: true, ...extra };
}

function requireJournalMatches(journal, expected) {
  if (!journal || !journal.eventId || !journal.reservationId) {
    return "journal_identity_missing";
  }
  if (expected.eventId !== undefined && journal.eventId !== expected.eventId) {
    return "event_id_mismatch";
  }
  if (expected.reservationId !== undefined && journal.reservationId !== expected.reservationId) {
    return "reservation_id_mismatch";
  }
  if (expected.routeCanonical !== undefined && journal.routeCanonical !== expected.routeCanonical) {
    return "route_mismatch";
  }
  if (expected.bindingId !== undefined && journal.bindingId !== expected.bindingId) {
    return "binding_mismatch";
  }
  if (expected.epoch !== undefined && journal.epoch !== expected.epoch) {
    return "epoch_mismatch";
  }
  if (expected.attemptId !== undefined && journal.attemptId !== expected.attemptId) {
    return "attempt_id_mismatch";
  }
  return null;
}

/**
 * Real /begin-send HTTP DTO (companion router):
 *   { eventId, status: "claimed", attemptId, message, messageSha256 }
 * reservationId/route/binding/epoch are NOT in the response; they stay locked
 * via local durable journal + authenticated transport context.
 */
function validateBeginSendResult(journal, result) {
  if (!result || typeof result !== "object") {
    return "begin_send_empty";
  }
  if (result.eventId !== journal.eventId) {
    return "event_id_mismatch";
  }
  if (result.status !== "claimed") {
    return "begin_send_status_invalid";
  }
  if (!result.attemptId) return "attempt_id_missing";
  if (typeof result.message !== "string" || result.message.length === 0) {
    return "message_missing";
  }
  if (typeof result.messageSha256 !== "string" || result.messageSha256.length === 0) {
    return "message_hash_missing";
  }
  return null;
}

/**
 * Real /ack HTTP DTO: { eventId, status: "observed" }.
 * Do not clear journal unless the result proves the exact event is observed.
 */
function validateAckResult(journal, result) {
  if (!result || typeof result !== "object") {
    return "ack_result_empty";
  }
  if (result.eventId !== journal.eventId) {
    return "ack_event_id_mismatch";
  }
  if (result.status !== "observed") {
    return "ack_status_not_observed";
  }
  return null;
}

function persist(persistJournal, next) {
  if (typeof persistJournal !== "function") {
    throw new Error("persistJournal required");
  }
  return persistJournal(next);
}

async function sleepDefault(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Re-resolve current page route and require exact match to durable journal route.
 * getCurrentRoute is mandatory for any write/click path — no silent fallback.
 * Returns null on ok, else reason string.
 */
function checkRouteFreshness(ctx, journal) {
  const { getCurrentRoute } = ctx;
  if (typeof getCurrentRoute !== "function") {
    return "route_resolver_missing";
  }
  let current;
  try {
    current = getCurrentRoute();
  } catch {
    return "route_unavailable";
  }
  if (!current || typeof current !== "string" || current.length === 0) {
    return "route_unavailable";
  }
  if (current !== journal.routeCanonical) {
    return "route_drift";
  }
  return null;
}

async function performClaimedWriteAndDispatch(ctx, claimedJournal) {
  const {
    doc,
    persistJournal,
    writeCanonicalMessage,
    verifyCanonicalComposer,
    dispatchNativeSend,
    inspectComposerWriteCapability,
  } = ctx;

  // Route freshness before write fence.
  const routeBeforeWrite = checkRouteFreshness(ctx, claimedJournal);
  if (routeBeforeWrite) {
    return fail(routeBeforeWrite, { journal: claimedJournal });
  }

  if (typeof inspectComposerWriteCapability === "function") {
    const eligibility = inspectComposerWriteCapability(doc, {
      routeValid: true,
      routeCanonical: claimedJournal.routeCanonical,
    });
    if (!eligibility?.ok) {
      // Pre-mutation: stay CLAIMED.
      return fail(eligibility?.reason || "pre_write_ineligible", { journal: claimedJournal });
    }
  }

  let writeJournal;
  try {
    writeJournal = markComposerWriteIntent(claimedJournal, {});
    await persist(persistJournal, writeJournal);
  } catch (error) {
    return fail("write_intent_persist_failed", {
      journal: claimedJournal,
      error: String(error?.message || error),
    });
  }

  // TOCTOU closeout: re-resolve route AFTER persist, BEFORE any DOM write.
  // Durable mutation fence already crossed → OUTCOME_UNKNOWN, zero write.
  const routeAfterWriteIntent = checkRouteFreshness(ctx, writeJournal);
  if (routeAfterWriteIntent) {
    const unknown = markOutcomeUnknown(writeJournal, {});
    await persist(persistJournal, unknown);
    return fail(routeAfterWriteIntent, { journal: unknown, zeroWrite: true });
  }

  let writeResult;
  try {
    writeResult = await writeCanonicalMessage(doc, writeJournal.message, {
      routeValid: true,
      routeCanonical: writeJournal.routeCanonical,
    });
  } catch (error) {
    const unknown = markOutcomeUnknown(writeJournal, {});
    await persist(persistJournal, unknown);
    return fail("write_threw", { journal: unknown, error: String(error?.message || error) });
  }
  if (!writeResult?.ok) {
    const unknown = markOutcomeUnknown(writeJournal, {});
    await persist(persistJournal, unknown);
    return fail(writeResult?.reason || "write_failed", { journal: unknown });
  }

  let verifyResult;
  try {
    verifyResult = await verifyCanonicalComposer(doc, writeJournal.message, {
      routeValid: true,
      routeCanonical: writeJournal.routeCanonical,
    });
  } catch (error) {
    const unknown = markOutcomeUnknown(writeJournal, {});
    await persist(persistJournal, unknown);
    return fail("verify_threw", { journal: unknown, error: String(error?.message || error) });
  }
  if (!verifyResult?.ok) {
    const unknown = markOutcomeUnknown(writeJournal, {});
    await persist(persistJournal, unknown);
    return fail(verifyResult?.reason || "composer_text_mismatch", { journal: unknown });
  }

  // Optional bounded Send-ready wait — MUST run before SEND_DISPATCH_INTENT.
  if (typeof ctx.waitForSendReady === "function") {
    let ready;
    try {
      ready = await ctx.waitForSendReady(doc, writeJournal.message, writeJournal);
    } catch (error) {
      const unknown = markOutcomeUnknown(writeJournal, {});
      await persist(persistJournal, unknown);
      return fail("send_ready_wait_threw", {
        journal: unknown,
        zeroClick: true,
        error: String(error?.message || error),
      });
    }
    if (!ready?.ok) {
      const unknown = markOutcomeUnknown(writeJournal, {});
      await persist(persistJournal, unknown);
      return fail(ready?.reason || "send_not_ready", { journal: unknown, zeroClick: true });
    }
  }

  // Route freshness + identity immediately before dispatch fence / click.
  const routeBeforeClick = checkRouteFreshness(ctx, writeJournal);
  if (routeBeforeClick) {
    const unknown = markOutcomeUnknown(writeJournal, {});
    await persist(persistJournal, unknown);
    return fail(routeBeforeClick, { journal: unknown });
  }
  const stillExact = requireJournalMatches(writeJournal, {
    eventId: claimedJournal.eventId,
    reservationId: claimedJournal.reservationId,
    attemptId: claimedJournal.attemptId,
    routeCanonical: claimedJournal.routeCanonical,
    bindingId: claimedJournal.bindingId,
    epoch: claimedJournal.epoch,
  });
  if (stillExact) {
    const unknown = markOutcomeUnknown(writeJournal, {});
    await persist(persistJournal, unknown);
    return fail(stillExact, { journal: unknown });
  }

  let dispatchJournal;
  try {
    dispatchJournal = markSendDispatchIntent(writeJournal, {});
    await persist(persistJournal, dispatchJournal);
  } catch (error) {
    const unknown = markOutcomeUnknown(writeJournal, {});
    await persist(persistJournal, unknown);
    return fail("dispatch_intent_persist_failed", {
      journal: unknown,
      error: String(error?.message || error),
    });
  }

  // TOCTOU closeout: re-resolve route AFTER dispatch persist, BEFORE click.
  // Fence already crossed → OUTCOME_UNKNOWN, zero click.
  const routeAfterDispatchIntent = checkRouteFreshness(ctx, dispatchJournal);
  if (routeAfterDispatchIntent) {
    const unknown = markOutcomeUnknown(dispatchJournal, {});
    await persist(persistJournal, unknown);
    return fail(routeAfterDispatchIntent, { journal: unknown, zeroClick: true });
  }

  let clickResult;
  try {
    clickResult = await dispatchNativeSend(doc, dispatchJournal.message, {
      routeValid: true,
      routeCanonical: dispatchJournal.routeCanonical,
    });
  } catch (error) {
    const unknown = markOutcomeUnknown(dispatchJournal, {});
    await persist(persistJournal, unknown);
    return fail("send_click_threw", { journal: unknown, error: String(error?.message || error) });
  }
  if (!clickResult?.ok) {
    const unknown = markOutcomeUnknown(dispatchJournal, {});
    await persist(persistJournal, unknown);
    return fail(clickResult?.reason || "send_click_failed", { journal: unknown });
  }

  return ok({ journal: dispatchJournal, baselineReady: true });
}

async function observeTurnAndAck(ctx, dispatchJournal, baseline) {
  const {
    doc,
    persistJournal,
    ackObserved,
    findCanonicalUserTurn,
    sleep = sleepDefault,
    pollIntervalMs = 20,
    maxPollAttempts = 3,
  } = ctx;

  let found = null;
  let observeReason = "not_observed";
  for (let attempt = 0; attempt < Math.max(1, maxPollAttempts); attempt++) {
    try {
      const rec = findCanonicalUserTurn(doc, {
        message: dispatchJournal.message,
        attemptId: dispatchJournal.attemptId,
        baseline,
      });
      if (rec?.ok) {
        found = rec;
        break;
      }
      if (rec?.reason === "ambiguous") {
        observeReason = "ambiguous";
        break;
      }
      observeReason = rec?.reason || "not_observed";
    } catch {
      observeReason = "observe_error";
    }
    if (attempt + 1 < maxPollAttempts && typeof sleep === "function") {
      await sleep(pollIntervalMs);
    }
  }
  if (!found) {
    const unknown = markOutcomeUnknown(dispatchJournal, {});
    await persist(persistJournal, unknown);
    return fail(observeReason === "ambiguous" ? "ambiguous" : "observe_timeout", {
      journal: unknown,
    });
  }

  let ackJournal = dispatchJournal;
  if (dispatchJournal.state !== "OBSERVED_PENDING_ACK") {
    try {
      ackJournal = markObservedPendingAck(dispatchJournal, {
        attemptId: dispatchJournal.attemptId,
      });
      await persist(persistJournal, ackJournal);
    } catch (error) {
      const unknown = markOutcomeUnknown(dispatchJournal, {});
      await persist(persistJournal, unknown);
      return fail("observed_ack_persist_failed", {
        journal: unknown,
        error: String(error?.message || error),
      });
    }
  }

  return finalizeAck(ctx, ackJournal);
}

/** ACK only after OBSERVED_PENDING_ACK; clear only if result proves observed. */
export async function finalizeAck(ctx, ackJournal) {
  const { persistJournal, ackObserved } = ctx;
  let ackResult;
  try {
    ackResult = await ackObserved({
      eventId: ackJournal.eventId,
      attemptId: ackJournal.attemptId,
      reservationId: ackJournal.reservationId,
      routeCanonical: ackJournal.routeCanonical,
      bindingId: ackJournal.bindingId,
      epoch: ackJournal.epoch,
    });
  } catch (error) {
    return fail("ack_failed", {
      journal: ackJournal,
      error: String(error?.message || error),
      retryAck: true,
    });
  }
  const ackErr = validateAckResult(ackJournal, ackResult);
  if (ackErr) {
    return fail(ackErr, {
      journal: ackJournal,
      ackResult,
      retryAck: true,
    });
  }
  const none = clearJournal();
  await persist(persistJournal, none);
  return ok({
    journal: none,
    attemptId: ackJournal.attemptId,
    message: ackJournal.message,
    messageSha256: ackJournal.messageSha256,
  });
}

/** Continue from durable SEND_INTENT: claim once, then write/dispatch/observe/ack. */
export async function continueFromSendIntent(ctx, sendIntentJournal) {
  const { persistJournal, beginSend, snapshotUserTurns, doc } = ctx;
  if (!sendIntentJournal || sendIntentJournal.state !== "SEND_INTENT") {
    return fail("journal_not_send_intent", { journal: sendIntentJournal });
  }
  let beginResult;
  try {
    beginResult = await beginSend({
      eventId: sendIntentJournal.eventId,
      reservationId: sendIntentJournal.reservationId,
      routeCanonical: sendIntentJournal.routeCanonical,
      bindingId: sendIntentJournal.bindingId,
      epoch: sendIntentJournal.epoch,
    });
  } catch (error) {
    return fail("begin_send_failed", {
      journal: sendIntentJournal,
      error: String(error?.message || error),
    });
  }
  const beginErr = validateBeginSendResult(sendIntentJournal, beginResult);
  if (beginErr) {
    return fail(beginErr, { journal: sendIntentJournal, beginResult });
  }
  let claimed;
  try {
    claimed = markClaimed(sendIntentJournal, {
      eventId: sendIntentJournal.eventId,
      reservationId: sendIntentJournal.reservationId,
      attemptId: beginResult.attemptId,
      message: beginResult.message,
      messageSha256: beginResult.messageSha256,
    });
    await persist(persistJournal, claimed);
  } catch (error) {
    return fail("claim_persist_failed", {
      journal: sendIntentJournal,
      error: String(error?.message || error),
    });
  }
  return continueFromClaimed(ctx, claimed, { snapshotBaseline: true, doc });
}

/**
 * Continue from durable CLAIMED (pre-mutation fence not yet crossed).
 * Snapshots user-turn baseline if requested, then write → dispatch → observe → ack.
 */
export async function continueFromClaimed(ctx, claimedJournal, opts = {}) {
  const { doc, snapshotUserTurns, validateClaimedPayload } = ctx;
  if (!claimedJournal || claimedJournal.state !== "CLAIMED") {
    return fail("journal_not_claimed", { journal: claimedJournal });
  }
  const identityErr = requireJournalMatches(claimedJournal, {
    routeCanonical: ctx.routeCanonical,
    bindingId: ctx.bindingId,
    epoch: ctx.epoch,
  });
  if (identityErr) {
    return fail(identityErr, { journal: claimedJournal });
  }

  // ATTEMPT_ID / message binding must be proven for EVERY CLAIMED source
  // (fresh beginSend, adopt-from-server, direct recovery) before any DOM work.
  if (typeof validateClaimedPayload === "function") {
    let payloadCheck;
    try {
      payloadCheck = validateClaimedPayload(claimedJournal);
    } catch (error) {
      return fail("claimed_payload_validator_threw", {
        journal: claimedJournal,
        zeroWrite: true,
        zeroClick: true,
        error: String(error?.message || error),
      });
    }
    if (!payloadCheck?.ok) {
      return fail(payloadCheck?.reason || "claimed_payload_invalid", {
        journal: claimedJournal,
        zeroWrite: true,
        zeroClick: true,
      });
    }
  } else if (ctx.requireClaimedPayloadValidator === true) {
    return fail("claimed_payload_validator_missing", {
      journal: claimedJournal,
      zeroWrite: true,
      zeroClick: true,
    });
  }

  let baseline = [];
  if (opts.snapshotBaseline !== false) {
    try {
      if (typeof snapshotUserTurns === "function") {
        baseline = snapshotUserTurns(doc) || [];
      }
    } catch {
      baseline = [];
    }
  }

  const stage = await performClaimedWriteAndDispatch(ctx, claimedJournal);
  if (!stage.ok) {
    return stage;
  }
  return observeTurnAndAck(ctx, stage.journal, baseline);
}

/**
 * Happy-path orchestration starting from durable RESERVED.
 */
export async function runSendOrchestration(ctx) {
  const { journal, persistJournal } = ctx;
  if (!journal || journal.state !== "RESERVED") {
    return fail("journal_not_reserved", { journal });
  }
  const identityErr = requireJournalMatches(journal, {
    eventId: journal.eventId,
    reservationId: journal.reservationId,
    routeCanonical: ctx.routeCanonical,
    bindingId: ctx.bindingId,
    epoch: ctx.epoch,
  });
  if (identityErr) return fail(identityErr, { journal });

  let sendIntent;
  try {
    sendIntent = markSendIntent(journal, {
      eventId: journal.eventId,
      reservationId: journal.reservationId,
      routeCanonical: journal.routeCanonical,
      bindingId: journal.bindingId,
      epoch: journal.epoch,
    });
    await persist(persistJournal, sendIntent);
  } catch (error) {
    return fail("send_intent_persist_failed", {
      journal,
      error: String(error?.message || error),
    });
  }
  return continueFromSendIntent(ctx, sendIntent);
}

/**
 * Late-positive recovery for durable OUTCOME_UNKNOWN.
 * Only exact server claimed/outcome_unknown + exact canonical user turn may ACK.
 * Zero write / click / beginSend / reserve / release.
 */
function recoverLatePositiveAck(ctx) {
  const {
    journal,
    doc,
    persistJournal,
    findCanonicalUserTurn,
    inFlight = null,
  } = ctx;

  const block = (reason = "outcome_unknown", diagnostic = null) => {
    const safeDiag = sanitizeObservationDiagnostic(diagnostic);
    const extra = {
      journal,
      action: "block",
      zeroWrite: true,
      zeroClick: true,
    };
    if (safeDiag) extra.diagnostic = safeDiag;
    return fail(reason, extra);
  };

  if (!inFlight) {
    return block("outcome_unknown");
  }
  if (inFlight.status !== "claimed" && inFlight.status !== "outcome_unknown") {
    return block("outcome_unknown");
  }
  if (
    inFlight.eventId !== journal.eventId
    || inFlight.reservationId !== journal.reservationId
    || inFlight.attemptId !== journal.attemptId
    || inFlight.message !== journal.message
    || inFlight.messageSha256 !== journal.messageSha256
  ) {
    return block("late_positive_identity_mismatch");
  }
  if (!doc || typeof findCanonicalUserTurn !== "function" || !journal.attemptId) {
    return block("outcome_unknown");
  }

  let rec;
  try {
    rec = findCanonicalUserTurn(doc, {
      message: journal.message,
      attemptId: journal.attemptId,
      baseline: null,
    });
  } catch {
    return block("outcome_unknown");
  }
  if (!rec?.ok) {
    return block(rec?.reason === "ambiguous" ? "ambiguous" : "outcome_unknown", rec?.diagnostic);
  }

  return (async () => {
    let ackJournal;
    try {
      ackJournal = markLateObservedPendingAck(journal, {});
      await persist(persistJournal, ackJournal);
    } catch (error) {
      return fail("late_observed_persist_failed", {
        journal,
        error: String(error?.message || error),
        action: "block",
        zeroWrite: true,
        zeroClick: true,
        diagnostic: sanitizeObservationDiagnostic(rec?.diagnostic) ?? undefined,
      });
    }
    const result = await finalizeAck(ctx, ackJournal);
    const safeDiag = sanitizeObservationDiagnostic(rec?.diagnostic);
    return {
      ...result,
      action: result.ok ? "late_positive_observed_then_acked" : "retry_ack",
      retryAck: result.ok ? undefined : true,
      zeroWrite: true,
      zeroClick: true,
      ...(safeDiag ? { diagnostic: safeDiag } : {}),
    };
  })();
}

/**
 * Crash recovery. Executes allowed continuations via DI when safe.
 * Post-mutation fence: never write / click / new beginSend.
 */
export async function recoverSendOrchestration(ctx) {
  const {
    journal,
    doc,
    persistJournal,
    findCanonicalUserTurn,
    inFlight = null,
  } = ctx;

  if (!journal || journal.state === "NONE") {
    return ok({ journal, action: "noop" });
  }
  if (journal.state === "OUTCOME_UNKNOWN") {
    return recoverLatePositiveAck(ctx);
  }

  if (journal.state === "SEND_INTENT") {
    if (!inFlight) {
      const none = clearJournal();
      await persist(persistJournal, none);
      return ok({ journal: none, action: "clear" });
    }
    if (
      inFlight.status === "reserved"
      && inFlight.eventId === journal.eventId
      && inFlight.reservationId === journal.reservationId
    ) {
      // Execute retry beginSend continuation (not a label-only return).
      const cont = await continueFromSendIntent(ctx, journal);
      return { ...cont, action: cont.ok ? "retried_begin_send" : cont.action || "retry_begin_send_failed" };
    }
    if (
      inFlight.status === "claimed"
      && inFlight.eventId === journal.eventId
      && inFlight.reservationId === journal.reservationId
      && inFlight.attemptId
    ) {
      try {
        const claimed = markClaimed(journal, {
          eventId: journal.eventId,
          reservationId: journal.reservationId,
          attemptId: inFlight.attemptId,
          message: inFlight.message,
          messageSha256: inFlight.messageSha256,
        });
        await persist(persistJournal, claimed);
        const cont = await continueFromClaimed(ctx, claimed, { snapshotBaseline: true, doc });
        return { ...cont, action: cont.ok ? "adopted_claimed_then_continue" : "adopted_claimed_failed" };
      } catch (error) {
        return fail("adopt_claimed_failed", {
          journal,
          error: String(error?.message || error),
        });
      }
    }
    if (
      inFlight.status === "outcome_unknown"
      && inFlight.eventId === journal.eventId
      && inFlight.reservationId === journal.reservationId
    ) {
      const unknown = markOutcomeUnknown(journal, {
        attemptId: inFlight.attemptId,
        message: inFlight.message,
        messageSha256: inFlight.messageSha256,
      });
      await persist(persistJournal, unknown);
      return fail("outcome_unknown", {
        journal: unknown,
        action: "adopt_outcome_unknown",
      });
    }
    return fail("inflight_mismatch", { journal, action: "conflict" });
  }

  if (journal.state === "CLAIMED") {
    // Pre-mutation: executable resume (write/dispatch/observe/ack).
    const cont = await continueFromClaimed(ctx, journal, { snapshotBaseline: true, doc });
    return { ...cont, action: cont.ok ? "resumed_claimed" : cont.reason || "resume_claimed_failed" };
  }

  if (journalInPostMutationFence(journal)) {
    if (journal.state === "OBSERVED_PENDING_ACK") {
      if (inFlight && inFlight.status === "observed") {
        if (inFlight.eventId === journal.eventId) {
          const none = clearJournal();
          await persist(persistJournal, none);
          return ok({ journal: none, action: "clear" });
        }
      }
      const result = await finalizeAck(ctx, journal);
      return {
        ...result,
        action: result.ok ? "ack_cleared" : "retry_ack",
        retryAck: result.ok ? undefined : true,
      };
    }

    // COMPOSER_WRITE_INTENT / SEND_DISPATCH_INTENT: observe only.
    if (doc && typeof findCanonicalUserTurn === "function" && journal.attemptId) {
      try {
        const rec = findCanonicalUserTurn(doc, {
          message: journal.message,
          attemptId: journal.attemptId,
          baseline: null,
        });
        if (rec?.ok) {
          const ackJournal = markObservedPendingAck(journal, {});
          await persist(persistJournal, ackJournal);
          const result = await finalizeAck(ctx, ackJournal);
          return {
            ...result,
            action: result.ok ? "observed_then_acked" : "retry_ack",
            retryAck: result.ok ? undefined : true,
          };
        }
      } catch {
        // fall through
      }
    }
    return fail("post_mutation_fence", {
      journal,
      action: "block",
      zeroWrite: true,
      zeroClick: true,
    });
  }

  return fail("unknown_state", { journal, action: "block" });
}
