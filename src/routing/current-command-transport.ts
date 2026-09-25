import { createHash } from "node:crypto";
import { sendDesktop } from "../desktop/service.js";
import { DesktopError, publicDelivery, readDesktop, type DesktopDelivery } from "../desktop/store.js";
import { projectDesktopExecutorCandidate } from "./desktop-adapter.js";
import { RoutingError, type CommandInput, type RoutingCommand } from "./schema.js";
import { createCurrentCommand } from "./current-command.js";
import { resolveCurrentExecutorRoute } from "./current-executor-route.js";
import { resolveCurrentPlannerRoute } from "./current-planner-route.js";
import { listCommands, listRoutes, transitionCommandDelivery, type RoutingWorkspaceIdentity } from "./store.js";

type Delivery = Awaited<ReturnType<typeof sendDesktop>>;

function assertCommandReplay(command: RoutingCommand, input: Pick<CommandInput, "commandId" | "intent"> & { payload: string }): void {
  const payloadBytes = Buffer.byteLength(input.payload, "utf8");
  const payloadSha256 = createHash("sha256").update(input.payload, "utf8").digest("hex");
  if (command.intent !== input.intent || command.payloadBytes !== payloadBytes || command.payloadSha256 !== payloadSha256) {
    throw new RoutingError("COMMAND_CONFLICT", "相同 commandId 但 intent 或 payload 指纹不一致；拒绝重放不同请求。");
  }
}

function assertCommandPlannerOwnership(
  identity: RoutingWorkspaceIdentity,
  plannerFingerprint: string,
  command: RoutingCommand,
): void {
  const planner = listRoutes(identity).find((route) => route.routeId === command.plannerRouteId);
  if (!planner || planner.role !== "planner" || planner.platform !== "chatgpt_web" ||
    planner.conversationId !== plannerFingerprint || JSON.stringify(planner.locator) !== "{}") {
    throw new RoutingError(
      "COMMAND_CONFLICT",
      "相同 commandId 属于不同 MCP conversation principal；拒绝重放或同步 Desktop delivery。",
    );
  }
}

function readDurableDelivery(
  identity: RoutingWorkspaceIdentity,
  command: RoutingCommand,
  clientId: string,
): DesktopDelivery | null {
  const state = readDesktop(identity.id);
  if (!state) return null;
  if (state.workspaceRoot !== identity.root) {
    throw new RoutingError("ROUTING_WORKSPACE_IDENTITY_MISMATCH", "Desktop delivery ledger 不属于当前 workspace root。");
  }
  const delivery = state.deliveries.find((item) => item.commandId === command.commandId);
  if (!delivery) return null;

  const executor = listRoutes(identity).find((route) => route.routeId === command.executorRouteId);
  if (!executor) {
    throw new RoutingError("ROUTING_ROUTE_NOT_FOUND", "pending Command 的 executor route 不存在，拒绝同步 Desktop delivery。");
  }
  if (executor.role !== "executor" || executor.platform !== "codex_desktop" ||
    delivery.clientId !== clientId || delivery.intent !== command.intent ||
    delivery.messageSha256 !== command.payloadSha256 || delivery.messageBytes !== command.payloadBytes ||
    delivery.threadId !== executor.conversationId) {
    throw new RoutingError(
      "ROUTING_DESKTOP_DELIVERY_MISMATCH",
      "Desktop durable delivery 与 routing Command 的 client/intent/payload/executor target 不一致；拒绝同步或发送。",
    );
  }
  return delivery;
}

function assertCurrentRoutes(
  identity: RoutingWorkspaceIdentity,
  plannerFingerprint: string,
  command: RoutingCommand,
  expectedBindingId?: string,
): { bindingId: string; threadId: string } {
  const planner = resolveCurrentPlannerRoute(identity, plannerFingerprint);
  const executor = resolveCurrentExecutorRoute(identity);
  const executorCandidate = projectDesktopExecutorCandidate(identity);
  if (expectedBindingId !== undefined && executorCandidate &&
    executorCandidate.legacyReferenceId !== expectedBindingId) {
    throw new DesktopError("DESKTOP_BINDING_MISMATCH", "bindingId 已失效；不能自动切换到新的投递目标。" );
  }
  if (!planner || !executor || !executorCandidate ||
    planner.routeId !== command.plannerRouteId || executor.routeId !== command.executorRouteId ||
    planner.platform !== "chatgpt_web" || planner.conversationId !== plannerFingerprint ||
    JSON.stringify(planner.locator) !== "{}" ||
    executor.conversationId !== executorCandidate.conversationId ||
    JSON.stringify(executor.locator) !== JSON.stringify(executorCandidate.locator)) {
    throw new RoutingError(
      "ROUTE_AUTHORITY_CHANGED",
      "当前 planner/executor authority 在 Desktop 投递前已变化；未发送，请重新解析。",
    );
  }
  return { bindingId: executorCandidate.legacyReferenceId, threadId: executorCandidate.conversationId };
}

/** 创建/回放当前 Command，并把原始 payload 交给现有 Desktop sender。 */
export async function deliverCurrentCommand(
  identity: RoutingWorkspaceIdentity,
  plannerFingerprint: string,
  input: Pick<CommandInput, "commandId" | "intent"> & { payload: string; userConfirmed: true },
  clientId: string,
  authorize: () => void,
  expectedBindingId?: string,
): Promise<{ command: RoutingCommand; delivery: Delivery | null }> {
  // Preserve the pre-send OAuth/request authorization fence before any routing-state write.
  authorize();
  const existing = listCommands(identity).find((item) => item.commandId === input.commandId);
  if (existing) {
    assertCommandReplay(existing, input);
    assertCommandPlannerOwnership(identity, plannerFingerprint, existing);
    if (existing.deliveryStatus !== "pending") {
      if (expectedBindingId === undefined) return { command: existing, delivery: null };
      const delivery = readDurableDelivery(identity, existing, clientId);
      if (!delivery) {
        throw new RoutingError("ROUTING_DESKTOP_DELIVERY_MISSING", "routing Command 已终态但缺少对应 Desktop durable delivery；拒绝重发。" );
      }
      if (delivery.bindingId !== expectedBindingId) {
        throw new DesktopError("DESKTOP_COMMAND_CONFLICT", "commandId 已绑定到不同 bindingId；拒绝重放到新目标。" );
      }
      return { command: existing, delivery: publicDelivery(delivery) };
    }
  } else if (expectedBindingId !== undefined) {
    const state = readDesktop(identity.id);
    if (state && state.workspaceRoot !== identity.root) {
      throw new DesktopError("DESKTOP_WRONG_WORKSPACE", "当前工作区与保存的绑定根目录不一致。" );
    }
    if (!state?.enabled || !state.binding) {
      throw new DesktopError("DESKTOP_DISABLED", "本机 Desktop Control 未启用或已撤权。" );
    }
    if (state.binding.bindingId !== expectedBindingId) {
      throw new DesktopError("DESKTOP_BINDING_MISMATCH", "bindingId 已失效；不能自动切换到新的投递目标。" );
    }
  }

  const command = existing ?? createCurrentCommand(identity, plannerFingerprint, input);

  const priorDelivery = readDurableDelivery(identity, command, clientId);
  if (priorDelivery) {
    if (expectedBindingId !== undefined && priorDelivery.bindingId !== expectedBindingId) {
      throw new DesktopError("DESKTOP_COMMAND_CONFLICT", "commandId 已绑定到不同 bindingId；拒绝重放到新目标。" );
    }
    const updated = transitionCommandDelivery(identity, {
      commandId: command.commandId,
      deliveryStatus: priorDelivery.deliveryStatus,
    });
    return { command: updated, delivery: publicDelivery(priorDelivery) };
  }

  // 只有既有 routing/desktop 状态都无 durable outcome 时才要求 authority 仍 current。
  const target = assertCurrentRoutes(identity, plannerFingerprint, command, expectedBindingId);
  const delivery = await sendDesktop(identity, {
    workspaceId: identity.id,
    bindingId: target.bindingId,
    commandId: input.commandId,
    intent: input.intent,
    userConfirmed: input.userConfirmed,
    message: input.payload,
  }, clientId, authorize);

  if (delivery.commandId !== command.commandId || delivery.bindingId !== target.bindingId ||
    delivery.threadId !== target.threadId || delivery.intent !== input.intent) {
    throw new RoutingError(
      "ROUTING_DESKTOP_RESULT_MISMATCH",
      "Desktop 返回结果与本次 Command 的 target/intent 不一致；保留 pending 并拒绝错误同步。",
    );
  }

  const updated = transitionCommandDelivery(identity, {
    commandId: input.commandId,
    deliveryStatus: delivery.deliveryStatus,
  });
  return { command: updated, delivery };
}
