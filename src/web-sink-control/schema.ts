import { z } from "zod";
import {
  endpointPluginIdSchema,
  endpointWorkspaceIdSchema,
  endpointCanonicalUrlSchema,
  webSinkBindingSchema,
  type WebSinkBinding,
} from "../endpoints/schema.js";

/**
 * R5c Bridge-owned Active Web Sink Binding persisted state.
 * 只保存 generic Web Sink identity；不保存 planner/feedback/executor 产品字段。
 */
export const webSinkControlStateSchema = z
  .object({
    version: z.literal(1),
    workspaceId: endpointWorkspaceIdSchema,
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    activeBinding: webSinkBindingSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.activeBinding) {
      if (value.activeBinding.workspaceId !== value.workspaceId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["activeBinding", "workspaceId"], message: "activeBinding.workspaceId 与 state 不一致" });
      }
    }
  });
export type WebSinkControlState = z.infer<typeof webSinkControlStateSchema>;

export class WebSinkControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WebSinkControlError";
  }
}

export function parseWebSinkControlState(input: unknown): WebSinkControlState {
  const parsed = webSinkControlStateSchema.safeParse(input);
  if (!parsed.success) {
    throw new WebSinkControlError("WEB_SINK_STATE_CORRUPT", "active web sink binding 状态损坏；拒绝静默修复。");
  }
  return parsed.data;
}

export type WebSinkAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reasonCode: string; readonly message: string };

export interface WebSinkPluginSummary {
  readonly pluginId: string;
  readonly surfaceId: string;
  readonly name: string;
  readonly capabilities: Readonly<Record<string, boolean>>;
}

export interface WebSinkStatusProjection {
  readonly workspaceId: string;
  readonly activeBinding: WebSinkBinding | null;
  readonly plugins: readonly WebSinkPluginSummary[];
  readonly availability: WebSinkAvailability;
}

export function isSameWebSinkCandidate(
  a: Pick<WebSinkBinding, "pluginId" | "surfaceId" | "workspaceId" | "canonicalUrl">,
  b: Pick<WebSinkBinding, "pluginId" | "surfaceId" | "workspaceId" | "canonicalUrl">,
): boolean {
  return (
    a.pluginId === b.pluginId &&
    a.surfaceId === b.surfaceId &&
    a.workspaceId === b.workspaceId &&
    a.canonicalUrl === b.canonicalUrl
  );
}

export const WEB_SINK_PLUGIN_ID = "browser-companion";
export const WEB_SINK_SURFACE_ID = "chatgpt-web";
