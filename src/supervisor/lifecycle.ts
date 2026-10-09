import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { findBridgeObservation, runtimeFile, type BridgeObservation } from "../bridge/runtime.js";
import { ensureBridgeAndTunnel } from "../process/daemon.js";
import { readReleaseReferenceJson } from "../core/release-references.js";
import { getStateDir } from "../config/paths.js";
import { ensureConfiguredGatewaySupervisor } from "../gateway/startup.js";
import { Workspace } from "../workspace/manager.js";
import { isNamedTunnelReady, readTunnelState } from "../tunnel/state.js";
import { hasSupervisorState, withSupervisorOperation } from "./store.js";
import { assertMaintenanceHandle, MaintenanceBusyError, releaseMaintenanceOrThrow,
  tryAcquireMaintenanceLock, type MaintenanceLockHandle } from "../core/maintenance-lock.js";
import type { SupervisorConfig } from "./schema.js";

export type SupervisorReason = "paused" | "unconfigured" | "retired" | "healthy" | "recovered" | "bridge_unknown" | "busy" | "start_failed" | "observation_failed" | "config_invalid";
type Outcome = { reason: SupervisorReason; healthy?: boolean; idle?: boolean; terminal?: boolean };
type Observation = Pick<BridgeObservation, "state">;
export interface SupervisorLoopDependencies {
  cycle(action: (config: SupervisorConfig | null, assertOwned: () => void) => Promise<Outcome>): Promise<Outcome>;
  observe(): Promise<Observation>;
  ensure(tunnel: boolean): Promise<unknown>;
  sleep(milliseconds: number, signal?: AbortSignal): Promise<unknown>;
  now(): string;
  report(event: { observedAt: string; reason: SupervisorReason; nextCheckMs: number }): void;
}

function busy(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | null;
  return ["MAINTENANCE_BUSY", "SUPERVISOR_BUSY"].includes(value?.code ?? "") ||
    value?.message?.startsWith("Bridge start lock 存在或无法取得") === true;
}

/** The operation fence covers desired-state read through the existing start authority. */
export async function runSupervisorLoop(deps: SupervisorLoopDependencies, signal: AbortSignal): Promise<void> {
  const backoff = [1000, 2000, 5000, 10000];
  let failures = 0;
  while (!signal.aborted) {
    let outcome: Outcome;
    try {
      outcome = await deps.cycle(async (config, assertOwned) => {
        if (!config) return { reason: "unconfigured", idle: true };
        if (config.registrationMode !== "windows-scheduled-task") return { reason: "retired", terminal: true };
        if (config.desiredState === "stopped") return { reason: "paused", idle: true };
        let observation: Observation;
        try { observation = await deps.observe(); }
        catch { return { reason: "observation_failed" }; }
        if (observation.state === "healthy") return { reason: "healthy", healthy: true };
        if (observation.state !== "stopped") return { reason: "bridge_unknown" };
        try { assertOwned(); await deps.ensure(config.tunnel); return { reason: "recovered" }; }
        catch (error) { return { reason: busy(error) ? "busy" : "start_failed" }; }
      });
    } catch (error) { outcome = { reason: busy(error) ? "busy" : "config_invalid" }; }
    if (outcome.terminal) {
      deps.report({ observedAt: deps.now(), reason: outcome.reason, nextCheckMs: 0 });
      break;
    }
    if (outcome.healthy || outcome.idle) failures = 0;
    const nextCheckMs = outcome.healthy || outcome.idle ? 10000 : backoff[Math.min(failures++, backoff.length - 1)];
    deps.report({ observedAt: deps.now(), reason: outcome.reason, nextCheckMs });
    if (signal.aborted) break;
    try { await deps.sleep(nextCheckMs, signal); }
    catch (error) { if (!signal.aborted) throw error; }
  }
}

// The legacy runtime reader treats malformed JSON as absent. Auto-recovery must
// reject an existing malformed/noncanonical authority before using that observation.
const runtimeIdentity = z.object({ workspaceId: z.string(), workspaceRoot: z.string(),
  pid: z.number().int().positive(), port: z.number().int().min(1).max(65535),
  startedAt: z.string().datetime(), service: z.string(), adminToken: z.string().min(1) });
export async function observeSupervisorBridge(workspace: Workspace): Promise<BridgeObservation> {
  const file = runtimeFile(workspace.id);
  try {
    fs.lstatSync(file);
    const runtime = runtimeIdentity.parse(readReleaseReferenceJson(file));
    if (runtime.workspaceId !== workspace.id || runtime.workspaceRoot !== workspace.root)
      return { state: "unknown", runtime: null, reason: "workspace_mismatch" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      return { state: "unknown", runtime: null, reason: "identity_mismatch" };
  }
  return findBridgeObservation(workspace.id);
}

/** Never provision a new identity or silently fall back to a quick tunnel. */
export async function recoverSupervisorBridge(workspace: Workspace, tunnel: boolean): Promise<void> {
  const named = tunnel ? readTunnelState(workspace.id) : null;
  if (tunnel && (!named || named.workspaceId !== workspace.id || named.preference !== "named" ||
      named.provider !== "cloudflare-named" || !isNamedTunnelReady(named)))
    throw new Error("SUPERVISOR_NAMED_TUNNEL_REQUIRED");
  const result = await ensureBridgeAndTunnel(workspace.root, { tunnel });
  if (named && (result.info.tunnel.provider !== "cloudflare-named" ||
      result.info.publicUrl !== `https://${named.hostname}` || result.info.tunnel.url !== result.info.publicUrl))
    throw new Error("SUPERVISOR_TUNNEL_IDENTITY_MISMATCH");
}

export function productionLoopDependencies(workspace: Workspace, assertLease: () => void): SupervisorLoopDependencies {
  return {
    cycle: action => withSupervisorOperation(workspace.root, tx => {
      const assertOwned = () => { assertLease(); tx.assertOwned(); };
      assertOwned();
      return action(tx.readConfig(), assertOwned);
    }),
    observe: () => observeSupervisorBridge(workspace),
    ensure: tunnel => recoverSupervisorBridge(workspace, tunnel),
    sleep: (milliseconds, signal) => delay(milliseconds, undefined, { signal }),
    now: () => new Date().toISOString(),
    report: event => { process.stdout.write(`${JSON.stringify(event)}\n`); },
  };
}

/** Reuse the machine start/installation fence, including its inherited handle.
 * No supervisor directory, ACL, process probe or ScheduledTasks dependency.
 * Install and no-config explicit actions cannot cross the initial publication.
 */
export async function withSupervisorLifecycleFence<T>(action: (maintenance: MaintenanceLockHandle) => Promise<T>,
  stateDir = getStateDir()): Promise<T> {
  const acquired = tryAcquireMaintenanceLock(stateDir, "supervisor-lifecycle");
  if (!acquired.ok) throw new MaintenanceBusyError();
  let result: T | undefined;
  let actionError: unknown;
  try {
    result = await action(acquired.handle);
    assertMaintenanceHandle(stateDir, acquired.handle);
  } catch (error) { actionError = error; }
  releaseMaintenanceOrThrow(acquired.handle, { result, actionError });
  return result as T;
}

/** Only explicit CLI intent changes desired state; rollout/daemon primitives do not. */
export async function withExplicitSupervisorIntent<T>(root: string, desiredState: "running" | "stopped",
  tunnel: boolean | undefined, action: (tunnel: boolean, maintenance: MaintenanceLockHandle) => Promise<T>, stateDir = getStateDir()): Promise<T> {
  const result = await withSupervisorLifecycleFence(async maintenance => {
    if (!hasSupervisorState(root, stateDir)) return action(tunnel ?? false, maintenance);
    return withSupervisorOperation(root, async tx => {
      const current = tx.readConfig();
      if (!current) throw new Error("SUPERVISOR_CONFIG_MISSING");
      const updated = tx.updateConfig({ desiredState, ...(tunnel === undefined ? {} : { tunnel }) });
      return action(updated.tunnel, maintenance);
    }, { stateDir });
  }, stateDir);
  if (desiredState === "running") {
    try { await ensureConfiguredGatewaySupervisor({ stateDir }); }
    catch (error) {
      if (!(error instanceof Error)) throw new Error("Bridge 已就绪，但 Gateway/公网隧道启动失败", { cause: error });
      error.message = `Bridge 已就绪，但 Gateway/公网隧道启动失败：${error.message}`;
      throw error;
    }
  }
  return result;
}
