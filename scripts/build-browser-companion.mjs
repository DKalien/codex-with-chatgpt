#!/usr/bin/env node
/** 打包 MV3 网页伴侣到 dist/browser-companion：复制扩展文件，并把 ESM 适配器转成 classic content script。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "browser-companion");
const dist = path.join(root, "dist", "browser-companion");

const read = (name) => fs.readFileSync(path.join(src, name), "utf8");
const write = (name, text) => fs.writeFileSync(path.join(dist, name), text, "utf8");

/** 去掉 import/export 关键字，返回 classic 源码与导出名。 */
function strip(esm) {
  const names = [...esm.matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/gm)].map((m) => m[1]);
  const body = esm
    .replace(/^import\s[^;]*?from\s+"[^"]+";\s*$/gm, "")
    .replace(/^export\s+(?=async\s+function|function|const|class)/gm, "");
  return { body, names };
}
const expose = (names, prefix = "") => names.map((n) => `globalThis.${prefix}${n} = ${n};`).join("\n");

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, "popup"), { recursive: true });
for (const f of ["manifest.json", "background.js", "content.js", "popup/popup.html", "popup/popup.js"]) {
  fs.copyFileSync(path.join(src, f), path.join(dist, f));
}

// dom-adapter / turn-observer：顶层声明，导出名挂到 globalThis（后加载的脚本直接引用）
for (const [file, out] of [["dom-adapter.js", "dom-adapter-global.js"], ["turn-observer.js", "turn-observer-global.js"]]) {
  const { body, names } = strip(read(file));
  write(out, `${body}\n;${expose(names)}\n`);
}

// 写入 / 点击适配器：IIFE 隔离，只暴露 content.js 需要的入口
const write_ = strip(read("composer-write-adapter.js"));
write(
  "composer-write-adapter.js",
  `(function () {\n${write_.body}\n;globalThis.__c2cWriteCanonicalMessage = writeCanonicalMessage;\nglobalThis.__c2cReadCanonicalComposerText = readCanonicalComposerText;\nglobalThis.__c2cClearComposerIfExact = clearComposerIfExact;\n})();\n`,
);
const click = strip(read("send-click-adapter.js"));
write(
  "send-click-adapter.js",
  `(function () {\nconst readCanonicalComposerText = globalThis.__c2cReadCanonicalComposerText;\n${click.body}\n;globalThis.__c2cDispatchNativeSend = dispatchNativeSend;\n})();\n`,
);

console.log(`build-browser-companion: ${dist}`);
