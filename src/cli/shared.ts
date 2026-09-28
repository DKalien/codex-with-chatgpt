import { InvalidArgumentError } from "commander";
import fs from "node:fs";
import path from "node:path";
import { Workspace } from "../workspace/manager.js";
import { ensureSandboxAllowlist } from "../config/sandbox-allow.js";
import {
  connectorNameFor,
  readLastEndpoint,
  writeLastEndpoint,
  type LastEndpoint,
} from "../config/endpoint.js";
import { parseZoneInput, suggestedNamedHostname } from "../tunnel/hostname.js";
import { hasCloudflaredCert } from "../tunnel/named-provision.js";
import {
  isNamedTunnelReady,
  NAMED_LOGIN_PROMPT,
  needsTunnelChoice,
  readTunnelState,
  resolveMigrationZone,
  TUNNEL_CHOICE_PROMPT,
} from "../tunnel/state.js";

export const say = (msg: string): void => { process.stdout.write(msg + "\n"); };
export const check = (msg: string): void => say(`✓ ${msg}`);
export const cross = (msg: string): void => say(`✗ ${msg}`);

export function resolveWorkspace(option?: string): string {
  return path.resolve(option ?? process.cwd());
}

export function parseInteger(value: string): number {
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) throw new InvalidArgumentError("must be an integer");
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) throw new InvalidArgumentError("must be a safe integer");
  return parsed;
}

export function parseNonNegativeInteger(value: string): number {
  const parsed = parseInteger(value);
  if (parsed < 0) throw new InvalidArgumentError("must be a non-negative integer");
  return parsed;
}

export function parseChangedFiles(value: string): string[] | number {
  const normalized = value.trim();
  if (/^-?\d+$/.test(normalized)) {
    const count = parseInteger(normalized);
    if (count < 0) throw new InvalidArgumentError("changed-files count must be a non-negative safe integer");
    return count;
  }
  return value.split(",").map((file) => file.trim()).filter(Boolean);
}

/** Local harness output only. Never pasted into ChatGPT. */
export const MAX_RECORD_OUTPUT_READ = 256 * 1024;

export function readCappedUtf8(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export function persistWorkspaceEndpoint(opts: {
  workspaceId: string;
  workspaceName: string;
  port: number;
  publicUrl: string | null;
  mcpUrl: string;
  previous?: LastEndpoint | null;
}): string {
  const previous = opts.previous ?? readLastEndpoint(opts.workspaceId);
  const connectorName = connectorNameFor({
    workspaceName: opts.workspaceName,
    workspaceId: opts.workspaceId,
    previousName: previous?.connectorName,
    hadEndpointBefore: Boolean(previous),
  });
  writeLastEndpoint({
    workspaceId: opts.workspaceId,
    port: opts.port,
    publicUrl: opts.publicUrl,
    mcpUrl: opts.mcpUrl,
    connectorName,
  });
  return connectorName;
}

export function tunnelChoicePayload(workspace: Workspace, zoneHint?: string): Record<string, unknown> {
  const state = readTunnelState(workspace.id);
  const migration = resolveMigrationZone(workspace.id);
  const zone = parseZoneInput(zoneHint ?? "") ?? migration.migrationZone;
  return {
    ok: true,
    needsChoice: needsTunnelChoice(state),
    preference: state.preference,
    loggedIn: hasCloudflaredCert(),
    namedReady: isNamedTunnelReady(state),
    zone,
    migrationZone: migration.migrationZone,
    zoneResolution: migration.zoneResolution,
    hostname: state.hostname ?? null,
    suggestedHostname: zone ? suggestedNamedHostname(zone, workspace.name, workspace.id) : null,
    userPrompt: needsTunnelChoice(state) ? TUNNEL_CHOICE_PROMPT : undefined,
    loginPrompt: NAMED_LOGIN_PROMPT,
    fallbackReason: state.fallbackReason,
  };
}

export function trySandboxAllow():
  | { ok: true; added: boolean; alreadyAllowed: boolean; stateDir: string; configPath: string }
  | { ok: false; added: false; alreadyAllowed: false; error: string } {
  try {
    const result = ensureSandboxAllowlist();
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, added: false, alreadyAllowed: false, error: (error as Error).message };
  }
}
export interface TunnelStartResponse {
  url?: string;
  error?: string;
  message?: string;
}

export interface PairingResponse {
  code: string;
  expiresAt: number;
}

export function handleCliError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    say(JSON.stringify({ ok: false, error: message }));
  } else if (message.startsWith("NEED_CLOUDFLARED")) {
    say("需要你完成一步：");
    say("");
    say("尚未安装安全连接组件 cloudflared。");
    say("macOS 用户可运行：brew install cloudflared");
    say("完成后再试一次即可。");
  } else {
    cross(message);
  }
  process.exitCode = 1;
}
