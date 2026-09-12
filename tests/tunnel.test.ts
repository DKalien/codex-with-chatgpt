import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { findBinary } from "../src/tunnel/detect.js";
import {
  CloudflaredQuickTunnel,
  parseQuickTunnelUrl,
  type CloudflaredQuickTunnelOptions,
} from "../src/tunnel/cloudflared.js";
import { normalizeNamedTunnelHostname } from "../src/tunnel/cloudflared-named.js";
import {
  hostnameSlug,
  parseZoneInput,
  suggestedNamedHostname,
  uniqueNamedHostname,
} from "../src/tunnel/hostname.js";
import {
  chooseQuickTunnel,
  isBenignRouteError,
  parseCreatedTunnel,
  parseTunnelList,
  provisionNamedTunnel,
  type CloudflaredAccount,
} from "../src/tunnel/named-provision.js";
import {
  isNamedTunnelReady,
  needsTunnelChoice,
  readTunnelState,
  resolveMigrationZone,
  tunnelStateFile,
  writeTunnelState,
} from "../src/tunnel/state.js";
import { sessionFile } from "../src/session/state.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const stateDirs: string[] = [];
const previousStateDir = process.env.C2C_STATE_DIR;
const previousCloudflaredPath = process.env.C2C_CLOUDFLARED_PATH;
const QUICK_URL = "https://random-words-here-1234.trycloudflare.com";
type FetchImpl = NonNullable<CloudflaredQuickTunnelOptions["fetchImpl"]>;

class FakeCloudflaredProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  readonly kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

function setupTunnel(fetchImpl: FetchImpl, startTimeoutMs = 1_000) {
  const child = new FakeCloudflaredProcess();
  const spawnImpl = vi.fn(() => child as unknown as ChildProcess);
  const tunnel = new CloudflaredQuickTunnel(undefined, "cloudflared", {
    spawnImpl,
    fetchImpl,
    startTimeoutMs,
  });
  return { child, spawnImpl, tunnel };
}

function announceUrl(child: FakeCloudflaredProcess): void {
  child.stderr.write(`INF ${QUICK_URL}\n`);
}

function healthResponse(): Response {
  return new Response(JSON.stringify({ service: "c2c-bridge", status: "ok" }), { status: 200 });
}

afterEach(() => {
  while (stateDirs.length) cleanup(stateDirs.pop()!);
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
  if (previousCloudflaredPath === undefined) delete process.env.C2C_CLOUDFLARED_PATH;
  else process.env.C2C_CLOUDFLARED_PATH = previousCloudflaredPath;
});

describe("findBinary", () => {
  it("uses C2C_CLOUDFLARED_PATH for an accessible cloudflared executable", () => {
    const dir = makeTmpDir("cloudflared-path");
    stateDirs.push(dir);
    const filename = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
    const configured = write(dir, filename, "placeholder");
    if (process.platform !== "win32") fs.chmodSync(configured, 0o755);
    process.env.C2C_CLOUDFLARED_PATH = configured;
    expect(findBinary("cloudflared")).toBe(configured);
  });
});

describe("parseQuickTunnelUrl", () => {
  it("extracts the URL from cloudflared banner output", () => {
    const line =
      "2026-08-28T10:00:00Z INF |  https://random-words-here-1234.trycloudflare.com                              |";
    expect(parseQuickTunnelUrl(line)).toBe(QUICK_URL);
  });

  it("ignores unrelated lines and non-Quick-Tunnel hosts", () => {
    expect(parseQuickTunnelUrl("INF Starting tunnel connection")).toBeNull();
    expect(parseQuickTunnelUrl("visit https://www.cloudflare.com for docs")).toBeNull();
    expect(parseQuickTunnelUrl("https://evil.example.com/trycloudflare.com")).toBeNull();
  });

  it("rejects Cloudflare's API host", () => {
    expect(parseQuickTunnelUrl("INF https://api.trycloudflare.com")).toBeNull();
  });
});

describe("CloudflaredQuickTunnel", () => {
  it("resolves only after the public health endpoint identifies the bridge", async () => {
    const fetchImpl = vi.fn(async () => healthResponse());
    const { child, spawnImpl, tunnel } = setupTunnel(fetchImpl);
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).resolves.toBe(QUICK_URL);
    expect(spawnImpl).toHaveBeenCalledWith(
      "cloudflared",
      ["tunnel", "--url", "http://127.0.0.1:3333", "--no-autoupdate"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    expect(fetchImpl).toHaveBeenCalledWith(`${QUICK_URL}/health`, {
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(tunnel.status()).toMatchObject({ running: true, url: QUICK_URL });
    await tunnel.stop();
  });

  it("keeps consuming cloudflared errors after the tunnel is ready", async () => {
    const { child, tunnel } = setupTunnel(async () => healthResponse());
    const starting = tunnel.start(3333);
    announceUrl(child);
    await expect(starting).resolves.toBe(QUICK_URL);

    child.stderr.write("ERR runtime connection error\n");
    await new Promise((resolve) => setImmediate(resolve));
    expect(tunnel.status().detail).toBe("ERR runtime connection error");
    await tunnel.stop();
  });

  it("does not accept an HTTP 200 response from another service", async () => {
    const { child, tunnel } = setupTunnel(
      async () =>
        new Response(JSON.stringify({ service: "cloudflare", status: "ok" }), { status: 200 }),
      20
    );
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).rejects.toThrow(/timed out/i);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(tunnel.status()).toMatchObject({ running: false, url: null });
  });

  it("does not spawn twice or resolve a stopped pending start", async () => {
    const { child, spawnImpl, tunnel } = setupTunnel(() => new Promise<Response>(() => {}));
    const starting = tunnel.start(3333);
    announceUrl(child);
    await new Promise((resolve) => setImmediate(resolve));

    const concurrent = tunnel.start(3333);
    await tunnel.stop();
    await expect(starting).rejects.toThrow(/stopped/i);
    await expect(concurrent).rejects.toThrow(/stopped/i);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not resolve if cloudflared exits while the health probe is in flight", async () => {
    let resolveFetch!: (response: Response) => void;
    const { child, tunnel } = setupTunnel(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve))
    );
    const starting = tunnel.start(3333);
    announceUrl(child);
    await new Promise((resolve) => setImmediate(resolve));

    child.exitCode = 1;
    child.emit("exit", 1, null);
    resolveFetch(healthResponse());
    await expect(starting).rejects.toThrow(/exited/i);
    expect(tunnel.status()).toMatchObject({ running: false, url: null });
  });

  it("rejects when spawning reports an asynchronous error", async () => {
    const { child, tunnel } = setupTunnel(async () => new Response(null));
    const starting = tunnel.start(3333);
    await new Promise((resolve) => setImmediate(resolve));
    child.emit("error", new Error("spawn cloudflared ENOENT"));

    await expect(starting).rejects.toThrow(/ENOENT/i);
    expect(tunnel.status()).toMatchObject({ running: false, url: null });
  });

  it("retries a non-ready health response before resolving", async () => {
    let calls = 0;
    const cancelBody = vi.fn(async () => undefined);
    const { child, tunnel } = setupTunnel(async () => {
      calls += 1;
      return calls === 1
        ? ({ ok: false, status: 503, body: { cancel: cancelBody } } as unknown as Response)
        : healthResponse();
    });
    const starting = tunnel.start(3333);
    announceUrl(child);

    await expect(starting).resolves.toBe(QUICK_URL);
    expect(calls).toBe(2);
    expect(cancelBody).toHaveBeenCalledTimes(1);
    await tunnel.stop();
  });
});

describe("normalizeNamedTunnelHostname", () => {
  it("normalizes a valid hostname", () => {
    expect(normalizeNamedTunnelHostname("Dev.GetRemi.xyz.")).toBe("dev.getremi.xyz");
  });

  it("rejects URLs and invalid hostnames", () => {
    expect(() => normalizeNamedTunnelHostname("https://dev.getremi.xyz")).toThrow(/invalid/i);
    expect(() => normalizeNamedTunnelHostname("localhost")).toThrow(/invalid/i);
  });
});

describe("named hostname helpers", () => {
  it("builds a stable c2c-<project>.<zone> hostname", () => {
    expect(suggestedNamedHostname("Example.COM", "My App", "abcdef123456")).toBe("c2c-my-app.example.com");
  });

  it("falls back to the workspace id when the name is not ASCII", () => {
    expect(hostnameSlug("回声", "abcdef123456")).toBe("c2c-ws-abcdef12");
  });

  it("parses a typed domain", () => {
    expect(parseZoneInput("https://Example.com/")).toBe("example.com");
    expect(parseZoneInput("not a domain")).toBeNull();
  });

  it("为严格迁移生成含 workspaceId 的唯一 hostname", () => {
    expect(uniqueNamedHostname("Example.COM", "abcdef123456")).toBe("c2c-abcdef123456.example.com");
  });
});

describe("cloudflared output parsers", () => {
  it("reads a tunnel list table", () => {
    const output = `
ID                                   NAME          CREATED
11111111-1111-1111-1111-111111111111 c2c-abc123    2026-08-30
`;
    expect(parseTunnelList(output)).toEqual([
      { id: "11111111-1111-1111-1111-111111111111", name: "c2c-abc123" },
    ]);
  });

  it("reads created-tunnel output", () => {
    expect(
      parseCreatedTunnel(
        "Created tunnel c2c-abc with id 22222222-2222-2222-2222-222222222222",
        "c2c-abc"
      )
    ).toEqual({ id: "22222222-2222-2222-2222-222222222222", name: "c2c-abc" });
  });

  it("treats an existing DNS route as success", () => {
    expect(isBenignRouteError("Failed to add route: record already exists")).toBe(true);
  });
});

describe("tunnel preference state", () => {
  it("asks once, then remembers a quick choice", () => {
    stateDirs.push(isolateStateDir());
    const unset = readTunnelState("ws1");
    expect(needsTunnelChoice(unset)).toBe(true);
    const saved = chooseQuickTunnel("ws1");
    expect(saved.preference).toBe("quick");
    expect(needsTunnelChoice(readTunnelState("ws1"))).toBe(false);
    expect(isNamedTunnelReady(saved)).toBe(false);
  });

  it("provisions a named hostname through the account adapter and stores it outside the project", () => {
    stateDirs.push(isolateStateDir());
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async (name) => ({ id: "33333333-3333-3333-3333-333333333333", name }),
      routeDns: async () => undefined,
    };
    return provisionNamedTunnel({
      workspaceId: "abcdef123456",
      workspaceName: "Demo",
      zone: "example.com",
      account,
    }).then((result) => {
      expect(result.fallback).toBe(false);
      expect(result.state.preference).toBe("named");
      expect(result.state.hostname).toBe("c2c-demo.example.com");
      expect(result.state.tunnelName).toBe("c2c-abcdef123456");
      expect(isNamedTunnelReady(readTunnelState("abcdef123456"))).toBe(true);
    });
  });

  it("falls back to a temporary address when named provisioning fails", () => {
    stateDirs.push(isolateStateDir());
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async () => {
        throw new Error("no zone");
      },
      routeDns: async () => undefined,
    };
    return provisionNamedTunnel({
      workspaceId: "ws2",
      workspaceName: "Demo",
      zone: "example.com",
      account,
    }).then((result) => {
      expect(result.fallback).toBe(true);
      expect(result.state.preference).toBe("quick");
      expect(result.userMessage).toMatch(/临时地址/);
    });
  });

  it("当前 workspace 有可靠 zone 时优先使用当前记录", () => {
    stateDirs.push(isolateStateDir());
    writeTunnelState({ workspaceId: "current", preference: "quick", zone: "current.example.com" });
    writeTunnelState({ workspaceId: "other", preference: "quick", zone: "other.example.com" });

    expect(resolveMigrationZone("current")).toEqual({
      migrationZone: "current.example.com",
      zoneResolution: "current",
    });
  });

  it("机器 tunnels 目录只有一个可靠 zone 时返回 machine-unique", () => {
    stateDirs.push(isolateStateDir());
    writeTunnelState({ workspaceId: "other", preference: "quick", zone: "example.com" });

    expect(resolveMigrationZone("missing-workspace")).toEqual({
      migrationZone: "example.com",
      zoneResolution: "machine-unique",
    });
  });

  it("机器 tunnels 目录有多个 zone 时返回 ambiguous 且不猜测", () => {
    stateDirs.push(isolateStateDir());
    writeTunnelState({ workspaceId: "one", preference: "quick", zone: "one.example.com" });
    writeTunnelState({ workspaceId: "two", preference: "quick", zone: "two.example.com" });

    expect(resolveMigrationZone("missing-workspace")).toEqual({
      migrationZone: null,
      zoneResolution: "ambiguous",
    });
  });

  it("当前或机器 tunnel 状态损坏时返回 corrupt", () => {
    stateDirs.push(isolateStateDir());
    const file = tunnelStateFile("corrupt-workspace");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{broken");

    expect(resolveMigrationZone("corrupt-workspace")).toEqual({
      migrationZone: null,
      zoneResolution: "corrupt",
    });
  });

  it("严格 named 不会覆盖损坏的当前状态", async () => {
    stateDirs.push(isolateStateDir());
    const file = tunnelStateFile("corrupt-workspace");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{broken");
    const before = fs.readFileSync(file);
    const account: CloudflaredAccount = {
      hasCert: vi.fn(() => false),
      login: vi.fn(async () => undefined),
      listTunnels: vi.fn(async () => []),
      createTunnel: vi.fn(async (name) => ({
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        name,
      })),
      routeDns: vi.fn(async () => undefined),
    };

    const result = await provisionNamedTunnel({
      workspaceId: "corrupt-workspace",
      workspaceName: "Target",
      zone: "example.com",
      requireNamed: true,
      account,
    });

    expect(result).toMatchObject({ ok: false, fallback: false });
    expect(account.hasCert).not.toHaveBeenCalled();
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("严格 named 失败时返回失败并保留所有既有 bytes", async () => {
    stateDirs.push(isolateStateDir());
    const otherState = writeTunnelState({
      workspaceId: "other-workspace",
      preference: "quick",
      fallbackReason: "existing",
    });
    const otherFile = tunnelStateFile(otherState.workspaceId);
    writeTunnelState({ workspaceId: "target-workspace", preference: "quick" });
    const targetFile = tunnelStateFile("target-workspace");
    const beforeTarget = fs.readFileSync(targetFile);
    const beforeOther = fs.readFileSync(otherFile);
    const sessionPath = sessionFile("target-workspace");
    const sessionContent = JSON.stringify({
      url: "https://chatgpt.com/c/target",
      projectUrl: "https://chatgpt.com/project/target",
      connectorName: "Target connector",
      taskId: "task-target",
      iteration: 4,
      savedAt: "2026-09-12T00:00:00.000Z",
      checkpoint: {
        taskId: "task-target",
        iteration: 4,
        protocolState: "EXECUTED_SENT",
        waitingFor: "GPT_REVIEW",
        projectUrl: "https://chatgpt.com/project/target",
        chatUrl: "https://chatgpt.com/c/target",
        updatedAt: "2026-09-12T00:00:00.000Z",
      },
    });
    write(path.dirname(sessionPath), path.basename(sessionPath), sessionContent);
    const beforeSession = fs.readFileSync(sessionPath);
    let routeCalled = false;
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async () => {
        throw new Error("Cloudflare unavailable");
      },
      routeDns: async () => {
        routeCalled = true;
      },
    };

    const result = await provisionNamedTunnel({
      workspaceId: "target-workspace",
      workspaceName: "Target",
      zone: "example.com",
      requireNamed: true,
      account,
    });

    expect(result).toMatchObject({ ok: false, fallback: false });
    expect(routeCalled).toBe(false);
    expect(fs.readFileSync(targetFile)).toEqual(beforeTarget);
    expect(fs.readFileSync(otherFile)).toEqual(beforeOther);
    expect(fs.readFileSync(sessionPath)).toEqual(beforeSession);
  });

  it.each([
    {
      label: "Cloudflare 返回了其他 tunnel 名称",
      createTunnel: async () => ({
        id: "44444444-4444-4444-4444-444444444444",
        name: "c2c-other-workspace",
      }),
      listTunnels: async () => [],
    },
    {
      label: "Cloudflare 返回了其他 workspace 的 tunnel id",
      createTunnel: async () => ({
        id: "55555555-5555-5555-5555-555555555555",
        name: "c2c-target-workspace",
      }),
      listTunnels: async () => [
        { id: "55555555-5555-5555-5555-555555555555", name: "c2c-other-workspace" },
      ],
    },
  ])("严格 named 拒绝$label", async ({ createTunnel, listTunnels }) => {
    stateDirs.push(isolateStateDir());
    writeTunnelState({ workspaceId: "target-workspace", preference: "quick" });
    const targetFile = tunnelStateFile("target-workspace");
    const before = fs.readFileSync(targetFile);
    const routeDns = vi.fn(async () => undefined);
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels,
      createTunnel,
      routeDns,
    };

    const result = await provisionNamedTunnel({
      workspaceId: "target-workspace",
      workspaceName: "Target",
      zone: "example.com",
      requireNamed: true,
      account,
    });

    expect(result).toMatchObject({ ok: false, fallback: false });
    expect(routeDns).not.toHaveBeenCalled();
    expect(fs.readFileSync(targetFile)).toEqual(before);
  });

  it.each([
    {
      label: "hostname",
      other: {
        tunnelName: "foreign-binding",
        tunnelId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        hostname: "c2c-target-workspace.example.com",
      },
    },
    {
      label: "tunnelId",
      other: {
        tunnelName: "foreign-binding",
        tunnelId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        hostname: "c2c-other-workspace.example.com",
      },
    },
  ])("严格 named 拒绝与其他 workspace 的 $label 冲突", async ({ other }) => {
    stateDirs.push(isolateStateDir());
    writeTunnelState({ workspaceId: "target-workspace", preference: "quick" });
    const otherState = writeTunnelState({
      workspaceId: "other-workspace",
      preference: "named",
      provider: "cloudflare-named",
      ...other,
      zone: "example.com",
    });
    const targetFile = tunnelStateFile("target-workspace");
    const beforeTarget = fs.readFileSync(targetFile);
    const otherFile = tunnelStateFile(otherState.workspaceId);
    const beforeOther = fs.readFileSync(otherFile);
    const routeDns = vi.fn(async () => undefined);
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async (name) => ({
        id: other.tunnelId,
        name,
      }),
      routeDns,
    };

    const result = await provisionNamedTunnel({
      workspaceId: "target-workspace",
      workspaceName: "Target",
      zone: "example.com",
      requireNamed: true,
      account,
    });

    expect(result).toMatchObject({ ok: false, fallback: false });
    expect(routeDns).not.toHaveBeenCalled();
    expect(fs.readFileSync(targetFile)).toEqual(beforeTarget);
    expect(fs.readFileSync(otherFile)).toEqual(beforeOther);
  });

  it("严格 named 使用唯一 hostname，并把 strict 传给 DNS route", async () => {
    stateDirs.push(isolateStateDir());
    writeTunnelState({ workspaceId: "abcdef123456", preference: "quick", provider: "cloudflare-quick" });
    const sessionPath = sessionFile("abcdef123456");
    const sessionContent = JSON.stringify({
      url: "https://chatgpt.com/c/abcdef",
      projectUrl: "https://chatgpt.com/project/abcdef",
      connectorName: "Demo connector",
      taskId: "task-abcdef",
      iteration: 7,
      savedAt: "2026-09-12T00:00:00.000Z",
      checkpoint: {
        taskId: "task-abcdef",
        iteration: 7,
        protocolState: "EXECUTED_SENT",
        waitingFor: "GPT_REVIEW",
        projectUrl: "https://chatgpt.com/project/abcdef",
        chatUrl: "https://chatgpt.com/c/abcdef",
        updatedAt: "2026-09-12T00:00:00.000Z",
      },
    });
    write(path.dirname(sessionPath), path.basename(sessionPath), sessionContent);
    const beforeSession = fs.readFileSync(sessionPath);
    const createTunnel = vi.fn(async (name: string) => ({
      id: "66666666-6666-6666-6666-666666666666",
      name,
    }));
    const routeDns = vi.fn(async (_tunnelName: string, _hostname: string, options?: { strict?: boolean }) => {
      expect(options).toEqual({ strict: true });
    });
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel,
      routeDns,
    };

    const result = await provisionNamedTunnel({
      workspaceId: "abcdef123456",
      workspaceName: "Same Name",
      zone: "example.com",
      requireNamed: true,
      account,
    });

    expect(result).toMatchObject({ ok: true, fallback: false });
    expect(createTunnel).toHaveBeenCalledWith("c2c-abcdef123456");
    expect(routeDns).toHaveBeenCalledWith(
      "c2c-abcdef123456",
      "c2c-abcdef123456.example.com",
      { strict: true }
    );
    expect(result.state.hostname).toBe("c2c-abcdef123456.example.com");
    expect(fs.readFileSync(sessionPath)).toEqual(beforeSession);
  });

  it("严格 named 遇到 DNS duplicate 错误时不降级为 quick", async () => {
    stateDirs.push(isolateStateDir());
    writeTunnelState({ workspaceId: "dns-target", preference: "quick" });
    const targetFile = tunnelStateFile("dns-target");
    const before = fs.readFileSync(targetFile);
    const account: CloudflaredAccount = {
      hasCert: () => true,
      login: async () => undefined,
      listTunnels: async () => [],
      createTunnel: async (name) => ({ id: "77777777-7777-7777-7777-777777777777", name }),
      routeDns: async () => {
        throw new Error("record already exists");
      },
    };

    const result = await provisionNamedTunnel({
      workspaceId: "dns-target",
      workspaceName: "Target",
      zone: "example.com",
      requireNamed: true,
      account,
    });

    expect(result).toMatchObject({ ok: false, fallback: false });
    expect(fs.readFileSync(targetFile)).toEqual(before);
  });

  it("已有当前 workspace 的完整 named binding 时幂等返回且不重复 provision", async () => {
    stateDirs.push(isolateStateDir());
    const state = writeTunnelState({
      workspaceId: "named-target",
      preference: "named",
      provider: "cloudflare-named",
      tunnelName: "c2c-named-target",
      tunnelId: "88888888-8888-8888-8888-888888888888",
      hostname: "c2c-target.example.com",
      zone: "example.com",
    });
    const account: CloudflaredAccount = {
      hasCert: vi.fn(() => false),
      login: vi.fn(async () => undefined),
      listTunnels: vi.fn(async () => []),
      createTunnel: vi.fn(async (name) => ({ id: "99999999-9999-9999-9999-999999999999", name })),
      routeDns: vi.fn(async () => undefined),
    };

    const result = await provisionNamedTunnel({
      workspaceId: "named-target",
      workspaceName: "Target",
      zone: "example.com",
      requireNamed: true,
      account,
    });

    expect(result).toEqual({ ok: true, state, fallback: false });
    expect(account.hasCert).not.toHaveBeenCalled();
    expect(account.login).not.toHaveBeenCalled();
    expect(account.listTunnels).not.toHaveBeenCalled();
    expect(account.createTunnel).not.toHaveBeenCalled();
    expect(account.routeDns).not.toHaveBeenCalled();
  });
});
