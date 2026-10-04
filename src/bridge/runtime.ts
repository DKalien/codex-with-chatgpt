import fs from "node:fs";
import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { requestLoopback } from "./loopback-http.js";
import { observeProcessPresence } from "../process/process-probe.js";

/** Capabilities are explicit; an absent token means the runtime is legacy/unknown. */
export const RUNTIME_CAPABILITY_FINAL_RECEIPT_REQUIRED = "feedback.final_receipt_required" as const;
export const RUNTIME_CAPABILITIES = [RUNTIME_CAPABILITY_FINAL_RECEIPT_REQUIRED] as const;

/**
 * Runtime state file: how the CLI/Skill finds a running bridge for a
 * workspace. Contains the admin token, so it is 0600 and lives in the user
 * state dir, never in the project.
 */
export interface RuntimeState {
  service: string;
  version: string;
  workspaceId: string;
  workspaceRoot: string;
  pid: number;
  port: number;
  adminToken: string;
  publicUrl: string | null;
  startedAt: string;
  runtimeBuildId?: string;
  capabilities?: readonly string[];
}

export function runtimeFile(workspaceId: string): string {
  return path.join(getStateDir(), "runtime", `${workspaceId}.json`);
}

export function writeRuntimeState(state: RuntimeState): void {
  writeSecureJson(runtimeFile(state.workspaceId), state);
}

export function readRuntimeState(workspaceId: string): RuntimeState | null {
  return readJsonIfExists<RuntimeState>(runtimeFile(workspaceId));
}

export function clearRuntimeState(workspaceId: string, expected?: Pick<RuntimeState, "pid" | "startedAt" | "adminToken">): void {
  if (expected) {
    const current = readRuntimeState(workspaceId);
    if (!current || current.pid !== expected.pid || current.startedAt !== expected.startedAt ||
      current.adminToken !== expected.adminToken) return;
  }
  try {
    fs.rmSync(runtimeFile(workspaceId), { force: true });
  } catch {
    // ignore
  }
}

export interface HealthPayload {
  service: string;
  version: string;
  workspaceId: string;
  status: string;
  pid?: number;
  startedAt?: string;
  runtimeBuildId?: string;
  capabilities?: readonly string[];
}

export function hasRuntimeCapability(
  runtime: Pick<RuntimeState, "capabilities"> | Pick<HealthPayload, "capabilities">,
  capability: string,
): boolean {
  return runtime.capabilities?.includes(capability) === true;
}

/** Probe a port and check whether a healthy c2c bridge for the workspace answers. */
// Normal observations stay fast; only a failed probe with a definitely live PID
// earns one 8s retry, covering the reproduced >4s host/event-loop stall.
const HEALTH_PROBE_TIMEOUT_MS = 2000;
const LIVE_PID_HEALTH_RETRY_TIMEOUT_MS = 8000;
export async function probeBridge(
  port: number,
  timeoutMs = HEALTH_PROBE_TIMEOUT_MS
): Promise<HealthPayload | null> {
  try {
    const response = await requestLoopback({ port, path: "/health", timeoutMs });
    if (response.status < 200 || response.status >= 300) return null;
    const body = JSON.parse(response.body) as HealthPayload;
    if (body.service !== SERVICE_NAME) return null;
    return body;
  } catch {
    return null;
  }
}

export async function adminFetch<T = unknown>(
  runtime: RuntimeState,
  method: "GET" | "POST",
  route: string,
  timeoutMs = 60_000,
  diagnostics?: { shutdownReason: "restart" | "rollout" },
): Promise<T> {
  const response = await requestLoopback({
    port: runtime.port, path: route, method, timeoutMs,
    headers: { Authorization: `Bearer ${runtime.adminToken}`,
      ...(diagnostics ? { "X-C2C-Shutdown-Reason": diagnostics.shutdownReason } : {}) },
  });
  let body: T & { message?: string };
  try { body = JSON.parse(response.body); }
  catch { body = {} as T & { message?: string }; } // Preserve the existing non-JSON admin error fallback.
  if (response.status < 200 || response.status >= 300) {
    throw new Error(body?.message ?? `Admin request failed (${response.status})`);
  }
  return body;
}

export type BridgeObservation =
  | { state: "healthy"; runtime: RuntimeState }
  | { state: "stopped"; runtime: RuntimeState | null; reason: "runtime_missing" | "pid_missing" | "stale_runtime" }
  | { state: "unknown"; runtime: RuntimeState | null; reason: "probe_failed" | "pid_unknown" | "workspace_mismatch" | "identity_mismatch" };

async function authenticateRuntimeIdentity(runtime: RuntimeState, health: HealthPayload): Promise<boolean> {
  if (health.pid !== runtime.pid || typeof health.startedAt !== "string" || health.startedAt !== runtime.startedAt)
    return false;
  if (health.runtimeBuildId !== undefined && runtime.runtimeBuildId !== undefined && health.runtimeBuildId !== runtime.runtimeBuildId)
    return false;
  try {
    const info = await adminFetch<Partial<RuntimeState>>(runtime, "GET", "/admin/info", 2000);
    if (info.service !== runtime.service || info.workspaceId !== runtime.workspaceId ||
      info.workspaceRoot !== runtime.workspaceRoot || info.pid !== runtime.pid ||
      info.startedAt !== runtime.startedAt || info.port !== runtime.port ||
      (runtime.runtimeBuildId !== undefined && info.runtimeBuildId !== runtime.runtimeBuildId)) return false;
    const confirmed = await probeBridge(runtime.port);
    return !!confirmed && confirmed.status === "ok" && confirmed.workspaceId === runtime.workspaceId &&
      confirmed.pid === runtime.pid && confirmed.startedAt === runtime.startedAt &&
      (runtime.runtimeBuildId === undefined || confirmed.runtimeBuildId === runtime.runtimeBuildId);
  } catch {
    return false;
  }
}

/**
 * Distinguish a dead bridge from a probe that simply failed.
 * Read-only: never starts, stops, or clears runtime.
 */
export async function findBridgeObservation(workspaceId: string): Promise<BridgeObservation> {
  const runtime = readRuntimeState(workspaceId);
  if (!runtime) return { state: "stopped", runtime: null, reason: "runtime_missing" };
  if (runtime.workspaceId !== workspaceId || runtime.service !== SERVICE_NAME) {
    return { state: "unknown", runtime, reason: "workspace_mismatch" };
  }

  let health = await probeBridge(runtime.port);
  let pid = await observeProcessPresence(runtime.pid);
  if (!health && pid === "present") {
    health = await probeBridge(runtime.port, LIVE_PID_HEALTH_RETRY_TIMEOUT_MS);
    pid = await observeProcessPresence(runtime.pid);
  }
  if (health) {
    if (health.status !== "ok" || typeof health.workspaceId !== "string" || !health.workspaceId) {
      return { state: "unknown", runtime, reason: "identity_mismatch" };
    }
    const legacy = health.pid === undefined && health.startedAt === undefined;
    const healthStart = typeof health.startedAt === "string" ? Date.parse(health.startedAt) : NaN;
    const identified = typeof health.pid === "number" && Number.isSafeInteger(health.pid) &&
      health.pid > 0 && Number.isFinite(healthStart);
    const savedStart = Date.parse(runtime.startedAt);
    const samePid = health.pid === runtime.pid;
    const sameStart = identified && healthStart === savedStart;
    // 端口复用不是身份矛盾的充分证据：旧 PID 必须已死亡，或同一 PID 的启动时间证明已被复用。
    if ((legacy || identified) && (
      (pid === "missing" && !samePid) ||
      (identified && samePid && pid === "present" && Number.isFinite(savedStart) &&
        healthStart > savedStart)
    )) return { state: "stopped", runtime, reason: "stale_runtime" };
    if (health.workspaceId !== workspaceId) {
      return { state: "unknown", runtime, reason: "workspace_mismatch" };
    }
    if (runtime.runtimeBuildId !== undefined && health.runtimeBuildId !== undefined &&
      health.runtimeBuildId !== runtime.runtimeBuildId) return { state: "unknown", runtime, reason: "identity_mismatch" };
    if (legacy && pid === "present" && Number.isFinite(savedStart) &&
      typeof runtime.adminToken === "string" && runtime.adminToken.length > 0) {
      try {
        const info = await adminFetch<Partial<RuntimeState>>(runtime, "GET", "/admin/info", 2000);
        if (info.service === runtime.service && info.workspaceId === workspaceId &&
          info.pid === runtime.pid && info.startedAt === runtime.startedAt &&
          (runtime.runtimeBuildId === undefined || info.runtimeBuildId === runtime.runtimeBuildId) &&
          await observeProcessPresence(runtime.pid) === "present") return { state: "healthy", runtime };
      } catch {
        // 旧 health 不是授权证明；认证失败、重定向或端口复用均保持 unknown。
      }
    }
    if (!legacy && identified && samePid && pid === "unknown" && Number.isFinite(savedStart) &&
      await authenticateRuntimeIdentity(runtime, health)) return { state: "healthy", runtime };
    if (pid === "present" && identified && samePid && sameStart &&
      (runtime.runtimeBuildId === undefined || health.runtimeBuildId === runtime.runtimeBuildId)) return { state: "healthy", runtime };
    return { state: "unknown", runtime, reason: "identity_mismatch" };
  }

  if (pid === "missing") return { state: "stopped", runtime, reason: "pid_missing" };
  return { state: "unknown", runtime, reason: pid === "unknown" ? "pid_unknown" : "probe_failed" };
}

export async function findLiveBridge(workspaceId: string): Promise<RuntimeState | null> {
  const observation = await findBridgeObservation(workspaceId);
  return observation.state === "healthy" ? observation.runtime : null;
}

export { SERVICE_NAME, VERSION };
