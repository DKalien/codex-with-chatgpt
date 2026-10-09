import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBridge, stopBridge } from "../src/process/daemon.js";
import * as bridgeRuntime from "../src/bridge/runtime.js";
import * as gatewayStartup from "../src/gateway/startup.js";
import { GatewaySupervisorError } from "../src/gateway/supervisor.js";
import { readMaintenanceLock, tryAcquireMaintenanceLock } from "../src/core/maintenance-lock.js";
import { startLockPath } from "../src/core/startup-lease.js";
import { withExplicitSupervisorIntent } from "../src/supervisor/lifecycle.js";
import { Workspace } from "../src/workspace/manager.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { isolateStateDir, makeTmpDir, write } from "./helpers.js";
import { cleanupStrict } from "./strict-teardown.js";

let stateDir: string;
let root: string;
let runtime: bridgeRuntime.RuntimeState;

beforeEach(() => {
  stateDir = isolateStateDir();
  root = makeTmpDir("bridge-gateway");
  const workspace = new Workspace(root);
  runtime = { service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id,
    workspaceRoot: workspace.root, pid: process.pid, port: 48111, adminToken: "fixture-token",
    publicUrl: null, startedAt: new Date().toISOString() };
  vi.spyOn(bridgeRuntime, "findBridgeObservation").mockResolvedValue({ state: "healthy", runtime });
  vi.spyOn(gatewayStartup, "ensureConfiguredGatewaySupervisor").mockResolvedValue(null);
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.C2C_STATE_DIR;
  await cleanupStrict(stateDir, root);
});

function start(kind: "standalone" | "explicit") {
  return kind === "standalone" ? ensureBridge(root) :
    withExplicitSupervisorIntent(root, "running", false,
      (_tunnel, maintenance) => ensureBridge(root, { maintenance }), stateDir);
}

describe("Bridge and configured machine Gateway startup", () => {
  it.each(["standalone", "explicit"] as const)("%s releases real startup/maintenance locks and awaits Gateway readiness", async kind => {
    let entered!: () => void;
    let ready!: () => void;
    const gatewayEntered = new Promise<void>(resolve => { entered = resolve; });
    const gatewayReady = new Promise<void>(resolve => { ready = resolve; });
    vi.mocked(gatewayStartup.ensureConfiguredGatewaySupervisor).mockImplementation(async options => {
      expect(options).toEqual({ stateDir });
      expect(fs.existsSync(startLockPath(stateDir, runtime.workspaceId))).toBe(false);
      expect(readMaintenanceLock(stateDir)).toBeNull();
      const acquired = tryAcquireMaintenanceLock(stateDir, "fixture-gateway-start");
      expect(acquired.ok).toBe(true);
      if (acquired.ok) expect(acquired.handle.release()).toBe(true);
      entered();
      await gatewayReady;
      return null;
    });
    let finished = false;
    const command = start(kind).then(result => { finished = true; return result; });
    await gatewayEntered;
    expect(finished).toBe(false);
    ready();
    expect(await command).toEqual({ runtime, spawned: false });
    expect(gatewayStartup.ensureConfiguredGatewaySupervisor).toHaveBeenCalledTimes(1);
  });

  it("inherited rollout maintenance skips shared Gateway and remains owned by the caller", async () => {
    const acquired = tryAcquireMaintenanceLock(stateDir, "rollout");
    if (!acquired.ok) throw new Error("fixture maintenance busy");
    try {
      expect(await ensureBridge(root, { maintenance: acquired.handle })).toEqual({ runtime, spawned: false });
      expect(readMaintenanceLock(stateDir)?.token).toBe(acquired.handle.token);
      expect(gatewayStartup.ensureConfiguredGatewaySupervisor).not.toHaveBeenCalled();
    } finally { expect(acquired.handle.release()).toBe(true); }
  });

  it("explicit stopped intent shuts down only its Bridge without starting shared Gateway", async () => {
    const shutdown = vi.spyOn(bridgeRuntime, "adminFetch").mockResolvedValue({});
    expect(await withExplicitSupervisorIntent(root, "stopped", undefined, () => stopBridge(root), stateDir)).toBe(true);
    expect(shutdown).toHaveBeenCalledExactlyOnceWith(runtime, "POST", "/admin/shutdown", 5000, undefined);
    expect(gatewayStartup.ensureConfiguredGatewaySupervisor).not.toHaveBeenCalled();
    expect(readMaintenanceLock(stateDir)).toBeNull();
  });

  it.each(["standalone", "explicit"] as const)("%s Gateway failure retains its error code, ready Bridge and workspace auth/session/tunnel state", async kind => {
    const protectedFiles = ["auth", "sessions", "tunnels"].map(directory =>
      write(stateDir, `${directory}/${runtime.workspaceId}.json`, JSON.stringify({ fixture: directory, preserved: true })));
    const before = protectedFiles.map(file => fs.readFileSync(file));
    const failure = new GatewaySupervisorError("GATEWAY_SUPERVISOR_RUN_FAILED", "fixture Gateway timeout");
    vi.mocked(gatewayStartup.ensureConfiguredGatewaySupervisor).mockRejectedValue(failure);
    await expect(start(kind)).rejects.toBe(failure);
    expect(failure.code).toBe("GATEWAY_SUPERVISOR_RUN_FAILED");
    expect(failure.message).toContain("Bridge 已就绪，但 Gateway/公网隧道启动失败");
    expect(await bridgeRuntime.findBridgeObservation(runtime.workspaceId)).toEqual({ state: "healthy", runtime });
    expect(protectedFiles.map(file => fs.readFileSync(file))).toEqual(before);
    expect(readMaintenanceLock(stateDir)).toBeNull();
    expect(fs.existsSync(startLockPath(stateDir, runtime.workspaceId))).toBe(false);
  });

  it.each(["maintenance", "start"])("%s release failure cannot enter Gateway startup", async authority => {
    const target = authority === "maintenance" ? path.join(stateDir, "maintenance.lock") :
      startLockPath(stateDir, runtime.workspaceId);
    const unlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, "unlinkSync").mockImplementation(file => {
      if (String(file) === target) throw new Error("fixture release failure");
      return unlink(file);
    });
    await expect(ensureBridge(root)).rejects.toThrow(/release failed/);
    expect(fs.existsSync(target)).toBe(true);
    expect(gatewayStartup.ensureConfiguredGatewaySupervisor).not.toHaveBeenCalled();
  });

  it("Bridge uncertainty fails before any Gateway startup", async () => {
    vi.mocked(bridgeRuntime.findBridgeObservation).mockResolvedValue({ state: "unknown", runtime, reason: "identity_mismatch" });
    await expect(start("explicit")).rejects.toThrow("refusing to start another bridge");
    expect(gatewayStartup.ensureConfiguredGatewaySupervisor).not.toHaveBeenCalled();
    expect(readMaintenanceLock(stateDir)).toBeNull();
  });
});
