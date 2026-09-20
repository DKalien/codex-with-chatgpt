import { z } from "zod";
import {
  desktopIpc,
  type DesktopTarget,
  type DesktopUnknownReconcileObservation,
} from "./ipc.js";
import {
  DesktopError,
  desktopId,
  readDesktop,
  updateDesktop,
  type DesktopDelivery,
  type DesktopState,
} from "./store.js";

export interface UnknownReconciliationWorkspace {
  id: string;
  root: string;
}

export interface UnknownReconciliationResult {
  status: "accepted" | "unresolved";
  commandId: string;
  deliveryStatus: "accepted" | "outcome_unknown";
  turnId?: string;
}

export interface UnknownReconciliationOptions {
  expectedTurnId?: string;
}

const workspaceInput = z.object({ id: desktopId, root: z.string().min(1) }).strict();
const uuid = z.string().uuid();

function fail(code: string, message: string): never {
  throw new DesktopError(code, message);
}

function strictUuid(value: unknown): value is string {
  return typeof value === "string" && value === value.toLowerCase() && uuid.safeParse(value).success;
}

function checkedTarget(state: DesktopState, workspace: UnknownReconciliationWorkspace, delivery: DesktopDelivery): DesktopTarget {
  if (state.workspaceRoot !== workspace.root || !state.binding ||
      state.binding.bindingId !== delivery.bindingId || state.binding.threadId !== delivery.threadId) {
    return fail("DESKTOP_RECONCILIATION_CONFLICT", "Desktop binding、thread 或 workspace 在对账前不一致；未修改投递状态。");
  }
  return {
    threadId: state.binding.threadId,
    hostId: state.binding.hostId,
    projectId: state.binding.projectId,
    workspaceRoot: workspace.root,
  };
}

function sameObservation(observation: DesktopUnknownReconcileObservation, target: DesktopTarget): boolean {
  return observation.threadId === target.threadId && observation.hostId === target.hostId &&
    observation.projectId === target.projectId && observation.workspaceRoot === target.workspaceRoot;
}

function validateObservation(value: DesktopUnknownReconcileObservation, target: DesktopTarget): string[] {
  if (!sameObservation(value, target) || !Array.isArray(value.candidates) || value.candidates.length > 10_000 ||
      !value.candidates.every(strictUuid)) {
    return fail("DESKTOP_RECONCILIATION_CONFLICT", "Desktop 返回的对账身份或 turn 候选无法严格核验；未修改投递状态。");
  }
  return value.candidates;
}

function sameDelivery(left: DesktopDelivery, right: DesktopDelivery): boolean {
  return left.commandId === right.commandId && left.clientId === right.clientId &&
    left.bindingId === right.bindingId && left.threadId === right.threadId &&
    left.intent === right.intent && left.messageSha256 === right.messageSha256 &&
    left.messageBytes === right.messageBytes && left.deliveryStatus === right.deliveryStatus &&
    left.turnId === right.turnId;
}

/**
 * 只把 Desktop 独立观察到的唯一真实 turn 补回 unknown delivery；不写 execution receipt。
 * 任何身份漂移、重复候选或已有终态都保持 fail-closed。
 */
export async function reconcileUnknownDesktopDelivery(
  workspaceRaw: UnknownReconciliationWorkspace,
  commandId: string,
  options: UnknownReconciliationOptions = {},
): Promise<UnknownReconciliationResult> {
  const workspace = workspaceInput.parse({ id: workspaceRaw.id, root: workspaceRaw.root });
  desktopId.parse(commandId);
  if (options.expectedTurnId !== undefined && !strictUuid(options.expectedTurnId)) {
    return fail("DESKTOP_RECONCILIATION_CONFLICT", "expected result turn 无法严格核验；未修改投递状态。");
  }
  const snapshot = readDesktop(workspace.id);
  if (!snapshot || snapshot.workspaceRoot !== workspace.root) {
    return fail("DESKTOP_RECONCILIATION_NOT_ELIGIBLE", "当前 workspace 没有可核对的 Desktop 状态；未修改投递状态。");
  }
  const delivery = snapshot.deliveries.find(item => item.commandId === commandId);
  if (!delivery || delivery.deliveryStatus !== "outcome_unknown" || delivery.turnId !== undefined || delivery.intent === undefined) {
    return fail("DESKTOP_RECONCILIATION_NOT_ELIGIBLE", "仅允许带完整 intent 的 outcome_unknown delivery；未修改投递状态。");
  }
  const target = checkedTarget(snapshot, workspace, delivery);
  const observation = await desktopIpc.reconcileUnknown(target, {
    workspaceId: workspace.id,
    commandId,
    intent: delivery.intent,
    messageBytes: delivery.messageBytes,
    messageSha256: delivery.messageSha256,
  });
  const candidates = validateObservation(observation, target);
  if (candidates.length === 0) {
    return { status: "unresolved", commandId, deliveryStatus: "outcome_unknown" };
  }
  if (candidates.length !== 1) {
    return fail("DESKTOP_RECONCILIATION_CONFLICT", "Desktop 历史存在多个精确候选；拒绝猜测或修改投递状态。");
  }
  const turnId = candidates[0];
  if (options.expectedTurnId !== undefined && turnId !== options.expectedTurnId) {
    return { status: "unresolved", commandId, deliveryStatus: "outcome_unknown" };
  }
  const accepted = updateDesktop(workspace.id, current => {
    if (!current || current.workspaceRoot !== workspace.root || (current.revision ?? 0) !== (snapshot.revision ?? 0)) {
      return fail("DESKTOP_RECONCILIATION_CONFLICT", "对账期间 Desktop workspace 状态发生变化；未修改投递状态。");
    }
    const currentDelivery = current.deliveries.find(item => item.commandId === commandId);
    if (!currentDelivery || !sameDelivery(currentDelivery, delivery) || currentDelivery.deliveryStatus !== "outcome_unknown") {
      return fail("DESKTOP_RECONCILIATION_CONFLICT", "对账期间 delivery 或 binding 发生变化；未修改投递状态。");
    }
    const currentTarget = checkedTarget(current, workspace, currentDelivery);
    if (!sameObservation(observation, currentTarget) ||
        (options.expectedTurnId !== undefined && turnId !== options.expectedTurnId) ||
        current.deliveries.some(item => item.turnId === turnId)) {
      return fail("DESKTOP_RECONCILIATION_CONFLICT", "对账结果与当前 binding 或投递历史不一致；未修改投递状态。");
    }
    currentDelivery.deliveryStatus = "accepted";
    currentDelivery.turnId = turnId;
    currentDelivery.updatedAt = new Date().toISOString();
    return {
      state: current,
      result: { status: "accepted" as const, commandId, deliveryStatus: "accepted" as const, turnId },
    };
  });
  return accepted;
}
