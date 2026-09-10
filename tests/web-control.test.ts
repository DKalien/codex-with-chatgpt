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

const WORKSPACE_ID = "web-control-workspace";
const CHAT_URL = "https://chatgpt.com/c/web-control-chat";
const OWNER = "codex-task-owner";
const OTHER_OWNER = "other-codex-task";
const NOW = Date.parse("2026-09-10T10:00:00.000Z");

let stateDir: string;

function baseSession(extra: Partial<SavedSession> = {}): SavedSession {
  return { url: CHAT_URL, savedAt: new Date(NOW).toISOString(), ...extra };
}

function state() {
  return readSession(WORKSPACE_ID)?.webControl!;
}

function commandText(commandId: string, controlSessionId: string, workspaceId = WORKSPACE_ID, goal = "完成原用户任务") {
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

function doneText(commandId: string, controlSessionId: string, workspaceId = WORKSPACE_ID) {
  return [
    "[C2C_CONTROL]",
    "STATE: DONE",
    `CONTROL_SESSION_ID: ${controlSessionId}`,
    `WORKSPACE_ID: ${workspaceId}`,
    `COMMAND_ID: ${commandId}`,
  ].join("\n");
}

function userEnvelope(text: string, options: {
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

function reviewEnvelope(text: string, commandId: string, feedbackMessageId: string, options: {
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

function enable(now = NOW, idleTimeoutMinutes = 30) {
  return enableWebControl(WORKSPACE_ID, {
    localUser: true,
    codexSessionId: OWNER,
    conversationUrl: CHAT_URL,
    idleTimeoutMinutes,
  }, now);
}

function boot(now = NOW) {
  const enabled = enable(now);
  return markBootSent(WORKSPACE_ID, OWNER, "boot-message-1", now + 1);
}

function acceptFirstCommand(now = NOW) {
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

function recordCurrentCommand(commandId: string, now = NOW): void {
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

function completeFirstCommand(now = NOW): void {
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

describe("网页控制完整生命周期", () => {
  it("从 enable 到 Boot、COMMAND、记录、反馈、新 COMMAND、DONE 完成闭环", () => {
    const enabled = enable();
    expect(enabled.enabled).toBe(true);
    expect(enabled.status).toBe("starting");
    expect(controlBootPrompt(enabled)).toContain("[C2C_CONTROL]");

    const waiting = markBootSent(WORKSPACE_ID, OWNER, "boot-message-1", NOW + 1);
    expect(waiting.status).toBe("waiting");
    const first = receiveControl(
      WORKSPACE_ID,
      OWNER,
      userEnvelope(commandText("command-1", waiting.controlSessionId)),
      NOW + 2,
    );
    expect(first.outcome).toBe("accepted");
    expect(state().activeCommand?.iteration).toBe(0);

    startControlCommand(WORKSPACE_ID, OWNER, "command-1", NOW + 3);
    recordCurrentCommand("command-1", NOW + 4);
    const firstFeedback = completeControlCommand(WORKSPACE_ID, OWNER, "command-1", NOW + 5);
    expect(firstFeedback.feedback).toContain("STATE: EXECUTED");
    expect(firstFeedback.feedbackMessageId).toBeUndefined();
    markControlFeedbackSent(WORKSPACE_ID, OWNER, "command-1", "feedback-message-1", NOW + 6);

    const review = receiveControl(
      WORKSPACE_ID,
      OWNER,
      reviewEnvelope(
        commandText("command-2", waiting.controlSessionId, WORKSPACE_ID, "在原用户任务范围内继续修复"),
        "command-1",
        "feedback-message-1",
        { messageId: "assistant-review-1" },
      ),
      NOW + 7,
    );
    expect(review.outcome).toBe("accepted");
    expect(state().activeCommand?.iteration).toBe(1);
    expect(state().activeCommand?.rootGoal).toBe("完成原用户任务");

    startControlCommand(WORKSPACE_ID, OWNER, "command-2", NOW + 8);
    recordCurrentCommand("command-2", NOW + 9);
    completeControlCommand(WORKSPACE_ID, OWNER, "command-2", NOW + 10);
    markControlFeedbackSent(WORKSPACE_ID, OWNER, "command-2", "feedback-message-2", NOW + 11);

    const done = receiveControl(
      WORKSPACE_ID,
      OWNER,
      reviewEnvelope(doneText("command-2", waiting.controlSessionId), "command-2", "feedback-message-2", {
        messageId: "assistant-done-1",
      }),
      NOW + 12,
    );
    expect(done).toEqual({ outcome: "done" });
    expect(state().activeCommand).toBeUndefined();
    expect(state().status).toBe("waiting");
    expect(state().seenCommands.map((item) => [item.commandId, item.status])).toEqual([
      ["command-1", "completed"],
      ["command-2", "completed"],
    ]);
  });
});

describe("来源、授权和范围", () => {
  it("拒绝普通文本和网页 ENABLE，且不会开启或新增命令记录", () => {
    const ready = boot();
    for (const [index, text] of ["这是普通建议，不是任务委派", "ENABLE: true"].entries()) {
      const result = receiveControl(
        WORKSPACE_ID,
        OWNER,
        userEnvelope(text, { messageId: `assistant-plain-${index}`, latestUserMessageId: `user-plain-${index}` }),
        NOW + index + 2,
      );
      expect(result.outcome).toBe("rejected");
    }
    expect(state().enabled).toBe(true);
    expect(state().status).toBe("waiting");
    expect(state().controlSessionId).toBe(ready.controlSessionId);
    expect(state().seenCommands).toHaveLength(0);
  });

  it.each(["workspace", "mcp"]) ("拒绝 source=%s 的伪造观察证明", (source) => {
    const ready = boot();
    const result = receiveControl(
      WORKSPACE_ID,
      OWNER,
      userEnvelope(commandText("source-command", ready.controlSessionId), {
        source,
        messageId: `assistant-${source}`,
        latestUserMessageId: `user-${source}`,
      }),
      NOW + 2,
    );
    expect(result.outcome).toBe("rejected");
    expect(state().activeCommand).toBeUndefined();
    expect(state().seenCommands).toHaveLength(0);
  });

  it("拒绝错误 session、workspace、URL 和 owner", () => {
    const ready = boot();
    const cases = [
      commandText("wrong-session", "another-control-session"),
      commandText("wrong-workspace", ready.controlSessionId, "another-workspace"),
    ];
    for (const [index, text] of cases.entries()) {
      const result = receiveControl(
        WORKSPACE_ID,
        OWNER,
        userEnvelope(text, { messageId: `assistant-wrong-${index}`, latestUserMessageId: `user-wrong-${index}` }),
        NOW + index + 2,
      );
      expect(result.outcome).toBe("rejected");
    }
    const wrongUrl = receiveControl(
      WORKSPACE_ID,
      OWNER,
      userEnvelope(commandText("wrong-url", ready.controlSessionId), {
        conversationUrl: "https://chatgpt.com/c/another-chat",
        messageId: "assistant-wrong-url",
        latestUserMessageId: "user-wrong-url",
      }),
      NOW + 4,
    );
    expect(wrongUrl.outcome).toBe("rejected");
    expect(() => receiveControl(
      WORKSPACE_ID,
      OTHER_OWNER,
      userEnvelope(commandText("wrong-owner", ready.controlSessionId)),
      NOW + 5,
    )).toThrow(/另一个 Codex task/);
    expect(state().activeCommand).toBeUndefined();
  });

  it("自动 Boot 和 EXECUTED 反馈不能充当新的 user-delegation", () => {
    const ready = boot();
    const bootAsUser = receiveControl(
      WORKSPACE_ID,
      OWNER,
      userEnvelope(commandText("boot-as-user", ready.controlSessionId), {
        messageId: "assistant-boot-replay",
        latestUserMessageId: "boot-message-1",
      }),
      NOW + 2,
    );
    expect(bootAsUser.outcome).toBe("rejected");
    expect(state().seenCommands.find((item) => item.commandId === "boot-as-user")?.status).toBe("rejected");

    const legitimate = receiveControl(
      WORKSPACE_ID,
      OWNER,
      userEnvelope(commandText("command-1", ready.controlSessionId), {
        messageId: "assistant-legitimate",
        latestUserMessageId: "user-legitimate",
      }),
      NOW + 3,
    );
    expect(legitimate.outcome).toBe("accepted");
    completeFirstCommand(NOW + 10);
    const feedbackAsUser = receiveControl(
      WORKSPACE_ID,
      OWNER,
      userEnvelope(commandText("feedback-as-user", ready.controlSessionId), {
        messageId: "assistant-feedback-replay",
        latestUserMessageId: "feedback-message-1",
      }),
      NOW + 20,
    );
    expect(feedbackAsUser.outcome).toBe("rejected");
    expect(state().seenCommands.find((item) => item.commandId === "feedback-as-user")?.status).toBe("rejected");
  });

  it("Review 只能跟随当前 EXECUTED 反馈并声明仍在原范围", () => {
    const ready = boot();
    receiveControl(
      WORKSPACE_ID,
      OWNER,
      userEnvelope(commandText("command-1", ready.controlSessionId)),
      NOW + 2,
    );
    completeFirstCommand(NOW + 3);

    const wrongFeedback = receiveControl(
      WORKSPACE_ID,
      OWNER,
      reviewEnvelope(commandText("wrong-feedback", ready.controlSessionId), "command-1", "other-feedback", {
        messageId: "assistant-wrong-feedback",
      }),
      NOW + 20,
    );
    expect(wrongFeedback.outcome).toBe("rejected");

    const wrongCommand = receiveControl(
      WORKSPACE_ID,
      OWNER,
      reviewEnvelope(commandText("wrong-review-owner", ready.controlSessionId), "other-command", "feedback-message-1", {
        messageId: "assistant-wrong-command",
      }),
      NOW + 21,
    );
    expect(wrongCommand.outcome).toBe("rejected");

    const outOfScope = receiveControl(
      WORKSPACE_ID,
      OWNER,
      reviewEnvelope(commandText("out-of-scope", ready.controlSessionId), "command-1", "feedback-message-1", {
        messageId: "assistant-out-of-scope",
        withinOriginalScope: false,
      }),
      NOW + 22,
    );
    expect(outOfScope.outcome).toBe("rejected");
    expect(state().activeCommand?.command.commandId).toBe("command-1");

    const valid = receiveControl(
      WORKSPACE_ID,
      OWNER,
      reviewEnvelope(commandText("valid-review", ready.controlSessionId), "command-1", "feedback-message-1", {
        messageId: "assistant-valid-review",
      }),
      NOW + 23,
    );
    expect(valid.outcome).toBe("accepted");
  });
});

describe("状态幂等、关闭和超时", () => {
  it("拒绝重复 Boot、COMMAND、start、complete、feedback-sent", () => {
    const ready = boot();
    expect(markBootSent(WORKSPACE_ID, OWNER, "boot-message-1", NOW + 2).bootMessageId).toBe("boot-message-1");
    expect(() => markBootSent(WORKSPACE_ID, OWNER, "boot-message-2", NOW + 3)).toThrow(/禁止重复/);

    const accepted = receiveControl(
      WORKSPACE_ID,
      OWNER,
      userEnvelope(commandText("command-1", ready.controlSessionId)),
      NOW + 4,
    );
    expect(accepted.outcome).toBe("accepted");
    const duplicate = receiveControl(
      WORKSPACE_ID,
      OWNER,
      userEnvelope(commandText("command-1", ready.controlSessionId), {
        messageId: "assistant-duplicate",
        latestUserMessageId: "user-duplicate",
      }),
      NOW + 5,
    );
    expect(duplicate).toEqual({ outcome: "ignored", reason: "COMMAND_ID 已处理，禁止重复执行。" });

    startControlCommand(WORKSPACE_ID, OWNER, "command-1", NOW + 6);
    expect(() => startControlCommand(WORKSPACE_ID, OWNER, "command-1", NOW + 7)).toThrow(/禁止重新执行/);
    recordCurrentCommand("command-1", NOW + 8);
    const feedback = completeControlCommand(WORKSPACE_ID, OWNER, "command-1", NOW + 9);
    const duplicateComplete = completeControlCommand(WORKSPACE_ID, OWNER, "command-1", NOW + 10);
    expect(duplicateComplete.feedback).toBe(feedback.feedback);
    markControlFeedbackSent(WORKSPACE_ID, OWNER, "command-1", "feedback-message-1", NOW + 11);
    expect(markControlFeedbackSent(WORKSPACE_ID, OWNER, "command-1", "feedback-message-1", NOW + 12).seenCommands).toBeDefined();
    expect(() => markControlFeedbackSent(WORKSPACE_ID, OWNER, "command-1", "feedback-message-2", NOW + 13)).toThrow(/不能重复/);
  });

  it("本地关闭和空闲超时都会停止接收，但保留历史", () => {
    boot();
    expect(() => disableWebControl(WORKSPACE_ID, false, NOW + 2)).toThrow(/本地用户/);
    const disabled = disableWebControl(WORKSPACE_ID, true, NOW + 2);
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.status).toBe("disabled");
    expect(() => markBootSent(WORKSPACE_ID, OWNER, "boot-message-2", NOW + 3)).toThrow(/关闭或过期/);

    const expiredWorkspace = "expired-workspace";
    writeSession(expiredWorkspace, baseSession());
    const expired = enableWebControl(expiredWorkspace, {
      localUser: true,
      codexSessionId: OWNER,
      conversationUrl: CHAT_URL,
      idleTimeoutMinutes: 1,
    }, NOW);
    expect(expired.enabled).toBe(true);
    expect(webControlStatus(expiredWorkspace, NOW + 60_000)?.status).toBe("expired");
    expect(readSession(expiredWorkspace)?.webControl?.enabled).toBe(false);
  });

  it("执行中的 COMMAND 不因空闲时间到期而中止", () => {
    const ready = boot();
    receiveControl(
      WORKSPACE_ID,
      OWNER,
      userEnvelope(commandText("command-1", ready.controlSessionId)),
      NOW + 2,
    );
    startControlCommand(WORKSPACE_ID, OWNER, "command-1", NOW + 3);
    const stillExecuting = webControlStatus(WORKSPACE_ID, NOW + 60 * 60_000);
    expect(stillExecuting?.enabled).toBe(true);
    expect(stillExecuting?.status).toBe("executing");
  });

  it("fence、被拒绝的 ID、重新开启和 session clear 都不能绕过 replay", () => {
    const ready = boot();
    const text = commandText("fenced-command", ready.controlSessionId);
    const envelope = userEnvelope(`\`\`\`text\n${text}\n\`\`\``);
    expect(receiveControl(WORKSPACE_ID, OWNER, envelope, NOW + 2).outcome).toBe("accepted");
    rejectControlCommand(WORKSPACE_ID, OWNER, "fenced-command", "用户修改尚未核对", NOW + 3);
    expect(receiveControl(WORKSPACE_ID, OWNER, userEnvelope(text), NOW + 4).outcome).toBe("ignored");
    clearChatPointer(WORKSPACE_ID);
    expect(state().enabled).toBe(false);
    expect(state().seenCommands[0].status).toBe("rejected");
    writeSession(WORKSPACE_ID, mergeSession(readSession(WORKSPACE_ID), { url: CHAT_URL }));
    const next = enable(NOW + 5);
    expect(next.controlSessionId).not.toBe(ready.controlSessionId);
    markBootSent(WORKSPACE_ID, OWNER, "boot-2", NOW + 6);
    const replay = userEnvelope(commandText("fenced-command", next.controlSessionId));
    expect(receiveControl(WORKSPACE_ID, OWNER, replay, NOW + 7).outcome).toBe("ignored");
  });

  it("重复/普通消息不续期，过期、关闭或 Chat URL 改变后拒绝新任务", () => {
    const ready = boot();
    const deadline = state().expiresAt;
    receiveControl(WORKSPACE_ID, OWNER, userEnvelope("普通建议"), NOW + 1000);
    expect(state().expiresAt).toBe(deadline);
    expect(receiveControl(WORKSPACE_ID, OWNER,
      userEnvelope(commandText("too-late", ready.controlSessionId)), NOW + 31 * 60000).outcome).toBe("rejected");
    expect(state()).toMatchObject({ enabled: false, status: "expired" });
    const next = enable(NOW + 32 * 60000);
    markBootSent(WORKSPACE_ID, OWNER, "boot-new", NOW + 32 * 60000 + 1);
    writeSession(WORKSPACE_ID, mergeSession(readSession(WORKSPACE_ID), { url: "https://chatgpt.com/c/other-chat" }));
    expect(receiveControl(WORKSPACE_ID, OWNER,
      userEnvelope(commandText("old-chat", next.controlSessionId)), NOW + 32 * 60000 + 2).outcome).toBe("rejected");
    expect(state()).toMatchObject({ enabled: false, status: "disabled" });
  });

  it("关闭后的在途完成只保存结果，不重新启用或重做任务", () => {
    acceptFirstCommand();
    startControlCommand(WORKSPACE_ID, OWNER, "command-1", NOW + 3);
    disableWebControl(WORKSPACE_ID, true, NOW + 4);
    expect(() => enable(NOW + 5)).toThrow(/未结案/);
    recordCurrentCommand("command-1", NOW + 6);
    completeControlCommand(WORKSPACE_ID, OWNER, "command-1", NOW + 7);
    expect(state()).toMatchObject({ enabled: false, status: "disabled" });
    expect(state().seenCommands[0].status).toBe("completed");
    expect(() => startControlCommand(WORKSPACE_ID, OWNER, "command-1", NOW + 8)).toThrow();
  });

  it("本地 reject 消耗本次用户授权，换 COMMAND_ID 仍不能重试被拒绝的任务", () => {
    const sessionId = acceptFirstCommand();
    rejectControlCommand(WORKSPACE_ID, OWNER, "command-1", "超出用户允许的任务范围", NOW + 3);
    expect(receiveControl(WORKSPACE_ID, OWNER,
      userEnvelope(commandText("new-id-same-user", sessionId), { messageId: "assistant-retry" }), NOW + 4).outcome).toBe("rejected");
    expect(receiveControl(WORKSPACE_ID, OWNER,
      userEnvelope(commandText("new-user-command", sessionId), { messageId: "assistant-new-user", latestUserMessageId: "user-new" }),
      NOW + 5).outcome).toBe("accepted");
  });

  it("过期重新 enable 不能丢弃待反馈任务，补反馈后由本地明确结案", () => {
    acceptFirstCommand();
    startControlCommand(WORKSPACE_ID, OWNER, "command-1", NOW + 3);
    expect(() => closeControlTask(WORKSPACE_ID, OWNER, "command-1", true, NOW + 4)).toThrow(/completed/);
    recordCurrentCommand("command-1", NOW + 5);
    const feedback = completeControlCommand(WORKSPACE_ID, OWNER, "command-1", NOW + 6);
    const expiredTime = NOW + 31 * 60000;
    expect(webControlStatus(WORKSPACE_ID, expiredTime)?.enabled).toBe(false);
    expect(() => enable(expiredTime)).toThrow(/未结案/);
    expect(completeControlCommand(WORKSPACE_ID, OWNER, "command-1", expiredTime).feedback).toBe(feedback.feedback);
    markControlFeedbackSent(WORKSPACE_ID, OWNER, "command-1", "late-feedback", expiredTime + 1);
    expect(() => closeControlTask(WORKSPACE_ID, OWNER, "command-1", false, expiredTime + 2)).toThrow(/本地用户/);
    closeControlTask(WORKSPACE_ID, OWNER, "command-1", true, expiredTime + 3);
    const next = enable(expiredTime + 4);
    expect(next.activeCommand).toBeUndefined();
    expect(next.seenCommands[0]).toMatchObject({ status: "completed", feedbackMessageId: "late-feedback" });
  });
});

describe("普通 checkpoint 与损坏状态", () => {
  it("普通 checkpoint 更新不会丢失 Web Control 状态", () => {
    writeSession(WORKSPACE_ID, baseSession({
      taskId: "normal-task",
      checkpoint: {
        taskId: "normal-task",
        iteration: 1,
        protocolState: "PLAN_RECEIVED",
        waitingFor: "GPT_PLAN",
        originalGoal: "普通任务",
        updatedAt: new Date(NOW).toISOString(),
      },
    }));
    const enabled = enable();
    const previous = readSession(WORKSPACE_ID)!;
    const updated = mergeSession(previous, {
      checkpoint: { protocolState: "EXECUTING", waitingFor: "GPT_REVIEW" },
    });
    writeSession(WORKSPACE_ID, updated);
    expect(readSession(WORKSPACE_ID)?.checkpoint?.protocolState).toBe("EXECUTING");
    expect(readSession(WORKSPACE_ID)?.webControl?.controlSessionId).toBe(enabled.controlSessionId);
  });

  it("损坏 JSON 或 webControl 结构时 fail closed 并保留原文件", () => {
    const file = sessionFile(WORKSPACE_ID);
    fs.writeFileSync(file, "{not-json");
    expect(() => webControlStatus(WORKSPACE_ID, NOW)).toThrow(/会话状态无法读取/);
    expect(fs.readFileSync(file, "utf8")).toBe("{not-json");

    fs.writeFileSync(file, JSON.stringify(baseSession({ webControl: { version: 1 } as never }), null, 2));
    const before = fs.readFileSync(file, "utf8");
    expect(() => webControlStatus(WORKSPACE_ID, NOW)).toThrow(/网页控制状态损坏/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);

    fs.writeFileSync(file, JSON.stringify({ ...baseSession(), webControl: null }));
    expect(() => clearChatPointer(WORKSPACE_ID)).toThrow(/网页控制状态损坏/);
    expect(() => writeSession(WORKSPACE_ID, baseSession())).toThrow(/网页控制状态损坏/);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).webControl).toBeNull();

    fs.writeFileSync(file, JSON.stringify(baseSession(), null, 2));
    const valid = enable();
    const inconsistent = { ...valid, enabled: true, status: "disabled" };
    fs.writeFileSync(file, JSON.stringify({ ...baseSession(), webControl: inconsistent as never }, null, 2));
    const inconsistentBefore = fs.readFileSync(file, "utf8");
    expect(() => webControlStatus(WORKSPACE_ID, NOW)).toThrow(/网页控制状态不一致/);
    expect(fs.readFileSync(file, "utf8")).toBe(inconsistentBefore);
  });

  it("自动消息 ID 引用丢失也按损坏状态拒绝，不能变为新用户授权", () => {
    acceptFirstCommand();
    completeFirstCommand();
    const file = sessionFile(WORKSPACE_ID);
    const saved = readSession(WORKSPACE_ID)!;
    for (const missing of ["boot-message-1", "feedback-message-1"]) {
      const corrupt = structuredClone(saved);
      corrupt.webControl!.generatedMessageIds = corrupt.webControl!.generatedMessageIds.filter((item) => item !== missing);
      fs.writeFileSync(file, JSON.stringify(corrupt));
      expect(() => webControlStatus(WORKSPACE_ID, NOW + 10)).toThrow(/状态不一致/);
      expect(() => enable(NOW + 11)).toThrow(/状态不一致/);
    }
  });
});

describe("state.ts 事务安全", () => {
  it("已有写锁时拒绝写入并保留原文件", () => {
    const file = sessionFile(WORKSPACE_ID);
    const before = fs.readFileSync(file, "utf8");
    const lock = `${file}.lock`;
    fs.writeFileSync(lock, JSON.stringify({ pid: 123, createdAt: NOW }));
    try {
      expect(() => enable()).toThrow(/写锁已存在/);
      expect(fs.readFileSync(file, "utf8")).toBe(before);
    } finally {
      fs.rmSync(lock, { force: true });
    }
  });

  it("原子替换失败时保留原文件并清理临时文件和锁", () => {
    const file = sessionFile(WORKSPACE_ID);
    const before = fs.readFileSync(file, "utf8");
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("模拟原子替换失败");
    });
    expect(() => enable()).toThrow("模拟原子替换失败");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
    expect(fs.readdirSync(path.dirname(file)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });
});
