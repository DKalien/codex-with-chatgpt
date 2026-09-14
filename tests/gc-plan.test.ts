import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planGc, gcPlanSummary, releaseLogicalSize, validateReleaseManifest } from "../src/core/gc-plan.js";
import { collectReleaseReferences } from "../src/core/release-references.js";
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
  const state = makeTmpDir("gc-state");
  const root = makeTmpDir("gc-checkout");
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

function writeRuntime(state: string, root: string, runtimeBuildId: string, workspaceId: string, overrides: Record<string, unknown> = {}): void {
  write(state, path.join("runtime", `${workspaceId}.json`), JSON.stringify({
    service: "codex-with-chatgpt",
    version: "test",
    workspaceId,
    workspaceRoot: root,
    pid: 123,
    port: 48765,
    adminToken: "test-token",
    publicUrl: null,
    startedAt: "2026-09-13T00:00:00.000Z",
    runtimeBuildId,
    ...overrides,
  }));
}

function writePending(state: string, root: string, targetBuildId: string, workspaceId: string, overrides: Record<string, unknown> = {}): void {
  write(state, path.join("runtime-upgrades", `${workspaceId}.json`), JSON.stringify({
    workspaceId,
    workspaceRoot: root,
    targetBuildId,
    reason: "busy",
    updatedAt: "2026-09-13T00:00:00.000Z",
    ...overrides,
  }));
}

function byId(plan: ReturnType<typeof planGc>) {
  return new Map(plan.releases.map(item => [item.buildId, item]));
}

function dirLink(target: string, link: string): void {
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

describe("immutable Core release GC plan", () => {
  it("合法 current 保留，未引用 release 成为回收候选并统计字节", () => {
    const { state, releases } = fixture(["A", "B"]);
    const plan = planGc(state);
    const map = byId(plan);
    const current = releases[1];
    const candidate = releases[0];

    expect(plan).toMatchObject({ ok: true, stateDir: path.resolve(state), totals: {
      releaseCount: 2, issueCount: 0, unknownReleaseCount: 0,
    }});
    expect(map.get(current.runtimeBuildId)).toMatchObject({ disposition: "keep", reasons: ["current"] });
    expect(map.get(candidate.runtimeBuildId)).toMatchObject({ disposition: "delete-candidate", reasons: [] });
    expect(plan.totals.bytesKept).toBe(map.get(current.runtimeBuildId)!.logicalBytes);
    expect(plan.totals.bytesCandidateReclaimable).toBe(map.get(candidate.runtimeBuildId)!.logicalBytes);
  });

  it("runtime 和 pending 引用的 release 均保留，多 workspace 同 build reasons 稳定", () => {
    const { state, root, releases } = fixture(["A", "B", "C"]);
    const runtimeWorkspace = new Workspace(root);
    const pendingRoot = makeTmpDir("gc-pending-workspace");
    const pendingWorkspace = new Workspace(pendingRoot);
    const secondRuntimeRoot = makeTmpDir("gc-runtime-workspace");
    const secondRuntimeWorkspace = new Workspace(secondRuntimeRoot);
    dirs.push(pendingRoot, secondRuntimeRoot);
    writeRuntime(state, runtimeWorkspace.root, releases[0].runtimeBuildId, runtimeWorkspace.id);
    writePending(state, pendingWorkspace.root, releases[1].runtimeBuildId, pendingWorkspace.id);
    writeRuntime(state, secondRuntimeWorkspace.root, releases[0].runtimeBuildId, secondRuntimeWorkspace.id);
    const plan = planGc(state);
    const map = byId(plan);

    expect(plan.ok).toBe(true);
    expect(map.get(releases[0].runtimeBuildId)!.disposition).toBe("keep");
    expect(map.get(releases[0].runtimeBuildId)!.reasons).toEqual([
      `runtime:${runtimeWorkspace.id}`,
      `runtime:${secondRuntimeWorkspace.id}`,
    ].sort());
    expect(map.get(releases[1].runtimeBuildId)).toMatchObject({
      disposition: "keep", reasons: [`pending:${pendingWorkspace.id}`],
    });
    expect(map.get(releases[2].runtimeBuildId)).toMatchObject({ disposition: "keep", reasons: ["current"] });
    expect(plan.totals.bytesCandidateReclaimable).toBe(0);
    expect(plan.totals.bytesKept).toBe(plan.releases.reduce((sum, item) => sum + item.logicalBytes, 0));
  });

  it("runtime/pending 的悬空 build 引用触发全局 unknown，阻断候选回收", () => {
    const { state, root, releases } = fixture(["A", "B"]);
    const workspaceId = new Workspace(root).id;
    writeRuntime(state, root, "f".repeat(64), workspaceId);
    writePending(state, root, "e".repeat(64), workspaceId);
    const plan = planGc(state);
    const candidate = byId(plan).get(releases[0].runtimeBuildId)!;

    expect(plan.ok).toBe(false);
    expect(plan.issues.length).toBeGreaterThanOrEqual(2);
    expect(candidate.disposition).toBe("unknown");
    expect(candidate.reasons).toContain("global_unknown_reference");
    expect(plan.totals.bytesCandidateReclaimable).toBe(0);
  });

  it("坏 release manifest 标为 unknown 并阻断回收", () => {
    const { state, releases } = fixture(["A", "B"]);
    const broken = releases[0];
    fs.writeFileSync(path.join(broken.releaseRoot, "release.json"), "{}");
    const plan = planGc(state);
    const item = byId(plan).get(broken.runtimeBuildId)!;

    expect(plan.ok).toBe(false);
    expect(plan.issues.some(issue => issue.startsWith(`releases/${broken.runtimeBuildId}:`))).toBe(true);
    expect(item.disposition).toBe("unknown");
    expect(item.reasons).toContain("manifest_mismatch");
    expect(plan.totals.bytesCandidateReclaimable).toBe(0);
  });

  it("manifest buildId mismatch 标为 unknown", () => {
    const { state, releases } = fixture(["A", "B"]);
    const broken = releases[0];
    const file = path.join(broken.releaseRoot, "release.json");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    manifest.runtimeBuildId = "a".repeat(64);
    fs.writeFileSync(file, JSON.stringify(manifest));
    const plan = planGc(state);
    expect(byId(plan).get(broken.runtimeBuildId)!.disposition).toBe("unknown");
    expect(plan.ok).toBe(false);
  });

  it("非 canonical release 目录名成为 issue", () => {
    const { state, releases } = fixture(["A"]);
    fs.mkdirSync(path.join(state, "releases", "not-a-build-id"), { recursive: true });
    const plan = planGc(state);
    expect(plan.ok).toBe(false);
    expect(plan.releases.some(item => item.buildId === "not-a-build-id" && item.disposition === "unknown")).toBe(true);
    expect(plan.issues.some(issue => issue.startsWith("releases/not-a-build-id:"))).toBe(true);
    // 既有合法 current 仍 keep，但全局阻断使候选为 0
    expect(byId(plan).get(releases[0].runtimeBuildId)!.disposition).toBe("keep");
    expect(plan.totals.bytesCandidateReclaimable).toBe(0);
  });

  it("release 根 symlink/junction 拒绝遍历", () => {
    const { state, root, releases } = fixture(["A"]);
    const outside = makeTmpDir("gc-outside");
    dirs.push(outside);
    const link = path.join(state, "releases", "b".repeat(64));
    dirLink(outside, link);
    const plan = planGc(state);
    const item = byId(plan).get("b".repeat(64))!;
    expect(item.disposition).toBe("unknown");
    expect(plan.ok).toBe(false);
    expect(byId(plan).get(releases[0].runtimeBuildId)!.disposition).toBe("keep");
  });

  it("release 内部链接仍在 root 内：计量稳定且不重复 target 内容", () => {
    const { state, releases } = fixture(["A"]);
    const releaseRoot = releases[0].releaseRoot;
    const target = path.join(releaseRoot, "package.json");
    const link = path.join(releaseRoot, "package-link.json");
    fs.symlinkSync(target, link);
    const plan = planGc(state);
    const item = byId(plan).get(releases[0].runtimeBuildId)!;
    expect(item.disposition).toBe("keep");
    expect(item.logicalBytes).toBeGreaterThan(0);
    // link 只计 lstat 大小，不把 target 内容再加一遍
    const withoutLink = item.logicalBytes - fs.lstatSync(link).size;
    expect(withoutLink).toBe(releaseLogicalSize(releaseRoot) - fs.lstatSync(link).size);
  });

  it("release 内部链接越界：unknown", () => {
    const { state, releases } = fixture(["A"]);
    const outside = makeTmpDir("gc-outside-file");
    dirs.push(outside);
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "secret");
    const releaseRoot = releases[0].releaseRoot;
    fs.symlinkSync(secret, path.join(releaseRoot, "escape.txt"));
    const plan = planGc(state);
    const item = byId(plan).get(releases[0].runtimeBuildId)!;
    expect(item.disposition).toBe("unknown");
    expect(plan.ok).toBe(false);
    expect(plan.totals.bytesCandidateReclaimable).toBe(0);
  });

  it("内部环状链接不无限递归，保持安全", () => {
    const { state, releases } = fixture(["A"]);
    const releaseRoot = releases[0].releaseRoot;
    fs.mkdirSync(path.join(releaseRoot, "sub"), { recursive: true });
    dirLink(path.join(releaseRoot, "sub"), path.join(releaseRoot, "loop"));
    const plan = planGc(state);
    const item = byId(plan).get(releases[0].runtimeBuildId)!;
    // 不跟随目录链接，因此不会环；仍可计量
    expect(item.disposition).toBe("keep");
    expect(Number.isFinite(item.logicalBytes)).toBe(true);
  });

  it("按 buildId 排序且只读，不改变 state 或 release 文件", () => {
    const { state, releases } = fixture(["A", "B", "C"]);
    const files = [
      path.join(state, "current.json"),
      ...releases.map(release => path.join(release.releaseRoot, "release.json")),
    ];
    const before = files.map(file => fs.readFileSync(file));
    const writeFile = vi.spyOn(fs, "writeFileSync");
    const rename = vi.spyOn(fs, "renameSync");
    const remove = vi.spyOn(fs, "rmSync");
    const plan = planGc(state);

    expect(plan.releases.map(item => item.buildId)).toEqual(
      [...plan.releases.map(item => item.buildId)].sort((a, b) => a.localeCompare(b)),
    );
    expect(files.map(file => fs.readFileSync(file))).toEqual(before);
    expect(writeFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("GC plan fail-closed 状态矩阵", () => {
  it("corrupt runtime JSON -> global unknown", () => {
    const { state, releases } = fixture(["A", "B"]);
    write(state, path.join("runtime", `${"a".repeat(12)}.json`), "{broken}");
    const plan = planGc(state);
    expect(plan.ok).toBe(false);
    expect(byId(plan).get(releases[0].runtimeBuildId)!.disposition).toBe("unknown");
    expect(plan.totals.bytesCandidateReclaimable).toBe(0);
  });

  it("wrong runtime workspaceId identity -> global unknown", () => {
    const { state, root, releases } = fixture(["A", "B"]);
    const ws = new Workspace(root).id;
    writeRuntime(state, root, releases[1].runtimeBuildId, ws);
    const file = path.join(state, "runtime", `${ws}.json`);
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    value.workspaceId = "b".repeat(12);
    fs.writeFileSync(file, JSON.stringify(value));
    const plan = planGc(state);
    expect(plan.ok).toBe(false);
    expect(byId(plan).get(releases[0].runtimeBuildId)!.disposition).toBe("unknown");
  });

  it("corrupt pending JSON -> global unknown", () => {
    const { state, releases } = fixture(["A", "B"]);
    write(state, path.join("runtime-upgrades", `${"b".repeat(12)}.json`), "not-json");
    const plan = planGc(state);
    expect(plan.ok).toBe(false);
    expect(plan.totals.bytesCandidateReclaimable).toBe(0);
  });

  it("wrong pending identity -> global unknown", () => {
    const { state, root, releases } = fixture(["A", "B"]);
    const ws = new Workspace(root).id;
    writePending(state, root, releases[1].runtimeBuildId, ws);
    const file = path.join(state, "runtime-upgrades", `${ws}.json`);
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    value.workspaceId = "c".repeat(12);
    fs.writeFileSync(file, JSON.stringify(value));
    const plan = planGc(state);
    expect(plan.ok).toBe(false);
  });

  it("runtime 外链文件 -> global unknown", () => {
    const { state, root, releases } = fixture(["A", "B"]);
    const workspace = new Workspace(root);
    const outside = makeTmpDir("gc-runtime-link-outside");
    dirs.push(outside);
    const target = write(outside, path.join("runtime", `${workspace.id}.json`), JSON.stringify({
      service: "codex-with-chatgpt",
      version: "test",
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      pid: 123,
      port: 48765,
      adminToken: "test-token",
      publicUrl: null,
      startedAt: "2026-09-13T00:00:00.000Z",
      runtimeBuildId: releases[0].runtimeBuildId,
    }));
    const link = path.join(state, "runtime", `${workspace.id}.json`);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, "file");

    const plan = planGc(state);
    expect(plan.ok).toBe(false);
    expect(plan.issues.some(message => message.includes(`runtime:${workspace.id}.json`) && message.includes("canonical regular file"))).toBe(true);
    expect(byId(plan).get(releases[0].runtimeBuildId)!.disposition).toBe("unknown");
    expect(fs.existsSync(target)).toBe(true);
  });

  it("pending 外链文件 -> global unknown", () => {
    const { state, root, releases } = fixture(["A", "B"]);
    const workspace = new Workspace(root);
    const outside = makeTmpDir("gc-pending-link-outside");
    dirs.push(outside);
    const target = write(outside, path.join("runtime-upgrades", `${workspace.id}.json`), JSON.stringify({
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      targetBuildId: releases[0].runtimeBuildId,
      reason: "busy",
      updatedAt: "2026-09-13T00:00:00.000Z",
    }));
    const link = path.join(state, "runtime-upgrades", `${workspace.id}.json`);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, "file");

    const plan = planGc(state);
    expect(plan.ok).toBe(false);
    expect(plan.issues.some(message => message.includes(`runtime-upgrade:${workspace.id}.json`) && message.includes("canonical regular file"))).toBe(true);
    expect(byId(plan).get(releases[0].runtimeBuildId)!.disposition).toBe("unknown");
    expect(fs.existsSync(target)).toBe(true);
  });

  it("runtime workspaceRoot 身份错配 -> global unknown", () => {
    const { state, root, releases } = fixture(["A", "B"]);
    const workspace = new Workspace(root);
    const otherRoot = makeTmpDir("gc-runtime-identity-other");
    dirs.push(otherRoot);
    writeRuntime(state, root, releases[0].runtimeBuildId, workspace.id, { workspaceRoot: otherRoot });

    const plan = planGc(state);
    expect(plan.ok).toBe(false);
    expect(plan.issues.some(message => message.includes(`runtime:${workspace.id}.json`) && message.includes("workspaceRoot 与 workspaceId 不匹配"))).toBe(true);
    expect(byId(plan).get(releases[0].runtimeBuildId)!.disposition).toBe("unknown");
  });

  it("pending workspaceRoot 身份错配 -> global unknown", () => {
    const { state, root, releases } = fixture(["A", "B"]);
    const workspace = new Workspace(root);
    const otherRoot = makeTmpDir("gc-pending-identity-other");
    dirs.push(otherRoot);
    writePending(state, root, releases[0].runtimeBuildId, workspace.id, { workspaceRoot: otherRoot });

    const plan = planGc(state);
    expect(plan.ok).toBe(false);
    expect(plan.issues.some(message => message.includes(`runtime-upgrade:${workspace.id}.json`) && message.includes("workspaceRoot 与 workspaceId 不匹配"))).toBe(true);
    expect(byId(plan).get(releases[0].runtimeBuildId)!.disposition).toBe("unknown");
  });

  it("invalid current pointer -> global unknown", () => {
    const { state, releases } = fixture(["A"]);
    fs.writeFileSync(path.join(state, "current.json"), JSON.stringify({ version: 3, runtimeBuildId: "nope" }));
    const plan = planGc(state);
    expect(plan.ok).toBe(false);
    // current 读取失败时无法证明任何 release 是 current：不得 keep，也不得作为 candidate
    expect(byId(plan).get(releases[0].runtimeBuildId)!.disposition).toBe("unknown");
    expect(plan.totals.bytesCandidateReclaimable).toBe(0);
  });

  it("--plan 与 --dry-run 处置等价；JSON 契约稳定；plain gc 拒绝", () => {
    const { state, releases } = fixture(["A", "B"]);
    const plan = planGc(state);
    const env = { ...process.env, C2C_STATE_DIR: state };
    const entry = path.join(project, "src/cli/index.ts");
    const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", entry, ...args], {
      cwd: project, encoding: "utf8", windowsHide: true, env,
    });

    const plain = run("gc");
    expect(plain.status).not.toBe(0);
    expect(plain.stdout + plain.stderr).toMatch(/--plan|--dry-run/);

    const healthyPlanRun = run("gc", "--plan", "--json");
    const healthyDryRun = run("gc", "--dry-run", "--json");
    expect(healthyPlanRun.status).toBe(0);
    expect(healthyDryRun.status).toBe(0);
    const planJson = JSON.parse(healthyPlanRun.stdout);
    const dryJson = JSON.parse(healthyDryRun.stdout);
    expect(planJson).toMatchObject({ ok: plan.ok, stateDir: plan.stateDir, totals: plan.totals });
    expect(dryJson.releases).toEqual(planJson.releases);
    expect(dryJson.totals.bytesCandidateReclaimable).toBe(planJson.totals.bytesCandidateReclaimable);
    expect(planJson.releases.map((item: { buildId: string }) => item.buildId)).toContain(releases[1].runtimeBuildId);
    // 契约字段稳定
    expect(Object.keys(planJson).sort()).toEqual(["issues", "ok", "releases", "stateDir", "totals"]);
    expect(Object.keys(planJson.totals).sort()).toEqual([
      "bytesCandidateReclaimable", "bytesKept", "issueCount", "releaseCount", "unknownReleaseCount",
    ]);
    expect(Object.keys(planJson.releases[0]).sort()).toEqual(["buildId", "disposition", "logicalBytes", "path", "reasons"]);
  }, 60000);

  it("ok=false 时 --plan/--dry-run --json 仍输出完整 plan 且非零退出", () => {
    const { state, root } = fixture(["A", "B"]);
    const workspaceId = new Workspace(root).id;
    // 明确 ok=false：dangling runtime 引用
    write(state, path.join("runtime", `${workspaceId}.json`), JSON.stringify({
      service: "codex-with-chatgpt",
      version: "test",
      workspaceId,
      workspaceRoot: root,
      pid: 1,
      port: 1,
      adminToken: "t",
      publicUrl: null,
      startedAt: "2026-09-13T00:00:00.000Z",
      runtimeBuildId: "f".repeat(64),
    }));
    expect(planGc(state).ok).toBe(false);

    const env = { ...process.env, C2C_STATE_DIR: state };
    const entry = path.join(project, "src/cli/index.ts");
    const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", entry, ...args], {
      cwd: project, encoding: "utf8", windowsHide: true, env,
    });

    const planResult = run("gc", "--plan", "--json");
    expect(planResult.status).not.toBe(0);
    const planJson = JSON.parse(planResult.stdout);
    expect(planJson.ok).toBe(false);
    expect(planJson.totals.issueCount).toBeGreaterThan(0);
    expect(planJson.releases.length).toBeGreaterThan(0);

    const dryResult = run("gc", "--dry-run", "--json");
    expect(dryResult.status).not.toBe(0);
    const dryJson = JSON.parse(dryResult.stdout);
    expect(dryJson.ok).toBe(false);
    expect(dryJson.releases).toEqual(planJson.releases);
  }, 60000);
});

describe("reference graph 与 manifest 单元", () => {
  it("collectReleaseReferences 可扩展引用图，不写状态", () => {
    const { state, root, releases } = fixture(["A"]);
    const workspace = new Workspace(root);
    writeRuntime(state, workspace.root, releases[0].runtimeBuildId, workspace.id);
    const before = fs.readFileSync(path.join(state, "current.json"));
    const graph = collectReleaseReferences(state);
    expect(graph.referencedBuildIds.has(releases[0].runtimeBuildId)).toBe(true);
    expect(graph.references.get(releases[0].runtimeBuildId)!.map(r => r.source).sort()).toEqual(
      ["current", `runtime:${workspace.id}`],
    );
    expect(graph.ok).toBe(true);
    expect(fs.readFileSync(path.join(state, "current.json"))).toEqual(before);
  });

  it("validateReleaseManifest 拒绝多余/缺失字段", () => {
    const { state, releases } = fixture(["A"]);
    const root = releases[0].releaseRoot;
    const file = path.join(root, "release.json");
    const good = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(good), extra: 1 }));
    expect(validateReleaseManifest(root, releases[0].runtimeBuildId).ok).toBe(false);
    fs.writeFileSync(file, "{}");
    expect(validateReleaseManifest(root, releases[0].runtimeBuildId).ok).toBe(false);
    fs.writeFileSync(file, good);
    expect(validateReleaseManifest(root, releases[0].runtimeBuildId).ok).toBe(true);
    void state;
  });

  it("gcPlanSummary 与 plan 数字一致", () => {
    const { state, releases } = fixture(["A", "B"]);
    const plan = planGc(state);
    const summary = gcPlanSummary(plan);
    expect(summary.releaseCount).toBe(2);
    expect(summary.bytesCandidateReclaimable).toBe(plan.totals.bytesCandidateReclaimable);
    expect(summary.bytesKept).toBe(plan.totals.bytesKept);
    expect(releases).toHaveLength(2);
  });
});
