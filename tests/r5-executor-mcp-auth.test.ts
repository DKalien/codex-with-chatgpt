import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { desktopIpc } from "../src/desktop/ipc.js";
import { bindDesktop, enableDesktop } from "../src/desktop/service.js";
import {
  DESKTOP_CONTROL_SCOPE,
  DESKTOP_READ_SCOPE,
  EXECUTOR_CONTROL_SCOPE,
  EXECUTOR_READ_SCOPE,
} from "../src/auth/store.js";
import { feedbackStateFile } from "../src/feedback/store.js";
import { bindCurrentExecutor } from "../src/executor-control/service.js";
import { projectCodexDesktopTargetToExecutorBindingCandidate } from "../src/executor/index.js";
import { listCommands, listRoutes } from "../src/routing/store.js";
import { resolveConversationPrincipal } from "../src/mcp/conversation-principal.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const THREAD_ID = "01a00000-0000-7000-8000-000000000001";
const PROJECT_ID = "project_test";
const PLANNER_CONVERSATION_ID = "018c0000-0000-7000-8000-00000000c2c1";
const runtimeFence = {
  desktopPid: 1001,
  desktopExe: "C:\\Program Files\\ChatGPT\\ChatGPT.exe",
  desktopCreation: "1000001",
  appServerPid: 1002,
  appServerExe: "C:\\Program Files\\ChatGPT\\codex.exe",
  appServerCreation: "1000002",
};

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
  clientId = "executor-auth-test",
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

async function bindGenericAndDesktop(): Promise<string> {
  vi.spyOn(desktopIpc, "inspect").mockResolvedValue({ title: "测试 Desktop 会话" } as never);
  vi.spyOn(desktopIpc, "discoverForBinding").mockResolvedValue({ title: "测试 Desktop 会话", runtimeFence } as never);
  const desktop = await bindDesktop(bridge.workspace, {
    threadId: THREAD_ID,
    hostId: "local",
    projectId: PROJECT_ID,
  });
  enableDesktop(bridge.workspace, desktop.bindingId);
  const candidate = projectCodexDesktopTargetToExecutorBindingCandidate({
    target: {
      threadId: desktop.threadId,
      hostId: desktop.hostId,
      projectId: desktop.projectId,
      workspaceRoot: bridge.workspace.root,
    },
    workspaceId: bridge.workspace.id,
  });
  const bound = bindCurrentExecutor(bridge.workspace.id, bridge.workspace.root, candidate);
  return bound.binding.bindingId;
}

beforeEach(async () => {
  previousStateDir = process.env.C2C_STATE_DIR;
  stateDir = isolateStateDir();
  root = makeTmpDir("executor-mcp-auth-workspace");
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

describe("R5b real MCP executor authorization", () => {
  it("executor_list requires executor.read; desktop.read/workspace.read cannot substitute", async () => {
    const workspaceOnly = await clientFor(["workspace.read"], "ws-read");
    const deniedWs = await workspaceOnly.callTool({ name: "executor_list", arguments: {} });
    expect(deniedWs.isError).toBe(true);
    expect(textOf(deniedWs)).toContain("INSUFFICIENT_SCOPE");
    await workspaceOnly.close();

    const desktopRead = await clientFor([DESKTOP_READ_SCOPE], "desktop-read");
    const deniedDesktop = await desktopRead.callTool({ name: "executor_list", arguments: {} });
    expect(deniedDesktop.isError).toBe(true);
    expect(textOf(deniedDesktop)).toContain("INSUFFICIENT_SCOPE");
    await desktopRead.close();

    const executorRead = await clientFor([EXECUTOR_READ_SCOPE], "executor-read");
    const allowed = await executorRead.callTool({ name: "executor_list", arguments: {} });
    expect(allowed.isError).not.toBe(true);
    expect(jsonOf<{ plugins: { pluginId: string }[] }>(allowed).plugins.map(p => p.pluginId)).toEqual(["codex-desktop"]);
    await executorRead.close();
  });

  it("executor_status requires executor.read; desktop.read cannot substitute", async () => {
    const desktopRead = await clientFor([DESKTOP_READ_SCOPE], "desktop-read-status");
    const denied = await desktopRead.callTool({
      name: "executor_status",
      arguments: { workspaceId: bridge.workspace.id },
    });
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toContain("INSUFFICIENT_SCOPE");
    await desktopRead.close();

    const executorRead = await clientFor([EXECUTOR_READ_SCOPE], "executor-read-status");
    const allowed = await executorRead.callTool({
      name: "executor_status",
      arguments: { workspaceId: bridge.workspace.id },
    });
    expect(allowed.isError).not.toBe(true);
    expect(jsonOf<{ workspaceId: string }>(allowed).workspaceId).toBe(bridge.workspace.id);
    await executorRead.close();
  });

  it("executor_send rejects non-executor.control scopes", async () => {
    const bindingId = await bindGenericAndDesktop();
    seedVerifiedPlannerRoute();
    for (const [scopes, name] of [
      [[DESKTOP_CONTROL_SCOPE], "desktop-control"],
      [["codex.control"], "codex-control"],
      [["codex.feedback"], "feedback"],
      [[EXECUTOR_READ_SCOPE], "executor-read-only"],
    ] as [string[], string][]) {
      const client = await clientFor(scopes, name);
      const denied = await client.callTool({
        name: "executor_send",
        arguments: {
          workspaceId: bridge.workspace.id,
          bindingId,
          commandId: `cmd_${name}`,
          intent: "development_plan",
          userConfirmed: true,
          message: "task body",
        },
      });
      expect(denied.isError, name).toBe(true);
      expect(textOf(denied), name).toContain("INSUFFICIENT_SCOPE");
      await client.close();
    }
  });

  it("executor.control alone does not authorize remote/feedback mutation tools", async () => {
    const client = await clientFor([EXECUTOR_CONTROL_SCOPE], "executor-control-only");
    const remote = await client.callTool({ name: "codex_create_thread", arguments: {
      workspaceId: bridge.workspace.id,
      requestId: "req-remote",
    } });
    const remoteText = textOf(remote) || String((remote as { error?: string }).error ?? "");
    expect(String(remoteText)).toMatch(/INSUFFICIENT_SCOPE|error|-32602|Unknown/);
    const feedback = await client.callTool({ name: "feedback_enable", arguments: {
      workspaceId: bridge.workspace.id,
    } });
    const feedbackText = textOf(feedback) || String((feedback as { error?: string }).error ?? "");
    expect(String(feedbackText)).toMatch(/INSUFFICIENT_SCOPE|error|-32602|Unknown/);
    await client.close();
  });

  it("invalid executor_send input causes zero routing mutation and no Desktop prepare", async () => {
    const bindingId = await bindGenericAndDesktop();
    seedVerifiedPlannerRoute();
    const prepare = vi.spyOn(desktopIpc, "prepare");
    const send = vi.fn();
    prepare.mockResolvedValue({ send, close: vi.fn() } as never);
    const client = await clientFor([EXECUTOR_CONTROL_SCOPE], "invalid-input");
    const base = {
      workspaceId: bridge.workspace.id,
      bindingId,
      commandId: "valid_command",
      intent: "development_plan",
      userConfirmed: true,
      message: "ok",
    };
    const cases = [
      { ...base, commandId: "bad command!" },
      { ...base, workspaceId: "ZZZZ" },
      { ...base, message: "x".repeat(64 * 1024 + 1) },
      { ...base, message: "bad\uD800surrogate" },
    ];
    for (const args of cases) {
      const result = await client.callTool({ name: "executor_send", arguments: args });
      expect(result.isError).toBe(true);
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(listCommands({ id: bridge.workspace.id, root: bridge.workspace.root } as never)).toEqual([]);
    expect(listRoutes({ id: bridge.workspace.id, root: bridge.workspace.root } as never)).toEqual([]);
    await client.close();
  });

  it("commit-time revocation rejects send and does not commit delivery", async () => {
    const bindingId = await bindGenericAndDesktop();
    seedVerifiedPlannerRoute();
    const send = vi.fn(async () => ({ threadId: THREAD_ID, turnId: "01a00000-0000-7000-8000-000000000002" }));
    vi.spyOn(desktopIpc, "prepare").mockImplementation(async () => {
      bridge.authStore.revokeAll();
      return { send, close: vi.fn() } as never;
    });
    const client = await clientFor([EXECUTOR_CONTROL_SCOPE], "revoked-executor");
    const result = await client.callTool({
      name: "executor_send",
      arguments: {
        workspaceId: bridge.workspace.id,
        bindingId,
        commandId: "revoked_command",
        intent: "development_plan",
        userConfirmed: true,
        message: "should not send",
      },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/UNAUTHORIZED|INSUFFICIENT_SCOPE|AUTH/);
    expect(send).not.toHaveBeenCalled();
    await client.close();
  });

  it("executor_send with executor.control reaches generic control path and freezes binding", async () => {
    const bindingId = await bindGenericAndDesktop();
    seedVerifiedPlannerRoute();
    const send = vi.fn(async () => ({ threadId: THREAD_ID, turnId: "01a00000-0000-7000-8000-000000000009" }));
    vi.spyOn(desktopIpc, "prepare").mockResolvedValue({ send, close: vi.fn() } as never);
    const session = "session-accepted";
    const client = await clientFor([EXECUTOR_CONTROL_SCOPE], "accepted-executor", session);
    const result = await client.callTool({
      name: "executor_send",
      arguments: {
        workspaceId: bridge.workspace.id,
        bindingId,
        commandId: "accepted_command",
        intent: "development_plan",
        userConfirmed: true,
        message: "SECRET_TASK_BODY",
      },
    });
    expect(result.isError).not.toBe(true);
    const payload = jsonOf<Record<string, unknown>>(result);
    expect(payload.commandId).toBe("accepted_command");
    expect(payload.bindingId).toBe(bindingId);
    expect(payload.deliveryId).toBe("01a00000-0000-7000-8000-000000000009");
    expect(JSON.stringify(payload)).not.toContain("SECRET_TASK_BODY");
    expect(JSON.stringify(payload)).not.toContain("threadId");
    expect(JSON.stringify(payload)).not.toContain("turnId");
    await client.close();
  });
});
