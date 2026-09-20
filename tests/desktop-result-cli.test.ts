import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDesktopCommands } from "../src/cli/desktop.js";
import { desktopIpc } from "../src/desktop/ipc.js";
import { listExecutionOutputs, readExecutionOutput } from "../src/execution/output.js";
import { readExecutionRecords } from "../src/execution/records.js";
import { Workspace } from "../src/workspace/manager.js";
import { desktopFile, readDesktop, updateDesktop } from "../src/desktop/store.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const threadId = "01a00000-0000-7000-8000-000000000001";
const commandId = "desktop_result_command";
const continuationTurnId = "01a00000-0000-7000-8000-000000000003";
const originTurnId = "01a00000-0000-7000-8000-000000000004";
let root: string;
let stateDir: string;
let workspace: Workspace;
let acceptedTurnId: string;

beforeEach(() => {
  root = makeTmpDir("desktop-result-workspace");
  stateDir = makeTmpDir("desktop-result-state");
  workspace = new Workspace(root);
  vi.stubEnv("C2C_STATE_DIR", stateDir);
  vi.stubEnv("CODEX_THREAD_ID", threadId);
  seedAcceptedDelivery();
  vi.spyOn(desktopIpc, "currentResultContext").mockResolvedValue(currentResultContext(acceptedTurnId) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  cleanup(root);
  cleanup(stateDir);
});

function seedAcceptedDelivery(): void {
  const now = new Date().toISOString();
  const bindingId = randomUUID();
  acceptedTurnId = randomUUID();
  updateDesktop(workspace.id, () => ({
    state: {
      version: 1,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      enabled: false,
      binding: {
        threadId,
        hostId: "local",
        projectId: "desktop_result_project",
        bindingId,
        title: "当前 Desktop 会话",
        boundAt: now,
      },
      deliveries: [{
        commandId,
        clientId: "accepted-client",
        bindingId,
        threadId,
        turnId: acceptedTurnId,
        intent: "development_plan" as const,
        messageSha256: "0".repeat(64),
        messageBytes: 1,
        deliveryStatus: "accepted" as const,
        createdAt: now,
        updatedAt: now,
      }],
    },
    result: undefined,
  }));
}

function seedUnknownDelivery(): void {
  updateDesktop(workspace.id, current => {
    if (!current) throw new Error("Desktop fixture missing");
    const delivery = { ...current.deliveries[0], deliveryStatus: "outcome_unknown" as const };
    delete delivery.turnId;
    return { state: { ...current, deliveries: [delivery] }, result: undefined };
  });
}

function currentResultContext(resultTurnId?: string): Record<string, unknown> {
  return {
    threadId,
    hostId: "local",
    projectId: "desktop_result_project",
    workspaceRoot: workspace.root,
    title: "当前 Desktop 会话",
    cwd: workspace.root,
    runtimeStatus: "active",
    ...(resultTurnId === undefined ? {} : { resultTurnId, resultTurnStatus: "inProgress" }),
  };
}

function rejectSeededDelivery(): void {
  updateDesktop(workspace.id, current => {
    if (!current) throw new Error("Desktop fixture missing");
    const delivery = current.deliveries[0];
    if (!delivery) throw new Error("Desktop delivery fixture missing");
    const rejected = {
      ...delivery,
      deliveryStatus: "rejected" as const,
      errorCode: "DESKTOP_REFUSED",
      errorMessage: "用户拒绝",
    };
    delete rejected.turnId;
    return {
      state: { ...current, deliveries: [rejected] },
      result: undefined,
    };
  });
}

async function runRecord(extra: string[]): Promise<{ exitCode: number; stdout: string }> {
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  let stdout = "";
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  });
  try {
    const program = new Command().exitOverride();
    registerDesktopCommands(program);
    await program.parseAsync([
      "node", "c2c", "desktop", "record-result", "-w", root,
      "--command-id", commandId,
      "--changed-files", "src/index.ts",
      "--tests", "not run",
      "--exit-status", "ok",
      "--json",
      ...extra,
    ]);
    return { exitCode: process.exitCode ?? 0, stdout };
  } finally {
    write.mockRestore();
    process.exitCode = previousExitCode;
  }
}

function json(stdout: string): Record<string, any> {
  return JSON.parse(stdout) as Record<string, any>;
}

describe("desktop record-result CLI", () => {
  it("拒绝调用方传入 turnId 或 threadId", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    for (const flag of ["--turn-id", "--thread-id"]) {
      await expect(runRecord([flag, acceptedTurnId])).rejects.toThrow();
    }
    expect(readExecutionRecords(workspace.id)).toEqual([]);
    expect(listExecutionOutputs(workspace.id)).toEqual([]);
  });

  it("accepted 且 CODEX_THREAD_ID 匹配时记录 receipt，JSON 返回 commandId，重试不追加", async () => {
    const sentinel = path.join(root, "must-not-run.txt");
    const sentinelScript = `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "executed")`;
    const args = [
      "--command", `${JSON.stringify(process.execPath)} -e ${JSON.stringify(sentinelScript)}`,
      "--output", "本轮输出",
      "--exit-code", "0",
    ];
    const first = await runRecord(args);
    const second = await runRecord(args);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(json(first.stdout)).toMatchObject({ ok: true, record: { commandId } });
    expect(json(second.stdout)).toMatchObject({ ok: true, record: { commandId } });
    expect(readExecutionRecords(workspace.id)).toHaveLength(1);
    expect(readExecutionRecords(workspace.id)[0]).toMatchObject({
      taskId: `desktop_${commandId}`,
      iteration: 1,
      commandId,
      outputId: expect.any(Number),
    });
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it("CLI 在 native continuation tip 上一次写入 receipt，保留 immutable origin turn", async () => {
    updateDesktop(workspace.id, current => {
      if (!current) throw new Error("Desktop fixture missing");
      return {
        state: { ...current, deliveries: [{ ...current.deliveries[0], turnId: originTurnId }] },
        result: undefined,
      };
    });
    vi.mocked(desktopIpc.currentResultContext).mockResolvedValue(currentResultContext(continuationTurnId) as never);
    const ownership = vi.spyOn(desktopIpc, "currentResultOwnership").mockResolvedValue({
      ...(currentResultContext(continuationTurnId) as never),
      ownership: "native_continuation", originTurnId,
      chainTurnIds: [originTurnId, continuationTurnId], chainLength: 1,
      signature: "capacity_retry_automatic",
    } as never);

    const result = await runRecord(["--output", "continuation output"]);
    const payload = json(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload).toMatchObject({ ok: true, record: { commandId, outputId: expect.any(Number) } });
    expect(ownership).toHaveBeenCalledTimes(2);
    expect(readDesktop(workspace.id)?.deliveries[0]).toMatchObject({ deliveryStatus: "accepted", turnId: originTurnId });
    expect(readExecutionRecords(workspace.id)).toHaveLength(1);
  });

  it("outcome_unknown 当前 turn 一次 CLI 调用完成严格 self-reconcile 和 receipt", async () => {
    seedUnknownDelivery();
    const reconcile = vi.spyOn(desktopIpc, "reconcileUnknown").mockResolvedValue({
      threadId,
      hostId: "local",
      projectId: "desktop_result_project",
      workspaceRoot: root,
      candidates: [acceptedTurnId],
    });

    const result = await runRecord(["--output", "self-reconcile output"]);
    const payload = json(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload).toMatchObject({ ok: true, record: { commandId, outputId: expect.any(Number) } });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(readExecutionRecords(workspace.id)).toHaveLength(1);
    expect(listExecutionOutputs(workspace.id)).toHaveLength(1);
    expect(readDesktop(workspace.id)?.deliveries[0]).toMatchObject({ deliveryStatus: "accepted", turnId: acceptedTurnId });
  });

  it("错误线程拒绝记录，隐藏命令不出现在 help", async () => {
    vi.stubEnv("CODEX_THREAD_ID", "01a00000-0000-7000-8000-000000000002");
    const result = await runRecord([]);
    expect(result.exitCode).toBe(1);
    expect(json(result.stdout)).toMatchObject({ ok: false, error: "DESKTOP_RESULT_THREAD" });
    expect(readExecutionRecords(workspace.id)).toEqual([]);

    const program = new Command();
    registerDesktopCommands(program);
    const desktop = program.commands.find(command => command.name() === "desktop")!;
    expect(desktop.helpInformation()).not.toContain("record-result");
  });

  it("同一线程但 active turn 较新时拒绝，且不写入 record/output", async () => {
    vi.mocked(desktopIpc.currentResultContext).mockResolvedValue(currentResultContext(randomUUID()) as never);

    const result = await runRecord(["--output", "later turn 不应记录"]);
    expect(result.exitCode).toBe(1);
    expect(json(result.stdout)).toMatchObject({ ok: false });
    expect(readExecutionRecords(workspace.id)).toEqual([]);
    expect(listExecutionOutputs(workspace.id)).toEqual([]);
  });

  it("rejected delivery 即使 turnId 相同也拒绝，且不写入 record/output", async () => {
    rejectSeededDelivery();

    const result = await runRecord(["--output", "拒绝状态不应记录"]);
    expect(result.exitCode).toBe(1);
    expect(json(result.stdout)).toMatchObject({ ok: false });
    expect(readExecutionRecords(workspace.id)).toEqual([]);
    expect(listExecutionOutputs(workspace.id)).toEqual([]);
  });

  it("current result context 缺少 turn 标识时拒绝，不能仅凭 threadId 伪造", async () => {
    vi.mocked(desktopIpc.currentResultContext).mockResolvedValue(currentResultContext() as never);

    const result = await runRecord(["--output", "缺少 turn 标识不应记录"]);
    expect(result.exitCode).toBe(1);
    expect(json(result.stdout)).toMatchObject({ ok: false });
    expect(readExecutionRecords(workspace.id)).toEqual([]);
    expect(listExecutionOutputs(workspace.id)).toEqual([]);
  });

  it("核心字段 required、辅助字段 optional，output-file 超过 256 KiB 拒绝且不落盘", async () => {
    const program = new Command();
    registerDesktopCommands(program);
    const desktop = program.commands.find(command => command.name() === "desktop")!;
    const record = desktop.commands.find(command => command.name() === "record-result")!;
    for (const flag of ["--command-id", "--changed-files", "--tests", "--exit-status"]) {
      expect(record.options.find(option => option.long === flag)?.mandatory).toBe(true);
    }
    for (const flag of ["--command", "--output", "--output-file", "--exit-code", "--notes", "--json"]) {
      expect(record.options.find(option => option.long === flag)?.mandatory).not.toBe(true);
    }

    const oversized = path.join(root, "oversized-output.txt");
    fs.writeFileSync(oversized, "x".repeat(256 * 1024 + 1), "utf8");
    const result = await runRecord(["--output-file", oversized]);
    expect(result.exitCode).toBe(1);
    expect(json(result.stdout)).toMatchObject({ ok: false, error: "DESKTOP_RESULT_INVALID" });
    expect(readExecutionRecords(workspace.id)).toEqual([]);
    expect(fs.existsSync(desktopFile(workspace.id))).toBe(true);
  });

  it("output-file 读取 UTF-8 输出并保留 exit-code", async () => {
    const outputFile = path.join(root, "output.txt");
    const outputText = "测试输出：通过 ✅\n";
    fs.writeFileSync(outputFile, outputText, "utf8");

    const result = await runRecord(["--output-file", outputFile, "--exit-code", "7"]);
    const payload = json(result.stdout);
    const outputId = payload.record.outputId as number;
    expect(result.exitCode).toBe(0);
    expect(payload).toMatchObject({ ok: true, record: { commandId, outputId: expect.any(Number) } });
    expect(payload.output).toMatchObject({ id: outputId, exitCode: 7 });
    expect(readExecutionOutput(workspace.id, outputId)).toMatchObject({ ok: true, text: outputText });
  });

  it("拒绝同时指定 output 与 output-file", async () => {
    const outputFile = path.join(root, "output.txt");
    fs.writeFileSync(outputFile, "文件输出", "utf8");

    const result = await runRecord(["--output", "命令行输出", "--output-file", outputFile]);
    expect(result.exitCode).toBe(1);
    expect(json(result.stdout)).toMatchObject({ ok: false, error: "DESKTOP_RESULT_INVALID" });
    expect(readExecutionRecords(workspace.id)).toEqual([]);
  });
});
