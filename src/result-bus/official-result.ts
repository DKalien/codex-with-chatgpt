import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalRoutingResultDigest } from "../routing/execution-result-digest.js";
import { routingCommandIdSchema, routingUuidSchema, type RoutingResult } from "../routing/schema.js";

export const OFFICIAL_TESTS_UNKNOWN = "未判定：App Server turn 终态不证明测试通过";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const status = z.enum(["completed", "failed", "cancelled"]);

/** Official turn evidence is deliberately not a Desktop receipt or a test verdict. */
export const officialResultSchema = z.object({
  commandId: routingCommandIdSchema,
  iteration: z.literal(1),
  resultId: routingUuidSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  status,
  rawSummary: z.string().min(1).refine(value => Buffer.byteLength(value, "utf8") <= 8192),
  machineEvidence: z.object({
    version: z.literal(1),
    source: z.literal("codex_app_server"),
    hostId: z.literal("local"),
    targetId: routingUuidSchema,
    taskId: routingUuidSchema,
    threadId: id,
    turnId: id,
    status,
    observedAt: z.string().datetime(),
    changedFiles: z.array(z.string()).max(0),
    changedFilesCollected: z.literal(false),
    testsSummary: z.literal(OFFICIAL_TESTS_UNKNOWN),
    output: z.object({ outputId: z.number().int().positive().safe(), outputAvailable: z.boolean() }).strict().optional(),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.resultId !== value.machineEvidence.taskId || value.status !== value.machineEvidence.status ||
      value.createdAt !== value.machineEvidence.observedAt || value.updatedAt !== value.createdAt)
    ctx.addIssue({ code: "custom", message: "Official result and observed turn identity differ" });
});
export type OfficialResult = z.infer<typeof officialResultSchema>;

export function isOfficialResult(result: unknown): result is OfficialResult {
  return typeof result === "object" && result !== null && "machineEvidence" in result &&
    (result as { machineEvidence?: { source?: unknown } }).machineEvidence?.source === "codex_app_server";
}

/** Preserve the byte contract of every existing Desktop digest. */
export function resultBusResultDigest(result: RoutingResult | OfficialResult): string {
  if (!isOfficialResult(result)) return canonicalRoutingResultDigest(result);
  return createHash("sha256").update(JSON.stringify(officialResultSchema.parse(result)), "utf8").digest("hex");
}
