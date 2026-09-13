import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerDesktopCommands } from "../src/cli/desktop.js";
import * as abandonment from "../src/desktop/abandonment.js";
import * as history from "../src/desktop/history.js";
import { DesktopError } from "../src/desktop/store.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const NOTICE = "仅停止等待，不代表完成/成功";
const COMMAND_IDS = ["historical-one", "historical-two"];
const CONFIRMATION = "a".repeat(64);

let root: string;
let stateDir: string;
let workspace: Workspace;

beforeEach(() => {
  root = makeTmpDir("desktop-abandonment-cli-workspace");
  stateDir = makeTmpDir("desktop-abandonment-cli-state");
  workspace = new Workspace(root);
  vi.stubEnv("C2C_STATE_DIR", stateDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  cleanup(root);
  cleanup(stateDir);
});

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string }> {
  const program = new Command().exitOverride();
  registerDesktopCommands(program);
  const output: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    await program.parseAsync(["node", "c2c", ...args]);
    return { exitCode: process.exitCode ?? 0, stdout: output.join("") };
  } finally {
    write.mockRestore();
    process.exitCode = previousExitCode;
  }
}

function jsonOf(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("desktop abandonment/history CLI", () => {
  it("省略 confirmation 时只做 preview，不写入状态并保留固定 notice", async () => {
    const preview = vi.spyOn(abandonment, "previewAbandonment").mockReturnValue({
      commandIds: COMMAND_IDS,
      confirmationSha256: CONFIRMATION,
      notice: NOTICE,
    } as never);
    const abandon = vi.spyOn(abandonment, "abandonHistoricalAccepted");
    const before = fs.readdirSync(stateDir);

    const result = await runCli([
      "desktop", "abandon", "-w", root, "--command-ids", COMMAND_IDS.join(","), "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(jsonOf(result.stdout)).toEqual({ ok: true, commandIds: COMMAND_IDS, confirmationSha256: CONFIRMATION, notice: NOTICE });
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ id: workspace.id, root: workspace.root }), COMMAND_IDS);
    expect(abandon).not.toHaveBeenCalled();
    expect(fs.readdirSync(stateDir)).toEqual(before);
  });

  it("普通文本预览显示精确集合、确认摘要和行政语义", async () => {
    vi.spyOn(abandonment, "previewAbandonment").mockReturnValue({
      commandIds: COMMAND_IDS, confirmationSha256: CONFIRMATION, notice: NOTICE,
    });
    const abandon = vi.spyOn(abandonment, "abandonHistoricalAccepted");
    const result = await runCli(["desktop", "abandon", "-w", root, "--command-ids", COMMAND_IDS.join(",")]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(NOTICE);
    expect(result.stdout).toContain(COMMAND_IDS.join(","));
    expect(result.stdout).toContain(`--confirm ${CONFIRMATION}`);
    expect(abandon).not.toHaveBeenCalled();
  });

  it("拒绝非法 confirmation，错误只返回固定 code/message 且不写入", async () => {
    const preview = vi.spyOn(abandonment, "previewAbandonment");
    const abandon = vi.spyOn(abandonment, "abandonHistoricalAccepted");
    const before = fs.readdirSync(stateDir);

    const result = await runCli([
      "desktop", "abandon", "-w", root, "--command-ids", COMMAND_IDS.join(","), "--confirm", "bad", "--json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(jsonOf(result.stdout)).toEqual({
      ok: false,
      error: "DESKTOP_ABANDONMENT_CONFIRMATION_INVALID",
      message: "confirmation 摘要必须是 64 位十六进制值；未修改状态。",
    });
    expect(preview).not.toHaveBeenCalled();
    expect(abandon).not.toHaveBeenCalled();
    expect(fs.readdirSync(stateDir)).toEqual(before);
  });

  it("confirmation 摘要不匹配时拒绝并隐藏异常原文", async () => {
    vi.spyOn(abandonment, "abandonHistoricalAccepted").mockRejectedValue(
      new DesktopError("DESKTOP_ABANDONMENT_CONFIRMATION_MISMATCH", "secret internal details"),
    );

    const result = await runCli([
      "desktop", "abandon", "-w", root, "--command-ids", COMMAND_IDS.join(","), "--confirm", CONFIRMATION, "--json",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain("secret internal details");
    expect(jsonOf(result.stdout)).toEqual({
      ok: false,
      error: "DESKTOP_ABANDONMENT_CONFIRMATION_MISMATCH",
      message: "confirmation 摘要不匹配；未修改状态。",
    });
  });

  it("正确 confirmation 才调用显式写入入口并保留 commandId 顺序", async () => {
    const abandon = vi.spyOn(abandonment, "abandonHistoricalAccepted").mockResolvedValue({
      commandIds: COMMAND_IDS,
      status: "abandoned",
      notice: NOTICE,
    } as never);

    const result = await runCli([
      "desktop", "abandon", "-w", root, "--command-ids", COMMAND_IDS.join(","), "--confirm", CONFIRMATION, "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(jsonOf(result.stdout)).toEqual({ ok: true, commandIds: COMMAND_IDS, status: "abandoned", notice: NOTICE });
    expect(abandon).toHaveBeenCalledWith(expect.objectContaining({ id: workspace.id, root: workspace.root }), COMMAND_IDS, CONFIRMATION);
  });

  it.each(["historical-one,historical-one", "historical-one,,historical-two", "historical-one, historical-two"])(
    "拒绝重复或空白 commandId 列表：%s",
    async commandIds => {
      const preview = vi.spyOn(abandonment, "previewAbandonment");
      const abandon = vi.spyOn(abandonment, "abandonHistoricalAccepted");
      const result = await runCli(["desktop", "abandon", "-w", root, "--command-ids", commandIds, "--json"]);

      expect(result.exitCode).toBe(1);
      expect(jsonOf(result.stdout)).toMatchObject({ ok: false, error: "DESKTOP_ABANDONMENT_INVALID" });
      expect(preview).not.toHaveBeenCalled();
      expect(abandon).not.toHaveBeenCalled();
    },
  );

  it("history 只读调用统一列表，并且每项只返回 commandId/status", async () => {
    vi.spyOn(history, "listDesktopHistory").mockReturnValue([{
      commandId: "one", status: "unresolved", detail: "secret",
    }] as never);
    const before = fs.readdirSync(stateDir);

    const result = await runCli(["desktop", "history", "-w", root, "--json"]);

    expect(result.exitCode).toBe(0);
    expect(jsonOf(result.stdout)).toEqual({ ok: true, items: [{ commandId: "one", status: "unresolved" }] });
    expect(history.listDesktopHistory).toHaveBeenCalledWith(expect.objectContaining({ id: workspace.id, root: workspace.root }));
    expect(fs.readdirSync(stateDir)).toEqual(before);
  });

  it("help 显示固定 abandonment notice，且不存在动态 --all 入口", () => {
    const program = new Command();
    registerDesktopCommands(program);
    const desktop = program.commands.find(command => command.name() === "desktop")!;
    const abandon = desktop.commands.find(command => command.name() === "abandon")!;

    expect(abandon.description()).toContain(NOTICE.slice(0, -1));
    expect(abandon.helpInformation()).toContain("--command-ids <ids>");
    expect(abandon.helpInformation()).toContain("--confirm <sha256>");
    expect(abandon.helpInformation()).not.toContain("--all");
  });

  it("非法 argv 被 Commander 拒绝，不提供 --all 或默认全选", async () => {
    const program = new Command().exitOverride();
    registerDesktopCommands(program);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(program.parseAsync(["node", "c2c", "desktop", "abandon", "-w", root, "--all", "--json"])).rejects.toThrow();
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });
});
