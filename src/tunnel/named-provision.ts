import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findBinary } from "./detect.js";
import { suggestedNamedHostname, uniqueNamedHostname } from "./hostname.js";
import { normalizeNamedTunnelHostname } from "./cloudflared-named.js";
import {
  hasLocalTunnelBindingConflict,
  NAMED_FALLBACK_MESSAGE,
  isNamedTunnelReady,
  readTunnelState,
  resolveMigrationZone,
  writeTunnelState,
  type TunnelState,
} from "./state.js";

const TUNNEL_ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const VALID_TUNNEL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const COMMAND_TIMEOUT_MS = 45_000;

export interface ListedTunnel {
  id: string;
  name: string;
}

export interface CloudflaredAccount {
  hasCert(): boolean;
  login(): Promise<void>;
  listTunnels(): Promise<ListedTunnel[]>;
  createTunnel(name: string): Promise<ListedTunnel>;
  routeDns(tunnelName: string, hostname: string, options?: { strict?: boolean }): Promise<void>;
}

export function cloudflaredCertPath(): string {
  const override = process.env.TUNNEL_ORIGIN_CERT?.trim();
  if (override) return override;
  return path.join(os.homedir(), ".cloudflared", "cert.pem");
}

export function hasCloudflaredCert(): boolean {
  try {
    return fs.statSync(cloudflaredCertPath()).isFile();
  } catch {
    return false;
  }
}

export function parseTunnelList(output: string): ListedTunnel[] {
  const trimmed = output.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const rows = Array.isArray(parsed) ? parsed : (parsed as { tunnels?: unknown }).tunnels;
      if (!Array.isArray(rows)) return [];
      return rows.flatMap((row) => {
        if (!row || typeof row !== "object") return [];
        const record = row as { id?: unknown; name?: unknown };
        if (typeof record.id !== "string" || typeof record.name !== "string") return [];
        return [{ id: record.id, name: record.name }];
      });
    } catch {
      // fall through to the table parser
    }
  }
  const found: ListedTunnel[] = [];
  for (const line of output.split(/\r?\n/)) {
    const id = line.match(TUNNEL_ID_RE)?.[0];
    if (!id) continue;
    const after = line.slice(line.indexOf(id) + id.length).trim();
    const name = after.split(/\s+/)[0];
    if (name && name !== "NAME") found.push({ id, name });
  }
  return found;
}

export function parseCreatedTunnel(output: string, name: string): ListedTunnel | null {
  const id = output.match(TUNNEL_ID_RE)?.[0];
  const returnedName = output.match(/created\s+tunnel\s+([^\s]+)\s+with\s+id/i)?.[1];
  return id ? { id, name: returnedName ?? name } : null;
}

export function isBenignRouteError(message: string): boolean {
  return /already exists|duplicate|exists as a cname/i.test(message);
}

export class ProcessCloudflaredAccount implements CloudflaredAccount {
  constructor(private readonly binaryOverride?: string) {}

  private binary(): string {
    const bin = this.binaryOverride ?? findBinary("cloudflared");
    if (!bin) {
      throw new Error(
        "NEED_CLOUDFLARED: cloudflared is not installed. Install it first (macOS: brew install cloudflared)."
      );
    }
    return bin;
  }

  hasCert(): boolean {
    return hasCloudflaredCert();
  }

  async login(): Promise<void> {
    if (this.hasCert()) return;
    const bin = this.binary();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, ["tunnel", "login"], { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const collect = (chunk: Buffer): void => {
        output += chunk.toString("utf8");
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("Cloudflare login timed out"));
      }, LOGIN_TIMEOUT_MS);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (this.hasCert()) {
          resolve();
          return;
        }
        reject(
          new Error(
            `Cloudflare login did not finish${code !== 0 ? ` (exit ${code})` : ""}${
              output.trim() ? `: ${output.trim().slice(0, 400)}` : ""
            }`
          )
        );
      });
    });
  }

  async listTunnels(): Promise<ListedTunnel[]> {
    const json = this.run(["tunnel", "list", "--output", "json"]);
    if (json.ok) {
      const parsed = parseTunnelList(json.stdout || json.stderr);
      if (parsed.length > 0 || (json.stdout || json.stderr).trim().startsWith("[")) return parsed;
    }
    const table = this.run(["tunnel", "list"]);
    if (!table.ok) throw new Error(table.stderr || table.stdout || "Unable to list Cloudflare tunnels");
    return parseTunnelList(`${table.stdout}\n${table.stderr}`);
  }

  async createTunnel(name: string): Promise<ListedTunnel> {
    const existing = (await this.listTunnels()).find((tunnel) => tunnel.name === name);
    if (existing) return existing;
    const result = this.run(["tunnel", "create", name]);
    const created = parseCreatedTunnel(`${result.stdout}\n${result.stderr}`, name);
    if (created) return created;
    if (/already exists/i.test(`${result.stdout}\n${result.stderr}`)) {
      const again = (await this.listTunnels()).find((tunnel) => tunnel.name === name);
      if (again) return again;
    }
    throw new Error(result.stderr || result.stdout || `Unable to create tunnel ${name}`);
  }

  async routeDns(tunnelName: string, hostname: string, options?: { strict?: boolean }): Promise<void> {
    const result = this.run(["tunnel", "route", "dns", tunnelName, hostname]);
    if (result.ok || (!options?.strict && isBenignRouteError(`${result.stdout}\n${result.stderr}`))) return;
    throw new Error(result.stderr || result.stdout || `Unable to route ${hostname}`);
  }

  private run(args: string[]): { ok: boolean; stdout: string; stderr: string } {
    const result = spawnSync(this.binary(), args, {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    return {
      ok: result.status === 0,
      stdout: (result.stdout ?? "").trim(),
      stderr: (result.stderr ?? "").trim(),
    };
  }
}

export interface ProvisionNamedResult {
  ok: boolean;
  state: TunnelState;
  fallback: boolean;
  userMessage?: string;
  error?: string;
}

export async function provisionNamedTunnel(opts: {
  workspaceId: string;
  workspaceName: string;
  zone: string;
  hostname?: string;
  requireNamed?: boolean;
  account?: CloudflaredAccount;
}): Promise<ProvisionNamedResult> {
  const requireNamed = opts.requireNamed === true;
  const previous = readTunnelState(opts.workspaceId);
  const account = opts.account ?? new ProcessCloudflaredAccount();
  let zone: string;
  let hostname: string;
  let tunnelName: string;
  try {
    zone = normalizeNamedTunnelHostname(opts.zone);
    tunnelName = `c2c-${opts.workspaceId.trim().toLowerCase()}`;
    if (requireNamed) {
      if (resolveMigrationZone(opts.workspaceId).zoneResolution === "corrupt") {
        throw new Error("Tunnel state is corrupt; migration is blocked until it is repaired");
      }
      const expectedHostname = uniqueNamedHostname(zone, opts.workspaceId);
      hostname = opts.hostname ? normalizeNamedTunnelHostname(opts.hostname) : expectedHostname;
      if (hostname !== expectedHostname) {
        throw new Error("Strict named tunnel hostname must include the current workspace id");
      }
      if (previous.workspaceId !== opts.workspaceId) {
        throw new Error("Tunnel state belongs to another workspace");
      }
      if (hasLocalTunnelBindingConflict(opts.workspaceId, { tunnelName, hostname })) {
        throw new Error("Named tunnel binding conflicts with another workspace");
      }
      if (
        isNamedTunnelReady(previous) &&
        previous.tunnelName === tunnelName &&
        previous.tunnelId &&
        VALID_TUNNEL_ID_RE.test(previous.tunnelId) &&
        previous.hostname
      ) {
        const previousHostname = normalizeNamedTunnelHostname(previous.hostname);
        if (
          hasLocalTunnelBindingConflict(opts.workspaceId, {
            tunnelName: previous.tunnelName,
            tunnelId: previous.tunnelId,
            hostname: previousHostname,
          })
        ) {
          throw new Error("Saved tunnel binding conflicts with another workspace");
        }
        return { ok: true, state: previous, fallback: false };
      }
    } else {
      hostname = opts.hostname
        ? normalizeNamedTunnelHostname(opts.hostname)
        : suggestedNamedHostname(zone, opts.workspaceName, opts.workspaceId);
    }
  } catch (error) {
    return provisionFailure(opts.workspaceId, requireNamed, "invalid_hostname", (error as Error).message);
  }

  try {
    if (!account.hasCert()) await account.login();
    const listed = requireNamed ? await account.listTunnels() : [];
    const tunnel = await account.createTunnel(tunnelName);
    if (requireNamed) {
      if (tunnel.name !== tunnelName) throw new Error("Cloudflare returned a tunnel for another workspace");
      if (!VALID_TUNNEL_ID_RE.test(tunnel.id)) throw new Error("Cloudflare returned an invalid tunnel id");
      const collision = listed.find((candidate) => candidate.id === tunnel.id && candidate.name !== tunnelName);
      if (collision) throw new Error("Cloudflare tunnel id belongs to another workspace");
      const existing = listed.find((candidate) => candidate.name === tunnelName);
      if (existing && existing.id !== tunnel.id) {
        throw new Error("Cloudflare returned a different tunnel for this workspace");
      }
      if (previous.tunnelId && previous.tunnelId !== tunnel.id) {
        throw new Error("Saved tunnel id does not match the current workspace tunnel");
      }
      if (
        hasLocalTunnelBindingConflict(opts.workspaceId, {
          tunnelName: tunnel.name,
          tunnelId: tunnel.id,
          hostname,
        })
      ) {
        throw new Error("Tunnel binding conflicts with another workspace");
      }
    }
    await account.routeDns(tunnel.name, hostname, requireNamed ? { strict: true } : undefined);
    const state = writeTunnelState({
      workspaceId: opts.workspaceId,
      preference: "named",
      askedAt: new Date().toISOString(),
      provider: "cloudflare-named",
      tunnelName: tunnel.name,
      tunnelId: tunnel.id,
      hostname,
      zone,
      configuredAt: new Date().toISOString(),
    });
    return { ok: true, state, fallback: false };
  } catch (error) {
    return provisionFailure(opts.workspaceId, requireNamed, "provision_failed", (error as Error).message);
  }
}

export function chooseQuickTunnel(workspaceId: string, fallbackReason?: string): TunnelState {
  return writeTunnelState({
    workspaceId,
    preference: "quick",
    askedAt: new Date().toISOString(),
    provider: "cloudflare-quick",
    fallbackReason,
  });
}

function fallbackState(workspaceId: string, reason: string, error: string): ProvisionNamedResult {
  const state = chooseQuickTunnel(workspaceId, reason);
  return {
    ok: true,
    state,
    fallback: true,
    userMessage: NAMED_FALLBACK_MESSAGE,
    error,
  };
}

function provisionFailure(
  workspaceId: string,
  requireNamed: boolean,
  reason: string,
  error: string
): ProvisionNamedResult {
  if (requireNamed) {
    return {
      ok: false,
      state: readTunnelState(workspaceId),
      fallback: false,
      error,
    };
  }
  return fallbackState(workspaceId, reason, error);
}
