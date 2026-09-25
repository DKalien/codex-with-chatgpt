import { createHash } from "node:crypto";
import { ensureCurrentExecutorRoute, resolveCurrentExecutorRoute } from "./current-executor-route.js";
import { ensureCurrentPlannerRoute, resolveCurrentPlannerRoute } from "./current-planner-route.js";
import { RoutingError, type CommandInput, type RoutingCommand } from "./schema.js";
import { createCommand, type RoutingWorkspaceIdentity } from "./store.js";

/** 创建当前 planner/executor route 对应的 pending Command；不投递、不授权发送。 */
export function createCurrentCommand(
  identity: RoutingWorkspaceIdentity,
  plannerFingerprint: string,
  input: Pick<CommandInput, "commandId" | "intent"> & { payload: string },
): RoutingCommand {
  const planner = ensureCurrentPlannerRoute(identity, plannerFingerprint);
  if (!planner) {
    throw new RoutingError(
      "ROUTING_ROUTE_NOT_FOUND",
      "当前 MCP request planner route 不存在；拒绝从历史 route 推断。",
    );
  }
  const executor = ensureCurrentExecutorRoute(identity);
  if (!executor) {
    throw new RoutingError(
      "ROUTING_ROUTE_NOT_FOUND",
      "当前 Desktop binding route 不存在；拒绝从历史 route 推断。",
    );
  }

  const payloadBytes = Buffer.byteLength(input.payload, "utf8");
  const payloadSha256 = createHash("sha256").update(input.payload, "utf8").digest("hex");

  // Recheck immediately before the local pending write; this snapshot is not a transport lease.
  const currentPlanner = resolveCurrentPlannerRoute(identity, plannerFingerprint);
  const currentExecutor = resolveCurrentExecutorRoute(identity);
  if (currentPlanner?.routeId !== planner.routeId || currentExecutor?.routeId !== executor.routeId) {
    throw new RoutingError(
      "ROUTE_AUTHORITY_CHANGED",
      "当前 planner/executor route 在 Command 创建前已变化；请重新解析后重试。",
    );
  }

  return createCommand(identity, {
    commandId: input.commandId,
    plannerRouteId: planner.routeId,
    executorRouteId: executor.routeId,
    intent: input.intent,
    payloadBytes,
    payloadSha256,
  });
}
