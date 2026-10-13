import fs from "node:fs";
import path from "node:path";
import { getStateDir, writeSecureJson } from "../config/paths.js";
import { assertMaintenanceHandle, type MaintenanceLockHandle } from "../core/maintenance-lock.js";
import { normalizeNamedTunnelHostname } from "../tunnel/cloudflared-named.js";
import { readTunnelState } from "../tunnel/state.js";
import { Workspace } from "../workspace/manager.js";
import { GatewayRegistry, GatewayRegistryError } from "./registry.js";
import type { GatewaySupervisorConfig } from "./supervisor.js";

function invalid(message: string): never {
  throw new GatewayRegistryError("GATEWAY_TUNNEL_INGRESS_INVALID", `${message}；共享 Tunnel 不会启动。`);
}

function hostname(value: string): string {
  let normalized: string;
  try { normalized = normalizeNamedTunnelHostname(value); }
  catch { return invalid("named hostname 格式无效"); }
  if (normalized !== value) invalid("named hostname 不是规范 DNS 名称");
  return normalized;
}

/** 仅读取已登记规范 workspace 的 named identity；不 provision DNS 或复制凭据。 */
export function buildGatewayTunnelIngress(config: Pick<GatewaySupervisorConfig, "publicUrl" | "port">, stateDir = getStateDir()) {
  if (path.resolve(stateDir) !== getStateDir()) invalid("ingress 与 Gateway state root 不一致");
  const gatewayUrl = new URL(config.publicUrl);
  if (gatewayUrl.protocol !== "https:" || gatewayUrl.port || gatewayUrl.username || gatewayUrl.password ||
      gatewayUrl.pathname !== "/" || gatewayUrl.search || gatewayUrl.hash) invalid("Gateway origin 无效");
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) invalid("Gateway 端口无效");
  const hosts = new Set([hostname(gatewayUrl.hostname)]);
  for (const entry of new GatewayRegistry(stateDir).list()) {
    let workspace: Workspace;
    try { workspace = new Workspace(entry.root); }
    catch { return invalid("已登记 workspace root 无法核验"); }
    if (workspace.id !== entry.workspaceId || workspace.root !== entry.root) invalid("已登记 workspace identity 不一致");
    const state = readTunnelState(workspace.id);
    if (state.workspaceId !== workspace.id || state.preference !== "named" || state.provider !== "cloudflare-named" ||
        typeof state.hostname !== "string") invalid("已登记 workspace 缺少有效 named Tunnel identity");
    const host = hostname(state.hostname);
    if (hosts.has(host)) invalid("Gateway 与 workspace hostname 冲突");
    hosts.add(host);
  }
  const service = `http://127.0.0.1:${config.port}`;
  const ingress: Array<{ hostname?: string; service: string }> = [...hosts].map(hostname => ({ hostname, service }));
  ingress.push({ service: "http_status:404" });
  return { ingress };
}

/** JSON 是 YAML 子集；写入机器日志目录，避免新增 GC/runtime pin 合同。 */
export function writeGatewayTunnelIngress(config: GatewaySupervisorConfig, stateDir: string, handle: MaintenanceLockHandle): string {
  assertMaintenanceHandle(stateDir, handle);
  const payload = buildGatewayTunnelIngress(config, stateDir);
  const directory = path.join(path.resolve(stateDir), "logs");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dirStat = fs.lstatSync(directory);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || fs.realpathSync.native(directory) !== directory)
    invalid("ingress 目录不是规范机器目录");
  const file = path.join(directory, "gateway-cloudflared.yml");
  let stat: fs.Stats | undefined;
  try { stat = fs.lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") invalid("ingress 配置无法核验"); }
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync.native(file) !== file))
    invalid("ingress 配置不是 owner 普通文件");
  assertMaintenanceHandle(stateDir, handle);
  writeSecureJson(file, payload);
  return file;
}
