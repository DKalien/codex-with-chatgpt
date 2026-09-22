import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WAKE_WATCHDOG_ALARM_NAME,
  WAKE_WATCHDOG_PERIOD_MINUTES,
  wakeWatchdogEligible,
} from "../browser-companion/wake-watchdog.js";
import vm from "node:vm";

const root = path.resolve(process.cwd(), "browser-companion");

function transport(overrides: Record<string, unknown> = {}) {
  return {
    bridgeOrigin: "https://bridge.example.test",
    authStale: false,
    ...overrides,
  };
}

async function settleWakeRefresh() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function createWakeRefreshHarness({
  ownerTabId = 41,
  ownerDocumentId = "doc-owner",
  sendFails = false,
} = {}) {
  const sw = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
  const refreshStart = sw.indexOf("async function requestActiveOwnerRefresh");
  const refreshEnd = sw.indexOf("\nfunction statusPayload", refreshStart);
  const listenersStart = sw.indexOf("if (chrome.tabs?.onActivated?.addListener)");
  const listenersEnd = sw.indexOf("chrome.runtime.onInstalled.addListener", listenersStart);
  if (refreshStart < 0 || refreshEnd < 0 || listenersStart < 0 || listenersEnd < 0) {
    throw new Error("wake refresh harness could not locate service-worker hooks");
  }

  let activeTabs = [{ id: ownerTabId }];
  let activatedListener: ((event: { tabId: number }) => void) | undefined;
  let focusListener: ((windowId: number) => void) | undefined;
  let queryCount = 0;
  const sends: unknown[][] = [];
  const context: Record<string, unknown> = {
    initPromise: Promise.resolve(),
    ownerState: { owner: { tabId: ownerTabId, documentId: ownerDocumentId } },
    chrome: {
      tabs: {
        query: async () => {
          queryCount += 1;
          return activeTabs;
        },
        sendMessage: async (...args: unknown[]) => {
          sends.push(args);
          if (sendFails) throw new Error("content script unavailable");
          return { ok: true };
        },
        onActivated: {
          addListener: (listener: unknown) => {
            activatedListener = listener as (event: { tabId: number }) => void;
          },
        },
      },
      windows: {
        WINDOW_ID_NONE: -1,
        onFocusChanged: {
          addListener: (listener: unknown) => {
            focusListener = listener as (windowId: number) => void;
          },
        },
      },
    },
  };

  vm.runInNewContext(
    `${sw.slice(refreshStart, refreshEnd)}\n${sw.slice(listenersStart, listenersEnd)}`,
    context,
    { filename: "service-worker.wake-refresh.test.js" },
  );

  return {
    sends,
    get queryCount() {
      return queryCount;
    },
    setActiveTab(tabId: number) {
      activeTabs = [{ id: tabId }];
    },
    async activate(tabId: number) {
      activeTabs = [{ id: tabId }];
      activatedListener?.({ tabId });
      await settleWakeRefresh();
    },
    async focus(windowId = 1) {
      focusListener?.(windowId);
      await settleWakeRefresh();
    },
  };
}

describe("Browser Companion sleep/wake feedback recovery", () => {
  it("adds only the alarms permission and keeps the host surface unchanged", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    expect(manifest.permissions).toEqual(["storage", "activeTab", "alarms"]);
    expect(manifest.host_permissions).toEqual([
      "https://chatgpt.com/*",
      "https://www.chatgpt.com/*",
    ]);
    expect(manifest.permissions).not.toContain("tabs");
    expect(manifest.permissions).not.toContain("scripting");
  });

  it("keeps discovery dormant by default and enables it only for protected recovery", () => {
    expect(wakeWatchdogEligible({
      storageProtected: true,
      transport: transport(),
      autonomyMode: "off",
      journalState: "NONE",
    })).toBe(false);
    expect(wakeWatchdogEligible({
      storageProtected: true,
      transport: transport(),
      autonomyMode: "armed",
      journalState: "NONE",
    })).toBe(true);
    expect(wakeWatchdogEligible({
      storageProtected: true,
      transport: transport(),
      autonomyMode: "shadow",
      journalState: "NONE",
    })).toBe(true);
    expect(wakeWatchdogEligible({
      storageProtected: true,
      transport: transport(),
      autonomyMode: "off",
      journalState: "RESERVED",
    })).toBe(true);
  });

  it("fails closed for stale, unprotected, missing, or invalid transport", () => {
    for (const input of [
      { storageProtected: false, transport: transport(), autonomyMode: "armed", journalState: "NONE" },
      { storageProtected: true, transport: transport({ authStale: true }), autonomyMode: "armed", journalState: "NONE" },
      { storageProtected: true, transport: null, autonomyMode: "armed", journalState: "NONE" },
      { storageProtected: true, transport: transport({ bridgeOrigin: null }), autonomyMode: "armed", journalState: "NONE" },
    ]) {
      expect(wakeWatchdogEligible(input)).toBe(false);
    }
  });

  it("uses a bounded Chrome alarm period", () => {
    expect(WAKE_WATCHDOG_ALARM_NAME).toBe("c2c.feedback.discovery");
    expect(WAKE_WATCHDOG_PERIOD_MINUTES).toBeGreaterThanOrEqual(1);
  });

  it("keeps the alarm path discovery-only and exact-name gated", () => {
    const sw = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
    const start = sw.indexOf("async function handleWakeWatchdogAlarm");
    const end = sw.indexOf("/** Ask only the known active owner tab", start);
    const handler = sw.slice(start, end);
    expect(handler).toContain("alarm.name !== WAKE_WATCHDOG_ALARM_NAME");
    expect((handler.match(/handleFetchState\(\)/g) ?? []).length).toBe(1);
    for (const forbidden of [
      "handleReservePage",
      "maybeRunAutonomyTick",
      "handleProductionSend",
      "c2c.production.begin.send",
      "c2c.production.ack",
    ]) {
      expect(handler).not.toContain(forbidden);
    }
    expect(sw).toContain("chrome.alarms.onAlarm.addListener");
  });

  it("restores real owner heartbeat after resume without resurrecting ownership", () => {
    const sw = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
    const cs = fs.readFileSync(path.join(root, "content-script.js"), "utf8");
    expect(sw).toContain("chrome.tabs.onActivated.addListener");
    expect(sw).toContain("chrome.windows.onFocusChanged.addListener");
    expect(sw).toContain("requestActiveOwnerRefresh");
    expect(cs).toContain('message.type === "c2c.wake.refresh"');
    expect(cs).toContain("if (!document.hidden) wakeHeartbeat();");
    expect(cs).toContain('window.addEventListener("pageshow", wakeHeartbeat)');
    expect(cs).toContain('window.addEventListener("focus", wakeHeartbeat)');
    expect(cs).toContain('type: "c2c.heartbeat"');
    expect(sw).toContain("resetSessionOwnership(emptyOwnerState())");
    expect(sw).not.toContain("ownerState.owner =");
  });

  it("targets the exact owner document on activation", async () => {
    const harness = createWakeRefreshHarness();

    await harness.activate(41);

    expect(harness.sends).toEqual([[
      41,
      { type: "c2c.wake.refresh", reason: "resume" },
      { documentId: "doc-owner" },
    ]]);
  });

  it("does not query or send when Chrome reports no focused window", async () => {
    const harness = createWakeRefreshHarness();

    await harness.focus(-1);

    expect(harness.queryCount).toBe(0);
    expect(harness.sends).toHaveLength(0);
  });

  it("targets the exact owner document on a real focused window", async () => {
    const harness = createWakeRefreshHarness();

    await harness.focus(7);

    expect(harness.sends).toEqual([[
      41,
      { type: "c2c.wake.refresh", reason: "resume" },
      { documentId: "doc-owner" },
    ]]);
  });

  it("fails closed when the owner has no document id", async () => {
    const harness = createWakeRefreshHarness({ ownerDocumentId: "" });

    await harness.activate(41);

    expect(harness.queryCount).toBe(0);
    expect(harness.sends).toHaveLength(0);
  });

  it("does not send when focus is on a foreign active tab", async () => {
    const harness = createWakeRefreshHarness();
    harness.setActiveTab(99);

    await harness.focus();

    expect(harness.queryCount).toBe(1);
    expect(harness.sends).toHaveLength(0);
  });

  it("does not retry with a tab-wide message after document-targeted send fails", async () => {
    const harness = createWakeRefreshHarness({ sendFails: true });

    await harness.focus();

    expect(harness.sends).toEqual([[
      41,
      { type: "c2c.wake.refresh", reason: "resume" },
      { documentId: "doc-owner" },
    ]]);
  });

  it("packages the policy module with the companion", () => {
    const buildScript = fs.readFileSync(path.join(process.cwd(), "scripts", "build-browser-companion.mjs"), "utf8");
    expect(buildScript).toContain("copyDir(srcCompanion, distCompanion)");
  });
});
