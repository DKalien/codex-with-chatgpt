import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isRuntimeBuildId } from "../build-id.js";
import { readCurrentInstall } from "./install.js";
import { UPGRADE_REASONS } from "./upgrade.js";
import { activeFinalizerSchema } from "./post-turn-finalizer.js";
import { Workspace } from "../workspace/manager.js";

/** 与 scripts/core-release.cjs 的 BOOTSTRAP 固定清单一致；GC 只做结构校验，不重算内容摘要。 */
export const RELEASE_BOOTSTRAP_KEYS = [
  "bin/c2c.js",
  "package.json",
  "dist/build-id.txt",
  "dist/cli/index.js",
  "scripts/core-release.cjs",
  "scripts/core-launcher.cjs",
  "scripts/install-core.mjs",
  "dist/core-assets/core-release.cjs",
  "dist/core-assets/core-launcher.cjs",
  "dist/core-assets/install-core.mjs",
  "dist/core-assets/c2c-entry.js",
  "dist/core-assets/package.json",
  "dist/core-assets/dependencies-sha256.txt",
] as const;

const HEX64 = /^[a-f0-9]{64}$/;
const WORKSPACE_ID = /^[a-f0-9]{12}$/;

/**
 * 引用种类可扩展：本轮只注册 current / runtime / runtime-upgrade，
 * D2/B 可加入 install/rollout/finalizer 而不改 graph 消费方契约。
 */
export type ReleaseReferenceKind = "current" | "runtime" | "runtime-upgrade" | "finalizer";

export interface ReleaseReference {
  kind: ReleaseReferenceKind;
  buildId: string;
  /** 稳定机器可读 source，例如 current / runtime:<workspaceId> / runtime-upgrade:<workspaceId> */
  source: string;
  workspaceId?: string;
}

export type ReleaseReferenceIssueCode =
  | "current_invalid"
  | "current_missing"
  | "runtime_corrupt"
  | "runtime_identity_mismatch"
  | "runtime_missing_build_id"
  | "pending_corrupt"
  | "pending_identity_mismatch"
  | "dangling_reference"
  | "noncanonical_entry"
  | "release_root_invalid"
  | "manifest_missing"
  | "manifest_corrupt"
  | "manifest_mismatch"
  | "size_unsafe"
  | "finalizer_corrupt";

export interface ReleaseReferenceIssue {
  code: ReleaseReferenceIssueCode;
  source: string;
  message: string;
}

export interface ReleaseReferenceGraph {
  stateDir: string;
  /** buildId → 引用列表（含悬空引用指向的 buildId） */
  references: Map<string, ReleaseReference[]>;
  referencedBuildIds: Set<string>;
  /** 问题对象；有任意 issue 时 ok=false，调用方必须 fail closed */
  issues: ReleaseReferenceIssue[];
  ok: boolean;
}

function issue(code: ReleaseReferenceIssueCode, source: string, message: string): ReleaseReferenceIssue {
  return { code, source, message };
}

const runtimeFileSchema = z.object({
  service: z.string().min(1),
  version: z.string().min(1),
  workspaceId: z.string().regex(WORKSPACE_ID),
  workspaceRoot: z.string().refine(path.isAbsolute),
  pid: z.number().int(),
  port: z.number().int().min(1).max(65535),
  adminToken: z.string().min(1),
  publicUrl: z.string().url().nullable(),
  startedAt: z.string().datetime(),
  runtimeBuildId: z.string().regex(HEX64),
}).strict();

const pendingFileSchema = z.object({
  workspaceId: z.string().regex(WORKSPACE_ID),
  workspaceRoot: z.string().refine(path.isAbsolute),
  targetBuildId: z.string().refine(isRuntimeBuildId),
  reason: z.enum(UPGRADE_REASONS),
  updatedAt: z.string().datetime(),
}).strict();

function addReference(graph: ReleaseReferenceGraph, reference: ReleaseReference): void {
  const list = graph.references.get(reference.buildId) ?? [];
  list.push(reference);
  graph.references.set(reference.buildId, list);
  graph.referencedBuildIds.add(reference.buildId);
}

function collectCurrent(stateDir: string, graph: ReleaseReferenceGraph): void {
  try {
    const current = readCurrentInstall(stateDir, "fast");
    if (!current) {
      // 空状态不是损坏；无 current 引用即可。doctor/install 流程负责首次安装。
      return;
    }
    if (!isRuntimeBuildId(current.runtimeBuildId)) {
      graph.issues.push(issue("current_invalid", "current", "current pointer runtimeBuildId 无效"));
      return;
    }
    addReference(graph, { kind: "current", buildId: current.runtimeBuildId, source: "current" });
  } catch (error) {
    graph.issues.push(issue("current_invalid", "current", error instanceof Error ? error.message : "current pointer 无法安全读取"));
  }
}

function listStateFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function collectRuntime(stateDir: string, graph: ReleaseReferenceGraph): void {
  const folder = path.join(stateDir, "runtime");
  for (const name of listStateFiles(folder)) {
    // Bridge start 的瞬时 fence 文件不是 runtime 状态；由 GC apply 单独检查。
    if (name.endsWith(".start.lock")) continue;
    const source = `runtime:${name}`;
    if (!/^[a-f0-9]{12}\.json$/.test(name)) {
      graph.issues.push(issue("runtime_corrupt", source, "runtime 状态文件名非 canonical workspaceId.json"));
      continue;
    }
    const workspaceId = name.slice(0, -5);
    try {
      const file = path.join(folder, name);
      const lstat = fs.lstatSync(file);
      if (!lstat.isFile() || lstat.isSymbolicLink() || fs.realpathSync(file) !== file) {
        graph.issues.push(issue("runtime_corrupt", source, "runtime 状态非 canonical regular file"));
        continue;
      }
      const parsed = runtimeFileSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
      if (parsed.workspaceId !== workspaceId) {
        graph.issues.push(issue("runtime_identity_mismatch", source, "runtime 文件名与 workspaceId 不一致"));
        continue;
      }
      if (new Workspace(parsed.workspaceRoot).id !== workspaceId) {
        graph.issues.push(issue("runtime_identity_mismatch", source, "workspaceRoot 与 workspaceId 不匹配"));
        continue;
      }
      addReference(graph, {
        kind: "runtime",
        buildId: parsed.runtimeBuildId,
        source: `runtime:${workspaceId}`,
        workspaceId,
      });
    } catch {
      graph.issues.push(issue("runtime_corrupt", source, "runtime 状态损坏、schema 无效或缺少 runtimeBuildId"));
    }
  }
}

function collectPending(stateDir: string, graph: ReleaseReferenceGraph): void {
  const folder = path.join(stateDir, "runtime-upgrades");
  for (const name of listStateFiles(folder)) {
    const source = `runtime-upgrade:${name}`;
    if (!/^[a-f0-9]{12}\.json$/.test(name)) {
      graph.issues.push(issue("pending_corrupt", source, "pending 状态文件名非 canonical workspaceId.json"));
      continue;
    }
    const workspaceId = name.slice(0, -5);
    try {
      const file = path.join(folder, name);
      const lstat = fs.lstatSync(file);
      if (!lstat.isFile() || lstat.isSymbolicLink() || fs.realpathSync(file) !== file) {
        graph.issues.push(issue("pending_corrupt", source, "pending 状态非 canonical regular file"));
        continue;
      }
      const parsed = pendingFileSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
      if (parsed.workspaceId !== workspaceId) {
        graph.issues.push(issue("pending_identity_mismatch", source, "pending 文件名与 workspaceId 不一致"));
        continue;
      }
      if (new Workspace(parsed.workspaceRoot).id !== workspaceId) {
        graph.issues.push(issue("pending_identity_mismatch", source, "workspaceRoot 与 workspaceId 不匹配"));
        continue;
      }
      addReference(graph, {
        kind: "runtime-upgrade",
        buildId: parsed.targetBuildId,
        source: `runtime-upgrade:${workspaceId}`,
        workspaceId,
      });
    } catch {
      graph.issues.push(issue("pending_corrupt", source, "pending 状态损坏或 schema 无效"));
    }
  }
}

function collectFinalizers(stateDir: string, graph: ReleaseReferenceGraph): void {
  const folder = path.join(stateDir, "post-turn-finalizers");
  let names: string[];
  try { names = fs.readdirSync(folder).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    graph.issues.push(issue("finalizer_corrupt", "post-turn-finalizers", "无法读取 finalizer 目录"));
    return;
  }
  for (const name of names) {
    const source = `finalizer:${name}`;
    if (!/^[a-f0-9]{12}\.json$/.test(name)) {
      graph.issues.push(issue("finalizer_corrupt", source, "finalizer 文件名非 canonical workspaceId.json"));
      continue;
    }
    const workspaceId = name.slice(0, -5);
    try {
      const file = path.join(folder, name);
      const lstat = fs.lstatSync(file);
      if (!lstat.isFile() || lstat.isSymbolicLink() || fs.realpathSync(file) !== file) {
        graph.issues.push(issue("finalizer_corrupt", source, "active finalizer 非 canonical regular file"));
        continue;
      }
      const raw = activeFinalizerSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
      if (raw.workspaceId !== workspaceId) {
        graph.issues.push(issue("finalizer_corrupt", source, "workspaceId 与文件名不匹配"));
        continue;
      }
      if (new Workspace(raw.workspaceRoot).id !== workspaceId) {
        graph.issues.push(issue("finalizer_corrupt", source, "workspaceRoot 与 workspaceId 不匹配"));
        continue;
      }
      addReference(graph, {
        kind: "finalizer",
        buildId: raw.targetBuildId,
        source: `finalizer:${workspaceId}`,
        workspaceId,
      });
    } catch {
      graph.issues.push(issue("finalizer_corrupt", source, "active finalizer schema/identity 无效"));
    }
  }
}

type Collector = (stateDir: string, graph: ReleaseReferenceGraph) => void;

/** 固定本轮已知源；install/rollout/finalizer 在此追加，不改 graph 形状。 */
const REFERENCE_COLLECTORS: ReadonlyArray<{ kind: ReleaseReferenceKind; collect: Collector }> = [
  { kind: "current", collect: collectCurrent },
  { kind: "runtime", collect: collectRuntime },
  { kind: "runtime-upgrade", collect: collectPending },
  { kind: "finalizer", collect: collectFinalizers },
];

export function emptyReleaseReferenceGraph(stateDir: string): ReleaseReferenceGraph {
  return {
    stateDir: path.resolve(stateDir),
    references: new Map(),
    referencedBuildIds: new Set(),
    issues: [],
    ok: true,
  };
}

/** 只读构建引用图；绝不写 state、绝不删除 release。 */
export function collectReleaseReferences(stateDir: string): ReleaseReferenceGraph {
  const graph = emptyReleaseReferenceGraph(stateDir);
  for (const { collect } of REFERENCE_COLLECTORS) {
    try {
      collect(graph.stateDir, graph);
    } catch (error) {
      graph.issues.push(issue("current_invalid", "collector", error instanceof Error ? error.message : "引用收集失败"));
    }
  }
  graph.ok = graph.issues.length === 0;
  return graph;
}

/** 悬空引用（引用了不存在的 release）必须单独标出，阻止无引用 release 被当成可删。 */
export function markDanglingReferences(graph: ReleaseReferenceGraph, presentBuildIds: ReadonlySet<string>): void {
  for (const buildId of [...graph.referencedBuildIds].sort()) {
    if (presentBuildIds.has(buildId)) continue;
    const refs = graph.references.get(buildId) ?? [];
    const sources = refs.map((ref) => ref.source).sort().join(", ");
    graph.issues.push(issue(
      "dangling_reference",
      sources || buildId,
      `引用的 release ${buildId} 不存在：${sources || "unknown"}`,
    ));
  }
  graph.ok = graph.issues.length === 0;
}

export function formatReferenceIssue(item: ReleaseReferenceIssue): string {
  return `${item.source}: ${item.message}`;
}

/** 供 doctor/CLI 摘要使用；不替代完整 GcPlan。 */
export function referenceGraphSummary(graph: ReleaseReferenceGraph): {
  ok: boolean;
  referenceCount: number;
  referencedBuildCount: number;
  issueCount: number;
  issues: string[];
} {
  let referenceCount = 0;
  for (const refs of graph.references.values()) referenceCount += refs.length;
  return {
    ok: graph.ok,
    referenceCount,
    referencedBuildCount: graph.referencedBuildIds.size,
    issueCount: graph.issues.length,
    issues: graph.issues.map(formatReferenceIssue),
  };
}
