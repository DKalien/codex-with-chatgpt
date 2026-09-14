import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAINTENANCE_LOCK_BUSY,
  MaintenanceBusyError,
  MaintenanceHandleError,
  MaintenanceReleaseError,
  appendCleanupError,
  assertMaintenanceHandle,
  hasLegacyRolloutLock,
  isMaintenanceLockBusy,
  listBridgeStartLocks,
  readCleanupErrors,
  readMaintenanceLock,
  releaseMaintenanceOrThrow,
  tryAcquireMaintenanceLock,
  withMaintenanceLock,
} from "../src/core/maintenance-lock.js";
import { installCore } from "../src/core/install.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";
import { buildCoreFixture } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach(cleanup);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function tmpState(): string {
  const state = makeTmpDir("maint-lock");
  dirs.push(state);
  vi.stubEnv("C2C_STATE_DIR", state);
  return state;
}

describe("machine maintenance lock", () => {
  it("原子独占；第二把 acquire 得到稳定 busy code，不 steal", () => {
    const state = tmpState();
    const first = tryAcquireMaintenanceLock(state, "op-a");
    expect(first.ok).toBe(true);
    expect(isMaintenanceLockBusy(state)).toBe(true);
    const second = tryAcquireMaintenanceLock(state, "op-b");
    expect(second).toEqual({ ok: false, code: MAINTENANCE_LOCK_BUSY });
    const meta = readMaintenanceLock(state)!;
    expect(meta.operation).toBe("op-a");
    expect(meta.token).toBe(first.ok ? first.handle.token : "");
    // stale 不自动偷锁
    expect(tryAcquireMaintenanceLock(state, "op-c").ok).toBe(false);
    if (first.ok) expect(first.handle.release()).toBe(true);
    expect(isMaintenanceLockBusy(state)).toBe(false);
  });

  it("错误 token release 不 unlink 他人 lock", () => {
    const state = tmpState();
    const owner = tryAcquireMaintenanceLock(state, "owner");
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;
    const file = owner.handle.path;
    const original = fs.readFileSync(file, "utf8");
    // 模拟被替换：写入不同 token
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(original), token: "not-the-owner" }));
    expect(owner.handle.release()).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
    // 清理
    fs.unlinkSync(file);
  });

  it("withMaintenanceLock busy 时抛稳定 MaintenanceBusyError", () => {
    const state = tmpState();
    const held = tryAcquireMaintenanceLock(state, "held");
    expect(held.ok).toBe(true);
    try {
      expect(() => withMaintenanceLock("other", () => 1, state)).toThrow(MaintenanceBusyError);
    } finally {
      if (held.ok) held.handle.release();
    }
  });

  it("installCore 在 maintenance 锁内执行，busy 时失败", () => {
    const state = tmpState();
    const root = makeTmpDir("maint-install");
    dirs.push(root);
    write(root, "bin/c2c.js", "// fixture");
    write(root, "dist/cli/index.js", "// fixture");
    write(root, "package.json", '{"type":"module"}');
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    const held = tryAcquireMaintenanceLock(state, "gc-apply");
    expect(held.ok).toBe(true);
    expect(() => installCore(root, buildCoreFixture(root))).toThrow(/maintenance/i);
    if (held.ok) held.handle.release();
    const ok = installCore(root, buildCoreFixture(root));
    expect(ok.runtimeBuildId).toMatch(/^[a-f0-9]{64}$/);
  });

  it("legacy rollout.lock 与 bridge start.lock 可被 GC 侧观察", () => {
    const state = tmpState();
    expect(hasLegacyRolloutLock(state)).toBe(false);
    fs.writeFileSync(path.join(state, "rollout.lock"), "x");
    expect(hasLegacyRolloutLock(state)).toBe(true);
    fs.mkdirSync(path.join(state, "runtime"), { recursive: true });
    expect(listBridgeStartLocks(state)).toEqual([]);
    fs.writeFileSync(path.join(state, "runtime", "a".repeat(12) + ".start.lock"), "1");
    expect(listBridgeStartLocks(state)).toEqual(["a".repeat(12) + ".start.lock"]);
  });

  it("fresh-stateDir installCore：lock 自建目录，成功后释放", () => {
    const parent = makeTmpDir("fresh-parent");
    dirs.push(parent);
    const state = path.join(parent, "brand-new-state"); // 最初不存在
    expect(fs.existsSync(state)).toBe(false);
    vi.stubEnv("C2C_STATE_DIR", state);
    const root = makeTmpDir("fresh-install");
    dirs.push(root);
    write(root, "bin/c2c.js", "// fixture");
    write(root, "dist/cli/index.js", "// fixture");
    write(root, "package.json", '{"type":"module"}');
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    const installed = installCore(root, buildCoreFixture(root));
    expect(installed.runtimeBuildId).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(path.join(state, "current.json"))).toBe(true);
    expect(fs.existsSync(path.join(state, "bin", "c2c.js"))).toBe(true);
    expect(fs.existsSync(path.join(state, "releases", installed.runtimeBuildId))).toBe(true);
    expect(fs.existsSync(path.join(state, "maintenance.lock"))).toBe(false);
  });

  it("assertMaintenanceHandle：合法 handle 通过，forged/replaced/missing fail closed", () => {
    const state = tmpState();
    const owner = tryAcquireMaintenanceLock(state, "rollout");
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;
    expect(() => assertMaintenanceHandle(state, owner.handle)).not.toThrow();
    expect(() => assertMaintenanceHandle(state, { ...owner.handle, path: path.join(state, "other.lock") }))
      .toThrow(MaintenanceHandleError);
    expect(() => assertMaintenanceHandle(state, { ...owner.handle, token: "forged-token" }))
      .toThrow(MaintenanceHandleError);
    // replaced token
    const file = owner.handle.path;
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), token: "someone-else" }));
    expect(() => assertMaintenanceHandle(state, owner.handle)).toThrow(MaintenanceHandleError);
    fs.unlinkSync(file);
    expect(() => assertMaintenanceHandle(state, owner.handle)).toThrow(MaintenanceHandleError);
  });

  it("token mismatch 时 release 失败且不 unlink 他人 lock", () => {
    const state = tmpState();
    const acquired = tryAcquireMaintenanceLock(state, "op");
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    fs.writeFileSync(acquired.handle.path, JSON.stringify({
      version: 1, operation: "x", pid: 1, startedAt: "2026-09-13T00:00:00.000Z", token: "00000000-0000-4000-8000-000000000009",
    }));
    expect(acquired.handle.release()).toBe(false);
    expect(fs.existsSync(acquired.handle.path)).toBe(true);
    fs.unlinkSync(acquired.handle.path);
  });

  it("action 失败 + release 失败：保留原始 error，cause 挂 release failure", () => {
    const state = tmpState();
    const acquired = tryAcquireMaintenanceLock(state, "op");
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    fs.writeFileSync(acquired.handle.path, JSON.stringify({
      version: 1, operation: "x", pid: 1, startedAt: "2026-09-13T00:00:00.000Z", token: "00000000-0000-4000-8000-000000000009",
    }));
    const actionError = new Error("action failed");
    try {
      releaseMaintenanceOrThrow(acquired.handle, { actionError });
      throw new Error("should throw");
    } catch (error) {
      expect(error).toBe(actionError);
      expect((error as { cause?: { code?: string } }).cause?.code).toBe("MAINTENANCE_RELEASE_FAILED");
    }
    expect(fs.existsSync(acquired.handle.path)).toBe(true);
    fs.unlinkSync(acquired.handle.path);
  });

  it("成功 action + release 失败：抛 MAINTENANCE_RELEASE_FAILED 并附 result", () => {
    const state = tmpState();
    const acquired = tryAcquireMaintenanceLock(state, "op");
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    fs.writeFileSync(acquired.handle.path, JSON.stringify({
      version: 1, operation: "x", pid: 1, startedAt: "2026-09-13T00:00:00.000Z", token: "00000000-0000-4000-8000-000000000009",
    }));
    try {
      releaseMaintenanceOrThrow(acquired.handle, { result: { spawned: true, port: 1 } });
      throw new Error("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MaintenanceReleaseError);
      expect((error as MaintenanceReleaseError).result).toEqual({ spawned: true, port: 1 });
    }
    expect(fs.existsSync(acquired.handle.path)).toBe(true);
    fs.unlinkSync(acquired.handle.path);
  });

  it("withMaintenanceLock 成功后 release 失败抛 MAINTENANCE_RELEASE_FAILED", () => {
    const state = tmpState();
    // 通过 helper 持有锁后，在 action 内替换 token，使最终 release 失败
    // withMaintenanceLock 自己 acquire；在 action 中破坏自己的 lock 文件
    try {
      withMaintenanceLock("probe", (handle) => {
        fs.writeFileSync(handle.path, JSON.stringify({
          version: 1, operation: "probe", pid: 1, startedAt: "2026-09-13T00:00:00.000Z", token: "replaced",
        }));
        return "payload";
      }, state);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("MAINTENANCE_RELEASE_FAILED");
      expect((error as { result?: string }).result).toBe("payload");
    }
    // replaced lock 仍在，不被 steal
    expect(fs.existsSync(path.join(state, "maintenance.lock"))).toBe(true);
    fs.unlinkSync(path.join(state, "maintenance.lock"));
  });

  it("action + start + maintenance cleanup failures 全部可枚举，主 error identity 保留", () => {
    const state = tmpState();
    const acquired = tryAcquireMaintenanceLock(state, "op");
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    fs.writeFileSync(acquired.handle.path, JSON.stringify({
      version: 1, operation: "x", pid: 1, startedAt: "2026-09-13T00:00:00.000Z", token: "00000000-0000-4000-8000-000000000009",
    }));
    const actionError = new Error("original action failed");
    (actionError as { items?: unknown[] }).items = [{ buildId: "x", status: "deleted" }];
    appendCleanupError(actionError, new Error("start.lock release failed"));
    try {
      releaseMaintenanceOrThrow(acquired.handle, { actionError });
      throw new Error("should throw");
    } catch (error) {
      expect(error).toBe(actionError);
      expect((error as Error).message).toBe("original action failed");
      const cleanups = readCleanupErrors(error);
      expect(cleanups.length).toBe(2);
      expect(cleanups.map((e) => e.message)).toEqual([
        "start.lock release failed",
        "maintenance lock release failed after action error",
      ]);
      expect((error as { items?: unknown[] }).items).toEqual([{ buildId: "x", status: "deleted" }]);
    }
    expect(fs.existsSync(acquired.handle.path)).toBe(true);
    fs.unlinkSync(acquired.handle.path);
  });
});
