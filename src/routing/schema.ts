import path from "node:path";
import { z } from "zod";

/**
 * Routing R1 语义身份层 schema。
 *
 * 核心身份：workspace + platform + conversationId。
 * - platform 是端点/执行平台，不是 OS 或模糊产品类别；strict 拒绝未知值（fail closed）。
 * - locator 是平台定位信息，不参与 route identity；唯一键只有 (platform, conversationId)。
 * - routeId / resultId / legacyReferenceId 都是内部引用标识，不承担跨进程路由归属。
 * - Command 只描述投递（deliveryStatus）；执行结果（ok/failed/blocked）属于 ExecutionResult。
 *   发送结果不明 ≠ 执行失败。
 */

export class RoutingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RoutingError";
  }
}

export const routingPlatformSchema = z.enum(["chatgpt_web", "codex_desktop"]);
export type RoutingPlatform = z.infer<typeof routingPlatformSchema>;

export const routingRoleSchema = z.enum(["planner", "executor"]);
export type RoutingRole = z.infer<typeof routingRoleSchema>;

/** 输入层 UUID：接受大小写（codex_desktop conversationId 注册时 canonical 化为 lowercase）。 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 持久化层 UUID：仅 canonical lowercase；人工改成非 canonical → fail closed。 */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[a-f0-9]{64}$/;
/** 与 desktop store 的 desktopId 同字符集：workspace 内稳定短 ID。 */
const ROUTING_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** chatgpt_web：沿用现有 ChatGPT legacy conversation 字符集（src/chatgpt/route.ts）。 */
const CHATGPT_WEB_CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const GPT_ID = /^g-[A-Za-z0-9_-]+$/;
/** Workspace.id = sha256(root)[:12]（src/workspace/manager.ts）。 */
const WORKSPACE_ID = /^[a-f0-9]{12}$/;

export const routingWorkspaceIdSchema = z.string().regex(WORKSPACE_ID);
export const routingCommandIdSchema = z.string().regex(ROUTING_ID);
export const routingUuidSchema = z.string().regex(CANONICAL_UUID);

/** chatgpt_web locator：可选 GPT id；不参与 identity。 */
export const chatgptWebLocatorSchema = z
  .object({ gptId: z.string().regex(GPT_ID).optional() })
  .strict();
/** codex_desktop locator：Codex Desktop 定位字段；不参与 identity。 */
export const codexDesktopLocatorSchema = z
  .object({
    hostId: z.literal("local"),
    executorProjectId: z.string().regex(ROUTING_ID),
  })
  .strict();
export type ChatgptWebLocator = z.infer<typeof chatgptWebLocatorSchema>;
export type CodexDesktopLocator = z.infer<typeof codexDesktopLocatorSchema>;
export type RoutingLocator = ChatgptWebLocator | CodexDesktopLocator;

const routeBase = {
  routeId: routingUuidSchema,
  role: routingRoleSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
};

/** 持久化 Route：conversationId 按 platform 专项校验，不用通用宽规则。 */
export const routeSchema = z.discriminatedUnion("platform", [
  z
    .object({
      ...routeBase,
      platform: z.literal("chatgpt_web"),
      conversationId: z.string().regex(CHATGPT_WEB_CONVERSATION_ID),
      locator: chatgptWebLocatorSchema,
    })
    .strict(),
  z
    .object({
      ...routeBase,
      platform: z.literal("codex_desktop"),
      // 持久化只认 canonical lowercase UUID；大写输入在注册时被 canonical 化。
      conversationId: z.string().regex(CANONICAL_UUID),
      locator: codexDesktopLocatorSchema,
    })
    .strict(),
]);
export type RoutingRoute = z.infer<typeof routeSchema>;

/** 注册输入：无 routeId/时间戳；role 注册后不可变。 */
export const routeRegistrationSchema = z.discriminatedUnion("platform", [
  z
    .object({
      role: routingRoleSchema,
      platform: z.literal("chatgpt_web"),
      conversationId: z.string().regex(CHATGPT_WEB_CONVERSATION_ID),
      locator: chatgptWebLocatorSchema,
    })
    .strict(),
  z
    .object({
      role: routingRoleSchema,
      platform: z.literal("codex_desktop"),
      // 输入层接受大小写 UUID；store 注册时 canonical 化为 lowercase。
      conversationId: z.string().regex(UUID),
      locator: codexDesktopLocatorSchema,
    })
    .strict(),
]);
export type RouteRegistration = z.infer<typeof routeRegistrationSchema>;

/** 与 desktop store 的 intent 枚举对齐。 */
export const routingIntentSchema = z.enum(["development_plan", "revision"]);
export type RoutingIntent = z.infer<typeof routingIntentSchema>;

/** Command 只描述投递；completed/failed/blocked 属于 ExecutionResult。 */
export const commandDeliveryStatusSchema = z.enum([
  "pending",
  "accepted",
  "rejected",
  "outcome_unknown",
]);
export type CommandDeliveryStatus = z.infer<typeof commandDeliveryStatusSchema>;

export const commandSchema = z
  .object({
    commandId: routingCommandIdSchema,
    plannerRouteId: routingUuidSchema,
    executorRouteId: routingUuidSchema,
    intent: routingIntentSchema,
    payloadBytes: z.number().int().positive(),
    payloadSha256: z.string().regex(HEX64),
    deliveryStatus: commandDeliveryStatusSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type RoutingCommand = z.infer<typeof commandSchema>;

/**
 * 创建入口封死：不接受调用方指定初始 deliveryStatus（strict 拒绝多余字段）。
 * 创建一律产生 pending；accepted/rejected/outcome_unknown 只能由显式 delivery
 * transition API 写入。
 */
export const commandInputSchema = commandSchema
  .omit({ deliveryStatus: true, createdAt: true, updatedAt: true })
  .strict();
export type CommandInput = z.infer<typeof commandInputSchema>;

/** 仅允许 transport 为已存在的 pending Command 写入首个终态。 */
export const commandDeliveryTransitionInputSchema = z.object({
  commandId: routingCommandIdSchema,
  deliveryStatus: z.enum(["accepted", "rejected", "outcome_unknown"]),
}).strict();
export type CommandDeliveryTransitionInput = z.infer<typeof commandDeliveryTransitionInputSchema>;

/** 执行结果状态；与 feedback 事件 result 枚举对齐。 */
export const resultStatusSchema = z.enum(["ok", "failed", "blocked"]);
export type ResultStatus = z.infer<typeof resultStatusSchema>;

/** R4 canonical envelope 只保留本机可信事实，不保存 output body。 */
export const machineEvidenceSchema = z.object({
  version: z.literal(1),
  source: z.literal("codex_desktop_receipt"),
  desktopReceiptSha256: z.string().regex(HEX64),
  taskId: z.string().regex(/^desktop_[A-Za-z0-9_-]{1,128}$/),
  iteration: z.number().int().positive(),
  status: resultStatusSchema,
  threadId: routingUuidSchema,
  originTurnId: routingUuidSchema,
  resultTurnId: routingUuidSchema,
  bindingId: routingUuidSchema,
  changedFiles: z.array(z.string().min(1).max(4096)).max(10_000),
  testsSummary: z.string().min(1).max(16_384),
  output: z.object({ outputId: z.number().int().positive().safe(), outputAvailable: z.boolean() }).strict().optional(),
}).strict();

const resultIdentityFields = {
  commandId: routingCommandIdSchema,
  executorRouteId: routingUuidSchema,
  iteration: z.number().int().positive(),
  status: resultStatusSchema,
};

const resultFields = {
  ...resultIdentityFields,
  rawSummary: z.string().min(1).refine(value => value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= 8192,
    "rawSummary 必须非空且不超过 8192 UTF-8 bytes"),
  machineEvidence: machineEvidenceSchema,
};

function checkResultConsistency(value: z.infer<z.ZodObject<typeof resultFields>>, ctx: z.RefinementCtx): void {
  if (value.machineEvidence.taskId !== `desktop_${value.commandId}` ||
      value.machineEvidence.iteration !== value.iteration ||
      value.machineEvidence.status !== value.status) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ExecutionResult 与 machineEvidence 身份或终态不一致" });
  }
}

/** resultId 由 store 生成；(commandId, iteration) 承担幂等身份。 */
export const resultInputSchema = z.object(resultFields).strict().superRefine(checkResultConsistency);
export type ResultInput = z.infer<typeof resultInputSchema>;

const resultEnvelopeFields = {
  resultId: routingUuidSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
};

const canonicalResultSchema = z.object({
  ...resultFields,
  ...resultEnvelopeFields,
}).strict().superRefine(checkResultConsistency);

const legacyResultSchema = z.object({
  ...resultIdentityFields,
  ...resultEnvelopeFields,
}).strict();

/** 持久化兼容 R1（两字段皆无）与 R4 canonical（两字段皆有），拒绝半成品。 */
export const resultSchema = z.union([legacyResultSchema, canonicalResultSchema]);
export type RoutingResult = z.infer<typeof resultSchema>;

export const routingStateSchema = z
  .object({
    version: z.literal(1),
    workspaceId: routingWorkspaceIdSchema,
    workspaceRoot: z.string().min(1),
    // 全新 store 无历史兼容包袱：revision 必填；缺失即损坏（fail closed），
    // 防止被删后下次 update 从 0 重新计数破坏单调性。
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    routes: z.array(routeSchema).max(1000),
    commands: z.array(commandSchema).max(10000),
    results: z.array(resultSchema).max(10000),
  })
  .strict()
  .superRefine((state, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (!path.isAbsolute(state.workspaceRoot)) {
      issue("workspaceRoot 必须是绝对路径");
    }
    const routeIds = new Set<string>();
    const routeIdentities = new Set<string>();
    const roleByRouteId = new Map<string, RoutingRole>();
    for (const route of state.routes) {
      if (routeIds.has(route.routeId)) issue(`routeId 重复：${route.routeId}`);
      routeIds.add(route.routeId);
      const identity = `${route.platform}\u0000${route.conversationId}`;
      if (routeIdentities.has(identity)) issue("route (platform, conversationId) 重复");
      routeIdentities.add(identity);
      roleByRouteId.set(route.routeId, route.role);
    }
    const commandIds = new Set<string>();
    for (const command of state.commands) {
      if (commandIds.has(command.commandId)) issue(`commandId 重复：${command.commandId}`);
      commandIds.add(command.commandId);
      if (!routeIds.has(command.plannerRouteId)) {
        issue(`command ${command.commandId} 引用不存在的 planner route`);
      } else if (roleByRouteId.get(command.plannerRouteId) !== "planner") {
        issue(`command ${command.commandId} 的 plannerRouteId 不是 planner role`);
      }
      if (!routeIds.has(command.executorRouteId)) {
        issue(`command ${command.commandId} 引用不存在的 executor route`);
      } else if (roleByRouteId.get(command.executorRouteId) !== "executor") {
        issue(`command ${command.commandId} 的 executorRouteId 不是 executor role`);
      }
    }
    const resultIds = new Set<string>();
    const resultKeys = new Set<string>();
    const commandById = new Map(state.commands.map((c) => [c.commandId, c]));
    for (const result of state.results) {
      if (resultIds.has(result.resultId)) issue(`resultId 重复：${result.resultId}`);
      resultIds.add(result.resultId);
      const key = `${result.commandId}\u0000${result.iteration}`;
      if (resultKeys.has(key)) issue("(commandId, iteration) 重复");
      resultKeys.add(key);
      const command = commandById.get(result.commandId);
      if (!command) {
        issue(`result ${result.resultId} 引用不存在的 command`);
      } else if (result.executorRouteId !== command.executorRouteId) {
        issue(`result ${result.resultId} 的 executorRouteId 与 command 不一致`);
      }
    }
  });
export type RoutingState = z.infer<typeof routingStateSchema>;
