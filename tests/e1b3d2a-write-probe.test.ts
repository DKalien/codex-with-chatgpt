import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectComposerWriteCapability,
  writeCanonicalMessage,
  verifyCanonicalComposer,
  runWriteProbe,
  buildProbeReadback,
  readCanonicalComposerText,
} from "../browser-companion/composer-write-adapter.js";
import {
  WRITE_PROBE_MESSAGE,
  buildWriteProbeRequest,
  validateWriteProbeResponse,
  parseChatgptRouteStrict,
  resolveMutationCanonicalRoute,
} from "../browser-companion/write-probe.js";
import { parseChatgptConversationRoute } from "../src/chatgpt/route.js";
import { dispatchNativeSend } from "../browser-companion/send-adapter.js";
import { resolveChatGptComposer, resolveChatGptAction } from "../browser-companion/dom-adapter.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const companionRoot = path.join(projectRoot, "browser-companion");
const distCompanion = path.join(projectRoot, "dist", "browser-companion");

const ROUTE = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const GPT_ROUTE = "https://chatgpt.com/g/g-p-example/c/11111111-1111-4111-8111-111111111111";
const GPT_ROUTE_B = "https://chatgpt.com/g/g-p-b/c/11111111-1111-4111-8111-111111111111";

/** Companion shared route parser (single mutation-fence authority). */
function sharedParse(href: string) {
  return parseChatgptConversationRoute(href, {
    allowQueryOrHash: false,
    conversationIdPolicy: "uuid",
  });
}

function MESSAGE() {
  return "[C2C_CONTROL]\nSTATE: EXECUTED\nATTEMPT_ID: 22222222-2222-4222-8222-222222222222\n";
}

type Mode = "idle" | "send" | "stop" | "unknown" | "dirty";

function makeComposerDom(opts: {
  mode?: Mode;
  text?: string;
  href?: string;
  textarea?: boolean;
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
    expect(src).toMatch(/export function runWriteProbe/);
    expect(code).not.toMatch(/dispatchNativeSend/);
    expect(code).not.toMatch(/\.click\(/);
    expect(code).not.toMatch(/chrome\.tabs/);
    expect(code).not.toMatch(/chrome\.runtime/);
    expect(code).not.toMatch(/fetch\(/);
    expect(code).not.toMatch(/begin-send/);
    expect(code).not.toMatch(/\/ack\b/);
    expect(code).not.toMatch(/journalActive|markReserved|markReserveRequested|SEND_INTENT/);
  });

  it("send-adapter re-exports write APIs and keeps dispatchNativeSend only for click", () => {
    const src = fs.readFileSync(path.join(companionRoot, "send-adapter.js"), "utf8");
    expect(src).toMatch(/from "\.\/composer-write-adapter\.js"/);
    expect(src).toMatch(/inspectComposerWriteCapability/);
    expect(src).toMatch(/writeCanonicalMessage/);
    expect(src).toMatch(/verifyCanonicalComposer/);
    expect(src).toMatch(/from "\.\/send-click-adapter\.js"/);
    expect(src).toMatch(/dispatchNativeSend/);
    // Runtime still must not load send-adapter.
    const manifest = JSON.parse(fs.readFileSync(path.join(companionRoot, "manifest.json"), "utf8"));
    const js = (manifest.content_scripts ?? []).flatMap((cs: { js?: string[] }) => cs.js ?? []);
    expect(js).toContain("composer-write-adapter.js");
    expect(js).not.toContain("send-adapter.js");
    expect(js).not.toContain("send-orchestrator.js");
  });

  it("dispatchNativeSend still works via re-export path (compat)", () => {
    const { doc, clicks } = makeComposerDom({ mode: "send", text: MESSAGE() });
    const r = dispatchNativeSend(doc, MESSAGE(), { routeValid: true });
    expect(r.ok).toBe(true);
    expect(clicks.n).toBe(1);
  });
});

describe("E1b3d2a fixed write probe message", () => {
  it("is a fixed multiline constant; popup cannot supply message", () => {
    expect(WRITE_PROBE_MESSAGE).toBe("[C2C_WRITE_PROBE]\nNO_SEND=1\nTOKEN=e1b3d2\n");
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    expect(sw).toMatch(/write_probe_payload_forbidden/);
    expect(sw).toMatch(/c2c\.write\.probe\.request/);
    const popup = fs.readFileSync(path.join(companionRoot, "popup", "popup.js"), "utf8");
    expect(popup).toMatch(/c2c\.write\.probe\.request/);
    const html = fs.readFileSync(path.join(companionRoot, "popup", "popup.html"), "utf8");
    expect(html).toMatch(/Write probe text \(NO SEND\)/);
    expect(html).toMatch(/WRITES COMPOSER — DOES NOT SEND/);
    expect(popup).not.toMatch(/type:\s*"c2c\.write\.probe\.request",\s*message:/);
  });
});

describe("E1b3d2a write probe success path", () => {
  it("empty idle primary composer: write once, exact multiline, verify, zero click", () => {
    const { doc, state, clicks } = makeComposerDom({ mode: "idle", text: "" });
    const r = runWriteProbe(doc, {
      expectedRoute: ROUTE,
      expectedGeneration: 7,
      locationHref: ROUTE,
      parseRoute: sharedParse,
      localGeneration: 7,
    });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe("write_probe_no_send");
    expect(r.wrote).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.noSend).toBe(true);
    expect(r.editorKind).toBe("contenteditable");
    expect(r.composerEvidence).toBe("prompt_textarea");
    expect(r.generation).toBe(7);
    expect(r.canonicalRoute).toBe(ROUTE);
    expect(state.text).toBe(WRITE_PROBE_MESSAGE);
    expect(state.text.split("\n").length).toBeGreaterThan(2);
    expect(clicks.n).toBe(0);
  });

  it("GPT-shaped route /g/g-.../c/<uuid>: full canonical match, write once, zero Send", () => {
    const { doc, state, clicks } = makeComposerDom({ mode: "idle", text: "" });
    const r = runWriteProbe(doc, {
      expectedRoute: GPT_ROUTE,
      expectedGeneration: 5,
      locationHref: GPT_ROUTE,
      parseRoute: sharedParse,
      localGeneration: 5,
    });
    expect(r.ok).toBe(true);
    expect(r.wrote).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.canonicalRoute).toBe(GPT_ROUTE);
    expect(state.text).toBe(WRITE_PROBE_MESSAGE);
    expect(clicks.n).toBe(0);
  });

  it("same conversation UUID but different GPT prefix → route_drift, zero write", () => {
    const { doc, state, clicks } = makeComposerDom({ mode: "idle", text: "" });
    const r = runWriteProbe(doc, {
      expectedRoute: GPT_ROUTE,
      expectedGeneration: 5,
      locationHref: GPT_ROUTE_B,
      parseRoute: sharedParse,
      localGeneration: 5,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("write_probe_route_drift");
    expect(state.text).toBe("");
    expect(clicks.n).toBe(0);
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

  it("A. block DOM: P-block canonical reader recovers exact probe → write succeeds", () => {
    const { doc, state, calls } = makeBlockComposerDom({ execCommandImpl: "blocks" });
    const r = runWriteProbe(doc, {
      expectedRoute: ROUTE,
      expectedGeneration: 1,
      locationHref: ROUTE,
      parseRoute: sharedParse,
      localGeneration: 1,
    });
    // Real Edge shape: 4 P including empty final → join("\n") === WRITE_PROBE_MESSAGE.
    expect(r.ok).toBe(true);
    expect(r.wrote).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.mutationAttempted).toBe(true);
    expect(calls.execCommand).toBe(1);
    expect(calls.clicks).toBe(0);
    expect(state.blocks.length).toBe(4);
    expect(state.blocks[3]).toBe("");
    expect(r.readback?.canonical?.representation).toBe("prosemirror_p_blocks");
    expect(r.readback?.canonical?.exact).toBe(true);
  });

  it("B. trailing-LF only mismatch: exact=false exactWithoutFinalLf=true; verify still fails", () => {
    const { doc } = makeBlockComposerDom({ execCommandImpl: "noFinalLf" });
    const r = runWriteProbe(doc, {
      expectedRoute: ROUTE,
      expectedGeneration: 1,
      locationHref: ROUTE,
      parseRoute: sharedParse,
      localGeneration: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("composer_write_mismatch");
    expect(r.wrote).toBe(true);
    expect(r.mutationAttempted).toBe(true);
    expect(r.verified).toBe(false);
    const rb = r.readback!;
    expect(rb.textContent.exact).toBe(false);
    expect(rb.textContent.exactWithoutFinalLf).toBe(true);
    expect(rb.canonical?.representation).toBe("prosemirror_p_blocks");
    expect(rb.canonical?.exact).toBe(false);
  });

  it("C. pre-mutation route drift: wrote=false mutationAttempted=false", () => {
    const { doc, clicks } = makeComposerDom({ mode: "idle", text: "" });
    const r = runWriteProbe(doc, {
      expectedRoute: ROUTE,
      expectedGeneration: 1,
      locationHref: "https://chatgpt.com/c/99999999-9999-4999-8999-999999999999",
      parseRoute: sharedParse,
      localGeneration: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("write_probe_route_drift");
    expect(r.wrote).toBe(false);
    expect(r.mutationAttempted).toBe(false);
    expect(clicks.n).toBe(0);
  });

  it("D. stable synthetic exact: wrote=true verified=true mutationAttempted=true zero Send", () => {
    const { doc, state, clicks } = makeComposerDom({ mode: "idle", text: "" });
    const r = runWriteProbe(doc, {
      expectedRoute: ROUTE,
      expectedGeneration: 4,
      locationHref: ROUTE,
      parseRoute: sharedParse,
      localGeneration: 4,
    });
    expect(r.ok).toBe(true);
    expect(r.wrote).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.mutationAttempted).toBe(true);
    expect(state.text).toBe(WRITE_PROBE_MESSAGE);
    expect(clicks.n).toBe(0);
    expect(r.readback?.textContent.exact).toBe(true);
  });

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

  it("CS/SW source carries mutationAttempted + readback; popup renders them", () => {
    const cs = fs.readFileSync(path.join(companionRoot, "content-script.js"), "utf8");
    expect(cs).toMatch(/mutationAttempted/);
    expect(cs).toMatch(/readback/);
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    expect(sw).toMatch(/mutationAttempted/);
    expect(sw).toMatch(/readback/);
    const popup = fs.readFileSync(path.join(companionRoot, "popup", "popup.js"), "utf8");
    expect(popup).toMatch(/mutationAttempted=/);
    expect(popup).toMatch(/textContent: len=/);
    expect(popup).toMatch(/NO SEND PERFORMED/);
    const adapter = fs.readFileSync(path.join(companionRoot, "composer-write-adapter.js"), "utf8");
    expect(adapter).toMatch(/export function buildProbeReadback/);
    expect(adapter).toMatch(/mutationAttempted: true/);
  });

  it("validateWriteProbeResponse preserves wrote=true on composer_write_mismatch", () => {
    const owner = { tabId: 1, documentId: "d", canonicalRoute: ROUTE, generation: 2 };
    const transport = { routeCanonical: ROUTE, authStale: false };
    const v = validateWriteProbeResponse(
      {
        ok: false,
        reason: "composer_write_mismatch",
        wrote: true,
        verified: false,
        mutationAttempted: true,
        mode: "write_probe_no_send",
        noSend: true,
        canonicalRoute: ROUTE,
        generation: 2,
        readback: { textContent: { length: 10, exact: false } },
      },
      owner,
      transport,
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("composer_write_mismatch");
    expect(v.wrote).toBe(true);
    expect(v.verified).toBe(false);
    expect(v.mutationAttempted).toBe(true);
    expect(v.readback).toBeTruthy();
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
    const r = runWriteProbe(doc, {
      expectedRoute: ROUTE,
      expectedGeneration: 3,
      locationHref: ROUTE,
      parseRoute: sharedParse,
      localGeneration: 3,
      getCurrentHref,
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
    const r = runWriteProbe(doc, {
      expectedRoute: ROUTE,
      expectedGeneration: 3,
      locationHref: ROUTE,
      parseRoute: sharedParse,
      localGeneration: 3,
      getCurrentHref,
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
    // With locationHref provided: read1 = prewrite D, read2 = mutationGuard.
    // Flip on read 2 so only the last fence sees OTHER_ROUTE.
    let reads = 0;
    const getCurrentHref = () => {
      reads += 1;
      if (reads >= 2) return OTHER_ROUTE;
      return ROUTE;
    };
    const { doc, calls } = makeToctouDom({ textarea: true });
    const r = runWriteProbe(doc, {
      expectedRoute: ROUTE,
      expectedGeneration: 2,
      locationHref: ROUTE,
      parseRoute: sharedParse,
      localGeneration: 2,
      getCurrentHref,
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
    const r = runWriteProbe(doc, {
      expectedRoute: ROUTE,
      expectedGeneration: 9,
      locationHref: ROUTE,
      parseRoute: sharedParse,
      localGeneration: 9,
      getCurrentHref,
    });
    expect(r.ok).toBe(true);
    expect(r.wrote).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.noSend).toBe(true);
    expect(state.text).toBe(WRITE_PROBE_MESSAGE);
    expect(calls.execCommand).toBe(1);
    expect(calls.clicks).toBe(0);
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

    // runWriteProbe builds live href guard via shared parser, not a cached boolean.
    const probe = src.slice(src.indexOf("export function runWriteProbe"));
    expect(probe).toMatch(/mutationGuard/);
    expect(probe).toMatch(/getCurrentHref|readHref/);
    expect(probe).toMatch(/resolveMutationCanonicalRoute/);
    expect(probe).toMatch(/parseRoute/);
    // No independent pathname regex left in write-probe mutation authority.
    const wp = fs.readFileSync(path.join(companionRoot, "write-probe.js"), "utf8");
    expect(wp).toMatch(/parseChatgptConversationRoute/);
    expect(wp).not.toMatch(/^\/c\\\/\(\[0-9a-fA-F\]/m);
  });
});

describe("E1b3d2a write probe negative fences", () => {
  it("dirty composer → zero write", () => {
    const { doc, state, clicks } = makeComposerDom({ mode: "idle", text: "already here" });
    const before = state.text;
    const r = runWriteProbe(doc, {
      expectedRoute: ROUTE,
      expectedGeneration: 1,
      locationHref: ROUTE,
      parseRoute: sharedParse,
      localGeneration: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("composer_dirty");
    expect(state.text).toBe(before);
    expect(clicks.n).toBe(0);
  });

  it("action=stop → zero write", () => {
    const { doc, state, clicks } = makeComposerDom({ mode: "stop", text: "" });
    const r = runWriteProbe(doc, {
      expectedRoute: ROUTE,
      expectedGeneration: 1,
      locationHref: ROUTE,
      parseRoute: sharedParse,
      localGeneration: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("generation_active");
    expect(state.text).toBe("");
    expect(clicks.n).toBe(0);
  });

  it("action=unknown → zero write", () => {
    const { doc, state, clicks } = makeComposerDom({ mode: "unknown", text: "" });
    const r = runWriteProbe(doc, {
      expectedRoute: ROUTE,
      expectedGeneration: 1,
      locationHref: ROUTE,
      parseRoute: sharedParse,
      localGeneration: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("generation_unknown");
    expect(state.text).toBe("");
    expect(clicks.n).toBe(0);
  });

  it("wrong route → zero write", () => {
    const { doc, state, clicks } = makeComposerDom({ mode: "idle", text: "" });
    const r = runWriteProbe(doc, {
      expectedRoute: ROUTE,
      expectedGeneration: 1,
      locationHref: "https://chatgpt.com/c/99999999-9999-4999-8999-999999999999",
      parseRoute: sharedParse,
      localGeneration: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("write_probe_route_drift");
    expect(state.text).toBe("");
    expect(clicks.n).toBe(0);
  });

  it("generation mismatch → zero write", () => {
    const { doc, state, clicks } = makeComposerDom({ mode: "idle", text: "" });
    const r = runWriteProbe(doc, {
      expectedRoute: ROUTE,
      expectedGeneration: 3,
      locationHref: ROUTE,
      parseRoute: sharedParse,
      localGeneration: 4,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("write_probe_generation_mismatch");
    expect(state.text).toBe("");
    expect(clicks.n).toBe(0);
  });

  it("second probe after successful write is rejected as dirty (no auto-clear)", () => {
    const { doc, state, clicks } = makeComposerDom({ mode: "idle", text: "" });
    const first = runWriteProbe(doc, {
      expectedRoute: ROUTE,
      expectedGeneration: 2,
      locationHref: ROUTE,
      parseRoute: sharedParse,
      localGeneration: 2,
    });
    expect(first.ok).toBe(true);
    const second = runWriteProbe(doc, {
      expectedRoute: ROUTE,
      expectedGeneration: 2,
      locationHref: ROUTE,
      parseRoute: sharedParse,
      localGeneration: 2,
    });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("composer_dirty");
    expect(state.text).toBe(WRITE_PROBE_MESSAGE);
    expect(clicks.n).toBe(0);
  });
});

describe("E1b3d2a SW write-probe contract (pure)", () => {
  const owner = {
    tabId: 5,
    documentId: "doc-1",
    canonicalRoute: ROUTE,
    generation: 11,
  };
  const transport = { routeCanonical: ROUTE, authStale: false };

  it("buildWriteProbeRequest uses sendOptions.documentId + fixed type", () => {
    const req = buildWriteProbeRequest(owner, transport);
    expect(req.ok).toBe(true);
    expect(req.tabId).toBe(5);
    expect(req.sendOptions).toEqual({ documentId: "doc-1" });
    expect(req.message.type).toBe("c2c.write.probe.execute");
    expect(req.message.expectedRoute).toBe(ROUTE);
    expect(req.message.expectedGeneration).toBe(11);
  });

  it("rejects invalid owner / authStale / route mismatch / missing generation", () => {
    expect(buildWriteProbeRequest({ ...owner, documentId: "" }, transport).reason)
      .toBe("owner_document_invalid");
    expect(buildWriteProbeRequest(owner, { ...transport, authStale: true }).reason)
      .toBe("auth_stale");
    expect(buildWriteProbeRequest(
      { ...owner, canonicalRoute: ROUTE.replace("1111", "9999") },
      transport,
    ).reason).toBe("owner_route_mismatch");
    expect(buildWriteProbeRequest({ ...owner, generation: undefined as unknown as number }, transport)
      .reason).toBe("owner_generation_missing");
  });

  it("validateWriteProbeResponse requires mode/noSend/route/generation AND wrote+verified", () => {
    const base = {
      ok: true,
      mode: "write_probe_no_send",
      noSend: true,
      canonicalRoute: ROUTE,
      generation: 11,
      wrote: true,
      verified: true,
    };
    expect(validateWriteProbeResponse(base, owner, transport).ok).toBe(true);
    expect(validateWriteProbeResponse({ ...base, mode: "read_only" }, owner, transport).reason)
      .toBe("write_probe_response_invalid");
    expect(validateWriteProbeResponse({ ...base, noSend: false }, owner, transport).reason)
      .toBe("write_probe_response_invalid");
    expect(validateWriteProbeResponse({ ...base, generation: 10 }, owner, transport).reason)
      .toBe("write_probe_generation_mismatch");
    expect(validateWriteProbeResponse(
      { ...base, canonicalRoute: ROUTE.replace("1111", "9999") },
      owner,
      transport,
    ).reason).toBe("write_probe_route_mismatch");
  });

  it("explicit CS failure is known failure — never success, reason preserved", () => {
    const dirty = {
      ok: false,
      reason: "composer_dirty",
      wrote: false,
      verified: false,
      mode: "write_probe_no_send",
      noSend: true,
      canonicalRoute: ROUTE,
      generation: 11,
    };
    const r = validateWriteProbeResponse(dirty, owner, transport);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("composer_dirty");
    expect(r.knownFailure).toBe(true);
    expect(r.wrote).toBe(false);
    expect(r.verified).toBe(false);

    for (const reason of [
      "generation_active",
      "generation_unknown",
      "write_probe_route_drift",
      "composer_write_error",
      "composer_write_mismatch",
      "composer_text_mismatch",
      "write_probe_generation_mismatch",
    ]) {
      const res = validateWriteProbeResponse({ ...dirty, reason }, owner, transport);
      expect(res.ok).toBe(false);
      expect(res.reason).toBe(reason);
    }

    const noReason = validateWriteProbeResponse(
      { ...dirty, reason: undefined as unknown as string },
      owner,
      transport,
    );
    expect(noReason.reason).toBe("write_probe_failed");
  });

  it("ok=true with wrote/verified not both true → write_probe_response_inconsistent", () => {
    const base = {
      mode: "write_probe_no_send",
      noSend: true,
      canonicalRoute: ROUTE,
      generation: 11,
    };
    const wroteOnly = validateWriteProbeResponse(
      { ...base, ok: true, wrote: true, verified: false },
      owner,
      transport,
    );
    expect(wroteOnly.ok).toBe(false);
    expect(wroteOnly.reason).toBe("write_probe_response_inconsistent");
    const verifiedOnly = validateWriteProbeResponse(
      { ...base, ok: true, wrote: false, verified: true },
      owner,
      transport,
    );
    expect(verifiedOnly.reason).toBe("write_probe_response_inconsistent");
    const neither = validateWriteProbeResponse(
      { ...base, ok: true, wrote: false, verified: false },
      owner,
      transport,
    );
    expect(neither.reason).toBe("write_probe_response_inconsistent");
  });

  it("SW source: journal gate, in-flight, outcome_unknown no-retry, popup sender", () => {
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    expect(sw).toMatch(/c2c\.write\.probe\.request/);
    expect(sw).toMatch(/write_probe_journal_active/);
    expect(sw).toMatch(/write_probe_in_flight/);
    expect(sw).toMatch(/write_outcome_unknown/);
    expect(sw).toMatch(/retryAllowed:\s*false/);
    expect(sw).toMatch(/writeProbeInFlight/);
    expect(sw).toMatch(/journalActive\(journal\)/);
    expect(sw).toMatch(/tabs\.sendMessage\(\s*request\.tabId,\s*request\.message,\s*request\.sendOptions/);
    expect(sw).toMatch(/popup_sender_required/);
    expect(sw).toMatch(/write_probe_payload_forbidden/);
    const probeStart = sw.indexOf("async function handleWriteProbe");
    const probeEnd = sw.indexOf("/** Exact-owner document check for CS production RPCs. */");
    expect(probeStart).toBeGreaterThan(0);
    expect(probeEnd).toBeGreaterThan(probeStart);
    const probeBody = sw.slice(probeStart, probeEnd);
    expect(probeBody).not.toMatch(/markReserveRequested|markReserved|begin-send|\/ack\b|SEND_INTENT|CLAIMED/);
  });

  it("CS source: local fences + __c2cRunWriteProbe, same handler no await between check and write", () => {
    const cs = fs.readFileSync(path.join(companionRoot, "content-script.js"), "utf8");
    expect(cs).toMatch(/c2c\.write\.probe\.execute/);
    expect(cs).toMatch(/__c2cRunWriteProbe/);
    expect(cs).not.toMatch(/\.click\(/);
    // E1b3d3b: CS may wire production DI globals by name; it must not implement them.
    expect(cs).not.toMatch(/function writeCanonicalMessage/);
    expect(cs).not.toMatch(/function dispatchNativeSend/);
  });

  it("SW source: known CS failure ≠ outcome_unknown; success requires wrote+verified", () => {
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    expect(sw).toMatch(/validateWriteProbeResponse/);
    // Known failure path returns concrete reason with wrote/verified + retryAllowed false.
    const probeFn = sw.slice(sw.indexOf("async function handleWriteProbe"));
    const probeBody = probeFn.slice(0, probeFn.indexOf("chrome.runtime.onMessage"));
    expect(probeBody).toMatch(/journalUnchanged:\s*true/);
    expect(probeBody).toMatch(/retryAllowed:\s*false/);
    // write_outcome_unknown only for rpcThrew/null — not for received CS failure.
    const unknownIdx = probeBody.indexOf("write_outcome_unknown");
    const checkIdx = probeBody.indexOf("validateWriteProbeResponse");
    expect(unknownIdx).toBeGreaterThan(-1);
    expect(unknownIdx).toBeLessThan(checkIdx);
  });

  it("parseChatgptRouteStrict delegates to shared parser (no independent regex)", () => {
    expect(parseChatgptRouteStrict(ROUTE, sharedParse)?.canonical).toBe(ROUTE);
    expect(parseChatgptRouteStrict("https://www.chatgpt.com/c/11111111-1111-4111-8111-111111111111", sharedParse)?.canonical)
      .toBe(ROUTE);
    expect(parseChatgptRouteStrict("https://chatgpt.com/c/11111111-1111-4111-8111-111111111111/", sharedParse)?.canonical)
      .toBe(ROUTE);
    // UUID charset accepts mixed case; shared parser preserves conversation id as-is.
    expect(parseChatgptRouteStrict("https://chatgpt.com/c/11111111-1111-4111-8111-11111111111A", sharedParse)?.canonical)
      .toBe("https://chatgpt.com/c/11111111-1111-4111-8111-11111111111A");
  });

  it("shared-parser parity: /c and /g/g-.../c accepted; GPT prefix preserved", () => {
    const uuid = "11111111-1111-4111-8111-111111111111";
    expect(resolveMutationCanonicalRoute(`https://chatgpt.com/c/${uuid}`, sharedParse))
      .toEqual({ ok: true, canonical: `https://chatgpt.com/c/${uuid}` });
    expect(resolveMutationCanonicalRoute(`https://www.chatgpt.com/c/${uuid}`, sharedParse))
      .toEqual({ ok: true, canonical: `https://chatgpt.com/c/${uuid}` });
    const gpt = `https://chatgpt.com/g/g-abc123/c/${uuid}`;
    expect(resolveMutationCanonicalRoute(gpt, sharedParse))
      .toEqual({ ok: true, canonical: gpt });
    expect(resolveMutationCanonicalRoute(`https://www.chatgpt.com/g/g-abc123/c/${uuid}`, sharedParse))
      .toEqual({ ok: true, canonical: gpt });
    // Must NOT collapse GPT route to /c/<uuid>.
    expect(parseChatgptRouteStrict(gpt, sharedParse)?.canonical).toBe(gpt);
  });

  it("parseChatgptRouteStrict rejects query/hash/extra path/protocol/host", () => {
    const uuid = "11111111-1111-4111-8111-111111111111";
    expect(parseChatgptRouteStrict(`https://chatgpt.com/c/${uuid}?x=1`, sharedParse)).toBeNull();
    expect(parseChatgptRouteStrict(`https://chatgpt.com/c/${uuid}#x`, sharedParse)).toBeNull();
    expect(parseChatgptRouteStrict(`https://chatgpt.com/c/${uuid}/extra`, sharedParse)).toBeNull();
    expect(parseChatgptRouteStrict(`http://chatgpt.com/c/${uuid}`, sharedParse)).toBeNull();
    expect(parseChatgptRouteStrict(`https://evil.example/c/${uuid}`, sharedParse)).toBeNull();
    expect(parseChatgptRouteStrict("https://chatgpt.com/", sharedParse)).toBeNull();
    expect(parseChatgptRouteStrict("", sharedParse)).toBeNull();
    expect(parseChatgptRouteStrict("not a url", sharedParse)).toBeNull();
    // Default https:443 is same as no port under companion policy.
    expect(parseChatgptRouteStrict(`https://chatgpt.com:443/c/${uuid}`, sharedParse)?.canonical).toBe(ROUTE);
    // Non-default port rejected.
    expect(parseChatgptRouteStrict(`https://chatgpt.com:8443/c/${uuid}`, sharedParse)).toBeNull();
    // Malformed UUID / gpt id rejected.
    expect(parseChatgptRouteStrict("https://chatgpt.com/c/not-a-uuid", sharedParse)).toBeNull();
    expect(parseChatgptRouteStrict(`https://chatgpt.com/g/bad_id/c/${uuid}`, sharedParse)).toBeNull();
  });

  it("parser unavailable → write_probe_route_parser_missing, never loose fallback", () => {
    const missing = resolveMutationCanonicalRoute(ROUTE, undefined as never);
    // globalThis.parseChatgptConversationRoute is not installed in this unit file.
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("write_probe_route_parser_missing");
    const { doc, state, clicks } = makeComposerDom({ mode: "idle", text: "" });
    const r = runWriteProbe(doc, {
      expectedRoute: ROUTE,
      expectedGeneration: 1,
      locationHref: ROUTE,
      parseRoute: undefined as never,
      localGeneration: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("write_probe_route_parser_missing");
    expect(state.text).toBe("");
    expect(clicks.n).toBe(0);
  });
});

describe("E1b3d2a runtime packaging gates", () => {
  it("manifest loads write-only capability, not send-adapter/orchestrator ESM", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(companionRoot, "manifest.json"), "utf8"));
    const js = (manifest.content_scripts ?? []).flatMap((cs: { js?: string[] }) => cs.js ?? []);
    expect(js).toEqual([
      "route-global.js",
      "dom-adapter.js",
      "turn-observer.js",
      "shadow-evidence.js",
      "composer-write-adapter.js",
      "send-click-adapter.js",
      "send-probe-message-global.js",
      "send-probe-run.js",
      "route-attestation.js",
      "route-attestation-run.js",
      "production-send-runtime-global.js",
      "content-script.js",
    ]);
    expect(js).not.toContain("send-adapter.js");
    expect(js).not.toContain("send-orchestrator.js");
    expect(js).not.toContain("production-send-runtime.js");
    for (const p of manifest.permissions ?? []) {
      expect(["scripting", "debugger", "nativeMessaging", "webRequest"]).not.toContain(p);
    }
  });

  it("classic write adapter exposes only __c2cRunWriteProbe and write globals", () => {
    if (!fs.existsSync(path.join(distCompanion, "composer-write-adapter.js"))) {
      expect(true).toBe(true);
      return;
    }
    const classic = fs.readFileSync(path.join(distCompanion, "composer-write-adapter.js"), "utf8");
    expect(classic).toMatch(/globalThis\.__c2cRunWriteProbe/);
    expect(classic).toMatch(/WRITE_PROBE_MESSAGE/);
    expect(classic).not.toMatch(/dispatchNativeSend/);
    expect(classic).not.toMatch(/\.click\(/);
    expect(classic).not.toMatch(/runSendOrchestration/);
    expect(classic).not.toMatch(/begin-send/);
    const cs = fs.readFileSync(path.join(distCompanion, "content-script.js"), "utf8");
    // E1b3d3b: CS may name production DI keys; must not implement write/click.
    expect(cs).not.toMatch(/function writeCanonicalMessage/);
    expect(cs).not.toMatch(/function dispatchNativeSend/);
    expect(cs).not.toMatch(/\.click\(/);
  });

  it("build script forbids send/click in classic write adapter", () => {
    const build = fs.readFileSync(path.join(projectRoot, "scripts", "build-browser-companion.mjs"), "utf8");
    expect(build).toMatch(/composer-write-adapter\.js/);
    expect(build).toMatch(/__c2cRunWriteProbe/);
    expect(build).toMatch(/must stay write-only/);
  });
});
