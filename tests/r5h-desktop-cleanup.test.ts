import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeCleanupJournal } from "../src/command-cleanup/fence.js";
import { cleanupArtifact, CommandCleanupError, type CleanupArtifact } from "../src/command-cleanup/schema.js";
import { cleanup, makeTmpDir } from "./helpers.js";
import { inspectDesktopCleanupArtifacts, deleteDesktopCleanupArtifacts } from "../src/desktop/command-cleanup.js";
import { abandonmentFile, readAbandonments } from "../src/desktop/abandonment.js";
import {
  acquireReceiptFinalizationClaim,
  readReceiptFinalizationAlert,
  readReceiptFinalizationDraft,
  readReceiptFinalizationClaim,
  receiptFinalizationAlertPath,
  receiptFinalizationClaimPath,
  receiptFinalizationDraftPath,
  stageReceiptFinalization,
  writeReceiptFinalizationAlert,
} from "../src/desktop/receipt-finalizer-store.js";
import { recordDesktopResult } from "../src/desktop/result.js";
import { sendDesktop } from "../src/desktop/service.js";
import { desktopFile, readDesktop, updateDesktop } from "../src/desktop/store.js";

const workspaceId = "aabbccddeeff";
const commandId = "r5h_ephemeral_command";
const otherCommandId = "legacy_sibling_command";
const bindingId = "00000000-0000-4000-8000-000000000101";
const threadId = "00000000-0000-4000-8000-000000000102";
const turnId = "00000000-0000-4000-8000-000000000103";
const workspaceRoot = "D:\\cleanup-workspace";
const runtimeFence = {
  desktopPid: 1001,
  desktopExe: "C:\\Program Files\\ChatGPT\\ChatGPT.exe",
  desktopCreation: "1000001",
  appServerPid: 1002,
  appServerExe: "C:\\Program Files\\ChatGPT\\codex.exe",
  appServerCreation: "1000002",
};

let stateDir: string;
let previousStateDir: string | undefined;

function target(id = commandId) {
  return { workspaceId, workspaceRoot, commandId: id, iteration: 1 as const, stateDir };
}

function setup(): void {
  stateDir = makeTmpDir("r5h-desktop-cleanup-state");
  previousStateDir = process.env.C2C_STATE_DIR;
  process.env.C2C_STATE_DIR = stateDir;
}

function journal(artifacts: CleanupArtifact[], id = commandId) {
  return {
    version: 1 as const,
    workspaceId,
    workspaceRoot,
    commandId: id,
    iteration: 1 as const,
    cleanupId: randomUUID(),
    mode: "manual_force" as const,
    phase: "fenced" as const,
    createdAt: new Date().toISOString(),
    artifacts,
  };
}

function seedDesktop(): void {
  updateDesktop(workspaceId, () => ({
    state: {
      version: 1,
      workspaceId,
      workspaceRoot,
      enabled: true,
      binding: { threadId, hostId: "local", projectId: "project", bindingId, title: "bound", boundAt: new Date().toISOString() },
      runtimeFence,
      deliveries: [
        {
          commandId,
          lifecycle: "ephemeral",
          clientId: "client",
          bindingId,
          intent: "revision",
          messageSha256: "a".repeat(64),
          messageBytes: 1,
          threadId,
          turnId,
          deliveryStatus: "accepted",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          commandId: otherCommandId,
          clientId: "old-client",
          bindingId,
          messageSha256: "b".repeat(64),
          messageBytes: 1,
          threadId,
          turnId,
          deliveryStatus: "accepted",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    },
    result: undefined,
  }));
}

function seedAbandonmentBatch(): void {
  const summary = (id: string) => ({
    commandId: id,
    clientId: "client",
    bindingId,
    intent: null,
    messageSha256: "c".repeat(64),
    messageBytes: 1,
    threadId,
    turnId,
    deliveryStatus: "accepted" as const,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  });
  const commandIds = [commandId, otherCommandId].sort();
  const deliveries = commandIds.map(summary);
  const canonical = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  };
  const selectionSha256 = createHash("sha256").update(canonical({ workspaceId, commandIds, deliveries })).digest("hex");
  const file = abandonmentFile(workspaceId, stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    workspaceId,
    batches: [{
      commandIds,
      deliveries,
      selectionSha256,
      confirmationSha256: "d".repeat(64),
      abandonedAt: "2026-09-01T00:00:00.000Z",
      maintenanceThreadId: threadId,
      maintenanceTurnId: turnId,
    }],
  }));
  fs.writeFileSync(`${file}.initialized`, "1\n");
}

function finish() {
  vi.restoreAllMocks();
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
  cleanup(stateDir);
}

afterEach(finish);

describe("R5h Desktop cleanup ownership", () => {
  it("deletes exact Desktop/finalizer artifacts, preserves workspace identity, and resumes from a subset", () => {
    setup();
    seedDesktop();
    const draft = stageReceiptFinalization({
      workspaceId, workspaceRoot, threadId, originTurnId: turnId, resultTurnId: turnId, commandId,
      inputMaterial: "tests=focused;changedFiles=[]",
    }, { stateDir });
    writeReceiptFinalizationAlert(draft, "timeout", { stateDir });
    expect(acquireReceiptFinalizationClaim(stateDir, draft)).toBe(true);

    const snapshot = inspectDesktopCleanupArtifacts(target());
    expect(snapshot.map(item => item.kind).sort()).toEqual([
      "desktop_delivery_ephemeral", "receipt_alert", "receipt_claim", "receipt_draft",
    ]);
    const expected = [...snapshot, cleanupArtifact("result_bus_entry", commandId, { observed: true })];
    const active = journal(expected);
    writeCleanupJournal(active, stateDir);
    deleteDesktopCleanupArtifacts(target(), active.artifacts);
    // Replaying the producer phase after a crash is safe: the current artifacts are an exact subset.
    deleteDesktopCleanupArtifacts(target(), active.artifacts);

    const after = readDesktop(workspaceId, stateDir)!;
    expect(after.deliveries.map(item => item.commandId)).toEqual([otherCommandId]);
    expect(after.binding?.bindingId).toBe(bindingId);
    expect(after.runtimeFence).toEqual(runtimeFence);
    expect(after.revision).toBeGreaterThan(1);
    expect(fs.existsSync(`${desktopFile(workspaceId, stateDir)}.initialized`)).toBe(true);
    expect(readReceiptFinalizationDraft(stateDir, workspaceId, commandId)).toBeNull();
    expect(readReceiptFinalizationAlert(stateDir, workspaceId, commandId)).toBeNull();
    expect(readReceiptFinalizationClaim(stateDir, workspaceId, commandId)).toBeNull();
    expect(fs.existsSync(receiptFinalizationDraftPath(stateDir, workspaceId, commandId))).toBe(false);
    expect(fs.existsSync(receiptFinalizationAlertPath(stateDir, workspaceId, commandId))).toBe(false);
    expect(fs.existsSync(receiptFinalizationClaimPath(stateDir, workspaceId, commandId))).toBe(false);
    expect(() => acquireReceiptFinalizationClaim(stateDir, draft)).toThrow(CommandCleanupError);
    expect(() => writeReceiptFinalizationAlert(draft, "timeout", { stateDir })).toThrow(CommandCleanupError);
  });

  it("prunes one command from a confirmed abandonment batch and retains strict sibling evidence", () => {
    setup();
    seedAbandonmentBatch();
    const before = readAbandonments(workspaceId, stateDir);
    expect(before).toHaveLength(2);
    const snapshot = inspectDesktopCleanupArtifacts(target());
    expect(snapshot.map(item => item.kind)).toEqual(["abandonment"]);
    const active = journal(snapshot);
    writeCleanupJournal(active, stateDir);
    deleteDesktopCleanupArtifacts(target(), active.artifacts);

    const after = readAbandonments(workspaceId, stateDir);
    expect(after.map(item => item.commandId)).toEqual([otherCommandId]);
    expect(after[0]?.confirmationSha256).toBe(before[0]?.confirmationSha256);
    expect(after[0]?.maintenanceThreadId).toBe(threadId);
    expect(after[0]?.maintenanceTurnId).toBe(turnId);
    expect(fs.existsSync(`${abandonmentFile(workspaceId, stateDir)}.initialized`)).toBe(true);
  });

  it("refuses changed delivery identity and noncanonical evidence paths", () => {
    setup();
    seedDesktop();
    const snapshot = inspectDesktopCleanupArtifacts(target());
    const active = journal(snapshot);
    writeCleanupJournal(active, stateDir);
    updateDesktop(workspaceId, state => {
      if (!state) throw new Error("Desktop state missing");
      state.deliveries[0]!.messageSha256 = "e".repeat(64);
      return { state, result: undefined };
    });
    expect(() => deleteDesktopCleanupArtifacts(target(), active.artifacts)).toThrow(CommandCleanupError);
    expect(readDesktop(workspaceId, stateDir)?.deliveries).toHaveLength(2);

    // A symlink/reparse-point state path must fail closed during a fresh inspection.
    const file = desktopFile(workspaceId, stateDir);
    const moved = `${file}.saved`;
    fs.renameSync(file, moved);
    try {
      fs.symlinkSync(moved, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EACCES") throw error;
      fs.renameSync(moved, file);
      return;
    }
    expect(() => inspectDesktopCleanupArtifacts(target())).toThrow(CommandCleanupError);
  });

  it("fences send, receipt recording, and finalizer draft/claim/alert producers", async () => {
    setup();
    const draft = stageReceiptFinalization({
      workspaceId, workspaceRoot, threadId, originTurnId: turnId, resultTurnId: turnId, commandId,
      inputMaterial: "tests=focused;changedFiles=[]",
    }, { stateDir });
    const active = journal(inspectDesktopCleanupArtifacts(target()));
    writeCleanupJournal(active, stateDir);

    const authorize = vi.fn();
    await expect(sendDesktop({ id: workspaceId, root: workspaceRoot }, {
      workspaceId, bindingId, commandId, intent: "revision", userConfirmed: true, message: "body",
    }, "client", authorize)).rejects.toMatchObject({ code: "COMMAND_CLEANUP_IN_PROGRESS" });
    expect(authorize).not.toHaveBeenCalled();
    await expect(recordDesktopResult({ id: workspaceId, root: workspaceRoot }, {
      commandId, changedFiles: [], tests: "not run", exitStatus: "blocked", rawSummary: "No execution was recorded.",
    })).rejects.toMatchObject({ code: "COMMAND_CLEANUP_IN_PROGRESS" });
    expect(() => stageReceiptFinalization({
      workspaceId, workspaceRoot, threadId, originTurnId: turnId, resultTurnId: turnId, commandId,
      inputMaterial: "changed payload",
    }, { stateDir })).toThrow(/cleanup/);
    expect(() => acquireReceiptFinalizationClaim(stateDir, draft)).toThrow(CommandCleanupError);
    expect(() => writeReceiptFinalizationAlert(draft, "timeout", { stateDir })).toThrow(CommandCleanupError);
  });
});
