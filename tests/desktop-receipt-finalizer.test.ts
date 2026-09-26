import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listExecutionOutputs } from "../src/execution/output.js";
import { readExecutionRecordsStrict, isTrustedDesktopReceipt } from "../src/execution/records.js";
import { desktopIpc } from "../src/desktop/ipc.js";
import * as desktopStore from "../src/desktop/store.js";
import {
  readReceiptFinalizationAlert,
  readReceiptFinalizationDraft,
  canonicalReceiptFinalizationInput,
  receiptFinalizationMarkerDigest,
  receiptFinalizationDraftPath,
  runReceiptFinalizer,
  spawnReceiptFinalizerWorker,
  stageReceiptFinalization,
} from "../src/desktop/receipt-finalizer.js";
import { Workspace } from "../src/workspace/manager.js";

const threadId = "01a00000-0000-7000-8000-000000000101";
const originTurnId = "00000000-0000-4000-8000-000000000102";
const resultTurnId = "00000000-0000-4000-8000-000000000103";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");

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

function v2Draft(stateDir: string, output = "safe output") {
  return stageReceiptFinalization({
    workspaceId: "desktop_receipt_test",
    workspaceRoot: process.cwd(),
    threadId,
    originTurnId,
    resultTurnId,
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
    marker: marker(),
  }, { stateDir, nowMs: Date.now() });
}

function preR4aV2Draft(stateDir: string) {
  const pending = stageReceiptFinalization({
    workspaceId: "desktop_receipt_test",
    workspaceRoot: process.cwd(),
    threadId,
    originTurnId,
    resultTurnId,
    commandId: "desktop_receipt_command",
    input: {
      commandId: "desktop_receipt_command",
      changedFiles: ["src/legacy.ts"],
      tests: "1 passed",
      exitStatus: "ok",
      command: "pnpm test",
      output: "safe output",
    },
    marker: marker(),
  }, { stateDir, nowMs: Date.now() });
  if (pending.version !== 2) throw new Error("expected a v2 draft");

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
  const fixture = {
    ...pending,
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
  vi.spyOn(desktopStore, "readDesktop").mockReturnValue({
    version: 1,
    workspaceId: pending.workspaceId,
    workspaceRoot: pending.workspaceRoot,
    enabled: true,
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
      messageSha256: "a".repeat(64),
      messageBytes: 1,
      threadId,
      turnId: pending.originTurnId,
      deliveryStatus: "accepted",
      createdAt: timestamp,
      updatedAt: timestamp,
    }],
  });
}

describe("Desktop receipt terminal fence", () => {
  let stateDir: string;
  let workspaceRoot: string;
  afterEach(() => {
    vi.restoreAllMocks();
    if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
    if (workspaceRoot) fs.rmSync(workspaceRoot, { recursive: true, force: true });
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
        chainTurnIds: [pending.originTurnId],
        chainLength: 0,
        signature: null,
      });
    const alert = await runReceiptFinalizer(pending, { stateDir, pollMs: 1000 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ threadId, hostId: "local", projectId: "project", workspaceRoot: pending.workspaceRoot });
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
      const result = await runReceiptFinalizer(pending, { stateDir });
      expect(result).toMatchObject({ record: { commandId: pending.commandId, taskId: `desktop_${pending.commandId}` } });
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
      const retry = await runReceiptFinalizer(pending, { stateDir });
      expect(retry).toMatchObject({ record: { commandId: pending.commandId, taskId: `desktop_${pending.commandId}` } });
      expect(readExecutionRecordsStrict(pending.workspaceId)).toHaveLength(1);
      expect(listExecutionOutputs(pending.workspaceId, Number.MAX_SAFE_INTEGER)).toHaveLength(1);
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
    const first = v2Draft(stateDir);
    if (first.version !== 2) throw new Error("expected a v2 draft");
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
      resultTurnId: pending.resultTurnId,
      resultTurnStatus: "completed",
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

  it("v2 draft persists sanitized input rather than raw secret output", () => {
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
    }, { stateDir });
    expect(pending.version).toBe(2);
    expect(JSON.stringify(pending)).not.toContain("super-secret");
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

  it("detached worker does not inherit or forge runner environment", () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-receipt-finalizer-"));
    const pending = draft(stateDir);
    const child = { unref: vi.fn(), once: vi.fn() } as never;
    const spawnImpl = vi.fn((_command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      expect(options.env?.CODEX_THREAD_ID).toBeUndefined();
      expect(options.env?.CODEX_SESSION_ID).toBeUndefined();
      expect(options.env?.C2C_STARTUP_LEASE).toBeUndefined();
      expect(options.env?.C2C_RECEIPT_FINALIZER_STATE_DIR).toBe(path.resolve(stateDir));
      return child;
    });
    spawnReceiptFinalizerWorker(pending, { stateDir, spawnImpl, entry: "worker-entry.js" });
    expect(spawnImpl).toHaveBeenCalledOnce();
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
