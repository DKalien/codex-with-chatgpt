import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getStateDir } from "../config/paths.js";
import { requestLoopback } from "../bridge/loopback-http.js";
import type { RuntimeState } from "../bridge/runtime.js";
import { probeProcess, processProbeSchema, resolveDaemonSpawnHelperPath, resolveDaemonSpawnPython, type ProcessProbe } from "../process/process-probe.js";
import { Workspace } from "../workspace/manager.js";
import { GatewayRegistry } from "./registry.js";
import { gatewaySupervisorConfigFile, gatewaySupervisorRuntimeFile, gatewaySupervisorLockFile,
  readGatewaySupervisorConfig, readGatewaySupervisorRuntime, readGatewayLock, listGatewaySupervisorLaunchPins,
  sameGatewayPath, sameGatewaySnapshot, snapshotGatewayFile,
  type GatewaySupervisorConfig, type GatewaySupervisorRuntime } from "./supervisor.js";

export interface GatewayControlOptions {
  stateDir?: string;
  probeProcess?: (pid: number, expectedCreationTime?: string) => Promise<ProcessProbe>;
  requestLoopback?: typeof requestLoopback;
}
export interface VerifiedGateway {
  config: GatewaySupervisorConfig;
  runtime: GatewaySupervisorRuntime;
  request<T>(method: "GET" | "POST", route: string, body?: unknown): Promise<T>;
}

function fail(message: string): never {
  throw new Error(`GATEWAY_UNIFIED_UNVERIFIED: ${message}；未启动或替换 workspace。`);
}

/** Fresh registry membership grants routing only; it never starts every registered workspace. */
export function isUnifiedWorkspace(workspace: Workspace, stateDir = getStateDir()): boolean {
  if (readGatewaySupervisorConfig(stateDir)?.unified !== true) return false;
  const entry = new GatewayRegistry(stateDir).list().find(item => item.workspaceId === workspace.id);
  if (!entry) return false;
  const canonical = new Workspace(entry.root);
  if (canonical.id !== workspace.id || canonical.root !== entry.root || canonical.root !== workspace.root)
    fail("registry workspace canonical 身份不一致");
  return true;
}

const serverLockSchema = z.object({ pid: z.number().int().positive(), createdAt: z.number().finite().positive(),
  ownerNonce: z.string().uuid() }).strict();

/** Read-only verification; safe while the caller owns machine maintenance. */
export async function requireVerifiedGateway(options: GatewayControlOptions = {}): Promise<VerifiedGateway> {
  const stateDir = path.resolve(options.stateDir ?? getStateDir());
  for (const dir of [stateDir, path.join(stateDir, "gateway")]) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !sameGatewayPath(fs.realpathSync.native(dir), dir))
      fail("Gateway state directory 非规范目录");
  }
  const files = [gatewaySupervisorConfigFile(stateDir), gatewaySupervisorRuntimeFile(stateDir),
    gatewaySupervisorLockFile(stateDir), path.join(stateDir, "gateway", "server.lock")];
  const snapshots = files.map(file => snapshotGatewayFile(file));
  const config = readGatewaySupervisorConfig(stateDir);
  const runtime = readGatewaySupervisorRuntime(stateDir);
  const lock = readGatewayLock(files[2]);
  const server = serverLockSchema.parse(JSON.parse(snapshots[3]!.bytes.toString("utf8")));
  if (!config || config.unified !== true || !runtime) fail("unified Gateway runtime 尚未就绪");
  if (!sameGatewayPath(config.stableLauncher, path.join(stateDir, "bin", "c2c.js")) ||
      runtime.pid !== lock.pid || runtime.creationTime !== lock.creationTime || runtime.buildId !== lock.buildId ||
      !sameGatewayPath(runtime.executable, lock.executable) || server.pid !== runtime.pid ||
      runtime.ports.length !== 1 || runtime.ports[0] !== config.port || runtime.children?.length !== 2 ||
      new Set([runtime.pid, ...runtime.children.map(child => child.pid)]).size !== 3 ||
      runtime.children.some(child => child.buildId !== runtime.buildId || child.ports.length !== 0) ||
      !sameGatewayPath(runtime.children[0].executable, config.cloudflaredPath) ||
      !sameGatewayPath(runtime.children[1].executable, config.tunnelClientPath) || listGatewaySupervisorLaunchPins(stateDir).length)
    fail("Gateway config/runtime/owner/children 身份不一致");
  const probe = options.probeProcess ?? ((pid, creation) =>
    probeProcess(pid, resolveDaemonSpawnPython(), resolveDaemonSpawnHelperPath(), creation));
  const http = options.requestLoopback ?? requestLoopback;
  const assertSnapshots = (): void => {
    files.forEach((file, index) => {
      if (!sameGatewaySnapshot(snapshots[index], snapshotGatewayFile(file, true))) fail("Gateway ownership 文件已改变");
    });
    if (listGatewaySupervisorLaunchPins(stateDir).length) fail("Gateway launch handoff 未完成");
  };
  const assertNative = async (): Promise<void> => {
    for (const expected of [runtime, ...runtime.children!]) {
      const value = processProbeSchema.safeParse(await probe(expected.pid, expected.creationTime));
      if (!value.success || value.data.status !== "identified" || value.data.pid !== expected.pid ||
          value.data.creationTime !== expected.creationTime || !value.data.executable ||
          !sameGatewayPath(value.data.executable, expected.executable)) fail("Gateway native 进程身份无法确认");
    }
  };
  const assertHealth = async (): Promise<void> => {
    const response = await http({ port: config.port, path: "/internal/gateway/health", timeoutMs: 2000 });
    if (response.status !== 200) fail("Gateway health HTTP 状态异常");
    const health = JSON.parse(response.body) as Record<string, unknown>;
    if (!health || health.service !== "machine-gateway" || health.pid !== runtime.pid ||
        health.creationTime !== runtime.creationTime || health.buildId !== runtime.buildId ||
        health.port !== config.port || health.publicUrl !== new URL(config.publicUrl).origin || health.unified !== true ||
        Object.keys(health).sort().join(",") !== "buildId,creationTime,pid,port,publicUrl,service,unified")
      fail("运行中的 Gateway build 未提供 unified 服务或 health 身份不匹配");
  };
  const verify = async (): Promise<void> => {
    assertSnapshots();
    await assertNative();
    await assertHealth();
    assertSnapshots();
    await assertNative();
  };
  await verify();
  return { config, runtime, async request<T>(method: "GET" | "POST", route: string, body?: unknown): Promise<T> {
    if (!route.startsWith("/internal/gateway/")) fail("非法 Gateway control route");
    await verify();
    const response = await http({ port: config.port, path: route, method, timeoutMs: 20_000,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    // shutdown ACK can race legitimate owner retirement; the caller must prove native exit.
    if (!(method === "POST" && route === "/internal/gateway/shutdown" && response.status >= 200 && response.status < 300)) {
      assertSnapshots();
      await assertNative();
    }
    if (response.status < 200 || response.status >= 300) {
      let code = "GATEWAY_CONTROL_REJECTED";
      try { const value = JSON.parse(response.body); const received = value.code ?? value.error; if (typeof received === "string" && /^[A-Z0-9_]+$/.test(received)) code = received; } catch { /* bounded generic error */ }
      throw new Error(`${code}: Gateway control HTTP ${response.status}`);
    }
    return JSON.parse(response.body) as T;
  } };
}

export interface GatewayWorkspaceIdentity {
  workspaceId: string;
  workspaceRoot: string;
  pid: number;
  startedAt: string;
  port: number;
  runtimeBuildId: string | null;
}
export interface GatewayWorkspaceStatus {
  hosted: boolean;
  current: GatewayWorkspaceIdentity | null;
  lastClosed: GatewayWorkspaceIdentity | null;
}

/** An ACK, missing runtime file, or failed workspace port is never a close proof. */
export async function isGatewayWorkspaceClosed(gateway: VerifiedGateway, runtime: RuntimeState): Promise<boolean> {
  if (runtime.hosting !== "gateway" || gateway.runtime.pid !== runtime.pid ||
      gateway.runtime.buildId !== runtime.runtimeBuildId) fail("关闭前后 Gateway owner/build 不一致");
  const state = await gateway.request<GatewayWorkspaceStatus>("GET", `/internal/gateway/workspaces/${runtime.workspaceId}`);
  const closed = state.lastClosed;
  return state.hosted === false && state.current === null && !!closed && closed.workspaceId === runtime.workspaceId &&
    closed.workspaceRoot === runtime.workspaceRoot && closed.pid === runtime.pid && closed.port === runtime.port &&
    closed.startedAt === runtime.startedAt && closed.runtimeBuildId === (runtime.runtimeBuildId ?? null);
}
