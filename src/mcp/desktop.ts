import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Workspace } from "../workspace/manager.js";
import { DesktopError, desktopIntent, readDesktop, sendInput, statusInput } from "../desktop/store.js";
import { desktopStatus, sendDesktop } from "../desktop/service.js";
import { DESKTOP_CONTROL_SCOPE, DESKTOP_READ_SCOPE } from "../auth/store.js";

export { DESKTOP_CONTROL_SCOPE, DESKTOP_READ_SCOPE };

const bindingOutputSchema = z.object({
  bindingId: z.string().uuid(),
  threadId: z.string().uuid(),
  hostId: z.literal("local"),
  projectId: z.string(),
  title: z.string(),
  boundAt: z.string(),
}).strict();

const deliveryOutputSchema = z.object({
  commandId: z.string(),
  intent: desktopIntent.optional(),
  bindingId: z.string().uuid(),
  threadId: z.string().uuid(),
  turnId: z.string().uuid().optional(),
  deliveryStatus: z.enum(["outcome_unknown", "accepted", "rejected"]),
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  message: z.string(),
}).strict();

const statusOutputSchema = {
  workspaceId: z.string(),
  enabled: z.boolean(),
  binding: bindingOutputSchema.nullable(),
  availability: z.object({
    available: z.boolean(),
    error: z.string().optional(),
    message: z.string().optional(),
  }).strict(),
  unresolvedDelivery: z.boolean(),
  delivery: deliveryOutputSchema.nullable(),
};

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

function safeError(error: unknown): ToolResult {
  if (error instanceof DesktopError) return fail(error.code, error.message);
  return fail("DESKTOP_ERROR", "Desktop Control 操作失败；请先读取状态。若投递结果不明，请勿重发，先在 Desktop 人工核对。" );
}

function requireAuth(auth: AuthInfo | undefined, scope: string): AuthInfo {
  if (!auth) throw new DesktopError("UNAUTHORIZED", "Desktop Control 需要有效的 OAuth 授权。" );
  if (!auth.scopes.includes(scope)) throw new DesktopError("INSUFFICIENT_SCOPE", `需要 ${scope} 授权。`);
  if (!auth.clientId || auth.clientId.length > 256) {
    throw new DesktopError("UNAUTHORIZED", "缺少有效的 OAuth 客户端身份。" );
  }
  return auth;
}

function authorizeNow(auth: AuthInfo): void {
  if (auth.expiresAt !== undefined && auth.expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new DesktopError("AUTH_EXPIRED", "OAuth 授权已过期，请重新授权后再操作。" );
  }
}

function result(action: () => unknown | Promise<unknown>, scope?: string): Promise<ToolResult> {
  return Promise.resolve().then(action).then((data) => ok(data as Record<string, unknown>)).catch((error) =>
    error instanceof DesktopError && error.code === "INSUFFICIENT_SCOPE"
      ? fail(error.code, error.message, scope)
      : safeError(error)
  );
}

/** Register Desktop tools only after a local user has bound a real Desktop session. */
export function registerDesktopTools(
  server: McpServer,
  workspace: Workspace,
  desktopAuthorize?: (auth: AuthInfo) => void,
): void {
  try {
    if (!readDesktop(workspace.id)?.binding) return;
  } catch (error) {
    // 已存在但损坏的状态仍提供错误诊断；工具内部读取严格校验，绝不恢复或发送。
    if (!(error instanceof DesktopError) || error.code !== "DESKTOP_STATE_CORRUPT") throw error;
  }

  server.registerTool(
    "codex_desktop_send",
    {
      title: "发送任务到 Desktop",
      description: "向已绑定且已授权的 Desktop 会话投递完整开发计划（development_plan）或修订（revision）。只有用户在当前对话明确确认后，才设置 userConfirmed:true 并调用。该字段仅为模型可填写的意图/审计信号，不是授权凭证，不能替代 OAuth、本机 enable、bindingId 或 Desktop 审批，也不改变或绕过平台安全策略，不保证计划不会被拦截。正文可能由 Desktop 按现有权限修改文件或执行命令。仅等待接受，不等待完成；idempotent 仅表示同 commandId 防重复尝试。",
      inputSchema: sendInput,
      outputSchema: {
        commandId: z.string(), bindingId: z.string().uuid(), threadId: z.string().uuid(),
        intent: desktopIntent.optional(),
        turnId: z.string().uuid().optional(), deliveryStatus: z.enum(["outcome_unknown", "accepted", "rejected"]), error: z.string().optional(),
        createdAt: z.string(), updatedAt: z.string(), message: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: [DESKTOP_CONTROL_SCOPE] }] },
    },
    (input, extra) => result(async () => {
      const auth = requireAuth(extra.authInfo, DESKTOP_CONTROL_SCOPE);
      authorizeNow(auth);
      return sendDesktop(workspace, input, auth.clientId, () => {
        authorizeNow(auth);
        desktopAuthorize?.(auth);
      });
    }, DESKTOP_CONTROL_SCOPE)
  );

  server.registerTool(
    "codex_desktop_status",
    {
      title: "查看 Desktop 投递状态",
      description: "读取当前 Desktop 绑定、可用性和可选 commandId 的投递状态；不会发送消息、恢复任务或切换目标。",
      inputSchema: statusInput,
      outputSchema: statusOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: [DESKTOP_READ_SCOPE] }] },
    },
    (input, extra) => result(async () => {
      const auth = requireAuth(extra.authInfo, DESKTOP_READ_SCOPE);
      authorizeNow(auth);
      if (input.workspaceId !== workspace.id) throw new DesktopError("DESKTOP_WRONG_WORKSPACE", "请求工作区不匹配。" );
      return desktopStatus(workspace, input.commandId);
    }, DESKTOP_READ_SCOPE)
  );
}
