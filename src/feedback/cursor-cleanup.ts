import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "../config/paths.js";
import { assertCleanupStoreFile, readCleanupJournal, withCommandOperation } from "../command-cleanup/fence.js";
import {
  assertCleanupArtifacts,
  cleanupArtifact,
  CommandCleanupError,
  type CleanupArtifact,
  type CleanupJournal,
  type CommandCleanupTarget,
} from "../command-cleanup/schema.js";
import type { StoredExecutionRecord } from "../execution/records.js";
import { feedbackStateFile, withFeedbackLock, writeState } from "./state-store.js";
import type { FeedbackState } from "./schema.js";

type FeedbackCursorAdjustment = NonNullable<FeedbackState["cleanupAdjustments"]>[number];

function cursorTarget(target: CommandCleanupTarget): { stateDir: string } {
  if (!/^[a-f0-9]{12}$/.test(target.workspaceId) || !/^[A-Za-z0-9_-]{1,128}$/.test(target.commandId) ||
      target.iteration !== 1 || !target.workspaceRoot) {
    throw new CommandCleanupError("COMMAND_CLEANUP_INVALID", "Feedback cursor cleanup identity 非法。");
  }
  return { stateDir: path.resolve(target.stateDir ?? getStateDir()) };
}

function requireCleanupSnapshot(target: CommandCleanupTarget, expected: readonly CleanupArtifact[], stateDir: string): CleanupJournal {
  const journal = readCleanupJournal(target.workspaceId, target.commandId, stateDir);
  const keys = (items: readonly CleanupArtifact[]) => items.map(item => `${item.kind}\0${item.id}\0${item.sha256}`).sort();
  if (!journal || journal.workspaceRoot !== target.workspaceRoot || journal.iteration !== target.iteration ||
      journal.phase === "snapshot_pending" || JSON.stringify(keys(expected)) !== JSON.stringify(keys(journal.artifacts))) {
    throw new CommandCleanupError("COMMAND_CLEANUP_REQUIRED", "Feedback cursor cleanup 要求匹配的完整 journal snapshot。");
  }
  return journal;
}

function executionRecordCleanupArtifact(target: CommandCleanupTarget, record: StoredExecutionRecord): CleanupArtifact {
  return cleanupArtifact("execution_record", `${target.commandId}:1`, record);
}

function requireExecutionRecordArtifact(target: CommandCleanupTarget, expected: readonly CleanupArtifact[]): CleanupArtifact {
  const matches = expected.filter(item => item.kind === "execution_record" && item.id === `${target.commandId}:1`);
  if (matches.length !== 1) throw new CommandCleanupError("COMMAND_CLEANUP_CURSOR_REQUIRED", "cursor adjustment 缺少唯一 exact execution_record artifact。");
  return matches[0]!;
}

function prefixSha256(records: readonly StoredExecutionRecord[], count: number): string {
  return createHash("sha256").update(JSON.stringify(records.slice(0, count)), "utf8").digest("hex");
}

function assertRecordPrefix(records: readonly StoredExecutionRecord[], count: number, expected: string, detail: string): void {
  if (records.length < count || prefixSha256(records, count) !== expected) {
    throw new CommandCleanupError("COMMAND_CLEANUP_CURSOR_CONFLICT", `execution JSONL ${detail} prefix changed; 保留 cleanup_pending。`);
  }
}

function readCleanupFeedbackState(read: () => FeedbackState | null, workspaceId: string, stateDir: string): FeedbackState | null {
  const file = feedbackStateFile(workspaceId, stateDir);
  assertCleanupStoreFile(file, stateDir);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "Feedback state 不是普通文件；保留 cleanup_pending。");
  }
  return read();
}

function assertAdjustmentIdentity(adjustment: FeedbackCursorAdjustment, journal: CleanupJournal, target: CommandCleanupTarget): void {
  if (adjustment.cleanupId !== journal.cleanupId || adjustment.commandId !== target.commandId) {
    throw new CommandCleanupError("COMMAND_CLEANUP_CURSOR_CONFLICT", "Feedback cursor adjustment 与 active cleanup identity 不匹配。");
  }
}

/** Persist exact source position and both prefix proofs before execution JSONL deletion. */
export function prepareFeedbackCursorCleanup(
  target: CommandCleanupTarget,
  beforeRecords: readonly StoredExecutionRecord[],
  afterRecords: readonly StoredExecutionRecord[],
  index: number,
  expected: readonly CleanupArtifact[],
): void {
  const { stateDir } = cursorTarget(target);
  withCommandOperation(target.workspaceId, target.commandId, () => {
    const journal = requireCleanupSnapshot(target, expected, stateDir);
    const recordArtifact = requireExecutionRecordArtifact(target, expected);
    const matches = beforeRecords.flatMap((record, position) =>
      record.commandId === target.commandId && record.iteration === target.iteration ? [position] : []);
    const expectedAfter = beforeRecords.filter((_record, position) => position !== index);
    if (!Number.isSafeInteger(index) || index < 0 || index >= beforeRecords.length || matches.length !== 1 ||
        matches[0] !== index || JSON.stringify(expectedAfter) !== JSON.stringify(afterRecords)) {
      throw new CommandCleanupError("COMMAND_CLEANUP_CURSOR_CONFLICT", "execution JSONL target index/after snapshot 不精确；保留 cleanup_pending。");
    }
    assertCleanupArtifacts([executionRecordCleanupArtifact(target, beforeRecords[index]!)], [recordArtifact]);

    withFeedbackLock(target.workspaceId, stateDir, read => {
      const previous = readCleanupFeedbackState(read, target.workspaceId, stateDir);
      if (!previous) return;
      const adjustments = previous.cleanupAdjustments ?? [];
      if (adjustments.some(item => item.cleanupId !== journal.cleanupId)) {
        throw new CommandCleanupError("COMMAND_CLEANUP_CURSOR_BUSY", "Feedback state 有其它 active cursor cleanup adjustment。");
      }
      const prior = adjustments.find(item => item.cleanupId === journal.cleanupId);
      if (prior) {
        assertAdjustmentIdentity(prior, journal, target);
        if (prior.state !== "prepared") throw new CommandCleanupError("COMMAND_CLEANUP_CURSOR_CONFLICT", "applied cursor adjustment 的 source record 意外重现。");
        assertRecordPrefix(beforeRecords, prior.recordCount, prior.beforePrefixSha256, "before");
        assertRecordPrefix(afterRecords, prior.recordCount - 1, prior.afterPrefixSha256, "after");
        if (index !== prior.index || beforeRecords[index]?.commandId !== target.commandId ||
            beforeRecords[index]?.iteration !== target.iteration) {
          throw new CommandCleanupError("COMMAND_CLEANUP_CURSOR_CONFLICT", "prepared cursor cleanup target index 已变化。");
        }
        return;
      }
      const adjustment: FeedbackCursorAdjustment = {
        cleanupId: journal.cleanupId,
        commandId: target.commandId,
        index,
        recordCount: beforeRecords.length,
        beforePrefixSha256: prefixSha256(beforeRecords, beforeRecords.length),
        afterPrefixSha256: prefixSha256(afterRecords, afterRecords.length),
        state: "prepared",
      };
      writeState(target.workspaceId, stateDir, { ...previous, cleanupAdjustments: [...adjustments, adjustment] });
    });
  }, stateDir, true);
}

/** Apply the cursor delta only after exact source deletion; retries never decrement twice. */
export function applyFeedbackCursorCleanup(
  target: CommandCleanupTarget,
  currentRecords: readonly StoredExecutionRecord[],
  expected: readonly CleanupArtifact[],
): void {
  const { stateDir } = cursorTarget(target);
  withCommandOperation(target.workspaceId, target.commandId, () => {
    const journal = requireCleanupSnapshot(target, expected, stateDir);
    const expectedRecord = expected.some(item => item.kind === "execution_record" && item.id === `${target.commandId}:1`);
    withFeedbackLock(target.workspaceId, stateDir, read => {
      const previous = readCleanupFeedbackState(read, target.workspaceId, stateDir);
      if (!previous) return;
      const adjustments = previous.cleanupAdjustments ?? [];
      const adjustment = adjustments.find(item => item.cleanupId === journal.cleanupId);
      const targetStillPresent = currentRecords.some(record => record.commandId === target.commandId && record.iteration === target.iteration);
      if (!adjustment) {
        if (!expectedRecord && !targetStillPresent) return;
        throw new CommandCleanupError("COMMAND_CLEANUP_CURSOR_REQUIRED", "execution record 已缺失但 Feedback cursor adjustment 未准备；保留 cleanup_pending。");
      }
      assertAdjustmentIdentity(adjustment, journal, target);
      if (!expectedRecord || targetStillPresent) {
        throw new CommandCleanupError("COMMAND_CLEANUP_CURSOR_CONFLICT", "cursor apply 需要已删除的 exact execution record。");
      }
      assertRecordPrefix(currentRecords, adjustment.recordCount - 1, adjustment.afterPrefixSha256, "after-delete");
      if (adjustment.state === "applied") return;
      const projectionCursor = adjustment.index < previous.projectionCursor
        ? previous.projectionCursor - 1
        : previous.projectionCursor;
      if (projectionCursor > currentRecords.length) {
        throw new CommandCleanupError("COMMAND_CLEANUP_CURSOR_CONFLICT", "调整后的 projectionCursor 超过 execution JSONL 长度。");
      }
      writeState(target.workspaceId, stateDir, {
        ...previous,
        projectionCursor,
        cleanupAdjustments: adjustments.map(item => item.cleanupId === journal.cleanupId
          ? { ...item, state: "applied" as const }
          : item),
      }, { allowPreparedCleanupId: journal.cleanupId });
    });
  }, stateDir, true);
}

/** Drop the transient receipt only after the coordinator has durably advanced producers_deleted. */
export function finishFeedbackCursorCleanup(target: CommandCleanupTarget): void {
  const { stateDir } = cursorTarget(target);
  withCommandOperation(target.workspaceId, target.commandId, () => {
    const journal = readCleanupJournal(target.workspaceId, target.commandId, stateDir);
    if (!journal || journal.workspaceRoot !== target.workspaceRoot || journal.iteration !== target.iteration ||
        (journal.phase !== "producers_deleted" && journal.phase !== "bus_deleted")) {
      throw new CommandCleanupError("COMMAND_CLEANUP_CURSOR_REQUIRED", "cursor marker 只能在 producers_deleted 后清理。");
    }
    withFeedbackLock(target.workspaceId, stateDir, read => {
      const previous = readCleanupFeedbackState(read, target.workspaceId, stateDir);
      if (!previous) return;
      const adjustments = previous.cleanupAdjustments ?? [];
      const adjustment = adjustments.find(item => item.cleanupId === journal.cleanupId);
      if (!adjustment) return;
      assertAdjustmentIdentity(adjustment, journal, target);
      if (adjustment.state !== "applied") throw new CommandCleanupError("COMMAND_CLEANUP_CURSOR_PENDING", "cursor adjustment 尚未 applied；保留 cleanup_pending。");
      writeState(target.workspaceId, stateDir, {
        ...previous,
        cleanupAdjustments: adjustments.filter(item => item.cleanupId !== journal.cleanupId),
      });
    });
  }, stateDir, true);
}
