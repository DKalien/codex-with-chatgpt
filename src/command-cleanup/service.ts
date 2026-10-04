import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "../config/paths.js";
import { resolveWorkspaceIdentity } from "../routing/store.js";
import { projectTrustedDesktopExecutionResult } from "../routing/execution-result-projector.js";
import { inspectRoutingCleanupArtifacts, deleteRoutingCleanupProjections, deleteRoutingCleanupArtifacts } from "../routing/result-outbox-store.js";
import { inspectFeedbackCleanupArtifacts, deleteFeedbackCleanupArtifacts, finishFeedbackCursorCleanup } from "../feedback/projection-store.js";
import { inspectDesktopCleanupArtifacts, deleteDesktopCleanupArtifacts } from "../desktop/command-cleanup.js";
import { inspectExecutionCleanupArtifacts, deleteExecutionCleanupArtifacts } from "../execution/records.js";
import { inspectExecutorDispatchCleanupArtifacts, deleteExecutorDispatchCleanupArtifacts } from "../executor-control/dispatch-store.js";
import { listResultBusEntries, inspectResultBusCleanupArtifacts, deleteResultBusCleanupArtifacts } from "../result-bus/store.js";
import { inspectResultBusCutoverCleanupArtifacts, deleteResultBusCutoverCleanupArtifacts } from "../result-bus/cutover-store.js";
import { assertCleanupPath, assertWorkspaceCleanupNotInherited, cleanupJournalFile, readCleanupJournal, writeCleanupJournal, removeCleanupJournal, withCommandOperation, withWorkspaceCleanupOperation } from "./fence.js";
import { assertCleanupArtifacts, cleanupJournalSchema, CommandCleanupError, type CleanupArtifact, type CleanupJournal, type CommandCleanupTarget } from "./schema.js";

export const COMMAND_CLEANUP_NOTICE = "本地放弃并物理删除该 command；外部可能已执行或发送的事实将无法由本机恢复，绝不自动重发。";
const sortArtifacts = (items: CleanupArtifact[]): CleanupArtifact[] => items.sort((a, b) => `${a.kind}\0${a.id}`.localeCompare(`${b.kind}\0${b.id}`));

function targetIdentity(target: CommandCleanupTarget): CommandCleanupTarget & { stateDir: string } {
  const identity = resolveWorkspaceIdentity({ id: target.workspaceId, root: target.workspaceRoot });
  if (target.iteration !== 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(target.commandId)) throw new CommandCleanupError("COMMAND_CLEANUP_INVALID", "cleanup 只支持 exact commandId / iteration=1。");
  return { ...target, workspaceId: identity.id, workspaceRoot: identity.root, stateDir: target.stateDir ?? getStateDir() };
}

export function inspectCommandCleanupArtifacts(raw: CommandCleanupTarget): CleanupArtifact[] {
  const target = targetIdentity(raw);
  const artifacts = sortArtifacts([
    ...inspectDesktopCleanupArtifacts(target), ...inspectExecutionCleanupArtifacts(target),
    ...inspectExecutorDispatchCleanupArtifacts(target), ...inspectRoutingCleanupArtifacts(target),
    ...inspectFeedbackCleanupArtifacts(target), ...inspectResultBusCleanupArtifacts(target),
    ...inspectResultBusCutoverCleanupArtifacts(target),
  ]);
  if (new Set(artifacts.map(item => `${item.kind}\0${item.id}`)).size !== artifacts.length) throw new CommandCleanupError("COMMAND_CLEANUP_AMBIGUOUS", "cleanup artifacts identity 重复。");
  return artifacts;
}

function journalFor(target: CommandCleanupTarget): CleanupJournal | null {
  const journal = readCleanupJournal(target.workspaceId, target.commandId, target.stateDir);
  if (journal && (journal.workspaceRoot !== target.workspaceRoot || journal.iteration !== target.iteration)) throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "cleanup journal workspace/iteration 不匹配。");
  return journal;
}

export function previewCommandCleanup(raw: CommandCleanupTarget) {
  const target = targetIdentity(raw);
  const journal = journalFor(target);
  const artifacts = inspectCommandCleanupArtifacts(target);
  const confirmationSha256 = createHash("sha256").update(JSON.stringify({ version: 1, workspaceId: target.workspaceId, workspaceRoot: target.workspaceRoot, commandId: target.commandId, iteration: target.iteration, cleanupId: journal?.cleanupId ?? null, artifacts })).digest("hex");
  return { status: artifacts.length || journal ? "preview" as const : "not_found" as const, workspaceId: target.workspaceId, commandId: target.commandId, iteration: 1, artifacts, confirmationSha256: artifacts.length || journal ? confirmationSha256 : null, notice: COMMAND_CLEANUP_NOTICE };
}

export type CleanupStage = CleanupJournal["phase"] | "cursor_prepared" | "record_deleted" | "cursor_applied";
export type CleanupPhaseHook = (phase: CleanupStage) => void;
export type CommandCleanupOutcome = { status: "cleaned" | "not_found"; workspaceId: string; commandId: string };

function verifyAutoProof(target: CommandCleanupTarget): void {
  const entries = listResultBusEntries({ id: target.workspaceId, root: target.workspaceRoot }, target.stateDir).filter(entry => entry.commandId === target.commandId);
  const entry = entries[0];
  if (entries.length !== 1 || !entry || entry.iteration !== 1 || entry.lifecycle !== "ephemeral" || entry.deliveryStatus !== "observed" || !entry.attempt || !entry.sendTarget || !("machineEvidence" in entry.result))
    throw new CommandCleanupError("COMMAND_CLEANUP_NOT_TERMINAL", "auto cleanup 必须是新 ephemeral flow 的 exact observed canonical result。");
  const candidate = projectTrustedDesktopExecutionResult({ id: target.workspaceId, root: target.workspaceRoot }, { commandId: target.commandId, desktopReceiptSha256: entry.result.machineEvidence.desktopReceiptSha256 }, target.stateDir);
  const { resultId: _resultId, createdAt: _createdAt, updatedAt: _updatedAt, ...persisted } = entry.result;
  if (JSON.stringify(candidate) !== JSON.stringify(persisted)) throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "observed result 与 trusted receipt 不一致。");
}

function resumeLocked(target: CommandCleanupTarget, hook?: CleanupPhaseHook): CommandCleanupOutcome {
  let journal = journalFor(target);
  if (!journal) return { status: "not_found", workspaceId: target.workspaceId, commandId: target.commandId };
  const advance = (phase: CleanupJournal["phase"]): void => {
    journal = { ...journal!, phase };
    writeCleanupJournal(journal, target.stateDir); hook?.(phase);
  };
  if (journal.phase === "snapshot_pending") {
    assertCleanupArtifacts(inspectResultBusCleanupArtifacts(target), journal.artifacts);
    verifyAutoProof(target);
    journal = { ...journal, artifacts: inspectCommandCleanupArtifacts(target) };
    advance("fenced");
  }
  assertCleanupArtifacts(inspectCommandCleanupArtifacts(target), journal.artifacts);
  // Dependent projections first; strict outbox readers still need the Routing producer.
  if (journal.phase === "fenced") {
    deleteFeedbackCleanupArtifacts(target, journal.artifacts);
    deleteRoutingCleanupProjections(target, journal.artifacts);
    deleteResultBusCutoverCleanupArtifacts(target, journal.artifacts);
    advance("projections_deleted");
  }
  if (journal.phase === "projections_deleted") {
    deleteRoutingCleanupArtifacts(target, journal.artifacts);
    deleteDesktopCleanupArtifacts(target, journal.artifacts);
    deleteExecutionCleanupArtifacts(target, journal.artifacts, hook);
    deleteExecutorDispatchCleanupArtifacts(target, journal.artifacts);
    advance("producers_deleted");
  }
  if (journal.phase === "producers_deleted") {
    finishFeedbackCursorCleanup(target);
    deleteResultBusCleanupArtifacts(target, journal.artifacts);
    advance("bus_deleted");
  }
  if (inspectCommandCleanupArtifacts(target).length !== 0) throw new CommandCleanupError("COMMAND_CLEANUP_PENDING", "command artifacts 尚未全部消失；保留 fence。");
  removeCleanupJournal(journal, target.stateDir);
  return { status: "cleaned", workspaceId: target.workspaceId, commandId: target.commandId };
}

export function resumeCommandCleanup(raw: CommandCleanupTarget, hook?: CleanupPhaseHook): CommandCleanupOutcome {
  const target = targetIdentity(raw);
  assertWorkspaceCleanupNotInherited(target.workspaceId, target.stateDir);
  return withCommandOperation(target.workspaceId, target.commandId, () => withWorkspaceCleanup(target, () => resumeLocked(target, hook)), target.stateDir, true);
}

function withWorkspaceCleanup<T>(target: CommandCleanupTarget, fn: () => T): T {
  // Lock order: command lifecycle -> workspace cleanup -> stores; deletion adjusts the shared Feedback cursor.
  return withWorkspaceCleanupOperation(target.workspaceId, target.stateDir!, fn);
}

/** Explicit maintenance only. Round-robin batches never repair corrupt lifecycle locks. */
export function resumeWorkspaceCommandCleanups(identity: { id: string; root: string }, stateDir = getStateDir(),
  batch?: { limit: number; after?: string }): { cleaned: number; pending: number; next?: string } {
  if (batch && (!Number.isInteger(batch.limit) || batch.limit < 1 || batch.limit > 100)) throw new CommandCleanupError("COMMAND_CLEANUP_INVALID", "维护批量必须在 1–100 之间。");
  const directory = path.dirname(cleanupJournalFile(identity.id, "_", stateDir));
  assertCleanupPath(path.join(directory, "_"), stateDir);
  const journals = (fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true }) : [])
    .filter(file => file.name.endsWith(".json"));
  if (journals.some(file => !file.isFile() || file.isSymbolicLink())) throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "cleanup journal directory 含 unsafe authority。");
  const observed = listResultBusEntries(identity, stateDir).filter(entry => entry.lifecycle === "ephemeral" && entry.deliveryStatus === "observed");
  const ids = [...new Set([...journals.map(file => file.name.slice(0, -5)), ...observed.map(entry => entry.commandId)])].sort();
  const start = batch?.after ? ids.findIndex(id => id > batch.after!) : 0;
  const ordered = start > 0 ? [...ids.slice(start), ...ids.slice(0, start)] : ids;
  const selected = ordered.slice(0, batch?.limit ?? ids.length);
  let cleaned = 0, pending = 0;
  for (const commandId of selected) {
    const target = { workspaceId: identity.id, workspaceRoot: identity.root, commandId, iteration: 1, stateDir };
    try {
      const result = readCleanupJournal(identity.id, commandId, stateDir)
        ? resumeCommandCleanup(target) : cleanupObservedCommand(target);
      if (result.status === "cleaned") cleaned++;
    } catch { pending++; }
  }
  return { cleaned, pending, ...(batch && selected.length ? { next: selected.at(-1)! } : {}) };
}

export function confirmCommandCleanup(raw: CommandCleanupTarget, confirmationSha256: string, hook?: CleanupPhaseHook): CommandCleanupOutcome {
  const target = targetIdentity(raw);
  assertWorkspaceCleanupNotInherited(target.workspaceId, target.stateDir);
  return withCommandOperation(target.workspaceId, target.commandId, () => withWorkspaceCleanup(target, () => {
    const preview = previewCommandCleanup(target);
    if (!/^[a-f0-9]{64}$/.test(confirmationSha256) || preview.confirmationSha256 !== confirmationSha256) throw new CommandCleanupError("COMMAND_CLEANUP_CONFIRMATION_MISMATCH", "cleanup preview 已漂移或 confirmation 不匹配；零删除。");
    if (!journalFor(target)) {
      const journal = cleanupJournalSchema.parse({ version: 1, workspaceId: target.workspaceId, workspaceRoot: target.workspaceRoot, commandId: target.commandId, iteration: 1, cleanupId: randomUUID(), mode: "manual_force", phase: "fenced", createdAt: new Date().toISOString(), artifacts: preview.artifacts });
      writeCleanupJournal(journal, target.stateDir); hook?.("fenced");
    }
    return resumeLocked(target, hook);
  }), target.stateDir, true);
}

/** Caller has durably committed observed before entering this function. Failure keeps ACK terminal. */
export function cleanupObservedCommand(raw: CommandCleanupTarget, hook?: CleanupPhaseHook): CommandCleanupOutcome {
  const target = targetIdentity(raw);
  assertWorkspaceCleanupNotInherited(target.workspaceId, target.stateDir);
  return withCommandOperation(target.workspaceId, target.commandId, () => withWorkspaceCleanup(target, () => {
    if (!journalFor(target)) {
      const proof = inspectResultBusCleanupArtifacts(target);
      if (proof.length !== 1) throw new CommandCleanupError("COMMAND_CLEANUP_NOT_TERMINAL", "缺少唯一 observed Bus proof。");
      writeCleanupJournal(cleanupJournalSchema.parse({ version: 1, workspaceId: target.workspaceId, workspaceRoot: target.workspaceRoot, commandId: target.commandId, iteration: 1, cleanupId: randomUUID(), mode: "auto_observed", phase: "snapshot_pending", createdAt: new Date().toISOString(), artifacts: proof }), target.stateDir);
      hook?.("snapshot_pending");
    }
    return resumeLocked(target, hook);
  }), target.stateDir, true);
}
