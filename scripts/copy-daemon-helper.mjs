import fs from "node:fs";

// 固定 helper 清单；源码目录中的调查产物或新增文件不能随构建进入 dist。
const HELPER_FILES = [
  "daemon_spawn.py",
];
const destination = new URL("../dist/process/helper/", import.meta.url);
const source = new URL("../src/process/helper/", import.meta.url);
fs.rmSync(destination, { recursive: true, force: true });
for (const relativePath of HELPER_FILES) {
  const target = new URL(relativePath, destination);
  fs.mkdirSync(new URL(".", target), { recursive: true });
  fs.copyFileSync(new URL(relativePath, source), target);
}
