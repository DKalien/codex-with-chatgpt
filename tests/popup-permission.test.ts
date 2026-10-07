import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  areChatgptConversationRoutesEquivalent,
  parseChatgptConversationRoute,
} from "../src/chatgpt/route.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePopup = path.join(root, "browser-companion", "popup");
const builtPopup = path.join(root, "dist", "browser-companion", "popup");
const route = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const workspaceId = "aaaaaaaaaaaa";
const project = { workspaceId, bridgeOrigin: "https://bridge.example.test", legacy: true };

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
    pageUrl?: string;
    autonomyArmConfirmed?: boolean;
    productionSendConfirmed?: boolean;
    savedBridgeOrigin?: string;
    status?: Record<string, unknown>;
    ownerProofResult?: unknown;
    statusResponse?: () => Promise<unknown>;
    runtimeResponse?: (message: unknown) => Promise<unknown>;
    projectResponse?: (message: { type?: string; workspaceId?: string }) => Promise<unknown>;
    visibility?: "visible" | "hidden";
    projects?: { workspaceId: string; bridgeOrigin: string; legacy?: boolean }[];
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
    projects: [] as unknown[],
    removed: [] as string[],
  };
  const projects = options.projects ?? [{ ...project,
    bridgeOrigin: new URL(options.savedBridgeOrigin ?? project.bridgeOrigin).origin }];
  let selectedWorkspaceId = projects[0]?.workspaceId ?? null;
  let activeTabId = options.tabId ?? 1;
  let activePageUrl = options.pageUrl ?? route;
  const requestResult = requestGranted ?? permissionGranted;
  const chrome = {
    tabs: {
      query: async () => {
        return [{ id: activeTabId, url: activePageUrl }];
      },
      sendMessage: async (_tabId: number, message: { type: string }) => {
        if (message.type === "c2c.popup.ping") {
          return { safety: { composer: "empty", generation: "idle", safe: true } };
        }
        if (message.type === "c2c.status.request") {
          if (options.statusResponse) return options.statusResponse();
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
        const input = message as { type?: string; workspaceId?: string };
        if (input.type?.startsWith("c2c.project.")) {
          calls.projects.push(message);
          if (input.type === "c2c.project.select") selectedWorkspaceId = input.workspaceId ?? null;
          const response = await options.projectResponse?.(input);
          if (response !== undefined) return response;
          if (input.type === "c2c.project.list") return { ok: true, projects };
          return { ok: true, workspaceId: selectedWorkspaceId };
        }
        calls.runtime.push(message);
        if (options.runtimeResponse) return options.runtimeResponse(message);
        if (typeof message === "object" && message && (message as { type?: string }).type === "c2c.pair") {
          calls.order.push("pair");
          return options.pairResult ?? { ok: true, transport: { workspaceId: input.workspaceId } };
        }
        if (
          typeof message === "object"
          && message
          && (message as { type?: string }).type === "c2c.route-attest.abandon.unknown"
        ) {
          // Byte-accurate success shape of handleAbandonRouteAttestUnknown so
          // the popup display assertions exercise the real zero-mutation flags.
          return {
            ok: true,
            abandoned: true,
            connectOutcome: "abandoned",
            state: "NONE",
            zeroWrite: true,
            zeroClick: true,
            zeroBridgeMutation: true,
          };
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
        remove: async (key: string) => { calls.removed.push(key); },
      },
    },
    permissions: {
      contains: async (query: unknown) => { calls.contains.push(query); calls.order.push("contains"); return permissionGranted; },
      request: (query: unknown) => {
        // Synchronous push proves gesture-time invocation from the click handler.
        calls.request.push(query);
        calls.order.push("permission");
        return Promise.resolve(requestResult);
      },
    },
  };
  const documentListeners = new Map<string, () => void>();
  const windowListeners = new Map<string, () => void>();
  const document = {
    getElementById: (id: string) => elements.get(id),
    visibilityState: options.visibility,
    addEventListener: (type: string, listener: () => void) => documentListeners.set(type, listener),
  };
  const sandbox = {
    chrome,
    document,
    addEventListener: (type: string, listener: () => void) => windowListeners.set(type, listener),
    parseChatgptConversationRoute,
    areChatgptConversationRoutesEquivalent,
    URL,
    console,
    setTimeout,
    clearTimeout,
    testRefresh: null as null | (() => Promise<boolean>),
    testRefreshProjects: null as null | (() => Promise<boolean>),
  };
  const source = fs.readFileSync(path.join(sourcePopup, "popup.js"), "utf8");
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, "globalThis.testRefresh = refresh; globalThis.testRefreshProjects = refreshProjectRegistry; })();"), sandbox);
  for (let i = 0; i < 10 && !elements.get("pair")?.onclick; i += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  const fireChange = (id: string) => Promise.all((listeners.get(id) ?? [])
    .filter(listener => listener.type === "change").map(listener => listener.handler()));
  return { calls, elements, fireChange, refresh: () => sandbox.testRefresh!(),
    refreshProjects: () => sandbox.testRefreshProjects!(),
    setActiveTab: (id: number, url = route) => { activeTabId = id; activePageUrl = url; },
    setVisibility: (value: "visible" | "hidden") => { document.visibilityState = value; documentListeners.get("visibilitychange")?.(); },
    close: () => windowListeners.get("pagehide")?.(),
  };
}

afterEach(() => { vi.useRealTimers(); });

describe("popup bounded status RPC", () => {
  it("visible popup follows completed route verification with read-only polling and stops when hidden/closed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let connected = false;
    let reads = 0;
    const popup = await loadPopup(true, true, { visibility: "visible", statusResponse: async () => {
      reads += 1;
      return { isOwner: true, storageProtected: true, connectState: connected ? "DONE" : "ATTEST_REQUESTED",
        transport: { connected: true, routeCanonical: route, routeVerification: connected ? "VERIFIED" : "PENDING",
          r5cConnected: connected, productionEligible: connected }, autonomy: { mode: connected ? "armed" : "off" } };
    } });
    connected = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(popup.elements.get("user-connection-status")!.textContent).toBe("当前对话已连接");
    expect(popup.elements.get("user-autonomy-status")!.textContent).toBe("已开启");
    expect(popup.elements.get("connect-status")!.textContent).toBe("当前对话已连接");
    expect(popup.elements.get("connect-diagnostic")!.textContent).toContain("connectState=DONE");
    const seen = reads;
    popup.setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(6000);
    expect(reads).toBe(seen);
    popup.setVisibility("visible");
    await vi.advanceTimersByTimeAsync(2000);
    expect(reads).toBe(seen + 1);
    popup.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(popup.calls.page).toEqual([]);
    expect(popup.calls.runtime).toEqual([]);
  });

  it("GET state refreshes the popup summary without connecting or sending", async () => {
    let connected = false;
    const popup = await loadPopup(true, true, { runtimeResponse: async () => ({ ok: true, status: { pendingReady: 0, reserved: 0, claimed: 0, outcomeUnknown: 0, inFlight: null } }), statusResponse: async () => ({
      isOwner: true, storageProtected: true, connectState: connected ? "DONE" : "ATTEST_REQUESTED",
      transport: { connected: true, routeCanonical: route, routeVerification: connected ? "VERIFIED" : "PENDING", r5cConnected: connected },
    }) });
    connected = true;
    await popup.elements.get("fetch-state")!.onclick!();
    expect(popup.elements.get("user-connection-status")!.textContent).toBe("当前对话已连接");
    expect(popup.calls.page).toEqual([]);
    expect(popup.calls.runtime).toEqual([{ type: "c2c.fetch.state", workspaceId }]);
  });

  it("keeps the durable stage diagnostic when Connect returns an error", async () => {
    const popup = await loadPopup(true, true, {
      connectResult: { ok: false, reason: "connect_outcome_unknown" },
      status: { connectState: "OUTCOME_UNKNOWN", routeAttestFence: "VERIFIED" },
    });
    await popup.elements.get("connect-chat")!.onclick!();
    expect(popup.elements.get("connect-diagnostic")!.textContent).toContain("connect_outcome_unknown\nconnectState=OUTCOME_UNKNOWN");
    expect(popup.elements.get("connect-diagnostic")!.textContent).toContain("routeAttestFence=VERIFIED");
  });
  it("separates a saved VERIFIED route from this page and exposes bootstrap continuation without sending", async () => {
    const popup = await loadPopup(true, true, { status: {
      connectState: "OUTCOME_UNKNOWN", routeAttestFence: "VERIFIED",
      transport: {
        connected: true, epoch: 11, routeVerification: "VERIFIED", productionEligible: true,
        routeCanonical: "https://chatgpt.com/c/77777777-7777-4777-8777-777777777777",
        takeoverRecovery: "verify_takeover",
      },
    } });
    expect(popup.elements.get("user-connection-status")!.textContent).toBe("接管结果待核验，当前页面尚未连接");
    expect(popup.elements.get("user-action-hint")!.textContent).toContain("不会重发之前的连接消息");
    expect(popup.elements.get("connect-diagnostic")!.textContent).toContain("connectState=OUTCOME_UNKNOWN");
    expect(popup.elements.get("connect-diagnostic")!.textContent).toContain("currentPageMatchesBinding=false");
    expect(popup.elements.get("autonomy-status")!.textContent).toContain("Stored binding verification: VERIFIED");
    expect(popup.elements.get("autonomy-status")!.textContent).toContain("Production eligible on current page: no");
    expect(popup.elements.get("autonomy-arm")!.disabled).toBe(true);
    expect(popup.calls.page).toEqual([]);
    expect(popup.calls.runtime).toEqual([]);
  });

  it("does not offer bootstrap continuation for an unknown route-attestation send", async () => {
    const popup = await loadPopup(true, true, { status: {
      connectState: "OUTCOME_UNKNOWN",
      transport: { connected: true, routeCanonical: route, takeoverRecovery: null },
    } });
    expect(popup.elements.get("user-connection-status")!.textContent).toBe("连接发送结果待确认，请勿重复发送");
    expect(popup.elements.get("user-action-hint")!.textContent).not.toContain("核验接管");
    expect(popup.calls.page).toEqual([]);
  });

  it("hung status settles with a bounded stage; delayed response cannot overwrite it; next refresh succeeds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let release!: (value: unknown) => void;
    const delayed = new Promise(resolve => { release = resolve; });
    let hung = true;
    const popup = await loadPopup(true, true, { statusResponse: () => hung ? delayed : Promise.resolve({
      targetRoute: route, isOwner: true, storageProtected: true, journal: { state: "NONE" },
      transport: { connected: true, routeCanonical: route, routeVerification: "VERIFIED", r5cConnected: true, productionEligible: true },
    }) });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(popup.elements.get("user-connection-status")!.textContent).toBe("连接服务响应超时");
    expect(popup.elements.get("connect-diagnostic")!.textContent).toBe("popup_timeout:c2c.status.request");
    release({ transport: { authStale: true } });
    await Promise.resolve();
    expect(popup.elements.get("user-connection-status")!.textContent).toBe("连接服务响应超时");
    hung = false;
    expect(await popup.refresh()).toBe(true);
    expect(popup.elements.get("user-connection-status")!.textContent).toBe("当前对话已连接");
    expect(popup.calls.runtime).toEqual([]);
    expect(popup.calls.page).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hung runtime.sendMessage settles and a subsequent read-only request succeeds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let hung = true;
    const popup = await loadPopup(true, true, { runtimeResponse: () => hung ? new Promise(() => {})
      : Promise.resolve({ ok: true, status: { pendingReady: 1 } }) });
    const first = popup.elements.get("fetch-state")!.onclick!();
    await vi.advanceTimersByTimeAsync(10_000);
    await first;
    expect(popup.elements.get("bridge-state")!.textContent).toContain("popup_timeout:c2c.fetch.state");
    hung = false;
    await popup.elements.get("fetch-state")!.onclick!();
    expect(popup.elements.get("bridge-state")!.textContent).toContain("1");
    expect(vi.getTimerCount()).toBe(0);
    expect(popup.calls.runtime).toEqual([{ type: "c2c.fetch.state", workspaceId }, { type: "c2c.fetch.state", workspaceId }]);
  });
});

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
  it("unbind keeps the refreshed owner gate after releasing the project action", async () => {
    let isOwner = true;
    const popup = await loadPopup(true, true, {
      statusResponse: async () => ({ isOwner, storageProtected: true }),
      runtimeResponse: async message => {
        if ((message as { type?: string }).type === "c2c.unbind") isOwner = false;
        return { ok: true };
      },
    });
    expect(popup.elements.get("pair")!.disabled).toBe(false);
    await popup.elements.get("unbind")!.onclick!();
    expect(popup.elements.get("pair")!.disabled).toBe(true);
    expect(popup.elements.get("workspace-select")!.disabled).toBe(false);
    expect(popup.calls.runtime).toEqual([{ type: "c2c.unbind", workspaceId }]);
    expect(popup.calls.ownerProof).toBe(0);
    expect(popup.calls.request).toEqual([]);
  });

  it.each(["fetch-state", "release", "recover", "write-probe", "production-send"])(
    "%s holds its project until the reply settles and clears its result when switching", async id => {
      const second = { workspaceId: "bbbbbbbbbbbb", bridgeOrigin: "https://second.example.test" };
      let release!: (value: unknown) => void;
      const delayed = new Promise(resolve => { release = resolve; });
      let started!: () => void;
      const requested = new Promise<void>(resolve => { started = resolve; });
      const popup = await loadPopup(true, true, { projects: [project, second], productionSendConfirmed: true,
        runtimeResponse: async () => { started(); return delayed; } });
      const pending = popup.elements.get(id)!.onclick!();
      await requested;
      expect(popup.elements.get("workspace-select")!.disabled).toBe(true);
      popup.elements.get("workspace-select")!.value = second.workspaceId;
      await popup.fireChange("workspace-select");
      expect(popup.elements.get("workspace-select")!.value).toBe(workspaceId);
      expect(popup.calls.projects).not.toContainEqual(expect.objectContaining({ type: "c2c.project.select", workspaceId: second.workspaceId }));
      release({ ok: true, attemptId: "a-only-result-987", status: { pendingReady: 987, reserved: 0, claimed: 0, outcomeUnknown: 0, inFlight: null } });
      await pending;
      expect(popup.calls.runtime).toHaveLength(1);
      expect(popup.calls.runtime[0]).toMatchObject({ workspaceId });
      expect(popup.elements.get("workspace-select")!.disabled).toBe(false);
      popup.elements.get("connect-status")!.textContent = "old A connected";
      popup.elements.get("bridge-permission-status")!.textContent = "old A granted";
      popup.elements.get("workspace-select")!.value = second.workspaceId;
      await popup.fireChange("workspace-select");
      expect(popup.elements.get("workspace-select")!.value).toBe(second.workspaceId);
      for (const resultId of ["bridge-state", "write-probe-result", "production-send-result", "connect-status", "bridge-permission-status"]) {
        expect(popup.elements.get(resultId)!.textContent).toBe("—");
      }
      expect(popup.calls.request).toEqual([]);
    },
  );

  it("an older project list cannot remove the newer selected project", async () => {
    const second = { workspaceId: "bbbbbbbbbbbb", bridgeOrigin: "https://second.example.test" };
    let release!: (value: unknown) => void;
    const delayed = new Promise(resolve => { release = resolve; });
    let started!: () => void;
    const requested = new Promise<void>(resolve => { started = resolve; });
    let hold = false;
    const popup = await loadPopup(true, true, { projects: [project, second], projectResponse: async message => {
      if (hold && message.type === "c2c.project.list") { hold = false; started(); return delayed; }
    } });
    hold = true;
    const oldList = popup.refreshProjects();
    await requested;
    expect(await popup.refreshProjects()).toBe(true);
    popup.elements.get("workspace-select")!.value = second.workspaceId;
    await popup.fireChange("workspace-select");
    release({ ok: true, projects: [project] });
    expect(await oldList).toBe(false);
    expect(popup.elements.get("workspace-select")!.value).toBe(second.workspaceId);
    expect(popup.elements.get("workspace-status")!.textContent).toContain(second.workspaceId);
    expect(popup.calls.runtime).toEqual([]);
  });

  it.each(["resolve", "status"])("a late A %s response cannot overwrite selected B or its requests", async stage => {
    const second = { workspaceId: "bbbbbbbbbbbb", bridgeOrigin: "https://second.example.test" };
    let release!: (value: unknown) => void;
    const delayed = new Promise(resolve => { release = resolve; });
    let started!: () => void;
    const requested = new Promise<void>(resolve => { started = resolve; });
    let hold = false;
    let held = false;
    let currentProject: typeof project | typeof second = project;
    const statusFor = (row: typeof project | typeof second) => ({
      targetRoute: route, isOwner: true, storageProtected: true, journal: { state: "NONE" },
      transport: { workspaceId: row.workspaceId, bridgeOrigin: row.bridgeOrigin, connected: true,
        routeCanonical: route, routeVerification: "VERIFIED", r5cConnected: true, productionEligible: true },
    });
    const popup = await loadPopup(true, true, {
      projects: [project, second],
      runtimeResponse: async () => ({ ok: true, status: { pendingReady: 0, reserved: 0, claimed: 0, outcomeUnknown: 0, inFlight: null } }),
      projectResponse: async message => {
        if (message.type === "c2c.project.select") currentProject = message.workspaceId === second.workspaceId ? second : project;
        if (stage === "resolve" && message.type === "c2c.project.resolve" && hold && !held) {
          held = true; started(); return delayed;
        }
      },
      statusResponse: async () => {
        if (stage === "status" && hold && !held) { held = true; started(); return delayed; }
        return statusFor(currentProject);
      },
    });
    hold = true;
    const oldRefresh = popup.refresh();
    await requested;
    popup.elements.get("workspace-select")!.value = second.workspaceId;
    await popup.fireChange("workspace-select");
    const bStatus = popup.elements.get("transport-status")!.textContent;
    expect(bStatus).toContain(second.bridgeOrigin);
    release(stage === "resolve" ? { ok: true, workspaceId } : statusFor(project));
    expect(await oldRefresh).toBe(false);
    expect(popup.elements.get("workspace-select")!.value).toBe(second.workspaceId);
    expect(popup.elements.get("transport-status")!.textContent).toBe(bStatus);
    expect(popup.elements.get("bridge-origin")!.value).toBe(second.bridgeOrigin);
    await popup.elements.get("fetch-state")!.onclick!();
    expect(popup.calls.runtime).toContainEqual({ type: "c2c.fetch.state", workspaceId: second.workspaceId });
    expect(popup.calls.request).toEqual([]);
    expect(popup.calls.ownerProof).toBe(0);
  });

  it.each([true, false])("a late selection response (ok=%s) cannot reset a newer choice", async ok => {
    const second = { workspaceId: "bbbbbbbbbbbb", bridgeOrigin: "https://second.example.test" };
    let release!: (value: unknown) => void;
    const delayed = new Promise(resolve => { release = resolve; });
    let started!: () => void;
    const requested = new Promise<void>(resolve => { started = resolve; });
    const popup = await loadPopup(true, true, { projects: [project, second], projectResponse: async message => {
      if (message.type === "c2c.project.select" && message.workspaceId === workspaceId) { started(); return delayed; }
    } });
    popup.elements.get("workspace-select")!.value = workspaceId;
    const oldSelection = popup.fireChange("workspace-select");
    await requested;
    popup.elements.get("workspace-select")!.value = second.workspaceId;
    await popup.fireChange("workspace-select");
    const bStatus = popup.elements.get("workspace-status")!.textContent;
    release({ ok, workspaceId, reason: "old_selection_failure" });
    await oldSelection;
    expect(popup.elements.get("workspace-select")!.value).toBe(second.workspaceId);
    expect(popup.elements.get("workspace-status")!.textContent).toBe(bStatus);
    expect(bStatus).toContain(second.workspaceId);
    expect(popup.calls.runtime).toEqual([]);
  });

  it.each(["tab", "route"])("a resolve response for a changed active %s cannot render old page state", async field => {
    let release!: (value: unknown) => void;
    const delayed = new Promise(resolve => { release = resolve; });
    let started!: () => void;
    const requested = new Promise<void>(resolve => { started = resolve; });
    let hold = false;
    let statusReads = 0;
    const popup = await loadPopup(true, true, {
      projectResponse: async message => { if (hold && message.type === "c2c.project.resolve") { started(); return delayed; } },
      statusResponse: async () => { statusReads += 1; return { isOwner: true, storageProtected: true }; },
    });
    const before = statusReads;
    hold = true;
    const oldRefresh = popup.refresh();
    await requested;
    popup.setActiveTab(field === "tab" ? 2 : 1, field === "route"
      ? "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222" : route);
    release({ ok: true, workspaceId });
    expect(await oldRefresh).toBe(false);
    expect(statusReads).toBe(before);
    expect(popup.calls.runtime).toEqual([]);
    expect(popup.calls.page).toEqual([]);
  });

  it("a Pair JSON for another selected project cannot write its intent or request a proof", async () => {
    const second = { workspaceId: "bbbbbbbbbbbb", bridgeOrigin: "https://second.example.test" };
    const { calls, elements } = await loadPopup(true, true, { projects: [second, project] });
    elements.get("pair-json")!.value = JSON.stringify({ ...project, legacy: undefined,
      intentId: "intent-a", secret: "secret-a", expiresAt: "2026-10-06T03:00:00.000Z", bindingId: "binding-a", epoch: 2 });
    await elements.get("apply-pair-json")!.onclick!();
    expect(elements.get("pair-hint")!.textContent).toBe("workspace_selection_mismatch");
    await elements.get("pair-connect")!.onclick!();
    expect(calls.contains).toEqual([]);
    expect(calls.request).toEqual([]);
    expect(calls.ownerProof).toBe(0);
    expect(calls.storage).toEqual([]);
    expect(calls.runtime).toEqual([]);
  });

  it("a delayed Pair remains in its captured project and blocks selection until it settles", async () => {
    let settlePair!: (value: unknown) => void;
    const paired = new Promise(resolve => { settlePair = resolve; });
    const { calls, elements, fireChange } = await loadPopup(true, true, {
      projects: [project, { workspaceId: "bbbbbbbbbbbb", bridgeOrigin: "https://second.example.test" }],
      runtimeResponse: async message => (message as { type: string }).type === "c2c.pair" ? paired : { ok: true },
    });
    elements.get("pair-json")!.value = JSON.stringify({ workspaceId, bridgeOrigin: project.bridgeOrigin, intentId: "intent-a", secret: "secret-a" });
    const pending = elements.get("pair-connect")!.onclick!();
    for (let tick = 0; tick < 5 && !calls.runtime.length; tick++) await new Promise(resolve => setImmediate(resolve));
    expect(calls.runtime).toContainEqual(expect.objectContaining({ type: "c2c.pair", workspaceId }));
    elements.get("workspace-select")!.value = "bbbbbbbbbbbb";
    await fireChange("workspace-select");
    expect(calls.projects).not.toContainEqual(expect.objectContaining({ type: "c2c.project.select", workspaceId: "bbbbbbbbbbbb" }));
    settlePair({ ok: true, transport: { workspaceId } });
    await pending;
    expect(calls.removed).toEqual([`c2c_companion_project_v1:${workspaceId}:c2c_companion_pair_intent_v1`]);
    expect(calls.page).toEqual([{ type: "c2c.connect.request", workspaceId, canonicalRoute: route }]);
    expect(JSON.stringify(calls.storage)).not.toContain("secret-a");
    expect(JSON.stringify(calls.storage)).not.toContain("bbbbbbbbbbbb");
  });

  it("shows the saved auto-rearm preference and restores the pause prompt when cleared", async () => {
    const transport = { connected: true, routeCanonical: route, routeVerification: "VERIFIED", r5cConnected: true, productionEligible: true };
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

  it("Connect checks permission and sends only the selected project and route witness", async () => {
    const { calls, elements } = await loadPopup(true);
    elements.get("bridge-origin")!.value = "https://bridge.example.test";
    await elements.get("connect-chat")!.onclick!();
    expect(calls.request).toEqual([]);
    expect(calls.contains).toEqual([{ origins: ["https://bridge.example.test/*"] }]);
    expect(calls.page).toEqual([{ type: "c2c.connect.request", workspaceId, canonicalRoute: route }]);
    expect(calls.ownerProof).toBe(0);
    expect(calls.runtime).toEqual([]);
    expect(JSON.stringify(calls.page)).not.toMatch(/document|tab|credential|principal|secret/);
  });

  it("advanced Bind fixes the selected project without popup document or route authority", async () => {
    const { calls, elements } = await loadPopup(true);
    await elements.get("bind")!.onclick!();
    expect(calls.page).toEqual([{ type: "c2c.bind.request", workspaceId }]);
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

  it("route-attest abandon enables only with confirm checkbox AND a durable OUTCOME_UNKNOWN attest fence", async () => {
    // R3q: the popup gate is only a pre-filter; exact owner / rebind / challenge
    // identity are re-validated inside the SW via a fresh one-use owner proof.
    const armed = await loadPopup(true, true, {
      status: { routeAttestFence: "OUTCOME_UNKNOWN" },
    });
    expect(armed.elements.get("route-attest-abandon")!.disabled).toBe(true);
    armed.elements.get("route-attest-abandon-confirm")!.checked = true;
    armed.fireChange("route-attest-abandon-confirm");
    expect(armed.elements.get("route-attest-abandon")!.disabled).toBe(false);

    const unhardened = await loadPopup(true, true, {
      status: { routeAttestFence: "NONE" },
    });
    unhardened.elements.get("route-attest-abandon-confirm")!.checked = true;
    unhardened.fireChange("route-attest-abandon-confirm");
    expect(unhardened.elements.get("route-attest-abandon")!.disabled).toBe(true);

    const missingStatus = await loadPopup(true, true);
    missingStatus.elements.get("route-attest-abandon-confirm")!.checked = true;
    missingStatus.fireChange("route-attest-abandon-confirm");
    expect(missingStatus.elements.get("route-attest-abandon")!.disabled).toBe(true);
  });

  it("route-attest abandon relays a fresh owner proof id only (no tab/document/route authority)", async () => {
    const { calls, elements, fireChange } = await loadPopup(true, true, {
      status: { routeAttestFence: "OUTCOME_UNKNOWN" },
    });
    elements.get("route-attest-abandon-confirm")!.checked = true;
    fireChange("route-attest-abandon-confirm");
    expect(elements.get("route-attest-abandon")!.disabled).toBe(false);

    await elements.get("route-attest-abandon")!.onclick!();

    // Same proof relay as the connect abandon: one-use proof minted by the
    // CURRENT active owner document; the popup never supplies tab/document/
    // route/challenge identity.
    expect(calls.ownerProof).toBe(1);
    const abandonMessage = calls.runtime.find(
      (message) => (message as { type?: string })?.type === "c2c.route-attest.abandon.unknown",
    ) as Record<string, unknown> | undefined;
    expect(abandonMessage).toMatchObject({
      type: "c2c.route-attest.abandon.unknown",
      ownerProofId: "proof-1",
    });
    expect(JSON.stringify(calls.runtime)).not.toMatch(/"tabId"|"documentId"|"routeCanonical"|challengeId/);
    expect(elements.get("bridge-state")!.textContent).toContain("attest abandon ok=true");
    expect(elements.get("bridge-state")!.textContent).toContain("zeroWrite=true");
  });

  it("route-attest abandon without an owner proof fails closed without sending the abandon message", async () => {
    const { calls, elements, fireChange } = await loadPopup(true, true, {
      status: { routeAttestFence: "OUTCOME_UNKNOWN" },
      ownerProofResult: { ok: false, reason: "owner_proof_missing" },
    });
    elements.get("route-attest-abandon-confirm")!.checked = true;
    fireChange("route-attest-abandon-confirm");

    await elements.get("route-attest-abandon")!.onclick!();

    expect(calls.ownerProof).toBe(1);
    expect(
      calls.runtime.find(
        (message) => (message as { type?: string })?.type === "c2c.route-attest.abandon.unknown",
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
    expect(calls.page).toEqual([{ type: "c2c.connect.request", workspaceId, canonicalRoute: route }]);
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

  it("Connect reports missing Bridge permission before contacting the page", async () => {
    const { calls, elements } = await loadPopup(false);
    elements.get("bridge-origin")!.value = "https://bridge.example.test";
    await elements.get("connect-chat")!.onclick!();
    expect(calls.page).toEqual([]);
    expect(calls.request).toEqual([]);
    expect(calls.contains).toEqual([{ origins: ["https://bridge.example.test/*"] }]);
    expect(elements.get("connect-status")!.textContent).toContain("授权连接服务");
    expect(elements.get("connect-diagnostic")?.textContent).toBe("bridge_permission_missing");
  });

  it("cold_pair_required opens the one-click first-use section", async () => {
    const { elements } = await loadPopup(true, true, { connectResult: { ok: false, reason: "cold_pair_required" } });
    elements.get("bridge-origin")!.value = "https://bridge.example.test";
    await elements.get("connect-chat")!.onclick!();
    expect((elements.get("first-use-settings") as { open?: boolean })?.open).toBe(true);
    expect(elements.get("pair-connect-hint")!.textContent).toContain("首次使用需要配对");
  });

  it("one-click Pair + Connect checks existing permission before the ordered identity flow", async () => {
    const { calls, elements } = await loadPopup(true, true, {
      connectResult: { ok: true, state: "CONNECTED" },
      status: { transport: { connected: true, routeCanonical: route, routeVerification: "VERIFIED", r5cConnected: true } },
    });
    elements.get("bridge-origin")!.value = "https://bridge.example.test";
    elements.get("pair-json")!.value = JSON.stringify({ intentId: "intent-1", secret: "c2c_pair_secret" });
    const pending = elements.get("pair-connect")!.onclick!();
    expect(calls.order).toEqual(["contains"]);
    await pending;
    expect(calls.order).toEqual(["contains", "save-intent", "owner-proof", "pair", "connect"]);
    expect(calls.request).toEqual([]);
    expect(calls.page).toEqual([{ type: "c2c.connect.request", workspaceId, canonicalRoute: route }]);
    expect(JSON.stringify(calls.storage)).not.toContain("c2c_pair_secret");
    expect(elements.get("pair-json")!.value).toBe("");
    expect(elements.get("pair-secret")!.value).toBe("");
    expect(elements.get("connect-status")!.textContent).toBe("当前对话已连接");
  });

  it("both Connect entries keep a retry hint when CONNECTED has no authoritative Web Sink", async () => {
    for (const button of ["connect-chat", "pair-connect"]) {
      const { elements } = await loadPopup(true, true, {
        connectResult: { ok: true, state: "CONNECTED" },
        status: { transport: { connected: true, routeCanonical: route, routeVerification: "VERIFIED", r5cConnected: false } },
      });
      elements.get("bridge-origin")!.value = "https://bridge.example.test";
      if (button === "pair-connect") {
        elements.get("pair-json")!.value = JSON.stringify({ intentId: "intent-1", secret: "c2c_pair_secret" });
      }
      await elements.get(button)!.onclick!();
      expect(elements.get("connect-status")!.textContent).toContain("尚未完成连接");
      expect(elements.get("connect-status")!.textContent).not.toBe("当前对话已连接");
      expect(elements.get("user-connection-status")!.textContent).toBe("当前对话需要完成连接");
    }
  });

  it("shows a verified connection as healthy only for the current document owner", async () => {
    const { elements } = await loadPopup(true, true, {
      status: {
        isOwner: true,
        transport: {
          connected: true,
          routeCanonical: route,
          routeVerification: "VERIFIED", r5cConnected: true,
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
          routeVerification: "VERIFIED", r5cConnected: true,
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
          connected: false,
          routeVerification: "VERIFIED", r5cConnected: true,
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
    expect(elements.get("transport-status")!.textContent).toContain("保留原配对");
    expect(elements.get("transport-status")!.textContent).not.toContain("重新 pair");
    expect(elements.get("fetch-state")!.disabled).toBe(false);
    expect(elements.get("reserve")!.disabled).toBe(true);
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
          routeVerification: "VERIFIED", r5cConnected: true,
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
          routeVerification: "VERIFIED", r5cConnected: true,
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
          routeVerification: "VERIFIED", r5cConnected: true,
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

  it("complete server pairing JSON retains metadata and canonicalizes the registered origin", async () => {
    const { calls, elements } = await loadPopup(true, true);
    elements.get("pair-json")!.value = JSON.stringify({
      intentId: "intent-1",
      secret: "c2c_pair_secret",
      bridgeOrigin: "https://bridge.example.test/",
      workspaceId, bindingId: "binding-1", epoch: 1, expiresAt: "2026-10-06T03:00:00.000Z",
    });
    await elements.get("pair-connect")!.onclick!();
    expect(calls.request).toEqual([]);
    expect(calls.contains).toEqual([{ origins: ["https://bridge.example.test/*"] }]);
    expect(calls.order).toEqual(["contains", "save-intent", "owner-proof", "pair", "connect"]);
    expect(calls.page).toEqual([{ type: "c2c.connect.request", workspaceId, canonicalRoute: route }]);
  });

  it("legacy pairing JSON falls back only to the explicitly selected single project", async () => {
    const { calls, elements } = await loadPopup(true, true, { savedBridgeOrigin: "https://bridge.example.test/" });
    elements.get("pair-json")!.value = JSON.stringify({ intentId: "intent-1", secret: "c2c_pair_secret" });
    await elements.get("pair-connect")!.onclick!();
    expect(calls.request).toEqual([]);
    expect(calls.contains).toEqual([{ origins: ["https://bridge.example.test/*"] }]);
    expect(calls.page).toEqual([{ type: "c2c.connect.request", workspaceId, canonicalRoute: route }]);
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

  it("without a registered project rejects pairing before permission or page work", async () => {
    const { calls, elements } = await loadPopup(true, true, { projects: [] });
    elements.get("pair-json")!.value = JSON.stringify({ intentId: "intent-1", secret: "c2c_pair_secret" });
    await elements.get("pair-connect")!.onclick!();
    expect(calls.order).toEqual([]);
    expect(calls.runtime).toEqual([]);
    expect(calls.page).toEqual([]);
    expect(elements.get("connect-diagnostic")!.textContent).toBe("workspace_id_required");
  });

  it("one-click Pair + Connect reports awaiting confirmation when route attestation is pending", async () => {
    const { calls, elements } = await loadPopup(true, true, { connectResult: { ok: true, state: "AWAITING_CONFIRMATION" } });
    elements.get("bridge-origin")!.value = "https://bridge.example.test";
    elements.get("pair-json")!.value = JSON.stringify({ intentId: "intent-1", secret: "c2c_pair_secret" });
    await elements.get("pair-connect")!.onclick!();
    expect(calls.page).toEqual([{ type: "c2c.connect.request", workspaceId, canonicalRoute: route }]);
    expect(elements.get("connect-status")!.textContent).toBe("已发送连接验证，请回到 ChatGPT 完成确认");
  });

  it("one-click Pair denial stops before owner proof/pair/connect and keeps input", async () => {
    const { calls, elements } = await loadPopup(false, false);
    elements.get("bridge-origin")!.value = "https://bridge.example.test";
    elements.get("pair-json")!.value = JSON.stringify({ intentId: "intent-1", secret: "c2c_pair_secret" });
    await elements.get("pair-connect")!.onclick!();
    expect(calls.order).toEqual(["contains"]);
    expect(calls.request).toEqual([]);
    expect(calls.storage).toEqual([]);
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
    expect(calls.order).toEqual(["contains", "save-intent", "owner-proof", "pair"]);
    expect(calls.page).toEqual([]);
    expect(elements.get("pair-json")!.value).toBe("");
    expect(elements.get("pair-connect-hint")!.textContent).toContain("配对未成功");
  });

  it("one-click Pair rejects an active-tab change before pairing", async () => {
    const { calls, elements, setActiveTab } = await loadPopup(true, true);
    setActiveTab(2);
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

  it("Connect checks permission before storage or page work", async () => {
    const { calls, elements } = await loadPopup(true);
    elements.get("bridge-origin")!.value = "https://bridge.example.test";
    const pending = elements.get("connect-chat")!.onclick!();
    expect(calls.request).toEqual([]);
    expect(calls.contains).toEqual([{ origins: ["https://bridge.example.test/*"] }]);
    expect(calls.storage).toEqual([]);
    expect(calls.page).toEqual([]);
    await pending;
    expect(calls.page).toEqual([{ type: "c2c.connect.request", workspaceId, canonicalRoute: route }]);
  });

  it("rebind controls send fixed payload-free SW commands", async () => {
    const { calls, elements } = await loadPopup(true);
    await elements.get("rebind-start")!.onclick!();
    await elements.get("rebind-complete")!.onclick!();
    expect(calls.runtime).toContainEqual({ type: "c2c.rebind.start", ownerProofId: "proof-1", workspaceId });
    expect(calls.runtime).toContainEqual({ type: "c2c.rebind.complete", workspaceId });
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
    const { calls, elements } = await loadPopup(false, true, { projects: [{ ...project, bridgeOrigin: "https://bridge.example.test:8443" }] });
    elements.get("bridge-origin")!.value = "https://bridge.example.test:8443";
    await elements.get("grant-bridge-access")!.onclick!();
    expect(calls.contains).toEqual([]);
    expect(calls.request).toEqual([{ origins: ["https://bridge.example.test:8443/*"] }]);
    expect(calls.ownerProof).toBe(0);
    expect(calls.runtime).not.toContainEqual(expect.objectContaining({ type: "c2c.pair" }));
    expect(elements.get("bridge-permission-status")!.textContent).toBe("Bridge access granted");
  });

  it("Grant invokes permissions.request synchronously before any async storage write", async () => {
    const { calls, elements } = await loadPopup(false, true, { projects: [{ ...project, bridgeOrigin: "https://bridge.example.test:8443" }] });
    elements.get("bridge-origin")!.value = "https://bridge.example.test:8443";
    const p = elements.get("grant-bridge-access")!.onclick!();
    // BEFORE awaiting p: request already invoked; storage not yet written.
    expect(calls.request).toHaveLength(1);
    expect(calls.storage).toHaveLength(0);
    expect(calls.contains).toHaveLength(0);
    await p;
    expect(calls.request).toEqual([{ origins: ["https://bridge.example.test:8443/*"] }]);
    expect(calls.storage).toEqual([]);
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

  it("pending Web Sink shows reconnect hint without full connected", async () => {
    const { calls, elements } = await loadPopup(true, true, {
      status: {
        isOwner: true,
        transport: {
          connected: true,
          routeVerification: "VERIFIED",
          r5cConnected: false,
          webSinkConverged: false,
          routeCanonical: route,
          authStale: false,
          rebindPending: false,
        },
        connectState: "DONE",
      },
    });
    expect(elements.get("user-connection-status")!.textContent).toBe("当前对话需要完成连接");
    expect(elements.get("user-connection-status")!.className).toContain("warn");
    const hint = elements.get("user-action-hint")?.textContent ?? "";
    expect(hint).toContain("连接当前对话");
    expect(calls.ownerProof).toBeGreaterThanOrEqual(0);
  });

});
