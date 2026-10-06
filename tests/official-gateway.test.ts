import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AuthStore } from "../src/auth/store.js";
import { createMcpServer } from "../src/mcp/server.js";
import { registerRemoteTools } from "../src/mcp/remote.js";
import { nullLogger } from "../src/logger/index.js";
import { runtimeFile } from "../src/bridge/runtime.js";
import { readRemote, setRemoteEnabled, updateRemote } from "../src/remote/store.js";
import { startOfficialRemoteServer, type OfficialRemoteServer } from "../src/remote/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";
import { requestHttp } from "./http-json.js";

let previousStateDir: string | undefined;
let stateDir: string;
let root: string;
let workspace: Workspace;
const servers: OfficialRemoteServer[] = [];
const clients: Client[] = [];
const outsideFiles: string[] = [];

beforeEach(() => {
  previousStateDir = process.env.C2C_STATE_DIR;
  stateDir = isolateStateDir();
  root = makeTmpDir("official-mcp-workspace");
  workspace = new Workspace(root);
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const server of servers.splice(0)) await server.close();
  for (const file of outsideFiles.splice(0)) cleanup(file);
  cleanup(root);
  cleanup(stateDir);
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
});

function official(): void {
  setRemoteEnabled(workspace, true, { deliveryMode: "official" });
  updateRemote(workspace.id, current => {
    current!.controller = { pid: process.pid, instanceId: "test-controller", heartbeatAt: Date.now(), appServer: "running" };
    current!.targets = [{
      targetId: randomUUID(), hostId: "local", workspaceId: workspace.id, workspaceRoot: workspace.root,
      threadId: "thread-1", createdAt: new Date().toISOString(), source: "selected", clientId: "local",
    }];
    return { state: current!, result: undefined };
  });
}

async function start(): Promise<OfficialRemoteServer> {
  const server = await startOfficialRemoteServer({ workspaceRoot: root, port: 0, publicUrl: "https://official.example.test" });
  servers.push(server);
  return server;
}

function responseText(result: { content?: unknown }): string {
  return ((result.content as { type: string; text: string }[] | undefined)?.[0]?.text) ?? "";
}

describe("standalone official MCP gateway", () => {
  it("authenticates with the existing bearer store and uses only the configured HTTPS origin", async () => {
    official();
    const server = await start();
    const response = await requestHttp(`${server.localBaseUrl()}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "untrusted.example.test" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("https://official.example.test/.well-known/oauth-protected-resource/mcp");

    const tokens = server.authStore.issueTokens({ clientId: "official-client", scopes: ["workspace.read", "workspace.search", "git.read", "codex.read"] });
    const client = new Client({ name: "official-gateway-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(
      new URL(`${server.localBaseUrl()}/mcp`), { requestInit: { headers: { authorization: `Bearer ${tokens.accessToken}` } } },
    ));
    const names = (await client.listTools()).tools.map(tool => tool.name);
    for (const name of ["workspace_info", "read_file", "search_workspace", "git_status", "codex_list_targets", "codex_task_result", "codex_cancel_task"])
      expect(names).toContain(name);
    for (const name of ["codex_desktop_send", "codex_desktop_status", "executor_send", "feedback_enable"])
      expect(names).not.toContain(name);
    await client.close();
  });

  it("keeps official OAuth registrations, refreshes, and revocations isolated from Bridge AuthStore", async () => {
    official();
    const bridgeAuth = new AuthStore(workspace.id);
    const bridgeClient = bridgeAuth.registerClient({ clientName: "bridge-client", redirectUris: ["http://127.0.0.1/callback"] });
    const bridgeInitial = bridgeAuth.issueTokens({ clientId: bridgeClient.clientId, scopes: ["workspace.read", "offline_access"] });
    const first = await start();
    expect(first.authStore.getClient(bridgeClient.clientId)).toBeUndefined();
    expect(first.authStore.verifyAccessToken(bridgeInitial.accessToken).ok).toBe(false);
    const rejectedBridgeToken = await requestHttp(`${first.localBaseUrl()}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bridgeInitial.accessToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(rejectedBridgeToken.status).toBe(401);

    const officialClient = first.authStore.registerClient({ clientName: "official-client", redirectUris: ["http://127.0.0.1/callback"] });
    const officialInitial = first.authStore.issueTokens({ clientId: officialClient.clientId, scopes: ["workspace.read", "offline_access"] });
    expect(bridgeAuth.getClient(officialClient.clientId)).toBeUndefined();
    expect(bridgeAuth.verifyAccessToken(officialInitial.accessToken).ok).toBe(false);

    const bridgeRefresh = bridgeAuth.refresh(bridgeInitial.refreshToken!, bridgeClient.clientId);
    const officialRefresh = first.authStore.refresh(officialInitial.refreshToken!, officialClient.clientId);
    expect(bridgeRefresh.ok).toBe(true);
    expect(officialRefresh.ok).toBe(true);
    if (!bridgeRefresh.ok || !officialRefresh.ok) throw new Error("expected each endpoint to refresh its own token");
    expect(bridgeAuth.verifyAccessToken(officialRefresh.tokens.accessToken).ok).toBe(false);
    expect(first.authStore.verifyAccessToken(bridgeRefresh.tokens.accessToken).ok).toBe(false);

    bridgeAuth.revokeAll();
    const bridgeAfterRevoke = bridgeAuth.issueTokens({ clientId: bridgeClient.clientId, scopes: ["workspace.read"] });
    const reloadedOfficial = await start();
    expect(reloadedOfficial.authStore.getClient(officialClient.clientId)).toBeDefined();
    expect(reloadedOfficial.authStore.getClient(bridgeClient.clientId)).toBeUndefined();
    expect(reloadedOfficial.authStore.verifyAccessToken(officialRefresh.tokens.accessToken).ok).toBe(true);
    expect(reloadedOfficial.authStore.verifyAccessToken(bridgeAfterRevoke.accessToken).ok).toBe(false);

    first.authStore.revokeAll();
    const reloadedBridge = new AuthStore(workspace.id);
    expect(reloadedBridge.getClient(bridgeClient.clientId)).toBeDefined();
    expect(reloadedBridge.getClient(officialClient.clientId)).toBeUndefined();
    expect(reloadedBridge.verifyAccessToken(bridgeAfterRevoke.accessToken).ok).toBe(true);
    const reloadedOfficialAfterRevoke = await start();
    expect(reloadedOfficialAfterRevoke.authStore.getClient(officialClient.clientId)).toBeDefined();
    expect(reloadedOfficialAfterRevoke.authStore.getClient(bridgeClient.clientId)).toBeUndefined();
    expect(reloadedOfficialAfterRevoke.authStore.verifyAccessToken(officialRefresh.tokens.accessToken).ok).toBe(false);
    expect(reloadedOfficialAfterRevoke.authStore.verifyAccessToken(bridgeAfterRevoke.accessToken).ok).toBe(false);
  });

  it("registers official tools while disabled but fails closed, and keeps scope checks", async () => {
    const registrations = new Map<string, (input: unknown, extra: unknown) => Promise<unknown>>();
    const registerOnly = { registerTool(name: string, _config: unknown, handler: (input: never, extra: never) => Promise<unknown>) {
      registrations.set(name, handler as (input: unknown, extra: unknown) => Promise<unknown>);
    } };
    registerRemoteTools(registerOnly as never, workspace, "official");
    expect(registrations.has("codex_list_targets")).toBe(true);
    const disabled = await registrations.get("codex_create_thread")!({ workspaceId: workspace.id, requestId: "disabled-request" }, {
      authInfo: { clientId: "authorized-client", scopes: ["codex.control"] },
    });
    expect(JSON.stringify(disabled)).toContain("REMOTE_CONTROL_DISABLED");

    official();
    const server = await start();
    const tokens = server.authStore.issueTokens({ clientId: "limited-client", scopes: ["workspace.read"] });
    const limited = new Client({ name: "limited-official-test", version: "1.0.0" });
    clients.push(limited);
    await limited.connect(new StreamableHTTPClientTransport(new URL(`${server.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${tokens.accessToken}` } },
    }));
    const result = await limited.callTool({ name: "codex_list_targets", arguments: { workspaceId: workspace.id, hostId: "local" } });
    expect(responseText(result)).toContain("INSUFFICIENT_SCOPE");
    const info = await limited.callTool({ name: "workspace_info", arguments: {} });
    const workflow = JSON.parse(responseText(info)).workflow;
    expect(workflow.overall).toBe("needs_authorization");
    expect(workflow.remote).toMatchObject({ enabled: true, controller: "online" });
    expect(JSON.parse(responseText(info)).desktopCompatibility).toEqual({ status: "unknown" });
    await limited.close();
  });

  it("reports only a running controller as ready and leaves reconciliation scoped to its target", async () => {
    official();
    updateRemote(workspace.id, current => {
      current!.controller!.appServer = "starting";
      current!.controller!.heartbeatAt = Date.now();
      return { state: current!, result: undefined };
    });
    const server = await start();
    const tokens = server.authStore.issueTokens({ clientId: "ready-reader", scopes: ["workspace.read", "codex.read", "codex.control"] });
    const client = new Client({ name: "official-readiness-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${tokens.accessToken}` } },
    }));
    const starting = await client.callTool({ name: "workspace_info", arguments: {} });
    expect(JSON.parse(responseText(starting))).toMatchObject({
      workflow: { overall: "needs_connection", remote: { controller: "unknown" } },
    });

    updateRemote(workspace.id, current => {
      current!.controller!.appServer = "running";
      current!.controller!.heartbeatAt = Date.now();
      const blockedTarget = { ...current!.targets![0]!, targetId: randomUUID(), threadId: "thread-unknown" };
      current!.targets!.push(blockedTarget);
      const now = new Date().toISOString();
      current!.tasks.push({ taskId: randomUUID(), targetId: blockedTarget.targetId, threadId: blockedTarget.threadId,
        workspaceId: workspace.id, commandId: "unknown-target-task", kind: "ANALYZE", goal: "unknown target",
        clientId: "other-client", status: "needs_reconciliation", createdAt: now, updatedAt: now });
      return { state: current!, result: undefined };
    });
    const healthy = await client.callTool({ name: "workspace_info", arguments: {} });
    expect(JSON.parse(responseText(healthy))).toMatchObject({
      workflow: { overall: "ready_remote", nextAction: "use_remote", remote: { controller: "online", needsReconciliation: true } },
    });
    await client.close();
  });

  it("blocks a legacy Remote handler if official mode is enabled after registration", async () => {
    setRemoteEnabled(workspace, true);
    updateRemote(workspace.id, current => {
      current!.controller = { pid: process.pid, instanceId: "test-controller", heartbeatAt: Date.now(), appServer: "running" };
      return { state: current!, result: undefined };
    });
    const registrations = new Map<string, (input: unknown, extra: unknown) => Promise<unknown>>();
    registerRemoteTools({ registerTool(name: string, _config: unknown, handler: (input: never, extra: never) => Promise<unknown>) {
      registrations.set(name, handler as (input: unknown, extra: unknown) => Promise<unknown>);
    } } as never, workspace, "legacy");
    setRemoteEnabled(workspace, true, { deliveryMode: "official" });
    const result = await registrations.get("codex_create_thread")!({ workspaceId: workspace.id, requestId: "late-legacy-request" }, {
      authInfo: { clientId: "authorized-client", scopes: ["codex.control"] },
    });
    expect(JSON.stringify(result)).toContain("OFFICIAL_MODE_ACTIVE");
  });

  it("keeps task status separate from finalResponse and cancels queued work by exact selector", async () => {
    official();
    const targetId = readRemote(workspace.id)!.targets![0]!.targetId;
    const now = new Date().toISOString();
    const taskId = randomUUID();
    updateRemote(workspace.id, current => {
      current!.tasks.push({
        taskId, targetId, threadId: "thread-1", workspaceId: workspace.id, commandId: "queued-command",
        kind: "ANALYZE", goal: "private goal", clientId: "task-client", status: "queued", createdAt: now, updatedAt: now,
        finalResponse: { text: "persisted safe final response", truncated: false },
      });
      return { state: current!, result: undefined };
    });
    const registrations = new Map<string, (input: unknown, extra: unknown) => Promise<unknown>>();
    registerRemoteTools({ registerTool(name: string, _config: unknown, handler: (input: never, extra: never) => Promise<unknown>) {
      registrations.set(name, handler as (input: unknown, extra: unknown) => Promise<unknown>);
    } } as never, workspace, "official");
    const extra = { authInfo: { clientId: "task-client", scopes: ["codex.read", "codex.control"] } };
    const status = await registrations.get("codex_task_status")!({ workspaceId: workspace.id, taskId }, extra);
    expect(JSON.stringify(status)).not.toContain("persisted safe final response");
    expect(JSON.stringify(status)).not.toContain("private goal");
    const result = await registrations.get("codex_task_result")!({ workspaceId: workspace.id, taskId }, extra);
    expect(JSON.stringify(result)).toContain("persisted safe final response");
    expect(JSON.stringify(result)).not.toContain("private goal");
    const cancelled = await registrations.get("codex_cancel_task")!({ workspaceId: workspace.id, taskId }, extra);
    expect(JSON.parse(responseText(cancelled as { content: unknown })).status).toBe("cancelled");
  });

  it("isolates official task status while sharing selected local thread metadata only", async () => {
    official();
    const target = readRemote(workspace.id)!.targets![0]!;
    const now = new Date().toISOString();
    const ownedTaskId = randomUUID();
    const hiddenTaskId = randomUUID();
    const privateThreadId = "private-thread";
    updateRemote(workspace.id, current => {
      current!.threads.push({ workspaceId: workspace.id, requestId: "selected-request", threadId: target.threadId,
        targetId: target.targetId, clientId: "local", source: "selected", status: "completed", createdAt: now, updatedAt: now });
      current!.threads.push({ workspaceId: workspace.id, requestId: "private-request", threadId: privateThreadId,
        clientId: "other-client", source: "created", status: "completed", createdAt: now, updatedAt: now });
      current!.tasks.push({ taskId: ownedTaskId, targetId: target.targetId, threadId: target.threadId, workspaceId: workspace.id,
        commandId: "owned-command", kind: "ANALYZE", goal: "owned", clientId: "reader", status: "completed",
        createdAt: now, updatedAt: now, outputId: 8 });
      current!.tasks.push({ taskId: hiddenTaskId, targetId: target.targetId, threadId: target.threadId, workspaceId: workspace.id,
        commandId: "private-command", kind: "ANALYZE", goal: "private", clientId: "other-client", status: "completed",
        createdAt: now, updatedAt: now, outputId: 99 });
      return { state: current!, result: undefined };
    });
    const registrations = new Map<string, (input: unknown, extra: unknown) => Promise<unknown>>();
    registerRemoteTools({ registerTool(name: string, _config: unknown, handler: (input: never, extra: never) => Promise<unknown>) {
      registrations.set(name, handler as (input: unknown, extra: unknown) => Promise<unknown>);
    } } as never, workspace, "official");
    const extra = { authInfo: { clientId: "reader", scopes: ["codex.read"] } };
    const taskStatus = await registrations.get("codex_task_status")!({ workspaceId: workspace.id, taskId: hiddenTaskId }, extra);
    expect(responseText(taskStatus as { content: unknown })).toContain("UNKNOWN_TASK");
    expect(JSON.stringify(taskStatus)).not.toContain(hiddenTaskId);
    expect(JSON.stringify(taskStatus)).not.toContain("99");
    const selected = await registrations.get("codex_thread_status")!({ workspaceId: workspace.id, threadId: target.threadId }, extra);
    expect(JSON.parse(responseText(selected as { content: unknown }))).toMatchObject({
      requestId: "selected-request", latestTask: { taskId: ownedTaskId, outputId: 8 },
    });
    expect(JSON.stringify(selected)).not.toContain(hiddenTaskId);
    expect(JSON.stringify(selected)).not.toContain('"outputId":99');
    const privateThread = await registrations.get("codex_thread_status")!({ workspaceId: workspace.id, requestId: "private-request" }, extra);
    expect(responseText(privateThread as { content: unknown })).toContain("UNKNOWN_THREAD");
    expect(JSON.stringify(privateThread)).not.toContain(privateThreadId);
  });

  it("reuses workspace sensitive-file and path-boundary checks and lists explicit registered targets", async () => {
    official();
    write(root, ".env", "API_KEY=must-not-leak\n");
    const outside = write(path.dirname(root), `${path.basename(root)}-outside.txt`, "outside-marker");
    outsideFiles.push(outside);
    const server = await start();
    const tokens = server.authStore.issueTokens({ clientId: "reader", scopes: ["workspace.read", "codex.read"] });
    const client = new Client({ name: "official-reader-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${tokens.accessToken}` } },
    }));

    const tools = (await client.listTools()).tools;
    expect(tools.find(tool => tool.name === "codex_list_targets")?.inputSchema).toMatchObject({
      properties: { hostId: { const: "local" }, workspaceId: expect.any(Object) },
    });
    updateRemote(workspace.id, current => {
      current!.controller!.appServer = "offline";
      current!.controller!.heartbeatAt = 0;
      return { state: current!, result: undefined };
    });
    const listed = await client.callTool({ name: "codex_list_targets", arguments: { workspaceId: workspace.id, hostId: "local" } });
    expect(responseText(listed)).toContain("thread-1");
    expect(responseText(listed)).toContain('"controller":"offline"');
    expect(responseText(listed)).not.toContain("clientId");
    const secret = await client.callTool({ name: "read_file", arguments: { path: ".env" } });
    expect(responseText(secret)).not.toContain("must-not-leak");
    expect(secret.isError).toBe(true);
    const traversal = await client.callTool({ name: "read_file", arguments: { path: `../${path.basename(outside)}` } });
    expect(responseText(traversal)).not.toContain("outside-marker");
    expect(traversal.isError).toBe(true);
    await client.close();
  });

  it("keeps feedback capabilities separate from remote and direct send tools", async () => {
    const feedback = createMcpServer({ workspace, logger: nullLogger, profile: "feedback" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await feedback.connect(serverTransport);
    const client = new Client({ name: "feedback-profile-test", version: "1.0.0" });
    await client.connect(clientTransport);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    for (const name of ["feedback_bootstrap_status", "feedback_enable", "feedback_claim_next", "feedback_companion_route_confirm", "web_sink_status", "execution_output"])
      expect(names).toContain(name);
    for (const name of ["codex_create_thread", "codex_submit_task", "codex_desktop_send", "executor_send", "workspace_info"])
      expect(names).not.toContain(name);
    clients.push(client);
    await client.close();
    await feedback.close();
  });

  it("closes its loopback listener without creating Bridge runtime state", async () => {
    official();
    const server = await start();
    expect(server.pairing.hasActiveSession()).toBe(true);
    expect(readRemote(workspace.id)?.deliveryMode).toBe("official");
    expect(fs.existsSync(runtimeFile(workspace.id))).toBe(false);
    const url = `${server.localBaseUrl()}/mcp`;
    await server.close();
    expect(server.pairing.hasActiveSession()).toBe(false);
    await expect(requestHttp(url, { method: "GET" })).rejects.toThrow();
    expect(server.pairing.verify(server.pairingCode)).toMatchObject({ ok: false });
  });

  it("rejects non-HTTPS and path-based public URLs before listening", async () => {
    official();
    await expect(startOfficialRemoteServer({ workspaceRoot: root, port: 0, publicUrl: "http://public.example.test" })).rejects.toMatchObject({ code: "INVALID_PUBLIC_URL" });
    await expect(startOfficialRemoteServer({ workspaceRoot: root, port: 0, publicUrl: "https://public.example.test/mcp" })).rejects.toMatchObject({ code: "INVALID_PUBLIC_URL" });
  });
});
