import { LIGHT_CONTENT_SCRIPTS } from "./browser-companion-chains.js";

import fs from "node:fs";

import path from "node:path";

import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { observeChatGptSafety, fakeDom } from "../browser-companion/dom-adapter.js";

import { companionApiUrl, BridgeOriginError } from "../browser-companion/bridge-origin.js";

import "../browser-companion/operations/view.js";

import { parseChatgptConversationRoute, normalizeChatgptConversationRoute, normalizeControlConversationUrl } from "../src/chatgpt/route.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ROUTE = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";

describe("Browser Companion exact isolation/result routes", () => {
  it("allows only the fixed isolate endpoint and canonical result query", () => {
    expect(companionApiUrl("https://bridge.example.test", "/isolate-attempt"))
      .toBe("https://bridge.example.test/api/companion/v1/isolate-attempt");
    expect(companionApiUrl("https://bridge.example.test", "/operations/terminal-gone"))
      .toBe("https://bridge.example.test/api/companion/v1/operations/terminal-gone");
    expect(companionApiUrl("https://bridge.example.test", "/operations/result?commandId=task_1&iteration=2"))
      .toBe("https://bridge.example.test/api/companion/v1/operations/result?commandId=task_1&iteration=2");
    for (const path of [
      "/isolate-attempt?eventId=any",
      "/operations/result?commandId=task%2Fone&iteration=1",
      "/operations/result?iteration=1&commandId=task_1",
      "/operations/result?commandId=task_1&iteration=01",
      "/operations/result?commandId=task_1&iteration=9007199254740992",
      "/operations/result?commandId=task_1&iteration=1&route=other",
    ]) expect(() => companionApiUrl("https://bridge.example.test", path)).toThrow(BridgeOriginError);
  });
});

describe("Browser Companion mailbox presentation", () => {
  it("explains queued Codex work, attention-blocked queue entries, and isolated unknown feedback", () => {
    const now = Date.parse("2026-10-01T00:00:00.000Z");
    const view = (globalThis as any).C2COperations.derive({
      ok: true,
      snapshot: {
        workspaceId: "a".repeat(12), routeCanonical: ROUTE, observedAt: new Date(now).toISOString(),
        executor: { state: "busy", observedAt: new Date(now).toISOString() },
        commands: [
          { commandId: "queued_1", delivery: { status: "pending", queueStatus: "queued" }, executions: [], feedback: [] },
          { commandId: "blocked_1", delivery: { status: "pending", queueStatus: "blocked", queueReason: "CODEX_BUSY" }, executions: [], feedback: [] },
          { commandId: "isolated_1", delivery: { status: "accepted" }, executions: [], feedback: [
            { eventId: "event_1", attemptId: "attempt_1", status: "outcome_unknown", isolated: true },
          ] },
        ],
      },
      web: { observedAt: new Date(now).toISOString(), verified: true, ownerAvailable: true, routeMatches: true, composer: "empty", generation: "idle", safe: true },
    }, now);
    expect(view.codex).toBe("忙碌");
    expect(view.rows.find((row: any) => row.commandId === "queued_1").deliveryLabel).toBe("已排队 · 等待 Codex 处理");
    expect(view.rows.find((row: any) => row.commandId === "blocked_1")).toMatchObject({
      needsAttention: true, deliveryLabel: "派发受阻 · CODEX_BUSY",
    });
    expect(view.rows.find((row: any) => row.commandId === "isolated_1")).toMatchObject({ needsAttention: true });
    expect(view.rows.find((row: any) => row.commandId === "isolated_1").feedback[0].label)
      .toBe("本条已隔离 · 未确认送达 · 后续继续");
  });
});

describe("browser companion manifest", () => {
  it("MV3, ChatGPT-only hosts, no dangerous permissions", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(projectRoot, "browser-companion", "manifest.json"), "utf8"),
    );
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.host_permissions).toEqual([
      "https://chatgpt.com/*",
      "https://www.chatgpt.com/*",
    ]);
    expect(manifest.host_permissions).not.toContain("<all_urls>");
    const perms = manifest.permissions ?? [];
    for (const banned of ["debugger", "nativeMessaging", "webRequest", "webRequestBlocking", "scripting", "tabs"]) {
      expect(perms).not.toContain(banned);
    }
    expect(perms).toContain("storage");
    expect(perms).toContain("activeTab");
    expect(manifest.optional_host_permissions ?? []).toContain("https://*/*");
    expect(manifest.host_permissions).not.toContain("<all_urls>");
    expect(manifest.optional_host_permissions).not.toContain("<all_urls>");
    expect(manifest.background?.service_worker).toBe("bridge-client.js");
    expect(manifest.action?.default_popup).toBe("popup/lightweight.html");
    expect(manifest.content_scripts?.[0]?.js).toEqual(LIGHT_CONTENT_SCRIPTS);
    expect(manifest.background?.type).toBe("module");
    expect(manifest.content_scripts?.[0]?.all_frames).toBe(false);
    // Edge rejects unrecognized keys; do not ship unsupported manifest fields.
    expect(manifest).not.toHaveProperty("minimum_edge_version");
    expect(JSON.stringify(manifest)).not.toContain("minimum_edge_version");
  });

  it("built companion manifest drops unsupported keys", () => {
    const distManifestPath = path.join(projectRoot, "dist", "browser-companion", "manifest.json");
    expect(fs.existsSync(distManifestPath)).toBe(true);
    const distRoot = path.dirname(distManifestPath);
    const assets = fs.readdirSync(distRoot, { recursive: true }).filter(file => fs.statSync(path.join(distRoot, String(file))).isFile())
      .map(file => String(file).replaceAll("\\", "/")).sort();
    expect(assets).toEqual(["manifest.json","bridge-client.js","bridge-operations.js","bridge-origin.js","project-context.js","content-lite.js","popup/lightweight.html","popup/lightweight.js","operations/operations.html","operations/operations.css","operations/operations.js","operations/view.js","operations/history.js","route-esm.js","completion-notification.js","route-global.js","dom-adapter-global.js","turn-observer-global.js","composer-write-adapter.js","send-click-adapter.js"].sort());
    const raw = fs.readFileSync(distManifestPath, "utf8");
    expect(raw).not.toContain("minimum_edge_version");
    const manifest = JSON.parse(raw);
    expect(manifest).not.toHaveProperty("minimum_edge_version");
  });
});

describe("DOM adapter generation positive evidence (P1)", () => {
  it("composer empty without positive idle evidence → unknown, safe=false", () => {
    const s = observeChatGptSafety(fakeDom({ composerText: "  ", stop: false, sendEnabled: false }), {
      routeValid: true,
    });
    expect(s.composer).toBe("empty");
    expect(s.generation).toBe("unknown");
    expect(s.safe).toBe(false);
    expect(s.reasons).toContain("generation_unknown");
  });

  it("send enabled + no stop → idle; empty composer can be safe", () => {
    const s = observeChatGptSafety(
      fakeDom({ composerText: "", stop: false, sendEnabled: true }),
      { routeValid: true },
    );
    expect(s.generation).toBe("idle");
    expect(s.safe).toBe(true);
  });

  it("composer dirty → unsafe", () => {
    const s = observeChatGptSafety(
      fakeDom({ composerText: "draft", stop: false, sendEnabled: true }),
      { routeValid: true },
    );
    expect(s.composer).toBe("dirty");
    expect(s.safe).toBe(false);
  });

  it("stop button → generating", () => {
    const s = observeChatGptSafety(
      fakeDom({ composerText: "", stop: true, sendEnabled: false }),
      { routeValid: true },
    );
    expect(s.generation).toBe("generating");
    expect(s.safe).toBe(false);
  });

  it("empty composer + composer-submit-button-color → idle/safe", () => {
    const s = observeChatGptSafety(
      fakeDom({ composerText: "", stop: false, sendEnabled: false, actionSlot: true }),
      { routeValid: true },
    );
    expect(s.composer).toBe("empty");
    expect(s.generation).toBe("idle");
    expect(s.safe).toBe(true);
  });

  it("dirty composer + action slot → idle generation but safe=false", () => {
    const s = observeChatGptSafety(
      fakeDom({ composerText: "draft", stop: false, sendEnabled: false, actionSlot: true }),
      { routeValid: true },
    );
    expect(s.composer).toBe("dirty");
    expect(s.generation).toBe("idle");
    expect(s.safe).toBe(false);
  });

  it("stop + action slot → generating; stop wins", () => {
    const s = observeChatGptSafety(
      fakeDom({ composerText: "", stop: true, sendEnabled: false, actionSlot: true }),
      { routeValid: true },
    );
    expect(s.generation).toBe("generating");
    expect(s.safe).toBe(false);
  });

  it("no stop / no send / no action slot → unknown", () => {
    const s = observeChatGptSafety(
      fakeDom({ composerText: "", stop: false, sendEnabled: false, actionSlot: false }),
      { routeValid: true },
    );
    expect(s.generation).toBe("unknown");
    expect(s.safe).toBe(false);
  });

  it("generating-state sample: action slot becomes stop-button → generating (not idle)", () => {
    // Real Edge sample 2026-09-16: same composer-submit-button-color with data-testid=stop-button
    const s = observeChatGptSafety(
      fakeDom({
        composerText: "",
        stop: false,
        sendEnabled: false,
        actionSlot: true,
        actionSlotClass:
          "composer-submit-btn composer-submit-button-color h-9 w-9",
        actionSlotTestId: "stop-button",
      }),
      { routeValid: true },
    );
    expect(s.generation).toBe("generating");
    expect(s.safe).toBe(false);
  });

  it("idle action slot requires text-submit-btn-text and not composer-submit-btn-only", () => {
    const idle = observeChatGptSafety(
      fakeDom({
        composerText: "",
        stop: false,
        sendEnabled: false,
        actionSlot: true,
        actionSlotClass: "composer-submit-button-color text-submit-btn-text",
      }),
      { routeValid: true },
    );
    expect(idle.generation).toBe("idle");
    expect(idle.safe).toBe(true);

    // stop-shaped class without text-submit-btn-text must not be idle
    const stopShaped = observeChatGptSafety(
      fakeDom({
        composerText: "",
        stop: false,
        sendEnabled: false,
        actionSlot: true,
        actionSlotClass: "composer-submit-btn composer-submit-button-color",
      }),
      { routeValid: true },
    );
    expect(stopShaped.generation).toBe("generating");
    expect(stopShaped.safe).toBe(false);
  });

  it("unsupported DOM → unknown unsafe", () => {
    const s = observeChatGptSafety(fakeDom({ hasBody: false, hasComposer: false }), {
      routeValid: true,
    });
    expect(s.safe).toBe(false);
    expect(s.adapterSupported).toBe(false);
  });

  it("does not mutate input document", () => {
    const d = fakeDom({ composerText: "x", sendEnabled: true });
    const before = JSON.stringify(Object.keys(d));
    observeChatGptSafety(d, { routeValid: true });
    expect(JSON.stringify(Object.keys(d))).toBe(before);
  });
});

describe("companion conversation id policy (P2)", () => {
  it("companion rejects unverified non-UUID conversation id", () => {
    expect(() =>
      normalizeChatgptConversationRoute("https://chatgpt.com/c/not-a-uuid-id"),
    ).toThrow();
  });

  it("web-control still accepts legacy id charset", () => {
    expect(normalizeControlConversationUrl("https://chatgpt.com/c/not-a-uuid-id"))
      .toBe("https://chatgpt.com/c/not-a-uuid-id");
  });

  it("companion accepts UUID / gpt-shaped UUID route", () => {
    expect(normalizeChatgptConversationRoute(ROUTE)).toBe(ROUTE);
    expect(() =>
      parseChatgptConversationRoute(`https://chatgpt.com/g/g-abc/c/${ROUTE.split("/").pop()}`, {
        allowQueryOrHash: false,
        conversationIdPolicy: "uuid",
      }),
    ).not.toThrow();
  });
});

describe("格式化接口固定路径", () => {
  it("只接受固定路径和精确hash query", () => {
    const origin = "https://bridge.example.test", hash = "f".repeat(64);
    for (const phase of ["preview", "confirm"])
      expect(companionApiUrl(origin, `/operations/format/${phase}`)).toBe(`${origin}/api/companion/v1/operations/format/${phase}`);
    expect(companionApiUrl(origin, `/operations/format/result?confirmationSha256=${hash}`))
      .toBe(`${origin}/api/companion/v1/operations/format/result?confirmationSha256=${hash}`);
    for (const path of ["/operations/format/result", `/operations/format/result?confirmationSha256=${hash}&workspaceId=x`,
      `/operations/format/result?confirmationSha256=${hash.toUpperCase()}`, `/operations/format/confirm?confirmationSha256=${hash}`,
      "/operations/format/all", "/operations%2Fformat/confirm"])
      expect(() => companionApiUrl(origin, path)).toThrow(BridgeOriginError);
  });
});
