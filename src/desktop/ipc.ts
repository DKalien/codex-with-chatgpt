import net from "node:net";
import { randomUUID } from "node:crypto";
import { C2CError } from "../errors.js";

const DEFAULT_PIPE = "\\\\.\\pipe\\codex-ipc";
const REQUEST_TIMEOUT_MS = 5_000;
const START_TURN_TIMEOUT_MS = 30_000;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

/** sent=true 表示 start-turn 字节可能已送达，结果未知。 */
export class DesktopIpcError extends C2CError {
  constructor(code: string, message: string, readonly sent = false) {
    super(code, message);
    this.name = "DesktopIpcError";
  }
}

export interface ThreadState { runtimeStatus: string; busy: boolean; title?: string; cwd?: string }

type Message = Record<string, any>;

/** 帧：4 字节小端长度 + UTF-8 JSON。 */
export function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(payload.length);
  return Buffer.concat([head, payload]);
}

export class FrameDecoder {
  private buf = Buffer.alloc(0);
  feed(chunk: Buffer): Message[] {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out: Message[] = [];
    while (this.buf.length >= 4) {
      const size = this.buf.readUInt32LE(0);
      if (size === 0 || size > MAX_FRAME_BYTES) throw new DesktopIpcError("DESKTOP_PROTOCOL", "Desktop IPC 帧长度非法");
      if (this.buf.length < 4 + size) break;
      let value: unknown;
      try {
        value = JSON.parse(this.buf.subarray(4, 4 + size).toString("utf8"));
      } catch {
        throw new DesktopIpcError("DESKTOP_PROTOCOL", "Desktop IPC 帧不是合法 JSON");
      }
      this.buf = this.buf.subarray(4 + size);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new DesktopIpcError("DESKTOP_PROTOCOL", "Desktop IPC 帧格式错误");
      out.push(value as Message);
    }
    return out;
  }
}

interface Pending { resolve(m: Message): void; reject(e: Error): void; critical: boolean; method: string; target?: string; timer: NodeJS.Timeout }
interface Waiter { threadId: string; resolve(state: Message): void; reject(e: Error): void }

export class DesktopClient {
  private decoder = new FrameDecoder();
  private pending = new Map<string, Pending>();
  private waiters = new Set<Waiter>();
  private clientId = "initializing-client";
  private closed: DesktopIpcError | null = null;

  private constructor(private socket: net.Socket) {
    socket.on("data", (chunk) => {
      try {
        for (const message of this.decoder.feed(chunk)) this.handle(message);
      } catch (error) {
        this.fail(error as DesktopIpcError);
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => this.fail(new DesktopIpcError("DESKTOP_UNAVAILABLE", "Codex Desktop 连接已断开")));
  }

  static async connect(opts: { pipe?: string; timeoutMs?: number } = {}): Promise<DesktopClient> {
    const path = opts.pipe ?? process.env.C2C_DESKTOP_PIPE ?? DEFAULT_PIPE;
    const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(path);
      const done = (failed: boolean) => {
        clearTimeout(timer);
        s.removeAllListeners("connect").removeAllListeners("error");
        if (!failed) return resolve(s);
        s.on("error", () => {});
        s.destroy();
        reject(new DesktopIpcError("DESKTOP_UNAVAILABLE", "无法连接 Codex Desktop，请确认 Desktop 正在运行"));
      };
      const timer = setTimeout(() => done(true), timeoutMs);
      s.once("connect", () => done(false));
      s.once("error", () => done(true));
    });
    const client = new DesktopClient(socket);
    try {
      const response = await client.request("initialize", 0, { clientType: "c2c" });
      const id = response.result?.clientId;
      if (typeof id !== "string") throw new DesktopIpcError("DESKTOP_PROTOCOL", "initialize 未返回 clientId");
      client.clientId = id;
    } catch (error) {
      client.close();
      throw error;
    }
    return client;
  }

  async discoverOwner(threadId: string): Promise<string> {
    const response = await this.request("thread-owner-discovery", 1, { hostId: "local", conversationId: threadId });
    const owner = response.handledByClientId;
    if (typeof owner !== "string" || !owner) throw new DesktopIpcError("DESKTOP_NO_OWNER", "Codex Desktop 中找不到该会话的所有者");
    return owner;
  }

  async snapshot(threadId: string): Promise<ThreadState> {
    const owner = await this.discoverOwner(threadId);
    const state = await new Promise<Message>((resolve, reject) => {
      const clear = () => { clearTimeout(timer); this.waiters.delete(waiter); };
      const waiter: Waiter = { threadId, resolve: (s) => { clear(); resolve(s); }, reject: (e) => { clear(); reject(e); } };
      const timer = setTimeout(() => { clear(); reject(new DesktopIpcError("DESKTOP_TIMEOUT", "等待 Desktop 会话快照超时")); }, REQUEST_TIMEOUT_MS);
      if (this.closed) { clear(); return reject(this.closed); }
      this.waiters.add(waiter);
      this.socket.write(encodeFrame({
        type: "broadcast", method: "thread-stream-following-changed", version: 1, sourceClientId: this.clientId,
        targetClientIds: [owner], params: { conversationId: threadId, hostId: "local", following: true },
      }));
    });
    const status = state.threadRuntimeStatus?.type;
    const nonEmpty = (v: unknown) => Array.isArray(v) && v.length > 0;
    const busy = status !== "idle" || nonEmpty(state.requests) || nonEmpty(state.unconfirmedTurnSubmissions)
      || (Array.isArray(state.turns) && state.turns.some((t: Message) => t?.status === "inProgress"));
    return {
      runtimeStatus: typeof status === "string" ? status : "unknown",
      busy,
      title: typeof state.title === "string" && state.title.trim() ? state.title : undefined,
      cwd: typeof state.cwd === "string" ? state.cwd : undefined,
    };
  }

  async startTurn(threadId: string, text: string): Promise<{ turnId: string }> {
    const owner = await this.discoverOwner(threadId);
    const response = await this.request("thread-follower-start-turn", 2, {
      conversationId: threadId,
      turnStart: { request: { threadId, input: [{ type: "text", text, text_elements: [] }] } },
    }, owner);
    const turnId = response.result?.result?.turn?.id;
    if (typeof turnId !== "string" || !turnId) throw new DesktopIpcError("DESKTOP_OUTCOME_UNKNOWN", "Desktop 已响应但未返回 turnId", true);
    return { turnId };
  }

  close(): void {
    this.socket.destroy();
  }

  private request(method: string, version: number, params: unknown, target?: string): Promise<Message> {
    const critical = method === "thread-follower-start-turn";
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(this.closed);
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(critical
          ? new DesktopIpcError("DESKTOP_OUTCOME_UNKNOWN", "Desktop 未在期限内回应，消息可能已送达", true)
          : new DesktopIpcError("DESKTOP_TIMEOUT", `Desktop IPC 请求超时：${method}`));
      }, critical ? START_TURN_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, critical, method, target, timer });
      const frame = encodeFrame({ type: "request", requestId, sourceClientId: this.clientId, version, method, params, ...(target ? { targetClientId: target } : {}) });
      this.socket.write(frame, (error) => {
        if (!error || !this.pending.delete(requestId)) return;
        clearTimeout(timer);
        reject(new DesktopIpcError(critical ? "DESKTOP_OUTCOME_UNKNOWN" : "DESKTOP_UNAVAILABLE", "写入 Desktop IPC 失败", critical));
      });
    });
  }

  private handle(message: Message): void {
    if (message.type === "client-discovery-request") {
      this.socket.write(encodeFrame({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } }));
    } else if (message.type === "response") {
      const entry = this.pending.get(message.requestId);
      if (!entry) return;
      this.pending.delete(message.requestId);
      clearTimeout(entry.timer);
      if (entry.critical) {
        // 请求字节已写出：任何非预期响应都不能证明任务未被执行或排队
        const ok = message.resultType === "success" && message.method === entry.method && message.handledByClientId === entry.target;
        if (ok) return entry.resolve(message);
        return entry.reject(new DesktopIpcError("DESKTOP_OUTCOME_UNKNOWN", `Desktop 返回了非预期响应：${String(message.error ?? message.resultType)}`, true));
      }
      if (message.resultType === "success") return entry.resolve(message);
      if (message.error === "no-client-found") return entry.reject(new DesktopIpcError("DESKTOP_NO_OWNER", "Codex Desktop 中找不到该会话的所有者"));
      entry.reject(new DesktopIpcError("DESKTOP_REJECTED", `Desktop 拒绝了请求：${String(message.error ?? message.resultType)}`));
    } else if (message.type === "broadcast" && message.method === "thread-stream-state-changed") {
      const { conversationId, change } = message.params ?? {};
      if (change?.type !== "snapshot" || !change.conversationState) return;
      for (const waiter of [...this.waiters]) if (waiter.threadId === conversationId) waiter.resolve(change.conversationState);
    }
  }

  private fail(error: DesktopIpcError): void {
    this.closed ??= error;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(entry.critical ? new DesktopIpcError("DESKTOP_OUTCOME_UNKNOWN", "连接在发送后断开，消息可能已送达", true) : error);
      this.pending.delete(id);
    }
    for (const waiter of [...this.waiters]) waiter.reject(error);
    this.socket.destroy();
  }
}
