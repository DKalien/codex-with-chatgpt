import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { encodeFrame, FrameDecoder } from "../src/desktop/ipc.js";

export interface FakeDesktopOptions {
  ownerPresent?: boolean;
  /** 前 N 次快照返回忙碌，之后空闲。Infinity 表示一直忙。 */
  busySnapshots?: number;
  startTurn?: "success" | "reject" | "hangup" | "foreign";
  title?: string;
  /** initialize 之后发一个 client-discovery-request，并记录客户端应答。 */
  probeDiscovery?: boolean;
}

/** 假的 Codex Desktop 命名管道服务（Windows 用 \\.\pipe\，其它平台用临时 unix socket）。 */
export class FakeDesktop {
  readonly pipe = process.platform === "win32"
    ? `\\\\.\\pipe\\c2c-test-${randomUUID()}`
    : path.join(os.tmpdir(), `c2c-test-${randomUUID()}.sock`);
  readonly ownerId = randomUUID();
  readonly requests: Record<string, any>[] = [];
  readonly discoveryResponses: Record<string, any>[] = [];
  snapshots = 0;
  private server = net.createServer((socket) => this.serve(socket));
  private sockets = new Set<net.Socket>();

  constructor(public options: FakeDesktopOptions = {}) {}

  get startTurnCount(): number {
    return this.requests.filter((r) => r.method === "thread-follower-start-turn").length;
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(this.pipe, resolve));
    return this;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
    if (process.platform !== "win32") fs.rmSync(this.pipe, { force: true });
  }

  private serve(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => {});
    const decoder = new FrameDecoder();
    const send = (value: unknown) => socket.write(encodeFrame(value));
    socket.on("data", (chunk) => {
      for (const m of decoder.feed(chunk)) {
        if (m.type === "client-discovery-response") this.discoveryResponses.push(m);
        else if (m.type === "request") this.request(m, send, socket);
        else if (m.type === "broadcast" && m.method === "thread-stream-following-changed") this.snapshot(m, send);
      }
    });
  }

  private request(m: Record<string, any>, send: (v: unknown) => void, socket: net.Socket): void {
    this.requests.push(m);
    const reply = (extra: Record<string, unknown>) =>
      send({ type: "response", requestId: m.requestId, method: m.method, resultType: "success", ...extra });
    const fail = (error: string) => send({ type: "response", requestId: m.requestId, method: m.method, resultType: "error", error });
    if (m.method === "initialize") {
      reply({ result: { clientId: randomUUID() } });
      if (this.options.probeDiscovery) send({ type: "client-discovery-request", requestId: randomUUID() });
    } else if (m.method === "thread-owner-discovery") {
      if (this.options.ownerPresent === false) fail("no-client-found");
      else reply({ handledByClientId: this.ownerId });
    } else if (m.method === "thread-follower-start-turn") {
      const mode = this.options.startTurn ?? "success";
      if (mode === "hangup") socket.destroy();
      else if (mode === "reject") fail("rejected");
      else if (mode === "foreign") reply({ handledByClientId: randomUUID(), result: { result: { turn: { id: randomUUID() } } } });
      else reply({ handledByClientId: m.targetClientId, result: { result: { turn: { id: randomUUID() } } } });
    }
  }

  private snapshot(m: Record<string, any>, send: (v: unknown) => void): void {
    const busy = this.snapshots++ < (this.options.busySnapshots ?? 0);
    send({
      type: "broadcast", method: "thread-stream-state-changed", version: 11, sourceClientId: this.ownerId,
      params: {
        conversationId: m.params.conversationId, hostId: "local",
        change: {
          type: "snapshot", revision: this.snapshots,
          conversationState: {
            title: this.options.title, cwd: "D:\\work", requests: [], unconfirmedTurnSubmissions: [],
            threadRuntimeStatus: { type: busy ? "active" : "idle" }, turns: [],
          },
        },
      },
    });
  }
}
