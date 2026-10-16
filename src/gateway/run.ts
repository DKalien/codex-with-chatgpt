import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { randomBytes } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { ensureDir, getStateDir } from "../config/paths.js";
import { C2CError } from "../errors.js";
import { redact } from "../logger/index.js";
import { readJson, writeJson } from "../util/json-file.js";
import { powershellPath, readGatewayConfig, readTunnelKey, type GatewayConfig } from "./config.js";
type StartServer = typeof import("./server.js").startGatewayServer;

export interface ChildStatus { state: "running" | "restarting"; since: string; error?: string }
interface Runtime { pid: number; port: number; token: string; publicUrl: string; startedAt: string; children?: Record<string, ChildStatus> }

export interface RunDeps {
  spawn?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => ChildProcess;
  startServer?: StartServer;
  readKey?: (keyFile: string) => string;
}

const MIN_DELAY_MS = 2_000;
const MAX_DELAY_MS = 60_000;
const HEALTHY_MS = 60_000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const STOP_WAIT_MS = 3_000;
const KEY_ENV = "C2C_TUNNEL_RUNTIME_KEY";

const runtimeFile = (): string => path.join(getStateDir(), "gateway", "runtime.json");
const readRuntime = (): Runtime | null => readJson<Runtime | null>(runtimeFile(), null);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 子进程可执行文件缺失时直接报错，不进入无限重启。 */
function assertExecutables(config: GatewayConfig): void {
  for (const [name, exe] of [["cloudflared", config.cloudflaredPath], ["tunnel-client", config.tunnelClientPath]] as const) {
    if (!fs.existsSync(exe)) throw new C2CError("GATEWAY_EXE_MISSING", `${name} 不存在：${exe}；请修正 gateway configure 中的路径。`);
  }
}

function tunnelClientArgs(config: GatewayConfig): string[] {
  const args = [
    "run",
    "--control-plane.tunnel-id", config.tunnelId,
    "--control-plane.api-key", `env:${KEY_ENV}`,
    "--mcp.server-url", new URL("/mcp", config.publicUrl).toString(),
    "--mcp.oauth-trusted-origin", config.publicUrl,
    "--harpoon.hosts-include-regex", `^${escapeRegex(new URL(config.publicUrl).hostname)}$`,
    "--harpoon.hosts-include-loopback=false",
    "--harpoon.hosts-include-private=false",
    "--harpoon.allow-plaintext-http=false",
    "--mcp.startup-wait-timeout", "30s",
    "--health.listen-addr", "127.0.0.1:0",
    "--log.format", "json",
  ];
  if (config.proxy) args.push("--control-plane.http-proxy", config.proxy);
  return args;
}

export async function runGateway(deps: RunDeps = {}): Promise<void> {
  // 以 health 检查为准：崩溃遗留的 runtime.json 即使 pid 被复用也直接覆盖
  const existing = await gatewayStatus();
  if (existing.running) throw new C2CError("GATEWAY_RUNNING", `Gateway 已在运行（pid ${existing.pid}）。`);
  const config = readGatewayConfig();
  if (!config) throw new C2CError("GATEWAY_NOT_CONFIGURED", "尚未配置 Gateway，请先运行 gateway configure。");
  if (!deps.spawn) assertExecutables(config);
  const key = (deps.readKey ?? readTunnelKey)(config.keyFile);
  const spawnChild = deps.spawn ?? ((command, args, options) =>
    spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }));

  const logFile = path.join(ensureDir(path.join(getStateDir(), "logs")), "gateway.log");
  try {
    if (fs.statSync(logFile).size > MAX_LOG_BYTES) fs.renameSync(logFile, `${logFile}.1`);
  } catch { /* 日志文件不存在或无法轮转 */ }
  const log = (text: string): void => {
    try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`, { mode: 0o600 }); } catch { /* 日志失败不影响运行 */ }
  };

  let stopping = false;
  const timers = new Set<NodeJS.Timeout>();
  const children = new Set<ChildProcess>();
  let runtime: Runtime | undefined;
  const setChild = (name: string, state: ChildStatus["state"], error?: string): void => {
    if (!runtime || stopping) return;
    runtime.children = { ...runtime.children, [name]: { state, since: new Date().toISOString(), ...(error ? { error } : {}) } };
    try { writeJson(runtimeFile(), runtime); } catch { /* 状态写入失败不影响运行 */ }
  };

  const supervise = (name: string, command: string, args: string[], env: NodeJS.ProcessEnv): void => {
    let delay = MIN_DELAY_MS;
    const start = (): void => {
      const startedAt = Date.now();
      let child: ChildProcess;
      try {
        child = spawnChild(command, args, { env });
      } catch (error) {
        log(`[${name}] 启动失败：${(error as Error).message}`);
        setChild(name, "restarting", (error as Error).message);
        return retry(startedAt);
      }
      children.add(child);
      setChild(name, "running");
      for (const stream of [child.stdout, child.stderr]) {
        if (stream) readline.createInterface({ input: stream }).on("line", line => log(`[${name}] ${redact(line)}`));
      }
      let ended = false;
      const onEnd = (detail: string): void => {
        if (ended) return;
        ended = true;
        children.delete(child);
        log(`[${name}] ${detail}`);
        setChild(name, "restarting", detail);
        retry(startedAt);
      };
      child.on("error", error => onEnd(`进程错误：${error.message}`));
      child.on("exit", (code, signal) => onEnd(`已退出（code=${code}, signal=${signal}）`));
    };
    const retry = (startedAt: number): void => {
      if (stopping) return;
      if (Date.now() - startedAt >= HEALTHY_MS) delay = MIN_DELAY_MS;
      const timer = setTimeout(() => { timers.delete(timer); start(); }, delay);
      timers.add(timer);
      log(`[${name}] ${delay / 1000}s 后重启`);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    };
    start();
  };

  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  let server: Awaited<ReturnType<StartServer>> | undefined;
  const onSignal = (): void => { void shutdown(); };
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    const exited = [...children].map(child => new Promise<void>(resolve => { child.once("exit", () => resolve()); }));
    for (const child of children) child.kill();
    let waitTimer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(exited), new Promise<void>(resolve => { waitTimer = setTimeout(resolve, STOP_WAIT_MS); })]);
    clearTimeout(waitTimer);
    try { await server?.close(); } catch (error) { log(`关闭服务失败：${(error as Error).message}`); }
    fs.rmSync(runtimeFile(), { force: true });
    log("Gateway 已停止");
    finish();
  };

  const token = randomBytes(32).toString("hex");
  // 动态导入：server 模块较重，且让单测不必加载它
  const startServer = deps.startServer ?? (await import("./server.js")).startGatewayServer;
  server = await startServer({
    port: config.port,
    publicUrl: config.publicUrl,
    runtimeToken: token,
    onShutdown: () => { void shutdown(); },
  });
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  runtime = { pid: process.pid, port: server.port, token, publicUrl: config.publicUrl, startedAt: new Date().toISOString() };
  writeJson(runtimeFile(), runtime);
  log(`Gateway 已启动：127.0.0.1:${server.port}（配对码请运行 gateway pair 获取，不写入日志）`);

  supervise("cloudflared", config.cloudflaredPath,
    ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${server.port}`, "run", config.tunnelName], process.env);
  // tunnel-client 启动时会探测公网 /mcp；先等 cloudflared 让公网地址可达，避免首轮探测失败
  if (!deps.spawn) await waitPublicReachable(config.publicUrl, () => stopping, log);
  if (!stopping) supervise("tunnel-client", config.tunnelClientPath, tunnelClientArgs(config), { ...process.env, [KEY_ENV]: key });

  await finished;
}

const PUBLIC_WAIT_MS = 30_000;

async function waitPublicReachable(publicUrl: string, stopped: () => boolean, log: (text: string) => void): Promise<void> {
  const url = new URL("/.well-known/oauth-protected-resource", publicUrl);
  const deadline = Date.now() + PUBLIC_WAIT_MS;
  while (!stopped() && Date.now() < deadline) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(5_000) })).ok) return;
    } catch { /* cloudflared 尚未就绪 */ }
    await sleep(1_000);
  }
  if (!stopped()) log(`[tunnel-client] ${PUBLIC_WAIT_MS / 1000}s 内公网地址不可达，仍然启动`);
}

export async function gatewayStatus(): Promise<{ running: boolean; pid?: number; port?: number; publicUrl?: string; children?: Record<string, ChildStatus> }> {
  const runtime = readRuntime();
  if (!runtime) return { running: false };
  try {
    const res = await fetch(`http://127.0.0.1:${runtime.port}/internal/health`, {
      headers: { "x-c2c-runtime-token": runtime.token },
      signal: AbortSignal.timeout(1_000),
    });
    if (res.ok) return { running: true, pid: runtime.pid, port: runtime.port, publicUrl: runtime.publicUrl, children: runtime.children ?? {} };
  } catch { /* 视为未运行 */ }
  return { running: false };
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const FORWARDED_ENV = /^(C2C_|(HTTPS?|ALL|NO)_PROXY$)/i;

/** 带上 C2C_* 与代理环境变量；没有需要转发的变量时直接用原命令行。 */
export function windowsCommandLine(argv: string[], env: NodeJS.ProcessEnv): string {
  const command = argv.map(a => `"${a}"`).join(" ");
  const sets = Object.entries(env).filter(([k, v]) => FORWARDED_ENV.test(k) && v).map(([k, v]) => `set "${k}=${v}" && `);
  return sets.length ? `cmd.exe /d /s /c "${sets.join("")}${command}"` : command;
}

export async function startGatewayDetached(): Promise<void> {
  if ((await gatewayStatus()).running) return;
  const config = readGatewayConfig();
  if (!config) throw new C2CError("GATEWAY_NOT_CONFIGURED", "尚未配置 Gateway，请先运行 gateway configure。");
  assertExecutables(config); // 后台进程的报错看不到，先在前台检查
  const argv = [process.execPath, process.argv[1] ?? "", "gateway", "run"];
  if (process.platform === "win32") {
    // 经 WMI 创建进程，脱离调用方 Job object；WMI 子进程不继承调用方环境，需经 cmd 显式带上。
    const quote = (s: string): string => `'${s.replace(/'/g, "''")}'`;
    const commandLine = windowsCommandLine(argv, process.env);
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${quote(commandLine)}; ProcessStartupInformation = $si }`,
      "if ($r.ReturnValue -ne 0) { exit 1 }",
    ].join("\n");
    try {
      execFileSync(powershellPath(), ["-NoLogo", "-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { stdio: "ignore", windowsHide: true, timeout: 30_000 });
    } catch {
      throw new C2CError("GATEWAY_START_FAILED", "无法在后台创建 Gateway 进程。");
    }
  } else {
    spawn(argv[0]!, argv.slice(1), { detached: true, stdio: "ignore" }).unref();
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if ((await gatewayStatus()).running) return;
    await sleep(250);
  }
  throw new C2CError("GATEWAY_START_TIMEOUT", "Gateway 未能在 15 秒内就绪，请查看 logs/gateway.log。");
}

/** 返回是否确实停止了一个运行中的 Gateway。 */
export async function stopGateway(): Promise<boolean> {
  const runtime = readRuntime();
  if (!runtime) return false;
  try {
    await fetch(`http://127.0.0.1:${runtime.port}/internal/shutdown`, {
      method: "POST",
      headers: { "x-c2c-runtime-token": runtime.token },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    if ((await gatewayStatus()).running) throw new C2CError("GATEWAY_STOP_FAILED", "无法联系运行中的 Gateway，未强制结束进程。");
    fs.rmSync(runtimeFile(), { force: true }); // health 不通：视为遗留文件，清理
    return false;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!fs.existsSync(runtimeFile())) return true;
    await sleep(100);
  }
  throw new C2CError("GATEWAY_STOP_TIMEOUT", "Gateway 未在 10 秒内停止。");
}
