import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createCompanionIndicatorApplier,
  deriveCompanionIndicator,
} from "../browser-companion/action-indicator.js";

const root = path.resolve(process.cwd(), "browser-companion");
const ROUTE = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";

function healthy(overrides: Record<string, unknown> = {}) {
  return {
    hydrated: true,
    storageProtected: true,
    transportPresent: true,
    bridgePermissionGranted: true,
    transport: {
      connected: true,
      connectionReadiness: { ready: true, reason: null },
      bridgeOrigin: "https://bridge.example.test",
      routeCanonical: ROUTE,
      routeVerification: "VERIFIED",
      authStale: false,
      rebindPending: false,
    },
    owner: { available: true, canonicalRoute: ROUTE },
    autonomy: { mode: "armed", identityExact: true, tickInFlight: false },
    journal: { state: "NONE" },
    routeAttestFence: { state: "NONE" },
    connectFlow: { state: "NONE" },
    productionSendInFlight: false,
    ...overrides,
  };
}

describe("Browser Companion action indicator", () => {
  it("healthy ARMED + VERIFIED derives normal C", () => {
    expect(deriveCompanionIndicator(healthy())).toEqual({
      severity: "normal",
      badgeText: "C",
      title: "C2C：当前对话已连接，自动回流已开启",
      reason: "ready",
    });
  });

  it.each([
    ["autonomy off", { autonomy: { mode: "off", identityExact: true } }, "autonomy_off"],
    ["autonomy shadow", { autonomy: { mode: "shadow", identityExact: true } }, "autonomy_shadow"],
    ["no transport", { transportPresent: false, transport: {}, owner: { available: false } }, "transport_missing"],
    ["pending route", { transport: { ...healthy().transport, routeVerification: "PENDING" } }, "route_pending"],
    ["rebind pending", { transport: { ...healthy().transport, rebindPending: true }, connectFlow: { state: "ATTEST_REQUESTED" } }, "rebind_pending"],
    ["permission missing", { bridgePermissionGranted: false }, "bridge_permission_missing"],
    ["startup pending", { hydrated: false, transportPresent: false }, "startup_pending"],
    ["owner missing", { owner: { available: false } }, "owner_missing"],
  ])("%s derives warning C!", (_name, overrides, reason) => {
    const result = deriveCompanionIndicator(healthy(overrides));
    expect(result.severity).toBe("warning");
    expect(result.badgeText).toBe("C!");
    expect(result.reason).toBe(reason);
  });

  it.each([
    ["known route mismatch", { owner: { available: true, canonicalRoute: "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222" } }, "route_identity_mismatch"],
    ["auth stale", { transport: { ...healthy().transport, authStale: true } }, "auth_stale"],
    ["journal outcome unknown", { journal: { state: "OUTCOME_UNKNOWN" } }, "journal_outcome_unknown"],
    ["route fence outcome unknown", { routeAttestFence: { state: "OUTCOME_UNKNOWN" } }, "route_attest_outcome_unknown"],
    ["connect outcome unknown", { connectFlow: { state: "OUTCOME_UNKNOWN" } }, "connect_outcome_unknown"],
    ["storage unprotected", { storageProtected: false }, "storage_unprotected"],
    ["unknown journal", { journal: { state: "CORRUPT" } }, "journal_state_unknown"],
    ["invalid bridge origin", { bridgeOriginInvalid: true }, "bridge_origin_invalid"],
  ])("%s derives error C×", (_name, overrides, reason) => {
    const result = deriveCompanionIndicator(healthy(overrides));
    expect(result.severity).toBe("error");
    expect(result.badgeText).toBe("C×");
    expect(result.reason).toBe(reason);
  });

  it.each([undefined, { ready: false, reason: "web_sink_not_ready" }])("missing or incomplete readiness cannot show C", connectionReadiness => {
    expect(deriveCompanionIndicator(healthy({ transport: { ...healthy().transport, connectionReadiness } })))
      .toMatchObject({ severity: "warning", reason: "connect_not_ready" });
  });

  it("journal unknown keeps C× with a feedback-specific tooltip", () => {
    expect(deriveCompanionIndicator(healthy({ journal: { state: "OUTCOME_UNKNOWN" } })))
      .toMatchObject({ badgeText: "C×", reason: "journal_outcome_unknown", title: "C2C：回流待核验，请勿重复发送" });
    expect(deriveCompanionIndicator(healthy({ routeAttestFence: { state: "OUTCOME_UNKNOWN" } })).title)
      .toBe("C2C：连接需要处理");
  });

  it("error precedence wins over warning", () => {
    const result = deriveCompanionIndicator(healthy({
      transport: { ...healthy().transport, authStale: true, routeVerification: "PENDING" },
      autonomy: { mode: "off", identityExact: true },
    }));
    expect(result.severity).toBe("error");
    expect(result.reason).toBe("auth_stale");
  });

  it("rebind transition is warning while durable unknown remains error", () => {
    expect(deriveCompanionIndicator(healthy({
      transport: { ...healthy().transport, rebindPending: true },
      connectFlow: { state: "ATTEST_REQUESTED" },
      owner: { available: true, canonicalRoute: "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222" },
    }))).toMatchObject({ reason: "rebind_pending", severity: "warning" });
    expect(deriveCompanionIndicator(healthy({
      transport: { ...healthy().transport, rebindPending: true },
      routeAttestFence: { state: "OUTCOME_UNKNOWN" },
    }))).toMatchObject({ reason: "route_attest_outcome_unknown", severity: "error" });
  });

  it("missing bridge origin stays warning rather than looking healthy", () => {
    expect(deriveCompanionIndicator(healthy({
      transport: { ...healthy().transport, bridgeOrigin: null },
    }))).toMatchObject({ severity: "warning", reason: "transport_missing" });
  });

  it("cooldown and in-flight are bounded warnings", () => {
    expect(deriveCompanionIndicator(healthy({
      autonomy: { mode: "armed", identityExact: true, lastDecision: "cooldown" },
    }))).toMatchObject({ reason: "autonomy_cooldown", severity: "warning" });
    expect(deriveCompanionIndicator(healthy({ productionSendInFlight: true }))).toMatchObject({
      reason: "in_flight",
      severity: "warning",
    });
  });

  it("converges from a transient autonomy tick warning back to C", async () => {
    const setBadgeText = vi.fn(async () => undefined);
    const setTitle = vi.fn(async () => undefined);
    const apply = createCompanionIndicatorApplier({ setBadgeText, setTitle });

    const inFlight = deriveCompanionIndicator(healthy({
      autonomy: { mode: "armed", identityExact: true, tickInFlight: true },
    }));
    const settled = deriveCompanionIndicator(healthy());
    expect(inFlight).toMatchObject({ severity: "warning", badgeText: "C!", reason: "in_flight" });
    expect(settled).toMatchObject({ severity: "normal", badgeText: "C", reason: "ready" });

    await apply(inFlight);
    await apply(settled);
    expect(setBadgeText.mock.calls.map(([arg]) => arg.text)).toEqual(["C!", "C"]);
  });

  it("never returns raw route, id, credential, secret, or arbitrary error text", () => {
    const result = deriveCompanionIndicator(healthy({
      owner: { available: true, canonicalRoute: "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222" },
      secret: "should-not-leak",
      error: "raw server error",
    }));
    const text = JSON.stringify(result);
    expect(text).not.toContain("chatgpt.com");
    expect(text).not.toContain("22222222");
    expect(text).not.toContain("should-not-leak");
    expect(text).not.toContain("raw server error");
  });

  it("deduplicates identical action updates and applies transitions once", async () => {
    const setBadgeText = vi.fn(async () => undefined);
    const setTitle = vi.fn(async () => undefined);
    const apply = createCompanionIndicatorApplier({ setBadgeText, setTitle });
    const normal = deriveCompanionIndicator(healthy());
    const warning = deriveCompanionIndicator(healthy({ autonomy: { mode: "off", identityExact: true } }));
    await apply(normal);
    await apply(normal);
    await apply(warning);
    await apply(warning);
    await apply(deriveCompanionIndicator(healthy({ transport: { ...healthy().transport, authStale: true } })));
    expect(setBadgeText.mock.calls.map(([arg]) => arg.text)).toEqual(["C", "C!", "C×"]);
    expect(setTitle).toHaveBeenCalledTimes(3);
  });

  it("service worker wires refresh to hydration, messages, startup, install, and tab removal", () => {
    const sw = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
    const projectContext = fs.readFileSync(path.join(root, "project-context.js"), "utf8");
    expect(sw).toContain("createCompanionIndicatorApplier");
    expect(sw).toMatch(/refreshSelectedIndicator: async \(\) => \{\s*await initPromise;\s*applyActionIndicator\.invalidate\(\);\s*await refreshActionIndicator\(\);/);
    expect(sw).toContain("void refreshActionIndicator();");
    const afterMessageStart = sw.indexOf("async function afterMessage(type)");
    const afterMessageEnd = sw.indexOf("\nreturn {", afterMessageStart);
    expect(sw.slice(afterMessageStart, afterMessageEnd)).toMatch(/refreshActionIndicator\(\)/);
    expect(sw.slice(afterMessageStart, afterMessageEnd)).toMatch(/syncWakeWatchdog\(\)/);
    expect(projectContext).toMatch(/await context\.afterMessage\?\.\(message\.type\)/);
    expect(sw).toMatch(/globalThis\.chrome\.runtime\.onMessage\.addListener\([\s\S]*projectRouter\.handle\(message, sender\)/);
    expect(sw).toMatch(/async function handleTabRemoved\(tabId\)[\s\S]*await refreshActionIndicator\(\)/);
    expect(sw).toMatch(/async function handleInstalled\(\)[\s\S]*await refreshActionIndicator\(\)/);
    expect(sw).toMatch(/async function handleStartup\(\)[\s\S]*await refreshActionIndicator\(\)/);
    expect(projectContext).toMatch(/dispatchToProjects\("handleTabRemoved", tabId\)/);
    expect(sw).toMatch(/globalThis\.chrome\.tabs\?\.onRemoved\?\.addListener\([\s\S]*projectRouter\.handleTabRemoved\(tabId\)/);
    expect(sw).toMatch(/globalThis\.chrome\.runtime\.onInstalled\?\.addListener\([\s\S]*projectRouter\.handleInstalled\(details\)/);
    expect(sw).toMatch(/globalThis\.chrome\.runtime\.onStartup\?\.addListener\([\s\S]*projectRouter\.handleStartup\(\)/);
    expect(sw).toContain("chrome.permissions?.contains");
    expect(sw).not.toContain("chrome.permissions.request");
  });

  it("refreshes after each transient in-flight flag is cleared", () => {
    const sw = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
    const tick = sw.slice(
      sw.indexOf("async function maybeRunAutonomyTick"),
      sw.indexOf("async function handleProductionSend"),
    );
    const send = sw.slice(
      sw.indexOf("async function handleProductionSend"),
      sw.indexOf("async function recoverProductionSendSide"),
    );
    const recover = sw.slice(
      sw.indexOf("async function recoverProductionSendSide"),
      sw.indexOf("async function handleRetireUnknown"),
    );

    expect(tick).toMatch(/autonomyTickInFlight = false;\s*void refreshActionIndicator\(\);/);
    expect(send).toMatch(/productionSendInFlight = false;\s*void refreshActionIndicator\(\);/);
    expect(recover).toMatch(/productionSendInFlight = false;\s*void refreshActionIndicator\(\);/);
  });
});
