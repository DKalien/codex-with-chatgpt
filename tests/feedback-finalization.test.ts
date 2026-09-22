import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { stageReceiptFinalization, writeReceiptFinalizationAlert } from "../src/desktop/receipt-finalizer.js";
import { reconcileFeedbackOutbox } from "../src/feedback/projector.js";
import { formatProductionFeedbackMessage } from "../src/feedback/message.js";
import {
  applyProjection,
  c2cExecutedEventSchema,
  ensureFeedbackState,
  repairForwardFeedbackControlEvents,
  feedbackBindingSchema,
  pairingIntentSchema,
  companionRecordSchema,
  companionRebindIntentSchema,
  companionRebindPredecessorSchema,
} from "../src/feedback/store.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";

describe("FINAL_RECEIPT_REQUIRED feedback", () => {
  let stateDir: string;
  let root: string;
  afterEach(() => {
    if (stateDir) cleanup(stateDir);
    if (root) cleanup(root);
  });

  it("projects a bounded alert once and never as C2C_EXECUTED", () => {
    stateDir = isolateStateDir();
    root = makeTmpDir("final-receipt-ws");
    const workspace = new Workspace(root);
    const draft = stageReceiptFinalization({
      workspaceId: workspace.id,
      workspaceRoot: root,
      threadId: "11111111-1111-4111-8111-111111111111",
      originTurnId: "22222222-2222-4222-8222-222222222222",
      resultTurnId: "33333333-3333-4333-8333-333333333333",
      commandId: "desktop_finalization_command",
      inputMaterial: "safe summary",
    }, { stateDir });
    writeReceiptFinalizationAlert(draft, "post_record_activity_unprovable", { stateDir });

    const first = reconcileFeedbackOutbox(workspace.id, stateDir);
    expect(first.projected).toBe(1);
    expect(first.state.events).toHaveLength(1);
    const event = first.state.events[0]!;
    expect(event.kind).toBe("FINAL_RECEIPT_REQUIRED");
    expect(event.taskId).toBe(`desktop_finalization_${draft.commandId}`);
    expect(event.changedFilesSummary).toEqual([]);
    expect(event.testsSummary).toBe("");
    expect(event.outputAvailable).toBe(false);
    const message = formatProductionFeedbackMessage({ ...event, attemptId: "44444444-4444-4444-8444-444444444444" });
    expect(message).toContain("STATE: FINAL_RECEIPT_REQUIRED");
    expect(message).toContain("post_record_activity_unprovable");
    expect(message).not.toContain("C2C_EXECUTED");

    const second = reconcileFeedbackOutbox(workspace.id, stateDir);
    expect(second.projected).toBe(0);
    expect(second.state.events).toHaveLength(1);
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("compatibility repair quarantines only alert-backed control events and preserves legacy state", () => {
    stateDir = isolateStateDir();
    root = makeTmpDir("final-receipt-repair");
    const workspace = new Workspace(root);
    ensureFeedbackState(workspace.id, 0, stateDir);
    const occurredAt = new Date().toISOString();
    const legacy = {
      version: 1 as const,
      eventId: "a".repeat(32),
      kind: "C2C_EXECUTED" as const,
      workspaceId: workspace.id,
      source: "desktop" as const,
      commandId: "legacy_command",
      taskId: "desktop_legacy_command",
      iteration: 1,
      result: "ok" as const,
      changedFilesSummary: [],
      testsSummary: "not run",
      outputAvailable: false,
      occurredAt,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      targetBindingId: null,
      targetEpoch: null,
      targetPrincipalFingerprint: null,
      status: "queued" as const,
    };
    applyProjection({ workspaceId: workspace.id, stateDir, nextCursor: 0, newEvents: [legacy] });
    const draft = stageReceiptFinalization({
      workspaceId: workspace.id,
      workspaceRoot: root,
      threadId: "11111111-1111-4111-8111-111111111111",
      originTurnId: "22222222-2222-4222-8222-222222222222",
      resultTurnId: "33333333-3333-4333-8333-333333333333",
      commandId: "repair_command",
      inputMaterial: "bounded",
    }, { stateDir });
    writeReceiptFinalizationAlert(draft, "identity_drift", { stateDir });
    reconcileFeedbackOutbox(workspace.id, stateDir);
    const before = JSON.parse(fs.readFileSync(path.join(stateDir, "feedback", `${workspace.id}.json`), "utf8")) as Record<string, unknown>;
    const repaired = repairForwardFeedbackControlEvents(workspace.id, stateDir);
    expect(repaired.removedEventIds).toHaveLength(1);
    expect(repaired.state.events.map(event => event.kind)).toEqual(["C2C_EXECUTED"]);
    expect(repaired.state.projectionCursor).toBe(before.projectionCursor);
    expect(repaired.state.binding).toEqual(before.binding ?? null);
    expect(repaired.state.companion).toEqual(before.companion ?? null);

    const oldStateSchema = z.object({
      version: z.literal(1),
      workspaceId: z.string(),
      projectionCursor: z.number().int().nonnegative(),
      binding: feedbackBindingSchema.nullable(),
      events: z.array(c2cExecutedEventSchema),
      pairingIntent: pairingIntentSchema.nullable(),
      companion: companionRecordSchema.nullable(),
      rebindIntent: companionRebindIntentSchema.nullable(),
      rebindPredecessor: companionRebindPredecessorSchema.nullable(),
    }).strict();
    expect(oldStateSchema.safeParse(repaired.state).success).toBe(true);
    expect(repaired.state.events.some(event => event.kind === "FINAL_RECEIPT_REQUIRED")).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "desktop-receipt-finalization", "alerts", `${workspace.id}-${draft.commandId}.json`))).toBe(true);
  });

  it("拒绝未支撑、篡改和重复控制事件，且不写回状态", () => {
    stateDir = isolateStateDir();
    root = makeTmpDir("final-receipt-repair-reject");
    const workspace = new Workspace(root);
    ensureFeedbackState(workspace.id, 0, stateDir);
    const occurredAt = new Date().toISOString();
    const control = {
      version: 1 as const,
      eventId: "b".repeat(32),
      kind: "FINAL_RECEIPT_REQUIRED" as const,
      workspaceId: workspace.id,
      source: "control" as const,
      commandId: "unbacked_command",
      taskId: "desktop_finalization_unbacked_command",
      iteration: 1 as const,
      result: "blocked" as const,
      changedFilesSummary: [] as string[],
      testsSummary: "" as const,
      outputAvailable: false as const,
      reason: "timeout" as const,
      occurredAt,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      targetBindingId: null,
      targetEpoch: null,
      targetPrincipalFingerprint: null,
      status: "queued" as const,
    };
    applyProjection({ workspaceId: workspace.id, stateDir, nextCursor: 0, newEvents: [control] });
    expect(() => repairForwardFeedbackControlEvents(workspace.id, stateDir)).toThrow(/durable alert/);
    const file = path.join(stateDir, "feedback", `${workspace.id}.json`);
    const unchanged = fs.readFileSync(file, "utf8");
    expect(unchanged).toContain("unbacked_command");
  });
});
