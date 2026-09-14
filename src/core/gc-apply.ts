import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getStateDir } from "../config/paths.js";
import { planGc, validateReleaseManifest, type GcPlan, type ReleasePlanItem } from "./gc-plan.js";
import {
  legacyRolloutLockPath,
  listBridgeStartLocks,
  tryAcquireMaintenanceLock,
  type MaintenanceLockHandle,
} from "./maintenance-lock.js";
import { releaseRolloutFence, tryAcquireRolloutFence } from "./rollout-fence.js";

export type GcApplyItemStatus = "deleted" | "tombstoned" | "skipped" | "error";

export interface GcApplyItem {
  buildId: string;
  status: GcApplyItemStatus;
  logicalBytes: number;
  reason: string;
}

export interface GcApplyResult {
  ok: boolean;
  stateDir: string;
  mode: "apply";
  items: GcApplyItem[];
  issues: string[];
  totals: {
    candidateCount: number;
    deletedCount: number;
    tombstonedCount: number;
    skippedCount: number;
    bytesDeleted: number;
  };
}

/** 测试专用阶段钩子；生产默认不提供。 */
export interface GcApplyHooks {
  afterInitialPlan?: (plan: GcPlan) => void;
  afterLockAcquired?: () => void;
  afterFreshPlan?: (plan: GcPlan) => void;
  beforeTombstone?: (buildId: string) => void;
  afterTombstone?: (buildId: string, trashPath: string) => void;
  beforeDelete?: (buildId: string, trashPath: string) => void;
}

/** 测试可注入 destructive primitive；生产使用默认实现。 */
export interface GcApplyFns {
  renameSync?: (from: string, to: string) => void;
  removeTree?: (root: string) => void;
}

export interface GcApplyOptions {
  hooks?: GcApplyHooks;
  fns?: GcApplyFns;
  stateDir?: string;
}

function emptyResult(stateDir: string): GcApplyResult {
  return {
    ok: false,
    stateDir,
    mode: "apply",
    items: [],
    issues: [],
    totals: {
      candidateCount: 0,
      deletedCount: 0,
      tombstonedCount: 0,
      skippedCount: 0,
      bytesDeleted: 0,
    },
  };
}

function fail(result: GcApplyResult, issue: string, items: GcApplyItem[] = []): GcApplyResult {
  result.issues.push(issue);
  result.items = items;
  result.totals.candidateCount = items.length;
  result.totals.deletedCount = items.filter((item) => item.status === "deleted").length;
  result.totals.tombstonedCount = items.filter((item) => item.status === "tombstoned").length;
  result.totals.skippedCount = items.filter((item) => item.status === "skipped").length;
  result.totals.bytesDeleted = items.filter((item) => item.status === "deleted").reduce((n, item) => n + item.logicalBytes, 0);
  result.ok = false;
  return result;
}

function candidateBuildIds(plan: GcPlan): string[] {
  return plan.releases.filter((item) => item.disposition === "delete-candidate").map((item) => item.buildId).sort();
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function ensureCanonicalDir(dir: string): void {
  const lstat = fs.lstatSync(dir);
  if (!lstat.isDirectory() || lstat.isSymbolicLink()) throw new Error("目标必须是真实目录");
  if (fs.realpathSync(dir) !== dir) throw new Error("目标必须是 canonical 路径");
}

/** 显式 no-follow 删除；只允许删除 gc-trash 下的 tombstone。 */
export function removeTreeNoFollow(root: string, trashAnchor: string): void {
  const anchor = path.resolve(trashAnchor);
  const target = path.resolve(root);
  if (target === anchor || !target.startsWith(anchor + path.sep)) {
    throw new Error("拒绝删除 gc-trash 锚点之外的路径");
  }
  ensureCanonicalDir(anchor);
  const lstat = fs.lstatSync(target);
  if (lstat.isSymbolicLink()) {
    fs.unlinkSync(target);
    return;
  }
  if (!lstat.isDirectory()) {
    fs.unlinkSync(target);
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    if (entry.isSymbolicLink()) {
      fs.unlinkSync(child);
      continue;
    }
    if (entry.isDirectory()) {
      removeTreeNoFollow(child, anchor);
      continue;
    }
    fs.unlinkSync(child);
  }
  fs.rmdirSync(target);
}

function ensureTrashDir(stateDir: string): string {
  const trash = path.join(path.resolve(stateDir), "gc-trash");
  fs.mkdirSync(trash, { recursive: true, mode: 0o700 });
  ensureCanonicalDir(trash);
  return trash;
}

function revalidateCandidate(stateDir: string, item: ReleasePlanItem): void {
  if (item.disposition !== "delete-candidate") throw new Error("disposition 不是 delete-candidate");
  const source = path.join(path.resolve(stateDir), "releases", item.buildId);
  if (source !== item.path) throw new Error("candidate path 与 canonical releases 路径不一致");
  if (!/^[a-f0-9]{64}$/.test(item.buildId)) throw new Error("buildId 非 canonical");
  const lstat = fs.lstatSync(source);
  if (!lstat.isDirectory() || lstat.isSymbolicLink()) throw new Error("release 根不是真实目录");
  if (fs.realpathSync(source) !== source) throw new Error("release 根不是 canonical");
  const manifest = validateReleaseManifest(source, item.buildId);
  if (!manifest.ok) throw new Error(manifest.message);
}

function skippedItem(item: ReleasePlanItem, reason: string): GcApplyItem {
  return { buildId: item.buildId, status: "skipped", logicalBytes: item.logicalBytes, reason };
}

/**
 * 安全 apply：绝不信任旧 plan。
 * initial plan → lock → fresh plan → candidate set 相等 → 逐项再验证 → tombstone → no-follow delete。
 */
export function applyGc(options: GcApplyOptions = {}): GcApplyResult {
  const stateDir = path.resolve(options.stateDir ?? getStateDir());
  const result = emptyResult(stateDir);
  const hooks = options.hooks ?? {};
  const renameSync = options.fns?.renameSync ?? fs.renameSync.bind(fs);
  const removeTree = options.fns?.removeTree ?? ((root: string) => removeTreeNoFollow(root, path.join(stateDir, "gc-trash")));

  const initial = planGc(stateDir);
  hooks.afterInitialPlan?.(initial);
  if (!initial.ok) {
    return fail(result, "initial_plan_unsafe: GC plan 存在 unknown/issue，拒绝 apply", initial.releases
      .filter((item) => item.disposition === "delete-candidate" || item.disposition === "unknown")
      .map((item) => skippedItem(item, "initial_plan_unsafe")));
  }

  const initialCandidates = candidateBuildIds(initial);
  const lock = tryAcquireMaintenanceLock(stateDir, "gc-apply");
  if (!lock.ok) {
    return fail(result, "maintenance_busy: 无法取得 machine maintenance lock");
  }
  const handle: MaintenanceLockHandle = lock.handle;
  let rolloutFence: { ok: true; handle: import("./rollout-fence.js").RolloutFenceHandle } | { ok: false } | null = null;
  try {
    hooks.afterLockAcquired?.();

    // 固定顺序：maintenance → 原子持有 rollout.lock。覆盖整个 destructive critical section。
    rolloutFence = tryAcquireRolloutFence(stateDir);
    if (!rolloutFence.ok) {
      return fail(result, "legacy_rollout_lock: 无法取得 rollout.lock，拒绝与 rollout 并发");
    }

    // bridge start 关键区间：start.lock 存在则 abort，避免 spawn 窗口内误判 unreferenced。
    const startLocks = listBridgeStartLocks(stateDir);
    if (startLocks.length > 0) {
      return fail(result, `bridge_start_in_progress: ${startLocks.join(", ")}`);
    }

    const fresh = planGc(stateDir);
    hooks.afterFreshPlan?.(fresh);
    if (!fresh.ok) {
      return fail(result, "fresh_plan_unsafe: lock 内 plan 不安全，拒绝 apply", fresh.releases
        .filter((item) => item.disposition === "delete-candidate" || item.disposition === "unknown")
        .map((item) => skippedItem(item, "fresh_plan_unsafe")));
    }

    const freshCandidates = candidateBuildIds(fresh);
    if (!sameStringSet(initialCandidates, freshCandidates)) {
      return fail(result, "stale_candidates: initial 与 fresh candidate set 不一致，整轮 abort", [
        ...initialCandidates.map((buildId) => ({ buildId, status: "skipped" as const, logicalBytes: 0, reason: "stale_candidates" })),
        ...freshCandidates.filter((id) => !initialCandidates.includes(id)).map((buildId) => ({
          buildId, status: "skipped" as const, logicalBytes: 0, reason: "new_candidate_not_deleted",
        })),
      ]);
    }

    const items: GcApplyItem[] = [];
    const trash = ensureTrashDir(stateDir);
    for (const buildId of freshCandidates) {
      const item = fresh.releases.find((entry) => entry.buildId === buildId)!;
      try {
        hooks.beforeTombstone?.(buildId);
        // hook 可能破坏 manifest/path：再校验必须在 mutation 之前。
        revalidateCandidate(stateDir, item);
        const nonce = randomUUID();
        const dest = path.join(trash, `${buildId}.${nonce}`);
        renameSync(item.path, dest);
        hooks.afterTombstone?.(buildId, dest);
        hooks.beforeDelete?.(buildId, dest);
        try {
          removeTree(dest);
          items.push({ buildId, status: "deleted", logicalBytes: item.logicalBytes, reason: "reclaimed" });
        } catch {
          // rename 已离开 active namespace；不 rollback，明确报告 tombstoned。
          items.push({ buildId, status: "tombstoned", logicalBytes: item.logicalBytes, reason: "cleanup_failed" });
        }
      } catch (error) {
        items.push({
          buildId,
          status: "error",
          logicalBytes: item.logicalBytes,
          reason: error instanceof Error ? error.message : "candidate_revalidation_failed",
        });
      }
    }

    result.items = items;
    result.totals.candidateCount = items.length;
    result.totals.deletedCount = items.filter((item) => item.status === "deleted").length;
    result.totals.tombstonedCount = items.filter((item) => item.status === "tombstoned").length;
    result.totals.skippedCount = items.filter((item) => item.status === "skipped").length;
    result.totals.bytesDeleted = items.filter((item) => item.status === "deleted").reduce((n, item) => n + item.logicalBytes, 0);
    for (const item of items) {
      if (item.status === "tombstoned") result.issues.push(`${item.buildId}: tombstone cleanup_failed`);
      if (item.status === "error") result.issues.push(`${item.buildId}: ${item.reason}`);
    }
    result.ok = result.issues.length === 0;
    return result;
  } finally {
    if (rolloutFence?.ok) {
      const report = releaseRolloutFence(rolloutFence.handle);
      if (!report.rolloutReleased) {
        result.ok = false;
        result.issues.push(report.issues[0] ?? "rollout_fence_release_failed: rollout.lock 未能安全释放，需人工核对");
      }
    }
    if (!handle.release()) {
      result.ok = false;
      result.issues.push("maintenance_release_failed: lock 无法证明已安全释放，需人工核对 maintenance.lock");
    }
  }
}
