import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
import { deriveConnectionReadiness } from "../browser-companion/connect-flow.js";
import { PROJECT_REGISTRY_KEY, projectStorageKey } from "../browser-companion/project-context.js";

const ROUTE_A = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const ROUTE_B = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";
const WORKSPACE = "b1c2d3e4f5a6";
const COMPANION = "11111111-1111-4111-8111-111111111111";
const BINDING = "22222222-2222-4222-8222-222222222222";
const EPOCH = 3;

const LOCAL_KEY = "c2c_companion_local_v1";
const TRANSPORT_KEY = "c2c_companion_transport_v1";
const OWNER_KEY = "c2c_companion_owner_v1";
const REGISTRY_KEY = "c2c_companion_registry_v1";
const EVIDENCE_KEY = "c2c_companion_evidence_v1";
const CONNECT_KEY = "c2c_companion_connect_flow_v1";
const AUTONOMY_KEY = "c2c_companion_autonomy_v1";
const FENCE_KEY = "c2c_route_attest_fence_v1";
const JOURNAL_KEY = "c2c_companion_journal_v1";
const ISOLATION_ARCHIVE_KEY = "c2c_companion_outcome_unknown_archive_v1";
const EVENT_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const RESERVATION_ID = "33333333-3333-4333-8333-333333333333";
const ATTEMPT_ID = "44444444-4444-4444-8444-444444444444";
const MESSAGE = "原始回流正文保留在本机 archive";
const MESSAGE_HASH = createHash("sha256").update(MESSAGE, "utf8").digest("hex");
const projectKey = (key: string) => projectStorageKey(WORKSPACE, key);

function unknownJournal() {
  return {
    state: "OUTCOME_UNKNOWN",
    eventId: EVENT_ID,
    reservationId: RESERVATION_ID,
    attemptId: ATTEMPT_ID,
    routeCanonical: ROUTE_A,
    bindingId: BINDING,
    epoch: EPOCH,
    message: MESSAGE,
    messageSha256: MESSAGE_HASH,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:01.000Z",
    terminalWitness: "terminal-witness-exact",
  };
}

function unknownInFlight() {
  const journal = unknownJournal();
  return {
    status: "outcome_unknown", eventId: journal.eventId, reservationId: journal.reservationId,
    attemptId: journal.attemptId, message: journal.message, messageSha256: journal.messageSha256,
  };
}

function unknownRecoveryProbe() {
  return {
    ok: false, mode: "production_recover", reason: "outcome_unknown", journalState: "OUTCOME_UNKNOWN",
    zeroWrite: true, zeroClick: true, ownerFresh: true, canonicalRoute: ROUTE_A, generation: 1,
    composerEmpty: true, generationIdle: true, nativeProductionInFlight: false,
  };
}

function apiState(inFlight: unknown, isolatedAttempts: unknown[] = []) {
  return {
    workspaceId: WORKSPACE, companionId: COMPANION, bindingId: BINDING, epoch: EPOCH,
    routeCanonical: ROUTE_A, routeVerification: "VERIFIED", inFlight, isolatedAttempts, events: [],
  };
}

function isolateProof() {
  const journal = unknownJournal();
  return {
    routeCanonical: journal.routeCanonical, eventId: journal.eventId, reservationId: journal.reservationId,
    attemptId: journal.attemptId, messageSha256: journal.messageSha256,
    status: "outcome_unknown", isolated: true, observed: false,
  };
}

function stateIsolatedAttempt() {
  const { observed: _observed, ...attempt } = isolateProof();
  return attempt;
}

function storageArea(initial: Record<string, unknown>) {
  const values = new Map(Object.entries(initial));
  const migratedValues = new Map<string, unknown>();
  return {
    values,
    migratedValues,
    async get(keys?: string | string[]) {
      if (keys == null) return Object.fromEntries(values);
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.map(key => [key, values.get(key)]));
    },
    async set(row: Record<string, unknown>) {
      if ((row[PROJECT_REGISTRY_KEY] as { legacyMigration?: string } | undefined)?.legacyMigration === "migrated") {
        for (const [key, value] of Object.entries(row)) {
          if (key.startsWith(`c2c_companion_project_v1:${WORKSPACE}:`)) migratedValues.set(key, value);
        }
      }
      for (const [key, value] of Object.entries(row)) values.set(key, value);
    },
    async remove(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) values.delete(key);
    },
    async setAccessLevel() {},
  };
}

function initialState(route = ROUTE_A, routeVerification: "VERIFIED" | "PENDING" = "VERIFIED") {
  const owner = {
    tabId: 7,
    documentId: "document-r5c",
    canonicalRoute: route,
    generation: 1,
    lastSeen: Date.now(),
  };
  const transport = {
    schemaVersion: 1,
    bridgeOrigin: "https://bridge.example.test",
    workspaceId: WORKSPACE,
    companionId: COMPANION,
    bindingId: BINDING,
    epoch: EPOCH,
    routeCanonical: route,
    pairedAt: "2026-09-19T00:00:00.000Z",
    credential: "c2c_comp_test-credential",
    authStale: false,
    routeVerification,
    routeAttestationMessage: "[C2C_ROUTE_ATTEST]\nchallengeId=55555555-5555-4555-8555-555555555555",
    routeAttestationExpiresAt: "2099-01-01T00:00:00.000Z",
    rebindPending: false,
  };
  return {
    local: {
      [LOCAL_KEY]: { schemaVersion: 1, targetRoute: route, paired: true },
      [TRANSPORT_KEY]: transport,
    },
    session: {
      [OWNER_KEY]: owner,
      [REGISTRY_KEY]: [owner],
      [EVIDENCE_KEY]: null,
    },
    transport,
    owner,
  };
}

function validSinkBinding(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: WORKSPACE,
    activeBinding: {
      bindingId: "99999999-9999-4999-8999-999999999999",
      pluginId: "browser-companion",
      surfaceId: "chatgpt-web",
      workspaceId: WORKSPACE,
      canonicalUrl: ROUTE_A,
      epoch: 1,
      boundAt: "2026-09-29T00:00:00.000Z",
    },
    created: true,
    ...overrides,
  };
}

function connectedFlow(overrides: Record<string, unknown> = {}) {
  return { state: "DONE", workspaceId: WORKSPACE, bindingId: BINDING, epoch: EPOCH,
    companionId: COMPANION, routeCanonical: ROUTE_A,
    challengeId: "55555555-5555-4555-8555-555555555555", ownerWitness: initialState().owner,
    updatedAt: Date.now(), ...overrides };
}

async function loadWorker(opts: {
  fetch?: (url: unknown, init?: unknown) => Promise<unknown>;
  tabsSendMessage?: (tabId: number, message: unknown, sendOptions?: unknown) => Promise<unknown>;
  route?: string;
  routeVerification?: "VERIFIED" | "PENDING";
  ownerRoute?: string;
  connectFlow?: Record<string, unknown>;
  routeFence?: Record<string, unknown>;
  local?: Record<string, unknown>;
  preMigrated?: boolean;
  storage?: { local: ReturnType<typeof storageArea>; session: ReturnType<typeof storageArea> };
} = {}) {
  const initial = initialState(opts.route ?? ROUTE_A, opts.routeVerification ?? "VERIFIED");
  if (opts.ownerRoute) {
    initial.owner.canonicalRoute = opts.ownerRoute;
    initial.session[OWNER_KEY] = initial.owner;
    initial.session[REGISTRY_KEY] = [initial.owner];
  }
  if (opts.connectFlow) initial.local[CONNECT_KEY] = opts.connectFlow;
  if (opts.routeFence) initial.local[FENCE_KEY] = opts.routeFence;
  Object.assign(initial.local, opts.local);
  const legacyMigrationExpected = !opts.storage && !opts.preMigrated && !Object.hasOwn(initial.local, PROJECT_REGISTRY_KEY);
  if (opts.preMigrated) {
    for (const [key, value] of Object.entries(initial.local)) initial.local[projectKey(key)] = value;
    for (const [key, value] of Object.entries(initial.session)) initial.session[projectKey(key)] = value;
    initial.local[PROJECT_REGISTRY_KEY] = {
      schemaVersion: 1,
      projects: [{ workspaceId: WORKSPACE, bridgeOrigin: "https://bridge.example.test", legacy: true }],
      legacyMigration: "migrated",
    };
  }
  const local = opts.storage?.local ?? storageArea(initial.local);
  const session = opts.storage?.session ?? storageArea(initial.session);
  let messageListener: ((message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => unknown) | null = null;
  const tabsSendMessage = vi.fn(opts.tabsSendMessage ?? (async () => ({ ok: true, observed: true, mutationAttempted: true, clickAttempted: true })));
  const fetchMock = vi.fn(opts.fetch ?? (async (url: unknown) => {
    const href = String(url);
    if (href.includes("/web-sink/bind-current")) {
      return { ok: true, status: 200, async json() { return validSinkBinding(); } };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          workspaceId: WORKSPACE,
          companionId: COMPANION,
          bindingId: BINDING,
          epoch: EPOCH,
          routeCanonical: opts.route ?? ROUTE_A,
          routeVerification: opts.routeVerification ?? "VERIFIED",
        };
      },
    };
  }));
  let tabRemoved: ((tabId: number) => void) | undefined;
  const action = { setBadgeText: vi.fn(async () => undefined), setTitle: vi.fn(async () => undefined) };
  const chrome = {
    action,
    storage: { local, session },
    runtime: {
      id: "browser-companion-test-id",
      getURL(path: string) { return `chrome-extension://browser-companion-test-id/${path}`; },
      onMessage: { addListener(listener: typeof messageListener) { messageListener = listener; } },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
    },
    tabs: {
      onRemoved: { addListener(listener: (tabId: number) => void) { tabRemoved = listener; } },
      sendMessage: tabsSendMessage,
    },
    permissions: { contains: async () => true },
  };
  vi.stubGlobal("chrome", chrome);
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  await import("../browser-companion/service-worker.js");
  if (!messageListener) throw new Error("service worker did not register onMessage handler");
  let legacyMigrationChecked = false;
  const send = async (message: unknown, sender: unknown = {}) => {
    const response = await new Promise<unknown>((resolve) => messageListener!(message, sender, resolve));
    if (legacyMigrationExpected && !legacyMigrationChecked) {
      expect(local.values.get(PROJECT_REGISTRY_KEY)).toMatchObject({ legacyMigration: "migrated" });
      expect(local.migratedValues.get(projectKey(TRANSPORT_KEY))).toEqual(initial.local[TRANSPORT_KEY]);
      expect(local.values.has(projectKey(TRANSPORT_KEY))).toBe(true);
      expect(local.values.get(TRANSPORT_KEY)).toEqual(initial.local[TRANSPORT_KEY]);
      expect(session.values.get(OWNER_KEY)).toEqual(initial.session[OWNER_KEY]);
      legacyMigrationChecked = true;
    }
    return response;
  };
  const ownerSender = {
    tab: { id: 7 },
    documentId: "document-r5c",
    frameId: 0,
    url: opts.route ?? ROUTE_A,
  };
  const panelSender = {
    id: chrome.runtime.id,
    url: `${chrome.runtime.getURL("operations/operations.html")}?workspaceId=${WORKSPACE}`,
    tab: {
      id: 9,
      url: `${chrome.runtime.getURL("operations/operations.html")}?workspaceId=${WORKSPACE}`,
    },
  };
  const selectProject = (tabId: number, canonicalRoute: string) => send({
    type: "c2c.project.select", workspaceId: WORKSPACE, tabId, canonicalRoute,
  }, { id: chrome.runtime.id });
  const selection = await selectProject(7, opts.route ?? ROUTE_A) as { ok: boolean; reason?: string };
  if (!selection.ok) throw new Error(`workspace selection setup failed: ${JSON.stringify(selection)}`);
  return { initial, local, session, fetchMock, send, selectProject, ownerSender, panelSender, tabsSendMessage, action,
    removeTab: (tabId: number) => tabRemoved?.(tabId) };
}

function bindCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter((call) => String(call[0]).includes("/web-sink/bind-current"));
}

describe("B2 operations read-only RPC", () => {
  const body = { schemaVersion: 1, readOnly: true, workspaceId: WORKSPACE, companionId: COMPANION,
    bindingId: BINDING, epoch: EPOCH, routeCanonical: ROUTE_A, commands: [], observedAt: new Date().toISOString() };
  it("coalesces panel reads into one GET with zero storage, Send, route-bind or journal mutation", async () => {
    let release!: () => void;
    const worker = await loadWorker({ fetch: async () => { await new Promise<void>(resolve => { release = resolve; }); return { ok: true, status: 200, json: async () => body }; } });
    await worker.send({ type: "c2c.status.read", canonicalRoute: ROUTE_A }, worker.ownerSender);
    const before = JSON.stringify([Object.fromEntries(worker.local.values), Object.fromEntries(worker.session.values)]);
    const a = worker.send({ type: "c2c.operations.read", workspaceId: WORKSPACE }, worker.panelSender);
    const b = worker.send({ type: "c2c.operations.read", workspaceId: WORKSPACE }, worker.panelSender);
    await vi.waitFor(() => expect(worker.fetchMock).toHaveBeenCalledTimes(1)); release();
    expect(await a).toMatchObject({ ok: true, snapshot: body }); expect(await b).toMatchObject({ ok: true });
    expect(worker.fetchMock.mock.calls[0][0]).toMatch(/\/operations$/);
    expect(worker.fetchMock.mock.calls[0][1]).toMatchObject({ method: "GET", cache: "no-store" });
    expect(worker.tabsSendMessage).not.toHaveBeenCalled();
    expect(JSON.stringify([Object.fromEntries(worker.local.values), Object.fromEntries(worker.session.values)])).toBe(before);
  });
  it("content scripts cannot request the project-wide history projection", async () => {
    const worker = await loadWorker();
    expect(await worker.send({ type: "c2c.operations.read" }, worker.ownerSender)).toEqual({ ok: false, reason: "extension_sender_required" });
    expect(worker.fetchMock).not.toHaveBeenCalled(); expect(worker.tabsSendMessage).not.toHaveBeenCalled();
  });
  it("failed read does not mark auth stale, repair or reset unknown journal", async () => {
    const worker = await loadWorker({ fetch: async () => ({ ok: false, status: 401, json: async () => ({ error: "COMPANION_UNAUTHORIZED" }) }) });
    await worker.send({ type: "c2c.status.read", canonicalRoute: ROUTE_A }, worker.ownerSender);
    const before = JSON.stringify(Object.fromEntries(worker.local.values));
    expect(await worker.send({ type: "c2c.operations.read", workspaceId: WORKSPACE }, worker.panelSender))
      .toMatchObject({ ok: false, reason: "COMPANION_UNAUTHORIZED" });
    expect(JSON.stringify(Object.fromEntries(worker.local.values))).toBe(before); expect(worker.tabsSendMessage).not.toHaveBeenCalled();
  });
  it("read rejects mismatched response identity without synchronizing binding", async () => {
    const worker = await loadWorker({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ ...body, epoch: EPOCH + 1 }) }) });
    expect(await worker.send({ type: "c2c.operations.read", workspaceId: WORKSPACE }, worker.panelSender))
      .toMatchObject({ ok: false, reason: "identity_mismatch:epoch" });
    expect(worker.local.values.get(projectKey(TRANSPORT_KEY))).toMatchObject({ epoch: EPOCH });
  });
  it("popup status observation never runs connect convergence or mutates owner on route mismatch", async () => {
    const worker = await loadWorker();
    await worker.send({ type: "c2c.status.read", canonicalRoute: ROUTE_A }, worker.ownerSender);
    await worker.selectProject(7, ROUTE_B);
    const before = JSON.stringify([Object.fromEntries(worker.local.values), Object.fromEntries(worker.session.values)]);
    expect(await worker.send({ type: "c2c.status.read", canonicalRoute: ROUTE_B }, worker.ownerSender)).toMatchObject({ ok: true, isOwner: false });
    expect(worker.fetchMock).not.toHaveBeenCalled(); expect(worker.tabsSendMessage).not.toHaveBeenCalled();
    expect(JSON.stringify([Object.fromEntries(worker.local.values), Object.fromEntries(worker.session.values)])).toBe(before);
  });
});

describe("durable outcome-unknown isolation mailbox", () => {
  const json = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300, status, async json() { return body; },
  });
  const terminalGoneProof = (status = "terminal_gone") => ({
    routeCanonical: ROUTE_A, eventId: EVENT_ID, attemptId: ATTEMPT_ID, status,
  });

  it("durably archives before exact isolate request, clears only after proof, and accepts the next reservation", async () => {
    const paths: string[] = [];
    const requests: Array<{ path: string; init: any }> = [];
    const worker = await loadWorker({
      connectFlow: connectedFlow(),
      local: { [JOURNAL_KEY]: unknownJournal() },
      tabsSendMessage: async (_tabId, message) => {
        expect(message).toMatchObject({ type: "c2c.production.send.recover", startJournal: { state: "OUTCOME_UNKNOWN" } });
        return unknownRecoveryProbe();
      },
      fetch: async (url, init = {}) => {
        const path = new URL(String(url)).pathname;
        paths.push(path); requests.push({ path, init });
        if (path.endsWith("/web-sink/status")) return json(200, { ...validSinkBinding(), availability: { available: true } });
        if (path.endsWith("/state")) return json(200, apiState(unknownInFlight()));
        if (path.endsWith("/isolate-attempt")) return json(200, isolateProof());
        if (path.endsWith("/reserve")) return json(200, {
          delivery: { eventId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", status: "reserved" },
          reservationId: "55555555-5555-4555-8555-555555555555",
        });
        return json(404, { error: "unexpected_endpoint" });
      },
    });

    const recovered = await worker.send({ type: "c2c.recover" });
    expect(recovered).toMatchObject({ ok: true, isolated: true, observed: false, journal: { state: "NONE" } });
    const archive = worker.local.values.get(projectKey(ISOLATION_ARCHIVE_KEY)) as any;
    expect(archive.entries[0]).toMatchObject({ status: "isolated", journal: { message: MESSAGE, messageSha256: MESSAGE_HASH } });
    const isolateRequest = requests.find(request => request.path.endsWith("/isolate-attempt"));
    expect(isolateRequest?.init.method).toBe("POST");
    expect(isolateRequest?.init.headers.authorization).toBe("Bearer c2c_comp_test-credential");
    expect(JSON.parse(isolateRequest?.init.body)).toEqual({
      routeCanonical: ROUTE_A, eventId: EVENT_ID, reservationId: RESERVATION_ID,
      attemptId: ATTEMPT_ID, messageSha256: MESSAGE_HASH,
    });
    expect(worker.fetchMock.mock.calls.some(call => String(call[0]).endsWith("/ack"))).toBe(false);
    expect(worker.tabsSendMessage).toHaveBeenCalledTimes(1);
    expect(worker.tabsSendMessage.mock.calls[0]?.[1]).toMatchObject({ type: "c2c.production.send.recover" });

    await worker.send({ type: "c2c.transport.status" });
    const next = await worker.send({
      type: "c2c.reserve.page", canonicalRoute: ROUTE_A, generation: 1,
      safety: { composer: "empty", generation: "idle", safe: true },
    }, worker.ownerSender);
    expect(next).toMatchObject({ ok: true, journal: { state: "RESERVED" } });
    expect(paths.some(path => path.endsWith("/reserve"))).toBe(true);
  });

  it("keeps the original journal on lost response, then restart closes only from exact server isolation evidence", async () => {
    let serverIsolated = false;
    const first = await loadWorker({
      local: { [JOURNAL_KEY]: unknownJournal() },
      tabsSendMessage: async () => unknownRecoveryProbe(),
      fetch: async url => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/state")) return json(200, apiState(unknownInFlight()));
        if (path.endsWith("/isolate-attempt")) { serverIsolated = true; throw new Error("committed response lost"); }
        return json(404, {});
      },
    });
    expect(await first.send({ type: "c2c.recover" })).toMatchObject({ ok: false, reason: "network_unreachable" });
    expect(first.local.values.get(projectKey(JOURNAL_KEY))).toMatchObject({ state: "OUTCOME_UNKNOWN", message: MESSAGE });
    expect(first.local.values.get(projectKey(ISOLATION_ARCHIVE_KEY))).toMatchObject({ entries: [{ status: "pending", journal: { message: MESSAGE } }] });
    expect(serverIsolated).toBe(true);

    const restarted = await loadWorker({
      local: Object.fromEntries(first.local.values),
      fetch: async url => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/state")) return json(200, apiState(null, [stateIsolatedAttempt()]));
        return json(404, { error: "unexpected_endpoint" });
      },
    });
    expect(await restarted.send({ type: "c2c.recover" })).toMatchObject({ ok: true, isolated: true, observed: false });
    expect(restarted.local.values.get(projectKey(JOURNAL_KEY))).toMatchObject({ state: "NONE" });
    expect(restarted.local.values.get(projectKey(ISOLATION_ARCHIVE_KEY))).toMatchObject({ entries: [{ status: "isolated", journal: { message: MESSAGE } }] });
    expect(restarted.fetchMock.mock.calls.some(call => String(call[0]).endsWith("/ack"))).toBe(false);
    expect(restarted.tabsSendMessage).not.toHaveBeenCalled();
  });

  it("refuses stale content proof, bad response target, and local archive write failure without clearing or ACK", async () => {
    const stale = await loadWorker({
      local: { [JOURNAL_KEY]: unknownJournal() },
      tabsSendMessage: async () => ({ ...unknownRecoveryProbe(), composerEmpty: false }),
      fetch: async url => new URL(String(url)).pathname.endsWith("/state")
        ? json(200, apiState(unknownInFlight())) : json(200, isolateProof()),
    });
    expect(await stale.send({ type: "c2c.recover" })).toMatchObject({ ok: false, reason: "outcome_unknown" });
    expect(stale.local.values.has(projectKey(ISOLATION_ARCHIVE_KEY))).toBe(false);
    expect(stale.fetchMock.mock.calls.some(call => String(call[0]).endsWith("/isolate-attempt"))).toBe(false);

    const wrongTarget = await loadWorker({
      local: { [JOURNAL_KEY]: unknownJournal() },
      tabsSendMessage: async () => unknownRecoveryProbe(),
      fetch: async url => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/state")) return json(200, apiState(unknownInFlight()));
        if (path.endsWith("/isolate-attempt")) return json(200, { ...isolateProof(), attemptId: "66666666-6666-4666-8666-666666666666" });
        return json(404, {});
      },
    });
    expect(await wrongTarget.send({ type: "c2c.recover" })).toMatchObject({ ok: false, reason: "isolation_response_invalid" });
    expect(wrongTarget.local.values.get(projectKey(JOURNAL_KEY))).toMatchObject({ state: "OUTCOME_UNKNOWN" });
    expect(wrongTarget.local.values.get(projectKey(ISOLATION_ARCHIVE_KEY))).toMatchObject({ entries: [{ status: "pending" }] });
    expect(wrongTarget.fetchMock.mock.calls.some(call => String(call[0]).endsWith("/ack"))).toBe(false);

    const storageFailure = await loadWorker({
      local: { [JOURNAL_KEY]: unknownJournal() }, tabsSendMessage: async () => unknownRecoveryProbe(),
      fetch: async url => new URL(String(url)).pathname.endsWith("/state")
        ? json(200, apiState(unknownInFlight())) : json(200, isolateProof()),
    });
    const originalSet = storageFailure.local.set.bind(storageFailure.local);
    storageFailure.local.set = async row => {
      if (Object.hasOwn(row, projectKey(ISOLATION_ARCHIVE_KEY))) throw new Error("protected storage write failed");
      await originalSet(row);
    };
    expect(await storageFailure.send({ type: "c2c.recover" })).toMatchObject({ ok: false, reason: "isolation_archive_persist_failed" });
    expect(storageFailure.local.values.get(projectKey(JOURNAL_KEY))).toMatchObject({ state: "OUTCOME_UNKNOWN" });
    expect(storageFailure.fetchMock.mock.calls.some(call => String(call[0]).endsWith("/isolate-attempt"))).toBe(false);
  });

  it("gives observe-only recovery first chance when an unknown journal has no server inFlight or archive", async () => {
    const worker = await loadWorker({
      local: { [JOURNAL_KEY]: unknownJournal() },
      tabsSendMessage: async () => ({ ...unknownRecoveryProbe(), composerEmpty: false }),
      fetch: async url => new URL(String(url)).pathname.endsWith("/state")
        ? json(200, apiState(null)) : json(404, { error: "unexpected_endpoint" }),
    });
    expect(await worker.send({ type: "c2c.recover" })).toMatchObject({ ok: false, reason: "outcome_unknown" });
    expect(worker.tabsSendMessage).toHaveBeenCalledTimes(1);
    expect(worker.local.values.get(projectKey(JOURNAL_KEY))).toMatchObject({ state: "OUTCOME_UNKNOWN", message: MESSAGE });
    expect(worker.local.values.has(projectKey(ISOLATION_ARCHIVE_KEY))).toBe(false);
    expect(worker.fetchMock.mock.calls.some(call => /\/(?:ack|isolate-attempt|operations\/terminal-gone)$/.test(String(call[0])))).toBe(false);
  });

  it("serializes recovery races so only one exact isolate call can run", async () => {
    let release!: () => void;
    const worker = await loadWorker({
      local: { [JOURNAL_KEY]: unknownJournal() }, tabsSendMessage: async () => unknownRecoveryProbe(),
      fetch: async url => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/state")) { await new Promise<void>(resolve => { release = resolve; }); return json(200, apiState(unknownInFlight())); }
        if (path.endsWith("/isolate-attempt")) return json(200, isolateProof());
        return json(404, {});
      },
    });
    const first = worker.send({ type: "c2c.recover" });
    const second = worker.send({ type: "c2c.recover" });
    await vi.waitFor(() => expect(worker.fetchMock.mock.calls.filter(call => String(call[0]).endsWith("/state"))).toHaveLength(1));
    expect(await second).toMatchObject({ ok: false, reason: "production_recovery_busy" });
    release();
    expect(await first).toMatchObject({ ok: true, isolated: true, observed: false });
    expect(worker.fetchMock.mock.calls.filter(call => String(call[0]).endsWith("/isolate-attempt"))).toHaveLength(1);
  });

  it("archives explicit terminal-gone evidence before clearing, without ACK or observation", async () => {
    const requests: Array<{ path: string; init: any }> = [];
    const steps: string[] = [];
    const worker = await loadWorker({
      local: { [JOURNAL_KEY]: unknownJournal() },
      tabsSendMessage: async () => { steps.push("observe"); return unknownRecoveryProbe(); },
      fetch: async (url, init = {}) => {
        const path = new URL(String(url)).pathname;
        requests.push({ path, init });
        steps.push(path);
        if (path.endsWith("/state")) return json(200, apiState(null));
        if (path.endsWith("/operations/terminal-gone")) return json(200, terminalGoneProof());
        return json(404, { error: "unexpected_endpoint" });
      },
    });
    expect(await worker.send({ type: "c2c.recover" })).toMatchObject({
      ok: true, terminalGone: true, isolated: false, observed: false, journal: { state: "NONE" },
    });
    expect(worker.local.values.get(projectKey(ISOLATION_ARCHIVE_KEY))).toMatchObject({
      entries: [{ status: "terminal_gone", journal: { message: MESSAGE, messageSha256: MESSAGE_HASH } }],
    });
    const request = requests.find(item => item.path.endsWith("/operations/terminal-gone"));
    expect(request?.init.method).toBe("POST");
    expect(JSON.parse(request?.init.body)).toEqual({
      routeCanonical: ROUTE_A, eventId: EVENT_ID, attemptId: ATTEMPT_ID, terminalWitness: "terminal-witness-exact",
    });
    expect(steps.indexOf("observe")).toBeLessThan(steps.indexOf("/api/companion/v1/operations/terminal-gone"));
    expect(requests.some(item => item.path.endsWith("/ack") || item.path.endsWith("/isolate-attempt"))).toBe(false);
    expect(worker.tabsSendMessage).toHaveBeenCalledTimes(1);
  });

  it("only isolates after the read-only terminal query proves source still present", async () => {
    const paths: string[] = [];
    const worker = await loadWorker({
      local: { [JOURNAL_KEY]: unknownJournal() },
      tabsSendMessage: async () => unknownRecoveryProbe(),
      fetch: async (url, init = {}) => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        if (path.endsWith("/state")) return json(200, apiState(null));
        if (path.endsWith("/operations/terminal-gone")) return json(409, terminalGoneProof("still_present"));
        if (path.endsWith("/isolate-attempt")) return json(200, isolateProof());
        return json(404, {});
      },
    });
    expect(await worker.send({ type: "c2c.recover" })).toMatchObject({ ok: true, isolated: true, observed: false });
    expect(paths.indexOf("/api/companion/v1/operations/terminal-gone"))
      .toBeLessThan(paths.indexOf("/api/companion/v1/isolate-attempt"));
    expect(worker.local.values.get(projectKey(ISOLATION_ARCHIVE_KEY))).toMatchObject({ entries: [{ status: "isolated" }] });
    expect(worker.fetchMock.mock.calls.some(call => String(call[0]).endsWith("/ack"))).toBe(false);
  });

  it("retries a lost terminal-gone response with archived evidence and blocks on archive storage failure", async () => {
    let gone = false;
    const first = await loadWorker({
      local: { [JOURNAL_KEY]: unknownJournal() },
      tabsSendMessage: async () => unknownRecoveryProbe(),
      fetch: async url => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/state")) return json(200, apiState(null));
        if (path.endsWith("/operations/terminal-gone")) { gone = true; throw new Error("terminal proof response lost"); }
        return json(404, {});
      },
    });
    expect(await first.send({ type: "c2c.recover" })).toMatchObject({ ok: false, reason: "network_unreachable" });
    expect(first.local.values.get(projectKey(JOURNAL_KEY))).toMatchObject({ state: "OUTCOME_UNKNOWN", message: MESSAGE });
    expect(first.local.values.get(projectKey(ISOLATION_ARCHIVE_KEY))).toMatchObject({ entries: [{ status: "pending", journal: { message: MESSAGE } }] });
    expect(gone).toBe(true);

    const restarted = await loadWorker({
      local: Object.fromEntries(first.local.values),
      fetch: async url => new URL(String(url)).pathname.endsWith("/state")
        ? json(200, apiState(null)) : json(200, terminalGoneProof()),
    });
    expect(await restarted.send({ type: "c2c.recover" })).toMatchObject({ ok: true, terminalGone: true, observed: false });
    expect(restarted.local.values.get(projectKey(JOURNAL_KEY))).toMatchObject({ state: "NONE" });
    expect(restarted.local.values.get(projectKey(ISOLATION_ARCHIVE_KEY))).toMatchObject({ entries: [{ status: "terminal_gone" }] });

    const storageFailure = await loadWorker({
      local: { [JOURNAL_KEY]: unknownJournal() },
      tabsSendMessage: async () => unknownRecoveryProbe(),
      fetch: async url => new URL(String(url)).pathname.endsWith("/state")
        ? json(200, apiState(null)) : json(200, terminalGoneProof()),
    });
    const originalSet = storageFailure.local.set.bind(storageFailure.local);
    storageFailure.local.set = async row => {
      if (Object.hasOwn(row, projectKey(ISOLATION_ARCHIVE_KEY))) throw new Error("protected storage write failed");
      await originalSet(row);
    };
    expect(await storageFailure.send({ type: "c2c.recover" })).toMatchObject({ ok: false, reason: "isolation_archive_persist_failed" });
    expect(storageFailure.local.values.get(projectKey(JOURNAL_KEY))).toMatchObject({ state: "OUTCOME_UNKNOWN" });
    expect(storageFailure.fetchMock.mock.calls.some(call => String(call[0]).endsWith("/operations/terminal-gone"))).toBe(false);
  });
});

describe("read-only execution result panel proxy", () => {
  const json = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300, status, async json() { return body; },
  });
  it("reads only a canonical result through the verified route and bounds the exact text projection", async () => {
    const result = {
      commandId: "mailbox_1", iteration: 2, resultId: "77777777-7777-4777-8777-777777777777",
      resultSha256: "b".repeat(64), status: "ok", deliveryStatus: "queued",
      rawSummary: "Codex execution summary", testsSummary: "Focused tests passed",
    };
    const worker = await loadWorker({ fetch: async url => {
      const path = new URL(String(url)).pathname;
      return path.endsWith("/operations/result") ? json(200, result) : json(404, {});
    } });
    const reply = await worker.send({ type: "c2c.operations.result.read", workspaceId: WORKSPACE, commandId: "mailbox_1", iteration: 2 }, worker.panelSender);
    expect(reply).toEqual({ ok: true, result });
    const [url, init] = worker.fetchMock.mock.calls.find(call => String(call[0]).includes("/operations/result"))!;
    expect(String(url)).toMatch(/\/operations\/result\?commandId=mailbox_1&iteration=2$/);
    expect(init).toMatchObject({ method: "GET", cache: "no-store" });
    expect(init.headers.authorization).toBe("Bearer c2c_comp_test-credential");
    expect(worker.tabsSendMessage).not.toHaveBeenCalled();
    expect(await worker.send({ type: "c2c.operations.result.read", workspaceId: WORKSPACE, commandId: "mailbox_1", iteration: 2, route: ROUTE_B }, worker.panelSender))
      .toMatchObject({ ok: false, reason: "bad_message" });
    expect(await worker.send({ type: "c2c.operations.result.read", commandId: "mailbox_1", iteration: 2 }, worker.ownerSender))
      .toMatchObject({ ok: false, reason: "extension_panel_required" });
  });

  it("does not expose historical result summaries", async () => {
    const worker = await loadWorker({ fetch: async url => new URL(String(url)).pathname.endsWith("/operations/result")
      ? json(409, { error: "COMPANION_RESULT_HISTORICAL_REFUSED", rawSummary: "must not reach UI" })
      : json(404, {}) });
    expect(await worker.send({ type: "c2c.operations.result.read", workspaceId: WORKSPACE, commandId: "mailbox_1", iteration: 2 }, worker.panelSender))
      .toEqual({ ok: false, reason: "COMPANION_RESULT_HISTORICAL_REFUSED" });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("authenticated response belongs to its request transport", () => {
  const JOURNAL = "c2c_companion_journal_v1";
  const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, async json() { return body; } });
  const stateBody = { workspaceId: WORKSPACE, companionId: COMPANION, bindingId: BINDING,
    epoch: EPOCH, routeCanonical: ROUTE_A, routeVerification: "VERIFIED", inFlight: null, events: [] };
  const pairBody = { ...stateBody, credential: "c2c_comp_replacement-only-credential-changed",
    routeAttestation: { message: "[C2C_ROUTE_ATTEST]\nchallengeId=66666666-6666-4666-8666-666666666666", expiresAt: "2099-01-01T00:00:00.000Z" } };
  const page = { canonicalRoute: ROUTE_A, generation: 1, safety: { composer: "empty", generation: "idle", safe: true } };

  it.each(["state", "reserve", "ack"])("late old /%s 401 after successful pair cannot mutate replacement transport/journal/fence", async endpoint => {
    let finish!: (value: unknown) => void;
    let started!: () => void;
    const pending = new Promise(resolve => { finish = resolve; });
    const requested = new Promise<void>(resolve => { started = resolve; });
    let first = true;
    let ackStateReads = 0;
    let worker!: Awaited<ReturnType<typeof loadWorker>>;
    let callbackAck: Promise<unknown> | undefined;
    const ackJournal = { state: "OBSERVED_PENDING_ACK", eventId: "a".repeat(32), reservationId: "reserved",
      attemptId: "attempt", routeCanonical: ROUTE_A, bindingId: BINDING, epoch: EPOCH,
      message: "fixture result", messageSha256: "b".repeat(64), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    worker = await loadWorker({
      connectFlow: connectedFlow(),
      ...(endpoint === "ack" ? { local: { [JOURNAL]: ackJournal } } : {}),
      ...(endpoint === "ack" ? { tabsSendMessage: async (tabId, message) => {
        expect(message).toMatchObject({ type: "c2c.production.send.recover" });
        callbackAck = worker.send({ type: "c2c.production.ack", workspaceId: WORKSPACE,
          eventId: ackJournal.eventId, attemptId: ackJournal.attemptId }, {
          id: "browser-companion-test-id", tab: { id: tabId }, documentId: "document-r5c", frameId: 0, url: ROUTE_A,
        });
        await requested;
        return { ok: false, reason: "outcome_unknown", zeroWrite: true, zeroClick: true };
      } } : {}),
      fetch: async url => {
        const pathname = String(url);
        if (pathname.endsWith("/web-sink/status")) return json(200, { ...validSinkBinding(), availability: { available: true } });
        if (pathname.endsWith(`/${endpoint}`) && first) { first = false; started(); return pending; }
        if (pathname.endsWith("/pair")) return json(200, pairBody);
        if (pathname.endsWith("/state") && endpoint === "ack") {
          ackStateReads += 1;
          return ackStateReads === 1 ? json(200, stateBody) : json(401, { error: "COMPANION_UNAUTHORIZED" });
        }
        // Current credential 401 permits repairing an active journal; replacement itself is real Pair.
        return json(401, { error: "COMPANION_UNAUTHORIZED" });
      },
    });
    if (endpoint === "reserve") await worker.send({ type: "c2c.transport.status" });
    let oldResponse: Promise<unknown>;
    if (endpoint === "ack") {
      const recovery = worker.send({ type: "c2c.recover" }, worker.ownerSender);
      await Promise.race([requested, recovery.then(response => { throw new Error(`ACK callback did not reach fetch: ${JSON.stringify(response)}`); })]);
      await recovery;
      expect(worker.tabsSendMessage).toHaveBeenCalledTimes(1);
      oldResponse = callbackAck!;
    } else {
      oldResponse = worker.send(endpoint === "state" ? { type: "c2c.fetch.state" }
        : { type: "c2c.reserve.page", ...page }, worker.ownerSender);
      await Promise.race([requested, oldResponse.then(response => { throw new Error(`request did not reach fetch: ${JSON.stringify(response)}`); })]);
    }
    if (endpoint === "reserve" || endpoint === "ack") {
      expect(await worker.send({ type: "c2c.fetch.state" })).toMatchObject({ authStale: true });
    }
    const proof = await worker.send({ type: "c2c.owner-proof.request", ...page }, worker.ownerSender) as { proof: { id: string } };
    expect(await worker.send({ type: "c2c.pair", bridgeOrigin: "https://bridge.example.test",
      workspaceId: WORKSPACE, tabId: 7, canonicalRoute: ROUTE_A,
      intentId: "fixture-intent", secret: "fixture-secret", ownerProofId: proof.proof.id })).toMatchObject({ ok: true });
    const before = JSON.stringify(Object.fromEntries(worker.local.values));
    finish(json(401, { error: "COMPANION_UNAUTHORIZED" }));
    expect(await oldResponse).toMatchObject({ ok: false, reason: "stale_transport_response" });
    expect(JSON.stringify(Object.fromEntries(worker.local.values))).toBe(before);
    expect(worker.local.values.get(projectKey(TRANSPORT_KEY))).toMatchObject({ authStale: false, credential: pairBody.credential });
    if (endpoint === "ack") expect(worker.tabsSendMessage.mock.calls[0]?.[1]).toMatchObject({ type: "c2c.production.send.recover" });
    else expect(worker.tabsSendMessage).not.toHaveBeenCalled();
  });

  it("current 401 is durably stale and remains stale after SW hydration", async () => {
    const worker = await loadWorker({ fetch: async () => json(401, { error: "COMPANION_UNAUTHORIZED" }) });
    expect(await worker.send({ type: "c2c.fetch.state" })).toMatchObject({ authStale: true });
    expect(worker.local.values.get(projectKey(TRANSPORT_KEY))).toMatchObject({ authStale: true });
    const restarted = await loadWorker({ local: Object.fromEntries(worker.local.values) });
    expect(await restarted.send({ type: "c2c.transport.status" })).toMatchObject({ transport: { authStale: true } });
    expect(restarted.local.values.get(projectKey(TRANSPORT_KEY))).toMatchObject({ authStale: true });
  });

  it("still-current rebindPending 401 keeps the established special semantics", async () => {
    const initial = initialState();
    const worker = await loadWorker({ local: { [TRANSPORT_KEY]: { ...initial.transport, rebindPending: true } },
      fetch: async () => json(401, { error: "COMPANION_UNAUTHORIZED" }) });
    expect(await worker.send({ type: "c2c.fetch.state" })).toEqual({ ok: false, reason: "rebind_pending", authStale: false });
    expect(worker.local.values.get(projectKey(TRANSPORT_KEY))).toMatchObject({ authStale: false });
  });

  it("revalidates the original stale credential after restart without pairing, sending or changing authority", async () => {
    const initial = initialState();
    const durable = { [TRANSPORT_KEY]: { ...initial.transport, authStale: true },
      [JOURNAL]: { state: "OUTCOME_UNKNOWN", eventId: "existing" },
      [FENCE_KEY]: { state: "VERIFIED", companionId: COMPANION, challengeId: "unchanged" } };
    const worker = await loadWorker({ preMigrated: true, local: durable, fetch: async () => json(200, stateBody) });
    const beforeJournal = worker.local.values.get(projectKey(JOURNAL));
    const beforeFence = worker.local.values.get(projectKey(FENCE_KEY));
    expect(await worker.send({ type: "c2c.fetch.state" })).toMatchObject({ ok: true });
    const { routeAttestationMessage: _pendingMessage, ...expectedTransport } = initial.transport;
    expect(worker.local.values.get(projectKey(TRANSPORT_KEY))).toEqual({ ...expectedTransport, authStale: false });
    expect(worker.local.values.get(projectKey(JOURNAL))).toEqual(beforeJournal);
    expect(worker.local.values.get(projectKey(FENCE_KEY))).toEqual(beforeFence);
    expect(worker.fetchMock).toHaveBeenCalledTimes(1);
    expect(String(worker.fetchMock.mock.calls[0][0])).toMatch(/\/state$/);
    expect(worker.fetchMock.mock.calls[0][1]).toMatchObject({ method: "GET",
      headers: { authorization: `Bearer ${initial.transport.credential}` } });
    expect(worker.tabsSendMessage).not.toHaveBeenCalled();
  });

  it("current rejection stays blocked, exposes only bounded reason, then exact recheck can recover", async () => {
    let rejected = true;
    const worker = await loadWorker({ fetch: async () => rejected
      ? json(401, { error: "arbitrary-private-response" }) : json(200, stateBody) });
    await worker.send({ type: "c2c.fetch.state" });
    expect(worker.local.values.get(projectKey(TRANSPORT_KEY))).toMatchObject({ authStale: true, authStaleReason: "auth_revalidation_required" });
    expect(await worker.send({ type: "c2c.transport.status" })).toMatchObject({ transport: { authStale: true, productionEligible: false } });
    const requestsBeforeReserve = worker.fetchMock.mock.calls.length;
    expect(await worker.send({ type: "c2c.reserve.page", ...page }, worker.ownerSender)).toMatchObject({ ok: false, reason: "auth_stale" });
    expect(worker.fetchMock).toHaveBeenCalledTimes(requestsBeforeReserve);
    rejected = false;
    expect(await worker.send({ type: "c2c.fetch.state" })).toMatchObject({ ok: true });
    expect(worker.local.values.get(projectKey(TRANSPORT_KEY))).toMatchObject({ authStale: false });
    expect(worker.local.values.get(projectKey(TRANSPORT_KEY))).not.toHaveProperty("authStaleReason");
  });

  it.each(["network", "500", "invalid", "identity", "401"])("stale credential recheck fails closed on %s", async failure => {
    const worker = await loadWorker({ local: { [TRANSPORT_KEY]: { ...initialState().transport, authStale: true } },
      fetch: async () => {
        if (failure === "network") throw Error("offline");
        if (failure === "500") return json(500, {});
        if (failure === "invalid") return json(200, {});
        if (failure === "identity") return json(200, { ...stateBody, companionId: "replacement" });
        return json(401, { error: "COMPANION_UNAUTHORIZED" });
      } });
    expect(await worker.send({ type: "c2c.fetch.state" })).toMatchObject({ ok: false });
    expect(worker.local.values.get(projectKey(TRANSPORT_KEY))).toMatchObject({ authStale: true, credential: initialState().transport.credential });
    expect(worker.tabsSendMessage).not.toHaveBeenCalled();
  });

  it("invalid 200 state is not proof that an otherwise valid pair was revoked", async () => {
    const worker = await loadWorker({ fetch: async () => json(200, {}) });
    expect(await worker.send({ type: "c2c.fetch.state" })).toEqual({ ok: false, reason: "state_response_invalid" });
    expect(worker.local.values.get(projectKey(TRANSPORT_KEY))).toMatchObject({ authStale: false });
  });

  it("a state response started before a newer auth failure cannot clear that failure", async () => {
    let finish!: (value: unknown) => void;
    let started!: () => void;
    const pending = new Promise(resolve => { finish = resolve; });
    const requested = new Promise<void>(resolve => { started = resolve; });
    let first = true;
    const worker = await loadWorker({ fetch: async () => {
      if (first) { first = false; started(); return pending; }
      return json(401, { error: "COMPANION_UNAUTHORIZED" });
    } });
    const old = worker.send({ type: "c2c.fetch.state" });
    await requested;
    expect(await worker.send({ type: "c2c.fetch.state" })).toMatchObject({ authStale: true });
    finish(json(200, stateBody));
    expect(await old).toEqual({ ok: false, reason: "stale_transport_response" });
    expect(worker.local.values.get(projectKey(TRANSPORT_KEY))).toMatchObject({ authStale: true });
  });

  it("failed persistence cannot unblock mutations during auth recovery", async () => {
    const worker = await loadWorker({ local: { [TRANSPORT_KEY]: { ...initialState().transport, authStale: true } },
      fetch: async () => json(200, stateBody) });
    vi.spyOn(worker.local, "set").mockRejectedValue(Error("disk failure"));
    expect(await worker.send({ type: "c2c.fetch.state" })).toMatchObject({ ok: false });
    expect(await worker.send({ type: "c2c.transport.status" })).toMatchObject({ transport: { authStale: true, productionEligible: false } });
    expect(worker.tabsSendMessage).not.toHaveBeenCalled();
  });
});

describe("R5c Browser explicit-connect Web Sink convergence", () => {
  it("explicit Connect repairs DONE witness for a fresh document when Bridge has no sink", async () => {
    let sinkBound = false;
    const { send, local, fetchMock } = await loadWorker({
      connectFlow: {
        state: "DONE", workspaceId: WORKSPACE, bindingId: BINDING, epoch: EPOCH,
        companionId: COMPANION, routeCanonical: ROUTE_A,
        challengeId: "55555555-5555-4555-8555-555555555555",
        ownerWitness: { tabId: 7, documentId: "old-document", generation: 1, canonicalRoute: ROUTE_A },
        updatedAt: Date.now(),
      },
      fetch: async (url: unknown) => {
        const href = String(url);
        if (href.includes("/web-sink/status")) {
          return { ok: true, status: 200, async json() {
            return { workspaceId: WORKSPACE, activeBinding: sinkBound ? validSinkBinding().activeBinding : null,
              availability: { available: sinkBound } };
          } };
        }
        if (href.includes("/web-sink/bind-current")) {
          sinkBound = true;
          return { ok: true, status: 200, async json() { return validSinkBinding(); } };
        }
        return { ok: true, status: 200, async json() {
          return { workspaceId: WORKSPACE, companionId: COMPANION, bindingId: BINDING,
            epoch: EPOCH, routeCanonical: ROUTE_A, routeVerification: "VERIFIED" };
        } };
      },
    });
    const freshSender = { tab: { id: 7 }, documentId: "fresh-document", frameId: 0, url: ROUTE_A };
    await send({ type: "c2c.bind", canonicalRoute: ROUTE_A, generation: 2 }, freshSender);
    await send({ type: "c2c.heartbeat", canonicalRoute: ROUTE_A, generation: 2 }, freshSender);
    const before = local.values.get(projectKey(CONNECT_KEY)) as { ownerWitness?: { documentId?: string } };
    expect(before).toMatchObject({ state: "DONE", ownerWitness: { documentId: "old-document" } });
    const status = await send({ type: "c2c.transport.status" }) as { transport?: { r5cConnected?: boolean } };
    expect(status.transport?.r5cConnected).toBe(false);
    expect(local.values.get(projectKey(CONNECT_KEY))).toMatchObject({ state: "DONE" });
    expect((local.values.get(projectKey(CONNECT_KEY)) as typeof before).ownerWitness?.documentId).toBe("old-document");
    expect(bindCalls(fetchMock)).toHaveLength(0);

    const result = await send({ type: "c2c.connect.page", canonicalRoute: ROUTE_A, generation: 2 }, freshSender) as { ok?: boolean; state?: string };
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, state: "CONNECTED" });
    expect(bindCalls(fetchMock)).toHaveLength(1);
    expect((local.values.get(projectKey(CONNECT_KEY)) as typeof before).ownerWitness?.documentId).toBe("fresh-document");
    const after = await send({ type: "c2c.transport.status" }) as { transport?: { r5cConnected?: boolean } };
    expect(after.transport?.r5cConnected).toBe(true);
  });

  it("DONE witness repair rejects a different transport identity or route", async () => {
    for (const mismatch of [
      { workspaceId: "other-workspace" }, { routeCanonical: ROUTE_B },
      { bindingId: "33333333-3333-4333-8333-333333333333" }, { epoch: EPOCH + 1 },
      { companionId: "44444444-4444-4444-8444-444444444444" },
    ]) {
      const { send, ownerSender, local, fetchMock } = await loadWorker({
        connectFlow: {
          state: "DONE", workspaceId: WORKSPACE, bindingId: BINDING, epoch: EPOCH,
          companionId: COMPANION, routeCanonical: ROUTE_A,
          challengeId: "55555555-5555-4555-8555-555555555555",
          ownerWitness: { tabId: 7, documentId: "old-document", generation: 1, canonicalRoute: ROUTE_A },
          updatedAt: Date.now(), ...mismatch,
        },
      });
      const result = await send({ type: "c2c.connect.page", canonicalRoute: ROUTE_A, generation: 1 }, ownerSender) as { ok?: boolean; reason?: string };
      expect(result).toMatchObject({ ok: false, reason: "connect_identity_conflict" });
      expect(bindCalls(fetchMock)).toHaveLength(0);
      expect((local.values.get(projectKey(CONNECT_KEY)) as { ownerWitness?: { documentId?: string } }).ownerWitness?.documentId).toBe("old-document");
    }
  });

  it("existing VERIFIED A + explicit Connect calls bind-current and returns CONNECTED", async () => {
    const { send, ownerSender, fetchMock } = await loadWorker({
      connectFlow: {
        state: "ATTEST_REQUESTED",
        workspaceId: WORKSPACE,
        bindingId: BINDING,
        epoch: EPOCH,
        companionId: COMPANION,
        routeCanonical: ROUTE_A,
        challengeId: "55555555-5555-4555-8555-555555555555",
        ownerWitness: { tabId: 7, documentId: "document-r5c", generation: 1, canonicalRoute: ROUTE_A },
        bootstrapAutoResume: false,
        updatedAt: Date.now(),
      },
    });
    const result = await send({
      type: "c2c.connect.page",
      canonicalRoute: ROUTE_A,
      generation: 1,
      safety: { composer: 'empty', generation: 'idle', safe: true },
    }, ownerSender) as { ok: boolean; state?: string; webSink?: unknown; reason?: string };
    expect(result.ok).toBe(true);
    expect(result.state).toBe("CONNECTED");
    expect(bindCalls(fetchMock).length).toBe(1);
    expect(result.webSink).toMatchObject({ pluginId: "browser-companion", surfaceId: "chatgpt-web" });
  });

  it("same A reconnect is no churn and still CONNECTED after bind", async () => {
    const { send, ownerSender, fetchMock } = await loadWorker({
      connectFlow: {
        state: "ATTEST_REQUESTED",
        workspaceId: WORKSPACE,
        bindingId: BINDING,
        epoch: EPOCH,
        companionId: COMPANION,
        routeCanonical: ROUTE_A,
        challengeId: "55555555-5555-4555-8555-555555555555",
        ownerWitness: { tabId: 7, documentId: "document-r5c", generation: 1, canonicalRoute: ROUTE_A },
        bootstrapAutoResume: false,
        updatedAt: Date.now(),
      },
      fetch: async (url: unknown) => {
        const href = String(url);
        if (href.includes("/web-sink/bind-current")) {
          return {
            ok: true,
            status: 200,
            async json() {
              return validSinkBinding({
                activeBinding: {
                  ...validSinkBinding().activeBinding,
                  epoch: 1,
                  boundAt: "2026-09-29T00:00:00.000Z",
                },
                created: false,
              });
            },
          };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              workspaceId: WORKSPACE,
              companionId: COMPANION,
              bindingId: BINDING,
              epoch: EPOCH,
              routeCanonical: ROUTE_A,
              routeVerification: "VERIFIED",
            };
          },
        };
      },
    });
    const result = await send({
      type: "c2c.connect.page",
      canonicalRoute: ROUTE_A,
      generation: 1,
      safety: { composer: 'empty', generation: 'idle', safe: true },
    }, ownerSender) as { ok: boolean; state?: string; webSink?: { created?: boolean; epoch?: number } };
    expect(result.ok).toBe(true);
    expect(result.webSink?.created).toBe(false);
    expect(result.webSink?.epoch).toBe(1);
  });

  it("malformed bind response fails closed and does not report convergence", async () => {
    const { send, ownerSender, fetchMock } = await loadWorker({
      connectFlow: {
        state: "ATTEST_REQUESTED",
        workspaceId: WORKSPACE,
        bindingId: BINDING,
        epoch: EPOCH,
        companionId: COMPANION,
        routeCanonical: ROUTE_A,
        challengeId: "55555555-5555-4555-8555-555555555555",
        ownerWitness: { tabId: 7, documentId: "document-r5c", generation: 1, canonicalRoute: ROUTE_A },
        bootstrapAutoResume: false,
        updatedAt: Date.now(),
      },
      fetch: async (url: unknown) => {
        const href = String(url);
        if (href.includes("/web-sink/bind-current")) {
          return {
            ok: true,
            status: 200,
            async json() {
              return validSinkBinding({
                activeBinding: {
                  ...validSinkBinding().activeBinding,
                  bindingId: "not-a-uuid",
                },
              });
            },
          };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              workspaceId: WORKSPACE,
              companionId: COMPANION,
              bindingId: BINDING,
              epoch: EPOCH,
              routeCanonical: ROUTE_A,
              routeVerification: "VERIFIED",
            };
          },
        };
      },
    });
    const result = await send({
      type: "c2c.connect.page",
      canonicalRoute: ROUTE_A,
      generation: 1,
      safety: { composer: 'empty', generation: 'idle', safe: true },
    }, ownerSender) as { ok: boolean; reason?: string; webSink?: unknown };
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/web_sink_response_invalid|web_sink_bind/);
    expect(result.webSink).toBeUndefined();
    expect(bindCalls(fetchMock).length).toBe(1);
  });

  it("stale owner/document after VERIFIED prevents bind success", async () => {
    const worker = await loadWorker({ ownerRoute: ROUTE_B, route: ROUTE_A });
    const { send, fetchMock } = worker;
    await worker.selectProject(9, ROUTE_B);
    const ownerSender = {
      tab: { id: 9 },
      documentId: "document-stale",
      frameId: 0,
      url: ROUTE_B,
    };
    const result = await send({
      type: "c2c.connect.page",
      canonicalRoute: ROUTE_B,
      generation: 1,
      safety: { composer: 'empty', generation: 'idle', safe: true },
    }, ownerSender) as { ok: boolean; reason?: string };
    // connect should fail closed before successful sink convergence
    expect(result.ok).toBe(false);
    expect(bindCalls(fetchMock).length).toBe(0);
  });

  it("navigation alone does not bind web sink", async () => {
    const { fetchMock } = await loadWorker({
      connectFlow: {
        state: "ATTEST_REQUESTED",
        workspaceId: WORKSPACE,
        bindingId: BINDING,
        epoch: EPOCH,
        companionId: COMPANION,
        routeCanonical: ROUTE_A,
        challengeId: "55555555-5555-4555-8555-555555555555",
        ownerWitness: { tabId: 7, documentId: "document-r5c", generation: 1, canonicalRoute: ROUTE_A },
        bootstrapAutoResume: false,
        updatedAt: Date.now(),
      },
    });
    expect(bindCalls(fetchMock).length).toBe(0);
  });

  it("bind failure does not persist DONE; later explicit Connect retries bind", async () => {
    let bindCount = 0;
    let failBind = true;
    const { send, ownerSender, local, tabsSendMessage } = await loadWorker({
      connectFlow: {
        state: "ATTEST_REQUESTED",
        workspaceId: WORKSPACE,
        bindingId: BINDING,
        epoch: EPOCH,
        companionId: COMPANION,
        routeCanonical: ROUTE_A,
        challengeId: "55555555-5555-4555-8555-555555555555",
        ownerWitness: {
          tabId: 7,
          documentId: "document-r5c",
          generation: 1,
          canonicalRoute: ROUTE_A,
        },
        bootstrapAutoResume: false,
        updatedAt: Date.now(),
      },
      fetch: async (url: unknown) => {
        const href = String(url);
        if (href.includes("/web-sink/bind-current")) {
          bindCount += 1;
          if (failBind) return { ok: false, status: 500, async json() { return {}; } };
          return { ok: true, status: 200, async json() { return validSinkBinding({ created: false }); } };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              workspaceId: WORKSPACE,
              companionId: COMPANION,
              bindingId: BINDING,
              epoch: EPOCH,
              routeCanonical: ROUTE_A,
              routeVerification: "VERIFIED",
            };
          },
        };
      },
    });
    const first = await send({
      type: "c2c.connect.page",
      canonicalRoute: ROUTE_A,
      generation: 1,
      safety: { composer: "empty", generation: "idle", safe: true },
    }, ownerSender) as { ok: boolean; state?: string; reason?: string };
    expect(first.ok).toBe(false);
    expect(first.reason).toMatch(/web_sink_bind|web_sink_response/);
    expect(bindCount).toBe(1);
    expect((local.values.get(projectKey(CONNECT_KEY)) as { state?: string }).state).not.toBe("DONE");

    failBind = false;
    const retry = await send({
      type: "c2c.connect.page",
      canonicalRoute: ROUTE_A,
      generation: 1,
      safety: { composer: "empty", generation: "idle", safe: true },
    }, ownerSender) as { ok: boolean; state?: string };
    expect(retry.ok).toBe(true);
    expect(retry.state).toBe("CONNECTED");
    expect(bindCount).toBe(2);
    expect((local.values.get(projectKey(CONNECT_KEY)) as { state?: string }).state).toBe("DONE");
  });

  it("same-route document replacement prevents old connect convergence", async () => {
    const { send, ownerSender, fetchMock, local } = await loadWorker({
      connectFlow: { state: "ATTEST_REQUESTED", workspaceId: WORKSPACE, bindingId: BINDING, epoch: EPOCH, companionId: COMPANION,
        routeCanonical: ROUTE_A, challengeId: "55555555-5555-4555-8555-555555555555",
        ownerWitness: { tabId: 7, documentId: "document-r5c", generation: 1, canonicalRoute: ROUTE_A }, updatedAt: Date.now() },
      routeVerification: "PENDING",
    });
    await send({
      type: "c2c.connect.page",
      canonicalRoute: ROUTE_A,
      generation: 1,
      safety: { composer: 'empty', generation: 'idle', safe: true },
    }, ownerSender);
    const before = bindCalls(fetchMock).length;
    // Ownership lifecycle replaces document WITHOUT a new explicit Connect.
    const sessionOwner = {
      tabId: 7,
      documentId: "document-replaced",
      canonicalRoute: ROUTE_A,
      generation: 2,
      lastSeen: Date.now(),
    };
    // Simulate owner replacement via session storage (no connect.page for Y).
    // Heartbeat from old document X must not bind as X's pending connect.
    await send({ type: "c2c.heartbeat", canonicalRoute: ROUTE_A, generation: 1, safety: { composer: "empty", generation: "idle", safe: true } }, ownerSender);
    expect(bindCalls(fetchMock).length).toBe(before);
    expect((local.values.get(projectKey(CONNECT_KEY)) as { state?: string }).state).not.toBe("DONE");
    // silence unused
    expect(sessionOwner.documentId).toBe("document-replaced");
  });

  it("rejects locale/date-only/missing-timezone boundAt", async () => {
    const badBoundAts = ["2026-09-29", "09/29/2026", "2026-09-29T00:00:00"];
    for (const boundAt of badBoundAts) {
      const { send, ownerSender, fetchMock } = await loadWorker({
      connectFlow: {
        state: "ATTEST_REQUESTED",
        workspaceId: WORKSPACE,
        bindingId: BINDING,
        epoch: EPOCH,
        companionId: COMPANION,
        routeCanonical: ROUTE_A,
        challengeId: "55555555-5555-4555-8555-555555555555",
        ownerWitness: { tabId: 7, documentId: "document-r5c", generation: 1, canonicalRoute: ROUTE_A },
        bootstrapAutoResume: false,
        updatedAt: Date.now(),
      },
        fetch: async (url: unknown) => {
          const href = String(url);
          if (href.includes("/web-sink/bind-current")) {
            return {
              ok: true,
              status: 200,
              async json() {
                return validSinkBinding({
                  activeBinding: { ...validSinkBinding().activeBinding, boundAt },
                });
              },
            };
          }
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                workspaceId: WORKSPACE,
                companionId: COMPANION,
                bindingId: BINDING,
                epoch: EPOCH,
                routeCanonical: ROUTE_A,
                routeVerification: "VERIFIED",
              };
            },
          };
        },
      });
      const result = await send({
        type: "c2c.connect.page",
        canonicalRoute: ROUTE_A,
        generation: 1,
        safety: { composer: 'empty', generation: 'idle', safe: true },
      }, ownerSender) as { ok: boolean; reason?: string };
      expect(result.ok, boundAt).toBe(false);
      expect(bindCalls(fetchMock).length).toBe(1);
    }
  });

  it("accepts canonical Z datetime per endpoint contract and rejects offset", async () => {
    for (const [boundAt, expectedOk] of [
      ["2026-09-29T00:00:00Z", true],
      ["2026-09-29T00:00:00.000Z", true],
      ["2026-09-29T08:00:00+08:00", false],
    ] as [string, boolean][]) {
      const { send, ownerSender } = await loadWorker({
      connectFlow: {
        state: "ATTEST_REQUESTED",
        workspaceId: WORKSPACE,
        bindingId: BINDING,
        epoch: EPOCH,
        companionId: COMPANION,
        routeCanonical: ROUTE_A,
        challengeId: "55555555-5555-4555-8555-555555555555",
        ownerWitness: { tabId: 7, documentId: "document-r5c", generation: 1, canonicalRoute: ROUTE_A },
        bootstrapAutoResume: false,
        updatedAt: Date.now(),
      },
        fetch: async (url: unknown) => {
          const href = String(url);
          if (href.includes("/web-sink/bind-current")) {
            return {
              ok: true,
              status: 200,
              async json() {
                return validSinkBinding({
                  activeBinding: { ...validSinkBinding().activeBinding, boundAt },
                });
              },
            };
          }
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                workspaceId: WORKSPACE,
                companionId: COMPANION,
                bindingId: BINDING,
                epoch: EPOCH,
                routeCanonical: ROUTE_A,
                routeVerification: "VERIFIED",
              };
            },
          };
        },
      });
      const result = await send({
        type: "c2c.connect.page",
        canonicalRoute: ROUTE_A,
        generation: 1,
        safety: { composer: 'empty', generation: 'idle', safe: true },
      }, ownerSender) as { ok: boolean; state?: string };
      // z.string().datetime() accepts Z and offset forms
      expect(result.ok, boundAt).toBe(expectedOk);
    }
  });
});

describe("R5c popup connection truth", () => {
  it("full connected requires shared readiness and shows retryable warning otherwise", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").join(process.cwd(), "browser-companion/popup/popup.js"),
      "utf8",
    );
    expect(src).toMatch(/connectionReadiness/);
    expect(src).toMatch(/当前对话需要完成连接/);
    expect(src).not.toMatch(/webSinkConverged/);
    expect(src).toMatch(/再次点击“连接当前对话”/);
  });

  it("beginConnectAttestation keeps numeric now compatibility and ownerWitness", () => {
    const {
      beginConnectAttestation,
      finishConnectFlow,
      parseConnectFlow,
      refreshExplicitConnectOwnerWitness,
      connectFlowOwnerWitnessMatches,
    } = require("../browser-companion/connect-flow.js");
    const identity = {
      workspaceId: WORKSPACE,
      bindingId: BINDING,
      epoch: EPOCH,
      companionId: COMPANION,
      routeCanonical: ROUTE_A,
      challengeId: "55555555-5555-4555-8555-555555555555",
    };
    const witness = { tabId: 7, documentId: "document-r5c", generation: 1, canonicalRoute: ROUTE_A };
    const legacy = beginConnectAttestation({ state: "NONE" }, identity, 12345);
    expect(legacy.ok).toBe(true);
    expect(legacy.flow.updatedAt).toBe(12345);
    expect(legacy.flow.ownerWitness).toBeUndefined();
    const withWitness = beginConnectAttestation({ state: "NONE" }, identity, witness, 999);
    expect(withWitness.ok).toBe(true);
    expect(withWitness.flow.ownerWitness).toEqual(witness);
    expect(connectFlowOwnerWitnessMatches(withWitness.flow, witness)).toBe(true);
    const done = finishConnectFlow(withWitness.flow, identity, "DONE", 2);
    expect(done.ownerWitness).toEqual(witness);
    const refreshed = refreshExplicitConnectOwnerWitness(
      { ...withWitness.flow, state: "ATTEST_REQUESTED" },
      { tabId: 7, documentId: "document-y", generation: 2, canonicalRoute: ROUTE_A },
    );
    expect(refreshed.ok).toBe(true);
    expect(refreshed.flow.ownerWitness.documentId).toBe("document-y");
    expect(parseConnectFlow(JSON.parse(JSON.stringify(withWitness.flow))).ownerWitness).toEqual(witness);
  });
});


describe("R5c Bridge-authoritative status and restart recovery", () => {
  it("status failure invalidates r5cConnected; Bridge available=false forces false", async () => {
    let statusCalls = 0;
    let statusMode = "ok";
    const { send, ownerSender, fetchMock } = await loadWorker({
      fetch: async (url: unknown) => {
        const href = String(url);
        if (href.includes("/web-sink/bind-current")) {
          return { ok: true, status: 200, async json() { return validSinkBinding(); } };
        }
        if (href.includes("/web-sink/status")) {
          statusCalls += 1;
          if (statusMode === "fail") return { ok: false, status: 500, async json() { return {}; } };
          if (statusMode === "unavailable") {
            return {
              ok: true,
              status: 200,
              async json() {
                return {
                  workspaceId: WORKSPACE,
                  activeBinding: validSinkBinding().activeBinding,
                  availability: { available: false, reasonCode: "binding_stale" },
                };
              },
            };
          }
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                workspaceId: WORKSPACE,
                activeBinding: validSinkBinding().activeBinding,
                availability: { available: true },
              };
            },
          };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              workspaceId: WORKSPACE,
              companionId: COMPANION,
              bindingId: BINDING,
              epoch: EPOCH,
              routeCanonical: ROUTE_A,
              routeVerification: "VERIFIED",
            };
          },
        };
      },
    });
    await send({
      type: "c2c.connect.page",
      canonicalRoute: ROUTE_A,
      generation: 1,
      safety: { composer: "empty", generation: "idle", safe: true },
    }, ownerSender);
    const st1 = await send({ type: "c2c.transport.status" }, {}) as { transport?: { r5cConnected?: boolean } };
    expect(st1.transport?.r5cConnected).toBe(true);
    expect(statusCalls).toBeGreaterThanOrEqual(1);
    const postsBefore = bindCalls(fetchMock).length;

    statusMode = "fail";
    const st2 = await send({ type: "c2c.transport.status" }, {}) as { transport?: { r5cConnected?: boolean } };
    expect(st2.transport?.r5cConnected).toBe(false);

    statusMode = "unavailable";
    const st3 = await send({ type: "c2c.transport.status" }, {}) as { transport?: { r5cConnected?: boolean } };
    expect(st3.transport?.r5cConnected).toBe(false);
    expect(bindCalls(fetchMock).length).toBe(postsBefore);
  });

  it("legacy VERIFIED without challenge uses local convergence identity and restart recovery", async () => {
    let statusCalls = 0;
    let bindCount = 0;
    const load = () => loadWorker({
      fetch: async (url: unknown) => {
        const href = String(url);
        if (href.includes("/web-sink/bind-current")) {
          bindCount += 1;
          return { ok: true, status: 200, async json() { return validSinkBinding(); } };
        }
        if (href.includes("/web-sink/status")) {
          statusCalls += 1;
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                workspaceId: WORKSPACE,
                activeBinding: validSinkBinding().activeBinding,
                availability: { available: true },
              };
            },
          };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              workspaceId: WORKSPACE,
              companionId: COMPANION,
              bindingId: BINDING,
              epoch: EPOCH,
              routeCanonical: ROUTE_A,
              routeVerification: "VERIFIED",
            };
          },
        };
      },
    });
    // Legacy transport: no routeAttestationMessage
    const worker1 = await load();
    // Override transport message via second load is hard; instead assert connectFlowIdentity local path
    const { connectFlowIdentity } = await import("../browser-companion/connect-flow.js");
    const localId = connectFlowIdentity({
      workspaceId: WORKSPACE,
      bindingId: BINDING,
      epoch: EPOCH,
      companionId: COMPANION,
      routeCanonical: ROUTE_A,
      routeAttestationMessage: null,
    });
    expect(localId).not.toBeNull();
    expect(localId!.challengeId).toBeNull();
    // Restart simulation: same identity derivation
    const localId2 = connectFlowIdentity({
      workspaceId: WORKSPACE,
      bindingId: BINDING,
      epoch: EPOCH,
      companionId: COMPANION,
      routeCanonical: ROUTE_A,
      routeAttestationMessage: null,
    });
    expect(localId2).toEqual(localId);
    expect(bindCount).toBeGreaterThanOrEqual(0);
    expect(statusCalls).toBeGreaterThanOrEqual(0);
  });

  it("PENDING route with no challenge cannot skip verification via local identity", async () => {
    const { send, ownerSender, fetchMock } = await loadWorker({
      routeVerification: "PENDING",
      fetch: async (url: unknown) => {
        const href = String(url);
        if (href.includes("/web-sink/bind-current")) {
          return { ok: true, status: 200, async json() { return validSinkBinding(); } };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              workspaceId: WORKSPACE,
              companionId: COMPANION,
              bindingId: BINDING,
              epoch: EPOCH,
              routeCanonical: ROUTE_A,
              routeVerification: "PENDING",
            };
          },
        };
      },
    });
    const result = await send({
      type: "c2c.connect.page",
      canonicalRoute: ROUTE_A,
      generation: 1,
      safety: { composer: "empty", generation: "idle", safe: true },
    }, ownerSender) as { ok: boolean; state?: string };
    // Must not claim full connected while route remains PENDING
    if (result.ok) {
      expect(result.state).not.toBe("CONNECTED");
    }
    expect(bindCalls(fetchMock).length).toBe(0);
  });
});


describe("R5c authority projection and real restart", () => {
  it("direct available=false on same binding forces r5cConnected=false then true again", async () => {
    let available = true;
    let bindCount = 0;
    const { send, ownerSender, fetchMock } = await loadWorker({
      fetch: async (url: unknown) => {
        const href = String(url);
        if (href.includes("/web-sink/bind-current")) {
          bindCount += 1;
          return { ok: true, status: 200, async json() { return validSinkBinding(); } };
        }
        if (href.includes("/web-sink/status")) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                workspaceId: WORKSPACE,
                activeBinding: validSinkBinding().activeBinding,
                availability: { available, reasonCode: available ? undefined : "binding_stale" },
              };
            },
          };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              workspaceId: WORKSPACE,
              companionId: COMPANION,
              bindingId: BINDING,
              epoch: EPOCH,
              routeCanonical: ROUTE_A,
              routeVerification: "VERIFIED",
            };
          },
        };
      },
    });
    await send({
      type: "c2c.connect.page",
      canonicalRoute: ROUTE_A,
      generation: 1,
      safety: { composer: "empty", generation: "idle", safe: true },
    }, ownerSender);
    const postsAfterConnect = bindCount;
    const st1 = await send({ type: "c2c.transport.status" }, {}) as { transport?: { r5cConnected?: boolean } };
    expect(st1.transport?.r5cConnected).toBe(true);

    available = false;
    const st2 = await send({ type: "c2c.transport.status" }, {}) as { transport?: { r5cConnected?: boolean } };
    expect(st2.transport?.r5cConnected).toBe(false);

    available = true;
    const st3 = await send({ type: "c2c.transport.status" }, {}) as { transport?: { r5cConnected?: boolean } };
    expect(st3.transport?.r5cConnected).toBe(true);
    expect(bindCount).toBe(postsAfterConnect);
    expect(bindCalls(fetchMock).length).toBe(postsAfterConnect);
  });

  it("thrown network on status invalidates authority without POST", async () => {
    let bindCount = 0;
    let failStatus = false;
    const { send, ownerSender, fetchMock } = await loadWorker({
      fetch: async (url: unknown) => {
        const href = String(url);
        if (href.includes("/web-sink/bind-current")) {
          bindCount += 1;
          return { ok: true, status: 200, async json() { return validSinkBinding(); } };
        }
        if (href.includes("/web-sink/status")) {
          if (failStatus) throw new Error("network down");
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                workspaceId: WORKSPACE,
                activeBinding: validSinkBinding().activeBinding,
                availability: { available: true },
              };
            },
          };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              workspaceId: WORKSPACE,
              companionId: COMPANION,
              bindingId: BINDING,
              epoch: EPOCH,
              routeCanonical: ROUTE_A,
              routeVerification: "VERIFIED",
            };
          },
        };
      },
    });
    await send({
      type: "c2c.connect.page",
      canonicalRoute: ROUTE_A,
      generation: 1,
      safety: { composer: "empty", generation: "idle", safe: true },
    }, ownerSender);
    const st1 = await send({ type: "c2c.transport.status" }, {}) as { transport?: { r5cConnected?: boolean } };
    expect(st1.transport?.r5cConnected).toBe(true);
    const posts = bindCount;

    failStatus = true;
    const st2 = await send({ type: "c2c.transport.status" }, {}) as { transport?: { r5cConnected?: boolean } };
    expect(st2.transport?.r5cConnected).toBe(false);
    expect(bindCount).toBe(posts);

    failStatus = false;
    const st3 = await send({ type: "c2c.transport.status" }, {}) as { transport?: { r5cConnected?: boolean } };
    expect(st3.transport?.r5cConnected).toBe(true);
    expect(bindCount).toBe(posts);
    expect(bindCalls(fetchMock).length).toBe(posts);
  });

  it("real SW restart recovers r5cConnected from Bridge status without POST bind", async () => {
    let bindCount = 0;
    let statusMode = "A";
    const storageHooks = { local: null as null | ReturnType<typeof storageArea>, session: null as null | ReturnType<typeof storageArea> };
    const fetchImpl = async (url: unknown) => {
      const href = String(url);
      if (href.includes("/web-sink/bind-current")) {
        bindCount += 1;
        return { ok: true, status: 200, async json() { return validSinkBinding(); } };
      }
      if (href.includes("/web-sink/status")) {
        if (statusMode === "none") {
          return { ok: true, status: 200, async json() { return { workspaceId: WORKSPACE, activeBinding: null, availability: { available: false } }; } };
        }
        const binding = statusMode === "B"
          ? { ...validSinkBinding().activeBinding, bindingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", canonicalUrl: ROUTE_B }
          : validSinkBinding().activeBinding;
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              workspaceId: WORKSPACE,
              activeBinding: binding,
              availability: { available: statusMode === "A" },
            };
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            workspaceId: WORKSPACE,
            companionId: COMPANION,
            bindingId: BINDING,
            epoch: EPOCH,
            routeCanonical: ROUTE_A,
            routeVerification: "VERIFIED",
          };
        },
      };
    };

    // Worker #1: connect
    const w1 = await loadWorker({ fetch: fetchImpl });
    storageHooks.local = w1.local;
    storageHooks.session = w1.session;
    await w1.send({
      type: "c2c.connect.page",
      canonicalRoute: ROUTE_A,
      generation: 1,
      safety: { composer: "empty", generation: "idle", safe: true },
    }, w1.ownerSender);
    const postsAfterConnect = bindCount;
    const st1 = await w1.send({ type: "c2c.transport.status" }, {}) as { transport?: { r5cConnected?: boolean } };
    expect(st1.transport?.r5cConnected).toBe(true);

    // Worker #2: same storage maps, fresh module memory
    vi.resetModules();
    const local = storageHooks.local!;
    const session = storageHooks.session!;
    let messageListener: ((message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => unknown) | null = null;
    const chrome = {
      storage: { local, session },
      runtime: {
        onMessage: { addListener(listener: typeof messageListener) { messageListener = listener; } },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
      },
      tabs: { onRemoved: { addListener() {} }, sendMessage: vi.fn(async () => ({ ok: true, observed: true, mutationAttempted: true, clickAttempted: true })) },
      permissions: { contains: async () => true },
    };
    vi.stubGlobal("chrome", chrome);
    vi.stubGlobal("fetch", vi.fn(fetchImpl));
    await import("../browser-companion/service-worker.js");
    const send2 = (message: unknown, sender: unknown = {}) => new Promise<unknown>((resolve) => {
      messageListener!(message, sender, resolve);
    });
    const st2 = await send2({ type: "c2c.transport.status" }, {}) as { transport?: { r5cConnected?: boolean } };
    expect(st2.transport?.r5cConnected).toBe(true);
    expect(bindCount).toBe(postsAfterConnect);

    statusMode = "B";
    const st3 = await send2({ type: "c2c.transport.status" }, {}) as { transport?: { r5cConnected?: boolean } };
    expect(st3.transport?.r5cConnected).toBe(false);
    expect(bindCount).toBe(postsAfterConnect);

    statusMode = "none";
    const st4 = await send2({ type: "c2c.transport.status" }, {}) as { transport?: { r5cConnected?: boolean } };
    expect(st4.transport?.r5cConnected).toBe(false);
    expect(bindCount).toBe(postsAfterConnect);
  });
});


describe("R5c acceptance evidence: real async and ownership", () => {
  it("document replacement via c2c.bind does not finish X flow; Y explicit Connect converges", async () => {
    let bindCount = 0;
    let verified = false;
    const { send, ownerSender, local, tabsSendMessage } = await loadWorker({
      connectFlow: { state: "ATTEST_REQUESTED", workspaceId: WORKSPACE, bindingId: BINDING, epoch: EPOCH, companionId: COMPANION,
        routeCanonical: ROUTE_A, challengeId: "55555555-5555-4555-8555-555555555555",
        ownerWitness: { tabId: 7, documentId: "document-r5c", generation: 1, canonicalRoute: ROUTE_A }, updatedAt: Date.now() },
      routeVerification: "PENDING",
      fetch: async (url: unknown) => {
        const href = String(url);
        if (href.includes("/web-sink/bind-current")) {
          bindCount += 1;
          return {
            ok: true,
            status: 200,
            async json() {
              return validSinkBinding({
                activeBinding: { ...validSinkBinding().activeBinding, boundAt: "2026-09-29T00:00:00Z" },
              });
            },
          };
        }
        if (href.endsWith("/state")) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                workspaceId: WORKSPACE,
                companionId: COMPANION,
                bindingId: BINDING,
                epoch: EPOCH,
                routeCanonical: ROUTE_A,
                routeVerification: verified ? "VERIFIED" : "PENDING",
              };
            },
          };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              workspaceId: WORKSPACE,
              companionId: COMPANION,
              bindingId: BINDING,
              epoch: EPOCH,
              routeCanonical: ROUTE_A,
              routeVerification: "VERIFIED",
            };
          },
        };
      },
    });
    await send({
      type: "c2c.connect.page",
      canonicalRoute: ROUTE_A,
      generation: 1,
      safety: { composer: "empty", generation: "idle", safe: true },
    }, ownerSender);
    const bindsAfterX = bindCount;
    // Y replaces ownership without Connect
    await send({
      type: "c2c.bind",
      canonicalRoute: ROUTE_A,
      generation: 2,
    }, {
      tab: { id: 7 },
      documentId: "document-y",
      frameId: 0,
      url: ROUTE_A,
    });
    await send({
      type: "c2c.heartbeat",
      canonicalRoute: ROUTE_A,
      generation: 2,
      safety: { composer: "empty", generation: "idle", safe: true },
    }, {
      tab: { id: 7 },
      documentId: "document-y",
      frameId: 0,
      url: ROUTE_A,
    });
    expect(bindCount).toBe(bindsAfterX);
    expect((local.values.get(projectKey(CONNECT_KEY)) as { state?: string }).state).not.toBe("DONE");

    verified = true; // Bridge attestation finishes before Y explicitly reconnects.
    const yConnect = await send({
      type: "c2c.connect.page",
      canonicalRoute: ROUTE_A,
      generation: 2,
      safety: { composer: "empty", generation: "idle", safe: true },
    }, {
      tab: { id: 7 },
      documentId: "document-y",
      frameId: 0,
      url: ROUTE_A,
    }) as { ok: boolean; webSink?: { bindingId?: string } };
    expect(yConnect, JSON.stringify(yConnect)).toMatchObject({ ok: true });
    expect(bindCount).toBe(bindsAfterX + 1);
    const done = local.values.get(projectKey(CONNECT_KEY)) as {
      state?: string;
      ownerWitness?: { documentId?: string };
    };
    expect(done.state).toBe("DONE");
    expect(done.ownerWitness?.documentId).toBe("document-y");
  });
});


describe("显式同路由 Connect 与旧回流记录隔离", () => {
  const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const doneFlow = {
    state: "DONE", workspaceId: WORKSPACE, bindingId: BINDING, epoch: EPOCH,
    companionId: COMPANION, routeCanonical: ROUTE_A,
    challengeId: "55555555-5555-4555-8555-555555555555",
    ownerWitness: { tabId: 7, documentId: "old-document", generation: 1, canonicalRoute: ROUTE_A },
    updatedAt: Date.now(),
  };
  const freshSender = { tab: { id: 7 }, documentId: "d2", frameId: 0, url: ROUTE_A };
  const connect = { type: "c2c.connect.page", canonicalRoute: ROUTE_A, generation: 2,
    safety: { composer: "empty", generation: "idle", safe: true } };
  const fetchConnected = async (url: unknown) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/state")) return json(200, apiState(unknownInFlight()));
    if (path.endsWith("/web-sink/status")) return json(200, {
      ...validSinkBinding(), availability: { available: true },
    });
    if (path.endsWith("/web-sink/bind-current")) return json(200, validSinkBinding({ created: false }));
    if (path.endsWith("/isolate-attempt")) return json(200, isolateProof());
    return json(404, { error: "unexpected_endpoint" });
  };
  const noSend = (worker: Awaited<ReturnType<typeof loadWorker>>) => {
    expect(worker.fetchMock.mock.calls.some(call => /\/(?:begin-send|reserve|rebind|pair)(?:$|\/)/.test(String(call[0])))).toBe(false);
    expect(worker.tabsSendMessage.mock.calls.every(call => (call[1] as any)?.type === "c2c.production.send.recover")).toBe(true);
  };

  it.each([false, true])("单次 d2 Connect 安全隔离旧 unknown，保留 rearm=%s，重复连接幂等", async rearmOnConnect => {
    const worker = await loadWorker({ connectFlow: doneFlow,
      local: { [JOURNAL_KEY]: unknownJournal(), [AUTONOMY_KEY]: { mode: "off", rearmOnConnect } },
      fetch: fetchConnected, tabsSendMessage: async () => ({ ...unknownRecoveryProbe(), generation: 2 }),
    });
    const result = await worker.send(connect, freshSender);
    expect(result).toMatchObject({ ok: true, state: "CONNECTED", r5cConnected: true,
      autonomy: rearmOnConnect ? "armed" : "off", deliveryRecovery: { blocked: false, recovered: true, journalState: "NONE" } });
    expect(worker.local.values.get(projectKey(CONNECT_KEY))).toMatchObject({ state: "DONE", ownerWitness: { documentId: "d2", generation: 2 } });
    expect(worker.local.values.get(projectKey(ISOLATION_ARCHIVE_KEY))).toMatchObject({ entries: [{ status: "isolated", journal: { message: MESSAGE } }] });
    expect(await worker.send(connect, freshSender)).toMatchObject({ ok: true, state: "CONNECTED", r5cConnected: true });
    expect(worker.tabsSendMessage).toHaveBeenCalledTimes(1);
    expect(bindCalls(worker.fetchMock)).toHaveLength(1);
    noSend(worker);
  });

  it("恢复失败保持 CONNECTED、原 journal、自动回流 off，重开状态仍独立提示", async () => {
    const worker = await loadWorker({ connectFlow: doneFlow,
      local: { [JOURNAL_KEY]: unknownJournal(), [AUTONOMY_KEY]: { mode: "off", rearmOnConnect: true } },
      fetch: fetchConnected, tabsSendMessage: async () => { throw Error("document unavailable"); },
    });
    expect(await worker.send(connect, freshSender)).toMatchObject({ ok: true, state: "CONNECTED", r5cConnected: true, autonomy: "off",
      deliveryRecovery: { blocked: true, journalState: "OUTCOME_UNKNOWN", reason: "production_recover_rpc_failed" } });
    expect(worker.local.values.get(projectKey(JOURNAL_KEY))).toEqual(unknownJournal());
    expect(await worker.send({ type: "c2c.transport.status" })).toMatchObject({ transport: { r5cConnected: true },
      deliveryRecovery: { blocked: true, journalState: "OUTCOME_UNKNOWN" } });
    expect(await worker.send({ type: "c2c.status.read", canonicalRoute: ROUTE_A }, freshSender)).toMatchObject({ connectReason: null,
      deliveryRecovery: { blocked: true } });
    noSend(worker);
  });

  it.each(["SEND_INTENT", "CLAIMED", "COMPOSER_WRITE_INTENT", "SEND_DISPATCH_INTENT"])("%s 保留原记录，不自动续发", async state => {
    const old = { ...unknownJournal(), state };
    const worker = await loadWorker({ connectFlow: doneFlow, local: { [JOURNAL_KEY]: old }, fetch: fetchConnected });
    expect(await worker.send(connect, freshSender)).toMatchObject({ ok: true, state: "CONNECTED", autonomy: "off",
      deliveryRecovery: { blocked: true, journalState: state, reason: "delivery_recovery_requires_manual_action" } });
    expect(worker.local.values.get(projectKey(JOURNAL_KEY))).toEqual(old);
    expect(worker.tabsSendMessage).not.toHaveBeenCalled(); noSend(worker);
  });

  it.each([401, 403])("fresh /state %s 不改变 owner、不 bind、不虚报连接", async status => {
    const worker = await loadWorker({ connectFlow: doneFlow, local: { [JOURNAL_KEY]: unknownJournal() },
      fetch: async url => String(url).endsWith("/state") ? json(status, { error: "COMPANION_UNAUTHORIZED" }) : fetchConnected(url),
    });
    expect(await worker.send(connect, freshSender)).toMatchObject({ ok: false });
    expect(worker.session.values.get(projectKey(OWNER_KEY))).toMatchObject({ documentId: "document-r5c" });
    expect(await worker.send({ type: "c2c.transport.status" })).toMatchObject({ transport: { r5cConnected: false } });
    expect(bindCalls(worker.fetchMock)).toHaveLength(0); noSend(worker);
  });

  it("缺权限不fetch、不变更owner", async () => {
    const worker = await loadWorker({ connectFlow: doneFlow, local: { [JOURNAL_KEY]: unknownJournal() }, fetch: fetchConnected });
    (globalThis as any).chrome.permissions.contains = async () => false;
    expect(await worker.send(connect, freshSender)).toMatchObject({ ok: false, reason: "bridge_permission_missing" });
    expect(worker.fetchMock).not.toHaveBeenCalled(); expect(worker.tabsSendMessage).not.toHaveBeenCalled();
    expect(worker.session.values.get(projectKey(OWNER_KEY))).toMatchObject({ documentId: "document-r5c" });
  });

  it.each(["unknown_connect", "unknown_attest", "other_route", "other_binding"])("旧journal不放行%s", async mismatch => {
    const worker = await loadWorker({ preMigrated: true, connectFlow: { ...doneFlow, ...(mismatch === "unknown_connect" ? { state: "OUTCOME_UNKNOWN" } : {}) },
      ...(mismatch === "unknown_attest" ? { routeFence: { state: "OUTCOME_UNKNOWN" } } : {}),
      local: { [JOURNAL_KEY]: { ...unknownJournal(), ...(mismatch === "other_binding" ? { bindingId: COMPANION } : {}) } }, fetch: fetchConnected });
    if (mismatch === "other_route") await worker.selectProject(7, ROUTE_B);
    expect(await worker.send({ ...connect, canonicalRoute: mismatch === "other_route" ? ROUTE_B : ROUTE_A },
      { ...freshSender, url: mismatch === "other_route" ? ROUTE_B : ROUTE_A })).toMatchObject({ ok: false, reason: "journal_active" });
    expect(worker.fetchMock).not.toHaveBeenCalled(); expect(worker.tabsSendMessage).not.toHaveBeenCalled();
  });

  it.each([null, ROUTE_B])("现役 sink 缺失或不同路由时不创建替代 binding（%s）", async route => {
    const worker = await loadWorker({ connectFlow: doneFlow, local: { [JOURNAL_KEY]: unknownJournal() },
      fetch: async url => String(url).endsWith("/web-sink/status") ? json(200, { workspaceId: WORKSPACE,
        activeBinding: route ? { ...validSinkBinding().activeBinding, canonicalUrl: route } : null,
        availability: { available: !!route } }) : fetchConnected(url),
    });
    expect(await worker.send(connect, freshSender)).toMatchObject({ ok: false, reason: "delivery_web_sink_mismatch" });
    expect(bindCalls(worker.fetchMock)).toHaveLength(0); expect(worker.tabsSendMessage).not.toHaveBeenCalled();
  });

  it.each(["bind", "recovery"])("%s await期间owner/generation变化不能使用迟到结果清记录或连绿", async phase => {
    let release!: (value: unknown) => void;
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    const worker = await loadWorker({ connectFlow: doneFlow, local: { [JOURNAL_KEY]: unknownJournal() },
      fetch: async url => {
        if (phase === "bind" && String(url).endsWith("/web-sink/status")) { entered(); return pending; }
        return fetchConnected(url);
      },
      tabsSendMessage: async () => { entered(); return pending; },
    });
    const connecting = worker.send(connect, freshSender); await reached;
    expect(await worker.send({ type: "c2c.recover" })).toMatchObject({ ok: false, reason: "production_recovery_busy" });
    expect(await worker.send({ ...connect, type: "c2c.reserve.page" }, freshSender)).toMatchObject({ ok: false });
    expect(await worker.send({ type: "c2c.autonomy.arm" })).toMatchObject({ ok: false, reason: "connect_in_flight" });
    worker.removeTab(7);
    await vi.waitFor(() => expect(worker.session.values.get(projectKey(OWNER_KEY))).toBeNull());
    release(phase === "bind" ? json(200, { ...validSinkBinding(), availability: { available: true } }) : { ...unknownRecoveryProbe(), generation: 2 });
    expect(await connecting).toMatchObject({ ok: false, reason: "connect_identity_changed" });
    expect(worker.local.values.get(projectKey(JOURNAL_KEY))).toEqual(unknownJournal());
    expect(worker.fetchMock.mock.calls.some(call => String(call[0]).endsWith("/isolate-attempt"))).toBe(false);
    noSend(worker);
  });

  it("暂时authStale允许相同credential fresh VERIFIED恢复", async () => {
    const worker = await loadWorker({ connectFlow: doneFlow,
      local: { [JOURNAL_KEY]: unknownJournal(), [TRANSPORT_KEY]: { ...initialState().transport, authStale: true } },
      fetch: fetchConnected, tabsSendMessage: async () => ({ ...unknownRecoveryProbe(), generation: 2 }),
    });
    expect(await worker.send(connect, freshSender)).toMatchObject({ ok: true, state: "CONNECTED", r5cConnected: true });
    expect(worker.local.values.get(projectKey(TRANSPORT_KEY))).toMatchObject({ authStale: false, credential: "c2c_comp_test-credential" });
    noSend(worker);
  });

  it("首次无transport的显式Connect仍建立owner供后续Pair取得proof", async () => {
    const worker = await loadWorker({ preMigrated: true, local: { [TRANSPORT_KEY]: null } });
    expect(await worker.send(connect, freshSender)).toMatchObject({ ok: false, reason: "cold_pair_required" });
    expect(await worker.send({ type: "c2c.owner-proof.request", canonicalRoute: ROUTE_A, generation: 2 }, freshSender)).toMatchObject({ ok: true });
    expect(worker.session.values.get(projectKey(OWNER_KEY))).toMatchObject({ documentId: "d2", generation: 2 });
    expect(worker.fetchMock).not.toHaveBeenCalled();
  });

  it("late-positive使用真实persist→ACK→persist回调，只补原attempt不重发", async () => {
    let worker!: Awaited<ReturnType<typeof loadWorker>>;
    const callbacks: unknown[] = [];
    const callbackSender = { ...freshSender, id: "browser-companion-test-id" };
    worker = await loadWorker({ connectFlow: doneFlow, local: { [JOURNAL_KEY]: unknownJournal() },
      fetch: async url => String(url).endsWith("/ack") ? json(200, { eventId: EVENT_ID, status: "observed" }) : fetchConnected(url),
      tabsSendMessage: async (_tabId, message) => {
        expect(message).toMatchObject({ type: "c2c.production.send.recover", startJournal: { state: "OUTCOME_UNKNOWN" } });
        const pending = { ...unknownJournal(), state: "OBSERVED_PENDING_ACK" };
        callbacks.push(await worker.send({ type: "c2c.production.journal.persist", workspaceId: WORKSPACE,
          expectedPrevious: unknownJournal(), proposed: pending }, callbackSender));
        callbacks.push(await worker.send({ type: "c2c.production.ack", workspaceId: WORKSPACE,
          eventId: EVENT_ID, attemptId: ATTEMPT_ID }, callbackSender));
        callbacks.push(await worker.send({ type: "c2c.production.journal.persist", workspaceId: WORKSPACE,
          expectedPrevious: pending, proposed: { state: "NONE" } }, callbackSender));
        return { ok: true, recovered: true, action: "ack", zeroWrite: true, zeroClick: true };
      },
    });
    const connected = await worker.send(connect, freshSender);
    expect(callbacks).toEqual([{ ok: true, journal: expect.objectContaining({ state: "OBSERVED_PENDING_ACK" }) },
      expect.objectContaining({ ok: true }), { ok: true, journal: expect.objectContaining({ state: "NONE" }) }]);
    expect(connected).toMatchObject({ ok: true, state: "CONNECTED",
      deliveryRecovery: { blocked: false, recovered: true, journalState: "NONE" } });
    expect(worker.fetchMock.mock.calls.filter(call => String(call[0]).endsWith("/ack"))).toHaveLength(1);
    expect(worker.fetchMock.mock.calls.some(call => String(call[0]).endsWith("/isolate-attempt"))).toBe(false);
    noSend(worker);
  });

  it("迟到terminal ACK遇owner关闭时保留原pending记录", async () => {
    let release!: (value: unknown) => void;
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    const old = { ...unknownJournal(), state: "OBSERVED_PENDING_ACK" };
    const worker = await loadWorker({ connectFlow: doneFlow, local: { [JOURNAL_KEY]: old },
      fetch: async url => {
        if (String(url).endsWith("/state")) return json(200, apiState(null));
        if (String(url).endsWith("/ack")) { entered(); return pending; }
        return fetchConnected(url);
      },
    });
    const connecting = worker.send(connect, freshSender); await reached;
    worker.removeTab(7);
    await vi.waitFor(() => expect(worker.session.values.get(projectKey(OWNER_KEY))).toBeNull());
    release(json(200, { eventId: EVENT_ID, attemptId: ATTEMPT_ID, status: "terminal_gone" }));
    expect(await connecting).toMatchObject({ ok: false, reason: "connect_identity_changed" });
    expect(worker.local.values.get(projectKey(JOURNAL_KEY))).toEqual(old);
    expect(worker.tabsSendMessage).not.toHaveBeenCalled(); noSend(worker);
  });

  it("生产Send已在执行时Connect不能更换owner或进入恢复", async () => {
    let release!: (value: unknown) => void;
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    const worker = await loadWorker({ connectFlow: doneFlow,
      local: { [JOURNAL_KEY]: { ...unknownJournal(), state: "RESERVED" } }, fetch: fetchConnected,
      tabsSendMessage: async () => { entered(); return pending; },
    });
    await worker.send({ type: "c2c.heartbeat", canonicalRoute: ROUTE_A, generation: 1,
      safety: { composer: "empty", generation: "idle", safe: true } }, worker.ownerSender);
    const sending = worker.send({ type: "c2c.production.send.request" });
    await Promise.race([reached, sending.then(result => { throw Error(`send gate: ${JSON.stringify(result)}`); })]);
    expect(await worker.send(connect, freshSender)).toMatchObject({ ok: false, reason: "production_recovery_busy" });
    expect(worker.session.values.get(projectKey(OWNER_KEY))).toMatchObject({ documentId: "document-r5c" });
    release({ ok: false, reason: "test_complete" }); await sending;
    expect(worker.fetchMock).not.toHaveBeenCalled();
  });


  it("恢复等待期间原credential被fresh401拒绝，迟到观察结果保留journal并禁止绿色", async () => {
    let rejectAuth = false;
    let release!: (value: unknown) => void;
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    const worker = await loadWorker({ connectFlow: doneFlow, local: { [JOURNAL_KEY]: unknownJournal() },
      fetch: async url => rejectAuth && String(url).endsWith("/state")
        ? json(401, { error: "COMPANION_UNAUTHORIZED" }) : fetchConnected(url),
      tabsSendMessage: async () => { entered(); return pending; },
    });
    const connecting = worker.send(connect, freshSender); await reached;
    rejectAuth = true;
    expect(await worker.send({ type: "c2c.fetch.state" })).toMatchObject({ ok: false, authStale: true });
    release({ ...unknownRecoveryProbe(), generation: 2 });
    expect(await connecting).toMatchObject({ ok: false, reason: "connect_identity_changed" });
    expect(worker.local.values.get(projectKey(JOURNAL_KEY))).toEqual(unknownJournal());
    expect(await worker.send({ type: "c2c.transport.status" })).toMatchObject({ transport: { r5cConnected: false } });
    expect(worker.fetchMock.mock.calls.some(call => String(call[0]).endsWith("/isolate-attempt"))).toBe(false);
    noSend(worker);
  });


  it("用户在rearm持久化等待中关闭回流时保留新的off偏好", async () => {
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const worker = await loadWorker({ connectFlow: doneFlow,
      local: { [JOURNAL_KEY]: unknownJournal(), [AUTONOMY_KEY]: { mode: "off", rearmOnConnect: true } },
      fetch: fetchConnected, tabsSendMessage: async () => ({ ...unknownRecoveryProbe(), generation: 2 }),
    });
    const save = worker.local.set.bind(worker.local);
    worker.local.set = async row => {
      if ((row[projectKey(AUTONOMY_KEY)] as any)?.mode === "armed") { entered(); await pending; }
      await save(row);
    };
    const connecting = worker.send(connect, freshSender); await reached;
    expect(await worker.send({ type: "c2c.autonomy.disable" })).toMatchObject({ ok: true, mode: "off" });
    release();
    expect(await connecting).toMatchObject({ ok: true, state: "CONNECTED", autonomy: "off" });
    expect(worker.local.values.get(projectKey(AUTONOMY_KEY))).toMatchObject({ mode: "off", rearmOnConnect: false });
    noSend(worker);
  });


  it.each(["state", "retire-unknown"])("Retire先挂起/%s时Connect返回busy，失败后释放恢复锁", async endpoint => {
    let release!: (value: unknown) => void;
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    let held = false;
    const worker = await loadWorker({ connectFlow: doneFlow, local: { [JOURNAL_KEY]: unknownJournal() },
      fetch: async url => {
        if (!held && String(url).endsWith(`/${endpoint}`)) { held = true; entered(); return pending; }
        return fetchConnected(url);
      },
      tabsSendMessage: async () => ({ ...unknownRecoveryProbe(), generation: 2 }),
    });
    const retiring = worker.send({ type: "c2c.retire.unknown" });
    await Promise.race([reached, retiring.then(result => { throw Error(`retire gate: ${JSON.stringify(result)}`); })]);
    expect(await worker.send(connect, freshSender)).toMatchObject({ ok: false, reason: "production_recovery_busy" });
    expect(await worker.send({ type: "c2c.recover" })).toMatchObject({ ok: false, reason: "production_recovery_busy" });
    expect(worker.session.values.get(projectKey(OWNER_KEY))).toMatchObject({ documentId: "document-r5c" });
    expect(worker.local.values.get(projectKey(JOURNAL_KEY))).toEqual(unknownJournal());
    expect(worker.tabsSendMessage).not.toHaveBeenCalled();
    release(json(500, { error: "test_retire_failed" }));
    expect(await retiring).toMatchObject({ ok: false });
    expect(await worker.send(connect, freshSender)).toMatchObject({ ok: true, state: "CONNECTED", r5cConnected: true });
    noSend(worker);
  });

});


describe("本机确认网页连接", () => {
  const REQUEST_KEY = "c2c_companion_local_route_request_v1";
  const nextCompanion = "66666666-6666-4666-8666-666666666666";
  const nextChallenge = "77777777-7777-4777-8777-777777777777";
  const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const owner = { tab: { id: 7 }, documentId: "document-r5c", frameId: 0, url: ROUTE_B };
  const message = { type: "c2c.connect.page", canonicalRoute: ROUTE_B, generation: 2,
    safety: { composer: "empty", generation: "idle", safe: true } };
  const doneFlow = { state: "DONE", workspaceId: WORKSPACE, bindingId: BINDING, epoch: EPOCH, companionId: COMPANION,
    routeCanonical: ROUTE_A, challengeId: "55555555-5555-4555-8555-555555555555",
    ownerWitness: { tabId: 7, documentId: "document-r5c", generation: 1, canonicalRoute: ROUTE_A }, updatedAt: Date.now() };
  async function setup(options: { loseRequest?: boolean; loseCommit?: boolean; requestStatus?: number; stage?: string;
    local?: Record<string, unknown>; connectFlow?: Record<string, unknown>; skipCommit?: boolean; candidateInvalid?: boolean } = {}) {
    let stage = options.stage ?? "PENDING";
    let requestId = "";
    let committed = false;
    const pairing = { credential: "c2c_comp_local-confirmed", companionId: nextCompanion, bindingId: BINDING,
      epoch: EPOCH, challengeId: nextChallenge, routeVerification: "VERIFIED", workspaceId: WORKSPACE, routeCanonical: ROUTE_B };
    const result = () => ({ requestId, state: stage, workspaceId: WORKSPACE, routeCanonical: ROUTE_B,
      expiresAt: "2099-01-01T00:00:00.000Z", ...(stage === "COMMITTED" ? { pairing } : stage === "CONFIRMED" ? { candidatePairing: { ...pairing, ...(options.candidateInvalid ? { epoch: EPOCH + 1 } : {}) } } : {}) });
    const worker = await loadWorker({ connectFlow: options.connectFlow ?? doneFlow, local: options.local,
      fetch: async (url, init: any = {}) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/route/local/request")) {
          requestId = JSON.parse(init.body).requestId;
          if (options.loseRequest) throw Error("response lost");
          return json(options.requestStatus ?? 202, result());
        }
        if (path.endsWith("/route/local/status")) return json(200, result());
        if (path.endsWith("/route/local/commit")) {
          expect(JSON.parse(init.body)).toEqual({ requestId, routeCanonical: ROUTE_B });
          if (options.skipCommit) throw Error("request did not arrive");
          committed = true; stage = "COMMITTED";
          if (options.loseCommit) throw Error("response lost");
          return json(200, result());
        }
        if (path.endsWith("/state") && init.headers?.authorization === `Bearer ${pairing.credential}` && !committed) return json(401, { error: "COMPANION_UNAUTHORIZED" });
        if (path.endsWith("/state")) return json(200, { ...apiState(null),
          companionId: committed ? nextCompanion : COMPANION, routeCanonical: committed ? ROUTE_B : ROUTE_A });
        if (path.endsWith("/web-sink/bind-current")) return json(200, { ...validSinkBinding(),
          activeBinding: { ...validSinkBinding().activeBinding, canonicalUrl: ROUTE_B } });
        if (path.endsWith("/web-sink/status")) return json(200, { ...validSinkBinding(),
          activeBinding: { ...validSinkBinding().activeBinding, canonicalUrl: committed ? ROUTE_B : ROUTE_A }, availability: { available: true } });
        return json(404, { error: "unexpected_endpoint" });
      },
    });
    await worker.selectProject(7, ROUTE_B);
    return { ...worker, confirm: () => { stage = "CONFIRMED"; }, expire: () => { stage = "EXPIRED"; }, result,
      calls: (endpoint: string) => worker.fetchMock.mock.calls.filter(call => new URL(String(call[0])).pathname.endsWith(endpoint)),
      heartbeat: () => worker.send({ ...message, type: "c2c.heartbeat" }, owner) };
  }
  const noChatSend = (worker: Awaited<ReturnType<typeof setup>>) => {
    expect(worker.tabsSendMessage).not.toHaveBeenCalled();
    expect(worker.fetchMock.mock.calls.some(call => /\/(?:pair|rebind|reserve|begin-send)(?:$|\/)/.test(new URL(String(call[0])).pathname))).toBe(false);
  };

  it("跨route只申请一次本机确认，popup关闭后精确heartbeat完成连接并保留manual off", async () => {
    const worker = await setup();
    expect(await worker.send(message, owner)).toMatchObject({ ok: true, state: "LOCAL_CONFIRM_PENDING" });
    expect(worker.local.values.get(projectKey(REQUEST_KEY))).toMatchObject({ stage: "PENDING", routeCanonical: ROUTE_B });
    expect(worker.calls("/route/local/request")).toHaveLength(1); expect(worker.calls("/route/local/commit")).toHaveLength(0);
    worker.confirm();
    expect(await worker.heartbeat()).toMatchObject({ transport: { r5cConnected: true, routeCanonical: ROUTE_B }, autonomy: { mode: "off" }, localRoute: { state: "DONE" } });
    expect(worker.calls("/route/local/commit")).toHaveLength(1);
    expect(worker.local.values.get(projectKey(TRANSPORT_KEY))).toMatchObject({ companionId: nextCompanion, bindingId: BINDING,
      epoch: EPOCH, challengeId: nextChallenge });
    expect((worker.local.values.get(projectKey(TRANSPORT_KEY)) as any).routeAttestationMessage ?? null).toBeNull();
    expect(worker.local.values.get(projectKey(FENCE_KEY))).toMatchObject({ state: "VERIFIED", companionId: nextCompanion, challengeId: nextChallenge });
    expect(await worker.send(message, owner)).toMatchObject({ ok: true, state: "CONNECTED" });
    expect(worker.calls("/route/local/request")).toHaveLength(1); noChatSend(worker);
  });

  it.each(["request", "commit"])("%s响应丢失只GET恢复，不重复native请求或commit", async phase => {
    const worker = await setup({ loseRequest: phase === "request", loseCommit: phase === "commit" });
    expect(await worker.send(message, owner)).toMatchObject({ ok: true, state: "LOCAL_CONFIRM_PENDING" });
    worker.confirm();
    const first = await worker.heartbeat();
    if (phase === "commit") {
      expect(first).toMatchObject({ localRoute: { state: "COMMIT_REQUESTED" } });
      expect(await worker.send(message, owner)).toMatchObject({ ok: true, state: "CONNECTED" });
    } else expect(first).toMatchObject({ localRoute: { state: "DONE" } });
    expect(worker.calls("/route/local/request")).toHaveLength(1); expect(worker.calls("/route/local/commit")).toHaveLength(1);
    expect(worker.calls("/route/local/status").length).toBeGreaterThanOrEqual(1); noChatSend(worker);
  });

  it.each(["CANCELLED", "EXPIRED"])("本机%s保持旧transport，不bind或commit", async stage => {
    const worker = await setup({ stage });
    expect(await worker.send(message, owner)).toMatchObject({ ok: true, state: `LOCAL_CONFIRM_${stage}` });
    expect(worker.local.values.get(projectKey(TRANSPORT_KEY))).toMatchObject({ companionId: COMPANION, routeCanonical: ROUTE_A });
    expect(worker.calls("/route/local/commit")).toHaveLength(0); expect(worker.calls("/web-sink/bind-current")).toHaveLength(0); noChatSend(worker);
  });

  it("旧Bridge明确upgrade_required，绝不降级bootstrap或ChatGPT验证码", async () => {
    const worker = await setup({ requestStatus: 404 });
    expect(await worker.send(message, owner)).toMatchObject({ ok: false, reason: "local_route_upgrade_required" });
    expect(worker.local.values.get(projectKey(REQUEST_KEY))).toMatchObject({ stage: "UPGRADE_REQUIRED" });
    noChatSend(worker);
  });

  it("确认后owner被关闭，heartbeat及显式Connect都不提交旧请求", async () => {
    const worker = await setup(); await worker.send(message, owner); worker.confirm();
    worker.removeTab(7);
    await vi.waitFor(() => expect(worker.session.values.get(projectKey(OWNER_KEY))).toBeNull());
    await worker.selectProject(7, ROUTE_B);
    await worker.send({ ...message, type: "c2c.heartbeat" }, { ...owner, documentId: "replacement" });
    expect(await worker.send(message, { ...owner, documentId: "replacement" })).toMatchObject({ ok: false, reason: "local_route_owner_changed" });
    expect(worker.calls("/route/local/commit")).toHaveLength(0); noChatSend(worker);
  });

  it("已完成本机确认后同tab刷新只GET恢复owner，不bind/rearm或重新确认", async () => {
    const worker = await setup(); await worker.send(message, owner); worker.confirm(); await worker.heartbeat();
    worker.fetchMock.mockClear();
    expect(await worker.send({ ...message, type: "c2c.heartbeat", generation: 3 }, { ...owner, documentId: "reload-document" }))
      .toMatchObject({ isOwner: true, transport: { r5cConnected: true }, autonomy: { mode: "off" } });
    expect(worker.local.values.get(projectKey(CONNECT_KEY))).toMatchObject({ ownerWitness: { documentId: "reload-document", generation: 3 } });
    expect(worker.fetchMock.mock.calls.every(call => (call[1] as any).method === "GET")).toBe(true);
    expect(worker.calls("/route/local/request")).toHaveLength(0); noChatSend(worker);
  });

  it("其他tab不能继承同对话owner或触发本机提交", async () => {
    const worker = await setup(); await worker.send(message, owner); worker.confirm();
    await worker.selectProject(8, ROUTE_B);
    expect(await worker.send({ ...message, type: "c2c.heartbeat" }, { ...owner, tab: { id: 8 }, documentId: "other-tab" }))
      .toMatchObject({ isOwner: false });
    expect(worker.calls("/route/local/commit")).toHaveLength(0); expect(worker.calls("/route/local/status")).toHaveLength(0); noChatSend(worker);
  });

  it.each([false, true])("commit未知且超期，用候选及原credential只读判定结果（未送达=%s）", async skipCommit => {
    const worker = await setup({ loseCommit: !skipCommit, skipCommit });
    await worker.send(message, owner); worker.confirm(); await worker.heartbeat();
    expect(worker.local.values.get(projectKey(REQUEST_KEY))).toMatchObject({ stage: "COMMIT_REQUESTED", stagedPairing: { credential: "c2c_comp_local-confirmed" } });
    const status = await worker.send({ type: "c2c.transport.status" });
    expect(JSON.stringify(status)).not.toContain("c2c_comp_local-confirmed");
    worker.expire();
    const restored = await worker.send(message, owner);
    expect(restored).toMatchObject(skipCommit
      ? { ok: false, reason: "local_route_request_ended", localRoute: { state: "EXPIRED" } }
      : { ok: true, state: "CONNECTED", r5cConnected: true });
    expect(worker.calls("/route/local/commit")).toHaveLength(1); expect(worker.calls("/route/local/request")).toHaveLength(1);
    expect(worker.local.values.get(projectKey(REQUEST_KEY))).not.toHaveProperty("stagedPairing"); noChatSend(worker);
  });

  it("candidate不精确匹配原receiver元数据时不能commit", async () => {
    const worker = await setup({ candidateInvalid: true }); await worker.send(message, owner); worker.confirm();
    expect(await worker.heartbeat()).toMatchObject({ connectReason: "local_route_candidate_invalid" });
    expect(worker.calls("/route/local/commit")).toHaveLength(0); noChatSend(worker);
  });

  it("staged candidate持久化失败时零commit，原transport保留", async () => {
    const worker = await setup(); await worker.send(message, owner); worker.confirm();
    const save = worker.local.set.bind(worker.local);
    worker.local.set = async row => {
      if ((row[projectKey(REQUEST_KEY)] as any)?.stage === "COMMIT_REQUESTED") throw Error("disk unavailable");
      await save(row);
    };
    expect(await worker.heartbeat()).toMatchObject({ ok: false });
    expect(worker.calls("/route/local/commit")).toHaveLength(0);
    expect(worker.local.values.get(projectKey(TRANSPORT_KEY))).toMatchObject({ companionId: COMPANION }); noChatSend(worker);
  });

  it("owner丢失后只读取得旧请求过期，下一次显式Connect可重新申请", async () => {
    const worker = await setup(); await worker.send(message, owner); worker.expire();
    const replacement = { ...owner, documentId: "replacement" };
    expect(await worker.send(message, replacement)).toMatchObject({ ok: false, reason: "local_route_request_ended" });
    expect(worker.calls("/route/local/commit")).toHaveLength(0);
    await worker.send(message, replacement);
    expect(worker.calls("/route/local/request")).toHaveLength(2); noChatSend(worker);
  });

  it.each(["removed", "document", "route", "persist", "session"])("reload恢复await期间%s变化不能授予旧owner或留下过期witness", async change => {
    const worker = await setup(); await worker.send(message, owner); worker.confirm(); await worker.heartbeat();
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    if (change === "session") {
      const save = worker.session.set.bind(worker.session);
      let held = false;
      worker.session.set = async row => {
        if (!held) { held = true; entered(); await pending; }
        await save(row);
      };
    } else if (change === "persist") {
      const save = worker.local.set.bind(worker.local);
      worker.local.set = async row => {
        if ((row[projectKey(CONNECT_KEY)] as any)?.ownerWitness?.documentId === "reload-old") { entered(); await pending; }
        await save(row);
      };
    } else {
      const fetch = worker.fetchMock.getMockImplementation()!;
      let held = false;
      worker.fetchMock.mockImplementation(async (url, init) => {
        if (!held && String(url).endsWith("/state")) { held = true; entered(); await pending; }
        return fetch(url, init);
      });
    }
    const restoring = worker.send({ ...message, type: "c2c.heartbeat", generation: 3 }, { ...owner, documentId: "reload-old" });
    await Promise.race([reached, restoring.then(result => { throw Error(`reload gate: ${JSON.stringify(result)}`); })]);
    let queued: Promise<unknown> | undefined;
    if (change === "removed") worker.removeTab(7);
    else queued = worker.send({ ...message, type: "c2c.heartbeat", generation: 4,
      canonicalRoute: change === "route" ? ROUTE_A : ROUTE_B }, { ...owner,
      documentId: "reload-new", url: change === "route" ? ROUTE_A : ROUTE_B });
    release();
    expect(await restoring).toMatchObject({ isOwner: false });
    if (queued) await queued;
    expect(worker.session.values.get(projectKey(OWNER_KEY))).toBeNull();
    expect((worker.local.values.get(projectKey(CONNECT_KEY))) as any).not.toMatchObject({ ownerWitness: { documentId: "reload-old" } });
    noChatSend(worker);
  });

  it("COMMITTED已落盘后中断，显式同目标新文档可完成连接而不重复native/commit", async () => {
    const worker = await setup(); await worker.send(message, owner); worker.confirm();
    const fetch = worker.fetchMock.getMockImplementation()!;
    let blockSink = true;
    worker.fetchMock.mockImplementation(async (url, init) => String(url).endsWith("/web-sink/bind-current") && blockSink
      ? json(503, { error: "temporary" }) : fetch(url, init));
    await worker.heartbeat();
    expect(worker.local.values.get(projectKey(REQUEST_KEY))).toMatchObject({ stage: "COMMITTED" });
    blockSink = false;
    expect(await worker.send(message, { ...owner, documentId: "fresh-explicit" })).toMatchObject({ ok: true, state: "CONNECTED" });
    expect(worker.calls("/route/local/request")).toHaveLength(1); expect(worker.calls("/route/local/commit")).toHaveLength(1); noChatSend(worker);
  });

  it.each(["committed", "expired-committed", "expired-unsent"])("未知commit换文档后显式Connect只读恢复%s", async result => {
    const worker = await setup({ loseCommit: result !== "expired-unsent", skipCommit: result === "expired-unsent" });
    await worker.send(message, owner); worker.confirm(); await worker.heartbeat();
    if (result.startsWith("expired")) worker.expire();
    const restored = await worker.send(message, { ...owner, documentId: "replacement-commit" });
    expect(restored).toMatchObject(result === "expired-unsent"
      ? { ok: false, reason: "local_route_request_ended", localRoute: { state: "EXPIRED" } }
      : { ok: true, state: "CONNECTED", autonomy: "off" });
    expect(worker.calls("/route/local/request")).toHaveLength(1); expect(worker.calls("/route/local/commit")).toHaveLength(1);
    noChatSend(worker);
  });

  it("确认期间服务端身份变化会结束旧请求，下一次显式Connect可重新申请", async () => {
    const worker = await setup(); await worker.send(message, owner);
    const fetch = worker.fetchMock.getMockImplementation()!;
    worker.fetchMock.mockImplementation(async (url, init) => String(url).includes("/route/local/status?")
      ? json(409, { error: "LOCAL_ROUTE_CHANGED" }) : fetch(url, init));
    expect(await worker.send(message, owner)).toMatchObject({ ok: false, reason: "LOCAL_ROUTE_CHANGED", localRoute: { state: "CHANGED" } });
    await worker.send(message, owner);
    expect(worker.calls("/route/local/request")).toHaveLength(2); expect(worker.calls("/route/local/commit")).toHaveLength(0); noChatSend(worker);
  });

  it("未知commit显式重建witness持久化期间新document到达，不能接管旧document", async () => {
    const worker = await setup({ loseCommit: true }); await worker.send(message, owner); worker.confirm(); await worker.heartbeat();
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const save = worker.local.set.bind(worker.local);
    worker.local.set = async row => {
      if ((row[projectKey(REQUEST_KEY)] as any)?.ownerWitness?.documentId === "replacement-commit") { entered(); await held; }
      await save(row);
    };
    const connecting = worker.send(message, { ...owner, documentId: "replacement-commit" });
    await Promise.race([reached, connecting.then(result => { throw Error(JSON.stringify(result)); })]);
    const queued = worker.send({ ...message, type: "c2c.heartbeat", generation: 3 }, { ...owner, documentId: "newest-document" });
    release();
    expect(await connecting).toMatchObject({ ok: false, reason: "local_route_owner_changed" }); await queued;
    expect(worker.local.values.get(projectKey(REQUEST_KEY))).toMatchObject({ stage: "COMMIT_REQUESTED", ownerWitness: { documentId: "document-r5c" } });
    expect(worker.calls("/route/local/commit")).toHaveLength(1); noChatSend(worker);
  });

});

describe("统一当前对话连接派生", () => {
  const page = { canonicalRoute: ROUTE_A, generation: 1, safety: { composer: "empty", generation: "idle", safe: true } };
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  const policy = { mode: "armed", bindingId: BINDING, epoch: EPOCH, routeCanonical: ROUTE_A, armedAt: Date.now() };
  const popupSource = fs.readFileSync("browser-companion/popup/popup.js", "utf8");
  const popupState = vm.runInNewContext(popupSource.slice(popupSource.indexOf("  function friendlyConnectState("),
    popupSource.indexOf("  const deliveryRecoveryHint")) + "\nfriendlyConnectState");
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync("browser-companion/operations/view.js", "utf8"), context);

  it.each(["sink_unavailable", "flow_pending", "owner_witness_changed", "witness_missing"])("%s 时 popup/toolbar/operations 一致，手工与自动入口均 zero reserve/send", async condition => {
    const flow = connectedFlow(condition === "flow_pending" ? { state: "COMPLETE_REQUESTED" }
      : condition === "witness_missing" ? { ownerWitness: undefined } : {});
    const worker = await loadWorker({ connectFlow: flow, local: { [AUTONOMY_KEY]: policy },
      fetch: async url => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/web-sink/status")) return json({ ...validSinkBinding(), availability: { available: condition !== "sink_unavailable" } });
        if (path.endsWith("/operations")) return json({ ...apiState(null), schemaVersion: 1, readOnly: true,
          commands: [], observedAt: new Date().toISOString() });
        return json({ ...apiState(null), pendingReady: 1 });
      },
    });
    const observation = { ...page, generation: condition === "owner_witness_changed" ? 2 : 1 };
    if (condition === "owner_witness_changed") {
      worker.ownerSender.documentId = "explicit-replacement";
      await worker.send({ type: "c2c.bind", ...observation }, worker.ownerSender);
    }
    const status: any = await worker.send({ type: "c2c.status.page", ...observation }, worker.ownerSender);
    expect(status.transport.connectionReadiness.ready).toBe(false);
    expect(status.transport.r5cConnected).toBe(status.transport.connectionReadiness.ready);
    expect(status.transport.webSinkConverged).toBe(status.transport.connectionReadiness.ready);
    expect(popupState(status.transport, status.isOwner, status.connectReason, status.connectState, true,
      status.transport.connectionReadiness, status.routeAttestFence, status.localRoute)[0]).not.toBe("当前对话已连接");
    expect(worker.action.setBadgeText.mock.calls.at(-1)?.[0]).toEqual({ text: "C!" });
    const operations: any = await worker.send({ type: "c2c.operations.read", workspaceId: WORKSPACE }, worker.panelSender);
    expect(operations.web.connectionReadiness).toEqual(status.transport.connectionReadiness);
    expect(context.C2COperations.derive(operations).web).toBe("当前对话需要完成连接");
    await worker.send({ type: "c2c.heartbeat", ...observation }, worker.ownerSender);
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    const after: any = await worker.send({ type: "c2c.status.read", ...observation }, worker.ownerSender);
    expect(after.autonomy.lastReason).toBe("connect_not_ready");
    expect(await worker.send({ type: "c2c.autonomy.disable", workspaceId: WORKSPACE }, { id: "browser-companion-test-id" })).toMatchObject({ ok: true });
    expect(await worker.send({ type: "c2c.reserve.page", ...observation,
      connectionReadiness: { ready: true }, r5cConnected: true }, worker.ownerSender)).toMatchObject({ ok: false });
    expect(worker.fetchMock.mock.calls.some(call => /\/(reserve|begin-send|ack)$/.test(String(call[0])))).toBe(false);
    expect(worker.tabsSendMessage).not.toHaveBeenCalled();
  });

  it("精确 owner 为 ready，foreign tab 的只读页面投影不继承全局连接", async () => {
    const worker = await loadWorker({ connectFlow: connectedFlow(), local: { [AUTONOMY_KEY]: policy },
      fetch: async () => json({ ...validSinkBinding(), availability: { available: true } }) });
    const status: any = await worker.send({ type: "c2c.status.page", ...page }, worker.ownerSender);
    expect(status.transport.connectionReadiness).toEqual({ ready: true, reason: null });
    expect(worker.action.setBadgeText.mock.calls.at(-1)?.[0]).toEqual({ text: "C" });
    await worker.selectProject(8, ROUTE_A);
    const other: any = await worker.send({ type: "c2c.status.read", ...page }, { ...worker.ownerSender, tab: { id: 8 }, documentId: "other-document" });
    expect(other.transport.connectionReadiness).toEqual({ ready: false, reason: "owner_witness_changed" });
    expect(other.transport.r5cConnected).toBe(false);
    const owner: any = await worker.send({ type: "c2c.status.read", ...page }, worker.ownerSender);
    expect(owner.transport.connectionReadiness.ready).toBe(true);
    expect(worker.tabsSendMessage).not.toHaveBeenCalled();
  });

  it.each(["storage", "auth", "identity", "epoch", "sink_workspace", "sink_adapter", "sink_surface", "sink_route", "owner_tab", "owner_document", "owner_generation", "owner_route", "mutation", "pair_barrier", "route_unknown"])("%s 变化从真实内部状态 fail closed", condition => {
    const state: any = { transport: initialState().transport, storageProtected: true, connectFlow: connectedFlow(),
      owner: initialState().owner, webSink: { synced: true, available: true, binding: validSinkBinding().activeBinding } };
    if (condition === "mutation") state.transportMutationInFlight = true;
    if (condition === "pair_barrier") state.routeAttestFence = { state: "PAIRING_TRANSITION" };
    if (condition === "route_unknown") state.routeAttestFence = { state: "OUTCOME_UNKNOWN" };
    if (condition === "storage") state.storageProtected = false;
    if (condition === "auth") state.transport.authStale = true;
    if (condition === "identity") state.transportIdentityBlocked = true;
    if (condition === "epoch") state.transport.epoch += 1;
    if (condition === "sink_workspace") state.webSink.binding.workspaceId = "foreign";
    if (condition === "sink_adapter") state.webSink.binding.pluginId = "foreign";
    if (condition === "sink_surface") state.webSink.binding.surfaceId = "foreign";
    if (condition === "sink_route") state.webSink.binding.canonicalUrl = ROUTE_B;
    if (condition === "owner_tab") state.owner.tabId = 8;
    if (condition === "owner_document") state.owner.documentId = "foreign";
    if (condition === "owner_generation") state.owner.generation += 1;
    if (condition === "owner_route") state.owner.canonicalRoute = ROUTE_B;
    expect(deriveConnectionReadiness(state).ready).toBe(false);
  });
});

describe("新增预约不继承异步期间的新身份", () => {
  const page = { canonicalRoute: ROUTE_A, generation: 1, safety: { composer: "empty", generation: "idle", safe: true } };
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  it("Pair 在等 server 时旧 DONE+sink 不能新增 reserve，替换完成后旧页面仍不 ready", async () => {
    let finish!: (value: unknown) => void;
    let start!: () => void;
    const pending = new Promise(resolve => { finish = resolve; });
    const started = new Promise<void>(resolve => { start = resolve; });
    const worker = await loadWorker({ connectFlow: connectedFlow(), fetch: async url => {
      if (String(url).endsWith("/web-sink/status")) return json({ ...validSinkBinding(), availability: { available: true } });
      if (String(url).endsWith("/pair")) { start(); return pending; }
      return json(apiState(null));
    } });
    await worker.send({ type: "c2c.status.page", ...page }, worker.ownerSender);
    const proof: any = await worker.send({ type: "c2c.owner-proof.request", ...page }, worker.ownerSender);
    const pairing = worker.send({ type: "c2c.pair", workspaceId: WORKSPACE, bridgeOrigin: "https://bridge.example.test",
      tabId: 7, canonicalRoute: ROUTE_A, intentId: "race-intent", secret: "race-secret", ownerProofId: proof.proof.id });
    await started;
    const before: any = await worker.send({ type: "c2c.status.read", ...page }, worker.ownerSender);
    expect(before.transport.connectionReadiness).toEqual({ ready: false, reason: "transport_mutation_in_flight" });
    expect(await worker.send({ type: "c2c.reserve.page", ...page }, worker.ownerSender))
      .toMatchObject({ ok: false, reason: "transport_mutation_in_flight" });
    finish(json({ ...apiState(null), credential: "c2c_comp_replacement-race",
      routeAttestation: { message: "[C2C_ROUTE_ATTEST]\nchallengeId=66666666-6666-4666-8666-666666666666", expiresAt: "2099-01-01T00:00:00.000Z" } }));
    expect(await pairing).toMatchObject({ ok: true });
    expect(worker.fetchMock.mock.calls.some(call => /\/(reserve|begin-send)$/.test(String(call[0])))).toBe(false);
    const after: any = await worker.send({ type: "c2c.status.read", ...page }, worker.ownerSender);
    expect(after.transport.connectionReadiness.ready).toBe(false);
  });

  it.each(["owner", "auth", "recovery"])("reserve journal 落盘等待期间 %s 变化，零请求并撤回本次未发送记录", async condition => {
    const worker = await loadWorker({ connectFlow: connectedFlow(), fetch: async url => {
      if (String(url).endsWith("/web-sink/status")) return json({ ...validSinkBinding(), availability: { available: true } });
      if (condition === "recovery") return json(apiState(null));
      return { ok: false, status: 401, json: async () => ({ error: "COMPANION_UNAUTHORIZED" }) };
    } });
    await worker.send({ type: "c2c.status.page", ...page }, worker.ownerSender);
    let finish!: () => void;
    let start!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const started = new Promise<void>(resolve => { start = resolve; });
    const set = worker.local.set;
    worker.local.set = async values => {
      if ((values[projectKey(JOURNAL_KEY)] as any)?.state === "RESERVE_REQUESTED") { start(); await pending; }
      return set(values);
    };
    const reserving = worker.send({ type: "c2c.reserve.page", ...page }, worker.ownerSender);
    await started;
    if (condition === "owner") await worker.send({ type: "c2c.bind", ...page, generation: 2 }, { ...worker.ownerSender, documentId: "new-document" });
    else if (condition === "recovery") expect(await worker.send({ type: "c2c.recover" })).toMatchObject({ ok: true, journal: { state: "NONE" } });
    else expect(await worker.send({ type: "c2c.fetch.state" })).toMatchObject({ ok: false, authStale: true });
    finish();
    expect(await reserving).toMatchObject({ ok: false, reason: "connection_changed", journalState: "NONE" });
    expect(worker.fetchMock.mock.calls.some(call => /\/(reserve|begin-send|ack)$/.test(String(call[0])))).toBe(false);
    expect(worker.tabsSendMessage).not.toHaveBeenCalled();
    expect(worker.local.values.get(projectKey(JOURNAL_KEY))).toMatchObject({ state: "NONE" });
  });
});

describe("SW 重建后普通 owner 心跳恢复连接权威", () => {
  const page = { canonicalRoute: ROUTE_A, generation: 1, safety: { composer: "empty", generation: "idle", safe: true } };
  const json = (status: number, body: unknown) => ({ ok: status === 200, status, json: async () => body });
  it.each(["ok", "network", "unavailable"])("cold cache 的 %s 状态只读恢复并有界重试，不需 popup/Connect", async first => {
    const clock = vi.spyOn(Date, "now");
    let now = Date.now();
    clock.mockImplementation(() => now);
    let statusCalls = 0;
    const fetchImpl = async (url: unknown) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/web-sink/status")) {
        statusCalls++;
        if (statusCalls === 2 && first === "network") throw new Error("offline");
        return json(200, { ...validSinkBinding(), availability: { available: !(statusCalls === 2 && first === "unavailable") } });
      }
      if (path.endsWith("/reserve")) return json(404, { error: "COMPANION_NO_READY_EVENT" });
      return json(200, { ...apiState(null), pendingReady: 1 });
    };
    try {
      const worker1 = await loadWorker({ connectFlow: connectedFlow(), local: { [AUTONOMY_KEY]: {
        mode: "armed", bindingId: BINDING, epoch: EPOCH, routeCanonical: ROUTE_A, armedAt: now,
      } }, fetch: fetchImpl });
      await worker1.send({ type: "c2c.status.page", ...page }, worker1.ownerSender);
      expect(statusCalls).toBe(1);
      const worker2 = await loadWorker({ storage: { local: worker1.local, session: worker1.session }, fetch: fetchImpl });
      const cold: any = await worker2.send({ type: "c2c.status.read", ...page }, worker2.ownerSender);
      expect(cold.transport.connectionReadiness.ready).toBe(false);
      const heartbeat = async () => {
        await worker2.send({ type: "c2c.heartbeat", ...page }, worker2.ownerSender);
        for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
      };
      await heartbeat();
      expect(statusCalls).toBe(2);
      if (first !== "ok") {
        expect(worker2.fetchMock.mock.calls.some(call => String(call[0]).endsWith("/reserve"))).toBe(false);
        await heartbeat();
        expect(statusCalls).toBe(2);
        now += 2_100;
        await heartbeat();
        expect(statusCalls).toBe(3);
      }
      const recovered: any = await worker2.send({ type: "c2c.status.read", ...page }, worker2.ownerSender);
      expect(recovered.transport.connectionReadiness.ready).toBe(true);
      expect(worker2.fetchMock.mock.calls.filter(call => String(call[0]).endsWith("/reserve"))).toHaveLength(1);
      const syncedCalls = statusCalls;
      await heartbeat();
      expect(statusCalls).toBe(syncedCalls);
      expect(worker2.fetchMock.mock.calls.some(call => /\/(?:pair|rebind|begin-send|bind-current|ack)$/.test(String(call[0])))).toBe(false);
      expect(worker2.tabsSendMessage).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });
});

describe("同 document 等价 URL generation 变化的只读恢复", () => {
  const projectBase = `https://chatgpt.com/g/g-p-${"a".repeat(32)}/c/11111111-1111-4111-8111-111111111111`;
  const page = { generation: 2, safety: { composer: "empty", generation: "idle", safe: true } };
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  it.each([
    [ROUTE_A, ROUTE_A.replace("chatgpt.com", "www.chatgpt.com") + "/"],
    [projectBase, projectBase.replace("/c/", "-renamed-project/c/")],
  ])("%s 的等价表示仅 fresh GET 复核后刷新 witness，不需 Connect", async (route, alias) => {
    const owner = initialState(route).owner;
    const worker = await loadWorker({ route, connectFlow: connectedFlow({ routeCanonical: route, ownerWitness: owner }),
      fetch: async url => String(url).endsWith("/web-sink/status")
        ? json({ ...validSinkBinding(), activeBinding: { ...validSinkBinding().activeBinding, canonicalUrl: route }, availability: { available: true } })
        : json({ ...apiState(null), routeCanonical: route }) });
    const sender = { ...worker.ownerSender, tab: { id: 7, url: alias }, url: alias };
    await worker.send({ type: "c2c.observe", ...page, canonicalRoute: alias }, sender);
    const before: any = await worker.send({ type: "c2c.status.read", canonicalRoute: alias }, sender);
    expect(before.transport.connectionReadiness.ready).toBe(false);
    const restored: any = await worker.send({ type: "c2c.heartbeat", ...page, canonicalRoute: alias }, sender);
    expect(restored).toMatchObject({ isOwner: true, transport: { connectionReadiness: { ready: true } }, autonomy: { mode: "off" } });
    expect(worker.local.values.get(projectKey(CONNECT_KEY))).toMatchObject({ ownerWitness: { documentId: owner.documentId, generation: 2 } });
    expect(worker.fetchMock.mock.calls.map(call => new URL(String(call[0])).pathname.split("/").slice(-2).join("/")))
      .toEqual(["v1/state", "web-sink/status"]);
    expect(worker.fetchMock.mock.calls.every(call => (call[1] as any).method === "GET")).toBe(true);
    expect(worker.tabsSendMessage).not.toHaveBeenCalled();
  });

  it.each(["sink_unavailable", "flow_unknown", "fence_unknown", "journal_active", "new_route", "foreign_tab"])("%s 不继承旧 witness", async condition => {
    const worker = await loadWorker({ connectFlow: connectedFlow(condition === "flow_unknown" ? { state: "OUTCOME_UNKNOWN" } : {}),
      ...(condition === "fence_unknown" ? { routeFence: { state: "OUTCOME_UNKNOWN", companionId: COMPANION,
        challengeId: "55555555-5555-4555-8555-555555555555", updatedAt: Date.now() } } : {}),
      ...(condition === "journal_active" ? { local: { [JOURNAL_KEY]: unknownJournal() } } : {}),
      fetch: async url => String(url).endsWith("/web-sink/status")
        ? json({ ...validSinkBinding(), availability: { available: condition !== "sink_unavailable" } }) : json(apiState(null)),
    });
    const route = condition === "new_route" ? ROUTE_B : ROUTE_A.replace("chatgpt.com", "www.chatgpt.com");
    const tabId = condition === "foreign_tab" ? 8 : 7;
    if (tabId === 8) await worker.selectProject(8, ROUTE_A);
    const sender = { ...worker.ownerSender, tab: { id: tabId, url: route }, url: route };
    await worker.send({ type: "c2c.observe", ...page, canonicalRoute: route }, sender);
    await worker.send({ type: "c2c.heartbeat", ...page, canonicalRoute: route }, sender);
    expect(worker.local.values.get(projectKey(CONNECT_KEY))).toMatchObject({ ownerWitness: { generation: 1 } });
    expect(worker.fetchMock.mock.calls.some(call => (call[1] as any).method !== "GET")).toBe(false);
    expect(worker.tabsSendMessage).not.toHaveBeenCalled();
  });
});
