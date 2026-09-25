import { parseChatgptConversationRoute } from "../chatgpt/route.js";
import { isRouteAttestationVerified, readFeedbackState } from "../feedback/store.js";
import { projectDesktopExecutorCandidate, type DesktopExecutorCandidate } from "./desktop-adapter.js";
import { resolveWorkspaceIdentity, type RoutingWorkspaceIdentity } from "./store.js";

/**
 * Routing R1 legacy projection（不是 migration）。
 *
 * 只读读取现有 desktop-control / feedback state，投影为 LegacyRouteCandidate：
 * - 不生成 routeId、不写 routing store、不写任何旧 state；
 * - 注册成 Route 是以后显式 migration/rebind 的事；
 * - 多次调用结果确定（无随机 identity）；
 * - 读取失败或结构不符时对应 candidate 产出为 none（fail closed），不猜测。
 *
 * 状态目录沿用 getStateDir()（测试经 C2C_STATE_DIR 隔离）。
 */

export type LegacyExecutorCandidate = DesktopExecutorCandidate;

export interface LegacyPlannerCandidate {
  kind: "planner";
  platform: "chatgpt_web";
  conversationId: string;
  locator: { gptId?: string };
  /** 仅为引用 ID（companion bindingId），不承担真实身份。 */
  legacyReferenceId: string;
  routeCanonical: string;
}

export type LegacyRouteCandidate = LegacyExecutorCandidate | LegacyPlannerCandidate;

export interface LegacyProjection {
  executorCandidate: LegacyExecutorCandidate | null;
  plannerCandidate: LegacyPlannerCandidate | null;
}

/**
 * 旧 feedback → planner candidate。
 * 只有现有 Companion route attestation 已 VERIFIED 时，才从 routeCanonical
 * 提取 chatgpt_web planner candidate；无 verified route → none。
 * 绝不因文件里有个 URL 就把它升级成可信 planner route。
 */
function projectPlannerCandidate(
  identity: RoutingWorkspaceIdentity,
): LegacyPlannerCandidate | null {
  try {
    const state = readFeedbackState(identity.id);
    const companion = state.companion;
    if (!isRouteAttestationVerified(companion)) return null;
    if (!companion) return null;
    const parsed = parseChatgptConversationRoute(companion.routeCanonical, {
      allowQueryOrHash: false,
      conversationIdPolicy: "uuid",
    });
    return {
      kind: "planner",
      platform: "chatgpt_web",
      conversationId: parsed.conversationId,
      locator: parsed.gptId ? { gptId: parsed.gptId } : {},
      legacyReferenceId: companion.bindingId,
      routeCanonical: companion.routeCanonical,
    };
  } catch {
    // feedback state 未初始化或损坏：fail closed，不产出候选。
    return null;
  }
}

/**
 * 只读投影；不产生任何写入。
 * 公共入口先做 workspace identity 派生校验（与 store 同一层），
 * 伪造 id/root 组合直接 fail closed，不读任何旧 state。
 */
export function projectLegacyRoutes(identity: RoutingWorkspaceIdentity): LegacyProjection {
  const resolved = resolveWorkspaceIdentity(identity);
  return {
    executorCandidate: projectDesktopExecutorCandidate(resolved),
    plannerCandidate: projectPlannerCandidate(resolved),
  };
}
