import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rollout } from "../src/core/rollout.js";
import * as installModule from "../src/core/install.js";
import * as buildId from "../src/build-id.js";
import * as runtimeModule from "../src/bridge/runtime.js";
import * as daemon from "../src/process/daemon.js";
import { desktopIpc } from "../src/desktop/ipc.js";
import { updateDesktop } from "../src/desktop/store.js";
import { updateRemote } from "../src/remote/store.js";
import { writeRuntimeState, type RuntimeState } from "../src/bridge/runtime.js";
import { writeTunnelState } from "../src/tunnel/state.js";
import { readSession, sessionFile, writeSession } from "../src/session/state.js";
import { pendingFile, readPending, writePending } from "../src/core/upgrade.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const targetBuildId = "a".repeat(64);
const oldBuildId = "b".repeat(64);
const threadId = "01a00000-0000-7000-8000-000000000001";
let stateDir: string;
const roots: string[] = [];
const contexts = new Map<string, Context>();

interface Context {
  workspace: Workspace;
  runtime: RuntimeState;
  info: Record<string, unknown>;
  host: string;
  afterRuntime?: RuntimeState;
  afterInfo?: Record<string, unknown>;
}

beforeEach(() => {
  stateDir = makeTmpDir("rollout-state");
  process.env.C2C_STATE_DIR = stateDir;
  vi.spyOn(buildId, "getRuntimeBuildId").mockReturnValue(targetBuildId);
  vi.spyOn(runtimeModule, "findBridgeObservation").mockImplementation(async workspaceId => {
    const context = contexts.get(workspaceId);
    if (!context) return { state: "stopped", runtime: null, reason: "runtime_missing" };
    return { state: "healthy", runtime: context.runtime };
  });
  vi.spyOn(runtimeModule, "adminFetch").mockImplementation(async runtime => {
    return contexts.get(runtime.workspaceId)?.info as never;
  });
  vi.spyOn(daemon, "restartBridge").mockImplementation(async (workspaceRoot, options) => {
    const context = [...contexts.values()].find(item => item.workspace.root === workspaceRoot);
    if (!context || !context.afterRuntime || !context.afterInfo) throw new Error("missing restart fixture");
    await options.beforeShutdown?.();
    context.runtime = context.afterRuntime;
    context.info = context.afterInfo;
    return {
      runtime: context.runtime,
      info: context.info as never,
      mcpUrl: `${context.host}/mcp`,
    };
  });
  vi.spyOn(desktopIpc, "inspect").mockResolvedValue({} as never);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const context = [...contexts.values()].find(item => `${item.host}/health` === url);
    return new Response(JSON.stringify(context ? {
      service: SERVICE_NAME,
      workspaceId: context.workspace.id,
      status: "ok",
      pid: context.runtime.pid,
      startedAt: context.runtime.startedAt,
    } : {}), { status: context ? 200 : 404, headers: { "content-type": "application/json" } });
  }));
  vi.spyOn(installModule, "readCurrentInstall").mockReturnValue({
    version: 2,
    checkoutRoot: process.cwd(),
    releaseRoot: process.cwd(),
    runtimeBuildId: targetBuildId,
    artifactSha256: "c".repeat(64),
    installedAt: "2026-09-12T00:00:00.000Z",
  } as ReturnType<typeof installModule.readCurrentInstall>);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  delete process.env.C2C_STATE_DIR;
  contexts.clear();
  while (roots.length) cleanup(roots.pop()!);
  cleanup(stateDir);
});

function addContext(name: string, build = oldBuildId): Context {
  const root = makeTmpDir(`rollout-${name}`);
  roots.push(root);
  write(root, "a.txt", "fixture");
  const workspace = new Workspace(root);
  const startedAt = "2026-09-11T00:00:00.000Z";
  const runtime: RuntimeState = {
    service: SERVICE_NAME,
    version: VERSION,
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    pid: 30001,
    port: 41001,
    adminToken: `token-${workspace.id}`,
    publicUrl: `https://${name}.example.com`,
    startedAt,
    runtimeBuildId: build,
  };
  writeRuntimeState(runtime);
  const host = `https://${name}.example.com`;
  writeTunnelState({
    workspaceId: workspace.id,
    preference: "named",
    provider: "cloudflare-named",
    tunnelName: `${name}-tunnel`,
    tunnelId: randomUUID(),
    hostname: `${name}.example.com`,
    zone: "example.com",
  });
  const info: Record<string, unknown> = {
    service: SERVICE_NAME,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspaceRoot: workspace.root,
    port: runtime.port,
    publicUrl: host,
    tunnel: { running: true, url: host, provider: "cloudflare-named" },
    tokenCount: 0,
    pairingActive: false,
    pid: runtime.pid,
    startedAt,
    runtimeBuildId: build,
  };
  const context: Context = { workspace, runtime, info, host };
  contexts.set(workspace.id, context);
  return context;
}

function makeAfter(context: Context): void {
  const startedAt = "2026-09-12T00:00:01.000Z";
  context.afterRuntime = { ...context.runtime, pid: context.runtime.pid + 1, adminToken: `${context.runtime.adminToken}-new`, startedAt, runtimeBuildId: targetBuildId };
  context.afterInfo = { ...context.info, pid: context.afterRuntime.pid, startedAt, runtimeBuildId: targetBuildId };
}

function seedDesktop(context: Context, status: "active" | "awaiting_approval" | "outcome_unknown"): void {
  const now = new Date().toISOString();
  const bindingId = randomUUID();
  updateDesktop(context.workspace.id, () => ({
    state: {
      version: 1,
      workspaceId: context.workspace.id,
      workspaceRoot: context.workspace.root,
      enabled: false,
      binding: {
        threadId,
        hostId: "local" as const,
        projectId: "rollout-project",
        bindingId,
        title: "rollout fixture",
        boundAt: now,
      },
      deliveries: status === "outcome_unknown" ? [{
        commandId: "rollout-command",
        clientId: "rollout-client",
        bindingId,
        threadId,
        messageSha256: "0".repeat(64),
        messageBytes: 1,
        deliveryStatus: "outcome_unknown" as const,
        createdAt: now,
        updatedAt: now,
      }] : [],
    },
    result: undefined,
  }));
  vi.mocked(desktopIpc.inspect).mockResolvedValue({
    threadId,
    hostId: "local",
    projectId: "rollout-project",
    workspaceRoot: context.workspace.root,
    title: "rollout fixture",
    cwd: context.workspace.root,
    runtimeStatus: status,
  } as never);
}

function seedRemoteActive(context: Context): void {
  const now = new Date().toISOString();
  updateRemote(context.workspace.id, () => ({
    state: {
      version: 1,
      workspaceId: context.workspace.id,
      workspaceRoot: context.workspace.root,
      enabled: true,
      threads: [],
      tasks: [{
        workspaceId: context.workspace.id,
        threadId: "remote-thread",
        commandId: "remote-command",
        kind: "ANALYZE" as const,
        goal: "rollout gate",
        clientId: "rollout-client",
        taskId: "remote-task",
        status: "running" as const,
        createdAt: now,
        updatedAt: now,
      }],
      audit: [],
    },
    result: undefined,
  }));
}

function seedRemoteController(context: Context, appServer: "unknown" | "offline"): void {
  const now = new Date().toISOString();
  updateRemote(context.workspace.id, () => ({
    state: {
      version: 1,
      workspaceId: context.workspace.id,
      workspaceRoot: context.workspace.root,
      enabled: true,
      threads: [],
      tasks: [],
      controller: { pid: 39001, instanceId: "rollout-controller", heartbeatAt: Date.now(), appServer },
      audit: [],
    },
    result: undefined,
  }));
}

function seedDesktopRebound(context: Context): void {
  const now = new Date().toISOString();
  const bindingId = randomUUID();
  updateDesktop(context.workspace.id, () => ({
    state: {
      version: 1,
      workspaceId: context.workspace.id,
      workspaceRoot: context.workspace.root,
      enabled: false,
      binding: {
        threadId,
        hostId: "local" as const,
        projectId: "rollout-project",
        bindingId,
        title: "rebound fixture",
        boundAt: now,
      },
      deliveries: [{
        commandId: "rebound-command",
        clientId: "rollout-client",
        bindingId: randomUUID(),
        threadId: "01a00000-0000-7000-8000-000000000002",
        turnId: randomUUID(),
        messageSha256: "1".repeat(64),
        messageBytes: 1,
        deliveryStatus: "accepted" as const,
        createdAt: now,
        updatedAt: now,
      }],
    },
    result: undefined,
  }));
  vi.mocked(desktopIpc.inspect).mockResolvedValue({
    threadId,
    hostId: "local",
    projectId: "rollout-project",
    workspaceRoot: context.workspace.root,
    title: "rebound fixture",
    cwd: context.workspace.root,
    runtimeStatus: "idle",
  } as never);
}

function seedSession(context: Context, suffix: string): void {
  const taskId = `rollout-${suffix}-task`;
  const projectUrl = "https://chatgpt.com/g/g-p-rollout/project";
  writeSession(context.workspace.id, {
    url: "https://chatgpt.com/c/rollout-chat",
    title: "rollout session",
    taskId,
    iteration: 7,
    lastState: "EXECUTED_SENT",
    savedAt: "2026-09-12T00:00:00.000Z",
    conversationMode: "project",
    projectUrl,
    connectorName: "named-connector",
    checkpoint: {
      taskId,
      iteration: 7,
      protocolState: "EXECUTED_SENT",
      waitingFor: "GPT_REVIEW",
      originalGoal: "preserve this session",
      chatUrl: "https://chatgpt.com/c/rollout-chat",
      projectUrl,
      updatedAt: "2026-09-12T00:00:00.000Z",
    },
  });
}

function resultFor(summary: Awaited<ReturnType<typeof rollout>>, id: string): Record<string, unknown> {
  return summary.workspaces.find(item => item.workspaceId === id) as unknown as Record<string, unknown>;
}

describe("core rollout", () => {
  it("current 与 stopped 不启动，named idle 才重启并完成二次 gate/postverify", async () => {
    const current = addContext("current", targetBuildId);
    const stopped = addContext("stopped");
    const upgraded = addContext("upgraded");
    const expectedRuntime = { ...upgraded.runtime };
    makeAfter(upgraded);
    vi.mocked(runtimeModule.findBridgeObservation).mockImplementation(async id => {
      if (id === stopped.workspace.id) return { state: "stopped", runtime: stopped.runtime, reason: "pid_missing" };
      return { state: "healthy", runtime: contexts.get(id)!.runtime };
    });

    const summary = await rollout();
    expect(summary.targetBuildId).toBe(targetBuildId);
    expect(resultFor(summary, current.workspace.id)).toMatchObject({ status: "current", workspaceName: current.workspace.name });
    expect(resultFor(summary, stopped.workspace.id)).toMatchObject({ status: "stopped", workspaceName: stopped.workspace.name });
    expect(resultFor(summary, upgraded.workspace.id)).toMatchObject({ status: "upgraded", workspaceName: upgraded.workspace.name });
    expect(summary.counts).toMatchObject({ current: 1, stopped: 1, upgraded: 1 });
    expect(vi.mocked(daemon.restartBridge)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(daemon.restartBridge).mock.calls[0][1]).toMatchObject({ tunnel: true, expectedRuntime });
  });

  it.each([
    ["quick", "skipped_quick", "quick"],
    ["pairing", "pending_busy", "pairing_active"],
    ["busy", "pending_busy", "busy"],
    ["approval", "pending_busy", "approval_pending"],
    ["unresolved", "pending", "desktop_unresolved"],
    ["remote", "pending", "remote_active"],
    ["unknown", "pending", "runtime_unknown"],
  ] as const)("%s gate 不重启并保留 pending", async (name, expectedStatus, expectedReason) => {
    const context = addContext(name);
    if (name === "quick") {
      writeTunnelState({ workspaceId: context.workspace.id, preference: "quick", provider: "cloudflare-quick" });
      context.info.tunnel = { running: true, url: context.host, provider: "cloudflare-quick" };
    } else if (name === "pairing") {
      context.info.pairingActive = true;
    } else if (name === "busy") {
      seedDesktop(context, "active");
    } else if (name === "approval") {
      seedDesktop(context, "awaiting_approval");
      vi.mocked(desktopIpc.inspect).mockRejectedValue(Object.assign(new Error("approval"), { code: "DESKTOP_APPROVAL_PENDING" }));
    } else if (name === "unresolved") {
      seedDesktop(context, "outcome_unknown");
    } else if (name === "remote") {
      seedRemoteActive(context);
    } else {
      vi.mocked(runtimeModule.findBridgeObservation).mockResolvedValue({ state: "unknown", runtime: context.runtime, reason: "probe_failed" });
    }

    const summary = await rollout();
    expect(resultFor(summary, context.workspace.id)).toMatchObject({ status: expectedStatus, reason: expectedReason });
    expect(vi.mocked(daemon.restartBridge)).not.toHaveBeenCalled();
  });

  it("当前 CODEX caller workspace 保守跳过且不重启", async () => {
    const context = addContext("caller");
    vi.spyOn(process, "cwd").mockReturnValue(context.workspace.root);
    vi.stubEnv("CODEX_THREAD_ID", threadId);
    const summary = await rollout();
    expect(resultFor(summary, context.workspace.id)).toMatchObject({ status: "pending_busy", reason: "busy" });
    expect(vi.mocked(daemon.restartBridge)).not.toHaveBeenCalled();
  });

  it("二次 gate 在关闭前变 busy 时失败安全并保留 pending", async () => {
    const context = addContext("second-gate");
    makeAfter(context);
    seedDesktop(context, "active");
    let inspectCount = 0;
    vi.mocked(desktopIpc.inspect).mockImplementation(async target => ({
      threadId: target.threadId,
      hostId: target.hostId,
      projectId: target.projectId,
      workspaceRoot: target.workspaceRoot,
      title: "rollout fixture",
      cwd: target.workspaceRoot,
      runtimeStatus: inspectCount++ === 0 ? "idle" : "active",
    }));
    const summary = await rollout();
    expect(resultFor(summary, context.workspace.id)).toMatchObject({ status: "pending_busy", reason: "busy" });
    expect(vi.mocked(daemon.restartBridge)).toHaveBeenCalledTimes(1);
    expect(context.runtime.runtimeBuildId).toBe(oldBuildId);
  });

  it.each(["wrong-build", "wrong-url"] as const)("postverify %s 保留 pending 且不报升级成功", async variant => {
    const context = addContext(`postverify-${variant}`);
    makeAfter(context);
    if (variant === "wrong-build") {
      context.afterRuntime!.runtimeBuildId = "c".repeat(64);
      context.afterInfo!.runtimeBuildId = "c".repeat(64);
    } else {
      context.afterInfo!.publicUrl = "https://other.example.com";
    }
    const summary = await rollout();
    expect(resultFor(summary, context.workspace.id)).toMatchObject({
      status: "pending",
      reason: variant === "wrong-build" ? "postcheck_failed" : "named_unhealthy",
    });
    expect(vi.mocked(daemon.restartBridge)).toHaveBeenCalledTimes(1);
  });

  it("admin identity 不匹配时拒绝重启", async () => {
    const context = addContext("identity-mismatch");
    context.info.workspaceRoot = `${context.workspace.root}-other`;
    const summary = await rollout();
    expect(resultFor(summary, context.workspace.id)).toMatchObject({ status: "pending", reason: "identity_mismatch" });
    expect(vi.mocked(daemon.restartBridge)).not.toHaveBeenCalled();
  });

  it("rollout 不改写 session/auth/endpoint/desktop 业务状态字节", async () => {
    const context = addContext("state-isolation");
    const other = addContext("other-workspace");
    makeAfter(context);
    seedDesktop(context, "active");
    vi.mocked(desktopIpc.inspect).mockImplementation(async target => ({
      threadId: target.threadId,
      hostId: target.hostId,
      projectId: target.projectId,
      workspaceRoot: target.workspaceRoot,
      title: "rollout fixture",
      cwd: target.workspaceRoot,
      runtimeStatus: "idle",
    }));
    seedSession(context, "selected");
    seedSession(other, "other");
    const businessFiles = [
      sessionFile(context.workspace.id), sessionFile(other.workspace.id),
      path.join(stateDir, "auth", `${context.workspace.id}.json`),
      path.join(stateDir, "auth", `${other.workspace.id}.json`),
      path.join(stateDir, "endpoints", `${context.workspace.id}.json`),
      path.join(stateDir, "endpoints", `${other.workspace.id}.json`),
      path.join(stateDir, "desktop-control", `${context.workspace.id}.json`),
    ];
    businessFiles.slice(2, 6).forEach((file, index) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `business-state-${index}`);
    });
    const files = [...businessFiles, runtimeModule.runtimeFile(other.workspace.id)];
    const before = files.map(file => fs.readFileSync(file));
    const summary = await rollout({ workspaceRoot: context.workspace.root });
    expect(resultFor(summary, context.workspace.id)).toMatchObject({ status: "upgraded" });
    expect(files.map(file => fs.readFileSync(file))).toEqual(before);
    expect(readSession(context.workspace.id)?.checkpoint?.taskId).toBe("rollout-selected-task");
    expect(readSession(other.workspace.id)?.checkpoint?.taskId).toBe("rollout-other-task");
  });

  it.each(["corrupt", "unknown-controller"] as const)("remote %s gate 安全跳过", async variant => {
    const context = addContext(`remote-${variant}`);
    if (variant === "corrupt") {
      const file = path.join(stateDir, "remote-control", `${context.workspace.id}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "not-json");
    } else {
      seedRemoteController(context, "unknown");
    }
    const summary = await rollout();
    expect(resultFor(summary, context.workspace.id)).toMatchObject({ status: "pending", reason: "remote_unknown" });
    expect(vi.mocked(daemon.restartBridge)).not.toHaveBeenCalled();
  });

  it.each(["corrupt", "inspect-unknown"] as const)("desktop %s gate 安全跳过", async variant => {
    const context = addContext(`desktop-${variant}`);
    if (variant === "corrupt") {
      const file = path.join(stateDir, "desktop-control", `${context.workspace.id}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "not-json");
    } else {
      seedDesktop(context, "active");
      vi.mocked(desktopIpc.inspect).mockResolvedValue({
        threadId,
        hostId: "local",
        projectId: "rollout-project",
        workspaceRoot: context.workspace.root,
        title: "unknown fixture",
        cwd: context.workspace.root,
        runtimeStatus: "unknown",
      } as never);
    }
    const summary = await rollout();
    expect(resultFor(summary, context.workspace.id)).toMatchObject({ status: "pending", reason: "desktop_unknown" });
    expect(vi.mocked(daemon.restartBridge)).not.toHaveBeenCalled();
  });

  it("Desktop 历史 accepted 记录发生 rebind 时拒绝升级", async () => {
    const context = addContext("desktop-rebound");
    makeAfter(context);
    seedDesktopRebound(context);
    vi.mocked(desktopIpc.inspect).mockImplementation(async target => {
      if (target.threadId !== threadId) {
        throw Object.assign(new Error("historical thread unavailable"), { code: "DESKTOP_TARGET_NOT_FOUND" });
      }
      return {
        threadId: target.threadId,
        hostId: target.hostId,
        projectId: target.projectId,
        workspaceRoot: target.workspaceRoot,
        title: "rebound fixture",
        cwd: target.workspaceRoot,
        runtimeStatus: "idle",
      };
    });
    const summary = await rollout();
    expect(resultFor(summary, context.workspace.id)).toMatchObject({ status: "pending", reason: "desktop_unknown" });
    expect(vi.mocked(daemon.restartBridge)).not.toHaveBeenCalled();
  });

  it("缺失 runtimeBuildId 的 legacy runtime 可升级", async () => {
    const context = addContext("legacy-build");
    delete context.runtime.runtimeBuildId;
    delete context.info.runtimeBuildId;
    writeRuntimeState(context.runtime);
    makeAfter(context);
    const summary = await rollout();
    expect(resultFor(summary, context.workspace.id)).toMatchObject({ status: "upgraded" });
    expect(vi.mocked(daemon.restartBridge)).toHaveBeenCalledTimes(1);
  });

  it("malformed runtimeBuildId 拒绝并标记 runtime_corrupt", async () => {
    const context = addContext("malformed-build");
    fs.writeFileSync(runtimeModule.runtimeFile(context.workspace.id), JSON.stringify({
      ...context.runtime, runtimeBuildId: "malformed",
    }));
    const summary = await rollout();
    expect(resultFor(summary, context.workspace.id)).toMatchObject({ status: "error", reason: "runtime_corrupt" });
    expect(vi.mocked(daemon.restartBridge)).not.toHaveBeenCalled();
  });

  it("runtime 消失时清理对应 pending 并报告 stopped", async () => {
    const context = addContext("stopped-pending");
    writePending(context.workspace, targetBuildId, "busy");
    fs.rmSync(runtimeModule.runtimeFile(context.workspace.id), { force: true });
    const summary = await rollout();
    expect(resultFor(summary, context.workspace.id)).toMatchObject({ status: "stopped" });
    expect(readPending(context.workspace)).toBeNull();
    expect(vi.mocked(daemon.restartBridge)).not.toHaveBeenCalled();
  });

  it("global rollout lock 存在时整次返回 rollout_busy 且不重启", async () => {
    const corruptRoot = makeTmpDir("rollout-corrupt");
    roots.push(corruptRoot);
    const corruptWorkspace = new Workspace(corruptRoot);
    fs.mkdirSync(path.join(stateDir, "runtime"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "runtime", `${corruptWorkspace.id}.json`), "not-json");

    const locked = addContext("locked");
    makeAfter(locked);
    fs.writeFileSync(path.join(stateDir, "rollout.lock"), "lock");
    const summary = await rollout();
    expect(resultFor(summary, corruptWorkspace.id)).toMatchObject({ status: "pending", reason: "rollout_busy" });
    expect(resultFor(summary, locked.workspace.id)).toMatchObject({ status: "pending", reason: "rollout_busy" });
    expect(summary.counts).toMatchObject({ pending: 2, error: 0 });
    expect(vi.mocked(daemon.restartBridge)).not.toHaveBeenCalled();
  });

  it("winner 暂停时 loser 不写 pending，winner 清理后没有 phantom pending", async () => {
    const context = addContext("concurrent");
    makeAfter(context);
    writePending(context.workspace, targetBuildId, "busy");
    const pendingBytes = fs.readFileSync(pendingFile(context.workspace.id));
    let pauseWinner!: () => void;
    const winnerPaused = new Promise<void>(resolve => { pauseWinner = resolve; });
    let resumeWinner!: () => void;
    const winnerHold = new Promise<void>(resolve => { resumeWinner = resolve; });
    vi.mocked(daemon.restartBridge).mockImplementation(async (workspaceRoot, options) => {
      const fixture = [...contexts.values()].find(item => item.workspace.root === workspaceRoot);
      if (!fixture || !fixture.afterRuntime || !fixture.afterInfo) throw new Error("missing restart fixture");
      await options.beforeShutdown?.();
      pauseWinner();
      await winnerHold;
      fixture.runtime = fixture.afterRuntime;
      fixture.info = fixture.afterInfo;
      return { runtime: fixture.runtime, info: fixture.info as never, mcpUrl: `${fixture.host}/mcp` };
    });

    const winner = rollout();
    await winnerPaused;
    const loser = await rollout();
    expect(loser.workspaces).toEqual([{ workspaceId: context.workspace.id, status: "pending", reason: "rollout_busy" }]);
    expect(fs.readFileSync(pendingFile(context.workspace.id))).toEqual(pendingBytes);

    resumeWinner();
    const winnerSummary = await winner;
    expect(resultFor(winnerSummary, context.workspace.id)).toMatchObject({ status: "upgraded" });
    expect(readPending(context.workspace)).toBeNull();
    expect(fs.existsSync(pendingFile(context.workspace.id))).toBe(false);
  });
});
