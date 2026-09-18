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
    // Safety contract: chatKnown=false never ready_local; with healthy connection → needs_conversation.
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
    expect(synthetic.overall).toBe("needs_conversation");
    expect(synthetic.nextAction).toBe("open_project_chat");
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
