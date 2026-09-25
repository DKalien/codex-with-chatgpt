import { afterEach, describe, expect, it, vi } from "vitest";

const ROUTE = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const OLD_ROUTE = "https://chatgpt.com/c/77777777-7777-4777-8777-777777777777";
const WORKSPACE = "workspace-g4-rebind";
const OLD_COMPANION = "11111111-1111-4111-8111-111111111111";
const OLD_BINDING = "22222222-2222-4222-8222-222222222222";
const NEW_COMPANION = "33333333-3333-4333-8333-333333333333";
const NEW_BINDING = "44444444-4444-4444-8444-444444444444";
const CHALLENGE = "55555555-5555-4555-8555-555555555555";
const OLD_EPOCH = 7;

const LOCAL_KEY = "c2c_companion_local_v1";
const TRANSPORT_KEY = "c2c_companion_transport_v1";
const FENCE_KEY = "c2c_route_attest_fence_v1";
const OWNER_KEY = "c2c_companion_owner_v1";
const REGISTRY_KEY = "c2c_companion_registry_v1";
const EVIDENCE_KEY = "c2c_companion_evidence_v1";
const CONNECT_KEY = "c2c_companion_connect_flow_v1";
const AUTONOMY_KEY = "c2c_companion_autonomy_v1";

function storageArea(initial: Record<string, unknown>, failAutonomyPersist = false, failArmedAutonomyPersist = false) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async get(keys?: string | string[]) {
      if (keys == null) return Object.fromEntries(values);
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.map(key => [key, values.get(key)]));
    },
    async set(row: Record<string, unknown>) {
      if (failAutonomyPersist && Object.hasOwn(row, AUTONOMY_KEY)) {
        throw new Error("autonomy storage unavailable");
      }
      if (failArmedAutonomyPersist && (row[AUTONOMY_KEY] as { mode?: string } | undefined)?.mode === "armed") {
        throw new Error("armed autonomy storage unavailable");
      }
      for (const [key, value] of Object.entries(row)) values.set(key, value);
    },
    async remove(keys: string | string[]) {
      for (const key of (Array.isArray(keys) ? keys : [keys])) values.delete(key);
    },
    async setAccessLevel() {},
  };
}

function responseBody(overrides: Record<string, unknown> = {}) {
  const routeAttestation = {
    challengeId: CHALLENGE,
    challengeDigest: "a".repeat(64),
    expiresAt: "2099-01-01T00:00:00.000Z",
    message: `[C2C_ROUTE_ATTEST]\nchallengeId=${CHALLENGE}`,
  };
  return {
    workspaceId: WORKSPACE,
    companionId: NEW_COMPANION,
    bindingId: NEW_BINDING,
    epoch: OLD_EPOCH + 1,
    routeCanonical: ROUTE,
    routeVerification: "PENDING",
    routeAttestation,
    ...overrides,
  };
}

function initialState() {
  const owner = {
    tabId: 7,
    documentId: "document-g4-rebind",
    canonicalRoute: ROUTE,
    generation: 1,
    lastSeen: Date.now(),
  };
  const transport = {
    schemaVersion: 1,
    bridgeOrigin: "https://bridge.example.test",
    workspaceId: WORKSPACE,
    companionId: OLD_COMPANION,
    bindingId: OLD_BINDING,
    epoch: OLD_EPOCH,
    routeCanonical: ROUTE,
    pairedAt: "2026-09-19T00:00:00.000Z",
    credential: "old-companion-credential",
    authStale: false,
    routeVerification: "PENDING",
    routeAttestationMessage: null,
    routeAttestationExpiresAt: null,
  };
  return {
    local: {
      [LOCAL_KEY]: { schemaVersion: 1, targetRoute: ROUTE, paired: true },
      [TRANSPORT_KEY]: transport,
    },
    session: {
      [OWNER_KEY]: owner,
      [REGISTRY_KEY]: [owner],
      [EVIDENCE_KEY]: null,
    },
    transport,
  };
}

async function loadWorker(body: Record<string, unknown>, opts: {
  oldRoute?: string;
  noTransport?: boolean;
  transport?: Record<string, unknown>;
  connectFlow?: Record<string, unknown>;
  routeFence?: Record<string, unknown>;
  failAutonomyPersist?: boolean;
  failArmedAutonomyPersist?: boolean;
  autonomyPolicy?: Record<string, unknown>;
  fetch?: (url: unknown, init?: unknown) => Promise<unknown>;
  tabsSendMessage?: (tabId: number, message: Record<string, unknown>) => Promise<unknown>;
} = {}) {
  const initial = initialState();
  if (opts.oldRoute) {
    initial.transport.routeCanonical = opts.oldRoute;
    initial.local[LOCAL_KEY] = { schemaVersion: 1, targetRoute: opts.oldRoute, paired: true };
  }
  if (opts.noTransport) {
    delete initial.local[TRANSPORT_KEY];
  }
  if (opts.transport) {
    initial.transport = { ...initial.transport, ...opts.transport };
    initial.local[TRANSPORT_KEY] = initial.transport;
  }
  if (opts.connectFlow) initial.local[CONNECT_KEY] = opts.connectFlow;
  if (opts.routeFence) initial.local[FENCE_KEY] = opts.routeFence;
  if (opts.autonomyPolicy) initial.local[AUTONOMY_KEY] = opts.autonomyPolicy;
  const local = storageArea(
    initial.local,
    opts.failAutonomyPersist === true,
    opts.failArmedAutonomyPersist === true,
  );
  const session = storageArea(initial.session);
  let messageListener: ((message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => unknown) | null = null;
  const tabsSendMessage = vi.fn(opts.tabsSendMessage ?? (async () => ({ ok: true })));
  const fetchMock = vi.fn(opts.fetch ?? (async () => ({
    ok: true,
    status: 200,
    async json() { return body; },
  })));
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
  const ownerSender = { tab: { id: 7 }, documentId: "document-g4-rebind", frameId: 0, url: ROUTE };
  const proof = await send({ type: "c2c.owner-proof.request", href: ROUTE, canonicalRoute: ROUTE, generation: 1 }, ownerSender) as {
    ok: boolean;
    proof?: { id: string };
  };
  if (!proof.ok || !proof.proof) throw new Error(`owner proof setup failed: ${JSON.stringify(proof)}`);
  return { initial, local, session, fetchMock, tabsSendMessage, send, proofId: proof.proof.id };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("G4c one-click connect orchestration", () => {
  function jsonResponse(status: number, body: Record<string, unknown>) {
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return body; },
    };
  }

  function completedBody(overrides: Record<string, unknown> = {}) {
    return {
      workspaceId: WORKSPACE,
      companionId: NEW_COMPANION,
      bindingId: NEW_BINDING,
      epoch: OLD_EPOCH + 1,
      routeCanonical: ROUTE,
      routeVerification: "VERIFIED",
      challengeId: CHALLENGE,
      credential: "c2c_comp_fresh-companion-credential",
      ...overrides,
    };
  }

  function verifiedState(overrides: Record<string, unknown> = {}) {
    return {
      workspaceId: WORKSPACE,
      companionId: NEW_COMPANION,
      bindingId: NEW_BINDING,
      epoch: OLD_EPOCH + 1,
      routeCanonical: ROUTE,
      routeVerification: "VERIFIED",
      productionEligible: true,
      enabled: true,
      pendingReady: 0,
      reserved: 0,
      claimed: 0,
      outcomeUnknown: 0,
      inFlight: null,
      events: [],
      ...overrides,
    };
  }

  it.each([false, true])(
    "binds the real sender, then heartbeat completes once (rearm persist failure=%s)",
    async (failRearmPersistence) => {
    const urls: string[] = [];
    const worker = await loadWorker(responseBody(), {
      oldRoute: OLD_ROUTE,
      failArmedAutonomyPersist: failRearmPersistence,
      autonomyPolicy: {
        mode: "armed",
        bindingId: OLD_BINDING,
        epoch: OLD_EPOCH,
        routeCanonical: OLD_ROUTE,
        armedAt: 100,
        lastProductionAttemptAt: 123456,
        rearmOnConnect: true,
      },
      tabsSendMessage: async (_tabId, message) => message.type === "c2c.route.attest.execute"
        ? { ok: true, observed: true, mutationAttempted: true, clickAttempted: true }
        : { ok: true },
      fetch: async (url) => {
        const value = String(url);
        urls.push(value);
        if (value.includes("/rebind/init")) return jsonResponse(200, responseBody());
        if (value.includes("/rebind/status")) return jsonResponse(200, {
          workspaceId: WORKSPACE,
          companionId: NEW_COMPANION,
          bindingId: NEW_BINDING,
          epoch: OLD_EPOCH + 1,
          routeCanonical: ROUTE,
          challengeId: CHALLENGE,
          state: "CONFIRMED",
        });
        if (value.includes("/rebind/complete")) return jsonResponse(200, completedBody());
        if (value.endsWith("/state")) {
          const completed = urls.some(item => item.includes("/rebind/complete"));
          return completed
            ? jsonResponse(200, verifiedState())
            : jsonResponse(401, { error: "COMPANION_EPOCH_STALE" });
        }
        throw new Error(`unexpected URL ${value}`);
      },
    });
    const sender = { tab: { id: 7 }, documentId: "document-g4-rebind", frameId: 0, url: ROUTE };
    const safety = { composer: "empty", generation: "idle", safe: true };
    const connected = await worker.send({ type: "c2c.connect.page", generation: 1, safety, canonicalRoute: ROUTE }, sender) as {
      ok: boolean; state?: string;
    };
    expect(connected).toMatchObject({ ok: true, state: "AWAITING_CONFIRMATION" });
    expect(worker.local.values.get(AUTONOMY_KEY)).toMatchObject({
      mode: "off",
      rearmOnConnect: true,
      bindingId: null,
      epoch: null,
      routeCanonical: null,
    });
    expect(worker.tabsSendMessage).toHaveBeenCalledTimes(1);
    expect(urls.filter(url => url.includes("/rebind/init"))).toHaveLength(1);
    const duplicate = await worker.send({
      type: "c2c.connect.page", generation: 1, safety, canonicalRoute: ROUTE,
    }, sender) as Record<string, unknown>;
    expect(duplicate).toMatchObject({ ok: false, reason: "connect_active", retryAllowed: false });
    expect(urls.filter(url => url.includes("/rebind/init"))).toHaveLength(1);
    expect(worker.tabsSendMessage).toHaveBeenCalledTimes(1);

    await worker.send({ type: "c2c.heartbeat", generation: 1, safety, canonicalRoute: ROUTE }, sender);
    await worker.send({ type: "c2c.heartbeat", generation: 1, safety, canonicalRoute: ROUTE }, sender);
    expect(urls.filter(url => url.includes("/rebind/complete"))).toHaveLength(1);
    expect(worker.tabsSendMessage).toHaveBeenCalledTimes(1);
    expect(worker.local.values.get(TRANSPORT_KEY)).toMatchObject({
      credential: "c2c_comp_fresh-companion-credential",
      routeVerification: "VERIFIED",
      rebindPending: false,
    });
    expect(worker.local.values.get(CONNECT_KEY)).toMatchObject({ state: "DONE", challengeId: CHALLENGE });
    expect(worker.local.values.get(AUTONOMY_KEY)).toMatchObject(failRearmPersistence
      ? { mode: "off", rearmOnConnect: true, bindingId: null, epoch: null, routeCanonical: null }
      : {
          mode: "armed",
          bindingId: NEW_BINDING,
          epoch: OLD_EPOCH + 1,
          routeCanonical: ROUTE,
          rearmOnConnect: true,
          lastProductionAttemptAt: 123456,
        });
    if (!failRearmPersistence) {
      expect((worker.local.values.get(AUTONOMY_KEY) as { armedAt: number }).armedAt).toBeGreaterThan(100);
    }
    const status = await worker.send({
      type: "c2c.status.page", href: ROUTE, canonicalRoute: ROUTE, generation: 1, safety,
    }, sender) as Record<string, any>;
    expect(status.connectState).toBe("DONE");
    expect(status.autonomy.mode).toBe(failRearmPersistence ? "off" : "armed");
    expect(status.autonomy.rearmOnConnect).toBe(true);
    if (failRearmPersistence) {
      expect(status.autonomy.lastReason).toBe("autonomy_rearm_persist_failed");
    }
  });

  it("A. NOT_SUCCESSOR binds the new page and sends one fixed bootstrap instead of cold-pairing", async () => {
    const worker = await loadWorker(responseBody(), {
      oldRoute: OLD_ROUTE,
      transport: { routeVerification: "VERIFIED" },
      fetch: async (url) => String(url).includes("/rebind/init")
        ? jsonResponse(409, { error: "COMPANION_REBIND_NOT_SUCCESSOR" })
        : Promise.reject(new Error(`unexpected URL ${String(url)}`)),
      tabsSendMessage: async (_tabId, message) => ({
        type: "c2c.feedback.bootstrap.result",
        mode: "feedback_bootstrap_send",
        ok: true,
        mutationAttempted: true,
        clickAttempted: true,
        clicked: true,
        observed: true,
        canonicalRoute: ROUTE,
        generation: 1,
      }),
    });
    const sender = { tab: { id: 7 }, documentId: "document-g4-rebind", frameId: 0, url: ROUTE };
    const result = await worker.send({
      type: "c2c.connect.page",
      generation: 1,
      safety: { composer: "empty", generation: "idle", safe: true },
      tabId: 999,
      documentId: "caller-document",
      canonicalRoute: ROUTE,
      href: OLD_ROUTE,
      targetRoute: OLD_ROUTE,
      frameId: 2,
      lastSeen: -1,
    }, sender) as Record<string, any>;

    expect(result).toMatchObject({ ok: true, state: "WAITING_TAKEOVER" });
    expect(result.reason).not.toBe("cold_pair_required");
    expect(worker.session.values.get(OWNER_KEY)).toMatchObject({
      tabId: 7, documentId: "document-g4-rebind", canonicalRoute: ROUTE, generation: 1,
    });
    expect(worker.session.values.get(OWNER_KEY)).not.toHaveProperty("frameId");
    expect(worker.local.values.get(LOCAL_KEY)).toMatchObject({ targetRoute: ROUTE });
    expect(worker.local.values.get(CONNECT_KEY)).toMatchObject({ state: "WAITING_TAKEOVER", challengeId: null });
    expect(worker.tabsSendMessage).toHaveBeenCalledTimes(1);
    expect(worker.tabsSendMessage.mock.calls[0][1]).toEqual({
      type: "c2c.feedback.bootstrap.execute",
      expectedRoute: ROUTE,
      expectedGeneration: 1,
    });
    expect(worker.fetchMock.mock.calls.filter(([url]) => String(url).includes("/rebind/init"))).toHaveLength(1);
  });

  it("explicit Bind derives the same identity from MessageSender and ignores caller identity fields", async () => {
    const worker = await loadWorker(responseBody());
    const sender = {
      tab: { id: 17 }, documentId: "actual-document", frameId: 0, url: ROUTE,
    };
    await worker.send({
      type: "c2c.bind",
      generation: 8,
      tabId: 999,
      documentId: "caller-document",
      canonicalRoute: ROUTE,
      href: OLD_ROUTE,
      targetRoute: OLD_ROUTE,
      frameId: 2,
      lastSeen: -1,
    }, sender);
    expect(worker.session.values.get(OWNER_KEY)).toMatchObject({
      tabId: 17, documentId: "actual-document", canonicalRoute: ROUTE, generation: 8,
    });
    expect(worker.session.values.get(OWNER_KEY)).not.toHaveProperty("frameId");
    expect(worker.local.values.get(LOCAL_KEY)).toMatchObject({ targetRoute: ROUTE });
  });

  it("proven no-mutation bootstrap failure stays retryable only on a later explicit Connect", async () => {
    let dispatches = 0;
    const worker = await loadWorker(responseBody(), {
      oldRoute: OLD_ROUTE,
      transport: { routeVerification: "VERIFIED" },
      fetch: async (url) => String(url).includes("/rebind/init")
        ? jsonResponse(409, { error: "COMPANION_REBIND_NOT_SUCCESSOR" })
        : Promise.reject(new Error(`unexpected URL ${String(url)}`)),
      tabsSendMessage: async () => {
        dispatches += 1;
        if (dispatches === 1) {
          return {
            type: "c2c.feedback.bootstrap.result",
            mode: "feedback_bootstrap_send",
            ok: false,
            reason: "bootstrap_sender_invalid",
            mutationAttempted: false,
            clickAttempted: false,
            observed: false,
            canonicalRoute: ROUTE,
            generation: 1,
          };
        }
        return {
          type: "c2c.feedback.bootstrap.result",
          mode: "feedback_bootstrap_send",
          ok: true,
          mutationAttempted: true,
          clickAttempted: true,
          clicked: true,
          observed: true,
          canonicalRoute: ROUTE,
          generation: 1,
        };
      },
    });
    const sender = { tab: { id: 7 }, documentId: "document-g4-rebind", frameId: 0, url: ROUTE };
    const message = {
      type: "c2c.connect.page",
      generation: 1,
      canonicalRoute: ROUTE,
      safety: { composer: "empty", generation: "idle", safe: true },
    };

    const failed = await worker.send(message, sender) as Record<string, unknown>;
    expect(failed).toMatchObject({ ok: false, reason: "bootstrap_sender_invalid", retryAllowed: true });
    expect(worker.tabsSendMessage).toHaveBeenCalledTimes(1);
    expect(worker.local.values.get(CONNECT_KEY)).toMatchObject({ state: "NONE" });

    const retried = await worker.send(message, sender) as Record<string, unknown>;
    expect(retried).toMatchObject({ ok: true, state: "WAITING_TAKEOVER" });
    expect(worker.tabsSendMessage).toHaveBeenCalledTimes(2);
  });

  it("C. repeated exact-owner heartbeat waits for takeover without resending bootstrap", async () => {
    const worker = await loadWorker(responseBody(), {
      oldRoute: OLD_ROUTE,
      fetch: async (url) => String(url).includes("/rebind/init")
        ? jsonResponse(409, { error: "COMPANION_REBIND_NOT_SUCCESSOR" })
        : Promise.reject(new Error(`unexpected URL ${String(url)}`)),
      tabsSendMessage: async () => ({
        type: "c2c.feedback.bootstrap.result", mode: "feedback_bootstrap_send", ok: true,
        mutationAttempted: true, clickAttempted: true, clicked: true, observed: true,
        canonicalRoute: ROUTE, generation: 1,
      }),
    });
    const sender = { tab: { id: 7 }, documentId: "document-g4-rebind", frameId: 0, url: ROUTE };
    const safety = { composer: "empty", generation: "idle", safe: true };
    await worker.send({ type: "c2c.connect.page", generation: 1, safety, canonicalRoute: ROUTE }, sender);
    await worker.send({
      type: "c2c.heartbeat", generation: 1, safety, canonicalRoute: ROUTE, feedbackBootstrapToolMissing: true,
    }, sender);
    await worker.send({ type: "c2c.heartbeat", generation: 1, safety, canonicalRoute: ROUTE }, sender);
    expect(worker.tabsSendMessage).toHaveBeenCalledTimes(1);
    expect(worker.fetchMock.mock.calls.filter(([url]) => String(url).includes("/rebind/init"))).toHaveLength(3);
    expect(worker.local.values.get(CONNECT_KEY)).toMatchObject({ state: "WAITING_TAKEOVER" });
    const status = await worker.send({ type: "c2c.status.page", href: ROUTE, canonicalRoute: ROUTE, generation: 1 }, sender) as Record<string, unknown>;
    expect(status.connectReason).toBe("bootstrap_tool_missing");
  });

  it("G. a blocked takeover remains waiting and never pairs or sends a second bootstrap", async () => {
    let rebindCalls = 0;
    const worker = await loadWorker(responseBody(), {
      oldRoute: OLD_ROUTE,
      fetch: async (url) => {
        if (!String(url).includes("/rebind/init")) throw new Error(`unexpected URL ${String(url)}`);
        rebindCalls += 1;
        return rebindCalls === 1
          ? jsonResponse(409, { error: "COMPANION_REBIND_NOT_SUCCESSOR" })
          : jsonResponse(409, { error: "COMPANION_REPAIR_BLOCKED" });
      },
      tabsSendMessage: async () => ({
        type: "c2c.feedback.bootstrap.result", mode: "feedback_bootstrap_send", ok: true,
        mutationAttempted: true, clickAttempted: true, clicked: true, observed: true,
        canonicalRoute: ROUTE, generation: 1,
      }),
    });
    const sender = { tab: { id: 7 }, documentId: "document-g4-rebind", frameId: 0, url: ROUTE };
    const safety = { composer: "empty", generation: "idle", safe: true };
    await worker.send({ type: "c2c.connect.page", generation: 1, safety, canonicalRoute: ROUTE }, sender);
    await worker.send({ type: "c2c.heartbeat", generation: 1, safety, canonicalRoute: ROUTE }, sender);
    expect(worker.local.values.get(CONNECT_KEY)).toMatchObject({ state: "WAITING_TAKEOVER" });
    expect(worker.tabsSendMessage).toHaveBeenCalledTimes(1);
    expect(rebindCalls).toBe(2);
  });

  it.each([true, false])(
    "D/E. heartbeat resumes after takeover, attests once, verifies, and honors rearm preference=%s",
    async (rearmOnConnect) => {
    let takeoverDone = false;
    const urls: string[] = [];
    const worker = await loadWorker(responseBody(), {
      oldRoute: OLD_ROUTE,
      autonomyPolicy: rearmOnConnect
        ? {
            mode: "armed", bindingId: OLD_BINDING, epoch: OLD_EPOCH,
            routeCanonical: OLD_ROUTE, armedAt: 100, rearmOnConnect: true,
          }
        : { mode: "off", rearmOnConnect: false },
      fetch: async (url) => {
        const value = String(url);
        urls.push(value);
        if (value.includes("/rebind/init")) {
          return takeoverDone
            ? jsonResponse(200, responseBody())
            : jsonResponse(409, { error: "COMPANION_REBIND_NOT_SUCCESSOR" });
        }
        if (value.includes("/rebind/status")) return jsonResponse(200, {
          workspaceId: WORKSPACE, companionId: NEW_COMPANION, bindingId: NEW_BINDING,
          epoch: OLD_EPOCH + 1, routeCanonical: ROUTE, challengeId: CHALLENGE, state: "CONFIRMED",
        });
        if (value.includes("/rebind/complete")) return jsonResponse(200, completedBody());
        if (value.endsWith("/state")) return urls.some(item => item.includes("/rebind/complete"))
          ? jsonResponse(200, verifiedState())
          : jsonResponse(401, { error: "COMPANION_EPOCH_STALE" });
        throw new Error(`unexpected URL ${value}`);
      },
      tabsSendMessage: async (_tabId, message) => message.type === "c2c.feedback.bootstrap.execute"
        ? {
            type: "c2c.feedback.bootstrap.result", mode: "feedback_bootstrap_send", ok: true,
            mutationAttempted: true, clickAttempted: true, clicked: true, observed: true,
            canonicalRoute: ROUTE, generation: 1,
          }
        : { ok: true, observed: true, mutationAttempted: true, clickAttempted: true },
    });
    const sender = { tab: { id: 7 }, documentId: "document-g4-rebind", frameId: 0, url: ROUTE };
    const safety = { composer: "empty", generation: "idle", safe: true };
    await worker.send({ type: "c2c.connect.page", generation: 1, safety, canonicalRoute: ROUTE }, sender);
    await worker.send({ type: "c2c.heartbeat", generation: 1, safety, canonicalRoute: ROUTE }, sender);
    expect(worker.tabsSendMessage.mock.calls.filter(([, message]) => message.type === "c2c.feedback.bootstrap.execute")).toHaveLength(1);

    takeoverDone = true;
    await worker.send({ type: "c2c.heartbeat", generation: 1, safety, canonicalRoute: ROUTE }, sender);
    expect(worker.tabsSendMessage.mock.calls.filter(([, message]) => message.type === "c2c.route.attest.execute")).toHaveLength(1);
    await worker.send({ type: "c2c.heartbeat", generation: 1, safety, canonicalRoute: ROUTE }, sender);
    expect(worker.local.values.get(CONNECT_KEY)).toMatchObject({ state: "DONE", bootstrapAutoResume: false });
    expect(worker.local.values.get(TRANSPORT_KEY)).toMatchObject({ routeVerification: "VERIFIED", rebindPending: false });
    expect(worker.local.values.get(AUTONOMY_KEY)).toMatchObject(rearmOnConnect
      ? {
          mode: "armed", bindingId: NEW_BINDING, epoch: OLD_EPOCH + 1,
          routeCanonical: ROUTE, rearmOnConnect: true,
        }
      : { mode: "off", rearmOnConnect: false });
    if (rearmOnConnect) {
      expect((worker.local.values.get(AUTONOMY_KEY) as { armedAt: number }).armedAt).toBeGreaterThan(100);
    }
    expect(urls.filter(url => url.includes("/rebind/complete"))).toHaveLength(1);
    if (!rearmOnConnect) expect((await worker.send({ type: "c2c.autonomy.arm" }, {})).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("F. a durable bootstrap dispatch fence survives restart without a second DOM send", async () => {
    const worker = await loadWorker(responseBody(), {
      oldRoute: OLD_ROUTE,
      connectFlow: {
        state: "TAKEOVER_DISPATCH", workspaceId: WORKSPACE, bindingId: OLD_BINDING,
        epoch: OLD_EPOCH, companionId: OLD_COMPANION, routeCanonical: ROUTE,
        challengeId: null, updatedAt: Date.now(),
      },
      fetch: async () => { throw new Error("durable dispatch must not retry /rebind/init"); },
      tabsSendMessage: async () => { throw new Error("durable dispatch must not resend bootstrap"); },
    });
    const sender = { tab: { id: 7 }, documentId: "document-g4-rebind", frameId: 0, url: ROUTE };
    const result = await worker.send({
      type: "c2c.connect.page", generation: 1,
      canonicalRoute: ROUTE,
      safety: { composer: "empty", generation: "idle", safe: true },
    }, sender);
    expect(result).toMatchObject({ ok: false, reason: "connect_outcome_unknown", state: "OUTCOME_UNKNOWN" });
    expect(worker.fetchMock).not.toHaveBeenCalled();
    expect(worker.tabsSendMessage).not.toHaveBeenCalled();
  });

  it("hydration disarms a changed identity but retains the explicit rearm preference", async () => {
    const worker = await loadWorker(responseBody(), {
      autonomyPolicy: {
        mode: "armed",
        bindingId: "99999999-9999-4999-8999-999999999999",
        epoch: OLD_EPOCH,
        routeCanonical: ROUTE,
        armedAt: 100,
        lastProductionAttemptAt: 123456,
        rearmOnConnect: true,
      },
    });
    expect(worker.local.values.get(AUTONOMY_KEY)).toMatchObject({
      mode: "off",
      bindingId: null,
      epoch: null,
      routeCanonical: null,
      rearmOnConnect: true,
      lastProductionAttemptAt: 123456,
    });
  });

  it("successful explicit Arm saves the rearm-on-connect preference", async () => {
    const worker = await loadWorker(verifiedState({
      companionId: OLD_COMPANION,
      bindingId: OLD_BINDING,
      epoch: OLD_EPOCH,
    }), { transport: { routeVerification: "VERIFIED" } });
    const result = await worker.send({ type: "c2c.autonomy.arm" }, {}) as Record<string, any>;
    expect(result).toMatchObject({ ok: true, mode: "armed", policy: { rearmOnConnect: true } });
  });

  it("a route with no saved preference stays OFF after Connect", async () => {
    const worker = await loadWorker(verifiedState({
      companionId: OLD_COMPANION,
      bindingId: OLD_BINDING,
      epoch: OLD_EPOCH,
    }), { transport: { routeVerification: "VERIFIED" } });
    const sender = { tab: { id: 7 }, documentId: "document-g4-rebind", frameId: 0, url: ROUTE };
    const result = await worker.send({
      type: "c2c.connect.page",
      generation: 1,
      canonicalRoute: ROUTE,
      safety: { composer: "empty", generation: "idle", safe: true },
    }, sender);
    expect(result).toMatchObject({ ok: true, state: "CONNECTED", autonomy: "off" });
    expect(worker.local.values.get(AUTONOMY_KEY)).toMatchObject({ mode: "off", rearmOnConnect: false });
    expect(worker.tabsSendMessage).not.toHaveBeenCalled();
  });

  it("manual disable clears the preference and Connect does not rearm it", async () => {
    const worker = await loadWorker(verifiedState({
      companionId: OLD_COMPANION,
      bindingId: OLD_BINDING,
      epoch: OLD_EPOCH,
    }), {
      transport: { routeVerification: "VERIFIED" },
      autonomyPolicy: {
        mode: "armed",
        bindingId: OLD_BINDING,
        epoch: OLD_EPOCH,
        routeCanonical: ROUTE,
        armedAt: 100,
        rearmOnConnect: true,
      },
    });
    expect(await worker.send({ type: "c2c.autonomy.disable" }, {})).toMatchObject({ ok: true, mode: "off" });
    expect(worker.local.values.get(AUTONOMY_KEY)).toMatchObject({ mode: "off", rearmOnConnect: false });
    const sender = { tab: { id: 7 }, documentId: "document-g4-rebind", frameId: 0, url: ROUTE };
    const result = await worker.send({
      type: "c2c.connect.page",
      generation: 1,
      canonicalRoute: ROUTE,
      safety: { composer: "empty", generation: "idle", safe: true },
    }, sender);
    expect(result).toMatchObject({ ok: true, state: "CONNECTED", autonomy: "off" });
    expect(worker.local.values.get(AUTONOMY_KEY)).toMatchObject({ mode: "off", rearmOnConnect: false });
  });

  it("explicit unbind clears the auto-rearm preference", async () => {
    const worker = await loadWorker(responseBody(), {
      autonomyPolicy: {
        mode: "armed",
        bindingId: OLD_BINDING,
        epoch: OLD_EPOCH,
        routeCanonical: ROUTE,
        armedAt: 100,
        rearmOnConnect: true,
      },
    });

    await worker.send({ type: "c2c.unbind" });

    expect(worker.local.values.get(AUTONOMY_KEY)).toMatchObject({ mode: "off", rearmOnConnect: false });
  });

  it("explicit transport clear clears the auto-rearm preference", async () => {
    const worker = await loadWorker(responseBody(), {
      autonomyPolicy: {
        mode: "armed",
        bindingId: OLD_BINDING,
        epoch: OLD_EPOCH,
        routeCanonical: ROUTE,
        armedAt: 100,
        rearmOnConnect: true,
      },
    });

    expect(await worker.send({ type: "c2c.transport.clear" })).toMatchObject({ ok: true });
    expect(worker.local.values.get(AUTONOMY_KEY)).toMatchObject({ mode: "off", rearmOnConnect: false });
  });

  it("holds the mutation gate across route attestation RPC and persistence", async () => {
    let releaseAttestation!: (value: unknown) => void;
    const pendingAttestation = new Promise(resolve => { releaseAttestation = resolve; });
    const worker = await loadWorker(responseBody(), {
      oldRoute: OLD_ROUTE,
      tabsSendMessage: async () => pendingAttestation,
      fetch: async (url) => {
        const value = String(url);
        if (value.includes("/rebind/init")) return jsonResponse(200, responseBody());
        if (value.endsWith("/state")) return jsonResponse(401, { error: "COMPANION_EPOCH_STALE" });
        throw new Error(`unexpected URL ${value}`);
      },
    });
    const sender = { tab: { id: 7 }, documentId: "document-g4-rebind", frameId: 0, url: ROUTE };
    const connect = worker.send({
      type: "c2c.connect.page",
      generation: 1,
      canonicalRoute: ROUTE,
      safety: { composer: "empty", generation: "idle", safe: true },
    }, sender);
    await vi.waitFor(() => expect(worker.tabsSendMessage).toHaveBeenCalledTimes(1));

    expect(await worker.send({
      type: "c2c.pair",
      bridgeOrigin: "https://bridge.example.test",
      intentId: "intent",
      secret: "secret",
      ownerProofId: "unused",
    })).toMatchObject({ reason: "transport_mutation_in_flight" });
    expect(await worker.send({ type: "c2c.transport.clear" })).toMatchObject({
      reason: "transport_mutation_in_flight",
    });

    releaseAttestation({
      ok: true,
      observed: true,
      mutationAttempted: true,
      clickAttempted: true,
    });
    expect(await connect).toMatchObject({ ok: true, state: "AWAITING_CONFIRMATION" });
  });

  it("fails closed when Connect cannot durably persist Autonomy OFF", async () => {
    const worker = await loadWorker(responseBody(), {
      transport: { routeVerification: "VERIFIED" },
      failAutonomyPersist: true,
      autonomyPolicy: {
        mode: "armed",
        bindingId: OLD_BINDING,
        epoch: OLD_EPOCH,
        routeCanonical: ROUTE,
        armedAt: Date.now(),
      },
    });
    const sender = { tab: { id: 7 }, documentId: "document-g4-rebind", frameId: 0, url: ROUTE };
    const result = await worker.send({
      type: "c2c.connect.page",
      generation: 1,
      canonicalRoute: ROUTE,
      safety: { composer: "empty", generation: "idle", safe: true },
    }, sender);
    expect(result).toMatchObject({ ok: false, reason: "autonomy_persist_failed", autonomy: "off" });
    expect(worker.tabsSendMessage).not.toHaveBeenCalled();
    expect(worker.local.values.get(CONNECT_KEY)).toBeUndefined();
  });

  it("rolls back a proven pre-dispatch attestation failure for a later explicit Connect", async () => {
    const worker = await loadWorker(responseBody(), {
      oldRoute: OLD_ROUTE,
      tabsSendMessage: async () => ({ ok: true }),
      fetch: async (url) => String(url).includes("/rebind/init")
        ? {
            ok: true,
            status: 200,
            async json() { return responseBody(); },
          }
        : {
            ok: false,
            status: 401,
            async json() { return { error: "COMPANION_EPOCH_STALE" }; },
          },
    });
    const sender = { tab: { id: 7 }, documentId: "document-g4-rebind", frameId: 0, url: ROUTE };
    const unsafe = await worker.send({
      type: "c2c.connect.page",
      generation: 1,
      canonicalRoute: ROUTE,
      safety: { composer: "filled", generation: "idle", safe: false },
    }, sender) as Record<string, unknown>;
    expect(unsafe).toMatchObject({ ok: false, state: "NONE", retryAllowed: true });
    expect(worker.local.values.get(CONNECT_KEY)).toMatchObject({ state: "NONE" });
    expect(worker.tabsSendMessage).not.toHaveBeenCalled();

    await worker.send({
      type: "c2c.connect.page",
      generation: 1,
      canonicalRoute: ROUTE,
      safety: { composer: "empty", generation: "idle", safe: true },
    }, sender);
    expect(worker.tabsSendMessage).toHaveBeenCalledTimes(1);
  });

  it.each(["COMPANION_REPAIR_BLOCKED", "COMPANION_REBIND_NOT_CONFIRMED"])(
    "%s rolls completion back without same-heartbeat retry",
    async (errorCode) => {
      const urls: string[] = [];
      const worker = await loadWorker(responseBody(), {
        transport: {
          workspaceId: WORKSPACE,
          companionId: NEW_COMPANION,
          bindingId: NEW_BINDING,
          epoch: OLD_EPOCH + 1,
          routeCanonical: ROUTE,
          rebindPending: true,
          routeAttestationMessage: `[C2C_ROUTE_ATTEST]\nchallengeId=${CHALLENGE}`,
          routeAttestationExpiresAt: "2099-01-01T00:00:00.000Z",
        },
        connectFlow: {
          state: "ATTEST_REQUESTED",
          workspaceId: WORKSPACE,
          bindingId: NEW_BINDING,
          epoch: OLD_EPOCH + 1,
          companionId: NEW_COMPANION,
          routeCanonical: ROUTE,
          challengeId: CHALLENGE,
          updatedAt: Date.now(),
        },
        routeFence: {
          state: "OBSERVED_PENDING_CONFIRM",
          companionId: NEW_COMPANION,
          challengeId: CHALLENGE,
          routeCanonical: ROUTE,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        fetch: async (url) => {
          const value = String(url);
          urls.push(value);
          if (value.includes("/rebind/status")) {
            return {
              ok: true,
              status: 200,
              async json() {
                return {
                  workspaceId: WORKSPACE,
                  companionId: NEW_COMPANION,
                  bindingId: NEW_BINDING,
                  epoch: OLD_EPOCH + 1,
                  routeCanonical: ROUTE,
                  challengeId: CHALLENGE,
                  state: urls.filter(item => item.includes("/rebind/status")).length === 1
                    ? "CONFIRMED" : "PENDING",
                };
              },
            };
          }
          if (value.includes("/rebind/complete")) {
            return {
              ok: false,
              status: 409,
              async json() { return { error: errorCode }; },
            };
          }
          throw new Error(`unexpected URL ${value}`);
        },
      });
      const sender = { tab: { id: 7 }, documentId: "document-g4-rebind", frameId: 0, url: ROUTE };
      const heartbeat = {
        type: "c2c.heartbeat",
        generation: 1,
        canonicalRoute: ROUTE,
        safety: { composer: "empty", generation: "idle", safe: true },
      };
      await worker.send(heartbeat, sender);
      expect(worker.local.values.get(CONNECT_KEY)).toMatchObject({ state: "ATTEST_REQUESTED" });
      expect(urls.filter(item => item.includes("/rebind/complete"))).toHaveLength(1);
      await worker.send(heartbeat, sender);
      expect(urls.filter(item => item.includes("/rebind/complete"))).toHaveLength(1);
      expect(urls.filter(item => item.includes("/rebind/status"))).toHaveLength(2);
    },
  );

  it("is idempotent for exact VERIFIED state with zero route DOM Send", async () => {
    const worker = await loadWorker(responseBody(), {
      transport: { routeVerification: "VERIFIED" },
      autonomyPolicy: { mode: "off", rearmOnConnect: true },
      fetch: async (url) => String(url).endsWith("/state")
        ? jsonResponse(200, verifiedState({
            companionId: OLD_COMPANION,
            bindingId: OLD_BINDING,
            epoch: OLD_EPOCH,
          }))
        : Promise.reject(new Error(`unexpected URL ${String(url)}`)),
    });
    const sender = { tab: { id: 7 }, documentId: "document-g4-rebind", frameId: 0, url: ROUTE };
    const result = await worker.send({
      type: "c2c.connect.page",
      generation: 1,
      canonicalRoute: ROUTE,
      safety: { composer: "empty", generation: "idle", safe: true },
    }, sender);
    expect(result).toMatchObject({ ok: true, state: "CONNECTED", routeVerification: "VERIFIED" });
    expect(worker.local.values.get(AUTONOMY_KEY)).toMatchObject({
      mode: "armed",
      bindingId: OLD_BINDING,
      epoch: OLD_EPOCH,
      routeCanonical: ROUTE,
      rearmOnConnect: true,
    });
    expect(worker.tabsSendMessage).not.toHaveBeenCalled();
    expect(worker.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("connects a persisted VERIFIED Project slug transport through the bare page alias", async () => {
    const slug = "https://chatgpt.com/g/g-p-6aa296e634348191b441d56fdab23b7b-codex-with-chatgpt/c/6aae79f7-d174-83ec-a704-2e3e4c662b47";
    const bare = "https://chatgpt.com/g/g-p-6aa296e634348191b441d56fdab23b7b/c/6aae79f7-d174-83ec-a704-2e3e4c662b47";
    const worker = await loadWorker(responseBody({ routeCanonical: slug }), {
      oldRoute: slug,
      transport: { routeCanonical: slug, routeVerification: "VERIFIED" },
      fetch: async (url) => String(url).endsWith("/state")
        ? jsonResponse(200, verifiedState({ routeCanonical: slug, companionId: OLD_COMPANION, bindingId: OLD_BINDING, epoch: OLD_EPOCH }))
        : Promise.reject(new Error(`unexpected URL ${String(url)}`)),
    });
    const result = await worker.send({
      type: "c2c.connect.page",
      generation: 1,
      canonicalRoute: bare,
      safety: { composer: "empty", generation: "idle", safe: true },
    }, { tab: { id: 7 }, documentId: "document-g4-rebind", frameId: 0, url: bare });
    expect(result).toMatchObject({ ok: true, state: "CONNECTED", routeVerification: "VERIFIED" });
    expect(worker.fetchMock.mock.calls.some(([url]) => String(url).includes("/rebind/init"))).toBe(false);
    expect(worker.tabsSendMessage).not.toHaveBeenCalled();
    expect(worker.local.values.get(TRANSPORT_KEY)).toMatchObject({ routeCanonical: slug, bindingId: OLD_BINDING, epoch: OLD_EPOCH });
  });

  it("returns bounded cold_pair_required with no transport and rejects popup authority", async () => {
    const worker = await loadWorker(responseBody(), { noTransport: true });
    const sender = { tab: { id: 7 }, documentId: "document-g4-rebind", frameId: 0, url: ROUTE };
    const result = await worker.send({
      type: "c2c.connect.page",
      generation: 1,
      canonicalRoute: ROUTE,
      safety: { composer: "empty", generation: "idle", safe: true },
    }, sender);
    expect(result).toMatchObject({ ok: false, reason: "cold_pair_required" });
    expect(await worker.send({
      type: "c2c.connect.page",
      routeCanonical: ROUTE,
      tabId: 7,
      documentId: "document-g4-rebind",
    }, {})).toMatchObject({ ok: false, reason: "no_tab" });
    expect(worker.fetchMock).not.toHaveBeenCalled();
    expect(worker.tabsSendMessage).not.toHaveBeenCalled();
  });

  it("complete timeout becomes durable OUTCOME_UNKNOWN and heartbeat never retries", async () => {
    const urls: string[] = [];
    const worker = await loadWorker(responseBody(), {
      oldRoute: OLD_ROUTE,
      tabsSendMessage: async () => ({
        ok: true, observed: true, mutationAttempted: true, clickAttempted: true,
      }),
      fetch: async (url) => {
        const value = String(url);
        urls.push(value);
        if (value.includes("/rebind/init")) return jsonResponse(200, responseBody());
        if (value.includes("/rebind/status")) return jsonResponse(200, {
          workspaceId: WORKSPACE,
          companionId: NEW_COMPANION,
          bindingId: NEW_BINDING,
          epoch: OLD_EPOCH + 1,
          routeCanonical: ROUTE,
          challengeId: CHALLENGE,
          state: "CONFIRMED",
        });
        if (value.includes("/rebind/complete")) throw new Error("timeout");
        if (value.endsWith("/state")) return jsonResponse(401, { error: "COMPANION_EPOCH_STALE" });
        throw new Error(`unexpected URL ${value}`);
      },
    });
    const sender = { tab: { id: 7 }, documentId: "document-g4-rebind", frameId: 0, url: ROUTE };
    const safety = { composer: "empty", generation: "idle", safe: true };
    await worker.send({ type: "c2c.connect.page", generation: 1, safety, canonicalRoute: ROUTE }, sender);
    await worker.send({ type: "c2c.heartbeat", generation: 1, safety, canonicalRoute: ROUTE }, sender);
    await worker.send({ type: "c2c.heartbeat", generation: 1, safety, canonicalRoute: ROUTE }, sender);
    expect(urls.filter(url => url.includes("/rebind/complete"))).toHaveLength(1);
    expect(worker.local.values.get(CONNECT_KEY)).toMatchObject({ state: "OUTCOME_UNKNOWN" });
    expect(worker.local.values.get(TRANSPORT_KEY)).toMatchObject({ credential: "old-companion-credential" });
  });

  it("identity-mismatched complete 2xx becomes OUTCOME_UNKNOWN without credential switch", async () => {
    const urls: string[] = [];
    const worker = await loadWorker(responseBody(), {
      oldRoute: OLD_ROUTE,
      tabsSendMessage: async () => ({
        ok: true, observed: true, mutationAttempted: true, clickAttempted: true,
      }),
      fetch: async (url) => {
        const value = String(url);
        urls.push(value);
        if (value.includes("/rebind/init")) return jsonResponse(200, responseBody());
        if (value.includes("/rebind/status")) return jsonResponse(200, {
          workspaceId: WORKSPACE,
          companionId: NEW_COMPANION,
          bindingId: NEW_BINDING,
          epoch: OLD_EPOCH + 1,
          routeCanonical: ROUTE,
          challengeId: CHALLENGE,
          state: "CONFIRMED",
        });
        if (value.includes("/rebind/complete")) {
          return jsonResponse(200, completedBody({ challengeId: "66666666-6666-4666-8666-666666666666" }));
        }
        if (value.endsWith("/state")) return jsonResponse(401, { error: "COMPANION_EPOCH_STALE" });
        throw new Error(`unexpected URL ${value}`);
      },
    });
    const sender = { tab: { id: 7 }, documentId: "document-g4-rebind", frameId: 0, url: ROUTE };
    const safety = { composer: "empty", generation: "idle", safe: true };
    await worker.send({ type: "c2c.connect.page", generation: 1, safety, canonicalRoute: ROUTE }, sender);
    await worker.send({ type: "c2c.heartbeat", generation: 1, safety, canonicalRoute: ROUTE }, sender);
    await worker.send({ type: "c2c.heartbeat", generation: 1, safety, canonicalRoute: ROUTE }, sender);
    expect(urls.filter(url => url.includes("/rebind/complete"))).toHaveLength(1);
    expect(worker.local.values.get(CONNECT_KEY)).toMatchObject({ state: "OUTCOME_UNKNOWN" });
    expect(worker.local.values.get(TRANSPORT_KEY)).toMatchObject({ credential: "old-companion-credential" });
  });

  it.each(["ATTEST_REQUESTED", "COMPLETE_REQUESTED", "OUTCOME_UNKNOWN"])(
    "restart in %s never resends attestation or complete",
    async (state) => {
      const flow = {
        state,
        workspaceId: WORKSPACE,
        bindingId: NEW_BINDING,
        epoch: OLD_EPOCH + 1,
        companionId: NEW_COMPANION,
        routeCanonical: ROUTE,
        challengeId: CHALLENGE,
        updatedAt: Date.now(),
      };
      const worker = await loadWorker(responseBody(), {
        transport: {
          workspaceId: WORKSPACE,
          companionId: NEW_COMPANION,
          bindingId: NEW_BINDING,
          epoch: OLD_EPOCH + 1,
          routeCanonical: ROUTE,
          rebindPending: true,
          routeAttestationMessage: `[C2C_ROUTE_ATTEST]\nchallengeId=${CHALLENGE}`,
          routeAttestationExpiresAt: "2099-01-01T00:00:00.000Z",
        },
        connectFlow: flow,
        routeFence: {
          state: state === "ATTEST_REQUESTED" ? "ROUTE_ATTEST_DISPATCH" : "OBSERVED_PENDING_CONFIRM",
          companionId: NEW_COMPANION,
          challengeId: CHALLENGE,
          routeCanonical: ROUTE,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        fetch: async () => { throw new Error("restart fence must not fetch"); },
        tabsSendMessage: async () => { throw new Error("restart fence must not send"); },
      });
      const sender = { tab: { id: 7 }, documentId: "document-g4-rebind", frameId: 0, url: ROUTE };
      const safety = { composer: "empty", generation: "idle", safe: true };
      await worker.send({ type: "c2c.heartbeat", generation: 1, safety, canonicalRoute: ROUTE }, sender);
      expect(worker.fetchMock).not.toHaveBeenCalled();
      expect(worker.tabsSendMessage).not.toHaveBeenCalled();
      expect(worker.local.values.get(CONNECT_KEY)).toMatchObject({ state });
    },
  );

  it("restart after durable DONE only polls state and converges VERIFIED", async () => {
    const urls: string[] = [];
    const flow = {
      state: "DONE",
      workspaceId: WORKSPACE,
      bindingId: NEW_BINDING,
      epoch: OLD_EPOCH + 1,
      companionId: NEW_COMPANION,
      routeCanonical: ROUTE,
      challengeId: CHALLENGE,
      updatedAt: Date.now(),
    };
    const worker = await loadWorker(responseBody(), {
      transport: {
        workspaceId: WORKSPACE,
        companionId: NEW_COMPANION,
        bindingId: NEW_BINDING,
        epoch: OLD_EPOCH + 1,
        credential: "c2c_comp_fresh-companion-credential",
        routeCanonical: ROUTE,
        routeVerification: "PENDING",
        rebindPending: false,
        routeAttestationMessage: `[C2C_ROUTE_ATTEST]\nchallengeId=${CHALLENGE}`,
      },
      connectFlow: flow,
      routeFence: {
        state: "OBSERVED_PENDING_CONFIRM",
        companionId: NEW_COMPANION,
        challengeId: CHALLENGE,
        routeCanonical: ROUTE,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      fetch: async (url) => {
        urls.push(String(url));
        return jsonResponse(200, verifiedState());
      },
      tabsSendMessage: async () => { throw new Error("DONE restart must not send"); },
    });
    const sender = { tab: { id: 7 }, documentId: "document-g4-rebind", frameId: 0, url: ROUTE };
    await worker.send({
      type: "c2c.heartbeat",
      generation: 1,
      canonicalRoute: ROUTE,
      safety: { composer: "empty", generation: "idle", safe: true },
    }, sender);

    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/\/state$/);
    expect(urls[0]).not.toContain("/rebind/complete");
    expect(worker.tabsSendMessage).not.toHaveBeenCalled();
    expect(worker.local.values.get(TRANSPORT_KEY)).toMatchObject({ routeVerification: "VERIFIED" });
    expect(worker.local.values.get(CONNECT_KEY)).toMatchObject({ state: "DONE" });
  });
});

describe("G4 Browser rebind init response identity gate", () => {
  it("valid 2xx response commits the successor transport and durable fence together", async () => {
    const worker = await loadWorker(responseBody());
    const result = await worker.send(
      { type: "c2c.rebind.start", ownerProofId: worker.proofId },
      {},
    ) as { ok: boolean; transport?: Record<string, unknown> };

    expect(result.ok).toBe(true);
    expect(result.transport).toMatchObject({
      workspaceId: WORKSPACE,
      companionId: NEW_COMPANION,
      bindingId: NEW_BINDING,
      epoch: OLD_EPOCH + 1,
      routeCanonical: ROUTE,
      rebindPending: true,
    });
    expect(worker.local.values.get(TRANSPORT_KEY)).toMatchObject({
      workspaceId: WORKSPACE,
      companionId: NEW_COMPANION,
      bindingId: NEW_BINDING,
      epoch: OLD_EPOCH + 1,
    });
    expect(worker.local.values.get(FENCE_KEY)).toMatchObject({
      state: "NONE",
      companionId: NEW_COMPANION,
      challengeId: CHALLENGE,
      routeCanonical: ROUTE,
    });
    expect(worker.tabsSendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["workspace mismatch", { workspaceId: "foreign-workspace" }],
    ["epoch is not immediate successor", { epoch: OLD_EPOCH + 2 }],
    ["binding is reused", { bindingId: OLD_BINDING }],
    ["binding id is malformed", { bindingId: "binding-not-uuid" }],
    ["companion id is malformed", { companionId: "companion-not-uuid" }],
    ["challenge id does not match message", {
      routeAttestation: {
        challengeId: CHALLENGE,
        message: "[C2C_ROUTE_ATTEST]\nchallengeId=66666666-6666-4666-8666-666666666666",
      },
    }],
    ["route is not the exact owner route", { routeCanonical: "https://chatgpt.com/c/66666666-6666-4666-8666-666666666666" }],
  ] as const)("%s keeps the barrier and old transport without retry", async (_label, override) => {
    const worker = await loadWorker(responseBody(override));
    const result = await worker.send(
      { type: "c2c.rebind.start", ownerProofId: worker.proofId },
      {},
    ) as { ok: boolean; reason?: string; routeAttestFence?: string; retryAllowed?: boolean };

    expect(result).toMatchObject({
      ok: false,
      reason: "rebind_init_response_invalid",
      routeAttestFence: "PAIRING_TRANSITION",
      retryAllowed: false,
    });
    expect(worker.local.values.get(TRANSPORT_KEY)).toEqual(worker.initial.transport);
    expect(worker.local.values.get(FENCE_KEY)).toMatchObject({ state: "PAIRING_TRANSITION" });
    expect(worker.fetchMock).toHaveBeenCalledTimes(1);
    expect(worker.tabsSendMessage).not.toHaveBeenCalled();
    const status = await worker.send({ type: "c2c.transport.status" }) as {
      transport?: Record<string, unknown>;
      routeAttestFence?: string;
    };
    expect(status.transport).toMatchObject({
      companionId: OLD_COMPANION,
      bindingId: OLD_BINDING,
      epoch: OLD_EPOCH,
    });
    expect(status.routeAttestFence).toBe("PAIRING_TRANSITION");
  });

  it("rejects Pair while rebind init is in flight", async () => {
    let releaseInit!: (value: unknown) => void;
    const pendingInit = new Promise(resolve => { releaseInit = resolve; });
    const worker = await loadWorker(responseBody(), {
      fetch: async () => pendingInit,
    });
    const rebind = worker.send(
      { type: "c2c.rebind.start", ownerProofId: worker.proofId },
      {},
    );
    await vi.waitFor(() => expect(worker.fetchMock).toHaveBeenCalledTimes(1));

    const pair = await worker.send({
      type: "c2c.pair",
      bridgeOrigin: "https://bridge.example.test",
      intentId: "intent",
      secret: "secret",
      ownerProofId: "unused",
    });
    expect(pair).toMatchObject({
      ok: false,
      reason: "transport_mutation_in_flight",
      retryAllowed: true,
    });
    expect(worker.fetchMock).toHaveBeenCalledTimes(1);

    releaseInit({
      ok: true,
      status: 200,
      async json() { return responseBody(); },
    });
    expect(await rebind).toMatchObject({ ok: true });
  });
});

describe("G4 R3o trusted route authority integration (live-like SPA topology)", () => {
  function jsonResponse(status: number, body: Record<string, unknown>) {
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return body; },
    };
  }

  it("binds using the browser tab.url authority even when MessageSender.url is stale", async () => {
    // Live-like SPA topology: the tab navigated OLD_ROUTE → ROUTE but MV3 still
    // reports the stale sender.url. R3o binds the authority route from tab.url
    // (witness must match) instead of trusting sender.url.
    const worker = await loadWorker(responseBody());
    const sender = { tab: { id: 7, url: ROUTE }, documentId: "document-g4-new-doc", frameId: 0, url: OLD_ROUTE };
    const result = await worker.send(
      { type: "c2c.bind", generation: 2, canonicalRoute: ROUTE },
      sender,
    ) as { ok: boolean; isOwner?: boolean; canonicalRoute?: string | null };

    expect(result).toMatchObject({ ok: true, isOwner: true, canonicalRoute: ROUTE });
    expect(worker.session.values.get(OWNER_KEY)).toMatchObject({
      tabId: 7,
      documentId: "document-g4-new-doc",
      canonicalRoute: ROUTE,
    });
    expect(worker.local.values.get(LOCAL_KEY)).toMatchObject({ targetRoute: ROUTE, paired: true });
  });

  it("connect identity stage resolves the current tab route and starts the rebind flow", async () => {
    // Same live-like topology: transport is still paired on OLD_ROUTE while the
    // tab is on ROUTE and MessageSender.url is stale. R3o resolves the connect
    // identity from tab.url + witness and proceeds with rebind init (previously
    // the stale sender.url fed the identity stage and failed the flow).
    const urls: string[] = [];
    const worker = await loadWorker(responseBody(), {
      oldRoute: OLD_ROUTE,
      fetch: async (url) => {
        const value = String(url);
        urls.push(value);
        if (value.includes("/rebind/init")) return jsonResponse(200, responseBody());
        throw new Error(`unexpected URL ${value}`);
      },
      tabsSendMessage: async (_tabId, message) => message.type === "c2c.route.attest.execute"
        ? { ok: true, observed: true, mutationAttempted: true, clickAttempted: true }
        : { ok: true },
    });
    const sender = { tab: { id: 7, url: ROUTE }, documentId: "document-g4-rebind", frameId: 0, url: OLD_ROUTE };
    const result = await worker.send({
      type: "c2c.connect.page",
      generation: 1,
      safety: { composer: "empty", generation: "idle", safe: true },
      canonicalRoute: ROUTE,
    }, sender) as { ok: boolean; state?: string; reason?: string };

    expect(result.ok).toBe(true);
    expect(result.state).toBe("AWAITING_CONFIRMATION");
    expect([
      "invalid_route",
      "route_witness_required",
      "route_witness_invalid",
      "route_witness_mismatch",
    ]).not.toContain(result.reason);
    expect(worker.session.values.get(OWNER_KEY)).toMatchObject({
      tabId: 7,
      documentId: "document-g4-rebind",
      canonicalRoute: ROUTE,
    });
    expect(worker.local.values.get(TRANSPORT_KEY)).toMatchObject({
      companionId: NEW_COMPANION,
      bindingId: NEW_BINDING,
      epoch: OLD_EPOCH + 1,
      routeCanonical: ROUTE,
      rebindPending: true,
    });
    expect(urls.filter((url) => url.includes("/rebind/init"))).toHaveLength(1);
  });

  it("drops a same-tab stale old-document heartbeat and preserves the new owner, evidence and proof", async () => {
    // Dangerous topology (same tab, different documents): the SPA created a new
    // document that became the owner; the stale old document in the SAME tab then
    // sends a heartbeat whose sender.url and witness both claim OLD_ROUTE while
    // the browser tab.url says ROUTE. The stale document is not the owner, so the
    // observation must be dropped with zero mutation: owner, evidence and the
    // in-memory owner proof must all survive untouched.
    const worker = await loadWorker(responseBody());
    const newDocSender = { tab: { id: 7, url: ROUTE }, documentId: "document-g4-new-doc", frameId: 0, url: ROUTE };
    const safety = { composer: "empty", generation: "idle", safe: true };

    // Explicitly establish the new document in the SAME tab as the current owner.
    const bound = await worker.send(
      { type: "c2c.bind", generation: 2, canonicalRoute: ROUTE },
      newDocSender,
    ) as { ok: boolean };
    expect(bound.ok).toBe(true);

    // Owner-exact heartbeat builds runtime evidence for the new document.
    await worker.send({ type: "c2c.heartbeat", generation: 2, canonicalRoute: ROUTE, safety }, newDocSender);
    expect(worker.session.values.get(OWNER_KEY)).toMatchObject({
      tabId: 7,
      documentId: "document-g4-new-doc",
      canonicalRoute: ROUTE,
    });
    expect(worker.session.values.get(EVIDENCE_KEY)).toMatchObject({
      tabId: 7,
      documentId: "document-g4-new-doc",
      canonicalRoute: ROUTE,
    });

    // Mint a live owner proof for the new owner (worker-internal, in-memory).
    const proof = await worker.send(
      { type: "c2c.owner-proof.request", href: ROUTE, canonicalRoute: ROUTE, generation: 2 },
      newDocSender,
    ) as { ok: boolean };
    expect(proof.ok).toBe(true);

    const ownerBefore = worker.session.values.get(OWNER_KEY);
    const evidenceBefore = worker.session.values.get(EVIDENCE_KEY);
    const registryBefore = worker.session.values.get(REGISTRY_KEY);
    const stale = await worker.send({
      type: "c2c.heartbeat",
      generation: 1,
      canonicalRoute: OLD_ROUTE,
      safety,
    }, { tab: { id: 7, url: ROUTE }, documentId: "document-g4-stale-old-doc", frameId: 0, url: OLD_ROUTE }) as {
      ok: boolean;
      canonicalRoute?: string | null;
      evidence?: { documentId?: string } | null;
      ownership?: {
        hasOwner?: boolean;
        isOwner?: boolean;
        owner?: { tabId?: number; documentId?: string; canonicalRoute?: string } | null;
      };
    };

    expect(stale.ownership).toMatchObject({ hasOwner: true, isOwner: false });
    expect(stale.ownership?.owner).toMatchObject({
      tabId: 7,
      documentId: "document-g4-new-doc",
      canonicalRoute: ROUTE,
    });
    // A mismatched observation never leaks its witness route as canonical.
    expect(stale.canonicalRoute).toBeNull();
    expect(stale.evidence).toMatchObject({ documentId: "document-g4-new-doc" });
    expect(worker.session.values.get(OWNER_KEY)).toEqual(ownerBefore);
    expect(worker.session.values.get(EVIDENCE_KEY)).toEqual(evidenceBefore);
    expect(worker.session.values.get(REGISTRY_KEY)).toEqual(registryBefore);
  });
});
