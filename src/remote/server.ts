import express, { type Request, type Response } from "express";
import type { Server } from "node:http";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { AuthStore } from "../auth/store.js";
import { createOAuthRouter } from "../auth/oauth.js";
import { bearerAuth } from "../auth/middleware.js";
import { ensureDir, getStateDir } from "../config/paths.js";
import { createMcpHttpHandler } from "../mcp/http.js";
import { createMcpServer } from "../mcp/server.js";
import { Logger, nullLogger } from "../logger/index.js";
import { PairingManager } from "../pairing/manager.js";
import { authorized, readRemote, RemoteError } from "./store.js";
import { Workspace } from "../workspace/manager.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GatewayRegistry, GatewayRegistryError } from "../gateway/registry.js";
import { createGatewayMcpServer } from "../mcp/gateway.js";
import { DesktopError } from "../desktop/store.js";

export interface OfficialRemoteServerOptions extends GatewayServerOptions {
  workspaceRoot: string;
}

export interface OfficialRemoteServer extends GatewayServer {
  workspace: Workspace;
}

export interface GatewayServerOptions {
  port: number;
  publicUrl: string;
  authStoreFile?: string;
  pairingTtlMs?: number;
}

export interface GatewayServer {
  authStore: AuthStore;
  pairing: PairingManager;
  pairingCode: string;
  pairingExpiresAt: number;
  port: number;
  publicUrl: string;
  /** Resolves after the loopback HTTP listener has closed. */
  closed: Promise<void>;
  localBaseUrl(): string;
  close(): Promise<void>;
}

function httpsOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new RemoteError("INVALID_PUBLIC_URL", "--public-url 必须是明确的 HTTPS origin。"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new RemoteError("INVALID_PUBLIC_URL", "--public-url 必须是无路径、无凭据的 HTTPS origin；不会从请求 Host 推断授权地址。");
  }
  return url.origin;
}

function listen(app: express.Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1");
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

/** Standalone official MCP endpoint. It owns no Bridge, tunnel, mailbox or Desktop runtime. */
export async function startOfficialRemoteServer(opts: OfficialRemoteServerOptions): Promise<OfficialRemoteServer> {
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new RemoteError("INVALID_PORT");
  const publicUrl = httpsOrigin(opts.publicUrl);
  const workspace = new Workspace(opts.workspaceRoot);
  const state = authorized(readRemote(workspace.id));
  if (state.workspaceRoot !== workspace.root) throw new RemoteError("UNKNOWN_WORKSPACE");
  if (state.deliveryMode !== "official") throw new RemoteError("OFFICIAL_MODE_REQUIRED");

  const authStoreFile = opts.authStoreFile ?? path.join(
    ensureDir(path.join(getStateDir(), "auth", "official-mcp")),
    `${workspace.id}.json`,
  );
  const endpoint = await startEndpoint({ ...opts, publicUrl, identity: workspace.id,
    name: workspace.name, authStoreFile,
    makeServer: () => createMcpServer({ workspace, logger: nullLogger, profile: "official" }),
  });
  return { ...endpoint, workspace };
}

// Gateway authentication identifies the caller; project grants remain in the local registry.
export const GATEWAY_AUTH_ID = "machine-gateway";

export async function startGatewayServer(opts: GatewayServerOptions): Promise<GatewayServer> {
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new RemoteError("INVALID_PORT");
  httpsOrigin(opts.publicUrl);
  const registry = new GatewayRegistry();
  registry.list(); // Corrupt registry stops startup; no discovery or implicit registration.
  // One owner for the memory-cached machine AuthStore; never reclaim a crash lock automatically.
  const lockFile = path.join(ensureDir(path.join(getStateDir(), "gateway")), "server.lock");
  let lock: number;
  try { lock = fs.openSync(lockFile, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new GatewayRegistryError("GATEWAY_BUSY", "Gateway owner 锁已存在；先人工核对原实例，不会自动接管。");
    throw error;
  }
  const ownerNonce = randomUUID();
  const release = () => {
    try {
      const current = fs.lstatSync(lockFile), held = fs.fstatSync(lock);
      if (current.isFile() && current.dev === held.dev && current.ino === held.ino &&
          JSON.parse(fs.readFileSync(lockFile, "utf8")).ownerNonce === ownerNonce) fs.unlinkSync(lockFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally { fs.closeSync(lock); }
  };
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now(), ownerNonce }));
    fs.fsyncSync(lock);
    const endpoint = await startEndpoint({ ...opts, identity: GATEWAY_AUTH_ID, name: "本机 Gateway（仅显式授权项目）",
      authStoreFile: opts.authStoreFile ?? path.join(getStateDir(), "auth", "gateway.json"),
      allowAnonymousDiscovery: true,
      makeServer: (authStore) => createGatewayMcpServer(registry, (auth, scope) => {
        const verdict = authStore.verifyAccessToken(auth.token);
        if (!verdict.ok || verdict.record.workspaceId !== GATEWAY_AUTH_ID ||
            verdict.record.clientId !== auth.clientId || !verdict.record.scopes.includes(scope)) {
          throw new DesktopError("UNAUTHORIZED", "Gateway OAuth 授权已失效或权限不足，请重新授权后再操作。");
        }
      }),
    });
    let closing: Promise<void> | undefined;
    return { ...endpoint, close: () => closing ??= endpoint.close().finally(release) };
  } catch (error) { release(); throw error; }
}

async function startEndpoint(opts: GatewayServerOptions & {
  identity: string; name: string; authStoreFile: string; makeServer: (authStore: AuthStore) => McpServer;
  allowAnonymousDiscovery?: boolean;
}): Promise<GatewayServer> {
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new RemoteError("INVALID_PORT");
  const publicUrl = httpsOrigin(opts.publicUrl);
  const authStore = new AuthStore(opts.identity, { file: opts.authStoreFile });
  const pairing = new PairingManager(opts.identity, { ttlMs: opts.pairingTtlMs });
  const requestLogger = new Logger({ name: `remote-mcp-${opts.identity}`, level: "info" });
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.once("finish", () => {
      const requestPath = req.path;
      if (requestPath === "/mcp" || requestPath === "/oauth/token") {
        requestLogger.info("HTTP request completed", {
          method: req.method,
          path: requestPath,
          statusCode: res.statusCode,
        });
      }
    });
    next();
  });
  app.use(createOAuthRouter({
    store: authStore,
    pairing,
    workspaceName: opts.name,
    getBaseUrl: () => publicUrl,
    logger: nullLogger,
  }));

  const handleMcp = createMcpHttpHandler(() => opts.makeServer(authStore), nullLogger);
  app.all("/mcp", express.json({ limit: "8mb" }), bearerAuth({
    store: authStore,
    workspaceId: opts.identity,
    getBaseUrl: () => publicUrl,
    logger: nullLogger,
    allowAnonymousDiscovery: opts.allowAnonymousDiscovery,
  }), (req: Request, res: Response) => { void handleMcp(req, res); });

  const server = await listen(app, opts.port);
  const session = pairing.create();
  let closePromise: Promise<void> | undefined;
  return {
    authStore,
    pairing,
    pairingCode: session.code,
    pairingExpiresAt: session.expiresAt,
    port: (server.address() as { port: number }).port,
    publicUrl,
    closed: new Promise<void>(resolve => server.once("close", resolve)),
    localBaseUrl: () => `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => {
      if (closePromise) return closePromise;
      pairing.invalidateAll();
      closePromise = new Promise<void>(resolve => {
        const deadline = setTimeout(() => server.closeAllConnections(), 1000);
        deadline.unref();
        server.close(() => { clearTimeout(deadline); resolve(); });
      });
      return closePromise;
    },
  };
}
