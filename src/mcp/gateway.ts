import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GatewayRegistry } from "../gateway/registry.js";
import { PRODUCT_NAME, VERSION } from "../version.js";
import { registerExecutionTools } from "./execution-tools.js";
import { registerFeedbackTools } from "./feedback.js";
import { registerRemoteTools } from "./remote.js";
import { mapError, okStructured, requireScope, UNTRUSTED_NOTE, type WorkspaceResolver } from "./tool-shared.js";
import { registerWebSinkTools } from "./web-sink-tools.js";
import { registerWorkspaceTools } from "./workspace-tools.js";
import { exposeTopLevelToolSecuritySchemes } from "./security-schemes.js";

const gatewaySecuritySchemes = (scope: string) => [{ type: "oauth2" as const, scopes: [scope] }];

export function registerGatewayTools(server: McpServer, registry: GatewayRegistry): void {
  const resolveWorkspace: WorkspaceResolver = (workspaceId, clientId) => registry.resolve(workspaceId, clientId);

  server.registerTool("gateway_list_workspaces", {
    title: "List authorized workspaces",
    description: "列出当前 OAuth 客户端已获准访问的本机项目。每个项目都重新核验授权和规范 root。",
    inputSchema: {},
    outputSchema: {
      clientId: z.string(),
      workspaces: z.array(z.object({ workspaceId: z.string(), root: z.string(), name: z.string() })),
    },
    annotations: { readOnlyHint: true },
    _meta: { securitySchemes: [{ type: "oauth2", scopes: ["workspace.read"] }] },
  }, async (_input, extra) => {
    const denied = requireScope(extra.authInfo, "workspace.read", true);
    if (denied) return denied;
    try {
      const clientId = extra.authInfo!.clientId;
      const workspaces = registry.list(clientId).map(entry => {
        const workspace = registry.resolve(entry.workspaceId, clientId);
        return { workspaceId: workspace.id, root: workspace.root, name: workspace.name };
      });
      return okStructured({ clientId, workspaces });
    } catch (error) {
      return mapError(error);
    }
  });

  registerWorkspaceTools(server, {}, "gateway", resolveWorkspace);
  registerRemoteTools(server, resolveWorkspace, "gateway");
  registerExecutionTools(server, resolveWorkspace);
  registerFeedbackTools(server, resolveWorkspace);
  registerWebSinkTools(server, resolveWorkspace);
}

export function createGatewayMcpServer(registry: GatewayRegistry): McpServer {
  const server = new McpServer(
    { name: PRODUCT_NAME, version: VERSION },
    { capabilities: { tools: {}, resources: {} }, instructions: UNTRUSTED_NOTE },
  );
  registerGatewayTools(server, registry);
  exposeTopLevelToolSecuritySchemes(server, {
    workspace_info: gatewaySecuritySchemes("workspace.read"),
    list_directory: gatewaySecuritySchemes("workspace.read"),
    read_file: gatewaySecuritySchemes("workspace.read"),
    search_workspace: gatewaySecuritySchemes("workspace.search"),
    git_status: gatewaySecuritySchemes("git.read"),
    git_diff: gatewaySecuritySchemes("git.read"),
    test_status: gatewaySecuritySchemes("execution.read"),
    execution_summary: gatewaySecuritySchemes("execution.read"),
    execution_output: gatewaySecuritySchemes("execution.read"),
  });
  return server;
}
