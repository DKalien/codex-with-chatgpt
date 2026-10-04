import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { desktopFile, readDesktop, updateDesktop } from "../src/desktop/store.js";
import { confirmCommandCleanup, previewCommandCleanup } from "../src/command-cleanup/service.js";
import {
  cleanupJournalFile,
  readCleanupJournal,
  withCommandOperationAsync,
  withWorkspaceCleanupOperation,
  workspaceCleanupLockFile,
} from "../src/command-cleanup/fence.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

let stateDir: string, root: string, workspace: Workspace;

beforeEach(() => {
  stateDir = isolateStateDir();
  root = makeTmpDir("r5h-workspace-cleanup-lock");
  workspace = new Workspace(root);
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup(root);
  cleanup(stateDir);
});

function target(commandId: string) {
  return { workspaceId: workspace.id, workspaceRoot: workspace.root, commandId, iteration: 1 as const, stateDir };
}

function delivery(commandId: string): void {
  const now = new Date().toISOString();
  const current = readDesktop(workspace.id);
  const binding = current?.binding ?? {
    bindingId: randomUUID(), threadId: randomUUID(), hostId: "local" as const,
    projectId: "cleanup-lock-test", title: "fixture", boundAt: now,
  };
  const item = {
    commandId, deliveryId: randomUUID(), clientId: "cleanup-lock-test", bindingId: binding.bindingId,
    lifecycle: "ephemeral" as const, intent: "development_plan" as const,
    threadId: binding.threadId, turnId: randomUUID(), messageBytes: 4, messageSha256: "a".repeat(64),
    deliveryStatus: "accepted" as const, createdAt: now, updatedAt: now,
  };
  updateDesktop(workspace.id, previous => ({
    state: {
      ...(previous ?? { version: 1, workspaceId: workspace.id, workspaceRoot: root, enabled: true, binding, runtimeFence: null, deliveries: [] }),
      deliveries: [...(previous?.deliveries ?? []), item],
    },
    result: null,
  }));
}

function lockOwner(pid = process.pid): string {
  return JSON.stringify({ pid, nonce: randomUUID() });
}

function seedLock(file: string, raw: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, raw);
}

function errorCode(action: () => unknown): string {
  try { action(); } catch (error) { return (error as { code?: string }).code ?? ""; }
  throw new Error("expected action to throw");
}

describe("R5h workspace cleanup lock", () => {
  it("keeps __workspace_cleanup__ available as a normal command ID", () => {
    const commandId = "__workspace_cleanup__";
    delivery(commandId);
    const preview = previewCommandCleanup(target(commandId));
    expect(preview.status).toBe("preview");
    expect(confirmCommandCleanup(target(commandId), preview.confirmationSha256!).status).toBe("cleaned");
    expect(readCleanupJournal(workspace.id, commandId, stateDir)).toBeNull();
    expect(fs.existsSync(cleanupJournalFile(workspace.id, commandId, stateDir) + ".lock")).toBe(false);
    expect(fs.existsSync(workspaceCleanupLockFile(workspace.id, stateDir))).toBe(false);
  });

  it("serializes cleanup with its own workspace lock, independent of a same-named command", async () => {
    const commandId = "__workspace_cleanup__";
    const otherCommandId = "unrelated_cleanup";
    delivery(otherCommandId);
    let unlock!: () => void;
    const activeCommand = withCommandOperationAsync(workspace.id, commandId, () => new Promise<void>(resolve => { unlock = resolve; }), stateDir);
    const commandLock = cleanupJournalFile(workspace.id, commandId, stateDir) + ".lock";
    expect(fs.existsSync(commandLock)).toBe(true);
    expect(fs.existsSync(workspaceCleanupLockFile(workspace.id, stateDir))).toBe(false);

    const preview = previewCommandCleanup(target(otherCommandId));
    expect(confirmCommandCleanup(target(otherCommandId), preview.confirmationSha256!).status).toBe("cleaned");
    expect(fs.existsSync(commandLock)).toBe(true);
    expect(readCleanupJournal(workspace.id, commandId, stateDir)).toBeNull();
    unlock();
    await activeCommand;
  });

  it("fails closed on an occupied workspace lock without changing cleanup identity", () => {
    const commandId = "blocked_cleanup";
    delivery(commandId);
    const before = fs.readFileSync(desktopFile(workspace.id), "utf8");
    const lock = workspaceCleanupLockFile(workspace.id, stateDir);
    const raw = lockOwner();
    seedLock(lock, raw);

    const preview = previewCommandCleanup(target(commandId));
    expect(errorCode(() => confirmCommandCleanup(target(commandId), preview.confirmationSha256!))).toBe("COMMAND_CLEANUP_BUSY");
    expect(fs.readFileSync(lock, "utf8")).toBe(raw);
    expect(fs.readFileSync(desktopFile(workspace.id), "utf8")).toBe(before);
    expect(readCleanupJournal(workspace.id, commandId, stateDir)).toBeNull();
    expect(readCleanupJournal(workspace.id, "__workspace_cleanup__", stateDir)).toBeNull();
    expect(fs.existsSync(cleanupJournalFile(workspace.id, commandId, stateDir) + ".lock")).toBe(false);
    expect(fs.existsSync(lock + ".reclaim")).toBe(false);
  });

  it("rejects nested workspace cleanup before another command changes its state", () => {
    const commandId = "nested_cleanup";
    delivery(commandId);
    const before = fs.readFileSync(desktopFile(workspace.id), "utf8");
    const preview = previewCommandCleanup(target(commandId));

    expect(errorCode(() => withWorkspaceCleanupOperation(workspace.id, stateDir, () =>
      confirmCommandCleanup(target(commandId), preview.confirmationSha256!),
    ))).toBe("COMMAND_CLEANUP_BUSY");
    expect(fs.readFileSync(desktopFile(workspace.id), "utf8")).toBe(before);
    expect(readCleanupJournal(workspace.id, commandId, stateDir)).toBeNull();
    expect(readCleanupJournal(workspace.id, "__workspace_cleanup__", stateDir)).toBeNull();
    expect(fs.existsSync(cleanupJournalFile(workspace.id, commandId, stateDir) + ".lock")).toBe(false);
  });

  it.each([
    ["live", "live"], ["EPERM", "EPERM"], ["unknown", "EINVAL"], ["corrupt", "corrupt"],
  ])("does not reclaim %s workspace locks", (kind, killResult) => {
    const lock = workspaceCleanupLockFile(workspace.id, stateDir);
    seedLock(lock, kind === "corrupt" ? "{" : lockOwner(kind === "live" ? process.pid : 2_000_000_000));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      if (killResult === "live") return true;
      throw Object.assign(new Error(killResult), { code: killResult });
    });
    let entered = false;
    expect(errorCode(() => withWorkspaceCleanupOperation(workspace.id, stateDir, () => { entered = true; }))).toBe("COMMAND_CLEANUP_BUSY");
    expect(entered).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.existsSync(lock + ".reclaim")).toBe(false);
    if (kind === "corrupt") expect(kill).not.toHaveBeenCalled();
  });

  it("reclaims a dead owner only after ESRCH and an exact file recheck", () => {
    const lock = workspaceCleanupLockFile(workspace.id, stateDir);
    const pid = 2_000_000_001;
    seedLock(lock, lockOwner(pid));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("dead"), { code: "ESRCH" }); });

    expect(withWorkspaceCleanupOperation(workspace.id, stateDir, () => "entered")).toBe("entered");
    expect(kill).toHaveBeenCalledWith(pid, 0);
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.existsSync(lock + ".reclaim")).toBe(false);
  });

  it("preserves a same-content replacement during stale-lock reclamation", () => {
    const lock = workspaceCleanupLockFile(workspace.id, stateDir);
    const replacement = `${lock}.replacement`;
    const pid = 2_000_000_002;
    const raw = lockOwner(pid);
    seedLock(lock, raw);
    seedLock(replacement, raw);
    const replacementIdentity = fs.statSync(replacement);
    vi.spyOn(process, "kill").mockImplementation(() => {
      fs.unlinkSync(lock);
      fs.renameSync(replacement, lock);
      throw Object.assign(new Error("dead"), { code: "ESRCH" });
    });
    let entered = false;

    expect(errorCode(() => withWorkspaceCleanupOperation(workspace.id, stateDir, () => { entered = true; }))).toBe("COMMAND_CLEANUP_BUSY");
    const preserved = fs.statSync(lock);
    expect(preserved.ino).toBe(replacementIdentity.ino);
    expect(preserved.dev).toBe(replacementIdentity.dev);
    expect(fs.readFileSync(lock, "utf8")).toBe(raw);
    expect(fs.existsSync(lock + ".reclaim")).toBe(false);
    expect(entered).toBe(false);
  });

  it("surfaces ownership loss and preserves a same-content replacement during release", () => {
    const lock = workspaceCleanupLockFile(workspace.id, stateDir);
    const replacement = `${lock}.replacement`;
    let raw = "";
    let replacementIdentity: fs.Stats | undefined;

    expect(errorCode(() => withWorkspaceCleanupOperation(workspace.id, stateDir, () => {
      raw = fs.readFileSync(lock, "utf8");
      seedLock(replacement, raw);
      replacementIdentity = fs.statSync(replacement);
      fs.unlinkSync(lock);
      fs.renameSync(replacement, lock);
    }))).toBe("COMMAND_CLEANUP_LOCK_LOST");
    const preserved = fs.statSync(lock);
    expect(preserved.ino).toBe(replacementIdentity!.ino);
    expect(preserved.dev).toBe(replacementIdentity!.dev);
    expect(fs.readFileSync(lock, "utf8")).toBe(raw);
    expect(fs.existsSync(lock + ".reclaim")).toBe(false);
  });

  it("surfaces loss of the reclaim sidecar instead of deleting its replacement", () => {
    const lock = workspaceCleanupLockFile(workspace.id, stateDir);
    const reclaim = lock + ".reclaim";
    const replacement = `${reclaim}.replacement`;
    const pid = 2_000_000_003;
    seedLock(lock, lockOwner(pid));
    let raw = "";
    let replacementIdentity: fs.Stats | undefined;
    vi.spyOn(process, "kill").mockImplementation(() => {
      raw = fs.readFileSync(reclaim, "utf8");
      seedLock(replacement, raw);
      replacementIdentity = fs.statSync(replacement);
      fs.unlinkSync(reclaim);
      fs.renameSync(replacement, reclaim);
      throw Object.assign(new Error("dead"), { code: "ESRCH" });
    });

    expect(errorCode(() => withWorkspaceCleanupOperation(workspace.id, stateDir, () => "must not run"))).toBe("COMMAND_CLEANUP_LOCK_LOST");
    const preserved = fs.statSync(reclaim);
    expect(preserved.ino).toBe(replacementIdentity!.ino);
    expect(preserved.dev).toBe(replacementIdentity!.dev);
    expect(fs.readFileSync(reclaim, "utf8")).toBe(raw);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("keeps failed lock writes fail-closed without inventing release authority", () => {
    const lock = workspaceCleanupLockFile(workspace.id, stateDir);
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => { throw new Error("write fault"); });
    let entered = false;

    expect(() => withWorkspaceCleanupOperation(workspace.id, stateDir, () => { entered = true; })).toThrow("write fault");
    expect(entered).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.readFileSync(lock, "utf8")).toBe("");
  });

  it("keeps a written lock when fsync fails instead of releasing uncommitted authority", () => {
    const lock = workspaceCleanupLockFile(workspace.id, stateDir);
    vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => { throw new Error("fsync fault"); });
    let entered = false;

    expect(() => withWorkspaceCleanupOperation(workspace.id, stateDir, () => { entered = true; })).toThrow("fsync fault");
    expect(entered).toBe(false);
    const raw = fs.readFileSync(lock, "utf8");
    expect(JSON.parse(raw)).toMatchObject({ pid: process.pid, nonce: expect.stringMatching(/^[a-f0-9-]{36}$/) });
  });
});
