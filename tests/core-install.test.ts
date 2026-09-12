import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentInstallPath, getCurrentInstall, installCore, launcherPath, readCurrentInstall } from "../src/core/install.js";
import { writeBuildId } from "../scripts/write-build-id.mjs";
import release from "../scripts/core-release.cjs";
import { buildCoreFixture, cleanup, makeTmpDir, write } from "./helpers.js";

const dirs: string[] = [];
function temp(name: string) { const dir = makeTmpDir(name); dirs.push(dir); return dir; }
afterEach(() => { dirs.splice(0).forEach(cleanup); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function checkout() {
  const parent = temp("core-checkout");
  const root = path.join(parent, "checkout");
  write(root, "package.json", '{"type":"module"}');
  write(root, "bin/c2c.js", 'import "../dist/cli/index.js";');
  const dependency = path.join(root, "node_modules", ".pnpm", "fixture", "node_modules", "fixture");
  write(dependency, "package.json", '{"name":"fixture","main":"index.cjs"}');
  write(dependency, "index.cjs", 'module.exports = "dependency-A";');
  fs.symlinkSync(process.platform === "win32" ? dependency : path.relative(path.join(root, "node_modules"), dependency),
    path.join(root, "node_modules", "fixture"), process.platform === "win32" ? "junction" : "dir");
  return { root, parent, dependency };
}
function rebuild(root: string, marker: string) {
  write(root, "dist/cli/index.js", `import fs from "node:fs";
import dependency from "fixture";
fs.writeFileSync(process.env.C2C_LAUNCHER_PROBE, JSON.stringify({marker:${JSON.stringify(marker)}, dependency, args:process.argv.slice(2), entry:process.argv[1]}));
process.exit(Number(process.env.C2C_LAUNCHER_EXIT_CODE || "0"));
`);
  return buildCoreFixture(root);
}
function machine() { const state = temp("core-machine"); vi.stubEnv("C2C_STATE_DIR", state); return state; }
function launch(state: string, args: string[] = [], exitCode = 0) {
  const probe = path.join(state, "probe.json"); fs.rmSync(probe, { force: true });
  const result = spawnSync(process.execPath, [launcherPath(state), ...args], { encoding: "utf8", windowsHide: true,
    env: { ...process.env, C2C_LAUNCHER_PROBE: probe, C2C_LAUNCHER_EXIT_CODE: String(exitCode) } });
  return { ...result, probe: fs.existsSync(probe) ? JSON.parse(fs.readFileSync(probe, "utf8")) : null };
}

describe("immutable installed Core", () => {
  it("build 后修改 live 入口/package/installer 不能冒充该 build 的已安装代码", () => {
    const state = machine(), source = checkout();
    const id = rebuild(source.root, "A");
    write(source.root, "bin/c2c.js", 'throw new Error("unbuilt B");');
    write(source.root, "package.json", '{"type":"commonjs"}');
    write(source.root, "scripts/core-launcher.cjs", 'throw new Error("unbuilt launcher B");');
    const installed = installCore(source.root, id);
    expect(installed.runtimeBuildId).toBe(id);
    const result = launch(state);
    expect(result.status, result.stderr).toBe(0);
    expect(result.probe.marker).toBe("A");
    expect(fs.readFileSync(path.join(installed.releaseRoot, "bin/c2c.js"), "utf8")).toBe('import "../dist/cli/index.js";');
  });
  it("测试缓存与包管理器 checkout 映射变化不污染 release 或重复安装", () => {
    const state = machine(), source = checkout();
    const id = rebuild(source.root, "A");
    write(source.root, "node_modules/.vite/results.json", "first test result");
    write(source.root, "node_modules/.package-map.json", JSON.stringify({ source: source.root }));
    const first = installCore(source.root, id);
    write(source.root, "node_modules/.vite/results.json", "new test result");
    write(source.root, "node_modules/.package-map.json", "changed checkout mapping");
    const second = installCore(source.root, id);
    expect(second.artifactSha256).toBe(first.artifactSha256);
    expect(fs.existsSync(path.join(second.releaseRoot, "node_modules/.vite"))).toBe(false);
    expect(fs.existsSync(path.join(second.releaseRoot, "node_modules/.package-map.json"))).toBe(false);
    expect(launch(state).probe.marker).toBe("A");
  });
  it("install A 后 argv/exit 透传；重建/修改/移动 checkout 仍运行 A，install B 后才切 B", () => {
    const state = machine(), source = checkout();
    const idA = rebuild(source.root, "A");
    const a = installCore(source.root, idA);
    expect(a).toMatchObject({ version: 2, checkoutRoot: source.root, runtimeBuildId: idA,
      releaseRoot: path.join(state, "releases", idA) });
    expect(readCurrentInstall()).toEqual(a);
    expect(getCurrentInstall()).toEqual({ status: "installed", metadata: a });
    const args = ["rollout", "--json", "中文 arg", "line\nfeed"];
    const first = launch(state, args, 17);
    expect(first.status, first.stderr).toBe(17);
    expect(first.probe).toMatchObject({ marker: "A", dependency: "dependency-A", args, entry: path.join(a.releaseRoot, "bin", "c2c.js") });

    fs.writeFileSync(path.join(source.dependency, "index.cjs"), 'module.exports = "dependency-B";');
    const idB = rebuild(source.root, "B");
    const bBeforeInstall = launch(state);
    expect(bBeforeInstall.status, bBeforeInstall.stderr).toBe(0);
    expect(bBeforeInstall.probe).toMatchObject({ marker: "A", dependency: "dependency-A" });
    const moved = path.join(source.parent, "moved");
    fs.renameSync(source.root, moved);
    expect(launch(state).probe).toMatchObject({ marker: "A", dependency: "dependency-A" });
    // pnpm 在 Windows 的源 junction 指向旧 checkout，移动后重新建立当前源依赖布局。
    if (process.platform === "win32") {
      fs.unlinkSync(path.join(moved, "node_modules", "fixture"));
      fs.symlinkSync(path.join(moved, "node_modules", ".pnpm", "fixture", "node_modules", "fixture"),
        path.join(moved, "node_modules", "fixture"), "junction");
    }
    const b = installCore(moved, idB);
    expect(b.runtimeBuildId).not.toBe(a.runtimeBuildId);
    const second = launch(state);
    expect(second.status, second.stderr).toBe(0);
    expect(second.probe).toMatchObject({ marker: "B", dependency: "dependency-B" });
    expect(fs.existsSync(a.releaseRoot)).toBe(true);
  });

  it("安装/原子切 pointer 失败仍可运行 A，失败不发布 B 或修改旧 launcher", () => {
    const state = machine(), source = checkout();
    const a = installCore(source.root, rebuild(source.root, "A"));
    const pointer = fs.readFileSync(currentInstallPath()), launcher = fs.readFileSync(launcherPath());
    const idB = rebuild(source.root, "B");
    fs.writeFileSync(path.join(source.root, "dist/build-id.txt"), "invalid");
    expect(() => installCore(source.root, idB)).toThrow(/实际 runtime artifact/);
    expect(launch(state).probe.marker).toBe("A");
    fs.writeFileSync(path.join(source.root, "dist/build-id.txt"), idB);
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === currentInstallPath()) throw new Error("injected pointer failure");
      return rename(from, to);
    });
    expect(() => installCore(source.root, idB)).toThrow(/保留旧 pointer/);
    expect(fs.readFileSync(currentInstallPath())).toEqual(pointer);
    expect(fs.readFileSync(launcherPath())).toEqual(launcher);
    expect(launch(state).probe.marker).toBe("A");
    expect(readCurrentInstall()).toEqual(a);
  });

  it("缺失/损坏 current 或 release 内容被改动时 fail closed，不执行 checkout", () => {
    const state = machine(), source = checkout();
    const a = installCore(source.root, rebuild(source.root, "A"));
    fs.unlinkSync(currentInstallPath());
    expect(readCurrentInstall()).toBeNull();
    expect(launch(state).status).toBe(1);
    fs.writeFileSync(currentInstallPath(), JSON.stringify({ ...a, extra: true }));
    expect(getCurrentInstall().status).toBe("corrupt");
    expect(launch(state).probe).toBeNull();
    fs.writeFileSync(currentInstallPath(), JSON.stringify(a));
    fs.writeFileSync(path.join(a.releaseRoot, "dist/cli/index.js"), 'throw new Error("modified release");');
    expect(launch(state).status).toBe(1);
    expect(launch(state).probe).toBeNull();
  });

  it("拒绝伪造 build-id 和同 buildId 的不同依赖，保留已有 artifact", () => {
    const state = machine(), source = checkout();
    const id = rebuild(source.root, "A");
    installCore(source.root, id);
    fs.writeFileSync(path.join(source.root, "dist/cli/index.js"), "// unbuilt change");
    expect(() => installCore(source.root, id)).toThrow(/实际 runtime artifact/);
    rebuild(source.root, "A");
    fs.writeFileSync(path.join(source.dependency, "index.cjs"), 'module.exports = "changed dependency";');
    expect(() => installCore(source.root, id)).toThrow(/依赖内容在 build 后已改变/);
    expect(launch(state).probe.dependency).toBe("dependency-A");
  });

  it("拒绝指向 checkout 外的依赖链接，不借用其他 workspace", () => {
    const state = machine(), source = checkout(), outside = temp("outside-dependency");
    const id = rebuild(source.root, "A");
    fs.symlinkSync(outside, path.join(source.root, "node_modules", "outside"), process.platform === "win32" ? "junction" : "dir");
    expect(() => installCore(source.root, id)).toThrow(/越过安装边界/);
    expect(fs.existsSync(currentInstallPath())).toBe(false);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("旧 v1 pointer 在 build 前冻结 A，随后失败构建或移走源目录不破坏已安装 A", () => {
    const state = machine(), source = checkout();
    rebuild(source.root, "A");
    fs.rmSync(path.join(source.root, "dist/core-assets"), { recursive: true });
    const idA = writeBuildId(path.join(source.root, "dist"));
    fs.writeFileSync(currentInstallPath(), JSON.stringify({ version: 1, checkoutRoot: source.root,
      runtimeBuildId: idA, installedAt: "2026-09-12T00:00:00.000Z" }));
    expect(() => readCurrentInstall()).toThrow(/尚未冻结/);
    release.protectCurrent(state);
    fs.writeFileSync(path.join(source.root, "dist/cli/index.js"), "// failed partial build");
    fs.renameSync(source.root, path.join(source.parent, "moved"));
    expect(launch(state).probe.marker).toBe("A");
  });

  it("旧 v1 已被未安装构建修改时拒绝冒充原 build；相对 root 拒绝", () => {
    const state = machine(), source = checkout();
    const id = rebuild(source.root, "A");
    fs.writeFileSync(currentInstallPath(), JSON.stringify({ version: 1, checkoutRoot: source.root,
      runtimeBuildId: id, installedAt: "2026-09-12T00:00:00.000Z" }));
    rebuild(source.root, "B");
    const before = fs.readFileSync(currentInstallPath());
    expect(() => release.protectCurrent(state)).toThrow(/实际 runtime artifact/);
    expect(fs.readFileSync(currentInstallPath())).toEqual(before);
    expect(() => installCore("relative-checkout", id)).toThrow(/绝对路径/);
  });
});
