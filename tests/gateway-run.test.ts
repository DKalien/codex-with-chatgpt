import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import http from "node:http";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStateDir } from "../src/config/paths.js";
import { writeGatewayConfig } from "../src/gateway/config.js";
import { runGateway, windowsCommandLine, type RunDeps } from "../src/gateway/run.js";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => { this.emit("exit", null, "SIGTERM"); return true; });
}

const runtimeFile = (): string => path.join(getStateDir(), "gateway", "runtime.json");

function harness() {
  const spawned: { command: string; args: string[]; env: NodeJS.ProcessEnv; child: FakeChild }[] = [];
  let onShutdown!: () => void;
  const close = vi.fn(async () => {});
  const deps: RunDeps = {
    spawn: (command, args, options) => {
      const child = new FakeChild();
      spawned.push({ command, args, env: options.env, child });
      return child as unknown as ChildProcess;
    },
    startServer: async opts => {
      onShutdown = opts.onShutdown!;
      return { port: 4321, pairingCode: () => ({ code: "ABCD-2345", expiresAt: 0 }), close };
    },
    readKey: () => "secret-key",
  };
  return { spawned, deps, close, shutdown: () => onShutdown() };
}

describe("runGateway", () => {
  beforeEach(() => {
    writeGatewayConfig({
      publicUrl: "https://example.test", port: 4321, tunnelName: "c2c", tunnelId: "tunnel_abcdef123456",
      cloudflaredPath: "cloudflared.exe", tunnelClientPath: "tunnel-client.exe", proxy: null,
      keyFile: path.join(getStateDir(), "gateway", "key.dpapi"),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => vi.useRealTimers());

  it("启动子进程、写 runtime.json、关闭时清理", async () => {
    const h = harness();
    const done = runGateway(h.deps);
    await vi.waitFor(() => expect(h.spawned).toHaveLength(2));

    const [cf, tc] = h.spawned;
    expect(cf!.command).toBe("cloudflared.exe");
    expect(cf!.args).toEqual(["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:4321", "run", "c2c"]);
    expect(tc!.command).toBe("tunnel-client.exe");
    expect(tc!.args).toEqual(expect.arrayContaining([
      "run", "--control-plane.tunnel-id", "tunnel_abcdef123456", "--control-plane.api-key", "env:C2C_TUNNEL_RUNTIME_KEY",
      "--mcp.server-url", "https://example.test/mcp", "--mcp.oauth-trusted-origin", "https://example.test",
      "--harpoon.hosts-include-regex", "^example\\.test$",
    ]));
    expect(tc!.env.C2C_TUNNEL_RUNTIME_KEY).toBe("secret-key");
    expect(cf!.env.C2C_TUNNEL_RUNTIME_KEY).toBeUndefined();

    const runtime = JSON.parse(fs.readFileSync(runtimeFile(), "utf8"));
    expect(runtime).toMatchObject({ pid: process.pid, port: 4321, publicUrl: "https://example.test" });
    expect(runtime.token).toMatch(/^[a-f0-9]{64}$/);
    const log = fs.readFileSync(path.join(getStateDir(), "logs", "gateway.log"), "utf8");
    expect(log).not.toContain("ABCD-2345");

    h.shutdown();
    await done;
    expect(cf!.child.kill).toHaveBeenCalled();
    expect(tc!.child.kill).toHaveBeenCalled();
    expect(h.close).toHaveBeenCalled();
    expect(fs.existsSync(runtimeFile())).toBe(false);
  });

  it("子进程退出后按 2s、4s 退避重启，健康运行 60s 后重置", async () => {
    const h = harness();
    const done = runGateway(h.deps);
    await vi.waitFor(() => expect(h.spawned).toHaveLength(2));
    const cloudflared = () => h.spawned.filter(s => s.command === "cloudflared.exe");

    const childState = () => JSON.parse(fs.readFileSync(runtimeFile(), "utf8")).children.cloudflared;
    expect(childState().state).toBe("running");
    h.spawned[0]!.child.emit("exit", 1, null);
    expect(childState()).toMatchObject({ state: "restarting", error: expect.stringContaining("code=1") });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(cloudflared()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(cloudflared()).toHaveLength(2);
    expect(childState().state).toBe("running");

    cloudflared()[1]!.child.emit("exit", 1, null); // 立刻再退出 -> 4s
    await vi.advanceTimersByTimeAsync(3_999);
    expect(cloudflared()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(cloudflared()).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(60_000); // 健康运行
    cloudflared()[2]!.child.emit("exit", 0, null); // 退避重置 -> 2s
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cloudflared()).toHaveLength(4);

    h.shutdown();
    await done;
    h.spawned.at(-1)!.child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.spawned).toHaveLength(5); // 关闭后不再重启（4 个 cloudflared + 1 个 tunnel-client）
  });

  it("子进程可执行文件不存在时直接报错，不启动服务", async () => {
    const h = harness();
    const { spawn: _injected, ...realSpawnDeps } = h.deps;
    await expect(runGateway(realSpawnDeps)).rejects.toMatchObject({ code: "GATEWAY_EXE_MISSING" });
    expect(fs.existsSync(runtimeFile())).toBe(false);
  });

  it("health 可达的 runtime.json 时拒绝启动", async () => {
    const live = http.createServer((_req, res) => res.end("{}"));
    await new Promise<void>(resolve => live.listen(0, "127.0.0.1", resolve));
    try {
      fs.mkdirSync(path.dirname(runtimeFile()), { recursive: true });
      const port = (live.address() as { port: number }).port;
      fs.writeFileSync(runtimeFile(), JSON.stringify({ pid: process.pid, port, token: "t", publicUrl: "https://example.test", startedAt: "" }));
      const h = harness();
      await expect(runGateway(h.deps)).rejects.toMatchObject({ code: "GATEWAY_RUNNING" });
      expect(h.spawned).toHaveLength(0);
    } finally {
      await new Promise(resolve => live.close(resolve));
    }
  });

  it("pid 存活但 health 不通的遗留 runtime.json 被覆盖", async () => {
    fs.mkdirSync(path.dirname(runtimeFile()), { recursive: true });
    fs.writeFileSync(runtimeFile(), JSON.stringify({ pid: process.pid, port: 1, token: "t", publicUrl: "https://example.test", startedAt: "" }));
    const h = harness();
    const done = runGateway(h.deps);
    await vi.waitFor(() => expect(h.spawned).toHaveLength(2));
    expect(JSON.parse(fs.readFileSync(runtimeFile(), "utf8")).port).toBe(4321);
    h.shutdown();
    await done;
  });

  it("日志超过 5MB 时启动前轮转", async () => {
    const logDir = path.join(getStateDir(), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, "gateway.log"), Buffer.alloc(5 * 1024 * 1024 + 1, "x"));
    const h = harness();
    const done = runGateway(h.deps);
    await vi.waitFor(() => expect(h.spawned).toHaveLength(2));
    expect(fs.statSync(path.join(logDir, "gateway.log.1")).size).toBe(5 * 1024 * 1024 + 1);
    expect(fs.statSync(path.join(logDir, "gateway.log")).size).toBeLessThan(1024);
    h.shutdown();
    await done;
  });
});

describe("windowsCommandLine", () => {
  const argv = ["C:\node.exe", "C:\c2c.js", "gateway", "run"];
  it("转发 C2C_* 与代理变量，其余忽略", () => {
    const line = windowsCommandLine(argv, { C2C_STATE_DIR: "D:\state", HTTPS_PROXY: "http://p:1", PATH: "x", C2C_EMPTY: "" });
    expect(line).toBe('cmd.exe /d /s /c "set "C2C_STATE_DIR=D:\state" && set "HTTPS_PROXY=http://p:1" && "C:\node.exe" "C:\c2c.js" "gateway" "run""');
  });
  it("无需转发时保持原命令行", () => {
    expect(windowsCommandLine(argv, { PATH: "x" })).toBe('"C:\node.exe" "C:\c2c.js" "gateway" "run"');
  });
});
