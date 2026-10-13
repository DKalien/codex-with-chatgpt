import { InvalidArgumentError, Option, type Command } from "commander";
import path from "node:path";
import { GatewayRegistry } from "../gateway/registry.js";
import {
  configureGatewaySupervisor,
  GatewaySupervisorError,
  readGatewaySupervisorStatus,
  runGatewaySupervisor,
  setGatewayTunnelKey,
  validateGatewaySupervisor,
} from "../gateway/supervisor.js";

export function registerGatewayCommands(program: Command): void {
  const gateway = program.command("gateway").description("管理本机 Gateway 与显式授权项目");

  gateway.command("register").description("显式授权一个本机 workspace 给 OAuth client")
    .requiredOption("--workspace <root>")
    .requiredOption("--client-id <clientId>")
    .action((opts: { workspace: string; clientId: string }) => {
      const entry = new GatewayRegistry().register(opts.workspace, opts.clientId);
      process.stdout.write(`已授权 workspace ${entry.workspaceId}：${entry.root}\n`);
    });

  gateway.command("list").description("列出本机已登记的 workspace")
    .option("--client-id <clientId>")
    .option("--json", "machine-readable output", false)
    .action((opts: { clientId?: string; json: boolean }) => {
      const entries = new GatewayRegistry().list(opts.clientId);
      if (opts.json) process.stdout.write(JSON.stringify(entries) + "\n");
      else if (entries.length === 0) process.stdout.write("没有已登记的 workspace。\n");
      else for (const entry of entries) process.stdout.write(`${entry.workspaceId}\t${entry.root}\t${entry.clientIds.join(", ")}\n`);
    });

  gateway.command("revoke").description("撤销本机 Gateway workspace 授权")
    .requiredOption("--workspace-id <id>")
    .option("--client-id <clientId>")
    .action((opts: { workspaceId: string; clientId?: string }) => {
      const revoked = new GatewayRegistry().revoke(opts.workspaceId, opts.clientId);
      process.stdout.write(revoked ? "已撤销 Gateway workspace 授权。\n" : "没有匹配的 Gateway workspace 授权。\n");
    });

  gateway.command("serve").description("启动本机 Gateway MCP；只绑定 loopback，不创建 Tunnel")
    .requiredOption("--port <port>", "loopback 监听端口", parsePort)
    .requiredOption("--public-url <url>", "明确配置的 HTTPS OAuth metadata 公网地址")
    .action(async (opts: { port: number; publicUrl: string }) => {
      const { startGatewayServer } = await import("../remote/server.js");
      const service = await startGatewayServer({ port: opts.port, publicUrl: opts.publicUrl });
      process.stdout.write(`Gateway MCP ready at ${service.localBaseUrl()}/mcp\n`);
      process.stdout.write(`OAuth public URL: ${service.publicUrl}\n`);
      process.stdout.write(`Local pairing code: ${service.pairingCode} (expires ${new Date(service.pairingExpiresAt).toISOString()})\n`);
      const stop = (): void => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        void service.close();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });

  const supervisor = gateway.command("supervisor").description("读取或校验机器级 Gateway supervisor 状态");
  const supervisorOptions = (command: Command): Command => command
    .option("--state-dir <path>", "机器状态目录")
    .option("--json", "machine-readable output", false);
  const stateDir = (opts: { stateDir?: string }): string | undefined => opts.stateDir;
  const output = (opts: { json: boolean }, value: unknown): void => {
    process.stdout.write(`${opts.json ? JSON.stringify(value) : JSON.stringify(value, null, 2)}\n`);
  };

  supervisor.command("configure")
    .description("写入机器级 Gateway/Tunnel 绑定配置；不接受明文 key")
    .requiredOption("--public-url <url>", "Gateway 的 HTTPS 公网 origin")
    .requiredOption("--port <port>", "Gateway loopback 端口", parseFixedPort)
    .requiredOption("--tunnel-name <name>", "机器级 Tunnel 名称")
    .requiredOption("--tunnel-id <id>", "机器级 Tunnel ID")
    .requiredOption("--stable-launcher <path>", "稳定 launcher 的绝对路径")
    .requiredOption("--cloudflared <path>", "cloudflared 的绝对路径")
    .requiredOption("--tunnel-client <path>", "Secure MCP Tunnel client 的绝对路径")
    .option("--proxy <url>", "可选的 HTTP(S) proxy")
    .option("--unified", "启用共享 Gateway、Bridge 与 Tunnel")
    .option("--state-dir <path>", "机器状态目录")
    .option("--json", "machine-readable output", false)
    .action((opts: {
      publicUrl: string;
      port: number;
      tunnelName: string;
      tunnelId: string;
      stableLauncher: string;
      cloudflared: string;
      tunnelClient: string;
      proxy?: string;
      unified?: boolean;
      stateDir?: string;
      json: boolean;
    }) => {
      const config = configureGatewaySupervisor({
        stateDir: opts.stateDir,
        publicUrl: opts.publicUrl,
        port: opts.port,
        tunnelName: opts.tunnelName,
        tunnelId: opts.tunnelId,
        stableLauncher: opts.stableLauncher,
        cloudflaredPath: opts.cloudflared,
        tunnelClientPath: opts.tunnelClient,
        proxy: opts.proxy ?? null,
        unified: opts.unified,
      });
      output(opts, { ok: true, config });
    });

  supervisorOptions(supervisor.command("status").description("只读查看 Gateway supervisor 配置与 runtime"))
    .action((opts: { stateDir?: string; json: boolean }) => {
      try { output(opts, readGatewaySupervisorStatus(stateDir(opts))); }
      catch (error) { throw error instanceof GatewaySupervisorError ? error : new Error("GATEWAY_SUPERVISOR_STATUS_FAILED"); }
    });

  supervisorOptions(supervisor.command("validate").description("只读校验 Gateway supervisor 配置、runtime 与端口")
    ).action((opts: { stateDir?: string; json: boolean }) => {
      try { output(opts, validateGatewaySupervisor(stateDir(opts))); }
      catch (error) { throw error instanceof GatewaySupervisorError ? error : new Error("GATEWAY_SUPERVISOR_VALIDATE_FAILED"); }
    });

  supervisor.command("run").description("前台运行已校验的 Gateway、Cloudflare origin 与 Secure MCP Tunnel；不注册 Scheduled Task")
    .option("--state-dir <path>", "机器状态目录")
    .addOption(new Option("--background").hideHelp())
    .action(async (opts: { stateDir?: string; background?: boolean }) => {
      // All Gateway stores resolve the same machine directory for this CLI process.
      if (opts.stateDir) process.env.C2C_STATE_DIR = path.resolve(opts.stateDir);
      await runGatewaySupervisor({ stateDir: opts.stateDir, onPairing: opts.background ? undefined : ({ code, expiresAt }) => {
        process.stdout.write(`Local pairing code: ${code} (expires ${new Date(expiresAt).toISOString()})\n`);
      } });
    });

  supervisor.command("set-key").description("通过 Windows DPAPI 交互式保存 Gateway tunnel key；不接受命令行 key")
    .option("--state-dir <path>", "机器状态目录")
    .option("--json", "machine-readable output", false)
    .action((opts: { stateDir?: string; json: boolean }) => {
      const saved = setGatewayTunnelKey({ stateDir: opts.stateDir });
      const output = { ok: true, keyFile: saved.keyFile, keyReference: saved.keyReference };
      process.stdout.write(`${opts.json ? `${JSON.stringify(output)}\n` : `已安全保存 Gateway tunnel key reference：${saved.keyReference}\n`}`);
    });
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new InvalidArgumentError("port must be an integer from 0 to 65535");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65535) throw new InvalidArgumentError("port must be an integer from 0 to 65535");
  return port;
}

function parseFixedPort(value: string): number {
  const port = parsePort(value);
  if (port === 0) throw new InvalidArgumentError("port must be an integer from 1 to 65535");
  return port;
}
