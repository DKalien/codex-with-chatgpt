import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getStateDir } from "../config/paths.js";
import { getRuntimeBuildId, isRuntimeBuildId } from "../build-id.js";
import { findBridgeObservation, adminFetch, type RuntimeState } from "../bridge/runtime.js";
import { Workspace } from "../workspace/manager.js";
import { SERVICE_NAME } from "../version.js";
import { desktopIpc } from "../desktop/ipc.js";
import { readDesktop } from "../desktop/store.js";
import { readRemote } from "../remote/store.js";
import { desktopHistory } from "../desktop/history.js";
import { unresolvedOutcomeUnknownCommandIds } from "../desktop/outcome-resolution.js";
import { readTunnelState, isNamedTunnelReady } from "../tunnel/state.js";
import { UpgradeReason } from "./upgrade.js";

export type RolloutBlocker =
  | { kind: "self_turn"; threadId: string }
  | { kind: "pairing_active" }
  | { kind: "desktop_busy"; threadId?: string }
  | { kind: "approval_pending" }
  | { kind: "desktop_unresolved" }
  | { kind: "desktop_unknown" }
  | { kind: "desktop_identity_mismatch" }
  | { kind: "remote_active" }
  | { kind: "remote_unknown" }
  | { kind: "runtime_unknown" }
  | { kind: "identity_mismatch" }
  | { kind: "named_unhealthy" }
  | { kind: "quick" }
  | { kind: "busy"; detail?: string };

export interface SelfBusyProof {
  threadId: string;
  hostId: string;
  projectId: string;
  workspaceRoot: string;
  runtimeStatus: "active" | "inProgress";
}

export interface IdleAssessment {
  idle: boolean;
  blockers: RolloutBlocker[];
  /** 仅当 blockers 严格等于单一已证明 self_turn 时存在。 */
  selfBusyProof?: SelfBusyProof;
}

export function blockerToReason(blocker: RolloutBlocker): UpgradeReason {
  switch (blocker.kind) {
    case "self_turn": return "busy";
    case "desktop_busy": return "busy";
    case "pairing_active": return "pairing_active";
    case "approval_pending": return "approval_pending";
    case "desktop_unresolved": return "desktop_unresolved";
    case "desktop_unknown": return "desktop_unknown";
    case "desktop_identity_mismatch": return "desktop_unknown";
    case "remote_active": return "remote_active";
    case "remote_unknown": return "remote_unknown";
    case "runtime_unknown": return "runtime_unknown";
    case "identity_mismatch": return "identity_mismatch";
    case "named_unhealthy": return "named_unhealthy";
    case "quick": return "quick";
    case "busy": return "busy";
  }
}

function uuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** 当前进程是否属于目标 workspace 的 Codex thread（环境变量只能保守观察，不能单独授予权限）。 */
export function currentCodexThread(workspace: Workspace): string | null {
  const threadId = process.env.CODEX_THREAD_ID;
  if (!uuid(threadId)) return null;
  try {
    if (new Workspace(process.cwd()).id !== workspace.id) return null;
  } catch {
    return null;
  }
  return threadId;
}

/**
 * 结构化 idle 评估。normal rollout 与 finalizer 共用，避免门禁漂移。
 * 不 throw Skip；调用方按 blockers 决定 restart / pending_busy / schedule。
 */
export async function assessRolloutIdle(
  workspace: Workspace,
  info: { pairingActive?: unknown; runtimeBuildId?: unknown } | null,
  options: { skipSelfTurnCheck?: boolean } = {},
): Promise<IdleAssessment> {
  const blockers: RolloutBlocker[] = [];
  const selfThreadId = options.skipSelfTurnCheck ? null : currentCodexThread(workspace);

  if (info) {
    if (typeof info.pairingActive !== "boolean") blockers.push({ kind: "runtime_unknown" });
    else if (info.pairingActive) blockers.push({ kind: "pairing_active" });
  }

  try {
    const before = readDesktop(workspace.id);
    if (before && before.workspaceRoot !== workspace.root) blockers.push({ kind: "desktop_unknown" });
    if (unresolvedOutcomeUnknownCommandIds(workspace, before).size > 0) {
      // 与原 idle() 一致：unresolved 全局阻塞，不再 inspect。
      blockers.push({ kind: "desktop_unresolved" });
    } else {
      const { desktop, accepted, skipHistory, retired, ownerless } = desktopHistory(workspace);
      if (JSON.stringify(desktop) !== JSON.stringify(before)) blockers.push({ kind: "desktop_unknown" });
      const acceptedThreads = accepted.filter(item => !skipHistory.has(item.commandId) || item.threadId === desktop?.binding?.threadId)
        .map(item => item.threadId!);
      const binding = desktop?.binding;
      if (acceptedThreads.length && !binding) blockers.push({ kind: "desktop_unknown" });
      if (binding) for (const tid of new Set([binding.threadId, ...acceptedThreads])) {
        const retirementOnly = tid !== binding.threadId && accepted
          .filter(item => item.threadId === tid && !skipHistory.has(item.commandId))
          .every(item => retired.has(item.commandId));
        let observed;
        try {
          observed = await desktopIpc.inspect({ threadId: tid, hostId: binding.hostId,
            projectId: binding.projectId, workspaceRoot: workspace.root });
        } catch (error) {
          if (!retirementOnly) {
            const code = (error as { code?: string }).code;
            if (code === "DESKTOP_BUSY") {
              if (tid !== selfThreadId) blockers.push({ kind: "desktop_busy", threadId: tid });
            } else if (code === "DESKTOP_APPROVAL_PENDING") blockers.push({ kind: "approval_pending" });
            else blockers.push({ kind: "desktop_unknown" });
            continue;
          }
          const code = (error as { code?: string }).code;
          if (code === "DESKTOP_TARGET_NOT_FOUND") continue;
          if (code === "DESKTOP_NO_OWNER" && accepted
            .filter(item => item.threadId === tid && !skipHistory.has(item.commandId))
            .every(item => ownerless.has(item.commandId))) continue;
          if (code === "DESKTOP_BUSY") {
            if (tid !== selfThreadId) blockers.push({ kind: "desktop_busy", threadId: tid });
          } else blockers.push({ kind: "desktop_unknown" });
          continue;
        }
        if (observed.runtimeStatus !== "idle") {
          if (observed.runtimeStatus === "active" || observed.runtimeStatus === "inProgress") {
            // 同一 self-turn 不再重复记 desktop_busy，避免遮挡唯一 self-busy proof。
            if (tid !== selfThreadId) blockers.push({ kind: "desktop_busy", threadId: tid });
          } else {
            blockers.push({ kind: "desktop_unknown" });
          }
        }
      }
    }
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "DESKTOP_BUSY") blockers.push({ kind: "desktop_busy" });
    else if (code === "DESKTOP_APPROVAL_PENDING") blockers.push({ kind: "approval_pending" });
    else blockers.push({ kind: "desktop_unknown" });
  }

  try {
    const remote = readRemote(workspace.id);
    if (remote && remote.workspaceRoot !== workspace.root) blockers.push({ kind: "remote_unknown" });
    const pending = new Set(["queued", "starting", "running", "awaiting_approval", "needs_reconciliation"]);
    if (remote && [...remote.threads, ...remote.tasks].some(item => pending.has(item.status))) blockers.push({ kind: "remote_active" });
    if (remote?.controller && (remote.controller.error || ["starting", "unknown"].includes(remote.controller.appServer)))
      blockers.push({ kind: "remote_unknown" });
  } catch {
    blockers.push({ kind: "remote_unknown" });
  }

  // self_turn 最后：其它 blocker 为空时才可能成为唯一 self-busy。
  if (selfThreadId) blockers.push({ kind: "self_turn", threadId: selfThreadId });

  let selfBusyProof: SelfBusyProof | undefined;
  if (blockers.length === 1 && blockers[0]!.kind === "self_turn") {
    const proof = await tryProveSelfBusy(workspace, (blockers[0] as { threadId: string }).threadId);
    if (!proof) {
      return { idle: false, blockers: [{ kind: "busy", detail: "self_turn_unproven" }] };
    }
    selfBusyProof = proof;
  }

  return { idle: blockers.length === 0, blockers, selfBusyProof };
}

/** Desktop exact origin proof：binding + current execution active/inProgress。 */
export async function tryProveSelfBusy(workspace: Workspace, threadId: string): Promise<SelfBusyProof | null> {
  const desktop = readDesktop(workspace.id);
  if (!desktop || desktop.workspaceRoot !== workspace.root) return null;
  const binding = desktop.binding;
  // 严格：仅当前 binding thread 可作为 origin proof。
  if (!binding || binding.threadId !== threadId) return null;
  try {
    const observed = await desktopIpc.currentExecution(workspace.root);
    if (observed.threadId !== binding.threadId || observed.hostId !== binding.hostId ||
      observed.projectId !== binding.projectId || observed.workspaceRoot !== workspace.root) return null;
    if (observed.runtimeStatus !== "active" && observed.runtimeStatus !== "inProgress") return null;
    return {
      threadId: observed.threadId,
      hostId: observed.hostId,
      projectId: observed.projectId,
      workspaceRoot: observed.workspaceRoot,
      runtimeStatus: observed.runtimeStatus,
    };
  } catch {
    return null;
  }
}

/** 兼容 normal rollout：有 blocker 时按现有语义 throw 对应 Skip reason。 */
export async function assertRolloutIdleOrSkip(
  workspace: Workspace,
  info: { pairingActive?: unknown; runtimeBuildId?: unknown } | null,
): Promise<IdleAssessment> {
  const assessment = await assessRolloutIdle(workspace, info);
  if (!assessment.idle) {
    const first = assessment.blockers[0]!;
    const error = new Error(first.kind) as Error & { reason: UpgradeReason; name: string };
    error.reason = blockerToReason(first);
    error.name = "RolloutSkip";
    throw error;
  }
  return assessment;
}
