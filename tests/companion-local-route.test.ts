import fs from "node:fs";
import path from "node:path";
import { readResultBus, resultBusFile } from "../src/result-bus/store.js";
import { resultBusEntryId, resultBusStateSchema } from "../src/result-bus/schema.js";
import { OFFICIAL_TESTS_UNKNOWN, resultBusResultDigest, type OfficialResult } from "../src/result-bus/official-result.js";
import { freezeActiveWebSinkTarget } from "../src/web-sink-control/service.js";
import { randomUUID } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { appendResult, createCommand, registerRoute } from "../src/routing/store.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";
import { readFeedbackState, writeState, feedbackStateFile } from "../src/feedback/state-store.js";
import { isRouteAttestationVerified, isWebSinkRouteVerified, type FeedbackState } from "../src/feedback/schema.js";
import { sha256Hex } from "../src/feedback/companion-common.js";
import { verifyCompanionCredential } from "../src/feedback/companion-delivery.js";
import { verifyCompanionCredentialForWebSink, bindCurrentWebSinkFromDurableCompanion } from "../src/web-sink-control/companion-adapter.js";
import { bindCurrentWebSink } from "../src/web-sink-control/service.js";
import { projectChatgptRouteToWebSinkCandidate } from "../src/web-sink-control/chatgpt-surface.js";
import { requestLocalRoute, finishLocalRouteConfirmation, commitLocalRoute, localRouteStatus, LOCAL_ROUTE_TTL_MS } from "../src/bridge/companion-local-route.js";
import { createCompanionRouter } from "../src/bridge/companion.js";
import { requestJson } from "./http-json.js";
import { grantPanelActions } from "../src/feedback/panel.js";

const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn() }));
vi.mock("../src/feedback/local-route-confirm.js", () => ({ confirmLocalRoute: confirmMock }));
const A = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const B = "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222";
let stateDir: string;
let root: string;
let workspaceId: string;
let server: Server | undefined;
const credential = "c2c_comp_original-test-credential";
const input = () => ({ workspaceId, workspaceRoot: root, credential, requestId: randomUUID(), routeCanonical: B, stateDir });
function edit(change: (state: FeedbackState) => FeedbackState) { writeState(workspaceId, stateDir, change(readFeedbackState(workspaceId, stateDir))); }

beforeEach(() => {
  stateDir = isolateStateDir(); root = makeTmpDir("local-route"); workspaceId = new Workspace(root).id;
  const bindingId = randomUUID(); const now = new Date().toISOString();
  writeState(workspaceId, stateDir, { version: 1, workspaceId, projectionCursor: 0, events: [],
    binding: { version: 1, bindingId, epoch: 1, principalFingerprint: "a".repeat(32), clientId: "client", widgetId: "widget", enabledAt: now, status: "active" },
    companion: { version: 1, companionId: randomUUID(), bindingId, epoch: 1, principalFingerprint: "a".repeat(32),
      credentialHash: sha256Hex(credential), routeCanonical: A, pairedAt: now },
    pairingIntent: null, rebindIntent: null, rebindPredecessor: null });
  confirmMock.mockReset();
});
afterEach(async () => {
  vi.useRealTimers();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined; cleanup(stateDir); cleanup(root);
});

describe("本机 route 的单次授权", () => {
  it("确认前不轮换；commit产生新credential/challenge且只授权WebSink", () => {
    const req = input(); const before = readFeedbackState(workspaceId, stateDir);
    const pending = requestLocalRoute(req);
    expect(pending.response.state).toBe("PENDING");
    expect(readFeedbackState(workspaceId, stateDir).companion).toEqual(before.companion);
    expect(() => commitLocalRoute(req)).toThrow(/尚未取得/);
    finishLocalRouteConfirmation(req, true);
    const candidate = localRouteStatus(req).candidatePairing!;
    expect(() => verifyCompanionCredentialForWebSink({ ...req, credential: candidate.credential })).toThrow(/无效/);
    const result = commitLocalRoute(req); const pair = result.pairing!;
    expect(pair).toEqual(candidate);
    expect(result.state).toBe("COMMITTED"); expect(pair.credential).not.toBe(credential);
    expect(pair.companionId).not.toBe(before.companion!.companionId);
    const state = readFeedbackState(workspaceId, stateDir);
    expect(state.binding).toEqual(before.binding);
    expect(state.companion!.routeAttestation!.proofKind).toBe("local_user");
    expect(isWebSinkRouteVerified(state.companion)).toBe(true);
    expect(isRouteAttestationVerified(state.companion)).toBe(false);
    expect(() => verifyCompanionCredential({ ...req, credential: pair.credential })).toThrow(/principal/);
    expect(() => verifyCompanionCredentialForWebSink(req)).toThrow(/无效/);
    expect(verifyCompanionCredentialForWebSink({ ...req, credential: pair.credential }).routeCanonical).toBe(B);
    expect(bindCurrentWebSinkFromDurableCompanion({ ...req, credential: pair.credential }).binding.canonicalUrl).toBe(B);
    expect(localRouteStatus(req).pairing).toEqual(pair);
    expect(localRouteStatus({ ...req, credential: pair.credential }).pairing).toEqual(pair);
    expect(fs.readFileSync(feedbackStateFile(workspaceId, stateDir), "utf8")).not.toContain(pair.credential);
    expect(() => commitLocalRoute({ ...req, credential: pair.credential })).toThrow(/只能查询/);
    expect(() => grantPanelActions({ workspaceId, companionId: pair.companionId, localUser: true, stateDir })).toThrow(/已验证/);
  });
  it("取消保持原配对，不允许commit；同requestId不重启native", () => {
    const req = input(); requestLocalRoute(req); finishLocalRouteConfirmation(req, false);
    expect(localRouteStatus(req).state).toBe("CANCELLED");
    expect(requestLocalRoute(req)).toMatchObject({ created: false, response: { state: "CANCELLED" } });
    expect(() => commitLocalRoute(req)).toThrow(/尚未取得/);
    expect(readFeedbackState(workspaceId, stateDir).companion!.credentialHash).toBe(sha256Hex(credential));
  });
  it("过期请求和恢复凭据都失败关闭", () => {
    vi.useFakeTimers(); const req = input(); requestLocalRoute(req); finishLocalRouteConfirmation(req, true);
    vi.setSystemTime(Date.now() + LOCAL_ROUTE_TTL_MS + 1);
    expect(localRouteStatus(req).state).toBe("EXPIRED");
    expect(() => commitLocalRoute(req)).toThrow(/过期/);
    expect(requestLocalRoute(req).created).toBe(false);
  });
  it("已消费响应丢失只读恢复，过期后不泄露credential", () => {
    vi.useFakeTimers(); const req = input(); requestLocalRoute(req); finishLocalRouteConfirmation(req, true);
    const candidate = localRouteStatus(req).candidatePairing!;
    commitLocalRoute(req);
    vi.setSystemTime(Date.now() + LOCAL_ROUTE_TTL_MS + 1);
    expect(localRouteStatus(req)).toMatchObject({ state: "EXPIRED" });
    expect(localRouteStatus(req).pairing).toBeUndefined();
    expect(verifyCompanionCredentialForWebSink({ ...req, credential: candidate.credential }).companionId).toBe(candidate.companionId);
  });
  it.each(["revoke", "binding", "companion", "sink"])("确认之后%s漂移阻断commit", kind => {
    const req = input(); requestLocalRoute(req); finishLocalRouteConfirmation(req, true);
    if (kind === "sink") bindCurrentWebSink(workspaceId, projectChatgptRouteToWebSinkCandidate({ workspaceId, routeCanonical: A }));
    else edit(state => ({ ...state, ...(kind === "revoke" ? { binding: { ...state.binding!, status: "superseded" as const } }
      : kind === "binding" ? { binding: { ...state.binding!, epoch: 2 } }
        : { companion: { ...state.companion!, companionId: randomUUID() } }) }));
    expect(() => commitLocalRoute(req)).toThrow();
    expect(readFeedbackState(workspaceId, stateDir).companion!.routeCanonical).toBe(A);
  });
  it("确认回调前撤权不能记录CONFIRMED", () => {
    const req = input(); requestLocalRoute(req);
    edit(state => ({ ...state, binding: { ...state.binding!, status: "superseded" } }));
    expect(() => finishLocalRouteConfirmation(req, true)).toThrow();
    expect(readFeedbackState(workspaceId, stateDir).localRouteRequests![0]!.status).toBe("PENDING");
  });
  it("每次仅一个确认，跨workspace/URL/credential不可提交", () => {
    const req = input(); requestLocalRoute(req);
    expect(() => requestLocalRoute(input())).toThrow(/已有本机/);
    expect(() => localRouteStatus({ ...req, workspaceRoot: root + "-other" })).toThrow();
    expect(() => finishLocalRouteConfirmation({ ...req, credential: "wrong" }, true)).toThrow();
    finishLocalRouteConfirmation(req, true);
    expect(() => commitLocalRoute({ ...req, routeCanonical: A })).toThrow(/URL/);
    expect(() => commitLocalRoute({ ...req, workspaceId: "f".repeat(12) })).toThrow();
  });
  it.each(["reserved", "claimed", "outcome_unknown"] as const)("legacy %s始终阻断切换", status => {
    const req = input(); const now = new Date().toISOString();
    edit(state => ({ ...state, events: [{ version: 1, eventId: "e".repeat(32), kind: "C2C_EXECUTED", workspaceId,
      source: "desktop", commandId: "cmd", taskId: "task", iteration: 1, result: "ok", changedFilesSummary: [], testsSummary: "",
      outputAvailable: false, occurredAt: now, createdAt: now, updatedAt: now,
      targetBindingId: state.binding!.bindingId, targetEpoch: 1, targetPrincipalFingerprint: "a".repeat(32), status }] }));
    expect(() => requestLocalRoute(req)).toThrow(/reserved\/claimed\/outcome_unknown/);
  });
  it("原successor再次轮换后旧credential不可恢复", () => {
    const req = input(); requestLocalRoute(req); finishLocalRouteConfirmation(req, true); const first = commitLocalRoute(req).pairing!;
    const next = { ...input(), credential: first.credential, routeCanonical: A };
    requestLocalRoute(next); finishLocalRouteConfirmation(next, true); commitLocalRoute(next);
    expect(() => localRouteStatus(req)).toThrow(/successor/);
  });
  it("旧authority过期记录可回收，当前authority过期请求仍不能重弹", () => {
    vi.useFakeTimers(); const req = input(); requestLocalRoute(req); finishLocalRouteConfirmation(req, true);
    const first = commitLocalRoute(req).pairing!;
    vi.setSystemTime(Date.now() + LOCAL_ROUTE_TTL_MS + 1);
    const fresh = { ...req, credential: first.credential, routeCanonical: A };
    expect(requestLocalRoute(fresh)).toMatchObject({ created: true, response: { state: "PENDING" } });
    expect(readFeedbackState(workspaceId, stateDir).localRouteRequests).toHaveLength(1);
    expect(() => commitLocalRoute(fresh)).toThrow(/尚未取得/);
    vi.setSystemTime(Date.now() + LOCAL_ROUTE_TTL_MS + 1);
    expect(requestLocalRoute(fresh)).toMatchObject({ created: false, response: { state: "EXPIRED" } });
  });
  it.each(["claimed", "outcome_unknown", "isolated"])("Bus %s 在确认后保留frozen target并正确阻断/允许切换", status => {
    const req = input();
    const sink = bindCurrentWebSink(workspaceId, projectChatgptRouteToWebSinkCandidate({ workspaceId, routeCanonical: A })).binding;
    requestLocalRoute(req); finishLocalRouteConfirmation(req, true);
    const now = new Date().toISOString(); const resultId = randomUUID();
    const result: OfficialResult = { commandId: "command_bus", iteration: 1, resultId, createdAt: now, updatedAt: now,
      status: "completed", rawSummary: "done", machineEvidence: { version: 1, source: "codex_app_server", hostId: "local",
        targetId: randomUUID(), taskId: resultId, threadId: "thread", turnId: "turn", status: "completed", observedAt: now,
        changedFiles: [], changedFilesCollected: false, testsSummary: OFFICIAL_TESTS_UNKNOWN } };
    const entry = { version: 1, busEntryId: resultBusEntryId(workspaceId, result.commandId, 1), workspaceId, commandId: result.commandId,
      iteration: 1, resultId, resultSha256: resultBusResultDigest(result), result, createdAt: now,
      deliveryStatus: status === "isolated" ? "outcome_unknown" : status,
      sendTarget: freezeActiveWebSinkTarget(sink), reservation: { bindingId: sink.bindingId, epoch: sink.epoch, boundAt: sink.boundAt,
        reservationId: randomUUID(), reservedAt: now }, attempt: { attemptId: randomUUID(), claimedAt: now },
      observedAt: null, outcomeUnknownAt: status === "claimed" ? null : now, retiredAt: null,
      outcomeReasonCode: status === "claimed" ? null : "UNKNOWN", cancelledAt: null, isolatedAt: status === "isolated" ? now : null };
    const bus = resultBusStateSchema.parse({ version: 1, workspaceId, workspaceRoot: root, revision: 1, entries: [entry] });
    const file = resultBusFile(workspaceId, stateDir); fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = JSON.stringify(bus); fs.writeFileSync(file, bytes);
    if (status === "isolated") expect(commitLocalRoute(req).state).toBe("COMMITTED");
    else expect(() => commitLocalRoute(req)).toThrow(/Result Bus/);
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
  });
  it("HTTP本机授权的空队列返回404、不领取legacy，canonical投递链完成后仍返回404", async () => {
    const req = input(); requestLocalRoute(req); finishLocalRouteConfirmation(req, true);
    const pairing = commitLocalRoute(req).pairing!;
    bindCurrentWebSinkFromDurableCompanion({ ...req, credential: pairing.credential });
    const app = express(); app.use(createCompanionRouter({ workspaceId, workspaceRoot: root, stateDir }));
    server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server!.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const post = (endpoint: string, body: Record<string, unknown> = {}) => requestJson(`http://127.0.0.1:${port}/${endpoint}`, {
      method: "POST", headers: { Authorization: `Bearer ${pairing.credential}`, "Content-Type": "application/json" },
      body: JSON.stringify({ routeCanonical: B, ...body }),
    });
    expect(await post("reserve")).toMatchObject({ status: 404, body: { error: "FEEDBACK_NO_READY_EVENT" } });
    const now = new Date().toISOString();
    edit(state => ({ ...state, events: [{ version: 1, eventId: "e".repeat(32), kind: "FINAL_RECEIPT_REQUIRED", workspaceId,
      source: "control", commandId: "legacy_control", taskId: "desktop_finalization_legacy_control", iteration: 1,
      result: "blocked", reason: "missing_final_receipt", changedFilesSummary: [], testsSummary: "", outputAvailable: false,
      occurredAt: now, createdAt: now, updatedAt: now, targetBindingId: state.binding!.bindingId, targetEpoch: 1,
      targetPrincipalFingerprint: state.binding!.principalFingerprint, status: "ready" }] }));
    const legacy = readFeedbackState(workspaceId, stateDir).events[0];
    const empty = await post("reserve");
    expect(empty).toMatchObject({ status: 404, body: { error: "FEEDBACK_NO_READY_EVENT" } });
    expect(empty.body.delivery).toBeUndefined();
    expect(JSON.stringify(empty.body)).not.toContain("legacy_control");
    expect(readFeedbackState(workspaceId, stateDir).events[0]).toEqual(legacy);
    const identity = { id: workspaceId, root };
    const planner = registerRoute(identity, { role: "planner", platform: "chatgpt_web", conversationId: "planner",
      locator: {} }, stateDir);
    const executorId = randomUUID();
    const executor = registerRoute(identity, { role: "executor", platform: "codex_desktop", conversationId: executorId,
      locator: { hostId: "local", executorProjectId: "local-route-test" } }, stateDir);
    const commandId = "local_route_canonical";
    createCommand(identity, { commandId, plannerRouteId: planner.routeId, executorRouteId: executor.routeId,
      intent: "development_plan", payloadBytes: 1, payloadSha256: "c".repeat(64) }, stateDir);
    appendResult(identity, { commandId, executorRouteId: executor.routeId, iteration: 1, status: "ok",
      rawSummary: "local route canonical result", machineEvidence: { version: 1, source: "codex_desktop_receipt",
        desktopReceiptSha256: "d".repeat(64), taskId: `desktop_${commandId}`, iteration: 1, status: "ok",
        threadId: executorId, originTurnId: executorId, resultTurnId: executorId, bindingId: randomUUID(),
        changedFiles: [], testsSummary: "local route HTTP chain" } }, stateDir);
    const reserved = await post("reserve");
    expect(reserved.status, JSON.stringify(reserved.body)).toBe(200);
    expect(reserved.body.delivery.commandId).toBe(commandId);
    const eventId = reserved.body.delivery.eventId;
    const started = await post("begin-send", { eventId, reservationId: reserved.body.reservationId });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body.status).toBe("claimed");
    expect(started.body.message).toContain("local route canonical result");
    expect(await post("ack", { eventId, attemptId: started.body.attemptId })).toMatchObject({ status: 200, body: { status: "observed" } });
    expect(readResultBus(identity, stateDir)?.entries[0]?.sendTarget?.canonicalUrl).toBe(B);
    expect(readResultBus(identity, stateDir)?.entries[0]?.deliveryStatus).toBe("observed");
    expect(await post("reserve")).toMatchObject({ status: 404, body: { error: "FEEDBACK_NO_READY_EVENT" } });
    expect(readFeedbackState(workspaceId, stateDir).events[0]).toEqual(legacy);
  });
  it("HTTP快速202，重复只查状态，后台一次确认后可提交", async () => {
    let finish!: (confirmed: boolean) => void;
    confirmMock.mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const app = express(); app.use(createCompanionRouter({ workspaceId, workspaceRoot: root, stateDir }));
    server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server!.once("listening", resolve));
    const port = (server.address() as { port: number }).port; const req = input();
    const post = (endpoint: string) => requestJson(`http://127.0.0.1:${port}/route/local/${endpoint}`, {
      method: "POST", headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: req.requestId, routeCanonical: B }),
    });
    expect(await post("request")).toMatchObject({ status: 202, body: { state: "PENDING" } });
    expect(await post("request")).toMatchObject({ status: 200, body: { state: "PENDING" } });
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock).toHaveBeenCalledWith({ workspaceId, workspaceRoot: root, routeCanonical: B });
    finish(true); await vi.waitFor(() => expect(localRouteStatus(req).state).toBe("CONFIRMED"));
    const committed = await post("commit");
    expect(committed).toMatchObject({ status: 200, body: { state: "COMMITTED", pairing: { routeVerification: "VERIFIED" } } });
    const nextCredential = committed.body.pairing.credential;
    bindCurrentWebSinkFromDurableCompanion({ ...req, credential: nextCredential });
    for (const endpoint of ["state", "web-sink/status"]) {
      const current = await requestJson(`http://127.0.0.1:${port}/${endpoint}`, { headers: { Authorization: `Bearer ${nextCredential}` } });
      expect(current.status).toBe(200);
      if (endpoint === "state") expect(current.body.routeVerification).toBe("VERIFIED");
      else expect(current.body.availability.available).toBe(true);
    }
    expect(await requestJson(`http://127.0.0.1:${port}/state`, { headers: { Authorization: `Bearer ${credential}` } })).toMatchObject({ status: 401 });
    const restored = await requestJson(`http://127.0.0.1:${port}/route/local/status?requestId=${req.requestId}`, { headers: { Authorization: `Bearer ${credential}` } });
    expect(restored).toMatchObject({ status: 200, body: { state: "COMMITTED" } });
    expect(await post("commit")).toMatchObject({ status: 401 });
  });
});
