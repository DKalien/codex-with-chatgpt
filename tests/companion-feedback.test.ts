import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ackObserved,
  claimNext,
  enableReceiver,
  FEEDBACK_RESERVATION_STALE_MS,
  readFeedbackState,
  takeoverReceiver,
  reserveNext,
  beginSend,
  retireOutcomeUnknown,
} from "../src/feedback/store.js";
import {
  companionAckObserved,
  companionBeginSend,
  companionBootstrapReadiness,
  companionPublicState,
  companionRelease,
  companionReserveNext,
  companionRetireOutcomeUnknown,
  companionStatusForPrincipal,
  completeCompanionRebind,
  confirmRouteAttestation,
  createPairingIntent,
  exchangePairingIntent,
  initiateCompanionRebind,
  normalizeChatgptRoute,
  revokeCompanion,
  verifyCompanionCredential,
} from "../src/feedback/companion.js";
import { createCompanionRouter } from "../src/bridge/companion.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { resolveConversationPrincipal } from "../src/mcp/conversation-principal.js";
import { reconcileFeedbackOutbox } from "../src/feedback/projector.js";
import {
  appendExecutionRecordLocked,
  withExecutionRecordsLock,
} from "../src/execution/records.js";
import { updateDesktop } from "../src/desktop/store.js";
import { Workspace } from "../src/workspace/manager.js";
import { CODEX_FEEDBACK_SCOPE, routeChallengeDigest } from "../src/feedback/store.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";
import {
  clearJournal,
  markClaimed,
  markComposerWriteIntent,
  markObservedPendingAck,
  markReserveRequested,
  markReserved,
  markSendDispatchIntent,
  markSendIntent,
  reconcileSendJournal,
  emptyJournal,
} from "../browser-companion/reservation-journal.js";

let stateDir: string;
let wsRoot: string;
let workspace: Workspace;

const ROUTE = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const ROUTE_B = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";
const PROJECT_ROUTE = "https://chatgpt.com/g/g-p-6aa296e634348191b441d56fdab23b7b/c/11111111-1111-4111-8111-111111111111";
const PROJECT_ROUTE_ALIAS = "https://chatgpt.com/g/g-p-6aa296e634348191b441d56fdab23b7b-codex-with-chatgpt/c/11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  stateDir = isolateStateDir();
  wsRoot = makeTmpDir("companion-ws");
  workspace = new Workspace(wsRoot);
});

afterEach(() => {
  cleanup(stateDir);
  cleanup(wsRoot);
});

function principalA() {
  return resolveConversationPrincipal({
    authInfo: { token: "t", clientId: "client-A", scopes: [CODEX_FEEDBACK_SCOPE] } as never,
    _meta: { "openai/session": "sess-A" },
  });
}

function principalB() {
  return resolveConversationPrincipal({
    authInfo: { token: "t", clientId: "client-B", scopes: [CODEX_FEEDBACK_SCOPE] } as never,
    _meta: { "openai/session": "sess-B" },
  });
}

function seedTrustedReceipt(commandId: string) {
  updateDesktop(workspace.id, (previous) => {
    const base = previous ?? {
      version: 1 as const,
      workspaceId: workspace.id,
      workspaceRoot: wsRoot,
      enabled: true,
      binding: {
        threadId: "11111111-1111-4111-8111-111111111111",
        hostId: "local" as const,
        projectId: "proj",
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
          ...base.deliveries.filter((d) => d.commandId !== commandId),
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

function setupReadyEvent(commandId = "cmd-1") {
  reconcileFeedbackOutbox(workspace.id, stateDir);
  seedTrustedReceipt(commandId);
  reconcileFeedbackOutbox(workspace.id, stateDir);
  enableReceiver({
    workspaceId: workspace.id,
    principal: principalA(),
    widgetId: "w",
    stateDir,
  });
  const state = readFeedbackState(workspace.id, stateDir);
  return state.events.find((e) => e.commandId === commandId)!;
}

function pairCompanion(route = ROUTE, opts: { verify?: boolean } = {}) {
  const intent = createPairingIntent({
    workspaceId: workspace.id,
    principal: principalA(),
    stateDir,
  });
  const paired = exchangePairingIntent({
    workspaceId: workspace.id,
    intentId: intent.intentId,
    secret: intent.secret,
    routeCanonical: route,
    stateDir,
  });
  if (opts.verify !== false) {
    confirmRouteAttestation({
      workspaceId: workspace.id,
      principal: principalA(),
      challengeId: paired.routeAttestation.challengeId,
      challengeDigest: paired.routeAttestation.challengeDigest,
      stateDir,
    });
  }
  return paired;
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`expected throw ${code}`);
  } catch (e) {
    expect((e as { code?: string }).code).toBe(code);
  }
}

describe("G3 route-principal attestation", () => {
  it("pair route A → pending; reserve blocked; principal B mismatch leaves pending", () => {
    setupReadyEvent();
    const paired = pairCompanion(ROUTE, { verify: false });
    expect(paired.routeVerification).toBe("PENDING");
    const ctx = verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: paired.credential,
      stateDir,
    });
    expect(ctx.routeVerified).toBe(false);
    expectCode(() => companionReserveNext({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      stateDir,
    }), "COMPANION_ROUTE_UNVERIFIED");
    // Wrong conversation principal must not consume challenge
    expectCode(() => confirmRouteAttestation({
      workspaceId: workspace.id,
      principal: principalB(),
      challengeId: paired.routeAttestation.challengeId,
      challengeDigest: paired.routeAttestation.challengeDigest,
      stateDir,
    }), "FEEDBACK_PRINCIPAL_MISMATCH");
    const afterWrong = readFeedbackState(workspace.id, stateDir).companion!;
    expect(afterWrong.routeAttestation?.status).toBe("pending");
    expect(afterWrong.routeAttestation?.consumedAt).toBeUndefined();
    expectCode(() => companionReserveNext({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      stateDir,
    }), "COMPANION_ROUTE_UNVERIFIED");
  });

  it("same challenge confirmed by A → verified → reserve allowed", () => {
    setupReadyEvent();
    const paired = pairCompanion(ROUTE, { verify: false });
    const confirmed = confirmRouteAttestation({
      workspaceId: workspace.id,
      principal: principalA(),
      challengeId: paired.routeAttestation.challengeId,
      challengeDigest: paired.routeAttestation.challengeDigest,
      stateDir,
    });
    expect(confirmed.verified).toBe(true);
    const ctx = verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: paired.credential,
      stateDir,
    });
    expect(ctx.routeVerified).toBe(true);
    const reserved = companionReserveNext({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      stateDir,
    });
    expect(reserved.delivery.status).toBe("reserved");
  });

  it("wrong digest / expired / replayed / wrong companion fail closed", () => {
    setupReadyEvent("cmd-attest");
    const paired = pairCompanion(ROUTE, { verify: false });
    expectCode(() => confirmRouteAttestation({
      workspaceId: workspace.id,
      principal: principalA(),
      challengeId: paired.routeAttestation.challengeId,
      challengeDigest: "0".repeat(64),
      stateDir,
    }), "ROUTE_ATTESTATION_INVALID");
    expectCode(() => confirmRouteAttestation({
      workspaceId: workspace.id,
      principal: principalA(),
      challengeId: "00000000-0000-4000-8000-000000000000",
      challengeDigest: paired.routeAttestation.challengeDigest,
      stateDir,
    }), "ROUTE_ATTESTATION_INVALID");

    // Expired challenge
    const expired = pairCompanion(ROUTE, { verify: false });
    expectCode(() => confirmRouteAttestation({
      workspaceId: workspace.id,
      principal: principalA(),
      challengeId: expired.routeAttestation.challengeId,
      challengeDigest: expired.routeAttestation.challengeDigest,
      stateDir,
      nowMs: Date.parse(expired.routeAttestation.expiresAt) + 1000,
    }), "ROUTE_ATTESTATION_EXPIRED");

    // Replay after success
    const okPair = pairCompanion(ROUTE, { verify: false });
    confirmRouteAttestation({
      workspaceId: workspace.id,
      principal: principalA(),
      challengeId: okPair.routeAttestation.challengeId,
      challengeDigest: okPair.routeAttestation.challengeDigest,
      stateDir,
    });
    expectCode(() => confirmRouteAttestation({
      workspaceId: workspace.id,
      principal: principalA(),
      challengeId: okPair.routeAttestation.challengeId,
      challengeDigest: okPair.routeAttestation.challengeDigest,
      stateDir,
    }), "ROUTE_ATTESTATION_INVALID");
  });

  it("re-pair route B → verification must not carry over", () => {
    setupReadyEvent("cmd-repair-route");
    const first = pairCompanion(ROUTE);
    const ctx1 = verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: first.credential,
      stateDir,
    });
    expect(ctx1.routeVerified).toBe(true);
    const second = pairCompanion(ROUTE_B, { verify: false });
    expect(second.companionId).not.toBe(first.companionId);
    expect(second.routeVerification).toBe("PENDING");
    const ctx2 = verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: second.credential,
      stateDir,
    });
    expect(ctx2.routeVerified).toBe(false);
    expectCode(() => companionReserveNext({
      workspaceId: workspace.id,
      ctx: ctx2,
      routeCanonical: ROUTE_B,
      stateDir,
    }), "COMPANION_ROUTE_UNVERIFIED");
  });

  it("takeover epoch 2 invalidates old verification", () => {
    setupReadyEvent("cmd-takeover-route");
    const paired = pairCompanion(ROUTE);
    expect(verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: paired.credential,
      stateDir,
    }).routeVerified).toBe(true);
    takeoverReceiver({
      workspaceId: workspace.id,
      principal: principalB(),
      widgetId: "wB",
      expectedEpoch: 1,
      stateDir,
    });
    try {
      verifyCompanionCredential({
        workspaceId: workspace.id,
        credential: paired.credential,
        stateDir,
      });
      expect.unreachable("old companion invalid after takeover");
    } catch (e) {
      expect(["COMPANION_EPOCH_STALE", "COMPANION_UNAUTHORIZED", "FEEDBACK_NOT_ENABLED"])
        .toContain((e as { code?: string }).code);
    }
  });

  it("legacy CompanionRecord without attestation → unverified, no production reserve", () => {
    setupReadyEvent("cmd-legacy-att");
    const paired = pairCompanion(ROUTE);
    // Strip attestation field to simulate legacy on-disk record
    const file = path.join(stateDir, "feedback", `${workspace.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    delete raw.companion.routeAttestation;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));
    const ctx = verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: paired.credential,
      stateDir,
    });
    expect(ctx.routeVerified).toBe(false);
    expectCode(() => companionReserveNext({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      stateDir,
    }), "COMPANION_ROUTE_UNVERIFIED");
  });

  it("legacy reserved recovery: release still works; new reserve blocked until verify", () => {
    setupReadyEvent("cmd-legacy-reserved");
    const paired = pairCompanion(ROUTE);
    // Simulate upgrade-time reserved without verifying the new challenge
    const ctx = verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: paired.credential,
      stateDir,
    });
    // Direct store reserve (legacy path used by old in-flight) — then unverify companion
    const reserved = reserveNext({
      workspaceId: workspace.id,
      bindingId: ctx.bindingId,
      epoch: ctx.epoch,
      principalFingerprint: ctx.principalFingerprint,
      companionId: ctx.companionId,
      stateDir,
    });
    // Mark companion attestation back to pending to simulate unverified upgrade state
    const file = path.join(stateDir, "feedback", `${workspace.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.companion.routeAttestation.status = "pending";
    delete raw.companion.routeAttestation.verifiedAt;
    delete raw.companion.routeAttestation.consumedAt;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));
    const ctxUnverified = verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: paired.credential,
      stateDir,
    });
    expect(ctxUnverified.routeVerified).toBe(false);
    // Recovery release still allowed
    const released = companionRelease({
      workspaceId: workspace.id,
      ctx: ctxUnverified,
      routeCanonical: ROUTE,
      eventId: reserved.event.eventId,
      reservationId: reserved.reservationId,
      stateDir,
    });
    expect(released.status).toBe("ready");
    // New reserve still blocked
    expectCode(() => companionReserveNext({
      workspaceId: workspace.id,
      ctx: ctxUnverified,
      routeCanonical: ROUTE,
      stateDir,
    }), "COMPANION_ROUTE_UNVERIFIED");
  });

  it("MCP confirm tool uses request principal; wrong principal rejected", async () => {
    setupReadyEvent("cmd-mcp-confirm");
    const paired = pairCompanion(ROUTE, { verify: false });
    const { createMcpServer } = await import("../src/mcp/server.js");
    const server = createMcpServer({ workspace, logger: { info() {}, error() {}, warn() {}, debug() {} } as never });
    const tools = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (a: unknown, e: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
      }>;
    })._registeredTools;
    const handler = tools.feedback_companion_route_confirm.handler;
    const denied = await handler({
      challengeId: paired.routeAttestation.challengeId,
      challengeDigest: paired.routeAttestation.challengeDigest,
    }, {
      authInfo: { token: "t", clientId: "client-B", scopes: [CODEX_FEEDBACK_SCOPE] },
      _meta: { "openai/session": "sess-B" },
    });
    expect(denied.isError).toBe(true);
    const okRes = await handler({
      challengeId: paired.routeAttestation.challengeId,
      challengeDigest: paired.routeAttestation.challengeDigest,
    }, {
      authInfo: { token: "t", clientId: "client-A", scopes: [CODEX_FEEDBACK_SCOPE] },
      _meta: { "openai/session": "sess-A" },
    });
    expect(okRes.isError).not.toBe(true);
    expect(ctxRouteVerified()).toBe(true);
  });

  function ctxRouteVerified(): boolean {
    return readFeedbackState(workspace.id, stateDir).companion?.routeAttestation?.status === "verified";
  }
});

describe("G4 bootstrap readiness and same-browser rebind", () => {
  it("MCP bootstrap tool derives ownership from request-scoped principal", async () => {
    reconcileFeedbackOutbox(workspace.id, stateDir);
    enableReceiver({ workspaceId: workspace.id, principal: principalA(), widgetId: "widget-A", stateDir });
    const { createMcpServer } = await import("../src/mcp/server.js");
    const server = createMcpServer({ workspace, logger: { info() {}, error() {}, warn() {}, debug() {} } as never });
    const handler = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (a: unknown, e: unknown) => Promise<{ structuredContent?: Record<string, unknown> }>;
        annotations?: { readOnlyHint?: boolean };
      }>;
    })._registeredTools.feedback_bootstrap_status.handler;
    expect((server as unknown as {
      _registeredTools: Record<string, { annotations?: { readOnlyHint?: boolean } }>;
    })._registeredTools.feedback_bootstrap_status.annotations?.readOnlyHint).toBe(true);
    const foreign = await handler({}, {
      authInfo: { token: "t", clientId: "client-B", scopes: [CODEX_FEEDBACK_SCOPE] },
      _meta: { "openai/session": "sess-B" },
    });
    expect(foreign.structuredContent).toMatchObject({
      state: "FOREIGN_SAFE_TO_TAKEOVER",
      expectedEpoch: 1,
      widgetId: "widget-A",
    });
    expect(JSON.stringify(foreign.structuredContent)).not.toContain(principalA().fingerprint);
  });

  it("bootstrap readiness projects stale events in memory without changing state bytes", async () => {
    setupReadyEvent("g4-bootstrap-readonly-stale");
    const paired = pairCompanion();
    const ctx = verifyCompanionCredential({ workspaceId: workspace.id, credential: paired.credential, stateDir });
    companionReserveNext({ workspaceId: workspace.id, ctx, routeCanonical: ROUTE, stateDir });
    const stateFile = path.join(stateDir, "feedback", `${workspace.id}.json`);
    const stale = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
      events: Array<{ status: string; reservedAt?: string }>;
    };
    stale.events[0]!.reservedAt = new Date(Date.now() - FEEDBACK_RESERVATION_STALE_MS - 1_000).toISOString();
    fs.writeFileSync(stateFile, JSON.stringify(stale, null, 2));
    const before = fs.readFileSync(stateFile);

    const { createMcpServer } = await import("../src/mcp/server.js");
    const server = createMcpServer({ workspace, logger: { info() {}, error() {}, warn() {}, debug() {} } as never });
    const handler = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (a: unknown, e: unknown) => Promise<{ structuredContent?: Record<string, unknown> }>;
      }>;
    })._registeredTools.feedback_bootstrap_status.handler;
    const readiness = await handler({}, {
      authInfo: { token: "t", clientId: "client-A", scopes: [CODEX_FEEDBACK_SCOPE] },
      _meta: { "openai/session": "sess-A" },
    });

    expect(readiness.structuredContent).toMatchObject({ state: "OWNED_VERIFIED", inFlightStatus: null });
    expect(fs.readFileSync(stateFile)).toEqual(before);
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).events[0].status).toBe("reserved");
  });

  it("projects disabled, foreign takeover, owned stale, owned verified and blocked states", () => {
    reconcileFeedbackOutbox(workspace.id, stateDir);
    expect(companionBootstrapReadiness({ workspaceId: workspace.id, principal: principalA(), stateDir }))
      .toMatchObject({ state: "DISABLED", ownsBinding: false });

    enableReceiver({ workspaceId: workspace.id, principal: principalA(), widgetId: "widget-A", stateDir });
    expect(companionBootstrapReadiness({ workspaceId: workspace.id, principal: principalB(), stateDir }))
      .toMatchObject({
        state: "FOREIGN_SAFE_TO_TAKEOVER",
        ownsBinding: false,
        expectedEpoch: 1,
        widgetId: "widget-A",
      });
    expect(companionBootstrapReadiness({ workspaceId: workspace.id, principal: principalA(), stateDir }))
      .toMatchObject({
        state: "OWNED_NEEDS_BROWSER_REBIND",
        companionPresent: false,
        routeVerification: "NONE",
      });

    const paired = pairCompanion();
    expect(companionBootstrapReadiness({ workspaceId: workspace.id, principal: principalA(), stateDir }))
      .toMatchObject({ state: "OWNED_VERIFIED", routeVerification: "VERIFIED" });
    const ctx = verifyCompanionCredential({ workspaceId: workspace.id, credential: paired.credential, stateDir });
    setupReadyEvent("g4-blocked");
    companionReserveNext({ workspaceId: workspace.id, ctx, routeCanonical: ROUTE, stateDir });
    expect(companionBootstrapReadiness({ workspaceId: workspace.id, principal: principalB(), stateDir }))
      .toMatchObject({ state: "BLOCKED_INFLIGHT", inFlightStatus: "reserved" });
    const stateFile = path.join(stateDir, "feedback", `${workspace.id}.json`);
    const claimed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    claimed.events[0].status = "claimed";
    claimed.events[0].attemptId = "33333333-3333-4333-8333-333333333333";
    claimed.events[0].claimedAt = new Date().toISOString();
    fs.writeFileSync(stateFile, JSON.stringify(claimed, null, 2));
    expect(companionBootstrapReadiness({ workspaceId: workspace.id, principal: principalB(), stateDir }))
      .toMatchObject({ state: "BLOCKED_INFLIGHT", inFlightStatus: "claimed" });
    claimed.events[0].status = "outcome_unknown";
    fs.writeFileSync(stateFile, JSON.stringify(claimed, null, 2));
    expect(companionBootstrapReadiness({ workspaceId: workspace.id, principal: principalB(), stateDir }))
      .toMatchObject({ state: "BLOCKED_INFLIGHT", inFlightStatus: "outcome_unknown" });
  });

  it("immediate successor rebind requires current principal confirmation and rotates credential", () => {
    setupReadyEvent("g4-rebind");
    const old = pairCompanion();
    takeoverReceiver({
      workspaceId: workspace.id,
      principal: principalB(),
      widgetId: "widget-B",
      expectedEpoch: old.epoch,
      stateDir,
    });
    expectCode(() => verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: old.credential,
      stateDir,
    }), "COMPANION_EPOCH_STALE");

    const started = initiateCompanionRebind({
      workspaceId: workspace.id,
      credential: old.credential,
      routeCanonical: ROUTE_B,
      stateDir,
    });
    const persisted = fs.readFileSync(path.join(stateDir, "feedback", `${workspace.id}.json`), "utf8");
    expect(persisted).not.toContain(old.credential);
    expectCode(() => confirmRouteAttestation({
      workspaceId: workspace.id,
      principal: principalA(),
      challengeId: started.routeAttestation.challengeId,
      challengeDigest: started.routeAttestation.challengeDigest,
      stateDir,
    }), "FEEDBACK_PRINCIPAL_MISMATCH");
    expectCode(() => completeCompanionRebind({
      workspaceId: workspace.id,
      credential: old.credential,
      challengeId: started.routeAttestation.challengeId,
      routeCanonical: ROUTE_B,
      stateDir,
    }), "COMPANION_REBIND_NOT_CONFIRMED");

    confirmRouteAttestation({
      workspaceId: workspace.id,
      principal: principalB(),
      challengeId: started.routeAttestation.challengeId,
      challengeDigest: started.routeAttestation.challengeDigest,
      stateDir,
    });
    const completed = completeCompanionRebind({
      workspaceId: workspace.id,
      credential: old.credential,
      challengeId: started.routeAttestation.challengeId,
      routeCanonical: ROUTE_B,
      stateDir,
    });
    const current = verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: completed.credential,
      stateDir,
    });
    expect(current).toMatchObject({ epoch: old.epoch + 1, routeCanonical: ROUTE_B, routeVerified: true });
    expectCode(() => verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: old.credential,
      stateDir,
    }), "COMPANION_UNAUTHORIZED");
  });

  it("rebind readiness treats only unconsumed, unexpired intents as active", () => {
    setupReadyEvent("g4-rebind-lifecycle");
    const old = pairCompanion();
    takeoverReceiver({
      workspaceId: workspace.id,
      principal: principalB(),
      widgetId: "widget-B",
      expectedEpoch: old.epoch,
      stateDir,
    });

    const readiness = () => companionBootstrapReadiness({
      workspaceId: workspace.id,
      principal: principalB(),
      stateDir,
    });
    const stateFile = path.join(stateDir, "feedback", `${workspace.id}.json`);
    const expireIntent = () => {
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
        rebindIntent: { expiresAt: string; routeAttestation: { expiresAt: string } };
      };
      const expiredAt = new Date(Date.now() - 1_000).toISOString();
      state.rebindIntent.expiresAt = expiredAt;
      state.rebindIntent.routeAttestation.expiresAt = expiredAt;
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    };

    expect(readiness()).toMatchObject({
      state: "OWNED_NEEDS_BROWSER_REBIND",
      rebindAvailable: true,
      rebindState: "NONE",
    });

    const pending = initiateCompanionRebind({
      workspaceId: workspace.id,
      credential: old.credential,
      routeCanonical: ROUTE_B,
      stateDir,
    });
    expect(readiness()).toMatchObject({ rebindAvailable: false, rebindState: "PENDING" });

    expireIntent();
    expect(readiness()).toMatchObject({ rebindAvailable: true, rebindState: "NONE" });

    const retryAfterPendingExpiry = initiateCompanionRebind({
      workspaceId: workspace.id,
      credential: old.credential,
      routeCanonical: ROUTE_B,
      stateDir,
    });
    expect(retryAfterPendingExpiry.routeAttestation.challengeId)
      .not.toBe(pending.routeAttestation.challengeId);
    confirmRouteAttestation({
      workspaceId: workspace.id,
      principal: principalB(),
      challengeId: retryAfterPendingExpiry.routeAttestation.challengeId,
      challengeDigest: retryAfterPendingExpiry.routeAttestation.challengeDigest,
      stateDir,
    });
    expect(readiness()).toMatchObject({ rebindAvailable: false, rebindState: "CONFIRMED" });

    const consumed = JSON.parse(fs.readFileSync(stateFile, "utf8")) as { rebindIntent: { consumedAt?: string } };
    consumed.rebindIntent.consumedAt = new Date().toISOString();
    fs.writeFileSync(stateFile, JSON.stringify(consumed, null, 2));
    expect(readiness()).toMatchObject({ rebindAvailable: true, rebindState: "NONE" });

    expireIntent();
    expect(readiness()).toMatchObject({ rebindAvailable: true, rebindState: "NONE" });

    const retryAfterConfirmedExpiry = initiateCompanionRebind({
      workspaceId: workspace.id,
      credential: old.credential,
      routeCanonical: ROUTE_B,
      stateDir,
    });
    confirmRouteAttestation({
      workspaceId: workspace.id,
      principal: principalB(),
      challengeId: retryAfterConfirmedExpiry.routeAttestation.challengeId,
      challengeDigest: retryAfterConfirmedExpiry.routeAttestation.challengeDigest,
      stateDir,
    });
    const completed = completeCompanionRebind({
      workspaceId: workspace.id,
      credential: old.credential,
      challengeId: retryAfterConfirmedExpiry.routeAttestation.challengeId,
      routeCanonical: ROUTE_B,
      stateDir,
    });
    expect(completed.routeVerification).toBe("VERIFIED");
    expect(readiness()).toMatchObject({
      state: "OWNED_VERIFIED",
      companionPresent: true,
      routeVerification: "VERIFIED",
      rebindAvailable: false,
      rebindState: "NONE",
    });
    const stored = readFeedbackState(workspace.id, stateDir);
    expect(stored.rebindIntent?.consumedAt).toBeDefined();
    expect(stored.rebindPredecessor).toBeNull();
  });

  it("rebind rejects non-successor and duplicate initiation", () => {
    setupReadyEvent("g4-rebind-guards");
    const old = pairCompanion();
    expectCode(() => initiateCompanionRebind({
      workspaceId: workspace.id,
      credential: old.credential,
      routeCanonical: ROUTE_B,
      stateDir,
    }), "COMPANION_REBIND_NOT_SUCCESSOR");
    takeoverReceiver({
      workspaceId: workspace.id,
      principal: principalB(),
      widgetId: "widget-B",
      expectedEpoch: old.epoch,
      stateDir,
    });
    initiateCompanionRebind({
      workspaceId: workspace.id,
      credential: old.credential,
      routeCanonical: ROUTE_B,
      stateDir,
    });
    expectCode(() => initiateCompanionRebind({
      workspaceId: workspace.id,
      credential: old.credential,
      routeCanonical: ROUTE_B,
      stateDir,
    }), "COMPANION_REBIND_ALREADY_INITIATED");
  });

  it("rebind init fails closed when current binding has claimed work", () => {
    setupReadyEvent("g4-rebind-inflight");
    const old = pairCompanion();
    const taken = takeoverReceiver({
      workspaceId: workspace.id,
      principal: principalB(),
      widgetId: "widget-B",
      expectedEpoch: old.epoch,
      stateDir,
    }).state.binding!;
    claimNext({
      workspaceId: workspace.id,
      principal: principalB(),
      bindingId: taken.bindingId,
      epoch: taken.epoch,
      stateDir,
    });
    expectCode(() => initiateCompanionRebind({
      workspaceId: workspace.id,
      credential: old.credential,
      routeCanonical: ROUTE_B,
      stateDir,
    }), "COMPANION_REPAIR_BLOCKED");
  });
});

describe("route normalization", () => {
  it("接受 canonical chatgpt.com/c/<uuid>", () => {
    expect(normalizeChatgptRoute(ROUTE)).toBe(ROUTE);
    expect(normalizeChatgptRoute(ROUTE + "/")).toBe(ROUTE);
    expect(normalizeChatgptRoute("https://ChatGPT.com/c/11111111-1111-4111-8111-111111111111"))
      .toBe(ROUTE);
  });

  it("拒绝非 chatgpt / 非 /c / query", () => {
    expectCode(() => normalizeChatgptRoute("https://chat.openai.com/c/11111111-1111-4111-8111-111111111111"), "ROUTE_INVALID");
    expectCode(() => normalizeChatgptRoute("https://chatgpt.com/c/11111111-1111-4111-8111-111111111111?x=1"), "ROUTE_INVALID");
    expectCode(() => normalizeChatgptRoute("https://chatgpt.com/chat/abc"), "ROUTE_INVALID");
  });
});

describe("pairing / credential security", () => {
  it("错误 principal 不能 pair", () => {
    setupReadyEvent();
    expect(() => createPairingIntent({
      workspaceId: workspace.id,
      principal: principalB(),
      stateDir,
    })).toThrow(/不一致|mismatch|主体/i);
  });

  it("intent 一次性消费；过期拒绝；secret 只存 hash", () => {
    setupReadyEvent();
    const intent = createPairingIntent({
      workspaceId: workspace.id,
      principal: principalA(),
      stateDir,
    });
    const exchanged = exchangePairingIntent({
      workspaceId: workspace.id,
      intentId: intent.intentId,
      secret: intent.secret,
      routeCanonical: ROUTE,
      stateDir,
    });
    expect(exchanged.credential.startsWith("c2c_comp_")).toBe(true);
    expectCode(() => exchangePairingIntent({
      workspaceId: workspace.id,
      intentId: intent.intentId,
      secret: intent.secret,
      routeCanonical: ROUTE,
      stateDir,
    }), "PAIRING_CONSUMED");

    const raw = fs.readFileSync(
      path.join(stateDir, "feedback", `${workspace.id}.json`),
      "utf8",
    );
    expect(raw).not.toContain(intent.secret);
    expect(raw).not.toContain(exchanged.credential);
    expect(raw).not.toContain("openai/session");

    const expired = createPairingIntent({
      workspaceId: workspace.id,
      principal: principalA(),
      stateDir,
      ttlMs: 1,
      nowMs: Date.now() - 10_000,
    });
    expectCode(() => exchangePairingIntent({
      workspaceId: workspace.id,
      intentId: expired.intentId,
      secret: expired.secret,
      routeCanonical: ROUTE,
      stateDir,
      nowMs: Date.now(),
    }), "PAIRING_EXPIRED");
  });

  it("错误 route 拒绝；wrong credential 拒绝；re-pair supersede 旧 credential", () => {
    setupReadyEvent();
    const first = pairCompanion();
    expectCode(() => verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: "c2c_comp_wrong",
      stateDir,
    }), "COMPANION_UNAUTHORIZED");

    const second = pairCompanion();
    expect(second.companionId).not.toBe(first.companionId);
    expectCode(() => verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: first.credential,
      stateDir,
    }), "COMPANION_UNAUTHORIZED");
    expect(verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: second.credential,
      stateDir,
    }).routeCanonical).toBe(ROUTE);
  });

  it("takeover 后旧 epoch companion 拒绝", () => {
    setupReadyEvent();
    const paired = pairCompanion();
    const ctx = verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: paired.credential,
      stateDir,
    });
    // 先 release 无 reserved；takeover 需要无 reserved/claimed/outcome_unknown
    takeoverReceiver({
      workspaceId: workspace.id,
      principal: principalB(),
      widgetId: "wB",
      expectedEpoch: 1,
      stateDir,
    });
    try {
      verifyCompanionCredential({
        workspaceId: workspace.id,
        credential: paired.credential,
        stateDir,
      });
      expect.unreachable("old companion must be rejected");
    } catch (e) {
      expect(["COMPANION_UNAUTHORIZED", "COMPANION_EPOCH_STALE", "FEEDBACK_NOT_ENABLED"])
        .toContain((e as { code?: string }).code);
    }
    expect(ctx.epoch).toBe(1);
  });

  it("错误 companion route 操作拒绝", () => {
    setupReadyEvent();
    const paired = pairCompanion(ROUTE);
    const ctx = verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: paired.credential,
      stateDir,
    });
    expectCode(() => companionReserveNext({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE_B,
      stateDir,
    }), "ROUTE_MISMATCH");
  });

  it("revoke 后 credential 失效", () => {
    setupReadyEvent();
    const paired = pairCompanion();
    expect(revokeCompanion({
      workspaceId: workspace.id,
      principal: principalA(),
      stateDir,
    }).revoked).toBe(true);
    expectCode(() => verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: paired.credential,
      stateDir,
    }), "COMPANION_UNAUTHORIZED");
  });

  it("companion status 不暴露 secret", () => {
    setupReadyEvent();
    const intent = createPairingIntent({
      workspaceId: workspace.id,
      principal: principalA(),
      stateDir,
    });
    const status = companionStatusForPrincipal({
      workspaceId: workspace.id,
      principal: principalA(),
      stateDir,
    });
    expect(JSON.stringify(status)).not.toContain(intent.secret);
    expect(status.pairingIntentActive).toBe(true);
  });
});

describe("reserved state machine", () => {
  it("ready → reserved → begin-send → claimed → observed", () => {
    const event = setupReadyEvent();
    const paired = pairCompanion();
    const ctx = verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: paired.credential,
      stateDir,
    });

    const reserved = companionReserveNext({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      stateDir,
    });
    expect(reserved.delivery.status).toBe("reserved");
    // 公网 DTO 不得含 principal fingerprint / targetBindingId / reservedBy
    const reservedJson = JSON.stringify(reserved);
    expect(reservedJson).not.toContain("principalFingerprint");
    expect(reservedJson).not.toContain("targetBindingId");
    expect(reservedJson).not.toContain("reservedBy");
    expect(reservedJson).not.toContain("openai/session");

    // reserved 不能被 MCP claimNext 抢走
    expectCode(() => claimNext({
      workspaceId: workspace.id,
      principal: principalA(),
      bindingId: ctx.bindingId,
      epoch: ctx.epoch,
      stateDir,
    }), "FEEDBACK_NO_READY_EVENT");

    // reserved 阻止 takeover
    expectCode(() => takeoverReceiver({
      workspaceId: workspace.id,
      principal: principalB(),
      widgetId: "wB",
      expectedEpoch: ctx.epoch,
      stateDir,
    }), "FEEDBACK_TAKEOVER_BLOCKED");

    const sent = companionBeginSend({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      stateDir,
    });
    expect(sent.event.status).toBe("claimed");
    expect(sent.attemptId).toBe(sent.event.attemptId);

    // claimed 后 release 不可能
    expectCode(() => companionRelease({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      stateDir,
    }), "FEEDBACK_RESERVATION_MISMATCH");

    // claimed 后 takeover 阻止
    expectCode(() => takeoverReceiver({
      workspaceId: workspace.id,
      principal: principalB(),
      widgetId: "wB",
      expectedEpoch: ctx.epoch,
      stateDir,
    }), "FEEDBACK_TAKEOVER_BLOCKED");

    const observed = companionAckObserved({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      attemptId: sent.attemptId,
      stateDir,
    });
    expect(observed.status).toBe("observed");

    // duplicate exact ACK 幂等
    const again = companionAckObserved({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      attemptId: sent.attemptId,
      stateDir,
    });
    expect(again.status).toBe("observed");
  });

  it("reserved → release → ready；fence 竞争 reservation", () => {
    const event = setupReadyEvent();
    const paired = pairCompanion();
    const ctx = verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: paired.credential,
      stateDir,
    });
    const reserved = companionReserveNext({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      stateDir,
    });
    expectCode(() => companionReserveNext({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      stateDir,
    }), "FEEDBACK_INFLIGHT_FENCE");

    const released = companionRelease({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      stateDir,
    });
    expect(released.status).toBe("ready");

    const again = companionReserveNext({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      stateDir,
    });
    expect(again.delivery.status).toBe("reserved");
  });

  it("stale reserved 安全恢复为 ready", () => {
    setupReadyEvent("stale-r");
    const paired = pairCompanion();
    const ctx = verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: paired.credential,
      stateDir,
    });
    companionReserveNext({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      stateDir,
    });
    // 直接把 reservedAt 拨回过去
    const file = path.join(stateDir, "feedback", `${workspace.id}.json`);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    state.events[0].reservedAt = new Date(Date.now() - FEEDBACK_RESERVATION_STALE_MS - 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(state, null, 2));

    const st = companionPublicState({
      workspaceId: workspace.id,
      ctx,
      stateDir,
    });
    expect(st.pendingReady).toBe(1);
    expect(st.reserved).toBe(0);
  });

  it("wrong attemptId / eventId 不能 ACK", () => {
    const event = setupReadyEvent();
    const paired = pairCompanion();
    const ctx = verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: paired.credential,
      stateDir,
    });
    const reserved = companionReserveNext({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      stateDir,
    });
    const sent = companionBeginSend({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      stateDir,
    });
    expectCode(() => companionAckObserved({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      attemptId: "99999999-9999-4999-8999-999999999999",
      stateDir,
    }), "FEEDBACK_ACK_MISMATCH");
    expectCode(() => companionAckObserved({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: "ffffffffffffffffffffffffffffffff",
      attemptId: sent.attemptId,
      stateDir,
    }), "FEEDBACK_EVENT_NOT_FOUND");
  });

  it("MCP claimNext 仍可直接 ready→claimed；与 reserved 路径互斥", () => {
    const event = setupReadyEvent();
    const binding = readFeedbackState(workspace.id, stateDir).binding!;
    const claimed = claimNext({
      workspaceId: workspace.id,
      principal: principalA(),
      bindingId: binding.bindingId,
      epoch: binding.epoch,
      stateDir,
    });
    expect(claimed.event.status).toBe("claimed");
    const acked = ackObserved({
      workspaceId: workspace.id,
      principal: principalA(),
      bindingId: binding.bindingId,
      epoch: binding.epoch,
      eventId: event.eventId,
      attemptId: claimed.attemptId,
      stateDir,
    });
    expect(acked.status).toBe("observed");
  });

  it("P1：claimed 后 re-pair fail closed；B 不能继承 A 的 attempt", () => {
    const event = setupReadyEvent("inherit-cmd");
    const pairedA = pairCompanion(ROUTE);
    const ctxA = verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: pairedA.credential,
      stateDir,
    });
    const reserved = companionReserveNext({
      workspaceId: workspace.id,
      ctx: ctxA,
      routeCanonical: ROUTE,
      stateDir,
    });
    const sentA = companionBeginSend({
      workspaceId: workspace.id,
      ctx: ctxA,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      stateDir,
    });
    expect(sentA.event.status).toBe("claimed");

    // re-pair B 到 route B：必须 fail closed（transport takeover 门禁）
    expectCode(() => pairCompanion(ROUTE_B), "COMPANION_REPAIR_BLOCKED");

    // 即使伪造一个 B 上下文（同 binding/epoch，不同 companionId），也不得 begin-send/ACK A 的 attempt
    const forgedB = {
      workspaceId: workspace.id,
      companionId: "99999999-9999-4999-8999-999999999999",
      bindingId: ctxA.bindingId,
      epoch: ctxA.epoch,
      principalFingerprint: ctxA.principalFingerprint,
      routeCanonical: ROUTE,
      routeVerified: false,
    };
    try {
      companionBeginSend({
        workspaceId: workspace.id,
        ctx: forgedB as never,
        routeCanonical: ROUTE,
        eventId: event.eventId,
        reservationId: reserved.reservationId,
        stateDir,
      });
      expect.unreachable("forged B must fail");
    } catch (e) {
      expect(["COMPANION_ROUTE_UNVERIFIED", "COMPANION_UNAUTHORIZED", "FEEDBACK_RESERVATION_MISMATCH"])
        .toContain((e as { code?: string }).code);
    }
    try {
      companionAckObserved({
        workspaceId: workspace.id,
        ctx: forgedB as never,
        routeCanonical: ROUTE,
        eventId: event.eventId,
        attemptId: sentA.attemptId,
        stateDir,
      });
      expect.unreachable("forged B ack must fail");
    } catch (e) {
      expect(["COMPANION_ROUTE_UNVERIFIED", "COMPANION_UNAUTHORIZED", "FEEDBACK_ACK_MISMATCH"])
        .toContain((e as { code?: string }).code);
    }
  });

  it("P1：MCP 直接 claim 的事件 companion 不能冒充 ACK", () => {
    const event = setupReadyEvent("mcp-claim-cmd");
    const binding = readFeedbackState(workspace.id, stateDir).binding!;
    const claimed = claimNext({
      workspaceId: workspace.id,
      principal: principalA(),
      bindingId: binding.bindingId,
      epoch: binding.epoch,
      stateDir,
    });
    // re-pair 在 claimed 时被拒绝
    expectCode(() => pairCompanion(), "COMPANION_REPAIR_BLOCKED");

    // release 后无 in-flight，才能 pair
    // MCP claimed 不能 release；直接用另一事件路径：先观察
    ackObserved({
      workspaceId: workspace.id,
      principal: principalA(),
      bindingId: binding.bindingId,
      epoch: binding.epoch,
      eventId: event.eventId,
      attemptId: claimed.attemptId,
      stateDir,
    });
    // observed 不算 in-flight，可以 pair
    const paired = pairCompanion();
    const ctx = verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: paired.credential,
      stateDir,
    });
    expectCode(() => companionAckObserved({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      attemptId: claimed.attemptId,
      stateDir,
    }), "FEEDBACK_ACK_MISMATCH");
  });

  it("P2：/state 仅返回当前 binding 事件；不含 principalFingerprint", () => {
    setupReadyEvent("scoped-1");
    const paired = pairCompanion();
    const ctx = verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: paired.credential,
      stateDir,
    });
    const st = companionPublicState({
      workspaceId: workspace.id,
      ctx,
      stateDir,
    });
    expect(st.pendingReady).toBe(1);
    const json = JSON.stringify(st);
    expect(json).not.toContain("principalFingerprint");
    expect(json).not.toContain("targetBindingId");
    expect(json).not.toContain("reservedBy");
    expect(json).not.toContain(ctx.principalFingerprint);
  });
});

describe("E1b3a single-flight fence", () => {
  function pairCtx(route = ROUTE) {
    const paired = pairCompanion(route);
    return verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: paired.credential,
      stateDir,
    });
  }

  it("claimed 阻止 later ready 的 reserve", () => {
    const event = setupReadyEvent("fence-claimed");
    const ctx = pairCtx();
    const reserved = companionReserveNext({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      stateDir,
    });
    companionBeginSend({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      stateDir,
    });
    seedTrustedReceipt("fence-later-ready");
    reconcileFeedbackOutbox(workspace.id, stateDir);
    expectCode(() => companionReserveNext({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      stateDir,
    }), "FEEDBACK_INFLIGHT_FENCE");
  });

  it("outcome_unknown 阻止 later ready 的 reserve", () => {
    const event = setupReadyEvent("fence-unknown");
    const ctx = pairCtx();
    const reserved = companionReserveNext({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      stateDir,
    });
    companionBeginSend({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      stateDir,
    });
    const file = path.join(stateDir, "feedback", `${workspace.id}.json`);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    state.events[0].claimedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(state, null, 2));

    seedTrustedReceipt("fence-unknown-later");
    reconcileFeedbackOutbox(workspace.id, stateDir);
    expectCode(() => companionReserveNext({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      stateDir,
    }), "FEEDBACK_INFLIGHT_FENCE");
  });

  it("stale reserved 恢复为 ready 后可以继续 reserve", () => {
    setupReadyEvent("stale-r-2");
    const ctx = pairCtx();
    companionReserveNext({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      stateDir,
    });
    const file = path.join(stateDir, "feedback", `${workspace.id}.json`);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    state.events[0].reservedAt = new Date(Date.now() - FEEDBACK_RESERVATION_STALE_MS - 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(state, null, 2));

    const again = companionReserveNext({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      stateDir,
    });
    expect(again.delivery.status).toBe("reserved");
  });
});

describe("E1b3a canonical production feedback message", () => {
  it("begin-send 返回 deterministic message；exact retry byte-identical", () => {
    const event = setupReadyEvent("msg-cmd");
    const ctx = (() => {
      const paired = pairCompanion();
      return verifyCompanionCredential({
        workspaceId: workspace.id,
        credential: paired.credential,
        stateDir,
      });
    })();
    const reserved = companionReserveNext({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      stateDir,
    });
    const first = companionBeginSend({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      stateDir,
    });
    const second = companionBeginSend({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      stateDir,
    });
    expect(first.attemptId).toBe(second.attemptId);
    expect(first.message).toBe(second.message);
    expect(first.messageSha256).toBe(second.messageSha256);
    expect(first.message).toContain("[C2C_CONTROL]");
    expect(first.message).toContain("STATE: EXECUTED");
    expect(first.message).toContain(`WORKSPACE_ID: ${workspace.id}`);
    expect(first.message).toContain(`EVENT_ID: ${event.eventId}`);
    expect(first.message).toContain(`ATTEMPT_ID: ${first.attemptId}`);
    expect(first.message).toContain("CHANGED_FILES:");
    expect(first.message).toContain("TESTS:");
    expect(first.message).toContain("OUTPUT_AVAILABLE:");
    expect(first.message).toContain("INSTRUCTION:");
    // Public DTO / message must not leak internal identity material.
    // (Raw FeedbackEvent is server-internal; HTTP response only uses public fields.)
    expect(first.message).not.toContain("principalFingerprint");
    expect(first.message).not.toContain("reservedBy");
    expect(first.message).not.toContain("targetBindingId");
    expect(first.message).not.toContain("openai/session");
    expect(first.message).not.toContain(ctx.principalFingerprint);

    // /state claimed inFlight carries the same canonical message.
    const st = companionPublicState({
      workspaceId: workspace.id,
      ctx,
      stateDir,
    });
    const inFlight = st.inFlight as Record<string, unknown>;
    expect(inFlight.status).toBe("claimed");
    expect(inFlight.message).toBe(first.message);
    expect(inFlight.messageSha256).toBe(first.messageSha256);
    expect(inFlight.attemptId).toBe(first.attemptId);
  });

  it("claimed stale → outcome_unknown 后 /state 仍恢复 message + attempt，且不得重发", () => {
    const event = setupReadyEvent("unknown-msg");
    const paired = pairCompanion();
    const ctx = verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: paired.credential,
      stateDir,
    });
    const reserved = companionReserveNext({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      stateDir,
    });
    const sent = companionBeginSend({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      stateDir,
    });
    const file = path.join(stateDir, "feedback", `${workspace.id}.json`);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    state.events[0].claimedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(state, null, 2));

    const st = companionPublicState({
      workspaceId: workspace.id,
      ctx,
      stateDir,
    });
    expect(st.outcomeUnknown).toBe(1);
    const inFlight = st.inFlight as Record<string, unknown>;
    expect(inFlight.status).toBe("outcome_unknown");
    expect(inFlight.eventId).toBe(event.eventId);
    expect(inFlight.attemptId).toBe(sent.attemptId);
    expect(inFlight.message).toBe(sent.message);
    expect(inFlight.messageSha256).toBe(sent.messageSha256);
    const json = JSON.stringify(st);
    expect(json).not.toContain("reservedBy");
    expect(json).not.toContain("principalFingerprint");
  });
});

describe("E1b3a late positive ACK", () => {
  it("ACK response-loss contract: observed inFlight=null; journal retry_ack; idempotent ACK", () => {
    // 1) reserve
    const event = setupReadyEvent("ack-lost");
    const paired = pairCompanion();
    const ctx = verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: paired.credential,
      stateDir,
    });
    const reserved = companionReserveNext({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      stateDir,
    });
    // 2) begin-send → claimed
    const sent = companionBeginSend({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      stateDir,
    });
    // 3) local journal → OBSERVED_PENDING_ACK (pure only; no DOM)
    let journal = emptyJournal();
    journal = markReserveRequested(journal, {
      routeCanonical: ROUTE,
      bindingId: ctx.bindingId,
      epoch: ctx.epoch,
    });
    journal = markReserved(journal, {
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      routeCanonical: ROUTE,
      bindingId: ctx.bindingId,
      epoch: ctx.epoch,
    });
    journal = markSendIntent(journal, {
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      routeCanonical: ROUTE,
      bindingId: ctx.bindingId,
      epoch: ctx.epoch,
    });
    journal = markClaimed(journal, {
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      attemptId: sent.attemptId,
      message: sent.message,
      messageSha256: sent.messageSha256,
    });
    journal = markComposerWriteIntent(journal, { attemptId: sent.attemptId });
    journal = markSendDispatchIntent(journal, { attemptId: sent.attemptId });
    journal = markObservedPendingAck(journal, { attemptId: sent.attemptId });
    expect(journal.state).toBe("OBSERVED_PENDING_ACK");

    // 4) server ACK success (response lost to client)
    companionAckObserved({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      attemptId: sent.attemptId,
      stateDir,
    });

    // 5) real contract: observed → inFlight === null
    const st = companionPublicState({
      workspaceId: workspace.id,
      ctx,
      stateDir,
    });
    expect(st.inFlight).toBeNull();

    // 6) reconcile: retry_ack (idempotent ACK, never resend)
    const rec = reconcileSendJournal(journal, st.inFlight);
    expect(rec.action).toBe("retry_ack");

    // 7) duplicate exact ACK still observed
    const again = companionAckObserved({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      attemptId: sent.attemptId,
      stateDir,
    });
    expect(again.status).toBe("observed");

    // 8) after successful ACK response, journal can clear
    const cleared = clearJournal();
    expect(cleared.state).toBe("NONE");
  });

  it("exact late ACK：outcome_unknown → observed", () => {
    const event = setupReadyEvent("late-ack");
    const paired = pairCompanion();
    const ctx = verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: paired.credential,
      stateDir,
    });
    const reserved = companionReserveNext({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      stateDir,
    });
    const sent = companionBeginSend({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      stateDir,
    });
    const file = path.join(stateDir, "feedback", `${workspace.id}.json`);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    state.events[0].claimedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(state, null, 2));

    const observed = companionAckObserved({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      attemptId: sent.attemptId,
      stateDir,
    });
    expect(observed.status).toBe("observed");

    // observed duplicate ACK idempotent
    const again = companionAckObserved({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      attemptId: sent.attemptId,
      stateDir,
    });
    expect(again.status).toBe("observed");
  });

  it("wrong attempt late ACK rejected；different companion late ACK rejected", () => {
    const event = setupReadyEvent("late-ack-bad");
    const paired = pairCompanion();
    const ctx = verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: paired.credential,
      stateDir,
    });
    const reserved = companionReserveNext({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      stateDir,
    });
    const sent = companionBeginSend({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      stateDir,
    });
    const file = path.join(stateDir, "feedback", `${workspace.id}.json`);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    state.events[0].claimedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(state, null, 2));

    expectCode(() => companionAckObserved({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      attemptId: "99999999-9999-4999-8999-999999999999",
      stateDir,
    }), "FEEDBACK_ACK_MISMATCH");

    const forged = {
      workspaceId: workspace.id,
      companionId: "99999999-9999-4999-8999-999999999999",
      bindingId: ctx.bindingId,
      epoch: ctx.epoch,
      principalFingerprint: ctx.principalFingerprint,
      routeCanonical: ROUTE,
    };
    expectCode(() => companionAckObserved({
      workspaceId: workspace.id,
      ctx: forged,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      attemptId: sent.attemptId,
      stateDir,
    }), "FEEDBACK_ACK_MISMATCH");
  });
});

describe("E1b3d3b outcome_unknown retirement", () => {
  function setupOutcomeUnknown(commandId = "cmd-retire") {
    const event = setupReadyEvent(commandId);
    const paired = pairCompanion();
    const ctx = verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: paired.credential,
      stateDir,
    });
    const reserved = companionReserveNext({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      stateDir,
    });
    const sent = companionBeginSend({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      stateDir,
    });
    // Force claimed → outcome_unknown via stale recovery.
    const file = path.join(stateDir, "feedback", `${workspace.id}.json`);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    state.events[0].claimedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
    // Trigger recoverStale via public state read.
    companionPublicState({ workspaceId: workspace.id, ctx, stateDir });
    return { event, ctx, reserved, sent };
  }

  it("A. exact outcome_unknown → retired_unknown", () => {
    const { event, ctx, reserved, sent } = setupOutcomeUnknown();
    const retired = companionRetireOutcomeUnknown({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      attemptId: sent.attemptId,
      stateDir,
    });
    expect(retired.status).toBe("retired_unknown");
    expect(retired.eventId).toBe(event.eventId);
    expect(retired.reservationId).toBe(reserved.reservationId);
    expect(retired.attemptId).toBe(sent.attemptId);
    expect(retired.reservedBy).toBe(ctx.companionId);
    expect(retired.claimedAt).toBeTruthy();
    expect(retired.retiredAt).toBeTruthy();
    // Not in-flight.
    const st = companionPublicState({ workspaceId: workspace.id, ctx, stateDir });
    expect(st.inFlight).toBeNull();
    expect(st.retiredUnknown).toBe(1);
    expect(st.outcomeUnknown).toBe(0);
  });

  it("B. mismatch rejected", () => {
    const { event, ctx, reserved, sent } = setupOutcomeUnknown("cmd-mismatch");
    const base = {
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      attemptId: sent.attemptId,
      stateDir,
    };
    expectCode(() => companionRetireOutcomeUnknown({
      ...base, eventId: "f".repeat(32),
    }), "FEEDBACK_EVENT_NOT_FOUND");
    expectCode(() => companionRetireOutcomeUnknown({
      ...base, attemptId: "99999999-9999-4999-8999-999999999999",
    }), "FEEDBACK_RETIRE_MISMATCH");
    expectCode(() => companionRetireOutcomeUnknown({
      ...base, reservationId: "99999999-9999-4999-8999-999999999999",
    }), "FEEDBACK_RETIRE_MISMATCH");
    // Wrong route
    expectCode(() => companionRetireOutcomeUnknown({
      ...base, routeCanonical: ROUTE_B,
    }), "ROUTE_MISMATCH");
    // Wrong companion: forge a different companionId against the same event.
    const forged = { ...ctx, companionId: "99999999-9999-4999-8999-999999999999" };
    expectCode(() => companionRetireOutcomeUnknown({
      ...base, ctx: forged,
    }), "FEEDBACK_RETIRE_MISMATCH");
  });

  it("C. non-outcome_unknown statuses rejected", () => {
    const event = setupReadyEvent("cmd-not-unknown");
    const paired = pairCompanion();
    const ctx = verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: paired.credential,
      stateDir,
    });
    // ready → reject
    expectCode(() => companionRetireOutcomeUnknown({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      reservationId: "11111111-1111-4111-8111-111111111111",
      attemptId: "22222222-2222-4222-8222-222222222222",
      stateDir,
    }), "FEEDBACK_RETIRE_MISMATCH");
    // reserved → reject
    const reserved = companionReserveNext({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      stateDir,
    });
    expectCode(() => companionRetireOutcomeUnknown({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      attemptId: "22222222-2222-4222-8222-222222222222",
      stateDir,
    }), "FEEDBACK_RETIRE_MISMATCH");
    // claimed → reject
    const sent = companionBeginSend({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      stateDir,
    });
    expectCode(() => companionRetireOutcomeUnknown({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      attemptId: sent.attemptId,
      stateDir,
    }), "FEEDBACK_RETIRE_MISMATCH");
    // observed → reject
    companionAckObserved({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      attemptId: sent.attemptId,
      stateDir,
    });
    expectCode(() => companionRetireOutcomeUnknown({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      attemptId: sent.attemptId,
      stateDir,
    }), "FEEDBACK_RETIRE_MISMATCH");
  });

  it("D. idempotent exact retry succeeds; different attempt fails", () => {
    const { event, ctx, reserved, sent } = setupOutcomeUnknown("cmd-idem");
    const first = companionRetireOutcomeUnknown({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      attemptId: sent.attemptId,
      stateDir,
    });
    expect(first.status).toBe("retired_unknown");
    const again = companionRetireOutcomeUnknown({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      attemptId: sent.attemptId,
      stateDir,
    });
    expect(again.status).toBe("retired_unknown");
    expectCode(() => companionRetireOutcomeUnknown({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      attemptId: "99999999-9999-4999-8999-999999999999",
      stateDir,
    }), "FEEDBACK_RETIRE_MISMATCH");
  });

  it("E. retired_unknown no longer fences later ready event", () => {
    const { event, ctx, reserved, sent } = setupOutcomeUnknown("cmd-fence");
    companionRetireOutcomeUnknown({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      attemptId: sent.attemptId,
      stateDir,
    });
    // Seed a second ready event.
    seedTrustedReceipt("cmd-after-retire");
    reconcileFeedbackOutbox(workspace.id, stateDir);
    const next = companionReserveNext({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      stateDir,
    });
    expect(next.delivery.status).toBe("reserved");
    expect(next.delivery.eventId).not.toBe(event.eventId);
  });

  it("F. retired event never returns ready; takeover allowed; late ACK rejected", () => {
    const { event, ctx, reserved, sent } = setupOutcomeUnknown("cmd-perm");
    companionRetireOutcomeUnknown({
      workspaceId: workspace.id,
      ctx,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      attemptId: sent.attemptId,
      stateDir,
    });
    // Stale recovery must not revive.
    const state = readFeedbackState(workspace.id, stateDir);
    const still = state.events.find((e) => e.eventId === event.eventId);
    expect(still?.status).toBe("retired_unknown");
    // Takeover allowed (retired_unknown is not a takeover fence).
    const takeover = takeoverReceiver({
      workspaceId: workspace.id,
      principal: principalA(),
      widgetId: "w2",
      expectedEpoch: ctx.epoch,
      stateDir,
    });
    expect(takeover.state.binding?.epoch).toBe(ctx.epoch + 1);
    // Late ACK after retirement rejected.
    const ctx2 = verifyCompanionCredential({
      workspaceId: workspace.id,
      credential: pairCompanion().credential,
      stateDir,
    });
    expectCode(() => companionAckObserved({
      workspaceId: workspace.id,
      ctx: ctx2,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      attemptId: sent.attemptId,
      stateDir,
    }), "FEEDBACK_ACK_MISMATCH");
  });

  it("store-level retireOutcomeUnknown requires exact identity", () => {
    const { event, ctx, reserved, sent } = setupOutcomeUnknown("cmd-store");
    const base = {
      workspaceId: workspace.id,
      bindingId: ctx.bindingId,
      epoch: ctx.epoch,
      principalFingerprint: ctx.principalFingerprint,
      companionId: ctx.companionId,
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      attemptId: sent.attemptId,
      stateDir,
    };
    expectCode(() => retireOutcomeUnknown({
      ...base, bindingId: "99999999-9999-4999-8999-999999999999",
    }), "FEEDBACK_EPOCH_STALE");
    expectCode(() => retireOutcomeUnknown({
      ...base, companionId: "99999999-9999-4999-8999-999999999999",
    }), "FEEDBACK_RETIRE_MISMATCH");
    const ok = retireOutcomeUnknown(base);
    expect(ok.status).toBe("retired_unknown");
  });
});

describe("public companion HTTP surface", () => {
  let bridge: Bridge;
  let base: string;
  let previousStateDir: string | undefined;

  async function fetchJson(pathname: string, init?: RequestInit) {
    const res = await fetch(`${base}${pathname}`, init);
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  beforeEach(async () => {
    previousStateDir = process.env.C2C_STATE_DIR;
    process.env.C2C_STATE_DIR = stateDir;
    bridge = await startBridge({
      workspaceRoot: wsRoot,
      port: 0,
      persistRuntime: false,
      runtimeBuildId: null,
      authStoreFile: path.join(stateDir, "auth", "test-auth.json"),
    });
    base = bridge.localBaseUrl();
  });

  afterEach(async () => {
    await bridge.close();
    if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousStateDir;
  });

  async function enableAndSeed() {
    reconcileFeedbackOutbox(workspace.id, stateDir);
    seedTrustedReceipt("http-cmd");
    reconcileFeedbackOutbox(workspace.id, stateDir);
    // enable 需要 principal；在 HTTP 路径下用 store 直接 enable
    enableReceiver({
      workspaceId: workspace.id,
      principal: principalA(),
      widgetId: "w",
      stateDir,
    });
  }

  it("pairing 流程 + reserve/begin-send/ack；companion 不能访问 admin/mcp", async () => {
    await enableAndSeed();
    const intent = createPairingIntent({
      workspaceId: workspace.id,
      principal: principalA(),
      stateDir,
    });

    const paired = await fetchJson("/api/companion/v1/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intentId: intent.intentId,
        secret: intent.secret,
        routeCanonical: ROUTE,
      }),
    });
    expect(paired.status).toBe(200);
    const credential = paired.body.credential as string;
    const auth = { authorization: `Bearer ${credential}`, "content-type": "application/json" };

    const state = await fetchJson("/api/companion/v1/state", { headers: auth });
    expect(state.status).toBe(200);
    expect(state.body.pendingReady).toBe(1);
    expect(state.body.routeVerification).toBe("PENDING");

    const unverifiedReserve = await fetchJson("/api/companion/v1/reserve", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ routeCanonical: ROUTE }),
    });
    expect(unverifiedReserve.status).toBe(409);
    expect(unverifiedReserve.body.error).toBe("COMPANION_ROUTE_UNVERIFIED");

    confirmRouteAttestation({
      workspaceId: workspace.id,
      principal: principalA(),
      challengeId: paired.body.routeAttestation.challengeId,
      challengeDigest: paired.body.routeAttestation.challengeDigest,
      stateDir,
    });

    const reserved = await fetchJson("/api/companion/v1/reserve", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ routeCanonical: ROUTE }),
    });
    expect(reserved.status).toBe(200);
    const eventId = reserved.body.delivery.eventId as string;
    const reservationId = reserved.body.reservationId as string;
    const reservedJson = JSON.stringify(reserved.body);
    expect(reservedJson).not.toContain("principalFingerprint");
    expect(reservedJson).not.toContain("targetBindingId");
    expect(reservedJson).not.toContain("reservedBy");

    const sent = await fetchJson("/api/companion/v1/begin-send", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ routeCanonical: ROUTE, eventId, reservationId }),
    });
    expect(sent.status).toBe(200);
    expect(sent.body.status).toBe("claimed");
    expect(sent.body.message).toContain("[C2C_CONTROL]");
    expect(sent.body.message).toContain(`ATTEMPT_ID: ${sent.body.attemptId}`);
    expect(typeof sent.body.messageSha256).toBe("string");
    expect(sent.body.messageSha256).toMatch(/^[a-f0-9]{64}$/);
    const attemptId = sent.body.attemptId as string;

    // Lost response: exact begin-send retry returns same attempt + byte-identical message/hash.
    const sentRetry = await fetchJson("/api/companion/v1/begin-send", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ routeCanonical: ROUTE, eventId, reservationId }),
    });
    expect(sentRetry.status).toBe(200);
    expect(sentRetry.body.attemptId).toBe(attemptId);
    expect(sentRetry.body.message).toBe(sent.body.message);
    expect(sentRetry.body.messageSha256).toBe(sent.body.messageSha256);

    // Single-flight: claimed blocks reserve of later ready events.
    await fetchJson("/api/companion/v1/state", { headers: auth }); // reconcile
    seedTrustedReceipt("later-ready-cmd");
    const blocked = await fetchJson("/api/companion/v1/reserve", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ routeCanonical: ROUTE }),
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("FEEDBACK_INFLIGHT_FENCE");

    const acked = await fetchJson("/api/companion/v1/ack", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ routeCanonical: ROUTE, eventId, attemptId }),
    });
    expect(acked.status).toBe(200);
    expect(acked.body.status).toBe("observed");

    // companion credential 不能当 MCP bearer
    const mcp = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcp.status).toBe(401);

    // admin 仍不可达（非 loopback 伪装无关；无 admin token → 404）
    const admin = await fetch(`${base}/admin/info`, {
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(admin.status).toBe(404);

    // 错误 route
    const badRoute = await fetchJson("/api/companion/v1/reserve", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ routeCanonical: ROUTE_B }),
    });
    expect(badRoute.status).toBe(400);
  });

  it("Project route alias 在 pair/state/写操作间保持 canonical compatibility", async () => {
    await enableAndSeed();
    const intent = createPairingIntent({
      workspaceId: workspace.id,
      principal: principalA(),
      stateDir,
    });
    const paired = await fetchJson("/api/companion/v1/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intentId: intent.intentId,
        secret: intent.secret,
        routeCanonical: PROJECT_ROUTE_ALIAS,
      }),
    });
    expect(paired.status).toBe(200);
    expect(paired.body.routeCanonical).toBe(PROJECT_ROUTE);
    const credential = paired.body.credential as string;
    const auth = { authorization: `Bearer ${credential}`, "content-type": "application/json" };

    const state = await fetchJson("/api/companion/v1/state", { headers: auth });
    expect(state.status).toBe(200);
    expect(state.body.routeCanonical).toBe(PROJECT_ROUTE);

    confirmRouteAttestation({
      workspaceId: workspace.id,
      principal: principalA(),
      challengeId: paired.body.routeAttestation.challengeId,
      challengeDigest: paired.body.routeAttestation.challengeDigest,
      stateDir,
    });

    const reserved = await fetchJson("/api/companion/v1/reserve", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ routeCanonical: PROJECT_ROUTE_ALIAS }),
    });
    expect(reserved.status).toBe(200);
    const eventId = reserved.body.delivery.eventId as string;
    const reservationId = reserved.body.reservationId as string;

    const sent = await fetchJson("/api/companion/v1/begin-send", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        routeCanonical: PROJECT_ROUTE_ALIAS,
        eventId,
        reservationId,
      }),
    });
    expect(sent.status).toBe(200);
    const acked = await fetchJson("/api/companion/v1/ack", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        routeCanonical: PROJECT_ROUTE_ALIAS,
        eventId,
        attemptId: sent.body.attemptId,
      }),
    });
    expect(acked.status).toBe(200);
    expect(acked.body.status).toBe("observed");

    const differentProject = await fetchJson("/api/companion/v1/reserve", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        routeCanonical: "https://chatgpt.com/g/g-p-7bb307f745459292c552e67efbc34c8c-codex-with-chatgpt/c/11111111-1111-4111-8111-111111111111",
      }),
    });
    expect(differentProject.status).toBe(400);
    expect(differentProject.body.error).toBe("ROUTE_MISMATCH");
  });

  it("legacy slug persisted companion accepts bare Project route without rewriting attestation", async () => {
    await enableAndSeed();
    const intent = createPairingIntent({
      workspaceId: workspace.id,
      principal: principalA(),
      stateDir,
    });
    const paired = await fetchJson("/api/companion/v1/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intentId: intent.intentId,
        secret: intent.secret,
        routeCanonical: PROJECT_ROUTE_ALIAS,
      }),
    });
    expect(paired.status).toBe(200);
    const credential = paired.body.credential as string;
    const auth = { authorization: `Bearer ${credential}`, "content-type": "application/json" };
    confirmRouteAttestation({
      workspaceId: workspace.id,
      principal: principalA(),
      challengeId: paired.body.routeAttestation.challengeId,
      challengeDigest: paired.body.routeAttestation.challengeDigest,
      stateDir,
    });

    const file = path.join(stateDir, "feedback", `${workspace.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      companion: {
        bindingId: string;
        epoch: number;
        companionId: string;
        routeCanonical: string;
        routeAttestation: { challengeId: string; [key: string]: unknown };
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
    raw.companion.routeCanonical = PROJECT_ROUTE_ALIAS;
    raw.companion.routeAttestation.routeCanonical = PROJECT_ROUTE_ALIAS;
    raw.companion.routeAttestation.challengeDigest = routeChallengeDigest({
      workspaceId: workspace.id,
      bindingId: raw.companion.bindingId,
      epoch: raw.companion.epoch,
      companionId: raw.companion.companionId,
      routeCanonical: PROJECT_ROUTE_ALIAS,
      challengeId: raw.companion.routeAttestation.challengeId,
    });
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));
    const persistedBefore = JSON.stringify(raw.companion);

    const reserved = await fetchJson("/api/companion/v1/reserve", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ routeCanonical: PROJECT_ROUTE }),
    });
    expect(reserved.status).toBe(200);
    expect(JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8")).companion))
      .toBe(persistedBefore);
  });

  it("错误 secret pair 失败；无 credential state 401", async () => {
    await enableAndSeed();
    const intent = createPairingIntent({
      workspaceId: workspace.id,
      principal: principalA(),
      stateDir,
    });
    const bad = await fetchJson("/api/companion/v1/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intentId: intent.intentId,
        secret: "c2c_pair_wrong",
        routeCanonical: ROUTE,
      }),
    });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe("PAIRING_INVALID");

    const anon = await fetchJson("/api/companion/v1/state");
    expect(anon.status).toBe(401);

    // P2：畸形 body → 400，不是 500
    const badBody = await fetchJson("/api/companion/v1/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intentId: "not-a-uuid" }),
    });
    expect(badBody.status).toBe(400);
    expect(badBody.body.error).toBe("COMPANION_VALIDATION");
  });

  it("takeover 后旧 credential 仅可完成 immediate-successor rebind", async () => {
    await enableAndSeed();
    const pairIntent = createPairingIntent({
      workspaceId: workspace.id,
      principal: principalA(),
      stateDir,
    });
    const paired = await fetchJson("/api/companion/v1/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intentId: pairIntent.intentId,
        secret: pairIntent.secret,
        routeCanonical: ROUTE,
      }),
    });
    expect(paired.status).toBe(200);
    confirmRouteAttestation({
      workspaceId: workspace.id,
      principal: principalA(),
      challengeId: paired.body.routeAttestation.challengeId,
      challengeDigest: paired.body.routeAttestation.challengeDigest,
      stateDir,
    });
    takeoverReceiver({
      workspaceId: workspace.id,
      principal: principalB(),
      widgetId: "widget-B",
      expectedEpoch: paired.body.epoch,
      stateDir,
    });
    const oldAuth = {
      authorization: `Bearer ${paired.body.credential as string}`,
      "content-type": "application/json",
    };
    expect((await fetchJson("/api/companion/v1/state", { headers: oldAuth })).status).toBe(401);
    expect((await fetchJson("/api/companion/v1/reserve", {
      method: "POST",
      headers: oldAuth,
      body: JSON.stringify({ routeCanonical: ROUTE_B }),
    })).status).toBe(401);

    const started = await fetchJson("/api/companion/v1/rebind/init", {
      method: "POST",
      headers: oldAuth,
      body: JSON.stringify({ routeCanonical: ROUTE_B }),
    });
    expect(started.status).toBe(200);
    expect(started.body.routeVerification).toBe("PENDING");
    expectCode(() => confirmRouteAttestation({
      workspaceId: workspace.id,
      principal: principalA(),
      challengeId: started.body.routeAttestation.challengeId,
      challengeDigest: started.body.routeAttestation.challengeDigest,
      stateDir,
    }), "FEEDBACK_PRINCIPAL_MISMATCH");
    const premature = await fetchJson("/api/companion/v1/rebind/complete", {
      method: "POST",
      headers: oldAuth,
      body: JSON.stringify({
        challengeId: started.body.routeAttestation.challengeId,
        routeCanonical: ROUTE_B,
      }),
    });
    expect(premature.status).toBe(409);
    expect(premature.body.error).toBe("COMPANION_REBIND_NOT_CONFIRMED");

    confirmRouteAttestation({
      workspaceId: workspace.id,
      principal: principalB(),
      challengeId: started.body.routeAttestation.challengeId,
      challengeDigest: started.body.routeAttestation.challengeDigest,
      stateDir,
    });
    const completed = await fetchJson("/api/companion/v1/rebind/complete", {
      method: "POST",
      headers: oldAuth,
      body: JSON.stringify({
        challengeId: started.body.routeAttestation.challengeId,
        routeCanonical: ROUTE_B,
      }),
    });
    expect(completed.status).toBe(200);
    expect(completed.body.routeVerification).toBe("VERIFIED");
    expect(completed.body.challengeId).toBe(started.body.routeAttestation.challengeId);
    const newAuth = { authorization: `Bearer ${completed.body.credential as string}` };
    const current = await fetchJson("/api/companion/v1/state", { headers: newAuth });
    expect(current.status).toBe(200);
    expect(current.body.routeVerification).toBe("VERIFIED");
    expect((await fetchJson("/api/companion/v1/state", { headers: oldAuth })).status).toBe(401);
  });

  it("rebind status 只读返回 bounded state，并在完成后拒绝旧 credential", async () => {
    await enableAndSeed();
    const pairIntent = createPairingIntent({
      workspaceId: workspace.id,
      principal: principalA(),
      stateDir,
    });
    const paired = await fetchJson("/api/companion/v1/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intentId: pairIntent.intentId,
        secret: pairIntent.secret,
        routeCanonical: ROUTE,
      }),
    });
    expect(paired.status).toBe(200);
    confirmRouteAttestation({
      workspaceId: workspace.id,
      principal: principalA(),
      challengeId: paired.body.routeAttestation.challengeId,
      challengeDigest: paired.body.routeAttestation.challengeDigest,
      stateDir,
    });
    takeoverReceiver({
      workspaceId: workspace.id,
      principal: principalB(),
      widgetId: "widget-B",
      expectedEpoch: paired.body.epoch,
      stateDir,
    });
    const oldAuth = {
      authorization: `Bearer ${paired.body.credential as string}`,
      "content-type": "application/json",
    };
    const started = await fetchJson("/api/companion/v1/rebind/init", {
      method: "POST",
      headers: oldAuth,
      body: JSON.stringify({ routeCanonical: ROUTE_B }),
    });
    expect(started.status).toBe(200);
    const challengeId = started.body.routeAttestation.challengeId as string;
    const statusPath = (route: string, challenge: string) =>
      `/api/companion/v1/rebind/status?routeCanonical=${encodeURIComponent(route)}&challengeId=${encodeURIComponent(challenge)}`;
    const stateFile = path.join(stateDir, "feedback", `${workspace.id}.json`);
    const beforePending = fs.readFileSync(stateFile);
    const pending = await fetchJson(statusPath(ROUTE_B, challengeId), { headers: oldAuth });
    expect(pending.status).toBe(200);
    expect(pending.body).toEqual({
      state: "PENDING",
      workspaceId: workspace.id,
      bindingId: started.body.bindingId,
      epoch: started.body.epoch,
      companionId: started.body.companionId,
      routeCanonical: ROUTE_B,
      challengeId,
    });
    expect(fs.readFileSync(stateFile)).toEqual(beforePending);
    expect(Object.keys(pending.body).sort()).toEqual([
      "bindingId",
      "challengeId",
      "companionId",
      "epoch",
      "routeCanonical",
      "state",
      "workspaceId",
    ].sort());

    expect((await fetchJson(statusPath(ROUTE_B, challengeId), {
      headers: { authorization: "Bearer c2c_comp_wrong" },
    })).status).toBe(401);
    expect((await fetchJson(statusPath(ROUTE_B, challengeId))).status).toBe(401);
    expect((await fetchJson(statusPath(ROUTE, challengeId), { headers: oldAuth })).status).toBe(401);
    expect((await fetchJson(statusPath(ROUTE_B, "33333333-3333-4333-8333-333333333333"), {
      headers: oldAuth,
    })).status).toBe(401);
    expect((await fetchJson(`/api/companion/v1/rebind/status?challengeId=${challengeId}`, {
      headers: oldAuth,
    })).status).toBe(400);

    confirmRouteAttestation({
      workspaceId: workspace.id,
      principal: principalB(),
      challengeId,
      challengeDigest: started.body.routeAttestation.challengeDigest,
      stateDir,
    });
    const beforeConfirmed = fs.readFileSync(stateFile);
    const confirmed = await fetchJson(statusPath(ROUTE_B, challengeId), { headers: oldAuth });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.state).toBe("CONFIRMED");
    expect(fs.readFileSync(stateFile)).toEqual(beforeConfirmed);

    const expiredState = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
      rebindIntent: { expiresAt: string; routeAttestation: { expiresAt: string } };
    };
    const expiredAt = new Date(Date.now() - 1_000).toISOString();
    expiredState.rebindIntent.expiresAt = expiredAt;
    expiredState.rebindIntent.routeAttestation.expiresAt = expiredAt;
    fs.writeFileSync(stateFile, JSON.stringify(expiredState, null, 2));
    const expired = await fetchJson(statusPath(ROUTE_B, challengeId), { headers: oldAuth });
    expect(expired.status).toBe(200);
    expect(expired.body.state).toBe("EXPIRED");

    const retry = await fetchJson("/api/companion/v1/rebind/init", {
      method: "POST",
      headers: oldAuth,
      body: JSON.stringify({ routeCanonical: ROUTE_B }),
    });
    expect(retry.status).toBe(200);
    const retryChallengeId = retry.body.routeAttestation.challengeId as string;
    confirmRouteAttestation({
      workspaceId: workspace.id,
      principal: principalB(),
      challengeId: retryChallengeId,
      challengeDigest: retry.body.routeAttestation.challengeDigest,
      stateDir,
    });
    const completed = await fetchJson("/api/companion/v1/rebind/complete", {
      method: "POST",
      headers: oldAuth,
      body: JSON.stringify({ challengeId: retryChallengeId, routeCanonical: ROUTE_B }),
    });
    expect(completed.status).toBe(200);
    expect(completed.body.challengeId).toBe(retryChallengeId);
    expect((await fetchJson(statusPath(ROUTE_B, retryChallengeId), { headers: oldAuth })).status).toBe(401);
    expect((await fetchJson("/api/companion/v1/rebind/complete", {
      method: "POST",
      headers: oldAuth,
      body: JSON.stringify({ challengeId: retryChallengeId, routeCanonical: ROUTE_B }),
    })).status).toBe(401);
  });

  it("rebind status 在 confirmed 后发现 in-flight 时 fail closed", async () => {
    setupReadyEvent("cmd-rebind-race");
    const paired = pairCompanion(ROUTE, { verify: false });
    confirmRouteAttestation({
      workspaceId: workspace.id,
      principal: principalA(),
      challengeId: paired.routeAttestation.challengeId,
      challengeDigest: paired.routeAttestation.challengeDigest,
      stateDir,
    });
    takeoverReceiver({
      workspaceId: workspace.id,
      principal: principalB(),
      widgetId: "widget-race",
      expectedEpoch: paired.epoch,
      stateDir,
    });
    const oldAuth = {
      authorization: `Bearer ${paired.credential as string}`,
      "content-type": "application/json",
    };
    const started = await fetchJson("/api/companion/v1/rebind/init", {
      method: "POST",
      headers: oldAuth,
      body: JSON.stringify({ routeCanonical: ROUTE_B }),
    });
    expect(started.status).toBe(200);
    const challengeId = started.body.routeAttestation.challengeId as string;
    confirmRouteAttestation({
      workspaceId: workspace.id,
      principal: principalB(),
      challengeId,
      challengeDigest: started.body.routeAttestation.challengeDigest,
      stateDir,
    });

    const stateFile = path.join(stateDir, "feedback", `${workspace.id}.json`);
    const current = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
      events: Array<{ status: string }>;
    };
    current.events[0]!.status = "outcome_unknown";
    fs.writeFileSync(stateFile, JSON.stringify(current, null, 2));

    const blocked = await fetchJson(
      `/api/companion/v1/rebind/status?routeCanonical=${encodeURIComponent(ROUTE_B)}&challengeId=${encodeURIComponent(challengeId)}`,
      { headers: oldAuth },
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("COMPANION_REPAIR_BLOCKED");
  });

  async function pairCompanionHttp(opts: { verify?: boolean } = {}) {
    const intent = createPairingIntent({
      workspaceId: workspace.id,
      principal: principalA(),
      stateDir,
    });
    const paired = await fetchJson("/api/companion/v1/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        intentId: intent.intentId,
        secret: intent.secret,
        routeCanonical: ROUTE,
      }),
    });
    expect(paired.status).toBe(200);
    if (opts.verify !== false) {
      confirmRouteAttestation({
        workspaceId: workspace.id,
        principal: principalA(),
        challengeId: paired.body.routeAttestation.challengeId,
        challengeDigest: paired.body.routeAttestation.challengeDigest,
        stateDir,
      });
    }
    return {
      authorization: `Bearer ${paired.body.credential as string}`,
      "content-type": "application/json",
    };
  }

  it("autonomous /state: pair 后 seed 新 receipt，无 MCP 仅 GET /state 即投影", async () => {
    reconcileFeedbackOutbox(workspace.id, stateDir);
    seedTrustedReceipt("http-cmd");
    reconcileFeedbackOutbox(workspace.id, stateDir);
    enableReceiver({
      workspaceId: workspace.id,
      principal: principalA(),
      widgetId: "w",
      stateDir,
    });
    const auth = await pairCompanionHttp();

    const baseline = await fetchJson("/api/companion/v1/state", { headers: auth });
    expect(baseline.status).toBe(200);
    const baselineReady = baseline.body.pendingReady as number;
    expect(baselineReady).toBeGreaterThanOrEqual(1);

    // 测试侧不调用 reconcileFeedbackOutbox
    seedTrustedReceipt("auto-cmd-1");
    const state1 = await fetchJson("/api/companion/v1/state", { headers: auth });
    expect(state1.status).toBe(200);
    expect(state1.body.pendingReady).toBe(baselineReady + 1);

    // 重复 GET 不重复投影
    const state2 = await fetchJson("/api/companion/v1/state", { headers: auth });
    expect(state2.status).toBe(200);
    expect(state2.body.pendingReady).toBe(baselineReady + 1);
    expect(state2.body.events?.length).toBe(state1.body.events?.length);
  });

  it("autonomous /reserve: pendingReady=0 时 seed 新 receipt，直接 reserve 即可命中", async () => {
    // 干净基线：无 event、无 ready
    reconcileFeedbackOutbox(workspace.id, stateDir);
    enableReceiver({
      workspaceId: workspace.id,
      principal: principalA(),
      widgetId: "w",
      stateDir,
    });
    const auth = await pairCompanionHttp();

    const empty = await fetchJson("/api/companion/v1/state", { headers: auth });
    expect(empty.status).toBe(200);
    expect(empty.body.pendingReady).toBe(0);

    // 新 receipt 落盘；不 reconcile，不先 GET /state
    seedTrustedReceipt("reserve-auto-cmd");
    const reserved = await fetchJson("/api/companion/v1/reserve", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ routeCanonical: ROUTE }),
    });
    expect(reserved.status).toBe(200);
    expect(reserved.body.delivery?.status).toBe("reserved");
    expect(reserved.body.delivery?.commandId).toBe("reserve-auto-cmd");
  });

  it("匿名 /state 401 且不推进 projectionCursor", async () => {
    reconcileFeedbackOutbox(workspace.id, stateDir);
    seedTrustedReceipt("http-cmd");
    reconcileFeedbackOutbox(workspace.id, stateDir);
    enableReceiver({
      workspaceId: workspace.id,
      principal: principalA(),
      widgetId: "w",
      stateDir,
    });

    const before = readFeedbackState(workspace.id, stateDir).projectionCursor;
    // 有一条尚未投影的 trusted receipt
    seedTrustedReceipt("anon-should-not-project");
    const mid = readFeedbackState(workspace.id, stateDir).projectionCursor;
    expect(mid).toBe(before);

    const anon = await fetchJson("/api/companion/v1/state");
    expect(anon.status).toBe(401);

    const after = readFeedbackState(workspace.id, stateDir).projectionCursor;
    expect(after).toBe(before);
  });
});
