/**
 * E1b3d3a one-shot real Send probe runner (CS-local diagnostic).
 * NOT production send-orchestrator. No journal transitions.
 * Uses write adapter + click adapter + turn observer only.
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
import { dispatchNativeSend } from "./send-click-adapter.js";
import { resolveMutationCanonicalRoute } from "./write-probe.js";
import { areChatgptConversationRoutesEquivalent } from "./route-esm.js";
import { buildSendProbeMessage } from "./send-probe-message.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Order: preflight idle → baseline → write+verify → poll Send ready → one click → observe.
 * Live generation fence via getCurrentGeneration(). Never auto-retry.
 */
export async function runRealSendProbe(doc, opts = {}) {
  const message = typeof opts.probeMessage === "string" ? opts.probeMessage : "";
  const attemptId = typeof opts.attemptId === "string" ? opts.attemptId : "";
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
  const pollMs = typeof opts.pollMs === "number" ? opts.pollMs : 50;

  const snapshotUserTurns = typeof opts.snapshotUserTurns === "function"
    ? opts.snapshotUserTurns
    : globalThis.snapshotUserTurns;
  const findCanonicalUserTurn = typeof opts.findCanonicalUserTurn === "function"
    ? opts.findCanonicalUserTurn
    : globalThis.findCanonicalUserTurn;

  const base = {
    mode: "send_probe_real",
    attemptId,
    mutationAttempted: false,
    wrote: false,
    verified: false,
    clickAttempted: false,
    clicked: false,
    observed: false,
    noSend: false,
  };

  if (!message || !attemptId) {
    return { ...base, ok: false, reason: "send_probe_payload_invalid" };
  }
  // Fixed template only — never accept arbitrary caller message.
  const expectedMessage = buildSendProbeMessage(attemptId);
  if (!expectedMessage || message !== expectedMessage) {
    return { ...base, ok: false, reason: "send_probe_payload_invalid" };
  }
  if (!expectedRoute || !Number.isFinite(expectedGeneration)) {
    return { ...base, ok: false, reason: "send_probe_identity_missing" };
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

  // Live generation fence at entry (before any mutation).
  if (!generationOk()) {
    return { ...base, ok: false, reason: "send_probe_generation_mismatch" };
  }
  if (!routeOk()) {
    return { ...base, ok: false, reason: "write_probe_route_drift" };
  }

  // Dedicated idle-only preflight (stricter than writeCanonicalMessage).
  {
    const { editor } = resolveChatGptComposer(doc);
    if (!editor) {
      return { ...base, ok: false, reason: "composer_missing" };
    }
    const read = readCanonicalComposerText(editor);
    if (!read.ok) {
      return { ...base, ok: false, reason: read.reason };
    }
    if (read.text.replace(/ /g, " ").trim().length > 0) {
      return { ...base, ok: false, reason: "composer_dirty" };
    }
    const action = resolveChatGptAction(doc, editor);
    if (action.kind === "stop") {
      return { ...base, ok: false, reason: "generation_active" };
    }
    if (action.kind === "unknown") {
      return { ...base, ok: false, reason: "generation_unknown" };
    }
    if (action.kind !== "idle") {
      return { ...base, ok: false, reason: "send_probe_not_idle" };
    }
    if (action.enabled !== true) {
      return { ...base, ok: false, reason: "send_disabled" };
    }
  }

  let baseline = [];
  try {
    if (typeof snapshotUserTurns === "function") {
      baseline = snapshotUserTurns(doc) || [];
    }
  } catch {
    baseline = [];
  }

  const write = writeCanonicalMessage(doc, message, {
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
  const verify = verifyCanonicalComposer(doc, message, { routeValid: true });
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

  // Send-ready poll: live route + generation + exact text each round.
  const deadline = now() + readyTimeoutMs;
  for (;;) {
    if (!generationOk()) {
      return {
        ...base,
        ok: false,
        reason: "send_probe_generation_mismatch",
        mutationAttempted: true,
        wrote: true,
        verified: true,
      };
    }
    if (!routeOk()) {
      return {
        ...base,
        ok: false,
        reason: "write_probe_route_drift",
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
    if (!read.ok || read.text !== normalizeCanonicalDomText(message)) {
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
    if (now() >= deadline) {
      return {
        ...base,
        ok: false,
        reason: "send_button_not_ready",
        mutationAttempted: true,
        wrote: true,
        verified: true,
      };
    }
    await waitMs(pollMs);
  }

  // Final fence immediately before dispatch.
  if (!generationOk()) {
    return {
      ...base,
      ok: false,
      reason: "send_probe_generation_mismatch",
      mutationAttempted: true,
      wrote: true,
      verified: true,
    };
  }
  if (!routeOk()) {
    return {
      ...base,
      ok: false,
      reason: "write_probe_route_drift",
      mutationAttempted: true,
      wrote: true,
      verified: true,
    };
  }

  const click = dispatchNativeSend(doc, message, {
    routeValid: true,
    mutationGuard: () => routeOk() && generationOk(),
  });
  if (!click.ok) {
    return {
      ...base,
      ok: false,
      reason: click.reason,
      mutationAttempted: true,
      wrote: true,
      verified: true,
      clickAttempted: true,
      clicked: false,
    };
  }

  if (typeof findCanonicalUserTurn !== "function") {
    return {
      ...base,
      ok: false,
      reason: "turn_observer_missing",
      mutationAttempted: true,
      wrote: true,
      verified: true,
      clickAttempted: true,
      clicked: true,
    };
  }
  const obsDeadline = now() + observeTimeoutMs;
  for (;;) {
    // Post-click generation drift → outcome unknown shape; no retry.
    if (!generationOk()) {
      return {
        ...base,
        ok: false,
        reason: "send_probe_generation_mismatch",
        mutationAttempted: true,
        wrote: true,
        verified: true,
        clickAttempted: true,
        clicked: true,
        observed: false,
      };
    }
    let rec = null;
    try {
      rec = findCanonicalUserTurn(doc, { message, attemptId, baseline });
    } catch {
      rec = null;
    }
    if (rec && rec.ok === true) {
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
    if (rec && rec.reason === "ambiguous") {
      return {
        ...base,
        ok: false,
        reason: "ambiguous",
        mutationAttempted: true,
        wrote: true,
        verified: true,
        clickAttempted: true,
        clicked: true,
        observed: false,
      };
    }
    if (now() >= obsDeadline) {
      return {
        ...base,
        ok: false,
        reason: "not_observed",
        mutationAttempted: true,
        wrote: true,
        verified: true,
        clickAttempted: true,
        clicked: true,
        observed: false,
      };
    }
    await waitMs(pollMs);
  }
}
