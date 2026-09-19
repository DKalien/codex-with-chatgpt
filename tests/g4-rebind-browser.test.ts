import { afterEach, describe, expect, it, vi } from "vitest";

const ROUTE = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
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

async function loadWorker(body: Record<string, unknown>) {
  const initial = initialState();
  const local = storageArea(initial.local);
  const session = storageArea(initial.session);
  let messageListener: ((message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => unknown) | null = null;
  const tabsSendMessage = vi.fn(async () => ({ ok: true }));
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    async json() { return body; },
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
  const proof = await send({ type: "c2c.owner-proof.request", href: ROUTE, generation: 1 }, ownerSender) as {
    ok: boolean;
    proof?: { id: string };
  };
  if (!proof.ok || !proof.proof) throw new Error(`owner proof setup failed: ${JSON.stringify(proof)}`);
  return { initial, local, session, fetchMock, tabsSendMessage, send, proofId: proof.proof.id };
}

afterEach(() => {
  vi.unstubAllGlobals();
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
});
