import { describe, expect, it } from "vitest";
import {
  resolveChatGptComposer,
  resolveChatGptAction,
  observeChatGptSafety,
  normalizeCanonicalDomText,
} from "../browser-companion/dom-adapter.js";
import {
  inspectComposerWriteCapability,
  writeCanonicalMessage,
  verifyCanonicalComposer,
  dispatchNativeSend,
} from "../browser-companion/send-adapter.js";
import {
  snapshotUserTurns,
  findCanonicalUserTurn,
  hasExactAttemptMarker,
} from "../browser-companion/turn-observer.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const companionRoot = path.join(projectRoot, "browser-companion");

const MESSAGE =
  "[C2C_CONTROL]\nSTATE: EXECUTED\nATTEMPT_ID: 22222222-2222-4222-8222-222222222222\n";
const ATTEMPT = "22222222-2222-4222-8222-222222222222";

type ClickSpy = { clicks: number; click: () => void };

/**
 * Fake DOM matching real Edge 2026-09-16 evidence.
 * mode:
 * - idle: empty ProseMirror + voice action slot (no send-button)
 * - send: form contains data-testid=send-button (localized aria)
 * - stop: stop-shaped action
 * - unknown: no action
 */
function makeEdgeDom(opts: {
  mode?: "idle" | "send" | "stop" | "unknown";
  text?: string;
  editorKind?: "contenteditable" | "textarea";
} = {}) {
  const mode = opts.mode ?? "idle";
  const editorKind = opts.editorKind ?? "contenteditable";
  const state = { text: opts.text ?? "" };
  const voiceClicks: ClickSpy = { clicks: 0, click: () => { voiceClicks.clicks += 1; } };
  const sendClicks: ClickSpy = { clicks: 0, click: () => { sendClicks.clicks += 1; } };
  const events: Array<{ type: string; bubbles: boolean }> = [];

  const voiceBtn = {
    className: "composer-submit-button-color text-submit-btn-text",
    getAttribute: (n: string) => (n === "aria-label" ? "启动语音功能" : null),
    hasAttribute: () => false,
    disabled: false,
    click: voiceClicks.click,
  };
  const sendBtn = {
    className: "composer-submit-button-color text-submit-btn-text",
    getAttribute: (n: string) =>
      n === "data-testid" ? "send-button" : n === "aria-label" ? "发送提示" : null,
    hasAttribute: (n: string) => n === "data-testid",
    disabled: false,
    type: "submit",
    click: sendClicks.click,
  };
  const stopBtn = {
    className: "composer-submit-button-color composer-submit-btn",
    getAttribute: (n: string) =>
      n === "data-testid" ? "composer-stop-button" : n === "aria-label" ? "Stop generating" : null,
    hasAttribute: (n: string) => n === "data-testid",
    disabled: false,
    click: voiceClicks.click,
  };

  const form = {
    querySelector(selector: string) {
      if (mode === "send" && selector === 'button[data-testid="send-button"]') {
        return sendBtn;
      }
      if (mode === "idle" && selector === "button.composer-submit-button-color") {
        return voiceBtn;
      }
      if (mode === "stop" && selector === "button.composer-submit-button-color") {
        return stopBtn;
      }
      return null;
    },
  };

  let editor: Record<string, unknown>;
  if (editorKind === "textarea") {
    const proto = Object.defineProperty({}, "value", {
      get() {
        return state.text;
      },
      set(v: string) {
        state.text = v;
      },
      configurable: true,
    });
    editor = {
      getAttribute: () => null,
      hasAttribute: () => false,
      closest: (s: string) => (s === "form" ? form : null),
      dispatchEvent(ev: { type: string; bubbles: boolean }) {
        events.push(ev);
        return true;
      },
    };
    Object.defineProperty(editor, "value", {
      get() {
        return state.text;
      },
      set(v: string) {
        state.text = v;
      },
      configurable: true,
    });
    const doc = {
      defaultView: {
        HTMLTextAreaElement: { prototype: proto },
        Event: class Event {
          type: string;
          bubbles: boolean;
          constructor(type: string, init: { bubbles?: boolean } = {}) {
            this.type = type;
            this.bubbles = Boolean(init.bubbles);
          }
        },
      },
      querySelector(selector: string) {
        if (
          selector.includes("ProseMirror")
          || selector.includes("contenteditable")
          || selector === "#prompt-textarea"
        ) {
          return null;
        }
        if (selector.includes("textarea")) return editor;
        if (selector === "body") return {};
        if (selector === "main") return {};
        if (mode === "stop" && (selector.includes("stop-button") || selector.includes("Stop"))) {
          return { getAttribute: () => "Stop generating", hasAttribute: () => false, disabled: false };
        }
        return null;
      },
    };
    return {
      doc: doc as never,
      state,
      voiceClicks,
      sendClicks,
      events,
    };
  }

  // ProseMirror contenteditable (real Edge empty/dirty composer)
  editor = {
    getAttribute: (n: string) => (n === "contenteditable" ? "true" : null),
    hasAttribute: () => false,
    className: "ProseMirror",
    id: "prompt-textarea",
    focus: () => {},
    closest: (s: string) => (s === "form" ? form : null),
  };
  Object.defineProperty(editor, "textContent", {
    get() {
      return state.text;
    },
    set(v: string) {
      state.text = v;
    },
    configurable: true,
  });
  Object.defineProperty(editor, "value", {
    get() {
      return state.text;
    },
    set(v: string) {
      state.text = v;
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
      state.text = value;
      return true;
    },
    queryCommandSupported: (cmd: string) => cmd === "insertText",
    querySelector(selector: string) {
      if (selector.includes("ProseMirror") || selector === "#prompt-textarea") return editor;
      if (selector.includes("textarea")) return null;
      if (selector === "body") return {};
      if (selector === "main") return {};
      if (mode === "stop" && (selector.includes("stop-button") || selector.includes("Stop"))) {
        return { getAttribute: () => "Stop generating", hasAttribute: () => false, disabled: false };
      }
      return null;
    },
  };
  return { doc: doc as never, state, voiceClicks, sendClicks, events };
}

/** Section-based real Edge turn structure. */
function makeSectionTurnDom(
  turns: Array<{ role: string; text: string; turnId?: string }>,
) {
  const elements = turns.map((t, i) => {
    const attrs: Record<string, string> = {
      "data-message-author-role": t.role,
    };
    return {
      getAttribute(name: string) {
        return attrs[name] ?? null;
      },
      querySelector() {
        return null;
      },
      closest(sel: string) {
        if (sel.includes("conversation-turn")) {
          return {
            getAttribute: (n: string) =>
              n === "data-testid"
                ? `conversation-turn-${t.turnId ?? i}`
                : n === "data-turn-id"
                  ? t.turnId ?? null
                  : null,
          };
        }
        return null;
      },
      textContent: t.text,
      innerText: t.text,
    };
  });
  return {
    querySelectorAll(selector: string) {
      if (
        selector.includes("conversation-turn")
        || selector.includes("data-message-author-role")
      ) {
        return elements;
      }
      return [];
    },
  } as never;
}

describe("A. real Edge action classification", () => {
  it("1. empty ProseMirror voice action slot => idle, not send; safety idle/safe", () => {
    const { doc, voiceClicks } = makeEdgeDom({ mode: "idle", text: "" });
    const { editor } = resolveChatGptComposer(doc);
    const action = resolveChatGptAction(doc, editor);
    expect(action.kind).toBe("idle");
    expect(action.button).toBeNull();
    expect(action.enabled).toBe(true);
    expect(action.evidence).toBe("action_slot_idle");

    const safety = observeChatGptSafety(doc, { routeValid: true });
    expect(safety.composer).toBe("empty");
    expect(safety.generation).toBe("idle");
    expect(safety.safe).toBe(true);

    // Voice control must never be a Send target.
    const r = dispatchNativeSend(doc, MESSAGE, { routeValid: true });
    expect(r.ok).toBe(false);
    expect(voiceClicks.clicks).toBe(0);
  });

  it("2. dirty composer with form send-button => kind send", () => {
    const { doc } = makeEdgeDom({ mode: "send", text: MESSAGE });
    const { editor } = resolveChatGptComposer(doc);
    const action = resolveChatGptAction(doc, editor);
    expect(action.kind).toBe("send");
    expect(action.enabled).toBe(true);
    expect(action.button?.getAttribute?.("data-testid")).toBe("send-button");
  });

  it("3. generic aria Send without data-testid must not be click target", () => {
    const form = {
      querySelector(selector: string) {
        if (selector === 'button[data-testid="send-button"]') return null;
        return null;
      },
    };
    const editor = {
      textContent: "",
      getAttribute: (n: string) => (n === "contenteditable" ? "true" : null),
      closest: (s: string) => (s === "form" ? form : null),
    };
    Object.defineProperty(editor, "textContent", {
      get() {
        return MESSAGE;
      },
      configurable: true,
    });
    const docSend = {
      getAttribute: (n: string) => (n === "aria-label" ? "Send feedback" : null),
      hasAttribute: () => false,
      disabled: false,
      click: () => {},
    };
    const doc = {
      querySelector(selector: string) {
        if (selector.includes("ProseMirror") || selector === "#prompt-textarea") return editor;
        if (selector.includes("textarea")) return null;
        if (selector === "body") return {};
        if (selector === "main") return {};
        if (selector.includes("Send")) return docSend;
        return null;
      },
    } as never;
    const { editor: ed } = resolveChatGptComposer(doc);
    const action = resolveChatGptAction(doc, ed);
    expect(action.kind).not.toBe("send");
    expect(dispatchNativeSend(doc, MESSAGE, { routeValid: true }).ok).toBe(false);
  });

  it("6. stop-shaped continues fail-closed", () => {
    const { doc, state } = makeEdgeDom({ mode: "stop", text: MESSAGE });
    const safety = observeChatGptSafety(doc, { routeValid: true });
    expect(safety.generation).toBe("generating");
    expect(safety.safe).toBe(false);
    const r = dispatchNativeSend(doc, MESSAGE, { routeValid: true });
    expect(r.reason).toBe("generation_active");
    void state;
  });
});

describe("B. pre-write + write + fresh Send", () => {
  it("4. pre-write accepts idle voice evidence on empty composer", () => {
    const { doc } = makeEdgeDom({ mode: "idle", text: "", editorKind: "textarea" });
    const pre = inspectComposerWriteCapability(doc, { routeValid: true });
    expect(pre.ok).toBe(true);
    expect(pre.action?.kind).toBe("idle");
  });

  it("5. write then DOM transitions to send-button; dispatch clicks NEW control once, voice zero", () => {
    // Start idle (empty ProseMirror voice). Write via contenteditable.
    const idle = makeEdgeDom({ mode: "idle", text: "", editorKind: "contenteditable" });
    const w = writeCanonicalMessage(idle.doc, MESSAGE, { routeValid: true });
    expect(w.ok).toBe(true);
    expect(idle.state.text).toBe(MESSAGE);
    expect(idle.voiceClicks.clicks).toBe(0);

    // After write, real DOM shows send-button. Use a fresh doc reflecting dirty+send.
    const dirty = makeEdgeDom({
      mode: "send",
      text: MESSAGE,
      editorKind: "contenteditable",
    });
    // Stale pre-write action reference (idle voice) is never reused:
    const r = dispatchNativeSend(dirty.doc, MESSAGE, { routeValid: true });
    expect(r.ok).toBe(true);
    expect(r.clicked).toBe(1);
    expect(dirty.sendClicks.clicks).toBe(1);
    expect(dirty.voiceClicks.clicks).toBe(0);
    expect(idle.voiceClicks.clicks).toBe(0);
  });

  it("textarea write + form send-button => one click", () => {
    const { doc, state, sendClicks, voiceClicks } = makeEdgeDom({
      mode: "idle",
      text: "",
      editorKind: "textarea",
    });
    // Pre-write idle on empty textarea.
    expect(inspectComposerWriteCapability(doc, { routeValid: true }).ok).toBe(true);
    // Simulate write then send appearing (same form state machine via mode switch on new dom).
    const after = makeEdgeDom({ mode: "send", text: MESSAGE, editorKind: "textarea" });
    const r = dispatchNativeSend(after.doc, MESSAGE, { routeValid: true });
    expect(r.ok).toBe(true);
    expect(after.sendClicks.clicks).toBe(1);
    expect(voiceClicks.clicks).toBe(0);
    void state;
  });

  it("direct post-write mismatch still fails closed", () => {
    const state = { text: "" };
    const form = {
      querySelector(sel: string) {
        if (sel === "button.composer-submit-button-color") {
          return {
            className: "composer-submit-button-color text-submit-btn-text",
            getAttribute: (n: string) => (n === "aria-label" ? "启动语音功能" : null),
            hasAttribute: () => false,
            disabled: false,
            click: () => {},
          };
        }
        return null;
      },
    };
    const editor = {
      getAttribute: () => null,
      hasAttribute: () => false,
      closest: (s: string) => (s === "form" ? form : null),
      dispatchEvent() {
        return true;
      },
    };
    Object.defineProperty(editor, "value", {
      get() {
        return state.text;
      },
      set(v: string) {
        state.text = `${v}!`;
      },
      configurable: true,
    });
    const proto = Object.defineProperty({}, "value", {
      get() {
        return state.text;
      },
      set(v: string) {
        state.text = `${v}!`;
      },
      configurable: true,
    });
    const doc = {
      defaultView: {
        HTMLTextAreaElement: { prototype: proto },
        Event: class {
          type: string;
          constructor(type: string) {
            this.type = type;
          }
        },
      },
      querySelector(selector: string) {
        if (
          selector.includes("ProseMirror")
          || selector.includes("contenteditable")
          || selector === "#prompt-textarea"
        ) {
          return null;
        }
        if (selector.includes("textarea")) return editor;
        if (selector === "body") return {};
        if (selector === "main") return {};
        return null;
      },
    } as never;
    const result = writeCanonicalMessage(doc, MESSAGE, { routeValid: true });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("composer_write_mismatch");
  });
});

describe("C. dispatchNativeSend fail-closed matrix", () => {
  it("route/text/stop/idle/unknown never click", () => {
    const idle = makeEdgeDom({ mode: "idle", text: MESSAGE });
    expect(dispatchNativeSend(idle.doc, MESSAGE, { routeValid: false }).reason).toBe("route_invalid");
    expect(dispatchNativeSend(idle.doc, MESSAGE, { routeValid: true }).reason).toBe("send_action_not_ready");
    expect(idle.voiceClicks.clicks).toBe(0);

    const send = makeEdgeDom({ mode: "send", text: MESSAGE });
    expect(dispatchNativeSend(send.doc, MESSAGE + "x", { routeValid: true }).reason)
      .toBe("composer_text_mismatch");
    expect(send.sendClicks.clicks).toBe(0);

    const stop = makeEdgeDom({ mode: "stop", text: MESSAGE });
    expect(dispatchNativeSend(stop.doc, MESSAGE, { routeValid: true }).reason).toBe("generation_active");
    expect(stop.sendClicks.clicks).toBe(0);

    const unknown = makeEdgeDom({ mode: "unknown", text: MESSAGE });
    expect(dispatchNativeSend(unknown.doc, MESSAGE, { routeValid: true }).ok).toBe(false);
    expect(unknown.sendClicks.clicks).toBe(0);
  });
});

describe("D. turn observer section structure", () => {
  it("7. SECTION conversation-turn + user role node => observed", () => {
    const doc = makeSectionTurnDom([{ role: "user", text: MESSAGE, turnId: "u1" }]);
    const found = findCanonicalUserTurn(doc, { message: MESSAGE, attemptId: ATTEMPT });
    expect(found.ok).toBe(true);
  });

  it("8. assistant equivalent rejected", () => {
    const doc = makeSectionTurnDom([{ role: "assistant", text: MESSAGE, turnId: "a1" }]);
    const found = findCanonicalUserTurn(doc, { message: MESSAGE, attemptId: ATTEMPT });
    expect(found.ok).toBe(false);
    expect(found.reason).toBe("not_observed");
  });

  it("9. role node full text mismatch rejected", () => {
    const doc = makeSectionTurnDom([
      { role: "user", text: `${MESSAGE} extra`, turnId: "u1" },
    ]);
    const found = findCanonicalUserTurn(doc, { message: MESSAGE, attemptId: ATTEMPT });
    expect(found.ok).toBe(false);
  });

  it("10. baseline / ambiguity / exact ATTEMPT still green", () => {
    const baselineDoc = makeSectionTurnDom([
      { role: "user", text: "old", turnId: "u0" },
    ]);
    const baseline = snapshotUserTurns(baselineDoc);
    const after = makeSectionTurnDom([
      { role: "user", text: "old", turnId: "u0" },
      { role: "user", text: MESSAGE, turnId: "u1" },
    ]);
    expect(
      findCanonicalUserTurn(after, { message: MESSAGE, attemptId: ATTEMPT, baseline }).ok,
    ).toBe(true);

    const dup = makeSectionTurnDom([
      { role: "user", text: MESSAGE, turnId: "u1" },
      { role: "user", text: MESSAGE, turnId: "u2" },
    ]);
    expect(findCanonicalUserTurn(dup, { message: MESSAGE, attemptId: ATTEMPT }).reason)
      .toBe("ambiguous");

    expect(hasExactAttemptMarker(MESSAGE, ATTEMPT).ok).toBe(true);
    expect(hasExactAttemptMarker(MESSAGE, ATTEMPT.slice(0, 8)).ok).toBe(false);
    expect(hasExactAttemptMarker(`${MESSAGE}ATTEMPT_ID: ${ATTEMPT}\n`, ATTEMPT).reason)
      .toBe("attempt_marker_duplicate");
  });
});

describe("E. contenteditable primitives (real Edge confirmed, strategy unchanged)", () => {
  it("insertText path writes exact content; no click", () => {
    const { doc, state, voiceClicks } = makeEdgeDom({
      mode: "idle",
      text: "",
      editorKind: "contenteditable",
    });
    expect(doc.defaultView.getSelection).toBeTypeOf("function");
    expect(doc.createRange).toBeTypeOf("function");
    expect(doc.queryCommandSupported("insertText")).toBe(true);
    const r = writeCanonicalMessage(doc, MESSAGE, { routeValid: true });
    expect(r.ok).toBe(true);
    expect(state.text).toBe(MESSAGE);
    expect(voiceClicks.clicks).toBe(0);
    expect(verifyCanonicalComposer(doc, MESSAGE).ok).toBe(true);
  });
});

describe("runtime unreachability (E1b3b safety gate)", () => {
  it("manifest does not load send-adapter or turn-observer", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(companionRoot, "manifest.json"), "utf8"),
    );
    const js = (manifest.content_scripts ?? [])
      .flatMap((cs: { js?: string[] }) => cs.js ?? []);
    expect(js).not.toContain("send-adapter.js");
    expect(js).not.toContain("send-orchestrator.js");
    // E1b3d1: read-only turn-observer is allowed for shadow inspect.
    expect(js).toContain("turn-observer.js");
    expect(js).toContain("shadow-evidence.js");
    for (const p of manifest.permissions ?? []) {
      expect(["scripting", "debugger", "nativeMessaging", "webRequest"]).not.toContain(p);
    }
  });

  it("content-script and service-worker do not implement send/observer capability", () => {
    const cs = fs.readFileSync(path.join(companionRoot, "content-script.js"), "utf8");
    // E1b3d3b: CS may name production DI keys that wire runtime globals; it must not implement them.
    expect(cs).not.toMatch(/function writeCanonicalMessage/);
    expect(cs).not.toMatch(/function dispatchNativeSend/);
    expect(cs).not.toMatch(/function findCanonicalUserTurn/);
    expect(cs).not.toMatch(/function snapshotUserTurns/);
    expect(cs).not.toMatch(/send-adapter/);
    expect(cs).not.toMatch(/turn-observer/);
    expect(cs).not.toMatch(/\/begin-send/);
    expect(cs).not.toMatch(/\/ack\b/);
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    expect(sw).not.toMatch(/writeCanonicalMessage/);
    expect(sw).not.toMatch(/dispatchNativeSend/);
    expect(sw).not.toMatch(/findCanonicalUserTurn/);
    expect(sw).not.toMatch(/snapshotUserTurns/);
    expect(sw).not.toMatch(/send-adapter/);
    expect(sw).not.toMatch(/turn-observer/);
  });

  it("content-script remains free of DOM mutation / native Send", () => {
    const text = fs.readFileSync(path.join(companionRoot, "content-script.js"), "utf8");
    expect(text).not.toMatch(/\.click\(\)/);
    expect(text).not.toMatch(/requestSubmit/);
    expect(text).not.toMatch(/form\.submit/);
    expect(text).not.toMatch(/dispatchEvent\(/);
  });
});

describe("normalizeCanonicalDomText", () => {
  it("only CRLF/CR/NBSP", () => {
    expect(normalizeCanonicalDomText("a\r\nb\rc d")).toBe("a\nb\nc d");
    expect(normalizeCanonicalDomText("  keep  ")).toBe("  keep  ");
  });
});
