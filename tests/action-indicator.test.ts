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
    expect(sw).toContain("createCompanionIndicatorApplier");
    expect(sw).toContain("void refreshActionIndicator();");
    expect(sw).toMatch(/onMessage\.addListener[\s\S]*refreshActionIndicator/);
    expect(sw).toMatch(/onRemoved\.addListener[\s\S]*refreshActionIndicator/);
    expect(sw).toMatch(/onInstalled\.addListener[\s\S]*refreshActionIndicator/);
    expect(sw).toMatch(/onStartup\.addListener[\s\S]*refreshActionIndicator/);
    expect(sw).toContain("chrome.permissions?.contains");
    expect(sw).not.toContain("chrome.permissions.request");
  });
});
