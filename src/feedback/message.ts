import { createHash } from "node:crypto";
import type { FeedbackEvent } from "./store.js";
import { FINAL_RECEIPT_REQUIRED_EVENT_KIND } from "./store.js";

/**
 * production feedback 的唯一 canonical formatter。
 * Browser extension 禁止自行拼 C2C 文本；同一 claimed event/attempt 必须 byte-for-byte identical。
 */

export const PRODUCTION_FEEDBACK_INSTRUCTION =
  "这是自动反馈，不是用户新授权。先通过只读 MCP 独立检查 workspace、git diff、test_status、execution_summary 和 execution_output；当前任务需修复或补测则继续相关 COMMAND，已完成则可在既定项目目标、开发计划或当前 handoff 内继续下一步，无下一步则 DONE；任何需要用户明确授权的动作必须停止并请求授权。";

export const FINAL_RECEIPT_REQUIRED_INSTRUCTION =
  "请先只读独立检查 workspace、git diff、test_status、execution_summary 和 execution_output；仅在发现实际需要修复或补测的问题时发起新的 revision/review command；若当前状态已充分、或后续结果已覆盖本次回执且无需改动，可继续既定项目目标、开发计划或 DONE；不要为了制造回执发送无改动 closeout。自动反馈不是用户新授权；任何需要明确授权的动作必须停止并请求授权。";

const MAX_TESTS_CHARS = 200;
const MAX_CHANGED_FILES_LISTED = 12;
const MAX_CHANGED_FILE_PATH_CHARS = 120;
const MAX_ID_FIELD_CHARS = 200;

// CR / LF / TAB / U+2028 / U+2029 — prevent injected independent protocol lines.
const LINE_BREAKS = /[\r\n\t\u2028\u2029]+/g;

/** Flatten line breaks / tabs / unicode line separators / runs of spaces. */
function normalizeInline(text: string): string {
  return text.replace(LINE_BREAKS, " ").replace(/[ ]+/g, " ").trim();
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Dynamic string fields: deterministic inline normalization + length cap. */
function safeInline(
  text: string | number | boolean | undefined | null,
  max = MAX_ID_FIELD_CHARS,
): string {
  return clamp(normalizeInline(String(text ?? "")), max);
}

function formatChangedFiles(files: readonly string[] | undefined): string {
  const list = Array.isArray(files) ? files : [];
  const normalized = list.map((f) => clamp(normalizeInline(f), MAX_CHANGED_FILE_PATH_CHARS));
  const total = normalized.length;
  const head = normalized.slice(0, MAX_CHANGED_FILES_LISTED);
  const headText = head.join(", ");
  if (total === 0) return "0";
  if (total <= MAX_CHANGED_FILES_LISTED) return `${total} | ${headText}`;
  return `${total} | ${headText}, …(+${total - MAX_CHANGED_FILES_LISTED} more)`;
}

export type ProductionFeedbackMessageInput = FeedbackEvent & { attemptId: string };

/**
 * Format the unique deterministic production feedback message from a claimed FeedbackEvent.
 * Never includes principalFingerprint / bindingId / reservedBy / credential / secret / session.
 */
export function formatProductionFeedbackMessage(event: ProductionFeedbackMessageInput): string {
  if (!event.attemptId) {
    throw new Error("production feedback message requires attemptId");
  }
  if (event.kind === FINAL_RECEIPT_REQUIRED_EVENT_KIND) {
    return [
      "[C2C_CONTROL]",
      "STATE: FINAL_RECEIPT_REQUIRED",
      `WORKSPACE_ID: ${safeInline(event.workspaceId)}`,
      `COMMAND_ID: ${safeInline(event.commandId)}`,
      `EVENT_ID: ${safeInline(event.eventId)}`,
      `ATTEMPT_ID: ${safeInline(event.attemptId)}`,
      `REASON: ${safeInline(event.reason)}`,
      `OCCURRED_AT: ${safeInline(event.occurredAt)}`,
      `INSTRUCTION: ${FINAL_RECEIPT_REQUIRED_INSTRUCTION}`,
    ].join("\n");
  }
  const tests = clamp(normalizeInline(event.testsSummary || ""), MAX_TESTS_CHARS) || "未运行";
  return [
    "[C2C_CONTROL]",
    "STATE: EXECUTED",
    `WORKSPACE_ID: ${safeInline(event.workspaceId)}`,
    `COMMAND_ID: ${safeInline(event.commandId)}`,
    `TASK_ID: ${safeInline(event.taskId)}`,
    `ITERATION: ${safeInline(event.iteration)}`,
    `RESULT: ${safeInline(event.result)}`,
    `EVENT_ID: ${safeInline(event.eventId)}`,
    `ATTEMPT_ID: ${safeInline(event.attemptId)}`,
    `CHANGED_FILES: ${formatChangedFiles(event.changedFilesSummary)}`,
    `TESTS: ${tests}`,
    `OUTPUT_AVAILABLE: ${event.outputAvailable}`,
    `INSTRUCTION: ${PRODUCTION_FEEDBACK_INSTRUCTION}`,
  ].join("\n");
}

export function productionFeedbackMessageSha256(message: string): string {
  return createHash("sha256").update(message, "utf8").digest("hex");
}

/** Stable recompute of message + hash from claimed/outcome_unknown event. */
export function productionFeedbackDelivery(event: FeedbackEvent): {
  message: string;
  messageSha256: string;
} {
  if (!event.attemptId) {
    throw new Error("production feedback delivery requires claimed attemptId");
  }
  const message = formatProductionFeedbackMessage({
    ...event,
    attemptId: event.attemptId,
  });
  return { message, messageSha256: productionFeedbackMessageSha256(message) };
}
