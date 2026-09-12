#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
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

try {
  const { root, json, protect } = parseArgs(process.argv.slice(2));
  // 与 getStateDir 相同的机器目录规则；build 前不能 import 可变的 dist。
  const stateDir = process.env.C2C_STATE_DIR?.trim() ? path.resolve(process.env.C2C_STATE_DIR) : process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "codex-with-chatgpt")
    : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "codex-with-chatgpt")
    : path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "codex-with-chatgpt");
  const metadata = protect ? release.protectCurrent(stateDir) :
    release.installCore(root, fs.readFileSync(path.join(root, "dist", "build-id.txt"), "utf8").trim(), stateDir);
  const result = { ...metadata, launcherPath: path.join(stateDir, "bin", "c2c.js"), ...(protect ? { protected: true } : {}) };
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `stable core 已安装：${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`core install 失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
