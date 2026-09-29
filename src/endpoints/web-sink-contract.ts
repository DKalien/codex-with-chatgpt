import {
  webSinkSendIdentityEquals,
  type WebSinkBinding,
  type WebSinkBindingCandidate,
  type WebSinkSendTargetSnapshot,
} from "./schema.js";

/**
 * Generic Web Sink Plugin contract。
 *
 * 约束：
 * - 不出现具体站点、planner route、conversation principal、feedback credential。
 * - plugin 只发现 surface candidate；Bridge 拥有 bindingId/epoch/boundAt。
 * - Bridge/core 只理解 descriptor + binding/send snapshot。
 * - DOM 差异属于未来 surface plugin 实现层，不进入本合同。
 */

export interface WebSinkPluginCapabilities {
  readonly urlBinding: boolean;
  readonly bindingEpoch: boolean;
  readonly durableJournal: boolean;
  readonly reserve: boolean;
  readonly beginSend: boolean;
  readonly observation: boolean;
  readonly ack: boolean;
  readonly singleFlight: boolean;
}

export interface WebSinkPluginDescriptor {
  readonly pluginId: string;
  readonly surfaceId: string;
  readonly name: string;
  readonly capabilities: WebSinkPluginCapabilities;
}

/**
 * Web Sink send attempt。
 * begin-send 之后 target URL/epoch/workspace 固定；outcome_unknown 不得自动改发新 URL。
 */
export interface WebSinkSendAttempt {
  readonly attemptId: string;
  readonly target: WebSinkSendTargetSnapshot;
  readonly reservedAt: string;
  readonly begunAt: string;
}

export type WebSinkSendOutcome =
  | { readonly status: "acked"; readonly ackedAt: string }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "outcome_unknown"; readonly reason: string };

export interface WebSinkPlugin {
  readonly descriptor: WebSinkPluginDescriptor;
  /**
   * 发现当前 Web Sink surface candidate。
   * 不得铸造 Bridge binding 元数据（bindingId/epoch/boundAt）。
   */
  discoverCurrent(context: {
    readonly workspaceRoot: string;
    readonly workspaceId: string;
  }): Promise<WebSinkBindingCandidate>;
  reserve(binding: WebSinkBinding): Promise<{ reserved: boolean; attemptId?: string; reason?: string }>;
  beginSend(attemptId: string): Promise<WebSinkSendAttempt>;
  observe(attemptId: string): Promise<WebSinkSendOutcome>;
  ack(attemptId: string): Promise<{ acked: boolean; reason?: string }>;
}

/**
 * begin-send 后禁止把 outcome_unknown 重绑到新 URL/epoch/workspace identity。
 * 比较 bindingId/pluginId/surfaceId/workspaceId/canonicalUrl/epoch。
 */
export function assertSendTargetImmutable(
  attempt: WebSinkSendAttempt,
  expected: Pick<
    WebSinkSendTargetSnapshot,
    "bindingId" | "pluginId" | "surfaceId" | "workspaceId" | "canonicalUrl" | "epoch"
  >,
): void {
  if (!webSinkSendIdentityEquals(attempt.target, expected)) {
    throw new Error("web sink send target 在 begin-send 后被改变");
  }
}
