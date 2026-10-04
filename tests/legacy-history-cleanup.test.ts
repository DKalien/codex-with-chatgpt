import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { previewLegacyHistoryCleanup, confirmLegacyHistoryCleanup } from "../src/command-cleanup/legacy-history.js";
import { legacyHistoryJournalFile } from "../src/command-cleanup/legacy-history-fence.js";
import { appendExecutionRecord, readExecutionRecordsStrict } from "../src/execution/records.js";
import { readExecutionOutputIndexStrict, saveExecutionOutput } from "../src/execution/output.js";
import { ensureFeedbackState, feedbackStateFile, readFeedbackState } from "../src/feedback/state-store.js";
import { applyProjection } from "../src/feedback/projection-store.js";
import { reconcileFeedbackOutbox } from "../src/feedback/projector.js";
import { previewCommandCleanup } from "../src/command-cleanup/service.js";
import { registerCleanupCommands } from "../src/cli/cleanup.js";
import { updateDesktop } from "../src/desktop/store.js";
import { randomUUID } from "node:crypto";
import { cleanup, makeTmpDir } from "./helpers.js";

let root: string, state: string, workspace: Workspace;
beforeEach(() => { root = makeTmpDir("legacy-history-root"); state = makeTmpDir("legacy-history-state"); workspace = new Workspace(root); vi.stubEnv("C2C_STATE_DIR", state); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); cleanup(root); cleanup(state); });
const record = () => ({ taskId: "old-task", iteration: 0, changedFiles: [], tests: null, exitStatus: "ok", timestamp: "2026-01-01T00:00:00.000Z" });
const recordsFile = () => path.join(state, "executions", `${workspace.id}.jsonl`);
const indexFile = () => path.join(state, "execution-outputs", workspace.id, "index.json");
const preview = () => previewLegacyHistoryCleanup(workspace, state);
const confirm = (hash: string, hook?: Parameters<typeof confirmLegacyHistoryCleanup>[3]) => confirmLegacyHistoryCleanup(workspace, hash, state, hook);
function seed() {
  for (const iteration of [0, 1, 1, 2]) appendExecutionRecord(workspace.id, { ...record(), iteration, commandId: "duplicate" }, state);
  appendExecutionRecord(workspace.id, record(), state);
  saveExecutionOutput(workspace.id, { command: "old", raw: "old output", taskId: "orphan", iteration: 1 }, state);
  ensureFeedbackState(workspace.id, 5, state);
  return preview().confirmationSha256!;
}
function bytes() {
  const result: Record<string, string> = {};
  const walk = (dir: string) => { for (const name of fs.readdirSync(dir)) { const p = path.join(dir, name); if (fs.lstatSync(p).isDirectory()) walk(p); else result[path.relative(state, p)] = fs.readFileSync(p).toString("hex"); } };
  walk(state); return result;
}
it("preview is zero-write on pristine and populated state", () => {
  expect(preview().status).toBe("not_found"); expect(fs.readdirSync(state)).toEqual([]);
  seed(); const before = bytes(); expect(preview()).toMatchObject({ records: 5, outputs: 1 }); expect(bytes()).toEqual(before);
});
it("clears duplicate, non-unit iteration and unowned history while keeping next ID and unrelated files", () => {
  const hash = seed(), beforeNext = readExecutionOutputIndexStrict(workspace.id, state).nextId;
  fs.writeFileSync(path.join(state, "unrelated-runtime.json"), "preserve");
  const receiver = readFeedbackState(workspace.id, state);
  expect(() => previewCommandCleanup({ workspaceId: workspace.id, workspaceRoot: workspace.root, commandId: "duplicate", iteration: 1, stateDir: state })).toThrow();
  expect(confirm(hash)).toMatchObject({ status: "cleaned", records: 5, outputs: 1 });
  expect(readExecutionRecordsStrict(workspace.id, state)).toEqual([]);
  expect(readExecutionOutputIndexStrict(workspace.id, state)).toEqual({ nextId: beforeNext, items: [] });
  expect(readFeedbackState(workspace.id, state)).toEqual({ ...receiver, projectionCursor: 0 });
  expect(fs.readFileSync(path.join(state, "unrelated-runtime.json"), "utf8")).toBe("preserve");
  expect(preview().status).toBe("not_found");
  appendExecutionRecord(workspace.id, record(), state);
  expect(saveExecutionOutput(workspace.id, { command: "new", raw: "new" }, state).id).toBe(beforeNext);
  expect(reconcileFeedbackOutbox(workspace.id, state, root)).toMatchObject({ projected: 0, state: { projectionCursor: 1 } });
});
it("supports empty output metadata without requiring a nonexistent body", () => {
  saveExecutionOutput(workspace.id, { command: "empty", raw: "" }, state);
  expect(confirm(preview().confirmationSha256!)).toMatchObject({ outputs: 1 });
});
it.each(["confirmation", "records", "replacement", "body", "receiver"])("rejects changed %s before creating journal or deleting data", kind => {
  const hash = seed();
  if (kind === "records") appendExecutionRecord(workspace.id, record(), state);
  if (kind === "replacement") { const b = fs.readFileSync(recordsFile()); fs.renameSync(recordsFile(), recordsFile() + ".prior"); fs.writeFileSync(recordsFile(), b); }
  if (kind === "body") fs.writeFileSync(path.join(state, "execution-outputs", workspace.id, "bodies", "1.txt"), "changed body");
  if (kind === "receiver") { const f = feedbackStateFile(workspace.id, state); const v = JSON.parse(fs.readFileSync(f, "utf8")); v.projectionCursor = 4; fs.writeFileSync(f, JSON.stringify(v)); }
  const before = bytes(); expect(() => confirm(kind === "confirmation" ? "f".repeat(64) : hash)).toThrow(); expect(bytes()).toEqual(before);
  expect(fs.existsSync(legacyHistoryJournalFile(workspace.id, state))).toBe(false);
});
it.each(["missing-index", "hardlink", "unknown-body", "cleanup-lock", "receipt-draft"])("fails closed for %s", kind => {
  seed();
  if (kind === "missing-index") fs.unlinkSync(indexFile());
  if (kind === "hardlink") fs.linkSync(recordsFile(), recordsFile() + ".linked");
  if (kind === "unknown-body") fs.writeFileSync(path.join(state, "execution-outputs", workspace.id, "bodies", "99.txt"), "orphan");
  if (kind === "cleanup-lock" || kind === "receipt-draft") {
    const dir = kind === "cleanup-lock" ? path.join(state, "command-cleanup", workspace.id) : path.join(state, "desktop-receipt-finalization", "drafts");
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${workspace.id}-old.json`), "");
  }
  const before = bytes(); expect(() => preview()).toThrow(); expect(bytes()).toEqual(before);
});
it.each(["journal", "records", "bodies", "index", "feedback"] as const)("resumes interrupted %s with same digest; pending blocks writers", stage => {
  const hash = seed(); expect(() => confirm(hash, at => { if (at === stage) throw Error("interrupted"); })).toThrow("interrupted");
  expect(preview()).toMatchObject({ status: "pending", confirmationSha256: hash });
  const journal = fs.readFileSync(legacyHistoryJournalFile(workspace.id, state), "utf8"); expect(journal).not.toContain("old output");
  expect(() => appendExecutionRecord(workspace.id, record(), state)).toThrow();
  expect(() => saveExecutionOutput(workspace.id, { command: "new", raw: "new" }, state)).toThrow();
  expect(() => ensureFeedbackState(workspace.id, 0, state)).toThrow();
  expect(confirm(hash).status).toBe("cleaned"); expect(preview().status).toBe("not_found");
});
it("revalidates every remaining artifact before resumed deletion", () => {
  const hash = seed(); expect(() => confirm(hash, at => { if (at === "journal") throw Error("interrupted"); })).toThrow();
  fs.appendFileSync(path.join(state, "execution-outputs", workspace.id, "bodies", "1.txt"), "changed");
  const before = bytes(); expect(() => confirm(hash)).toThrow(); expect(bytes()).toEqual(before);
});
it("replaced journal is preserved and refuses the first deletion", () => {
  const hash = seed(), original = fs.readFileSync(recordsFile());
  expect(() => confirm(hash, at => { if (at === "journal") { const f = legacyHistoryJournalFile(workspace.id, state); const b = fs.readFileSync(f); fs.renameSync(f, f + ".old"); fs.writeFileSync(f, b); } })).toThrow();
  expect(fs.readFileSync(recordsFile())).toEqual(original);
});
it("stale projector cannot restore old cursor/events after cleanup", () => {
  const hash = seed(); const source = { cursor: 5, recordsSha256: createHash("sha256").update(JSON.stringify(readExecutionRecordsStrict(workspace.id, state))).digest("hex") };
  confirm(hash);
  expect(() => applyProjection({ workspaceId: workspace.id, stateDir: state, nextCursor: 5, newEvents: [], source })).toThrow("旧快照");
  expect(readFeedbackState(workspace.id, state).projectionCursor).toBe(0);
});
it("CLI requires exact preview digest and reports bounded errors", async () => {
  seed();
  const run = async (...args: string[]) => { const program = new Command().exitOverride(); registerCleanupCommands(program); let stdout = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(x => { stdout += String(x); return true; }); const prior = process.exitCode;
    try { await program.parseAsync(["node", "c2c", "cleanup", "legacy-history", "-w", root, "--json", ...args]); return JSON.parse(stdout); }
    finally { spy.mockRestore(); process.exitCode = prior; }
  };
  const value = await run(); expect(value.status).toBe("preview");
  expect(await run("--confirm", "x")).toMatchObject({ status: "blocked", code: "COMMAND_CLEANUP_CONFIRMATION_MISMATCH" });
  expect(await run("--confirm", value.confirmationSha256)).toMatchObject({ status: "cleaned" });
});
it.each(["records", "output", "feedback"])("existing %s lock blocks cleanup without deleting history", kind => {
  const hash = seed(); const file = kind === "records" ? recordsFile() : kind === "output" ? indexFile() : feedbackStateFile(workspace.id, state);
  fs.writeFileSync(file + ".lock", "unknown owner"); const before = bytes();
  expect(() => confirm(hash)).toThrow(); expect(bytes()).toEqual(before);
});
it("accepted Desktop delivery prevents legacy cleanup", () => {
  seed(); const now = new Date().toISOString(), bindingId = randomUUID(), threadId = randomUUID();
  updateDesktop(workspace.id, () => ({ state: { version: 1, workspaceId: workspace.id, workspaceRoot: root, enabled: true,
    binding: { bindingId, threadId, hostId: "local", projectId: "fixture", title: "fixture", boundAt: now }, deliveries: [{
      commandId: "active", deliveryId: randomUUID(), clientId: "fixture", bindingId, threadId, messageBytes: 1,
      messageSha256: "a".repeat(64), turnId: randomUUID(), deliveryStatus: "accepted", createdAt: now, updatedAt: now,
    }] }, result: null }), state);
  const before = bytes(); expect(() => preview()).toThrow(); expect(bytes()).toEqual(before);
});
it("corrupt journal remains fenced and unchanged", () => {
  const hash = seed(); expect(() => confirm(hash, at => { if (at === "journal") throw Error("interrupted"); })).toThrow();
  fs.writeFileSync(legacyHistoryJournalFile(workspace.id, state), ""); const before = bytes();
  expect(() => preview()).toThrow(); expect(() => appendExecutionRecord(workspace.id, record(), state)).toThrow(); expect(bytes()).toEqual(before);
});
it("exact interrupted replacement temporary can be resumed", () => {
  const hash = seed(); expect(() => confirm(hash, at => { if (at === "bodies") throw Error("interrupted"); })).toThrow();
  const tmp = `${indexFile()}.${hash}.legacy-tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ nextId: 2, items: [] }));
  expect(confirm(hash).status).toBe("cleaned"); expect(fs.existsSync(tmp)).toBe(false);
});
it("junction to an external body directory is rejected and preserved", () => {
  seed(); const dir = path.join(state, "execution-outputs", workspace.id, "bodies"), moved = path.join(state, "original-bodies");
  fs.renameSync(dir, moved); fs.symlinkSync(moved, dir, "junction");
  expect(() => preview()).toThrow(); expect(fs.readFileSync(path.join(moved, "1.txt"), "utf8")).toBe("old output");
  fs.unlinkSync(dir);
});
