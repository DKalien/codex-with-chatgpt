import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Workspace } from "../workspace/manager.js";
import { WEB_SINK_READ_SCOPE } from "../auth/store.js";
import { WebSinkControlError } from "../web-sink-control/schema.js";
import {
  listWebSinkSurfaces,
  webSinkStatus,
} from "../web-sink-control/service.js";
import { readFeedbackState } from "../feedback/store.js";
import { isRouteAttestationVerified } from "../feedback/schema.js";

export { WEB_SINK_READ_SCOPE };

const pluginSummarySchema = z.object({
  pluginId: z.string(),
  surfaceId: z.string(),
  name: z.string(),
  capabilities: z.record(z.boolean()),
}).strict();

const bindingSchema = z.object({
  bindingId: z.string(),
  pluginId: z.string(),
  surfaceId: z.string(),
  workspaceId: z.string(),
  canonicalUrl: z.string(),
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

const listInputSchema = z.object({}).strict();
const statusInputSchema = z.object({
  workspaceId: z.string().regex(/^[a-f0-9]{12}$/),
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
  if (!auth) throw new WebSinkControlError("UNAUTHORIZED", "Web Sink 工具需要有效的 OAuth 授权。");
  if (!auth.scopes.includes(scope)) throw new WebSinkControlError("INSUFFICIENT_SCOPE", `需要 ${scope} 授权。`);
  return auth;
}

function authorizeNow(auth: AuthInfo): void {
  if (auth.expiresAt !== undefined && auth.expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new WebSinkControlError("AUTH_EXPIRED", "OAuth 授权已过期，请重新授权后再操作。");
  }
}

function safeError(error: unknown, scope?: string): ToolResult {
  if (error instanceof WebSinkControlError) {
    return error.code === "INSUFFICIENT_SCOPE"
      ? fail(error.code, error.message, scope)
      : fail(error.code, error.message);
  }
  return fail("WEB_SINK_ERROR", "Web Sink 操作失败；请先读取状态。");
}

function result(action: () => unknown | Promise<unknown>, scope?: string): Promise<ToolResult> {
  return Promise.resolve()
    .then(action)
    .then(data => ok(data as Record<string, unknown>))
    .catch(error => safeError(error, scope));
}

/**
 * Generic Web Sink MCP read-only tools。
 * 不提供 MCP web_sink_bind / web_sink_switch（绑定必须来自 Companion 页面证明）。
 */
export function registerWebSinkTools(server: McpServer, workspace: Workspace): void {
  server.registerTool(
    "web_sink_list",
    {
      title: "列出 Web Sink Surface",
      description: "只读列出 production Web Sink surface；不会绑定或切换结果目的地。",
      inputSchema: listInputSchema,
      outputSchema: listOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: [WEB_SINK_READ_SCOPE] }] },
    },
    (_input, extra) => result(() => {
      const auth = requireAuth(extra.authInfo, WEB_SINK_READ_SCOPE);
      authorizeNow(auth);
      return { plugins: listWebSinkSurfaces() };
    }, WEB_SINK_READ_SCOPE),
  );

  server.registerTool(
    "web_sink_status",
    {
      title: "查看 Active Web Sink Binding",
      description: "只读查看当前 workspace 的 Active Web Sink Binding（URL identity）；不包含 planner/feedback 私有身份。",
      inputSchema: statusInputSchema,
      outputSchema: statusOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: [WEB_SINK_READ_SCOPE] }] },
    },
    (input, extra) => result(async () => {
      const auth = requireAuth(extra.authInfo, WEB_SINK_READ_SCOPE);
      authorizeNow(auth);
      if (input.workspaceId !== workspace.id) {
        throw new WebSinkControlError("WEB_SINK_WORKSPACE_MISMATCH", "请求工作区不匹配。");
      }
      let companionRouteCanonical: string | null = null;
      let companionVerified = false;
      let companionAvailable = false;
      try {
        const feedback = readFeedbackState(workspace.id);
        const companion = feedback?.companion ?? null;
        if (companion && !companion.supersededAt) {
          companionAvailable = true;
          companionRouteCanonical = companion.routeCanonical;
          companionVerified = isRouteAttestationVerified(companion);
        }
      } catch {
        companionAvailable = false;
      }
      return webSinkStatus(workspace.id, {
        companionRouteCanonical,
        companionVerified,
        companionAvailable,
      });
    }, WEB_SINK_READ_SCOPE),
  );
}
