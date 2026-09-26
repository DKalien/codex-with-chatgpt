import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listExecutionOutputs, MAX_OUTPUT_RECORDS, saveExecutionOutput } from "../src/execution/output.js";
import { appendExecutionRecord, readExecutionRecords, type ExecutionRecord } from "../src/execution/records.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");

function runRecord(root: string, args: string[]) {
  const env = { ...process.env };
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_SESSION_ID;
  return spawnSync(
    process.execPath,
    ["--import", "tsx", cliEntry, "record", "--workspace", root, "--task", "c2c_test", ...args],
    { cwd: projectRoot, encoding: "utf8", env }
  );
}

function withRecordEnvironment(run: (root: string, workspace: Workspace) => void): void {
  const root = makeTmpDir("record-cli-workspace");
  const stateDir = makeTmpDir("record-cli-state");
  const previousStateDir = process.env.C2C_STATE_DIR;
  process.env.C2C_STATE_DIR = stateDir;

  try {
    run(root, new Workspace(root));
  } finally {
    if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousStateDir;
    cleanup(root);
    cleanup(stateDir);
  }
}

describe("c2c record", () => {
  it("--json 保持普通非 Desktop record 的结构化成功输出", () => {
    withRecordEnvironment((root, workspace) => {
      const result = runRecord(root, ["--iteration", "1", "--changed-files", "", "--tests", "not run", "--json"]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, autoPromotedDesktop: false, taskId: "c2c_test" });
      expect(readExecutionRecords(workspace.id)).toHaveLength(1);
    });
  });

  it("将 rawSummary 独立保存并脱敏，notes 仍保留范围说明", () => {
    withRecordEnvironment((root, workspace) => {
      const result = runRecord(root, [
        "--iteration", "1", "--changed-files", "", "--tests", "not run",
        "--notes", "范围说明",
        "--raw-summary", "本轮完成；token=ghp_abcdefghijklmnopqrstuv",
      ]);

      expect(result.status).toBe(0);
      expect(readExecutionRecords(workspace.id)[0]).toMatchObject({
        notes: "范围说明",
        rawSummary: "本轮完成；token=[REDACTED]",
      });
      expect(fs.readFileSync(path.join(process.env.C2C_STATE_DIR!, "executions", `${workspace.id}.jsonl`), "utf8"))
        .not.toContain("ghp_abcdefghijklmnopqrstuv");
    });
  });

  it("超过 8192 UTF-8 bytes 的 rawSummary 在输出落盘前拒绝", () => {
    withRecordEnvironment((root, workspace) => {
      const result = runRecord(root, [
        "--iteration", "1", "--changed-files", "", "--tests", "not run",
        "--raw-summary", "字".repeat(2731),
        "--command", "pnpm test", "--output", "should not be saved",
      ]);

      expect(result.status).toBe(1);
      expect(readExecutionRecords(workspace.id)).toEqual([]);
      expect(listExecutionOutputs(workspace.id)).toEqual([]);
    });
  });

  it("records valid numeric options and command output", () => {
    withRecordEnvironment((root, workspace) => {
      const result = runRecord(root, [
        "--iteration",
        "2",
        "--changed-files",
        "3",
        "--command",
        "pnpm test",
        "--output",
        "tests passed",
        "--exit-code",
        "1",
      ]);

      expect(result.status).toBe(0);
      expect(readExecutionRecords(workspace.id)).toEqual([
        expect.objectContaining({ taskId: "c2c_test", iteration: 2, changedFiles: 3 }),
      ]);
      expect(listExecutionOutputs(workspace.id)).toEqual([
        expect.objectContaining({ command: "pnpm test", exitCode: 1, iteration: 2 }),
      ]);
    });
  });

  it("rejects a non-integer iteration without recording the execution", () => {
    withRecordEnvironment((root, workspace) => {
      const result = runRecord(root, ["--iteration", "abc"]);

      expect(result.status).toBe(1);
      expect(readExecutionRecords(workspace.id)).toEqual([]);
    });
  });

  it("rejects an unsafe changed-file count before recording command output", () => {
    withRecordEnvironment((root, workspace) => {
      const result = runRecord(root, [
        "--iteration",
        "1",
        "--changed-files",
        "9".repeat(400),
        "--command",
        "pnpm test",
        "--output",
        "tests passed",
      ]);

      expect(result.status).toBe(1);
      expect(readExecutionRecords(workspace.id)).toEqual([]);
      expect(listExecutionOutputs(workspace.id)).toEqual([]);
    });
  });

  it("rejects a negative changed-file count", () => {
    withRecordEnvironment((root, workspace) => {
      const result = runRecord(root, ["--iteration", "1", "--changed-files=-1"]);

      expect(result.status).toBe(1);
      expect(readExecutionRecords(workspace.id)).toEqual([]);
    });
  });

  it("rejects a non-integer exit code before recording command output", () => {
    withRecordEnvironment((root, workspace) => {
      const result = runRecord(root, [
        "--iteration",
        "1",
        "--command",
        "pnpm test",
        "--output",
        "tests passed",
        "--exit-code",
        "abc",
      ]);

      expect(result.status).toBe(1);
      expect(readExecutionRecords(workspace.id)).toEqual([]);
      expect(listExecutionOutputs(workspace.id)).toEqual([]);
    });
  });

  it.each(["--control-session-id", "--command-id"])(
    "rejects invalid %s without creating command output",
    (idOption) => {
      withRecordEnvironment((root, workspace) => {
        const stateDir = process.env.C2C_STATE_DIR!;
        const result = runRecord(root, [
          "--iteration",
          "1",
          idOption,
          "bad!",
          "--command",
          "pnpm test",
          "--output",
          "tests passed",
        ]);

        expect(result.status).toBe(1);
        expect(readExecutionRecords(workspace.id)).toEqual([]);
        expect(listExecutionOutputs(workspace.id, MAX_OUTPUT_RECORDS)).toEqual([]);
        expect(fs.existsSync(path.join(stateDir, "executions", `${workspace.id}.jsonl`))).toBe(false);
        expect(fs.existsSync(path.join(stateDir, "execution-outputs", workspace.id, "index.json"))).toBe(false);
        expect(fs.existsSync(path.join(stateDir, "execution-outputs", workspace.id, "bodies"))).toBe(false);
      });
    }
  );

  // 预填满输出保留窗口，验证非法 ID 不会先写入并淘汰旧输出。
  it.each(["--control-session-id", "--command-id"])(
    "keeps a full output window unchanged for invalid %s",
    (idOption) => {
      withRecordEnvironment((root, workspace) => {
        const stateDir = process.env.C2C_STATE_DIR!;
        const seededOutputs = Array.from({ length: MAX_OUTPUT_RECORDS }, (_, iteration) =>
          saveExecutionOutput(workspace.id, {
            command: `seed command ${iteration}`,
            raw: `seed body ${iteration}`,
            exitCode: 0,
            taskId: "c2c_seed",
            iteration,
          })
        );
        appendExecutionRecord(workspace.id, {
          taskId: "c2c_seed",
          iteration: 0,
          changedFiles: 0,
          tests: null,
          exitStatus: "ok",
          timestamp: "2026-01-01T00:00:00.000Z",
          outputId: seededOutputs[0].id,
          outputAvailable: true,
        });

        const indexFile = path.join(stateDir, "execution-outputs", workspace.id, "index.json");
        const oldestBodyFile = path.join(
          stateDir,
          "execution-outputs",
          workspace.id,
          "bodies",
          `${seededOutputs[0].id}.txt`
        );
        const indexBefore = fs.readFileSync(indexFile, "utf8");
        const bodyBefore = fs.readFileSync(oldestBodyFile, "utf8");
        const recordsBefore = readExecutionRecords(workspace.id);
        const outputsBefore = listExecutionOutputs(workspace.id, MAX_OUTPUT_RECORDS);

        const result = runRecord(root, [
          "--iteration",
          "1",
          idOption,
          "bad!",
          "--command",
          "pnpm test",
          "--output",
          "tests passed",
        ]);

        expect(result.status).toBe(1);
        expect(fs.readFileSync(indexFile, "utf8")).toBe(indexBefore);
        expect(fs.readFileSync(oldestBodyFile, "utf8")).toBe(bodyBefore);
        expect(readExecutionRecords(workspace.id)).toEqual(recordsBefore);
        expect(listExecutionOutputs(workspace.id, MAX_OUTPUT_RECORDS)).toEqual(outputsBefore);
      });
    }
  );
});

describe("execution record persistence", () => {
  it("rejects invalid records at the write boundary", () => {
    withRecordEnvironment((_root, workspace) => {
      const invalidRecord: ExecutionRecord = {
        taskId: "c2c_invalid",
        iteration: Number.NaN,
        changedFiles: 0,
        tests: null,
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
      };

      expect(() => appendExecutionRecord(workspace.id, invalidRecord)).toThrow();
      expect(readExecutionRecords(workspace.id)).toEqual([]);
    });
  });
});
