import { repairDigest, repairPaths, repairSnapshot } from "../src/command-cleanup/abandonment-repair-store.js";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { makeTmpDir, cleanup } from "./helpers.js";
import { previewWorkspaceHistoryFormat, confirmWorkspaceHistoryFormat, workspaceHistoryFormatResult } from "../src/command-cleanup/workspace-history.js";
import { workspaceHistoryJournalFile } from "../src/command-cleanup/legacy-history-fence.js";
import { registerCleanupCommands } from "../src/cli/cleanup.js";
import { appendExecutionRecord, readExecutionRecordsStrict } from "../src/execution/records.js";
import { saveExecutionOutput, readExecutionOutputIndexStrict } from "../src/execution/output.js";
import { readRemote, updateRemote, setRemoteEnabled, type RemoteTask } from "../src/remote/store.js";
import { projectRemoteResult } from "../src/remote/results.js";
import { updateDesktop, readDesktop } from "../src/desktop/store.js";
import { registerRoute, readRouting } from "../src/routing/store.js";
import { readResultBus, withResultBusTransaction } from "../src/result-bus/store.js";
import { reconcileWorkspaceResultBus } from "../src/result-bus/service.js";
import { reserveNextResultBusEntry, beginResultBusSend, ackResultBusObserved, markResultBusOutcomeUnknown, isolateResultBusAttempt } from "../src/result-bus/delivery-lifecycle.js";
import { ensureFeedbackState, readFeedbackStatusState } from "../src/feedback/state-store.js";
import { reconcileFeedbackOutbox } from "../src/feedback/projector.js";
import { withCommandOperationAsync, cleanupJournalFile } from "../src/command-cleanup/fence.js";
import { bindCurrentWebSink, projectChatgptRouteToWebSinkCandidate } from "../src/web-sink-control/index.js";
import { resolveConversationPrincipal } from "../src/mcp/conversation-principal.js";
import { enableReceiver } from "../src/feedback/receiver.js";
import { createPairingIntent, exchangePairingIntent, confirmRouteAttestation } from "../src/feedback/companion.js";
import { grantPanelActions } from "../src/feedback/panel.js";
import { previewCompanionFormat, confirmCompanionFormat, readCompanionFormatResult } from "../src/bridge/companion-format.js";

let root: string, state: string, workspace: Workspace;
const route = "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111";
beforeEach(() => { root = makeTmpDir("format-root"); state = makeTmpDir("format-state"); workspace = new Workspace(root); vi.stubEnv("C2C_STATE_DIR", state); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); cleanup(root); cleanup(state); });
const preview = () => previewWorkspaceHistoryFormat(workspace, state);
const confirm = (hash: string, hook?: (stage: string) => void) => confirmWorkspaceHistoryFormat(workspace, hash, state, hook);
function bytes() {
  const result: Record<string, string> = {};
  const walk = (dir: string) => { for (const name of fs.readdirSync(dir)) { const file = path.join(dir, name); if (fs.lstatSync(file).isDirectory()) walk(file); else result[path.relative(state, file)] = fs.readFileSync(file).toString("hex"); } };
  walk(state); return result;
}
function task(index: number): RemoteTask {
  const now = new Date().toISOString();
  return { taskId: randomUUID(), targetId: randomUUID(), threadId: randomUUID(), turnId: randomUUID(), workspaceId: workspace.id,
    commandId: `old-${index}`, kind: "ANALYZE", goal: "old private task", clientId: "local", status: index === 15 ? "cancelled" : "completed",
    createdAt: now, updatedAt: now, completedAt: now, finalResponse: { text: "old private output", truncated: false }, recorded: true, resultProjected: true };
}
function seed(full = false) {
  const tasks = Array.from({ length: full ? 16 : 1 }, (_, i) => task(i));
  setRemoteEnabled(workspace, false, { deliveryMode: "official" });
  updateRemote(workspace.id, previous => ({ state: { ...previous!, tasks,
    targets: [{ targetId: tasks[0]!.targetId!, hostId: "local", workspaceId: workspace.id, workspaceRoot: root,
      threadId: tasks[0]!.threadId, createdAt: tasks[0]!.createdAt, source: "created", clientId: "local" }],
    threads: [{ workspaceId: workspace.id, requestId: "old-thread", clientId: "local", source: "created", threadId: tasks[0]!.threadId,
      status: "completed", createdAt: tasks[0]!.createdAt, updatedAt: tasks[0]!.updatedAt }],
    audit: [{ timestamp: tasks[0]!.createdAt, clientId: "local", action: "old-action", id: "old-audit", result: "completed" }] }, result: undefined }), state);
  registerRoute(workspace, { role: "planner", platform: "chatgpt_web", conversationId: randomUUID(), locator: {} }, state);
  updateDesktop(workspace.id, () => ({ state: { version: 1, workspaceId: workspace.id, workspaceRoot: root, enabled: true,
    binding: { bindingId: randomUUID(), threadId: randomUUID(), hostId: "local", projectId: "preserve", title: "preserve", boundAt: new Date().toISOString() }, deliveries: [] }, result: null }), state);
  bindCurrentWebSink(workspace.id, projectChatgptRouteToWebSinkCandidate({ workspaceId: workspace.id, routeCanonical: route }));
  for (const [index, item] of tasks.slice(0, full ? 13 : 1).entries()) {
    const output = saveExecutionOutput(workspace.id, { command: "old", raw: item.finalResponse!.text, taskId: item.taskId, commandId: item.commandId, iteration: 1 }, state);
    item.outputId = output.id; item.outputAvailable = true;
    appendExecutionRecord(workspace.id, { taskId: item.taskId, commandId: item.commandId, iteration: 1, changedFiles: [], tests: null,
      exitStatus: "completed", timestamp: item.completedAt!, outputId: output.id, outputAvailable: true }, state);
    projectRemoteResult(workspace, item);
    const reservation = reserveNextResultBusEntry(workspace, {}, state);
    if (reservation.status !== "reserved") throw Error("fixture reserve failed");
    const sent = beginResultBusSend(workspace, { busEntryId: reservation.entry.busEntryId, reservationId: reservation.entry.reservation!.reservationId }, {}, state);
    if (index < 10) ackResultBusObserved(workspace, { busEntryId: sent.entry.busEntryId, attemptId: sent.attemptId }, {}, state);
    else {
      markResultBusOutcomeUnknown(workspace, { busEntryId: sent.entry.busEntryId, attemptId: sent.attemptId }, {}, state);
      isolateResultBusAttempt(workspace, { busEntryId: sent.entry.busEntryId, attemptId: sent.attemptId, reservationId: sent.entry.reservation!.reservationId }, state);
    }
  }
  updateRemote(workspace.id, previous => ({ state: { ...previous!, tasks }, result: undefined }), state);
  ensureFeedbackState(workspace.id, full ? 13 : 1, state);
  return tasks;
}
function pair() {
  const principal = resolveConversationPrincipal({ authInfo: { token: "fixture", clientId: "fixture", scopes: ["codex.feedback"] }, _meta: { "openai/session": "fixture" } } as never);
  enableReceiver({ workspaceId: workspace.id, principal, widgetId: "fixture", stateDir: state });
  const intent = createPairingIntent({ workspaceId: workspace.id, principal, stateDir: state });
  const paired = exchangePairingIntent({ workspaceId: workspace.id, intentId: intent.intentId, secret: intent.secret, routeCanonical: route, stateDir: state });
  confirmRouteAttestation({ workspaceId: workspace.id, principal, challengeId: paired.routeAttestation.challengeId, challengeDigest: paired.routeAttestation.challengeDigest, stateDir: state });
  return { input: { workspaceId: workspace.id, workspaceRoot: root, credential: paired.credential, stateDir: state }, companionId: paired.companionId };
}
it("preview is zero-write and pristine state is not_found", () => {
  expect(preview().status).toBe("not_found"); expect(fs.readdirSync(state)).toEqual([]);
  seed(); const before = bytes(); expect(preview().counts).toMatchObject({ tasks: 1, records: 1, outputs: 1, resultBus: 1 }); expect(bytes()).toEqual(before);
});
it("formats official 16/13/3 history, preserves configuration and other workspace, and prevents backfill", () => {
  const tasks = seed(true), desktop = readDesktop(workspace.id, state), routing = readRouting(workspace, state), remote = readRemote(workspace.id, state)!;
  const nextId = readExecutionOutputIndexStrict(workspace.id, state).nextId, beforeBusRevision = readResultBus(workspace, state)!.revision;
  const unrelated = path.join(state, "remote-control", "aaaaaaaaaaaa.json"); fs.writeFileSync(unrelated, "preserve unrelated");
  fs.mkdirSync(path.join(state, "auth")); fs.writeFileSync(path.join(state, "auth", `${workspace.id}.json`), "preserve OAuth");
  const hash = preview().confirmationSha256!, result = confirm(hash);
  expect(result).toMatchObject({ status: "cleaned", confirmationSha256: hash, counts: { tasks: 16, records: 13, outputs: 13, resultBus: 13 } });
  expect(readRemote(workspace.id, state)).toEqual({ ...remote, tasks: [], threads: [], audit: [] });
  expect(readDesktop(workspace.id, state)).toEqual({ ...desktop, revision: desktop!.revision! + 1 });
  expect(readRouting(workspace, state)).toEqual({ ...routing, revision: routing!.revision + 1 });
  expect(readResultBus(workspace, state)).toMatchObject({ entries: [], revision: beforeBusRevision + 1 });
  expect(readExecutionRecordsStrict(workspace.id, state)).toEqual([]);
  expect(readExecutionOutputIndexStrict(workspace.id, state)).toEqual({ nextId, items: [] });
  expect(fs.readdirSync(path.join(state, "execution-outputs", workspace.id, "bodies"))).toEqual([]);
  expect(readFeedbackStatusState(workspace.id, state)).toMatchObject({ events: [], projectionCursor: 0, historyFormatSha256: hash });
  expect(workspaceHistoryFormatResult(workspace, hash, state).status).toBe("cleaned");
  expect(() => projectRemoteResult(workspace, tasks[0]!)).toThrow("stale");
  expect(reconcileWorkspaceResultBus(workspace, state)).toEqual({ projected: 0, replayed: 0 });
  expect(reconcileFeedbackOutbox(workspace.id, state, root)).toMatchObject({ projected: 0 });
  expect(fs.readFileSync(unrelated, "utf8")).toBe("preserve unrelated");
  expect(fs.readFileSync(path.join(state, "auth", `${workspace.id}.json`), "utf8")).toBe("preserve OAuth");
  expect(preview().status).toBe("not_found"); expect(fs.existsSync(workspaceHistoryJournalFile(workspace.id, state))).toBe(false);
  expect(JSON.stringify(bytes())).not.toContain("old-private");
});
it("drift or wrong hash refuses before deletion", () => {
  seed(); const hash = preview().confirmationSha256!;
  appendExecutionRecord(workspace.id, { taskId: "new", iteration: 0, changedFiles: [], tests: null, exitStatus: "ok", timestamp: new Date().toISOString() }, state);
  const before = bytes();
  try { confirm(hash); throw Error("expected refusal"); } catch (error) { expect(error).toMatchObject({ formatNoMutation: true, workspaceId: workspace.id, confirmationSha256: hash }); }
  expect(bytes()).toEqual(before);
  expect(() => confirm("f".repeat(64))).toThrow(); expect(bytes()).toEqual(before);
});
it.each(["journal", "remote-control", "executions", "feedback"])("resumes interrupted %s with same exact hash and fences writers", stage => {
  seed(); const hash = preview().confirmationSha256!;
  expect(() => confirm(hash, at => { if (at === stage || at.startsWith(`${stage}/`)) throw Error("interrupted"); })).toThrow("interrupted");
  expect(preview()).toMatchObject({ status: "preview", pending: true, confirmationSha256: hash });
  expect(workspaceHistoryFormatResult(workspace, hash, state).status).toBe("pending");
  for (const write of [() => updateRemote(workspace.id, previous => ({ state: previous!, result: 0 }), state),
    () => appendExecutionRecord(workspace.id, { taskId: "new", iteration: 0, changedFiles: [], tests: null, exitStatus: "ok", timestamp: new Date().toISOString() }, state),
    () => saveExecutionOutput(workspace.id, { command: "new", raw: "new" }, state),
    () => withResultBusTransaction(workspace, previous => ({ state: previous, noWrite: true, result: null }), state),
    () => registerRoute(workspace, { role: "planner", platform: "chatgpt_web", conversationId: randomUUID(), locator: {} }, state),
    () => updateDesktop(workspace.id, previous => ({ state: previous!, result: null }), state),
    () => ensureFeedbackState(workspace.id, 0, state)]) expect(write).toThrow();
  expect(confirm(hash).status).toBe("cleaned"); expect(preview().status).toBe("not_found");
});
it.each(["task", "controller", "unknown", "command-lock", "store-lock", "desktop"])("blocks %s without mutation", kind => {
  seed();
  if (kind === "task" || kind === "controller") updateRemote(workspace.id, previous => {
    if (kind === "task") previous!.tasks[0]!.status = "running";
    else previous!.controller = { pid: process.pid, instanceId: "live", heartbeatAt: Date.now(), appServer: "running" };
    return { state: previous!, result: null };
  }, state);
  if (kind === "unknown") withResultBusTransaction(workspace, previous => ({ state: { ...previous!, entries: previous!.entries.map(entry => ({ ...entry,
    deliveryStatus: "outcome_unknown", observedAt: null, outcomeUnknownAt: new Date().toISOString(), isolatedAt: null })) }, result: null }), state);
  if (kind === "command-lock") { const file = `${cleanupJournalFile(workspace.id, "live", state)}.lock`; fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "live"); }
  if (kind === "store-lock") fs.writeFileSync(path.join(state, "remote-control", `${workspace.id}.json.lock`), "unknown owner");
  if (kind === "desktop") updateDesktop(workspace.id, previous => ({ state: { ...previous!, deliveries: [{ commandId: "active", bindingId: previous!.binding!.bindingId,
    clientId: "local", threadId: previous!.binding!.threadId, turnId: randomUUID(), messageSha256: "a".repeat(64), messageBytes: 1,
    deliveryStatus: "accepted", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] }, result: null }), state);
  const before = bytes(); expect(() => preview()).toThrow(); expect(bytes()).toEqual(before);
});
it("existing async command authority prevents format and cannot write after detachment", async () => {
  seed(); let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const writer = withCommandOperationAsync(workspace.id, "in-progress", () => waiting, state);
  const before = bytes(); expect(() => preview()).toThrow(); expect(bytes()).toEqual(before); release(); await writer;
  expect(confirm(preview().confirmationSha256!).status).toBe("cleaned");
});
it("CLI confirm requires local-user; preview is read-only", async () => {
  seed(); const before = bytes();
  const run = async (...args: string[]) => { const program = new Command().exitOverride(); registerCleanupCommands(program); let stdout = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(value => { stdout += String(value); return true; }), prior = process.exitCode;
    try { await program.parseAsync(["node", "c2c", "cleanup", "workspace-history", "-w", root, "--json", ...args]); return JSON.parse(stdout); }
    finally { spy.mockRestore(); process.exitCode = prior; }
  };
  const value = await run(); expect(bytes()).toEqual(before);
  expect(await run("--confirm", value.confirmationSha256)).toMatchObject({ status: "blocked", code: "PANEL_LOCAL_AUTHORIZATION_REQUIRED" }); expect(bytes()).toEqual(before);
  expect(await run("--local-user", "--confirm", value.confirmationSha256)).toMatchObject({ status: "cleaned" });
});
it("Companion needs local expiring cleanup grant and preserves all pairing identities", () => {
  seed(); const { input, companionId } = pair(); const before = bytes();
  expect(() => previewCompanionFormat(input)).toThrow("本机"); expect(bytes()).toEqual(before);
  try { confirmCompanionFormat(input, preview().confirmationSha256!); throw Error("expected refusal"); }
  catch (error) { expect(error).toMatchObject({ formatNoMutation: true, workspaceId: workspace.id }); }
  expect(bytes()).toEqual(before);
  grantPanelActions({ workspaceId: workspace.id, companionId, localUser: true, stateDir: state });
  const feedback = readFeedbackStatusState(workspace.id, state), value = previewCompanionFormat(input), granted = bytes();
  expect(bytes()).toEqual(granted); expect(confirmCompanionFormat(input, value.confirmationSha256!).status).toBe("cleaned");
  expect(readFeedbackStatusState(workspace.id, state)).toEqual({ ...feedback, events: [], projectionCursor: 0, historyFormatSha256: value.confirmationSha256 });
  expect(readCompanionFormatResult(input, value.confirmationSha256!).status).toBe("cleaned");
});

it("empty server history still has a hash to authorize clearing scoped browser remnants", () => {
  const before = bytes(), value = preview(); expect(value).toMatchObject({ status: "not_found", counts: { tasks: 0, records: 0, resultBus: 0 } });
  expect(value.confirmationSha256).toMatch(/^[a-f0-9]{64}$/); expect(bytes()).toEqual(before);
  expect(confirm(value.confirmationSha256).status).toBe("cleaned");
  expect(workspaceHistoryFormatResult(workspace, value.confirmationSha256, state).status).toBe("cleaned");
});
it("a hard process exit leaves exact pending evidence and all locks fail closed", () => {
  seed(); const hash = preview().confirmationSha256;
  const module = pathToFileURL(path.resolve("src/command-cleanup/workspace-history.ts")).href;
  const script = `import { confirmWorkspaceHistoryFormat } from ${JSON.stringify(module)};
    confirmWorkspaceHistoryFormat(${JSON.stringify({ id: workspace.id, root })}, ${JSON.stringify(hash)}, ${JSON.stringify(state)}, stage => { if (stage === "journal") process.exit(73); });`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 30000 });
  expect(child.status, child.stderr).toBe(73);
  const before = bytes(); expect(preview()).toMatchObject({ pending: true, confirmationSha256: hash });
  expect(workspaceHistoryFormatResult(workspace, hash, state).status).toBe("pending");
  expect(() => confirm(hash)).toThrow(); expect(bytes()).toEqual(before);
  expect(() => appendExecutionRecord(workspace.id, { taskId: "new", iteration: 0, changedFiles: [], tests: null, exitStatus: "ok", timestamp: new Date().toISOString() }, state)).toThrow();
  expect(bytes()).toEqual(before);
});

function completedRepair(commandId = "old-completed-repair") {
  const repairId = randomUUID(), p = repairPaths(workspace.id, commandId, state);
  fs.mkdirSync(p.directory, { recursive: true });
  const quarantine = path.join(p.directory, `${repairId}.lock`); fs.writeFileSync(quarantine, "");
  const fingerprint = repairSnapshot(quarantine).fingerprint;
  const proof = { version: 1, workspaceId: workspace.id, workspaceRoot: root, commandIds: [commandId], repairCommandIds: [commandId],
    confirmationSha256: "a".repeat(64), bindingSha256: "b".repeat(64), deliveriesSha256: "c".repeat(64), contextSha256: "d".repeat(64),
    observations: [{ commandId, fingerprint, observedAt: "2026-01-01T00:00:00.000Z", confirmedAt: "2026-01-01T00:00:00.200Z", reason: "ZERO_BYTE_OWNER_UNKNOWN" }] };
  const journal = { version: 1, repairId, commandId, proof, repairConfirmationSha256: repairDigest(proof), normalOwner: { pid: process.pid, nonce: randomUUID() },
    state: "completed", quarantine: fingerprint, abandonmentBatchSha256: "e".repeat(64) };
  fs.writeFileSync(p.journal, JSON.stringify(journal));
  return { p, quarantine, journal };
}
it("formats 81 legal artifacts and preserves configuration and other workspace", () => {
  seed();
  for (let i = 1; i < 40; i++) saveExecutionOutput(workspace.id, { command: "old", raw: `historical output ${i}` }, state);
  const repairs = Array.from({ length: 13 }, (_, i) => completedRepair(`completed-repair-${i}`));
  const remote = readRemote(workspace.id, state)!, desktop = readDesktop(workspace.id, state);
  const unrelated = path.join(state, "remote-control", "aaaaaaaaaaaa.json"); fs.writeFileSync(unrelated, "preserve unrelated");
  const before = bytes(), value = preview();
  expect(value.counts).toMatchObject({ outputs: 40, repairHistory: 13 }); expect(bytes()).toEqual(before);
  expect(confirm(value.confirmationSha256)).toMatchObject({ status: "cleaned", counts: { outputs: 40, repairHistory: 13 } });
  expect(readRemote(workspace.id, state)).toEqual({ ...remote, tasks: [], threads: [], audit: [] });
  expect(readDesktop(workspace.id, state)).toEqual({ ...desktop, revision: desktop!.revision! + 1 });
  expect(readExecutionOutputIndexStrict(workspace.id, state).items).toEqual([]);
  expect(fs.readdirSync(path.join(state, "execution-outputs", workspace.id, "bodies"))).toEqual([]);
  for (const { p, quarantine } of repairs) { expect(fs.existsSync(p.journal)).toBe(false); expect(fs.existsSync(quarantine)).toBe(false); }
  expect(fs.readFileSync(unrelated, "utf8")).toBe("preserve unrelated");
  expect(preview().status).toBe("not_found"); expect(fs.existsSync(workspaceHistoryJournalFile(workspace.id, state))).toBe(false);
});
it.each(["complete", "partial"])("completed repair history %s is deleted with exact transaction and resumable pair", kind => {
  seed(); const { p, quarantine } = completedRepair(), before = bytes(), value = preview();
  expect(value.counts.repairHistory).toBe(1); expect(bytes()).toEqual(before);
  if (kind === "partial") {
    const relative = path.relative(state, p.journal).split(path.sep).join("/");
    expect(() => confirm(value.confirmationSha256, stage => { if (stage === relative) throw Error("interrupted repair pair"); })).toThrow("interrupted repair pair");
    expect(fs.existsSync(p.journal)).toBe(false); expect(fs.existsSync(quarantine)).toBe(true);
    expect(preview()).toMatchObject({ pending: true, confirmationSha256: value.confirmationSha256 });
  }
  expect(confirm(value.confirmationSha256).status).toBe("cleaned");
  expect(fs.existsSync(p.journal)).toBe(false); expect(fs.existsSync(quarantine)).toBe(false); expect(preview().counts.repairHistory).toBe(0);
});
it.each(["orphan", "pending", "foreign-root", "fingerprint", "active-fence"])("repair history rejects %s before mutation", kind => {
  seed(); const { p, quarantine, journal } = completedRepair();
  if (kind === "orphan") fs.unlinkSync(p.journal);
  if (kind === "pending") { journal.state = "adopted_pending"; journal.abandonmentBatchSha256 = null as never; fs.writeFileSync(p.journal, JSON.stringify(journal)); }
  if (kind === "foreign-root") { journal.proof.workspaceRoot = root + "-other"; journal.repairConfirmationSha256 = repairDigest(journal.proof); fs.writeFileSync(p.journal, JSON.stringify(journal)); }
  if (kind === "fingerprint") fs.writeFileSync(quarantine, "changed");
  if (kind === "active-fence") { fs.mkdirSync(path.dirname(p.fence), { recursive: true }); fs.writeFileSync(p.fence, "preserve active"); }
  const before = bytes(); expect(() => preview()).toThrow(); expect(bytes()).toEqual(before);
});
