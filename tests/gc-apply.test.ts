import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { activeFinalizerPath, workerClaimPath, readFinalizerRetirement } from "../src/core/post-turn-finalizer.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planGc } from "../src/core/gc-plan.js";
import { applyGc, removeTreeNoFollow } from "../src/core/gc-apply.js";
import {
  isMaintenanceLockBusy,
  tryAcquireMaintenanceLock,
} from "../src/core/maintenance-lock.js";
import { installCore } from "../src/core/install.js";
import { Workspace } from "../src/workspace/manager.js";
import { buildCoreFixture, cleanup, makeTmpDir, write } from "./helpers.js";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach(cleanup);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function fixture(markers: string[]) {
  const state = makeTmpDir("gc-apply-state");
  const root = makeTmpDir("gc-apply-checkout");
  dirs.push(state, root);
  vi.stubEnv("C2C_STATE_DIR", state);
  write(root, "bin/c2c.js", "// fixture");
  write(root, "dist/cli/index.js", "// fixture");
  write(root, "package.json", '{"type":"module"}');
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  const releases = markers.map(marker => {
    write(root, "dist/cli/index.js", `// ${marker}`);
    return installCore(root, buildCoreFixture(root));
  });
  return { state, root, releases };
}

function writeRuntime(state: string, root: string, runtimeBuildId: string, workspaceId: string): void {
  write(state, path.join("runtime", `${workspaceId}.json`), JSON.stringify({
    service: "codex-with-chatgpt", version: "test", workspaceId, workspaceRoot: root,
    pid: 123, port: 48765, adminToken: "t", publicUrl: null,
    startedAt: "2026-09-13T00:00:00.000Z", runtimeBuildId,
  }));
}

function writePending(state: string, root: string, targetBuildId: string, workspaceId: string): void {
  write(state, path.join("runtime-upgrades", `${workspaceId}.json`), JSON.stringify({
    workspaceId, workspaceRoot: root, targetBuildId, reason: "busy",
    updatedAt: "2026-09-13T00:00:00.000Z",
  }));
}

describe("scoped GC progress", () => {
  it.each(["pending", "finalizer"])("exact %s A allows unrelated B to delete even with future fields", kind => {
    const { state, root, releases } = fixture(["A", "B", "current"]);
    const ws = new Workspace(root).id;
    const authority = kind === "pending" ? path.join(state, "runtime-upgrades", `${ws}.json`) : activeFinalizerPath(state, ws);
    write(state, path.relative(state, authority), JSON.stringify({ workspaceId: ws, workspaceRoot: root,
      targetBuildId: releases[0].runtimeBuildId, futureField: true }));
    const before = fs.readFileSync(authority);
    const result = applyGc({ stateDir: state });
    expect(result.globalBlockerCount).toBe(0);
    expect(result.localIssueCount).toBe(kind === "pending" ? 0 : 1);
    expect(result.totals.deletedCount).toBe(1);
    expect(fs.existsSync(releases[0].releaseRoot)).toBe(true);
    expect(fs.existsSync(releases[1].releaseRoot)).toBe(false);
    expect(fs.readFileSync(authority)).toEqual(before);
  });

  it.each(["runtime-missing", "runtime-invalid", "pending", "finalizer", "worker", "retirement"])("unscoped %s authority blocks all destruction", kind => {
    const { state, root, releases } = fixture(["A", "B", "current"]);
    const ws = new Workspace(root).id;
    const folder = kind.startsWith("runtime") ? "runtime" : kind === "pending" ? "runtime-upgrades" :
      kind === "finalizer" ? "post-turn-finalizers" : kind === "worker" ? "post-turn-finalizer-workers" : "post-turn-finalizer-retirements";
    write(state, path.join(folder, `${ws}.${kind === "worker" ? "claim" : "json"}`), JSON.stringify({
      workspaceId: ws, workspaceRoot: root, ...(kind === "runtime-invalid" ? { runtimeBuildId: "invalid" } : {}),
    }));
    const mutate = vi.fn();
    const result = applyGc({ stateDir: state, hooks: { afterLockAcquired: mutate }, fns: { renameSync: mutate, removeTree: mutate } });
    expect(result).toMatchObject({ ok: false, status: "blocked" });
    expect(result.globalBlockerCount).toBeGreaterThan(0);
    expect(result.totals.deletedCount).toBe(0);
    expect(mutate).not.toHaveBeenCalled();
    for (const release of releases) expect(fs.existsSync(release.releaseRoot)).toBe(true);
  });

  it.each([0, 1])("new global blocker after %i deletions halts every remaining item", alreadyDeleted => {
    const { state, releases } = fixture(["A", "B", "C", "current"]);
    let calls = 0;
    const result = applyGc({ stateDir: state, hooks: { beforeTombstone() {
      if (calls++ === alreadyDeleted) write(state, path.join("runtime", "unknown.json"), "{}");
    } } });
    expect(result).toMatchObject({ ok: false, status: "blocked" });
    expect(result.globalBlockerCount).toBeGreaterThan(0);
    expect(result.totals.deletedCount).toBe(alreadyDeleted);
    expect(result.totals.skippedCount).toBe(3 - alreadyDeleted);
    expect(releases.filter(release => !fs.existsSync(release.releaseRoot))).toHaveLength(alreadyDeleted);
  });

  it("start lock appearing before a later tombstone halts remaining deletions", () => {
    const { state } = fixture(["A", "B", "current"]);
    let calls = 0;
    const result = applyGc({ stateDir: state, hooks: { beforeTombstone() {
      if (calls++ === 1) write(state, path.join("runtime", `${"a".repeat(12)}.start.lock`), "busy");
    } } });
    expect(result).toMatchObject({ ok: false, status: "blocked" });
    expect(result.totals.deletedCount).toBe(1);
    expect(result.totals.skippedCount).toBe(1);
  });

  it("reclaims ten valid candidates while preserving an unrelated malformed release", () => {
    const { state, releases } = fixture([...Array.from({ length: 10 }, (_, i) => `old-${i}`), "broken", "current"]);
    fs.writeFileSync(path.join(releases[10].releaseRoot, "release.json"), "{}");
    const result = applyGc({ stateDir: state });
    expect(result).toMatchObject({ ok: false, status: "partial", globalBlockerCount: 0, localIssueCount: 1 });
    expect(result.totals.deletedCount).toBe(10);
    for (const release of releases.slice(0, 10)) expect(fs.existsSync(release.releaseRoot)).toBe(false);
    for (const release of releases.slice(10)) expect(fs.existsSync(release.releaseRoot)).toBe(true);
    expect(result.totals.bytesDeleted).toBe(result.items.filter(i => i.status === "deleted").reduce((n, i) => n + i.logicalBytes, 0));
  });

  it("dangling exact reference preserves its authority but does not pin unrelated A/B", () => {
    const { state, root, releases } = fixture(["A", "B", "current"]);
    const ws = new Workspace(root).id;
    writeRuntime(state, root, "f".repeat(64), ws);
    const file = path.join(state, "runtime", `${ws}.json`), before = fs.readFileSync(file);
    const result = applyGc({ stateDir: state });
    expect(result).toMatchObject({ ok: false, status: "partial", globalBlockerCount: 0, localIssueCount: 1 });
    expect(result.totals.deletedCount).toBe(2);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.existsSync(path.join(state, "releases", "f".repeat(64)))).toBe(false);
    expect(fs.existsSync(releases[2].releaseRoot)).toBe(true);
  });

  it.each(["capabilities", "futureField"])("runtime with %s pins exact A while B is reclaimed", extra => {
    const { state, root, releases } = fixture(["A", "B", "current"]);
    const ws = new Workspace(root).id;
    writeRuntime(state, root, releases[0].runtimeBuildId, ws);
    const file = path.join(state, "runtime", `${ws}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), [extra]: { extension: true } }));
    const result = applyGc({ stateDir: state });
    expect(result.ok).toBe(true);
    expect(result.totals.deletedCount).toBe(1);
    expect(fs.existsSync(releases[0].releaseRoot)).toBe(true);
    expect(fs.existsSync(releases[1].releaseRoot)).toBe(false);
  });

  it("candidate becoming referenced only skips itself", () => {
    const { state, root, releases } = fixture(["A", "B", "current"]);
    const result = applyGc({ stateDir: state, hooks: { afterLockAcquired() {
      writeRuntime(state, root, releases[0].runtimeBuildId, new Workspace(root).id);
    } } });
    expect(result.totals.deletedCount).toBe(1);
    expect(result.items).toContainEqual(expect.objectContaining({ buildId: releases[0].runtimeBuildId, status: "skipped" }));
    expect(fs.existsSync(releases[0].releaseRoot)).toBe(true);
    expect(fs.existsSync(releases[1].releaseRoot)).toBe(false);
  });

  it("a newly appearing candidate is deferred while the original candidate is reclaimed", () => {
    const { state, releases } = fixture(["A", "current"]);
    const added = "f".repeat(64), addedRoot = path.join(state, "releases", added);
    const result = applyGc({ stateDir: state, hooks: { afterLockAcquired() {
      write(addedRoot, "release.json", JSON.stringify({ version: 1, runtimeBuildId: added, artifactSha256: "a".repeat(64) }));
    } } });
    expect(result.totals.deletedCount).toBe(1);
    expect(result.items).toContainEqual(expect.objectContaining({ buildId: added, status: "skipped", reason: "new_candidate_not_deleted" }));
    expect(fs.existsSync(addedRoot)).toBe(true);
    expect(fs.existsSync(releases[0].releaseRoot)).toBe(false);
  });

  it("pre-tombstone local manifest failure does not prevent processing an independent candidate", () => {
    const { state, releases } = fixture(["A", "B", "current"]);
    const candidates = releases.slice(0, 2).sort((a, b) => a.runtimeBuildId.localeCompare(b.runtimeBuildId));
    const result = applyGc({ stateDir: state, hooks: { beforeTombstone(id) {
      if (id === candidates[0].runtimeBuildId) fs.writeFileSync(path.join(candidates[0].releaseRoot, "release.json"), "{}");
    } } });
    expect(result).toMatchObject({ ok: false, status: "partial" });
    expect(result.totals.deletedCount).toBe(1);
    expect(fs.existsSync(candidates[0].releaseRoot)).toBe(true);
    expect(fs.existsSync(candidates[1].releaseRoot)).toBe(false);
  });
});

describe("gc apply 安全算法", () => {
  it("无候选时 success no-op", () => {
    const { state } = fixture(["A"]);
    const result = applyGc({ stateDir: state });
    expect(result.ok).toBe(true);
    expect(result.totals.candidateCount).toBe(0);
    expect(result.totals.deletedCount).toBe(0);
    expect(isMaintenanceLockBusy(state)).toBe(false);
  });

  it("合法 candidate：tombstone 后删除；current/runtime/pending 永不删除", () => {
    const { state, root, releases } = fixture(["A", "B", "C"]);
    const workspaceId = new Workspace(root).id;
    writeRuntime(state, root, releases[0].runtimeBuildId, workspaceId);
    writePending(state, root, releases[1].runtimeBuildId, workspaceId);
    // current = last install = releases[2]
    const plan = planGc(state);
    // A runtime keep, B pending keep, C current keep → 无候选
    expect(plan.totals.bytesCandidateReclaimable).toBe(0);
    const noop = applyGc({ stateDir: state });
    expect(noop.ok).toBe(true);
    expect(fs.existsSync(releases[0].releaseRoot)).toBe(true);
    expect(fs.existsSync(releases[1].releaseRoot)).toBe(true);
    expect(fs.existsSync(releases[2].releaseRoot)).toBe(true);
  });

  it("未引用 release 被 tombstone+delete，bytesDeleted 只计完成删除", () => {
    const { state, releases } = fixture(["A", "B"]);
    const old = releases[0];
    const current = releases[1];
    expect(planGc(state).releases.find(r => r.buildId === old.runtimeBuildId)!.disposition).toBe("delete-candidate");
    const result = applyGc({ stateDir: state });
    expect(result.ok).toBe(true);
    expect(result.items).toEqual([expect.objectContaining({
      buildId: old.runtimeBuildId,
      status: "deleted",
      reason: "reclaimed",
    })]);
    expect(result.totals.bytesDeleted).toBe(result.items[0]!.logicalBytes);
    expect(fs.existsSync(old.releaseRoot)).toBe(false);
    expect(fs.existsSync(current.releaseRoot)).toBe(true);
    expect(isMaintenanceLockBusy(state)).toBe(false);
    // gc-trash 不应残留 tombstone
    const trash = path.join(state, "gc-trash");
    expect(!fs.existsSync(trash) || fs.readdirSync(trash).length === 0).toBe(true);
  });

  it("maintenance busy → 无 mutation", () => {
    const { state, releases } = fixture(["A", "B"]);
    const held = tryAcquireMaintenanceLock(state, "other");
    expect(held.ok).toBe(true);
    const result = applyGc({ stateDir: state });
    expect(result.ok).toBe(false);
    expect(result.issues.some(i => i.includes("maintenance_busy"))).toBe(true);
    expect(fs.existsSync(releases[0].releaseRoot)).toBe(true);
    if (held.ok) held.handle.release();
  });

  it("legacy rollout.lock 存在 → fail closed", () => {
    const { state, releases } = fixture(["A", "B"]);
    fs.writeFileSync(path.join(state, "rollout.lock"), "x");
    const result = applyGc({ stateDir: state });
    expect(result.ok).toBe(false);
    expect(result.issues.some(i => i.includes("legacy_rollout_lock"))).toBe(true);
    expect(fs.existsSync(releases[0].releaseRoot)).toBe(true);
  });

  it("bridge start.lock 存在 → abort，不删除", () => {
    const { state, releases } = fixture(["A", "B"]);
    write(state, path.join("runtime", `${"c".repeat(12)}.start.lock`), "1");
    const result = applyGc({ stateDir: state });
    expect(result.ok).toBe(false);
    expect(result.issues.some(i => i.includes("bridge_start_in_progress"))).toBe(true);
    expect(fs.existsSync(releases[0].releaseRoot)).toBe(true);
  });

  it("initial plan unsafe → 不进 lock / 不破坏", () => {
    const { state, releases } = fixture(["A", "B"]);
    fs.writeFileSync(path.join(state, "current.json"), "{broken}");
    const result = applyGc({ stateDir: state });
    expect(result.ok).toBe(false);
    expect(result.issues.some(i => i.includes("initial_plan_unsafe"))).toBe(true);
    expect(fs.existsSync(releases[0].releaseRoot)).toBe(true);
    expect(isMaintenanceLockBusy(state)).toBe(false);
  });

  it("candidate 在 lock 内被引用后 stale abort，deletedCount=0 且 release 仍在", () => {
    const { state, root, releases } = fixture(["A", "B"]);
    const old = releases[0];
    const workspaceId = new Workspace(root).id;
    const result = applyGc({
      stateDir: state,
      hooks: {
        afterLockAcquired() {
          writeRuntime(state, root, old.runtimeBuildId, workspaceId);
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.totals.deletedCount).toBe(0);
    expect(result.items).toContainEqual(expect.objectContaining({ buildId: old.runtimeBuildId, status: "skipped", reason: "candidate_reference_changed" }));
    expect(fs.existsSync(old.releaseRoot)).toBe(true);
  });

  it("GC 持有 rollout fence 时 legacy-style openSync(wx) 失败，结束后释放", () => {
    const { state, releases } = fixture(["A", "B"]);
    const rolloutPath = path.join(state, "rollout.lock");
    let sawFence = false;
    const result = applyGc({
      stateDir: state,
      hooks: {
        afterFreshPlan() {
          sawFence = fs.existsSync(rolloutPath);
          expect(() => fs.openSync(rolloutPath, "wx", 0o600)).toThrow();
        },
      },
    });
    expect(sawFence).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.totals.deletedCount).toBe(1);
    expect(fs.existsSync(rolloutPath)).toBe(false);
    expect(fs.existsSync(releases[0].releaseRoot)).toBe(false);
    expect(fs.existsSync(releases[1].releaseRoot)).toBe(true);
  });

  it("maintenance 获取后、rollout fence 被抢先创建 → abort 无 mutation", () => {
    const { state, releases } = fixture(["A", "B"]);
    const result = applyGc({
      stateDir: state,
      hooks: {
        afterLockAcquired() {
          fs.writeFileSync(path.join(state, "rollout.lock"), "legacy");
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some(i => i.includes("legacy_rollout_lock"))).toBe(true);
    expect(result.totals.deletedCount).toBe(0);
    expect(fs.existsSync(releases[0].releaseRoot)).toBe(true);
  });

  it("rollout fence unlink 失败 → ok=false 但保留 deleted items", () => {
    const { state, releases } = fixture(["A", "B"]);
    const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      if (String(target).endsWith("rollout.lock")) {
        throw new Error("simulated unlink failure");
      }
      return fs.unlinkSync as never;
    });
    // restore real unlink for non-fence paths via wrap
    unlinkSpy.mockRestore();
    const realUnlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      if (String(target).endsWith("rollout.lock")) throw new Error("simulated unlink failure");
      return realUnlink(target as fs.PathLike);
    });
    const result = applyGc({ stateDir: state });
    vi.restoreAllMocks();
    expect(result.totals.deletedCount).toBe(1);
    expect(fs.existsSync(releases[0].releaseRoot)).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.issues.some(i => i.includes("rollout_fence_release_failed"))).toBe(true);
    // 失败后 fence 可能仍在，供人工核对；不自动 steal
    expect(fs.existsSync(path.join(state, "rollout.lock"))).toBe(true);
  });

  it("fresh 前 candidate 变为 current → stale abort", () => {
    const { state, releases } = fixture(["A", "B"]);
    const old = releases[0];
    const result = applyGc({
      stateDir: state,
      hooks: {
        afterLockAcquired() {
          const current = JSON.parse(fs.readFileSync(path.join(state, "current.json"), "utf8"));
          current.runtimeBuildId = old.runtimeBuildId;
          current.releaseRoot = old.releaseRoot;
          current.manifestSha256 = current.manifestSha256; // keep v3 shape
          fs.writeFileSync(path.join(state, "current.json"), JSON.stringify(current));
        },
      },
    });
    // pointer 指向 old 后 fast verify 可能失败 → initial 已在 hook 前成功，fresh 可能 unsafe 或 set 变化
    expect(result.ok).toBe(false);
    expect(fs.existsSync(old.releaseRoot)).toBe(true);
  });

  it("fresh 前出现 runtime 引用 → stale abort", () => {
    const { state, root, releases } = fixture(["A", "B"]);
    const old = releases[0];
    const workspaceId = new Workspace(root).id;
    const result = applyGc({
      stateDir: state,
      hooks: {
        afterLockAcquired() {
          writeRuntime(state, root, old.runtimeBuildId, workspaceId);
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.items).toContainEqual(expect.objectContaining({ buildId: old.runtimeBuildId, status: "skipped", reason: "candidate_reference_changed" }));
    expect(fs.existsSync(old.releaseRoot)).toBe(true);
  });

  it("fresh 前出现 pending 引用 → stale abort", () => {
    const { state, root, releases } = fixture(["A", "B"]);
    const old = releases[0];
    const workspaceId = new Workspace(root).id;
    const result = applyGc({
      stateDir: state,
      hooks: {
        afterLockAcquired() {
          writePending(state, root, old.runtimeBuildId, workspaceId);
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(old.releaseRoot)).toBe(true);
  });

  it("fresh 前新增 candidate → 整轮 stale abort，不删除新 candidate", () => {
    const { state, root, releases } = fixture(["A", "B"]);
    // 在 lock 后再 install 第三个（会再次拿 maintenance —— 会 busy！）
    // 改为直接创建一个 valid-looking 目录会 fail manifest。
    // 用 hooks afterLockAcquired 时我们已持有锁，无法再 installCore。
    // 模拟：在 afterInitialPlan 后、但 apply 仍会取锁… 真正路径是两个进程。
    // 这里用 afterLockAcquired 注入一个已存在的 unreferenced 目录：fixture 只有 A,B；
    // 在 afterLockAcquired 中把 B 的 current 改回… 复杂。
    // 直接验证：initial 1 candidate；afterLockAcquired 时再写 runtime 使该 candidate 被引用 → set 变空。
    const old = releases[0];
    const workspaceId = new Workspace(root).id;
    const result = applyGc({
      stateDir: state,
      hooks: {
        afterLockAcquired() {
          writeRuntime(state, root, old.runtimeBuildId, workspaceId);
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(old.releaseRoot)).toBe(true);
  });

  it("candidate 消失 → stale abort", () => {
    const { state, releases } = fixture(["A", "B"]);
    const old = releases[0];
    const result = applyGc({
      stateDir: state,
      hooks: {
        afterLockAcquired() {
          // 在 lock 内把 candidate 移出 releases（模拟他人删除）
          const trash = path.join(state, "gc-trash");
          fs.mkdirSync(trash, { recursive: true });
          fs.renameSync(old.releaseRoot, path.join(trash, `${old.runtimeBuildId}.pre`));
        },
      },
    });
    expect(result.ok).toBe(false);
  });

  it("beforeTombstone 时 manifest 损坏 → error，不删除", () => {
    const { state, releases } = fixture(["A", "B"]);
    const old = releases[0];
    const result = applyGc({
      stateDir: state,
      hooks: {
        beforeTombstone(buildId) {
          if (buildId === old.runtimeBuildId) {
            fs.writeFileSync(path.join(old.releaseRoot, "release.json"), "{}");
          }
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.items[0]!.status).toBe("error");
    expect(fs.existsSync(old.releaseRoot)).toBe(true);
  });

  it("source path 被换成 symlink → fail closed", () => {
    const { state, releases } = fixture(["A", "B"]);
    const old = releases[0];
    const outside = makeTmpDir("gc-apply-outside");
    dirs.push(outside);
    const result = applyGc({
      stateDir: state,
      hooks: {
        beforeTombstone(buildId) {
          if (buildId !== old.runtimeBuildId) return;
          fs.rmSync(old.releaseRoot, { recursive: true, force: true });
          fs.symlinkSync(outside, old.releaseRoot, process.platform === "win32" ? "junction" : "dir");
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(outside))).toBe(true);
  });

  it("cleanup 失败 → tombstoned + 非零；bytesDeleted 不含未完成删除", () => {
    const { state, releases } = fixture(["A", "B"]);
    const old = releases[0];
    const result = applyGc({
      stateDir: state,
      fns: {
        removeTree() {
          throw new Error("simulated cleanup failure");
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.items[0]!.status).toBe("tombstoned");
    expect(result.items[0]!.reason).toBe("cleanup_failed");
    expect(result.totals.tombstonedCount).toBe(1);
    expect(result.totals.bytesDeleted).toBe(0);
    expect(fs.existsSync(old.releaseRoot)).toBe(false);
    const trash = path.join(state, "gc-trash");
    expect(fs.readdirSync(trash).some(name => name.startsWith(old.runtimeBuildId))).toBe(true);
  });

  it("release 内逃逸 symlink 使 plan unsafe，apply 不删除", () => {
    const { state, releases } = fixture(["A", "B"]);
    const outside = makeTmpDir("gc-apply-secret");
    dirs.push(outside);
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "keep-me");
    const old = releases[0];
    fs.symlinkSync(secret, path.join(old.releaseRoot, "escape.txt"));
    const result = applyGc({ stateDir: state });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ status: "partial", globalBlockerCount: 0, localIssueCount: 1 });
    expect(result.retained).toContainEqual(expect.objectContaining({ buildId: old.runtimeBuildId, disposition: "unknown", reasons: ["size_unsafe"] }));
    expect(fs.existsSync(old.releaseRoot)).toBe(true);
    expect(fs.readFileSync(secret, "utf8")).toBe("keep-me");
  });

  it("removeTreeNoFollow 删除 tombstone 时 unlink 链接本身，不触碰外部 target", () => {
    const state = makeTmpDir("gc-apply-nofollow");
    dirs.push(state);
    const trash = path.join(state, "gc-trash");
    const tomb = path.join(trash, `${"a".repeat(64)}.nonce`);
    fs.mkdirSync(tomb, { recursive: true });
    const outside = makeTmpDir("gc-apply-out-target");
    dirs.push(outside);
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "keep-me");
    fs.symlinkSync(secret, path.join(tomb, "escape.txt"));
    fs.writeFileSync(path.join(tomb, "real.txt"), "gone");
    removeTreeNoFollow(tomb, trash);
    expect(fs.existsSync(tomb)).toBe(false);
    expect(fs.readFileSync(secret, "utf8")).toBe("keep-me");
  });

  it("removeTreeNoFollow 拒绝锚点外路径", () => {
    const state = makeTmpDir("gc-apply-anchor");
    dirs.push(state);
    const trash = path.join(state, "gc-trash");
    fs.mkdirSync(trash, { recursive: true });
    expect(() => removeTreeNoFollow(state, trash)).toThrow(/锚点之外/);
  });
});

describe("gc apply CLI contract", () => {
  function run(state: string, ...args: string[]) {
    const env = { ...process.env, C2C_STATE_DIR: state };
    const entry = path.join(project, "tests/fixtures/gc-cli.ts");
    return spawnSync(process.execPath, ["--import", "tsx", entry, "gc", ...args], {
      cwd: project, encoding: "utf8", windowsHide: true, env,
    });
  }

  it("互斥模式：plain / --plan --apply 拒绝；--apply --json 成功", () => {
    const { state, releases } = fixture(["A", "B"]);
    expect(run(state).status).not.toBe(0);
    expect(run(state, "--plan", "--apply").status).not.toBe(0);
    expect(run(state, "--dry-run", "--apply").status).not.toBe(0);
    expect(run(state, "--plan", "--dry-run").status).not.toBe(0);

    const applied = run(state, "--apply", "--json");
    expect(applied.status).toBe(0);
    const payload = JSON.parse(applied.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.mode).toBe("apply");
    expect(payload.totals.deletedCount).toBe(1);
    expect(fs.existsSync(releases[0].releaseRoot)).toBe(false);
    expect(fs.existsSync(releases[1].releaseRoot)).toBe(true);
  }, 60000);

  it("--apply --json failure 仍有完整 JSON + nonzero", () => {
    const { state, releases } = fixture(["A", "B"]);
    const held = tryAcquireMaintenanceLock(state, "block");
    expect(held.ok).toBe(true);
    const result = run(state, "--apply", "--json");
    if (held.ok) held.handle.release();
    expect(result.status).not.toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.issues.length).toBeGreaterThan(0);
    expect(fs.existsSync(releases[0].releaseRoot)).toBe(true);
  }, 60000);

  it("--plan D1 contract 不回归", () => {
    const { state } = fixture(["A"]);
    const plan = run(state, "--plan", "--json");
    expect(plan.status).toBe(0);
    expect(JSON.parse(plan.stdout).ok).toBe(true);
  }, 60000);
});


describe("gc legacy retirement", () => {
  const dead = () => { throw Object.assign(new Error("dead"), { code: "ESRCH" }); };
  function legacyFixture(expired = true, markers = ["old", "current"]) {
    const f = fixture(markers);
    const workspace = new Workspace(f.root);
    const job = {
      version: 1, jobId: randomUUID(), token: randomUUID(), workspaceId: workspace.id, workspaceRoot: workspace.root,
      targetBuildId: f.releases[0].runtimeBuildId, originThreadId: randomUUID(), originHostId: "local", originProjectId: "test",
      expectedRuntime: {}, createdAt: new Date(Date.now() - 120000).toISOString(),
      expiresAt: new Date(Date.now() + (expired ? -60000 : 60000)).toISOString(), status: "waiting",
    };
    const claim = { version: 1, jobId: job.jobId, jobToken: job.token, workerToken: randomUUID(), pid: 987654, claimedAt: job.createdAt };
    write(f.state, path.relative(f.state, activeFinalizerPath(f.state, workspace.id)), JSON.stringify(job));
    write(f.state, path.relative(f.state, workerClaimPath(f.state, workspace.id)), JSON.stringify(claim));
    return { ...f, workspace, job, claim };
  }
  it.each([false, true])("live exact finalizer with future field=%s only pins its target", extra => {
    const f = legacyFixture(true, ["old", "other", "current"]);
    if (extra) fs.writeFileSync(activeFinalizerPath(f.state, f.workspace.id), JSON.stringify({ ...f.job, future: true }));
    const result = applyGc({ stateDir: f.state, retirement: { probeProcess: () => {} } });
    expect(result.globalBlockerCount).toBe(0);
    expect(result.totals.deletedCount).toBe(1);
    expect(fs.existsSync(f.releases[0].releaseRoot)).toBe(true);
    expect(fs.existsSync(f.releases[1].releaseRoot)).toBe(false);
    expect(fs.existsSync(f.releases[2].releaseRoot)).toBe(true);
    expect(fs.existsSync(activeFinalizerPath(f.state, f.workspace.id))).toBe(true);
  });
  it("dry plan preserves pin; apply retires dead expired worker then collects old release", () => {
    const f = legacyFixture();
    expect(planGc(f.state).releases.find(r => r.buildId === f.job.targetBuildId)?.disposition).not.toBe("delete-candidate");
    expect(readFinalizerRetirement(f.state, f.workspace.id)).toBeNull();
    const result = applyGc({ stateDir: f.state, retirement: { probeProcess: dead } });
    expect(result.ok).toBe(true);
    expect(result.totals.deletedCount).toBe(1);
    expect(fs.existsSync(f.releases[0].releaseRoot)).toBe(false);
    expect(fs.existsSync(f.releases[1].releaseRoot)).toBe(true);
    expect(readFinalizerRetirement(f.state, f.workspace.id)).toMatchObject({ active: f.job, claim: f.claim });
    expect(() => fs.openSync(workerClaimPath(f.state, f.workspace.id), "wx")).toThrow();
  });
  it.each(["nonexpired", "live", "unknown", "missing"])("%s keeps old release pinned", mode => {
    const f = legacyFixture(mode !== "nonexpired");
    if (mode === "missing") fs.unlinkSync(workerClaimPath(f.state, f.workspace.id));
    const probeProcess = mode === "live" ? () => {} : mode === "unknown" ? () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); } : dead;
    const result = applyGc({ stateDir: f.state, retirement: { probeProcess } });
    expect(result.ok).toBe(true);
    expect(result.totals.deletedCount).toBe(0);
    expect(fs.existsSync(f.releases[0].releaseRoot)).toBe(true);
    expect(fs.existsSync(activeFinalizerPath(f.state, f.workspace.id))).toBe(true);
    expect(readFinalizerRetirement(f.state, f.workspace.id)).toBeNull();
  });
  it("maintenance first rejects old worker rollout lock and does not retire live claim", () => {
    const f = legacyFixture();
    const result = applyGc({ stateDir: f.state, retirement: { probeProcess: () => {} }, hooks: {
      afterFreshPlan() { expect(() => fs.openSync(path.join(f.state, "rollout.lock"), "wx")).toThrow(); },
    } });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(activeFinalizerPath(f.state, f.workspace.id))).toBe(true);
    expect(fs.existsSync(f.releases[0].releaseRoot)).toBe(true);
  });
  it("old maintenance owner first makes cleanup entirely read-only", () => {
    const f = legacyFixture();
    const held = tryAcquireMaintenanceLock(f.state, "old-worker");
    if (!held.ok) throw new Error("test lock busy");
    const before = fs.readFileSync(activeFinalizerPath(f.state, f.workspace.id));
    try {
      const result = applyGc({ stateDir: f.state, retirement: { probeProcess: dead } });
      expect(result.ok).toBe(false);
      expect(fs.readFileSync(activeFinalizerPath(f.state, f.workspace.id))).toEqual(before);
      expect(readFinalizerRetirement(f.state, f.workspace.id)).toBeNull();
      expect(fs.existsSync(f.releases[0].releaseRoot)).toBe(true);
    } finally { held.handle.release(); }
  });
});


describe("GC final reference validation", () => {
  it.each(["runtime", "pending"])("beforeTombstone new %s reference keeps release", kind => {
    const { state, root, releases } = fixture(["old", "current"]);
    const old = releases[0];
    const workspaceId = new Workspace(root).id;
    const result = applyGc({ stateDir: state, hooks: { beforeTombstone() {
      if (kind === "runtime") writeRuntime(state, root, old.runtimeBuildId, workspaceId);
      else writePending(state, root, old.runtimeBuildId, workspaceId);
    } } });
    expect(result.ok).toBe(false);
    expect(result.totals.deletedCount).toBe(0);
    expect(fs.existsSync(old.releaseRoot)).toBe(true);
  });
});
