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
  if (el.getAttribute?.("data-user-message-bubble") === "true") return true;
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

function turnKeyOf(el) {
  return el.closest?.("[data-turn-key]")?.getAttribute?.("data-turn-key") || null;
}

function turnCandidates(doc) {
  if (!doc || typeof doc.querySelectorAll !== "function") return [];
  // Real Edge: SECTION[data-testid^="conversation-turn"]; keep article fallback.
  const turns = queryAll(
    doc,
    'section[data-testid^="conversation-turn"], article[data-testid^="conversation-turn"], [data-testid="conversation-turn"], [data-message-author-role], [data-user-message-bubble="true"]',
  );
  const unique = [];
  const seen = new Set();
  for (const t of turns) {
    if (!t || seen.has(t)) continue;
    if (!isUserTurn(t)) continue;
    seen.add(t);
    unique.push(t);
  }
  // Keep legacy preference within legacy candidates; modern bubbles carry their own USER proof.
  const legacy = unique.filter((el) => el.getAttribute?.("data-user-message-bubble") !== "true");
  const direct = legacy.filter((el) =>
    (el.getAttribute?.("data-message-author-role") || el.getAttribute?.("data-turn-author-role")) === "user");
  const preferred = [...(direct.length > 0 ? direct : legacy),
    ...unique.filter((el) => el.getAttribute?.("data-user-message-bubble") === "true")];
  const byTurnKey = new Map();
  const deduped = [];
  for (const el of preferred) {
    const key = turnKeyOf(el);
    const index = key ? byTurnKey.get(key) : undefined;
    if (index === undefined) {
      if (key) byTurnKey.set(key, deduped.length);
      deduped.push(el);
    } else if (el.getAttribute?.("data-user-message-bubble") === "true"
      && deduped[index].getAttribute?.("data-user-message-bubble") !== "true") {
      deduped[index] = el;
    }
  }
  return deduped;
}

export function snapshotUserTurns(doc) {
  const turns = turnCandidates(doc);
  return turns.map((el, index) => ({
    id: el.getAttribute?.("data-turn-id")
      || turnKeyOf(el)
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
  maxDescendantsScanned: 64,
};

export const MARKER_REPRESENTATION_NUMERIC_KEYS = [
  "markerCandidateIndex",
  "markerCandidateNormalizedLength",
  "markerInnerTextLength",
  "markerTextContentLength",
  "targetLineCount",
  "markerInnerTextLineCount",
  "markerTextContentLineCount",
  "innerLengthDelta",
  "textContentLengthDelta",
  "innerCommonPrefixLength",
  "innerCommonSuffixLength",
  "textCommonPrefixLength",
  "textCommonSuffixLength",
  "descendantScannedCount",
  "exactInnerTextDescendantCount",
  "exactTextContentDescendantCount",
  "attemptMarkerDescendantCount",
  "richBodyWrapperScannedCount",
  "richBodyCount",
  "richBodyNodeScannedCount",
  "richBodyRebuiltLength",
  "richBodyRebuiltLineCount",
  "richBodyLengthDelta",
  "richBodyFirstMismatchIndex",
];

export const MARKER_REPRESENTATION_BOOLEAN_KEYS = [
  "markerInnerTextExact",
  "markerTextContentExact",
  "markerInnerTextAttemptExact",
  "markerTextContentAttemptExact",
  "richBodyRebuildSucceeded",
  "richBodyExact",
];

function commonPrefixLength(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return 0;
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

function commonSuffixLength(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return 0;
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i += 1;
  return i;
}

function lineCount(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  return text.split("\n").length;
}

function rawInnerTextOf(el) {
  if (!el) return "";
  const t = el.innerText;
  return typeof t === "string" ? t : "";
}

function rawTextContentOf(el) {
  if (!el) return "";
  const t = el.textContent;
  return typeof t === "string" ? t : "";
}

/**
 * True bounded BFS over descendants via children/childNodes only.
 * Visits at most maxCount nodes; never querySelectorAll("*").
 * Read-only: no mutation / scroll / focus / click.
 */
export function collectBoundedDescendants(root, maxCount) {
  const visited = [];
  if (!root || !Number.isFinite(maxCount) || maxCount <= 0) return visited;
  const queue = [];
  const pushChildren = (el) => {
    if (!el || visited.length >= maxCount) return;
    try {
      const kids = Array.isArray(el.children) ? el.children : null;
      if (kids && kids.length > 0) {
        for (let i = 0; i < kids.length && visited.length < maxCount; i += 1) {
          const child = kids[i];
          if (!child) continue;
          visited.push(child);
          queue.push(child);
        }
        return;
      }
      const nodes = el.childNodes;
      if (nodes && typeof nodes.length === "number") {
        for (let i = 0; i < nodes.length && visited.length < maxCount; i += 1) {
          const child = nodes[i];
          if (!child) continue;
          visited.push(child);
          queue.push(child);
        }
      }
    } catch {
      // read-only diagnostic; ignore host accessor faults
    }
  };

  pushChildren(root);
  while (queue.length > 0 && visited.length < maxCount) {
    const next = queue.shift();
    pushChildren(next);
  }
  return visited;
}

/**
 * Unique exact ATTEMPT-marker user candidate representation (read-only).
 * Numbers/booleans only. Never raw text / HTML / selectors.
 * Returns null when marker candidates are 0 or >1 (fail closed).
 */
export function buildMarkerRepresentationDiagnostic(input = {}) {
  const message = typeof input.message === "string" ? input.message : "";
  const attemptId = typeof input.attemptId === "string" ? input.attemptId : "";
  const turns = Array.isArray(input.turns) ? input.turns : [];
  const want = message ? normalizeCanonicalDomText(message) : "";
  if (!attemptId || turns.length === 0) return null;

  const markerIndices = [];
  for (let i = 0; i < turns.length; i += 1) {
    const text = typeof turns[i]?.text === "string" ? turns[i].text : "";
    if (hasExactAttemptMarker(text, attemptId).ok) markerIndices.push(i);
  }
  if (markerIndices.length !== 1) return null;

  const markerCandidateIndex = markerIndices[0];
  const turn = turns[markerCandidateIndex];
  const node = turn?.node ?? null;
  const normalized = typeof turn?.text === "string" ? turn.text : "";
  // Parent representations are independent — no fallback between innerText/textContent.
  const innerNorm = normalizeCanonicalDomText(rawInnerTextOf(node));
  const textNorm = normalizeCanonicalDomText(rawTextContentOf(node));

  const maxDesc = TURN_DIAGNOSTIC_LIMITS.maxDescendantsScanned;
  const descendants = collectBoundedDescendants(node, maxDesc);
  let exactInnerTextDescendantCount = 0;
  let exactTextContentDescendantCount = 0;
  let attemptMarkerDescendantCount = 0;
  for (const d of descendants) {
    // Independent representations: missing innerText must not borrow textContent.
    const dInner = normalizeCanonicalDomText(rawInnerTextOf(d));
    const dText = normalizeCanonicalDomText(rawTextContentOf(d));
    if (want && dInner === want) exactInnerTextDescendantCount += 1;
    if (want && dText === want) exactTextContentDescendantCount += 1;
    if (
      hasExactAttemptMarker(dInner, attemptId).ok
      || hasExactAttemptMarker(dText, attemptId).ok
    ) {
      attemptMarkerDescendantCount += 1;
    }
  }

  const richStats = {};
  let richBody = null;
  try {
    richBody = readRichTextUserBody(node, richStats);
  } catch {
    // 诊断读取故障不影响既有匹配结果。
    richStats.richBodyReasonCode = 15;
  }
  if (richBody !== null) {
    Object.assign(richStats, {
      richBodyRebuildSucceeded: true,
      richBodyExact: want.length > 0 && richBody === want,
      richBodyRebuiltLength: richBody.length,
      richBodyRebuiltLineCount: lineCount(richBody),
      richBodyLengthDelta: richBody.length - want.length,
      richBodyFirstMismatchIndex: richBody === want ? -1 : commonPrefixLength(richBody, want),
    });
  }

  return {
    ...richStats,
    markerCandidateIndex,
    markerCandidateNormalizedLength: normalized.length,
    markerInnerTextLength: innerNorm.length,
    markerTextContentLength: textNorm.length,
    markerInnerTextExact: want.length > 0 && innerNorm === want,
    markerTextContentExact: want.length > 0 && textNorm === want,
    markerInnerTextAttemptExact: hasExactAttemptMarker(innerNorm, attemptId).ok === true,
    markerTextContentAttemptExact: hasExactAttemptMarker(textNorm, attemptId).ok === true,
    targetLineCount: want.length > 0 ? lineCount(want) : null,
    markerInnerTextLineCount: lineCount(innerNorm),
    markerTextContentLineCount: lineCount(textNorm),
    innerLengthDelta: innerNorm.length - want.length,
    textContentLengthDelta: textNorm.length - want.length,
    innerCommonPrefixLength: commonPrefixLength(innerNorm, want),
    innerCommonSuffixLength: commonSuffixLength(innerNorm, want),
    textCommonPrefixLength: commonPrefixLength(textNorm, want),
    textCommonSuffixLength: commonSuffixLength(textNorm, want),
    descendantScannedCount: descendants.length,
    exactInnerTextDescendantCount,
    exactTextContentDescendantCount,
    attemptMarkerDescendantCount,
  };
}

/** Allowlist only number/boolean. Never raw text / DOM / credentials. */
export function sanitizeMarkerRepresentation(rep) {
  if (!rep || typeof rep !== "object") return null;
  const out = {};
  for (const key of MARKER_REPRESENTATION_NUMERIC_KEYS) {
    if (Number.isFinite(rep[key])) out[key] = rep[key];
  }
  for (const key of MARKER_REPRESENTATION_BOOLEAN_KEYS) {
    if (typeof rep[key] === "boolean") out[key] = rep[key];
  }
  const code = rep.richBodyReasonCode;
  if (Number.isInteger(code) && code >= 0 && code <= 15) out.richBodyReasonCode = code;
  return Object.keys(out).length ? out : null;
}

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
    representation: buildMarkerRepresentationDiagnostic({
      message,
      attemptId,
      turns,
    }),
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
    "representation",
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
    if (key === "representation") {
      const rep = sanitizeMarkerRepresentation(value);
      if (rep) out.representation = rep;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Bounded exact visible-body proof inside one user-turn node.
 * Authority is descendant.innerText only (normalizeCanonicalDomText full equality).
 * textContent is diagnostic-only and never a match authority.
 * Parent turn must already have exact ATTEMPT marker in its visible text.
 */
export function hasExactVisibleBodyDescendant(node, want, attemptId) {
  if (!node || typeof want !== "string" || want.length === 0) return false;
  if (typeof attemptId !== "string" || attemptId.length === 0) return false;
  const descendants = collectBoundedDescendants(
    node,
    TURN_DIAGNOSTIC_LIMITS.maxDescendantsScanned,
  );
  for (const d of descendants) {
    const inner = normalizeCanonicalDomText(rawInnerTextOf(d));
    if (inner !== want) continue;
    if (!hasExactAttemptMarker(inner, attemptId).ok) continue;
    return true;
  }
  return false;
}

/**
 * Observed ChatGPT user shapes: rich P with text/SPAN/A/BR, or pre-wrap DIV
 * with direct text/CODE. Only the latter restores single inline backticks.
 * A link's empty block favicon can add a layout newline to P.innerText; outer
 * collapse controls add more text. Reconstruct ONLY this explicit body shape,
 * preserving every text character and BR. No whitespace folding, href-derived
 * text, hidden-text fallback or general Markdown interpretation.
 */
function readRichTextUserBody(bubble, stats = null) {
  // 只记录固定数字原因码；异常消息和 DOM 内容不进入诊断，码表见 troubleshooting。
  if (stats) Object.assign(stats, {
    richBodyWrapperScannedCount: 0, richBodyCount: 0, richBodyNodeScannedCount: 0,
    richBodyReasonCode: 15, richBodyRebuildSucceeded: false, richBodyExact: false,
  });
  const reject = (code) => {
    if (stats) stats.richBodyReasonCode = code;
    return null;
  };
  const fail = (code) => {
    reject(code);
    throw Error("rich_body_rejected");
  };
  if (bubble?.getAttribute?.("data-user-message-bubble") !== "true") return reject(1);
  const view = bubble.ownerDocument?.defaultView;
  if (typeof view?.getComputedStyle !== "function") return reject(2);
  const visible = (element) => {
    const style = view.getComputedStyle(element);
    return style.display !== "none" && style.visibility === "visible"
      && Number(style.opacity) !== 0;
  };
  try {
    // Search wrappers only, pruning rich bodies. Exhaust the bounded search so
    // a second body cannot be silently ignored. Existing 64-node scan stays put.
    const pending = [bubble], bodies = [];
    let searched = 0;
    while (pending.length) {
      if (++searched > 64) return reject(3);
      if (stats) stats.richBodyWrapperScannedCount = searched;
      const element = pending.pop();
      const children = element.children;
      if (!children) return reject(4);
      const plainBody = element.tagName === "DIV"
        && element.classList?.contains("whitespace-pre-wrap")
        && children.length <= 128
        && Array.from(children).every(child => child.tagName === "CODE");
      if (element.classList?.contains("rich-text-user-turn") || plainBody) {
        bodies.push(element);
        if (stats) stats.richBodyCount = bodies.length;
        continue;
      }
      if (searched + pending.length + children.length > 64) return reject(3);
      for (const child of children) pending.push(child);
    }
    if (bodies.length !== 1) return reject(5);
    const body = bodies[0];
    const plainBody = !body.classList.contains("rich-text-user-turn");
    if (body.tagName !== "DIV" || (!plainBody && (body.childNodes.length !== 1
      || body.firstChild?.tagName !== "P"))) return reject(6);
    for (let parent = body; parent; parent = parent.parentElement) {
      if (!visible(parent)) return reject(7);
      if (parent === bubble) break;
    }
    // Separate, bounded grammar walk: real incident body has 65 nodes, including
    // text nodes and the empty favicon. Unknown/oversized trees fail closed.
    let remaining = 128;
    const read = (node, inLink = false) => {
      if (--remaining < 0) fail(8);
      if (stats) stats.richBodyNodeScannedCount = 128 - remaining;
      if (node.nodeType === 3) return node.nodeValue;
      if (node.nodeType !== 1) fail(9);
      const tag = node.tagName.toUpperCase();
      // A link's decorative subtree is allowed only when it has no text.
      if (inLink && rawTextContentOf(node) === "" && ["SPAN", "SVG", "PATH", "IMG"].includes(tag)) {
        for (const child of node.childNodes) read(child, true);
        return "";
      }
      if (!visible(node)) fail(7);
      const style = view.getComputedStyle(node);
      const display = style.display;
      if (style.textTransform !== "none") fail(10);
      if (node.childNodes.length > remaining) fail(8);
      if (plainBody) {
        if (node === body) {
          if (display !== "block" || style.whiteSpace !== "pre-wrap") fail(13);
          if (rawInnerTextOf(node) !== rawTextContentOf(node)) fail(14);
          return Array.from(node.childNodes, child => read(child)).join("");
        }
        if (tag !== "CODE" || display !== "inline") fail(13);
        const text = rawInnerTextOf(node);
        if (!text || text.includes("`") || LINE_BREAKS.test(text)
          || text !== rawTextContentOf(node)) fail(14);
        if (Array.from(node.childNodes).some(child => child.nodeType !== 3)) fail(9);
        return "`" + Array.from(node.childNodes, child => read(child)).join("") + "`";
      }
      if (tag === "BR" && !inLink && node.childNodes.length === 0 && display === "inline") return "\n";
      if (tag === "A" && !inLink && display === "inline"
        && /(?:^|\s)ExternalMarkdownLink-\S+/.test(node.className)) {
        const text = rawInnerTextOf(node);
        if (!text || text !== rawTextContentOf(node) || LINE_BREAKS.test(text)) fail(11);
        const rebuilt = Array.from(node.childNodes, child => read(child, true)).join("");
        if (rebuilt !== text) fail(12);
        return text;
      }
      if (!((tag === "P" && node === body.firstChild && display === "block")
        || (tag === "SPAN" && display === "inline"))) fail(13);
      if (tag === "SPAN" && rawInnerTextOf(node) !== rawTextContentOf(node)) fail(14);
      return Array.from(node.childNodes, child => read(child, inLink)).join("");
    };
    const rebuilt = normalizeCanonicalDomText(read(plainBody ? body : body.firstChild));
    if (stats) stats.richBodyReasonCode = 0;
    return rebuilt;
  } catch {
    return null;
  }
}

/**
 * Canonical message-body match for one USER turn.
 * 1) Parent exact fast path: turn.text === want + exact ATTEMPT.
 * 2) Else bounded fallback: parent visible text must have exact ATTEMPT marker,
 *    and some descendant innerText is canonical-exact (byte/canonical equality only).
 * 3) Known modern USER body may reconstruct BRs or inline CODE backticks;
 *    the whole reconstructed body and ATTEMPT marker must still match exactly.
 * Ambiguity is counted per USER TURN, never per descendant.
 */
export function canonicalTurnBodyMatch(turn, want, attemptId) {
  if (!turn || typeof want !== "string" || want.length === 0) return false;
  if (typeof turn.text !== "string") return false;

  // Parent exact fast path (unchanged).
  if (turn.text === want && hasExactAttemptMarker(turn.text, attemptId).ok) {
    return true;
  }

  // Parent visible representation must carry the exact ATTEMPT marker first.
  if (!hasExactAttemptMarker(turn.text, attemptId).ok) return false;

  if (hasExactVisibleBodyDescendant(turn.node, want, attemptId)) return true;
  const richBody = readRichTextUserBody(turn.node);
  return richBody === want && hasExactAttemptMarker(richBody, attemptId).ok;
}

/**
 * Find exactly one new (or uniquely matching) USER turn whose
 * normalized body equals the canonical message with exact ATTEMPT_ID line.
 *
 * Parent exact, bounded descendant exact, or known rich USER body reconstruction.
 * Zero => not observed. Multiple USER turns => ambiguous fail closed.
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
    if (!canonicalTurnBodyMatch(turn, want, attemptId)) return false;
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
