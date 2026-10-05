import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRemoteTools } from "./remote.js";
import { registerFeedbackProbeTools } from "./feedback-probe.js";
import { registerFeedbackTools } from "./feedback.js";
import { registerDesktopTools } from "./desktop.js";
import { registerExecutorTools } from "./executor-tools.js";
import { registerWebSinkTools } from "./web-sink-tools.js";
import { PRODUCT_NAME, VERSION } from "../version.js";
import { registerWorkspaceTools } from "./workspace-tools.js";
import { registerExecutionTools } from "./execution-tools.js";
import { registerWriteProbeTools } from "./write-probe-tools.js";
import { UNTRUSTED_NOTE, type McpContext } from "./tool-shared.js";

export type { McpContext } from "./tool-shared.js";
export { buildWorkspaceInfoWorkflow } from "./workspace-tools.js";
export { workflowOutputSchema } from "./base-schemas.js";

export function createMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: PRODUCT_NAME, version: VERSION },
    { capabilities: { tools: {}, resources: {} }, instructions: UNTRUSTED_NOTE },
  );

  // Keep registration order stable: base workspace, execution, optional write probe,
  // then the existing remote/Desktop/feedback groups, then generic executor tools.
  registerWorkspaceTools(server, ctx);
  registerExecutionTools(server, ctx);
  registerWriteProbeTools(server, ctx);
  registerRemoteTools(server, ctx.workspace);
  registerDesktopTools(server, ctx.workspace, ctx.desktopAuthorize, ctx.commandMailbox);
  // 默认关闭；C2C_ENABLE_FEEDBACK_PROBE=1 时注册 UI resource + 探针工具。
  registerFeedbackProbeTools(server, ctx.workspace);
  // production feedback：永久 scope codex.feedback；与 synthetic probe 分离。
  registerFeedbackTools(server, ctx.workspace);
  // R5b generic executor control plane（不提供 MCP bind）。
  registerExecutorTools(server, ctx.workspace, ctx.executorAuthorize, ctx.commandMailbox);
  // R5c generic Web Sink read-only（不提供 MCP bind/switch）。
  registerWebSinkTools(server, ctx.workspace);
  return server;
}
