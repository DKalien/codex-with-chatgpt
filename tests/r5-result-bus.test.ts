import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { appendResult, createCommand, registerRoute, routingFile } from "../src/routing/store.js";
import { canonicalRoutingResultDigest } from "../src/routing/execution-result-digest.js";
import {
  enqueueResultOutboxEntry,
  listResultOutboxEntries,
  resultOutboxFile,
} from "../src/routing/result-outbox-store.js";
import {
  resultBusEntryId,
  resultBusEntrySchema,
  resultBusLifecycleSchema,
  resultBusStateSchema,
} from "../src/result-bus/schema.js";
import {
  ResultBusError,
  enqueueResultBusEntry,
  listResultBusEntries,
  readResultBus,
  resultBusFile,
} from "../src/result-bus/store.js";
import { projectAvailableResultBusCommands, reconcileWorkspaceResultBus } from "../src/result-bus/service.js";
import { cleanupJournalFile } from "../src/command-cleanup/fence.js";

const HEX64 = "c".repeat(64);
const PLANNER = "018c0000-0000-7000-8000-00000000c2d1";
const EXECUTOR = "01a00000-0000-7000-8000-0000000002d1";
const BINDING = "01a00000-0000-7000-8000-0000000002d2";

let stateDir: string;
let root: string;
let identity: { id: string; root: string };

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-result-bus-"));
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "c2c-result-bus-root-")));
  identity = { id: new Workspace(root).id, root };
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

function canonicalResult(commandId = "r5d1-command", iteration = 1) {
  const planner = registerRoute(identity, {
    role: "planner", platform: "chatgpt_web", conversationId: PLANNER, locator: {},
  }, stateDir);
  const executor = registerRoute(identity, {
    role: "executor", platform: "codex_desktop", conversationId: EXECUTOR,
    locator: { hostId: "local", executorProjectId: "r5d1" },
  }, stateDir);
  createCommand(identity, {
    commandId, plannerRouteId: planner.routeId, executorRouteId: executor.routeId,
    intent: "development_plan", payloadBytes: 1, payloadSha256: HEX64,
  }, stateDir);
  return appendResult(identity, {
    commandId, executorRouteId: executor.routeId, iteration, status: "ok",
    rawSummary: "R5d1 canonical result",
    machineEvidence: {
      version: 1, source: "codex_desktop_receipt", desktopReceiptSha256: HEX64,
      taskId: `desktop_${commandId}`, iteration, status: "ok", threadId: EXECUTOR,
      originTurnId: EXECUTOR, resultTurnId: EXECUTOR, bindingId: BINDING,
      changedFiles: ["src/result-bus"], testsSummary: "r5d1 passed",
    },
  }, stateDir);
}

describe("delivery-only available-command projection", () => {
  it("skips only unavailable command A; strict reconciliation still rejects it", () => {
    canonicalResult("a-locked");
    canonicalResult("b-available", 1);
    canonicalResult("b-available", 2);
    const file = `${cleanupJournalFile(identity.id, "a-locked", stateDir)}.lock`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
    expect(() => reconcileWorkspaceResultBus(identity, stateDir)).toThrow(/lock live\/unknown\/corrupt/);
    expect(readResultBus(identity, stateDir)).toBeNull();
    expect(projectAvailableResultBusCommands(identity, stateDir)).toEqual({ projected: 2, replayed: 0,
      skipped: [{ commandId: "a-locked", code: "COMMAND_CLEANUP_BUSY" }] });
    const bytes = fs.readFileSync(resultBusFile(identity.id, stateDir));
    expect(projectAvailableResultBusCommands(identity, stateDir)).toMatchObject({ projected: 0, replayed: 2 });
    expect(fs.readFileSync(resultBusFile(identity.id, stateDir))).toEqual(bytes);
    expect(fs.statSync(file).size).toBe(0);
  });

  it("corrupt cleanup journal is a hard failure, never a skipped command", () => {
    canonicalResult("a-corrupt-journal");
    canonicalResult("b-available");
    const file = cleanupJournalFile(identity.id, "a-corrupt-journal", stateDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}");
    expect(() => projectAvailableResultBusCommands(identity, stateDir)).toThrow(/journal 损坏/);
    expect(readResultBus(identity, stateDir)).toBeNull();
    expect(fs.readFileSync(file, "utf8")).toBe("{}");
  });

  it("valid cleanup journal skips only its command while another result projects", () => {
    canonicalResult("a-cleaning");
    canonicalResult("b-available");
    const file = cleanupJournalFile(identity.id, "a-cleaning", stateDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, workspaceId: identity.id, workspaceRoot: root,
      commandId: "a-cleaning", iteration: 1, cleanupId: EXECUTOR, mode: "manual_force", phase: "fenced",
      createdAt: new Date().toISOString(), artifacts: [] }));
    const bytes = fs.readFileSync(file);
    expect(projectAvailableResultBusCommands(identity, stateDir)).toEqual({ projected: 1, replayed: 0,
      skipped: [{ commandId: "a-cleaning", code: "COMMAND_CLEANUP_IN_PROGRESS" }] });
    expect(readResultBus(identity, stateDir)!.entries.map(e => e.commandId)).toEqual(["b-available"]);
    expect(fs.readFileSync(file)).toEqual(bytes);
  });

  it("corrupt routing and mismatched workspace fail closed instead of returning degraded success", () => {
    canonicalResult("available");
    expect(() => projectAvailableResultBusCommands({ ...identity, id: "0".repeat(12) }, stateDir)).toThrow();
    fs.writeFileSync(routingFile(identity.id, stateDir), "{}");
    expect(() => projectAvailableResultBusCommands(identity, stateDir)).toThrow(/Routing 状态损坏/);
    expect(readResultBus(identity, stateDir)).toBeNull();
  });
});

function frozenSendTarget() {
  return {
    version: 1 as const,
    bindingId: "binding-r5d1",
    pluginId: "chatgpt-web",
    surfaceId: "chatgpt-web",
    workspaceId: identity.id,
    canonicalUrl: "https://chatgpt.com/",
    epoch: 3,
    frozenAt: new Date().toISOString(),
  };
}

function reservation() {
  return {
    reservationId: "01a00000-0000-7000-8000-0000000003d1",
    reservedAt: new Date().toISOString(),
    bindingId: "binding-r5d1",
    epoch: 3,
    boundAt: new Date().toISOString(),
  };
}

function attempt() {
  return {
    attemptId: "01a00000-0000-7000-8000-0000000003d2",
    claimedAt: new Date().toISOString(),
  };
}

function writeBusState(entries: unknown[]): void {
  const file = resultBusFile(identity.id, stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1, workspaceId: identity.id, workspaceRoot: identity.root, revision: 1, entries,
  }));
}

function busErrorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ResultBusError);
    return (error as ResultBusError).code;
  }
  throw new Error("expected ResultBusError");
}

describe("R5d1 workspace Result Bus", () => {
  it("enqueues canonical result, exact replays, and preserves planner-independent entry", () => {
    const result = canonicalResult();
    const first = reconcileWorkspaceResultBus(identity, stateDir);
    expect(first).toEqual({ projected: 1, replayed: 0 });
    const replay = reconcileWorkspaceResultBus(identity, stateDir);
    expect(replay).toEqual({ projected: 0, replayed: 1 });
    const entries = listResultBusEntries(identity, stateDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ commandId: result.commandId, iteration: 1, resultId: result.resultId, deliveryStatus: "queued", sendTarget: null });
    expect(entries[0]).not.toHaveProperty("plannerRouteId");
    expect(entries[0]).not.toHaveProperty("plannerPrincipalFingerprint");
    expect(entries[0]!.resultSha256).toBe(canonicalRoutingResultDigest(result));
  });

  it("matches R4 outbox digest for the same canonical result (O)", () => {
    const result = canonicalResult("r5d1-parity");
    enqueueResultOutboxEntry(identity, { commandId: result.commandId, iteration: 1 }, stateDir);
    reconcileWorkspaceResultBus(identity, stateDir);
    const outboxEntry = listResultOutboxEntries(identity, stateDir).at(-1)!;
    const busEntry = listResultBusEntries(identity, stateDir).at(-1)!;
    expect(outboxEntry.commandId).toBe(busEntry.commandId);
    expect(outboxEntry.resultSha256).toBe(busEntry.resultSha256);
    expect(busEntry.resultSha256).toBe(canonicalRoutingResultDigest(result));
  });

  it("backfills a pre-R5d canonical result when the R4 outbox and bus are absent (M)", () => {
    canonicalResult("r5d1-crash-gap");
    expect(fs.existsSync(path.join(stateDir, "routing", `${identity.id}.result-outbox.json`))).toBe(false);
    expect(reconcileWorkspaceResultBus(identity, stateDir).projected).toBe(1);
    expect(listResultBusEntries(identity, stateDir)).toHaveLength(1);
  });

  it("keeps R4 outbox bytes unchanged and revision monotonic across writes and replays (J/N)", () => {
    const first = canonicalResult("r5d1-revision", 1);
    const second = canonicalResult("r5d1-revision", 2);
    enqueueResultOutboxEntry(identity, { commandId: first.commandId, iteration: 1 }, stateDir);
    const outbox = resultOutboxFile(identity.id, stateDir);
    const before = fs.readFileSync(outbox, "utf8");
    expect(reconcileWorkspaceResultBus(identity, stateDir)).toEqual({ projected: 2, replayed: 0 });
    expect(readResultBus(identity, stateDir)?.revision).toBe(1);
    expect(reconcileWorkspaceResultBus(identity, stateDir)).toEqual({ projected: 0, replayed: 2 });
    expect(readResultBus(identity, stateDir)?.revision).toBe(1);
    canonicalResult("r5d1-revision", 3);
    expect(reconcileWorkspaceResultBus(identity, stateDir)).toEqual({ projected: 1, replayed: 2 });
    expect(readResultBus(identity, stateDir)?.revision).toBe(2);
    expect(fs.readFileSync(outbox, "utf8")).toBe(before);
    expect(second.iteration).toBe(2);
  });

  it("skips legacy results and rejects identity/corrupt/symlink state (L/H)", () => {
    const result = canonicalResult("r5d1-corrupt");
    const routingFile = path.join(stateDir, "routing", `${identity.id}.json`);
    const routing = JSON.parse(fs.readFileSync(routingFile, "utf8"));
    delete routing.results[0].rawSummary;
    delete routing.results[0].machineEvidence;
    fs.writeFileSync(routingFile, JSON.stringify(routing));
    expect(reconcileWorkspaceResultBus(identity, stateDir)).toEqual({ projected: 0, replayed: 0 });
    routing.results[0] = result;
    fs.writeFileSync(routingFile, JSON.stringify(routing));
    const file = resultBusFile(identity.id, stateDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, workspaceId: identity.id, workspaceRoot: root, revision: 1, entries: [] }));
    expect(readResultBus(identity, stateDir)?.entries).toEqual([]);
    fs.writeFileSync(file, "{}\n");
    expect(() => readResultBus(identity, stateDir)).toThrowError(ResultBusError);
    fs.rmSync(file);
    fs.symlinkSync(path.join(stateDir, "missing-target"), file);
    expect(() => readResultBus(identity, stateDir)).toThrowError(ResultBusError);
    expect(result.resultId).toBeTruthy();
  });

  it("rejects wrong workspace identity/root and schema-level over-capacity state (G)", () => {
    const result = canonicalResult("r5d1-identity");
    expect(() => readResultBus({ id: "a".repeat(12), root: identity.root }, stateDir)).toThrow();
    const entry = {
      version: 1, busEntryId: resultBusEntryId(identity.id, result.commandId, 1), workspaceId: identity.id, commandId: result.commandId,
      iteration: 1, resultId: result.resultId, resultSha256: canonicalRoutingResultDigest(result), result,
      createdAt: new Date().toISOString(), deliveryStatus: "queued" as const, sendTarget: null,
    };
    expect(() => resultBusStateSchema.parse({ version: 1, workspaceId: identity.id, workspaceRoot: identity.root, revision: 1, entries: Array(10_001).fill(entry) })).toThrow();
  });

  it("fails closed when persisted workspaceRoot drifts (G)", () => {
    const result = canonicalResult("r5d1-root");
    reconcileWorkspaceResultBus(identity, stateDir);
    const file = resultBusFile(identity.id, stateDir);
    const state = JSON.parse(fs.readFileSync(file, "utf8")) as { workspaceRoot: string };
    state.workspaceRoot = path.join(os.tmpdir(), "c2c-not-this-root");
    fs.writeFileSync(file, JSON.stringify(state));
    expect(() => readResultBus(identity, stateDir)).toThrowError(ResultBusError);
    expect(result.resultId).toBeTruthy();
  });

  it("fails closed on tampered persisted busEntryId/resultSha256/result (E/F)", () => {
    canonicalResult("r5d1-tamper");
    reconcileWorkspaceResultBus(identity, stateDir);
    const file = resultBusFile(identity.id, stateDir);
    const state = JSON.parse(fs.readFileSync(file, "utf8")) as { entries: Array<Record<string, unknown>> };

    state.entries[0]!.busEntryId = "b".repeat(64);
    fs.writeFileSync(file, JSON.stringify(state));
    expect(busErrorCode(() => readResultBus(identity, stateDir))).toBe("RESULT_BUS_STATE_CORRUPT");

    state.entries[0]!.busEntryId = resultBusEntryId(identity.id, "r5d1-tamper", 1);
    state.entries[0]!.resultSha256 = "b".repeat(64);
    fs.writeFileSync(file, JSON.stringify(state));
    expect(busErrorCode(() => readResultBus(identity, stateDir))).toBe("RESULT_BUS_STATE_CORRUPT");

    state.entries[0]!.resultSha256 = canonicalRoutingResultDigest((state.entries[0]!.result as Record<string, unknown>) as never);
    (state.entries[0]!.result as Record<string, unknown>).rawSummary = "drifted summary";
    fs.writeFileSync(file, JSON.stringify(state));
    expect(busErrorCode(() => readResultBus(identity, stateDir))).toBe("RESULT_BUS_STATE_CORRUPT");
  });

  it("fails closed when the initialized marker exists without state (I)", () => {
    canonicalResult("r5d1-marker");
    reconcileWorkspaceResultBus(identity, stateDir);
    fs.rmSync(resultBusFile(identity.id, stateDir));
    expect(busErrorCode(() => readResultBus(identity, stateDir))).toBe("RESULT_BUS_STATE_CORRUPT");
    expect(() => reconcileWorkspaceResultBus(identity, stateDir)).toThrowError(ResultBusError);
  });

  it("rejects enqueue beyond 10000 persisted entries at the store level (K)", () => {
    const now = new Date().toISOString();
    const entries = Array.from({ length: 10_000 }, (_, i) => {
      const commandId = `cap-${String(i).padStart(5, "0")}`;
      const result = {
        commandId,
        executorRouteId: EXECUTOR,
        iteration: 1,
        status: "ok" as const,
        rawSummary: "capacity probe",
        machineEvidence: {
          version: 1 as const, source: "codex_desktop_receipt" as const, desktopReceiptSha256: HEX64,
          taskId: `desktop_${commandId}`, iteration: 1, status: "ok" as const, threadId: EXECUTOR,
          originTurnId: EXECUTOR, resultTurnId: EXECUTOR, bindingId: BINDING,
          changedFiles: [], testsSummary: "capacity",
        },
        resultId: `01a00000-0000-7000-8000-${String(i).padStart(12, "0")}`,
        createdAt: now,
        updatedAt: now,
      };
      return {
        version: 1,
        busEntryId: resultBusEntryId(identity.id, commandId, 1),
        workspaceId: identity.id,
        commandId,
        iteration: 1,
        resultId: result.resultId,
        resultSha256: canonicalRoutingResultDigest(result),
        result,
        createdAt: now,
        deliveryStatus: "queued" as const,
        sendTarget: null,
      };
    });
    writeBusState(entries);
    const extra = canonicalResult("cap-extra");
    expect(busErrorCode(() => enqueueResultBusEntry(identity, extra, stateDir))).toBe("RESULT_BUS_FULL");
  });

  it("freezes the single send-target lifecycle contract (P/Q)", () => {
    const result = canonicalResult("r5d1-lifecycle");
    const now = new Date().toISOString();
    const base = {
      version: 1,
      busEntryId: resultBusEntryId(identity.id, result.commandId, 1),
      workspaceId: identity.id,
      commandId: result.commandId,
      iteration: 1,
      resultId: result.resultId,
      resultSha256: canonicalRoutingResultDigest(result),
      result,
      createdAt: now,
      observedAt: null,
      outcomeUnknownAt: null,
      retiredAt: null,
      outcomeReasonCode: null,
    };
    const target = frozenSendTarget();
    const reserve = reservation();
    const claim = attempt();
    expect(resultBusLifecycleSchema.options).toEqual(["queued", "reserved", "claimed", "observed", "outcome_unknown", "retired_unknown", "cancelled"]);
    const cancelled = { ...base, deliveryStatus: "cancelled", sendTarget: null, reservation: null, attempt: null, cancelledAt: now };
    expect(resultBusEntrySchema.parse(cancelled)).toBeTruthy();
    expect(() => resultBusEntrySchema.parse({ ...cancelled, cancelledAt: null })).toThrow();
    expect(() => resultBusEntrySchema.parse({ ...cancelled, reservation: reserve })).toThrow();
    expect(() => resultBusEntrySchema.parse({ ...cancelled, attempt: claim, sendTarget: target })).toThrow();
    expect(() => resultBusEntrySchema.parse({ ...cancelled, deliveryStatus: "queued" })).toThrow();
    expect(resultBusEntrySchema.parse({ ...base, deliveryStatus: "queued", sendTarget: null, reservation: null, attempt: null })).toBeTruthy();
    expect(() => resultBusEntrySchema.parse({ ...base, deliveryStatus: "queued", sendTarget: target, reservation: null, attempt: null })).toThrow();
    expect(() => resultBusEntrySchema.parse({ ...base, deliveryStatus: "queued", sendTarget: null, reservation: reserve, attempt: null })).toThrow();
    expect(resultBusEntrySchema.parse({ ...base, deliveryStatus: "reserved", sendTarget: null, reservation: reserve, attempt: null })).toBeTruthy();
    expect(() => resultBusEntrySchema.parse({ ...base, deliveryStatus: "reserved", sendTarget: target, reservation: reserve, attempt: null })).toThrow();
    expect(() => resultBusEntrySchema.parse({ ...base, deliveryStatus: "reserved", sendTarget: null, reservation: null, attempt: null })).toThrow();
    expect(resultBusEntrySchema.parse({ ...base, deliveryStatus: "claimed", sendTarget: target, reservation: reserve, attempt: claim })).toBeTruthy();
    expect(() => resultBusEntrySchema.parse({ ...base, deliveryStatus: "claimed", sendTarget: null, reservation: reserve, attempt: claim })).toThrow();
    expect(() => resultBusEntrySchema.parse({ ...base, deliveryStatus: "claimed", sendTarget: target, reservation: null, attempt: claim })).toThrow();
    expect(() => resultBusEntrySchema.parse({ ...base, deliveryStatus: "claimed", sendTarget: target, reservation: reserve, attempt: null })).toThrow();
    expect(resultBusEntrySchema.parse({
      ...base, deliveryStatus: "observed", sendTarget: target, reservation: reserve, attempt: claim, observedAt: now,
    })).toBeTruthy();
    expect(() => resultBusEntrySchema.parse({ ...base, deliveryStatus: "observed", sendTarget: target, reservation: reserve, attempt: claim })).toThrow();
    expect(resultBusEntrySchema.parse({
      ...base, deliveryStatus: "outcome_unknown", sendTarget: target, reservation: reserve, attempt: claim, outcomeUnknownAt: now,
    })).toBeTruthy();
    expect(() => resultBusEntrySchema.parse({ ...base, deliveryStatus: "outcome_unknown", sendTarget: target, reservation: reserve, attempt: claim })).toThrow();
    expect(resultBusEntrySchema.parse({
      ...base, deliveryStatus: "retired_unknown", sendTarget: target, reservation: reserve, attempt: claim, outcomeUnknownAt: now, retiredAt: now,
    })).toBeTruthy();
    expect(() => resultBusEntrySchema.parse({
      ...base, deliveryStatus: "retired_unknown", sendTarget: target, reservation: reserve, attempt: claim, retiredAt: now,
    })).toThrow();
  });

  it("exact canonical replay preserves a frozen post-send lifecycle and snapshot (R)", () => {
    const result = canonicalResult("r5d1-frozen");
    const target = frozenSendTarget();
    const entry = {
      version: 1,
      busEntryId: resultBusEntryId(identity.id, result.commandId, 1),
      workspaceId: identity.id,
      commandId: result.commandId,
      iteration: 1,
      resultId: result.resultId,
      resultSha256: canonicalRoutingResultDigest(result),
      result,
      createdAt: new Date().toISOString(),
      deliveryStatus: "claimed" as const,
      sendTarget: target,
      reservation: reservation(),
      attempt: attempt(),
      observedAt: null,
      outcomeUnknownAt: null,
      retiredAt: null,
      outcomeReasonCode: null,
    };
    writeBusState([entry]);
    const file = resultBusFile(identity.id, stateDir);
    const before = fs.readFileSync(file, "utf8");
    expect(reconcileWorkspaceResultBus(identity, stateDir)).toEqual({ projected: 0, replayed: 1 });
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    const state = readResultBus(identity, stateDir)!;
    expect(state.revision).toBe(1);
    expect(state.entries[0]).toMatchObject({ deliveryStatus: "claimed", sendTarget: target, attempt: entry.attempt, reservation: entry.reservation });
  });

  it("rejects conflicting same command+iteration result identity (D)", () => {
    const first = canonicalResult("r5d1-conflict");
    expect(reconcileWorkspaceResultBus(identity, stateDir).projected).toBe(1);
    const file = path.join(stateDir, "routing", `${identity.id}.json`);
    const routing = JSON.parse(fs.readFileSync(file, "utf8"));
    routing.results[0].rawSummary = "drift";
    fs.writeFileSync(file, JSON.stringify(routing));
    expect(() => reconcileWorkspaceResultBus(identity, stateDir)).toThrow();
    expect(first.resultId).toBeTruthy();
  });
});
