import fs from "node:fs";

// 固定 helper 清单；源码目录中的调查产物或新增文件不能随构建进入 dist。
const HELPER_FILES = [
  "desktop_ipc.py",
  "c2c_desktop_ipc/__init__.py",
  "c2c_desktop_ipc/common.py",
  "c2c_desktop_ipc/dispatch.py",
  "c2c_desktop_ipc/history.py",
  "c2c_desktop_ipc/identity.py",
  "c2c_desktop_ipc/operations.py",
  "c2c_desktop_ipc/reconciliation.py",
  "c2c_desktop_ipc/result.py",
  "c2c_desktop_ipc/transport.py",
];
const destination = new URL("../dist/desktop/helper/", import.meta.url);
const source = new URL("../src/desktop/helper/", import.meta.url);
fs.rmSync(destination, { recursive: true, force: true });
for (const relativePath of HELPER_FILES) {
  const target = new URL(relativePath, destination);
  fs.mkdirSync(new URL(".", target), { recursive: true });
  fs.copyFileSync(new URL(relativePath, source), target);
}

// 本机 route 授权使用独立 UI helper，不扩 Desktop IPC 协议。
const routeTarget = new URL("../dist/feedback/local-route-confirm.py", import.meta.url);
fs.mkdirSync(new URL(".", routeTarget), { recursive: true });
fs.copyFileSync(new URL("../src/feedback/local-route-confirm.py", import.meta.url), routeTarget);
