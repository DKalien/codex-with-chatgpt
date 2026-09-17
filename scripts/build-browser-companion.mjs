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
    .replace(/^export\s+async\s+function\s+/gm, "async function ")
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
    .replace(/^import\s+[\s\S]*?from\s+"[^"]+";\s*$/gm, "")
    .replace(/^import\s+.*?;\s*$/gm, "")
    .replace(/^export\s+const\s+/gm, "const ")
    .replace(/^export\s+async\s+function\s+/gm, "async function ")
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
globalThis.resolveChatGptComposer = resolveChatGptComposer;
globalThis.isExcludedEmbeddedEditor = isExcludedEmbeddedEditor;
globalThis.resolveChatGptAction = resolveChatGptAction;
globalThis.normalizeCanonicalDomText = normalizeCanonicalDomText;
globalThis.inspectChatGptActionEvidence = inspectChatGptActionEvidence;
globalThis.inspectActiveComposerControls = inspectActiveComposerControls;
globalThis.inspectComposerContainerInventory = inspectComposerContainerInventory;
globalThis.summarizeStopButtonEvidence = summarizeStopButtonEvidence;
`,
  "utf8",
);

// E1b3d1: package turn-observer as classic script with READ-ONLY exports only.
// writeCanonicalMessage / dispatchNativeSend are never packaged into this classic file.
const turnObserver = fs.readFileSync(path.join(srcCompanion, "turn-observer.js"), "utf8");
if (/writeCanonicalMessage|dispatchNativeSend|\.click\(\)/.test(turnObserver)) {
  fail("turn-observer.js must stay read-only (no write/dispatch/click)");
}
fs.writeFileSync(
  path.join(distCompanion, "turn-observer.js"),
  stripExports(turnObserver.replace(/^import\s+.*?;\s*$/gm, "")) + `
;globalThis.snapshotUserTurns = snapshotUserTurns;
globalThis.findCanonicalUserTurn = findCanonicalUserTurn;
globalThis.hasExactAttemptMarker = hasExactAttemptMarker;
`,
  "utf8",
);

// send-adapter is copied as inert ESM for tests/dev only; it is NOT in content_scripts.
// Runtime shadow path uses shadow-evidence.js (read-only) instead.
const shadowEvidence = fs.readFileSync(path.join(srcCompanion, "shadow-evidence.js"), "utf8");
if (/writeCanonicalMessage|dispatchNativeSend|\.click\(\)/.test(shadowEvidence)) {
  fail("shadow-evidence.js must remain read-only");
}
fs.writeFileSync(
  path.join(distCompanion, "shadow-evidence.js"),
  stripExports(shadowEvidence.replace(/^import\s+.*?;\s*$/gm, "")) + `
;globalThis.__c2cInspectShadowEvidence = inspectShadowEvidence;
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
const writeProbeSrc = fs.readFileSync(path.join(srcCompanion, "write-probe.js"), "utf8");
const probeMessageMatch = /export const WRITE_PROBE_MESSAGE = ("(?:\\.|[^"\\])*")/.exec(writeProbeSrc);
if (!probeMessageMatch) fail("WRITE_PROBE_MESSAGE constant missing from write-probe.js");
if (!/export function parseChatgptRouteStrict/.test(writeProbeSrc)) {
  fail("parseChatgptRouteStrict missing from write-probe.js");
}
const writeAdapterBody = stripExports(
  writeAdapter
    .replace(/^import\s+[\s\S]*?from\s+"[^"]+";\s*$/gm, "")
    .replace(/^import\s+.*?;\s*$/gm, ""),
);
const writeAdapterClassic = `// classic write-only runtime capability (E1b3d2a)
${writeProbeSrc
  .replace(/^export\s+const\s+/gm, "const ")
  .replace(/^export\s+function\s+/gm, "function ")}
${writeAdapterBody}
;globalThis.__c2cInspectComposerWriteCapability = inspectComposerWriteCapability;
globalThis.__c2cWriteCanonicalMessage = writeCanonicalMessage;
globalThis.__c2cVerifyCanonicalComposer = verifyCanonicalComposer;
globalThis.__c2cReadCanonicalComposerText = readCanonicalComposerText;
globalThis.__c2cRunWriteProbe = runWriteProbe;
globalThis.__c2cWriteProbeMessage = WRITE_PROBE_MESSAGE;
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
const sendProbeSrc = fs.readFileSync(path.join(srcCompanion, "send-probe.js"), "utf8");
const clickBody = stripExports(
  clickAdapter
    .replace(/^import\s+[\s\S]*?from\s+"[^"]+";\s*$/gm, "")
    .replace(/^import\s+.*?;\s*$/gm, ""),
);
const clickClassic = `// classic runtime click capability (E1b3d3a)
${clickBody}
;globalThis.__c2cDispatchNativeSend = dispatchNativeSend;
`;
if (/\.click\(\)/.test(clickClassic) === false) {
  fail("classic send-click-adapter must retain .click()");
}
fs.writeFileSync(path.join(distCompanion, "send-click-adapter.js"), clickClassic, "utf8");

const probeRun = fs.readFileSync(path.join(srcCompanion, "send-probe-run.js"), "utf8");
const probeRunCode = probeRun.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
if (/\.click\(\)|chrome\.|fetch\(|begin-send|\/ack\b|markSendIntent/.test(probeRunCode)) {
  fail("send-probe-run.js must not click/chrome/fetch/journal");
}
const probeMessageSrc = fs.readFileSync(path.join(srcCompanion, "send-probe-message.js"), "utf8");
// Classic CS helper — separate artifact name; ESM source stays intact for SW.
const probeMessageClassic = `// classic fixed send-probe message helper (E1b3d3a)
${stripExports(probeMessageSrc)}
;globalThis.SEND_PROBE_TOKEN = SEND_PROBE_TOKEN;
globalThis.buildSendProbeMessage = buildSendProbeMessage;
`;
if (/^export\s/m.test(probeMessageClassic) || /^import\s/m.test(probeMessageClassic)) {
  fail("classic send-probe-message-global must not contain export/import");
}
if (!/globalThis\.buildSendProbeMessage/.test(probeMessageClassic)) {
  fail("classic send-probe-message-global must expose buildSendProbeMessage");
}
fs.writeFileSync(
  path.join(distCompanion, "send-probe-message-global.js"),
  probeMessageClassic,
  "utf8",
);

// ESM artifact must keep real exports for service-worker import chain.
const probeMessageEsm = fs.readFileSync(path.join(distCompanion, "send-probe-message.js"), "utf8");
if (!/export const SEND_PROBE_TOKEN/.test(probeMessageEsm)) {
  fail("dist send-probe-message.js must keep export const SEND_PROBE_TOKEN");
}
if (!/export function buildSendProbeMessage/.test(probeMessageEsm)) {
  fail("dist send-probe-message.js must keep export function buildSendProbeMessage");
}
if (/globalThis\.buildSendProbeMessage/.test(probeMessageEsm)) {
  fail("dist send-probe-message.js must not be classic global script");
}

const probeRunBody = stripExports(probeRun);
const probeRunClassic = `// classic one-shot send probe runner (E1b3d3a)
${probeRunBody}
;globalThis.__c2cRunRealSendProbe = runRealSendProbe;
`;
if (/^export\s/m.test(probeRunClassic) || /^import\s/m.test(probeRunClassic)) {
  fail("classic send-probe-run must not contain export/import");
}
if (!/function runRealSendProbe|async function runRealSendProbe/.test(probeRunClassic)) {
  fail("classic send-probe-run must define runRealSendProbe");
}
fs.writeFileSync(path.join(distCompanion, "send-probe-run.js"), probeRunClassic, "utf8");

// E1b3d3b: isolated classic production send runtime. Never overwrite ESM journal/orchestrator sources.
const reservationJournalSrc = fs.readFileSync(
  path.join(srcCompanion, "reservation-journal.js"),
  "utf8",
);
const sendOrchestratorSrc = fs.readFileSync(
  path.join(srcCompanion, "send-orchestrator.js"),
  "utf8",
);
const productionRuntimeSrc = fs.readFileSync(
  path.join(srcCompanion, "production-send-runtime.js"),
  "utf8",
);
const productionRuntimeCode = productionRuntimeSrc
  .replace(/^\s*\/\/.*$/gm, "")
  .replace(/\/\*[\s\S]*?\*\//g, "");
if (/chrome\.|fetch\(|localStorage|sessionStorage|credential/i.test(productionRuntimeCode)) {
  fail("production-send-runtime.js must stay DI-only (no chrome/fetch/storage/credential)");
}
if (/\.click\(\)/.test(productionRuntimeCode)) {
  fail("production-send-runtime.js must not contain .click()");
}
const productionClassic = `// classic production one-shot send runtime (E1b3d3b)
(function () {
${stripExports(reservationJournalSrc)}
${stripExports(sendOrchestratorSrc)}
${stripExports(productionRuntimeSrc)}
;globalThis.__c2cRunProductionSend = runProductionSend;
globalThis.__c2cRecoverProductionSend = recoverProductionSend;
})();
`;
if (/^export\s/m.test(productionClassic) || /^import\s/m.test(productionClassic)) {
  fail("classic production-send-runtime must not contain export/import");
}
if (!/function runProductionSend|async function runProductionSend/.test(productionClassic)) {
  fail("classic production-send-runtime must define runProductionSend");
}
if (!/globalThis\.__c2cRunProductionSend/.test(productionClassic)) {
  fail("classic production-send-runtime must expose __c2cRunProductionSend");
}
if (!/globalThis\.__c2cRecoverProductionSend/.test(productionClassic)) {
  fail("classic production-send-runtime must expose __c2cRecoverProductionSend");
}
// Journal reducers must not leak to global namespace.
if (/globalThis\.(markSendIntent|markClaimed|markReserved|emptyJournal)\s*=/.test(productionClassic)) {
  fail("classic production-send-runtime must not expose journal reducers");
}
if (/globalThis\.(runSendOrchestration|recoverSendOrchestration)\s*=/.test(productionClassic)) {
  fail("classic production-send-runtime must not expose orchestrator globals");
}
fs.writeFileSync(
  path.join(distCompanion, "production-send-runtime-global.js"),
  productionClassic,
  "utf8",
);

// ESM sources must remain intact for SW imports / unit tests.
for (const esmName of [
  "reservation-journal.js",
  "send-orchestrator.js",
  "production-send-runtime.js",
  "production-send.js",
]) {
  const esmPath = path.join(distCompanion, esmName);
  if (!fs.existsSync(esmPath)) fail(`ESM source missing after copy: ${esmName}`);
  const esm = fs.readFileSync(esmPath, "utf8");
  if (!/^export\s/m.test(esm)) {
    fail(`dist ${esmName} must keep ESM exports`);
  }
}

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
  "turn-observer.js",
  "shadow-evidence.js",
  "shadow-rpc.js",
  "composer-write-adapter.js",
  "send-click-adapter.js",
  "send-probe-message.js",
  "send-probe-message-global.js",
  "send-probe-run.js",
  "send-probe.js",
  "write-probe.js",
  "production-send.js",
  "production-send-runtime.js",
  "production-send-runtime-global.js",
  "route-esm.js",
  "route-global.js",
  "popup/popup.html",
  "popup/popup.js",
];
for (const f of requiredFiles) {
  if (!fs.existsSync(path.join(distCompanion, f))) fail(`packaged file missing: ${f}`);
}

for (const f of ["ownership.js", "dom-adapter.js", "content-script.js", "service-worker.js", "turn-observer.js", "shadow-evidence.js"]) {
  const text = fs.readFileSync(path.join(distCompanion, f), "utf8");
  if (/require\(["']node:/.test(text) || /from ["']node:/.test(text)) {
    fail(`${f} must not use Node-only imports`);
  }
}

// E1b3d1/d2a/d3a/d3b: content-script must not own network/click/journal authority.
const csSource = fs.readFileSync(path.join(distCompanion, "content-script.js"), "utf8");
if (/\.click\(\)/.test(csSource)) {
  fail("content-script.js must not contain .click()");
}
if (/chrome\.tabs\.sendMessage|fetch\(/.test(csSource)) {
  fail("content-script.js must not call chrome.tabs or fetch directly");
}
if (!/c2c\.production\.send\.execute/.test(csSource)) {
  fail("content-script.js must handle production send execute");
}
if (!/__c2cRunProductionSend/.test(csSource)) {
  fail("content-script.js must wire __c2cRunProductionSend");
}
if (/\.click\(\)/.test(fs.readFileSync(path.join(distCompanion, "composer-write-adapter.js"), "utf8"))) {
  fail("composer-write-adapter.js must not contain .click()");
}
const writeClassic = fs.readFileSync(path.join(distCompanion, "composer-write-adapter.js"), "utf8");
const writeClassicCode = writeClassic.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
if (/dispatchNativeSend|runSendOrchestration|recoverSendOrchestration|\.click\(\)|begin-send|\/ack\b/.test(writeClassicCode)) {
  fail("classic write adapter must not expose send/click/orchestrator/begin-send/ack");
}
if (!/globalThis\.__c2cRunWriteProbe/.test(writeClassic)) {
  fail("classic write adapter must expose __c2cRunWriteProbe");
}

console.log(`browser-companion packaged → ${path.relative(root, distCompanion)}`);
