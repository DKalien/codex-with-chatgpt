import type { Command } from "commander";
import { Workspace } from "../workspace/manager.js";
import { findBridgeObservation } from "../bridge/runtime.js";
import { adminFetch, ensureBridgeAndTunnel, type BridgeAdminInfo as AdminInfo } from "../process/daemon.js";
import { connectorNameFor, readLastEndpoint } from "../config/endpoint.js";
import { isNamedTunnelReady, readTunnelState } from "../tunnel/state.js";
import { PRODUCT_NAME } from "../version.js";
import { isWriteProbeEnabled, readWriteProbeStatus, WRITE_PROBE_SCOPE } from "../mcp/write-probe.js";
import { trySandboxAllow, persistWorkspaceEndpoint, type PairingResponse } from "./shared.js";
import { handleCliError, resolveWorkspace, say, check } from "./shared.js";

export function registerSetupCommands(program: Command): void {
// ---------------------------------------------------------------- setup

program
  .command("write-probe-status")
  .description("只读查看实验性 MCP 写入探针的开关和最近落盘结果")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const observation = await findBridgeObservation(workspace.id);
      const enabled = observation.state === "healthy"
        ? (await adminFetch<AdminInfo>(observation.runtime, "GET", "/admin/info")).writeProbeEnabled ?? null
        : observation.state === "stopped" ? false : null;
      const result = {
        enabled, configured: isWriteProbeEnabled(), bridgeState: observation.state,
        requiredScope: WRITE_PROBE_SCOPE, ...readWriteProbeStatus(),
      };
      if (opts.json) say(JSON.stringify(result));
      else {
        say(`运行中的 Bridge 已开启探针：${enabled === null ? "未知（请检查或重启 Bridge）" : enabled ? "是" : "否"}`);
        say(`当前 CLI 环境开关：${result.configured ? "开启" : "关闭"}；所需授权：${WRITE_PROBE_SCOPE}`);
        say(`探针文件：${result.exists ? "存在" : "不存在"}（${result.location}）`);
        say(`最近 nonce：${result.nonce ?? "无"}；时间：${result.timestamp ?? "无"}；workspaceId：${result.workspaceId ?? "无"}`);
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("setup")
  .description("First-time setup: bridge + secure connection + pairing code")
  .option("-w, --workspace <path>")
  .option("--no-tunnel", "local-only setup (development)")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      if (!opts.json) {
        say(PRODUCT_NAME);
        say("");
        say("正在连接 ChatGPT…");
        say("");
      }
      const sandbox = trySandboxAllow();
      const { runtime, info, mcpUrl } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel });
      const connectorName = mcpUrl
        ? persistWorkspaceEndpoint({
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
          })
        : connectorNameFor({
            workspaceName: info.workspaceName,
            workspaceId: info.workspaceId,
            previousName: readLastEndpoint(info.workspaceId)?.connectorName,
            hadEndpointBefore: Boolean(readLastEndpoint(info.workspaceId)),
          });
      const pairingResult = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
      const tunnelState = readTunnelState(info.workspaceId);
      if (opts.json) {
        say(
          JSON.stringify({
            ok: true,
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            connectorName,
            mcpUrl: mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`,
            local: mcpUrl === null,
            pairingCode: pairingResult.code,
            pairingExpiresAt: pairingResult.expiresAt,
            sandbox,
            tunnel: {
              mode: isNamedTunnelReady(tunnelState) ? "named" : "quick",
              hostname: tunnelState.hostname ?? null,
              fallback: Boolean(tunnelState.fallbackReason),
            },
          })
        );
        return;
      }
      check(`当前项目已识别（${info.workspaceName}）`);
      check("Workspace Bridge 已启动");
      if (mcpUrl) check("安全连接已建立");
      say("");
      say(`连接地址：${mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`}`);
      say(`配对码：${pairingResult.code}（${Math.round((pairingResult.expiresAt - Date.now()) / 60000)} 分钟内有效）`);
      say("");
      say("下一步：在 ChatGPT 的连接器设置中添加以上地址（OAuth），并在授权页输入配对码。");
      say("如果你在使用 Codex Skill，这一步会自动完成。");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });
}
