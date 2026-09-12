import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, getStateDir } from "../config/paths.js";
import { adminFetch, findBridgeObservation, findLiveBridge, type RuntimeState } from "../bridge/runtime.js";
import { Workspace } from "../workspace/manager.js";
import type { DesktopCompatibility } from "../auth/store.js";
import { detectTunnelBinaries } from "../tunnel/detect.js";

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
export async function ensureBridge(workspaceRoot: string, opts: { port?: number } = {}): Promise<EnsureBridgeResult> {
  const workspace = new Workspace(workspaceRoot);
  const lockFile = path.join(ensureDir(path.join(getStateDir(), "runtime")), `${workspace.id}.start.lock`);
  let lock: number;
  try { lock = fs.openSync(lockFile, "wx", 0o600); }
  catch { throw new Error("Bridge start lock 存在或无法取得；未启动重复实例，请稍后重试。"); }
  try { return await ensureUnlocked(workspace, opts); }
  finally { fs.closeSync(lock); fs.unlinkSync(lockFile); }
}

async function ensureUnlocked(workspace: Workspace, opts: { port?: number }): Promise<EnsureBridgeResult> {
  const observation = await findBridgeObservation(workspace.id);
  if (observation.state === "healthy") return { runtime: observation.runtime, spawned: false };
  if (observation.state === "unknown") {
    throw new Error(
      `Bridge state is uncertain (${observation.reason}); refusing to start another bridge.`
    );
  }

  const logDir = ensureDir(path.join(getStateDir(), "logs"));
  const logFile = path.join(logDir, `bridge-${workspace.id}.out.log`);
  const out = fs.openSync(logFile, "a", 0o600);
  try {
    // Existing files may have been created with a permissive umask. Keep the
    // daemon's inherited stdout/stderr log owner-readable only.
    fs.chmodSync(logFile, 0o600);
  } catch {
    // Windows / filesystems without chmod semantics
  }
  const { cmd, args } = cliEntry();
  const child = spawn(
    cmd,
    buildServeArgs(args, workspace.root, opts.port),
    {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env },
      windowsHide: true,
    }
  );
  child.unref();
  fs.closeSync(out);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const runtime = await findLiveBridge(workspace.id);
    if (runtime) return { runtime, spawned: true };
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(`Bridge process exited with code ${child.exitCode}. See ${logFile}`);
    }
  }
  throw new Error(`Bridge did not become healthy within 20s. See ${logFile}`);
}

function sameRuntime(a: RuntimeState, b: RuntimeState): boolean {
  return a.workspaceId === b.workspaceId && a.workspaceRoot === b.workspaceRoot &&
    a.pid === b.pid && a.startedAt === b.startedAt && a.port === b.port && a.adminToken === b.adminToken;
}

export async function stopBridge(workspaceRoot: string, expectedRuntime?: RuntimeState): Promise<boolean> {
  const workspace = new Workspace(workspaceRoot);
  const observation = await findBridgeObservation(workspace.id);
  if (observation.state !== "healthy") return false;
  if (observation.runtime.workspaceRoot !== workspace.root ||
    (expectedRuntime && !sameRuntime(observation.runtime, expectedRuntime))) return false;
  try {
    // admin token 绑定此 runtime；端口在检查后被复用也不能关闭对方。绝不按旧 PID 盲目 kill。
    await adminFetch(observation.runtime, "POST", "/admin/shutdown", 5000);
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
  runtimeBuildId?: string | null;
  pairingActive: boolean;
  writeProbeEnabled?: boolean;
  pid: number;
  startedAt: string;
}

export async function ensureBridgeAndTunnel(
  workspaceRoot: string,
  opts: { tunnel: boolean }
): Promise<{ runtime: RuntimeState; info: BridgeAdminInfo; mcpUrl: string | null }> {
  const { runtime } = await ensureBridge(workspaceRoot);
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
  opts: { tunnel: boolean; expectedRuntime?: RuntimeState; beforeShutdown?: () => Promise<void> }
): Promise<{ runtime: RuntimeState; info: BridgeAdminInfo; mcpUrl: string | null }> {
  const workspace = new Workspace(workspaceRoot);
  const before = await findBridgeObservation(workspace.id);
  if (before.state === "unknown") throw new Error(`Bridge 身份无法确认（${before.reason}），未重启。`);
  if (opts.expectedRuntime && (before.state !== "healthy" || !sameRuntime(before.runtime, opts.expectedRuntime))) {
    throw new Error("Bridge runtime 已被替换或停止，未继续重启。");
  }
  if (before.state === "healthy") {
    await opts.beforeShutdown?.();
    if (!await stopBridge(workspace.root, before.runtime)) throw new Error("Bridge 认证关闭失败，未重启。");
    const deadline = Date.now() + 5000;
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const current = await findBridgeObservation(workspace.id);
      if (current.state === "stopped") break;
      if (!current.runtime || !sameRuntime(current.runtime, before.runtime)) {
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
