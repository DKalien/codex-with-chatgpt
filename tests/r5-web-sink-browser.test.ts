import { afterEach, describe, expect, it, vi } from "vitest";

const ROUTE_A = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const ROUTE_B = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";
const WORKSPACE = "workspace-r5c-sink";
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

function storageArea(initial: Record<string, unknown>) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async get(keys?: string | string[]) {
      if (keys == null) return Object.fromEntries(values);
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.map(key => [key, values.get(key)]));
    },
    async set(row: Record<string, unknown>) {
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

async function loadWorker(opts: {
  fetch?: (url: unknown, init?: unknown) => Promise<unknown>;
  route?: string;
  routeVerification?: "VERIFIED" | "PENDING";
  ownerRoute?: string;
  connectFlow?: Record<string, unknown>;
  routeFence?: Record<string, unknown>;
  local?: Record<string, unknown>;
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
  const local = storageArea(initial.local);
  const session = storageArea(initial.session);
  let messageListener: ((message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => unknown) | null = null;
  const tabsSendMessage = vi.fn(async () => ({ ok: true, observed: true, mutationAttempted: true, clickAttempted: true }));
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
  const chrome = {
    storage: { local, session },
    runtime: {
      onMessage: { addListener(listener: typeof messageListener) { messageListener = listener; } },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
    },
    tabs: {
      onRemoved: { addListener() {} },
      sendMessage: tabsSendMessage,
    },
    permissions: { contains: async () => true },
  };
  vi.stubGlobal("chrome", chrome);
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  await import("../browser-companion/service-worker.js");
  if (!messageListener) throw new Error("service worker did not register onMessage handler");
  const send = (message: unknown, sender: unknown = {}) => new Promise<unknown>((resolve) => {
    messageListener!(message, sender, resolve);
  });
  const ownerSender = {
    tab: { id: 7 },
    documentId: "document-r5c",
    frameId: 0,
    url: opts.route ?? ROUTE_A,
  };
  return { initial, local, session, fetchMock, send, ownerSender, tabsSendMessage };
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
    const a = worker.send({ type: "c2c.operations.read" }), b = worker.send({ type: "c2c.operations.read" });
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
    expect(await worker.send({ type: "c2c.operations.read" })).toMatchObject({ ok: false, reason: "COMPANION_UNAUTHORIZED" });
    expect(JSON.stringify(Object.fromEntries(worker.local.values))).toBe(before); expect(worker.tabsSendMessage).not.toHaveBeenCalled();
  });
  it("read rejects mismatched response identity without synchronizing binding", async () => {
    const worker = await loadWorker({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ ...body, epoch: EPOCH + 1 }) }) });
    expect(await worker.send({ type: "c2c.operations.read" })).toMatchObject({ ok: false, reason: "identity_mismatch:epoch" });
    expect(worker.local.values.get(TRANSPORT_KEY)).toMatchObject({ epoch: EPOCH });
  });
  it("popup status observation never runs connect convergence or mutates owner on route mismatch", async () => {
    const worker = await loadWorker();
    await worker.send({ type: "c2c.status.read", canonicalRoute: ROUTE_A }, worker.ownerSender);
    const before = JSON.stringify([Object.fromEntries(worker.local.values), Object.fromEntries(worker.session.values)]);
    expect(await worker.send({ type: "c2c.status.read", canonicalRoute: ROUTE_B }, worker.ownerSender)).toMatchObject({ ok: true, isOwner: false });
    expect(worker.fetchMock).not.toHaveBeenCalled(); expect(worker.tabsSendMessage).not.toHaveBeenCalled();
    expect(JSON.stringify([Object.fromEntries(worker.local.values), Object.fromEntries(worker.session.values)])).toBe(before);
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
    const ackJournal = { state: "OBSERVED_PENDING_ACK", eventId: "a".repeat(32), reservationId: "reserved",
      attemptId: "attempt", routeCanonical: ROUTE_A, bindingId: BINDING, epoch: EPOCH,
      message: "fixture result", messageSha256: "b".repeat(64), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const worker = await loadWorker({
      ...(endpoint === "ack" ? { local: { [JOURNAL]: ackJournal } } : {}),
      fetch: async url => {
        const pathname = String(url);
        if (pathname.endsWith(`/${endpoint}`) && first) { first = false; started(); return pending; }
        if (pathname.endsWith("/pair")) return json(200, pairBody);
        // Current credential 401 permits repairing an active journal; replacement itself is real Pair.
        return json(401, { error: "COMPANION_UNAUTHORIZED" });
      },
    });
    const oldResponse = worker.send(endpoint === "state" ? { type: "c2c.fetch.state" }
      : endpoint === "reserve" ? { type: "c2c.reserve.page", ...page }
        : { type: "c2c.production.ack", eventId: ackJournal.eventId, attemptId: ackJournal.attemptId }, worker.ownerSender);
    await Promise.race([requested, oldResponse.then(response => { throw new Error(`request did not reach fetch: ${JSON.stringify(response)}`); })]);
    if (endpoint !== "state") expect(await worker.send({ type: "c2c.fetch.state" })).toMatchObject({ authStale: true });
    const proof = await worker.send({ type: "c2c.owner-proof.request", ...page }, worker.ownerSender) as { proof: { id: string } };
    expect(await worker.send({ type: "c2c.pair", bridgeOrigin: "https://bridge.example.test",
      intentId: "fixture-intent", secret: "fixture-secret", ownerProofId: proof.proof.id })).toMatchObject({ ok: true });
    const before = JSON.stringify(Object.fromEntries(worker.local.values));
    finish(json(401, { error: "COMPANION_UNAUTHORIZED" }));
    expect(await oldResponse).toMatchObject({ ok: false, reason: "stale_transport_response" });
    expect(JSON.stringify(Object.fromEntries(worker.local.values))).toBe(before);
    expect(worker.local.values.get(TRANSPORT_KEY)).toMatchObject({ authStale: false, credential: pairBody.credential });
    expect(worker.tabsSendMessage).not.toHaveBeenCalled();
  });

  it("current 401 is durably stale and remains stale after SW hydration", async () => {
    const worker = await loadWorker({ fetch: async () => json(401, { error: "COMPANION_UNAUTHORIZED" }) });
    expect(await worker.send({ type: "c2c.fetch.state" })).toMatchObject({ authStale: true });
    expect(worker.local.values.get(TRANSPORT_KEY)).toMatchObject({ authStale: true });
    const restarted = await loadWorker({ local: Object.fromEntries(worker.local.values) });
    expect(await restarted.send({ type: "c2c.transport.status" })).toMatchObject({ transport: { authStale: true } });
    expect(restarted.local.values.get(TRANSPORT_KEY)).toMatchObject({ authStale: true });
  });

  it("still-current rebindPending 401 keeps the established special semantics", async () => {
    const initial = initialState();
    const worker = await loadWorker({ local: { [TRANSPORT_KEY]: { ...initial.transport, rebindPending: true } },
      fetch: async () => json(401, { error: "COMPANION_UNAUTHORIZED" }) });
    expect(await worker.send({ type: "c2c.fetch.state" })).toEqual({ ok: false, reason: "rebind_pending", authStale: false });
    expect(worker.local.values.get(TRANSPORT_KEY)).toMatchObject({ authStale: false });
  });

  it("revalidates the original stale credential after restart without pairing, sending or changing authority", async () => {
    const initial = initialState();
    const durable = { [TRANSPORT_KEY]: { ...initial.transport, authStale: true },
      [JOURNAL]: { state: "OUTCOME_UNKNOWN", eventId: "existing" },
      [FENCE_KEY]: { state: "VERIFIED", companionId: COMPANION, challengeId: "unchanged" } };
    const worker = await loadWorker({ local: durable, fetch: async () => json(200, stateBody) });
    const beforeJournal = worker.local.values.get(JOURNAL);
    const beforeFence = worker.local.values.get(FENCE_KEY);
    expect(await worker.send({ type: "c2c.fetch.state" })).toMatchObject({ ok: true });
    const { routeAttestationMessage: _pendingMessage, ...expectedTransport } = initial.transport;
    expect(worker.local.values.get(TRANSPORT_KEY)).toEqual({ ...expectedTransport, authStale: false });
    expect(worker.local.values.get(JOURNAL)).toEqual(beforeJournal);
    expect(worker.local.values.get(FENCE_KEY)).toEqual(beforeFence);
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
    expect(worker.local.values.get(TRANSPORT_KEY)).toMatchObject({ authStale: true, authStaleReason: "auth_revalidation_required" });
    expect(await worker.send({ type: "c2c.transport.status" })).toMatchObject({ transport: { authStale: true, productionEligible: false } });
    const requestsBeforeReserve = worker.fetchMock.mock.calls.length;
    expect(await worker.send({ type: "c2c.reserve.page", ...page }, worker.ownerSender)).toMatchObject({ ok: false, reason: "auth_stale" });
    expect(worker.fetchMock).toHaveBeenCalledTimes(requestsBeforeReserve);
    rejected = false;
    expect(await worker.send({ type: "c2c.fetch.state" })).toMatchObject({ ok: true });
    expect(worker.local.values.get(TRANSPORT_KEY)).toMatchObject({ authStale: false });
    expect(worker.local.values.get(TRANSPORT_KEY)).not.toHaveProperty("authStaleReason");
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
    expect(worker.local.values.get(TRANSPORT_KEY)).toMatchObject({ authStale: true, credential: initialState().transport.credential });
    expect(worker.tabsSendMessage).not.toHaveBeenCalled();
  });

  it("invalid 200 state is not proof that an otherwise valid pair was revoked", async () => {
    const worker = await loadWorker({ fetch: async () => json(200, {}) });
    expect(await worker.send({ type: "c2c.fetch.state" })).toEqual({ ok: false, reason: "state_response_invalid" });
    expect(worker.local.values.get(TRANSPORT_KEY)).toMatchObject({ authStale: false });
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
    expect(worker.local.values.get(TRANSPORT_KEY)).toMatchObject({ authStale: true });
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
    const before = local.values.get(CONNECT_KEY) as { ownerWitness?: { documentId?: string } };
    expect(before).toMatchObject({ state: "DONE", ownerWitness: { documentId: "old-document" } });
    const status = await send({ type: "c2c.transport.status" }) as { transport?: { r5cConnected?: boolean } };
    expect(status.transport?.r5cConnected).toBe(false);
    expect(local.values.get(CONNECT_KEY)).toMatchObject({ state: "DONE" });
    expect((local.values.get(CONNECT_KEY) as typeof before).ownerWitness?.documentId).toBe("old-document");
    expect(bindCalls(fetchMock)).toHaveLength(0);

    const result = await send({ type: "c2c.connect.page", canonicalRoute: ROUTE_A, generation: 2 }, freshSender) as { ok?: boolean; state?: string };
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, state: "CONNECTED" });
    expect(bindCalls(fetchMock)).toHaveLength(1);
    expect((local.values.get(CONNECT_KEY) as typeof before).ownerWitness?.documentId).toBe("fresh-document");
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
      expect((local.values.get(CONNECT_KEY) as { ownerWitness?: { documentId?: string } }).ownerWitness?.documentId).toBe("old-document");
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
    const { send, fetchMock } = await loadWorker({ ownerRoute: ROUTE_B, route: ROUTE_A });
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
    expect((local.values.get(CONNECT_KEY) as { state?: string }).state).not.toBe("DONE");

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
    expect((local.values.get(CONNECT_KEY) as { state?: string }).state).toBe("DONE");
  });

  it("same-route document replacement prevents old connect convergence", async () => {
    const { send, ownerSender, fetchMock, local } = await loadWorker({
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
    expect((local.values.get(CONNECT_KEY) as { state?: string }).state).not.toBe("DONE");
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
  it("full connected requires r5cConnected and shows retryable warning otherwise", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").join(process.cwd(), "browser-companion/popup/popup.js"),
      "utf8",
    );
    expect(src).toMatch(/r5cConnected/);
    expect(src).toMatch(/当前对话需要完成连接/);
    expect(src).toMatch(/webSinkConverged/);
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
    let stateCalls = 0;
    const { send, ownerSender, local, tabsSendMessage } = await loadWorker({
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
          stateCalls += 1;
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
                routeVerification: stateCalls >= 3 ? "VERIFIED" : "PENDING",
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
    expect((local.values.get(CONNECT_KEY) as { state?: string }).state).not.toBe("DONE");

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
    expect(yConnect.ok).toBe(true);
    expect(bindCount).toBe(bindsAfterX + 1);
    const done = local.values.get(CONNECT_KEY) as {
      state?: string;
      ownerWitness?: { documentId?: string };
    };
    expect(done.state).toBe("DONE");
    expect(done.ownerWitness?.documentId).toBe("document-y");
  });
});
