import { describe, expect, it } from "vitest";

import fs from "node:fs";

import path from "node:path";

import { fileURLToPath } from "node:url";

import { resolveChatGptComposer, resolveChatGptAction, inspectChatGptActionEvidence, inspectActiveComposerControls, inspectComposerContainerInventory, isExcludedEmbeddedEditor } from "../browser-companion/dom-adapter.js";

import { snapshotUserTurns, findCanonicalUserTurn } from "../browser-companion/turn-observer.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const companionRoot = path.join(projectRoot, "browser-companion");

const ATTEMPT = "22222222-2222-4222-8222-222222222222";

const MESSAGE = `[C2C_CONTROL]\nSTATE: EXECUTED\nATTEMPT_ID: ${ATTEMPT}\n`;

describe("E1b3d1 stop diagnostic (read-only, no priority change)", () => {
  function makeDiagDom(opts: {
    docStop?: boolean;
    actionSlotStop?: boolean;
    formSend?: boolean;
    idleVoice?: boolean;
    text?: string;
  }) {
    const text = opts.text ?? "";
    const voice = {
      className: "composer-submit-button-color text-submit-btn-text",
      getAttribute: (n: string) => (n === "aria-label" ? "启动语音功能" : null),
      hasAttribute: () => false,
      disabled: false,
      focus: () => {
        throw new Error("no focus");
      },
    };
    const stopSlot = {
      className: "composer-submit-button-color composer-submit-btn",
      getAttribute: (n: string) =>
        n === "data-testid" ? "composer-stop-button" : n === "aria-label" ? null : null,
      hasAttribute: (n: string) => n === "data-testid",
      disabled: false,
    };
    const send = {
      className: "composer-submit-button-color text-submit-btn-text",
      getAttribute: (n: string) => (n === "data-testid" ? "send-button" : n === "aria-label" ? "发送提示" : null),
      hasAttribute: (n: string) => n === "data-testid",
      disabled: false,
    };
    const docStop = {
      className: "",
      getAttribute: (n: string) =>
        n === "aria-label" ? "Stop generating" : n === "data-testid" ? null : null,
      hasAttribute: () => false,
      disabled: false,
    };
    const form = {
      querySelector(selector: string) {
        if (opts.formSend && selector === 'button[data-testid="send-button"]') return send;
        if (opts.actionSlotStop && selector === "button.composer-submit-button-color") {
          return stopSlot;
        }
        if (opts.idleVoice && selector === "button.composer-submit-button-color") return voice;
        return null;
      },
    };
    const editor = {
      getAttribute: (n: string) => (n === "contenteditable" ? "true" : null),
      hasAttribute: () => false,
      closest: (s: string) => (s === "form" ? form : null),
      focus: () => {
        throw new Error("no focus");
      },
    };
    Object.defineProperty(editor, "textContent", {
      get() {
        return text;
      },
      set() {
        throw new Error("no write");
      },
      configurable: true,
    });
    return {
      doc: {
        querySelector(selector: string) {
          if (selector.includes("ProseMirror") || selector === "#prompt-textarea") return editor;
          if (opts.docStop && (selector.includes("stop-button") || selector.includes("Stop"))) {
            return docStop;
          }
          if (selector.includes("textarea")) return null;
          if (selector === "body") return {};
          if (selector === "main") return {};
          return null;
        },
        querySelectorAll: () => [],
      } as never,
      editor,
    };
  }

  it("1. document-wide Stop + form send-button: action still stop, both reported", () => {
    const { doc, editor } = makeDiagDom({ docStop: true, formSend: true, text: MESSAGE });
    const action = resolveChatGptAction(doc, editor);
    expect(action.kind).toBe("stop");
    expect(action.evidence).toBe("legacy_stop");
    const diag = inspectChatGptActionEvidence(doc, editor);
    expect(diag.hasExactSendButton).toBe(true);
    expect(diag.stopEvidence?.source).toBe("document_stop_button");
    expect(diag.stopEvidence?.insideComposerForm).toBe(false);
    expect(diag.stopEvidence?.ariaLabel).toContain("Stop");
    expect(diag.action.kind).toBe("stop");
  });

  it("2. composer action-slot stop", () => {
    const { doc, editor } = makeDiagDom({ actionSlotStop: true, text: "" });
    const diag = inspectChatGptActionEvidence(doc, editor);
    expect(diag.action.kind).toBe("stop");
    expect(diag.action.evidence).toBe("action_slot_stop");
    expect(diag.stopEvidence?.source).toBe("composer_action_slot");
    expect(diag.stopEvidence?.insideComposerForm).toBe(true);
    expect(diag.stopEvidence?.dataTestId).toBe("composer-stop-button");
    expect(diag.hasExactSendButton).toBe(false);
  });

  it("3. normal dirty send: evidence form_send_button, stopEvidence null", () => {
    const { doc, editor } = makeDiagDom({ formSend: true, text: MESSAGE });
    const diag = inspectChatGptActionEvidence(doc, editor);
    expect(diag.action.kind).toBe("send");
    expect(diag.action.evidence).toBe("form_send_button");
    expect(diag.hasExactSendButton).toBe(true);
    expect(diag.stopEvidence).toBeNull();
  });

  it("4. idle composer: stopEvidence null", () => {
    const { doc, editor } = makeDiagDom({ idleVoice: true, text: "" });
    const diag = inspectChatGptActionEvidence(doc, editor);
    expect(diag.action.kind).toBe("idle");
    expect(diag.stopEvidence).toBeNull();
  });
});

describe("E1b3d1 action inventory (read-only, no resolver change)", () => {
  type InvButton = {
    index: number;
    dataTestId: string | null;
    ariaLabel: string | null;
    title: string | null;
    type: string | null;
    name: string | null;
    role: string | null;
    className: string | null;
    disabled: boolean;
    ariaDisabled: boolean | null;
    matchesKnownSend: boolean;
    matchesKnownActionSlot: boolean;
    matchesKnownStop: boolean;
  };

  function makeButton(attrs: {
    dataTestId?: string | null;
    ariaLabel?: string | null;
    title?: string | null;
    type?: string | null;
    name?: string | null;
    role?: string | null;
    className?: string;
    disabled?: boolean;
    ariaDisabled?: string | null;
    extra?: Record<string, string>;
  } = {}) {
    const map = new Map<string, string>();
    if (attrs.dataTestId != null) map.set("data-testid", attrs.dataTestId);
    if (attrs.ariaLabel != null) map.set("aria-label", attrs.ariaLabel);
    if (attrs.title != null) map.set("title", attrs.title);
    if (attrs.type != null) map.set("type", attrs.type);
    if (attrs.name != null) map.set("name", attrs.name);
    if (attrs.role != null) map.set("role", attrs.role);
    if (attrs.ariaDisabled != null) map.set("aria-disabled", attrs.ariaDisabled);
    if (attrs.extra) {
      for (const [k, v] of Object.entries(attrs.extra)) map.set(k, v);
    }
    const btn: Record<string, unknown> = {
      className: attrs.className ?? "",
      disabled: attrs.disabled === true,
      getAttribute: (n: string) => map.get(n) ?? null,
      hasAttribute: (n: string) => map.has(n) || (n === "disabled" && attrs.disabled === true),
      // Privacy traps: inventory must never surface these.
      textContent: "USER SECRET COMPOSER TEXT",
      innerHTML: "<span>html-secret</span>",
      outerHTML: "<button>outer-secret</button>",
      value: "value-secret",
      focus: () => {
        throw new Error("inventory must not focus");
      },
      click: () => {
        throw new Error("inventory must not click");
      },
    };
    return btn;
  }

  function makeInventoryDom(opts: {
    buttons?: ReturnType<typeof makeButton>[];
    formPresent?: boolean;
    editorText?: string;
    withFormQuerySelectorAll?: boolean;
  } = {}) {
    const buttons = opts.buttons ?? [];
    const formPresent = opts.formPresent !== false;
    const form = formPresent
      ? {
          querySelector: () => null,
          ...(opts.withFormQuerySelectorAll !== false
            ? { querySelectorAll: (sel: string) => (sel === "button" ? buttons : []) }
            : {}),
        }
      : null;
    const editor = {
      getAttribute: (n: string) => (n === "contenteditable" ? "true" : null),
      hasAttribute: () => false,
      closest: (s: string) => (s === "form" ? form : null),
      focus: () => {
        throw new Error("no focus");
      },
    };
    Object.defineProperty(editor, "textContent", {
      get() {
        return opts.editorText ?? "";
      },
      set() {
        throw new Error("no write");
      },
      configurable: true,
    });
    const doc = {
      querySelector(selector: string) {
        if (selector.includes("ProseMirror") || selector === "#prompt-textarea") return editor;
        if (selector.includes("textarea")) return null;
        if (selector === "body") return {};
        if (selector === "main") return {};
        return null;
      },
      querySelectorAll: () => [],
    } as never;
    return { doc, editor, form };
  }

  it("1. form absent → formPresent=false, buttons=[]", () => {
    const { doc, editor } = makeInventoryDom({ formPresent: false, editorText: MESSAGE });
    const inv = inspectActiveComposerControls(doc, editor);
    expect(inv).toEqual({ formPresent: false, buttonCount: 0, buttons: [] });
    const diag = inspectChatGptActionEvidence(doc, editor);
    expect(diag.inventory.formPresent).toBe(false);
    expect(diag.action.kind).toBe("unknown");
  });

  it("2. legacy send fixture: data-testid=send-button captured, matchesKnownSend=true", () => {
    const send = makeButton({
      dataTestId: "send-button",
      ariaLabel: "发送提示",
      className: "composer-submit-button-color text-submit-btn-text",
      type: "button",
    });
    const { doc, editor } = makeInventoryDom({
      buttons: [send],
      editorText: MESSAGE,
    });
    const inv = inspectActiveComposerControls(doc, editor);
    expect(inv.formPresent).toBe(true);
    expect(inv.buttonCount).toBe(1);
    expect(inv.buttons).toHaveLength(1);
    const b = inv.buttons[0] as InvButton;
    expect(b.dataTestId).toBe("send-button");
    expect(b.matchesKnownSend).toBe(true);
    expect(b.matchesKnownActionSlot).toBe(true);
    expect(b.matchesKnownStop).toBe(false);
    // Resolver unchanged: still send via exact selector path when form.querySelector works.
    const sendViaForm = makeButton({
      dataTestId: "send-button",
      className: "composer-submit-button-color",
    });
    const form = {
      querySelector: (sel: string) =>
        sel === 'button[data-testid="send-button"]' ? sendViaForm : null,
      querySelectorAll: (sel: string) => (sel === "button" ? [send] : []),
    };
    const editor2 = {
      getAttribute: () => "true",
      hasAttribute: () => false,
      closest: (s: string) => (s === "form" ? form : null),
    };
    Object.defineProperty(editor2, "textContent", {
      get: () => MESSAGE,
      set() {
        throw new Error("no write");
      },
      configurable: true,
    });
    const doc2 = {
      querySelector: (sel: string) =>
        sel.includes("ProseMirror") || sel === "#prompt-textarea" ? editor2 : null,
      querySelectorAll: () => [],
    } as never;
    const action = resolveChatGptAction(doc2, editor2);
    expect(action.kind).toBe("send");
    expect(action.evidence).toBe("form_send_button");
  });

  it("3. idle voice fixture: composer-submit-button-color captured, matchesKnownActionSlot=true", () => {
    const voice = makeButton({
      ariaLabel: "启动语音功能",
      className: "composer-submit-button-color text-submit-btn-text",
      type: "button",
    });
    const form = {
      querySelector: (sel: string) =>
        sel === "button.composer-submit-button-color" ? voice : null,
      querySelectorAll: (sel: string) => (sel === "button" ? [voice] : []),
    };
    const editor = {
      getAttribute: () => "true",
      hasAttribute: () => false,
      closest: (s: string) => (s === "form" ? form : null),
    };
    Object.defineProperty(editor, "textContent", {
      get: () => "",
      set() {
        throw new Error("no write");
      },
      configurable: true,
    });
    const doc = {
      querySelector: (sel: string) =>
        sel.includes("ProseMirror") || sel === "#prompt-textarea" ? editor : null,
      querySelectorAll: () => [],
    } as never;
    const inv = inspectActiveComposerControls(doc, editor);
    expect(inv.formPresent).toBe(true);
    const b = inv.buttons[0] as InvButton;
    expect(b.matchesKnownActionSlot).toBe(true);
    expect(b.matchesKnownSend).toBe(false);
    expect(b.ariaLabel).toBe("启动语音功能");
    const action = resolveChatGptAction(doc, editor);
    expect(action.kind).toBe("idle");
    expect(action.evidence).toBe("action_slot_idle");
  });

  it("4. unknown action: unmatched button attrs reported, resolver stays unknown", () => {
    const mystery = makeButton({
      dataTestId: "composer-mystery-action",
      ariaLabel: "未知操作",
      className: "btn-mystery",
      type: "submit",
      name: "mystery",
      role: "button",
      title: "mystery-title",
    });
    const form = {
      querySelector: () => null,
      querySelectorAll: (sel: string) => (sel === "button" ? [mystery] : []),
    };
    const editor = {
      getAttribute: () => "true",
      hasAttribute: () => false,
      closest: (s: string) => (s === "form" ? form : null),
    };
    Object.defineProperty(editor, "textContent", {
      get: () => MESSAGE,
      set() {
        throw new Error("no write");
      },
      configurable: true,
    });
    const doc = {
      querySelector: (sel: string) =>
        sel.includes("ProseMirror") || sel === "#prompt-textarea" ? editor : null,
      querySelectorAll: () => [],
    } as never;
    const action = resolveChatGptAction(doc, editor);
    expect(action.kind).toBe("unknown");
    const inv = inspectActiveComposerControls(doc, editor);
    expect(inv.buttonCount).toBe(1);
    const b = inv.buttons[0] as InvButton;
    expect(b.dataTestId).toBe("composer-mystery-action");
    expect(b.ariaLabel).toBe("未知操作");
    expect(b.type).toBe("submit");
    expect(b.name).toBe("mystery");
    expect(b.role).toBe("button");
    expect(b.title).toBe("mystery-title");
    expect(b.className).toBe("btn-mystery");
    expect(b.matchesKnownSend).toBe(false);
    expect(b.matchesKnownActionSlot).toBe(false);
    expect(b.matchesKnownStop).toBe(false);
  });

  it("5. truncation: max 12 buttons in DTO; className/attrs length-capped", () => {
    const many: ReturnType<typeof makeButton>[] = [];
    for (let i = 0; i < 15; i++) {
      many.push(makeButton({
        dataTestId: `btn-${i}`,
        className: `c${"x".repeat(300)}-${i}`,
        title: "t".repeat(250),
        ariaLabel: "a".repeat(220),
      }));
    }
    const { doc, editor } = makeInventoryDom({ buttons: many, editorText: MESSAGE });
    const inv = inspectActiveComposerControls(doc, editor);
    expect(inv.buttonCount).toBe(15);
    expect(inv.buttons).toHaveLength(12);
    const b0 = inv.buttons[0] as InvButton;
    expect((b0.className ?? "").length).toBeLessThanOrEqual(240);
    expect((b0.title ?? "").length).toBeLessThanOrEqual(200);
    expect((b0.ariaLabel ?? "").length).toBeLessThanOrEqual(200);
    expect(inv.buttons[11]?.index).toBe(11);
  });

  it("6. privacy/read-only: no text/HTML/value, zero write/focus/click", () => {
    const btn = makeButton({
      dataTestId: "send-button",
      ariaLabel: "aria-secret",
      className: "composer-submit-button-color",
    });
    const { doc, editor } = makeInventoryDom({ buttons: [btn], editorText: MESSAGE });
    expect(() => inspectActiveComposerControls(doc, editor)).not.toThrow();
    const inv = inspectActiveComposerControls(doc, editor);
    const raw = JSON.stringify(inv);
    expect(raw).not.toContain("USER SECRET");
    expect(raw).not.toContain("html-secret");
    expect(raw).not.toContain("outer-secret");
    expect(raw).not.toContain("value-secret");
    const b = inv.buttons[0] as unknown as Record<string, unknown>;
    expect(b).not.toHaveProperty("textContent");
    expect(b).not.toHaveProperty("innerHTML");
    expect(b).not.toHaveProperty("outerHTML");
    expect(b).not.toHaveProperty("value");
    expect(b).not.toHaveProperty("focus");
    expect(b).not.toHaveProperty("click");
    // Allowed keys only (matchesKnownVoiceIdle: current-voice read-only diagnostic
    // boolean, authorized R3 slice; still no text/HTML/value).
    expect(Object.keys(b).sort()).toEqual([
      "ariaDisabled",
      "ariaLabel",
      "className",
      "dataTestId",
      "disabled",
      "index",
      "matchesKnownActionSlot",
      "matchesKnownSend",
      "matchesKnownStop",
      "matchesKnownVoiceIdle",
      "name",
      "role",
      "title",
      "type",
    ]);
  });

  it("resolver priority unchanged: stop still wins over send when both present", () => {
    const docStop = makeButton({
      ariaLabel: "Stop generating",
      className: "btn-stop",
    });
    const send = makeButton({
      dataTestId: "send-button",
      className: "composer-submit-button-color",
    });
    const form = {
      querySelector: (sel: string) =>
        sel === 'button[data-testid="send-button"]' ? send : null,
      querySelectorAll: (sel: string) => (sel === "button" ? [send] : []),
    };
    const editor = {
      getAttribute: () => "true",
      hasAttribute: () => false,
      closest: (s: string) => (s === "form" ? form : null),
    };
    Object.defineProperty(editor, "textContent", {
      get: () => MESSAGE,
      set() {
        throw new Error("no write");
      },
      configurable: true,
    });
    const doc = {
      querySelector(selector: string) {
        if (selector.includes("ProseMirror") || selector === "#prompt-textarea") return editor;
        if (selector.includes("Stop") || selector.includes("stop-button")) return docStop;
        return null;
      },
      querySelectorAll: () => [],
    } as never;
    const action = resolveChatGptAction(doc, editor);
    expect(action.kind).toBe("stop");
    expect(action.evidence).toBe("legacy_stop");
    const inv = inspectActiveComposerControls(doc, editor);
    expect(inv.buttons[0]?.matchesKnownSend).toBe(true);
  });
});

describe("E1b3d1 composer container inventory (read-only, no form, no resolver change)", () => {
  type ContainerButton = {
    index: number;
    dataTestId: string | null;
    ariaLabel: string | null;
    title: string | null;
    type: string | null;
    name: string | null;
    role: string | null;
    className: string | null;
    disabled: boolean;
    ariaDisabled: boolean | null;
    matchesKnownSend: boolean;
    matchesKnownActionSlot: boolean;
    matchesKnownStop: boolean;
    ancestorDepth: number;
    insideEditorAncestor: boolean;
    distanceFromEditor: number;
  };

  function makeBtn(attrs: {
    dataTestId?: string | null;
    ariaLabel?: string | null;
    title?: string | null;
    type?: string | null;
    name?: string | null;
    role?: string | null;
    className?: string;
    disabled?: boolean;
    ariaDisabled?: string | null;
  } = {}) {
    const map = new Map<string, string>();
    if (attrs.dataTestId != null) map.set("data-testid", attrs.dataTestId);
    if (attrs.ariaLabel != null) map.set("aria-label", attrs.ariaLabel);
    if (attrs.title != null) map.set("title", attrs.title);
    if (attrs.type != null) map.set("type", attrs.type);
    if (attrs.name != null) map.set("name", attrs.name);
    if (attrs.role != null) map.set("role", attrs.role);
    if (attrs.ariaDisabled != null) map.set("aria-disabled", attrs.ariaDisabled);
    return {
      tagName: "BUTTON",
      className: attrs.className ?? "",
      disabled: attrs.disabled === true,
      getAttribute: (n: string) => map.get(n) ?? null,
      hasAttribute: (n: string) => map.has(n) || (n === "disabled" && attrs.disabled === true),
      textContent: "BTN SECRET",
      innerHTML: "<span>html</span>",
      outerHTML: "<button>outer</button>",
      value: "val-secret",
      focus: () => {
        throw new Error("no focus");
      },
      click: () => {
        throw new Error("no click");
      },
    };
  }

  type El = {
    tagName: string;
    id?: string;
    className?: string;
    getAttribute: (n: string) => string | null;
    hasAttribute: (n: string) => boolean;
    parentElement: El | null;
    querySelector: (s: string) => unknown;
    querySelectorAll: (s: string) => unknown[];
    textContent?: string;
  };

  function makeEl(opts: {
    tagName?: string;
    id?: string;
    className?: string;
    testId?: string;
    role?: string;
    buttons?: unknown[];
    parent?: El | null;
  } = {}): El {
    const map = new Map<string, string>();
    if (opts.id != null) map.set("id", opts.id);
    if (opts.testId != null) map.set("data-testid", opts.testId);
    if (opts.role != null) map.set("role", opts.role);
    const buttons = opts.buttons ?? [];
    const el: El = {
      tagName: opts.tagName ?? "DIV",
      className: opts.className ?? "",
      getAttribute: (n: string) => map.get(n) ?? null,
      hasAttribute: (n: string) => map.has(n),
      parentElement: opts.parent ?? null,
      querySelector: (s: string) => (s === "button" ? buttons[0] ?? null : null),
      querySelectorAll: (s: string) => (s === "button" ? buttons : []),
      textContent: "EL SECRET",
    };
    if (opts.id != null) el.id = opts.id;
    return el;
  }

  /**
   * Build editor with NO form, sitting inside a parentElement chain.
   * depth 1 = editor.parentElement, etc.
   */
  function makeNoFormDom(opts: {
    chainButtons: Record<number, unknown[]>; // depth -> buttons in that ancestor
    chainMeta?: Record<number, { tagName?: string; id?: string; className?: string; testId?: string; role?: string }>;
    depth?: number;
    editorText?: string;
  }) {
    const maxDepth = opts.depth ?? 4;
    // Build from outermost to innermost.
    let current: El | null = null;
    const nodes: El[] = [];
    for (let d = maxDepth; d >= 1; d--) {
      const meta = opts.chainMeta?.[d] ?? {};
      const el = makeEl({
        tagName: meta.tagName ?? "DIV",
        id: meta.id,
        className: meta.className ?? `c-depth-${d}`,
        testId: meta.testId,
        role: meta.role,
        buttons: opts.chainButtons[d] ?? [],
        parent: current,
      });
      nodes[d] = el;
      current = el;
    }
    const editor = {
      tagName: "DIV",
      className: "ProseMirror",
      parentElement: nodes[1] ?? null,
      closest: () => null, // no form
      getAttribute: (n: string) => (n === "contenteditable" ? "true" : null),
      hasAttribute: () => false,
      focus: () => {
        throw new Error("no focus");
      },
      textContent: opts.editorText ?? "",
    };
    const doc = {
      querySelector(selector: string) {
        if (selector.includes("ProseMirror") || selector === "#prompt-textarea") return editor;
        if (selector.includes("textarea")) return null;
        if (selector === "body") return {};
        if (selector === "main") return {};
        return null;
      },
      querySelectorAll: () => [],
    } as never;
    return { doc, editor, nodes };
  }

  it("1. no form, parent has send-like button: resolver unknown, inventory sees button", () => {
    const sendLike = makeBtn({
      dataTestId: "send-button",
      ariaLabel: "发送",
      className: "composer-submit-button-color",
      type: "button",
    });
    const { doc, editor } = makeNoFormDom({
      chainButtons: { 1: [sendLike] },
      chainMeta: { 1: { className: "composer-shell" } },
      editorText: MESSAGE,
    });
    const action = resolveChatGptAction(doc, editor);
    expect(action.kind).toBe("unknown");
    expect(action.evidence).toBeNull();
    const inv = inspectComposerContainerInventory(doc, editor);
    expect(inv.ancestors.length).toBeGreaterThan(0);
    expect(inv.ancestors[0]?.depth).toBe(1);
    expect(inv.ancestors[0]?.descendantButtonCount).toBe(1);
    expect(inv.controlContainers).toHaveLength(1);
    const b = inv.controlContainers[0]?.buttons[0] as ContainerButton;
    expect(b.dataTestId).toBe("send-button");
    expect(b.insideEditorAncestor).toBe(true);
    expect(b.distanceFromEditor).toBe(1);
    expect(b.ancestorDepth).toBe(1);
    expect(b.matchesKnownSend).toBe(true);
    // Old form inventory still reports form absent.
    const formInv = inspectActiveComposerControls(doc, editor);
    expect(formInv).toEqual({ formPresent: false, buttonCount: 0, buttons: [] });
  });

  it("2. sibling button shares nearest parent with editor", () => {
    const sibling = makeBtn({ dataTestId: "composer-mystery", className: "btn-x" });
    const { doc, editor } = makeNoFormDom({
      chainButtons: { 1: [sibling], 2: [] },
      depth: 2,
      editorText: MESSAGE,
    });
    const inv = inspectComposerContainerInventory(doc, editor);
    expect(inv.ancestors[0]?.descendantButtonCount).toBe(1);
    expect(inv.ancestors[1]?.descendantButtonCount).toBe(0);
    expect(inv.controlContainers[0]?.depth).toBe(1);
    const b = inv.controlContainers[0]?.buttons[0] as ContainerButton;
    expect(b.dataTestId).toBe("composer-mystery");
    expect(b.insideEditorAncestor).toBe(true);
    expect(resolveChatGptAction(doc, editor).kind).toBe("unknown");
  });

  it("3. multi-level ancestors capped at 8", () => {
    const deepBtn = makeBtn({ dataTestId: "far-away" });
    const { doc, editor } = makeNoFormDom({
      chainButtons: { 9: [deepBtn] }, // 9th ancestor only
      depth: 10,
      editorText: MESSAGE,
    });
    const inv = inspectComposerContainerInventory(doc, editor);
    expect(inv.ancestors.length).toBe(8);
    expect(inv.ancestors[0]?.depth).toBe(1);
    expect(inv.ancestors[7]?.depth).toBe(8);
    // depth 9 button is outside 8-layer cap.
    expect(inv.controlContainers).toHaveLength(0);
  });

  it("4. at most 3 control containers (closest first)", () => {
    const b1 = makeBtn({ dataTestId: "near" });
    const b2 = makeBtn({ dataTestId: "mid" });
    const b3 = makeBtn({ dataTestId: "far" });
    const b4 = makeBtn({ dataTestId: "farthest" });
    const { doc, editor } = makeNoFormDom({
      chainButtons: { 1: [b1], 2: [b2], 3: [b3], 4: [b4] },
      depth: 5,
      editorText: MESSAGE,
    });
    const inv = inspectComposerContainerInventory(doc, editor);
    expect(inv.ancestors.length).toBe(5);
    expect(inv.controlContainers).toHaveLength(3);
    expect(inv.controlContainers.map((c) => c.depth)).toEqual([1, 2, 3]);
    expect((inv.controlContainers[0]?.buttons[0] as ContainerButton).dataTestId).toBe("near");
    expect((inv.controlContainers[2]?.buttons[0] as ContainerButton).dataTestId).toBe("far");
  });

  it("5. at most 12 buttons per control container", () => {
    const many: ReturnType<typeof makeBtn>[] = [];
    for (let i = 0; i < 15; i++) {
      many.push(makeBtn({ dataTestId: `b-${i}` }));
    }
    const { doc, editor } = makeNoFormDom({
      chainButtons: { 1: many },
      editorText: MESSAGE,
    });
    const inv = inspectComposerContainerInventory(doc, editor);
    expect(inv.ancestors[0]?.descendantButtonCount).toBe(15);
    expect(inv.controlContainers[0]?.buttonCount).toBe(15);
    expect(inv.controlContainers[0]?.buttons).toHaveLength(12);
  });

  it("6. attr/class truncation on ancestor and button", () => {
    const longBtn = makeBtn({
      dataTestId: "t".repeat(250),
      ariaLabel: "a".repeat(220),
      className: `c${"x".repeat(300)}`,
      title: "title".repeat(60),
    });
    const { doc, editor, nodes } = makeNoFormDom({
      chainButtons: { 1: [longBtn] },
      chainMeta: {
        1: {
          id: "i".repeat(250),
          testId: "tt".repeat(120),
          role: "r".repeat(220),
          className: `cl${"y".repeat(300)}`,
        },
      },
      editorText: MESSAGE,
    });
    void nodes;
    const inv = inspectComposerContainerInventory(doc, editor);
    const anc = inv.ancestors[0];
    expect((anc?.id ?? "").length).toBeLessThanOrEqual(200);
    expect((anc?.dataTestId ?? "").length).toBeLessThanOrEqual(200);
    expect((anc?.role ?? "").length).toBeLessThanOrEqual(200);
    expect((anc?.className ?? "").length).toBeLessThanOrEqual(240);
    const b = inv.controlContainers[0]?.buttons[0] as ContainerButton;
    expect((b.dataTestId ?? "").length).toBeLessThanOrEqual(200);
    expect((b.ariaLabel ?? "").length).toBeLessThanOrEqual(200);
    expect((b.className ?? "").length).toBeLessThanOrEqual(240);
    expect((b.title ?? "").length).toBeLessThanOrEqual(200);
  });

  it("7. privacy: no editor/button text, no HTML/value in DTO", () => {
    const btn = makeBtn({ dataTestId: "send-button", ariaLabel: "aria-secret" });
    const { doc, editor } = makeNoFormDom({
      chainButtons: { 1: [btn] },
      editorText: "EDITOR USER SECRET TEXT",
    });
    const inv = inspectComposerContainerInventory(doc, editor);
    const raw = JSON.stringify(inv);
    expect(raw).not.toContain("EDITOR USER SECRET");
    expect(raw).not.toContain("BTN SECRET");
    expect(raw).not.toContain("html");
    expect(raw).not.toContain("outer");
    expect(raw).not.toContain("val-secret");
    expect(raw).not.toContain("EL SECRET");
    const b = inv.controlContainers[0]?.buttons[0] as unknown as Record<string, unknown>;
    expect(b).not.toHaveProperty("textContent");
    expect(b).not.toHaveProperty("innerHTML");
    expect(b).not.toHaveProperty("outerHTML");
    expect(b).not.toHaveProperty("value");
  });

  it("diagnostic includes containerInventory while keeping old inventory fields", () => {
    const { doc, editor } = makeNoFormDom({ chainButtons: { 1: [] }, editorText: MESSAGE });
    const diag = inspectChatGptActionEvidence(doc, editor);
    expect(diag.inventory).toEqual({ formPresent: false, buttonCount: 0, buttons: [] });
    expect(Array.isArray(diag.containerInventory.ancestors)).toBe(true);
    expect(Array.isArray(diag.containerInventory.controlContainers)).toBe(true);
  });

  it("editor without parentElement returns empty containers", () => {
    const editor = {
      parentElement: null,
      closest: () => null,
      getAttribute: () => null,
      hasAttribute: () => false,
    };
    const doc = { querySelector: () => null, querySelectorAll: () => [] } as never;
    expect(inspectComposerContainerInventory(doc, editor)).toEqual({
      ancestors: [],
      controlContainers: [],
    });
    expect(inspectComposerContainerInventory(doc, null)).toEqual({
      ancestors: [],
      controlContainers: [],
    });
  });
});

describe("E1b3d1 composer identity (Writing Block exclusion, no Send change)", () => {
  function makeWritingBlockEditor(text = "WRITING BLOCK SECRET") {
    const wbContainer = {
      tagName: "DIV",
      getAttribute: (n: string) => (n === "data-testid" ? "writing-block-container" : null),
      hasAttribute: (n: string) => n === "data-testid",
      querySelector: () => null,
      querySelectorAll: () => [],
      parentElement: null,
      closest: (s: string) => (s.includes("writing-block") ? wbContainer : null),
    };
    const editor = {
      tagName: "DIV",
      className: "ProseMirror",
      getAttribute: (n: string) => (n === "contenteditable" ? "true" : null),
      hasAttribute: () => false,
      parentElement: wbContainer,
      closest: (s: string) => {
        if (s.includes("writing-block")) return wbContainer;
        if (s === "form") return null;
        return null;
      },
      focus: () => {
        throw new Error("no focus");
      },
    };
    Object.defineProperty(editor, "textContent", {
      get: () => text,
      set() {
        throw new Error("no write");
      },
      configurable: true,
    });
    return { editor, wbContainer };
  }

  function makePrimaryComposer(text = MESSAGE) {
    const form = {
      querySelector: (s: string) =>
        s === 'button[data-testid="send-button"]'
          ? {
              getAttribute: (n: string) => (n === "data-testid" ? "send-button" : null),
              hasAttribute: (n: string) => n === "data-testid",
              disabled: false,
              className: "composer-submit-button-color",
            }
          : null,
      querySelectorAll: (s: string) => (s === "button" ? [] : []),
    };
    const editor = {
      tagName: "DIV",
      id: "prompt-textarea",
      className: "ProseMirror",
      getAttribute: (n: string) => (n === "contenteditable" ? "true" : null),
      hasAttribute: () => false,
      parentElement: form,
      closest: (s: string) => (s === "form" ? form : null),
      focus: () => {
        throw new Error("no focus");
      },
    };
    Object.defineProperty(editor, "textContent", {
      get: () => text,
      set() {
        throw new Error("no write");
      },
      configurable: true,
    });
    return { editor, form };
  }

  it("isExcludedEmbeddedEditor detects writing-block-container and writing-block id", () => {
    const { editor } = makeWritingBlockEditor();
    expect(isExcludedEmbeddedEditor(editor)).toBe(true);
    expect(isExcludedEmbeddedEditor(null)).toBe(false);
    const standalone = makePrimaryComposer("").editor;
    expect(isExcludedEmbeddedEditor(standalone)).toBe(false);
  });

  it("2. no #prompt-textarea; generic candidates: WB first, standalone second → standalone", () => {
    const wb = makeWritingBlockEditor("WB");
    const standaloneForm = {
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    const standalone = {
      tagName: "DIV",
      className: "ProseMirror",
      getAttribute: (n: string) => (n === "contenteditable" ? "true" : null),
      hasAttribute: () => false,
      parentElement: standaloneForm,
      closest: (s: string) => (s === "form" ? standaloneForm : null),
    };
    Object.defineProperty(standalone, "textContent", {
      get: () => "",
      configurable: true,
    });
    const doc = {
      querySelector(selector: string) {
        if (selector === "#prompt-textarea") return null;
        if (selector === 'div.ProseMirror[contenteditable="true"]') return wb.editor;
        if (selector.includes("ProseMirror") || selector.includes("contenteditable")) {
          return wb.editor;
        }
        if (selector.includes("textarea")) return null;
        return null;
      },
      querySelectorAll(selector: string) {
        if (
          selector === 'div.ProseMirror[contenteditable="true"]'
          || selector === "div.ProseMirror"
          || selector.includes("contenteditable")
        ) {
          return [wb.editor, standalone];
        }
        return [];
      },
    } as never;
    const resolved = resolveChatGptComposer(doc);
    expect(resolved.editor).toBe(standalone);
    expect(resolved.evidence).toBe("fallback_prosemirror");
    expect(isExcludedEmbeddedEditor(resolved.editor)).toBe(false);
  });

  it("4. textarea primary path retained (textarea[data-id=root])", () => {
    const textarea = {
      tagName: "TEXTAREA",
      getAttribute: (n: string) => (n === "data-id" ? "root" : null),
      hasAttribute: (n: string) => n === "data-id",
      closest: () => null,
      value: "",
    };
    const doc = {
      querySelector(selector: string) {
        if (selector === "#prompt-textarea") return null;
        if (selector === 'textarea[data-id="root"]') return textarea;
        return null;
      },
      querySelectorAll: () => [],
    } as never;
    const resolved = resolveChatGptComposer(doc);
    expect(resolved.editor).toBe(textarea);
    expect(resolved.kind).toBe("textarea");
    expect(resolved.evidence).toBe("textarea_root");
  });

  it("5. multi generic candidates respect scan cap 16", () => {
    const wbEditors = Array.from({ length: 20 }, (_, i) => {
      const { editor } = makeWritingBlockEditor(`WB${i}`);
      return editor;
    });
    const eligible = {
      tagName: "DIV",
      className: "ProseMirror",
      getAttribute: (n: string) => (n === "contenteditable" ? "true" : null),
      hasAttribute: () => false,
      closest: () => null,
    };
    // 16 Writing Blocks then eligible — beyond cap should miss eligible (fail closed).
    const docBeyond = {
      querySelector: () => null,
      querySelectorAll: (s: string) =>
        s.includes("ProseMirror") ? [...wbEditors.slice(0, 16), eligible] : [],
    } as never;
    // First 15 are WB, 16th is eligible → within cap, should find eligible.
    const docWithin = {
      querySelector: () => null,
      querySelectorAll: (s: string) =>
        s.includes("ProseMirror") ? [...wbEditors.slice(0, 15), eligible] : [],
    } as never;
    expect(resolveChatGptComposer(docWithin).editor).toBe(eligible);
    // All 16 scanned are WB → eligible never reached.
    expect(resolveChatGptComposer(docBeyond).editor).toBeNull();
  });

  it("fallback placeholder and form textarea evidence labels", () => {
    const ph = {
      tagName: "DIV",
      getAttribute: (n: string) =>
        n === "contenteditable" ? "true" : n === "data-placeholder" ? "Message…" : null,
      hasAttribute: (n: string) => n === "contenteditable" || n === "data-placeholder",
      closest: () => null,
    };
    const docPh = {
      querySelector: () => null,
      querySelectorAll: (s: string) => (s.includes("data-placeholder") ? [ph] : []),
    } as never;
    expect(resolveChatGptComposer(docPh).evidence).toBe("fallback_placeholder");

    const ta = {
      tagName: "TEXTAREA",
      getAttribute: () => null,
      hasAttribute: () => false,
      closest: () => null,
    };
    const docTa = {
      querySelector: () => null,
      querySelectorAll: (s: string) => (s === "form textarea" || s === "textarea" ? [ta] : []),
    } as never;
    expect(resolveChatGptComposer(docTa).evidence).toBe("fallback_textarea");
  });

  it("packaging exports isExcludedEmbeddedEditor; resolver source keeps strong id first", () => {
    const src = fs.readFileSync(path.join(companionRoot, "dom-adapter.js"), "utf8");
    expect(src).toMatch(/export function isExcludedEmbeddedEditor/);
    expect(src).toMatch(/export function resolveChatGptComposer/);
    expect(src).toMatch(/COMPOSER_FALLBACK_MAX_CANDIDATES/);
    // #prompt-textarea must be consulted before generic ProseMirror.
    const resolveBody = src.slice(
      src.indexOf("export function resolveChatGptComposer"),
      src.indexOf("/** Hard caps for inventory"),
    );
    const promptIdx = resolveBody.indexOf('"#prompt-textarea"');
    const genericIdx = resolveBody.indexOf('div.ProseMirror[contenteditable="true"]');
    expect(promptIdx).toBeGreaterThan(-1);
    expect(genericIdx).toBeGreaterThan(-1);
    expect(promptIdx).toBeLessThan(genericIdx);
    // Action priority still stop > send.
    expect(src.indexOf("if (stopBtn)")).toBeLessThan(src.indexOf('kind: "send"'));
  });
});

describe("E1b3d1 exact Send vs Stop disambiguation (real Edge 2026-09-16)", () => {
  /**
   * Real Edge dirty composer: #prompt-textarea + form send-button that ALSO
   * carries composer-submit-btn class (previously misclassified as action_slot_stop).
   */
  function makeRealEdgeDirtySendDom(opts: {
    sendClass?: string;
    stopClass?: string;
    withDocStop?: boolean;
    text?: string;
  } = {}) {
    const text = opts.text ?? MESSAGE;
    const sendClass = opts.sendClass ?? "composer-submit-btn composer-submit-button-color h-9";
    const sendBtn = {
      tagName: "BUTTON",
      className: sendClass,
      disabled: false,
      getAttribute: (n: string) =>
        n === "data-testid" ? "send-button" : n === "type" ? "submit" : n === "aria-label" ? "发送提示词" : null,
      hasAttribute: (n: string) => n === "data-testid" || n === "type",
    };
    const form = {
      querySelector(selector: string) {
        if (selector === 'button[data-testid="send-button"]') return sendBtn;
        if (selector === "button.composer-submit-button-color") return sendBtn;
        return null;
      },
      querySelectorAll(selector: string) {
        if (selector === "button") return [sendBtn];
        return [];
      },
    };
    const editor = {
      tagName: "DIV",
      id: "prompt-textarea",
      className: "ProseMirror",
      getAttribute: (n: string) => (n === "contenteditable" ? "true" : null),
      hasAttribute: () => false,
      closest: (s: string) => (s === "form" ? form : null),
      focus: () => {
        throw new Error("no focus");
      },
    };
    Object.defineProperty(editor, "textContent", {
      get: () => text,
      set() {
        throw new Error("no write");
      },
      configurable: true,
    });
    const doc = {
      querySelector(selector: string) {
        if (selector === "#prompt-textarea") return editor;
        if (selector.includes("ProseMirror") || selector.includes("contenteditable")) return editor;
        if (selector.includes("textarea")) return null;
        if (selector === "body") return {};
        if (selector === "main") return {};
        if (opts.withDocStop && (selector.includes("stop-button") || selector.includes("Stop"))) {
          return {
            getAttribute: (n: string) => (n === "aria-label" ? "Stop generating" : null),
            hasAttribute: () => false,
            disabled: false,
          };
        }
        return null;
      },
      querySelectorAll: () => [],
    } as never;
    return { doc, editor, sendBtn, form };
  }

  it("real Edge: send-button with composer-submit-btn class → send, not stop", () => {
    const { doc, editor } = makeRealEdgeDirtySendDom();
    const action = resolveChatGptAction(doc, editor);
    expect(action.kind).toBe("send");
    expect(action.evidence).toBe("form_send_button");
    expect(action.enabled).toBe(true);
    expect(action.button?.getAttribute?.("data-testid")).toBe("send-button");

    const diag = inspectChatGptActionEvidence(doc, editor);
    expect(diag.hasExactSendButton).toBe(true);
    expect(diag.stopEvidence).toBeNull();
    expect(diag.action.kind).toBe("send");
    expect(diag.action.evidence).toBe("form_send_button");

    const inv = diag.inventory;
    expect(inv.formPresent).toBe(true);
    const b = inv.buttons[0]!;
    expect(b.matchesKnownSend).toBe(true);
    expect(b.matchesKnownActionSlot).toBe(true);
    expect(b.matchesKnownStop).toBe(false);
  });

  it("A. data-testid=stop-button still stop", () => {
    const stopBtn = {
      className: "btn",
      getAttribute: (n: string) => (n === "data-testid" ? "stop-button" : null),
      hasAttribute: (n: string) => n === "data-testid",
      disabled: false,
    };
    const form = {
      querySelector: (s: string) =>
        s === "button.composer-submit-button-color" ? null : s.includes("stop-button") ? stopBtn : null,
      querySelectorAll: () => [],
    };
    const editor = {
      getAttribute: (n: string) => (n === "contenteditable" ? "true" : null),
      hasAttribute: () => false,
      closest: (s: string) => (s === "form" ? form : null),
    };
    Object.defineProperty(editor, "textContent", {
      get: () => "",
      configurable: true,
    });
    const doc = {
      querySelector(selector: string) {
        if (selector.includes("ProseMirror") || selector === "#prompt-textarea") return editor;
        if (selector.includes("stop-button") || selector.includes("Stop")) return stopBtn;
        if (selector === "body") return {};
        if (selector === "main") return {};
        return null;
      },
      querySelectorAll: () => [],
    } as never;
    const action = resolveChatGptAction(doc, editor);
    expect(action.kind).toBe("stop");
    expect(action.evidence).toBe("legacy_stop");
  });

  it("B. data-testid=composer-stop-button still stop", () => {
    const stopSlot = {
      className: "composer-submit-btn composer-submit-button-color",
      getAttribute: (n: string) => (n === "data-testid" ? "composer-stop-button" : null),
      hasAttribute: (n: string) => n === "data-testid",
      disabled: false,
    };
    const form = {
      querySelector: (s: string) =>
        s === "button.composer-submit-button-color" ? stopSlot : null,
      querySelectorAll: () => [stopSlot],
    };
    const editor = {
      getAttribute: (n: string) => (n === "contenteditable" ? "true" : null),
      hasAttribute: () => false,
      closest: (s: string) => (s === "form" ? form : null),
    };
    Object.defineProperty(editor, "textContent", {
      get: () => "",
      configurable: true,
    });
    const doc = {
      querySelector(selector: string) {
        if (selector.includes("ProseMirror") || selector === "#prompt-textarea") return editor;
        if (selector === "body") return {};
        if (selector === "main") return {};
        return null;
      },
      querySelectorAll: () => [],
    } as never;
    const action = resolveChatGptAction(doc, editor);
    expect(action.kind).toBe("stop");
    expect(action.evidence).toBe("action_slot_stop");
    const diag = inspectChatGptActionEvidence(doc, editor);
    expect(diag.stopEvidence?.source).toBe("composer_action_slot");
    expect(diag.stopEvidence?.dataTestId).toBe("composer-stop-button");
  });

  it("C. class-only stop fallback retained (composer-submit-btn, no text-submit-btn-text, no send testid)", () => {
    const classStop = {
      className: "composer-submit-btn composer-submit-button-color",
      getAttribute: () => null,
      hasAttribute: () => false,
      disabled: false,
    };
    const form = {
      querySelector: (s: string) =>
        s === "button.composer-submit-button-color" ? classStop : null,
      querySelectorAll: () => [classStop],
    };
    const editor = {
      getAttribute: (n: string) => (n === "contenteditable" ? "true" : null),
      hasAttribute: () => false,
      closest: (s: string) => (s === "form" ? form : null),
    };
    Object.defineProperty(editor, "textContent", {
      get: () => "",
      configurable: true,
    });
    const doc = {
      querySelector(selector: string) {
        if (selector.includes("ProseMirror") || selector === "#prompt-textarea") return editor;
        if (selector === "body") return {};
        if (selector === "main") return {};
        return null;
      },
      querySelectorAll: () => [],
    } as never;
    const action = resolveChatGptAction(doc, editor);
    expect(action.kind).toBe("stop");
    expect(action.evidence).toBe("action_slot_stop");
  });

  it("D. empty voice slot remains idle (text-submit-btn-text)", () => {
    const voice = {
      className: "composer-submit-button-color text-submit-btn-text",
      getAttribute: (n: string) => (n === "aria-label" ? "启动语音功能" : null),
      hasAttribute: () => false,
      disabled: false,
    };
    const form = {
      querySelector: (s: string) =>
        s === "button.composer-submit-button-color" ? voice : null,
      querySelectorAll: () => [voice],
    };
    const editor = {
      getAttribute: (n: string) => (n === "contenteditable" ? "true" : null),
      hasAttribute: () => false,
      closest: (s: string) => (s === "form" ? form : null),
    };
    Object.defineProperty(editor, "textContent", {
      get: () => "",
      configurable: true,
    });
    const doc = {
      querySelector(selector: string) {
        if (selector.includes("ProseMirror") || selector === "#prompt-textarea") return editor;
        if (selector === "body") return {};
        if (selector === "main") return {};
        return null;
      },
      querySelectorAll: () => [],
    } as never;
    const action = resolveChatGptAction(doc, editor);
    expect(action.kind).toBe("idle");
    expect(action.evidence).toBe("action_slot_idle");
  });

  it("document-wide explicit Stop still wins over form send (fail-closed, unchanged this round)", () => {
    const { doc, editor } = makeRealEdgeDirtySendDom({ withDocStop: true });
    const action = resolveChatGptAction(doc, editor);
    expect(action.kind).toBe("stop");
    expect(action.evidence).toBe("legacy_stop");
    const diag = inspectChatGptActionEvidence(doc, editor);
    expect(diag.stopEvidence?.source).toBe("document_stop_button");
    expect(diag.hasExactSendButton).toBe(true);
  });

  it("resolver and diagnostic share isComposerActionSlotStop semantics (source-level)", () => {
    const src = fs.readFileSync(path.join(companionRoot, "dom-adapter.js"), "utf8");
    expect(src).toMatch(/function isComposerActionSlotStop/);
    expect(src).toMatch(/isComposerActionSlotStop\(composerActionBtn\)/);
    // Exact send exclusion is first in shared helper.
    const helper = src.slice(
      src.indexOf("function isComposerActionSlotStop"),
      src.indexOf("function buttonMatchesKnownStop"),
    );
    expect(helper.indexOf('testid === "send-button"')).toBeGreaterThan(-1);
    expect(helper.indexOf('testid === "send-button"')).toBeLessThan(
      helper.indexOf("composer-submit-btn"),
    );
    // Diagnostic matcher also excludes send-button first.
    const matcher = src.slice(src.indexOf("function buttonMatchesKnownStop"));
    expect(matcher.indexOf('dataTestId === "send-button"')).toBeLessThan(
      matcher.indexOf("composer-submit-btn"),
    );
  });
});

describe("E1b3d1 packaging + runtime safety gates", () => {

  it("dom-adapter inventory source stays read-only and privacy-capped", () => {
    const src = fs.readFileSync(path.join(companionRoot, "dom-adapter.js"), "utf8");
    expect(src).toMatch(/export function inspectActiveComposerControls/);
    expect(src).toMatch(/export function inspectComposerContainerInventory/);
    expect(src).toMatch(/export function isExcludedEmbeddedEditor/);
    expect(src).toMatch(/INVENTORY_MAX_BUTTONS/);
    expect(src).toMatch(/INVENTORY_ATTR_MAX/);
    expect(src).toMatch(/INVENTORY_CLASS_MAX/);
    expect(src).toMatch(/CONTAINER_MAX_ANCESTORS/);
    expect(src).toMatch(/CONTAINER_MAX_CONTROL_CONTAINERS/);
    // Inventory helper must not emit user text / HTML / value.
    expect(src).toMatch(/No text\/HTML\/value\/nodes/);
    const inventoryFn = src.slice(src.indexOf("export function inspectActiveComposerControls"));
    const inventoryBody = inventoryFn.slice(0, inventoryFn.indexOf("export function summarizeStopButtonEvidence") > 0
      ? inventoryFn.indexOf("export function summarizeStopButtonEvidence")
      : inventoryFn.indexOf("export function inspectChatGptActionEvidence"));
    expect(inventoryBody).not.toMatch(/textContent/);
    expect(inventoryBody).not.toMatch(/innerHTML/);
    expect(inventoryBody).not.toMatch(/outerHTML/);
    expect(inventoryBody).not.toMatch(/\.value\b/);
    expect(inventoryBody).not.toMatch(/\.click\(/);
    expect(inventoryBody).not.toMatch(/\.focus\(/);

    const containerFn = src.slice(src.indexOf("export function inspectComposerContainerInventory"));
    const containerBody = containerFn.slice(0, containerFn.indexOf("export function summarizeStopButtonEvidence"));
    expect(containerBody).not.toMatch(/textContent/);
    expect(containerBody).not.toMatch(/innerHTML/);
    expect(containerBody).not.toMatch(/outerHTML/);
    expect(containerBody).not.toMatch(/\.value\b/);
    expect(containerBody).not.toMatch(/\.click\(/);
    expect(containerBody).not.toMatch(/\.focus\(/);
    // Must not walk the whole document for buttons.
    expect(containerBody).not.toMatch(/doc\.querySelectorAll/);
    expect(containerBody).not.toMatch(/document\.querySelectorAll/);
  });
});

describe("user-turn observer still available for shadow", () => {
  it("snapshotUserTurns / findCanonicalUserTurn remain read-only exports", () => {
    expect(typeof snapshotUserTurns).toBe("function");
    expect(typeof findCanonicalUserTurn).toBe("function");
  });
});
