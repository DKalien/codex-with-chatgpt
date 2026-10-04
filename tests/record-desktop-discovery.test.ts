import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerRecordCommand } from "../src/cli/record.js";
import * as desktopResult from "../src/desktop/result.js";
import { listExecutionOutputs } from "../src/execution/output.js";
import { readExecutionRecords } from "../src/execution/records.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

let root: string;
let stateDir: string;
let workspace: Workspace;
let priorExitCode: typeof process.exitCode;
let priorStateDir: string | undefined;

beforeEach(() => {
  priorStateDir = process.env.C2C_STATE_DIR;
  stateDir = isolateStateDir();
  root = makeTmpDir("record-desktop-discovery");
  workspace = new Workspace(root);
  priorExitCode = process.exitCode;
  process.exitCode = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = priorExitCode;
  if (priorStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = priorStateDir;
  cleanup(root);
  cleanup(stateDir);
});

async function run(json: boolean): Promise<string> {
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  });
  const program = new Command().exitOverride();
  registerRecordCommand(program);
  await program.parseAsync(["node", "c2c", "record", "-w", root, "--iteration", "1", "--changed-files", "", "--tests", "not run", "--raw-summary", "diagnostic fixture", ...(json ? ["--json"] : [])]);
  return output;
}

describe("record Desktop discovery diagnosis", () => {
  it.each([
    "当前进程不是可识别的 Desktop runner；未写入通用执行记录。",
    "当前 Desktop result turn 不是可识别的 accepted delivery；未写入通用执行记录。",
  ])("preserves the bounded not-applicable reason without suggesting a task fallback: %s", async message => {
    vi.spyOn(desktopResult, "discoverCurrentDesktopDelivery").mockRejectedValue(new desktopResult.DesktopResultError("DESKTOP_RESULT_NOT_APPLICABLE", message));
    expect(JSON.parse(await run(true))).toEqual({ ok: false, error: "DESKTOP_RESULT_NOT_APPLICABLE", stage: "desktop_discovery", message });
    expect(process.exitCode).toBe(1);
    expect(readExecutionRecords(workspace.id)).toEqual([]);
    expect(listExecutionOutputs(workspace.id)).toEqual([]);
    expect(fs.existsSync(path.join(stateDir, "executions", `${workspace.id}.jsonl`))).toBe(false);
  });

  it("non-JSON callers receive the original discovery error", async () => {
    const failure = new desktopResult.DesktopResultError("DESKTOP_RESULT_NOT_APPLICABLE", "bounded fixture reason");
    vi.spyOn(desktopResult, "discoverCurrentDesktopDelivery").mockRejectedValue(failure);
    await expect(run(false)).rejects.toBe(failure);
    expect(readExecutionRecords(workspace.id)).toEqual([]);
    expect(listExecutionOutputs(workspace.id)).toEqual([]);
  });

  it("ownership and state errors never become a generic record", async () => {
    const failure = new desktopResult.DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "bounded ownership mismatch");
    vi.spyOn(desktopResult, "discoverCurrentDesktopDelivery").mockRejectedValue(failure);
    await expect(run(true)).rejects.toBe(failure);
    expect(readExecutionRecords(workspace.id)).toEqual([]);
    expect(listExecutionOutputs(workspace.id)).toEqual([]);
  });
});
