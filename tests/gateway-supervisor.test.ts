import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import {
  GatewaySupervisorError,
  assertGatewayTunnelIdentity,
  buildGatewaySupervisorCommandPlan,
  configureGatewaySupervisor,
  gatewaySupervisorTunnelUpstream,
  gatewaySupervisorConfigSchema,
  gatewaySupervisorLaunchFile,
  gatewaySupervisorLockFile,
  gatewaySupervisorKeyFile,
  gatewaySupervisorRuntimeSchema,
  readGatewaySupervisorConfig,
  readGatewayTunnelKey,
  readGatewaySupervisorStatus,
  startGatewaySupervisor,
  setGatewayTunnelKey,
  validateGatewaySupervisor,
  writeGatewaySupervisorConfig,
  writeGatewaySupervisorRuntime,
} from "../src/gateway/supervisor.js";
import { registerGatewayCommands } from "../src/cli/gateway.js";
import { startGatewayServer, type GatewayServer } from "../src/remote/server.js";
import { buildDaemonEnv } from "../src/process/daemon-spawn.js";
import { cleanup, isolateStateDir } from "./helpers.js";

let stateDir: string;
let oldState: string | undefined;
let oldLaunchPin: string | undefined;
let oldLaunchIdentity: string | undefined;
let gateway: GatewayServer;
beforeEach(() => {
  oldState = process.env.C2C_STATE_DIR;
  oldLaunchPin = process.env.C2C_GATEWAY_SUPERVISOR_LAUNCH_PIN;
  oldLaunchIdentity = process.env.C2C_GATEWAY_SUPERVISOR_LAUNCH_IDENTITY;
  delete process.env.C2C_GATEWAY_SUPERVISOR_LAUNCH_PIN;
  delete process.env.C2C_GATEWAY_SUPERVISOR_LAUNCH_IDENTITY;
  stateDir = isolateStateDir();
  let closed!: () => void;
  gateway = {
    pairingCode: "TEST-CODE", pairingExpiresAt: Date.now() + 60_000,
    closed: new Promise<void>(resolve => { closed = resolve; }),
    close: vi.fn(async () => closed()),
  } as unknown as GatewayServer;
});
afterEach(() => {
  cleanup(stateDir);
  if (oldState === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = oldState;
  if (oldLaunchPin === undefined) delete process.env.C2C_GATEWAY_SUPERVISOR_LAUNCH_PIN;
  else process.env.C2C_GATEWAY_SUPERVISOR_LAUNCH_PIN = oldLaunchPin;
  if (oldLaunchIdentity === undefined) delete process.env.C2C_GATEWAY_SUPERVISOR_LAUNCH_IDENTITY;
  else process.env.C2C_GATEWAY_SUPERVISOR_LAUNCH_IDENTITY = oldLaunchIdentity;
});

function config() {
  return {
    version: 1 as const,
    scope: "machine" as const,
    publicUrl: "https://gateway.example.test/",
    port: 48765,
    tunnelName: "codex-gateway",
    tunnelId: "tunnel_6ac3023c5bec8191ba7bca75faf05024",
    stableLauncher: path.join(stateDir, "bin", "c2c.js"),
    cloudflaredPath: path.join(stateDir, "bin", "cloudflared.exe"),
    tunnelClientPath: path.join(stateDir, "bin", "tunnel-client.exe"),
    proxy: "http://127.0.0.1:7897",
    keyReference: "windows-dpapi://codex-with-chatgpt/gateway",
  };
}

function readyOAuthDiscoveryFetch(onRequest?: (url: URL, init?: RequestInit) => void): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
    onRequest?.(url, init);
    const origin = new URL(config().publicUrl).origin;
    const metadata = url.pathname === "/.well-known/oauth-protected-resource/mcp"
      ? { resource: `${origin}/mcp`, authorization_servers: [origin] }
      : { issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`,
          token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register` };
    return new Response(JSON.stringify(metadata), { status: 200, headers: { "content-type": "application/json" } });
  };
}

function runtime() {
  return {
    pid: 1234,
    creationTime: "fixture-creation:1",
    executable: process.execPath,
    buildId: "a".repeat(64),
    ports: [48765],
  };
}

function installLaunchPin(buildId: string): string {
  const launcherPath = config().stableLauncher;
  fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
  fs.writeFileSync(launcherPath, "// stable launcher");
  const nonce = randomUUID();
  const file = gatewaySupervisorLaunchFile(nonce, stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = JSON.stringify({ version: 1, scope: "machine", buildId, nonce, launcherPath,
    createdAt: new Date().toISOString() });
  fs.writeFileSync(file, raw, { flag: "wx", mode: 0o600 });
  const stat = fs.lstatSync(file);
  process.env.C2C_GATEWAY_SUPERVISOR_LAUNCH_PIN = file;
  process.env.C2C_GATEWAY_SUPERVISOR_LAUNCH_IDENTITY = JSON.stringify({ dev: stat.dev, ino: stat.ino,
    size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, sha256: createHash("sha256").update(raw).digest("hex") });
  return file;
}

describe("machine Gateway supervisor", () => {
  it("拒绝非 HTTPS、含凭据或带路径的 public URL", () => {
    for (const publicUrl of [
      "http://gateway.example.test/",
      "https://user:pass@gateway.example.test/",
      "https://gateway.example.test/mcp",
    ]) {
      expect(gatewaySupervisorConfigSchema.safeParse({ ...config(), publicUrl }).success).toBe(false);
    }
  });

  it("runtime schema 只接受 PID、creationTime、executable、buildId 和 ports", () => {
    const parsed = gatewaySupervisorRuntimeSchema.parse(runtime());
    expect(Object.keys(parsed).sort()).toEqual(["buildId", "creationTime", "executable", "pid", "ports"]);
    for (const secretField of ["key", "pairing", "token"]) {
      expect(gatewaySupervisorRuntimeSchema.safeParse({ ...runtime(), [secretField]: "secret" }).success).toBe(false);
    }
    writeGatewaySupervisorConfig(config(), stateDir);
    writeGatewaySupervisorRuntime(runtime(), stateDir);
    const stored = fs.readFileSync(path.join(stateDir, "gateway", "supervisor.runtime.json"), "utf8");
    expect(stored).not.toMatch(/key|pairing|token/i);
  });

  it("Gateway tunnel identity 必须是 machine scope，不能接收 workspace Bridge identity", () => {
    expect(assertGatewayTunnelIdentity({ scope: "machine", tunnelName: "gateway", tunnelId: config().tunnelId })).toMatchObject({ scope: "machine" });
    expect(() => assertGatewayTunnelIdentity({ scope: "workspace", workspaceId: "a".repeat(12), tunnelName: "gateway", tunnelId: config().tunnelId })).toThrow(GatewaySupervisorError);
    expect(() => assertGatewayTunnelIdentity({ scope: "machine", workspaceId: "a".repeat(12), tunnelName: "gateway", tunnelId: config().tunnelId })).toThrow(GatewaySupervisorError);
    for (const tunnelName of ["--config", "two names", "bad\nname"]) {
      expect(gatewaySupervisorConfigSchema.safeParse({ ...config(), tunnelName }).success).toBe(false);
    }
  });

  it("status/validate 只读，且 runtime 端口必须包含 Gateway 端口", () => {
    writeGatewaySupervisorConfig(config(), stateDir);
    writeGatewaySupervisorRuntime({ ...runtime(), ports: [48766] }, stateDir);
    expect(readGatewaySupervisorStatus(stateDir)).toMatchObject({ ok: false, problems: ["runtime ports do not include the configured Gateway port"] });
    expect(validateGatewaySupervisor(stateDir)).toMatchObject({ ok: false });
  });

  it("configure 只写 machine 配置并自动引用 DPAPI 文件，不接受 raw key", () => {
    const configured = configureGatewaySupervisor({
      stateDir,
      publicUrl: config().publicUrl,
      port: config().port,
      tunnelName: config().tunnelName,
      tunnelId: config().tunnelId,
      stableLauncher: config().stableLauncher,
      cloudflaredPath: config().cloudflaredPath,
      tunnelClientPath: config().tunnelClientPath,
      proxy: config().proxy,
    });
    expect(configured.scope).toBe("machine");
    expect(configured.keyFile).toBe(gatewaySupervisorKeyFile(stateDir));
    expect(configured.keyReference).toMatch(/^dpapi-file:/);
    expect(JSON.stringify(configured)).not.toContain("sk-runtime-key");
    expect(readGatewaySupervisorConfig(stateDir)).toEqual(configured);
  });

  it("CLI 提供 configure/status/validate/set-key/run，解析命令不注册或启动任务", () => {
    const program = new Command();
    registerGatewayCommands(program);
    const gateway = program.commands.find(command => command.name() === "gateway")!;
    const supervisor = gateway.commands.find(command => command.name() === "supervisor")!;
    expect(supervisor.commands.map(command => command.name()).sort()).toEqual(["configure", "run", "set-key", "status", "validate"]);
    expect(supervisor.commands.find(command => command.name() === "set-key")!.options.map(option => option.long)).not.toContain("--key");
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });

  it("set-key 明确拒绝伪安全的 TypeScript secret storage", () => {
    expect(() => setGatewayTunnelKey({ stateDir, platform: "linux" })).toThrowError(/DPAPI key helper/);
  });

  it("set-key 通过交互式 PowerShell 保存 DPAPI 密文，read 仅返回 runner 内存值", () => {
    writeGatewaySupervisorConfig(config(), stateDir);
    const spawn = vi.fn((_file: string, _args: string[], options: Record<string, unknown>) => {
      expect(options.stdio).toEqual(["inherit", "pipe", "pipe"]);
      return { status: 0, stdout: "prompt\nC2C_DPAPI_BEGIN\n01020304\nC2C_DPAPI_END\n", stderr: "" } as any;
    });
    const saved = setGatewayTunnelKey({ stateDir, platform: "win32", powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", spawnSyncImpl: spawn });
    expect(saved.keyFile).toBe(gatewaySupervisorKeyFile(stateDir));
    expect(saved.keyReference).toContain("dpapi-file:");
    expect(fs.readFileSync(saved.keyFile, "utf8")).toBe("01020304\n");
    expect(JSON.stringify(saved)).not.toContain("01020304");
    expect(readGatewaySupervisorConfig(stateDir)).toMatchObject({ keyFile: saved.keyFile, keyReference: saved.keyReference });

    const readSpawn = vi.fn((_file: string, _args: string[], options: Record<string, unknown>) => {
      expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
      return { status: 0, stdout: "C2C_DPAPI_BEGIN\nsecret runtime key\nC2C_DPAPI_END\n", stderr: "" } as any;
    });
    expect(readGatewayTunnelKey({ stateDir, platform: "win32", powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", spawnSyncImpl: readSpawn })).toBe("secret runtime key");
    expect(fs.existsSync(gatewaySupervisorKeyFile(stateDir))).toBe(true);
  });

  it("拒绝 helper 返回的非密文内容，不落盘原始 key", () => {
    writeGatewaySupervisorConfig(config(), stateDir);
    const spawn = vi.fn(() => ({ status: 0, stdout: "C2C_DPAPI_BEGIN\nraw secret\nC2C_DPAPI_END\n", stderr: "" }) as any);
    expect(() => setGatewayTunnelKey({ stateDir, platform: "win32", powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", spawnSyncImpl: spawn })).toThrow(/返回内容无效|密文格式无效/);
    expect(fs.existsSync(gatewaySupervisorKeyFile(stateDir))).toBe(false);
  });

  function processProbe(pid: number, creationTime = `created-${pid}`) {
    return {
      pid,
      status: "identified" as const,
      executable: process.execPath,
      creationTime,
      inAnyJob: false,
      errors: { process: null, executable: null, creationTime: null, inAnyJob: null },
      observedAt: new Date().toISOString(),
    };
  }

  function fakeChild(pid: number) {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    child.pid = pid;
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    child.kill = vi.fn(() => {
      child.killed = true;
      child.exitCode = 0;
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
      return true;
    });
    return child;
  }

  async function expectOAuthDiscoveryFailure(options: {
    fetchImpl: typeof fetch;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<Error> {
    writeGatewaySupervisorConfig(config(), stateDir);
    const cloudflared = fakeChild(2301);
    const executableByPid = new Map<number, string>([[process.pid, process.execPath]]);
    const spawnImpl = vi.fn((command: string) => {
      executableByPid.set(cloudflared.pid, command);
      return cloudflared as any;
    });
    const failure = await startGatewaySupervisor({
      stateDir,
      startGateway: async () => gateway,
      platform: "win32",
      buildId: "e".repeat(64),
      readKey: () => "sk-discovery-test-key",
      cloudflaredPath: path.join(stateDir, "cloudflared.exe"),
      spawnImpl: spawnImpl as any,
      probeProcess: async (pid, expected) => ({
        ...processProbe(pid, expected ?? `created-${pid}`),
        executable: executableByPid.get(pid) ?? process.execPath,
      }),
      oauthDiscoveryFetchImpl: options.fetchImpl,
      oauthDiscoveryTimeoutMs: options.timeoutMs,
      signal: options.signal,
    }).then(() => new Error("Expected OAuth discovery to fail"), error => error as Error);

    expect(failure).toMatchObject({ code: "GATEWAY_SUPERVISOR_RUN_FAILED" });
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(cloudflared.kill).toHaveBeenCalledTimes(1);
    expect(gateway.close).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(stateDir, "gateway", "supervisor.runtime.json"))).toBe(false);
    expect(fs.existsSync(gatewaySupervisorLockFile(stateDir))).toBe(false);
    return failure;
  }

  it("稳定 launcher pin 在维护锁内发布 runtime 后完成 handoff", async () => {
    writeGatewaySupervisorConfig(config(), stateDir);
    const buildId = "9".repeat(64);
    const pinFile = installLaunchPin(buildId);
    const children = [fakeChild(2051), fakeChild(2052)];
    const executableByPid = new Map<number, string>([[process.pid, process.execPath]]);
    let callCount = 0;
    const spawnImpl = vi.fn((command: string) => {
      const child = children[callCount++];
      executableByPid.set(child.pid, command);
      return child as any;
    });
    const handle = await startGatewaySupervisor({
      stateDir,
      startGateway: async () => gateway,
      platform: "win32",
      buildId,
      readKey: () => "sk-launch-pin-key",
      oauthDiscoveryFetchImpl: readyOAuthDiscoveryFetch(),
      cloudflaredPath: path.join(stateDir, "cloudflared.exe"),
      spawnImpl: spawnImpl as any,
      probeProcess: async (pid, expected) => ({
        ...processProbe(pid, expected ?? `created-${pid}`),
        executable: executableByPid.get(pid) ?? process.execPath,
      }),
    });

    expect(fs.existsSync(pinFile)).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "gateway", "supervisor.runtime.json"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "maintenance.lock"))).toBe(false);
    expect(process.env.C2C_GATEWAY_SUPERVISOR_LAUNCH_PIN).toBeUndefined();
    expect(spawnImpl.mock.calls).toHaveLength(2);
    expect(spawnImpl.mock.calls.every(([, , options]) => {
      const env = (options as any).env as NodeJS.ProcessEnv;
      return !env.C2C_GATEWAY_SUPERVISOR_LAUNCH_PIN && !env.C2C_GATEWAY_SUPERVISOR_LAUNCH_IDENTITY;
    })).toBe(true);
    expect(await handle.stop()).toBe(true);
  });

  it("launch 文件身份不匹配时拒绝启动并保留 pin", async () => {
    writeGatewaySupervisorConfig(config(), stateDir);
    const pinFile = installLaunchPin("8".repeat(64));
    process.env.C2C_GATEWAY_SUPERVISOR_LAUNCH_IDENTITY = JSON.stringify({ dev: 1, ino: 1, size: 1,
      mtimeMs: 1, ctimeMs: 1, sha256: "f".repeat(64) });
    const readKey = vi.fn(() => "sk-runtime-key");
    await expect(startGatewaySupervisor({ stateDir, startGateway: async () => gateway, platform: "win32",
      buildId: "8".repeat(64), readKey })).rejects.toMatchObject({ code: "GATEWAY_SUPERVISOR_LAUNCH_INVALID" });
    expect(readKey).not.toHaveBeenCalled();
    expect(fs.existsSync(pinFile)).toBe(true);
    expect(fs.existsSync(gatewaySupervisorLockFile(stateDir))).toBe(false);
  });

  it("pin 已验证但启动状态未知时保留 pin", async () => {
    writeGatewaySupervisorConfig(config(), stateDir);
    const pinFile = installLaunchPin("7".repeat(64));
    await expect(startGatewaySupervisor({ stateDir, startGateway: async () => gateway, platform: "win32",
      buildId: "7".repeat(64), readKey: () => { throw new Error("key helper state unknown"); } }))
      .rejects.toThrow("key helper state unknown");
    expect(fs.existsSync(pinFile)).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "gateway", "supervisor.runtime.json"))).toBe(false);
    expect(fs.existsSync(gatewaySupervisorLockFile(stateDir))).toBe(false);
  });

  it("runner 参数只把 key 放入 tunnel-client 环境，并把 upstream 固定到 Gateway /mcp", async () => {
    writeGatewaySupervisorConfig(config(), stateDir);
    const children = [fakeChild(2101), fakeChild(2102)];
    const executableByPid = new Map<number, string>([[process.pid, process.execPath]]);
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const startupOrder: string[] = [];
    const spawnImpl = vi.fn((command: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ command, args, options });
      startupOrder.push(command === path.join(stateDir, "cloudflared.exe") ? "cloudflared" : "tunnel-client");
      const child = children[calls.length - 1] as any;
      executableByPid.set(child.pid, command);
      return child;
    });
    const probe = vi.fn(async (pid: number, expected?: string) => ({
      ...processProbe(pid, expected ?? `created-${pid}`),
      executable: executableByPid.get(pid) ?? process.execPath,
    }));
    const handle = await startGatewaySupervisor({
      stateDir,
      startGateway: async () => gateway,
      platform: "win32",
      buildId: "a".repeat(64),
      readKey: () => "sk-runtime-key",
      oauthDiscoveryFetchImpl: readyOAuthDiscoveryFetch((url, init) => {
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("accept")).toBe("application/json");
        startupOrder.push(url.pathname);
      }),
      cloudflaredPath: path.join(stateDir, "cloudflared.exe"),
      spawnImpl: spawnImpl as any,
      probeProcess: probe,
    });
    expect(calls).toHaveLength(2);
    expect(startupOrder).toEqual([
      "cloudflared",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
      "tunnel-client",
    ]);
    expect(calls[0].args).toContain(`http://127.0.0.1:${config().port}`);
    expect(calls[1].args).toContain(`${config().publicUrl}mcp`);
    expect(calls.flatMap(call => call.args)).not.toContain("sk-runtime-key");
    expect((calls[0].options.env as NodeJS.ProcessEnv)["C2C_TUNNEL_RUNTIME_KEY"]).toBeUndefined();
    expect((calls[1].options.env as NodeJS.ProcessEnv)["C2C_TUNNEL_RUNTIME_KEY"]).toBe("sk-runtime-key");
    expect(calls.every(call => (call.options.env as NodeJS.ProcessEnv).C2C_STATE_DIR === path.resolve(stateDir))).toBe(true);
    expect(calls.every(call => JSON.stringify(call.options.stdio) === JSON.stringify(["ignore", "ignore", "ignore"]))).toBe(true);
    const stored = fs.readFileSync(path.join(stateDir, "gateway", "supervisor.runtime.json"), "utf8");
    expect(stored).not.toContain("sk-runtime-key");
    expect(JSON.parse(stored).children).toHaveLength(2);
    expect(await handle.stop()).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "gateway", "supervisor.runtime.json"))).toBe(false);
    expect(fs.existsSync(gatewaySupervisorLockFile(stateDir))).toBe(false);
    expect(children.every(child => child.kill.mock.calls.length === 1)).toBe(true);
  });

  it("Protected Resource metadata resource 不匹配时拒绝启动 tunnel-client 并清理", async () => {
    const failure = await expectOAuthDiscoveryFailure({
      fetchImpl: async () => new Response(JSON.stringify({ resource: "https://foreign.example/mcp?token=secret-body", authorization_servers: ["https://gateway.example.test"] }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    });
    expect(failure.message).toMatch(/Protected Resource Metadata/);
    expect(failure.message).not.toContain("foreign.example");
    expect(failure.message).not.toContain("secret-body");
    expect(failure.message).not.toContain("sk-discovery-test-key");
  });

  it("HTTP 200 HTML metadata 不算 discovery 就绪，也不会泄露响应正文", async () => {
    const failure = await expectOAuthDiscoveryFailure({
      fetchImpl: async () => new Response("<html>secret-body</html>", {
        status: 200, headers: { "content-type": "text/html" },
      }),
    });
    expect(failure.message).toMatch(/不是 JSON/);
    expect(failure.message).not.toContain("secret-body");
  });

  it("Authorization Server issuer/token endpoint 不匹配时拒绝启动 tunnel-client 并清理", async () => {
    const readyFetch = readyOAuthDiscoveryFetch();
    const fetchImpl: typeof fetch = async input => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return new Response(JSON.stringify({ issuer: url.origin, authorization_endpoint: `${url.origin}/oauth/authorize`,
          token_endpoint: "https://foreign.example/oauth/token", registration_endpoint: `${url.origin}/oauth/register` }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return readyFetch(input);
    };
    const failure = await expectOAuthDiscoveryFailure({ fetchImpl });
    expect(failure.message).toMatch(/Authorization Server Metadata/);
    expect(failure.message).not.toContain("foreign.example");
    expect(failure.message).not.toContain("sk-discovery-test-key");
  });

  it("OAuth discovery 在有界等待内持续未就绪时不启动 tunnel-client 并收敛清理", async () => {
    const failure = await expectOAuthDiscoveryFailure({
      fetchImpl: async () => new Response(null, { status: 503 }),
      timeoutMs: 5,
    });
    expect(failure.message).toMatch(/秒内未就绪/);
  });

  it("单个 OAuth metadata 请求超时会中止请求并清理 cloudflared", async () => {
    let requestAborted = false;
    const failure = await expectOAuthDiscoveryFailure({
      fetchImpl: (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          requestAborted = true;
          reject(new Error("request aborted"));
        }, { once: true });
      }),
      timeoutMs: 10,
    });
    expect(requestAborted).toBe(true);
    expect(failure.message).toMatch(/秒内未就绪/);
  });

  it("OAuth metadata redirect 不跟随到其他域名", async () => {
    let redirectMode: RequestRedirect | undefined;
    let requestedUrl = "";
    const failure = await expectOAuthDiscoveryFailure({
      fetchImpl: async (input, init) => {
        requestedUrl = input instanceof Request ? input.url : input.toString();
        redirectMode = init?.redirect;
        return new Response(null, { status: 302, headers: { location: "https://foreign.example/metadata" } });
      },
      timeoutMs: 5,
    });
    expect(redirectMode).toBe("error");
    expect(requestedUrl).toBe("https://gateway.example.test/.well-known/oauth-protected-resource/mcp");
    expect(failure.message).toMatch(/秒内未就绪/);
  });

  it("OAuth discovery 收到取消信号后不启动 tunnel-client 并收敛清理", async () => {
    const controller = new AbortController();
    const failure = await expectOAuthDiscoveryFailure({
      fetchImpl: async () => {
        controller.abort();
        return new Response(null, { status: 503 });
      },
      signal: controller.signal,
    });
    expect(failure.message).toMatch(/等待已取消/);
  });

  it("停止超时且二次 probe 仍识别 child 时 fail closed 并保留 runtime/lock", async () => {
    writeGatewaySupervisorConfig(config(), stateDir);
    const children = [fakeChild(2151), fakeChild(2152)];
    for (const child of children) {
      child.kill = vi.fn(() => {
        child.killed = true;
        // Deliberately omit exit/close: stopOwnedChild must re-probe after
        // the timeout instead of treating the child as safely gone.
        return true;
      });
    }
    const executableByPid = new Map<number, string>([[process.pid, process.execPath]]);
    let callCount = 0;
    const spawnImpl = vi.fn((command: string) => {
      const child = children[callCount++];
      executableByPid.set(child.pid, command);
      return child as any;
    });
    const probe = vi.fn(async (pid: number, expected?: string) => ({
      ...processProbe(pid, expected ?? `created-${pid}`),
      executable: executableByPid.get(pid) ?? process.execPath,
    }));
    const handle = await startGatewaySupervisor({
      stateDir,
      startGateway: async () => gateway,
      platform: "win32",
      buildId: "c".repeat(64),
      readKey: () => "sk-timeout-key",
      oauthDiscoveryFetchImpl: readyOAuthDiscoveryFetch(),
      cloudflaredPath: path.join(stateDir, "cloudflared.exe"),
      spawnImpl: spawnImpl as any,
      probeProcess: probe,
      childStopTimeoutMs: 1,
    });

    expect(await handle.stop()).toBe(false);
    expect(children.every(child => child.kill.mock.calls.length === 1)).toBe(true);
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(7);
    expect(fs.existsSync(path.join(stateDir, "gateway", "supervisor.runtime.json"))).toBe(true);
    expect(fs.existsSync(gatewaySupervisorLockFile(stateDir))).toBe(true);
  });

  it("lock 已存在时拒绝启动且不读取 key", async () => {
    writeGatewaySupervisorConfig(config(), stateDir);
    fs.mkdirSync(path.dirname(gatewaySupervisorLockFile(stateDir)), { recursive: true });
    fs.writeFileSync(gatewaySupervisorLockFile(stateDir), "foreign-owner", "utf8");
    const readKey = vi.fn(() => "sk-runtime-key");
    await expect(startGatewaySupervisor({
      stateDir,
      startGateway: async () => gateway,
      platform: "win32",
      buildId: "a".repeat(64),
      readKey,
      probeProcess: async (pid, expected) => processProbe(pid, expected ?? `created-${pid}`),
    })).rejects.toMatchObject({ code: "GATEWAY_SUPERVISOR_BUSY" });
    expect(readKey).not.toHaveBeenCalled();
  });

  it("未 configure 时 set-key 不读取输入或产生半配置", () => {
    const helper = vi.fn();
    expect(() => setGatewayTunnelKey({ stateDir, platform: "win32", powershellPath: process.execPath,
      spawnSyncImpl: helper })).toThrow(/configure/);
    expect(helper).not.toHaveBeenCalled();
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });

  it("存在 runtime 时 configure 不覆盖配置", () => {
    writeGatewaySupervisorConfig(config(), stateDir);
    const before = fs.readFileSync(path.join(stateDir, "gateway", "supervisor.json"));
    writeGatewaySupervisorRuntime(runtime(), stateDir);
    expect(() => configureGatewaySupervisor({ ...config(), stateDir })).toThrow(/ownership/);
    expect(fs.readFileSync(path.join(stateDir, "gateway", "supervisor.json"))).toEqual(before);
  });

  it.runIf(process.platform === "win32")("真实 DPAPI key 与 OAuth 在两次隔离启动中复用，正常停止不遗留进程或锁", async () => {
    // Only the two tunnel executables are replaced by inert, local Node children.
    // Gateway HTTP, DPAPI decryption, native process probes and shutdown are real.
    const available = await startGatewayServer({ port: 0, publicUrl: config().publicUrl });
    const port = available.port;
    await available.close();
    const settings = { ...config(), port, cloudflaredPath: process.execPath, tunnelClientPath: process.execPath };
    fs.mkdirSync(path.dirname(settings.stableLauncher), { recursive: true });
    configureGatewaySupervisor({ ...settings, stateDir });
    const powershell = path.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const protectedKey = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; $s=ConvertTo-SecureString -AsPlainText -Force ([Console]::In.ReadToEnd()); ConvertFrom-SecureString $s"],
    { input: "synthetic-test-key", env: buildDaemonEnv(process.env), encoding: "utf8", windowsHide: true, timeout: 15_000 });
    expect(protectedKey.status).toBe(0);
    fs.writeFileSync(gatewaySupervisorKeyFile(stateDir), protectedKey.stdout.trim());
    const keyBytes = fs.readFileSync(gatewaySupervisorKeyFile(stateDir));
    let token: string | undefined;
    let authBytes: Buffer | undefined;
    const authFile = path.join(stateDir, "auth", "gateway.json");
    for (let cycle = 0; cycle < 2; cycle++) {
      let endpoint!: GatewayServer;
      const onPairing = vi.fn();
      const children: ReturnType<typeof spawn>[] = [];
      const handle = await startGatewaySupervisor({ stateDir, buildId: "d".repeat(64), onPairing,
        startGateway: async opts => endpoint = await startGatewayServer(opts),
        oauthDiscoveryFetchImpl: async (input, init) => {
          const publicUrl = input instanceof Request ? new URL(input.url) : new URL(input.toString());
          return fetch(new URL(publicUrl.pathname, `http://127.0.0.1:${port}`), init);
        },
        spawnImpl: (_command, _args, options) => {
          const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
          children.push(child);
          return child;
        },
      });
      try {
        expect(onPairing).toHaveBeenCalledWith({ code: endpoint.pairingCode, expiresAt: endpoint.pairingExpiresAt });
        expect(endpoint.pairing.verify(endpoint.pairingCode).ok).toBe(true);
        if (cycle === 0) {
          token = endpoint.authStore.issueTokens({ clientId: "restart-test", scopes: ["workspace.read"] }).accessToken;
          authBytes = fs.readFileSync(authFile);
        } else {
          expect(endpoint.authStore.verifyAccessToken(token!).ok).toBe(true);
        }
        expect(fs.readFileSync(authFile)).toEqual(authBytes);
        expect(fs.readFileSync(gatewaySupervisorKeyFile(stateDir))).toEqual(keyBytes);
      } finally { expect(await handle.stop()).toBe(true); }
      expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
      for (const name of ["server.lock", "supervisor.lock", "supervisor.runtime.json"]) {
        expect(fs.existsSync(path.join(stateDir, "gateway", name))).toBe(false);
      }
      await expect(fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`)).rejects.toThrow();
    }
  }, 90_000);

  it("无法证明当前 supervisor 身份时 fail closed", async () => {
    writeGatewaySupervisorConfig(config(), stateDir);
    await expect(startGatewaySupervisor({
      stateDir,
      startGateway: async () => gateway,
      platform: "win32",
      buildId: "a".repeat(64),
      readKey: () => "sk-runtime-key",
      probeProcess: async (pid) => ({ ...processProbe(pid), status: "unknown", executable: null, creationTime: null,
        errors: { process: "PROBE_UNAVAILABLE", executable: "PROBE_UNAVAILABLE", creationTime: "PROBE_UNAVAILABLE", inAnyJob: "PROBE_UNAVAILABLE" } }),
    })).rejects.toMatchObject({ code: "GATEWAY_SUPERVISOR_IDENTITY_UNAVAILABLE" });
    expect(fs.existsSync(gatewaySupervisorLockFile(stateDir))).toBe(false);
  });

  it("命令计划拒绝 workspace Bridge identity", () => {
    expect(() => buildGatewaySupervisorCommandPlan({ ...config(), workspaceId: "a".repeat(12) } as any)).toThrow();
    expect(gatewaySupervisorTunnelUpstream(config())).toBe(`${config().publicUrl}mcp`);
  });

  it("Gateway 子进程退出会收敛同一 supervisor lease 的 Cloudflare/Tunnel 子进程", async () => {
    writeGatewaySupervisorConfig(config(), stateDir);
    const children = [fakeChild(2201), fakeChild(2202)];
    const executableByPid = new Map<number, string>([[process.pid, process.execPath]]);
    let callCount = 0;
    const spawnImpl = vi.fn((command: string) => {
      const child = children[callCount++];
      executableByPid.set(child.pid, command);
      return child as any;
    });
    const probe = vi.fn(async (pid: number, expected?: string) => ({
      ...processProbe(pid, expected ?? `created-${pid}`),
      executable: executableByPid.get(pid) ?? process.execPath,
    }));
    const handle = await startGatewaySupervisor({
      stateDir,
      startGateway: async () => gateway,
      platform: "win32",
      buildId: "b".repeat(64),
      readKey: () => "sk-persisted-runtime-key",
      oauthDiscoveryFetchImpl: readyOAuthDiscoveryFetch(),
      cloudflaredPath: path.join(stateDir, "cloudflared.exe"),
      spawnImpl: spawnImpl as any,
      probeProcess: probe,
    });
    await gateway.close();
    // Simulate the Gateway closing before the foreground wait installs listeners.
    const wait = handle.wait();
    await expect(wait).rejects.toMatchObject({ code: "GATEWAY_SUPERVISOR_RUN_FAILED" });
    expect(children[1].kill).toHaveBeenCalledTimes(1);
    expect(children[0].kill).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(gatewaySupervisorLockFile(stateDir))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "gateway", "supervisor.runtime.json"))).toBe(false);
  });
});
