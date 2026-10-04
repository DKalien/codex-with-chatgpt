import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { checkForUpdates } from "../src/cli/update-check.js";
import { git, makeGitRepo, makeTmpDir, write } from "./helpers.js";
import { cleanupStrict } from "./strict-teardown.js";
import { treeSnapshot } from "../scripts/test-full-candidate.mjs";

function pairSnapshot(root: string): ReturnType<typeof treeSnapshot> {
  expect(fs.realpathSync.native(root)).toBe(root);
  const snapshot = treeSnapshot(root); // Includes .git refs/config/objects; rejects links.
  for (const [relative, value] of Object.entries(snapshot)) {
    if (value !== "directory") expect(fs.lstatSync(path.join(root, relative)).nlink).toBe(1);
  }
  for (const repo of ["remote", "local"]) {
    const gitDir = path.join(root, repo, ".git");
    expect(fs.lstatSync(gitDir).isDirectory()).toBe(true);
    for (const shared of ["commondir", "gitdir", "objects/info/alternates", "objects/info/http-alternates"]) {
      expect(fs.existsSync(path.join(gitDir, shared))).toBe(false);
    }
  }
  return snapshot;
}

describe("Fork 更新检查（真实 Git 仓库）", () => {
  let dir: string;
  let remote: string;
  let local: string;
  let cache: string;
  let seedRoot: string | undefined;
  let seed: { snapshot: ReturnType<typeof pairSnapshot>; origin: string; upstream: string } | undefined;
  const copies: string[] = [];
  beforeAll(() => {
    // Match helpers.git so seed validation and checkForUpdates see the same config sources.
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
    vi.stubEnv("GIT_CONFIG_SYSTEM", "/dev/null");
  });
  beforeEach(() => {
    if (!seed) {
      if (seedRoot) throw new Error("update-check seed construction failed; refusing another seed");
      seedRoot = makeTmpDir("update-check-seed"); // Track partial construction for strict teardown.
      const seedRemote = path.join(seedRoot, "remote"), seedLocal = path.join(seedRoot, "local");
      fs.mkdirSync(seedRemote);
      makeGitRepo(seedRemote);
      git(seedRoot, "clone", "--no-hardlinks", seedRemote, seedLocal);
      git(seedLocal, "remote", "set-url", "origin", "../remote");
      // upstream remains a real unreachable relative path inside each copied pair.
      git(seedLocal, "remote", "add", "upstream", "../absent-upstream");
      git(seedLocal, "update-ref", "refs/remotes/upstream/main", git(seedLocal, "rev-parse", "HEAD").trim());
      const origin = git(seedLocal, "remote", "get-url", "origin").trim();
      const upstream = git(seedLocal, "remote", "get-url", "upstream").trim();
      expect(origin).toBe("../remote");
      expect(upstream).toBe("../absent-upstream");
      seed = { snapshot: pairSnapshot(seedRoot), origin, upstream };
    }
    dir = makeTmpDir("update-check");
    copies.push(dir);
    expect(dir).not.toBe(seedRoot);
    fs.cpSync(seedRoot!, dir, { recursive: true, force: false, errorOnExist: true });
    // Exact copied config bytes retain the URLs verified once with real Git above.
    expect(pairSnapshot(dir)).toEqual(seed.snapshot);
    remote = path.join(dir, "remote");
    local = path.join(dir, "local");
    cache = path.join(dir, "state", "update-check.json");
    expect(fs.realpathSync.native(local)).toBe(local);
    expect(fs.realpathSync.native(path.resolve(local, seed.origin))).toBe(remote);
    expect(remote).not.toBe(path.join(seedRoot!, "remote"));
    const missingUpstream = path.resolve(local, seed.upstream);
    expect(missingUpstream).toBe(path.join(dir, "absent-upstream"));
    expect(fs.existsSync(missingUpstream)).toBe(false);
  });
  afterEach(async () => {
    try {
      if (seed) expect(pairSnapshot(seedRoot!)).toEqual(seed.snapshot);
    } finally {
      await cleanupStrict(...copies.splice(0));
    }
  });
  afterAll(async () => {
    try { if (seedRoot) await cleanupStrict(seedRoot); }
    finally { vi.unstubAllEnvs(); }
  });
  const commit = (repo: string, name: string) => {
    write(repo, `${name}.txt`, name);
    git(repo, "add", `${name}.txt`);
    git(repo, "commit", "-m", name);
  };

  it("equal 不算更新，旧 checkout 缓存不能复用", () => {
    write(path.dirname(cache), path.basename(cache), JSON.stringify({ date: new Date().toLocaleDateString("en-CA"), updateAvailable: true }));
    expect(checkForUpdates(local, cache)).toMatchObject({
      ok: true, checked: true, updateAvailable: false, remoteAhead: false, localAhead: false,
      diverged: false, dirty: false, localAheadCount: 0, remoteAheadCount: 0, remoteBranch: "origin/main",
    });
    expect(checkForUpdates(local, cache)).toMatchObject({ ok: true, checked: false, updateAvailable: false });
  });

  it("remote ahead 才提示更新，保留 HEAD / index / stash / dirty working tree / upstream", () => {
    commit(remote, "remote-change");
    write(local, "hello.txt", "待提交的修改");
    git(local, "add", "hello.txt");
    write(local, "hello.txt", "尚未暂存的修改");
    write(local, "untracked.txt", "未跟踪文件");
    const before = {
      head: git(local, "rev-parse", "HEAD"), branch: git(local, "symbolic-ref", "HEAD"),
      status: git(local, "status", "--porcelain"), stash: git(local, "stash", "list"),
      upstream: git(local, "rev-parse", "refs/remotes/upstream/main"),
      index: fs.readFileSync(path.join(local, ".git", "index")),
    };
    expect(checkForUpdates(local, cache)).toMatchObject({
      ok: true, updateAvailable: true, remoteAhead: true, localAhead: false,
      diverged: false, dirty: true, localAheadCount: 0, remoteAheadCount: 1,
    });
    expect(fs.readFileSync(path.join(local, ".git", "index"))).toEqual(before.index);
    expect(git(local, "rev-parse", "HEAD")).toBe(before.head);
    expect(git(local, "symbolic-ref", "HEAD")).toBe(before.branch);
    expect(git(local, "status", "--porcelain")).toBe(before.status);
    expect(git(local, "stash", "list")).toBe(before.stash);
    expect(git(local, "rev-parse", "refs/remotes/upstream/main")).toBe(before.upstream);
    expect(fs.readFileSync(path.join(local, "hello.txt"), "utf8")).toBe("尚未暂存的修改");
    expect(fs.readFileSync(path.join(local, "untracked.txt"), "utf8")).toBe("未跟踪文件");
  });

  it("local ahead 不算更新，命中日缓存后本地 HEAD 和 dirty 仍实时计算", () => {
    checkForUpdates(local, cache);
    commit(local, "local-change");
    write(local, "untracked.txt", "未提交");
    expect(checkForUpdates(local, cache)).toMatchObject({
      ok: true, checked: false, updateAvailable: false, remoteAhead: false, localAhead: true,
      diverged: false, dirty: true, localAheadCount: 1, remoteAheadCount: 0,
    });
  });

  it("diverged 单独报告，不视为可更新，也不合入任何提交", () => {
    commit(local, "local-change");
    commit(remote, "remote-change");
    const head = git(local, "rev-parse", "HEAD");
    expect(checkForUpdates(local, cache)).toMatchObject({
      ok: true, updateAvailable: false, remoteAhead: true, localAhead: true,
      diverged: true, localAheadCount: 1, remoteAheadCount: 1,
    });
    expect(git(local, "rev-parse", "HEAD")).toBe(head);
  });

  it("比较当前分支对应 origin tracking branch，切换分支使缓存失效", () => {
    checkForUpdates(local, cache);
    git(remote, "checkout", "-b", "dev");
    commit(remote, "dev-change");
    git(local, "fetch", "origin");
    git(local, "checkout", "-b", "feature", "--track", "origin/dev");
    expect(checkForUpdates(local, cache)).toMatchObject({
      ok: true, checked: true, updateAvailable: false, branch: "feature", remoteBranch: "origin/dev",
    });
    git(local, "checkout", "-b", "dev");
    expect(checkForUpdates(local, cache)).toMatchObject({ ok: true, remoteBranch: "origin/dev" });
  });

  it("upstream tracking 和 detached HEAD 跳过，不访问 upstream", () => {
    git(local, "branch", "--set-upstream-to", "upstream/main");
    expect(checkForUpdates(local, cache)).toMatchObject({ ok: false, checked: false, updateAvailable: false });
    expect(fs.existsSync(cache)).toBe(false);
    git(local, "checkout", "--detach");
    expect(checkForUpdates(local, cache)).toMatchObject({ ok: false, checked: false });
  });

  it("远端同日变化由 force 刷新，fetch 失败不伪报一致，不缓存失败", () => {
    checkForUpdates(local, cache);
    commit(remote, "remote-change");
    expect(checkForUpdates(local, cache)).toMatchObject({ checked: false, updateAvailable: false });
    expect(checkForUpdates(local, cache, true)).toMatchObject({ checked: true, updateAvailable: true });
    const saved = fs.readFileSync(cache, "utf8");
    git(local, "remote", "set-url", "origin", path.join(dir, "absent-origin"));
    expect(checkForUpdates(local, cache)).toMatchObject({ ok: false, checked: false, updateAvailable: false });
    expect(fs.readFileSync(cache, "utf8")).toBe(saved);
  });
});
