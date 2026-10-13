import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import "../browser-companion/operations/view.js";
import { createBridgeClient } from "../browser-companion/bridge-client.js";
import { projectStorageKey, PROJECT_REGISTRY_KEY } from "../browser-companion/project-context.js";

const first = "aaaaaaaaaaaa", second = "bbbbbbbbbbbb";
const route = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const sender = { id: "extension", tab: { id: 8 }, frameId: 0, documentId: "document", url: route };
function fixture(ids = [first]) {
  const local: Record<string, any> = { [PROJECT_REGISTRY_KEY]: { schemaVersion: 1, projects: ids.map(workspaceId => ({ workspaceId, bridgeOrigin: "https://bridge.test" })), legacyMigration: "none" } };
  const session: Record<string, any> = {};
  for (const id of ids) {
    local[projectStorageKey(id, "c2c_companion_transport_v1")] = { workspaceId: id, bridgeOrigin: "https://bridge.test", credential: `credential-${id}`, routeCanonical: route, routeVerification: "VERIFIED" };
    local[projectStorageKey(id, "c2c_companion_light_autonomy_v1")] = { enabled: true };
    session[projectStorageKey(id, "c2c_companion_light_page_v1")] = { tabId: 8, documentId: "document", url: route };
  }
  const area = (data: Record<string, any>) => ({ get: vi.fn(async (keys: any) => typeof keys === "string" ? { [keys]: data[keys] } : data), set: vi.fn(async (rows: any) => { Object.assign(data, rows); }), remove: vi.fn(async (keys: any) => { for (const key of [keys].flat()) delete data[key]; }), setAccessLevel: vi.fn(async () => {}) });
  const chrome = { runtime: { id: "extension", getURL: (path: string) => `chrome-extension://extension/${path}` }, storage: { local: area(local), session: area(session) }, permissions: { contains: vi.fn(async () => true) }, tabs: { query: vi.fn(async () => [{ id: 8, url: route }]), get: vi.fn(async () => ({ id: 8, url: route })), sendMessage: vi.fn(async (_tab: any, value: any) => ({ ok: true, observed: true, eventId: value.delivery.eventId, attemptId: value.delivery.attemptId })) } };
  const calls: { path: string; body: any; authorization: any }[] = [];
  let inFlight: any = null;
  let loseOnce = false;
  let rejectBegin = false;
  const fetcher = vi.fn(async (url: string, options: any) => {
    const path = new URL(url).pathname.replace("/api/companion/v1", "");
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, body, authorization: options.headers.authorization });
    let result: any = {};
    let ok = true;
    if (path === "/operations") result = { workspaceId: first, observedAt: new Date().toISOString(), commands: [] };
    if (path === "/web-sink/status") result = { activeBinding: { canonicalUrl: route } };
    if (path === "/state") result = { routeCanonical: route, routeVerification: "VERIFIED", inFlight };
    if (path === "/reserve") { inFlight = { status: "reserved", eventId: "event", reservationId: "reservation" }; result = { delivery: inFlight, reservationId: "reservation" }; }
    if (path === "/begin-send") {
      if (rejectBegin) { ok = false; result = { error: "BRIDGE_REJECTED" }; }
      else { inFlight = { status: "claimed", eventId: "event", attemptId: "attempt", message: "通知正文", messageSha256: createHash("sha256").update("通知正文").digest("hex") }; result = inFlight; if (loseOnce) { loseOnce = false; throw new Error("network_lost"); } }
    }
    return { ok, status: ok ? 200 : 409, json: async () => result };
  });
  return { local, session, chrome, calls, fetcher, client: createBridgeClient(chrome, fetcher), setFlight: (value: any) => { inFlight = value; }, lose: () => { loseOnce = true; }, reject: () => { rejectBegin = true; } };
}
const heartbeat = (workspaceId = first) => ({ type: "c2c.light.heartbeat", workspaceId, safety: { safe: true } });

describe("轻量 Companion Bridge client", () => {
  it("陈旧本地 fences 不阻止 Bridge 连接", async () => {
    const f = fixture();
    f.local[projectStorageKey(first, "c2c_companion_journal_v1")] = { state: "OUTCOME_UNKNOWN" };
    f.local[projectStorageKey(first, "c2c_companion_route_attest_fence_v1")] = { state: "PAIRING_TRANSITION" };
    expect((await f.client.handle({ type: "c2c.light.connect", workspaceId: first, href: "https://evil.test" }, sender)).ok).toBe(true);
    expect(f.calls.map(c => c.path)).toEqual(["/state", "/web-sink/bind-current"]);
    expect(f.calls[1].body.routeCanonical).toBe(route);
    expect(f.chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });
  it("Bridge 拒绝发送时不触碰 DOM", async () => {
    const f = fixture(); f.reject();
    expect(await f.client.handle(heartbeat(), sender)).toMatchObject({ ok: false, reason: "BRIDGE_REJECTED" });
    expect(f.chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });
  it("once 响应丢失后仅观察与 ACK，不再次 begin-send", async () => {
    const f = fixture(); f.lose();
    expect((await f.client.handle(heartbeat(), sender)).ok).toBe(false);
    expect(f.chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect((await f.client.handle(heartbeat(), sender)).ok).toBe(true);
    expect(f.calls.filter(c => c.path === "/begin-send")).toHaveLength(1);
    expect(f.calls.find(c => c.path === "/begin-send")?.body.once).toBe(true);
    expect(f.chrome.tabs.sendMessage.mock.calls[0][1].type).toBe("c2c.light.observe");
    expect(f.calls.at(-1)?.path).toBe("/ack");
  });
  it("重启后的 claimed/outcome_unknown 只观察精确文档与 ACK", async () => {
    for (const status of ["claimed", "outcome_unknown"]) {
      const f = fixture(); f.setFlight({ status, eventId: "event", attemptId: "attempt", message: "通知正文", messageSha256: createHash("sha256").update("通知正文").digest("hex") });
      const restarted = createBridgeClient(f.chrome, f.fetcher);
      expect((await restarted.handle(heartbeat(), sender)).ok).toBe(true);
      expect(f.calls.map(c => c.path)).toEqual(["/state", "/ack"]);
      expect(f.chrome.tabs.sendMessage.mock.calls[0]).toMatchObject([8, { type: "c2c.light.observe", expectedHref: route }, { documentId: "document" }]);
    }
  });
  it("刷新文档无需重新连接，真实sender重新关联后只观察", async () => {
    const f = fixture(); f.setFlight({ status: "claimed", eventId: "event", attemptId: "attempt", message: "通知正文", messageSha256: createHash("sha256").update("通知正文").digest("hex") });
    const refreshed = { ...sender, documentId: "refreshed" };
    expect((await f.client.handle({ type: "c2c.light.heartbeat", safety: { safe: false } }, refreshed)).ok).toBe(true);
    expect(f.calls.map(c => c.path)).toEqual(["/state", "/ack"]);
    expect(f.chrome.tabs.sendMessage.mock.calls[0][2]).toEqual({ documentId: "refreshed" });
  });
  it("页面不安全时不预约或开始新发送", async () => {
    const f = fixture();
    expect((await f.client.handle({ ...heartbeat(), safety: { safe: false } }, sender)).ok).toBe(true);
    expect(f.calls.map(c => c.path)).toEqual(["/state"]);
    expect(f.chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });
  it("不同 workspace 凭据和偏好互不混用", async () => {
    const f = fixture([first, second]);
    await f.client.handle({ type: "c2c.light.autonomy", workspaceId: first, enabled: false }, { id: "extension" });
    await f.client.handle(heartbeat(first), sender);
    f.setFlight(null);
    await f.client.handle(heartbeat(second), sender);
    expect(f.local[projectStorageKey(second, "c2c_companion_light_autonomy_v1")]).toEqual({ enabled: true });
    expect(f.calls[0].authorization).toBe(`Bearer credential-${first}`);
    expect(f.calls.slice(1).every(c => c.authorization === `Bearer credential-${second}`)).toBe(true);
    expect(f.calls.filter(c => c.path === "/begin-send")).toHaveLength(1);
  });
  it("配对后待确认路由自动由status提交并绑定，不发送验证消息", async () => {
    const f = fixture();
    let phase = "PENDING";
    const calls: string[] = [];
    const pairing = { workspaceId: first, credential: "new-credential", companionId: "companion", bindingId: "binding", epoch: 1, routeCanonical: route, routeVerification: "VERIFIED" };
    f.fetcher.mockImplementation(async (url: string, options: any) => {
      const path = new URL(url).pathname.replace("/api/companion/v1", ""); calls.push(path);
      let body: any = {};
      if (path === "/pair") body = { ...pairing, credential: "paired-credential", routeVerification: "PENDING" };
      if (path === "/state") body = { routeCanonical: route, routeVerification: phase === "COMMITTED" ? "VERIFIED" : "PENDING" };
      if (path.startsWith("/route/local/")) body = { state: phase, requestId: JSON.parse(options.body ?? "{}").requestId, routeCanonical: route, ...(phase === "CONFIRMED" ? { candidatePairing: pairing } : {}) };
      if (path === "/route/local/commit") { phase = "COMMITTED"; body = { state: phase, pairing }; }
      if (path === "/web-sink/status") body = { activeBinding: { canonicalUrl: route } };
      return { ok: true, status: 200, json: async () => body };
    });
    const pairReply = await f.client.handle({ type: "c2c.light.pair", workspaceId: first, bridgeOrigin: "https://bridge.test", intentId: "intent", secret: "secret" }, sender);
    expect(pairReply).toMatchObject({ ok: true, state: "PENDING" });
    expect(JSON.stringify(pairReply)).not.toMatch(/credential|candidatePairing|pairing/);
    expect(f.local[projectStorageKey(first, "c2c_companion_transport_v1")].credential).toBe("paired-credential");
    phase = "CONFIRMED";
    const statusReply = await f.client.handle({ type: "c2c.light.status", workspaceId: first }, { id: "extension" });
    expect(statusReply).toMatchObject({ ok: true, connected: true });
    expect(JSON.stringify(statusReply)).not.toMatch(/credential|candidatePairing|pairing/);
    expect(f.local[projectStorageKey(first, "c2c_companion_transport_v1")].credential).toBe("new-credential");
    expect(calls.filter(path => path === "/route/local/commit")).toHaveLength(1);
    expect(calls).toContain("/web-sink/bind-current");
    expect(f.chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(f.local)).not.toContain('"secret"');
  });
  it("浏览器重启session丢失按真实页面关联，只观察原attempt", async () => {
    const f = fixture(); delete f.session[projectStorageKey(first, "c2c_companion_light_page_v1")];
    f.setFlight({ status: "outcome_unknown", eventId: "event", attemptId: "attempt", message: "通知正文", messageSha256: createHash("sha256").update("通知正文").digest("hex") });
    expect((await f.client.handle({ type: "c2c.light.heartbeat", safety: { safe: false } }, sender)).ok).toBe(true);
    expect(f.calls.map(c => c.path)).toEqual(["/state", "/ack"]);
    expect(f.chrome.tabs.sendMessage.mock.calls[0][1].type).toBe("c2c.light.observe");
  });
  it("错误正文hash零DOM，保留服务端claim供只读恢复", async () => {
    const f = fixture(); f.setFlight({ status: "claimed", eventId: "event", attemptId: "attempt", message: "通知正文", messageSha256: "bad" });
    expect(await f.client.handle(heartbeat(), sender)).toMatchObject({ ok: false, reason: "delivery_response_invalid" });
    expect(f.chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(f.calls.map(c => c.path)).toEqual(["/state"]);
  });
  it("status只以真实活动标签页判定当前对话连接", async () => {
    const f = fixture();
    expect(await f.client.handle({ type: "c2c.light.status", workspaceId: first }, { id: "extension" })).toMatchObject({ connected: true });
    f.chrome.tabs.query.mockResolvedValue([{ id: 9, url: "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222" }]);
    expect(await f.client.handle({ type: "c2c.light.status", workspaceId: first }, { id: "extension" })).toMatchObject({ connected: false });
    expect(f.chrome.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
  });
  it("operations展示真实DOM观察，无观察时不伪造可接收", async () => {
    const f = fixture();
    const withoutObservation = await f.client.handle({ type: "c2c.operations.read", workspaceId: first }, { id: "extension" });
    expect(withoutObservation.web).toMatchObject({ observedAt: null, composer: "unknown", generation: "unknown", safe: false });
    expect((globalThis as any).C2COperations.derive(withoutObservation).web).toBe("无法确认");
    await f.client.handle({ ...heartbeat(), safety: { safe: false, composer: "dirty", generation: "idle" } }, sender);
    const busyPage = await f.client.handle({ type: "c2c.operations.read", workspaceId: first }, { id: "extension" });
    expect((globalThis as any).C2COperations.derive(busyPage).web).toBe("输入框有未发送内容");
    f.local[projectStorageKey(first, "c2c_companion_light_autonomy_v1")] = { enabled: false };
    await f.client.handle({ ...heartbeat(), safety: { safe: true, composer: "empty", generation: "idle" } }, sender);
    const readyPage = await f.client.handle({ type: "c2c.operations.read", workspaceId: first }, { id: "extension" });
    expect((globalThis as any).C2COperations.derive(readyPage).web).toBe("可接收结果");
    expect((globalThis as any).C2COperations.derive(readyPage, Date.now() + 46_000).web).toBe("无法确认");
    f.chrome.tabs.get.mockRejectedValue(new Error("tab_closed"));
    const closedPage = await f.client.handle({ type: "c2c.operations.read", workspaceId: first }, { id: "extension" });
    expect((globalThis as any).C2COperations.derive(closedPage).web).toBe("等待页面连接");
    expect((globalThis as any).C2COperations.derive({ ...readyPage, web: { ...readyPage.web, verified: false } }).web).toBe("等待 Bridge 确认连接");
  });
  it("没有Bridge权限时零请求且不保存配对secret", async () => {
    const f = fixture(); f.chrome.permissions.contains.mockResolvedValue(false);
    expect(await f.client.handle({ type: "c2c.light.pair", workspaceId: first, bridgeOrigin: "https://bridge.test", intentId: "intent", secret: "secret" }, sender)).toMatchObject({ ok: false, reason: "bridge_permission_missing" });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(f.local)).not.toContain('"secret"');
  });
  it("DOM未观察或event关联不一致时零ACK", async () => {
    const f = fixture(); f.chrome.tabs.sendMessage.mockResolvedValue({ ok: true, observed: true, eventId: "wrong", attemptId: "attempt" });
    expect(await f.client.handle(heartbeat(), sender)).toMatchObject({ ok: true, observed: false });
    expect(f.calls.some(c => c.path === "/ack")).toBe(false);
  });
});

it("格式化确认结果未知时显示当前 workspace 的核验入口", async () => {
  const f = fixture([first, second]);
  f.local[projectStorageKey(first, "c2c.panel.format.v1")] = { version: 1, workspaceId: first, confirmationSha256: "a".repeat(64) };
  expect(await f.client.handle({ type: "c2c.operations.read", workspaceId: first }, { id: "extension" })).toMatchObject({ formatPending: true });
  expect(await f.client.handle({ type: "c2c.operations.read", workspaceId: second }, { id: "extension" })).toMatchObject({ formatPending: false });
});
it("与 manifest 和现有 parser 一致接受 www 对话的真实 sender", async () => {
  const f = fixture();
  const url = route.replace("https://chatgpt.com", "https://www.chatgpt.com");
  expect(await f.client.handle({ type: "c2c.light.connect", workspaceId: first }, { ...sender, url })).toMatchObject({ ok: true, connected: true });
  expect(f.calls.at(-1)?.body.routeCanonical).toBe(url);
});
