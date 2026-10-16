import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Command, CommanderError, Option } from "commander";
import { getStateDir } from "../config/paths.js";
import { companionToken } from "../companion/store.js";
import { bindCurrentDesktop, desktopStatus, unbindDesktop } from "../desktop/service.js";
import { readDesktop } from "../desktop/store.js";
import { C2CError } from "../errors.js";
import { defaultKeyFile, readGatewayConfig, setTunnelKey, writeGatewayConfig } from "../gateway/config.js";
import { Registry } from "../gateway/registry.js";
import { gatewayStatus, runGateway, startGatewayDetached, stopGateway } from "../gateway/run.js";
import { listNotifications, recordResult, type ResultStatus } from "../results/store.js";
import { readJson } from "../util/json-file.js";
import { VERSION } from "../version.js";
import { Workspace } from "../workspace/manager.js";

const MAX_OUTPUT_FILE = 256 * 1024;

const say = (text: string): void => { process.stdout.write(`${text}\n`); };
const show = (json: boolean | undefined, value: unknown, text: string): void => say(json ? JSON.stringify(value) : text);
const wsId = (root?: string): string => new Workspace(path.resolve(root ?? process.cwd())).id;
const port = (v: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new C2CError("INVALID_PORT", "端口必须是 1-65535 的整数。");
  return n;
};

function readOutputFile(file: string): string {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(MAX_OUTPUT_FILE);
    return buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

async function pair(): Promise<{ code: string; expiresAt: number }> {
  const runtime = readJson<{ port: number; token: string } | null>(path.join(getStateDir(), "gateway", "runtime.json"), null);
  if (!runtime) throw new C2CError("GATEWAY_NOT_RUNNING", "Gateway 未运行，请先执行 c2c gateway start。");
  try {
    const res = await fetch(`http://127.0.0.1:${runtime.port}/internal/pairing`, {
      method: "POST",
      headers: { "x-c2c-runtime-token": runtime.token },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(String(res.status));
    return await res.json() as { code: string; expiresAt: number };
  } catch {
    throw new C2CError("GATEWAY_UNREACHABLE", "无法联系运行中的 Gateway，生成配对码失败。");
  }
}

function gatewayLine(s: Awaited<ReturnType<typeof gatewayStatus>>): string {
  if (!s.running) return "Gateway 未运行。";
  const children = Object.entries(s.children ?? {}).map(([name, c]) =>
    `  ${name}: ${c.state === "running" ? "运行中" : `重启中（${c.error ?? "已退出"}）`}`);
  return [`Gateway 运行中：pid ${s.pid}，端口 ${s.port}，${s.publicUrl}`, ...children].join("\n");
}

export function buildProgram(): Command {
  const program = new Command().name("c2c").description("Codex with ChatGPT").version(VERSION, "-v, --version").exitOverride();
  const wOpt = (c: Command): Command => c.option("-w, --workspace <root>", "项目根目录，缺省为当前目录");

  const gateway = program.command("gateway").description("管理本机 Gateway");
  gateway.command("configure").description("写入 Gateway 配置")
    .requiredOption("--public-url <url>").requiredOption("--port <port>", "监听端口", port)
    .requiredOption("--tunnel-name <name>").requiredOption("--tunnel-id <id>")
    .requiredOption("--cloudflared <path>").requiredOption("--tunnel-client <path>").option("--proxy <url>")
    .action((o) => {
      writeGatewayConfig({
        publicUrl: o.publicUrl, port: o.port, tunnelName: o.tunnelName, tunnelId: o.tunnelId,
        cloudflaredPath: o.cloudflared, tunnelClientPath: o.tunnelClient, proxy: o.proxy ?? null,
        keyFile: readGatewayConfig()?.keyFile ?? defaultKeyFile(),
      });
      say("已写入 Gateway 配置。");
    });
  gateway.command("set-key").description("交互式保存 tunnel runtime key（DPAPI）").action(() => { setTunnelKey(); say("已保存 tunnel key。"); });
  gateway.command("run").description("前台运行 Gateway").action(() => runGateway());
  gateway.command("start").description("后台启动 Gateway").action(async () => {
    await startGatewayDetached();
    say("Gateway 已运行。");
  });
  gateway.command("stop").description("停止 Gateway").action(async () => { say(await stopGateway() ? "Gateway 已停止。" : "Gateway 未在运行。"); });
  gateway.command("status").description("查看 Gateway 状态").option("--json").action(async (o) => {
    const s = await gatewayStatus();
    show(o.json, s, gatewayLine(s));
  });
  gateway.command("pair").description("生成 OAuth 配对码").action(async () => {
    const { code, expiresAt } = await pair();
    say(`配对码：${code}（有效至 ${new Date(expiresAt).toLocaleString()}）`);
  });

  const workspace = program.command("workspace").description("管理已登记项目");
  wOpt(workspace.command("add")).description("登记项目（已登记则跳过）").action((o) => {
    const registry = new Registry();
    const root = path.resolve(o.workspace ?? process.cwd());
    const existed = registry.list().some(e => e.workspaceId === new Workspace(root).id);
    const e = registry.add(root);
    say(existed ? `已登记过 ${e.workspaceId}（${e.name}），跳过。` : `新登记 ${e.workspaceId}（${e.name}）：${e.root}`);
  });
  workspace.command("list").description("列出已登记项目").option("--json").action((o) => {
    const list = new Registry().list();
    show(o.json, list, list.length ? list.map(e => `${e.workspaceId}\t${e.name}\t${e.root}`).join("\n") : "没有已登记的项目。");
  });
  workspace.command("remove <workspaceId>").description("移除项目登记").action((id: string) => {
    say(new Registry().remove(id) ? `已移除 ${id}。` : `未找到 ${id}。`);
  });

  const desktop = program.command("desktop").description("Codex Desktop 绑定");
  wOpt(desktop.command("bind-current")).description("绑定当前 Codex 会话").option("--json").action(async (o) => {
    const b = await bindCurrentDesktop(wsId(o.workspace));
    show(o.json, b, `已绑定会话 ${b.threadId}${b.title ? `（${b.title}）` : ""}`);
  });
  wOpt(desktop.command("status")).description("查看绑定与 Desktop 可用性").option("--json").action(async (o) => {
    const s = await desktopStatus(wsId(o.workspace));
    show(o.json, s, [
      `绑定：${s.binding ? `${s.binding.threadId}${s.binding.title ? `（${s.binding.title}）` : ""}` : "未绑定"}`,
      `Desktop：${s.available ? (s.busy ? "可用（忙碌）" : "可用（空闲）") : `不可用${s.error ? `：${s.error}` : ""}`}`,
    ].join("\n"));
  });
  wOpt(desktop.command("unbind")).description("解除绑定").action((o) => { unbindDesktop(wsId(o.workspace)); say("已解除绑定。"); });

  wOpt(program.command("record")).description("记录执行结果并生成通知")
    .requiredOption("--command-id <id>")
    .addOption(new Option("--status <status>").choices(["ok", "failed", "blocked"]).makeOptionMandatory())
    .requiredOption("--summary <text>").option("--tests <text>").option("--changed-files <a,b>")
    .option("--notes <text>").option("--output-file <path>").option("--json")
    .action((o) => {
      const { result, notification } = recordResult({
        workspaceId: wsId(o.workspace), commandId: o.commandId, status: o.status as ResultStatus, summary: o.summary,
        tests: o.tests, notes: o.notes,
        changedFiles: o.changedFiles?.split(",").map((f: string) => f.trim()).filter(Boolean),
        output: o.outputFile ? readOutputFile(o.outputFile) : undefined,
      });
      show(o.json, { ok: true, result, notification }, `已记录 ${result.commandId}（${result.status}），通知 ${notification.id}`);
    });

  program.command("companion").description("网页伴侣").command("token").description("显示伴侣 token")
    .option("--rotate", "重新生成").action((o) => say(companionToken({ rotate: o.rotate })));

  program.command("status").description("总览").option("--json").action(async (o) => {
    const gw = await gatewayStatus();
    const workspaces = new Registry().list().map(e => {
      const n = listNotifications(e.workspaceId);
      return {
        ...e, binding: readDesktop(e.workspaceId).binding,
        pending: n.filter(x => x.state === "pending").length, claimed: n.filter(x => x.state === "claimed").length,
      };
    });
    show(o.json, { gateway: gw, workspaces }, [
      gatewayLine(gw),
      ...(workspaces.length ? workspaces.map(w =>
        `${w.workspaceId}\t${w.name}\t${w.binding ? `绑定 ${w.binding.threadId}` : "未绑定"}\t待发送 ${w.pending}\t已领取 ${w.claimed}`) : ["没有已登记的项目。"]),
    ].join("\n"));
  });

  return program;
}

/** 返回退出码；错误统一输出为「错误 <code>: <message>」。 */
export async function runCli(argv: string[]): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    const code = error instanceof C2CError ? error.code : (error as { code?: string }).code ?? "ERROR";
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(argv.includes("--json") ? `${JSON.stringify({ ok: false, error: code, message })}\n` : `错误 ${code}: ${message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv);
}
