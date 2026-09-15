/**
 * Read-only ChatGPT DOM adapter (E1b1).
 * Pure functions over a Document-like object for unit tests; no mutations.
 * Unknown is always unsafe.
 */

/**
 * @typedef {Object} DomSafety
 * @property {"absent"|"empty"|"dirty"|"unknown"} composer
 * @property {"idle"|"generating"|"unknown"} generation
 * @property {boolean} routeValid
 * @property {boolean} adapterSupported
 * @property {boolean} safe
 * @property {string[]} reasons
 */

/** @returns {DomSafety} */
export function unsafeDomSafety(reason) {
  return {
    composer: "unknown",
    generation: "unknown",
    routeValid: false,
    adapterSupported: false,
    safe: false,
    reasons: [reason],
  };
}

function textOf(el) {
  if (!el) return "";
  if (typeof el.value === "string") return el.value;
  const t = el.textContent ?? "";
  return typeof t === "string" ? t : "";
}

function query(root, selector) {
  try {
    return root.querySelector(selector);
  } catch {
    return null;
  }
}

function isDisabled(btn) {
  if (!btn) return false;
  if (btn.disabled === true) return true;
  const aria = btn.getAttribute?.("aria-disabled");
  if (aria === "true") return true;
  if (btn.hasAttribute?.("disabled")) return true;
  return false;
}

/**
 * Observe composer / generation without mutation.
 * Generation requires positive evidence:
 * - generating: stop affordance present
 * - idle: send control present and not disabled, and no stop
 * - otherwise: unknown (unsafe)
 */
export function observeChatGptSafety(doc, opts = {}) {
  const routeValid = opts.routeValid !== false;
  const reasons = [];
  if (!doc || typeof doc.querySelector !== "function") {
    return unsafeDomSafety("no_document");
  }

  const proseMirror =
    query(doc, 'div.ProseMirror[contenteditable="true"]')
    || query(doc, 'div[contenteditable="true"][data-placeholder]')
    || query(doc, "#prompt-textarea")
    || query(doc, "div.ProseMirror");
  const textarea =
    query(doc, 'textarea[data-id="root"]')
    || query(doc, "form textarea")
    || query(doc, "textarea");

  let composer = "unknown";
  const editor = proseMirror || textarea;
  if (!editor) {
    const body = query(doc, "body");
    if (!body) return unsafeDomSafety("no_body");
    const shell =
      query(doc, "main")
      || query(doc, '[data-testid="conversation-turn"]')
      || query(doc, "nav");
    if (shell) {
      composer = "absent";
      reasons.push("composer_absent");
    } else {
      return unsafeDomSafety("unsupported_dom");
    }
  } else {
    const text = textOf(editor).replace(/ /g, " ").trim();
    if (text.length === 0) composer = "empty";
    else {
      composer = "dirty";
      reasons.push("composer_dirty");
    }
  }

  // Positive evidence only. Absence of stop is NOT idle.
  let generation = "unknown";
  const stopBtn =
    query(doc, 'button[aria-label="Stop generating"]')
    || query(doc, 'button[data-testid="stop-button"]')
    || query(doc, 'button[aria-label*="Stop"]')
    || query(doc, 'div.streaming button[aria-label*="Stop"]');
  const sendBtn =
    query(doc, 'button[data-testid="send-button"]')
    || query(doc, 'button[aria-label="Send prompt"]')
    || query(doc, 'button[aria-label*="Send"]');

  if (stopBtn) {
    generation = "generating";
    reasons.push("generating");
  } else if (sendBtn && !isDisabled(sendBtn)) {
    generation = "idle";
  } else {
    generation = "unknown";
    reasons.push("generation_unknown");
  }

  if (!routeValid) reasons.push("route_invalid");

  const adapterSupported = composer !== "unknown" && generation !== "unknown";
  if (!adapterSupported && !reasons.includes("unsupported_dom")) {
    reasons.push("adapter_unknown");
  }

  const safe =
    adapterSupported
    && routeValid
    && composer === "empty"
    && generation === "idle";

  if (!safe && reasons.length === 0) reasons.push("unsafe");

  return {
    composer,
    generation,
    routeValid,
    adapterSupported,
    safe,
    reasons,
  };
}

/** Pure helper for tests. */
export function fakeDom({
  composerText = "",
  hasComposer = true,
  stop = false,
  hasBody = true,
  sendEnabled = false,
} = {}) {
  const nodes = {};
  if (hasBody) nodes.body = { textContent: "" };
  if (hasComposer) {
    nodes.prose = { textContent: composerText, value: composerText };
  }
  if (stop) nodes.stop = { ariaLabel: "Stop generating" };
  if (sendEnabled) {
    nodes.send = {
      getAttribute: () => null,
      hasAttribute: () => false,
      disabled: false,
      testId: "send-button",
    };
  }
  return {
    querySelector(selector) {
      if (!hasBody && !hasComposer) return null;
      if (selector.includes("Stop") || selector.includes("stop-button")) {
        return stop ? nodes.stop : null;
      }
      if (
        selector.includes("ProseMirror")
        || selector === "#prompt-textarea"
        || selector.includes("contenteditable")
      ) {
        return hasComposer ? nodes.prose : null;
      }
      if (selector === "body") return nodes.body ?? null;
      if (
        selector === "main"
        || selector.includes("conversation-turn")
        || selector === "nav"
      ) {
        return hasComposer || hasBody ? {} : null;
      }
      if (selector.includes("send-button") || selector.includes("Send prompt") || selector.includes('aria-label*="Send"')) {
        return sendEnabled ? nodes.send : null;
      }
      return null;
    },
  };
}
