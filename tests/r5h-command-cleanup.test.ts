import { createWorkspaceMaintenance } from "../src/bridge/maintenance.js";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { readDesktop, updateDesktop, desktopFile } from "../src/desktop/store.js";
import { desktopHistory } from "../src/desktop/history.js";
import { appendExecutionRecordLocked, readExecutionRecordsStrict, withExecutionRecordsLock, appendExecutionRecord } from "../src/execution/records.js";
import { readExecutionOutputMetadataStrict, saveExecutionOutput } from "../src/execution/output.js";
import { appendTrustedReceiptLocked } from "../src/desktop/result-commit.js";
import { registerRoute, createCommand, transitionCommandDelivery } from "../src/routing/store.js";
import { reconcileTrustedDesktopExecutionResult } from "../src/routing/execution-result-reconciler.js";
import { reconcileWorkspaceResultBus } from "../src/result-bus/service.js";
import { enqueueResultBusEntry, listResultBusEntries } from "../src/result-bus/store.js";
import { ackResultBusObserved, reserveNextResultBusEntry, beginResultBusSend, markResultBusOutcomeUnknown, recoverStaleResultBusEntries } from "../src/result-bus/delivery-lifecycle.js";
import { bindCurrentWebSink, readActiveWebSinkBinding } from "../src/web-sink-control/service.js";
import { projectChatgptRouteToWebSinkCandidate } from "../src/web-sink-control/chatgpt-surface.js";
import { reconcileFeedbackOutbox } from "../src/feedback/projector.js";
import { confirmCommandCleanup, inspectCommandCleanupArtifacts, previewCommandCleanup, resumeCommandCleanup, type CleanupStage } from "../src/command-cleanup/service.js";
import { assertCommandWritable, cleanupJournalFile, readCleanupJournal, withCommandOperationAsync, writeCleanupJournal } from "../src/command-cleanup/fence.js";
import { issueTerminalWitness, verifyTerminalWitness } from "../src/command-cleanup/terminal-witness.js";
import { cleanupJournalSchema, type CleanupJournal } from "../src/command-cleanup/schema.js";
import { CommandCleanupError } from "../src/command-cleanup/schema.js";
import * as lifecycleFence from "../src/command-cleanup/fence.js";
import * as resultOutbox from "../src/routing/result-outbox-store.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const ROUTE = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
describe("R5h command runtime auto-destroy / exact force cleanup", () => {
  let stateDir: string, root: string, previous: string | undefined, workspace: Workspace;
  const target = (commandId = "cleanup_x") => ({ workspaceId: workspace.id, workspaceRoot: workspace.root, commandId, iteration: 1, stateDir });
  function delivery(commandId: string, complete = true, ephemeral = true) {
    const now = new Date().toISOString();
    const prior = readDesktop(workspace.id);
    const binding = prior?.binding ?? { bindingId: randomUUID(), threadId: randomUUID(), hostId: "local" as const, projectId: "cleanup-project", title: "fixture", boundAt: now };
    const item = {
      commandId, deliveryId: randomUUID(), clientId: "cleanup-test", bindingId: binding.bindingId,
      ...(ephemeral ? { lifecycle: "ephemeral" as const } : {}), intent: "development_plan" as const,
      threadId: binding.threadId, ...(complete ? { turnId: randomUUID() } : {}),
      messageBytes: 4, messageSha256: createHash("sha256").update("task").digest("hex"),
      deliveryStatus: complete ? "accepted" as const : "outcome_unknown" as const, createdAt: now, updatedAt: now,
    };
    updateDesktop(workspace.id, current => ({
      state: { ...(current ?? { version: 1, workspaceId: workspace.id, workspaceRoot: root, enabled: true, binding, runtimeFence: null, deliveries: [] }), deliveries: [...(current?.deliveries ?? []), item] },
      result: null,
    }));
    return item;
  }
  function canonical(commandId = "cleanup_x", ephemeral = true) {
    const accepted = delivery(commandId, true, ephemeral);
    const planner = registerRoute(workspace, { role: "planner", platform: "chatgpt_web", conversationId: "planner", locator: {} });
    const executor = registerRoute(workspace, { role: "executor", platform: "codex_desktop", conversationId: accepted.threadId, locator: { hostId: "local", executorProjectId: "cleanup-project" } });
    createCommand(workspace, { commandId, plannerRouteId: planner.routeId, executorRouteId: executor.routeId, intent: accepted.intent, payloadBytes: accepted.messageBytes, payloadSha256: accepted.messageSha256 });
    transitionCommandDelivery(workspace, { commandId, deliveryStatus: "accepted" });
    const output = saveExecutionOutput(workspace.id, { command: "fixture test", raw: "fixture output", exitCode: 0, taskId: "desktop_" + commandId, commandId, iteration: 1 });
    withExecutionRecordsLock(workspace.id, () => appendExecutionRecordLocked(workspace.id, {
      taskId: "desktop_" + commandId, commandId, iteration: 1, changedFiles: [], tests: "PASS", exitStatus: "ok", timestamp: new Date().toISOString(),
      rawSummary: "fixture result", desktopReceiptSha256: "a".repeat(64), desktopThreadId: accepted.threadId,
      desktopOriginTurnId: accepted.turnId!, desktopResultTurnId: accepted.turnId!, desktopBindingId: accepted.bindingId,
      outputId: output.id, outputAvailable: output.allowed,
    }));
    expect(reconcileTrustedDesktopExecutionResult(workspace, commandId)).toMatchObject({ status: "reconciled", resultBus: { status: "reconciled" } });
    return { entry: listResultBusEntries(workspace, stateDir).find(item => item.commandId === commandId)!, output };
  }
  function claim(commandId = "cleanup_x") {
    bindCurrentWebSink(workspace.id, projectChatgptRouteToWebSinkCandidate({ workspaceId: workspace.id, routeCanonical: ROUTE }));
    const reserved = reserveNextResultBusEntry(workspace, {}, stateDir);
    if (reserved.status !== "reserved" || reserved.entry.commandId !== commandId) throw new Error("fixture reservation mismatch");
    const claimed = beginResultBusSend(workspace, { busEntryId: reserved.entry.busEntryId, reservationId: reserved.entry.reservation!.reservationId }, {}, stateDir);
    if (claimed.status !== "claimed") throw new Error("fixture claim failed");
    return claimed;
  }
  beforeEach(() => { previous = process.env.C2C_STATE_DIR; stateDir = isolateStateDir(); root = makeTmpDir("r5h-command-ws"); workspace = new Workspace(root); });
  afterEach(() => { vi.restoreAllMocks(); if (previous === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = previous; cleanup(root); cleanup(stateDir); });

  it("observed immediately deletes runtime state and output, bindings survive and backfill cannot recreate", () => {
    const { output } = canonical(); const claimed = claim(); const binding = readDesktop(workspace.id)!.binding;
    expect(ackResultBusObserved(workspace, { busEntryId: claimed.entry.busEntryId, attemptId: claimed.attemptId }, {}, stateDir)).toMatchObject({ status: "observed", cleanupStatus: "cleaned" });
    expect(inspectCommandCleanupArtifacts(target())).toEqual([]);
    expect(readCleanupJournal(workspace.id, "cleanup_x", stateDir)).toBeNull();
    expect(fs.existsSync(cleanupJournalFile(workspace.id, "cleanup_x", stateDir))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "execution-outputs", workspace.id, "bodies", output.id + ".txt"))).toBe(false);
    expect(readDesktop(workspace.id)!.binding).toEqual(binding);
    expect(readActiveWebSinkBinding(workspace.id)!.bindingId).toBe(claimed.sendTarget.bindingId);
    expect(reconcileWorkspaceResultBus(workspace, stateDir)).toEqual({ projected: 0, replayed: 0 });
    reconcileFeedbackOutbox(workspace.id, stateDir, root);
    expect(inspectCommandCleanupArtifacts(target())).toEqual([]);
    expect(previewCommandCleanup(target()).status).toBe("not_found");
    delivery("cleanup_x"); expect(readDesktop(workspace.id)!.deliveries).toHaveLength(1);
  });

  it("receipt commit uses the supplied stateDir for output, records, and cleanup fence", () => {
    const explicitStateDir = makeTmpDir("r5h-receipt-explicit-state");
    const defaultStateDir = makeTmpDir("r5h-receipt-default-state");
    const previousStateDir = process.env.C2C_STATE_DIR;
    process.env.C2C_STATE_DIR = defaultStateDir;
    const commandId = "explicit_state_dir";
    const input = { commandId, changedFiles: [], tests: "PASS", exitStatus: "ok" as const, rawSummary: "fixture summary", output: "fixture output" };
    const record = {
      taskId: `desktop_${commandId}`, iteration: 1, changedFiles: [], tests: "PASS", exitStatus: "ok", timestamp: new Date().toISOString(),
      rawSummary: input.rawSummary, commandId, desktopReceiptSha256: "b".repeat(64),
      desktopThreadId: randomUUID(), desktopOriginTurnId: randomUUID(), desktopResultTurnId: randomUUID(), desktopBindingId: randomUUID(),
    };
    try {
      const committed = appendTrustedReceiptLocked(workspace.id, input, record, explicitStateDir);
      expect(committed.output).not.toBeNull();
      expect(readExecutionRecordsStrict(workspace.id, explicitStateDir)).toHaveLength(1);
      expect(readExecutionRecordsStrict(workspace.id, defaultStateDir)).toEqual([]);
      expect(readExecutionOutputMetadataStrict(workspace.id, explicitStateDir)).toHaveLength(1);
      expect(readExecutionOutputMetadataStrict(workspace.id, defaultStateDir)).toEqual([]);

      writeCleanupJournal(cleanupJournalSchema.parse({
        version: 1, workspaceId: workspace.id, workspaceRoot: workspace.root, commandId, iteration: 1,
        cleanupId: randomUUID(), mode: "manual_force", phase: "fenced", createdAt: new Date().toISOString(), artifacts: [],
      }), explicitStateDir);
      expect(readCleanupJournal(workspace.id, commandId, explicitStateDir)).not.toBeNull();
      expect(readCleanupJournal(workspace.id, commandId, defaultStateDir)).toBeNull();
      expect(() => appendTrustedReceiptLocked(workspace.id, input, record, explicitStateDir)).toThrow("cleanup");
      expect(readExecutionRecordsStrict(workspace.id, explicitStateDir)).toHaveLength(1);
      expect(readExecutionOutputMetadataStrict(workspace.id, explicitStateDir)).toHaveLength(1);
    } finally {
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
      cleanup(explicitStateDir);
      cleanup(defaultStateDir);
    }
  });

  it.each(["snapshot_pending", "fenced", "projections_deleted", "cursor_prepared", "record_deleted", "cursor_applied", "producers_deleted", "bus_deleted"] as CleanupStage[])("crash after %s: resume deletes only, producer fences remain", phase => {
    const { entry } = canonical(); const claimed = claim(); let crashed = false;
    reconcileFeedbackOutbox(workspace.id, stateDir, root);
    const outcome = ackResultBusObserved(workspace, { busEntryId: entry.busEntryId, attemptId: claimed.attemptId }, { cleanupPhaseHook: current => { if (current === phase) { crashed = true; throw new Error("crash seam"); } } }, stateDir);
    expect(crashed).toBe(true); expect(outcome).toMatchObject({ status: "observed", cleanupStatus: "cleanup_pending" });
    const journal = readCleanupJournal(workspace.id, "cleanup_x", stateDir)!;
    expect(journal.phase).toBe(["cursor_prepared", "record_deleted", "cursor_applied"].includes(phase) ? "projections_deleted" : phase);
    expect(JSON.stringify(journal)).not.toContain("fixture result");
    expect(JSON.stringify(journal)).not.toContain("fixture output");
    expect(() => assertCommandWritable(workspace.id, "cleanup_x", stateDir)).toThrow("cleanup");
    expect(() => enqueueResultBusEntry(workspace, entry.result, stateDir)).toThrow("cleanup");
    expect(() => appendExecutionRecord(workspace.id, { taskId: "desktop_cleanup_x", commandId: "cleanup_x", iteration: 1, changedFiles: [], tests: "PASS", exitStatus: "ok", timestamp: new Date().toISOString() })).toThrow("cleanup");
    expect(reconcileTrustedDesktopExecutionResult(workspace, "cleanup_x")).toMatchObject({ status: "reconciliation_needed", issuePersisted: false });
    reconcileWorkspaceResultBus(workspace, stateDir);
    expect(resumeCommandCleanup(target()).status).toBe("cleaned");
    expect(inspectCommandCleanupArtifacts(target())).toEqual([]);
    expect(readCleanupJournal(workspace.id, "cleanup_x", stateDir)).toBeNull();
    expect(readExecutionRecordsStrict(workspace.id)).toEqual([]);
  });

  it("cleanup failure never rolls ACK back; duplicate exact ACK resumes deletion", () => {
    const { entry } = canonical(); const claimed = claim();
    const first = ackResultBusObserved(workspace, { busEntryId: entry.busEntryId, attemptId: claimed.attemptId }, { cleanupPhaseHook: phase => { if (phase === "fenced") throw new Error("crash"); } }, stateDir);
    expect(first.cleanupStatus).toBe("cleanup_pending");
    expect(listResultBusEntries(workspace, stateDir)[0]!.deliveryStatus).toBe("observed");
    expect(ackResultBusObserved(workspace, { busEntryId: entry.busEntryId, attemptId: claimed.attemptId }, {}, stateDir)).toMatchObject({ status: "observed", noWrite: true, cleanupStatus: "cleaned" });
    expect(inspectCommandCleanupArtifacts(target())).toEqual([]);
  });

  it("reconciler error handling cannot recreate a diagnostic after cleanup or lock refusal", () => {
    canonical();
    const diagnostic = vi.spyOn(resultOutbox, "markResultReconciliationNeeded");
    vi.spyOn(lifecycleFence, "withCommandOperation").mockImplementationOnce(() => { throw new CommandCleanupError("COMMAND_CLEANUP_BUSY", "seam"); });
    expect(reconcileTrustedDesktopExecutionResult(workspace, "cleanup_x")).toMatchObject({ issuePersisted: false });
    expect(diagnostic).not.toHaveBeenCalled();
    vi.spyOn(lifecycleFence, "withCommandOperation").mockImplementationOnce(() => {
      const preview = previewCommandCleanup(target());
      confirmCommandCleanup(target(), preview.confirmationSha256!);
      throw new Error("old failure released authority before reporting");
    });
    expect(reconcileTrustedDesktopExecutionResult(workspace, "cleanup_x")).toMatchObject({ issuePersisted: false });
    expect(diagnostic).not.toHaveBeenCalled();
    expect(inspectCommandCleanupArtifacts(target())).toEqual([]);
  });

  it("unfinished shared atomic write stays fail closed; ACK is terminal and residue is never ignored", () => {
    const { entry } = canonical(); const claimed = claim();
    const bus = path.join(stateDir, "result-bus", workspace.id + ".json");
    const leftover = bus + "." + randomUUID() + ".tmp";
    fs.copyFileSync(bus, leftover);
    expect(() => previewCommandCleanup(target())).toThrow("residue");
    expect(ackResultBusObserved(workspace, { busEntryId: entry.busEntryId, attemptId: claimed.attemptId }, {}, stateDir)).toMatchObject({ status: "observed", cleanupStatus: "cleanup_pending" });
    expect(fs.existsSync(leftover)).toBe(true);
    expect(readDesktop(workspace.id)!.deliveries).toHaveLength(1);
  });

  it("runtime resumes observed ACK when first journal rename failed; no historical migration", () => {
    const { entry } = canonical(); const claimed = claim();
    const original = fs.renameSync;
    const fault = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).includes("command-cleanup")) throw new Error("journal I/O seam");
      return original(from, to);
    });
    expect(ackResultBusObserved(workspace, { busEntryId: entry.busEntryId, attemptId: claimed.attemptId }, {}, stateDir)).toMatchObject({ status: "observed", cleanupStatus: "cleanup_pending" });
    expect(readCleanupJournal(workspace.id, "cleanup_x", stateDir)).toBeNull();
    fault.mockRestore();
    reconcileFeedbackOutbox(workspace.id, stateDir, root);
    expect(inspectCommandCleanupArtifacts(target()).length).toBeGreaterThan(0); // Projection is no longer cleanup authority.
    createWorkspaceMaintenance(workspace, stateDir)();
    expect(inspectCommandCleanupArtifacts(target())).toEqual([]);
  });

  it("busy async writer cannot wait across completed cleanup; valid atomic leftovers are removed", async () => {
    delivery("cleanup_x"); const preview = previewCommandCleanup(target()); let lateWrites = 0;
    // Reproduce another process owning the operation without inheriting its context.
    const lock = cleanupJournalFile(workspace.id, "cleanup_x", stateDir) + ".lock";
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
    lateWrites = 0;
    const rejected = withCommandOperationAsync(workspace.id, "cleanup_x", async () => { lateWrites++; }, stateDir);
    const result = rejected.catch(error => error.code);
    fs.unlinkSync(lock);
    expect(confirmCommandCleanup(target(), preview.confirmationSha256!).status).toBe("cleaned");
    expect(await result).toBe("COMMAND_CLEANUP_BUSY"); expect(lateWrites).toBe(0);

    delivery("cleanup_x"); const fresh = previewCommandCleanup(target());
    confirmCommandCleanup(target(), fresh.confirmationSha256!, phase => {
      if (phase === "producers_deleted") {
        const journal = readCleanupJournal(workspace.id, "cleanup_x", stateDir)!;
        fs.writeFileSync(cleanupJournalFile(workspace.id, "cleanup_x", stateDir) + "." + randomUUID() + ".tmp", JSON.stringify(journal));
      }
    });
    expect(fs.readdirSync(path.dirname(cleanupJournalFile(workspace.id, "cleanup_x", stateDir)))).toEqual([]);
  });

  it("detached callback cannot reuse an expired in-memory lock lease after destruction", async () => {
    delivery("cleanup_x"); let continueOld!: () => void; let late!: Promise<unknown>;
    await withCommandOperationAsync(workspace.id, "cleanup_x", async () => {
      late = new Promise<void>(resolve => { continueOld = resolve; }).then(() => {
        appendExecutionRecord(workspace.id, { commandId: "cleanup_x", taskId: "desktop_cleanup_x", iteration: 1, changedFiles: [], tests: "PASS", exitStatus: "ok", timestamp: new Date().toISOString() });
      }).catch(error => error.code);
    }, stateDir);
    const preview = previewCommandCleanup(target()); confirmCommandCleanup(target(), preview.confirmationSha256!);
    continueOld(); expect(await late).toBe("COMMAND_CLEANUP_LOCK_LOST");
    expect(inspectCommandCleanupArtifacts(target())).toEqual([]);
  });

  it.each(["accepted", "outcome_unknown", "receipt_only", "claimed", "browser_unknown"])("manual exact confirm removes incomplete %s and preserves sibling", status => {
    if (status === "claimed" || status === "browser_unknown") { canonical(); const claimed = claim(); if (status === "browser_unknown") markResultBusOutcomeUnknown(workspace, { busEntryId: claimed.entry.busEntryId, attemptId: claimed.attemptId }, {}, stateDir); }
    else if (status === "receipt_only") appendExecutionRecord(workspace.id, { commandId: "cleanup_x", taskId: "desktop_cleanup_x", iteration: 1, changedFiles: [], tests: "PASS", exitStatus: "ok", timestamp: new Date().toISOString() });
    else delivery("cleanup_x", status === "accepted");
    delivery("cleanup_y"); const y = readDesktop(workspace.id)!.deliveries.find(item => item.commandId === "cleanup_y");
    const before = fs.readFileSync(desktopFile(workspace.id), "utf8"); const preview = previewCommandCleanup(target());
    expect(preview.status).toBe("preview"); expect(preview.notice).toContain("绝不自动重发");
    expect(fs.readFileSync(desktopFile(workspace.id), "utf8")).toBe(before); expect(readCleanupJournal(workspace.id, "cleanup_x", stateDir)).toBeNull();
    expect(confirmCommandCleanup(target(), preview.confirmationSha256!).status).toBe("cleaned");
    expect(inspectCommandCleanupArtifacts(target())).toEqual([]); expect(readDesktop(workspace.id)!.deliveries).toEqual([y]);
    recoverStaleResultBusEntries(workspace, { nowMs: Date.now() + 1e8 }, stateDir);
    expect(listResultBusEntries(workspace, stateDir)).toEqual([]);
  });

  it("preview drift refuses zero deletion; active send cannot race a force cleanup late commit", async () => {
    delivery("cleanup_x"); const preview = previewCommandCleanup(target());
    updateDesktop(workspace.id, state => ({ state: { ...state!, deliveries: state!.deliveries.map(item => ({ ...item, updatedAt: new Date(Date.now() + 1000).toISOString() })) }, result: null }));
    expect(() => confirmCommandCleanup(target(), preview.confirmationSha256!)).toThrow("confirmation");
    expect(readCleanupJournal(workspace.id, "cleanup_x", stateDir)).toBeNull();
    const fresh = previewCommandCleanup(target()); let unlock!: () => void;
    const inFlight = withCommandOperationAsync(workspace.id, "cleanup_x", () => new Promise<void>(resolve => { unlock = resolve; }), stateDir);
    expect(() => confirmCommandCleanup(target(), fresh.confirmationSha256!)).toThrow("lifecycle");
    unlock(); await inFlight; expect(confirmCommandCleanup(target(), fresh.confirmationSha256!).status).toBe("cleaned");
  });

  it("legacy observed history remains intact; no automatic migration deletion", () => {
    canonical("legacy", false); const claimed = claim("legacy");
    expect(ackResultBusObserved(workspace, { busEntryId: claimed.entry.busEntryId, attemptId: claimed.attemptId }, {}, stateDir)).toMatchObject({ status: "observed" });
    expect(listResultBusEntries(workspace, stateDir)).toHaveLength(1); expect(readDesktop(workspace.id)!.deliveries).toHaveLength(1);
    expect(readCleanupJournal(workspace.id, "legacy", stateDir)).toBeNull();
  });

  it("completed deleted command leaves rollout history; incomplete remains unresolved", () => {
    canonical(); const claimed = claim(); delivery("cleanup_y");
    ackResultBusObserved(workspace, { busEntryId: claimed.entry.busEntryId, attemptId: claimed.attemptId }, {}, stateDir);
    const history = desktopHistory(workspace);
    expect(history.accepted.map(item => item.commandId)).toEqual(["cleanup_y"]); expect(history.statuses.get("cleanup_y")).toBe("unresolved");
  });

  it("corrupt journal and symlink output refuse cleanup without deleting external content", () => {
    const { output } = canonical(); const preview = previewCommandCleanup(target());
    const file = cleanupJournalFile(workspace.id, "cleanup_x", stateDir); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "{}");
    expect(() => previewCommandCleanup(target())).toThrow("损坏"); fs.unlinkSync(file);
    const body = path.join(stateDir, "execution-outputs", workspace.id, "bodies", output.id + ".txt");
    const outside = path.join(root, "protected.txt"); fs.writeFileSync(outside, "fixture output"); fs.unlinkSync(body); fs.symlinkSync(outside, body, "file");
    expect(() => confirmCommandCleanup(target(), preview.confirmationSha256!)).toThrow();
    expect(fs.readFileSync(outside, "utf8")).toBe("fixture output"); expect(readCleanupJournal(workspace.id, "cleanup_x", stateDir)).toBeNull();
    expect(() => previewCommandCleanup({ ...target(), workspaceId: "f".repeat(12) })).toThrow();
  });

  it("signed exact attempt witness verifies without command history; arbitrary identity/forgery fails noWrite", () => {
    const input = { workspaceId: workspace.id, eventId: "a".repeat(32), attemptId: randomUUID(), routeCanonical: ROUTE, companionId: randomUUID() };
    expect(verifyTerminalWitness("bad", input, stateDir)).toBe(false); expect(fs.existsSync(path.join(stateDir, "command-cleanup-keys"))).toBe(false);
    const token = issueTerminalWitness(input, stateDir);
    expect(verifyTerminalWitness(token, input, stateDir)).toBe(true); expect(verifyTerminalWitness(token, { ...input, routeCanonical: ROUTE + "/" }, stateDir)).toBe(true);
    for (const changed of [{ ...input, eventId: "b".repeat(32) }, { ...input, attemptId: randomUUID() }, { ...input, companionId: randomUUID() }, { ...input, routeCanonical: ROUTE.replace("11111111-1111", "22222222-2222") }]) expect(verifyTerminalWitness(token, changed, stateDir)).toBe(false);
    expect(verifyTerminalWitness(token.slice(0, -1) + (token.endsWith("a") ? "b" : "a"), input, stateDir)).toBe(false);
    expect(fs.readFileSync(path.join(stateDir, "command-cleanup-keys", workspace.id + ".json"), "utf8")).not.toContain(input.attemptId);
  });
});
