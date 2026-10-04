import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installCore } from "../src/core/install.js";
import { Workspace } from "../src/workspace/manager.js";
import { buildCoreFixture, cleanup, makeTmpDir, write } from "./helpers.js";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(cleanup); vi.unstubAllEnvs(); });
function temp(name: string) { const dir = makeTmpDir(name); dirs.push(dir); return dir; }

/**
 * fixture CLI：launcher（release bin/c2c.js → import ../dist/cli/index.js）加载它后，
 * 把参数原样转发给真实 CLI（tsx）。GC 语义全部来自生产实现，fixture 只做进程桥接。
 * marker 注入内容使每次 build 生成不同 buildId（buildId = dist 内容哈希）。
 */
function delegateCli(marker: string): string {
  return `import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
// install-gc fixture marker: ${marker}
if (process.env.C2C_GC_PROBE) appendFileSync(process.env.C2C_GC_PROBE, process.argv.slice(2).join(" ") + "\\n");
const project = ${JSON.stringify(project)};
const result = spawnSync(process.execPath,
  ["--import", "tsx", ${JSON.stringify(path.join(project, "src/cli/index.ts"))}, ...process.argv.slice(2)],
  { stdio: "inherit", windowsHide: true, cwd: project, env: process.env });
if (result.error) { process.stderr.write(String(result.error)); process.exit(1); }
process.exit(result.status ?? 1);
`;
}

function checkout(marker: string) {
  const root = temp("install-gc-checkout");
  write(root, "package.json", '{"type":"module"}');
  write(root, "bin/c2c.js", 'import "../dist/cli/index.js";');
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  write(root, "dist/cli/index.js", delegateCli(marker));
  return { root, buildId: buildCoreFixture(root) };
}

function writeRuntime(state: string, workspaceRoot: string, runtimeBuildId: string): void {
  const workspaceId = new Workspace(workspaceRoot).id;
  write(state, path.join("runtime", `${workspaceId}.json`), JSON.stringify({
    service: "codex-with-chatgpt", version: "test", workspaceId, workspaceRoot,
    pid: 123, port: 48765, adminToken: "t", publicUrl: null,
    startedAt: "2026-09-13T00:00:00.000Z", runtimeBuildId,
  }));
}

function writeDanglingPending(state: string, workspaceRoot: string): void {
  const workspaceId = new Workspace(workspaceRoot).id;
  write(state, path.join("runtime-upgrades", `${workspaceId}.json`), JSON.stringify({
    workspaceId, workspaceRoot, targetBuildId: "f".repeat(64), reason: "busy",
    updatedAt: "2026-09-13T00:00:00.000Z",
  }));
}

function probeFile(state: string): string { return path.join(state, "gc-probe.txt"); }

/** 经生产安装脚本执行 install + 自动 GC；返回 { payload, gcPayload 首行 }。 */
function runInstall(state: string, args: string[] = []) {
  const result = spawnSync(process.execPath,
    [path.join(project, "scripts", "install-core.mjs"), ...args, "--json"], {
      encoding: "utf8", windowsHide: true, timeout: 120_000,
      env: { ...process.env, C2C_STATE_DIR: state, C2C_GC_PROBE: probeFile(state) },
    });
  const lines = String(result.stdout ?? "").split("\n").map(line => line.trim()).filter(Boolean);
  const payload = JSON.parse(lines.at(-1)!);
  return { ...result, payload };
}

describe("install-core 自动 GC 集成（临时状态，真实安装逻辑 + 真实 gc --apply）", () => {
  it("install A 且 runtime 引用仍指向 A → install B 自动 GC 必须保留 A", () => {
    const state = temp("install-gc-keep");
    vi.stubEnv("C2C_STATE_DIR", state);
    const sourceA = checkout("A");
    const installedA = installCore(sourceA.root, sourceA.buildId);
    writeRuntime(state, sourceA.root, installedA.runtimeBuildId);

    const sourceB = checkout("B");
    const result = runInstall(state, ["--checkout-root", sourceB.root]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.payload.gc.ok).toBe(true);
    expect(result.payload.gc.totals.deletedCount).toBe(0);
    expect(result.payload.runtimeBuildId).toBe(sourceB.buildId);
    expect(result.payload.releaseRoot).toBe(path.join(state, "releases", sourceB.buildId));
    // runtime 引用 → A 保留；current=B 正常服务
    expect(fs.existsSync(installedA.releaseRoot)).toBe(true);
    expect(fs.existsSync(result.payload.releaseRoot)).toBe(true);
    // 自动 GC 确实经已安装 launcher 调用过一次 `gc --apply --json`
    expect(fs.readFileSync(probeFile(state), "utf8")).toBe("gc --apply --json\n");
  }, 120_000);

  it("install A 且无剩余引用 → install B 自动 GC 可删除 A", () => {
    const state = temp("install-gc-reclaim");
    vi.stubEnv("C2C_STATE_DIR", state);
    const sourceA = checkout("A");
    const installedA = installCore(sourceA.root, sourceA.buildId);

    const sourceB = checkout("B");
    const result = runInstall(state, ["--checkout-root", sourceB.root]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.payload.gc.ok).toBe(true);
    expect(result.payload.gc.totals.deletedCount).toBe(1);
    expect(result.payload.gc.items).toEqual([expect.objectContaining({
      buildId: sourceA.buildId, status: "deleted", reason: "reclaimed",
    })]);
    expect(fs.existsSync(installedA.releaseRoot)).toBe(false);
    expect(fs.existsSync(result.payload.releaseRoot)).toBe(true);
    expect(result.stderr).toContain("已回收旧 release：1 个");
  }, 120_000);

  it("--protect-current 永不调用 GC：A 保留、无 launcher 调用、无回收警告", () => {
    const state = temp("install-gc-protect");
    vi.stubEnv("C2C_STATE_DIR", state);
    const sourceA = checkout("A");
    const installedA = installCore(sourceA.root, sourceA.buildId);

    const result = runInstall(state, ["--protect-current", "--checkout-root", sourceA.root]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.payload.protected).toBe(true);
    expect(result.payload.gc).toEqual({ ok: true, skipped: "protect_current" });
    expect(fs.existsSync(installedA.releaseRoot)).toBe(true);
    expect(fs.existsSync(probeFile(state))).toBe(false);
    expect(result.stderr).not.toContain("回收");
  }, 120_000);

  it.each(["dangling", "global"])("GC %s warning 保留安装成功，只有 exact dangling 允许安全回收", kind => {
    const state = temp("install-gc-failure");
    vi.stubEnv("C2C_STATE_DIR", state);
    const sourceA = checkout("A");
    const installedA = installCore(sourceA.root, sourceA.buildId);
    writeDanglingPending(state, sourceA.root);
    if (kind === "global") write(state, path.join("runtime-upgrades", `${new Workspace(sourceA.root).id}.json`), "{}");

    const sourceB = checkout("B");
    const result = runInstall(state, ["--checkout-root", sourceB.root]);
    // 安装结果不受 GC 失败影响
    expect(result.status, result.stderr).toBe(0);
    expect(result.payload.runtimeBuildId).toBe(sourceB.buildId);
    expect(fs.existsSync(result.payload.releaseRoot)).toBe(true);
    // Partial GC uses nonzero/ok=false warning semantics without invalidating installation.
    expect(result.payload.gc.ok).toBe(false);
    expect(result.stderr).toContain("旧 release 回收未完全成功");
    expect(fs.existsSync(installedA.releaseRoot)).toBe(kind === "global");
    expect(result.payload.gc.totals.deletedCount).toBe(kind === "global" ? 0 : 1);
    expect(result.payload.gc.status).toBe(kind === "global" ? "blocked" : "partial");
  }, 120_000);
});
