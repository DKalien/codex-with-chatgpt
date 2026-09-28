import type { Command } from "commander";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getStateDir } from "../config/paths.js";
import { checkForUpdates } from "./update-check.js";
import { VERSION } from "../version.js";
import { trySandboxAllow, say, check, cross } from "./shared.js";

export function registerSandboxAllowCommand(program: Command): void {
// ---------------------------------------------------------------- sandbox-allow (Codex writable_roots, macOS + Windows)

program
  .command("sandbox-allow")
  .description("Add the local settings directory to the Codex sandbox allowlist")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    const result = trySandboxAllow();
    if (opts.json) {
      say(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (!result.ok) {
      cross(`无法写入 Codex 沙箱白名单：${result.error}`);
      process.exitCode = 1;
      return;
    }
    if (result.alreadyAllowed) check("沙箱白名单已就绪，后续对话无需再提权");
    else check("已将本地设置目录加入 Codex 沙箱白名单（后续对话无需再提权）");
  });
}

export function registerUpdateCheckCommand(program: Command): void {
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

program
  .command("update-check")
  .description("只检查当前分支对应的 origin 提交（当天缓存 fetch，只报告，不更新工作区）")
  .option("--force", "check even if already checked today", false)
  .option("--json", "machine-readable output", false)
  .action((opts: { force: boolean; json: boolean }) => {
    const result = checkForUpdates(repoRoot, path.join(getStateDir(), "update-check.json"), opts.force);
    if (opts.json) say(JSON.stringify({ version: VERSION, ...result }));
    else say(result.note);
    if (!result.ok) process.exitCode = 1;
  });
}
