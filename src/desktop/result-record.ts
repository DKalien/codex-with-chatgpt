import {
  readExecutionRecordsStrict,
  withExecutionRecordsLockAsync,
  type StoredExecutionRecord,
} from "../execution/records.js";
import { DesktopError, readDesktop, type DesktopDelivery } from "./store.js";
import { reconcileUnknownDesktopDelivery } from "./unknown-reconciliation.js";
import {
  sanitizeReceiptFinalizationInput,
  type ReceiptFinalizationDraft,
} from "./receipt-finalizer-schema.js";
import { stageReceiptFinalization, writeReceiptFinalizationAlert } from "./receipt-finalizer-store.js";
import { spawnReceiptFinalizerWorker } from "./receipt-finalizer-worker.js";
import {
  DesktopResultError,
  DesktopResultPendingError,
  desktopResultInput,
  type DesktopResultInput,
  type DesktopResultReceipt,
  type DesktopResultWorkspace,
  workspaceInput,
} from "./result-schema.js";
import {
  assertCurrentResultContext,
  assertDesktopResultContext,
  currentThreadId,
  finalizationOwnershipSnapshot,
  assertResultActivityMarker,
  readCurrentResultContext,
  readDesktopResultDelivery,
  sameOwnership,
} from "./result-evidence.js";
import {
  existingRecord,
  appendTrustedReceiptLocked,
  failClosed,
  hasPartialOutput,
  outputForRecord,
  prepareReceiptCommit,
  receiptHash,
} from "./result-commit.js";

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
    await readCurrentResultContext(workspace, threadId);
    const reconciled = await reconcileUnknownDesktopDelivery(workspace, input.commandId);
    if (reconciled.status !== "accepted") {
      throw new DesktopResultError("DESKTOP_RESULT_THREAD", "Desktop 投递没有唯一精确的 canonical history origin 候选；未记录执行结果。");
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
      const observed = await assertResultActivityMarker(workspace, threadId, target, firstOwnership.resultTurnId);
      const marker = observed.marker;
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
    const record: StoredExecutionRecord = {
      taskId,
      iteration: 1,
      changedFiles: [...input.changedFiles],
      tests: input.tests,
      exitStatus: input.exitStatus,
      timestamp: new Date().toISOString(),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
      rawSummary,
      commandId: input.commandId,
      desktopReceiptSha256: digest,
      desktopThreadId: threadId,
      desktopOriginTurnId: acceptedNow.turnId!,
      desktopResultTurnId: firstOwnership.resultTurnId,
      desktopBindingId: acceptedNow.bindingId,
    };
    return appendTrustedReceiptLocked(workspace.id, input, record);
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
