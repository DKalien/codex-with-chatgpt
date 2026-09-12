import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensureDir, getStateDir, writeSecureJson } from "../config/paths.js";
import { isWriteProbeEnabled, WRITE_PROBE_SCOPE } from "../mcp/write-probe.js";

export const SUPPORTED_SCOPES = [
  "workspace.read",
  "workspace.search",
  "git.read",
  "execution.read",
  "offline_access",
] as const;

export const DESKTOP_CONTROL_SCOPE = "codex.desktop.control";
export const DESKTOP_READ_SCOPE = "codex.desktop.read";
export const CONNECTOR_CONTRACT_VERSION = 1 as const;

export type DesktopCompatibilityStatus =
  | "none"
  | "legacy"
  | "incomplete"
  | "current"
  | "unknown"
  | "corrupt";

export interface DesktopCompatibility {
  status: DesktopCompatibilityStatus;
}

export type Scope =
  | (typeof SUPPORTED_SCOPES)[number]
  | typeof WRITE_PROBE_SCOPE
  | "codex.control"
  | "codex.read"
  | typeof DESKTOP_CONTROL_SCOPE
  | typeof DESKTOP_READ_SCOPE;

export function getSupportedScopes(): string[] {
  const scopes = [...SUPPORTED_SCOPES, "codex.control", "codex.read", DESKTOP_CONTROL_SCOPE, DESKTOP_READ_SCOPE];
  return isWriteProbeEnabled() ? [...scopes, WRITE_PROBE_SCOPE] : scopes;
}

export interface ClientRegistration {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: string;
}

export interface AuthorizationCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  workspaceId: string;
  pairingSessionId: string;
  resource?: string;
  expiresAt: number;
}

export interface TokenRecord {
  hash: string;
  kind: "access" | "refresh";
  clientId: string;
  workspaceId: string;
  scopes: string[];
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
}

interface PersistedAuthState {
  clients: ClientRegistration[];
  tokens: TokenRecord[];
}

type DesktopScopeProfile = "none" | "read" | "control" | "both";

function isClientId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

const persistedAuthStateSchema = z.object({
  clients: z.array(z.object({
    clientId: z.string().min(1).max(256),
    clientName: z.string().optional(),
    redirectUris: z.array(z.string()),
    createdAt: z.string(),
  }).passthrough()),
  tokens: z.array(z.object({
    hash: z.string().min(1),
    kind: z.enum(["access", "refresh"]),
    clientId: z.string().min(1).max(256),
    workspaceId: z.string().min(1),
    scopes: z.array(z.string()),
    issuedAt: z.number().finite(),
    expiresAt: z.number().finite(),
    revoked: z.boolean(),
  }).passthrough()),
}).passthrough();

function desktopScopeProfile(scopes: readonly string[]): DesktopScopeProfile {
  const read = scopes.includes(DESKTOP_READ_SCOPE);
  const control = scopes.includes(DESKTOP_CONTROL_SCOPE);
  if (read && control) return "both";
  if (read) return "read";
  if (control) return "control";
  return "none";
}

function desktopCompatibilityStatus(profile: DesktopScopeProfile): DesktopCompatibilityStatus {
  if (profile === "both") return "current";
  if (profile === "none") return "legacy";
  return "incomplete";
}

export type VerifyTokenResult =
  | { ok: true; record: TokenRecord }
  | { ok: false; reason: "unknown" | "expired" | "revoked" | "wrong_kind" };

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;

function sha256hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function base64UrlSha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** Constant-time string comparison for equal-length inputs. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export class AuthStore {
  private clients = new Map<string, ClientRegistration>();
  private tokens = new Map<string, TokenRecord>();
  private authCodes = new Map<string, AuthorizationCodeRecord>();
  private readonly file: string;
  private stateCorrupt = false;

  constructor(
    readonly workspaceId: string,
    opts: { file?: string } = {}
  ) {
    this.file =
      opts.file ?? path.join(ensureDir(path.join(getStateDir(), "auth")), `${workspaceId}.json`);
    this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.stateCorrupt = true;
      return;
    }

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      this.stateCorrupt = true;
      return;
    }
    const parsed = persistedAuthStateSchema.safeParse(data);
    if (!parsed.success) {
      this.stateCorrupt = true;
      return;
    }
    const state = parsed.data;
    const now = Date.now();
    for (const client of state.clients) this.clients.set(client.clientId, client);
    for (const token of state.tokens) {
      if (!token.revoked && token.expiresAt > now) this.tokens.set(token.hash, token);
    }
  }

  private assertStateHealthy(): void {
    if (this.stateCorrupt) throw new Error("授权状态损坏；请保留原文件并人工核对，不能通过重新授权覆盖。");
  }

  private save(): void {
    this.assertStateHealthy();
    const now = Date.now();
    const state: PersistedAuthState = {
      clients: [...this.clients.values()],
      tokens: [...this.tokens.values()].filter((t) => !t.revoked && t.expiresAt > now),
    };
    writeSecureJson(this.file, state);
  }

  // ---- Dynamic Client Registration -------------------------------------

  registerClient(input: { clientName?: string; redirectUris: string[] }): ClientRegistration {
    this.assertStateHealthy();
    const client: ClientRegistration = {
      clientId: `c2c_client_${randomBytes(12).toString("base64url")}`,
      clientName: input.clientName,
      redirectUris: input.redirectUris,
      createdAt: new Date().toISOString(),
    };
    this.clients.set(client.clientId, client);
    this.save();
    return client;
  }

  getClient(clientId: string): ClientRegistration | undefined {
    return this.clients.get(clientId);
  }

  // ---- Authorization codes ----------------------------------------------

  createAuthorizationCode(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scopes: string[];
    pairingSessionId: string;
    resource?: string;
  }): string {
    this.assertStateHealthy();
    const code = newToken("c2c_ac");
    this.authCodes.set(code, {
      code,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scopes: input.scopes,
      workspaceId: this.workspaceId,
      pairingSessionId: input.pairingSessionId,
      resource: input.resource,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });
    return code;
  }

  /** One-time consumption of an authorization code. */
  consumeAuthorizationCode(code: string): AuthorizationCodeRecord | null {
    const record = this.authCodes.get(code);
    if (!record) return null;
    this.authCodes.delete(code);
    if (Date.now() > record.expiresAt) return null;
    return record;
  }

  // ---- Tokens -------------------------------------------------------------

  issueTokens(input: {
    clientId: string;
    scopes: string[];
    workspaceId?: string;
    accessTtlMs?: number;
  }): { accessToken: string; refreshToken: string | null; expiresIn: number; scopes: string[] } {
    this.assertStateHealthy();
    const now = Date.now();
    const workspaceId = input.workspaceId ?? this.workspaceId;
    const accessTtl = input.accessTtlMs ?? ACCESS_TOKEN_TTL_MS;

    const accessToken = newToken("c2c_at");
    this.tokens.set(sha256hex(accessToken), {
      hash: sha256hex(accessToken),
      kind: "access",
      clientId: input.clientId,
      workspaceId,
      scopes: input.scopes,
      issuedAt: now,
      expiresAt: now + accessTtl,
      revoked: false,
    });

    let refreshToken: string | null = null;
    if (input.scopes.includes("offline_access")) {
      refreshToken = newToken("c2c_rt");
      this.tokens.set(sha256hex(refreshToken), {
        hash: sha256hex(refreshToken),
        kind: "refresh",
        clientId: input.clientId,
        workspaceId,
        scopes: input.scopes,
        issuedAt: now,
        expiresAt: now + REFRESH_TOKEN_TTL_MS,
        revoked: false,
      });
    }
    this.save();
    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(accessTtl / 1000),
      scopes: input.scopes,
    };
  }

  verifyAccessToken(token: string): VerifyTokenResult {
    const record = this.tokens.get(sha256hex(token));
    if (!record) return { ok: false, reason: "unknown" };
    if (record.kind !== "access") return { ok: false, reason: "wrong_kind" };
    if (record.revoked) return { ok: false, reason: "revoked" };
    if (Date.now() > record.expiresAt) return { ok: false, reason: "expired" };
    return { ok: true, record };
  }

  /** 描述当前 Desktop OAuth 兼容性；无上下文时汇总独立授权，不合并不同 token。 */
  desktopCompatibility(accessToken?: string): DesktopCompatibility {
    if (this.stateCorrupt) return { status: "corrupt" };

    if (accessToken !== undefined) {
      const verdict = this.verifyAccessToken(accessToken);
      if (
        !verdict.ok ||
        verdict.record.workspaceId !== this.workspaceId ||
        verdict.record.expiresAt <= Date.now() ||
        !isClientId(verdict.record.clientId)
      ) return { status: "unknown" };
      return { status: desktopCompatibilityStatus(desktopScopeProfile(verdict.record.scopes)) };
    }

    const profiles = new Set<DesktopScopeProfile>();
    let invalidContext = false;
    const now = Date.now();
    for (const record of this.tokens.values()) {
      if (record.revoked || record.expiresAt <= now || record.workspaceId !== this.workspaceId) {
        continue;
      }
      if (!isClientId(record.clientId)) {
        invalidContext = true;
        continue;
      }
      profiles.add(desktopScopeProfile(record.scopes));
    }
    if (invalidContext) return { status: "unknown" };
    if (profiles.size === 0) return { status: "none" };
    if (profiles.has("both")) return { status: "current" };
    if (profiles.size !== 1) return { status: "unknown" };
    return { status: desktopCompatibilityStatus(profiles.values().next().value as DesktopScopeProfile) };
  }

  /** Refresh-token rotation: old refresh token is revoked, a new pair is issued. */
  refresh(
    refreshToken: string,
    clientId: string
  ): { ok: true; tokens: ReturnType<AuthStore["issueTokens"]> } | { ok: false; reason: string } {
    if (this.stateCorrupt) return { ok: false, reason: "invalid_grant" };
    const record = this.tokens.get(sha256hex(refreshToken));
    if (!record || record.kind !== "refresh") return { ok: false, reason: "invalid_grant" };
    if (record.revoked) return { ok: false, reason: "invalid_grant" };
    if (Date.now() > record.expiresAt) return { ok: false, reason: "invalid_grant" };
    if (record.clientId !== clientId) return { ok: false, reason: "invalid_client" };
    record.revoked = true;
    this.tokens.delete(record.hash);
    const tokens = this.issueTokens({
      clientId,
      scopes: record.scopes,
      workspaceId: record.workspaceId,
    });
    return { ok: true, tokens };
  }

  revokeToken(token: string): boolean {
    this.assertStateHealthy();
    const record = this.tokens.get(sha256hex(token));
    if (!record) return false;
    record.revoked = true;
    this.tokens.delete(record.hash);
    this.save();
    return true;
  }

  /** Used by `c2c unpair`: revoke everything for this workspace. */
  revokeAll(): number {
    this.assertStateHealthy();
    const count = this.tokens.size;
    this.tokens.clear();
    this.authCodes.clear();
    this.save();
    return count;
  }

  tokenCount(): number {
    return this.tokens.size;
  }

  static deleteStateFile(workspaceId: string): void {
    const file = path.join(getStateDir(), "auth", `${workspaceId}.json`);
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }
}

export function filterScopes(requested: string | undefined): string[] {
  if (!requested || requested.trim() === "") return [...SUPPORTED_SCOPES];
  const asked = requested.split(/[\s+]+/).filter(Boolean);
  const granted = asked.filter((scope) => getSupportedScopes().includes(scope));
  return granted.length > 0 ? granted : [...SUPPORTED_SCOPES];
}
