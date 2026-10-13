import { previewWorkspaceHistoryFormat, confirmWorkspaceHistoryFormat } from "../command-cleanup/workspace-history.js";
import { CommandCleanupError } from "../command-cleanup/schema.js";
import type { Command } from "commander";
import { Workspace } from "../workspace/manager.js";
import { previewCommandCleanup, confirmCommandCleanup } from "../command-cleanup/service.js";
import { previewLegacyHistoryCleanup, confirmLegacyHistoryCleanup } from "../command-cleanup/legacy-history.js";

export function registerCleanupCommands(program: Command): void {
  const group = program.command("cleanup").description("command 运行时状态清理");
  group.command("workspace-history").description("本机预览并永久格式化当前工作区任务历史，保留连接配置")
    .requiredOption("-w, --workspace <path>", "workspace root")
    .option("--confirm <sha256>", "本次预览摘要；未提供时只读")
    .option("--local-user", "本机用户明确授权永久清空", false)
    .option("--json", "JSON 输出", false)
    .action((opts: { workspace: string; confirm?: string; localUser: boolean }) => {
      try {
        const workspace = new Workspace(opts.workspace);
        if (opts.confirm && !opts.localUser) throw new CommandCleanupError("PANEL_LOCAL_AUTHORIZATION_REQUIRED", "永久格式化需要本机 --local-user 明确授权。");
        const result = opts.confirm ? confirmWorkspaceHistoryFormat(workspace, opts.confirm) : previewWorkspaceHistoryFormat(workspace);
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } catch (error) {
        process.exitCode = 1;
        process.stdout.write(`${JSON.stringify({ status: "blocked", code: (error as { code?: string }).code ?? "WORKSPACE_HISTORY_FAILED" })}\n`);
      }
    });
  group.command("legacy-history").description("任务队列清空后，精确预览/确认删除剩余旧执行记录与输出")
    .requiredOption("-w, --workspace <path>", "workspace root")
    .option("--confirm <sha256>", "本次预览摘要；未提供时只读")
    .option("--json", "JSON 输出", false)
    .action((opts: { workspace: string; confirm?: string }) => {
      try {
        const workspace = new Workspace(opts.workspace);
        const result = opts.confirm ? confirmLegacyHistoryCleanup(workspace, opts.confirm) : previewLegacyHistoryCleanup(workspace);
        process.stdout.write(`${JSON.stringify(result)}\n`);
      } catch (error) {
        process.exitCode = 1;
        process.stdout.write(`${JSON.stringify({ status: "blocked", code: (error as { code?: string }).code ?? "LEGACY_HISTORY_FAILED" })}\n`);
      }
    });
  group
    .command("command").description("exact command preview；--confirm 后本地强制放弃并物理删除")
    .requiredOption("-w, --workspace <path>", "workspace root")
    .requiredOption("--command-id <id>", "exact commandId")
    .option("--confirm <sha256>", "使用本次 preview 返回的 confirmationSha256")
    .option("--json", "JSON 输出", false)
    .action((opts: { workspace: string; commandId: string; confirm?: string; json: boolean }) => {
      try {
        const workspace = new Workspace(opts.workspace);
        const target = { workspaceId: workspace.id, workspaceRoot: workspace.root, commandId: opts.commandId, iteration: 1 };
        const result = opts.confirm ? confirmCommandCleanup(target, opts.confirm) : previewCommandCleanup(target);
        process.stdout.write(`${opts.json ? JSON.stringify(result) : JSON.stringify(result, null, 2)}\n`);
      } catch (error) {
        process.exitCode = 1;
        const bounded = { status: "blocked", code: error && typeof error === "object" && "code" in error ? error.code : "COMMAND_CLEANUP_FAILED" };
        process.stdout.write(`${JSON.stringify(bounded)}\n`);
      }
    });
}
