import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { getStateDir } from "../config/paths.js";
import { C2CError } from "../errors.js";
import { readJson, writeJson } from "../util/json-file.js";

export interface GatewayConfig {
  publicUrl: string;
  port: number;
  tunnelName: string;
  tunnelId: string;
  cloudflaredPath: string;
  tunnelClientPath: string;
  proxy: string | null;
  keyFile: string;
}

const gatewayDir = (): string => path.join(getStateDir(), "gateway");
const configFile = (): string => path.join(gatewayDir(), "supervisor.json");
export const defaultKeyFile = (): string => path.join(gatewayDir(), "tunnel-runtime-key.dpapi");

const publicUrl = z.string().refine(v => {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash;
  } catch { return false; }
}, "publicUrl 必须是不带路径的 HTTPS origin");

// 未声明的旧字段（stableLauncher、keyReference、unified…）由 zod 默认丢弃。
const schema = z.object({
  publicUrl,
  port: z.number().int().min(1).max(65535),
  tunnelName: z.string().min(1),
  tunnelId: z.string().min(1),
  cloudflaredPath: z.string().min(1),
  tunnelClientPath: z.string().min(1),
  proxy: z.string().nullish().transform(v => v ?? null),
  keyFile: z.string().min(1).optional(),
});

export function readGatewayConfig(): GatewayConfig | null {
  const raw = readJson<unknown>(configFile(), null);
  if (raw === null) return null;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new C2CError("GATEWAY_CONFIG_INVALID", `Gateway 配置无效：${parsed.error.issues[0]?.message ?? ""}`);
  return { ...parsed.data, keyFile: parsed.data.keyFile ?? defaultKeyFile() };
}

export function writeGatewayConfig(config: GatewayConfig): void {
  const parsed = schema.safeParse(config);
  if (!parsed.success) throw new C2CError("GATEWAY_CONFIG_INVALID", `Gateway 配置无效：${parsed.error.issues[0]?.message ?? ""}`);
  writeJson(configFile(), { version: 1, scope: "machine", ...parsed.data, keyFile: config.keyFile });
}

// --- Windows DPAPI（当前用户）：密文落盘，明文只经环境变量交给 tunnel-client ---

const BEGIN = "C2C_DPAPI_BEGIN";
const END = "C2C_DPAPI_END";

const SET_KEY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$secure = Read-Host -AsSecureString -Prompt 'Gateway tunnel runtime key'
$cipher = ConvertFrom-SecureString -SecureString $secure
[Console]::Out.WriteLine('${BEGIN}')
[Console]::Out.WriteLine($cipher)
[Console]::Out.WriteLine('${END}')
`;

const READ_KEY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$cipher = [Console]::In.ReadToEnd().Trim()
$secure = ConvertTo-SecureString -String $cipher
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  [Console]::Out.WriteLine('${BEGIN}')
  [Console]::Out.WriteLine([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr))
  [Console]::Out.WriteLine('${END}')
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}
`;

export function powershellPath(): string {
  if (process.platform !== "win32") throw new C2CError("KEY_UNSUPPORTED", "DPAPI 密钥保护仅支持 Windows。");
  const root = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function runKeyScript(script: string, input?: string): string {
  const { PSModulePath: _drop, ...env } = process.env; // PowerShell 7 的 PSModulePath 会破坏 DPAPI cmdlet
  const result = spawnSync(
    powershellPath(),
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { env, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024, input, stdio: [input === undefined ? "inherit" : "pipe", "pipe", "pipe"] },
  );
  if (result.error || result.status !== 0) throw new C2CError("KEY_HELPER_FAILED", "Windows DPAPI 执行失败（不会输出 key）。");
  const lines = result.stdout.split(/\r?\n/);
  const begin = lines.indexOf(BEGIN);
  const end = lines.indexOf(END, begin + 1);
  const payload = begin < 0 || end < 0 ? "" : lines.slice(begin + 1, end).join("\n").trim();
  if (!payload) throw new C2CError("KEY_HELPER_FAILED", "Windows DPAPI 返回格式无效（不会输出 key）。");
  return payload;
}

export function setTunnelKey(): void {
  powershellPath();
  if (!process.stdin.isTTY) throw new C2CError("KEY_NEEDS_TTY", "请在交互式终端运行 gateway set-key；不从管道接收明文 key。");
  const keyFile = readGatewayConfig()?.keyFile ?? defaultKeyFile();
  process.stderr.write("请输入 Gateway tunnel runtime key（隐藏输入，回车保存）：\n");
  const cipher = runKeyScript(SET_KEY_SCRIPT);
  if (!/^[A-Za-z0-9+/=_-]+$/.test(cipher)) throw new C2CError("KEY_HELPER_FAILED", "DPAPI 密文格式无效，未写入。");
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(keyFile, `${cipher}\n`, { mode: 0o600 });
}

export function readTunnelKey(keyFile: string): string {
  let cipher: string;
  try {
    cipher = fs.readFileSync(keyFile, "utf8").trim();
  } catch {
    throw new C2CError("KEY_MISSING", "未找到 Gateway tunnel key，请先运行 gateway set-key。");
  }
  if (!/^[A-Za-z0-9+/=_-]+$/.test(cipher)) throw new C2CError("KEY_INVALID", "Gateway tunnel key 文件内容无效。");
  return runKeyScript(READ_KEY_SCRIPT, `${cipher}\n`);
}
