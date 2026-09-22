import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  applyProjection,
  ensureFeedbackState,
  feedbackEventSchema,
  finalReceiptRequiredEventSchema,
  feedbackStateFile,
  readFeedbackState,
  repairFinalReceiptRequired,
} from "../src/feedback/store.js";
import { reconcileFeedbackOutbox } from "../src/feedback/projector.js";
import { stageReceiptFinalization, writeReceiptFinalizationAlert } from "../src/desktop/receipt-finalizer.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const OCCURRED_AT = "2026-09-22T00:00:00.000Z";

describe("FINAL_RECEIPT_REQUIRED repair fence", () => {
  let stateDir: string;
  let root: string;

  afterEach(() => {
    if (stateDir) cleanup(stateDir);
    if (root) cleanup(root);
  });

  it("只在 durable alert + terminal event 支撑时锁内移除 control event", () => {
    stateDir = isolateStateDir();
    root = makeTmpDir("final-receipt-repair");
    const workspace = new Workspace(root);
    const draft = stageReceiptFinalization({
      workspaceId: workspace.id,
      workspaceRoot: root,
      threadId: "11111111-1111-4111-8111-111111111111",
      originTurnId: "22222222-2222-4222-8222-222222222222",
      resultTurnId: "33333333-3333-4333-8333-333333333333",
      commandId: "desktop_repair_command",
      inputMaterial: "repair",
    }, { stateDir });
    writeReceiptFinalizationAlert(draft, "timeout", { stateDir });

    const projected = reconcileFeedbackOutbox(workspace.id, stateDir);
    expect(projected.state.events).toHaveLength(1);
    const terminal = feedbackEventSchema.parse({
      version: 1,
      eventId: "a".repeat(32),
      kind: "C2C_EXECUTED",
      workspaceId: workspace.id,
      source: "desktop",
      commandId: draft.commandId,
      taskId: `desktop_${draft.commandId}`,
      iteration: 1,
      result: "ok",
      changedFilesSummary: [],
      testsSummary: "ok",
      outputAvailable: false,
      occurredAt: OCCURRED_AT,
      createdAt: OCCURRED_AT,
      updatedAt: OCCURRED_AT,
      targetBindingId: null,
      targetEpoch: null,
      targetPrincipalFingerprint: null,
      status: "queued",
    });
    applyProjection({ workspaceId: workspace.id, stateDir, nextCursor: 0, newEvents: [terminal] });

    const repaired = repairFinalReceiptRequired(workspace.id, stateDir);
    expect(repaired.removedEventIds).toHaveLength(1);
    expect(repaired.state.events.map((event) => event.kind)).toEqual(["C2C_EXECUTED"]);
  });

  it("无 durable alert 支撑时 fail closed 且不改写 state", () => {
    stateDir = isolateStateDir();
    root = makeTmpDir("final-receipt-unsupported");
    const workspace = new Workspace(root);
    ensureFeedbackState(workspace.id, 0, stateDir);
    const event = finalReceiptRequiredEventSchema.parse({
      version: 1,
      eventId: "b".repeat(32),
      kind: "FINAL_RECEIPT_REQUIRED",
      workspaceId: workspace.id,
      source: "control",
      commandId: "desktop_unsupported_command",
      taskId: "desktop_finalization_desktop_unsupported_command",
      iteration: 1,
      result: "blocked",
      changedFilesSummary: [],
      testsSummary: "",
      outputAvailable: false,
      reason: "timeout",
      occurredAt: OCCURRED_AT,
      createdAt: OCCURRED_AT,
      updatedAt: OCCURRED_AT,
      targetBindingId: null,
      targetEpoch: null,
      targetPrincipalFingerprint: null,
      status: "queued",
    });
    applyProjection({ workspaceId: workspace.id, stateDir, nextCursor: 0, newEvents: [event] });

    try {
      repairFinalReceiptRequired(workspace.id, stateDir);
      throw new Error("expected repair to fail closed");
    } catch (error) {
      expect(error).toMatchObject({ code: "FEEDBACK_FINALIZATION_UNSUPPORTED" });
    }
    expect(readFeedbackState(workspace.id, stateDir).events).toHaveLength(1);
  });

  it("损坏或重复 state fail closed", () => {
    stateDir = isolateStateDir();
    root = makeTmpDir("final-receipt-repair-corrupt");
    const workspace = new Workspace(root);
    ensureFeedbackState(workspace.id, 0, stateDir);
    const file = feedbackStateFile(workspace.id, stateDir);
    fs.writeFileSync(file, "{broken", "utf8");
    expect(() => repairFinalReceiptRequired(workspace.id, stateDir)).toThrow(/FEEDBACK_STATE_CORRUPT|损坏/);

    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      workspaceId: workspace.id,
      projectionCursor: 0,
      binding: null,
      events: [],
      pairingIntent: null,
      companion: null,
      rebindIntent: null,
      rebindPredecessor: null,
    }), "utf8");
    const state = JSON.parse(fs.readFileSync(file, "utf8")) as { events: unknown[]; [key: string]: unknown };
    const event = {
      version: 1,
      eventId: "c".repeat(32),
      kind: "C2C_EXECUTED",
      workspaceId: workspace.id,
      source: "desktop",
      commandId: "duplicate_command",
      taskId: "desktop_duplicate_command",
      iteration: 1,
      result: "ok",
      changedFilesSummary: [],
      testsSummary: "",
      outputAvailable: false,
      occurredAt: OCCURRED_AT,
      createdAt: OCCURRED_AT,
      updatedAt: OCCURRED_AT,
      targetBindingId: null,
      targetEpoch: null,
      targetPrincipalFingerprint: null,
      status: "queued",
    };
    state.events = [event, event];
    fs.writeFileSync(file, JSON.stringify(state), "utf8");
    expect(() => repairFinalReceiptRequired(workspace.id, stateDir)).toThrow(/重复 eventId/);
    expect(fs.readFileSync(file, "utf8")).toContain("duplicate_command");
  });

  it("声明 control-event capability 且旧 runtime 缺失能力时保持 false", async () => {
    const { hasRuntimeCapability, RUNTIME_CAPABILITY_FINAL_RECEIPT_REQUIRED } = await import("../src/bridge/runtime.js");
    expect(hasRuntimeCapability({ capabilities: [RUNTIME_CAPABILITY_FINAL_RECEIPT_REQUIRED] }, RUNTIME_CAPABILITY_FINAL_RECEIPT_REQUIRED)).toBe(true);
    expect(hasRuntimeCapability({}, RUNTIME_CAPABILITY_FINAL_RECEIPT_REQUIRED)).toBe(false);
  });
});
