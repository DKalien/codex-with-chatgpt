import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";
import {
  requireConversationPrincipal,
  type ConversationPrincipal,
} from "../mcp/conversation-principal.js";
import { listReceiptFinalizationAlerts } from "../desktop/receipt-finalizer.js";

/** production feedback 永久 scope；与 synthetic feedback.probe 分离。 */
export const CODEX_FEEDBACK_SCOPE = "codex.feedback";
export const FEEDBACK_EVENT_KIND = "C2C_EXECUTED";
export const FINAL_RECEIPT_REQUIRED_EVENT_KIND = "FINAL_RECEIPT_REQUIRED";
/** 新版 Bridge 才声明并投影控制类反馈事件；不改变 connector contract。 */
export const FEEDBACK_CONTROL_EVENT_VERSION = 1;
/** Control event reasons are deliberately finite; never carry arbitrary diagnostic text. */
export const FINAL_RECEIPT_REQUIRED_REASONS = [
  "missing_final_receipt",
  "post_record_activity",
  "post_record_activity_unprovable",
  "identity_drift",
  "terminality_unknown",
  "timeout",
  "worker_spawn_failed",
] as const;
export const FEEDBACK_CLAIM_STALE_MS = 10 * 60_000;
/** reserved 可逆；比 claimed 短，避免长期占位。 */
export const FEEDBACK_RESERVATION_STALE_MS = 2 * 60_000;
export const COMPANION_PAIRING_TTL_MS = 10 * 60_000;
/** Route attestation challenge TTL; pairing ≠ origin conversation authenticated. */
export const COMPANION_ROUTE_ATTEST_TTL_MS = 10 * 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX32 = /^[a-f0-9]{32}$/;
const HEX64 = /^[a-f0-9]{64}$/;
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

export const c2cExecutedEventSchema = z.object({
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
  status: z.enum(["queued", "ready", "reserved", "claimed", "observed", "outcome_unknown", "retired_unknown"]),
  attemptId: z.string().regex(UUID).optional(),
  claimedAt: z.string().datetime().optional(),
  reservationId: z.string().regex(UUID).optional(),
  reservedAt: z.string().datetime().optional(),
  reservedBy: z.string().regex(UUID).optional(),
  retiredAt: z.string().datetime().optional(),
}).strict();

const feedbackEventLifecycleSchema = {
  version: z.literal(1),
  eventId: z.string().regex(HEX32),
  workspaceId: z.string().regex(WORKSPACE_ID),
  commandId: z.string().regex(DESKTOP_ID),
  occurredAt: z.string().max(64).datetime(),
  createdAt: z.string().max(64).datetime(),
  updatedAt: z.string().max(64).datetime(),
  targetBindingId: z.string().regex(UUID).nullable(),
  targetEpoch: z.number().int().nonnegative().nullable(),
  targetPrincipalFingerprint: z.string().regex(HEX32).nullable(),
  status: z.enum(["queued", "ready", "reserved", "claimed", "observed", "outcome_unknown", "retired_unknown"]),
  attemptId: z.string().regex(UUID).optional(),
  claimedAt: z.string().max(64).datetime().optional(),
  reservationId: z.string().regex(UUID).optional(),
  reservedAt: z.string().max(64).datetime().optional(),
  reservedBy: z.string().regex(UUID).optional(),
  retiredAt: z.string().max(64).datetime().optional(),
} as const;

export const finalReceiptRequiredInputSchema = z.object({
  workspaceId: z.string().regex(WORKSPACE_ID),
  commandId: z.string().regex(DESKTOP_ID),
  reason: z.enum(FINAL_RECEIPT_REQUIRED_REASONS),
  occurredAt: z.string().max(64).datetime(),
}).strict();

/** Persisted control event. It intentionally has no task/files/tests/output/raw fields. */
export const finalReceiptRequiredEventSchema = z.object({
  ...feedbackEventLifecycleSchema,
  kind: z.literal(FINAL_RECEIPT_REQUIRED_EVENT_KIND),
  source: z.literal("control"),
  taskId: z.string().regex(/^desktop_finalization_[A-Za-z0-9_-]{1,128}$/),
  iteration: z.literal(1),
  result: z.literal("blocked"),
  changedFilesSummary: z.array(z.string().min(1).max(512)).max(0),
  testsSummary: z.literal(""),
  outputAvailable: z.literal(false),
  outputId: z.never().optional(),
  reason: z.enum(FINAL_RECEIPT_REQUIRED_REASONS),
}).strict();

export const feedbackEventSchema = z.union([
  c2cExecutedEventSchema,
  finalReceiptRequiredEventSchema,
]);

export const pairingIntentSchema = z.object({
  version: z.literal(1),
  intentId: z.string().regex(UUID),
  bindingId: z.string().regex(UUID),
  epoch: z.number().int().nonnegative(),
  principalFingerprint: z.string().regex(HEX32),
  secretHash: z.string().regex(HEX64),
  expiresAt: z.string().datetime(),
  consumedAt: z.string().datetime().optional(),
}).strict();

export const routeAttestationSchema = z.object({
  status: z.enum(["pending", "verified"]),
  challengeId: z.string().regex(UUID),
  challengeDigest: z.string().regex(HEX64),
  routeCanonical: z.string().min(1).max(512),
  expiresAt: z.string().datetime(),
  verifiedAt: z.string().datetime().optional(),
  consumedAt: z.string().datetime().optional(),
}).strict();

export const companionRecordSchema = z.object({
  version: z.literal(1),
  companionId: z.string().regex(UUID),
  bindingId: z.string().regex(UUID),
  epoch: z.number().int().nonnegative(),
  principalFingerprint: z.string().regex(HEX32),
  credentialHash: z.string().regex(HEX64),
  routeCanonical: z.string().min(1).max(512),
  pairedAt: z.string().datetime(),
  supersededAt: z.string().datetime().optional(),
  /** Optional for legacy schema compatibility; missing ⇒ unverified. */
  routeAttestation: routeAttestationSchema.optional(),
}).strict();

export const companionRebindIntentSchema = z.object({
  version: z.literal(1),
  companionId: z.string().regex(UUID),
  previousBindingId: z.string().regex(UUID),
  previousEpoch: z.number().int().nonnegative(),
  bindingId: z.string().regex(UUID),
  epoch: z.number().int().nonnegative(),
  principalFingerprint: z.string().regex(HEX32),
  routeCanonical: z.string().min(1).max(512),
  initiatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  confirmedAt: z.string().datetime().optional(),
  consumedAt: z.string().datetime().optional(),
  routeAttestation: routeAttestationSchema,
}).strict();

export const companionRebindPredecessorSchema = z.object({
  version: z.literal(1),
  companionId: z.string().regex(UUID),
  previousBindingId: z.string().regex(UUID),
  previousEpoch: z.number().int().nonnegative(),
  bindingId: z.string().regex(UUID),
  epoch: z.number().int().nonnegative(),
}).strict();

export const feedbackStateSchema = z.object({
  version: z.literal(1),
  workspaceId: z.string().regex(WORKSPACE_ID),
  projectionCursor: z.number().int().nonnegative(),
  binding: feedbackBindingSchema.nullable(),
  events: z.array(feedbackEventSchema).max(10000),
  pairingIntent: pairingIntentSchema.nullable().default(null),
  companion: companionRecordSchema.nullable().default(null),
  rebindIntent: companionRebindIntentSchema.nullable().default(null),
  rebindPredecessor: companionRebindPredecessorSchema.nullable().default(null),
}).strict();

// Compatibility fence: the running pre-command51 Bridge only understands
// C2C_EXECUTED events. Keep this schema local to the repair path so normal
// runtime parsing remains the forward-capable union above.
const legacyFeedbackStateSchema = z.object({
  version: z.literal(1),
  workspaceId: z.string().regex(WORKSPACE_ID),
  projectionCursor: z.number().int().nonnegative(),
  binding: feedbackBindingSchema.nullable(),
  events: z.array(c2cExecutedEventSchema).max(10000),
  pairingIntent: pairingIntentSchema.nullable().default(null),
  companion: companionRecordSchema.nullable().default(null),
  rebindIntent: companionRebindIntentSchema.nullable().default(null),
  rebindPredecessor: companionRebindPredecessorSchema.nullable().default(null),
}).strict();

export type FeedbackBinding = z.infer<typeof feedbackBindingSchema>;
export type C2CExecutedFeedbackEvent = z.infer<typeof c2cExecutedEventSchema>;
export type FinalReceiptRequiredEvent = z.infer<typeof finalReceiptRequiredEventSchema>;
export type FeedbackEvent = C2CExecutedFeedbackEvent | FinalReceiptRequiredEvent;
export type FeedbackState = z.infer<typeof feedbackStateSchema>;
export type PairingIntent = z.infer<typeof pairingIntentSchema>;
export type CompanionRecord = z.infer<typeof companionRecordSchema>;
export type RouteAttestation = z.infer<typeof routeAttestationSchema>;
export type CompanionRebindIntent = z.infer<typeof companionRebindIntentSchema>;

/** Challenge binds workspace+binding+epoch+companion+route; never infer openai/session from URL. */
export function routeChallengeDigest(input: {
  workspaceId: string;
  bindingId: string;
  epoch: number;
  companionId: string;
  routeCanonical: string;
  challengeId: string;
}): string {
  return createHash("sha256").update(JSON.stringify({
    workspaceId: input.workspaceId,
    bindingId: input.bindingId,
    epoch: input.epoch,
    companionId: input.companionId,
    routeCanonical: input.routeCanonical,
    challengeId: input.challengeId,
  }), "utf8").digest("hex");
}

/** Fixed attestation body; no credential/principal/secret; browser cannot free-write.
 * Tool-call instruction carries the actual challengeId/challengeDigest values — never placeholders.
 */
export function formatRouteAttestationMessage(challengeId: string, challengeDigest: string): string {
  return [
    "[C2C_ROUTE_ATTEST]",
    `challengeId=${challengeId}`,
    `challengeDigest=${challengeDigest}`,
    "",
    "这是 C2C delivery-route verification，不是新开发任务。",
    "请在本对话调用 MCP 工具（参数必须与上方两行完全一致）：",
    `feedback_companion_route_confirm(challengeId=${challengeId}, challengeDigest=${challengeDigest})`,
  ].join("\n");
}

/**
 * Legacy CompanionRecord without routeAttestation is unverified.
 * verified requires explicit status=verified + verifiedAt + matching route.
 */
export function isRouteAttestationVerified(
  companion: CompanionRecord | null | undefined,
): boolean {
  if (!companion || companion.supersededAt) return false;
  const att = companion.routeAttestation;
  if (!att) return false;
  if (att.status !== "verified" || !att.verifiedAt) return false;
  return att.routeCanonical === companion.routeCanonical;
}

export function feedbackStateFile(workspaceId: string, stateDir = getStateDir()): string {
  if (!WORKSPACE_ID.test(workspaceId)) {
    throw new FeedbackError("FEEDBACK_WORKSPACE_MISMATCH", "workspaceId 无效");
  }
  return path.join(path.resolve(stateDir), "feedback", `${workspaceId}.json`);
}

function emptyState(workspaceId: string, projectionCursor = 0): FeedbackState {
  return {
    version: 1,
    workspaceId,
    projectionCursor,
    binding: null,
    events: [],
    pairingIntent: null,
    companion: null,
    rebindIntent: null,
    rebindPredecessor: null,
  };
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

function recoverStaleReserved(state: FeedbackState, nowMs: number): FeedbackState {
  let changed = false;
  const events = state.events.map((event) => {
    if (event.status !== "reserved" || !event.reservedAt) return event;
    const age = nowMs - Date.parse(event.reservedAt);
    if (Number.isFinite(age) && age >= FEEDBACK_RESERVATION_STALE_MS) {
      changed = true;
      const {
        reservationId: _rid,
        reservedAt: _rat,
        reservedBy: _rby,
        ...rest
      } = event;
      return {
        ...rest,
        status: "ready" as const,
        updatedAt: new Date(nowMs).toISOString(),
      };
    }
    return event;
  });
  return changed ? { ...state, events } : state;
}

export function recoverStaleInMemory(state: FeedbackState, nowMs: number): FeedbackState {
  return recoverStaleReserved(recoverStaleClaimed(state, nowMs), nowMs);
}

/** 锁内 stale convergence；reconcile 每次调用，resident 重开仅 status 即可恢复。 */
export function recoverStaleFeedback(
  workspaceId: string,
  stateDir = getStateDir(),
  nowMs: number = Date.now(),
): FeedbackState {
  return withFeedbackLock(workspaceId, stateDir, (read) => {
    const previous = requireInitializedState(read(), workspaceId);
    const recovered = recoverStaleInMemory(previous, nowMs);
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
    const recovered = recoverStaleInMemory(previous, now);
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
      rebindIntent: null,
      rebindPredecessor: null,
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
    if (previous.events.some((e) => e.status === "claimed" || e.status === "outcome_unknown" || e.status === "reserved")) {
      throw new FeedbackError(
        "FEEDBACK_TAKEOVER_BLOCKED",
        "存在 claimed/outcome_unknown/reserved 事件；禁止接管以免重发",
      );
    }
    const now = Date.now();
    const recovered = recoverStaleInMemory(previous, now);
    if (recovered.events.some((e) => e.status === "claimed" || e.status === "outcome_unknown" || e.status === "reserved")) {
      throw new FeedbackError(
        "FEEDBACK_TAKEOVER_BLOCKED",
        "存在 claimed/outcome_unknown/reserved 事件；禁止接管以免重发",
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
      rebindIntent: null,
      rebindPredecessor: recovered.companion
        && !recovered.companion.supersededAt
        && recovered.companion.bindingId === previous.binding.bindingId
        && recovered.companion.epoch === previous.binding.epoch
        && recovered.companion.principalFingerprint === previous.binding.principalFingerprint
        ? {
            version: 1,
            companionId: recovered.companion.companionId,
            previousBindingId: previous.binding.bindingId,
            previousEpoch: previous.binding.epoch,
            bindingId: binding.bindingId,
            epoch: binding.epoch,
          }
        : null,
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
      ...recoverStaleInMemory(previous, now),
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
    const recovered = recoverStaleInMemory(previous, Date.now());
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
    const recovered = recoverStaleInMemory(previous, Date.now());
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
    // retired_unknown 是人工终态：一旦 retire，后续 ACK 必须拒绝，绝不能 resurrect。
    if (event.status === "retired_unknown") {
      throw new FeedbackError("FEEDBACK_ACK_MISMATCH", "retired 事件不可 ACK");
    }
    // Late-positive：stale recovery 后的 outcome_unknown 仍可在 exact attempt 下闭环。
    // ready / reserved / queued 及其它非 claimed/outcome_unknown 状态全部拒绝。
    const isExactClaimAttempt =
      event.attemptId === input.attemptId
      && (event.status === "claimed" || event.status === "outcome_unknown");
    if (!isExactClaimAttempt) {
      throw new FeedbackError(
        "FEEDBACK_ACK_MISMATCH",
        "ack 身份与 claimed/outcome_unknown 事件不匹配",
      );
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

function requireActiveCompanionBinding(
  state: FeedbackState,
  input: {
    bindingId: string;
    epoch: number;
    principalFingerprint: string;
  },
): FeedbackBinding {
  if (!state.binding || state.binding.status !== "active") {
    throw new FeedbackError("FEEDBACK_NOT_ENABLED", "production feedback 未启用");
  }
  if (
    state.binding.bindingId !== input.bindingId
    || state.binding.epoch !== input.epoch
    || state.binding.principalFingerprint !== input.principalFingerprint
  ) {
    throw new FeedbackError("FEEDBACK_EPOCH_STALE", "companion 绑定代次已失效");
  }
  return state.binding;
}

const INFLIGHT_FENCE_STATUSES = new Set(["reserved", "claimed", "outcome_unknown"]);

/** ready → reserved；binding 范围内任一 reserved/claimed/outcome_unknown 时 single-flight fence。 */
export function reserveNext(input: {
  workspaceId: string;
  bindingId: string;
  epoch: number;
  principalFingerprint: string;
  companionId: string;
  stateDir?: string;
}): { event: FeedbackEvent; reservationId: string } {
  const stateDir = input.stateDir ?? getStateDir();
  return withFeedbackLock(input.workspaceId, stateDir, (read) => {
    const previous = requireInitializedState(read(), input.workspaceId);
    const recovered = recoverStaleInMemory(previous, Date.now());
    if (recovered !== previous) {
      writeState(input.workspaceId, stateDir, recovered);
    }
    requireActiveCompanionBinding(recovered, input);
    // Companion delivery 严格 single-flight：未解决 reserved/claimed/outcome_unknown 不得越过继续消费 ready。
    if (recovered.events.some((e) => INFLIGHT_FENCE_STATUSES.has(e.status))) {
      throw new FeedbackError(
        "FEEDBACK_INFLIGHT_FENCE",
        "存在 reserved/claimed/outcome_unknown 事件；禁止并发预占",
      );
    }
    const ready = recovered.events
      .filter((e) => e.status === "ready")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (ready.length === 0) {
      throw new FeedbackError("FEEDBACK_NO_READY_EVENT", "没有可预占的 ready 事件");
    }
    const target = ready[0]!;
    const reservationId = randomUUID();
    const reservedAt = new Date().toISOString();
    const next: FeedbackState = {
      ...recovered,
      events: recovered.events.map((e) =>
        e.eventId === target.eventId
          ? {
              ...e,
              status: "reserved" as const,
              reservationId,
              reservedAt,
              reservedBy: input.companionId,
              updatedAt: reservedAt,
            }
          : e,
      ),
    };
    writeState(input.workspaceId, stateDir, next);
    return {
      event: next.events.find((e) => e.eventId === target.eventId)!,
      reservationId,
    };
  });
}

/** reserved → ready；exact reservationId + companionId。 */
export function releaseReservation(input: {
  workspaceId: string;
  bindingId: string;
  epoch: number;
  principalFingerprint: string;
  companionId: string;
  eventId: string;
  reservationId: string;
  stateDir?: string;
}): FeedbackEvent {
  const stateDir = input.stateDir ?? getStateDir();
  return withFeedbackLock(input.workspaceId, stateDir, (read) => {
    const previous = requireInitializedState(read(), input.workspaceId);
    const recovered = recoverStaleInMemory(previous, Date.now());
    if (recovered !== previous) {
      writeState(input.workspaceId, stateDir, recovered);
    }
    requireActiveCompanionBinding(recovered, input);
    const event = recovered.events.find((e) => e.eventId === input.eventId);
    if (!event) throw new FeedbackError("FEEDBACK_EVENT_NOT_FOUND", "feedback 事件不存在");
    if (event.status === "ready") {
      if (event.reservationId) {
        throw new FeedbackError("FEEDBACK_RESERVATION_MISMATCH", "reservation 状态不一致");
      }
      return event;
    }
    if (event.status !== "reserved" || event.reservationId !== input.reservationId) {
      throw new FeedbackError("FEEDBACK_RESERVATION_MISMATCH", "reservation 身份不匹配");
    }
    if (
      event.reservedBy !== input.companionId
      || event.targetBindingId !== recovered.binding!.bindingId
      || event.targetEpoch !== recovered.binding!.epoch
      || event.targetPrincipalFingerprint !== input.principalFingerprint
    ) {
      throw new FeedbackError("FEEDBACK_RESERVATION_MISMATCH", "reservation 目标绑定不匹配");
    }
    const {
      reservationId: _rid,
      reservedAt: _rat,
      reservedBy: _rby,
      ...rest
    } = event;
    const released: FeedbackEvent = {
      ...rest,
      status: "ready",
      updatedAt: new Date().toISOString(),
    };
    const next: FeedbackState = {
      ...recovered,
      events: recovered.events.map((e) => (e.eventId === input.eventId ? released : e)),
    };
    writeState(input.workspaceId, stateDir, next);
    return released;
  });
}

/** reserved → claimed：不可逆 send-intent 边界。companionId 必须是 reservation 归属。 */
export function beginSend(input: {
  workspaceId: string;
  bindingId: string;
  epoch: number;
  principalFingerprint: string;
  companionId: string;
  eventId: string;
  reservationId: string;
  stateDir?: string;
}): { event: FeedbackEvent; attemptId: string } {
  const stateDir = input.stateDir ?? getStateDir();
  return withFeedbackLock(input.workspaceId, stateDir, (read) => {
    const previous = requireInitializedState(read(), input.workspaceId);
    const recovered = recoverStaleInMemory(previous, Date.now());
    if (recovered !== previous) {
      writeState(input.workspaceId, stateDir, recovered);
    }
    const binding = requireActiveCompanionBinding(recovered, input);
    const event = recovered.events.find((e) => e.eventId === input.eventId);
    if (!event) throw new FeedbackError("FEEDBACK_EVENT_NOT_FOUND", "feedback 事件不存在");
    // claimed 幂等也必须绑定 reservedBy：其它 companion 不得继承本 attempt。
    if (event.status === "claimed" && event.reservationId === input.reservationId) {
      if (event.reservedBy !== input.companionId) {
        throw new FeedbackError(
          "FEEDBACK_RESERVATION_MISMATCH",
          "claimed attempt 不属于当前 companion",
        );
      }
      if (!event.attemptId) {
        throw new FeedbackError("FEEDBACK_RESERVATION_MISMATCH", "claimed 事件缺少 attemptId");
      }
      return { event, attemptId: event.attemptId };
    }
    if (event.status !== "reserved" || event.reservationId !== input.reservationId) {
      throw new FeedbackError("FEEDBACK_RESERVATION_MISMATCH", "begin-send 需要 exact reserved 事件");
    }
    if (
      event.reservedBy !== input.companionId
      || event.targetBindingId !== binding.bindingId
      || event.targetEpoch !== binding.epoch
      || event.targetPrincipalFingerprint !== input.principalFingerprint
    ) {
      throw new FeedbackError("FEEDBACK_RESERVATION_MISMATCH", "reservation 归属不匹配");
    }
    const attemptId = randomUUID();
    const claimedAt = new Date().toISOString();
    const claimed: FeedbackEvent = {
      ...event,
      status: "claimed",
      attemptId,
      claimedAt,
      updatedAt: claimedAt,
    };
    const next: FeedbackState = {
      ...recovered,
      events: recovered.events.map((e) => (e.eventId === input.eventId ? claimed : e)),
    };
    writeState(input.workspaceId, stateDir, next);
    return { event: claimed, attemptId };
  });
}

/**
 * outcome_unknown → retired_unknown：人工显式放弃，永不重发。
 * 不是“证明未发送”，也不是 ACK；仅表示永久退出 single-flight。
 * 幂等：同 exact event/attempt/reservation/companion 重复 retire 返回现有成功。
 */
export function retireOutcomeUnknown(input: {
  workspaceId: string;
  bindingId: string;
  epoch: number;
  principalFingerprint: string;
  companionId: string;
  eventId: string;
  reservationId: string;
  attemptId: string;
  stateDir?: string;
}): FeedbackEvent {
  const stateDir = input.stateDir ?? getStateDir();
  return withFeedbackLock(input.workspaceId, stateDir, (read) => {
    const previous = requireInitializedState(read(), input.workspaceId);
    const recovered = recoverStaleInMemory(previous, Date.now());
    if (recovered !== previous) {
      writeState(input.workspaceId, stateDir, recovered);
    }
    const binding = requireActiveCompanionBinding(recovered, input);
    const event = recovered.events.find((e) => e.eventId === input.eventId);
    if (!event) throw new FeedbackError("FEEDBACK_EVENT_NOT_FOUND", "feedback 事件不存在");
    if (
      event.targetBindingId !== binding.bindingId
      || event.targetEpoch !== binding.epoch
      || event.targetPrincipalFingerprint !== input.principalFingerprint
    ) {
      throw new FeedbackError("FEEDBACK_RETIRE_MISMATCH", "retire 目标绑定不匹配");
    }
    // Idempotent exact retry.
    if (event.status === "retired_unknown") {
      if (
        event.attemptId === input.attemptId
        && event.reservationId === input.reservationId
        && event.reservedBy === input.companionId
      ) {
        return event;
      }
      throw new FeedbackError("FEEDBACK_RETIRE_MISMATCH", "retired 事件 attempt 不匹配");
    }
    if (event.status !== "outcome_unknown") {
      throw new FeedbackError("FEEDBACK_RETIRE_MISMATCH", "仅 outcome_unknown 事件可 retire");
    }
    if (
      event.attemptId !== input.attemptId
      || event.reservationId !== input.reservationId
      || event.reservedBy !== input.companionId
    ) {
      throw new FeedbackError("FEEDBACK_RETIRE_MISMATCH", "retire 身份与 outcome_unknown 事件不匹配");
    }
    const retiredAt = new Date().toISOString();
    const retired: FeedbackEvent = {
      ...event,
      status: "retired_unknown",
      retiredAt,
      updatedAt: retiredAt,
    };
    const next: FeedbackState = {
      ...recovered,
      events: recovered.events.map((e) => (e.eventId === input.eventId ? retired : e)),
    };
    writeState(input.workspaceId, stateDir, next);
    return retired;
  });
}

// ---------------------------------------------------------------------------
// Companion pairing / credential (state-owned; secrets never stored plaintext)
// ---------------------------------------------------------------------------

export function putPairingIntent(input: {
  workspaceId: string;
  intent: PairingIntent;
  stateDir?: string;
}): FeedbackState {
  const stateDir = input.stateDir ?? getStateDir();
  return withFeedbackLock(input.workspaceId, stateDir, (read) => {
    const previous = requireInitializedState(read(), input.workspaceId);
    const next: FeedbackState = { ...previous, pairingIntent: input.intent };
    writeState(input.workspaceId, stateDir, next);
    return next;
  });
}

export function mutateCompanionPairing<T>(
  workspaceId: string,
  stateDir: string,
  fn: (state: FeedbackState) => { state: FeedbackState; result: T },
): T {
  return withFeedbackLock(workspaceId, stateDir, (read) => {
    const previous = requireInitializedState(read(), workspaceId);
    const recovered = recoverStaleInMemory(previous, Date.now());
    if (recovered !== previous) {
      writeState(workspaceId, stateDir, recovered);
    }
    const { state: next, result } = fn(recovered);
    if (next !== recovered) {
      writeState(workspaceId, stateDir, next);
    }
    return result;
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

export function finalReceiptRequiredEventId(input: {
  workspaceId: string;
  commandId: string;
  alertId: string;
}): string {
  return createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex").slice(0, 32);
}

export interface FinalReceiptRepairResult {
  state: FeedbackState;
  removedEventIds: string[];
}

/**
 * 锁内收敛 FINAL_RECEIPT_REQUIRED。
 *
 * Control event 只有在 durable finalizer alert 与 event 身份完全匹配时才可移除。
 * 缺失、重复或冲突的 alert 一律 fail closed，且在校验完成前不写 state。
 */
export function repairFinalReceiptRequired(
  workspaceId: string,
  stateDir = getStateDir(),
): FinalReceiptRepairResult {
  return withFeedbackLock(workspaceId, stateDir, (read) => {
    const previous = requireInitializedState(read(), workspaceId);
    const alerts = listReceiptFinalizationAlerts(stateDir)
      .filter((alert) => alert.workspaceId === workspaceId);
    const alertsByCommand = new Map<string, typeof alerts>();
    for (const alert of alerts) {
      const current = alertsByCommand.get(alert.commandId) ?? [];
      current.push(alert);
      alertsByCommand.set(alert.commandId, current);
    }
    for (const [commandId, commandAlerts] of alertsByCommand) {
      if (commandAlerts.length > 1) {
        throw new FeedbackError(
          "FEEDBACK_FINALIZATION_CONFLICT",
          `同一 commandId 存在多个 durable finalization alert: ${commandId}`,
        );
      }
    }

    const eventIds = new Set<string>();
    const controlEventIds = new Set<string>();
    const controlCommandIds = new Set<string>();

    const removedEventIds: string[] = [];
    for (const event of previous.events) {
      if (eventIds.has(event.eventId)) {
        throw new FeedbackError("FEEDBACK_FINALIZATION_CONFLICT", `feedback state 存在重复 eventId: ${event.eventId}`);
      }
      eventIds.add(event.eventId);
      if (event.kind !== FINAL_RECEIPT_REQUIRED_EVENT_KIND) continue;
      if (controlEventIds.has(event.eventId) || controlCommandIds.has(event.commandId)) {
        throw new FeedbackError(
          "FEEDBACK_FINALIZATION_CONFLICT",
          `存在重复的 FINAL_RECEIPT_REQUIRED: ${event.commandId}`,
        );
      }
      controlEventIds.add(event.eventId);
      controlCommandIds.add(event.commandId);
      const commandAlerts = alertsByCommand.get(event.commandId) ?? [];
      if (commandAlerts.length === 0) {
        throw new FeedbackError(
          "FEEDBACK_FINALIZATION_UNSUPPORTED",
          `FINAL_RECEIPT_REQUIRED 缺少 durable alert: ${event.commandId}`,
        );
      }
      const [alert] = commandAlerts;
      const expectedEventId = finalReceiptRequiredEventId({
        workspaceId,
        commandId: alert.commandId,
        alertId: alert.alertId,
      });
      if (
        event.workspaceId !== alert.workspaceId
        || event.workspaceId !== workspaceId
        || event.commandId !== alert.commandId
        || event.eventId !== expectedEventId
        || event.taskId !== `desktop_finalization_${alert.commandId}`
        || event.iteration !== 1
        || event.result !== "blocked"
        || event.reason !== alert.reason
        || event.occurredAt !== alert.occurredAt
        || event.changedFilesSummary.length !== 0
        || event.testsSummary !== ""
        || event.outputAvailable !== false
      ) {
        throw new FeedbackError(
          "FEEDBACK_FINALIZATION_CONFLICT",
          `FINAL_RECEIPT_REQUIRED 与 durable alert 身份冲突: ${event.commandId}`,
        );
      }
      // Never delete an in-flight delivery: the receiver may still need to ACK
      // this exact attempt. A terminal receipt can only retire queued/ready or
      // already-settled control state.
      if (["reserved", "claimed", "outcome_unknown"].includes(event.status)) {
        throw new FeedbackError(
          "FEEDBACK_FINALIZATION_CONFLICT",
          `FINAL_RECEIPT_REQUIRED 仍在投递中: ${event.commandId}`,
        );
      }
      removedEventIds.push(event.eventId);
    }
    if (removedEventIds.length === 0) {
      legacyFeedbackStateSchema.parse(previous);
      return { state: previous, removedEventIds };
    }
    const removed = new Set(removedEventIds);
    const next: FeedbackState = {
      ...previous,
      events: previous.events.filter((event) => !removed.has(event.eventId)),
    };
    legacyFeedbackStateSchema.parse(next);
    writeState(workspaceId, stateDir, next);
    const reread = requireInitializedState(readState(workspaceId, stateDir), workspaceId);
    if (reread.events.some((event) => event.kind === FINAL_RECEIPT_REQUIRED_EVENT_KIND)) {
      throw new FeedbackError("FEEDBACK_FINALIZATION_CONFLICT", "兼容修复后仍残留控制事件");
    }
    legacyFeedbackStateSchema.parse(reread);
    return { state: reread, removedEventIds };
  });
}

/** Compatibility name used by maintenance callers; kept as a direct alias. */
export const repairForwardFeedbackControlEvents = repairFinalReceiptRequired;

export function publicFeedbackEvent(event: FeedbackEvent): Record<string, unknown> {
  return {
    eventId: event.eventId,
    kind: event.kind,
    commandId: event.commandId,
    taskId: event.taskId,
    iteration: event.iteration,
    result: event.result,
    status: event.status,
    outputAvailable: event.outputAvailable,
    ...(event.outputId !== undefined ? { outputId: event.outputId } : {}),
    ...(event.attemptId ? { attemptId: event.attemptId } : {}),
    ...(event.reservationId ? { reservationId: event.reservationId } : {}),
    targetEpoch: event.targetEpoch,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

/**
 * Companion 公网 delivery DTO：只含生成固定 C2C 消息所需字段。
 * 禁止 principalFingerprint / targetBindingId / reservedBy / secret 等内部身份。
 */
export function publicCompanionDeliveryEvent(event: FeedbackEvent): Record<string, unknown> {
  return {
    eventId: event.eventId,
    kind: event.kind,
    commandId: event.commandId,
    taskId: event.taskId,
    iteration: event.iteration,
    result: event.result,
    status: event.status,
    changedFilesSummary: event.changedFilesSummary,
    testsSummary: event.testsSummary,
    outputAvailable: event.outputAvailable,
    ...(event.outputId !== undefined ? { outputId: event.outputId } : {}),
    ...(event.attemptId ? { attemptId: event.attemptId } : {}),
    occurredAt: event.occurredAt,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

export function feedbackStatusSummary(state: FeedbackState, callerFingerprint?: string): Record<string, unknown> {
  const binding = state.binding && state.binding.status === "active" ? state.binding : null;
  const owns = Boolean(
    binding
    && callerFingerprint
    && binding.principalFingerprint === callerFingerprint,
  );
  // 仅当前 active binding/epoch/fingerprint 可见 companion route；旧 companion 不泄露。
  const companion = owns && state.companion && !state.companion.supersededAt
    && binding
    && state.companion.bindingId === binding.bindingId
    && state.companion.epoch === binding.epoch
    && state.companion.principalFingerprint === binding.principalFingerprint
    ? state.companion
    : null;
  return {
    workspaceId: state.workspaceId,
    enabled: Boolean(binding),
    ownsBinding: owns,
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
    companion: companion
      ? {
          companionId: companion.companionId,
          bindingId: companion.bindingId,
          epoch: companion.epoch,
          routeCanonical: companion.routeCanonical,
          pairedAt: companion.pairedAt,
        }
      : null,
    events: state.events.map((e) => publicFeedbackEvent(e)),
  };
}
