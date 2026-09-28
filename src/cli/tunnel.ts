import type { Command } from "commander";
import { Workspace } from "../workspace/manager.js";
import { findLiveBridge } from "../bridge/runtime.js";
import { stopBridge } from "../process/daemon.js";
import {
  chooseQuickTunnel,
  hasCloudflaredCert,
  ProcessCloudflaredAccount,
  provisionNamedTunnel,
} from "../tunnel/named-provision.js";
import { parseZoneInput } from "../tunnel/hostname.js";
import {
  NAMED_LOGIN_PROMPT,
  readTunnelState,
  TUNNEL_CHOICE_PROMPT,
} from "../tunnel/state.js";
import { resolveWorkspace, tunnelChoicePayload, handleCliError, say, check, cross } from "./shared.js";

export function registerTunnelCommands(program: Command): void {
const tunnelCmd = program.command("tunnel").description("Choose or inspect the public connection for this workspace");

tunnelCmd
  .command("status", { isDefault: true })
  .description("Show whether this workspace still needs a one-time connection choice")
  .option("-w, --workspace <path>")
  .option("--zone <domain>", "optional domain, used to preview the stable hostname")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; zone?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const payload = tunnelChoicePayload(workspace, opts.zone);
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      if (payload.needsChoice) say(TUNNEL_CHOICE_PROMPT);
      else if (payload.namedReady) check(`固定域名：${payload.hostname}`);
      else say("当前使用临时地址。");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

tunnelCmd
  .command("choose")
  .description("Remember quick vs named, and provision a named hostname when asked")
  .requiredOption("--mode <mode>", "quick or named")
  .option("-w, --workspace <path>")
  .option("--zone <domain>", "Cloudflare domain for a named hostname")
  .option("--hostname <hostname>", "override the default c2c-<project>.<zone>")
  .option("--require-named", "strictly require a named tunnel; never fall back to quick", false)
  .option("--json", "machine-readable output", false)
  .action(async (opts: {
    mode: string;
    workspace?: string;
    zone?: string;
    hostname?: string;
    requireNamed: boolean;
    json: boolean;
  }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const workspace = new Workspace(root);
      const mode = opts.mode.trim().toLowerCase();
      const previous = readTunnelState(workspace.id);
      if (mode === "quick") {
        if (opts.requireNamed) {
          const payload = {
            ok: false,
            fallback: false,
            error: "--require-named 只能与 --mode named 一起使用",
          };
          if (opts.json) say(JSON.stringify(payload));
          else cross(payload.error);
          return;
        }
        const state = chooseQuickTunnel(workspace.id);
        if (await findLiveBridge(workspace.id)) {
          if (previous.preference === "named" && !await stopBridge(root)) {
            throw new Error("Bridge 认证关闭失败；连接选择已保存，但运行连接尚未切换。");
          }
        }
        const payload = { ...tunnelChoicePayload(workspace), state };
        if (opts.json) say(JSON.stringify(payload));
        else check("已选用临时地址");
        return;
      }
      if (mode !== "named") {
        throw new Error("mode must be quick or named");
      }
      const zone = parseZoneInput(opts.zone ?? "");
      if (!zone) {
        const payload = {
          ok: false,
          fallback: false,
          need: "zone",
          userMessage: "请告诉我已经加在 Cloudflare 上的域名，例如 example.com",
          loginPrompt: NAMED_LOGIN_PROMPT,
        };
        if (opts.json) {
          say(JSON.stringify(payload));
          return;
        }
        say(payload.userMessage);
        return;
      }
      if (!opts.json) say(NAMED_LOGIN_PROMPT);
      const result = await provisionNamedTunnel({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        zone,
        hostname: opts.hostname,
        requireNamed: opts.requireNamed,
      });
      const payload = {
        ...tunnelChoicePayload(workspace),
        ok: result.ok,
        fallback: result.fallback,
        userMessage: result.userMessage,
        error: result.error,
        state: result.state,
      };
      const reusedNamedBinding =
        opts.requireNamed &&
        previous.preference === "named" &&
        previous.tunnelName === result.state.tunnelName &&
        previous.tunnelId === result.state.tunnelId &&
        previous.hostname === result.state.hostname;
      if (result.ok && !reusedNamedBinding && (await findLiveBridge(workspace.id)) && !await stopBridge(root)) {
        throw new Error("Bridge 认证关闭失败；固定域名配置已保存，但运行连接尚未切换。");
      }
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      if (!result.ok) {
        cross(`固定域名未就绪：${result.error ?? "命名隧道配置失败"}`);
      } else if (result.fallback) say(result.userMessage ?? "");
      else check(`固定域名已就绪：${result.state.hostname}`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

tunnelCmd
  .command("login")
  .description("Open the Cloudflare login window used by a named hostname")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { json: boolean }) => {
    try {
      if (!opts.json) say(NAMED_LOGIN_PROMPT);
      const account = new ProcessCloudflaredAccount();
      await account.login();
      const payload = { ok: true, loggedIn: hasCloudflaredCert() };
      if (opts.json) say(JSON.stringify(payload));
      else check("Cloudflare 已登录");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });
}
