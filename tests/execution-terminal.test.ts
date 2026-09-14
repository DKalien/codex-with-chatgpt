import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendExecutionRecord,
  resolveTerminalExecutionRecord,
  type ExecutionRecord,
} from "../src/execution/records.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const WORKSPACE_ID = "terminal-resolver-workspace";
const EXPECTED = {
  controlSessionId: "control-session",
  commandId: "command-id",
  taskId: "task-id",
  iteration: 2,
};

let stateDir: string;

beforeEach(() => {
  stateDir = makeTmpDir("execution-terminal");
  process.env.C2C_STATE_DIR = stateDir;
});

afterEach(() => {
  cleanup(stateDir);
  delete process.env.C2C_STATE_DIR;
});

function record(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    ...EXPECTED,
    changedFiles: [],
    tests: "1 passed",
    exitStatus: "ok",
    timestamp: "2026-09-13T00:00:00.000Z",
    ...overrides,
  };
}

function recordsFile(): string {
  return path.join(stateDir, "executions", `${WORKSPACE_ID}.jsonl`);
}

describe("strict terminal execution resolver", () => {
  it.each(["ok", "failed", "blocked"] as const)("accepts the unique %s terminal", (exitStatus) => {
    appendExecutionRecord(WORKSPACE_ID, record({ exitStatus }));
    expect(resolveTerminalExecutionRecord(WORKSPACE_ID, EXPECTED)).toMatchObject({
      ...EXPECTED,
      exitStatus,
    });
  });

  it("does not treat accepted or another non-terminal status as complete", () => {
    appendExecutionRecord(WORKSPACE_ID, record({ exitStatus: "accepted" }));
    expect(() => resolveTerminalExecutionRecord(WORKSPACE_ID, EXPECTED)).toThrow(/尚未进入/);
  });

  it("rejects missing, wrong-identity and duplicate history", () => {
    expect(() => resolveTerminalExecutionRecord(WORKSPACE_ID, EXPECTED)).toThrow(/缺少唯一匹配/);

    appendExecutionRecord(WORKSPACE_ID, record({ taskId: "other-task" }));
    expect(() => resolveTerminalExecutionRecord(WORKSPACE_ID, EXPECTED)).toThrow(/身份不匹配/);

    appendExecutionRecord(WORKSPACE_ID, record());
    expect(() => resolveTerminalExecutionRecord(WORKSPACE_ID, EXPECTED)).toThrow(/重复或冲突/);
  });

  it("fails closed when any historical JSONL line is damaged", () => {
    appendExecutionRecord(WORKSPACE_ID, record());
    fs.appendFileSync(recordsFile(), "{broken history}\n", "utf8");
    expect(() => resolveTerminalExecutionRecord(WORKSPACE_ID, EXPECTED)).toThrow(/JSONL 损坏/);
  });
});
