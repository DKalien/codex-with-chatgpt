import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { createCommand, appendResult, readRouting, registerRoute, transitionCommandDelivery, type RoutingWorkspaceIdentity } from "../src/routing/store.js";
import {
  enqueueResultOutboxEntry,
  inspectRoutingCleanupArtifacts,
  deleteRoutingCleanupArtifacts,
  deleteRoutingCleanupProjections,
  markResultReconciliationNeeded,
} from "../src/routing/result-outbox-store.js";
import { reconcileCanonicalResultOutbox } from "./helpers/canonical-compat.js";
import {
  applyFeedbackCursorCleanup,
  deleteFeedbackCleanupArtifacts,
  finishFeedbackCursorCleanup,
  finalReceiptRequiredEventId,
  inspectFeedbackCleanupArtifacts,
  prepareFeedbackCursorCleanup,
} from "../src/feedback/projection-store.js";
import { feedbackEventSchema, feedbackStateSchema, type FeedbackBinding } from "../src/feedback/schema.js";
import { readFeedbackState, writeState } from "../src/feedback/state-store.js";
import { applyProjection } from "../src/feedback/projection-store.js";
import { cleanupJournalSchema } from "../src/command-cleanup/schema.js";
import { writeCleanupJournal, removeCleanupJournal } from "../src/command-cleanup/fence.js";
import { deleteExecutionCleanupArtifacts, executionRecordSchema, inspectExecutionCleanupArtifacts, readExecutionRecordsStrict } from "../src/execution/records.js";
import { receiptFinalizationAlertPath, receiptFinalizationAlertSchema } from "../src/desktop/receipt-finalizer.js";

const PRINCIPAL = "a".repeat(32);
const TARGET = "r5h-cleanup-target";
const PEER = "r5h-cleanup-peer";

let stateDir: string;
let workspaceRoot: string;
let identity: RoutingWorkspaceIdentity;
let plannerRouteId: string;
let executorRouteId: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-r5h-state-"));
  workspaceRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "c2c-r5h-workspace-")));
  identity = { id: new Workspace(workspaceRoot).id, root: workspaceRoot };
  plannerRouteId = registerRoute(identity, {
    role: "planner", platform: "chatgpt_web", conversationId: PRINCIPAL, locator: {},
  }, stateDir).routeId;
  executorRouteId = registerRoute(identity, {
    role: "executor", platform: "codex_desktop", conversationId: randomUUID(),
    locator: { hostId: "local", executorProjectId: "r5h" },
  }, stateDir).routeId;
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

function seedCommand(commandId: string, status: "pending" | "accepted" = "accepted") {
  const payload = `payload:${commandId}`;
  createCommand(identity, {
    commandId,
    plannerRouteId,
    executorRouteId,
    intent: "development_plan",
    payloadBytes: Buffer.byteLength(payload),
    payloadSha256: createHash("sha256").update(payload).digest("hex"),
  }, stateDir);
  if (status === "accepted") transitionCommandDelivery(identity, { commandId, deliveryStatus: "accepted" }, stateDir);
  if (status !== "accepted") return null;
  const result = appendResult(identity, {
    commandId,
    executorRouteId,
    iteration: 1,
    status: "ok",
    rawSummary: `result ${commandId}`,
    machineEvidence: {
      version: 1,
      source: "codex_desktop_receipt",
      desktopReceiptSha256: createHash("sha256").update(`receipt:${commandId}`).digest("hex"),
      taskId: `desktop_${commandId}`,
      iteration: 1,
      status: "ok",
      threadId: randomUUID(),
      originTurnId: randomUUID(),
      resultTurnId: randomUUID(),
      bindingId: randomUUID(),
      changedFiles: [`src/${commandId}.ts`],
      testsSummary: "1 focused test passed",
    },
  }, stateDir);
  enqueueResultOutboxEntry(identity, { commandId, iteration: 1 }, stateDir);
  return result;
}

function initializeFeedback(): { binding: FeedbackBinding } {
  const binding = {
    version: 1 as const,
    bindingId: randomUUID(),
    epoch: 1,
    principalFingerprint: PRINCIPAL,
    clientId: "client-r5h",
    widgetId: "widget-r5h",
    enabledAt: new Date().toISOString(),
    status: "active" as const,
  };
  writeState(identity.id, stateDir, feedbackStateSchema.parse({
    version: 1,
    workspaceId: identity.id,
    projectionCursor: 7,
    binding,
    events: [],
    pairingIntent: null,
    companion: null,
    rebindIntent: null,
    rebindPredecessor: null,
  }));
  return { binding };
}

function initializeFeedbackCursor(projectionCursor: number): void {
  writeState(identity.id, stateDir, feedbackStateSchema.parse({
    version: 1,
    workspaceId: identity.id,
    projectionCursor,
    binding: null,
    events: [],
    pairingIntent: null,
    companion: null,
    rebindIntent: null,
    rebindPredecessor: null,
  }));
}

function executionRecord(commandId: string) {
  return executionRecordSchema.parse({
    taskId: `desktop_${commandId}`,
    iteration: 1,
    changedFiles: [],
    tests: "focused test passed",
    exitStatus: "ok",
    timestamp: new Date().toISOString(),
    commandId,
  });
}

function writeExecutionRecords(records: readonly ReturnType<typeof executionRecord>[]): void {
  const file = path.join(stateDir, "executions", `${identity.id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.length ? `${records.map(record => JSON.stringify(record)).join("\n")}\n` : "", "utf8");
}

function installJournal(commandId: string, artifacts: ReturnType<typeof inspectRoutingCleanupArtifacts>) {
  const journal = cleanupJournalSchema.parse({
    version: 1,
    workspaceId: identity.id,
    workspaceRoot: identity.root,
    commandId,
    iteration: 1,
    cleanupId: randomUUID(),
    mode: "manual_force",
    phase: "fenced",
    createdAt: new Date().toISOString(),
    artifacts,
  });
  writeCleanupJournal(journal, stateDir);
  return journal;
}

function cleanupTarget(commandId: string) {
  return { workspaceId: identity.id, workspaceRoot: identity.root, commandId, iteration: 1 as const, stateDir };
}

describe("R5h routing and feedback cleanup", () => {
  it("deletes only target command projections and producers, preserving peer routes, event, binding and cursor", () => {
    const targetResult = seedCommand(TARGET);
    seedCommand(PEER);
    const { binding } = initializeFeedback();
    reconcileCanonicalResultOutbox(identity.root, identity.id, stateDir);

    const before = readFeedbackState(identity.id, stateDir);
    expect(before.events).toHaveLength(2);
    expect(before.events.find(event => event.commandId === TARGET)?.targetBindingId).toBe(binding.bindingId);
    const target = cleanupTarget(TARGET);
    const artifacts = [
      ...inspectRoutingCleanupArtifacts(target),
      ...inspectFeedbackCleanupArtifacts(target),
    ];
    expect(artifacts.map(item => item.kind).sort()).toEqual([
      "feedback_event", "result_outbox", "routing_command", "routing_result",
    ]);
    installJournal(TARGET, artifacts);

    expect(() => reconcileCanonicalResultOutbox(identity.root, identity.id, stateDir))
      .toThrow(expect.objectContaining({ code: "COMMAND_CLEANUP_IN_PROGRESS" }));

    expect(deleteFeedbackCleanupArtifacts(target, artifacts)).toEqual({ events: 1 });
    expect(deleteRoutingCleanupProjections(target, artifacts)).toEqual({ outbox: 1, reconciliation: 0 });
    expect(deleteRoutingCleanupArtifacts(target, artifacts)).toEqual({ commands: 1, results: 1 });

    const afterFeedback = readFeedbackState(identity.id, stateDir);
    expect(afterFeedback.projectionCursor).toBe(before.projectionCursor);
    expect(afterFeedback.binding).toEqual(before.binding);
    expect(afterFeedback.events.map(event => event.commandId)).toEqual([PEER]);
    const afterRouting = readRouting(identity, stateDir)!;
    expect(afterRouting.routes.map(route => route.routeId)).toEqual([plannerRouteId, executorRouteId]);
    expect(afterRouting.commands.map(command => command.commandId)).toEqual([PEER]);
    expect(afterRouting.results.map(result => result.commandId)).toEqual([PEER]);
    expect(afterRouting.results[0]?.resultId).not.toBe(targetResult?.resultId);
    expect(inspectRoutingCleanupArtifacts(target)).toEqual([]);
    expect(inspectFeedbackCleanupArtifacts(target)).toEqual([]);
    removeCleanupJournal(readJournal(TARGET), stateDir);
  });

  it("fences ordinary routing and feedback projection writers while cleanup is pending", () => {
    seedCommand(TARGET, "pending");
    const target = cleanupTarget(TARGET);
    const artifacts = inspectRoutingCleanupArtifacts(target);
    const journal = installJournal(TARGET, artifacts);
    const candidate = {
      commandId: TARGET,
      executorRouteId,
      iteration: 1,
      status: "ok" as const,
      rawSummary: "late receipt",
      machineEvidence: {
        version: 1 as const,
        source: "codex_desktop_receipt" as const,
        desktopReceiptSha256: "b".repeat(64),
        taskId: `desktop_${TARGET}`,
        iteration: 1,
        status: "ok" as const,
        threadId: randomUUID(),
        originTurnId: randomUUID(),
        resultTurnId: randomUUID(),
        bindingId: randomUUID(),
        changedFiles: ["late.ts"],
        testsSummary: "late result",
      },
    };
    expect(() => appendResult(identity, candidate, stateDir)).toThrow(expect.objectContaining({ code: "COMMAND_CLEANUP_IN_PROGRESS" }));
    expect(() => markResultReconciliationNeeded(identity, { commandId: TARGET, reasonCode: "LATE_WRITE" }, stateDir))
      .toThrow(expect.objectContaining({ code: "COMMAND_CLEANUP_IN_PROGRESS" }));
    expect(() => applyProjection({
      workspaceId: identity.id,
      stateDir,
      nextCursor: 0,
      newEvents: [{
        version: 1,
        eventId: "c".repeat(32),
        kind: "C2C_EXECUTED",
        workspaceId: identity.id,
        source: "desktop",
        commandId: TARGET,
        taskId: `desktop_${TARGET}`,
        iteration: 1,
        result: "ok",
        changedFilesSummary: [],
        testsSummary: "",
        outputAvailable: false,
        occurredAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        targetBindingId: null,
        targetEpoch: null,
        targetPrincipalFingerprint: null,
        status: "queued",
      }],
    }))
      .toThrow(expect.objectContaining({ code: "COMMAND_CLEANUP_IN_PROGRESS" }));
    expect(readRouting(identity, stateDir)?.commands.map(command => command.commandId)).toEqual([TARGET]);
    removeCleanupJournal(journal, stateDir);
  });

  it("allows an explicitly confirmed pending legacy command exact-delete", () => {
    seedCommand(TARGET, "pending");
    const target = cleanupTarget(TARGET);
    const artifacts = inspectRoutingCleanupArtifacts(target);
    installJournal(TARGET, artifacts);
    expect(deleteRoutingCleanupProjections(target, artifacts)).toEqual({ outbox: 0, reconciliation: 0 });
    expect(deleteRoutingCleanupArtifacts(target, artifacts)).toEqual({ commands: 1, results: 0 });
    expect(readRouting(identity, stateDir)?.commands).toEqual([]);
    removeCleanupJournal(readJournal(TARGET), stateDir);
  });

  it("snapshots and deletes the exact executed and finalization-control events for one command", () => {
    seedCommand(TARGET);
    initializeFeedback();
    reconcileCanonicalResultOutbox(identity.root, identity.id, stateDir);
    const occurredAt = new Date().toISOString();
    const alert = receiptFinalizationAlertSchema.parse({
      version: 1,
      alertId: randomUUID(),
      workspaceId: identity.id,
      commandId: TARGET,
      reason: "post_record_activity",
      occurredAt,
    });
    const alertFile = receiptFinalizationAlertPath(stateDir, identity.id, TARGET);
    fs.mkdirSync(path.dirname(alertFile), { recursive: true });
    fs.writeFileSync(alertFile, JSON.stringify(alert), "utf8");
    const control = feedbackEventSchema.parse({
      version: 1,
      eventId: finalReceiptRequiredEventId({ workspaceId: identity.id, commandId: TARGET, alertId: alert.alertId }),
      kind: "FINAL_RECEIPT_REQUIRED",
      workspaceId: identity.id,
      source: "control",
      commandId: TARGET,
      taskId: `desktop_finalization_${TARGET}`,
      iteration: 1,
      result: "blocked",
      changedFilesSummary: [],
      testsSummary: "",
      outputAvailable: false,
      reason: alert.reason,
      occurredAt,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      targetBindingId: null,
      targetEpoch: null,
      targetPrincipalFingerprint: null,
      status: "queued",
    });
    const state = readFeedbackState(identity.id, stateDir);
    writeState(identity.id, stateDir, { ...state, events: [...state.events, control] });

    const target = cleanupTarget(TARGET);
    const artifacts = [...inspectRoutingCleanupArtifacts(target), ...inspectFeedbackCleanupArtifacts(target)];
    expect(artifacts.filter(item => item.kind === "feedback_event").map(item => item.id).sort()).toEqual([
      state.events.find(event => event.commandId === TARGET)!.eventId,
      control.eventId,
    ].sort());
    installJournal(TARGET, artifacts);
    expect(deleteFeedbackCleanupArtifacts(target, artifacts)).toEqual({ events: 2 });
    expect(readFeedbackState(identity.id, stateDir).events.some(event => event.commandId === TARGET)).toBe(false);
    removeCleanupJournal(readJournal(TARGET), stateDir);
  });

  it.each(["cursor_prepared", "record_deleted", "cursor_applied"] as const)(
    "resumes cursor cleanup after %s without reprocessing peers",
    crashStage => {
      const before = [executionRecord(PEER), executionRecord(TARGET), executionRecord("r5h-cleanup-peer-after")];
      writeExecutionRecords(before);
      initializeFeedbackCursor(2);
      const target = cleanupTarget(TARGET);
      const artifacts = inspectExecutionCleanupArtifacts(target);
      const journal = installJournal(TARGET, artifacts);

      expect(() => deleteExecutionCleanupArtifacts(target, artifacts, stage => {
        if (stage === crashStage) throw new Error(`simulated crash: ${stage}`);
      })).toThrow(`simulated crash: ${crashStage}`);

      if (crashStage === "cursor_prepared") {
        expect(() => applyProjection({
          workspaceId: identity.id,
          stateDir,
          nextCursor: 2,
          newEvents: [feedbackEventSchema.parse({
            version: 1,
            eventId: "d".repeat(32),
            kind: "C2C_EXECUTED",
            workspaceId: identity.id,
            source: "desktop",
            commandId: PEER,
            taskId: `desktop_${PEER}`,
            iteration: 1,
            result: "ok",
            changedFilesSummary: [],
            testsSummary: "",
            outputAvailable: false,
            occurredAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            targetBindingId: null,
            targetEpoch: null,
            targetPrincipalFingerprint: null,
            status: "queued",
          })],
        })).toThrow(expect.objectContaining({ code: "FEEDBACK_CURSOR_CLEANUP_PENDING" }));
      }

      const afterCrash = readExecutionRecordsStrict(identity.id, stateDir);
      const withPeerAppend = [...afterCrash, executionRecord("r5h-cleanup-appended-peer")];
      writeExecutionRecords(withPeerAppend);

      deleteExecutionCleanupArtifacts(target, artifacts);
      const remaining = readExecutionRecordsStrict(identity.id, stateDir);
      expect(remaining.map(record => record.commandId)).toEqual([
        PEER,
        "r5h-cleanup-peer-after",
        "r5h-cleanup-appended-peer",
      ]);
      const feedback = readFeedbackState(identity.id, stateDir);
      expect(feedback.projectionCursor).toBe(1);
      expect(feedback.cleanupAdjustments).toHaveLength(1);
      expect(feedback.cleanupAdjustments?.[0]?.state).toBe("applied");

      // A repeated resume may validate the same prefix, but must not decrement again.
      deleteExecutionCleanupArtifacts(target, artifacts);
      expect(readFeedbackState(identity.id, stateDir).projectionCursor).toBe(1);
      writeCleanupJournal({ ...readJournal(TARGET), phase: "producers_deleted" }, stateDir);
      finishFeedbackCursorCleanup(target);
      expect(readFeedbackState(identity.id, stateDir).cleanupAdjustments).toEqual([]);
      removeCleanupJournal(readJournal(TARGET), stateDir);
      expect(journal.phase).toBe("fenced");
    },
  );
});

function readJournal(commandId: string) {
  const file = path.join(stateDir, "command-cleanup", identity.id, `${commandId}.json`);
  return cleanupJournalSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}
