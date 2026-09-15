import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { Workspace } from "../workspace/manager.js";
import {
  FEEDBACK_PROBE_SCOPE,
  FEEDBACK_PROBE_UI_URI,
  FEEDBACK_PROBE_MIME,
  isFeedbackProbeEnabled,
  claimProbeEvent,
  confirmProbeObservation,
  enableProbe,
  ProbeError,
  probeStatusSummary,
  readProbeState,
  reportProbeSend,
  resolveTrustedPrincipal,
  stopProbe,
  takeoverProbe,
  type TrustedPrincipal,
} from "../feedback/probe-store.js";
import { renderProbeHtml } from "../feedback/probe-ui.js";

/**
 * MCP Apps / ChatGPT 宿主约定：
 * - resource MIME: text/html;profile=mcp-app
 * - 版本化 resource URI：ui://c2c/feedback-probe/v1.html
 * - tool descriptor `_meta.ui.resourceUri` + 兼容别名 `openai/outputTemplate`
 * - 浏览器桥：window.openai.callTool + 标准 ui/message（postMessage JSON-RPC）
 * LIVE_HOST_CONTRACT=documented_unverified：官方合同已核对，真实宿主尚未验收。
 */
export const PROBE_LIVE_HOST_CONTRACT = "documented_unverified" as const;

const securitySchemes = [{ type: "oauth2", scopes: [FEEDBACK_PROBE_SCOPE] }] as const;

/** 内部 app 状态机工具：widget 可调用，模型不应直接触达。 */
function appWidgetMeta(extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    securitySchemes,
    ui: { visibility: ["app"] },
    "openai/widgetAccessible": true,
    "openai/visibility": "private",
    ...extra,
  };
}

/** 模型可见工具：open_card / model_confirm。
 * 旧 `openai/visibility=private` 会从模型隐藏工具；与 ui.visibility=["model"] 冲突，故显式 public。 */
function modelVisibleMeta(extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    securitySchemes,
    ui: { visibility: ["model"] },
    "openai/visibility": "public",
    ...extra,
  };
}

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
  if (error instanceof ProbeError) {
    return fail(error.code, error.message);
  }
  return fail("PROBE_INTERNAL", error instanceof Error ? error.message : String(error));
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

function principalFromExtra(extra: Extra): TrustedPrincipal {
  return resolveTrustedPrincipal(extra);
}

const principalDiagnosticsSchema = z.object({
  hasClientId: z.boolean(),
  hasConversationKey: z.boolean(),
  hasSessionId: z.boolean(),
  hostMetaKeys: z.array(z.string()),
});

const bindingSummarySchema = z.object({
  bindingId: z.string(),
  epoch: z.number(),
  status: z.string(),
  principalFingerprint: z.string(),
  widgetId: z.string(),
}).nullable();

const eventSummarySchema = z.object({
  probeId: z.string(),
  status: z.string(),
  payloadDigest: z.string(),
  epoch: z.number(),
  principalFingerprint: z.string(),
  attemptId: z.string().optional(),
  messageId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const statusOutput = {
  workspaceId: z.string(),
  enabled: z.boolean(),
  ownsBinding: z.boolean(),
  binding: bindingSummarySchema,
  events: z.array(eventSummarySchema),
  principalDiagnostics: principalDiagnosticsSchema,
  liveHostContract: z.literal("documented_unverified"),
};

export function registerFeedbackProbeTools(server: McpServer, workspace: Workspace): void {
  if (!isFeedbackProbeEnabled()) return;

  server.registerResource(
    "feedback-probe-ui",
    FEEDBACK_PROBE_UI_URI,
    {
      title: "C2C Feedback Probe",
      description: "默认关闭的 ChatGPT 反馈探针组件。自动测试事件，不是用户新授权。",
      mimeType: FEEDBACK_PROBE_MIME,
    },
    async () => ({
      contents: [{
        uri: FEEDBACK_PROBE_UI_URI,
        mimeType: FEEDBACK_PROBE_MIME,
        text: renderProbeHtml(),
      }],
    }),
  );

  /** open_card：模型可见 + securitySchemes + 版本化 UI 绑定。 */
  const openCardMeta = modelVisibleMeta({
    ui: { resourceUri: FEEDBACK_PROBE_UI_URI, visibility: ["model"] },
    "openai/outputTemplate": FEEDBACK_PROBE_UI_URI,
  });

  server.registerTool(
    "probe_open_card",
    {
      title: "Open feedback probe card",
      description:
        "打开反馈探针 UI 卡片。返回 MCP Apps resource 绑定（documented_unverified：合同已核对，真实宿主尚未验收）。",
      inputSchema: {},
      outputSchema: {
        resourceUri: z.string(),
        mimeType: z.literal(FEEDBACK_PROBE_MIME),
        liveHostContract: z.literal("documented_unverified"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: openCardMeta,
    },
    async (_args, extra) => {
      const denied = requireScope(extra.authInfo, FEEDBACK_PROBE_SCOPE);
      if (denied) return denied;
      return {
        ...ok({
          resourceUri: FEEDBACK_PROBE_UI_URI,
          mimeType: FEEDBACK_PROBE_MIME,
          liveHostContract: PROBE_LIVE_HOST_CONTRACT,
        }),
        _meta: openCardMeta,
      };
    },
  );

  server.registerTool(
    "probe_status",
    {
      title: "Probe status",
      description:
        "只读查看反馈探针绑定与事件。返回 ownsBinding 供卡片判断 enable 幂等或只能 takeover；session 只返回不可逆 fingerprint。",
      inputSchema: {},
      outputSchema: statusOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: appWidgetMeta(),
    },
    async (_args, extra: Extra) => {
      const denied = requireScope(extra.authInfo, FEEDBACK_PROBE_SCOPE);
      if (denied) return denied;
      try {
        const principal = principalFromExtra(extra);
        const state = readProbeState(workspace.id);
        return ok({
          ...probeStatusSummary(state, principal.fingerprint),
          principalDiagnostics: principal.diagnostics,
          liveHostContract: PROBE_LIVE_HOST_CONTRACT,
        });
      } catch (error) {
        return mapError(error);
      }
    },
  );

  server.registerTool(
    "probe_enable",
    {
      title: "Enable feedback probe",
      description:
        "为当前可信宿主主体启用探针。无绑定则创建；同 owner 幂等返回原绑定；异主体返回 PROBE_TAKEOVER_REQUIRED。不由模型填写 session/conversation。",
      inputSchema: {
        widgetId: z.string().min(1).max(128),
      },
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
      _meta: appWidgetMeta(),
    },
    async (args, extra: Extra) => {
      const denied = requireScope(extra.authInfo, FEEDBACK_PROBE_SCOPE);
      if (denied) return denied;
      try {
        const principal = principalFromExtra(extra);
        const state = enableProbe({
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
    "probe_takeover",
    {
      title: "Take over probe binding",
      description: "新可信主体明确接管；必须带 status 返回的 expectedEpoch。旧 epoch 不能再领取。",
      inputSchema: {
        widgetId: z.string().min(1).max(128),
        expectedEpoch: z.number().int().nonnegative(),
      },
      outputSchema: {
        bindingId: z.string(),
        epoch: z.number(),
        principalFingerprint: z.string(),
        blockedEvents: z.array(z.string()),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: appWidgetMeta(),
    },
    async (args, extra: Extra) => {
      const denied = requireScope(extra.authInfo, FEEDBACK_PROBE_SCOPE);
      if (denied) return denied;
      try {
        const principal = principalFromExtra(extra);
        const result = takeoverProbe({
          workspaceId: workspace.id,
          principal,
          widgetId: args.widgetId,
          expectedEpoch: args.expectedEpoch,
        });
        return ok({
          bindingId: result.state.binding!.bindingId,
          epoch: result.state.binding!.epoch,
          principalFingerprint: result.state.binding!.principalFingerprint,
          blockedEvents: result.blockedEvents,
        });
      } catch (error) {
        return mapError(error);
      }
    },
  );

  // probe_emit_event 不再注册：事件由本机 CLI `c2c feedback-probe emit` 产生，Chat 侧不提供 emit 入口。

  server.registerTool(
    "probe_claim_event",
    {
      title: "Claim probe event for send",
      description: "发送前持久领取；caller 必须是事件目标绑定的可信主体。返回 payloadDigest 供 follow-up 使用。",
      inputSchema: {
        probeId: z.string().min(1).max(128),
        bindingId: z.string().uuid(),
        epoch: z.number().int().nonnegative(),
      },
      outputSchema: {
        attemptId: z.string(),
        event: z.object({
          probeId: z.string(),
          payload: z.string(),
          payloadDigest: z.string(),
          epoch: z.number(),
        }),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: appWidgetMeta(),
    },
    async (args, extra: Extra) => {
      const denied = requireScope(extra.authInfo, FEEDBACK_PROBE_SCOPE);
      if (denied) return denied;
      try {
        const principal = principalFromExtra(extra);
        const claimed = claimProbeEvent({
          workspaceId: workspace.id,
          probeId: args.probeId,
          bindingId: args.bindingId,
          epoch: args.epoch,
          principal,
        });
        return ok({
          attemptId: claimed.attemptId,
          event: {
            probeId: claimed.event.probeId,
            payload: claimed.event.payload,
            payloadDigest: claimed.event.payloadDigest,
            epoch: claimed.event.epoch,
          },
        });
      } catch (error) {
        return mapError(error);
      }
    },
  );

  server.registerTool(
    "probe_report_send",
    {
      title: "Report probe send outcome",
      description: "报告发送结果。无真实 messageId 不得标 sent；未知结果 outcome_unknown 且禁止换接口重发。",
      inputSchema: {
        probeId: z.string().min(1).max(128),
        attemptId: z.string().uuid(),
        outcome: z.enum(["sent", "outcome_unknown"]),
        messageId: z.string().min(1).max(256).optional(),
      },
      outputSchema: {
        probeId: z.string(),
        status: z.string(),
        messageId: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: appWidgetMeta(),
    },
    async (args, extra: Extra) => {
      const denied = requireScope(extra.authInfo, FEEDBACK_PROBE_SCOPE);
      if (denied) return denied;
      try {
        const principal = principalFromExtra(extra);
        const event = reportProbeSend({
          workspaceId: workspace.id,
          probeId: args.probeId,
          attemptId: args.attemptId,
          outcome: args.outcome,
          principal,
          ...(args.messageId ? { messageId: args.messageId } : {}),
        });
        return ok({
          probeId: event.probeId,
          status: event.status,
          ...(event.messageId ? { messageId: event.messageId } : {}),
        });
      } catch (error) {
        return mapError(error);
      }
    },
  );

  server.registerTool(
    "probe_model_confirm",
    {
      title: "Confirm probe observation",
      description:
        "模型在当前 Chat 观察到探针后核验。必须精确提供 probeId + payloadDigest + attemptId；caller 必须是事件目标绑定主体。只证明观察层，不伪造 sent。",
      inputSchema: {
        probeId: z.string().min(1).max(128),
        payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
        attemptId: z.string().uuid(),
      },
      outputSchema: { probeId: z.string(), status: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: modelVisibleMeta(),
    },
    async (args, extra: Extra) => {
      const denied = requireScope(extra.authInfo, FEEDBACK_PROBE_SCOPE);
      if (denied) return denied;
      try {
        const principal = principalFromExtra(extra);
        const event = confirmProbeObservation({
          workspaceId: workspace.id,
          probeId: args.probeId,
          payloadDigest: args.payloadDigest,
          attemptId: args.attemptId,
          principal,
        });
        return ok({ probeId: event.probeId, status: event.status });
      } catch (error) {
        return mapError(error);
      }
    },
  );

  server.registerTool(
    "probe_stop",
    {
      title: "Stop feedback probe",
      description: "停止当前绑定。caller 必须匹配绑定主体；遗留 sending 收敛为 outcome_unknown。",
      inputSchema: {},
      outputSchema: { stopped: z.boolean(), workspaceId: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: appWidgetMeta(),
    },
    async (_args, extra: Extra) => {
      const denied = requireScope(extra.authInfo, FEEDBACK_PROBE_SCOPE);
      if (denied) return denied;
      try {
        const principal = principalFromExtra(extra);
        stopProbe({ workspaceId: workspace.id, principal });
        return ok({ stopped: true, workspaceId: workspace.id });
      } catch (error) {
        return mapError(error);
      }
    },
  );
}

export { FEEDBACK_PROBE_SCOPE, FEEDBACK_PROBE_UI_URI, isFeedbackProbeEnabled };
