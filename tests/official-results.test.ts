import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { makeTmpDir } from "./helpers.js";
import { cleanupStrict } from "./strict-teardown.js";
import { Workspace } from "../src/workspace/manager.js";
import { projectRemoteResult } from "../src/remote/results.js";
import type { RemoteTask } from "../src/remote/store.js";
import { setRemoteEnabled, updateRemote } from "../src/remote/store.js";
import { beginResultBusSend, markResultBusOutcomeUnknown } from "../src/result-bus/delivery-lifecycle.js";
import { renderCompletionNotification } from "../src/browser/completion-notification.js";
import { formatOfficialTurnMessage, productionFeedbackMessageSha256 } from "../src/feedback/message.js";
import { resultBusEntrySchema } from "../src/result-bus/schema.js";
import { readResultBus, resultBusFile } from "../src/result-bus/store.js";
import { officialResultSchema, OFFICIAL_TESTS_UNKNOWN } from "../src/result-bus/official-result.js";
import { resultBusCompanionReserve, resultBusCompanionBeginSend, resultBusCompanionAck,
  resultBusCompanionResult, resultBusCompanionState, resultBusDeliveryMessage, resultBusCompanionDeliveryId } from "../src/bridge/result-bus-delivery.js";
import { resolveConversationPrincipal } from "../src/mcp/conversation-principal.js";
import { enableReceiver } from "../src/feedback/receiver.js";
import { ensureFeedbackState, readFeedbackState } from "../src/feedback/state-store.js";
import { createPairingIntent, exchangePairingIntent, confirmRouteAttestation } from "../src/feedback/companion.js";
import { bindCurrentWebSink, projectChatgptRouteToWebSinkCandidate } from "../src/web-sink-control/index.js";
import { readCompanionOperations } from "../src/bridge/companion-operations.js";
import { readExecutionRecordsStrict } from "../src/execution/records.js";
import { previewCommandCleanup } from "../src/command-cleanup/service.js";

let stateDir: string, root: string, workspace: Workspace, oldState: string | undefined;
const route = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
beforeEach(() => {
  stateDir = makeTmpDir("official-result-state"); root = makeTmpDir("official-result-work");
  oldState = process.env.C2C_STATE_DIR; process.env.C2C_STATE_DIR = stateDir; workspace = new Workspace(root);
});
afterEach(async () => {
  if (oldState === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = oldState;
  await cleanupStrict(stateDir, root);
});
function task(): RemoteTask {
  const now = new Date().toISOString();
  return { taskId: randomUUID(), targetId: randomUUID(), threadId: randomUUID(), turnId: randomUUID(),
    workspaceId: workspace.id, commandId: "official-one", clientId: "client", kind: "ANALYZE", goal: "private task body",
    createdAt: now, updatedAt: now, completedAt: now, status: "completed", finalResponse: { text: "turn 结果，等待 Review", truncated: false } };
}
function pair() {
  const principal = resolveConversationPrincipal({ authInfo: { token: "fixture", clientId: "client", scopes: ["codex.feedback"] },
    _meta: { "openai/session": "official-fixture" } } as never);
  ensureFeedbackState(workspace.id, 0, stateDir);
  enableReceiver({ workspaceId: workspace.id, principal, widgetId: "fixture", stateDir });
  const intent = createPairingIntent({ workspaceId: workspace.id, principal, stateDir });
  const paired = exchangePairingIntent({ workspaceId: workspace.id, intentId: intent.intentId, secret: intent.secret, routeCanonical: route, stateDir });
  confirmRouteAttestation({ workspaceId: workspace.id, principal, challengeId: paired.routeAttestation.challengeId,
    challengeDigest: paired.routeAttestation.challengeDigest, stateDir });
  bindCurrentWebSink(workspace.id, projectChatgptRouteToWebSinkCandidate({ workspaceId: workspace.id, routeCanonical: route }));
  return { workspaceId: workspace.id, workspaceRoot: root, credential: paired.credential, routeCanonical: route, stateDir };
}

it("official projection is durable, replayable and cannot fabricate a Desktop receipt or test pass", () => {
  const t = task(); projectRemoteResult(workspace, t);
  const before = fs.readFileSync(resultBusFile(workspace.id), "utf8");
  projectRemoteResult(workspace, t);
  expect(fs.readFileSync(resultBusFile(workspace.id), "utf8")).toBe(before);
  const entry = readResultBus(workspace)!.entries[0];
  expect(entry.result).toMatchObject({ status: "completed", machineEvidence: { source: "codex_app_server", testsSummary: OFFICIAL_TESTS_UNKNOWN } });
  expect(readExecutionRecordsStrict(workspace.id)).toEqual([]);
  expect(before).not.toContain("desktopReceiptSha256");
  const message = resultBusDeliveryMessage(entry, randomUUID()).message;
  expect(message).toContain("STATE: TURN_ENDED"); expect(message).toContain("CHANGED_FILES: 未采集");
  expect(message).not.toContain("RESULT: ok");
  expect(() => projectRemoteResult(workspace, { ...t, finalResponse: { text: "drift", truncated: false } })).toThrow();
  expect(fs.readFileSync(resultBusFile(workspace.id), "utf8")).toBe(before);
});

it("official evidence rejects mismatched turn verdict, identity and corrupt digest", () => {
  projectRemoteResult(workspace, task());
  const entry = readResultBus(workspace)!.entries[0];
  expect(resultBusEntrySchema.safeParse({ ...entry, resultSha256: "f".repeat(64) }).success).toBe(false);
  const result = officialResultSchema.parse(entry.result);
  expect(officialResultSchema.safeParse({ ...result, status: "failed" }).success).toBe(false);
  expect(officialResultSchema.safeParse({ ...result, resultId: randomUUID() }).success).toBe(false);
  expect(officialResultSchema.safeParse({ ...result, machineEvidence: { ...result.machineEvidence, desktopReceiptSha256: "a".repeat(64) } }).success).toBe(false);
});

it("legacy task without target and queued cancellation do not invent turn results", () => {
  const t = task(); delete t.targetId; projectRemoteResult(workspace, t);
  projectRemoteResult(workspace, { ...task(), status: "cancelled", turnId: undefined });
  expect(readResultBus(workspace)).toBeNull();
});

it("workspace-authorized Companion receives another dispatch client's result with one frozen attempt", () => {
  const input = pair(); projectRemoteResult(workspace, { ...task(), clientId: "other-dispatch-client" });
  const reserved = resultBusCompanionReserve(input);
  expect(reserved.delivery).toMatchObject({ kind: "C2C_TURN_ENDED", source: "codex_app_server" });
  const reserve = { eventId: reserved.delivery!.eventId as string, reservationId: reserved.reservationId! };
  const begin = resultBusCompanionBeginSend({ ...input, ...reserve });
  expect(begin.signal).toMatchObject({ type: "execution_ended", version: 1, workspaceId: workspace.id, commandId: "official-one" });
  expect(begin).not.toHaveProperty("message");
  expect(JSON.stringify(begin)).not.toContain("turn 结果，等待 Review");
  expect(resultBusCompanionBeginSend({ ...input, ...reserve })).toEqual(begin);
  expect(() => resultBusCompanionBeginSend({ ...input, ...reserve, routeCanonical: "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222" })).toThrow();
  const read = resultBusCompanionResult({ ...input, commandId: "official-one", iteration: 1 });
  expect(read).toMatchObject({ source: "codex_app_server", status: "completed", testsSummary: OFFICIAL_TESTS_UNKNOWN });
  resultBusCompanionAck({ ...input, eventId: reserve.eventId, attemptId: begin.attemptId });
  resultBusCompanionAck({ ...input, eventId: reserve.eventId, attemptId: begin.attemptId });
  expect(readResultBus(workspace)!.entries).toHaveLength(1);
  expect(readResultBus(workspace)!.entries[0]).toMatchObject({ deliveryStatus: "observed", sendTarget: { canonicalUrl: route } });
  expect(readFeedbackState(workspace.id).events).toHaveLength(0);
  expect(() => resultBusCompanionState(input)).not.toThrow();
});

it("operations show official task lifecycle and skip Desktop IPC in official mode", async () => {
  const input = pair(), t = task();
  setRemoteEnabled(workspace, true, { deliveryMode: "official" });
  updateRemote(workspace.id, state => { state!.tasks.push(t); state!.controller = { pid: process.pid, instanceId: "fixture", heartbeatAt: Date.now(), appServer: "running" }; return { state: state!, result: null }; });
  projectRemoteResult(workspace, t);
  const inspect = vi.fn(async () => { throw new Error("Desktop must not be queried"); });
  const result = await readCompanionOperations(input, inspect);
  expect(inspect).not.toHaveBeenCalled();
  expect(result.executor).toMatchObject({ source: "codex_app_server", state: "idle" });
  expect(result.commands[0]).toMatchObject({ appServerTurn: { status: "completed", threadId: t.threadId }, executions: [], feedback: [{ status: "queued" }] });
  expect(JSON.stringify(result)).not.toContain("private task body");
  const context = vm.createContext({}); vm.runInContext(fs.readFileSync(path.resolve("browser-companion/operations/view.js"), "utf8"), context);
  const view = context.C2COperations.derive({ ok: true, snapshot: result });
  expect(view.rows[0].executionLabel).toContain("待 Review");
  expect(view.rows[0].executionLabel).toContain("测试结果未判定");
  expect(context.C2COperations.derive({ ok: true, snapshot: { ...result, commands: [{ ...result.commands[0],
    appServerTurn: { ...result.commands[0].appServerTurn, status: "cancelled" }, feedback: [] }] } }).rows[0].active).toBe(false);
  updateRemote(workspace.id, state => { state!.controller!.appServer = "starting"; return { state: state!, result: null }; });
  expect((await readCompanionOperations(input, inspect)).executor).toMatchObject({ state: "unknown", reason: "APP_SERVER_NOT_READY" });
  expect(() => previewCommandCleanup({ workspaceId: workspace.id, workspaceRoot: root, commandId: t.commandId, iteration: 1 })).toThrow("官方任务");
});


it.each(["completed", "failed", "cancelled"] as const)("官方 %s 只发结束信号且完整结果仍可读取", status => {
  const input = pair(), t = { ...task(), status };
  projectRemoteResult(workspace, t);
  const reserved = resultBusCompanionReserve(input);
  const begin = resultBusCompanionBeginSend({ ...input, eventId: reserved.delivery!.eventId as string,
    reservationId: reserved.reservationId! });
  expect(begin.signal).toEqual({ type: "execution_ended", version: 1, workspaceId: workspace.id,
    commandId: t.commandId, taskId: t.taskId, attemptId: begin.attemptId });
  expect(begin).not.toHaveProperty("message");
  expect(JSON.stringify(begin)).not.toMatch(/rawSummary|testsSummary|machineEvidence|finalResponse|turn 结果/);
  expect(begin.messageSha256).toBe(productionFeedbackMessageSha256(renderCompletionNotification(begin.signal)));
  const before = fs.readFileSync(resultBusFile(workspace.id), "utf8");
  const view = resultBusCompanionState(input);
  expect(view.inFlight).toMatchObject({ signal: begin.signal, messageSha256: begin.messageSha256 });
  expect(view.inFlight).not.toHaveProperty("message");
  expect(fs.readFileSync(resultBusFile(workspace.id), "utf8")).toBe(before);
  expect(resultBusCompanionResult({ ...input, commandId: t.commandId, iteration: 1 })).toMatchObject({
    source: "codex_app_server", status, taskId: t.taskId, rawSummary: "turn 结果，等待 Review", testsSummary: OFFICIAL_TESTS_UNKNOWN,
  });
});

it("历史官方 attempt 保持原正文/hash、claimed noWrite 和 unknown 重建，exact ACK仍可", () => {
  const input = pair(), t = task(); projectRemoteResult(workspace, t);
  const reserved = resultBusCompanionReserve(input);
  const reserve = { eventId: reserved.delivery!.eventId as string, reservationId: reserved.reservationId! };
  const begun = resultBusCompanionBeginSend({ ...input, ...reserve });
  const file = resultBusFile(workspace.id), state = JSON.parse(fs.readFileSync(file, "utf8"));
  delete state.entries[0].attempt.messageFormat;
  fs.writeFileSync(file, JSON.stringify(state));
  const bytes = fs.readFileSync(file, "utf8"), entry = readResultBus(workspace)!.entries[0]!;
  const oldMessage = formatOfficialTurnMessage({ workspaceId: workspace.id, result: officialResultSchema.parse(entry.result),
    eventId: resultBusCompanionDeliveryId(entry.busEntryId), attemptId: begun.attemptId });
  const delivery = { message: oldMessage, messageSha256: productionFeedbackMessageSha256(oldMessage) };
  const replay = beginResultBusSend(workspace, { busEntryId: entry.busEntryId, reservationId: reserve.reservationId });
  expect(replay).toMatchObject({ noWrite: true, entry: { attempt: { attemptId: begun.attemptId } } });
  expect(replay.entry.attempt).not.toHaveProperty("messageFormat");
  expect(resultBusDeliveryMessage(replay.entry, begun.attemptId)).toEqual(delivery);
  const adapterReplay = resultBusCompanionBeginSend({ ...input, ...reserve });
  expect(adapterReplay).toMatchObject(delivery);
  expect(adapterReplay).not.toHaveProperty("signal");
  expect(fs.readFileSync(file, "utf8")).toBe(bytes);
  markResultBusOutcomeUnknown(workspace, { busEntryId: entry.busEntryId, attemptId: begun.attemptId });
  expect(resultBusCompanionState(input).inFlight).toMatchObject(delivery);
  expect(resultBusDeliveryMessage(readResultBus(workspace)!.entries[0]!, begun.attemptId)).toEqual(delivery);
  expect(resultBusCompanionAck({ ...input, eventId: reserve.eventId, attemptId: begun.attemptId }).status).toBe("observed");
});
