import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import type { DesktopIpcOptions } from "./ipc-contracts.js";
import {
  error,
  MAX_CONTROL_FRAME_BYTES,
  SAFE_CODES,
} from "./ipc-errors.js";

type HelperResponse = {
  id?: unknown;
  ok?: unknown;
  value?: unknown;
  code?: unknown;
  notSent?: unknown;
};

type Pending = {
  operation: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Resolve the bundled helper without turning a temporary investigation path
 * into a product dependency. The build copies src/desktop/helper beside dist;
 * source execution remains useful for Vitest/tsx.
 */
export function resolveDesktopHelperPath(moduleUrl = import.meta.url): string {
  const here = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    path.join(here, "helper", "desktop_ipc.py"),
    path.resolve(here, "..", "..", "src", "desktop", "helper", "desktop_ipc.py"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  return found ?? candidates[0];
}

class HelperSession {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, Pending>();
  private buffer = "";
  private closed = false;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(child: ChildProcess, private readonly requestTimeoutMs: number, private readonly sendTimeoutMs: number) {
    this.child = child;
    child.stdout?.on("data", (chunk: string | Buffer) => this.consume(chunk));
    child.stdout?.on("error", () => this.failPending("DESKTOP_IPC_UNAVAILABLE"));
    child.stdin?.on("error", () => this.failPending("DESKTOP_IPC_UNAVAILABLE"));
    child.once("error", () => this.failPending("DESKTOP_PYTHON_UNAVAILABLE"));
    child.once("exit", () => this.failPending("DESKTOP_IPC_UNAVAILABLE"));
  }

  request<T>(operation: string, payload: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(error("DESKTOP_IPC_UNAVAILABLE"));
    const id = randomUUID();
    let encoded: string;
    try {
      encoded = JSON.stringify({ id, op: operation, ...payload }) + "\n";
    } catch {
      return Promise.reject(error("DESKTOP_PROTOCOL_ERROR"));
    }
    if (Buffer.byteLength(encoded, "utf8") > MAX_CONTROL_FRAME_BYTES) return Promise.reject(error("DESKTOP_MESSAGE_TOO_LARGE"));
    const waitMs = operation === "current_confirm" ? 120_000 : operation === "send" ? this.sendTimeoutMs : this.requestTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(error(operation === "send" ? "DESKTOP_OUTCOME_UNKNOWN" :
          operation === "current_confirm" ? "DESKTOP_CONFIRMATION_CANCELLED" : "DESKTOP_IPC_TIMEOUT", { notSent: operation !== "send" }));
      }, waitMs);
      this.pending.set(id, { operation, resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        if (!this.child.stdin || this.child.stdin.destroyed || this.child.stdin.writableEnded) throw new Error("stdin closed");
        this.child.stdin.write(encoded);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error(operation === "send" ? "DESKTOP_OUTCOME_UNKNOWN" : "DESKTOP_IPC_UNAVAILABLE", { notSent: operation !== "send" }));
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error(
        pending.operation === "send" ? "DESKTOP_OUTCOME_UNKNOWN" : "DESKTOP_IPC_UNAVAILABLE",
        { notSent: pending.operation !== "send" },
      ));
    }
    this.pending.clear();
    try { this.child.stdin?.end(); } catch { /* best effort */ }
    try { if (!this.child.killed) this.child.kill(); } catch { /* best effort */ }
  }

  private consume(chunk: string | Buffer): void {
    if (this.closed) return;
    let decoded: string;
    try {
      decoded = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    } catch {
      this.failPending("DESKTOP_PROTOCOL_ERROR");
      this.close();
      return;
    }
    this.buffer += decoded;
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_CONTROL_FRAME_BYTES) {
      this.failPending("DESKTOP_PROTOCOL_ERROR");
      this.close();
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) {
        this.failPending("DESKTOP_PROTOCOL_ERROR");
        continue;
      }
      let response: HelperResponse;
      try { response = JSON.parse(line) as HelperResponse; } catch {
        this.failPending("DESKTOP_PROTOCOL_ERROR");
        continue;
      }
      if (!response || typeof response !== "object" || typeof response.id !== "string") continue;
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.ok === true) {
        pending.resolve(response.value);
      } else {
        const requestedCode = typeof response.code === "string" && SAFE_CODES.has(response.code)
          ? response.code
          : pending.operation === "send" ? "DESKTOP_OUTCOME_UNKNOWN" : "DESKTOP_PROTOCOL_ERROR";
        // 缺失 notSent 不能证明尚未进入真实 start；send 必须保守为 unknown。
        pending.reject(error(requestedCode, { notSent: response.notSent === true }));
      }
    }
  }

  private failPending(code: string): void {
    if (this.closed) return;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      const uncertain = pending.operation === "send";
      pending.reject(error(uncertain ? "DESKTOP_OUTCOME_UNKNOWN" : code, { notSent: !uncertain }));
      this.pending.delete(id);
    }
  }
}

export function openHelperSession(
  platform: NodeJS.Platform,
  helperPath: string,
  pythonExecutable: string,
  spawnImpl: NonNullable<DesktopIpcOptions["spawnImpl"]>,
  requestTimeoutMs: number,
  sendTimeoutMs: number,
): HelperSession {
  if (platform !== "win32") throw error("DESKTOP_UNSUPPORTED_PLATFORM");
  if (!helperPath || !fs.existsSync(helperPath)) throw error("DESKTOP_IPC_UNAVAILABLE");
  let child: ChildProcess;
  try {
    child = spawnImpl(pythonExecutable, ["-I", "-B", "-X", "utf8", helperPath], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    throw error("DESKTOP_IPC_UNAVAILABLE");
  }
  return new HelperSession(child, requestTimeoutMs, sendTimeoutMs);
}
