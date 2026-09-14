import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "../config/paths.js";
import { isRuntimeBuildId } from "../build-id.js";
import {
  collectReleaseReferences,
  formatReferenceIssue,
  markDanglingReferences,
  RELEASE_BOOTSTRAP_KEYS,
  type ReleaseReferenceIssue,
  type ReleaseReferenceIssueCode,
  type ReleaseReferenceGraph,
} from "./release-references.js";

export type ReleaseDisposition = "keep" | "delete-candidate" | "unknown";

export interface ReleasePlanItem {
  buildId: string;
  path: string;
  disposition: ReleaseDisposition;
  /** 稳定机器可读原因，例如 current / runtime:<ws> / corrupt_manifest / global_unknown_reference */
  reasons: string[];
  logicalBytes: number;
}

export interface GcPlanTotals {
  releaseCount: number;
  bytesKept: number;
  bytesCandidateReclaimable: number;
  issueCount: number;
  unknownReleaseCount: number;
}

export interface GcPlan {
  ok: boolean;
  stateDir: string;
  releases: ReleasePlanItem[];
  issues: string[];
  totals: GcPlanTotals;
}

const HEX64 = /^[a-f0-9]{64}$/;
const BOOTSTRAP_KEY_SET = new Set<string>(RELEASE_BOOTSTRAP_KEYS);

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * 逻辑大小：安全锚点永远是整个 releaseRoot。
 * - 普通文件：计 stat 大小
 * - symlink/junction：目标必须仍在 releaseRoot 内；只计 link 自身字节，不跟随、不重复 target
 * - 目录：用同一 releaseRoot 递归；visited realpath 防环
 */
export function releaseLogicalSize(releaseRoot: string): number {
  const anchor = path.resolve(releaseRoot);
  if (!fs.lstatSync(anchor).isDirectory() || fs.lstatSync(anchor).isSymbolicLink()) {
    throw new Error("release 根必须是真实目录");
  }
  if (fs.realpathSync(anchor) !== anchor) throw new Error("release 根不是 canonical 路径");
  const visited = new Set<string>([fs.realpathSync(anchor)]);
  let total = 0;

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = fs.realpathSync(file);
        } catch {
          throw new Error("release 含无法解析的链接");
        }
        if (!isInside(anchor, target)) throw new Error("release 链接越过安装边界");
        total += fs.lstatSync(file).size;
        continue;
      }
      if (entry.isDirectory()) {
        const real = fs.realpathSync(file);
        if (!isInside(anchor, real)) throw new Error("release 子目录越过安装边界");
        if (visited.has(real)) continue;
        visited.add(real);
        walk(file);
        continue;
      }
      if (entry.isFile()) {
        total += fs.statSync(file).size;
        continue;
      }
      throw new Error("release 含未知文件类型");
    }
  };

  walk(anchor);
  return total;
}

/** 严格只读 release.json 结构校验；坏 manifest = unknown，绝不猜。 */
export function validateReleaseManifest(releaseRoot: string, directoryBuildId: string): { ok: true } | { ok: false; message: string } {
  if (!HEX64.test(directoryBuildId)) return { ok: false, message: "目录名不是 canonical runtimeBuildId" };
  const file = path.join(releaseRoot, "release.json");
  let raw: string;
  try {
    if (fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isFile()) {
      return { ok: false, message: "release.json 不是普通文件" };
    }
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { ok: false, message: "release.json 缺失或无法读取" };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch {
    return { ok: false, message: "release.json 不是有效 JSON" };
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, message: "release.json 不是对象" };
  }
  const value = manifest as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(",");
  if (value.version === 1) {
    if (keys !== "artifactSha256,runtimeBuildId,version") return { ok: false, message: "manifest v1 字段不严格" };
    if (value.runtimeBuildId !== directoryBuildId) return { ok: false, message: "manifest runtimeBuildId 与目录不一致" };
    if (typeof value.artifactSha256 !== "string" || !HEX64.test(value.artifactSha256)) return { ok: false, message: "manifest artifactSha256 无效" };
    return { ok: true };
  }
  if (value.version === 2) {
    if (keys !== "artifactSha256,bootstrap,runtimeBuildId,version") return { ok: false, message: "manifest v2 字段不严格" };
    if (value.runtimeBuildId !== directoryBuildId) return { ok: false, message: "manifest runtimeBuildId 与目录不一致" };
    if (typeof value.artifactSha256 !== "string" || !HEX64.test(value.artifactSha256)) return { ok: false, message: "manifest artifactSha256 无效" };
    const bootstrap = value.bootstrap;
    if (!bootstrap || typeof bootstrap !== "object" || Array.isArray(bootstrap)) return { ok: false, message: "manifest bootstrap 无效" };
    const bootstrapKeys = Object.keys(bootstrap as object).sort();
    if (bootstrapKeys.join(",") !== [...BOOTSTRAP_KEY_SET].sort().join(",")) {
      return { ok: false, message: "manifest bootstrap 键集不匹配" };
    }
    for (const name of BOOTSTRAP_KEY_SET) {
      const digest = (bootstrap as Record<string, unknown>)[name];
      if (typeof digest !== "string" || !HEX64.test(digest)) return { ok: false, message: `manifest bootstrap 摘要无效：${name}` };
    }
    return { ok: true };
  }
  return { ok: false, message: "不支持的 manifest version" };
}

function reasonTags(refs: ReadonlyArray<{ kind: string; source: string; workspaceId?: string }>): string[] {
  return refs.map((ref) => {
    if (ref.kind === "current") return "current";
    if (ref.kind === "runtime") return `runtime:${ref.workspaceId}`;
    if (ref.kind === "runtime-upgrade") return `pending:${ref.workspaceId}`;
    if (ref.kind === "finalizer") return `finalizer:${ref.workspaceId}`;
    return ref.source;
  }).sort();
}

function scanReleases(releaseDir: string, graph: ReleaseReferenceGraph): {
  items: ReleasePlanItem[];
  presentBuildIds: Set<string>;
  localIssues: ReleaseReferenceIssue[];
} {
  const items: ReleasePlanItem[] = [];
  const presentBuildIds = new Set<string>();
  const localIssues: ReleaseReferenceIssue[] = [];

  let names: string[];
  try {
    names = fs.readdirSync(releaseDir).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { items, presentBuildIds, localIssues };
    }
    throw error;
  }

  for (const name of names) {
    const itemPath = path.join(releaseDir, name);
    const reasons: string[] = [];
    let disposition: ReleaseDisposition = "unknown";
    let logicalBytes = 0;
    let localError: string | null = null;
    let code: ReleaseReferenceIssueCode = "noncanonical_entry";

    try {
      if (!HEX64.test(name)) {
        localError = "目录名不是 canonical runtimeBuildId";
        code = "noncanonical_entry";
      } else {
        const lstat = fs.lstatSync(itemPath);
        if (!lstat.isDirectory() || lstat.isSymbolicLink()) {
          localError = "release 根必须是真实目录，不能是 symlink/junction";
          code = "release_root_invalid";
        } else if (fs.realpathSync(itemPath) !== itemPath) {
          localError = "release 根不是 canonical 路径";
          code = "release_root_invalid";
        } else {
          presentBuildIds.add(name);
          const manifest = validateReleaseManifest(itemPath, name);
          if (!manifest.ok) {
            localError = manifest.message;
            code = manifest.message.includes("JSON") || manifest.message.includes("缺失") || manifest.message.includes("普通文件")
              ? "manifest_corrupt"
              : "manifest_mismatch";
          } else {
            logicalBytes = releaseLogicalSize(itemPath);
            disposition = "delete-candidate";
          }
        }
      }
    } catch (error) {
      localError = error instanceof Error ? error.message : "release 无法安全读取";
      code = localError.includes("链接") || localError.includes("未知文件")
        ? "size_unsafe"
        : "release_root_invalid";
    }

    if (localError) {
      localIssues.push({ code, source: `releases/${name}`, message: localError });
      items.push({ buildId: name, path: itemPath, disposition: "unknown", reasons: [code], logicalBytes });
      continue;
    }

    const refs = graph.references.get(name) ?? [];
    if (refs.length > 0) {
      disposition = "keep";
      reasons.push(...reasonTags(refs));
    }
    items.push({ buildId: name, path: itemPath, disposition, reasons: reasons.sort(), logicalBytes });
  }

  items.sort((a, b) => a.buildId.localeCompare(b.buildId));
  return { items, presentBuildIds, localIssues };
}

/**
 * 只读 GC plan。任何未知/损坏/悬空引用都 fail closed：
 * 原本 delete-candidate 一律降为 unknown，bytesCandidateReclaimable = 0。
 */
export function planGc(stateDir = getStateDir()): GcPlan {
  const root = path.resolve(stateDir);
  const graph = collectReleaseReferences(root);
  const releaseDir = path.join(root, "releases");
  const { items, presentBuildIds, localIssues } = scanReleases(releaseDir, graph);

  markDanglingReferences(graph, presentBuildIds);
  const allIssues: ReleaseReferenceIssue[] = [...graph.issues, ...localIssues];
  const issueMessages = allIssues.map(formatReferenceIssue);
  const blocked = issueMessages.length > 0;

  if (blocked) {
    for (const item of items) {
      if (item.disposition === "delete-candidate") {
        item.disposition = "unknown";
        item.reasons = [...item.reasons, "global_unknown_reference"].sort();
      }
    }
  }

  const totals: GcPlanTotals = {
    releaseCount: items.length,
    bytesKept: items.filter((item) => item.disposition === "keep").reduce((sum, item) => sum + item.logicalBytes, 0),
    bytesCandidateReclaimable: items
      .filter((item) => item.disposition === "delete-candidate")
      .reduce((sum, item) => sum + item.logicalBytes, 0),
    issueCount: issueMessages.length,
    unknownReleaseCount: items.filter((item) => item.disposition === "unknown").length,
  };

  return {
    ok: !blocked,
    stateDir: root,
    releases: items,
    issues: issueMessages,
    totals,
  };
}

/** doctor / CLI 摘要；不自动清理。 */
export function gcPlanSummary(plan: GcPlan): {
  ok: boolean;
  releaseCount: number;
  bytesTotal: number;
  bytesKept: number;
  bytesCandidateReclaimable: number;
  unknownReleaseCount: number;
  issueCount: number;
} {
  return {
    ok: plan.ok,
    releaseCount: plan.totals.releaseCount,
    bytesTotal: plan.releases.reduce((sum, item) => sum + item.logicalBytes, 0),
    bytesKept: plan.totals.bytesKept,
    bytesCandidateReclaimable: plan.totals.bytesCandidateReclaimable,
    unknownReleaseCount: plan.totals.unknownReleaseCount,
    issueCount: plan.totals.issueCount,
  };
}

export type { ReleaseReferenceGraph };
