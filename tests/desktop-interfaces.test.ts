import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Command } from "commander";
import fs from "node:fs";
import { desktopFile } from "../src/desktop/store.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { bindDesktop, enableDesktop } from "../src/desktop/service.js";
import { desktopIpc } from "../src/desktop/ipc.js";
import { DESKTOP_CONTROL_SCOPE, DESKTOP_READ_SCOPE, filterScopes, getSupportedScopes, SUPPORTED_SCOPES } from "../src/auth/store.js";
import { registerDesktopCommands } from "../src/cli/desktop.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const THREAD_ID = "01a00000-0000-7000-8000-000000000001";

let root: string;
let stateDir: string;
let bridge: Bridge;
let previousStateDir: string | undefined;

function textOf(result: { content?: unknown }): string {
  return (result.content as { type: string; text: string }[] | undefined)?.[0]?.text ?? "";
}

function jsonOf<T>(result: { content?: unknown }): T {
  return JSON.parse(textOf(result)) as T;
}

async function clientFor(scopes: string[], clientId = "desktop-interface-test"): Promise<Client> {
  const token = bridge.authStore.issueTokens({ clientId, scopes });
  const client = new Client({ name: clientId, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token.accessToken}` } },
  }));
  return client;
}

beforeEach(async () => {
  previousStateDir = process.env.C2C_STATE_DIR;
  stateDir = isolateStateDir();
  root = makeTmpDir("desktop-interface-workspace");
  bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false });
});

afterEach(async () => {
  await bridge.close();
  vi.restoreAllMocks();
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
  cleanup(root);
  cleanup(stateDir);
});

describe("Desktop MCP 与本地接口", () => {
  it("已绑定状态损坏时返回明确错误，不隐藏故障或重新初始化", async () => {
    vi.spyOn(desktopIpc, "inspect").mockResolvedValue({ title: "测试 Desktop 会话" } as never);
    await bindDesktop(bridge.workspace, { threadId: THREAD_ID, hostId: "local", projectId: "project_test" });
    fs.writeFileSync(desktopFile(bridge.workspace.id), "broken state");
    const client = await clientFor([DESKTOP_READ_SCOPE]);
    try {
      const result = await client.callTool({ name: "codex_desktop_status", arguments: { workspaceId: bridge.workspace.id } });
      expect(result.isError).toBe(true);
      expect(jsonOf<{ error: string }>(result).error).toBe("DESKTOP_STATE_CORRUPT");
      expect(fs.readFileSync(desktopFile(bridge.workspace.id), "utf8")).toBe("broken state");
    } finally { await client.close(); }
  });
  it("新增 scope 不改变原五个默认 scope，旧 token 刷新不升级", () => {
    expect(filterScopes(undefined)).toEqual([...SUPPORTED_SCOPES]);
    expect(filterScopes(`${DESKTOP_CONTROL_SCOPE} ${DESKTOP_READ_SCOPE}`)).toEqual([
      DESKTOP_CONTROL_SCOPE,
      DESKTOP_READ_SCOPE,
    ]);
    expect(getSupportedScopes()).toEqual(expect.arrayContaining([DESKTOP_CONTROL_SCOPE, DESKTOP_READ_SCOPE]));
    const token = bridge.authStore.issueTokens({ clientId: "old-client", scopes: [...SUPPORTED_SCOPES] });
    const refreshed = bridge.authStore.refresh(token.refreshToken!, "old-client");
    expect(refreshed.ok).toBe(true);
    if (refreshed.ok) expect(refreshed.tokens.scopes).toEqual([...SUPPORTED_SCOPES]);
  });

  it("Desktop Control OAuth 授权页明确显示可修改权限与本机撤权边界", async () => {
    const registration = await fetch(`${bridge.localBaseUrl()}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Desktop UI test", redirect_uris: ["http://127.0.0.1:19999/callback"] }),
    });
    const clientId = (await registration.json() as { client_id: string }).client_id;
    const pairing = bridge.pairing.create();
    const url = new URL(`${bridge.localBaseUrl()}/oauth/authorize`);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "http://127.0.0.1:19999/callback");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", "test-challenge");
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("scope", `${DESKTOP_CONTROL_SCOPE} ${DESKTOP_READ_SCOPE}`);
    const page = await fetch(url);
    const html = await page.text();
    expect(pairing.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(html).toContain("Desktop 任务投递，可修改文件或执行命令");
    expect(html).toContain("可随时在本机撤权");
    expect(html).toContain("网页不能自行启用、绑定或调整权限");
    expect(html).not.toContain("(read-only)");
  });

  it("未绑定时注册 Desktop 工具并安全返回状态，绑定后 disabled 仍只开放状态查询", async () => {
    const unbound = await clientFor([DESKTOP_READ_SCOPE]);
    const unboundTools = (await unbound.listTools()).tools;
    expect(unboundTools).toHaveLength(21);
    const unboundSend = unboundTools.find(tool => tool.name === "codex_desktop_send")!;
    expect(unboundSend.inputSchema.required).toEqual(expect.arrayContaining(["intent", "userConfirmed", "message", "bindingId", "commandId", "workspaceId"]));
    expect(unboundSend.inputSchema.properties?.intent).toMatchObject({ enum: ["development_plan", "revision"] });
    expect(unboundSend.inputSchema.properties?.userConfirmed).toMatchObject({ const: true });
    const unboundStatus = jsonOf<{ enabled: boolean; binding: null; availability: { available: boolean } }>(await unbound.callTool({
      name: "codex_desktop_status",
      arguments: { workspaceId: bridge.workspace.id },
    }));
    expect(unboundStatus).toMatchObject({ enabled: false, binding: null, availability: { available: false } });
    await unbound.close();

    const prepare = vi.spyOn(desktopIpc, "prepare");
    const control = await clientFor([DESKTOP_CONTROL_SCOPE]);
    const rejected = await control.callTool({
      name: "codex_desktop_send",
      arguments: {
        intent: "development_plan", userConfirmed: true, workspaceId: bridge.workspace.id,
        bindingId: "00000000-0000-0000-0000-000000000001", commandId: "unbound_command", message: "未绑定不应发送",
      },
    });
    expect(rejected.isError).toBe(true);
    expect(jsonOf<{ error: string }>(rejected).error).toBe("DESKTOP_DISABLED");
    expect(prepare).not.toHaveBeenCalled();
    await control.close();

    vi.spyOn(desktopIpc, "inspect").mockResolvedValue({ title: "测试 Desktop 会话" } as never);
    const binding = await bindDesktop(bridge.workspace, { threadId: THREAD_ID, hostId: "local", projectId: "project_test" });
    const client = await clientFor([DESKTOP_READ_SCOPE]);
    const tools = (await client.listTools()).tools;
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(["codex_desktop_send", "codex_desktop_status"]));
    expect(tools.find(tool => tool.name === "codex_desktop_status")?.annotations).toMatchObject({ readOnlyHint: true });
    const sendTool = tools.find(tool => tool.name === "codex_desktop_send")!;
    expect(sendTool.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: true });
    expect(sendTool.inputSchema.required).toEqual(expect.arrayContaining(["intent", "userConfirmed", "message", "bindingId", "commandId", "workspaceId"]));
    expect(sendTool.inputSchema.properties?.intent).toMatchObject({ enum: ["development_plan", "revision"] });
    expect(sendTool.inputSchema.properties?.userConfirmed).toMatchObject({ const: true });
    expect(sendTool.inputSchema.additionalProperties).toBe(false);
    expect(tools.find(tool => tool.name === "codex_desktop_send")?._meta).toMatchObject({
      securitySchemes: [{ type: "oauth2", scopes: [DESKTOP_CONTROL_SCOPE] }],
    });
    expect(tools.find(tool => tool.name === "codex_desktop_status")?._meta).toMatchObject({
      securitySchemes: [{ type: "oauth2", scopes: [DESKTOP_READ_SCOPE] }],
    });
    const status = jsonOf<{ enabled: boolean; binding: { bindingId: string } | null }>(await client.callTool({
      name: "codex_desktop_status",
      arguments: { workspaceId: bridge.workspace.id },
    }));
    expect(status.enabled).toBe(false);
    expect(status.binding?.bindingId).toBe(binding.bindingId);
    await client.close();
  });

  it.each(["development_plan", "revision"])("Bridge %s 保留完整中文正文，并只返回真实 accepted 回执", async intent => {
    vi.spyOn(desktopIpc, "inspect").mockResolvedValue({ title: "测试 Desktop 会话" } as never);
    const prefix = "中文计划\n\n";
    const message = prefix + "中".repeat(21000) + "x";
    const send = vi.fn(async (sent: string) => {
      expect(JSON.parse(sent)).toEqual({ type: "C2C_DESKTOP_TASK", version: 1, workspaceId: bridge.workspace.id,
        commandId: "accepted_command", intent, message });
      return { threadId: THREAD_ID, turnId: "01a00000-0000-7000-8000-000000000002" };
    });
    vi.spyOn(desktopIpc, "prepare").mockResolvedValue({ send, close: vi.fn() } as never);
    const binding = await bindDesktop(bridge.workspace, { threadId: THREAD_ID, hostId: "local", projectId: "project_test" });
    enableDesktop(bridge.workspace, binding.bindingId);
    const client = await clientFor([DESKTOP_CONTROL_SCOPE]);
    const result = jsonOf<{ deliveryStatus: string; threadId: string; turnId?: string }>(await client.callTool({
      name: "codex_desktop_send",
      arguments: { intent, userConfirmed: true, workspaceId: bridge.workspace.id, bindingId: binding.bindingId, commandId: "accepted_command", message },
    }));
    expect(result).toMatchObject({ deliveryStatus: "accepted", threadId: THREAD_ID, turnId: "01a00000-0000-7000-8000-000000000002" });
    expect(send).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it("确认/意图缺失或错误及额外字段在 IPC 前被 schema 拒绝", async () => {
    vi.spyOn(desktopIpc, "inspect").mockResolvedValue({ title: "测试会话" } as never);
    const binding = await bindDesktop(bridge.workspace, { threadId: THREAD_ID, hostId: "local", projectId: "project_test" });
    enableDesktop(bridge.workspace, binding.bindingId);
    const prepare = vi.spyOn(desktopIpc, "prepare");
    const client = await clientFor([DESKTOP_CONTROL_SCOPE]);
    const base = { workspaceId: bridge.workspace.id, bindingId: binding.bindingId, commandId: "invalid", message: "中文\n```ts\nconst x = 1;\n```", intent: "development_plan", userConfirmed: true };
    for (const delta of [{ userConfirmed: false }, { userConfirmed: undefined }, { intent: undefined }, { intent: "shell" },
      ...["shell", "path", "rpc", "model", "provider", "cwd", "effort", "sandbox", "approval", "permissions"].map(field => ({ [field]: "extra" }))]) {
      const result = await client.callTool({ name: "codex_desktop_send", arguments: { ...base, ...delta } });
      expect(result.isError).toBe(true);
    }
    expect(prepare).not.toHaveBeenCalled();
    await client.close();
  });

  it("提交点重新验证已撤销的 OAuth，撤销期间不发送且不写投递记录", async () => {
    vi.spyOn(desktopIpc, "inspect").mockResolvedValue({ title: "测试 Desktop 会话" } as never);
    const binding = await bindDesktop(bridge.workspace, { threadId: THREAD_ID, hostId: "local", projectId: "project_test" });
    enableDesktop(bridge.workspace, binding.bindingId);
    const send = vi.fn(async () => ({ threadId: THREAD_ID, turnId: "01a00000-0000-7000-8000-000000000002" }));
    vi.spyOn(desktopIpc, "prepare").mockImplementation(async () => {
      bridge.authStore.revokeAll();
      return { send, close: vi.fn() } as never;
    });
    const tokenClient = await clientFor([DESKTOP_CONTROL_SCOPE], "revoked-client");
    const result = await tokenClient.callTool({
      name: "codex_desktop_send",
      arguments: { intent: "development_plan", userConfirmed: true, workspaceId: bridge.workspace.id, bindingId: binding.bindingId, commandId: "revoked_command", message: "完整计划" },
    });
    expect(result.isError).toBe(true);
    expect(jsonOf<{ error: string }>(result).error).toBe("UNAUTHORIZED");
    expect(send).not.toHaveBeenCalled();
    await tokenClient.close();
  });

  it("read scope 的状态请求拒绝错误 workspaceId", async () => {
    vi.spyOn(desktopIpc, "inspect").mockResolvedValue({ title: "测试 Desktop 会话" } as never);
    await bindDesktop(bridge.workspace, { threadId: THREAD_ID, hostId: "local", projectId: "project_test" });
    const client = await clientFor([DESKTOP_READ_SCOPE]);
    const result = await client.callTool({ name: "codex_desktop_status", arguments: { workspaceId: "wrong_workspace" } });
    expect(result.isError).toBe(true);
    expect(jsonOf<{ error: string }>(result).error).toBe("DESKTOP_WRONG_WORKSPACE");
    await client.close();
  });

  it("Desktop 工具分别校验 control/read scope 与 workspaceId", async () => {
    vi.spyOn(desktopIpc, "inspect").mockResolvedValue({ title: "测试 Desktop 会话" } as never);
    const binding = await bindDesktop(bridge.workspace, { threadId: THREAD_ID, hostId: "local", projectId: "project_test" });
    const readClient = await clientFor([DESKTOP_READ_SCOPE], "read-client");
    const deniedSend = await readClient.callTool({
      name: "codex_desktop_send",
      arguments: { intent: "development_plan", userConfirmed: true, workspaceId: bridge.workspace.id, bindingId: binding.bindingId, commandId: "command_1", message: "完整计划" },
    });
    expect(deniedSend.isError).toBe(true);
    expect(jsonOf<{ error: string }>(deniedSend).error).toBe("INSUFFICIENT_SCOPE");
    await readClient.close();

    const controlClient = await clientFor([DESKTOP_CONTROL_SCOPE], "control-client");
    const deniedStatus = await controlClient.callTool({
      name: "codex_desktop_status",
      arguments: { workspaceId: "wrong_workspace" },
    });
    expect(deniedStatus.isError).toBe(true);
    expect(jsonOf<{ error: string }>(deniedStatus).error).toBe("INSUFFICIENT_SCOPE");
    await controlClient.close();
  });

  it("CLI 注册 bind/enable/disable/status，并要求 enable 明确接受权限", () => {
    const program = new Command();
    registerDesktopCommands(program);
    const desktop = program.commands.find(command => command.name() === "desktop");
    expect(desktop?.commands.map(command => command.name())).toEqual(["record-result", "legacy-reconcile", "legacy-retire", "abandon", "bind-current", "bind", "enable", "disable", "status", "history", "compatibility"]);
    expect(desktop?.commands.find(command => command.name() === "enable")?.options.map(option => option.long)).toContain("--accept-desktop-permissions");
    expect(desktop?.commands.find(command => command.name() === "legacy-reconcile")?.options.map(option => option.long)).toEqual([
      "--workspace", "--command-id", "--list", "--json",
    ]);
    expect(desktop?.commands.find(command => command.name() === "legacy-retire")?.options.find(option => option.long === "--command-id")?.mandatory).toBe(true);
    expect(desktop?.commands.find(command => command.name() === "abandon")?.options.map(option => option.long)).toEqual([
      "--workspace", "--command-ids", "--confirm", "--json",
    ]);
    expect(desktop?.commands.find(command => command.name() === "abandon")?.options.find(option => option.long === "--command-ids")?.mandatory).toBe(true);
    expect(desktop?.commands.find(command => command.name() === "abandon")?.options.map(option => option.long)).not.toContain("--all");
    expect(desktop?.commands.find(command => command.name() === "history")?.options.map(option => option.long)).toEqual([
      "--workspace", "--json",
    ]);
  });

  it("CLI 解析时拒绝没有确认参数的 enable 和缺少目标的 bind", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const program = new Command().exitOverride();
    registerDesktopCommands(program);
    await expect(program.parseAsync(["node", "c2c", "desktop", "enable", "-w", root, "--binding", "00000000-0000-0000-0000-000000000001"])).rejects.toThrow();
    const missingTarget = new Command().exitOverride();
    registerDesktopCommands(missingTarget);
    await expect(missingTarget.parseAsync(["node", "c2c", "desktop", "bind", "-w", root])).rejects.toThrow();
  });
});
