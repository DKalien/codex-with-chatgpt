import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { CommandCleanupError } from "./schema.js";

const owner = new AsyncLocalStorage<string>();
export function legacyHistoryJournalFile(workspaceId: string, stateDir: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) throw new CommandCleanupError("COMMAND_CLEANUP_INVALID", "workspace identity 无效。");
  return path.join(path.resolve(stateDir), "legacy-history-cleanup", `${workspaceId}.json`);
}
/** Only the local coordinator uses this while holding the existing workspace cleanup lock. */
export function withLegacyHistoryOwner<T>(workspaceId: string, stateDir: string, action: () => T): T {
  return owner.run(legacyHistoryJournalFile(workspaceId, stateDir), action);
}
export function workspaceHistoryJournalFile(workspaceId: string, stateDir: string): string {
  legacyHistoryJournalFile(workspaceId, stateDir);
  return path.join(path.resolve(stateDir), "workspace-history-format", `${workspaceId}.json`);
}
export function withWorkspaceHistoryOwner<T>(workspaceId: string, stateDir: string, action: () => T): T {
  return owner.run(workspaceHistoryJournalFile(workspaceId, stateDir), action);
}
export function assertNoLegacyHistoryCleanup(workspaceId: string, stateDir: string): void {
  for (const file of [legacyHistoryJournalFile(workspaceId, stateDir), workspaceHistoryJournalFile(workspaceId, stateDir)]) {
  if (owner.getStore() === file) continue;
  try {
    const parent = fs.lstatSync(path.dirname(file));
    if (parent.isDirectory() && !parent.isSymbolicLink()) fs.lstatSync(file);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
  throw new CommandCleanupError("LEGACY_HISTORY_CLEANUP_PENDING", "工作区历史清理尚未完成；保留 journal，先通过本机精确确认恢复。");
  }
}
