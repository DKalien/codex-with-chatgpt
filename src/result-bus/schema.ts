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
import { canonicalRoutingResultDigest } from "../routing/execution-result-digest.js";
import { webSinkSendTargetSnapshotSchema } from "../endpoints/schema.js";

const HEX64 = /^[a-f0-9]{64}$/;

/**
 * 投递 lifecycle 冻结契约（R5d1）：
 * - queued/reserved：均未冻结投递目的地，sendTarget 必须为 null。
 * - send 发起（reserved → claimed 迁移）是冻结边界：此刻冻结精确的 generic WebSinkSendTargetSnapshot。
 * - claimed/observed/outcome_unknown/retired_unknown：sendTarget 必须保留且不可消失、不可改指。
 * 不设 "sending"：冻结边界唯一（reserved → claimed），冻结语义只有一个。
 * R5d1 只冻结持久化契约；任何投递状态迁移 API 都不属于本模块。
 */
export const resultBusLifecycleSchema = z.enum([
  "queued",
  "reserved",
  "claimed",
  "observed",
  "outcome_unknown",
  "retired_unknown",
]);

/** Bus entry 持久化身份：由 (workspaceId, commandId, iteration) 确定性派生，读取时可自校验。 */
export function resultBusEntryId(workspaceId: string, commandId: string, iteration: number): string {
  return createHash("sha256").update(JSON.stringify([workspaceId, commandId, iteration]), "utf8").digest("hex");
}

const canonicalResultSchema = resultSchema.superRefine((value, ctx) => {
  if (!("rawSummary" in value) || !("machineEvidence" in value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Result Bus 只接受 canonical RoutingResult。" });
  }
});

export const resultBusEntrySchema = z.object({
  version: z.literal(1),
  busEntryId: z.string().regex(HEX64),
  workspaceId: routingWorkspaceIdSchema,
  commandId: routingCommandIdSchema,
  iteration: z.number().int().positive(),
  resultId: routingUuidSchema,
  resultSha256: z.string().regex(HEX64),
  result: canonicalResultSchema,
  createdAt: z.string().datetime(),
  deliveryStatus: resultBusLifecycleSchema,
  sendTarget: webSinkSendTargetSnapshotSchema.nullable(),
}).strict().superRefine((entry, ctx) => {
  if (entry.result.commandId !== entry.commandId || entry.result.iteration !== entry.iteration || entry.result.resultId !== entry.resultId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["result"], message: "Result Bus entry 与 canonical result identity 不一致。" });
  }
  if (entry.busEntryId !== resultBusEntryId(entry.workspaceId, entry.commandId, entry.iteration)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["busEntryId"], message: "busEntryId 与 (workspaceId, commandId, iteration) 派生值不一致。" });
  }
  let expectedDigest: string | null = null;
  try {
    expectedDigest = canonicalRoutingResultDigest(entry.result);
  } catch {
    expectedDigest = null;
  }
  if (!expectedDigest || entry.resultSha256 !== expectedDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["resultSha256"], message: "resultSha256 与 embedded canonical result 不一致。" });
  }
  const frozenStatus = entry.deliveryStatus !== "queued" && entry.deliveryStatus !== "reserved";
  if (frozenStatus && !entry.sendTarget) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sendTarget"], message: "目的地冻结后的 lifecycle 状态必须保留 sendTarget。" });
  }
  if (!frozenStatus && entry.sendTarget) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sendTarget"], message: "queued/reserved 尚未冻结投递目的地，sendTarget 必须为 null。" });
  }
  if (entry.sendTarget && entry.sendTarget.workspaceId !== entry.workspaceId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sendTarget"], message: "sendTarget.workspaceId 与 bus entry 不一致。" });
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
  for (const entry of state.entries) {
    const key = `${entry.commandId}\u0000${entry.iteration}`;
    if (keys.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries"], message: "Result Bus command+iteration 重复。" });
    if (ids.has(entry.busEntryId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries"], message: "Result Bus busEntryId 重复。" });
    keys.add(key);
    ids.add(entry.busEntryId);
    if (entry.workspaceId !== state.workspaceId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries"], message: "entry workspaceId 与 state 不一致。" });
  }
});

export type ResultBusLifecycle = z.infer<typeof resultBusLifecycleSchema>;
export type ResultBusEntry = z.infer<typeof resultBusEntrySchema>;
export type ResultBusState = z.infer<typeof resultBusStateSchema>;
export type CanonicalRoutingResult = Extract<RoutingResult, { rawSummary: string }>;

export function isCanonicalRoutingResult(result: RoutingResult): result is CanonicalRoutingResult {
  return "rawSummary" in result && "machineEvidence" in result;
}
