import { createHash } from "node:crypto";
import { z } from "zod";
import { listExecutionOutputs, saveExecutionOutput, saveRestrictedExecutionOutput, type ExecutionOutputMeta } from "../execution/output.js";
import {
  appendExecutionRecordLocked,
  executionSummarySchema,
  isTrustedDesktopReceipt,
  readExecutionRecordsStrict,
  withExecutionRecordsLockAsync,
  type StoredExecutionRecord,
} from "../execution/records.js";
import {
  desktopIpc,
  type DesktopResultActivityMarkerObservation,
  type DesktopResultClassification,
  type DesktopResultContext,
  type DesktopResultOwnership,
  type DesktopResultOwnershipExpectation,
  type DesktopTarget,
} from "./ipc.js";
import {
  DesktopError,
  desktopId,
  readDesktop,
  type DesktopDelivery,
} from "./store.js";
import { reconcileUnknownDesktopDelivery } from "./unknown-reconciliation.js";
import {
  spawnReceiptFinalizerWorker,
  canonicalReceiptFinalizationInput,
  receiptFinalizationMarkerDigest,
  sanitizeReceiptFinalizationInput,
  stageReceiptFinalization,
  type ReceiptFinalizationFenceResult,
  type ReceiptFinalizationInput,
  type ReceiptFinalizationMarkedDraft,
  type ReceiptFinalizationMarker,
  type ReceiptFinalizationOwnershipSnapshot,
  writeReceiptFinalizationAlert,
  type ReceiptFinalizationDraft,
} from "./receipt-finalizer.js";

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
  record: StoredExecutionRecord;
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

const uuid = z.string().uuid();
const workspaceInput = z.object({ id: desktopId, root: z.string().min(1) });
const RESULT_CONTEXT_ATTEMPTS = 3;
const RESULT_CONTEXT_RETRY_DELAY_MS = 25;

function waitForResultContextRetry(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, RESULT_CONTEXT_RETRY_DELAY_MS));
}

function currentThreadId(): string {
  const value = process.env.CODEX_THREAD_ID;
  if (!uuid.safeParse(value).success) {
    throw new DesktopResultError("DESKTOP_RESULT_CONTEXT", "缺少有效的 CODEX_THREAD_ID；拒绝记录 Desktop 结果。");
  }
  return value!;
}

function readDesktopResultDelivery(workspace: DesktopResultWorkspace, commandId: string, threadId: string): DesktopDelivery {
  const state = readDesktop(workspace.id);
  if (!state) {
    throw new DesktopResultError("DESKTOP_RESULT_STATE", "当前工作区没有 Desktop 授权历史；拒绝记录执行结果。");
  }
  if (state.workspaceRoot !== workspace.root) {
    throw new DesktopResultError("DESKTOP_WRONG_WORKSPACE", "当前工作区根目录与 Desktop 状态不一致；拒绝记录执行结果。");
  }
  const delivery = state.deliveries.find(item => item.commandId === commandId && item.threadId === threadId);
  if (!delivery) {
    throw new DesktopResultError("DESKTOP_RESULT_THREAD", "没有与当前 commandId 和 CODEX_THREAD_ID 匹配的 accepted Desktop 投递；拒绝记录执行结果。");
  }
  return delivery;
}

function assertDesktopResultContext(workspace: DesktopResultWorkspace, commandId: string, threadId: string): DesktopDelivery {
  const delivery = readDesktopResultDelivery(workspace, commandId, threadId);
  if (delivery.deliveryStatus !== "accepted") {
    throw new DesktopResultError("DESKTOP_RESULT_THREAD", "没有与当前 commandId 和 CODEX_THREAD_ID 匹配的 accepted Desktop 投递；拒绝记录执行结果。");
  }
  return delivery;
}

function strictUuid(value: unknown): value is string {
  return typeof value === "string" && value === value.toLowerCase() && uuid.safeParse(value).success;
}

async function assertCurrentResultContext(
  workspace: DesktopResultWorkspace,
  accepted: DesktopDelivery,
): Promise<DesktopResultOwnership> {
  const context = await readCurrentResultContext(workspace, accepted.threadId);
  if (context.resultTurnId === accepted.turnId && accepted.deliveryId === undefined) {
    return {
      ...context,
      ownership: "origin",
      originTurnId: accepted.turnId,
      originAlias: null,
      chainTurnIds: [accepted.turnId],
      chainLength: 0,
      chainSignatures: [],
      signature: null,
    };
  }
  if (!accepted.intent) {
    throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "accepted 投递缺少 continuation 所需的 intent；拒绝记录执行结果。");
  }
  let ownership: DesktopResultOwnership;
  try {
    ownership = await desktopIpc.currentResultOwnership(workspace.root, {
      workspaceId: workspace.id,
      commandId: accepted.commandId,
      intent: accepted.intent,
      messageBytes: accepted.messageBytes,
      messageSha256: accepted.messageSha256,
      originTurnId: accepted.turnId!,
      ...(accepted.deliveryId === undefined ? {} : { deliveryId: accepted.deliveryId }),
    });
  } catch {
    // 当前 context 已经确认可用；continuation attestation 的任何失败都必须
    // 保持 current-execution fail-closed，不能被 prior receipt 的 durable
    // unavailable fallback 吞掉。
    throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "无法严格证明当前 Desktop continuation 归属；拒绝记录执行结果。");
  }
  const expectedKind = context.resultTurnId === accepted.turnId ? "origin" : "native_continuation";
  const exactOrigin = ownership.ownership === expectedKind && ownership.originTurnId === accepted.turnId &&
    ownership.originAlias === null && ownership.deliveryId === accepted.deliveryId;
  const editAlias = ownership.ownership === "native_continuation" && accepted.deliveryId !== undefined &&
    ownership.deliveryId === accepted.deliveryId && ownership.originAlias === "edit_user_message_v2_delivery" &&
    ownership.originTurnId !== accepted.turnId && ownership.chainSignatures[0] === "resume_interrupted_task";
  if ((!exactOrigin && !editAlias) ||
      ownership.threadId !== accepted.threadId || ownership.workspaceRoot !== workspace.root ||
      ownership.resultTurnId !== context.resultTurnId || ownership.chainTurnIds[0] !== ownership.originTurnId ||
      ownership.chainTurnIds[ownership.chainTurnIds.length - 1] !== context.resultTurnId) {
    throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "当前 Desktop continuation 归属或 result tip 不一致；拒绝记录执行结果。");
  }
  if (context.resultTurnId === accepted.turnId && ownership.ownership !== "origin") {
    throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "当前 Desktop origin attestation 与 accepted turn 不一致；拒绝记录执行结果。");
  }
  return ownership;
}

function sameOwnership(left: DesktopResultOwnership, right: DesktopResultOwnership): boolean {
  return left.ownership === right.ownership && left.originTurnId === right.originTurnId &&
    left.deliveryId === right.deliveryId && left.originAlias === right.originAlias &&
    left.resultTurnId === right.resultTurnId && left.chainLength === right.chainLength &&
    left.signature === right.signature &&
    JSON.stringify(left.chainTurnIds) === JSON.stringify(right.chainTurnIds) &&
    JSON.stringify(left.chainSignatures) === JSON.stringify(right.chainSignatures);
}

async function readCurrentResultContext(workspace: DesktopResultWorkspace, expectedThreadId: string): Promise<DesktopResultContext> {
  let current: unknown;
  for (let attempt = 1; attempt <= RESULT_CONTEXT_ATTEMPTS; attempt += 1) {
    try {
      current = await desktopIpc.currentResultContext(workspace.root);
      break;
    } catch (error) {
      const retryable = error instanceof DesktopError && error.code === "DESKTOP_STATE_UNAVAILABLE";
      if (!retryable || attempt === RESULT_CONTEXT_ATTEMPTS) {
        if (error instanceof DesktopError) throw error;
        throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "无法确认当前 Desktop result context；拒绝记录执行结果。");
      }
      await waitForResultContextRetry();
    }
  }
  const context = current as Partial<DesktopResultContext> | null;
  const terminal = context?.resultTurnStatus === "completed" || context?.resultTurnStatus === "failed" ||
    context?.resultTurnStatus === "interrupted" || context?.resultTurnStatus === "cancelled";
  if (!context || typeof context !== "object" || Array.isArray(context) ||
      !strictUuid(context.threadId) || !strictUuid(context.resultTurnId) ||
      context.workspaceRoot !== workspace.root ||
      context.threadId !== expectedThreadId ||
      (context.runtimeStatus === "idle" && !terminal) ||
      ((context.runtimeStatus === "active" || context.runtimeStatus === "inProgress") && context.resultTurnStatus !== "inProgress")) {
    throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "当前 Desktop result context 与 accepted 投递的 thread、workspace 或 turn 不一致；拒绝记录执行结果。");
  }
  return context as DesktopResultContext;
}

async function readCurrentResultClassification(
  workspace: DesktopResultWorkspace,
): Promise<DesktopResultClassification> {
  for (let attempt = 1; attempt <= RESULT_CONTEXT_ATTEMPTS; attempt += 1) {
    try {
      return await desktopIpc.currentResultClassification(workspace.root);
    } catch (error) {
      const retryable = error instanceof DesktopError && error.code === "DESKTOP_STATE_UNAVAILABLE";
      if (!retryable || attempt === RESULT_CONTEXT_ATTEMPTS) {
        if (error instanceof DesktopError) throw error;
        throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "无法确认当前 Desktop result classification；拒绝记录执行结果。");
      }
      await waitForResultContextRetry();
    }
  }
  throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "无法确认当前 Desktop result classification；拒绝记录执行结果。");
}

/**
 * Discover only the accepted delivery owned by the current Desktop result turn.
 * This is deliberately strict: no latest/nearest delivery inference and no
 * fallback to generic execution records.
 */
export async function discoverCurrentDesktopDelivery(
  workspaceRaw: DesktopResultWorkspace,
): Promise<CurrentDesktopDelivery> {
  const workspace = workspaceInput.parse(workspaceRaw);
  const rawThreadId = process.env.CODEX_THREAD_ID;
  if (!strictUuid(rawThreadId)) {
    throw new DesktopResultError("DESKTOP_RESULT_NOT_APPLICABLE", "当前进程不是可识别的 Desktop runner；未写入通用执行记录。");
  }
  const threadId = rawThreadId;
  const state = readDesktop(workspace.id);
  if (state && state.workspaceRoot !== workspace.root) {
    throw new DesktopResultError("DESKTOP_WRONG_WORKSPACE", "当前 Desktop workspace 根目录与状态不一致；拒绝回退通用记录。");
  }
  const classification = await readCurrentResultClassification(workspace);
  if (classification.classification === "not_applicable") {
    throw new DesktopResultError("DESKTOP_RESULT_NOT_APPLICABLE", "当前 Desktop result turn 不是可识别的 accepted delivery；未写入通用执行记录。");
  }
  if (!state) {
    throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "当前 Desktop result 已自证为 delivery，但 durable workspace 状态缺失；拒绝回退通用记录。");
  }
  const candidates = state.deliveries.filter(item => item.threadId === threadId && item.deliveryStatus === "accepted");
  if (!classification.workspaceId || !classification.commandId || !classification.intent ||
      classification.messageBytes === undefined || !classification.messageSha256 || !classification.ownership || !classification.originTurnId ||
      !classification.chainTurnIds || classification.chainLength === undefined || !classification.chainSignatures ||
      classification.signature === undefined) {
    throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "当前 Desktop result classification 不完整；拒绝回退通用记录。");
  }
  if (classification.threadId !== threadId || classification.workspaceRoot !== workspace.root || classification.workspaceId !== workspace.id) {
    throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "当前 Desktop result classification 身份与 runner/workspace 不一致；拒绝回退通用记录。");
  }
  const accepted = candidates.find(item => item.commandId === classification.commandId &&
      item.threadId === classification.threadId && item.intent === classification.intent &&
      item.messageBytes === classification.messageBytes && item.messageSha256 === classification.messageSha256 &&
      item.deliveryId === classification.deliveryId && classification.workspaceId === workspace.id);
  const exactOrigin = !!accepted && classification.originAlias === null && classification.originTurnId === accepted.turnId;
  const editAlias = !!accepted && accepted.deliveryId !== undefined &&
    classification.deliveryId === accepted.deliveryId && classification.originAlias === "edit_user_message_v2_delivery" &&
    classification.ownership === "native_continuation" &&
    classification.chainTurnIds[0] === classification.originTurnId &&
    classification.chainSignatures[0] === "resume_interrupted_task";
  if (!accepted || (!exactOrigin && !editAlias) ||
      (classification.ownership === "origin" && classification.resultTurnId !== classification.originTurnId) ||
      (classification.ownership === "native_continuation" && classification.resultTurnId === classification.originTurnId)) {
    throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "当前 Desktop result self-attestation 与 accepted delivery 不一致；拒绝回退通用记录。");
  }
  const {
    classification: _classification, workspaceId: _workspaceId, commandId: _commandId, intent: _intent,
    messageBytes: _messageBytes, messageSha256: _messageSha256, ...ownership
  } = classification;
  return {
    commandId: accepted.commandId,
    threadId: classification.threadId,
    turnId: classification.resultTurnId,
    ownership: ownership as DesktopResultOwnership,
  };
}

function canonicalInput(input: ReceiptFinalizationInput): string {
  return canonicalReceiptFinalizationInput(sanitizeReceiptFinalizationInput(input));
}

function receiptHash(input: ReceiptFinalizationInput): string {
  return createHash("sha256").update(canonicalInput(input), "utf8").digest("hex");
}

function failClosed(code: string, message: string): never {
  throw new DesktopResultError(code, message);
}

function existingRecord(
  records: StoredExecutionRecord[],
  commandId: string,
  taskId: string,
  digest: string,
): StoredExecutionRecord | undefined {
  const byCommand = records.filter(record => record.commandId === commandId);
  const byTask = records.filter(record => record.taskId === taskId);
  if (byCommand.length > 1 || byTask.length > 1) {
    return failClosed("DESKTOP_RESULT_CONFLICT", "commandId 已有重复执行记录；拒绝猜测或追加结果。");
  }
  const prior = byCommand[0] ?? byTask[0];
  if (!prior) return undefined;
  if (prior.commandId !== commandId || prior.taskId !== taskId || !prior.desktopReceiptSha256) {
    return failClosed("DESKTOP_RESULT_CONFLICT", "commandId 已有不匹配或不完整的执行记录；拒绝追加结果。");
  }
  if (prior.desktopReceiptSha256 !== digest) {
    return failClosed("DESKTOP_RESULT_CONFLICT", "commandId 的 Desktop 结果参数不一致；拒绝重放或覆盖原记录。");
  }
  return prior;
}

function outputForRecord(workspaceId: string, record: StoredExecutionRecord): ExecutionOutputMeta | null {
  if (record.outputId === undefined) return null;
  try {
    return listExecutionOutputs(workspaceId, Number.MAX_SAFE_INTEGER).find(item => item.id === record.outputId) ?? null;
  } catch {
    return failClosed("DESKTOP_RESULT_OUTPUT_CORRUPT", "执行输出状态损坏；保留原文件并人工核对，拒绝重放结果。");
  }
}

function hasPartialOutput(workspaceId: string, taskId: string): boolean {
  try {
    return listExecutionOutputs(workspaceId, Number.MAX_SAFE_INTEGER).some(item => item.taskId === taskId);
  } catch {
    return failClosed("DESKTOP_RESULT_OUTPUT_CORRUPT", "执行输出状态损坏；保留原文件并人工核对，拒绝追加结果。");
  }
}

function assertFinalizationDelivery(
  workspace: DesktopResultWorkspace,
  draft: ReceiptFinalizationMarkedDraft,
  target: { threadId: string; hostId: string; projectId: string; workspaceRoot: string },
): DesktopDelivery {
  if (draft.workspaceId !== workspace.id || draft.workspaceRoot !== workspace.root || draft.threadId !== target.threadId ||
      target.workspaceRoot !== workspace.root || draft.resultTurnId !== draft.marker.resultTurnId) {
    throw new DesktopResultError("DESKTOP_RESULT_THREAD", "pending receipt 的 terminal fence 身份不一致；拒绝写入结果。 ");
  }
  const state = readDesktop(workspace.id);
  if (!state || state.workspaceRoot !== workspace.root || !state.binding || state.binding.threadId !== draft.threadId ||
      state.binding.hostId !== target.hostId || state.binding.projectId !== target.projectId) {
    throw new DesktopResultError("DESKTOP_RESULT_THREAD", "pending receipt 的 Desktop binding 已变化；拒绝写入结果。 ");
  }
  const deliveries = state.deliveries.filter(item => item.deliveryStatus === "accepted" && item.commandId === draft.commandId &&
    item.threadId === draft.threadId && item.turnId === draft.originTurnId);
  if (deliveries.length !== 1) {
    throw new DesktopResultError("DESKTOP_RESULT_THREAD", "pending receipt 没有唯一匹配的 accepted delivery；拒绝写入结果。 ");
  }
  return deliveries[0]!;
}

function assertFinalizationFence(
  draft: ReceiptFinalizationMarkedDraft,
  fence: ReceiptFinalizationFenceResult,
): void {
  if (fence.fence !== "safe_terminal" || fence.resultTurnId !== draft.resultTurnId ||
      fence.threadId !== draft.threadId || fence.workspaceRoot !== draft.workspaceRoot) {
    throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "Desktop terminal fence 不是可证明的 safe_terminal；拒绝写入结果。 ");
  }
}

function finalizationOwnershipSnapshot(
  workspace: DesktopResultWorkspace,
  accepted: DesktopDelivery,
  ownership: DesktopResultOwnership,
): ReceiptFinalizationOwnershipSnapshot {
  if (!accepted.turnId || !accepted.intent || ownership.hostId !== "local" || ownership.threadId !== accepted.threadId ||
      ownership.workspaceRoot !== workspace.root || ownership.deliveryId !== accepted.deliveryId ||
      (ownership.originAlias === null && ownership.originTurnId !== accepted.turnId) ||
      (ownership.originAlias !== null && ownership.originTurnId === accepted.turnId) ||
      ownership.resultTurnId !== ownership.chainTurnIds[ownership.chainTurnIds.length - 1]) {
    throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "pending receipt 缺少完整 Desktop ownership identity；未写入 pending receipt。 ");
  }
  return {
    workspaceId: workspace.id,
    commandId: accepted.commandId,
    threadId: ownership.threadId,
    hostId: "local",
    projectId: ownership.projectId,
    workspaceRoot: ownership.workspaceRoot,
    intent: accepted.intent,
    messageBytes: accepted.messageBytes,
    messageSha256: accepted.messageSha256,
    ownership: ownership.ownership,
    originTurnId: ownership.originTurnId,
    ...(accepted.deliveryId === undefined ? {} : { deliveryId: accepted.deliveryId }),
    originAlias: ownership.originAlias,
    resultTurnId: ownership.resultTurnId,
    chainTurnIds: [...ownership.chainTurnIds],
    chainLength: ownership.chainLength,
    chainSignatures: [...ownership.chainSignatures],
    signature: ownership.signature,
  };
}

function finalizationOwnershipMatches(
  snapshot: ReceiptFinalizationOwnershipSnapshot,
  ownership: DesktopResultOwnership,
): boolean {
  return snapshot.threadId === ownership.threadId && snapshot.hostId === ownership.hostId &&
    snapshot.projectId === ownership.projectId && snapshot.workspaceRoot === ownership.workspaceRoot &&
    snapshot.ownership === ownership.ownership && snapshot.originTurnId === ownership.originTurnId &&
    snapshot.deliveryId === ownership.deliveryId && snapshot.originAlias === ownership.originAlias &&
    snapshot.resultTurnId === ownership.resultTurnId && snapshot.chainLength === ownership.chainLength &&
    snapshot.signature === ownership.signature &&
    JSON.stringify(snapshot.chainTurnIds) === JSON.stringify(ownership.chainTurnIds) &&
    JSON.stringify(snapshot.chainSignatures) === JSON.stringify(ownership.chainSignatures);
}

function finalizationOwnershipExpectation(
  workspace: DesktopResultWorkspace,
  draft: Extract<ReceiptFinalizationDraft, { version: 3 }>,
  accepted: DesktopDelivery,
): DesktopResultOwnershipExpectation {
  if (!accepted.turnId || !accepted.intent || accepted.commandId !== draft.commandId ||
      accepted.threadId !== draft.threadId || accepted.turnId !== draft.originTurnId ||
      accepted.deliveryId !== draft.ownershipSnapshot.deliveryId ||
      accepted.intent !== draft.ownershipSnapshot.intent || accepted.messageBytes !== draft.ownershipSnapshot.messageBytes ||
      accepted.messageSha256 !== draft.ownershipSnapshot.messageSha256 ||
      workspace.id !== draft.ownershipSnapshot.workspaceId || workspace.root !== draft.ownershipSnapshot.workspaceRoot) {
    throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "pending receipt accepted delivery 身份与 ownership snapshot 不一致；拒绝写入。 ");
  }
  return {
    workspaceId: workspace.id,
    commandId: accepted.commandId,
    intent: accepted.intent,
    messageBytes: accepted.messageBytes,
    messageSha256: accepted.messageSha256,
    originTurnId: accepted.turnId,
    ...(accepted.deliveryId === undefined ? {} : { deliveryId: accepted.deliveryId }),
  };
}

async function assertFinalizationOwnership(
  workspace: DesktopResultWorkspace,
  draft: Extract<ReceiptFinalizationDraft, { version: 3 }>,
  target: DesktopTarget,
  accepted: DesktopDelivery,
): Promise<void> {
  const snapshot = draft.ownershipSnapshot;
  const expectation = finalizationOwnershipExpectation(workspace, draft, accepted);
  if (snapshot.threadId !== target.threadId || snapshot.hostId !== target.hostId ||
      snapshot.projectId !== target.projectId || snapshot.workspaceRoot !== target.workspaceRoot ||
      snapshot.resultTurnId !== draft.resultTurnId || snapshot.resultTurnId !== draft.marker.resultTurnId) {
    throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "pending receipt ownership snapshot target/fence 不一致；拒绝写入。 ");
  }
  let ownership: DesktopResultOwnership;
  try { ownership = await desktopIpc.inspectResultOwnership(target, expectation); }
  catch {
    throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "无法按精确 Desktop target 重新证明 pending receipt ownership；拒绝写入。 ");
  }
  if (ownership.resultTurnId !== draft.resultTurnId || !finalizationOwnershipMatches(snapshot, ownership)) {
    throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "pending receipt ownership chain 在终态期间发生漂移；拒绝写入。 ");
  }
}

function assertFinalizationDeliveryStable(
  workspace: DesktopResultWorkspace,
  draft: ReceiptFinalizationMarkedDraft,
  target: { threadId: string; hostId: string; projectId: string; workspaceRoot: string },
  expected: DesktopDelivery,
): DesktopDelivery {
  const current = assertFinalizationDelivery(workspace, draft, target);
  if (current.turnId !== expected.turnId || current.deliveryId !== expected.deliveryId ||
      current.bindingId !== expected.bindingId || current.intent !== expected.intent ||
      current.messageBytes !== expected.messageBytes || current.messageSha256 !== expected.messageSha256) {
    throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "pending receipt accepted delivery 在写入前发生漂移；拒绝写入。 ");
  }
  return current;
}

function prepareReceiptCommit(
  beforeReceiptCommit: ((receiptAlreadyExists: boolean) => void) | undefined,
  receiptAlreadyExists: boolean,
): void {
  try {
    beforeReceiptCommit?.(receiptAlreadyExists);
  } catch {
    throw new DesktopResultError(
      "DESKTOP_RESULT_RECONCILIATION_PENDING",
      "无法在 Desktop receipt 提交前持久化 Routing reconciliation intent；未写入新 output/receipt。",
    );
  }
}

/** Detached finalizer 的唯一写入口；复用 execution lock、output sanitizer 和 command 幂等。 */
export async function finalizeReceiptFinalizationDraft(
  draft: ReceiptFinalizationMarkedDraft,
  target: { threadId: string; hostId: string; projectId: string; workspaceRoot: string },
  fence: ReceiptFinalizationFenceResult,
  beforeReceiptCommit?: (receiptAlreadyExists: boolean) => void,
): Promise<DesktopResultReceipt> {
  const workspace = workspaceInput.parse({ id: draft.workspaceId, root: draft.workspaceRoot });
  assertFinalizationFence(draft, fence);
  assertFinalizationDelivery(workspace, draft, target);
  const input = sanitizeReceiptFinalizationInput(draft.input);
  const digest = createHash("sha256").update(canonicalReceiptFinalizationInput(input), "utf8").digest("hex");
  if (digest !== draft.inputDigest || input.commandId !== draft.commandId) {
    throw new DesktopResultError("DESKTOP_RESULT_CONFLICT", "pending receipt input 摘要不一致；拒绝写入结果。 ");
  }
  const taskId = `desktop_${draft.commandId}`;
  return withExecutionRecordsLockAsync(workspace.id, async () => {
    const accepted = assertFinalizationDelivery(workspace, draft, target);
    if (draft.version === 3) await assertFinalizationOwnership(workspace, draft, target, accepted);
    let records: StoredExecutionRecord[];
    try { records = readExecutionRecordsStrict(workspace.id); }
    catch (error) { throw new DesktopResultError("DESKTOP_RESULT_RECORDS_CORRUPT", error instanceof Error ? error.message : "执行记录损坏；拒绝继续。 "); }
    const prior = existingRecord(records, draft.commandId, taskId, digest);
    if (prior) {
      if (!isTrustedDesktopReceipt(prior, draft.commandId)) {
        throw new DesktopResultError("DESKTOP_RESULT_CONFLICT", "已有记录不是唯一可信 Desktop receipt；拒绝重放。 ");
      }
      const output = outputForRecord(workspace.id, prior);
      const matchingOutputs = listExecutionOutputs(workspace.id, Number.MAX_SAFE_INTEGER)
        .filter(item => item.taskId === taskId && item.iteration === 1);
      if ((prior.outputId === undefined && matchingOutputs.length !== 0) ||
          (prior.outputId !== undefined && matchingOutputs.length !== 1)) {
        throw new DesktopResultError("DESKTOP_RESULT_PARTIAL", "已有 Desktop receipt 的 output 数量不唯一；拒绝重放。 ");
      }
      if (prior.rawSummary !== undefined) {
        if (draft.version === 3) assertFinalizationDeliveryStable(workspace, draft, target, accepted);
        prepareReceiptCommit(beforeReceiptCommit, true);
      }
      return { record: prior, output };
    }
    if (hasPartialOutput(workspace.id, taskId)) {
      throw new DesktopResultError("DESKTOP_RESULT_PARTIAL", "已有未完成的 Desktop 结果输出但缺少执行记录；拒绝追加。 ");
    }
    if (input.rawSummary !== undefined) {
      if (draft.version === 3) assertFinalizationDeliveryStable(workspace, draft, target, accepted);
      prepareReceiptCommit(beforeReceiptCommit, false);
    }
    const acceptedBeforeOutput = draft.version === 3
      ? assertFinalizationDeliveryStable(workspace, draft, target, accepted)
      : accepted;
    const output = input.output !== undefined
      ? saveExecutionOutput(workspace.id, {
          command: input.command ?? `Desktop result ${draft.commandId}`,
          raw: input.output,
          exitCode: input.exitCode,
          taskId,
          iteration: 1,
        })
      : input.outputRestrictedReason !== undefined
        ? saveRestrictedExecutionOutput(workspace.id, {
            command: input.command ?? `Desktop result ${draft.commandId}`,
            reason: input.outputRestrictedReason,
            exitCode: input.exitCode,
            taskId,
            iteration: 1,
          })
        : null;
    const record: StoredExecutionRecord = {
      taskId,
      iteration: 1,
      changedFiles: [...input.changedFiles],
      tests: input.tests,
      exitStatus: input.exitStatus,
      timestamp: new Date().toISOString(),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
      ...(input.rawSummary === undefined ? {} : { rawSummary: input.rawSummary }),
      ...(output === null ? {} : { outputId: output.id, outputAvailable: output.allowed }),
      commandId: draft.commandId,
      desktopReceiptSha256: digest,
      desktopThreadId: draft.threadId,
      desktopOriginTurnId: draft.originTurnId,
      desktopResultTurnId: draft.resultTurnId,
      desktopBindingId: acceptedBeforeOutput.bindingId,
    };
    if (draft.version === 3) assertFinalizationDeliveryStable(workspace, draft, target, acceptedBeforeOutput);
    appendExecutionRecordLocked(workspace.id, record);
    const committed = readExecutionRecordsStrict(workspace.id)
      .filter(item => item.commandId === draft.commandId && item.taskId === taskId);
    if (committed.length !== 1 || !isTrustedDesktopReceipt(committed[0], draft.commandId)) {
      throw new DesktopResultError("DESKTOP_RESULT_CONFLICT", "Desktop receipt 未形成唯一可信终态；拒绝报告成功。 ");
    }
    const outputs = listExecutionOutputs(workspace.id, Number.MAX_SAFE_INTEGER)
      .filter(item => item.taskId === taskId && item.iteration === 1);
    if ((output === null && outputs.length !== 0) || (output !== null && outputs.length !== 1)) {
      throw new DesktopResultError("DESKTOP_RESULT_PARTIAL", "Desktop receipt output 数量不唯一；拒绝报告成功。 ");
    }
    return { record: committed[0], output };
  });
}

/**
 * 记录已由 Desktop 接受的本次结果。
 *
 * 首次写入仍要求新鲜 current result context 与 accepted origin 对齐，或由独立
 * native continuation attestation 证明后继 tip；不接受任意后续 turn 冒充。已落盘且 digest 完全一致的终态，在 Desktop context 暂时
 * 不可用时可只读恢复——terminal truth 与 UI 窗口解耦，不因此永久丢失。
 * 若 context 可用且指向其他 turn，即使已有 prior 也 fail closed。
 */
export async function recordDesktopResult(
  workspaceRaw: DesktopResultWorkspace,
  rawInput: DesktopResultInput,
  options: {
    allowInProgress?: boolean;
    beforeReceiptCommit?: (receiptAlreadyExists: boolean) => void;
  } = {},
): Promise<DesktopResultReceipt> {
  const workspace = workspaceInput.parse(workspaceRaw);
  const input = sanitizeReceiptFinalizationInput(desktopResultInput.parse(rawInput));
  const threadId = currentThreadId();
  const initial = readDesktopResultDelivery(workspace, input.commandId, threadId);
  let accepted: DesktopDelivery;
  if (initial.deliveryStatus === "accepted") {
    accepted = initial;
  } else if (initial.deliveryStatus === "outcome_unknown" && initial.intent !== undefined) {
    const current = await readCurrentResultContext(workspace, threadId);
    const reconciled = await reconcileUnknownDesktopDelivery(workspace, input.commandId, {
      expectedTurnId: current.resultTurnId,
    });
    if (reconciled.status !== "accepted" || reconciled.turnId !== current.resultTurnId) {
      throw new DesktopResultError("DESKTOP_RESULT_THREAD", "当前 Desktop result turn 没有唯一精确的 canonical history 候选；未记录执行结果。");
    }
    accepted = assertDesktopResultContext(workspace, input.commandId, threadId);
  } else {
    accepted = assertDesktopResultContext(workspace, input.commandId, threadId);
  }

  const taskId = `desktop_${input.commandId}`;
  const digest = receiptHash(input);
  return withExecutionRecordsLockAsync(workspace.id, async () => {
    // execution 锁只串行化记录；在输出或追加前再次验证状态，避免校验后 workspace 被撤权/损坏。
    const acceptedNow = assertDesktopResultContext(workspace, input.commandId, threadId);
    if (acceptedNow.turnId !== accepted.turnId || acceptedNow.deliveryId !== accepted.deliveryId) {
      return failClosed("DESKTOP_RESULT_THREAD", "accepted Desktop 投递在记录期间发生变化；拒绝写入结果。");
    }
    let records: StoredExecutionRecord[];
    try {
      records = readExecutionRecordsStrict(workspace.id);
    } catch (error) {
      return failClosed("DESKTOP_RESULT_RECORDS_CORRUPT", error instanceof Error ? error.message : "执行记录损坏；拒绝继续。");
    }

    const prior = existingRecord(records, input.commandId, taskId, digest);
    if (prior) {
      const recovered = await recoverPriorDesktopResult(workspace, acceptedNow, prior);
      if (prior.rawSummary !== undefined) prepareReceiptCommit(options.beforeReceiptCommit, true);
      return recovered;
    }
    if (hasPartialOutput(workspace.id, taskId)) {
      return failClosed("DESKTOP_RESULT_PARTIAL", "已有未完成的 Desktop 结果输出但缺少执行记录；拒绝追加或覆盖，请人工核对。");
    }

    const firstOwnership = await assertCurrentResultContext(workspace, acceptedNow);
    const rawSummary = input.rawSummary;
    if (rawSummary === undefined) {
      throw new DesktopResultError("DESKTOP_RESULT_INVALID", "Desktop execution receipt 必须包含 rawSummary。");
    }
    if (firstOwnership.resultTurnStatus === "inProgress" && options.allowInProgress !== true) {
      let draft: ReceiptFinalizationDraft;
      const durable = readDesktop(workspace.id);
      const binding = durable?.binding;
      const target = binding && durable?.workspaceRoot === workspace.root ? {
        threadId: binding.threadId,
        hostId: binding.hostId,
        projectId: binding.projectId,
        workspaceRoot: workspace.root,
      } : null;
      if (!target) {
        throw new DesktopResultError("DESKTOP_RESULT_THREAD", "pending receipt 缺少稳定 Desktop binding；未写入 pending receipt。 ");
      }
      let observed: DesktopResultActivityMarkerObservation;
      try { observed = await desktopIpc.inspectResultActivityMarker(target); }
      catch { throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "无法建立 Desktop receipt activity marker；未写入 pending receipt。 "); }
      const marker = observed.marker;
      if (observed.threadId !== threadId || observed.workspaceRoot !== workspace.root || observed.hostId !== target.hostId ||
          observed.projectId !== target.projectId || observed.resultTurnId !== firstOwnership.resultTurnId ||
          observed.resultTurnStatus !== "inProgress" || marker.resultTurnId !== firstOwnership.resultTurnId ||
          marker.itemIds.length !== marker.itemCount || marker.itemTypes.length !== marker.itemCount ||
          receiptFinalizationMarkerDigest(marker) !== marker.itemSha256) {
        throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "Desktop receipt activity marker 身份或摘要不一致；未写入 pending receipt。 ");
      }
      draft = stageReceiptFinalization({
        workspaceId: workspace.id,
        workspaceRoot: workspace.root,
        threadId,
        originTurnId: acceptedNow.turnId!,
        resultTurnId: firstOwnership.resultTurnId,
        commandId: input.commandId,
        input,
        marker,
        ownershipSnapshot: finalizationOwnershipSnapshot(workspace, acceptedNow, firstOwnership),
      });
      try {
        if (process.env.C2C_RECEIPT_FINALIZER_NO_SPAWN !== "1") spawnReceiptFinalizerWorker(draft);
      } catch {
        // spawn 失败由显式 finalization-required alert 表示，不能回退为 trusted receipt。
        writeReceiptFinalizationAlert(draft, "worker_spawn_failed");
      }
      throw new DesktopResultPendingError(draft);
    }
    if (firstOwnership.ownership === "native_continuation") {
      // Continuation chain 只在第一次 output/record 写入前再次读取；exact
      // origin 路径保持原有单次 current-result 校验。
      const acceptedBeforeWrite = assertDesktopResultContext(workspace, input.commandId, threadId);
      if (acceptedBeforeWrite.turnId !== acceptedNow.turnId || acceptedBeforeWrite.deliveryId !== acceptedNow.deliveryId) {
        return failClosed("DESKTOP_RESULT_THREAD", "accepted Desktop 投递在记录期间发生变化；拒绝写入结果。");
      }
      const secondOwnership = await assertCurrentResultContext(workspace, acceptedBeforeWrite);
      if (!sameOwnership(firstOwnership, secondOwnership)) {
        return failClosed("DESKTOP_RESULT_CURRENT_EXECUTION", "Desktop continuation 在写入前发生漂移；拒绝写入结果。");
      }
    }
    prepareReceiptCommit(options.beforeReceiptCommit, false);
    // 输出先提交；若随后记录追加中断，下次会通过 taskId 发现孤立 output 并 fail closed。
    const output = input.output !== undefined
      ? saveExecutionOutput(workspace.id, {
          command: input.command ?? `Desktop result ${input.commandId}`,
          raw: input.output,
          exitCode: input.exitCode,
          taskId,
          iteration: 1,
        })
      : input.outputRestrictedReason !== undefined
        ? saveRestrictedExecutionOutput(workspace.id, {
            command: input.command ?? `Desktop result ${input.commandId}`,
            reason: input.outputRestrictedReason,
            exitCode: input.exitCode,
            taskId,
            iteration: 1,
          })
        : null;
    const record: StoredExecutionRecord = {
      taskId,
      iteration: 1,
      changedFiles: [...input.changedFiles],
      tests: input.tests,
      exitStatus: input.exitStatus,
      timestamp: new Date().toISOString(),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
      rawSummary,
      ...(output === null ? {} : { outputId: output.id, outputAvailable: output.allowed }),
      commandId: input.commandId,
      desktopReceiptSha256: digest,
      desktopThreadId: threadId,
      desktopOriginTurnId: acceptedNow.turnId!,
      desktopResultTurnId: firstOwnership.resultTurnId,
      desktopBindingId: acceptedNow.bindingId,
    };
    appendExecutionRecordLocked(workspace.id, record);
    return { record, output };
  });
}

/** 已有 exact terminal 时的只读恢复；context 可用且 turn 不一致仍拒绝。 */
async function recoverPriorDesktopResult(
  workspace: DesktopResultWorkspace,
  accepted: DesktopDelivery,
  prior: StoredExecutionRecord,
): Promise<DesktopResultReceipt> {
  try {
    await assertCurrentResultContext(workspace, accepted);
    return { record: prior, output: outputForRecord(workspace.id, prior) };
  } catch (error) {
    const code = error instanceof DesktopError ? error.code : null;
    const durable = code === "DESKTOP_STATE_UNAVAILABLE" || code === "DESKTOP_IPC_UNAVAILABLE" ||
      code === "DESKTOP_IPC_TIMEOUT" || code === "DESKTOP_IPC_REJECTED";
    if (!durable) throw error;
    // UI context 消失不推翻已写入的 exact terminal；不创建新记录、不改 digest。
    return { record: prior, output: outputForRecord(workspace.id, prior) };
  }
}
