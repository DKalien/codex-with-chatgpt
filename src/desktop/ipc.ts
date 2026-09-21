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
  profile?: string | null;
  /** 内部诊断字段；不会由 MCP 直接返回。 */
  ownerClientId?: string | null;
}

export type DesktopCompatibilityStatus = "current" | "unverified" | "incompatible";

export interface DesktopCompatibility {
  observedDesktopVersion: string | null;
  observedAppServerVersion: string | null;
  status: DesktopCompatibilityStatus;
  profile: string | null;
}

export type DesktopCompatibilityAuditClassification =
  | "current"
  | "same_protocol_candidate"
  | "protocol_drift_or_unknown"
  | "ambiguous"
  | "unavailable";

export type DesktopCompatibilityAuditModuleRole = "ipc-main" | "webview-bootstrap";

export interface DesktopCompatibilityAuditModule {
  role: DesktopCompatibilityAuditModuleRole;
  path: string;
  sha256: string;
}

export interface DesktopCompatibilityCandidateRuntime {
  desktopVersion: string;
  appServerVersion: string;
  appServerSha256: string;
  asarHeader: [number, number, number, number];
  modules: DesktopCompatibilityAuditModule[];
}

export interface DesktopCompatibilityAudit extends DesktopCompatibility {
  classification: DesktopCompatibilityAuditClassification;
  appServerSha256: string | null;
  asarHeader: [number, number, number, number] | null;
  candidateProfile: string | null;
  modules: DesktopCompatibilityAuditModule[];
  candidateRuntime?: DesktopCompatibilityCandidateRuntime;
}

export interface DesktopHandshakeAudit {
  processStable: true;
  runtimeStable: true;
  protocolClassification: DesktopCompatibilityAuditClassification;
  initialize: true;
  ownerDiscovery: true;
  followingChangedSent: true;
  stateReceived: true;
  stateChange: "snapshot" | "patches";
}

export interface DesktopExecutionInfo extends DesktopTargetInfo {
  activeTurnId: string;
}

export type DesktopResultTurnStatus = "inProgress" | "completed" | "failed" | "interrupted" | "cancelled";

export interface DesktopResultContext extends DesktopTargetInfo {
  resultTurnId: string;
  resultTurnStatus: DesktopResultTurnStatus;
}

export type DesktopResultOwnershipKind = "origin" | "native_continuation";

export interface DesktopResultOwnershipExpectation extends DesktopUnknownReconcileExpectation {
  originTurnId: string;
}

export interface DesktopResultOwnership extends DesktopResultContext {
  ownership: DesktopResultOwnershipKind;
  originTurnId: string;
  chainTurnIds: string[];
  chainLength: number;
  signature: "capacity_retry_automatic" | null;
}

export interface DesktopUnknownReconcileExpectation {
  workspaceId: string;
  commandId: string;
  intent: "development_plan" | "revision";
  messageBytes: number;
  messageSha256: string;
}

export interface DesktopUnknownReconcileObservation {
  threadId: string;
  hostId: "local";
  projectId: string;
  workspaceRoot: string;
  candidates: string[];
}

const MAX_RESULT_CONTINUATION_CHAIN = 8;

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
  compatibility?: unknown;
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
  "DESKTOP_RECONCILIATION_CONFLICT",
]);

const COMPATIBILITY_VERSION = /^\d+\.\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const COMPATIBILITY_PROFILE = /^desktop-ipc-v[1-9]\d*$/;
const COMPATIBILITY_STATUSES = new Set<DesktopCompatibilityStatus>([
  "current",
  "unverified",
  "incompatible",
]);
const COMPATIBILITY_AUDIT_CLASSIFICATIONS = new Set<DesktopCompatibilityAuditClassification>([
  "current",
  "same_protocol_candidate",
  "protocol_drift_or_unknown",
  "ambiguous",
  "unavailable",
]);
const COMPATIBILITY_AUDIT_MODULE_ROLES = new Set<DesktopCompatibilityAuditModuleRole>([
  "ipc-main",
  "webview-bootstrap",
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
  DESKTOP_RECONCILIATION_CONFLICT: "Desktop 历史无法唯一核对；未恢复结果或修改投递状态。",
};

function messageFor(code: string, fallback = "DESKTOP_INTERNAL_ERROR"): string {
  return ERROR_MESSAGES[code] ?? ERROR_MESSAGES[fallback] ?? "Desktop Control 暂时不可用。";
}

function compatibilityVersion(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 64 || !COMPATIBILITY_VERSION.test(value)) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  return value;
}

function compatibilityProfile(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 64 || !COMPATIBILITY_PROFILE.test(value)) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  return value;
}

export function validateDesktopCompatibility(value: unknown): DesktopCompatibility {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("DESKTOP_PROTOCOL_ERROR");
  const input = value as Record<string, unknown>;
  for (const key of ["observedDesktopVersion", "observedAppServerVersion", "status", "profile"] as const) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) throw error("DESKTOP_PROTOCOL_ERROR");
  }
  const status = input.status;
  if (typeof status !== "string" || !COMPATIBILITY_STATUSES.has(status as DesktopCompatibilityStatus)) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  const observedDesktopVersion = compatibilityVersion(input.observedDesktopVersion);
  const observedAppServerVersion = compatibilityVersion(input.observedAppServerVersion);
  const profile = compatibilityProfile(input.profile);
  if (status === "current" && (!observedDesktopVersion || !observedAppServerVersion || !profile)) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  return {
    observedDesktopVersion,
    observedAppServerVersion,
    status: status as DesktopCompatibilityStatus,
    profile,
  };
}

const AUDIT_HASH = /^[a-f0-9]{64}$/u;
const AUDIT_DESKTOP_VERSION = /^\d+\.\d+\.\d+\.\d+$/u;
const MAX_AUDIT_ASAR_HEADER_BYTES = 64 * 1024 * 1024;
const AUDIT_MODULE_PATHS: Record<DesktopCompatibilityAuditModuleRole, RegExp> = {
  "ipc-main": /^\.vite\/build\/src-[A-Za-z0-9_-]+\.js$/u,
  "webview-bootstrap": /^webview\/assets\/app-initial-[A-Za-z0-9_-]+\.js$/u,
};

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return keys.length >= required.length && keys.length <= allowed.size && keys.every(key => allowed.has(key)) && required.every(key =>
    Object.prototype.hasOwnProperty.call(value, key));
}

function auditHash(value: unknown, nullable: false): string;
function auditHash(value: unknown, nullable?: true): string | null;
function auditHash(value: unknown, nullable = true): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || !AUDIT_HASH.test(value)) throw error("DESKTOP_PROTOCOL_ERROR");
  return value;
}

function auditAsarHeader(value: unknown, nullable: false): [number, number, number, number];
function auditAsarHeader(value: unknown, nullable?: true): [number, number, number, number] | null;
function auditAsarHeader(value: unknown, nullable = true): [number, number, number, number] | null {
  if (value === null && nullable) return null;
  if (!Array.isArray(value) || value.length !== 4 || value.some(item =>
    !Number.isInteger(item) || item < 0 || item > MAX_AUDIT_ASAR_HEADER_BYTES)) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  if (value[0] !== 4 || value[1] !== value[2] + 4 || value[2] !== value[3] + 7) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  return [...value] as [number, number, number, number];
}

function auditModule(value: unknown): DesktopCompatibilityAuditModule {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("DESKTOP_PROTOCOL_ERROR");
  const input = value as Record<string, unknown>;
  if (!exactKeys(input, ["role", "path", "sha256"])) throw error("DESKTOP_PROTOCOL_ERROR");
  const role = input.role;
  const modulePath = input.path;
  if (typeof role !== "string" || !COMPATIBILITY_AUDIT_MODULE_ROLES.has(role as DesktopCompatibilityAuditModuleRole) ||
      typeof modulePath !== "string" || !AUDIT_MODULE_PATHS[role as DesktopCompatibilityAuditModuleRole].test(modulePath)) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  const sha256 = auditHash(input.sha256, false);
  return { role: role as DesktopCompatibilityAuditModuleRole, path: modulePath, sha256 };
}

function auditModules(value: unknown): DesktopCompatibilityAuditModule[] {
  if (!Array.isArray(value) || value.length > 2) throw error("DESKTOP_PROTOCOL_ERROR");
  const modules = value.map(auditModule);
  if (new Set(modules.map(module => module.role)).size !== modules.length ||
      new Set(modules.map(module => module.path)).size !== modules.length) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  return modules;
}

function auditCandidateRuntime(value: unknown): DesktopCompatibilityCandidateRuntime {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("DESKTOP_PROTOCOL_ERROR");
  const input = value as Record<string, unknown>;
  if (!exactKeys(input, ["desktopVersion", "appServerVersion", "appServerSha256", "asarHeader", "modules"])) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  const desktopVersion = input.desktopVersion;
  if (typeof desktopVersion !== "string" || desktopVersion.length > 64 || !AUDIT_DESKTOP_VERSION.test(desktopVersion)) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  const appServerVersion = compatibilityVersion(input.appServerVersion);
  const appServerSha256 = auditHash(input.appServerSha256, false);
  const asarHeader = auditAsarHeader(input.asarHeader, false);
  const modules = auditModules(input.modules);
  if (!appServerVersion || !asarHeader) throw error("DESKTOP_PROTOCOL_ERROR");
  return { desktopVersion, appServerVersion, appServerSha256, asarHeader, modules };
}

export function validateDesktopCompatibilityAudit(value: unknown): DesktopCompatibilityAudit {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("DESKTOP_PROTOCOL_ERROR");
  const input = value as Record<string, unknown>;
  const required = [
    "observedDesktopVersion", "observedAppServerVersion", "status", "profile", "classification",
    "appServerSha256", "asarHeader", "candidateProfile", "modules",
  ] as const;
  if (!exactKeys(input, required, ["candidateRuntime"])) throw error("DESKTOP_PROTOCOL_ERROR");
  const compatibility = validateDesktopCompatibility({
    observedDesktopVersion: input.observedDesktopVersion,
    observedAppServerVersion: input.observedAppServerVersion,
    status: input.status,
    profile: input.profile,
  });
  const classification = input.classification;
  if (typeof classification !== "string" ||
      !COMPATIBILITY_AUDIT_CLASSIFICATIONS.has(classification as DesktopCompatibilityAuditClassification)) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  const candidateProfile = compatibilityProfile(input.candidateProfile);
  const appServerSha256 = auditHash(input.appServerSha256);
  const asarHeader = auditAsarHeader(input.asarHeader);
  const modules = auditModules(input.modules);
  const candidateRuntime = Object.prototype.hasOwnProperty.call(input, "candidateRuntime")
    ? auditCandidateRuntime(input.candidateRuntime) : undefined;
  if (classification === "same_protocol_candidate") {
    if (!candidateRuntime || !candidateProfile || compatibility.status !== "unverified" || compatibility.profile !== null ||
        !compatibility.observedDesktopVersion || !compatibility.observedAppServerVersion || !appServerSha256 || !asarHeader ||
        modules.length !== 2 || candidateRuntime.modules.length !== 2 ||
        new Set(modules.map(module => module.role)).size !== 2 ||
        candidateRuntime.desktopVersion !== compatibility.observedDesktopVersion ||
        candidateRuntime.appServerVersion !== compatibility.observedAppServerVersion ||
        candidateRuntime.appServerSha256 !== appServerSha256 ||
        JSON.stringify(candidateRuntime.asarHeader) !== JSON.stringify(asarHeader) ||
        JSON.stringify(candidateRuntime.modules) !== JSON.stringify(modules)) {
      throw error("DESKTOP_PROTOCOL_ERROR");
    }
  } else if (candidateRuntime) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  if (classification === "current" && (compatibility.status !== "current" || !compatibility.profile ||
      candidateProfile !== compatibility.profile || !appServerSha256 || !asarHeader || modules.length !== 2 ||
      new Set(modules.map(module => module.role)).size !== 2)) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  return {
    ...compatibility,
    classification: classification as DesktopCompatibilityAuditClassification,
    appServerSha256,
    asarHeader,
    candidateProfile,
    modules,
    ...(candidateRuntime ? { candidateRuntime } : {}),
  };
}

export function desktopCompatibilityFromError(value: unknown): DesktopCompatibility | undefined {
  if (!value || typeof value !== "object") return undefined;
  try {
    return validateDesktopCompatibility((value as { compatibility?: unknown }).compatibility);
  } catch {
    return undefined;
  }
}

function error(
  code: string,
  options: { notSent?: boolean; compatibility?: DesktopCompatibility } = {},
): DesktopError & { notSent: boolean; compatibility?: DesktopCompatibility } {
  const result = new DesktopError(code, messageFor(code)) as DesktopError & {
    notSent: boolean;
    compatibility?: DesktopCompatibility;
  };
  result.notSent = options.notSent ?? true;
  if (options.compatibility !== undefined) result.compatibility = options.compatibility;
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

function validateResultContext(value: unknown, target: DesktopTarget): DesktopResultContext {
  const info = validateInfo(value, target);
  const input = value as { resultTurnId?: unknown; resultTurnStatus?: unknown };
  if (!isUuid(input.resultTurnId) || typeof input.resultTurnStatus !== "string" ||
      !(["inProgress", "completed", "failed", "interrupted", "cancelled"] as const).includes(input.resultTurnStatus as DesktopResultTurnStatus)) {
    throw error("DESKTOP_STATE_UNAVAILABLE");
  }
  if (info.runtimeStatus === "idle" && input.resultTurnStatus === "inProgress") {
    throw error("DESKTOP_STATE_UNAVAILABLE");
  }
  if ((info.runtimeStatus === "active" || info.runtimeStatus === "inProgress") && input.resultTurnStatus !== "inProgress") {
    throw error("DESKTOP_STATE_UNAVAILABLE");
  }
  if (info.runtimeStatus !== "idle" && info.runtimeStatus !== "active" && info.runtimeStatus !== "inProgress") {
    throw error("DESKTOP_STATE_UNAVAILABLE");
  }
  return { ...info, resultTurnId: input.resultTurnId, resultTurnStatus: input.resultTurnStatus as DesktopResultTurnStatus };
}

export function validateDesktopHandshakeAudit(value: unknown): DesktopHandshakeAudit {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("DESKTOP_PROTOCOL_ERROR");
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort().join(",");
  if (keys !== "followingChangedSent,initialize,ownerDiscovery,processStable,protocolClassification,runtimeStable,stateChange,stateReceived") {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  if (input.processStable !== true || input.runtimeStable !== true || input.initialize !== true ||
      input.ownerDiscovery !== true || input.followingChangedSent !== true || input.stateReceived !== true ||
      (input.stateChange !== "snapshot" && input.stateChange !== "patches") ||
      !["current", "same_protocol_candidate", "protocol_drift_or_unknown"].includes(input.protocolClassification as string)) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  return input as unknown as DesktopHandshakeAudit;
}

function validateResultOwnershipExpectation(value: DesktopResultOwnershipExpectation): DesktopResultOwnershipExpectation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("DESKTOP_INVALID_REQUEST");
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== ["commandId", "intent", "messageBytes", "messageSha256", "originTurnId", "workspaceId"].join(",")) {
    throw error("DESKTOP_INVALID_REQUEST");
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value.workspaceId) || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.commandId) ||
      !["development_plan", "revision"].includes(value.intent) || !isUuid(value.originTurnId) ||
      !Number.isSafeInteger(value.messageBytes) || value.messageBytes < 1 || value.messageBytes > MAX_MESSAGE_BYTES ||
      !/^[a-f0-9]{64}$/u.test(value.messageSha256)) {
    throw error("DESKTOP_INVALID_REQUEST");
  }
  return { ...value };
}

function validateResultOwnership(value: unknown, target: DesktopTarget): DesktopResultOwnership {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("DESKTOP_PROTOCOL_ERROR");
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "threadId", "hostId", "projectId", "workspaceRoot", "title", "cwd", "workspaceKind", "resumeState",
    "runtimeStatus", "requestsCount", "desktopVersion", "appServerVersion", "profile", "ownerClientId",
    "resultTurnId", "resultTurnStatus", "ownership", "originTurnId", "chainTurnIds", "chainLength", "signature",
  ]);
  if (Object.keys(input).some(key => !allowed.has(key))) throw error("DESKTOP_PROTOCOL_ERROR");
  const context = validateResultContext(value, target);
  const ownership = input.ownership;
  const originTurnId = input.originTurnId;
  const chainTurnIds = input.chainTurnIds;
  const chainLength = input.chainLength;
  const signature = input.signature;
  if (ownership !== "origin" && ownership !== "native_continuation") throw error("DESKTOP_PROTOCOL_ERROR");
  if (!isUuid(originTurnId) || !Array.isArray(chainTurnIds) ||
      chainTurnIds.length < 1 || chainTurnIds.length > MAX_RESULT_CONTINUATION_CHAIN + 1 ||
      !chainTurnIds.every(isUuid) || new Set(chainTurnIds).size !== chainTurnIds.length ||
      typeof chainLength !== "number" || !Number.isSafeInteger(chainLength) ||
      chainLength < 0 || chainLength > MAX_RESULT_CONTINUATION_CHAIN ||
      chainLength !== chainTurnIds.length - 1 || chainTurnIds[0] !== originTurnId ||
      chainTurnIds[chainTurnIds.length - 1] !== context.resultTurnId) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  if (ownership === "origin") {
    if (chainLength !== 0 || signature !== null || context.resultTurnId !== originTurnId) {
      throw error("DESKTOP_PROTOCOL_ERROR");
    }
  } else if (chainLength < 1 || signature !== "capacity_retry_automatic" || context.resultTurnId === originTurnId) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  return {
    ...context,
    ownership,
    originTurnId,
    chainTurnIds: [...chainTurnIds],
    chainLength,
    signature,
  };
}

function validateUnknownReconcileExpectation(value: DesktopUnknownReconcileExpectation): DesktopUnknownReconcileExpectation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("DESKTOP_INVALID_REQUEST");
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== ["commandId", "intent", "messageBytes", "messageSha256", "workspaceId"].join(",")) {
    throw error("DESKTOP_INVALID_REQUEST");
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value.workspaceId) || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.commandId) ||
      !["development_plan", "revision"].includes(value.intent) ||
      !Number.isSafeInteger(value.messageBytes) || value.messageBytes < 1 || value.messageBytes > MAX_MESSAGE_BYTES ||
      !/^[a-f0-9]{64}$/u.test(value.messageSha256)) {
    throw error("DESKTOP_INVALID_REQUEST");
  }
  return { ...value };
}

function validateUnknownReconcileObservation(value: unknown, target: DesktopTarget): DesktopUnknownReconcileObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("DESKTOP_PROTOCOL_ERROR");
  const input = value as Partial<DesktopUnknownReconcileObservation>;
  const candidates = input.candidates;
  if (input.threadId !== target.threadId || input.hostId !== target.hostId || input.projectId !== target.projectId ||
      input.workspaceRoot !== target.workspaceRoot || !Array.isArray(candidates) || candidates.length > 10_000 ||
      !candidates.every(candidate => isUuid(candidate))) {
    throw error("DESKTOP_RECONCILIATION_CONFLICT");
  }
  return { ...target, hostId: "local", candidates: [...candidates] };
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
        const compatibility = desktopCompatibilityFromError(response);
        pending.reject(error(requestedCode, {
          notSent,
          ...(compatibility ? { compatibility } : {}),
        }));
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

  async compatibility(): Promise<DesktopCompatibility> {
    const session = this.open();
    try {
      const value = await session.request("compatibility", {});
      return validateDesktopCompatibility(value);
    } finally {
      session.close();
    }
  }

  async compatibilityAudit(): Promise<DesktopCompatibilityAudit> {
    const session = this.open();
    try {
      const value = await session.request("compatibility_audit", {});
      return validateDesktopCompatibilityAudit(value);
    } finally {
      session.close();
    }
  }

  async handshakeAudit(workspaceRoot: string): Promise<DesktopHandshakeAudit> {
    if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) throw error("DESKTOP_INVALID_REQUEST");
    const session = this.open();
    try {
      const value = await session.request("handshake_audit", { workspaceRoot });
      return validateDesktopHandshakeAudit(value);
    } finally { session.close(); }
  }

  async currentIdentity(workspaceRoot: string): Promise<DesktopTargetInfo> {
    return this.currentOperation("current_identity", workspaceRoot);
  }

  async currentExecution(workspaceRoot: string): Promise<DesktopExecutionInfo> {
    return this.currentOperation("current_execution", workspaceRoot, validateExecutionInfo) as Promise<DesktopExecutionInfo>;
  }

  /** Target-scoped active-turn observation for the Bridge server; no runner context required. */
  async inspectActiveExecution(rawTarget: DesktopTarget): Promise<DesktopExecutionInfo> {
    const target = validateTarget(rawTarget);
    const session = this.open();
    try {
      const value = await session.request("inspect_active_execution", { target });
      return validateExecutionInfo(value, target);
    } finally { session.close(); }
  }

  async currentResultContext(workspaceRoot: string): Promise<DesktopResultContext> {
    return this.currentOperation("current_result_context", workspaceRoot, validateResultContext) as Promise<DesktopResultContext>;
  }

  /** 当前 result turn 对 accepted origin 的严格归属证明；只读且要求当前 runner 身份。 */
  async currentResultOwnership(
    workspaceRoot: string,
    rawExpectation: DesktopResultOwnershipExpectation,
  ): Promise<DesktopResultOwnership> {
    const expectation = validateResultOwnershipExpectation(rawExpectation);
    const value = await this.currentOperation("current_result_ownership", workspaceRoot, validateResultOwnership, { expectation }) as unknown as DesktopResultOwnership;
    if (value.originTurnId !== expectation.originTurnId) throw error("DESKTOP_RECONCILIATION_CONFLICT");
    return value as DesktopResultOwnership;
  }

  async confirmCurrent(workspaceRoot: string): Promise<DesktopTargetInfo> {
    return this.currentOperation("current_confirm", workspaceRoot);
  }

  async reconcileUnknown(
    rawTarget: DesktopTarget,
    rawExpectation: DesktopUnknownReconcileExpectation,
  ): Promise<DesktopUnknownReconcileObservation> {
    const target = validateTarget(rawTarget);
    const expectation = validateUnknownReconcileExpectation(rawExpectation);
    const session = this.open();
    try {
      const value = await session.request("reconcile_unknown", { target, expectation });
      return validateUnknownReconcileObservation(value, target);
    } finally { session.close(); }
  }

  private async currentOperation(operation: string, workspaceRoot: string,
    validate: (value: unknown, target: DesktopTarget) => DesktopTargetInfo = validateInfo,
    extra: Record<string, unknown> = {}): Promise<DesktopTargetInfo> {
    const threadId = process.env.CODEX_THREAD_ID;
    if (!isUuid(threadId) || (process.env.CODEX_SESSION_ID && process.env.CODEX_SESSION_ID !== threadId) ||
      typeof workspaceRoot !== "string" || !workspaceRoot.trim()) throw error("DESKTOP_CURRENT_CONTEXT_INVALID");
    const session = this.open();
    try {
      // 不传 thread/project/host：helper 从继承的当前 Agent 上下文和 Desktop 映射精确解析。
      const value = await session.request<DesktopTargetInfo>(operation, { workspaceRoot, ...extra });
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
