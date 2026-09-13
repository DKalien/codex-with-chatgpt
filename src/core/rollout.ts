import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getStateDir } from "../config/paths.js";
import { getRuntimeBuildId, isRuntimeBuildId } from "../build-id.js";
import { findBridgeObservation, adminFetch, type RuntimeState } from "../bridge/runtime.js";
import { restartBridge, type BridgeAdminInfo } from "../process/daemon.js";
import { Workspace } from "../workspace/manager.js";
import { SERVICE_NAME } from "../version.js";
import { readCurrentInstall } from "./install.js";
import { clearPending, readPending, writePending, type UpgradeReason } from "./upgrade.js";
import { readTunnelState, isNamedTunnelReady } from "../tunnel/state.js";
import { desktopIpc } from "../desktop/ipc.js";
import { readDesktop } from "../desktop/store.js";
import { readRemote } from "../remote/store.js";
import { desktopHistory } from "../desktop/history.js";

const runtimeSchema = z.object({ service: z.literal(SERVICE_NAME), version: z.string(),
  workspaceId: z.string().regex(/^[a-f0-9]{12}$/), workspaceRoot: z.string().refine(path.isAbsolute),
  pid: z.number().int().positive(), port: z.number().int().min(1).max(65535), adminToken: z.string().min(1),
  publicUrl: z.string().nullable(), startedAt: z.string().datetime(),
  runtimeBuildId: z.string().refine(isRuntimeBuildId).optional() });
type RolloutStatus = "current" | "upgraded" | "stopped" | "pending_busy" | "skipped_quick" | "pending" | "error";
interface RolloutItem { workspaceId: string; workspaceName?: string; status: RolloutStatus; reason?: UpgradeReason }

class Skip extends Error {
  constructor(readonly reason: UpgradeReason) { super(reason); }
}
function sameRuntime(a: RuntimeState, b: RuntimeState): boolean {
  return a.workspaceId === b.workspaceId && a.workspaceRoot === b.workspaceRoot && a.pid === b.pid &&
    a.port === b.port && a.startedAt === b.startedAt && a.adminToken === b.adminToken;
}

async function authenticatedInfo(workspace: Workspace, expected: RuntimeState): Promise<BridgeAdminInfo> {
  const observation = await findBridgeObservation(workspace.id);
  if (observation.state !== "healthy" || !sameRuntime(observation.runtime, expected)) throw new Skip("identity_mismatch");
  let info: BridgeAdminInfo;
  try { info = await adminFetch<BridgeAdminInfo>(expected, "GET", "/admin/info", 3000); }
  catch { throw new Skip("runtime_unknown"); }
  if (info.service !== SERVICE_NAME || info.workspaceId !== workspace.id || info.workspaceRoot !== workspace.root ||
    info.pid !== expected.pid || info.startedAt !== expected.startedAt || info.port !== expected.port ||
    (info.runtimeBuildId != null && !isRuntimeBuildId(info.runtimeBuildId)) ||
    info.runtimeBuildId !== expected.runtimeBuildId) throw new Skip("identity_mismatch");
  return info;
}

async function namedUrl(workspace: Workspace, info: BridgeAdminInfo): Promise<string> {
  if (info.tunnel?.provider === "cloudflare-quick") throw new Skip("quick");
  const state = readTunnelState(workspace.id);
  if (state.workspaceId !== workspace.id || !isNamedTunnelReady(state) || state.provider !== "cloudflare-named" ||
    !state.hostname || !state.tunnelId || info.tunnel?.provider !== "cloudflare-named" || info.tunnel.running !== true)
    throw new Skip("named_unhealthy");
  const expected = `https://${state.hostname}`;
  if (info.publicUrl !== expected || info.tunnel.url !== expected) throw new Skip("named_unhealthy");
  try {
    const response = await fetch(`${expected}/health`, { signal: AbortSignal.timeout(8000), redirect: "error" });
    const health = await response.json() as Record<string, unknown>;
    if (!response.ok || health.service !== SERVICE_NAME || health.workspaceId !== workspace.id || health.status !== "ok" ||
      (health.pid !== undefined && health.pid !== info.pid) || (health.startedAt !== undefined && health.startedAt !== info.startedAt))
      throw new Error("Unhealthy named endpoint");
  } catch { throw new Skip("named_unhealthy"); }
  return expected;
}

async function idle(workspace: Workspace, info: BridgeAdminInfo): Promise<void> {
  // 环境变量只能保守拒绝，绝不能以它证明 idle 或授予权限。
  if (process.env.CODEX_THREAD_ID && new Workspace(process.cwd()).id === workspace.id) throw new Skip("busy");
  if (typeof info.pairingActive !== "boolean") throw new Skip("runtime_unknown");
  if (info.pairingActive) throw new Skip("pairing_active");
  try {
    const before = readDesktop(workspace.id);
    if (before && before.workspaceRoot !== workspace.root) throw new Skip("desktop_unknown");
    if (before?.deliveries.some(item => item.deliveryStatus === "outcome_unknown")) throw new Skip("desktop_unresolved");
    const { desktop, accepted, skipHistory, retired, ownerless } = desktopHistory(workspace);
    if (JSON.stringify(desktop) !== JSON.stringify(before)) throw new Skip("desktop_unknown");
    const acceptedThreads = accepted.filter(item => !skipHistory.has(item.commandId) || item.threadId === desktop?.binding?.threadId)
      .map(item => item.threadId!);
    const binding = desktop?.binding;
    if (acceptedThreads.length && !binding) throw new Skip("desktop_unknown");
    if (binding) for (const threadId of new Set([binding.threadId, ...acceptedThreads])) {
      // 同一历史 thread 的所有待检查 delivery 都已 retired 才能接受明确不存在。
      const retirementOnly = threadId !== binding.threadId && accepted
        .filter(item => item.threadId === threadId && !skipHistory.has(item.commandId))
        .every(item => retired.has(item.commandId));
      let observed;
      try {
        observed = await desktopIpc.inspect({ threadId, hostId: binding.hostId,
          projectId: binding.projectId, workspaceRoot: workspace.root });
      } catch (error) {
        if (!retirementOnly) throw error;
        const code = (error as { code?: string }).code;
        if (code === "DESKTOP_TARGET_NOT_FOUND") continue;
        // 无 owner 仅对显式 ownerless 处置生效；同 thread 任一未处置项仍阻塞。
        if (code === "DESKTOP_NO_OWNER" && accepted
          .filter(item => item.threadId === threadId && !skipHistory.has(item.commandId))
          .every(item => ownerless.has(item.commandId))) continue;
        throw new Skip(code === "DESKTOP_BUSY" ? "busy" : "desktop_unknown");
      }
      if (observed.runtimeStatus !== "idle") throw new Skip(
        observed.runtimeStatus === "active" || observed.runtimeStatus === "inProgress" ? "busy" : "desktop_unknown");
    }
  } catch (error) {
    if (error instanceof Skip) throw error;
    const code = (error as { code?: string }).code;
    throw new Skip(code === "DESKTOP_BUSY" ? "busy" : code === "DESKTOP_APPROVAL_PENDING" ? "approval_pending" : "desktop_unknown");
  }
  try {
    const remote = readRemote(workspace.id);
    if (remote && remote.workspaceRoot !== workspace.root) throw new Skip("remote_unknown");
    const pending = new Set(["queued", "starting", "running", "awaiting_approval", "needs_reconciliation"]);
    if (remote && [...remote.threads, ...remote.tasks].some(item => pending.has(item.status))) throw new Skip("remote_active");
    if (remote?.controller && (remote.controller.error || ["starting", "unknown"].includes(remote.controller.appServer)))
      throw new Skip("remote_unknown");
  } catch (error) { throw error instanceof Skip ? error : new Skip("remote_unknown"); }
}

/** 本机显式维护；只共享程序版本，不迁移 Connector 或 workspace 业务状态。 */
export async function rollout(opts: { workspaceRoot?: string } = {}) {
  const installed = readCurrentInstall();
  if (!installed || getRuntimeBuildId() !== installed.runtimeBuildId) {
    throw new Error("Core install/build 无法确认；请从已安装的当前 launcher 运行 rollout。");
  }
  const targetBuildId = installed.runtimeBuildId;
  const selected = opts.workspaceRoot ? new Workspace(opts.workspaceRoot) : null;
  const items: RolloutItem[] = [];
  const stateDir = getStateDir();
  const runtimeDir = path.join(stateDir, "runtime");
  const names = fs.existsSync(runtimeDir) ? fs.readdirSync(runtimeDir).filter(name => /^[a-f0-9]{12}\.json$/.test(name)).sort() : [];
  // ponytail: 显式 rollout 使用一把短期机器锁；不偷锁、不引入后台 Supervisor。
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(stateDir, "rollout.lock");
  let lock: number | undefined;
  try { lock = fs.openSync(lockPath, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("无法取得 rollout lock。"); }
  if (lock === undefined) {
    for (const name of names) {
      const workspaceId = name.slice(0, -5);
      if (selected && selected.id !== workspaceId) continue;
      items.push({ workspaceId, status: "pending", reason: "rollout_busy" });
    }
    const counts: Record<RolloutStatus, number> = { current: 0, upgraded: 0, stopped: 0, pending_busy: 0, skipped_quick: 0, pending: items.length, error: 0 };
    return { targetBuildId, counts, workspaces: items };
  }
  try {
    for (const name of names) {
      const workspaceId = name.slice(0, -5);
      if (selected && selected.id !== workspaceId) continue;
      let workspace: Workspace | undefined;
      let restarting = false;
      try {
        let saved: RuntimeState;
        try { saved = runtimeSchema.parse(JSON.parse(fs.readFileSync(path.join(runtimeDir, name), "utf8"))); }
        catch { throw new Skip("runtime_corrupt"); }
        const resolved = new Workspace(saved.workspaceRoot);
        if (resolved.id !== workspaceId || saved.workspaceId !== workspaceId || saved.workspaceRoot !== resolved.root ||
          (selected && selected.root !== resolved.root)) throw new Skip("identity_mismatch");
        workspace = resolved;
        readPending(workspace); // 损坏的 pending 不能被重启/覆盖“修好”。
        const observation = await findBridgeObservation(workspace.id);
        if (observation.state === "stopped") {
          clearPending(workspace);
          items.push({ workspaceId, workspaceName: workspace.name, status: "stopped" });
          continue;
        }
        if (observation.state !== "healthy") throw new Skip("runtime_unknown");
        const info = await authenticatedInfo(workspace, saved);
        if (info.runtimeBuildId === targetBuildId) {
          clearPending(workspace);
          items.push({ workspaceId, workspaceName: workspace.name, status: "current" });
          continue;
        }
        if (info.tunnel?.provider === "cloudflare-quick") throw new Skip("quick");
        // 当前 active workspace 在任何公网探测或关闭之前直接保留 pending。
        await idle(workspace, info);
        const url = await namedUrl(workspace, info);
        restarting = true;
        const result = await restartBridge(workspace.root, { tunnel: true, expectedRuntime: saved,
          beforeShutdown: async () => {
            const fresh = await authenticatedInfo(workspace!, saved);
            if (await namedUrl(workspace!, fresh) !== url) throw new Skip("named_unhealthy");
            await idle(workspace!, fresh);
          } });
        const after = await authenticatedInfo(workspace, result.runtime);
        if (after.runtimeBuildId !== targetBuildId || await namedUrl(workspace, after) !== url || result.mcpUrl !== `${url}/mcp`)
          throw new Skip("postcheck_failed");
        clearPending(workspace);
        items.push({ workspaceId, workspaceName: workspace.name, status: "upgraded" });
      } catch (error) {
        const reason = error instanceof Skip ? error.reason : restarting ? "restart_failed" : "runtime_unknown";
        let status: RolloutStatus = reason === "quick" ? "skipped_quick" :
          ["busy", "approval_pending", "pairing_active"].includes(reason) ? "pending_busy" : restarting && !(error instanceof Skip) ? "error" : "pending";
        if (workspace) {
          try { writePending(workspace, targetBuildId, reason); } catch { status = "error"; }
        } else status = "error";
        items.push({ workspaceId, ...(workspace ? { workspaceName: workspace.name } : {}), status, reason });
      }
    }
    // runtime 文件已消失的 workspace 不启动；其 pending 可在此显式维护操作中清理。
    if (lock !== undefined) {
      const directory = path.join(stateDir, "runtime-upgrades");
      for (const name of fs.existsSync(directory) ? fs.readdirSync(directory) : []) {
        if (!/^[a-f0-9]{12}\.json$/.test(name) || names.includes(name) || (selected && name !== `${selected.id}.json`)) continue;
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")) as { workspaceRoot: string };
          const workspace = new Workspace(raw.workspaceRoot);
          if (`${workspace.id}.json` !== name) continue;
          clearPending(workspace);
          items.push({ workspaceId: workspace.id, workspaceName: workspace.name, status: "stopped" });
        } catch { items.push({ workspaceId: name.slice(0, -5), status: "error", reason: "runtime_corrupt" }); }
      }
    }
  } finally { if (lock !== undefined) { fs.closeSync(lock); fs.unlinkSync(lockPath); } }
  const counts: Record<RolloutStatus, number> = { current: 0, upgraded: 0, stopped: 0, pending_busy: 0, skipped_quick: 0, pending: 0, error: 0 };
  for (const item of items) counts[item.status] += 1;
  return { targetBuildId, counts, workspaces: items };
}
