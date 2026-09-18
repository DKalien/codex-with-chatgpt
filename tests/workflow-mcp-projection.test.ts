import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { mergeSession, projectChatOwnerFingerprint, writeSession } from "../src/session/state.js";
import { desktopFile } from "../src/desktop/store.js";
import { remoteFile } from "../src/remote/store.js";
import { desktopIpc } from "../src/desktop/ipc.js";
import { DESKTOP_CONTROL_SCOPE, DESKTOP_READ_SCOPE } from "../src/auth/store.js";
import { workflowOutputSchema } from "../src/mcp/server.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const PROJECT = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";
const BINDING_THREAD = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

let stateDir: string;
let previousStateDir: string | undefined;
let root: string;
let bridge: Bridge;

function textOf(result: { content?: unknown }): string {
  const content = result.content as { type: string; text: string }[];
  return content?.[0]?.text ?? "";
}

function jsonOf<T = Record<string, unknown>>(result: { content?: unknown; structuredContent?: unknown }): T {
  const parsed = JSON.parse(textOf(result)) as T;
  if (result.structuredContent !== undefined) {
    expect(result.structuredContent).toEqual(parsed);
  }
  return parsed;
}

type WorkflowInfo = {
  connectorContractVersion: number;
  desktopCompatibility: { status: string };
  workspaceId: string;
  workspaceName: string;
  rootAlias: string;
  workflow: {
    schemaVersion: number;
    overall: string;
    nextAction: string;
    requestContext: { source: string; conversationIdentity: string; remote: string };
    connection: {
      running: string;
      runtimeUpgrade: string;
      authorization: string;
      connectorContract: string;
      desktopCompatibility: string;
    };
    conversation: { mode: string; chatKnown: boolean; chatBinding: string; projectReady: boolean };
    desktop: Record<string, unknown>;
    remote: Record<string, unknown>;
    blockers: Array<{ code: string; detail?: string }>;
  };
};

async function clientFor(scopes: string[], clientId: string): Promise<Client> {
  const token = bridge.authStore.issueTokens({ clientId, scopes });
  const client = new Client({ name: clientId, version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token.accessToken}` } },
  }));
  return client;
}

async function workspaceInfo(
  client: Client,
  meta?: Record<string, unknown>,
): Promise<WorkflowInfo> {
  const result = await client.callTool({
    name: "workspace_info",
    arguments: {},
    ...(meta ? { _meta: meta } : {}),
  });
  expect(result.isError).not.toBe(true);
  return jsonOf<WorkflowInfo>(result);
}

function writeDesktop(workspaceId: string) {
  const file = desktopFile(workspaceId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    workspaceId,
    workspaceRoot: root,
    enabled: true,
    binding: {
      threadId: BINDING_THREAD,
      hostId: "local",
      projectId: "p1",
      bindingId: "33333333-3333-4333-8333-333333333333",
      title: "t",
      boundAt: "2026-01-01T00:00:00.000Z",
    },
    deliveries: [],
  }));
}

function writeRemoteOnline(workspaceId: string) {
  const file = remoteFile(workspaceId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    workspaceId,
    workspaceRoot: root,
    enabled: true,
    threads: [],
    tasks: [],
    audit: [],
    controller: { pid: 1, instanceId: "i", heartbeatAt: Date.now(), appServer: "running" },
  }));
}

beforeEach(async () => {
  previousStateDir = process.env.C2C_STATE_DIR;
  stateDir = isolateStateDir();
  root = makeTmpDir("workflow-mcp-req");
  // Force runtime projection to current so readiness can reach desktop/remote gates.
  vi.spyOn(await import("../src/workflow/request.js"), "projectRuntimeUpgrade").mockReturnValue("current");
  bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    runtimeBuildId: null,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await bridge.close();
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
  cleanup(root);
  cleanup(stateDir);
});

describe("G2 request-scoped workspace_info.workflow over HTTP MCP", () => {
  it("Case A: machine has full Desktop token; workspace.read-only request must not borrow it", async () => {
    bridge.authStore.issueTokens({
      clientId: "other-full-desktop",
      scopes: ["workspace.read", DESKTOP_READ_SCOPE, DESKTOP_CONTROL_SCOPE, "codex.read", "codex.control"],
    });
    expect(bridge.authStore.desktopCompatibility()).toEqual({ status: "current" });

    const readClient = await clientFor(["workspace.read"], "read-only-request");
    try {
      const info = await workspaceInfo(readClient);
      expect(info.rootAlias).toBe("workspace:/");
      expect(info.desktopCompatibility.status).toBe("legacy");
      expect(info.workflow.connection.desktopCompatibility).toBe("legacy");
      expect(info.workflow.overall).not.toBe("ready_local");
      expect(info.workflow.overall).not.toBe("ready_remote");
      expect(workflowOutputSchema.safeParse(info.workflow).success).toBe(true);

      const tools = await readClient.listTools();
      const workflowSchema = (tools.tools.find((t) => t.name === "workspace_info")?.outputSchema as {
        properties?: { workflow?: { properties?: Record<string, unknown> } };
      })?.properties?.workflow?.properties;
      const overallEnum = (workflowSchema?.overall as { enum?: string[] } | undefined)?.enum;
      expect(overallEnum).toEqual(expect.arrayContaining(["ready_local", "blocked", "needs_authorization"]));
      const runtimeEnum = (workflowSchema?.connection as { properties?: Record<string, unknown> })
        ?.properties?.runtimeUpgrade as { enum?: string[] } | undefined;
      expect(runtimeEnum?.enum).toEqual(["current", "pending", "unknown"]);
    } finally {
      await readClient.close();
    }
  });

  it("Case B: full Desktop request scopes + exact local binding → ready_local; chatKnown stays false", async () => {
    writeDesktop(bridge.workspace.id);
    writeSession(bridge.workspace.id, mergeSession(null, {
      conversationMode: "project",
      projectUrl: PROJECT,
    }));
    vi.spyOn(desktopIpc, "currentIdentity").mockResolvedValue({
      threadId: BINDING_THREAD,
      hostId: "local",
      projectId: "p1",
      title: "t",
    } as never);
    vi.spyOn(desktopIpc, "inspect").mockResolvedValue({
      threadId: BINDING_THREAD,
      hostId: "local",
      projectId: "p1",
      title: "t",
    } as never);

    const full = await clientFor([
      "workspace.read",
      DESKTOP_READ_SCOPE,
      DESKTOP_CONTROL_SCOPE,
      "codex.read",
      "codex.control",
    ], "full-desktop-request");
    try {
      const info = await workspaceInfo(full, { "openai/session": "sess-case-b" });
      expect(info.desktopCompatibility.status).toBe("current");
      expect(info.workflow.connection.desktopCompatibility).toBe("current");
      expect(info.workflow.requestContext.conversationIdentity).toBe("available");
      expect(info.workflow.requestContext.remote).toBe("current");
      expect(info.workflow.conversation.chatKnown).toBe(false);
      expect(info.workflow.conversation.chatBinding).toBe("none");
      expect(info.workflow.overall).toBe("ready_local");
      expect(info.workflow.nextAction).toBe("reuse");
      expect(workflowOutputSchema.safeParse(info.workflow).success).toBe(true);

      const dump = JSON.stringify(info.workflow);
      for (const forbidden of ["threadId", "bindingId", "hostId", "projectId", root, "sess-case-b"]) {
        expect(dump).not.toContain(forbidden);
      }
    } finally {
      await full.close();
    }
  });

  it("Case C: Remote online but request lacks codex.read/control → not ready_remote", async () => {
    writeSession(bridge.workspace.id, mergeSession(null, {
      conversationMode: "project",
      projectUrl: PROJECT,
    }));
    writeRemoteOnline(bridge.workspace.id);

    const desktopOnly = await clientFor([
      "workspace.read",
      DESKTOP_READ_SCOPE,
      DESKTOP_CONTROL_SCOPE,
    ], "desktop-no-remote-scopes");
    try {
      const info = await workspaceInfo(desktopOnly, { "openai/session": "sess-case-c" });
      expect(info.workflow.requestContext.remote).toBe("none");
      expect(info.workflow.requestContext.conversationIdentity).toBe("available");
      expect(info.workflow.overall).not.toBe("ready_remote");
      expect(info.workflow.overall).toBe("needs_authorization");
      expect(info.workflow.blockers.some((b) => b.code === "remote_request_scope_missing")).toBe(true);
      expect(info.workflow.conversation.chatKnown).toBe(false);
    } finally {
      await desktopOnly.close();
    }

    const withRemote = await clientFor([
      "workspace.read",
      DESKTOP_READ_SCOPE,
      DESKTOP_CONTROL_SCOPE,
      "codex.read",
      "codex.control",
    ], "with-remote-scopes");
    try {
      const info = await workspaceInfo(withRemote, { "openai/session": "sess-case-c2" });
      expect(info.workflow.requestContext.remote).toBe("current");
      expect(info.workflow.overall).toBe("ready_remote");
      expect(info.workflow.nextAction).toBe("use_remote");
    } finally {
      await withRemote.close();
    }
  });

  it("projection failure keeps workspace_info identity and full schema over HTTP", async () => {
    const facts = await import("../src/workflow/facts.js");
    vi.spyOn(facts, "collectWorkflowCapabilityFacts").mockRejectedValue(new Error("http_projection_boom"));
    const client = await clientFor(["workspace.read"], "projection-fail");
    try {
      const info = await workspaceInfo(client);
      expect(info.workspaceId).toBe(bridge.workspace.id);
      expect(info.workflow.overall).toBe("blocked");
      expect(info.workflow.blockers).toEqual([{ code: "workflow_projection_failed" }]);
      expect(workflowOutputSchema.safeParse(info.workflow).success).toBe(true);
      expect(JSON.stringify(info)).not.toContain("http_projection_boom");
      expect(info.rootAlias).toBe("workspace:/");
      expect(JSON.stringify(info.workflow)).not.toContain(root);
    } finally {
      await client.close();
    }
  });
});
