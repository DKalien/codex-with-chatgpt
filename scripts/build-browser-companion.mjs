#!/usr/bin/env node
/**
 * Package the Edge MV3 browser companion into dist/browser-companion.
 * No bundler framework — copy + compile shared route parser only.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
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
// Classic CS artifact only. ESM dist/dom-adapter.js stays intact for service-worker imports.
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

// E1b3d1: classic CS turn-observer (READ-ONLY). ESM dist/turn-observer.js stays intact for SW.
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
(function () {
const areChatgptConversationRoutesEquivalent = globalThis.areChatgptConversationRoutesEquivalent || ((left, right) => {
  const resolve = globalThis.__c2cResolveMutationCanonicalRoute;
  if (typeof resolve === "function") {
    const parser = globalThis.parseChatgptConversationRoute;
    const a = resolve(left, parser);
    const b = resolve(right, parser);
    return a.ok === true && b.ok === true && a.canonical === b.canonical;
  }
  const parser = globalThis.parseChatgptConversationRoute;
  if (typeof parser !== "function") return false;
  try { return parser(left, { conversationIdPolicy: "uuid" }).canonical === parser(right, { conversationIdPolicy: "uuid" }).canonical; } catch { return false; }
});
${writeProbeSrc
  .replace(/^import\s+.*?;\s*$/gm, "")
  .replace(/^export\s+const\s+/gm, "const ")
  .replace(/^export\s+function\s+/gm, "function ")}
${writeAdapterBody}
;globalThis.__c2cInspectComposerWriteCapability = inspectComposerWriteCapability;
globalThis.__c2cWriteCanonicalMessage = writeCanonicalMessage;
globalThis.__c2cVerifyCanonicalComposer = verifyCanonicalComposer;
globalThis.__c2cReadCanonicalComposerText = readCanonicalComposerText;
globalThis.__c2cRunWriteProbe = runWriteProbe;
globalThis.__c2cWriteProbeMessage = WRITE_PROBE_MESSAGE;
globalThis.__c2cResolveMutationCanonicalRoute = resolveMutationCanonicalRoute;
})();
`;
if (/dispatchNativeSend|\.click\(\)/.test(writeAdapterClassic)) {
  fail("classic composer-write-adapter must not contain dispatchNativeSend or .click()");
}
if (/globalThis\.resolveMutationCanonicalRoute\s*=/.test(writeAdapterClassic)) {
  fail("classic composer-write-adapter must not expose unnamespaced resolveMutationCanonicalRoute");
}
if (!/globalThis\.__c2cResolveMutationCanonicalRoute\s*=\s*resolveMutationCanonicalRoute/.test(writeAdapterClassic)) {
  fail("classic composer-write-adapter must expose __c2cResolveMutationCanonicalRoute");
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
const areChatgptConversationRoutesEquivalent = globalThis.areChatgptConversationRoutesEquivalent || ((left, right) => {
  const parser = globalThis.parseChatgptConversationRoute;
  if (typeof parser !== "function") return false;
  try { return parser(left, { conversationIdPolicy: "uuid" }).canonical === parser(right, { conversationIdPolicy: "uuid" }).canonical; } catch { return false; }
});
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
// IIFE + explicit globalThis bindings: write-adapter classic is IIFE-isolated,
// so free names like writeCanonicalMessage are no longer classic globals.
const probeRunClassic = `// classic one-shot send probe runner (E1b3d3a)
(function () {
const areChatgptConversationRoutesEquivalent = globalThis.areChatgptConversationRoutesEquivalent || ((left, right) => { if (left === right) return true; const resolve = globalThis.__c2cResolveMutationCanonicalRoute; const parser = globalThis.parseChatgptConversationRoute; if (typeof resolve !== "function" || typeof parser !== "function") return false; const a = resolve(left, parser), b = resolve(right, parser); return a.ok === true && b.ok === true && a.canonical === b.canonical; });
const resolveChatGptComposer = globalThis.resolveChatGptComposer;
const resolveChatGptAction = globalThis.resolveChatGptAction;
const normalizeCanonicalDomText = globalThis.normalizeCanonicalDomText;
const readCanonicalComposerText = globalThis.__c2cReadCanonicalComposerText;
const writeCanonicalMessage = globalThis.__c2cWriteCanonicalMessage;
const verifyCanonicalComposer = globalThis.__c2cVerifyCanonicalComposer;
const dispatchNativeSend = globalThis.__c2cDispatchNativeSend;
const resolveMutationCanonicalRoute = globalThis.__c2cResolveMutationCanonicalRoute;
const buildSendProbeMessage = globalThis.buildSendProbeMessage;
${probeRunBody}
;globalThis.__c2cRunRealSendProbe = runRealSendProbe;
})();
`;
if (/^export\s/m.test(probeRunClassic) || /^import\s/m.test(probeRunClassic)) {
  fail("classic send-probe-run must not contain export/import");
}
if (!/function runRealSendProbe|async function runRealSendProbe/.test(probeRunClassic)) {
  fail("classic send-probe-run must define runRealSendProbe");
}
if (!/globalThis\.__c2cResolveMutationCanonicalRoute/.test(probeRunClassic)) {
  fail("classic send-probe-run must bind __c2cResolveMutationCanonicalRoute");
}
if (!/globalThis\.__c2cReadCanonicalComposerText/.test(probeRunClassic)) {
  fail("classic send-probe-run must bind __c2cReadCanonicalComposerText");
}
if (!/globalThis\.__c2cWriteCanonicalMessage/.test(probeRunClassic)) {
  fail("classic send-probe-run must bind __c2cWriteCanonicalMessage");
}
if (!/globalThis\.__c2cVerifyCanonicalComposer/.test(probeRunClassic)) {
  fail("classic send-probe-run must bind __c2cVerifyCanonicalComposer");
}
if (!/globalThis\.__c2cDispatchNativeSend/.test(probeRunClassic)) {
  fail("classic send-probe-run must bind __c2cDispatchNativeSend");
}
if (!/globalThis\.buildSendProbeMessage/.test(probeRunClassic)) {
  fail("classic send-probe-run must bind buildSendProbeMessage");
}
if (!/globalThis\.__c2cRunRealSendProbe\s*=\s*runRealSendProbe/.test(probeRunClassic)) {
  fail("classic send-probe-run must expose __c2cRunRealSendProbe");
}
// Must not re-expose unnamespaced write helpers from this IIFE.
if (/globalThis\.(writeCanonicalMessage|readCanonicalComposerText|verifyCanonicalComposer)\s*=/.test(probeRunClassic)) {
  fail("classic send-probe-run must not re-expose unnamespaced write helpers");
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
const areChatgptConversationRoutesEquivalent = globalThis.areChatgptConversationRoutesEquivalent || ((left, right) => {
  const parser = globalThis.parseChatgptConversationRoute;
  if (typeof parser !== "function") return false;
  try { return parser(left, { conversationIdPolicy: "uuid" }).canonical === parser(right, { conversationIdPolicy: "uuid" }).canonical; } catch { return false; }
});
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

// G3: classic route-attestation artifacts for MV3 content_scripts.
// ESM route-attestation.js / route-attestation-run.js stay intact for SW imports + unit tests.
function assertClassicArtifact(filePath, label) {
  const text = fs.readFileSync(filePath, "utf8");
  if (/^\s*import\s/m.test(text) || /^\s*export\s/m.test(text)) {
    fail(`${label} must not contain top-level import/export`);
  }
  try {
    // Compile-only classic parse gate — never execute at build time.
    new Function(text);
  } catch (e) {
    fail(`${label} is not parseable as classic JS: ${e instanceof Error ? e.message : String(e)}`);
  }
  return text;
}

const routeAttestSrc = fs.readFileSync(path.join(srcCompanion, "route-attestation.js"), "utf8");
const routeAttestRunSrc = fs.readFileSync(path.join(srcCompanion, "route-attestation-run.js"), "utf8");
if (!/export function findRouteAttestationUserTurn/.test(routeAttestSrc)) {
  fail("route-attestation.js must export findRouteAttestationUserTurn");
}
if (!/export async function runRouteAttestationSend/.test(routeAttestRunSrc)) {
  fail("route-attestation-run.js must export runRouteAttestationSend");
}

const routeAttestClassic = `// classic route-attestation contract (G3) — protocol semantics unchanged
(function () {
const collectBoundedDescendants = globalThis.collectBoundedDescendants;
const normalizeCanonicalDomText = globalThis.normalizeCanonicalDomText;
${stripExports(routeAttestSrc)}
;globalThis.extractRouteChallengeId = extractRouteChallengeId;
globalThis.findRouteAttestationUserTurn = findRouteAttestationUserTurn;
globalThis.isRouteAttestationMessage = isRouteAttestationMessage;
})();
`;
fs.writeFileSync(
  path.join(distCompanion, "route-attestation-global.js"),
  routeAttestClassic,
  "utf8",
);
assertClassicArtifact(path.join(distCompanion, "route-attestation-global.js"), "route-attestation-global.js");

const routeAttestRunClassic = `// classic route-attestation one-shot runner (G3) — protocol semantics unchanged
(function () {
const areChatgptConversationRoutesEquivalent = globalThis.areChatgptConversationRoutesEquivalent || ((left, right) => {
  const parser = globalThis.parseChatgptConversationRoute;
  if (typeof parser !== "function") return false;
  try { return parser(left, { conversationIdPolicy: "uuid" }).canonical === parser(right, { conversationIdPolicy: "uuid" }).canonical; } catch { return false; }
});
const resolveChatGptComposer = globalThis.resolveChatGptComposer;
const resolveChatGptAction = globalThis.resolveChatGptAction;
const matchesSendTargetIdentity = globalThis.matchesSendTargetIdentity;
const normalizeCanonicalDomText = globalThis.normalizeCanonicalDomText;
const readCanonicalComposerText = globalThis.__c2cReadCanonicalComposerText;
const writeCanonicalMessage = globalThis.__c2cWriteCanonicalMessage;
const verifyCanonicalComposer = globalThis.__c2cVerifyCanonicalComposer;
const dispatchNativeSend = globalThis.__c2cDispatchNativeSend;
const resolveMutationCanonicalRoute = globalThis.__c2cResolveMutationCanonicalRoute;
const extractRouteChallengeId = globalThis.extractRouteChallengeId;
const findRouteAttestationUserTurn = globalThis.findRouteAttestationUserTurn;
const isRouteAttestationMessage = globalThis.isRouteAttestationMessage;
${stripExports(routeAttestRunSrc)}
;globalThis.__c2cRunRouteAttestationSend = runRouteAttestationSend;
})();
`;
fs.writeFileSync(
  path.join(distCompanion, "route-attestation-run-global.js"),
  routeAttestRunClassic,
  "utf8",
);
const routeAttestRunClassicText = assertClassicArtifact(
  path.join(distCompanion, "route-attestation-run-global.js"),
  "route-attestation-run-global.js",
);
if (!/globalThis\.__c2cRunRouteAttestationSend\s*=\s*runRouteAttestationSend/.test(routeAttestRunClassicText)) {
  fail("classic route-attestation-run-global must expose __c2cRunRouteAttestationSend");
}
if (!/function runRouteAttestationSend|async function runRouteAttestationSend/.test(routeAttestRunClassicText)) {
  fail("classic route-attestation-run-global must define runRouteAttestationSend");
}
if (!/globalThis\.__c2cResolveMutationCanonicalRoute/.test(routeAttestRunClassicText)) {
  fail("classic route-attestation-run-global must bind __c2cResolveMutationCanonicalRoute");
}
// R3q: the classic runner must consume the SHARED structural Send matcher,
// never a local data-testid hardcode.
if (!/matchesSendTargetIdentity\(/.test(routeAttestRunClassicText)) {
  fail("classic route-attestation-run-global must consume the shared matchesSendTargetIdentity");
}
if (/data-testid.*send-button/.test(routeAttestRunClassicText)) {
  fail("classic route-attestation-run-global must not hardcode data-testid send-button");
}
if (/globalThis\.resolveMutationCanonicalRoute\s*=/.test(routeAttestRunClassicText)) {
  fail("classic route-attestation-run-global must not expose unnamespaced resolveMutationCanonicalRoute");
}

// Fixed feedback takeover message runner. The executor gets no body from callers.
const bootstrapRunSrc = fs.readFileSync(path.join(srcCompanion, "feedback-bootstrap-run.js"), "utf8");
if (!/export async function runFeedbackBootstrapSend/.test(bootstrapRunSrc)
  || !/export function isFeedbackBootstrapMessage/.test(bootstrapRunSrc)) {
  fail("feedback-bootstrap-run.js must export its fixed validator and one-shot runner");
}
const bootstrapRunClassic = `// fixed feedback bootstrap one-shot runner
(function () {
const areChatgptConversationRoutesEquivalent = globalThis.areChatgptConversationRoutesEquivalent || ((left, right) => {
  const parser = globalThis.parseChatgptConversationRoute;
  if (typeof parser !== "function") return false;
  try { return parser(left, { conversationIdPolicy: "uuid" }).canonical === parser(right, { conversationIdPolicy: "uuid" }).canonical; } catch { return false; }
});
const resolveChatGptComposer = globalThis.resolveChatGptComposer;
const resolveChatGptAction = globalThis.resolveChatGptAction;
const matchesSendTargetIdentity = globalThis.matchesSendTargetIdentity;
const normalizeCanonicalDomText = globalThis.normalizeCanonicalDomText;
const readCanonicalComposerText = globalThis.__c2cReadCanonicalComposerText;
const writeCanonicalMessage = globalThis.__c2cWriteCanonicalMessage;
const verifyCanonicalComposer = globalThis.__c2cVerifyCanonicalComposer;
const dispatchNativeSend = globalThis.__c2cDispatchNativeSend;
const resolveMutationCanonicalRoute = globalThis.__c2cResolveMutationCanonicalRoute;
const collectBoundedDescendants = globalThis.collectBoundedDescendants;
const snapshotUserTurns = globalThis.snapshotUserTurns;
${stripExports(bootstrapRunSrc)}
;globalThis.__c2cRunFeedbackBootstrapSend = runFeedbackBootstrapSend;
;globalThis.__c2cFeedbackBootstrapToolMissingReply = hasFeedbackBootstrapToolMissingReply;
})();
`;
fs.writeFileSync(path.join(distCompanion, "feedback-bootstrap-run-global.js"), bootstrapRunClassic, "utf8");
const bootstrapRunClassicText = assertClassicArtifact(
  path.join(distCompanion, "feedback-bootstrap-run-global.js"),
  "feedback-bootstrap-run-global.js",
);
if (!/globalThis\.__c2cRunFeedbackBootstrapSend\s*=\s*runFeedbackBootstrapSend/.test(bootstrapRunClassicText)) {
  fail("classic feedback-bootstrap-run-global must expose its fixed runner");
}

// ESM route-attestation artifacts must remain importable for service-worker + unit tests.
for (const esmName of ["route-attestation.js", "route-attestation-run.js"]) {
  const esmPath = path.join(distCompanion, esmName);
  if (!fs.existsSync(esmPath)) fail(`ESM route-attestation artifact missing after copy: ${esmName}`);
  const esm = fs.readFileSync(esmPath, "utf8");
  if (!/^export\s/m.test(esm)) {
    fail(`dist ${esmName} must keep ESM exports for SW/tests`);
  }
  if (/globalThis\.__c2cRunRouteAttestationSend\s*=/.test(esm) && esmName === "route-attestation.js") {
    fail("dist route-attestation.js must not be a classic global script");
  }
}

// ESM sources must remain intact for SW imports / unit tests.
for (const esmName of [
  "reservation-journal.js",
  "send-orchestrator.js",
  "production-send-runtime.js",
  "production-send.js",
  "autonomy.js",
  "route-attestation.js",
  "route-attestation-run.js",
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
  // ESM artifacts (SW import graph)
  "dom-adapter.js",
  "turn-observer.js",
  // classic CS artifacts
  "dom-adapter-global.js",
  "turn-observer-global.js",
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
  "autonomy.js",
  "route-esm.js",
  "route-global.js",
  "route-attestation.js",
  "route-attestation-run.js",
  "feedback-bootstrap-run.js",
  "route-attestation-global.js",
  "route-attestation-run-global.js",
  "feedback-bootstrap-run-global.js",
  "popup/popup.html",
  "popup/popup.js",
];
for (const f of requiredFiles) {
  if (!fs.existsSync(path.join(distCompanion, f))) fail(`packaged file missing: ${f}`);
}

const popupHtml = fs.readFileSync(path.join(distCompanion, "popup", "popup.html"), "utf8");
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

// ESM preserve gates: SW module graph must keep import/export semantics.
const distDomEsm = fs.readFileSync(path.join(distCompanion, "dom-adapter.js"), "utf8");
if (!/^export\s/m.test(distDomEsm)) {
  fail("dist dom-adapter.js must retain ESM export (service-worker / route-attestation import)");
}
if (/globalThis\.resolveChatGptComposer\s*=/.test(distDomEsm)) {
  fail("dist dom-adapter.js must not contain generated globalThis classic footer");
}
const distTurnEsm = fs.readFileSync(path.join(distCompanion, "turn-observer.js"), "utf8");
if (!/from\s+["']\.\/dom-adapter\.js["']/.test(distTurnEsm)) {
  fail("dist turn-observer.js must retain import of ./dom-adapter.js");
}
if (!/^export\s/m.test(distTurnEsm)) {
  fail("dist turn-observer.js must retain ESM exports");
}
if (!/export function collectBoundedDescendants/.test(distTurnEsm)) {
  fail("dist turn-observer.js must retain export function collectBoundedDescendants");
}
if (/globalThis\.collectBoundedDescendants\s*=/.test(distTurnEsm)) {
  fail("dist turn-observer.js must not contain generated globalThis classic footer");
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

// G3 content_scripts packaging: classic only; ESM SW modules stay off the CS chain.
const csJs = (manifest.content_scripts ?? []).flatMap((cs) => cs.js ?? []);
for (const bannedCs of [
  "route-attestation.js",
  "route-attestation-run.js",
  "feedback-bootstrap-run.js",
  "dom-adapter.js",
  "turn-observer.js",
]) {
  if (csJs.includes(bannedCs)) {
    fail(`manifest content_scripts must not load ESM ${bannedCs}`);
  }
}
for (const requiredCs of [
  "route-attestation-global.js",
  "route-attestation-run-global.js",
  "feedback-bootstrap-run-global.js",
  "dom-adapter-global.js",
  "turn-observer-global.js",
]) {
  if (!csJs.includes(requiredCs)) {
    fail(`manifest content_scripts must load classic ${requiredCs}`);
  }
}
const expectedCsOrder = [
  "route-global.js",
  "dom-adapter-global.js",
  "turn-observer-global.js",
  "shadow-evidence.js",
  "composer-write-adapter.js",
  "send-click-adapter.js",
  "send-probe-message-global.js",
  "send-probe-run.js",
  "route-attestation-global.js",
  "route-attestation-run-global.js",
  "feedback-bootstrap-run-global.js",
  "production-send-runtime-global.js",
  "content-script.js",
];
if (JSON.stringify(csJs) !== JSON.stringify(expectedCsOrder)) {
  fail(`manifest content_scripts order mismatch: ${JSON.stringify(csJs)}`);
}
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

// G3: route-attestation runner runtime deps must be provided by earlier manifest artifacts.
const routeAttestRunDeps = [
  { symbol: "resolveChatGptComposer", file: "dom-adapter-global.js", expose: /globalThis\.resolveChatGptComposer\s*=/ },
  { symbol: "resolveChatGptAction", file: "dom-adapter-global.js", expose: /globalThis\.resolveChatGptAction\s*=/ },
  { symbol: "normalizeCanonicalDomText", file: "dom-adapter-global.js", expose: /globalThis\.normalizeCanonicalDomText\s*=/ },
  { symbol: "__c2cReadCanonicalComposerText", file: "composer-write-adapter.js", expose: /globalThis\.__c2cReadCanonicalComposerText\s*=/ },
  { symbol: "__c2cWriteCanonicalMessage", file: "composer-write-adapter.js", expose: /globalThis\.__c2cWriteCanonicalMessage\s*=/ },
  { symbol: "__c2cVerifyCanonicalComposer", file: "composer-write-adapter.js", expose: /globalThis\.__c2cVerifyCanonicalComposer\s*=/ },
  { symbol: "__c2cDispatchNativeSend", file: "send-click-adapter.js", expose: /globalThis\.__c2cDispatchNativeSend\s*=/ },
  { symbol: "__c2cResolveMutationCanonicalRoute", file: "composer-write-adapter.js", expose: /globalThis\.__c2cResolveMutationCanonicalRoute\s*=/ },
  { symbol: "extractRouteChallengeId", file: "route-attestation-global.js", expose: /globalThis\.extractRouteChallengeId\s*=/ },
  { symbol: "findRouteAttestationUserTurn", file: "route-attestation-global.js", expose: /globalThis\.findRouteAttestationUserTurn\s*=/ },
  { symbol: "isRouteAttestationMessage", file: "route-attestation-global.js", expose: /globalThis\.isRouteAttestationMessage\s*=/ },
  { symbol: "snapshotUserTurns", file: "turn-observer-global.js", expose: /globalThis\.snapshotUserTurns\s*=/ },
];
const runGlobalIdx = csJs.indexOf("route-attestation-run-global.js");
if (runGlobalIdx < 0) fail("manifest missing route-attestation-run-global.js");
for (const dep of routeAttestRunDeps) {
  const idx = csJs.indexOf(dep.file);
  if (idx < 0) fail(`route-attest run dep ${dep.symbol}: manifest missing ${dep.file}`);
  if (idx >= runGlobalIdx) {
    fail(`route-attest run dep ${dep.symbol}: ${dep.file} must load before route-attestation-run-global.js`);
  }
  const providerText = fs.readFileSync(path.join(distCompanion, dep.file), "utf8");
  if (!dep.expose.test(providerText)) {
    fail(`route-attest run dep ${dep.symbol}: ${dep.file} does not expose ${dep.expose}`);
  }
}
const bootstrapRunDeps = [
  ...routeAttestRunDeps.filter(({ file }) => file !== "route-attestation-global.js"),
  { symbol: "areChatgptConversationRoutesEquivalent", file: "route-global.js", expose: /globalThis\.areChatgptConversationRoutesEquivalent\s*=/ },
  { symbol: "collectBoundedDescendants", file: "turn-observer-global.js", expose: /globalThis\.collectBoundedDescendants\s*=/ },
];
const bootstrapRunIdx = csJs.indexOf("feedback-bootstrap-run-global.js");
if (bootstrapRunIdx < 0) fail("manifest missing feedback-bootstrap-run-global.js");
for (const dep of bootstrapRunDeps) {
  const idx = csJs.indexOf(dep.file);
  if (idx < 0 || idx >= bootstrapRunIdx) {
    fail(`feedback bootstrap dep ${dep.symbol}: ${dep.file} must load before feedback-bootstrap-run-global.js`);
  }
  const providerText = fs.readFileSync(path.join(distCompanion, dep.file), "utf8");
  if (!dep.expose.test(providerText)) {
    fail(`feedback bootstrap dep ${dep.symbol}: ${dep.file} does not expose ${dep.expose}`);
  }
}
const writeClassicForDeps = fs.readFileSync(path.join(distCompanion, "composer-write-adapter.js"), "utf8");
if (/globalThis\.resolveMutationCanonicalRoute\s*=/.test(writeClassicForDeps)) {
  fail("composer-write-adapter.js must not expose unnamespaced resolveMutationCanonicalRoute");
}

// send-probe-run classic runtime deps (IIFE bindings after write-adapter isolation).
const sendProbeRunDeps = [
  { symbol: "resolveChatGptComposer", file: "dom-adapter-global.js", expose: /globalThis\.resolveChatGptComposer\s*=/ },
  { symbol: "resolveChatGptAction", file: "dom-adapter-global.js", expose: /globalThis\.resolveChatGptAction\s*=/ },
  { symbol: "normalizeCanonicalDomText", file: "dom-adapter-global.js", expose: /globalThis\.normalizeCanonicalDomText\s*=/ },
  { symbol: "__c2cReadCanonicalComposerText", file: "composer-write-adapter.js", expose: /globalThis\.__c2cReadCanonicalComposerText\s*=/ },
  { symbol: "__c2cWriteCanonicalMessage", file: "composer-write-adapter.js", expose: /globalThis\.__c2cWriteCanonicalMessage\s*=/ },
  { symbol: "__c2cVerifyCanonicalComposer", file: "composer-write-adapter.js", expose: /globalThis\.__c2cVerifyCanonicalComposer\s*=/ },
  { symbol: "__c2cDispatchNativeSend", file: "send-click-adapter.js", expose: /globalThis\.__c2cDispatchNativeSend\s*=/ },
  { symbol: "__c2cResolveMutationCanonicalRoute", file: "composer-write-adapter.js", expose: /globalThis\.__c2cResolveMutationCanonicalRoute\s*=/ },
  { symbol: "buildSendProbeMessage", file: "send-probe-message-global.js", expose: /globalThis\.buildSendProbeMessage\s*=/ },
];
const sendProbeRunIdx = csJs.indexOf("send-probe-run.js");
if (sendProbeRunIdx < 0) fail("manifest missing send-probe-run.js");
for (const dep of sendProbeRunDeps) {
  const idx = csJs.indexOf(dep.file);
  if (idx < 0) fail(`send-probe run dep ${dep.symbol}: manifest missing ${dep.file}`);
  if (idx >= sendProbeRunIdx) {
    fail(`send-probe run dep ${dep.symbol}: ${dep.file} must load before send-probe-run.js`);
  }
  const providerText = fs.readFileSync(path.join(distCompanion, dep.file), "utf8");
  if (!dep.expose.test(providerText)) {
    fail(`send-probe run dep ${dep.symbol}: ${dep.file} does not expose ${dep.expose}`);
  }
}
const sendProbeRunClassicGate = fs.readFileSync(path.join(distCompanion, "send-probe-run.js"), "utf8");
for (const bindName of [
  "globalThis.resolveChatGptComposer",
  "globalThis.resolveChatGptAction",
  "globalThis.normalizeCanonicalDomText",
  "globalThis.__c2cReadCanonicalComposerText",
  "globalThis.__c2cWriteCanonicalMessage",
  "globalThis.__c2cVerifyCanonicalComposer",
  "globalThis.__c2cDispatchNativeSend",
  "globalThis.__c2cResolveMutationCanonicalRoute",
  "globalThis.buildSendProbeMessage",
]) {
  if (!sendProbeRunClassicGate.includes(bindName)) {
    fail(`send-probe-run.js must bind ${bindName}`);
  }
}
if (!/^\(function \(\)/.test(sendProbeRunClassicGate.replace(/^\/\/.*\n/, ""))) {
  fail("send-probe-run.js classic must be wrapped in IIFE");
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

for (const f of ["ownership.js", "dom-adapter-global.js", "content-script.js", "service-worker.js", "turn-observer-global.js", "shadow-evidence.js", "dom-adapter.js", "turn-observer.js", "route-attestation.js"]) {
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
if (!/c2c\.route\.attest\.execute/.test(csSource)) {
  fail("content-script.js must handle route attest execute");
}
if (!/__c2cRunRouteAttestationSend/.test(csSource)) {
  fail("content-script.js must wire __c2cRunRouteAttestationSend");
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
if (!/globalThis\.__c2cResolveMutationCanonicalRoute\s*=/.test(writeClassic)) {
  fail("classic composer-write-adapter.js must expose __c2cResolveMutationCanonicalRoute");
}
if (/globalThis\.resolveMutationCanonicalRoute\s*=/.test(writeClassic)) {
  fail("classic composer-write-adapter.js must not expose unnamespaced resolveMutationCanonicalRoute");
}
const attestRunClassicGate = fs.readFileSync(
  path.join(distCompanion, "route-attestation-run-global.js"),
  "utf8",
);
if (!/globalThis\.__c2cResolveMutationCanonicalRoute/.test(attestRunClassicGate)) {
  fail("route-attestation-run-global.js must consume __c2cResolveMutationCanonicalRoute");
}

console.log(`browser-companion packaged → ${path.relative(root, distCompanion)}`);
