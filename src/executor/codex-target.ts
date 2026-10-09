import { ENDPOINT_SAFE_ID } from "../endpoints/schema.js";

export class CodexTargetTranslationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CodexTargetTranslationError";
  }
}

/** Codex locator 的唯一键和值边界；调用方保留自己的错误码映射。 */
export function codexExecutorProjectId(locator: Readonly<Record<string, string>>): string {
  const keys = Object.keys(locator);
  if (keys.length !== 1 || keys[0] !== "executorProjectId") {
    throw new CodexTargetTranslationError("LOCATOR_INVALID", "Codex locator 必须且只包含 executorProjectId");
  }
  const projectId = locator.executorProjectId;
  if (typeof projectId !== "string" || !ENDPOINT_SAFE_ID.test(projectId)) {
    throw new CodexTargetTranslationError("LOCATOR_INVALID", "executorProjectId 不是有效 bounded 值");
  }
  return projectId;
}
