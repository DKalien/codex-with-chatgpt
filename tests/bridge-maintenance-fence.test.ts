import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBridge } from "../src/process/daemon.js";
import * as bridgeRuntime from "../src/bridge/runtime.js";
import {
  MaintenanceBusyError,
  MaintenanceHandleError,
  tryAcquireMaintenanceLock,
} from "../src/core/maintenance-lock.js";
import { applyGc } from "../src/core/gc-apply.js";
import { installCore } from "../src/core/install.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { Workspace } from "../src/workspace/manager.js";
import { buildCoreFixture, cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

let stateDir: string;
let wsRoot: string;

beforeEach(() => {
  stateDir = isolateStateDir();
  wsRoot = makeTmpDir("bridge-fence-ws");
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup(stateDir);
  cleanup(wsRoot);
  delete process.env.C2C_STATE_DIR;
});

function startLockLeftovers(): string[] {
  const runtimeDir = path.join(stateDir, "runtime");
  if (!fs.existsSync(runtimeDir)) return [];
  return fs.readdirSync(runtimeDir).filter((n) => n.endsWith(".start.lock"));
}

describe("bridge-start maintenance fencing", () => {
  it("GC 持有 maintenance 时 standalone ensureBridge 在 spawn 前失败并清理 start.lock", async () => {
    const held = tryAcquireMaintenanceLock(stateDir, "gc-apply");
    expect(held.ok).toBe(true);
    await expect(ensureBridge(wsRoot)).rejects.toThrow(MaintenanceBusyError);
    expect(startLockLeftovers()).toEqual([]);
    expect(fs.existsSync(path.join(stateDir, "runtime", `${new Workspace(wsRoot).id}.json`))).toBe(false);
    if (held.ok) held.handle.release();
  });

  it("合法 inherited handle 可进入 critical section（healthy 复用，不 spawn）", async () => {
    const held = tryAcquireMaintenanceLock(stateDir, "rollout");
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    vi.spyOn(bridgeRuntime, "findBridgeObservation").mockResolvedValue({
      state: "healthy",
      runtime: {
        service: SERVICE_NAME,
        version: VERSION,
        workspaceId: new Workspace(wsRoot).id,
        workspaceRoot: wsRoot,
        pid: process.pid,
        port: 48000,
        adminToken: "token",
        publicUrl: null,
        startedAt: new Date().toISOString(),
      },
    });
    const result = await ensureBridge(wsRoot, { maintenance: held.handle });
    expect(result.spawned).toBe(false);
    held.handle.release();
  });

  it("forged / wrong-path / replaced-token handle 被拒绝且不写 runtime", async () => {
    const held = tryAcquireMaintenanceLock(stateDir, "rollout");
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    const wsId = new Workspace(wsRoot).id;

    await expect(ensureBridge(wsRoot, {
      maintenance: { ...held.handle, token: "forged" },
    })).rejects.toThrow(MaintenanceHandleError);

    await expect(ensureBridge(wsRoot, {
      maintenance: { ...held.handle, path: path.join(stateDir, "not-maintenance.lock") },
    })).rejects.toThrow(MaintenanceHandleError);

    fs.writeFileSync(held.handle.path, JSON.stringify({
      version: 1, operation: "x", pid: 1, startedAt: "2026-09-13T00:00:00.000Z", token: "other",
    }));
    await expect(ensureBridge(wsRoot, { maintenance: held.handle })).rejects.toThrow(MaintenanceHandleError);

    expect(startLockLeftovers()).toEqual([]);
    expect(fs.existsSync(path.join(stateDir, "runtime", `${wsId}.json`))).toBe(false);
    fs.unlinkSync(held.handle.path);
  });

  it("apply 持有 maintenance 时 ensureBridge 不能启动（确定性 race）", async () => {
    write(wsRoot, "bin/c2c.js", "// fixture");
    write(wsRoot, "dist/cli/index.js", "// fixture");
    write(wsRoot, "package.json", '{"type":"module"}');
    fs.mkdirSync(path.join(wsRoot, "node_modules"), { recursive: true });
    installCore(wsRoot, buildCoreFixture(wsRoot));
    write(wsRoot, "dist/cli/index.js", "// next");
    installCore(wsRoot, buildCoreFixture(wsRoot));

    let ensureDuringApply: Promise<unknown> | null = null;
    const apply = applyGc({
      stateDir,
      hooks: {
        afterLockAcquired() {
          ensureDuringApply = ensureBridge(wsRoot);
        },
      },
    });
    expect(apply.ok).toBe(true);
    expect(ensureDuringApply).not.toBeNull();
    await expect(ensureDuringApply).rejects.toThrow(MaintenanceBusyError);
    expect(startLockLeftovers()).toEqual([]);
    expect(fs.existsSync(path.join(stateDir, "current.json"))).toBe(true);
  });
});
