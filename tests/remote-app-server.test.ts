import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppServerClient, type AppServerClientOptions } from "../src/remote/app-server.js";

class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  readonly kill = vi.fn(() => {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
    return true;
  });
}

function setup(options: Partial<AppServerClientOptions> = {}): { client: AppServerClient; child: FakeProcess; spawnImpl: ReturnType<typeof vi.fn> } {
  const child = new FakeProcess();
  const spawnImpl = vi.fn(() => child as unknown as ChildProcess);
  const client = new AppServerClient({ executable: "fake-codex", spawnImpl, ...options });
  return { client, child, spawnImpl };
}

function respond(child: FakeProcess, id: number, result: unknown): void {
  child.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Codex app-server stdio client", () => {
  it("starts with the protocol handshake and sends initialized", async () => {
    const { client, child, spawnImpl } = setup();
    const requests: Record<string, unknown>[] = [];
    child.stdin.on("data", chunk => {
      const message = JSON.parse(String(chunk)) as Record<string, unknown>;
      requests.push(message);
      if (message.method === "initialize") {
        respond(child, message.id as number, {
          userAgent: "fake",
          codexHome: "C:/fake",
          platformFamily: "windows",
          platformOs: "windows",
        });
      }
    });

    await expect(client.start()).resolves.toMatchObject({ userAgent: "fake" });
    expect(spawnImpl).toHaveBeenCalledWith(
      "fake-codex",
      ["app-server", "--stdio"],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    expect(requests[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        clientInfo: { name: "codex-with-chatgpt", title: "Codex with ChatGPT", version: expect.any(String) },
        capabilities: { experimentalApi: false, requestAttestation: false },
      },
    });
    expect(requests[1]).toEqual({ jsonrpc: "2.0", method: "initialized" });
    client.close();
  });

  it("routes responses and notifications, while leaving server requests unanswered", async () => {
    const { client, child } = setup();
    child.stdin.on("data", chunk => {
      const message = JSON.parse(String(chunk)) as Record<string, unknown>;
      if (message.method === "initialize") respond(child, message.id as number, {});
      if (message.method === "thread/start") respond(child, message.id as number, { thread: { id: "t1" } });
    });
    const notifications: unknown[] = [];
    const serverRequests: unknown[] = [];
    client.on("notification", message => notifications.push(message));
    client.on("request", message => serverRequests.push(message));

    await client.start();
    await expect(client.request("thread/start", { cwd: "C:/workspace" })).resolves.toEqual({ thread: { id: "t1" } });
    child.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: "t1" } }) + "\n");
    child.stdout.write(JSON.stringify({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { command: "secret" } }) + "\n");
    await new Promise(resolve => setImmediate(resolve));
    expect(notifications).toEqual([{ method: "turn/started", params: { threadId: "t1" } }]);
    expect(serverRequests).toEqual([{ id: "approval-1", method: "item/commandExecution/requestApproval", params: { command: "secret" } }]);
    client.close();
  });

  it("rejects pending requests when the process exits and does not expose stderr", async () => {
    const { client, child } = setup({ requestTimeoutMs: 10_000 });
    child.stdin.on("data", chunk => {
      const message = JSON.parse(String(chunk)) as Record<string, unknown>;
      if (message.method === "initialize") respond(child, message.id as number, {});
    });
    const errors: Error[] = [];
    client.on("error", error => errors.push(error));
    await client.start();
    const pending = client.request("thread/read", { threadId: "t1" });
    child.stderr.write("access_token=do-not-leak\n");
    child.emit("exit", 23, null);
    await expect(pending).rejects.toThrow(/exited/);
    expect(errors).toEqual([]);
  });

  it("enforces a frame limit", async () => {
    const { client, child } = setup({ maxFrameBytes: 64 });
    const close = vi.fn();
    client.on("close", close);
    const starting = client.start();
    child.stdout.write(`${"x".repeat(65)}\n`);
    await expect(starting).rejects.toThrow(/frame/);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
