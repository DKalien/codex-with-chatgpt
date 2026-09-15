import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FEEDBACK_PROBE_UI_URI,
  FEEDBACK_PROBE_MIME,
  PROBE_DEFAULT_MAX_ATTEMPTS,
  PROBE_MAX_LIFETIME_MS,
  PROBE_POLL_INTERVAL_MS,
  PROBE_SENDING_STALE_MS,
  buildFollowUpPrompt,
  claimProbeEvent,
  confirmProbeObservation,
  emitProbeEventLocal,
  enableProbe,
  isFeedbackProbeEnabled,
  probeStateSchema,
  readProbeState,
  reportProbeSend,
  resolveTrustedPrincipal,
  stateFile,
  stopProbe,
  takeoverProbe,
  unwrapToolResult,
  type TrustedPrincipal,
} from "../src/feedback/probe-store.js";
import {
  renderProbeHtml,
  pollForProbeEvent,
  escapeHtml,
  normalizeToolResult,
  McpAppsBridge,
  UI_INITIALIZE_METHOD,
  UI_INITIALIZED_NOTIFICATION,
  UI_MESSAGE_METHOD,
  UI_PROTOCOL_VERSION,
} from "../src/feedback/probe-ui.js";
import { PROBE_LIVE_HOST_CONTRACT } from "../src/mcp/feedback-probe.js";
import { createMcpServer } from "../src/mcp/server.js";
import { getSupportedScopes } from "../src/auth/store.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

let stateDir: string;
let wsRoot: string;
let workspace: Workspace;

beforeEach(() => {
  stateDir = isolateStateDir();
  wsRoot = makeTmpDir("probe-ws");
  workspace = new Workspace(wsRoot);
  process.env.C2C_ENABLE_FEEDBACK_PROBE = "1";
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.C2C_ENABLE_FEEDBACK_PROBE;
  cleanup(stateDir);
  cleanup(wsRoot);
});

function principalA(): TrustedPrincipal {
  return resolveTrustedPrincipal({
    authInfo: { token: "t", clientId: "client-A", scopes: ["feedback.probe"] } as never,
    sessionId: "session-A",
    _meta: { "openai/session": "sess-A" },
  });
}

function principalB(): TrustedPrincipal {
  return resolveTrustedPrincipal({
    authInfo: { token: "t", clientId: "client-B", scopes: ["feedback.probe"] } as never,
    sessionId: "session-B",
    _meta: { "openai/session": "sess-B" },
  });
}

/** 同 clientId + openai/session，但 _meta 额外字段不同。 */
function principalANoisy(): TrustedPrincipal {
  return resolveTrustedPrincipal({
    authInfo: { token: "t", clientId: "client-A", scopes: ["feedback.probe"] } as never,
    sessionId: "session-A",
    _meta: {
      "openai/session": "sess-A",
      "x-unrelated": "noise-should-not-change-identity",
      "traceId": "abc123",
    },
  });
}

describe("trusted principal 与对话级身份", () => {
  it("无 clientId 拒绝；无 openai/session enable/takeover 拒绝", () => {
    expect(() => resolveTrustedPrincipal({ authInfo: undefined })).toThrow(/clientId/);
    const noConv = resolveTrustedPrincipal({
      authInfo: { token: "t", clientId: "c", scopes: [] } as never,
    });
    expect(noConv.diagnostics.hasConversationKey).toBe(false);
    try {
      enableProbe({ workspaceId: workspace.id, principal: noConv, widgetId: "w", stateDir });
      expect.unreachable("enable 必须失败");
    } catch (error) {
      expect((error as { code: string }).code).toBe("PROBE_CHAT_IDENTITY_UNAVAILABLE");
    }
    try {
      takeoverProbe({ workspaceId: workspace.id, principal: noConv, widgetId: "w", expectedEpoch: 1, stateDir });
      expect.unreachable("takeover 必须失败");
    } catch (error) {
      expect((error as { code: string }).code).toBe("PROBE_CHAT_IDENTITY_UNAVAILABLE");
    }

    const a = principalA();
    const b = principalB();
    expect(a.diagnostics.hasConversationKey).toBe(true);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("无 openai/session 时 claim/report/confirm/stop 也 fail closed", () => {
    enableProbe({ workspaceId: workspace.id, principal: principalA(), widgetId: "w", stateDir });
    const ev = emitProbeEventLocal({ workspaceId: workspace.id, stateDir });
    const binding = readProbeState(workspace.id, stateDir).binding!;
    const noConv = resolveTrustedPrincipal({
      authInfo: { token: "t", clientId: "client-A", scopes: [] } as never,
    });
    const expectChatId = (fn: () => unknown) => {
      try {
        fn();
        expect.unreachable("应 fail closed");
      } catch (error) {
        expect((error as { code: string }).code).toBe("PROBE_CHAT_IDENTITY_UNAVAILABLE");
      }
    };
    expectChatId(() => claimProbeEvent({
      workspaceId: workspace.id, probeId: ev.probeId, bindingId: binding.bindingId, epoch: binding.epoch,
      principal: noConv, stateDir,
    }));
    const claimed = claimProbeEvent({
      workspaceId: workspace.id, probeId: ev.probeId, bindingId: binding.bindingId, epoch: binding.epoch,
      principal: principalA(), stateDir,
    });
    expectChatId(() => reportProbeSend({
      workspaceId: workspace.id, probeId: ev.probeId, attemptId: claimed.attemptId,
      outcome: "outcome_unknown", principal: noConv, stateDir,
    }));
    reportProbeSend({
      workspaceId: workspace.id, probeId: ev.probeId, attemptId: claimed.attemptId,
      outcome: "sent", messageId: "m1", principal: principalA(), stateDir,
    });
    expectChatId(() => confirmProbeObservation({
      workspaceId: workspace.id, probeId: ev.probeId, payloadDigest: ev.payloadDigest,
      attemptId: claimed.attemptId, principal: noConv, stateDir,
    }));
    expectChatId(() => stopProbe({ workspaceId: workspace.id, principal: noConv, stateDir }));
  });

  it("只认官方 openai/session 字符串；object/conversationId 等 fail closed", () => {
    const guessed = resolveTrustedPrincipal({
      authInfo: { token: "t", clientId: "c", scopes: [] } as never,
      sessionId: "mcp-session",
      _meta: { "openai/conversationId": "conv-x", threadId: "th-x", conversation_id: "c2" },
    });
    expect(guessed.diagnostics.hasConversationKey).toBe(false);
    expect(() => enableProbe({ workspaceId: workspace.id, principal: guessed, widgetId: "w", stateDir }))
      .toThrow(/openai\/session/);

    // 未文档化 object 形态一律拒绝
    const nested = resolveTrustedPrincipal({
      authInfo: { token: "t", clientId: "c", scopes: [] } as never,
      _meta: { "openai/session": { id: "sess-nested" } },
    });
    expect(nested.diagnostics.hasConversationKey).toBe(false);
    expect(() => enableProbe({ workspaceId: workspace.id, principal: nested, widgetId: "w", stateDir }))
      .toThrow(/openai\/session/);
  });

  it("fingerprint 只基于稳定字段；无关 metadata 不改变身份", () => {
    const a = principalA();
    const noisy = principalANoisy();
    expect(noisy.fingerprint).toBe(a.fingerprint);
    // conversationKey 不同则 fingerprint 必须不同
    const sameClientOtherConv = resolveTrustedPrincipal({
      authInfo: { token: "t", clientId: "client-A", scopes: [] } as never,
      sessionId: "session-A",
      _meta: { "openai/session": "sess-Z" },
    });
    expect(sameClientOtherConv.fingerprint).not.toBe(a.fingerprint);
  });

  it("status 不返回原始 sessionKey；只给 fingerprint", () => {
    enableProbe({ workspaceId: workspace.id, principal: principalA(), widgetId: "w", stateDir });
    const state = readProbeState(workspace.id, stateDir);
    expect(JSON.stringify(state)).not.toContain("session-A");
    expect(state.binding?.principalFingerprint).toHaveLength(32);
  });

  it("unwrapToolResult 统一 structuredContent", () => {
    expect(unwrapToolResult({ structuredContent: { a: 1 }, content: [] })).toEqual({ a: 1 });
    expect(unwrapToolResult({ b: 2 })).toEqual({ b: 2 });
    expect(unwrapToolResult(null)).toEqual({});
  });
});

describe("enable / takeover 锁死", () => {
  it("无绑定时 enable 创建；A 重复 enable 幂等不换 epoch 不改 sending", () => {
    const first = enableProbe({ workspaceId: workspace.id, principal: principalA(), widgetId: "w1", stateDir });
    expect(first.binding?.epoch).toBe(1);
    const ev = emitProbeEventLocal({ workspaceId: workspace.id, stateDir });
    const binding = readProbeState(workspace.id, stateDir).binding!;
    claimProbeEvent({
      workspaceId: workspace.id, probeId: ev.probeId, bindingId: binding.bindingId, epoch: binding.epoch,
      principal: principalA(), stateDir,
    });
    const before = readProbeState(workspace.id, stateDir);
    const again = enableProbe({ workspaceId: workspace.id, principal: principalA(), widgetId: "w2", stateDir });
    expect(again.binding?.epoch).toBe(1);
    expect(again.binding?.bindingId).toBe(first.binding?.bindingId);
    expect(again.binding?.widgetId).toBe("w1"); // 不换 widget
    const after = readProbeState(workspace.id, stateDir);
    expect(after.events.find((e) => e.probeId === ev.probeId)?.status).toBe("sending");
    expect(after.binding?.epoch).toBe(before.binding?.epoch);
  });

  it("B 直接 enable 得到 PROBE_TAKEOVER_REQUIRED；只能走 takeover(expectedEpoch)", () => {
    enableProbe({ workspaceId: workspace.id, principal: principalA(), widgetId: "wA", stateDir });
    try {
      enableProbe({ workspaceId: workspace.id, principal: principalB(), widgetId: "wB", stateDir });
      expect.unreachable("B enable 必须失败");
    } catch (error) {
      expect((error as { code: string }).code).toBe("PROBE_TAKEOVER_REQUIRED");
    }
    // B 必须带 status 的 expectedEpoch
    expect(() => takeoverProbe({
      workspaceId: workspace.id, principal: principalB(), widgetId: "wB", expectedEpoch: 0, stateDir,
    })).toThrow(/epoch|代次/);
    const taken = takeoverProbe({
      workspaceId: workspace.id, principal: principalB(), widgetId: "wB", expectedEpoch: 1, stateDir,
    });
    expect(taken.state.binding?.epoch).toBe(2);
    expect(taken.state.binding?.principalFingerprint).toBe(principalB().fingerprint);
  });
});

describe("destination principal binding", () => {
  it("caller A 不能 claim/report/confirm/stop B 的事件", () => {
    enableProbe({ workspaceId: workspace.id, principal: principalA(), widgetId: "w", stateDir });
    const ev = emitProbeEventLocal({ workspaceId: workspace.id, stateDir });
    const binding = readProbeState(workspace.id, stateDir).binding!;
    expect(() => claimProbeEvent({
      workspaceId: workspace.id, probeId: ev.probeId, bindingId: binding.bindingId, epoch: binding.epoch,
      principal: principalB(), stateDir,
    })).toThrow(/主体/);

    const claimed = claimProbeEvent({
      workspaceId: workspace.id, probeId: ev.probeId, bindingId: binding.bindingId, epoch: binding.epoch,
      principal: principalA(), stateDir,
    });
    expect(() => reportProbeSend({
      workspaceId: workspace.id, probeId: ev.probeId, attemptId: claimed.attemptId,
      outcome: "sent", messageId: "m1", principal: principalB(), stateDir,
    })).toThrow(/主体/);
    reportProbeSend({
      workspaceId: workspace.id, probeId: ev.probeId, attemptId: claimed.attemptId,
      outcome: "sent", messageId: "m1", principal: principalA(), stateDir,
    });
    expect(() => confirmProbeObservation({
      workspaceId: workspace.id, probeId: ev.probeId, payloadDigest: ev.payloadDigest,
      attemptId: claimed.attemptId, principal: principalB(), stateDir,
    })).toThrow(/主体/);
    expect(() => stopProbe({ workspaceId: workspace.id, principal: principalB(), stateDir })).toThrow(/主体/);
  });

  it("takeover 后 B 不能 confirm A 已 sent 事件；ready 事件只有 B 能 claim", () => {
    enableProbe({ workspaceId: workspace.id, principal: principalA(), widgetId: "wA", stateDir });
    const ev1 = emitProbeEventLocal({ workspaceId: workspace.id, stateDir });
    const bindingA = readProbeState(workspace.id, stateDir).binding!;
    const claimed = claimProbeEvent({
      workspaceId: workspace.id, probeId: ev1.probeId, bindingId: bindingA.bindingId, epoch: bindingA.epoch,
      principal: principalA(), stateDir,
    });
    reportProbeSend({
      workspaceId: workspace.id, probeId: ev1.probeId, attemptId: claimed.attemptId,
      outcome: "sent", messageId: "m1", principal: principalA(), stateDir,
    });
    const taken = takeoverProbe({
      workspaceId: workspace.id, principal: principalB(), widgetId: "wB", expectedEpoch: 1, stateDir,
    });
    expect(taken.state.binding?.principalFingerprint).toBe(principalB().fingerprint);
    expect(() => confirmProbeObservation({
      workspaceId: workspace.id, probeId: ev1.probeId, payloadDigest: ev1.payloadDigest,
      attemptId: claimed.attemptId, principal: principalB(), stateDir,
    })).toThrow(/主体/);
    const confirmed = confirmProbeObservation({
      workspaceId: workspace.id, probeId: ev1.probeId, payloadDigest: ev1.payloadDigest,
      attemptId: claimed.attemptId, principal: principalA(), stateDir,
    });
    expect(confirmed.status).toBe("model_observed");
    // 既有真实 messageId 保留；confirm 只改观察层，不抹掉证据
    expect(confirmed.messageId).toBe("m1");

    const ev2 = emitProbeEventLocal({ workspaceId: workspace.id, stateDir });
    const bindingB = readProbeState(workspace.id, stateDir).binding!;
    const claimB = claimProbeEvent({
      workspaceId: workspace.id, probeId: ev2.probeId, bindingId: bindingB.bindingId, epoch: bindingB.epoch,
      principal: principalB(), stateDir,
    });
    expect(claimB.event.status).toBe("sending");
    expect(() => claimProbeEvent({
      workspaceId: workspace.id, probeId: ev2.probeId, bindingId: bindingB.bindingId, epoch: bindingB.epoch,
      principal: principalA(), stateDir,
    })).toThrow(/主体/);
  });
});

describe("messageId、模板与 crash recovery", () => {
  it("无真实 messageId 永不 sent", () => {
    enableProbe({ workspaceId: workspace.id, principal: principalA(), widgetId: "w", stateDir });
    const ev = emitProbeEventLocal({ workspaceId: workspace.id, stateDir });
    const binding = readProbeState(workspace.id, stateDir).binding!;
    const claimed = claimProbeEvent({
      workspaceId: workspace.id, probeId: ev.probeId, bindingId: binding.bindingId, epoch: binding.epoch,
      principal: principalA(), stateDir,
    });
    expect(() => reportProbeSend({
      workspaceId: workspace.id, probeId: ev.probeId, attemptId: claimed.attemptId,
      outcome: "sent", principal: principalA(), stateDir,
    })).toThrow(/messageId/);
    const unknown = reportProbeSend({
      workspaceId: workspace.id, probeId: ev.probeId, attemptId: claimed.attemptId,
      outcome: "outcome_unknown", principal: principalA(), stateDir,
    });
    expect(unknown.status).toBe("outcome_unknown");
  });

  it("payload 为服务端固定模板；follow-up 含完整 confirm 身份并要求 model_confirm", () => {
    enableProbe({ workspaceId: workspace.id, principal: principalA(), widgetId: "w", stateDir });
    const ev = emitProbeEventLocal({ workspaceId: workspace.id, label: "ok", stateDir });
    expect(ev.payload).toContain("C2C_FEEDBACK_PROBE");
    const binding = readProbeState(workspace.id, stateDir).binding!;
    const claimed = claimProbeEvent({
      workspaceId: workspace.id, probeId: ev.probeId, bindingId: binding.bindingId, epoch: binding.epoch,
      principal: principalA(), stateDir,
    });
    const prompt = buildFollowUpPrompt(claimed.event, claimed.attemptId, binding.principalFingerprint);
    expect(prompt).toContain(ev.probeId);
    expect(prompt).toContain(claimed.attemptId);
    expect(prompt).toContain(binding.principalFingerprint);
    expect(prompt).toContain(`payloadDigest=${ev.payloadDigest}`);
    expect(prompt).toContain(`epoch=${binding.epoch}`);
    expect(prompt).toContain("不是用户新授权");
    expect(prompt).toContain(`probe_model_confirm(probeId=${ev.probeId}`);
    expect(prompt).toContain(`payloadDigest=${ev.payloadDigest}`);
    expect(prompt).toContain(`attemptId=${claimed.attemptId}`);
    expect(prompt).toContain("model_observed");
    expect(prompt).toContain("不伪造 sent");
  });

  it("follow-up / confirm 精确校验 attemptId；outcome_unknown 后 model_observed 对账", () => {
    enableProbe({ workspaceId: workspace.id, principal: principalA(), widgetId: "w", stateDir });
    const ev = emitProbeEventLocal({ workspaceId: workspace.id, stateDir });
    const binding = readProbeState(workspace.id, stateDir).binding!;
    const claimed = claimProbeEvent({
      workspaceId: workspace.id, probeId: ev.probeId, bindingId: binding.bindingId, epoch: binding.epoch,
      principal: principalA(), stateDir,
    });
    // 无 messageId 只能 outcome_unknown
    const unknown = reportProbeSend({
      workspaceId: workspace.id, probeId: ev.probeId, attemptId: claimed.attemptId,
      outcome: "outcome_unknown", principal: principalA(), stateDir,
    });
    expect(unknown.status).toBe("outcome_unknown");
    expect(unknown.messageId).toBeUndefined();
    // 错误 attemptId 不能 confirm
    expect(() => confirmProbeObservation({
      workspaceId: workspace.id, probeId: ev.probeId, payloadDigest: ev.payloadDigest,
      attemptId: "11111111-1111-4111-8111-111111111111", principal: principalA(), stateDir,
    })).toThrow(/attempt/);
    const observed = confirmProbeObservation({
      workspaceId: workspace.id, probeId: ev.probeId, payloadDigest: ev.payloadDigest,
      attemptId: claimed.attemptId, principal: principalA(), stateDir,
    });
    expect(observed.status).toBe("model_observed");
    expect(observed.messageId).toBeUndefined();
  });

  it("takeover 将遗留 sending 收敛为 outcome_unknown", () => {
    enableProbe({ workspaceId: workspace.id, principal: principalA(), widgetId: "w", stateDir });
    const ev = emitProbeEventLocal({ workspaceId: workspace.id, stateDir });
    const binding = readProbeState(workspace.id, stateDir).binding!;
    claimProbeEvent({
      workspaceId: workspace.id, probeId: ev.probeId, bindingId: binding.bindingId, epoch: binding.epoch,
      principal: principalA(), stateDir,
    });
    const taken = takeoverProbe({
      workspaceId: workspace.id, principal: principalB(), widgetId: "w2", expectedEpoch: 1, stateDir,
    });
    expect(taken.blockedEvents).toContain(ev.probeId);
    const recovered = taken.state.events.find((e) => e.probeId === ev.probeId)!;
    expect(recovered.status).toBe("outcome_unknown");
  });

  it("race: claim→confirm→report unknown 保持 model_observed", () => {
    enableProbe({ workspaceId: workspace.id, principal: principalA(), widgetId: "w", stateDir });
    const ev = emitProbeEventLocal({ workspaceId: workspace.id, stateDir });
    const binding = readProbeState(workspace.id, stateDir).binding!;
    const claimed = claimProbeEvent({
      workspaceId: workspace.id, probeId: ev.probeId, bindingId: binding.bindingId, epoch: binding.epoch,
      principal: principalA(), stateDir,
    });
    const observed = confirmProbeObservation({
      workspaceId: workspace.id, probeId: ev.probeId, payloadDigest: ev.payloadDigest,
      attemptId: claimed.attemptId, principal: principalA(), stateDir,
    });
    expect(observed.status).toBe("model_observed");
    const late = reportProbeSend({
      workspaceId: workspace.id, probeId: ev.probeId, attemptId: claimed.attemptId,
      outcome: "outcome_unknown", principal: principalA(), stateDir,
    });
    expect(late.status).toBe("model_observed");
    expect(readProbeState(workspace.id, stateDir).events[0].status).toBe("model_observed");
  });

  it("race: claim→confirm→report sent 只补 messageId，不降级 sent", () => {
    enableProbe({ workspaceId: workspace.id, principal: principalA(), widgetId: "w", stateDir });
    const ev = emitProbeEventLocal({ workspaceId: workspace.id, stateDir });
    const binding = readProbeState(workspace.id, stateDir).binding!;
    const claimed = claimProbeEvent({
      workspaceId: workspace.id, probeId: ev.probeId, bindingId: binding.bindingId, epoch: binding.epoch,
      principal: principalA(), stateDir,
    });
    confirmProbeObservation({
      workspaceId: workspace.id, probeId: ev.probeId, payloadDigest: ev.payloadDigest,
      attemptId: claimed.attemptId, principal: principalA(), stateDir,
    });
    const late = reportProbeSend({
      workspaceId: workspace.id, probeId: ev.probeId, attemptId: claimed.attemptId,
      outcome: "sent", messageId: "late-m1", principal: principalA(), stateDir,
    });
    expect(late.status).toBe("model_observed");
    expect(late.messageId).toBe("late-m1");
    expect(readProbeState(workspace.id, stateDir).events[0].status).toBe("model_observed");
  });

  it("owner enable 收敛 stale sending，不碰 fresh sending", () => {
    const first = enableProbe({ workspaceId: workspace.id, principal: principalA(), widgetId: "w1", stateDir });
    const staleEv = emitProbeEventLocal({ workspaceId: workspace.id, stateDir });
    const binding = readProbeState(workspace.id, stateDir).binding!;
    const claimed = claimProbeEvent({
      workspaceId: workspace.id, probeId: staleEv.probeId, bindingId: binding.bindingId, epoch: binding.epoch,
      principal: principalA(), stateDir,
    });
    // 把 updatedAt 改旧，模拟超过 stale 阈值
    const file = stateFile(workspace.id, stateDir);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.events[0].updatedAt = new Date(Date.now() - PROBE_SENDING_STALE_MS - 60_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));
    const again = enableProbe({ workspaceId: workspace.id, principal: principalA(), widgetId: "w2", stateDir });
    expect(again.binding?.bindingId).toBe(first.binding?.bindingId);
    expect(again.binding?.epoch).toBe(1);
    expect(again.binding?.widgetId).toBe("w1");
    const recovered = again.events.find((e) => e.probeId === staleEv.probeId)!;
    expect(recovered.status).toBe("outcome_unknown");
    expect(recovered.attemptId).toBe(claimed.attemptId);

    // fresh sending 不得被改
    const freshEv = emitProbeEventLocal({ workspaceId: workspace.id, stateDir });
    const b2 = readProbeState(workspace.id, stateDir).binding!;
    claimProbeEvent({
      workspaceId: workspace.id, probeId: freshEv.probeId, bindingId: b2.bindingId, epoch: b2.epoch,
      principal: principalA(), stateDir,
    });
    const after = enableProbe({ workspaceId: workspace.id, principal: principalA(), widgetId: "w3", stateDir });
    expect(after.events.find((e) => e.probeId === freshEv.probeId)?.status).toBe("sending");
    expect(after.binding?.bindingId).toBe(first.binding?.bindingId);
  });
});

describe("本机 emit", () => {
  it("不需要 Chat principal；事件目标为当前 active binding", () => {
    // 未 enable 时拒绝
    expect(() => emitProbeEventLocal({ workspaceId: workspace.id, stateDir })).toThrow(/未启用/);
    enableProbe({ workspaceId: workspace.id, principal: principalA(), widgetId: "w", stateDir });
    const ev = emitProbeEventLocal({ workspaceId: workspace.id, stateDir });
    const binding = readProbeState(workspace.id, stateDir).binding!;
    expect(ev.principalFingerprint).toBe(binding.principalFingerprint);
    expect(ev.bindingId).toBe(binding.bindingId);
    expect(ev.epoch).toBe(binding.epoch);
    expect(ev.status).toBe("ready");
  });
});

describe("workspace isolation", () => {
  it("两个 workspace 状态文件互不影响", () => {
    enableProbe({ workspaceId: workspace.id, principal: principalA(), widgetId: "w", stateDir });
    const otherId = "abcdefabcdef";
    enableProbe({ workspaceId: otherId, principal: principalA(), widgetId: "w2", stateDir });
    expect(fs.existsSync(stateFile(workspace.id, stateDir))).toBe(true);
    expect(fs.existsSync(stateFile(otherId, stateDir))).toBe(true);
    expect(readProbeState(workspace.id, stateDir).binding?.widgetId).toBe("w");
    expect(readProbeState(otherId, stateDir).binding?.widgetId).toBe("w2");
  });
});

describe("UI 与 poll 未知未来事件", () => {
  it("HTML 内嵌同一 poll/follow-up 源码；window.openai 桥；无 toolkit/emit", () => {
    const html = renderProbeHtml();
    expect(html).toContain("pollForProbeEvent");
    expect(html).toContain("buildFollowUpPrompt");
    expect(html).toContain("payloadDigest");
    expect(html).toContain("等待未知未来事件");
    expect(html).toContain("probe_status");
    expect(html).toContain("ownsBinding");
    expect(html).toContain("明确接管");
    expect(html).toContain("window.openai");
    expect(html).toContain("callTool");
    expect(html).toContain("ui/message");
    expect(html).not.toContain("window.openai.toolkit");
    expect(html).not.toContain("toolkit.callTool");
    expect(html).not.toContain("probe_emit_event");
    expect(html).not.toContain("host-ack");
    expect(html).toContain("probe_model_confirm");
    expect(html).toContain("outcome_unknown");
    expect(html).toContain("normalizeToolResult");
    expect(html).toContain("isError");
    // 版本化 resource URI（不复用旧 cache key）
    expect(FEEDBACK_PROBE_UI_URI).toBe("ui://c2c/feedback-probe/v4.html");
    expect(pollForProbeEvent.toString()).toContain("PROBE_EVENT_CLAIM_CONFLICT");
    // 真实 HTML 使用的 follow-up 必须含 digest/attempt/epoch/fingerprint 与 model_confirm 指令
    const sample = buildFollowUpPrompt(
      { probeId: "probe_x", payloadDigest: "d".repeat(64), payload: "C2C_FEEDBACK_PROBE ...", epoch: 3 },
      "a1",
      "f".repeat(32),
    );
    expect(sample).toContain("payloadDigest=" + "d".repeat(64));
    expect(sample).toContain("attemptId=a1");
    expect(sample).toContain("epoch=3");
    expect(sample).toContain("principalFingerprint=" + "f".repeat(32));
    expect(sample).toContain("probe_model_confirm(probeId=probe_x");
    expect(sample).toContain("model_observed");
  });

  it("卡片加载先 probe_status；owner resume；非 owner takeover 用真实 expectedEpoch", () => {
    const html = renderProbeHtml();
    // 加载入口
    expect(html).toContain("refreshStatusThenMaybePoll");
    expect(html).toMatch(/refreshStatusThenMaybePoll\(\)/);
    // 读取 ownsBinding / epoch
    expect(html).toContain("applyStatus");
    expect(html).toContain("status.ownsBinding");
    // owner 可 resume
    expect(html).toContain("startPollingAfterBind");
    expect(html).toContain("已持有绑定");
    // 非 owner 提示 takeover，并用 status 的 epoch 作为 expectedEpoch
    expect(html).toContain("明确接管（expectedEpoch=");
    expect(html).toContain("expectedEpoch: expected");
    // enable 不能绕过 takeover：服务端异主体抛 TAKEOVER_REQUIRED，UI 只展示失败
    expect(html).toContain("启用失败");
    expect(html).not.toMatch(/probe_takeover[\s\S]{0,80}probe_enable/);
  });

  it("poll 等待任意 ready 事件而非预置 probeId", async () => {
    let calls = 0;
    const claimed = await pollForProbeEvent(
      { bindingId: "b", epoch: 1, maxAttempts: 3 },
      {
        now: () => Date.now(),
        sleep: async () => {},
        isStopped: () => false,
        callTool: async (name: string) => {
          calls += 1;
          if (name === "probe_status") {
            if (calls === 1) {
              return { binding: { status: "active", epoch: 1 }, events: [] };
            }
            return {
              binding: { status: "active", epoch: 1 },
              events: [{ probeId: "probe_x", status: "ready" }],
            };
          }
          return {
            attemptId: "a1",
            event: { payload: "C2C_FEEDBACK_PROBE ...", payloadDigest: "d".repeat(64), epoch: 1 },
          };
        },
      },
    );
    expect(claimed.kind).toBe("claimed");
    if (claimed.kind === "claimed") {
      expect(claimed.probeId).toBe("probe_x");
      expect(claimed.payloadDigest).toBe("d".repeat(64));
      expect(claimed.epoch).toBe(1);
    }
  });

  it("默认 polling 覆盖 15 分钟，不会十几秒就结束", async () => {
    // 默认 attempts ≈ lifetime/interval = 300；用模拟时钟验证不因 5 次提前 timeout
    let t = 0;
    let statusCalls = 0;
    const outcome = await pollForProbeEvent(
      { bindingId: "b", epoch: 1 }, // 不注入 maxAttempts
      {
        now: () => t,
        sleep: async (ms) => { t += ms; },
        isStopped: () => false,
        callTool: async (name: string) => {
          if (name === "probe_status") {
            statusCalls += 1;
            // 第 20 次（约 57s）才出现 ready；旧默认 5 次会在约 12s 结束
            if (statusCalls >= 20) {
              return {
                binding: { status: "active", epoch: 1 },
                events: [{ probeId: "probe_late", status: "ready" }],
              };
            }
            return { binding: { status: "active", epoch: 1 }, events: [] };
          }
          return {
            attemptId: "a-late",
            event: { payload: "C2C_FEEDBACK_PROBE late", payloadDigest: "e".repeat(64), epoch: 1 },
          };
        },
      },
    );
    expect(outcome.kind).toBe("claimed");
    if (outcome.kind === "claimed") expect(outcome.probeId).toBe("probe_late");
    expect(PROBE_DEFAULT_MAX_ATTEMPTS).toBeGreaterThanOrEqual(
      Math.floor(PROBE_MAX_LIFETIME_MS / PROBE_POLL_INTERVAL_MS) - 1,
    );
    expect(PROBE_DEFAULT_MAX_ATTEMPTS).toBeGreaterThanOrEqual(100);
  });

  it("normalizeToolResult：isError 抛出带 code 的错误", () => {
    expect(normalizeToolResult({
      structuredContent: { a: 1 },
      content: [{ type: "text", text: JSON.stringify({ a: 1 }) }],
    })).toEqual({ a: 1 });
    try {
      normalizeToolResult({
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: "PROBE_PRINCIPAL_MISMATCH", message: "主体不一致" }) }],
      });
      expect.unreachable("必须 throw");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("PROBE_PRINCIPAL_MISMATCH");
      expect((error as Error).message).toContain("主体");
    }
    try {
      normalizeToolResult({ isError: true, content: [{ type: "text", text: "not-json" }] });
      expect.unreachable("必须 throw");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("PROBE_TOOL_ERROR");
    }
  });

  it("HTML script 可 new Function 语法编译", () => {
    const html = renderProbeHtml();
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(match?.[1]).toBeTruthy();
    expect(() => new Function(match![1])).not.toThrow();
  });

  it("registered resource callback 实际返回 text/html;profile=mcp-app", async () => {
    const server = createMcpServer({
      workspace,
      logger: { info() {}, error() {}, warn() {}, debug() {} } as never,
    });
    const resources = (server as unknown as {
      _registeredResources?: Record<string, {
        metadata?: { mimeType?: string };
        readCallback?: () => Promise<{ contents: Array<{ mimeType?: string; text?: string; uri?: string }> }>;
      }>;
    })._registeredResources ?? {};
    const entry = resources[FEEDBACK_PROBE_UI_URI];
    expect(entry).toBeTruthy();
    expect(entry?.metadata?.mimeType).toBe(FEEDBACK_PROBE_MIME);
    expect(typeof entry?.readCallback).toBe("function");
    const result = await entry!.readCallback!();
    expect(result.contents[0].mimeType).toBe(FEEDBACK_PROBE_MIME);
    expect(result.contents[0].uri).toBe(FEEDBACK_PROBE_UI_URI);
    expect(result.contents[0].text).toContain("pollForProbeEvent");
    expect(result.contents[0].text).toContain("window.openai");
  });

  it("probe_open_card descriptor：ui.resourceUri + openai/outputTemplate + MCP Apps MIME", async () => {
    const server = createMcpServer({
      workspace,
      logger: { info() {}, error() {}, warn() {}, debug() {} } as never,
    });
    const tools = (server as unknown as {
      _registeredTools?: Record<string, {
        handler?: unknown;
        _meta?: Record<string, unknown>;
      }>;
    })._registeredTools ?? {};
    expect(tools.probe_open_card).toBeTruthy();
    expect(tools.probe_emit_event).toBeUndefined();

    type Meta = {
      securitySchemes?: Array<{ type?: string; scopes?: string[] }>;
      ui?: { resourceUri?: string; visibility?: string[] };
      "openai/outputTemplate"?: string;
      "openai/widgetAccessible"?: boolean;
      "openai/visibility"?: string;
    };

    // MCP SDK 将 registerTool 的 _meta 挂在 tool 对象顶层（descriptor）
    const openMeta = tools.probe_open_card?._meta as Meta | undefined;
    expect(openMeta?.ui?.resourceUri).toBe(FEEDBACK_PROBE_UI_URI);
    expect(openMeta?.["openai/outputTemplate"]).toBe(FEEDBACK_PROBE_UI_URI);
    expect(openMeta?.securitySchemes?.[0]).toMatchObject({ type: "oauth2", scopes: ["feedback.probe"] });
    expect(openMeta?.ui?.visibility).toEqual(["model"]);
    // 兼容层：openai/visibility 不得 private，否则模型看不到 open_card
    expect(openMeta?.["openai/visibility"]).toBe("public");
    expect(openMeta?.["openai/widgetAccessible"]).toBeUndefined();

    const appNames = ["probe_status", "probe_enable", "probe_takeover", "probe_claim_event", "probe_report_send", "probe_stop"] as const;
    for (const name of appNames) {
      const meta = tools[name]?._meta as Meta | undefined;
      expect(meta?.securitySchemes?.[0], name).toMatchObject({ type: "oauth2", scopes: ["feedback.probe"] });
      expect(meta?.ui?.visibility, name).toEqual(["app"]);
      expect(meta?.["openai/widgetAccessible"], name).toBe(true);
      expect(meta?.["openai/visibility"], name).toBe("private");
    }
    const confirmMeta = tools.probe_model_confirm?._meta as Meta | undefined;
    expect(confirmMeta?.securitySchemes?.[0]).toMatchObject({ type: "oauth2", scopes: ["feedback.probe"] });
    expect(confirmMeta?.ui?.visibility).toEqual(["model"]);
    // model_confirm 必须对模型可见
    expect(confirmMeta?.["openai/visibility"]).toBe("public");
    expect(confirmMeta?.["openai/widgetAccessible"]).toBeUndefined();

    expect(PROBE_LIVE_HOST_CONTRACT).toBe("documented_unverified");
    expect(FEEDBACK_PROBE_UI_URI).toBe("ui://c2c/feedback-probe/v4.html");

    const result = await (tools.probe_open_card as {
      handler: (a: unknown, e: unknown) => Promise<{ structuredContent?: Record<string, unknown>; _meta?: Record<string, unknown> }>;
    }).handler(
      {},
      { authInfo: { token: "t", clientId: "c", scopes: ["feedback.probe"] }, requestId: 1 },
    );
    expect(result.structuredContent?.mimeType).toBe(FEEDBACK_PROBE_MIME);
    expect(result.structuredContent?.liveHostContract).toBe("documented_unverified");
    expect((result._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri).toBe(FEEDBACK_PROBE_UI_URI);
    expect((result._meta as Record<string, unknown>)?.["openai/outputTemplate"]).toBe(FEEDBACK_PROBE_UI_URI);

    const denied = await (tools.probe_status as { handler: (a: unknown, e: unknown) => Promise<{ isError?: boolean }> }).handler(
      {},
      { authInfo: { token: "t", clientId: "c", scopes: ["workspace.read"] }, requestId: 2 },
    );
    expect(denied.isError).toBe(true);
  });

  it("默认关闭不注册 probe 工具", () => {
    delete process.env.C2C_ENABLE_FEEDBACK_PROBE;
    expect(getSupportedScopes()).not.toContain("feedback.probe");
    const server = createMcpServer({ workspace, logger: { info() {}, error() {}, warn() {}, debug() {} } as never });
    const handlers = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {};
    expect(Object.keys(handlers).filter((k) => k.startsWith("probe_"))).toEqual([]);
  });

  it("escapeHtml", () => {
    expect(escapeHtml(`<script>"x"</script>`)).not.toContain("<script>");
  });
});

describe("MCP Apps JSON-RPC message bridge", () => {
  function makeBridge() {
    const posted: unknown[] = [];
    const bridge = new McpAppsBridge({
      postMessage: (m) => { posted.push(m); },
    });
    const parent = { name: "parent" };
    const other = { name: "other" };
    return { bridge, posted, parent, other };
  }

  const stdInitResult = {
    protocolVersion: "2026-01-26",
    hostInfo: { name: "test-host", version: "1" },
    hostCapabilities: { message: { text: {} } },
    hostContext: {},
  };

  it("initialize 标准 hostCapabilities.message.text；protocol 2026-01-26", async () => {
    const { bridge, posted, parent } = makeBridge();
    const initPromise = bridge.initialize(1000);
    const req = posted[0] as { jsonrpc: string; id: number; method: string; params: Record<string, unknown> };
    expect(req.method).toBe(UI_INITIALIZE_METHOD);
    expect(UI_PROTOCOL_VERSION).toBe("2026-01-26");
    expect(req.params.protocolVersion).toBe("2026-01-26");
    expect(req.params.appInfo).toEqual({ name: "c2c-feedback-probe", version: "1" });
    expect(req.params.appCapabilities).toEqual({});

    bridge.handleMessage({ jsonrpc: "2.0", id: req.id, result: stdInitResult }, parent, parent);
    const init = await initPromise;
    expect(init.ok).toBe(true);
    expect(init.messageTransport).toBe(true);
    expect(bridge.state).toBe("standard");
    expect(bridge.hostCapabilities).toMatchObject({ message: { text: {} } });
    const note = posted[1] as { method: string; params: Record<string, unknown> };
    expect(note.method).toBe(UI_INITIALIZED_NOTIFICATION);
    expect(note.params).toEqual({});
  });

  it("legacy message.types（无 hostCapabilities.message.text）=> initialized_no_message / init=ok", async () => {
    const { bridge, posted, parent } = makeBridge();
    const initPromise = bridge.initialize(1000);
    const req = posted[0] as { id: number };
    bridge.handleMessage({
      jsonrpc: "2.0",
      id: req.id,
      result: { message: { types: ["text"] } },
    }, parent, parent);
    const init = await initPromise;
    expect(init.messageTransport).toBe(false);
    expect(init.outcome).toBe("ok");
    expect(bridge.state).toBe("initialized_no_message");
    expect(bridge.initOutcome).toBe("ok");
    const send = await bridge.sendUserMessage("x");
    expect(send.failed).toBe(true);
    expect(send.attempted).toBe(false);
    expect(posted).toHaveLength(2); // initialize + initialized；无 ui/message
  });

  it("缺 hostCapabilities.message.text => initialized_no_message，仍发 initialized", async () => {
    const { bridge, posted, parent } = makeBridge();
    const initPromise = bridge.initialize(1000);
    const req = posted[0] as { id: number };
    bridge.handleMessage({ jsonrpc: "2.0", id: req.id, result: { hostCapabilities: { message: {} } } }, parent, parent);
    const init = await initPromise;
    expect(init.messageTransport).toBe(false);
    expect(bridge.state).toBe("initialized_no_message");
    expect(bridge.initOutcome).toBe("ok");
    expect((posted as Array<{ method?: string }>).some((m) => m.method === UI_INITIALIZED_NOTIFICATION)).toBe(true);
  });

  it("只接受 parent JSON-RPC response；非 parent / 非 2.0 忽略", async () => {
    const { bridge, posted, parent, other } = makeBridge();
    const p = bridge.request("ui/message", {}, 500);
    const req = posted[0] as { id: number };
    expect(bridge.handleMessage({ jsonrpc: "2.0", id: req.id, result: {} }, other, parent)).toBe(false);
    expect(bridge.handleMessage({ jsonrpc: "1.0", id: req.id, result: {} }, parent, parent)).toBe(false);
    expect(bridge.handleMessage({ jsonrpc: "2.0", id: req.id, result: { ok: 1 } }, parent, parent)).toBe(true);
    await expect(p).resolves.toEqual({ ok: 1 });
  });

  it("ui/message exact shape；{} / isError:false => attempted 无 sent；isError:true => failed", async () => {
    const { bridge, posted, parent } = makeBridge();
    const initP = bridge.initialize(1000);
    const initReq = posted[0] as { id: number };
    bridge.handleMessage({ jsonrpc: "2.0", id: initReq.id, result: stdInitResult }, parent, parent);
    await initP;

    const sendP = bridge.sendUserMessage("hello-prompt", 1000);
    const msgReq = posted[2] as { method: string; id: number; params: Record<string, unknown> };
    expect(msgReq.method).toBe(UI_MESSAGE_METHOD);
    expect(msgReq.params).toEqual({ role: "user", content: [{ type: "text", text: "hello-prompt" }] });
    bridge.handleMessage({ jsonrpc: "2.0", id: msgReq.id, result: {} }, parent, parent);
    const emptyOk = await sendP;
    expect(emptyOk.failed).toBeUndefined();
    expect(emptyOk.attempted).toBe(true);
    // 不从 result 推导 messageId / sent
    expect(emptyOk).not.toHaveProperty("messageId");

    const sendP2 = bridge.sendUserMessage("hello2", 1000);
    const msgReq2 = posted[3] as { id: number };
    bridge.handleMessage({ jsonrpc: "2.0", id: msgReq2.id, result: { isError: false } }, parent, parent);
    const falseOk = await sendP2;
    expect(falseOk.attempted).toBe(true);
    expect(falseOk.failed).toBeUndefined();

    const sendP3 = bridge.sendUserMessage("bad", 1000);
    const msgReq3 = posted[4] as { id: number };
    bridge.handleMessage({ jsonrpc: "2.0", id: msgReq3.id, result: { isError: true } }, parent, parent);
    const failed = await sendP3;
    expect(failed.failed).toBe(true);
    expect(failed.attempted).toBe(false);
    expect(failed.transport).toBe("ui/message");
  });

  it("duplicate response ignored；timeout reject；teardown reject pending", async () => {
    const { bridge, posted, parent } = makeBridge();
    const p = bridge.request("ui/message", {}, 50);
    const id = (posted[0] as { id: number }).id;
    expect(bridge.handleMessage({ jsonrpc: "2.0", id, result: { a: 1 } }, parent, parent)).toBe(true);
    await p;
    expect(bridge.handleMessage({ jsonrpc: "2.0", id, result: { a: 2 } }, parent, parent)).toBe(false);

    const timed = bridge.request("ui/message", {}, 30);
    await expect(timed).rejects.toMatchObject({ code: "PROBE_BRIDGE_TIMEOUT" });

    const pending = bridge.request("ui/message", {}, 5000);
    bridge.teardown();
    await expect(pending).rejects.toMatchObject({ code: "PROBE_BRIDGE_TEARDOWN" });
  });

  it("JSON-RPC error => reject；发送尝试后无 alias fallback/no resend", async () => {
    const { bridge, posted, parent } = makeBridge();
    const initP = bridge.initialize(1000);
    const initReq = posted[0] as { id: number };
    bridge.handleMessage({ jsonrpc: "2.0", id: initReq.id, result: stdInitResult }, parent, parent);
    await initP;

    const sendP = bridge.sendUserMessage("err", 1000);
    const msg = posted[2] as { id: number };
    bridge.handleMessage({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "nope" } }, parent, parent);
    const r = await sendP;
    expect(r.failed).toBe(true);
    expect(r.attempted).toBe(false);
    expect(posted).toHaveLength(3);
    expect((posted as Array<{ method?: string }>).filter((m) => m.method === UI_MESSAGE_METHOD)).toHaveLength(1);
  });

  it("HTML：v4、init 诊断字段、标准 bridge；script 可编译", () => {
    const html = renderProbeHtml();
    expect(FEEDBACK_PROBE_UI_URI).toBe("ui://c2c/feedback-probe/v4.html");
    expect(html).toContain("var UI_INITIALIZE_METHOD");
    expect(html).toContain("var UI_PROTOCOL_VERSION");
    expect(html).toContain("var UI_BRIDGE_TIMEOUT_MS");
    expect(html).toContain("init.outcome");
    expect(html).toContain("initOutcome");
    expect(html).toContain("host.serverTools");
    expect(html).toContain("initialized_no_message");
    expect(html).toContain("bridge");
    expect(html).toContain("host.message");
    expect(html).toContain(UI_MESSAGE_METHOD);
    expect(html).toContain(UI_INITIALIZE_METHOD);
    expect(html).toContain("McpAppsBridge");
    expect(html).toContain("window.parent");
    expect(html).toContain("outcome_unknown");
    expect(html).not.toContain("host.sendFollowUpMessage");
    expect(html).not.toContain(".sendFollowUpMessage(");
    expect(html).not.toContain("message.types");
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(() => new Function(match![1])).not.toThrow();
  });
});

/** 执行 renderProbeHtml 真正嵌入的 script（不是 module class）。 */
function runRenderedProbeScript(options: {
  onParentPost?: (msg: unknown) => void;
  autoRespondInit?: "timeout" | "standard" | "none";
}) {
  const posted: unknown[] = [];
  const listeners: Array<(event: { data: unknown; source: unknown }) => void> = [];
  const elements = new Map<string, { textContent: string; disabled: boolean; addEventListener: Function }>();
  const getEl = (id: string) => {
    if (!elements.has(id)) {
      elements.set(id, { textContent: "", disabled: false, addEventListener() {} });
    }
    return elements.get(id)!;
  };
  const parent = {
    postMessage: (msg: unknown) => {
      posted.push(msg);
      options.onParentPost?.(msg);
    },
  };
  const win: Record<string, unknown> = {
    parent,
    openai: null,
    addEventListener: (_type: string, fn: (e: { data: unknown; source: unknown }) => void) => {
      listeners.push(fn);
    },
  };
  win.self = win;
  const timers: Array<{ id: number; fn: () => void; ms: number; cleared: boolean }> = [];
  let timerSeq = 1;
  const fakeSetTimeout = (fn: () => void, ms: number) => {
    const id = timerSeq++;
    timers.push({ id, fn, ms, cleared: false });
    return id;
  };
  const fakeClearTimeout = (id: unknown) => {
    const t = timers.find((x) => x.id === id);
    if (t) t.cleared = true;
  };
  const html = renderProbeHtml();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  const fn = new Function("window", "document", "setTimeout", "clearTimeout", script);
  fn(win, { getElementById: getEl }, fakeSetTimeout, fakeClearTimeout);
  const deliver = (data: unknown) => {
    for (const l of listeners) l({ data, source: parent });
  };
  const runPendingTimers = () => {
    for (const t of timers.slice()) {
      if (!t.cleared) {
        t.cleared = true;
        t.fn();
      }
    }
  };
  return {
    posted,
    getEl,
    deliver,
    runPendingTimers,
    parent,
    respondInit(result: unknown) {
      const req = posted.find((m) => (m as { method?: string }).method === UI_INITIALIZE_METHOD) as { id: number };
      deliver({ jsonrpc: "2.0", id: req.id, result });
    },
    async flush(ms = 20) {
      await new Promise((r) => setTimeout(r, ms));
    },
  };
}

describe("rendered HTML runtime（真正执行嵌入 script）", () => {
  it("无 initialize 响应：timeout => unavailable + init.outcome=timeout", async () => {
    const env = runRenderedProbeScript({ autoRespondInit: "timeout" });
    await env.flush(30);
    expect(env.posted.some((m) => (m as { method?: string }).method === UI_INITIALIZE_METHOD)).toBe(true);
    env.runPendingTimers();
    await env.flush(30);
    expect(env.getEl("bridge").textContent).toBe("unavailable");
    expect(env.getEl("initOutcome").textContent).toBe("timeout");
    expect(env.getEl("hostMessage").textContent).toBe("no");
    expect(env.posted.some((m) => (m as { method?: string }).method === UI_MESSAGE_METHOD)).toBe(false);
    expect(env.getEl("bridge").textContent).not.toBe("initializing");
  });

  it("JSON-RPC error => unavailable + init.outcome=rpc_error", async () => {
    const env = runRenderedProbeScript({ autoRespondInit: "none" });
    await env.flush(20);
    const req = env.posted.find((m) => (m as { method?: string }).method === UI_INITIALIZE_METHOD) as { id: number };
    env.deliver({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32000, message: "nope" },
    });
    await env.flush(30);
    expect(env.getEl("bridge").textContent).toBe("unavailable");
    expect(env.getEl("initOutcome").textContent).toBe("rpc_error");
    expect(env.getEl("hostMessage").textContent).toBe("no");
  });

  it("合法 init 无 message => initialized_no_message + init.outcome=ok + initialized 通知", async () => {
    const env = runRenderedProbeScript({ autoRespondInit: "none" });
    await env.flush(20);
    env.respondInit({
      protocolVersion: "2026-01-26",
      hostInfo: { name: "test", version: "1" },
      hostCapabilities: { tools: {} },
      hostContext: {},
    });
    await env.flush(40);
    expect(env.posted.some((m) => (m as { method?: string }).method === UI_INITIALIZED_NOTIFICATION)).toBe(true);
    expect(env.getEl("bridge").textContent).toBe("initialized_no_message");
    expect(env.getEl("initOutcome").textContent).toBe("ok");
    expect(env.getEl("protocol").textContent).toBe("2026-01-26");
    expect(env.getEl("hostMessage").textContent).toBe("no");
    expect(env.getEl("hostServerTools").textContent).toBe("yes");
  });

  it("合法 init + message.text => standard + init.outcome=ok + initialized 通知", async () => {
    const env = runRenderedProbeScript({ autoRespondInit: "none" });
    await env.flush(20);
    env.respondInit({
      protocolVersion: "2026-01-26",
      hostInfo: { name: "test", version: "1" },
      hostCapabilities: { message: { text: {} } },
      hostContext: {},
    });
    await env.flush(40);
    expect(env.posted.some((m) => (m as { method?: string }).method === UI_INITIALIZED_NOTIFICATION)).toBe(true);
    expect(env.getEl("bridge").textContent).toBe("standard");
    expect(env.getEl("initOutcome").textContent).toBe("ok");
    expect(env.getEl("hostMessage").textContent).toBe("yes");
  });

  it("HTML 嵌入 UI_* 常量，rendered McpAppsBridge 无模块 free variable", () => {
    const html = renderProbeHtml();
    expect(html).toContain("var UI_INITIALIZE_METHOD");
    expect(html).toContain("var UI_INITIALIZED_NOTIFICATION");
    expect(html).toContain("var UI_MESSAGE_METHOD");
    expect(html).toContain("var UI_PROTOCOL_VERSION");
    expect(html).toContain("var UI_BRIDGE_TIMEOUT_MS");
    expect(html).toContain(JSON.stringify(UI_PROTOCOL_VERSION));
  });
});

describe("probeStateSchema still validates", () => {
  it("schema 可解析本地状态", () => {
    enableProbe({ workspaceId: workspace.id, principal: principalA(), widgetId: "w", stateDir });
    const raw = JSON.parse(fs.readFileSync(stateFile(workspace.id, stateDir), "utf8"));
    expect(() => probeStateSchema.parse(raw)).not.toThrow();
  });
});
