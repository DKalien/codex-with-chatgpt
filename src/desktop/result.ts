import { createHash } from "node:crypto";
import { z } from "zod";
import { listExecutionOutputs, saveExecutionOutput, type ExecutionOutputMeta } from "../execution/output.js";
import {
  appendExecutionRecordLocked,
  readExecutionRecordsStrict,
  withExecutionRecordsLockAsync,
  type StoredExecutionRecord,
} from "../execution/records.js";
import { desktopIpc, type DesktopResultContext } from "./ipc.js";
import {
  DesktopError,
  desktopId,
  readDesktop,
  type DesktopDelivery,
} from "./store.js";

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

function assertDesktopResultContext(workspace: DesktopResultWorkspace, commandId: string, threadId: string): DesktopDelivery {
  const state = readDesktop(workspace.id);
  if (!state) {
    throw new DesktopResultError("DESKTOP_RESULT_STATE", "当前工作区没有 Desktop 授权历史；拒绝记录执行结果。");
  }
  if (state.workspaceRoot !== workspace.root) {
    throw new DesktopResultError("DESKTOP_WRONG_WORKSPACE", "当前工作区根目录与 Desktop 状态不一致；拒绝记录执行结果。");
  }
  const accepted = state.deliveries.find(item => item.commandId === commandId && item.deliveryStatus === "accepted" && item.threadId === threadId);
  if (!accepted) {
    throw new DesktopResultError("DESKTOP_RESULT_THREAD", "没有与当前 commandId 和 CODEX_THREAD_ID 匹配的 accepted Desktop 投递；拒绝记录执行结果。");
  }
  return accepted;
}

function strictUuid(value: unknown): value is string {
  return typeof value === "string" && value === value.toLowerCase() && uuid.safeParse(value).success;
}

async function assertCurrentResultContext(
  workspace: DesktopResultWorkspace,
  accepted: DesktopDelivery,
): Promise<void> {
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
      context.threadId !== accepted.threadId || context.resultTurnId !== accepted.turnId ||
      (context.runtimeStatus === "idle" && !terminal) ||
      ((context.runtimeStatus === "active" || context.runtimeStatus === "inProgress") && context.resultTurnStatus !== "inProgress")) {
    throw new DesktopResultError("DESKTOP_RESULT_CURRENT_EXECUTION", "当前 Desktop result context 与 accepted 投递的 thread、workspace 或 turn 不一致；拒绝记录执行结果。");
  }
}

function canonicalInput(input: DesktopResultInput): string {
  return JSON.stringify({
    commandId: input.commandId,
    changedFiles: [...input.changedFiles],
    tests: input.tests,
    exitStatus: input.exitStatus,
    notes: input.notes ?? null,
    command: input.command ?? null,
    output: input.output ?? null,
    exitCode: input.exitCode ?? null,
  });
}

function receiptHash(input: DesktopResultInput): string {
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

/**
 * 记录已由 Desktop 接受的本次结果。CODEX_THREAD_ID 仅提供调用线程候选，
 * 还必须通过新鲜 current result context 与同工作区历史 accepted delivery 的 turn 校验；
 * 不信任当前 enabled/binding。
 */
export async function recordDesktopResult(
  workspaceRaw: DesktopResultWorkspace,
  rawInput: DesktopResultInput,
): Promise<DesktopResultReceipt> {
  const workspace = workspaceInput.parse(workspaceRaw);
  const input = desktopResultInput.parse(rawInput);
  const threadId = currentThreadId();
  const accepted = assertDesktopResultContext(workspace, input.commandId, threadId);
  await assertCurrentResultContext(workspace, accepted);

  const taskId = `desktop_${input.commandId}`;
  const digest = receiptHash(input);
  return withExecutionRecordsLockAsync(workspace.id, async () => {
    // execution 锁只串行化记录；在输出或追加前再次验证状态，避免校验后 workspace 被撤权/损坏。
    const acceptedNow = assertDesktopResultContext(workspace, input.commandId, threadId);
    if (acceptedNow.turnId !== accepted.turnId) {
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
      await assertCurrentResultContext(workspace, acceptedNow);
      return { record: prior, output: outputForRecord(workspace.id, prior) };
    }
    if (hasPartialOutput(workspace.id, taskId)) {
      return failClosed("DESKTOP_RESULT_PARTIAL", "已有未完成的 Desktop 结果输出但缺少执行记录；拒绝追加或覆盖，请人工核对。");
    }

    await assertCurrentResultContext(workspace, acceptedNow);
    // 输出先提交；若随后记录追加中断，下次会通过 taskId 发现孤立 output 并 fail closed。
    const output = input.output === undefined ? null : saveExecutionOutput(workspace.id, {
      command: input.command ?? `Desktop result ${input.commandId}`,
      raw: input.output,
      exitCode: input.exitCode,
      taskId,
      iteration: 1,
    });
    const record: StoredExecutionRecord = {
      taskId,
      iteration: 1,
      changedFiles: [...input.changedFiles],
      tests: input.tests,
      exitStatus: input.exitStatus,
      timestamp: new Date().toISOString(),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
      ...(output === null ? {} : { outputId: output.id, outputAvailable: output.allowed }),
      commandId: input.commandId,
      desktopReceiptSha256: digest,
    };
    appendExecutionRecordLocked(workspace.id, record);
    return { record, output };
  });
}
