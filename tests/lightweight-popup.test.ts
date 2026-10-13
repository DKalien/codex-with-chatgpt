import fs from "node:fs";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const root = "browser-companion/popup/";
const pair = { workspaceId: "012345abcdef", bridgeOrigin: "https://bridge.example", intentId: "intent", secret: "c2c_pair_secret" };
const other = { workspaceId: "abcdef012345", bridgeOrigin: "https://other.example" };

type Message = Record<string, any>;
async function load(options: { granted?: boolean; failure?: string; timeout?: boolean; pending?: boolean } = {}) {
  const html = fs.readFileSync(`${root}lightweight.html`, "utf8");
  const elements = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], {
    value: "", textContent: "", href: "", disabled: false, onclick: null as null | (() => Promise<void>),
    onchange: null as null | (() => Promise<void>), replaceChildren: (..._args: unknown[]) => {},
  }]));
  const calls = { runtime: [] as Message[], page: [] as Message[], request: [] as unknown[], contains: [] as unknown[], storage: [] as unknown[] };
  let projects = [other];
  let selectedWorkspaceId: string | null = other.workspaceId;
  let enabled = false;
  let pending = false;
  let close: (() => void) | undefined;
  const context = vm.createContext({
    URL, setTimeout, clearTimeout,
    document: { getElementById: (id: string) => elements[id] },
    Option: function (this: Message, label: string, value: string) { this.label = label; this.value = value; },
    addEventListener: (_event: string, listener: () => void) => { close = listener; },
    chrome: {
      storage: { local: { set: (data: unknown) => calls.storage.push(data) }, session: { set: (data: unknown) => calls.storage.push(data) } },
      permissions: {
        contains: async (query: unknown) => { calls.contains.push(query); return options.granted ?? true; },
        request: (query: unknown) => { calls.request.push(query); return Promise.resolve(true); },
      },
      tabs: {
        query: async () => [{ id: 7 }],
        sendMessage: async (tab: number, message: Message) => {
          calls.page.push({ tab, ...message });
          if (options.pending) { pending = true; return { ok: true, state: "PENDING" }; }
          if (options.timeout) return new Promise(() => {});
          return options.failure ? { ok: false, reason: options.failure } : { ok: true, state: "CONNECTED" };
        },
      },
      runtime: { sendMessage: async (message: Message) => {
        calls.runtime.push(message);
        if (message.type === "c2c.light.projects.add") projects.push({ workspaceId: message.workspaceId, bridgeOrigin: message.bridgeOrigin });
        if (message.type === "c2c.light.projects.select") selectedWorkspaceId = message.workspaceId;
        if (message.type.startsWith("c2c.light.projects.")) return { ok: true, projects, selectedWorkspaceId };
        if (message.type === "c2c.light.autonomy") enabled = message.enabled;
        return { ok: true, paired: true, connected: pending, autonomy: { enabled } };
      } },
    },
  });
  const originSource = fs.readFileSync("browser-companion/bridge-origin.js", "utf8").replace(/^import .*;\s*$/gm, "").replace(/^export /gm, "");
  vm.runInContext(originSource, context);
  const source = fs.readFileSync(`${root}lightweight.js`, "utf8").replace(/^import .*;\s*$/gm, "");
  vm.runInContext(source.replace("void action(", "globalThis.ready = action("), context);
  await context.ready;
  return { elements, calls, close: () => close?.(), click: async (id: string) => { await elements[id].onclick!(); } };
}

afterEach(() => vi.useRealTimers());
describe("轻量 popup", () => {
  it("保留已选择的项目，只读取状态，不自动请求权限或连接", async () => {
    const ui = await load();
    expect(ui.elements.project.value).toBe(other.workspaceId);
    expect(ui.elements.operations.href).toContain(`workspaceId=${other.workspaceId}`);
    expect(ui.calls.request).toEqual([]);
    expect(ui.calls.page).toEqual([]);
    expect(ui.calls.runtime.map(item => item.type)).toEqual(["c2c.light.projects.list", "c2c.light.status"]);
  });
  it("缺少权限时配对不请求权限、不登记或向当前页发送", async () => {
    const ui = await load({ granted: false });
    ui.elements["pair-json"].value = JSON.stringify(pair);
    await ui.click("pair");
    expect(ui.calls.contains).toEqual([{ origins: [`${pair.bridgeOrigin}/*`] }]);
    expect(ui.calls.request).toEqual([]);
    expect(ui.calls.page).toEqual([]);
    expect(ui.calls.runtime.some(item => item.type === "c2c.light.projects.add")).toBe(false);
    expect(ui.elements.error.textContent).toContain("bridge_permission_missing");
  });
  it("独立 Grant 同步请求精确 origin 权限，不配对、不存密钥", async () => {
    const ui = await load();
    ui.elements["pair-json"].value = JSON.stringify(pair);
    const pending = ui.elements.grant.onclick!();
    expect(ui.calls.request).toEqual([{ origins: [`${pair.bridgeOrigin}/*`] }]);
    await pending;
    expect(ui.calls.page).toEqual([]);
    expect(ui.calls.storage).toEqual([]);
  });
  it("配对自动登记并选中 JSON 项目，仅向活动页传递密钥", async () => {
    const ui = await load();
    ui.elements["pair-json"].value = JSON.stringify(pair);
    await ui.click("pair");
    expect(ui.elements.project.value).toBe(pair.workspaceId);
    expect(ui.calls.runtime.find(item => item.type === "c2c.light.projects.add")).toEqual({ type: "c2c.light.projects.add", workspaceId: pair.workspaceId, bridgeOrigin: pair.bridgeOrigin });
    expect(ui.calls.page).toEqual([{ tab: 7, type: "c2c.light.pair.request", ...pair }]);
    expect(ui.calls.request).toEqual([]);
    expect(ui.calls.storage).toEqual([]);
    expect(JSON.stringify(ui.calls.runtime)).not.toContain(pair.secret);
    expect(ui.elements["pair-json"].value).toBe("");
  });
  it("连接使用选中项目，自动回流启停委托 Bridge", async () => {
    const ui = await load();
    await ui.click("connect");
    expect(ui.calls.page).toEqual([{ tab: 7, type: "c2c.light.connect.request", ...other }]);
    await ui.click("autonomy");
    expect(ui.elements["autonomy-status"].textContent).toContain("已开启");
    await ui.click("autonomy");
    expect(ui.calls.runtime.filter(item => item.type === "c2c.light.autonomy").map(item => item.enabled)).toEqual([true, false]);
  });
  it("Bridge 拒绝原因始终可见，关闭清空配对 JSON", async () => {
    const ui = await load({ failure: "binding_not_enabled" });
    await ui.click("connect");
    expect(ui.elements.error.textContent).toBe("binding_not_enabled");
    ui.elements["pair-json"].value = JSON.stringify(pair);
    ui.close();
    expect(ui.elements["pair-json"].value).toBe("");
  });
  it("连接超时解释未知结果且不自动重试", async () => {
    vi.useFakeTimers();
    const ui = await load({ timeout: true });
    const pending = ui.click("connect");
    await vi.advanceTimersByTimeAsync(15000);
    await pending;
    expect(ui.elements.error.textContent).toContain("request_timeout");
    expect(ui.elements.error.textContent).toContain("不会自动重试");
    expect(ui.calls.page).toHaveLength(1);
  });
  it("配对 pending 自动只读等待 Bridge 收敛，无需第二次点击", async () => {
    vi.useFakeTimers();
    const ui = await load({ pending: true });
    ui.elements["pair-json"].value = JSON.stringify(pair);
    const pending = ui.click("pair");
    await vi.advanceTimersByTimeAsync(1500);
    await pending;
    expect(ui.elements.status.textContent).toBe("当前对话已连接");
    expect(ui.calls.page).toHaveLength(1);
    expect(ui.calls.runtime.filter(item => item.type === "c2c.light.status")).toHaveLength(2);
  });
  it("非法 JSON 或非安全 origin 不请求权限、不发送", async () => {
    const ui = await load();
    for (const value of ["[]", JSON.stringify({ ...pair, bridgeOrigin: "http://untrusted.example" }), JSON.stringify({ ...pair, bridgeOrigin: "https://bridge.example/path" })]) {
      ui.elements["pair-json"].value = value;
      await ui.click("grant");
      expect(ui.elements.error.textContent).not.toBe("");
    }
    expect(ui.calls.request).toEqual([]);
    expect(ui.calls.page).toEqual([]);
  });
});
