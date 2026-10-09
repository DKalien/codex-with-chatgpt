import { createHash } from "node:crypto";
import { MAX_MESSAGE_BYTES } from "./store.js";
import { z } from "zod";
import { sanitizeExecutionOutput } from "../execution/sanitize.js";
import {
  executionSummarySchema,
  sanitizeExecutionSummary,
} from "../execution/records.js";
import {
  DESKTOP_RESULT_ACTIVITY_ITEM_TYPES,
  MAX_RESULT_CONTINUATION_CHAIN,
  type DesktopResultActivityMarker,
  type DesktopResultTerminalFence,
} from "./ipc.js";

const UUID = z.string().uuid();
const DESKTOP_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const RECEIPT_FINALIZER_POLL_MS = 1_000;
export const RECEIPT_FINALIZER_MAX_LIFETIME_MS = 15 * 60_000;

const receiptFinalizationInputSchema = z.object({
  commandId: z.string().regex(DESKTOP_ID),
  changedFiles: z.array(z.string().max(4096)).max(10_000),
  tests: z.string().min(1).max(16_384),
  exitStatus: z.enum(["ok", "failed", "blocked"]),
  notes: z.string().max(16_384).optional(),
  // 新 receipt 必须提供；旧 v2 draft 保留缺失字段与原 canonical digest。
  rawSummary: executionSummarySchema.optional(),
  command: z.string().max(16_384).optional(),
  output: z.string().max(256 * 1024).optional(),
  outputRestrictedReason: z.string().max(128).optional(),
  exitCode: z.number().int().safe().optional(),
}).strict();

export const receiptFinalizationMarkerSchema = z.object({
  resultTurnId: UUID,
  itemIds: z.array(z.string().min(1).max(512)).min(1).max(4_096),
  itemTypes: z.array(z.enum(DESKTOP_RESULT_ACTIVITY_ITEM_TYPES)).min(1).max(4_096),
  itemCount: z.number().int().nonnegative().safe(),
  itemSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const receiptFinalizationDraftV1Schema = z.object({
  version: z.literal(1),
  draftId: UUID,
  workspaceId: z.string().regex(DESKTOP_ID),
  workspaceRoot: z.string().min(1),
  threadId: UUID,
  originTurnId: UUID,
  resultTurnId: UUID,
  commandId: z.string().regex(DESKTOP_ID),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

const receiptFinalizationDraftV2Schema = z.object({
  version: z.literal(2),
  draftId: UUID,
  workspaceId: z.string().regex(DESKTOP_ID),
  workspaceRoot: z.string().min(1),
  threadId: UUID,
  originTurnId: UUID,
  resultTurnId: UUID,
  commandId: z.string().regex(DESKTOP_ID),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  input: receiptFinalizationInputSchema,
  marker: receiptFinalizationMarkerSchema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

export const receiptFinalizationOwnershipSnapshotSchema = z.object({
  workspaceId: z.string().regex(DESKTOP_ID),
  commandId: z.string().regex(DESKTOP_ID),
  threadId: UUID,
  hostId: z.literal("local"),
  projectId: z.string().min(1).max(128),
  workspaceRoot: z.string().min(1).max(32_768),
  intent: z.enum(["development_plan", "revision"]),
  messageBytes: z.number().int().safe().min(1).max(MAX_MESSAGE_BYTES),
  messageSha256: z.string().regex(/^[a-f0-9]{64}$/),
  ownership: z.enum(["origin", "native_continuation"]),
  originTurnId: UUID,
  deliveryId: UUID.optional(),
  originAlias: z.enum(["edit_user_message_v2_delivery"]).nullable(),
  resultTurnId: UUID,
  chainTurnIds: z.array(UUID).min(1).max(MAX_RESULT_CONTINUATION_CHAIN + 1),
  chainLength: z.number().int().safe().min(0).max(MAX_RESULT_CONTINUATION_CHAIN),
  chainSignatures: z.array(z.enum(["capacity_retry_automatic", "resume_interrupted_task"]))
    .max(MAX_RESULT_CONTINUATION_CHAIN),
  signature: z.enum(["capacity_retry_automatic", "resume_interrupted_task"]).nullable(),
}).strict().superRefine((snapshot, context) => {
  if (snapshot.chainLength !== snapshot.chainTurnIds.length - 1 ||
      new Set(snapshot.chainTurnIds).size !== snapshot.chainTurnIds.length ||
      snapshot.chainTurnIds[0] !== snapshot.originTurnId ||
      snapshot.chainTurnIds[snapshot.chainTurnIds.length - 1] !== snapshot.resultTurnId ||
      snapshot.chainSignatures.length !== snapshot.chainLength) {
    context.addIssue({ code: "custom", message: "ownership chain shape is inconsistent" });
  }
  if (snapshot.ownership === "origin") {
    if (snapshot.chainLength !== 0 || snapshot.originAlias !== null || snapshot.signature !== null ||
        snapshot.resultTurnId !== snapshot.originTurnId) {
      context.addIssue({ code: "custom", message: "origin ownership shape is inconsistent" });
    }
  } else if (snapshot.chainLength < 1 ||
      snapshot.signature !== snapshot.chainSignatures[snapshot.chainSignatures.length - 1] ||
      snapshot.resultTurnId === snapshot.originTurnId) {
    context.addIssue({ code: "custom", message: "continuation ownership shape is inconsistent" });
  }
  if (snapshot.originAlias !== null &&
      (snapshot.deliveryId === undefined || snapshot.ownership !== "native_continuation" ||
       snapshot.chainSignatures[0] !== "resume_interrupted_task")) {
    context.addIssue({ code: "custom", message: "origin alias ownership shape is inconsistent" });
  }
});

const receiptFinalizationDraftV3Schema = receiptFinalizationDraftV2Schema.extend({
  version: z.literal(3),
  ownershipSnapshot: receiptFinalizationOwnershipSnapshotSchema,
}).strict().superRefine((draft, context) => {
  if (draft.input.rawSummary === undefined) {
    context.addIssue({ code: "custom", message: "new receipt finalization draft requires rawSummary" });
  }
  const snapshot = draft.ownershipSnapshot;
  if (snapshot.workspaceId !== draft.workspaceId || snapshot.commandId !== draft.commandId ||
      snapshot.threadId !== draft.threadId || snapshot.workspaceRoot !== draft.workspaceRoot ||
      (snapshot.originAlias === null && snapshot.originTurnId !== draft.originTurnId) ||
      (snapshot.originAlias !== null && snapshot.originTurnId === draft.originTurnId) ||
      snapshot.resultTurnId !== draft.resultTurnId) {
    context.addIssue({ code: "custom", message: "ownership snapshot does not match draft identity" });
  }
});

export const receiptFinalizationDraftSchema = z.union([
  receiptFinalizationDraftV1Schema,
  receiptFinalizationDraftV2Schema,
  receiptFinalizationDraftV3Schema,
]);

export type ReceiptFinalizationInput = z.infer<typeof receiptFinalizationInputSchema>;
export type ReceiptFinalizationMarker = DesktopResultActivityMarker;
export type ReceiptFinalizationFenceResult = DesktopResultTerminalFence;
export type ReceiptFinalizationOwnershipSnapshot = z.infer<typeof receiptFinalizationOwnershipSnapshotSchema>;
export type ReceiptFinalizationMarkedDraft = Extract<ReceiptFinalizationDraft, { version: 2 | 3 }>;

function markerMaterial(marker: { itemIds: string[]; itemTypes: string[] }): string {
  return JSON.stringify(marker.itemIds.map((id, index) => ({ id, type: marker.itemTypes[index] })))
    .replace(/[\u007f-\uffff]/g, character => {
      const code = character.charCodeAt(0).toString(16).padStart(4, "0");
      return `\\u${code}`;
    });
}

export function receiptFinalizationMarkerDigest(marker: { itemIds: string[]; itemTypes: string[] }): string {
  return createHash("sha256").update(markerMaterial(marker), "utf8").digest("hex");
}

export function parseReceiptFinalizationMarker(value: unknown): ReceiptFinalizationMarker {
  const marker = receiptFinalizationMarkerSchema.parse(value);
  if (marker.itemIds.length !== marker.itemCount || marker.itemTypes.length !== marker.itemCount ||
      receiptFinalizationMarkerDigest(marker) !== marker.itemSha256) {
    throw new Error("Desktop receipt activity marker 不一致；拒绝继续。 ");
  }
  return marker as unknown as ReceiptFinalizationMarker;
}

export function receiptFinalizationDraftMarkerEqual(left: ReceiptFinalizationDraft, right: ReceiptFinalizationDraft): boolean {
  if (left.version !== right.version) return false;
  if (left.version === 1) return true;
  if (!("marker" in left) || !("marker" in right) || JSON.stringify(left.marker) !== JSON.stringify(right.marker)) return false;
  return left.version !== 3 || (right.version === 3 &&
    JSON.stringify(left.ownershipSnapshot) === JSON.stringify(right.ownershipSnapshot));
}

/** 只把 output 交给现有 sanitizer；draft 永远不落原始敏感输出。 */
export function sanitizeReceiptFinalizationInput(value: unknown): ReceiptFinalizationInput {
  const input = receiptFinalizationInputSchema.parse(value);
  const rawSummary = input.rawSummary === undefined ? undefined : sanitizeExecutionSummary(input.rawSummary);
  if (input.output === undefined) {
    return rawSummary === undefined ? input : { ...input, rawSummary };
  }
  const sanitized = sanitizeExecutionOutput(input.output);
  return {
    ...input,
    ...(rawSummary === undefined ? {} : { rawSummary }),
    ...(sanitized.allowed
      ? { output: sanitized.text, outputRestrictedReason: undefined }
      : { output: undefined, outputRestrictedReason: sanitized.reason }),
  };
}

export function canonicalReceiptFinalizationInput(input: ReceiptFinalizationInput): string {
  return JSON.stringify({
    commandId: input.commandId,
    changedFiles: [...input.changedFiles],
    tests: input.tests,
    exitStatus: input.exitStatus,
    notes: input.notes ?? null,
    ...(input.rawSummary === undefined ? {} : { rawSummary: input.rawSummary }),
    command: input.command ?? null,
    output: input.output ?? null,
    outputRestrictedReason: input.outputRestrictedReason ?? null,
    exitCode: input.exitCode ?? null,
  });
}

export const receiptFinalizationAlertSchema = z.object({
  version: z.literal(1),
  alertId: UUID,
  workspaceId: z.string().regex(DESKTOP_ID),
  commandId: z.string().regex(DESKTOP_ID),
  reason: z.enum([
    "post_record_activity",
    "post_record_activity_unprovable",
    "identity_drift",
    "terminality_unknown",
    "timeout",
    "worker_spawn_failed",
  ]),
  occurredAt: z.string().datetime(),
}).strict();

export type ReceiptFinalizationDraft = z.infer<typeof receiptFinalizationDraftSchema>;
export type ReceiptFinalizationAlert = z.infer<typeof receiptFinalizationAlertSchema>;
