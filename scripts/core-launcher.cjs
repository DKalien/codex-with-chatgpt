#!/usr/bin/env node
"use strict";

async function main() {
  // 仅加载机器 bin 下随 launcher 安装的 Node-only 格式校验器，不加载 checkout。
  const fs = (await import("node:fs")).default;
  const path = (await import("node:path")).default;
  const { pathToFileURL } = await import("node:url");
  const { spawnSync } = await import("node:child_process");
  const bin = path.dirname(fs.realpathSync(process.argv[1]));
  const { default: release } = await import(pathToFileURL(path.join(bin, "core-release.cjs")).href);
  const metadata = release.readCurrent(path.dirname(bin));
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
