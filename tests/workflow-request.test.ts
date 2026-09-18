import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Workspace } from "../src/workspace/manager.js";
import { mergeSession, projectChatOwnerFingerprint, writeSession } from "../src/session/state.js";
import { collectWorkflowCapabilityFacts } from "../src/workflow/facts.js";
import {
  projectRuntimeUpgrade,
  remoteRequestCapability,
  requestAuthorization,
  requestConversationAvailable,
  workflowProjectionFailure,
} from "../src/workflow/request.js";
import { resolveWorkflowReadiness, WORKFLOW_BLOCKER_CODES } from "../src/workflow/readiness.js";
import { buildWorkspaceInfoWorkflow, workflowOutputSchema } from "../src/mcp/server.js";
import { desktopFile } from "../src/desktop/store.js";
import { remoteFile } from "../src/remote/store.js";
import { desktopIpc } from "../src/desktop/ipc.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const PROJECT = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";
const CHAT = "https://chatgpt.com/c/aaaaaaaa-1111-4111-8111-111111111111";
const THREAD_A = "11111111-1111-7111-8111-111111111111";
const BINDING_THREAD = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

let stateDir: string;
let previousStateDir: string | undefined;
let root: string;

beforeEach(() => {
  previousStateDir = process.env.C2C_STATE_DIR;
  stateDir = isolateStateDir();
  root = makeTmpDir("workflow-g2");
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
  delete process.env.CODEX_THREAD_ID;
  delete process.env.CODEX_SESSION_ID;
  cleanup(root);
  cleanup(stateDir);
});

function baseConnection(overrides: Record<string, unknown> = {}) {
  return {
    running: "running" as const,
    runtimeUpgrade: "current" as const,
    authorization: "authorized" as const,
    connectorContract: "current" as const,
    desktopCompatibility: "current" as const,
    ...overrides,
  };
}

function healthyRemoteInput(remoteCap?: "current" | "incomplete" | "none") {
  return {
    workspaceId: "2582910bf0d2",
    workspaceName: "ws",
    connection: baseConnection(),
    conversation: {
      mode: "project" as const,
      projectReady: true,
      chatKnown: true,
      chatBinding: "none" as const,
      checkpoint: "none" as const,
      sessionCorrupt: false,
    },
    desktop: {
      configured: false,
      enabled: false,
      currentTarget: "unavailable" as const,
      bindingAvailability: "unavailable" as const,
      unresolvedDelivery: false,
    },
    remote: { enabled: true, controller: "online" as const, activeWork: false, needsReconciliation: false },
    ...(remoteCap ? {} : {}),
  };
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

function writeRemote(workspaceId: string) {
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

describe("G2 runtime upgrade projection", () => {
  it("state-first: stopped/unknown → unknown even with pending marker", () => {
    expect(projectRuntimeUpgrade({ state: "stale", upgradePending: true })).toBe("pending");
    expect(projectRuntimeUpgrade({ state: "stale", upgradePending: false })).toBe("pending");
    expect(projectRuntimeUpgrade({ state: "current", upgradePending: true })).toBe("pending");
    expect(projectRuntimeUpgrade({ state: "current", upgradePending: false })).toBe("current");
    expect(projectRuntimeUpgrade({ state: "unknown", upgradePending: true })).toBe("unknown");
    expect(projectRuntimeUpgrade({ state: "stopped", upgradePending: false })).toBe("unknown");
    expect(projectRuntimeUpgrade({ state: "stopped", upgradePending: true })).toBe("unknown");
    expect(projectRuntimeUpgrade({ state: "corrupt", upgradePending: true })).toBe("unknown");
    expect(projectRuntimeUpgrade(null)).toBe("unknown");
  });
});

describe("G2 request helpers", () => {
  it("remote request capability by scopes", () => {
    expect(remoteRequestCapability(["codex.read", "codex.control"])).toBe("current");
    expect(remoteRequestCapability(["codex.read"])).toBe("incomplete");
    expect(remoteRequestCapability(["codex.control"])).toBe("incomplete");
    expect(remoteRequestCapability([])).toBe("none");
    expect(remoteRequestCapability(undefined)).toBe("none");
  });

  it("conversation identity only from official openai/session", () => {
    expect(requestConversationAvailable({
      authInfo: { clientId: "c1", token: "t", scopes: [] } as never,
      _meta: { "openai/session": "sess_abc" },
    })).toBe(true);
    expect(requestConversationAvailable({
      authInfo: { clientId: "c1", token: "t", scopes: [] } as never,
      _meta: { conversationId: "user-supplied" },
    })).toBe(false);
    expect(requestConversationAvailable({
      authInfo: { clientId: "c1", token: "t", scopes: [] } as never,
      sessionId: "mcp-session-id",
    })).toBe(false);
    process.env.CODEX_THREAD_ID = THREAD_A;
    expect(requestConversationAvailable({})).toBe(false);
  });

  it("request authorization isolated from AuthStore aggregate", () => {
    expect(requestAuthorization({ clientId: "c", token: "t", scopes: ["workspace.read"] } as never)).toBe("authorized");
    expect(requestAuthorization(undefined)).toBe("unknown");
  });
});

describe("G2 workflowProjectionFailure schema shape", () => {
  it("returns full schema-valid projection with workflow_projection_failed", () => {
    const fallback = workflowProjectionFailure({
      conversationIdentity: "available",
      remoteCapability: "none",
      authorization: "authorized",
      desktopCompatibility: "legacy",
      connectorContract: "current",
    });
    const parsed = workflowOutputSchema.safeParse(fallback);
    expect(parsed.success).toBe(true);
    expect(fallback.overall).toBe("blocked");
    expect(fallback.nextAction).toBe("stop_unknown");
    expect(fallback.blockers).toEqual([{ code: "workflow_projection_failed" }]);
    expect(fallback.connection.running).toBe("running");
    expect(fallback.connection.runtimeUpgrade).toBe("unknown");
    expect(fallback.conversation.chatKnown).toBe(false);
    expect(fallback.desktop).toBeDefined();
    expect(fallback.remote).toBeDefined();
  });

  it("normal resolver output also passes the same schema", () => {
    const result = resolveWorkflowReadiness(healthyRemoteInput(), { remoteControl: "current", currentConversation: "available" });
    const projection = {
      schemaVersion: result.schemaVersion,
      overall: result.overall,
      nextAction: result.nextAction,
      requestContext: { source: "mcp_request" as const, conversationIdentity: "available" as const, remote: "current" as const },
      connection: result.connection,
      conversation: result.conversation,
      desktop: result.desktop,
      remote: result.remote,
      blockers: result.blockers,
    };
    expect(workflowOutputSchema.safeParse(projection).success).toBe(true);
  });

  it("WORKFLOW_BLOCKER_CODES covers resolver + G2 projection codes", () => {
    for (const code of [
      "session_corrupt",
      "remote_request_scope_missing",
      "remote_request_scope_incomplete",
      "workflow_projection_failed",
      "project_not_ready",
      "conversation_not_reusable",
    ] as const) {
      expect(WORKFLOW_BLOCKER_CODES).toContain(code);
    }
  });
});

describe("G2 remote scope gate in resolver", () => {
  it("local remote ready + request scope none/incomplete → not ready_remote", () => {
    for (const cap of ["none", "incomplete"] as const) {
      const r = resolveWorkflowReadiness(healthyRemoteInput(), { remoteControl: cap });
      expect(r.overall).toBe("needs_authorization");
      expect(r.nextAction).toBe("resume_authorization");
      expect(r.blockers.some((b) => b.code.startsWith("remote_request_scope_"))).toBe(true);
    }
  });

  it("request remote current + healthy remote → ready_remote", () => {
    const r = resolveWorkflowReadiness(healthyRemoteInput(), { remoteControl: "current" });
    expect(r.overall).toBe("ready_remote");
  });

  it("CLI (no requestPolicy) keeps ready_remote when remote online", () => {
    const r = resolveWorkflowReadiness(healthyRemoteInput());
    expect(r.overall).toBe("ready_remote");
  });
});

describe("G2 currentConversation vs durable chatKnown", () => {
  function projectNoDurableChat() {
    return {
      ...healthyRemoteInput(),
      conversation: {
        mode: "project" as const,
        projectReady: true,
        chatKnown: false,
        chatBinding: "none" as const,
        checkpoint: "none" as const,
        sessionCorrupt: false,
      },
    };
  }

  it("request conversation available can proceed this turn without flipping chatKnown", () => {
    const r = resolveWorkflowReadiness(projectNoDurableChat(), {
      remoteControl: "current",
      currentConversation: "available",
    });
    expect(r.overall).toBe("ready_remote");
    expect(r.conversation.chatKnown).toBe(false);
    expect(r.conversation.chatBinding).toBe("none");
  });

  it("request conversation unavailable → needs_conversation", () => {
    const r = resolveWorkflowReadiness(projectNoDurableChat(), {
      remoteControl: "current",
      currentConversation: "unavailable",
    });
    expect(r.overall).toBe("needs_conversation");
    expect(r.nextAction).toBe("open_project_chat");
  });

  it("projectReady false still needs_project even with request conversation", () => {
    const r = resolveWorkflowReadiness({
      ...projectNoDurableChat(),
      conversation: { ...projectNoDurableChat().conversation, projectReady: false },
    }, { remoteControl: "current", currentConversation: "available" });
    expect(r.overall).toBe("needs_project");
    expect(r.nextAction).toBe("bind_project");
  });
});

describe("G2 MCP request capability facts", () => {
  it("mcp_request never sets chatKnown from openai/session; chatBinding none", async () => {
    const workspace = new Workspace(root);
    process.env.CODEX_THREAD_ID = THREAD_A;
    writeSession(workspace.id, mergeSession(null, {
      conversationMode: "project",
      projectUrl: PROJECT,
      url: CHAT,
      chatOwnerFingerprint: projectChatOwnerFingerprint(workspace.id, THREAD_A),
    }));
    const facts = await collectWorkflowCapabilityFacts(workspace, {
      kind: "mcp_request",
      conversationAvailable: true,
    });
    expect(facts.conversation.chatBinding).toBe("none");
    expect(facts.conversation.chatKnown).toBe(false);
    expect(facts.conversation.projectReady).toBe(true);
  });

  it("full Desktop request + exact local desktop can ready_local via currentConversation; read-only token cannot", async () => {
    const workspace = new Workspace(root);
    writeDesktop(workspace.id);
    writeSession(workspace.id, mergeSession(null, { conversationMode: "project", projectUrl: PROJECT }));
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
    const facts = await collectWorkflowCapabilityFacts(workspace, {
      kind: "mcp_request",
      conversationAvailable: true,
    });
    expect(facts.desktop.currentTarget).toBe("exact");
    expect(facts.desktop.bindingAvailability).toBe("available");
    expect(facts.conversation.chatKnown).toBe(false);

    const full = resolveWorkflowReadiness({
      workspaceId: workspace.id,
      workspaceName: "ws",
      connection: baseConnection({ desktopCompatibility: "current", authorization: "authorized" }),
      conversation: facts.conversation,
      desktop: facts.desktop,
      remote: { enabled: false, controller: "offline", activeWork: false, needsReconciliation: false },
    }, { remoteControl: "current", currentConversation: "available" });
    expect(full.overall).toBe("ready_local");
    expect(full.nextAction).toBe("reuse");
    expect(full.conversation.chatKnown).toBe(false);

    const readOnly = resolveWorkflowReadiness({
      workspaceId: workspace.id,
      workspaceName: "ws",
      connection: baseConnection({ desktopCompatibility: "none", authorization: "authorized" }),
      conversation: facts.conversation,
      desktop: facts.desktop,
      remote: { enabled: false, controller: "offline", activeWork: false, needsReconciliation: false },
    }, { remoteControl: "none", currentConversation: "available" });
    expect(readOnly.overall).toBe("needs_authorization");
  });

  it("durable blockers still project: session corrupt / unresolved delivery / remote reconcile", async () => {
    const workspace = new Workspace(root);
    const sessionPath = `${process.env.C2C_STATE_DIR}/sessions/${workspace.id}.json`;
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, JSON.stringify({
      savedAt: "2026-01-01T00:00:00.000Z",
      conversationMode: "project",
      projectUrl: PROJECT,
      projectChats: "corrupt",
    }));
    writeDesktop(workspace.id);
    const dfile = desktopFile(workspace.id);
    const desktop = JSON.parse(fs.readFileSync(dfile, "utf8"));
    desktop.deliveries = [{
      commandId: "cmd1",
      clientId: "c",
      bindingId: "33333333-3333-4333-8333-333333333333",
      messageSha256: "a".repeat(64),
      messageBytes: 10,
      threadId: BINDING_THREAD,
      deliveryStatus: "outcome_unknown",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }];
    fs.writeFileSync(dfile, JSON.stringify(desktop));
    writeRemote(workspace.id);
    const rfile = remoteFile(workspace.id);
    const remote = JSON.parse(fs.readFileSync(rfile, "utf8"));
    remote.tasks = [{
      workspaceId: workspace.id,
      requestId: "r1",
      threadId: "t1",
      commandId: "c1",
      kind: "development_plan",
      goal: "g",
      clientId: "c",
      taskId: "task1",
      status: "needs_reconciliation",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }];
    fs.writeFileSync(rfile, JSON.stringify(remote));

    const facts = await collectWorkflowCapabilityFacts(workspace, {
      kind: "mcp_request",
      conversationAvailable: true,
    });
    expect(facts.conversation.sessionCorrupt).toBe(true);
    expect(facts.desktop.unresolvedDelivery).toBe(true);
    expect(facts.remote.needsReconciliation).toBe(true);

    const result = resolveWorkflowReadiness({
      workspaceId: workspace.id,
      workspaceName: "ws",
      connection: baseConnection(),
      conversation: facts.conversation,
      desktop: facts.desktop,
      remote: facts.remote,
    }, { remoteControl: "current", currentConversation: "available" });
    expect(result.overall).toBe("blocked");
  });

  it("collect twice does not mutate session/desktop/remote bytes", async () => {
    const workspace = new Workspace(root);
    writeSession(workspace.id, mergeSession(null, {
      conversationMode: "project",
      projectUrl: PROJECT,
      chatOwnerFingerprint: projectChatOwnerFingerprint(workspace.id, THREAD_A),
    }));
    writeDesktop(workspace.id);
    writeRemote(workspace.id);
    process.env.CODEX_THREAD_ID = THREAD_A;
    const sessionPath = `${process.env.C2C_STATE_DIR}/sessions/${workspace.id}.json`;
    const before = {
      s: fs.readFileSync(sessionPath, "utf8"),
      d: fs.readFileSync(desktopFile(workspace.id), "utf8"),
      r: fs.readFileSync(remoteFile(workspace.id), "utf8"),
    };
    await collectWorkflowCapabilityFacts(workspace, { kind: "mcp_request", conversationAvailable: false });
    await collectWorkflowCapabilityFacts(workspace, { kind: "mcp_request", conversationAvailable: true });
    expect(fs.readFileSync(sessionPath, "utf8")).toBe(before.s);
    expect(fs.readFileSync(desktopFile(workspace.id), "utf8")).toBe(before.d);
    expect(fs.readFileSync(remoteFile(workspace.id), "utf8")).toBe(before.r);
  });
});

describe("G2 real workspace_info.workflow projection", () => {
  const logger = { info() {}, error() {}, warn() {}, debug() {} } as never;

  it("builder output has no sensitive fields; rootAlias not inside workflow", async () => {
    const workspace = new Workspace(root);
    writeDesktop(workspace.id);
    writeSession(workspace.id, mergeSession(null, {
      conversationMode: "project",
      projectUrl: PROJECT,
      url: CHAT,
      chatOwnerFingerprint: projectChatOwnerFingerprint(workspace.id, THREAD_A),
    }));
    writeRemote(workspace.id);
    const workflow = await buildWorkspaceInfoWorkflow(
      workspace,
      {
        workspace,
        logger,
        desktopCompatibility: () => ({ status: "legacy" }),
        runtimeUpgrade: () => "unknown",
      },
      {
        authInfo: { clientId: "c-read", token: "at_secret_value", scopes: ["workspace.read"] } as never,
        _meta: { "openai/session": "sess_secret_key" },
      },
      { status: "legacy" },
    );
    const dump = JSON.stringify(workflow);
    for (const forbidden of [
      "threadId",
      "bindingId",
      "hostId",
      "projectId",
      "projectChats",
      "ownerFingerprint",
      "conversationKey",
      "sessionId",
      "adminToken",
      "at_secret_value",
      "sess_secret_key",
      root,
    ]) {
      expect(dump).not.toContain(forbidden);
    }
    expect(workflow.conversation.chatKnown).toBe(false);
    expect(workflow.requestContext.conversationIdentity).toBe("available");
    expect(workflow.connection.desktopCompatibility).toBe("legacy");
    expect(workflowOutputSchema.safeParse(workflow).success).toBe(true);
  });

  it("runtime hook throw → full fallback via MCP handler, identity preserved", async () => {
    const workspace = new Workspace(root);
    writeSession(workspace.id, mergeSession(null, { conversationMode: "project", projectUrl: PROJECT }));
    const { createMcpServer } = await import("../src/mcp/server.js");
    const server = createMcpServer({
      workspace,
      logger,
      desktopCompatibility: () => ({ status: "legacy" }),
      runtimeUpgrade: () => {
        throw new Error(`secret-thread/${BINDING_THREAD}`);
      },
    });
    const tools = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (a: unknown, e: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> }>;
      }>;
    })._registeredTools;
    const result = await tools.workspace_info.handler({}, {
      authInfo: { clientId: "c-read", token: "t", scopes: ["workspace.read"] },
      _meta: { "openai/session": "sess-x" },
    });
    expect(result.isError).not.toBe(true);
    const info = JSON.parse(result.content[0].text) as {
      workspaceId: string;
      rootAlias: string;
      workflow: Record<string, unknown>;
    };
    expect(info.workspaceId).toBe(workspace.id);
    expect(info.rootAlias).toBe("workspace:/");
    expect(info.workflow.overall).toBe("blocked");
    expect(info.workflow.blockers).toEqual([{ code: "workflow_projection_failed" }]);
    expect(workflowOutputSchema.safeParse(info.workflow).success).toBe(true);
    const dump = JSON.stringify(info.workflow);
    expect(dump).not.toContain("secret-thread");
    expect(dump).not.toContain(BINDING_THREAD);
  });

  it("capability collector failure → MCP tool still succeeds with full fallback schema", async () => {
    const workspace = new Workspace(root);
    const facts = await import("../src/workflow/facts.js");
    vi.spyOn(facts, "collectWorkflowCapabilityFacts").mockRejectedValue(new Error("collector_boom_admin_token"));
    const { createMcpServer } = await import("../src/mcp/server.js");
    const server = createMcpServer({
      workspace,
      logger,
      desktopCompatibility: () => ({ status: "current" }),
      runtimeUpgrade: () => "current",
    });
    const tools = (server as unknown as {
      _registeredTools: Record<string, {
        handler: (a: unknown, e: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
      }>;
    })._registeredTools;
    const result = await tools.workspace_info.handler({}, {
      authInfo: { clientId: "c-full", token: "t", scopes: ["workspace.read", "codex.desktop.read", "codex.desktop.control"] },
      _meta: {},
    });
    expect(result.isError).not.toBe(true);
    const info = JSON.parse(result.content[0].text) as {
      workspaceId: string;
      workflow: Record<string, unknown>;
    };
    expect(info.workspaceId).toBe(workspace.id);
    expect(info.workflow.overall).toBe("blocked");
    expect((info.workflow.blockers as Array<{ code: string }>)[0]?.code).toBe("workflow_projection_failed");
    expect(workflowOutputSchema.safeParse(info.workflow).success).toBe(true);
    expect(JSON.stringify(info.workflow)).not.toContain("collector_boom_admin_token");
    expect(JSON.stringify(info.workflow)).not.toContain("admin_token");
  });
});
