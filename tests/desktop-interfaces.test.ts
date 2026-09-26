import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { desktopFile } from "../src/desktop/store.js";
import { feedbackStateFile } from "../src/feedback/store.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { bindDesktop, enableDesktop } from "../src/desktop/service.js";
import { desktopIpc } from "../src/desktop/ipc.js";
import { DESKTOP_CONTROL_SCOPE, DESKTOP_READ_SCOPE, filterScopes, getSupportedScopes, SUPPORTED_SCOPES } from "../src/auth/store.js";
import { registerDesktopCommands } from "../src/cli/desktop.js";
import { createCurrentCommand } from "../src/routing/current-command.js";
import { listCommands, listRoutes, registerRoute } from "../src/routing/store.js";
import { resolveConversationPrincipal } from "../src/mcp/conversation-principal.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const THREAD_ID = "01a00000-0000-7000-8000-000000000001";
const THREAD_ID_2 = "01a00000-0000-7000-8000-000000000003";
const PLANNER_CONVERSATION_ID = "018c0000-0000-7000-8000-00000000c2c1";

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

async function clientFor(
  scopes: string[],
  clientId = "desktop-interface-test",
  conversationSession: string | null = `session-${clientId}`,
): Promise<Client> {
  const token = bridge.authStore.issueTokens({ clientId, scopes });
  const client = new Client({ name: clientId, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token.accessToken}` } },
  }));
  if (conversationSession !== null) {
    const callTool = client.callTool.bind(client);
    client.callTool = ((params, ...rest) => callTool({
      ...params,
      _meta: { ...params._meta, "openai/session": conversationSession },
    }, ...rest)) as typeof client.callTool;
  }
  return client;
}

function requestPlannerFingerprint(clientId: string, session: string): string {
  return resolveConversationPrincipal({
    authInfo: { clientId } as never,
    _meta: { "openai/session": session },
  }).fingerprint;
}

function seedVerifiedPlannerRoute(): void {
  const routeCanonical = `https://chatgpt.com/c/${PLANNER_CONVERSATION_ID}`;
  const now = new Date().toISOString();
  const file = feedbackStateFile(bridge.workspace.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    workspaceId: bridge.workspace.id,
    projectionCursor: 0,
    binding: null,
    events: [],
    pairingIntent: null,
    companion: {
      version: 1,
      companionId: randomUUID(),
      bindingId: randomUUID(),
      epoch: 0,
      principalFingerprint: "a".repeat(32),
      credentialHash: "b".repeat(64),
      routeCanonical,
      pairedAt: now,
      routeAttestation: {
        status: "verified",
        challengeId: randomUUID(),
        challengeDigest: "c".repeat(64),
        routeCanonical,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        verifiedAt: now,
      },
    },
    rebindIntent: null,
    rebindPredecessor: null,
  }));
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
    expect(unboundTools).toHaveLength(22);
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
    seedVerifiedPlannerRoute();
    registerRoute(bridge.workspace, {
      role: "planner",
      platform: "chatgpt_web",
      conversationId: PLANNER_CONVERSATION_ID,
      locator: {},
    });
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
    const command = listCommands(bridge.workspace)[0];
    const routes = listRoutes(bridge.workspace);
    expect(command).toMatchObject({ commandId: "accepted_command", intent, deliveryStatus: "accepted" });
    expect(routes.find(route => route.routeId === command.plannerRouteId)).toMatchObject({
      role: "planner", platform: "chatgpt_web",
      conversationId: requestPlannerFingerprint("desktop-interface-test", "session-desktop-interface-test"),
    });
    expect(routes.find(route => route.role === "planner" && route.conversationId === PLANNER_CONVERSATION_ID)).toBeDefined();
    expect(routes.find(route => route.routeId === command.executorRouteId)).toMatchObject({
      role: "executor", platform: "codex_desktop", conversationId: THREAD_ID,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify({ result, routes })).not.toContain("session-desktop-interface-test");
    await client.close();
  });

  it("新 command 的 stale bindingId 不会自动切换目标或进入 IPC", async () => {
    vi.spyOn(desktopIpc, "inspect").mockResolvedValue({ title: "测试 Desktop 会话" } as never);
    seedVerifiedPlannerRoute();
    const binding = await bindDesktop(bridge.workspace, { threadId: THREAD_ID, hostId: "local", projectId: "project_test" });
    enableDesktop(bridge.workspace, binding.bindingId);
    const prepare = vi.spyOn(desktopIpc, "prepare");
    const client = await clientFor([DESKTOP_CONTROL_SCOPE]);
    const response = await client.callTool({
      name: "codex_desktop_send",
      arguments: {
        intent: "development_plan", userConfirmed: true, workspaceId: bridge.workspace.id,
        bindingId: randomUUID(), commandId: "stale_binding_command", message: "完整计划",
      },
    });

    expect(response.isError).toBe(true);
    expect(jsonOf<{ error: string }>(response).error).toBe("DESKTOP_BINDING_MISMATCH");
    expect(prepare).not.toHaveBeenCalled();
    expect(listCommands(bridge.workspace)).toEqual([]);
    await client.close();
  });

  it("pending 且无 Desktop durable record 时，bindingId 仍须匹配当前 target", async () => {
    vi.spyOn(desktopIpc, "inspect").mockResolvedValue({ title: "测试 Desktop 会话" } as never);
    seedVerifiedPlannerRoute();
    const originalBinding = await bindDesktop(bridge.workspace, { threadId: THREAD_ID, hostId: "local", projectId: "project_test" });
    enableDesktop(bridge.workspace, originalBinding.bindingId);
    createCurrentCommand(bridge.workspace, requestPlannerFingerprint("desktop-interface-test", "session-desktop-interface-test"), {
      commandId: "pending_binding_switch", intent: "revision", payload: "完整修订",
    });
    const currentBinding = await bindDesktop(bridge.workspace, {
      threadId: THREAD_ID_2, hostId: "local", projectId: "project_next",
    });
    enableDesktop(bridge.workspace, currentBinding.bindingId);
    const prepare = vi.spyOn(desktopIpc, "prepare");
    const client = await clientFor([DESKTOP_CONTROL_SCOPE]);
    const input = {
      intent: "revision", userConfirmed: true, workspaceId: bridge.workspace.id,
      commandId: "pending_binding_switch", message: "完整修订",
    };

    const staleTarget = await client.callTool({
      name: "codex_desktop_send", arguments: { ...input, bindingId: originalBinding.bindingId },
    });
    expect(staleTarget.isError).toBe(true);
    expect(jsonOf<{ error: string }>(staleTarget).error).toBe("DESKTOP_BINDING_MISMATCH");

    const changedRoute = await client.callTool({
      name: "codex_desktop_send", arguments: { ...input, bindingId: currentBinding.bindingId },
    });
    expect(changedRoute.isError).toBe(true);
    expect(jsonOf<{ error: string }>(changedRoute).error).toBe("ROUTE_AUTHORITY_CHANGED");
    expect(prepare).not.toHaveBeenCalled();
    expect(listCommands(bridge.workspace)).toMatchObject([{ commandId: "pending_binding_switch", deliveryStatus: "pending" }]);
    await client.close();
  });

  it("durable replay 返回原 delivery、保留原 bindingId，改 bindingId 冲突且不二次发送", async () => {
    vi.spyOn(desktopIpc, "inspect").mockResolvedValue({ title: "测试 Desktop 会话" } as never);
    seedVerifiedPlannerRoute();
    const binding = await bindDesktop(bridge.workspace, { threadId: THREAD_ID, hostId: "local", projectId: "project_test" });
    enableDesktop(bridge.workspace, binding.bindingId);
    const send = vi.fn(async () => ({ threadId: THREAD_ID, turnId: "01a00000-0000-7000-8000-000000000004" }));
    const prepare = vi.spyOn(desktopIpc, "prepare").mockResolvedValue({ send, close: vi.fn() } as never);
    const client = await clientFor([DESKTOP_CONTROL_SCOPE]);
    const input = {
      intent: "revision", userConfirmed: true, workspaceId: bridge.workspace.id,
      bindingId: binding.bindingId, commandId: "durable_binding_replay", message: "完整修订",
    };
    const first = await client.callTool({ name: "codex_desktop_send", arguments: input });
    const sameBindingReplay = await client.callTool({ name: "codex_desktop_send", arguments: input });

    expect(first.isError).not.toBe(true);
    expect(sameBindingReplay.isError).not.toBe(true);
    expect(jsonOf(sameBindingReplay)).toEqual(jsonOf(first));
    expect(prepare).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();

    const nextBinding = await bindDesktop(bridge.workspace, {
      threadId: THREAD_ID_2, hostId: "local", projectId: "project_next",
    });
    enableDesktop(bridge.workspace, nextBinding.bindingId);
    const afterSwitch = await client.callTool({ name: "codex_desktop_send", arguments: input });
    expect(afterSwitch.isError).not.toBe(true);
    expect(jsonOf(afterSwitch)).toEqual(jsonOf(first));

    const changedBindingReplay = await client.callTool({
      name: "codex_desktop_send", arguments: { ...input, bindingId: nextBinding.bindingId },
    });
    expect(changedBindingReplay.isError).toBe(true);
    expect(jsonOf<{ error: string }>(changedBindingReplay).error).toBe("DESKTOP_COMMAND_CONFLICT");
    expect(prepare).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    await client.close();
  });

  it("workspace mismatch 被拒绝；Browser feedback 不存在、损坏或未 VERIFIED 均不阻断投递", async () => {
    vi.spyOn(desktopIpc, "inspect").mockResolvedValue({ title: "测试 Desktop 会话" } as never);
    const binding = await bindDesktop(bridge.workspace, { threadId: THREAD_ID, hostId: "local", projectId: "project_test" });
    enableDesktop(bridge.workspace, binding.bindingId);
    const prepare = vi.spyOn(desktopIpc, "prepare");
    const client = await clientFor([DESKTOP_CONTROL_SCOPE]);

    const wrongWorkspace = await client.callTool({
      name: "codex_desktop_send",
      arguments: {
        intent: "development_plan", userConfirmed: true, workspaceId: "wrong_workspace",
        bindingId: binding.bindingId, commandId: "wrong_workspace_command", message: "完整计划",
      },
    });
    expect(wrongWorkspace.isError).toBe(true);
    expect(jsonOf<{ error: string }>(wrongWorkspace).error).toBe("DESKTOP_WRONG_WORKSPACE");

    for (const [index, feedbackState] of ["absent", "corrupt", "unverified"].entries()) {
      const file = feedbackStateFile(bridge.workspace.id);
      if (feedbackState === "absent") fs.rmSync(file, { force: true });
      if (feedbackState === "corrupt") {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "not-json");
      }
      if (feedbackState === "unverified") {
        seedVerifiedPlannerRoute();
        const state = JSON.parse(fs.readFileSync(file, "utf8")) as { companion: { routeAttestation: { status: string; verifiedAt?: string } } };
        state.companion.routeAttestation.status = "pending";
        delete state.companion.routeAttestation.verifiedAt;
        fs.writeFileSync(file, JSON.stringify(state));
      }
      const send = vi.fn(async () => ({ threadId: THREAD_ID, turnId: randomUUID() }));
      prepare.mockResolvedValue({ send, close: vi.fn() } as never);
      const delivered = await client.callTool({
        name: "codex_desktop_send",
        arguments: {
          intent: "development_plan", userConfirmed: true, workspaceId: bridge.workspace.id,
          bindingId: binding.bindingId, commandId: `feedback-independent-${index}`, message: "完整计划",
        },
      });
      expect(delivered.isError).not.toBe(true);
      expect(jsonOf<{ deliveryStatus: string }>(delivered).deliveryStatus).toBe("accepted");
      expect(send).toHaveBeenCalledOnce();
    }
    expect(prepare).toHaveBeenCalledTimes(3);
    await client.close();
  });

  it("缺少官方 openai/session 时不从参数或历史 planner route 回退，且不写 Command/发送", async () => {
    vi.spyOn(desktopIpc, "inspect").mockResolvedValue({ title: "测试 Desktop 会话" } as never);
    seedVerifiedPlannerRoute();
    registerRoute(bridge.workspace, {
      role: "planner",
      platform: "chatgpt_web",
      conversationId: PLANNER_CONVERSATION_ID,
      locator: {},
    });
    const binding = await bindDesktop(bridge.workspace, { threadId: THREAD_ID, hostId: "local", projectId: "project_test" });
    enableDesktop(bridge.workspace, binding.bindingId);
    const prepare = vi.spyOn(desktopIpc, "prepare");
    const client = await clientFor([DESKTOP_CONTROL_SCOPE], "missing-session-client", null);
    const result = await client.callTool({
      name: "codex_desktop_send",
      arguments: {
        intent: "development_plan", userConfirmed: true, workspaceId: bridge.workspace.id,
        bindingId: binding.bindingId, commandId: "missing_mcp_session", message: "不得发送",
      },
    });
    expect(result.isError).toBe(true);
    expect(jsonOf<{ error: string }>(result).error).toBe("ROUTING_PLANNER_IDENTITY_UNAVAILABLE");
    expect(prepare).not.toHaveBeenCalled();
    expect(listCommands(bridge.workspace)).toEqual([]);
    await client.close();
  });

  it("同 OAuth client 不同 MCP conversation principal 使用不同 planner route", async () => {
    vi.spyOn(desktopIpc, "inspect").mockResolvedValue({ title: "测试 Desktop 会话" } as never);
    const binding = await bindDesktop(bridge.workspace, { threadId: THREAD_ID, hostId: "local", projectId: "project_test" });
    enableDesktop(bridge.workspace, binding.bindingId);
    const send = vi.fn(async () => ({ threadId: THREAD_ID, turnId: randomUUID() }));
    vi.spyOn(desktopIpc, "prepare").mockResolvedValue({ send, close: vi.fn() } as never);
    const clientA = await clientFor([DESKTOP_CONTROL_SCOPE], "same-oauth-client", "session-A");
    const clientB = await clientFor([DESKTOP_CONTROL_SCOPE], "same-oauth-client", "session-B");
    const makeInput = (commandId: string) => ({
      intent: "revision", userConfirmed: true, workspaceId: bridge.workspace.id,
      bindingId: binding.bindingId, commandId, message: "独立 conversation 投递",
    });
    const first = await clientA.callTool({ name: "codex_desktop_send", arguments: makeInput("principal-A") });
    const samePrincipal = await clientA.callTool({ name: "codex_desktop_send", arguments: makeInput("principal-A-2") });
    const second = await clientB.callTool({ name: "codex_desktop_send", arguments: makeInput("principal-B") });
    const sameCommandReplay = await clientA.callTool({ name: "codex_desktop_send", arguments: makeInput("principal-A") });
    const crossPrincipalReplay = await clientB.callTool({ name: "codex_desktop_send", arguments: makeInput("principal-A") });
    expect(first.isError).not.toBe(true);
    expect(samePrincipal.isError).not.toBe(true);
    expect(second.isError).not.toBe(true);
    expect(sameCommandReplay.isError).not.toBe(true);
    expect(jsonOf(sameCommandReplay)).toEqual(jsonOf(first));
    expect(crossPrincipalReplay.isError).toBe(true);
    expect(jsonOf<{ error: string }>(crossPrincipalReplay).error).toBe("COMMAND_CONFLICT");
    const commands = listCommands(bridge.workspace);
    const routes = listRoutes(bridge.workspace);
    const plannerIds = commands.map((command) => routes.find((route) => route.routeId === command.plannerRouteId)?.conversationId);
    expect(plannerIds).toEqual([
      requestPlannerFingerprint("same-oauth-client", "session-A"),
      requestPlannerFingerprint("same-oauth-client", "session-A"),
      requestPlannerFingerprint("same-oauth-client", "session-B"),
    ]);
    expect(new Set(plannerIds).size).toBe(2);
    expect(commands[0]?.plannerRouteId).toBe(commands[1]?.plannerRouteId);
    expect(JSON.stringify(routes)).not.toContain("session-A");
    expect(send).toHaveBeenCalledTimes(3);
    await clientA.close();
    await clientB.close();
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
    seedVerifiedPlannerRoute();
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
    expect(desktop?.commands.map(command => command.name())).toEqual(["record-result", "reconcile-result", "result-reconciliation-status", "reconcile-unknown", "legacy-reconcile", "legacy-retire", "abandon", "resolve-unknown", "bind-current", "bind", "enable", "disable", "status", "history", "diagnose"]);
    expect(desktop?.helpInformation()).toContain("reconcile-result");
    expect(desktop?.helpInformation()).toContain("result-reconciliation-status");
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
    expect(desktop?.commands.find(command => command.name() === "resolve-unknown")?.options.map(option => option.long)).toEqual([
      "--workspace", "--command-id", "--confirm", "--json",
    ]);
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
