import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  mergeSession,
  projectChatOwnerFingerprint,
  readSession,
  resolveThreadConversation,
  writeSession,
} from "../src/session/state.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const PROJECT = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";
const CHAT_A = "https://chatgpt.com/c/aaaaaaaa-1111-4111-8111-111111111111";
const CHAT_B = "https://chatgpt.com/c/bbbbbbbb-2222-4222-8222-222222222222";
const THREAD_A = "11111111-1111-7111-8111-111111111111";
const THREAD_B = "22222222-2222-7222-8222-222222222222";

let stateDir: string;
let previousStateDir: string | undefined;
let root: string;

beforeEach(() => {
  previousStateDir = process.env.C2C_STATE_DIR;
  stateDir = isolateStateDir();
  root = makeTmpDir("thread-projection");
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
  delete process.env.CODEX_THREAD_ID;
  delete process.env.CODEX_SESSION_ID;
  cleanup(root);
  cleanup(stateDir);
});

function saveThreadChat(workspaceId: string, threadId: string, url: string): void {
  process.env.CODEX_THREAD_ID = threadId;
  delete process.env.CODEX_SESSION_ID;
  const fp = projectChatOwnerFingerprint(workspaceId, threadId);
  writeSession(workspaceId, mergeSession(readSession(workspaceId), {
    conversationMode: "project",
    projectUrl: PROJECT,
    url,
    chatOwnerFingerprint: fp,
  }));
}

describe("resolveThreadConversation", () => {
  it("Project A→ChatA / B→ChatB independently; no raw threadId in projection", () => {
    const workspace = new Workspace(root);
    saveThreadChat(workspace.id, THREAD_A, CHAT_A);
    saveThreadChat(workspace.id, THREAD_B, CHAT_B);
    const session = readSession(workspace.id);

    process.env.CODEX_THREAD_ID = THREAD_A;
    const projA = resolveThreadConversation(session, workspace.id);
    expect(projA.mode).toBe("project");
    expect(projA.projectReady).toBe(true);
    expect(projA.projectUrl).toBe(PROJECT);
    expect(projA.chatBinding).toBe("same_thread");
    expect(projA.chatUrl).toBe(CHAT_A);
    expect(projA.reuseChat).toBe(true);
    const dumpA = JSON.stringify(projA);
    expect(dumpA).not.toContain("projectChats");
    expect(dumpA).not.toContain("ownerFingerprint");
    expect(dumpA).not.toContain(THREAD_A);

    process.env.CODEX_THREAD_ID = THREAD_B;
    const projB = resolveThreadConversation(session, workspace.id);
    expect(projB.chatUrl).toBe(CHAT_B);
    expect(projB.reuseChat).toBe(true);
  });

  it("other_thread / unowned / current_thread_unknown → chatUrl null, reuseChat false", () => {
    const workspace = new Workspace(root);
    saveThreadChat(workspace.id, THREAD_A, CHAT_A);
    const session = readSession(workspace.id);

    process.env.CODEX_THREAD_ID = THREAD_B;
    const other = resolveThreadConversation(session, workspace.id);
    expect(other.chatBinding).toBe("other_thread");
    expect(other.chatUrl).toBeNull();
    expect(other.reuseChat).toBe(false);

    writeSession(workspace.id, {
      savedAt: "2026-01-01T00:00:00.000Z",
      conversationMode: "project",
      projectUrl: PROJECT,
      url: CHAT_A,
    });
    process.env.CODEX_THREAD_ID = THREAD_A;
    const unowned = resolveThreadConversation(readSession(workspace.id), workspace.id);
    expect(unowned.chatBinding).toBe("unowned");
    expect(unowned.chatUrl).toBeNull();
    expect(unowned.reuseChat).toBe(false);

    delete process.env.CODEX_THREAD_ID;
    const unknown = resolveThreadConversation(session, workspace.id);
    expect(unknown.chatBinding).toBe("current_thread_unknown");
    expect(unknown.chatUrl).toBeNull();
    expect(unknown.reuseChat).toBe(false);
  });

  it("long-chat keeps conversation.chatUrl; invalid project map URL fails closed", () => {
    const workspace = new Workspace(root);
    writeSession(workspace.id, {
      savedAt: "2026-01-01T00:00:00.000Z",
      conversationMode: "long-chat",
      url: CHAT_B,
    });
    process.env.CODEX_THREAD_ID = THREAD_A;
    const longChat = resolveThreadConversation(readSession(workspace.id), workspace.id);
    expect(longChat.mode).toBe("long-chat");
    expect(longChat.chatUrl).toBe(CHAT_B);
    expect(longChat.reuseChat).toBe(true);
    expect(longChat.chatBinding).toBe("none");

    writeSession(workspace.id, mergeSession(null, {
      conversationMode: "project",
      projectUrl: PROJECT,
      url: "https://chatgpt.com/c/aaaaaaaa-1111-4111-8111-111111111111",
      chatOwnerFingerprint: projectChatOwnerFingerprint(workspace.id, THREAD_A),
    }));
    // Force corrupt map entry via raw write is blocked by strict readSession;
    // instead use invalid URL stored through a valid fingerprint map entry shape.
    // map entry URL that is not a ChatGPT conversation route:
    const fp = projectChatOwnerFingerprint(workspace.id, THREAD_A);
    const sessionPath = `${process.env.C2C_STATE_DIR}/sessions/${workspace.id}.json`;
    fs.writeFileSync(sessionPath, JSON.stringify({
      savedAt: "2026-01-01T00:00:00.000Z",
      conversationMode: "project",
      projectUrl: PROJECT,
      projectChats: [{ ownerFingerprint: fp, url: "https://example.com/not-chatgpt" }],
    }));
    process.env.CODEX_THREAD_ID = THREAD_A;
    const badUrl = resolveThreadConversation(readSession(workspace.id), workspace.id);
    expect(badUrl.chatBinding).toBe("same_thread");
    expect(badUrl.chatUrl).toBeNull();
    expect(badUrl.reuseChat).toBe(false);
  });

  it("rebind thread A keeps thread B mapping; projection updates only A", () => {
    const workspace = new Workspace(root);
    saveThreadChat(workspace.id, THREAD_A, CHAT_A);
    saveThreadChat(workspace.id, THREAD_B, CHAT_B);
    process.env.CODEX_THREAD_ID = THREAD_A;
    writeSession(workspace.id, mergeSession(readSession(workspace.id), {
      conversationMode: "project",
      projectUrl: PROJECT,
      url: "https://chatgpt.com/c/cccccccc-3333-4333-8333-333333333333",
      chatOwnerFingerprint: projectChatOwnerFingerprint(workspace.id, THREAD_A),
    }));
    const after = readSession(workspace.id)!;
    expect(after.projectChats?.length).toBe(2);
    process.env.CODEX_THREAD_ID = THREAD_A;
    expect(resolveThreadConversation(after, workspace.id).chatUrl)
      .toBe("https://chatgpt.com/c/cccccccc-3333-4333-8333-333333333333");
    process.env.CODEX_THREAD_ID = THREAD_B;
    expect(resolveThreadConversation(after, workspace.id).chatUrl).toBe(CHAT_B);
  });
});
