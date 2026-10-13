import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { registerGatewayCommands } from "../src/cli/gateway.js";
import * as supervisor from "../src/gateway/supervisor.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCurrentInstall } from "../src/core/install.js";
import { collectReleaseReferences } from "../src/core/release-references.js";
import { withMaintenanceLock, maintenanceLockPath } from "../src/core/maintenance-lock.js";
import { ensureConfiguredGatewaySupervisor } from "../src/gateway/startup.js";
import { createGatewaySupervisorLaunch, gatewaySupervisorRuntimeFile,
  listGatewaySupervisorLaunchPins, writeGatewaySupervisorConfig, writeGatewaySupervisorRuntime } from "../src/gateway/supervisor.js";
import type { GatewaySupervisorRuntime } from "../src/gateway/supervisor.js";
import type { ProcessProbe } from "../src/process/process-probe.js";
import type { DaemonSpawnOptions, DaemonSpawnResult } from "../src/process/daemon-spawn.js";
import { cleanup, isolateStateDir, write } from "./helpers.js";

vi.mock("../src/core/install.js", () => ({ readCurrentInstall: vi.fn() }));
let stateDir: string;
let previousState: string | undefined;
const buildId = "a".repeat(64);
const origin = "https://gateway.example.test";
beforeEach(() => {
  previousState = process.env.C2C_STATE_DIR;
  stateDir = isolateStateDir();
  vi.mocked(readCurrentInstall).mockReturnValue({ version: 3, checkoutRoot: "unused", releaseRoot: path.join(stateDir, "releases", buildId),
    runtimeBuildId: buildId, artifactSha256: buildId, manifestSha256: buildId, installedAt: new Date().toISOString() });
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup(stateDir);
  if (previousState === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousState;
});
function configure() {
  write(stateDir, "bin/c2c.js", "// installed launcher");
  const config = { version: 1 as const, scope: "machine" as const, publicUrl: `${origin}/`, port: 48765,
    tunnelName: "gateway", tunnelId: "tunnel_12345678", stableLauncher: path.join(stateDir, "bin", "c2c.js"),
    cloudflaredPath: path.join(stateDir, "bin", "cloudflared.exe"), tunnelClientPath: path.join(stateDir, "bin", "client.exe"),
    proxy: null, keyReference: "dpapi-fixture" };
  writeGatewaySupervisorConfig(config, stateDir);
  return config;
}
function createPin() {
  return withMaintenanceLock("fixture", handle => createGatewaySupervisorLaunch(buildId, stateDir, handle), stateDir);
}
function runtime(): GatewaySupervisorRuntime {
  return { pid: 101, creationTime: "ctime:101", executable: process.execPath, buildId, ports: [48765],
    children: [{ pid: 102, creationTime: "ctime:102", executable: path.join(stateDir, "bin", "cloudflared.exe"), buildId, ports: [] },
      { pid: 103, creationTime: "ctime:103", executable: path.join(stateDir, "bin", "client.exe"), buildId, ports: [] }] };
}
function publish(value = runtime()) {
  writeGatewaySupervisorRuntime(value, stateDir);
  const { children: _children, ports: _ports, ...owner } = value;
  write(stateDir, "gateway/supervisor.lock", JSON.stringify({ version: 1, scope: "machine", ...owner, nonce: randomUUID() }));
  write(stateDir, "gateway/server.lock", JSON.stringify({ pid: value.pid, createdAt: Date.now(), ownerNonce: randomUUID() }));
  for (const pin of listGatewaySupervisorLaunchPins(stateDir)) fs.unlinkSync(pin.file);
}
const native = async (pid: number): Promise<ProcessProbe> => {
  const value = runtime();
  const found = [value, ...value.children!].find(entry => entry.pid === pid)!;
  return { pid, status: "identified", creationTime: found.creationTime, executable: found.executable, inAnyJob: false,
    errors: { process: null, creationTime: null, executable: null, inAnyJob: null }, observedAt: new Date().toISOString() };
};
function http(overrides: Record<string, unknown> = {}): typeof fetch {
  return vi.fn(async input => {
    const url = new URL(input.toString());
    let body: unknown;
    if (url.pathname === "/internal/gateway/health") body = { service: "machine-gateway", pid: 101, creationTime: "ctime:101",
      buildId, port: 48765, publicUrl: origin, ...overrides };
    else if (url.pathname.includes("oauth-protected-resource")) body = { resource: `${origin}/mcp`, authorization_servers: [origin] };
    else body = { issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register` };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
function options(spawnDaemon = vi.fn(async (_opts: DaemonSpawnOptions) => {
  publish(); return { pid: 101 } as DaemonSpawnResult;
})) {
  return { stateDir, timeoutMs: 250, pollMs: 1, probeProcess: native, spawnDaemon, fetchImpl: http() };
}

describe("configured Gateway background ensure", () => {
  it("无配置跳过，不读安装或启动后台", async () => {
    vi.mocked(readCurrentInstall).mockClear();
    const opts = options();
    expect(await ensureConfiguredGatewaySupervisor(opts)).toBeNull();
    expect(opts.spawnDaemon).not.toHaveBeenCalled();
    expect(readCurrentInstall).not.toHaveBeenCalled();
  });
  it("冷启动固定 installed release pin，在释放 maintenance 后交付干净环境", async () => {
    configure();
    process.env.C2C_TUNNEL_RUNTIME_KEY = "test-secret";
    process.env.C2C_GATEWAY_SUPERVISOR_LAUNCH_PIN = "inherited-invalid";
    try {
      const spawnDaemon = vi.fn(async (opts: DaemonSpawnOptions) => {
        expect(fs.existsSync(maintenanceLockPath(stateDir))).toBe(false);
        expect(opts.cmd).toBe(process.execPath);
        expect(opts.args).toEqual([path.join(stateDir, "releases", buildId, "bin", "c2c.js"), "gateway", "supervisor", "run", "--state-dir", stateDir, "--background"]);
        expect(opts.env.C2C_TUNNEL_RUNTIME_KEY).toBeUndefined();
        const pins = listGatewaySupervisorLaunchPins(stateDir);
        expect(pins).toHaveLength(1);
        expect(opts.env.C2C_GATEWAY_SUPERVISOR_LAUNCH_PIN).toBe(pins[0].file);
        expect(opts.env.C2C_GATEWAY_SUPERVISOR_LAUNCH_IDENTITY).toBe(pins[0].identity);
        expect(opts.logFile).toBe(path.join(stateDir, "logs", "gateway-supervisor.out.log"));
        fs.writeFileSync(opts.logFile, "fixture background log", { mode: 0o600 });
        publish();
        const graph = collectReleaseReferences(stateDir);
        expect(graph.issues.filter(issue => issue.source.startsWith("gateway:") || issue.source === "collector:gateway-runtime")).toEqual([]);
        return { pid: 101 } as DaemonSpawnResult;
      });
      expect(await ensureConfiguredGatewaySupervisor(options(spawnDaemon))).toEqual(runtime());
      expect(spawnDaemon).toHaveBeenCalledTimes(1);
      expect(readCurrentInstall).toHaveBeenCalledWith(stateDir, "fast");
    } finally {
      delete process.env.C2C_TUNNEL_RUNTIME_KEY;
      delete process.env.C2C_GATEWAY_SUPERVISOR_LAUNCH_PIN;
    }
  });
  it("健康旧 build 直接复用，不读 current 或 spawn", async () => {
    configure(); publish();
    vi.mocked(readCurrentInstall).mockClear();
    const opts = options();
    expect(await ensureConfiguredGatewaySupervisor(opts)).toEqual(runtime());
    expect(opts.spawnDaemon).not.toHaveBeenCalled();
    expect(readCurrentInstall).not.toHaveBeenCalled();
  });
  it("unified owner 只能复用带 exact unified:true 的健康 Gateway", async () => {
    const config = configure(); writeGatewaySupervisorConfig({ ...config, unified: true }, stateDir); publish();
    const opts = options(); opts.fetchImpl = http({ unified: true });
    expect(await ensureConfiguredGatewaySupervisor(opts)).toEqual(runtime());
    expect(opts.spawnDaemon).not.toHaveBeenCalled();
  });
  it.each([{}, { unified: false }, { unified: true, extra: "unknown" }])("unified health 模式缺失或异常 %j 保留 owner", async health => {
    const config = configure(); writeGatewaySupervisorConfig({ ...config, unified: true }, stateDir); publish();
    const opts = options(); opts.fetchImpl = http(health);
    await expect(ensureConfiguredGatewaySupervisor(opts)).rejects.toMatchObject({ code: "GATEWAY_SUPERVISOR_OWNERSHIP_LOST" });
    expect(opts.spawnDaemon).not.toHaveBeenCalled();
    expect(fs.existsSync(gatewaySupervisorRuntimeFile(stateDir))).toBe(true);
  });
  it("legacy 配置拒绝复用带 unified 身份的 Gateway", async () => {
    configure(); publish();
    const opts = options(); opts.fetchImpl = http({ unified: true });
    await expect(ensureConfiguredGatewaySupervisor(opts)).rejects.toMatchObject({ code: "GATEWAY_SUPERVISOR_OWNERSHIP_LOST" });
    expect(opts.spawnDaemon).not.toHaveBeenCalled();
  });
  it("两个并发 ensure 只 spawn 一次，第二个等待 pin handoff", async () => {
    configure();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const spawnDaemon = vi.fn(async (_opts: DaemonSpawnOptions) => {
      await pending; publish(); return { pid: 101 } as DaemonSpawnResult;
    });
    const opts = options(spawnDaemon);
    const first = ensureConfiguredGatewaySupervisor(opts);
    const second = ensureConfiguredGatewaySupervisor(opts);
    release();
    expect(await Promise.all([first, second])).toEqual([runtime(), runtime()]);
    expect(spawnDaemon).toHaveBeenCalledTimes(1);
  });
  it.each(["unknown", "missing", "creation", "executable"])("native %s 拒绝复用且不接管", async kind => {
    configure(); publish();
    const opts = options();
    opts.probeProcess = async pid => ({ ...await native(pid), ...(kind === "unknown" || kind === "missing"
      ? { status: kind as "unknown" | "missing" } : kind === "creation" ? { creationTime: "other" } : { executable: path.join(stateDir, "wrong.exe") }) });
    await expect(ensureConfiguredGatewaySupervisor(opts)).rejects.toMatchObject({ code: "GATEWAY_SUPERVISOR_OWNERSHIP_LOST" });
    expect(opts.spawnDaemon).not.toHaveBeenCalled();
    expect(fs.existsSync(gatewaySupervisorRuntimeFile(stateDir))).toBe(true);
  });
  it.each(["orphan-lock", "orphan-server", "corrupt-runtime", "corrupt-lock", "multiple-pins", "bad-pin"])("%s 保留并拒绝启动", async kind => {
    configure();
    if (kind === "multiple-pins") { createPin(); createPin(); }
    else if (kind === "bad-pin") write(stateDir, "gateway/supervisor.invalid.launch.json", "{}");
    else if (kind === "corrupt-runtime") write(stateDir, "gateway/supervisor.runtime.json", "{}");
    else if (kind === "orphan-server") write(stateDir, "gateway/server.lock", JSON.stringify({ pid: 101, createdAt: Date.now(), ownerNonce: randomUUID() }));
    else if (kind === "corrupt-lock") write(stateDir, "gateway/supervisor.lock", "{}");
    else { publish(); fs.unlinkSync(gatewaySupervisorRuntimeFile(stateDir)); }
    const opts = options();
    await expect(ensureConfiguredGatewaySupervisor(opts)).rejects.toThrow();
    expect(opts.spawnDaemon).not.toHaveBeenCalled();
  });
  it.each([{ pid: 999 }, { publicUrl: "https://wrong.test" }, { service: "bridge" }, { ownerNonce: "must-not-leak" }])("错误 health %j 拒绝", async wrong => {
    configure(); publish();
    const opts = { ...options(), fetchImpl: http(wrong) };
    await expect(ensureConfiguredGatewaySupervisor(opts)).rejects.toMatchObject({ code: "GATEWAY_SUPERVISOR_OWNERSHIP_LOST" });
    expect(opts.spawnDaemon).not.toHaveBeenCalled();
  });
  it("pin 被改写时保留 pin，不补 spawn", async () => {
    configure();
    const spawnDaemon = vi.fn(async (_opts: DaemonSpawnOptions) => {
      const pin = listGatewaySupervisorLaunchPins(stateDir)[0];
      fs.writeFileSync(pin.file, JSON.stringify({ ...pin.launch, createdAt: "2026-01-01T00:00:00.000Z" }));
      return { pid: 101 } as DaemonSpawnResult;
    });
    await expect(ensureConfiguredGatewaySupervisor(options(spawnDaemon))).rejects.toMatchObject({ code: "GATEWAY_SUPERVISOR_OWNERSHIP_LOST" });
    expect(spawnDaemon).toHaveBeenCalledTimes(1);
    expect(listGatewaySupervisorLaunchPins(stateDir)).toHaveLength(1);
  });
  it("合法未 publish pin 等待超时保留，绝不启动第二个", async () => {
    configure(); createPin();
    const opts = { ...options(), timeoutMs: 25 };
    await expect(ensureConfiguredGatewaySupervisor(opts)).rejects.toThrow(path.join(stateDir, "logs", "gateway-supervisor.out.log"));
    expect(opts.spawnDaemon).not.toHaveBeenCalled();
    expect(listGatewaySupervisorLaunchPins(stateDir)).toHaveLength(1);
  });
  it("spawn 结果未知仍保留 pin", async () => {
    configure();
    const spawnDaemon = vi.fn(async (_opts: DaemonSpawnOptions): Promise<DaemonSpawnResult> => { throw new Error("spawn unknown"); });
    await expect(ensureConfiguredGatewaySupervisor(options(spawnDaemon))).rejects.toThrow("spawn unknown");
    expect(listGatewaySupervisorLaunchPins(stateDir)).toHaveLength(1);
  });
});

it("裸调用不能发布 launch pin", () => {
  configure();
  expect(() => createGatewaySupervisorLaunch(buildId, stateDir, undefined as never)).toThrow("handle");
  expect(listGatewaySupervisorLaunchPins(stateDir)).toHaveLength(0);
});
it("pin 写入后同 inode 被改为另一个合法 build 仍拒绝并保留", () => {
  configure();
  const original = fs.fstatSync;
  vi.spyOn(fs, "fstatSync").mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => {
    const result = original(...args);
    const folder = path.join(stateDir, "gateway");
    const name = fs.readdirSync(folder).find(entry => entry.endsWith(".launch.json"));
    if (name) {
      const file = path.join(folder, name);
      const launch = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file, JSON.stringify({ ...launch, buildId: "b".repeat(64) }));
    }
    return result;
  }) as typeof fs.fstatSync);
  expect(() => createPin()).toThrow("文件身份发生变化");
  expect(listGatewaySupervisorLaunchPins(stateDir)).toHaveLength(1);
});
it("后台 CLI 不注册 pairing 输出回调", async () => {
  const runner = vi.spyOn(supervisor, "runGatewaySupervisor").mockImplementation(async opts => {
    opts?.onPairing?.({ code: "must-not-log", expiresAt: Date.now() });
  });
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const command = new Command(); registerGatewayCommands(command);
  await command.parseAsync(["node", "c2c", "gateway", "supervisor", "run", "--state-dir", stateDir, "--background"]);
  expect(runner).toHaveBeenCalledWith({ stateDir, onPairing: undefined });
  expect(output).not.toHaveBeenCalled();
});

it("HTTP 核验后 child 身份改变，不能返回就绪", async () => {
  configure(); publish();
  let checkedHttp = false;
  const fetchImpl = http();
  const opts = { ...options(), fetchImpl: (async (...args: Parameters<typeof fetch>) => {
    checkedHttp = true; return fetchImpl(...args);
  }) as typeof fetch, probeProcess: async (pid: number) => ({ ...await native(pid),
    ...(checkedHttp && pid === 102 ? { creationTime: "replaced" } : {}) }) };
  await expect(ensureConfiguredGatewaySupervisor(opts)).rejects.toMatchObject({ code: "GATEWAY_SUPERVISOR_OWNERSHIP_LOST" });
  expect(opts.spawnDaemon).not.toHaveBeenCalled();
});

it("OAuth metadata 与配置 origin 不符时拒绝，绝不重启", async () => {
  configure(); publish();
  const ready = http();
  const opts = { ...options(), fetchImpl: (async (...args: Parameters<typeof fetch>) => {
    if (args[0].toString().endsWith("oauth-authorization-server"))
      return new Response(JSON.stringify({ issuer: "https://wrong.test" }));
    return ready(...args);
  }) as typeof fetch };
  await expect(ensureConfiguredGatewaySupervisor(opts)).rejects.toMatchObject({ code: "GATEWAY_SUPERVISOR_OWNERSHIP_LOST" });
  expect(opts.spawnDaemon).not.toHaveBeenCalled();
});
