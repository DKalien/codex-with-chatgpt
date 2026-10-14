import { describe, expect, it } from "vitest";

import fs from "node:fs";

import path from "node:path";

import { fileURLToPath } from "node:url";

import { inspectComposerWriteCapability, writeCanonicalMessage, verifyCanonicalComposer, buildProbeReadback, readCanonicalComposerText } from "../browser-companion/composer-write-adapter.js";

const WRITE_PROBE_MESSAGE = "[C2C_WRITE_PROBE]\nNONCE: 1\n仅验证编辑器写入，不发送。\n";

import { dispatchNativeSend } from "../browser-companion/send-click-adapter.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const companionRoot = path.join(projectRoot, "browser-companion");

const ROUTE = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";

function MESSAGE() {
  return "[C2C_CONTROL]\nSTATE: EXECUTED\nATTEMPT_ID: 22222222-2222-4222-8222-222222222222\n";
}

type Mode = "idle" | "send" | "stop" | "unknown" | "dirty" | "current-voice";

function makeComposerDom(opts: {
  mode?: Mode;
  text?: string;
  href?: string;
  textarea?: boolean;
  /** R3 2026-09-25 current-voice fixture controls (only for mode "current-voice"). */
  currentVoiceClass?: string;
  currentVoiceAria?: string;
  currentVoiceDisabled?: boolean;
} = {}) {
  const mode = opts.mode ?? "idle";
  const state = { text: opts.text ?? "" };
  const clicks: { n: number } = { n: 0 };

  const voice = {
    className: "composer-submit-button-color text-submit-btn-text",
    getAttribute: (n: string) => (n === "aria-label" ? "启动语音功能" : null),
    hasAttribute: () => false,
    disabled: false,
    click: () => {
      clicks.n += 1;
    },
  };
  const send = {
    className: "composer-submit-btn composer-submit-button-color",
    getAttribute: (n: string) =>
      n === "data-testid" ? "send-button" : n === "type" ? "submit" : n === "aria-label" ? "发送提示词" : null,
    hasAttribute: (n: string) => n === "data-testid",
    disabled: false,
    click: () => {
      clicks.n += 1;
    },
  };
  const stopSlot = {
    className: "composer-submit-btn composer-submit-button-color",
    getAttribute: (n: string) => (n === "data-testid" ? "composer-stop-button" : null),
    hasAttribute: (n: string) => n === "data-testid",
    disabled: false,
    click: () => {
      clicks.n += 1;
    },
  };
  // R3 2026-09-25 observed blank-composer voice control (real ChatGPT DOM):
  // 4 form buttons, main control carries exact aria + both structural tokens.
  const currentVoice = {
    className:
      opts.currentVoiceClass ?? "size-token-button-composer bg-composer-primary",
    getAttribute: (n: string) =>
      n === "aria-label" ? (opts.currentVoiceAria ?? "开始语音") : null,
    hasAttribute: () => false,
    disabled: opts.currentVoiceDisabled ?? false,
    click: () => {
      clicks.n += 1;
    },
  };
  const currentVoiceFillers = [0, 1, 2].map(() => ({
    className: "bg-token-button",
    getAttribute: () => null,
    hasAttribute: () => false,
    disabled: false,
  }));

  const form = {
    querySelector(selector: string) {
      if (selector === 'button[data-testid="send-button"]') {
        return mode === "send" ? send : null;
      }
      if (selector === "button.composer-submit-button-color") {
        if (mode === "idle") return voice;
        if (mode === "send") return send;
        if (mode === "stop") return stopSlot;
        return null;
      }
      return null;
    },
    querySelectorAll(selector: string) {
      if (mode === "current-voice") {
        if (selector === "button") return [...currentVoiceFillers, currentVoice];
        if (selector === 'button[aria-label="开始语音"]') {
          return (opts.currentVoiceAria ?? "开始语音") === "开始语音" ? [currentVoice] : [];
        }
        return [];
      }
      if (selector !== "button") return [];
      if (mode === "idle") return [voice];
      if (mode === "send") return [send];
      if (mode === "stop") return [stopSlot];
      return [];
    },
  };

  let editor: Record<string, unknown>;
  if (opts.textarea) {
    editor = {
      tagName: "TEXTAREA",
      getAttribute: (n: string) => (n === "data-id" ? "root" : null),
      hasAttribute: (n: string) => n === "data-id",
      closest: (s: string) => (s === "form" ? form : null),
      dispatchEvent: () => true,
    };
    Object.defineProperty(editor, "value", {
      get: () => state.text,
      set: (v: string) => {
        state.text = v;
      },
      configurable: true,
    });
  } else {
    editor = {
      tagName: "DIV",
      id: "prompt-textarea",
      className: "ProseMirror",
      getAttribute: (n: string) => (n === "contenteditable" ? "true" : null),
      hasAttribute: () => false,
      closest: (s: string) => (s === "form" ? form : null),
      focus: () => {},
    };
    Object.defineProperty(editor, "textContent", {
      get: () => state.text,
      set: (v: string) => {
        state.text = v;
      },
      configurable: true,
    });
  }

  const doc = {
    defaultView: {
      getSelection: () => ({
        removeAllRanges() {},
        addRange() {},
      }),
      Event: class Event {
        type: string;
        bubbles: boolean;
        constructor(type: string, init: { bubbles?: boolean } = {}) {
          this.type = type;
          this.bubbles = Boolean(init.bubbles);
        }
      },
      HTMLTextAreaElement: {
        prototype: {},
      },
    },
    createRange: () => ({ selectNodeContents() {} }),
    execCommand: (_cmd: string, _ui: boolean, value: string) => {
      state.text = value;
      return true;
    },
    queryCommandSupported: (cmd: string) => cmd === "insertText",
    querySelector(selector: string) {
      if (selector === "#prompt-textarea" && !opts.textarea) return editor;
      if (selector === 'textarea[data-id="root"]' && opts.textarea) return editor;
      if (selector.includes("ProseMirror") || selector.includes("contenteditable")) {
        return opts.textarea ? null : editor;
      }
      if (selector.includes("textarea")) return opts.textarea ? editor : null;
      if (selector === "body") return {};
      if (selector === "main") return {};
      if (mode === "stop" && (selector.includes("stop-button") || selector.includes("Stop"))) {
        return {
          getAttribute: (n: string) => (n === "aria-label" ? "Stop generating" : null),
          hasAttribute: () => false,
          disabled: false,
          click: () => {
            clicks.n += 1;
          },
        };
      }
      return null;
    },
    querySelectorAll: () => [],
  } as never;

  return { doc, editor, state, clicks, form };
}

describe("E1b3d2a write/send physical split", () => {
  it("composer-write-adapter has write APIs, zero click/dispatch/chrome/fetch", () => {
    const src = fs.readFileSync(path.join(companionRoot, "composer-write-adapter.js"), "utf8");
    const code = src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).toMatch(/export function inspectComposerWriteCapability/);
    expect(src).toMatch(/export function writeCanonicalMessage/);
    expect(src).toMatch(/export function verifyCanonicalComposer/);
    expect(code).not.toMatch(/dispatchNativeSend/);
    expect(code).not.toMatch(/\.click\(/);
    expect(code).not.toMatch(/chrome\.tabs/);
    expect(code).not.toMatch(/chrome\.runtime/);
    expect(code).not.toMatch(/fetch\(/);
    expect(code).not.toMatch(/begin-send/);
    expect(code).not.toMatch(/\/ack\b/);
    expect(code).not.toMatch(/journalActive|markReserved|markReserveRequested|SEND_INTENT/);
  });
});

describe("E1b3d2a real readback diagnostic (wrote semantics)", () => {
  const PROBE = WRITE_PROBE_MESSAGE;

  /**
   * ProseMirror-like block DOM: parent textContent concatenates without LF;
   * children are <p> blocks; innerText preserves visual newlines.
   */
  function makeBlockComposerDom(opts: {
    execCommandImpl?: "blocks" | "noFinalLf" | "exact" | "fail";
  } = {}) {
    const mode = opts.execCommandImpl ?? "blocks";
    const state = { blocks: [] as string[], textContentOverride: "", innerTextOverride: "" };
    const calls = { execCommand: 0, clicks: 0 };

    const children = {
      get length() {
        return state.blocks.length;
      },
      [Symbol.iterator]() {
        return state.blocks[Symbol.iterator]();
      },
      // Array-like access for kids[i]
    };
    // Make array-like for kids[i]
    const kidsProxy = new Proxy(children, {
      get(target, prop) {
        if (prop in target) return target[prop as keyof typeof target];
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          const i = Number(prop);
          const block = state.blocks[i];
          if (block === undefined) return undefined;
          return {
            tagName: "P",
            textContent: block,
          };
        }
        return undefined;
      },
      has(target, prop) {
        return prop in target || (typeof prop === "string" && /^\d+$/.test(prop));
      },
    });

    const editor: Record<string, unknown> = {
      tagName: "DIV",
      id: "prompt-textarea",
      className: "ProseMirror",
      getAttribute: (n: string) => (n === "contenteditable" ? "true" : null),
      hasAttribute: () => false,
      closest: (s: string) => (s === "form" ? { querySelector: () => null, querySelectorAll: () => [] } : null),
      focus: () => {},
      get children() {
        return kidsProxy;
      },
    };
    Object.defineProperty(editor, "textContent", {
      get() {
        // Parent textContent joins blocks WITHOUT newlines (real ProseMirror shape).
        return state.blocks.join("");
      },
      set(v: string) {
        state.blocks = v ? [v] : [];
      },
      configurable: true,
    });
    Object.defineProperty(editor, "innerText", {
      get() {
        return state.blocks.join("\n");
      },
      configurable: true,
    });

    const doc = {
      defaultView: {
        getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
        Event: class Event {
          type: string;
          bubbles: boolean;
          constructor(type: string, init: { bubbles?: boolean } = {}) {
            this.type = type;
            this.bubbles = Boolean(init.bubbles);
          }
        },
      },
      createRange: () => ({ selectNodeContents() {} }),
      execCommand: (_cmd: string, _ui: boolean, value: string) => {
        calls.execCommand += 1;
        if (mode === "fail") return false;
        if (mode === "blocks") {
          // Real Edge: trailing \n becomes empty final P — preserve it.
          state.blocks = String(value).split("\n");
          return true;
        }
        if (mode === "noFinalLf") {
          state.blocks = [String(value).replace(/\n$/, "")];
          return true;
        }
        // exact: parent textContent equals full message including final LF
        state.blocks = [String(value)];
        return true;
      },
      queryCommandSupported: (cmd: string) => cmd === "insertText",
      querySelector(selector: string) {
        if (selector === "#prompt-textarea" || selector.includes("ProseMirror") || selector.includes("contenteditable")) {
          return editor;
        }
        if (selector.includes("textarea")) return null;
        if (selector === "body") return {};
        if (selector === "main") return {};
        return null;
      },
      querySelectorAll: () => [],
    } as never;

    const voice = {
      className: "composer-submit-button-color text-submit-btn-text",
      getAttribute: (n: string) => (n === "aria-label" ? "启动语音功能" : null),
      hasAttribute: () => false,
      disabled: false,
      click: () => {
        calls.clicks += 1;
      },
    };
    // form for idle action slot
    const form = {
      querySelector: (s: string) => (s === "button.composer-submit-button-color" ? voice : null),
      querySelectorAll: (s: string) => (s === "button" ? [voice] : []),
    };
    (editor as { closest: (s: string) => unknown }).closest = (s: string) =>
      s === "form" ? form : null;

    return { doc, editor, state, calls };
  }

  it("buildProbeReadback never emits raw text/HTML/nodes", () => {
    const { editor } = makeBlockComposerDom({ execCommandImpl: "blocks" });
    // Seed blocks as if written.
    (editor as unknown as { textContent: string }).textContent = "abc";
    const rb = buildProbeReadback(editor, PROBE);
    const raw = JSON.stringify(rb);
    expect(raw).not.toContain("C2C_WRITE_PROBE");
    expect(raw).not.toContain("<");
    expect(raw).not.toContain("innerHTML");
    expect(raw).not.toContain("outerHTML");
    expect(Object.keys(rb!)).toEqual(["textContent", "innerText", "childBlocks", "canonical"]);
    expect(Object.keys(rb!.textContent).sort()).toEqual([
      "exact",
      "exactWithoutFinalLf",
      "length",
      "newlineCount",
    ]);
  });
});

describe("E1b3d2b canonical ProseMirror P-block reader", () => {
  function p(text: string) {
    return { tagName: "P", textContent: text };
  }
  function editable(blocks: { tagName: string; textContent: string }[]) {
    return {
      tagName: "DIV",
      id: "prompt-textarea",
      className: "ProseMirror",
      getAttribute: (n: string) => (n === "contenteditable" ? "true" : null),
      hasAttribute: () => false,
      closest: () => null,
      get children() {
        return {
          length: blocks.length,
          ...Object.fromEntries(blocks.map((b, i) => [String(i), b])),
        };
      },
      textContent: blocks.map((b) => b.textContent).join(""),
    };
  }

  it("A. empty one P → empty string", () => {
    const r = readCanonicalComposerText(editable([p("")]));
    expect(r.ok).toBe(true);
    expect(r.representation).toBe("prosemirror_p_blocks");
    if (r.ok) expect(r.text).toBe("");
  });

  it("B. one P text → that text", () => {
    const r = readCanonicalComposerText(editable([p("abc")]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("abc");
  });

  it("C. multiple P → join with LF", () => {
    const r = readCanonicalComposerText(editable([p("a"), p("b")]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("a\nb");
  });

  it("D. internal empty line preserved", () => {
    const r = readCanonicalComposerText(editable([p("a"), p(""), p("b")]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("a\n\nb");
  });

  it("E. terminal LF via empty final P", () => {
    const r = readCanonicalComposerText(editable([p("a"), p("")]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("a\n");
  });

  it("F. real Edge four-P probe fixture → exact WRITE_PROBE_MESSAGE", () => {
    const parts = WRITE_PROBE_MESSAGE.split("\n"); // 4 parts, last ""
    const r = readCanonicalComposerText(editable(parts.map((t) => p(t))));
    expect(r.ok).toBe(true);
    expect(r.representation).toBe("prosemirror_p_blocks");
    if (r.ok) expect(r.text).toBe(WRITE_PROBE_MESSAGE);
    expect(r.ok && r.text).not.toBe(WRITE_PROBE_MESSAGE.replace(/\n$/, ""));
  });

  it("textarea value path", () => {
    const ta = { tagName: "TEXTAREA", value: "hi", textContent: "", children: { length: 0 } };
    const r = readCanonicalComposerText(ta);
    expect(r.ok).toBe(true);
    expect(r.representation).toBe("textarea_value");
    if (r.ok) expect(r.text).toBe("hi");
  });

  it("no-element textContent fallback", () => {
    const ed = { tagName: "DIV", textContent: "simple", children: { length: 0 } };
    const r = readCanonicalComposerText(ed);
    expect(r.ok).toBe(true);
    expect(r.representation).toBe("text_content");
    if (r.ok) expect(r.text).toBe("simple");
  });

  it("unknown block structure fails closed", () => {
    const mixed = editable([{ tagName: "P", textContent: "a" }, { tagName: "DIV", textContent: "b" } as never]);
    const r = readCanonicalComposerText(mixed);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("composer_text_structure_unknown");

    const onlyDiv = editable([{ tagName: "DIV", textContent: "x" } as never]);
    expect(readCanonicalComposerText(onlyDiv).ok).toBe(false);
  });

  it("preflight dirty/unknown fail closed without parent-textContent empty guess", () => {
    const mixedDoc = {
      querySelector: (s: string) => {
        if (s === "#prompt-textarea" || s.includes("ProseMirror")) {
          return editable([{ tagName: "DIV", textContent: "" } as never]);
        }
        if (s === "body") return {};
        if (s === "main") return {};
        return null;
      },
      querySelectorAll: () => [],
    } as never;
    const r = inspectComposerWriteCapability(mixedDoc, { routeValid: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("composer_text_structure_unknown");
  });

  it("dispatchNativeSend uses same reader: exact P-block click once; mismatch zero click", () => {
    const sendBtn = {
      tagName: "BUTTON",
      getAttribute: (n: string) => (n === "data-testid" ? "send-button" : null),
      hasAttribute: (n: string) => n === "data-testid",
      disabled: false,
      clicks: 0,
      click() {
        this.clicks += 1;
      },
    };
    const form = {
      querySelector: (s: string) =>
        s === 'button[data-testid="send-button"]' ? sendBtn : null,
      querySelectorAll: () => [sendBtn],
    };
    const parts = WRITE_PROBE_MESSAGE.split("\n");
    const editor = {
      ...editable(parts.map((t) => p(t))),
      closest: (s: string) => (s === "form" ? form : null),
    };
    const doc = {
      querySelector(selector: string) {
        if (selector === "#prompt-textarea" || selector.includes("ProseMirror") || selector.includes("contenteditable")) {
          return editor;
        }
        if (selector.includes("textarea")) return null;
        if (selector === "body") return {};
        if (selector === "main") return {};
        return null;
      },
      querySelectorAll: () => [],
    } as never;
    expect(dispatchNativeSend(doc, WRITE_PROBE_MESSAGE, { routeValid: true }).ok).toBe(true);
    expect(sendBtn.clicks).toBe(1);

    const editorBad = {
      ...editable([p(WRITE_PROBE_MESSAGE.replace("1", "2"))]),
      closest: (s: string) => (s === "form" ? form : null),
    };
    const docBad = {
      querySelector(selector: string) {
        if (selector === "#prompt-textarea" || selector.includes("ProseMirror") || selector.includes("contenteditable")) {
          return editorBad;
        }
        if (selector === "body") return {};
        if (selector === "main") return {};
        return null;
      },
      querySelectorAll: () => [],
    } as never;
    const before = sendBtn.clicks;
    expect(dispatchNativeSend(docBad, WRITE_PROBE_MESSAGE, { routeValid: true }).ok).toBe(false);
    expect(sendBtn.clicks).toBe(before);

    const editorUnknown = {
      ...editable([{ tagName: "SPAN", textContent: "x" } as never]),
      closest: (s: string) => (s === "form" ? form : null),
    };
    const docUnknown = {
      querySelector(selector: string) {
        if (selector === "#prompt-textarea" || selector.includes("ProseMirror") || selector.includes("contenteditable")) {
          return editorUnknown;
        }
        if (selector === "body") return {};
        if (selector === "main") return {};
        return null;
      },
      querySelectorAll: () => [],
    } as never;
    expect(dispatchNativeSend(docUnknown, WRITE_PROBE_MESSAGE, { routeValid: true }).ok).toBe(false);
    expect(sendBtn.clicks).toBe(before);
  });

  it("execCommand false + non-empty canonical readback → wrote truthfully true", () => {
    // Custom fixture: execCommand returns false but still mutates blocks.
    const state = { blocks: [] as string[] };
    const editor = {
      tagName: "DIV",
      id: "prompt-textarea",
      className: "ProseMirror",
      getAttribute: (n: string) => (n === "contenteditable" ? "true" : null),
      hasAttribute: () => false,
      closest: (s: string) =>
        s === "form"
          ? {
              querySelector: () => ({
                className: "composer-submit-button-color text-submit-btn-text",
                getAttribute: (n: string) => (n === "aria-label" ? "启动语音功能" : null),
                hasAttribute: () => false,
                disabled: false,
              }),
              querySelectorAll: () => [],
            }
          : null,
      focus: () => {},
      get children() {
        return {
          length: state.blocks.length,
          ...Object.fromEntries(state.blocks.map((t, i) => [String(i), { tagName: "P", textContent: t }])),
        };
      },
      textContent: state.blocks.join(""),
    };
    const doc = {
      defaultView: {
        getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
        Event: class {
          type: string;
          bubbles: boolean;
          constructor(type: string) {
            this.type = type;
            this.bubbles = true;
          }
        },
      },
      createRange: () => ({ selectNodeContents() {} }),
      execCommand: (_c: string, _u: boolean, v: string) => {
        state.blocks = String(v).split("\n");
        return false;
      },
      queryCommandSupported: () => true,
      querySelector(selector: string) {
        if (selector === "#prompt-textarea" || selector.includes("ProseMirror") || selector.includes("contenteditable")) {
          return editor;
        }
        if (selector === "body") return {};
        if (selector === "main") return {};
        return null;
      },
      querySelectorAll: () => [],
    } as never;
    const r = writeCanonicalMessage(doc, WRITE_PROBE_MESSAGE, { routeValid: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("editing_primitive_unavailable");
    expect(r.mutationAttempted).toBe(true);
    expect(r.wrote).toBe(true);
  });
});

describe("E1b3d2a final mutation fence (TOCTOU)", () => {
  const OTHER_ROUTE = "https://chatgpt.com/c/99999999-9999-4999-8999-999999999999";

  function makeToctouDom(opts: {
    driftOn?: "focus" | "addRange" | "beforeSetter";
    textarea?: boolean;
  } = {}) {
    const state = { text: "", href: ROUTE };
    const calls = {
      focus: 0,
      execCommand: 0,
      addRange: 0,
      setter: 0,
      dispatchEvent: 0,
      clicks: 0,
    };

    const voice = {
      className: "composer-submit-button-color text-submit-btn-text",
      getAttribute: (n: string) => (n === "aria-label" ? "启动语音功能" : null),
      hasAttribute: () => false,
      disabled: false,
      click: () => {
        calls.clicks += 1;
      },
    };
    const form = {
      querySelector: (s: string) =>
        s === "button.composer-submit-button-color" ? voice : null,
      querySelectorAll: (s: string) => (s === "button" ? [voice] : []),
    };

    let editor: Record<string, unknown>;
    if (opts.textarea) {
      let setterCalls = 0;
      editor = {
        tagName: "TEXTAREA",
        getAttribute: (n: string) => (n === "data-id" ? "root" : null),
        hasAttribute: (n: string) => n === "data-id",
        closest: (s: string) => (s === "form" ? form : null),
        dispatchEvent: () => {
          calls.dispatchEvent += 1;
          return true;
        },
      };
      Object.defineProperty(editor, "value", {
        get: () => state.text,
        set(v: string) {
          setterCalls += 1;
          calls.setter = setterCalls;
          if (opts.driftOn === "beforeSetter") {
            state.href = OTHER_ROUTE;
          }
          state.text = v;
        },
        configurable: true,
      });
    } else {
      editor = {
        tagName: "DIV",
        id: "prompt-textarea",
        className: "ProseMirror",
        getAttribute: (n: string) => (n === "contenteditable" ? "true" : null),
        hasAttribute: () => false,
        closest: (s: string) => (s === "form" ? form : null),
        focus: () => {
          calls.focus += 1;
          if (opts.driftOn === "focus") {
            state.href = OTHER_ROUTE;
          }
        },
      };
      Object.defineProperty(editor, "textContent", {
        get: () => state.text,
        set: (v: string) => {
          state.text = v;
        },
        configurable: true,
      });
    }

    const doc = {
      defaultView: {
        getSelection: () => ({
          removeAllRanges() {},
          addRange() {
            calls.addRange += 1;
            if (opts.driftOn === "addRange") {
              state.href = OTHER_ROUTE;
            }
          },
        }),
        Event: class Event {
          type: string;
          bubbles: boolean;
          constructor(type: string, init: { bubbles?: boolean } = {}) {
            this.type = type;
            this.bubbles = Boolean(init.bubbles);
          }
        },
        HTMLTextAreaElement: {
          prototype: Object.defineProperty({}, "value", {
            get() {
              return state.text;
            },
            set(v: string) {
              calls.setter += 1;
              if (opts.driftOn === "beforeSetter") {
                state.href = OTHER_ROUTE;
              }
              state.text = v;
            },
            configurable: true,
          }),
        },
      },
      createRange: () => ({ selectNodeContents() {} }),
      execCommand: (_cmd: string, _ui: boolean, value: string) => {
        calls.execCommand += 1;
        state.text = value;
        return true;
      },
      queryCommandSupported: (cmd: string) => cmd === "insertText",
      querySelector(selector: string) {
        if (selector === "#prompt-textarea" && !opts.textarea) return editor;
        if (selector === 'textarea[data-id="root"]' && opts.textarea) return editor;
        if (selector.includes("ProseMirror") || selector.includes("contenteditable")) {
          return opts.textarea ? null : editor;
        }
        if (selector.includes("textarea")) return opts.textarea ? editor : null;
        if (selector === "body") return {};
        if (selector === "main") return {};
        return null;
      },
      querySelectorAll: () => [],
    } as never;

    const getCurrentHref = () => state.href;
    return { doc, editor, state, calls, getCurrentHref };
  }

  it("focus-triggered route drift: execCommand=0, text empty, write_probe_route_drift", () => {
    const { doc, state, calls, getCurrentHref } = makeToctouDom({ driftOn: "focus" });
    const r = writeCanonicalMessage(doc, WRITE_PROBE_MESSAGE, {
      routeValid: true,
      mutationGuard: () => getCurrentHref() === ROUTE,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("write_probe_route_drift");
    expect(r.wrote).toBe(false);
    expect(calls.focus).toBeGreaterThan(0);
    expect(calls.execCommand).toBe(0);
    expect(state.text).toBe("");
    expect(calls.clicks).toBe(0);
  });

  it("selection-triggered route drift after addRange: execCommand still blocked", () => {
    const { doc, state, calls, getCurrentHref } = makeToctouDom({ driftOn: "addRange" });
    const r = writeCanonicalMessage(doc, WRITE_PROBE_MESSAGE, {
      routeValid: true,
      mutationGuard: () => getCurrentHref() === ROUTE,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("write_probe_route_drift");
    expect(calls.focus).toBeGreaterThan(0);
    expect(calls.addRange).toBeGreaterThan(0);
    expect(calls.execCommand).toBe(0);
    expect(state.text).toBe("");
    expect(calls.clicks).toBe(0);
  });

  it("textarea native-setter drift: no setter, no input event, value unchanged", () => {
    // 最后 mutationGuard 读取当前页面，导航变化时禁止 native setter。
    const getCurrentHref = () => OTHER_ROUTE;
    const { doc, calls } = makeToctouDom({ textarea: true });
    const r = writeCanonicalMessage(doc, WRITE_PROBE_MESSAGE, {
      routeValid: true,
      mutationGuard: () => getCurrentHref() === ROUTE,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("write_probe_route_drift");
    expect(r.wrote).toBe(false);
    expect(calls.setter).toBe(0);
    expect(calls.dispatchEvent).toBe(0);
    expect(calls.clicks).toBe(0);
  });

  it("stable route: write once + verify exact + zero Send/click (success regression)", () => {
    const { doc, state, calls, getCurrentHref } = makeToctouDom({});
    const r = writeCanonicalMessage(doc, WRITE_PROBE_MESSAGE, {
      routeValid: true,
      mutationGuard: () => getCurrentHref() === ROUTE,
    });
    expect(r.ok).toBe(true);
    expect(r.wrote).toBe(true);
    expect(verifyCanonicalComposer(doc, WRITE_PROBE_MESSAGE, { routeValid: true }).ok).toBe(true);
    expect(state.text).toBe(WRITE_PROBE_MESSAGE);
    expect(calls.execCommand).toBe(1);
    expect(calls.clicks).toBe(0);
  });

  it("source: mutationGuard sits immediately before execCommand / setNativeValue", () => {
    const src = fs.readFileSync(path.join(companionRoot, "composer-write-adapter.js"), "utf8");
    const ce = src.slice(src.indexOf("function writeContentEditable"));
    const ceBody = ce.slice(0, ce.indexOf("export function verifyCanonicalComposer"));
    const guardIdx = ceBody.indexOf("runMutationGuard");
    const execIdx = ceBody.indexOf('doc.execCommand("insertText"');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(execIdx).toBeGreaterThan(guardIdx);
    // No await between guard and execCommand.
    const between = ceBody.slice(guardIdx, execIdx);
    expect(between).not.toMatch(/\bawait\b/);

    const ta = src.slice(src.indexOf("export function writeCanonicalMessage"));
    const taBody = ta.slice(0, ta.indexOf("function writeContentEditable"));
    const taGuard = taBody.indexOf("runMutationGuard");
    const taSet = taBody.indexOf("setNativeValue(editor, message, win)");
    expect(taGuard).toBeGreaterThan(-1);
    expect(taSet).toBeGreaterThan(taGuard);
    expect(taBody.slice(taGuard, taSet)).not.toMatch(/\bawait\b/);

  });

  it("writeCanonicalMessage mutationGuard: false/throw fail closed without write", () => {
    const { doc, state, calls } = makeToctouDom({});
    const blocked = writeCanonicalMessage(doc, "hello", {
      routeValid: true,
      mutationGuard: () => false,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe("write_probe_route_drift");
    expect(state.text).toBe("");
    expect(calls.execCommand).toBe(0);

    const thrown = writeCanonicalMessage(doc, "hello", {
      routeValid: true,
      mutationGuard: () => {
        throw new Error("boom");
      },
    });
    expect(thrown.ok).toBe(false);
    expect(thrown.reason).toBe("write_probe_route_drift");
    expect(state.text).toBe("");
    expect(calls.execCommand).toBe(0);
  });
});

describe("E1b3d2a R3 current-voice idle adaptation", () => {
  it("write capability accepts current-voice idle; voice control not retained; zero clicks", () => {
    const { doc, clicks } = makeComposerDom({ mode: "current-voice" });
    const cap = inspectComposerWriteCapability(doc, { routeValid: true });
    expect(cap.ok).toBe(true);
    if (cap.ok) {
      expect(cap.action.kind).toBe("idle");
      expect(cap.action.enabled).toBe(true);
      expect(cap.action.evidence).toBe("current_voice_idle");
      expect(cap.action.button).toBeNull();
    }
    expect(clicks.n).toBe(0);
  });

  it("aria matches but class token missing => capability fail-closed generation_unknown", () => {
    const { doc } = makeComposerDom({
      mode: "current-voice",
      currentVoiceClass: "bg-composer-primary",
    });
    const cap = inspectComposerWriteCapability(doc, { routeValid: true });
    expect(cap.ok).toBe(false);
    if (!cap.ok) expect(cap.reason).toBe("generation_unknown");
  });

  it("different aria => capability fail-closed generation_unknown", () => {
    const { doc } = makeComposerDom({
      mode: "current-voice",
      currentVoiceAria: "语音输入",
    });
    const cap = inspectComposerWriteCapability(doc, { routeValid: true });
    expect(cap.ok).toBe(false);
    if (!cap.ok) expect(cap.reason).toBe("generation_unknown");
  });

  it("disabled current voice => capability fail-closed (no disabled-idle this slice)", () => {
    const { doc } = makeComposerDom({ mode: "current-voice", currentVoiceDisabled: true });
    const cap = inspectComposerWriteCapability(doc, { routeValid: true });
    expect(cap.ok).toBe(false);
    if (!cap.ok) expect(cap.reason).toBe("generation_unknown");
  });

  it("write accepted on idle evidence; post-write send re-resolution fails closed with zero clicks", () => {
    const { doc, clicks } = makeComposerDom({ mode: "current-voice" });
    const w = writeCanonicalMessage(doc, MESSAGE(), { routeValid: true });
    expect(w.ok).toBe(true);
    const v = verifyCanonicalComposer(doc, MESSAGE(), { routeValid: true });
    expect(v.ok).toBe(true);
    // After write the click path must re-resolve the exact send-button; the
    // static current fixture offers none, so send fails closed (no voice click).
    const r = dispatchNativeSend(doc, MESSAGE(), { routeValid: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("send_action_not_ready");
    expect(clicks.n).toBe(0);
  });
});
