import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getStateDir } from "../config/paths.js";
import { planGc, validateReleaseManifest, type GcPlan, type ReleasePlanItem } from "./gc-plan.js";
import {
  listBridgeStartLocks,
  assertMaintenanceHandle,
  tryAcquireMaintenanceLock,
  type MaintenanceLockHandle,
} from "./maintenance-lock.js";
import { retireLegacyFinalizers, type FinalizerRetirementOptions } from "./post-turn-finalizer.js";
import { releaseRolloutFence, tryAcquireRolloutFence } from "./rollout-fence.js";
import { readReleaseReferenceJson, type ReleaseReferenceIssue } from "./release-references.js";

export type GcApplyItemStatus = "deleted" | "tombstoned" | "skipped" | "error";

export interface GcApplyItem {
  buildId: string;
  status: GcApplyItemStatus;
  logicalBytes: number;
  reason: string;
}

export interface GcApplyResult {
  ok: boolean;
  status: "success" | "partial" | "blocked";
  globalBlockerCount: number;
  localIssueCount: number;
  issueDetails: ReleaseReferenceIssue[];
  retained: ReleasePlanItem[];
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
  retirement?: FinalizerRetirementOptions;
  hooks?: GcApplyHooks;
  fns?: GcApplyFns;
  stateDir?: string;
}

function emptyResult(stateDir: string): GcApplyResult {
  return {
    ok: false,
    status: "blocked",
    globalBlockerCount: 0,
    localIssueCount: 0,
    issueDetails: [],
    retained: [],
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
  result.status = "blocked";
  result.globalBlockerCount = Math.max(1, result.globalBlockerCount);
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

function notePlan(result: GcApplyResult, plan: GcPlan): void {
  for (const detail of plan.issueDetails) {
    if (!result.issueDetails.some(existing => JSON.stringify(existing) === JSON.stringify(detail))) {
      result.issueDetails.push(detail);
      result.issues.push(`${detail.source}: ${detail.message}`);
    }
  }
  result.globalBlockerCount = result.issueDetails.filter(issue => issue.scope.kind === "global").length;
  result.localIssueCount = result.issueDetails.length - result.globalBlockerCount;
  result.retained = plan.releases.filter(item => item.disposition !== "delete-candidate");
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
 * initial plan → maintenance → rollout fence → start check → fresh intersection →
 * strict retirement → per-item global/reference recheck → tombstone → no-follow delete.
 */
export function applyGc(options: GcApplyOptions = {}): GcApplyResult {
  const stateDir = path.resolve(options.stateDir ?? getStateDir());
  const result = emptyResult(stateDir);
  const hooks = options.hooks ?? {};
  const renameSync = options.fns?.renameSync ?? fs.renameSync.bind(fs);
  const removeTree = options.fns?.removeTree ?? ((root: string) => removeTreeNoFollow(root, path.join(stateDir, "gc-trash")));

  const initial = planGc(stateDir);
  notePlan(result, initial);
  hooks.afterInitialPlan?.(initial);
  if (initial.globalBlockerCount) {
    return fail(result, "initial_plan_unsafe: GC plan 存在 global blocker，拒绝 apply", initial.releases
      .filter((item) => item.disposition === "delete-candidate" || item.disposition === "unknown")
      .map((item) => skippedItem(item, "initial_plan_unsafe")));
  }

  const initialCandidates = candidateBuildIds(initial);
  let lock: ReturnType<typeof tryAcquireMaintenanceLock>;
  try { lock = tryAcquireMaintenanceLock(stateDir, "gc-apply"); }
  catch { return fail(result, "maintenance_unavailable: maintenance authority 无法确认"); }
  if (!lock.ok) {
    return fail(result, "maintenance_busy: 无法取得 machine maintenance lock");
  }
  const handle: MaintenanceLockHandle = lock.handle;
  const items: GcApplyItem[] = [];
  let rolloutFence: { ok: true; handle: import("./rollout-fence.js").RolloutFenceHandle } | { ok: false } | null = null;
  try {
    hooks.afterLockAcquired?.();

    // 固定顺序：maintenance → 原子持有 rollout.lock。覆盖整个 destructive critical section。
    rolloutFence = tryAcquireRolloutFence(stateDir);
    if (!rolloutFence.ok) {
      return fail(result, "legacy_rollout_lock: 无法取得 rollout.lock，拒绝与 rollout 并发");
    }
    const fenceHandle = rolloutFence.handle;
    const fenceStat = fs.lstatSync(fenceHandle.path);
    const fenceContents = JSON.stringify(readReleaseReferenceJson(fenceHandle.path));
    const checkFences = (): void => {
      assertMaintenanceHandle(stateDir, handle);
      const stat = fs.lstatSync(fenceHandle.path);
      if (stat.dev !== fenceStat.dev || stat.ino !== fenceStat.ino ||
          JSON.stringify(readReleaseReferenceJson(fenceHandle.path)) !== fenceContents) throw new Error("rollout_fence_owner_lost");
      if (listBridgeStartLocks(stateDir).length) throw new Error("bridge_start_in_progress");
    };

    // bridge start 关键区间：start.lock 存在则 abort，避免 spawn 窗口内误判 unreferenced。
    const startLocks = listBridgeStartLocks(stateDir);
    if (startLocks.length > 0) {
      return fail(result, `bridge_start_in_progress: ${startLocks.join(", ")}`);
    }

    const fresh = planGc(stateDir);
    notePlan(result, fresh);
    hooks.afterFreshPlan?.(fresh);
    if (fresh.globalBlockerCount) {
      return fail(result, "fresh_plan_unsafe: lock 内 plan 不安全，拒绝 apply", fresh.releases
        .filter((item) => item.disposition === "delete-candidate" || item.disposition === "unknown")
        .map((item) => skippedItem(item, "fresh_plan_unsafe")));
    }

    const freshCandidates = candidateBuildIds(fresh);
    for (const buildId of initialCandidates.filter(id => !freshCandidates.includes(id))) {
      items.push(skippedItem(initial.releases.find(item => item.buildId === buildId)!, "candidate_reference_changed"));
    }

    checkFences();
    // A forward-format exact pin is safe to retain, never safe to retire with the old protocol.
    let retired: ReturnType<typeof retireLegacyFinalizers> = [];
    if (!fresh.issueDetails.some(issue => issue.code === "finalizer_corrupt")) {
      try { retired = retireLegacyFinalizers(stateDir, handle, options.retirement); }
      catch { return fail(result, "finalizer_retirement_failed: strict retirement proof unavailable", items); }
    }
    const afterRetirement = planGc(stateDir);
    notePlan(result, afterRetirement);
    if (afterRetirement.globalBlockerCount) return fail(result, "retirement_plan_unsafe", items);
    const afterCandidates = candidateBuildIds(afterRetirement);
    const allowed = new Set(initialCandidates.filter(id => freshCandidates.includes(id)));
    for (const job of retired) {
      // Only an exact pin present in BOTH snapshots may become eligible in this run.
      if ([initial, fresh].every(plan => plan.releases.some(item => item.buildId === job.targetBuildId &&
          item.disposition === "keep" && item.reasons.includes(`finalizer:${job.workspaceId}`)))) allowed.add(job.targetBuildId);
    }
    for (const buildId of allowed) {
      if (!afterCandidates.includes(buildId)) items.push(skippedItem(fresh.releases.find(item => item.buildId === buildId)!, "candidate_reference_changed"));
    }

    for (const buildId of afterCandidates) {
      const item = afterRetirement.releases.find((entry) => entry.buildId === buildId)!;
      if (!allowed.has(buildId)) {
        if (!items.some(entry => entry.buildId === buildId)) items.push(skippedItem(item, "new_candidate_not_deleted"));
        continue;
      }
      try {
        hooks.beforeTombstone?.(buildId);
        checkFences();
      } catch {
        return fail(result, "mutation_fence_unsafe", [...items, ...afterCandidates
          .filter(id => !items.some(entry => entry.buildId === id))
          .map(id => skippedItem(afterRetirement.releases.find(entry => entry.buildId === id)!, "mutation_fence_unsafe"))]);
      }
      // Unscoped uncertainty halts further mutations; a local failure only skips its build.
      const current = planGc(stateDir);
      notePlan(result, current);
      if (current.globalBlockerCount) return fail(result, "mutation_plan_unsafe", [...items, ...afterCandidates
        .filter(id => !items.some(entry => entry.buildId === id))
        .map(id => skippedItem(afterRetirement.releases.find(entry => entry.buildId === id)!, "mutation_plan_unsafe"))]);
      // Planning may traverse a large tree; recheck ownership after that read window.
      try { checkFences(); }
      catch { return fail(result, "mutation_fence_unsafe", [...items, ...afterCandidates
        .filter(id => !items.some(entry => entry.buildId === id))
        .map(id => skippedItem(afterRetirement.releases.find(entry => entry.buildId === id)!, "mutation_fence_unsafe"))]); }
      try {
        if (!candidateBuildIds(current).includes(buildId)) throw new Error("candidate_reference_changed");
        revalidateCandidate(stateDir, item);
        const trash = ensureTrashDir(stateDir);
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
      if (item.status === "skipped") result.issues.push(`${item.buildId}: ${item.reason}`);
    }
    result.ok = result.issues.length === 0;
    result.status = result.ok ? "success" : "partial";
    return result;
  } catch {
    return fail(result, "gc_authority_unavailable", items);
  } finally {
    if (rolloutFence?.ok) {
      const report = releaseRolloutFence(rolloutFence.handle);
      if (!report.rolloutReleased) {
        result.ok = false;
        result.status = "blocked";
        result.globalBlockerCount += 1;
        result.issues.push(report.issues[0] ?? "rollout_fence_release_failed: rollout.lock 未能安全释放，需人工核对");
      }
    }
    if (!handle.release()) {
      result.ok = false;
      result.status = "blocked";
      result.globalBlockerCount += 1;
      result.issues.push("maintenance_release_failed: lock 无法证明已安全释放，需人工核对 maintenance.lock");
    }
  }
}
