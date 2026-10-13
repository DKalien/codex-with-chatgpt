import fs from "node:fs";
import http from "node:http";
import express from "express";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it } from "vitest";
import { makeTmpDir } from "./helpers.js";
import { cleanupStrict } from "./strict-teardown.js";
import { requestJson } from "./http-json.js";
import { Workspace } from "../src/workspace/manager.js";
import { projectRemoteResult } from "../src/remote/results.js";
import type { RemoteTask } from "../src/remote/store.js";
import { markResultBusOutcomeUnknown } from "../src/result-bus/delivery-lifecycle.js";
import { readResultBus, resultBusFile } from "../src/result-bus/store.js";
import { resolveConversationPrincipal } from "../src/mcp/conversation-principal.js";
import { enableReceiver } from "../src/feedback/receiver.js";
import { ensureFeedbackState, readFeedbackState, writeState } from "../src/feedback/state-store.js";
import { beginSend } from "../src/feedback/delivery-lifecycle.js";
import { createPairingIntent, exchangePairingIntent, confirmRouteAttestation, verifyCompanionCredential } from "../src/feedback/companion.js";
import { bindCurrentWebSink, projectChatgptRouteToWebSinkCandidate } from "../src/web-sink-control/index.js";
import { createCompanionRouter } from "../src/bridge/companion.js";
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


it("once HTTP 并发仅一次授予发送载荷；重放拒绝而旧请求仍兼容", async () => {
  const input = pair(); projectRemoteResult(workspace, task());
  const app = express(); app.use(express.json());
  app.use("/companion", createCompanionRouter({ workspaceId: workspace.id, workspaceRoot: root, stateDir }));
  const foreignRoot = makeTmpDir("once-foreign"), foreign = new Workspace(foreignRoot);
  app.use("/foreign", createCompanionRouter({ workspaceId: foreign.id, workspaceRoot: foreignRoot, stateDir }));
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (endpoint: string, body: object, credential = input.credential) => requestJson(`${base}${endpoint}`, {
    method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const reserved = await post("/companion/reserve", { routeCanonical: route });
    const body = { routeCanonical: route, eventId: reserved.body.delivery.eventId, reservationId: reserved.body.reservationId, once: true };
    const before = fs.readFileSync(resultBusFile(workspace.id), "utf8");
    expect((await post("/companion/begin-send", { ...body, routeCanonical: "https://chatgpt.com/c/22222222-2222-4222-8222-222222222222" })).status).not.toBe(200);
    expect((await post("/foreign/begin-send", body)).status).not.toBe(200);
    expect((await post("/companion/begin-send", body, "invalid")).status).not.toBe(200);
    expect(fs.readFileSync(resultBusFile(workspace.id), "utf8")).toBe(before);
    const results = await Promise.all(Array.from({ length: 4 }, () => post("/companion/begin-send", body)));
    const granted = results.filter(result => result.status === 200);
    expect(granted).toHaveLength(1);
    expect(granted[0]!.body).toMatchObject({ status: "claimed", signal: { type: "execution_ended" } });
    for (const rejected of results.filter(result => result.status !== 200)) {
      expect(rejected.status).toBe(409); expect(rejected.body).not.toHaveProperty("signal");
      expect(rejected.body).not.toHaveProperty("messageSha256"); expect(rejected.body).not.toHaveProperty("attemptId");
    }
    const claimedBytes = fs.readFileSync(resultBusFile(workspace.id), "utf8");
    expect((await post("/companion/begin-send", body)).status).toBe(409);
    const { once: _once, ...legacy } = body;
    expect((await post("/companion/begin-send", legacy)).body).toEqual(granted[0]!.body);
    expect(fs.readFileSync(resultBusFile(workspace.id), "utf8")).toBe(claimedBytes);
    const entry = readResultBus(workspace)!.entries[0]!;
    markResultBusOutcomeUnknown(workspace, { busEntryId: entry.busEntryId, attemptId: entry.attempt!.attemptId });
    const unknownBytes = fs.readFileSync(resultBusFile(workspace.id), "utf8");
    expect((await post("/companion/begin-send", body)).status).toBe(409);
    expect(fs.readFileSync(resultBusFile(workspace.id), "utf8")).toBe(unknownBytes);
    const state = await requestJson(`${base}/companion/state`, { headers: { authorization: `Bearer ${input.credential}` } });
    expect(state.body.inFlight).toMatchObject({ status: "outcome_unknown", attemptId: entry.attempt!.attemptId });
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await cleanupStrict(foreignRoot); }
});

it("Feedback once 在现有锁内拒绝 claimed 和 unknown，旧调用精确重放兼容", () => {
  const input = pair(), ctx = verifyCompanionCredential(input), now = new Date().toISOString();
  const eventId = "a".repeat(32), reservationId = randomUUID();
  const state = readFeedbackState(workspace.id, stateDir);
  writeState(workspace.id, stateDir, { ...state, events: [{ version: 1, kind: "FINAL_RECEIPT_REQUIRED", source: "control",
    eventId, workspaceId: workspace.id, commandId: "once-control", taskId: "desktop_finalization_once-control", iteration: 1,
    result: "blocked", changedFilesSummary: [], testsSummary: "", outputAvailable: false, reason: "terminality_unknown",
    occurredAt: now, createdAt: now, updatedAt: now, targetBindingId: ctx.bindingId, targetEpoch: ctx.epoch,
    targetPrincipalFingerprint: ctx.principalFingerprint, status: "reserved", reservationId, reservedAt: now, reservedBy: ctx.companionId }] });
  const request = { workspaceId: workspace.id, bindingId: ctx.bindingId, epoch: ctx.epoch,
    principalFingerprint: ctx.principalFingerprint, companionId: ctx.companionId, eventId, reservationId, stateDir };
  const claimed = beginSend({ ...request, once: true });
  expect(() => beginSend({ ...request, once: true })).toThrow("exact reserved");
  expect(beginSend(request)).toEqual(claimed);
  const claimedState = readFeedbackState(workspace.id, stateDir);
  writeState(workspace.id, stateDir, { ...claimedState, events: claimedState.events.map(event => ({ ...event, status: "outcome_unknown" })) });
  expect(() => beginSend({ ...request, once: true })).toThrow("exact reserved");
});
