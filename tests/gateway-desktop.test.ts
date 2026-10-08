import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "./sdk-http-fixture.js";
import { GatewayRegistry, gatewayRegistryFile } from "../src/gateway/registry.js";
import { startGatewayServer, type GatewayServer } from "../src/remote/server.js";
import { DESKTOP_CONTROL_SCOPE, DESKTOP_READ_SCOPE } from "../src/auth/store.js";
import { desktopIpc } from "../src/desktop/ipc.js";
import { bindDesktop, disableDesktop, enableDesktop } from "../src/desktop/service.js";
import { DesktopError, desktopFile, readDesktop } from "../src/desktop/store.js";
import { readRemote, setRemoteEnabled, updateRemote } from "../src/remote/store.js";
import { listCommands } from "../src/routing/store.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const scopes = [DESKTOP_READ_SCOPE, DESKTOP_CONTROL_SCOPE, "codex.read", "codex.control"];
const runtimeFence = { desktopPid: 1001, desktopExe: "C:\\Desktop.exe", desktopCreation: "1001",
  appServerPid: 1002, appServerExe: "C:\\codex.exe", appServerCreation: "1002" };
let stateDir: string, oldState: string | undefined, roots: string[], workspaces: Workspace[], bindings: string[];
let registry: GatewayRegistry, server: GatewayServer;
let send: ReturnType<typeof vi.fn>, close: ReturnType<typeof vi.fn>;
const clients: Client[] = [];
const threads = ["01a00000-0000-7000-8000-000000000001", "01a00000-0000-7000-8000-000000000002"];

beforeEach(async () => {
  oldState = process.env.C2C_STATE_DIR;
  stateDir = isolateStateDir();
  roots = [makeTmpDir("desktop-gateway-a"), makeTmpDir("desktop-gateway-b")];
  workspaces = roots.map(root => new Workspace(root));
  registry = new GatewayRegistry();
  send = vi.fn(async () => ({ threadId: threads[0], turnId: randomUUID() }));
  close = vi.fn();
  const inspect = async (target: object) => ({ ...target, title: "本机测试绑定", runtimeFence });
  vi.spyOn(desktopIpc, "inspect").mockImplementation(inspect as never);
  vi.spyOn(desktopIpc, "discoverForBinding").mockImplementation(inspect as never);
  vi.spyOn(desktopIpc, "prepare").mockImplementation(async () => ({ send, close }));
  vi.spyOn(desktopIpc, "inspectActiveExecution").mockRejectedValue(new DesktopError("DESKTOP_BUSY", "busy"));
  bindings = [];
  for (const [index, workspace] of workspaces.entries()) {
    registry.register(workspace.root, index === 0 ? "client-a" : "client-b");
    const binding = await bindDesktop(workspace, { threadId: threads[index]!, hostId: "local", projectId: `project-${index}` });
    enableDesktop(workspace, binding.bindingId);
    bindings.push(binding.bindingId);
  }
  server = await startGatewayServer({ port: 0, publicUrl: "https://gateway.example.test" });
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await server?.close();
  vi.restoreAllMocks();
  roots.forEach(cleanup); cleanup(stateDir);
  if (oldState === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = oldState;
});
async function connect(clientId = "client-a", requestedScopes = scopes) {
  const token = server.authStore.issueTokens({ clientId, scopes: requestedScopes }).accessToken;
  const client = new Client({ name: "gateway-desktop-test", version: "1" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return { client, token };
}
async function call(client: Client, name: string, args: Record<string, unknown>, session: string | null = "chat-a") {
  const result = await client.callTool({ name, arguments: args, ...(session ? { _meta: { "openai/session": session } } : {}) });
  const text = (result.content as { text: string }[])[0]!.text;
  let data; try { data = JSON.parse(text); } catch { data = { message: text }; }
  return { error: result.isError, data };
}
function input(overrides = {}) {
  return { workspaceId: workspaces[0]!.id, bindingId: bindings[0], commandId: "desktop-command",
    intent: "development_plan", userConfirmed: true, message: "只执行测试计划", ...overrides };
}
const invokeSend = (client: Client, overrides = {}, session: string | null = "chat-a") => call(client, "codex_desktop_send", input(overrides), session);

describe("Gateway Desktop 独立入口", () => {
  it("SDK 披露 Desktop scopes；按本机绑定发送，Remote 未启用也可用，且不修改 B", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    for (const [name, scope] of [["codex_desktop_status", DESKTOP_READ_SCOPE], ["codex_desktop_send", DESKTOP_CONTROL_SCOPE]]) {
      const tool = tools.find(tool => tool.name === name)!;
      expect(tool._meta?.securitySchemes).toEqual([{ type: "oauth2", scopes: [scope] }]);
      expect(tool.inputSchema.required).toContain("workspaceId");
    }
    expect(tools.find(tool => tool.name === "codex_submit_task")!.description).toContain("后台 Remote");
    const beforeB = fs.readFileSync(desktopFile(workspaces[1]!.id), "utf8");
    expect((await call(client, "codex_desktop_status", { workspaceId: workspaces[0]!.id })).data.binding.threadId).toBe(threads[0]);
    expect((await call(client, "codex_desktop_status", { workspaceId: workspaces[1]!.id })).data.error).toBe("GATEWAY_CLIENT_NOT_AUTHORIZED");
    expect((await invokeSend(client, { workspaceId: workspaces[1]!.id })).data.error).toBe("GATEWAY_CLIENT_NOT_AUTHORIZED");
    const accepted = await invokeSend(client);
    expect(accepted.data.deliveryStatus).toBe("accepted");
    expect(accepted.data.threadId).toBe(threads[0]);
    expect((await invokeSend(client)).data).toEqual(accepted.data);
    expect((await invokeSend(client, {}, "other-chat")).data.error).toBe("COMMAND_CONFLICT");
    expect(send).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(desktopFile(workspaces[1]!.id), "utf8")).toBe(beforeB);
    expect(readRemote(workspaces[0]!.id)).toBeNull();
  });

  it("read scope 仅允许 status；缺 principal、确认、binding 或 enable 时均不发送", async () => {
    const { client: readOnly } = await connect("client-a", [DESKTOP_READ_SCOPE]);
    expect((await call(readOnly, "codex_desktop_status", { workspaceId: workspaces[0]!.id })).error).not.toBe(true);
    expect((await invokeSend(readOnly)).data.error).toBe("INSUFFICIENT_SCOPE");
    const { client } = await connect();
    expect((await invokeSend(client, {}, null)).data.error).toBe("ROUTING_PLANNER_IDENTITY_UNAVAILABLE");
    expect((await invokeSend(client, { userConfirmed: false })).error).toBe(true);
    expect((await invokeSend(client, { bindingId: randomUUID() })).data.error).toBe("DESKTOP_BINDING_MISMATCH");
    disableDesktop(workspaces[0]!);
    expect((await invokeSend(client)).data.error).toBe("DESKTOP_DISABLED");
    expect(send).not.toHaveBeenCalled();
    expect(listCommands(workspaces[0]!)).toEqual([]);
  });

  it.each(["revoked", "expired", "scope", "registry", "root", "disabled", "binding"])("提交前 %s 变化时零 IPC send", async change => {
    const { client, token } = await connect();
    vi.mocked(desktopIpc.prepare).mockImplementationOnce(async () => {
      const verdict = server.authStore.verifyAccessToken(token);
      if (!verdict.ok) throw new Error("fixture token missing");
      if (change === "revoked") server.authStore.revokeToken(token);
      if (change === "expired") verdict.record.expiresAt = Date.now() - 1000;
      if (change === "scope") verdict.record.scopes = [DESKTOP_READ_SCOPE];
      if (change === "registry") registry.revoke(workspaces[0]!.id, "client-a");
      if (change === "root") {
        const file = gatewayRegistryFile();
        const state = JSON.parse(fs.readFileSync(file, "utf8"));
        state.workspaces[0].root = workspaces[1]!.root;
        fs.writeFileSync(file, JSON.stringify(state));
      }
      if (change === "disabled") disableDesktop(workspaces[0]!);
      if (change === "binding") {
        const binding = await bindDesktop(workspaces[0]!, { threadId: threads[0]!, hostId: "local", projectId: "project-0" });
        enableDesktop(workspaces[0]!, binding.bindingId);
      }
      return { send, close };
    });
    const result = await invokeSend(client);
    expect(result.error).toBe(true);
    expect(result.data.error).toBe(({ revoked: "UNAUTHORIZED", expired: "UNAUTHORIZED", scope: "UNAUTHORIZED",
      registry: "GATEWAY_UNKNOWN_WORKSPACE", root: "GATEWAY_WORKSPACE_ID_MISMATCH", disabled: "DESKTOP_DISABLED", binding: "DESKTOP_BINDING_MISMATCH" })[change]);
    expect(send).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(readDesktop(workspaces[0]!.id)?.deliveries).toEqual([]);
  });

  it("token 入口撤权后 status/send 均被 HTTP 拒绝，状态不变", async () => {
    const { client, token } = await connect();
    server.authStore.revokeToken(token);
    await expect(call(client, "codex_desktop_status", { workspaceId: workspaces[0]!.id })).rejects.toThrow();
    await expect(invokeSend(client)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(listCommands(workspaces[0]!)).toEqual([]);
  });

  it("busy 不排队或发送；outcome_unknown 不重发", async () => {
    const { client } = await connect();
    vi.mocked(desktopIpc.prepare).mockRejectedValueOnce(new DesktopError("DESKTOP_BUSY", "busy"));
    expect((await invokeSend(client, { commandId: "busy-command" })).data.error).toBe("DESKTOP_BUSY");
    expect(send).not.toHaveBeenCalled();
    expect(listCommands(workspaces[0]!).every(command => !command.mailbox)).toBe(true);
    send.mockRejectedValueOnce(new Error("unknown"));
    expect((await invokeSend(client)).data.deliveryStatus).toBe("outcome_unknown");
    expect((await invokeSend(client)).data.deliveryStatus).toBe("outcome_unknown");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("codex_submit_task 继续仅创建 Remote 任务，不使用 Desktop 绑定", async () => {
    const { client } = await connect();
    const workspace = workspaces[0]!;
    setRemoteEnabled(workspace, true, { deliveryMode: "official" });
    const targetId = randomUUID();
    updateRemote(workspace.id, state => {
      state!.controller = { pid: process.pid, instanceId: "fixture-controller", heartbeatAt: Date.now(), appServer: "running" };
      state!.targets = [{ targetId, workspaceId: workspace.id, workspaceRoot: workspace.root, hostId: "local",
        threadId: "remote-background-thread", clientId: "client-a", source: "created", createdAt: new Date().toISOString() }];
      return { state: state!, result: undefined };
    });
    expect((await call(client, "codex_submit_task", { workspaceId: workspace.id, targetId, commandId: "remote-command",
      kind: "ANALYZE", goal: "测试后台路径" })).error).not.toBe(true);
    expect(readRemote(workspace.id)?.tasks[0]?.threadId).toBe("remote-background-thread");
    expect(send).not.toHaveBeenCalled();
    expect(readDesktop(workspace.id)?.deliveries).toEqual([]);
  });
});
