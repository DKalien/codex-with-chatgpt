export type CompletionSignal = {
  type: "execution_ended";
  version: 1;
  workspaceId: string;
  commandId: string;
  taskId: string;
  attemptId: string;
};

const FIELDS = ["type", "version", "workspaceId", "commandId", "taskId", "attemptId"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** signal-v1 正文冻结；未来文案变更必须升级格式版本，避免旧 journal/hash 冲突。 */
export function renderCompletionNotification(signal: unknown): string {
  if (!signal || typeof signal !== "object" || Array.isArray(signal)) {
    throw new Error("completion signal invalid");
  }
  const value = signal as Record<string, unknown>;
  if (Object.keys(value).length !== FIELDS.length || !FIELDS.every(key => Object.hasOwn(value, key))
    || value.type !== "execution_ended" || value.version !== 1
    || typeof value.workspaceId !== "string" || !/^[a-f0-9]{12}$/.test(value.workspaceId)
    || typeof value.commandId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.commandId)
    || typeof value.taskId !== "string"
    || (!/^desktop_[A-Za-z0-9_-]{1,128}$/.test(value.taskId) && !UUID.test(value.taskId))
    || typeof value.attemptId !== "string" || !UUID.test(value.attemptId)
    || [value.workspaceId, value.commandId, value.taskId, value.attemptId].some(id => /[\r\n\t\u2028\u2029]/.test(id))) {
    throw new Error("completion signal invalid");
  }
  return [
    "本轮执行已结束，请读取结果（自动通知，非新授权）。",
    `WORKSPACE_ID: ${value.workspaceId} | COMMAND_ID: ${value.commandId} | TASK_ID: ${value.taskId}`,
    `ATTEMPT_ID: ${value.attemptId}`,
  ].join("\n");
}
