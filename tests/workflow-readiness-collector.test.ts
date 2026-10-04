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
  RUNTIME_FENCE,
  root,
  baseInput,
  saveProjectChat,
  writeDesktopFixture,
  writeRemoteFixture,
} from "./workflow-readiness-fixtures.js";

describe("G1a Desktop error projection (collector + structured codes)", () => {
  function mockIdentity(result: unknown): void {
    vi.spyOn(desktopIpc, "currentIdentity").mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return { ...(result as Record<string, unknown>), runtimeFence: RUNTIME_FENCE } as never;
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
      runtimeFence: RUNTIME_FENCE,
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
