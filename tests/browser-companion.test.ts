import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  emptyOwnerState,
  observeDocument,
  bindOwner,
  invalidateOnRouteChange,
  invalidateOnTabRemoved,
  invalidateOnDocumentChanged,
  isOwner,
  resetSessionOwnership,
  resolveSenderDocumentIdentity,
  applyObserveOwnership,
} from "../browser-companion/ownership.js";
import { observeChatGptSafety, fakeDom } from "../browser-companion/dom-adapter.js";
import {
  parseChatgptConversationRoute,
  normalizeChatgptConversationRoute,
  normalizeControlConversationUrl,
} from "../src/chatgpt/route.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROUTE = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const ROUTE_B = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";

function doc(tabId: number, documentId: string, canonicalRoute: string, generation = 1) {
  return { tabId, documentId, canonicalRoute, generation, frameId: 0, lastSeen: Date.now() };
}

describe("browser companion manifest", () => {
  it("MV3, ChatGPT-only hosts, no dangerous permissions", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(projectRoot, "browser-companion", "manifest.json"), "utf8"),
    );
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.host_permissions).toEqual([
      "https://chatgpt.com/*",
      "https://www.chatgpt.com/*",
    ]);
    expect(manifest.host_permissions).not.toContain("<all_urls>");
    const perms = manifest.permissions ?? [];
    for (const banned of ["debugger", "nativeMessaging", "webRequest", "webRequestBlocking", "scripting", "tabs"]) {
      expect(perms).not.toContain(banned);
    }
    expect(perms).toContain("storage");
    expect(perms).toContain("activeTab");
    expect(manifest.background?.service_worker).toBe("service-worker.js");
    expect(manifest.background?.type).toBe("module");
    expect(manifest.content_scripts?.[0]?.all_frames).toBe(false);
  });
});

describe("sender document identity (P1 fail-closed)", () => {
  it("missing documentId cannot bind / cannot invent identity", () => {
    const id = resolveSenderDocumentIdentity({ tab: { id: 3 }, frameId: 0 });
    expect(id.ok).toBe(false);
    if (!id.ok) expect(id.reason).toBe("document_id_unavailable");
    // no synthetic documentId field
    expect(JSON.stringify(id)).not.toContain("unknown-doc");
  });

  it("reload with missing documentId cannot inherit owner", () => {
    const bound = bindOwner(emptyOwnerState(), doc(1, "real-doc-1", ROUTE), ROUTE);
    expect(bound.ok).toBe(true);
    // same tab after reload, but sender lacks documentId — cannot re-bind
    const missing = resolveSenderDocumentIdentity({ tab: { id: 1 }, frameId: 0 });
    expect(missing.ok).toBe(false);
    // ownership remains tied to real-doc-1 only
    expect(isOwner(bound.state, 1, "real-doc-1")).toBe(true);
    expect(isOwner(bound.state, 1, "")).toBe(false);
  });

  it("subframe and no-tab rejected", () => {
    expect(resolveSenderDocumentIdentity({ tab: { id: 1 }, frameId: 2, documentId: "d" }).ok).toBe(false);
    expect(resolveSenderDocumentIdentity({ frameId: 0, documentId: "d" }).ok).toBe(false);
    const ok = resolveSenderDocumentIdentity({ tab: { id: 9 }, frameId: 0, documentId: "doc-9" });
    expect(ok).toEqual({ ok: true, tabId: 9, documentId: "doc-9", frameId: 0 });
  });
});

describe("ownership reducer", () => {
  it("correct tab+document can bind; wrong route cannot", () => {
    const state = emptyOwnerState();
    const bad = bindOwner(state, doc(1, "d1", ROUTE_B), ROUTE);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("route_mismatch");
    const good = bindOwner(state, doc(1, "d1", ROUTE), ROUTE);
    expect(good.ok).toBe(true);
    expect(isOwner(good.state, 1, "d1")).toBe(true);
  });

  it("empty documentId cannot bind", () => {
    const r = bindOwner(emptyOwnerState(), doc(1, "", ROUTE), ROUTE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("document_id_required");
  });

  it("subframe cannot bind", () => {
    const r = bindOwner(emptyOwnerState(), { ...doc(1, "d1", ROUTE), frameId: 2 }, ROUTE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("subframe_forbidden");
  });

  it("second tab does not silently steal owner", () => {
    const first = bindOwner(emptyOwnerState(), doc(1, "d1", ROUTE), ROUTE);
    expect(first.ok).toBe(true);
    const observed = observeDocument(first.state, doc(2, "d2", ROUTE));
    expect(isOwner(observed, 1, "d1")).toBe(true);
    expect(isOwner(observed, 2, "d2")).toBe(false);
    const stolen = bindOwner(observed, doc(2, "d2", ROUTE), ROUTE);
    expect(stolen.ok).toBe(true);
    expect(isOwner(stolen.state, 2, "d2")).toBe(true);
    expect(isOwner(stolen.state, 1, "d1")).toBe(false);
  });

  it("navigation away invalidates owner", () => {
    const bound = bindOwner(emptyOwnerState(), doc(1, "d1", ROUTE), ROUTE);
    expect(bound.ok).toBe(true);
    const next = invalidateOnRouteChange(bound.state, 1, "d1", ROUTE_B);
    expect(next.owner).toBeNull();
  });

  it("new document cannot inherit old document authorization", () => {
    const bound = bindOwner(emptyOwnerState(), doc(1, "d1", ROUTE), ROUTE);
    expect(bound.ok).toBe(true);
    const afterReload = invalidateOnDocumentChanged(bound.state, 1, "d1", "d2");
    expect(isOwner(afterReload, 1, "d2")).toBe(false);
    expect(afterReload.owner).toBeNull();
  });

  it("tab removal invalidates owner", () => {
    const bound = bindOwner(emptyOwnerState(), doc(7, "d7", ROUTE), ROUTE);
    expect(bound.ok).toBe(true);
    const next = invalidateOnTabRemoved(bound.state, 7);
    expect(next.owner).toBeNull();
    expect(next.registry).toHaveLength(0);
  });

  it("browser session reset clears ephemeral ownership but keeps targetRoute", () => {
    const bound = bindOwner(emptyOwnerState(), doc(1, "d1", ROUTE), ROUTE);
    const reset = resetSessionOwnership(bound.state);
    expect(reset.owner).toBeNull();
    expect(reset.targetRoute).toBe(ROUTE);
  });
});

describe("DOM adapter generation positive evidence (P1)", () => {
  it("composer empty without positive idle evidence → unknown, safe=false", () => {
    const s = observeChatGptSafety(fakeDom({ composerText: "  ", stop: false, sendEnabled: false }), {
      routeValid: true,
    });
    expect(s.composer).toBe("empty");
    expect(s.generation).toBe("unknown");
    expect(s.safe).toBe(false);
    expect(s.reasons).toContain("generation_unknown");
  });

  it("send enabled + no stop → idle; empty composer can be safe", () => {
    const s = observeChatGptSafety(
      fakeDom({ composerText: "", stop: false, sendEnabled: true }),
      { routeValid: true },
    );
    expect(s.generation).toBe("idle");
    expect(s.safe).toBe(true);
  });

  it("composer dirty → unsafe", () => {
    const s = observeChatGptSafety(
      fakeDom({ composerText: "draft", stop: false, sendEnabled: true }),
      { routeValid: true },
    );
    expect(s.composer).toBe("dirty");
    expect(s.safe).toBe(false);
  });

  it("stop button → generating", () => {
    const s = observeChatGptSafety(
      fakeDom({ composerText: "", stop: true, sendEnabled: false }),
      { routeValid: true },
    );
    expect(s.generation).toBe("generating");
    expect(s.safe).toBe(false);
  });

  it("unsupported DOM → unknown unsafe", () => {
    const s = observeChatGptSafety(fakeDom({ hasBody: false, hasComposer: false }), {
      routeValid: true,
    });
    expect(s.safe).toBe(false);
    expect(s.adapterSupported).toBe(false);
  });

  it("does not mutate input document", () => {
    const d = fakeDom({ composerText: "x", sendEnabled: true });
    const before = JSON.stringify(Object.keys(d));
    observeChatGptSafety(d, { routeValid: true });
    expect(JSON.stringify(Object.keys(d))).toBe(before);
  });
});

describe("ownership reload / page status (final review-fix)", () => {
  it("bind tab1/d1 → observe tab1/d2 → owner=null", () => {
    const bound = bindOwner(emptyOwnerState(), doc(1, "d1", ROUTE), ROUTE);
    expect(bound.ok).toBe(true);
    const next = applyObserveOwnership(bound.state, {
      tabId: 1,
      documentId: "d2",
      canonicalRoute: ROUTE,
      generation: 2,
    });
    expect(next.owner).toBeNull();
    expect(isOwner(next, 1, "d2")).toBe(false);
  });

  it("bind tab1/d1 → same tab missing documentId → owner=null", () => {
    const bound = bindOwner(emptyOwnerState(), doc(1, "d1", ROUTE), ROUTE);
    expect(bound.ok).toBe(true);
    const next = applyObserveOwnership(bound.state, {
      tabId: 1,
      documentId: null,
      canonicalRoute: ROUTE,
    });
    expect(next.owner).toBeNull();
  });

  it("other tab without documentId does not clear owner", () => {
    const bound = bindOwner(emptyOwnerState(), doc(1, "d1", ROUTE), ROUTE);
    const next = applyObserveOwnership(bound.state, {
      tabId: 2,
      documentId: null,
      canonicalRoute: ROUTE,
    });
    expect(isOwner(next, 1, "d1")).toBe(true);
  });

  it("same document remains owner after observe", () => {
    const bound = bindOwner(emptyOwnerState(), doc(1, "d1", ROUTE), ROUTE);
    const next = applyObserveOwnership(bound.state, {
      tabId: 1,
      documentId: "d1",
      canonicalRoute: ROUTE,
    });
    expect(isOwner(next, 1, "d1")).toBe(true);
  });

  it("tab2 same route does not steal owner on observe", () => {
    const bound = bindOwner(emptyOwnerState(), doc(1, "d1", ROUTE), ROUTE);
    const next = applyObserveOwnership(bound.state, {
      tabId: 2,
      documentId: "d2",
      canonicalRoute: ROUTE,
    });
    expect(isOwner(next, 1, "d1")).toBe(true);
    expect(isOwner(next, 2, "d2")).toBe(false);
  });
});

describe("companion conversation id policy (P2)", () => {
  it("companion rejects unverified non-UUID conversation id", () => {
    expect(() =>
      normalizeChatgptConversationRoute("https://chatgpt.com/c/not-a-uuid-id"),
    ).toThrow();
  });

  it("web-control still accepts legacy id charset", () => {
    expect(normalizeControlConversationUrl("https://chatgpt.com/c/not-a-uuid-id"))
      .toBe("https://chatgpt.com/c/not-a-uuid-id");
  });

  it("companion accepts UUID / gpt-shaped UUID route", () => {
    expect(normalizeChatgptConversationRoute(ROUTE)).toBe(ROUTE);
    expect(() =>
      parseChatgptConversationRoute(`https://chatgpt.com/g/g-abc/c/${ROUTE.split("/").pop()}`, {
        allowQueryOrHash: false,
        conversationIdPolicy: "uuid",
      }),
    ).not.toThrow();
  });
});
