#!/usr/bin/env node
"use strict";

async function main() {
  // 仅加载机器 bin 下随 launcher 安装的 Node-only 格式校验器，不加载 checkout。
  const fs = (await import("node:fs")).default;
  const path = (await import("node:path")).default;
  const { pathToFileURL } = await import("node:url");
  const { spawnSync } = await import("node:child_process");
  const launcher = path.resolve(process.argv[1]);
  const bin = path.dirname(launcher);
  const helper = path.join(bin, "core-release.cjs");
  // machine bin 是本机信任根；允许更新后的 helper 在 pointer 切换前验证旧 release。
  for (const file of [launcher, helper]) {
    if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file) throw new Error("machine bootstrap 路径身份不匹配");
  }
  const { default: release } = await import(pathToFileURL(helper).href);
  const metadata = release.readCurrent(path.dirname(bin), "fast");
  if (!metadata) throw new Error("current.json 缺失");
  const entry = path.join(metadata.releaseRoot, "bin", "c2c.js");
  const result = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = typeof result.status === "number" ? result.status : 1;
}
main().catch(error => {
  process.stderr.write(`c2c launcher: ${error instanceof Error ? error.message : "启动失败"}\n`);
  process.exitCode = 1;
});
