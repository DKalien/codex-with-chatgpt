import { Command } from "commander";
import { Workspace } from "../workspace/manager.js";
import { bindCurrentDesktop } from "../desktop/service.js";
import {
  bindCurrentExecutor,
  executorStatus,
  listExecutorPlugins,
} from "../executor-control/service.js";
import { hasProductionExecutorPlugin } from "../executor-control/registry.js";
import { ExecutorControlError } from "../executor-control/schema.js";
import {
  CODEX_DESKTOP_EXECUTOR_ID,
  projectCodexDesktopTargetToExecutorBindingCandidate,
} from "../executor/index.js";
import { resolveWorkspace, say } from "./shared.js";

function print(data: unknown, json: boolean | undefined, human: string): void {
  if (json) say(JSON.stringify(data));
  else say(human);
}

/**
 * 本地显式 Executor 控制。不提供 MCP bind；绑定必须走本机确认。
 */
export function registerExecutorCommands(program: Command): void {
  const executor = program.command("executor").description("本地 Active Executor Binding 控制");

  executor
    .command("list")
    .description("列出 production Executor 插件")
    .option("--json", "machine-readable output")
    .action((opts: { json?: boolean }) => {
      const plugins = listExecutorPlugins();
      print({ plugins }, opts.json, plugins.map(p => `${p.pluginId}\t${p.name}`).join("\n") || "(empty)");
    });

  executor
    .command("status")
    .description("查看当前 workspace 的 active Executor Binding")
    .option("-w, --workspace <path>", "workspace root")
    .option("--json", "machine-readable output")
    .action(async (opts: { workspace?: string; json?: boolean }) => {
      const root = resolveWorkspace(opts.workspace);
      const workspace = new Workspace(root);
      const status = await executorStatus(workspace.id, workspace.root);
      const reason = status.availability.available ? "" : ` (${("reasonCode" in status.availability ? status.availability.reasonCode : "none")})`;
      print(
        status,
        opts.json,
        status.activeBinding
          ? `active ${status.activeBinding.pluginId} epoch=${status.activeBinding.epoch} available=${status.availability.available}`
          : `no active binding${reason}`,
      );
    });

  executor
    .command("bind-current")
    .description("本地确认后把当前 executor session 绑定为 active Executor Binding")
    .option("-w, --workspace <path>", "workspace root")
    .option("--plugin <id>", "executor plugin id", CODEX_DESKTOP_EXECUTOR_ID)
    .option("--json", "machine-readable output")
    .action(async (opts: { workspace?: string; plugin?: string; json?: boolean }) => {
      const root = resolveWorkspace(opts.workspace);
      const workspace = new Workspace(root);
      const pluginId = opts.plugin ?? CODEX_DESKTOP_EXECUTOR_ID;
      if (!hasProductionExecutorPlugin(pluginId)) {
        throw new ExecutorControlError(
          "EXECUTOR_CONTROL_UNKNOWN_PLUGIN",
          `production registry 仅支持 ${CODEX_DESKTOP_EXECUTOR_ID}。`,
        );
      }
      // 复用现有可信本地确认，不重新实现更弱的 confirmation。
      const desktop = await bindCurrentDesktop(workspace);
      // 从已确认 Desktop binding 投影 candidate，避免二次 discover 选中未确认会话。
      const confirmed = desktop.binding;
      const candidate = projectCodexDesktopTargetToExecutorBindingCandidate({
        target: {
          threadId: confirmed.threadId,
          hostId: confirmed.hostId,
          projectId: confirmed.projectId,
          workspaceRoot: workspace.root,
        },
        workspaceId: workspace.id,
        instanceId: confirmed.hostId,
      });
      const result = bindCurrentExecutor(workspace.id, workspace.root, candidate);
      print(
        {
          created: result.created,
          binding: result.binding,
          desktopBindingId: desktop.binding.bindingId,
        },
        opts.json,
        result.created
          ? `bound ${result.binding.pluginId} bindingId=${result.binding.bindingId} epoch=${result.binding.epoch}`
          : `unchanged ${result.binding.pluginId} bindingId=${result.binding.bindingId} epoch=${result.binding.epoch}`,
      );
    });
}
