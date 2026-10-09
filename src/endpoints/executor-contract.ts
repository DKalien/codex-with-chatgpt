import { z } from "zod";
import { createPluginRegistry } from "./registry.js";
import {
  DESCRIPTOR_NAME_MAX,
  EVIDENCE_DETAIL_MAX,
  endpointInstantSchema,
  endpointPluginIdSchema,
  executorBindingCandidateSchema,
  executorExecutionEvidenceSchema,
  parseExecutorExecutionEvidence,
  type ExecutorBinding,
  type ExecutorBindingCandidate,
  type ExecutorExecutionEvidenceRecord,
} from "./schema.js";

/**
 * Generic Executor Plugin contract。
 *
 * 约束：
 * - 不出现具体产品、线程、回合、主机、项目字段名。
 * - plugin 只发现 session candidate；不铸造 bindingId/epoch/boundAt。
 * - trusted terminal receipt 是 capability，不是默认能力。
 * - 一个插件支持 delivery 不代表支持 trusted terminal receipt。
 * - production delivery 由受控 backend 提供，不暴露 raw send 合同。
 */

export const executorPluginCapabilitiesSchema = z
  .object({
    bindExistingSession: z.boolean(),
    createSession: z.boolean(),
    delivery: z.boolean(),
    activeExecutionInspection: z.boolean(),
    approvalVisibility: z.boolean(),
    trustedTerminalReceipt: z.boolean(),
    cancellationInterrupt: z.boolean(),
    resume: z.boolean(),
  })
  .strict();
export type ExecutorPluginCapabilities = z.infer<typeof executorPluginCapabilitiesSchema>;

export const executorPluginDescriptorSchema = z
  .object({
    pluginId: endpointPluginIdSchema,
    kind: endpointPluginIdSchema,
    name: z.string().min(1).max(DESCRIPTOR_NAME_MAX),
    capabilities: executorPluginCapabilitiesSchema,
  })
  .strict();
export type ExecutorPluginDescriptor = z.infer<typeof executorPluginDescriptorSchema>;

export function parseExecutorPluginDescriptor(input: unknown): ExecutorPluginDescriptor {
  const parsed = executorPluginDescriptorSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`executor plugin descriptor 无效: ${parsed.error.issues.map(i => i.message).join("; ")}`);
  }
  return parsed.data;
}

export type ExecutorExecutionEvidence = ExecutorExecutionEvidenceRecord;

export interface ExecutorSessionProjection {
  /** Observed activity only; never authorizes delivery. Omitted means unknown. */
  readonly activity?: "idle" | "busy" | "approval_required" | "unknown";
  readonly sessionId: string;
  readonly instanceId: string;
  readonly locator: Readonly<Record<string, string>>;
}

export interface ExecutorActiveExecutionProjection {
  readonly active: boolean;
  readonly executionId?: string;
}

export interface ExecutorPlugin {
  readonly descriptor: ExecutorPluginDescriptor;
  /**
   * 发现/投影当前 executor session candidate。
   * 不得铸造 Bridge binding 元数据（bindingId/epoch/boundAt）。
   */
  discoverCurrent(context: {
    readonly workspaceRoot: string;
    readonly workspaceId: string;
  }): Promise<ExecutorBindingCandidate>;
  inspectSession(binding: ExecutorBinding): Promise<ExecutorSessionProjection>;
  inspectActiveExecution?(binding: ExecutorBinding): Promise<ExecutorActiveExecutionProjection>;
  /**
   * 仅当 capabilities.trustedTerminalReceipt === true 时可返回 trusted evidence。
   * 其他插件不得通过该路径产出 trusted receipt。
   */
  inspectExecutionEvidence?(binding: ExecutorBinding): Promise<readonly ExecutorExecutionEvidence[]>;
  cancel?(binding: ExecutorBinding): Promise<{ cancelled: boolean; reason?: string }>;
  resume?(binding: ExecutorBinding): Promise<{ resumed: boolean; reason?: string }>;
}

/**
 * Runtime-strict evidence 门禁：
 * - 先 parse/validate descriptor（不信 TypeScript 编译期类型）
 * - 解析/校验每条 evidence
 * - 要求 evidence.pluginId === descriptor.pluginId
 * - trusted=true 仅当 descriptor.capabilities.trustedTerminalReceipt === true
 */
export function assertTrustedEvidenceAllowed(
  descriptorInput: unknown,
  evidence: readonly unknown[],
): void {
  const descriptor = parseExecutorPluginDescriptor(descriptorInput);
  const validated: ExecutorExecutionEvidence[] = [];
  for (const item of evidence) {
    const record = parseExecutorExecutionEvidence(item);
    if (record.pluginId !== descriptor.pluginId) {
      throw new Error(`evidence.pluginId ${record.pluginId} 与 descriptor.pluginId ${descriptor.pluginId} 不一致`);
    }
    validated.push(record);
  }
  if (!descriptor.capabilities.trustedTerminalReceipt && validated.some(item => item.trusted)) {
    throw new Error(`plugin ${descriptor.pluginId} 未声明 trustedTerminalReceipt，不得产出 trusted evidence`);
  }
}

/** 校验 ExecutorPlugin 运行时结构：descriptor 严格解析，必需方法存在。 */
export function validateExecutorPlugin(plugin: unknown): ExecutorPlugin {
  if (!plugin || typeof plugin !== "object") {
    throw new Error("executor plugin 必须是对象");
  }
  const candidate = plugin as Partial<ExecutorPlugin> & { descriptor?: unknown };
  const descriptor = parseExecutorPluginDescriptor(candidate.descriptor);
  for (const method of ["discoverCurrent", "inspectSession"] as const) {
    if (typeof candidate[method] !== "function") {
      throw new Error(`executor plugin ${descriptor.pluginId} 缺少必需方法 ${method}`);
    }
  }
  return plugin as ExecutorPlugin;
}

/**
 * Executor-specialized 固定注册表：先做 runtime 合同校验，再委托 generic registry。
 * 不做动态发现。
 */
export function createExecutorPluginRegistry(
  plugins: readonly unknown[],
): ReturnType<typeof createPluginRegistry<ExecutorPlugin>> {
  const validated = plugins.map(plugin => validateExecutorPlugin(plugin));
  return createPluginRegistry(validated);
}

export function parseExecutionEvidenceList(
  input: readonly unknown[],
): readonly ExecutorExecutionEvidence[] {
  return input.map(item => parseExecutorExecutionEvidence(item));
}

/** 供 registry/调用方使用的 descriptor 运行时校验入口。 */
export function assertValidExecutorPluginDescriptor(input: unknown): ExecutorPluginDescriptor {
  return parseExecutorPluginDescriptor(input);
}

export const EXECUTION_EVIDENCE_DETAIL_MAX = EVIDENCE_DETAIL_MAX;
export { executorBindingCandidateSchema, endpointInstantSchema, endpointPluginIdSchema };
