#!/usr/bin/env node
/**
 * Package the Edge MV3 browser companion into dist/browser-companion.
 * No bundler framework — copy + compile shared route parser only.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcCompanion = path.join(root, "browser-companion");
const distCompanion = path.join(root, "dist", "browser-companion");
const routeJs = path.join(root, "dist", "chatgpt", "route.js");

function fail(msg) {
  console.error(`build-browser-companion: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(routeJs)) {
  fail(`missing compiled route module at ${routeJs}; run tsc first`);
}

const routeEsm = fs.readFileSync(routeJs, "utf8");
if (!routeEsm.includes("parseChatgptConversationRoute")) {
  fail("compiled route.js does not export parseChatgptConversationRoute");
}

function toGlobalScript(esm) {
  let body = esm
    .replace(/^import\s+.*?;\s*$/gm, "")
    .replace(/^export\s+type\s+[^;]+;\s*$/gm, "")
    .replace(/^export\s+\{[^}]+\}\s*;\s*$/gm, "")
    .replace(/^export\s+function\s+/gm, "function ")
    .replace(/^export\s+class\s+/gm, "class ")
    .replace(/^export\s+const\s+/gm, "const ");
  body += `
;globalThis.parseChatgptConversationRoute = parseChatgptConversationRoute;
globalThis.normalizeChatgptConversationRoute = normalizeChatgptConversationRoute;
globalThis.normalizeControlConversationUrl = normalizeControlConversationUrl;
globalThis.isChatgptConversationRoute = isChatgptConversationRoute;
globalThis.ChatGptRouteError = ChatGptRouteError;
`;
  return body;
}

function stripExports(text) {
  return text
    .replace(/^export\s+const\s+/gm, "const ")
    .replace(/^export\s+function\s+/gm, "function ")
    .replace(/^export\s+class\s+/gm, "class ")
    .replace(/^export\s+\{[^}]+\}\s*;\s*$/gm, "");
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === "src") continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(src, dest);
    } else if (entry.isFile()) {
      if (entry.name === "route-esm.js" || entry.name === "route-global.js") continue;
      fs.copyFileSync(src, dest);
    }
  }
}

fs.rmSync(distCompanion, { recursive: true, force: true });
copyDir(srcCompanion, distCompanion);

const domAdapter = fs.readFileSync(path.join(srcCompanion, "dom-adapter.js"), "utf8");
fs.writeFileSync(
  path.join(distCompanion, "dom-adapter.js"),
  stripExports(domAdapter) + `
;globalThis.observeChatGptSafety = observeChatGptSafety;
globalThis.fakeDom = fakeDom;
globalThis.unsafeDomSafety = unsafeDomSafety;
`,
  "utf8",
);

fs.copyFileSync(routeJs, path.join(distCompanion, "route-esm.js"));
fs.writeFileSync(path.join(distCompanion, "route-global.js"), toGlobalScript(routeEsm), "utf8");

const manifestPath = path.join(distCompanion, "manifest.json");
if (!fs.existsSync(manifestPath)) fail("manifest.json missing after copy");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.manifest_version !== 3) fail("manifest_version must be 3");
const hosts = manifest.host_permissions ?? [];
for (const h of hosts) {
  if (h === "<all_urls>" || h.includes("*://*/*")) fail(`forbidden host permission: ${h}`);
}
const banned = ["debugger", "nativeMessaging", "webRequest", "webRequestBlocking"];
for (const p of manifest.permissions ?? []) {
  if (banned.includes(p)) fail(`forbidden permission: ${p}`);
}

const requiredFiles = [
  "manifest.json",
  "service-worker.js",
  "content-script.js",
  "ownership.js",
  "dom-adapter.js",
  "route-esm.js",
  "route-global.js",
  "popup/popup.html",
  "popup/popup.js",
];
for (const f of requiredFiles) {
  if (!fs.existsSync(path.join(distCompanion, f))) fail(`packaged file missing: ${f}`);
}

for (const f of ["ownership.js", "dom-adapter.js", "content-script.js", "service-worker.js"]) {
  const text = fs.readFileSync(path.join(distCompanion, f), "utf8");
  if (/require\(["']node:/.test(text) || /from ["']node:/.test(text)) {
    fail(`${f} must not use Node-only imports`);
  }
}

console.log(`browser-companion packaged → ${path.relative(root, distCompanion)}`);
