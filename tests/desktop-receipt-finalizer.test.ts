import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listExecutionOutputs } from "../src/execution/output.js";
import { readExecutionRecordsStrict, isTrustedDesktopReceipt, type StoredExecutionRecord } from "../src/execution/records.js";
import { desktopIpc } from "../src/desktop/ipc.js";
import * as desktopStore from "../src/desktop/store.js";
import * as lifecycle from "../src/command-cleanup/fence.js";
import { CommandCleanupError } from "../src/command-cleanup/schema.js";
import {
  readReceiptFinalizationAlert,
  readReceiptFinalizationDraft,
  canonicalReceiptFinalizationInput,
  receiptFinalizationMarkerDigest,
  receiptFinalizationDraftPath,
  runReceiptFinalizer,
  spawnReceiptFinalizerWorker,
  stageReceiptFinalization,
  type ReceiptFinalizationDraft,
  type ReceiptFinalizationOwnershipSnapshot,
} from "../src/desktop/receipt-finalizer.js";
import { acquireReceiptFinalizationClaim, readReceiptFinalizationClaim, receiptFinalizationClaimPath, writeReceiptFinalizationWorkerFailureAlert } from "../src/desktop/receipt-finalizer-store.js";
import { type DaemonSpawnOptions, type DaemonSpawnResult } from "../src/process/daemon-spawn.js";
import { probeProcess } from "../src/process/process-probe.js";
import { Workspace } from "../src/workspace/manager.js";

const threadId = "01a00000-0000-7000-8000-000000000101";
const originTurnId = "00000000-0000-4000-8000-000000000102";
const resultTurnId = "00000000-0000-4000-8000-000000000103";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");
const receiptFinalizerCliSource = path.join(projectRoot, "src/cli/desktop-receipt-finalizer.ts");
const runtimeFence = {
  desktopPid: 1001,
  desktopExe: "C:\\Program Files\\ChatGPT\\ChatGPT.exe",
  desktopCreation: "1000001",
  appServerPid: 1002,
  appServerExe: "C:\\Program Files\\ChatGPT\\codex.exe",
  appServerCreation: "1000002",
};

function draft(stateDir: string) {
  return stageReceiptFinalization({
    workspaceId: "desktop_receipt_test",
    workspaceRoot: process.cwd(),
    threadId,
    originTurnId,
    resultTurnId,
    commandId: "desktop_receipt_command",
    inputMaterial: "tests=real;changedFiles=[]",
  }, { stateDir, nowMs: Date.now() });
}

function marker(turnId = resultTurnId) {
  const value = { resultTurnId: turnId, itemIds: ["item-1"], itemTypes: ["userMessage" as const], itemCount: 1, itemSha256: "" };
  return { ...value, itemSha256: receiptFinalizationMarkerDigest(value) };
}

function ownershipSnapshot(overrides: Partial<ReceiptFinalizationOwnershipSnapshot> = {}): ReceiptFinalizationOwnershipSnapshot {
  return {
    workspaceId: "desktop_receipt_test",
    commandId: "desktop_receipt_command",
    threadId,
    hostId: "local",
    projectId: "project",
    workspaceRoot: process.cwd(),
    intent: "revision",
    messageBytes: 1,
    messageSha256: "a".repeat(64),
    ownership: "origin",
    originTurnId,
    originAlias: null,
    resultTurnId,
    chainTurnIds: [originTurnId],
    chainLength: 0,
    chainSignatures: [],
    signature: null,
    ...overrides,
  };
}

function v3Draft(
  stateDir: string,
  output = "safe output",
  snapshot = ownershipSnapshot({ resultTurnId: originTurnId, chainTurnIds: [originTurnId] }),
) {
  const resultId = snapshot.resultTurnId;
  return stageReceiptFinalization({
    workspaceId: "desktop_receipt_test",
    workspaceRoot: process.cwd(),
    threadId,
    originTurnId,
    resultTurnId: resultId,
    commandId: "desktop_receipt_command",
    input: {
      commandId: "desktop_receipt_command",
      changedFiles: ["src/desktop/result.ts"],
      tests: "1 passed",
      exitStatus: "ok",
      rawSummary: "本轮已完成实现，定向测试通过。",
      command: "pnpm test",
      output,
    },
    marker: marker(resultId),
    ownershipSnapshot: snapshot,
  }, { stateDir, nowMs: Date.now() });
}

function v2Draft(stateDir: string, output = "safe output") {
  const staged = v3Draft(stateDir, output, ownershipSnapshot({
    ownership: "native_continuation",
    chainTurnIds: [originTurnId, resultTurnId],
    chainLength: 1,
    chainSignatures: ["capacity_retry_automatic"],
    signature: "capacity_retry_automatic",
  }));
  const { ownershipSnapshot: _ownershipSnapshot, ...oldFields } = staged;
  const legacy = { ...oldFields, version: 2 as const };
  fs.writeFileSync(receiptFinalizationDraftPath(stateDir, staged.workspaceId, staged.commandId), JSON.stringify(legacy), "utf8");
  const persisted = readReceiptFinalizationDraft(stateDir, staged.workspaceId, staged.commandId);
  if (!persisted || persisted.version !== 2) throw new Error("expected a persisted v2 draft");
  return persisted;
}

function preR4aV2Draft(stateDir: string) {
  const pending = v2Draft(stateDir);

  // 固定 pre-R4a 的 canonical 字段顺序与字段集合，刻意省略 rawSummary。
  const legacyCanonical = JSON.stringify({
    commandId: pending.input.commandId,
    changedFiles: [...pending.input.changedFiles],
    tests: pending.input.tests,
    exitStatus: pending.input.exitStatus,
    notes: pending.input.notes ?? null,
    command: pending.input.command ?? null,
    output: pending.input.output ?? null,
    outputRestrictedReason: pending.input.outputRestrictedReason ?? null,
    exitCode: pending.input.exitCode ?? null,
  });
  const { rawSummary: _rawSummary, ...legacyInput } = pending.input;
  const fixture = {
    ...pending,
    input: legacyInput,
    inputDigest: createHash("sha256").update(legacyCanonical, "utf8").digest("hex"),
  };
  fs.writeFileSync(receiptFinalizationDraftPath(stateDir, pending.workspaceId, pending.commandId), JSON.stringify(fixture), "utf8");
  const persisted = readReceiptFinalizationDraft(stateDir, pending.workspaceId, pending.commandId);
  if (!persisted || persisted.version !== 2) throw new Error("expected a persisted v2 draft");
  return persisted;
}

function mockDurableState(pending: ReturnType<typeof draft>) {
  const bindingId = "00000000-0000-4000-8000-000000000111";
  const timestamp = new Date().toISOString();
  const state: NonNullable<ReturnType<typeof desktopStore.readDesktop>> = {
    version: 1,
    workspaceId: pending.workspaceId,
    workspaceRoot: pending.workspaceRoot,
    enabled: true,
    runtimeFence,
    binding: {
      bindingId,
      threadId,
      hostId: "local",
      projectId: "project",
      title: "test",
      boundAt: timestamp,
    },
    deliveries: [{
      commandId: pending.commandId,
      clientId: "client",
      bindingId,
      intent: "revision",
      messageSha256: pending.version === 3 ? pending.ownershipSnapshot.messageSha256 : "a".repeat(64),
      messageBytes: pending.version === 3 ? pending.ownershipSnapshot.messageBytes : 1,
      ...(pending.version === 3 && pending.ownershipSnapshot.deliveryId !== undefined
        ? { deliveryId: pending.ownershipSnapshot.deliveryId }
        : {}),
      threadId,
      turnId: pending.originTurnId,
      deliveryStatus: "accepted",
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
  };
  vi.spyOn(desktopStore, "readDesktop").mockReturnValue(state);
  return state;
}

function ownershipResult(
  pending: Extract<ReceiptFinalizationDraft, { version: 3 }>,
  overrides: Partial<ReceiptFinalizationOwnershipSnapshot> = {},
) {
  const snapshot = { ...pending.ownershipSnapshot, ...overrides };
  return {
    threadId: snapshot.threadId,
    hostId: snapshot.hostId,
    projectId: snapshot.projectId,
    workspaceRoot: snapshot.workspaceRoot,
    title: "test",
    cwd: snapshot.workspaceRoot,
    runtimeStatus: "active",
    fence: "safe_terminal" as const,
    resultTurnId: snapshot.resultTurnId,
    resultTurnStatus: "completed" as const,
    ownership: snapshot.ownership,
    originTurnId: snapshot.originTurnId,
    ...(snapshot.deliveryId === undefined ? {} : { deliveryId: snapshot.deliveryId }),
    originAlias: snapshot.originAlias,
    chainTurnIds: snapshot.chainTurnIds,
    chainLength: snapshot.chainLength,
    chainSignatures: snapshot.chainSignatures,
    signature: snapshot.signature,
  };
}

function safeTerminalFence(pending: Extract<ReceiptFinalizationDraft, { version: 2 | 3 }>) {
  return {
    threadId,
    hostId: "local",
    projectId: "project",
    workspaceRoot: pending.workspaceRoot,
    title: "test",
    cwd: pending.workspaceRoot,
    runtimeStatus: "idle",
    resultTurnId: pending.resultTurnId,
    resultTurnStatus: "completed" as const,
    fence: "safe_terminal" as const,
  };
}

describe("Desktop receipt terminal fence", () => {
  let stateDir: string;
  let workspaceRoot: string;
  afterEach(() => {
    vi.restoreAllMocks();
    if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
    if (workspaceRoot) fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("detached safe_terminal CLI routes committed receipts through the local result reconciler", () => {
    const source = fs.readFileSync(receiptFinalizerCliSource, "utf8");
    expect(source).toMatch(/if\s*\(\s*["']record["']\s+in\s+result\s*\)\s*\{[\s\S]*?reconcileTrustedDesktopExecutionResult\([\s\S]*?draft\.commandId/);
    expect(source).toMatch(/runReceiptFinalizer\(draft,\s*\{[\s\S]*?beforeReceiptCommit:\s*receiptAlreadyExists\s*=>\s*prepareResultReconciliation/);
    expect(source).toMatch(/const reconciliationNeeded\s*=\s*resultReconciliation\.status\s*===\s*["']reconciliation_needed["'][\s\S]*?if\s*\(\s*reconciliationNeeded\s*\)\s*process\.exitCode\s*=\s*1/);
    expect(source).not.toMatch(/reconcileTrustedDesktopExecutionResult[\s\S]{0,300}reconcileFeedbackOutbox/);
  });

  it("stages a strict pending draft and refuses conflicting overwrite", () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-receipt-finalizer-"));
    const first = draft(stateDir);
    expect(readReceiptFinalizationDraft(stateDir, first.workspaceId, first.commandId)?.draftId).toBe(first.draftId);
    expect(() => stageReceiptFinalization({
      workspaceId: first.workspaceId,
      workspaceRoot: first.workspaceRoot,
      threadId: first.threadId,
      originTurnId: first.originTurnId,
      resultTurnId: first.resultTurnId,
      commandId: first.commandId,
      inputMaterial: "changed",
    }, { stateDir })).toThrow();
  });

  it("never projects an in-progress draft as C2C_EXECUTED", async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-receipt-finalizer-"));
    const pending = draft(stateDir);
    mockDurableState(pending);
    const spy = vi.spyOn(desktopIpc, "inspectResultContext")
      .mockResolvedValue({
        threadId,
        hostId: "local",
        projectId: "project",
        workspaceRoot: pending.workspaceRoot,
        title: "test",
        cwd: pending.workspaceRoot,
        resultTurnId: pending.resultTurnId,
        resultTurnStatus: "completed",
        classification: "applicable",
        workspaceId: pending.workspaceId,
        commandId: pending.commandId,
        intent: "revision",
        messageBytes: 1,
        messageSha256: "a".repeat(64),
        ownership: "origin",
        originTurnId: pending.originTurnId,
        originAlias: null,
        chainTurnIds: [pending.originTurnId],
        chainLength: 0,
        chainSignatures: [],
        signature: null,
      });
    const alert = await runReceiptFinalizer(pending, { stateDir, pollMs: 1000 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ threadId, hostId: "local", projectId: "project", workspaceRoot: pending.workspaceRoot }, runtimeFence);
    expect(alert?.reason).toBe("post_record_activity_unprovable");
    expect(readReceiptFinalizationAlert(stateDir, pending.workspaceId, pending.commandId)?.alertId).toBe(pending.draftId);
  });

  it("v2 safe_terminal exactly once writes trusted receipt/output and clears the command draft", async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-receipt-finalizer-"));
    const pending = v2Draft(stateDir);
    mockDurableState(pending);
    const previousStateDir = process.env.C2C_STATE_DIR;
    process.env.C2C_STATE_DIR = stateDir;
    try {
      const fence = vi.spyOn(desktopIpc, "inspectResultTerminalFence").mockResolvedValue({
        threadId,
        hostId: "local",
        projectId: "project",
        workspaceRoot: pending.workspaceRoot,
        title: "test",
        cwd: pending.workspaceRoot,
        workspaceKind: "project",
        resumeState: "resumed",
        runtimeStatus: "idle",
        requestsCount: 0,
        desktopVersion: "26.915.4065.0",
        appServerVersion: "0.155.0-alpha.9.2",
        profile: "desktop-ipc-v1",
        ownerClientId: "client",
        resultTurnId: pending.resultTurnId,
        resultTurnStatus: "completed",
        fence: "safe_terminal",
      });
      const beforeReceiptCommit = vi.fn();
      const result = await runReceiptFinalizer(pending, { stateDir, beforeReceiptCommit });
      expect(result).toMatchObject({ record: { commandId: pending.commandId, taskId: `desktop_${pending.commandId}` } });
      expect(beforeReceiptCommit).toHaveBeenCalledOnce();
      expect(beforeReceiptCommit).toHaveBeenCalledWith(false);
      expect(fence).toHaveBeenCalledOnce();
      expect(readExecutionRecordsStrict(pending.workspaceId)).toHaveLength(1);
      const records = readExecutionRecordsStrict(pending.workspaceId);
      expect(isTrustedDesktopReceipt(records[0], pending.commandId)).toBe(true);
      expect(records[0]).toMatchObject({
        rawSummary: "本轮已完成实现，定向测试通过。",
        desktopThreadId: threadId,
        desktopOriginTurnId: originTurnId,
        desktopResultTurnId: resultTurnId,
        desktopBindingId: "00000000-0000-4000-8000-000000000111",
      });
      expect(listExecutionOutputs(pending.workspaceId, Number.MAX_SAFE_INTEGER))
        .toMatchObject([{ taskId: `desktop_${pending.commandId}`, iteration: 1, allowed: true }]);
      expect(readReceiptFinalizationDraft(stateDir, pending.workspaceId, pending.commandId)).toBeNull();
      expect(fs.existsSync(path.join(stateDir, "desktop-receipt-finalization", "claims"))).toBe(true);
      const retry = await runReceiptFinalizer(pending, { stateDir, beforeReceiptCommit });
      expect(retry).toMatchObject({ record: { commandId: pending.commandId, taskId: `desktop_${pending.commandId}` } });
      expect(beforeReceiptCommit).toHaveBeenLastCalledWith(true);
      expect(readExecutionRecordsStrict(pending.workspaceId)).toHaveLength(1);
      expect(listExecutionOutputs(pending.workspaceId, Number.MAX_SAFE_INTEGER)).toHaveLength(1);
    } finally {
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
    }
  });

  it.each([
    ["origin", ownershipSnapshot({ resultTurnId: originTurnId, chainTurnIds: [originTurnId] })],
    ["native continuation", ownershipSnapshot({
      ownership: "native_continuation",
      chainTurnIds: [originTurnId, "00000000-0000-4000-8000-000000000104", resultTurnId],
      chainLength: 2,
      chainSignatures: ["capacity_retry_automatic", "resume_interrupted_task"],
      signature: "resume_interrupted_task",
    })],
  ] as const)("v3 %s safe_terminal re-attests ownership before writing receipt", async (_label, snapshot) => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-receipt-finalizer-"));
    const pending = v3Draft(stateDir, "safe output", snapshot);
    mockDurableState(pending);
    const previousStateDir = process.env.C2C_STATE_DIR;
    process.env.C2C_STATE_DIR = stateDir;
    try {
      vi.spyOn(desktopIpc, "inspectResultTerminalFence").mockResolvedValue(safeTerminalFence(pending));
      const ownership = vi.spyOn(desktopIpc, "inspectPendingReceipt").mockResolvedValue(ownershipResult(pending));
      const result = await runReceiptFinalizer(pending, { stateDir });
      expect(result).toMatchObject({ record: { commandId: pending.commandId } });
      expect(ownership).toHaveBeenCalledTimes(2);
      expect(ownership).toHaveBeenCalledWith(
        { threadId, hostId: "local", projectId: "project", workspaceRoot: pending.workspaceRoot },
        {
          workspaceId: pending.workspaceId,
          commandId: pending.commandId,
          intent: "revision",
          messageBytes: 1,
          messageSha256: "a".repeat(64),
          originTurnId,
        },
        pending.marker, runtimeFence,
      );
      expect(readExecutionRecordsStrict(pending.workspaceId)).toHaveLength(1);
      expect(listExecutionOutputs(pending.workspaceId, Number.MAX_SAFE_INTEGER)).toHaveLength(1);
    } finally {
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
    }
  });

  it("v3 edit_user_message_v2_delivery alias safely finalizes only after exact re-attestation", async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-receipt-finalizer-"));
    const deliveryId = "00000000-0000-4000-8000-000000000105";
    const materializedOrigin = "00000000-0000-4000-8000-000000000106";
    const snapshot = ownershipSnapshot({
      ownership: "native_continuation",
      originTurnId: materializedOrigin,
      deliveryId,
      originAlias: "edit_user_message_v2_delivery",
      chainTurnIds: [materializedOrigin, resultTurnId],
      chainLength: 1,
      chainSignatures: ["resume_interrupted_task"],
      signature: "resume_interrupted_task",
    });
    const pending = v3Draft(stateDir, "safe output", snapshot);
    mockDurableState(pending);
    const previousStateDir = process.env.C2C_STATE_DIR;
    process.env.C2C_STATE_DIR = stateDir;
    try {
      vi.spyOn(desktopIpc, "inspectResultTerminalFence").mockResolvedValue(safeTerminalFence(pending));
      const ownership = vi.spyOn(desktopIpc, "inspectPendingReceipt").mockResolvedValue(ownershipResult(pending));
      await expect(runReceiptFinalizer(pending, { stateDir })).resolves.toMatchObject({
        record: { commandId: pending.commandId, desktopOriginTurnId: originTurnId, desktopResultTurnId: resultTurnId },
      });
      expect(ownership).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ originTurnId, deliveryId }), pending.marker, runtimeFence);
      expect(isTrustedDesktopReceipt(readExecutionRecordsStrict(pending.workspaceId)[0], pending.commandId)).toBe(true);
    } finally {
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
    }
  });

  it("v3 earlier continuation signature drift with unchanged tip fails before output/receipt write", async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-receipt-finalizer-"));
    const middleTurnId = "00000000-0000-4000-8000-000000000104";
    const snapshot = ownershipSnapshot({
      ownership: "native_continuation",
      chainTurnIds: [originTurnId, middleTurnId, resultTurnId],
      chainLength: 2,
      chainSignatures: ["capacity_retry_automatic", "resume_interrupted_task"],
      signature: "resume_interrupted_task",
    });
    const pending = v3Draft(stateDir, "safe output", snapshot);
    mockDurableState(pending);
    const previousStateDir = process.env.C2C_STATE_DIR;
    process.env.C2C_STATE_DIR = stateDir;
    try {
      vi.spyOn(desktopIpc, "inspectResultTerminalFence").mockResolvedValue(safeTerminalFence(pending));
      const inspect = vi.spyOn(desktopIpc, "inspectPendingReceipt").mockResolvedValue(ownershipResult(pending, {
        chainSignatures: ["resume_interrupted_task", "resume_interrupted_task"],
      }));
      const alert = await runReceiptFinalizer(pending, { stateDir });
      expect(inspect).toHaveBeenCalledOnce();
      expect(alert).toMatchObject({ reason: "identity_drift" });
      expect(readExecutionRecordsStrict(pending.workspaceId)).toEqual([]);
      expect(listExecutionOutputs(pending.workspaceId, Number.MAX_SAFE_INTEGER)).toEqual([]);
      expect(readReceiptFinalizationDraft(stateDir, pending.workspaceId, pending.commandId)?.draftId).toBe(pending.draftId);
    } finally {
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
    }
  });

  it("v3 alias, origin, or deliveryId drift fails closed before output/receipt write", async () => {
    for (const drift of ["origin", "delivery", "alias"] as const) {
      stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-receipt-finalizer-"));
      const deliveryId = "00000000-0000-4000-8000-000000000105";
      const materializedOrigin = "00000000-0000-4000-8000-000000000106";
      const snapshot = ownershipSnapshot({
        ownership: "native_continuation",
        originTurnId: materializedOrigin,
        deliveryId,
        originAlias: "edit_user_message_v2_delivery",
        chainTurnIds: [materializedOrigin, resultTurnId],
        chainLength: 1,
        chainSignatures: ["resume_interrupted_task"],
        signature: "resume_interrupted_task",
      });
      const pending = v3Draft(stateDir, "safe output", snapshot);
      mockDurableState(pending);
      const previousStateDir = process.env.C2C_STATE_DIR;
      process.env.C2C_STATE_DIR = stateDir;
      try {
        vi.spyOn(desktopIpc, "inspectResultTerminalFence").mockResolvedValue(safeTerminalFence(pending));
        const changed = drift === "origin" ? { originTurnId: "00000000-0000-4000-8000-000000000107" }
          : drift === "delivery" ? { deliveryId: "00000000-0000-4000-8000-000000000108" }
            : { originAlias: null };
        vi.spyOn(desktopIpc, "inspectPendingReceipt").mockResolvedValue(ownershipResult(pending, changed));
        const alert = await runReceiptFinalizer(pending, { stateDir });
        expect(alert).toMatchObject({ reason: "identity_drift" });
        expect(readExecutionRecordsStrict(pending.workspaceId)).toEqual([]);
        expect(listExecutionOutputs(pending.workspaceId, Number.MAX_SAFE_INTEGER)).toEqual([]);
      } finally {
        if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
        else process.env.C2C_STATE_DIR = previousStateDir;
        vi.restoreAllMocks();
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    }
    stateDir = "";
  });

  it.each(["turnId", "deliveryId"] as const)("v3 durable accepted %s drift fails before ownership inspect or write", async field => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-receipt-finalizer-"));
    const snapshot = ownershipSnapshot({
      resultTurnId: originTurnId,
      chainTurnIds: [originTurnId],
      deliveryId: "00000000-0000-4000-8000-000000000105",
    });
    const pending = v3Draft(stateDir, "safe output", snapshot);
    const durable = mockDurableState(pending);
    const delivery = durable.deliveries[0]!;
    vi.mocked(desktopStore.readDesktop).mockReturnValue({
      ...durable,
      deliveries: [{
        ...delivery,
        ...(field === "turnId"
          ? { turnId: "00000000-0000-4000-8000-000000000107" }
          : { deliveryId: "00000000-0000-4000-8000-000000000108" }),
      }],
    });
    const previousStateDir = process.env.C2C_STATE_DIR;
    process.env.C2C_STATE_DIR = stateDir;
    try {
      vi.spyOn(desktopIpc, "inspectResultTerminalFence").mockResolvedValue(safeTerminalFence(pending));
      const inspect = vi.spyOn(desktopIpc, "inspectPendingReceipt");
      const alert = await runReceiptFinalizer(pending, { stateDir });
      expect(alert).toMatchObject({ reason: "identity_drift" });
      expect(inspect).not.toHaveBeenCalled();
      expect(readExecutionRecordsStrict(pending.workspaceId)).toEqual([]);
      expect(listExecutionOutputs(pending.workspaceId, Number.MAX_SAFE_INTEGER)).toEqual([]);
    } finally {
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
    }
  });

  it("pre-R4a v2 safe_terminal finalizes with its legacy digest and no fabricated rawSummary", async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-receipt-finalizer-"));
    const pending = preR4aV2Draft(stateDir);
    expect(pending.input.rawSummary).toBeUndefined();
    mockDurableState(pending);
    const previousStateDir = process.env.C2C_STATE_DIR;
    process.env.C2C_STATE_DIR = stateDir;
    try {
      const fence = vi.spyOn(desktopIpc, "inspectResultTerminalFence").mockResolvedValue({
        threadId,
        hostId: "local",
        projectId: "project",
        workspaceRoot: pending.workspaceRoot,
        title: "test",
        cwd: pending.workspaceRoot,
        workspaceKind: "project",
        resumeState: "resumed",
        runtimeStatus: "idle",
        requestsCount: 0,
        desktopVersion: "26.915.4065.0",
        appServerVersion: "0.155.0-alpha.9.2",
        profile: "desktop-ipc-v1",
        ownerClientId: "client",
        resultTurnId: pending.resultTurnId,
        resultTurnStatus: "completed",
        fence: "safe_terminal",
      });
      const result = await runReceiptFinalizer(pending, { stateDir });
      const records = readExecutionRecordsStrict(pending.workspaceId);
      expect(fence).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ record: { commandId: pending.commandId, desktopReceiptSha256: pending.inputDigest } });
      expect(records).toHaveLength(1);
      expect(records[0]!.rawSummary).toBeUndefined();
      expect(Object.hasOwn(records[0]!, "rawSummary")).toBe(false);
      expect(isTrustedDesktopReceipt(records[0]!, pending.commandId)).toBe(true);
      expect(readReceiptFinalizationDraft(stateDir, pending.workspaceId, pending.commandId)).toBeNull();
    } finally {
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
    }
  });

  it("pending digest 包含 rawSummary，不能以不同摘要重放同一 command", () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-receipt-finalizer-"));
    const first = v3Draft(stateDir);
    if (first.version !== 3) throw new Error("expected a v3 draft");
    const changedInput = { ...first.input, rawSummary: "另一份最终摘要" };
    expect(canonicalReceiptFinalizationInput(changedInput)).not.toBe(canonicalReceiptFinalizationInput(first.input));
    expect(() => stageReceiptFinalization({
      workspaceId: first.workspaceId,
      workspaceRoot: first.workspaceRoot,
      threadId: first.threadId,
      originTurnId: first.originTurnId,
      resultTurnId: first.resultTurnId,
      commandId: first.commandId,
      input: changedInput,
      marker: first.marker,
      ownershipSnapshot: first.ownershipSnapshot,
    }, { stateDir })).toThrow(/不一致/);
  });

  it.each(["post_record_activity", "unprovable"] as const)("v2 %s writes bounded alert and keeps draft", async fenceKind => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-receipt-finalizer-"));
    const pending = v2Draft(stateDir);
    mockDurableState(pending);
    vi.spyOn(desktopIpc, "inspectResultTerminalFence").mockResolvedValue({
      threadId,
      hostId: "local",
      projectId: "project",
      workspaceRoot: pending.workspaceRoot,
      resultTurnId: fenceKind === "unprovable" ? "00000000-0000-4000-8000-000000000199" : pending.resultTurnId,
      resultTurnStatus: fenceKind === "unprovable" ? "inProgress" : "completed",
      fence: fenceKind,
    });
    const alert = await runReceiptFinalizer(pending, { stateDir });
    expect(alert).toMatchObject({
      workspaceId: pending.workspaceId,
      commandId: pending.commandId,
      reason: fenceKind === "post_record_activity" ? "post_record_activity" : "post_record_activity_unprovable",
    });
    expect(readReceiptFinalizationDraft(stateDir, pending.workspaceId, pending.commandId)?.draftId).toBe(pending.draftId);
    expect(readReceiptFinalizationAlert(stateDir, pending.workspaceId, pending.commandId)?.reason)
      .toBe(fenceKind === "post_record_activity" ? "post_record_activity" : "post_record_activity_unprovable");
  });

  it("new v3 draft persists sanitized input rather than raw secret output", () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-receipt-finalizer-"));
    const pending = stageReceiptFinalization({
      workspaceId: "desktop_receipt_test",
      workspaceRoot: process.cwd(),
      threadId,
      originTurnId,
      resultTurnId,
      commandId: "desktop_receipt_command",
      input: {
        commandId: "desktop_receipt_command",
        changedFiles: [],
        tests: "not run",
        exitStatus: "blocked",
        rawSummary: "本轮被阻塞，未运行测试。",
        output: "password=super-secret",
      },
      marker: marker(),
      ownershipSnapshot: ownershipSnapshot({
        commandId: "desktop_receipt_command",
        ownership: "native_continuation",
        originTurnId,
        resultTurnId,
        chainTurnIds: [originTurnId, resultTurnId],
        chainLength: 1,
        chainSignatures: ["capacity_retry_automatic"],
        signature: "capacity_retry_automatic",
      }),
    }, { stateDir });
    expect(pending.version).toBe(3);
    expect(JSON.stringify(pending)).not.toContain("super-secret");
  });

  it("new v3 draft refuses to stage without Codex rawSummary", () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-receipt-finalizer-"));
    expect(() => stageReceiptFinalization({
      workspaceId: "desktop_receipt_test",
      workspaceRoot: process.cwd(),
      threadId,
      originTurnId,
      resultTurnId,
      commandId: "desktop_receipt_command",
      input: {
        commandId: "desktop_receipt_command",
        changedFiles: [],
        tests: "not run",
        exitStatus: "blocked",
      },
      marker: marker(),
      ownershipSnapshot: ownershipSnapshot({
        ownership: "native_continuation",
        originTurnId,
        resultTurnId,
        chainTurnIds: [originTurnId, resultTurnId],
        chainLength: 1,
        chainSignatures: ["capacity_retry_automatic"],
        signature: "capacity_retry_automatic",
      }),
    }, { stateDir })).toThrow();
    expect(fs.existsSync(receiptFinalizationDraftPath(stateDir, "desktop_receipt_test", "desktop_receipt_command"))).toBe(false);
  });

  it("v2 safe_terminal preserves restricted output metadata without storing the rejected body", async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-receipt-finalizer-"));
    const pending = v2Draft(stateDir, "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----");
    mockDurableState(pending);
    const previousStateDir = process.env.C2C_STATE_DIR;
    process.env.C2C_STATE_DIR = stateDir;
    try {
      vi.spyOn(desktopIpc, "inspectResultTerminalFence").mockResolvedValue({
        threadId, hostId: "local", projectId: "project", workspaceRoot: pending.workspaceRoot,
        resultTurnId: pending.resultTurnId, resultTurnStatus: "completed", fence: "safe_terminal",
      });
      const result = await runReceiptFinalizer(pending, { stateDir });
      expect(result).toMatchObject({ record: { commandId: pending.commandId } });
      expect(listExecutionOutputs(pending.workspaceId, Number.MAX_SAFE_INTEGER)).toMatchObject([{
        allowed: false, restrictedReason: "private_key", sizeBytes: 0,
      }]);
      expect(JSON.stringify(pending)).not.toContain("BEGIN PRIVATE KEY");
    } finally {
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
    }
  });

  it("fails closed on result-turn drift", async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-receipt-finalizer-"));
    const pending = draft(stateDir);
    mockDurableState(pending);
    vi.spyOn(desktopIpc, "inspectResultContext").mockResolvedValue({
      threadId,
      hostId: "local",
      projectId: "project",
      workspaceRoot: pending.workspaceRoot,
      title: "test",
      cwd: pending.workspaceRoot,
      resultTurnId: "00000000-0000-4000-8000-000000000199",
      resultTurnStatus: "completed",
      classification: "not_applicable",
    });
    const alert = await runReceiptFinalizer(pending, { stateDir });
    expect(alert?.reason).toBe("post_record_activity");
  });

  it("durable binding or delivery drift emits identity_drift before IPC", async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-receipt-finalizer-"));
    const pending = draft(stateDir);
    const read = vi.spyOn(desktopStore, "readDesktop").mockReturnValue({
      version: 1,
      workspaceId: pending.workspaceId,
      workspaceRoot: pending.workspaceRoot,
      enabled: true,
      binding: null,
      deliveries: [],
    });
    const inspect = vi.spyOn(desktopIpc, "inspectResultContext");
    const alert = await runReceiptFinalizer(pending, { stateDir });
    expect(read).toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(alert?.reason).toBe("identity_drift");
  });

  it("uses one worker claim and lets a later worker resume", async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-receipt-finalizer-"));
    const original = draft(stateDir);
    const pending = { ...original, expiresAt: new Date(Date.now() + 1_100).toISOString() };
    mockDurableState(pending);
    vi.spyOn(desktopIpc, "inspectResultContext").mockResolvedValue({
      threadId,
      hostId: "local",
      projectId: "project",
      workspaceRoot: pending.workspaceRoot,
      title: "test",
      cwd: pending.workspaceRoot,
      resultTurnId: pending.resultTurnId,
      resultTurnStatus: "inProgress",
      classification: "not_applicable",
    });
    const first = runReceiptFinalizer(pending, { stateDir, pollMs: 1_000 });
    await new Promise(resolve => setTimeout(resolve, 10));
    const second = await runReceiptFinalizer(pending, { stateDir, pollMs: 1_000 });
    expect(second).toBeNull();
    expect((await first)?.reason).toBe("timeout");
  });

  it.each([false, true])("startup lock contention re-reads the draft without resurrection (cleaned=%s)", async cleaned => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-receipt-finalizer-"));
    const pending = v2Draft(stateDir);
    mockDurableState(pending);
    const ipc = vi.spyOn(desktopIpc, "inspectResultTerminalFence").mockResolvedValue({ ...safeTerminalFence(pending), fence: "post_record_activity" });
    vi.spyOn(lifecycle, "withCommandOperationAsync").mockImplementationOnce(async () => {
      if (cleaned) fs.unlinkSync(receiptFinalizationDraftPath(stateDir, pending.workspaceId, pending.commandId));
      throw new CommandCleanupError("COMMAND_CLEANUP_BUSY", "record still owns the lifecycle lock");
    });
    const result = await runReceiptFinalizer(pending, { stateDir, pollMs: 1000 });
    if (cleaned) { expect(result).toBeNull(); expect(ipc).not.toHaveBeenCalled(); }
    else { expect(result).toMatchObject({ reason: "post_record_activity" }); expect(ipc).toHaveBeenCalledOnce(); }
  });

  it("surfaces claim storage failures instead of treating them as contention", async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-receipt-finalizer-"));
    const pending = draft(stateDir);
    const blocker = path.join(stateDir, "not-a-directory");
    fs.writeFileSync(blocker, "x", "utf8");
    await expect(runReceiptFinalizer(pending, { stateDir: path.join(blocker, "state") }))
      .rejects.toThrow();
  });

  it.skipIf(process.platform !== "win32")("短命 receipt worker 经真实 helper 完成后不误报 worker_spawn_failed", async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-receipt-finalizer-"));
    const pending = draft(stateDir);
    const markerFile = path.join(stateDir, "worker-completed.json");
    const entry = path.join(stateDir, "short-worker.mjs");
    fs.writeFileSync(entry, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(markerFile)}, JSON.stringify(process.argv.slice(2)));`, "utf8");
    const spawned = await spawnReceiptFinalizerWorker(pending, { stateDir, entry });
    expect(spawned.finalProcess).toMatchObject({ pid: spawned.pid, status: "identified", inAnyJob: false });
    const deadline = Date.now() + 10_000;
    let observed = await probeProcess(spawned.pid, undefined, undefined, spawned.finalProcess.creationTime!);
    while (observed.status === "identified" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      observed = await probeProcess(spawned.pid, undefined, undefined, spawned.finalProcess.creationTime!);
    }
    expect(observed.status).toBe("missing");
    expect(JSON.parse(fs.readFileSync(markerFile, "utf8"))).toEqual([
      "desktop-receipt-finalizer", "run", "-w", pending.workspaceRoot, "--draft", pending.draftId,
    ]);
    expect(readReceiptFinalizationAlert(stateDir, pending.workspaceId, pending.commandId)).toBeNull();
  });

  it("worker awaits the Job-escaping daemon helper with an allowlisted environment", async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-receipt-finalizer-"));
    const pending = draft(stateDir);
    const spawned = { pid: 1234, mode: "helper-wmi" } as DaemonSpawnResult;
    const spawnImpl = vi.fn(async (options: DaemonSpawnOptions) => {
      expect(options.env.CODEX_THREAD_ID).toBeUndefined();
      expect(options.env.CODEX_SESSION_ID).toBeUndefined();
      expect(options.env.C2C_STARTUP_LEASE).toBeUndefined();
      expect(options.env.C2C_RECEIPT_FINALIZER_STATE_DIR).toBe(path.resolve(stateDir));
      expect(options.logFile).toBe(os.devNull);
      expect(options.allowUnprovenDirectFallback).toBeUndefined();
      return spawned;
    });
    await expect(spawnReceiptFinalizerWorker(pending, { stateDir, spawnImpl, entry: "worker-entry.ts" })).resolves.toBe(spawned);
    expect(spawnImpl.mock.calls[0]?.[0].args).toEqual([
      "--import", "tsx", "worker-entry.ts", "desktop-receipt-finalizer", "run",
      "-w", pending.workspaceRoot, "--draft", pending.draftId,
    ]);
    spawnImpl.mockRejectedValueOnce(new Error("helper escape failed"));
    await expect(spawnReceiptFinalizerWorker(pending, { stateDir, spawnImpl, entry: "worker-entry.js" })).rejects.toThrow("helper escape failed");
    expect(readReceiptFinalizationAlert(stateDir, pending.workspaceId, pending.commandId)).toMatchObject({ reason: "worker_spawn_failed" });
  });

  it.each(["live", "EPERM", "EIO", "ESRCH", "replacement"])("claim recovery requires exact dead owner: %s", code => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-receipt-finalizer-"));
    const pending = draft(stateDir);
    const file = receiptFinalizationClaimPath(stateDir, pending.workspaceId, pending.commandId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const prior = { version: 1, draftId: pending.draftId, pid: 123456, claimedAt: new Date(0).toISOString() };
    fs.writeFileSync(file, JSON.stringify(prior));
    vi.spyOn(process, "kill").mockImplementation(() => {
      if (code === "live") return true;
      if (code === "replacement") fs.writeFileSync(file, JSON.stringify({ ...prior, pid: 654321 }));
      throw Object.assign(new Error(), { code: code === "replacement" ? "ESRCH" : code });
    });
    if (code === "replacement") {
      expect(() => acquireReceiptFinalizationClaim(stateDir, pending)).toThrow(/corrupt/);
      expect(readReceiptFinalizationClaim(stateDir, pending.workspaceId, pending.commandId)?.pid).toBe(654321);
    } else {
      expect(acquireReceiptFinalizationClaim(stateDir, pending)).toBe(code === "ESRCH");
      expect(readReceiptFinalizationClaim(stateDir, pending.workspaceId, pending.commandId)?.pid).toBe(code === "ESRCH" ? process.pid : prior.pid);
    }
  });

  it("does not emit a terminality alert after a trusted receipt was committed", () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-receipt-finalizer-"));
    const pending = draft(stateDir);
    const completed = stageReceiptFinalization({
      workspaceId: pending.workspaceId,
      workspaceRoot: pending.workspaceRoot,
      threadId: pending.threadId,
      originTurnId: pending.originTurnId,
      resultTurnId: pending.resultTurnId,
      commandId: "desktop_receipt_worker_committed",
      inputMaterial: "committed receipt",
    }, { stateDir });
    fs.mkdirSync(path.join(stateDir, "executions"), { recursive: true });
    fs.writeFileSync(path.join(stateDir, "executions", `${completed.workspaceId}.jsonl`), `${JSON.stringify({
      taskId: `desktop_${completed.commandId}`,
      iteration: 1,
      changedFiles: [],
      tests: "1 passed",
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
      commandId: completed.commandId,
      desktopReceiptSha256: "a".repeat(64),
      desktopThreadId: completed.threadId,
      desktopOriginTurnId: completed.originTurnId,
      desktopResultTurnId: completed.resultTurnId,
      desktopBindingId: "00000000-0000-4000-8000-000000000104",
    })}\n`, "utf8");

    writeReceiptFinalizationWorkerFailureAlert(completed, { stateDir });

    expect(readReceiptFinalizationAlert(stateDir, completed.workspaceId, completed.commandId)).toBeNull();
  });

  it("损坏的 draft、alert、claim 不按 missing 处理", async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-receipt-finalizer-"));
    const pending = draft(stateDir);
    const draftPath = path.join(stateDir, "desktop-receipt-finalization", "drafts", `${pending.workspaceId}-${pending.commandId}.json`);
    fs.writeFileSync(draftPath, "{broken", "utf8");
    expect(() => readReceiptFinalizationDraft(stateDir, pending.workspaceId, pending.commandId)).toThrow(/corrupt/);

    const alertDir = path.join(stateDir, "desktop-receipt-finalization", "alerts");
    fs.mkdirSync(alertDir, { recursive: true });
    const alertPath = path.join(alertDir, `${pending.workspaceId}-${pending.commandId}.json`);
    fs.writeFileSync(alertPath, "{broken", "utf8");
    expect(() => readReceiptFinalizationAlert(stateDir, pending.workspaceId, pending.commandId)).toThrow(/corrupt/);

    const claimDir = path.join(stateDir, "desktop-receipt-finalization", "claims");
    fs.mkdirSync(claimDir, { recursive: true });
    fs.writeFileSync(path.join(claimDir, `${pending.workspaceId}-${pending.commandId}.claim`), "{broken", "utf8");
    await expect(runReceiptFinalizer(pending, { stateDir })).rejects.toThrow(/corrupt/);
  });

  it("CLI worker 只落 durable alert，不直接投影 feedback", () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-receipt-finalizer-cli-"));
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-receipt-finalizer-ws-"));
    const workspace = new Workspace(workspaceRoot);
    const pending = stageReceiptFinalization({
      workspaceId: workspace.id,
      workspaceRoot,
      threadId,
      originTurnId,
      resultTurnId,
      commandId: "desktop_finalization_cli",
      inputMaterial: "bounded",
    }, { stateDir });
    const env = { ...process.env, C2C_STATE_DIR: stateDir, C2C_RECEIPT_FINALIZER_STATE_DIR: stateDir };
    delete env.CODEX_THREAD_ID;
    delete env.CODEX_SESSION_ID;
    const result = spawnSync(process.execPath, [
      "--import", "tsx", cliEntry, "desktop-receipt-finalizer", "run",
      "-w", workspaceRoot, "--draft", pending.draftId,
    ], { cwd: projectRoot, env, encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    const alert = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(alert).toMatchObject({
      workspaceId: workspace.id,
      commandId: pending.commandId,
      reason: "identity_drift",
    });
    expect(alert.projected).toBeUndefined();
    expect(fs.existsSync(path.join(stateDir, "feedback", `${workspace.id}.json`))).toBe(false);
    expect(readReceiptFinalizationAlert(stateDir, workspace.id, pending.commandId)).toMatchObject(alert);
  });
});

// isTrustedDesktopReceipt 8 谓词 zod 收敛（#10）的逐条等价性回归：
// 仅信任判定本身——不读文件、不建 stateDir；每个翻转必须与旧手工谓词同判。
describe("isTrustedDesktopReceipt 信任谓词等价性（#10 zod 收敛）", () => {
  const COMMAND = "cmd_trusted_receipt";
  const SHA = "a".repeat(64);
  const valid = (): StoredExecutionRecord => ({
    commandId: COMMAND,
    taskId: `desktop_${COMMAND}`,
    iteration: 1,
    changedFiles: ["src/a.ts"],
    tests: "1 passed",
    exitStatus: "ok",
    timestamp: "2026-10-09T08:30:00.000Z",
    desktopReceiptSha256: SHA,
  });
  const gate = (record: unknown): boolean =>
    isTrustedDesktopReceipt(record as StoredExecutionRecord, COMMAND);

  it("合法 record 与三种终态/空 changedFiles 边界通过", () => {
    expect(gate(valid())).toBe(true);
    for (const exitStatus of ["ok", "failed", "blocked"] as const) {
      expect(gate({ ...valid(), exitStatus })).toBe(true);
    }
    // 旧手工谓词对空数组 every 为 vacuous true，zod 同判
    expect(gate({ ...valid(), changedFiles: [] })).toBe(true);
  });

  it("谓词 1-3：commandId/taskId/iteration 身份键翻转拒绝", () => {
    expect(gate({ ...valid(), commandId: "other_command" })).toBe(false);
    expect(gate({ ...valid(), taskId: "desktop_other_command" })).toBe(false);
    expect(gate({ ...valid(), taskId: COMMAND })).toBe(false);
    expect(gate({ ...valid(), iteration: 0 })).toBe(false);
    expect(gate({ ...valid(), iteration: 2 })).toBe(false);
    expect(gate({ ...valid(), commandId: undefined })).toBe(false);
  });

  it("谓词 4：changedFiles 必须全为字符串", () => {
    expect(gate({ ...valid(), changedFiles: 0 })).toBe(false);
    expect(gate({ ...valid(), changedFiles: ["ok", 1] })).toBe(false);
    expect(gate({ ...valid(), changedFiles: undefined })).toBe(false);
  });

  it("谓词 5：tests 为非空白字符串", () => {
    expect(gate({ ...valid(), tests: null })).toBe(false);
    expect(gate({ ...valid(), tests: "" })).toBe(false);
    expect(gate({ ...valid(), tests: "   " })).toBe(false);
    expect(gate({ ...valid(), tests: undefined })).toBe(false);
  });

  it("谓词 6：exitStatus 仅三种终态", () => {
    expect(gate({ ...valid(), exitStatus: "running" })).toBe(false);
    expect(gate({ ...valid(), exitStatus: "OK" })).toBe(false);
    expect(gate({ ...valid(), exitStatus: "" })).toBe(false);
  });

  it("谓词 7：timestamp 必须可解析且规范 ISO 往返相等", () => {
    expect(gate({ ...valid(), timestamp: "not-a-date" })).toBe(false);
    // 可被 Date.parse 解析但非规范 Z 后缀：往返字符串不等，旧手工谓词同样拒绝
    expect(gate({ ...valid(), timestamp: "2026-10-09T08:30:00" })).toBe(false);
    expect(gate({ ...valid(), timestamp: "2026-10-09 08:30:00Z" })).toBe(false);
    expect(gate({ ...valid(), timestamp: "2026-10-09T08:30:00.000+00:00" })).toBe(false);
    expect(gate({ ...valid(), timestamp: "" })).toBe(false);
  });

  it("谓词 8：desktopReceiptSha256 为 64 位小写 hex", () => {
    expect(gate({ ...valid(), desktopReceiptSha256: undefined })).toBe(false);
    expect(gate({ ...valid(), desktopReceiptSha256: "A".repeat(64) })).toBe(false);
    expect(gate({ ...valid(), desktopReceiptSha256: "a".repeat(63) })).toBe(false);
    expect(gate({ ...valid(), desktopReceiptSha256: "g".repeat(64) })).toBe(false);
  });

  it("passthrough：多余键与未纳入 8 谓词的字段不影响 gate（与旧手工谓词同判）", () => {
    expect(gate({ ...valid(), unknownExtra: "x" })).toBe(true);
    // rawSummary 等字段的形状归 storedExecutionRecordSchema 读取路径，gate 不重复校验
    expect(gate({ ...valid(), rawSummary: 123 as unknown as string })).toBe(true);
  });

  it("commandId 参数化：同一 record 对不同期望 commandId 判定不同", () => {
    expect(isTrustedDesktopReceipt(valid(), "other_command")).toBe(false);
  });
});
