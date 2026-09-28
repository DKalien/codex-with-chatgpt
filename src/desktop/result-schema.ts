import { z } from "zod";
import { executionSummarySchema } from "../execution/records.js";
import type { ExecutionOutputMeta } from "../execution/output.js";
import { DesktopError, desktopId } from "./store.js";
import type { ReceiptFinalizationDraft } from "./receipt-finalizer-schema.js";
import type { DesktopResultOwnership } from "./ipc.js";

export interface DesktopResultWorkspace {
  id: string;
  root: string;
}

export const desktopResultInput = z.object({
  commandId: desktopId,
  changedFiles: z.array(z.string()),
  tests: z.string().refine(value => value.trim().length > 0, "tests 不能为空；未运行测试请填写 not run。"),
  exitStatus: z.enum(["ok", "failed", "blocked"]),
  notes: z.string().optional(),
  rawSummary: executionSummarySchema,
  command: z.string().optional(),
  output: z.string().optional(),
  exitCode: z.number().int().safe().optional(),
}).strict();

export type DesktopResultInput = z.infer<typeof desktopResultInput>;

export class DesktopResultError extends DesktopError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "DesktopResultError";
  }
}

export interface DesktopResultReceipt {
  record: import("../execution/records.js").StoredExecutionRecord;
  output: ExecutionOutputMeta | null;
}

/** inProgress 只允许进入 durable pending draft；它不是 trusted receipt。 */
export class DesktopResultPendingError extends DesktopResultError {
  readonly draft: ReceiptFinalizationDraft;
  constructor(draft: ReceiptFinalizationDraft) {
    super("DESKTOP_RESULT_FINALIZATION_PENDING", "Desktop turn 仍在执行；结果已暂存，等待终态核验后再决定是否回执。 ");
    this.name = "DesktopResultPendingError";
    this.draft = draft;
  }
}

export interface CurrentDesktopDelivery {
  commandId: string;
  threadId: string;
  turnId: string;
  ownership: DesktopResultOwnership;
}

export const uuid = z.string().uuid();
export const workspaceInput = z.object({ id: desktopId, root: z.string().min(1) });
export const RESULT_CONTEXT_ATTEMPTS = 3;
export const RESULT_CONTEXT_RETRY_DELAY_MS = 25;
