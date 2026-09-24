import { projectLegacyRoutes } from "./legacy-adapter.js";
import { RoutingError, type RoutingRoute } from "./schema.js";
import { listRoutes, registerRoute, type RoutingWorkspaceIdentity } from "./store.js";

/** 当前 executor route 只从现有 Desktop binding target 派生，不代表发送可用性。 */
export function resolveCurrentExecutorRoute(
  identity: RoutingWorkspaceIdentity,
): RoutingRoute | null {
  const candidate = projectLegacyRoutes(identity).executorCandidate;
  const routes = listRoutes(identity);
  if (!candidate) return null;

  const route = routes.find(
    (item) => item.platform === candidate.platform && item.conversationId === candidate.conversationId,
  );
  if (!route) return null;
  if (route.role !== "executor") {
    throw new RoutingError(
      "ROUTE_ROLE_CONFLICT",
      "当前 Desktop binding identity 已注册为不同 role；拒绝将历史 route 视为 current。",
    );
  }
  if (JSON.stringify(route.locator) !== JSON.stringify(candidate.locator)) {
    throw new RoutingError(
      "ROUTE_LOCATOR_CONFLICT",
      "当前 Desktop binding locator 与已注册 route 不一致。",
    );
  }
  return route;
}

/** 显式注册当前 Desktop binding target；exact replay 不改 revision 或文件。 */
export function ensureCurrentExecutorRoute(
  identity: RoutingWorkspaceIdentity,
): RoutingRoute | null {
  const candidate = projectLegacyRoutes(identity).executorCandidate;
  // 即使当前没有 binding，也读取 store，避免绕过损坏的 route history。
  listRoutes(identity);
  if (!candidate) return null;
  const registered = registerRoute(identity, {
    role: "executor",
    platform: candidate.platform,
    conversationId: candidate.conversationId,
    locator: candidate.locator,
  });

  // Desktop 与 routing 使用不同 state/lock；注册后重读 binding，拒绝返回 stale current。
  const current = resolveCurrentExecutorRoute(identity);
  if (!current || current.routeId !== registered.routeId) {
    throw new RoutingError(
      "ROUTE_AUTHORITY_CHANGED",
      "Desktop binding 在 ensure 期间已变化；route 可能保留为历史记录，请重新解析后重试。",
    );
  }
  return current;
}
