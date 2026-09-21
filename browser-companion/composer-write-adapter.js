/**
 * E1b3d2a write-only composer capability.
 * Browser-safe ESM. Focus / Selection / Range / execCommand / input event only.
 * Forbidden here: native Send click, Chrome API, fetch, production journal, ack path.
 */

import {
  resolveChatGptComposer,
  resolveChatGptAction,
  normalizeCanonicalDomText,
} from "./dom-adapter.js";
import { WRITE_PROBE_MESSAGE, resolveMutationCanonicalRoute } from "./write-probe.js";
import { areChatgptConversationRoutesEquivalent } from "./route-esm.js";

/**
 * @typedef {Object} CapabilityResult
 * @property {boolean} ok
 * @property {string} [reason]
 * @property {"contenteditable"|"textarea"|null} [editorKind]
 */

function fail(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

function ok(extra = {}) {
  return { ok: true, ...extra };
}

/**
 * Canonical composer text reader — single semantic source for write/verify/
 * future dispatch exact-text fence (E1b3d2b / E1b3d3).
 *
 * Real Edge 2026-09-16: ProseMirror multiline is N direct <p> blocks;
 * join("\n") restores exact message including terminal LF from trailing empty P.
 * Empty final P is preserved. Non-P block structure fails closed.
 *
 * @returns {{ ok: true, text: string, representation: "textarea_value"|"prosemirror_p_blocks"|"text_content" }
 *   | { ok: false, reason: "composer_missing"|"composer_text_structure_unknown" }}
 */
export function readCanonicalComposerText(editor) {
  if (!editor) return { ok: false, reason: "composer_missing" };

  let tag = "";
  try {
    tag = String(editor.tagName || "").toLowerCase();
  } catch {
    tag = "";
  }
  let hasTextContent = false;
  try {
    hasTextContent = typeof editor.textContent === "string";
  } catch {
    hasTextContent = false;
  }

  // textarea / input-like (real DOM tag, or value-primary mock without textContent).
  if (typeof editor.value === "string") {
    if (tag === "textarea" || tag === "input") {
      return {
        ok: true,
        text: normalizeCanonicalDomText(editor.value),
        representation: "textarea_value",
      };
    }
    if (!hasTextContent) {
      let kidsLen = 0;
      try {
        kidsLen = editor.children?.length ?? 0;
      } catch {
        kidsLen = 0;
      }
      if (!kidsLen) {
        return {
          ok: true,
          text: normalizeCanonicalDomText(editor.value),
          representation: "textarea_value",
        };
      }
    }
  }

  let kids = null;
  try {
    kids = editor.children;
  } catch {
    kids = null;
  }
  if (kids && typeof kids.length === "number" && kids.length > 0) {
    const parts = [];
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      const childTag = String(child?.tagName || "").toLowerCase();
      if (childTag !== "p") {
        return { ok: false, reason: "composer_text_structure_unknown" };
      }
      const t = child.textContent;
      parts.push(typeof t === "string" ? t : "");
    }
    // N P → N-1 LF joins; empty final P yields trailing LF; one empty P → "".
    const text = normalizeCanonicalDomText(parts.join("\n"));
    return { ok: true, text, representation: "prosemirror_p_blocks" };
  }

  // No element children: simple single-text representation.
  if (hasTextContent) {
    try {
      const t = editor.textContent;
      return { ok: true, text: normalizeCanonicalDomText(t), representation: "text_content" };
    } catch {
      /* fall through */
    }
  }
  return { ok: false, reason: "composer_text_structure_unknown" };
}

/**
 * Pre-write eligibility (empty composer).
 * Real Edge: empty composer exposes idle voice control, NOT send-button.
 * Accepts kind idle (enabled) or enabled send; rejects stop/unknown/disabled.
 * Unknown block structure fails closed (never parent-textContent empty guess).
 */
export function inspectComposerWriteCapability(doc, opts = {}) {
  const routeValid = opts.routeValid === true;
  if (!routeValid) return fail("route_invalid");
  if (!doc || typeof doc.querySelector !== "function") return fail("composer_missing");

  const { editor, kind, evidence } = resolveChatGptComposer(doc);
  if (!editor) return fail("composer_missing");

  const read = readCanonicalComposerText(editor);
  if (!read.ok) {
    return fail(read.reason, { editorKind: kind, composerEvidence: evidence ?? null });
  }
  const normalized = read.text;
  if (normalized.replace(/ /g, " ").trim().length > 0) {
    return fail("composer_dirty", {
      editorKind: kind,
      composerEvidence: evidence ?? null,
      representation: read.representation,
    });
  }

  const action = resolveChatGptAction(doc, editor);
  if (action.kind === "stop") {
    return fail("generation_active", { editorKind: kind, composerEvidence: evidence ?? null });
  }
  if (action.kind === "unknown") {
    return fail("generation_unknown", { editorKind: kind, composerEvidence: evidence ?? null });
  }
  if (!action.enabled) {
    return fail("send_disabled", { editorKind: kind, composerEvidence: evidence ?? null });
  }
  if (action.kind !== "idle" && action.kind !== "send") {
    return fail("send_action_unknown", { editorKind: kind, composerEvidence: evidence ?? null });
  }
  return ok({
    editorKind: kind,
    editor,
    action,
    composerEvidence: evidence ?? null,
    representation: read.representation,
  });
}

function setNativeValue(editor, value, win) {
  const proto =
    (win.HTMLTextAreaElement && win.HTMLTextAreaElement.prototype)
    || (win.HTMLInputElement && win.HTMLInputElement.prototype)
    || null;
  const desc = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
  if (desc && typeof desc.set === "function") {
    desc.set.call(editor, value);
    return "native_setter";
  }
  editor.value = value;
  return "direct_value";
}

/**
 * Synchronous last-moment mutation fence.
 * false / throw → fail closed. Never Promise. No page logic between guard and write.
 */
function runMutationGuard(mutationGuard) {
  if (typeof mutationGuard !== "function") return true;
  try {
    return mutationGuard() !== false;
  } catch {
    return false;
  }
}

/**
 * Bounded fixed-probe readback diagnostic. Never returns raw composer text,
 * innerHTML/outerHTML, DOM nodes, or React props. Only lengths/flags/tags.
 */
function countNewlines(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n += 1;
  return n;
}

/**
 * Bounded fixed-probe readback diagnostic. Never returns raw composer text,
 * innerHTML/outerHTML, DOM nodes, or React props. Only lengths/flags/tags.
 * Adds canonical reader summary (representation + exact) without raw text.
 */
export function buildProbeReadback(editor, expected) {
  if (!editor) return null;
  const want = normalizeCanonicalDomText(typeof expected === "string" ? expected : "");
  const wantNoFinalLf = want.endsWith("\n") ? want.slice(0, -1) : want;

  let textContentRaw = "";
  try {
    const t = editor.textContent;
    textContentRaw = typeof t === "string" ? t : "";
  } catch {
    textContentRaw = "";
  }
  const textNorm = normalizeCanonicalDomText(textContentRaw);
  const textContent = {
    length: textNorm.length,
    newlineCount: countNewlines(textNorm),
    exact: textNorm === want,
    exactWithoutFinalLf: textNorm === wantNoFinalLf,
  };

  let innerText = { available: false, length: 0, newlineCount: 0, exact: false, exactWithoutFinalLf: false };
  try {
    if (typeof editor.innerText === "string") {
      const it = normalizeCanonicalDomText(editor.innerText);
      innerText = {
        available: true,
        length: it.length,
        newlineCount: countNewlines(it),
        exact: it === want,
        exactWithoutFinalLf: it === wantNoFinalLf,
      };
    }
  } catch {
    innerText = { available: false, length: 0, newlineCount: 0, exact: false, exactWithoutFinalLf: false };
  }

  const childBlocks = {
    count: 0,
    firstTags: [],
    childTextLengths: [],
    joinedWithLfExact: false,
    joinedWithLfExactWithoutFinalLf: false,
  };
  try {
    const kids = editor.children;
    if (kids && typeof kids.length === "number") {
      childBlocks.count = kids.length;
      const limit = Math.min(kids.length, 12);
      const parts = [];
      for (let i = 0; i < limit; i++) {
        const c = kids[i];
        const tag = String(c?.tagName || "").toUpperCase();
        childBlocks.firstTags.push(tag || "?");
        const ct = typeof c?.textContent === "string" ? c.textContent : "";
        childBlocks.childTextLengths.push(ct.length);
        parts.push(ct);
      }
      const joined = normalizeCanonicalDomText(parts.join("\n"));
      childBlocks.joinedWithLfExact = joined === want;
      childBlocks.joinedWithLfExactWithoutFinalLf = joined === wantNoFinalLf;
    }
  } catch {
    /* ignore */
  }

  let canonical = { representation: null, exact: false, ok: false };
  try {
    const read = readCanonicalComposerText(editor);
    if (read.ok) {
      canonical = {
        representation: read.representation,
        exact: read.text === want,
        ok: true,
      };
    } else {
      canonical = { representation: null, exact: false, ok: false, reason: read.reason };
    }
  } catch {
    /* ignore */
  }

  return { textContent, innerText, childBlocks, canonical };
}

/**
 * Write canonical message into textarea/input-like composer.
 * No Send during write. Fail closed if post-write text mismatches.
 * Optional opts.mutationGuard is a sync () => boolean checked immediately
 * before the actual text mutation (native setter / insertText).
 *
 * Outcomes:
 * - pre-mutation failure: mutationAttempted=false, wrote=false
 * - post-execCommand/setter mismatch: mutationAttempted=true; wrote=true iff
 *   readback is non-empty (composer changed from empty preflight).
 */
export function writeCanonicalMessage(doc, message, opts = {}) {
  const pre = inspectComposerWriteCapability(doc, opts);
  if (!pre.ok) {
    return fail(pre.reason, {
      editorKind: pre.editorKind ?? null,
      composerEvidence: pre.composerEvidence ?? null,
      mutationAttempted: false,
      wrote: false,
      verified: false,
    });
  }
  const editor = pre.editor;
  if (pre.editorKind !== "textarea") {
    return writeContentEditable(doc, message, opts, pre);
  }

  const win = doc.defaultView || globalThis;
  try {
    // Last sync fence before native value mutation.
    if (!runMutationGuard(opts.mutationGuard)) {
      return fail("write_probe_route_drift", {
        editorKind: "textarea",
        wrote: false,
        mutationAttempted: false,
        verified: false,
      });
    }
    const setter = setNativeValue(editor, message, win);
    // Native setter executed → mutation was attempted.
    const EventCtor = win.Event || Event;
    editor.dispatchEvent(new EventCtor("input", { bubbles: true }));
    const afterRead = readCanonicalComposerText(editor);
    const after = afterRead.ok ? afterRead.text : "";
    const want = normalizeCanonicalDomText(message);
    if (!afterRead.ok || after !== want) {
      return fail(!afterRead.ok ? afterRead.reason : "composer_write_mismatch", {
        editorKind: "textarea",
        setter,
        mutationAttempted: true,
        wrote: after.length > 0,
        verified: false,
        readback: buildProbeReadback(editor, message),
      });
    }
    return ok({
      editorKind: "textarea",
      setter,
      mutationAttempted: true,
      wrote: true,
      representation: afterRead.representation,
    });
  } catch (e) {
    return fail("composer_write_error", {
      editorKind: "textarea",
      mutationAttempted: true,
      wrote: false,
      verified: false,
      error: String(e?.message || e),
    });
  }
}

/**
 * Conservative contenteditable write via focused selection + insertText.
 * No blind textContent fallback. No Send.
 * mutationGuard runs immediately before execCommand — no await/timer/DOM between.
 */
function writeContentEditable(doc, message, opts, pre) {
  const editor = pre.editor;
  const win = doc.defaultView || globalThis;
  try {
    if (typeof editor.focus === "function") editor.focus();
    const sel = win.getSelection?.();
    const rangeFactory = doc.createRange?.bind(doc);
    if (!sel || !rangeFactory || typeof doc.execCommand !== "function") {
      return fail("editing_primitive_unavailable", {
        editorKind: "contenteditable",
        wrote: false,
        mutationAttempted: false,
        verified: false,
      });
    }
    const range = rangeFactory();
    if (typeof range.selectNodeContents === "function") {
      range.selectNodeContents(editor);
    } else {
      return fail("editing_primitive_unavailable", {
        editorKind: "contenteditable",
        wrote: false,
        mutationAttempted: false,
        verified: false,
      });
    }
    sel.removeAllRanges();
    sel.addRange(range);
    // Last sync fence before text mutation. Focus/selection already applied is allowed;
    // this stage forbids text write on a drifted route only.
    if (!runMutationGuard(opts.mutationGuard)) {
      return fail("write_probe_route_drift", {
        editorKind: "contenteditable",
        wrote: false,
        mutationAttempted: false,
        verified: false,
      });
    }
    const inserted = doc.execCommand("insertText", false, message);
    // execCommand invoked → mutation attempted (even if it returned false).
    const afterRead = readCanonicalComposerText(editor);
    const after = afterRead.ok ? afterRead.text : "";
    const want = normalizeCanonicalDomText(message);
    if (!inserted) {
      return fail("editing_primitive_unavailable", {
        editorKind: "contenteditable",
        mutationAttempted: true,
        wrote: after.length > 0,
        verified: false,
        readback: buildProbeReadback(editor, message),
      });
    }
    if (!afterRead.ok || after !== want) {
      return fail(!afterRead.ok ? afterRead.reason : "composer_write_mismatch", {
        editorKind: "contenteditable",
        mutationAttempted: true,
        // Preflight required empty composer; non-empty readback means text landed.
        wrote: after.length > 0,
        verified: false,
        readback: buildProbeReadback(editor, message),
      });
    }
    return ok({
      editorKind: "contenteditable",
      mutationAttempted: true,
      wrote: true,
      representation: afterRead.representation,
    });
  } catch (e) {
    return fail("composer_write_error", {
      editorKind: "contenteditable",
      mutationAttempted: true,
      wrote: false,
      verified: false,
      error: String(e?.message || e),
    });
  }
}

/** Verify composer still holds the exact canonical message. */
export function verifyCanonicalComposer(doc, message, opts = {}) {
  const { editor } = resolveChatGptComposer(doc);
  if (!editor) return fail("composer_missing");
  if (opts.routeValid === false) return fail("route_invalid");
  const read = readCanonicalComposerText(editor);
  if (!read.ok) return fail(read.reason);
  const after = read.text;
  const want = normalizeCanonicalDomText(message);
  if (after !== want) return fail("composer_text_mismatch");
  return ok({ representation: read.representation });
}

/**
 * E1b3d2a fixed write probe — zero Send, zero click.
 * Local CS fences only. Caller must already have exact document delivery.
 * Route authority is the companion shared parser (supports /c/<uuid> and
 * /g/g-.../c/<uuid>); never a second independent regex.
 *
 * @param {Document} doc
 * @param {{
 *   expectedRoute: string,
 *   expectedGeneration: number,
 *   locationHref?: string,
 *   getCurrentHref?: () => string,
 *   parseRoute?: (raw: string, opts: object) => { canonical: string },
 *   now?: number,
 * }} opts
 */
export function runWriteProbe(doc, opts = {}) {
  const expectedRoute = typeof opts.expectedRoute === "string" ? opts.expectedRoute : "";
  const expectedGeneration = opts.expectedGeneration;
  const parseRoute = typeof opts.parseRoute === "function" ? opts.parseRoute : undefined;
  const readHref = typeof opts.getCurrentHref === "function"
    ? opts.getCurrentHref
    : () => {
      try {
        if (typeof location !== "undefined" && location.href) return location.href;
      } catch {
        /* ignore */
      }
      // Tests / non-browser: fall back to the probe's expected starting href.
      return typeof opts.locationHref === "string" ? opts.locationHref : "";
    };
  const href = opts.locationHref ?? readHref();

  if (!expectedRoute) return fail("write_probe_route_missing", { wrote: false, mutationAttempted: false, verified: false });
  if (typeof expectedGeneration !== "number" || !Number.isFinite(expectedGeneration)) {
    return fail("write_probe_generation_missing", { wrote: false, mutationAttempted: false, verified: false });
  }

  // Shared parser must exist before any fence — fail closed, never loose fallback.
  const parserProbe = resolveMutationCanonicalRoute(expectedRoute, parseRoute);
  if (!parserProbe.ok && parserProbe.reason === "write_probe_route_parser_missing") {
    return fail("write_probe_route_parser_missing", { wrote: false, mutationAttempted: false, verified: false });
  }

  // A. generation fence (same CS generation counter).
  const localGeneration = typeof opts.localGeneration === "number"
    ? opts.localGeneration
    : expectedGeneration;
  if (localGeneration !== expectedGeneration) {
    return fail("write_probe_generation_mismatch", { wrote: false, mutationAttempted: false, verified: false });
  }

  // B. current route exact match via shared parser.
  const initial = resolveMutationCanonicalRoute(href, parseRoute);
  if (!initial.ok) {
    return fail(initial.reason === "write_probe_route_parser_missing"
      ? "write_probe_route_parser_missing"
      : "write_probe_route_drift", { wrote: false, mutationAttempted: false, verified: false });
  }
  if (initial.canonical !== expectedRoute && !areChatgptConversationRoutesEquivalent(initial.canonical, expectedRoute)) {
    return fail("write_probe_route_drift", { wrote: false, mutationAttempted: false, verified: false });
  }

  // C. local preflight — do not trust SW-cached evidence.
  const pre = inspectComposerWriteCapability(doc, { routeValid: true });
  if (!pre.ok) {
    return fail(pre.reason, {
      editorKind: pre.editorKind ?? null,
      composerEvidence: pre.composerEvidence ?? null,
      wrote: false,
      mutationAttempted: false,
      verified: false,
    });
  }

  // D. TOCTOU final route check immediately before write (no await between B–write).
  let hrefNow = href;
  try {
    hrefNow = readHref() || href;
  } catch {
    hrefNow = href;
  }
  const prewrite = resolveMutationCanonicalRoute(hrefNow, parseRoute);
  if (!prewrite.ok || (prewrite.canonical !== expectedRoute && !areChatgptConversationRoutesEquivalent(prewrite.canonical, expectedRoute))) {
    return fail(prewrite.ok ? "write_probe_route_drift" : prewrite.reason, {
      wrote: false,
      mutationAttempted: false,
      verified: false,
    });
  }

  // E. Last-moment sync mutation fence: re-read href every call; never cached boolean.
  // Must pass into writeCanonicalMessage so it sits immediately before insertText/native setter.
  const mutationGuard = () => {
    let current = "";
    try {
      current = readHref();
    } catch {
      return false;
    }
    const r = resolveMutationCanonicalRoute(current, parseRoute);
    return r.ok === true && (r.canonical === expectedRoute || areChatgptConversationRoutesEquivalent(r.canonical, expectedRoute));
  };

  const write = writeCanonicalMessage(doc, WRITE_PROBE_MESSAGE, {
    routeValid: true,
    mutationGuard,
  });
  if (!write.ok) {
    return fail(write.reason, {
      wrote: write.wrote === true,
      verified: write.verified === true,
      mutationAttempted: write.mutationAttempted === true,
      editorKind: write.editorKind ?? pre.editorKind ?? null,
      composerEvidence: pre.composerEvidence ?? null,
      readback: write.readback ?? null,
      mode: "write_probe_no_send",
      noSend: true,
    });
  }

  const verify = verifyCanonicalComposer(doc, WRITE_PROBE_MESSAGE, { routeValid: true });
  const generationAfter = localGeneration; // CS generation does not change on write-only probe.
  const readback = buildProbeReadback(
    resolveChatGptComposer(doc).editor,
    WRITE_PROBE_MESSAGE,
  );

  return {
    ok: verify.ok === true,
    mode: "write_probe_no_send",
    reason: verify.ok ? undefined : (verify.reason || "write_probe_verify_failed"),
    wrote: true,
    verified: verify.ok === true,
    mutationAttempted: true,
    canonicalRoute: expectedRoute,
    generation: generationAfter,
    editorKind: write.editorKind ?? pre.editorKind ?? null,
    composerEvidence: pre.composerEvidence ?? null,
    noSend: true,
    message: WRITE_PROBE_MESSAGE,
    readback,
  };
}
