import { z } from "zod";
import {
  endpointWorkspaceRootSchema,
  executorDeliveryTargetSnapshotSchema,
} from "../endpoints/schema.js";

/**
 * R5e Executor Dispatch Ledger schema（Bridge-owned durable target-pin 账本）。
 *
 * 约束：
 * - identity 字段（intent/payloadBytes/payloadSha256/requestAuthoritySha256）
 *   在本模块本地 bounded 定义；零 routing import，保持 fence 友好。
 * - entry.target 直接复用 generic executorDeliveryTargetSnapshotSchema：
 *   delivery 一旦开始，target 是不可变冻结快照。
 * - 不含任何外层身份 / URL / 路由字段；identity 只保留有界摘要。
 */

export const EXECUTOR_DISPATCH_MAX_ENTRIES = 10000;

/** bounded commandId：与 routing 层正交，本模块自有校验（≤128 safe chars）。 */
export const EXECUTOR_DISPATCH_COMMAND_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const BOUNDED_CODE = /^[A-Za-z0-9_.:-]{1,128}$/;

export class ExecutorDispatchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ExecutorDispatchError";
  }
}

/** Executor Command 的投递意图（与 routing intent 语义一致的本地枚举）。 */
export const executorDispatchIntentSchema = z.enum(["development_plan", "revision"]);
export type ExecutorDispatchIntent = z.infer<typeof executorDispatchIntentSchema>;

/** send-start 生命周期状态；"started" 表示 target 已 pin 但尚未到达 terminal。 */
export const executorDispatchStatusSchema = z.enum([
  "started",
  "accepted",
  "rejected",
  "outcome_unknown",
]);
export type ExecutorDispatchStatus = z.infer<typeof executorDispatchStatusSchema>;

export const executorDispatchEntrySchema = z
  .object({
    version: z.literal(1),
    commandId: z.string().regex(EXECUTOR_DISPATCH_COMMAND_ID),
    /** Only new command-cleanup-enabled pins opt in; missing remains legacy. */
    lifecycle: z.literal("ephemeral").optional(),
    dispatchGenerationId: z.string().uuid().optional(),
    intent: executorDispatchIntentSchema,
    payloadBytes: z.number().int().min(1),
    payloadSha256: z.string().regex(HEX64),
    requestAuthoritySha256: z.string().regex(HEX64),
    target: executorDeliveryTargetSnapshotSchema,
    deliveryStatus: executorDispatchStatusSchema,
    /** R5E_DISPATCH_OWNER：pin 时写入的 dispatcher 进程 owner identity（内部字段，不进 MCP DTO）。 */
    ownerId: z.string().regex(BOUNDED_CODE).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    startedAt: z.string().datetime(),
    deliveryId: z.string().max(256).optional(),
    errorCode: z.string().regex(BOUNDED_CODE).optional(),
    terminalAt: z.string().datetime().optional(),
    outcomeReasonCode: z.string().regex(BOUNDED_CODE).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if ((entry.lifecycle === "ephemeral") !== (entry.dispatchGenerationId !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dispatchGenerationId"],
        message: "ephemeral lifecycle entry 必须且只能携带 dispatchGenerationId。",
      });
    }
    // R5E_DISPATCH_STORE_HARDENING + D：拒绝不可能的生命周期元数据组合。
    if (entry.deliveryStatus === "started") {
      const forbidden = [
        ["terminalAt", entry.terminalAt],
        ["outcomeReasonCode", entry.outcomeReasonCode],
        ["deliveryId", entry.deliveryId],
        ["errorCode", entry.errorCode],
      ] as const;
      for (const [field, value] of forbidden) {
        if (value !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `started entry 不得携带 ${field}（terminal 残留）。`,
          });
        }
      }
      return;
    }
    // terminal 状态必须有 terminalAt。
    if (entry.terminalAt === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["terminalAt"],
        message: `terminal 状态 ${entry.deliveryStatus} 必须携带 terminalAt。`,
      });
    }
    // accepted 是成功终态：不得携带 outcomeReasonCode（那是 outcome_unknown 专属）。
    if (entry.deliveryStatus === "accepted" && entry.outcomeReasonCode !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcomeReasonCode"],
        message: "accepted entry 不得携带 outcomeReasonCode。",
      });
    }
    // outcome_unknown 必须携带有界 outcomeReasonCode。
    if (entry.deliveryStatus === "outcome_unknown" && entry.outcomeReasonCode === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcomeReasonCode"],
        message: "outcome_unknown entry 必须携带有界 outcomeReasonCode。",
      });
    }
  });
export type ExecutorDispatchEntry = z.infer<typeof executorDispatchEntrySchema>;

export const executorDispatchStateSchema = z
  .object({
    version: z.literal(1),
    workspaceId: z.string().regex(/^[a-f0-9]{12}$/),
    workspaceRoot: endpointWorkspaceRootSchema,
    revision: z.number().int().min(1),
    entries: z.array(executorDispatchEntrySchema).max(EXECUTOR_DISPATCH_MAX_ENTRIES),
  })
  .strict()
  .superRefine((state, ctx) => {
    // R5E_DISPATCH_STORE_HARDENING：duplicate commandId 与 target/workspace 漂移 fail closed。
    const seen = new Set<string>();
    state.entries.forEach((entry, index) => {
      if (seen.has(entry.commandId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", index, "commandId"],
          message: `duplicate commandId=${entry.commandId}；ledger 拒绝重复条目。`,
        });
      }
      seen.add(entry.commandId);
      if (entry.target.workspaceId !== state.workspaceId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", index, "target", "workspaceId"],
          message: "entry.target.workspaceId 与 state.workspaceId 不一致（workspace 漂移）。",
        });
      }
      if (entry.target.workspaceRoot !== state.workspaceRoot) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", index, "target", "workspaceRoot"],
          message: "entry.target.workspaceRoot 与 state.workspaceRoot 不一致（workspace 漂移）。",
        });
      }
    });
  });
export type ExecutorDispatchState = z.infer<typeof executorDispatchStateSchema>;

export function parseExecutorDispatchEntry(input: unknown): ExecutorDispatchEntry {
  const parsed = executorDispatchEntrySchema.safeParse(input);
  if (!parsed.success) {
    throw new ExecutorDispatchError(
      "EXECUTOR_DISPATCH_ENTRY_INVALID",
      parsed.error.issues.map(i => i.message).join("; "),
    );
  }
  return parsed.data;
}

export function parseExecutorDispatchState(input: unknown): ExecutorDispatchState {
  const parsed = executorDispatchStateSchema.safeParse(input);
  if (!parsed.success) {
    throw new ExecutorDispatchError(
      "EXECUTOR_DISPATCH_STATE_CORRUPT",
      parsed.error.issues.map(i => i.message).join("; "),
    );
  }
  return parsed.data;
}
