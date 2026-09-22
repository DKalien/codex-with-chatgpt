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
import { appendCleanupError, releaseMaintenanceOrThrow, tryAcquireMaintenanceLock } from "./maintenance-lock.js";
import { releaseRolloutFence, tryAcquireRolloutFence } from "./rollout-fence.js";
import { assessRolloutIdle, blockerToReason, type IdleAssessment } from "./rollout-idle.js";
import { schedulePostTurnFinalizer } from "./post-turn-finalizer.js";
import type { spawn } from "node:child_process";

const runtimeSchema = z.object({ service: z.literal(SERVICE_NAME), version: z.string(),
  workspaceId: z.string().regex(/^[a-f0-9]{12}$/), workspaceRoot: z.string().refine(path.isAbsolute),
  pid: z.number().int().positive(), port: z.number().int().min(1).max(65535), adminToken: z.string().min(1),
  publicUrl: z.string().nullable(), startedAt: z.string().datetime(),
  runtimeBuildId: z.string().refine(isRuntimeBuildId).optional() });
type RolloutStatus = "current" | "upgraded" | "stopped" | "pending_busy" | "skipped_quick" | "pending" | "error";
interface RolloutItem {
  workspaceId: string;
  workspaceName?: string;
  status: RolloutStatus;
  reason?: UpgradeReason;
  finalizer?: { jobId: string; status: "scheduled" | "existing" };
}

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

async function idle(workspace: Workspace, info: BridgeAdminInfo, assessment?: IdleAssessment): Promise<IdleAssessment> {
  const result = assessment ?? await assessRolloutIdle(workspace, info);
  if (!result.idle) {
    const first = result.blockers[0]!;
    throw new Skip(blockerToReason(first));
  }
  return result;
}

/** 显式 rollout 在 reason=busy 且严格 self-busy proof 时 schedule 一次性 finalizer。 */
async function tryScheduleSelfBusyFinalizer(
  workspace: Workspace,
  targetBuildId: string,
  assessment: IdleAssessment,
  saved: RuntimeState,
  spawnImpl?: typeof spawn,
): Promise<{ jobId: string; status: "scheduled" | "existing" } | null> {
  try {
    if (assessment.blockers.length !== 1 || assessment.blockers[0]!.kind !== "self_turn" || !assessment.selfBusyProof) {
      return null;
    }
    const scheduled = await schedulePostTurnFinalizer(workspace, targetBuildId, {
      stateDir: getStateDir(),
      assessment,
      runtime: saved,
      ...(spawnImpl ? { spawnImpl } : {}),
    });
    if (!scheduled.ok) return null;
    // existing 不再 spawn，避免重复 worker。
    if (scheduled.status === "existing") {
      return { jobId: scheduled.job.jobId, status: "existing" };
    }
    return { jobId: scheduled.job.jobId, status: scheduled.status };
  } catch {
    return null;
  }
}

/** 本机显式维护；只共享程序版本，不迁移 Connector 或 workspace 业务状态。 */
export async function rollout(opts: {
  workspaceRoot?: string;
  /** 测试注入：仅用于替代 detached spawn；生产默认真实 spawn。 */
  finalizerSpawnImpl?: typeof spawn;
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
      let lastSaved: RuntimeState | undefined;
      let initialAssessment: IdleAssessment | undefined;
      try {
        let saved: RuntimeState;
        try { saved = runtimeSchema.parse(JSON.parse(fs.readFileSync(path.join(runtimeDir, name), "utf8"))); }
        catch { throw new Skip("runtime_corrupt"); }
        lastSaved = saved;
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
        initialAssessment = await assessRolloutIdle(workspace, info);
        await idle(workspace, info, initialAssessment);
        const url = await namedUrl(workspace, info);
        restarting = true;
        const result = await restartBridge(workspace.root, { tunnel: true, expectedRuntime: saved,
          maintenance: maintenance.handle,
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
        let finalizer: RolloutItem["finalizer"];
        if (workspace) {
          try { writePending(workspace, targetBuildId, reason); } catch { status = "error"; }
          if (reason === "busy" && !restarting && initialAssessment && lastSaved) {
            finalizer = await tryScheduleSelfBusyFinalizer(workspace, targetBuildId, initialAssessment, lastSaved, opts.finalizerSpawnImpl) ?? undefined;
          }
        } else status = "error";
        items.push({ workspaceId, ...(workspace ? { workspaceName: workspace.name } : {}), status, reason, ...(finalizer ? { finalizer } : {}) });
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
