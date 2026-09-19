import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildSendProbeMessage,
  emptySendProbeLatch,
  parseSendProbeLatch,
  canStartSendProbe,
  buildSendProbeExecuteRequest,
  classifySendProbeRpcResult,
  validateSendProbeCompletedResponse,
  executeSendProbeMutationRpc,
  SEND_PROBE_LATCH_KEY,
} from "../browser-companion/send-probe.js";
import { dispatchNativeSend } from "../browser-companion/send-click-adapter.js";
import { runRealSendProbe } from "../browser-companion/send-probe-run.js";
import { parseChatgptConversationRoute } from "../src/chatgpt/route.js";
import { WRITE_PROBE_MESSAGE } from "../browser-companion/write-probe.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const companionRoot = path.join(projectRoot, "browser-companion");
const distCompanion = path.join(projectRoot, "dist", "browser-companion");

const ROUTE = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const ATTEMPT = "22222222-2222-4222-8222-222222222222";
const PROBE = buildSendProbeMessage(ATTEMPT)!;

function sharedParse(href: string) {
  return parseChatgptConversationRoute(href, {
    allowQueryOrHash: false,
    conversationIdPolicy: "uuid",
  });
}

function p(text: string) {
  return { tagName: "P", textContent: text };
}

function makeSendDom(opts: {
  blocks?: string[];
  sendReady?: boolean;
  becomeSendAfterWrite?: boolean;
  stop?: boolean;
  turns?: string[];
  sendThrows?: boolean;
} = {}) {
  const parts = opts.blocks ?? [""];
  const state = {
    blocks: parts,
    turns: opts.turns ?? [],
    clicks: 0,
    href: ROUTE,
    sendReady: opts.sendReady === true,
  };
  const sendBtn = {
    tagName: "BUTTON",
    className: "composer-submit-btn composer-submit-button-color",
    getAttribute: (n: string) =>
      n === "data-testid" ? "send-button" : n === "type" ? "submit" : n === "aria-label" ? "发送提示词" : null,
    hasAttribute: (n: string) => n === "data-testid",
    disabled: false,
    click() {
      if (opts.sendThrows) throw new Error("click boom");
      state.clicks += 1;
    },
  };
  const voice = {
    className: "composer-submit-button-color text-submit-btn-text",
    getAttribute: (n: string) => (n === "aria-label" ? "启动语音功能" : null),
    hasAttribute: () => false,
    disabled: false,
    click: () => {
      state.clicks += 1;
    },
  };
  const stopBtn = {
    className: "composer-submit-btn composer-submit-button-color",
    getAttribute: (n: string) => (n === "data-testid" ? "composer-stop-button" : null),
    hasAttribute: (n: string) => n === "data-testid",
    disabled: false,
  };
  const form = {
    querySelector(selector: string) {
      if (selector === 'button[data-testid="send-button"]') {
        return state.sendReady ? sendBtn : null;
      }
      if (selector === "button.composer-submit-button-color") {
        if (opts.stop) return stopBtn;
        return state.sendReady ? sendBtn : voice;
      }
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector !== "button") return [];
      if (opts.stop) return [stopBtn];
      return state.sendReady ? [sendBtn] : [voice];
    },
  };
  const editor: Record<string, unknown> = {
    tagName: "DIV",
    id: "prompt-textarea",
    className: "ProseMirror",
    getAttribute: (n: string) => (n === "contenteditable" ? "true" : null),
    hasAttribute: () => false,
    closest: (s: string) => (s === "form" ? form : null),
    focus: () => {},
    get children() {
      return {
        length: state.blocks.length,
        ...Object.fromEntries(state.blocks.map((t, i) => [String(i), p(t)])),
      };
    },
    textContent: state.blocks.join(""),
  };
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
    execCommand: (_c: string, _u: boolean, v: string) => {
      state.blocks = String(v).split("\n");
      if (opts.becomeSendAfterWrite) state.sendReady = true;
      return true;
    },
    queryCommandSupported: () => true,
    querySelector(selector: string) {
      if (selector === "#prompt-textarea" || selector.includes("ProseMirror") || selector.includes("contenteditable")) {
        return editor;
      }
      if (selector.includes("textarea")) return null;
      if (selector === "body") return {};
      if (selector === "main") return {};
      if (opts.stop && (selector.includes("stop-button") || selector.includes("Stop"))) {
        return stopBtn;
      }
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector.includes("conversation-turn") || selector.includes("data-message-author-role")) {
        return state.turns.map((text, i) => ({
          getAttribute: (n: string) =>
            n === "data-message-author-role" ? "user" : n === "data-testid" ? `conversation-turn-${i}` : null,
          textContent: text,
          innerText: text,
          closest: () => ({ getAttribute: () => `conversation-turn-${i}` }),
          querySelector: () => null,
        }));
      }
      return [];
    },
  } as never;

  return {
    doc,
    state,
    sendBtn,
    getCurrentHref: () => state.href,
  };
}

const noWait = async () => {};

describe("E1b3d3a send probe contract", () => {
  it("fixed message builder + attempt marker shape (no terminal LF)", () => {
    expect(PROBE).toContain("[C2C_SEND_PROBE]");
    expect(PROBE).toContain("NO_PRODUCTION_EVENT=1");
    expect(PROBE).toContain(`ATTEMPT_ID: ${ATTEMPT}`);
    expect(PROBE).toContain("TOKEN=e1b3d3");
    expect(PROBE.endsWith("\n")).toBe(false);
    expect(buildSendProbeMessage("")).toBeNull();
  });

  it("popup cannot supply message/attempt/route/document", () => {
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    expect(sw).toMatch(/c2c\.send\.probe\.request/);
    expect(sw).toMatch(/send_probe_payload_forbidden/);
    expect(sw).toMatch(/popup_sender_required/);
    const popup = fs.readFileSync(path.join(companionRoot, "popup", "popup.js"), "utf8");
    expect(popup).toMatch(/c2c\.send\.probe\.request/);
    expect(popup).toMatch(/c2c\.send\.probe\.reset/);
    expect(popup).not.toMatch(/type:\s*"c2c\.send\.probe\.request",\s*message:/);
    const html = fs.readFileSync(path.join(companionRoot, "popup", "popup.html"), "utf8");
    expect(html).toMatch(/I understand this sends a real ChatGPT message/);
    expect(html).toMatch(/SEND one test message/);
  });

  it("bind sendMessage reject is surfaced, not silently swallowed", () => {
    const popup = fs.readFileSync(path.join(companionRoot, "popup", "popup.js"), "utf8");
    expect(popup).toMatch(/content_script_unavailable/);
    expect(popup).toMatch(/bind 失败/);
  });

  it("SW continues to import send-probe ESM chain", () => {
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    expect(sw).toMatch(/from "\.\/send-probe\.js"/);
  });

  it("canStartSendProbe: journal/latch/owner gates", () => {
    const owner = { tabId: 1, documentId: "d", canonicalRoute: ROUTE, generation: 3 };
    const transport = { routeCanonical: ROUTE, authStale: false };
    expect(canStartSendProbe({ owner, transport, journalIsNone: true, latch: emptySendProbeLatch() }).ok).toBe(true);
    expect(canStartSendProbe({ owner, transport, journalIsNone: false, latch: emptySendProbeLatch() }).reason)
      .toBe("send_probe_journal_active");
    expect(canStartSendProbe({
      owner,
      transport,
      journalIsNone: true,
      latch: { ...emptySendProbeLatch(), state: "COMPLETED" },
    }).reason).toBe("send_probe_latch_active");
    expect(canStartSendProbe({
      owner,
      transport,
      journalIsNone: true,
      latch: { ...emptySendProbeLatch(), state: "EXECUTION_INTENT" },
    }).reason).toBe("send_probe_latch_active");
    expect(canStartSendProbe({
      owner: { ...owner, canonicalRoute: "x" },
      transport,
      journalIsNone: true,
      latch: emptySendProbeLatch(),
    }).reason).toBe("owner_route_mismatch");
  });

  it("execute request builds fixed template internally (no caller message)", () => {
    const owner = { tabId: 9, documentId: "doc-9", canonicalRoute: ROUTE, generation: 4 };
    const transport = { routeCanonical: ROUTE, authStale: false };
    const req = buildSendProbeExecuteRequest(owner, transport, ATTEMPT);
    expect(req.ok).toBe(true);
    expect(req.sendOptions).toEqual({ documentId: "doc-9" });
    expect(req.message.type).toBe("c2c.send.probe.execute");
    expect(req.message.probeMessage).toBe(buildSendProbeMessage(ATTEMPT));
    // arity: no message parameter
    expect(buildSendProbeExecuteRequest.length).toBe(3);
  });

  it("validateSendProbeCompletedResponse requires full exact DTO + latch identity", () => {
    const latch = {
      ...emptySendProbeLatch(),
      state: "EXECUTION_INTENT",
      attemptId: ATTEMPT,
      canonicalRoute: ROUTE,
      generation: 11,
    };
    const full = {
      mode: "send_probe_real",
      ok: true,
      mutationAttempted: true,
      wrote: true,
      verified: true,
      clickAttempted: true,
      clicked: true,
      observed: true,
      attemptId: ATTEMPT,
      canonicalRoute: ROUTE,
      generation: 11,
    };
    expect(validateSendProbeCompletedResponse(full, latch).ok).toBe(true);
    expect(validateSendProbeCompletedResponse({ ...full, verified: false }, latch).ok).toBe(false);
    expect(validateSendProbeCompletedResponse({ ...full, attemptId: "x" }, latch).reason)
      .toBe("send_probe_attempt_mismatch");
    expect(validateSendProbeCompletedResponse(
      { ...full, canonicalRoute: ROUTE.replace("1111", "9999") },
      latch,
    ).reason).toBe("send_probe_route_mismatch");
    expect(validateSendProbeCompletedResponse({ ...full, generation: 10 }, latch).reason)
      .toBe("send_probe_generation_mismatch");
    expect(validateSendProbeCompletedResponse({ ...full, clickAttempted: undefined as never }, latch).reason)
      .toBe("send_probe_response_inconsistent");
  });

  it("classify: completed / pre_mutation / unknown (strict)", () => {
    const latch = {
      ...emptySendProbeLatch(),
      state: "EXECUTION_INTENT",
      attemptId: ATTEMPT,
      canonicalRoute: ROUTE,
      generation: 3,
    };
    const full = {
      mode: "send_probe_real",
      ok: true,
      mutationAttempted: true,
      wrote: true,
      verified: true,
      clickAttempted: true,
      clicked: true,
      observed: true,
      attemptId: ATTEMPT,
      canonicalRoute: ROUTE,
      generation: 3,
    };
    expect(classifySendProbeRpcResult(full, latch).outcome).toBe("completed");
    // ok+clicked+observed but verified false → unknown
    expect(classifySendProbeRpcResult({ ...full, verified: false }, latch).outcome).toBe("unknown");
    expect(classifySendProbeRpcResult({ ...full, attemptId: "other" }, latch).outcome).toBe("unknown");
    expect(classifySendProbeRpcResult({ ...full, generation: 99 }, latch).outcome).toBe("unknown");
    expect(classifySendProbeRpcResult({
      mode: "send_probe_real",
      ok: false,
      reason: "composer_dirty",
      mutationAttempted: false,
      clickAttempted: false,
    }, latch).outcome).toBe("pre_mutation");
    expect(classifySendProbeRpcResult(null, latch).outcome).toBe("unknown");
  });

  it("latch parse: no key → NONE; unknown/corrupt → OUTCOME_UNKNOWN blocked", () => {
    expect(SEND_PROBE_LATCH_KEY).toBe("c2c_send_probe_latch_v1");
    expect(parseSendProbeLatch(null).state).toBe("NONE");
    expect(parseSendProbeLatch(undefined).state).toBe("NONE");
    expect(parseSendProbeLatch({ state: "COMPLETED", attemptId: ATTEMPT }).state).toBe("COMPLETED");
    expect(parseSendProbeLatch({ state: "EXECUTION_INTENT", attemptId: ATTEMPT }).state)
      .toBe("EXECUTION_INTENT");
    expect(parseSendProbeLatch({ state: "NOPE" }).state).toBe("OUTCOME_UNKNOWN");
    expect(parseSendProbeLatch({ state: 123 }).state).toBe("OUTCOME_UNKNOWN");
    const owner = { tabId: 1, documentId: "d", canonicalRoute: ROUTE, generation: 1 };
    const transport = { routeCanonical: ROUTE, authStale: false };
    expect(canStartSendProbe({
      owner,
      transport,
      journalIsNone: true,
      latch: parseSendProbeLatch({ state: "NOPE" }),
    }).ok).toBe(false);
    expect(canStartSendProbe({
      owner,
      transport,
      journalIsNone: true,
      latch: parseSendProbeLatch(null),
    }).ok).toBe(true);
  });

  it("executeSendProbeMutationRpc: persist reject → zero RPC", async () => {
    const intentLatch = {
      ...emptySendProbeLatch(),
      state: "EXECUTION_INTENT",
      attemptId: ATTEMPT,
      canonicalRoute: ROUTE,
      generation: 3,
    };
    let rpcCalls = 0;
    const r = await executeSendProbeMutationRpc({
      intentLatch,
      persistLatch: async () => false,
      invokeRpc: async () => {
        rpcCalls += 1;
        return null;
      },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("send_probe_latch_persist_failed");
    expect(r.mutationAttempted).toBe(false);
    expect(r.clickAttempted).toBe(false);
    expect(rpcCalls).toBe(0);
  });

  it("executeSendProbeMutationRpc: persist throw → zero RPC fail closed", async () => {
    const intentLatch = {
      ...emptySendProbeLatch(),
      state: "EXECUTION_INTENT",
      attemptId: ATTEMPT,
      canonicalRoute: ROUTE,
      generation: 3,
    };
    let rpcCalls = 0;
    const r = await executeSendProbeMutationRpc({
      intentLatch,
      persistLatch: async () => {
        throw new Error("storage down");
      },
      invokeRpc: async () => {
        rpcCalls += 1;
        return null;
      },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("send_probe_latch_persist_failed");
    expect(r.mutationAttempted).toBe(false);
    expect(rpcCalls).toBe(0);
  });

  it("SW source: durable intent before RPC, OUTCOME_UNKNOWN, journal NONE, persist fail-closed", () => {
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    expect(sw).toMatch(/EXECUTION_INTENT/);
    expect(sw).toMatch(/OUTCOME_UNKNOWN/);
    expect(sw).toMatch(/send_probe_outcome_unknown/);
    expect(sw).toMatch(/send_probe_latch_persist_failed/);
    expect(sw).toMatch(/journalActive\(journal\)/);
    expect(sw).toMatch(/crypto\.randomUUID/);
    const probeFn = sw.slice(sw.indexOf("async function handleSendProbe"));
    const body = probeFn.slice(0, probeFn.indexOf("async function handleSendProbeReset"));
    expect(body).not.toMatch(/markSendIntent|markClaimed|markObservedPendingAck/);
    expect(body).toMatch(/executeSendProbeMutationRpc/);
    expect(body).toMatch(/persistSendProbeLatch/);
    expect(body).toMatch(/send_probe_latch_persist_failed/);
    expect(sw).toMatch(/chrome\.tabs\.sendMessage/);
    // COMPLETED success fields must come from response, not hardcoded true.
    expect(body).toMatch(/mutationAttempted: response\.mutationAttempted === true/);
    expect(body).toMatch(/observed: response\.observed === true/);
  });

  it("persistSendProbeLatch returns false on storage failure (fail-closed contract)", () => {
    const sw = fs.readFileSync(path.join(companionRoot, "service-worker.js"), "utf8");
    const fn = sw.slice(sw.indexOf("async function persistSendProbeLatch"));
    const body = fn.slice(0, fn.indexOf("async function persistLocal"));
    expect(body).toMatch(/return true/);
    expect(body).toMatch(/return false/);
  });
});

describe("E1b3d3a runRealSendProbe", () => {
  const gen = { value: 5 };
  const optsBase = () => ({
    expectedRoute: ROUTE,
    expectedGeneration: 5,
    probeMessage: PROBE,
    attemptId: ATTEMPT,
    locationHref: ROUTE,
    parseRoute: sharedParse,
    getCurrentGeneration: () => gen.value,
    waitMs: noWait,
    readyTimeoutMs: 1,
    observeTimeoutMs: 1,
    pollMs: 1,
  });

  it("wrong route → zero write/click", async () => {
    gen.value = 5;
    const { doc, state } = makeSendDom({});
    const r = await runRealSendProbe(doc, {
      ...optsBase(),
      locationHref: "https://chatgpt.com/c/99999999-9999-4999-8999-999999999999",
      getCurrentHref: () => "https://chatgpt.com/c/99999999-9999-4999-8999-999999999999",
    });
    expect(r.ok).toBe(false);
    expect(r.mutationAttempted).toBe(false);
    expect(r.clickAttempted).toBe(false);
    expect(state.clicks).toBe(0);
  });

  it("arbitrary probe message rejected before write", async () => {
    gen.value = 5;
    const { doc, state } = makeSendDom({});
    const r = await runRealSendProbe(doc, {
      ...optsBase(),
      probeMessage: "not the fixed template",
      getCurrentHref: () => ROUTE,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("send_probe_payload_invalid");
    expect(r.mutationAttempted).toBe(false);
    expect(state.clicks).toBe(0);
  });

  it("initial generation mismatch → zero write/click", async () => {
    gen.value = 9;
    const { doc, state } = makeSendDom({});
    const r = await runRealSendProbe(doc, { ...optsBase(), getCurrentHref: () => ROUTE });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("send_probe_generation_mismatch");
    expect(r.mutationAttempted).toBe(false);
    expect(r.clickAttempted).toBe(false);
    expect(state.clicks).toBe(0);
  });

  it("dirty composer → zero write/click", async () => {
    gen.value = 5;
    const { doc, state } = makeSendDom({ blocks: ["already dirty"] });
    const r = await runRealSendProbe(doc, { ...optsBase(), getCurrentHref: () => ROUTE });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("composer_dirty");
    expect(r.mutationAttempted).toBe(false);
    expect(state.clicks).toBe(0);
  });

  it("empty composer but action=send → send_probe_not_idle, zero write/click", async () => {
    gen.value = 5;
    const { doc, state } = makeSendDom({ sendReady: true });
    const r = await runRealSendProbe(doc, { ...optsBase(), getCurrentHref: () => ROUTE });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("send_probe_not_idle");
    expect(r.mutationAttempted).toBe(false);
    expect(state.clicks).toBe(0);
  });

  it("Stop active → zero write/click", async () => {
    gen.value = 5;
    const { doc, state } = makeSendDom({ stop: true });
    const r = await runRealSendProbe(doc, { ...optsBase(), getCurrentHref: () => ROUTE });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("generation_active");
    expect(r.mutationAttempted).toBe(false);
    expect(state.clicks).toBe(0);
  });

  it("Send readiness timeout → write but zero click", async () => {
    gen.value = 5;
    const { doc, state } = makeSendDom({ sendReady: false });
    const r = await runRealSendProbe(doc, {
      ...optsBase(),
      readyTimeoutMs: 1,
      getCurrentHref: () => ROUTE,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("send_button_not_ready");
    expect(r.mutationAttempted).toBe(true);
    expect(r.wrote).toBe(true);
    expect(r.clickAttempted).toBe(false);
    expect(state.clicks).toBe(0);
  });

  it("generation drift during readiness wait → zero click", async () => {
    gen.value = 5;
    const { doc, state } = makeSendDom({ sendReady: false });
    let polls = 0;
    const flipGen = () => {
      polls += 1;
      if (polls > 3) gen.value = 6;
      return gen.value;
    };
    const r = await runRealSendProbe(doc, {
      ...optsBase(),
      getCurrentGeneration: flipGen,
      readyTimeoutMs: 200,
      pollMs: 1,
      getCurrentHref: () => ROUTE,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("send_probe_generation_mismatch");
    expect(r.mutationAttempted).toBe(true);
    expect(r.clickAttempted).toBe(false);
    expect(state.clicks).toBe(0);
  });

  it("route drift after write before ready → zero click", async () => {
    gen.value = 5;
    const { doc, state } = makeSendDom({ sendReady: false });
    let n = 0;
    const flipHref = () => {
      n += 1;
      return n < 4 ? ROUTE : "https://chatgpt.com/c/99999999-9999-4999-8999-999999999999";
    };
    const r = await runRealSendProbe(doc, {
      ...optsBase(),
      readyTimeoutMs: 200,
      pollMs: 1,
      getCurrentHref: flipHref,
      locationHref: ROUTE,
    });
    expect(r.ok).toBe(false);
    expect(r.mutationAttempted).toBe(true);
    expect(r.clickAttempted).toBe(false);
    expect(state.clicks).toBe(0);
  });

  it("generation drift immediately before dispatch after ready → zero click", async () => {
    gen.value = 5;
    const { doc, state } = makeSendDom({ becomeSendAfterWrite: true });
    let calls = 0;
    const flipBeforeDispatch = () => {
      calls += 1;
      // entry + first ready-loop checks stay 5; final fence sees 6.
      if (calls >= 3) return 6;
      return 5;
    };
    const r = await runRealSendProbe(doc, {
      ...optsBase(),
      getCurrentGeneration: flipBeforeDispatch,
      getCurrentHref: () => ROUTE,
      readyTimeoutMs: 50,
      pollMs: 1,
      observeTimeoutMs: 5,
      findCanonicalUserTurn: () => ({ ok: false, reason: "not_observed" }),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("send_probe_generation_mismatch");
    expect(r.mutationAttempted).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.clickAttempted).toBe(false);
    expect(state.clicks).toBe(0);
  });

  it("ready + exact USER turn → observed exactly once", async () => {
    gen.value = 5;
    const { doc, state } = makeSendDom({ becomeSendAfterWrite: true, turns: [PROBE] });
    const r = await runRealSendProbe(doc, {
      ...optsBase(),
      getCurrentHref: () => ROUTE,
      snapshotUserTurns: () => [],
      findCanonicalUserTurn: () => ({ ok: true, turn: { text: PROBE } }),
      observeTimeoutMs: 50,
    });
    expect(r.ok).toBe(true);
    expect(r.clicked).toBe(true);
    expect(r.observed).toBe(true);
    expect(state.clicks).toBe(1);
  });

  it("click throw → no retry, clickAttempted true, clicked false", async () => {
    gen.value = 5;
    const { doc, state } = makeSendDom({ becomeSendAfterWrite: true, sendThrows: true });
    const r = await runRealSendProbe(doc, {
      ...optsBase(),
      getCurrentHref: () => ROUTE,
      findCanonicalUserTurn: () => ({ ok: false, reason: "not_observed" }),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("send_click_error");
    expect(r.clickAttempted).toBe(true);
    expect(r.clicked).toBe(false);
    expect(state.clicks).toBe(0);
  });

  it("not observed after click → blocked outcome fields", async () => {
    gen.value = 5;
    const { doc, state } = makeSendDom({ becomeSendAfterWrite: true });
    const r = await runRealSendProbe(doc, {
      ...optsBase(),
      getCurrentHref: () => ROUTE,
      observeTimeoutMs: 5,
      findCanonicalUserTurn: () => ({ ok: false, reason: "not_observed" }),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("not_observed");
    expect(r.clickAttempted).toBe(true);
    expect(r.clicked).toBe(true);
    expect(r.observed).toBe(false);
    expect(state.clicks).toBe(1);
  });
});

describe("E1b3d3a observer exactness (pure)", () => {
  it("findCanonicalUserTurn ignores unrelated / handles zero/one/many", async () => {
    const { findCanonicalUserTurn, snapshotUserTurns, hasExactAttemptMarker } = await import(
      "../browser-companion/turn-observer.js"
    );
    expect(hasExactAttemptMarker(PROBE, ATTEMPT).ok).toBe(true);
    expect(hasExactAttemptMarker(PROBE, "11111111-1111-4111-8111-111111111111").ok).toBe(false);

    function docWithTurns(texts: string[]) {
      return {
        querySelectorAll: () => texts.map((text, i) => ({
          getAttribute: (n: string) =>
            n === "data-message-author-role" ? "user" : n === "data-testid" ? `conversation-turn-${i}` : null,
          textContent: text,
          innerText: text,
          closest: () => ({ getAttribute: () => `conversation-turn-${i}` }),
          querySelector: () => null,
        })),
      } as never;
    }

    const unrelated = findCanonicalUserTurn(docWithTurns(["hello world", "other"]), {
      message: PROBE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(unrelated.ok).toBe(false);
    expect(unrelated.reason).toBe("not_observed");

    const one = findCanonicalUserTurn(docWithTurns(["hello", PROBE]), {
      message: PROBE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(one.ok).toBe(true);

    const two = findCanonicalUserTurn(docWithTurns([PROBE, PROBE]), {
      message: PROBE,
      attemptId: ATTEMPT,
      baseline: [],
    });
    expect(two.ok).toBe(false);
    expect(two.reason).toBe("ambiguous");

    // baseline excludes existing identical turn
    const baseDoc = docWithTurns([PROBE]);
    const baseline = snapshotUserTurns(baseDoc);
    const same = findCanonicalUserTurn(baseDoc, {
      message: PROBE,
      attemptId: ATTEMPT,
      baseline,
    });
    expect(same.ok).toBe(false);
    expect(same.reason).toBe("not_observed");
  });
});

describe("E1b3d3a classic built-artifact execution", () => {
  function loadClassic(files: string[]) {
    const sandbox: Record<string, unknown> = { console };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    for (const f of files) {
      const p = path.join(distCompanion, f);
      if (!fs.existsSync(p)) continue;
      const src = fs.readFileSync(p, "utf8");
      expect(src).not.toMatch(/^\s*export\s/m);
      expect(src).not.toMatch(/^\s*import\s/m);
      vm.runInContext(src, sandbox, { filename: f });
    }
    return sandbox;
  }

  it("classic runtime scripts parse and expose __c2cRunRealSendProbe", () => {
    if (!fs.existsSync(distCompanion)) {
      expect(true).toBe(true);
      return;
    }
    const runner = path.join(distCompanion, "send-probe-run.js");
    expect(fs.existsSync(runner)).toBe(true);
    const runnerSrc = fs.readFileSync(runner, "utf8");
    expect(runnerSrc).not.toMatch(/^\s*export\s/m);
    expect(runnerSrc).not.toMatch(/^\s*import\s/m);
    expect(runnerSrc).toMatch(/async function runRealSendProbe/);
    expect(runnerSrc).toMatch(/^\(function \(\)/m);
    expect(runnerSrc).toMatch(/globalThis\.__c2cWriteCanonicalMessage/);
    expect(runnerSrc).toMatch(/globalThis\.__c2cReadCanonicalComposerText/);
    expect(runnerSrc).toMatch(/globalThis\.__c2cVerifyCanonicalComposer/);
    expect(runnerSrc).toMatch(/globalThis\.__c2cResolveMutationCanonicalRoute/);
    expect(runnerSrc).toMatch(/globalThis\.buildSendProbeMessage/);
    expect(runnerSrc).not.toMatch(/globalThis\.(writeCanonicalMessage|readCanonicalComposerText|verifyCanonicalComposer)\s*=/);

    const sandbox = loadClassic([
      "route-global.js",
      "dom-adapter-global.js",
      "turn-observer-global.js",
      "composer-write-adapter.js",
      "send-click-adapter.js",
      "send-probe-message-global.js",
      "send-probe-run.js",
    ]);
    expect(typeof sandbox.__c2cRunRealSendProbe).toBe("function");
    expect(typeof sandbox.buildSendProbeMessage).toBe("function");
    expect(sandbox.writeCanonicalMessage).toBeUndefined();
  });

  it("classic send-probe runner uses namespaced write deps without ReferenceError", async () => {
    if (!fs.existsSync(path.join(distCompanion, "send-probe-run.js"))) {
      expect(true).toBe(true);
      return;
    }
    const sandbox = loadClassic([
      "route-global.js",
      "dom-adapter-global.js",
      "turn-observer-global.js",
      "composer-write-adapter.js",
      "send-click-adapter.js",
      "send-probe-message-global.js",
      "send-probe-run.js",
    ]);
    const run = sandbox.__c2cRunRealSendProbe as (
      doc: unknown,
      opts: Record<string, unknown>,
    ) => Promise<{ ok: boolean; reason?: string; wrote?: boolean; verified?: boolean }>;
    const build = sandbox.buildSendProbeMessage as (id: string) => string;
    const probeMessage = build(ATTEMPT);
    const fixture = makeSendDom({ sendReady: false, blocks: [""] });
    const r = await run(fixture.doc, {
      probeMessage,
      attemptId: ATTEMPT,
      expectedRoute: ROUTE,
      expectedGeneration: 1,
      locationHref: ROUTE,
      parseRoute: sharedParse,
      getCurrentHref: () => ROUTE,
      getCurrentGeneration: () => 1,
      waitMs: noWait,
      readyTimeoutMs: 150,
      pollMs: 10,
    });
    // Must reach write/verify/read/route-resolve; stop before click (send not ready).
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("send_button_not_ready");
    expect(r.wrote).toBe(true);
    expect(r.verified).toBe(true);
    expect(fixture.state.clicks).toBe(0);
  });

  it("classic runner invalid payload returns send_probe_payload_invalid without ReferenceError", async () => {
    if (!fs.existsSync(path.join(distCompanion, "send-probe-run.js"))) {
      expect(true).toBe(true);
      return;
    }
    const sandbox = loadClassic([
      "route-global.js",
      "dom-adapter-global.js",
      "turn-observer-global.js",
      "composer-write-adapter.js",
      "send-click-adapter.js",
      "send-probe-message-global.js",
      "send-probe-run.js",
    ]);
    const run = sandbox.__c2cRunRealSendProbe as (
      doc: unknown,
      opts: Record<string, unknown>,
    ) => Promise<{ ok: boolean; reason?: string }>;
    const r = await run({ querySelector: () => null, querySelectorAll: () => [] }, {
      expectedRoute: ROUTE,
      expectedGeneration: 1,
      attemptId: ATTEMPT,
      probeMessage: "not-fixed",
      locationHref: ROUTE,
      getCurrentHref: () => ROUTE,
      getCurrentGeneration: () => 1,
      waitMs: async () => {},
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("send_probe_payload_invalid");
  });

  it("built send-probe.js ESM imports message helper (not classic-overwritten)", async () => {
    const esmPath = path.join(distCompanion, "send-probe-message.js");
    if (!fs.existsSync(esmPath)) {
      expect(true).toBe(true);
      return;
    }
    const esm = fs.readFileSync(esmPath, "utf8");
    expect(esm).toMatch(/export const SEND_PROBE_TOKEN/);
    expect(esm).toMatch(/export function buildSendProbeMessage/);
    expect(esm).not.toMatch(/globalThis\.buildSendProbeMessage/);
    const globalPath = path.join(distCompanion, "send-probe-message-global.js");
    expect(fs.existsSync(globalPath)).toBe(true);
    const globalSrc = fs.readFileSync(globalPath, "utf8");
    expect(globalSrc).not.toMatch(/^\s*export\s/m);
    expect(globalSrc).not.toMatch(/^\s*import\s/m);
    expect(globalSrc).toMatch(/globalThis\.buildSendProbeMessage/);

    const mod = await import(pathToFileURL(path.join(distCompanion, "send-probe.js")).href);
    expect(typeof mod.buildSendProbeMessage).toBe("function");
    expect(mod.buildSendProbeMessage(ATTEMPT)).toBe(buildSendProbeMessage(ATTEMPT));
  });
});

describe("E1b3d3a runtime packaging", () => {
  function loadClassicPackaged(files: string[]) {
    const sandbox: Record<string, unknown> = { console };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    for (const f of files) {
      const p = path.join(distCompanion, f);
      if (!fs.existsSync(p)) continue;
      const src = fs.readFileSync(p, "utf8");
      vm.runInContext(src, sandbox, { filename: f });
    }
    return sandbox;
  }

  it("manifest loads send-click-adapter, not orchestrator", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(companionRoot, "manifest.json"), "utf8"));
    const js = (manifest.content_scripts ?? []).flatMap((cs: { js?: string[] }) => cs.js ?? []);
    expect(js).toContain("send-click-adapter.js");
    expect(js).toContain("send-probe-message-global.js");
    expect(js).toContain("send-probe-run.js");
    expect(js).toContain("composer-write-adapter.js");
    expect(js).not.toContain("send-probe-message.js");
    expect(js).not.toContain("send-orchestrator.js");
    expect(js).not.toContain("send-adapter.js");
  });

  it("only send-click-adapter may contain .click() among pure capability modules", () => {
    const files = [
      "content-script.js",
      "shadow-evidence.js",
      "turn-observer.js",
      "composer-write-adapter.js",
    ];
    for (const f of files) {
      const text = fs.readFileSync(path.join(companionRoot, f), "utf8");
      expect(text).not.toMatch(/\.click\(\)/);
    }
    const click = fs.readFileSync(path.join(companionRoot, "send-click-adapter.js"), "utf8");
    const clickCode = click.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(clickCode).toMatch(/\.click\(\)/);
    expect(clickCode).not.toMatch(/execCommand/);
    expect(clickCode).not.toMatch(/begin-send|\/ack\b/);
    const runner = fs.readFileSync(path.join(companionRoot, "send-probe-run.js"), "utf8");
    const runnerCode = runner.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(runnerCode).not.toMatch(/\.click\(\)/);
    expect(runnerCode).not.toMatch(/markSendIntent|begin-send|\/ack\b/);
  });

  it("send-adapter re-exports click adapter for compat", () => {
    const src = fs.readFileSync(path.join(companionRoot, "send-adapter.js"), "utf8");
    expect(src).toMatch(/from "\.\/send-click-adapter\.js"/);
    expect(src).toMatch(/dispatchNativeSend/);
  });

  it("classic click adapter IIFE binds namespaced deps; probe runner exposes runRealSendProbe", () => {
    if (!fs.existsSync(path.join(distCompanion, "send-click-adapter.js"))) {
      expect(true).toBe(true);
      return;
    }
    const classic = fs.readFileSync(path.join(distCompanion, "send-click-adapter.js"), "utf8");
    expect(classic).toMatch(/globalThis\.__c2cDispatchNativeSend/);
    expect(classic).toMatch(/^\(function \(\)/m);
    expect(classic).toMatch(/globalThis\.__c2cReadCanonicalComposerText/);
    expect(classic).toMatch(/globalThis\.resolveChatGptComposer/);
    expect(classic).toMatch(/globalThis\.resolveChatGptAction/);
    expect(classic).toMatch(/globalThis\.normalizeCanonicalDomText/);
    expect(classic).not.toMatch(/globalThis\.readCanonicalComposerText\s*=/);
    const runner = fs.readFileSync(path.join(distCompanion, "send-probe-run.js"), "utf8");
    expect(runner).toMatch(/globalThis\.__c2cRunRealSendProbe/);
    const build = fs.readFileSync(path.join(projectRoot, "scripts", "build-browser-companion.mjs"), "utf8");
    expect(build).toMatch(/send-click dep/);
    expect(build).toMatch(/send-click-adapter\.js classic must be wrapped in IIFE/);
    expect(build).toMatch(/must not expose unnamespaced readCanonicalComposerText/);
  });

  it("built classic __c2cDispatchNativeSend click count without ReferenceError", () => {
    if (!fs.existsSync(path.join(distCompanion, "send-click-adapter.js"))) {
      expect(true).toBe(true);
      return;
    }
    const sandbox = loadClassicPackaged([
      "route-global.js",
      "dom-adapter-global.js",
      "turn-observer-global.js",
      "composer-write-adapter.js",
      "send-click-adapter.js",
    ]);
    const dispatch = sandbox.__c2cDispatchNativeSend as (
      doc: unknown,
      message: string,
      opts?: Record<string, unknown>,
    ) => { ok: boolean; reason?: string; clicked?: number };
    expect(typeof dispatch).toBe("function");
    expect(sandbox.readCanonicalComposerText).toBeUndefined();

    const MESSAGE = "hello exact composer";
    let clicks = 0;
    const sendBtn = {
      tagName: "BUTTON",
      getAttribute: (n: string) =>
        n === "data-testid" ? "send-button" : n === "type" ? "submit" : n === "aria-label" ? "发送提示词" : null,
      hasAttribute: (n: string) => n === "data-testid",
      disabled: false,
      click() {
        clicks += 1;
      },
    };
    const form = {
      querySelector(selector: string) {
        if (selector === 'button[data-testid="send-button"]') return sendBtn;
        if (selector === "button.composer-submit-button-color") return sendBtn;
        return null;
      },
      querySelectorAll(selector: string) {
        return selector === "button" ? [sendBtn] : [];
      },
    };
    const editor: Record<string, unknown> = {
      tagName: "DIV",
      id: "prompt-textarea",
      className: "ProseMirror",
      getAttribute: (n: string) => (n === "contenteditable" ? "true" : null),
      hasAttribute: () => false,
      closest: (s: string) => (s === "form" ? form : null),
      focus: () => {},
      children: { length: 1, 0: { tagName: "P", textContent: MESSAGE } },
      textContent: MESSAGE,
    };
    const doc = {
      querySelector(selector: string) {
        if (selector === "#prompt-textarea" || selector.includes("ProseMirror") || selector.includes("contenteditable")) {
          return editor;
        }
        return null;
      },
      querySelectorAll: () => [],
    };

    clicks = 0;
    const good = dispatch(doc, MESSAGE, { routeValid: true });
    expect(good.ok).toBe(true);
    expect(good.clicked).toBe(1);
    expect(clicks).toBe(1);

    clicks = 0;
    const bad = dispatch(doc, `${MESSAGE}!`, { routeValid: true });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBe("composer_text_mismatch");
    expect(clicks).toBe(0);
  });

  it("dispatchNativeSend still one-shot exact fence", () => {
    const { doc, state, sendBtn } = makeSendDom({ sendReady: true, blocks: PROBE.split("\n") });
    expect(dispatchNativeSend(doc, PROBE, { routeValid: true }).ok).toBe(true);
    expect(state.clicks).toBe(1);
    expect(sendBtn.getAttribute("data-testid")).toBe("send-button");
    const bad = makeSendDom({ sendReady: true, blocks: ["nope"] });
    expect(dispatchNativeSend(bad.doc, PROBE, { routeValid: true }).ok).toBe(false);
    expect(bad.state.clicks).toBe(0);
  });
});

// silence unused import in some environments
void WRITE_PROBE_MESSAGE;
