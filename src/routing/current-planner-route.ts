import { projectLegacyRoutes } from "./legacy-adapter.js";
import { RoutingError, type RoutingRoute } from "./schema.js";
import { listRoutes, registerRoute, type RoutingWorkspaceIdentity } from "./store.js";

/** 当前 planner authority 从 VERIFIED Companion state 派生，不另存 route pointer。 */
export function resolveCurrentPlannerRoute(
  identity: RoutingWorkspaceIdentity,
): RoutingRoute | null {
  const candidate = projectLegacyRoutes(identity).plannerCandidate;
  const routes = listRoutes(identity);
  if (!candidate) return null;

  const route = routes.find(
    (item) => item.platform === candidate.platform && item.conversationId === candidate.conversationId,
  );
  if (!route) return null;
  if (route.role !== "planner") {
    throw new RoutingError(
      "ROUTE_ROLE_CONFLICT",
      "当前已验证 planner identity 已注册为不同 role；拒绝将历史 route 视为当前。",
    );
  }
  if (JSON.stringify(route.locator) !== JSON.stringify(candidate.locator)) {
    throw new RoutingError(
      "ROUTE_LOCATOR_CONFLICT",
      "当前已验证 planner identity 的 locator 与已注册 route 不一致。",
    );
  }
  return route;
}

/** 显式注册 VERIFIED candidate；exact replay 复用 registerRoute 的无写入语义。 */
export function ensureCurrentPlannerRoute(
  identity: RoutingWorkspaceIdentity,
): RoutingRoute | null {
  const candidate = projectLegacyRoutes(identity).plannerCandidate;
  // Check even without a candidate so corrupt routing history never gets silently bypassed.
  listRoutes(identity);
  if (!candidate) return null;
  const registered = registerRoute(identity, {
    role: "planner",
    platform: candidate.platform,
    conversationId: candidate.conversationId,
    locator: candidate.locator,
  });

  // Feedback and routing have separate locks; another process may replace the
  // verified Companion route after projection but before registration.
  const current = resolveCurrentPlannerRoute(identity);
  if (!current || current.routeId !== registered.routeId) {
    throw new RoutingError(
      "ROUTE_AUTHORITY_CHANGED",
      "VERIFIED Companion 路由在 ensure 期间已变化；route 可能保留为历史记录，请重新解析后重试。",
    );
  }
  return current;
}
