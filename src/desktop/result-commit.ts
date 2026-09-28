import { createHash } from "node:crypto";
import { listExecutionOutputs, saveExecutionOutput, saveRestrictedExecutionOutput, type ExecutionOutputMeta } from "../execution/output.js";
import { appendExecutionRecordLocked, type StoredExecutionRecord } from "../execution/records.js";
import {
  canonicalReceiptFinalizationInput,
  sanitizeReceiptFinalizationInput,
  type ReceiptFinalizationInput,
} from "./receipt-finalizer-schema.js";
import { DesktopResultError, DesktopResultReceipt, DesktopResultWorkspace } from "./result-schema.js";

export function canonicalInput(input: ReceiptFinalizationInput): string {
  return canonicalReceiptFinalizationInput(sanitizeReceiptFinalizationInput(input));
}

export function receiptHash(input: ReceiptFinalizationInput): string {
  return createHash("sha256").update(canonicalInput(input), "utf8").digest("hex");
}

export function failClosed(code: string, message: string): never {
  throw new DesktopResultError(code, message);
}

export function existingRecord(
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

export function outputForRecord(workspaceId: string, record: StoredExecutionRecord): ExecutionOutputMeta | null {
  if (record.outputId === undefined) return null;
  try {
    return listExecutionOutputs(workspaceId, Number.MAX_SAFE_INTEGER).find(item => item.id === record.outputId) ?? null;
  } catch {
    return failClosed("DESKTOP_RESULT_OUTPUT_CORRUPT", "执行输出状态损坏；保留原文件并人工核对，拒绝重放结果。");
  }
}

export function hasPartialOutput(workspaceId: string, taskId: string): boolean {
  try {
    return listExecutionOutputs(workspaceId, Number.MAX_SAFE_INTEGER).some(item => item.taskId === taskId);
  } catch {
    return failClosed("DESKTOP_RESULT_OUTPUT_CORRUPT", "执行输出状态损坏；保留原文件并人工核对，拒绝追加结果。");
  }
}

export function prepareReceiptCommit(
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

/** 唯一的 trusted Desktop receipt/output 提交原语；调用方只负责完成证据校验和构造记录事实。 */
export function appendTrustedReceiptLocked(
  workspaceId: string,
  input: ReceiptFinalizationInput,
  record: Omit<StoredExecutionRecord, "outputId" | "outputAvailable">,
): DesktopResultReceipt {
  const output = input.output !== undefined
    ? saveExecutionOutput(workspaceId, {
        command: input.command ?? `Desktop result ${record.commandId}`,
        raw: input.output,
        exitCode: input.exitCode,
        taskId: record.taskId,
        iteration: record.iteration,
      })
    : input.outputRestrictedReason !== undefined
      ? saveRestrictedExecutionOutput(workspaceId, {
          command: input.command ?? `Desktop result ${record.commandId}`,
          reason: input.outputRestrictedReason,
          exitCode: input.exitCode,
          taskId: record.taskId,
          iteration: record.iteration,
        })
      : null;
  const committed: StoredExecutionRecord = {
    ...record,
    ...(output === null ? {} : { outputId: output.id, outputAvailable: output.allowed }),
  };
  appendExecutionRecordLocked(workspaceId, committed);
  return { record: committed, output };
}
