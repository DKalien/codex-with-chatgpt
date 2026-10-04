import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, getStateDir } from "../config/paths.js";
import { adminFetch, findBridgeObservation, findLiveBridge, type RuntimeState } from "../bridge/runtime.js";
import { Workspace } from "../workspace/manager.js";
import type { DesktopCompatibility } from "../auth/store.js";
import { detectTunnelBinaries } from "../tunnel/detect.js";
import { buildDaemonEnv, spawnDetachedDaemon, resolveDaemonSpawnHelperPath, resolveDaemonSpawnPython } from "./daemon-spawn.js";
import { observeProcessPresence, probeProcess } from "./process-probe.js";
import { persistSpawnProvenance, type LaunchIdentity, type readBridgeProvenance } from "./bridge-provenance.js";
import { isRuntimeBuildId } from "../build-id.js";
import {
  tryAcquireMaintenanceLock,
  assertMaintenanceHandle,
  MaintenanceBusyError,
  appendCleanupError,
  releaseMaintenanceOrThrow,
  type MaintenanceLockHandle,
} from "../core/maintenance-lock.js";
import {
  STARTUP_LEASE_ENV,
  cleanupStartupLeaseClaim,
  createStartLock,
  encodeStartupLease,
  issueStartupLease,
  type StartupLease,
} from "../core/startup-lease.js";

export { adminFetch } from "../bridge/runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Path to the CLI entry, works from dist/ and from tsx dev runs. */
function cliEntry(): { cmd: string; args: string[] } {
  const distEntry = path.resolve(__dirname, "..", "cli", "index.js");
  if (fs.existsSync(distEntry)) {
    return { cmd: process.execPath, args: [distEntry] };
  }
  // dev fallback: run TypeScript sources through the tsx ESM loader
  const projectRoot = path.resolve(__dirname, "..", "..");
  const tsEntry = path.join(projectRoot, "src", "cli", "index.ts");
  return { cmd: process.execPath, args: ["--import", "tsx/esm", tsEntry] };
}

export interface EnsureBridgeResult {
  runtime: RuntimeState;
  spawned: boolean;
}

/** 构造 serve 参数；0 是有效的 ephemeral port，不能按 false 处理。 */
export function buildServeArgs(baseArgs: string[], workspaceRoot: string, port?: number): string[] {
  return [
    ...baseArgs,
    "serve",
    "--workspace",
    workspaceRoot,
    ...(port !== undefined ? ["--port", String(port)] : []),
  ];
}

/**
 * Ensure a bridge is running for the workspace. Reuses a live instance,
 * otherwise spawns a detached daemon and waits for it to become healthy.
 */
export async function ensureBridge(workspaceRoot: string, opts: {
  port?: number;
  /** rollout 已持有 maintenance 时传入，避免 nested self-deadlock。 */
  maintenance?: MaintenanceLockHandle;
} = {}): Promise<EnsureBridgeResult> {
  const workspace = new Workspace(workspaceRoot);
  const stateDir = getStateDir();
  const start = createStartLock(stateDir, workspace.id);
  let ownedMaintenance: MaintenanceLockHandle | null = null;
  if (opts.maintenance) {
    try {
      assertMaintenanceHandle(stateDir, opts.maintenance);
    } catch (error) {
      start.release();
      throw error;
    }
  } else {
    const acquired = tryAcquireMaintenanceLock(stateDir, "bridge-start");
    if (!acquired.ok) {
      start.release();
      throw new MaintenanceBusyError("Bridge start 需要 machine maintenance lock，当前繁忙");
    }
    ownedMaintenance = acquired.handle;
  }
  const maintenance = opts.maintenance ?? ownedMaintenance!;
  const lease = issueStartupLease({ stateDir, workspace, maintenance, startLockNonce: start.nonce });
  let result: EnsureBridgeResult | undefined;
  let actionError: unknown = null;
  try {
    result = await ensureUnlocked(workspace, { ...opts, startupLease: lease });
  } catch (error) {
    actionError = error;
  }
  // fail-closed：start.lock 未成功退休时保留 claim，避免同 lease 再 claim 窗口。
  const startReleased = start.release();
  if (startReleased) {
    cleanupStartupLeaseClaim(stateDir, lease);
  } else {
    const startError = new Error("start.lock release failed");
    if (actionError) appendCleanupError(actionError, startError);
    else {
      (startError as { result?: EnsureBridgeResult }).result = result;
      actionError = startError;
    }
  }
  releaseMaintenanceOrThrow(ownedMaintenance, { result, actionError: actionError ?? undefined });
  return result!;
}

export type { StartupLease };

async function ensureUnlocked(workspace: Workspace, opts: { port?: number; startupLease?: StartupLease }): Promise<EnsureBridgeResult> {
  const observation = await findBridgeObservation(workspace.id);
  if (observation.state === "healthy") return { runtime: observation.runtime, spawned: false };
  if (observation.state === "unknown") {
    throw new Error(
      `Bridge state is uncertain (${observation.reason}); refusing to start another bridge.`
    );
  }

  const logDir = ensureDir(path.join(getStateDir(), "logs"));
  const logFile = path.join(logDir, `bridge-${workspace.id}.out.log`);
  try {
    // Existing files may have been created with a permissive umask. Keep the
    // daemon's inherited stdout/stderr log owner-readable only.
    fs.chmodSync(logFile, 0o600);
  } catch {
    // Windows / filesystems without chmod semantics
  }
  const { cmd, args } = cliEntry();
  // R5f prework（DAEMON_ENV_SANITIZATION，exact allowlist）：env 交接文件落盘，
  // 禁止把完整父 process.env 写盘——只投影 OS/runtime/path 变量与 Bridge 实际
  // 读取的显式 C2C 配置（未知父 secrets/上下文一律排除）；startup lease 在投影
  // 之后显式注入 fresh 值，不继承旧父进程 lease。
  const env = buildDaemonEnv(process.env);
  if (opts.startupLease) env[STARTUP_LEASE_ENV] = encodeStartupLease(opts.startupLease);
  // detached 只脱离父进程生命周期；Windows 下还需脱离 Job（kill-on-close）与
  // taskkill /T 父链，否则宿主（如 Codex）退出时会连带杀死 daemon。
  const entryPath = args[args.length - 1];
  let buildId: string | null = null;
  try {
    const value = fs.readFileSync(path.resolve(path.dirname(entryPath), "..", "build-id.txt"), "utf8").trim();
    if (isRuntimeBuildId(value)) buildId = value;
  } catch { /* source launch: build identity unavailable */ }
  const launch: LaunchIdentity = { entryPath, buildId };
  const spawned = await spawnDetachedDaemon({ cmd, args: buildServeArgs(args, workspace.root, opts.port), logFile, env });
  const { pid } = spawned;

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const runtime = await findLiveBridge(workspace.id);
    if (runtime) {
      try {
        const confirmed = await adminFetch<BridgeAdminInfo>(runtime, "GET", "/admin/info", 2000);
        if (confirmed.pid !== pid || confirmed.startedAt !== runtime.startedAt || confirmed.workspaceId !== workspace.id ||
          confirmed.workspaceRoot !== workspace.root || (confirmed.runtimeBuildId ?? null) !== (runtime.runtimeBuildId ?? null))
          throw new Error("BRIDGE_PROVENANCE_CONFLICT");
        const healthyProcess = await probeProcess(pid, resolveDaemonSpawnPython(), resolveDaemonSpawnHelperPath(), spawned.finalProcess.creationTime ?? undefined);
        persistSpawnProvenance(runtime, workspace, spawned, launch, healthyProcess);
      } catch {
        // Diagnostics cannot make an already healthy Bridge unavailable. Never log raw errors/argv/env.
        try { fs.appendFileSync(logFile, "[bridge-provenance] unavailable_or_conflict\n"); } catch { /* diagnostic only */ }
      }
      return { runtime, spawned: true };
    }
    if (await observeProcessPresence(pid) === "missing") {
      throw new Error(`Bridge process exited during startup. See ${logFile}`);
    }
  }
  throw new Error(`Bridge did not become healthy within 20s. See ${logFile}`);
}

function sameRuntime(a: RuntimeState, b: RuntimeState): boolean {
  return a.workspaceId === b.workspaceId && a.workspaceRoot === b.workspaceRoot &&
    a.pid === b.pid && a.startedAt === b.startedAt && a.port === b.port && a.adminToken === b.adminToken;
}

/** True confirms authenticated shutdown acceptance only; it does not prove OS process exit. */
export async function stopBridge(workspaceRoot: string, expectedRuntime?: RuntimeState, reason?: "restart" | "rollout"): Promise<boolean> {
  const workspace = new Workspace(workspaceRoot);
  const observation = await findBridgeObservation(workspace.id);
  if (observation.state !== "healthy") return false;
  if (observation.runtime.workspaceRoot !== workspace.root ||
    (expectedRuntime && !sameRuntime(observation.runtime, expectedRuntime))) return false;
  try {
    // admin token 绑定此 runtime；端口在检查后被复用也不能关闭对方。绝不按旧 PID 盲目 kill。
    await adminFetch(observation.runtime, "POST", "/admin/shutdown", 5000, reason ? { shutdownReason: reason } : undefined);
    return true;
  } catch {
    return false;
  }
}

export interface BridgeAdminInfo {
  service: string;
  workspaceId: string;
  workspaceName: string;
  workspaceRoot: string;
  port: number;
  publicUrl: string | null;
  tunnel: { running: boolean; url: string | null; provider: string };
  tokenCount: number;
  desktopCompatibility?: DesktopCompatibility;
  connectorContractVersion?: number;
  feedbackControlEventVersion?: number;
  runtimeBuildId?: string | null;
  pairingActive: boolean;
  writeProbeEnabled?: boolean;
  pid: number;
  startedAt: string;
  bridgeProvenance?: ReturnType<typeof readBridgeProvenance>;
}

export async function ensureBridgeAndTunnel(
  workspaceRoot: string,
  opts: { tunnel: boolean; maintenance?: MaintenanceLockHandle }
): Promise<{ runtime: RuntimeState; info: BridgeAdminInfo; mcpUrl: string | null }> {
  const { runtime } = await ensureBridge(workspaceRoot, { maintenance: opts.maintenance });
  let info = await adminFetch<BridgeAdminInfo>(runtime, "GET", "/admin/info");
  let mcpUrl: string | null = info.publicUrl ? `${info.publicUrl}/mcp` : null;
  if (opts.tunnel && !info.publicUrl) {
    if (!detectTunnelBinaries().cloudflared) {
      throw new Error("NEED_CLOUDFLARED: cloudflared is not installed. Install it first (macOS: brew install cloudflared).");
    }
    const result = await adminFetch<{ url?: string; message?: string }>(runtime, "POST", "/admin/tunnel/start", 90_000);
    if (!result.url) throw new Error(result.message ?? "Tunnel start failed");
    info = await adminFetch<BridgeAdminInfo>(runtime, "GET", "/admin/info");
    mcpUrl = `${result.url}/mcp`;
  }
  return { runtime, info, mcpUrl };
}

/** 所有重启共用认证 shutdown；等待关闭期间绝不按 PID kill 或猜测已停止。 */
export async function restartBridge(
  workspaceRoot: string,
  opts: { tunnel: boolean; expectedRuntime?: RuntimeState; beforeShutdown?: () => Promise<void>; maintenance?: MaintenanceLockHandle; shutdownReason?: "restart" | "rollout" }
): Promise<{ runtime: RuntimeState; info: BridgeAdminInfo; mcpUrl: string | null }> {
  const workspace = new Workspace(workspaceRoot);
  const before = await findBridgeObservation(workspace.id);
  if (before.state === "unknown") throw new Error(`Bridge 身份无法确认（${before.reason}），未重启。`);
  if (opts.expectedRuntime && (before.state !== "healthy" || !sameRuntime(before.runtime, opts.expectedRuntime))) {
    throw new Error("Bridge runtime 已被替换或停止，未继续重启。");
  }
  if (before.state === "healthy") {
    await opts.beforeShutdown?.();
    if (!await stopBridge(workspace.root, before.runtime, opts.shutdownReason ?? "restart")) throw new Error("Bridge 认证关闭失败，未重启。");
    const deadline = Date.now() + 5000;
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const current = await findBridgeObservation(workspace.id);
      if (current.state === "stopped") {
        // A legacy server may delete runtime before exiting. Never lose the original
        // process fence just because its HTTP listener or runtime file disappeared.
        if (await observeProcessPresence(before.runtime.pid) === "missing") break;
      } else if (!current.runtime || !sameRuntime(current.runtime, before.runtime)) {
        throw new Error("Bridge runtime 已被替换，未继续重启。");
      }
      // 认证关闭之后 server 可能已退出但进程仍在收尾；只能等待，不能将 unknown 当作 stopped。
      if (current.state === "unknown" && current.reason !== "probe_failed") {
        throw new Error(`关闭后 Bridge 身份无法确认（${current.reason}），未重启。`);
      }
      if (Date.now() >= deadline) throw new Error("Bridge 尚未完成关闭，未重启。");
    }
  }
  return ensureBridgeAndTunnel(workspace.root, opts);
}
