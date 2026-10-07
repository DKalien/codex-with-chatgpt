import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type SecurityScheme = { type: "oauth2"; scopes: string[] } | { type: "noauth" };
type ToolDescriptor = Record<string, unknown>;
type RequestHandler = (request: unknown, extra: unknown) => Promise<unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * SDK 1.30 only serializes `_meta`; expose the standard top-level mirror too.
 * The private handler map is the smallest compatibility bridge until the SDK
 * accepts `securitySchemes` in registerTool itself.
 */
export function exposeTopLevelToolSecuritySchemes(
  server: McpServer,
  fallback: Record<string, SecurityScheme[]>,
): void {
  const protocol = (server as unknown as {
    server: {
      _requestHandlers: Map<string, RequestHandler>;
      setRequestHandler(schema: typeof ListToolsRequestSchema, handler: RequestHandler): void;
    };
  }).server;
  const original = protocol._requestHandlers.get("tools/list");
  if (!original) throw new Error("MCP tools/list handler is not initialized");

  protocol.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = await original(request, extra);
    if (!isRecord(result) || !Array.isArray(result.tools)) return result;
    return {
      ...result,
      tools: result.tools.map((value): ToolDescriptor => {
        if (!isRecord(value)) return value as ToolDescriptor;
        const meta = isRecord(value._meta) ? value._meta : {};
        const schemes = Array.isArray(value.securitySchemes)
          ? value.securitySchemes
          : Array.isArray(meta.securitySchemes)
            ? meta.securitySchemes
            : fallback[String(value.name)];
        return schemes ? { ...value, securitySchemes: schemes, _meta: { ...meta, securitySchemes: schemes } } : value;
      }),
    };
  });
}
