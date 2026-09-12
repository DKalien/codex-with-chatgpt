import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { DesktopError, MAX_MESSAGE_BYTES } from "./store.js";

/** 已绑定的本机 Desktop 会话；字段来自用户明确选择的目标。 */
export interface DesktopTarget {
  threadId: string;
  hostId: string;
  projectId: string;
  workspaceRoot: string;
}

export interface DesktopTargetInfo extends DesktopTarget {
  title: string;
  cwd: string;
  workspaceKind?: string;
  resumeState?: string;
  runtimeStatus?: string;
  requestsCount?: number;
  desktopVersion?: string;
  appServerVersion?: string;
  /** 内部诊断字段；不会由 MCP 直接返回。 */
  ownerClientId?: string | null;
}

export interface DesktopExecutionInfo extends DesktopTargetInfo {
  activeTurnId: string;
}

export interface DesktopIpcConnection {
  send(message: string): Promise<{ threadId: string; turnId: string }>;
  close(): void;
}

export interface DesktopIpcOptions {
  /** 仅测试替换；产品默认使用 Node spawn，shell 永远为 false。 */
  spawnImpl?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  pythonExecutable?: string;
  helperPath?: string;
  platform?: NodeJS.Platform;
  requestTimeoutMs?: number;
  sendTimeoutMs?: number;
}

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

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_SEND_TIMEOUT_MS = 40_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_CONTROL_FRAME_BYTES = 512 * 1024;
const SEND_REQUEST_ID_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

const SAFE_CODES = new Set([
  "DESKTOP_UNSUPPORTED_PLATFORM",
  "DESKTOP_TOKEN_UNVERIFIED",
  "DESKTOP_ELEVATED",
  "DESKTOP_TOKEN_INTEGRITY",
  "DESKTOP_IPC_UNAVAILABLE",
  "DESKTOP_IPC_SERVER_MISMATCH",
  "DESKTOP_PROCESS_CHANGED",
  "DESKTOP_VERSION_UNSUPPORTED",
  "DESKTOP_PROJECT_MISMATCH",
  "DESKTOP_TARGET_NOT_FOUND",
  "DESKTOP_NO_OWNER",
  "DESKTOP_OWNER_CHANGED",
  "DESKTOP_BUSY",
  "DESKTOP_APPROVAL_PENDING",
  "DESKTOP_STATE_UNAVAILABLE",
  "DESKTOP_IPC_TIMEOUT",
  "DESKTOP_IPC_REJECTED",
  "DESKTOP_OUTCOME_UNKNOWN",
  "DESKTOP_PROTOCOL_ERROR",
  "DESKTOP_INTERNAL_ERROR",
  "DESKTOP_PYTHON_UNAVAILABLE",
  "DESKTOP_PYTHON_UNSUPPORTED",
  "DESKTOP_INVALID_REQUEST",
  "DESKTOP_MESSAGE_TOO_LARGE",
  "DESKTOP_CURRENT_CONTEXT_INVALID",
  "DESKTOP_CONFIRMATION_CANCELLED",
]);

const ERROR_MESSAGES: Record<string, string> = {
  DESKTOP_UNSUPPORTED_PLATFORM: "当前平台不支持 Desktop Control。",
  DESKTOP_TOKEN_UNVERIFIED: "当前进程权限无法安全确认；已拒绝 Desktop 投递。",
  DESKTOP_ELEVATED: "当前进程为提升权限；为避免跨权限 IPC，已拒绝 Desktop 投递。",
  DESKTOP_TOKEN_INTEGRITY: "当前进程完整性级别不符合 Desktop 投递要求。",
  DESKTOP_IPC_UNAVAILABLE: "Codex Desktop 当前不可用；没有发送消息。",
  DESKTOP_IPC_SERVER_MISMATCH: "Desktop IPC 服务端身份不匹配；没有发送消息。",
  DESKTOP_PROCESS_CHANGED: "Desktop/app-server 进程已变化；没有发送消息。",
  DESKTOP_VERSION_UNSUPPORTED: "当前 Desktop/app-server 版本未经过适配验证；没有发送消息。",
  DESKTOP_PROJECT_MISMATCH: "Desktop 会话项目或实际目录与绑定不匹配；没有发送消息。",
  DESKTOP_TARGET_NOT_FOUND: "找不到绑定的 Desktop 会话；没有发送消息。",
  DESKTOP_NO_OWNER: "绑定会话没有可确认的 Desktop owner；没有发送消息。",
  DESKTOP_OWNER_CHANGED: "Desktop 会话 owner 已变化；没有发送消息。",
  DESKTOP_BUSY: "Desktop 会话当前忙；没有发送消息。",
  DESKTOP_APPROVAL_PENDING: "Desktop 会话有待处理审批或用户输入；没有发送消息。",
  DESKTOP_STATE_UNAVAILABLE: "Desktop 会话状态无法安全确认；没有发送消息。",
  DESKTOP_IPC_TIMEOUT: "Desktop IPC 接受回执超时；没有发送消息。",
  DESKTOP_IPC_REJECTED: "Desktop 拒绝了投递；结果无法作为成功确认。",
  DESKTOP_OUTCOME_UNKNOWN: "Desktop 投递结果不明，消息可能已执行；不要重发。",
  DESKTOP_PROTOCOL_ERROR: "Desktop IPC 返回无法确认的结果；不要重发。",
  DESKTOP_INTERNAL_ERROR: "Desktop Control 暂时不可用；没有发送消息。",
  DESKTOP_PYTHON_UNAVAILABLE: "无法启动 Desktop IPC helper 的 Python 运行时；没有发送消息。",
  DESKTOP_PYTHON_UNSUPPORTED: "运行 Desktop IPC helper 需要 Python 3.11 或更高版本；没有发送消息。",
  DESKTOP_INVALID_REQUEST: "Desktop Control 请求格式无效；没有发送消息。",
  DESKTOP_MESSAGE_TOO_LARGE: "消息超过 64 KiB UTF-8 上限；拒绝投递，不截断。",
  DESKTOP_CURRENT_CONTEXT_INVALID: "无法确认当前 Desktop 会话身份或来源；未绑定或启用。",
  DESKTOP_CONFIRMATION_CANCELLED: "本机确认被取消或未完成；未绑定或启用。",
};

function messageFor(code: string, fallback = "DESKTOP_INTERNAL_ERROR"): string {
  return ERROR_MESSAGES[code] ?? ERROR_MESSAGES[fallback] ?? "Desktop Control 暂时不可用。";
}

function error(code: string, options: { notSent?: boolean } = {}): DesktopError & { notSent: boolean } {
  const result = new DesktopError(code, messageFor(code)) as DesktopError & { notSent: boolean };
  result.notSent = options.notSent ?? true;
  return result;
}

function timeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error("Desktop IPC timeout must be a positive finite number");
  return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
}

function isUuid(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
  return match && value === value.toLowerCase();
}

function validateTarget(value: DesktopTarget): DesktopTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("DESKTOP_INVALID_REQUEST");
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== ["hostId", "projectId", "threadId", "workspaceRoot"].join(",")) throw error("DESKTOP_INVALID_REQUEST");
  if (!isUuid(value.threadId) || value.hostId !== "local" || typeof value.projectId !== "string" ||
      value.projectId.length < 1 || value.projectId.length > 128 || typeof value.workspaceRoot !== "string" || !value.workspaceRoot.trim()) {
    throw error("DESKTOP_INVALID_REQUEST");
  }
  return { ...value };
}

function validateMessage(value: string): string {
  if (typeof value !== "string" || value.length === 0) throw error("DESKTOP_INVALID_REQUEST");
  const encoded = Buffer.from(value, "utf8");
  if (encoded.toString("utf8") !== value) throw error("DESKTOP_INVALID_REQUEST");
  if (encoded.byteLength > MAX_MESSAGE_BYTES) throw error("DESKTOP_MESSAGE_TOO_LARGE");
  return value;
}

export function validateDesktopWireMessage(value: string): string {
  const text = validateMessage(value);
  let encoded: string;
  try { encoded = JSON.stringify({ id: SEND_REQUEST_ID_PLACEHOLDER, op: "send", message: text }) + "\n"; }
  catch { throw error("DESKTOP_PROTOCOL_ERROR"); }
  if (Buffer.byteLength(encoded, "utf8") > MAX_CONTROL_FRAME_BYTES) throw error("DESKTOP_MESSAGE_TOO_LARGE");
  return text;
}

function validateInfo(value: unknown, target: DesktopTarget): DesktopTargetInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("DESKTOP_PROTOCOL_ERROR");
  const info = value as Partial<DesktopTargetInfo>;
  if (info.threadId !== target.threadId || info.hostId !== target.hostId || info.projectId !== target.projectId ||
      info.workspaceRoot !== target.workspaceRoot) throw error("DESKTOP_TARGET_NOT_FOUND");
  if (typeof info.title !== "string" || !info.title.trim() || info.title.length > 300 || typeof info.cwd !== "string" ||
      normalizePath(info.cwd) !== normalizePath(target.workspaceRoot)) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  return { ...target, ...info } as DesktopTargetInfo;
}

function validateExecutionInfo(value: unknown, target: DesktopTarget): DesktopExecutionInfo {
  const info = validateInfo(value, target);
  if (info.runtimeStatus !== "active" && info.runtimeStatus !== "inProgress") {
    throw error("DESKTOP_STATE_UNAVAILABLE");
  }
  const activeTurnId = (value as { activeTurnId?: unknown }).activeTurnId;
  if (!isUuid(activeTurnId)) throw error("DESKTOP_STATE_UNAVAILABLE");
  return { ...info, activeTurnId };
}

function normalizePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized;
}

function validateReceipt(value: unknown, target: DesktopTarget): { threadId: string; turnId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("DESKTOP_OUTCOME_UNKNOWN", { notSent: false });
  const receipt = value as Partial<{ threadId: string; turnId: string }>;
  if (!isUuid(receipt.threadId) || !isUuid(receipt.turnId) || receipt.threadId !== target.threadId) {
    throw error("DESKTOP_OUTCOME_UNKNOWN", { notSent: false });
  }
  return { threadId: receipt.threadId, turnId: receipt.turnId };
}

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
        const notSent = response.notSent === true;
        pending.reject(error(requestedCode, { notSent }));
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

export class DesktopIpcClient {
  private readonly spawnImpl: NonNullable<DesktopIpcOptions["spawnImpl"]>;
  private readonly pythonExecutable: string;
  private readonly helperPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly requestTimeoutMs: number;
  private readonly sendTimeoutMs: number;

  constructor(options: DesktopIpcOptions = {}) {
    this.spawnImpl = options.spawnImpl ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    this.pythonExecutable = options.pythonExecutable ?? process.env.C2C_DESKTOP_PYTHON?.trim() ?? "python";
    this.helperPath = options.helperPath ?? resolveDesktopHelperPath();
    this.platform = options.platform ?? process.platform;
    this.requestTimeoutMs = timeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.sendTimeoutMs = timeout(options.sendTimeoutMs, DEFAULT_SEND_TIMEOUT_MS);
  }

  async inspect(rawTarget: DesktopTarget): Promise<DesktopTargetInfo> {
    const target = validateTarget(rawTarget);
    const session = this.open();
    try {
      const value = await session.request("inspect", { target });
      return validateInfo(value, target);
    } finally {
      session.close();
    }
  }

  async currentIdentity(workspaceRoot: string): Promise<DesktopTargetInfo> {
    return this.currentOperation("current_identity", workspaceRoot);
  }

  async currentExecution(workspaceRoot: string): Promise<DesktopExecutionInfo> {
    return this.currentOperation("current_execution", workspaceRoot, validateExecutionInfo) as Promise<DesktopExecutionInfo>;
  }

  async confirmCurrent(workspaceRoot: string): Promise<DesktopTargetInfo> {
    return this.currentOperation("current_confirm", workspaceRoot);
  }

  private async currentOperation(operation: string, workspaceRoot: string,
    validate: (value: unknown, target: DesktopTarget) => DesktopTargetInfo = validateInfo): Promise<DesktopTargetInfo> {
    const threadId = process.env.CODEX_THREAD_ID;
    if (!isUuid(threadId) || (process.env.CODEX_SESSION_ID && process.env.CODEX_SESSION_ID !== threadId) ||
      typeof workspaceRoot !== "string" || !workspaceRoot.trim()) throw error("DESKTOP_CURRENT_CONTEXT_INVALID");
    const session = this.open();
    try {
      // 不传 thread/project/host：helper 从继承的当前 Agent 上下文和 Desktop 映射精确解析。
      const value = await session.request<DesktopTargetInfo>(operation, { workspaceRoot });
      const target = validateTarget({ threadId, hostId: "local", projectId: value?.projectId, workspaceRoot });
      return validate(value, target);
    } finally { session.close(); }
  }

  async prepare(rawTarget: DesktopTarget): Promise<DesktopIpcConnection> {
    const target = validateTarget(rawTarget);
    const session = this.open();
    try {
      const value = await session.request("prepare", { target });
      validateInfo(value, target);
      return {
        send: async (message: string) => {
          const text = validateMessage(message);
          const receipt = await session.request("send", { message: text });
          return validateReceipt(receipt, target);
        },
        close: () => session.close(),
      };
    } catch (failure) {
      session.close();
      throw failure;
    }
  }

  private open(): HelperSession {
    if (this.platform !== "win32") throw error("DESKTOP_UNSUPPORTED_PLATFORM");
    if (!this.helperPath || !fs.existsSync(this.helperPath)) throw error("DESKTOP_IPC_UNAVAILABLE");
    let child: ChildProcess;
    try {
      child = this.spawnImpl(this.pythonExecutable, ["-I", "-B", "-X", "utf8", this.helperPath], {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      throw error("DESKTOP_IPC_UNAVAILABLE");
    }
    return new HelperSession(child, this.requestTimeoutMs, this.sendTimeoutMs);
  }
}

/** 默认关闭由 service 的 enable 状态控制；构造本身不会连接 Desktop。 */
export const desktopIpc = new DesktopIpcClient();

export {
  ERROR_MESSAGES as DESKTOP_IPC_ERROR_MESSAGES,
  validateMessage as validateDesktopMessage,
  validateTarget as validateDesktopTarget,
};
