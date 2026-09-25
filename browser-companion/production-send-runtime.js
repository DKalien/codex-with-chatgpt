/**
 * E1b3d3b production send runtime adapter (CS-local DI).
 * Wires pure send-orchestrator to browser runtime. NOT a second state machine.
 * Forbidden here: chrome.*, fetch, storage, credential, direct Bridge HTTP.
 */

import {
  runSendOrchestration,
  recoverSendOrchestration,
} from "./send-orchestrator.js";
import {
  matchesSendTargetIdentity,
  resolveChatGptAction,
  resolveChatGptComposer,
} from "./dom-adapter.js";
import { readCanonicalComposerText } from "./composer-write-adapter.js";
import { areChatgptConversationRoutesEquivalent } from "./route-esm.js";

function psFail(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

function psOk(extra = {}) {
  return { ok: true, ...extra };
}

/** Capability names required before any production claim / begin-send. */
export const REQUIRED_PRODUCTION_CAPABILITIES = [
  "inspectComposerWriteCapability",
  "writeCanonicalMessage",
  "verifyCanonicalComposer",
  "dispatchNativeSend",
  "snapshotUserTurns",
  "findCanonicalUserTurn",
  "hasExactAttemptMarker",
  "getCurrentRoute",
  "getCurrentGeneration",
  "persistJournal",
  "beginSend",
  "ackObserved",
];

/** OUTCOME_UNKNOWN late-positive recovery is observe/ACK only. */
export const REQUIRED_LATE_POSITIVE_RECOVERY_CAPABILITIES = [
  "findCanonicalUserTurn",
  "persistJournal",
  "ackObserved",
  "getCurrentRoute",
  "getCurrentGeneration",
];

function checkRequiredCapabilities(ctx) {
  const missing = [];
  for (const name of REQUIRED_PRODUCTION_CAPABILITIES) {
    if (typeof ctx?.[name] !== "function") missing.push(name);
  }
  // Send-readiness inspector: either dedicated DI or production-local fallback via resolveChatGptAction.
  const hasSendReady =
    typeof ctx?.waitForSendReady === "function"
    || (typeof ctx?.resolveChatGptAction === "function"
      && typeof ctx?.resolveChatGptComposer === "function"
      && typeof ctx?.readCanonicalComposerText === "function");
  if (!hasSendReady) missing.push("send_readiness_inspector");
  if (missing.length) {
    return psFail("production_capability_missing", { missing });
  }
  return psOk();
}

/** State-specific gate: OUTCOME_UNKNOWN late-positive recovery never needs write/click/beginSend. */
export function latePositiveRecoveryCapabilityGate(ctx) {
  const missing = [];
  for (const name of REQUIRED_LATE_POSITIVE_RECOVERY_CAPABILITIES) {
    if (typeof ctx?.[name] !== "function") missing.push(name);
  }
  if (missing.length) {
    return psFail("recovery_capability_missing", { missing });
  }
  return psOk();
}

/**
 * Local pre-claim preflight. Must fail while durable journal is still RESERVED.
 * Production is stricter than generic write helper: idle-only, never action=send.
 */
export function productionLocalPreflight(input) {
  const {
    journal,
    expectedRoute,
    expectedGeneration,
    getCurrentRoute,
    getCurrentGeneration,
    inspectComposerWriteCapability,
    doc,
  } = input || {};

  if (!journal || journal.state !== "RESERVED") {
    return psFail("journal_not_reserved", { journalState: journal?.state ?? "NONE" });
  }
  if (!journal.eventId || !journal.reservationId) {
    return psFail("journal_identity_missing");
  }
  if (!expectedRoute || !Number.isFinite(expectedGeneration)) {
    return psFail("production_identity_missing");
  }

  const cap = checkRequiredCapabilities(input);
  if (!cap.ok) return cap;

  let route;
  try {
    route = getCurrentRoute();
  } catch {
    return psFail("route_unavailable");
  }
  if (!areChatgptConversationRoutesEquivalent(route, expectedRoute)) {
    return psFail("route_drift");
  }
  let generation;
  try {
    generation = getCurrentGeneration();
  } catch {
    return psFail("generation_unavailable");
  }
  if (!Number.isFinite(generation) || Number(generation) !== Number(expectedGeneration)) {
    return psFail("generation_drift");
  }

  const eligibility = inspectComposerWriteCapability(doc, {
    routeValid: true,
    routeCanonical: expectedRoute,
  });
  if (!eligibility?.ok) {
    return psFail(eligibility?.reason || "pre_write_ineligible");
  }
  // Production one-shot: idle only. action=send on empty composer is still not idle.
  const action = eligibility.action;
  if (!action || action.kind !== "idle") {
    return psFail("production_not_idle", { actionKind: action?.kind ?? null });
  }
  if (action.enabled !== true) {
    return psFail("send_disabled");
  }
  return psOk();
}

function defaultSendReadyInspector(ctx) {
  const resolveComposer =
    typeof ctx.resolveChatGptComposer === "function"
      ? ctx.resolveChatGptComposer
      : resolveChatGptComposer;
  const resolveAction =
    typeof ctx.resolveChatGptAction === "function"
      ? ctx.resolveChatGptAction
      : resolveChatGptAction;
  const readText =
    typeof ctx.readCanonicalComposerText === "function"
      ? ctx.readCanonicalComposerText
      : readCanonicalComposerText;

  return function waitForSendReady(doc, message, journal) {
    const readyTimeoutMs = Number.isFinite(ctx.sendReadyTimeoutMs) ? ctx.sendReadyTimeoutMs : 1000;
    const pollMs = Number.isFinite(ctx.sendReadyPollMs) ? ctx.sendReadyPollMs : 50;
    const now = typeof ctx.now === "function" ? ctx.now : () => Date.now();
    const waitMs = typeof ctx.waitMs === "function"
      ? ctx.waitMs
      : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const deadline = now() + readyTimeoutMs;

    const checkOnce = () => {
      if (!ctx.liveFenceOk()) return psFail("send_ready_fence_failed");
      const { editor } = resolveComposer(doc);
      if (!editor) return psFail("composer_missing");
      const read = readText(editor);
      if (!read.ok) return psFail(read.reason);
      const want = typeof ctx.normalizeCanonicalDomText === "function"
        ? ctx.normalizeCanonicalDomText(message)
        : message;
      if (read.text !== want) return psFail("composer_text_mismatch");
      const action = resolveAction(doc, editor);
      if (action.kind === "stop") return psFail("generation_active");
      if (action.kind === "unknown") return psFail("generation_unknown");
      if (action.kind === "send") {
        if (action.enabled !== true) return psFail("send_disabled");
        // R3r Send parity: the shared structural matcher (dom-adapter) is the
        // single Send identity source — exactly what the bootstrap ready gate,
        // the click adapter's second line of defense and the route-attest
        // runner consume. Legacy testid identity passes through it; the
        // current structural submit identity matches it. A missing classic
        // binding fails closed, never clicks. No local identity hardcode is
        // allowed here: the build drift gate forbids reintroducing one.
        if (typeof matchesSendTargetIdentity !== "function"
          || !matchesSendTargetIdentity(action.button)) {
          return psFail("send_target_invalid");
        }
        return psOk();
      }
      // idle → keep polling
      return { ok: false, reason: "send_not_ready", continuePolling: true };
    };

    const loop = async () => {
      for (;;) {
        const r = checkOnce();
        if (r.ok) return r;
        if (!r.continuePolling) return r;
        if (now() >= deadline) return psFail("send_ready_timeout");
        await waitMs(pollMs);
      }
    };
    return loop();
  };
}

function buildFencedCtx(ctx) {
  const expectedRoute = ctx.expectedRoute;
  const expectedGeneration = ctx.expectedGeneration;
  const getCurrentRoute = ctx.getCurrentRoute;
  const getCurrentGeneration = ctx.getCurrentGeneration;
  const hasExactAttemptMarker =
    typeof ctx.hasExactAttemptMarker === "function"
      ? ctx.hasExactAttemptMarker
      : typeof globalThis !== "undefined" && typeof globalThis.hasExactAttemptMarker === "function"
        ? globalThis.hasExactAttemptMarker.bind(globalThis)
        : null;

  const routeOk = () => {
    if (typeof getCurrentRoute !== "function") return false;
    try {
      return areChatgptConversationRoutesEquivalent(getCurrentRoute(), expectedRoute);
    } catch {
      return false;
    }
  };
  const generationOk = () => {
    if (typeof getCurrentGeneration !== "function") return false;
    try {
      const g = getCurrentGeneration();
      return Number.isFinite(g) && Number(g) === Number(expectedGeneration);
    } catch {
      return false;
    }
  };
  const liveFenceOk = () => routeOk() && generationOk();

  const inspectComposerWriteCapability = (doc, opts = {}) => {
    if (!liveFenceOk()) return { ok: false, reason: "generation_drift" };
    return ctx.inspectComposerWriteCapability(doc, opts);
  };

  const writeCanonicalMessage = (doc, message, opts = {}) => {
    if (!liveFenceOk()) {
      return {
        ok: false,
        reason: "generation_drift",
        mutationAttempted: false,
        wrote: false,
        verified: false,
      };
    }
    const callerGuard = opts.mutationGuard;
    return ctx.writeCanonicalMessage(doc, message, {
      ...opts,
      mutationGuard: () => {
        if (!liveFenceOk()) return false;
        if (typeof callerGuard === "function") {
          try {
            return callerGuard() !== false;
          } catch {
            return false;
          }
        }
        return true;
      },
    });
  };

  const verifyCanonicalComposer = (doc, message, opts = {}) => {
    if (!liveFenceOk()) return { ok: false, reason: "generation_drift" };
    return ctx.verifyCanonicalComposer(doc, message, opts);
  };

  const dispatchNativeSend = (doc, message, opts = {}) => {
    if (!liveFenceOk()) {
      return { ok: false, reason: "generation_drift" };
    }
    return ctx.dispatchNativeSend(doc, message, {
      ...opts,
      mutationGuard: () => liveFenceOk(),
    });
  };

  const beginSend = async (input) => {
    // Re-fence immediately before /begin-send RPC.
    if (!liveFenceOk()) {
      throw new Error("production_fence_failed");
    }
    const result = await ctx.beginSend(input);
    if (
      hasExactAttemptMarker
      && result
      && typeof result.message === "string"
      && typeof result.attemptId === "string"
    ) {
      const marker = hasExactAttemptMarker(result.message, result.attemptId);
      if (!marker?.ok) {
        throw new Error(marker?.reason || "attempt_marker_missing");
      }
    }
    return result;
  };

  const validateClaimedPayload = (claimedJournal) => {
    if (!hasExactAttemptMarker) {
      return { ok: false, reason: "attempt_marker_validator_missing" };
    }
    if (!claimedJournal?.message || !claimedJournal?.attemptId) {
      return { ok: false, reason: "claimed_payload_missing" };
    }
    return hasExactAttemptMarker(claimedJournal.message, claimedJournal.attemptId);
  };

  const findCanonicalUserTurn = (doc, input = {}) => {
    if (!liveFenceOk()) {
      return { ok: false, reason: "observation_fence_failed" };
    }
    return ctx.findCanonicalUserTurn(doc, input);
  };

  const waitForSendReady =
    typeof ctx.waitForSendReady === "function"
      ? (doc, message, journal) => {
          if (!liveFenceOk()) return psFail("send_ready_fence_failed");
          return ctx.waitForSendReady(doc, message, journal);
        }
      : defaultSendReadyInspector({
          ...ctx,
          liveFenceOk,
        });

  return {
    ...ctx,
    liveFenceOk,
    inspectComposerWriteCapability,
    writeCanonicalMessage,
    verifyCanonicalComposer,
    dispatchNativeSend,
    beginSend,
    validateClaimedPayload,
    requireClaimedPayloadValidator: true,
    findCanonicalUserTurn,
    waitForSendReady,
    // Production observation window: ~2s at 50ms poll (tests may override).
    pollIntervalMs: Number.isFinite(ctx.pollIntervalMs) ? ctx.pollIntervalMs : 50,
    maxPollAttempts: Number.isFinite(ctx.maxPollAttempts) ? ctx.maxPollAttempts : 40,
  };
}

/**
 * Explicit production one-shot send from durable RESERVED.
 * Preflight MUST pass before any journal mutation / begin-send.
 */
export async function runProductionSend(ctx) {
  const preflight = productionLocalPreflight(ctx);
  if (!preflight.ok) {
    return {
      ...preflight,
      journal: ctx?.journal ?? null,
      mode: "production_send",
      preMutation: true,
      zeroWrite: true,
      zeroClick: true,
      beginSendCalled: false,
    };
  }
  const result = await runSendOrchestration(buildFencedCtx(ctx));
  return {
    ...result,
    mode: "production_send",
  };
}

/**
 * Crash recovery for send-side durable states. Reuses pure recoverSendOrchestration.
 * OUTCOME_UNKNOWN uses a state-specific observe/ACK-only capability gate.
 */
export async function recoverProductionSend(ctx) {
  const isLatePositive = ctx?.journal?.state === "OUTCOME_UNKNOWN";
  const cap = isLatePositive
    ? latePositiveRecoveryCapabilityGate(ctx)
    : checkRequiredCapabilities(ctx);
  if (!cap.ok) {
    return {
      ...cap,
      journal: ctx?.journal ?? null,
      mode: "production_recover",
      zeroWrite: true,
      zeroClick: true,
    };
  }
  const fenced = isLatePositive
    ? {
        ...ctx,
        liveFenceOk: () => {
          const getCurrentRoute = ctx.getCurrentRoute;
          const getCurrentGeneration = ctx.getCurrentGeneration;
          try {
            if (!areChatgptConversationRoutesEquivalent(getCurrentRoute(), ctx.expectedRoute)) return false;
            const g = getCurrentGeneration();
            return Number.isFinite(g) && Number(g) === Number(ctx.expectedGeneration);
          } catch {
            return false;
          }
        },
        findCanonicalUserTurn: (doc, input = {}) => {
          try {
            if (
              !areChatgptConversationRoutesEquivalent(ctx.getCurrentRoute(), ctx.expectedRoute)
              || Number(ctx.getCurrentGeneration()) !== Number(ctx.expectedGeneration)
            ) {
              return { ok: false, reason: "observation_fence_failed" };
            }
          } catch {
            return { ok: false, reason: "observation_fence_failed" };
          }
          return ctx.findCanonicalUserTurn(doc, input);
        },
      }
    : buildFencedCtx(ctx);
  const result = await recoverSendOrchestration(fenced);
  return {
    ...result,
    mode: "production_recover",
  };
}
