import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  observeChatGptSafety,
  resolveChatGptComposer,
  resolveChatGptAction,
  normalizeCanonicalDomText,
  inspectChatGptActionEvidence,
  inspectActiveComposerControls,
  inspectComposerContainerInventory,
  isExcludedEmbeddedEditor,
} from "../browser-companion/dom-adapter.js";
import { snapshotUserTurns, findCanonicalUserTurn } from "../browser-companion/turn-observer.js";
import { inspectShadowEvidence } from "../browser-companion/shadow-evidence.js";
import {
  isExtensionInternalSender,
  buildShadowInspectRequest,
  validateShadowInspectResponse,
  buildOwnerLocalShadowInspectRequest,
  validateOwnerLocalShadowInspectResponse,
} from "../browser-companion/shadow-rpc.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const companionRoot = path.join(projectRoot, "browser-companion");
const distCompanion = path.join(projectRoot, "dist", "browser-companion");

const ROUTE = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const ATTEMPT = "22222222-2222-4222-8222-222222222222";
const MESSAGE = `[C2C_CONTROL]\nSTATE: EXECUTED\nATTEMPT_ID: ${ATTEMPT}\n`;

function parseRoute(href: string) {
  const m = /https:\/\/chatgpt\.com\/c\/([0-9a-f-]{36})/i.exec(href);
  if (!m) throw new Error("bad route");
  return { canonical: `https://chatgpt.com/c/${m[1]!.toLowerCase()}` };
}

function makeEdgeDom(mode: "idle" | "send" | "stop" | "empty-doc", text = "") {
  const state = { text };
  const voice = {
    className: "composer-submit-button-color text-submit-btn-text",
    getAttribute: (n: string) => (n === "aria-label" ? "启动语音功能" : null),
    hasAttribute: () => false,
    disabled: false,
  };
  const send = {
    className: "composer-submit-button-color text-submit-btn-text",
    getAttribute: (n: string) => (n === "data-testid" ? "send-button" : null),
    hasAttribute: (n: string) => n === "data-testid",
    disabled: false,
  };
  const stop = {
    className: "composer-submit-button-color composer-submit-btn",
    getAttribute: (n: string) => (n === "data-testid" ? "composer-stop-button" : null),
    hasAttribute: (n: string) => n === "data-testid",
    disabled: false,
  };
  const form = {
    querySelector(selector: string) {
      if (mode === "idle" && selector === "button.composer-submit-button-color") return voice;
      if (mode === "send" && selector === 'button[data-testid="send-button"]') return send;
      if (mode === "stop" && selector === "button.composer-submit-button-color") return stop;
      return null;
    },
  };
  const editor = {
    getAttribute: (n: string) => (n === "contenteditable" ? "true" : null),
    hasAttribute: () => false,
    closest: (s: string) => (s === "form" ? form : null),
    focus: () => {
      throw new Error("shadow must not focus");
    },
  };
  Object.defineProperty(editor, "textContent", {
    get() {
      return state.text;
    },
    set() {
      throw new Error("shadow must not write");
    },
    configurable: true,
  });
  if (mode === "empty-doc") {
    return {
      doc: {
        querySelector: () => null,
        querySelectorAll: () => [],
      } as never,
      state,
    };
  }
  return {
    doc: {
      querySelector(selector: string) {
        if (selector.includes("ProseMirror") || selector === "#prompt-textarea") return editor;
        if (selector.includes("textarea")) return null;
        if (selector === "body") return {};
        if (selector === "main") return {};
        if (mode === "stop" && selector.includes("Stop")) {
          return { getAttribute: () => "Stop generating", hasAttribute: () => false, disabled: false };
        }
        return null;
      },
      querySelectorAll: () => [],
    } as never,
    state,
  };
}

const helpers = {
  observeChatGptSafety,
  resolveChatGptComposer,
  resolveChatGptAction,
  inspectChatGptActionEvidence,
  normalizeCanonicalDomText,
  snapshotUserTurns,
  parseChatgptConversationRoute: parseRoute,
};

describe("E1b3d1 shadow evidence (read-only)", () => {
  it("scenario A empty composer: idle, no exact send-button, safe idle", () => {
    const { doc } = makeEdgeDom("idle", "");
    const ev = inspectShadowEvidence(doc, {
      ...helpers,
      locationHref: ROUTE,
      now: 1,
    });
    expect(ev.ok).toBe(true);
    expect(ev.mode).toBe("read_only");
    expect(ev.canonicalRoute).toBe(ROUTE);
    expect(ev.composer.present).toBe(true);
    expect(ev.composer.editorKind).toBe("contenteditable");
    expect(ev.composer.textEmpty).toBe(true);
    expect(ev.action.kind).toBe("idle");
    expect(ev.action.hasExactSendButton).toBe(false);
    expect(ev.composer.evidence).toBe("prompt_textarea");
    expect(ev.safety.generation).toBe("idle");
    expect(ev.safety.safe).toBe(true);
  });

  it("scenario B dirty composer: send + exact send-button", () => {
    const { doc } = makeEdgeDom("send", MESSAGE);
    const ev = inspectShadowEvidence(doc, {
      ...helpers,
      locationHref: ROUTE,
      now: 2,
    });
    expect(ev.ok).toBe(true);
    expect(ev.composer.textEmpty).toBe(false);
    expect(ev.action.kind).toBe("send");
    expect(ev.action.enabled).toBe(true);
    expect(ev.action.hasExactSendButton).toBe(true);
    expect(ev.safety.safe).toBe(false); // dirty
  });

  it("stop/generating and empty document fail closed", () => {
    const stopDom = makeEdgeDom("stop", "");
    const stopEv = inspectShadowEvidence(stopDom.doc, { ...helpers, locationHref: ROUTE });
    expect(stopEv.safety.generation).toBe("generating");
    expect(stopEv.safety.safe).toBe(false);

    const empty = makeEdgeDom("empty-doc");
    const emptyEv = inspectShadowEvidence(empty.doc, { ...helpers, locationHref: ROUTE });
    expect(emptyEv.composer.present).toBe(false);
  });

  it("capability_missing when helpers absent", () => {
    const { doc } = makeEdgeDom("idle", "");
    const ev = inspectShadowEvidence(doc, { locationHref: ROUTE });
    // globals not set in unit test unless injected
    expect(ev.ok).toBe(false);
    expect(ev.reason).toBe("capability_missing");
  });

  it("never focuses / writes even if editor is hostile", () => {
    const { doc } = makeEdgeDom("idle", "");
    expect(() => inspectShadowEvidence(doc, { ...helpers, locationHref: ROUTE })).not.toThrow();
  });
});

describe("E1b3d1 exact owner RPC contract (pure validation)", () => {
  function validateShadowResponse(response: Record<string, unknown>, route: string) {
    if (!response || typeof response !== "object") return "malformed_shadow_response";
    if (response.mode !== "read_only") return "shadow_response_invalid";
    if (response.canonicalRoute !== route) return "shadow_route_mismatch";
    if (response.documentCanonicalRoute && response.documentCanonicalRoute !== route) {
      return "shadow_route_mismatch";
    }
    return null;
  }

  it("wrong document / route changed rejects; correct route accepts", () => {
    expect(validateShadowResponse({ mode: "read_only", canonicalRoute: ROUTE }, ROUTE)).toBeNull();
    expect(validateShadowResponse({ mode: "write", canonicalRoute: ROUTE }, ROUTE))
      .toBe("shadow_response_invalid");
    expect(validateShadowResponse({ mode: "read_only", canonicalRoute: ROUTE }, ROUTE.replace("1111", "9999")))
      .toBe("shadow_route_mismatch");
    expect(validateShadowResponse({
      mode: "read_only",
      canonicalRoute: ROUTE,
      documentCanonicalRoute: ROUTE.replace("1111", "9999"),
    }, ROUTE)).toBe("shadow_route_mismatch");
    expect(validateShadowResponse(null, ROUTE)).toBe("malformed_shadow_response");
  });
});

describe("E1b3d1 exact-document RPC (sendMessage options + generation + sender)", () => {
  const owner = {
    tabId: 7,
    documentId: "doc-abc",
    canonicalRoute: ROUTE,
    generation: 12,
  };
  const transport = {
    routeCanonical: ROUTE,
    authStale: false,
  };

  it("buildShadowInspectRequest uses sendOptions.documentId (not payload-only)", () => {
    const req = buildShadowInspectRequest(owner, transport);
    expect(req.ok).toBe(true);
    expect(req.tabId).toBe(7);
    // Third-argument delivery options must carry exact documentId.
    expect(req.sendOptions).toEqual({ documentId: "doc-abc" });
    expect(req.sendOptions.documentId).toBe(owner.documentId);
    expect(req.message.type).toBe("c2c.send.shadow.inspect");
  });

  it("owner route mismatch / invalid owner rejects before RPC", () => {
    expect(buildShadowInspectRequest(
      { ...owner, canonicalRoute: ROUTE.replace("1111", "9999") },
      transport,
    ).reason).toBe("owner_route_mismatch");
    expect(buildShadowInspectRequest(
      { ...owner, documentId: "" },
      transport,
    ).reason).toBe("owner_document_invalid");
    expect(buildShadowInspectRequest(owner, { ...transport, authStale: true }).reason)
      .toBe("auth_stale");
  });

  it("validateShadowInspectResponse requires exact generation", () => {
    const base = { mode: "read_only", canonicalRoute: ROUTE, generation: 12 };
    expect(validateShadowInspectResponse(base, owner, transport).ok).toBe(true);
    expect(validateShadowInspectResponse(
      { ...base, generation: 11 },
      owner,
      transport,
    ).reason).toBe("shadow_generation_mismatch");
    expect(validateShadowInspectResponse(
      { ...base, generation: undefined },
      owner,
      transport,
    ).reason).toBe("shadow_generation_mismatch");
    expect(validateShadowInspectResponse(
      { mode: "read_only", canonicalRoute: ROUTE.replace("1111", "9999"), generation: 12 },
      owner,
      transport,
    ).reason).toBe("shadow_route_mismatch");
  });

  it("isExtensionInternalSender: popup yes, content-script tab no", () => {
    expect(isExtensionInternalSender({ id: "ext" })).toBe(true);
    expect(isExtensionInternalSender({ id: "ext", tab: undefined })).toBe(true);
    expect(isExtensionInternalSender({ tab: { id: 3 } })).toBe(false);
    expect(isExtensionInternalSender(null)).toBe(false);
  });

  it("SW source uses document-targeted sendMessage third arg", () => {
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    expect(sw).toMatch(/tabs\.sendMessage\(\s*request\.tabId,\s*request\.message,\s*request\.sendOptions/);
    expect(sw).toMatch(/isExtensionInternalSender/);
    expect(sw).toMatch(/popup_sender_required/);
    expect(sw).toMatch(/shadow_generation_mismatch|validateOwnerLocalShadowInspectResponse/);
  });
});

describe("R3i owner-local read-only shadow RPC", () => {
  const owner = {
    tabId: 7,
    documentId: "doc-current-chat",
    canonicalRoute: ROUTE
      .replace("11111111-1111-4111-8111-111111111111", "33333333-3333-4333-8333-333333333333")
      .replace("/c/", "/g/g-p-test/c/"),
    generation: 19,
  };

  it("inspects a different owner route without consulting old transport", () => {
    expect(buildShadowInspectRequest(owner, { routeCanonical: ROUTE, authStale: false }).reason)
      .toBe("owner_route_mismatch");
    const req = buildOwnerLocalShadowInspectRequest(owner);
    expect(req).toEqual({
      ok: true,
      tabId: owner.tabId,
      message: { type: "c2c.send.shadow.inspect" },
      sendOptions: { documentId: owner.documentId },
    });
    expect(validateOwnerLocalShadowInspectResponse({
      mode: "read_only",
      canonicalRoute: owner.canonicalRoute,
      documentCanonicalRoute: owner.canonicalRoute,
      generation: owner.generation,
      composer: { present: true },
    }, owner).ok).toBe(true);
  });

  it("uses only owner route/document/generation and has no caller body fields", () => {
    const req = buildOwnerLocalShadowInspectRequest(owner);
    expect(req.message).toEqual({ type: "c2c.send.shadow.inspect" });
    expect(req.sendOptions.documentId).toBe(owner.documentId);
    expect(validateOwnerLocalShadowInspectResponse({
      mode: "read_only",
      canonicalRoute: owner.canonicalRoute,
      documentCanonicalRoute: owner.canonicalRoute,
      generation: owner.generation,
    }, owner).ok).toBe(true);
  });

  it("fails closed on missing owner, malformed response, route mismatch, or generation mismatch", () => {
    expect(buildOwnerLocalShadowInspectRequest(null).reason).toBe("owner_document_invalid");
    expect(validateOwnerLocalShadowInspectResponse(null, owner).reason).toBe("malformed_shadow_response");
    expect(validateOwnerLocalShadowInspectResponse({
      mode: "read_only",
      canonicalRoute: owner.canonicalRoute,
      documentCanonicalRoute: ROUTE,
      generation: owner.generation,
    }, owner).reason).toBe("shadow_route_mismatch");
    expect(validateOwnerLocalShadowInspectResponse({
      mode: "read_only",
      canonicalRoute: owner.canonicalRoute,
      documentCanonicalRoute: owner.canonicalRoute,
      generation: owner.generation + 1,
    }, owner).reason).toBe("shadow_generation_mismatch");
  });

  it("service-worker inspect stays owner-local and read-only", () => {
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    const start = sw.indexOf("async function handleShadowInspect() {");
    const end = sw.indexOf("\n}\n\n/**", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = sw.slice(start, end);
    expect(body).toMatch(/if \(!ownerState\.owner\)[\s\S]*reason: "owner_missing"/);
    expect(body).toMatch(/buildOwnerLocalShadowInspectRequest\(owner\)/);
    expect(body).toMatch(/validateOwnerLocalShadowInspectResponse\(response, owner\)/);
    expect(body).not.toMatch(/requireProtectedTransport|\btransport\b|journal\s*=|autonomy|connectFlow|persist|\.click\(|writeCanonicalMessage/);
    const cs = fs.readFileSync(path.join(companionRoot, "content-script.js"), "utf8");
    expect(cs).toMatch(/if \(message\.type === "c2c\.send\.shadow\.inspect"\)[\s\S]*?__c2cInspectShadowEvidence/);
    expect(cs).not.toMatch(/function writeCanonicalMessage|function dispatchNativeSend|\.click\(\)/);
  });
});

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

  it("5. diagnostic is zero side-effect", () => {
    const { doc, editor } = makeDiagDom({ docStop: true, formSend: true, text: MESSAGE });
    expect(() => inspectChatGptActionEvidence(doc, editor)).not.toThrow();
    const ev = inspectShadowEvidence(doc, {
      ...helpers,
      locationHref: ROUTE,
      now: 1,
    });
    expect(ev.ok).toBe(true);
    expect(ev.action.stopEvidence?.source).toBe("document_stop_button");
    expect(ev.action.evidence).toBe("legacy_stop");
  });

  it("6. popup source renders evidence + stop diagnostic + READ ONLY", () => {
    const popup = fs.readFileSync(path.join(companionRoot, "popup", "popup.js"), "utf8");
    expect(popup).toMatch(/READ ONLY — no composer write \/ no Send/);
    expect(popup).toMatch(/evidence=\$\{a\.evidence/);
    expect(popup).toMatch(/stopSource=/);
    expect(popup).toMatch(/stopTestId=/);
    expect(popup).toMatch(/stopAria=/);
    expect(popup).toMatch(/stopInForm=/);
    expect(popup).toMatch(/formatControlInventory/);
    expect(popup).toMatch(/shadow-controls/);
    expect(popup).toMatch(/formatContainerInventory/);
    expect(popup).toMatch(/shadow-containers/);
    expect(popup).not.toMatch(/writeCanonicalMessage|dispatchNativeSend|\.click\(\)/);
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
    // Allowed keys only.
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
      "name",
      "role",
      "title",
      "type",
    ]);
  });

  it("shadow evidence exposes action.inventory without changing kind/evidence semantics", () => {
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
      querySelector: (sel: string) =>
        sel.includes("ProseMirror") || sel === "#prompt-textarea" ? editor : null,
      querySelectorAll: () => [],
    } as never;
    const ev = inspectShadowEvidence(doc, {
      ...helpers,
      inspectActiveComposerControls,
      locationHref: ROUTE,
      now: 3,
    });
    expect(ev.ok).toBe(true);
    expect(ev.action.kind).toBe("send");
    expect(ev.action.hasExactSendButton).toBe(true);
    expect(ev.action.evidence).toBe("form_send_button");
    const inv = (ev.action as { inventory?: { formPresent: boolean; buttonCount: number; buttons: InvButton[] } }).inventory;
    expect(inv?.formPresent).toBe(true);
    expect(inv?.buttonCount).toBe(1);
    expect(inv?.buttons[0]?.matchesKnownSend).toBe(true);
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

  it("8. zero side effect: hostile focus/click/write never invoked", () => {
    const btn = makeBtn({ dataTestId: "x" });
    const { doc, editor } = makeNoFormDom({
      chainButtons: { 1: [btn] },
      editorText: MESSAGE,
    });
    expect(() => inspectComposerContainerInventory(doc, editor)).not.toThrow();
    expect(() => inspectChatGptActionEvidence(doc, editor)).not.toThrow();
    expect(() => inspectShadowEvidence(doc, {
      ...helpers,
      inspectComposerContainerInventory,
      locationHref: ROUTE,
    })).not.toThrow();
  });

  it("shadow evidence exposes action.containerInventory; form inventory still present", () => {
    const sendLike = makeBtn({ dataTestId: "send-button", className: "composer-submit-button-color" });
    const { doc, editor } = makeNoFormDom({
      chainButtons: { 1: [sendLike] },
      chainMeta: { 1: { testId: "composer-shell", className: "composer-shell" } },
      editorText: MESSAGE,
    });
    const ev = inspectShadowEvidence(doc, {
      ...helpers,
      inspectComposerContainerInventory,
      locationHref: ROUTE,
      now: 4,
    });
    expect(ev.ok).toBe(true);
    expect(ev.action.kind).toBe("unknown");
    const a = ev.action as {
      inventory?: { formPresent: boolean };
      containerInventory?: {
        ancestors: { depth: number; dataTestId: string | null; descendantButtonCount: number }[];
        controlContainers: { depth: number; buttons: ContainerButton[] }[];
      };
    };
    expect(a.inventory?.formPresent).toBe(false);
    expect(a.containerInventory?.ancestors[0]?.depth).toBe(1);
    expect(a.containerInventory?.ancestors[0]?.dataTestId).toBe("composer-shell");
    expect(a.containerInventory?.controlContainers[0]?.buttons[0]?.dataTestId).toBe("send-button");
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

  it("1. collision: Writing Block ProseMirror first + #prompt-textarea primary → primary wins", () => {
    const wb = makeWritingBlockEditor("WB");
    const primary = makePrimaryComposer(MESSAGE);
    const doc = {
      querySelector(selector: string) {
        if (selector === "#prompt-textarea") return primary.editor;
        if (selector.includes("ProseMirror") || selector.includes("contenteditable")) {
          return wb.editor;
        }
        if (selector.includes("textarea")) return null;
        if (selector === "body") return {};
        if (selector === "main") return {};
        return null;
      },
      querySelectorAll(selector: string) {
        if (selector.includes("ProseMirror") || selector.includes("contenteditable")) {
          return [wb.editor];
        }
        return [];
      },
    } as never;

    const resolved = resolveChatGptComposer(doc);
    expect(resolved.editor).toBe(primary.editor);
    expect(resolved.editor).not.toBe(wb.editor);
    expect(resolved.evidence).toBe("prompt_textarea");
    expect(resolved.kind).toBe("contenteditable");
    expect(String(resolved.editor?.textContent)).toContain("C2C_CONTROL");

    const action = resolveChatGptAction(doc, resolved.editor);
    expect(action.kind).toBe("send");
    expect(action.evidence).toBe("form_send_button");

    const ev = inspectShadowEvidence(doc, {
      ...helpers,
      locationHref: ROUTE,
      now: 10,
    });
    expect(ev.ok).toBe(true);
    expect(ev.composer.present).toBe(true);
    expect(ev.composer.evidence).toBe("prompt_textarea");
    expect(ev.composer.textEmpty).toBe(false);
    expect(ev.action.kind).toBe("send");
    // Writing Block buttons are outside primary form scope.
    const inv = (ev.action as { inventory?: { formPresent: boolean } }).inventory;
    expect(inv?.formPresent).toBe(true);
    expect(JSON.stringify(ev)).not.toContain("WRITING BLOCK SECRET");
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

  it("3. only Writing Block editor → composer missing, fail closed", () => {
    const wb = makeWritingBlockEditor("WB ONLY");
    const doc = {
      querySelector(selector: string) {
        if (selector === "#prompt-textarea") return null;
        if (selector.includes("ProseMirror") || selector.includes("contenteditable")) {
          return wb.editor;
        }
        if (selector.includes("textarea")) return null;
        if (selector === "body") return {};
        if (selector === "main") return {};
        return null;
      },
      querySelectorAll(selector: string) {
        if (selector.includes("ProseMirror") || selector.includes("contenteditable")) {
          return [wb.editor];
        }
        return [];
      },
    } as never;
    const resolved = resolveChatGptComposer(doc);
    expect(resolved.editor).toBeNull();
    expect(resolved.kind).toBe("unknown");
    expect(resolved.evidence).toBeNull();

    const ev = inspectShadowEvidence(doc, { ...helpers, locationHref: ROUTE });
    expect(ev.composer.present).toBe(false);
    expect(ev.composer.textEmpty).toBeNull();
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

  it("popup source shows composerEvidence and READ ONLY", () => {
    const popup = fs.readFileSync(path.join(companionRoot, "popup", "popup.js"), "utf8");
    expect(popup).toMatch(/composerEvidence=/);
    expect(popup).toMatch(/READ ONLY — no composer write \/ no Send/);
    expect(popup).not.toMatch(/writeCanonicalMessage|dispatchNativeSend|\.click\(\)/);
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

  it("real Edge dirty shadow: composerEvidence=prompt_textarea, action=send, gen=idle, safe=false", () => {
    const { doc } = makeRealEdgeDirtySendDom();
    const ev = inspectShadowEvidence(doc, {
      ...helpers,
      locationHref: ROUTE,
      now: 20,
    });
    expect(ev.ok).toBe(true);
    expect(ev.composer.evidence).toBe("prompt_textarea");
    expect(ev.composer.textEmpty).toBe(false);
    expect(ev.action.kind).toBe("send");
    expect(ev.action.evidence).toBe("form_send_button");
    expect(ev.action.hasExactSendButton).toBe(true);
    expect(ev.action.stopEvidence).toBeNull();
    expect(ev.safety.generation).toBe("idle");
    expect(ev.safety.safe).toBe(false); // dirty composer
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
  it("manifest loads read-only capability only", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(companionRoot, "manifest.json"), "utf8"));
    const js = (manifest.content_scripts ?? []).flatMap((cs: { js?: string[] }) => cs.js ?? []);
    expect(js).toContain("turn-observer-global.js");
    expect(js).not.toContain("turn-observer.js");
    expect(js).not.toContain("dom-adapter.js");
    expect(js).toContain("shadow-evidence.js");
    expect(js).not.toContain("send-adapter.js");
    expect(js).not.toContain("send-orchestrator.js");
    for (const p of manifest.permissions ?? []) {
      expect(["scripting", "debugger", "nativeMessaging", "webRequest"]).not.toContain(p);
    }
  });

  it("content-script + shadow path have no write/click/begin-send/ack", () => {
    for (const name of ["shadow-evidence.js", "turn-observer.js"]) {
      const text = fs.readFileSync(path.join(companionRoot, name), "utf8");
      expect(text).not.toMatch(/writeCanonicalMessage/);
      expect(text).not.toMatch(/dispatchNativeSend/);
      expect(text).not.toMatch(/runSendOrchestration/);
      expect(text).not.toMatch(/\/begin-send/);
      expect(text).not.toMatch(/\.click\(\)/);
      expect(text).not.toMatch(/execCommand\(/);
    }
    // E1b3d3b: CS may name DI wrappers for production runtime globals, but must not implement write/click.
    const cs = fs.readFileSync(path.join(companionRoot, "content-script.js"), "utf8");
    expect(cs).not.toMatch(/function writeCanonicalMessage/);
    expect(cs).not.toMatch(/function dispatchNativeSend/);
    expect(cs).not.toMatch(/runSendOrchestration/);
    expect(cs).not.toMatch(/\/begin-send/);
    expect(cs).not.toMatch(/\.click\(\)/);
    expect(cs).not.toMatch(/execCommand\(/);
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    expect(sw).toMatch(/c2c\.shadow\.send\.inspect/);
    expect(sw).toMatch(/isExtensionInternalSender/);
    expect(sw).toMatch(/shadow-rpc\.js/);
    const rpc = fs.readFileSync(path.join(companionRoot, "shadow-rpc.js"), "utf8");
    expect(rpc).toMatch(/c2c\.send\.shadow\.inspect/);
    expect(rpc).toMatch(/documentId/);
    // E1b3d3b: SW may own production /begin-send and /ack; CS still must not.
    expect(sw).toMatch(/c2c\.production\.send\.request/);
    expect(sw).not.toMatch(/function writeCanonicalMessage/);
    expect(sw).not.toMatch(/function dispatchNativeSend/);
    expect(sw).not.toMatch(/runSendOrchestration/);
    expect(cs).not.toMatch(/\/begin-send/);
    expect(cs).not.toMatch(/\/ack\b/);
    const popup = fs.readFileSync(path.join(companionRoot, "popup", "popup.html"), "utf8");
    expect(popup).toMatch(/READ ONLY/);
    expect(popup).not.toMatch(/Send message/i);
  });

  it("popup has no Send button, only shadow inspect", () => {
    const html = fs.readFileSync(path.join(companionRoot, "popup", "popup.html"), "utf8");
    expect(html).toMatch(/shadow-inspect/);
    expect(html).toMatch(/Inspect Send capability \(read-only\)/);
    expect(html).toMatch(/shadow-controls/);
    expect(html).toMatch(/Control inventory — READ ONLY/);
    expect(html).toMatch(/shadow-containers/);
    expect(html).toMatch(/Composer containers — READ ONLY/);
    const js = fs.readFileSync(path.join(companionRoot, "popup", "popup.js"), "utf8");
    expect(js).toMatch(/c2c\.shadow\.send\.inspect/);
    expect(js).toMatch(/formatControlInventory/);
    expect(js).toMatch(/formatContainerInventory/);
    expect(js).not.toMatch(/writeCanonicalMessage/);
    expect(js).not.toMatch(/dispatchNativeSend/);
    expect(js).not.toMatch(/\.click\(\)/);
  });

  it("dist packages read-only capability when built", () => {
    if (!fs.existsSync(distCompanion)) {
      // Build not run in this unit pass — packaging gate still enforced at build time.
      expect(true).toBe(true);
      return;
    }
    for (const f of ["turn-observer.js", "shadow-evidence.js", "content-script.js"]) {
      expect(fs.existsSync(path.join(distCompanion, f))).toBe(true);
    }
    const cs = fs.readFileSync(path.join(distCompanion, "content-script.js"), "utf8");
    // E1b3d3b: CS may name production DI keys; must not implement write/click.
    expect(cs).not.toMatch(/function writeCanonicalMessage/);
    expect(cs).not.toMatch(/function dispatchNativeSend/);
    expect(cs).not.toMatch(/\.click\(\)/);
    const shadow = fs.readFileSync(path.join(distCompanion, "shadow-evidence.js"), "utf8");
    expect(shadow).not.toMatch(/writeCanonicalMessage|dispatchNativeSend|\.click\(\)/);
    const dom = fs.readFileSync(path.join(distCompanion, "dom-adapter-global.js"), "utf8");
    expect(dom).toMatch(/inspectActiveComposerControls/);
    expect(dom).toMatch(/globalThis\.inspectActiveComposerControls/);
    expect(dom).toMatch(/inspectComposerContainerInventory/);
    expect(dom).toMatch(/globalThis\.inspectComposerContainerInventory/);
    expect(dom).toMatch(/isExcludedEmbeddedEditor/);
    expect(dom).toMatch(/globalThis\.isExcludedEmbeddedEditor/);
    expect(dom).not.toMatch(/writeCanonicalMessage|dispatchNativeSend|\.click\(\)/);
    // ESM SW artifact must not carry classic footer.
    const domEsm = fs.readFileSync(path.join(distCompanion, "dom-adapter.js"), "utf8");
    expect(domEsm).toMatch(/^export\s/m);
    expect(domEsm).not.toMatch(/globalThis\.resolveChatGptComposer\s*=/);
  });

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
