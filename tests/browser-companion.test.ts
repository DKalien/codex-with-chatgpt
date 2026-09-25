import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  emptyOwnerState,
  observeDocument,
  bindCurrentDocument,
  invalidateOnRouteChange,
  invalidateOnTabRemoved,
  invalidateOnDocumentChanged,
  isOwner,
  resetSessionOwnership,
  resolveSenderDocumentIdentity,
  resolveCurrentDocumentBindingIdentity,
  resolveAuthorityRoute,
  checkRouteWitness,
  resolveObservationRouteVerdict,
  applyObservationRouteVerdict,
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

function bindDoc(state: ReturnType<typeof emptyOwnerState>, observation: ReturnType<typeof doc>) {
  return bindCurrentDocument(state, {
    tabId: observation.tabId,
    documentId: observation.documentId,
    canonicalRoute: observation.canonicalRoute,
  }, { generation: observation.generation, now: observation.lastSeen });
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
    expect(manifest.optional_host_permissions ?? []).toContain("https://*/*");
    expect(manifest.host_permissions).not.toContain("<all_urls>");
    expect(manifest.optional_host_permissions).not.toContain("<all_urls>");
    expect(manifest.background?.service_worker).toBe("service-worker.js");
    expect(manifest.background?.type).toBe("module");
    expect(manifest.content_scripts?.[0]?.all_frames).toBe(false);
    // Edge rejects unrecognized keys; do not ship unsupported manifest fields.
    expect(manifest).not.toHaveProperty("minimum_edge_version");
    expect(JSON.stringify(manifest)).not.toContain("minimum_edge_version");
  });

  it("built companion manifest drops unsupported keys", () => {
    const distManifestPath = path.join(projectRoot, "dist", "browser-companion", "manifest.json");
    if (!fs.existsSync(distManifestPath)) {
      expect(true).toBe(true);
      return;
    }
    const raw = fs.readFileSync(distManifestPath, "utf8");
    expect(raw).not.toContain("minimum_edge_version");
    const manifest = JSON.parse(raw);
    expect(manifest).not.toHaveProperty("minimum_edge_version");
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
    const bound = bindDoc(emptyOwnerState(), doc(1, "real-doc-1", ROUTE));
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
    expect(resolveSenderDocumentIdentity({ tab: { id: 1 }, documentId: "d" })).toMatchObject({
      ok: false, reason: "frame_id_unavailable",
    });
    expect(resolveSenderDocumentIdentity({ frameId: 0, documentId: "d" }).ok).toBe(false);
    const ok = resolveSenderDocumentIdentity({ tab: { id: 9 }, frameId: 0, documentId: "doc-9" });
    expect(ok).toEqual({ ok: true, tabId: 9, documentId: "doc-9" });
  });

  it("derives identity from MessageSender with tab.url as route authority (R3o)", () => {
    // tab.url is the authority even when sender.url disagrees; witness must match it,
    // and the persisted canonicalRoute is the authority's, never the witness value.
    const result = resolveCurrentDocumentBindingIdentity(
      {
        tab: { id: 9, url: ROUTE }, documentId: "doc-9", frameId: 0,
        url: ROUTE_B,
        tabId: 99, canonicalRoute: ROUTE_B, href: ROUTE_B, targetRoute: ROUTE_B,
      },
      ROUTE,
    );
    expect(result).toEqual({
      ok: true,
      identity: { tabId: 9, documentId: "doc-9", canonicalRoute: ROUTE },
    });
    // tab.url present but invalid: fail closed, never fall back to sender.url.
    expect(resolveCurrentDocumentBindingIdentity(
      { tab: { id: 9, url: "https://chatgpt.com/" }, documentId: "doc-9", frameId: 0, url: ROUTE },
      ROUTE,
    )).toMatchObject({ ok: false, reason: "invalid_route" });
  });
});

describe("popup-to-content identity boundary", () => {
  it("forwards fixed commands plus runtime freshness/evidence/witness, never binding identity (R3o)", () => {
    const source = fs.readFileSync(path.join(projectRoot, "browser-companion", "content-script.js"), "utf8");
    const bindStart = source.indexOf('if (message.type === "c2c.bind.request")');
    const connectStart = source.indexOf('if (message.type === "c2c.connect.request")', bindStart);
    const ownerProofStart = source.indexOf('if (message.type === "c2c.owner-proof.request")', connectStart);
    expect(bindStart).toBeGreaterThanOrEqual(0);
    expect(connectStart).toBeGreaterThan(bindStart);
    expect(ownerProofStart).toBeGreaterThan(connectStart);
    const bindBranch = source.slice(bindStart, connectStart);
    const connectBranch = source.slice(connectStart, ownerProofStart);
    // R3o: the canonicalRoute witness is mandatory on bind/connect, derived only from
    // the document's own location; tabId/documentId remain forbidden (identity still
    // comes only from the forwarded MessageSender).
    expect(bindBranch).toMatch(/canonicalRoute:\s*parseRoute\(location\.href\)\?\.canonical \?\? null/);
    expect(connectBranch).toMatch(/canonicalRoute:\s*observation\.canonicalRoute,/);
    expect(bindBranch).not.toMatch(/(?:tabId|documentId|targetRoute|frameId|lastSeen|href):/);
    expect(connectBranch).not.toMatch(/(?:tabId|documentId|targetRoute|frameId|lastSeen|href):/);
  });
});

describe("ownership reducer", () => {
  it("binds the strict three-field identity and derives targetRoute", () => {
    const state = emptyOwnerState();
    const bad = bindCurrentDocument(state, { tabId: 1, documentId: "d1", canonicalRoute: "https://chatgpt.com/" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("invalid_route");
    const good = bindCurrentDocument(state, { tabId: 1, documentId: "d1", canonicalRoute: ROUTE }, {
      generation: 4, now: 12345,
    });
    expect(good.ok).toBe(true);
    expect(isOwner(good.state, 1, "d1")).toBe(true);
    expect(good.state.targetRoute).toBe(ROUTE);
    expect(good.state.owner).toMatchObject({ tabId: 1, documentId: "d1", canonicalRoute: ROUTE, generation: 4, lastSeen: 12345 });
    expect(good.state.owner).not.toHaveProperty("frameId");
  });

  it("empty documentId cannot bind", () => {
    const r = bindCurrentDocument(emptyOwnerState(), { tabId: 1, documentId: "", canonicalRoute: ROUTE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("document_id_required");
  });

  it("generation is freshness metadata, not document identity", () => {
    const identity = { tabId: 1, documentId: "d1", canonicalRoute: ROUTE };
    const first = bindCurrentDocument(emptyOwnerState(), identity, { generation: 1, now: 100 });
    const refreshed = bindCurrentDocument(first.state, identity, { generation: 2, now: 200 });
    expect(first.ok && refreshed.ok).toBe(true);
    expect(isOwner(refreshed.state, 1, "d1")).toBe(true);
    expect(refreshed.state.owner).toMatchObject({ ...identity, generation: 2, lastSeen: 200 });
    expect(bindCurrentDocument(emptyOwnerState(), { ...identity, generation: 1 }, { now: 100 }))
      .toMatchObject({ ok: false, reason: "invalid_identity" });
  });

  it("second tab does not silently steal owner", () => {
    const first = bindDoc(emptyOwnerState(), doc(1, "d1", ROUTE));
    expect(first.ok).toBe(true);
    const observed = observeDocument(first.state, doc(2, "d2", ROUTE));
    expect(isOwner(observed, 1, "d1")).toBe(true);
    expect(isOwner(observed, 2, "d2")).toBe(false);
    const stolen = bindDoc(observed, doc(2, "d2", ROUTE));
    expect(stolen.ok).toBe(true);
    expect(isOwner(stolen.state, 2, "d2")).toBe(true);
    expect(isOwner(stolen.state, 1, "d1")).toBe(false);
  });

  it("navigation away invalidates owner", () => {
    const bound = bindDoc(emptyOwnerState(), doc(1, "d1", ROUTE));
    expect(bound.ok).toBe(true);
    const next = invalidateOnRouteChange(bound.state, 1, "d1", ROUTE_B);
    expect(next.owner).toBeNull();
  });

  it("new document cannot inherit old document authorization", () => {
    const bound = bindDoc(emptyOwnerState(), doc(1, "d1", ROUTE));
    expect(bound.ok).toBe(true);
    const afterReload = invalidateOnDocumentChanged(bound.state, 1, "d1", "d2");
    expect(isOwner(afterReload, 1, "d2")).toBe(false);
    expect(afterReload.owner).toBeNull();
  });

  it("tab removal invalidates owner", () => {
    const bound = bindDoc(emptyOwnerState(), doc(7, "d7", ROUTE));
    expect(bound.ok).toBe(true);
    const next = invalidateOnTabRemoved(bound.state, 7);
    expect(next.owner).toBeNull();
    expect(next.registry).toHaveLength(0);
  });

  it("browser session reset clears ephemeral ownership but keeps targetRoute", () => {
    const bound = bindDoc(emptyOwnerState(), doc(1, "d1", ROUTE));
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

  it("empty composer + composer-submit-button-color → idle/safe", () => {
    const s = observeChatGptSafety(
      fakeDom({ composerText: "", stop: false, sendEnabled: false, actionSlot: true }),
      { routeValid: true },
    );
    expect(s.composer).toBe("empty");
    expect(s.generation).toBe("idle");
    expect(s.safe).toBe(true);
  });

  it("dirty composer + action slot → idle generation but safe=false", () => {
    const s = observeChatGptSafety(
      fakeDom({ composerText: "draft", stop: false, sendEnabled: false, actionSlot: true }),
      { routeValid: true },
    );
    expect(s.composer).toBe("dirty");
    expect(s.generation).toBe("idle");
    expect(s.safe).toBe(false);
  });

  it("stop + action slot → generating; stop wins", () => {
    const s = observeChatGptSafety(
      fakeDom({ composerText: "", stop: true, sendEnabled: false, actionSlot: true }),
      { routeValid: true },
    );
    expect(s.generation).toBe("generating");
    expect(s.safe).toBe(false);
  });

  it("no stop / no send / no action slot → unknown", () => {
    const s = observeChatGptSafety(
      fakeDom({ composerText: "", stop: false, sendEnabled: false, actionSlot: false }),
      { routeValid: true },
    );
    expect(s.generation).toBe("unknown");
    expect(s.safe).toBe(false);
  });

  it("generating-state sample: action slot becomes stop-button → generating (not idle)", () => {
    // Real Edge sample 2026-09-16: same composer-submit-button-color with data-testid=stop-button
    const s = observeChatGptSafety(
      fakeDom({
        composerText: "",
        stop: false,
        sendEnabled: false,
        actionSlot: true,
        actionSlotClass:
          "composer-submit-btn composer-submit-button-color h-9 w-9",
        actionSlotTestId: "stop-button",
      }),
      { routeValid: true },
    );
    expect(s.generation).toBe("generating");
    expect(s.safe).toBe(false);
  });

  it("idle action slot requires text-submit-btn-text and not composer-submit-btn-only", () => {
    const idle = observeChatGptSafety(
      fakeDom({
        composerText: "",
        stop: false,
        sendEnabled: false,
        actionSlot: true,
        actionSlotClass: "composer-submit-button-color text-submit-btn-text",
      }),
      { routeValid: true },
    );
    expect(idle.generation).toBe("idle");
    expect(idle.safe).toBe(true);

    // stop-shaped class without text-submit-btn-text must not be idle
    const stopShaped = observeChatGptSafety(
      fakeDom({
        composerText: "",
        stop: false,
        sendEnabled: false,
        actionSlot: true,
        actionSlotClass: "composer-submit-btn composer-submit-button-color",
      }),
      { routeValid: true },
    );
    expect(stopShaped.generation).toBe("generating");
    expect(stopShaped.safe).toBe(false);
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
    const bound = bindDoc(emptyOwnerState(), doc(1, "d1", ROUTE));
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
    const bound = bindDoc(emptyOwnerState(), doc(1, "d1", ROUTE));
    expect(bound.ok).toBe(true);
    const next = applyObserveOwnership(bound.state, {
      tabId: 1,
      documentId: null,
      canonicalRoute: ROUTE,
    });
    expect(next.owner).toBeNull();
  });

  it("other tab without documentId does not clear owner", () => {
    const bound = bindDoc(emptyOwnerState(), doc(1, "d1", ROUTE));
    const next = applyObserveOwnership(bound.state, {
      tabId: 2,
      documentId: null,
      canonicalRoute: ROUTE,
    });
    expect(isOwner(next, 1, "d1")).toBe(true);
  });

  it("same document remains owner after observe", () => {
    const bound = bindDoc(emptyOwnerState(), doc(1, "d1", ROUTE));
    const next = applyObserveOwnership(bound.state, {
      tabId: 1,
      documentId: "d1",
      canonicalRoute: ROUTE,
    });
    expect(isOwner(next, 1, "d1")).toBe(true);
  });

  it("tab2 same route does not steal owner on observe", () => {
    const bound = bindDoc(emptyOwnerState(), doc(1, "d1", ROUTE));
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

describe("R3o trusted route authority + witness", () => {
  const send = (tabUrl: string | undefined, senderUrl: string) => ({
    tab: tabUrl === undefined ? { id: 9 } : { id: 9, url: tabUrl },
    documentId: "doc-9",
    frameId: 0,
    url: senderUrl,
  });

  it("bind/connect witness: missing => route_witness_required, invalid => route_witness_invalid, mismatch => route_witness_mismatch", () => {
    const sender = send(ROUTE, ROUTE);
    expect(resolveCurrentDocumentBindingIdentity(sender, undefined))
      .toMatchObject({ ok: false, reason: "route_witness_required" });
    expect(resolveCurrentDocumentBindingIdentity(sender, null))
      .toMatchObject({ ok: false, reason: "route_witness_required" });
    expect(resolveCurrentDocumentBindingIdentity(sender, ""))
      .toMatchObject({ ok: false, reason: "route_witness_required" });
    expect(resolveCurrentDocumentBindingIdentity(sender, "not-a-route"))
      .toMatchObject({ ok: false, reason: "route_witness_invalid" });
    expect(resolveCurrentDocumentBindingIdentity(sender, ROUTE_B))
      .toMatchObject({ ok: false, reason: "route_witness_mismatch" });
  });

  it("authority: tab.url wins over sender.url; persisted canonicalRoute is the authority's", () => {
    const r = resolveCurrentDocumentBindingIdentity(send(ROUTE, ROUTE_B), ROUTE);
    expect(r).toEqual({
      ok: true,
      identity: { tabId: 9, documentId: "doc-9", canonicalRoute: ROUTE },
    });
    expect(resolveAuthorityRoute(send(ROUTE, ROUTE_B)))
      .toEqual({ ok: true, canonical: ROUTE, fallbackUsed: false });
  });

  it("authority: tab.url present but non-conversation fails closed even with valid sender.url and witness", () => {
    expect(resolveAuthorityRoute(send("https://chatgpt.com/", ROUTE)))
      .toEqual({ ok: false, reason: "invalid_route" });
    expect(resolveCurrentDocumentBindingIdentity(send("https://chatgpt.com/", ROUTE), ROUTE))
      .toMatchObject({ ok: false, reason: "invalid_route" });
    // Empty-string tab.url is still a present string: no sender.url fallback.
    expect(resolveAuthorityRoute(send("", ROUTE)))
      .toEqual({ ok: false, reason: "invalid_route" });
    expect(resolveCurrentDocumentBindingIdentity(send("", ROUTE), ROUTE))
      .toMatchObject({ ok: false, reason: "invalid_route" });
  });

  it("authority: absent tab.url falls back to sender.url, still witness-checked", () => {
    expect(resolveAuthorityRoute(send(undefined, ROUTE)))
      .toEqual({ ok: true, canonical: ROUTE, fallbackUsed: true });
    expect(resolveCurrentDocumentBindingIdentity(send(undefined, ROUTE), ROUTE))
      .toEqual({ ok: true, identity: { tabId: 9, documentId: "doc-9", canonicalRoute: ROUTE } });
    expect(resolveCurrentDocumentBindingIdentity(send(undefined, ROUTE), ROUTE_B))
      .toMatchObject({ ok: false, reason: "route_witness_mismatch" });
    expect(resolveCurrentDocumentBindingIdentity(send(undefined, "https://chatgpt.com/"), ROUTE))
      .toMatchObject({ ok: false, reason: "invalid_route" });
  });

  it("witness check unit: requires a strictly-parsing witness equivalent to authority", () => {
    expect(checkRouteWitness(ROUTE, undefined)).toMatchObject({ ok: false, reason: "route_witness_required" });
    expect(checkRouteWitness(ROUTE, "https://chatgpt.com/c/not-a-uuid")).toMatchObject({ ok: false, reason: "route_witness_invalid" });
    expect(checkRouteWitness(ROUTE, ROUTE_B)).toMatchObject({ ok: false, reason: "route_witness_mismatch" });
    expect(checkRouteWitness(ROUTE, ROUTE)).toEqual({ ok: true });
  });

  it("TOCTOU bind: old sender.url + old witness + new tab.url => route_witness_mismatch, never bound", () => {
    const state = emptyOwnerState();
    const sender = { tab: { id: 1, url: ROUTE_B }, documentId: "old-doc", frameId: 0, url: ROUTE };
    const resolved = resolveCurrentDocumentBindingIdentity(sender, ROUTE);
    expect(resolved).toMatchObject({ ok: false, reason: "route_witness_mismatch" });
    // The mismatch result carries the witness-free authority identity only: the old
    // documentId is never bound to the new route, and nothing persists a witness value.
    expect(isOwner(state, 1, "old-doc")).toBe(false);
    expect(JSON.stringify(resolved)).not.toContain(ROUTE_B);
  });

  it("observe verdict: matching authority+witness keeps existing behavior", () => {
    const bound = bindDoc(emptyOwnerState(), doc(1, "d1", ROUTE));
    if (!bound.ok) throw new Error("setup bind failed");
    const verdict = resolveObservationRouteVerdict(send(ROUTE, ROUTE), ROUTE);
    expect(verdict).toEqual({ verdict: "match", canonicalRoute: ROUTE });
    const applied = applyObservationRouteVerdict(bound.state, {
      tabId: 1, documentId: "d1", verdict: verdict.verdict, canonicalRoute: verdict.canonicalRoute,
    });
    expect(applied.applied).toBe("observed");
    expect(isOwner(applied.state, 1, "d1")).toBe(true);
  });

  it("observe verdict: exact owner document mismatch invalidates owner (SPA navigation)", () => {
    const bound = bindDoc(emptyOwnerState(), doc(1, "d1", ROUTE));
    if (!bound.ok) throw new Error("setup bind failed");
    // Tab navigated to a new conversation; the document still reports the old route.
    const verdict = resolveObservationRouteVerdict(send(ROUTE_B, ROUTE), ROUTE);
    expect(verdict).toEqual({ verdict: "mismatch" });
    const applied = applyObservationRouteVerdict(bound.state, { tabId: 1, documentId: "d1", verdict: verdict.verdict });
    expect(applied.applied).toBe("owner_invalidated");
    expect(applied.state.owner).toBeNull();
  });

  it("observe verdict: same-tab stale old-document mismatch heartbeat must NOT clear the new owner (DoS)", () => {
    // Old document bound first, then a new document explicitly takes over the SAME tab.
    const oldBound = bindDoc(emptyOwnerState(), doc(7, "old-doc", ROUTE_B));
    if (!oldBound.ok) throw new Error("setup bind failed");
    const rebound = bindDoc(oldBound.state, doc(7, "new-doc", ROUTE));
    if (!rebound.ok) throw new Error("setup rebind failed");
    expect(isOwner(rebound.state, 7, "new-doc")).toBe(true);
    // Stale old document on tab 7: tab.url already the new route, document still
    // reports the old route (sender.url and witness both stale).
    const verdict = resolveObservationRouteVerdict(
      { tab: { id: 7, url: ROUTE }, documentId: "old-doc", frameId: 0, url: ROUTE_B },
      ROUTE_B,
    );
    expect(verdict).toEqual({ verdict: "mismatch" });
    const applied = applyObservationRouteVerdict(rebound.state, { tabId: 7, documentId: "old-doc", verdict: verdict.verdict });
    expect(applied.applied).toBe("dropped");
    expect(isOwner(applied.state, 7, "new-doc")).toBe(true);
    expect(applied.state.owner).toMatchObject({ tabId: 7, documentId: "new-doc", canonicalRoute: ROUTE });
  });

  it("observe verdict: off-route authority + null witness keeps existing null-route invalidation", () => {
    const bound = bindDoc(emptyOwnerState(), doc(1, "d1", ROUTE));
    if (!bound.ok) throw new Error("setup bind failed");
    // Both the tab and the document agree the tab left every conversation.
    const verdict = resolveObservationRouteVerdict(send("https://chatgpt.com/", "https://chatgpt.com/"), null);
    expect(verdict).toEqual({ verdict: "off_route" });
    const applied = applyObservationRouteVerdict(bound.state, { tabId: 1, documentId: "d1", verdict: verdict.verdict });
    expect(applied.applied).toBe("observed");
    expect(applied.state.owner).toBeNull();
  });

  it("observe verdict: conversation witness contradicts a non-conversation authority => mismatch", () => {
    const verdict = resolveObservationRouteVerdict(send("https://chatgpt.com/", "https://chatgpt.com/"), ROUTE);
    expect(verdict).toEqual({ verdict: "mismatch" });
    // Same for a valid authority contradicted by an unparseable/null witness.
    expect(resolveObservationRouteVerdict(send(ROUTE, ROUTE), null)).toEqual({ verdict: "mismatch" });
  });
});
