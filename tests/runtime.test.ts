import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { startBridge } from "../src/bridge/server.js";
import {
  clearRuntimeState,
  findBridgeObservation,
  findLiveBridge,
  readRuntimeState,
  runtimeFile,
  writeRuntimeState,
  type RuntimeState,
} from "../src/bridge/runtime.js";
import { adminFetch, buildServeArgs, ensureBridge, restartBridge, stopBridge } from "../src/process/daemon.js";
import { sessionFile, writeSession } from "../src/session/state.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

function stubRuntime(workspaceId: string, workspaceRoot: string, pid: number, port: number): RuntimeState {
  return {
    service: SERVICE_NAME,
    version: VERSION,
    workspaceId,
    workspaceRoot,
    pid,
    port,
    adminToken: "test-token",
    publicUrl: null,
    startedAt: new Date().toISOString(),
  };
}

function healthPayload(
  workspaceId: string,
  opts: { pid?: number; startedAt?: string; legacy?: boolean } = {}
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    service: SERVICE_NAME,
    version: VERSION,
    workspaceId,
    status: "ok",
  };
  if (!opts.legacy) {
    payload.pid = opts.pid ?? process.pid;
    payload.startedAt = opts.startedAt ?? "2026-09-12T00:00:00.000Z";
  }
  return payload;
}

function adminInfoPayload(
  workspaceId: string,
  workspaceRoot: string,
  opts: { pid: number; port: number; startedAt: string }
): Record<string, unknown> {
  return {
    service: SERVICE_NAME,
    version: VERSION,
    workspaceId,
    workspaceName: "Test workspace",
    workspaceRoot,
    port: opts.port,
    publicUrl: null,
    tunnel: { running: false, url: null, provider: "cloudflare-quick" },
    tokenCount: 0,
    pairingActive: false,
    pid: opts.pid,
    startedAt: opts.startedAt,
  };
}

interface HealthServer {
  port: number;
  requests: Array<{ path: string; authorization: string | undefined }>;
  close(): Promise<void>;
}

async function startHealthServer(
  health: Record<string, unknown>,
  shutdownStatus = 200,
  info: Record<string, unknown> | null = null,
  expectedAdminToken = "test-token",
  shutdownHandler?: () => void | Promise<void>
): Promise<HealthServer> {
  const requests: HealthServer["requests"] = [];
  const server: Server = createServer((req, res) => {
    if (req.url === "/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(health));
      return;
    }
    requests.push({ path: req.url ?? "", authorization: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${expectedAdminToken}`) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message: "unauthorized" }));
      return;
    }
    if (req.url === "/admin/info") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(info ?? {}));
      return;
    }
    if (req.url === "/admin/shutdown") {
      res.statusCode = shutdownStatus;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(shutdownStatus === 200 ? { shuttingDown: true } : { message: "denied" }), () => {
        if (shutdownStatus === 200 && shutdownHandler) void shutdownHandler();
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("health server did not expose a TCP port");
  }
  return {
    port: address.port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function waitForRuntimeClear(workspaceId: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (!fs.existsSync(runtimeFile(workspaceId))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function runCliRestart(workspaceRoot: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const cliPath = path.resolve(process.cwd(), "src", "cli", "index.ts");
  const child = spawn(
    process.execPath,
    ["--import", "tsx/esm", cliPath, "restart", "--workspace", workspaceRoot],
    { cwd: process.cwd(), env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`CLI restart timed out\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 25_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("findBridgeObservation", () => {
  const dirs: string[] = [];

  it("serve 参数保留显式 port=0", () => {
    const workspaceRoot = path.resolve("port-zero-workspace");
    expect(buildServeArgs(["--import", "tsx/esm"], workspaceRoot, 0)).toEqual([
      "--import", "tsx/esm", "serve", "--workspace", workspaceRoot, "--port", "0",
    ]);
    expect(buildServeArgs(["node"], workspaceRoot)).not.toContain("--port");
  });

  it("旧实例清理不能删除已替换的 runtime", () => {
    dirs.push(isolateStateDir());
    const old = stubRuntime("cleanup-owner", "unused", process.pid, 1);
    const current = { ...old, adminToken: "replacement-token" };
    writeRuntimeState(current);
    clearRuntimeState(old.workspaceId, old);
    expect(readRuntimeState(old.workspaceId)).toEqual(current);
    clearRuntimeState(current.workspaceId, current);
    expect(readRuntimeState(current.workspaceId)).toBeNull();
  });

  it("Bridge close 不会清除已经替换的 runtime", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("clear-replaced-runtime");
    const authDir = makeTmpDir("clear-replaced-auth");
    dirs.push(root, authDir);
    write(root, "a.txt", "a");
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: true,
      authStoreFile: path.join(authDir, "store.json"),
    });
    let closed = false;
    try {
      const old = readRuntimeState(bridge.workspace.id);
      if (!old) throw new Error("bridge runtime was not persisted");
      const replacement = {
        ...old,
        pid: old.pid + 1,
        startedAt: "2026-09-12T00:00:00.000Z",
        adminToken: "replacement-token",
      };
      writeRuntimeState(replacement);
      await bridge.close();
      closed = true;
      expect(readRuntimeState(bridge.workspace.id)).toEqual(replacement);
    } finally {
      if (!closed) await bridge.close();
    }
  });

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("treats a missing runtime file as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-missing");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const observation = await findBridgeObservation(workspace.id);
    expect(observation.state).toBe("stopped");
    if (observation.state === "stopped") expect(observation.reason).toBe("runtime_missing");
    expect(await findLiveBridge(workspace.id)).toBeNull();
  });

  it("treats a dead pid plus a failed probe as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-dead");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    writeRuntimeState(stubRuntime(workspace.id, workspace.root, 999_999_999, 1));
    const observation = await findBridgeObservation(workspace.id);
    expect(observation.state).toBe("stopped");
    if (observation.state === "stopped") expect(observation.reason).toBe("pid_missing");
    expect(await findLiveBridge(workspace.id)).toBeNull();
  });

  it("does not treat a live pid plus a failed probe as stopped", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-unknown");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    child.unref();
    try {
      if (!child.pid) throw new Error("failed to spawn helper");
      writeRuntimeState(stubRuntime(workspace.id, workspace.root, child.pid, 1));
      const observation = await findBridgeObservation(workspace.id);
      expect(observation.state).toBe("unknown");
      if (observation.state === "unknown") expect(observation.reason).toBe("probe_failed");
      expect(await findLiveBridge(workspace.id)).toBeNull();
      await expect(ensureBridge(root)).rejects.toThrow(/uncertain/);
    } finally {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
  });

  it("只在 health 的 pid、startedAt、workspace 都匹配时返回 healthy", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-identity-healthy");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const startedAt = "2026-09-12T00:00:00.000Z";
    const health = await startHealthServer(healthPayload(workspace.id, { startedAt }));
    try {
      writeRuntimeState({ ...stubRuntime(workspace.id, workspace.root, process.pid, health.port), startedAt });
      const observation = await findBridgeObservation(workspace.id);
      expect(observation.state).toBe("healthy");
    } finally {
      await health.close();
    }
  });

  it("新版 health 身份完整但 pid 检测 unknown 时通过 admin token 认证", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-authenticated-fallback");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const startedAt = "2026-09-12T00:00:00.000Z";
    const info = adminInfoPayload(workspace.id, workspace.root, {
      pid: process.pid,
      port: 0,
      startedAt,
    });
    const health = await startHealthServer(
      healthPayload(workspace.id, { pid: process.pid, startedAt }),
      200,
      info,
    );
    info.port = health.port;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      throw new Error(`unexpected signal ${String(signal)} for ${pid}`);
    }) as typeof process.kill);
    try {
      const runtime = { ...stubRuntime(workspace.id, workspace.root, process.pid, health.port), startedAt };
      writeRuntimeState(runtime);
      await expect(findBridgeObservation(workspace.id)).resolves.toMatchObject({ state: "healthy", runtime });
      expect(health.requests).toContainEqual({ path: "/admin/info", authorization: "Bearer test-token" });
      expect(killSpy.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    } finally {
      killSpy.mockRestore();
      await health.close();
    }
  });

  it("authenticated fallback 的 admin 身份不匹配时 restart 拒绝且不 shutdown", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-authenticated-mismatch");
    const otherRoot = makeTmpDir("obs-authenticated-mismatch-other");
    dirs.push(root, otherRoot);
    write(root, "a.txt", "a");
    write(otherRoot, "a.txt", "a");
    const workspace = new Workspace(root);
    const other = new Workspace(otherRoot);
    const startedAt = "2026-09-12T00:00:00.000Z";
    const info = adminInfoPayload(workspace.id, workspace.root, {
      pid: process.pid,
      port: 0,
      startedAt,
    });
    info.workspaceId = other.id;
    info.workspaceRoot = other.root;
    const health = await startHealthServer(
      healthPayload(workspace.id, { pid: process.pid, startedAt }),
      200,
      info,
    );
    info.port = health.port;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      throw new Error(`unexpected signal ${String(signal)} for ${pid}`);
    }) as typeof process.kill);
    try {
      writeRuntimeState({ ...stubRuntime(workspace.id, workspace.root, process.pid, health.port), startedAt });
      await expect(restartBridge(root, { tunnel: false })).rejects.toThrow("身份无法确认");
      expect(health.requests.some(request => request.path === "/admin/shutdown")).toBe(false);
      expect(killSpy.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    } finally {
      killSpy.mockRestore();
      await health.close();
    }
  });

  it("authenticated fallback 可通过 restart 的预关闭 gate，gate 失败时不重启", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("restart-authenticated-fallback");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const startedAt = "2026-09-12T00:00:00.000Z";
    const info = adminInfoPayload(workspace.id, workspace.root, {
      pid: process.pid,
      port: 0,
      startedAt,
    });
    const health = await startHealthServer(
      healthPayload(workspace.id, { pid: process.pid, startedAt }),
      200,
      info,
    );
    info.port = health.port;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0) throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      throw new Error(`unexpected signal ${String(signal)} for ${pid}`);
    }) as typeof process.kill);
    try {
      const runtime = { ...stubRuntime(workspace.id, workspace.root, process.pid, health.port), startedAt };
      writeRuntimeState(runtime);
      let gateCalled = false;
      await expect(restartBridge(root, {
        tunnel: false,
        expectedRuntime: runtime,
        beforeShutdown: async () => {
          gateCalled = true;
          throw new Error("test gate");
        },
      })).rejects.toThrow("test gate");
      expect(gateCalled).toBe(true);
      expect(health.requests.some(request => request.path === "/admin/shutdown")).toBe(false);
      expect(killSpy.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    } finally {
      killSpy.mockRestore();
      await health.close();
    }
  });

  it("同 pid 但 startedAt 更新时识别为 stale_runtime", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-pid-reuse");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const savedStartedAt = "2026-09-11T00:00:00.000Z";
    const health = await startHealthServer(
      healthPayload(workspace.id, { pid: process.pid, startedAt: "2026-09-12T00:00:00.000Z" })
    );
    try {
      writeRuntimeState({
        ...stubRuntime(workspace.id, workspace.root, process.pid, health.port),
        startedAt: savedStartedAt,
      });
      const observation = await findBridgeObservation(workspace.id);
      expect(observation.state).toBe("stopped");
      if (observation.state === "stopped") expect(observation.reason).toBe("stale_runtime");
    } finally {
      await health.close();
    }
  });

  it("保存 pid 仍存活但 health 报告其他 pid 时保持 unknown", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-live-pid-mismatch");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const startedAt = "2026-09-12T00:00:00.000Z";
    const health = await startHealthServer(
      healthPayload(workspace.id, { pid: process.pid + 1, startedAt })
    );
    try {
      writeRuntimeState({ ...stubRuntime(workspace.id, workspace.root, process.pid, health.port), startedAt });
      const observation = await findBridgeObservation(workspace.id);
      expect(observation.state).toBe("unknown");
    } finally {
      await health.close();
    }
  });

  it("同 pid 同 startedAt 但 workspace 不一致时保持 unknown", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-workspace-mismatch");
    const otherRoot = makeTmpDir("obs-workspace-other");
    dirs.push(root, otherRoot);
    write(root, "a.txt", "a");
    write(otherRoot, "a.txt", "a");
    const workspace = new Workspace(root);
    const other = new Workspace(otherRoot);
    const startedAt = "2026-09-12T00:00:00.000Z";
    const health = await startHealthServer(
      healthPayload(other.id, { pid: process.pid, startedAt })
    );
    try {
      writeRuntimeState({ ...stubRuntime(workspace.id, workspace.root, process.pid, health.port), startedAt });
      const observation = await findBridgeObservation(workspace.id);
      expect(observation.state).toBe("unknown");
    } finally {
      await health.close();
    }
  });

  it.each([
    {
      label: "status 非 ok",
      health: (workspaceId: string, startedAt: string) => ({
        ...healthPayload(workspaceId, { startedAt }),
        status: "starting",
      }),
    },
    {
      label: "workspaceId 缺失",
      health: (_workspaceId: string, startedAt: string) => ({
        service: SERVICE_NAME,
        version: VERSION,
        status: "ok",
        pid: process.pid,
        startedAt,
      }),
    },
  ])("$label 的 health 身份校验返回 unknown", async ({ health: makeHealth }) => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-invalid-health");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const startedAt = "2026-09-12T00:00:00.000Z";
    const health = await startHealthServer(makeHealth(workspace.id, startedAt));
    try {
      writeRuntimeState({ ...stubRuntime(workspace.id, workspace.root, process.pid, health.port), startedAt });
      const observation = await findBridgeObservation(workspace.id);
      expect(observation.state).toBe("unknown");
      if (observation.state === "unknown") expect(observation.reason).toBe("identity_mismatch");
    } finally {
      await health.close();
    }
  });

  it("旧 health 缺少身份字段时仅允许 dead pid 恢复", async () => {
    dirs.push(isolateStateDir());
    const deadRoot = makeTmpDir("obs-legacy-dead");
    const liveRoot = makeTmpDir("obs-legacy-live");
    dirs.push(deadRoot, liveRoot);
    write(deadRoot, "a.txt", "a");
    write(liveRoot, "a.txt", "a");
    const deadWorkspace = new Workspace(deadRoot);
    const liveWorkspace = new Workspace(liveRoot);
    const deadHealth = await startHealthServer(healthPayload(deadWorkspace.id, { legacy: true }));
    const liveHealth = await startHealthServer(healthPayload(liveWorkspace.id, { legacy: true }));
    try {
      writeRuntimeState(stubRuntime(deadWorkspace.id, deadWorkspace.root, 999_999_999, deadHealth.port));
      const deadObservation = await findBridgeObservation(deadWorkspace.id);
      expect(deadObservation.state).toBe("stopped");
      if (deadObservation.state === "stopped") expect(deadObservation.reason).toBe("stale_runtime");

      writeRuntimeState(stubRuntime(liveWorkspace.id, liveWorkspace.root, process.pid, liveHealth.port));
      const liveObservation = await findBridgeObservation(liveWorkspace.id);
      expect(liveObservation.state).toBe("unknown");
    } finally {
      await deadHealth.close();
      await liveHealth.close();
    }
  });

  it("legacy health 身份完整时通过 admin info 认证为 healthy，并可安全 stop", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("legacy-admin-consistent");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const startedAt = "2026-09-12T00:00:00.000Z";
    const info = adminInfoPayload(workspace.id, workspace.root, {
      pid: process.pid,
      port: 0,
      startedAt,
    });
    const health = await startHealthServer(healthPayload(workspace.id, { legacy: true }), 200, info);
    info.port = health.port;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal !== 0 && signal !== undefined) throw new Error(`blocked test kill ${pid}`);
      return true;
    }) as typeof process.kill);
    try {
      writeRuntimeState({
        ...stubRuntime(workspace.id, workspace.root, process.pid, health.port),
        startedAt,
      });
      const observation = await findBridgeObservation(workspace.id);
      expect(observation.state).toBe("healthy");
      await expect(stopBridge(root)).resolves.toBe(true);
      expect(health.requests).toContainEqual({
        path: "/admin/info",
        authorization: "Bearer test-token",
      });
      expect(health.requests).toContainEqual({
        path: "/admin/shutdown",
        authorization: "Bearer test-token",
      });
      expect(killSpy.mock.calls.some(([, signal]) => signal === "SIGTERM")).toBe(false);
    } finally {
      killSpy.mockRestore();
      await health.close();
    }
  });

  it.each([
    "错误 admin token",
    "admin info 缺 startedAt",
    "admin info pid 不一致",
    "admin info 为其他 workspace",
    "health 后端口竞态切换到其他 workspace",
  ])("legacy 身份不完整或不一致（%s）时拒绝 stop 且不 kill", async (caseName) => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("legacy-admin-invalid");
    const otherRoot = makeTmpDir("legacy-admin-other");
    dirs.push(root, otherRoot);
    write(root, "a.txt", "a");
    write(otherRoot, "a.txt", "a");
    const workspace = new Workspace(root);
    const other = new Workspace(otherRoot);
    const startedAt = "2026-09-12T00:00:00.000Z";
    const info = adminInfoPayload(workspace.id, workspace.root, {
      pid: process.pid,
      port: 0,
      startedAt,
    });
    let runtimeAdminToken = "test-token";
    if (caseName === "错误 admin token") runtimeAdminToken = "wrong-token";
    if (caseName === "admin info 缺 startedAt") delete info.startedAt;
    if (caseName === "admin info pid 不一致") info.pid = process.pid + 1;
    if (
      caseName === "admin info 为其他 workspace" ||
      caseName === "health 后端口竞态切换到其他 workspace"
    ) {
      info.workspaceId = other.id;
      info.workspaceRoot = other.root;
    }
    const health = await startHealthServer(healthPayload(workspace.id, { legacy: true }), 200, info);
    info.port = health.port;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal !== 0 && signal !== undefined) throw new Error(`blocked test kill ${pid}`);
      return true;
    }) as typeof process.kill);
    try {
      writeRuntimeState({
        ...stubRuntime(workspace.id, workspace.root, process.pid, health.port),
        adminToken: runtimeAdminToken,
        startedAt,
      });
      const observation = await findBridgeObservation(workspace.id);
      expect(observation.state).toBe("unknown");
      await expect(stopBridge(root)).resolves.toBe(false);
      expect(health.requests.some((request) => request.path === "/admin/shutdown")).toBe(false);
      expect(killSpy.mock.calls.some(([, signal]) => signal === "SIGTERM")).toBe(false);
    } finally {
      killSpy.mockRestore();
      await health.close();
    }
  });

  it("stale workspace runtime 不会影响真实另一 workspace Bridge", async () => {
    dirs.push(isolateStateDir());
    const staleRoot = makeTmpDir("obs-stale-real");
    const liveRoot = makeTmpDir("obs-live-real");
    const authDir = makeTmpDir("obs-real-auth");
    dirs.push(staleRoot, liveRoot, authDir);
    write(staleRoot, "a.txt", "a");
    write(liveRoot, "a.txt", "a");
    const staleWorkspace = new Workspace(staleRoot);
    const liveBridge = await startBridge({
      workspaceRoot: liveRoot,
      port: 0,
      persistRuntime: true,
      authStoreFile: path.join(authDir, "live.json"),
    });
    const peerRuntimeFile = runtimeFile(liveBridge.workspace.id);
    const beforePeerRuntime = fs.readFileSync(peerRuntimeFile);
    let staleBridgeAttempted = false;
    try {
      writeRuntimeState(stubRuntime(staleWorkspace.id, staleWorkspace.root, 999_999_999, liveBridge.port));
      const staleObservation = await findBridgeObservation(staleWorkspace.id);
      expect(staleObservation.state).toBe("stopped");
      if (staleObservation.state === "stopped") expect(staleObservation.reason).toBe("stale_runtime");

      staleBridgeAttempted = true;
      const ensured = await ensureBridge(staleRoot, { port: liveBridge.port });
      expect(ensured.spawned).toBe(true);
      expect(ensured.runtime.workspaceId).toBe(staleWorkspace.id);

      const liveObservation = await findBridgeObservation(liveBridge.workspace.id);
      expect(liveObservation.state).toBe("healthy");
      expect(fs.readFileSync(peerRuntimeFile)).toEqual(beforePeerRuntime);
    } finally {
      if (staleBridgeAttempted) {
        const stopped = await stopBridge(staleRoot);
        if (stopped) await waitForRuntimeClear(staleWorkspace.id);
      }
      await liveBridge.close();
    }
  });

  it("ensureBridge 会替换 stale 当前 workspace 并保留 session checkpoint bytes", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("ensure-stale");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    writeRuntimeState(stubRuntime(workspace.id, workspace.root, 999_999_999, 1));
    writeSession(workspace.id, {
      url: "https://chatgpt.com/c/keep",
      projectUrl: "https://chatgpt.com/g/g-p-keep/project",
      connectorName: "Keep connector",
      taskId: "task-keep",
      iteration: 4,
      savedAt: "2026-09-12T00:00:00.000Z",
      checkpoint: {
        taskId: "task-keep",
        iteration: 4,
        protocolState: "EXECUTED_SENT",
        waitingFor: "GPT_REVIEW",
        projectUrl: "https://chatgpt.com/g/g-p-keep/project",
        chatUrl: "https://chatgpt.com/c/keep",
        updatedAt: "2026-09-12T00:00:00.000Z",
      },
    });
    const sessionPath = sessionFile(workspace.id);
    const beforeSession = fs.readFileSync(sessionPath);
    try {
      const ensured = await ensureBridge(root, { port: 0 });
      expect(ensured.spawned).toBe(true);
      expect(ensured.runtime.workspaceId).toBe(workspace.id);
      expect((await findBridgeObservation(workspace.id)).state).toBe("healthy");
      expect(fs.readFileSync(sessionPath)).toEqual(beforeSession);
    } finally {
      const stopped = await stopBridge(root);
      if (stopped) await waitForRuntimeClear(workspace.id);
    }
  });

  it("legacy stop 后真实 CLI restart 可 ensure 新 contract，并保留 Project/session/checkpoint bytes", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("legacy-stop-ensure");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const startedAt = "2026-09-12T00:00:00.000Z";
    const legacyRuntime = {
      ...stubRuntime(workspace.id, workspace.root, process.pid, 0),
      startedAt,
    };
    const info = adminInfoPayload(workspace.id, workspace.root, {
      pid: process.pid,
      port: 0,
      startedAt,
    });
    let legacyClosed = false;
    let health!: HealthServer;
    const shutdownHandler = async (): Promise<void> => {
      legacyClosed = true;
      clearRuntimeState(workspace.id, legacyRuntime);
      await health.close();
    };
    health = await startHealthServer(
      healthPayload(workspace.id, { legacy: true }),
      200,
      info,
      "test-token",
      shutdownHandler
    );
    info.port = health.port;
    writeRuntimeState({ ...legacyRuntime, port: health.port });
    writeSession(workspace.id, {
      url: "https://chatgpt.com/c/legacy",
      projectUrl: "https://chatgpt.com/g/g-p-legacy/project",
      connectorName: "Legacy connector",
      taskId: "task-legacy",
      iteration: 8,
      savedAt: "2026-09-12T00:00:00.000Z",
      checkpoint: {
        taskId: "task-legacy",
        iteration: 8,
        protocolState: "EXECUTED_SENT",
        waitingFor: "GPT_REVIEW",
        projectUrl: "https://chatgpt.com/g/g-p-legacy/project",
        chatUrl: "https://chatgpt.com/c/legacy",
        updatedAt: "2026-09-12T00:00:00.000Z",
      },
    });
    const sessionPath = sessionFile(workspace.id);
    const beforeSession = fs.readFileSync(sessionPath);
    try {
      const restart = await runCliRestart(root);
      expect(restart.code, JSON.stringify(restart)).toBe(0);
      expect(restart.stdout).toMatch(/Bridge/);
      expect(health.requests).toContainEqual({
        path: "/admin/info",
        authorization: "Bearer test-token",
      });
      expect(health.requests).toContainEqual({
        path: "/admin/shutdown",
        authorization: "Bearer test-token",
      });
      const upgraded = await findBridgeObservation(workspace.id);
      expect(upgraded.state).toBe("healthy");
      if (upgraded.state !== "healthy") throw new Error("升级后 runtime 未就绪");
      expect(upgraded.runtime.adminToken).not.toBe(legacyRuntime.adminToken);
      const upgradedInfo = await adminFetch<{ connectorContractVersion: number }>(upgraded.runtime, "GET", "/admin/info");
      expect(upgradedInfo.connectorContractVersion).toBe(1);
      expect(fs.readFileSync(sessionPath)).toEqual(beforeSession);
    } finally {
      if (!legacyClosed) {
        clearRuntimeState(workspace.id, legacyRuntime);
        await health.close();
      }
      const stopped = await stopBridge(root);
      if (stopped) await waitForRuntimeClear(workspace.id);
    }
  });

  it("reports healthy when the local bridge answers", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("obs-live");
    dirs.push(root);
    write(root, "a.txt", "a");
    const auth = path.join(makeTmpDir("obs-auth"), "store.json");
    dirs.push(path.dirname(auth));
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: true,
      authStoreFile: auth,
    });
    try {
      const observation = await findBridgeObservation(bridge.workspace.id);
      expect(observation.state).toBe("healthy");
      const health = await (await fetch(`${bridge.localBaseUrl()}/health`)).json() as Record<string, unknown>;
      expect(health.pid).toBe(process.pid);
      expect(health.startedAt).toBe(observation.runtime.startedAt);
      expect(health).not.toHaveProperty("adminToken");
      expect(await findLiveBridge(bridge.workspace.id)).not.toBeNull();
    } finally {
      await bridge.close();
    }
  });

  it("只对 healthy observation 使用 admin shutdown，不调用 SIGTERM", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("stop-healthy");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const startedAt = "2026-09-12T00:00:00.000Z";
    const health = await startHealthServer(healthPayload(workspace.id, { startedAt }));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal !== 0 && signal !== undefined) throw new Error(`blocked test kill ${pid}`);
      return true;
    }) as typeof process.kill);
    try {
      writeRuntimeState({
        ...stubRuntime(workspace.id, workspace.root, process.pid, health.port),
        startedAt,
      });
      await expect(stopBridge(root)).resolves.toBe(true);
      expect(health.requests).toContainEqual({
        path: "/admin/shutdown",
        authorization: "Bearer test-token",
      });
      expect(killSpy.mock.calls.some(([, signal]) => signal === "SIGTERM")).toBe(false);
    } finally {
      killSpy.mockRestore();
      await health.close();
    }
  });

  it("rollout restart 的预关闭 gate 与 pinned runtime 阻止竞态 shutdown", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("restart-pinned");
    dirs.push(root);
    const workspace = new Workspace(root);
    const startedAt = "2026-09-12T00:00:00.000Z";
    const health = await startHealthServer(healthPayload(workspace.id, { startedAt }));
    const runtime = { ...stubRuntime(workspace.id, workspace.root, process.pid, health.port), startedAt };
    writeRuntimeState(runtime);
    try {
      await expect(restartBridge(root, {
        tunnel: false, expectedRuntime: runtime,
        beforeShutdown: async () => { throw new Error("DESKTOP_BUSY"); },
      })).rejects.toThrow("DESKTOP_BUSY");
      await expect(restartBridge(root, {
        tunnel: false, expectedRuntime: { ...runtime, adminToken: "obsolete" },
      })).rejects.toThrow("被替换或停止");
      await expect(stopBridge(root, { ...runtime, port: runtime.port + 1 })).resolves.toBe(false);
      expect(health.requests.some(request => request.path === "/admin/shutdown")).toBe(false);
      expect((await findBridgeObservation(workspace.id)).state).toBe("healthy");
    } finally {
      await health.close();
    }
  });

  it("并发 ensure 由同 workspace start lock 拦截，不能覆盖 runtime 留下第二个进程", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("ensure-start-lock");
    dirs.push(root);
    const workspace = new Workspace(root);
    try {
      const results = await Promise.allSettled([ensureBridge(root, { port: 0 }), ensureBridge(root, { port: 0 })]);
      expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
      const refused = results.find(item => item.status === "rejected") as PromiseRejectedResult;
      expect(refused.reason.message).toContain("start lock");
      expect((await findBridgeObservation(workspace.id)).state).toBe("healthy");
      expect(fs.existsSync(path.join(path.dirname(runtimeFile(workspace.id)), `${workspace.id}.start.lock`))).toBe(false);
    } finally {
      if (await stopBridge(root)) await waitForRuntimeClear(workspace.id);
    }
  });

  it("admin shutdown 失败时不回退 kill 未认证的 runtime", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("stop-admin-failed");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const startedAt = "2026-09-12T00:00:00.000Z";
    const health = await startHealthServer(healthPayload(workspace.id, { startedAt }), 401);
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal !== 0 && signal !== undefined) throw new Error(`blocked test kill ${pid}`);
      return true;
    }) as typeof process.kill);
    try {
      writeRuntimeState({
        ...stubRuntime(workspace.id, workspace.root, process.pid, health.port),
        startedAt,
      });
      await expect(stopBridge(root)).resolves.toBe(false);
      expect(killSpy.mock.calls.some(([, signal]) => signal === "SIGTERM")).toBe(false);
    } finally {
      killSpy.mockRestore();
      await health.close();
    }
  });

  it("health 身份不可信时不发送 admin shutdown 也不 kill", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("stop-untrusted");
    const otherRoot = makeTmpDir("stop-untrusted-other");
    dirs.push(root, otherRoot);
    write(root, "a.txt", "a");
    write(otherRoot, "a.txt", "a");
    const workspace = new Workspace(root);
    const other = new Workspace(otherRoot);
    const startedAt = "2026-09-12T00:00:00.000Z";
    const health = await startHealthServer(healthPayload(other.id, { startedAt }));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal !== 0 && signal !== undefined) throw new Error(`blocked test kill ${pid}`);
      return true;
    }) as typeof process.kill);
    try {
      writeRuntimeState({
        ...stubRuntime(workspace.id, workspace.root, process.pid, health.port),
        startedAt,
      });
      await expect(stopBridge(root)).resolves.toBe(false);
      expect(health.requests.some((request) => request.path === "/admin/shutdown")).toBe(false);
      expect(killSpy.mock.calls.some(([, signal]) => signal === "SIGTERM")).toBe(false);
    } finally {
      killSpy.mockRestore();
      await health.close();
    }
  });

  it("旧 health 的 live PID 保持 unknown，既不 admin shutdown 也不 kill", async () => {
    dirs.push(isolateStateDir());
    const root = makeTmpDir("stop-legacy-health");
    dirs.push(root);
    write(root, "a.txt", "a");
    const workspace = new Workspace(root);
    const health = await startHealthServer(healthPayload(workspace.id, { legacy: true }));
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (signal !== 0 && signal !== undefined) throw new Error(`blocked test kill ${pid}`);
      return true;
    }) as typeof process.kill);
    try {
      writeRuntimeState(stubRuntime(workspace.id, workspace.root, process.pid, health.port));
      await expect(stopBridge(root)).resolves.toBe(false);
      expect(health.requests.some((request) => request.path === "/admin/shutdown")).toBe(false);
      expect(killSpy.mock.calls.some(([, signal]) => signal === "SIGTERM")).toBe(false);
    } finally {
      killSpy.mockRestore();
      await health.close();
    }
  });
});
