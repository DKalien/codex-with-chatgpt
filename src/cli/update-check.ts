import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { readJsonIfExists, writeSecureJson } from "../config/paths.js";

export interface UpdateCheckResult {
  ok: boolean;
  checked: boolean;
  updateAvailable: boolean;
  remoteAhead: boolean;
  localAhead: boolean;
  diverged: boolean;
  dirty?: boolean;
  branch?: string;
  remoteBranch?: string;
  localCommit?: string;
  remoteCommit?: string;
  localAheadCount?: number;
  remoteAheadCount?: number;
  note: string;
}

/** 只更新 origin 的远端引用；每天缓存 fetch，每次重新读取本地状态。 */
export function checkForUpdates(repoRoot: string, cacheFile: string, force = false): UpdateCheckResult {
  const result: UpdateCheckResult = {
    ok: false, checked: false, updateAvailable: false,
    remoteAhead: false, localAhead: false, diverged: false, note: "",
  };
  const git = (...args: string[]): string => {
    const run = spawnSync("git", args, {
      cwd: repoRoot, encoding: "utf8", timeout: 30_000, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_OPTIONAL_LOCKS: "0" },
    });
    // 不回显 stderr：远端地址可能含凭证。
    if (run.status !== 0) throw new Error(`Git ${args[0]} 失败，无法确认 Fork 更新状态；请检查仓库、origin 分支或网络。`);
    return run.stdout.trim();
  };
  try {
    result.dirty = git("status", "--porcelain", "--untracked-files=normal") !== "";
    result.branch = git("symbolic-ref", "--quiet", "--short", "HEAD");
    if (result.branch === "upstream-main") {
      result.note = "upstream-main 是官方只读参考分支，不参与日常 Fork 更新检查。";
      return result;
    }
    const tracking = git("for-each-ref", "--format=%(upstream:remotename)%09%(upstream:remoteref)", `refs/heads/${result.branch}`);
    const [remote, trackedRef] = tracking.split("\t");
    if (remote && remote !== "origin") {
      result.note = "当前分支未跟踪 origin，已跳过；日常检查不会访问其他 remote。";
      return result;
    }
    const remoteRef = remote ? trackedRef : `refs/heads/${result.branch}`;
    if (!remoteRef?.startsWith("refs/heads/")) throw new Error("origin 跟踪分支配置无效，已停止检查。");
    result.remoteBranch = `origin/${remoteRef.slice("refs/heads/".length)}`;
    const target = `refs/remotes/${result.remoteBranch}`;
    const origin = git("remote", "get-url", "origin");
    const key = createHash("sha256").update(JSON.stringify([path.resolve(repoRoot), result.branch, remoteRef, origin])).digest("hex");
    const date = new Date().toLocaleDateString("en-CA");
    const cache = readJsonIfExists<{ key?: string; date?: string; remoteCommit?: string }>(cacheFile);
    // 旧安装的缓存没有 key，不能沿用其 HEAD/SHA 不等判断。
    const currentRemote = git("for-each-ref", "--format=%(objectname)", target);
    if (force || cache?.key !== key || cache.date !== date || !currentRemote || cache.remoteCommit !== currentRemote) {
      git("-c", "maintenance.auto=false", "-c", "gc.auto=0", "fetch", "--no-tags", "--no-recurse-submodules",
        "--no-write-fetch-head", "--refmap=", "origin", `+${remoteRef}:${target}`);
      result.checked = true;
    }
    if (git("symbolic-ref", "--quiet", "--short", "HEAD") !== result.branch) {
      throw new Error("检查期间当前分支发生变化，请重新运行 update-check。");
    }
    result.localCommit = git("rev-parse", "HEAD");
    result.remoteCommit = git("rev-parse", "--verify", `${target}^{commit}`);
    const counts = git("rev-list", "--left-right", "--count", `${result.localCommit}...${result.remoteCommit}`).split(/\s+/).map(Number);
    if (counts.length !== 2 || !counts.every((n) => Number.isSafeInteger(n) && n >= 0)) {
      throw new Error("无法解析 Git 提交领先数量，已停止检查。");
    }
    [result.localAheadCount, result.remoteAheadCount] = counts;
    result.localAhead = counts[0] > 0;
    result.remoteAhead = counts[1] > 0;
    result.diverged = result.localAhead && result.remoteAhead;
    result.updateAvailable = result.remoteAhead && !result.diverged;
    result.dirty = git("status", "--porcelain", "--untracked-files=normal") !== "";
    result.ok = true;
    result.note = result.diverged
      ? `本地与 ${result.remoteBranch} 已分叉（本地领先 ${counts[0]}，远端领先 ${counts[1]}），请人工处理。`
      : result.remoteAhead
        ? `你的 Fork 有 ${counts[1]} 个新的远端提交，是否更新由你决定。`
        : result.localAhead
          ? `本地领先 ${result.remoteBranch} ${counts[0]} 个提交，远端没有待更新提交。`
          : `本地与 ${result.remoteBranch} 一致。`;
    if (result.dirty) result.note += " 工作区有未提交修改，已保留。";
    if (result.checked) {
      try {
        writeSecureJson(cacheFile, { key, date, remoteCommit: result.remoteCommit });
      } catch {
        result.note += " 无法保存检查缓存，下次将重新 fetch origin。";
      }
    }
  } catch (error) {
    result.note = (error as Error).message;
  }
  return result;
}
