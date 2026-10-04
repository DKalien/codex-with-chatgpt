import {
  desktopIpc,
  type DesktopResultClassification,
  type DesktopResultContext,
  type DesktopResultOwnership,
  type DesktopResultOwnershipExpectation,
  type DesktopResultActivityMarkerObservation,
  type DesktopRuntimeFence,
  type DesktopTarget,
} from "./ipc.js";
import {
  DesktopError,
  readDesktop,
  type DesktopDelivery,
} from "./store.js";
import { SAFE_CODES } from "./ipc-errors.js";
import {
  CurrentDesktopDelivery,
  DesktopResultError,
  DesktopResultWorkspace,
  RESULT_CONTEXT_ATTEMPTS,
  RESULT_CONTEXT_RETRY_DELAY_MS,
  uuid,
  workspaceInput,
} from "./result-schema.js";
import {
  receiptFinalizationMarkerDigest,
  type ReceiptFinalizationDraft,
  type ReceiptFinalizationFenceResult,
  type ReceiptFinalizationMarkedDraft,
  type ReceiptFinalizationOwnershipSnapshot,
} from "./receipt-finalizer-schema.js";

function waitForResultContextRetry(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, RESULT_CONTEXT_RETRY_DELAY_MS));
}

export function currentThreadId(): string {
  const value = process.env.CODEX_THREAD_ID;
  if (!uuid.safeParse(value).success) {
    throw new DesktopResultError("DESKTOP_RESULT_CONTEXT", "缺少有效的 CODEX_THREAD_ID；拒绝记录 Desktop 结果。");
  }
  return value!;
}

export function readDesktopResultDelivery(workspace: DesktopResultWorkspace, commandId: string, threadId: string): DesktopDelivery {
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

export function assertDesktopResultContext(workspace: DesktopResultWorkspace, commandId: string, threadId: string): DesktopDelivery {
  const delivery = readDesktopResultDelivery(workspace, commandId, threadId);
  if (delivery.deliveryStatus !== "accepted") {
    throw new DesktopResultError("DESKTOP_RESULT_THREAD", "没有与当前 commandId 和 CODEX_THREAD_ID 匹配的 accepted Desktop 投递；拒绝记录执行结果。");
  }
  return delivery;
}

function strictUuid(value: unknown): value is string {
  return typeof value === "string" && value === value.toLowerCase() && uuid.safeParse(value).success;
}

export async function assertCurrentResultContext(
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

export function sameOwnership(left: DesktopResultOwnership, right: DesktopResultOwnership): boolean {
  return left.ownership === right.ownership && left.originTurnId === right.originTurnId &&
    left.deliveryId === right.deliveryId && left.originAlias === right.originAlias &&
    left.resultTurnId === right.resultTurnId && left.chainLength === right.chainLength &&
    left.signature === right.signature &&
    JSON.stringify(left.chainTurnIds) === JSON.stringify(right.chainTurnIds) &&
    JSON.stringify(left.chainSignatures) === JSON.stringify(right.chainSignatures);
}

export async function readCurrentResultContext(workspace: DesktopResultWorkspace, expectedThreadId: string): Promise<DesktopResultContext> {
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

export async function inspectResultActivityMarker(target: DesktopTarget, runtimeFence: DesktopRuntimeFence): Promise<DesktopResultActivityMarkerObservation> {
  return desktopIpc.inspectResultActivityMarker(target, runtimeFence);
}

export function resolveReceiptFinalizationTarget(draft: ReceiptFinalizationDraft): DesktopTarget {
  const state = readDesktop(draft.workspaceId);
  if (!state || state.workspaceRoot !== draft.workspaceRoot || !state.binding ||
      state.binding.threadId !== draft.threadId) {
    throw new DesktopError("DESKTOP_TARGET_NOT_FOUND", "Desktop durable binding no longer matches pending receipt.");
  }
  const deliveries = state.deliveries.filter(delivery =>
    delivery.deliveryStatus === "accepted" && delivery.commandId === draft.commandId &&
    delivery.threadId === draft.threadId && delivery.turnId === draft.originTurnId,
  );
  if (deliveries.length !== 1) {
    throw new DesktopError("DESKTOP_RECONCILIATION_CONFLICT", "pending receipt has no unique accepted delivery.");
  }
  if (draft.version === 3) {
    const accepted = deliveries[0]!;
    const expected = draft.ownershipSnapshot;
    if (accepted.deliveryId !== expected.deliveryId || accepted.intent !== expected.intent ||
        accepted.messageBytes !== expected.messageBytes || accepted.messageSha256 !== expected.messageSha256) {
      throw new DesktopError("DESKTOP_RECONCILIATION_CONFLICT", "pending receipt accepted identity changed.");
    }
  }
  return {
    threadId: state.binding.threadId,
    hostId: state.binding.hostId,
    projectId: state.binding.projectId,
    workspaceRoot: draft.workspaceRoot,
  };
}

export async function inspectReceiptFinalizationFence(
  target: DesktopTarget,
  draft: ReceiptFinalizationMarkedDraft,
): Promise<ReceiptFinalizationFenceResult> {
  const state = readDesktop(draft.workspaceId);
  if (!state || state.workspaceRoot !== draft.workspaceRoot || !state.runtimeFence) {
    throw new DesktopError("DESKTOP_RUNTIME_FENCE_MISSING", "Desktop 绑定缺少运行时身份 fence；请重新绑定当前 Desktop 会话。");
  }
  let fence: ReceiptFinalizationFenceResult;
  if (draft.version === 3) {
    const observed = await inspectPendingReceipt(target, draft, state.runtimeFence);
    if (!finalizationOwnershipMatches(draft.ownershipSnapshot, observed)) {
      throw new DesktopError("DESKTOP_PROCESS_CHANGED", "pending receipt ownership chain changed.");
    }
    fence = observed;
  } else {
    fence = await desktopIpc.inspectResultTerminalFence(target, draft.marker, state.runtimeFence);
  }
  if (fence.threadId !== target.threadId || fence.hostId !== target.hostId ||
      fence.projectId !== target.projectId || fence.workspaceRoot !== target.workspaceRoot) {
    throw new DesktopError("DESKTOP_PROCESS_CHANGED", "Desktop receipt terminal fence identity changed.");
  }
  if (!["inProgress", "completed", "failed", "interrupted", "cancelled"].includes(fence.resultTurnStatus)) {
    throw new DesktopError("DESKTOP_STATE_UNAVAILABLE", "Desktop receipt terminal fence status is invalid.");
  }
  return fence;
}

export async function inspectLegacyReceiptFinalizationContext(
  target: DesktopTarget,
  draft: ReceiptFinalizationDraft,
): Promise<DesktopResultContext> {
  const state = readDesktop(draft.workspaceId);
  if (!state || state.workspaceRoot !== draft.workspaceRoot || !state.runtimeFence) {
    throw new DesktopError("DESKTOP_RUNTIME_FENCE_MISSING", "Desktop 绑定缺少运行时身份 fence；请重新绑定当前 Desktop 会话。");
  }
  const context = await desktopIpc.inspectResultContext(target, state.runtimeFence);
  if (context.threadId !== draft.threadId || context.workspaceRoot !== draft.workspaceRoot ||
      context.projectId !== target.projectId || context.hostId !== target.hostId) {
    throw new DesktopError("DESKTOP_PROCESS_CHANGED", "Desktop receipt result context identity changed.");
  }
  return context;
}

export async function assertResultActivityMarker(
  workspace: DesktopResultWorkspace,
  expectedThreadId: string,
  target: DesktopTarget,
  resultTurnId: string,
): Promise<DesktopResultActivityMarkerObservation> {
  let observed: DesktopResultActivityMarkerObservation;
  const state = readDesktop(workspace.id);
  if (!state || state.workspaceRoot !== workspace.root || !state.runtimeFence) {
    throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "Desktop 绑定缺少运行时身份 fence；未写入 pending receipt。 ");
  }
  try { observed = await desktopIpc.inspectResultActivityMarker(target, state.runtimeFence); }
  catch (error) {
    const code = error instanceof DesktopError && SAFE_CODES.has(error.code) ? error.code : "DESKTOP_INTERNAL_ERROR";
    throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", `无法建立 Desktop receipt activity marker（${code}）；未写入 pending receipt。 `);
  }
  const marker = observed.marker;
  if (observed.threadId !== expectedThreadId || observed.workspaceRoot !== workspace.root || observed.hostId !== target.hostId ||
      observed.projectId !== target.projectId || observed.resultTurnId !== resultTurnId || observed.resultTurnStatus !== "inProgress" ||
      marker.resultTurnId !== resultTurnId || marker.itemIds.length !== marker.itemCount || marker.itemTypes.length !== marker.itemCount ||
      receiptFinalizationMarkerDigest(marker) !== marker.itemSha256) {
    throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "Desktop receipt activity marker 身份或摘要不一致；未写入 pending receipt。 ");
  }
  return observed;
}

export function finalizationOwnershipSnapshot(
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
    workspaceId: workspace.id, commandId: accepted.commandId, threadId: ownership.threadId,
    hostId: "local", projectId: ownership.projectId, workspaceRoot: ownership.workspaceRoot,
    intent: accepted.intent, messageBytes: accepted.messageBytes, messageSha256: accepted.messageSha256,
    ownership: ownership.ownership, originTurnId: ownership.originTurnId,
    ...(accepted.deliveryId === undefined ? {} : { deliveryId: accepted.deliveryId }),
    originAlias: ownership.originAlias, resultTurnId: ownership.resultTurnId,
    chainTurnIds: [...ownership.chainTurnIds], chainLength: ownership.chainLength,
    chainSignatures: [...ownership.chainSignatures], signature: ownership.signature,
  };
}

function inspectPendingReceipt(
  target: DesktopTarget,
  draft: Extract<ReceiptFinalizationMarkedDraft, { version: 3 }>,
  runtimeFence: DesktopRuntimeFence,
) {
  const snapshot = draft.ownershipSnapshot;
  const expectation: DesktopResultOwnershipExpectation = {
    workspaceId: draft.workspaceId, commandId: draft.commandId, intent: snapshot.intent,
    messageBytes: snapshot.messageBytes, messageSha256: snapshot.messageSha256,
    originTurnId: draft.originTurnId,
    ...(snapshot.deliveryId === undefined ? {} : { deliveryId: snapshot.deliveryId }),
  };
  return desktopIpc.inspectPendingReceipt(target, expectation, draft.marker, runtimeFence);
}

function finalizationOwnershipMatches(snapshot: ReceiptFinalizationOwnershipSnapshot, ownership: DesktopResultOwnership): boolean {
  return snapshot.threadId === ownership.threadId && snapshot.hostId === ownership.hostId &&
    snapshot.projectId === ownership.projectId && snapshot.workspaceRoot === ownership.workspaceRoot &&
    snapshot.ownership === ownership.ownership && snapshot.originTurnId === ownership.originTurnId &&
    snapshot.deliveryId === ownership.deliveryId && snapshot.originAlias === ownership.originAlias &&
    snapshot.resultTurnId === ownership.resultTurnId && snapshot.chainLength === ownership.chainLength &&
    snapshot.signature === ownership.signature && JSON.stringify(snapshot.chainTurnIds) === JSON.stringify(ownership.chainTurnIds) &&
    JSON.stringify(snapshot.chainSignatures) === JSON.stringify(ownership.chainSignatures);
}

export async function assertFinalizationOwnership(
  workspace: DesktopResultWorkspace,
  draft: Extract<ReceiptFinalizationMarkedDraft, { version: 3 }>,
  target: DesktopTarget,
  accepted: DesktopDelivery,
): Promise<void> {
  const snapshot = draft.ownershipSnapshot;
  if (!accepted.turnId || !accepted.intent || accepted.commandId !== draft.commandId || accepted.threadId !== draft.threadId ||
      accepted.turnId !== draft.originTurnId || accepted.deliveryId !== snapshot.deliveryId ||
      accepted.intent !== snapshot.intent || accepted.messageBytes !== snapshot.messageBytes ||
      accepted.messageSha256 !== snapshot.messageSha256 || workspace.id !== snapshot.workspaceId ||
      workspace.root !== snapshot.workspaceRoot || snapshot.threadId !== target.threadId || snapshot.hostId !== target.hostId ||
      snapshot.projectId !== target.projectId || snapshot.workspaceRoot !== target.workspaceRoot ||
      snapshot.resultTurnId !== draft.resultTurnId || snapshot.resultTurnId !== draft.marker.resultTurnId) {
    throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "pending receipt ownership snapshot 身份不一致；拒绝写入。 ");
  }
  const state = readDesktop(workspace.id);
  if (!state || state.workspaceRoot !== workspace.root || !state.runtimeFence) {
    throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "Desktop 绑定缺少运行时身份 fence；拒绝写入。 ");
  }
  let ownership: DesktopResultOwnership;
  try {
    const observed = await inspectPendingReceipt(target, draft, state.runtimeFence);
    if (observed.fence !== "safe_terminal") throw new Error("terminal fence changed before commit");
    ownership = observed;
  }
  catch { throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "无法按精确 Desktop target 重新证明 pending receipt ownership；拒绝写入。 "); }
  if (ownership.resultTurnId !== draft.resultTurnId || !finalizationOwnershipMatches(snapshot, ownership)) {
    throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "pending receipt ownership chain 在终态期间发生漂移；拒绝写入。 ");
  }
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
  // outcome_unknown 仍是未完成投递；这里只允许它作为当前 self-attested
  // command 的入口候选，后续必须经过 reconcileUnknownDesktopDelivery 才能变为 accepted。
  const candidates = state.deliveries.filter(item => item.threadId === threadId &&
    (item.deliveryStatus === "accepted" || item.deliveryStatus === "outcome_unknown"));
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
  const exactOrigin = !!accepted && classification.originAlias === null &&
    (accepted.deliveryStatus === "outcome_unknown" || classification.originTurnId === accepted.turnId);
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
