import http from "node:http";
import express from "express";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createBridgeClient } from "../browser-companion/bridge-client.js";
import { PROJECT_REGISTRY_KEY, projectStorageKey } from "../browser-companion/project-context.js";
import { createCompanionRouter } from "../src/bridge/companion.js";
import { Workspace } from "../src/workspace/manager.js";
import { projectRemoteResult } from "../src/remote/results.js";
import { readResultBus } from "../src/result-bus/store.js";
import { ensureFeedbackState } from "../src/feedback/state-store.js";
import { enableReceiver } from "../src/feedback/receiver.js";
import { createPairingIntent, confirmRouteAttestation } from "../src/feedback/companion.js";
import { resolveConversationPrincipal } from "../src/mcp/conversation-principal.js";
import { makeTmpDir } from "./helpers.js";
import { cleanupStrict } from "./strict-teardown.js";
import { requestHttp, requestJson } from "./http-json.js";

const route = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const sender = { id: "extension", tab: { id: 8 }, frameId: 0, documentId: "document", url: route };
let stateDir: string, oldState: string | undefined;
let roots: string[], servers: http.Server[];
beforeEach(() => {
  roots = []; servers = []; stateDir = makeTmpDir("light-integration-state");
  oldState = process.env.C2C_STATE_DIR; process.env.C2C_STATE_DIR = stateDir;
});
afterEach(async () => {
  for (const server of servers) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (oldState === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = oldState;
  await cleanupStrict(stateDir, ...roots);
});

async function bridge() {
  const root = makeTmpDir("light-integration-work"); roots.push(root);
  const workspace = new Workspace(root);
  let disconnectBegin = false;
  const app = express(); app.use(express.json());
  app.use((req, res, next) => {
    const json = res.json.bind(res);
    res.json = body => {
      // 测试故障：真实 begin-send 已提交后断开 socket，客户端拿不到发送许可响应。
      if (disconnectBegin && req.path.endsWith("/begin-send") && res.statusCode === 200) {
        disconnectBegin = false; res.socket!.destroy(); return res;
      }
      return json(body);
    };
    next();
  });
  app.use("/api/companion/v1", createCompanionRouter({ workspaceId: workspace.id, workspaceRoot: root, stateDir }));
  const server = http.createServer(app); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const principal = resolveConversationPrincipal({ authInfo: { token: "fixture", clientId: "client", scopes: ["codex.feedback"] },
    _meta: { "openai/session": `light-${workspace.id}` } } as never);
  ensureFeedbackState(workspace.id, 0, stateDir);
  enableReceiver({ workspaceId: workspace.id, principal, widgetId: "fixture", stateDir });
  const intent = createPairingIntent({ workspaceId: workspace.id, principal, stateDir });
  const pair = await requestJson(`${origin}/api/companion/v1/pair`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ intentId: intent.intentId, secret: intent.secret, routeCanonical: route }) });
  expect(pair.status).toBe(200);
  const pairing = pair.body;
  confirmRouteAttestation({ workspaceId: workspace.id, principal, challengeId: pairing.routeAttestation.challengeId,
    challengeDigest: pairing.routeAttestation.challengeDigest, stateDir });
  const bound = await requestJson(`${origin}/api/companion/v1/web-sink/bind-current`, { method: "POST",
    headers: { authorization: `Bearer ${pairing.credential}`, "content-type": "application/json" }, body: JSON.stringify({ routeCanonical: route }) });
  expect(bound.status).toBe(200);
  const now = new Date().toISOString(), taskId = randomUUID();
  projectRemoteResult(workspace, { taskId, targetId: randomUUID(), threadId: randomUUID(), turnId: randomUUID(),
    workspaceId: workspace.id, commandId: "light-result", clientId: "client", kind: "ANALYZE", goal: "fixture",
    createdAt: now, updatedAt: now, completedAt: now, status: "completed", finalResponse: { text: "真实 DTO 集成结果", truncated: false } });
  return { workspace, origin, pairing, loseBeginResponse: () => { disconnectBegin = true; } };
}

function browserAdapter(bridges: Awaited<ReturnType<typeof bridge>>[]) {
  const local: Record<string, any> = { [PROJECT_REGISTRY_KEY]: { schemaVersion: 1, legacyMigration: "none",
    projects: bridges.map(item => ({ workspaceId: item.workspace.id, bridgeOrigin: item.origin })) } };
  const session: Record<string, any> = {};
  for (const item of bridges) {
    local[projectStorageKey(item.workspace.id, "c2c_companion_transport_v1")] = { ...item.pairing, schemaVersion: 1, bridgeOrigin: item.origin };
    local[projectStorageKey(item.workspace.id, "c2c_companion_light_autonomy_v1")] = { enabled: true };
    session[projectStorageKey(item.workspace.id, "c2c_companion_light_page_v1")] = { tabId: 8, documentId: "document", url: route };
  }
  const area = (data: Record<string, any>) => ({ get: async (key: string) => ({ [key]: data[key] }),
    set: async (rows: Record<string, any>) => { Object.assign(data, rows); }, remove: async (key: string) => { delete data[key]; }, setAccessLevel: async () => {} });
  // Chrome storage/tabs 为模拟适配器；此回调只模拟 DOM 观察成功，不执行真实浏览器写入或点击。
  const sendMessage = vi.fn(async (_tab: number, value: any, target: any) => {
    expect(target).toEqual({ documentId: "document" });
    expect(value.expectedHref).toBe(route);
    expect(value.delivery.message).toContain(value.delivery.attemptId);
    return { ok: true, observed: true, eventId: value.delivery.eventId, attemptId: value.delivery.attemptId };
  });
  const chrome = { runtime: { id: "extension", getURL: (path: string) => `chrome-extension://extension/${path}` },
    storage: { local: area(local), session: area(session) }, permissions: { contains: async () => true }, tabs: { sendMessage } };
  const calls: { origin: string; path: string; body: any; credential: string }[] = [];
  const fetcher = async (url: string, options: any) => {
    const parsed = new URL(url);
    calls.push({ origin: parsed.origin, path: parsed.pathname.replace("/api/companion/v1", ""),
      body: options.body ? JSON.parse(options.body) : null, credential: options.headers.authorization });
    return requestHttp(url, { method: options.method, headers: options.headers, body: options.body });
  };
  return { chrome, calls, sendMessage, client: createBridgeClient(chrome, fetcher), restart: () => createBridgeClient(chrome, fetcher) };
}
const heartbeat = (workspaceId: string) => ({ type: "c2c.light.heartbeat", workspaceId, safety: { safe: true } });

it("真实 Bridge DTO 完成 reserve→once begin→模拟 DOM 回调→ACK observed", async () => {
  const b = await bridge(), browser = browserAdapter([b]);
  expect(await browser.client.handle(heartbeat(b.workspace.id), sender)).toMatchObject({ ok: true, observed: true });
  expect(browser.calls.map(call => call.path)).toEqual(["/state", "/reserve", "/begin-send", "/ack"]);
  expect(browser.calls[2]!.body.once).toBe(true);
  expect(browser.sendMessage).toHaveBeenCalledTimes(1);
  expect(browser.sendMessage.mock.calls[0]![1].type).toBe("c2c.light.deliver");
  const entry = readResultBus(b.workspace, stateDir)!.entries[0]!;
  expect(entry.deliveryStatus).toBe("observed");
  expect(browser.calls[3]!.body.attemptId).toBe(entry.attempt!.attemptId);
  expect(browser.calls[3]!.body.eventId).toBe(browser.calls[2]!.body.eventId);
});

it("真实 begin 已提交但响应断开，重建 client 仅 observe 原 attempt 并 ACK", async () => {
  const b = await bridge(), browser = browserAdapter([b]); b.loseBeginResponse();
  expect((await browser.client.handle(heartbeat(b.workspace.id), sender)).ok).toBe(false);
  expect(browser.sendMessage).not.toHaveBeenCalled();
  const before = readResultBus(b.workspace, stateDir)!.entries[0]!;
  expect(before.deliveryStatus).toBe("claimed");
  browser.calls.length = 0;
  expect(await browser.restart().handle(heartbeat(b.workspace.id), sender)).toMatchObject({ ok: true, observed: true });
  expect(browser.calls.map(call => call.path)).toEqual(["/state", "/ack"]);
  expect(browser.sendMessage).toHaveBeenCalledTimes(1);
  expect(browser.sendMessage.mock.calls[0]![1]).toMatchObject({ type: "c2c.light.observe", delivery: { attemptId: before.attempt!.attemptId } });
  expect(readResultBus(b.workspace, stateDir)!.entries[0]).toMatchObject({ deliveryStatus: "observed", attempt: before.attempt });
});

it("真实双 workspace 同一模拟 tab 分别 observed，凭据与 attempt 保持隔离", async () => {
  const a = await bridge(), b = await bridge(), browser = browserAdapter([a, b]);
  expect(await browser.client.handle(heartbeat(a.workspace.id), sender)).toMatchObject({ ok: true, observed: true });
  expect(await browser.client.handle(heartbeat(b.workspace.id), sender)).toMatchObject({ ok: true, observed: true });
  const entryA = readResultBus(a.workspace, stateDir)!.entries[0]!, entryB = readResultBus(b.workspace, stateDir)!.entries[0]!;
  expect(entryA.deliveryStatus).toBe("observed"); expect(entryB.deliveryStatus).toBe("observed");
  expect(entryA.attempt!.attemptId).not.toBe(entryB.attempt!.attemptId);
  for (const item of [a, b]) {
    const calls = browser.calls.filter(call => call.origin === item.origin);
    expect(calls.map(call => call.path)).toEqual(["/state", "/reserve", "/begin-send", "/ack"]);
    expect(calls.every(call => call.credential === `Bearer ${item.pairing.credential}`)).toBe(true);
    expect(calls[2]!.body.once).toBe(true);
  }
  expect(browser.sendMessage).toHaveBeenCalledTimes(2);
  expect(browser.sendMessage.mock.calls.map(call => call[1].delivery.signal.workspaceId)).toEqual([a.workspace.id, b.workspace.id]);
});
