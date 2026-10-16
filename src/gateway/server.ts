import express, { type Request, type RequestHandler } from "express";
import path from "node:path";
import { AuthStore, safeEqual } from "../auth/store.js";
import { createOAuthRouter } from "../auth/oauth.js";
import { bearerAuth } from "../auth/middleware.js";
import { getStateDir } from "../config/paths.js";
import { nullLogger } from "../logger/index.js";
import { createMcpHttpHandler } from "../mcp/http.js";
import { createMcpServer } from "../mcp/server.js";
import { PairingManager } from "../pairing/manager.js";
import { createCompanionRouter } from "../companion/api.js";
import { C2CError } from "../errors.js";
import { Registry } from "./registry.js";

export const GATEWAY_AUTH_ID = "machine-gateway";

export interface GatewayServerOptions {
  port: number;
  publicUrl: string;
  runtimeToken: string;
  onShutdown?: () => void;
}

export interface GatewayServer {
  port: number;
  pairingCode(): { code: string; expiresAt: number };
  close(): Promise<void>;
}

export async function startGatewayServer(opts: GatewayServerOptions): Promise<GatewayServer> {
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new C2CError("INVALID_PORT", "端口无效。");
  const publicUrl = new URL(opts.publicUrl).origin;
  const registry = new Registry();
  const authStore = new AuthStore(GATEWAY_AUTH_ID, { file: path.join(getStateDir(), "auth", "gateway.json") });
  const pairing = new PairingManager(GATEWAY_AUTH_ID);
  let port = 0;

  // 本机直连：回环地址 + Host 为 127.0.0.1:<port> 或 localhost:<port> + 无代理头（cloudflared 也从回环连入，靠头区分）
  const isLocal = (req: Request): boolean =>
    req.socket.remoteAddress === "127.0.0.1" && (req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`) &&
    !Object.keys(req.headers).some(h => h === "forwarded" || h.startsWith("x-forwarded-") || h.startsWith("cf-"));
  const localOnly: RequestHandler = (req, res, next) => { if (isLocal(req)) next(); else res.status(404).json({ error: "NOT_LOCAL", message: "仅限本机直连访问（Host 须为 127.0.0.1 或 localhost 加端口）。" }); };
  const internalAuth: RequestHandler = (req, res, next) => {
    const token = req.headers["x-c2c-runtime-token"];
    if (typeof token === "string" && safeEqual(token, opts.runtimeToken)) next();
    else res.status(401).json({ error: "UNAUTHORIZED", message: "runtime token 无效。" });
  };

  const app = express();
  app.disable("x-powered-by");
  // 公网与本机都可访问
  app.use(createOAuthRouter({
    store: authStore, pairing, workspaceName: "本机 Gateway", getBaseUrl: () => publicUrl, logger: nullLogger,
  }));
  const handleMcp = createMcpHttpHandler(() => createMcpServer({ registry }), nullLogger);
  app.all("/mcp", express.json({ limit: "8mb" }), bearerAuth({
    store: authStore, workspaceId: GATEWAY_AUTH_ID, getBaseUrl: () => publicUrl, logger: nullLogger,
    allowAnonymousDiscovery: true,
  }), (req, res) => { void handleMcp(req, res); });

  // 以下仅本机直连
  app.use(localOnly);
  app.use("/companion/v1", createCompanionRouter({ registry }));
  app.use("/internal", internalAuth);
  app.get("/internal/health", (_req, res) => { res.json({ ok: true, pid: process.pid, port }); });
  app.post("/internal/pairing", (_req, res) => { res.json(pairing.create()); });
  app.post("/internal/shutdown", (_req, res) => {
    res.json({ shuttingDown: true });
    res.once("finish", () => opts.onShutdown?.());
  });

  const server = await new Promise<import("node:http").Server>((resolve, reject) => {
    const s = app.listen(opts.port, "127.0.0.1");
    s.once("listening", () => resolve(s));
    s.once("error", reject);
  });
  port = (server.address() as { port: number }).port;

  let closing: Promise<void> | undefined;
  return {
    port,
    pairingCode: () => { const { code, expiresAt } = pairing.create(); return { code, expiresAt }; },
    close: () => closing ??= new Promise<void>(resolve => {
      pairing.invalidateAll();
      const timer = setTimeout(() => server.closeAllConnections(), 1000);
      timer.unref();
      server.close(() => { clearTimeout(timer); resolve(); });
    }),
  };
}
