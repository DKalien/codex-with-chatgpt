import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, git, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const devInstallSource = path.join(projectRoot, "scripts", "dev-install.ps1");
const updateSource = path.join(projectRoot, "scripts", "update-upstream-track.ps1");
const skillSource = path.join(projectRoot, "skill", "SKILL.md");

const temporaryDirs: string[] = [];

afterEach(() => {
  while (temporaryDirs.length > 0) cleanup(temporaryDirs.pop()!);
});

function tempDir(name: string): string {
  const dir = makeTmpDir(name);
  temporaryDirs.push(dir);
  return dir;
}

function copyIntoRepo(repo: string, source: string, relativePath: string): string {
  const destination = path.join(repo, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  return destination;
}

function powerShell(script: string, repo: string, args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(repo, "test-global-config"),
    GIT_TERMINAL_PROMPT: "0",
    ...extraEnv,
  };
  // Windows 的环境变量名不区分大小写；Node 只传递排序后的第一个 PATH。
  // 统一名称，确保测试替身不会被宿主机真实 pnpm 绕过。
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") delete env[key];
  }
  env.Path = extraEnv.Path ?? process.env.Path ?? process.env.PATH ?? "";
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
    { cwd: repo, encoding: "utf8", env, windowsHide: true }
  );
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function makeUpstreamRepo(name: string): { repo: string; remote: string; script: string } {
  const repo = tempDir(`fork-${name}`);
  const remote = tempDir(`fork-remote-${name}`);
  makeGitRepo(repo);
  git(remote, "init", "--bare", "-b", "main");
  git(repo, "remote", "add", "upstream", remote);
  git(repo, "push", "upstream", "main");
  const script = copyIntoRepo(repo, updateSource, "scripts/update-upstream-track.ps1");
  return { repo, remote, script };
}

function update(repoInfo: { repo: string; script: string }) {
  return powerShell(repoInfo.script, repoInfo.repo);
}

function makeDevRepo(name: string): { repo: string; script: string; installRoot: string } {
  const repo = tempDir(`dev-install-${name}`);
  makeGitRepo(repo);
  write(repo, "package.json", "{}\n");
  copyIntoRepo(repo, devInstallSource, "scripts/dev-install.ps1");
  copyIntoRepo(repo, skillSource, "skill/SKILL.md");
  return { repo, script: path.join(repo, "scripts", "dev-install.ps1"), installRoot: tempDir(`skill-${name}`) };
}

function makeFakePnpm(): { bin: string; log: string } {
  const bin = tempDir("fake-pnpm");
  const log = path.join(bin, "pnpm-args.log");
  write(
    bin,
    "pnpm.ps1",
    "$argsLine = ($args -join ' ')\nAdd-Content -LiteralPath $env:C2C_FAKE_PNPM_LOG -Value $argsLine\nexit 0\n"
  );
  return { bin, log };
}

function withFakePnpm(fake: { bin: string; log: string }): NodeJS.ProcessEnv {
  const currentPath = process.env.Path ?? process.env.PATH ?? "";
  return {
    Path: `${fake.bin}${path.delimiter}${currentPath}`,
    C2C_FAKE_PNPM_LOG: fake.log,
  };
}

const windowsTests = describe.skipIf(process.platform !== "win32");

windowsTests("fork maintenance scripts", () => {
  it("开发安装运行冻结依赖、构建，并把 Skill 写入隔离目录", () => {
    const fixture = makeDevRepo("install");
    const fake = makeFakePnpm();
    const result = powerShell(
      fixture.script,
      fixture.repo,
      ["-InstallRoot", fixture.installRoot],
      withFakePnpm(fake)
    );

    expect(result.status, result.output).toBe(0);
    const calls = fs.readFileSync(fake.log, "utf8");
    expect(calls).toContain("install --frozen-lockfile");
    expect(calls).toContain("run build");
    expect(calls).not.toContain("test");

    const installed = path.join(fixture.installRoot, "SKILL.md");
    const installedText = fs.readFileSync(installed, "utf8");
    expect(installedText).toContain(fixture.repo);
    expect(installedText).not.toContain("<ACTUAL_CHECKOUT_PATH>");

    fs.chmodSync(installed, 0o444);
    const repeated = powerShell(
      fixture.script,
      fixture.repo,
      ["-InstallRoot", fixture.installRoot],
      withFakePnpm(fake)
    );
    expect(repeated.status).toBe(0);
    expect(fs.readFileSync(installed, "utf8")).toBe(installedText);
    fs.chmodSync(installed, 0o666);
  });

  it("-Test 排除本测试，且 checkout upstream-main 时拒绝安装", () => {
    const fixture = makeDevRepo("guards");
    const fake = makeFakePnpm();
    const testRun = powerShell(
      fixture.script,
      fixture.repo,
      ["-Test", "-InstallRoot", fixture.installRoot],
      withFakePnpm(fake)
    );
    expect(testRun.status, testRun.output).toBe(0);
    expect(fs.readFileSync(fake.log, "utf8")).toContain("test -- --exclude tests/fork-scripts.test.ts");

    git(fixture.repo, "branch", "upstream-main");
    git(fixture.repo, "checkout", "upstream-main");
    fs.writeFileSync(fake.log, "");
    const rejected = powerShell(
      fixture.script,
      fixture.repo,
      ["-InstallRoot", fixture.installRoot],
      withFakePnpm(fake)
    );
    expect(rejected.status).not.toBe(0);
    expect(rejected.output).toContain("upstream-main");
    expect(fs.readFileSync(fake.log, "utf8")).toBe("");
  });

  it("创建 upstream-main 并设置 upstream/main tracking", () => {
    const fixture = makeUpstreamRepo("create");
    const result = update(fixture);

    expect(result.status, result.output).toBe(0);
    const remoteSha = git(fixture.repo, "rev-parse", "refs/remotes/upstream/main").trim();
    expect(git(fixture.repo, "rev-parse", "refs/heads/upstream-main").trim()).toBe(remoteSha);
    expect(git(fixture.repo, "config", "--get", "branch.upstream-main.remote").trim()).toBe("upstream");
    expect(git(fixture.repo, "config", "--get", "branch.upstream-main.merge").trim()).toBe("refs/heads/main");
  });

  it("equal 状态不移动引用，远端快进时只做 fast-forward", () => {
    const fixture = makeUpstreamRepo("states");
    const created = update(fixture);
    expect(created.status, created.output).toBe(0);
    const equalSha = git(fixture.repo, "rev-parse", "refs/heads/upstream-main").trim();
    const equal = update(fixture);
    expect(equal.status).toBe(0);
    expect(git(fixture.repo, "rev-parse", "refs/heads/upstream-main").trim()).toBe(equalSha);

    write(fixture.repo, "remote-change.txt", "remote change\n");
    git(fixture.repo, "add", "remote-change.txt");
    git(fixture.repo, "commit", "-m", "remote change");
    git(fixture.repo, "push", "upstream", "main");
    const fastForward = update(fixture);
    expect(fastForward.status).toBe(0);
    expect(git(fixture.repo, "rev-parse", "refs/heads/upstream-main").trim()).toBe(
      git(fixture.repo, "rev-parse", "refs/remotes/upstream/main").trim()
    );
  });

  it("local-ahead 和 diverged 都停止且不覆盖 upstream-main", () => {
    const ahead = makeUpstreamRepo("ahead");
    const aheadCreated = update(ahead);
    expect(aheadCreated.status, aheadCreated.output).toBe(0);
    write(ahead.repo, "local-only.txt", "local only\n");
    git(ahead.repo, "add", "local-only.txt");
    git(ahead.repo, "commit", "-m", "local only");
    const aheadSha = git(ahead.repo, "rev-parse", "HEAD").trim();
    git(ahead.repo, "update-ref", "refs/heads/upstream-main", aheadSha);
    const aheadResult = update(ahead);
    expect(aheadResult.status).not.toBe(0);
    expect(aheadResult.output).toContain("local-ahead");
    expect(git(ahead.repo, "rev-parse", "refs/heads/upstream-main").trim()).toBe(aheadSha);

    const diverged = makeUpstreamRepo("diverged");
    const divergedCreated = update(diverged);
    expect(divergedCreated.status, divergedCreated.output).toBe(0);
    const writer = tempDir("fork-diverged-writer");
    git(writer, "clone", "--branch", "main", diverged.remote, ".");
    write(diverged.repo, "local-only.txt", "local only\n");
    git(diverged.repo, "add", "local-only.txt");
    git(diverged.repo, "commit", "-m", "local only");
    const divergedSha = git(diverged.repo, "rev-parse", "HEAD").trim();
    git(diverged.repo, "update-ref", "refs/heads/upstream-main", divergedSha);
    write(writer, "remote-only.txt", "remote only\n");
    git(writer, "add", "remote-only.txt");
    git(writer, "commit", "-m", "remote only");
    git(writer, "push", "origin", "main");

    const divergedResult = update(diverged);
    expect(divergedResult.status).not.toBe(0);
    expect(divergedResult.output).toContain("diverged");
    expect(git(diverged.repo, "rev-parse", "refs/heads/upstream-main").trim()).toBe(divergedSha);
  });

  it("linked worktree checkout upstream-main 时拒绝移动", () => {
    const fixture = makeUpstreamRepo("worktree");
    const created = update(fixture);
    expect(created.status, created.output).toBe(0);
    const linked = tempDir("fork-linked-worktree");
    git(fixture.repo, "worktree", "add", linked, "upstream-main");

    const result = update(fixture);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("linked worktree");
    git(fixture.repo, "worktree", "remove", "--force", linked);
  });

  it("同步时保留当前 branch、HEAD、dirty/staged/untracked 工作区和 stash", () => {
    const fixture = makeUpstreamRepo("preserve");
    const created = update(fixture);
    expect(created.status, created.output).toBe(0);
    const writer = tempDir("fork-preserve-writer");
    git(writer, "clone", "--branch", "main", fixture.remote, ".");
    write(writer, "remote-change.txt", "remote change\n");
    git(writer, "add", "remote-change.txt");
    git(writer, "commit", "-m", "remote change");
    git(writer, "push", "origin", "main");
    const oldUpstreamSha = git(fixture.repo, "rev-parse", "refs/heads/upstream-main").trim();

    write(fixture.repo, "stash-source.txt", "stash source\n");
    git(fixture.repo, "add", "stash-source.txt");
    git(fixture.repo, "stash", "push", "-m", "preserve");

    write(fixture.repo, "hello.txt", "dirty\n");
    write(fixture.repo, "staged.txt", "staged\n");
    git(fixture.repo, "add", "staged.txt");
    write(fixture.repo, "untracked.txt", "untracked\n");
    const before = {
      branch: git(fixture.repo, "branch", "--show-current"),
      head: git(fixture.repo, "rev-parse", "HEAD"),
      status: git(fixture.repo, "status", "--porcelain=v1"),
      cached: git(fixture.repo, "diff", "--cached", "--binary"),
      stash: git(fixture.repo, "stash", "list", "--format=%H"),
    };

    const result = update(fixture);
    expect(result.status, result.output).toBe(0);
    expect(git(fixture.repo, "rev-parse", "refs/heads/upstream-main").trim()).not.toBe(oldUpstreamSha);
    expect(git(fixture.repo, "rev-parse", "refs/heads/upstream-main").trim()).toBe(
      git(fixture.repo, "rev-parse", "refs/remotes/upstream/main").trim()
    );
    expect(git(fixture.repo, "branch", "--show-current")).toBe(before.branch);
    expect(git(fixture.repo, "rev-parse", "HEAD")).toBe(before.head);
    expect(git(fixture.repo, "status", "--porcelain=v1")).toBe(before.status);
    expect(git(fixture.repo, "diff", "--cached", "--binary")).toBe(before.cached);
    expect(git(fixture.repo, "stash", "list", "--format=%H")).toBe(before.stash);
  });
});
