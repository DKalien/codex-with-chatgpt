import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";
import {
  requireConversationPrincipal,
  type ConversationPrincipal,
} from "../mcp/conversation-principal.js";

/** production feedback 永久 scope；与 synthetic feedback.probe 分离。 */
export const CODEX_FEEDBACK_SCOPE = "codex.feedback";
export const FEEDBACK_EVENT_KIND = "C2C_EXECUTED";
export const FEEDBACK_CLAIM_STALE_MS = 10 * 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX32 = /^[a-f0-9]{32}$/;
const WORKSPACE_ID = /^[a-f0-9]{12}$/;
const DESKTOP_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class FeedbackError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FeedbackError";
  }
}

export const feedbackBindingSchema = z.object({
  version: z.literal(1),
  bindingId: z.string().regex(UUID),
  epoch: z.number().int().nonnegative(),
  principalFingerprint: z.string().regex(HEX32),
  clientId: z.string().min(1).max(256),
  widgetId: z.string().min(1).max(128),
  enabledAt: z.string().datetime(),
  status: z.enum(["active", "superseded"]),
}).strict();

export const feedbackEventSchema = z.object({
  version: z.literal(1),
  eventId: z.string().regex(HEX32),
  kind: z.literal(FEEDBACK_EVENT_KIND),
  workspaceId: z.string().regex(WORKSPACE_ID),
  source: z.literal("desktop"),
  commandId: z.string().regex(DESKTOP_ID),
  taskId: z.string().min(1).max(256),
  iteration: z.number().int().positive(),
  result: z.enum(["ok", "failed", "blocked"]),
  changedFilesSummary: z.array(z.string().min(1).max(512)).max(200),
  testsSummary: z.string().max(2000),
  outputAvailable: z.boolean(),
  outputId: z.number().int().positive().optional(),
  occurredAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  targetBindingId: z.string().regex(UUID).nullable(),
  targetEpoch: z.number().int().nonnegative().nullable(),
  targetPrincipalFingerprint: z.string().regex(HEX32).nullable(),
  status: z.enum(["queued", "ready", "claimed", "observed", "outcome_unknown"]),
  attemptId: z.string().regex(UUID).optional(),
  claimedAt: z.string().datetime().optional(),
}).strict();

export const feedbackStateSchema = z.object({
  version: z.literal(1),
  workspaceId: z.string().regex(WORKSPACE_ID),
  projectionCursor: z.number().int().nonnegative(),
  binding: feedbackBindingSchema.nullable(),
  events: z.array(feedbackEventSchema).max(10000),
}).strict();

export type FeedbackBinding = z.infer<typeof feedbackBindingSchema>;
export type FeedbackEvent = z.infer<typeof feedbackEventSchema>;
export type FeedbackState = z.infer<typeof feedbackStateSchema>;

export function feedbackStateFile(workspaceId: string, stateDir = getStateDir()): string {
  if (!WORKSPACE_ID.test(workspaceId)) {
    throw new FeedbackError("FEEDBACK_WORKSPACE_MISMATCH", "workspaceId 无效");
  }
  return path.join(path.resolve(stateDir), "feedback", `${workspaceId}.json`);
}

function emptyState(workspaceId: string, projectionCursor = 0): FeedbackState {
  return { version: 1, workspaceId, projectionCursor, binding: null, events: [] };
}

function readState(workspaceId: string, stateDir: string): FeedbackState | null {
  const file = feedbackStateFile(workspaceId, stateDir);
  try {
    const parsed = feedbackStateSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (parsed.workspaceId !== workspaceId) {
      throw new FeedbackError("FEEDBACK_WORKSPACE_MISMATCH", "feedback 状态 workspace 身份不匹配");
    }
    return parsed;
  } catch (error) {
    if (error instanceof FeedbackError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new FeedbackError("FEEDBACK_STATE_CORRUPT", "production feedback 状态损坏；保留文件人工核对");
  }
}

function writeState(workspaceId: string, stateDir: string, state: FeedbackState): void {
  const file = feedbackStateFile(workspaceId, stateDir);
  ensureDir(path.dirname(file));
  const tmp = `${file}.${randomUUID()}.tmp`;
  let fd = -1;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    const payload = JSON.stringify(feedbackStateSchema.parse(state), null, 2);
    fs.writeFileSync(fd, payload, { encoding: "utf8" });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = -1;
    fs.renameSync(tmp, file);
  } finally {
    if (fd >= 0) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* rename 后残留清理 */ }
  }
}

function withFeedbackLock<T>(workspaceId: string, stateDir: string, fn: (read: () => FeedbackState | null) => T): T {
  const file = feedbackStateFile(workspaceId, stateDir);
  ensureDir(path.dirname(file));
  const lock = `${file}.lock`;
  let fd: number;
  try {
    fd = fs.openSync(lock, "wx", 0o600);
  } catch {
    throw new FeedbackError("FEEDBACK_BUSY", "feedback 状态锁繁忙；不清理遗留锁");
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    fs.fsyncSync(fd);
    return fn(() => readState(workspaceId, stateDir));
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(lock); } catch { /* ignore */ }
  }
}

/** binding API 不得隐式 baseline；必须已由 ensureFeedbackState 初始化。 */
function requireInitializedState(
  previous: FeedbackState | null,
  workspaceId: string,
): FeedbackState {
  if (!previous) {
    throw new FeedbackError(
      "FEEDBACK_STATE_UNINITIALIZED",
      "production feedback state 尚未初始化；先 reconcile 建立 baseline cursor",
    );
  }
  return previous;
}

export function readFeedbackState(workspaceId: string, stateDir = getStateDir()): FeedbackState {
  const existing = readState(workspaceId, stateDir);
  if (!existing) {
    throw new FeedbackError(
      "FEEDBACK_STATE_UNINITIALIZED",
      "production feedback state 尚未初始化",
    );
  }
  return existing;
}

/** 首次建立 state：cursor = 当前 execution record 数量（历史 baseline，不投影）。 */
export function ensureFeedbackState(
  workspaceId: string,
  baselineCursor: number,
  stateDir = getStateDir(),
): FeedbackState {
  return withFeedbackLock(workspaceId, stateDir, (read) => {
    const previous = read();
    if (previous) return previous;
    if (!Number.isInteger(baselineCursor) || baselineCursor < 0) {
      throw new FeedbackError("FEEDBACK_CURSOR_INVALID", "baseline cursor 无效");
    }
    const next = emptyState(workspaceId, baselineCursor);
    writeState(workspaceId, stateDir, next);
    return next;
  });
}

function recoverStaleClaimed(state: FeedbackState, nowMs: number): FeedbackState {
  let changed = false;
  const events = state.events.map((event) => {
    if (event.status !== "claimed" || !event.claimedAt) return event;
    const age = nowMs - Date.parse(event.claimedAt);
    if (Number.isFinite(age) && age >= FEEDBACK_CLAIM_STALE_MS) {
      changed = true;
      return { ...event, status: "outcome_unknown" as const, updatedAt: new Date(nowMs).toISOString() };
    }
    return event;
  });
  return changed ? { ...state, events } : state;
}

/** 锁内 stale convergence；reconcile 每次调用，resident 重开仅 status 即可恢复。 */
export function recoverStaleFeedback(
  workspaceId: string,
  stateDir = getStateDir(),
  nowMs: number = Date.now(),
): FeedbackState {
  return withFeedbackLock(workspaceId, stateDir, (read) => {
    const previous = requireInitializedState(read(), workspaceId);
    const recovered = recoverStaleClaimed(previous, nowMs);
    if (recovered !== previous) {
      writeState(workspaceId, stateDir, recovered);
    }
    return recovered;
  });
}

function requireActiveBinding(state: FeedbackState, principal: ConversationPrincipal): FeedbackBinding {
  if (!state.binding || state.binding.status !== "active") {
    throw new FeedbackError("FEEDBACK_NOT_ENABLED", "production feedback 未启用");
  }
  if (state.binding.principalFingerprint !== principal.fingerprint) {
    throw new FeedbackError("FEEDBACK_PRINCIPAL_MISMATCH", "调用主体与当前 receiver 绑定不一致");
  }
  return state.binding;
}

export function enableReceiver(input: {
  workspaceId: string;
  principal: ConversationPrincipal;
  widgetId: string;
  stateDir?: string;
}): FeedbackState {
  requireConversationPrincipal(input.principal);
  const stateDir = input.stateDir ?? getStateDir();
  return withFeedbackLock(input.workspaceId, stateDir, (read) => {
    const previous = requireInitializedState(read(), input.workspaceId);
    if (previous.binding && previous.binding.status === "active") {
      if (previous.binding.principalFingerprint === input.principal.fingerprint) {
        return previous;
      }
      throw new FeedbackError(
        "FEEDBACK_TAKEOVER_REQUIRED",
        "已有其它 receiver 绑定；请使用 takeover(expectedEpoch)",
      );
    }
    const now = Date.now();
    const recovered = recoverStaleClaimed(previous, now);
    const epoch = (recovered.binding?.epoch ?? 0) + 1;
    const binding: FeedbackBinding = {
      version: 1,
      bindingId: randomUUID(),
      epoch,
      principalFingerprint: input.principal.fingerprint,
      clientId: input.principal.clientId,
      widgetId: input.widgetId,
      enabledAt: new Date(now).toISOString(),
      status: "active",
    };
    const next: FeedbackState = {
      ...recovered,
      binding,
      events: recovered.events.map((event) =>
        event.status === "queued" || event.status === "ready"
          ? {
              ...event,
              status: "ready" as const,
              targetBindingId: binding.bindingId,
              targetEpoch: binding.epoch,
              targetPrincipalFingerprint: binding.principalFingerprint,
              updatedAt: new Date(now).toISOString(),
            }
          : event,
      ),
    };
    writeState(input.workspaceId, stateDir, next);
    return next;
  });
}

export function takeoverReceiver(input: {
  workspaceId: string;
  principal: ConversationPrincipal;
  widgetId: string;
  expectedEpoch: number;
  stateDir?: string;
}): { state: FeedbackState } {
  requireConversationPrincipal(input.principal);
  const stateDir = input.stateDir ?? getStateDir();
  return withFeedbackLock(input.workspaceId, stateDir, (read) => {
    const previous = requireInitializedState(read(), input.workspaceId);
    if (!previous.binding || previous.binding.status !== "active") {
      throw new FeedbackError("FEEDBACK_NOT_ENABLED", "当前没有可接管的 receiver 绑定");
    }
    if (previous.binding.epoch !== input.expectedEpoch) {
      throw new FeedbackError("FEEDBACK_EPOCH_CONFLICT", "绑定代次已变化，接管失败");
    }
    if (previous.events.some((e) => e.status === "claimed" || e.status === "outcome_unknown")) {
      throw new FeedbackError(
        "FEEDBACK_TAKEOVER_BLOCKED",
        "存在 claimed/outcome_unknown 事件；禁止接管以免重发",
      );
    }
    const now = Date.now();
    const recovered = recoverStaleClaimed(previous, now);
    if (recovered.events.some((e) => e.status === "claimed" || e.status === "outcome_unknown")) {
      throw new FeedbackError(
        "FEEDBACK_TAKEOVER_BLOCKED",
        "存在 claimed/outcome_unknown 事件；禁止接管以免重发",
      );
    }
    const binding: FeedbackBinding = {
      version: 1,
      bindingId: randomUUID(),
      epoch: previous.binding.epoch + 1,
      principalFingerprint: input.principal.fingerprint,
      clientId: input.principal.clientId,
      widgetId: input.widgetId,
      enabledAt: new Date(now).toISOString(),
      status: "active",
    };
    const next: FeedbackState = {
      ...recovered,
      binding,
      events: recovered.events.map((event) =>
        event.status === "queued" || event.status === "ready"
          ? {
              ...event,
              status: "ready" as const,
              targetBindingId: binding.bindingId,
              targetEpoch: binding.epoch,
              targetPrincipalFingerprint: binding.principalFingerprint,
              updatedAt: new Date(now).toISOString(),
            }
          : event,
      ),
    };
    writeState(input.workspaceId, stateDir, next);
    return { state: next };
  });
}

export function stopReceiver(input: {
  workspaceId: string;
  principal: ConversationPrincipal;
  stateDir?: string;
}): FeedbackState {
  requireConversationPrincipal(input.principal);
  const stateDir = input.stateDir ?? getStateDir();
  return withFeedbackLock(input.workspaceId, stateDir, (read) => {
    const previous = requireInitializedState(read(), input.workspaceId);
    if (!previous.binding) return previous;
    if (previous.binding.principalFingerprint !== input.principal.fingerprint) {
      throw new FeedbackError("FEEDBACK_PRINCIPAL_MISMATCH", "停止主体与当前 receiver 绑定不一致");
    }
    const now = Date.now();
    const next: FeedbackState = {
      ...recoverStaleClaimed(previous, now),
      binding: { ...previous.binding, status: "superseded" },
    };
    writeState(input.workspaceId, stateDir, next);
    return next;
  });
}

/** 投影到 store：与 cursor 原子前进。 */
export function applyProjection(input: {
  workspaceId: string;
  stateDir?: string;
  nextCursor: number;
  newEvents: FeedbackEvent[];
}): FeedbackState {
  const stateDir = input.stateDir ?? getStateDir();
  return withFeedbackLock(input.workspaceId, stateDir, (read) => {
    const previous = requireInitializedState(read(), input.workspaceId);
    if (input.nextCursor < previous.projectionCursor) {
      throw new FeedbackError("FEEDBACK_CURSOR_REGRESSION", "projection cursor 不得回退");
    }
    const now = new Date().toISOString();
    const existing = new Set(previous.events.map((e) => e.eventId));
    const binding = previous.binding && previous.binding.status === "active" ? previous.binding : null;
    const added = input.newEvents
      .filter((event) => !existing.has(event.eventId))
      .map((event) => {
        if (binding) {
          return {
            ...event,
            status: "ready" as const,
            targetBindingId: binding.bindingId,
            targetEpoch: binding.epoch,
            targetPrincipalFingerprint: binding.principalFingerprint,
            updatedAt: now,
          };
        }
        return {
          ...event,
          status: "queued" as const,
          targetBindingId: null,
          targetEpoch: null,
          targetPrincipalFingerprint: null,
          updatedAt: now,
        };
      });
    const next: FeedbackState = {
      ...previous,
      projectionCursor: input.nextCursor,
      events: [...previous.events, ...added],
    };
    writeState(input.workspaceId, stateDir, next);
    return next;
  });
}

export function claimNext(input: {
  workspaceId: string;
  principal: ConversationPrincipal;
  bindingId: string;
  epoch: number;
  stateDir?: string;
}): { event: FeedbackEvent; attemptId: string } {
  requireConversationPrincipal(input.principal);
  const stateDir = input.stateDir ?? getStateDir();
  return withFeedbackLock(input.workspaceId, stateDir, (read) => {
    const previous = requireInitializedState(read(), input.workspaceId);
    const recovered = recoverStaleClaimed(previous, Date.now());
    if (recovered !== previous) {
      writeState(input.workspaceId, stateDir, recovered);
    }
    const binding = requireActiveBinding(recovered, input.principal);
    if (binding.bindingId !== input.bindingId || binding.epoch !== input.epoch) {
      throw new FeedbackError("FEEDBACK_EPOCH_STALE", "旧绑定不能领取事件");
    }
    const ready = recovered.events
      .filter((e) => e.status === "ready")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (ready.length === 0) {
      throw new FeedbackError("FEEDBACK_NO_READY_EVENT", "没有可领取的 ready 事件");
    }
    const target = ready[0]!;
    const attemptId = randomUUID();
    const claimedAt = new Date().toISOString();
    const next: FeedbackState = {
      ...recovered,
      events: recovered.events.map((e) =>
        e.eventId === target.eventId
          ? { ...e, status: "claimed" as const, attemptId, claimedAt, updatedAt: claimedAt }
          : e,
      ),
    };
    writeState(input.workspaceId, stateDir, next);
    return { event: next.events.find((e) => e.eventId === target.eventId)!, attemptId };
  });
}

export function ackObserved(input: {
  workspaceId: string;
  principal: ConversationPrincipal;
  bindingId: string;
  epoch: number;
  eventId: string;
  attemptId: string;
  stateDir?: string;
}): FeedbackEvent {
  requireConversationPrincipal(input.principal);
  const stateDir = input.stateDir ?? getStateDir();
  return withFeedbackLock(input.workspaceId, stateDir, (read) => {
    const previous = requireInitializedState(read(), input.workspaceId);
    const recovered = recoverStaleClaimed(previous, Date.now());
    if (recovered !== previous) {
      writeState(input.workspaceId, stateDir, recovered);
    }
    const binding = requireActiveBinding(recovered, input.principal);
    if (binding.bindingId !== input.bindingId || binding.epoch !== input.epoch) {
      throw new FeedbackError("FEEDBACK_EPOCH_STALE", "旧绑定不能确认事件");
    }
    const event = recovered.events.find((e) => e.eventId === input.eventId);
    if (!event) throw new FeedbackError("FEEDBACK_EVENT_NOT_FOUND", "feedback 事件不存在");
    // 先完整校验 target/attempt，再处理 observed 幂等。
    if (event.targetBindingId !== binding.bindingId
      || event.targetEpoch !== binding.epoch
      || event.targetPrincipalFingerprint !== input.principal.fingerprint) {
      throw new FeedbackError("FEEDBACK_ACK_MISMATCH", "ack 目标绑定不匹配");
    }
    if (event.status === "observed") {
      if (event.attemptId === input.attemptId) return event;
      throw new FeedbackError("FEEDBACK_ACK_MISMATCH", "observed 事件 attempt 不匹配");
    }
    if (event.status !== "claimed" || event.attemptId !== input.attemptId) {
      throw new FeedbackError("FEEDBACK_ACK_MISMATCH", "ack 身份与 claimed 事件不匹配");
    }
    const next: FeedbackState = {
      ...recovered,
      events: recovered.events.map((e) =>
        e.eventId === input.eventId
          ? { ...e, status: "observed" as const, updatedAt: new Date().toISOString() }
          : e,
      ),
    };
    writeState(input.workspaceId, stateDir, next);
    return next.events.find((e) => e.eventId === input.eventId)!;
  });
}

/** 确定性 eventId：同一 receipt 重复扫描不会重复创建。 */
export function feedbackEventId(parts: {
  workspaceId: string;
  commandId: string;
  taskId: string;
  iteration: number;
  desktopReceiptSha256: string;
}): string {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex").slice(0, 32);
}

export function feedbackStatusSummary(state: FeedbackState, callerFingerprint?: string): Record<string, unknown> {
  return {
    workspaceId: state.workspaceId,
    enabled: state.binding?.status === "active",
    ownsBinding: Boolean(
      state.binding?.status === "active"
      && callerFingerprint
      && state.binding.principalFingerprint === callerFingerprint,
    ),
    projectionCursor: state.projectionCursor,
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
      eventId: e.eventId,
      kind: e.kind,
      commandId: e.commandId,
      taskId: e.taskId,
      iteration: e.iteration,
      result: e.result,
      status: e.status,
      outputAvailable: e.outputAvailable,
      ...(e.outputId !== undefined ? { outputId: e.outputId } : {}),
      ...(e.attemptId ? { attemptId: e.attemptId } : {}),
      targetEpoch: e.targetEpoch,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    })),
  };
}
