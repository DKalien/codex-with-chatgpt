import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  clearChatPointer,
  conversationChatKnown,
  currentCodexThreadId,
  mergeSession,
  projectChatBinding,
  projectChatForCurrentThread,
  projectChatOwnerFingerprint,
  readSession,
  upsertProjectChat,
  writeSession,
  PROJECT_CHATS_MAX,
} from "../src/session/state.js";
import { Workspace } from "../src/workspace/manager.js";
import { collectWorkflowReadinessInput } from "../src/cli/workflow.js";
import {
  formatWorkflowReadinessHuman,
  resolveWorkflowReadiness,
  type WorkflowReadinessInput,
} from "../src/workflow/readiness.js";
import { desktopFile } from "../src/desktop/store.js";
import { remoteFile } from "../src/remote/store.js";
import { desktopIpc } from "../src/desktop/ipc.js";
import { DesktopError } from "../src/desktop/store.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const PROJECT = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";
const CHAT_A = "https://chatgpt.com/c/aaaaaaaa-1111-4111-8111-111111111111";
const CHAT_B = "https://chatgpt.com/c/bbbbbbbb-2222-4222-8222-222222222222";
const THREAD_A = "11111111-1111-7111-8111-111111111111";
const THREAD_B = "22222222-2222-7222-8222-222222222222";
const WS = "workspaceg1amulti";
const BINDING_THREAD = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const BINDING_PROJECT = "project_bind_test";
const BINDING_ID = "33333333-3333-4333-8333-333333333333";

let stateDir: string;
let previousStateDir: string | undefined;
let root: string;

beforeEach(() => {
  previousStateDir = process.env.C2C_STATE_DIR;
  stateDir = isolateStateDir();
  root = makeTmpDir("workflow-g1a-review2");
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

function baseInput(overrides: Partial<WorkflowReadinessInput> = {}): WorkflowReadinessInput {
  return {
    workspaceId: "2582910bf0d2",
    workspaceName: "codex-with-chatgpt",
    connection: {
      running: "running",
      runtimeUpgrade: "current",
      authorization: "authorized",
      connectorContract: "current",
      desktopCompatibility: "current",
    },
    conversation: {
      mode: "project",
      projectReady: true,
      chatKnown: true,
      chatBinding: "same_thread",
      checkpoint: "none",
      sessionCorrupt: false,
    },
    desktop: {
      configured: true,
      enabled: true,
      currentTarget: "exact",
      bindingAvailability: "available",
      unresolvedDelivery: false,
    },
    remote: {
      enabled: false,
      controller: "offline",
      activeWork: false,
      needsReconciliation: false,
    },
    now: 1_700_000_000_000,
    ...overrides,
  };
}

function saveProjectChat(workspaceId: string, threadId: string, url: string): void {
  process.env.CODEX_THREAD_ID = threadId;
  delete process.env.CODEX_SESSION_ID;
  const fp = projectChatOwnerFingerprint(workspaceId, threadId);
  const previous = readSession(workspaceId);
  writeSession(workspaceId, mergeSession(previous, {
    conversationMode: "project",
    projectUrl: PROJECT,
    url,
    chatOwnerFingerprint: fp,
  }));
}

function writeDesktopFixture(workspaceId: string): void {
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
      projectId: BINDING_PROJECT,
      bindingId: BINDING_ID,
      title: "test desktop",
      boundAt: "2026-01-01T00:00:00.000Z",
    },
    deliveries: [],
  }));
}

function writeRemoteFixture(workspaceId: string): void {
  const file = remoteFile(workspaceId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    workspaceId,
    workspaceRoot: root,
    enabled: false,
    threads: [],
    tasks: [],
    audit: [],
  }));
}

describe("G1a multi-thread projectChats map", () => {
  it("A saves Chat A, B saves Chat B; both recover same_thread independently", () => {
    const workspace = new Workspace(root);
    saveProjectChat(workspace.id, THREAD_A, CHAT_A);
    saveProjectChat(workspace.id, THREAD_B, CHAT_B);
    const session = readSession(workspace.id)!;
    expect(session.projectChats?.length).toBe(2);
    process.env.CODEX_THREAD_ID = THREAD_A;
    expect(projectChatForCurrentThread(session, workspace.id).url).toBe(CHAT_A);
    expect(projectChatBinding(session, workspace.id)).toBe("same_thread");
    process.env.CODEX_THREAD_ID = THREAD_B;
    expect(projectChatForCurrentThread(session, workspace.id).url).toBe(CHAT_B);
    expect(projectChatBinding(session, workspace.id)).toBe("same_thread");
  });

  it("legacy project URL without map → unowned", () => {
    process.env.CODEX_THREAD_ID = THREAD_A;
    const session = {
      savedAt: "2026-01-01T00:00:00.000Z",
      conversationMode: "project" as const,
      projectUrl: PROJECT,
      url: CHAT_A,
    };
    expect(projectChatBinding(session, WS)).toBe("unowned");
  });

  it("CODEX_SESSION_ID mismatch → no ownership stamp", () => {
    process.env.CODEX_THREAD_ID = THREAD_A;
    process.env.CODEX_SESSION_ID = THREAD_B;
    expect(currentCodexThreadId()).toBeNull();
    expect(projectChatBinding({
      savedAt: "2026-01-01T00:00:00.000Z",
      conversationMode: "project",
      projectUrl: PROJECT,
      url: CHAT_A,
      projectChats: [{ ownerFingerprint: projectChatOwnerFingerprint(WS, THREAD_A), url: CHAT_A }],
    }, WS)).toBe("current_thread_unknown");
  });

  it("checkpoint / metadata updates preserve mappings", () => {
    const workspace = new Workspace(root);
    saveProjectChat(workspace.id, THREAD_A, CHAT_A);
    saveProjectChat(workspace.id, THREAD_B, CHAT_B);
    const next = mergeSession(readSession(workspace.id), {
      taskId: "t1",
      checkpoint: { protocolState: "EXECUTED_SENT", waitingFor: "GPT_REVIEW" },
    });
    expect(next.projectChats?.length).toBe(2);
    writeSession(workspace.id, next);
    process.env.CODEX_THREAD_ID = THREAD_A;
    expect(projectChatBinding(readSession(workspace.id), workspace.id)).toBe("same_thread");
  });

  it("clear Thread A retains Thread B mapping", () => {
    const workspace = new Workspace(root);
    saveProjectChat(workspace.id, THREAD_A, CHAT_A);
    saveProjectChat(workspace.id, THREAD_B, CHAT_B);
    process.env.CODEX_THREAD_ID = THREAD_A;
    clearChatPointer(workspace.id);
    const after = readSession(workspace.id)!;
    expect(after.projectChats?.some((e) => e.ownerFingerprint === projectChatOwnerFingerprint(workspace.id, THREAD_A))).toBe(false);
    expect(after.projectChats?.some((e) => e.ownerFingerprint === projectChatOwnerFingerprint(workspace.id, THREAD_B))).toBe(true);
    process.env.CODEX_THREAD_ID = THREAD_B;
    expect(projectChatBinding(after, workspace.id)).toBe("same_thread");
  });

  it("clear with unknown thread does not delete other owner mappings", () => {
    const workspace = new Workspace(root);
    saveProjectChat(workspace.id, THREAD_A, CHAT_A);
    saveProjectChat(workspace.id, THREAD_B, CHAT_B);
    delete process.env.CODEX_THREAD_ID;
    clearChatPointer(workspace.id);
    const after = readSession(workspace.id)!;
    expect(after.projectChats?.length).toBe(2);
  });

  it("capacity full new entry → fail closed; same fingerprint replace allowed", () => {
    const list = Array.from({ length: PROJECT_CHATS_MAX }, (_, i) => ({
      ownerFingerprint: i.toString(16).padStart(64, "0"),
      url: `https://chatgpt.com/c/${i}`,
    }));
    const insert = upsertProjectChat(list, { ownerFingerprint: "f".repeat(64), url: CHAT_A });
    expect(insert.ok).toBe(false);
    const replace = upsertProjectChat(list, { ownerFingerprint: list[0].ownerFingerprint, url: CHAT_A });
    expect(replace.ok).toBe(true);
  });

  it("corrupt projectChats: readSession throws; checkpoint update fails; bytes unchanged; collector blocked", async () => {
    const workspace = new Workspace(root);
    const sessionPath = `${process.env.C2C_STATE_DIR}/sessions/${workspace.id}.json`;
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    const corrupt = {
      savedAt: "2026-01-01T00:00:00.000Z",
      conversationMode: "project",
      projectUrl: PROJECT,
      url: CHAT_A,
      projectChats: [{ ownerFingerprint: "not-hex", url: CHAT_A }],
    };
    const raw = JSON.stringify(corrupt);
    fs.writeFileSync(sessionPath, raw);
    expect(() => readSession(workspace.id)).toThrow();
    expect(() => mergeSession(readSession(workspace.id), {})).toThrow();
    expect(fs.readFileSync(sessionPath, "utf8")).toBe(raw);
    const input = await collectWorkflowReadinessInput(workspace);
    expect(input.conversation.sessionCorrupt).toBe(true);
    expect(resolveWorkflowReadiness(input).overall).toBe("blocked");
  });

  it("projectChats: null is corrupt (not legacy no-map); collector blocked", async () => {
    const workspace = new Workspace(root);
    const sessionPath = `${process.env.C2C_STATE_DIR}/sessions/${workspace.id}.json`;
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    const raw = JSON.stringify({
      savedAt: "2026-01-01T00:00:00.000Z",
      conversationMode: "project",
      projectUrl: PROJECT,
      url: CHAT_A,
      projectChats: null,
    });
    fs.writeFileSync(sessionPath, raw);
    expect(() => readSession(workspace.id)).toThrow();
    const input = await collectWorkflowReadinessInput(workspace);
    expect(input.conversation.sessionCorrupt).toBe(true);
    expect(resolveWorkflowReadiness(input).overall).toBe("blocked");
  });

  it("Project invalid chat URL → chatKnown false; pure resolver → needs_conversation", async () => {
    const workspace = new Workspace(root);
    const fp = projectChatOwnerFingerprint(workspace.id, THREAD_A);
    process.env.CODEX_THREAD_ID = THREAD_A;
    writeSession(workspace.id, mergeSession(null, {
      conversationMode: "project",
      projectUrl: PROJECT,
      url: "https://example.com/not-chatgpt",
      chatOwnerFingerprint: fp,
    }));
    const { resolveThreadConversation, conversationChatKnown } = await import("../src/session/state.js");
    const thread = resolveThreadConversation(readSession(workspace.id), workspace.id);
    const known = conversationChatKnown(readSession(workspace.id), workspace.id);
    expect(thread.chatBinding).toBe("same_thread");
    expect(thread.reuseChat).toBe(false);
    expect(thread.chatUrl).toBeNull();
    expect(known.chatKnown).toBe(false);
    const input = await collectWorkflowReadinessInput(workspace);
    expect(input.conversation.chatKnown).toBe(false);
    expect(input.conversation.chatBinding).toBe("same_thread");
    // Collector may report needs_connection when Bridge is stopped in this test env.
    // New current_context threads bind locally before opening a ChatGPT conversation.
    const synthetic = resolveWorkflowReadiness({
      ...input,
      connection: {
        running: "running",
        runtimeUpgrade: "current",
        authorization: "authorized",
        connectorContract: "current",
        desktopCompatibility: "current",
      },
    });
    expect(synthetic.overall).toBe("needs_desktop_bind");
    expect(synthetic.nextAction).toBe("bind_current");
  });

  it("long-chat invalid URL → chatKnown false, not ready reuse", async () => {
    const workspace = new Workspace(root);
    writeSession(workspace.id, {
      savedAt: "2026-01-01T00:00:00.000Z",
      conversationMode: "long-chat",
      url: "https://example.com/not-chatgpt",
    });
    process.env.CODEX_THREAD_ID = THREAD_A;
    const input = await collectWorkflowReadinessInput(workspace);
    expect(input.conversation.chatKnown).toBe(false);
    const r = resolveWorkflowReadiness(input);
    expect(r.overall).not.toBe("ready_local");
  });

  it("collector same-thread ready path uses projectChats not session.url alone", async () => {
    const workspace = new Workspace(root);
    saveProjectChat(workspace.id, THREAD_A, CHAT_A);
    saveProjectChat(workspace.id, THREAD_B, CHAT_B);
    process.env.CODEX_THREAD_ID = THREAD_A;
    const input = await collectWorkflowReadinessInput(workspace);
    expect(input.conversation.chatBinding).toBe("same_thread");
    expect(input.conversation.chatKnown).toBe(true);
  });
  it("local readiness does not depend on request conversation or durable chatKnown", () => {
    const withoutDurableChat = baseInput({
      conversation: {
        mode: "project",
        projectReady: true,
        chatKnown: false,
        chatBinding: "none",
        checkpoint: "none",
        sessionCorrupt: false,
      },
    });
    const withRequest = resolveWorkflowReadiness(withoutDurableChat, { currentConversation: "available" });
    expect(withRequest.overall).toBe("ready_local");
    expect(withRequest.conversation.chatKnown).toBe(false);

    const withoutRequest = resolveWorkflowReadiness(withoutDurableChat, { currentConversation: "unavailable" });
    expect(withoutRequest.overall).toBe("ready_local");
    expect(withoutRequest.nextAction).toBe("reuse");
  });
});

describe("G2 desktopRoute saved_binding vs current_context", () => {
  function healthyConversation() {
    return {
      mode: "project" as const,
      projectReady: true,
      chatKnown: false,
      chatBinding: "none" as const,
      checkpoint: "none" as const,
      sessionCorrupt: false,
    };
  }
  function connection() {
    return {
      running: "running" as const,
      runtimeUpgrade: "current" as const,
      authorization: "authorized" as const,
      connectorContract: "current" as const,
      desktopCompatibility: "current" as const,
    };
  }
  function remoteOffline() {
    return { enabled: false, controller: "offline" as const, activeWork: false, needsReconciliation: false };
  }
  function remoteOnline() {
    return { enabled: true, controller: "online" as const, activeWork: false, needsReconciliation: false };
  }
  function desktop(overrides: Partial<WorkflowReadinessInput["desktop"]> = {}): WorkflowReadinessInput["desktop"] {
    return {
      configured: true,
      enabled: true,
      currentTarget: "unavailable",
      bindingAvailability: "available",
      unresolvedDelivery: false,
      ...overrides,
    };
  }
  function input(
    desktopFacts: WorkflowReadinessInput["desktop"],
    remote = remoteOffline(),
    conversation = healthyConversation(),
  ): WorkflowReadinessInput {
    return {
      workspaceId: "2582910bf0d2",
      workspaceName: "ws",
      connection: connection(),
      conversation,
      desktop: desktopFacts,
      remote,
      now: 1,
    };
  }

  it("MCP saved_binding + available → ready_local even without currentTarget exact", () => {
    const r = resolveWorkflowReadiness(input(desktop()), {
      desktopRoute: "saved_binding",
      currentConversation: "available",
      remoteControl: "current",
    });
    expect(r.overall).toBe("ready_local");
    expect(r.nextAction).toBe("reuse");
    expect(r.desktop.currentTarget).toBe("unavailable");
  });

  it("same facts without request policy (CLI current_context) → needs_desktop_bind", () => {
    const r = resolveWorkflowReadiness(input(desktop()), { currentConversation: "available" });
    expect(r.overall).toBe("needs_desktop_bind");
    expect(r.nextAction).toBe("bind_current");
  });

  it("new current_context thread binds locally without opening ChatGPT", () => {
    for (const desktopFacts of [
      desktop({ configured: false, enabled: false, currentTarget: "unavailable" }),
      desktop({ configured: true, enabled: false, currentTarget: "unavailable" }),
      desktop({ configured: true, enabled: false, currentTarget: "exact", bindingAvailability: "available" }),
      desktop({ configured: true, enabled: true, currentTarget: "different" }),
    ]) {
      const r = resolveWorkflowReadiness(input(desktopFacts), { currentConversation: "unavailable" });
      expect(r.overall).toBe("needs_desktop_bind");
      expect(r.nextAction).toBe("bind_current");
      expect(r.nextAction).not.toBe("open_project_chat");
    }
  });

  it("exact local Desktop is ready without a same-thread Project chat", () => {
    const r = resolveWorkflowReadiness(
      input(desktop({ currentTarget: "exact", bindingAvailability: "available" }), remoteOffline(), {
        ...healthyConversation(),
        chatBinding: "other_thread",
      }),
      { currentConversation: "unavailable" },
    );
    expect(r.overall).toBe("ready_local");
    expect(r.nextAction).toBe("reuse");
  });

  it("missing first-time Project still requires bind_project before local readiness", () => {
    const r = resolveWorkflowReadiness(
      input(desktop({ currentTarget: "exact", bindingAvailability: "available" }), remoteOffline(), {
        ...healthyConversation(),
        projectReady: false,
        chatBinding: "none",
      }),
      { currentConversation: "unavailable" },
    );
    expect(r.overall).toBe("needs_project");
    expect(r.nextAction).toBe("bind_project");
  });

  it("unavailable current target binds before opening a missing Project chat", () => {
    const r = resolveWorkflowReadiness(
      input(desktop({ currentTarget: "unavailable", bindingAvailability: "available" })),
      { currentConversation: "unavailable" },
    );
    expect(r.overall).toBe("needs_desktop_bind");
    expect(r.nextAction).toBe("bind_current");
    expect(r.blockers).toContainEqual({ code: "desktop_unavailable", detail: "available" });
  });

  it("exact target keeps busy/unknown strict and routes unavailable with a request conversation", () => {
    const busy = resolveWorkflowReadiness(
      input(desktop({ currentTarget: "exact", bindingAvailability: "busy" }), remoteOnline()),
      { currentConversation: "unavailable" },
    );
    expect(busy.overall).toBe("busy");
    expect(busy.nextAction).toBe("wait_current_task");
    expect(busy.nextAction).not.toBe("bind_current");
    expect(busy.nextAction).not.toBe("open_project_chat");

    const unknown = resolveWorkflowReadiness(
      input(desktop({ currentTarget: "exact", bindingAvailability: "unknown" }), remoteOnline()),
      { currentConversation: "unavailable" },
    );
    expect(unknown.overall).toBe("blocked");
    expect(unknown.nextAction).toBe("stop_unknown");
    expect(unknown.blockers).toContainEqual({ code: "desktop_delivery_unknown" });

    const unavailable = resolveWorkflowReadiness(
      input(desktop({ currentTarget: "exact", bindingAvailability: "unavailable" }), remoteOnline()),
      { currentConversation: "available" },
    );
    expect(unavailable.overall).toBe("ready_remote");
    expect(unavailable.nextAction).toBe("use_remote");
  });

  it("exact unavailable uses safely-ready Remote with current request scopes", () => {
    const r = resolveWorkflowReadiness(
      input(desktop({ currentTarget: "exact", bindingAvailability: "unavailable" }), remoteOnline()),
      { currentConversation: "available", remoteControl: "current" },
    );
    expect(r.overall).toBe("ready_remote");
    expect(r.nextAction).toBe("use_remote");
  });

  it("exact unavailable + Remote ready requires missing/incomplete request scopes", () => {
    for (const remoteControl of ["none", "incomplete"] as const) {
      const r = resolveWorkflowReadiness(
        input(desktop({ currentTarget: "exact", bindingAvailability: "unavailable" }), remoteOnline()),
        { currentConversation: "available", remoteControl },
      );
      expect(r.overall).toBe("needs_authorization");
      expect(r.nextAction).toBe("resume_authorization");
      expect(r.blockers.some((blocker) => blocker.code.startsWith("remote_request_scope_"))).toBe(true);
    }
  });

  it("exact unavailable + Remote offline stays blocked", () => {
    const r = resolveWorkflowReadiness(
      input(desktop({ currentTarget: "exact", bindingAvailability: "unavailable" }), remoteOffline()),
      { currentConversation: "available", remoteControl: "current" },
    );
    expect(r.overall).toBe("blocked");
    expect(r.nextAction).toBe("stop_unknown");
    expect(r.blockers).toContainEqual({ code: "desktop_delivery_unavailable" });
  });

  it("Remote-ready and saved_binding routes preserve their existing conversation strategy", () => {
    const remote = resolveWorkflowReadiness(
      input(desktop({ configured: false, enabled: false }), remoteOnline()),
      { currentConversation: "unavailable", remoteControl: "current" },
    );
    expect(remote.nextAction).toBe("open_project_chat");

    const saved = resolveWorkflowReadiness(
      input(desktop({ configured: false, enabled: false }), remoteOffline()),
      { desktopRoute: "saved_binding", currentConversation: "unavailable" },
    );
    expect(saved.nextAction).toBe("open_project_chat");
  });

  it("MCP saved_binding busy → busy/wait_current_task", () => {
    const r = resolveWorkflowReadiness(
      input(desktop({ bindingAvailability: "busy" })),
      { desktopRoute: "saved_binding", currentConversation: "available" },
    );
    expect(r.overall).toBe("busy");
    expect(r.nextAction).toBe("wait_current_task");
  });

  it("MCP saved_binding unknown → blocked/stop_unknown", () => {
    const r = resolveWorkflowReadiness(
      input(desktop({ bindingAvailability: "unknown" })),
      { desktopRoute: "saved_binding", currentConversation: "available" },
    );
    expect(r.overall).toBe("blocked");
    expect(r.nextAction).toBe("stop_unknown");
  });

  it("MCP saved_binding unavailable + remote ready + scopes current → ready_remote fallback", () => {
    const r = resolveWorkflowReadiness(
      input(desktop({ bindingAvailability: "unavailable" }), remoteOnline()),
      { desktopRoute: "saved_binding", currentConversation: "available", remoteControl: "current" },
    );
    expect(r.overall).toBe("ready_remote");
    expect(r.nextAction).toBe("use_remote");
  });

  it("MCP saved_binding unavailable + remote ready without scopes → needs_authorization", () => {
    const r = resolveWorkflowReadiness(
      input(desktop({ bindingAvailability: "unavailable" }), remoteOnline()),
      { desktopRoute: "saved_binding", currentConversation: "available", remoteControl: "none" },
    );
    expect(r.overall).toBe("needs_authorization");
  });

  it("MCP saved_binding unavailable + remote offline → blocked", () => {
    const r = resolveWorkflowReadiness(
      input(desktop({ bindingAvailability: "unavailable" }), remoteOffline()),
      { desktopRoute: "saved_binding", currentConversation: "available" },
    );
    expect(r.overall).toBe("blocked");
  });

  it("unresolved delivery still blocks highest priority on saved_binding route", () => {
    const r = resolveWorkflowReadiness(
      input(desktop({ unresolvedDelivery: true })),
      { desktopRoute: "saved_binding", currentConversation: "available" },
    );
    expect(r.overall).toBe("blocked");
    expect(r.nextAction).toBe("resolve_unconfirmed_delivery");
  });

  it("configured=false / enabled=false on saved_binding still needs_desktop_bind when no remote", () => {
    const unconfigured = resolveWorkflowReadiness(
      input(desktop({ configured: false, enabled: false, bindingAvailability: "unavailable" })),
      { desktopRoute: "saved_binding", currentConversation: "available" },
    );
    expect(unconfigured.overall).toBe("needs_desktop_bind");
    expect(unconfigured.nextAction).toBe("bind_current");

    const disabled = resolveWorkflowReadiness(
      input(desktop({ configured: true, enabled: false, bindingAvailability: "unavailable" })),
      { desktopRoute: "saved_binding", currentConversation: "available" },
    );
    expect(disabled.overall).toBe("needs_desktop_bind");
  });

  it("currentTarget=different does not affect MCP saved_binding; still affects local current_context", () => {
    const differentAvailable = desktop({ currentTarget: "different", bindingAvailability: "available" });
    const mcp = resolveWorkflowReadiness(
      input(differentAvailable),
      { desktopRoute: "saved_binding", currentConversation: "available" },
    );
    expect(mcp.overall).toBe("ready_local");

    const cli = resolveWorkflowReadiness(
      input(differentAvailable),
      { currentConversation: "available" },
    );
    expect(cli.overall).toBe("needs_desktop_bind");
  });
});

describe("G1a resolver + human (kept + review)", () => {
  it("authorization unknown → blocked; missing → needs_authorization; desktopCompatibility none → needs_authorization", () => {
    expect(resolveWorkflowReadiness(baseInput({
      connection: { ...baseInput().connection, authorization: "unknown" },
    })).overall).toBe("blocked");
    expect(resolveWorkflowReadiness(baseInput({
      connection: { ...baseInput().connection, authorization: "missing" },
    })).overall).toBe("needs_authorization");
    expect(resolveWorkflowReadiness(baseInput({
      connection: { ...baseInput().connection, desktopCompatibility: "none" },
    })).overall).toBe("needs_authorization");
  });

  it("Bridge stopped + unreadable admin facts → needs_connection, not blocked", () => {
    const r = resolveWorkflowReadiness(baseInput({
      connection: {
        running: "stopped",
        runtimeUpgrade: "unknown",
        authorization: "unknown",
        connectorContract: "unknown",
        desktopCompatibility: "unknown",
      },
    }));
    expect(r.overall).toBe("needs_connection");
    expect(r.nextAction).toBe("repair_connection");
  });

  it("Bridge unknown → blocked / stop_unknown (not stopped)", () => {
    const r = resolveWorkflowReadiness(baseInput({
      connection: {
        running: "unknown",
        runtimeUpgrade: "unknown",
        authorization: "unknown",
        connectorContract: "unknown",
        desktopCompatibility: "unknown",
      },
    }));
    expect(r.overall).toBe("blocked");
    expect(r.nextAction).toBe("stop_unknown");
  });

  it("exact + available → ready_local/reuse", () => {
    const r = resolveWorkflowReadiness(baseInput());
    expect(r.overall).toBe("ready_local");
    expect(r.nextAction).toBe("reuse");
  });

  it("exact + busy → busy / wait_current_task", () => {
    const r = resolveWorkflowReadiness(baseInput({
      desktop: { ...baseInput().desktop, bindingAvailability: "busy" },
    }));
    expect(r.overall).toBe("busy");
  });

  it("exact + unknown → blocked / stop_unknown (not soft ready_local)", () => {
    const r = resolveWorkflowReadiness(baseInput({
      desktop: { ...baseInput().desktop, bindingAvailability: "unknown" },
    }));
    expect(r.overall).toBe("blocked");
    expect(r.nextAction).toBe("stop_unknown");
    const human = formatWorkflowReadinessHuman(r);
    expect(human).not.toContain("Ready.");
    expect(human).not.toContain("ready_local");
  });

  it("exact + unavailable + Remote disabled → blocked", () => {
    const r = resolveWorkflowReadiness(baseInput({
      desktop: { ...baseInput().desktop, bindingAvailability: "unavailable" },
      remote: { enabled: false, controller: "offline", activeWork: false, needsReconciliation: false },
    }));
    expect(r.overall).toBe("blocked");
  });

  it("exact + unavailable + Remote online idle → ready_remote / use_remote", () => {
    const r = resolveWorkflowReadiness(baseInput({
      desktop: { ...baseInput().desktop, bindingAvailability: "unavailable" },
      remote: { enabled: true, controller: "online", activeWork: false, needsReconciliation: false },
    }));
    expect(r.overall).toBe("ready_remote");
    expect(r.nextAction).toBe("use_remote");
  });
});

describe("G1a Desktop error projection (collector + structured codes)", () => {
  function mockIdentity(result: unknown): void {
    vi.spyOn(desktopIpc, "currentIdentity").mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result as never;
    });
  }
  function mockInspect(result: unknown): void {
    vi.spyOn(desktopIpc, "inspect").mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result as never;
    });
  }

  it("currentIdentity DESKTOP_CURRENT_CONTEXT_INVALID → currentTarget unavailable", async () => {
    const workspace = new Workspace(root);
    writeDesktopFixture(workspace.id);
    mockIdentity(new DesktopError("DESKTOP_CURRENT_CONTEXT_INVALID", "x"));
    mockInspect(new DesktopError("DESKTOP_STATE_UNAVAILABLE", "x"));
    const input = await collectWorkflowReadinessInput(workspace);
    expect(input.desktop.currentTarget).toBe("unavailable");
  });

  it("inspect DESKTOP_BUSY / APPROVAL_PENDING → busy", async () => {
    const workspace = new Workspace(root);
    writeDesktopFixture(workspace.id);
    mockIdentity({ threadId: BINDING_THREAD, hostId: "local", projectId: BINDING_PROJECT });
    mockInspect(new DesktopError("DESKTOP_BUSY", "x"));
    const busy = await collectWorkflowReadinessInput(workspace);
    expect(busy.desktop.bindingAvailability).toBe("busy");

    mockInspect(new DesktopError("DESKTOP_APPROVAL_PENDING", "x"));
    const pending = await collectWorkflowReadinessInput(workspace);
    expect(pending.desktop.bindingAvailability).toBe("busy");
  });

  it("inspect DESKTOP_STATE_UNAVAILABLE → unknown", async () => {
    const workspace = new Workspace(root);
    writeDesktopFixture(workspace.id);
    mockIdentity({ threadId: BINDING_THREAD, hostId: "local", projectId: BINDING_PROJECT });
    mockInspect(new DesktopError("DESKTOP_STATE_UNAVAILABLE", "x"));
    const input = await collectWorkflowReadinessInput(workspace);
    expect(input.desktop.bindingAvailability).toBe("unknown");
  });

  it("identity exact then inspect DESKTOP_NO_OWNER → currentTarget unknown, not ready_local", async () => {
    const workspace = new Workspace(root);
    writeDesktopFixture(workspace.id);
    mockIdentity({ threadId: BINDING_THREAD, hostId: "local", projectId: BINDING_PROJECT });
    mockInspect(new DesktopError("DESKTOP_NO_OWNER", "x"));
    const input = await collectWorkflowReadinessInput(workspace);
    expect(input.desktop.currentTarget).toBe("unknown");
    const r = resolveWorkflowReadiness({
      ...input,
      connection: {
        running: "running",
        runtimeUpgrade: "current",
        authorization: "authorized",
        connectorContract: "current",
        desktopCompatibility: "current",
      },
      conversation: { mode: "project", projectReady: true, chatKnown: true, chatBinding: "same_thread", checkpoint: "none", sessionCorrupt: false },
    });
    expect(r.overall).toBe("blocked");
  });

  it("arbitrary Error('busy secret...') is NOT classified busy", async () => {
    const workspace = new Workspace(root);
    writeDesktopFixture(workspace.id);
    mockIdentity({ threadId: BINDING_THREAD, hostId: "local", projectId: BINDING_PROJECT });
    mockInspect(new Error("busy secret token C:\\private\\pipe"));
    const input = await collectWorkflowReadinessInput(workspace);
    expect(input.desktop.bindingAvailability).toBe("unknown");
  });
});

describe("G1a zero-write session/desktop/remote", () => {
  it("collect twice does not mutate session, desktop, or remote bytes", async () => {
    const workspace = new Workspace(root);
    saveProjectChat(workspace.id, THREAD_A, CHAT_A);
    writeDesktopFixture(workspace.id);
    writeRemoteFixture(workspace.id);
    mockIdentityOk();
    mockInspectOk();
    const sessionPath = `${process.env.C2C_STATE_DIR}/sessions/${workspace.id}.json`;
    const desktopPath = desktopFile(workspace.id);
    const remotePath = remoteFile(workspace.id);
    const before = {
      s: fs.readFileSync(sessionPath, "utf8"),
      d: fs.readFileSync(desktopPath, "utf8"),
      r: fs.readFileSync(remotePath, "utf8"),
    };
    await collectWorkflowReadinessInput(workspace);
    await collectWorkflowReadinessInput(workspace);
    expect(fs.readFileSync(sessionPath, "utf8")).toBe(before.s);
    expect(fs.readFileSync(desktopPath, "utf8")).toBe(before.d);
    expect(fs.readFileSync(remotePath, "utf8")).toBe(before.r);
  });

  function mockIdentityOk(): void {
    vi.spyOn(desktopIpc, "currentIdentity").mockResolvedValue({
      threadId: BINDING_THREAD,
      hostId: "local",
      projectId: BINDING_PROJECT,
      title: "t",
    } as never);
  }
  function mockInspectOk(): void {
    vi.spyOn(desktopIpc, "inspect").mockResolvedValue({
      threadId: BINDING_THREAD,
      hostId: "local",
      projectId: BINDING_PROJECT,
      title: "t",
    } as never);
  }
});
