import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopIpc } from "../src/desktop/ipc.js";
import { legacyRetirementFile } from "../src/desktop/legacy-retirement.js";
import { appendExecutionRecord, isTrustedDesktopReceipt, readExecutionRecordsStrict } from "../src/execution/records.js";
import { MAX_OUTPUT_RECORDS, saveExecutionOutput } from "../src/execution/output.js";
import {
  getReconciledLegacyCommandIds,
  legacyReconciliationFile,
  listLegacyReconciliations,
  readLegacyReconciliations,
  reconcileLegacyAccepted,
  LegacyReconciliationError,
} from "../src/desktop/legacy-reconciliation.js";
import { updateDesktop } from "../src/desktop/store.js";
import { registerDesktopCommands } from "../src/cli/desktop.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir } from "./helpers.js";

let root: string;
let stateDir: string;
let workspace: Workspace;

const commandId = "pre_receipt_command";
const threadId = "01a00000-0000-7000-8000-000000000001";
const turnId = "01a00000-0000-7000-8000-000000000002";
const acceptedAt = "2026-01-01T00:00:00.000Z";

beforeEach(() => {
  root = makeTmpDir("legacy-reconciliation-workspace");
  stateDir = makeTmpDir("legacy-reconciliation-state");
  workspace = new Workspace(root);
  process.env.C2C_STATE_DIR = stateDir;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.C2C_STATE_DIR;
  cleanup(root);
  cleanup(stateDir);
});

function seedDelivery(overrides: Record<string, unknown> = {}): void {
  updateDesktop(workspace.id, () => ({
    state: {
      version: 1,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      enabled: false,
      binding: {
        threadId,
        hostId: "local",
        projectId: "legacy-project",
        bindingId: "01a00000-0000-7000-8000-000000000003",
        title: "历史 Desktop 会话",
        boundAt: acceptedAt,
      },
      deliveries: [{
        commandId,
        clientId: "legacy-client",
        bindingId: "01a00000-0000-7000-8000-000000000003",
        messageSha256: "0".repeat(64),
        messageBytes: 1,
        threadId,
        turnId,
        deliveryStatus: "accepted" as const,
        createdAt: acceptedAt,
        updatedAt: acceptedAt,
        ...overrides,
      }],
    },
    result: undefined,
  }));
}

function addDelivery(newCommandId: string, overrides: Record<string, unknown> = {}): void {
  updateDesktop(workspace.id, current => {
    if (!current) throw new Error("Desktop fixture missing");
    const template = current.deliveries[0];
    if (!template) throw new Error("Desktop delivery fixture missing");
    return {
      state: {
        ...current,
        deliveries: [...current.deliveries, { ...template, commandId: newCommandId, ...overrides }],
      },
      result: undefined,
    };
  });
}

function seedEvidenceSourcesFor(
  sourceCommandId: string,
  overrides: { record?: Record<string, unknown>; output?: Record<string, unknown> } = {},
): ReturnType<typeof saveExecutionOutput> {
  const taskId = `desktop_${sourceCommandId}`;
  const output = saveExecutionOutput(workspace.id, {
    command: "test command",
    raw: "output",
    exitCode: 0,
    taskId,
    iteration: 1,
  });
  const outputTimestamp = new Date(Date.parse(acceptedAt) + 10_000).toISOString();
  const recordTimestamp = new Date(Date.parse(acceptedAt) + 20_000).toISOString();
  if (overrides.output) {
    const indexFile = path.join(stateDir, "execution-outputs", workspace.id, "index.json");
    const index = JSON.parse(fs.readFileSync(indexFile, "utf8")) as { items: Array<Record<string, unknown>> };
    const item = index.items.find(candidate => candidate.id === output.id);
    if (!item) throw new Error("Output fixture missing");
    Object.assign(item, { timestamp: outputTimestamp, ...overrides.output });
    fs.writeFileSync(indexFile, JSON.stringify(index));
  }
  appendExecutionRecord(workspace.id, {
    taskId,
    iteration: 1,
    changedFiles: [],
    tests: "legacy evidence",
    exitStatus: "ok",
    timestamp: recordTimestamp,
    outputId: output.id,
    outputAvailable: true,
    commandId: sourceCommandId,
    ...overrides.record,
  });
  if (!overrides.output) {
    const indexFile = path.join(stateDir, "execution-outputs", workspace.id, "index.json");
    const index = JSON.parse(fs.readFileSync(indexFile, "utf8")) as { items: Array<Record<string, unknown>> };
    const item = index.items.find(candidate => candidate.id === output.id);
    if (!item) throw new Error("Output fixture missing");
    item.timestamp = outputTimestamp;
    fs.writeFileSync(indexFile, JSON.stringify(index));
  }
  return output;
}

function seedEvidenceSources(overrides: { record?: Record<string, unknown>; output?: Record<string, unknown> } = {}): void {
  seedEvidenceSourcesFor(commandId, overrides);
}

async function runLegacyCli(args: string[]): Promise<{ output: string; exitCode: number | undefined }> {
  const program = new Command().exitOverride();
  registerDesktopCommands(program);
  const output: string[] = [];
  const write = process.stdout.write;
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  let exitCode: number | undefined;
  try {
    await program.parseAsync(["node", "c2c", ...args]);
    exitCode = process.exitCode;
  } finally {
    process.stdout.write = write;
    process.exitCode = previousExitCode;
  }
  return { output: output.join(""), exitCode };
}

describe("legacy accepted reconciliation", () => {
  it("legacy-retire CLI 后 list 只读显示 retired；不能再 reconciliation", async () => {
    seedDelivery({ threadId: turnId });
    vi.spyOn(desktopIpc, "inspect").mockImplementation(async target => {
      if (target.threadId === turnId) throw Object.assign(new Error("fixture"), { code: "DESKTOP_TARGET_NOT_FOUND" });
      return { ...target, runtimeStatus: "idle" } as never;
    });
    const result = await runLegacyCli(["desktop", "legacy-retire", "-w", root, "--command-id", commandId, "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({ ok: true, commandId });
    const file = legacyRetirementFile(workspace.id);
    const before = fs.readFileSync(file, "utf8");
    vi.mocked(desktopIpc.inspect).mockClear();
    expect(listLegacyReconciliations(workspace)).toEqual([{ commandId, status: "retired" }]);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(desktopIpc.inspect).not.toHaveBeenCalled();
    expect(() => reconcileLegacyAccepted(workspace, commandId)).toThrowError(expect.objectContaining({ code: "LEGACY_RECONCILIATION_CONFLICT" }));
  });

  it.each([
    { taskId: "wrong_task" }, { commandId: "wrong_command" }, { iteration: 2 },
    { tests: "   " }, { tests: null }, { timestamp: "2026-01-01T00:00:20Z" },
    { changedFiles: 0 }, { exitStatus: "running" },
  ])("带 hash 的不可信 receipt %j 在 list 显示 conflict", overrides => {
    seedDelivery();
    seedEvidenceSources();
    const file = path.join(stateDir, "executions", `${workspace.id}.jsonl`);
    const record = { ...JSON.parse(fs.readFileSync(file, "utf8")), desktopReceiptSha256: "a".repeat(64), ...overrides };
    fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
    expect(isTrustedDesktopReceipt(readExecutionRecordsStrict(workspace.id)[0], commandId)).toBe(false);
    expect(listLegacyReconciliations(workspace)).toEqual([{ commandId, status: "conflict" }]);
  });

  it("合法 receipt 存在 taskId 冲突时也不能从 list 隐藏", () => {
    seedDelivery();
    seedEvidenceSources();
    const file = path.join(stateDir, "executions", `${workspace.id}.jsonl`);
    const record = { ...JSON.parse(fs.readFileSync(file, "utf8")), desktopReceiptSha256: "a".repeat(64) };
    fs.writeFileSync(file, `${JSON.stringify(record)}\n${JSON.stringify({ ...record, commandId: "other" })}\n`);
    expect(listLegacyReconciliations(workspace)).toEqual([{ commandId, status: "conflict" }]);
  });
  it("list 只返回 legacy accepted 候选并标记五种状态", () => {
    const reconciledId = "reconciled_command";
    const missingExecutionId = "missing_execution_command";
    const missingOutputId = "missing_output_command";
    const conflictId = "conflict_command";
    const modernReceiptId = "modern_receipt_command";
    const intentId = "intent_command";
    const rejectedId = "rejected_command";
    const unknownId = "unknown_command";

    seedDelivery();
    seedEvidenceSources();

    addDelivery(reconciledId);
    seedEvidenceSourcesFor(reconciledId);
    reconcileLegacyAccepted(workspace, reconciledId);

    addDelivery(missingExecutionId);

    addDelivery(missingOutputId);
    seedEvidenceSourcesFor(missingOutputId, { record: { outputId: undefined } });

    addDelivery(conflictId);
    const conflictOutput = seedEvidenceSourcesFor(conflictId);
    appendExecutionRecord(workspace.id, {
      taskId: `desktop_${conflictId}`,
      iteration: 1,
      changedFiles: [],
      tests: "duplicate",
      exitStatus: "ok",
      timestamp: "2026-01-01T00:01:00.000Z",
      outputId: conflictOutput.id,
      outputAvailable: true,
      commandId: conflictId,
    });

    addDelivery(modernReceiptId);
    seedEvidenceSourcesFor(modernReceiptId);
    const recordsFile = path.join(stateDir, "executions", `${workspace.id}.jsonl`);
    const modernRecords = fs.readFileSync(recordsFile, "utf8").trimEnd().split("\n").map(line => {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.commandId === modernReceiptId) record.desktopReceiptSha256 = "a".repeat(64);
      return JSON.stringify(record);
    });
    fs.writeFileSync(recordsFile, `${modernRecords.join("\n")}\n`);
    addDelivery(intentId, { intent: "development_plan" });
    addDelivery(rejectedId, { deliveryStatus: "rejected", turnId: undefined, errorCode: "DESKTOP_TEST", errorMessage: "rejected" });
    addDelivery(unknownId, { deliveryStatus: "outcome_unknown", turnId: undefined });

    const files = [path.join(stateDir, "desktop-control", `${workspace.id}.json`), recordsFile,
      path.join(stateDir, "execution-outputs", workspace.id, "index.json"), legacyReconciliationFile(workspace.id)];
    const before = files.map(file => fs.readFileSync(file, "utf8"));
    expect(listLegacyReconciliations(workspace)).toEqual([
      { commandId, status: "eligible" },
      { commandId: reconciledId, status: "reconciled" },
      { commandId: missingExecutionId, status: "missing_execution" },
      { commandId: missingOutputId, status: "missing_output" },
      { commandId: conflictId, status: "conflict" },
    ]);
    expect(files.map(file => fs.readFileSync(file, "utf8"))).toEqual(before);
  });

  it("list 对已有证据的字段冲突返回 conflict，不降级为 eligible", () => {
    seedDelivery();
    seedEvidenceSources();
    reconcileLegacyAccepted(workspace, commandId);
    const file = legacyReconciliationFile(workspace.id);
    const evidence = JSON.parse(fs.readFileSync(file, "utf8"));
    evidence.entries[0].iteration += 1;
    fs.writeFileSync(file, JSON.stringify(evidence));
    expect(listLegacyReconciliations(workspace)).toEqual([{ commandId, status: "conflict" }]);
    expect(fs.readFileSync(file, "utf8")).toBe(JSON.stringify(evidence));
  });

  it("list 是只读的，fresh state 不创建目录或 lock", () => {
    seedDelivery();
    const beforeEntries = fs.readdirSync(stateDir).sort();
    const desktopStateFile = path.join(stateDir, "desktop-control", `${workspace.id}.json`);
    const beforeDesktop = fs.readFileSync(desktopStateFile, "utf8");

    expect(listLegacyReconciliations(workspace)).toEqual([{ commandId, status: "missing_execution" }]);

    expect(fs.readdirSync(stateDir).sort()).toEqual(beforeEntries);
    expect(fs.readFileSync(desktopStateFile, "utf8")).toBe(beforeDesktop);
    expect(fs.existsSync(legacyReconciliationFile(workspace.id))).toBe(false);
  });

  it.each(["records", "outputs", "evidence"] as const)("list 遇到 %s 存储损坏时整体拒绝", mode => {
    seedDelivery();
    seedEvidenceSources();
    let file: string;
    let code: string;
    if (mode === "records") {
      file = path.join(stateDir, "executions", `${workspace.id}.jsonl`);
      code = "LEGACY_RECONCILIATION_RECORDS_CORRUPT";
    } else if (mode === "outputs") {
      file = path.join(stateDir, "execution-outputs", workspace.id, "index.json");
      code = "LEGACY_RECONCILIATION_OUTPUT_CORRUPT";
    } else {
      reconcileLegacyAccepted(workspace, commandId);
      file = legacyReconciliationFile(workspace.id);
      code = "LEGACY_RECONCILIATION_STORE_CORRUPT";
    }
    fs.writeFileSync(file, "{");

    expect(() => listLegacyReconciliations(workspace)).toThrowError(expect.objectContaining({ code }));
    expect(fs.readFileSync(file, "utf8")).toBe("{");
  });

  it("list 在 retention 淘汰 output 后仍返回 reconciled", () => {
    seedDelivery();
    seedEvidenceSources();
    reconcileLegacyAccepted(workspace, commandId);
    for (let index = 0; index < MAX_OUTPUT_RECORDS; index++) {
      saveExecutionOutput(workspace.id, { command: `retention ${index}`, raw: "output", taskId: `retention-${index}`, iteration: 1 });
    }

    expect(listLegacyReconciliations(workspace)).toEqual([{ commandId, status: "reconciled" }]);
  });

  it("正常 retention 淘汰后仍严格复用 snapshot，幂等不改证据", () => {
    seedDelivery();
    seedEvidenceSources();
    reconcileLegacyAccepted(workspace, commandId);
    const file = legacyReconciliationFile(workspace.id);
    const before = fs.readFileSync(file, "utf8");
    for (let i = 0; i < MAX_OUTPUT_RECORDS; i++) {
      saveExecutionOutput(workspace.id, { command: "unrelated", raw: "output", taskId: `unrelated-${i}`, iteration: 1 });
    }
    expect(getReconciledLegacyCommandIds(workspace)).toEqual(new Set([commandId]));
    expect(reconcileLegacyAccepted(workspace, commandId).status).toBe("already_reconciled");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it.each(["missing", "changed", "corrupt"])("已 reconciliation 的 output index %s 仍拒绝", mode => {
    seedDelivery();
    seedEvidenceSources();
    reconcileLegacyAccepted(workspace, commandId);
    const file = path.join(stateDir, "execution-outputs", workspace.id, "index.json");
    const index = JSON.parse(fs.readFileSync(file, "utf8"));
    if (mode === "missing") index.items = [];
    if (mode === "changed") index.items[0].allowed = !index.items[0].allowed;
    fs.writeFileSync(file, mode === "corrupt" ? "{" : JSON.stringify(index));
    expect(() => getReconciledLegacyCommandIds(workspace)).toThrowError(expect.objectContaining({
      code: mode === "corrupt" ? "LEGACY_RECONCILIATION_OUTPUT_CORRUPT" : "LEGACY_RECONCILIATION_CONFLICT",
    }));
  });

  it("旧证据没有 snapshot 时不能借 retention 推断，也不回填", () => {
    seedDelivery();
    seedEvidenceSources();
    reconcileLegacyAccepted(workspace, commandId);
    const file = legacyReconciliationFile(workspace.id);
    const evidence = JSON.parse(fs.readFileSync(file, "utf8"));
    delete evidence.entries[0].outputSnapshot;
    fs.writeFileSync(file, JSON.stringify(evidence));
    expect(getReconciledLegacyCommandIds(workspace)).toEqual(new Set([commandId]));
    for (let i = 0; i < MAX_OUTPUT_RECORDS; i++) saveExecutionOutput(workspace.id, { command: "unrelated", raw: "output" });
    expect(() => getReconciledLegacyCommandIds(workspace)).toThrowError(expect.objectContaining({ code: "LEGACY_RECONCILIATION_CONFLICT" }));
    expect(JSON.parse(fs.readFileSync(file, "utf8")).entries[0].outputSnapshot).toBeUndefined();
  });

  it.each(["ok", "failed", "blocked"])("合法旧 task/iteration 的 %s 终态保留所有原始证据", exitStatus => {
    seedDelivery();
    const task = { taskId: "legacy-task", iteration: 3 };
    seedEvidenceSources({ record: { ...task, exitStatus }, output: task });
    const files = [path.join(stateDir, "desktop-control", `${workspace.id}.json`),
      path.join(stateDir, "executions", `${workspace.id}.jsonl`),
      path.join(stateDir, "execution-outputs", workspace.id, "index.json")];
    const before = files.map(file => fs.readFileSync(file, "utf8"));
    expect(reconcileLegacyAccepted(workspace, commandId).status).toBe("reconciled");
    expect(getReconciledLegacyCommandIds(workspace)).toEqual(new Set([commandId]));
    expect(files.map(file => fs.readFileSync(file, "utf8"))).toEqual(before);
  });

  it("只为缺失 intent 的唯一终态 record 和匹配 output 写独立证据，并可幂等重用", () => {
    seedDelivery();
    seedEvidenceSources();
    const first = reconcileLegacyAccepted(workspace, commandId);
    const second = reconcileLegacyAccepted(workspace, commandId);

    expect(first.status).toBe("reconciled");
    expect(second).toMatchObject({ status: "already_reconciled", commandId, proofSha256: first.proofSha256 });
    expect(readLegacyReconciliations(workspace.id)).toHaveLength(1);
    expect(getReconciledLegacyCommandIds(workspace)).toEqual(new Set([commandId]));
    expect(fs.existsSync(legacyReconciliationFile(workspace.id))).toBe(true);
  });

  it("intent 已存在时永远拒绝 legacy reconciliation", () => {
    seedDelivery({ intent: "revision" });
    seedEvidenceSources();
    expect(() => reconcileLegacyAccepted(workspace, commandId)).toThrowError(
      expect.objectContaining({ code: "LEGACY_RECONCILIATION_NOT_ELIGIBLE" })
    );
    expect(readLegacyReconciliations(workspace.id)).toEqual([]);
  });

  it.each([
    ["missing outputId", { record: { outputId: undefined } }],
    ["missing output metadata", { record: { outputId: 999 } }],
    ["wrong taskId", { record: { taskId: "desktop_other" } }],
    ["wrong iteration", { record: { iteration: 2 } }],
    ["nonterminal record", { record: { exitStatus: "running" } }],
    ["noncanonical timestamp", { record: { timestamp: "2026-01-01T00:00:20Z" } }],
    ["record before accepted", { record: { timestamp: acceptedAt } }],
    ["output before accepted", { output: { timestamp: acceptedAt } }],
  ])("%s 时拒绝且不写证据", (_name, overrides) => {
    seedDelivery();
    seedEvidenceSources(overrides);
    expect(() => reconcileLegacyAccepted(workspace, commandId)).toThrow(LegacyReconciliationError);
    expect(readLegacyReconciliations(workspace.id)).toEqual([]);
  });

  it("duplicate commandId/taskId 或 execution JSONL 损坏时 fail-closed", () => {
    seedDelivery();
    seedEvidenceSources();
    appendExecutionRecord(workspace.id, {
      taskId: `desktop_${commandId}`,
      iteration: 1,
      changedFiles: [],
      tests: "duplicate",
      exitStatus: "ok",
      timestamp: "2026-01-01T00:01:00.000Z",
      outputId: 1,
      commandId,
    });
    expect(() => reconcileLegacyAccepted(workspace, commandId)).toThrowError(
      expect.objectContaining({ code: "LEGACY_RECONCILIATION_CONFLICT" })
    );
    const recordsFile = path.join(stateDir, "executions", `${workspace.id}.jsonl`);
    fs.appendFileSync(recordsFile, "broken");
    expect(() => reconcileLegacyAccepted(workspace, "other_command")).toThrowError(
      expect.objectContaining({ code: "LEGACY_RECONCILIATION_RECORDS_CORRUPT" })
    );
    expect(readLegacyReconciliations(workspace.id)).toEqual([]);
  });

  it("不同 commandId 复用同一 taskId 时视为冲突", () => {
    seedDelivery();
    seedEvidenceSources({ record: { taskId: "shared-legacy-task" } });
    appendExecutionRecord(workspace.id, {
      taskId: "shared-legacy-task",
      iteration: 1,
      changedFiles: [],
      tests: "other task record",
      exitStatus: "ok",
      timestamp: "2026-01-01T00:01:00.000Z",
      outputId: 1,
      commandId: "other_command",
    });
    expect(() => reconcileLegacyAccepted(workspace, commandId)).toThrowError(
      expect.objectContaining({ code: "LEGACY_RECONCILIATION_CONFLICT" })
    );
    expect(readLegacyReconciliations(workspace.id)).toEqual([]);
  });

  it("output index 损坏时拒绝并保留旧证据", () => {
    seedDelivery();
    seedEvidenceSources();
    const indexFile = path.join(stateDir, "execution-outputs", workspace.id, "index.json");
    fs.writeFileSync(indexFile, "{}");
    expect(() => reconcileLegacyAccepted(workspace, commandId)).toThrowError(
      expect.objectContaining({ code: "LEGACY_RECONCILIATION_OUTPUT_CORRUPT" })
    );
    expect(readLegacyReconciliations(workspace.id)).toEqual([]);
  });

  it("证据 store 的临时残片、缺失主文件或重复条目都 fail-closed", () => {
    seedDelivery();
    seedEvidenceSources();
    reconcileLegacyAccepted(workspace, commandId);
    const file = legacyReconciliationFile(workspace.id);
    const before = fs.readFileSync(file, "utf8");
    const temporary = `${file}.partial.tmp`;
    fs.writeFileSync(temporary, "partial");
    expect(() => reconcileLegacyAccepted(workspace, commandId)).toThrowError(
      expect.objectContaining({ code: "LEGACY_RECONCILIATION_STORE_CORRUPT" })
    );
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    fs.rmSync(temporary);
    fs.rmSync(file);
    expect(() => readLegacyReconciliations(workspace.id)).toThrowError(
      expect.objectContaining({ code: "LEGACY_RECONCILIATION_STORE_CORRUPT" })
    );
  });

  it("证据 store 重复 commandId 条目 fail-closed", () => {
    seedDelivery();
    seedEvidenceSources();
    reconcileLegacyAccepted(workspace, commandId);
    const duplicateFile = legacyReconciliationFile(workspace.id);
    const state = JSON.parse(fs.readFileSync(duplicateFile, "utf8")) as { entries: unknown[] };
    state.entries.push(state.entries[0]);
    fs.writeFileSync(duplicateFile, JSON.stringify(state));
    expect(() => getReconciledLegacyCommandIds(workspace)).toThrowError(
      expect.objectContaining({ code: "LEGACY_RECONCILIATION_STORE_CORRUPT" })
    );
  });

  it("已写证据对应的输入事实变化时冲突，不覆盖原证据", () => {
    seedDelivery();
    seedEvidenceSources();
    const first = reconcileLegacyAccepted(workspace, commandId);
    const evidenceBefore = fs.readFileSync(legacyReconciliationFile(workspace.id), "utf8");
    const recordsFile = path.join(stateDir, "executions", `${workspace.id}.jsonl`);
    const lines = fs.readFileSync(recordsFile, "utf8").trimEnd().split("\n");
    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    record.tests = "changed fact";
    fs.writeFileSync(recordsFile, `${JSON.stringify(record)}\n`);
    expect(() => reconcileLegacyAccepted(workspace, commandId)).toThrowError(
      expect.objectContaining({ code: "LEGACY_RECONCILIATION_CONFLICT" })
    );
    expect(fs.readFileSync(legacyReconciliationFile(workspace.id), "utf8")).toBe(evidenceBefore);
    expect(first.proofSha256).toBe(readLegacyReconciliations(workspace.id)[0].proofSha256);
    expect(() => getReconciledLegacyCommandIds(workspace)).toThrowError(
      expect.objectContaining({ code: "LEGACY_RECONCILIATION_CONFLICT" })
    );
  });

  it("CLI 只执行显式 commandId 核对，不触发 rollout", async () => {
    seedDelivery();
    seedEvidenceSources();
    const program = new Command().exitOverride();
    registerDesktopCommands(program);
    const output: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      await program.parseAsync(["node", "c2c", "desktop", "legacy-reconcile", "-w", root,
        "--command-id", commandId, "--json"]);
    } finally {
      process.stdout.write = write;
      process.exitCode = previousExitCode;
    }
    expect(JSON.parse(output.join(""))).toMatchObject({ ok: true, status: "reconciled", commandId });
    expect(readLegacyReconciliations(workspace.id)).toHaveLength(1);
  });

  it("CLI --list --json 返回只读核对状态", async () => {
    seedDelivery();
    seedEvidenceSources();

    const result = await runLegacyCli(["desktop", "legacy-reconcile", "-w", root, "--list", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toEqual({ ok: true, items: [{ commandId, status: "eligible" }] });
    expect(readLegacyReconciliations(workspace.id)).toEqual([]);
  });

  it.each([
    ["同时指定 --list 和 --command-id", ["--list", "--command-id", commandId]],
    ["同时缺少 --list 和 --command-id", []],
  ] as const)("CLI %s 时拒绝", async (_name, selectors) => {
    const result = await runLegacyCli(["desktop", "legacy-reconcile", "-w", root, ...selectors, "--json"]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({ ok: false, error: "LEGACY_RECONCILIATION_INVALID" });
  });
});
