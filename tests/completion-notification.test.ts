import { createHash, webcrypto } from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { renderCompletionNotification, type CompletionSignal } from "../src/browser/completion-notification.js";
import { renderCompletionNotification as shimRenderer } from "../browser-companion/completion-notification.js";
import { buildClaimProof, sanitizeInFlightForRecovery } from "../browser-companion/production-send.js";
import { hasExactAttemptMarker } from "../browser-companion/turn-observer.js";

const signal: CompletionSignal = {
  type: "execution_ended", version: 1, workspaceId: "aaaaaaaaaaaa", commandId: "command_1",
  taskId: "desktop_command_1", attemptId: "22222222-2222-4222-8222-222222222222",
};
const message = renderCompletionNotification(signal);
const messageSha256 = createHash("sha256").update(message).digest("hex");
const payload = { eventId: "e".repeat(32), status: "claimed", attemptId: signal.attemptId, signal, messageSha256 };
const source = fs.readFileSync("browser-companion/service-worker.js", "utf8");
function section(start: string, end: string): string {
  const offset = source.indexOf(start);
  return source.slice(offset, source.indexOf(end, offset + start.length));
}
const resolver = section("async function resolveCompletionPayload", "async function handleFetchState");
const hashCheck = section("async function unknownJournalMessageHashMatches", "function unknownIsolationResult");
const beginSend = section("async function handleProductionBeginSend", "\n/**");
const fetchState = section("async function handleFetchState", "\n/**");

function worker(body: any = payload, duringHash?: (ctx: any) => void) {
  const response = { ok: true, status: 200, body };
  const ctx: any = {
    body, response, renderCompletionNotification, TextEncoder,
    crypto: { subtle: { digest: async (...args: any[]) => {
      duringHash?.(ctx);
      return webcrypto.subtle.digest(args[0], args[1]);
    } } },
    workspaceId: signal.workspaceId, initPromise: Promise.resolve(), connectInFlight: false,
    storageProtected: true, transportIdentityBlocked: false,
    transport: { workspaceId: signal.workspaceId, credential: "test", routeVerification: "VERIFIED" },
    authFailureRevision: 0, requestTransports: new WeakMap(),
    isCurrentTransportResponse: () => ctx.transport.workspaceId === signal.workspaceId,
    owner: { tabId: 7, documentId: "doc", generation: 1 },
    requireExactOwnerSender: () => ({ ok: true, owner: ctx.owner }),
    ownerStillMatches: (owner: any) => JSON.stringify(owner) === JSON.stringify(ctx.owner),
    requireProtectedTransport: () => ({ ok: true }),
    journal: { state: "SEND_INTENT", eventId: payload.eventId, reservationId: "res", routeCanonical: "route" },
    exactJournalSnapshot: (value: any) => JSON.stringify(value),
    summarizeProductionJournal: (value: any) => ({ state: value.state }),
    fetchCompanion: async () => response,
    assertNoForbiddenFields: vi.fn(), buildClaimProof: vi.fn(buildClaimProof), productionClaimProof: null,
    areChatgptConversationRoutesEquivalent: (a: any, b: any) => a === b,
    parseServerIsolatedAttempts: () => ({ ok: true, attempts: [] }),
    validateStateIdentity: () => ({ ok: true }),
    syncTransportRouteVerification: () => ({ ok: false }),
    findExactObservedEvent: () => ({ ok: false }),
  };
  ctx.requestTransports.set(response, { requestAuthRevision: 0 });
  const prefix = `${hashCheck}\n${resolver}`;
  return {
    ctx,
    resolve: () => vm.runInNewContext(`${prefix}; resolveCompletionPayload(body, workspaceId)`, ctx),
    begin: () => vm.runInNewContext(`${prefix}\n${beginSend}; handleProductionBeginSend({}, {})`, ctx),
    state: (inFlight: any = body) => {
      response.body = { workspaceId: signal.workspaceId, bindingId: "b", epoch: 1, companionId: "c", routeCanonical: "route", inFlight };
      return vm.runInNewContext(`${prefix}\n${fetchState}; handleFetchState()`, ctx);
    },
  };
}

describe("浏览器 execution_ended 通知模板", () => {
  it("固定三行正文、shim和exact ATTEMPT marker一致", () => {
    expect(shimRenderer(signal)).toBe(message);
    expect(message).toBe(`本轮执行已结束，请读取结果（自动通知，非新授权）。\nWORKSPACE_ID: aaaaaaaaaaaa | COMMAND_ID: command_1 | TASK_ID: desktop_command_1\nATTEMPT_ID: ${signal.attemptId}`);
    expect(hasExactAttemptMarker(message, signal.attemptId)).toEqual({ ok: true });
  });
  it("接受既有Desktop和official合法ID以及长度边界", () => {
    expect(renderCompletionNotification({ ...signal, taskId: signal.attemptId })).toContain(`TASK_ID: ${signal.attemptId}`);
    expect(() => renderCompletionNotification({ ...signal, commandId: "x".repeat(128), taskId: `desktop_${"x".repeat(128)}` })).not.toThrow();
  });
  it.each([
    null, [], {}, { ...signal, extra: true }, { ...signal, version: 2 }, { ...signal, type: "finished" },
    { ...signal, workspaceId: "invalid" }, { ...signal, commandId: "x".repeat(129) },
    { ...signal, commandId: "command\nID" }, { ...signal, taskId: "" }, { ...signal, taskId: "task_1" },
    { ...signal, taskId: `desktop_${"x".repeat(129)}` }, { ...signal, attemptId: "invalid" },
    ...["\r", "\n", "\t", "\u2028", "\u2029"].map(separator => ({ ...signal, taskId: `desktop_a${separator}ATTEMPT_ID: fake` })),
    ...["workspaceId", "commandId", "taskId", "attemptId"].map(key => ({ ...signal, [key]: `${signal[key as keyof CompletionSignal]}\n` })),
  ])("拒绝非法signal %#", value => {
    expect(() => renderCompletionNotification(value)).toThrow("completion signal invalid");
  });
});

describe("service worker信号入站边界", () => {
  it("signal本地归一化为原协议消息与hash，恢复保留相同正文", async () => {
    const normalized = await worker().resolve();
    expect(normalized).toMatchObject({ message, messageSha256 });
    expect(normalized).not.toHaveProperty("signal");
    expect(sanitizeInFlightForRecovery(normalized)).toMatchObject({ message, messageSha256, attemptId: signal.attemptId });
    const sw = worker();
    expect(await sw.begin()).toMatchObject({ ok: true, message, messageSha256 });
    expect(sw.ctx.buildClaimProof).toHaveBeenCalledTimes(1);
    expect((await worker().state()).status.inFlight).toMatchObject({ message, messageSha256 });
  });
  it("legacy消息保持原正文/hash", async () => {
    const { signal: ignored, ...legacy } = payload;
    const body = { ...legacy, message: "legacy canonical body" };
    expect(await worker(body).resolve()).toEqual(body);
    expect(await worker(body).begin()).toMatchObject({ ok: true, message: body.message });
    expect((await worker(body).state()).status.inFlight.message).toBe(body.message);
  });
  const badBodies = [
    { ...payload, message }, { ...payload, signal: undefined }, { ...payload, signal: { ...signal, version: 2 } },
    { ...payload, signal: { ...signal, type: "finished" } }, { ...payload, messageFormat: "unknown" },
    { ...payload, signal: { ...signal, workspaceId: "bbbbbbbbbbbb" } },
    { ...payload, signal: { ...signal, attemptId: "33333333-3333-4333-8333-333333333333" } },
    { ...payload, messageSha256: "0".repeat(64) }, { ...payload, messageSha256: "invalid" },
    { ...payload, signal: { ...signal, taskId: "desktop_a\nATTEMPT_ID: fake" } },
    { ...payload, signal: { ...signal, extra: true } },
    { eventId: payload.eventId, status: "claimed", attemptId: signal.attemptId, messageFormat: "signal-v1", messageSha256 },
  ];
  it.each(badBodies)("坏signal拒绝mint proof及恢复成功，不能降成null %#", async body => {
    const sw = worker(body);
    expect(await sw.begin()).toMatchObject({ ok: false, reason: "begin_send_response_invalid" });
    expect(sw.ctx.buildClaimProof).not.toHaveBeenCalled();
    expect(sw.ctx.productionClaimProof).toBeNull();
    expect(await sw.state()).toMatchObject({ ok: false, reason: "state_response_invalid" });
    expect(sw.ctx.journal.state).toBe("SEND_INTENT");
  });
  it("外层event身份仍必须匹配原journal", async () => {
    const sw = worker({ ...payload, eventId: "f".repeat(32) });
    expect(await sw.begin()).toMatchObject({ ok: false, reason: "begin_send_response_invalid" });
    expect(sw.ctx.buildClaimProof).not.toHaveBeenCalled();
  });
  it.each([
    ["transport", (ctx: any) => { ctx.transport.workspaceId = "bbbbbbbbbbbb"; }, "stale_transport_response"],
    ["authRevision", (ctx: any) => { ctx.authFailureRevision += 1; }, "stale_transport_response"],
    ["owner", (ctx: any) => { ctx.owner.generation += 1; }, "connection_changed"],
    ["journal", (ctx: any) => { ctx.journal.state = "NONE"; }, "connection_changed"],
  ])("异步hash后重新核对%s身份", async (_name, mutate, reason) => {
    const sw = worker(payload, mutate as (ctx: any) => void);
    expect(await sw.begin()).toMatchObject({ ok: false, reason });
    expect(sw.ctx.buildClaimProof).not.toHaveBeenCalled();
  });
  it.each(["transport", "authRevision"])("state异步hash后%s变化停止恢复", async kind => {
    const sw = worker(payload, ctx => { if (kind === "transport") ctx.transport.workspaceId = "bbbbbbbbbbbb"; else ctx.authFailureRevision += 1; });
    expect(await sw.state()).toMatchObject({ ok: false, reason: "stale_transport_response" });
  });
  it("hash计算失败拒绝发送与恢复", async () => {
    const sw = worker(); sw.ctx.crypto.subtle.digest = async () => { throw new Error("hash unavailable"); };
    expect(await sw.begin()).toMatchObject({ ok: false, reason: "begin_send_response_invalid" });
    expect(await sw.state()).toMatchObject({ ok: false, reason: "state_response_invalid" });
  });
  it("state null保持既有语义", async () => {
    expect((await worker().state(null)).status.inFlight).toBeNull();
  });
});

describe("completion模板构建约束", () => {
  it("编译模板覆盖源码shim并只进入SW ESM链", () => {
    const build = fs.readFileSync("scripts/build-browser-companion.mjs", "utf8");
    expect(build).toContain('fs.copyFileSync(completionJs, path.join(distCompanion, "completion-notification.js"))');
    expect(build).toContain('missing compiled completion module');
    expect(source).toContain('import { renderCompletionNotification } from "./completion-notification.js"');
    const renderer = fs.readFileSync("src/browser/completion-notification.ts", "utf8");
    expect(renderer).not.toMatch(/\bimport\b|node:|\bzod\b/);
    const manifest = JSON.parse(fs.readFileSync("browser-companion/manifest.json", "utf8"));
    expect(manifest.content_scripts.flatMap((script: any) => script.js)).not.toContain("completion-notification.js");
  });
});
