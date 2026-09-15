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
  companionStatusForPrincipal,
  createPairingIntent,
  revokeCompanion,
} from "../feedback/companion.js";
import { reconcileFeedbackOutbox } from "../feedback/projector.js";

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

const securitySchemes = [{ type: "oauth2", scopes: [CODEX_FEEDBACK_SCOPE] }] as const;

const appMeta = {
  securitySchemes,
  ui: { visibility: ["app"] },
  "openai/widgetAccessible": true,
  "openai/visibility": "private",
} as const;

/**
 * Production feedback tools（E1a：无 card UI / 无 emit / 无 model_confirm）。
 * status/claim 前 reconcile，恢复 crash gap。
 */
export function registerFeedbackTools(server: McpServer, workspace: Workspace): void {
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
      _meta: appMeta,
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
      _meta: appMeta,
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
      _meta: appMeta,
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
      _meta: appMeta,
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
      description: "精确匹配 workspace/binding/epoch/principal/eventId/attemptId；claimed→observed。",
      inputSchema: {
        bindingId: z.string().uuid(),
        epoch: z.number().int().nonnegative(),
        eventId: z.string().regex(/^[a-f0-9]{32}$/),
        attemptId: z.string().uuid(),
      },
      outputSchema: { eventId: z.string(), status: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: appMeta,
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
      _meta: appMeta,
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
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: appMeta,
    },
    async (_args, extra: Extra) => {
      const denied = requireScope(extra.authInfo, CODEX_FEEDBACK_SCOPE);
      if (denied) return denied;
      try {
        const principal = principalFromExtra(extra);
        reconcileFeedbackOutbox(workspace.id);
        const intent = createPairingIntent({
          workspaceId: workspace.id,
          principal,
        });
        return ok(intent);
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
      _meta: appMeta,
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
      _meta: appMeta,
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
