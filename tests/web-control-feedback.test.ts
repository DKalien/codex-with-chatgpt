import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendExecutionRecord,
  tryResolveTerminalExecutionRecord,
  type ExecutionRecord,
} from "../src/execution/records.js";
import {
  completeControlCommand,
  controlBootPrompt,
  disableWebControl,
  enableWebControl,
  listPendingControlFeedback,
  markBootSent,
  markControlFeedbackSent,
  receiveControl,
  recoverControlCommand,
  startControlCommand,
  webControlStatus,
  type WebControlState,
} from "../src/session/web-control.js";
import {
  readSession,
  sessionFile,
  writeSession,
  type SavedSession,
} from "../src/session/state.js";
import { cleanup, makeTmpDir } from "./helpers.js";
import { PRODUCTION_FEEDBACK_INSTRUCTION } from "../src/feedback/message.js";

const WORKSPACE_ID = "phase-a-feedback";
const CHAT_URL = "https://chatgpt.com/c/phase-a-chat";
const OWNER = "codex-owner-a";
const NOW = Date.parse("2026-09-13T12:00:00.000Z");

let stateDir: string;

function baseSession(extra: Partial<SavedSession> = {}): SavedSession {
  return { url: CHAT_URL, savedAt: new Date(NOW).toISOString(), ...extra };
}

function state(): WebControlState {
  return readSession(WORKSPACE_ID)!.webControl!;
}

function commandText(commandId: string, controlSessionId: string, workspaceId = WORKSPACE_ID) {
  return [
    "[C2C_CONTROL]",
    "STATE: COMMAND",
    `CONTROL_SESSION_ID: ${controlSessionId}`,
    `WORKSPACE_ID: ${workspaceId}`,
    `COMMAND_ID: ${commandId}`,
    "KIND: TASK",
    "",
    "GOAL:",
    "完成原用户任务",
    "",
    "INSTRUCTIONS:",
    "按本地计划执行并验证",
    "",
    "SUCCESS_CRITERIA:",
    "原用户任务在范围内完成",
  ].join("\n");
}

function userEnvelope(text: string, options: { messageId?: string; latestUserMessageId?: string } = {}) {
  const latestUserMessageId = options.latestUserMessageId ?? "user-message-1";
  return {
    source: "chatgpt-assistant",
    conversationUrl: CHAT_URL,
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

function bootAndAccept(now = NOW) {
  const enabled = enableWebControl(WORKSPACE_ID, {
    localUser: true,
    codexSessionId: OWNER,
    conversationUrl: CHAT_URL,
  }, now);
  markBootSent(WORKSPACE_ID, OWNER, "boot-message-1", now + 1);
  const result = receiveControl(
    WORKSPACE_ID,
    OWNER,
    userEnvelope(commandText("command-1", enabled.controlSessionId)),
    now + 2,
  );
  expect(result.outcome).toBe("accepted");
  return enabled.controlSessionId;
}

function recordCurrentCommand(commandId: string, overrides: Partial<ExecutionRecord> = {}, now = NOW): void {
  const active = state().activeCommand!;
  appendExecutionRecord(WORKSPACE_ID, {
    taskId: active.taskId,
    iteration: active.iteration,
    changedFiles: ["src/example.ts"],
    tests: "1 passed",
    exitStatus: "ok",
    timestamp: new Date(now).toISOString(),
    controlSessionId: state().controlSessionId,
    commandId,
    outputAvailable: false,
    ...overrides,
  });
}

beforeEach(() => {
  stateDir = makeTmpDir("phase-a-feedback");
  process.env.C2C_STATE_DIR = stateDir;
  writeSession(WORKSPACE_ID, baseSession());
});

afterEach(() => {
  cleanup(stateDir);
  delete process.env.C2C_STATE_DIR;
});

describe("tryResolveTerminalExecutionRecord 分类", () => {
  const expected = {
    controlSessionId: "control-session",
    commandId: "command-id",
    taskId: "task-id",
    iteration: 2,
  };

  function record(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
    return {
      ...expected,
      changedFiles: [],
      tests: "1 passed",
      exitStatus: "ok",
      timestamp: "2026-09-13T00:00:00.000Z",
      ...overrides,
    };
  }

  it("missing / not_terminal / terminal 可区分，且不靠文案", () => {
    expect(tryResolveTerminalExecutionRecord(WORKSPACE_ID, expected)).toEqual({ status: "missing" });
    appendExecutionRecord(WORKSPACE_ID, record({ exitStatus: "accepted" }));
    expect(tryResolveTerminalExecutionRecord(WORKSPACE_ID, expected)).toEqual({ status: "not_terminal" });
    appendExecutionRecord(WORKSPACE_ID, record());
    expect(() => tryResolveTerminalExecutionRecord(WORKSPACE_ID, expected)).toThrow(/重复或冲突/);
  });

  it("唯一 ok 终态返回 terminal", () => {
    appendExecutionRecord(WORKSPACE_ID, record({ exitStatus: "failed" }));
    expect(tryResolveTerminalExecutionRecord(WORKSPACE_ID, expected)).toMatchObject({
      status: "terminal",
      record: { exitStatus: "failed" },
    });
  });
});

describe("status 路径自动 reconciliation", () => {
  it("executing + exact terminal 自动变 completed + pending", () => {
    bootAndAccept();
    startControlCommand(WORKSPACE_ID, OWNER, "command-1", NOW + 3);
    expect(state().status).toBe("executing");
    recordCurrentCommand("command-1", {}, NOW + 4);

    const reconciled = webControlStatus(WORKSPACE_ID, NOW + 5)!;
    expect(reconciled.status).toBe("review");
    expect(reconciled.seenCommands[0]).toMatchObject({
      commandId: "command-1",
      status: "completed",
      feedbackStatus: "pending",
    });
    expect(readSession(WORKSPACE_ID)!.webControl!.seenCommands[0].feedbackStatus).toBe("pending");
  });

  it.each(["ok", "failed", "blocked"] as const)("terminal %s 都能推进", (exitStatus) => {
    bootAndAccept();
    startControlCommand(WORKSPACE_ID, OWNER, "command-1", NOW + 3);
    recordCurrentCommand("command-1", { exitStatus }, NOW + 4);
    expect(webControlStatus(WORKSPACE_ID, NOW + 5)!.seenCommands[0]).toMatchObject({
      status: "completed",
      feedbackStatus: "pending",
    });
  });

  it("没有 terminal 时状态完全不变", () => {
    bootAndAccept();
    startControlCommand(WORKSPACE_ID, OWNER, "command-1", NOW + 3);
    const before = JSON.stringify(state());
    expect(webControlStatus(WORKSPACE_ID, NOW + 4)!.status).toBe("executing");
    expect(JSON.stringify(state())).toBe(before);
  });

  it("accepted 不是 terminal，status 不推进 complete", () => {
    const sessionId = bootAndAccept();
    expect(sessionId).toBeTruthy();
    recordCurrentCommand("command-1", { exitStatus: "accepted" }, NOW + 3);
    const checked = webControlStatus(WORKSPACE_ID, NOW + 4)!;
    expect(checked.seenCommands[0].status).toBe("accepted");
    expect(checked.seenCommands[0].feedbackStatus).toBeUndefined();
  });

  it("duplicate / corrupt / wrong identity 在 status 路径 fail closed", () => {
    bootAndAccept();
    startControlCommand(WORKSPACE_ID, OWNER, "command-1", NOW + 3);
    recordCurrentCommand("command-1", {}, NOW + 4);
    const active = state().activeCommand!;
    appendExecutionRecord(WORKSPACE_ID, {
      taskId: active.taskId,
      iteration: active.iteration,
      changedFiles: [],
      tests: "dup",
      exitStatus: "ok",
      timestamp: new Date(NOW + 5).toISOString(),
      controlSessionId: state().controlSessionId,
      commandId: "command-1",
    });
    expect(() => webControlStatus(WORKSPACE_ID, NOW + 6)).toThrow(/重复或冲突/);
  });

  it("corrupt JSONL 在 status 路径 fail closed 且不改会话", () => {
    const corruptWs = "phase-a-corrupt";
    writeSession(corruptWs, baseSession());
    enableWebControl(corruptWs, {
      localUser: true,
      codexSessionId: OWNER,
      conversationUrl: CHAT_URL,
    }, NOW);
    markBootSent(corruptWs, OWNER, "boot-corrupt", NOW + 1);
    const enabled = readSession(corruptWs)!.webControl!;
    receiveControl(corruptWs, OWNER, userEnvelope(commandText("cmd-corrupt", enabled.controlSessionId, corruptWs), {
      messageId: "assistant-corrupt",
      latestUserMessageId: "user-corrupt",
    }), NOW + 2);
    startControlCommand(corruptWs, OWNER, "cmd-corrupt", NOW + 3);
    const file = path.join(stateDir, "executions", `${corruptWs}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{broken}\n", "utf8");
    const before = fs.readFileSync(sessionFile(corruptWs), "utf8");
    expect(() => webControlStatus(corruptWs, NOW + 4)).toThrow(/损坏|不完整|schema/);
    expect(fs.readFileSync(sessionFile(corruptWs), "utf8")).toBe(before);
  });

  it("wrong identity 在 status 路径 fail closed", () => {
    const wrongWs = "phase-a-wrong-identity";
    writeSession(wrongWs, baseSession());
    enableWebControl(wrongWs, {
      localUser: true,
      codexSessionId: OWNER,
      conversationUrl: CHAT_URL,
    }, NOW);
    markBootSent(wrongWs, OWNER, "boot-wrong", NOW + 1);
    const enabled = readSession(wrongWs)!.webControl!;
    receiveControl(wrongWs, OWNER, userEnvelope(commandText("cmd-wrong", enabled.controlSessionId, wrongWs), {
      messageId: "assistant-wrong",
      latestUserMessageId: "user-wrong",
    }), NOW + 2);
    startControlCommand(wrongWs, OWNER, "cmd-wrong", NOW + 3);
    appendExecutionRecord(wrongWs, {
      taskId: "other-task",
      iteration: 0,
      changedFiles: [],
      tests: "x",
      exitStatus: "ok",
      timestamp: new Date(NOW + 4).toISOString(),
      controlSessionId: enabled.controlSessionId,
      commandId: "cmd-wrong",
    });
    expect(() => webControlStatus(wrongWs, NOW + 5)).toThrow(/身份不匹配/);
  });

  it("disabled/expired 中 terminal reconciliation 不重新 enable", () => {
    bootAndAccept();
    startControlCommand(WORKSPACE_ID, OWNER, "command-1", NOW + 3);
    disableWebControl(WORKSPACE_ID, true, NOW + 4);
    recordCurrentCommand("command-1", {}, NOW + 5);
    const after = webControlStatus(WORKSPACE_ID, NOW + 6)!;
    expect(after.enabled).toBe(false);
    expect(after.status).toBe("disabled");
    expect(after.seenCommands[0]).toMatchObject({ status: "completed", feedbackStatus: "pending" });
  });

  it("completed/pending 不允许重新 start", () => {
    bootAndAccept();
    startControlCommand(WORKSPACE_ID, OWNER, "command-1", NOW + 3);
    recordCurrentCommand("command-1", {}, NOW + 4);
    webControlStatus(WORKSPACE_ID, NOW + 5);
    expect(() => startControlCommand(WORKSPACE_ID, OWNER, "command-1", NOW + 6)).toThrow(/已开始或已结案/);
  });
});

describe("feedback pending/sent 状态机", () => {
  function toPending(now = NOW): string {
    bootAndAccept();
    startControlCommand(WORKSPACE_ID, OWNER, "command-1", now + 3);
    recordCurrentCommand("command-1", {}, now + 4);
    webControlStatus(WORKSPACE_ID, now + 5);
    return state().controlSessionId;
  }

  it("pending recover 多次得到相同 feedback，不重执行", () => {
    toPending();
    const first = recoverControlCommand(WORKSPACE_ID, OWNER, "command-1", NOW + 6);
    const second = recoverControlCommand(WORKSPACE_ID, OWNER, "command-1", NOW + 7);
    expect(first.feedback).toContain("STATE: EXECUTED");
    expect(first.feedback).toContain(`INSTRUCTION: ${PRODUCTION_FEEDBACK_INSTRUCTION}`);
    expect(second.feedback).toBe(first.feedback);
    expect(second.feedbackMessageId).toBeUndefined();
    expect(listPendingControlFeedback(WORKSPACE_ID, NOW + 8)).toHaveLength(1);
  });

  it("pending -> sent，同 messageId 幂等，不同 messageId fail closed", () => {
    toPending();
    markControlFeedbackSent(WORKSPACE_ID, OWNER, "command-1", "feedback-message-1", NOW + 6);
    expect(state().seenCommands[0]).toMatchObject({
      feedbackStatus: "sent",
      feedbackMessageId: "feedback-message-1",
    });
    expect(listPendingControlFeedback(WORKSPACE_ID, NOW + 7)).toHaveLength(0);
    expect(() => markControlFeedbackSent(WORKSPACE_ID, OWNER, "command-1", "feedback-message-2", NOW + 8))
      .toThrow(/不能重复/);
    expect(state().seenCommands[0].feedbackStatus).toBe("sent");
  });

  it("发送失败保留 pending，不丢 terminal", () => {
    toPending();
    // 模拟发送失败：不调用 feedback-sent，status/recover 仍能拿到同一终态
    const recovered = recoverControlCommand(WORKSPACE_ID, OWNER, "command-1", NOW + 6);
    expect(recovered.feedback).toContain("COMMAND_ID: command-1");
    expect(state().seenCommands[0]).toMatchObject({ status: "completed", feedbackStatus: "pending" });
    expect(listPendingControlFeedback(WORKSPACE_ID, NOW + 7)[0]!.feedback).toBe(recovered.feedback);
  });

  it("legacy feedbackMessageId without feedbackStatus 可读，同 ID 确认后规范化为 sent", () => {
    toPending();
    const file = sessionFile(WORKSPACE_ID);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    saved.webControl.seenCommands[0].feedbackMessageId = "legacy-feedback";
    delete saved.webControl.seenCommands[0].feedbackStatus;
    saved.webControl.generatedMessageIds.push("legacy-feedback");
    fs.writeFileSync(file, JSON.stringify(saved, null, 2));
    expect(webControlStatus(WORKSPACE_ID, NOW + 6)!.seenCommands[0]).toMatchObject({
      feedbackMessageId: "legacy-feedback",
    });
    markControlFeedbackSent(WORKSPACE_ID, OWNER, "command-1", "legacy-feedback", NOW + 7);
    expect(state().seenCommands[0]).toMatchObject({
      feedbackMessageId: "legacy-feedback",
      feedbackStatus: "sent",
    });
  });

  it("pending + feedbackMessageId 与 sent without messageId 的 schema 拒绝", () => {
    toPending();
    const file = sessionFile(WORKSPACE_ID);
    const base = fs.readFileSync(file, "utf8");
    const badPending = JSON.parse(base);
    badPending.webControl.seenCommands[0].feedbackMessageId = "should-not-with-pending";
    badPending.webControl.generatedMessageIds.push("should-not-with-pending");
    fs.writeFileSync(file, JSON.stringify(badPending, null, 2));
    expect(() => webControlStatus(WORKSPACE_ID, NOW + 6)).toThrow(/损坏|状态不一致/);

    fs.writeFileSync(file, base);
    const badSent = JSON.parse(fs.readFileSync(file, "utf8"));
    badSent.webControl.seenCommands[0].feedbackStatus = "sent";
    delete badSent.webControl.seenCommands[0].feedbackMessageId;
    fs.writeFileSync(file, JSON.stringify(badSent, null, 2));
    expect(() => webControlStatus(WORKSPACE_ID, NOW + 7)).toThrow(/损坏|状态不一致/);
  });

  it("bootPrompt 仍是本地模板，不因 pending 改变授权语义", () => {
    const enabled = enableWebControl(WORKSPACE_ID, {
      localUser: true,
      codexSessionId: OWNER,
      conversationUrl: CHAT_URL,
    }, NOW);
    expect(controlBootPrompt(enabled)).toContain("自动反馈");
  });
});
