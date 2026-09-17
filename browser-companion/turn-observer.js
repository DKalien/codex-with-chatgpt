/**
 * E1b3b read-only user-turn observation.
 * No DOM mutation. No network. No Chrome API.
 * Not runtime-loaded in production extension.
 */

import { normalizeCanonicalDomText } from "./dom-adapter.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// CR / LF / U+2028 / U+2029
const LINE_BREAKS = /[\r\n\u2028\u2029]/;

function queryAll(root, selector) {
  try {
    if (typeof root.querySelectorAll !== "function") return [];
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function textOf(el) {
  if (!el) return "";
  const t = el.innerText ?? el.textContent ?? "";
  return typeof t === "string" ? t : "";
}

function isUserTurn(el) {
  if (!el) return false;
  const role =
    el.getAttribute?.("data-message-author-role")
    || el.getAttribute?.("data-turn-author-role")
    || el.getAttribute?.("data-author-role")
    || "";
  if (role === "user") return true;
  const nested = el.querySelector?.('[data-message-author-role="user"]');
  if (nested && nested !== el) return true;
  return false;
}

function turnCandidates(doc) {
  if (!doc || typeof doc.querySelectorAll !== "function") return [];
  // Real Edge: SECTION[data-testid^="conversation-turn"]; keep article fallback.
  const turns = queryAll(
    doc,
    'section[data-testid^="conversation-turn"], article[data-testid^="conversation-turn"], [data-testid="conversation-turn"], [data-message-author-role]',
  );
  const unique = [];
  const seen = new Set();
  for (const t of turns) {
    if (!t || seen.has(t)) continue;
    if (!isUserTurn(t)) continue;
    seen.add(t);
    unique.push(t);
  }
  // Prefer nodes that themselves carry the user role attribute (message body).
  const direct = unique.filter((el) =>
    (el.getAttribute?.("data-message-author-role") || el.getAttribute?.("data-turn-author-role")) === "user");
  return direct.length > 0 ? direct : unique;
}

export function snapshotUserTurns(doc) {
  const turns = turnCandidates(doc);
  return turns.map((el, index) => ({
    id: el.getAttribute?.("data-turn-id")
      || el.closest?.('[data-testid^="conversation-turn"]')?.getAttribute?.("data-testid")
      || el.getAttribute?.("data-testid")
      || `idx-${index}`,
    text: normalizeCanonicalDomText(textOf(el)),
    node: el,
  }));
}

function baselineHas(baseline, turn) {
  if (!baseline || baseline.length === 0) return false;
  for (const b of baseline) {
    if (b === turn) return true;
    if (b && b.id != null && b.id === turn.id) return true;
    if (b && typeof b.text === "string" && b.text === turn.text && b.text.length > 0) return true;
    if (b && b.node === turn.node) return true;
  }
  return false;
}

/**
 * Exact ATTEMPT_ID marker proof (FIX1).
 * Requires exactly one line: `ATTEMPT_ID: <attemptId>`.
 * No substring match. attemptId must be line-safe UUID.
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function hasExactAttemptMarker(message, attemptId) {
  if (typeof message !== "string" || message.length === 0) {
    return { ok: false, reason: "message_missing" };
  }
  if (typeof attemptId !== "string" || attemptId.length === 0) {
    return { ok: false, reason: "attempt_missing" };
  }
  if (LINE_BREAKS.test(attemptId) || attemptId.includes("\u2028") || attemptId.includes("\u2029")) {
    return { ok: false, reason: "attempt_not_line_safe" };
  }
  if (!UUID.test(attemptId)) {
    return { ok: false, reason: "attempt_not_uuid" };
  }
  const normalized = normalizeCanonicalDomText(message);
  const lines = normalized.split("\n");
  const expected = `ATTEMPT_ID: ${attemptId}`;
  const hits = lines.filter((line) => line === expected);
  if (hits.length === 1) return { ok: true };
  if (hits.length === 0) return { ok: false, reason: "attempt_marker_mismatch" };
  return { ok: false, reason: "attempt_marker_duplicate" };
}

/**
 * Late-positive recover diagnostics: counts/lengths only.
 * Never include raw turn text, message body, credential, or secret.
 */
export const TURN_DIAGNOSTIC_LIMITS = {
  maxCandidatesReported: 5,
};

function roleEvidence(el) {
  if (!el || typeof el.getAttribute !== "function") {
    return { directRole: null, nestedUser: false };
  }
  const directRole =
    el.getAttribute("data-message-author-role")
    || el.getAttribute("data-turn-author-role")
    || el.getAttribute("data-author-role")
    || null;
  let nestedUser = false;
  try {
    nestedUser = Boolean(el.querySelector?.('[data-message-author-role="user"]'));
  } catch {
    nestedUser = false;
  }
  return { directRole, nestedUser };
}

/**
 * Bounded observation diagnostic. Safe for popup / recover RPC.
 * @param {{ message?: string, attemptId?: string, turns?: Array<{text?: string, node?: unknown}>, matches?: unknown[] }} input
 */
export function buildTurnObservationDiagnostic(input = {}) {
  const message = typeof input.message === "string" ? input.message : "";
  const attemptId = typeof input.attemptId === "string" ? input.attemptId : "";
  const want = message ? normalizeCanonicalDomText(message) : "";
  const turns = Array.isArray(input.turns) ? input.turns : [];
  const matches = Array.isArray(input.matches) ? input.matches : [];

  let exactTextMatchCount = 0;
  let exactAttemptMarkerCount = 0;
  let firstMismatchIndex = null;
  const maxReport = TURN_DIAGNOSTIC_LIMITS.maxCandidatesReported;
  const candidateLengths = [];
  const candidates = [];

  for (let i = 0; i < turns.length; i++) {
    const text = typeof turns[i]?.text === "string" ? turns[i].text : "";
    if (want && text === want) exactTextMatchCount += 1;
    if (attemptId && hasExactAttemptMarker(text, attemptId).ok) {
      exactAttemptMarkerCount += 1;
    }
    if (firstMismatchIndex == null && want && text !== want) {
      firstMismatchIndex = i;
    }
    if (i < maxReport) {
      candidateLengths.push(text.length);
      candidates.push(roleEvidence(turns[i]?.node));
    }
  }

  return {
    candidateCount: turns.length,
    exactTextMatchCount,
    exactAttemptMarkerCount,
    ambiguousCount: matches.length > 1 ? matches.length : 0,
    targetLength: want.length,
    candidateLengths,
    firstMismatchIndex,
    candidates,
  };
}

/**
 * Allowlist only. Never pass through message/text/body/credential/secret.
 */
export function sanitizeObservationDiagnostic(diagnostic) {
  if (!diagnostic || typeof diagnostic !== "object") return null;
  const allowed = [
    "candidateCount",
    "exactTextMatchCount",
    "exactAttemptMarkerCount",
    "ambiguousCount",
    "targetLength",
    "candidateLengths",
    "firstMismatchIndex",
    "candidates",
  ];
  const out = {};
  for (const key of allowed) {
    if (diagnostic[key] === undefined) continue;
    const value = diagnostic[key];
    if (key === "candidateLengths") {
      if (!Array.isArray(value)) continue;
      out[key] = value
        .slice(0, TURN_DIAGNOSTIC_LIMITS.maxCandidatesReported)
        .map((n) => (Number.isFinite(n) ? Number(n) : 0));
      continue;
    }
    if (key === "candidates") {
      if (!Array.isArray(value)) continue;
      out[key] = value.slice(0, TURN_DIAGNOSTIC_LIMITS.maxCandidatesReported).map((item) => ({
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

/**
 * Find exactly one new (or uniquely matching) USER turn whose
 * normalized text equals the canonical message with exact ATTEMPT_ID line.
 *
 * Zero => not observed. Multiple => ambiguous fail closed.
 */
export function findCanonicalUserTurn(doc, input = {}) {
  const message = input.message;
  const attemptId = input.attemptId;
  const baseline = Array.isArray(input.baseline) ? input.baseline : null;

  if (typeof message !== "string" || message.length === 0) {
    return { ok: false, reason: "message_missing" };
  }
  if (typeof attemptId !== "string" || attemptId.length === 0) {
    return { ok: false, reason: "attempt_missing" };
  }
  if (!doc || typeof doc.querySelectorAll !== "function") {
    return { ok: false, reason: "document_missing" };
  }

  // Validate canonical message ↔ attemptId binding BEFORE scanning DOM.
  const marker = hasExactAttemptMarker(message, attemptId);
  if (!marker.ok) {
    return { ok: false, reason: marker.reason };
  }

  const want = normalizeCanonicalDomText(message);
  const turns = snapshotUserTurns(doc);
  const matches = turns.filter((turn) => {
    if (turn.text !== want) return false;
    const turnMarker = hasExactAttemptMarker(turn.text, attemptId);
    if (!turnMarker.ok) return false;
    if (baseline && baselineHas(baseline, turn)) return false;
    return true;
  });

  const diagnostic = buildTurnObservationDiagnostic({
    message,
    attemptId,
    turns,
    matches,
  });

  if (matches.length === 0) {
    return { ok: false, reason: "not_observed", diagnostic };
  }
  if (matches.length > 1) {
    return { ok: false, reason: "ambiguous", diagnostic };
  }
  return {
    ok: true,
    turn: matches[0],
    withBaseline: Boolean(baseline),
    diagnostic,
  };
}
