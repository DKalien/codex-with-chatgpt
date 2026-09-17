/**
 * E1b3d3a runtime Send click capability — ONLY module allowed to .click().
 * Browser-safe. No composer write, no execCommand, no Chrome API, no fetch,
 * no production journal transitions, no orchestration state machine.
 */

import {
  resolveChatGptComposer,
  resolveChatGptAction,
  normalizeCanonicalDomText,
} from "./dom-adapter.js";
import { readCanonicalComposerText } from "./composer-write-adapter.js";

function fail(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

function ok(extra = {}) {
  return { ok: true, ...extra };
}

/**
 * Native Send click. Fresh resolve composer/action/exact text before click.
 * Optional synchronous mutationGuard runs immediately before .click().
 * At most one .click(). Zero clicks on any validation failure. No retry.
 */
export function dispatchNativeSend(doc, message, opts = {}) {
  const routeValid = opts.routeValid === true;
  if (!routeValid) return fail("route_invalid");
  if (!doc || typeof doc.querySelector !== "function") return fail("composer_missing");

  const { editor } = resolveChatGptComposer(doc);
  if (!editor) return fail("composer_missing");

  const action = resolveChatGptAction(doc, editor);
  if (action.kind === "stop") return fail("generation_active");
  if (action.kind === "idle") return fail("send_action_not_ready");
  if (action.kind === "unknown") return fail("send_action_unknown");
  if (action.kind !== "send" || !action.enabled) return fail("send_disabled");
  if (!action.button || typeof action.button.click !== "function") {
    return fail("send_button_missing");
  }
  if (action.button.getAttribute?.("data-testid") !== "send-button") {
    return fail("send_target_invalid");
  }

  const read = readCanonicalComposerText(editor);
  if (!read.ok) return fail(read.reason);
  const want = normalizeCanonicalDomText(message);
  if (read.text !== want) return fail("composer_text_mismatch");

  // Last-moment fence after all fresh DOM checks, immediately before .click().
  if (typeof opts.mutationGuard === "function") {
    let guarded = false;
    try {
      guarded = opts.mutationGuard() !== false;
    } catch {
      guarded = false;
    }
    if (!guarded) return fail("send_mutation_guard_failed");
  }

  try {
    action.button.click();
    return ok({ clicked: 1, evidence: action.evidence, representation: read.representation });
  } catch {
    return fail("send_click_error");
  }
}
