import express, { type Request, type Response } from "express";
import type { Server } from "node:http";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
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
import { GatewayWorkspaces } from "../gateway/workspaces.js";
import { assertMaintenanceHandle, maintenanceLockPath } from "../core/maintenance-lock.js";
import type { ShutdownReason } from "../process/bridge-provenance.js";
import { DesktopError } from "../desktop/store.js";

export interface OfficialRemoteServerOptions extends GatewayServerOptions {
  workspaceRoot: string;
}

export interface OfficialRemoteServer extends GatewayServer {
  workspace: Workspace;
}

export interface GatewayServerOptions {
  sharedWorkspaces?: { tunnelAvailable: () => boolean };
  onShutdown?: () => void;
  port: number;
  publicUrl: string;
  authStoreFile?: string;
  pairingTtlMs?: number;
  healthIdentity?: { pid: number; creationTime: string; buildId: string };
}

export interface GatewayServer {
  authStore: AuthStore;
  pairing: PairingManager;
  pairingCode: string;
  pairingExpiresAt: number;
  port: number;
  publicUrl: string;
  /** 在所有 workspace contexts 和 loopback HTTP listener 完整关闭后 resolve。 */
  closed: Promise<void>;
  localBaseUrl(): string;
  close(reason?: ShutdownReason): Promise<void>;
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
  const healthIdentity = opts.healthIdentity === undefined ? undefined : z.object({
    pid: z.number().int().positive().max(0xffffffff).refine(pid => pid === process.pid),
    creationTime: z.string().regex(/^[a-zA-Z0-9:-]{1,128}$/),
    buildId: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().parse(opts.healthIdentity);
  if (opts.sharedWorkspaces && !healthIdentity) throw new GatewayRegistryError("GATEWAY_HEALTH_IDENTITY_REQUIRED");
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
      gatewayHealth: healthIdentity,
      makeServer: (authStore) => createGatewayMcpServer(registry, (auth, scope) => {
        const verdict = authStore.verifyAccessToken(auth.token);
        if (!verdict.ok || verdict.record.workspaceId !== GATEWAY_AUTH_ID ||
            verdict.record.clientId !== auth.clientId || !verdict.record.scopes.includes(scope)) {
          throw new DesktopError("UNAUTHORIZED", "Gateway OAuth 授权已失效或权限不足，请重新授权后再操作。");
        }
      }),
    });
    let closing: Promise<void> | undefined;
    return { ...endpoint, close: (reason) => closing ??= endpoint.close(reason).then(release) };
  } catch (error) { release(); throw error; }
}

async function startEndpoint(opts: GatewayServerOptions & {
  identity: string; name: string; authStoreFile: string; makeServer: (authStore: AuthStore) => McpServer;
  allowAnonymousDiscovery?: boolean;
  gatewayHealth?: GatewayServerOptions["healthIdentity"];
}): Promise<GatewayServer> {
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new RemoteError("INVALID_PORT");
  const publicUrl = httpsOrigin(opts.publicUrl);
  const authStore = new AuthStore(opts.identity, { file: opts.authStoreFile });
  const pairing = new PairingManager(opts.identity, { ttlMs: opts.pairingTtlMs });
  const requestLogger = new Logger({ name: `remote-mcp-${opts.identity}`, level: "info" });
  const app = express();
  app.disable("x-powered-by");
  const workspaces = opts.sharedWorkspaces ? new GatewayWorkspaces(new GatewayRegistry(), publicUrl, opts.sharedWorkspaces.tunnelAvailable) : null;
  const localRequest = (req: Request): boolean => {
    const port = (server.address() as { port: number }).port;
    return req.socket.remoteAddress === "127.0.0.1" && req.headers.host === `127.0.0.1:${port}` &&
      !Object.keys(req.headers).some(name => name === "forwarded" || name.startsWith("x-forwarded-") ||
        name === "cf-connecting-ip" || name === "cf-ray");
  };
  if (workspaces) app.use((req, res, next) => {
    const rawHosts = req.rawHeaders.filter((_value, index) => index % 2 === 0 && req.rawHeaders[index]?.toLowerCase() === "host");
    if (rawHosts.length !== 1) { res.sendStatus(404); return; }
    if (localRequest(req) && req.path.startsWith("/internal/gateway/")) { next(); return; }
    if (req.path.startsWith("/internal/") || /^\/admin(?:\/|$)/i.test(req.path)) { res.sendStatus(404); return; }
    try {
      const dispatch = workspaces.dispatch(req.headers.host ?? "");
      if (dispatch) { dispatch(req, res, next); return; }
      if (req.headers.host !== new URL(publicUrl).host && !localRequest(req)) { res.sendStatus(404); return; }
      next();
    } catch { res.status(503).json({ error: "GATEWAY_HOST_UNAVAILABLE" }); }
  });
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
  if (opts.gatewayHealth) {
    app.get("/internal/gateway/health", (req, res) => {
      const port = (server.address() as { port: number }).port;
      if (!localRequest(req)) {
        res.sendStatus(404);
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({ service: "machine-gateway", pid: opts.gatewayHealth!.pid, creationTime: opts.gatewayHealth!.creationTime,
        buildId: opts.gatewayHealth!.buildId, port, publicUrl, ...(workspaces ? { unified: true } : {}) });
    });
  }
  if (workspaces && opts.gatewayHealth) {
    const guard: express.RequestHandler = (req, res, next) => {
      if (!localRequest(req)) { res.sendStatus(404); return; }
      res.setHeader("Cache-Control", "no-store");
      next();
    };
    const failure = (res: Response, error: unknown) => res.status(409).json({
      code: typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "GATEWAY_WORKSPACE_UNAVAILABLE",
    });
    app.get("/internal/gateway/workspaces", guard, (_req, res) => { res.json({ workspaces: workspaces.list() }); });
    app.get("/internal/gateway/workspaces/:id", guard, (req, res) => {
      try { res.json(workspaces.status(z.string().parse(req.params.id))); } catch (error) { failure(res, error); }
    });
    app.post("/internal/gateway/workspaces/:id/start", guard, express.json({ limit: "8kb" }), async (req, res) => {
      try {
        const request = z.object({ lease: z.string().min(1).max(8192), port: z.number().int().min(0).max(65535).optional(),
          tunnel: z.boolean().optional() }).strict().parse(req.body);
        const runtime = await workspaces.start(z.string().parse(req.params.id), request);
        res.json({ started: true, runtime });
      } catch (error) { failure(res, error); }
    });
    app.post("/internal/gateway/shutdown", guard, express.json({ limit: "1mb" }), async (req, res) => {
      try {
        const identity = z.object({ workspaceId: z.string().regex(/^[a-f0-9]{12}$/), workspaceRoot: z.string(),
          pid: z.number().int().positive(), startedAt: z.string().datetime(), port: z.number().int().min(1).max(65535),
          runtimeBuildId: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict();
        const body = z.object({ maintenanceToken: z.string().uuid(), expectedOwner: z.object({
          pid: z.number().int().positive(), creationTime: z.string(), buildId: z.string().regex(/^[a-f0-9]{64}$/),
        }).strict(), workspaces: z.array(identity).max(10000) }).strict().parse(req.body);
        const stateDir = getStateDir();
        const assertOwner = async () => {
          const { readGatewaySupervisorRuntime, readGatewayLock, gatewaySupervisorLockFile, sameGatewayPath } = await import("../gateway/supervisor.js");
          assertMaintenanceHandle(stateDir, { token: body.maintenanceToken, path: maintenanceLockPath(stateDir), release: () => false });
          const runtime = readGatewaySupervisorRuntime(stateDir);
          const currentOwner = readGatewayLock(gatewaySupervisorLockFile(stateDir));
          const owner = body.expectedOwner;
          if (!runtime || currentOwner.pid !== owner.pid || currentOwner.creationTime !== owner.creationTime || currentOwner.buildId !== owner.buildId ||
              !sameGatewayPath(currentOwner.executable, runtime.executable) || runtime.pid !== owner.pid || runtime.creationTime !== owner.creationTime || runtime.buildId !== owner.buildId ||
              owner.pid !== opts.gatewayHealth!.pid || owner.creationTime !== opts.gatewayHealth!.creationTime ||
              owner.buildId !== opts.gatewayHealth!.buildId || !runtime.ports.includes((server.address() as { port: number }).port)) {
            throw new GatewayRegistryError("GATEWAY_OWNER_MISMATCH");
          }
          workspaces.prepareShutdown(body.workspaces);
        };
        await assertOwner();
        res.json({ shuttingDown: true });
        if (opts.onShutdown) opts.onShutdown();
        else void close("SIGTERM");
      } catch (error) { failure(res, error); }
    });
  }
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
  let resolveClosed!: () => void;
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const close = (reason: ShutdownReason = "SIGTERM"): Promise<void> => {
    if (closePromise) return closePromise;
    pairing.invalidateAll();
    closePromise = (async () => {
      await workspaces?.close(reason);
      await new Promise<void>(resolve => {
        const deadline = setTimeout(() => server.closeAllConnections(), 1000);
        deadline.unref();
        server.close(() => { clearTimeout(deadline); resolve(); });
      });
      resolveClosed();
    })();
    return closePromise;
  };
  return {
    authStore,
    pairing,
    pairingCode: session.code,
    pairingExpiresAt: session.expiresAt,
    port: (server.address() as { port: number }).port,
    publicUrl,
    closed,
    localBaseUrl: () => `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close,
  };
}
