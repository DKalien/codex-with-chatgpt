import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseProcessProbe, probeProcess, resolveDaemonSpawnHelperPath, resolveDaemonSpawnPython, type ProcessProbe } from "./process-probe.js";
export { resolveDaemonSpawnHelperPath, resolveDaemonSpawnPython } from "./process-probe.js";

/**
 * Detached daemon spawn with a Windows Job escape.
 *
 * Node `detached` keeps a daemon alive after the parent exits, but it does NOT
 * escape Job membership: a spawner inside a kill-on-close Job (e.g. Codex
 * wrapping its child processes) also kills the detached daemon when the app
 * closes. On win32 we delegate to the Python stdlib helper
 * (see src/process/helper/daemon_spawn.py) which first tries
 * CREATE_BREAKAWAY_FROM_JOB and falls back to a WMI relay that leaves the
 * daemon outside any caller Job and with no live parent link.
 *
 * Fail-closed fallback policy (R5f prework): a direct detached spawn inside a
 * kill-on-close Job does NOT survive the Job being closed, so it must never be
 * presented as a successfully independent daemon. The helper therefore reports
 * `in_job` (IsProcessInJob on the caller's membership); direct fallback is only
 * allowed when the caller is PROVEN not to be inside a Job (`in_job === false`),
 * or via the explicit `allowUnprovenDirectFallback` escape hatch. Otherwise a
 * failed escape throws instead of silently degrading.
 */

export type DaemonSpawnMode = "helper-breakaway" | "helper-wmi" | "posix" | "direct" | "unknown";

export interface DaemonSpawnResult {
  pid: number;
  mode: DaemonSpawnMode;
  spawnAttemptId: string;
  helperInJob: boolean | null;
  spawner: ProcessProbe;
  helper: ProcessProbe | null;
  finalProcess: ProcessProbe;
}

export interface DaemonSpawnOptions {
  cmd: string;
  args: string[];
  /** stdout/stderr 合并写入的日志文件（追加）。 */
  logFile: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pythonExecutable?: string;
  /** 测试注入：null 强制 direct，字符串替换 helper 路径。 */
  helperPath?: string | null;
  spawnImpl?: typeof spawn;
  helperTimeoutMs?: number;
  /**
   * 逃生阀（默认 false）：true 时恢复「helper 失败 → direct」历史行为。
   * 该模式不声称 lifetime independence，仅供测试/受控环境使用。
   */
  allowUnprovenDirectFallback?: boolean;
}

const DEFAULT_HELPER_TIMEOUT_MS = 45_000;

/** Legacy fixture/diagnostic hint only. Runtime/start/reclaim must use process-probe evidence. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === "EPERM"; // EPERM 表示进程存在但无权限
  }
}

// ---- R5f prework：daemon env 投影（DAEMON_ENV_SANITIZATION，E：exact allowlist）--
//
// daemon 环境交接文件落盘（0600 JSON）；把完整父 process.env 写盘会把无关
// secrets（API keys/tokens）与宿主上下文（CODEX_THREAD_ID 等）一并泄漏到磁盘。
// 这里按 EXACT allowlist 显式投影：仅 OS/runtime/path 变量 + Bridge 源码实际
// 读取的 C2C_ 配置项。任意/未来的 C2C_*（含旧 C2C_STARTUP_LEASE、test-only
// receipt-finalizer 开关、未知 secret）一律不落盘；startup lease 由 daemon.ts
// 在投影之后显式注入 fresh 值。

/** Bridge 源码实际读取的 C2C 配置（精确枚举；C2C_STARTUP_LEASE 由投影后注入，不在表内）。 */
const DAEMON_ENV_C2C_ALLOWLIST = new Set([
  "C2C_STATE_DIR",
  "C2C_LOG_LEVEL",
  "C2C_ENABLE_FEEDBACK_PROBE",
  "C2C_ENABLE_WRITE_PROBE",
  "C2C_DESKTOP_PYTHON",
  "C2C_DAEMON_PYTHON",
  "C2C_DISABLE_RG",
  "C2C_RG_PATH",
  "C2C_CLOUDFLARED_PATH",
  "C2C_CODEX_EXECUTABLE",
]);

/** Bridge 直接读取的非 C2C 业务变量。 */
const DAEMON_ENV_APP_ALLOWLIST = new Set([
  "TUNNEL_ORIGIN_CERT", // tunnel/named-provision
  "CODEX_HOME", // config/sandbox-allow
]);

/** Windows 变量名大小写不敏感，allowlist 用大写形式匹配。 */
const DAEMON_ENV_WIN32_ALLOWLIST = new Set([
  "PATH", "PATHEXT", "COMSPEC", "OS",
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "TEMP", "TMP",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "PROGRAMFILES", "PROGRAMFILES(X86)",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER",
]);

/** POSIX 变量名大小写敏感，精确匹配。 */
const DAEMON_ENV_POSIX_ALLOWLIST = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL",
  "LANG", "LC_ALL", "TZ", "TMPDIR",
]);

function isAllowedDaemonEnvKey(key: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    // Windows 变量名大小写不敏感：C2C/app/OS allowlist 均按大写匹配。
    const upper = key.toUpperCase();
    return DAEMON_ENV_WIN32_ALLOWLIST.has(upper)
      || DAEMON_ENV_APP_ALLOWLIST.has(upper)
      || DAEMON_ENV_C2C_ALLOWLIST.has(upper);
  }
  return DAEMON_ENV_POSIX_ALLOWLIST.has(key)
    || DAEMON_ENV_APP_ALLOWLIST.has(key)
    || DAEMON_ENV_C2C_ALLOWLIST.has(key)
    || key.startsWith("XDG_");
}

/**
 * 构造 daemon 环境投影：只保留 OS/runtime/path 变量、Bridge 实际读取的
 * 非 C2C 业务变量与显式 C2C 配置 allowlist。startup lease 由调用方在投影
 * 之后显式注入（daemon.ts）；旧父进程 lease 与任意未知 C2C_* 一律不投影。
 */
export function buildDaemonEnv(
  parentEnv: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const projected: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (!isAllowedDaemonEnvKey(key, platform)) continue;
    projected[key] = value;
  }
  return projected;
}

function openDaemonLog(logFile: string): number {
  const out = fs.openSync(logFile, "a", 0o600);
  try {
    // 既有文件可能由宽松 umask 创建；保持日志仅 owner 可读。
    fs.chmodSync(logFile, 0o600);
  } catch {
    // Windows / 无 chmod 语义的文件系统
  }
  return out;
}

function spawnDirect(opts: Required<Pick<DaemonSpawnOptions, "cmd" | "args" | "logFile" | "env">> & { spawnImpl: typeof spawn }): number {
  const out = openDaemonLog(opts.logFile);
  let child;
  try {
    child = opts.spawnImpl(opts.cmd, opts.args, {
      detached: true,
      stdio: ["ignore", out, out],
      env: opts.env,
      windowsHide: true,
    });
  } finally {
    fs.closeSync(out);
  }
  child.unref();
  return child.pid!;
}

function appendLogNote(logFile: string, note: string): void {
  try {
    fs.appendFileSync(logFile, `[daemon-spawn] ${note}\n`);
  } catch {
    // 日志不可写时静默；spawn 仍需继续
  }
}

interface HelperOutcome {
  ok: boolean;
  pid?: number;
  mode?: string;
  message?: string;
  /** caller（helper 进程）是否在 Windows Job 内；缺省/null = 无法安全判定。 */
  in_job?: boolean | null;
  spawner_probe?: unknown;
  helper_probe?: unknown;
  final_probe?: unknown;
}

function runHelper(opts: DaemonSpawnOptions, python: string, helperPath: string, envFile: string): Promise<HelperOutcome> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const finish = (outcome: HelperOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const child = (opts.spawnImpl ?? spawn)(python, [
      "-I", "-B", "-X", "utf8", helperPath,
      "--log", opts.logFile,
      "--env-file", envFile,
      "--cwd", process.cwd(),
      "--",
      opts.cmd, ...opts.args,
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* best effort */ }
      finish({ ok: false, message: "helper 超时" });
    }, opts.helperTimeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.once("error", (error) => finish({ ok: false, message: `helper 启动失败：${error.message}` }));
    // close follows drained stdio; provenance is larger than the old PID-only reply.
    child.once("close", () => {
      const line = stdout.split("\n").map((entry) => entry.trim()).filter(Boolean).pop();
      if (!line) {
        finish({ ok: false, message: "helper 无 JSON 输出" });
        return;
      }
      try {
        finish(JSON.parse(line) as HelperOutcome);
      } catch {
        finish({ ok: false, message: "helper 输出不是有效 JSON" });
      }
    });
  });
}

export async function spawnDetachedDaemon(opts: DaemonSpawnOptions): Promise<DaemonSpawnResult> {
  const spawnAttemptId = randomUUID();
  const python = opts.pythonExecutable ?? resolveDaemonSpawnPython();
  const probeHelper = resolveDaemonSpawnHelperPath();
  const direct = async (helperInJob: boolean | null = null): Promise<DaemonSpawnResult> => {
    const spawner = await probeProcess(process.pid, python, probeHelper);
    const pid = spawnDirect({ cmd: opts.cmd, args: opts.args, logFile: opts.logFile, env: opts.env, spawnImpl: opts.spawnImpl ?? spawn });
    return { pid, mode: (opts.platform ?? process.platform) === "win32" ? "direct" : "posix",
      spawnAttemptId, spawner, helper: null, helperInJob,
      finalProcess: await probeProcess(pid, python, probeHelper) };
  };
  const allowUnproven = opts.allowUnprovenDirectFallback === true;

  if ((opts.platform ?? process.platform) !== "win32") return direct();
  const helperPath = opts.helperPath !== undefined ? opts.helperPath : resolveDaemonSpawnHelperPath();
  if (opts.helperPath === null || !helperPath || !fs.existsSync(helperPath)) {
    if (allowUnproven) {
      appendLogNote(opts.logFile, "helper 不可用，回退 direct detached spawn（allowUnprovenDirectFallback，不声称 lifetime independence）");
      return direct();
    }
    // fail closed：无法运行 escape helper，也就无法证明 direct detached 能在
    // kill-on-close Job 下独立存活；不得静默降级为注定被杀死的 daemon。
    throw new Error(
      "daemon spawn helper 不可用，且无法证明本进程不在 kill-on-close Job 内；拒绝无独立性的 direct fallback。",
    );
  }

  // daemon env 经 buildDaemonEnv 精确 allowlist 投影（startup lease 由 daemon.ts
  // 在投影后注入）；helper/relay 不继承调用方 shell env，投影结果经 0600 JSON
  // 文件交接，读后即删。
  const envFile = path.join(os.tmpdir(), `c2c-daemon-env-${randomUUID()}.json`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(envFile, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(opts.env));
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  try {
    const outcome = await runHelper(opts, python, helperPath, envFile);
    if (outcome.ok && Number.isSafeInteger(outcome.pid) && outcome.pid! > 0) {
      const mode: DaemonSpawnMode = outcome.mode === "breakaway" ? "helper-breakaway"
        : outcome.mode === "wmi" ? "helper-wmi"
        : outcome.mode === "posix" ? "posix" : "unknown";
      const helperPid = (outcome.helper_probe as { pid?: unknown } | undefined)?.pid;
      return { pid: outcome.pid!, mode, spawnAttemptId,
        helperInJob: typeof outcome.in_job === "boolean" ? outcome.in_job : null,
        spawner: parseProcessProbe(outcome.spawner_probe, process.pid),
        helper: typeof helperPid === "number" && Number.isSafeInteger(helperPid) && helperPid > 0
          ? parseProcessProbe(outcome.helper_probe, helperPid) : null,
        finalProcess: parseProcessProbe(outcome.final_probe, outcome.pid!) };
    }
    // helper 失败：仅当 caller 被证明不在 Job 内（in_job === false）或显式
    // allowUnprovenDirectFallback 时才允许 direct fallback；其余 fail closed。
    if (allowUnproven || outcome.in_job === false) {
      const why = allowUnproven ? "allowUnprovenDirectFallback" : "caller 已证明不在 Job 内（in_job=false）";
      appendLogNote(opts.logFile, `helper spawn 失败（${outcome.message ?? "未知原因"}），${why}，回退 direct detached spawn`);
      return direct(typeof outcome.in_job === "boolean" ? outcome.in_job : null);
    }
    throw new Error(
      `daemon spawn helper 逃生失败且无法证明 direct fallback 可独立存活`
        + `（in_job=${outcome.in_job === undefined || outcome.in_job === null ? "unknown" : outcome.in_job}）：`
        + `${outcome.message ?? "未知原因"}`,
    );
  } finally {
    try { fs.rmSync(envFile, { force: true }); } catch { /* best effort */ }
  }
}
