import type { Workspace } from "../workspace/manager.js";
import type { RemoteTask } from "./store.js";
import { enqueueResultBusEntry } from "../result-bus/store.js";
import { OFFICIAL_TESTS_UNKNOWN, officialResultSchema } from "../result-bus/official-result.js";

/** Replayable projection of an observed official turn; never imports or fabricates a receipt. */
export function projectRemoteResult(workspace: Workspace, task: RemoteTask): void {
  // Legacy Remote tasks retain their original records. No historical backfill or guessed target.
  if (!task.targetId || !task.turnId || !task.completedAt) return;
  if (task.workspaceId !== workspace.id || !["completed", "failed", "cancelled"].includes(task.status))
    throw new Error("Official result workspace or terminal identity mismatch");
  const result = officialResultSchema.parse({
    commandId: task.commandId, iteration: 1, resultId: task.taskId,
    createdAt: task.completedAt, updatedAt: task.completedAt, status: task.status,
    rawSummary: task.finalResponse?.text.slice(0, 2000) || `App Server turn ${task.status}；请读取任务结果并独立核验。`,
    machineEvidence: {
      version: 1, source: "codex_app_server", hostId: "local", targetId: task.targetId,
      taskId: task.taskId, threadId: task.threadId, turnId: task.turnId,
      status: task.status, observedAt: task.completedAt,
      changedFiles: [], changedFilesCollected: false, testsSummary: OFFICIAL_TESTS_UNKNOWN,
      ...(task.outputId ? { output: { outputId: task.outputId, outputAvailable: task.outputAvailable ?? false } } : {}),
    },
  });
  enqueueResultBusEntry({ id: workspace.id, root: workspace.root }, result);
}
