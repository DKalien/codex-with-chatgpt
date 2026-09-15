import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ackObserved,
  claimNext,
  CODEX_FEEDBACK_SCOPE,
  enableReceiver,
  feedbackStateFile,
  readFeedbackState,
  stopReceiver,
  takeoverReceiver,
  type FeedbackEvent,
} from "../src/feedback/store.js";
import { reconcileFeedbackOutbox } from "../src/feedback/projector.js";
import {
  resolveConversationPrincipal,
  ConversationPrincipalError,
} from "../src/mcp/conversation-principal.js";
import { resolveTrustedPrincipal } from "../src/feedback/probe-store.js";
import {
  appendExecutionRecord,
  appendExecutionRecordLocked,
  withExecutionRecordsLock,
} from "../src/execution/records.js";
import { updateDesktop } from "../src/desktop/store.js";
import { createMcpServer } from "../src/mcp/server.js";
import { getSupportedScopes } from "../src/auth/store.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

let stateDir: string;
let wsRoot: string;
let workspace: Workspace;

beforeEach(() => {
  stateDir = isolateStateDir();
  wsRoot = makeTmpDir("feedback-ws");
  workspace = new Workspace(wsRoot);
});

afterEach(() => {
  cleanup(stateDir);
  cleanup(wsRoot);
});

function principalA() {
  return resolveConversationPrincipal({
    authInfo: { token: "t", clientId: "client-A", scopes: [CODEX_FEEDBACK_SCOPE] } as never,
    sessionId: "session-A",
    _meta: { "openai/session": "sess-A" },
  });
}

function principalB() {
  return resolveConversationPrincipal({
    authInfo: { token: "t", clientId: "client-B", scopes: [CODEX_FEEDBACK_SCOPE] } as never,
    sessionId: "session-B",
    _meta: { "openai/session": "sess-B" },
  });
}

function seedDesktopAccepted(commandId: string) {
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
}

function seedTrustedReceipt(commandId: string, exitStatus = "ok") {
  seedDesktopAccepted(commandId);
  withExecutionRecordsLock(workspace.id, () => {
    appendExecutionRecordLocked(workspace.id, {
      taskId: `desktop_${commandId}`,
      iteration: 1,
      changedFiles: ["a.ts"],
      tests: "1 passed",
      exitStatus,
      timestamp: new Date().toISOString(),
      commandId,
      desktopReceiptSha256: "b".repeat(64),
      outputAvailable: true,
      outputId: 7,
    } as never);
  });
}

describe("conversation principal 共享模块", () => {
  it("与 probe 行为一致：只认 openai/session 字符串；fingerprint 稳定", () => {
    const a = principalA();
    const noisy = resolveConversationPrincipal({
      authInfo: { token: "t", clientId: "client-A", scopes: [] } as never,
      _meta: { "openai/session": "sess-A", trace: "x" },
    });
    expect(noisy.fingerprint).toBe(a.fingerprint);
    const guessed = resolveConversationPrincipal({
      authInfo: { token: "t", clientId: "client-A", scopes: [] } as never,
      _meta: { conversationId: "c", threadId: "t" },
    });
    expect(guessed.diagnostics.hasConversationKey).toBe(false);
    try {
      enableReceiver({ workspaceId: workspace.id, principal: guessed, widgetId: "w", stateDir });
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe("PROBE_CHAT_IDENTITY_UNAVAILABLE");
    }
    try {
      resolveTrustedPrincipal({ authInfo: undefined });
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe("PROBE_PRINCIPAL_MISSING");
      expect(e).not.toBeInstanceOf(ConversationPrincipalError);
    }
  });

  it("auth 永久暴露 codex.feedback", () => {
    expect(getSupportedScopes()).toContain("codex.feedback");
    expect(CODEX_FEEDBACK_SCOPE).toBe("codex.feedback");
  });
});

describe("projection cursor baseline", () => {
  it("首次 state 不投历史 receipt；baseline 后新 receipt 产生 1 event；重复 reconcile 仍 1", () => {
    seedTrustedReceipt("hist-cmd");
    const first = reconcileFeedbackOutbox(workspace.id, stateDir);
    expect(first.projected).toBe(0);
    expect(first.state.events).toHaveLength(0);
    expect(first.state.projectionCursor).toBe(1);

    seedTrustedReceipt("new-cmd");
    const second = reconcileFeedbackOutbox(workspace.id, stateDir);
    expect(second.projected).toBe(1);
    expect(second.state.events).toHaveLength(1);
    expect(second.state.events[0]!.status).toBe("queued");
    expect(second.state.events[0]!.source).toBe("desktop");

    const third = reconcileFeedbackOutbox(workspace.id, stateDir);
    expect(third.projected).toBe(0);
    expect(third.state.events).toHaveLength(1);
  });

  it("crash-gap：receipt 已存在尚未投影，下次 reconcile 恢复", () => {
    reconcileFeedbackOutbox(workspace.id, stateDir);
    seedTrustedReceipt("gap-cmd");
    const r = reconcileFeedbackOutbox(workspace.id, stateDir);
    expect(r.projected).toBe(1);
  });

  it("普通 finalizer/manual 不创建 event，但 cursor 前进", () => {
    reconcileFeedbackOutbox(workspace.id, stateDir);
    appendExecutionRecord(workspace.id, {
      taskId: "post_turn_x",
      iteration: 1,
      changedFiles: 0,
      tests: null,
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
    });
    appendExecutionRecord(workspace.id, {
      taskId: "manual",
      iteration: 1,
      changedFiles: [],
      tests: "n/a",
      exitStatus: "blocked",
      timestamp: new Date().toISOString(),
      notes: "manual user task",
    });
    const r = reconcileFeedbackOutbox(workspace.id, stateDir);
    expect(r.projected).toBe(0);
    expect(r.state.events).toHaveLength(0);
    expect(r.state.projectionCursor).toBe(2);
  });

  it("Desktop identity 冲突 fail closed", () => {
    // 先 baseline，再追加冲突 receipt，第二次 reconcile 必须 fail closed
    reconcileFeedbackOutbox(workspace.id, stateDir);
    seedDesktopAccepted("bad-cmd");
    withExecutionRecordsLock(workspace.id, () => {
      appendExecutionRecordLocked(workspace.id, {
        taskId: "desktop_bad-cmd",
        iteration: 2,
        changedFiles: ["x"],
        tests: "t",
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
        commandId: "bad-cmd",
        desktopReceiptSha256: "c".repeat(64),
      } as never);
    });
    expect(() => reconcileFeedbackOutbox(workspace.id, stateDir)).toThrow(/IDENTITY_CONFLICT|冲突|拒绝静默投影|身份不匹配/);
  });

  it("JSONL 短于 cursor fail closed", () => {
    reconcileFeedbackOutbox(workspace.id, stateDir);
    seedTrustedReceipt("c1");
    seedTrustedReceipt("c2");
    const projected = reconcileFeedbackOutbox(workspace.id, stateDir);
    expect(projected.state.projectionCursor).toBe(2);
    const file = path.join(stateDir, "executions", `${workspace.id}.jsonl`);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    fs.writeFileSync(file, lines.slice(0, 1).join("\n") + "\n");
    expect(() => reconcileFeedbackOutbox(workspace.id, stateDir)).toThrow(/cursor|短于|损坏|不完整/i);
  });
});

describe("binding / claim / ack", () => {
  it("no binding -> queued；enable -> ready；same principal 幂等；other principal 拒绝", () => {
    reconcileFeedbackOutbox(workspace.id, stateDir);
    seedTrustedReceipt("e1");
    reconcileFeedbackOutbox(workspace.id, stateDir);
    expect(readFeedbackState(workspace.id, stateDir).events[0]!.status).toBe("queued");

    const enabled = enableReceiver({ workspaceId: workspace.id, principal: principalA(), widgetId: "wA", stateDir });
    expect(enabled.events[0]!.status).toBe("ready");
    expect(enabled.events[0]!.targetBindingId).toBe(enabled.binding!.bindingId);

    const again = enableReceiver({ workspaceId: workspace.id, principal: principalA(), widgetId: "w2", stateDir });
    expect(again.binding!.bindingId).toBe(enabled.binding!.bindingId);
    expect(again.binding!.epoch).toBe(1);

    try {
      enableReceiver({ workspaceId: workspace.id, principal: principalB(), widgetId: "wB", stateDir });
      expect.unreachable("B enable 必须失败");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("FEEDBACK_TAKEOVER_REQUIRED");
    }
  });

  it("takeover CAS；ready 转移到 B；claimed/outcome_unknown 阻止 takeover", () => {
    reconcileFeedbackOutbox(workspace.id, stateDir);
    seedTrustedReceipt("t1");
    reconcileFeedbackOutbox(workspace.id, stateDir);
    enableReceiver({ workspaceId: workspace.id, principal: principalA(), widgetId: "wA", stateDir });
    expect(() => takeoverReceiver({
      workspaceId: workspace.id, principal: principalB(), widgetId: "wB", expectedEpoch: 99, stateDir,
    })).toThrow(/epoch|代次/i);

    const taken = takeoverReceiver({
      workspaceId: workspace.id, principal: principalB(), widgetId: "wB", expectedEpoch: 1, stateDir,
    });
    expect(taken.state.binding!.epoch).toBe(2);
    expect(taken.state.events[0]!.targetPrincipalFingerprint).toBe(principalB().fingerprint);
    expect(taken.state.events[0]!.status).toBe("ready");

    const bindingB = readFeedbackState(workspace.id, stateDir).binding!;
    claimNext({
      workspaceId: workspace.id, principal: principalB(),
      bindingId: bindingB.bindingId, epoch: bindingB.epoch, stateDir,
    });
    expect(() => takeoverReceiver({
      workspaceId: workspace.id, principal: principalA(), widgetId: "wA2", expectedEpoch: 2, stateDir,
    })).toThrow(/claimed|接管/i);
  });

  it("old A epoch 在 takeover 后不能 claim", () => {
    reconcileFeedbackOutbox(workspace.id, stateDir);
    seedTrustedReceipt("old");
    reconcileFeedbackOutbox(workspace.id, stateDir);
    const en = enableReceiver({ workspaceId: workspace.id, principal: principalA(), widgetId: "wA", stateDir });
    const aBinding = { ...en.binding! };
    takeoverReceiver({ workspaceId: workspace.id, principal: principalB(), widgetId: "wB", expectedEpoch: 1, stateDir });
    expect(() => claimNext({
      workspaceId: workspace.id, principal: principalA(),
      bindingId: aBinding.bindingId, epoch: aBinding.epoch, stateDir,
    })).toThrow(/不一致|mismatch|主体/i);
  });

  it("claim 先持久化 attempt；exact ack -> observed", () => {
    reconcileFeedbackOutbox(workspace.id, stateDir);
    seedTrustedReceipt("claim1");
    reconcileFeedbackOutbox(workspace.id, stateDir);
    const en = enableReceiver({ workspaceId: workspace.id, principal: principalA(), widgetId: "w", stateDir });
    const b = en.binding!;
    const claimed = claimNext({
      workspaceId: workspace.id, principal: principalA(), bindingId: b.bindingId, epoch: b.epoch, stateDir,
    });
    expect(claimed.event.status).toBe("claimed");
    expect(claimed.event.attemptId).toBe(claimed.attemptId);
    const persisted = readFeedbackState(workspace.id, stateDir).events.find((e) => e.eventId === claimed.event.eventId)!;
    expect(persisted.status).toBe("claimed");
    expect(persisted.attemptId).toBe(claimed.attemptId);

    expect(() => ackObserved({
      workspaceId: workspace.id, principal: principalA(), bindingId: b.bindingId, epoch: b.epoch,
      eventId: claimed.event.eventId, attemptId: "11111111-1111-4111-8111-111111111111", stateDir,
    })).toThrow(/ack|mismatch|不匹配/i);

    const observed = ackObserved({
      workspaceId: workspace.id, principal: principalA(), bindingId: b.bindingId, epoch: b.epoch,
      eventId: claimed.event.eventId, attemptId: claimed.attemptId, stateDir,
    });
    expect(observed.status).toBe("observed");
  });

  it("stale claimed -> outcome_unknown；outcome_unknown 不自动重 claim；stop 保留 history", () => {
    reconcileFeedbackOutbox(workspace.id, stateDir);
    seedTrustedReceipt("stale1");
    reconcileFeedbackOutbox(workspace.id, stateDir);
    const en = enableReceiver({ workspaceId: workspace.id, principal: principalA(), widgetId: "w", stateDir });
    const b = en.binding!;
    const c = claimNext({ workspaceId: workspace.id, principal: principalA(), bindingId: b.bindingId, epoch: b.epoch, stateDir });
    const file = feedbackStateFile(workspace.id, stateDir);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.events.find((e: FeedbackEvent) => e.eventId === c.event.eventId).claimedAt =
      new Date(Date.now() - 11 * 60_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));
    // 仅 reconcile/status 即可恢复，无需再 claim
    reconcileFeedbackOutbox(workspace.id, stateDir);
    const after = readFeedbackState(workspace.id, stateDir).events.find((e) => e.eventId === c.event.eventId)!;
    expect(after.status).toBe("outcome_unknown");
    expect(() => claimNext({ workspaceId: workspace.id, principal: principalA(), bindingId: b.bindingId, epoch: b.epoch, stateDir }))
      .toThrow(/ready|没有/i);

    stopReceiver({ workspaceId: workspace.id, principal: principalA(), stateDir });
    const stopped = readFeedbackState(workspace.id, stateDir);
    expect(stopped.binding!.status).toBe("superseded");
    expect(stopped.events).toHaveLength(1);
    const re = enableReceiver({ workspaceId: workspace.id, principal: principalA(), widgetId: "w2", stateDir });
    expect(re.events).toHaveLength(1);
  });
});

describe("E1a review-fix", () => {
  it("未初始化：enable/claim 不得隐式 baseline cursor=0", () => {
    expect(() => enableReceiver({ workspaceId: workspace.id, principal: principalA(), widgetId: "w", stateDir }))
      .toThrow(/UNINITIALIZED|尚未初始化/i);
    expect(fs.existsSync(feedbackStateFile(workspace.id, stateDir))).toBe(false);
  });

  it("stale：只 reconcile/status 恢复，不生成新 attempt；takeover 仍被阻止", () => {
    reconcileFeedbackOutbox(workspace.id, stateDir);
    seedTrustedReceipt("stale-only");
    reconcileFeedbackOutbox(workspace.id, stateDir);
    const en = enableReceiver({ workspaceId: workspace.id, principal: principalA(), widgetId: "w", stateDir });
    const b = en.binding!;
    const c = claimNext({ workspaceId: workspace.id, principal: principalA(), bindingId: b.bindingId, epoch: b.epoch, stateDir });
    const file = feedbackStateFile(workspace.id, stateDir);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    raw.events.find((e: FeedbackEvent) => e.eventId === c.event.eventId).claimedAt =
      new Date(Date.now() - 11 * 60_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));
    reconcileFeedbackOutbox(workspace.id, stateDir);
    const after = readFeedbackState(workspace.id, stateDir).events.find((e) => e.eventId === c.event.eventId)!;
    expect(after.status).toBe("outcome_unknown");
    expect(after.attemptId).toBe(c.attemptId);
    expect(() => takeoverReceiver({
      workspaceId: workspace.id, principal: principalB(), widgetId: "wB", expectedEpoch: 1, stateDir,
    })).toThrow(/claimed|接管|outcome_unknown/i);
  });

  it("desktopReceiptSha256 有但无 accepted delivery => fail closed", () => {
    reconcileFeedbackOutbox(workspace.id, stateDir);
    withExecutionRecordsLock(workspace.id, () => {
      appendExecutionRecordLocked(workspace.id, {
        taskId: "manual-x",
        iteration: 1,
        changedFiles: ["a"],
        tests: "t",
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
        commandId: "no-delivery",
        desktopReceiptSha256: "d".repeat(64),
      } as never);
    });
    expect(() => reconcileFeedbackOutbox(workspace.id, stateDir)).toThrow(/IDENTITY_CONFLICT|拒绝静默投影|身份不匹配/);
  });

  it("desktop_* task 但 commandId 缺失 => fail closed", () => {
    reconcileFeedbackOutbox(workspace.id, stateDir);
    withExecutionRecordsLock(workspace.id, () => {
      appendExecutionRecordLocked(workspace.id, {
        taskId: "desktop_orphan",
        iteration: 1,
        changedFiles: ["a"],
        tests: "t",
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
      } as never);
    });
    expect(() => reconcileFeedbackOutbox(workspace.id, stateDir)).toThrow(/IDENTITY_CONFLICT|拒绝静默投影|缺少 commandId/);
  });

  it("普通 manual/finalizer 仍 skip 并前进 cursor", () => {
    reconcileFeedbackOutbox(workspace.id, stateDir);
    appendExecutionRecord(workspace.id, {
      taskId: "finalizer_job",
      iteration: 1,
      changedFiles: 0,
      tests: null,
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
    });
    const r = reconcileFeedbackOutbox(workspace.id, stateDir);
    expect(r.projected).toBe(0);
    expect(r.state.projectionCursor).toBe(1);
    expect(r.state.events).toHaveLength(0);
  });

  it("observed 后 takeover 到 B，B 不能 ack A 的 eventId；A exact 幂等可", () => {
    reconcileFeedbackOutbox(workspace.id, stateDir);
    seedTrustedReceipt("ack-race");
    reconcileFeedbackOutbox(workspace.id, stateDir);
    const enA = enableReceiver({ workspaceId: workspace.id, principal: principalA(), widgetId: "wA", stateDir });
    const bA = enA.binding!;
    const claimed = claimNext({
      workspaceId: workspace.id, principal: principalA(), bindingId: bA.bindingId, epoch: bA.epoch, stateDir,
    });
    const observed = ackObserved({
      workspaceId: workspace.id, principal: principalA(), bindingId: bA.bindingId, epoch: bA.epoch,
      eventId: claimed.event.eventId, attemptId: claimed.attemptId, stateDir,
    });
    expect(observed.status).toBe("observed");
    // A exact 幂等
    const again = ackObserved({
      workspaceId: workspace.id, principal: principalA(), bindingId: bA.bindingId, epoch: bA.epoch,
      eventId: claimed.event.eventId, attemptId: claimed.attemptId, stateDir,
    });
    expect(again.status).toBe("observed");
    // 合法 takeover（无 claimed/unknown）到 B
    const taken = takeoverReceiver({
      workspaceId: workspace.id, principal: principalB(), widgetId: "wB", expectedEpoch: 1, stateDir,
    });
    const bB = taken.state.binding!;
    expect(() => ackObserved({
      workspaceId: workspace.id, principal: principalB(), bindingId: bB.bindingId, epoch: bB.epoch,
      eventId: claimed.event.eventId, attemptId: claimed.attemptId, stateDir,
    })).toThrow(/ACK_MISMATCH|不匹配/i);
  });

  it("MCP：缺 openai/session 的 status/enable 不创建 state 文件", async () => {
    const server = createMcpServer({ workspace, logger: { info() {}, error() {}, warn() {}, debug() {} } as never });
    const tools = (server as unknown as {
      _registeredTools?: Record<string, {
        handler: (a: unknown, e: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
      }>;
    })._registeredTools ?? {};
    const extraNoSession = {
      authInfo: { token: "t", clientId: "c", scopes: [CODEX_FEEDBACK_SCOPE] },
      _meta: { conversationId: "conv-x", threadId: "th-x" },
      requestId: 1,
    };
    const statusRes = await tools.feedback_status.handler({}, extraNoSession);
    expect(statusRes.isError).toBe(true);
    const enableRes = await tools.feedback_enable.handler({ widgetId: "w" }, extraNoSession);
    expect(enableRes.isError).toBe(true);
    expect(fs.existsSync(feedbackStateFile(workspace.id, stateDir))).toBe(false);

    const statusMeta = tools.feedback_status as unknown as { _meta?: { /* annotations on register */ } };
    // annotation 断言在 descriptor
    const registered = tools as unknown as Record<string, { annotations?: { readOnlyHint?: boolean } }>;
    expect(registered.feedback_status!.annotations?.readOnlyHint).toBe(false);
  });
});

describe("MCP production feedback tools", () => {
  it("注册 feedback_* 且无 emit/model_confirm；scope 校验", async () => {
    const server = createMcpServer({ workspace, logger: { info() {}, error() {}, warn() {}, debug() {} } as never });
    const tools = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {};
    const names = Object.keys(tools).filter((k) => k.startsWith("feedback_"));
    expect(names.sort()).toEqual([
      "feedback_ack_observed",
      "feedback_claim_next",
      "feedback_companion_pair",
      "feedback_companion_revoke",
      "feedback_companion_status",
      "feedback_enable",
      "feedback_status",
      "feedback_stop",
      "feedback_takeover",
    ]);
    expect(tools.feedback_emit).toBeUndefined();
    const handler = (tools.feedback_status as { handler: (a: unknown, e: unknown) => Promise<{ isError?: boolean }> }).handler;
    const denied = await handler({}, {
      authInfo: { token: "t", clientId: "c", scopes: ["workspace.read"] },
      requestId: 1,
    });
    expect(denied.isError).toBe(true);
  });
});
