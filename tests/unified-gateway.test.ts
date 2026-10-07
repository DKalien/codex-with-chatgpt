import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "./sdk-http-fixture.js";
import { GatewayRegistry, gatewayRegistryFile } from "../src/gateway/registry.js";
import { startGatewayServer, type GatewayServer } from "../src/remote/server.js";
import { RemoteController } from "../src/remote/controller.js";
import { controllerOnline, readRemote, remoteFile, setRemoteEnabled } from "../src/remote/store.js";
import { readResultBus } from "../src/result-bus/store.js";
import { readFeedbackState, writeState } from "../src/feedback/state-store.js";
import { applyProjection } from "../src/feedback/projection-store.js";
import { FEEDBACK_CLAIM_STALE_MS } from "../src/feedback/schema.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import { AuthStore } from "../src/auth/store.js";
import { bindCurrentWebSink } from "../src/web-sink-control/service.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";
import { requestHttp } from "./http-json.js";

let oldState: string | undefined, stateDir: string, roots: string[], workspaces: Workspace[], registry: GatewayRegistry;
let server: GatewayServer | undefined;
const clients: Client[] = [];
const controllers: { service: RemoteController; running: Promise<void> }[] = [];
beforeEach(() => {
  oldState = process.env.C2C_STATE_DIR;
  stateDir = isolateStateDir();
  roots = [makeTmpDir("gateway-project-a"), makeTmpDir("gateway-project-b")];
  workspaces = roots.map(root => new Workspace(root));
  registry = new GatewayRegistry();
});
afterEach(async () => {
  for (const controller of controllers) controller.service.stop();
  await Promise.all(controllers.splice(0).map(controller => controller.running));
  for (const client of clients.splice(0)) await client.close();
  await server?.close(); server = undefined;
  roots.forEach(cleanup); cleanup(stateDir);
  if (oldState === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = oldState;
});

const scopes = ["workspace.read", "workspace.search", "git.read", "codex.read", "codex.control", "codex.feedback", "codex.websink.read", "execution.read"];
async function connect(clientId = "gateway-client", requestedScopes = scopes) {
  server ??= await startGatewayServer({ port: 0, publicUrl: "https://gateway.example.test" });
  const tokens = server.authStore.issueTokens({ clientId, scopes: requestedScopes });
  const client = new Client({ name: "unified-gateway-test", version: "1" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${tokens.accessToken}` } },
  }));
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown>, session: string | null = "chat-a") {
  const result = await client.callTool({ name, arguments: args, ...(session ? { _meta: { "openai/session": session } } : {}) });
  return { error: result.isError, data: JSON.parse((result.content as { text: string }[])[0]!.text) };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Gateway fixture timed out");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

// Existing Controller and stores run unchanged; only the official subprocess is a fixture.
class FixtureAppServer extends EventEmitter {
  constructor(private workspace: Workspace) { super(); }
  async start() {}
  async close() { this.emit("close"); }
  async request(method: string, params: any) {
    if (method === "config/read") return { config: {} };
    if (method === "thread/start") return { thread: { id: `thread-${this.workspace.id}`, cwd: this.workspace.root } };
    if (method === "thread/resume") return { thread: { id: params.threadId, cwd: this.workspace.root } };
    if (method === "turn/start") {
      const turnId = `turn-${this.workspace.id}`;
      setTimeout(() => this.emit("notification", { method: "turn/completed", params: {
        threadId: params.threadId, turn: { id: turnId, status: "completed", items: [
          { type: "agentMessage", phase: "final_answer", text: `result-${this.workspace.id}` },
        ] },
      } }), 15);
      return { turn: { id: turnId, status: "inProgress" } };
    }
    throw new Error(`Unexpected fixture method ${method}`);
  }
}

function projectSnapshot() {
  return Object.fromEntries((fs.readdirSync(stateDir, { recursive: true }) as string[])
    .filter(name => workspaces.some(workspace => name.includes(workspace.id)))
    .filter(name => fs.statSync(path.join(stateDir, name)).isFile())
    .map(name => [name, fs.readFileSync(path.join(stateDir, name), "utf8")]));
}

describe("machine Gateway over authenticated MCP", () => {
  it("one connection routes two Controllers, targets, tasks and results without shared business state", async () => {
    for (const workspace of workspaces) {
      registry.register(workspace.root, "gateway-client");
      setRemoteEnabled(workspace, true, { deliveryMode: "official" });
      const service = new RemoteController(workspace, new FixtureAppServer(workspace) as any);
      controllers.push({ service, running: service.run() });
    }
    await until(() => workspaces.every(workspace => {
      const state = readRemote(workspace.id); return !!state && controllerOnline(state);
    }));
    const client = await connect();
    expect((await call(client, "gateway_list_workspaces", {})).data.workspaces).toHaveLength(2);
    for (const workspace of workspaces) {
      const created = await call(client, "codex_create_thread", { workspaceId: workspace.id, requestId: "same-request" });
      expect(created.error).not.toBe(true);
    }
    await until(() => workspaces.every(workspace => readRemote(workspace.id)!.threads[0]?.status === "completed"));
    const targets = workspaces.map(workspace => readRemote(workspace.id)!.targets![0]!);
    const beforeReject = workspaces.map(workspace => readRemote(workspace.id)!).map(({ threads, tasks, audit }) => ({ threads, tasks, audit }));
    const foreign = await call(client, "codex_submit_task", {
      workspaceId: workspaces[1]!.id, targetId: targets[0]!.targetId,
      commandId: "foreign", kind: "ANALYZE", goal: "must fail",
    });
    expect(foreign.error).toBe(true);
    expect(readRemote(workspaces[1]!.id)!.tasks).toHaveLength(0);
    expect(workspaces.map(workspace => readRemote(workspace.id)!).map(({ threads, tasks, audit }) => ({ threads, tasks, audit }))).toEqual(beforeReject);
    const tasks = [];
    for (const [index, workspace] of workspaces.entries()) {
      const submitted = await call(client, "codex_submit_task", { workspaceId: workspace.id,
        targetId: targets[index]!.targetId, commandId: "same-command", kind: "ANALYZE", goal: "inspect" });
      expect(submitted.error).not.toBe(true); tasks.push(submitted.data);
    }
    await until(() => workspaces.every(workspace => readRemote(workspace.id)!.tasks[0]?.resultProjected));
    expect(tasks[0]!.taskId).not.toBe(tasks[1]!.taskId);
    for (const [index, workspace] of workspaces.entries()) {
      const status = await call(client, "codex_task_status", { workspaceId: workspace.id, taskId: tasks[index]!.taskId });
      expect(status.data.status).toBe("completed");
      const result = await call(client, "codex_task_result", { workspaceId: workspace.id, taskId: tasks[index]!.taskId });
      expect(JSON.stringify(result.data)).toContain(`result-${workspace.id}`);
      expect(readResultBus(workspace)!.entries).toHaveLength(1);
      expect((await call(client, "codex_task_result", { workspaceId: workspace.id, taskId: tasks[1-index]!.taskId })).error).toBe(true);
    }
  });

  it("OAuth alone grants no project; explicit grants and revocations take effect on the same token", async () => {
    const client = await connect();
    expect((await call(client, "gateway_list_workspaces", {})).data).toEqual({ clientId: "gateway-client", workspaces: [] });
    write(roots[0]!, "hello.txt", "project-a");
    write(roots[1]!, "hello.txt", "project-b");
    expect((await call(client, "read_file", { workspaceId: workspaces[0]!.id, path: "hello.txt" })).error).toBe(true);
    registry.register(roots[0]!, "gateway-client"); registry.register(roots[1]!, "different-client");
    expect((await call(client, "gateway_list_workspaces", {})).data.workspaces).toHaveLength(1);
    expect((await call(client, "read_file", { workspaceId: workspaces[0]!.id, path: "hello.txt" })).data.content).toBe("project-a");
    expect((await call(client, "read_file", { workspaceId: workspaces[1]!.id, path: "hello.txt" })).error).toBe(true);
    const before = projectSnapshot();
    registry.revoke(workspaces[0]!.id, "gateway-client");
    expect((await call(client, "read_file", { workspaceId: workspaces[0]!.id, path: "hello.txt" })).error).toBe(true);
    expect(projectSnapshot()).toEqual(before);
    const file = gatewayRegistryFile(); fs.writeFileSync(file, "corrupt registry");
    expect((await call(client, "gateway_list_workspaces", {})).error).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("corrupt registry");
  });

  it("feedback reads are side effect free; scope, project and conversation proof precede mutations", async () => {
    for (const workspace of workspaces) registry.register(workspace.root, "gateway-client");
    const client = await connect();
    const before = projectSnapshot();
    for (const workspace of workspaces) for (const tool of ["feedback_bootstrap_status", "feedback_status", "feedback_companion_status", "web_sink_list", "web_sink_status", "execution_summary"]) {
      expect((await call(client, tool, { workspaceId: workspace.id })).error).not.toBe(true);
    }
    expect(projectSnapshot()).toEqual(before);
    const missing = await call(client, "feedback_enable", { workspaceId: workspaces[0]!.id, widgetId: "widget-a" }, null);
    expect(missing.data.error).toBe("PROBE_CHAT_IDENTITY_UNAVAILABLE");
    const limited = await connect("gateway-client", ["workspace.read"]);
    expect((await call(limited, "feedback_enable", { workspaceId: workspaces[0]!.id, widgetId: "widget-a" })).data.error).toBe("INSUFFICIENT_SCOPE");
    expect(projectSnapshot()).toEqual(before);
    for (const [index, workspace] of workspaces.entries()) {
      expect((await call(client, "feedback_enable", { workspaceId: workspace.id, widgetId: `widget-${index}` }, `chat-${index}`)).error).not.toBe(true);
    }
    appendExecutionRecord(workspaces[1]!.id, { taskId: "pending-projection", iteration: 1,
      changedFiles: [], tests: null, exitStatus: "completed", timestamp: new Date().toISOString() });
    const b = JSON.stringify(readFeedbackState(workspaces[1]!.id));
    const beforeClaim = projectSnapshot();
    const binding = readFeedbackState(workspaces[1]!.id).binding!;
    expect((await call(client, "feedback_claim_next", { workspaceId: workspaces[1]!.id,
      bindingId: binding.bindingId, epoch: binding.epoch }, "chat-0")).data.error).toBe("FEEDBACK_PRINCIPAL_MISMATCH");
    expect(projectSnapshot()).toEqual(beforeClaim);
    expect((await call(client, "feedback_stop", { workspaceId: workspaces[0]!.id }, "chat-0")).error).not.toBe(true);
    expect(JSON.stringify(readFeedbackState(workspaces[1]!.id))).toBe(b);
    registry.revoke(workspaces[1]!.id);
    expect((await call(client, "feedback_enable", { workspaceId: workspaces[1]!.id, widgetId: "replay" }, "chat-1")).error).toBe(true);
    expect(JSON.stringify(readFeedbackState(workspaces[1]!.id))).toBe(b);
  });

  it("validates a durable active web sink binding through the SDK public projection", async () => {
    const workspace = workspaces[0]!;
    registry.register(workspace.root, "gateway-client");
    bindCurrentWebSink(workspace.id, {
      pluginId: "browser-companion",
      surfaceId: "chatgpt-web",
      workspaceId: workspace.id,
      canonicalUrl: "https://chatgpt.com/c/gateway-test",
    });
    const client = await connect();

    const result = await client.callTool({
      name: "web_sink_status",
      arguments: { workspaceId: workspace.id },
    });
    expect(result.isError).not.toBe(true);
    const output = result.structuredContent as {
      activeBinding: Record<string, unknown> | null;
    };
    expect(output.activeBinding).not.toBeNull();
    expect(Object.keys(output.activeBinding!).sort()).toEqual([
      "bindingId", "boundAt", "canonicalUrl", "epoch", "pluginId", "surfaceId", "workspaceId",
    ]);
    expect(output.activeBinding).toMatchObject({
      pluginId: "browser-companion",
      surfaceId: "chatgpt-web",
      workspaceId: workspace.id,
      canonicalUrl: "https://chatgpt.com/c/gateway-test",
      epoch: 1,
    });
    expect(JSON.stringify(output)).not.toMatch(/principalFingerprint|credential|challenge|plannerRouteId|version/);
  });

  it("stale claimed ACK rejects wrong session/epoch without writes and accepts exact late-positive ACK", async () => {
    for (const workspace of workspaces) registry.register(workspace.root, "gateway-client");
    const client = await connect();
    for (const [index, workspace] of workspaces.entries()) {
      expect((await call(client, "feedback_enable", { workspaceId: workspace.id, widgetId: `widget-${index}` }, `chat-${index}`)).error).not.toBe(true);
    }

    const workspace = workspaces[1]!;
    const binding = readFeedbackState(workspace.id).binding!;
    const now = new Date().toISOString();
    applyProjection({ workspaceId: workspace.id, stateDir, nextCursor: 0, newEvents: [{
      version: 1, eventId: "a".repeat(32), kind: "C2C_EXECUTED", workspaceId: workspace.id, source: "desktop",
      commandId: "gateway-late-ack", taskId: "desktop_gateway-late-ack", iteration: 1, result: "ok",
      changedFilesSummary: [], testsSummary: "", outputAvailable: false, occurredAt: now, createdAt: now, updatedAt: now,
      targetBindingId: null, targetEpoch: null, targetPrincipalFingerprint: null, status: "queued",
    }] });
    const claimed = await call(client, "feedback_claim_next", { workspaceId: workspace.id,
      bindingId: binding.bindingId, epoch: binding.epoch }, "chat-1");
    expect(claimed.error).not.toBe(true);
    const event = claimed.data.event as { eventId: string; attemptId: string };
    const staleState = readFeedbackState(workspace.id);
    writeState(workspace.id, stateDir, {
      ...staleState,
      events: staleState.events.map(item => item.eventId === event.eventId
        ? { ...item, claimedAt: new Date(Date.now() - FEEDBACK_CLAIM_STALE_MS - 1).toISOString() }
        : item),
    });

    const beforeReject = projectSnapshot();
    const ackInput = { workspaceId: workspace.id, bindingId: binding.bindingId, epoch: binding.epoch,
      eventId: event.eventId, attemptId: event.attemptId };
    const wrongSession = await call(client, "feedback_ack_observed", ackInput, "wrong-chat");
    expect(wrongSession.error).toBe(true);
    expect(wrongSession.data.error).toBe("FEEDBACK_PRINCIPAL_MISMATCH");
    expect(projectSnapshot()).toEqual(beforeReject);

    const staleEpoch = await call(client, "feedback_ack_observed", { ...ackInput, epoch: binding.epoch + 1 }, "chat-1");
    expect(staleEpoch.error).toBe(true);
    expect(staleEpoch.data.error).toBe("FEEDBACK_EPOCH_STALE");
    expect(projectSnapshot()).toEqual(beforeReject);

    const otherBefore = Object.fromEntries(Object.entries(beforeReject).filter(([file]) => file.includes(workspaces[0]!.id)));
    const lateAck = await call(client, "feedback_ack_observed", ackInput, "chat-1");
    expect(lateAck.error).not.toBe(true);
    expect(lateAck.data).toMatchObject({ eventId: event.eventId, status: "observed" });
    expect(readFeedbackState(workspace.id).events.find(item => item.eventId === event.eventId)?.status).toBe("observed");
    expect(Object.fromEntries(Object.entries(projectSnapshot()).filter(([file]) => file.includes(workspaces[0]!.id)))).toEqual(otherBefore);
  });

  it("allows anonymous MCP discovery but still requires bearer auth for tool calls", async () => {
    server = await startGatewayServer({ port: 0, publicUrl: "https://gateway.example.test" });
    const initialize = await requestHttp(`${server.localBaseUrl()}/mcp`, { method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", host: "untrusted.example.test" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "anonymous", version: "1" },
      } }) });
    expect(initialize.status).toBe(200);

    const response = await requestHttp(`${server.localBaseUrl()}/mcp`, { method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", host: "untrusted.example.test" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(response.status).toBe(200);
    const listed = await response.json() as { result?: { tools?: { name: string }[] } };
    expect(listed.result?.tools?.map(tool => tool.name)).toContain("gateway_list_workspaces");
    const workspaceInfo = listed.result?.tools?.find(tool => tool.name === "workspace_info") as
      { securitySchemes?: { type: string; scopes?: string[] }[] } | undefined;
    expect(workspaceInfo?.securitySchemes).toEqual([{ type: "oauth2", scopes: ["workspace.read"] }]);

    const call = await requestHttp(`${server.localBaseUrl()}/mcp`, { method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "gateway_list_workspaces", arguments: {},
      } }) });
    expect(call.status).toBe(401);
    expect(call.headers.get("www-authenticate")).toContain("https://gateway.example.test/");
    const bridge = new AuthStore(workspaces[0]!.id);
    const legacy = bridge.issueTokens({ clientId: "legacy", scopes });
    expect(server.authStore.verifyAccessToken(legacy.accessToken).ok).toBe(false);
    await expect(startGatewayServer({ port: 0, publicUrl: "https://other.example.test" })).rejects.toMatchObject({ code: "GATEWAY_BUSY" });
    await expect(startGatewayServer({ port: 0, publicUrl: "http://public.example.test" })).rejects.toMatchObject({ code: "INVALID_PUBLIC_URL" });
    expect(fs.existsSync(remoteFile(workspaces[0]!.id))).toBe(false);
  });

  it("does not release a replacement instance's owner lock", async () => {
    const first = await startGatewayServer({ port: 0, publicUrl: "https://gateway.example.test" });
    server = first;
    fs.unlinkSync(path.join(stateDir, "gateway", "server.lock"));
    const second = await startGatewayServer({ port: 0, publicUrl: "https://gateway.example.test" });
    server = second;
    await first.close();
    await expect(startGatewayServer({ port: 0, publicUrl: "https://gateway.example.test" })).rejects.toMatchObject({ code: "GATEWAY_BUSY" });
  });
});
