import path from "node:path";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";
import { readCurrentInstall } from "../core/install.js";
import { MaintenanceBusyError, withMaintenanceLock } from "../core/maintenance-lock.js";
import { buildDaemonEnv, spawnDetachedDaemon } from "../process/daemon-spawn.js";
import { probeProcess, processProbeSchema, resolveDaemonSpawnHelperPath, resolveDaemonSpawnPython, type ProcessProbe } from "../process/process-probe.js";
import {
  createGatewaySupervisorLaunch, ensureGatewayDirectory, GatewaySupervisorError,
  gatewaySupervisorConfigFile, gatewaySupervisorLockFile, gatewaySupervisorRuntimeFile,
  listGatewaySupervisorLaunchPins, readGatewayLock, readGatewaySupervisorConfig, readGatewaySupervisorRuntime,
  sameGatewayPath, sameGatewaySnapshot, snapshotGatewayFile,
  type GatewayLaunchReservation, type GatewaySupervisorRuntime,
} from "./supervisor.js";

export interface GatewayStartupOptions {
  stateDir?: string;
  timeoutMs?: number;
  pollMs?: number;
  probeProcess?: (pid: number, expectedCreationTime?: string) => Promise<ProcessProbe>;
  spawnDaemon?: typeof spawnDetachedDaemon;
  fetchImpl?: typeof fetch;
}

const serverLockSchema = z.object({ pid: z.number().int().positive(), createdAt: z.number().finite().positive(),
  ownerNonce: z.string().uuid() }).strict();

function ownershipError(message: string): never {
  throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_OWNERSHIP_LOST", `${message}；保留现有 runtime、锁与 launch pin，需人工核对。`);
}

/** 复用已核验的机器 Gateway；只有已配置且无 owner 的机器可冷启动。 */
export async function ensureConfiguredGatewaySupervisor(options: GatewayStartupOptions = {}): Promise<GatewaySupervisorRuntime | null> {
  const stateDir = path.resolve(options.stateDir ?? getStateDir());
  if (!snapshotGatewayFile(gatewaySupervisorConfigFile(stateDir), true)) return null;
  readGatewaySupervisorConfig(stateDir);
  const logFile = path.join(ensureDir(path.join(stateDir, "logs")), "gateway-supervisor.out.log");
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  const probe = options.probeProcess ?? ((pid, creation) =>
    probeProcess(pid, resolveDaemonSpawnPython(), resolveDaemonSpawnHelperPath(), creation));
  let reservation: GatewayLaunchReservation | undefined;
  let entry: string | undefined;
  let spawned = false;
  let first = true;
  let configIdentity: ReturnType<typeof snapshotGatewayFile> | undefined;
  const identity = async (expected: { pid: number; creationTime: string; executable: string }): Promise<void> => {
    const observed = processProbeSchema.safeParse(await probe(expected.pid, expected.creationTime));
    if (!observed.success || observed.data.pid !== expected.pid || observed.data.status !== "identified" ||
        observed.data.creationTime !== expected.creationTime || !observed.data.executable ||
        !sameGatewayPath(observed.data.executable, expected.executable)) ownershipError("Gateway native 进程身份无法确认");
  };
  while (Date.now() < deadline) {
    let state;
    try {
      state = withMaintenanceLock("gateway-ensure", (handle) => {
        ensureGatewayDirectory(stateDir);
        const configFile = gatewaySupervisorConfigFile(stateDir);
        const configSnapshot = snapshotGatewayFile(configFile);
        if (configIdentity !== undefined && !sameGatewaySnapshot(configIdentity, configSnapshot)) ownershipError("Gateway 配置在启动期间改变");
        configIdentity = configSnapshot;
        const config = readGatewaySupervisorConfig(stateDir);
        if (!config || !sameGatewayPath(config.stableLauncher, path.join(stateDir, "bin", "c2c.js")))
          ownershipError("Gateway stable launcher 与 machine 安装路径不一致");
        const runtimeSnapshot = snapshotGatewayFile(gatewaySupervisorRuntimeFile(stateDir), true);
        const runtime = readGatewaySupervisorRuntime(stateDir);
        const lockSnapshot = snapshotGatewayFile(gatewaySupervisorLockFile(stateDir), true);
        const lock = lockSnapshot ? readGatewayLock(gatewaySupervisorLockFile(stateDir)) : null;
        const serverFile = path.join(stateDir, "gateway", "server.lock");
        const serverSnapshot = snapshotGatewayFile(serverFile, true);
        let server = null;
        if (serverSnapshot) {
          try { server = serverLockSchema.parse(JSON.parse(serverSnapshot.bytes.toString("utf8"))); }
          catch { ownershipError("Gateway server.lock 内容无效"); }
        }
        const pins = listGatewaySupervisorLaunchPins(stateDir);
        if (pins.length > 1) ownershipError("Gateway 存在多个 launch pin");
        if (reservation && pins.length && (pins[0].file !== reservation.file || !sameGatewaySnapshot(pins[0].snapshot, reservation.snapshot)))
          ownershipError("Gateway launch pin 文件身份改变");
        if (server && (!lock || server.pid !== lock.pid)) ownershipError("Gateway server.lock 与 supervisor owner 不一致");
        if (runtime) {
          if (!lock || !server || runtime.pid !== lock.pid || runtime.creationTime !== lock.creationTime ||
              !sameGatewayPath(runtime.executable, lock.executable) || runtime.buildId !== lock.buildId ||
              runtime.ports.length !== 1 || runtime.ports[0] !== config.port || runtime.children?.length !== 2 ||
              new Set([runtime.pid, ...runtime.children.map(child => child.pid)]).size !== 3 ||
              runtime.children.some(child => child.buildId !== runtime.buildId || child.ports.length !== 0) ||
              !sameGatewayPath(runtime.children[0].executable, config.cloudflaredPath) ||
              !sameGatewayPath(runtime.children[1].executable, config.tunnelClientPath)) ownershipError("Gateway runtime、锁与配置身份不一致");
          if ((reservation && runtime.buildId !== reservation.launch.buildId) || pins.length) ownershipError("Gateway runtime handoff 尚未完成或 build 不一致");
        } else {
          if (reservation && !pins.length) ownershipError("Gateway launch pin 在 runtime 发布前消失");
          if (!pins.length && (lock || server || !first)) ownershipError("Gateway owner 尚未发布 runtime，且无合法 launch pin");
          if (!pins.length) {
            const installed = readCurrentInstall(stateDir, "fast");
            if (!installed) ownershipError("Gateway 缺少已安装 Core release");
            entry = path.join(installed.releaseRoot, "bin", "c2c.js");
            reservation = createGatewaySupervisorLaunch(installed.runtimeBuildId, stateDir, handle);
            spawned = true;
          } else reservation ??= pins[0];
        }
        return { config, runtime, lock, runtimeSnapshot, lockSnapshot, serverSnapshot, serverFile };
      }, stateDir);
    } catch (error) {
      if (!(error instanceof MaintenanceBusyError)) throw error;
      await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 100));
      continue;
    }
    if (spawned && first) {
      // maintenance 释放后由 pin 保留此次固定的 release。
      const env = buildDaemonEnv(process.env);
      env.C2C_STATE_DIR = stateDir;
      env.C2C_GATEWAY_SUPERVISOR_LAUNCH_PIN = reservation!.file;
      env.C2C_GATEWAY_SUPERVISOR_LAUNCH_IDENTITY = reservation!.identity;
      await (options.spawnDaemon ?? spawnDetachedDaemon)({ cmd: process.execPath,
        args: [entry!,
          "gateway", "supervisor", "run", "--state-dir", stateDir, "--background"], logFile, env });
    }
    first = false;
    if (state.lock) await identity(state.lock);
    if (state.runtime) {
      for (const child of state.runtime.children!) await identity(child);
      let response: Response | undefined;
      try {
        response = await (options.fetchImpl ?? fetch)(`http://127.0.0.1:${state.config.port}/internal/gateway/health`, {
          redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(2000, deadline - Date.now()))),
        });
      } catch { /* 刚发布的 listener 可能暂未可用；继续等待同一 owner。 */ }
      if (response) {
        if (!response.ok) ownershipError("Gateway loopback health HTTP 状态异常");
        let health: Record<string, unknown>;
        try { health = await response.json() as Record<string, unknown>; }
        catch { ownershipError("Gateway loopback health JSON 无效"); }
        if (!health || health.service !== "machine-gateway" || health.pid !== state.runtime.pid ||
            health.creationTime !== state.runtime.creationTime || health.buildId !== state.runtime.buildId ||
            health.port !== state.config.port || health.publicUrl !== new URL(state.config.publicUrl).origin ||
            health.unified !== (state.config.unified ? true : undefined) ||
            Object.keys(health).sort().join(",") !== (state.config.unified
              ? "buildId,creationTime,pid,port,publicUrl,service,unified"
              : "buildId,creationTime,pid,port,publicUrl,service")) ownershipError("Gateway loopback health 身份或 origin 不匹配");
        const origin = new URL(state.config.publicUrl).origin;
        for (const [route, expected] of [
          ["/.well-known/oauth-protected-resource/mcp", { resource: `${origin}/mcp`, authorization_servers: [origin] }],
          ["/.well-known/oauth-authorization-server", { issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`,
            token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register` }],
        ] as const) {
          let metadata: Record<string, unknown>;
          try {
            const result = await (options.fetchImpl ?? fetch)(`http://127.0.0.1:${state.config.port}${route}`, {
              redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(2000, deadline - Date.now()))),
            });
            if (!result.ok) ownershipError("Gateway loopback OAuth metadata HTTP 状态异常");
            metadata = await result.json() as Record<string, unknown>;
          } catch { ownershipError("Gateway loopback OAuth metadata 无法核验"); }
          if (!metadata || Object.entries(expected).some(([key, value]) => JSON.stringify(metadata[key]) !== JSON.stringify(value)))
            ownershipError("Gateway loopback OAuth metadata 与配置 origin 不匹配");
        }
        for (const [file, snapshot] of [[gatewaySupervisorConfigFile(stateDir), configIdentity],
          [gatewaySupervisorRuntimeFile(stateDir), state.runtimeSnapshot], [gatewaySupervisorLockFile(stateDir), state.lockSnapshot],
          [state.serverFile, state.serverSnapshot]] as const) {
          if (!sameGatewaySnapshot(snapshot!, snapshotGatewayFile(file, true))) ownershipError("Gateway 健康核验期间 ownership 文件改变");
        }
        await identity(state.runtime);
        for (const child of state.runtime.children!) await identity(child);
        return state.runtime;
      }
    }
    await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 100));
  }
  throw new GatewaySupervisorError("GATEWAY_SUPERVISOR_RUN_FAILED", `Gateway 后台启动或健康确认超时；保留所有权状态，日志：${logFile}`);
}
