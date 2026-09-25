/** One-shot fixed feedback takeover bootstrap; no caller-supplied message body. */

import {
  resolveChatGptComposer,
  resolveChatGptAction,
  matchesSendTargetIdentity,
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
import { collectBoundedDescendants } from "./turn-observer.js";

export const FEEDBACK_BOOTSTRAP_MESSAGE = [
  "[C2C_FEEDBACK_BOOTSTRAP]",
  "这是 C2C 当前对话连接自举，不是开发任务。",
  "请在本对话调用 feedback_status。",
  "若 enabled=true 且 ownsBinding=false，使用返回 binding 的 exact epoch/widgetId 调 feedback_takeover。",
  "若 ownsBinding=true 不调用 takeover。",
  "完成后停止；Browser Companion 会继续 route verification。",
  "不调用 codex_desktop_send，不执行开发任务。",
  "若 feedback_status 或 feedback_takeover 工具不可用，仅回复 C2C_FEEDBACK_BOOTSTRAP_TOOL_MISSING 并停止。",
].join("\n");

export const FEEDBACK_BOOTSTRAP_EXECUTE_TYPE = "c2c.feedback.bootstrap.execute";

export function isFeedbackBootstrapMessage(value) {
  return value === FEEDBACK_BOOTSTRAP_MESSAGE;
}

function baselineHas(baseline, turn) {
  return baseline.some((item) => item === turn
    || (item?.id != null && item.id === turn?.id)
    || (item?.node && item.node === turn?.node)
    || (typeof item?.text === "string" && item.text.length > 0 && item.text === turn?.text));
}

function hasBootstrapMarker(text, normalizeText) {
  const normalized = normalizeText(text);
  return normalized.split("\n").filter((line) => line === "[C2C_FEEDBACK_BOOTSTRAP]").length === 1;
}

function hasExactBody(turn, wanted, normalizeText) {
  if (!turn || typeof turn.text !== "string") return false;
  const parent = normalizeText(turn.text);
  if (parent === wanted) return true;
  if (!hasBootstrapMarker(parent, normalizeText)) return false;
  let descendants = [];
  try {
    descendants = collectBoundedDescendants(turn.node, 64);
  } catch {
    return false;
  }
  return descendants.some((node) => {
    const text = typeof node?.innerText === "string" ? node.innerText : "";
    return normalizeText(text) === wanted;
  });
}

export function findFeedbackBootstrapUserTurn({ turns, message, baseline, normalizeText } = {}) {
  if (!isFeedbackBootstrapMessage(message)) return { ok: false, reason: "bootstrap_message_invalid" };
  if (!Array.isArray(turns)) return { ok: false, reason: "bootstrap_turns_missing" };
  const normalize = typeof normalizeText === "function" ? normalizeText : normalizeCanonicalDomText;
  const wanted = normalize(FEEDBACK_BOOTSTRAP_MESSAGE);
  const prior = Array.isArray(baseline) ? baseline : [];
  const matches = turns.filter((turn) => hasExactBody(turn, wanted, normalize) && !baselineHas(prior, turn));
  if (matches.length === 0) return { ok: false, reason: "bootstrap_not_observed" };
  if (matches.length > 1) return { ok: false, reason: "bootstrap_observation_ambiguous" };
  return { ok: true, turn: matches[0] };
}

export function hasFeedbackBootstrapToolMissingReply(doc, normalizeText = normalizeCanonicalDomText) {
  if (!doc || typeof doc.querySelectorAll !== "function") return false;
  let nodes;
  try {
    nodes = Array.from(doc.querySelectorAll(
      'section[data-testid^="conversation-turn"], article[data-testid^="conversation-turn"], [data-testid="conversation-turn"]',
    )).slice(-64);
  } catch {
    return false;
  }
  let lastBootstrapIndex = -1;
  const roles = [];
  const texts = [];
  for (const node of nodes) {
    const role = node?.getAttribute?.("data-message-author-role")
      || node?.getAttribute?.("data-turn-author-role")
      || node?.querySelector?.("[data-message-author-role]")?.getAttribute?.("data-message-author-role")
      || "";
    const rawText = node?.innerText ?? node?.textContent ?? "";
    const text = typeof rawText === "string" ? normalizeText(rawText) : "";
    if (role === "user" && text === normalizeText(FEEDBACK_BOOTSTRAP_MESSAGE)) {
      lastBootstrapIndex = roles.length;
    }
    roles.push(role);
    texts.push(text);
  }
  if (lastBootstrapIndex < 0) return false;
  const nextAssistant = roles.findIndex((role, index) => index > lastBootstrapIndex && role === "assistant");
  return nextAssistant >= 0 && texts[nextAssistant] === "C2C_FEEDBACK_BOOTSTRAP_TOOL_MISSING";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runFeedbackBootstrapSend(doc, opts = {}) {
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
  const readyTimeoutMs = Number.isFinite(opts.readyTimeoutMs) ? opts.readyTimeoutMs : 1000;
  const observeTimeoutMs = Number.isFinite(opts.observeTimeoutMs) ? opts.observeTimeoutMs : 2000;
  const snapshotUserTurns = typeof opts.snapshotUserTurns === "function"
    ? opts.snapshotUserTurns
    : globalThis.snapshotUserTurns;
  const normalizeText = typeof opts.normalizeText === "function"
    ? opts.normalizeText
    : normalizeCanonicalDomText;
  const base = {
    mode: "feedback_bootstrap_send",
    mutationAttempted: false,
    wrote: false,
    verified: false,
    clickAttempted: false,
    clicked: false,
    observed: false,
  };

  if (!isFeedbackBootstrapMessage(FEEDBACK_BOOTSTRAP_MESSAGE)) {
    return { ...base, ok: false, reason: "bootstrap_message_invalid" };
  }
  if (!expectedRoute || !Number.isFinite(expectedGeneration)) {
    return { ...base, ok: false, reason: "bootstrap_identity_missing" };
  }
  if (typeof snapshotUserTurns !== "function") {
    return { ...base, ok: false, reason: "bootstrap_observer_missing" };
  }

  const routeOk = () => {
    const actual = resolveMutationCanonicalRoute(readHref(), parseRoute);
    const expected = resolveMutationCanonicalRoute(expectedRoute, parseRoute);
    return actual.ok === true && expected.ok === true
      && (actual.canonical === expected.canonical
        || areChatgptConversationRoutesEquivalent(actual.canonical, expected.canonical));
  };
  const generationOk = () => {
    const current = getCurrentGeneration();
    return Number.isFinite(current) && Number(current) === Number(expectedGeneration);
  };
  if (!generationOk()) return { ...base, ok: false, reason: "bootstrap_generation_mismatch" };
  if (!routeOk()) return { ...base, ok: false, reason: "bootstrap_route_drift" };

  const { editor } = resolveChatGptComposer(doc);
  if (!editor) return { ...base, ok: false, reason: "composer_missing" };
  const before = readCanonicalComposerText(editor);
  if (!before.ok) return { ...base, ok: false, reason: before.reason };
  if (before.text.trim()) return { ...base, ok: false, reason: "composer_dirty" };
  const action = resolveChatGptAction(doc, editor);
  if (action.kind === "stop") return { ...base, ok: false, reason: "generation_active" };
  if (action.kind === "unknown") return { ...base, ok: false, reason: "generation_unknown" };
  if (action.kind !== "idle") return { ...base, ok: false, reason: "bootstrap_not_idle" };
  if (action.enabled !== true) return { ...base, ok: false, reason: "send_disabled" };

  let baseline;
  try {
    baseline = snapshotUserTurns(doc) || [];
  } catch {
    return { ...base, ok: false, reason: "bootstrap_observer_error" };
  }
  if (!Array.isArray(baseline)) return { ...base, ok: false, reason: "bootstrap_observer_invalid" };

  const write = writeCanonicalMessage(doc, FEEDBACK_BOOTSTRAP_MESSAGE, {
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
  const verify = verifyCanonicalComposer(doc, FEEDBACK_BOOTSTRAP_MESSAGE, { routeValid: true });
  if (!verify.ok) {
    return {
      ...base,
      ok: false,
      reason: verify.reason || "composer_text_mismatch",
      mutationAttempted: true,
      wrote: true,
    };
  }

  const deadline = now() + readyTimeoutMs;
  const pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : 50;
  for (;;) {
    if (!generationOk() || !routeOk()) {
      return { ...base, ok: false, reason: "bootstrap_identity_lost", mutationAttempted: true, wrote: true, verified: true };
    }
    const current = resolveChatGptComposer(doc).editor;
    if (!current) return { ...base, ok: false, reason: "composer_missing", mutationAttempted: true, wrote: true, verified: true };
    const read = readCanonicalComposerText(current);
    if (!read.ok || normalizeText(read.text) !== normalizeText(FEEDBACK_BOOTSTRAP_MESSAGE)) {
      return { ...base, ok: false, reason: read.ok ? "composer_text_mismatch" : read.reason, mutationAttempted: true, wrote: true, verified: true };
    }
    const nextAction = resolveChatGptAction(doc, current);
    if (nextAction.kind === "stop") return { ...base, ok: false, reason: "generation_active", mutationAttempted: true, wrote: true, verified: true };
    // R3p: Send-ready gate uses the shared identity rule (legacy data-testid
    // OR current structural submit identity) — same rule as classification.
    if (nextAction.kind === "send" && nextAction.enabled === true
      && matchesSendTargetIdentity(nextAction.button)) break;
    if (now() >= deadline) return { ...base, ok: false, reason: "bootstrap_send_not_ready", mutationAttempted: true, wrote: true, verified: true };
    await waitMs(pollMs);
  }

  let click;
  try {
    click = await dispatchNativeSend(doc, FEEDBACK_BOOTSTRAP_MESSAGE, {
      routeValid: true,
      mutationGuard: () => routeOk() && generationOk(),
    });
  } catch {
    return { ...base, ok: false, reason: "bootstrap_click_outcome_unknown", mutationAttempted: true, wrote: true, verified: true, clickAttempted: true };
  }
  if (!click || click.ok !== true) {
    return {
      ...base,
      ok: false,
      reason: click?.reason || "bootstrap_click_outcome_unknown",
      mutationAttempted: true,
      wrote: true,
      verified: true,
      clickAttempted: true,
    };
  }

  const observeDeadline = now() + observeTimeoutMs;
  for (;;) {
    if (!generationOk() || !routeOk()) {
      return { ...base, ok: false, reason: "bootstrap_outcome_unknown", mutationAttempted: true, wrote: true, verified: true, clickAttempted: true, clicked: true };
    }
    try {
      const found = findFeedbackBootstrapUserTurn({
        turns: snapshotUserTurns(doc),
        message: FEEDBACK_BOOTSTRAP_MESSAGE,
        baseline,
        normalizeText,
      });
      if (found.ok) {
        return { ...base, ok: true, mutationAttempted: true, wrote: true, verified: true, clickAttempted: true, clicked: true, observed: true };
      }
      if (found.reason === "bootstrap_observation_ambiguous") {
        return { ...base, ok: false, reason: found.reason, mutationAttempted: true, wrote: true, verified: true, clickAttempted: true, clicked: true };
      }
    } catch {
      // Keep waiting only within this bounded observation window.
    }
    if (now() >= observeDeadline) break;
    await waitMs(50);
  }
  return { ...base, ok: false, reason: "bootstrap_outcome_unknown", mutationAttempted: true, wrote: true, verified: true, clickAttempted: true, clicked: true };
}
