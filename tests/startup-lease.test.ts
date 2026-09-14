import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MaintenanceHandleError,
  tryAcquireMaintenanceLock,
  assertMaintenanceHandle,
  readMaintenanceLock,
} from "../src/core/maintenance-lock.js";
import {
  StartupLeaseError,
  StartupLeaseReplayError,
  assertStartupLease,
  claimPath,
  claimStartupLease,
  cleanupStartupLeaseClaim,
  consumeStartupLeaseFromEnv,
  createStartLock,
  decodeStartupLease,
  encodeStartupLease,
  issueStartupLease,
  STARTUP_LEASE_ENV,
} from "../src/core/startup-lease.js";
import { ensureBridge } from "../src/process/daemon.js";
import * as bridgeRuntime from "../src/bridge/runtime.js";
import { Workspace } from "../src/workspace/manager.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

let stateDir: string;
let wsRoot: string;

beforeEach(() => {
  stateDir = isolateStateDir();
  wsRoot = makeTmpDir("startup-lease-ws");
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup(stateDir);
  cleanup(wsRoot);
  delete process.env.C2C_STATE_DIR;
});

describe("strict maintenance lock metadata", () => {
  it("rejects symlink / extra field / wrong version / bad startedAt / bad pid/token", () => {
    const acquired = tryAcquireMaintenanceLock(stateDir, "probe");
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    const file = acquired.handle.path;
    const good = JSON.parse(fs.readFileSync(file, "utf8"));

    const cases: Array<Record<string, unknown>> = [
      { ...good, extra: 1 },
      { ...good, version: 2 },
      { ...good, startedAt: "not-iso" },
      { ...good, pid: 1.5 },
      { ...good, pid: "1" },
      { ...good, token: "not-a-uuid" },
      { ...good, operation: "" },
    ];
    for (const bad of cases) {
      fs.writeFileSync(file, JSON.stringify(bad));
      expect(readMaintenanceLock(stateDir)).toBeNull();
      expect(() => assertMaintenanceHandle(stateDir, acquired.handle)).toThrow(MaintenanceHandleError);
    }

    // restore good then replace with symlink to a regular file
    fs.writeFileSync(file, JSON.stringify(good));
    const target = path.join(stateDir, "target.json");
    fs.writeFileSync(target, JSON.stringify(good));
    fs.unlinkSync(file);
    fs.symlinkSync(target, file);
    expect(readMaintenanceLock(stateDir)).toBeNull();
    expect(() => assertMaintenanceHandle(stateDir, acquired.handle)).toThrow(MaintenanceHandleError);
    fs.unlinkSync(file);
    fs.writeFileSync(file, JSON.stringify(good));
    acquired.handle.release();
  });
});

describe("startup lease fencing", () => {
  it("合法 lease 通过；forged/replayed/wrong-workspace fail closed", () => {
    const workspace = new Workspace(wsRoot);
    const maintenance = tryAcquireMaintenanceLock(stateDir, "bridge-start");
    expect(maintenance.ok).toBe(true);
    if (!maintenance.ok) return;
    const start = createStartLock(stateDir, workspace.id);
    const lease = issueStartupLease({ stateDir, workspace, maintenance: maintenance.handle, startLockNonce: start.nonce });

    expect(() => assertStartupLease(lease, workspace)).not.toThrow();

    expect(() => assertStartupLease({ ...lease, maintenanceToken: "00000000-0000-4000-8000-000000000001" }, workspace))
      .toThrow();
    expect(() => assertStartupLease({ ...lease, startLockNonce: "00000000-0000-4000-8000-000000000002" }, workspace))
      .toThrow(StartupLeaseError);
    expect(() => assertStartupLease(lease, new Workspace(makeTmpDir("other-ws"))))
      .toThrow(StartupLeaseError);

    expect(start.release()).toBe(true);
    expect(() => assertStartupLease(lease, workspace)).toThrow(StartupLeaseError);
    maintenance.handle.release();
  });

  it("one-shot claim：first success，same active lease second fails；cleanup 后 claim 移除", () => {
    const workspace = new Workspace(wsRoot);
    const maintenance = tryAcquireMaintenanceLock(stateDir, "bridge-start");
    if (!maintenance.ok) throw new Error("busy");
    const start = createStartLock(stateDir, workspace.id);
    const lease = issueStartupLease({ stateDir, workspace, maintenance: maintenance.handle, startLockNonce: start.nonce });

    const first = claimStartupLease(lease, workspace);
    expect(fs.existsSync(first.claimPath)).toBe(true);
    expect(() => claimStartupLease(lease, workspace)).toThrow(StartupLeaseReplayError);

    expect(cleanupStartupLeaseClaim(stateDir, lease)).toBe(true);
    expect(fs.existsSync(claimPath(stateDir, workspace.id, lease.leaseNonce))).toBe(false);

    start.release();
    maintenance.handle.release();
  });

  it("crash-style stale claim 不自动 steal", () => {
    const workspace = new Workspace(wsRoot);
    const maintenance = tryAcquireMaintenanceLock(stateDir, "bridge-start");
    if (!maintenance.ok) throw new Error("busy");
    const start = createStartLock(stateDir, workspace.id);
    const lease = issueStartupLease({ stateDir, workspace, maintenance: maintenance.handle, startLockNonce: start.nonce });
    claimStartupLease(lease, workspace);
    // 另一 leaseNonce 的 claim 文件已存在时，cleanup 不会误删
    const other = { ...lease, leaseNonce: "00000000-0000-4000-8000-0000000000aa" };
    expect(cleanupStartupLeaseClaim(stateDir, other)).toBe(false);
    start.release();
    maintenance.handle.release();
  });

  it("start.lock handle：wrong nonce / replaced metadata 不 unlink", () => {
    const workspace = new Workspace(wsRoot);
    const handle = createStartLock(stateDir, workspace.id);
    expect(fs.existsSync(handle.path)).toBe(true);
    fs.writeFileSync(handle.path, JSON.stringify({
      version: 1,
      workspaceId: workspace.id,
      nonce: "00000000-0000-4000-8000-0000000000bb",
      pid: process.pid,
      createdAt: new Date().toISOString(),
    }));
    expect(handle.release()).toBe(false);
    expect(fs.existsSync(handle.path)).toBe(true);
    fs.unlinkSync(handle.path);
  });

  it("start.lock strict metadata：extra field / bad createdAt / non-positive pid 拒绝", () => {
    const workspace = new Workspace(wsRoot);
    const handle = createStartLock(stateDir, workspace.id);
    const good = JSON.parse(fs.readFileSync(handle.path, "utf8"));
    const cases = [
      { ...good, extra: 1 },
      { ...good, createdAt: "not-iso" },
      { ...good, pid: 0 },
      { ...good, pid: -1 },
    ];
    for (const bad of cases) {
      fs.writeFileSync(handle.path, JSON.stringify(bad));
      expect(handle.release()).toBe(false);
      expect(fs.existsSync(handle.path)).toBe(true);
    }
    fs.writeFileSync(handle.path, JSON.stringify(good));
    expect(handle.release()).toBe(true);
    expect(fs.existsSync(handle.path)).toBe(false);
  });

  it("consumeStartupLeaseFromEnv 读取后删除 env，避免继承", () => {
    const workspace = new Workspace(wsRoot);
    const maintenance = tryAcquireMaintenanceLock(stateDir, "bridge-start");
    if (!maintenance.ok) throw new Error("busy");
    const start = createStartLock(stateDir, workspace.id);
    const lease = issueStartupLease({ stateDir, workspace, maintenance: maintenance.handle, startLockNonce: start.nonce });
    const env: NodeJS.ProcessEnv = { [STARTUP_LEASE_ENV]: encodeStartupLease(lease) };
    const consumed = consumeStartupLeaseFromEnv(env);
    expect(consumed).toEqual(lease);
    expect(env[STARTUP_LEASE_ENV]).toBeUndefined();
    start.release();
    maintenance.handle.release();
  });

  it("encode/decode 往返稳定；坏 base64 拒绝", () => {
    const workspace = new Workspace(wsRoot);
    const maintenance = tryAcquireMaintenanceLock(stateDir, "bridge-start");
    if (!maintenance.ok) throw new Error("busy");
    const start = createStartLock(stateDir, workspace.id);
    const lease = issueStartupLease({ stateDir, workspace, maintenance: maintenance.handle, startLockNonce: start.nonce });
    const round = decodeStartupLease(encodeStartupLease(lease));
    expect(round).toEqual(lease);
    expect(() => decodeStartupLease("!!!")).toThrow(StartupLeaseError);
    start.release();
    maintenance.handle.release();
  });

  it("start.lock release 失败时保留 claim，二次 claim 仍 REPLAY", () => {
    const workspace = new Workspace(wsRoot);
    const maintenance = tryAcquireMaintenanceLock(stateDir, "bridge-start");
    if (!maintenance.ok) throw new Error("busy");
    const start = createStartLock(stateDir, workspace.id);
    const lease = issueStartupLease({ stateDir, workspace, maintenance: maintenance.handle, startLockNonce: start.nonce });
    claimStartupLease(lease, workspace);
    const claim = claimPath(stateDir, workspace.id, lease.leaseNonce);
    const realUnlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      if (String(target) === start.path) throw new Error("simulated unlink failure");
      return realUnlink(target as fs.PathLike);
    });
    expect(start.release()).toBe(false);
    vi.restoreAllMocks();
    // daemon 约定：start.release() !== true 时不得清理 claim
    expect(fs.existsSync(claim)).toBe(true);
    expect(() => claimStartupLease(lease, workspace)).toThrow(StartupLeaseReplayError);
    expect(start.release()).toBe(true);
    cleanupStartupLeaseClaim(stateDir, lease);
    maintenance.handle.release();
  });

  it("standalone ensureBridge 在 healthy 路径成功并清理 start.lock", async () => {
    const workspace = new Workspace(wsRoot);
    const runtime = {
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: workspace.id,
      workspaceRoot: wsRoot,
      pid: process.pid,
      port: 48111,
      adminToken: "t",
      publicUrl: null,
      startedAt: new Date().toISOString(),
    };
    vi.spyOn(bridgeRuntime, "findBridgeObservation").mockResolvedValue({ state: "healthy", runtime } as never);
    const result = await ensureBridge(wsRoot);
    expect(result.runtime.port).toBe(48111);
    expect(fs.existsSync(path.join(stateDir, "runtime", `${workspace.id}.start.lock`))).toBe(false);
  });
});
