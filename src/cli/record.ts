import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { Workspace } from "../workspace/manager.js";
import { appendExecutionRecord, executionRecordSchema, sanitizeExecutionSummary } from "../execution/records.js";
import { saveExecutionOutput } from "../execution/output.js";
import { DesktopResultError, DesktopResultPendingError, discoverCurrentDesktopDelivery, recordDesktopResult } from "../desktop/result.js";
import { reconcileTrustedDesktopExecutionResult } from "../routing/execution-result-reconciler.js";
import { prepareResultReconciliation } from "../routing/result-outbox-store.js";
import { resolveWorkspace, parseNonNegativeInteger, parseChangedFiles, parseInteger, readCappedUtf8, MAX_RECORD_OUTPUT_READ, say, check } from "./shared.js";

export function registerRecordCommand(program: Command): void {
program
  .command("record", { hidden: true })
  .description("Record a Codex execution summary (used by the Skill)")
  .option("-w, --workspace <path>")
  .option("--task <id>")
  .requiredOption("--iteration <n>", "non-negative execution iteration", parseNonNegativeInteger)
  .option("--changed-files <filesOrCount>", "comma-separated files or a count", "0")
  .option("--tests <summary>", "e.g. '27 passed'")
  .option("--exit-status <status>", "ok | failed | blocked", "ok")
  .option("--notes <text>")
  .option("--raw-summary <text>", "Codex 本轮明确最终执行摘要（最多 8192 UTF-8 bytes）")
  .option("--control-session-id <id>", "Web Control session metadata (local only)")
  .option("--command-id <id>", "关联命令 ID（本地执行记录）")
  .option("--command <text>", "command whose output may be offered to ChatGPT")
  .option("--output <text>", "command output (prefer --output-file for long logs)")
  .option("--output-file <path>", "read command output from a local file")
  .option("--exit-code <n>", "numeric exit code of that command", parseInteger)
  .option("--json", "machine-readable output", false)
  .action(
    async (opts: {
      workspace?: string;
      task?: string;
      iteration: number;
      changedFiles: string;
      tests?: string;
      exitStatus: string;
      notes?: string;
      rawSummary?: string;
      controlSessionId?: string;
      commandId?: string;
      command?: string;
      output?: string;
      outputFile?: string;
      exitCode?: number;
      json: boolean;
    }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      let desktopDelivery: Awaited<ReturnType<typeof discoverCurrentDesktopDelivery>> | null = null;
      try {
        desktopDelivery = await discoverCurrentDesktopDelivery({ id: workspace.id, root: workspace.root });
      } catch (error) {
        if (!(error instanceof DesktopResultError) || error.code !== "DESKTOP_RESULT_NOT_APPLICABLE") throw error;
      }
      if (desktopDelivery) {
        if (opts.iteration !== 1) throw new Error("Desktop 自动 receipt 仅允许 iteration=1。");
        const changed = opts.changedFiles.trim();
        if (/^-?\d+$/.test(changed)) {
          throw new Error("Desktop 自动 receipt 要求实际 changed-files 列表；数字 count 会被拒绝。");
        }
        const tests = opts.tests?.trim();
        if (!tests) throw new Error("Desktop 自动 receipt 要求非空 tests；未运行请填写 not run。");
        if (!opts.rawSummary?.trim()) throw new Error("Desktop 自动 receipt 要求非空 --raw-summary；填写 Codex 自己的最终执行摘要，不要传 notes 或 transcript。");
        let rawOutput = opts.output;
        if (opts.outputFile !== undefined) {
          const fd = fs.openSync(path.resolve(opts.outputFile), "r");
          try {
            const buffer = Buffer.alloc(MAX_RECORD_OUTPUT_READ + 1);
            const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
            if (count === buffer.length) throw new Error("Desktop 自动 receipt 输出超过 256 KiB；请先生成汇总，不会截断证据。");
            rawOutput = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count));
          } finally { fs.closeSync(fd); }
        }
        const discovered = desktopDelivery;
        if (opts.commandId && opts.commandId !== discovered.commandId) {
          throw new Error("提供的 command-id 与当前 Desktop delivery 不一致；拒绝记录。");
        }
        let receipt;
        try {
          receipt = await recordDesktopResult({ id: workspace.id, root: workspace.root }, {
            commandId: discovered.commandId,
            changedFiles: changed.split(",").map(file => file.trim()).filter(Boolean),
            tests,
            exitStatus: opts.exitStatus as "ok" | "failed" | "blocked",
            ...(opts.notes === undefined ? {} : { notes: opts.notes.slice(0, 400) }),
            rawSummary: opts.rawSummary,
            ...(opts.command === undefined ? {} : { command: opts.command }),
            ...(rawOutput === undefined ? {} : { output: rawOutput }),
            ...(opts.exitCode === undefined ? {} : { exitCode: opts.exitCode }),
          }, {
            beforeReceiptCommit: receiptAlreadyExists =>
              prepareResultReconciliation({ id: workspace.id, root: workspace.root }, discovered.commandId, receiptAlreadyExists),
          });
        } catch (error) {
          if (!(error instanceof DesktopResultPendingError)) throw error;
          const pending = {
            ok: true,
            autoPromotedDesktop: true,
            finalizationPending: true,
            commandId: discovered.commandId,
            draftId: error.draft.draftId,
          };
          if (opts.json) say(JSON.stringify(pending)); else check("Desktop 结果已暂存，等待终态核验；未生成完成回执");
          return;
        }
        const result = { ok: true, autoPromotedDesktop: true, commandId: discovered.commandId, taskId: receipt.record.taskId, outputId: receipt.record.outputId };
        const resultOutbox = reconcileTrustedDesktopExecutionResult({ id: workspace.id, root: workspace.root }, discovered.commandId);
        const reconciliationNeeded = resultOutbox.status === "reconciliation_needed";
        if (opts.json) say(JSON.stringify({ ...result, ok: !reconciliationNeeded, receiptCommitted: true, resultOutbox }));
        else check(resultOutbox.status === "reconciliation_needed"
          ? "Desktop trusted execution receipt 已记录；canonical RoutingResult 需本机重试对账。"
          : "已自动记录 Desktop execution receipt");
        if (reconciliationNeeded) process.exitCode = 1;
        return;
      }
      if (!opts.task) throw new Error("普通执行记录必须提供 --task；当前 turn 不是 Desktop delivery。");
      const record = executionRecordSchema.parse({
        taskId: opts.task,
        iteration: opts.iteration,
        changedFiles: parseChangedFiles(opts.changedFiles),
        tests: opts.tests ?? null,
        exitStatus: opts.exitStatus,
        timestamp: new Date().toISOString(),
        notes: opts.notes?.slice(0, 400),
        ...(opts.rawSummary === undefined ? {} : { rawSummary: sanitizeExecutionSummary(opts.rawSummary) }),
        controlSessionId: opts.controlSessionId,
        commandId: opts.commandId,
      });
      let outputId: number | undefined;
      let outputAvailable = false;
      const rawOutput =
        opts.outputFile !== undefined
          ? readCappedUtf8(path.resolve(opts.outputFile), MAX_RECORD_OUTPUT_READ)
          : opts.output;
      if (opts.command && rawOutput !== undefined) {
        const savedOutput = saveExecutionOutput(workspace.id, {
          command: opts.command,
          raw: rawOutput,
          exitCode: opts.exitCode ?? null,
          taskId: record.taskId,
          iteration: record.iteration,
        });
        outputId = savedOutput.id;
        outputAvailable = savedOutput.allowed;
      }
      appendExecutionRecord(workspace.id, {
        ...record,
        outputId,
        outputAvailable,
      });
      if (opts.json) {
        say(JSON.stringify({ ok: true, autoPromotedDesktop: false, taskId: record.taskId, outputId, outputAvailable }));
      } else if (outputId !== undefined && !outputAvailable) check("已记录执行摘要（输出未对 ChatGPT 开放）");
      else if (outputId !== undefined) check("已记录执行摘要与输出");
      else check("已记录执行摘要");
    }
  );
}
