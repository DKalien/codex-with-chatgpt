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
} from "../src/feedback/store.js";
import {
  companionAckObserved,
  companionBeginSend,
  companionPublicState,
  companionRelease,
  companionReserveNext,
  companionStatusForPrincipal,
  createPairingIntent,
  exchangePairingIntent,
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
import { CODEX_FEEDBACK_SCOPE } from "../src/feedback/store.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

let stateDir: string;
let wsRoot: string;
let workspace: Workspace;

const ROUTE = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const ROUTE_B = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";

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

function pairCompanion(route = ROUTE) {
  const intent = createPairingIntent({
    workspaceId: workspace.id,
    principal: principalA(),
    stateDir,
  });
  return exchangePairingIntent({
    workspaceId: workspace.id,
    intentId: intent.intentId,
    secret: intent.secret,
    routeCanonical: route,
    stateDir,
  });
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`expected throw ${code}`);
  } catch (e) {
    expect((e as { code?: string }).code).toBe(code);
  }
}

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
    }), "FEEDBACK_RESERVED_FENCE");

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
    };
    expectCode(() => companionBeginSend({
      workspaceId: workspace.id,
      ctx: forgedB,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      reservationId: reserved.reservationId,
      stateDir,
    }), "FEEDBACK_RESERVATION_MISMATCH");
    expectCode(() => companionAckObserved({
      workspaceId: workspace.id,
      ctx: forgedB,
      routeCanonical: ROUTE,
      eventId: event.eventId,
      attemptId: sentA.attemptId,
      stateDir,
    }), "FEEDBACK_ACK_MISMATCH");
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
    const attemptId = sent.body.attemptId as string;

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
});
