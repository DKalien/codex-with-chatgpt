import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { Workspace } from "../workspace/manager.js";
import { AuthStore, CONNECTOR_CONTRACT_VERSION, DESKTOP_CONTROL_SCOPE } from "../auth/store.js";
import { createOAuthRouter } from "../auth/oauth.js";
import { bearerAuth } from "../auth/middleware.js";
import { PairingManager } from "../pairing/manager.js";
import { createMcpServer } from "../mcp/server.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { DesktopError } from "../desktop/store.js";
import { isWriteProbeEnabled } from "../mcp/write-probe.js";
import { createMcpHttpHandler } from "../mcp/http.js";
import { createCompanionRouter } from "./companion.js";
import { CloudflaredQuickTunnel } from "../tunnel/cloudflared.js";
import { CloudflaredNamedTunnel } from "../tunnel/cloudflared-named.js";
import type { TunnelProvider } from "../tunnel/provider.js";
import { namedTunnelBinding, readTunnelState } from "../tunnel/state.js";
import { Logger, nullLogger } from "../logger/index.js";
import { DEFAULT_HOST, DEFAULT_PORT } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { getRuntimeBuildId, isRuntimeBuildId } from "../build-id.js";
import { writeRuntimeState, clearRuntimeState, type RuntimeState } from "./runtime.js";
import { readRuntimeUpgrade } from "../core/upgrade.js";
import { projectRuntimeUpgrade } from "../workflow/request.js";

function tunnelForWorkspace(workspaceId: string, logger: Logger): TunnelProvider {
  const binding = namedTunnelBinding(readTunnelState(workspaceId));
  if (binding) {
    return new CloudflaredNamedTunnel({
      tunnelName: binding.tunnelName,
      hostname: binding.hostname,
      logger,
    });
  }
  return new CloudflaredQuickTunnel(logger);
}

export interface BridgeOptions {
  workspaceRoot: string;
  port?: number;
  host?: string;
  logger?: Logger;
  tunnelProvider?: TunnelProvider;
  /** Persist runtime state file (disable in tests). */
  persistRuntime?: boolean;
  authStoreFile?: string;
  pairingTtlMs?: number;
  accessTokenTtlMs?: number;
  /** Build artifact ID captured at startup; source/test runs may inject null or a valid ID. */
  runtimeBuildId?: string | null;
}

export interface Bridge {
  workspace: Workspace;
  port: number;
  host: string;
  adminToken: string;
  authStore: AuthStore;
  pairing: PairingManager;
  tunnel: TunnelProvider;
  getPublicBaseUrl(): string | null;
  localBaseUrl(): string;
  close(): Promise<void>;
}

/**
 * Listen on the preferred port; on EADDRINUSE fall back to an ephemeral port.
 */
function listen(app: express.Express, host: string, preferredPort: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, allowFallback: boolean): void => {
      const server = app.listen(port, host);
      server.once("listening", () => {
        const address = server.address();
        const actual = typeof address === "object" && address ? address.port : port;
        resolve({ server, port: actual });
      });
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && allowFallback) {
          tryListen(0, false);
        } else {
          reject(error);
        }
      });
    };
    tryListen(preferredPort, preferredPort !== 0);
  });
}

export async function startBridge(opts: BridgeOptions): Promise<Bridge> {
  const logger = opts.logger ?? nullLogger;
  const workspace = new Workspace(opts.workspaceRoot);
  const host = opts.host ?? DEFAULT_HOST;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The bridge only binds to loopback addresses. Public exposure goes through the tunnel.");
  }

  const authStore = new AuthStore(workspace.id, { file: opts.authStoreFile });
  const pairing = new PairingManager(workspace.id, { ttlMs: opts.pairingTtlMs });
  const tunnel = opts.tunnelProvider ?? tunnelForWorkspace(workspace.id, logger);
  const adminToken = `c2c_admin_${randomBytes(24).toString("base64url")}`;
  const runtimeBuildId = opts.runtimeBuildId === undefined ? getRuntimeBuildId() : opts.runtimeBuildId;
  if (runtimeBuildId !== null && !isRuntimeBuildId(runtimeBuildId)) {
    throw new Error("runtimeBuildId must be a 64-character lowercase SHA-256 hex string or null");
  }

  let publicBaseUrl: string | null = null;

  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  const getBaseUrl = (req: Request): string => {
    if (publicBaseUrl) return publicBaseUrl;
    const proto = req.protocol;
    const hostHeader = req.get("host") ?? `${host}:${port}`;
    return `${proto}://${hostHeader}`;
  };

  // ---- Health (public but minimal) ---------------------------------------

  const startedAt = new Date().toISOString();
  app.get("/health", (_req, res) => {
    res.json({ service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id, status: "ok",
      pid: process.pid, startedAt, ...(runtimeBuildId === null ? {} : { runtimeBuildId }) });
  });

  // ---- OAuth + discovery ---------------------------------------------------

  app.use(
    createOAuthRouter({
      store: authStore,
      pairing,
      workspaceName: workspace.name,
      getBaseUrl,
      logger,
    })
  );

  // ---- MCP endpoint (bearer-protected) --------------------------------------

  const mcpHandler = createMcpHttpHandler(() => createMcpServer({
    workspace,
    logger,
    desktopAuthorize: (auth: AuthInfo) => {
      const verdict = authStore.verifyAccessToken(auth.token);
      if (!verdict.ok || verdict.record.workspaceId !== workspace.id || verdict.record.clientId !== auth.clientId || !verdict.record.scopes.includes(DESKTOP_CONTROL_SCOPE)) {
        throw new DesktopError("UNAUTHORIZED", "OAuth 授权已失效，请重新授权后再发送。" );
      }
    },
    desktopCompatibility: (auth: AuthInfo | undefined) =>
      auth?.token ? authStore.desktopCompatibility(auth.token) : { status: "unknown" },
    runtimeUpgrade: () => {
      try {
        const upgrade = readRuntimeUpgrade(
          workspace,
          runtimeBuildId ? { runtimeBuildId } : null,
          "fast",
        );
        return projectRuntimeUpgrade(upgrade);
      } catch {
        return "unknown";
      }
    },
  }), logger);
  app.all(
    "/mcp",
    express.json({ limit: "8mb" }),
    bearerAuth({ store: authStore, workspaceId: workspace.id, getBaseUrl, logger }),
    (req: Request, res: Response) => {
      void mcpHandler(req, res);
    }
  );

  // ---- Companion public transport (scoped credential; tunnel-reachable) ----
  // 不使用 admin token / OAuth bearer；不代理 MCP/Desktop。
  app.use(
    "/api/companion/v1",
    createCompanionRouter({ workspaceId: workspace.id }),
  );

  // ---- Admin API (loopback + admin token only; used by the CLI/Skill) --------

  const adminGuard = (req: Request, res: Response, next: NextFunction): void => {
    // Defense in depth: reject anything that arrived through a proxy/tunnel.
    const remote = req.socket.remoteAddress ?? "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const viaProxy = Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);
    const header = req.headers.authorization ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!isLoopback || viaProxy || token !== adminToken) {
      res.status(404).end(); // do not advertise the admin surface
      return;
    }
    next();
  };

  app.post("/admin/pairing", adminGuard, (_req, res) => {
    const session = pairing.create();
    logger.info("Created pairing session");
    res.json({ code: session.code, expiresAt: session.expiresAt });
  });

  app.get("/admin/info", adminGuard, (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceRoot: workspace.root,
      port,
      publicUrl: publicBaseUrl,
      tunnel: tunnel.status(),
      tokenCount: authStore.tokenCount(),
      desktopCompatibility: authStore.desktopCompatibility(),
      connectorContractVersion: CONNECTOR_CONTRACT_VERSION,
      pairingActive: pairing.hasActiveSession(),
      writeProbeEnabled: isWriteProbeEnabled(),
      pid: process.pid,
      startedAt,
      ...(runtimeBuildId === null ? {} : { runtimeBuildId }),
    });
  });

  app.post("/admin/tunnel/start", adminGuard, (_req, res) => {
    tunnel
      .start(port)
      .then((url) => {
        publicBaseUrl = url;
        persistRuntime();
        res.json({ url });
      })
      .catch((error: Error) => {
        logger.error(`Tunnel start failed: ${error.message}`);
        res.status(500).json({ error: "tunnel_failed", message: error.message });
      });
  });

  app.post("/admin/tunnel/stop", adminGuard, (_req, res) => {
    void tunnel.stop().then(() => {
      publicBaseUrl = null;
      persistRuntime();
      res.json({ stopped: true });
    });
  });

  app.post("/admin/revoke-all", adminGuard, (_req, res) => {
    const count = authStore.revokeAll();
    pairing.invalidateAll();
    logger.info(`Revoked all tokens (${count})`);
    res.json({ revoked: count });
  });

  app.post("/admin/shutdown", adminGuard, (_req, res) => {
    res.json({ shuttingDown: true });
    setTimeout(() => {
      void shutdown().then(() => process.exit(0));
    }, 100);
  });

  const { server, port } = await listen(app, host, opts.port ?? DEFAULT_PORT);
  logger.info(`Bridge listening on ${host}:${port} for workspace ${workspace.name} (${workspace.id})`);

  const persistRuntime = (): void => {
    if (opts.persistRuntime === false) return;
    const state: RuntimeState = {
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      pid: process.pid,
      port,
      adminToken,
      publicUrl: publicBaseUrl,
      startedAt,
      ...(runtimeBuildId === null ? {} : { runtimeBuildId }),
    };
    writeRuntimeState(state);
  };
  persistRuntime();

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await tunnel.stop().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (opts.persistRuntime !== false) clearRuntimeState(workspace.id, { pid: process.pid, startedAt, adminToken });
    logger.info("Bridge stopped");
  };

  return {
    workspace,
    port,
    host,
    adminToken,
    authStore,
    pairing,
    tunnel,
    getPublicBaseUrl: () => publicBaseUrl,
    localBaseUrl: () => `http://${host}:${port}`,
    close: shutdown,
  };
}
