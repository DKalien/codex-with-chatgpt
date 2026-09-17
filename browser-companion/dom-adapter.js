/**
 * Read-only ChatGPT DOM adapter (E1b1/E1b2/E1b3b shared targets).
 * Pure functions over a Document-like object for unit tests; no mutations.
 * Unknown is always unsafe.
 *
 * E1b3b: send targeting MUST use resolveChatGptComposer / resolveChatGptAction
 * so classification cannot drift from observeChatGptSafety.
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

function hasClass(el, name) {
  return new RegExp(`(?:^|\\s)${name}(?:\\s|$)`).test(String(el?.className || ""));
}

/**
 * Strict DOM-text normalization for canonical C2C comparison.
 * Only browser representation differences: CRLF/CR→LF, NBSP→space.
 * Does NOT collapse whitespace or trim.
 */
export function normalizeCanonicalDomText(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ");
}

/** Bounded scan cap for generic composer fallbacks (Writing Block exclusion). */
const COMPOSER_FALLBACK_MAX_CANDIDATES = 16;

/**
 * True when editor sits inside a known embedded (non-primary) editor shell.
 * Real Edge 2026-09-16: Writing Block ProseMirror was selected instead of #prompt-textarea.
 */
export function isExcludedEmbeddedEditor(editor) {
  if (!editor || typeof editor.closest !== "function") return false;
  try {
    if (editor.closest('[data-testid="writing-block-container"]')) return true;
  } catch {
    /* ignore */
  }
  try {
    if (editor.closest('[id^="writing-block-"]')) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function editorKindOf(el) {
  if (!el) return "unknown";
  try {
    const tag = String(el.tagName || "").toLowerCase();
    if (tag === "textarea") return "textarea";
    const ce = el.getAttribute?.("contenteditable");
    if (ce === "true" || ce === "") return "contenteditable";
    if (el.isContentEditable === true) return "contenteditable";
    // Historical ProseMirror / contenteditable shells selected without attribute echo.
    if (tag === "div" || tag === "p") return "contenteditable";
  } catch {
    /* ignore */
  }
  return "unknown";
}

function composerResult(editor, evidence, kindOverride) {
  if (!editor) return { editor: null, kind: "unknown", form: null, evidence: null };
  let form = null;
  try {
    form = typeof editor.closest === "function" ? editor.closest("form") : null;
  } catch {
    form = null;
  }
  const kind = kindOverride || editorKindOf(editor);
  return { editor, kind, form, evidence };
}

/**
 * First non-excluded match for a generic selector.
 * Uses bounded querySelectorAll so Writing Block can be skipped without
 * treating "first hit excluded" as composer_missing when a later candidate exists.
 */
function firstEligibleFallback(doc, selector) {
  let nodes = [];
  try {
    if (typeof doc.querySelectorAll === "function") {
      const list = doc.querySelectorAll(selector);
      if (list && typeof list.length === "number") nodes = list;
    }
  } catch {
    nodes = [];
  }
  if ((!nodes || nodes.length === 0) && typeof doc.querySelector === "function") {
    try {
      const one = doc.querySelector(selector);
      if (one) nodes = [one];
    } catch {
      nodes = [];
    }
  }
  if (!nodes || typeof nodes.length !== "number") return null;
  const limit = Math.min(nodes.length, COMPOSER_FALLBACK_MAX_CANDIDATES);
  for (let i = 0; i < limit; i++) {
    const el = nodes[i];
    if (!el) continue;
    try {
      if (isExcludedEmbeddedEditor(el)) continue;
      return el;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Resolve primary ChatGPT composer editor.
 * E1b3d1 identity order (real Edge 2026-09-16): generic ProseMirror no longer
 * outranks #prompt-textarea; Writing Block embedded editors are excluded from fallbacks.
 *
 * evidence:
 * - prompt_textarea | textarea_root
 * - fallback_prosemirror | fallback_placeholder | fallback_textarea
 * - null when missing
 * @returns {{ editor: object|null, kind: "contenteditable"|"textarea"|"unknown", form: object|null, evidence: string|null }}
 */
export function resolveChatGptComposer(doc) {
  if (!doc || typeof doc.querySelector !== "function") {
    return { editor: null, kind: "unknown", form: null, evidence: null };
  }

  const promptTextarea = query(doc, "#prompt-textarea");
  if (promptTextarea) return composerResult(promptTextarea, "prompt_textarea");

  const rootTextarea = query(doc, 'textarea[data-id="root"]');
  if (rootTextarea) return composerResult(rootTextarea, "textarea_root", "textarea");

  const prose = firstEligibleFallback(doc, 'div.ProseMirror[contenteditable="true"]');
  if (prose) return composerResult(prose, "fallback_prosemirror", "contenteditable");

  const placeholder = firstEligibleFallback(doc, 'div[contenteditable="true"][data-placeholder"]');
  if (placeholder) return composerResult(placeholder, "fallback_placeholder", "contenteditable");

  const bareProse = firstEligibleFallback(doc, "div.ProseMirror");
  if (bareProse) return composerResult(bareProse, "fallback_prosemirror", "contenteditable");

  const formTextarea = firstEligibleFallback(doc, "form textarea");
  if (formTextarea) return composerResult(formTextarea, "fallback_textarea", "textarea");

  const anyTextarea = firstEligibleFallback(doc, "textarea");
  if (anyTextarea) return composerResult(anyTextarea, "fallback_textarea", "textarea");

  return { editor: null, kind: "unknown", form: null, evidence: null };
}

/** Hard caps for inventory DTO size / privacy. */
const INVENTORY_MAX_BUTTONS = 12;
const INVENTORY_ATTR_MAX = 200;
const INVENTORY_CLASS_MAX = 240;
const CONTAINER_MAX_ANCESTORS = 8;
const CONTAINER_MAX_CONTROL_CONTAINERS = 3;

function clampInventoryStr(value, max) {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function inventoryAttr(btn, name) {
  try {
    return btn.getAttribute?.(name) ?? null;
  } catch {
    return null;
  }
}

/**
 * Shared composer action-slot stop classification.
 * Priority on one button:
 * 1. exact Send identity (data-testid=send-button) → NOT stop
 * 2. explicit stop testid → stop
 * 3. class-only stop (composer-submit-btn without text-submit-btn-text) → stop
 */
function isComposerActionSlotStop(btn) {
  if (!btn) return false;
  let testid = null;
  try {
    testid = btn.getAttribute?.("data-testid") ?? null;
  } catch {
    testid = null;
  }
  // Exact structural Send identity must not be overridden by class-only stop heuristic.
  if (testid === "send-button") return false;
  if (testid === "stop-button" || testid === "composer-stop-button") return true;
  try {
    if (hasClass(btn, "composer-submit-btn") && !hasClass(btn, "text-submit-btn-text")) {
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Read-only match of current stop heuristics on one button.
 * Must stay consistent with isComposerActionSlotStop / resolveChatGptAction.
 */
function buttonMatchesKnownStop(btn, dataTestId, ariaLabelRaw) {
  // Exact Send identity is never a known stop candidate.
  if (dataTestId === "send-button") return false;
  if (dataTestId === "stop-button" || dataTestId === "composer-stop-button") return true;
  // Mirrors document-wide `button[aria-label*="Stop"]` (CSS attribute substring is case-sensitive).
  if (typeof ariaLabelRaw === "string" && ariaLabelRaw.includes("Stop")) return true;
  try {
    if (hasClass(btn, "composer-submit-btn") && !hasClass(btn, "text-submit-btn-text")) return true;
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Safe attribute summary of one form button. No text/HTML/value/nodes.
 */
function summarizeInventoryButton(btn, index) {
  const dataTestIdRaw = inventoryAttr(btn, "data-testid");
  const ariaLabelRaw = inventoryAttr(btn, "aria-label");
  const titleRaw = inventoryAttr(btn, "title");
  const typeRaw = inventoryAttr(btn, "type");
  const nameRaw = inventoryAttr(btn, "name");
  const roleRaw = inventoryAttr(btn, "role");
  const ariaDisabledRaw = inventoryAttr(btn, "aria-disabled");

  let className = null;
  try {
    const cn = btn.className;
    if (typeof cn === "string" && cn.length > 0) {
      className = cn.length > INVENTORY_CLASS_MAX ? cn.slice(0, INVENTORY_CLASS_MAX) : cn;
    }
  } catch {
    className = null;
  }

  let disabled = false;
  try {
    disabled = btn.disabled === true || btn.hasAttribute?.("disabled") === true;
  } catch {
    disabled = false;
  }

  const dataTestId = clampInventoryStr(dataTestIdRaw, INVENTORY_ATTR_MAX);
  const ariaLabel = clampInventoryStr(ariaLabelRaw, INVENTORY_ATTR_MAX);

  return {
    index,
    dataTestId,
    ariaLabel,
    title: clampInventoryStr(titleRaw, INVENTORY_ATTR_MAX),
    type: clampInventoryStr(typeRaw, INVENTORY_ATTR_MAX),
    name: clampInventoryStr(nameRaw, INVENTORY_ATTR_MAX),
    role: clampInventoryStr(roleRaw, INVENTORY_ATTR_MAX),
    className,
    disabled,
    ariaDisabled: ariaDisabledRaw === "true" ? true : ariaDisabledRaw === "false" ? false : null,
    matchesKnownSend: dataTestIdRaw === "send-button",
    matchesKnownActionSlot: hasClass(btn, "composer-submit-button-color"),
    matchesKnownStop: buttonMatchesKnownStop(btn, dataTestIdRaw, ariaLabelRaw),
  };
}

/**
 * E1b3d1 read-only inventory of buttons inside the active composer form.
 * Explains why resolveChatGptAction did/did not match — never changes classification.
 * @returns {{ formPresent: boolean, buttonCount: number, buttons: object[] }}
 */
export function inspectActiveComposerControls(doc, editor) {
  const empty = { formPresent: false, buttonCount: 0, buttons: [] };
  void doc; // form is resolved from editor only; no document-wide walk.
  if (!editor || typeof editor.closest !== "function") return empty;
  let form = null;
  try {
    form = editor.closest("form");
  } catch {
    return empty;
  }
  if (!form || typeof form.querySelectorAll !== "function") return empty;
  let nodes;
  try {
    nodes = form.querySelectorAll("button");
  } catch {
    return empty;
  }
  if (!nodes || typeof nodes.length !== "number") return empty;
  const total = nodes.length;
  const buttons = [];
  const limit = Math.min(total, INVENTORY_MAX_BUTTONS);
  for (let i = 0; i < limit; i++) {
    const btn = nodes[i];
    if (!btn) continue;
    try {
      buttons.push(summarizeInventoryButton(btn, i));
    } catch {
      /* skip hostile node */
    }
  }
  return { formPresent: true, buttonCount: total, buttons };
}

/**
 * Safe attribute summary of one editor ancestor container.
 * No text/HTML/value/nodes; no document-wide walk.
 */
function summarizeContainerAncestor(el, depth) {
  let tagName = null;
  try {
    const t = el.tagName;
    if (typeof t === "string" && t.length > 0) {
      tagName = t.toUpperCase();
    }
  } catch {
    tagName = null;
  }

  let className = null;
  try {
    const cn = el.className;
    if (typeof cn === "string" && cn.length > 0) {
      className = cn.length > INVENTORY_CLASS_MAX ? cn.slice(0, INVENTORY_CLASS_MAX) : cn;
    }
  } catch {
    className = null;
  }

  let descendantButtonCount = 0;
  try {
    if (typeof el.querySelectorAll === "function") {
      const nodes = el.querySelectorAll("button");
      if (nodes && typeof nodes.length === "number") {
        descendantButtonCount = nodes.length;
      }
    }
  } catch {
    descendantButtonCount = 0;
  }

  return {
    depth,
    tagName,
    id: clampInventoryStr(inventoryAttr(el, "id"), INVENTORY_ATTR_MAX),
    dataTestId: clampInventoryStr(inventoryAttr(el, "data-testid"), INVENTORY_ATTR_MAX),
    role: clampInventoryStr(inventoryAttr(el, "role"), INVENTORY_ATTR_MAX),
    className,
    descendantButtonCount,
  };
}

/**
 * Safe button summary inside an editor ancestor, plus structural relationship.
 */
function summarizeContainerButton(btn, index, ancestorDepth) {
  const base = summarizeInventoryButton(btn, index);
  return {
    ...base,
    ancestorDepth,
    insideEditorAncestor: true,
    distanceFromEditor: ancestorDepth,
  };
}

/**
 * E1b3d1 read-only ancestor + nearby-controls inventory.
 * Real Edge 2026-09-16: composer may not be inside a <form>; walk parentElement only.
 * Explains structure only — never classifies Send/Stop, never changes resolver.
 * @returns {{ ancestors: object[], controlContainers: object[] }}
 */
export function inspectComposerContainerInventory(doc, editor) {
  const empty = { ancestors: [], controlContainers: [] };
  void doc; // parentElement chain only; never document-wide button scan.
  if (!editor || typeof editor !== "object") return empty;
  let node = null;
  try {
    node = editor.parentElement;
  } catch {
    return empty;
  }
  if (!node) return empty;

  const ancestors = [];
  const controlContainers = [];
  let depth = 1;

  while (node && depth <= CONTAINER_MAX_ANCESTORS) {
    let summary;
    try {
      summary = summarizeContainerAncestor(node, depth);
    } catch {
      break;
    }
    ancestors.push(summary);

    if (
      summary.descendantButtonCount > 0
      && controlContainers.length < CONTAINER_MAX_CONTROL_CONTAINERS
      && typeof node.querySelectorAll === "function"
    ) {
      const buttons = [];
      try {
        const nodes = node.querySelectorAll("button");
        const limit = Math.min(nodes?.length ?? 0, INVENTORY_MAX_BUTTONS);
        for (let i = 0; i < limit; i++) {
          const btn = nodes[i];
          if (!btn) continue;
          try {
            buttons.push(summarizeContainerButton(btn, i, depth));
          } catch {
            /* skip hostile node */
          }
        }
      } catch {
        /* skip container if query fails */
      }
      controlContainers.push({
        depth,
        buttonCount: summary.descendantButtonCount,
        buttons,
      });
    }

    try {
      node = node.parentElement;
    } catch {
      break;
    }
    depth += 1;
  }

  return { ancestors, controlContainers };
}

/**
 * Safe attribute summary of a stop-shaped button (read-only, no HTML/nodes).
 * @returns {{ source: string, dataTestId: string|null, ariaLabel: string|null, className: string|null, insideComposerForm: boolean }|null}
 */
export function summarizeStopButtonEvidence(btn, source, insideComposerForm) {
  if (!btn) return null;
  let dataTestId = null;
  let ariaLabel = null;
  try {
    dataTestId = btn.getAttribute?.("data-testid") ?? null;
    ariaLabel = btn.getAttribute?.("aria-label") ?? null;
  } catch {
    dataTestId = null;
    ariaLabel = null;
  }
  const className = typeof btn.className === "string" && btn.className.length > 0
    ? btn.className.slice(0, 200)
    : null;
  return {
    source,
    dataTestId,
    ariaLabel,
    className,
    insideComposerForm: Boolean(insideComposerForm),
  };
}

/**
 * Read-only diagnostic: which stop evidence fired (document vs composer action slot).
 * Does not change resolveChatGptAction classification.
 */
export function inspectChatGptActionEvidence(doc, editor) {
  if (!doc || typeof doc.querySelector !== "function") {
    return {
      action: { kind: "unknown", enabled: false, evidence: null },
      stopEvidence: null,
      hasExactSendButton: false,
      inventory: { formPresent: false, buttonCount: 0, buttons: [] },
      containerInventory: { ancestors: [], controlContainers: [] },
    };
  }
  const action = resolveChatGptAction(doc, editor);
  const editorForm = editor && typeof editor.closest === "function"
    ? editor.closest("form")
    : null;
  const composerActionBtn = editorForm
    ? query(editorForm, "button.composer-submit-button-color")
    : null;
  const actionIsStop = isComposerActionSlotStop(composerActionBtn);

  let stopEvidence = null;
  const docStop =
    query(doc, 'button[data-testid="stop-button"]')
    || query(doc, 'button[aria-label="Stop generating"]')
    || query(doc, 'button[aria-label*="Stop"]')
    || query(doc, 'div.streaming button[aria-label*="Stop"]');
  if (docStop) {
    stopEvidence = summarizeStopButtonEvidence(docStop, "document_stop_button", false);
  } else if (actionIsStop) {
    stopEvidence = summarizeStopButtonEvidence(
      composerActionBtn,
      "composer_action_slot",
      true,
    );
  }

  const hasExactSendButton = Boolean(
    editorForm
    && typeof editorForm.querySelector === "function"
    && editorForm.querySelector('button[data-testid="send-button"]'),
  );

  return {
    action: {
      kind: action.kind,
      enabled: action.enabled === true,
      evidence: action.evidence ?? null,
    },
    stopEvidence,
    hasExactSendButton,
    inventory: inspectActiveComposerControls(doc, editor),
    containerInventory: inspectComposerContainerInventory(doc, editor),
  };
}

/**
 * Resolve native action for a resolved editor.
 * Real Edge 2026-09-16 evidence:
 * - empty composer action slot (composer-submit-button-color + text-submit-btn-text) is
 *   voice control ("启动语音功能"), NOT Send.
 * - actual Send is form-scoped button[data-testid="send-button"] (localized aria).
 *
 * kind: "stop" | "send" | "idle" | "unknown"
 * - idle = positive generation idle evidence, MUST NOT be a click target
 * - send = only structural data-testid=send-button (click-capable)
 * @returns {{ button: object|null, kind: "stop"|"send"|"idle"|"unknown", enabled: boolean, evidence: string|null }}
 */
export function resolveChatGptAction(doc, editor) {
  if (!doc || typeof doc.querySelector !== "function") {
    return { button: null, kind: "unknown", enabled: false, evidence: null };
  }
  // Stop may remain document-wide: false-positive stop only fails closed (zero click).
  const stopBtn =
    query(doc, 'button[data-testid="stop-button"]')
    || query(doc, 'button[aria-label="Stop generating"]')
    || query(doc, 'button[aria-label*="Stop"]')
    || query(doc, 'div.streaming button[aria-label*="Stop"]');
  const editorForm = editor && typeof editor.closest === "function"
    ? editor.closest("form")
    : null;
  // Positive real-Edge Send target: form-scoped structural send-button only.
  const formSendBtn = editorForm
    ? query(editorForm, 'button[data-testid="send-button"]')
    : null;
  const composerActionBtn = editorForm
    ? query(editorForm, "button.composer-submit-button-color")
    : null;

  // Exact Send identity wins over class-only stop heuristic on the same button.
  const actionIsStop = isComposerActionSlotStop(composerActionBtn);
  // Empty-composer structural idle evidence (voice control when no send-button).
  const actionLooksIdle =
    Boolean(composerActionBtn)
    && !isDisabled(composerActionBtn)
    && !actionIsStop
    && hasClass(composerActionBtn, "text-submit-btn-text");

  if (stopBtn) {
    return {
      button: stopBtn,
      kind: "stop",
      enabled: !isDisabled(stopBtn),
      evidence: "legacy_stop",
    };
  }
  if (actionIsStop) {
    return {
      button: composerActionBtn,
      kind: "stop",
      enabled: !isDisabled(composerActionBtn),
      evidence: "action_slot_stop",
    };
  }
  // Real Send: only data-testid=send-button inside the active editor form.
  if (formSendBtn && !isDisabled(formSendBtn)) {
    return {
      button: formSendBtn,
      kind: "send",
      enabled: true,
      evidence: "form_send_button",
    };
  }
  if (formSendBtn && isDisabled(formSendBtn)) {
    return {
      button: formSendBtn,
      kind: "send",
      enabled: false,
      evidence: "form_send_button_disabled",
    };
  }
  // Idle evidence (e.g. voice control): generation idle, never a Send click target.
  if (actionLooksIdle) {
    return {
      button: null,
      kind: "idle",
      enabled: true,
      evidence: "action_slot_idle",
    };
  }
  if (composerActionBtn && isDisabled(composerActionBtn) && !actionIsStop) {
    return {
      button: null,
      kind: "idle",
      enabled: false,
      evidence: "action_slot_idle_disabled",
    };
  }
  return { button: null, kind: "unknown", enabled: false, evidence: null };
}

/**
 * Observe composer / generation without mutation.
 * Generation requires positive evidence (fail-closed).
 */
export function observeChatGptSafety(doc, opts = {}) {
  const routeValid = opts.routeValid !== false;
  const reasons = [];
  if (!doc || typeof doc.querySelector !== "function") {
    return unsafeDomSafety("no_document");
  }

  const { editor, kind } = resolveChatGptComposer(doc);

  let composer = "unknown";
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
    // Normalize NBSP only for empty/dirty classification (existing E1b2 behavior).
    const text = textOf(editor).replace(/\u00a0/g, " ").trim();
    if (text.length === 0) composer = "empty";
    else {
      composer = "dirty";
      reasons.push("composer_dirty");
    }
    void kind;
  }

  const action = resolveChatGptAction(doc, editor);
  let generation = "unknown";
  if (action.kind === "stop") {
    generation = "generating";
    reasons.push("generating");
  } else if ((action.kind === "idle" || action.kind === "send") && action.enabled) {
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
  actionSlot = false,
  actionSlotClass = null,
  actionSlotTestId = null,
} = {}) {
  const nodes = {};
  if (hasBody) nodes.body = { textContent: "" };
  if (hasComposer) {
    nodes.prose = { textContent: composerText, value: composerText };
    // Support editor.closest("form") so action-slot lookup is form-scoped.
    nodes.form = {
      querySelector(selector) {
        if (actionSlot && selector === "button.composer-submit-button-color") {
          return nodes.action ?? null;
        }
        // Real-Edge structural Send target only.
        if (sendEnabled && selector === 'button[data-testid="send-button"]') {
          return nodes.send ?? null;
        }
        return null;
      },
    };
    nodes.prose.closest = (sel) => (sel === "form" ? nodes.form : null);
  }
  if (stop) nodes.stop = { ariaLabel: "Stop generating" };
  if (sendEnabled) {
    nodes.send = {
      getAttribute: (name) => (name === "data-testid" ? "send-button" : null),
      hasAttribute: (name) => name === "data-testid",
      disabled: false,
      ariaLabel: "发送提示",
    };
  }
  if (actionSlot) {
    nodes.action = {
      className: actionSlotClass
        || "composer-submit-button-color text-submit-btn-text",
      getAttribute: (name) => (name === "data-testid" ? actionSlotTestId : null),
      hasAttribute: (name) => name === "data-testid" && Boolean(actionSlotTestId),
      disabled: false,
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
      if (
        selector.includes("send-button")
        || selector.includes("Send prompt")
        || selector.includes('aria-label*="Send"')
      ) {
        return sendEnabled ? nodes.send : null;
      }
      // Current ChatGPT structural action slot (form-scoped only).
      if (selector === "form button.composer-submit-button-color" || selector === "button.composer-submit-button-color") {
        // Document-level selector must not hit; only form.querySelector does.
        return null;
      }
      return null;
    },
  };
}
