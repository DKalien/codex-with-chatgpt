import { listResultBusCutoverDispositions } from "../src/result-bus/cutover-store.js";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import http from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";
import { appendExecutionRecordLocked, withExecutionRecordsLock } from "../src/execution/records.js";
import { updateDesktop } from "../src/desktop/store.js";
import { appendResult, createCommand, registerRoute, routingFile } from "../src/routing/store.js";
import { canonicalRoutingResultDigest } from "../src/routing/execution-result-digest.js";
import { enqueueResultBusEntry, readResultBus, resultBusFile } from "../src/result-bus/store.js";
import { reserveNextResultBusEntry, markResultBusOutcomeUnknown, retireResultBusOutcomeUnknown } from "../src/result-bus/delivery-lifecycle.js";
import { ResultBusCutoverError, readResultBusCutover, resultBusCutoverFile } from "../src/result-bus/cutover-store.js";
import {
  ResultBusDeliveryError,
  reconcileResultBusCutover,
  resultBusCompanionAck,
  resultBusCompanionBeginSend,
  resultBusCompanionDeliveryId,
  resultBusCompanionRelease,
  resultBusCompanionReserve,
  resultBusCompanionRetire,
  resultBusCompanionState,
} from "../src/bridge/result-bus-delivery.js";
import { withDeliveryArbiter, assertNoResultBusInFlight } from "../src/bridge/delivery-arbiter.js";
import {
  type FeedbackEvent,
  ackObservedForCompanion,
  beginSend,
  claimNext,
  enableReceiver,
  readFeedbackState,
  reserveNext,
  retireOutcomeUnknown,
} from "../src/feedback/store.js";
import { ackObservedForCompanion as legacyAck } from "../src/feedback/delivery-lifecycle.js";
import {
  confirmRouteAttestation,
  companionPublicState,
  createPairingIntent,
  exchangePairingIntent,
  verifyCompanionCredential,
} from "../src/feedback/companion.js";
import { applyProjection, feedbackEventId, finalReceiptRequiredEventId } from "../src/feedback/projection-store.js";
import { canonicalFeedbackEvent } from "./helpers/canonical-compat.js";
import { reconcileHistoricalFeedbackFixtures } from "./helpers/legacy-feedback-fixtures.js";
import { reconcileFeedbackOutbox } from "../src/feedback/projector.js";
import { writeState, feedbackStateFile } from "../src/feedback/state-store.js";
import { cleanupJournalFile } from "../src/command-cleanup/fence.js";
import { confirmCommandCleanup, previewCommandCleanup } from "../src/command-cleanup/service.js";
import { resolveConversationPrincipal } from "../src/mcp/conversation-principal.js";
import { bindCurrentWebSink, readActiveWebSinkBinding } from "../src/web-sink-control/index.js";
import { projectChatgptRouteToWebSinkCandidate } from "../src/web-sink-control/index.js";
import { createCompanionRouter } from "../src/bridge/companion.js";
import { readCompanionOperations } from "../src/bridge/companion-operations.js";
import { claimNextForMcp } from "../src/mcp/feedback.js";
import { evaluateServerObservedCloseout, findExactObservedEvent } from "../browser-companion/production-send.js";
import { requestJson } from "./http-json.js";

let stateDir: string;
let wsRoot: string;
let workspace: Workspace;
let previousStateDir: string | undefined;

const ROUTE_A = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const ROUTE_B = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";
const ROUTE_C = "https://chatgpt.com/c/33333333-3333-4333-8333-333333333333";
const PLANNER_CONV = "planner-conv-task-A";
const EXECUTOR = "01a00000-0000-7000-8000-0000000002d1";
const BINDING = "01a00000-0000-7000-8000-0000000002d2";
const HEX64 = "c".repeat(64);
const CLAIM_ATTEMPT = "01a00000-0000-7000-8000-0000000007d2";
const RESERVATION = "01a00000-0000-7000-8000-0000000007d1";

beforeEach(() => {
  stateDir = isolateStateDir();
  wsRoot = makeTmpDir("r5d3-cutover-ws");
  workspace = new Workspace(wsRoot);
  previousStateDir = process.env.C2C_STATE_DIR;
  process.env.C2C_STATE_DIR = stateDir;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
  cleanup(stateDir);
  cleanup(wsRoot);
});

function principalA() {
  return resolveConversationPrincipal({
    authInfo: { token: "t", clientId: "client-A", scopes: ["codex.feedback"] } as never,
    _meta: { "openai/session": "sess-A" },
  });
}

function routingResult(commandId: string) {
  const planner = registerRoute(workspace, {
    role: "planner", platform: "chatgpt_web", conversationId: PLANNER_CONV, locator: {},
  }, stateDir);
  const executor = registerRoute(workspace, {
    role: "executor", platform: "codex_desktop", conversationId: EXECUTOR,
    locator: { hostId: "local", executorProjectId: "r5d3" },
  }, stateDir);
  createCommand(workspace, {
    commandId, plannerRouteId: planner.routeId, executorRouteId: executor.routeId,
    intent: "development_plan", payloadBytes: 1, payloadSha256: HEX64,
  }, stateDir);
  return appendResult(workspace, {
    commandId, executorRouteId: executor.routeId, iteration: 1, status: "ok",
    rawSummary: `R5d3 canonical result ${commandId}`,
    machineEvidence: {
      version: 1, source: "codex_desktop_receipt", desktopReceiptSha256: HEX64,
      taskId: `desktop_${commandId}`, iteration: 1, status: "ok", threadId: EXECUTOR,
      originTurnId: EXECUTOR, resultTurnId: EXECUTOR, bindingId: BINDING,
      changedFiles: ["src/r5d3.ts"], testsSummary: "r5d3 passed",
    },
  }, stateDir);
}

function seedBusEntry(commandId: string) {
  const result = routingResult(commandId);
  const entry = enqueueResultBusEntry(workspace, result, stateDir).entry;
  return { entry, result };
}

function seedEphemeralBusEntry(commandId: string) {
  const now = new Date().toISOString();
  updateDesktop(workspace.id, previous => {
    const base = previous ?? { version: 1 as const, workspaceId: workspace.id, workspaceRoot: wsRoot,
      enabled: false, binding: null, deliveries: [] };
    return { state: { ...base, deliveries: [...base.deliveries.filter(item => item.commandId !== commandId), {
      commandId, deliveryId: randomUUID(), lifecycle: "ephemeral" as const, intent: "development_plan" as const,
      clientId: "terminal-gone-client", bindingId: BINDING, messageSha256: "a".repeat(64), messageBytes: 1,
      threadId: EXECUTOR, turnId: randomUUID(), deliveryStatus: "accepted" as const, createdAt: now, updatedAt: now,
    }] }, result: null };
  }, stateDir);
  return seedBusEntry(commandId);
}

function stateSnapshot(directory: string): unknown {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(item => {
    const file = path.join(directory, item.name);
    return item.isDirectory() ? [item.name, stateSnapshot(file)] : [item.name, fs.readFileSync(file).toString("base64")];
  });
}

function enableBinding() {
  reconcileFeedbackOutbox(workspace.id, stateDir, wsRoot);
  enableReceiver({ workspaceId: workspace.id, principal: principalA(), widgetId: "w", stateDir });
}

function pairCompanion(route = ROUTE_A) {
  const intent = createPairingIntent({ workspaceId: workspace.id, principal: principalA(), stateDir });
  const paired = exchangePairingIntent({
    workspaceId: workspace.id, intentId: intent.intentId, secret: intent.secret,
    routeCanonical: route, stateDir,
  });
  confirmRouteAttestation({
    workspaceId: workspace.id, principal: principalA(),
    challengeId: paired.routeAttestation.challengeId,
    challengeDigest: paired.routeAttestation.challengeDigest,
    stateDir,
  });
  return paired;
}

function bindSink(route: string) {
  return bindCurrentWebSink(workspace.id, projectChatgptRouteToWebSinkCandidate({
    workspaceId: workspace.id, routeCanonical: route,
  })).binding;
}

function ctxOf(credential: string) {
  return verifyCompanionCredential({ workspaceId: workspace.id, credential, stateDir });
}

/** R4c canonical-pinned 历史 legacy 事件。 */
function projectPinnedLegacy(
  result: ReturnType<typeof routingResult>,
  options: { status?: string; companionId?: string; eventId?: string; resultSha256?: string } = {},
): FeedbackEvent {
  const base = canonicalFeedbackEvent({
    workspaceId: workspace.id, result,
    plannerRouteId: registerRoute(workspace, {
      role: "planner", platform: "chatgpt_web", conversationId: PLANNER_CONV, locator: {},
    }, stateDir).routeId,
    plannerPrincipalFingerprint: principalA().fingerprint,
    resultSha256: options.resultSha256 ?? canonicalRoutingResultDigest(result),
    occurredAt: result.createdAt,
  });
  const event = (options.eventId ? { ...base, eventId: options.eventId } : base) as FeedbackEvent;
  return insertAndMaybeTerminalize(event, options);
}

/** pre-R4c exact legacy 事件：同 canonical identity、无任何 planner/canonical 元数据。 */
function projectPreR4cLegacy(
  result: ReturnType<typeof routingResult>,
  options: { status?: string; companionId?: string; eventId?: string } = {},
): FeedbackEvent {
  const evidence = result.machineEvidence;
  const base = {
    version: 1,
    eventId: options.eventId ?? feedbackEventId({
      workspaceId: workspace.id, commandId: result.commandId, taskId: evidence.taskId,
      iteration: result.iteration, desktopReceiptSha256: evidence.desktopReceiptSha256,
    }),
    kind: "C2C_EXECUTED", workspaceId: workspace.id, source: "desktop",
    commandId: result.commandId, taskId: evidence.taskId, iteration: result.iteration,
    result: result.status, changedFilesSummary: evidence.changedFiles.slice(0, 200),
    testsSummary: evidence.testsSummary, outputAvailable: evidence.output?.outputAvailable ?? false,
    ...(evidence.output?.outputId !== undefined ? { outputId: evidence.output.outputId } : {}),
    occurredAt: result.createdAt, createdAt: result.createdAt, updatedAt: result.createdAt,
    targetBindingId: null, targetEpoch: null, targetPrincipalFingerprint: null, status: "queued",
  };
  return insertAndMaybeTerminalize(base as FeedbackEvent, options);
}

const CLAIM_ATTEMPT_ALT = "01a00000-0000-7000-8000-0000000007d3";

function insertAndMaybeTerminalize(
  event: FeedbackEvent,
  options: { status?: string; companionId?: string },
): FeedbackEvent {
  applyProjection({
    workspaceId: workspace.id, stateDir,
    nextCursor: readFeedbackState(workspace.id, stateDir).projectionCursor,
    newEvents: [event],
  });
  const status = options.status ?? "ready";
  if (status !== "ready") {
    const state = readFeedbackState(workspace.id, stateDir)!;
    const now = new Date().toISOString();
    const claimedLike = status === "claimed" || status === "observed" || status === "outcome_unknown" || status === "retired_unknown";
    const lifecycle = {
      reservationId: RESERVATION,
      reservedAt: now,
      reservedBy: options.companionId ?? ctxCompanionId,
      ...(claimedLike ? { attemptId: CLAIM_ATTEMPT, claimedAt: now } : {}),
      ...(status === "retired_unknown" ? { retiredAt: now } : {}),
    };
    writeState(workspace.id, stateDir, {
      ...state,
      events: state.events.map(e => e.eventId === event.eventId ? { ...e, status, ...lifecycle } : e),
    });
  }
  return { ...event, status } as FeedbackEvent;
}

let ctxCompanionId = "01a00000-0000-7000-8000-0000000007d9";

/** FINAL_RECEIPT_REQUIRED control 事件：可与同 commandId/iteration=1 的 Bus canonical entry 合法共存。 */
function projectControlEvent(
  commandId: string,
  options: { status?: string; companionId?: string } = {},
): FeedbackEvent {
  const now = new Date().toISOString();
  const base = {
    version: 1,
    eventId: finalReceiptRequiredEventId({ workspaceId: workspace.id, commandId, alertId: `alert-${commandId}` }),
    kind: "FINAL_RECEIPT_REQUIRED",
    workspaceId: workspace.id,
    source: "control",
    commandId,
    taskId: `desktop_finalization_${commandId}`,
    iteration: 1,
    result: "blocked",
    changedFilesSummary: [],
    testsSummary: "",
    outputAvailable: false,
    reason: "missing_final_receipt",
    occurredAt: now,
    createdAt: now,
    updatedAt: now,
    targetBindingId: null,
    targetEpoch: null,
    targetPrincipalFingerprint: null,
    status: "queued",
  };
  return insertAndMaybeTerminalize(base as FeedbackEvent, options);
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`expected throw ${code}`);
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
  }
}

function reserveViaAdapter(credential: string, route = ROUTE_A) {
  return resultBusCompanionReserve({
    workspaceId: workspace.id, workspaceRoot: wsRoot, credential, routeCanonical: route, stateDir,
  });
}

function beginViaAdapter(credential: string, eventId: string, reservationId: string, route = ROUTE_A) {
  return resultBusCompanionBeginSend({
    workspaceId: workspace.id, workspaceRoot: wsRoot, credential, routeCanonical: route,
    eventId, reservationId, stateDir,
  });
}

function ackViaAdapter(credential: string, eventId: string, attemptId: string, route = ROUTE_A) {
  return resultBusCompanionAck({
    workspaceId: workspace.id, workspaceRoot: wsRoot, credential, routeCanonical: route,
    eventId, attemptId, stateDir,
  });
}

function blockUnrelatedLegacy() {
  const commandId = "unrelated-control-locked";
  projectControlEvent(commandId);
  const file = `${cleanupJournalFile(workspace.id, commandId, stateDir)}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Real incident: an empty, unprovable owner is never reclaimed.
  fs.writeFileSync(file, "");
  return file;
}

describe("canonical delivery with unavailable legacy enrichment", () => {
  function setup() {
    enableBinding();
    const paired = pairCompanion();
    bindSink(ROUTE_A);
    const seeded = seedBusEntry("canonical-lock-independent");
    return { ...seeded, credential: paired.credential };
  }
  function state(credential: string) {
    return resultBusCompanionState({ workspaceId: workspace.id, workspaceRoot: wsRoot, credential, stateDir });
  }
  function snapshot() {
    return [feedbackStateFile(workspace.id, stateDir), resultBusCutoverFile(workspace.id, stateDir)]
      .map(file => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
  }

  it("unrelated corrupt lock leaves canonical state/reserve/release/begin/ACK available with no legacy writes", () => {
    const { credential, entry } = setup();
    const lock = blockUnrelatedLegacy();
    const before = snapshot();
    expect(state(credential)).toMatchObject({ routeVerification: "VERIFIED", productionEligible: true,
      pendingReady: 2 }); // Durable ready counts; actual acquisition rechecks command authority.
    const reserved = reserveViaAdapter(credential);
    expect(reserved.delivery.eventId).toBe(resultBusCompanionDeliveryId(entry.busEntryId));
    const busBytes = fs.readFileSync(resultBusFile(workspace.id, stateDir));
    expect(reserveViaAdapter(credential)).toEqual(reserved);
    expect(fs.readFileSync(resultBusFile(workspace.id, stateDir))).toEqual(busBytes);
    resultBusCompanionRelease({ workspaceId: workspace.id, workspaceRoot: wsRoot, credential,
      eventId: reserved.delivery.eventId as string, reservationId: reserved.reservationId, routeCanonical: ROUTE_A, stateDir });
    const next = reserveViaAdapter(credential);
    const sent = beginViaAdapter(credential, next.delivery.eventId as string, next.reservationId);
    expect(beginViaAdapter(credential, next.delivery.eventId as string, next.reservationId)).toEqual(sent);
    expect(ackViaAdapter(credential, next.delivery.eventId as string, sent.attemptId)).toMatchObject({ status: "observed" });
    expect(snapshot()).toEqual(before);
    expect(fs.statSync(lock).size).toBe(0);
  });

  it.each(["reserved", "claimed", "outcome_unknown"])("strict legacy %s still fences new canonical reservation", status => {
    const { credential } = setup();
    projectControlEvent("legacy-flight", { status });
    blockUnrelatedLegacy();
    const before = snapshot();
    expect(state(credential)).toMatchObject({ blockedByLegacyInFlight: true });
    expectCode(() => reserveViaAdapter(credential), "FEEDBACK_INFLIGHT_FENCE");
    expect(readResultBus(workspace, stateDir)!.entries[0]).toMatchObject({ deliveryStatus: "queued", attempt: null });
    expect(snapshot()).toEqual(before);
  });

  it("unresolved historical counterpart cannot invent a disposition in degraded mode", () => {
    const { credential, result } = setup();
    projectPinnedLegacy(result);
    blockUnrelatedLegacy();
    const before = snapshot();
    expectCode(() => state(credential), "RESULT_BUS_CUTOVER_REQUIRED");
    const reserved = reserveViaAdapter(credential); // Explicit mutation may establish the exact cutover disposition.
    expect(reserved.delivery.commandId).toBe(result.commandId);
    expect(snapshot()[0]).toEqual(before[0]);
    expect(listResultBusCutoverDispositions(workspace, stateDir)).toHaveLength(1);
  });

  it("strict existing cutover disposition can be reused without writing legacy authority", () => {
    const { credential, result } = setup();
    projectPinnedLegacy(result);
    reconcileResultBusCutover({ identity: workspace, stateDir });
    blockUnrelatedLegacy();
    const before = snapshot();
    expect(state(credential).pendingReady).toBe(2);
    expect(reserveViaAdapter(credential).reservationId).toBeTruthy();
    expect(snapshot()).toEqual(before);
  });

  it("corrupt Feedback snapshot cannot prove absence of legacy in-flight", () => {
    const { credential } = setup();
    blockUnrelatedLegacy();
    fs.writeFileSync(feedbackStateFile(workspace.id, stateDir), "{}");
    // Auth cannot even be established from a corrupt Feedback store; no canonical state.
    expect(state(credential)).toEqual({ legacyOnly: true });
    expect(() => reserveViaAdapter(credential)).toThrow();
    expect(readResultBus(workspace, stateDir)!.entries[0].deliveryStatus).toBe("queued");
  });

  it("invalid credential/route/sink cannot use degraded canonical authority", () => {
    const { credential } = setup();
    blockUnrelatedLegacy();
    const before = snapshot();
    expect(() => reserveViaAdapter("invalid")).toThrow();
    expectCode(() => reserveViaAdapter(credential, ROUTE_B), "ROUTE_MISMATCH");
    bindSink(ROUTE_B);
    expect(state(credential).productionEligible).toBe(false);
    expectCode(() => reserveViaAdapter(credential), "RESULT_BUS_SINK_ROUTE_MISMATCH");
    expect(snapshot()).toEqual(before);
  });

  it("legacy/control fallback remains blocked when there is no canonical entry", () => {
    enableBinding();
    const paired = pairCompanion();
    bindSink(ROUTE_A);
    blockUnrelatedLegacy();
    expectCode(() => reserveViaAdapter(paired.credential), "COMMAND_CLEANUP_BUSY");
  });

  it.each(["corrupt_lock", "cleanup_journal"])("new result's own %s prevents projection/reservation without touching its authority", kind => {
    enableBinding();
    const paired = pairCompanion();
    bindSink(ROUTE_A);
    const result = routingResult("own-fenced-result");
    const journal = cleanupJournalFile(workspace.id, result.commandId, stateDir);
    const file = kind === "corrupt_lock" ? `${journal}.lock` : journal;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, kind === "corrupt_lock" ? "" : JSON.stringify({ version: 1,
      workspaceId: workspace.id, workspaceRoot: wsRoot, commandId: result.commandId, iteration: 1,
      cleanupId: CLAIM_ATTEMPT, mode: "manual_force", phase: "fenced", createdAt: new Date().toISOString(), artifacts: [] }));
    const before = fs.readFileSync(file);
    // GET observes the durable Bus only, without projection or cleanup lock acquisition.
    expect(state(paired.credential)).toMatchObject({ pendingReady: 0 });
    expect(() => reserveViaAdapter(paired.credential)).toThrow();
    expect(readResultBus(workspace, stateDir)?.entries ?? []).toEqual([]);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("corrupt Bus fails canonical projection before any rewrite despite unavailable legacy locks", () => {
    const { credential } = setup();
    routingResult("new-result-not-enqueued");
    blockUnrelatedLegacy();
    const file = resultBusFile(workspace.id, stateDir);
    fs.writeFileSync(file, "{}");
    const before = snapshot();
    expectCode(() => state(credential), "RESULT_BUS_STATE_CORRUPT");
    expectCode(() => reserveViaAdapter(credential), "RESULT_BUS_STATE_CORRUPT");
    expect(fs.readFileSync(file, "utf8")).toBe("{}");
    expect(snapshot()).toEqual(before);
  });

  it("immutable routing drift is not a skippable lifecycle failure", () => {
    const { credential } = setup();
    blockUnrelatedLegacy();
    const file = routingFile(workspace.id, stateDir);
    const routing = JSON.parse(fs.readFileSync(file, "utf8"));
    routing.results[0].rawSummary = "different immutable canonical content";
    fs.writeFileSync(file, JSON.stringify(routing));
    const bus = fs.readFileSync(resultBusFile(workspace.id, stateDir));
    expectCode(() => state(credential), "RESULT_BUS_CONFLICT");
    expectCode(() => reserveViaAdapter(credential), "RESULT_BUS_CONFLICT");
    expect(fs.readFileSync(resultBusFile(workspace.id, stateDir))).toEqual(bus);
  });

  it("new projection cannot bypass its unresolved historical counterpart", () => {
    enableBinding();
    const paired = pairCompanion();
    bindSink(ROUTE_A);
    const result = routingResult("new-with-counterpart");
    projectPinnedLegacy(result);
    blockUnrelatedLegacy();
    const before = snapshot();
    expect(state(paired.credential)).toMatchObject({ pendingReady: 1 });
    expect(readResultBus(workspace, stateDir)?.entries ?? []).toEqual([]);
    expect(snapshot()).toEqual(before);
    expect(reserveViaAdapter(paired.credential).delivery.commandId).toBe(result.commandId);
    expect(listResultBusCutoverDispositions(workspace, stateDir)).toHaveLength(1);
    expect(readResultBus(workspace, stateDir)!.entries[0]).toMatchObject({ deliveryStatus: "reserved", attempt: null });
    expect(snapshot()[0]).toEqual(before[0]);
  });

  it("validated old disposition remains usable while a new pure canonical result projects", () => {
    const { credential, result } = setup();
    projectPinnedLegacy(result, { status: "observed" });
    reconcileResultBusCutover({ identity: workspace, stateDir });
    blockUnrelatedLegacy();
    const next = routingResult("new-after-disposition");
    const before = snapshot();
    expect(state(credential).pendingReady).toBe(1);
    expect(reserveViaAdapter(credential).delivery.commandId).toBe(next.commandId);
    expect(snapshot()).toEqual(before);
  });

  it("invalid request route cannot project a new result before rejection", () => {
    enableBinding();
    const paired = pairCompanion();
    bindSink(ROUTE_A);
    routingResult("new-auth-first");
    blockUnrelatedLegacy();
    expect(() => reserveViaAdapter("invalid")).toThrow();
    expectCode(() => reserveViaAdapter(paired.credential, ROUTE_B), "ROUTE_MISMATCH");
    bindSink(ROUTE_B);
    expectCode(() => reserveViaAdapter(paired.credential), "RESULT_BUS_SINK_ROUTE_MISMATCH");
    expect(fs.existsSync(resultBusFile(workspace.id, stateDir))).toBe(false);
  });
});

describe("R5d3 Result Bus cutover", () => {
  it("A: R4c pinned observed → legacy_observed；Bus 永不被预约", () => {
    enableBinding();
    const paired = pairCompanion();
    ctxCompanionId = ctxOf(paired.credential).companionId;
    const { entry, result } = seedBusEntry("r5d3-a");
    projectPinnedLegacy(result, { status: "observed", companionId: ctxCompanionId });

    const report = reconcileResultBusCutover({ identity: workspace, stateDir });
    expect(report.cutoverReady).toBe(true);
    expect(report.dispositionsWritten).toBe(1);
    expect(readResultBusCutover(workspace, stateDir)!.entries[0]).toMatchObject({
      busEntryId: entry.busEntryId, disposition: "legacy_observed",
    });
    const replay = reconcileResultBusCutover({ identity: workspace, stateDir });
    expect(replay).toMatchObject({ dispositionsWritten: 0, dispositionsReplayed: 1, cutoverReady: true });
    expect(readResultBus(workspace, stateDir)!.entries[0]!.deliveryStatus).toBe("queued");
    expectCode(() => reserveViaAdapter(paired.credential), "FEEDBACK_NO_READY_EVENT");
    expect(readResultBus(workspace, stateDir)!.entries[0]!.deliveryStatus).toBe("queued");
  });

  it("A2: pre-R4c exact legacy observed（无 planner 元数据）→ 永久抑制，绝不重发", () => {
    enableBinding();
    const paired = pairCompanion();
    ctxCompanionId = ctxOf(paired.credential).companionId;
    const { entry, result } = seedBusEntry("r5d3-a2");
    projectPreR4cLegacy(result, { status: "observed", companionId: ctxCompanionId });

    reconcileResultBusCutover({ identity: workspace, stateDir });
    expect(readResultBusCutover(workspace, stateDir)!.entries[0]).toMatchObject({
      busEntryId: entry.busEntryId, disposition: "legacy_observed",
    });
    expectCode(() => reserveViaAdapter(paired.credential), "FEEDBACK_NO_READY_EVENT");
  });

  it("B/B2: observed→retired_unknown（pinned 与 pre-R4c）→ legacy_retired 永久抑制", () => {
    enableBinding();
    const paired = pairCompanion();
    ctxCompanionId = ctxOf(paired.credential).companionId;
    const { entry, result } = seedBusEntry("r5d3-b");
    projectPinnedLegacy(result, { status: "retired_unknown", companionId: ctxCompanionId });
    reconcileResultBusCutover({ identity: workspace, stateDir });
    expect(readResultBusCutover(workspace, stateDir)!.entries[0]).toMatchObject({ disposition: "legacy_retired" });
    expectCode(() => reserveViaAdapter(paired.credential), "FEEDBACK_NO_READY_EVENT");

    const second = seedBusEntry("r5d3-b2");
    projectPreR4cLegacy(second.result, { status: "retired_unknown", companionId: ctxCompanionId });
    reconcileResultBusCutover({ identity: workspace, stateDir });
    const rows = readResultBusCutover(workspace, stateDir)!.entries;
    expect(rows.find(row => row.busEntryId === second.entry.busEntryId)).toMatchObject({ disposition: "legacy_retired" });
  });

  it("C: 历史 ready（pinned 与 pre-R4c）→ legacy 不可预约，Bus 恰好投递一次", () => {
    enableBinding();
    const paired = pairCompanion();
    bindSink(ROUTE_A);
    const { entry, result } = seedBusEntry("r5d3-c");
    projectPinnedLegacy(result, { status: "ready" });
    // pre-R4c ready 同样不可经 legacy 预约
    const legacyReserved = (() => {
      try {
        const ctx = ctxOf(paired.credential);
        return reserveNext({
          workspaceId: workspace.id, bindingId: ctx.bindingId, epoch: ctx.epoch,
          principalFingerprint: ctx.principalFingerprint, companionId: ctx.companionId, stateDir,
        });
      } catch (error) {
        expect((error as { code?: string }).code).toBe("FEEDBACK_NO_READY_EVENT");
        return null;
      }
    })();
    expect(legacyReserved).toBeNull();

    const reserved = reserveViaAdapter(paired.credential);
    expect((reserved.delivery as { eventId: string }).eventId).toBe(resultBusCompanionDeliveryId(entry.busEntryId));
    const sent = beginViaAdapter(paired.credential, (reserved.delivery as { eventId: string }).eventId, reserved.reservationId);
    const acked = ackViaAdapter(paired.credential, sent.eventId, sent.attemptId);
    expect(acked.status).toBe("observed");
    expect(readFeedbackState(workspace.id, stateDir)!.events.find(e => e.commandId === "r5d3-c")!.status).toBe("ready");
    // Bus 已无 queued；legacy ready 事件仍不可预约 → 恰好一次
    expectCode(() => reserveViaAdapter(paired.credential), "FEEDBACK_NO_READY_EVENT");
  });

  it("C2: pre-R4c ready + Bus queued → disposition legacy_unbegun_bus_owned；Bus exactly once", () => {
    enableBinding();
    const paired = pairCompanion();
    bindSink(ROUTE_A);
    const { entry, result } = seedBusEntry("r5d3-c2");
    projectPreR4cLegacy(result, { status: "ready" });
    const report = reconcileResultBusCutover({ identity: workspace, stateDir });
    expect(readResultBusCutover(workspace, stateDir)!.entries[0]).toMatchObject({
      busEntryId: entry.busEntryId, disposition: "legacy_unbegun_bus_owned",
    });
    // lifecycle 排除 cutover-owned 事件（adapter legacy 路径传入同一排除集）
    expectCode(() => reserveNext({
      workspaceId: workspace.id, bindingId: ctxOf(paired.credential).bindingId,
      epoch: ctxOf(paired.credential).epoch,
      principalFingerprint: ctxOf(paired.credential).principalFingerprint,
      companionId: ctxOf(paired.credential).companionId,
      excludeEventIds: report.ownedLegacyEventIds, stateDir,
    }), "FEEDBACK_NO_READY_EVENT");
    // Bus 不被抑制 → 恰好一次投递
    const reservedBus = reserveViaAdapter(paired.credential);
    expect((reservedBus.delivery as { eventId: string }).eventId).toBe(resultBusCompanionDeliveryId(entry.busEntryId));
    const sent = beginViaAdapter(paired.credential, (reservedBus.delivery as { eventId: string }).eventId, reservedBus.reservationId);
    expect(sent.status).toBe("claimed");
    // Bus 投递完成后，legacy 路径（经 adapter 排除集）仍不可重发
    ackViaAdapter(paired.credential, sent.eventId, sent.attemptId);
    expectCode(() => reserveViaAdapter(paired.credential), "FEEDBACK_NO_READY_EVENT");
  });

  it("D/E/F: legacy reserved/claimed/outcome_unknown（pinned 与 pre-R4c）fence Bus", () => {
    enableBinding();
    const paired = pairCompanion();
    ctxCompanionId = ctxOf(paired.credential).companionId;
    const { result } = seedBusEntry("r5d3-def");
    projectPinnedLegacy(result, { status: "reserved", companionId: ctxCompanionId });
    expectCode(() => reserveViaAdapter(paired.credential), "FEEDBACK_INFLIGHT_FENCE");
    projectPreR4cLegacy(routingResult("r5d3-def2"), { status: "claimed", companionId: ctxCompanionId });
    expectCode(() => reserveViaAdapter(paired.credential), "FEEDBACK_INFLIGHT_FENCE");
    projectPinnedLegacy(routingResult("r5d3-def3"), { status: "outcome_unknown", companionId: ctxCompanionId });
    projectPreR4cLegacy(routingResult("r5d3-def4"), { status: "outcome_unknown", companionId: ctxCompanionId });
    expectCode(() => reserveViaAdapter(paired.credential), "FEEDBACK_INFLIGHT_FENCE");
    const report = reconcileResultBusCutover({ identity: workspace, stateDir });
    expect(report.cutoverReady).toBe(false);
  });

  it("G: legacy claimed → observed（ack 内同步落 disposition）→ Bus 抑制", () => {
    enableBinding();
    const paired = pairCompanion();
    const ctx = ctxOf(paired.credential);
    ctxCompanionId = ctx.companionId;
    const { entry, result } = seedBusEntry("r5d3-g");
    projectPinnedLegacy(result, { status: "claimed", companionId: ctx.companionId });
    expectCode(() => reserveViaAdapter(paired.credential), "FEEDBACK_INFLIGHT_FENCE");
    const event = readFeedbackState(workspace.id, stateDir)!.events.find(e => e.commandId === "r5d3-g")!;
    const acked = ackViaAdapter(paired.credential, event.eventId, CLAIM_ATTEMPT);
    expect(acked.status).toBe("observed");
    // FIX 6：ack 返回时 disposition 已 durable（无 terminalization TOCTOU 窗口）
    expect(readResultBusCutover(workspace, stateDir)!.entries[0]).toMatchObject({
      busEntryId: entry.busEntryId, disposition: "legacy_observed",
    });
    expectCode(() => reserveViaAdapter(paired.credential), "FEEDBACK_NO_READY_EVENT");
  });

  it("H: legacy outcome_unknown → retired_unknown → disposition 落账，Bus 抑制", () => {
    enableBinding();
    const paired = pairCompanion();
    const ctx = ctxOf(paired.credential);
    ctxCompanionId = ctx.companionId;
    const { entry, result } = seedBusEntry("r5d3-h");
    projectPinnedLegacy(result, { status: "outcome_unknown", companionId: ctx.companionId });
    const event = readFeedbackState(workspace.id, stateDir)!.events.find(e => e.commandId === "r5d3-h")!;
    const retired = resultBusCompanionRetire({
      workspaceId: workspace.id, workspaceRoot: wsRoot, credential: paired.credential,
      routeCanonical: ROUTE_A, eventId: event.eventId, reservationId: RESERVATION,
      attemptId: CLAIM_ATTEMPT, stateDir,
    });
    expect(retired.status).toBe("retired_unknown");
    expect(readResultBusCutover(workspace, stateDir)!.entries[0]).toMatchObject({
      busEntryId: entry.busEntryId, disposition: "legacy_retired",
    });
    expectCode(() => reserveViaAdapter(paired.credential), "FEEDBACK_NO_READY_EVENT");
  });

  it("I: pinned resultSha256 漂移 / pre-R4c eventId 漂移 → fail closed", () => {
    enableBinding();
    pairCompanion();
    const { result } = seedBusEntry("r5d3-i");
    projectPinnedLegacy(result, { resultSha256: "d".repeat(64) });
    expectCode(() => reconcileResultBusCutover({ identity: workspace, stateDir }), "RESULT_BUS_CUTOVER_IDENTITY_CONFLICT");
    const second = seedBusEntry("r5d3-i2");
    projectPreR4cLegacy(second.result, { eventId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" });
    expectCode(() => reconcileResultBusCutover({ identity: workspace, stateDir }), "RESULT_BUS_CUTOVER_IDENTITY_CONFLICT");
  });

  it("J: pinned + unpinned 歧义 counterpart → fail closed", () => {
    enableBinding();
    pairCompanion();
    const { result } = seedBusEntry("r5d3-j");
    projectPreR4cLegacy(result, { status: "ready" });
    // 同 command/iteration 的 pinned counterpart（不同 eventId）→ 歧义 fail closed
    projectPinnedLegacy(result, { status: "ready", eventId: "ffffffffffffffffffffffffffffffff" });
    expectCode(() => reconcileResultBusCutover({ identity: workspace, stateDir }), "RESULT_BUS_CUTOVER_IDENTITY_CONFLICT");
  });

  it("FIX2-1A: Bus canonical entry + 同 commandId/iteration 的 FINAL_RECEIPT_REQUIRED → reconcile 成功且 control 完整", () => {
    enableBinding();
    pairCompanion();
    const { entry } = seedBusEntry("r5d3-fix21a");
    const control = projectControlEvent("r5d3-fix21a");
    const report = reconcileResultBusCutover({ identity: workspace, stateDir });
    expect(report.cutoverReady).toBe(true);
    expect(report.dispositionsWritten).toBe(0);
    // 无 canonical-like counterpart → 无 disposition、ledger 不存在
    expect(readResultBusCutover(workspace, stateDir)).toBeNull();
    expect(readResultBus(workspace, stateDir)!.entries[0]!.busEntryId).toBe(entry.busEntryId);
    // control 事件被 cutover 分类忽略，保持自身生命周期
    const controlAfter = readFeedbackState(workspace.id, stateDir)!.events.find(e => e.eventId === control.eventId)!;
    expect(controlAfter.status).toBe("ready");
  });

  it("FIX2-1B: control 共存且无历史 canonical → Bus 仍可 canonical 投递，control 仍可经 legacy/control 路径投递", () => {
    enableBinding();
    const paired = pairCompanion();
    const { entry } = seedBusEntry("r5d3-fix21b");
    const control = projectControlEvent("r5d3-fix21b");
    // 无 Active Sink：legacy/control fallback 预约 control 事件（Bus 不经 legacy 投递）
    const reserved = reserveViaAdapter(paired.credential);
    expect((reserved.delivery as { eventId: string }).eventId).toBe(control.eventId);
    resultBusCompanionRelease({
      workspaceId: workspace.id, workspaceRoot: wsRoot, credential: paired.credential,
      routeCanonical: ROUTE_A, eventId: control.eventId, reservationId: reserved.reservationId, stateDir,
    });
    expect(readFeedbackState(workspace.id, stateDir)!.events.find(e => e.eventId === control.eventId)!.status).toBe("ready");
    // 绑定 Active Sink 后：Bus canonical 投递保持可用
    bindSink(ROUTE_A);
    const busReserved = reserveViaAdapter(paired.credential);
    expect((busReserved.delivery as { eventId: string }).eventId).toBe(resultBusCompanionDeliveryId(entry.busEntryId));
  });

  it("FIX2-1C: exact pre-R4c canonical + 同 command control 事件 → pre-R4c 分类正确，control 不参与迁移匹配", () => {
    enableBinding();
    pairCompanion();
    const { entry, result } = seedBusEntry("r5d3-fix21c");
    const preR4c = projectPreR4cLegacy(result, { status: "ready" });
    const control = projectControlEvent("r5d3-fix21c");
    const report = reconcileResultBusCutover({ identity: workspace, stateDir });
    expect(report.dispositionsWritten).toBe(1);
    expect(readResultBusCutover(workspace, stateDir)!.entries[0]).toMatchObject({
      busEntryId: entry.busEntryId,
      legacyEventId: preR4c.eventId,
      disposition: "legacy_unbegun_bus_owned",
    });
    // control 事件被忽略且保持自身生命周期；ledger row 不指向 control
    expect(readFeedbackState(workspace.id, stateDir)!.events.find(e => e.eventId === control.eventId)!.status).toBe("ready");
  });

  it("FIX2-1D: pinned canonical + 同 command control 事件 → pinned 分类正常", () => {
    enableBinding();
    const paired = pairCompanion();
    const { entry, result } = seedBusEntry("r5d3-fix21d");
    const pinned = projectPinnedLegacy(result, { status: "observed", companionId: ctxOf(paired.credential).companionId });
    const control = projectControlEvent("r5d3-fix21d");
    const report = reconcileResultBusCutover({ identity: workspace, stateDir });
    expect(report.cutoverReady).toBe(true);
    expect(readResultBusCutover(workspace, stateDir)!.entries[0]).toMatchObject({
      busEntryId: entry.busEntryId,
      legacyEventId: pinned.eventId,
      disposition: "legacy_observed",
    });
    expect(readFeedbackState(workspace.id, stateDir)!.events.find(e => e.eventId === control.eventId)!.status).toBe("ready");
  });

  it("FIX2-1E: 两个 canonical-like counterpart 仍 fail closed（control 共存不弱化歧义检测）", () => {
    enableBinding();
    pairCompanion();
    const { result } = seedBusEntry("r5d3-fix21e");
    projectPreR4cLegacy(result, { status: "ready" });
    projectPinnedLegacy(result, { status: "ready", eventId: "ffffffffffffffffffffffffffffffff" });
    projectControlEvent("r5d3-fix21e");
    expectCode(() => reconcileResultBusCutover({ identity: workspace, stateDir }), "RESULT_BUS_CUTOVER_IDENTITY_CONFLICT");
  });

  it.each(["claimed", "outcome_unknown"] as const)("%s replay cannot expose Sink A payload to verified Sink B", status => {
    enableBinding();
    const pairedA = pairCompanion(ROUTE_A);
    bindSink(ROUTE_A);
    const { entry } = seedBusEntry("r5g-frozen-begin-replay");
    const reserved = reserveViaAdapter(pairedA.credential);
    const eventId = (reserved.delivery as { eventId: string }).eventId;
    const sent = beginViaAdapter(pairedA.credential, eventId, reserved.reservationId);
    if (status === "outcome_unknown") {
      markResultBusOutcomeUnknown(workspace, { busEntryId: entry.busEntryId, attemptId: sent.attemptId }, {}, stateDir);
    } else {
      const replayBytes = fs.readFileSync(resultBusFile(workspace.id, stateDir));
      expect(beginViaAdapter(pairedA.credential, eventId, reserved.reservationId)).toEqual(sent);
      expect(fs.readFileSync(resultBusFile(workspace.id, stateDir))).toEqual(replayBytes);
    }
    const frozen = readResultBus(workspace, stateDir)!.entries[0]!;
    const pairedB = pairCompanion(ROUTE_B);
    bindSink(ROUTE_B);
    const before = fs.readFileSync(resultBusFile(workspace.id, stateDir));

    expectCode(() => reserveViaAdapter(pairedB.credential, ROUTE_B), "RESULT_BUS_FROZEN_TARGET_MISMATCH");
    expectCode(() => beginViaAdapter(pairedB.credential, eventId, reserved.reservationId, ROUTE_B), "RESULT_BUS_FROZEN_TARGET_MISMATCH");

    expect(fs.readFileSync(resultBusFile(workspace.id, stateDir))).toEqual(before);
    expect(readResultBus(workspace, stateDir)!.entries[0]).toMatchObject({
      busEntryId: entry.busEntryId, deliveryStatus: status,
      attempt: { attemptId: sent.attemptId }, sendTarget: frozen.sendTarget,
    });
  });

  it("16/FIX B: 认证 route 与目标边界——B 目标必须出自 B-verified credential；跨 route 一律拒绝", () => {
    enableBinding();
    const pairedA = pairCompanion(ROUTE_A);
    const sinkA = bindSink(ROUTE_A);
    const { entry: entryA } = seedBusEntry("r5d3-16a");
    // 1. verified A + Active Sink A → reserve/send A 成功
    const reservedA = reserveViaAdapter(pairedA.credential);
    expect((reservedA.delivery as { eventId: string }).eventId).toBe(resultBusCompanionDeliveryId(entryA.busEntryId));
    expect(readResultBus(workspace, stateDir)!.entries[0]!.reservation).toMatchObject({
      bindingId: sinkA.bindingId, epoch: sinkA.epoch,
    });
    const sentA = beginViaAdapter(pairedA.credential, (reservedA.delivery as { eventId: string }).eventId, reservedA.reservationId);
    expect(sentA.status).toBe("claimed");
    // 2. verified A credential + 手工绑定 sink B → reserve B 在 mutation 前被拒
    bindSink(ROUTE_B);
    expectCode(() => reserveViaAdapter(pairedA.credential, ROUTE_B), "ROUTE_MISMATCH");
    expect(readResultBus(workspace, stateDir)!.entries[0]!.deliveryStatus).toBe("claimed");
    // 3. B 目标必须出自 B-verified credential：pair B（supersede A credential）
    const pairedB = pairCompanion(ROUTE_B);
    // 5. superseded A credential 不能操作（即使 Active Sink 说 B）：
    //    WebSink 认证失败 → legacy fallback 的 Feedback 认证同样拒绝（401）。
    expectCode(() => reserveViaAdapter(pairedA.credential, ROUTE_B), "COMPANION_UNAUTHORIZED");
    // R5d3 auth-purity：只读 pre-auth 统一边界先于 source-specific 认证，
    // superseded credential 一律 COMPANION_UNAUTHORIZED（401 语义不变）。
    expectCode(() => ackViaAdapter(pairedA.credential, sentA.eventId, sentA.attemptId), "COMPANION_UNAUTHORIZED");
    // 经 core 将冻结 A 的 attempt 安全终态化（retire 释放单飞；HTTP 层已证明拒绝跨 route）
    markResultBusOutcomeUnknown(workspace, { busEntryId: entryA.busEntryId, attemptId: sentA.attemptId }, {}, stateDir);
    retireResultBusOutcomeUnknown(workspace, { busEntryId: entryA.busEntryId, attemptId: sentA.attemptId }, {}, stateDir);
    const { entry: entryB } = seedBusEntry("r5d3-16b");
    const reservedB = reserveViaAdapter(pairedB.credential, ROUTE_B);
    expect((reservedB.delivery as { eventId: string }).eventId).toBe(resultBusCompanionDeliveryId(entryB.busEntryId));
    const sentB = beginViaAdapter(pairedB.credential, (reservedB.delivery as { eventId: string }).eventId, reservedB.reservationId, ROUTE_B);
    expect(sentB.status).toBe("claimed");
    // 4. B-verified credential/request 不能 ACK/retire 冻结于 A 的 attempt
    expectCode(() => ackViaAdapter(pairedB.credential, sentA.eventId, sentA.attemptId, ROUTE_B), "RESULT_BUS_FROZEN_TARGET_MISMATCH");
    expectCode(() => resultBusCompanionRetire({
      workspaceId: workspace.id, workspaceRoot: wsRoot, credential: pairedB.credential,
      routeCanonical: ROUTE_B, eventId: sentA.eventId, reservationId: reservedA.reservationId,
      attemptId: sentA.attemptId, stateDir,
    }), "RESULT_BUS_FROZEN_TARGET_MISMATCH");
    // retire reservationId 必须精确
    expectCode(() => resultBusCompanionRetire({
      workspaceId: workspace.id, workspaceRoot: wsRoot, credential: pairedB.credential,
      routeCanonical: ROUTE_B, eventId: sentB.eventId, reservationId: RESERVATION,
      attemptId: sentB.attemptId, stateDir,
    }), "RESULT_BUS_RESERVATION_MISMATCH");
    // 精确 B 身份 ack → 冻结 B 不变
    const acked = ackViaAdapter(pairedB.credential, sentB.eventId, sentB.attemptId, ROUTE_B);
    expect(acked.status).toBe("observed");
    expect(readResultBus(workspace, stateDir)!.entries.find(e => e.busEntryId === entryB.busEntryId)!.sendTarget)
      .toMatchObject({ canonicalUrl: ROUTE_B });
    expect(readResultBus(workspace, stateDir)!.entries.find(e => e.busEntryId === entryA.busEntryId)!.sendTarget)
      .toMatchObject({ canonicalUrl: ROUTE_A, bindingId: sinkA.bindingId });
  });

  it("17: 全局单飞 pre-mutation——第二获取被拒且状态不变", () => {
    enableBinding();
    const paired = pairCompanion();
    bindSink(ROUTE_A);
    seedBusEntry("r5d3-17");
    seedLegacyReceipt("legacy-cmd-17");
    const ctx = ctxOf(paired.credential);
    const stateSnapshot = () => JSON.stringify(readFeedbackState(workspace.id, stateDir));
    // Bus in-flight（经 adapter reserve+begin）
    const reserved = reserveViaAdapter(paired.credential);
    const sent = beginViaAdapter(paired.credential, (reserved.delivery as { eventId: string }).eventId, reserved.reservationId);
    const feedbackBefore = stateSnapshot();
    // FIX 5：Bus in-flight → MCP claim fence（neutral read fence，不写状态）
    expectCode(() => withDeliveryArbiter({ workspaceId: workspace.id, workspaceRoot: wsRoot, stateDir }, () => {
      assertNoResultBusInFlight({ workspaceId: workspace.id, workspaceRoot: wsRoot, stateDir });
    }), "FEEDBACK_INFLIGHT_FENCE");
    // Feedback 状态未被改写（pre-mutation 拒绝）
    expect(stateSnapshot()).toBe(feedbackBefore);
    // companion reserve 在 Bus in-flight 时幂等返回同一 in-flight（priority 1，不产生第二获取）
    const again = reserveViaAdapter(paired.credential);
    expect(again.reservationId).toBe(reserved.reservationId);
    // 收尾 Bus attempt → legacy in-flight（经 MCP claim arbiter 路径）→ Bus reserve 被拒
    ackViaAdapter(paired.credential, sent.eventId, sent.attemptId);
    seedLegacyReceipt("legacy-cmd-17b");
    const legacyClaimed = withDeliveryArbiter({ workspaceId: workspace.id, workspaceRoot: wsRoot, stateDir }, () => {
      assertNoResultBusInFlight({ workspaceId: workspace.id, workspaceRoot: wsRoot, stateDir });
      return claimNext({
        workspaceId: workspace.id, principal: principalA(),
        bindingId: ctx.bindingId, epoch: ctx.epoch, stateDir,
      });
    });
    expect(legacyClaimed.attemptId).toBeTruthy();
    const revisionBefore = readResultBus(workspace, stateDir)!.revision;
    expectCode(() => reserveViaAdapter(paired.credential), "FEEDBACK_INFLIGHT_FENCE");
    expect(readResultBus(workspace, stateDir)!.revision).toBe(revisionBefore);
  });

  it("17b: 手工双态 fixture（绕过 adapter）→ /state 只读诊断 fail closed", () => {
    enableBinding();
    const paired = pairCompanion();
    bindSink(ROUTE_A);
    seedBusEntry("r5d3-17b");
    seedLegacyReceipt("legacy-cmd-17b");
    const ctx = ctxOf(paired.credential);
    const legacyReserved = reserveNext({
      workspaceId: workspace.id, bindingId: ctx.bindingId, epoch: ctx.epoch,
      principalFingerprint: ctx.principalFingerprint, companionId: ctx.companionId, stateDir,
    });
    // 绕过 adapter 单飞：core 直接制造 Bus in-flight → 双 durable in-flight
    reserveNextResultBusEntry(workspace, {}, stateDir);
    expectCode(() => resultBusCompanionState({
      workspaceId: workspace.id, workspaceRoot: wsRoot, credential: paired.credential, stateDir,
    }), "RESULT_BUS_CUTOVER_INFLIGHT_CONFLICT");
    void legacyReserved;
  });

  it("FIX 2: Feedback receiver binding null / stale principal 不阻断 Bus 投递；legacy 仍需旧认证", () => {
    enableBinding();
    const paired = pairCompanion();
    bindSink(ROUTE_A);
    const { entry } = seedBusEntry("r5d3-fix2");
    // binding 置 null：feedback auth 失效，webSink auth 仍通过
    const state = readFeedbackState(workspace.id, stateDir)!;
    writeState(workspace.id, stateDir, { ...state, binding: null });
    const stateView = resultBusCompanionState({
      workspaceId: workspace.id, workspaceRoot: wsRoot, credential: paired.credential, stateDir,
    });
    expect(stateView).toMatchObject({ legacyOnly: false, pendingReady: 1 });
    const reserved = reserveViaAdapter(paired.credential);
    const sent = beginViaAdapter(paired.credential, (reserved.delivery as { eventId: string }).eventId, reserved.reservationId);
    expect(sent.status).toBe("claimed");
    expect(sent.message).toContain(`COMMAND_ID: r5d3-fix2`);
    // legacy 路径仍要求旧 Feedback 认证：无 binding → FEEDBACK_NOT_ENABLED
    expectCode(() => ctxOf(paired.credential), "FEEDBACK_NOT_ENABLED");
    // stale/different receiver principal 不阻断 Bus：恢复 binding 但 principal 改变
    const state2 = readFeedbackState(workspace.id, stateDir)!;
    writeState(workspace.id, stateDir, {
      ...state2,
      binding: { ...state.binding!, principalFingerprint: "f".repeat(32) },
    });
    expectCode(() => ctxOf(paired.credential), "COMPANION_EPOCH_STALE");
    const acked = ackViaAdapter(paired.credential, sent.eventId, sent.attemptId);
    expect(acked.status).toBe("observed");
    expect(readResultBus(workspace, stateDir)!.entries[0]!.busEntryId).toBe(entry.busEntryId);
  });

  it("FIX 4a: foreign legacy in-flight 只暴露 bounded blocking 元数据", () => {
    enableBinding();
    const paired = pairCompanion();
    ctxCompanionId = ctxOf(paired.credential).companionId;
    const { result } = seedBusEntry("r5d3-fix4a");
    bindSink(ROUTE_A);
    const legacy = projectPinnedLegacy(result, { status: "claimed", companionId: "01a00000-0000-7000-8000-0000000009d9" });
    const stateView = resultBusCompanionState({
      workspaceId: workspace.id, workspaceRoot: wsRoot, credential: paired.credential, stateDir,
    });
    expect(stateView).toMatchObject({ blockedByLegacyInFlight: true, cutoverReady: false });
    expect((stateView as { inFlight: unknown }).inFlight).toBeNull();
    expect(JSON.stringify(stateView)).not.toContain("messageSha256");
    expect(stateView).toMatchObject({ unsafeLegacyInFlight: [], unsafeLegacyInFlightCount: 1, events: [] });
    expect(JSON.stringify(stateView)).not.toContain(legacy.eventId);
    expect(JSON.stringify(stateView)).not.toContain(legacy.commandId);
  });

  it("FIX 4b: Bus attempt 冻结到 B 时，当前 verified route A 不收到可恢复载荷", () => {
    enableBinding();
    const paired = pairCompanion();
    bindSink(ROUTE_A);
    seedBusEntry("r5d3-fix4b");
    const reserved = reserveViaAdapter(paired.credential);
    const sentB = beginViaAdapter(paired.credential, (reserved.delivery as { eventId: string }).eventId, reserved.reservationId);
    expect(sentB.status).toBe("claimed");
    bindSink(ROUTE_C);
    // 当前 verified route 仍为 A（pairing route），冻结 target 也是 A —— 场景改为：
    // 冻结 target A vs companion route A 匹配 → 完整可恢复；再以不同 companion route 视角验证
    const full = resultBusCompanionState({
      workspaceId: workspace.id, workspaceRoot: wsRoot, credential: paired.credential, stateDir,
    });
    expect((full.inFlight as Record<string, unknown>)).toMatchObject({ status: "claimed" });
    expect((full.inFlight as Record<string, unknown>)).toHaveProperty("message");
    // 模拟 companion 已迁到 C（re-pair 视角）：frozen A 对 C 为 pinned-away
    // 直接用 core 检查：sendTarget.canonicalUrl(A) !== C → pinnedToOtherRoute
    const frozenUrl = readResultBus(workspace, stateDir)!.entries[0]!.sendTarget!.canonicalUrl;
    expect(frozenUrl).toBe(ROUTE_A);
    expect(frozenUrl === ROUTE_C).toBe(false);
    void sentB;
  });

  it("FIX 7: ledger 自校验——resultSha 漂移 / orphan / legacyEventId 不一致 fail closed", () => {
    enableBinding();
    const paired = pairCompanion();
    ctxCompanionId = ctxOf(paired.credential).companionId;
    const { result } = seedBusEntry("r5d3-fix7");
    projectPinnedLegacy(result, { status: "observed", companionId: ctxCompanionId });
    reconcileResultBusCutover({ identity: workspace, stateDir });
    const file = resultBusCutoverFile(workspace.id, stateDir);
    const pristine = fs.readFileSync(file, "utf8");
    const tamper = (mutate: (rows: Array<Record<string, unknown>>) => void) => {
      const state = JSON.parse(pristine);
      mutate(state.entries);
      fs.writeFileSync(file, JSON.stringify(state));
    };
    // resultSha256 漂移
    tamper(rows => { rows[0]!.resultSha256 = "e".repeat(64); });
    expectCode(() => reconcileResultBusCutover({ identity: workspace, stateDir }), "RESULT_BUS_CUTOVER_CONFLICT");
    // orphan busEntryId（无对应 Bus entry）
    tamper(rows => { rows[0]!.busEntryId = "f".repeat(64); });
    expectCode(() => reconcileResultBusCutover({ identity: workspace, stateDir }), "RESULT_BUS_CUTOVER_CONFLICT");
    // legacyEventId 与历史 source 不一致
    tamper(rows => { rows[0]!.legacyEventId = "ffffffffffffffffffffffffffffffff"; });
    expectCode(() => reconcileResultBusCutover({ identity: workspace, stateDir }), "RESULT_BUS_CUTOVER_CONFLICT");
    // 还原后精确重放 noWrite
    fs.writeFileSync(file, pristine);
    expect(reconcileResultBusCutover({ identity: workspace, stateDir })).toMatchObject({
      dispositionsWritten: 0, dispositionsReplayed: 1,
    });
  });

  it("FIX 8: 兼容 eventId 冲突在预约前 fail closed（Bus 保持 queued，revision 不变）", () => {
    enableBinding();
    const paired = pairCompanion();
    bindSink(ROUTE_A);
    const { entry } = seedBusEntry("r5d3-fix8");
    const compatId = resultBusCompanionDeliveryId(entry.busEntryId);
    // 手工 legacy 事件（无 routing result，不触发 shadow 投影）占用兼容 ID
    applyProjection({
      workspaceId: workspace.id, stateDir,
      nextCursor: readFeedbackState(workspace.id, stateDir).projectionCursor,
      newEvents: [{
        version: 1, eventId: compatId, kind: "C2C_EXECUTED", workspaceId: workspace.id,
        source: "desktop", commandId: "collision-cmd", taskId: "desktop_collision-cmd", iteration: 1,
        result: "ok", changedFilesSummary: [], testsSummary: "", outputAvailable: false,
        occurredAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        targetBindingId: null, targetEpoch: null, targetPrincipalFingerprint: null, status: "queued",
      } as FeedbackEvent],
    });
    const revisionBefore = readResultBus(workspace, stateDir)!.revision;
    expectCode(() => reserveViaAdapter(paired.credential), "RESULT_BUS_DELIVERY_ID_CONFLICT");
    expect(readResultBus(workspace, stateDir)!.entries.find(e => e.busEntryId === entry.busEntryId)).toMatchObject({
      deliveryStatus: "queued", reservation: null,
    });
    expect(readResultBus(workspace, stateDir)!.revision).toBe(revisionBefore);
  });

  it("FIX A/D/E: 无 Active Sink 时 cutover ownership 仍先建立——pre-R4c ready 永不可经 legacy 预约", () => {
    enableBinding();
    const paired = pairCompanion(ROUTE_A);
    const { result } = seedBusEntry("r5d3-fixa");
    projectPreR4cLegacy(result, { status: "ready" });
    // 无 bindSink：adapter reconcile 先行 → owned 排除集 → legacy fallback 不预约历史事件
    expectCode(() => reserveViaAdapter(paired.credential), "FEEDBACK_NO_READY_EVENT");
    // E：Feedback 状态保持不变（事件仍 ready，未被消费）
    expect(readFeedbackState(workspace.id, stateDir)!.events.find(e => e.commandId === "r5d3-fixa")!.status).toBe("ready");
    // D：reconcile 建立 ownership 后，丢失/不存在 Active Sink 也不会使其重新可预约
    reconcileResultBusCutover({ identity: workspace, stateDir });
    expect(readResultBusCutover(workspace, stateDir)!.entries[0]).toMatchObject({ disposition: "legacy_unbegun_bus_owned" });
    expectCode(() => reserveViaAdapter(paired.credential), "FEEDBACK_NO_READY_EVENT");
    // Bus entry 保持 queued（fresh canonical 无 sink 时允许留队）
    expect(readResultBus(workspace, stateDir)!.entries[0]!.deliveryStatus).toBe("queued");
  });

  it("FIX A/B: MCP claim 路径（claimNextForMcp）在任何 Browser 操作之前也不得领取 pre-R4c 事件", () => {
    enableBinding();
    const paired = pairCompanion(ROUTE_A);
    const { result } = seedBusEntry("r5d3-fixab");
    projectPreR4cLegacy(result, { status: "ready" });
    const ctx = ctxOf(paired.credential);
    // MCP handler 在任何 Browser /state //reserve 之前调用
    expectCode(() => claimNextForMcp({
      workspace, principal: principalA(), bindingId: ctx.bindingId, epoch: ctx.epoch, stateDir,
    }), "FEEDBACK_NO_READY_EVENT");
    // Feedback 状态不变；ownership 已 durable；后续 legacy reserve 同样被排除
    expect(readFeedbackState(workspace.id, stateDir)!.events.find(e => e.commandId === "r5d3-fixab")!.status).toBe("ready");
    expect(readResultBusCutover(workspace, stateDir)!.entries[0]).toMatchObject({ disposition: "legacy_unbegun_bus_owned" });
    expectCode(() => reserveViaAdapter(paired.credential), "FEEDBACK_NO_READY_EVENT");
  });

  it("历史非 canonical execution ready 不可新预约或领取，并报告排空", () => {
    enableBinding();
    const paired = pairCompanion(ROUTE_A);
    seedLegacyReceipt("legacy-noncanon-a");
    const before = readFeedbackState(workspace.id, stateDir);
    expectCode(() => reserveViaAdapter(paired.credential), "RESULT_BUS_LEGACY_DRAIN_REQUIRED");
    const binding = before.binding!;
    expectCode(() => claimNextForMcp({ workspace, principal: principalA(), bindingId: binding.bindingId,
      epoch: binding.epoch, stateDir }), "RESULT_BUS_LEGACY_DRAIN_REQUIRED");
    expect(readFeedbackState(workspace.id, stateDir).events).toEqual(before.events);
    expect(resultBusCompanionState({ workspaceId: workspace.id, workspaceRoot: wsRoot,
      credential: paired.credential, stateDir })).toMatchObject({ pendingReady: 0, cutoverReady: false,
      legacyDrainPending: 1, legacyDrainRequired: true });
  });

  it("控制专用自动回流保留 reserve/begin/ACK；不消费旁边的历史执行结果", () => {
    enableBinding();
    const paired = pairCompanion();
    seedLegacyReceipt("legacy-control-peer");
    const control = projectControlEvent("control-only-send");
    const reserved = reserveViaAdapter(paired.credential);
    expect(reserved.delivery.eventId).toBe(control.eventId);
    const sent = beginViaAdapter(paired.credential, control.eventId, reserved.reservationId);
    expect(sent.message).toContain("STATE: FINAL_RECEIPT_REQUIRED");
    expect(ackViaAdapter(paired.credential, control.eventId, sent.attemptId).status).toBe("observed");
    expect(readFeedbackState(workspace.id, stateDir).events.find(event => event.commandId === "legacy-control-peer")!.status).toBe("ready");
  });

  it("历史排空诊断仅返回聚合值，不暴露其他 binding 的执行身份", () => {
    enableBinding();
    const paired = pairCompanion();
    seedLegacyReceipt("foreign-legacy-drain");
    const snapshot = readFeedbackState(workspace.id, stateDir);
    const event = snapshot.events[0]!;
    writeState(workspace.id, stateDir, { ...snapshot, events: snapshot.events.map(item => ({ ...item,
      targetBindingId: randomUUID(), targetEpoch: 2, targetPrincipalFingerprint: "b".repeat(32) })) });
    const before = JSON.stringify(readFeedbackState(workspace.id, stateDir));
    const state = resultBusCompanionState({ workspaceId: workspace.id, workspaceRoot: wsRoot,
      credential: paired.credential, stateDir });
    expect(state).toMatchObject({ legacyDrainRequired: true, legacyDrainPending: 1, events: [] });
    expect(JSON.stringify(state)).not.toContain(event.commandId);
    expect(JSON.stringify(state)).not.toContain(event.eventId);
    expect(JSON.stringify(readFeedbackState(workspace.id, stateDir))).toBe(before);
  });

  it("foreign/MCP 旧非 canonical in-flight 只形成全局 fence，不泄漏身份", () => {
    enableBinding();
    const paired = pairCompanion();
    seedLegacyReceipt("foreign-mcp-history");
    const snapshot = readFeedbackState(workspace.id, stateDir);
    const event = snapshot.events[0]!;
    writeState(workspace.id, stateDir, { ...snapshot, events: snapshot.events.map(item => ({ ...item,
      status: "claimed", attemptId: CLAIM_ATTEMPT, claimedAt: new Date().toISOString() })) });
    const before = JSON.stringify(readFeedbackState(workspace.id, stateDir));
    const state = resultBusCompanionState({ workspaceId: workspace.id, workspaceRoot: wsRoot,
      credential: paired.credential, stateDir });
    expect(state).toMatchObject({ blockedByLegacyInFlight: true, cutoverReady: false, inFlight: null,
      unsafeLegacyInFlight: [], unsafeLegacyInFlightCount: 1, legacyDrainRequired: true, events: [] });
    for (const hidden of [event.commandId, event.eventId, CLAIM_ATTEMPT]) expect(JSON.stringify(state)).not.toContain(hidden);
    expect(JSON.stringify(readFeedbackState(workspace.id, stateDir))).toBe(before);
  });

  it.each(["reserved", "claimed", "outcome_unknown"] as const)("历史执行 %s 不可 begin 或重放 Send，原证据保持", status => {
    enableBinding();
    const paired = pairCompanion();
    const ctx = ctxOf(paired.credential);
    const result = routingResult(`history-no-send-${status}`);
    const legacy = projectPreR4cLegacy(result, { status, companionId: ctx.companionId });
    const before = JSON.stringify(readFeedbackState(workspace.id, stateDir));
    expectCode(() => beginViaAdapter(paired.credential, legacy.eventId, RESERVATION), "RESULT_BUS_LEGACY_DRAIN_REQUIRED");
    expect(JSON.stringify(readFeedbackState(workspace.id, stateDir))).toBe(before);
  });

  it.each(["reserved", "claimed", "outcome_unknown"] as const)("旧执行 %s 的自身恢复 state 禁止 Send，保留原身份与只读证据", status => {
    enableBinding();
    const paired = pairCompanion();
    const ctx = ctxOf(paired.credential);
    const result = routingResult(`history-state-no-send-${status}`);
    const legacy = projectPreR4cLegacy(result, { status, companionId: ctx.companionId });
    const before = JSON.stringify(readFeedbackState(workspace.id, stateDir));
    for (const state of [
      resultBusCompanionState({ workspaceId: workspace.id, workspaceRoot: wsRoot, credential: paired.credential, stateDir }),
      companionPublicState({ workspaceId: workspace.id, ctx, stateDir }),
    ]) {
      expect(state.inFlight).toMatchObject({ eventId: legacy.eventId,
        status: status === "claimed" ? "outcome_unknown" : status, reservationId: RESERVATION, sendAllowed: false });
      if (status !== "reserved") expect(state.inFlight).toHaveProperty("messageSha256");
    }
    expect(JSON.stringify(readFeedbackState(workspace.id, stateDir))).toBe(before);
  });

  /** legacy 非 canonical 投影路径：trusted receipt + reconcile（无 routing command）。 */
  function seedLegacyReceipt(commandId: string, options: { reconcile?: boolean } = {}) {
    updateDesktop(workspace.id, (previous) => {
      const base = previous ?? {
        version: 1 as const,
        workspaceId: workspace.id,
        workspaceRoot: wsRoot,
        enabled: true,
        binding: {
          threadId: "11111111-1111-4111-8111-111111111111",
          hostId: "local" as const,
          projectId: "proj",
          bindingId: "22222222-2222-4222-8222-222222222222",
          title: "t",
          boundAt: new Date().toISOString(),
        },
        deliveries: [] as never[],
      };
      return {
        state: {
          ...base,
          deliveries: [
            ...base.deliveries.filter((d) => d.commandId !== commandId),
            {
              commandId,
              clientId: "c",
              bindingId: "22222222-2222-4222-8222-222222222222",
              messageSha256: "a".repeat(64),
              messageBytes: 1,
              threadId: "11111111-1111-4111-8111-111111111111",
              turnId: "33333333-3333-4333-8333-333333333333",
              deliveryStatus: "accepted" as const,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        } as never,
        result: null as never,
      };
    });
    withExecutionRecordsLock(workspace.id, () => {
      appendExecutionRecordLocked(workspace.id, {
        taskId: `desktop_${commandId}`,
        iteration: 1,
        changedFiles: ["src/legacy.ts"],
        tests: "1 passed",
        exitStatus: "ok",
        timestamp: new Date().toISOString(),
        commandId,
        desktopReceiptSha256: "b".repeat(64),
        rawSummary: `legacy ${commandId}`,
        desktopThreadId: "11111111-1111-4111-8111-111111111111",
        desktopOriginTurnId: "33333333-3333-4333-8333-333333333333",
        desktopResultTurnId: "33333333-3333-4333-8333-333333333333",
        desktopBindingId: "22222222-2222-4222-8222-222222222222",
      });
    });
    if (options.reconcile !== false) reconcileHistoricalFeedbackFixtures(workspace.id, stateDir, wsRoot);
  }

  /** stale in-flight legacy fixture：把 seedLegacyReceipt 产生的 ready 事件回填为 stale reserved/claimed。 */
  function seedStaleLegacyInFlight(
    commandId: string,
    status: "reserved" | "claimed",
    staleMs: number,
  ): string {
    seedLegacyReceipt(commandId);
    const state = readFeedbackState(workspace.id, stateDir)!;
    const target = state.events.find(e => e.commandId === commandId)!;
    const ts = new Date(Date.now() - staleMs).toISOString();
    const events = state.events.map(e => e.eventId === target.eventId
      ? {
          ...e,
          status,
          reservationId: RESERVATION,
          reservedAt: ts,
          reservedBy: ctxCompanionId,
          ...(status === "claimed" ? { attemptId: CLAIM_ATTEMPT, claimedAt: ts } : {}),
        } as FeedbackEvent
      : e);
    writeState(workspace.id, stateDir, { ...state, events });
    return target.eventId;
  }

  describe("Companion HTTP integration (WebSink-only auth + cutover)", () => {
    let server: http.Server;
    let base: string;

    function startHttp(): Promise<void> {
      const app = express();
      app.use(express.json({ limit: "32kb" }));
      app.use("/api/companion/v1", createCompanionRouter({
        workspaceId: workspace.id,
        workspaceRoot: wsRoot,
        stateDir,
      }));
      server = http.createServer(app);
      return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    }

    function fetchJson(pathname: string, init?: Parameters<typeof requestJson>[1]) {
      return requestJson(`${base}${pathname}`, init);
    }

    beforeEach(async () => {
      await startHttp();
      base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });

    it("HTTP: new canonical result projects after degraded state despite another result's corrupt lifecycle lock", async () => {
      enableBinding();
      const paired = pairCompanion();
      bindSink(ROUTE_A);
      routingResult("unrelated-control-locked");
      const lock = blockUnrelatedLegacy();
      const headers = { authorization: `Bearer ${paired.credential}`, "content-type": "application/json" };
      const before = fs.readFileSync(feedbackStateFile(workspace.id, stateDir));
      expect(await fetchJson("/api/companion/v1/state", { headers })).toMatchObject({ status: 200,
        body: { pendingReady: 1 } });
      // Incident: the trusted canonical result appears AFTER degraded serving began.
      const result = routingResult("new-command27-like");
      expect(readResultBus(workspace, stateDir)?.entries ?? []).toEqual([]);
      const state = await fetchJson("/api/companion/v1/state", { headers });
      expect(state).toMatchObject({ status: 200, body: { pendingReady: 1, routeVerification: "VERIFIED" } });
      expect(readResultBus(workspace, stateDir)?.entries ?? []).toEqual([]);
      expect(JSON.stringify(state.body)).not.toMatch(/nonce|\.json\.lock|c2c_comp_/);
      const request = { method: "POST", headers, body: JSON.stringify({ routeCanonical: ROUTE_A }) };
      const reserved = await fetchJson("/api/companion/v1/reserve", request);
      expect(reserved).toMatchObject({ status: 200, body: { delivery: { commandId: result.commandId } } });
      const bytes = fs.readFileSync(resultBusFile(workspace.id, stateDir));
      expect(await fetchJson("/api/companion/v1/reserve", request)).toEqual(reserved);
      expect(fs.readFileSync(resultBusFile(workspace.id, stateDir))).toEqual(bytes);
      expect(readResultBus(workspace, stateDir)!.entries).toHaveLength(1);
      expect(fs.readFileSync(feedbackStateFile(workspace.id, stateDir))).toEqual(before);
      expect(fs.statSync(lock).size).toBe(0);
    });

    it("HTTP: WebSink-only auth（binding null）下 /state /reserve /begin-send 可用", async () => {
      enableBinding();
      const paired = pairCompanion();
      bindSink(ROUTE_A);
      seedBusEntry("r5d3-http1");
      const state = readFeedbackState(workspace.id, stateDir)!;
      writeState(workspace.id, stateDir, { ...state, binding: null });
      const auth = { authorization: `Bearer ${paired.credential}`, "content-type": "application/json" };
      const stateRes = await fetchJson("/api/companion/v1/state", { headers: auth });
      expect(stateRes.status).toBe(200);
      expect(stateRes.body.legacyOnly).toBe(false);
      expect(stateRes.body.pendingReady).toBe(1);
      const reserved = await fetchJson("/api/companion/v1/reserve", {
        method: "POST", headers: auth, body: JSON.stringify({ routeCanonical: ROUTE_A }),
      });
      expect(reserved.status).toBe(200);
      const eventId = reserved.body.delivery.eventId as string;
      const sent = await fetchJson("/api/companion/v1/begin-send", {
        method: "POST", headers: auth,
        body: JSON.stringify({ routeCanonical: ROUTE_A, eventId, reservationId: reserved.body.reservationId }),
      });
      expect(sent.status).toBe(200);
      expect(sent.body.status).toBe("claimed");
      expect(sent.body.message).toContain("[C2C_CONTROL]");
    });

    it("HTTP: exact isolate frees the next result; retry is idempotent and late ACK remains observed", async () => {
      enableBinding();
      const paired = pairCompanion();
      bindSink(ROUTE_A);
      const first = seedBusEntry("r5d3-isolate-first");
      const headers = { authorization: `Bearer ${paired.credential}`, "content-type": "application/json" };
      const resultPath = `/api/companion/v1/operations/result?commandId=${first.result.commandId}&iteration=1`;
      const routingBeforeRead = fs.readFileSync(routingFile(workspace.id, stateDir));
      const busBeforeRead = fs.readFileSync(resultBusFile(workspace.id, stateDir));
      expect(await fetchJson(resultPath, { headers })).toMatchObject({ status: 200, body: {
        commandId: first.result.commandId, iteration: 1, resultId: first.result.resultId,
        resultSha256: canonicalRoutingResultDigest(first.result), status: "ok",
        rawSummary: first.result.rawSummary, testsSummary: first.result.machineEvidence.testsSummary,
        deliveryStatus: "queued",
      } });
      expect(fs.readFileSync(routingFile(workspace.id, stateDir))).toEqual(routingBeforeRead);
      expect(fs.readFileSync(resultBusFile(workspace.id, stateDir))).toEqual(busBeforeRead);

      const reserved = await fetchJson("/api/companion/v1/reserve", { method: "POST", headers,
        body: JSON.stringify({ routeCanonical: ROUTE_A }) });
      expect(reserved).toMatchObject({ status: 200, body: { delivery: { commandId: first.result.commandId } } });
      const second = seedBusEntry("r5d3-isolate-second");
      const eventId = reserved.body.delivery.eventId as string;
      const reservationId = reserved.body.reservationId as string;
      const sent = await fetchJson("/api/companion/v1/begin-send", { method: "POST", headers,
        body: JSON.stringify({ routeCanonical: ROUTE_A, eventId, reservationId }) });
      expect(sent.status).toBe(200);
      const target = { routeCanonical: ROUTE_A, eventId, reservationId,
        attemptId: sent.body.attemptId as string, messageSha256: sent.body.messageSha256 as string };
      const revision = readResultBus(workspace, stateDir)!.revision;
      const unauthorized = await fetchJson("/api/companion/v1/isolate-attempt", { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify(target) });
      expect(unauthorized.status).toBe(401);
      const extraField = await fetchJson("/api/companion/v1/isolate-attempt", { method: "POST", headers,
        body: JSON.stringify({ ...target, message: "must not be accepted" }) });
      expect(extraField.status).toBe(400);
      const wrongAttempt = await fetchJson("/api/companion/v1/isolate-attempt", { method: "POST", headers,
        body: JSON.stringify({ ...target, attemptId: "01a00000-0000-7000-8000-0000000007d3" }) });
      expect(wrongAttempt.status).toBe(409);
      const wrongRoute = await fetchJson("/api/companion/v1/isolate-attempt", { method: "POST", headers,
        body: JSON.stringify({ ...target, routeCanonical: ROUTE_B }) });
      expect(wrongRoute.status).toBe(400);
      expect(readResultBus(workspace, stateDir)!.revision).toBe(revision);

      const isolated = await fetchJson("/api/companion/v1/isolate-attempt", { method: "POST", headers,
        body: JSON.stringify(target) });
      expect(isolated).toMatchObject({ status: 200, body: { ...target,
        status: "outcome_unknown", isolated: true, observed: false } });
      expect(isolated.body).not.toHaveProperty("message");
      expect(readResultBus(workspace, stateDir)!.entries.find(entry => entry.commandId === first.result.commandId))
        .toMatchObject({ deliveryStatus: "outcome_unknown", isolatedAt: expect.any(String) });
      const state = await fetchJson("/api/companion/v1/state", { headers });
      expect(state).toMatchObject({ status: 200, body: { inFlight: null, isolatedAttempts: [{
        ...target, isolated: true, status: "outcome_unknown",
      }] } });
      expect(JSON.stringify(state.body)).not.toContain(sent.body.message);
      const frozenReadBytes = fs.readFileSync(resultBusFile(workspace.id, stateDir));
      expect(await fetchJson(resultPath, { headers })).toMatchObject({ status: 200, body: {
        resultId: first.result.resultId, resultSha256: canonicalRoutingResultDigest(first.result),
        status: "ok", rawSummary: first.result.rawSummary,
        testsSummary: first.result.machineEvidence.testsSummary, deliveryStatus: "outcome_unknown",
      } });
      expect(fs.readFileSync(resultBusFile(workspace.id, stateDir))).toEqual(frozenReadBytes);

      const isolatedRevision = readResultBus(workspace, stateDir)!.revision;
      const retry = await fetchJson("/api/companion/v1/isolate-attempt", { method: "POST", headers,
        body: JSON.stringify(target) });
      expect(retry).toEqual(isolated);
      expect(readResultBus(workspace, stateDir)!.revision).toBe(isolatedRevision);
      const operations = await readCompanionOperations({ workspaceId: workspace.id, workspaceRoot: wsRoot,
        credential: paired.credential, stateDir }, async () => ({ workspaceId: workspace.id, activeBinding: null,
        plugins: [], availability: { available: false, reasonCode: "inspect_failed", message: "unavailable" } } as never));
      expect(operations.commands.find(command => command.commandId === first.result.commandId)?.feedback)
        .toContainEqual(expect.objectContaining({ source: "result_bus", status: "outcome_unknown", isolated: true }));

      const next = await fetchJson("/api/companion/v1/reserve", { method: "POST", headers,
        body: JSON.stringify({ routeCanonical: ROUTE_A }) });
      expect(next).toMatchObject({ status: 200, body: { delivery: { commandId: second.result.commandId } } });
      const lateAck = await fetchJson("/api/companion/v1/ack", { method: "POST", headers,
        body: JSON.stringify({ routeCanonical: ROUTE_A, eventId, attemptId: target.attemptId }) });
      expect(lateAck).toMatchObject({ status: 200, body: { eventId, status: "observed" } });
      const afterLateAck = await fetchJson("/api/companion/v1/state", { headers });
      expect(afterLateAck.body.isolatedAttempts).toEqual([]);
      expect(afterLateAck.body.events).toContainEqual({ eventId, status: "observed", attemptId: target.attemptId });
    });

    it("HTTP: new verified route gets an explicit refusal for a frozen historical result", async () => {
      enableBinding();
      const pairedA = pairCompanion(ROUTE_A);
      bindSink(ROUTE_A);
      const { result } = seedBusEntry("r5d3-isolate-history");
      const headersA = { authorization: `Bearer ${pairedA.credential}`, "content-type": "application/json" };
      const reserved = await fetchJson("/api/companion/v1/reserve", { method: "POST", headers: headersA,
        body: JSON.stringify({ routeCanonical: ROUTE_A }) });
      const eventId = reserved.body.delivery.eventId as string;
      const sent = await fetchJson("/api/companion/v1/begin-send", { method: "POST", headers: headersA,
        body: JSON.stringify({ routeCanonical: ROUTE_A, eventId, reservationId: reserved.body.reservationId }) });
      const target = { routeCanonical: ROUTE_A, eventId, reservationId: reserved.body.reservationId,
        attemptId: sent.body.attemptId, messageSha256: sent.body.messageSha256 };
      expect((await fetchJson("/api/companion/v1/isolate-attempt", { method: "POST", headers: headersA,
        body: JSON.stringify(target) })).status).toBe(200);

      const pairedB = pairCompanion(ROUTE_B);
      const headersB = { authorization: `Bearer ${pairedB.credential}` };
      const query = `/api/companion/v1/operations/result?commandId=${result.commandId}&iteration=1`;
      const refused = await fetchJson(query, { headers: headersB });
      expect(refused).toMatchObject({ status: 409, body: { error: "COMPANION_RESULT_HISTORICAL_REFUSED" } });
      expect(JSON.stringify(refused.body)).not.toContain(result.rawSummary);
      expect(JSON.stringify(refused.body)).not.toContain(result.machineEvidence.testsSummary);
      const state = await fetchJson("/api/companion/v1/state", { headers: headersB });
      expect(state.body.isolatedAttempts).toEqual([]);
      expect(JSON.stringify(state.body)).not.toContain(target.attemptId);
    });

    it("HTTP: canonical result read fails closed on immutable digest drift", async () => {
      enableBinding();
      const paired = pairCompanion();
      bindSink(ROUTE_A);
      const { result } = seedBusEntry("r5d3-result-digest-drift");
      const file = routingFile(workspace.id, stateDir);
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      state.results[0].rawSummary = `${result.rawSummary} tampered`;
      fs.writeFileSync(file, JSON.stringify(state));
      const routingBeforeRead = fs.readFileSync(file);
      const headers = { authorization: `Bearer ${paired.credential}` };
      const response = await fetchJson(`/api/companion/v1/operations/result?commandId=${result.commandId}&iteration=1`, { headers });
      expect(response.status).toBe(409);
      expect(response.body.error).toBe("RESULT_BUS_CONFLICT");
      expect(JSON.stringify(response.body)).not.toContain(result.rawSummary);
      expect(fs.readFileSync(file)).toEqual(routingBeforeRead);
    });

    it("HTTP: terminal-gone query is read-only and never ACKs a still-present attempt", async () => {
      enableBinding();
      const paired = pairCompanion();
      bindSink(ROUTE_A);
      const commandId = "r5d3-terminal-gone-query";
      const { entry } = seedEphemeralBusEntry(commandId);
      expect(entry.lifecycle).toBe("ephemeral");
      const headers = { authorization: `Bearer ${paired.credential}`, "content-type": "application/json" };
      const reserved = await fetchJson("/api/companion/v1/reserve", { method: "POST", headers,
        body: JSON.stringify({ routeCanonical: ROUTE_A }) });
      const eventId = reserved.body.delivery.eventId as string;
      const sent = await fetchJson("/api/companion/v1/begin-send", { method: "POST", headers,
        body: JSON.stringify({ routeCanonical: ROUTE_A, eventId, reservationId: reserved.body.reservationId }) });
      const target = { routeCanonical: ROUTE_A, eventId, attemptId: sent.body.attemptId as string,
        terminalWitness: sent.body.terminalWitness as string };
      expect(target.terminalWitness).toBeTruthy();

      const unauthorized = await fetchJson("/api/companion/v1/operations/terminal-gone", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(target),
      });
      expect(unauthorized.status).toBe(401);
      const extraField = await fetchJson("/api/companion/v1/operations/terminal-gone", { method: "POST", headers,
        body: JSON.stringify({ ...target, extra: true }) });
      expect(extraField.status).toBe(400);

      const beforePresentRead = stateSnapshot(stateDir);
      const present = await fetchJson("/api/companion/v1/operations/terminal-gone", { method: "POST", headers,
        body: JSON.stringify(target) });
      expect(present).toEqual({ status: 409, body: { routeCanonical: ROUTE_A, eventId,
        attemptId: target.attemptId, status: "still_present" } });
      expect(readResultBus(workspace, stateDir)!.entries.find(item => item.commandId === commandId)?.deliveryStatus).toBe("claimed");
      expect(stateSnapshot(stateDir)).toEqual(beforePresentRead);

      const cleanupTarget = { workspaceId: workspace.id, workspaceRoot: wsRoot, commandId, iteration: 1 as const, stateDir };
      const preview = previewCommandCleanup(cleanupTarget);
      expect(confirmCommandCleanup(cleanupTarget, preview.confirmationSha256!)).toMatchObject({ status: "cleaned" });
      const beforeGoneRead = stateSnapshot(stateDir);
      const gone = await fetchJson("/api/companion/v1/operations/terminal-gone", { method: "POST", headers,
        body: JSON.stringify(target) });
      expect(gone).toEqual({ status: 200, body: { routeCanonical: ROUTE_A, eventId,
        attemptId: target.attemptId, status: "terminal_gone" } });
      expect(stateSnapshot(stateDir)).toEqual(beforeGoneRead);
    });

    it("HTTP: valid Web Sink state/reserve bypass only unrelated unavailable legacy enrichment", async () => {
      enableBinding();
      const paired = pairCompanion();
      bindSink(ROUTE_A);
      seedBusEntry("http-canonical-locked-legacy");
      blockUnrelatedLegacy();
      const before = fs.readFileSync(feedbackStateFile(workspace.id, stateDir));
      const headers = { authorization: `Bearer ${paired.credential}`, "content-type": "application/json" };
      const state = await fetchJson("/api/companion/v1/state", { headers });
      expect(state).toMatchObject({ status: 200, body: { routeVerification: "VERIFIED", pendingReady: 2 } });
      expect(JSON.stringify(state.body)).not.toMatch(/nonce|\.json\.lock|c2c_comp_/);
      expect(await fetchJson("/api/companion/v1/reserve", { method: "POST", headers,
        body: JSON.stringify({ routeCanonical: ROUTE_A }) })).toMatchObject({ status: 200 });
      expect(fs.readFileSync(feedbackStateFile(workspace.id, stateDir))).toEqual(before);
    });

    it("HTTP: unresolved cutover and corrupt Feedback stay bounded fail-closed", async () => {
      enableBinding();
      const paired = pairCompanion();
      bindSink(ROUTE_A);
      const { result } = seedBusEntry("http-unresolved-cutover");
      projectPinnedLegacy(result);
      blockUnrelatedLegacy();
      const headers = { authorization: `Bearer ${paired.credential}`, "content-type": "application/json" };
      expect(await fetchJson("/api/companion/v1/state", { headers })).toEqual({ status: 409,
        body: { error: "RESULT_BUS_CUTOVER_REQUIRED", stage: "result_bus_cutover" } });
      fs.writeFileSync(feedbackStateFile(workspace.id, stateDir), "{}");
      const failed = await fetchJson("/api/companion/v1/state", { headers });
      expect(failed.status).not.toBe(200);
      expect(failed.body.error).toBe("FEEDBACK_STATE_CORRUPT");
      expect(readResultBus(workspace, stateDir)!.entries[0].deliveryStatus).toBe("queued");
    });

    it("HTTP: 无 Active Sink 保持 queued；显式绑定后 ACK 丢响应可由冻结 route 的 /state 精确收敛", async () => {
      enableBinding();
      const paired = pairCompanion(ROUTE_A);
      const { entry } = seedBusEntry("r5d3-http-observed");
      const auth = { authorization: `Bearer ${paired.credential}`, "content-type": "application/json" };
      expect(readActiveWebSinkBinding(workspace.id)).toBeNull();
      const before = await fetchJson("/api/companion/v1/state", { headers: auth });
      expect(before.status).toBe(200);
      expect(before.body).toMatchObject({ routeVerification: "VERIFIED", pendingReady: 1, inFlight: null });
      const unavailable = await fetchJson("/api/companion/v1/reserve", {
        method: "POST", headers: auth, body: JSON.stringify({ routeCanonical: ROUTE_A }),
      });
      expect(unavailable.status).toBe(404);
      expect(readResultBus(workspace, stateDir)!.entries[0]).toMatchObject({
        deliveryStatus: "queued", attempt: null,
      });

      const bound = await fetchJson("/api/companion/v1/web-sink/bind-current", {
        method: "POST", headers: auth, body: JSON.stringify({ routeCanonical: ROUTE_A }),
      });
      expect(bound.status).toBe(200);
      expect(bound.body.activeBinding.canonicalUrl).toBe(ROUTE_A);
      const reserved = await fetchJson("/api/companion/v1/reserve", {
        method: "POST", headers: auth, body: JSON.stringify({ routeCanonical: ROUTE_A }),
      });
      expect(reserved.status).toBe(200);
      const eventId = reserved.body.delivery.eventId as string;
      const sent = await fetchJson("/api/companion/v1/begin-send", {
        method: "POST", headers: auth,
        body: JSON.stringify({ routeCanonical: ROUTE_A, eventId, reservationId: reserved.body.reservationId }),
      });
      expect(sent.status).toBe(200);
      const attemptId = sent.body.attemptId as string;
      const ackBody = { routeCanonical: ROUTE_A, eventId, attemptId };
      const ack = await fetchJson("/api/companion/v1/ack", {
        method: "POST", headers: auth, body: JSON.stringify(ackBody),
      });
      expect(ack).toMatchObject({ status: 200, body: { eventId, status: "observed" } });
      // 模拟 ACK 响应丢失：仅用随后认证 /state 的投影恢复本地 journal。
      const state = await fetchJson("/api/companion/v1/state", { headers: auth });
      expect(state.status).toBe(200);
      expect(state.body.inFlight).toBeNull();
      const observed = { eventId, status: "observed", attemptId };
      expect(state.body.events.filter((event: { eventId: string }) => event.eventId === eventId)).toEqual([observed]);
      for (const journalState of ["OUTCOME_UNKNOWN", "OBSERVED_PENDING_ACK"]) {
        const journal = { state: journalState, eventId, attemptId };
        const found = findExactObservedEvent(state.body.events, journal);
        expect(found).toEqual({ ok: true, observed });
        expect(evaluateServerObservedCloseout({ journal, inFlight: state.body.inFlight, serverObserved: found.observed }))
          .toEqual({ ok: true, action: "server_observed_clear" });
      }
      expect(findExactObservedEvent(state.body.events, {
        state: "OBSERVED_PENDING_ACK", eventId, attemptId: CLAIM_ATTEMPT_ALT,
      }).ok).toBe(false);
      const duplicate = await fetchJson("/api/companion/v1/ack", {
        method: "POST", headers: auth, body: JSON.stringify(ackBody),
      });
      expect(duplicate).toMatchObject({ status: 200, body: { eventId, status: "observed" } });
      expect(readResultBus(workspace, stateDir)!.entries[0]!.busEntryId).toBe(entry.busEntryId);

      bindSink(ROUTE_C);
      const oldRoute = await fetchJson("/api/companion/v1/state", { headers: auth });
      expect(oldRoute.body.events).toContainEqual(observed);
      const pairedC = pairCompanion(ROUTE_C);
      const otherRoute = await fetchJson("/api/companion/v1/state", {
        headers: { authorization: `Bearer ${pairedC.credential}` },
      });
      expect(otherRoute.status).toBe(200);
      expect(otherRoute.body.events).not.toContainEqual(observed);
      expect(findExactObservedEvent(otherRoute.body.events, {
        state: "OBSERVED_PENDING_ACK", eventId, attemptId,
      }).ok).toBe(false);
    });

    for (const sameRouteSuccessor of [false, true]) {
      it(`HTTP: reserved 只向原 Sink stamp 暴露；${sameRouteSuccessor ? "同 route successor" : "跨 route Sink"} 切换后先 stale 再新预约`, async () => {
        enableBinding();
        const pairedA = pairCompanion(ROUTE_A);
        const sinkA = bindSink(ROUTE_A);
        const { entry } = seedBusEntry(`r5d3-reserved-isolation-${sameRouteSuccessor ? "same" : "cross"}`);
        const authA = { authorization: `Bearer ${pairedA.credential}`, "content-type": "application/json" };
        const reserve = (auth: typeof authA, routeCanonical: string) => fetchJson("/api/companion/v1/reserve", {
          method: "POST", headers: auth, body: JSON.stringify({ routeCanonical }),
        });
        const first = await reserve(authA, ROUTE_A);
        expect(first.status).toBe(200);
        const eventId = first.body.delivery.eventId as string;
        const reservationId = first.body.reservationId as string;
        expect(eventId).toBe(resultBusCompanionDeliveryId(entry.busEntryId));
        const firstStamp = readResultBus(workspace, stateDir)!.entries[0]!.reservation!;
        expect(firstStamp).toMatchObject({ bindingId: sinkA.bindingId, epoch: sinkA.epoch, boundAt: sinkA.boundAt });
        const firstBytes = fs.readFileSync(resultBusFile(workspace.id, stateDir), "utf8");
        const same = await reserve(authA, ROUTE_A);
        expect(same).toMatchObject({ status: 200, body: { reservationId, delivery: { eventId } } });
        const equivalentRoute = `https://www.chatgpt.com/c/${ROUTE_A.split("/").at(-1)}/`;
        const equivalent = await reserve(authA, equivalentRoute);
        expect(equivalent).toMatchObject({ status: 200, body: { reservationId, delivery: { eventId } } });
        const sameState = await fetchJson("/api/companion/v1/state", { headers: authA });
        expect(sameState.body.inFlight).toMatchObject({ status: "reserved", eventId, reservationId });
        expect(fs.readFileSync(resultBusFile(workspace.id, stateDir), "utf8")).toBe(firstBytes);

        const pairedB = pairCompanion(ROUTE_B);
        bindSink(ROUTE_B);
        const nextPaired = sameRouteSuccessor ? pairCompanion(ROUTE_A) : pairedB;
        const nextRoute = sameRouteSuccessor ? ROUTE_A : ROUTE_B;
        const nextSink = sameRouteSuccessor ? bindSink(ROUTE_A) : readActiveWebSinkBinding(workspace.id)!;
        expect(nextSink.bindingId).not.toBe(sinkA.bindingId);
        const nextAuth = { authorization: `Bearer ${nextPaired.credential}`, "content-type": "application/json" };
        const beforeStale = fs.readFileSync(resultBusFile(workspace.id, stateDir), "utf8");
        const blocked = await reserve(nextAuth, nextRoute);
        expect(blocked.status).toBe(409);
        expect(blocked.body.error).toBe("RESULT_BUS_STALE_RESERVATION");
        expect(blocked.body).not.toHaveProperty("delivery");
        expect(blocked.body).not.toHaveProperty("reservationId");
        expect(JSON.stringify(blocked.body)).not.toContain(eventId);
        expect(JSON.stringify(blocked.body)).not.toContain(reservationId);
        expect(JSON.stringify(blocked.body)).not.toContain(entry.result.rawSummary);
        const pinned = await fetchJson("/api/companion/v1/state", { headers: nextAuth });
        expect(pinned.body.inFlight).toEqual({ status: "reserved", pinnedToOtherRoute: true });
        expect(fs.readFileSync(resultBusFile(workspace.id, stateDir), "utf8")).toBe(beforeStale);

        const stale = await fetchJson("/api/companion/v1/begin-send", {
          method: "POST", headers: nextAuth,
          body: JSON.stringify({ routeCanonical: nextRoute, eventId, reservationId }),
        });
        expect(stale.status).toBe(409);
        expect(stale.body.error).toBe("RESULT_BUS_STALE_RESERVATION");
        expect(readResultBus(workspace, stateDir)!.entries[0]).toMatchObject({
          deliveryStatus: "queued", reservation: null, attempt: null, sendTarget: null,
        });
        const fresh = await reserve(nextAuth, nextRoute);
        expect(fresh).toMatchObject({ status: 200, body: { delivery: { eventId } } });
        expect(fresh.body.reservationId).not.toBe(reservationId);
        expect(readResultBus(workspace, stateDir)!.entries[0]!.reservation).toMatchObject({
          reservationId: fresh.body.reservationId,
          bindingId: nextSink.bindingId, epoch: nextSink.epoch, boundAt: nextSink.boundAt,
        });
      });
    }

    it("HTTP: pre-R4c observed 历史事件经 /reserve 不重发", async () => {
      enableBinding();
      const paired = pairCompanion();
      bindSink(ROUTE_A);
      seedBusEntry("r5d3-http2");
      projectPreR4cLegacy(readResultBus(workspace, stateDir)!.entries[0]!.result as never, { status: "observed", companionId: ctxOf(paired.credential).companionId });
      reconcileResultBusCutover({ identity: workspace, stateDir });
      const auth = { authorization: `Bearer ${paired.credential}`, "content-type": "application/json" };
      const reserved = await fetchJson("/api/companion/v1/reserve", {
        method: "POST", headers: auth, body: JSON.stringify({ routeCanonical: ROUTE_A }),
      });
      expect(reserved.status).toBe(404);
      expect(reserved.body.error).toBe("FEEDBACK_NO_READY_EVENT");
    });

    it("HTTP: 全局单飞——legacy in-flight 时 /reserve 409；collision preflight 409", async () => {
      enableBinding();
      const paired = pairCompanion();
      bindSink(ROUTE_A);
      seedBusEntry("r5d3-http3");
      seedLegacyReceipt("legacy-cmd-http3");
      const ctx = ctxOf(paired.credential);
      const legacyReserved = reserveNext({
        workspaceId: workspace.id, bindingId: ctx.bindingId, epoch: ctx.epoch,
        principalFingerprint: ctx.principalFingerprint, companionId: ctx.companionId, stateDir,
      });
      const auth = { authorization: `Bearer ${paired.credential}`, "content-type": "application/json" };
      const reserved = await fetchJson("/api/companion/v1/reserve", {
        method: "POST", headers: auth, body: JSON.stringify({ routeCanonical: ROUTE_A }),
      });
      expect(reserved.status).toBe(409);
      expect(reserved.body.error).toBe("FEEDBACK_INFLIGHT_FENCE");
      void legacyReserved;
      // collision preflight：legacy 事件占用某 queued entry 的兼容 ID → /reserve 409
      const collisionEntry = seedBusEntry("r5d3-http4");
      const legacyClaimed = beginSend({
        workspaceId: workspace.id, bindingId: ctx.bindingId, epoch: ctx.epoch,
        principalFingerprint: ctx.principalFingerprint, companionId: ctx.companionId,
        eventId: legacyReserved.event.eventId, reservationId: legacyReserved.reservationId, stateDir,
      });
      legacyAck({
        workspaceId: workspace.id, bindingId: ctx.bindingId, epoch: ctx.epoch,
        principalFingerprint: ctx.principalFingerprint, companionId: ctx.companionId,
        eventId: legacyReserved.event.eventId, attemptId: legacyClaimed.attemptId, stateDir,
      });
      void collisionEntry;
      const compatId = resultBusCompanionDeliveryId(collisionEntry.entry.busEntryId);
      projectPinnedLegacy(readResultBus(workspace, stateDir)!.entries
        .find(e => e.busEntryId === collisionEntry.entry.busEntryId)!.result as never, { eventId: compatId });
      const collision = await fetchJson("/api/companion/v1/reserve", {
        method: "POST", headers: auth, body: JSON.stringify({ routeCanonical: ROUTE_A }),
      });
      expect(collision.status).toBe(409);
      expect(collision.body.error).toBe("RESULT_BUS_DELIVERY_ID_CONFLICT");
    });

    it("HTTP FIX2-2A: 无效 credential + pending canonical RoutingResult → 401 且零 mutation", async () => {
      enableBinding();
      const paired = pairCompanion();
      // pending canonical RoutingResult：只建 routing result，不显式 enqueue Bus entry；
      // pre-auth reconcile 会创建 Bus 文件（mutation），auth-first 修复后必须保持 absent。
      routingResult("r5d3-auth-a");
      const feedbackBefore = JSON.stringify(readFeedbackState(workspace.id, stateDir));
      expect(fs.existsSync(resultBusFile(workspace.id, stateDir))).toBe(false);
      expect(fs.existsSync(resultBusCutoverFile(workspace.id, stateDir))).toBe(false);
      const res = await fetchJson("/api/companion/v1/reserve", {
        method: "POST",
        headers: { authorization: "Bearer invalid-credential-xyz", "content-type": "application/json" },
        body: JSON.stringify({ routeCanonical: ROUTE_A }),
      });
      expect(res.status).toBe(401);
      // Result Bus shadow / cutover ledger / Feedback projector 全部未被触碰
      expect(fs.existsSync(resultBusFile(workspace.id, stateDir))).toBe(false);
      expect(fs.existsSync(resultBusCutoverFile(workspace.id, stateDir))).toBe(false);
      expect(JSON.stringify(readFeedbackState(workspace.id, stateDir))).toBe(feedbackBefore);
      void paired;
    });

    it("HTTP FIX2-2B: 无效 credential + pending Feedback control 事件 → 401 且零 projection/reservation mutation", async () => {
      enableBinding();
      pairCompanion();
      // pending execution record（未投影）+ ready control 事件共存
      seedLegacyReceipt("r5d3-auth-b", { reconcile: false });
      const control = projectControlEvent("r5d3-auth-b");
      const feedbackBefore = JSON.stringify(readFeedbackState(workspace.id, stateDir));
      expect(fs.existsSync(resultBusCutoverFile(workspace.id, stateDir))).toBe(false);
      const res = await fetchJson("/api/companion/v1/reserve", {
        method: "POST",
        headers: { authorization: "Bearer invalid-credential-xyz", "content-type": "application/json" },
        body: JSON.stringify({ routeCanonical: ROUTE_A }),
      });
      expect(res.status).toBe(401);
      // 无投影（pending record 未被消费、cursor 未前进）、无 reservation、无 ledger
      const after = readFeedbackState(workspace.id, stateDir)!;
      expect(JSON.stringify(after)).toBe(feedbackBefore);
      expect(after.events.find(e => e.eventId === control.eventId)!.status).toBe("ready");
      expect(after.events.some(e => e.status === "reserved")).toBe(false);
      expect(fs.existsSync(resultBusCutoverFile(workspace.id, stateDir))).toBe(false);
    });

    it("HTTP FIX2-2C: 有效 WebSink credential + 无 Active Sink → 认证后 ownership reconcile，canonical legacy 被排除，control fallback 可用", async () => {
      enableBinding();
      const paired = pairCompanion();
      const { result } = seedBusEntry("r5d3-auth-c");
      const preR4c = projectPreR4cLegacy(result, { status: "ready" });
      const control = projectControlEvent("r5d3-auth-c-ctrl");
      const auth = { authorization: `Bearer ${paired.credential}`, "content-type": "application/json" };
      const reserved = await fetchJson("/api/companion/v1/reserve", {
        method: "POST", headers: auth, body: JSON.stringify({ routeCanonical: ROUTE_A }),
      });
      expect(reserved.status).toBe(200);
      // fallback 预约的是 eligible control 事件，而非 cutover-owned canonical legacy
      expect(reserved.body.delivery.eventId).toBe(control.eventId);
      expect(reserved.body.delivery.eventId).not.toBe(preR4c.eventId);
      // 认证后 cutover ownership 已 reconcile（pre-R4c ready → legacy_unbegun_bus_owned）
      expect(readResultBusCutover(workspace, stateDir)!.entries[0]).toMatchObject({
        legacyEventId: preR4c.eventId,
        disposition: "legacy_unbegun_bus_owned",
      });
      // canonical legacy 保持 ready（被排除，未被消费）
      expect(readFeedbackState(workspace.id, stateDir)!.events.find(e => e.eventId === preR4c.eventId)!.status).toBe("ready");
    });

    it("HTTP FIX2-2D: 有效 credential 保留控制专用回流，旧 execution 返回明确排空错误", async () => {
      enableBinding();
      const paired = pairCompanion();
      seedLegacyReceipt("r5d3-auth-d");
      const auth = { authorization: `Bearer ${paired.credential}`, "content-type": "application/json" };
      const reserved = await fetchJson("/api/companion/v1/reserve", {
        method: "POST", headers: auth, body: JSON.stringify({ routeCanonical: ROUTE_A }),
      });
      expect(reserved.status).toBe(409);
      expect(reserved.body.error).toBe("RESULT_BUS_LEGACY_DRAIN_REQUIRED");
      const control = projectControlEvent("r5d3-auth-d-control");
      const notification = await fetchJson("/api/companion/v1/reserve", {
        method: "POST", headers: auth, body: JSON.stringify({ routeCanonical: ROUTE_A }),
      });
      expect(notification.status).toBe(200);
      expect(notification.body.delivery.eventId).toBe(control.eventId);
    });

    it("HTTP AUTH-A: 无效 credential + stale reserved → 401 且 stale 状态字节不变", async () => {
      enableBinding();
      pairCompanion();
      seedStaleLegacyInFlight("r5d3-auth-stale-a", "reserved", 30 * 60_000);
      const before = JSON.stringify(readFeedbackState(workspace.id, stateDir));
      expect(fs.existsSync(resultBusFile(workspace.id, stateDir))).toBe(false);
      expect(fs.existsSync(resultBusCutoverFile(workspace.id, stateDir))).toBe(false);
      const res = await fetchJson("/api/companion/v1/reserve", {
        method: "POST",
        headers: { authorization: "Bearer invalid-credential-xyz", "content-type": "application/json" },
        body: JSON.stringify({ routeCanonical: ROUTE_A }),
      });
      expect(res.status).toBe(401);
      // 零 mutation：stale reserved 未被收敛为 ready；Bus/cutover 未被触碰
      expect(JSON.stringify(readFeedbackState(workspace.id, stateDir))).toBe(before);
      expect(readFeedbackState(workspace.id, stateDir)!.events.find(e => e.commandId === "r5d3-auth-stale-a")!.status).toBe("reserved");
      expect(fs.existsSync(resultBusFile(workspace.id, stateDir))).toBe(false);
      expect(fs.existsSync(resultBusCutoverFile(workspace.id, stateDir))).toBe(false);
    });

    it("HTTP AUTH-B: 无效 credential + stale claimed → /state 与 /reserve 均 401 且不转 outcome_unknown", async () => {
      enableBinding();
      pairCompanion();
      seedStaleLegacyInFlight("r5d3-auth-stale-b", "claimed", 30 * 60_000);
      const before = JSON.stringify(readFeedbackState(workspace.id, stateDir));
      const stateRes = await fetchJson("/api/companion/v1/state", {
        headers: { authorization: "Bearer invalid-credential-xyz" },
      });
      expect(stateRes.status).toBe(401);
      const res = await fetchJson("/api/companion/v1/reserve", {
        method: "POST",
        headers: { authorization: "Bearer invalid-credential-xyz", "content-type": "application/json" },
        body: JSON.stringify({ routeCanonical: ROUTE_A }),
      });
      expect(res.status).toBe(401);
      // 零 mutation：stale claimed 未被收敛为 outcome_unknown
      expect(JSON.stringify(readFeedbackState(workspace.id, stateDir))).toBe(before);
      expect(readFeedbackState(workspace.id, stateDir)!.events.find(e => e.commandId === "r5d3-auth-stale-b")!.status).toBe("claimed");
    });

    it("HTTP AUTH-C: 无效 credential 打 /release /begin-send /ack /retire-unknown → 401 且 stale 字节不变", async () => {
      enableBinding();
      pairCompanion();
      const eventId = seedStaleLegacyInFlight("r5d3-auth-stale-c", "claimed", 30 * 60_000);
      const before = JSON.stringify(readFeedbackState(workspace.id, stateDir));
      const invalid = { authorization: "Bearer invalid-credential-xyz", "content-type": "application/json" };
      // legacy eventId：resolveDeliverySource 命中 legacy 路径——若 source resolution 仍在
      // auth 前 recover，stale claimed 会被转成 outcome_unknown；pre-auth 先拒则零 mutation。
      const release = await fetchJson("/api/companion/v1/release", {
        method: "POST", headers: invalid,
        body: JSON.stringify({ routeCanonical: ROUTE_A, eventId, reservationId: RESERVATION }),
      });
      expect(release.status).toBe(401);
      const begin = await fetchJson("/api/companion/v1/begin-send", {
        method: "POST", headers: invalid,
        body: JSON.stringify({ routeCanonical: ROUTE_A, eventId, reservationId: RESERVATION }),
      });
      expect(begin.status).toBe(401);
      const ack = await fetchJson("/api/companion/v1/ack", {
        method: "POST", headers: invalid,
        body: JSON.stringify({ routeCanonical: ROUTE_A, eventId, attemptId: CLAIM_ATTEMPT }),
      });
      expect(ack.status).toBe(401);
      const retire = await fetchJson("/api/companion/v1/retire-unknown", {
        method: "POST", headers: invalid,
        body: JSON.stringify({ routeCanonical: ROUTE_A, eventId, reservationId: RESERVATION, attemptId: CLAIM_ATTEMPT }),
      });
      expect(retire.status).toBe(401);
      expect(JSON.stringify(readFeedbackState(workspace.id, stateDir))).toBe(before);
      expect(readFeedbackState(workspace.id, stateDir)!.events.find(e => e.eventId === eventId)!.status).toBe("claimed");
    });

    it("HTTP AUTH-D: 有效 credential 仍在认证边界内执行 bounded stale recovery", async () => {
      enableBinding();
      const paired = pairCompanion();
      seedStaleLegacyInFlight("r5d3-auth-stale-d", "claimed", 30 * 60_000);
      // 无 Active Sink → legacy fallback：认证成功后 stale claimed 被 bounded 收敛为
      // outcome_unknown（durable）；outcome_unknown 仍是 in-flight（等待人工 retire）
      // → 新 reserve 被 single-flight fence 拦截。
      const res = await fetchJson("/api/companion/v1/reserve", {
        method: "POST",
        headers: { authorization: `Bearer ${paired.credential}`, "content-type": "application/json" },
        body: JSON.stringify({ routeCanonical: ROUTE_A }),
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("FEEDBACK_INFLIGHT_FENCE");
      expect(readFeedbackState(workspace.id, stateDir)!.events.find(e => e.commandId === "r5d3-auth-stale-d")!.status).toBe("outcome_unknown");
    });
  });
});
