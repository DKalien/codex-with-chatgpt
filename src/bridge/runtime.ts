import fs from "node:fs";
import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";

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
export async function probeBridge(
  port: number,
  timeoutMs = 2000
): Promise<HealthPayload | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const body = (await response.json()) as HealthPayload;
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
  timeoutMs = 60_000
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
      method,
      headers: { Authorization: `Bearer ${runtime.adminToken}` },
      signal: controller.signal,
      redirect: "error",
    });
    const body = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok) {
      throw new Error((body as { message?: string }).message ?? `Admin request failed (${response.status})`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export type BridgeObservation =
  | { state: "healthy"; runtime: RuntimeState }
  | { state: "stopped"; runtime: RuntimeState | null; reason: "runtime_missing" | "pid_missing" | "stale_runtime" }
  | { state: "unknown"; runtime: RuntimeState | null; reason: "probe_failed" | "pid_unknown" | "workspace_mismatch" | "identity_mismatch" };

function observePid(pid: number): "present" | "missing" | "unknown" {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "missing" : "unknown";
  }
}

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

  const health = await probeBridge(runtime.port);
  const pid = observePid(runtime.pid);
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
    if (legacy && pid === "present" && Number.isFinite(savedStart) &&
      typeof runtime.adminToken === "string" && runtime.adminToken.length > 0) {
      try {
        const info = await adminFetch<Partial<RuntimeState>>(runtime, "GET", "/admin/info", 2000);
        if (info.service === runtime.service && info.workspaceId === workspaceId &&
          info.pid === runtime.pid && info.startedAt === runtime.startedAt &&
          observePid(runtime.pid) === "present") return { state: "healthy", runtime };
      } catch {
        // 旧 health 不是授权证明；认证失败、重定向或端口复用均保持 unknown。
      }
    }
    if (!legacy && identified && samePid && pid === "unknown" && Number.isFinite(savedStart) &&
      await authenticateRuntimeIdentity(runtime, health)) return { state: "healthy", runtime };
    if (pid === "present" && identified && samePid && sameStart) return { state: "healthy", runtime };
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
