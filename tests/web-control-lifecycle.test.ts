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
import {
  WORKSPACE_ID,
  CHAT_URL,
  OWNER,
  OTHER_OWNER,
  NOW,
  baseSession,
  state,
  commandText,
  doneText,
  userEnvelope,
  reviewEnvelope,
  enable,
  boot,
  acceptFirstCommand,
  recordCurrentCommand,
  completeFirstCommand,
} from "./web-control-fixtures.js";

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
