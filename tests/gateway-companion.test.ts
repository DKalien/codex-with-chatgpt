import { afterEach, describe, expect, it, vi } from "vitest";

import { createProjectChrome, createProjectContextRouter, PROJECT_REGISTRY_KEY, PROJECT_SELECTION_KEY, projectStorageKey } from "../browser-companion/project-context.js";

const EXTENSION_ID = "gateway-companion-test-id";

const WORKSPACE_A = "111111aaaaaa";

const WORKSPACE_B = "222222bbbbbb";

const ORIGIN_A = "https://bridge-a.example.test";

const ORIGIN_B = "https://bridge-b.example.test";

const ROUTE_A = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";

const ROUTE_B = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";

const TRANSPORT_KEY = "c2c_companion_transport_v1";

const JOURNAL_KEY = "c2c_companion_journal_v1";

function event() {
  const listeners = new Set<(...args: any[]) => void>();
  return {
    addListener(listener: (...args: any[]) => void) { listeners.add(listener); },
    fire(...args: any[]) { for (const listener of listeners) listener(...args); },
    getListeners() { return [...listeners]; },
  };
}

function storageArea(
  initial: Record<string, unknown> = {},
  options: { failSetKey?: string | null; failGetNull?: boolean; failAccess?: boolean; failExactGet?: Set<string> } = {},
) {
  const values = new Map(Object.entries(initial));
  const area = {
    values,
    failSetKey: options.failSetKey ?? null,
    async get(keys?: string | string[] | Record<string, unknown> | null) {
      if (keys == null) {
        if (options.failGetNull) throw new Error("get-all-failed");
        return Object.fromEntries(values);
      }
      const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      if (list.length === 1 && options.failExactGet?.has(list[0])) throw new Error("exact-get-failed");
      return Object.fromEntries(list.map(key => [key, values.get(key)]));
    },
    async set(row: Record<string, unknown>) {
      if (area.failSetKey && Object.hasOwn(row, area.failSetKey)) throw new Error("set-failed");
      for (const [key, value] of Object.entries(row)) values.set(key, value);
    },
    async remove(keys: string | string[]) {
      for (const key of typeof keys === "string" ? [keys] : keys) values.delete(key);
    },
    async clear() { values.clear(); },
    async setAccessLevel() {
      if (options.failAccess) throw new Error("access-level-failed");
    },
  };
  return area;
}

function browserWithStorage(
  local = storageArea(),
  session = storageArea(),
  tabsSendMessage: (tabId: number, message: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown> = async () => ({ ok: true }),
) {
  return {
    runtime: { id: EXTENSION_ID, getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}` },
    storage: { local, session },
    tabs: { sendMessage: tabsSendMessage, onRemoved: event() },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function popupSender() { return { id: EXTENSION_ID }; }

describe("Gateway Companion project contexts", () => {

  it("keeps two contexts isolated through concurrent page RPCs and A-only unknown/revoke/refresh", async () => {
    const local = storageArea();
    const session = storageArea();
    const aGate = deferred<unknown>();
    const bGate = deferred<unknown>();
    const starts = new Map<string, ReturnType<typeof deferred<void>>>([
      ["doc-a", deferred<void>()], ["doc-b", deferred<void>()],
    ]);
    const browser = browserWithStorage(local, session, async (tabId, message, options) => {
      const documentId = String(options?.documentId ?? "");
      starts.get(documentId)?.resolve();
      return documentId === "doc-a" ? aGate.promise : bGate.promise;
    });
    const contexts = new Map<string, { owner: { tabId: number; route: string } | null; ack: number; refresh: number }>();
    const router = createProjectContextRouter({
      browser,
      createContext(project, isSelected, withPageSendLock) {
        const scoped = createProjectChrome(browser, project.workspaceId, isSelected, withPageSendLock);
        const state = { owner: null as { tabId: number; route: string } | null, ack: 0, refresh: 0 };
        contexts.set(project.workspaceId, state);
        return {
          async handleMessage(message: Record<string, any>, sender: Record<string, any>) {
            if (message.type === "test.mutate") {
              await scoped.storage.local.set({ [JOURNAL_KEY]: { state: "SEND_INTENT", documentId: message.documentId } });
              return scoped.tabs.sendMessage(message.tabId, { type: "c2c.production.send.execute" }, { documentId: message.documentId });
            }
            if (message.type === "c2c.production.ack") { state.ack += 1; return { ok: true }; }
            if (message.type === "c2c.bind") {
              state.owner = { tabId: sender.tab.id, route: message.canonicalRoute };
              return { ok: true };
            }
            if (message.type === "test.unknown") {
              await scoped.storage.local.set({ [JOURNAL_KEY]: { state: "OUTCOME_UNKNOWN", workspaceId: project.workspaceId } });
              return { ok: true };
            }
            if (message.type === "test.revoke") {
              await scoped.storage.local.set({ [TRANSPORT_KEY]: { workspaceId: project.workspaceId, bridgeOrigin: project.bridgeOrigin, credential: null } });
              return { ok: true };
            }
            if (message.type === "test.refresh") { state.refresh += 1; return { ok: true }; }
            return { ok: false, reason: "test_message_unhandled" };
          },
          async matchesOwner(sender: Record<string, any>) {
            return state.owner?.tabId === sender.tab?.id;
          },
          async matchesDocument(sender: Record<string, any>) {
            return state.owner?.tabId === sender.tab?.id;
          },
          async ownsTabRoute(tabId: number, route: string) {
            return state.owner?.tabId === tabId && state.owner.route === route;
          },
          async summary() { return { workspaceId: project.workspaceId, ack: state.ack, refresh: state.refresh }; },
        };
      },
    });

    await router.handle({ type: "c2c.project.add", project: { workspaceId: WORKSPACE_A, bridgeOrigin: ORIGIN_A } }, popupSender());
    await router.handle({ type: "c2c.project.add", project: { workspaceId: WORKSPACE_B, bridgeOrigin: ORIGIN_B } }, popupSender());
    expect((await router.handle({ type: "c2c.project.select", workspaceId: WORKSPACE_A, tabId: 7, canonicalRoute: ROUTE_A }, popupSender())).ok).toBe(true);
    expect((await router.handle({ type: "c2c.project.select", workspaceId: WORKSPACE_B, tabId: 8, canonicalRoute: ROUTE_B }, popupSender())).ok).toBe(true);
    local.values.set(projectStorageKey(WORKSPACE_A, TRANSPORT_KEY), {
      workspaceId: WORKSPACE_A, bridgeOrigin: ORIGIN_A, credential: "credential-a",
    });
    local.values.set(projectStorageKey(WORKSPACE_B, TRANSPORT_KEY), {
      workspaceId: WORKSPACE_B, bridgeOrigin: ORIGIN_B, credential: "credential-b",
    });
    expect(await router.handle({
      type: "c2c.bind", workspaceId: WORKSPACE_A, canonicalRoute: ROUTE_A,
    }, { id: EXTENSION_ID, tab: { id: 7 }, documentId: "doc-a", url: ROUTE_A })).toMatchObject({ ok: true });
    expect(await router.handle({
      type: "c2c.bind", workspaceId: WORKSPACE_B, canonicalRoute: ROUTE_A,
    }, { id: EXTENSION_ID, tab: { id: 7 }, documentId: "doc-a", url: ROUTE_A }))
      .toMatchObject({ ok: false, reason: "popup_sender_required" });
    expect(await router.handle({
      type: "c2c.project.select", workspaceId: WORKSPACE_B, tabId: 7, canonicalRoute: ROUTE_A,
    }, popupSender())).toMatchObject({ ok: false, reason: "workspace_binding_conflict" });

    const sendA = router.handle({ type: "test.mutate", workspaceId: WORKSPACE_A, tabId: 7, documentId: "doc-a" }, popupSender());
    const sendB = router.handle({ type: "test.mutate", workspaceId: WORKSPACE_B, tabId: 8, documentId: "doc-b" }, popupSender());
    await Promise.all([starts.get("doc-a")!.promise, starts.get("doc-b")!.promise]);
    expect(await router.handle({ type: "c2c.production.ack", workspaceId: WORKSPACE_B }, {
      id: EXTENSION_ID, tab: { id: 7 }, documentId: "doc-a",
    })).toEqual({ ok: false, reason: "workspace_callback_unbound" });
    expect(await router.handle({ type: "c2c.production.ack" }, {
      id: EXTENSION_ID, tab: { id: 7 }, documentId: "doc-a",
    })).toEqual({ ok: true });
    aGate.resolve({ ok: true });
    bGate.resolve({ ok: true });
    await Promise.all([sendA, sendB]);

    const aJournalKey = projectStorageKey(WORKSPACE_A, JOURNAL_KEY);
    const bJournalKey = projectStorageKey(WORKSPACE_B, JOURNAL_KEY);
    expect(local.values.get(aJournalKey)).toMatchObject({ state: "SEND_INTENT", documentId: "doc-a" });
    expect(local.values.get(bJournalKey)).toMatchObject({ state: "SEND_INTENT", documentId: "doc-b" });
    expect(contexts.get(WORKSPACE_A)?.ack).toBe(1);
    expect(contexts.get(WORKSPACE_B)?.ack).toBe(0);

    const bBefore = structuredClone({
      journal: local.values.get(bJournalKey),
      transport: local.values.get(projectStorageKey(WORKSPACE_B, TRANSPORT_KEY)),
      ack: contexts.get(WORKSPACE_B)?.ack,
      refresh: contexts.get(WORKSPACE_B)?.refresh,
    });
    await router.handle({ type: "test.unknown", workspaceId: WORKSPACE_A }, popupSender());
    await router.handle({ type: "test.revoke", workspaceId: WORKSPACE_A }, popupSender());
    await router.handle({ type: "test.refresh", workspaceId: WORKSPACE_A }, popupSender());
    expect(local.values.get(aJournalKey)).toMatchObject({ state: "OUTCOME_UNKNOWN", workspaceId: WORKSPACE_A });
    expect(contexts.get(WORKSPACE_A)?.refresh).toBe(1);
    expect({
      journal: local.values.get(bJournalKey),
      transport: local.values.get(projectStorageKey(WORKSPACE_B, TRANSPORT_KEY)),
      ack: contexts.get(WORKSPACE_B)?.ack,
      refresh: contexts.get(WORKSPACE_B)?.refresh,
    }).toEqual(bBefore);
  });

  it("does not publish failed project/selection writes into memory", async () => {
    const local = storageArea();
    const session = storageArea();
    const browser = browserWithStorage(local, session);
    const router = createProjectContextRouter({
      browser,
      createContext: () => ({
        async handleMessage() { return { ok: true }; },
        async ownsTabRoute() { return false; },
        async summary() { return {}; },
      }),
    });
    await router.handle({ type: "c2c.project.list" }, popupSender());
    local.failSetKey = PROJECT_REGISTRY_KEY;
    expect(await router.handle({ type: "c2c.project.add", project: { workspaceId: WORKSPACE_A, bridgeOrigin: ORIGIN_A } }, popupSender()))
      .toMatchObject({ ok: false, reason: "project_registry_persist_failed" });
    local.failSetKey = null;
    expect(await router.handle({ type: "c2c.project.list" }, popupSender())).toMatchObject({ projects: [] });
    await router.handle({ type: "c2c.project.add", project: { workspaceId: WORKSPACE_A, bridgeOrigin: ORIGIN_A } }, popupSender());
    await router.handle({ type: "c2c.project.select", workspaceId: WORKSPACE_A, tabId: 7, canonicalRoute: ROUTE_A }, popupSender());
    session.failSetKey = PROJECT_SELECTION_KEY;
    expect(await router.handle({ type: "c2c.project.select", workspaceId: WORKSPACE_A, tabId: 7, canonicalRoute: ROUTE_B }, popupSender()))
      .toMatchObject({ ok: false, reason: "workspace_selection_persist_failed" });
    session.failSetKey = null;
    expect(await router.handle({ type: "c2c.project.resolve", tabId: 7, canonicalRoute: ROUTE_A }, popupSender()))
      .toMatchObject({ ok: true, workspaceId: WORKSPACE_A });
    expect(await router.handle({ type: "c2c.project.resolve", tabId: 7, canonicalRoute: ROUTE_B }, popupSender()))
      .toMatchObject({ ok: true, workspaceId: null });
  });

  it("serializes different-tab selection snapshots so no persisted selection is lost", async () => {
    const local = storageArea();
    const session = storageArea();
    const setSelectionStarted = deferred<void>();
    const releaseFirstSelection = deferred<void>();
    const originalSet = session.set.bind(session);
    let selectionWrites = 0;
    session.set = async row => {
      if (Object.hasOwn(row, PROJECT_SELECTION_KEY)) {
        selectionWrites += 1;
        if (selectionWrites === 1) {
          setSelectionStarted.resolve();
          await releaseFirstSelection.promise;
        }
      }
      return originalSet(row);
    };
    const router = createProjectContextRouter({
      browser: browserWithStorage(local, session),
      createContext: () => ({
        async handleMessage() { return { ok: true }; },
        async ownsTabRoute() { return false; },
        async summary() { return {}; },
      }),
    });
    await router.handle({ type: "c2c.project.list" }, popupSender());
    await router.handle({ type: "c2c.project.add", project: { workspaceId: WORKSPACE_A, bridgeOrigin: ORIGIN_A } }, popupSender());
    await router.handle({ type: "c2c.project.add", project: { workspaceId: WORKSPACE_B, bridgeOrigin: ORIGIN_B } }, popupSender());
    const selectA = router.handle({ type: "c2c.project.select", workspaceId: WORKSPACE_A, tabId: 7, canonicalRoute: ROUTE_A }, popupSender());
    const selectB = router.handle({ type: "c2c.project.select", workspaceId: WORKSPACE_B, tabId: 8, canonicalRoute: ROUTE_B }, popupSender());
    await setSelectionStarted.promise;
    releaseFirstSelection.resolve();
    expect(await selectA).toMatchObject({ ok: true, workspaceId: WORKSPACE_A });
    expect(await selectB).toMatchObject({ ok: true, workspaceId: WORKSPACE_B });
    expect(session.values.get(PROJECT_SELECTION_KEY)).toEqual([
      { tabId: 7, workspaceId: WORKSPACE_A, canonicalRoute: ROUTE_A },
      { tabId: 8, workspaceId: WORKSPACE_B, canonicalRoute: ROUTE_B },
    ]);
  });

  it("hydrates saved selections before handling a cold tab removal", async () => {
    const local = storageArea({
      [PROJECT_REGISTRY_KEY]: {
        schemaVersion: 1,
        projects: [{ workspaceId: WORKSPACE_A, bridgeOrigin: ORIGIN_A }],
        legacyMigration: "none",
      },
    });
    const session = storageArea({
      [PROJECT_SELECTION_KEY]: [{ tabId: 7, workspaceId: WORKSPACE_A, canonicalRoute: ROUTE_A }],
    });
    const selectionReadStarted = deferred<void>();
    const releaseSelectionRead = deferred<void>();
    const originalGet = session.get.bind(session);
    session.get = async keys => {
      if (keys === PROJECT_SELECTION_KEY) {
        selectionReadStarted.resolve();
        await releaseSelectionRead.promise;
      }
      return originalGet(keys);
    };
    const removed = vi.fn();
    const router = createProjectContextRouter({
      browser: browserWithStorage(local, session),
      createContext: () => ({
        async handleMessage() { return { ok: true }; },
        async handleTabRemoved(tabId: number) { removed(tabId); },
        async summary() { return {}; },
      }),
    });

    const removal = router.handleTabRemoved(7);
    await selectionReadStarted.promise;
    expect(session.values.get(PROJECT_SELECTION_KEY)).toEqual([
      { tabId: 7, workspaceId: WORKSPACE_A, canonicalRoute: ROUTE_A },
    ]);
    releaseSelectionRead.resolve();
    await removal;
    expect(session.values.get(PROJECT_SELECTION_KEY)).toEqual([]);
    expect(removed).toHaveBeenCalledWith(7);
  });

  it("preserves legacy history and sanitizes credentials when access-level setup fails and get-all is unavailable", async () => {
    const legacyTransport = {
      workspaceId: WORKSPACE_A,
      bridgeOrigin: ORIGIN_A,
      routeCanonical: ROUTE_A,
      companionId: "33333333-3333-4333-8333-333333333333",
      bindingId: "44444444-4444-4444-8444-444444444444",
      credential: "legacy-secret",
    };
    const local = storageArea({
      c2c_companion_transport_v1: legacyTransport,
      c2c_companion_journal_v1: { state: "OUTCOME_UNKNOWN", attemptId: "retain-this" },
    }, { failAccess: true, failGetNull: true });
    const router = createProjectContextRouter({
      browser: browserWithStorage(local, storageArea()),
      createContext: () => ({ async handleMessage() { return { ok: true }; }, async summary() { return {}; } }),
      localKeys: ["c2c_companion_transport_v1", "c2c_companion_journal_v1"],
      transportKey: "c2c_companion_transport_v1",
    });
    expect(await router.handle({ type: "c2c.project.list" }, popupSender()))
      .toMatchObject({ ok: false, reason: "storage_unprotected" });
    expect(local.values.get("c2c_companion_transport_v1")).not.toHaveProperty("credential");
    expect(local.values.get("c2c_companion_journal_v1")).toEqual({ state: "OUTCOME_UNKNOWN", attemptId: "retain-this" });
  });

  it("does not migrate state whose workspace identity is unclear and keeps the old record", async () => {
    const legacyTransport = {
      bridgeOrigin: ORIGIN_A,
      routeCanonical: ROUTE_A,
      companionId: "33333333-3333-4333-8333-333333333333",
      bindingId: "44444444-4444-4444-8444-444444444444",
      credential: "legacy-secret",
    };
    const local = storageArea({
      c2c_companion_transport_v1: legacyTransport,
      c2c_companion_local_v1: { schemaVersion: 1, paired: true, targetRoute: ROUTE_A },
    });
    const router = createProjectContextRouter({
      browser: browserWithStorage(local, storageArea()),
      createContext: () => ({ async handleMessage() { return { ok: true }; }, async summary() { return {}; } }),
      localKeys: ["c2c_companion_transport_v1", "c2c_companion_local_v1"],
      transportKey: "c2c_companion_transport_v1",
    });
    expect(await router.handle({ type: "c2c.project.list" }, popupSender()))
      .toMatchObject({ ok: false, reason: "legacy_state_identity_unknown" });
    expect(local.values.get("c2c_companion_transport_v1")).toEqual(legacyTransport);
    expect(local.values.has(projectStorageKey(WORKSPACE_A, TRANSPORT_KEY))).toBe(false);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
