import { deliverCurrentCommand } from "../routing/current-command-transport.js";
import { readDesktop } from "../desktop/store.js";
import type { Workspace } from "../workspace/manager.js";
import {
  locatorExactEqual,
  type ExecutorDeliveryTargetSnapshot,
} from "../endpoints/schema.js";
import { codexExecutorProjectId, CodexTargetTranslationError } from "../executor/codex-target.js";
import { ExecutorControlError } from "./schema.js";

export interface ProductionSendRequest {
  readonly workspace: Workspace;
  readonly plannerFingerprint: string;
  readonly commandId: string;
  readonly intent: "development_plan" | "revision";
  readonly message: string;
  readonly userConfirmed: true;
  readonly clientId: string;
  /** R5e：backend 只认 dispatch ledger 冻结的 target snapshot；不再接收 Active binding。 */
  readonly target: ExecutorDeliveryTargetSnapshot;
  readonly authorize: () => void;
}

export interface ProductionSendResult {
  readonly commandId: string;
  readonly pluginId: string;
  readonly bindingId: string;
  readonly sessionId: string;
  readonly deliveryStatus: "accepted" | "rejected" | "outcome_unknown";
  readonly deliveryId?: string;
  readonly error?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly message: string;
}

export interface ExecutorProductionBackend {
  readonly pluginId: string;
  send(request: ProductionSendRequest): Promise<ProductionSendResult>;
}

const CODEX_PLUGIN_ID = "codex-desktop";

function reject(code: string, message: string): never {
  throw new ExecutorControlError(code, message);
}

function assertExactWorkspace(
  workspace: Workspace,
  target: ExecutorDeliveryTargetSnapshot,
): void {
  if (target.workspaceId !== workspace.id || target.workspaceRoot !== workspace.root) {
    reject("EXECUTOR_CONTROL_WORKSPACE_MISMATCH", "delivery target workspace 与当前 workspace 不一致。");
  }
}

function assertExactCodexLocator(target: ExecutorDeliveryTargetSnapshot): string {
  try { return codexExecutorProjectId(target.locator); }
  catch (error) {
    if (error instanceof CodexTargetTranslationError) reject("EXECUTOR_BINDING_STALE", `${error.message}。`);
    throw error;
  }
}

/**
 * Generic binding ↔ legacy Desktop binding exact attestation。
 * 两个 bindingId 是不同概念；只比 session/instance/project/workspace/plugin。
 */
function assertGenericMatchesLegacyDesktop(
  workspace: Workspace,
  target: ExecutorDeliveryTargetSnapshot,
  projectId: string,
): string {
  if (target.pluginId !== CODEX_PLUGIN_ID) {
    reject("EXECUTOR_BINDING_STALE", "active binding 不是 Codex Desktop。");
  }
  const state = readDesktop(workspace.id);
  if (!state) {
    reject("EXECUTOR_BINDING_STALE", "本机 Desktop Control 状态不存在。");
  }
  if (state.workspaceRoot !== workspace.root) {
    reject("EXECUTOR_CONTROL_WORKSPACE_MISMATCH", "Desktop 状态 workspaceRoot 不匹配。");
  }
  if (!state.enabled || !state.binding) {
    reject("EXECUTOR_BINDING_STALE", "本机 Desktop Control 未启用或未绑定。");
  }
  const binding = state.binding;
  if (
    binding.threadId !== target.sessionId ||
    binding.hostId !== target.instanceId ||
    binding.projectId !== projectId
  ) {
    reject(
      "EXECUTOR_BINDING_STALE",
      "generic active binding 与当前 Desktop binding 不一致；请重新 bind-current。",
    );
  }
  return binding.bindingId;
}

/**
 * Codex Desktop production delivery backend。
 * 委托现有 deliverCurrentCommand durable R4 transport。
 * production 投递只通过受控 transport。
 */
export class CodexDesktopProductionBackend implements ExecutorProductionBackend {
  readonly pluginId = CODEX_PLUGIN_ID;

  async send(request: ProductionSendRequest): Promise<ProductionSendResult> {
    const { target, workspace } = request;
    assertExactWorkspace(workspace, target);
    const projectId = assertExactCodexLocator(target);
    const legacyBindingId = assertGenericMatchesLegacyDesktop(workspace, target, projectId);
    const delivered = await deliverCurrentCommand(
      workspace,
      request.plannerFingerprint,
      {
        commandId: request.commandId,
        intent: request.intent,
        payload: request.message,
        userConfirmed: request.userConfirmed,
      },
      request.clientId,
      request.authorize,
      legacyBindingId,
    );
    const delivery = delivered.delivery;
    if (!delivery) {
      // expectedBindingId 路径必须有 durable public delivery；缺失即不变量失败。
      reject("EXECUTOR_DELIVERY_MISSING", "production transport 未返回 durable delivery；拒绝合成结果。");
    }
    return {
      commandId: delivery.commandId,
      pluginId: target.pluginId,
      bindingId: target.bindingId,
      sessionId: target.sessionId,
      deliveryStatus: delivery.deliveryStatus,
      ...(delivery.turnId ? { deliveryId: delivery.turnId } : {}),
      ...(delivery.error ? { error: delivery.error } : {}),
      createdAt: delivery.createdAt,
      updatedAt: delivery.updatedAt,
      message: delivery.message,
    };
  }
}

export function createCodexDesktopProductionBackend(): ExecutorProductionBackend {
  return new CodexDesktopProductionBackend();
}

export { assertExactCodexLocator, locatorExactEqual };
