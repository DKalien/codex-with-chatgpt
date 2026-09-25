import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  FEEDBACK_BOOTSTRAP_MESSAGE,
  findFeedbackBootstrapUserTurn,
  hasFeedbackBootstrapToolMissingReply,
  isFeedbackBootstrapMessage,
  runFeedbackBootstrapSend,
} from "../browser-companion/feedback-bootstrap-run.js";
import { normalizeCanonicalDomText } from "../browser-companion/dom-adapter.js";
import { parseChatgptConversationRoute } from "../src/chatgpt/route.js";

const ROUTE = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const EXTENSION_ID = "c2c-test-extension";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadContentScript(runner?: (...args: any[]) => unknown) {
  let onMessage: ((message: any, sender: any, sendResponse: (response: any) => void) => boolean) | undefined;
  const document = { hidden: false, addEventListener: () => undefined };
  const chrome = {
    runtime: {
      id: EXTENSION_ID,
      lastError: null,
      sendMessage: (_message: unknown, callback?: (response: unknown) => void) => callback?.({ ok: true }),
      onMessage: { addListener: (listener: typeof onMessage) => { onMessage = listener; } },
    },
  };
  const sandbox = {
    chrome,
    document,
    location: { href: ROUTE },
    window: { __c2cCompanionLoaded: false, addEventListener: () => undefined },
    setInterval: () => 0,
    parseChatgptConversationRoute,
    __c2cRunFeedbackBootstrapSend: runner,
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(repositoryRoot, "browser-companion", "content-script.js"), "utf8"),
    sandbox,
  );
  return {
    async dispatch(message: unknown, sender: unknown) {
      let response: unknown;
      const returnValue = onMessage!(message, sender, value => { response = value; });
      if (returnValue === true) await new Promise(resolve => setImmediate(resolve));
      return { returnValue, response };
    },
    document,
  };
}

async function runWithDom(options: Record<string, any> = {}) {
  const dom = await import("../browser-companion/dom-adapter.js");
  const write = await import("../browser-companion/composer-write-adapter.js");
  const click = await import("../browser-companion/send-click-adapter.js");
  const writeProbe = await import("../browser-companion/write-probe.js");
  const editor = { editor: true };
  const button = { getAttribute: (key: string) => key === "data-testid" ? "send-button" : null };
  let writtenText = "";
  let clicks = 0;
  let snapshots = 0;
  const captured: string[] = [];
  vi.spyOn(dom, "resolveChatGptComposer").mockReturnValue({ editor } as any);
  vi.spyOn(dom, "resolveChatGptAction").mockImplementation(() => writtenText
    ? { kind: "send", enabled: true, button } as any
    : { kind: "idle", enabled: true, button: null } as any);
  vi.spyOn(writeProbe, "resolveMutationCanonicalRoute").mockReturnValue({ ok: true, canonical: ROUTE } as any);
  vi.spyOn(write, "readCanonicalComposerText").mockImplementation(() => ({ ok: true, text: writtenText } as any));
  vi.spyOn(write, "writeCanonicalMessage").mockImplementation((_doc, text) => {
    writtenText = text;
    captured.push(text);
    return { ok: true, wrote: true, mutationAttempted: true } as any;
  });
  vi.spyOn(write, "verifyCanonicalComposer").mockReturnValue({ ok: true } as any);
  vi.spyOn(click, "dispatchNativeSend").mockImplementation(async () => {
    clicks += 1;
    return { ok: true, clicked: 1 } as any;
  });
  const result = await runFeedbackBootstrapSend({}, {
    expectedRoute: ROUTE,
    expectedGeneration: 4,
    locationHref: ROUTE,
    getCurrentGeneration: () => 4,
    now: (() => { let time = 0; return () => (time += 100); })(),
    waitMs: async () => {},
    readyTimeoutMs: 1000,
    observeTimeoutMs: 500,
    snapshotUserTurns: () => {
      snapshots += 1;
      if (snapshots === 1) return [];
      return options.turns ?? [{ id: "new-turn", text: FEEDBACK_BOOTSTRAP_MESSAGE }];
    },
    ...options.runner,
    message: "caller-controlled secret must be ignored",
  });
  vi.restoreAllMocks();
  return { result, clicks, captured };
}

describe("fixed feedback bootstrap DOM send", () => {
  it("accepts only the SW-owned exact control message and observes a unique new user turn", async () => {
    expect(isFeedbackBootstrapMessage(FEEDBACK_BOOTSTRAP_MESSAGE)).toBe(true);
    expect(isFeedbackBootstrapMessage(`${FEEDBACK_BOOTSTRAP_MESSAGE}\nextra`)).toBe(false);
    expect(FEEDBACK_BOOTSTRAP_MESSAGE).not.toMatch(/credential|secret|principal|conversationId=/i);
    expect(FEEDBACK_BOOTSTRAP_MESSAGE).toContain("feedback_status");
    expect(FEEDBACK_BOOTSTRAP_MESSAGE).toContain("feedback_takeover");
    expect(FEEDBACK_BOOTSTRAP_MESSAGE).toContain("不调用 codex_desktop_send");

    const { result, clicks, captured } = await runWithDom({
      runner: { message: "must not replace the fixed message" },
    });
    expect(result).toMatchObject({ ok: true, observed: true, clicked: true, mutationAttempted: true });
    expect(clicks).toBe(1);
    expect(captured).toEqual([FEEDBACK_BOOTSTRAP_MESSAGE]);
  });

  it("fails closed on duplicate exact turns and does not report observation", () => {
    const turns = [
      { id: "one", text: FEEDBACK_BOOTSTRAP_MESSAGE },
      { id: "two", text: FEEDBACK_BOOTSTRAP_MESSAGE },
    ];
    expect(findFeedbackBootstrapUserTurn({
      turns,
      message: FEEDBACK_BOOTSTRAP_MESSAGE,
      baseline: [],
    })).toMatchObject({ ok: false, reason: "bootstrap_observation_ambiguous" });
  });

  it("does not count a baseline copy or a body-mismatched turn", () => {
    const old = { id: "old", text: FEEDBACK_BOOTSTRAP_MESSAGE };
    expect(findFeedbackBootstrapUserTurn({
      turns: [old],
      message: FEEDBACK_BOOTSTRAP_MESSAGE,
      baseline: [old],
    })).toMatchObject({ ok: false, reason: "bootstrap_not_observed" });
    expect(findFeedbackBootstrapUserTurn({
      turns: [{ id: "wrong", text: normalizeCanonicalDomText(FEEDBACK_BOOTSTRAP_MESSAGE).replace("feedback_status", "other_tool") }],
      message: FEEDBACK_BOOTSTRAP_MESSAGE,
      baseline: [],
    })).toMatchObject({ ok: false, reason: "bootstrap_not_observed" });
  });

  it("reports tool absence only from the exact assistant sentinel after the exact bootstrap turn", () => {
    const user = {
      getAttribute: (key: string) => key === "data-message-author-role" ? "user" : null,
      innerText: FEEDBACK_BOOTSTRAP_MESSAGE,
    };
    const missing = {
      getAttribute: (key: string) => key === "data-message-author-role" ? "assistant" : null,
      innerText: "C2C_FEEDBACK_BOOTSTRAP_TOOL_MISSING",
    };
    const normalAssistant = {
      getAttribute: (key: string) => key === "data-message-author-role" ? "assistant" : null,
      innerText: "I called the available feedback tools.",
    };
    expect(hasFeedbackBootstrapToolMissingReply({ querySelectorAll: () => [user, missing] } as any)).toBe(true);
    expect(hasFeedbackBootstrapToolMissingReply({ querySelectorAll: () => [missing, user] } as any)).toBe(false);
    expect(hasFeedbackBootstrapToolMissingReply({ querySelectorAll: () => [user, missing, user, normalAssistant] } as any)).toBe(false);
  });
});

describe("content-script fixed feedback bootstrap sender", () => {
  it.each([
    ["missing sender URL", { id: EXTENSION_ID, tab: null }],
    ["alternate internal extension URL", { id: EXTENSION_ID, tab: null, url: `chrome-extension://${EXTENSION_ID}/popup.html` }],
  ])("accepts same-extension internal sender with %s", async (_label, sender) => {
    const runner = vi.fn(async () => ({
      ok: true, mutationAttempted: true, clickAttempted: true, clicked: true, observed: true,
    }));
    const harness = loadContentScript(runner);
    const result = await harness.dispatch({
      type: "c2c.feedback.bootstrap.execute",
      expectedRoute: ROUTE,
      expectedGeneration: 1,
      message: "caller body must not be forwarded",
      bootstrapMessage: "caller body must not be forwarded",
    }, sender);

    expect(result.returnValue).toBe(true);
    expect(result.response).toMatchObject({ ok: true, mode: "feedback_bootstrap_send" });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0][0]).toBe(harness.document);
    expect(runner.mock.calls[0][1]).toMatchObject({
      expectedRoute: ROUTE,
      expectedGeneration: 1,
      locationHref: ROUTE,
    });
    expect(runner.mock.calls[0][1]).not.toHaveProperty("message");
    expect(runner.mock.calls[0][1]).not.toHaveProperty("bootstrapMessage");
  });

  it.each([
    ["external extension", { id: "another-extension", tab: null }],
    ["tab content script", { id: EXTENSION_ID, tab: { id: 7 }, url: ROUTE }],
  ])("rejects %s before invoking the fixed runner", async (_label, sender) => {
    const runner = vi.fn();
    const harness = loadContentScript(runner);
    const result = await harness.dispatch({ type: "c2c.feedback.bootstrap.execute" }, sender);
    expect(result.returnValue).toBe(false);
    expect(result.response).toMatchObject({
      ok: false,
      reason: "bootstrap_sender_invalid",
      mutationAttempted: false,
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("reports a missing fixed runner without DOM mutation", async () => {
    const harness = loadContentScript();
    const result = await harness.dispatch(
      { type: "c2c.feedback.bootstrap.execute" },
      { id: EXTENSION_ID, tab: null },
    );
    expect(result.returnValue).toBe(false);
    expect(result.response).toMatchObject({
      ok: false,
      reason: "bootstrap_capability_missing",
      mutationAttempted: false,
    });
  });
});
