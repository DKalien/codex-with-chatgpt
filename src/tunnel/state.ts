import fs from "node:fs";
import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { normalizeNamedTunnelHostname } from "./cloudflared-named.js";

export type TunnelPreference = "unset" | "quick" | "named";

export interface TunnelState {
  workspaceId: string;
  preference: TunnelPreference;
  askedAt?: string;
  provider?: "cloudflare-quick" | "cloudflare-named";
  tunnelName?: string;
  tunnelId?: string;
  hostname?: string;
  zone?: string;
  configuredAt?: string;
  fallbackReason?: string;
}

export type ZoneResolution = "current" | "machine-unique" | "ambiguous" | "missing" | "corrupt";

export interface MigrationZoneInfo {
  migrationZone: string | null;
  zoneResolution: ZoneResolution;
}

export function tunnelStateFile(workspaceId: string): string {
  return path.join(getStateDir(), "tunnels", `${workspaceId}.json`);
}

export function readTunnelState(workspaceId: string): TunnelState {
  return (
    readJsonIfExists<TunnelState>(tunnelStateFile(workspaceId)) ?? {
      workspaceId,
      preference: "unset",
    }
  );
}

function parseTunnelState(value: unknown): TunnelState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.workspaceId !== "string" || !record.workspaceId.trim()) return null;
  if (record.preference !== "unset" && record.preference !== "quick" && record.preference !== "named") {
    return null;
  }
  if (
    record.provider !== undefined &&
    record.provider !== "cloudflare-quick" &&
    record.provider !== "cloudflare-named"
  ) {
    return null;
  }
  for (const key of [
    "askedAt",
    "tunnelName",
    "tunnelId",
    "hostname",
    "zone",
    "configuredAt",
    "fallbackReason",
  ]) {
    if (record[key] !== undefined && typeof record[key] !== "string") return null;
  }
  return record as unknown as TunnelState;
}

function readStateForResolution(file: string): "missing" | "corrupt" | TunnelState {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "corrupt";
  }
  try {
    const parsed = parseTunnelState(JSON.parse(raw));
    return parsed ?? "corrupt";
  } catch {
    return "corrupt";
  }
}

function normalizedStateZone(state: TunnelState): string | null | "corrupt" {
  if (state.zone === undefined) return null;
  try {
    return normalizeNamedTunnelHostname(state.zone);
  } catch {
    return "corrupt";
  }
}

/**
 * 只读解析迁移所需的 zone。优先当前 workspace 的可靠记录，随后才查看机器级 tunnels 目录。
 * 这里只读取 tunnel 状态文件，不读取证书或凭据，也不会复用或修改其他 workspace 的绑定。
 */
export function resolveMigrationZone(workspaceId: string): MigrationZoneInfo {
  const currentFile = tunnelStateFile(workspaceId);
  const current = readStateForResolution(currentFile);
  if (current === "corrupt") return { migrationZone: null, zoneResolution: "corrupt" };
  if (current !== "missing") {
    if (current.workspaceId !== workspaceId) return { migrationZone: null, zoneResolution: "corrupt" };
    const zone = normalizedStateZone(current);
    if (zone === "corrupt") return { migrationZone: null, zoneResolution: "corrupt" };
    if (zone) return { migrationZone: zone, zoneResolution: "current" };
  }

  const dir = path.dirname(currentFile);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { migrationZone: null, zoneResolution: "missing" }
      : { migrationZone: null, zoneResolution: "corrupt" };
  }

  const zones = new Set<string>();
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile()) return { migrationZone: null, zoneResolution: "corrupt" };
    const state = readStateForResolution(path.join(dir, entry.name));
    if (state === "missing" || state === "corrupt") {
      return { migrationZone: null, zoneResolution: "corrupt" };
    }
    if (state.workspaceId !== entry.name.slice(0, -5)) {
      return { migrationZone: null, zoneResolution: "corrupt" };
    }
    const zone = normalizedStateZone(state);
    if (zone === "corrupt") return { migrationZone: null, zoneResolution: "corrupt" };
    if (zone) zones.add(zone);
  }
  if (zones.size === 1) return { migrationZone: [...zones][0], zoneResolution: "machine-unique" };
  if (zones.size > 1) return { migrationZone: null, zoneResolution: "ambiguous" };
  return { migrationZone: null, zoneResolution: "missing" };
}

/**
 * 检查本机状态中是否已有其他 workspace 使用同一个 named binding。
 * 解析失败也按冲突处理，避免在不确定时复用远端 tunnel。
 */
export function hasLocalTunnelBindingConflict(
  workspaceId: string,
  binding: { tunnelName?: string; tunnelId?: string; hostname?: string }
): boolean {
  const currentFile = tunnelStateFile(workspaceId);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.dirname(currentFile), { withFileTypes: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  let hostname: string | null = null;
  if (binding.hostname) {
    try {
      hostname = normalizeNamedTunnelHostname(binding.hostname);
    } catch {
      return true;
    }
  }
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile()) return true;
    const file = path.join(path.dirname(currentFile), entry.name);
    if (path.resolve(file) === path.resolve(currentFile)) continue;
    const state = readStateForResolution(file);
    if (state === "missing" || state === "corrupt") return true;
    if (state.workspaceId !== entry.name.slice(0, -5)) return true;
    if (binding.tunnelName && state.tunnelName === binding.tunnelName) return true;
    if (binding.tunnelId && state.tunnelId === binding.tunnelId) return true;
    if (hostname && state.hostname) {
      try {
        if (normalizeNamedTunnelHostname(state.hostname) === hostname) return true;
      } catch {
        return true;
      }
    }
  }
  return false;
}

export function writeTunnelState(state: TunnelState): TunnelState {
  writeSecureJson(tunnelStateFile(state.workspaceId), state);
  return state;
}

export function needsTunnelChoice(state: TunnelState): boolean {
  return state.preference === "unset" || !state.askedAt;
}

export function isNamedTunnelReady(state: TunnelState): boolean {
  return (
    state.preference === "named" &&
    Boolean(state.tunnelName?.trim()) &&
    Boolean(state.hostname?.trim())
  );
}

export function namedTunnelBinding(state: TunnelState): { tunnelName: string; hostname: string } | null {
  if (!isNamedTunnelReady(state) || !state.tunnelName || !state.hostname) return null;
  return { tunnelName: state.tunnelName, hostname: state.hostname };
}

export const TUNNEL_CHOICE_PROMPT = `连 ChatGPT 之前，有一条可选的。
你有没有 Cloudflare 账号，并且有没有一个域名已经加在 Cloudflare 里？
- 有：可以用固定域名。插件配一次，以后电脑重启一般不用再改插件。要登录一次 Cloudflare，并在你的域名下加一个子域名。
- 没有：用临时地址。不用注册，功能一样。但电脑重启后地址常会变，ChatGPT 里的旧地址会失效。我会自己删掉这个项目的插件、用新地址再加回去，你偶尔要再登一下 ChatGPT。能修好，只是更慢。
没有账号也完全能用。你选哪个？如果有域名，直接告诉我域名（例如 example.com）。`;

export const NAMED_LOGIN_PROMPT =
  "会弹出浏览器，请登录 Cloudflare 并选中你的域名，完成后告诉我「好了」。";

export const NAMED_FALLBACK_MESSAGE =
  "这次先用临时地址。功能一样，以后修连接可能会更慢。想改成固定域名时再说一声。";

export const NAMED_REPAIR_MESSAGE =
  "固定域名暂时连不上。请在即将弹出的窗口登录 Cloudflare，选中你的域名，完成后告诉我「好了」。";
