/**
 * G3-0a: explicit maintenance to prune proven-stale runtime state files.
 * Never auto-runs from GC; never deletes healthy/unknown runtime.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { isRuntimeBuildId } from "../build-id.js";
import { getStateDir } from "../config/paths.js";
import { Workspace } from "../workspace/manager.js";
import {
  clearRuntimeState,
  findBridgeObservation,
  runtimeFile,
  type RuntimeState,
} from "../bridge/runtime.js";
import { SERVICE_NAME } from "../version.js";
import {
  MaintenanceBusyError,
  releaseMaintenanceOrThrow,
  tryAcquireMaintenanceLock,
} from "./maintenance-lock.js";

export type RuntimeBuildIdState = "missing" | "valid" | "malformed";

export type PruneObservationReason = "stale_runtime" | "pid_missing";

export interface RuntimePrunePlanOk {
  ok: true;
  eligible: boolean;
  workspaceId: string;
  workspaceName: string;
  observation?: { state: "stopped"; reason: PruneObservationReason };
  runtimeBuildIdState?: RuntimeBuildIdState;
  confirmationSha256?: string;
  blockedReason?: string;
}

export interface RuntimePrunePlanFail {
  ok: false;
  eligible: false;
  error: string;
}

export type RuntimePrunePlanResult = RuntimePrunePlanOk | RuntimePrunePlanFail;

export interface RuntimePruneApplyResult {
  ok: boolean;
  removed: boolean;
  workspaceId?: string;
  observation?: PruneObservationReason;
  reason?: string;
}

const WORKSPACE_ID = /^[a-f0-9]{12}$/;
const HEX64 = /^[a-f0-9]{64}$/;

/**
 * Base schema allows missing/legacy runtimeBuildId only.
 * Extra unknown fields are schema-invalid — not legacy.
 */
const runtimeBaseSchema = z.object({
  service: z.string().min(1),
  version: z.string().min(1),
  workspaceId: z.string().regex(WORKSPACE_ID),
  workspaceRoot: z.string().refine((v) => path.isAbsolute(v)),
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
  adminToken: z.string().min(1),
  publicUrl: z.string().url().nullable(),
  startedAt: z.string().datetime(),
  runtimeBuildId: z.string().optional(),
}).strict();

/**
 * Legacy missing = field absent only.
 * Empty string / null / non-hex / non-lowercase-hex are malformed, never missing.
 */
function buildIdState(value: unknown): RuntimeBuildIdState {
  if (value === undefined) return "missing";
  if (typeof value === "string" && HEX64.test(value)) return "valid";
  return "malformed";
}

function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function isCanonicalRegularFile(file: string): boolean {
  try {
    const lstat = fs.lstatSync(file);
    if (!lstat.isFile() || lstat.isSymbolicLink()) return false;
    return fs.realpathSync(file) === file;
  } catch {
    return false;
  }
}

type ValidatedRuntime = {
  runtime: RuntimeState;
  fileSha256: string;
  runtimeBuildIdState: RuntimeBuildIdState;
  workspace: Workspace;
};

function validateRuntimeFile(workspace: Workspace): { ok: true; value: ValidatedRuntime } | { ok: false; blockedReason: string } {
  const file = runtimeFile(workspace.id);
  if (!fs.existsSync(file)) {
    return { ok: false, blockedReason: "runtime_missing" };
  }
  if (!isCanonicalRegularFile(file)) {
    return { ok: false, blockedReason: "runtime_not_canonical_regular" };
  }
  let raw: unknown;
  let fileBytes: Buffer;
  try {
    fileBytes = fs.readFileSync(file);
    raw = JSON.parse(fileBytes.toString("utf8"));
  } catch {
    return { ok: false, blockedReason: "runtime_json_invalid" };
  }
  const parsed = runtimeBaseSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, blockedReason: "runtime_schema_invalid" };
  }
  const data = parsed.data;
  if (data.workspaceId !== workspace.id) {
    return { ok: false, blockedReason: "workspace_id_mismatch" };
  }
  if (data.service !== SERVICE_NAME) {
    return { ok: false, blockedReason: "service_mismatch" };
  }
  try {
    if (new Workspace(data.workspaceRoot).id !== workspace.id) {
      return { ok: false, blockedReason: "workspace_root_identity_mismatch" };
    }
  } catch {
    return { ok: false, blockedReason: "workspace_root_invalid" };
  }
  const rbState = buildIdState(data.runtimeBuildId);
  if (rbState === "malformed") {
    return { ok: false, blockedReason: "runtime_build_id_malformed" };
  }
  const runtime: RuntimeState = {
    service: data.service,
    version: data.version,
    workspaceId: data.workspaceId,
    workspaceRoot: data.workspaceRoot,
    pid: data.pid,
    port: data.port,
    adminToken: data.adminToken,
    publicUrl: data.publicUrl,
    startedAt: data.startedAt,
    ...(rbState === "valid" ? { runtimeBuildId: data.runtimeBuildId } : {}),
  };
  return {
    ok: true,
    value: {
      runtime,
      fileSha256: sha256Hex(fileBytes),
      runtimeBuildIdState: rbState,
      workspace,
    },
  };
}

function confirmationFor(input: {
  workspaceId: string;
  canonicalRoot: string;
  pid: number;
  port: number;
  startedAt: string;
  runtimeBuildIdState: RuntimeBuildIdState;
  runtimeBuildIdValue: string | null;
  fileSha256: string;
  observationReason: PruneObservationReason;
  adminTokenDigest: string;
}): string {
  // Stable key order; never includes raw adminToken / publicUrl / root in output.
  const material = JSON.stringify({
    workspaceId: input.workspaceId,
    canonicalRoot: input.canonicalRoot,
    pid: input.pid,
    port: input.port,
    startedAt: input.startedAt,
    runtimeBuildIdState: input.runtimeBuildIdState,
    runtimeBuildIdValue: input.runtimeBuildIdValue,
    fileSha256: input.fileSha256,
    observationReason: input.observationReason,
    adminTokenDigest: input.adminTokenDigest,
  });
  return sha256Hex(material);
}

function eligibleObservationReason(state: string, reason: string): PruneObservationReason | null {
  if (state === "stopped" && (reason === "stale_runtime" || reason === "pid_missing")) {
    return reason as PruneObservationReason;
  }
  return null;
}

/** Read-only plan. Zero writes to runtime/session/desktop/feedback/remote. */
export async function planRuntimePrune(workspaceRoot: string): Promise<RuntimePrunePlanResult> {
  let workspace: Workspace;
  try {
    workspace = new Workspace(workspaceRoot);
  } catch {
    // Never echo WorkspaceError.message (it embeds the local path).
    return {
      ok: false,
      eligible: false,
      error: "workspace_invalid",
    };
  }

  const validated = validateRuntimeFile(workspace);
  if (!validated.ok) {
    return {
      ok: true,
      eligible: false,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      blockedReason: validated.blockedReason,
    };
  }

  const observation = await findBridgeObservation(workspace.id);
  const observationReason = observation.state === "healthy" ? "" : observation.reason;
  const reason = eligibleObservationReason(observation.state, observationReason ?? "");
  if (!reason) {
    // Bounded output: observation field only when eligible=true.
    return {
      ok: true,
      eligible: false,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      runtimeBuildIdState: validated.value.runtimeBuildIdState,
      blockedReason:
        observation.state === "stopped"
          ? `observation_stopped_${observation.reason}`
          : `observation_${observation.state}_${observationReason || "unknown"}`,
    };
  }

  const { runtime, fileSha256, runtimeBuildIdState } = validated.value;
  const confirmationSha256 = confirmationFor({
    workspaceId: workspace.id,
    canonicalRoot: workspace.root,
    pid: runtime.pid,
    port: runtime.port,
    startedAt: runtime.startedAt,
    runtimeBuildIdState,
    runtimeBuildIdValue: runtimeBuildIdState === "valid" ? (runtime.runtimeBuildId ?? null) : null,
    fileSha256,
    observationReason: reason,
    adminTokenDigest: sha256Hex(runtime.adminToken),
  });

  return {
    ok: true,
    eligible: true,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    observation: { state: "stopped", reason },
    runtimeBuildIdState,
    confirmationSha256,
  };
}

/**
 * Destructive apply: maintenance lock + full revalidation + CAS clearRuntimeState.
 * ok = full maintenance operation success; removed = runtime file actually deleted.
 * Never rewrite removed=false after a successful delete (e.g. release failure).
 */
export async function applyRuntimePrune(
  workspaceRoot: string,
  confirm: string,
): Promise<RuntimePruneApplyResult> {
  if (typeof confirm !== "string" || !/^[a-f0-9]{64}$/.test(confirm)) {
    return { ok: false, removed: false, reason: "confirm_invalid" };
  }

  const initial = await planRuntimePrune(workspaceRoot);
  if (!initial.ok) {
    return { ok: false, removed: false, reason: initial.error };
  }
  if (!initial.eligible || !initial.confirmationSha256 || !initial.observation) {
    return { ok: false, removed: false, reason: initial.blockedReason ?? "not_eligible" };
  }
  if (initial.confirmationSha256 !== confirm) {
    return { ok: false, removed: false, workspaceId: initial.workspaceId, reason: "confirmation_mismatch" };
  }

  let workspace: Workspace;
  try {
    workspace = new Workspace(workspaceRoot);
  } catch {
    return { ok: false, removed: false, reason: "workspace_invalid" };
  }

  const stateDir = getStateDir();
  const acquired = tryAcquireMaintenanceLock(stateDir, "runtime_prune_stale");
  if (!acquired.ok) {
    return { ok: false, removed: false, workspaceId: workspace.id, reason: "maintenance_busy" };
  }

  // Do not return from inside the maintenance try — JS freezes the return value
  // before finally, which previously hid release failures after a successful delete.
  let result: RuntimePruneApplyResult = {
    ok: false,
    removed: false,
    workspaceId: workspace.id,
    reason: "not_removed",
  };

  try {
    const validated = validateRuntimeFile(workspace);
    if (!validated.ok) {
      result = { ok: false, removed: false, workspaceId: workspace.id, reason: validated.blockedReason };
    } else {
      const observation = await findBridgeObservation(workspace.id);
      const observationReason = observation.state === "healthy" ? "" : observation.reason;
      const reason = eligibleObservationReason(observation.state, observationReason ?? "");
      if (!reason) {
        result = {
          ok: false,
          removed: false,
          workspaceId: workspace.id,
          reason: `fresh_observation_${observation.state}_${observationReason || "unknown"}`,
        };
      } else {
        const { runtime, fileSha256, runtimeBuildIdState } = validated.value;
        const freshConfirm = confirmationFor({
          workspaceId: workspace.id,
          canonicalRoot: workspace.root,
          pid: runtime.pid,
          port: runtime.port,
          startedAt: runtime.startedAt,
          runtimeBuildIdState,
          runtimeBuildIdValue: runtimeBuildIdState === "valid" ? (runtime.runtimeBuildId ?? null) : null,
          fileSha256,
          observationReason: reason,
          adminTokenDigest: sha256Hex(runtime.adminToken),
        });
        if (freshConfirm !== confirm) {
          result = { ok: false, removed: false, workspaceId: workspace.id, reason: "fresh_confirmation_mismatch" };
        } else {
          // CAS-style: only clear if pid + startedAt + adminToken still match.
          clearRuntimeState(workspace.id, {
            pid: runtime.pid,
            startedAt: runtime.startedAt,
            adminToken: runtime.adminToken,
          });
          if (fs.existsSync(runtimeFile(workspace.id))) {
            result = { ok: false, removed: false, workspaceId: workspace.id, reason: "runtime_file_still_present" };
          } else {
            result = { ok: true, removed: true, workspaceId: workspace.id, observation: reason };
          }
        }
      }
    }
  } catch (error) {
    result = {
      ok: false,
      removed: false,
      workspaceId: workspace.id,
      reason: error instanceof MaintenanceBusyError ? "maintenance_busy" : "apply_failed",
    };
  }

  try {
    releaseMaintenanceOrThrow(acquired.handle, { result });
  } catch {
    // Mutation fact must survive cleanup failure: removed stays true if the file was deleted.
    return {
      ...result,
      ok: false,
      removed: result.removed === true,
      reason: "maintenance_release_failed",
    };
  }

  return result;
}

export { isRuntimeBuildId };
