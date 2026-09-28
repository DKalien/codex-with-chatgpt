import type { Command } from "commander";
import path from "node:path";
import { Workspace } from "../workspace/manager.js";
import { getStateDir } from "../config/paths.js";
import {
  findReceiptFinalizationDraft,
  runReceiptFinalizer,
  writeReceiptFinalizationWorkerFailureAlert,
} from "../desktop/receipt-finalizer.js";
import { reconcileTrustedDesktopExecutionResult } from "../routing/execution-result-reconciler.js";
import { prepareResultReconciliation } from "../routing/result-outbox-store.js";
import { say } from "./shared.js";

export function registerDesktopReceiptFinalizerCommands(program: Command): void {
// ---------------------------------------------------------------- Desktop receipt terminal fence
const drf = program.command("desktop-receipt-finalizer").description("内部 Desktop receipt 终态 fence worker");
drf.command("run").requiredOption("-w, --workspace <path>").requiredOption("--draft <id>").action(async (opts: { workspace: string; draft: string }) => {
  const workspace = new Workspace(path.resolve(opts.workspace));
  const stateDir = process.env.C2C_RECEIPT_FINALIZER_STATE_DIR ?? getStateDir();
  const draft = findReceiptFinalizationDraft(stateDir, workspace.id, opts.draft);
  if (!draft) return;
  let result: Awaited<ReturnType<typeof runReceiptFinalizer>>;
  try {
    result = await runReceiptFinalizer(draft, {
      stateDir,
      beforeReceiptCommit: receiptAlreadyExists =>
        prepareResultReconciliation({ id: workspace.id, root: workspace.root }, draft.commandId, receiptAlreadyExists),
    });
  }
  catch {
    try {
      say(JSON.stringify(writeReceiptFinalizationWorkerFailureAlert(draft, { stateDir })));
      return;
    } catch {
      process.exitCode = 1;
      return;
    }
  }
  // Missing claim ownership means another worker is already responsible; treat it as a no-op,
  // so the parent does not misreport ordinary claim contention as worker failure.
  if (!result) return;
  if ("record" in result) {
    const resultOutbox = reconcileTrustedDesktopExecutionResult({ id: workspace.id, root: workspace.root }, draft.commandId);
    const reconciliationNeeded = resultOutbox.status === "reconciliation_needed";
    say(JSON.stringify({ ok: !reconciliationNeeded, finalized: true, commandId: draft.commandId,
      taskId: result.record.taskId, outputId: result.record.outputId, resultOutbox }));
    // Keep the trusted receipt committed; non-zero only signals the independent R4 reconciliation gap.
    if (reconciliationNeeded) process.exitCode = 1;
    return;
  }
  // Worker 只写入 durable alert；feedback projector 在受控 reconcile 路径统一消费。
  say(JSON.stringify(result));
});
}
