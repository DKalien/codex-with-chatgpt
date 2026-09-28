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
import {
  PROJECT,
  CHAT_A,
  CHAT_B,
  THREAD_A,
  THREAD_B,
  WS,
  BINDING_THREAD,
  BINDING_PROJECT,
  BINDING_ID,
  root,
  baseInput,
  saveProjectChat,
  writeDesktopFixture,
  writeRemoteFixture,
} from "./workflow-readiness-fixtures.js";

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
