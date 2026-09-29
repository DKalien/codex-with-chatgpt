import path from "node:path";
import { z } from "zod";

/**
 * Generic Endpoint Core — implementation-neutral identity & binding schema.
 *
 * 约束：
 * - 不出现具体产品/线程/主机/项目字段名。
 * - 不 import desktop / feedback / browser-companion / mcp / cli / remote。
 * - locator 是 bounded string map；sessionId/instanceId 是 opaque identity（不必 UUID）。
 * - 一律 strict + fail closed；不接受无界 unknown JSON。
 * - Bridge 拥有 bindingId/epoch/boundAt；plugin 只发现 session candidate。
 */

/** Endpoint / Plugin / Binding 共用 safe ID（字母数字 + _-）。 */
export const ENDPOINT_SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Workspace.id = sha256(root)[:12]。 */
export const WORKSPACE_ID = /^[a-f0-9]{12}$/;
/** 通用 opaque identity；允许非 UUID 会话/实例标识。 */
export const OPAQUE_IDENTITY = /^[A-Za-z0-9_.:-]{1,128}$/;

export const LOCATOR_MAX_KEYS = 8;
export const LOCATOR_KEY = /^[A-Za-z0-9_-]{1,64}$/;
export const LOCATOR_VALUE_MAX = 256;
export const CANONICAL_URL_MAX = 2048;
export const EPOCH_MAX = 2_147_483_647;
export const EVIDENCE_DETAIL_MAX = 1024;
export const REASON_TEXT_MAX = 256;
export const DESCRIPTOR_NAME_MAX = 128;

export class EndpointSchemaError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EndpointSchemaError";
  }
}

export function isEndpointSafeId(value: unknown): value is string {
  return typeof value === "string" && ENDPOINT_SAFE_ID.test(value);
}

export function isOpaqueIdentity(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_IDENTITY.test(value);
}

export const endpointPluginIdSchema = z.string().regex(ENDPOINT_SAFE_ID);
export const endpointBindingIdSchema = z.string().regex(ENDPOINT_SAFE_ID);
export const endpointWorkspaceIdSchema = z.string().regex(WORKSPACE_ID);
export const endpointWorkspaceRootSchema = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value), { message: "workspaceRoot 必须是绝对路径" });
export const opaqueIdentitySchema = z.string().regex(OPAQUE_IDENTITY);
export const endpointEpochSchema = z.number().int().min(1).max(EPOCH_MAX);
export const endpointInstantSchema = z.string().datetime();
export const endpointReasonTextSchema = z.string().max(REASON_TEXT_MAX);

/** bounded string map：有限 key、safe ID key、有上限 value。 */
export const endpointLocatorSchema = z
  .record(z.string().regex(LOCATOR_KEY), z.string().min(1).max(LOCATOR_VALUE_MAX))
  .refine(
    (value) => Object.keys(value).length <= LOCATOR_MAX_KEYS,
    { message: `locator key 数量不得超过 ${LOCATOR_MAX_KEYS}` },
  );
export type EndpointLocator = z.infer<typeof endpointLocatorSchema>;

/** locator 结构化精确相等（非子串/模糊比较）。 */
export function locatorExactEqual(a: EndpointLocator, b: EndpointLocator): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let index = 0; index < aKeys.length; index += 1) {
    if (aKeys[index] !== bKeys[index]) return false;
    if (a[aKeys[index]] !== b[bKeys[index]]) return false;
  }
  return true;
}

function isBoundedHttpsUrl(value: string): boolean {
  if (value.length === 0 || value.length > CANONICAL_URL_MAX) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.hostname.length > 0;
}

export const endpointCanonicalUrlSchema = z
  .string()
  .max(CANONICAL_URL_MAX)
  .refine(isBoundedHttpsUrl, { message: "canonicalUrl 必须是有界 HTTPS URL" });

/**
 * Plugin 发现的 executor session candidate。
 * 不含 Bridge binding 元数据（bindingId/epoch/boundAt）。
 */
export const executorBindingCandidateSchema = z
  .object({
    pluginId: endpointPluginIdSchema,
    workspaceId: endpointWorkspaceIdSchema,
    workspaceRoot: endpointWorkspaceRootSchema,
    instanceId: opaqueIdentitySchema,
    sessionId: opaqueIdentitySchema,
    locator: endpointLocatorSchema,
  })
  .strict();
export type ExecutorBindingCandidate = z.infer<typeof executorBindingCandidateSchema>;

/**
 * Generic Executor Binding。
 * bindingId/epoch/boundAt 由 Bridge 在 candidate 上盖章；plugin 不得铸造。
 */
export const executorBindingSchema = z
  .object({
    version: z.literal(1),
    bindingId: endpointBindingIdSchema,
    pluginId: endpointPluginIdSchema,
    workspaceId: endpointWorkspaceIdSchema,
    workspaceRoot: endpointWorkspaceRootSchema,
    instanceId: opaqueIdentitySchema,
    sessionId: opaqueIdentitySchema,
    locator: endpointLocatorSchema,
    epoch: endpointEpochSchema,
    boundAt: endpointInstantSchema,
  })
  .strict();
export type ExecutorBinding = z.infer<typeof executorBindingSchema>;

/** Bridge 拥有的 binding 元数据。 */
export const executorBindingStampSchema = z
  .object({
    bindingId: endpointBindingIdSchema,
    epoch: endpointEpochSchema,
    boundAt: endpointInstantSchema,
  })
  .strict();
export type ExecutorBindingStamp = z.infer<typeof executorBindingStampSchema>;

/**
 * Plugin 发现的 web sink session candidate。
 * 不含 Bridge binding 元数据。
 */
export const webSinkBindingCandidateSchema = z
  .object({
    pluginId: endpointPluginIdSchema,
    surfaceId: endpointPluginIdSchema,
    workspaceId: endpointWorkspaceIdSchema,
    canonicalUrl: endpointCanonicalUrlSchema,
  })
  .strict();
export type WebSinkBindingCandidate = z.infer<typeof webSinkBindingCandidateSchema>;

/**
 * Generic Web Sink Binding。
 * 不包含 planner route、conversation principal 或 executor identity。
 */
export const webSinkBindingSchema = z
  .object({
    version: z.literal(1),
    bindingId: endpointBindingIdSchema,
    pluginId: endpointPluginIdSchema,
    surfaceId: endpointPluginIdSchema,
    workspaceId: endpointWorkspaceIdSchema,
    canonicalUrl: endpointCanonicalUrlSchema,
    epoch: endpointEpochSchema,
    boundAt: endpointInstantSchema,
  })
  .strict();
export type WebSinkBinding = z.infer<typeof webSinkBindingSchema>;

export const webSinkBindingStampSchema = z
  .object({
    bindingId: endpointBindingIdSchema,
    epoch: endpointEpochSchema,
    boundAt: endpointInstantSchema,
  })
  .strict();
export type WebSinkBindingStamp = z.infer<typeof webSinkBindingStampSchema>;

/**
 * Executor delivery 一旦开始后的不可变 target snapshot。
 * 后续 executor 切换不得改变已 snapshot 的目标。
 */
export const executorDeliveryTargetSnapshotSchema = z
  .object({
    version: z.literal(1),
    bindingId: endpointBindingIdSchema,
    pluginId: endpointPluginIdSchema,
    workspaceId: endpointWorkspaceIdSchema,
    workspaceRoot: endpointWorkspaceRootSchema,
    instanceId: opaqueIdentitySchema,
    sessionId: opaqueIdentitySchema,
    locator: endpointLocatorSchema,
    epoch: endpointEpochSchema,
    frozenAt: endpointInstantSchema,
  })
  .strict();
export type ExecutorDeliveryTargetSnapshot = z.infer<typeof executorDeliveryTargetSnapshotSchema>;

/** Web Sink begin-send 后冻结 workspace+URL/epoch；禁止 outcome_unknown 自动改发新 URL。 */
export const webSinkSendTargetSnapshotSchema = z
  .object({
    version: z.literal(1),
    bindingId: endpointBindingIdSchema,
    pluginId: endpointPluginIdSchema,
    surfaceId: endpointPluginIdSchema,
    workspaceId: endpointWorkspaceIdSchema,
    canonicalUrl: endpointCanonicalUrlSchema,
    epoch: endpointEpochSchema,
    frozenAt: endpointInstantSchema,
  })
  .strict();
export type WebSinkSendTargetSnapshot = z.infer<typeof webSinkSendTargetSnapshotSchema>;

/** Runtime-strict execution evidence。 */
export const executorExecutionEvidenceSchema = z
  .object({
    evidenceId: opaqueIdentitySchema,
    pluginId: endpointPluginIdSchema,
    kind: z.string().regex(ENDPOINT_SAFE_ID),
    createdAt: endpointInstantSchema,
    trusted: z.boolean(),
    detail: z.string().max(EVIDENCE_DETAIL_MAX).optional(),
  })
  .strict();
export type ExecutorExecutionEvidenceRecord = z.infer<typeof executorExecutionEvidenceSchema>;

export function parseExecutorBindingCandidate(input: unknown): ExecutorBindingCandidate {
  const parsed = executorBindingCandidateSchema.safeParse(input);
  if (!parsed.success) {
    throw new EndpointSchemaError("EXECUTOR_BINDING_CANDIDATE_INVALID", parsed.error.issues.map(i => i.message).join("; "));
  }
  return parsed.data;
}

export function parseExecutorBinding(input: unknown): ExecutorBinding {
  const parsed = executorBindingSchema.safeParse(input);
  if (!parsed.success) {
    throw new EndpointSchemaError("EXECUTOR_BINDING_INVALID", parsed.error.issues.map(i => i.message).join("; "));
  }
  return parsed.data;
}

export function parseWebSinkBindingCandidate(input: unknown): WebSinkBindingCandidate {
  const parsed = webSinkBindingCandidateSchema.safeParse(input);
  if (!parsed.success) {
    throw new EndpointSchemaError("WEB_SINK_BINDING_CANDIDATE_INVALID", parsed.error.issues.map(i => i.message).join("; "));
  }
  return parsed.data;
}

export function parseWebSinkBinding(input: unknown): WebSinkBinding {
  const parsed = webSinkBindingSchema.safeParse(input);
  if (!parsed.success) {
    throw new EndpointSchemaError("WEB_SINK_BINDING_INVALID", parsed.error.issues.map(i => i.message).join("; "));
  }
  return parsed.data;
}

export function parseExecutorDeliveryTargetSnapshot(input: unknown): ExecutorDeliveryTargetSnapshot {
  const parsed = executorDeliveryTargetSnapshotSchema.safeParse(input);
  if (!parsed.success) {
    throw new EndpointSchemaError("DELIVERY_TARGET_SNAPSHOT_INVALID", parsed.error.issues.map(i => i.message).join("; "));
  }
  return parsed.data;
}

export function parseWebSinkSendTargetSnapshot(input: unknown): WebSinkSendTargetSnapshot {
  const parsed = webSinkSendTargetSnapshotSchema.safeParse(input);
  if (!parsed.success) {
    throw new EndpointSchemaError("WEB_SINK_SEND_SNAPSHOT_INVALID", parsed.error.issues.map(i => i.message).join("; "));
  }
  return parsed.data;
}

export function parseExecutorExecutionEvidence(input: unknown): ExecutorExecutionEvidenceRecord {
  const parsed = executorExecutionEvidenceSchema.safeParse(input);
  if (!parsed.success) {
    throw new EndpointSchemaError("EXECUTION_EVIDENCE_INVALID", parsed.error.issues.map(i => i.message).join("; "));
  }
  return parsed.data;
}

/**
 * Bridge 盖章：candidate + Bridge-owned binding metadata → ExecutorBinding。
 * 纯函数，无持久化。
 */
export function createExecutorBinding(
  candidate: ExecutorBindingCandidate,
  stamp: ExecutorBindingStamp,
): ExecutorBinding {
  return parseExecutorBinding({
    version: 1,
    bindingId: stamp.bindingId,
    pluginId: candidate.pluginId,
    workspaceId: candidate.workspaceId,
    workspaceRoot: candidate.workspaceRoot,
    instanceId: candidate.instanceId,
    sessionId: candidate.sessionId,
    locator: candidate.locator,
    epoch: stamp.epoch,
    boundAt: stamp.boundAt,
  });
}

/** Bridge 盖章：web sink candidate + binding metadata → WebSinkBinding。 */
export function createWebSinkBinding(
  candidate: WebSinkBindingCandidate,
  stamp: WebSinkBindingStamp,
): WebSinkBinding {
  return parseWebSinkBinding({
    version: 1,
    bindingId: stamp.bindingId,
    pluginId: candidate.pluginId,
    surfaceId: candidate.surfaceId,
    workspaceId: candidate.workspaceId,
    canonicalUrl: candidate.canonicalUrl,
    epoch: stamp.epoch,
    boundAt: stamp.boundAt,
  });
}

/** Binding → delivery snapshot：复制 identity 并冻结时间。 */
export function freezeExecutorDeliveryTarget(
  binding: ExecutorBinding,
  frozenAt: string = new Date().toISOString(),
): ExecutorDeliveryTargetSnapshot {
  return parseExecutorDeliveryTargetSnapshot({
    version: 1,
    bindingId: binding.bindingId,
    pluginId: binding.pluginId,
    workspaceId: binding.workspaceId,
    workspaceRoot: binding.workspaceRoot,
    instanceId: binding.instanceId,
    sessionId: binding.sessionId,
    locator: binding.locator,
    epoch: binding.epoch,
    frozenAt,
  });
}

/** Web Sink binding → send snapshot：冻结 workspace + URL/epoch。 */
export function freezeWebSinkSendTarget(
  binding: WebSinkBinding,
  frozenAt: string = new Date().toISOString(),
): WebSinkSendTargetSnapshot {
  return parseWebSinkSendTargetSnapshot({
    version: 1,
    bindingId: binding.bindingId,
    pluginId: binding.pluginId,
    surfaceId: binding.surfaceId,
    workspaceId: binding.workspaceId,
    canonicalUrl: binding.canonicalUrl,
    epoch: binding.epoch,
    frozenAt,
  });
}

/** Executor snapshot 与 binding 的完整 identity 精确比较。 */
export function executorTargetIdentityEquals(
  target: ExecutorDeliveryTargetSnapshot,
  binding: ExecutorBinding,
): boolean {
  return (
    target.version === binding.version &&
    target.bindingId === binding.bindingId &&
    target.pluginId === binding.pluginId &&
    target.workspaceId === binding.workspaceId &&
    target.workspaceRoot === binding.workspaceRoot &&
    target.instanceId === binding.instanceId &&
    target.sessionId === binding.sessionId &&
    target.epoch === binding.epoch &&
    locatorExactEqual(target.locator, binding.locator)
  );
}

/** Web sink send snapshot 与 binding 的完整 identity 精确比较。 */
export function webSinkSendIdentityEquals(
  target: WebSinkSendTargetSnapshot,
  expected: Pick<
    WebSinkSendTargetSnapshot,
    "bindingId" | "pluginId" | "surfaceId" | "workspaceId" | "canonicalUrl" | "epoch"
  >,
): boolean {
  return (
    target.bindingId === expected.bindingId &&
    target.pluginId === expected.pluginId &&
    target.surfaceId === expected.surfaceId &&
    target.workspaceId === expected.workspaceId &&
    target.canonicalUrl === expected.canonicalUrl &&
    target.epoch === expected.epoch
  );
}
