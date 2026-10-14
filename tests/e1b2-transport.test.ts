import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseBridgeOrigin, companionApiUrl, BridgeOriginError } from "../browser-companion/bridge-origin.js";

import { companionPublicState } from "../src/feedback/companion.js";

import { enableReceiver } from "../src/feedback/store.js";

import { resolveConversationPrincipal } from "../src/mcp/conversation-principal.js";

import { CODEX_FEEDBACK_SCOPE } from "../src/feedback/store.js";

import { reconcileHistoricalFeedbackFixtures } from "./helpers/legacy-feedback-fixtures.js";

import { appendExecutionRecordLocked, withExecutionRecordsLock } from "../src/execution/records.js";

import { updateDesktop } from "../src/desktop/store.js";

import { Workspace } from "../src/workspace/manager.js";

import { createPairingIntent, exchangePairingIntent, verifyCompanionCredential } from "../src/feedback/companion.js";

import { reserveNext } from "../src/feedback/store.js";

import fs from "node:fs";

import path from "node:path";

import { fileURLToPath } from "node:url";

import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ROUTE = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";

describe("bridge origin parser", () => {
  it("accepts HTTPS origin only by default", () => {
    expect(parseBridgeOrigin("https://bridge.example.com")).toBe("https://bridge.example.com");
    expect(parseBridgeOrigin("https://bridge.example.com:8443")).toBe("https://bridge.example.com:8443");
    expect(() => parseBridgeOrigin("http://evil.example.com")).toThrow(BridgeOriginError);
    expect(() => parseBridgeOrigin("https://bridge.example.com/path")).toThrow(BridgeOriginError);
    expect(() => parseBridgeOrigin("https://bridge.example.com?x=1")).toThrow(BridgeOriginError);
  });

  it("loopback HTTP only when explicitly allowed", () => {
    expect(() => parseBridgeOrigin("http://127.0.0.1:5000")).toThrow(BridgeOriginError);
    expect(parseBridgeOrigin("http://127.0.0.1:5000", { allowLoopbackHttp: true }))
      .toBe("http://127.0.0.1:5000");
    expect(parseBridgeOrigin("http://localhost:5000", { allowLoopbackHttp: true }))
      .toBe("http://localhost:5000");
    expect(() => parseBridgeOrigin("http://example.com", { allowLoopbackHttp: true }))
      .toThrow(BridgeOriginError);
  });

  it("companionApiUrl builds full /api/companion/v1 URLs from short endpoints", () => {
    // Real SW call sites use short endpoints; builder must add the Bridge mount prefix.
    expect(companionApiUrl("https://b.example.com", "/pair"))
      .toBe("https://b.example.com/api/companion/v1/pair");
    expect(companionApiUrl("https://b.example.com", "/state"))
      .toBe("https://b.example.com/api/companion/v1/state");
    expect(companionApiUrl("https://b.example.com", "/reserve"))
      .toBe("https://b.example.com/api/companion/v1/reserve");
    expect(companionApiUrl("https://b.example.com", "/release"))
      .toBe("https://b.example.com/api/companion/v1/release");
    expect(companionApiUrl("http://127.0.0.1:48765", "pair"))
      .toBe("http://127.0.0.1:48765/api/companion/v1/pair");
    // Idempotent when prefix already present
    expect(companionApiUrl("https://b.example.com", "/api/companion/v1/state"))
      .toBe("https://b.example.com/api/companion/v1/state");
  });

  it("companionApiUrl allows only feedback endpoints and the bounded rebind status query", () => {
    const route = "https://chatgpt.com/g/g-p-6aa296e634348191b441d56fdab23b7b/c/6ab246f9-3b94-83ec-b873-9bc2ac9edf67";
    const challengeId = "6ab246f9-3b94-83ec-b873-9bc2ac9edf67";
    const status = `/rebind/status?routeCanonical=${encodeURIComponent(route)}&challengeId=${challengeId}`;
    expect(companionApiUrl("https://b.example.com", status))
      .toBe(`https://b.example.com/api/companion/v1${status}`);

    for (const endpoint of [
      "/pair", "/rebind/init", "/rebind/complete", "/rebind/status", "/state",
      "/reserve", "/release", "/begin-send", "/ack", "/retire-unknown",
    ]) {
      if (endpoint === "/rebind/status") continue;
      expect(companionApiUrl("https://b.example.com", endpoint))
        .toBe(`https://b.example.com/api/companion/v1${endpoint}`);
    }

    for (const endpoint of [
      "/desktop", "/command", "/task", "/routing", "/api/companion/v1/desktop",
      "/pair?next=/desktop", "/pair/../desktop", "//other.example/desktop",
      "/rebind/status?routeCanonical=bad&challengeId=also-bad",
      `/rebind/status?routeCanonical=${encodeURIComponent(route)}&challengeId=${challengeId}&extra=1`,
      `/rebind/status?routeCanonical=${encodeURIComponent(route)}&challengeId=${challengeId}&challengeId=${challengeId}`,
    ]) {
      expect(() => companionApiUrl("https://b.example.com", endpoint)).toThrow(BridgeOriginError);
    }
  });
});

describe("server /state inFlight recovery projection", () => {
  let stateDir: string;
  let wsRoot: string;
  let workspace: Workspace;

  function principalA() {
    return resolveConversationPrincipal({
      authInfo: { token: "t", clientId: "client-A", scopes: [CODEX_FEEDBACK_SCOPE] } as never,
      _meta: { "openai/session": "sess-A" },
    });
  }

  function seed(commandId: string) {
    updateDesktop(workspace.id, (previous) => {
      const base = previous ?? {
        version: 1 as const,
        workspaceId: workspace.id,
        workspaceRoot: wsRoot,
        enabled: true,
        binding: {
          threadId: "11111111-1111-4111-8111-111111111111",
          hostId: "local" as const,
          projectId: "p",
          bindingId: "22222222-2222-4222-8222-222222222222",
          title: "t",
          boundAt: new Date().toISOString(),
        },
        deliveries: [] as never[],
      };
      return {
        state: {
          ...base,
          deliveries: [
            {
              commandId,
              clientId: "c",
              bindingId: "22222222-2222-4222-8222-222222222222",
              messageSha256: "a".repeat(64),
              messageBytes: 1,
              threadId: "11111111-1111-4111-8111-111111111111",
              turnId: "33333333-3333-4333-8333-333333333333",
              deliveryStatus: "accepted" as const,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        } as never,
        result: null as never,
      };
    });
    withExecutionRecordsLock(workspace.id, () => {
      appendExecutionRecordLocked(workspace.id, {
        taskId: `desktop_${commandId}`,
        iteration: 1,
        changedFiles: ["a.ts"],
        tests: "1 passed",
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
        commandId,
        desktopReceiptSha256: "b".repeat(64),
        outputAvailable: true,
      } as never);
    });
  }

  beforeEach(() => {
    stateDir = isolateStateDir();
    wsRoot = makeTmpDir("e1b2-ws");
    workspace = new Workspace(wsRoot);
  });

  afterEach(() => {
    cleanup(stateDir);
    cleanup(wsRoot);
  });

  it("authenticated companion recovers own reservationId; no forbidden fields", () => {
    reconcileHistoricalFeedbackFixtures(workspace.id, stateDir);
    seed("cmd-inflight");
    reconcileHistoricalFeedbackFixtures(workspace.id, stateDir);
    enableReceiver({ workspaceId: workspace.id, principal: principalA(), widgetId: "w", stateDir });
    const intent = createPairingIntent({ workspaceId: workspace.id, principal: principalA(), stateDir });
    const paired = exchangePairingIntent({
      workspaceId: workspace.id,
      intentId: intent.intentId,
      secret: intent.secret,
      routeCanonical: ROUTE,
      stateDir,
    });
    const ctx = verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: paired.credential,
      stateDir,
    });
    const reserved = reserveNext({
      workspaceId: workspace.id,
      bindingId: ctx.bindingId,
      epoch: ctx.epoch,
      principalFingerprint: ctx.principalFingerprint,
      companionId: ctx.companionId,
      stateDir,
    });
    const state = companionPublicState({ workspaceId: workspace.id, ctx, stateDir });
    expect(state.inFlight).toEqual({
      eventId: reserved.event.eventId,
      status: "reserved",
      reservationId: reserved.reservationId,
      sendAllowed: false,
    });
    const json = JSON.stringify(state);
    expect(json).not.toContain("principalFingerprint");
    expect(json).not.toContain("reservedBy");
    expect(json).not.toContain("credentialHash");
  });
});
