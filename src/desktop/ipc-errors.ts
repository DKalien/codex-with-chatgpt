import { DesktopError } from "./store.js";

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
// helper 单次 send 最坏路径上界（preflight 双份 5s discovery/snapshot +
// drain/current_state + 30s start-turn ACK + 30s post-start bounded wait +
// final discovery ≈ 86s）；外层超时必须大于该上界并留余量，否则 Node 会在
// helper 仍处于合法 bounded proof window 时先杀掉它，制造不必要的
// durable outcome_unknown。
export const DEFAULT_SEND_TIMEOUT_MS = 90_000;
export const MAX_TIMEOUT_MS = 120_000;
export const MAX_CONTROL_FRAME_BYTES = 512 * 1024;
export const SEND_REQUEST_ID_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

export const SAFE_CODES = new Set([
  "DESKTOP_UNSUPPORTED_PLATFORM",
  "DESKTOP_TOKEN_UNVERIFIED",
  "DESKTOP_ELEVATED",
  "DESKTOP_TOKEN_INTEGRITY",
  "DESKTOP_IPC_UNAVAILABLE",
  "DESKTOP_IPC_SERVER_MISMATCH",
  "DESKTOP_PROCESS_CHANGED",
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
  "DESKTOP_RECONCILIATION_CONFLICT",
]);

export const ERROR_MESSAGES: Record<string, string> = {
  DESKTOP_UNSUPPORTED_PLATFORM: "当前平台不支持 Desktop Control。",
  DESKTOP_TOKEN_UNVERIFIED: "当前进程权限无法安全确认；已拒绝 Desktop 投递。",
  DESKTOP_ELEVATED: "当前进程为提升权限；为避免跨权限 IPC，已拒绝 Desktop 投递。",
  DESKTOP_TOKEN_INTEGRITY: "当前进程完整性级别不符合 Desktop 投递要求。",
  DESKTOP_IPC_UNAVAILABLE: "Codex Desktop 当前不可用；没有发送消息。",
  DESKTOP_IPC_SERVER_MISMATCH: "Desktop IPC 服务端身份不匹配；没有发送消息。",
  DESKTOP_PROCESS_CHANGED: "Desktop/app-server 进程已变化；没有发送消息。",
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
  DESKTOP_PROTOCOL_ERROR: "Desktop 协议无法安全确认；没有发送消息。",
  DESKTOP_INTERNAL_ERROR: "Desktop Control 暂时不可用；没有发送消息。",
  DESKTOP_PYTHON_UNAVAILABLE: "无法启动 Desktop IPC helper 的 Python 运行时；没有发送消息。",
  DESKTOP_PYTHON_UNSUPPORTED: "运行 Desktop IPC helper 需要 Python 3.11 或更高版本；没有发送消息。",
  DESKTOP_INVALID_REQUEST: "Desktop Control 请求格式无效；没有发送消息。",
  DESKTOP_MESSAGE_TOO_LARGE: "消息超过 64 KiB UTF-8 上限；拒绝投递，不截断。",
  DESKTOP_CURRENT_CONTEXT_INVALID: "无法确认当前 Desktop 会话身份或来源；未绑定或启用。",
  DESKTOP_CONFIRMATION_CANCELLED: "本机确认被取消或未完成；未绑定或启用。",
  DESKTOP_RECONCILIATION_CONFLICT: "Desktop 历史无法唯一核对；未恢复结果或修改投递状态。",
};

export function messageFor(code: string, fallback = "DESKTOP_INTERNAL_ERROR"): string {
  return ERROR_MESSAGES[code] ?? ERROR_MESSAGES[fallback] ?? "Desktop Control 暂时不可用。";
}

export function error(code: string, options: { notSent?: boolean } = {}): DesktopError & { notSent: boolean } {
  const result = new DesktopError(code, messageFor(code)) as DesktopError & { notSent: boolean };
  result.notSent = options.notSent ?? true;
  return result;
}

export function timeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error("Desktop IPC timeout must be a positive finite number");
  return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
}

export function isUuid(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
  return match && value === value.toLowerCase();
}
