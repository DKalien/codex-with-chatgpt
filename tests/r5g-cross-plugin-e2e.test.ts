import { requestHttp } from "./http-json.js";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { desktopIpc } from "../src/desktop/ipc.js";
import { bindDesktop, enableDesktop } from "../src/desktop/service.js";
import { desktopFile, readDesktop } from "../src/desktop/store.js";
import { recordDesktopResult } from "../src/desktop/result.js";
import { bindCurrentExecutor, readActiveExecutorBinding, readExecutorDispatchEntry } from "../src/executor-control/index.js";
import { executorDispatchFile } from "../src/executor-control/dispatch-store.js";
import { createMcpServer } from "../src/mcp/server.js";
import { resolveConversationPrincipal } from "../src/mcp/conversation-principal.js";
import { reconcileTrustedDesktopExecutionResult } from "../src/routing/execution-result-reconciler.js";
import { canonicalRoutingResultDigest } from "../src/routing/execution-result-digest.js";
import { listResultOutboxEntries, resultOutboxFile } from "../src/routing/result-outbox-store.js";
import { readRouting, routingFile } from "../src/routing/store.js";
import { readResultBus, resultBusFile } from "../src/result-bus/store.js";
import { markResultBusOutcomeUnknown } from "../src/result-bus/delivery-lifecycle.js";
import { confirmRouteAttestation, createPairingIntent } from "../src/feedback/companion.js";
import { enableReceiver } from "../src/feedback/receiver.js";
import { readFeedbackState } from "../src/feedback/store.js";
import { reconcileFeedbackOutbox } from "../src/feedback/projector.js";
import { applyProjection } from "../src/feedback/projection-store.js";
import { reserveNext } from "../src/feedback/delivery-lifecycle.js";
import { readActiveWebSinkBinding } from "../src/web-sink-control/index.js";
import { resultBusCompanionDeliveryId } from "../src/bridge/result-bus-delivery.js";
import { inspectCommandCleanupArtifacts } from "../src/command-cleanup/service.js";
import { readCleanupJournal } from "../src/command-cleanup/fence.js";
import { reconcileWorkspaceResultBus } from "../src/result-bus/service.js";
import { renderCompletionNotification } from "../browser-companion/completion-notification.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const ROUTE_A = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const ROUTE_B = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";
const THREAD = "01a00000-0000-7000-8000-000000000701";
const PROJECT = "r5g-project";
const TURN = "01a00000-0000-7000-8000-000000000702";
const COMMAND = "r5g_cross_plugin_command";
const MESSAGE = "R5g isolated production-chain task";
const receiptInput = {
  commandId: COMMAND, changedFiles: ["src/r5g.ts"], tests: "r5g focused passed",
  exitStatus: "ok" as const, rawSummary: "R5g isolated fake Desktop terminal receipt",
  command: "r5g isolated check", output: "r5g isolated output",
};
const fence = {
  desktopPid: 1001, desktopExe: "C:\\Program Files\\ChatGPT\\ChatGPT.exe", desktopCreation: "1000001",
  appServerPid: 1002, appServerExe: "C:\\Program Files\\ChatGPT\\codex.exe", appServerCreation: "1000002",
};

type Wire = { status: number; body: Record<string, any> };
type ToolResponse = { isError?: boolean; content: Array<{ text: string }> };

// 隔离 fixture 验证 Bridge HTTP 与持久状态；Desktop IPC 使用模拟适配器。
describe("R5g 隔离跨插件 Bridge HTTP 与持久状态链", () => {
  let stateDir: string;
  let wsRoot: string;
  let previousStateDir: string | undefined;
  let previousThread: string | undefined;
  let bridge: Bridge;
  let base: string;

  const principal = () => resolveConversationPrincipal({
    authInfo: { token: "r5g-planner-token", clientId: "r5g-client", scopes: ["codex.feedback"] } as never,
    _meta: { "openai/session": "r5g-planner-session" },
  });

  async function http(pathname: string, credential?: string, body?: Record<string, unknown>): Promise<Wire> {
    const response = await requestHttp(`${base}/api/companion/v1${pathname}`, {
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      },
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }

  function completionPayload(body: Wire["body"]) {
    expect(body).not.toHaveProperty("message");
    expect(body.signal).toEqual({ type: "execution_ended", version: 1, workspaceId: bridge.workspace.id,
      commandId: COMMAND, taskId: `desktop_${COMMAND}`, attemptId: body.attemptId });
    const message = renderCompletionNotification(body.signal);
    expect(body.messageSha256).toBe(createHash("sha256").update(message).digest("hex"));
    const { signal, ...normalized } = body;
    return { ...normalized, message };
  }

  async function pair(route: string, verify = true): Promise<string> {
    const intent = createPairingIntent({ workspaceId: bridge.workspace.id, principal: principal(), stateDir });
    const paired = await http("/pair", undefined, {
      intentId: intent.intentId, secret: intent.secret, routeCanonical: route,
    });
    expect(paired.status).toBe(200);
    if (verify) confirmRouteAttestation({
      workspaceId: bridge.workspace.id,
      principal: principal(),
      challengeId: paired.body.routeAttestation.challengeId,
      challengeDigest: paired.body.routeAttestation.challengeDigest,
      stateDir,
    });
    return paired.body.credential as string;
  }

  async function bindSink(route: string, credential: string) {
    const bound = await http("/web-sink/bind-current", credential, { routeCanonical: route });
    expect(bound.status).toBe(200);
    return bound.body.activeBinding as { bindingId: string; epoch: number; canonicalUrl: string };
  }

  async function sendViaRegisteredTool(bindingId: string, commandId = COMMAND, message = MESSAGE): Promise<ToolResponse> {
    const server = createMcpServer({
      workspace: bridge.workspace,
      logger: { info() {}, error() {}, warn() {}, debug() {} } as never,
      executorAuthorize: () => {},
    });
    const handler = (server as unknown as {
      _registeredTools: Record<string, { handler: (input: unknown, extra: unknown) => Promise<ToolResponse> }>;
    })._registeredTools.executor_send.handler;
    return handler({
      workspaceId: bridge.workspace.id, bindingId, commandId,
      intent: "development_plan", userConfirmed: true, message,
    }, {
      authInfo: { token: "r5g-planner-token", clientId: "r5g-client", scopes: ["codex.executor.control"] },
      _meta: { "openai/session": "r5g-planner-session" },
    });
  }

  async function prepareCanonical() {
    const sent = vi.fn(async (wire: string) => {
      expect(JSON.parse(wire)).toMatchObject({ type: "C2C_DESKTOP_TASK", commandId: COMMAND, message: MESSAGE });
      return { threadId: THREAD, turnId: TURN };
    });
    const close = vi.fn();
    vi.spyOn(desktopIpc, "discoverForBinding").mockResolvedValue({
      threadId: THREAD, hostId: "local", projectId: PROJECT, workspaceRoot: wsRoot,
      cwd: wsRoot, title: "R5g fake Desktop boundary", runtimeFence: fence,
    } as never);
    vi.spyOn(desktopIpc, "prepare").mockResolvedValue({ send: sent, close } as never);
    const desktopBinding = await bindDesktop(bridge.workspace, { threadId: THREAD, hostId: "local", projectId: PROJECT });
    enableDesktop(bridge.workspace, desktopBinding.bindingId);
    const executorA = bindCurrentExecutor(bridge.workspace.id, wsRoot, {
      pluginId: "codex-desktop", workspaceId: bridge.workspace.id, workspaceRoot: wsRoot,
      instanceId: "local", sessionId: THREAD, locator: { executorProjectId: PROJECT },
    });
    const accepted = await sendViaRegisteredTool(executorA.binding.bindingId);
    expect(accepted.isError).toBeFalsy();
    expect(JSON.parse(accepted.content[0]!.text)).toMatchObject({ deliveryStatus: "accepted", commandId: COMMAND });
    expect(sent).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    const delivery = readDesktop(bridge.workspace.id)!.deliveries[0]!;
    vi.spyOn(desktopIpc, "currentResultContext").mockResolvedValue({
      threadId: THREAD, hostId: "local", projectId: PROJECT, workspaceRoot: wsRoot,
      title: "R5g terminal", cwd: wsRoot, runtimeStatus: "idle", resultTurnId: TURN,
      resultTurnStatus: "completed",
    } as never);
    vi.spyOn(desktopIpc, "currentResultOwnership").mockResolvedValue({
      threadId: THREAD, workspaceRoot: wsRoot, resultTurnId: TURN,
      ownership: "origin", originTurnId: TURN, originAlias: null,
      deliveryId: delivery.deliveryId, chainTurnIds: [TURN], chainLength: 0,
      chainSignatures: [], signature: null,
    } as never);
    const receipt = await recordDesktopResult(bridge.workspace, receiptInput);
    expect(receipt.record.commandId).toBe(COMMAND);
    const reconciled = reconcileTrustedDesktopExecutionResult(bridge.workspace, COMMAND);
    expect(reconciled.status).toBe("reconciled");
    if (reconciled.status !== "reconciled") throw new Error("canonical result reconciliation failed");
    expect(reconciled.resultBus).toEqual({ projected: 1, replayed: 0 });
    return { sent, close, executorA, receipt };
  }

  beforeEach(async () => {
    previousStateDir = process.env.C2C_STATE_DIR;
    previousThread = process.env.CODEX_THREAD_ID;
    stateDir = isolateStateDir();
    wsRoot = makeTmpDir("r5g-cross-plugin-ws");
    bridge = await startBridge({
      workspaceRoot: wsRoot, port: 0, persistRuntime: false, runtimeBuildId: null,
      authStoreFile: path.join(stateDir, "auth", "r5g-test.json"),
    });
    base = bridge.localBaseUrl();
    reconcileFeedbackOutbox(bridge.workspace.id, stateDir);
    enableReceiver({ workspaceId: bridge.workspace.id, principal: principal(), widgetId: "r5g", stateDir });
    process.env.CODEX_THREAD_ID = THREAD;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await bridge.close();
    if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousStateDir;
    if (previousThread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = previousThread;
    cleanup(wsRoot);
    cleanup(stateDir);
  });

  it("MCP→Desktop receipt→canonical Bus→Bridge HTTP begin-send/ACK，Desktop 派发重放保持幂等", async () => {
    const { sent, close, executorA, receipt } = await prepareCanonical();
    expect(close).toHaveBeenCalledTimes(1);
    expect(readDesktop(bridge.workspace.id)?.deliveries).toHaveLength(1);
    expect(readExecutorDispatchEntry(bridge.workspace.id, COMMAND, stateDir)?.target.bindingId).toBe(executorA.binding.bindingId);

    const executorB = bindCurrentExecutor(bridge.workspace.id, wsRoot, {
      pluginId: "codex-desktop", workspaceId: bridge.workspace.id, workspaceRoot: wsRoot,
      instanceId: "local", sessionId: randomUUID(), locator: { executorProjectId: PROJECT },
    });
    expect(executorB.binding.bindingId).not.toBe(executorA.binding.bindingId);
    expect(readExecutorDispatchEntry(bridge.workspace.id, COMMAND, stateDir)?.target.bindingId).toBe(executorA.binding.bindingId);
    const dispatchBeforeReplay = fs.readFileSync(executorDispatchFile(bridge.workspace.id, stateDir), "utf8");
    const desktopBeforeReplay = fs.readFileSync(desktopFile(bridge.workspace.id), "utf8");
    const replay = await sendViaRegisteredTool(executorA.binding.bindingId);
    expect(JSON.parse(replay.content[0]!.text)).toMatchObject({ deliveryStatus: "accepted", commandId: COMMAND });
    expect(sent).toHaveBeenCalledTimes(1);
    const changedTarget = await sendViaRegisteredTool(executorB.binding.bindingId);
    expect(changedTarget.isError).toBe(true);
    expect(JSON.parse(changedTarget.content[0]!.text).error).toBe("EXECUTOR_COMMAND_PINNED");
    const driftedPayload = await sendViaRegisteredTool(executorA.binding.bindingId, COMMAND, `${MESSAGE} drift`);
    expect(driftedPayload.isError).toBe(true);
    expect(JSON.parse(driftedPayload.content[0]!.text).error).toBe("EXECUTOR_DISPATCH_IDENTITY_MISMATCH");
    expect(fs.readFileSync(executorDispatchFile(bridge.workspace.id, stateDir), "utf8")).toBe(dispatchBeforeReplay);
    expect(fs.readFileSync(desktopFile(bridge.workspace.id), "utf8")).toBe(desktopBeforeReplay);
    expect(sent).toHaveBeenCalledTimes(1);

    const routing = readRouting(bridge.workspace)!;
    expect(routing.results.filter(result => result.commandId === COMMAND)).toHaveLength(1);
    const result = routing.results.find(item => item.commandId === COMMAND)!;
    if (!("machineEvidence" in result)) throw new Error("canonical machine evidence missing");
    expect(result.machineEvidence).toMatchObject({
      desktopReceiptSha256: receipt.record.desktopReceiptSha256,
      originTurnId: TURN, resultTurnId: TURN, bindingId: readDesktop(bridge.workspace.id)!.binding!.bindingId,
    });
    const outbox = listResultOutboxEntries(bridge.workspace).filter(entry => entry.commandId === COMMAND);
    expect(outbox).toEqual([]);
    const bus = readResultBus(bridge.workspace, stateDir)!;
    expect(bus.entries.filter(entry => entry.commandId === COMMAND)).toHaveLength(1);
    expect(bus.entries[0]!.deliveryStatus).toBe("queued");
    expect(bus.entries[0]!.resultSha256).toBe(canonicalRoutingResultDigest(result));
    expect(readFeedbackState(bridge.workspace.id, stateDir)?.events.filter(event => event.commandId === COMMAND && event.kind === "C2C_EXECUTED")).toHaveLength(0);

    const credential = await pair(ROUTE_A);
    expect((await http("/state", credential)).status).toBe(200);
    const sinkA = await bindSink(ROUTE_A, credential);
    expect(sinkA.bindingId).not.toBe(executorA.binding.bindingId);
    expect(readActiveExecutorBinding(bridge.workspace.id, wsRoot)?.bindingId).toBe(executorB.binding.bindingId);
    const reserved = await http("/reserve", credential, { routeCanonical: ROUTE_A });
    expect(reserved.status).toBe(200);
    expect(reserved.body.delivery.commandId).toBe(COMMAND);
    const eventId = reserved.body.delivery.eventId as string;
    const reservationId = reserved.body.reservationId as string;
    expect(eventId).toBe(resultBusCompanionDeliveryId(bus.entries[0]!.busEntryId));

    const claimed = await http("/begin-send", credential, { eventId, reservationId, routeCanonical: ROUTE_A });
    expect(claimed.status).toBe(200);
    const claimedMessage = completionPayload(claimed.body).message;
    const claimedMessageSha256 = claimed.body.messageSha256 as string;
    const terminalWitness = claimed.body.terminalWitness as string;
    const attemptId = claimed.body.attemptId as string;
    const frozenTarget = readResultBus(bridge.workspace, stateDir)!.entries[0]!.sendTarget;
    const ack = await http("/ack", credential, { eventId, attemptId, routeCanonical: ROUTE_A, terminalWitness });
    expect(ack.status).toBe(200);
    const ackBody = ack.body;
    expect(claimedMessage).not.toContain(receipt.record.rawSummary);
    expect(claimedMessageSha256).toBe(createHash("sha256").update(claimedMessage).digest("hex"));
    expect(ackBody).toMatchObject({ status: "observed", cleanupStatus: "cleaned" });
    expect(frozenTarget).toMatchObject({ bindingId: sinkA.bindingId, canonicalUrl: ROUTE_A });
    const cleanupTarget = { workspaceId: bridge.workspace.id, workspaceRoot: wsRoot, commandId: COMMAND, iteration: 1, stateDir };
    expect(inspectCommandCleanupArtifacts(cleanupTarget)).toEqual([]);
    expect(readCleanupJournal(bridge.workspace.id, COMMAND, stateDir)).toBeNull();
    expect(readDesktop(bridge.workspace.id)!.binding).not.toBeNull();
    expect(readActiveExecutorBinding(bridge.workspace.id, wsRoot)?.bindingId).toBe(executorB.binding.bindingId);
    expect(readActiveWebSinkBinding(bridge.workspace.id)?.bindingId).toBe(sinkA.bindingId);
    expect(fs.existsSync(path.join(stateDir, "execution-outputs", bridge.workspace.id, "bodies", `${receipt.record.outputId}.txt`))).toBe(false);
    const bytes = fs.readFileSync(resultBusFile(bridge.workspace.id, stateDir), "utf8");
    const duplicateAck = await http("/ack", credential, {
      routeCanonical: ROUTE_A, eventId, attemptId, terminalWitness,
    });
    expect(duplicateAck).toMatchObject({ status: 200, body: { status: "terminal_gone", attemptId } });
    expect((await http("/ack", credential, { routeCanonical: ROUTE_A, eventId, attemptId })).status).not.toBe(200);
    expect((await http("/ack", credential, { routeCanonical: ROUTE_A, eventId, attemptId: randomUUID(), terminalWitness })).status).not.toBe(200);
    expect(fs.readFileSync(resultBusFile(bridge.workspace.id, stateDir), "utf8")).toBe(bytes);
    expect((await http("/reserve", credential, { routeCanonical: ROUTE_A })).body.error).toBe("FEEDBACK_NO_READY_EVENT");
    await expect(recordDesktopResult(bridge.workspace, receiptInput)).rejects.toThrow();
    expect(reconcileWorkspaceResultBus(bridge.workspace, stateDir)).toEqual({ projected: 0, replayed: 0 });
    reconcileFeedbackOutbox(bridge.workspace.id, stateDir, wsRoot);
    expect(inspectCommandCleanupArtifacts(cleanupTarget)).toEqual([]);
    expect(fs.readFileSync(resultBusFile(bridge.workspace.id, stateDir), "utf8")).toBe(bytes);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("未验证/无 Sink 不投递；stale reservation 重新排队；claimed 冻结目标拒绝 B 路由取消息或 ACK", async () => {
    const { executorA } = await prepareCanonical();
    const unverified = await pair(ROUTE_A, false);
    expect((await http("/web-sink/bind-current", unverified, { routeCanonical: ROUTE_A })).status).toBe(409);
    expect(readActiveWebSinkBinding(bridge.workspace.id)).toBeNull();
    const unverifiedReserve = await http("/reserve", unverified, { routeCanonical: ROUTE_A });
    expect(unverifiedReserve.status).not.toBe(200);
    expect(readResultBus(bridge.workspace, stateDir)!.entries[0]!.deliveryStatus).toBe("queued");

    const credentialA = await pair(ROUTE_A);
    expect(readActiveWebSinkBinding(bridge.workspace.id)).toBeNull();
    const noSink = await http("/reserve", credentialA, { routeCanonical: ROUTE_A });
    expect(noSink.status).not.toBe(200);
    expect(readResultBus(bridge.workspace, stateDir)!.entries[0]!.deliveryStatus).toBe("queued");
    const sinkA = await bindSink(ROUTE_A, credentialA);
    const reservedA = await http("/reserve", credentialA, { routeCanonical: ROUTE_A });
    expect(reservedA.status).toBe(200);
    const eventId = reservedA.body.delivery.eventId as string;
    const reservationIdA = reservedA.body.reservationId as string;
    expect(readResultBus(bridge.workspace, stateDir)!.entries[0]!.reservation?.bindingId).toBe(sinkA.bindingId);
    const firstBytes = fs.readFileSync(resultBusFile(bridge.workspace.id, stateDir), "utf8");
    const sameReserve = await http("/reserve", credentialA, { routeCanonical: ROUTE_A });
    expect(sameReserve).toMatchObject({ status: 200, body: { reservationId: reservationIdA, delivery: { eventId } } });
    expect((await http("/state", credentialA)).body.inFlight).toMatchObject({
      status: "reserved", eventId, reservationId: reservationIdA,
    });
    expect(fs.readFileSync(resultBusFile(bridge.workspace.id, stateDir), "utf8")).toBe(firstBytes);

    const credentialB = await pair(ROUTE_B);
    const sinkB = await bindSink(ROUTE_B, credentialB);
    expect(sinkB.bindingId).not.toBe(sinkA.bindingId);
    expect(readActiveExecutorBinding(bridge.workspace.id, wsRoot)?.bindingId).toBe(executorA.binding.bindingId);
    const beforeStale = fs.readFileSync(resultBusFile(bridge.workspace.id, stateDir), "utf8");
    const blockedReserve = await http("/reserve", credentialB, { routeCanonical: ROUTE_B });
    expect(blockedReserve.status).toBe(409);
    expect(blockedReserve.body.error).toBe("RESULT_BUS_STALE_RESERVATION");
    expect(blockedReserve.body).not.toHaveProperty("delivery");
    expect(blockedReserve.body).not.toHaveProperty("reservationId");
    expect(JSON.stringify(blockedReserve.body)).not.toContain(eventId);
    expect(JSON.stringify(blockedReserve.body)).not.toContain(reservationIdA);
    expect(JSON.stringify(blockedReserve.body)).not.toContain(receiptInput.rawSummary);
    expect((await http("/state", credentialB)).body.inFlight).toEqual({
      status: "reserved", pinnedToOtherRoute: true,
    });
    expect(fs.readFileSync(resultBusFile(bridge.workspace.id, stateDir), "utf8")).toBe(beforeStale);
    const stale = await http("/begin-send", credentialB, {
      routeCanonical: ROUTE_B, eventId, reservationId: reservationIdA,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("RESULT_BUS_STALE_RESERVATION");
    expect(readResultBus(bridge.workspace, stateDir)!.entries[0]).toMatchObject({
      deliveryStatus: "queued", reservation: null, attempt: null, sendTarget: null,
    });
    const reservedB = await http("/reserve", credentialB, { routeCanonical: ROUTE_B });
    expect(reservedB.status).toBe(200);
    expect(reservedB.body.delivery.eventId).toBe(eventId);
    expect(reservedB.body.reservationId).not.toBe(reservationIdA);
    expect(readResultBus(bridge.workspace, stateDir)!.entries[0]!.reservation).toMatchObject({
      reservationId: reservedB.body.reservationId,
      bindingId: sinkB.bindingId, epoch: sinkB.epoch, boundAt: readActiveWebSinkBinding(bridge.workspace.id)!.boundAt,
    });
    const claimedB = await http("/begin-send", credentialB, {
      routeCanonical: ROUTE_B, eventId, reservationId: reservedB.body.reservationId,
    });
    expect(claimedB).toMatchObject({ status: 200, body: { status: "claimed" } });
    expect(completionPayload(claimedB.body).message.split("\n").at(-1)).toBe(`ATTEMPT_ID: ${claimedB.body.attemptId}`);
    const frozen = readResultBus(bridge.workspace, stateDir)!.entries[0]!;
    expect(frozen.sendTarget?.bindingId).toBe(sinkB.bindingId);
    expect(frozen.sendTarget?.canonicalUrl).toBe(ROUTE_B);

    const credentialA2 = await pair(ROUTE_A);
    await bindSink(ROUTE_A, credentialA2);
    expect(readActiveExecutorBinding(bridge.workspace.id, wsRoot)?.bindingId).toBe(executorA.binding.bindingId);
    expect((await http("/state", credentialA2)).body.inFlight).toMatchObject({ status: "claimed", pinnedToOtherRoute: true });
    const bytes = fs.readFileSync(resultBusFile(bridge.workspace.id, stateDir), "utf8");
    const wrongReserve = await http("/reserve", credentialA2, { routeCanonical: ROUTE_A });
    expect(wrongReserve).toMatchObject({ status: 400, body: { error: "RESULT_BUS_FROZEN_TARGET_MISMATCH" } });
    expect(wrongReserve.body).not.toHaveProperty("delivery");
    expect(wrongReserve.body).not.toHaveProperty("reservationId");
    expect(JSON.stringify(wrongReserve.body)).not.toContain(claimedB.body.messageSha256);
    const wrongBegin = await http("/begin-send", credentialA2, {
      routeCanonical: ROUTE_A, eventId, reservationId: reservedB.body.reservationId,
    });
    expect(wrongBegin.body.error).toBe("RESULT_BUS_FROZEN_TARGET_MISMATCH");
    const wrongAck = await http("/ack", credentialA2, {
      routeCanonical: ROUTE_A, eventId, attemptId: claimedB.body.attemptId,
    });
    expect(wrongAck.body.error).toBe("RESULT_BUS_FROZEN_TARGET_MISMATCH");
    expect(fs.readFileSync(resultBusFile(bridge.workspace.id, stateDir), "utf8")).toBe(bytes);
    expect(readResultBus(bridge.workspace, stateDir)!.entries[0]!.deliveryStatus).toBe("claimed");
  });

  it("Bridge outcome_unknown 持久状态保留冻结目标；切 Sink 后 HTTP state/reserve 不暴露结果", async () => {
    await prepareCanonical();
    const credentialB = await pair(ROUTE_B);
    const sinkB = await bindSink(ROUTE_B, credentialB);
    const reserved = await http("/reserve", credentialB, { routeCanonical: ROUTE_B });
    expect(reserved.status).toBe(200);
    const eventId = reserved.body.delivery.eventId as string;
    const reservationId = reserved.body.reservationId as string;
    const claimed = await http("/begin-send", credentialB, { routeCanonical: ROUTE_B, eventId, reservationId });
    expect(claimed.status).toBe(200);
    const claimedPayload = completionPayload(claimed.body);
    const beforeUnknown = readResultBus(bridge.workspace, stateDir)!.entries[0]!;
    const marked = markResultBusOutcomeUnknown(bridge.workspace, {
      busEntryId: beforeUnknown.busEntryId, attemptId: claimed.body.attemptId,
    }, {}, stateDir);
    expect(marked.entry).toMatchObject({
      deliveryStatus: "outcome_unknown", reservation: beforeUnknown.reservation,
      attempt: beforeUnknown.attempt, sendTarget: beforeUnknown.sendTarget,
    });
    const serverState = await http("/state", credentialB);
    expect(serverState.body.inFlight).toMatchObject({
      status: "outcome_unknown", eventId, reservationId,
      attemptId: claimed.body.attemptId, signal: claimed.body.signal,
      messageSha256: claimed.body.messageSha256,
    });
    const credentialA = await pair(ROUTE_A);
    await bindSink(ROUTE_A, credentialA);
    expect((await http("/state", credentialA)).body.inFlight).toMatchObject({
      status: "outcome_unknown", pinnedToOtherRoute: true,
    });
    const before = fs.readFileSync(resultBusFile(bridge.workspace.id, stateDir), "utf8");
    const wrongReserve = await http("/reserve", credentialA, { routeCanonical: ROUTE_A });
    expect(wrongReserve).toMatchObject({ status: 400, body: { error: "RESULT_BUS_FROZEN_TARGET_MISMATCH" } });
    expect(wrongReserve.body).not.toHaveProperty("delivery");
    expect(wrongReserve.body).not.toHaveProperty("reservationId");
    expect(JSON.stringify(wrongReserve.body)).not.toContain(claimed.body.messageSha256);
    expect(fs.readFileSync(resultBusFile(bridge.workspace.id, stateDir), "utf8")).toBe(before);
    expect(readResultBus(bridge.workspace, stateDir)!.entries[0]).toMatchObject({
      deliveryStatus: "outcome_unknown", sendTarget: beforeUnknown.sendTarget,
    });
  });

  it("Bus 与 legacy 同时 durable in-flight 时 /state 和 /reserve 拒绝迁移冲突", async () => {
    await prepareCanonical();
    const credential = await pair(ROUTE_A);
    await bindSink(ROUTE_A, credential);
    const reserved = await http("/reserve", credential, { routeCanonical: ROUTE_A });
    expect(reserved.status).toBe(200);
    const claimed = await http("/begin-send", credential, {
      routeCanonical: ROUTE_A, eventId: reserved.body.delivery.eventId,
      reservationId: reserved.body.reservationId,
    });
    expect(claimed.status).toBe(200);
    const feedback = readFeedbackState(bridge.workspace.id, stateDir)!;
    const now = new Date().toISOString();
    applyProjection({
      workspaceId: bridge.workspace.id, stateDir, nextCursor: feedback.projectionCursor,
      newEvents: [{
        version: 1, eventId: randomUUID().replaceAll("-", ""), kind: "C2C_EXECUTED",
        workspaceId: bridge.workspace.id, source: "desktop", commandId: "legacy-inflight",
        taskId: "desktop_legacy-inflight", iteration: 1, result: "ok",
        changedFilesSummary: [], testsSummary: "", outputAvailable: false,
        occurredAt: now, createdAt: now, updatedAt: now,
        targetBindingId: null, targetEpoch: null, targetPrincipalFingerprint: null,
        status: "queued",
      } as never],
    });
    reconcileFeedbackOutbox(bridge.workspace.id, stateDir, wsRoot);
    const companion = readFeedbackState(bridge.workspace.id, stateDir)!.companion!;
    const legacyReserved = reserveNext({
      workspaceId: bridge.workspace.id, bindingId: companion.bindingId, epoch: companion.epoch,
      principalFingerprint: companion.principalFingerprint, companionId: companion.companionId,
      stateDir,
    });
    expect(legacyReserved.event.status).toBe("reserved");
    const before = fs.readFileSync(resultBusFile(bridge.workspace.id, stateDir), "utf8");
    const state = await http("/state", credential);
    expect(state.body.error).toBe("RESULT_BUS_CUTOVER_INFLIGHT_CONFLICT");
    const reserve = await http("/reserve", credential, { routeCanonical: ROUTE_A });
    expect(reserve.body.error).toBe("RESULT_BUS_CUTOVER_INFLIGHT_CONFLICT");
    expect(reserve.body).not.toHaveProperty("delivery");
    expect(fs.readFileSync(resultBusFile(bridge.workspace.id, stateDir), "utf8")).toBe(before);
    expect(readResultBus(bridge.workspace, stateDir)!.entries[0]!.deliveryStatus).toBe("claimed");
  });

  it("Bus 与 legacy 兼容 eventId 碰撞时真实 HTTP 预约 fail closed 且 Bus 不变", async () => {
    await prepareCanonical();
    const credential = await pair(ROUTE_A);
    await bindSink(ROUTE_A, credential);
    const entry = readResultBus(bridge.workspace, stateDir)!.entries[0]!;
    const eventId = resultBusCompanionDeliveryId(entry.busEntryId);
    const before = fs.readFileSync(resultBusFile(bridge.workspace.id, stateDir), "utf8");
    const feedback = readFeedbackState(bridge.workspace.id, stateDir)!;
    applyProjection({
      workspaceId: bridge.workspace.id, stateDir, nextCursor: feedback.projectionCursor,
      newEvents: [{
        version: 1, eventId, kind: "C2C_EXECUTED", workspaceId: bridge.workspace.id,
        source: "desktop", commandId: "legacy-collision", taskId: "desktop_legacy-collision", iteration: 1,
        result: "ok", changedFilesSummary: [], testsSummary: "", outputAvailable: false,
        occurredAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        targetBindingId: null, targetEpoch: null, targetPrincipalFingerprint: null, status: "queued",
      } as never],
    });
    const collision = await http("/reserve", credential, { routeCanonical: ROUTE_A });
    expect(collision.body.error).toBe("RESULT_BUS_DELIVERY_ID_CONFLICT");
    expect(fs.readFileSync(resultBusFile(bridge.workspace.id, stateDir), "utf8")).toBe(before);
    expect(readResultBus(bridge.workspace, stateDir)!.entries[0]).toMatchObject({ deliveryStatus: "queued", reservation: null });
  });
});
