import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";
import { appendExecutionRecord, deleteExecutionCleanupArtifacts, inspectExecutionCleanupArtifacts } from "../src/execution/records.js";
import { inspectExecutionOutputCleanupArtifacts, MAX_OUTPUT_RECORDS, readExecutionOutputMetadataStrict, saveExecutionOutput } from "../src/execution/output.js";
import { cleanupArtifact, type CleanupArtifact, type CleanupJournal } from "../src/command-cleanup/schema.js";
import { removeCleanupJournal, writeCleanupJournal } from "../src/command-cleanup/fence.js";
import {
  deleteExecutorDispatchCleanupArtifacts,
  executorDispatchFile,
  executorDispatchInitializedFile,
  inspectExecutorDispatchCleanupArtifacts,
  readExecutorDispatchState,
  updateExecutorDispatchDetailed,
} from "../src/executor-control/dispatch-store.js";
import { finalizeExecutorDispatch, markExecutorDispatchOutcomeUnknown } from "../src/executor-control/dispatch-service.js";
import { beginExecutorDispatch } from "../src/executor-control/dispatch-service.js";
import { parseExecutorDispatchEntry, type ExecutorDispatchEntry } from "../src/executor-control/dispatch-schema.js";

let stateDir: string;
let workspaceRoot: string;
let workspace: Workspace;

beforeEach(() => {
  stateDir = isolateStateDir();
  workspaceRoot = makeTmpDir("r5h-cleanup-workspace");
  workspace = new Workspace(workspaceRoot);
});

afterEach(() => {
  cleanup(stateDir);
  cleanup(workspaceRoot);
});

function record(commandId: string, taskId = "task-" + commandId) {
  return {
    taskId, iteration: 1, changedFiles: ["src/example.ts"], tests: "focused tests passed",
    exitStatus: "ok", timestamp: new Date().toISOString(), commandId,
  };
}

function journal(artifacts: CleanupArtifact[], commandId: string): CleanupJournal {
  return {
    version: 1, workspaceId: workspace.id, workspaceRoot, commandId, iteration: 1,
    cleanupId: randomUUID(), mode: "manual_force", phase: "fenced",
    createdAt: new Date().toISOString(), artifacts,
  };
}

function dispatchEntry(
  commandId: string,
  generationId: string,
  lifecycle: "ephemeral" | undefined,
  status: "started" | "accepted" = "started",
): ExecutorDispatchEntry {
  const now = new Date().toISOString();
  const target = {
    version: 1 as const, bindingId: "binding-r5h", pluginId: "codex-desktop",
    workspaceId: workspace.id, workspaceRoot, instanceId: "local", sessionId: "session-r5h",
    locator: {}, epoch: 1, frozenAt: new Date().toISOString(),
  };
  return parseExecutorDispatchEntry({
    version: 1, commandId, ...(lifecycle ? { lifecycle, dispatchGenerationId: generationId } : {}),
    intent: "development_plan", payloadBytes: 4, payloadSha256: "a".repeat(64),
    requestAuthoritySha256: "b".repeat(64), target, deliveryStatus: status, ownerId: "test-owner",
    createdAt: now, updatedAt: now, startedAt: now,
    ...(status === "accepted" ? { terminalAt: now } : {}),
  });
}

function writeDispatchEntry(entry: ExecutorDispatchEntry): void {
  updateExecutorDispatchDetailed(workspace.id, workspaceRoot, previous => ({
    state: {
      version: 1, workspaceId: workspace.id, workspaceRoot,
      revision: (previous?.revision ?? 0) + 1, entries: [...(previous?.entries ?? []), entry],
    },
    result: undefined,
  }), stateDir);
}

describe("R5h execution artifact cleanup", () => {
  it("inspects without store locks and deletes only the exact record/output", () => {
    const commandId = "r5h-command";
    const otherCommandId = "r5h-other";
    const output = saveExecutionOutput(workspace.id, {
      command: "run target", raw: "target body", taskId: "desktop_" + commandId, iteration: 1, commandId,
    });
    const otherOutput = saveExecutionOutput(workspace.id, {
      command: "run other", raw: "other body", taskId: "other-task", iteration: 1, commandId: otherCommandId,
    });
    appendExecutionRecord(workspace.id, { ...record(commandId, "desktop_" + commandId), outputId: output.id, outputAvailable: true });
    appendExecutionRecord(workspace.id, { ...record(otherCommandId), outputId: otherOutput.id, outputAvailable: true });
    const target = { workspaceId: workspace.id, workspaceRoot, commandId, iteration: 1 as const, stateDir };

    const snapshot = inspectExecutionCleanupArtifacts(target);
    expect(snapshot.map(item => item.kind).sort()).toEqual(["execution_output", "execution_record"]);
    expect(fs.existsSync(path.join(stateDir, "executions", workspace.id + ".jsonl.lock"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "execution-outputs", workspace.id, "index.json.lock"))).toBe(false);
    const expected = [...snapshot, cleanupArtifact("result_bus_delivery", commandId, { proof: "test" })];
    writeCleanupJournal(journal(expected, commandId), stateDir);
    expect(inspectExecutionCleanupArtifacts(target)).toEqual(snapshot);
    deleteExecutionCleanupArtifacts(target, expected);

    const recordsFile = path.join(stateDir, "executions", workspace.id + ".jsonl");
    expect(fs.readFileSync(recordsFile, "utf8")).toContain(otherCommandId);
    expect(fs.readFileSync(recordsFile, "utf8")).not.toContain(commandId);
    const index = JSON.parse(fs.readFileSync(path.join(stateDir, "execution-outputs", workspace.id, "index.json"), "utf8"));
    expect(index.nextId).toBe(otherOutput.id + 1);
    expect(index.items.map((item: { id: number }) => item.id)).toEqual([otherOutput.id]);
    expect(fs.existsSync(path.join(stateDir, "execution-outputs", workspace.id, "bodies", output.id + ".txt"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "execution-outputs", workspace.id, "bodies", otherOutput.id + ".txt"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "execution-outputs", workspace.id, "index.json.initialized"))).toBe(true);
  });

  it("allows a missing body only with a matching full fence and resumes deletion", () => {
    const commandId = "r5h-body-resume";
    const output = saveExecutionOutput(workspace.id, {
      command: "run", raw: "body", taskId: "task", iteration: 1, commandId,
    });
    appendExecutionRecord(workspace.id, { ...record(commandId), outputId: output.id, outputAvailable: true });
    const target = { workspaceId: workspace.id, workspaceRoot, commandId, iteration: 1 as const, stateDir };
    const snapshot = inspectExecutionCleanupArtifacts(target);
    fs.unlinkSync(path.join(stateDir, "execution-outputs", workspace.id, "bodies", output.id + ".txt"));
    expect(() => inspectExecutionOutputCleanupArtifacts(target, [output.id])).toThrow();

    const expected = [...snapshot, cleanupArtifact("result_bus_delivery", commandId, { proof: "test" })];
    writeCleanupJournal(journal(expected, commandId), stateDir);
    expect(inspectExecutionOutputCleanupArtifacts(target, [output.id])).toEqual(snapshot.filter(item => item.kind === "execution_output"));
    deleteExecutionCleanupArtifacts(target, expected);
    expect(fs.existsSync(path.join(stateDir, "executions", workspace.id + ".jsonl"))).toBe(false);
  });

  it("does not evict command-owned outputs when retention is full", () => {
    for (let index = 0; index < MAX_OUTPUT_RECORDS; index += 1) {
      saveExecutionOutput(workspace.id, {
        command: `owned-${index}`, raw: `body-${index}`, taskId: `task-${index}`, iteration: 1,
        commandId: `r5h-owned-${index}`,
      });
    }
    const indexPath = path.join(stateDir, "execution-outputs", workspace.id, "index.json");
    const beforeIndex = fs.readFileSync(indexPath, "utf8");
    expect(readExecutionOutputMetadataStrict(workspace.id)).toHaveLength(MAX_OUTPUT_RECORDS);

    expect(() => saveExecutionOutput(workspace.id, {
      command: "overflow", raw: "must remain uncommitted", taskId: "task-overflow", iteration: 1,
      commandId: "r5h-overflow",
    })).toThrow(/cleanup/i);

    expect(fs.readFileSync(indexPath, "utf8")).toBe(beforeIndex);
    expect(readExecutionOutputMetadataStrict(workspace.id)).toHaveLength(MAX_OUTPUT_RECORDS);
    expect(fs.existsSync(path.join(stateDir, "execution-outputs", workspace.id, "bodies", `${MAX_OUTPUT_RECORDS + 1}.txt`))).toBe(false);
  });

  it("fences new output, record, and dispatch writers as soon as snapshot_pending is durable", () => {
    const commandId = "r5h-fenced-writers";
    const target = { workspaceId: workspace.id, workspaceRoot, commandId, iteration: 1 as const, stateDir };
    writeCleanupJournal({ ...journal([], commandId), phase: "snapshot_pending" }, stateDir);

    expect(() => saveExecutionOutput(workspace.id, {
      command: "run", raw: "must not persist", taskId: "task", iteration: 1, commandId,
    })).toThrow(/cleanup/i);
    expect(() => appendExecutionRecord(workspace.id, record(commandId))).toThrow(/cleanup/i);
    expect(() => beginExecutorDispatch({
      workspaceId: workspace.id, workspaceRoot, bindingId: "binding-r5h", commandId,
      intent: "development_plan", message: "task", requestAuthoritySha256: "a".repeat(64),
      lifecycle: "ephemeral", stateDir,
    })).toThrow(/cleanup/i);
    expect(readExecutorDispatchState(workspace.id, stateDir)).toBeNull();
    expect(fs.existsSync(path.join(stateDir, "execution-outputs", workspace.id, "index.json"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "executions", workspace.id + ".jsonl"))).toBe(false);
    expect(inspectExecutionCleanupArtifacts(target)).toEqual([]);
  });

  it("allows a manually confirmed exact legacy dispatch entry at accepted status", () => {
    const commandId = "r5h-legacy-accepted";
    const legacyAccepted = dispatchEntry(commandId, randomUUID(), undefined, "accepted");
    writeDispatchEntry(legacyAccepted);
    const target = { workspaceId: workspace.id, workspaceRoot, commandId, iteration: 1 as const, stateDir };
    expect(inspectExecutorDispatchCleanupArtifacts(target, "auto_observed")).toEqual([]);
    const autoProof = cleanupArtifact("result_bus_delivery", commandId, { proof: "auto" });
    const autoJournal = { ...journal([autoProof], commandId), mode: "auto_observed" as const };
    writeCleanupJournal(autoJournal, stateDir);
    deleteExecutorDispatchCleanupArtifacts(target, [autoProof]);
    expect(readExecutorDispatchState(workspace.id, stateDir)?.entries.map(entry => entry.commandId)).toEqual([commandId]);
    removeCleanupJournal(autoJournal, stateDir);
    const artifacts = inspectExecutorDispatchCleanupArtifacts(target);
    expect(artifacts).toEqual([cleanupArtifact("executor_dispatch", commandId, legacyAccepted)]);
    const expected = [...artifacts, cleanupArtifact("result_bus_delivery", commandId, { proof: "manual" })];
    const cleanupJournal = journal(expected, commandId);
    writeCleanupJournal(cleanupJournal, stateDir);
    deleteExecutorDispatchCleanupArtifacts(target, expected);
    expect(readExecutorDispatchState(workspace.id, stateDir)?.entries).toEqual([]);
  });

  it("preserves legacy dispatch entries and rejects stale generation commits after command ID reuse", () => {
    const commandId = "r5h-dispatch";
    const generation1 = randomUUID();
    const ephemeral = dispatchEntry(commandId, generation1, "ephemeral");
    const legacy = dispatchEntry("legacy-r5h-entry", randomUUID(), undefined);
    writeDispatchEntry(ephemeral);
    writeDispatchEntry(legacy);
    const target = { workspaceId: workspace.id, workspaceRoot, commandId, iteration: 1 as const, stateDir };
    const artifacts = inspectExecutorDispatchCleanupArtifacts(target);
    expect(artifacts).toHaveLength(1);
    const expected = [...artifacts, cleanupArtifact("result_bus_delivery", commandId, { proof: "dispatch" })];
    const cleanupJournal = journal(expected, commandId);
    writeCleanupJournal(cleanupJournal, stateDir);
    deleteExecutorDispatchCleanupArtifacts(target, expected);
    expect(fs.existsSync(executorDispatchFile(workspace.id, stateDir))).toBe(true);
    expect(fs.existsSync(executorDispatchInitializedFile(workspace.id, stateDir))).toBe(true);
    expect(readExecutorDispatchState(workspace.id, stateDir)?.entries.map(entry => entry.commandId)).toEqual([legacy.commandId]);

    removeCleanupJournal(cleanupJournal, stateDir);
    const generation2 = randomUUID();
    const reused = dispatchEntry(commandId, generation2, "ephemeral");
    writeDispatchEntry(reused);
    expect(() => finalizeExecutorDispatch({
      workspaceId: workspace.id, workspaceRoot, commandId, target: reused.target,
      expectedDispatchGenerationId: generation1, result: { deliveryStatus: "accepted" }, stateDir,
    })).toThrow(/generation/i);
    expect(() => markExecutorDispatchOutcomeUnknown({
      workspaceId: workspace.id, workspaceRoot, commandId, target: reused.target,
      expectedDispatchGenerationId: generation1, stateDir,
    })).toThrow(/generation/i);
    expect(readExecutorDispatchState(workspace.id, stateDir)?.entries.find(entry => entry.commandId === commandId)).toMatchObject({
      deliveryStatus: "started", dispatchGenerationId: generation2,
    });
  });
});
