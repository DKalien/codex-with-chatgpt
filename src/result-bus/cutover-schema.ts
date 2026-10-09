import path from "node:path";
import { z } from "zod";
import { routingWorkspaceIdSchema } from "../routing/schema.js";

import { HEX64 } from "../core/hex.js";
/** legacy Feedback eventId 是 32-hex；ledger 只记录迁移身份。 */
const HEX32 = /^[a-f0-9]{32}$/;

/**
 * R5d3 cutover disposition：Bridge-owned 迁移台账，只记录历史 legacy canonical
 * 投递的终局处置，不携带 planner/principal 身份，也不是通用 Bus 投递元数据。
 * - legacy_observed：历史 canonical Feedback（含 pre-R4c exact legacy）已 observed → 永久抑制；
 * - legacy_retired：历史 canonical Feedback 已 retired_unknown → 永久抑制；
 * - legacy_unbegun_bus_owned：历史 ready/queued 从未 begin-send → cutover 后该旧事件
 *   永久不可经 legacy 路径预约，未来投递归 Result Bus 所有（exactly once）。
 */
export const resultBusCutoverDispositionSchema = z.enum([
  "legacy_observed",
  "legacy_retired",
  "legacy_unbegun_bus_owned",
]);
export type ResultBusCutoverDisposition = z.infer<typeof resultBusCutoverDispositionSchema>;

export const resultBusCutoverEntrySchema = z.object({
  busEntryId: z.string().regex(HEX64),
  resultSha256: z.string().regex(HEX64),
  legacyEventId: z.string().regex(HEX32),
  disposition: resultBusCutoverDispositionSchema,
  recordedAt: z.string().datetime(),
}).strict();
export type ResultBusCutoverEntry = z.infer<typeof resultBusCutoverEntrySchema>;

export const resultBusCutoverStateSchema = z.object({
  version: z.literal(1),
  workspaceId: routingWorkspaceIdSchema,
  workspaceRoot: z.string().min(1),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  entries: z.array(resultBusCutoverEntrySchema).max(10_000),
}).strict().superRefine((state, ctx) => {
  if (!path.isAbsolute(state.workspaceRoot)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workspaceRoot"], message: "workspaceRoot 必须是绝对路径。" });
  }
  const ids = new Set<string>();
  for (const entry of state.entries) {
    if (ids.has(entry.busEntryId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries"], message: "cutover ledger busEntryId 重复。" });
    }
    ids.add(entry.busEntryId);
  }
});

export type ResultBusCutoverState = z.infer<typeof resultBusCutoverStateSchema>;
