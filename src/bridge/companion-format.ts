import fs from "node:fs";
import { getStateDir } from "../config/paths.js";
import { workspaceHistoryJournalFile } from "../command-cleanup/legacy-history-fence.js";
import { authenticateOperations } from "./companion-operation-auth.js";
import { readPanelAuthorization } from "../feedback/panel.js";
import { FeedbackError } from "../feedback/schema.js";
import { resolveWorkspaceIdentity } from "../routing/store.js";
import { previewWorkspaceHistoryFormat, confirmWorkspaceHistoryFormat, workspaceHistoryFormatResult } from "../command-cleanup/workspace-history.js";
import type { PanelContext } from "./companion-actions.js";
function authorize(input: PanelContext) {
  authenticateOperations(input);
  const permission = readPanelAuthorization(input.workspaceId, input.stateDir);
  if (!permission.enabled || !permission.actions.includes("cleanup"))
    throw new FeedbackError("PANEL_LOCAL_AUTHORIZATION_REQUIRED", "永久格式化需要当前 Companion 的本机限时 cleanup 授权。");
  return resolveWorkspaceIdentity({ id: input.workspaceId, root: input.workspaceRoot });
}
export function previewCompanionFormat(input: PanelContext) {
  return previewWorkspaceHistoryFormat(authorize(input), input.stateDir);
}
export function confirmCompanionFormat(input: PanelContext, confirmationSha256: string) {
  let identity;
  try { identity = authorize(input); }
  catch (error) {
    if (!fs.existsSync(workspaceHistoryJournalFile(input.workspaceId, input.stateDir ?? getStateDir())) && error instanceof Error)
      Object.assign(error, { formatNoMutation: true, workspaceId: input.workspaceId, confirmationSha256 });
    throw error;
  }
  return confirmWorkspaceHistoryFormat(identity, confirmationSha256, input.stateDir, () => { authorize(input); });
}
export function readCompanionFormatResult(input: PanelContext, confirmationSha256: string) {
  authenticateOperations(input);
  return workspaceHistoryFormatResult({ id: input.workspaceId, root: input.workspaceRoot }, confirmationSha256, input.stateDir);
}
