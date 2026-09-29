import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import {
  confirmRouteAttestation,
  createPairingIntent,
} from "../src/feedback/companion.js";
import { enableReceiver } from "../src/feedback/receiver.js";
import { reconcileFeedbackOutbox } from "../src/feedback/projector.js";
import { resolveConversationPrincipal } from "../src/mcp/conversation-principal.js";
import { CODEX_FEEDBACK_SCOPE } from "../src/feedback/store.js";
import { readActiveWebSinkBinding } from "../src/web-sink-control/index.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const ROUTE_A = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const ROUTE_B = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";

describe("R5c production Companion HTTP web-sink bind-current", () => {
  let wsRoot: string;
  let stateDir: string;
  let previousStateDir: string | undefined;
  let bridge: Bridge;
  let base: string;

  const principal = () => resolveConversationPrincipal({
    authInfo: { token: "t", clientId: "client-A", scopes: [CODEX_FEEDBACK_SCOPE] } as never,
    _meta: { "openai/session": "sess-A" },
  });

  async function fetchJson(p: string, init: RequestInit = {}) {
    const res = await fetch(`${base}${p}`, init);
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  async function pairAndVerify(route: string) {
    const intent = createPairingIntent({
      workspaceId: bridge.workspace.id,
      principal: principal(),
      stateDir,
    });
    const paired = await fetchJson("/api/companion/v1/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intentId: intent.intentId, secret: intent.secret, routeCanonical: route }),
    });
    expect(paired.status).toBe(200);
    confirmRouteAttestation({
      workspaceId: bridge.workspace.id,
      principal: principal(),
      challengeId: paired.body.routeAttestation.challengeId,
      challengeDigest: paired.body.routeAttestation.routeCanonical
        ? paired.body.routeAttestation.challengeDigest
        : paired.body.routeAttestation.challengeDigest,
      stateDir,
    });
    return {
      credential: paired.body.credential as string,
      auth: {
        authorization: `Bearer ${paired.body.credential}`,
        "content-type": "application/json",
      },
    };
  }

  beforeEach(async () => {
    previousStateDir = process.env.C2C_STATE_DIR;
    stateDir = isolateStateDir();
    wsRoot = makeTmpDir("r5c-http-ws");
    process.env.C2C_STATE_DIR = stateDir;
    bridge = await startBridge({
      workspaceRoot: wsRoot,
      port: 0,
      persistRuntime: false,
      runtimeBuildId: null,
      authStoreFile: path.join(stateDir, "auth", "test-auth.json"),
    });
    base = bridge.localBaseUrl();
    reconcileFeedbackOutbox(bridge.workspace.id, stateDir);
    enableReceiver({
      workspaceId: bridge.workspace.id,
      principal: principal(),
      widgetId: "w",
      stateDir,
    });
  });

  afterEach(async () => {
    await bridge.close();
    if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousStateDir;
    cleanup(wsRoot);
    cleanup(stateDir);
  });

  it("rejects missing or wrong credential with exactly 401", async () => {
    const noAuth = await fetchJson("/api/companion/v1/web-sink/bind-current", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ routeCanonical: ROUTE_A }),
    });
    expect(noAuth.status).toBe(401);

    const wrong = await fetchJson("/api/companion/v1/web-sink/bind-current", {
      method: "POST",
      headers: { authorization: "Bearer c2c_comp_wrong", "content-type": "application/json" },
      body: JSON.stringify({ routeCanonical: ROUTE_A }),
    });
    expect(wrong.status).toBe(401);
  });

  it("rejects caller route different from verified durable route", async () => {
    const { auth } = await pairAndVerify(ROUTE_A);
    const mismatch = await fetchJson("/api/companion/v1/web-sink/bind-current", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ routeCanonical: ROUTE_B }),
    });
    expect([400, 409]).toContain(mismatch.status);
    expect(readActiveWebSinkBinding(bridge.workspace.id)).toBeNull();
  });

  it("binds verified A then switches to B with epoch+1; same A is noWrite", async () => {
    const first = await pairAndVerify(ROUTE_A);
    const bindA = await fetchJson("/api/companion/v1/web-sink/bind-current", {
      method: "POST",
      headers: first.auth,
      body: JSON.stringify({ routeCanonical: ROUTE_A }),
    });
    expect(bindA.status).toBe(200);
    expect(bindA.body.created).toBe(true);
    expect(bindA.body.activeBinding.canonicalUrl).toBe(ROUTE_A);
    expect(bindA.body.activeBinding.pluginId).toBe("browser-companion");
    expect(bindA.body.activeBinding.surfaceId).toBe("chatgpt-web");
    expect(bindA.body.activeBinding.epoch).toBe(1);
    expect(JSON.stringify(bindA.body)).not.toMatch(/principalFingerprint|credential|challenge/);

    const again = await fetchJson("/api/companion/v1/web-sink/bind-current", {
      method: "POST",
      headers: first.auth,
      body: JSON.stringify({ routeCanonical: ROUTE_A }),
    });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.activeBinding.bindingId).toBe(bindA.body.activeBinding.bindingId);
    expect(again.body.activeBinding.epoch).toBe(1);
    expect(again.body.activeBinding.boundAt).toBe(bindA.body.activeBinding.boundAt);

    // Rebind companion to route B and verify, then bind B
    const second = await pairAndVerify(ROUTE_B);
    const bindB = await fetchJson("/api/companion/v1/web-sink/bind-current", {
      method: "POST",
      headers: second.auth,
      body: JSON.stringify({ routeCanonical: ROUTE_B }),
    });
    expect(bindB.status).toBe(200);
    expect(bindB.body.created).toBe(true);
    expect(bindB.body.activeBinding.canonicalUrl).toBe(ROUTE_B);
    expect(bindB.body.activeBinding.bindingId).not.toBe(bindA.body.activeBinding.bindingId);
    expect(bindB.body.activeBinding.epoch).toBe(2);
    expect(readActiveWebSinkBinding(bridge.workspace.id)?.canonicalUrl).toBe(ROUTE_B);
  });

  it("unverified route cannot bind", async () => {
    const intent = createPairingIntent({
      workspaceId: bridge.workspace.id,
      principal: principal(),
      stateDir,
    });
    const paired = await fetchJson("/api/companion/v1/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intentId: intent.intentId, secret: intent.secret, routeCanonical: ROUTE_A }),
    });
    expect(paired.status).toBe(200);
    const res = await fetchJson("/api/companion/v1/web-sink/bind-current", {
      method: "POST",
      headers: {
        authorization: `Bearer ${paired.body.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ routeCanonical: ROUTE_A }),
    });
    expect([400, 409]).toContain(res.status);
    expect(readActiveWebSinkBinding(bridge.workspace.id)).toBeNull();
  });

  it("web-sink/status is authenticated read-only generic projection", async () => {
    const { auth } = await pairAndVerify(ROUTE_A);
    await fetchJson("/api/companion/v1/web-sink/bind-current", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ routeCanonical: ROUTE_A }),
    });
    const status = await fetchJson("/api/companion/v1/web-sink/status", { headers: auth });
    expect(status.status).toBe(200);
    expect(status.body.activeBinding.canonicalUrl).toBe(ROUTE_A);
    expect(JSON.stringify(status.body)).not.toMatch(/principalFingerprint|credential|challenge/);
    const noAuth = await fetchJson("/api/companion/v1/web-sink/status");
    expect(noAuth.status).toBe(401);
  });
});
