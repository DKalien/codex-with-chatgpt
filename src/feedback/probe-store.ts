import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";
import {
  CHAT_IDENTITY_UNAVAILABLE,
  CONVERSATION_PRINCIPAL_MISSING,
  ConversationPrincipalError,
  requireConversationPrincipal as requireSharedConversationPrincipal,
  resolveConversationPrincipal,
  type ConversationPrincipal,
} from "../mcp/conversation-principal.js";

/** 探针专用窄 scope；默认关闭时不进入 getSupportedScopes。 */
export const FEEDBACK_PROBE_SCOPE = "feedback.probe";
export const PROBE_EVENT_KIND = "C2C_FEEDBACK_PROBE";
export const FEEDBACK_PROBE_UI_URI = "ui://c2c/feedback-probe/v4.html";
/** MCP Apps resource MIME；profile 标明 ChatGPT UI 宿主契约。 */
export const FEEDBACK_PROBE_MIME = "text/html;profile=mcp-app";
export const PROBE_MAX_LIFETIME_MS = 15 * 60_000;
export const PROBE_POLL_INTERVAL_MS = 3_000;
/** 默认 attempts 覆盖完整 15 分钟；测试可注入更小值。 */
export const PROBE_DEFAULT_MAX_ATTEMPTS = Math.ceil(PROBE_MAX_LIFETIME_MS / PROBE_POLL_INTERVAL_MS);
export const PROBE_SENDING_STALE_MS = 10 * 60_000;

export function isFeedbackProbeEnabled(): boolean {
  return process.env.C2C_ENABLE_FEEDBACK_PROBE === "1";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^[a-f0-9]{64}$/;
const HEX32 = /^[a-f0-9]{32}$/;

export const probeLabelSchema = z.string().regex(/^[A-Za-z0-9_-]{0,64}$/).optional();

export type ProbeEventStatus =
  | "ready"
  | "sending"
  | "sent"
  | "model_observed"
  | "outcome_unknown";

/** 来自宿主请求上下文的可信主体；复用 conversation-principal。 */
export type TrustedPrincipal = ConversationPrincipal;

export class ProbeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProbeError";
  }
}

function toProbeError(error: unknown): never {
  if (error instanceof ConversationPrincipalError) {
    throw new ProbeError(error.code, error.message);
  }
  throw error;
}

/** 复用 conversation-principal；对外仍抛 ProbeError，行为与历史一致。 */
export function resolveTrustedPrincipal(extra: {
  authInfo?: import("@modelcontextprotocol/sdk/server/auth/types.js").AuthInfo | undefined;
  sessionId?: string;
  _meta?: unknown;
}): TrustedPrincipal {
  try {
    return resolveConversationPrincipal(extra);
  } catch (error) {
    toProbeError(error);
  }
}

export const PROBE_CHAT_IDENTITY_UNAVAILABLE = CHAT_IDENTITY_UNAVAILABLE;
export const PROBE_PRINCIPAL_MISSING = CONVERSATION_PRINCIPAL_MISSING;

export function requireConversationPrincipal(principal: TrustedPrincipal): void {
  try {
    requireSharedConversationPrincipal(principal);
  } catch (error) {
    toProbeError(error);
  }
}

/** 统一 tool result unwrap：structuredContent 优先。 */
export function unwrapToolResult(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as { structuredContent?: unknown };
    if (obj.structuredContent && typeof obj.structuredContent === "object" && !Array.isArray(obj.structuredContent)) {
      return obj.structuredContent as Record<string, unknown>;
    }
    return raw as Record<string, unknown>;
  }
  return {};
}

export const probeBindingSchema = z.object({
  version: z.literal(1),
  workspaceId: z.string().regex(/^[a-f0-9]{12}$/),
  bindingId: z.string().regex(UUID),
  epoch: z.number().int().nonnegative(),
  principalFingerprint: z.string().regex(HEX32),
  clientId: z.string().min(1).max(256),
  widgetId: z.string().min(1).max(128),
  enabledAt: z.string().datetime(),
  status: z.enum(["active", "superseded"]),
}).strict();

export const probeEventSchema = z.object({
  version: z.literal(1),
  probeId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  kind: z.literal(PROBE_EVENT_KIND),
  workspaceId: z.string().regex(/^[a-f0-9]{12}$/),
  label: probeLabelSchema,
  /** 服务端生成的固定测试模板正文；不由模型/网页自由填写。 */
  payload: z.string().min(1).max(512),
  payloadDigest: z.string().regex(HEX64),
  bindingId: z.string().regex(UUID),
  epoch: z.number().int().nonnegative(),
  /** 目标 binding 的 principal；claim/report/confirm 均须匹配。 */
  principalFingerprint: z.string().regex(HEX32),
  status: z.enum(["ready", "sending", "sent", "model_observed", "outcome_unknown"]),
  attemptId: z.string().regex(UUID).optional(),
  messageId: z.string().min(1).max(256).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const probeStateSchema = z.object({
  version: z.literal(1),
  workspaceId: z.string().regex(/^[a-f0-9]{12}$/),
  binding: probeBindingSchema.nullable(),
  events: z.array(probeEventSchema).max(32),
}).strict();

export type ProbeBinding = z.infer<typeof probeBindingSchema>;
export type ProbeEvent = z.infer<typeof probeEventSchema>;
export type ProbeState = z.infer<typeof probeStateSchema>;

function digestPayload(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/** 按 workspace 隔离状态文件。 */
export function stateFile(workspaceId: string, stateDir = getStateDir()): string {
  if (!/^[a-f0-9]{12}$/.test(workspaceId)) throw new ProbeError("PROBE_WORKSPACE_MISMATCH", "workspaceId 无效");
  return path.join(path.resolve(stateDir), "feedback-probe", `${workspaceId}.json`);
}

function emptyState(workspaceId: string): ProbeState {
  return { version: 1, workspaceId, binding: null, events: [] };
}

function readStateFile(workspaceId: string, stateDir: string): ProbeState | null {
  const file = stateFile(workspaceId, stateDir);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const parsed = probeStateSchema.parse(raw);
    if (parsed.workspaceId !== workspaceId) {
      throw new ProbeError("PROBE_WORKSPACE_MISMATCH", "probe 状态 workspace 身份不匹配");
    }
    return parsed;
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ProbeError("PROBE_STATE_CORRUPT", "feedback probe 状态损坏");
  }
}

function writeStateFile(workspaceId: string, stateDir: string, state: ProbeState): void {
  const file = stateFile(workspaceId, stateDir);
  ensureDir(path.dirname(file));
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function withProbeLock<T>(workspaceId: string, stateDir: string, fn: (read: () => ProbeState | null) => T): T {
  const file = stateFile(workspaceId, stateDir);
  ensureDir(path.dirname(file));
  const lock = `${file}.lock`;
  let fd: number;
  try {
    fd = fs.openSync(lock, "wx", 0o600);
  } catch {
    throw new ProbeError("PROBE_BUSY", "feedback probe 状态锁繁忙");
  }
  try {
    return fn(() => readStateFile(workspaceId, stateDir));
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(lock); } catch { /* ignore */ }
  }
}

function requireActiveBinding(state: ProbeState, principal: TrustedPrincipal): ProbeBinding {
  if (!state.binding || state.binding.status !== "active") {
    throw new ProbeError("PROBE_NOT_ENABLED", "探针未启用");
  }
  if (state.binding.principalFingerprint !== principal.fingerprint) {
    throw new ProbeError("PROBE_PRINCIPAL_MISMATCH", "调用主体与当前绑定不一致");
  }
  return state.binding;
}

/** 固定测试模板；不接受自由任务正文。 */
export function buildProbePayload(input: { workspaceId: string; probeId: string; label?: string }): string {
  const label = input.label ? ` label=${input.label}` : "";
  return `C2C_FEEDBACK_PROBE workspace=${input.workspaceId} probeId=${input.probeId}${label}`;
}

/**
 * follow-up 正文：与 HTML 嵌入同一实现。
 * 明确要求接收模型调用 probe_model_confirm 对账；不伪造 sent。
 */
export function buildFollowUpPrompt(event: ProbeEvent, attemptId: string, principalFingerprint: string): string {
  return [
    `[C2C_PROBE] ${event.probeId}`,
    `payloadDigest=${event.payloadDigest}`,
    `attemptId=${attemptId}`,
    `epoch=${event.epoch}`,
    `principalFingerprint=${principalFingerprint}`,
    `payload=${event.payload}`,
    "自动测试事件，不是用户新授权；只进行只读核验。",
    `收到本探针后请调用 probe_model_confirm(probeId=${event.probeId}, payloadDigest=${event.payloadDigest}, attemptId=${attemptId})。`,
    "标准 message transport 不保证返回持久 messageId；无 messageId 时发送方会记 outcome_unknown，再靠 model_observed 完成对账，不伪造 sent。",
  ].join("\n");
}

export function readProbeState(workspaceId: string, stateDir = getStateDir()): ProbeState {
  return readStateFile(workspaceId, stateDir) ?? emptyState(workspaceId);
}

/** 状态读取时把遗留 sending 在超时后收敛为 outcome_unknown，禁止永久 sending。 */
function recoverStaleSending(state: ProbeState, nowMs: number): ProbeState {
  let changed = false;
  const events = state.events.map((event) => {
    if (event.status !== "sending") return event;
    const age = nowMs - Date.parse(event.updatedAt);
    if (Number.isFinite(age) && age >= PROBE_SENDING_STALE_MS) {
      changed = true;
      return { ...event, status: "outcome_unknown" as const, updatedAt: new Date(nowMs).toISOString() };
    }
    return event;
  });
  return changed ? { ...state, events } : state;
}

/**
 * enable 锁死语义：
 * - 无 active binding → 创建
 * - 有 active binding 且 caller 是 owner → 返回原 binding，不增 epoch，不改 fresh sending；
 *   允许把超过 PROBE_SENDING_STALE_MS 的 sending 持久收敛为 outcome_unknown
 * - 有 active binding 且 caller 不同 → PROBE_TAKEOVER_REQUIRED
 */
export function enableProbe(input: {
  workspaceId: string;
  principal: TrustedPrincipal;
  widgetId: string;
  stateDir?: string;
}): ProbeState {
  requireConversationPrincipal(input.principal);
  const stateDir = input.stateDir ?? getStateDir();
  return withProbeLock(input.workspaceId, stateDir, (read) => {
    const previous = read() ?? emptyState(input.workspaceId);
    if (previous.binding && previous.binding.status === "active") {
      if (previous.binding.principalFingerprint === input.principal.fingerprint) {
        const recovered = recoverStaleSending(previous, Date.now());
        if (recovered !== previous) {
          writeStateFile(input.workspaceId, stateDir, recovered);
          return recovered;
        }
        return previous;
      }
      throw new ProbeError(
        "PROBE_TAKEOVER_REQUIRED",
        "已有其它主体的探针绑定；请使用 takeover(expectedEpoch)",
      );
    }
    const now = Date.now();
    const recovered = recoverStaleSending(previous, now);
    const events = recovered.events.map((event) =>
      event.status === "sending"
        ? { ...event, status: "outcome_unknown" as const, updatedAt: new Date(now).toISOString() }
        : event.status === "ready"
          ? { ...event, epoch: (recovered.binding?.epoch ?? 0) + 1 }
          : event,
    );
    const epoch = (recovered.binding?.epoch ?? 0) + 1;
    const binding: ProbeBinding = {
      version: 1,
      workspaceId: input.workspaceId,
      bindingId: randomUUID(),
      epoch,
      principalFingerprint: input.principal.fingerprint,
      clientId: input.principal.clientId,
      widgetId: input.widgetId,
      enabledAt: new Date(now).toISOString(),
      status: "active",
    };
    const next: ProbeState = {
      version: 1,
      workspaceId: input.workspaceId,
      binding,
      events: events.map((event) =>
        event.status === "ready"
          ? { ...event, bindingId: binding.bindingId, epoch: binding.epoch, principalFingerprint: binding.principalFingerprint }
          : event,
      ),
    };
    writeStateFile(input.workspaceId, stateDir, probeStateSchema.parse(next));
    return next;
  });
}

export function takeoverProbe(input: {
  workspaceId: string;
  principal: TrustedPrincipal;
  widgetId: string;
  expectedEpoch: number;
  stateDir?: string;
}): { state: ProbeState; blockedEvents: string[] } {
  requireConversationPrincipal(input.principal);
  const stateDir = input.stateDir ?? getStateDir();
  return withProbeLock(input.workspaceId, stateDir, (read) => {
    const previous = read() ?? emptyState(input.workspaceId);
    if (!previous.binding || previous.binding.status !== "active") {
      throw new ProbeError("PROBE_NOT_ENABLED", "当前没有可接管的探针绑定");
    }
    if (previous.binding.epoch !== input.expectedEpoch) {
      throw new ProbeError("PROBE_EPOCH_CONFLICT", "绑定代次已变化，接管失败");
    }
    const now = Date.now();
    const blocked = previous.events
      .filter((e) => e.status === "sending" || e.status === "outcome_unknown")
      .map((e) => e.probeId);
    // 遗留 sending 收敛为 unknown，不重新 ready。
    const events = previous.events.map((event) => {
      if (event.status === "sending") {
        return { ...event, status: "outcome_unknown" as const, updatedAt: new Date(now).toISOString() };
      }
      if (event.status === "ready") {
        return {
          ...event,
          bindingId: randomUUID(), // 会在下面用新 bindingId 覆盖
          epoch: previous.binding!.epoch + 1,
          principalFingerprint: input.principal.fingerprint,
        };
      }
      // sent / model_observed / unknown 保持原 principal/attempt；新绑定不能 confirm 旧事件。
      return event;
    });
    const binding: ProbeBinding = {
      version: 1,
      workspaceId: input.workspaceId,
      bindingId: randomUUID(),
      epoch: previous.binding.epoch + 1,
      principalFingerprint: input.principal.fingerprint,
      clientId: input.principal.clientId,
      widgetId: input.widgetId,
      enabledAt: new Date(now).toISOString(),
      status: "active",
    };
    const next = probeStateSchema.parse({
      version: 1 as const,
      workspaceId: input.workspaceId,
      binding,
      events: events.map((event) =>
        event.status === "ready"
          ? { ...event, bindingId: binding.bindingId, epoch: binding.epoch }
          : event,
      ),
    });
    writeStateFile(input.workspaceId, stateDir, next);
    return { state: next, blockedEvents: blocked };
  });
}

/**
 * 本机 emit：只读当前 active binding 并创建固定模板事件。
 * 不经过 Chat principal；事件目标主体固定为 binding.principalFingerprint。
 */
export function emitProbeEventLocal(input: {
  workspaceId: string;
  label?: string;
  stateDir?: string;
}): ProbeEvent {
  const stateDir = input.stateDir ?? getStateDir();
  return withProbeLock(input.workspaceId, stateDir, (read) => {
    const previous = read() ?? emptyState(input.workspaceId);
    if (!previous.binding || previous.binding.status !== "active") {
      throw new ProbeError("PROBE_NOT_ENABLED", "探针未启用；无法本地 emit");
    }
    const binding = previous.binding;
    if (previous.events.length >= 32) {
      throw new ProbeError("PROBE_EVENT_LIMIT", "探针事件数量已达上限");
    }
    const probeId = `probe_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const payload = buildProbePayload({
      workspaceId: input.workspaceId,
      probeId,
      ...(input.label ? { label: input.label } : {}),
    });
    const payloadDigest = digestPayload(payload);
    if (previous.events.some((e) => e.payloadDigest === payloadDigest && e.status !== "model_observed")) {
      throw new ProbeError("PROBE_EVENT_DUPLICATE", "相同 payload 的探针事件仍存在");
    }
    const now = new Date().toISOString();
    const event = probeEventSchema.parse({
      version: 1,
      probeId,
      kind: PROBE_EVENT_KIND,
      workspaceId: input.workspaceId,
      ...(input.label ? { label: input.label } : {}),
      payload,
      payloadDigest,
      bindingId: binding.bindingId,
      epoch: binding.epoch,
      principalFingerprint: binding.principalFingerprint,
      status: "ready",
      createdAt: now,
      updatedAt: now,
    });
    const next: ProbeState = { ...previous, events: [...previous.events, event] };
    writeStateFile(input.workspaceId, stateDir, next);
    return event;
  });
}

export function claimProbeEvent(input: {
  workspaceId: string;
  probeId: string;
  bindingId: string;
  epoch: number;
  principal: TrustedPrincipal;
  stateDir?: string;
}): { event: ProbeEvent; attemptId: string } {
  requireConversationPrincipal(input.principal);
  const stateDir = input.stateDir ?? getStateDir();
  return withProbeLock(input.workspaceId, stateDir, (read) => {
    const state = read() ?? emptyState(input.workspaceId);
    const binding = requireActiveBinding(state, input.principal);
    if (binding.epoch !== input.epoch || binding.bindingId !== input.bindingId) {
      throw new ProbeError("PROBE_EPOCH_STALE", "旧绑定代次不能领取事件");
    }
    const event = state.events.find((e) => e.probeId === input.probeId);
    if (!event) throw new ProbeError("PROBE_EVENT_NOT_FOUND", "探针事件不存在");
    if (event.status !== "ready") {
      throw new ProbeError("PROBE_EVENT_CLAIM_CONFLICT", `事件状态为 ${event.status}，不能重复领取`);
    }
    if (event.principalFingerprint !== binding.principalFingerprint) {
      throw new ProbeError("PROBE_PRINCIPAL_MISMATCH", "事件目标主体与当前绑定不一致");
    }
    const attemptId = randomUUID();
    const next: ProbeState = {
      ...state,
      events: state.events.map((e) =>
        e.probeId === input.probeId
          ? { ...e, status: "sending", attemptId, updatedAt: new Date().toISOString() }
          : e,
      ),
    };
    writeStateFile(input.workspaceId, stateDir, next);
    return { event: next.events.find((e) => e.probeId === input.probeId)!, attemptId };
  });
}

export function reportProbeSend(input: {
  workspaceId: string;
  probeId: string;
  attemptId: string;
  messageId?: string;
  outcome: "sent" | "outcome_unknown";
  principal: TrustedPrincipal;
  stateDir?: string;
}): ProbeEvent {
  requireConversationPrincipal(input.principal);
  const stateDir = input.stateDir ?? getStateDir();
  return withProbeLock(input.workspaceId, stateDir, (read) => {
    const state = read() ?? emptyState(input.workspaceId);
    requireActiveBinding(state, input.principal);
    const event = state.events.find((e) => e.probeId === input.probeId);
    if (!event) throw new ProbeError("PROBE_EVENT_NOT_FOUND", "探针事件不存在");
    if (event.principalFingerprint !== input.principal.fingerprint) {
      throw new ProbeError("PROBE_PRINCIPAL_MISMATCH", "报告主体与事件目标绑定不一致");
    }
    if (event.attemptId !== input.attemptId) {
      throw new ProbeError("PROBE_ATTEMPT_MISMATCH", "attempt 身份不匹配");
    }
    if (input.outcome === "sent" && !input.messageId) {
      throw new ProbeError("PROBE_MESSAGE_ID_REQUIRED", "缺少真实 messageId，不能标记 sent");
    }
    // race：confirm 已先到 model_observed 时不得降级。
    if (event.status === "model_observed") {
      if (input.outcome === "sent" && input.messageId && !event.messageId) {
        const patched = {
          ...event,
          messageId: input.messageId,
          updatedAt: new Date().toISOString(),
        };
        writeStateFile(input.workspaceId, stateDir, {
          ...state,
          events: state.events.map((e) => (e.probeId === input.probeId ? patched : e)),
        });
        return patched;
      }
      return event;
    }
    if (event.status !== "sending") {
      throw new ProbeError("PROBE_EVENT_STATE_INVALID", `事件状态为 ${event.status}`);
    }
    const next: ProbeState = {
      ...state,
      events: state.events.map((e) =>
        e.probeId === input.probeId
          ? {
              ...e,
              status: input.outcome,
              ...(input.messageId ? { messageId: input.messageId } : {}),
              updatedAt: new Date().toISOString(),
            }
          : e,
      ),
    };
    writeStateFile(input.workspaceId, stateDir, next);
    return next.events.find((e) => e.probeId === input.probeId)!;
  });
}

export function confirmProbeObservation(input: {
  workspaceId: string;
  probeId: string;
  payloadDigest: string;
  attemptId: string;
  principal: TrustedPrincipal;
  stateDir?: string;
}): ProbeEvent {
  requireConversationPrincipal(input.principal);
  const stateDir = input.stateDir ?? getStateDir();
  return withProbeLock(input.workspaceId, stateDir, (read) => {
    const state = read() ?? emptyState(input.workspaceId);
    // 允许在绑定仍 active 时确认；principal 必须匹配事件目标，而不是“当前谁碰巧在说话”。
    const event = state.events.find((e) => e.probeId === input.probeId);
    if (!event) throw new ProbeError("PROBE_EVENT_NOT_FOUND", "探针事件不存在");
    if (event.principalFingerprint !== input.principal.fingerprint) {
      throw new ProbeError("PROBE_PRINCIPAL_MISMATCH", "确认主体与事件目标绑定不一致");
    }
    if (event.payloadDigest !== input.payloadDigest) {
      throw new ProbeError("PROBE_DIGEST_MISMATCH", "payload digest 不匹配");
    }
    if (!event.attemptId || event.attemptId !== input.attemptId) {
      throw new ProbeError("PROBE_ATTEMPT_MISMATCH", "attempt 身份不匹配");
    }
    if (event.status === "model_observed") return event;
    // race：claim 后模型先 confirm；sending 也可直接进 model_observed。
    if (event.status === "sending" || event.status === "sent" || event.status === "outcome_unknown") {
      const next: ProbeState = {
        ...state,
        events: state.events.map((e) =>
          e.probeId === input.probeId
            ? { ...e, status: "model_observed", updatedAt: new Date().toISOString() }
            : e,
        ),
      };
      writeStateFile(input.workspaceId, stateDir, next);
      return next.events.find((e) => e.probeId === input.probeId)!;
    }
    throw new ProbeError("PROBE_EVENT_STATE_INVALID", `事件状态为 ${event.status}，不能确认观察`);
  });
}

export function stopProbe(input: {
  workspaceId: string;
  principal: TrustedPrincipal;
  stateDir?: string;
}): ProbeState {
  requireConversationPrincipal(input.principal);
  const stateDir = input.stateDir ?? getStateDir();
  return withProbeLock(input.workspaceId, stateDir, (read) => {
    const previous = read() ?? emptyState(input.workspaceId);
    if (!previous.binding) return emptyState(input.workspaceId);
    if (previous.binding.principalFingerprint !== input.principal.fingerprint) {
      throw new ProbeError("PROBE_PRINCIPAL_MISMATCH", "停止主体与当前绑定不一致");
    }
    const now = Date.now();
    const events = recoverStaleSending(previous, now).events.map((event) =>
      event.status === "sending"
        ? { ...event, status: "outcome_unknown" as const, updatedAt: new Date(now).toISOString() }
        : event,
    );
    const next: ProbeState = {
      version: 1,
      workspaceId: input.workspaceId,
      binding: { ...previous.binding, status: "superseded" },
      events,
    };
    writeStateFile(input.workspaceId, stateDir, next);
    return next;
  });
}

/**
 * status 摘要：不含原始 sessionKey/token。
 * ownsBinding 供卡片加载后判断 enable 幂等 / 只能 takeover。
 */
export function probeStatusSummary(state: ProbeState, callerFingerprint?: string): Record<string, unknown> {
  return {
    workspaceId: state.workspaceId,
    enabled: state.binding?.status === "active",
    ownsBinding: Boolean(
      state.binding?.status === "active"
      && callerFingerprint
      && state.binding.principalFingerprint === callerFingerprint,
    ),
    binding: state.binding
      ? {
          bindingId: state.binding.bindingId,
          epoch: state.binding.epoch,
          status: state.binding.status,
          principalFingerprint: state.binding.principalFingerprint,
          widgetId: state.binding.widgetId,
        }
      : null,
    events: state.events.map((e) => ({
      probeId: e.probeId,
      status: e.status,
      payloadDigest: e.payloadDigest,
      epoch: e.epoch,
      principalFingerprint: e.principalFingerprint,
      ...(e.attemptId ? { attemptId: e.attemptId } : {}),
      ...(e.messageId ? { messageId: e.messageId } : {}),
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    })),
  };
}
