import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  areChatgptConversationRoutesEquivalent,
  parseChatgptConversationRoute,
} from "../src/chatgpt/route.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePopup = path.join(root, "browser-companion", "popup");
const builtPopup = path.join(root, "dist", "browser-companion", "popup");
const route = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";

function popupScripts(dir: string) {
  const html = fs.readFileSync(path.join(dir, "popup.html"), "utf8");
  return [...html.matchAll(/<script\b([^>]*)><\/script>/gi)].map(([, attributes]) => ({
    attributes,
    src: /\bsrc=["']([^"']+)["']/i.exec(attributes)?.[1] ?? "",
  })).filter(script => script.src);
}

async function loadPopup(
  permissionGranted: boolean,
  requestGranted?: boolean,
  options: {
    pairResult?: unknown;
    connectResult?: unknown;
    tabId?: number;
    tabIds?: number[];
    pageUrl?: string;
    autonomyArmConfirmed?: boolean;
    productionSendConfirmed?: boolean;
    savedBridgeOrigin?: string;
    status?: Record<string, unknown>;
    ownerProofResult?: unknown;
  } = {},
) {
  const html = fs.readFileSync(path.join(sourcePopup, "popup.html"), "utf8");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  const listeners = new Map(ids.map(id => [id, [] as { type: string; handler: () => void }[]]));
  const elements = new Map(ids.map(id => [id, {
    value: "", textContent: "", className: "", disabled: false, checked: false,
    onclick: null as null | (() => Promise<void>),
    addEventListener: (type: string, handler: () => void) => { listeners.get(id)!.push({ type, handler }); },
  }]));
  if (options.autonomyArmConfirmed) elements.get("autonomy-arm-confirm")!.checked = true;
  if (options.productionSendConfirmed) elements.get("production-send-confirm")!.checked = true;
  const calls = {
    contains: [] as unknown[], request: [] as unknown[], ownerProof: 0,
    order: [] as string[],
    runtime: [] as unknown[], storage: [] as unknown[], page: [] as unknown[],
  };
  const requestResult = requestGranted ?? permissionGranted;
  const chrome = {
    tabs: {
      query: async () => {
        const id = options.tabIds?.shift() ?? options.tabId ?? 1;
        return [{ id, url: options.pageUrl ?? route }];
      },
      sendMessage: async (_tabId: number, message: { type: string }) => {
        if (message.type === "c2c.popup.ping") {
          return { safety: { composer: "empty", generation: "idle", safe: true } };
        }
        if (message.type === "c2c.status.request") {
          return {
            targetRoute: route, isOwner: true, storageProtected: true,
            ownership: { hasOwner: true }, transport: null,
            journal: { state: "NONE" }, sendProbeLatch: "NONE",
            ...options.status,
          };
        }
        if (message.type === "c2c.owner-proof.request") {
          calls.order.push("owner-proof");
          calls.ownerProof += 1;
          return options.ownerProofResult ?? { ok: true, proof: { id: "proof-1" } };
        }
        if (message.type === "c2c.connect.request") {
          calls.order.push("connect");
          calls.page.push(message);
          return options.connectResult ?? { ok: true, state: "AWAITING_CONFIRMATION" };
        }
        if (message.type === "c2c.bind.request") {
          calls.page.push(message);
          return { ok: true };
        }
        return { ok: true };
      },
    },
    runtime: {
      sendMessage: async (message: unknown) => {
        calls.runtime.push(message);
        if (typeof message === "object" && message && (message as { type?: string }).type === "c2c.pair") {
          calls.order.push("pair");
          return options.pairResult ?? { ok: true };
        }
        return { ok: true };
      },
    },
    storage: {
      local: {
        get: async () => options.savedBridgeOrigin
          ? { c2c_companion_bridge_origin_v1: options.savedBridgeOrigin }
          : {},
        set: async (value: unknown) => { calls.storage.push(value); calls.order.push("save-origin"); },
      },
      session: {
        get: async () => ({}),
        set: async (value: unknown) => { calls.storage.push(value); calls.order.push("save-intent"); },
        remove: async () => undefined,
      },
    },
    permissions: {
      contains: async (query: unknown) => { calls.contains.push(query); return permissionGranted; },
      request: (query: unknown) => {
        // Synchronous push proves gesture-time invocation from the click handler.
        calls.request.push(query);
        calls.order.push("permission");
        return Promise.resolve(requestResult);
      },
    },
  };
  const sandbox = {
    chrome,
    document: { getElementById: (id: string) => elements.get(id) },
    parseChatgptConversationRoute,
    areChatgptConversationRoutesEquivalent,
    URL,
    console,
  };
  vm.runInNewContext(fs.readFileSync(path.join(sourcePopup, "popup.js"), "utf8"), sandbox);
  for (let i = 0; i < 10 && !elements.get("pair")?.onclick; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  const fireChange = (id: string) => {
    for (const listener of listeners.get(id) ?? []) {
      if (listener.type === "change") listener.handler();
    }
  };
  return { calls, elements, fireChange };
}

describe("popup classic packaging", () => {
  it("does not load SW ESM artifacts as classic scripts", () => {
    const banned = new Set(["dom-adapter.js", "turn-observer.js", "route-attestation.js", "route-attestation-run.js"]);
    for (const dir of [sourcePopup, builtPopup]) {
      if (!fs.existsSync(path.join(dir, "popup.html"))) continue;
      expect(popupScripts(dir).map(script => path.basename(script.src)).filter(name => banned.has(name))).toEqual([]);
    }
  });

  it("every built classic popup script parses as classic JavaScript", () => {
    if (!fs.existsSync(path.join(builtPopup, "popup.html"))) return;
    for (const script of popupScripts(builtPopup)) {
      if (/\btype=["']module["']/i.test(script.attributes)) continue;
      const artifact = path.resolve(builtPopup, script.src);
      expect(() => new vm.Script(fs.readFileSync(artifact, "utf8"), { filename: script.src })).not.toThrow();
    }
  });
});

describe("popup Bridge permission and Pair separation", () => {
  it("shows the saved auto-rearm preference and restores the pause prompt when cleared", async () => {
    const transport = { connected: true, routeCanonical: route, routeVerification: "VERIFIED", productionEligible: true };
    const saved = await loadPopup(true, true, {
      status: { transport, autonomy: { mode: "off", rearmOnConnect: true } },
    });
    expect(saved.elements.get("user-action-hint")!.textContent)
      .toContain("连接后将自动恢复自动回流");
    expect(saved.elements.get("autonomy-disable")!.disabled).toBe(false);

    const paused = await loadPopup(true, true, {
      status: { transport, autonomy: { mode: "off", rearmOnConnect: false } },
    });
    expect(paused.elements.get("user-action-hint")!.textContent)
      .toContain("如需自动回流，请勾选确认后开启。");
    expect(paused.elements.get("user-action-hint")!.textContent)
      .not.toContain("连接后将自动恢复自动回流");
    expect(paused.elements.get("autonomy-disable")!.disabled).toBe(true);
  });

  it("Connect uses one fixed content-script request and no popup identity or owner proof", async () => {
    const { calls, elements } = await loadPopup(true);
    elements.get("bridge-origin")!.value = "https://bridge.example.test";
    await elements.get("connect-chat")!.onclick!();
    expect(calls.request).toEqual([{ origins: ["https://bridge.example.test/*"] }]);
    expect(calls.contains).toEqual([]);
    expect(calls.page).toEqual([{ type: "c2c.connect.request" }]);
    expect(calls.ownerProof).toBe(0);
    expect(calls.runtime).toEqual([]);
    expect(JSON.stringify(calls.page)).not.toMatch(/route|document|tab|credential|principal|secret/);
  });

  it("advanced Bind also sends a fixed zero-parameter request", async () => {
    const { calls, elements } = await loadPopup(true);
    await elements.get("bind")!.onclick!();
    expect(calls.page).toEqual([{ type: "c2c.bind.request" }]);
    expect(JSON.stringify(calls.page)).not.toMatch(/route|document|tab|generation|credential|principal|secret/);
  });

  it("abandon connect unknown relays a fresh owner proof id minted from the active owner document", async () => {
    // R3p review-fix: the popup itself proves nothing about which page the user
    // is on, so Abandon must first fetch a one-use owner proof through the
    // current active tab's content script and relay only the proof id; the SW
    // re-validates it against the exact durable owner.
    const { calls, elements, fireChange } = await loadPopup(true, true, {
      status: { connectState: "OUTCOME_UNKNOWN" },
    });
    elements.get("connect-abandon-confirm")!.checked = true;
    fireChange("connect-abandon-confirm");
    expect(elements.get("connect-abandon")!.disabled).toBe(false);

    await elements.get("connect-abandon")!.onclick!();

    // Proof first (owner document), then the fence-clearing message with the
    // minted proof id. The popup never supplies tab/document/route identity.
    expect(calls.ownerProof).toBe(1);
    const abandonMessage = calls.runtime.find(
      (message) => (message as { type?: string })?.type === "c2c.connect.abandon.unknown",
    ) as Record<string, unknown> | undefined;
    expect(abandonMessage).toMatchObject({
      type: "c2c.connect.abandon.unknown",
      ownerProofId: "proof-1",
    });
    expect(JSON.stringify(calls.runtime)).not.toMatch(/"tabId"|"documentId"|"routeCanonical"/);
    expect(elements.get("bridge-state")!.textContent).toContain("abandon ok=true");
  });

  it("abandon without an owner proof fails closed without sending the abandon message", async () => {
    // R3p review-fix: when the owner document cannot mint a proof, the popup
    // must fail closed locally and never send the fence-clearing message.
    const { calls, elements, fireChange } = await loadPopup(true, true, {
      status: { connectState: "OUTCOME_UNKNOWN" },
      ownerProofResult: { ok: false, reason: "owner_proof_missing" },
    });
    elements.get("connect-abandon-confirm")!.checked = true;
    fireChange("connect-abandon-confirm");

    await elements.get("connect-abandon")!.onclick!();

    expect(calls.ownerProof).toBe(1);
    expect(
      calls.runtime.find(
        (message) => (message as { type?: string })?.type === "c2c.connect.abandon.unknown",
      ),
    ).toBeUndefined();
    expect(elements.get("bridge-state")!.textContent).toContain("owner_proof_missing");
  });

  it("reports bootstrap takeover waiting without exposing a body field", async () => {
    const { calls, elements } = await loadPopup(true, true, {
      status: { connectState: "WAITING_TAKEOVER" },
      connectResult: { ok: true, state: "WAITING_TAKEOVER" },
    });
    await elements.get("connect-chat")!.onclick!();
    expect(calls.page).toEqual([{ type: "c2c.connect.request" }]);
    expect(elements.get("connect-status")!.textContent).toBe("正在等待当前 Chat 接管连接");
    expect(elements.get("user-connection-status")!.textContent).toBe("正在等待当前 Chat 接管连接");
    expect(elements.get("user-action-hint")!.textContent).toContain("完成反馈连接接管");
  });

  it("surfaces an exact bootstrap tool-missing diagnostic without retrying the message", async () => {
    const { calls, elements } = await loadPopup(true, true, {
      status: { connectState: "WAITING_TAKEOVER", connectReason: "bootstrap_tool_missing" },
    });
    expect(elements.get("user-connection-status")!.textContent).toBe("当前对话缺少反馈连接工具");
    expect(elements.get("user-action-hint")!.textContent).toContain("不会自动重发自举消息");
    expect(calls.page).toEqual([]);
  });

  it("Connect reports denied Bridge permission before contacting the page", async () => {
    const { calls, elements } = await loadPopup(false);
    elements.get("bridge-origin")!.value = "https://bridge.example.test";
    await elements.get("connect-chat")!.onclick!();
    expect(calls.page).toEqual([]);
    expect(calls.request).toEqual([{ origins: ["https://bridge.example.test/*"] }]);
    expect(calls.contains).toEqual([]);
    expect(elements.get("connect-status")!.textContent).toContain("需要授权连接服务才能继续");
    expect(elements.get("connect-diagnostic")?.textContent).toBe("bridge_permission_denied");
  });

  it("cold_pair_required opens the one-click first-use section", async () => {
    const { elements } = await loadPopup(true, true, { connectResult: { ok: false, reason: "cold_pair_required" } });
    elements.get("bridge-origin")!.value = "https://bridge.example.test";
    await elements.get("connect-chat")!.onclick!();
    expect((elements.get("first-use-settings") as { open?: boolean })?.open).toBe(true);
    expect(elements.get("pair-connect-hint")!.textContent).toContain("首次使用需要配对");
  });

  it("one-click Pair + Connect requests permission before the ordered identity flow", async () => {
    const { calls, elements } = await loadPopup(true, true, { connectResult: { ok: true, state: "CONNECTED" } });
    elements.get("bridge-origin")!.value = "https://bridge.example.test";
    elements.get("pair-json")!.value = JSON.stringify({ intentId: "intent-1", secret: "c2c_pair_secret" });
    const pending = elements.get("pair-connect")!.onclick!();
    expect(calls.order).toEqual(["permission"]);
    await pending;
    expect(calls.order).toEqual(["permission", "save-origin", "save-intent", "owner-proof", "pair", "connect"]);
    expect(calls.page).toEqual([{ type: "c2c.connect.request" }]);
    expect(JSON.stringify(calls.storage)).not.toContain("c2c_pair_secret");
    expect(elements.get("pair-json")!.value).toBe("");
    expect(elements.get("pair-secret")!.value).toBe("");
    expect(elements.get("connect-status")!.textContent).toBe("当前对话已连接");
  });

  it("shows a verified connection as healthy only for the current document owner", async () => {
    const { elements } = await loadPopup(true, true, {
      status: {
        isOwner: true,
        transport: {
          connected: true,
          routeCanonical: route,
          routeVerification: "VERIFIED",
          rebindPending: false,
          authStale: false,
          bridgeOrigin: "https://bridge.example.test",
          companionId: "companion-1",
        },
      },
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(elements.get("user-connection-status")!.textContent).toBe("当前对话已连接");
    expect(elements.get("user-connection-status")!.className).toContain("ok");
  });

  it("warns when a refreshed document is no longer the verified owner", async () => {
    const { elements } = await loadPopup(true, true, {
      status: {
        isOwner: false,
        ownership: { hasOwner: true },
        transport: {
          connected: true,
          routeVerification: "VERIFIED",
          rebindPending: false,
          authStale: false,
          bridgeOrigin: "https://bridge.example.test",
          companionId: "companion-1",
        },
      },
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(elements.get("user-connection-status")!.textContent).toBe("当前页面需要重新连接");
    expect(elements.get("user-connection-status")!.className).toContain("warn");
    expect(elements.get("user-action-hint")!.textContent).toContain("连接当前对话");
    expect(elements.get("user-action-hint")!.textContent).not.toMatch(/Pair|Verify/);
  });

  it("keeps hard auth repair ahead of the owner-missing warning", async () => {
    const { elements } = await loadPopup(true, true, {
      status: {
        isOwner: false,
        transport: {
          connected: true,
          routeVerification: "VERIFIED",
          rebindPending: false,
          authStale: true,
          bridgeOrigin: "https://bridge.example.test",
          companionId: "companion-1",
        },
      },
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(elements.get("user-connection-status")!.textContent).toBe("连接需要修复");
    expect(elements.get("user-connection-status")!.className).toContain("bad");
    expect(elements.get("user-connection-status")!.textContent).not.toContain("重新连接");
    expect(elements.get("user-action-hint")!.textContent).not.toContain("连接当前对话");
  });

  it("does not show or enable a verified old route for a new current page", async () => {
    const oldRoute = "https://chatgpt.com/c/77777777-7777-4777-8777-777777777777";
    const { elements, fireChange } = await loadPopup(true, true, {
      pageUrl: route,
      autonomyArmConfirmed: true,
      productionSendConfirmed: true,
      status: {
        isOwner: true,
        storageProtected: true,
        transport: {
          connected: true,
          routeCanonical: oldRoute,
          routeVerification: "VERIFIED",
          productionEligible: true,
          rebindPending: false,
          authStale: false,
        },
        autonomy: { mode: "off", rearmOnConnect: true },
        journal: { state: "RESERVED" },
        sendProbeLatch: "NONE",
        productionSendInFlight: false,
      },
    });
    await new Promise(resolve => setImmediate(resolve));
    fireChange("autonomy-arm-confirm");
    fireChange("production-send-confirm");
    expect(elements.get("user-connection-status")!.textContent).toBe("当前页面需要重新连接");
    expect(elements.get("user-connection-status")!.className).toContain("warn");
    expect(elements.get("autonomy-arm")!.disabled).toBe(true);
    expect(elements.get("reserve")!.disabled).toBe(true);
    expect(elements.get("production-send")!.disabled).toBe(true);
  });

  it("keeps an equivalent current route healthy and armable", async () => {
    const aliasPage = "https://www.chatgpt.com/c/11111111-1111-4111-8111-111111111111";
    const { elements } = await loadPopup(true, true, {
      pageUrl: aliasPage,
      autonomyArmConfirmed: true,
      status: {
        isOwner: true,
        storageProtected: true,
        transport: {
          connected: true,
          routeCanonical: route,
          routeVerification: "VERIFIED",
          productionEligible: true,
          rebindPending: false,
          authStale: false,
        },
        autonomy: { mode: "off", rearmOnConnect: false },
      },
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(elements.get("user-connection-status")!.textContent).toBe("当前对话已连接");
    expect(elements.get("autonomy-arm")!.disabled).toBe(false);
  });

  it("keeps rebind and route-pending warnings ahead of owner reconnect", async () => {
    const rebind = await loadPopup(true, true, {
      status: {
        isOwner: false,
        transport: {
          connected: true,
          routeVerification: "VERIFIED",
          rebindPending: true,
          authStale: false,
          bridgeOrigin: "https://bridge.example.test",
          companionId: "companion-1",
        },
      },
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(rebind.elements.get("user-connection-status")!.textContent).toBe("正在等待 ChatGPT 完成确认");
    expect(rebind.elements.get("user-action-hint")!.textContent).toContain("回到 ChatGPT 完成确认");

    const pending = await loadPopup(true, true, {
      status: {
        isOwner: false,
        transport: {
          connected: true,
          routeVerification: "PENDING",
          rebindPending: false,
          authStale: false,
          bridgeOrigin: "https://bridge.example.test",
          companionId: "companion-1",
        },
      },
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(pending.elements.get("user-connection-status")!.textContent).toBe("还差一步完成连接");
  });

  it("brand-new first-use pairing JSON bootstraps and canonicalizes bridge origin", async () => {
    const { calls, elements } = await loadPopup(true, true);
    elements.get("pair-json")!.value = JSON.stringify({
      intentId: "intent-1",
      secret: "c2c_pair_secret",
      bridgeOrigin: "https://bridge.example.test/",
    });
    await elements.get("pair-connect")!.onclick!();
    expect(calls.request).toEqual([{ origins: ["https://bridge.example.test/*"] }]);
    expect(calls.order).toEqual(["permission", "save-origin", "save-intent", "owner-proof", "pair", "connect"]);
    expect(calls.page).toEqual([{ type: "c2c.connect.request" }]);
  });

  it("legacy pairing JSON falls back to the saved bridge origin", async () => {
    const { calls, elements } = await loadPopup(true, true, { savedBridgeOrigin: "https://bridge.example.test/" });
    elements.get("pair-json")!.value = JSON.stringify({ intentId: "intent-1", secret: "c2c_pair_secret" });
    await elements.get("pair-connect")!.onclick!();
    expect(calls.request).toEqual([{ origins: ["https://bridge.example.test/*"] }]);
    expect(calls.page).toEqual([{ type: "c2c.connect.request" }]);
  });

  it("unsafe pairing JSON origin stops before permission, owner proof, and pair", async () => {
    const { calls, elements } = await loadPopup(true, true);
    elements.get("pair-json")!.value = JSON.stringify({
      intentId: "intent-1",
      secret: "c2c_pair_secret",
      bridgeOrigin: "http://evil.example.test/",
    });
    await elements.get("pair-connect")!.onclick!();
    expect(calls.order).toEqual([]);
    expect(calls.ownerProof).toBe(0);
    expect(calls.runtime).toEqual([]);
    expect(calls.page).toEqual([]);
    expect(elements.get("connect-diagnostic")!.textContent).toBe("bridge_origin_invalid");
  });

  it("without pairing or saved origin keeps the first-use origin error", async () => {
    const { calls, elements } = await loadPopup(true, true);
    elements.get("pair-json")!.value = JSON.stringify({ intentId: "intent-1", secret: "c2c_pair_secret" });
    await elements.get("pair-connect")!.onclick!();
    expect(calls.order).toEqual([]);
    expect(calls.runtime).toEqual([]);
    expect(calls.page).toEqual([]);
    expect(elements.get("connect-diagnostic")!.textContent).toBe("bridge_origin_invalid");
  });

  it("one-click Pair + Connect reports awaiting confirmation when route attestation is pending", async () => {
    const { calls, elements } = await loadPopup(true, true, { connectResult: { ok: true, state: "AWAITING_CONFIRMATION" } });
    elements.get("bridge-origin")!.value = "https://bridge.example.test";
    elements.get("pair-json")!.value = JSON.stringify({ intentId: "intent-1", secret: "c2c_pair_secret" });
    await elements.get("pair-connect")!.onclick!();
    expect(calls.page).toEqual([{ type: "c2c.connect.request" }]);
    expect(elements.get("connect-status")!.textContent).toBe("已发送连接验证，请回到 ChatGPT 完成确认");
  });

  it("one-click Pair denial stops before owner proof/pair/connect and keeps input", async () => {
    const { calls, elements } = await loadPopup(false, false);
    elements.get("bridge-origin")!.value = "https://bridge.example.test";
    elements.get("pair-json")!.value = JSON.stringify({ intentId: "intent-1", secret: "c2c_pair_secret" });
    await elements.get("pair-connect")!.onclick!();
    expect(calls.order).toEqual(["permission"]);
    expect(calls.ownerProof).toBe(0);
    expect(calls.runtime).toEqual([]);
    expect(calls.page).toEqual([]);
    expect(elements.get("pair-json")!.value).toContain("c2c_pair_secret");
  });

  it("one-click Pair failure clears the secret and does not connect", async () => {
    const { calls, elements } = await loadPopup(true, true, { pairResult: { ok: false, reason: "pair_failed" } });
    elements.get("bridge-origin")!.value = "https://bridge.example.test";
    elements.get("pair-json")!.value = JSON.stringify({ intentId: "intent-1", secret: "c2c_pair_secret" });
    await elements.get("pair-connect")!.onclick!();
    expect(calls.order).toEqual(["permission", "save-origin", "save-intent", "owner-proof", "pair"]);
    expect(calls.page).toEqual([]);
    expect(elements.get("pair-json")!.value).toBe("");
    expect(elements.get("pair-connect-hint")!.textContent).toContain("配对未成功");
  });

  it("one-click Pair rejects an active-tab change before pairing", async () => {
    const { calls, elements } = await loadPopup(true, true, { tabIds: [1, 2] });
    elements.get("bridge-origin")!.value = "https://bridge.example.test";
    elements.get("pair-json")!.value = JSON.stringify({ intentId: "intent-1", secret: "c2c_pair_secret" });
    await elements.get("pair-connect")!.onclick!();
    expect(calls.ownerProof).toBe(0);
    expect(calls.runtime).toEqual([]);
    expect(calls.page).toEqual([]);
    expect(elements.get("connect-diagnostic")!.textContent).toBe("tab_changed");
  });

  it("keeps repair controls nested while the one-click action stays in first-use flow", () => {
    const html = fs.readFileSync(path.join(sourcePopup, "popup.html"), "utf8");
    const firstUse = html.indexOf('id="first-use-settings"');
    const manual = html.indexOf('id="manual-repair"');
    expect(firstUse).toBeGreaterThan(-1);
    expect(manual).toBeGreaterThan(firstUse);
    expect(html.indexOf('id="pair-connect"')).toBeLessThan(manual);
    expect(html.indexOf('id="bind"')).toBeGreaterThan(manual);
    expect(html.indexOf('id="grant-bridge-access"')).toBeGreaterThan(manual);
    expect(html.indexOf('id="verify-route"')).toBeGreaterThan(manual);
  });

  it("Connect requests permission synchronously before storage or page work", async () => {
    const { calls, elements } = await loadPopup(true);
    elements.get("bridge-origin")!.value = "https://bridge.example.test";
    const pending = elements.get("connect-chat")!.onclick!();
    expect(calls.request).toEqual([{ origins: ["https://bridge.example.test/*"] }]);
    expect(calls.contains).toEqual([]);
    expect(calls.storage).toEqual([]);
    expect(calls.page).toEqual([]);
    await pending;
    expect(calls.page).toEqual([{ type: "c2c.connect.request" }]);
  });

  it("rebind controls send fixed payload-free SW commands", async () => {
    const { calls, elements } = await loadPopup(true);
    await elements.get("rebind-start")!.onclick!();
    await elements.get("rebind-complete")!.onclick!();
    expect(calls.runtime).toContainEqual({ type: "c2c.rebind.start", ownerProofId: "proof-1" });
    expect(calls.runtime).toContainEqual({ type: "c2c.rebind.complete" });
    expect(JSON.stringify(calls.runtime)).not.toMatch(/credential|principal|secret|redemption/);
  });

  it("missing permission blocks Pair without request, owner proof, or c2c.pair", async () => {
    const { calls, elements } = await loadPopup(false);
    elements.get("bridge-origin")!.value = "https://bridge.example.test";
    elements.get("intent-id")!.value = "intent-1";
    elements.get("pair-secret")!.value = "c2c_pair_secret";
    await elements.get("pair")!.onclick!();
    expect(calls.contains).toEqual([{ origins: ["https://bridge.example.test/*"] }]);
    expect(calls.request).toEqual([]);
    expect(calls.ownerProof).toBe(0);
    expect(calls.runtime).not.toContainEqual(expect.objectContaining({ type: "c2c.pair" }));
    expect(elements.get("transport-status")!.textContent).toBe("bridge_permission_missing");
  });

  it("granted permission keeps owner-proof then Pair flow and never stores secret", async () => {
    const { calls, elements } = await loadPopup(true);
    elements.get("bridge-origin")!.value = "https://bridge.example.test";
    elements.get("intent-id")!.value = "intent-1";
    elements.get("pair-secret")!.value = "c2c_pair_secret";
    await elements.get("pair")!.onclick!();
    expect(calls.request).toEqual([]);
    expect(calls.ownerProof).toBe(1);
    expect(calls.runtime).toContainEqual(expect.objectContaining({
      type: "c2c.pair", bridgeOrigin: "https://bridge.example.test",
      intentId: "intent-1", secret: "c2c_pair_secret", ownerProofId: "proof-1",
    }));
    expect(JSON.stringify(calls.storage)).not.toContain("c2c_pair_secret");
  });

  it("Grant requests only the exact validated Bridge origin (port retained)", async () => {
    const { calls, elements } = await loadPopup(false, true);
    elements.get("bridge-origin")!.value = "https://bridge.example.test:8443";
    await elements.get("grant-bridge-access")!.onclick!();
    expect(calls.contains).toEqual([]);
    expect(calls.request).toEqual([{ origins: ["https://bridge.example.test:8443/*"] }]);
    expect(calls.ownerProof).toBe(0);
    expect(calls.runtime).not.toContainEqual(expect.objectContaining({ type: "c2c.pair" }));
    expect(elements.get("bridge-permission-status")!.textContent).toBe("Bridge access granted");
  });

  it("Grant invokes permissions.request synchronously before any async storage write", async () => {
    const { calls, elements } = await loadPopup(false, true);
    elements.get("bridge-origin")!.value = "https://bridge.example.test:8443";
    const p = elements.get("grant-bridge-access")!.onclick!();
    // BEFORE awaiting p: request already invoked; storage not yet written.
    expect(calls.request).toHaveLength(1);
    expect(calls.storage).toHaveLength(0);
    expect(calls.contains).toHaveLength(0);
    await p;
    expect(calls.request).toEqual([{ origins: ["https://bridge.example.test:8443/*"] }]);
    expect(calls.storage).toContainEqual({ "c2c_companion_bridge_origin_v1": "https://bridge.example.test:8443" });
    expect(elements.get("bridge-origin")!.value).toBe("https://bridge.example.test:8443");
  });

  it("Grant denied permission does not persist origin or trigger pair/owner-proof", async () => {
    const { calls, elements } = await loadPopup(false, false);
    elements.get("bridge-origin")!.value = "https://bridge.example.test";
    await elements.get("grant-bridge-access")!.onclick!();
    expect(calls.request).toEqual([{ origins: ["https://bridge.example.test/*"] }]);
    expect(calls.contains).toEqual([]);
    expect(calls.storage).toEqual([]);
    expect(calls.ownerProof).toBe(0);
    expect(calls.runtime).not.toContainEqual(expect.objectContaining({ type: "c2c.pair" }));
    expect(elements.get("bridge-permission-status")!.textContent).toBe("Bridge access denied");
  });

  it("Grant always requests (no contains shortcut); already-granted path still only requests", async () => {
    const { calls, elements } = await loadPopup(true, true);
    elements.get("bridge-origin")!.value = "https://bridge.example.test";
    await elements.get("grant-bridge-access")!.onclick!();
    expect(calls.contains).toEqual([]);
    expect(calls.request).toEqual([{ origins: ["https://bridge.example.test/*"] }]);
    expect(elements.get("bridge-permission-status")!.textContent).toBe("Bridge access granted");
  });

  it("source Grant handler calls permissions.request before any await", () => {
    const src = fs.readFileSync(path.join(sourcePopup, "popup.js"), "utf8");
    const start = src.indexOf("els.grantBridgeAccess.onclick");
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, start + 900);
    const requestIdx = block.indexOf("chrome.permissions.request");
    const saveIdx = block.indexOf("saveBridgeOrigin");
    const containsIdx = block.indexOf("permissions.contains");
    expect(requestIdx).toBeGreaterThan(0);
    // saveBridgeOrigin must not appear before permissions.request in the Grant handler.
    expect(saveIdx === -1 || saveIdx > requestIdx).toBe(true);
    // contains is not used in Grant (may appear later in Pair).
    const grantEnd = block.indexOf("els.pair.onclick");
    const grantBlock = grantEnd > 0 ? block.slice(0, grantEnd) : block;
    expect(grantBlock).not.toMatch(/permissions\.contains/);
  });
});
