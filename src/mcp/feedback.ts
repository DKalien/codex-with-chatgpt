import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { Workspace } from "../workspace/manager.js";
import {
  resolveConversationPrincipal,
  requireConversationPrincipal,
  type ConversationPrincipal,
} from "./conversation-principal.js";
import {
  ackObserved,
  claimNext,
  CODEX_FEEDBACK_SCOPE,
  enableReceiver,
  FeedbackError,
  feedbackStatusSummary,
  readFeedbackState,
  stopReceiver,
  takeoverReceiver,
} from "../feedback/store.js";
import {
  companionBootstrapReadiness,
  companionStatusForPrincipal,
  confirmRouteAttestation,
  createPairingIntent,
  revokeCompanion,
} from "../feedback/companion.js";
import { reconcileFeedbackOutbox } from "../feedback/projector.js";
import { findLiveBridge } from "../bridge/runtime.js";

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

function ok(data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function fail(code: string, message: string, scope?: string): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: code, message }) }],
    ...(scope ? {
      _meta: {
        "mcp/www_authenticate": [
          `Bearer error="insufficient_scope", error_description="Reauthorize this connector with ${scope}", scope="${scope}"`,
        ],
      },
    } : {}),
  };
}

function mapError(error: unknown): ToolResult {
  if (error instanceof FeedbackError) {
    return fail(error.code, error.message);
  }
  const code = (error as { code?: string }).code;
  if (typeof code === "string" && (code === "PROBE_PRINCIPAL_MISSING" || code === "PROBE_CHAT_IDENTITY_UNAVAILABLE")) {
    return fail(code, (error as Error).message);
  }
  return fail("FEEDBACK_INTERNAL", error instanceof Error ? error.message : String(error));
}

function requireScope(authInfo: AuthInfo | undefined, scope: string): ToolResult | null {
  if (!authInfo) return null;
  if (!authInfo.scopes.includes(scope)) {
    return fail("INSUFFICIENT_SCOPE", `This operation requires the '${scope}' scope.`, scope);
  }
  return null;
}

type Extra = {
  authInfo?: AuthInfo | undefined;
  sessionId?: string;
  _meta?: unknown;
};

function principalFromExtra(extra: Extra): ConversationPrincipal {
  // conversation identity 必须先于任何 reconcile / state mutation。
  const principal = resolveConversationPrincipal(extra);
  requireConversationPrincipal(principal);
  return principal;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

async function companionBridgeOrigin(workspaceId: string): Promise<string> {
  const runtime = await findLiveBridge(workspaceId);
  if (!runtime) {
    throw new FeedbackError("FEEDBACK_BRIDGE_ORIGIN_UNAVAILABLE", "当前连接服务未处于健康状态");
  }
  const raw = runtime.publicUrl === null
    ? `http://127.0.0.1:${runtime.port}`
    : runtime.publicUrl;
  try {
    const url = new URL(raw);
    const loopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
    const validProtocol = url.protocol === "https:" || (url.protocol === "http:" && loopback);
    const validPort = runtime.publicUrl !== null || (Number.isInteger(runtime.port) && runtime.port > 0 && runtime.port <= 65535);
    if (!validProtocol || !validPort || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error("unsafe bridge origin");
    }
    return url.origin;
  } catch {
    throw new FeedbackError("FEEDBACK_BRIDGE_ORIGIN_UNAVAILABLE", "当前连接服务地址无效或不安全");
  }
}

const securitySchemes = [{ type: "oauth2", scopes: [CODEX_FEEDBACK_SCOPE] }] as const;

/** 仅 widget/app 内部状态机（production feedback 当前无 card UI；保留便于回归区分）。 */
function appWidgetMeta(extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    securitySchemes,
    ui: { visibility: ["app"] },
    "openai/widgetAccessible": true,
    "openai/visibility": "private",
    ...extra,
  };
}

// 回归锚点：app-only/private 形状不得被误用到 production model 工具。
export const FEEDBACK_APP_ONLY_META_SHAPE = {
  ui: { visibility: ["app"] },
  "openai/visibility": "private",
} as const;

/** 供测试断言 appWidgetMeta 存在且与 model 路径分离。 */
export function feedbackAppWidgetMeta(extra?: Record<string, unknown>): Record<string, unknown> {
  return appWidgetMeta(extra);
}

/**
 * 模型可见：production feedback / companion 由 ChatGPT conversation 模型直接调用。
 * private 会从模型隐藏工具；与 ui.visibility=["model"] 冲突，故显式 public。
 * OAuth 仍要求 codex.feedback。
 */
function modelVisibleMeta(extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    securitySchemes,
    ui: { visibility: ["model"] },
    "openai/visibility": "public",
    ...extra,
  };
}

/**
 * Production feedback tools（E1a：无 card UI / 无 emit / 无 model_confirm）。
 * status/claim 前 reconcile，恢复 crash gap。
 */
export function registerFeedbackTools(server: McpServer, workspace: Workspace): void {
  server.registerTool(
    "feedback_bootstrap_status",
    {
      title: "Feedback bootstrap readiness",
      description: "一次读取当前 Chat 的 bounded feedback bootstrap 状态；不返回 principal、credential、secret 或 hash。",
      inputSchema: {},
      outputSchema: {
        workspaceId: z.string(),
        state: z.enum([
          "DISABLED",
          "OWNED_VERIFIED",
          "OWNED_NEEDS_BROWSER_REBIND",
          "FOREIGN_SAFE_TO_TAKEOVER",
          "BLOCKED_INFLIGHT",
        ]),
        ownsBinding: z.boolean(),
        inFlightStatus: z.enum(["reserved", "claimed", "outcome_unknown"]).nullable(),
        expectedEpoch: z.number().optional(),
        widgetId: z.string().optional(),
        companionPresent: z.boolean().optional(),
        routeVerification: z.enum(["NONE", "PENDING", "VERIFIED"]).optional(),
        rebindAvailable: z.boolean().optional(),
        rebindState: z.enum(["NONE", "PENDING", "CONFIRMED"]).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: modelVisibleMeta(),
    },
    async (_args, extra: Extra) => {
      const denied = requireScope(extra.authInfo, CODEX_FEEDBACK_SCOPE);
      if (denied) return denied;
      try {
        const principal = principalFromExtra(extra);
        return ok(companionBootstrapReadiness({ workspaceId: workspace.id, principal }));
      } catch (error) {
        return mapError(error);
      }
    },
  );

  server.registerTool(
    "feedback_status",
    {
      title: "Production feedback status",
      description:
        "读取 production feedback receiver/outbox，并在本地执行 reconcile（含 stale claimed 收敛）。只维护本机 outbox，不执行 Codex/task、不外部发送。",
      inputSchema: {},
      outputSchema: {
        workspaceId: z.string(),
        enabled: z.boolean(),
        ownsBinding: z.boolean(),
        projectionCursor: z.number(),
        binding: z.unknown(),
        companion: z.unknown(),
        events: z.array(z.unknown()),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: modelVisibleMeta(),
    },
    async (_args, extra: Extra) => {
      const denied = requireScope(extra.authInfo, CODEX_FEEDBACK_SCOPE);
      if (denied) return denied;
      try {
        const principal = principalFromExtra(extra);
        const reconciled = reconcileFeedbackOutbox(workspace.id);
        return ok({
          ...feedbackStatusSummary(reconciled.state, principal.fingerprint),
          projected: reconciled.projected,
        });
      } catch (error) {
        return mapError(error);
      }
    },
  );

  server.registerTool(
    "feedback_enable",
    {
      title: "Enable production feedback receiver",
      description: "为当前对话主体启用 production receiver。无绑定创建；同主体幂等；异主体需 takeover。",
      inputSchema: { widgetId: z.string().min(1).max(128) },
      outputSchema: {
        workspaceId: z.string(),
        binding: z.object({
          bindingId: z.string(),
          epoch: z.number(),
          status: z.string(),
          principalFingerprint: z.string(),
        }),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: modelVisibleMeta(),
    },
    async (args, extra: Extra) => {
      const denied = requireScope(extra.authInfo, CODEX_FEEDBACK_SCOPE);
      if (denied) return denied;
      try {
        const principal = principalFromExtra(extra);
        reconcileFeedbackOutbox(workspace.id);
        const state = enableReceiver({
          workspaceId: workspace.id,
          principal,
          widgetId: args.widgetId,
        });
        return ok({
          workspaceId: state.workspaceId,
          binding: {
            bindingId: state.binding!.bindingId,
            epoch: state.binding!.epoch,
            status: state.binding!.status,
            principalFingerprint: state.binding!.principalFingerprint,
          },
        });
      } catch (error) {
        return mapError(error);
      }
    },
  );

  server.registerTool(
    "feedback_takeover",
    {
      title: "Take over production feedback receiver",
      description: "明确接管；必须带 status 的 expectedEpoch。存在 claimed/outcome_unknown 时拒绝。",
      inputSchema: {
        widgetId: z.string().min(1).max(128),
        expectedEpoch: z.number().int().nonnegative(),
      },
      outputSchema: {
        bindingId: z.string(),
        epoch: z.number(),
        principalFingerprint: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: modelVisibleMeta(),
    },
    async (args, extra: Extra) => {
      const denied = requireScope(extra.authInfo, CODEX_FEEDBACK_SCOPE);
      if (denied) return denied;
      try {
        const principal = principalFromExtra(extra);
        reconcileFeedbackOutbox(workspace.id);
        const result = takeoverReceiver({
          workspaceId: workspace.id,
          principal,
          widgetId: args.widgetId,
          expectedEpoch: args.expectedEpoch,
        });
        return ok({
          bindingId: result.state.binding!.bindingId,
          epoch: result.state.binding!.epoch,
          principalFingerprint: result.state.binding!.principalFingerprint,
        });
      } catch (error) {
        return mapError(error);
      }
    },
  );

  server.registerTool(
    "feedback_claim_next",
    {
      title: "Claim next ready feedback event",
      description: "先 reconcile 再领取最早 ready 事件；持久化 attempt 后返回。",
      inputSchema: {
        bindingId: z.string().uuid(),
        epoch: z.number().int().nonnegative(),
      },
      outputSchema: {
        attemptId: z.string(),
        event: z.unknown(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: modelVisibleMeta(),
    },
    async (args, extra: Extra) => {
      const denied = requireScope(extra.authInfo, CODEX_FEEDBACK_SCOPE);
      if (denied) return denied;
      try {
        const principal = principalFromExtra(extra);
        reconcileFeedbackOutbox(workspace.id);
        const claimed = claimNext({
          workspaceId: workspace.id,
          principal,
          bindingId: args.bindingId,
          epoch: args.epoch,
        });
        return ok({ attemptId: claimed.attemptId, event: claimed.event });
      } catch (error) {
        return mapError(error);
      }
    },
  );

  server.registerTool(
    "feedback_ack_observed",
    {
      title: "Ack feedback event observed",
      description: "精确匹配 workspace/binding/epoch/principal/eventId/attemptId；exact claimed/outcome_unknown → observed；observed same-attempt idempotent。调用者必须已拥有正观察证据，工具不判断 UI 是否显示消息。",
      inputSchema: {
        bindingId: z.string().uuid(),
        epoch: z.number().int().nonnegative(),
        eventId: z.string().regex(/^[a-f0-9]{32}$/),
        attemptId: z.string().uuid(),
      },
      outputSchema: { eventId: z.string(), status: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: modelVisibleMeta(),
    },
    async (args, extra: Extra) => {
      const denied = requireScope(extra.authInfo, CODEX_FEEDBACK_SCOPE);
      if (denied) return denied;
      try {
        const principal = principalFromExtra(extra);
        const event = ackObserved({
          workspaceId: workspace.id,
          principal,
          bindingId: args.bindingId,
          epoch: args.epoch,
          eventId: args.eventId,
          attemptId: args.attemptId,
        });
        return ok({ eventId: event.eventId, status: event.status });
      } catch (error) {
        return mapError(error);
      }
    },
  );

  server.registerTool(
    "feedback_stop",
    {
      title: "Stop production feedback receiver",
      description: "supersede 当前绑定；不删除 queued/history；不自动 unmount。",
      inputSchema: {},
      outputSchema: { stopped: z.boolean(), workspaceId: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: modelVisibleMeta(),
    },
    async (_args, extra: Extra) => {
      const denied = requireScope(extra.authInfo, CODEX_FEEDBACK_SCOPE);
      if (denied) return denied;
      try {
        const principal = principalFromExtra(extra);
        stopReceiver({ workspaceId: workspace.id, principal });
        return ok({ stopped: true, workspaceId: workspace.id });
      } catch (error) {
        return mapError(error);
      }
    },
  );

  server.registerTool(
    "feedback_companion_pair",
    {
      title: "Create one-time companion pairing intent",
      description:
        "为当前 active binding 创建短时 one-time pairing intent。返回的 secret 只出现一次，需安全转交 browser companion；浏览器不得使用 MCP principal/admin token。",
      inputSchema: {},
      outputSchema: {
        intentId: z.string(),
        secret: z.string(),
        expiresAt: z.string(),
        bindingId: z.string(),
        epoch: z.number(),
        bridgeOrigin: z.string().url(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: modelVisibleMeta(),
    },
    async (_args, extra: Extra) => {
      const denied = requireScope(extra.authInfo, CODEX_FEEDBACK_SCOPE);
      if (denied) return denied;
      try {
        const principal = principalFromExtra(extra);
        const bridgeOrigin = await companionBridgeOrigin(workspace.id);
        reconcileFeedbackOutbox(workspace.id);
        const intent = createPairingIntent({
          workspaceId: workspace.id,
          principal,
        });
        return ok({ ...intent, bridgeOrigin });
      } catch (error) {
        return mapError(error);
      }
    },
  );

  server.registerTool(
    "feedback_companion_route_confirm",
    {
      title: "Confirm companion delivery-route attestation",
      description:
        "确认 Browser Companion delivery route 属于当前 MCP request 的 openai/session principal。" +
        "不接受 principal 参数；错误 principal 拒绝且不消费 challenge。" +
        "这是 C2C delivery-route verification，不是新开发任务。",
      inputSchema: {
        challengeId: z.string().uuid(),
        challengeDigest: z.string().regex(/^[a-f0-9]{64}$/),
      },
      outputSchema: {
        verified: z.literal(true),
        companionId: z.string(),
        routeCanonical: z.string(),
        routeVerifiedAt: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: modelVisibleMeta(),
    },
    async (args, extra: Extra) => {
      const denied = requireScope(extra.authInfo, CODEX_FEEDBACK_SCOPE);
      if (denied) return denied;
      try {
        // Principal must come from official openai/session only — never a tool arg.
        const principal = principalFromExtra(extra);
        const result = confirmRouteAttestation({
          workspaceId: workspace.id,
          principal,
          challengeId: args.challengeId,
          challengeDigest: args.challengeDigest,
        });
        return ok({
          verified: true,
          companionId: result.companionId,
          routeCanonical: result.routeCanonical,
          routeVerifiedAt: result.routeVerifiedAt,
        });
      } catch (error) {
        return mapError(error);
      }
    },
  );

  server.registerTool(
    "feedback_companion_status",
    {
      title: "Companion pairing status",
      description: "读取当前 binding 的 companion 元数据；不返回 secret 或 credential hash。",
      inputSchema: {},
      outputSchema: {
        workspaceId: z.string(),
        ownsBinding: z.boolean(),
        companion: z.unknown(),
        pairingIntentActive: z.boolean(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: modelVisibleMeta(),
    },
    async (_args, extra: Extra) => {
      const denied = requireScope(extra.authInfo, CODEX_FEEDBACK_SCOPE);
      if (denied) return denied;
      try {
        const principal = principalFromExtra(extra);
        reconcileFeedbackOutbox(workspace.id);
        return ok(companionStatusForPrincipal({
          workspaceId: workspace.id,
          principal,
        }));
      } catch (error) {
        return mapError(error);
      }
    },
  );

  server.registerTool(
    "feedback_companion_revoke",
    {
      title: "Revoke companion pairing",
      description: "撤销当前 companion 与未消费 pairing intent；不自动 stop receiver binding。",
      inputSchema: {},
      outputSchema: { revoked: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      _meta: modelVisibleMeta(),
    },
    async (_args, extra: Extra) => {
      const denied = requireScope(extra.authInfo, CODEX_FEEDBACK_SCOPE);
      if (denied) return denied;
      try {
        const principal = principalFromExtra(extra);
        return ok(revokeCompanion({ workspaceId: workspace.id, principal }));
      } catch (error) {
        return mapError(error);
      }
    },
  );
}

export { CODEX_FEEDBACK_SCOPE };
export type { ConversationPrincipal };
