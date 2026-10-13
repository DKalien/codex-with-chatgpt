import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncReturns } from "node:child_process";
import { pathToFileURL } from "node:url";
import { getStateDir, readJsonIfExists } from "../config/paths.js";
import { getRuntimeBuildId } from "../build-id.js";
import { isProcessProvenMissing, probeProcess, processProbeSchema, type ProcessProbe } from "../process/process-probe.js";
import { buildDaemonEnv, resolveDaemonSpawnHelperPath, resolveDaemonSpawnPython } from "../process/daemon-spawn.js";
import { startGatewayServer, type GatewayServer } from "../remote/server.js";
import { assertMaintenanceHandle, MaintenanceBusyError, releaseMaintenanceOrThrow, tryAcquireMaintenanceLock, withMaintenanceLock, type MaintenanceLockHandle } from "../core/maintenance-lock.js";
import { z } from "zod";
import { writeGatewayTunnelIngress } from "./tunnel-ingress.js";

const BUILD_ID = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GATEWAY_LAUNCH_FILE = /^supervisor\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.launch\.json$/;
const TUNNEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TUNNEL_ID = /^tunnel_[A-Za-z0-9_-]{8,128}$/;
const ABSOLUTE_PATH = (value: string): boolean => path.isAbsolute(value) && path.normalize(value) === value;
const GATEWAY_OAUTH_DISCOVERY_TIMEOUT_MS = 30_000;
const GATEWAY_OAUTH_DISCOVERY_REQUEST_TIMEOUT_MS = 5_000;
const GATEWAY_OAUTH_DISCOVERY_RETRY_MS = 250;

function noCredentials(value: string): boolean {
  try {
    const url = new URL(value);
    return !url.username && !url.password;
  } catch {
    return false;
  }
}

const publicUrlSchema = z.string().min(1).max(2048).superRefine((value, ctx) => {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "publicUrl must be an HTTPS origin without credentials" });
    }
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "publicUrl must be an HTTPS origin" });
  }
});

const proxySchema = z.string().max(2048).nullable().superRefine((value, ctx) => {
  if (value === null) return;
  try {
    const url = new URL(value);
    if (!(url.protocol === "http:" || url.protocol === "https:") || !url.hostname || !noCredentials(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "proxy must be an HTTP(S) URL without credentials" });
    }
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "proxy must be an HTTP(S) URL" });
  }
});

const absolutePathSchema = z.string().min(1).max(32768).refine(ABSOLUTE_PATH, "path must be absolute and normalized");
const portSchema = z.number().int().min(1).max(65535);
const creationTimeSchema = z.string().regex(/^[a-zA-Z0-9:-]{1,128}$/);

/** Machine-owned identity for the one Gateway tunnel. It intentionally has no workspaceId. */
export const gatewayTunnelIdentitySchema = z.object({
  scope: z.literal("machine"),
  tunnelName: z.string().regex(TUNNEL_NAME),
  tunnelId: z.string().regex(TUNNEL_ID),
}).strict();
export type GatewayTunnelIdentity = z.infer<typeof gatewayTunnelIdentitySchema>;

/**
 * The Gateway config is machine scoped. Workspace supervisor fields are not
 * accepted here, so a Bridge tunnel record cannot be passed through by shape.
 */
export const gatewaySupervisorConfigSchema = z.object({
  version: z.literal(1),
  scope: z.literal("machine"),
  unified: z.boolean().optional(),
  publicUrl: publicUrlSchema,
  port: portSchema,
  tunnelName: z.string().regex(TUNNEL_NAME),
  tunnelId: z.string().regex(TUNNEL_ID),
  stableLauncher: absolutePathSchema,
  cloudflaredPath: absolutePathSchema,
  tunnelClientPath: absolutePathSchema,
  proxy: proxySchema,
  /** A DPAPI/Credential Manager reference, never the runtime key itself. */
  keyReference: z.string().min(1).max(512).refine(value => !/[\r\n]/.test(value), "keyReference must be one line"),
  /** Optional until the machine config is first written by the key helper. */
  keyFile: absolutePathSchema.optional(),
}).strict();
export type GatewaySupervisorConfig = z.infer<typeof gatewaySupervisorConfigSchema>;

/** A child has the same identity fields as the supervisor, but may expose no local port. */
const gatewaySupervisorProcessRuntimeSchema = z.object({
  pid: z.number().int().positive().max(0xffffffff),
  creationTime: creationTimeSchema,
  executable: absolutePathSchema,
  buildId: z.string().regex(BUILD_ID),
  ports: z.array(portSchema).max(16).refine(values => new Set(values).size === values.length, "ports must be unique"),
}).strict();
/** Runtime state deliberately contains only process identity, build and ports. */
export const gatewaySupervisorRuntimeSchema = gatewaySupervisorProcessRuntimeSchema.extend({
  ports: z.array(portSchema).min(1).max(16).refine(values => new Set(values).size === values.length, "ports must be unique"),
  /** Owned tunnels. Older snapshots may also contain a Gateway child. */
  children: z.array(gatewaySupervisorProcessRuntimeSchema).max(3).optional(),
}).strict().refine(value => value.ports.length > 0, "supervisor runtime must include a port");
export type GatewaySupervisorRuntime = z.infer<typeof gatewaySupervisorRuntimeSchema>;
export type GatewaySupervisorProcessRuntime = z.infer<typeof gatewaySupervisorProcessRuntimeSchema>;

/** Fixed machine launch pin; runtime ownership replaces it after durable publication. */
export const gatewaySupervisorLaunchSchema = z.object({
  version: z.literal(1),
  scope: z.literal("machine"),
  buildId: z.string().regex(BUILD_ID),
  nonce: z.string().regex(UUID),
  launcherPath: absolutePathSchema,
  createdAt: z.string().refine(value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value),
}).strict();
export type GatewaySupervisorLaunch = z.infer<typeof gatewaySupervisorLaunchSchema>;

export const gatewaySupervisorLaunchFileIdentitySchema = z.object({
  dev: z.number().nonnegative(), ino: z.number().nonnegative(),
  size: z.number().int().positive().max(16 * 1024),
  mtimeMs: z.number().nonnegative(), ctimeMs: z.number().nonnegative(),
  sha256: z.string().regex(BUILD_ID),
}).strict();
const gatewayLaunchPins = new WeakMap<GatewaySupervisorLaunch, { file: string; snapshot: GatewayFileSnapshot; stateDir: string }>();

export type GatewaySupervisorErrorCode =
  | "GATEWAY_SUPERVISOR_CONFIG_CORRUPT"
  | "GATEWAY_SUPERVISOR_RUNTIME_CORRUPT"
  | "GATEWAY_SUPERVISOR_KEY_STORAGE_UNAVAILABLE"
  | "GATEWAY_SUPERVISOR_KEY_MISSING"
  | "GATEWAY_SUPERVISOR_KEY_HELPER_FAILED"
  | "GATEWAY_TUNNEL_IDENTITY_MISMATCH"
  | "GATEWAY_SUPERVISOR_BUSY"
  | "GATEWAY_SUPERVISOR_IDENTITY_UNAVAILABLE"
  | "GATEWAY_SUPERVISOR_UNSUPPORTED_PLATFORM"
  | "GATEWAY_SUPERVISOR_RUN_FAILED"
  | "GATEWAY_SUPERVISOR_LAUNCH_INVALID"
  | "GATEWAY_SUPERVISOR_OWNERSHIP_LOST";

export class GatewaySupervisorError extends Error {
  constructor(readonly code: GatewaySupervisorErrorCode, message: string) {
    super(message);
    this.name = "GatewaySupervisorError";
  }
}

function supervisorDir(stateDir = getStateDir()): string {
  return path.join(path.resolve(stateDir), "gateway");
}

function writeAtomicJson(file: string, value: unknown): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* Windows ACLs are managed by the installed state owner. */ }
  const temporary = `${file}.${randomUUID()}.tmp`;
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, payload);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows. */ }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

export function gatewaySupervisorConfigFile(stateDir = getStateDir()): string {
  return path.join(supervisorDir(stateDir), "supervisor.json");
}

export function gatewaySupervisorRuntimeFile(stateDir = getStateDir()): string {
  return path.join(supervisorDir(stateDir), "supervisor.runtime.json");
}

export function gatewaySupervisorLaunchFile(nonce: string, stateDir = getStateDir()): string {
  if (!UUID.test(nonce)) throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_LAUNCH_INVALID", "Gateway launch nonce 格式无效。 ");
  return path.join(supervisorDir(stateDir), `supervisor.${nonce}.launch.json`);
}

export function gatewaySupervisorKeyFile(stateDir = getStateDir()): string {
  return path.join(supervisorDir(stateDir), "tunnel-runtime-key.dpapi");
}

function gatewaySupervisorKeyReference(keyFile: string): string {
  return `dpapi-file:${pathToFileURL(keyFile).href}`;
}

function readStrict<T>(file: string, schema: z.ZodType<T>, code: GatewaySupervisorErrorCode): T | null {
  if (!fs.existsSync(file)) return null;
  const raw = readJsonIfExists<unknown>(file);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new GatewaySupervisorError(code, `${path.basename(file)} schema 无效，保留原文件供人工核对。`);
  return parsed.data;
}

export function readGatewaySupervisorConfig(stateDir = getStateDir()): GatewaySupervisorConfig | null {
  return readStrict(gatewaySupervisorConfigFile(stateDir), gatewaySupervisorConfigSchema, "GATEWAY_SUPERVISOR_CONFIG_CORRUPT");
}

export function readGatewaySupervisorRuntime(stateDir = getStateDir()): GatewaySupervisorRuntime | null {
  return readStrict(gatewaySupervisorRuntimeFile(stateDir), gatewaySupervisorRuntimeSchema, "GATEWAY_SUPERVISOR_RUNTIME_CORRUPT");
}

export function writeGatewaySupervisorConfig(value: unknown, stateDir = getStateDir()): GatewaySupervisorConfig {
  const config = gatewaySupervisorConfigSchema.parse(value);
  writeAtomicJson(gatewaySupervisorConfigFile(stateDir), config);
  return config;
}

export interface GatewaySupervisorConfigureOptions {
  stateDir?: string;
  unified?: boolean;
  publicUrl: string;
  port: number;
  tunnelName: string;
  tunnelId: string;
  stableLauncher: string;
  cloudflaredPath: string;
  tunnelClientPath: string;
  proxy?: string | null;
  /** Test seam; production defaults to the machine supervisor DPAPI file. */
  keyFile?: string;
}

function normalizeGatewayConfigPath(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_CONFIG_CORRUPT", `${label} path 不能为空。`);
  }
  return path.normalize(path.resolve(value));
}

/**
 * Create or replace the machine Gateway config without accepting a plaintext
 * key. A live runtime or lock is treated as owned state and blocks reconfigure.
 */
export function configureGatewaySupervisor(options: GatewaySupervisorConfigureOptions): GatewaySupervisorConfig {
  const stateDir = path.resolve(options.stateDir ?? getStateDir());
  ensureGatewayDirectory(stateDir);
  return withMaintenanceLock("gateway-configure", () => {
    assertGatewayInactive(stateDir);
    const existing = readGatewaySupervisorConfig(stateDir);
    const keyFile = normalizeGatewayConfigPath(options.keyFile ?? existing?.keyFile ?? gatewaySupervisorKeyFile(stateDir), "keyFile");
    if (existing && (options.unified === true || existing.unified === true) &&
        (new URL(existing.publicUrl).origin !== new URL(options.publicUrl).origin ||
         existing.tunnelName !== options.tunnelName || existing.tunnelId !== options.tunnelId)) {
      throw new GatewaySupervisorError("GATEWAY_TUNNEL_IDENTITY_MISMATCH", "共享模式配置必须保留现有 Gateway hostname 与 Tunnel identity。");
    }
    const candidate = {
      ...(options.unified !== undefined || existing?.unified !== undefined ? { unified: options.unified ?? existing?.unified } : {}),
      version: 1 as const,
      scope: "machine" as const,
      publicUrl: options.publicUrl,
      port: options.port,
      tunnelName: options.tunnelName,
      tunnelId: options.tunnelId,
      stableLauncher: normalizeGatewayConfigPath(options.stableLauncher, "stableLauncher"),
      cloudflaredPath: normalizeGatewayConfigPath(options.cloudflaredPath, "cloudflaredPath"),
      tunnelClientPath: normalizeGatewayConfigPath(options.tunnelClientPath, "tunnelClientPath"),
      proxy: options.proxy ?? null,
      keyFile,
      keyReference: existing && keyFile === existing.keyFile ? existing.keyReference : gatewaySupervisorKeyReference(keyFile),
    };
    return writeGatewaySupervisorConfig(candidate, stateDir);
  }, stateDir);
}

export function writeGatewaySupervisorRuntime(value: unknown, stateDir = getStateDir()): GatewaySupervisorRuntime {
  const runtime = gatewaySupervisorRuntimeSchema.parse(value);
  writeAtomicJson(gatewaySupervisorRuntimeFile(stateDir), runtime);
  return runtime;
}

export function gatewayTunnelIdentity(config: GatewaySupervisorConfig): GatewayTunnelIdentity {
  return gatewayTunnelIdentitySchema.parse({ scope: config.scope, tunnelName: config.tunnelName, tunnelId: config.tunnelId });
}

/** Reject a workspace-bound Bridge tunnel identity at the Gateway boundary. */
export function assertGatewayTunnelIdentity(value: unknown): GatewayTunnelIdentity {
  const parsed = gatewayTunnelIdentitySchema.safeParse(value);
  if (!parsed.success) {
    throw new GatewaySupervisorError("GATEWAY_TUNNEL_IDENTITY_MISMATCH", "Gateway tunnel 必须是 machine scope，不能复用 workspace Bridge tunnel identity。");
  }
  return parsed.data;
}

export interface GatewaySupervisorStatus {
  ok: boolean;
  config: GatewaySupervisorConfig | null;
  runtime: GatewaySupervisorRuntime | null;
  problems: string[];
}

/** Read-only status. It never starts a process, registers a task, or repairs state. */
export function readGatewaySupervisorStatus(stateDir = getStateDir()): GatewaySupervisorStatus {
  const config = readGatewaySupervisorConfig(stateDir);
  const runtime = readGatewaySupervisorRuntime(stateDir);
  const problems: string[] = [];
  if (!config) problems.push("gateway supervisor config missing");
  if (!runtime) problems.push("gateway supervisor runtime missing");
  if (config && runtime && !runtime.ports.includes(config.port)) {
    problems.push("runtime ports do not include the configured Gateway port");
  }
  return { ok: problems.length === 0, config, runtime, problems };
}

export function validateGatewaySupervisor(stateDir = getStateDir()): GatewaySupervisorStatus {
  const status = readGatewaySupervisorStatus(stateDir);
  if (status.config) assertGatewayTunnelIdentity(gatewayTunnelIdentity(status.config));
  return status;
}

const DPAPI_BEGIN = "C2C_DPAPI_BEGIN";
const DPAPI_END = "C2C_DPAPI_END";
const MAX_KEY_CIPHERTEXT_BYTES = 16 * 1024;

const SET_KEY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$secure = Read-Host -AsSecureString -Prompt 'Gateway tunnel runtime key'
$cipher = ConvertFrom-SecureString -SecureString $secure
[Console]::Out.WriteLine('${DPAPI_BEGIN}')
[Console]::Out.WriteLine($cipher)
[Console]::Out.WriteLine('${DPAPI_END}')
`;

const READ_KEY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$cipher = [Console]::In.ReadToEnd().Trim()
$secure = ConvertTo-SecureString -String $cipher
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  [Console]::Out.WriteLine('${DPAPI_BEGIN}')
  [Console]::Out.WriteLine([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr))
  [Console]::Out.WriteLine('${DPAPI_END}')
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}
`;

export interface GatewayKeyHelperOptions {
  stateDir?: string;
  /** Test seam; production uses the machine-scoped default key file. */
  keyFile?: string;
  /** Test seam; production requires the Windows built-in PowerShell path. */
  powershellPath?: string;
  platform?: NodeJS.Platform;
  spawnSyncImpl?: (file: string, args: string[], options: Record<string, unknown>) => SpawnSyncReturns<string>;
}

export interface GatewayKeyReference {
  keyFile: string;
  keyReference: string;
}

function keyHelperFailure(message: string): never {
  throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_KEY_HELPER_FAILED", message);
}

function resolveKeyFile(options: GatewayKeyHelperOptions): string {
  const raw = options.keyFile ?? gatewaySupervisorKeyFile(options.stateDir);
  if (!path.isAbsolute(raw) || path.normalize(raw) !== raw) {
    throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_KEY_STORAGE_UNAVAILABLE", "Gateway key file path 必须是规范绝对路径。");
  }
  return raw;
}

function resolvePowerShell(options: GatewayKeyHelperOptions): string {
  if (options.powershellPath) return options.powershellPath;
  if ((options.platform ?? process.platform) !== "win32") {
    throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_KEY_STORAGE_UNAVAILABLE", "Gateway DPAPI key helper 仅支持 Windows；不会接受或写入原始 key。");
  }
  const root = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const executable = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!fs.existsSync(executable)) {
    throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_KEY_STORAGE_UNAVAILABLE", "Windows PowerShell helper 不可定位；不会写入 Gateway key。");
  }
  return executable;
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

function runPowerShell(script: string, options: GatewayKeyHelperOptions, input?: string): string {
  const executable = resolvePowerShell(options);
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const args = ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded];
  const runner = options.spawnSyncImpl ?? ((file, commandArgs, spawnOptions) =>
    spawnSync(file, commandArgs, spawnOptions as never) as SpawnSyncReturns<string>);
  let result: SpawnSyncReturns<string>;
  try {
    result = runner(executable, args, {
      // PowerShell 7's inherited PSModulePath can break Windows PowerShell DPAPI cmdlets.
      env: buildDaemonEnv(process.env),
      encoding: "utf8",
      windowsHide: input !== undefined,
      timeout: 120_000,
      maxBuffer: MAX_KEY_CIPHERTEXT_BYTES,
      stdio: input === undefined ? ["inherit", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      ...(input === undefined ? {} : { input }),
    });
  } catch {
    return keyHelperFailure("Windows DPAPI helper 启动失败；不会输出或记录 key。");
  }
  if (result.error || result.status !== 0) return keyHelperFailure("Windows DPAPI helper 执行失败；不会输出或记录 key。");
  return outputText(result.stdout);
}

function markedPayload(output: string, allowWhitespace: boolean): string {
  const lines = output.split(/\r?\n/);
  const begin = lines.indexOf(DPAPI_BEGIN);
  const end = begin < 0 ? -1 : lines.indexOf(DPAPI_END, begin + 1);
  if (begin < 0 || end <= begin + 1) return keyHelperFailure("Windows DPAPI helper 返回格式无效；不会输出或记录 key。");
  const payload = lines.slice(begin + 1, end).join("\n").trim();
  if (!payload || /[\r\n]/.test(payload) || (!allowWhitespace && /\s/.test(payload))) {
    return keyHelperFailure("Windows DPAPI helper 返回内容无效；不会输出或记录 key。");
  }
  return payload;
}

function readCiphertext(file: string): string {
  let value: string;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_KEY_CIPHERTEXT_BYTES) {
      throw new Error("invalid key file");
    }
    value = fs.readFileSync(file, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_KEY_MISSING", "Gateway DPAPI key file 不存在；不会启动 tunnel。");
    }
    throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_KEY_STORAGE_UNAVAILABLE", "Gateway DPAPI key file 不可安全读取；不会启动 tunnel。");
  }
  if (!value || !/^[A-Za-z0-9+/=_-]+$/.test(value)) {
    throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_KEY_STORAGE_UNAVAILABLE", "Gateway DPAPI key file 内容无效；不会启动 tunnel。");
  }
  return value;
}

function writeAtomicText(file: string, value: string): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* Windows ACLs are managed by the installed state owner. */ }
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, `${value}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows. */ }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

/** Store a DPAPI-protected runtime key without accepting a key argument or logging its value. */
export function setGatewayTunnelKey(options: GatewayKeyHelperOptions = {}): GatewayKeyReference {
  const stateDir = path.resolve(options.stateDir ?? getStateDir());
  resolvePowerShell(options);
  const existing = options.keyFile ? null : readGatewaySupervisorConfig(stateDir);
  if (!options.keyFile && !existing) {
    throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_CONFIG_CORRUPT", "请先执行 gateway supervisor configure，再保存 key。");
  }
  assertGatewayInactive(stateDir);
  const keyFile = resolveKeyFile({ ...options, stateDir, keyFile: options.keyFile ?? existing?.keyFile });
  if (!options.spawnSyncImpl) {
    if (!process.stdin.isTTY) throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_KEY_HELPER_FAILED", "请在交互式终端运行 gateway supervisor set-key；不从管道接收明文 key。");
    process.stderr.write("请输入 Gateway tunnel runtime key（隐藏输入，回车保存）：\n");
  }
  const output = runPowerShell(SET_KEY_SCRIPT, { ...options, stateDir });
  const ciphertext = markedPayload(output, false);
  if (!/^[A-Za-z0-9+/=_-]+$/.test(ciphertext)) {
    return keyHelperFailure("Windows DPAPI helper 返回的密文格式无效；不会写入 key。");
  }
  const keyReference = gatewaySupervisorKeyReference(keyFile);
  withMaintenanceLock("gateway-set-key", () => {
    assertGatewayInactive(stateDir);
    if (existing && JSON.stringify(readGatewaySupervisorConfig(stateDir)) !== JSON.stringify(existing)) {
      throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_BUSY", "输入期间 Gateway 配置已变化，未写入 key。");
    }
    writeAtomicText(keyFile, ciphertext);
    if (existing) writeGatewaySupervisorConfig({ ...existing, keyFile, keyReference }, stateDir);
  }, stateDir);
  return { keyFile, keyReference };
}

/** Read/decrypt only for the controlled foreground runner; no CLI output includes the plaintext. */
export function readGatewayTunnelKey(options: GatewayKeyHelperOptions = {}): string {
  const stateDir = path.resolve(options.stateDir ?? getStateDir());
  const existing = options.keyFile ? null : readGatewaySupervisorConfig(stateDir);
  const keyFile = resolveKeyFile({ ...options, stateDir, keyFile: options.keyFile ?? existing?.keyFile });
  const ciphertext = readCiphertext(keyFile);
  return markedPayload(runPowerShell(READ_KEY_SCRIPT, { ...options, stateDir }, `${ciphertext}\n`), true);
}

/** The only environment variable accepted by tunnel-client for the plaintext key. */
export const GATEWAY_TUNNEL_KEY_ENV = "C2C_TUNNEL_RUNTIME_KEY";
const GATEWAY_LAUNCH_PIN_ENV = "C2C_GATEWAY_SUPERVISOR_LAUNCH_PIN";
const GATEWAY_LAUNCH_IDENTITY_ENV = "C2C_GATEWAY_SUPERVISOR_LAUNCH_IDENTITY";

const gatewayLockSchema = z.object({
  version: z.literal(1),
  scope: z.literal("machine"),
  pid: z.number().int().positive().max(0xffffffff),
  creationTime: creationTimeSchema,
  executable: absolutePathSchema,
  buildId: z.string().regex(BUILD_ID),
  nonce: z.string().uuid(),
}).strict();
type GatewaySupervisorLock = z.infer<typeof gatewayLockSchema>;

export function gatewaySupervisorLockFile(stateDir = getStateDir()): string {
  return path.join(supervisorDir(stateDir), "supervisor.lock");
}

function assertGatewayInactive(stateDir: string): void {
  if (fs.existsSync(gatewaySupervisorRuntimeFile(stateDir)) || fs.existsSync(gatewaySupervisorLockFile(stateDir))) {
    throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_BUSY", "Gateway supervisor 正在运行或 ownership 未知，拒绝覆盖配置。 ");
  }
}

export type GatewayFileSnapshot = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  bytes: Buffer;
};

export function sameGatewayPath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.normalize(path.resolve(value));
    return process.platform === "win32" || process.platform === "darwin" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

export function ensureGatewayDirectory(stateDir: string): string {
  const root = path.resolve(stateDir);
  try { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); }
  catch { throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_RUN_FAILED", "Gateway supervisor state directory 无法创建。 "); }
  try {
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !sameGatewayPath(fs.realpathSync.native(root), root)) {
      throw new Error("non-canonical state root");
    }
    const dir = supervisorDir(root);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dirStat = fs.lstatSync(dir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || !sameGatewayPath(fs.realpathSync.native(dir), dir)) {
      throw new Error("non-canonical gateway state directory");
    }
    try { fs.chmodSync(root, 0o700); fs.chmodSync(dir, 0o700); } catch { /* Windows ACLs are managed by the installed state owner. */ }
    return dir;
  } catch (error) {
    if (error instanceof GatewaySupervisorError) throw error;
    throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_RUN_FAILED", "Gateway supervisor state directory 不是可验证的规范目录。 ");
  }
}

export function snapshotGatewayFile(file: string, allowMissing = false): GatewayFileSnapshot | null {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_OWNERSHIP_LOST", "Gateway supervisor state file 无法核验。 ");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !sameGatewayPath(fs.realpathSync.native(file), file)) {
    throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_OWNERSHIP_LOST", "Gateway supervisor state file 不是规范普通文件。 ");
  }
  if (stat.size > MAX_KEY_CIPHERTEXT_BYTES) {
    throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_RUN_FAILED", "Gateway supervisor state file 超出大小限制。 ");
  }
  const bytes = fs.readFileSync(file);
  const after = fs.lstatSync(file);
  if (stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs || bytes.length !== stat.size) {
    throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_OWNERSHIP_LOST", "Gateway supervisor state file 在读取期间发生变化。 ");
  }
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, bytes };
}

export function sameGatewaySnapshot(left: GatewayFileSnapshot | null, right: GatewayFileSnapshot | null): boolean {
  if (left === null || right === null) return left === right;
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.bytes.equals(right.bytes);
}

function readGatewaySupervisorLaunch(stateDir: string, file: string | undefined, encodedIdentity: string | undefined,
  buildId: string): GatewaySupervisorLaunch | null {
  if (file === undefined && encodedIdentity === undefined) return null;
  try {
    const folder = supervisorDir(stateDir);
    const match = file && GATEWAY_LAUNCH_FILE.exec(path.basename(file));
    if (!file || !match || !encodedIdentity || encodedIdentity.length > 1024 || path.dirname(file) !== folder || path.resolve(file) !== file)
      throw new Error("launch path or identity missing");
    const dirStat = fs.lstatSync(folder);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || fs.realpathSync.native(folder) !== folder)
      throw new Error("launch directory is not canonical");
    const launcherPath = path.join(stateDir, "bin", "c2c.js");
    const launcherStat = fs.lstatSync(launcherPath);
    if (!launcherStat.isFile() || launcherStat.isSymbolicLink() || fs.realpathSync.native(launcherPath) !== launcherPath)
      throw new Error("stable launcher is not canonical");
    const snapshot = snapshotGatewayFile(file, false)!;
    const identity = gatewaySupervisorLaunchFileIdentitySchema.parse(JSON.parse(encodedIdentity));
    if (identity.dev !== snapshot.dev || identity.ino !== snapshot.ino || identity.size !== snapshot.size ||
        identity.mtimeMs !== snapshot.mtimeMs || identity.ctimeMs !== snapshot.ctimeMs ||
        identity.sha256 !== createHash("sha256").update(snapshot.bytes).digest("hex"))
      throw new Error("launch file identity changed");
    const launch = gatewaySupervisorLaunchSchema.parse(JSON.parse(snapshot.bytes.toString("utf8")));
    if (launch.buildId !== buildId || launch.launcherPath !== launcherPath || launch.nonce !== match[1])
      throw new Error("launch build or launcher identity mismatch");
    const capability = Object.freeze(launch);
    gatewayLaunchPins.set(capability, { file, snapshot, stateDir });
    return capability;
  } catch {
    throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_LAUNCH_INVALID", "Gateway supervisor launch pin 的路径、内容或文件身份无法验证；保留 pin。 ");
  }
}

export interface GatewayLaunchReservation {
  file: string;
  identity: string;
  launch: GatewaySupervisorLaunch;
  snapshot: GatewayFileSnapshot;
}

function gatewayLaunchReservation(stateDir: string, file: string): GatewayLaunchReservation {
  const snapshot = snapshotGatewayFile(file)!;
  const { dev, ino, size, mtimeMs, ctimeMs } = snapshot;
  const identity = JSON.stringify({ dev, ino, size, mtimeMs, ctimeMs,
    sha256: createHash("sha256").update(snapshot.bytes).digest("hex") });
  let buildId: string;
  try { buildId = gatewaySupervisorLaunchSchema.parse(JSON.parse(snapshot.bytes.toString("utf8"))).buildId; }
  catch { throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_LAUNCH_INVALID", "Gateway launch pin 内容无效；保留 pin。"); }
  const launch = readGatewaySupervisorLaunch(stateDir, file, identity, buildId)!;
  return { file, identity, launch, snapshot };
}

export function listGatewaySupervisorLaunchPins(stateDir: string): GatewayLaunchReservation[] {
  const folder = ensureGatewayDirectory(stateDir);
  return fs.readdirSync(folder).filter(name => name.startsWith("supervisor.") && name.endsWith(".launch.json"))
    .map(name => gatewayLaunchReservation(stateDir, path.join(folder, name)));
}

/** 发布 durable release pin 前必须确认调用方仍持有机器 maintenance fence。 */
export function createGatewaySupervisorLaunch(buildId: string, stateDir: string, handle: MaintenanceLockHandle): GatewayLaunchReservation {
  assertMaintenanceHandle(stateDir, handle);
  ensureGatewayDirectory(stateDir);
  const launch = gatewaySupervisorLaunchSchema.parse({ version: 1, scope: "machine", buildId,
    nonce: randomUUID(), launcherPath: path.join(stateDir, "bin", "c2c.js"), createdAt: new Date().toISOString() });
  const file = gatewaySupervisorLaunchFile(launch.nonce, stateDir);
  const bytes = Buffer.from(JSON.stringify(launch), "utf8");
  const fd = fs.openSync(file, "wx", 0o600);
  let created: fs.Stats;
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); created = fs.fstatSync(fd); }
  finally { fs.closeSync(fd); }
  const reservation = gatewayLaunchReservation(stateDir, file);
  if (reservation.snapshot.dev !== created.dev || reservation.snapshot.ino !== created.ino || !reservation.snapshot.bytes.equals(bytes))
    throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_LAUNCH_INVALID", "Gateway launch pin 文件身份发生变化；保留 pin。");
  return reservation;
}

function unlinkGatewaySnapshot(file: string, expected: GatewayFileSnapshot): boolean {
  const actual = snapshotGatewayFile(file, false);
  if (!sameGatewaySnapshot(expected, actual)) return false;
  fs.unlinkSync(file);
  return true;
}

export function readGatewayLock(file: string): GatewaySupervisorLock {
  const snapshot = snapshotGatewayFile(file, false);
  try { return gatewayLockSchema.parse(JSON.parse(snapshot!.bytes.toString("utf8"))); }
  catch { throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_BUSY", "Gateway supervisor lock 内容无法确认，拒绝接管。 "); }
}

function acquireGatewayLock(stateDir: string, identity: GatewaySupervisorLock): { owner: GatewaySupervisorLock; snapshot: GatewayFileSnapshot; path: string } {
  const dir = ensureGatewayDirectory(stateDir);
  const file = gatewaySupervisorLockFile(stateDir);
  let fd: number;
  try { fd = fs.openSync(file, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // Read only for diagnostics; a present lock is never reclaimed automatically.
      try { readGatewayLock(file); } catch { /* preserve the busy outcome */ }
      throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_BUSY", "Gateway supervisor lock 已存在，拒绝并行运行。 ");
    }
    throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_RUN_FAILED", "Gateway supervisor lock 无法创建。 ");
  }
  try {
    fs.writeFileSync(fd, JSON.stringify(identity), "utf8");
    fs.fsyncSync(fd);
    try { fs.fchmodSync(fd, 0o600); } catch { /* best effort on Windows. */ }
    fs.closeSync(fd);
    const snapshot = snapshotGatewayFile(file, false);
    if (!snapshot) throw new Error("lock disappeared");
    return { owner: identity, snapshot, path: file };
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* preserve primary failure */ }
    // A partial lock is intentionally preserved. Never remove a path after a
    // failed publication because another owner may have replaced it.
    if (error instanceof GatewaySupervisorError) throw error;
    throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_RUN_FAILED", "Gateway supervisor lock 写入失败。 ");
  }
}

function releaseGatewayLock(lock: { owner: GatewaySupervisorLock; snapshot: GatewayFileSnapshot; path: string }): boolean {
  try {
    const current = readGatewayLock(lock.path);
    if (current.nonce !== lock.owner.nonce || current.pid !== lock.owner.pid ||
        current.creationTime !== lock.owner.creationTime || !sameGatewayPath(current.executable, lock.owner.executable)) return false;
    return unlinkGatewaySnapshot(lock.path, lock.snapshot);
  } catch { return false; }
}

function gatewayProbe(options: GatewaySupervisorRunOptions): (pid: number, expectedCreationTime?: string) => Promise<ProcessProbe> {
  return options.probeProcess ?? ((pid, expectedCreationTime) =>
    probeProcess(pid, resolveDaemonSpawnPython(), resolveDaemonSpawnHelperPath(), expectedCreationTime));
}

async function requireGatewayIdentity(
  pid: number,
  probe: (pid: number, expectedCreationTime?: string) => Promise<ProcessProbe>,
  expectedExecutable?: string,
): Promise<{ pid: number; creationTime: string; executable: string }> {
  let observed: ProcessProbe;
  try { observed = processProbeSchema.parse(await probe(pid)); }
  catch { throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_IDENTITY_UNAVAILABLE", "Gateway supervisor 进程身份无法验证。 "); }
  if (observed.pid !== pid || observed.status !== "identified" || !observed.creationTime || !observed.executable) {
    throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_IDENTITY_UNAVAILABLE", "Gateway supervisor 进程身份无法验证。 ");
  }
  if (expectedExecutable && path.isAbsolute(expectedExecutable) && !sameGatewayPath(observed.executable, expectedExecutable)) {
    throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_IDENTITY_UNAVAILABLE", "Gateway 子进程 executable 与预期不一致。 ");
  }
  return { pid, creationTime: observed.creationTime, executable: observed.executable };
}

function cleanGatewayEnvironment(stateDir: string, runtimeKey?: string): NodeJS.ProcessEnv {
  const env = buildDaemonEnv(process.env);
  env.C2C_STATE_DIR = path.resolve(stateDir);
  delete env[GATEWAY_TUNNEL_KEY_ENV];
  delete env[GATEWAY_LAUNCH_PIN_ENV];
  delete env[GATEWAY_LAUNCH_IDENTITY_ENV];
  if (runtimeKey !== undefined) env[GATEWAY_TUNNEL_KEY_ENV] = runtimeKey;
  return env;
}

export function gatewaySupervisorTunnelUpstream(rawConfig: GatewaySupervisorConfig): string {
  const config = gatewaySupervisorConfigSchema.parse(rawConfig);
  assertGatewayTunnelIdentity(gatewayTunnelIdentity(config));
  // The secure tunnel may only target the unified Gateway endpoint. There is
  // intentionally no workspace root, workspace id, or Bridge origin input.
  return new URL("/mcp", config.publicUrl).toString();
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface GatewaySupervisorCommand {
  kind: "cloudflared" | "tunnel-client";
  executable: string;
  args: string[];
}

export interface GatewaySupervisorCommandPlan {
  cloudflared: GatewaySupervisorCommand;
  tunnelClient: GatewaySupervisorCommand;
}

/** Build the child argv without ever including the runtime key. */
export function buildGatewaySupervisorCommandPlan(
  rawConfig: GatewaySupervisorConfig,
  options: { cloudflaredPath?: string; ingressFile?: string } = {},
): GatewaySupervisorCommandPlan {
  const config = gatewaySupervisorConfigSchema.parse(rawConfig);
  assertGatewayTunnelIdentity(gatewayTunnelIdentity(config));
  const cloudflaredPath = options.cloudflaredPath ?? config.cloudflaredPath;
  if (config.unified && (!options.ingressFile || !ABSOLUTE_PATH(options.ingressFile))) {
    throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_CONFIG_CORRUPT", "共享 Tunnel 必须使用机器 owner 管理的 ingress 配置。");
  }
  const cloudflared: GatewaySupervisorCommand = {
    kind: "cloudflared",
    executable: cloudflaredPath,
    args: config.unified
      ? ["tunnel", "--no-autoupdate", "--config", options.ingressFile!, "run", config.tunnelName]
      : ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${config.port}`, "run", config.tunnelName],
  };
  const tunnelArgs = [
    "run",
    "--control-plane.tunnel-id", config.tunnelId,
    "--control-plane.api-key", `env:${GATEWAY_TUNNEL_KEY_ENV}`,
    "--mcp.server-url", gatewaySupervisorTunnelUpstream(config),
    "--mcp.oauth-trusted-origin", config.publicUrl,
    "--harpoon.hosts-include-regex", `^${regexEscape(new URL(config.publicUrl).hostname)}$`,
    "--harpoon.hosts-include-loopback=false",
    "--harpoon.hosts-include-private=false",
    "--harpoon.allow-plaintext-http=false",
    "--mcp.startup-wait-timeout", "30s",
    "--health.listen-addr", "127.0.0.1:0",
    "--log.format", "json",
  ];
  if (config.proxy) tunnelArgs.push("--control-plane.http-proxy", config.proxy);
  const tunnelClient: GatewaySupervisorCommand = { kind: "tunnel-client", executable: config.tunnelClientPath, args: tunnelArgs };
  return { cloudflared, tunnelClient };
}

export interface GatewaySupervisorRunOptions {
  stateDir?: string;
  platform?: NodeJS.Platform;
  buildId?: string;
  cloudflaredPath?: string;
  probeProcess?: (pid: number, expectedCreationTime?: string) => Promise<ProcessProbe>;
  spawnImpl?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  /** Test seam for bounded child-stop verification. Production keeps the 5s bound. */
  childStopTimeoutMs?: number;
  /** Test seam; production reads and decrypts the machine DPAPI key in memory. */
  readKey?: (stateDir: string) => string | Promise<string>;
  /** Test seams; production uses fetch and a fixed 30-second public discovery budget. */
  oauthDiscoveryFetchImpl?: typeof fetch;
  oauthDiscoveryTimeoutMs?: number;
  /** Test seam; production owns the Gateway in this process for graceful close. */
  startGateway?: typeof startGatewayServer;
  onPairing?: (pairing: { code: string; expiresAt: number }) => void;
  signal?: AbortSignal;
}

interface GatewayOwnedChild {
  child: ChildProcess;
  identity: GatewaySupervisorProcessRuntime;
}

export interface GatewaySupervisorHandle {
  readonly runtime: GatewaySupervisorRuntime;
  readonly commands: GatewaySupervisorCommandPlan;
  stop(): Promise<boolean>;
  wait(signal?: AbortSignal): Promise<void>;
}

function childSpawnOptions(cwd: string, stateDir: string, runtimeKey?: string): SpawnOptions {
  return {
    cwd,
    env: cleanGatewayEnvironment(stateDir, runtimeKey),
    windowsHide: true,
    shell: false,
    // Tunnel output can contain credentials or pairing data. Discard it at the OS boundary.
    stdio: ["ignore", "ignore", "ignore"],
  };
}

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitChildExit(child: ChildProcess, timeoutMs = 5_000): Promise<boolean> {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (): void => {
      if (timer) clearTimeout(timer);
      child.removeListener("exit", done);
      child.removeListener("close", done);
      child.removeListener("error", done);
      resolve(childExited(child));
    };
    child.once("exit", done);
    child.once("close", done);
    child.once("error", done);
    timer = setTimeout(done, timeoutMs);
  });
}

async function stopOwnedChild(
  owned: GatewayOwnedChild,
  probe: (pid: number, expectedCreationTime?: string) => Promise<ProcessProbe>,
  timeoutMs = 5_000,
): Promise<boolean> {
  if (childExited(owned.child)) return true;
  let observed: ProcessProbe;
  try { observed = processProbeSchema.parse(await probe(owned.identity.pid, owned.identity.creationTime)); }
  catch { return false; }
  if (observed.pid === owned.identity.pid && isProcessProvenMissing(observed)) return true;
  if (observed.status !== "identified" || observed.pid !== owned.identity.pid || observed.creationTime !== owned.identity.creationTime ||
      !observed.executable || !sameGatewayPath(observed.executable, owned.identity.executable)) return false;
  try { owned.child.kill("SIGTERM"); }
  catch { return false; }
  if (await waitChildExit(owned.child, timeoutMs)) return true;
  // A timeout is ambiguous. Re-probe the same PID+creationTime and only
  // accept a native missing observation; unknown/identified stays owned.
  try {
    const after = processProbeSchema.parse(await probe(owned.identity.pid, owned.identity.creationTime));
    return after.pid === owned.identity.pid && isProcessProvenMissing(after);
  } catch { return false; }
}

async function waitForGatewayChildren(children: GatewayOwnedChild[], closed: Promise<void>, signal?: AbortSignal): Promise<"aborted" | "child-exit"> {
  if (signal?.aborted) return "aborted";
  // A child can exit between the final identity probe and this wait call.
  // Check the native ChildProcess state before installing listeners so the
  // foreground runner cannot wait forever on an already-closed handle.
  if (children.some(item => childExited(item.child))) return "child-exit";
  return new Promise(resolve => {
    let done = false;
    const finish = (reason: "aborted" | "child-exit"): void => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", onAbort);
      for (const item of children) {
        item.child.removeListener("exit", onExit);
        item.child.removeListener("close", onExit);
        item.child.removeListener("error", onExit);
      }
      resolve(reason);
    };
    const onAbort = (): void => finish("aborted");
    const onExit = (): void => finish("child-exit");
    signal?.addEventListener("abort", onAbort, { once: true });
    void closed.then(onExit);
    for (const item of children) {
      item.child.once("exit", onExit);
      item.child.once("close", onExit);
      item.child.once("error", onExit);
    }
  });
}

function isGatewayMetadataObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function gatewayDiscoveryError(message: string): GatewaySupervisorError {
  return new GatewaySupervisorError("GATEWAY_SUPERVISOR_RUN_FAILED", message);
}

async function fetchGatewayOAuthMetadata(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ ready: true; value: unknown } | { ready: false }> {
  if (signal?.aborted) throw gatewayDiscoveryError("Gateway OAuth discovery 等待已取消；未启动 tunnel-client。 ");
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      return { ready: false };
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
      await response.body?.cancel().catch(() => undefined);
      throw gatewayDiscoveryError("Gateway OAuth discovery 返回的 metadata 不是 JSON；未启动 tunnel-client。 ");
    }
    try {
      const value = await response.json();
      if (signal?.aborted) throw gatewayDiscoveryError("Gateway OAuth discovery 等待已取消；未启动 tunnel-client。 ");
      if (controller.signal.aborted) return { ready: false };
      return { ready: true, value };
    } catch {
      if (signal?.aborted) throw gatewayDiscoveryError("Gateway OAuth discovery 等待已取消；未启动 tunnel-client。 ");
      if (controller.signal.aborted) return { ready: false };
      throw gatewayDiscoveryError("Gateway OAuth discovery 返回的 metadata JSON 无效；未启动 tunnel-client。 ");
    }
  } catch (error) {
    if (error instanceof GatewaySupervisorError) throw error;
    if (signal?.aborted) throw gatewayDiscoveryError("Gateway OAuth discovery 等待已取消；未启动 tunnel-client。 ");
    return { ready: false };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function waitForGatewayDiscoveryRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      resolve();
    };
    const cancel = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      reject(gatewayDiscoveryError("Gateway OAuth discovery 等待已取消；未启动 tunnel-client。 "));
    };
    const timer = setTimeout(finish, ms);
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
  });
}

async function waitForGatewayOAuthDiscovery(
  publicUrl: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<void> {
  const origin = new URL(publicUrl).origin;
  const resourceUrl = new URL("/.well-known/oauth-protected-resource/mcp", origin).toString();
  const authorizationServerUrl = new URL("/.well-known/oauth-authorization-server", origin).toString();
  const expectedResource = `${origin}/mcp`;
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? GATEWAY_OAUTH_DISCOVERY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const timeoutError = (): GatewaySupervisorError => gatewayDiscoveryError(
    `Gateway OAuth discovery 在 ${timeoutMs / 1000} 秒内未就绪；未启动 tunnel-client。 `,
  );

  while (true) {
    if (options.signal?.aborted) throw gatewayDiscoveryError("Gateway OAuth discovery 等待已取消；未启动 tunnel-client。 ");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timeoutError();
    const resource = await fetchGatewayOAuthMetadata(fetchImpl, resourceUrl, options.signal,
      Math.min(GATEWAY_OAUTH_DISCOVERY_REQUEST_TIMEOUT_MS, remaining));
    if (resource.ready) {
      const metadata = resource.value;
      if (!isGatewayMetadataObject(metadata) || metadata.resource !== expectedResource ||
          !Array.isArray(metadata.authorization_servers) || metadata.authorization_servers.length !== 1 ||
          metadata.authorization_servers[0] !== origin) {
        throw gatewayDiscoveryError("Gateway OAuth Protected Resource Metadata 与配置 origin 不匹配；未启动 tunnel-client。 ");
      }
      const authorizationRemaining = deadline - Date.now();
      if (authorizationRemaining <= 0) throw timeoutError();
      const authorizationServer = await fetchGatewayOAuthMetadata(fetchImpl, authorizationServerUrl, options.signal,
        Math.min(GATEWAY_OAUTH_DISCOVERY_REQUEST_TIMEOUT_MS, authorizationRemaining));
      if (authorizationServer.ready) {
        if (options.signal?.aborted) throw gatewayDiscoveryError("Gateway OAuth discovery 等待已取消；未启动 tunnel-client。 ");
        if (Date.now() >= deadline) throw timeoutError();
        const asMetadata = authorizationServer.value;
        if (!isGatewayMetadataObject(asMetadata) || asMetadata.issuer !== origin ||
            asMetadata.authorization_endpoint !== `${origin}/oauth/authorize` ||
            asMetadata.token_endpoint !== `${origin}/oauth/token` ||
            asMetadata.registration_endpoint !== `${origin}/oauth/register`) {
          throw gatewayDiscoveryError("Gateway OAuth Authorization Server Metadata 与配置 origin 不匹配；未启动 tunnel-client。 ");
        }
        return;
      }
    }
    const retryIn = deadline - Date.now();
    if (retryIn <= 0) throw timeoutError();
    await waitForGatewayDiscoveryRetry(Math.min(GATEWAY_OAUTH_DISCOVERY_RETRY_MS, retryIn), options.signal);
  }
}

/** Start the owned foreground process set and publish an exact machine runtime. */
export async function startGatewaySupervisor(options: GatewaySupervisorRunOptions = {}): Promise<GatewaySupervisorHandle> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_UNSUPPORTED_PLATFORM", "Gateway supervisor runner 仅支持 Windows DPAPI。 ");
  if (options.signal?.aborted) throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_RUN_FAILED", "Gateway supervisor run 已被取消，未启动子进程。 ");
  const stateDir = path.resolve(options.stateDir ?? getStateDir());
  if (!sameGatewayPath(stateDir, getStateDir())) {
    throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_CONFIG_CORRUPT", "Gateway 与 supervisor 必须使用相同的 C2C_STATE_DIR。 ");
  }
  const buildId = options.buildId ?? getRuntimeBuildId();
  if (!buildId || !BUILD_ID.test(buildId)) throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_RUN_FAILED", "Gateway supervisor build identity 缺失或无效。 ");
  if (Object.prototype.hasOwnProperty.call(process.env, GATEWAY_TUNNEL_KEY_ENV)) {
    throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_RUN_FAILED", "检测到继承的 tunnel runtime key，拒绝启动以避免跨进程泄露。 ");
  }
  const launchFile = process.env[GATEWAY_LAUNCH_PIN_ENV];
  const launchIdentity = process.env[GATEWAY_LAUNCH_IDENTITY_ENV];
  delete process.env[GATEWAY_LAUNCH_PIN_ENV];
  delete process.env[GATEWAY_LAUNCH_IDENTITY_ENV];
  const launch = readGatewaySupervisorLaunch(stateDir, launchFile, launchIdentity, buildId);

  const maintenanceDeadline = Date.now() + 60_000;
  const startupMaintenance = async <T>(operation: string, action: (handle: MaintenanceLockHandle) => T | Promise<T>): Promise<T> => {
    while (true) {
      if (options.signal?.aborted) throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_RUN_FAILED", "Gateway startup maintenance 等待已取消；保留 launch pin。");
      try {
        const acquired = tryAcquireMaintenanceLock(stateDir, operation);
        if (!acquired.ok) throw new MaintenanceBusyError();
        let result: T | undefined;
        let actionError: unknown;
        try { result = await action(acquired.handle); }
        catch (error) { actionError = error; }
        releaseMaintenanceOrThrow(acquired.handle, { result, actionError });
        return result as T;
      }
      catch (error) {
        // 已验证的后台 launch 可等待其他 workspace 的短 fence；前台 busy 语义保持不变。
        if (!launch || !(error instanceof MaintenanceBusyError)) throw error;
        const remaining = maintenanceDeadline - Date.now();
        if (remaining <= 0) throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_BUSY", "Gateway startup maintenance 等待超时；保留 launch pin。");
        await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
      }
    }
  };

  const probe = gatewayProbe(options);
  const current = await requireGatewayIdentity(process.pid, probe);
  const owner = gatewayLockSchema.parse({ version: 1, scope: "machine", ...current, buildId, nonce: randomUUID() });
  const { config, lock } = await startupMaintenance("gateway-start", () => {
    const config = readGatewaySupervisorConfig(stateDir);
    if (!config) throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_CONFIG_CORRUPT", "先执行 gateway supervisor configure。 ");
    assertGatewayTunnelIdentity(gatewayTunnelIdentity(config));
    if (launch && !sameGatewayPath(config.stableLauncher, launch.launcherPath)) {
      throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_LAUNCH_INVALID", "Gateway launch pin 与配置的 stable launcher 不一致；保留 pin。 ");
    }
    return { config, lock: acquireGatewayLock(stateDir, owner) };
  });
  let runtimeKey = "";
  const owned: GatewayOwnedChild[] = [];
  let runtimeSnapshot: GatewayFileSnapshot | null = null;
  let childIdentityAmbiguous = false;
  let released = false;
  let gateway: GatewayServer | undefined;
  const intent = new AbortController();
  const shutdownSignal = options.signal ? AbortSignal.any([options.signal, intent.signal]) : intent.signal;
  try {
    const existingRuntime = readGatewaySupervisorRuntime(stateDir);
    if (existingRuntime) throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_BUSY", "Gateway supervisor runtime 已存在，拒绝覆盖。 ");
    runtimeKey = await (options.readKey ?? (dir => readGatewayTunnelKey({ stateDir: dir })))(stateDir);
    if (typeof runtimeKey !== "string" || !runtimeKey.trim() || /[\r\n]/.test(runtimeKey)) {
      throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_KEY_HELPER_FAILED", "Gateway runtime key 未能安全解密到内存。 ");
    }
    const ingressFile = config.unified ? await startupMaintenance("gateway-ingress", handle =>
      writeGatewayTunnelIngress(config, stateDir, handle)) : undefined;
    gateway = await (options.startGateway ?? startGatewayServer)({ port: config.port, publicUrl: config.publicUrl,
      healthIdentity: { pid: current.pid, creationTime: current.creationTime, buildId },
      onShutdown: () => intent.abort(),
      ...(config.unified ? { sharedWorkspaces: { tunnelAvailable: () =>
        Boolean(owned[0] && !childExited(owned[0].child)) } } : {}),
    });
    options.onPairing?.({ code: gateway.pairingCode, expiresAt: gateway.pairingExpiresAt });
    const commands = buildGatewaySupervisorCommandPlan(config, { cloudflaredPath: options.cloudflaredPath, ingressFile });
    const cwd = path.dirname(config.stableLauncher);
    const spawnChild = options.spawnImpl ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    const commandEntries: Array<{ command: GatewaySupervisorCommand; key?: string }> = [
      { command: commands.cloudflared },
      { command: commands.tunnelClient, key: runtimeKey },
    ];
    for (const entry of commandEntries) {
      if (shutdownSignal.aborted) throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_RUN_FAILED", "Gateway supervisor run 已被取消，未完成子进程启动。 ");
      if (entry.command.kind === "tunnel-client") {
        await waitForGatewayOAuthDiscovery(config.publicUrl, {
          signal: shutdownSignal,
          fetchImpl: options.oauthDiscoveryFetchImpl,
          timeoutMs: options.oauthDiscoveryTimeoutMs,
        });
      }
      let child: ChildProcess;
      try { child = spawnChild(entry.command.executable, entry.command.args, childSpawnOptions(cwd, stateDir, entry.key)); }
      catch { throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_RUN_FAILED", `${entry.command.kind} 子进程启动失败。 `); }
      // spawn errors arrive asynchronously, including ENOENT with no PID.
      child?.once("error", () => {});
      if (!child || !child.pid || !Number.isInteger(child.pid) || child.pid <= 0) {
        throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_IDENTITY_UNAVAILABLE", `${entry.command.kind} 子进程 PID 无法验证。 `);
      }
      let identity: { pid: number; creationTime: string; executable: string };
      try {
        identity = await requireGatewayIdentity(child.pid, probe, path.isAbsolute(entry.command.executable) ? entry.command.executable : undefined);
      } catch (error) {
        childIdentityAmbiguous = true;
        throw error;
      }
      owned.push({ child, identity: {
        ...identity,
        buildId,
        ports: [],
      } });
    }
    runtimeKey = "";
    const runtime = gatewaySupervisorRuntimeSchema.parse({
      ...current,
      buildId,
      ports: [config.port],
      children: owned.map(item => item.identity),
    });
    runtimeSnapshot = await startupMaintenance("gateway-start-handoff", () => {
      if (owned.some(item => childExited(item.child))) throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_RUN_FAILED", "Gateway 子进程在 startup maintenance 等待期间退出；保留 launch pin。");
      writeGatewaySupervisorRuntime(runtime, stateDir);
      const published = snapshotGatewayFile(gatewaySupervisorRuntimeFile(stateDir), false);
      if (!published) throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_RUN_FAILED", "Gateway supervisor runtime 发布失败。 ");
      runtimeSnapshot = published;
      if (launch) {
        const pin = gatewayLaunchPins.get(launch);
        const currentLock = readGatewayLock(lock.path);
        if (!pin || pin.stateDir !== stateDir || launch.buildId !== runtime.buildId ||
            !sameGatewayPath(launch.launcherPath, config.stableLauncher) ||
            currentLock.nonce !== lock.owner.nonce || currentLock.pid !== lock.owner.pid ||
            currentLock.creationTime !== lock.owner.creationTime || !sameGatewayPath(currentLock.executable, lock.owner.executable) ||
            !sameGatewaySnapshot(lock.snapshot, snapshotGatewayFile(lock.path, false)) ||
            !sameGatewaySnapshot(published, snapshotGatewayFile(gatewaySupervisorRuntimeFile(stateDir), false))) {
          throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_OWNERSHIP_LOST", "Gateway runtime handoff ownership 无法确认；保留 launch pin。 ");
        }
        if (!sameGatewaySnapshot(pin.snapshot, snapshotGatewayFile(pin.file, false)) || !unlinkGatewaySnapshot(pin.file, pin.snapshot)) {
          throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_OWNERSHIP_LOST", "Gateway launch pin 在 handoff 时发生变化；保留 pin。 ");
        }
        gatewayLaunchPins.delete(launch);
      }
      return published;
    });

    if (config.unified) {
      const { restoreGatewayRunningWorkspaces } = await import("../supervisor/lifecycle.js");
      await startupMaintenance("gateway-restore-workspaces", handle => restoreGatewayRunningWorkspaces(handle, stateDir));
    }

    let stopping: Promise<boolean> | undefined;
    const stop = (): Promise<boolean> => {
      intent.abort();
      return stopping ??= cleanupOwned();
    };
    const cleanupOwned = async (): Promise<boolean> => {
      if (released) return true;
      let ok = true;
      try { await gateway!.close("SIGTERM"); } catch { ok = false; }
      for (const child of [...owned].reverse()) {
        if (!await stopOwnedChild(child, probe, options.childStopTimeoutMs)) ok = false;
      }
      // Keep both ownership records when any child identity is ambiguous. A
      // later run must stop and inspect rather than hide an unowned process.
      if (ok && runtimeSnapshot && !unlinkGatewaySnapshot(gatewaySupervisorRuntimeFile(stateDir), runtimeSnapshot)) ok = false;
      if (ok && !releaseGatewayLock(lock)) ok = false;
      if (ok) released = true;
      runtimeKey = "";
      return ok;
    };
    const wait = async (signal?: AbortSignal): Promise<void> => {
      const waitingSignal = signal ? AbortSignal.any([shutdownSignal, signal]) : shutdownSignal;
      const reason = await waitForGatewayChildren(owned, gateway!.closed, waitingSignal);
      const unexpectedExit = reason === "child-exit" && !waitingSignal.aborted;
      const stopped = await stop();
      if (!stopped) throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_OWNERSHIP_LOST", "Gateway supervisor 子进程或 runtime ownership 无法确认。 ");
      if (unexpectedExit) throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_RUN_FAILED", "Gateway supervisor 子进程提前退出。 ");
    };
    return { runtime, commands, stop, wait };
  } catch (error) {
    let childrenStopped = true;
    try { await gateway?.close("SIGTERM"); } catch { childrenStopped = false; }
    for (const child of [...owned].reverse()) {
      if (!await stopOwnedChild(child, probe, options.childStopTimeoutMs)) childrenStopped = false;
    }
    const runtimeRemoved = !childIdentityAmbiguous && childrenStopped &&
      (!runtimeSnapshot || unlinkGatewaySnapshot(gatewaySupervisorRuntimeFile(stateDir), runtimeSnapshot));
    if (childrenStopped && runtimeRemoved) releaseGatewayLock(lock);
    runtimeKey = "";
    throw error;
  }
}

/** Foreground runner. Tunnel output is discarded; pairing is delivered only to the local callback. */
export async function runGatewaySupervisor(options: GatewaySupervisorRunOptions = {}): Promise<void> {
  if (options.signal?.aborted) return;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const forward = (): void => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  options.signal?.addEventListener("abort", forward, { once: true });
  try {
    const handle = await startGatewaySupervisor({ ...options, signal: controller.signal });
    await handle.wait(controller.signal);
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    options.signal?.removeEventListener("abort", forward);
  }
}
