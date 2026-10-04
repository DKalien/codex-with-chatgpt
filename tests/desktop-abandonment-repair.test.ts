import fs from "node:fs";
import path from "node:path";
import { AsyncResource } from "node:async_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { desktopIpc } from "../src/desktop/ipc.js";
import { DesktopError, desktopFile, readDesktop, updateDesktop } from "../src/desktop/store.js";
import { previewCorruptLockAbandonment, confirmCorruptLockAbandonment } from "../src/desktop/abandonment-repair.js";
import { withCommandOperation, withCommandOperationAsync, withWorkspaceCleanupOperation } from "../src/command-cleanup/fence.js";
import { isMaintenanceLockBusy, maintenanceLockPath, readMaintenanceLock, tryAcquireMaintenanceLock } from "../src/core/maintenance-lock.js";
import { repairPaths, repairSnapshot, repairDigest, type RepairOptions } from "../src/command-cleanup/abandonment-repair-store.js";
import { abandonmentFile, readAbandonments, previewAbandonment, abandonHistoricalAccepted } from "../src/desktop/abandonment.js";
import { desktopHistory } from "../src/desktop/history.js";
import { assessRolloutIdle } from "../src/core/rollout-idle.js";
import { legacyReconciliationFile } from "../src/desktop/legacy-reconciliation.js";
import { legacyRetirementFile } from "../src/desktop/legacy-retirement.js";
import { receiptFinalizationClaimPath } from "../src/desktop/receipt-finalizer-store.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import { saveExecutionOutput } from "../src/execution/output.js";
import type { ProcessProbe } from "../src/process/process-probe.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const currentThread = "01a00000-0000-7000-8000-000000000001", oldThread = "01a00000-0000-7000-8000-000000000002";
const binding = "01a00000-0000-7000-8000-000000000003", turn = "01a00000-0000-7000-8000-000000000004";
const commands = ["a-normal", "b-corrupt", "c-normal", "d-normal", "e-normal"], repairs = ["b-corrupt"];
const instant = "2026-01-01T00:00:00.000Z";
let root: string, state: string, workspace: Workspace, paths: ReturnType<typeof repairPaths>;
let dead: boolean, ownerState: "identified" | "missing" | "unknown";
let options: RepairOptions;
function processObservation(pid: number, creation?: string): ProcessProbe {
  const missing = Boolean(creation && dead), status = creation ? (missing ? ownerState : "identified") : "identified";
  return { pid, status, creationTime: status === "identified" ? "100" : null, executable: status === "identified" ? process.execPath : null,
    inAnyJob: null, observedAt: new Date().toISOString(), errors: { process: status === "missing" ? "PID_MISSING" : status === "unknown" ? "PROBE_UNAVAILABLE" : null,
      executable: null, creationTime: null, inAnyJob: null } };
}
function context() { return { threadId: currentThread, hostId: "local", projectId: "project", workspaceRoot: workspace.root,
  runtimeStatus: "active", resultTurnId: turn, resultTurnStatus: "inProgress", requestsCount: 0, ownerClientId: "owner" } as never; }
function tree(dir: string, base = dir): Record<string, unknown> {
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const f = path.join(dir, e.name);
    return e.isDirectory() ? Object.entries(tree(f, base)) : [[path.relative(base, f), repairSnapshot(f)]];
  }));
}
const preview = () => previewCorruptLockAbandonment(workspace, commands, repairs, options);
type Preview = Awaited<ReturnType<typeof preview>>;
const confirm = (p: Preview, opts = options) => confirmCorruptLockAbandonment(workspace, commands, repairs, p.proof, p.confirmationSha256, p.repairConfirmationSha256, opts);
function crashAt(point: string): RepairOptions { return { ...options, checkpoint: p => { if (p === point) throw new Error(`CRASH:${point}`); } }; }

async function staleReclaim(point = "after_reclaim_created") {
  const p = await preview();
  await expect(confirm(p, crashAt("after_repair_fence"))).rejects.toThrow("CRASH:after_repair_fence");
  dead = true;
  await expect(confirm(p, crashAt(point))).rejects.toThrow(`CRASH:${point}`);
  expect(isMaintenanceLockBusy(state)).toBe(false); // Ordinary exception cleanup; an OS-crashed maintenance owner is never reclaimed here.
  return p;
}

beforeEach(() => {
  root = makeTmpDir("abandon-repair-workspace"); state = makeTmpDir("abandon-repair-state");
  vi.stubEnv("C2C_STATE_DIR", state); vi.stubEnv("CODEX_THREAD_ID", currentThread);
  workspace = new Workspace(root); dead = false; ownerState = "missing";
  options = { probe: async (pid, creation) => processObservation(pid, creation) };
  vi.spyOn(desktopIpc, "currentResultContext").mockImplementation(async () => context());
  vi.spyOn(desktopIpc, "inspect").mockImplementation(async target => {
    if (target.threadId === oldThread) throw new DesktopError("DESKTOP_NO_OWNER", "no owner");
    return { ...target, runtimeStatus: "active" } as never;
  });
  updateDesktop(workspace.id, () => ({ state: { version: 1, workspaceId: workspace.id, workspaceRoot: workspace.root, enabled: true,
    binding: { bindingId: binding, threadId: currentThread, hostId: "local", projectId: "project", title: "current", boundAt: instant },
    runtimeFence: { desktopPid: 1, desktopExe: "desktop", desktopCreation: "1", appServerPid: 2, appServerExe: "app-server", appServerCreation: "2" },
    deliveries: commands.map(commandId => ({ commandId, clientId: "client", bindingId: binding, messageSha256: "a".repeat(64), messageBytes: 1,
      threadId: oldThread, turnId: turn, deliveryStatus: "accepted" as const, createdAt: instant, updatedAt: instant })) }, result: undefined }));
  paths = repairPaths(workspace.id, repairs[0]!); fs.mkdirSync(path.dirname(paths.lock), { recursive: true }); fs.writeFileSync(paths.lock, "");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); cleanup(root); cleanup(state); });

it.each(["", "broken", '{"pid":0}'])("ordinary writers remain BUSY on corrupt lock %j", async body => {
  fs.writeFileSync(paths.lock, body); const before = repairSnapshot(paths.lock), action = vi.fn();
  expect(() => withCommandOperation(workspace.id, repairs[0]!, action)).toThrow(expect.objectContaining({ code: "COMMAND_CLEANUP_BUSY" }));
  await expect(withCommandOperationAsync(workspace.id, repairs[0]!, async () => action())).rejects.toMatchObject({ code: "COMMAND_CLEANUP_BUSY" });
  expect(action).not.toHaveBeenCalled(); expect(repairSnapshot(paths.lock)).toEqual(before);
});
it("preview is zero-write, exact and contains no lock path/owner nonce/credentials", async () => {
  const before = tree(state), p = await preview();
  expect(tree(state)).toEqual(before); expect(p.commandIds).toEqual(commands); expect(p.repairCommandIds).toEqual(repairs);
  expect(p.repairConfirmationSha256).toBe(repairDigest(p.proof));
  expect(JSON.stringify(p)).not.toMatch(/\.json\.lock|nonce|adminToken|messageBody|argv/);
  expect(desktopIpc.inspect).toHaveBeenCalledTimes(2);
});
it("nonzero malformed repair stays unsupported with zero preview writes", async () => {
  fs.writeFileSync(paths.lock, "broken"); const before = tree(state);
  await expect(preview()).rejects.toThrow(); expect(tree(state)).toEqual(before);
});
it.each(["reconciliation", "retirement", "result-claim"])("refuses existing %s authority without creating repair evidence", async kind => {
  const commandId = repairs[0]!;
  const file = kind === "reconciliation" ? legacyReconciliationFile(workspace.id) : kind === "retirement" ? legacyRetirementFile(workspace.id) : receiptFinalizationClaimPath(state, workspace.id, commandId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entry = kind === "reconciliation" ? { commandId, taskId: "legacy-task", iteration: 1, outputId: 1, acceptedAt: instant, executionTimestamp: instant,
    outputTimestamp: instant, proofSha256: "0".repeat(64), reconciledAt: instant } : { commandId, deliverySha256: "0".repeat(64), observedMissingAt: instant };
  fs.writeFileSync(file, JSON.stringify(kind === "result-claim" ? { version: 1, draftId: turn, pid: process.pid, claimedAt: instant } : { version: 1, workspaceId: workspace.id, entries: [entry] }));
  if (kind !== "result-claim") fs.writeFileSync(`${file}.initialized`, "1\n");
  const before = tree(state); await expect(preview()).rejects.toThrow(); expect(tree(state)).toEqual(before);
});
it.each(["content", "replacement"])("rejects %s drift during bounded observation", async mode => {
  options.sleep = async ms => { await new Promise(r => setTimeout(r, ms));
    if (mode === "replacement") { fs.renameSync(paths.lock, `${paths.lock}.old`); fs.writeFileSync(paths.lock, ""); }
    else fs.writeFileSync(paths.lock, "changed"); };
  await expect(preview()).rejects.toThrow(); expect(fs.existsSync(paths.fence)).toBe(false);
});
it.each(["current-thread", "live-owner", "unknown-owner", "outcome-unknown", "trusted-receipt", "existing-abandonment"])("rejects eligibility %s", async mode => {
  if (mode === "current-thread") updateDesktop(workspace.id, d => ({ state: { ...d!, deliveries: d!.deliveries.map(x => ({ ...x, threadId: currentThread })) }, result: undefined }));
  if (mode === "live-owner") vi.mocked(desktopIpc.inspect).mockResolvedValue({ runtimeStatus: "idle" } as never);
  if (mode === "unknown-owner") vi.mocked(desktopIpc.inspect).mockRejectedValue(new DesktopError("DESKTOP_STATE_UNAVAILABLE", "unknown"));
  if (mode === "outcome-unknown") updateDesktop(workspace.id, d => ({ state: { ...d!, deliveries: [...d!.deliveries, { ...d!.deliveries[0]!, commandId: "unknown", deliveryStatus: "outcome_unknown", turnId: undefined }] }, result: undefined }));
  if (mode === "trusted-receipt") {
    const file = path.join(state, "executions", `${workspace.id}.jsonl`); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ taskId: "desktop_b-corrupt", iteration: 1, changedFiles: [], tests: "ok", exitStatus: "ok", timestamp: instant,
      commandId: "b-corrupt", desktopReceiptSha256: "0".repeat(64) }) + "\n");
  }
  if (mode === "existing-abandonment") {
    fs.unlinkSync(paths.lock); const p = previewAbandonment(workspace, commands); await abandonHistoricalAccepted(workspace, commands, p.confirmationSha256); fs.writeFileSync(paths.lock, "");
  }
  const before = tree(state); await expect(preview()).rejects.toThrow(); expect(tree(state)).toEqual(before);
});
it.each([".reclaim", ".repair", ".repair.reclaim", ".repair.tmp"])("unknown/corrupt sidecar %s fences both preview and ordinary writers", async suffix => {
  fs.writeFileSync(paths.lock + suffix, ""); const before = tree(state);
  await expect(preview()).rejects.toThrow(); expect(() => withCommandOperation(workspace.id, repairs[0]!, () => true)).toThrow();
  expect(tree(state)).toEqual(before);
});
it("cleanup journal/temp and hardlinked or symlinked targets refuse without adoption", async () => {
  fs.writeFileSync(paths.lock.slice(0, -5), "{}"); await expect(preview()).rejects.toThrow();
  fs.unlinkSync(paths.lock.slice(0, -5));
  fs.writeFileSync(paths.lock.slice(0, -5) + ".anything.tmp", ""); await expect(preview()).rejects.toThrow();
  fs.unlinkSync(paths.lock.slice(0, -5) + ".anything.tmp");
  fs.linkSync(paths.lock, paths.lock + ".hardlink"); await expect(preview()).rejects.toThrow(); fs.unlinkSync(paths.lock + ".hardlink");
  fs.renameSync(paths.lock, paths.lock + ".target"); fs.symlinkSync(paths.lock + ".target", paths.lock);
  await expect(preview()).rejects.toThrow(); expect(fs.existsSync(paths.fence)).toBe(false);
});
it.each(["abandonment", "repair", "fingerprint", "selection", "binding", "maintenance", "preview-turn"])("confirm rejects %s drift before adoption", async mode => {
  const p = await preview();
  if (mode === "abandonment") p.confirmationSha256 = "f".repeat(64);
  if (mode === "repair") p.repairConfirmationSha256 = "f".repeat(64);
  if (mode === "fingerprint") { fs.renameSync(paths.lock, paths.lock + ".old"); fs.writeFileSync(paths.lock, ""); }
  if (mode === "selection") p.proof.commandIds = [...commands, "unexpected"];
  if (mode === "binding") updateDesktop(workspace.id, d => ({ state: { ...d!, binding: { ...d!.binding!, title: "changed" } }, result: undefined }));
  if (mode === "maintenance") vi.mocked(desktopIpc.currentResultContext).mockResolvedValueOnce(context()).mockResolvedValue({ ...context(), resultTurnId: "01a00000-0000-7000-8000-000000000009" } as never);
  if (mode === "preview-turn") vi.mocked(desktopIpc.currentResultContext).mockResolvedValue({ ...context(), resultTurnId: "01a00000-0000-7000-8000-000000000009" } as never);
  await expect(confirm(p)).rejects.toThrow(); expect(fs.readFileSync(paths.lock)).toHaveLength(0);
  expect(fs.existsSync(paths.directory)).toBe(false); expect(readAbandonments(workspace.id)).toEqual([]);
});
it.each(["fence", "normal", "quarantine"])("replaced %s immediately before commit retains evidence and refuses abandonment", async kind => {
  const p = await preview();
  options.checkpoint = point => {
    if (point !== "before_abandonment_write") return;
    const journal = JSON.parse(fs.readFileSync(paths.journal, "utf8"));
    const file = kind === "fence" ? paths.fence : kind === "normal" ? paths.lock : path.join(paths.directory, `${journal.repairId}.lock`);
    const bytes = fs.readFileSync(file); fs.renameSync(file, file + ".replaced"); fs.writeFileSync(file, bytes);
  };
  await expect(confirm(p)).rejects.toThrow(); expect(readAbandonments(workspace.id)).toEqual([]);
  expect(fs.existsSync(paths.fence)).toBe(true);
  expect(JSON.parse(fs.readFileSync(paths.journal, "utf8")).state).toBe("adopted_pending");
});
it("missing exact current process identity refuses before any repair mutation", async () => {
  const p = await preview(), before = tree(state);
  options.probe = async pid => ({ ...processObservation(pid), status: "unknown", creationTime: null, executable: null,
    errors: { process: "PROBE_UNAVAILABLE", creationTime: null, executable: null, inAnyJob: null } });
  await expect(confirm(p)).rejects.toThrow(); expect(tree(state)).toEqual(before);
});
it("two sorted repairs resume a partial acquisition without duplicate quarantine or batch", async () => {
  const second = repairPaths(workspace.id, "d-normal"), selected = ["d-normal", "b-corrupt"];
  fs.writeFileSync(second.lock, "");
  const p = await previewCorruptLockAbandonment(workspace, [...commands].reverse(), selected, options);
  const invoke = (opts: RepairOptions) => confirmCorruptLockAbandonment(workspace, commands, selected, p.proof, p.confirmationSha256, p.repairConfirmationSha256, opts);
  await expect(invoke({ ...options, checkpoint: (point, id) => { if (point === "after_repair_fence" && id === "d-normal") throw new Error("partial"); } })).rejects.toThrow("partial");
  expect(readAbandonments(workspace.id)).toEqual([]); dead = true;
  expect((await invoke(options)).status).toBe("abandoned");
  expect(readAbandonments(workspace.id)).toHaveLength(5);
  expect(fs.readdirSync(paths.directory).filter(x => x.endsWith(".lock"))).toHaveLength(2);
  expect(fs.existsSync(paths.fence)).toBe(false); expect(fs.existsSync(second.fence)).toBe(false);
});
it("same transaction closes exact five, preserves original evidence and file identity, and unblocks rollout history", async () => {
  // Seed ordinary historical facts before introducing the isolated corrupt-lock fixture.
  fs.unlinkSync(paths.lock);
  appendExecutionRecord(workspace.id, { taskId: "legacy-task", iteration: 1, changedFiles: [], tests: "ordinary fact",
    exitStatus: "ok", timestamp: instant, commandId: repairs[0]! });
  saveExecutionOutput(workspace.id, { command: "ordinary output", raw: "retained historical output", taskId: `desktop_${repairs[0]}`, iteration: 1 });
  fs.writeFileSync(paths.lock, "");
  const records = tree(path.join(state, "executions")), outputs = tree(path.join(state, "execution-outputs"));
  const before = fs.readFileSync(desktopFile(workspace.id)), original = repairSnapshot(paths.lock).fingerprint, p = await preview();
  const race = vi.fn(), unrelated = new AsyncResource("unrelated-writer");
  options.checkpoint = () => unrelated.runInAsyncScope(() => { expect(() => withCommandOperation(workspace.id, repairs[0]!, race)).toThrow(); });
  expect((await confirm(p)).status).toBe("abandoned"); expect(race).not.toHaveBeenCalled();
  expect(fs.readFileSync(desktopFile(workspace.id))).toEqual(before);
  expect(tree(path.join(state, "executions"))).toEqual(records); expect(tree(path.join(state, "execution-outputs"))).toEqual(outputs);
  const journal = JSON.parse(fs.readFileSync(paths.journal, "utf8")), q = path.join(paths.directory, `${journal.repairId}.lock`);
  expect(repairSnapshot(q).fingerprint).toMatchObject({ dev: original.dev, ino: original.ino, size: 0, sha256: original.sha256 });
  expect(journal.state).toBe("completed"); expect(fs.existsSync(paths.lock)).toBe(false); expect(fs.existsSync(paths.fence)).toBe(false);
  expect(readAbandonments(workspace.id).map(x => x.commandId)).toEqual(commands);
  expect([...desktopHistory(workspace).skipHistory]).toEqual(commands);
  expect((await assessRolloutIdle(workspace, { pairingActive: false }, { skipSelfTurnCheck: true, ignoreDesktopActivity: true })).idle).toBe(true);
  const stable = tree(state); options.checkpoint = undefined;
  expect((await confirm(p)).status).toBe("already_abandoned"); expect(tree(state)).toEqual(stable);
  unrelated.emitDestroy();
});
it.each(["after_repair_fence", "after_quarantine_rename", "after_new_lifecycle_lock", "after_adopted_pending", "before_abandonment_write", "after_abandonment_write", "after_completed_evidence"])("crash %s remains fenced and resumes exactly once after owner missing", async point => {
  const p = await preview(); await expect(confirm(p, crashAt(point))).rejects.toThrow(`CRASH:${point}`);
  expect(fs.existsSync(paths.fence)).toBe(true);
  expect(() => withCommandOperation(workspace.id, repairs[0]!, () => true)).toThrow();
  await expect(preview()).rejects.toThrow();
  dead = true;
  const resumed = await preview(); expect(resumed.repairConfirmationSha256).toBe(p.repairConfirmationSha256);
  await confirm(resumed); expect(readAbandonments(workspace.id)).toHaveLength(5);
  expect(fs.readdirSync(paths.directory).filter(x => x.endsWith(".lock"))).toHaveLength(1);
  expect(fs.existsSync(paths.lock)).toBe(false); expect(fs.existsSync(paths.fence)).toBe(false);
});
it.each(["unknown", "reused", "replaced", "corrupt"])("pending repair owner %s cannot be stolen", async mode => {
  const p = await preview(); await expect(confirm(p, crashAt("after_repair_fence"))).rejects.toThrow(); dead = true;
  if (mode === "unknown") ownerState = "unknown";
  if (mode === "reused") options.probe = async (pid, creation) => creation ? { ...processObservation(pid), status: "unknown", errors: { process: "IDENTITY_CHANGED", executable: null, creationTime: null, inAnyJob: null } } : processObservation(pid);
  if (mode === "corrupt") fs.writeFileSync(paths.fence, "");
  if (mode === "replaced") options.probe = async (pid, creation) => {
    if (creation) { const bytes = fs.readFileSync(paths.fence); fs.renameSync(paths.fence, paths.fence + ".old"); fs.writeFileSync(paths.fence, bytes); }
    return processObservation(pid, creation);
  };
  await expect(preview()).rejects.toThrow(); expect(readAbandonments(workspace.id)).toEqual([]); expect(fs.readFileSync(paths.lock)).toHaveLength(0);
});

it.each(["after_reclaim_created", "after_reclaim_owner_proof", "after_reclaim_consumed"])("takeover crash %s resumes only through explicit maintenance-owned confirm", async point => {
  const p = await staleReclaim(point), before = tree(state);
  expect(fs.existsSync(paths.reclaim)).toBe(point !== "after_reclaim_consumed");
  if (fs.existsSync(paths.reclaim)) {
    const claim = JSON.parse(fs.readFileSync(paths.reclaim, "utf8")), fence = JSON.parse(fs.readFileSync(paths.fence, "utf8"));
    expect(claim).toMatchObject({ version: 1, workspaceId: workspace.id, commandId: repairs[0], repairId: fence.repairId,
      owner: { pid: process.pid, creationTime: "100", executable: process.execPath }, target: repairSnapshot(paths.fence).fingerprint });
    expect(Object.keys(claim).sort()).toEqual(["version", "workspaceId", "commandId", "repairId", "owner", "nonce", "target", "createdAt"].sort());
  }
  expect((await preview()).repairConfirmationSha256).toBe(p.repairConfirmationSha256);
  expect(tree(state)).toEqual(before);
  expect(() => withCommandOperation(workspace.id, repairs[0]!, () => true)).toThrow();
  expect((await confirm(p)).status).toBe("abandoned");
  expect(fs.existsSync(paths.reclaim)).toBe(false); expect(fs.existsSync(paths.fence)).toBe(false);
  expect(readAbandonments(workspace.id)).toHaveLength(5);
  expect(fs.readdirSync(paths.directory).filter(x => x.endsWith(".lock"))).toHaveLength(1);
});

it.each(["live", "unknown", "reused"])("valid reclaim with %s exact owner stays blocked and byte-identical", async mode => {
  const p = await staleReclaim(), claim = JSON.parse(fs.readFileSync(paths.reclaim, "utf8"));
  claim.owner.creationTime = "200"; fs.writeFileSync(paths.reclaim, JSON.stringify(claim));
  options.probe = async (pid, creation) => creation === "200" ? {
    ...processObservation(pid), status: mode === "live" ? "identified" : "unknown", creationTime: mode === "live" ? "200" : null,
    errors: { process: mode === "live" ? null : mode === "reused" ? "IDENTITY_CHANGED" : "PROBE_UNAVAILABLE", executable: null, creationTime: null, inAnyJob: null },
  } : processObservation(pid, creation);
  const before = tree(state);
  await expect(preview()).rejects.toThrow(); await expect(confirm(p)).rejects.toThrow();
  expect(tree(state)).toEqual(before); expect(readAbandonments(workspace.id)).toEqual([]);
});

it.each(["sidecar", "target-fence"])("reclaim %s replaced between missing proofs is preserved, never consumed", async kind => {
  const p = await staleReclaim();
  options.checkpoint = point => {
    if (point !== "after_stale_reclaim_owner_proof") return;
    const file = kind === "sidecar" ? paths.reclaim : paths.fence, bytes = fs.readFileSync(file);
    fs.renameSync(file, `${file}.replaced`); fs.writeFileSync(file, bytes);
  };
  await expect(confirm(p)).rejects.toThrow(); expect(fs.existsSync(paths.reclaim)).toBe(true);
  expect(fs.existsSync(paths.directory)).toBe(false); expect(readAbandonments(workspace.id)).toEqual([]);
});

it("second missing proof becomes unknown and preserves the exact stale reclaim", async () => {
  const p = await staleReclaim(), before = tree(state);
  options.checkpoint = point => { if (point === "after_stale_reclaim_owner_proof") ownerState = "unknown"; };
  await expect(confirm(p)).rejects.toThrow(); expect(tree(state)).toEqual(before);
});

it("lost maintenance ownership prevents stale reclaim unlink and preserves the replacement", async () => {
  const p = await staleReclaim(), guard = repairSnapshot(paths.reclaim), fence = repairSnapshot(paths.fence);
  options.checkpoint = point => {
    if (point !== "after_stale_reclaim_owner_proof") return;
    const file = maintenanceLockPath(state), meta = JSON.parse(fs.readFileSync(file, "utf8"));
    meta.token = "01a00000-0000-4000-8000-000000000099"; fs.writeFileSync(file, JSON.stringify(meta));
  };
  await expect(confirm(p)).rejects.toThrow(); expect(repairSnapshot(paths.reclaim)).toEqual(guard);
  expect(repairSnapshot(paths.fence)).toEqual(fence); expect(isMaintenanceLockBusy(state)).toBe(true);
  expect(fs.existsSync(paths.directory)).toBe(false);
});

it.each(["", "broken", '{"version":1}', "extra-field", "wrong-target"])("corrupt or drifted reclaim %j is never age-reclaimed", async body => {
  const p = await staleReclaim();
  if (body === "extra-field" || body === "wrong-target") {
    const claim = JSON.parse(fs.readFileSync(paths.reclaim, "utf8"));
    if (body === "extra-field") claim.unexpected = true;
    else claim.target.sha256 = "f".repeat(64);
    fs.writeFileSync(paths.reclaim, JSON.stringify(claim));
  } else fs.writeFileSync(paths.reclaim, body);
  const before = tree(state);
  await expect(preview()).rejects.toThrow(); await expect(confirm(p)).rejects.toThrow();
  expect(tree(state)).toEqual(before); expect(fs.existsSync(paths.directory)).toBe(false);
});

it("two takeover contenders serialize on maintenance; loser makes no repair or abandonment mutation", async () => {
  const p = await staleReclaim();
  let armed = false, release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
  const first = confirm(p, { ...options, checkpoint: point => { if (point === "after_reclaim_created") armed = true; },
    probe: async (pid, creation) => { if (armed && creation) { armed = false; entered(); await gate; } return processObservation(pid, creation); } });
  await reached;
  try {
    const before = tree(state);
    expect(readMaintenanceLock(state)?.operation).toBe("desktop-abandonment-repair");
    await expect(confirm(p)).rejects.toMatchObject({ code: "MAINTENANCE_BUSY" });
    expect(tree(state)).toEqual(before); expect(readAbandonments(workspace.id)).toEqual([]);
  } finally { release(); }
  expect((await first).status).toBe("abandoned"); expect(readAbandonments(workspace.id)).toHaveLength(5);
});

it.each(["rollout", "gc-apply", "bridge-start", "corrupt-maintenance"])("maintenance held by %s prevents repair with zero mutation", async operation => {
  const p = await staleReclaim();
  const held = operation === "corrupt-maintenance" ? null : tryAcquireMaintenanceLock(state, operation);
  if (held) expect(held.ok).toBe(true);
  else fs.writeFileSync(maintenanceLockPath(state), "");
  try {
    const before = tree(state);
    await expect(confirm(p)).rejects.toMatchObject({ code: "MAINTENANCE_BUSY" });
    expect(tree(state)).toEqual(before);
  } finally { if (held?.ok) held.handle.release(); }
});

it.each(["command", "workspace"])("rejects lower-order inherited %s authority before acquiring maintenance", async kind => {
  const p = await preview();
  const operation = () => {
    const result = confirm(p);
    expect(isMaintenanceLockBusy(state)).toBe(false);
    return expect(result).rejects.toMatchObject({ code: "COMMAND_CLEANUP_BUSY" });
  };
  if (kind === "command") await withCommandOperationAsync(workspace.id, "a-normal", operation);
  else await withWorkspaceCleanupOperation(workspace.id, state, operation);
  expect(fs.existsSync(paths.fence)).toBe(false); expect(fs.existsSync(paths.directory)).toBe(false);
});

it("actual lock acquisition order is maintenance, sorted command authorities, then abandonment evidence", async () => {
  const p = await preview(), opened: string[] = [], original = fs.openSync;
  const evidence = path.join(state, "desktop-legacy-reconciliation", `${workspace.id}.json.lock`);
  vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
    if (flags === "wx") opened.push(String(file));
    return original(file, flags, mode);
  });
  await confirm(p);
  const authorities = [maintenanceLockPath(state), ...commands.map(id => id === repairs[0] ? paths.fence : repairPaths(workspace.id, id).lock), evidence];
  expect(opened.filter(file => authorities.includes(file))).toEqual(authorities);
  expect(isMaintenanceLockBusy(state)).toBe(false);
});
