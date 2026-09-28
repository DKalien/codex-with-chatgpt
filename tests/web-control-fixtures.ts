import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendExecutionRecord,
  type ExecutionRecord,
} from "../src/execution/records.js";
import {
  controlBootPrompt,
  disableWebControl,
  enableWebControl,
  markBootSent,
  markControlFeedbackSent,
  completeControlCommand,
  closeControlTask,
  receiveControl,
  startControlCommand,
  rejectControlCommand,
  webControlStatus,
} from "../src/session/web-control.js";
import {
  mergeSession,
  clearChatPointer,
  readSession,
  sessionFile,
  writeSession,
  type SavedSession,
} from "../src/session/state.js";
import { cleanup, makeTmpDir } from "./helpers.js";

export const WORKSPACE_ID = "web-control-workspace";
export const CHAT_URL = "https://chatgpt.com/c/web-control-chat";
export const OWNER = "codex-task-owner";
export const OTHER_OWNER = "other-codex-task";
export const NOW = Date.parse("2026-09-10T10:00:00.000Z");

let stateDir: string;

export function baseSession(extra: Partial<SavedSession> = {}): SavedSession {
  return { url: CHAT_URL, savedAt: new Date(NOW).toISOString(), ...extra };
}

export function state() {
  return readSession(WORKSPACE_ID)?.webControl!;
}

export function commandText(commandId: string, controlSessionId: string, workspaceId = WORKSPACE_ID, goal = "完成原用户任务") {
  return [
    "[C2C_CONTROL]",
    "STATE: COMMAND",
    `CONTROL_SESSION_ID: ${controlSessionId}`,
    `WORKSPACE_ID: ${workspaceId}`,
    `COMMAND_ID: ${commandId}`,
    "KIND: TASK",
    "",
    "GOAL:",
    goal,
    "",
    "INSTRUCTIONS:",
    "按本地计划执行并验证",
    "",
    "SUCCESS_CRITERIA:",
    "原用户任务在范围内完成",
  ].join("\n");
}

export function doneText(commandId: string, controlSessionId: string, workspaceId = WORKSPACE_ID) {
  return [
    "[C2C_CONTROL]",
    "STATE: DONE",
    `CONTROL_SESSION_ID: ${controlSessionId}`,
    `WORKSPACE_ID: ${workspaceId}`,
    `COMMAND_ID: ${commandId}`,
  ].join("\n");
}

export function userEnvelope(text: string, options: {
  messageId?: string;
  latestUserMessageId?: string;
  conversationUrl?: string;
  source?: string;
} = {}) {
  const latestUserMessageId = options.latestUserMessageId ?? "user-message-1";
  return {
    source: options.source ?? "chatgpt-assistant",
    conversationUrl: options.conversationUrl ?? CHAT_URL,
    messageId: options.messageId ?? "assistant-message-1",
    latestUserMessageId,
    complete: true,
    text,
    authorization: {
      type: "user-delegation",
      userMessageId: latestUserMessageId,
      explicitDelegation: true,
    },
  };
}

export function reviewEnvelope(text: string, commandId: string, feedbackMessageId: string, options: {
  messageId?: string;
  conversationUrl?: string;
  withinOriginalScope?: boolean;
} = {}) {
  return {
    source: "chatgpt-assistant",
    conversationUrl: options.conversationUrl ?? CHAT_URL,
    messageId: options.messageId ?? "assistant-review-1",
    latestUserMessageId: feedbackMessageId,
    complete: true,
    text,
    authorization: {
      type: "review-followup",
      commandId,
      withinOriginalScope: options.withinOriginalScope ?? true,
    },
  };
}

export function enable(now = NOW, idleTimeoutMinutes = 30) {
  return enableWebControl(WORKSPACE_ID, {
    localUser: true,
    codexSessionId: OWNER,
    conversationUrl: CHAT_URL,
    idleTimeoutMinutes,
  }, now);
}

export function boot(now = NOW) {
  const enabled = enable(now);
  return markBootSent(WORKSPACE_ID, OWNER, "boot-message-1", now + 1);
}

export function acceptFirstCommand(now = NOW) {
  const ready = boot(now);
  const result = receiveControl(
    WORKSPACE_ID,
    OWNER,
    userEnvelope(commandText("command-1", ready.controlSessionId)),
    now + 2,
  );
  expect(result.outcome).toBe("accepted");
  return ready.controlSessionId;
}

export function recordCurrentCommand(commandId: string, now = NOW): void {
  const active = state().activeCommand!;
  const record: ExecutionRecord = {
    taskId: active.taskId,
    iteration: active.iteration,
    changedFiles: ["src/example.ts"],
    tests: "1 passed",
    exitStatus: "ok",
    timestamp: new Date(now).toISOString(),
    controlSessionId: state().controlSessionId,
    commandId,
    outputAvailable: false,
  };
  appendExecutionRecord(WORKSPACE_ID, record);
}

export function completeFirstCommand(now = NOW): void {
  startControlCommand(WORKSPACE_ID, OWNER, "command-1", now + 3);
  recordCurrentCommand("command-1", now + 4);
  completeControlCommand(WORKSPACE_ID, OWNER, "command-1", now + 5);
  markControlFeedbackSent(WORKSPACE_ID, OWNER, "command-1", "feedback-message-1", now + 6);
}

beforeEach(() => {
  stateDir = makeTmpDir("web-control");
  process.env.C2C_STATE_DIR = stateDir;
  writeSession(WORKSPACE_ID, baseSession());
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup(stateDir);
  delete process.env.C2C_STATE_DIR;
});
