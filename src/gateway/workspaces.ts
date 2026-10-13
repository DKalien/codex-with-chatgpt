import { type RequestHandler } from "express";
import { startBridge, type Bridge } from "../bridge/server.js";
import { findBridgeObservation, readRuntimeState } from "../bridge/runtime.js";
import { claimStartupLease, decodeStartupLease } from "../core/startup-lease.js";
import { Workspace } from "../workspace/manager.js";
import { GatewayRegistry, GatewayRegistryError } from "./registry.js";
import { normalizeNamedTunnelHostname } from "../tunnel/cloudflared-named.js";
import { namedTunnelBinding, readTunnelState } from "../tunnel/state.js";
import type { TunnelProvider, TunnelStatus } from "../tunnel/provider.js";
import type { ShutdownReason } from "../process/bridge-provenance.js";

export interface HostedWorkspaceIdentity {
  workspaceId: string;
  workspaceRoot: string;
  pid: number;
  startedAt: string;
  port: number;
  runtimeBuildId: string | null;
}

/** 仅管理本 workspace 的 attachment，共享 tunnel child 由 Supervisor 持有。 */
class SharedTunnel implements TunnelProvider {
  readonly name = "cloudflare-named";
  private attached = false;
  constructor(private readonly origin: string, private readonly available: () => boolean) {}
  async start(): Promise<string> {
    if (!this.available()) throw new GatewayRegistryError("GATEWAY_TUNNEL_UNAVAILABLE");
    this.attached = true;
    return this.origin;
  }
  async stop(): Promise<void> { this.attached = false; }
  async restart(): Promise<string> { await this.stop(); return this.start(); }
  status(): TunnelStatus {
    const running = this.attached && this.available();
    return { running, url: running ? this.origin : null, provider: this.name };
  }
  getPublicUrl(): string | null { return this.status().url; }
  async doctor() {
    const status = this.status();
    return { provider: this.name, binaryFound: true, binaryPath: null, running: status.running,
      url: status.url, problems: status.running ? [] : ["共享 tunnel 未连接或此 workspace 未开启"] };
  }
}

type Context = { bridge: Bridge; identity: HostedWorkspaceIdentity };

/** 业务状态仍由原 workspace stores 持有；这里只保存运行中的 contexts 和完整关闭证据。 */
export class GatewayWorkspaces {
  private readonly contexts = new Map<string, Context>();
  private readonly lastClosed = new Map<string, HostedWorkspaceIdentity>();
  private readonly starting = new Set<Promise<HostedWorkspaceIdentity>>();
  private closing = false;
  constructor(private readonly registry: GatewayRegistry, private readonly machineOrigin: string,
    private readonly tunnelAvailable: () => boolean) {}

  private registrations() {
    return this.registry.list().map(entry => {
      const workspace = new Workspace(entry.root);
      if (workspace.id !== entry.workspaceId || workspace.root !== entry.root) {
        throw new GatewayRegistryError("GATEWAY_WORKSPACE_ID_MISMATCH");
      }
      return { entry, workspace };
    });
  }

  private origins(): Map<string, { workspace: Workspace; origin: string }> {
    const hosts = new Map<string, { workspace: Workspace; origin: string }>();
    for (const { workspace } of this.registrations()) {
      const state = readTunnelState(workspace.id);
      if (state.workspaceId !== workspace.id) throw new GatewayRegistryError("GATEWAY_WORKSPACE_ID_MISMATCH");
      const binding = namedTunnelBinding(state);
      if (!binding) continue;
      if (normalizeNamedTunnelHostname(binding.hostname) !== binding.hostname) throw new GatewayRegistryError("GATEWAY_HOST_UNAVAILABLE");
      const origin = `https://${binding.hostname}`;
      const host = new URL(origin).host;
      if (hosts.has(host) || host === new URL(this.machineOrigin).host) {
        throw new GatewayRegistryError("GATEWAY_DUPLICATE_HOST");
      }
      hosts.set(host, { workspace, origin });
    }
    return hosts;
  }

  list(): HostedWorkspaceIdentity[] { return [...this.contexts.values()].map(context => ({ ...context.identity })); }
  status(workspaceId: string) {
    if (!this.registrations().some(({ workspace }) => workspace.id === workspaceId)) {
      throw new GatewayRegistryError("GATEWAY_UNKNOWN_WORKSPACE");
    }
    const current = this.contexts.get(workspaceId)?.identity;
    const previous = this.lastClosed.get(workspaceId);
    return { hosted: !!current, current: current ? { ...current } : null,
      lastClosed: previous ? { ...previous } : null };
  }

  dispatch(host: string): RequestHandler | null {
    const registration = this.origins().get(host);
    if (!registration) return null;
    const context = this.contexts.get(registration.workspace.id);
    return (req, res, next) => {
      if (/^\/(?:admin|internal)(?:\/|$)/i.test(req.path)) { res.sendStatus(404); return; }
      if (!context || context.bridge.getPublicBaseUrl() !== registration.origin || !context.bridge.tunnel.status().running) {
        res.status(503).json({ error: "GATEWAY_WORKSPACE_NOT_PUBLIC" });
        return;
      }
      context.bridge.expressApp(req, res, next);
    };
  }

  start(workspaceId: string, request: { lease: string; port?: number; tunnel?: boolean }): Promise<HostedWorkspaceIdentity> {
    if (this.closing) return Promise.reject(new GatewayRegistryError("GATEWAY_CLOSING"));
    const operation = this.startContext(workspaceId, request);
    this.starting.add(operation);
    void operation.finally(() => this.starting.delete(operation)).catch(() => undefined);
    return operation;
  }

  private async startContext(workspaceId: string, request: { lease: string; port?: number; tunnel?: boolean }) {
    const registration = [...this.origins().values()].find(item => item.workspace.id === workspaceId);
    if (!registration) throw new GatewayRegistryError("GATEWAY_UNKNOWN_WORKSPACE");
    const { workspace, origin } = registration;
    claimStartupLease(decodeStartupLease(request.lease), workspace);
    if (this.contexts.has(workspaceId)) throw new GatewayRegistryError("GATEWAY_WORKSPACE_RUNNING");
    const observation = await findBridgeObservation(workspace.id);
    if (observation.state !== "stopped") throw new GatewayRegistryError(
      observation.state === "healthy" ? "GATEWAY_WORKSPACE_RUNNING" : "GATEWAY_WORKSPACE_UNKNOWN");
    if (this.closing) throw new GatewayRegistryError("GATEWAY_CLOSING");
    const bridge = await startBridge({ workspaceRoot: workspace.root, port: request.port, hosting: "gateway",
      publicOrigin: origin, tunnelProvider: new SharedTunnel(origin, this.tunnelAvailable) });
    const runtime = readRuntimeState(workspace.id)!;
    const identity: HostedWorkspaceIdentity = { workspaceId, workspaceRoot: workspace.root, pid: runtime.pid,
      startedAt: runtime.startedAt, port: bridge.port, runtimeBuildId: runtime.runtimeBuildId ?? null };
    const context = { bridge, identity };
    this.contexts.set(workspaceId, context);
    void bridge.closed.then(() => {
      if (this.contexts.get(workspaceId) === context) {
        this.contexts.delete(workspaceId);
        this.lastClosed.set(workspaceId, identity);
      }
    });
    try { if (request.tunnel) await bridge.startTunnel(); }
    catch (error) { await bridge.close(); throw error; }
    return { ...identity };
  }

  prepareShutdown(expected: HostedWorkspaceIdentity[]): void {
    const current = this.list();
    if (this.starting.size || expected.length !== current.length || new Set(expected.map(item => item.workspaceId)).size !== expected.length ||
        current.some(item => !expected.some(other => item.workspaceId === other.workspaceId && item.workspaceRoot === other.workspaceRoot &&
          item.pid === other.pid && item.startedAt === other.startedAt && item.port === other.port && item.runtimeBuildId === other.runtimeBuildId))) {
      throw new GatewayRegistryError("GATEWAY_WORKSPACES_CHANGED");
    }
    this.closing = true;
  }

  async close(reason: ShutdownReason = "SIGTERM"): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.starting]);
    await Promise.all([...this.contexts.values()].map(context => context.bridge.close(reason)));
  }
}
