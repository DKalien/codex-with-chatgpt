import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { checkForUpdates } from "../src/cli/update-check.js";
import { cleanup, git, makeGitRepo, makeTmpDir, write } from "./helpers.js";

describe("Fork 更新检查（真实 Git 仓库）", () => {
  let dir: string;
  let remote: string;
  let local: string;
  let cache: string;
  beforeEach(() => {
    dir = makeTmpDir("update-check");
    remote = path.join(dir, "remote");
    local = path.join(dir, "local");
    cache = path.join(dir, "state", "update-check.json");
    fs.mkdirSync(remote);
    makeGitRepo(remote);
    git(dir, "clone", remote, local);
    // upstream 无法访问：任何误 fetch 都会失败。
    git(local, "remote", "add", "upstream", path.join(dir, "absent-upstream"));
    git(local, "update-ref", "refs/remotes/upstream/main", git(local, "rev-parse", "HEAD").trim());
  });
  afterEach(() => cleanup(dir));
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
