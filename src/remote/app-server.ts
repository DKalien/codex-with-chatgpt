import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { VERSION } from "../version.js";

export type RequestId = string | number;

export interface ClientInfo {
  name: string;
  title: string | null;
  version: string;
}

export interface InitializeCapabilities {
  experimentalApi: boolean;
  requestAttestation: boolean;
  mcpServerOpenaiFormElicitation?: boolean;
  optOutNotificationMethods?: string[] | null;
  extensions?: Record<string, unknown> | null;
}

/** Parameters from the generated app-server protocol's InitializeParams. */
export interface InitializeParams {
  clientInfo: ClientInfo;
  capabilities: InitializeCapabilities | null;
}

/** A server notification envelope; emitted_at_ms is retained when present. */
export interface ServerNotification {
  method: string;
  params?: unknown;
  emittedAtMs?: number;
}

/** A request initiated by app-server. It is emitted and deliberately not answered here. */
export interface ServerRequest {
  id: RequestId;
  method: string;
  params?: unknown;
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface AppServerClientOptions {
  /** Executable used for `codex app-server --stdio`. */
  executable?: string;
  cwd?: string;
  clientInfo?: ClientInfo;
  capabilities?: InitializeCapabilities | null;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  closeTimeoutMs?: number;
  maxFrameBytes?: number;
  spawnImpl?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

export interface AppServerCloseEvent {
  code: number | null;
  signal: NodeJS.Signals | null;
  reason?: "exit" | "error" | "closed" | "protocol";
}

export class AppServerRpcError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "AppServerRpcError";
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type RpcMessage = {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_FRAME_BYTES = 1 * 1024 * 1024;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

function timeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error("app-server timeout must be a positive finite number");
  return Math.min(value, MAX_TIMEOUT_MS);
}

function frameLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_FRAME_BYTES;
  if (!Number.isInteger(value) || value <= 0) throw new Error("app-server frame limit must be a positive integer");
  return Math.min(value, MAX_FRAME_BYTES);
}

function isRequestId(value: unknown): value is RequestId {
  return (typeof value === "string" && value.length > 0) || (typeof value === "number" && Number.isFinite(value));
}

function idKey(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(typeof error === "string" ? error : fallback);
}

function errorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "app-server request failed";
  const record = error as Record<string, unknown>;
  return typeof record.message === "string" && record.message.length > 0
    ? record.message.slice(0, 400)
    : "app-server request failed";
}

/**
 * Minimal JSONL JSON-RPC client for a dedicated `codex app-server --stdio` process.
 * Server initiated requests are surfaced to the caller and never auto-approved.
 */
export class CodexAppServerClient extends EventEmitter {
  private readonly executable: string;
  private readonly cwd: string | undefined;
  private readonly clientInfo: ClientInfo;
  private readonly capabilities: InitializeCapabilities | null;
  private readonly startupTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly spawnImpl: NonNullable<AppServerClientOptions["spawnImpl"]>;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private frameBuffer = Buffer.alloc(0);
  private state: "idle" | "starting" | "running" | "closed" = "idle";
  private startPromise: Promise<InitializeResponse> | null = null;
  private closeEvent: AppServerCloseEvent | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private shutdownResolve: (() => void) | null = null;
  private shutdownReject: ((error: Error) => void) | null = null;
  private shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCloseEvent: AppServerCloseEvent | null = null;
  private childExited = false;

  constructor(options: AppServerClientOptions = {}) {
    super();
    this.executable = options.executable ?? "codex";
    this.cwd = options.cwd;
    this.clientInfo = options.clientInfo ?? {
      name: "codex-with-chatgpt",
      title: "Codex with ChatGPT",
      version: VERSION,
    };
    this.capabilities = options.capabilities ?? { experimentalApi: false, requestAttestation: false };
    this.startupTimeoutMs = timeout(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
    this.requestTimeoutMs = timeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.closeTimeoutMs = timeout(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS);
    this.maxFrameBytes = frameLimit(options.maxFrameBytes);
    this.spawnImpl = options.spawnImpl ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  }

  /** Start the child, complete initialize/initialized, and return initialize's result. */
  start(): Promise<InitializeResponse> {
    if (this.state === "running") return Promise.resolve(this.startResult as InitializeResponse);
    if (this.startPromise) return this.startPromise;
    if (this.state === "closed") return Promise.reject(new Error("app-server client is closed"));

    let child: ChildProcess;
    try {
      const options: SpawnOptions = { stdio: ["pipe", "pipe", "pipe"], windowsHide: true };
      if (this.cwd !== undefined) options.cwd = this.cwd;
      child = this.spawnImpl(this.executable, ["app-server", "--stdio"], options);
    } catch (error) {
      const failure = asError(error, "failed to start app-server");
      this.state = "closed";
      this.emitError(failure);
      this.emitClose({ code: null, signal: null, reason: "error" });
      return Promise.reject(failure);
    }

    this.child = child;
    this.childExited = false;
    this.state = "starting";
    this.attach(child);
    this.startPromise = this.startHandshake();
    return this.startPromise;
  }

  private startResult: InitializeResponse | null = null;

  private async startHandshake(): Promise<InitializeResponse> {
    try {
      const result = await this.requestInternal<InitializeResponse>(
        "initialize",
        { clientInfo: this.clientInfo, capabilities: this.capabilities } satisfies InitializeParams,
        this.startupTimeoutMs,
      );
      this.sendNotification("initialized");
      this.startResult = result;
      this.state = "running";
      return result;
    } catch (error) {
      const failure = asError(error, "app-server initialization failed");
      this.fail(failure, "error", true);
      throw failure;
    } finally {
      this.startPromise = null;
    }
  }

  /** Send an arbitrary app-server request after startup. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.state !== "running") return Promise.reject(new Error("app-server client is not running"));
    return this.requestInternal<T>(method, params, this.requestTimeoutMs);
  }

  private requestInternal<T>(method: string, params: unknown, waitMs: number): Promise<T> {
    if (!method || method.length > 256) return Promise.reject(new Error("app-server method is invalid"));
    const child = this.child;
    const stdin = child?.stdin;
    if (!child || !stdin || stdin.destroyed || stdin.writableEnded) {
      return Promise.reject(new Error("app-server process is unavailable"));
    }

    const id = this.nextId++;
    const message: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    let encoded: string;
    try {
      encoded = JSON.stringify(message);
    } catch {
      return Promise.reject(new Error("app-server request parameters are not serializable"));
    }
    if (Buffer.byteLength(encoded, "utf8") > this.maxFrameBytes) {
      return Promise.reject(new Error("app-server request exceeds frame limit"));
    }

    return new Promise<T>((resolve, reject) => {
      const key = idKey(id);
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`app-server request timed out after ${waitMs}ms`));
      }, waitMs);
      this.pending.set(key, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        stdin.write(`${encoded}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(key);
        reject(asError(error, "failed to write app-server request"));
      }
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    const child = this.child;
    const stdin = child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) throw new Error("app-server process is unavailable");
    const message: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    const encoded = JSON.stringify(message);
    if (Buffer.byteLength(encoded, "utf8") > this.maxFrameBytes) throw new Error("app-server notification exceeds frame limit");
    stdin.write(`${encoded}\n`);
  }

  private attach(child: ChildProcess): void {
    child.stdout?.on("data", (chunk: Buffer | string) => this.consume(chunk));
    child.stdout?.on("error", (error) => this.fail(asError(error, "app-server stdout failed"), "error", true));
    child.stdin?.on("error", (error) => this.fail(asError(error, "app-server stdin failed"), "error", true));
    // Drain stderr but never include it in an event or error. It may contain credentials or prompt content.
    child.stderr?.on("data", () => undefined);
    child.stderr?.on("error", () => undefined);
    child.once("error", (error) => this.fail(asError(error, "app-server process failed"), "error", true));
    const exited = (code: number | null, signal: NodeJS.Signals | null): void => this.onChildExit(child, code, signal);
    child.once("exit", exited);
    child.once("close", exited);
  }

  private onChildExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child || this.childExited) return;
    this.childExited = true;
    this.child = null;
    if (this.state !== "closed") {
      this.fail(new Error(`app-server process exited (code ${code ?? "null"})`), "exit", false, { code, signal });
      return;
    }
    this.finishShutdown({
      code,
      signal,
      reason: this.pendingCloseEvent?.reason ?? "exit",
    });
  }

  private consume(chunk: Buffer | string): void {
    if ((this.state as string) === "closed") return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < data.length) {
      if ((this.state as string) === "closed") return;
      const newline = data.indexOf(0x0a, offset);
      if (newline < 0) {
        this.append(data.subarray(offset));
        return;
      }
      this.append(data.subarray(offset, newline));
      const line = this.frameBuffer;
      this.frameBuffer = Buffer.alloc(0);
      offset = newline + 1;
      this.handleFrame(line);
    }
  }

  private append(part: Uint8Array): void {
    if (this.frameBuffer.length + part.length > this.maxFrameBytes) {
      this.fail(new Error("app-server frame exceeds size limit"), "protocol", true);
      return;
    }
    if (part.length > 0) this.frameBuffer = Buffer.concat([this.frameBuffer, part]);
  }

  private handleFrame(raw: Buffer): void {
    if (raw.at(-1) === 0x0d) raw = raw.subarray(0, raw.length - 1);
    if (raw.length === 0) {
      this.fail(new Error("app-server sent an empty frame"), "protocol", true);
      return;
    }
    let message: RpcMessage;
    try {
      message = JSON.parse(raw.toString("utf8")) as RpcMessage;
    } catch {
      this.fail(new Error("app-server sent invalid JSON"), "protocol", true);
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.fail(new Error("app-server sent an invalid JSON-RPC message"), "protocol", true);
      return;
    }

    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        if (!isRequestId(message.id)) {
          this.fail(new Error("app-server sent a request with an invalid id"), "protocol", true);
          return;
        }
        this.emit("request", {
          id: message.id,
          method: message.method,
          ...(message.params !== undefined ? { params: message.params } : {}),
        } satisfies ServerRequest);
      } else {
        const emittedAtMs = (message as Record<string, unknown>).emittedAtMs;
        this.emit("notification", {
          method: message.method,
          ...(message.params !== undefined ? { params: message.params } : {}),
          ...(typeof emittedAtMs === "number"
            ? { emittedAtMs }
            : {}),
        } satisfies ServerNotification);
      }
      return;
    }

    if (!isRequestId(message.id)) {
      this.fail(new Error("app-server sent a response with an invalid id"), "protocol", true);
      return;
    }
    const pending = this.pending.get(idKey(message.id));
    if (!pending) return;
    this.pending.delete(idKey(message.id));
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      const rpcError = message.error && typeof message.error === "object" ? message.error as Record<string, unknown> : {};
      const code = typeof rpcError.code === "number" ? rpcError.code : -32000;
      pending.reject(new AppServerRpcError(errorMessage(message.error), code, rpcError.data));
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(message, "result")) {
      pending.reject(new Error("app-server response has neither result nor error"));
      return;
    }
    pending.resolve(message.result);
  }

  /** Stop the child and reject all in-flight requests. Resolves only after it exits. */
  close(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (this.state === "closed") return Promise.resolve();
    this.fail(new Error("app-server client closed"), "closed", false, { code: null, signal: null });
    return this.shutdownPromise ?? Promise.resolve();
  }

  private fail(
    error: Error,
    reason: AppServerCloseEvent["reason"],
    emitError: boolean,
    status?: { code: number | null; signal: NodeJS.Signals | null },
  ): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.frameBuffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (emitError) this.emitError(error);

    const child = this.child;
    const closeEvent = { code: status?.code ?? null, signal: status?.signal ?? null, reason } satisfies AppServerCloseEvent;
    this.pendingCloseEvent = closeEvent;
    if (!child || this.childExited) {
      this.finishShutdown(closeEvent);
      return;
    }
    this.beginShutdown(child);
  }

  private beginShutdown(child: ChildProcess): void {
    if (this.shutdownPromise) return;
    this.shutdownPromise = new Promise<void>((resolve, reject) => {
      this.shutdownResolve = resolve;
      this.shutdownReject = reject;
      this.shutdownTimer = setTimeout(() => {
        this.shutdownResolve = null;
        this.shutdownReject = null;
        this.shutdownTimer = null;
        reject(new Error("app-server process did not exit after close"));
      }, this.closeTimeoutMs);
    });
    // A startup/protocol failure may have no caller awaiting close(); keep the
    // internal shutdown rejection observable through close() without creating
    // an unhandled rejection in that path.
    this.shutdownPromise.catch(() => undefined);
    try {
      child.kill();
    } catch (error) {
      const failure = asError(error, "failed to stop app-server process");
      if (this.shutdownTimer) clearTimeout(this.shutdownTimer);
      this.shutdownTimer = null;
      this.shutdownResolve = null;
      this.shutdownReject?.(failure);
      this.shutdownReject = null;
    }
  }

  private finishShutdown(event: AppServerCloseEvent): void {
    if (this.shutdownTimer) clearTimeout(this.shutdownTimer);
    this.shutdownTimer = null;
    this.emitClose(event);
    this.shutdownResolve?.();
    this.shutdownResolve = null;
    this.shutdownReject = null;
  }

  private emitError(error: Error): void {
    // EventEmitter treats an unhandled `error` event as a process crash. Keep a
    // client failure observable without making a missing listener fatal.
    if (this.listenerCount("error") > 0) this.emit("error", error);
  }

  private emitClose(event: AppServerCloseEvent): void {
    if (this.closeEvent) return;
    this.closeEvent = event;
    this.emit("close", event);
  }
}

export { CodexAppServerClient as AppServerClient };
export default CodexAppServerClient;
