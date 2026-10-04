import { getStateDir } from "../config/paths.js";
import { readExecutionOutputMetadataStrict } from "../execution/output.js";
import {
  isTrustedDesktopReceipt,
  readExecutionRecordsStrict,
  withExecutionRecordsLockAsync,
  type StoredExecutionRecord,
} from "../execution/records.js";
import {
  type DesktopTarget,
} from "./ipc.js";
import { readDesktop, type DesktopDelivery } from "./store.js";
import {
  sanitizeReceiptFinalizationInput,
  type ReceiptFinalizationFenceResult,
  type ReceiptFinalizationMarkedDraft,
} from "./receipt-finalizer-schema.js";
import {
  DesktopResultError,
  DesktopResultReceipt,
  DesktopResultWorkspace,
  workspaceInput,
} from "./result-schema.js";
import {
  existingRecord,
  appendTrustedReceiptLocked,
  hasPartialOutput,
  outputForRecord,
  prepareReceiptCommit,
  receiptHash,
} from "./result-commit.js";
import { assertFinalizationOwnership } from "./result-evidence.js";
import { withCommandOperationAsync } from "../command-cleanup/fence.js";

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

/** Detached finalizer 的唯一写入口；复用 execution lock、output sanitizer 和 command 幂等。 */
export async function finalizeReceiptFinalizationDraft(
  draft: ReceiptFinalizationMarkedDraft,
  target: { threadId: string; hostId: string; projectId: string; workspaceRoot: string },
  fence: ReceiptFinalizationFenceResult,
  beforeReceiptCommit?: (receiptAlreadyExists: boolean) => void,
  stateDir = getStateDir(),
): Promise<DesktopResultReceipt> {
  return withCommandOperationAsync(draft.workspaceId, draft.commandId,
    () => finalizeReceiptFinalizationDraftLocked(draft, target, fence, beforeReceiptCommit, stateDir), stateDir);
}

async function finalizeReceiptFinalizationDraftLocked(
  draft: ReceiptFinalizationMarkedDraft,
  target: { threadId: string; hostId: string; projectId: string; workspaceRoot: string },
  fence: ReceiptFinalizationFenceResult,
  beforeReceiptCommit?: (receiptAlreadyExists: boolean) => void,
  stateDir = getStateDir(),
): Promise<DesktopResultReceipt> {
  const workspace = workspaceInput.parse({ id: draft.workspaceId, root: draft.workspaceRoot });
  assertFinalizationFence(draft, fence);
  assertFinalizationDelivery(workspace, draft, target);
  const input = sanitizeReceiptFinalizationInput(draft.input);
  const digest = receiptHash(input);
  if (digest !== draft.inputDigest || input.commandId !== draft.commandId) {
    throw new DesktopResultError("DESKTOP_RESULT_CONFLICT", "pending receipt input 摘要不一致；拒绝写入结果。 ");
  }
  const taskId = `desktop_${draft.commandId}`;
  return withExecutionRecordsLockAsync(workspace.id, async () => {
    const accepted = assertFinalizationDelivery(workspace, draft, target);
    if (draft.version === 3) await assertFinalizationOwnership(workspace, draft, target, accepted);
    let records: StoredExecutionRecord[];
    try { records = readExecutionRecordsStrict(workspace.id, stateDir); }
    catch (error) { throw new DesktopResultError("DESKTOP_RESULT_RECORDS_CORRUPT", error instanceof Error ? error.message : "执行记录损坏；拒绝继续。 "); }
    const prior = existingRecord(records, draft.commandId, taskId, digest);
    if (prior) {
      if (!isTrustedDesktopReceipt(prior, draft.commandId)) {
        throw new DesktopResultError("DESKTOP_RESULT_CONFLICT", "已有记录不是唯一可信 Desktop receipt；拒绝重放。 ");
      }
      const output = outputForRecord(workspace.id, prior, stateDir);
      const matchingOutputs = readExecutionOutputMetadataStrict(workspace.id, stateDir)
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
    if (hasPartialOutput(workspace.id, taskId, stateDir)) {
      throw new DesktopResultError("DESKTOP_RESULT_PARTIAL", "已有未完成的 Desktop 结果输出但缺少执行记录；拒绝追加。 ");
    }
    if (input.rawSummary !== undefined) {
      if (draft.version === 3) assertFinalizationDeliveryStable(workspace, draft, target, accepted);
      prepareReceiptCommit(beforeReceiptCommit, false);
    }
    const acceptedBeforeOutput = draft.version === 3
      ? assertFinalizationDeliveryStable(workspace, draft, target, accepted)
      : accepted;
    const record: StoredExecutionRecord = {
      taskId,
      iteration: 1,
      changedFiles: [...input.changedFiles],
      tests: input.tests,
      exitStatus: input.exitStatus,
      timestamp: new Date().toISOString(),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
      ...(input.rawSummary === undefined ? {} : { rawSummary: input.rawSummary }),
      commandId: draft.commandId,
      desktopReceiptSha256: digest,
      desktopThreadId: draft.threadId,
      desktopOriginTurnId: draft.originTurnId,
      desktopResultTurnId: draft.resultTurnId,
      desktopBindingId: acceptedBeforeOutput.bindingId,
    };
    if (draft.version === 3) assertFinalizationDeliveryStable(workspace, draft, target, acceptedBeforeOutput);
    const committedReceipt = appendTrustedReceiptLocked(workspace.id, input, record, stateDir);
    const output = committedReceipt.output;
    const committed = readExecutionRecordsStrict(workspace.id, stateDir)
      .filter(item => item.commandId === draft.commandId && item.taskId === taskId);
    if (committed.length !== 1 || !isTrustedDesktopReceipt(committed[0], draft.commandId)) {
      throw new DesktopResultError("DESKTOP_RESULT_CONFLICT", "Desktop receipt 未形成唯一可信终态；拒绝报告成功。 ");
    }
    const outputs = readExecutionOutputMetadataStrict(workspace.id, stateDir)
      .filter(item => item.taskId === taskId && item.iteration === 1);
    if ((output === null && outputs.length !== 0) || (output !== null && outputs.length !== 1)) {
      throw new DesktopResultError("DESKTOP_RESULT_PARTIAL", "Desktop receipt output 数量不唯一；拒绝报告成功。 ");
    }
    return { record: committed[0], output };
  }, stateDir);
}
