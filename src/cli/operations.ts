import type { Command } from "commander";
import { Workspace } from "../workspace/manager.js";
import { grantPanelActions, revokePanelActions, readPanelAuthorization } from "../feedback/panel.js";
import { withDeliveryArbiter } from "../bridge/delivery-arbiter.js";

/** Local confirmation surface; no machine authority is exported to the extension. */
export function registerOperationsCommands(program: Command): void {
  const group = program.command("operations").description("浏览器任务面板的本机授权（默认关闭）");
  const add = (command: Command, action: (workspace: Workspace, options: any) => unknown) => command
    .requiredOption("-w, --workspace <path>").option("--json")
    .action(options => {
      try { process.stdout.write(`${JSON.stringify(action(new Workspace(options.workspace), options))}\n`); }
      catch (error) {
        process.exitCode = 1;
        process.stdout.write(`${JSON.stringify({ status: "blocked", code: (error as { code?: string }).code ?? "PANEL_STATE_UNAVAILABLE" })}\n`);
      }
    });
  add(group.command("status"), workspace => readPanelAuthorization(workspace.id));
  add(group.command("authorize").requiredOption("--companion-id <id>")
    .option("--minutes <number>", "授权分钟数，1–60", "15").option("--local-user", "仅本机用户明确同意后使用"), (workspace, options) =>
    withDeliveryArbiter({ workspaceId: workspace.id, workspaceRoot: workspace.root }, () => grantPanelActions({
      workspaceId: workspace.id, companionId: options.companionId, localUser: options.localUser === true, minutes: Number(options.minutes),
    })));
  add(group.command("revoke").option("--local-user", "本机用户明确撤销授权"), (workspace, options) =>
    withDeliveryArbiter({ workspaceId: workspace.id, workspaceRoot: workspace.root }, () => {
      revokePanelActions(workspace.id, options.localUser === true); return { revoked: true };
    }));
}
