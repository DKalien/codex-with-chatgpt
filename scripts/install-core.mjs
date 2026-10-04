#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import release from "./core-release.cjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const checkoutRoot = path.resolve(scriptDirectory, "..");

function parseArgs(args) {
  let root = checkoutRoot;
  let json = false;
  let protect = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      json = true;
    } else if (argument === "--protect-current") {
      protect = true;
    } else if (argument === "--checkout-root") {
      const value = args[++index];
      if (!value) throw new Error("--checkout-root 需要路径。");
      root = path.resolve(value);
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  return { root, json, protect };
}

/**
 * 安装成功后回收无引用旧 release：复用已安装 launcher 的 `gc --apply`，
 * 完整保留其门禁（maintenance lock、rollout fence、start lock、fresh plan、
 * tombstone + no-follow delete）。仍被 current/runtime 引用的 release 不会被删。
 * best effort：任何失败只降级为警告，不影响安装结果。
 */
function gcOldReleases(stateDir) {
  const launcher = path.join(stateDir, "bin", "c2c.js");
  if (!fs.existsSync(launcher)) {
    return { ok: false, skipped: "launcher_missing" };
  }
  let result;
  try {
    result = spawnSync(process.execPath, [launcher, "gc", "--apply", "--json"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 600_000,
      env: { ...process.env },
    });
  } catch (error) {
    return { ok: false, skipped: `gc_spawn_failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (result.error) {
    return { ok: false, skipped: `gc_spawn_failed: ${result.error.message}` };
  }
  if (result.timeout || typeof result.status !== "number") {
    return { ok: false, skipped: "gc_timeout_or_signal" };
  }
  const line = String(result.stdout ?? "").split("\n").map((entry) => entry.trim()).filter(Boolean).pop();
  let parsed = null;
  try {
    parsed = line ? JSON.parse(line) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.ok !== "boolean") {
    return { ok: false, skipped: `gc_output_unparsable (exit ${result.status})` };
  }
  // exit 1 仅在 ok=false 时出现（--json contract）；两者必须一致才可信。
  if ((result.status === 0) !== parsed.ok) {
    return { ok: false, skipped: "gc_status_mismatch", detail: parsed };
  }
  return parsed;
}

try {
  const { root, json, protect } = parseArgs(process.argv.slice(2));
  // 与 getStateDir 相同的机器目录规则；build 前不能 import 可变的 dist。
  const stateDir = process.env.C2C_STATE_DIR?.trim() ? path.resolve(process.env.C2C_STATE_DIR) : process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "codex-with-chatgpt")
    : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "codex-with-chatgpt")
    : path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "codex-with-chatgpt");
  const metadata = protect ? release.protectCurrent(stateDir) :
    release.installCore(root, fs.readFileSync(path.join(root, "dist", "build-id.txt"), "utf8").trim(), stateDir);
  // 只有真实 install 触发旧 release 回收；protect-current 是冻结修复，不删除任何东西。
  const gc = protect ? { ok: true, skipped: "protect_current" } : gcOldReleases(stateDir);
  const result = { ...metadata, launcherPath: path.join(stateDir, "bin", "c2c.js"), ...(protect ? { protected: true } : {}), gc };
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `stable core 已安装：${JSON.stringify(result)}\n`);
  if (!gc.ok && gc.skipped) {
    process.stderr.write(`旧 release 回收跳过（不影响安装）：${gc.skipped}\n`);
  } else if (!gc.ok) {
    const issues = Array.isArray(gc.issues) ? gc.issues.join("；") : "";
    process.stderr.write(`旧 release 回收未完全成功${issues ? `：${issues}` : ""}\n`);
  } else if (gc.totals && gc.totals.deletedCount > 0) {
    process.stderr.write(`已回收旧 release：${gc.totals.deletedCount} 个（${gc.totals.bytesDeleted} bytes）\n`);
  }
} catch (error) {
  process.stderr.write(`core install 失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
