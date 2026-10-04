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
import { appendCleanupError, releaseMaintenanceOrThrow, tryAcquireMaintenanceLock } from "./maintenance-lock.js";
import { releaseRolloutFence, tryAcquireRolloutFence } from "./rollout-fence.js";
import { assessRolloutIdle, blockerToReason } from "./rollout-idle.js";
import { probeNamedHealth, type NamedHealthFailure, type NamedHealthIdentity } from "./named-health.js";

const runtimeSchema = z.object({ service: z.literal(SERVICE_NAME), version: z.string(),
  workspaceId: z.string().regex(/^[a-f0-9]{12}$/), workspaceRoot: z.string().refine(path.isAbsolute),
  pid: z.number().int().positive(), port: z.number().int().min(1).max(65535), adminToken: z.string().min(1),
  publicUrl: z.string().nullable(), startedAt: z.string().datetime(),
  runtimeBuildId: z.string().refine(isRuntimeBuildId).optional() });
type RolloutStatus = "current" | "upgraded" | "stopped" | "pending_busy" | "skipped_quick" | "pending" | "error";
interface NamedHealthDiagnostic {
  phase: "preflight" | "pre_shutdown" | "postcheck";
  failure: NamedHealthFailure | "tunnel_state_mismatch" | "canonical_url_mismatch";
  attempts: number;
  httpStatus?: number;
}
interface RolloutItem {
  workspaceId: string;
  workspaceName?: string;
  status: RolloutStatus;
  reason?: UpgradeReason;
  /** Bounded diagnostic only; not persisted in the strict pending authority schema. */
  namedHealth?: NamedHealthDiagnostic;
}

class Skip extends Error {
  constructor(readonly reason: UpgradeReason, readonly namedHealth?: NamedHealthDiagnostic) { super(reason); }
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

async function namedUrl(workspace: Workspace, info: BridgeAdminInfo, phase: NamedHealthDiagnostic["phase"],
  previous?: NamedHealthIdentity): Promise<string> {
  if (info.tunnel?.provider === "cloudflare-quick") throw new Skip("quick");
  const state = readTunnelState(workspace.id);
  if (state.workspaceId !== workspace.id || !isNamedTunnelReady(state) || state.provider !== "cloudflare-named" ||
    !state.hostname || !state.tunnelId || info.tunnel?.provider !== "cloudflare-named" || info.tunnel.running !== true)
    throw new Skip("named_unhealthy", { phase, failure: "tunnel_state_mismatch", attempts: 0 });
  const expected = `https://${state.hostname}`;
  if (info.publicUrl !== expected || info.tunnel.url !== expected)
    throw new Skip("named_unhealthy", { phase, failure: "canonical_url_mismatch", attempts: 0 });
  const probe = await probeNamedHealth(expected, info, previous);
  if (!probe.ok) {
    const { ok: _ok, ...detail } = probe;
    throw new Skip("named_unhealthy", { phase, ...detail });
  }
  return expected;
}

async function idle(workspace: Workspace, info: BridgeAdminInfo): Promise<void> {
  const result = await assessRolloutIdle(workspace, info, {
    skipSelfTurnCheck: true,
    ignoreDesktopActivity: true,
  });
  if (!result.idle) {
    const first = result.blockers[0]!;
    throw new Skip(blockerToReason(first));
  }
}

/** 本机显式维护；只共享程序版本，不迁移 Connector 或 workspace 业务状态。 */
export async function rollout(opts: {
  workspaceRoot?: string;
} = {}) {
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
  // 固定顺序：maintenance → rollout。GC/install/bridge-start 共享 maintenance 边界。
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const maintenance = tryAcquireMaintenanceLock(stateDir, "rollout");
  if (!maintenance.ok) {
    for (const name of names) {
      const workspaceId = name.slice(0, -5);
      if (selected && selected.id !== workspaceId) continue;
      items.push({ workspaceId, status: "pending", reason: "rollout_busy" });
    }
    const counts: Record<RolloutStatus, number> = { current: 0, upgraded: 0, stopped: 0, pending_busy: 0, skipped_quick: 0, pending: items.length, error: 0 };
    return { targetBuildId, counts, workspaces: items };
  }
  const fence = tryAcquireRolloutFence(stateDir);
  if (!fence.ok) {
    releaseMaintenanceOrThrow(maintenance.handle);
    for (const name of names) {
      const workspaceId = name.slice(0, -5);
      if (selected && selected.id !== workspaceId) continue;
      items.push({ workspaceId, status: "pending", reason: "rollout_busy" });
    }
    const counts: Record<RolloutStatus, number> = { current: 0, upgraded: 0, stopped: 0, pending_busy: 0, skipped_quick: 0, pending: items.length, error: 0 };
    return { targetBuildId, counts, workspaces: items };
  }
  let actionError: unknown = null;
  try {
    // TOCTOU：拿到 maintenance 后重新确认 current install 仍等于最初 target。
    const reconfirm = readCurrentInstall(stateDir, "fast");
    if (!reconfirm || reconfirm.runtimeBuildId !== targetBuildId || getRuntimeBuildId() !== reconfirm.runtimeBuildId) {
      for (const name of names) {
        const workspaceId = name.slice(0, -5);
        if (selected && selected.id !== workspaceId) continue;
        items.push({ workspaceId, status: "error", reason: "install_changed" });
      }
      const counts: Record<RolloutStatus, number> = { current: 0, upgraded: 0, stopped: 0, pending_busy: 0, skipped_quick: 0, pending: 0, error: items.length };
      return { targetBuildId, counts, workspaces: items };
    }
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
        // 在公网探测和关闭前确认安全门禁；Desktop turn 活动不阻断维护。
        await idle(workspace, info);
        const url = await namedUrl(workspace, info, "preflight");
        restarting = true;
        const result = await restartBridge(workspace.root, { tunnel: true, expectedRuntime: saved,
          shutdownReason: "rollout",
          maintenance: maintenance.handle,
          beforeShutdown: async () => {
            const fresh = await authenticatedInfo(workspace!, saved);
            if (await namedUrl(workspace!, fresh, "pre_shutdown") !== url)
              throw new Skip("named_unhealthy", { phase: "pre_shutdown", failure: "canonical_url_mismatch", attempts: 0 });
            await idle(workspace!, fresh);
          } });
        const after = await authenticatedInfo(workspace, result.runtime);
        if (after.runtimeBuildId !== targetBuildId || await namedUrl(workspace, after, "postcheck", info) !== url || result.mcpUrl !== `${url}/mcp`)
          throw new Skip("postcheck_failed");
        clearPending(workspace);
        items.push({ workspaceId, workspaceName: workspace.name, status: "upgraded" });
      } catch (error) {
        const reason = error instanceof Skip ? error.reason : restarting ? "restart_failed" : "runtime_unknown";
        let status: RolloutStatus = reason === "quick" ? "skipped_quick" :
          reason === "pairing_active" ? "pending_busy" : restarting && !(error instanceof Skip) ? "error" : "pending";
        if (workspace) {
          try { writePending(workspace, targetBuildId, reason); } catch { status = "error"; }
        } else status = "error";
        items.push({ workspaceId, ...(workspace ? { workspaceName: workspace.name } : {}), status, reason,
          ...(error instanceof Skip && error.namedHealth ? { namedHealth: error.namedHealth } : {}) });
      }
    }
    // runtime 文件已消失的 workspace 不启动；其 pending 可在此显式维护操作中清理。
    {
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
  } catch (error) {
    actionError = error;
    throw error;
  } finally {
    const fenceReport = releaseRolloutFence(fence.handle);
    if (actionError) {
      if (!fenceReport.rolloutReleased) {
        appendCleanupError(actionError, new Error(fenceReport.issues.join("; ") || "rollout fence release failed"));
      }
      try {
        releaseMaintenanceOrThrow(maintenance.handle, { actionError: undefined, result: { targetBuildId, items } });
      } catch (maintenanceError) {
        appendCleanupError(actionError, maintenanceError instanceof Error ? maintenanceError : new Error(String(maintenanceError)));
      }
    } else {
      if (!fenceReport.rolloutReleased) {
        const fenceError = new Error(fenceReport.issues.join("; ") || "rollout fence release failed");
        (fenceError as { result?: unknown }).result = { targetBuildId, items };
        releaseMaintenanceOrThrow(maintenance.handle, { actionError: fenceError, result: { targetBuildId, items } });
      } else {
        releaseMaintenanceOrThrow(maintenance.handle, { result: { targetBuildId, items } });
      }
    }
  }
  const counts: Record<RolloutStatus, number> = { current: 0, upgraded: 0, stopped: 0, pending_busy: 0, skipped_quick: 0, pending: 0, error: 0 };
  for (const item of items) counts[item.status] += 1;
  return { targetBuildId, counts, workspaces: items };
}
