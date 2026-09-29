import { z } from "zod";
import {
  endpointWorkspaceIdSchema,
  executorBindingSchema,
  endpointWorkspaceRootSchema,
} from "../endpoints/schema.js";

/**
 * R5b Bridge-owned Active Executor Binding persisted state.
 * 只保存 generic binding；不保存产品字段名。
 */
export const executorControlStateSchema = z
  .object({
    version: z.literal(1),
    workspaceId: endpointWorkspaceIdSchema,
    workspaceRoot: endpointWorkspaceRootSchema,
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    activeBinding: executorBindingSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.activeBinding) {
      if (value.activeBinding.workspaceId !== value.workspaceId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["activeBinding", "workspaceId"], message: "activeBinding.workspaceId 与 state 不一致" });
      }
      if (value.activeBinding.workspaceRoot !== value.workspaceRoot) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["activeBinding", "workspaceRoot"], message: "activeBinding.workspaceRoot 与 state 不一致" });
      }
    }
  });
export type ExecutorControlState = z.infer<typeof executorControlStateSchema>;

export class ExecutorControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ExecutorControlError";
  }
}

/** 与 production Desktop send 相同的正文上限（UTF-8 bytes）。 */
export const EXECUTOR_MESSAGE_MAX_BYTES = 64 * 1024;

/** Implementation-neutral bounded executor message。 */
export const executorMessageSchema = z
  .string()
  .min(1)
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= EXECUTOR_MESSAGE_MAX_BYTES,
    { message: "正文超过 64 KiB UTF-8 上限；拒绝投递，不截断。" },
  )
  .refine(
    (value) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value),
    { message: "正文包含无效 Unicode。" },
  );

export function parseExecutorControlState(input: unknown): ExecutorControlState {
  const parsed = executorControlStateSchema.safeParse(input);
  if (!parsed.success) {
    throw new ExecutorControlError(
      "EXECUTOR_CONTROL_STATE_CORRUPT",
      "active executor binding 状态损坏；拒绝静默修复。",
    );
  }
  return parsed.data;
}

export type ExecutorAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reasonCode: string; readonly message: string };

export interface ExecutorPluginSummary {
  readonly pluginId: string;
  readonly kind: string;
  readonly name: string;
  readonly capabilities: Readonly<Record<string, boolean>>;
}

export interface ExecutorStatusProjection {
  readonly workspaceId: string;
  readonly activeBinding: import("../endpoints/schema.js").ExecutorBinding | null;
  readonly plugins: readonly ExecutorPluginSummary[];
  readonly availability: ExecutorAvailability;
}

export function isSameExecutorCandidate(
  a: Pick<import("../endpoints/schema.js").ExecutorBinding, "pluginId" | "workspaceId" | "workspaceRoot" | "instanceId" | "sessionId" | "locator">,
  b: Pick<import("../endpoints/schema.js").ExecutorBinding, "pluginId" | "workspaceId" | "workspaceRoot" | "instanceId" | "sessionId" | "locator">,
): boolean {
  if (
    a.pluginId !== b.pluginId ||
    a.workspaceId !== b.workspaceId ||
    a.workspaceRoot !== b.workspaceRoot ||
    a.instanceId !== b.instanceId ||
    a.sessionId !== b.sessionId
  ) {
    return false;
  }
  const ak = Object.keys(a.locator).sort();
  const bk = Object.keys(b.locator).sort();
  if (ak.length !== bk.length) return false;
  return ak.every((key, index) => key === bk[index] && a.locator[key] === b.locator[key]);
}
