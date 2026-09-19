import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

async function loadPopup(permissionGranted: boolean, requestGranted?: boolean) {
  const html = fs.readFileSync(path.join(sourcePopup, "popup.html"), "utf8");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  const elements = new Map(ids.map(id => [id, {
    value: "", textContent: "", className: "", disabled: false, checked: false,
    onclick: null as null | (() => Promise<void>),
    addEventListener: () => undefined,
  }]));
  const calls = {
    contains: [] as unknown[], request: [] as unknown[], ownerProof: 0,
    runtime: [] as unknown[], storage: [] as unknown[],
  };
  const requestResult = requestGranted ?? permissionGranted;
  const chrome = {
    tabs: {
      query: async () => [{ id: 1, url: route }],
      sendMessage: async (_tabId: number, message: { type: string }) => {
        if (message.type === "c2c.popup.ping") {
          return { safety: { composer: "empty", generation: "idle", safe: true } };
        }
        if (message.type === "c2c.status.request") {
          return {
            targetRoute: route, isOwner: true, storageProtected: true,
            ownership: { hasOwner: true }, transport: null,
            journal: { state: "NONE" }, sendProbeLatch: "NONE",
          };
        }
        if (message.type === "c2c.owner-proof.request") {
          calls.ownerProof += 1;
          return { ok: true, proof: { id: "proof-1" } };
        }
        return { ok: true };
      },
    },
    runtime: {
      sendMessage: async (message: unknown) => {
        calls.runtime.push(message);
        return { ok: true };
      },
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async (value: unknown) => { calls.storage.push(value); },
      },
      session: {
        get: async () => ({}),
        set: async (value: unknown) => { calls.storage.push(value); },
        remove: async () => undefined,
      },
    },
    permissions: {
      contains: async (query: unknown) => { calls.contains.push(query); return permissionGranted; },
      request: (query: unknown) => {
        // Synchronous push proves gesture-time invocation from the click handler.
        calls.request.push(query);
        return Promise.resolve(requestResult);
      },
    },
  };
  const sandbox = {
    chrome,
    document: { getElementById: (id: string) => elements.get(id) },
    parseChatgptConversationRoute: () => ({ canonical: route }),
    URL,
    console,
  };
  vm.runInNewContext(fs.readFileSync(path.join(sourcePopup, "popup.js"), "utf8"), sandbox);
  for (let i = 0; i < 10 && !elements.get("pair")?.onclick; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  return { calls, elements };
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
    for (const script of popupScripts(builtPopup)) {
      if (/\btype=["']module["']/i.test(script.attributes)) continue;
      const artifact = path.resolve(builtPopup, script.src);
      expect(() => new vm.Script(fs.readFileSync(artifact, "utf8"), { filename: script.src })).not.toThrow();
    }
  });
});

describe("popup Bridge permission and Pair separation", () => {
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
