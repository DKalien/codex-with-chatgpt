import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getStateDir } from "../config/paths.js";
import { isRuntimeBuildId } from "../build-id.js";
import type { RuntimeState } from "../bridge/runtime.js";
import type { Workspace } from "../workspace/manager.js";
import { getCurrentInstall } from "./install.js";

export const UPGRADE_REASONS = ["busy", "approval_pending", "quick", "named_unhealthy", "pairing_active",
  "desktop_unresolved", "desktop_unknown", "remote_active", "remote_unknown", "runtime_unknown",
  "runtime_corrupt", "identity_mismatch", "restart_failed", "postcheck_failed", "rollout_busy", "build_unknown"] as const;
export type UpgradeReason = typeof UPGRADE_REASONS[number];
type LocalWorkspace = Pick<Workspace, "id" | "root">;
const pendingSchema = z.object({
  workspaceId: z.string().regex(/^[a-f0-9]{12}$/), workspaceRoot: z.string().refine(path.isAbsolute),
  targetBuildId: z.string().refine(isRuntimeBuildId), reason: z.enum(UPGRADE_REASONS), updatedAt: z.string().datetime(),
}).strict();
export type UpgradePending = z.infer<typeof pendingSchema>;

export function pendingFile(workspaceId: string): string {
  if (!/^[a-f0-9]{12}$/.test(workspaceId)) throw new Error("Invalid pending workspace ID");
  return path.join(getStateDir(), "runtime-upgrades", `${workspaceId}.json`);
}

export function readPending(workspace: LocalWorkspace): UpgradePending | null {
  try {
    const pending = pendingSchema.parse(JSON.parse(fs.readFileSync(pendingFile(workspace.id), "utf8")));
    if (pending.workspaceId !== workspace.id || pending.workspaceRoot !== workspace.root) throw new Error("Pending workspace mismatch");
    return pending;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Runtime upgrade pending 状态损坏或身份不匹配；保留原状态。");
  }
}

export function writePending(workspace: LocalWorkspace, targetBuildId: string, reason: UpgradeReason): void {
  const previous = readPending(workspace);
  if (previous?.targetBuildId === targetBuildId && previous.reason === reason) return;
  const pending = pendingSchema.parse({ workspaceId: workspace.id, workspaceRoot: workspace.root,
    targetBuildId, reason, updatedAt: new Date().toISOString() });
  const file = pendingFile(workspace.id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(pending)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function clearPending(workspace: LocalWorkspace): void {
  if (readPending(workspace)) fs.unlinkSync(pendingFile(workspace.id));
}

/** status/doctor 只读，不以 metadata 将旧进程冒充为新 build。 */
export function readRuntimeUpgrade(workspace: LocalWorkspace, runtime: RuntimeState | null) {
  const installed = getCurrentInstall();
  const runtimeBuildId = isRuntimeBuildId(runtime?.runtimeBuildId) ? runtime.runtimeBuildId : null;
  const installedBuildId = installed.metadata?.runtimeBuildId ?? null;
  let pending: UpgradePending | null;
  try { pending = readPending(workspace); }
  catch { return { runtimeBuildId, installedBuildId, state: "unknown", upgradePending: true, reason: "pending_corrupt" }; }
  if (installed.status !== "installed") return { runtimeBuildId, installedBuildId, state: "unknown",
    upgradePending: Boolean(runtime || pending), reason: `install_${installed.status}` };
  const mismatch = runtime !== null && runtimeBuildId !== installedBuildId;
  return { runtimeBuildId, installedBuildId, state: !runtime ? "stopped" : mismatch ? "stale" : "current",
    upgradePending: Boolean(pending || mismatch), reason: pending?.reason ?? (mismatch ? "build_stale" : null),
    targetBuildId: pending?.targetBuildId ?? null };
}
