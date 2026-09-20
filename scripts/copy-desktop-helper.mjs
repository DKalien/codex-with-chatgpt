import fs from "node:fs";

// 仅打包受控 helper，不复制 Python 缓存或本机调查产物。
const destination = new URL("../dist/desktop/helper/", import.meta.url);
fs.mkdirSync(destination, { recursive: true });
fs.copyFileSync(new URL("../src/desktop/helper/desktop_ipc.py", import.meta.url), new URL("desktop_ipc.py", destination));
fs.copyFileSync(new URL("../src/desktop/helper/desktop_profiles.json", import.meta.url), new URL("desktop_profiles.json", destination));
