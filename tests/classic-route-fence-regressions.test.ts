import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  areChatgptConversationRoutesEquivalent,
  parseChatgptConversationRoute,
} from "../src/chatgpt/route.js";
import { runWriteProbe } from "../browser-companion/composer-write-adapter.js";
import { runRealSendProbe } from "../browser-companion/send-probe-run.js";
import { runRouteAttestationSend } from "../browser-companion/route-attestation-run.js";
import { buildSendProbeMessage } from "../browser-companion/send-probe-message.js";
import { validateShadowInspectResponse } from "../browser-companion/shadow-rpc.js";
import { productionLocalPreflight } from "../browser-companion/production-send-runtime.js";
import { formatRouteAttestationMessage } from "../src/feedback/store.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distCompanion = path.join(projectRoot, "dist", "browser-companion");

const CONVERSATION = "11111111-1111-4111-8111-111111111111";
const OTHER_CONVERSATION = "99999999-9999-4999-8999-999999999999";
const PROJECT = "6aa296e634348191b441d56fdab23b7b";
const ROUTE = `https://chatgpt.com/g/g-p-${PROJECT}/c/${CONVERSATION}`;
const ROUTE_ALIAS = `https://www.chatgpt.com/g/g-p-${PROJECT}-codex-with-chatgpt/c/${CONVERSATION}/`;
const OTHER_ROUTE = `https://chatgpt.com/g/g-p-${PROJECT}/c/${OTHER_CONVERSATION}`;
const ATTEMPT = "22222222-2222-4222-8222-222222222222";
const CHALLENGE = "33333333-3333-4333-8333-333333333333";
const DIGEST = "a".repeat(64);
const PROBE = buildSendProbeMessage(ATTEMPT)!;
const ATTESTATION = formatRouteAttestationMessage(CHALLENGE, DIGEST);

function parseRoute(raw: string) {
  return parseChatgptConversationRoute(raw, {
    allowQueryOrHash: false,
    conversationIdPolicy: "uuid",
  });
}

function preflightContext(currentRoute: string) {
  const noop = () => {};
  return {
    journal: { state: "RESERVED", eventId: "event", reservationId: "reservation" },
    expectedRoute: ROUTE,
    expectedGeneration: 1,
    getCurrentRoute: () => currentRoute,
    getCurrentGeneration: () => 1,
    inspectComposerWriteCapability: () => ({ ok: true, action: { kind: "idle", enabled: true } }),
    waitForSendReady: noop,
    writeCanonicalMessage: noop,
    verifyCanonicalComposer: noop,
    dispatchNativeSend: noop,
    snapshotUserTurns: noop,
    findCanonicalUserTurn: noop,
    hasExactAttemptMarker: () => ({ ok: true }),
    persistJournal: noop,
    beginSend: noop,
    ackObserved: noop,
  };
}

function runnerOptions(currentRoute: string) {
  return {
    expectedRoute: ROUTE,
    expectedGeneration: 1,
    locationHref: currentRoute,
    getCurrentHref: () => currentRoute,
    parseRoute,
    localGeneration: 1,
    getCurrentGeneration: () => 1,
    waitMs: async () => {},
    readyTimeoutMs: 0,
    pollMs: 0,
    probeMessage: PROBE,
    attemptId: ATTEMPT,
    attestationMessage: ATTESTATION,
  };
}

type ClassicSandbox = Record<string, any>;

function loadClassic(files: string[]) {
  const sandbox: ClassicSandbox = {
    console,
    URL,
    setTimeout: () => 0,
    setInterval: () => 0,
    clearTimeout: () => {},
    clearInterval: () => {},
    location: { href: ROUTE_ALIAS },
    window: { addEventListener: () => {} },
    document: { hidden: false, addEventListener: () => {}, querySelector: () => null, querySelectorAll: () => [] },
    chrome: {
      runtime: {
        lastError: null,
        sendMessage: (_message: unknown, callback?: (value: unknown) => void) => callback?.({ ok: true }),
        onMessage: { addListener: () => {} },
      },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of files) {
    const source = fs.readFileSync(path.join(distCompanion, file), "utf8");
    vm.runInContext(source, sandbox, { filename: file });
  }
  return sandbox;
}

const commonClassic = ["route-global.js", "dom-adapter-global.js", "composer-write-adapter.js"];

describe("conversation route aliases stay inside content mutation fences", () => {
  it("accepts equivalent aliases and rejects a different conversation in every ESM runner", async () => {
    expect(areChatgptConversationRoutesEquivalent(ROUTE, ROUTE_ALIAS)).toBe(true);
    expect(areChatgptConversationRoutesEquivalent(ROUTE, OTHER_ROUTE)).toBe(false);

    const productionAlias = productionLocalPreflight(preflightContext(ROUTE_ALIAS));
    expect(productionAlias.ok).toBe(true);
    expect(productionLocalPreflight(preflightContext(OTHER_ROUTE))).toMatchObject({
      ok: false,
      reason: "route_drift",
    });

    const writeAlias = runWriteProbe({}, runnerOptions(ROUTE_ALIAS));
    expect(writeAlias).toMatchObject({ ok: false, reason: "composer_missing" });
    expect(runWriteProbe({}, runnerOptions(OTHER_ROUTE))).toMatchObject({
      ok: false,
      reason: "write_probe_route_drift",
    });

    const sendAlias = await runRealSendProbe({}, runnerOptions(ROUTE_ALIAS));
    expect(sendAlias).toMatchObject({ ok: false, reason: "composer_missing" });
    expect(await runRealSendProbe({}, runnerOptions(OTHER_ROUTE))).toMatchObject({
      ok: false,
      reason: "write_probe_route_drift",
    });

    const attestAlias = await runRouteAttestationSend({}, runnerOptions(ROUTE_ALIAS));
    expect(attestAlias).toMatchObject({ ok: false, reason: "composer_missing" });
    expect(await runRouteAttestationSend({}, runnerOptions(OTHER_ROUTE))).toMatchObject({
      ok: false,
      reason: "route_attest_route_drift",
    });
  });

  it("accepts aliases in the shadow response but rejects either mismatched route field", () => {
    const owner = { generation: 1 };
    const transport = { routeCanonical: ROUTE };
    expect(validateShadowInspectResponse({ mode: "read_only", canonicalRoute: ROUTE_ALIAS, generation: 1 }, owner, transport))
      .toEqual({ ok: true });
    expect(validateShadowInspectResponse({ mode: "read_only", canonicalRoute: OTHER_ROUTE, generation: 1 }, owner, transport))
      .toEqual({ ok: false, reason: "shadow_route_mismatch" });
    expect(validateShadowInspectResponse({
      mode: "read_only",
      canonicalRoute: ROUTE_ALIAS,
      documentCanonicalRoute: OTHER_ROUTE,
      generation: 1,
    }, owner, transport)).toEqual({ ok: false, reason: "shadow_route_mismatch" });
  });
});

describe("packaged classic content mutation fences", () => {
  const requiredArtifacts = [
    "route-global.js",
    "dom-adapter-global.js",
    "composer-write-adapter.js",
    "send-probe-message-global.js",
    "send-probe-run.js",
    "route-attestation-global.js",
    "route-attestation-run-global.js",
    "production-send-runtime-global.js",
  ];

  it("uses the shared route alias fence in all classic runners", async () => {
    for (const file of requiredArtifacts) {
      expect(fs.existsSync(path.join(distCompanion, file)), `missing packaged artifact: ${file}`).toBe(true);
    }

    const production = loadClassic(["route-global.js", "production-send-runtime-global.js"]);
    const runProduction = production.__c2cRunProductionSend as (ctx: Record<string, unknown>) => Promise<Record<string, unknown>>;
    const productionAliasContext = preflightContext(ROUTE_ALIAS);
    productionAliasContext.inspectComposerWriteCapability = () => ({
      ok: false,
      reason: "classic_preflight_reached",
    });
    const productionAlias = await runProduction(productionAliasContext);
    expect(productionAlias).toMatchObject({ ok: false, reason: "classic_preflight_reached" });
    const productionMismatch = await runProduction(preflightContext(OTHER_ROUTE));
    expect(productionMismatch).toMatchObject({ ok: false, reason: "route_drift" });

    const write = loadClassic(commonClassic);
    const runWrite = write.__c2cRunWriteProbe as (doc: unknown, opts: Record<string, unknown>) => Record<string, unknown>;
    expect(runWrite({}, runnerOptions(ROUTE_ALIAS))).toMatchObject({ ok: false, reason: "composer_missing" });
    expect(runWrite({}, runnerOptions(OTHER_ROUTE))).toMatchObject({ ok: false, reason: "write_probe_route_drift" });

    const probe = loadClassic([...commonClassic, "send-probe-message-global.js", "send-probe-run.js"]);
    const runProbe = probe.__c2cRunRealSendProbe as (doc: unknown, opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
    expect(await runProbe({}, runnerOptions(ROUTE_ALIAS))).toMatchObject({ ok: false, reason: "composer_missing" });
    expect(await runProbe({}, runnerOptions(OTHER_ROUTE))).toMatchObject({ ok: false, reason: "write_probe_route_drift" });

    const attest = loadClassic([
      ...commonClassic,
      "route-attestation-global.js",
      "route-attestation-run-global.js",
    ]);
    const runAttest = attest.__c2cRunRouteAttestationSend as (doc: unknown, opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
    expect(await runAttest({}, runnerOptions(ROUTE_ALIAS))).toMatchObject({ ok: false, reason: "composer_missing" });
    expect(await runAttest({}, runnerOptions(OTHER_ROUTE))).toMatchObject({ ok: false, reason: "route_attest_route_drift" });
  });
});
