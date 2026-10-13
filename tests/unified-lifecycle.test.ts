import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as control from "../src/gateway/control.js";
import * as gatewayStartup from "../src/gateway/startup.js";
import * as runtimeStore from "../src/bridge/runtime.js";
import * as spawn from "../src/process/daemon-spawn.js";
import * as supervisorStore from "../src/supervisor/store.js";
import * as processProbe from "../src/process/process-probe.js";
import * as daemon from "../src/process/daemon.js";
import { GatewayRegistry } from "../src/gateway/registry.js";
import { restoreGatewayRunningWorkspaces } from "../src/supervisor/lifecycle.js";
import { ensureBridge, restartBridge } from "../src/process/daemon.js";
import { withExplicitSupervisorIntent } from "../src/supervisor/lifecycle.js";
import { claimStartupLease, decodeStartupLease, startLockPath } from "../src/core/startup-lease.js";
import { readMaintenanceLock, tryAcquireMaintenanceLock } from "../src/core/maintenance-lock.js";
import { writeGatewaySupervisorConfig, writeGatewaySupervisorRuntime, type GatewaySupervisorConfig, type GatewaySupervisorRuntime } from "../src/gateway/supervisor.js";
import { Workspace } from "../src/workspace/manager.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { isolateStateDir, makeTmpDir, write } from "./helpers.js";
import { cleanupStrict } from "./strict-teardown.js";

let stateDir: string, root: string;
const buildId = "a".repeat(64), origin = "https://gateway.example.test";
beforeEach(() => { stateDir = isolateStateDir(); root = makeTmpDir("unified-lifecycle"); });
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); delete process.env.C2C_STATE_DIR; await cleanupStrict(stateDir, root); });
function configure(): GatewaySupervisorConfig {
  const config = { version: 1 as const, scope: "machine" as const, unified: true,
    publicUrl: origin, port: 48765, tunnelName: "gateway", tunnelId: "tunnel_12345678",
    stableLauncher: path.join(stateDir, "bin", "c2c.js"), cloudflaredPath: path.join(stateDir, "bin", "cloudflared.exe"),
    tunnelClientPath: path.join(stateDir, "bin", "client.exe"), proxy: null, keyReference: "fixture" };
  writeGatewaySupervisorConfig(config, stateDir); return config;
}
function gatewayRuntime(config: GatewaySupervisorConfig): GatewaySupervisorRuntime {
  return { pid: 101, creationTime: "ctime:101", executable: process.execPath, buildId, ports: [config.port], children: [
    { pid: 102, creationTime: "ctime:102", executable: config.cloudflaredPath, buildId, ports: [] },
    { pid: 103, creationTime: "ctime:103", executable: config.tunnelClientPath, buildId, ports: [] } ] };
}
function publish(value: GatewaySupervisorRuntime) {
  writeGatewaySupervisorRuntime(value, stateDir);
  const { children: _children, ports: _ports, ...owner } = value;
  write(stateDir, "gateway/supervisor.lock", JSON.stringify({ version: 1, scope: "machine", ...owner, nonce: randomUUID() }));
  write(stateDir, "gateway/server.lock", JSON.stringify({ pid: value.pid, createdAt: Date.now(), ownerNonce: randomUUID() }));
}
function native(value: GatewaySupervisorRuntime) {
  return vi.fn(async (pid: number) => {
    const expected = [value, ...value.children!].find(item => item.pid === pid)!;
    return { pid, status: "identified" as const, executable: expected.executable, creationTime: expected.creationTime, inAnyJob: false,
      errors: { process: null, executable: null, creationTime: null, inAnyJob: null }, observedAt: new Date().toISOString() };
  });
}
function bridgeRuntime(): runtimeStore.RuntimeState {
  const workspace = new Workspace(root);
  return { service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id, workspaceRoot: workspace.root,
    pid: 101, port: 48222, startedAt: "2026-10-11T00:00:00.000Z", adminToken: "fixture", publicUrl: null,
    hosting: "gateway", runtimeBuildId: buildId };
}
function identity(runtime: runtimeStore.RuntimeState): control.GatewayWorkspaceIdentity {
  return { workspaceId: runtime.workspaceId, workspaceRoot: runtime.workspaceRoot, pid: runtime.pid, port: runtime.port,
    startedAt: runtime.startedAt, runtimeBuildId: runtime.runtimeBuildId ?? null };
}

describe("readonly unified Gateway control", () => {
  function fixture(overrides: Record<string, unknown> = {}) {
    const config = configure(), runtime = gatewayRuntime(config); publish(runtime);
    const probe = native(runtime);
    const http = vi.fn(async () => ({ status: 200, headers: {}, body: JSON.stringify({ service: "machine-gateway",
      pid: runtime.pid, creationTime: runtime.creationTime, buildId, port: config.port, publicUrl: origin, unified: true, ...overrides }) }));
    return { config, runtime, probe, http, options: { stateDir, probeProcess: probe, requestLoopback: http } };
  }
  it("healthy exact native parent+children and loopback owner can verify while maintenance remains held", async () => {
    const f = fixture(), acquired = tryAcquireMaintenanceLock(stateDir, "fixture");
    if (!acquired.ok) throw new Error("fixture busy");
    try {
      expect((await control.requireVerifiedGateway(f.options)).runtime).toEqual(f.runtime);
      expect(readMaintenanceLock(stateDir)?.token).toBe(acquired.handle.token);
      expect(f.probe.mock.calls.map(call => call[0])).toEqual([101, 102, 103, 101, 102, 103]);
    } finally { expect(acquired.handle.release()).toBe(true); }
  });
  it.each([101, 102, 103])("native unknown owner/child %s fails closed", async pid => {
    const f = fixture(); const original = native(f.runtime);
    f.probe.mockImplementation(async observed => ({ ...await original(observed), ...(observed === pid ? { status: "unknown" as never } : {}) }));
    await expect(control.requireVerifiedGateway(f.options)).rejects.toThrow("native");
  });
  it.each([{ unified: undefined }, { pid: 999 }, { buildId: "b".repeat(64) }, { publicUrl: "https://other.test" }])("legacy/foreign health never permits unified control %j", async override => {
    const f = fixture(override);
    await expect(control.requireVerifiedGateway(f.options)).rejects.toThrow("health");
  });
  it("control mutation is fenced against owner files changing after response", async () => {
    const f = fixture(), gateway = await control.requireVerifiedGateway(f.options);
    f.http.mockImplementation(async options => {
      if (options.path.endsWith("/start")) {
        write(stateDir, "gateway/server.lock", JSON.stringify({ pid: 101, createdAt: Date.now(), ownerNonce: randomUUID() }));
        return { status: 200, headers: {}, body: "{}" };
      }
      return { status: 200, headers: {}, body: JSON.stringify({ service: "machine-gateway", pid: 101,
        creationTime: "ctime:101", buildId, port: f.config.port, publicUrl: origin, unified: true }) };
    });
    await expect(gateway.request("POST", "/internal/gateway/workspaces/123456789abc/start", {})).rejects.toThrow("ownership");
  });
  it("exact shutdown ACK tolerates legitimate immediate owner retirement; caller still must prove exit", async () => {
    const f = fixture(), gateway = await control.requireVerifiedGateway(f.options);
    f.http.mockImplementation(async options => {
      if (options.path.endsWith("/shutdown")) {
        fs.unlinkSync(path.join(stateDir, "gateway", "server.lock"));
        return { status: 200, headers: {}, body: '{"shuttingDown":true}' };
      }
      return { status: 200, headers: {}, body: JSON.stringify({ service: "machine-gateway", pid: 101,
        creationTime: "ctime:101", buildId, port: f.config.port, publicUrl: origin, unified: true }) };
    });
    expect(await gateway.request("POST", "/internal/gateway/shutdown", {})).toEqual({ shuttingDown: true });
  });
});

describe("unified workspace lifecycle", () => {
  function fixture(active = false) {
    const config = configure(), host = gatewayRuntime(config); let runtime = bridgeRuntime();
    vi.spyOn(control, "isUnifiedWorkspace").mockReturnValue(true);
    const ensure = vi.spyOn(gatewayStartup, "ensureConfiguredGatewaySupervisor").mockImplementation(async () => {
      expect(readMaintenanceLock(stateDir)).toBeNull(); expect(fs.existsSync(startLockPath(stateDir, runtime.workspaceId))).toBe(false); return host;
    });
    let lastClosed: control.GatewayWorkspaceIdentity | null = null;
    const request = vi.fn(async (method: string, route: string, body?: unknown) => {
      if (method === "POST") {
        const lease = decodeStartupLease((body as { lease: string }).lease);
        claimStartupLease(lease, new Workspace(root));
        expect(() => claimStartupLease(lease, new Workspace(root))).toThrow("禁止重放");
        runtime = { ...runtime, startedAt: "2026-10-11T00:00:01.000Z" }; active = true;
        return { started: true, runtime: identity(runtime) };
      }
      return { hosted: active, current: active ? identity(runtime) : null, lastClosed };
    });
    const gateway = { config, runtime: host, request } as unknown as control.VerifiedGateway;
    vi.spyOn(control, "requireVerifiedGateway").mockResolvedValue(gateway);
    vi.spyOn(runtimeStore, "findBridgeObservation").mockImplementation(async () => active ? { state: "healthy", runtime } : { state: "stopped", runtime: null, reason: "runtime_missing" });
    vi.spyOn(runtimeStore, "adminFetch").mockImplementation(async (_runtime, _method, route) => {
      if (route.endsWith("shutdown")) { lastClosed = identity(runtime); active = false; return {} as never; }
      return { ...runtime, tunnel: { running: false, url: null, provider: "cloudflare-named" } } as never;
    });
    const daemon = vi.spyOn(spawn, "spawnDetachedDaemon").mockRejectedValue(new Error("unified must not spawn serve"));
    return { request, ensure, daemon, gateway, runtime: () => runtime, setClosed: (value: control.GatewayWorkspaceIdentity | null) => { lastClosed = value; } };
  }
  it("registered unified start claims exact one-shot lease and never spawns serve", async () => {
    const f = fixture(); const result = await ensureBridge(root, { port: 0, tunnel: true });
    expect(result).toEqual({ runtime: f.runtime(), spawned: true });
    expect(f.request).toHaveBeenCalledWith("POST", `/internal/gateway/workspaces/${result.runtime.workspaceId}/start`, expect.objectContaining({ lease: expect.any(String), port: 0, tunnel: true }));
    expect(f.daemon).not.toHaveBeenCalled(); expect(f.ensure).toHaveBeenCalledTimes(1);
    expect(readMaintenanceLock(stateDir)).toBeNull(); expect(fs.existsSync(startLockPath(stateDir, result.runtime.workspaceId))).toBe(false);
    expect(fs.readdirSync(path.join(stateDir, "startup-leases"))).toEqual([]);
  });
  it("inherited maintenance only validates Gateway read-only and never enters nested ensure", async () => {
    const f = fixture(), acquired = tryAcquireMaintenanceLock(stateDir, "rollout");
    if (!acquired.ok) throw new Error("fixture busy");
    try { await ensureBridge(root, { maintenance: acquired.handle }); expect(f.ensure).not.toHaveBeenCalled(); expect(readMaintenanceLock(stateDir)?.token).toBe(acquired.handle.token); }
    finally { expect(acquired.handle.release()).toBe(true); }
  });
  it("healthy hosted reuse checks current exact hosted instance", async () => {
    const f = fixture(true); expect((await ensureBridge(root)).spawned).toBe(false);
    expect(f.request).toHaveBeenCalledExactlyOnceWith("GET", `/internal/gateway/workspaces/${f.runtime().workspaceId}`);
    expect(f.daemon).not.toHaveBeenCalled();
  });
  it("healthy legacy Bridge cannot be overwritten or silently downgraded", async () => {
    const f = fixture(true), runtime = { ...f.runtime(), hosting: undefined };
    vi.mocked(runtimeStore.findBridgeObservation).mockResolvedValue({ state: "healthy", runtime });
    await expect(ensureBridge(root)).rejects.toThrow("IDENTITY_MISMATCH"); expect(f.request).not.toHaveBeenCalled(); expect(f.daemon).not.toHaveBeenCalled();
  });
  it("unknown workspace cannot start another instance", async () => {
    const f = fixture(); vi.mocked(runtimeStore.findBridgeObservation).mockResolvedValue({ state: "unknown", runtime: f.runtime(), reason: "probe_failed" });
    await expect(ensureBridge(root)).rejects.toThrow("refusing to start"); expect(f.request).not.toHaveBeenCalled(); expect(f.daemon).not.toHaveBeenCalled();
  });
  it.each([null, { port: 9999 }, { startedAt: "2026-10-11T00:01:00.000Z" }, { workspaceRoot: "other" }])("absent or foreign lastClosed is never full close proof %j", async changed => {
    const f = fixture(); f.setClosed(changed && { ...identity(f.runtime()), ...changed });
    expect(await control.isGatewayWorkspaceClosed(f.gateway, f.runtime())).toBe(false);
  });
  it("shared restart waits exact workspace close and re-registers with same Gateway PID", async () => {
    const f = fixture(true), before = f.runtime();
    const presence = vi.spyOn(processProbe, "observeProcessPresence").mockResolvedValue("present");
    const result = await restartBridge(root, { tunnel: false, expectedRuntime: before });
    expect(result.runtime.pid).toBe(before.pid); expect(result.runtime.startedAt).not.toBe(before.startedAt);
    expect(presence).not.toHaveBeenCalled(); expect(f.daemon).not.toHaveBeenCalled();
  });
  it("runtime disappearance and shutdown ACK cannot authorize re-registration without lastClosed", async () => {
    vi.useFakeTimers(); const f = fixture(true);
    vi.mocked(runtimeStore.adminFetch).mockImplementation(async (_runtime, _method, route) => {
      if (route.endsWith("shutdown")) {
        vi.mocked(runtimeStore.findBridgeObservation).mockResolvedValue({ state: "stopped", runtime: null, reason: "runtime_missing" });
        return {} as never;
      }
      return { ...f.runtime(), tunnel: { running: false, url: null, provider: "cloudflare-named" } } as never;
    });
    const pending = expect(restartBridge(root, { tunnel: false })).rejects.toThrow("尚未完成关闭");
    await vi.advanceTimersByTimeAsync(5200); await pending;
    expect(f.request.mock.calls.every(call => call[0] === "GET")).toBe(true); expect(f.daemon).not.toHaveBeenCalled();
  });
  it("explicit unified intent persists missing desiredState with registrationMode none before action", async () => {
    const f = fixture(); let value: unknown = null;
    vi.spyOn(supervisorStore, "hasSupervisorState").mockReturnValue(false);
    vi.spyOn(supervisorStore, "withSupervisorOperation").mockImplementation(async (_root, action) => action({ assertOwned() {},
      readConfig: () => null, updateConfig: patch => { value = { tunnel: false, ...patch }; return value as never; } }) as never);
    await withExplicitSupervisorIntent(root, "running", false, async () => { expect(value).toEqual({ tunnel: false, desiredState: "running", registrationMode: "none" }); });
    expect(f.ensure).toHaveBeenCalledTimes(1);
  });
});

describe("unified persisted intent recovery", () => {
  it("fresh registry restores running only and skips stopped or absent configs without creating intent", async () => {
    configure(); const registry = new GatewayRegistry(stateDir);
    const stopped = makeTmpDir("unified-stopped"), absent = makeTmpDir("unified-absent");
    try {
      for (const item of [root, stopped, absent]) registry.register(item, "fixture-client");
      const read = vi.spyOn(supervisorStore, "readSupervisorConfig").mockImplementation(item => item === root
        ? { desiredState: "running", tunnel: true } as never : item === stopped ? { desiredState: "stopped", tunnel: true } as never : null);
      vi.spyOn(supervisorStore, "hasSupervisorState").mockReturnValue(false);
      const ensure = vi.spyOn(daemon, "ensureBridgeAndTunnel").mockResolvedValue({} as never);
      const update = vi.spyOn(supervisorStore, "withSupervisorOperation");
      const acquired = tryAcquireMaintenanceLock(stateDir, "fixture-recover");
      if (!acquired.ok) throw new Error("fixture busy");
      try {
        await restoreGatewayRunningWorkspaces(acquired.handle, stateDir);
        expect(ensure).toHaveBeenCalledExactlyOnceWith(root, { maintenance: acquired.handle, tunnel: true });
        expect(read).toHaveBeenCalledTimes(3); expect(update).not.toHaveBeenCalled();
        expect(readMaintenanceLock(stateDir)?.token).toBe(acquired.handle.token);
      } finally { expect(acquired.handle.release()).toBe(true); }
    } finally { await cleanupStrict(stopped, absent); }
  });
  it("malformed desiredState prevents starts before recovery mutates any workspace", async () => {
    configure(); new GatewayRegistry(stateDir).register(root, "fixture-client");
    vi.spyOn(supervisorStore, "readSupervisorConfig").mockImplementation(() => { throw new Error("SUPERVISOR_STORE_CORRUPT"); });
    const ensure = vi.spyOn(daemon, "ensureBridgeAndTunnel").mockResolvedValue({} as never);
    const acquired = tryAcquireMaintenanceLock(stateDir, "fixture-recover");
    if (!acquired.ok) throw new Error("fixture busy");
    try { await expect(restoreGatewayRunningWorkspaces(acquired.handle, stateDir)).rejects.toThrow("CORRUPT"); expect(ensure).not.toHaveBeenCalled(); }
    finally { expect(acquired.handle.release()).toBe(true); }
  });
  it("legacy configuration never enumerates registered roots or restores contexts", async () => {
    const list = vi.spyOn(GatewayRegistry.prototype, "list");
    const acquired = tryAcquireMaintenanceLock(stateDir, "fixture-recover");
    if (!acquired.ok) throw new Error("fixture busy");
    try { await restoreGatewayRunningWorkspaces(acquired.handle, stateDir); expect(list).not.toHaveBeenCalled(); }
    finally { expect(acquired.handle.release()).toBe(true); }
  });
});
