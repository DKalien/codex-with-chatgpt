/**
 * G3 route-attestation one-shot runner (CS-local).
 * NOT production send-orchestrator. No journal transitions. No auto-retry.
 * Message must exactly equal SW-supplied attestationMessage.
 */

import {
  resolveChatGptComposer,
  resolveChatGptAction,
  normalizeCanonicalDomText,
} from "./dom-adapter.js";
import {
  readCanonicalComposerText,
  writeCanonicalMessage,
  verifyCanonicalComposer,
} from "./composer-write-adapter.js";
import { areChatgptConversationRoutesEquivalent } from "./route-esm.js";
import { dispatchNativeSend } from "./send-click-adapter.js";
import { resolveMutationCanonicalRoute } from "./write-probe.js";
import {
  extractRouteChallengeId,
  findRouteAttestationUserTurn,
  isRouteAttestationMessage,
} from "./route-attestation.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runRouteAttestationSend(doc, opts = {}) {
  const attestationMessage = typeof opts.attestationMessage === "string" ? opts.attestationMessage : "";
  const expectedRoute = typeof opts.expectedRoute === "string" ? opts.expectedRoute : "";
  const expectedGeneration = opts.expectedGeneration;
  const parseRoute = typeof opts.parseRoute === "function" ? opts.parseRoute : undefined;
  const readHref = typeof opts.getCurrentHref === "function"
    ? opts.getCurrentHref
    : () => (typeof location !== "undefined" ? location.href : opts.locationHref || "");
  const getCurrentGeneration = typeof opts.getCurrentGeneration === "function"
    ? opts.getCurrentGeneration
    : () => opts.localGeneration;
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const waitMs = typeof opts.waitMs === "function" ? opts.waitMs : sleep;
  const readyTimeoutMs = typeof opts.readyTimeoutMs === "number" ? opts.readyTimeoutMs : 1000;
  const observeTimeoutMs = typeof opts.observeTimeoutMs === "number" ? opts.observeTimeoutMs : 2000;

  const snapshotUserTurns = typeof opts.snapshotUserTurns === "function"
    ? opts.snapshotUserTurns
    : globalThis.snapshotUserTurns;
  // Always default to production canonical DOM normalization (CRLF/CR/NBSP).
  const normalizeText = typeof opts.normalizeText === "function"
    ? opts.normalizeText
    : normalizeCanonicalDomText;

  const base = {
    mode: "route_attestation_send",
    mutationAttempted: false,
    wrote: false,
    verified: false,
    clickAttempted: false,
    clicked: false,
    observed: false,
  };

  // Fixed SW-owned message only — never accept arbitrary caller body.
  if (!isRouteAttestationMessage(attestationMessage)) {
    return { ...base, ok: false, reason: "route_attestation_message_missing" };
  }
  const challengeId = extractRouteChallengeId(attestationMessage);
  if (!challengeId) {
    return { ...base, ok: false, reason: "challenge_missing" };
  }
  if (!expectedRoute || !Number.isFinite(expectedGeneration)) {
    return { ...base, ok: false, reason: "route_attest_identity_missing" };
  }

  const routeOk = () => {
    const r = resolveMutationCanonicalRoute(readHref(), parseRoute);
    const expected = resolveMutationCanonicalRoute(expectedRoute, parseRoute);
    return r.ok === true && expected.ok === true && (r.canonical === expected.canonical || areChatgptConversationRoutesEquivalent(r.canonical, expected.canonical));
  };
  const generationOk = () => {
    const g = getCurrentGeneration();
    return Number.isFinite(g) && Number(g) === Number(expectedGeneration);
  };

  if (!generationOk()) return { ...base, ok: false, reason: "route_attest_generation_mismatch" };
  if (!routeOk()) return { ...base, ok: false, reason: "route_attest_route_drift" };

  {
    const { editor } = resolveChatGptComposer(doc);
    if (!editor) return { ...base, ok: false, reason: "composer_missing" };
    const read = readCanonicalComposerText(editor);
    if (!read.ok) return { ...base, ok: false, reason: read.reason };
    if (read.text.replace(/ /g, " ").trim().length > 0) {
      return { ...base, ok: false, reason: "composer_dirty" };
    }
    const action = resolveChatGptAction(doc, editor);
    if (action.kind === "stop") return { ...base, ok: false, reason: "generation_active" };
    if (action.kind === "unknown") return { ...base, ok: false, reason: "generation_unknown" };
    if (action.kind !== "idle") return { ...base, ok: false, reason: "route_attest_not_idle" };
    if (action.enabled !== true) return { ...base, ok: false, reason: "send_disabled" };
  }

  let baseline = [];
  try {
    if (typeof snapshotUserTurns === "function") baseline = snapshotUserTurns(doc) || [];
  } catch {
    baseline = [];
  }

  const write = writeCanonicalMessage(doc, attestationMessage, {
    routeValid: true,
    mutationGuard: () => routeOk() && generationOk(),
  });
  if (!write.ok) {
    return {
      ...base,
      ok: false,
      reason: write.reason,
      mutationAttempted: write.mutationAttempted === true,
      wrote: write.wrote === true,
    };
  }
  const verify = verifyCanonicalComposer(doc, attestationMessage, { routeValid: true });
  if (!verify.ok) {
    return {
      ...base,
      ok: false,
      reason: verify.reason || "composer_text_mismatch",
      mutationAttempted: true,
      wrote: true,
      verified: false,
    };
  }

  // Send-ready poll (send-probe contract): live route + generation + exact text.
  // idle = generation idle / NOT a click target; only form send-button is dispatchable.
  const deadline = now() + readyTimeoutMs;
  const pollMs = typeof opts.pollMs === "number" ? opts.pollMs : 50;
  for (;;) {
    if (!generationOk()) {
      return {
        ...base,
        ok: false,
        reason: "route_attest_generation_mismatch",
        mutationAttempted: true,
        wrote: true,
        verified: true,
      };
    }
    if (!routeOk()) {
      return {
        ...base,
        ok: false,
        reason: "route_attest_identity_lost",
        mutationAttempted: true,
        wrote: true,
        verified: true,
      };
    }
    const { editor } = resolveChatGptComposer(doc);
    if (!editor) {
      return {
        ...base,
        ok: false,
        reason: "composer_missing",
        mutationAttempted: true,
        wrote: true,
        verified: true,
      };
    }
    const read = readCanonicalComposerText(editor);
    if (!read.ok || read.text !== normalizeText(attestationMessage)) {
      return {
        ...base,
        ok: false,
        reason: read.ok ? "composer_text_mismatch" : read.reason,
        mutationAttempted: true,
        wrote: true,
        verified: true,
      };
    }
    const action = resolveChatGptAction(doc, editor);
    if (action.kind === "stop") {
      return {
        ...base,
        ok: false,
        reason: "generation_active",
        mutationAttempted: true,
        wrote: true,
        verified: true,
      };
    }
    if (
      action.kind === "send"
      && action.enabled === true
      && action.button?.getAttribute?.("data-testid") === "send-button"
    ) {
      break;
    }
    // idle / unknown / disabled send: keep polling until timeout.
    if (now() >= deadline) {
      return {
        ...base,
        ok: false,
        reason: "route_attest_send_not_ready",
        mutationAttempted: true,
        wrote: true,
        verified: true,
      };
    }
    await waitMs(pollMs);
  }

  const click = await dispatchNativeSend(doc, attestationMessage, {
    routeValid: true,
    mutationGuard: () => routeOk() && generationOk(),
  });
  // send-probe contract: success is click.ok (dispatch returns clicked: 1).
  if (!click || click.ok !== true) {
    // Ambiguous or failed click — fail closed, no auto-retry.
    return {
      ...base,
      ok: false,
      reason: click?.reason || "route_attest_click_failed",
      mutationAttempted: true,
      wrote: true,
      verified: true,
      clickAttempted: true,
      clicked: false,
    };
  }

  const observeDeadline = now() + observeTimeoutMs;
  let observed = false;
  let lastObserveReason = "not_observed";
  for (;;) {
    if (!generationOk() || !routeOk()) {
      return {
        ...base,
        ok: false,
        reason: "route_attest_outcome_ambiguous",
        mutationAttempted: true,
        wrote: true,
        verified: true,
        clickAttempted: true,
        clicked: true,
        observed: false,
      };
    }
    try {
      if (typeof snapshotUserTurns === "function") {
        const turns = snapshotUserTurns(doc) || [];
        const found = findRouteAttestationUserTurn({
          turns,
          message: attestationMessage,
          challengeId,
          baseline,
          normalizeText,
        });
        if (found.ok === true) {
          observed = true;
          break;
        }
        lastObserveReason = found.reason || "not_observed";
        // Any non-ok observer result is NEVER treated as observed.
      } else {
        lastObserveReason = "route_attest_observer_missing";
      }
    } catch {
      lastObserveReason = "route_attest_observer_error";
    }
    if (now() >= observeDeadline) break;
    await waitMs(50);
  }

  if (!observed) {
    return {
      ...base,
      ok: false,
      reason: lastObserveReason === "ambiguous"
        ? "route_attest_outcome_ambiguous"
        : (lastObserveReason === "not_observed"
          ? "route_attest_outcome_ambiguous"
          : lastObserveReason),
      mutationAttempted: true,
      wrote: true,
      verified: true,
      clickAttempted: true,
      clicked: true,
      observed: false,
    };
  }

  return {
    ...base,
    ok: true,
    mutationAttempted: true,
    wrote: true,
    verified: true,
    clickAttempted: true,
    clicked: true,
    observed: true,
  };
}

// Content-script capability global. SW never free-writes; message is SW-owned.
globalThis.__c2cRunRouteAttestationSend = runRouteAttestationSend;
