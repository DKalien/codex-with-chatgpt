import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isWriteProbeEnabled, probeNonceSchema, writeProbe, WRITE_PROBE_LOCATION, WRITE_PROBE_SCOPE } from "./write-probe.js";
import { fail, okStructured, scopeSatisfied, type McpContext } from "./tool-shared.js";

export function registerWriteProbeTools(server: McpServer, ctx: McpContext): void {
  if (!isWriteProbeEnabled()) return;
  const { workspace } = ctx;
  server.registerTool(
    "write_probe",
    {
      title: "实验性 MCP 写入探针",
      description: "实验性写操作：将测试 nonce 覆盖保存到 C2C 自身的固定状态文件。需要 probe.write 授权；不修改工作区，不执行命令。仅用于验证账户的 MCP write action 支持情况。",
      inputSchema: z.object({ nonce: probeNonceSchema }).strict(),
      outputSchema: {
        ok: z.literal(true), written: z.literal(true), nonce: probeNonceSchema,
        timestamp: z.string(), location: z.literal(WRITE_PROBE_LOCATION),
      },
      // 覆盖上一次探针记录，且每次更新时间；不与外部实体交互。
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      _meta: { securitySchemes: [{ type: "oauth2", scopes: [WRITE_PROBE_SCOPE] }] },
    },
    async ({ nonce }, extra) => {
      if (!extra.authInfo || !scopeSatisfied(extra.authInfo, WRITE_PROBE_SCOPE)) {
        return fail(
          "INSUFFICIENT_SCOPE",
          "需要 probe.write 授权。请重新授权当前 Connector；旧 read token 不会自动升级。",
          "reauth",
          WRITE_PROBE_SCOPE,
        );
      }
      try {
        return okStructured(writeProbe(workspace.id, nonce));
      } catch {
        return fail("PROBE_WRITE_FAILED", `无法写入 ${WRITE_PROBE_LOCATION}；请在本地检查 C2C 状态目录权限。`);
      }
    },
  );
}
