import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { Workspace } from "../workspace/manager.js";
import { readSession } from "../session/state.js";
import {
  closeControlTask, completeControlCommand, controlBootPrompt, disableWebControl, enableWebControl,
  recoverControlCommand,
  reconcileControlCommand,
  markBootSent, markControlFeedbackSent, receiveControl, rejectControlCommand,
  startControlCommand, webControlStatus, listPendingControlFeedback,
} from "../session/web-control.js";

interface Options {
  workspace?: string; codexSession?: string; localUser?: boolean; url?: string;
  idleMinutes?: string; messageId?: string; commandId?: string; reason?: string; input?: string;
}

function owner(options: Options): string {
  const current = process.env.CODEX_THREAD_ID ?? process.env.CODEX_SESSION_ID;
  if (current && options.codexSession && current !== options.codexSession) {
    throw new Error("--codex-session 与当前 Codex task 不一致。");
  }
  const value = current ?? options.codexSession;
  if (!value || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error("缺少可靠的 Codex task ID；请提供实际 --codex-session，不能生成或猜测。");
  }
  return value;
}

function readEnvelope(file: string): unknown {
  // 固定上限，不能把网页文本直接插入 Shell；本地 Agent 用文件工具写入此 JSON。
  const fd = fs.openSync(path.resolve(file), "r");
  try {
    const buffer = Buffer.alloc(32769);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (size > 32768) throw new Error("网页观察 JSON 超过 32 KiB 上限。");
    try {
      return JSON.parse(buffer.subarray(0, size).toString("utf8").replace(/^\uFEFF/, ""));
    } catch { throw new Error("网页观察 JSON 格式无效；未回显输入内容。"); }
  } finally { fs.closeSync(fd); }
}

/** 仅本地 Skill 使用；不会注册到 Bridge、MCP 或 HTTP。 */
export function registerWebControlCommands(program: Command): void {
  const group = program.command("web-control").description("本地启用、校验和记录 ChatGPT 网页控制；不执行命令文本");
  const run = (command: Command, action: (workspaceId: string, options: Options) => unknown) => {
    command.option("-w, --workspace <path>")
      .option("--codex-session <id>", "当前真实 Codex task ID（默认读 CODEX_THREAD_ID）")
      .option("--json", "机器可读输出（默认）")
      .action((options: Options) => {
        try {
          const workspace = new Workspace(path.resolve(options.workspace ?? process.cwd()));
          const result = action(workspace.id, options);
          process.stdout.write(JSON.stringify({ ok: true, workspaceId: workspace.id, ...result as object }) + "\n");
        } catch (error) {
          const detail = error instanceof Error && error.name !== "ZodError" ? error.message : "网页控制参数或状态无效。";
          process.stdout.write(JSON.stringify({ ok: false, error: detail }) + "\n");
          process.exitCode = 1;
        }
      });
  };
  run(group.command("status"), (workspaceId) => {
    const state = webControlStatus(workspaceId);
    const pendingFeedback = state ? listPendingControlFeedback(workspaceId) : [];
    return { enabled: state?.enabled ?? false, state: state ?? null,
      pendingFeedback,
      projectUrl: readSession(workspaceId)?.projectUrl ?? null,
      listening: "仅当前 Agent 保持运行并等待网页时生效；此 CLI 不启动监听器。" };
  });
  run(group.command("enable").requiredOption("--url <url>")
    .option("--local-user", "仅在本地用户明确授权后传入")
    .option("--idle-minutes <minutes>", "空闲超时，1–240 分钟，默认 30"), (workspaceId, options) => {
      const state = enableWebControl(workspaceId, { localUser: options.localUser ?? false,
        codexSessionId: owner(options), conversationUrl: options.url!,
        idleTimeoutMinutes: options.idleMinutes === undefined ? undefined : Number(options.idleMinutes) });
      return { state, bootPrompt: controlBootPrompt(state) };
    });
  run(group.command("disable").option("--local-user", "仅在本地用户要求停止时传入"), (workspaceId, options) =>
    ({ enabled: false, state: disableWebControl(workspaceId, options.localUser ?? false) ?? null }));
  run(group.command("boot"), (workspaceId, options) => {
    const state = webControlStatus(workspaceId);
    if (!state?.enabled || state.codexSessionId !== owner(options)) throw new Error("当前 task 无有效控制会话。");
    return { alreadySent: !!state.bootMessageId, messageId: state.bootMessageId,
      bootPrompt: state.bootMessageId ? undefined : controlBootPrompt(state) };
  });
  run(group.command("boot-sent").requiredOption("--message-id <id>"), (workspaceId, options) =>
    ({ state: markBootSent(workspaceId, owner(options), options.messageId!) }));
  run(group.command("receive").requiredOption("--input <file>", "本地 Agent 核对来源后写入的 DOM 观察 JSON"), (workspaceId, options) =>
    receiveControl(workspaceId, owner(options), readEnvelope(options.input!)));
  run(group.command("start").requiredOption("--command-id <id>"), (workspaceId, options) =>
    ({ activeCommand: startControlCommand(workspaceId, owner(options), options.commandId!) }));
  run(group.command("reject").requiredOption("--command-id <id>").requiredOption("--reason <text>"), (workspaceId, options) =>
    ({ state: rejectControlCommand(workspaceId, owner(options), options.commandId!, options.reason!) }));
  run(group.command("complete").requiredOption("--command-id <id>"), (workspaceId, options) =>
    completeControlCommand(workspaceId, owner(options), options.commandId!));
  run(group.command("recover").requiredOption("--command-id <id>"), (workspaceId, options) =>
    recoverControlCommand(workspaceId, owner(options), options.commandId!));
  run(group.command("reconcile").requiredOption("--command-id <id>"), (workspaceId, options) =>
    reconcileControlCommand(workspaceId, owner(options), options.commandId!));
  run(group.command("close-task").requiredOption("--command-id <id>")
    .option("--local-user", "仅本地用户明确放弃已完成任务的后续网页 Review"), (workspaceId, options) =>
    ({ state: closeControlTask(workspaceId, owner(options), options.commandId!, options.localUser ?? false) }));
  run(group.command("feedback-sent").requiredOption("--command-id <id>").requiredOption("--message-id <id>"), (workspaceId, options) =>
    ({ state: markControlFeedbackSent(workspaceId, owner(options), options.commandId!, options.messageId!) }));
}
