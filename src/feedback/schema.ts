import { createHash } from "node:crypto";
import { z } from "zod";
import { machineEvidenceSchema } from "../routing/schema.js";

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
export const WORKSPACE_ID = /^[a-f0-9]{12}$/;
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
  plannerRouteId: z.string().uuid().optional(),
  plannerPrincipalFingerprint: z.string().regex(HEX32).optional(),
  resultId: z.string().uuid().optional(),
  resultSha256: z.string().regex(HEX64).optional(),
  rawSummary: z.string().min(1).refine((value) => Buffer.byteLength(value, "utf8") <= 8192, "rawSummary 超过 8192 UTF-8 bytes").optional(),
  machineEvidence: machineEvidenceSchema.optional(),
}).strict().superRefine((event, ctx) => {
  const canonicalKeys = ["plannerRouteId", "plannerPrincipalFingerprint", "resultId", "resultSha256", "rawSummary", "machineEvidence"] as const;
  const present = canonicalKeys.filter((key) => event[key] !== undefined).length;
  if (present !== 0 && present !== canonicalKeys.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "canonical feedback 元数据必须全部存在或全部缺失" });
    return;
  }
  if (present === 0) return;
  if (event.taskId !== `desktop_${event.commandId}` || event.machineEvidence?.taskId !== event.taskId
    || event.machineEvidence?.iteration !== event.iteration || event.machineEvidence?.status !== event.result) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "canonical feedback 身份与 machineEvidence 不一致" });
  }
});

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

export const panelActionSchema = z.enum(["cancel_command", "cancel_return", "requeue_return", "cleanup"]);
export const panelGrantSchema = z.object({
  grantId: z.string().uuid(), companionId: z.string().uuid(), bindingId: z.string().uuid(),
  epoch: z.number().int().nonnegative(), routeCanonical: z.string().min(1).max(512),
  actions: z.array(panelActionSchema).min(1).max(4), expiresAt: z.string().datetime(),
}).strict();
export const panelOperationSchema = z.object({
  requestId: z.string().uuid(), grantId: z.string().uuid(), commandId: z.string().regex(DESKTOP_ID),
  action: panelActionSchema, confirmationSha256: z.string().regex(HEX64),
  requestSha256: z.string().regex(HEX64),
  eventId: z.string().regex(HEX32).optional(), sourceSha256: z.string().regex(HEX64).optional(), reservationId: z.string().uuid().optional(),
  status: z.enum(["pending", "completed"]), createdAt: z.string().datetime(),
}).strict();

export const feedbackStateSchema = z.object({
  version: z.literal(1),
  workspaceId: z.string().regex(WORKSPACE_ID),
  projectionCursor: z.number().int().nonnegative(),
  binding: feedbackBindingSchema.nullable(),
  events: z.array(feedbackEventSchema).max(10000),
  panelGrant: panelGrantSchema.optional(),
  panelOperations: z.array(panelOperationSchema).max(100).optional(),
  // Active command cleanup only; removed before its journal is finalized.
  cleanupAdjustments: z.array(z.object({
    cleanupId: z.string().uuid(),
    commandId: z.string().regex(DESKTOP_ID),
    index: z.number().int().nonnegative(),
    recordCount: z.number().int().positive(),
    beforePrefixSha256: z.string().regex(HEX64),
    afterPrefixSha256: z.string().regex(HEX64),
    state: z.enum(["prepared", "applied"]),
  }).strict()).max(8).optional(),
  pairingIntent: pairingIntentSchema.nullable().default(null),
  companion: companionRecordSchema.nullable().default(null),
  rebindIntent: companionRebindIntentSchema.nullable().default(null),
  rebindPredecessor: companionRebindPredecessorSchema.nullable().default(null),
}).strict().superRefine((state, ctx) => {
  const ids = (state.panelOperations ?? []).map(item => item.requestId);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "重复 panel requestId" });
});

// Compatibility fence: the running pre-command51 Bridge only understands
// C2C_EXECUTED events. Keep this schema local to the repair path so normal
// runtime parsing remains the forward-capable union above.
export const legacyFeedbackStateSchema = z.object({
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
export function formatRouteAttestationMessage(challengeId: string, challengeDigest: string, workspaceId?: string): string {
  return [
    "[C2C_ROUTE_ATTEST]",
    ...(workspaceId ? [`workspaceId=${workspaceId}`] : []),
    `challengeId=${challengeId}`,
    `challengeDigest=${challengeDigest}`,
    "",
    "这是 C2C delivery-route verification，不是新开发任务。",
    "请在本对话调用 MCP 工具（参数必须与上方身份行完全一致）：",
    `feedback_companion_route_confirm(${workspaceId ? `workspaceId=${workspaceId}, ` : ""}challengeId=${challengeId}, challengeDigest=${challengeDigest})`,
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
