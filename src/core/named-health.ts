import { SERVICE_NAME } from "../version.js";

export interface NamedHealthIdentity {
  workspaceId: string;
  pid: number;
  startedAt: string;
  runtimeBuildId?: string | null;
}
export type NamedHealthFailure = "timeout" | "network" | "http" | "invalid_json" |
  "wrong_service" | "wrong_status" | "workspace_mismatch" | "pid_mismatch" |
  "started_at_mismatch" | "build_mismatch" | "stale_runtime";
type Failure = { ok: false; failure: NamedHealthFailure; httpStatus?: number };
type Attempt = { ok: true } | Failure;
export type NamedHealthResult = Attempt & { attempts: number };

// One exact response suffices. Each probe has an 18.4s transport/backoff budget;
// rollout's preflight, pre-shutdown and postcheck total at most 55.2s of this budget.
const ATTEMPT_TIMEOUTS_MS = [5000, 5000, 8000] as const;
const BACKOFF_MS = 200;

function processMismatch(health: Record<string, unknown>, expected: NamedHealthIdentity): NamedHealthFailure | null {
  if (health.pid !== expected.pid) return "pid_mismatch";
  if (health.startedAt !== expected.startedAt) return "started_at_mismatch";
  // A legacy local runtime without a build ID remains supported. Modern local
  // authority requires the public response to include that exact build ID.
  if (expected.runtimeBuildId != null && health.runtimeBuildId !== expected.runtimeBuildId) return "build_mismatch";
  return null;
}

async function attempt(url: string, expected: NamedHealthIdentity, timeoutMs: number,
  previous?: NamedHealthIdentity): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url}/health`, { signal: controller.signal, redirect: "error" });
    if (!response.ok) {
      // Do not leave an unread error body holding a connection between attempts.
      controller.abort();
      return { ok: false, failure: "http", httpStatus: response.status };
    }
    let value: unknown;
    try { value = await response.json(); }
    catch (error) {
      return { ok: false, failure: controller.signal.aborted ? "timeout" : error instanceof SyntaxError ? "invalid_json" : "network" };
    }
    const health = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
    if (health.service !== SERVICE_NAME) return { ok: false, failure: "wrong_service" };
    if (health.status !== "ok") return { ok: false, failure: "wrong_status" };
    if (health.workspaceId !== expected.workspaceId) return { ok: false, failure: "workspace_mismatch" };
    const mismatch = processMismatch(health, expected);
    if (!mismatch) return { ok: true };
    // Only postcheck supplies the exact authenticated pre-restart identity.
    // Arbitrary old/foreign processes are semantic failures, never retry targets.
    if (previous?.workspaceId === expected.workspaceId && processMismatch(health, previous) === null)
      return { ok: false, failure: "stale_runtime" };
    return { ok: false, failure: mismatch };
  } catch {
    return { ok: false, failure: controller.signal.aborted ? "timeout" : "network" };
  } finally { clearTimeout(timer); }
}

/** Read-only: never changes runtime, tunnel, pending or business state. */
export async function probeNamedHealth(url: string, expected: NamedHealthIdentity,
  previous?: NamedHealthIdentity): Promise<NamedHealthResult> {
  for (let index = 0; index < ATTEMPT_TIMEOUTS_MS.length; index++) {
    const result = await attempt(url, expected, ATTEMPT_TIMEOUTS_MS[index]!, previous);
    const retry = !result.ok && (["timeout", "network", "invalid_json", "stale_runtime"].includes(result.failure) ||
      (result.failure === "http" && (result.httpStatus === 429 || (result.httpStatus! >= 500 && result.httpStatus! <= 599))));
    if (result.ok || !retry || index === ATTEMPT_TIMEOUTS_MS.length - 1) return { ...result, attempts: index + 1 };
    // 429 uses the same bounded backoff; untrusted Retry-After cannot extend maintenance.
    await new Promise(resolve => setTimeout(resolve, BACKOFF_MS));
  }
  throw new Error("Unreachable named health attempt budget");
}
