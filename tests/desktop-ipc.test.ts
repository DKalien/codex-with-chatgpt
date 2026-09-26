import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DesktopIpcClient,
  resolveDesktopHelperPath,
  validateDesktopDiagnosis,
  validateDesktopMessage,
  validateDesktopTarget,
  validateDesktopResultActivityMarker,
  validateDesktopResultActivityMarkerObservation,
  validateDesktopResultTerminalFence,
  type DesktopResultActivityMarker,
} from "../src/desktop/ipc.js";
import { MAX_MESSAGE_BYTES } from "../src/desktop/store.js";

const target = {
  threadId: "01a00000-0000-7000-8000-000000000001",
  hostId: "local",
  projectId: "project_test",
  workspaceRoot: "D:\\python\\codex-with-chatgpt",
} as const;

type FakeRequest = Record<string, unknown> & { op?: string; id?: string };
type FakeReply = { ok: true; value: unknown } | { ok: false; code: string; notSent?: boolean };

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

function fakeSpawner(replyFor: (request: FakeRequest) => FakeReply = request => {
  if (request.op === "inspect" || request.op === "prepare") {
    return {
      ok: true,
      value: { ...target, title: "Fake Desktop 会话", cwd: target.workspaceRoot, runtimeStatus: "idle" },
    };
  }
  if (request.op === "send") {
    return { ok: true, value: { threadId: target.threadId, turnId: "01a00000-0000-7000-8000-000000000002" } };
  }
  return { ok: true, value: {} };
}) {
  const requests: FakeRequest[] = [];
  const children: FakeChild[] = [];
  const spawnImpl = vi.fn((_command: string, _args: string[], _options: unknown) => {
    const child = new FakeChild();
    children.push(child);
    let buffered = "";
    child.stdin.on("data", chunk => {
      buffered += Buffer.from(chunk).toString("utf8");
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line) {
          const request = JSON.parse(line) as FakeRequest;
          requests.push(request);
          const reply = replyFor(request);
          setImmediate(() => child.stdout.write(`${JSON.stringify({ id: request.id, ...reply })}\n`));
        }
        newline = buffered.indexOf("\n");
      }
    });
    return child as unknown as ChildProcess;
  });
  return { spawnImpl, requests, children };
}

function makeClient(spawnImpl: ReturnType<typeof fakeSpawner>["spawnImpl"]) {
  return new DesktopIpcClient({
    platform: "win32",
    helperPath: resolveDesktopHelperPath(),
    spawnImpl,
    requestTimeoutMs: 200,
    sendTimeoutMs: 200,
  });
}

describe("Desktop IPC wrapper（fake helper）", () => {
  it("本机确认超时关闭helper，不返回授权结果", async () => {
    vi.stubEnv("CODEX_THREAD_ID", target.threadId); vi.stubEnv("CODEX_SESSION_ID", target.threadId);
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const client = new DesktopIpcClient({ platform: "win32", spawnImpl: () => child as unknown as ChildProcess });
      const result = expect(client.confirmCurrent(target.workspaceRoot)).rejects.toMatchObject({ code: "DESKTOP_CONFIRMATION_CANCELLED" });
      await vi.advanceTimersByTimeAsync(120_000);
      await result;
      expect(child.kill).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); vi.unstubAllEnvs(); }
  });
  it("快捷身份/确认只传workspace，当前ID来自环境，确认取消不变成成功", async () => {
    vi.stubEnv("CODEX_THREAD_ID", target.threadId); vi.stubEnv("CODEX_SESSION_ID", target.threadId);
    try {
      const fake = fakeSpawner(request => request.op === "current_confirm" ?
        { ok: false, code: "DESKTOP_CONFIRMATION_CANCELLED", notSent: true } :
        { ok: true, value: { ...target, title: "当前会话", cwd: target.workspaceRoot, runtimeStatus: "active" } });
      const client = makeClient(fake.spawnImpl);
      expect((await client.currentIdentity(target.workspaceRoot)).runtimeStatus).toBe("active");
      await expect(client.confirmCurrent(target.workspaceRoot)).rejects.toMatchObject({ code: "DESKTOP_CONFIRMATION_CANCELLED" });
      for (const request of fake.requests) {
        expect(Object.keys(request).sort()).toEqual(["id", "op", "workspaceRoot"]);
        expect(request.workspaceRoot).toBe(target.workspaceRoot);
      }
      expect(fake.requests.map(r => r.op)).toEqual(["current_identity", "current_confirm"]);
    } finally { vi.unstubAllEnvs(); }
  });

  it("currentExecution 只传workspace并严格验证运行态与 activeTurnId", async () => {
    vi.stubEnv("CODEX_THREAD_ID", target.threadId); vi.stubEnv("CODEX_SESSION_ID", target.threadId);
    const activeTurnId = "01a00000-0000-7000-8000-000000000003";
    try {
      for (const runtimeStatus of ["active", "inProgress"] as const) {
        const fake = fakeSpawner(request => request.op === "current_execution" ?
          { ok: true, value: { ...target, title: "当前执行会话", cwd: target.workspaceRoot, runtimeStatus, activeTurnId } } :
          { ok: true, value: { ...target, title: "Fake Desktop 会话", cwd: target.workspaceRoot, runtimeStatus: "idle" } });
        const result = await makeClient(fake.spawnImpl).currentExecution(target.workspaceRoot);
        expect(result.activeTurnId).toBe(activeTurnId);
        expect(result.runtimeStatus).toBe(runtimeStatus);
        const request = fake.requests.find(item => item.op === "current_execution");
        expect(request && Object.keys(request).sort()).toEqual(["id", "op", "workspaceRoot"]);
        expect(request?.workspaceRoot).toBe(target.workspaceRoot);
      }

      for (const invalid of [undefined, null, 1, "not-a-uuid"]) {
        const fake = fakeSpawner(request => request.op === "current_execution" ?
          { ok: true, value: { ...target, title: "当前执行会话", cwd: target.workspaceRoot, runtimeStatus: "active", activeTurnId: invalid } } :
          { ok: true, value: { ...target, title: "Fake Desktop 会话", cwd: target.workspaceRoot, runtimeStatus: "idle" } });
        await expect(makeClient(fake.spawnImpl).currentExecution(target.workspaceRoot))
          .rejects.toMatchObject({ code: "DESKTOP_STATE_UNAVAILABLE" });
      }

      const idle = fakeSpawner(request => request.op === "current_execution" ?
        { ok: true, value: { ...target, title: "当前执行会话", cwd: target.workspaceRoot, runtimeStatus: "idle", activeTurnId } } :
        { ok: true, value: { ...target, title: "Fake Desktop 会话", cwd: target.workspaceRoot, runtimeStatus: "idle" } });
      await expect(makeClient(idle.spawnImpl).currentExecution(target.workspaceRoot))
        .rejects.toMatchObject({ code: "DESKTOP_STATE_UNAVAILABLE" });
    } finally { vi.unstubAllEnvs(); }
  });

  it("inspectActiveExecution 使用显式 target，不依赖 CODEX_THREAD_ID 或 runner ancestry", async () => {
    vi.stubEnv("CODEX_THREAD_ID", "");
    const activeTurnId = "01a00000-0000-7000-8000-000000000003";
    const fake = fakeSpawner(request => request.op === "inspect_active_execution"
      ? { ok: true, value: { ...target, title: "目标 active 会话", cwd: target.workspaceRoot, runtimeStatus: "active", activeTurnId } }
      : { ok: true, value: { ...target, title: "Fake Desktop 会话", cwd: target.workspaceRoot, runtimeStatus: "idle" } });
    const result = await makeClient(fake.spawnImpl).inspectActiveExecution(target);
    expect(result).toMatchObject({ ...target, runtimeStatus: "active", activeTurnId });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ op: "inspect_active_execution", target });
    expect(Object.keys(fake.requests[0]).sort()).toEqual(["id", "op", "target"]);
  });

  it("inspectActiveExecution 严格拒绝无效 active turn、idle 和错目标响应", async () => {
    const activeTurnId = "01a00000-0000-7000-8000-000000000003";
    for (const value of [
      { ...target, title: "active", cwd: target.workspaceRoot, runtimeStatus: "active" },
      { ...target, title: "active", cwd: target.workspaceRoot, runtimeStatus: "active", activeTurnId: "not-a-uuid" },
      { ...target, title: "idle", cwd: target.workspaceRoot, runtimeStatus: "idle", activeTurnId },
    ]) {
      const fake = fakeSpawner(() => ({ ok: true, value }));
      await expect(makeClient(fake.spawnImpl).inspectActiveExecution(target))
        .rejects.toMatchObject({ code: "DESKTOP_STATE_UNAVAILABLE" });
    }
    for (const value of [
      { ...target, threadId: randomUUID(), title: "wrong", cwd: target.workspaceRoot, runtimeStatus: "active", activeTurnId },
      { ...target, projectId: "wrong_project", title: "wrong", cwd: target.workspaceRoot, runtimeStatus: "active", activeTurnId },
      { ...target, workspaceRoot: "D:\\python\\other", title: "wrong", cwd: "D:\\python\\other", runtimeStatus: "active", activeTurnId },
    ]) {
      const fake = fakeSpawner(() => ({ ok: true, value }));
      await expect(makeClient(fake.spawnImpl).inspectActiveExecution(target))
        .rejects.toMatchObject({ code: "DESKTOP_TARGET_NOT_FOUND" });
    }
  });

  it("inspectResultContext 使用显式 target，不需要 runner 环境且严格限制 public schema", async () => {
    vi.stubEnv("CODEX_THREAD_ID", "");
    const resultTurnId = "01a00000-0000-7000-8000-000000000003";
    const value = {
      ...target,
      title: "目标结果会话",
      cwd: target.workspaceRoot,
      workspaceKind: "project",
      resumeState: "resumed",
      runtimeStatus: "idle",
      requestsCount: 0,
      ownerClientId: "01a00000-0000-7000-8000-000000000004",
      resultTurnId,
      resultTurnStatus: "completed",
    };
    const fake = fakeSpawner(request => request.op === "inspect_result_context"
      ? { ok: true, value }
      : { ok: true, value: {} });
    await expect(makeClient(fake.spawnImpl).inspectResultContext(target)).resolves.toMatchObject({
      ...target, ownerClientId: "01a00000-0000-7000-8000-000000000004", resultTurnId, resultTurnStatus: "completed",
    });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ op: "inspect_result_context", target });
    expect(Object.keys(fake.requests[0]).sort()).toEqual(["id", "op", "target"]);
    expect(Object.keys(value).sort()).toEqual([
      "cwd", "hostId", "ownerClientId", "projectId", "requestsCount",
      "resultTurnId", "resultTurnStatus", "resumeState", "runtimeStatus", "threadId", "title",
      "workspaceKind", "workspaceRoot",
    ]);

    const extra = fakeSpawner(request => request.op === "inspect_result_context"
      ? { ok: true, value: { ...value, secret: "nope" } }
      : { ok: true, value: {} });
    await expect(makeClient(extra.spawnImpl).inspectResultContext(target))
      .rejects.toMatchObject({ code: "DESKTOP_PROTOCOL_ERROR" });
    vi.unstubAllEnvs();
  });

  it("inspectResultActivityMarker 只投影有序 item id/type 且使用严格 target request", async () => {
    vi.stubEnv("CODEX_THREAD_ID", "");
    const resultTurnId = "01a00000-0000-7000-8000-000000000003";
    const marker = {
      resultTurnId,
      itemIds: ["item-1", "item-2"],
      itemTypes: ["userMessage", "commandExecution"],
      itemCount: 2,
      itemSha256: "a".repeat(64),
    } satisfies DesktopResultActivityMarker;
    const value = {
      ...target,
      title: "marker session",
      cwd: target.workspaceRoot,
      workspaceKind: "project",
      resumeState: "resumed",
      runtimeStatus: "inProgress",
      requestsCount: 0,
      ownerClientId: "01a00000-0000-7000-8000-000000000004",
      resultTurnId,
      resultTurnStatus: "inProgress",
      marker,
    };
    const fake = fakeSpawner(request => request.op === "inspect_result_activity_marker"
      ? { ok: true, value }
      : { ok: true, value: {} });
    await expect(makeClient(fake.spawnImpl).inspectResultActivityMarker(target)).resolves.toEqual(value);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ op: "inspect_result_activity_marker", target });
    expect(Object.keys(fake.requests[0]).sort()).toEqual(["id", "op", "target"]);
    vi.unstubAllEnvs();
  });

  it("inspectResultTerminalFence 传 marker 做一次性 prefix fence，且不传正文", async () => {
    vi.stubEnv("CODEX_THREAD_ID", "");
    const resultTurnId = "01a00000-0000-7000-8000-000000000003";
    const marker = {
      resultTurnId,
      itemIds: ["item-1"],
      itemTypes: ["userMessage"],
      itemCount: 1,
      itemSha256: "a".repeat(64),
    } satisfies DesktopResultActivityMarker;
    const base = {
      ...target,
      title: "fence session",
      cwd: target.workspaceRoot,
      workspaceKind: "project",
      resumeState: "resumed",
      runtimeStatus: "idle",
      requestsCount: 0,
      ownerClientId: "01a00000-0000-7000-8000-000000000004",
      resultTurnId,
      resultTurnStatus: "completed",
    };
    const fake = fakeSpawner(request => request.op === "inspect_result_terminal_fence"
      ? { ok: true, value: { ...base, fence: "safe_terminal" } }
      : { ok: true, value: {} });
    await expect(makeClient(fake.spawnImpl).inspectResultTerminalFence(target, marker)).resolves.toMatchObject({
      ...base, fence: "safe_terminal",
    });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ op: "inspect_result_terminal_fence", target, marker });
    expect(Object.keys(fake.requests[0]).sort()).toEqual(["id", "marker", "op", "target"]);
    vi.unstubAllEnvs();
  });

  it("activity marker/fence validators 对未知 type、重复 ID、raw body 和状态错配 fail closed", () => {
    const marker = {
      resultTurnId: target.threadId,
      itemIds: ["item-1"],
      itemTypes: ["userMessage"],
      itemCount: 1,
      itemSha256: "a".repeat(64),
    };
    expect(validateDesktopResultActivityMarker(marker)).toEqual(marker);
    for (const broken of [
      { ...marker, itemTypes: ["unknown"] },
      { ...marker, itemIds: ["item-1", "item-1"], itemTypes: ["userMessage", "agentMessage"], itemCount: 2 },
      { ...marker, body: "secret" },
      { ...marker, itemSha256: "bad" },
    ]) {
      expect(() => validateDesktopResultActivityMarker(broken)).toThrowError(/无法安全确认/);
    }
    const context = {
      ...target,
      title: "marker",
      cwd: target.workspaceRoot,
      workspaceKind: "project",
      resumeState: "resumed",
      runtimeStatus: "active",
      requestsCount: 0,
      ownerClientId: "01a00000-0000-7000-8000-000000000004",
      resultTurnId: target.threadId,
      resultTurnStatus: "inProgress",
    };
    expect(validateDesktopResultActivityMarkerObservation({ ...context, marker }, target).marker).toEqual(marker);
    expect(() => validateDesktopResultTerminalFence({ ...context, fence: "safe_terminal" }, target)).toThrow();
  });

  it("currentResultContext 只传workspace，支持 active exact 与 idle terminal exact", async () => {
    vi.stubEnv("CODEX_THREAD_ID", target.threadId); vi.stubEnv("CODEX_SESSION_ID", target.threadId);
    const resultTurnId = "01a00000-0000-7000-8000-000000000003";
    try {
      for (const [runtimeStatus, resultTurnStatus] of [["active", "inProgress"], ["inProgress", "inProgress"], ["idle", "completed"]] as const) {
        const fake = fakeSpawner(request => request.op === "current_result_context" ?
          { ok: true, value: { ...target, title: "结果会话", cwd: target.workspaceRoot, runtimeStatus, resultTurnId, resultTurnStatus } } :
          { ok: true, value: { ...target, title: "Fake Desktop 会话", cwd: target.workspaceRoot, runtimeStatus: "idle" } });
        const result = await makeClient(fake.spawnImpl).currentResultContext(target.workspaceRoot);
        expect(result).toMatchObject({ runtimeStatus, resultTurnId, resultTurnStatus });
        const request = fake.requests.find(item => item.op === "current_result_context");
        expect(request && Object.keys(request).sort()).toEqual(["id", "op", "workspaceRoot"]);
      }

      for (const value of [
        { ...target, title: "结果会话", cwd: target.workspaceRoot, runtimeStatus: "idle", resultTurnId, resultTurnStatus: "inProgress" },
        { ...target, title: "结果会话", cwd: target.workspaceRoot, runtimeStatus: "idle", resultTurnId, resultTurnStatus: "future" },
        { ...target, title: "结果会话", cwd: target.workspaceRoot, runtimeStatus: "active", resultTurnId, resultTurnStatus: "completed" },
      ]) {
        const fake = fakeSpawner(request => request.op === "current_result_context" ? { ok: true, value } :
          { ok: true, value: { ...target, title: "Fake Desktop 会话", cwd: target.workspaceRoot, runtimeStatus: "idle" } });
        await expect(makeClient(fake.spawnImpl).currentResultContext(target.workspaceRoot))
          .rejects.toMatchObject({ code: "DESKTOP_STATE_UNAVAILABLE" });
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it("currentResultClassification 只传workspace，并投影 self-attestation 与 applicable ownership", async () => {
    vi.stubEnv("CODEX_THREAD_ID", target.threadId); vi.stubEnv("CODEX_SESSION_ID", target.threadId);
    const resultTurnId = "01a00000-0000-7000-8000-000000000003";
    const attestation = {
      workspaceId: "workspace_test",
      commandId: "desktop_command_test",
      intent: "development_plan" as const,
      messageBytes: 3,
      messageSha256: "a".repeat(64),
      originTurnId: resultTurnId,
    };
    try {
      const fake = fakeSpawner(request => request.op === "current_result_classification" ? {
        ok: true,
        value: {
          ...target, title: "结果分类会话", cwd: target.workspaceRoot, runtimeStatus: "active",
          resultTurnId, resultTurnStatus: "inProgress", classification: "applicable",
          ...attestation, ownership: "origin", originTurnId: resultTurnId,
          originAlias: null, chainTurnIds: [resultTurnId], chainLength: 0, chainSignatures: [], signature: null,
        },
      } : { ok: true, value: {} });
    const result = await makeClient(fake.spawnImpl).currentResultClassification(target.workspaceRoot);
    expect(result).toMatchObject({ classification: "applicable", ...attestation,
      ownership: "origin", resultTurnId, chainSignatures: [] });
      expect(fake.requests).toHaveLength(1);
      expect(Object.keys(fake.requests[0]).sort()).toEqual(["id", "op", "workspaceRoot"]);
    } finally { vi.unstubAllEnvs(); }
  });

  it("currentResultClassification 接受严格 allowlist 内的 manual resume signature", async () => {
    vi.stubEnv("CODEX_THREAD_ID", target.threadId); vi.stubEnv("CODEX_SESSION_ID", target.threadId);
    const originTurnId = "01a00000-0000-7000-8000-000000000004";
    const resultTurnId = "01a00000-0000-7000-8000-000000000005";
    const fake = fakeSpawner(request => request.op === "current_result_classification" ? {
      ok: true,
      value: {
        ...target, title: "结果分类会话", cwd: target.workspaceRoot, runtimeStatus: "idle",
        resultTurnId, resultTurnStatus: "completed", classification: "applicable",
        workspaceId: "workspace_test", commandId: "desktop_command_test", intent: "development_plan",
        messageBytes: 3, messageSha256: "a".repeat(64), ownership: "native_continuation",
        originTurnId, originAlias: null, chainTurnIds: [originTurnId, resultTurnId], chainLength: 1,
        chainSignatures: ["resume_interrupted_task"],
        signature: "resume_interrupted_task",
      },
    } : { ok: true, value: {} });
    try {
      await expect(makeClient(fake.spawnImpl).currentResultClassification(target.workspaceRoot))
        .resolves.toMatchObject({ ownership: "native_continuation", signature: "resume_interrupted_task", originTurnId, resultTurnId });
    } finally { vi.unstubAllEnvs(); }
  });

  it("currentResultClassification 保留 mixed chain 的逐边签名顺序", async () => {
    vi.stubEnv("CODEX_THREAD_ID", target.threadId); vi.stubEnv("CODEX_SESSION_ID", target.threadId);
    const originTurnId = "01a00000-0000-7000-8000-000000000004";
    const middleTurnId = "01a00000-0000-7000-8000-000000000005";
    const resultTurnId = "01a00000-0000-7000-8000-000000000006";
    const value = {
      ...target, title: "混合 continuation 会话", cwd: target.workspaceRoot, runtimeStatus: "idle",
      resultTurnId, resultTurnStatus: "completed", classification: "applicable",
      workspaceId: "workspace_test", commandId: "desktop_command_test", intent: "development_plan",
      messageBytes: 3, messageSha256: "a".repeat(64), ownership: "native_continuation",
      originTurnId, originAlias: null, chainTurnIds: [originTurnId, middleTurnId, resultTurnId], chainLength: 2,
      chainSignatures: ["capacity_retry_automatic", "resume_interrupted_task"],
      signature: "resume_interrupted_task",
    };
    const fake = fakeSpawner(request => request.op === "current_result_classification"
      ? { ok: true, value } : { ok: true, value: {} });
    try {
      await expect(makeClient(fake.spawnImpl).currentResultClassification(target.workspaceRoot))
        .resolves.toMatchObject({ chainTurnIds: [originTurnId, middleTurnId, resultTurnId],
          chainSignatures: ["capacity_retry_automatic", "resume_interrupted_task"],
          signature: "resume_interrupted_task" });
    } finally { vi.unstubAllEnvs(); }
  });

  it("currentResultClassification 只接受与 v2 deliveryId 绑定的 edit alias 形态", async () => {
    vi.stubEnv("CODEX_THREAD_ID", target.threadId); vi.stubEnv("CODEX_SESSION_ID", target.threadId);
    const deliveryId = randomUUID();
    const originTurnId = "01a00000-0000-7000-8000-000000000004";
    const resultTurnId = "01a00000-0000-7000-8000-000000000005";
    const valid = {
      ...target, title: "v2 alias 会话", cwd: target.workspaceRoot, runtimeStatus: "idle",
      resultTurnId, resultTurnStatus: "completed", classification: "applicable",
      workspaceId: "workspace_test", commandId: "desktop_command_test", intent: "development_plan",
      messageBytes: 3, messageSha256: "a".repeat(64), deliveryId,
      ownership: "native_continuation", originTurnId, originAlias: "edit_user_message_v2_delivery",
      chainTurnIds: [originTurnId, resultTurnId], chainLength: 1,
      chainSignatures: ["resume_interrupted_task"], signature: "resume_interrupted_task",
    };
    const fake = fakeSpawner(request => request.op === "current_result_classification"
      ? { ok: true, value: valid } : { ok: true, value: {} });
    try {
      await expect(makeClient(fake.spawnImpl).currentResultClassification(target.workspaceRoot)).resolves.toMatchObject({
        classification: "applicable", deliveryId, originAlias: "edit_user_message_v2_delivery",
      });
      const malformed = [
        { ...valid, deliveryId: "not-a-uuid" },
        { ...valid, deliveryId: undefined },
        { ...valid, originAlias: "arbitrary_alias" },
        { ...valid, ownership: "origin" },
        { ...valid, chainSignatures: ["capacity_retry_automatic"] },
        (() => { const copy: Record<string, unknown> = { ...valid }; delete copy.originAlias; return copy; })(),
      ];
      for (const broken of malformed) {
        const invalid = fakeSpawner(request => request.op === "current_result_classification"
          ? { ok: true, value: broken } : { ok: true, value: {} });
        await expect(makeClient(invalid.spawnImpl).currentResultClassification(target.workspaceRoot))
          .rejects.toMatchObject({ code: "DESKTOP_PROTOCOL_ERROR" });
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it("result classification 拒绝 origin 非空签名和 not_applicable ownership 字段", async () => {
    vi.stubEnv("CODEX_THREAD_ID", target.threadId); vi.stubEnv("CODEX_SESSION_ID", target.threadId);
    const resultTurnId = "01a00000-0000-7000-8000-000000000003";
    const origin = {
      ...target, title: "结果分类会话", cwd: target.workspaceRoot, runtimeStatus: "active",
      resultTurnId, resultTurnStatus: "inProgress", classification: "applicable",
      workspaceId: "workspace_test", commandId: "desktop_command_test", intent: "development_plan",
      messageBytes: 3, messageSha256: "a".repeat(64), ownership: "origin", originTurnId: resultTurnId,
      originAlias: null, chainTurnIds: [resultTurnId], chainLength: 0, chainSignatures: [], signature: null,
    };
    const cases = [
      { ...origin, chainSignatures: ["capacity_retry_automatic"] },
      { ...origin, chainSignatures: ["unknown"] },
      { ...origin, extra: true },
      { ...target, title: "普通结果", cwd: target.workspaceRoot, runtimeStatus: "idle",
        resultTurnId, resultTurnStatus: "completed", classification: "not_applicable",
        chainSignatures: [] },
    ];
    try {
      for (const value of cases) {
        const fake = fakeSpawner(request => request.op === "current_result_classification"
          ? { ok: true, value } : { ok: true, value: {} });
        await expect(makeClient(fake.spawnImpl).currentResultClassification(target.workspaceRoot))
          .rejects.toMatchObject({ code: "DESKTOP_PROTOCOL_ERROR" });
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it("缺失/伪造当前ID或helper错目标不能绑定", async () => {
    const fake = fakeSpawner(() => ({ ok: true, value: { ...target, threadId: randomUUID(), title: "错误会话", cwd: target.workspaceRoot } }));
    try {
      vi.stubEnv("CODEX_THREAD_ID", "");
      await expect(makeClient(fake.spawnImpl).currentIdentity(target.workspaceRoot)).rejects.toMatchObject({ code: "DESKTOP_CURRENT_CONTEXT_INVALID" });
      vi.stubEnv("CODEX_THREAD_ID", target.threadId); vi.stubEnv("CODEX_SESSION_ID", randomUUID());
      await expect(makeClient(fake.spawnImpl).currentIdentity(target.workspaceRoot)).rejects.toMatchObject({ code: "DESKTOP_CURRENT_CONTEXT_INVALID" });
      expect(fake.spawnImpl).not.toHaveBeenCalled();
      vi.stubEnv("CODEX_SESSION_ID", target.threadId);
      await expect(makeClient(fake.spawnImpl).currentIdentity(target.workspaceRoot)).rejects.toMatchObject({ code: "DESKTOP_TARGET_NOT_FOUND" });
    } finally { vi.unstubAllEnvs(); }
  });

  it("diagnose 只发送 workspaceRoot，并严格投影 live handshake 诊断字段", async () => {
    const expected = {
      mode: "behavioral" as const,
      processStable: true,
      initialize: true,
      ownerDiscovery: true,
      followingChangedSent: true,
      stateReceived: true,
      stateChange: "snapshot" as const,
    };
    const fake = fakeSpawner(request => request.op === "diagnose" ? {
      ok: true,
      value: expected,
    } : { ok: true, value: {} });
    await expect(makeClient(fake.spawnImpl).diagnose(target.workspaceRoot)).resolves.toEqual(expected);
    const polluted = fakeSpawner(request => request.op === "diagnose" ? {
      ok: true,
      value: { ...expected, token: "secret-token" },
    } : { ok: true, value: {} });
    await expect(makeClient(polluted.spawnImpl).diagnose(target.workspaceRoot))
      .rejects.toMatchObject({ code: "DESKTOP_PROTOCOL_ERROR" });
    expect(fake.requests).toHaveLength(1);
    expect(Object.keys(fake.requests[0]).sort()).toEqual(["id", "op", "workspaceRoot"]);
    expect(fake.requests[0].op).toBe("diagnose");
  });

  it("diagnose 错误不带回任意字段", async () => {
    const fake = fakeSpawner(request => request.op === "diagnose" ? {
      ok: false,
      code: "DESKTOP_STATE_UNAVAILABLE",
      notSent: true,
      compatibility: { token: "secret-token", rawError: "secret-error" },
    } : { ok: true, value: {} });
    try {
      await makeClient(fake.spawnImpl).diagnose(target.workspaceRoot);
      throw new Error("diagnose 错误未被拒绝");
    } catch (error) {
      expect(error).toMatchObject({ code: "DESKTOP_STATE_UNAVAILABLE", notSent: true });
      expect(error).not.toHaveProperty("compatibility");
      expect(error).not.toHaveProperty("token");
      expect(String((error as Error).message)).not.toContain("secret");
    }
  });

  it("currentResultOwnership 只传当前 workspace + exact expectation，并严格验证 native chain", async () => {
    vi.stubEnv("CODEX_THREAD_ID", target.threadId); vi.stubEnv("CODEX_SESSION_ID", target.threadId);
    const originTurnId = "01a00000-0000-7000-8000-000000000004";
    const resultTurnId = "01a00000-0000-7000-8000-000000000005";
    const expectation = {
      workspaceId: "workspace_test", commandId: "command_test", intent: "development_plan" as const,
      messageBytes: 10, messageSha256: "a".repeat(64), originTurnId,
    };
    const value = {
      ...target, title: "结果会话", cwd: target.workspaceRoot, runtimeStatus: "active",
      resultTurnId, resultTurnStatus: "inProgress", ownership: "native_continuation",
      originTurnId, originAlias: null, chainTurnIds: [originTurnId, resultTurnId], chainLength: 1,
      chainSignatures: ["resume_interrupted_task"],
      signature: "resume_interrupted_task",
    };
    const fake = fakeSpawner(request => request.op === "current_result_ownership"
      ? { ok: true, value }
      : { ok: true, value: { ...target, title: "Fake Desktop 会话", cwd: target.workspaceRoot, runtimeStatus: "idle" } });
    const result = await makeClient(fake.spawnImpl).currentResultOwnership(target.workspaceRoot, expectation);
    expect(result).toMatchObject({ ownership: "native_continuation", originTurnId, resultTurnId, chainLength: 1,
      signature: "resume_interrupted_task" });
    expect(fake.requests).toHaveLength(1);
    expect(Object.keys(fake.requests[0]).sort()).toEqual(["expectation", "id", "op", "workspaceRoot"]);
    expect(fake.requests[0]).toMatchObject({ op: "current_result_ownership", workspaceRoot: target.workspaceRoot, expectation });

    const capacity = fakeSpawner(request => request.op === "current_result_ownership"
      ? { ok: true, value: { ...value, chainSignatures: ["capacity_retry_automatic"], signature: "capacity_retry_automatic" } }
      : { ok: true, value: { ...target, title: "Fake Desktop 会话", cwd: target.workspaceRoot, runtimeStatus: "idle" } });
    await expect(makeClient(capacity.spawnImpl).currentResultOwnership(target.workspaceRoot, expectation))
      .resolves.toMatchObject({ signature: "capacity_retry_automatic" });

    const missingChainSignatures = { ...value } as Record<string, unknown>;
    delete missingChainSignatures.chainSignatures;
    for (const broken of [
      missingChainSignatures,
      { ...value, chainTurnIds: [originTurnId], chainLength: 0 },
      { ...value, chainSignatures: [] },
      { ...value, chainSignatures: ["unknown"] },
      { ...value, chainSignatures: ["capacity_retry_automatic"] },
      { ...value, signature: "wrong" },
      { ...value, extra: true },
      { ...value, resultTurnId: randomUUID() },
      { ...value, runtimeStatus: "idle", resultTurnStatus: "inProgress" },
      { ...value, threadId: randomUUID() },
    ]) {
      const invalid = fakeSpawner(request => request.op === "current_result_ownership"
        ? { ok: true, value: broken }
        : { ok: true, value: { ...target, title: "Fake Desktop 会话", cwd: target.workspaceRoot, runtimeStatus: "idle" } });
      await expect(makeClient(invalid.spawnImpl).currentResultOwnership(target.workspaceRoot, expectation))
        .rejects.toMatchObject({ code: expect.stringMatching(/DESKTOP_(PROTOCOL_ERROR|STATE_UNAVAILABLE|TARGET_NOT_FOUND|RECONCILIATION_CONFLICT)/) });
    }
    vi.unstubAllEnvs();
  });

  it("currentResultOwnership 允许 alias turn 与 accepted origin 不同但必须精确匹配 v2 ID", async () => {
    vi.stubEnv("CODEX_THREAD_ID", target.threadId); vi.stubEnv("CODEX_SESSION_ID", target.threadId);
    const deliveryId = randomUUID();
    const acceptedTurnId = "01a00000-0000-7000-8000-000000000004";
    const materializedTurnId = "01a00000-0000-7000-8000-000000000005";
    const resultTurnId = "01a00000-0000-7000-8000-000000000006";
    const expectation = {
      workspaceId: "workspace_test", commandId: "command_test", intent: "development_plan" as const,
      messageBytes: 10, messageSha256: "a".repeat(64), originTurnId: acceptedTurnId, deliveryId,
    };
    const value = {
      ...target, title: "v2 alias ownership", cwd: target.workspaceRoot, runtimeStatus: "idle",
      resultTurnId, resultTurnStatus: "completed", ownership: "native_continuation",
      originTurnId: materializedTurnId, deliveryId, originAlias: "edit_user_message_v2_delivery",
      chainTurnIds: [materializedTurnId, resultTurnId], chainLength: 1,
      chainSignatures: ["resume_interrupted_task"], signature: "resume_interrupted_task",
    };
    const fake = fakeSpawner(request => request.op === "current_result_ownership"
      ? { ok: true, value } : { ok: true, value: {} });
    try {
      await expect(makeClient(fake.spawnImpl).currentResultOwnership(target.workspaceRoot, expectation))
        .resolves.toMatchObject({ deliveryId, originTurnId: materializedTurnId, originAlias: "edit_user_message_v2_delivery" });
      const mismatch = fakeSpawner(request => request.op === "current_result_ownership"
        ? { ok: true, value: { ...value, deliveryId: randomUUID() } } : { ok: true, value: {} });
      await expect(makeClient(mismatch.spawnImpl).currentResultOwnership(target.workspaceRoot, expectation))
        .rejects.toMatchObject({ code: "DESKTOP_RECONCILIATION_CONFLICT" });
    } finally { vi.unstubAllEnvs(); }
  });

  it("inspectResultOwnership uses an explicit target and rejects malformed expectations/results", async () => {
    const originTurnId = "01a00000-0000-7000-8000-000000000004";
    const expectation = {
      workspaceId: "workspace_test", commandId: "command_test", intent: "revision" as const,
      messageBytes: 10, messageSha256: "a".repeat(64), originTurnId,
    };
    const valid = {
      ...target, title: "Target-scoped result", cwd: target.workspaceRoot, runtimeStatus: "idle",
      resultTurnId: originTurnId, resultTurnStatus: "completed", ownership: "origin", originTurnId,
      originAlias: null, chainTurnIds: [originTurnId], chainLength: 0, chainSignatures: [], signature: null,
    };
    const fake = fakeSpawner(request => request.op === "inspect_result_ownership"
      ? { ok: true, value: valid } : { ok: true, value: {} });
    const result = await makeClient(fake.spawnImpl).inspectResultOwnership(target, expectation);
    expect(result).toMatchObject({ ownership: "origin", originTurnId, chainSignatures: [] });
    expect(fake.requests).toHaveLength(1);
    expect(Object.keys(fake.requests[0]).sort()).toEqual(["expectation", "id", "op", "target"]);
    expect(fake.requests[0]).toMatchObject({ op: "inspect_result_ownership", target, expectation });

    const deliveryId = randomUUID();
    const v2Expectation = { ...expectation, deliveryId };
    const v2Origin = { ...valid, deliveryId };
    await expect(makeClient(fakeSpawner(request => request.op === "inspect_result_ownership"
      ? { ok: true, value: v2Origin } : { ok: true, value: {} }).spawnImpl)
      .inspectResultOwnership(target, v2Expectation)).resolves.toMatchObject({ deliveryId });
    for (const mismatchedDelivery of [
      (() => { const value = { ...v2Origin } as Record<string, unknown>; delete value.deliveryId; return value; })(),
      { ...v2Origin, deliveryId: randomUUID() },
    ]) {
      await expect(makeClient(fakeSpawner(request => request.op === "inspect_result_ownership"
        ? { ok: true, value: mismatchedDelivery } : { ok: true, value: {} }).spawnImpl)
        .inspectResultOwnership(target, v2Expectation)).rejects.toMatchObject({ code: "DESKTOP_RECONCILIATION_CONFLICT" });
    }
    await expect(makeClient(fakeSpawner(request => request.op === "inspect_result_ownership"
      ? { ok: true, value: { ...valid, deliveryId } } : { ok: true, value: {} }).spawnImpl)
      .inspectResultOwnership(target, expectation)).rejects.toMatchObject({ code: "DESKTOP_RECONCILIATION_CONFLICT" });

    const malformedRequest = fakeSpawner();
    await expect(makeClient(malformedRequest.spawnImpl).inspectResultOwnership(
      target, { ...expectation, ignored: true } as never,
    )).rejects.toMatchObject({ code: "DESKTOP_INVALID_REQUEST" });
    expect(malformedRequest.requests).toEqual([]);

    const wrongTarget = fakeSpawner(request => request.op === "inspect_result_ownership"
      ? { ok: true, value: { ...valid, threadId: randomUUID() } } : { ok: true, value: {} });
    await expect(makeClient(wrongTarget.spawnImpl).inspectResultOwnership(target, expectation))
      .rejects.toMatchObject({ code: "DESKTOP_TARGET_NOT_FOUND" });

    for (const broken of [
      { ...valid, originAlias: "arbitrary_alias" },
      { ...valid, chainSignatures: ["unknown"] },
      { ...valid, signature: "capacity_retry_automatic" },
      (() => { const value = { ...valid } as Record<string, unknown>; delete value.chainSignatures; return value; })(),
    ]) {
      const malformedResponse = fakeSpawner(request => request.op === "inspect_result_ownership"
        ? { ok: true, value: broken } : { ok: true, value: {} });
      await expect(makeClient(malformedResponse.spawnImpl).inspectResultOwnership(target, expectation))
        .rejects.toMatchObject({ code: "DESKTOP_PROTOCOL_ERROR" });
    }
  });

  it("diagnose validator 拒绝未知字段、缺字段和坏诊断值", () => {
    const base = {
      mode: "behavioral" as const,
      processStable: true,
      initialize: true,
      ownerDiscovery: true,
      followingChangedSent: true,
      stateReceived: true,
      stateChange: "snapshot" as const,
    };
    expect(validateDesktopDiagnosis(base)).toEqual(base);
    expect(() => validateDesktopDiagnosis({ ...base, extra: true })).toThrowError(/无法安全确认/);
    expect(() => validateDesktopDiagnosis({ ...base, stateChange: "bad" })).toThrowError(/无法安全确认/);
    expect(() => validateDesktopDiagnosis({ ...base, processStable: false })).toThrowError(/无法安全确认/);
    expect(() => validateDesktopDiagnosis({ ...base, initialize: false })).toThrowError(/无法安全确认/);
    expect(() => validateDesktopDiagnosis({ ...base, mode: "compatibility" })).toThrowError(/无法安全确认/);
    expect(() => validateDesktopDiagnosis({ ...base, ownerDiscovery: "yes" })).toThrowError(/无法安全确认/);
    expect(() => validateDesktopDiagnosis({ ...base, followingChangedSent: null })).toThrowError(/无法安全确认/);
  });

  it("使用隔离、无 shell 的 helper，并保留中文多行正文直到接受回执", async () => {
    const previousPython = process.env.C2C_DESKTOP_PYTHON;
    delete process.env.C2C_DESKTOP_PYTHON;

    try {
      const fake = fakeSpawner();
      const client = makeClient(fake.spawnImpl);
      const message = "请按已确认方案执行。\n\n```ts\nconst greeting = '你好';\n```";

      const connection = await client.prepare(target);
      await expect(connection.send(message)).resolves.toEqual({
        threadId: target.threadId,
        turnId: "01a00000-0000-7000-8000-000000000002",
      });
      connection.close();

      expect(fake.spawnImpl).toHaveBeenCalledWith(
        "python",
        ["-I", "-B", "-X", "utf8", resolveDesktopHelperPath()],
        expect.objectContaining({ shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] }),
      );
      expect(fake.requests.map(request => request.op)).toEqual(["prepare", "send"]);
      expect(fake.requests[0]).toMatchObject({ op: "prepare", target });
      expect(fake.requests[1]).toMatchObject({ op: "send", message });
      expect(fake.requests[1]).not.toHaveProperty("model");
      expect(fake.requests[1]).not.toHaveProperty("provider");
      expect(fake.requests[1]).not.toHaveProperty("cwd");
      expect(fake.requests[1]).not.toHaveProperty("sandbox");
    } finally {
      if (previousPython === undefined) {
        delete process.env.C2C_DESKTOP_PYTHON;
      } else {
        process.env.C2C_DESKTOP_PYTHON = previousPython;
      }
    }
  });

  it("支持 UUIDv7，并在输入边界拒绝额外字段、非法 Unicode 与超限正文", () => {
    expect(validateDesktopTarget(target)).toEqual(target);
    expect(validateDesktopMessage("中".repeat(21845) + "x")).toHaveLength(21846);
    expect(Buffer.byteLength("中".repeat(21845) + "x", "utf8")).toBe(MAX_MESSAGE_BYTES);
    expect(() => validateDesktopTarget({ ...target, extra: true } as never)).toThrowError(/格式无效/);
    expect(() => validateDesktopMessage("中".repeat(21846))).toThrowError(/64 KiB/);
    expect(() => validateDesktopMessage("\ud800")).toThrowError(/格式无效/);
  });

  it("不在非 Windows 平台启动 helper", async () => {
    const spawnImpl = vi.fn();
    const client = new DesktopIpcClient({ platform: "linux", spawnImpl });
    await expect(client.inspect(target)).rejects.toMatchObject({ code: "DESKTOP_UNSUPPORTED_PLATFORM" });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("helper 返回错目标或错回执时 fail closed，不伪造 accepted", async () => {
    const wrongInfo = fakeSpawner(request => {
      if (request.op === "inspect") {
        return { ok: true, value: { ...target, threadId: randomUUID(), title: "伪造", cwd: target.workspaceRoot } };
      }
      return { ok: true, value: {} };
    });
    await expect(makeClient(wrongInfo.spawnImpl).inspect(target)).rejects.toMatchObject({ code: "DESKTOP_TARGET_NOT_FOUND" });

    const wrongReceipt = fakeSpawner(request => {
      if (request.op === "send") return { ok: true, value: { threadId: randomUUID(), turnId: randomUUID() } };
      return {
        ok: true,
        value: { ...target, title: "Fake Desktop 会话", cwd: target.workspaceRoot },
      };
    });
    const connection = await makeClient(wrongReceipt.spawnImpl).prepare(target);
    await expect(connection.send("执行修订")).rejects.toMatchObject({ code: "DESKTOP_OUTCOME_UNKNOWN", notSent: false });
    connection.close();
  });

  it("helper 错误缺少 notSent 时，send 仍按结果不明处理", async () => {
    const fake = fakeSpawner(request => {
      if (request.op === "send") return { ok: false, code: "DESKTOP_BUSY" };
      return {
        ok: true,
        value: { ...target, title: "Fake Desktop 会话", cwd: target.workspaceRoot },
      };
    });
    const connection = await makeClient(fake.spawnImpl).prepare(target);
    try {
      await connection.send("执行修订");
      throw new Error("send 错误未被拒绝");
    } catch (error) {
      expect(error).toMatchObject({ code: "DESKTOP_BUSY", notSent: false });
    }
    connection.close();
  });

  it("stdout 非法 UTF-8 作为协议错误处理，且不会把原始内容带回错误", async () => {
    const fake = fakeSpawner(request => {
      if (request.op === "inspect") return { ok: true, value: {} };
      return { ok: true, value: {} };
    });
    const child = fake.children;
    const client = makeClient(fake.spawnImpl);
    const inspection = client.inspect(target);
    await vi.waitFor(() => expect(child).toHaveLength(1));
    child[0].stdout.write(Buffer.from([0xff, 0x0a]));
    try {
      await inspection;
      throw new Error("非法 UTF-8 未被拒绝");
    } catch (error) {
      expect(error).toMatchObject({ code: "DESKTOP_PROTOCOL_ERROR" });
      expect(String((error as Error).message)).not.toContain("ff");
    }
  });
});
