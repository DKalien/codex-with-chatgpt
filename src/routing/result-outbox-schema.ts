import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  resultStatusSchema,
  routingCommandIdSchema,
  routingUuidSchema,
  routingWorkspaceIdSchema,
} from "./schema.js";

const HEX64 = /^[a-f0-9]{64}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

export const resultOutboxEntryId = (workspaceId: string, commandId: string, iteration: number): string =>
  createHash("sha256").update(JSON.stringify([workspaceId, commandId, iteration]), "utf8").digest("hex");

export const resultOutboxEntrySchema = z.object({
  version: z.literal(1),
  outboxEntryId: z.string().regex(HEX64),
  workspaceId: routingWorkspaceIdSchema,
  plannerRouteId: routingUuidSchema,
  commandId: routingCommandIdSchema,
  resultId: routingUuidSchema,
  executorRouteId: routingUuidSchema,
  iteration: z.number().int().positive(),
  status: resultStatusSchema,
  resultSha256: z.string().regex(HEX64),
  createdAt: z.string().datetime(),
  deliveryStatus: z.literal("pending"),
}).strict().superRefine((entry, ctx) => {
  if (entry.outboxEntryId !== resultOutboxEntryId(entry.workspaceId, entry.commandId, entry.iteration)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "outboxEntryId 与 workspace/command/iteration 不一致" });
  }
});

export const resultOutboxReconciliationNeededSchema = z.object({
  commandId: routingCommandIdSchema,
  reasonCode: z.string().regex(SAFE_CODE),
  createdAt: z.string().datetime(),
}).strict();

export const resultOutboxStateSchema = z.object({
  version: z.literal(1),
  workspaceId: routingWorkspaceIdSchema,
  workspaceRoot: z.string().min(1),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  entries: z.array(resultOutboxEntrySchema).max(10_000),
}).strict().superRefine((state, ctx) => {
  if (!path.isAbsolute(state.workspaceRoot)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workspaceRoot"], message: "workspaceRoot 必须是绝对路径" });
  }
  const entryIds = new Set<string>();
  const entryKeys = new Set<string>();
  for (const entry of state.entries) {
    if (entry.workspaceId !== state.workspaceId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries"], message: "entry workspaceId 与 state 不匹配" });
    }
    if (entryIds.has(entry.outboxEntryId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries"], message: "outboxEntryId 重复" });
    }
    entryIds.add(entry.outboxEntryId);
    const key = `${entry.commandId}\u0000${entry.iteration}`;
    if (entryKeys.has(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries"], message: "(commandId, iteration) 重复" });
    }
    entryKeys.add(key);
  }
});

export const resultReconciliationQueueSchema = z.object({
  version: z.literal(1),
  workspaceId: routingWorkspaceIdSchema,
  workspaceRoot: z.string().min(1),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  entries: z.array(resultOutboxReconciliationNeededSchema).max(10_000),
}).strict().superRefine((state, ctx) => {
  if (!path.isAbsolute(state.workspaceRoot)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workspaceRoot"], message: "workspaceRoot 必须是绝对路径" });
  }
  const issueCommands = new Set<string>();
  for (const issue of state.entries) {
    if (issueCommands.has(issue.commandId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries"], message: "commandId 重复" });
    }
    issueCommands.add(issue.commandId);
  }
});

export type ResultOutboxEntry = z.infer<typeof resultOutboxEntrySchema>;
export type ResultOutboxReconciliationNeeded = z.infer<typeof resultOutboxReconciliationNeededSchema>;
export type ResultOutboxState = z.infer<typeof resultOutboxStateSchema>;
export type ResultReconciliationQueue = z.infer<typeof resultReconciliationQueueSchema>;
export type ResultOutboxReconciliationInput = Pick<ResultOutboxReconciliationNeeded, "commandId" | "reasonCode">;
