import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { isRuntimeBuildId } from "../build-id.js";
import { readCurrentInstall } from "./install.js";
import { activeFinalizerSchema, workerClaimSchema, readFinalizerRetirement } from "./post-turn-finalizer.js";
import { Workspace } from "../workspace/manager.js";
import { supervisorRuntimeSchema, supervisorLaunchSchema } from "../supervisor/schema.js";
import { gatewaySupervisorLaunchSchema, gatewaySupervisorRuntimeSchema } from "../gateway/supervisor.js";
import { remoteStateSchema } from "../remote/store.js";

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
export type ReleaseReferenceKind = "current" | "runtime" | "runtime-upgrade" | "finalizer" | "supervisor-runtime" | "supervisor-launch" | "gateway-runtime" | "gateway-launch" | "remote-controller";

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
  | "finalizer_corrupt"
  | "supervisor_corrupt"
  | "supervisor_identity_mismatch"
  | "supervisor_missing_build_id"
  | "remote_corrupt"
  | "remote_missing_build_id";

export type ReleaseIssueScope =
  | { kind: "global" }
  | { kind: "build"; buildId: string }
  | { kind: "release"; entryName: string };

export interface ReleaseReferenceIssue {
  code: ReleaseReferenceIssueCode;
  source: string;
  message: string;
  scope: ReleaseIssueScope;
}

export interface ReleaseReferenceGraph {
  stateDir: string;
  /** buildId → 引用列表（含悬空引用指向的 buildId） */
  references: Map<string, ReleaseReference[]>;
  referencedBuildIds: Set<string>;
  /** ok remains a clean-diagnostics flag; destructive eligibility uses explicit scope. */
  issues: ReleaseReferenceIssue[];
  ok: boolean;
}

function issue(code: ReleaseReferenceIssueCode, source: string, message: string, scope: ReleaseIssueScope = { kind: "global" }): ReleaseReferenceIssue {
  return { code, source, message, scope };
}

// GC extracts authority, not the entire runtime API contract. Unrelated new fields
// (including capabilities) cannot erase an exact pin. This never makes a runtime healthy.
const workspaceReferenceSchema = z.object({
  workspaceId: z.string().regex(WORKSPACE_ID),
  workspaceRoot: z.string().refine(path.isAbsolute),
});
const runtimeFileBaseSchema = workspaceReferenceSchema.extend({ runtimeBuildId: z.unknown().optional() });
const pendingFileSchema = workspaceReferenceSchema.extend({
  targetBuildId: z.string().refine(isRuntimeBuildId),
});
const finalizerReferenceSchema = pendingFileSchema.extend({ jobId: z.unknown().optional(), token: z.unknown().optional() });

function exactWorkspace(raw: z.infer<typeof workspaceReferenceSchema>, workspaceId: string): boolean {
  const workspace = new Workspace(raw.workspaceRoot);
  return raw.workspaceId === workspaceId && workspace.id === workspaceId && workspace.root === raw.workspaceRoot;
}

/** Canonical regular authority; reject replacement/truncation during the bounded read. */
export function readReleaseReferenceJson(file: string): unknown {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || fs.realpathSync(file) !== file)
    throw new Error("authority is not a canonical regular file");
  if (before.size > 1024 * 1024) throw new Error("authority exceeds size bound");
  const fd = fs.openSync(file, "r");
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("authority replaced before read");
    const bytes = Buffer.alloc(before.size + 1);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const after = fs.lstatSync(file), held = fs.fstatSync(fd);
    for (const stat of [after, held]) {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino ||
          stat.size !== before.size || stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs)
        throw new Error("authority replaced during read");
    }
    if (count !== before.size || fs.realpathSync(file) !== file) throw new Error("authority read incomplete");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)));
  } finally { fs.closeSync(fd); }
}

/** Known supervisor config/lock files do not name a release, but must still be canonical unshared files. */
function assertCanonicalNonReferenceFile(file: string): void {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || fs.realpathSync(file) !== file) {
    throw new Error("non-reference entry is not a canonical regular file");
  }
  const fd = fs.openSync(file, "r");
  try {
    const opened = fs.fstatSync(fd);
    const after = fs.lstatSync(file);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        !after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        fs.realpathSync(file) !== file) {
      throw new Error("non-reference entry changed during inspection");
    }
  } finally { fs.closeSync(fd); }
}

function addReference(graph: ReleaseReferenceGraph, reference: ReleaseReference): void {
  const list = graph.references.get(reference.buildId) ?? [];
  list.push(reference);
  graph.references.set(reference.buildId, list);
  graph.referencedBuildIds.add(reference.buildId);
}

function collectCurrent(stateDir: string, graph: ReleaseReferenceGraph): void {
  try {
    try { readReleaseReferenceJson(path.join(stateDir, "current.json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
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
  } catch {
    graph.issues.push(issue("current_invalid", "current", "current pointer 无法安全读取/验证"));
  }
}

function listStateFiles(dir: string): string[] {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(dir) !== dir) throw new Error("reference directory is not canonical");
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
      let rawJson: unknown;
      try {
        rawJson = readReleaseReferenceJson(file);
      } catch {
        graph.issues.push(issue("runtime_corrupt", source, "runtime 状态非 canonical regular file 或 JSON 无效"));
        continue;
      }
      const base = runtimeFileBaseSchema.safeParse(rawJson);
      if (!base.success) {
        graph.issues.push(issue("runtime_corrupt", source, "runtime 状态 schema 无效"));
        continue;
      }
      if (base.data.workspaceId !== workspaceId) {
        graph.issues.push(issue("runtime_identity_mismatch", source, "runtime 文件名与 workspaceId 不一致"));
        continue;
      }
      if (!exactWorkspace(base.data, workspaceId)) {
        graph.issues.push(issue("runtime_identity_mismatch", source, "workspaceRoot 与 workspaceId 不匹配"));
        continue;
      }
      const rb = base.data.runtimeBuildId;
      if (rb === undefined) {
        // 字段不存在 = legacy missing；仍 global fail-closed。
        graph.issues.push(issue("runtime_missing_build_id", source, "runtime 状态缺少 runtimeBuildId"));
        continue;
      }
      if (typeof rb !== "string" || !HEX64.test(rb)) {
        // "" / null-like / malformed / non-lowercase-hex → corrupt，不是 legacy missing。
        graph.issues.push(issue("runtime_corrupt", source, "runtimeBuildId malformed"));
        continue;
      }
      addReference(graph, {
        kind: "runtime",
        buildId: rb,
        source: `runtime:${workspaceId}`,
        workspaceId,
      });
    } catch {
      graph.issues.push(issue("runtime_corrupt", source, "runtime 状态读取失败"));
    }
  }
}

function collectSupervisor(stateDir: string, graph: ReleaseReferenceGraph): void {
  const folder = path.join(stateDir, "bridge-supervisor");
  for (const name of listStateFiles(folder)) {
    const source = `supervisor:${name}`;
    const runtimeMatch = /^([a-f0-9]{12})\.runtime\.json$/.exec(name);
    const launchMatch = /^([a-f0-9]{12})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.launch\.json$/.exec(name);
    if (!runtimeMatch && !launchMatch) {
      // Config and lock records never identify a release. Ignore only their exact known names,
      // and only when the entry itself is canonical, regular, and not hard-linked.
      if (/^[a-f0-9]{12}\.json$/.test(name) ||
          /^[a-f0-9]{12}(?:\.operation)?\.lock(?:\.reclaim\.lock)?$/.test(name)) {
        try { assertCanonicalNonReferenceFile(path.join(folder, name)); }
        catch { graph.issues.push(issue("supervisor_corrupt", source, "known supervisor config/lock entry is not a canonical regular file")); }
      } else {
        graph.issues.push(issue("supervisor_corrupt", source, "unknown supervisor entry may contain an unrecognized release reference"));
      }
      continue;
    }

    try {
      const file = path.join(folder, name);
      const json = readReleaseReferenceJson(file);
      if (runtimeMatch) {
        const workspaceId = runtimeMatch[1];
        const parsed = supervisorRuntimeSchema.safeParse(json);
        if (!parsed.success) throw new Error("runtime schema");
        if (parsed.data.workspaceId !== workspaceId || !exactWorkspace(parsed.data, workspaceId)) {
          graph.issues.push(issue("supervisor_identity_mismatch", source, "runtime filename/workspace identity does not match"));
          continue;
        }
        if (parsed.data.buildId === null) {
          graph.issues.push(issue("supervisor_missing_build_id", source, "runtime pin lacks an exact release buildId"));
          continue;
        }
        addReference(graph, {
          kind: "supervisor-runtime",
          buildId: parsed.data.buildId,
          source: `supervisor-runtime:${workspaceId}`,
          workspaceId,
        });
        continue;
      }

      const workspaceId = launchMatch![1];
      const nonce = launchMatch![2];
      const parsed = supervisorLaunchSchema.safeParse(json);
      if (!parsed.success) throw new Error("launch pin schema");
      if (parsed.data.workspaceId !== workspaceId || parsed.data.nonce !== nonce || !exactWorkspace(parsed.data, workspaceId)) {
        graph.issues.push(issue("supervisor_identity_mismatch", source, "launch filename/workspace identity does not match"));
        continue;
      }
      addReference(graph, {
        kind: "supervisor-launch",
        buildId: parsed.data.buildId,
        source: `supervisor-launch:${workspaceId}:${nonce}`,
        workspaceId,
      });
    } catch {
      graph.issues.push(issue("supervisor_corrupt", source, "supervisor release pin is noncanonical, corrupt, or ambiguous"));
    }
  }
}

function collectGateway(stateDir: string, graph: ReleaseReferenceGraph): void {
  const folder = path.join(stateDir, "gateway");
  for (const name of listStateFiles(folder)) {
    const source = `gateway:${name}`;
    const runtime = name === "supervisor.runtime.json";
    const launchMatch = /^supervisor\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.launch\.json$/.exec(name);
    const launch = launchMatch !== null;
    if (!runtime && !launch) {
      const known = name === "supervisor.json" || name === "supervisor.lock" || name === "server.lock" ||
        name === "workspaces.json" || name === "workspaces.json.lock" || name === "tunnel-runtime-key.dpapi" ||
        /^(?:workspaces|supervisor)\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i.test(name);
      if (known) {
        try { assertCanonicalNonReferenceFile(path.join(folder, name)); }
        catch { graph.issues.push(issue("supervisor_corrupt", source, "known gateway config, lock, registry, or key entry is not a canonical regular file")); }
      } else {
        graph.issues.push(issue("supervisor_corrupt", source, "unknown gateway entry may contain an unrecognized release reference"));
      }
      continue;
    }

    try {
      const value = readReleaseReferenceJson(path.join(folder, name));
      if (runtime) {
        const parsed = gatewaySupervisorRuntimeSchema.safeParse(value);
        if (!parsed.success) throw new Error("runtime schema");
        addReference(graph, { kind: "gateway-runtime", buildId: parsed.data.buildId, source: "gateway-runtime" });
        for (const [index, child] of (parsed.data.children ?? []).entries()) {
          addReference(graph, { kind: "gateway-runtime", buildId: child.buildId, source: `gateway-runtime:child:${index}` });
        }
        continue;
      }

      const parsed = gatewaySupervisorLaunchSchema.safeParse(value);
      if (!parsed.success) throw new Error("launch schema");
      if (parsed.data.nonce !== launchMatch![1]) {
        graph.issues.push(issue("supervisor_identity_mismatch", source, "launch pin filename nonce does not match its contents"));
        continue;
      }
      if (parsed.data.launcherPath !== path.join(stateDir, "bin", "c2c.js")) {
        graph.issues.push(issue("supervisor_identity_mismatch", source, "launch pin stable launcher path does not match the machine bin"));
        continue;
      }
      addReference(graph, { kind: "gateway-launch", buildId: parsed.data.buildId, source: `gateway-launch:${parsed.data.nonce}` });
    } catch {
      graph.issues.push(issue("supervisor_corrupt", source, "gateway runtime or launch pin is noncanonical, corrupt, or ambiguous"));
    }
  }
}

function collectRemote(stateDir: string, graph: ReleaseReferenceGraph): void {
  const folder = path.join(stateDir, "remote-control");
  for (const name of listStateFiles(folder)) {
    const source = `remote-controller:${name}`;
    if (!/^[a-f0-9]{12}\.json$/.test(name)) {
      graph.issues.push(issue("remote_corrupt", source, "remote state filename is not canonical workspaceId.json"));
      continue;
    }
    const workspaceId = name.slice(0, -5);
    try {
      const parsed = remoteStateSchema.safeParse(readReleaseReferenceJson(path.join(folder, name)));
      if (!parsed.success) throw new Error("state schema");
      const state = parsed.data;
      if (state.workspaceId !== workspaceId || !exactWorkspace(state, workspaceId)) {
        graph.issues.push(issue("remote_corrupt", source, "remote state filename/workspace identity does not match"));
        continue;
      }
      if (!state.controller) continue;
      if (!isRuntimeBuildId(state.controller.buildId)) {
        graph.issues.push(issue("remote_missing_build_id", source, "Controller runtime lacks an exact release buildId"));
        continue;
      }
      addReference(graph, { kind: "remote-controller", buildId: state.controller.buildId,
        source: `remote-controller:${workspaceId}`, workspaceId });
    } catch {
      graph.issues.push(issue("remote_corrupt", source, "remote state is noncanonical, corrupt, or ambiguous"));
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
      let rawJson: unknown;
      try { rawJson = readReleaseReferenceJson(file); } catch {
        graph.issues.push(issue("pending_corrupt", source, "pending 状态非 canonical regular file"));
        continue;
      }
      const parsed = pendingFileSchema.parse(rawJson);
      if (parsed.workspaceId !== workspaceId) {
        graph.issues.push(issue("pending_identity_mismatch", source, "pending 文件名与 workspaceId 不一致"));
        continue;
      }
      if (!exactWorkspace(parsed, workspaceId)) {
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
  const active = new Map<string, z.infer<typeof finalizerReferenceSchema>>();
  for (const name of listStateFiles(folder)) {
    const source = `finalizer:${name}`;
    if (!/^[a-f0-9]{12}\.json$/.test(name)) {
      graph.issues.push(issue("finalizer_corrupt", source, "finalizer 文件名非 canonical workspaceId.json"));
      continue;
    }
    const workspaceId = name.slice(0, -5);
    try {
      const file = path.join(folder, name);
      const json = readReleaseReferenceJson(file);
      const raw = finalizerReferenceSchema.parse(json);
      if (!exactWorkspace(raw, workspaceId)) {
        graph.issues.push(issue("finalizer_corrupt", source, "workspaceRoot 与 workspaceId 不匹配"));
        continue;
      }
      active.set(workspaceId, raw);
      addReference(graph, {
        kind: "finalizer",
        buildId: raw.targetBuildId,
        source: `finalizer:${workspaceId}`,
        workspaceId,
      });
      // Exact target remains pinned, but this record cannot enter strict retirement.
      if (!activeFinalizerSchema.safeParse(json).success) graph.issues.push(issue(
        "finalizer_corrupt", source, "finalizer exact target 已保留；不兼容 retirement schema",
        { kind: "build", buildId: raw.targetBuildId },
      ));
    } catch {
      graph.issues.push(issue("finalizer_corrupt", source, "active finalizer schema/identity 无效"));
    }
  }
  for (const name of listStateFiles(path.join(stateDir, "post-turn-finalizer-retirements"))) {
    try {
      if (!/^[a-f0-9]{12}\.json$/.test(name)) throw new Error("filename");
      readReleaseReferenceJson(path.join(stateDir, "post-turn-finalizer-retirements", name));
      if (!readFinalizerRetirement(stateDir, name.slice(0, -5))) throw new Error("missing proof");
    } catch {
      graph.issues.push(issue("finalizer_corrupt", `finalizer-retirement:${name}`, "retirement proof 无法严格验证"));
    }
  }
  for (const name of listStateFiles(path.join(stateDir, "post-turn-finalizer-workers"))) {
    try {
      if (!/^[a-f0-9]{12}\.claim$/.test(name)) throw new Error("filename");
      const workspaceId = name.slice(0, -6);
      const claim = workerClaimSchema.parse(readReleaseReferenceJson(path.join(stateDir, "post-turn-finalizer-workers", name)));
      const job = active.get(workspaceId);
      if (job) {
        if (claim.jobId !== job.jobId || claim.jobToken !== job.token) throw new Error("claim identity");
      } else if (!readFinalizerRetirement(stateDir, workspaceId)) throw new Error("orphan claim");
    } catch {
      graph.issues.push(issue("finalizer_corrupt", `finalizer-worker:${name}`, "worker claim target/retirement proof 不确定"));
    }
  }
}

type Collector = (stateDir: string, graph: ReleaseReferenceGraph) => void;

/** 固定本轮已知源；install/rollout/finalizer 在此追加，不改 graph 形状。 */
const REFERENCE_COLLECTORS: ReadonlyArray<{ kind: ReleaseReferenceKind; collect: Collector }> = [
  { kind: "current", collect: collectCurrent },
  { kind: "runtime", collect: collectRuntime },
  { kind: "supervisor-runtime", collect: collectSupervisor },
  { kind: "gateway-runtime", collect: collectGateway },
  { kind: "remote-controller", collect: collectRemote },
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
  try {
    const stat = fs.lstatSync(graph.stateDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(graph.stateDir) !== graph.stateDir) throw new Error("state directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      graph.issues.push(issue("current_invalid", "stateDir", "state directory 非 canonical 或无法读取"));
      graph.ok = false;
      return graph;
    }
  }
  for (const { kind, collect } of REFERENCE_COLLECTORS) {
    try {
      collect(graph.stateDir, graph);
    } catch {
      graph.issues.push(issue("current_invalid", `collector:${kind}`, "引用目录无法完整安全读取"));
    }
  }
  graph.ok = graph.issues.length === 0;
  return graph;
}

/** Exact dangling references remain visible without pinning unrelated present builds. */
export function markDanglingReferences(graph: ReleaseReferenceGraph, presentBuildIds: ReadonlySet<string>): void {
  for (const buildId of [...graph.referencedBuildIds].sort()) {
    if (presentBuildIds.has(buildId)) continue;
    const refs = graph.references.get(buildId) ?? [];
    const sources = refs.map((ref) => ref.source).sort().join(", ");
    graph.issues.push(issue(
      "dangling_reference",
      sources || buildId,
      `引用的 release ${buildId} 不存在：${sources || "unknown"}`,
      { kind: "build", buildId },
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
