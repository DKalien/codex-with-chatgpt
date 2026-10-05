import type { Workspace } from "../workspace/manager.js";
import { ExecutorControlError } from "./schema.js";
import { ExecutorDispatchError } from "./dispatch-schema.js";
import { beginExecutorDispatch, finalizeExecutorDispatch, hashRequestAuthority, markExecutorDispatchOutcomeUnknown, releaseUnsentExecutorPin } from "./dispatch-service.js";
import { DesktopError } from "../desktop/store.js";
import { resolveProductionBackend } from "./service.js";
import type { ProductionSendResult } from "./codex-backend.js";
import { withCommandOperationAsync } from "../command-cleanup/fence.js";
import { RoutingError } from "../routing/schema.js";

export interface ExecutorSendInput {
  workspaceId: string; bindingId: string; commandId: string;
  intent: "development_plan" | "revision"; message: string; userConfirmed: true;
}

/** Shared by synchronous compatibility callers and the durable command mailbox. */
export async function dispatchExecutorCommand(workspace: Workspace, input: ExecutorSendInput,
  plannerFingerprint: string, clientId: string, authorize: () => void, queueOnBusy = false) {
  authorize();
  return withCommandOperationAsync(workspace.id, input.commandId, async () => {
  // R5e：新 commandId 的 pin 在 endpoint switch lock 内完成（beginExecutorDispatch
  // 内部）；existing entry 的 replay/recovery 只走 dispatch-store transaction，
  // 不需要 switch lock。同 owner 的 live in-flight 重试 → EXECUTOR_DISPATCH_IN_FLIGHT。
  const pinned = beginExecutorDispatch({
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    bindingId: input.bindingId,
    commandId: input.commandId,
    intent: input.intent,
    message: input.message,
    requestAuthoritySha256: hashRequestAuthority(plannerFingerprint),
    lifecycle: "ephemeral",
  });
  const { entry, target } = pinned;
  const expectedDispatchGenerationId = entry.dispatchGenerationId;
  if (pinned.phase === "replay") {
    // replay：不调用 backend；DTO 从 durable entry + 冻结 target 合成。
    return {
      commandId: input.commandId,
      pluginId: target.pluginId,
      bindingId: target.bindingId,
      sessionId: target.sessionId,
      deliveryStatus: entry.deliveryStatus,
      ...(entry.deliveryId !== undefined ? { deliveryId: entry.deliveryId } : {}),
      ...(entry.errorCode !== undefined ? { error: entry.errorCode } : {}),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      message: `replay:${entry.deliveryStatus}`,
    };
  }
  if (!expectedDispatchGenerationId || entry.lifecycle !== "ephemeral") {
    throw new ExecutorDispatchError("EXECUTOR_DISPATCH_GENERATION_MISMATCH", "新 dispatch pin 缺少 lifecycle generation；拒绝发送。");
  }
  const backend = resolveProductionBackend(target.pluginId);
  let sent: ProductionSendResult;
  try {
    sent = await backend.send({
      workspace,
      plannerFingerprint,
      commandId: input.commandId,
      intent: input.intent,
      message: input.message,
      userConfirmed: input.userConfirmed,
      clientId,
      target,
      authorize,
    });
  } catch (error) {
    if (queueOnBusy && target.pluginId === "codex-desktop" &&
        ((error instanceof DesktopError && error.code === "DESKTOP_BUSY") ||
         (error instanceof RoutingError && error.code === "ROUTING_MAILBOX_CLOSED"))) {
      // Codex backend forwards this exception only from prepare-before-commit.
      // Failure to prove the rollback leaves the original conservative ledger.
      releaseUnsentExecutorPin({ workspaceId: workspace.id, workspaceRoot: workspace.root,
        commandId: input.commandId, target, expectedDispatchGenerationId });
      throw error;
    }
    // backend 抛错 → durable outcome_unknown 收敛；失败不掩盖原始错误。
    try {
      markExecutorDispatchOutcomeUnknown({
        workspaceId: workspace.id,
        workspaceRoot: workspace.root,
        commandId: input.commandId,
        target,
        expectedDispatchGenerationId,
        errorCode: error instanceof ExecutorControlError ? error.code : "EXECUTOR_SEND_FAILED",
      });
    } catch {
      // 保留原始投递错误
    }
    throw error;
  }
  // backend result 必须与冻结 target 精确一致；漂移 → outcome_unknown + fail closed。
  if (
    sent.commandId !== input.commandId ||
    sent.pluginId !== target.pluginId ||
    sent.bindingId !== target.bindingId ||
    sent.sessionId !== target.sessionId
  ) {
    try {
      markExecutorDispatchOutcomeUnknown({
        workspaceId: workspace.id,
        workspaceRoot: workspace.root,
        commandId: input.commandId,
        target,
        expectedDispatchGenerationId,
        errorCode: "EXECUTOR_DISPATCH_RESULT_MISMATCH",
      });
    } catch {
      // 保留主错误
    }
    throw new ExecutorControlError(
      "EXECUTOR_DISPATCH_RESULT_MISMATCH",
      "backend result 与冻结 target 不一致；已收敛 outcome_unknown。",
    );
  }
  let finalized;
  try {
    finalized = finalizeExecutorDispatch({
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      commandId: input.commandId,
      target,
      expectedDispatchGenerationId,
      result: {
        deliveryStatus: sent.deliveryStatus,
        ...(sent.deliveryId !== undefined ? { deliveryId: sent.deliveryId } : {}),
        ...(sent.error !== undefined ? { errorCode: sent.error } : {}),
      },
    });
  } catch (error) {
    try {
      markExecutorDispatchOutcomeUnknown({
        workspaceId: workspace.id,
        workspaceRoot: workspace.root,
        commandId: input.commandId,
        target,
        expectedDispatchGenerationId,
        errorCode: "EXECUTOR_DISPATCH_FINALIZE_FAILED",
      });
    } catch {
      // 保留原始错误
    }
    throw error;
  }
  return {
    commandId: sent.commandId,
    pluginId: sent.pluginId,
    bindingId: sent.bindingId,
    sessionId: sent.sessionId,
    deliveryStatus: finalized.entry.deliveryStatus,
    ...(finalized.entry.deliveryId !== undefined ? { deliveryId: finalized.entry.deliveryId } : {}),
    ...(finalized.entry.errorCode !== undefined ? { error: finalized.entry.errorCode } : {}),
    createdAt: sent.createdAt,
    updatedAt: sent.updatedAt,
    message: sent.message,
  };
  });
}
