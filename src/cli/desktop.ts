import type { Command } from "commander";
import fs from "node:fs";
import { Workspace } from "../workspace/manager.js";
import { bindCurrentDesktop, bindDesktop, desktopStatus, disableDesktop, enableDesktop } from "../desktop/service.js";
import { DesktopError, targetInput } from "../desktop/store.js";
import { recordDesktopResult } from "../desktop/result.js";

const say = (message: string): void => { process.stdout.write(`${message}\n`); };

function workspaceRoot(option?: string): string {
  return option ? option : process.cwd();
}

function print(payload: unknown, json: boolean, message: string): void {
  if (json) say(JSON.stringify(payload));
  else say(message);
}

export function registerDesktopCommands(program: Command): void {
  const desktop = program.command("desktop").description("管理本机已绑定的 Desktop Control 会话");

  desktop.command("record-result", { hidden: true })
    .description("记录当前 Desktop turn 的执行结果（仅本机）")
    .option("-w, --workspace <path>", "workspace 根目录")
    .requiredOption("--command-id <id>", "原 accepted commandId")
    .requiredOption("--changed-files <files>", "本轮实际修改文件，逗号分隔；无修改传空字符串")
    .requiredOption("--tests <summary>", "本轮测试摘要；未运行填 not run")
    .requiredOption("--exit-status <status>", "ok / failed / blocked")
    .option("--notes <text>", "本轮说明")
    .option("--command <text>", "已执行命令的描述，不执行此文本")
    .option("--output <text>", "已执行命令的输出")
    .option("--output-file <path>", "已执行命令的 UTF-8 汇总输出文件，最多 256 KiB")
    .option("--exit-code <code>", "已执行命令的退出码")
    .option("--json", "输出机器可读结果", false)
    .action(async (opts: { workspace?: string; commandId: string; changedFiles: string; tests: string;
      exitStatus: "ok" | "failed" | "blocked"; notes?: string; command?: string; output?: string;
      outputFile?: string; exitCode?: string; json: boolean }) => {
      try {
        if (opts.output !== undefined && opts.outputFile !== undefined) {
          throw new DesktopError("DESKTOP_RESULT_INVALID", "output 与 output-file 不能同时指定。");
        }
        let output = opts.output;
        if (opts.outputFile !== undefined) {
          const fd = fs.openSync(opts.outputFile, "r");
          try {
            const buffer = Buffer.alloc(256 * 1024 + 1);
            const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
            if (count === buffer.length) throw new DesktopError("DESKTOP_RESULT_INVALID", "输出文件超过 256 KiB；请先生成本轮汇总，不会截断证据。");
            output = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count));
          } finally { fs.closeSync(fd); }
        }
        if (opts.exitCode !== undefined && (!/^-?\d+$/.test(opts.exitCode) || !Number.isSafeInteger(Number(opts.exitCode)))) {
          throw new DesktopError("DESKTOP_RESULT_INVALID", "exit-code 必须为安全整数。");
        }
        const result = await recordDesktopResult(new Workspace(workspaceRoot(opts.workspace)), {
          commandId: opts.commandId, changedFiles: opts.changedFiles.split(",").map(file => file.trim()).filter(Boolean),
          tests: opts.tests, exitStatus: opts.exitStatus, notes: opts.notes, command: opts.command,
          output, exitCode: opts.exitCode === undefined ? undefined : Number(opts.exitCode),
        });
        print({ ok: true, ...result }, opts.json, "本轮 Desktop execution receipt 已记录。");
      } catch (error) {
        const code = error instanceof DesktopError ? error.code : "DESKTOP_RESULT_INVALID";
        const message = error instanceof DesktopError ? error.message : "执行结果记录失败；未确认验收闭环完成。";
        print({ ok: false, error: code, message }, opts.json, message);
        process.exitCode = 1;
      }
    });

  desktop.command("bind-current")
    .description("识别当前 Desktop 会话，经本机确认后绑定并启用")
    .option("-w, --workspace <path>", "workspace 根目录")
    .option("--json", "输出机器可读结果", false)
    .action(async (opts: { workspace?: string; json: boolean }) => {
      try {
        const result = await bindCurrentDesktop(new Workspace(workspaceRoot(opts.workspace)));
        print({ ok: true, ...result }, opts.json, result.alreadyEnabled ?
          "当前会话已绑定并启用，ChatGPT 可以向这里发送任务。" : "已绑定并启用当前会话，ChatGPT 现在可以向这里发送任务。");
      } catch (error) {
        const code = error instanceof DesktopError ? error.code : "DESKTOP_CURRENT_CONTEXT_INVALID";
        const message = error instanceof DesktopError ? error.message : "无法确认当前 Desktop 会话；未绑定或启用。";
        print({ ok: false, error: code, message }, opts.json, message);
        process.exitCode = 1;
      }
    });

  desktop.command("bind")
    .description("绑定一个由本机用户明确指定的 Desktop 会话")
    .option("-w, --workspace <path>", "workspace 根目录")
    .requiredOption("--thread <threadId>", "Desktop threadId")
    .requiredOption("--host <hostId>", "Desktop hostId")
    .requiredOption("--project <projectId>", "Desktop projectId")
    .option("--json", "machine-readable output", false)
    .action(async (opts: { workspace?: string; thread: string; host: string; project: string; json: boolean }) => {
      const workspace = new Workspace(workspaceRoot(opts.workspace));
      const target = targetInput.parse({
        threadId: opts.thread,
        hostId: opts.host,
        projectId: opts.project,
      });
      const binding = await bindDesktop(workspace, target);
      print({ ok: true, binding }, opts.json, `已绑定 Desktop 会话「${binding.title}」（threadId：${binding.threadId}，bindingId：${binding.bindingId}）。重新绑定后须重新启用。`);
    });

  desktop.command("enable")
    .description("启用当前 Desktop 绑定；必须明确接受 Desktop 权限风险")
    .option("-w, --workspace <path>", "workspace 根目录")
    .requiredOption("--binding <bindingId>", "当前绑定 ID")
    .option("--accept-desktop-permissions", "确认任务可能按 Desktop 会话权限修改文件或执行命令", false)
    .option("--json", "machine-readable output", false)
    .action((opts: { workspace?: string; binding: string; acceptDesktopPermissions: boolean; json: boolean }) => {
      if (!opts.acceptDesktopPermissions) {
        throw new DesktopError("DESKTOP_PERMISSION_CONFIRMATION_REQUIRED", "启用 Desktop Control 前必须指定 --accept-desktop-permissions，并确认任务可能按该 Desktop 会话的现有权限修改文件或执行命令。" );
      }
      const workspace = new Workspace(workspaceRoot(opts.workspace));
      enableDesktop(workspace, opts.binding);
      const notice = "启用期间，获授权客户端可向此绑定会话发送任务；任务可能按该 Desktop 会话现有权限修改文件或执行命令，可随时使用 desktop disable 撤权。";
      print({ ok: true, enabled: true, bindingId: opts.binding, notice }, opts.json, `Desktop Control 已启用（bindingId：${opts.binding}）。${notice}`);
    });

  desktop.command("disable")
    .description("撤销本机 Desktop Control 授权")
    .option("-w, --workspace <path>", "workspace 根目录")
    .option("--json", "machine-readable output", false)
    .action((opts: { workspace?: string; json: boolean }) => {
      const workspace = new Workspace(workspaceRoot(opts.workspace));
      disableDesktop(workspace);
      print({ ok: true, enabled: false }, opts.json, "Desktop Control 已撤权；绑定和投递历史仍保留。" );
    });

  desktop.command("status")
    .description("查看 Desktop 绑定、可用性和投递状态")
    .option("-w, --workspace <path>", "workspace 根目录")
    .option("--command-id <commandId>", "只查看指定投递")
    .option("--json", "machine-readable output", false)
    .action(async (opts: { workspace?: string; commandId?: string; json: boolean }) => {
      const workspace = new Workspace(workspaceRoot(opts.workspace));
      const status = await desktopStatus(workspace, opts.commandId);
      print({ ok: true, ...status }, opts.json, `Desktop Control：${status.enabled ? "已启用" : "未启用"}；绑定：${status.binding?.title ?? "无"}；可用性：${status.availability.available ? "可用" : "不可用"}。`);
    });
}
