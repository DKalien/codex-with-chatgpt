import type { Command } from "commander";
import { startBridge } from "../bridge/server.js";
import {
  tryAcquireMaintenanceLock,
  MaintenanceBusyError,
  appendCleanupError,
  releaseMaintenanceOrThrow,
  type MaintenanceLockHandle,
} from "../core/maintenance-lock.js";
import {
  claimStartupLease,
  consumeStartupLeaseFromEnv,
  createStartLock,
  type StartLockHandle,
} from "../core/startup-lease.js";
import { Workspace } from "../workspace/manager.js";
import { Logger } from "../logger/index.js";
import { getStateDir } from "../config/paths.js";
import { resolveWorkspace, say } from "./shared.js";

export function registerServerCommand(program: Command): void {
program
  .command("serve", { hidden: true })
  .description("Run the bridge in the foreground (internal)")
  .requiredOption("--workspace <path>")
  .option("--port <port>", "preferred port")
  .action(async (opts: { workspace: string; port?: string }) => {
    const logger = new Logger({ name: "bridge", console: true });
    const workspaceRoot = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(workspaceRoot);
    const port = opts.port ? parseInt(opts.port, 10) : undefined;
    // one-shot：读取后立即从 env 删除，避免 grandchild 继承。
    const lease = consumeStartupLeaseFromEnv();
    let ownedMaintenance: MaintenanceLockHandle | null = null;
    const ownedStartLocks: StartLockHandle[] = [];

    const start = async (): Promise<Awaited<ReturnType<typeof startBridge>>> => {
      const stateDir = getStateDir();
      if (lease) {
        // parent ensureBridge 已持有 maintenance + start.lock；child 做跨进程 one-shot claim。
        claimStartupLease(lease, workspace);
        return startBridge({ workspaceRoot, port, logger });
      }
      // 直接 serve：在 persistRuntime 落盘前自持 fence，防止与 GC destructive 并发。
      const acquired = tryAcquireMaintenanceLock(stateDir, "bridge-serve");
      if (!acquired.ok) throw new MaintenanceBusyError("serve 需要 machine maintenance lock，当前繁忙");
      ownedMaintenance = acquired.handle;
      ownedStartLocks.push(createStartLock(stateDir, workspace.id));
      return startBridge({ workspaceRoot, port, logger });
    };

    let bridge: Awaited<ReturnType<typeof startBridge>> | undefined;
    let actionError: unknown = null;
    try {
      bridge = await start();
    } catch (error) {
      actionError = error;
    }
    for (const startLock of ownedStartLocks) {
      if (!startLock.release()) {
        const startError = new Error("start.lock release failed");
        if (actionError) appendCleanupError(actionError, startError);
        else {
          (startError as { result?: unknown }).result = bridge;
          actionError = startError;
        }
      }
    }
    releaseMaintenanceOrThrow(ownedMaintenance, { result: bridge, actionError: actionError ?? undefined });
    const started = bridge!;
    const shutdown = (reason: "SIGINT" | "SIGTERM"): void => {
      void started.close(reason).then(() => process.exit(0));
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    say(`bridge ready on ${started.localBaseUrl()} (workspace ${started.workspace.name})`);
  });
}
