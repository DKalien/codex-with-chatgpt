#!/usr/bin/env node
/**
 * Package the Edge MV3 browser companion into dist/browser-companion.
 * No bundler framework — copy compiled browser-safe shared modules.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcCompanion = path.join(root, "browser-companion");
const distCompanion = path.join(root, "dist", "browser-companion");
const routeJs = path.join(root, "dist", "chatgpt", "route.js");
const completionJs = path.join(root, "dist", "browser", "completion-notification.js");

function fail(msg) {
  console.error(`build-browser-companion: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(routeJs)) {
  fail(`missing compiled route module at ${routeJs}; run tsc first`);
}

if (!fs.existsSync(completionJs)) {
  fail(`missing compiled completion module at ${completionJs}; run tsc first`);
}
const completionEsm = fs.readFileSync(completionJs, "utf8");
if (!/export function renderCompletionNotification/.test(completionEsm) || /^import\s/m.test(completionEsm)) {
  fail("completion-notification.js must export a dependency-free browser renderer");
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
    .replace(/^export\s+async\s+function\s+/gm, "async function ")
    .replace(/^export\s+function\s+/gm, "function ")
    .replace(/^export\s+class\s+/gm, "class ")
    .replace(/^export\s+const\s+/gm, "const ");
  body += `
;globalThis.parseChatgptConversationRoute = parseChatgptConversationRoute;
globalThis.areChatgptConversationRoutesEquivalent = areChatgptConversationRoutesEquivalent;
globalThis.normalizeChatgptConversationRoute = normalizeChatgptConversationRoute;
globalThis.normalizeControlConversationUrl = normalizeControlConversationUrl;
globalThis.isChatgptConversationRoute = isChatgptConversationRoute;
globalThis.ChatGptRouteError = ChatGptRouteError;
`;
  return body;
}

function stripExports(text) {
  return text
    .replace(/^import\s+[\s\S]*?from\s+"[^"]+";\s*$/gm, "")
    .replace(/^import\s+.*?;\s*$/gm, "")
    .replace(/^export\s+const\s+/gm, "const ")
    .replace(/^export\s+async\s+function\s+/gm, "async function ")
    .replace(/^export\s+function\s+/gm, "function ")
    .replace(/^export\s+class\s+/gm, "class ")
    .replace(/^export\s+\{[^}]+\}\s*;\s*$/gm, "");
}

const sourceFiles = [
  "manifest.json", "bridge-client.js", "bridge-operations.js", "bridge-origin.js",
  "project-context.js", "content-lite.js", "popup/lightweight.html", "popup/lightweight.js",
  "operations/operations.html", "operations/operations.css", "operations/operations.js",
  "operations/view.js", "operations/history.js",
];
fs.rmSync(distCompanion, { recursive: true, force: true });
for (const file of sourceFiles) {
  const destination = path.join(distCompanion, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(srcCompanion, file), destination);
}
fs.copyFileSync(completionJs, path.join(distCompanion, "completion-notification.js"));

const domAdapter = fs.readFileSync(path.join(srcCompanion, "dom-adapter.js"), "utf8");
// 现役 DOM 模块仅生成 classic content script；ESM 源码供共享模块测试。
fs.writeFileSync(
  path.join(distCompanion, "dom-adapter-global.js"),
  stripExports(domAdapter) + `
;globalThis.observeChatGptSafety = observeChatGptSafety;
globalThis.fakeDom = fakeDom;
globalThis.unsafeDomSafety = unsafeDomSafety;
globalThis.resolveChatGptComposer = resolveChatGptComposer;
globalThis.isExcludedEmbeddedEditor = isExcludedEmbeddedEditor;
globalThis.resolveChatGptAction = resolveChatGptAction;
globalThis.matchesSendTargetIdentity = matchesSendTargetIdentity;
globalThis.normalizeCanonicalDomText = normalizeCanonicalDomText;
globalThis.inspectChatGptActionEvidence = inspectChatGptActionEvidence;
globalThis.inspectActiveComposerControls = inspectActiveComposerControls;
globalThis.inspectComposerContainerInventory = inspectComposerContainerInventory;
globalThis.summarizeStopButtonEvidence = summarizeStopButtonEvidence;
`,
  "utf8",
);

// 只读 turn observer 生成 classic content script。
const turnObserver = fs.readFileSync(path.join(srcCompanion, "turn-observer.js"), "utf8");
if (/writeCanonicalMessage|dispatchNativeSend|\.click\(\)/.test(turnObserver)) {
  fail("turn-observer.js must stay read-only (no write/dispatch/click)");
}
fs.writeFileSync(
  path.join(distCompanion, "turn-observer-global.js"),
  stripExports(turnObserver.replace(/^import\s+.*?;\s*$/gm, "")) + `
;globalThis.snapshotUserTurns = snapshotUserTurns;
globalThis.findCanonicalUserTurn = findCanonicalUserTurn;
globalThis.hasExactAttemptMarker = hasExactAttemptMarker;
globalThis.collectBoundedDescendants = collectBoundedDescendants;
`,
  "utf8",
);

// E1b3d2a: write-only runtime capability. Zero Send / click / journal / chrome.
const writeAdapter = fs.readFileSync(path.join(srcCompanion, "composer-write-adapter.js"), "utf8");
if (/dispatchNativeSend|\.click\(\)|begin-send|\/ack\b|chrome\.tabs|chrome\.runtime|fetch\(/.test(
  // Strip line comments before gate so prose cannot trip the write-only ban.
  writeAdapter.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""),
)) {
  fail("composer-write-adapter.js must stay write-only (no send/click/chrome/fetch)");
}
const writeAdapterBody = stripExports(
  writeAdapter
    .replace(/^import\s+[\s\S]*?from\s+"[^"]+";\s*$/gm, "")
    .replace(/^import\s+.*?;\s*$/gm, ""),
);
const writeAdapterClassic = `// classic write-only runtime capability (E1b3d2a)
(function () {
${writeAdapterBody}
;globalThis.__c2cInspectComposerWriteCapability = inspectComposerWriteCapability;
globalThis.__c2cWriteCanonicalMessage = writeCanonicalMessage;
globalThis.__c2cVerifyCanonicalComposer = verifyCanonicalComposer;
globalThis.__c2cReadCanonicalComposerText = readCanonicalComposerText;
})();
`;
if (/dispatchNativeSend|\.click\(\)/.test(writeAdapterClassic)) {
  fail("classic composer-write-adapter must not contain dispatchNativeSend or .click()");
}
fs.writeFileSync(path.join(distCompanion, "composer-write-adapter.js"), writeAdapterClassic, "utf8");

// E1b3d3a: runtime click capability. Only module allowed .click().
const clickAdapter = fs.readFileSync(path.join(srcCompanion, "send-click-adapter.js"), "utf8");
const clickCode = clickAdapter.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
if (/execCommand|writeCanonicalMessage|chrome\.tabs|chrome\.runtime|fetch\(|begin-send|\/ack\b/.test(clickCode)) {
  fail("send-click-adapter.js must not contain write/chrome/fetch/journal/ack");
}
if (!/\.click\(\)/.test(clickCode)) {
  fail("send-click-adapter.js must contain the single runtime .click()");
}
const clickBody = stripExports(
  clickAdapter
    .replace(/^import\s+[\s\S]*?from\s+"[^"]+";\s*$/gm, "")
    .replace(/^import\s+.*?;\s*$/gm, ""),
);
// IIFE + explicit namespaced bindings: write-adapter classic is IIFE-isolated,
// so free names like readCanonicalComposerText are not classic globals.
const clickClassic = `// classic runtime click capability (E1b3d3a)
(function () {
const resolveChatGptComposer = globalThis.resolveChatGptComposer;
const resolveChatGptAction = globalThis.resolveChatGptAction;
const normalizeCanonicalDomText = globalThis.normalizeCanonicalDomText;
const readCanonicalComposerText = globalThis.__c2cReadCanonicalComposerText;
${clickBody}
;globalThis.__c2cDispatchNativeSend = dispatchNativeSend;
})();
`;
if (/\.click\(\)/.test(clickClassic) === false) {
  fail("classic send-click-adapter must retain .click()");
}
if (!/^\(function \(\)/.test(clickClassic.replace(/^\/\/.*\n/, ""))) {
  fail("classic send-click-adapter must be wrapped in IIFE");
}
for (const bindName of [
  "globalThis.resolveChatGptComposer",
  "globalThis.resolveChatGptAction",
  "globalThis.normalizeCanonicalDomText",
  "globalThis.__c2cReadCanonicalComposerText",
]) {
  if (!clickClassic.includes(bindName)) {
    fail(`classic send-click-adapter must bind ${bindName}`);
  }
}
if (!/globalThis\.__c2cDispatchNativeSend\s*=\s*dispatchNativeSend/.test(clickClassic)) {
  fail("classic send-click-adapter must expose __c2cDispatchNativeSend");
}
if (/globalThis\.readCanonicalComposerText\s*=/.test(clickClassic)) {
  fail("classic send-click-adapter must not expose unnamespaced readCanonicalComposerText");
}
fs.writeFileSync(path.join(distCompanion, "send-click-adapter.js"), clickClassic, "utf8");

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
  ...sourceFiles, "completion-notification.js", "route-esm.js", "route-global.js",
  "dom-adapter-global.js", "turn-observer-global.js", "composer-write-adapter.js", "send-click-adapter.js",
];
for (const f of requiredFiles) {
  if (!fs.existsSync(path.join(distCompanion, f))) fail(`packaged file missing: ${f}`);
}

const popupHtml = fs.readFileSync(path.join(distCompanion, manifest.action.default_popup), "utf8");
const popupScripts = [...popupHtml.matchAll(/<script\b([^>]*)><\/script>/gi)]
  .map(([, attributes]) => ({
    attributes,
    src: /\bsrc=["']([^"']+)["']/i.exec(attributes)?.[1] ?? null,
  }));
for (const bannedPopupScript of ["dom-adapter.js", "turn-observer.js", "route-attestation.js", "route-attestation-run.js"]) {
  if (popupScripts.some(({ src }) => src?.split(/[\\/]/).pop() === bannedPopupScript)) {
    fail(`popup.html must not load ESM artifact as classic script: ${bannedPopupScript}`);
  }
}
for (const { attributes, src } of popupScripts) {
  if (/\btype=["']module["']/i.test(attributes)) continue;
  if (!src) fail("popup classic script must reference a packaged artifact");
  const artifact = path.resolve(distCompanion, "popup", src);
  if (!artifact.startsWith(`${distCompanion}${path.sep}`) || !fs.existsSync(artifact)) {
    fail(`popup classic script missing or outside package: ${src}`);
  }
  try {
    new vm.Script(fs.readFileSync(artifact, "utf8"), { filename: src });
  } catch (error) {
    fail(`popup classic script contains unsupported syntax (${src}): ${error.message}`);
  }
}

const distDomGlobal = fs.readFileSync(path.join(distCompanion, "dom-adapter-global.js"), "utf8");
if (/^\s*import\s/m.test(distDomGlobal) || /^\s*export\s/m.test(distDomGlobal)) {
  fail("dom-adapter-global.js must be classic (no top-level import/export)");
}
if (!/globalThis\.resolveChatGptComposer\s*=/.test(distDomGlobal)) {
  fail("dom-adapter-global.js must expose resolveChatGptComposer");
}
const distTurnGlobal = fs.readFileSync(path.join(distCompanion, "turn-observer-global.js"), "utf8");
if (/^\s*import\s/m.test(distTurnGlobal) || /^\s*export\s/m.test(distTurnGlobal)) {
  fail("turn-observer-global.js must be classic (no top-level import/export)");
}
if (!/globalThis\.collectBoundedDescendants\s*=/.test(distTurnGlobal)) {
  fail("turn-observer-global.js must expose collectBoundedDescendants");
}
if (!/globalThis\.snapshotUserTurns\s*=/.test(distTurnGlobal)) {
  fail("turn-observer-global.js must expose snapshotUserTurns");
}
for (const [name, observer] of [
  ["source", turnObserver], ["classic", distTurnGlobal],
]) {
  const code = observer.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
  if (!code.includes('[data-user-message-bubble="true"]')
    || !code.includes('getAttribute?.("data-user-message-bubble")')) {
    fail(`${name} turn-observer must discover exact modern USER bubbles`);
  }
  if (/\.(?:click|dispatchEvent|setAttribute|removeAttribute|appendChild|removeChild|replaceChild|insertBefore|replaceChildren|scrollIntoView|focus)\s*\(|\.(?:innerText|textContent|innerHTML|outerHTML|value)\s*=|querySelectorAll\s*\(\s*["'`]\*["'`]\s*\)/.test(code)) {
    fail(`${name} turn-observer must stay read-only and use bounded scans`);
  }
}

// content_scripts 保持 classic 语法和现役加载顺序。
const csJs = (manifest.content_scripts ?? []).flatMap((cs) => cs.js ?? []);
const lightweightOrder = ["route-global.js","dom-adapter-global.js","turn-observer-global.js","composer-write-adapter.js","send-click-adapter.js","content-lite.js"];
if (JSON.stringify(csJs) !== JSON.stringify(lightweightOrder)) fail("lightweight content_scripts order mismatch");
for (const f of csJs) {
  const p = path.join(distCompanion, f);
  if (!fs.existsSync(p)) fail(`content script missing from dist: ${f}`);
  const text = fs.readFileSync(p, "utf8");
  if (/^\s*import\s/m.test(text) || /^\s*export\s/m.test(text)) {
    fail(`content script ${f} is not classic JS (top-level import/export)`);
  }
  try {
    new Function(text);
  } catch (e) {
    fail(`content script ${f} failed classic parse: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// send-click-adapter classic: IIFE + namespaced write/DOM deps; providers must precede it.
const clickIdx = csJs.indexOf("send-click-adapter.js");
if (clickIdx < 0) fail("manifest missing send-click-adapter.js");
const sendClickDeps = [
  { symbol: "resolveChatGptComposer", file: "dom-adapter-global.js", expose: /globalThis\.resolveChatGptComposer\s*=/ },
  { symbol: "resolveChatGptAction", file: "dom-adapter-global.js", expose: /globalThis\.resolveChatGptAction\s*=/ },
  { symbol: "normalizeCanonicalDomText", file: "dom-adapter-global.js", expose: /globalThis\.normalizeCanonicalDomText\s*=/ },
  { symbol: "__c2cReadCanonicalComposerText", file: "composer-write-adapter.js", expose: /globalThis\.__c2cReadCanonicalComposerText\s*=/ },
];
for (const dep of sendClickDeps) {
  const idx = csJs.indexOf(dep.file);
  if (idx < 0) fail(`send-click dep ${dep.symbol}: manifest missing ${dep.file}`);
  if (idx >= clickIdx) {
    fail(`send-click dep ${dep.symbol}: ${dep.file} must load before send-click-adapter.js`);
  }
  const providerText = fs.readFileSync(path.join(distCompanion, dep.file), "utf8");
  if (!dep.expose.test(providerText)) {
    fail(`send-click dep ${dep.symbol}: ${dep.file} does not expose ${dep.expose}`);
  }
}
const clickClassicGate = fs.readFileSync(path.join(distCompanion, "send-click-adapter.js"), "utf8");
if (!/^\(function \(\)/.test(clickClassicGate.replace(/^\/\/.*\n/, ""))) {
  fail("send-click-adapter.js classic must be wrapped in IIFE");
}
for (const bindName of [
  "globalThis.resolveChatGptComposer",
  "globalThis.resolveChatGptAction",
  "globalThis.normalizeCanonicalDomText",
  "globalThis.__c2cReadCanonicalComposerText",
]) {
  if (!clickClassicGate.includes(bindName)) {
    fail(`send-click-adapter.js must bind ${bindName}`);
  }
}
if (!/globalThis\.__c2cDispatchNativeSend\s*=/.test(clickClassicGate)) {
  fail("send-click-adapter.js must expose __c2cDispatchNativeSend");
}
if (/globalThis\.readCanonicalComposerText\s*=/.test(clickClassicGate)) {
  fail("send-click-adapter.js must not expose unnamespaced readCanonicalComposerText");
}

for (const f of requiredFiles.filter((file) => file.endsWith(".js"))) {
  const text = fs.readFileSync(path.join(distCompanion, f), "utf8");
  if (/require\(["']node:/.test(text) || /from ["']node:/.test(text) || /import\s*["']node:/.test(text)) {
    fail(`${f} must not use Node-only imports`);
  }
}

// 页面执行器只委派写入和点击，不持有网络与原生点击能力。
const csSource = fs.readFileSync(path.join(distCompanion, "content-lite.js"), "utf8");
if (/\.click\(\)|chrome\.tabs|fetch\(/.test(csSource)) {
  fail("content-lite.js must not click or call chrome.tabs/fetch directly");
}
if (/\.click\(\)/.test(fs.readFileSync(path.join(distCompanion, "composer-write-adapter.js"), "utf8"))) {
  fail("composer-write-adapter.js must not contain .click()");
}
const writeClassic = fs.readFileSync(path.join(distCompanion, "composer-write-adapter.js"), "utf8");
const writeClassicCode = writeClassic.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
if (/dispatchNativeSend|runSendOrchestration|recoverSendOrchestration|\.click\(\)|begin-send|\/ack\b/.test(writeClassicCode)) {
  fail("classic write adapter must not expose send/click/orchestrator/begin-send/ack");
}
console.log(`browser-companion packaged → ${path.relative(root, distCompanion)}`);
