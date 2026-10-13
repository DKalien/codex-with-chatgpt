import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuthStore } from "../src/auth/store.js";
import { startGatewayServer, type GatewayServer } from "../src/remote/server.js";
import { GatewayRegistry } from "../src/gateway/registry.js";
import { Workspace } from "../src/workspace/manager.js";
import { writeTunnelState } from "../src/tunnel/state.js";
import { startBridge } from "../src/bridge/server.js";
import * as bridgeRuntime from "../src/bridge/runtime.js";
import { readRuntimeState } from "../src/bridge/runtime.js";
import { createStartLock, encodeStartupLease, issueStartupLease } from "../src/core/startup-lease.js";
import { tryAcquireMaintenanceLock } from "../src/core/maintenance-lock.js";
import { createPairingIntent, exchangePairingIntent } from "../src/feedback/companion.js";
import { enableReceiver } from "../src/feedback/receiver.js";
import { ensureFeedbackState } from "../src/feedback/state-store.js";
import { resolveConversationPrincipal } from "../src/mcp/conversation-principal.js";
import { gatewaySupervisorLockFile, writeGatewaySupervisorRuntime } from "../src/gateway/supervisor.js";
import { isolateStateDir, makeTmpDir } from "./helpers.js";
import { cleanupStrict } from "./strict-teardown.js";
import { requestHttp } from "./http-json.js";

let prior: string | undefined, stateDir: string, roots: string[], a: Workspace, b: Workspace;
let gateway: GatewayServer | undefined;
let available = true;
const owner = { pid: process.pid, creationTime: "fixture:1", buildId: "a".repeat(64) };
beforeEach(() => {
  prior = process.env.C2C_STATE_DIR;
  stateDir = isolateStateDir();
  roots = [makeTmpDir("hosted-a"), makeTmpDir("hosted-b")];
  [a, b] = roots.map(root => new Workspace(root)) as [Workspace, Workspace];
  available = true;
  for (const [index, workspace] of [a, b].entries()) {
    new GatewayRegistry().register(workspace.root, "client");
    writeTunnelState({ workspaceId: workspace.id, preference: "named", provider: "cloudflare-named",
      tunnelName: `old-${index}`, hostname: `${index ? "b" : "a"}.example.test` });
  }
});
afterEach(async () => {
  await gateway?.close("close"); gateway = undefined;
  vi.restoreAllMocks();
  await cleanupStrict(stateDir, ...roots);
  if (prior === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = prior;
});
async function startGateway() {
  gateway = await startGatewayServer({ port: 0, publicUrl: "https://gateway.example.test", healthIdentity: owner,
    sharedWorkspaces: { tunnelAvailable: () => available } });
  return gateway;
}
function local(route: string, body?: unknown, headers: Record<string, string> = {}) {
  return requestHttp(`${gateway!.localBaseUrl()}${route}`, { method: body === undefined ? "GET" : "POST",
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function publicRequest(host: string, route: string, headers: Record<string, string> = {}, body?: unknown) {
  return local(route, body, { host, ...headers });
}
async function start(workspace: Workspace, tunnel = true) {
  const maintenance = tryAcquireMaintenanceLock(stateDir, "fixture-start");
  if (!maintenance.ok) throw new Error("fixture lock busy");
  const lock = createStartLock(stateDir, workspace.id);
  const lease = encodeStartupLease(issueStartupLease({ workspace, maintenance: maintenance.handle, startLockNonce: lock.nonce }));
  try {
    const response = await local(`/internal/gateway/workspaces/${workspace.id}/start`, { lease, port: 0, tunnel });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(JSON.stringify(result)).not.toContain("adminToken");
    const replay = await local(`/internal/gateway/workspaces/${workspace.id}/start`, { lease, port: 0 });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ code: "STARTUP_LEASE_REPLAY" });
    return result.runtime;
  } finally { expect(lock.release()).toBe(true); expect(maintenance.handle.release()).toBe(true); }
}
function companion(workspace: Workspace) {
  const principal = resolveConversationPrincipal({ authInfo: { token: "test", clientId: "client", scopes: ["codex.feedback"] } as never,
    _meta: { "openai/session": workspace.id } });
  ensureFeedbackState(workspace.id, 0, stateDir);
  enableReceiver({ workspaceId: workspace.id, principal, widgetId: "widget", stateDir });
  const intent = createPairingIntent({ workspaceId: workspace.id, principal, stateDir });
  return exchangePairingIntent({ workspaceId: workspace.id, intentId: intent.intentId, secret: intent.secret,
    routeCanonical: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111", stateDir }).credential;
}

it("共享 listener 保留原 OAuth issuer/token/Companion 凭据隔离，公开 Host 不暴露 admin 或 machine OAuth", async () => {
  const auth = new AuthStore(a.id);
  const token = auth.issueTokens({ clientId: "client", scopes: ["workspace.read"] }).accessToken;
  const credential = companion(a), credentialB = companion(b);
  const authFile = path.join(stateDir, "auth", `${a.id}.json`), original = fs.readFileSync(authFile);
  await startGateway();
  await start(a); await start(b);
  expect(fs.readFileSync(authFile)).toEqual(original);
  for (const [host, origin] of [["a.example.test", "https://a.example.test"], ["b.example.test", "https://b.example.test"]]) {
    const response = await publicRequest(host!, "/.well-known/oauth-authorization-server", { "x-forwarded-host": "gateway.example.test" });
    expect(response.status).toBe(200);
    expect((await response.json()).issuer).toBe(origin);
  }
  expect((await publicRequest("a.example.test", "/mcp", { authorization: `Bearer ${token}` },
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } })).status).not.toBe(401);
  expect((await publicRequest("b.example.test", "/mcp", { authorization: `Bearer ${token}` }, {})).status).toBe(401);
  expect((await publicRequest("a.example.test", "/api/companion/v1/state", { authorization: `Bearer ${credential}` })).status).toBe(200);
  expect((await publicRequest("b.example.test", "/api/companion/v1/state", { authorization: `Bearer ${credentialB}` })).status).toBe(200);
  expect((await publicRequest("b.example.test", "/api/companion/v1/state", { authorization: `Bearer ${credential}` })).status).toBe(401);
  const runtime = readRuntimeState(a.id)!;
  expect((await publicRequest("a.example.test", "/admin/info", { authorization: `Bearer ${runtime.adminToken}` })).status).toBe(404);
  expect((await publicRequest("a.example.test", "/admin/shutdown", { authorization: `Bearer ${runtime.adminToken}` }, {})).status).toBe(404);
  for (const route of ["/.well-known/oauth-authorization-server", "/oauth/token", "/mcp"]) {
    expect((await publicRequest("unknown.example.test", route, { "x-forwarded-host": "gateway.example.test" })).status).toBe(404);
  }
});

it("关闭 A 完整记录 exact lastClosed，B 与共享 tunnel 继续服务；未开启 workspace 不公开", async () => {
  await startGateway();
  const identityA = await start(a, false), identityB = await start(b);
  expect((await publicRequest("a.example.test", "/health")).status).toBe(503);
  const runtime = readRuntimeState(a.id)!;
  expect(runtime.hosting).toBe("gateway");
  expect((await requestHttp(`http://127.0.0.1:${runtime.port}/admin/tunnel/start`, { method: "POST",
    headers: { authorization: `Bearer ${runtime.adminToken}` } })).status).toBe(200);
  expect((await publicRequest("a.example.test", "/health")).status).toBe(200);
  expect((await requestHttp(`http://127.0.0.1:${runtime.port}/admin/shutdown`, { method: "POST",
    headers: { authorization: `Bearer ${runtime.adminToken}` } })).status).toBe(200);
  await vi.waitFor(async () => {
    const response = await local(`/internal/gateway/workspaces/${a.id}`);
    expect(await response.json()).toEqual({ hosted: false, current: null, lastClosed: identityA });
  });
  expect(readRuntimeState(a.id)).toBeNull();
  expect(readRuntimeState(b.id)?.port).toBe(identityB.port);
  expect((await publicRequest("b.example.test", "/health")).status).toBe(200);
  available = false;
  expect((await publicRequest("b.example.test", "/health")).status).toBe(503);
});

it("本机 API 拒绝 forwarded/未知 lease，fresh registry 重复或篡改 Host fail closed", async () => {
  await startGateway();
  for (const headers of [{ host: "gateway.example.test" }, { "x-forwarded-for": "127.0.0.1" }, { forwarded: "for=127.0.0.1" }, { "cf-ray": "test" }]) {
    expect((await local("/internal/gateway/workspaces", undefined, headers)).status).toBe(404);
  }
  expect((await local(`/internal/gateway/workspaces/000000000000/start`, { lease: "invalid" })).status).toBe(409);
  expect((await local(`/internal/gateway/workspaces/${a.id}/start`, { lease: "invalid" })).status).toBe(409);
  writeTunnelState({ workspaceId: b.id, preference: "named", provider: "cloudflare-named", tunnelName: "duplicate", hostname: "a.example.test" });
  expect((await publicRequest("gateway.example.test", "/.well-known/oauth-authorization-server")).status).toBe(503);
  expect((await local(`/internal/gateway/workspaces/${a.id}/start`, { lease: "invalid" })).status).toBe(409);
});

it("整体 SIGTERM 关闭保留 workspace runtime，shutdown 只接受 maintenance+exact owner/集合", async () => {
  await startGateway();
  const hosted = await start(a);
  writeGatewaySupervisorRuntime({ ...owner, executable: process.execPath, ports: [gateway!.port] }, stateDir);
  fs.writeFileSync(gatewaySupervisorLockFile(stateDir), JSON.stringify({ version: 1, scope: "machine", ...owner, executable: process.execPath, nonce: randomUUID() }));
  const maintenance = tryAcquireMaintenanceLock(stateDir, "fixture-shutdown");
  if (!maintenance.ok) throw new Error("fixture lock busy");
  try {
    const request = { maintenanceToken: maintenance.handle.token, expectedOwner: owner, workspaces: [hosted] };
    expect((await local("/internal/gateway/shutdown", { ...request, maintenanceToken: "00000000-0000-4000-8000-000000000000" })).status).toBe(409);
    expect((await local("/internal/gateway/shutdown", { ...request, workspaces: [] })).status).toBe(409);
    expect((await local("/internal/gateway/shutdown", { ...request, expectedOwner: { ...owner, buildId: "b".repeat(64) } })).status).toBe(409);
    expect((await local("/internal/gateway/shutdown", request)).status).toBe(200);
    await gateway!.closed;
    expect(readRuntimeState(a.id)?.startedAt).toBe(hosted.startedAt);
  } finally { expect(maintenance.handle.release()).toBe(true); }
});


it.each(["healthy", "unknown"] as const)("既有 %s observation 拒绝覆盖 runtime 或启动嵌入 Bridge", async state => {
  await startGateway();
  const runtime = { service: "codex-with-chatgpt", version: "fixture", workspaceId: a.id, workspaceRoot: a.root,
    pid: process.pid, port: 47111, adminToken: "existing-secret", publicUrl: "https://a.example.test", startedAt: new Date().toISOString() };
  bridgeRuntime.writeRuntimeState(runtime);
  vi.spyOn(bridgeRuntime, "findBridgeObservation").mockResolvedValue(state === "healthy" ? { state, runtime } : { state, runtime, reason: "probe_failed" });
  const maintenance = tryAcquireMaintenanceLock(stateDir, "fixture-existing");
  if (!maintenance.ok) throw new Error("fixture lock busy");
  const lock = createStartLock(stateDir, a.id);
  try {
    const lease = encodeStartupLease(issueStartupLease({ workspace: a, maintenance: maintenance.handle, startLockNonce: lock.nonce }));
    const response = await local(`/internal/gateway/workspaces/${a.id}/start`, { lease, port: 0, tunnel: true });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: state === "healthy" ? "GATEWAY_WORKSPACE_RUNNING" : "GATEWAY_WORKSPACE_UNKNOWN" });
    expect(readRuntimeState(a.id)).toEqual(runtime);
    expect(await (await local("/internal/gateway/workspaces")).json()).toEqual({ workspaces: [] });
  } finally { expect(lock.release()).toBe(true); expect(maintenance.handle.release()).toBe(true); }
});

it("嵌入 closed 等待共享 listener 的活动响应关闭，关闭后不能重新 attach", async () => {
  const tunnel = { name: "fixture", start: async () => "https://a.example.test", stop: async () => undefined,
    restart: async () => "https://a.example.test", status: () => ({ running: true, url: "https://a.example.test", provider: "fixture" }),
    getPublicUrl: () => "https://a.example.test", doctor: async () => ({ provider: "fixture", binaryFound: true, binaryPath: null,
      running: true, url: "https://a.example.test", problems: [] }) };
  const bridge = await startBridge({ workspaceRoot: a.root, port: 0, hosting: "gateway", publicOrigin: "https://a.example.test", persistRuntime: false, tunnelProvider: tunnel });
  let entered!: () => void;
  const active = new Promise<void>(resolve => { entered = resolve; });
  bridge.expressApp.get("/held", (_req, _res) => { entered(); });
  const shared = http.createServer(bridge.expressApp);
  await new Promise<void>(resolve => shared.listen(0, "127.0.0.1", resolve));
  const port = (shared.address() as { port: number }).port;
  const held = requestHttp(`http://127.0.0.1:${port}/held`).catch(() => undefined);
  try {
    await active;
    let finished = false;
    const closing = bridge.close().then(() => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(finished).toBe(false);
    await closing;
    await bridge.closed;
    await held;
    await expect(bridge.startTunnel()).rejects.toThrow("正在关闭");
    expect((await requestHttp(`http://127.0.0.1:${port}/health`)).status).toBe(503);
  } finally {
    await bridge.close();
    await new Promise<void>(resolve => shared.close(() => resolve()));
  }
});


it("unified Gateway exact loopback 保留 startup machine OAuth metadata 检查", async () => {
  await startGateway();
  expect((await (await local("/.well-known/oauth-authorization-server")).json()).issuer).toBe("https://gateway.example.test");
  const resource = await local("/.well-known/oauth-protected-resource/mcp");
  expect(resource.status).toBe(200);
  expect((await resource.json()).authorization_servers).toEqual(["https://gateway.example.test"]);
  expect((await local("/.well-known/oauth-authorization-server", undefined, { "x-forwarded-host": "gateway.example.test" })).status).toBe(404);
  expect((await local("/admin/info")).status).toBe(404);
});

it("embedded runtime CAS 失败保留新 owner，不发布 closed 证据", async () => {
  const bridge = await startBridge({ workspaceRoot: a.root, port: 0, hosting: "gateway", publicOrigin: "https://a.example.test" });
  const saved = readRuntimeState(a.id)!;
  const replacement = { ...saved, adminToken: "new-owner-token", startedAt: new Date(Date.parse(saved.startedAt) + 1000).toISOString() };
  bridgeRuntime.writeRuntimeState(replacement);
  let closed = false;
  void bridge.closed.then(() => { closed = true; });
  await expect(bridge.close()).rejects.toThrow("BRIDGE_RUNTIME_CLEAR_FAILED");
  expect(closed).toBe(false);
  expect(readRuntimeState(a.id)).toEqual(replacement);
});
