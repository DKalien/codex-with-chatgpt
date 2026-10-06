import express, { type Request, type Response } from "express";
import type { Server } from "node:http";
import path from "node:path";
import { AuthStore } from "../auth/store.js";
import { createOAuthRouter } from "../auth/oauth.js";
import { bearerAuth } from "../auth/middleware.js";
import { ensureDir, getStateDir } from "../config/paths.js";
import { createMcpHttpHandler } from "../mcp/http.js";
import { createMcpServer } from "../mcp/server.js";
import { nullLogger } from "../logger/index.js";
import { PairingManager } from "../pairing/manager.js";
import { authorized, readRemote, RemoteError } from "./store.js";
import { Workspace } from "../workspace/manager.js";

export interface OfficialRemoteServerOptions {
  workspaceRoot: string;
  port: number;
  publicUrl: string;
  authStoreFile?: string;
  pairingTtlMs?: number;
}

export interface OfficialRemoteServer {
  workspace: Workspace;
  authStore: AuthStore;
  pairing: PairingManager;
  pairingCode: string;
  pairingExpiresAt: number;
  port: number;
  publicUrl: string;
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
  const authStore = new AuthStore(workspace.id, { file: authStoreFile });
  const pairing = new PairingManager(workspace.id, { ttlMs: opts.pairingTtlMs });
  const app = express();
  app.disable("x-powered-by");
  app.use(createOAuthRouter({
    store: authStore,
    pairing,
    workspaceName: workspace.name,
    getBaseUrl: () => publicUrl,
    logger: nullLogger,
  }));

  const handleMcp = createMcpHttpHandler(() => createMcpServer({
    workspace,
    logger: nullLogger,
    profile: "official",
  }), nullLogger);
  app.all("/mcp", express.json({ limit: "8mb" }), bearerAuth({
    store: authStore,
    workspaceId: workspace.id,
    getBaseUrl: () => publicUrl,
    logger: nullLogger,
  }), (req: Request, res: Response) => { void handleMcp(req, res); });

  const server = await listen(app, opts.port);
  const session = pairing.create();
  let closePromise: Promise<void> | undefined;
  return {
    workspace,
    authStore,
    pairing,
    pairingCode: session.code,
    pairingExpiresAt: session.expiresAt,
    port: (server.address() as { port: number }).port,
    publicUrl,
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
