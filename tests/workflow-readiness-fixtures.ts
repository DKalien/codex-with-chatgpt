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

export const PROJECT = "https://chatgpt.com/g/g-p-6a94399430e08191860ab5364b7748b8/project";
export const CHAT_A = "https://chatgpt.com/c/aaaaaaaa-1111-4111-8111-111111111111";
export const CHAT_B = "https://chatgpt.com/c/bbbbbbbb-2222-4222-8222-222222222222";
export const THREAD_A = "11111111-1111-7111-8111-111111111111";
export const THREAD_B = "22222222-2222-7222-8222-222222222222";
export const WS = "workspaceg1amulti";
export const BINDING_THREAD = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const BINDING_PROJECT = "project_bind_test";
export const BINDING_ID = "33333333-3333-4333-8333-333333333333";
export const RUNTIME_FENCE = {
  desktopPid: 1001,
  desktopExe: "C:\\Program Files\\ChatGPT\\ChatGPT.exe",
  desktopCreation: "1000001",
  appServerPid: 1002,
  appServerExe: "C:\\Program Files\\ChatGPT\\codex.exe",
  appServerCreation: "1000002",
};

let stateDir: string;
let previousStateDir: string | undefined;
export let root: string;

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

export function baseInput(overrides: Partial<WorkflowReadinessInput> = {}): WorkflowReadinessInput {
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
export function saveProjectChat(workspaceId: string, threadId: string, url: string): void {
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

export function writeDesktopFixture(workspaceId: string): void {
  const file = desktopFile(workspaceId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    workspaceId,
    workspaceRoot: root,
    enabled: true,
    runtimeFence: RUNTIME_FENCE,
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

export function writeRemoteFixture(workspaceId: string): void {
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
