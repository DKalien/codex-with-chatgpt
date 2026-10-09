import { dispatchExecutorCommand } from "../executor-control/send.js";
import type { CommandMailboxSubmit } from "../routing/mailbox.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Workspace } from "../workspace/manager.js";
import {
  EXECUTOR_CONTROL_SCOPE,
  EXECUTOR_READ_SCOPE,
} from "../auth/store.js";
import {
  endpointBindingIdSchema,
  endpointWorkspaceIdSchema,
} from "../endpoints/schema.js";
import { routingCommandIdSchema, routingIntentSchema } from "../routing/schema.js";
import { executorMessageSchema } from "../executor-control/schema.js";
import { ExecutorControlError } from "../executor-control/schema.js";
import { ExecutorDispatchError } from "../executor-control/dispatch-schema.js";
import { EndpointSwitchLockError } from "../endpoint-switch/lock.js";
import {
  executorStatus,
  listExecutorPlugins,
} from "../executor-control/service.js";
import {
  ConversationPrincipalError,
  requireConversationPrincipal,
  resolveConversationPrincipal,
} from "./conversation-principal.js";
import { RoutingError } from "../routing/schema.js";
import { DesktopError } from "../desktop/store.js";

export { EXECUTOR_CONTROL_SCOPE, EXECUTOR_READ_SCOPE };

const pluginSummarySchema = z.object({
  pluginId: z.string(),
  kind: z.string(),
  name: z.string(),
  capabilities: z.record(z.boolean()),
}).strict();

const bindingSchema = z.object({
  bindingId: z.string(),
  pluginId: z.string(),
  workspaceId: z.string(),
  workspaceRoot: z.string(),
  instanceId: z.string(),
  sessionId: z.string(),
  locator: z.record(z.string()),
  epoch: z.number().int(),
  boundAt: z.string(),
}).strict();

const availabilitySchema = z.object({
  available: z.boolean(),
  reasonCode: z.string().optional(),
  message: z.string().optional(),
}).strict();

const listOutputSchema = {
  plugins: z.array(pluginSummarySchema),
};

const statusOutputSchema = {
  workspaceId: z.string(),
  activeBinding: bindingSchema.nullable(),
  plugins: z.array(pluginSummarySchema),
  availability: availabilitySchema,
};

const sendOutputSchema = {
  commandId: z.string(),
  pluginId: z.string(),
  bindingId: z.string(),
  sessionId: z.string(),
  deliveryStatus: z.enum(["queued", "accepted", "rejected", "outcome_unknown"]),
  queueStatus: z.enum(["queued", "dispatching", "blocked"]).optional(),
  deliveryId: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  message: z.string(),
};

const listInputSchema = z.object({}).strict();
const statusInputSchema = z.object({
  workspaceId: endpointWorkspaceIdSchema,
}).strict();
const sendInputSchema = z.object({
  workspaceId: endpointWorkspaceIdSchema,
  bindingId: endpointBindingIdSchema,
  commandId: routingCommandIdSchema,
  intent: routingIntentSchema,
  userConfirmed: z.literal(true),
  message: executorMessageSchema,
}).strict();

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

function ok(data: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
    ...(data.deliveryStatus === "rejected" ? { isError: true } : {}),
  };
}

function fail(code: string, message: string, scope?: string): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: code, message }) }],
    ...(scope ? { _meta: { "mcp/www_authenticate": [`Bearer error="insufficient_scope", scope="${scope}"`] } } : {}),
  };
}

function requireAuth(auth: AuthInfo | undefined, scope: string): AuthInfo {
  if (!auth) throw new ExecutorControlError("UNAUTHORIZED", "Executor 工具需要有效的 OAuth 授权。");
  if (!auth.scopes.includes(scope)) throw new ExecutorControlError("INSUFFICIENT_SCOPE", `需要 ${scope} 授权。`);
  if (!auth.clientId || auth.clientId.length > 256) {
    throw new ExecutorControlError("UNAUTHORIZED", "缺少有效的 OAuth 客户端身份。");
  }
  return auth;
}

function authorizeNow(auth: AuthInfo): void {
  if (auth.expiresAt !== undefined && auth.expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new ExecutorControlError("AUTH_EXPIRED", "OAuth 授权已过期，请重新授权后再操作。");
  }
}

function requestPlannerFingerprint(extra: { authInfo?: AuthInfo; sessionId?: string; _meta?: unknown }): string {
  try {
    const principal = resolveConversationPrincipal(extra);
    requireConversationPrincipal(principal);
    return principal.fingerprint;
  } catch (error) {
    if (error instanceof ConversationPrincipalError) {
      throw new RoutingError(
        "ROUTING_PLANNER_IDENTITY_UNAVAILABLE",
        "缺少当前 MCP 对话主体；拒绝创建或投递 Executor Command。",
      );
    }
    throw error;
  }
}

function safeError(error: unknown, scope?: string): ToolResult {
  if (error instanceof ExecutorControlError) {
    return error.code === "INSUFFICIENT_SCOPE"
      ? fail(error.code, error.message, scope)
      : fail(error.code, error.message);
  }
  if (error instanceof ExecutorDispatchError || error instanceof EndpointSwitchLockError) {
    return fail(error.code, error.message);
  }
  if (error instanceof DesktopError || error instanceof RoutingError) {
    return fail(error.code, error.message);
  }
  return fail("EXECUTOR_ERROR", "Executor 操作失败；请先读取状态。");
}

function result(action: () => unknown | Promise<unknown>, scope?: string): Promise<ToolResult> {
  return Promise.resolve()
    .then(action)
    .then(data => ok(data as Record<string, unknown>))
    .catch(error => safeError(error, scope));
}

/**
 * Generic Executor MCP tools。
 * 只读 list/status + control send。
 * 不提供 MCP executor_bind（本地绑定边界）。
 * executor_send 只走 production backend 与既有 durable sender。
 */
export function registerExecutorTools(
  server: McpServer,
  workspace: Workspace,
  executorAuthorize?: (auth: AuthInfo) => void,
  mailbox?: CommandMailboxSubmit,
): void {
  server.registerTool(
    "executor_list",
    {
      title: "列出 Executor 插件",
      description: "只读列出 production Executor plugin registry 中的本地编程工具；不会绑定或发送。",
      inputSchema: listInputSchema,
      outputSchema: listOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: [EXECUTOR_READ_SCOPE] }] },
    },
    (_input, extra) => result(() => {
      const auth = requireAuth(extra.authInfo, EXECUTOR_READ_SCOPE);
      authorizeNow(auth);
      return { plugins: listExecutorPlugins() };
    }, EXECUTOR_READ_SCOPE),
  );

  server.registerTool(
    "executor_status",
    {
      title: "查看 Active Executor Binding",
      description: "只读查看当前 workspace 的 active Executor Binding、插件能力与可用性；不会绑定或发送。",
      inputSchema: statusInputSchema,
      outputSchema: statusOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: [EXECUTOR_READ_SCOPE] }] },
    },
    (input, extra) => result(async () => {
      const auth = requireAuth(extra.authInfo, EXECUTOR_READ_SCOPE);
      authorizeNow(auth);
      if (input.workspaceId !== workspace.id) {
        throw new ExecutorControlError("EXECUTOR_CONTROL_WORKSPACE_MISMATCH", "请求工作区不匹配。");
      }
      return executorStatus(workspace.id, workspace.root);
    }, EXECUTOR_READ_SCOPE),
  );

  server.registerTool(
    "executor_send",
    {
      title: "发送到 Active Executor",
      description:
        "向当前 active Executor Binding 提交任务，Bridge 持久排队并返回 queued，Codex 空闲后投递。queued/accepted 不表示执行完成。必须提供用户本地 bind-current 后的 bindingId；不会重新发现或切换 executor。正文可能被本地编程工具修改文件或执行命令。同 commandId 从 durable ledger 回放，结果不明不自动重发；其他独立任务仍可排队。",
      inputSchema: sendInputSchema,
      outputSchema: sendOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: [EXECUTOR_CONTROL_SCOPE] }] },
    },
    (input, extra) => result(async () => {
      const auth = requireAuth(extra.authInfo, EXECUTOR_CONTROL_SCOPE);
      authorizeNow(auth);
      // R5E_AUTH_BEFORE_PIN：durable target pin 之前的 live OAuth 重验证
      // （token/store 实时校验）；send-time 的 authorize 回调保留为第二道重验证。
      executorAuthorize?.(auth);
      if (input.workspaceId !== workspace.id) {
        throw new ExecutorControlError("EXECUTOR_CONTROL_WORKSPACE_MISMATCH", "请求工作区不匹配。");
      }
      const plannerFingerprint = requestPlannerFingerprint(extra);
      if (mailbox) return mailbox("executor", input, plannerFingerprint, auth);
      return dispatchExecutorCommand(workspace, input, plannerFingerprint, auth.clientId, () => {
        authorizeNow(auth); executorAuthorize?.(auth);
      });
    }, EXECUTOR_CONTROL_SCOPE),
  );
}
