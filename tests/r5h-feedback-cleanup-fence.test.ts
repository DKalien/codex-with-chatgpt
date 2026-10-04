import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";
import { CODEX_FEEDBACK_SCOPE, ensureFeedbackState, feedbackEventSchema, feedbackStateFile, readFeedbackState } from "../src/feedback/store.js";
import { applyProjection } from "../src/feedback/projection-store.js";
import { enableReceiver } from "../src/feedback/receiver.js";
import { ackObserved, ackObservedForCompanion, beginSend, claimNext, releaseReservation, reserveNext, retireOutcomeUnknown } from "../src/feedback/delivery-lifecycle.js";
import { FEEDBACK_CLAIM_STALE_MS, FEEDBACK_RESERVATION_STALE_MS } from "../src/feedback/schema.js";
import { readCleanupJournal } from "../src/command-cleanup/fence.js";
import { confirmCommandCleanup, previewCommandCleanup, resumeCommandCleanup } from "../src/command-cleanup/service.js";
import { resolveConversationPrincipal } from "../src/mcp/conversation-principal.js";
import { recoverStaleFeedback } from "../src/feedback/state-store.js";

const TARGET = "r5h-feedback-target";
const PEER = "r5h-feedback-peer";
const COMPANION = "55555555-5555-4555-8555-555555555555";

describe("R5h Feedback delivery cleanup fence", () => {
  let stateDir: string;
  let root: string;
  let workspace: Workspace;
  let principal: ReturnType<typeof resolveConversationPrincipal>;
  let binding: NonNullable<ReturnType<typeof readFeedbackState>["binding"]>;

  const target = (commandId: string) => ({
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    commandId,
    iteration: 1 as const,
    stateDir,
  });

  beforeEach(() => {
    stateDir = isolateStateDir();
    root = makeTmpDir("r5h-feedback-cleanup-ws");
    workspace = new Workspace(root);
    principal = resolveConversationPrincipal({
      authInfo: { token: "feedback-test", clientId: "feedback-test", scopes: [CODEX_FEEDBACK_SCOPE] } as never,
      sessionId: "feedback-test",
      _meta: { "openai/session": "feedback-test" },
    });
    ensureFeedbackState(workspace.id, 0, stateDir);
    binding = enableReceiver({ workspaceId: workspace.id, principal, widgetId: "feedback-test", stateDir }).binding!;
  });

  afterEach(() => {
    cleanup(stateDir);
    cleanup(root);
    vi.restoreAllMocks();
  });

  function event(commandId: string) {
    const now = new Date().toISOString();
    return feedbackEventSchema.parse({
      version: 1,
      eventId: randomUUID().replaceAll("-", ""),
      kind: "C2C_EXECUTED",
      workspaceId: workspace.id,
      source: "desktop",
      commandId,
      taskId: `desktop_${commandId}`,
      iteration: 1,
      result: "ok",
      changedFilesSummary: [],
      testsSummary: "PASS",
      outputAvailable: false,
      occurredAt: now,
      createdAt: now,
      updatedAt: now,
      targetBindingId: null,
      targetEpoch: null,
      targetPrincipalFingerprint: null,
      status: "queued",
    });
  }

  function seed(...commandIds: string[]) {
    const events = commandIds.map(event);
    applyProjection({ workspaceId: workspace.id, stateDir, nextCursor: 0, newEvents: events });
    return readFeedbackState(workspace.id, stateDir);
  }

  function fenceAfterManualConfirmCrash(commandId = TARGET): Buffer {
    const preview = previewCommandCleanup(target(commandId));
    expect(preview.status).toBe("preview");
    expect(preview.artifacts.some(item => item.kind === "feedback_event")).toBe(true);
    expect(() => confirmCommandCleanup(target(commandId), preview.confirmationSha256!, phase => {
      if (phase === "fenced") throw new Error("simulated crash after durable fence");
    })).toThrow("simulated crash after durable fence");
    expect(readCleanupJournal(workspace.id, commandId, stateDir)).toMatchObject({ mode: "manual_force", phase: "fenced" });
    return fs.readFileSync(feedbackStateFile(workspace.id, stateDir));
  }

  function expectFenced(action: () => unknown, bytes: Buffer): void {
    let error: unknown;
    try { action(); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "COMMAND_CLEANUP_IN_PROGRESS" });
    expect(fs.readFileSync(feedbackStateFile(workspace.id, stateDir))).toEqual(bytes);
  }

  function resumeDeletesTargetPreservingPeer(commandId = TARGET, expectedPeerStatus = "ready"): void {
    expect(resumeCommandCleanup(target(commandId))).toMatchObject({ status: "cleaned" });
    expect(readCleanupJournal(workspace.id, commandId, stateDir)).toBeNull();
    const state = readFeedbackState(workspace.id, stateDir);
    expect(state.events.some(item => item.commandId === commandId)).toBe(false);
    expect(state.events.find(item => item.commandId === PEER)?.status).toBe(expectedPeerStatus);
    expect(state.binding).toEqual(binding);
  }

  it("ready reserve and claim fail closed after exact manual confirm crashes at fenced; resume deletes only target", () => {
    seed(TARGET, PEER);
    const bytes = fenceAfterManualConfirmCrash();
    expectFenced(() => reserveNext({
      workspaceId: workspace.id, bindingId: binding.bindingId, epoch: binding.epoch,
      principalFingerprint: principal.fingerprint, companionId: COMPANION, stateDir,
    }), bytes);
    expectFenced(() => claimNext({
      workspaceId: workspace.id, principal, bindingId: binding.bindingId, epoch: binding.epoch, stateDir,
    }), bytes);
    expect(readFeedbackState(workspace.id, stateDir).events.find(item => item.commandId === TARGET)).toMatchObject({ status: "ready" });
    resumeDeletesTargetPreservingPeer();
  });

  it("reserved begin-send and release fail closed without changing the reservation", () => {
    seed(TARGET, PEER);
    const reserved = reserveNext({
      workspaceId: workspace.id, bindingId: binding.bindingId, epoch: binding.epoch,
      principalFingerprint: principal.fingerprint, companionId: COMPANION, stateDir,
    });
    const frozen = reserved.event;
    const bytes = fenceAfterManualConfirmCrash();
    const identity = {
      workspaceId: workspace.id, bindingId: binding.bindingId, epoch: binding.epoch,
      principalFingerprint: principal.fingerprint, companionId: COMPANION,
      eventId: frozen.eventId, reservationId: reserved.reservationId, stateDir,
    };
    expectFenced(() => beginSend(identity), bytes);
    expectFenced(() => releaseReservation(identity), bytes);
    expect(readFeedbackState(workspace.id, stateDir).events.find(item => item.eventId === frozen.eventId)).toEqual(frozen);
    resumeDeletesTargetPreservingPeer();
  });

  it("claimed ACK and retire fail closed without changing attempt identity", () => {
    seed(TARGET, PEER);
    const reserved = reserveNext({
      workspaceId: workspace.id, bindingId: binding.bindingId, epoch: binding.epoch,
      principalFingerprint: principal.fingerprint, companionId: COMPANION, stateDir,
    });
    const claimed = beginSend({
      workspaceId: workspace.id, bindingId: binding.bindingId, epoch: binding.epoch,
      principalFingerprint: principal.fingerprint, companionId: COMPANION,
      eventId: reserved.event.eventId, reservationId: reserved.reservationId, stateDir,
    });
    const bytes = fenceAfterManualConfirmCrash();
    const ack = {
      workspaceId: workspace.id, bindingId: binding.bindingId, epoch: binding.epoch,
      eventId: claimed.event.eventId, attemptId: claimed.attemptId, stateDir,
    };
    expectFenced(() => ackObserved({ ...ack, principal }), bytes);
    expectFenced(() => ackObservedForCompanion({
      ...ack, principalFingerprint: principal.fingerprint, companionId: COMPANION,
    }), bytes);
    expectFenced(() => retireOutcomeUnknown({
      ...ack, principalFingerprint: principal.fingerprint, companionId: COMPANION,
      reservationId: reserved.reservationId,
    }), bytes);
    expect(readFeedbackState(workspace.id, stateDir).events.find(item => item.eventId === claimed.event.eventId))
      .toMatchObject({ status: "claimed", attemptId: claimed.attemptId, reservationId: reserved.reservationId });
    resumeDeletesTargetPreservingPeer();
  });

  it("outcome-unknown ACK and retire fail closed without changing attempt identity", () => {
    seed(TARGET, PEER);
    const reserved = reserveNext({
      workspaceId: workspace.id, bindingId: binding.bindingId, epoch: binding.epoch,
      principalFingerprint: principal.fingerprint, companionId: COMPANION, stateDir,
    });
    const claimed = beginSend({
      workspaceId: workspace.id, bindingId: binding.bindingId, epoch: binding.epoch,
      principalFingerprint: principal.fingerprint, companionId: COMPANION,
      eventId: reserved.event.eventId, reservationId: reserved.reservationId, stateDir,
    });
    const staleNow = Date.now() + FEEDBACK_CLAIM_STALE_MS + 1;
    expect(readFeedbackState(workspace.id, stateDir).events.find(item => item.eventId === claimed.event.eventId)?.status).toBe("claimed");
    // Keep this cleanup case outcome_unknown, then separately exercise blocked stale convergence below.
    const stateFile = feedbackStateFile(workspace.id, stateDir);
    const raw = JSON.parse(fs.readFileSync(stateFile, "utf8")) as ReturnType<typeof readFeedbackState>;
    const current = raw.events.find(item => item.eventId === claimed.event.eventId)!;
    current.claimedAt = new Date(staleNow - FEEDBACK_CLAIM_STALE_MS - 10).toISOString();
    fs.writeFileSync(stateFile, JSON.stringify(raw, null, 2));
    // This explicit recovery uses the ordinary legacy path before the fence and creates a valid unknown attempt.
    expect(readFeedbackState(workspace.id, stateDir).events.find(item => item.eventId === claimed.event.eventId)?.status).toBe("claimed");
    const beforeUnknown = fs.readFileSync(stateFile);
    expect(() => recoverStaleFeedback(workspace.id, stateDir, staleNow)).not.toThrow();
    const unknown = readFeedbackState(workspace.id, stateDir).events.find(item => item.eventId === claimed.event.eventId)!;
    expect(unknown.status).toBe("outcome_unknown");
    expect(unknown.attemptId).toBe(claimed.attemptId);
    expect(fs.readFileSync(stateFile)).not.toEqual(beforeUnknown);

    const bytes = fenceAfterManualConfirmCrash();
    const ack = {
      workspaceId: workspace.id, bindingId: binding.bindingId, epoch: binding.epoch,
      eventId: unknown.eventId, attemptId: claimed.attemptId, stateDir,
    };
    expectFenced(() => ackObserved({ ...ack, principal }), bytes);
    expectFenced(() => ackObservedForCompanion({
      ...ack, principalFingerprint: principal.fingerprint, companionId: COMPANION,
    }), bytes);
    expectFenced(() => retireOutcomeUnknown({
      ...ack, principalFingerprint: principal.fingerprint, companionId: COMPANION,
      reservationId: reserved.reservationId,
    }), bytes);
    expect(readFeedbackState(workspace.id, stateDir).events.find(item => item.eventId === unknown.eventId))
      .toMatchObject({ status: "outcome_unknown", attemptId: claimed.attemptId, reservationId: reserved.reservationId });
    resumeDeletesTargetPreservingPeer();
  });

  it("stale reservation recovery is fenced before clearing reservation identity", () => {
    seed(TARGET, PEER);
    const reserved = reserveNext({
      workspaceId: workspace.id, bindingId: binding.bindingId, epoch: binding.epoch,
      principalFingerprint: principal.fingerprint, companionId: COMPANION, stateDir,
    });
    const stateFile = feedbackStateFile(workspace.id, stateDir);
    const raw = JSON.parse(fs.readFileSync(stateFile, "utf8")) as ReturnType<typeof readFeedbackState>;
    const current = raw.events.find(item => item.eventId === reserved.event.eventId)!;
    current.reservedAt = new Date(Date.now() - FEEDBACK_RESERVATION_STALE_MS - 1).toISOString();
    fs.writeFileSync(stateFile, JSON.stringify(raw, null, 2));
    const stale = readFeedbackState(workspace.id, stateDir).events.find(item => item.eventId === reserved.event.eventId)!;
    const bytes = fenceAfterManualConfirmCrash();
    expectFenced(() => recoverStaleFeedback(workspace.id, stateDir, Date.now()), bytes);
    expect(readFeedbackState(workspace.id, stateDir).events.find(item => item.eventId === stale.eventId)).toEqual(stale);
    resumeDeletesTargetPreservingPeer();
  });

  it("rejects a command appended after the pre-lock snapshot before any lifecycle mutation", () => {
    seed(TARGET);
    const stateFile = feedbackStateFile(workspace.id, stateDir);
    const commandLock = path.join(stateDir, "command-cleanup", workspace.id, `${TARGET}.json.lock`);
    const added = event("r5h-feedback-added-during-lock");
    const original = fs.openSync;
    let injected = false;
    let bytesAfterProjection: Buffer | undefined;
    vi.spyOn(fs, "openSync").mockImplementation((file: Parameters<typeof fs.openSync>[0], flags: Parameters<typeof fs.openSync>[1], mode?: Parameters<typeof fs.openSync>[2]) => {
      if (!injected && String(file) === commandLock) {
        injected = true;
        applyProjection({ workspaceId: workspace.id, stateDir, nextCursor: 0, newEvents: [added] });
        bytesAfterProjection = fs.readFileSync(stateFile);
      }
      return original(file, flags, mode);
    });
    let error: unknown;
    try {
      claimNext({ workspaceId: workspace.id, principal, bindingId: binding.bindingId, epoch: binding.epoch, stateDir });
    } catch (caught) { error = caught; }
    expect(injected).toBe(true);
    expect(error).toMatchObject({ code: "FEEDBACK_COMMAND_SNAPSHOT_CHANGED" });
    const state = readFeedbackState(workspace.id, stateDir);
    expect(state.events.find(item => item.commandId === TARGET)).toMatchObject({ status: "ready" });
    expect(state.events.find(item => item.commandId === added.commandId)).toMatchObject({ status: "ready" });
    expect(fs.readFileSync(stateFile)).toEqual(bytesAfterProjection);
  });

  it("ordinary legacy reservation, begin, ACK, and claim still work without a journal", () => {
    seed(TARGET);
    const reserved = reserveNext({
      workspaceId: workspace.id, bindingId: binding.bindingId, epoch: binding.epoch,
      principalFingerprint: principal.fingerprint, companionId: COMPANION, stateDir,
    });
    const claimed = beginSend({
      workspaceId: workspace.id, bindingId: binding.bindingId, epoch: binding.epoch,
      principalFingerprint: principal.fingerprint, companionId: COMPANION,
      eventId: reserved.event.eventId, reservationId: reserved.reservationId, stateDir,
    });
    expect(ackObservedForCompanion({
      workspaceId: workspace.id, bindingId: binding.bindingId, epoch: binding.epoch,
      principalFingerprint: principal.fingerprint, companionId: COMPANION,
      eventId: claimed.event.eventId, attemptId: claimed.attemptId, stateDir,
    }).status).toBe("observed");

    seed("r5h-feedback-claim-safe");
    const claimBinding = readFeedbackState(workspace.id, stateDir).binding!;
    expect(claimNext({
      workspaceId: workspace.id, principal, bindingId: claimBinding.bindingId, epoch: claimBinding.epoch, stateDir,
    }).event.status).toBe("claimed");
  });
});
