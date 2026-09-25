import { RoutingError, type RoutingRoute } from "./schema.js";
import { listRoutes, registerRoute, type RoutingWorkspaceIdentity } from "./store.js";

const PLANNER_FINGERPRINT = /^[0-9a-f]{32}$/;

function currentPlannerRegistration(fingerprint: string) {
  if (!PLANNER_FINGERPRINT.test(fingerprint)) {
    throw new RoutingError("ROUTING_PLANNER_IDENTITY_INVALID", "MCP planner fingerprint 格式无效；拒绝创建 route。");
  }
  return {
    role: "planner" as const,
    platform: "chatgpt_web" as const,
    conversationId: fingerprint,
    locator: {},
  };
}

/** Planner identity is scoped to this MCP request, not Browser Companion feedback state. */
export function resolveCurrentPlannerRoute(
  identity: RoutingWorkspaceIdentity,
  fingerprint: string,
): RoutingRoute | null {
  const candidate = currentPlannerRegistration(fingerprint);
  const routes = listRoutes(identity);

  const route = routes.find(
    (item) => item.platform === candidate.platform && item.conversationId === candidate.conversationId,
  );
  if (!route) return null;
  if (route.role !== "planner") {
    throw new RoutingError(
      "ROUTE_ROLE_CONFLICT",
      "当前 MCP planner identity 已注册为不同 role；拒绝将历史 route 视为当前。",
    );
  }
  if (JSON.stringify(route.locator) !== JSON.stringify(candidate.locator)) {
    throw new RoutingError(
      "ROUTE_LOCATOR_CONFLICT",
      "当前 MCP planner identity 的 locator 与已注册 route 不一致。",
    );
  }
  return route;
}

/** 显式注册 request-scoped planner; exact replay 复用 registerRoute 的无写入语义。 */
export function ensureCurrentPlannerRoute(
  identity: RoutingWorkspaceIdentity,
  fingerprint: string,
): RoutingRoute | null {
  const candidate = currentPlannerRegistration(fingerprint);
  // Check even without a candidate so corrupt routing history never gets silently bypassed.
  listRoutes(identity);
  const registered = registerRoute(identity, {
    role: "planner",
    platform: candidate.platform,
    conversationId: candidate.conversationId,
    locator: candidate.locator,
  });

  const current = resolveCurrentPlannerRoute(identity, fingerprint);
  if (!current || current.routeId !== registered.routeId) {
    throw new RoutingError(
      "ROUTE_AUTHORITY_CHANGED",
      "MCP planner route 在 ensure 期间已变化；route 可能保留为历史记录，请重新解析后重试。",
    );
  }
  return current;
}
