import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  resultSchema,
  routingCommandIdSchema,
  routingUuidSchema,
  routingWorkspaceIdSchema,
  type RoutingResult,
} from "../routing/schema.js";
import { officialResultSchema, resultBusResultDigest, type OfficialResult } from "./official-result.js";
import {
  endpointBindingIdSchema,
  endpointEpochSchema,
  endpointInstantSchema,
  webSinkSendTargetSnapshotSchema,
} from "../endpoints/schema.js";

import { HEX64 } from "../core/hex.js";
/** bounded 诊断/原因码：与 Routing reconciliation reasonCode 同字符集。 */
const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * 投递 lifecycle 冻结契约（R5d2）：
 * - queued/reserved：均未冻结投递目的地，sendTarget 必须为 null。
 * - send 发起（reserved → claimed 迁移）是冻结边界：此刻冻结精确的 generic WebSinkSendTargetSnapshot。
 * - claimed/observed/outcome_unknown/retired_unknown：sendTarget 必须保留且不可消失、不可改指。
 * 不设 "sending"：冻结边界唯一（reserved → claimed），冻结语义只有一个。
 * 投递状态迁移只能经由 result-bus store-owned 事务原语完成。
 */
export const resultBusLifecycleSchema = z.enum([
  "queued",
  "reserved",
  "claimed",
  "observed",
  "outcome_unknown",
  "retired_unknown",
  "cancelled",
]);

/** Bus entry 持久化身份：由 (workspaceId, commandId, iteration) 确定性派生，读取时可自校验。 */
export function resultBusEntryId(workspaceId: string, commandId: string, iteration: number): string {
  return createHash("sha256").update(JSON.stringify([workspaceId, commandId, iteration]), "utf8").digest("hex");
}

/** generic Web Sink binding stamp：reserve 时盖章的当前 Active Web Sink 身份。 */
export const resultBusSinkStampSchema = z.object({
  bindingId: endpointBindingIdSchema,
  epoch: endpointEpochSchema,
  boundAt: endpointInstantSchema,
}).strict();
export type ResultBusSinkStamp = z.infer<typeof resultBusSinkStampSchema>;

/** 发送前预约：reservationId 幂等引用 + 预约时 Active Web Sink binding stamp；不含 planner/principal/companion/executor 身份。 */
export const resultBusReservationSchema = resultBusSinkStampSchema.extend({
  reservationId: routingUuidSchema,
  reservedAt: endpointInstantSchema,
}).strict();
export type ResultBusReservation = z.infer<typeof resultBusReservationSchema>;

/** begin-send 后的发送尝试身份；attemptId 是 ack/outcome/retire 的幂等引用。 */
export const resultBusAttemptSchema = z.object({
  attemptId: routingUuidSchema,
  claimedAt: endpointInstantSchema,
  messageFormat: z.literal("signal-v1").optional(),
}).strict();
export type ResultBusAttempt = z.infer<typeof resultBusAttemptSchema>;

export const resultBusReasonCodeSchema = z.string().regex(REASON_CODE);
export type ResultBusReasonCode = z.infer<typeof resultBusReasonCodeSchema>;

const canonicalResultSchema = resultSchema.superRefine((value, ctx) => {
  if (!("rawSummary" in value) || !("machineEvidence" in value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Result Bus 只接受 canonical RoutingResult。" });
  }
});

const nullable = <T extends z.ZodTypeAny>(schema: T) => schema.nullable().optional();

export const resultBusEntrySchema = z.object({
  version: z.literal(1),
  lifecycle: z.literal("ephemeral").optional(),
  busEntryId: z.string().regex(HEX64),
  workspaceId: routingWorkspaceIdSchema,
  commandId: routingCommandIdSchema,
  iteration: z.number().int().positive(),
  resultId: routingUuidSchema,
  resultSha256: z.string().regex(HEX64),
  result: z.union([officialResultSchema, canonicalResultSchema]),
  createdAt: z.string().datetime(),
  deliveryStatus: resultBusLifecycleSchema,
  sendTarget: nullable(webSinkSendTargetSnapshotSchema),
  reservation: nullable(resultBusReservationSchema),
  attempt: nullable(resultBusAttemptSchema),
  observedAt: nullable(endpointInstantSchema),
  outcomeUnknownAt: nullable(endpointInstantSchema),
  retiredAt: nullable(endpointInstantSchema),
  outcomeReasonCode: nullable(resultBusReasonCodeSchema),
  cancelledAt: nullable(endpointInstantSchema),
  isolatedAt: nullable(endpointInstantSchema),
}).strict().superRefine((entry, ctx) => {
  const issue = (path: string[], message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  if (entry.result.commandId !== entry.commandId || entry.result.iteration !== entry.iteration || entry.result.resultId !== entry.resultId) {
    issue(["result"], "Result Bus entry 与 canonical result identity 不一致。");
  }
  if (entry.busEntryId !== resultBusEntryId(entry.workspaceId, entry.commandId, entry.iteration)) {
    issue(["busEntryId"], "busEntryId 与 (workspaceId, commandId, iteration) 派生值不一致。");
  }
  let expectedDigest: string | null = null;
  try {
    expectedDigest = resultBusResultDigest(entry.result);
  } catch {
    expectedDigest = null;
  }
  if (!expectedDigest || entry.resultSha256 !== expectedDigest) {
    issue(["resultSha256"], "resultSha256 与 embedded canonical result 不一致。");
  }
  if (entry.sendTarget && entry.sendTarget.workspaceId !== entry.workspaceId) {
    issue(["sendTarget"], "sendTarget.workspaceId 与 bus entry 不一致。");
  }

  // 每个 lifecycle 状态的精确 shape；拒绝跨状态残留字段。
  const hasReservation = entry.reservation != null;
  const hasAttempt = entry.attempt != null;
  const hasTarget = entry.sendTarget != null;
  const hasObservedAt = entry.observedAt != null;
  const hasOutcomeUnknownAt = entry.outcomeUnknownAt != null;
  const hasRetiredAt = entry.retiredAt != null;
  const hasReasonCode = entry.outcomeReasonCode != null;
  if ((entry.deliveryStatus === "cancelled") !== (entry.cancelledAt != null)) issue(["cancelledAt"], "只有 cancelled 必须保留取消时间。");
  if (entry.isolatedAt && !["outcome_unknown", "retired_unknown"].includes(entry.deliveryStatus))
    issue(["isolatedAt"], "只有未确认发送及其行政终态允许保留隔离标记。");
  switch (entry.deliveryStatus) {
    case "cancelled":
    case "queued":
      if (hasReservation || hasAttempt || hasTarget || hasObservedAt || hasOutcomeUnknownAt || hasRetiredAt || hasReasonCode) {
        issue(["deliveryStatus"], "queued 不得携带 reservation/attempt/sendTarget 或后续状态时间戳。");
      }
      break;
    case "reserved":
      if (!hasReservation) issue(["reservation"], "reserved 必须携带 reservation。");
      if (hasAttempt || hasTarget || hasObservedAt || hasOutcomeUnknownAt || hasRetiredAt || hasReasonCode) {
        issue(["deliveryStatus"], "reserved 不得携带 attempt/sendTarget 或后续状态时间戳。");
      }
      break;
    case "claimed":
      if (!hasReservation) issue(["reservation"], "claimed 必须携带 reservation。");
      if (!hasAttempt) issue(["attempt"], "claimed 必须携带 attempt。");
      if (!hasTarget) issue(["sendTarget"], "claimed 必须携带已冻结 sendTarget。");
      if (hasObservedAt || hasOutcomeUnknownAt || hasRetiredAt || hasReasonCode) {
        issue(["deliveryStatus"], "claimed 不得携带后续状态时间戳。");
      }
      break;
    case "observed":
      if (!hasReservation) issue(["reservation"], "observed 必须携带 reservation。");
      if (!hasAttempt) issue(["attempt"], "observed 必须携带 attempt。");
      if (!hasTarget) issue(["sendTarget"], "observed 必须保留已冻结 sendTarget。");
      if (!hasObservedAt) issue(["observedAt"], "observed 必须携带 observedAt。");
      if (hasOutcomeUnknownAt || hasRetiredAt || hasReasonCode) {
        issue(["deliveryStatus"], "observed 不得携带 outcome_unknown/retired 时间戳。");
      }
      break;
    case "outcome_unknown":
      if (!hasReservation) issue(["reservation"], "outcome_unknown 必须携带 reservation。");
      if (!hasAttempt) issue(["attempt"], "outcome_unknown 必须携带 attempt。");
      if (!hasTarget) issue(["sendTarget"], "outcome_unknown 必须保留已冻结 sendTarget。");
      if (!hasOutcomeUnknownAt) issue(["outcomeUnknownAt"], "outcome_unknown 必须携带 outcomeUnknownAt。");
      if (hasObservedAt || hasRetiredAt) {
        issue(["deliveryStatus"], "outcome_unknown 不得携带 observed/retired 时间戳。");
      }
      break;
    case "retired_unknown":
      if (!hasReservation) issue(["reservation"], "retired_unknown 必须携带 reservation。");
      if (!hasAttempt) issue(["attempt"], "retired_unknown 必须携带 attempt。");
      if (!hasTarget) issue(["sendTarget"], "retired_unknown 必须保留已冻结 sendTarget。");
      if (!hasOutcomeUnknownAt) issue(["outcomeUnknownAt"], "retired_unknown 必须保留 outcomeUnknownAt。");
      if (!hasRetiredAt) issue(["retiredAt"], "retired_unknown 必须携带 retiredAt。");
      if (hasObservedAt) {
        issue(["deliveryStatus"], "retired_unknown 不得携带 observedAt。");
      }
      break;
  }
  // 冻结 provenance：冻结 target 必须源自 reservation 盖章的同一 binding stamp。
  // reservation 刻意只存 bindingId/epoch/boundAt；canonicalUrl/pluginId/surfaceId 以冻结时的
  // sendTarget 为准，不参与此一致性检查。
  if (hasReservation && hasTarget) {
    if (entry.reservation!.bindingId !== entry.sendTarget!.bindingId) {
      issue(["sendTarget"], "冻结 sendTarget.bindingId 与 reservation 盖章不一致。");
    }
    if (entry.reservation!.epoch !== entry.sendTarget!.epoch) {
      issue(["sendTarget"], "冻结 sendTarget.epoch 与 reservation 盖章不一致。");
    }
  }
});

export const resultBusStateSchema = z.object({
  version: z.literal(1),
  workspaceId: routingWorkspaceIdSchema,
  workspaceRoot: z.string().min(1),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  entries: z.array(resultBusEntrySchema).max(10_000),
}).strict().superRefine((state, ctx) => {
  if (!path.isAbsolute(state.workspaceRoot)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workspaceRoot"], message: "workspaceRoot 必须是绝对路径。" });
  }
  const keys = new Set<string>();
  const ids = new Set<string>();
  let inFlight = 0;
  for (const entry of state.entries) {
    const key = `${entry.commandId}\u0000${entry.iteration}`;
    if (keys.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries"], message: "Result Bus command+iteration 重复。" });
    if (ids.has(entry.busEntryId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries"], message: "Result Bus busEntryId 重复。" });
    keys.add(key);
    ids.add(entry.busEntryId);
    if (entry.workspaceId !== state.workspaceId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries"], message: "entry workspaceId 与 state 不一致。" });
    // 持久化单飞不变量：reserved/claimed/outcome_unknown 同时至多一条；
    // observed/retired_unknown 是终态，不计入。
    if (isResultBusInFlight(entry)) {
      inFlight += 1;
    }
  }
  if (inFlight > 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries"], message: "Result Bus 单飞不变量被破坏：多个 in-flight entry。" });
  }
});

export type ResultBusLifecycle = z.infer<typeof resultBusLifecycleSchema>;
export type ResultBusEntry = z.infer<typeof resultBusEntrySchema>;
export type ResultBusState = z.infer<typeof resultBusStateSchema>;
export type CanonicalRoutingResult = Extract<RoutingResult, { rawSummary: string }>;
export type ResultBusResult = CanonicalRoutingResult | OfficialResult;

export function isCanonicalRoutingResult(result: RoutingResult): result is CanonicalRoutingResult {
  return "rawSummary" in result && "machineEvidence" in result;
}

/** Isolated unknown attempts retain evidence but occupy no send slot. */
export function isResultBusInFlight(entry: { deliveryStatus: string; isolatedAt?: string | null }): boolean {
  return entry.deliveryStatus === "reserved" || entry.deliveryStatus === "claimed" ||
    (entry.deliveryStatus === "outcome_unknown" && !entry.isolatedAt);
}
