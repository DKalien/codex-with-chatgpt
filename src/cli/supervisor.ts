import { Command, Option } from "commander";
import path from "node:path";
import { getStateDir } from "../config/paths.js";
import { Workspace } from "../workspace/manager.js";
import { readSupervisorConfig, readSupervisorRuntime, withSupervisorOperation } from "../supervisor/store.js";
import { inspectWindowsSupervisorTask, installWindowsSupervisorTask, uninstallWindowsSupervisorTask, WindowsTaskError } from "../supervisor/windows-task.js";
import { runInstalledSupervisor } from "../supervisor/run.js";
import { withSupervisorLifecycleFence } from "../supervisor/lifecycle.js";
import { probeProcess } from "../process/process-probe.js";
import { resolveDaemonSpawnHelperPath, resolveDaemonSpawnPython } from "../process/daemon-spawn.js";
import { isNamedTunnelReady, readTunnelState } from "../tunnel/state.js";
import { handleCliError, resolveWorkspace, say } from "./shared.js";

type Options = { workspace?: string; json?: boolean; tunnel?: boolean; stateDir?: string };
function context(opts: Options) {
  const workspace = new Workspace(resolveWorkspace(opts.workspace));
  return { workspace, input: { workspaceRoot: workspace.root, stateDir: getStateDir() } };
}
function requireCompatible(inspection: ReturnType<typeof inspectWindowsSupervisorTask>): void {
  if (inspection.status === "conflict") throw new WindowsTaskError("TASK_CONFLICT");
  if (inspection.status === "unsupported") throw new WindowsTaskError(inspection.errorCode ?? "SCHEDULER_UNAVAILABLE");
}
function requireNamed(workspace: Workspace, tunnel: boolean): void {
  if (!tunnel) return;
  const state = readTunnelState(workspace.id);
  if (!state || state.workspaceId !== workspace.id || state.preference !== "named" || state.provider !== "cloudflare-named" || !isNamedTunnelReady(state))
    throw new Error("SUPERVISOR_NAMED_TUNNEL_REQUIRED");
}
function output(opts: Options, value: unknown): void { say(opts.json ? JSON.stringify(value) : JSON.stringify(value, null, 2)); }

export function registerSupervisorCommands(program: Command): void {
  const group = program.command("supervisor").description("Manage independent per-user Bridge recovery");
  const command = (name: string, description: string) => group.command(name).description(description)
    .option("-w, --workspace <path>", "exact workspace root").option("--json", "machine-readable output", false);
  command("status", "Read supervisor configuration, registration and exact runtime identity")
    .action(async (opts: Options) => {
      try {
        const { workspace, input } = context(opts);
        const config = readSupervisorConfig(workspace.root), runtime = readSupervisorRuntime(workspace.root);
        const registration = inspectWindowsSupervisorTask(input);
        const identity = runtime ? await probeProcess(runtime.pid, resolveDaemonSpawnPython(), resolveDaemonSpawnHelperPath(), runtime.creationTime) : null;
        output(opts, { ok: registration.status !== "conflict" && registration.status !== "unsupported", config, registration, runtime, identity });
      } catch (error) { handleCliError(error, Boolean(opts.json)); }
    });
  command("install", "Register an exact current-user logon task and enable recovery")
    .option("--tunnel", "recover the existing named tunnel")
    .action(async (opts: Options) => {
      try {
        const { workspace, input } = context(opts);
        const result = await withSupervisorLifecycleFence(() => withSupervisorOperation(workspace.root, async tx => {
          const previous = tx.readConfig(), tunnel = opts.tunnel ?? previous?.tunnel ?? false;
          requireNamed(workspace, tunnel);
          // A partial registration remains paused. The loop shares this operation fence.
          tx.updateConfig({ desiredState: "stopped", tunnel, registrationMode: "none" });
          requireCompatible(inspectWindowsSupervisorTask(input));
          const registration = installWindowsSupervisorTask(input);
          const verified = inspectWindowsSupervisorTask(input);
          requireCompatible(verified);
          if (verified.status !== "owned") throw new WindowsTaskError("TASK_VERIFY_FAILED");
          const config = tx.updateConfig({ desiredState: "running", registrationMode: "windows-scheduled-task" });
          return { ok: true, config, registration };
        }));
        output(opts, result);
      } catch (error) { handleCliError(error, Boolean(opts.json)); }
    });
  command("pause", "Pause automatic recovery without shutting down the Bridge")
    .action(async (opts: Options) => {
      try {
        const { workspace } = context(opts);
        output(opts, await withSupervisorOperation(workspace.root, tx => ({ ok: true,
          config: tx.readConfig() ? tx.updateConfig({ desiredState: "stopped" }) : null })));
      } catch (error) { handleCliError(error, Boolean(opts.json)); }
    });
  command("uninstall", "Pause recovery and remove only the exact owned task")
    .action(async (opts: Options) => {
      try {
        const { workspace, input } = context(opts);
        const result = await withSupervisorOperation(workspace.root, tx => {
          const previous = tx.readConfig();
          if (previous) tx.updateConfig({ desiredState: "stopped" });
          requireCompatible(inspectWindowsSupervisorTask(input));
          const registration = uninstallWindowsSupervisorTask(input);
          const config = previous ? tx.updateConfig({ desiredState: "stopped", registrationMode: "none" }) : null;
          return { ok: true, config, registration };
        });
        output(opts, result);
      } catch (error) { handleCliError(error, Boolean(opts.json)); }
    });
  group.addCommand(new Command("run").description("Internal foreground Scheduled Task entry")
    .requiredOption("-w, --workspace <path>").addOption(new Option("--state-dir <path>").hideHelp())
    .action(async (opts: Options) => {
      if (!opts.stateDir || path.resolve(opts.stateDir) !== opts.stateDir) throw new Error("SUPERVISOR_STATE_DIR_REQUIRED");
      process.env.C2C_STATE_DIR = opts.stateDir;
      await runInstalledSupervisor(resolveWorkspace(opts.workspace));
    }), { hidden: true });
}
