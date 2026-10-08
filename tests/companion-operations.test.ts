import { bindCurrentWebSink, projectChatgptRouteToWebSinkCandidate } from "../src/web-sink-control/index.js";
import { projectAvailableResultBusCommands } from "../src/result-bus/service.js";
import { previewPanelAction, confirmPanelAction, reconcilePanelAction } from "../src/bridge/companion-actions.js";
import { grantPanelActions, revokePanelActions, readPanelAuthorization } from "../src/feedback/panel.js";
import { readFeedbackState, recoverStaleFeedback } from "../src/feedback/state-store.js";
import { readRouting, assertCommandNotCancelled } from "../src/routing/store.js";
import { listResultBusEntries } from "../src/result-bus/store.js";
import { reserveNextResultBusEntry } from "../src/result-bus/delivery-lifecycle.js";
import { withConnectionMutation } from "../src/bridge/connection.js";
import { resultBusCompanionState } from "../src/bridge/result-bus-delivery.js";
import { deliveryArbiterLockFile } from "../src/bridge/delivery-arbiter.js";
import { createWorkspaceMaintenance } from "../src/bridge/maintenance.js";
import { beginExecutorDispatch } from "../src/executor-control/dispatch-service.js";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { readCompanionOperations } from "../src/bridge/companion-operations.js";
import { createMcpServer } from "../src/mcp/server.js";
import { resolveConversationPrincipal } from "../src/mcp/conversation-principal.js";
import { enableReceiver } from "../src/feedback/receiver.js";
import { ensureFeedbackState, feedbackStateFile } from "../src/feedback/state-store.js";
import { confirmRouteAttestation, createPairingIntent, exchangePairingIntent, revokeCompanion } from "../src/feedback/companion.js";
import { appendResult, createCommand, registerRoute, transitionCommandDelivery, routingFile } from "../src/routing/store.js";
import type { CommandMailbox } from "../src/routing/schema.js";
import { enqueueResultBusEntry } from "../src/result-bus/store.js";
import { cleanupJournalFile, withCommandOperation } from "../src/command-cleanup/fence.js";
import { codexDesktopAdapter } from "../src/executor/index.js";
import { readDesktop, updateDesktop } from "../src/desktop/store.js";
import { setRemoteEnabled, updateRemote } from "../src/remote/store.js";
import { takeoverReceiver } from "../src/feedback/receiver.js";
import { isolateStateDir, makeTmpDir } from "./helpers.js";
import { cleanupStrict } from "./strict-teardown.js";

const route = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
const extra = { authInfo: { token: "test", clientId: "test-client", scopes: ["codex.feedback"] }, _meta: { "openai/session": "test-session" } };
let stateDir: string, root: string, workspace: Workspace;
const principal = () => resolveConversationPrincipal(extra as never);
beforeEach(() => { stateDir = isolateStateDir(); root = makeTmpDir("operations"); workspace = new Workspace(root); });
afterEach(async () => { vi.restoreAllMocks(); await cleanupStrict(stateDir, root); });
function pair(verified = true) {
  ensureFeedbackState(workspace.id, 0, stateDir);
  enableReceiver({ workspaceId: workspace.id, principal: principal(), widgetId: "widget", stateDir });
  const intent = createPairingIntent({ workspaceId: workspace.id, principal: principal(), stateDir });
  const paired = exchangePairingIntent({ workspaceId: workspace.id, intentId: intent.intentId, secret: intent.secret, routeCanonical: route, stateDir });
  if (verified) confirmRouteAttestation({ workspaceId: workspace.id, principal: principal(),
    challengeId: paired.routeAttestation.challengeId, challengeDigest: paired.routeAttestation.challengeDigest, stateDir });
  return { workspaceId: workspace.id, workspaceRoot: root, credential: paired.credential, stateDir };
}
function seed(commandId: string, owner = principal().fingerprint, result = false) {
  const planner = registerRoute(workspace, { platform: "chatgpt_web", role: "planner", conversationId: owner, locator: {} }, stateDir);
  const executor = registerRoute(workspace, { platform: "codex_desktop", role: "executor", conversationId: randomUUID(), locator: { hostId: "local", executorProjectId: "test" } }, stateDir);
  createCommand(workspace, { commandId, plannerRouteId: planner.routeId, executorRouteId: executor.routeId, intent: "revision", payloadBytes: 1, payloadSha256: "a".repeat(64) }, stateDir);
  transitionCommandDelivery(workspace, { commandId, deliveryStatus: "accepted" }, stateDir);
  if (!result) return;
  const canonical = appendResult(workspace, { commandId, executorRouteId: executor.routeId, iteration: 1, status: "ok", rawSummary: "private output text",
    machineEvidence: { version: 1, source: "codex_desktop_receipt", desktopReceiptSha256: "b".repeat(64), taskId: `desktop_${commandId}`, iteration: 1, status: "ok",
      threadId: executor.conversationId, originTurnId: randomUUID(), resultTurnId: randomUUID(), bindingId: randomUUID(), changedFiles: [], testsSummary: "PASS", output: { outputId: 42, outputAvailable: true } } }, stateDir);
  enqueueResultBusEntry(workspace, canonical, stateDir);
}
const inspect = async () => ({ workspaceId: workspace.id, activeBinding: null, plugins: [], availability: { available: false as const, reasonCode: "no_active_binding", message: "not bound" } });
function snapshot(dir: string): unknown {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(item => {
    const file = path.join(dir, item.name), stat = fs.statSync(file);
    return item.isDirectory() ? [item.name, snapshot(file)] : [item.name, stat.ino, stat.mtimeMs, stat.size, createHash("sha256").update(fs.readFileSync(file)).digest("hex")];
  });
}
function tools() {
  return (createMcpServer({ workspace, logger: { info() {}, error() {}, warn() {}, debug() {} } as never }) as unknown as {
    _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<any>; annotations: { readOnlyHint: boolean } }>
  })._registeredTools;
}

describe("B2 read-only status boundary", () => {
  it("authenticated absent status queries create no state, locks, directories or cursor", async () => {
    const registered = tools(), before = snapshot(stateDir);
    for (const name of ["feedback_status", "feedback_companion_status"]) {
      expect(registered[name].annotations.readOnlyHint).toBe(true);
      const result = await registered[name].handler({}, extra);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ ownsBinding: false });
    }
    expect(snapshot(stateDir)).toEqual(before);
  });
  it("old corrupt lifecycle lock cannot block status or GUI and is not reclaimed", async () => {
    const input = pair(); seed("historical-command", principal().fingerprint, true);
    const lock = `${cleanupJournalFile(workspace.id, "historical-command", stateDir)}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true }); fs.writeFileSync(lock, "");
    const before = snapshot(stateDir), registered = tools();
    for (const name of ["feedback_status", "feedback_companion_status"]) expect((await registered[name].handler({}, extra)).isError).not.toBe(true);
    expect((await readCompanionOperations(input, inspect)).commands).toHaveLength(1);
    expect(snapshot(stateDir)).toEqual(before);
    expect(() => withCommandOperation(workspace.id, "historical-command", () => {}, stateDir)).toThrow();
  });
  it("all workspace tasks include other conversations, with exact evidence and no message or secret disclosure", async () => {
    const input = pair(); seed("accepted-only"); seed("record-ready", principal().fingerprint, true); seed("foreign", "other-principal", true);
    const before = snapshot(stateDir), result = await readCompanionOperations(input, inspect);
    expect(result.commands.map(command => command.commandId).sort()).toEqual(["accepted-only", "foreign", "record-ready"]);
    expect(result.commands.find(command => command.commandId === "foreign")).toMatchObject({ scope: "historical" });
    expect(result.commands.find(command => command.commandId === "accepted-only")).toMatchObject({ delivery: { status: "accepted" }, executions: [], feedback: [] });
    expect(result.commands.find(command => command.commandId === "record-ready")).toMatchObject({ executions: [{ status: "ok", outputId: 42 }], feedback: [{ source: "result_bus", status: "queued", iteration: 1 }] });
    expect(result.commands.find(command => command.commandId === "accepted-only")?.delivery).toMatchObject({ cancelable: false, cancelReason: "PANEL_CANCEL_UNSAFE" });
    expect(result.commands.find(command => command.commandId === "record-ready")?.delivery).toMatchObject({ cancelable: false, cancelReason: "PANEL_CANCEL_UNSAFE" });
    for (const secret of [input.credential, principal().fingerprint, "private output text", "other-principal", root]) expect(JSON.stringify(result)).not.toContain(secret);
    expect(snapshot(stateDir)).toEqual(before);
  });
  it("queued command mailbox exposes bounded scheduling metadata without payload or grant secrets", async () => {
    const input = pair(), message = "private queued task payload";
    const planner = registerRoute(workspace, { platform: "chatgpt_web", role: "planner",
      conversationId: principal().fingerprint, locator: {} }, stateDir);
    for (const state of ["queued", "dispatching", "blocked"] as const) {
      const executor = registerRoute(workspace, { platform: "codex_desktop", role: "executor",
        conversationId: randomUUID(), locator: { hostId: "local", executorProjectId: "test" } }, stateDir);
      createCommand(workspace, { commandId: `mailbox-${state}`, plannerRouteId: planner.routeId,
        executorRouteId: executor.routeId, intent: "revision", payloadBytes: Buffer.byteLength(message),
        payloadSha256: createHash("sha256").update(message).digest("hex") }, stateDir, {
        kind: "executor", state, message, clientId: "private-client", tokenHash: "f".repeat(64),
        bindingId: randomUUID(), desktopBindingId: randomUUID(), plannerFingerprint: principal().fingerprint,
        ...(state === "blocked" ? { reason: "DESKTOP_BUSY" } : {}),
      });
    }
    const before = snapshot(stateDir), result = await readCompanionOperations(input, inspect);
    for (const state of ["queued", "dispatching", "blocked"] as const) {
      const row = result.commands.find(command => command.commandId === `mailbox-${state}`)!;
      expect(row.delivery.status).toBe("pending");
      expect(row.delivery.queueStatus).toBe(state);
      expect(row.delivery.cancelable).toBe(state === "queued");
      if (state !== "queued") expect(row.delivery.cancelReason).toBe("PANEL_CANCEL_UNSAFE");
      expect(row.delivery.queueReason).toBe(state === "blocked" ? "DESKTOP_BUSY" : undefined);
      expect(row.delivery.reason).toBeNull();
    }
    for (const secret of [message, "private-client", "f".repeat(64), principal().fingerprint])
      expect(JSON.stringify(result)).not.toContain(secret);
    expect(snapshot(stateDir)).toEqual(before);
  });
  it("whitelisted blocked mailbox is eligible for cancel without exposing mailbox identity", async () => {
    const input = pair();
    const planner = registerRoute(workspace, { platform: "chatgpt_web", role: "planner",
      conversationId: principal().fingerprint, locator: {} }, stateDir);
    const executor = registerRoute(workspace, { platform: "codex_desktop", role: "executor",
      conversationId: randomUUID(), locator: { hostId: "local", executorProjectId: "test" } }, stateDir);
    const mailbox = { kind: "executor" as const, state: "blocked" as const, reason: "UNAUTHORIZED",
      message: "private payload", clientId: "private-client", tokenHash: "f".repeat(64), bindingId: randomUUID(),
      desktopBindingId: randomUUID(), plannerFingerprint: principal().fingerprint };
    createCommand(workspace, { commandId: "mailbox-blocked-safe", plannerRouteId: planner.routeId,
      executorRouteId: executor.routeId, intent: "revision", payloadBytes: 15,
      payloadSha256: createHash("sha256").update(mailbox.message).digest("hex") }, stateDir, mailbox);
    const before = snapshot(stateDir), result = await readCompanionOperations(input, inspect);
    const delivery = result.commands.find(command => command.commandId === "mailbox-blocked-safe")!.delivery;
    expect(delivery).toMatchObject({ status: "pending", queueStatus: "blocked", queueReason: "UNAUTHORIZED", cancelable: true });
    expect(delivery).not.toHaveProperty("cancelReason");
    for (const secret of [mailbox.message, mailbox.clientId, mailbox.tokenHash, mailbox.plannerFingerprint])
      expect(JSON.stringify(result)).not.toContain(secret);
    expect(snapshot(stateDir)).toEqual(before);
  });
  it("old unrouted Desktop accepted and unknown deliveries plus orphan zero-byte lock stay visible", async () => {
    const input = pair(), now = new Date().toISOString(), threadId = randomUUID();
    updateDesktop(workspace.id, () => ({ state: { version: 1, workspaceId: workspace.id, workspaceRoot: root, enabled: false, binding: null,
      deliveries: ["accepted", "outcome_unknown"].map(status => ({ commandId: `old-${status}`, clientId: "private-client", bindingId: randomUUID(), messageSha256: "a".repeat(64), messageBytes: 5,
        threadId, ...(status === "accepted" ? { turnId: randomUUID() } : {}), deliveryStatus: status as "accepted" | "outcome_unknown", createdAt: now, updatedAt: now })) }, result: null }), stateDir);
    const lock = `${cleanupJournalFile(workspace.id, "orphan", stateDir)}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true }); fs.writeFileSync(lock, "");
    const before = snapshot(stateDir), result = await readCompanionOperations(input, inspect);
    expect(result.commands.map(command => command.commandId).sort()).toEqual(["old-accepted", "old-outcome_unknown", "orphan"]);
    expect(result.commands.find(command => command.commandId === "orphan")).toMatchObject({ scope: "historical", issues: ["empty_lifecycle_lock"] });
    expect(result.commands.find(command => command.commandId === "old-outcome_unknown")).toMatchObject({ delivery: { status: "outcome_unknown" }, executions: [] });
    expect(snapshot(stateDir)).toEqual(before);
  });
  it("does not silently truncate historical debt after 100 tasks", async () => {
    const input = pair(); seed("base", "old-principal");
    const file = routingFile(workspace.id, stateDir), state = JSON.parse(fs.readFileSync(file, "utf8"));
    state.commands = Array.from({ length: 105 }, (_, index) => ({ ...state.commands[0], commandId: `history-${index}` }));
    fs.writeFileSync(file, JSON.stringify(state));
    const before = snapshot(stateDir), result = await readCompanionOperations(input, inspect);
    expect(result.commands).toHaveLength(105); expect(result.total).toBe(105); expect(snapshot(stateDir)).toEqual(before);
  });
  it("old receiver credential cannot view workspace history after takeover", async () => {
    const input = pair();
    const other = resolveConversationPrincipal({ ...extra, _meta: { "openai/session": "other" } } as never);
    takeoverReceiver({ workspaceId: workspace.id, principal: other, expectedEpoch: 1, widgetId: "widget", stateDir });
    const probe = vi.fn(inspect), before = snapshot(stateDir);
    await expect(readCompanionOperations(input, probe)).rejects.toThrow();
    expect(probe).not.toHaveBeenCalled(); expect(snapshot(stateDir)).toEqual(before);
  });
  it.each(["invalid", "unverified"])("%s credential cannot probe executor or read command data", async mode => {
    const input = pair(mode !== "unverified"), probe = vi.fn(inspect);
    if (mode === "invalid") input.credential = "wrong";
    const before = snapshot(stateDir);
    await expect(readCompanionOperations(input, probe)).rejects.toThrow();
    expect(probe).not.toHaveBeenCalled(); expect(snapshot(stateDir)).toEqual(before);
  });
  it("revocation during IPC wait refuses the old authenticated snapshot", async () => {
    const input = pair();
    await expect(readCompanionOperations(input, async () => {
      revokeCompanion({ workspaceId: workspace.id, principal: principal(), stateDir }); return inspect();
    })).rejects.toThrow();
  });
  it("corrupt source stays an error, never an empty successful list or repair", async () => {
    const input = pair(); seed("record");
    fs.writeFileSync(routingFile(workspace.id, stateDir), "{}");
    const before = snapshot(stateDir);
    await expect(readCompanionOperations(input, inspect)).rejects.toThrow();
    expect(snapshot(stateDir)).toEqual(before);
  });
  it("status never initializes or rewrites malformed Feedback state", async () => {
    const file = feedbackStateFile(workspace.id, stateDir); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "{}");
    const registered = tools(), before = snapshot(stateDir);
    expect((await registered.feedback_status.handler({}, extra)).isError).toBe(true);
    expect(snapshot(stateDir)).toEqual(before);
  });
});

describe("Companion Desktop activity", () => {
  const fence = { desktopPid: 1, desktopExe: "desktop.exe", desktopCreation: "1",
    appServerPid: 2, appServerExe: "server.exe", appServerCreation: "2" };
  function desktop() {
    const binding = { bindingId: randomUUID(), threadId: randomUUID(), hostId: "local" as const,
      projectId: "test", title: "private title", boundAt: new Date().toISOString() };
    updateDesktop(workspace.id, () => ({ state: { version: 1, workspaceId: workspace.id, workspaceRoot: root,
      enabled: true, binding, runtimeFence: fence, deliveries: [] }, result: null }), stateDir);
    setRemoteEnabled(workspace, false, { deliveryMode: "official" });
    return { threadId: binding.threadId, hostId: binding.hostId, projectId: binding.projectId, workspaceRoot: root };
  }
  it.each([
    ["idle", 0, "idle"], ["active", 0, "busy"], ["inProgress", 0, "busy"],
    ["idle", 1, "approval_required"], ["idle", undefined, "unknown"], [undefined, 0, "unknown"],
  ])("disabled official mode projects exact Desktop %s / %s as %s without writes", async (runtimeStatus, requestsCount, activity) => {
    const input = pair(), target = desktop(); seed("history", principal().fingerprint, true);
    const probe = vi.spyOn(codexDesktopAdapter, "inspect").mockResolvedValue({ ...target, title: "private title", runtimeStatus, requestsCount });
    const generic = vi.fn(inspect), before = snapshot(stateDir);
    const result = await readCompanionOperations(input, generic);
    expect(result.executor).toMatchObject({ source: "codex_desktop", state: activity, sessionId: target.threadId });
    expect(probe).toHaveBeenCalledExactlyOnceWith(target, fence);
    expect(generic).not.toHaveBeenCalled();
    expect(result.commands.map(command => command.commandId)).toEqual(["history"]);
    for (const secret of [root, "private title", "desktop.exe", input.credential]) expect(JSON.stringify(result)).not.toContain(secret);
    expect(snapshot(stateDir)).toEqual(before);
  });
  it.each(["disabled", "retarget", "revision", "fence", "remote_enabled", "remote_mode"])("%s during IPC invalidates the observation", async change => {
    const input = pair(), target = desktop();
    vi.spyOn(codexDesktopAdapter, "inspect").mockImplementation(async () => {
      if (change.startsWith("remote_")) updateRemote(workspace.id, state => {
        if (change === "remote_enabled") state!.enabled = true;
        else delete state!.deliveryMode;
        return { state: state!, result: null };
      }, stateDir);
      else updateDesktop(workspace.id, state => {
        if (change === "disabled") state!.enabled = false;
        if (change === "retarget") state!.binding!.threadId = randomUUID();
        if (change === "fence") state!.runtimeFence!.desktopPid++;
        return { state: state!, result: null };
      }, stateDir);
      return { ...target, title: "test", requestsCount: 0, runtimeStatus: "idle" };
    });
    expect((await readCompanionOperations(input, inspect)).executor).toMatchObject({
      state: "unknown", reason: "binding_changed", observedAt: null, sessionId: null });
  });
  it.each(["missing_fence", "wrong_target", "inspect_failed"])("%s never falls back to a generic target", async failure => {
    const input = pair(), target = desktop();
    if (failure === "missing_fence") updateDesktop(workspace.id, state => ({ state: { ...state!, runtimeFence: null }, result: null }), stateDir);
    const probe = vi.spyOn(codexDesktopAdapter, "inspect").mockImplementation(async () => {
      if (failure === "inspect_failed") throw new Error("offline");
      return { ...target, threadId: randomUUID(), title: "test", requestsCount: 0, runtimeStatus: "idle" };
    });
    const generic = vi.fn(inspect), before = snapshot(stateDir);
    expect((await readCompanionOperations(input, generic)).executor).toMatchObject({ state: "unknown", reason: "inspect_failed" });
    expect(generic).not.toHaveBeenCalled();
    if (failure === "missing_fence") expect(probe).not.toHaveBeenCalled();
    expect(snapshot(stateDir)).toEqual(before);
  });
  it("enabling Desktop during a generic inspection discards the old target observation", async () => {
    const input = pair(); desktop();
    updateDesktop(workspace.id, state => ({ state: { ...state!, enabled: false }, result: null }), stateDir);
    updateRemote(workspace.id, state => { delete state!.deliveryMode; return { state: state!, result: null }; }, stateDir);
    const probe = vi.spyOn(codexDesktopAdapter, "inspect");
    expect((await readCompanionOperations(input, async () => {
      updateDesktop(workspace.id, state => ({ state: { ...state!, enabled: true }, result: null }), stateDir);
      return { workspaceId: workspace.id, activeBinding: null, plugins: [], availability: { available: true }, activity: "idle" };
    })).executor).toMatchObject({ state: "unknown", reason: "binding_changed", observedAt: null });
    expect(probe).not.toHaveBeenCalled();
  });
  it("enabled unhealthy official Remote stays unknown and disabled Desktop is not inspected", async () => {
    const input = pair(); desktop();
    const probe = vi.spyOn(codexDesktopAdapter, "inspect"), generic = vi.fn(inspect);
    setRemoteEnabled(workspace, true);
    expect((await readCompanionOperations(input, generic)).executor).toMatchObject({ source: "codex_app_server", state: "unknown", reason: "CONTROLLER_OFFLINE" });
    setRemoteEnabled(workspace, false);
    updateDesktop(workspace.id, state => ({ state: { ...state!, enabled: false }, result: null }), stateDir);
    expect((await readCompanionOperations(input, generic)).executor).toMatchObject({ state: "unknown", reason: "REMOTE_CONTROL_DISABLED" });
    expect(probe).not.toHaveBeenCalled(); expect(generic).not.toHaveBeenCalled();
  });
  it("rejects a foreign workspace before IPC and revocation after IPC", async () => {
    const input = pair(), target = desktop();
    updateDesktop(workspace.id, state => ({ state: { ...state!, workspaceRoot: "foreign" }, result: null }), stateDir);
    const probe = vi.spyOn(codexDesktopAdapter, "inspect").mockImplementation(async () => {
      revokeCompanion({ workspaceId: workspace.id, principal: principal(), stateDir });
      return { ...target, title: "test", requestsCount: 0, runtimeStatus: "idle" };
    });
    await expect(readCompanionOperations(input, inspect)).rejects.toThrow("workspace 身份不一致");
    expect(probe).not.toHaveBeenCalled();
    updateDesktop(workspace.id, state => ({ state: { ...state!, workspaceRoot: root }, result: null }), stateDir);
    await expect(readCompanionOperations(input, inspect)).rejects.toThrow();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(readDesktop(workspace.id, stateDir)!.binding!.threadId).toBe(target.threadId);
  });
});

describe("Companion read-only presentation", () => {
  function model() {
    const context = vm.createContext({});
    vm.runInContext(fs.readFileSync("browser-companion/operations/view.js", "utf8"), context);
    return context.C2COperations;
  }
  const now = Date.parse("2026-10-04T12:00:00.000Z");
  function response(overrides = {}) { return { ok: true, autonomy: "off", snapshot: { observedAt: new Date(now).toISOString(), executor: { state: "busy", observedAt: new Date(now).toISOString() }, commands: [] },
    web: { connectionReadiness: { ready: true, reason: null }, observedAt: now, ownerAvailable: true, routeMatches: true, verified: true, composer: "empty", generation: "idle", safe: true }, ...overrides }; }
  it("Codex busy and webpage available are independent; pause is not offline", () => {
    expect(model().derive(response(), now)).toMatchObject({ codex: "忙碌", web: "可接收结果", autonomy: "已暂停" });
  });
  it("unknown journal changes only an otherwise-ready webpage to awaiting feedback verification", () => {
    const view = model();
    const data = response({ autonomy: "armed", journal: { state: "OUTCOME_UNKNOWN" } });
    expect(view.derive(data, now)).toMatchObject({ web: "回流待核验", autonomy: "已开启" });
    expect(view.derive(response({ autonomy: "armed", journal: { state: "NONE" } }), now))
      .toMatchObject({ web: "可接收结果", autonomy: "已开启" });
    expect(view.derive(data, now + 46_000).web).toBe("无法确认");
    for (const [web, label] of [
      [{ ownerAvailable: false }, "当前页面无 owner"], [{ routeMatches: false }, "页面与绑定不一致"],
      [{ verified: false }, "对话待验证"], [{ generation: "generating" }, "正在生成"],
      [{ composer: "nonempty" }, "输入框有未发送内容"], [{ safe: false }, "暂不可接收"],
      [{ observedAt: now - 46_000 }, "无法确认"],
    ] as const) {
      expect(view.derive({ ...data, web: { ...data.web, ...web } }, now).web).toBe(label);
    }
  });
  it.each(["generating", "nonempty", "mismatch"])("web %s cannot appear ready", condition => {
    const data = response();
    if (condition === "generating") data.web.generation = condition;
    if (condition === "nonempty") data.web.composer = condition;
    if (condition === "mismatch") data.web.routeMatches = false;
    expect(model().derive(data, now).web).not.toBe("可接收结果");
  });
  it.each([undefined, { ready: false, reason: "web_sink_not_ready" }])("missing or incomplete readiness cannot receive", connectionReadiness => {
    const data = response();
    expect(model().derive({ ...data, web: { ...data.web, connectionReadiness } }, now).web)
      .toBe("当前对话需要完成连接");
  });
  it("stale or unreachable service makes both endpoints unknown", () => {
    expect(model().derive(response(), now + 46_000)).toMatchObject({ codex: "无法确认", web: "无法确认", serviceFresh: false });
    expect(model().derive(response({ ok: false }), now)).toMatchObject({ codex: "无法确认", web: "无法确认", rows: [] });
  });
  it("only exact observed attempt has ACK-pending label; unknown never claims success", () => {
    const data = response() as any;
    data.snapshot.commands = [{ commandId: "a", delivery: { status: "accepted" }, executions: [], feedback: [
      { eventId: "e", attemptId: "a", status: "outcome_unknown" }, { eventId: "e", attemptId: "b", status: "outcome_unknown" }] }];
    data.journal = { state: "OBSERVED_PENDING_ACK", eventId: "e", attemptId: "a" };
    const row = model().derive(data, now).rows[0];
    expect(row.executionLabel).toBe("执行未确认");
    expect(row.feedback.map((event: any) => event.label)).toEqual(["网页已观察 · 待确认", "发送结果待核实"]);
    expect(row.needsAttention).toBe(true);
  });
  it("panel scripts parse as classic, have no HTML injection or persistent-history writer", () => {
    for (const file of ["operations/view.js", "operations/operations.js", "popup/operations-summary.js"]) {
      const source = fs.readFileSync(`browser-companion/${file}`, "utf8");
      expect(() => new vm.Script(source)).not.toThrow();
      expect(source).not.toMatch(/innerHTML|chrome\.storage|localStorage|\.click\(/);
    }
    const source = fs.readFileSync("browser-companion/operations/operations.js", "utf8");
    expect([...source.matchAll(/type: "([^"]+)"/g)].map(match => match[1])).toEqual([
      "c2c.operations.action", "c2c.operations.result.read", "c2c.operations.action",
      "c2c.operations.action", "c2c.operations.action", "c2c.operations.read",
    ]);
  });
  it("historical accepted without a record is debt; administrative closure never displays success", () => {
    const data = response() as any;
    data.snapshot.commands = [{ commandId: "old", scope: "historical", delivery: { status: "accepted" }, executions: [], feedback: [], issues: ["empty_lifecycle_lock"], administrative: "abandoned" }];
    const row = model().derive(data, now).rows[0];
    expect(row).toMatchObject({ needsAttention: true, active: false, scopeLabel: "历史遗留", executionLabel: "执行未确认", administrativeLabel: "已行政结束等待" });
    expect(row.issueLabels).toContain("空生命周期锁，需人工核验");
  });
});


describe("B2 connection/maintenance and B5 manual panel actions", () => {
  function authorized() {
    const input = pair();
    const companionId = readFeedbackState(workspace.id, stateDir).companion!.companionId;
    grantPanelActions({ workspaceId: workspace.id, companionId, localUser: true, stateDir });
    return input;
  }
  const request = (commandId: string, action: "cancel_command" | "cancel_return" | "cleanup" | "requeue_return" = "cleanup", eventId?: string) =>
    ({ requestId: randomUUID(), commandId, action, ...(eventId ? { eventId } : {}) });
  function pendingCommand(commandId: string, mailbox?: CommandMailbox) {
    const planner = registerRoute(workspace, { platform: "chatgpt_web", role: "planner", conversationId: principal().fingerprint, locator: {} }, stateDir);
    const executor = registerRoute(workspace, { platform: "codex_desktop", role: "executor", conversationId: randomUUID(), locator: { hostId: "local", executorProjectId: "test" } }, stateDir);
    const message = mailbox?.message ?? "x";
    createCommand(workspace, { commandId, plannerRouteId: planner.routeId, executorRouteId: executor.routeId, intent: "revision",
      payloadBytes: Buffer.byteLength(message), payloadSha256: createHash("sha256").update(message).digest("hex") }, stateDir, mailbox);
  }
  it("connection ignores unrelated historical corrupt locks and performs no cleanup", async () => {
    pair(); seed("old");
    const lock = `${cleanupJournalFile(workspace.id, "old", stateDir)}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true }); fs.writeFileSync(lock, "");
    const before = fs.statSync(lock);
    const result = await tools().feedback_enable.handler({ widgetId: "widget" }, extra);
    expect(result.isError).not.toBe(true);
    expect(fs.statSync(lock).ino).toBe(before.ino); expect(fs.readFileSync(lock).length).toBe(0);
    const pairing = await tools().feedback_companion_pair.handler({}, extra);
    // Live Bridge discovery is outside this isolated fixture; direct connection use-case proves the fence.
    expect(pairing.isError).toBe(true);
    expect(withConnectionMutation({ workspaceId: workspace.id, workspaceRoot: root, stateDir }, () => "connected")).toBe("connected");
  });
  it("connection requires arbiter ownership before mutation", () => {
    pair(); const fn = vi.fn();
    const file = deliveryArbiterLockFile(workspace.id, stateDir); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "");
    expect(() => withConnectionMutation({ workspaceId: workspace.id, workspaceRoot: root, stateDir }, fn)).toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
  it("canonical GET state is byte/identity read-only with an unrelated corrupt lock", () => {
    const input = pair(); seed("old", principal().fingerprint, true);
    const lock = `${cleanupJournalFile(workspace.id, "old", stateDir)}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true }); fs.writeFileSync(lock, "");
    const before = snapshot(stateDir);
    expect(resultBusCompanionState(input)).toMatchObject({ pendingReady: 1 });
    expect(snapshot(stateDir)).toEqual(before);
  });
  it("maintenance on a pristine workspace never creates a Feedback binding or history", () => {
    const result = createWorkspaceMaintenance(workspace, stateDir)();
    expect(result.projected).toBe(0); expect(fs.existsSync(feedbackStateFile(workspace.id, stateDir))).toBe(false);
  });
  it("bounded canonical projection advances past a corrupt task without touching its fence", () => {
    pair(); for (const id of ["a", "b", "c"]) seed(id, principal().fingerprint, true);
    const lock = `${cleanupJournalFile(workspace.id, "a", stateDir)}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true }); fs.writeFileSync(lock, "");
    const first = projectAvailableResultBusCommands(workspace, stateDir, { limit: 2 });
    expect(first).toMatchObject({ next: "b", replayed: 1, skipped: [{ commandId: "a", code: "COMMAND_CLEANUP_BUSY" }] });
    expect(projectAvailableResultBusCommands(workspace, stateDir, { limit: 1, after: first.next })).toMatchObject({ next: "c", replayed: 1, skipped: [] });
    expect(fs.readFileSync(lock).length).toBe(0);
  });
  it("an exact reserved return fences connection takeover and can be safely requeued without Send", async () => {
    const input = authorized(); seed("result", principal().fingerprint, true);
    bindCurrentWebSink(workspace.id, projectChatgptRouteToWebSinkCandidate({ workspaceId: workspace.id, routeCanonical: route }));
    const reservation = reserveNextResultBusEntry(workspace, {}, stateDir); expect(reservation.status).toBe("reserved");
    fs.mkdirSync(path.dirname(deliveryArbiterLockFile(workspace.id, stateDir)), { recursive: true });
    const mutation = vi.fn(), before = snapshot(stateDir);
    expect(() => withConnectionMutation(input, mutation)).toThrow(); expect(mutation).not.toHaveBeenCalled();
    expect(withConnectionMutation({ ...input, kind: "companion" }, () => "credentials-only")).toBe("credentials-only");
    expect(snapshot(stateDir)).toEqual(before);
    const eventId = (await readCompanionOperations(input, inspect)).commands[0].feedback[0].eventId;
    const raw = request("result", "requeue_return", eventId), preview = previewPanelAction(input, raw);
    expect(confirmPanelAction(input, raw, preview.confirmationSha256)).toMatchObject({ status: "completed" });
    expect(listResultBusEntries(workspace, stateDir)[0]).toMatchObject({ deliveryStatus: "queued", reservation: null, attempt: null });
    expect(readRouting(workspace, stateDir)!.results).toHaveLength(1);
    expect(confirmPanelAction(input, raw, preview.confirmationSha256)).toMatchObject({ status: "completed", replayed: true });
  });
  it("pairing credential alone cannot authorize any manual action", () => {
    const input = pair(); seed("command", principal().fingerprint, true); const before = snapshot(stateDir);
    expect(() => previewPanelAction(input, request("command"))).toThrow(/本机/);
    expect(snapshot(stateDir)).toEqual(before);
  });
  it("local grant requires exact verified companion, local consent, and bounded expiry", () => {
    pair(); const companionId = readFeedbackState(workspace.id, stateDir).companion!.companionId;
    const before = snapshot(stateDir);
    for (const change of [{ localUser: false }, { companionId: randomUUID() }, { minutes: 61 }, { minutes: 0 }])
      expect(() => grantPanelActions({ workspaceId: workspace.id, companionId, localUser: true, stateDir, ...change })).toThrow();
    // Locks may create a directory, but no durable authority changes.
    expect(readPanelAuthorization(workspace.id, stateDir).enabled).toBe(false);
    expect(snapshot(stateDir)).toEqual(before);
  });
  it("preview is zero-write and expired/revoked grant refuses confirmation", () => {
    const input = authorized(); seed("command", principal().fingerprint, true); const before = snapshot(stateDir);
    const raw = request("command"), preview = previewPanelAction(input, raw);
    expect(snapshot(stateDir)).toEqual(before);
    revokePanelActions(workspace.id, true, stateDir);
    expect(() => confirmPanelAction(input, raw, preview.confirmationSha256)).toThrow(/本机/);
    expect(listResultBusEntries(workspace, stateDir)).toHaveLength(1);
  });
  it("confirmation binds exact request, command and state; mismatch creates no action marker", () => {
    const input = authorized(); seed("a", principal().fingerprint, true); seed("b", principal().fingerprint, true);
    const raw = request("a"), preview = previewPanelAction(input, raw);
    expect(() => confirmPanelAction(input, { ...raw, commandId: "b" }, preview.confirmationSha256)).toThrow(/变化/);
    expect(readFeedbackState(workspace.id, stateDir).panelOperations).toBeUndefined();
    expect(listResultBusEntries(workspace, stateDir)).toHaveLength(2);
  });
  it("cancels a proven pending command and fences generic dispatch before external work", () => {
    const input = authorized(); pendingCommand("pending");
    const raw = request("pending", "cancel_command"), preview = previewPanelAction(input, raw);
    expect(confirmPanelAction(input, raw, preview.confirmationSha256).status).toBe("completed");
    expect(readRouting(workspace, stateDir)!.commands[0]).toMatchObject({ deliveryStatus: "rejected", cancelledAt: expect.any(String) });
    expect(() => assertCommandNotCancelled(workspace, "pending", stateDir)).toThrow(/取消/);
    expect(() => beginExecutorDispatch({ workspaceId: workspace.id, workspaceRoot: root, bindingId: randomUUID(), commandId: "pending", intent: "revision", message: "x", requestAuthoritySha256: "a".repeat(64), stateDir })).toThrow(/取消/);
    const before = snapshot(stateDir);
    expect(confirmPanelAction(input, raw, preview.confirmationSha256)).toMatchObject({ status: "completed", replayed: true });
    // The arbiter/command directory already exists; exact replay is no-write.
    expect(snapshot(stateDir)).toEqual(before);
  });
  it("cancel preview rejects dispatching and non-whitelisted blocked inboxes before writing a marker", () => {
    const input = authorized();
    const inbox = (state: CommandMailbox["state"], reason?: string): CommandMailbox => ({
      kind: "executor", state, message: "private payload", clientId: "private-client", tokenHash: "f".repeat(64),
      bindingId: randomUUID(), desktopBindingId: randomUUID(), plannerFingerprint: principal().fingerprint,
      ...(reason ? { reason } : {}),
    });
    for (const [commandId, mailbox] of [
      ["dispatching", inbox("dispatching")], ["unsafe-blocked", inbox("blocked", "DESKTOP_BUSY")],
    ] as const) {
      pendingCommand(commandId, mailbox);
      const before = snapshot(stateDir);
      expect(() => previewPanelAction(input, request(commandId, "cancel_command"))).toThrow("尚未进入外部投递边界");
      expect(readFeedbackState(workspace.id, stateDir).panelOperations).toBeUndefined();
      expect(snapshot(stateDir)).toEqual(before);
    }
    pendingCommand("safe-blocked", inbox("blocked", "UNAUTHORIZED"));
    expect(previewPanelAction(input, request("safe-blocked", "cancel_command")).confirmationSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("accepted task cannot be cancelled or cleaned as if unsent", () => {
    const input = authorized(); seed("accepted");
    for (const action of ["cancel_command", "cleanup"] as const) expect(() => previewPanelAction(input, request("accepted", action))).toThrow();
    expect(readRouting(workspace, stateDir)!.commands[0].deliveryStatus).toBe("accepted");
  });
  it("cancelled queued return retains result and cannot become a new reservation", async () => {
    const input = authorized(); seed("result", principal().fingerprint, true);
    const eventId = (await readCompanionOperations(input, inspect)).commands[0].feedback[0].eventId;
    const raw = request("result", "cancel_return", eventId), preview = previewPanelAction(input, raw);
    confirmPanelAction(input, raw, preview.confirmationSha256);
    expect(listResultBusEntries(workspace, stateDir)[0]).toMatchObject({ deliveryStatus: "cancelled", cancelledAt: expect.any(String), attempt: null });
    expect(readRouting(workspace, stateDir)!.results).toHaveLength(1);
    expect(() => previewPanelAction(input, request("result", "requeue_return", eventId))).toThrow();
  });
  it("new reservation between preview and confirm blocks cancellation without changing it", async () => {
    const input = authorized(); seed("result", principal().fingerprint, true);
    const eventId = (await readCompanionOperations(input, inspect)).commands[0].feedback[0].eventId;
    const raw = request("result", "cancel_return", eventId), preview = previewPanelAction(input, raw);
    const file = path.join(stateDir, "result-bus", `${workspace.id}.json`), state = JSON.parse(fs.readFileSync(file, "utf8"));
    state.entries[0].deliveryStatus = "reserved"; state.entries[0].reservation = { reservationId: randomUUID(), reservedAt: new Date().toISOString(), bindingId: randomUUID(), epoch: 1, boundAt: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(state)); const before = fs.readFileSync(file);
    expect(() => confirmPanelAction(input, raw, preview.confirmationSha256)).toThrow();
    expect(fs.readFileSync(file)).toEqual(before);
    expect(readFeedbackState(workspace.id, stateDir).panelOperations).toBeUndefined();
  });
  it("exact cleanup removes one terminal task, preserves peer and never synthesizes receipt", () => {
    const input = authorized(); seed("target", principal().fingerprint, true); seed("peer", principal().fingerprint, true);
    const raw = request("target"), preview = previewPanelAction(input, raw);
    expect(confirmPanelAction(input, raw, preview.confirmationSha256).status).toBe("completed");
    expect(readRouting(workspace, stateDir)!.commands.map(item => item.commandId)).toEqual(["peer"]);
    expect(listResultBusEntries(workspace, stateDir).map(item => item.commandId)).toEqual(["peer"]);
    expect(confirmPanelAction(input, raw, preview.confirmationSha256)).toMatchObject({ status: "completed", replayed: true });
  });
  it("corrupt lifecycle authority stays intact and no pending operation is created", () => {
    const input = authorized(); seed("target", principal().fingerprint, true);
    const raw = request("target"), preview = previewPanelAction(input, raw);
    const file = `${cleanupJournalFile(workspace.id, "target", stateDir)}.lock`;
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "");
    expect(() => confirmPanelAction(input, raw, preview.confirmationSha256)).toThrow();
    expect(fs.readFileSync(file).length).toBe(0); expect(readFeedbackState(workspace.id, stateDir).panelOperations).toBeUndefined();
  });
  it("crash after cancellation commit is reconciled by exact domain proof without repeating the mutation", () => {
    const input = authorized(); pendingCommand("pending");
    const raw = request("pending", "cancel_command"), preview = previewPanelAction(input, raw);
    const rename = fs.renameSync; let writes = 0;
    const fault = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === feedbackStateFile(workspace.id, stateDir) && ++writes === 2) throw new Error("final receipt write failed");
      return rename(from, to);
    });
    expect(() => confirmPanelAction(input, raw, preview.confirmationSha256)).toThrow("final receipt"); fault.mockRestore();
    expect(readRouting(workspace, stateDir)!.commands[0].cancelledAt).toBeTruthy();
    expect(confirmPanelAction(input, raw, preview.confirmationSha256)).toMatchObject({ status: "pending", replayed: true });
    const bytes = fs.readFileSync(routingFile(workspace.id, stateDir));
    expect(reconcilePanelAction(input, raw.requestId)).toMatchObject({ status: "completed", reconciled: true });
    expect(fs.readFileSync(routingFile(workspace.id, stateDir))).toEqual(bytes);
  });
  it("crash before domain mutation stays pending and cannot block a different task", () => {
    const input = authorized(); pendingCommand("pending"); pendingCommand("other");
    const raw = request("pending", "cancel_command"), preview = previewPanelAction(input, raw);
    const rename = fs.renameSync;
    const fault = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === routingFile(workspace.id, stateDir)) throw new Error("before domain commit");
      return rename(from, to);
    });
    expect(() => confirmPanelAction(input, raw, preview.confirmationSha256)).toThrow(); fault.mockRestore();
    expect(reconcilePanelAction(input, raw.requestId)).toMatchObject({ status: "pending", reconciled: false });
    expect(previewPanelAction(input, request("other", "cancel_command")).confirmationSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("pending action after interruption is visible and blocks new request IDs", () => {
    const input = authorized(); seed("target", principal().fingerprint, true);
    const file = feedbackStateFile(workspace.id, stateDir), state = JSON.parse(fs.readFileSync(file, "utf8"));
    state.panelOperations = [{ requestId: randomUUID(), grantId: state.panelGrant.grantId, commandId: "target", action: "cleanup", confirmationSha256: "a".repeat(64), requestSha256: "b".repeat(64), status: "pending", createdAt: new Date().toISOString() }];
    fs.writeFileSync(file, JSON.stringify(state)); const before = snapshot(stateDir);
    expect(readPanelAuthorization(workspace.id, stateDir).pending).toHaveLength(1);
    expect(() => previewPanelAction(input, request("target"))).toThrow(/换 ID/);
    expect(snapshot(stateDir)).toEqual(before);
  });
});


describe("B5 extension manual action crash and sender boundaries", () => {
  function worker() {
    const stored: Record<string, any> = {};
    const ctx: any = { console, URL, project: { workspaceId: "aaaaaaaaaaaa" }, encodeURIComponent, storageProtected: true, transport: { credential: "test", workspaceId: "aaaaaaaaaaaa" }, authFailureRevision: 0,
      autonomyPolicy: { mode: "off" }, productionSendInFlight: false, autonomyTickInFlight: false, connectInFlight: false,
      journal: { state: "NONE" }, requestTransports: new WeakMap(), assertNoForbiddenFields: vi.fn(),
      isCurrentTransportResponse: () => true, clearJournal: () => ({ state: "NONE" }), persistJournal: vi.fn(),
      chrome: { runtime: { id: "extension", getURL: (file: string) => `chrome-extension://extension/${file}` },
        storage: { local: { get: async (key: string) => ({ [key]: stored[key] }), set: vi.fn(async (value: any) => Object.assign(stored, JSON.parse(JSON.stringify(value)))) } } },
      initPromise: Promise.resolve(), runTransportMutation: (fn: () => unknown) => fn() };
    ctx.fetchCompanion = vi.fn(async (_path: string, options: any) => {
      const request = options.body ? JSON.parse(options.body).request : undefined;
      const response = { ok: true, body: { requestId: request?.requestId, status: "completed" } };
      ctx.requestTransports.set(response, { requestAuthRevision: 0 }); return response;
    });
    const source = fs.readFileSync("browser-companion/service-worker.js", "utf8");
    const context = vm.createContext(ctx);
    vm.runInContext(source.slice(source.indexOf('function isOwnOperationsPanel('), source.indexOf('const LOCAL_KEY =')), context);
    vm.runInContext(source.slice(source.indexOf('const PANEL_ACTION_KEY ='), source.indexOf('async function handleMessage(')) + '\nglobalThis.action = panelAction;', context);
    const handler = source.slice(source.indexOf('async function handleMessage('), source.indexOf('  if (message.type === "c2c.operations.read")'));
    vm.runInContext(handler + '\nreturn { ok: false, reason: "unsupported" }; } globalThis.routeAction = handleMessage;', context);
    return { ctx, stored, action: ctx.action, routeAction: ctx.routeAction };
  }
  const raw = (commandId = "one") => ({ requestId: randomUUID(), commandId, action: "cleanup" });
  const confirm = (request = raw()) => ({ phase: "confirm", request, confirmationSha256: "a".repeat(64), confirmed: true });
  it("content scripts and spoofed extension senders cannot call panel actions", async () => {
    const { ctx, routeAction } = worker();
    for (const sender of [{ id: "extension", url: "https://chatgpt.com/c/x", tab: { id: 1 } }, { id: "foreign", url: "chrome-extension://extension/operations/operations.html" }])
      expect(await routeAction({ type: "c2c.operations.action", ...confirm() }, sender)).toMatchObject({ ok: false, reason: "extension_panel_required" });
    expect(ctx.fetchCompanion).not.toHaveBeenCalled(); expect(ctx.chrome.storage.local.set).not.toHaveBeenCalled();
  });
  it("panel actions require the exact extension page and explicit project query", async () => {
    const { ctx, routeAction } = worker();
    const panel = "chrome-extension://extension/operations/operations.html?workspaceId=aaaaaaaaaaaa";
    for (const url of [panel.replace("extension/operations", "foreign/operations"), panel.replace("aaaaaaaaaaaa", "bbbbbbbbbbbb"), `${panel}&workspaceId=aaaaaaaaaaaa`, `${panel}#changed`]) {
      expect(await routeAction({ type: "c2c.operations.action", ...confirm() }, {
        id: "extension", url, tab: { id: 1, url },
      })).toMatchObject({ ok: false, reason: "extension_panel_required" });
    }
    expect(ctx.fetchCompanion).not.toHaveBeenCalled();
    expect(await routeAction({ type: "c2c.operations.action", ...confirm() }, {
      id: "extension", url: panel, tab: { id: 1, url: panel },
    })).toMatchObject({ ok: true });
  });
  it.each(["armed", "claimed", "unknown", "sending"])("%s prevents manual side effects", async mode => {
    const { ctx, action } = worker();
    if (mode === "armed") ctx.autonomyPolicy.mode = "armed";
    if (mode === "claimed" || mode === "unknown") ctx.journal = { state: mode === "claimed" ? "CLAIMED" : "OUTCOME_UNKNOWN" };
    if (mode === "sending") ctx.productionSendInFlight = true;
    expect((await action(confirm())).ok).toBe(false);
    expect(ctx.fetchCompanion).not.toHaveBeenCalled(); expect(ctx.chrome.storage.local.set).not.toHaveBeenCalled();
  });
  it("explicit checkbox is required before durable intent or POST", async () => {
    const { ctx, action } = worker();
    expect(await action({ ...confirm(), confirmed: false })).toMatchObject({ reason: "explicit_confirmation_required" });
    expect(ctx.fetchCompanion).not.toHaveBeenCalled(); expect(ctx.chrome.storage.local.set).not.toHaveBeenCalled();
  });
  it("lost response persists pending, blocks same-command new-ID retry, and isolates another task", async () => {
    const { ctx, action, stored } = worker();
    ctx.fetchCompanion.mockRejectedValue(new Error("network"));
    expect(await action(confirm())).toMatchObject({ reason: "panel_operation_unknown" });
    expect(Object.values(stored)[0].operations[0].status).toBe("pending");
    expect(await action(confirm(raw("one")))).toMatchObject({ reason: "panel_operation_unknown" });
    expect(ctx.fetchCompanion).toHaveBeenCalledTimes(1);
    await action({ phase: "preview", request: raw("other") });
    expect(ctx.fetchCompanion).toHaveBeenCalledTimes(2);
  });
  it("known pre-mutation rejection permits a fresh preview without erasing unknown evidence", async () => {
    const { ctx, action, stored } = worker(), request = raw();
    ctx.fetchCompanion.mockImplementation(async () => {
      const response = { ok: false, body: { error: "PANEL_CONFIRMATION_MISMATCH", noMutation: true, requestId: request.requestId } };
      ctx.requestTransports.set(response, { requestAuthRevision: 0 }); return response;
    });
    expect(await action(confirm(request))).toMatchObject({ reason: "PANEL_CONFIRMATION_MISMATCH" });
    expect(Object.values(stored)[0].operations[0].status).toBe("rejected");
  });
  it("stale transport response leaves pending evidence and delivery journal intact", async () => {
    const { ctx, action, stored } = worker(); ctx.isCurrentTransportResponse = () => false;
    const before = ctx.journal;
    expect(await action(confirm())).toMatchObject({ reason: "stale_transport_response" });
    expect(Object.values(stored)[0].operations[0].status).toBe("pending"); expect(ctx.journal).toBe(before);
  });
  it("read-only check never resends a lost operation and only exact completed proof closes it", async () => {
    const { ctx, action, stored } = worker(), request = raw();
    ctx.fetchCompanion.mockRejectedValueOnce(new Error("network")); await action(confirm(request));
    ctx.fetchCompanion.mockImplementation(async (_path: string, options: any) => {
      expect(options.method).toBe("GET"); const response = { ok: true, body: { requestId: request.requestId, status: "unknown" } };
      ctx.requestTransports.set(response, { requestAuthRevision: 0 }); return response;
    });
    expect((await action({ phase: "check" })).status).toBe("unknown");
    expect(Object.values(stored)[0].operations[0].status).toBe("pending");
    ctx.fetchCompanion.mockImplementation(async () => { const response = { ok: true, body: { requestId: request.requestId, status: "completed" } };
      ctx.requestTransports.set(response, { requestAuthRevision: 0 }); return response; });
    expect((await action({ phase: "check" })).status).toBe("completed");
    expect(Object.values(stored)[0].operations[0].status).toBe("completed");
  });
  it("auth revision drift prevents reconciliation response from clearing pending evidence", async () => {
    const { ctx, action, stored } = worker(), request = raw();
    ctx.fetchCompanion.mockRejectedValueOnce(new Error("network")); await action(confirm(request));
    ctx.fetchCompanion.mockImplementation(async () => {
      const response = { ok: true, body: { requestId: request.requestId, status: "completed" } };
      ctx.requestTransports.set(response, { requestAuthRevision: 0 }); ctx.authFailureRevision = 1; return response;
    });
    expect((await action({ phase: "reconcile", requestId: request.requestId })).ok).toBe(false);
    expect(Object.values(stored)[0].operations[0].status).toBe("pending");
  });
  it("pending and completed panel intents are isolated by workspace even for identical command and request IDs", async () => {
    const { ctx, action, stored } = worker(), request = raw();
    ctx.fetchCompanion.mockRejectedValueOnce(new Error("network")); await action(confirm(request));
    ctx.transport = { credential: "other-workspace", workspaceId: "bbbbbbbbbbbb" };
    expect(await action({ phase: "check" })).toMatchObject({ status: "none" });
    expect(await action(confirm(request))).toMatchObject({ status: "completed" });
    const journal = Object.values(stored)[0];
    expect(journal.operations).toHaveLength(2);
    expect(journal.operations.find((item: any) => item.workspaceId === "aaaaaaaaaaaa").status).toBe("pending");
    expect(journal.operations.find((item: any) => item.workspaceId === "bbbbbbbbbbbb").status).toBe("completed");
    ctx.transport = { credential: "original-workspace", workspaceId: "aaaaaaaaaaaa" };
    expect(await action(confirm(request))).toMatchObject({ reason: "panel_operation_unknown" });
    expect(ctx.fetchCompanion).toHaveBeenCalledTimes(2);
  });
  it("an operation journal without workspace identity is preserved and refuses mutation", async () => {
    const { ctx, action, stored } = worker(), request = raw();
    stored["c2c.panel.action.v1"] = { version: 1, operations: [{ request, status: "pending" }] };
    const before = JSON.stringify(stored);
    expect(await action(confirm(request))).toMatchObject({ reason: "panel_journal_corrupt" });
    expect(ctx.fetchCompanion).not.toHaveBeenCalled(); expect(JSON.stringify(stored)).toBe(before);
  });
  it("storage failure before request means zero POST", async () => {
    const { ctx, action } = worker(); ctx.chrome.storage.local.set.mockRejectedValue(new Error("disk"));
    await expect(action(confirm())).rejects.toThrow("disk"); expect(ctx.fetchCompanion).not.toHaveBeenCalled();
  });
});
