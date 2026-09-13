import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopIpc } from "../src/desktop/ipc.js";
import { legacyReconciliationFile } from "../src/desktop/legacy-reconciliation.js";
import { legacyRetirementFile } from "../src/desktop/legacy-retirement.js";
import {
  abandonHistoricalAccepted,
  abandonmentFile,
  getAbandonedCommandIds,
  readAbandonedCommandIds,
  readAbandonments,
  previewAbandonment,
  AbandonmentError,
} from "../src/desktop/abandonment.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import { MAX_OUTPUT_RECORDS, saveExecutionOutput } from "../src/execution/output.js";
import { updateDesktop } from "../src/desktop/store.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const currentThreadId = "01a00000-0000-7000-8000-000000000001";
const oldThreadId = "01a00000-0000-7000-8000-000000000002";
const bindingId = "01a00000-0000-7000-8000-000000000003";
const deliveryBindingId = "01a00000-0000-7000-8000-000000000004";
const turnA = "01a00000-0000-7000-8000-000000000005";
const turnB = "01a00000-0000-7000-8000-000000000006";
const maintenanceTurn = "01a00000-0000-7000-8000-000000000007";
const acceptedAt = "2026-01-01T00:00:00.000Z";

let root: string;
let stateDir: string;
let workspace: Workspace;

beforeEach(() => {
  root = makeTmpDir("desktop-abandonment-workspace");
  stateDir = makeTmpDir("desktop-abandonment-state");
  process.env.C2C_STATE_DIR = stateDir;
  process.env.CODEX_THREAD_ID = currentThreadId;
  workspace = new Workspace(root);
  vi.spyOn(desktopIpc, "currentResultContext").mockResolvedValue(maintenanceContext());
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.C2C_STATE_DIR;
  delete process.env.CODEX_THREAD_ID;
  cleanup(root);
  cleanup(stateDir);
});

function maintenanceContext(overrides: Record<string, unknown> = {}): never {
  return {
    threadId: currentThreadId,
    hostId: "local",
    projectId: "project",
    workspaceRoot: workspace.root,
    title: "maintenance",
    cwd: workspace.root,
    runtimeStatus: "active",
    resultTurnId: maintenanceTurn,
    resultTurnStatus: "inProgress",
    ...overrides,
  } as never;
}

function seedDeliveries(): void {
  updateDesktop(workspace.id, () => ({
    state: {
      version: 1,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      enabled: false,
      binding: {
        threadId: currentThreadId,
        hostId: "local" as const,
        projectId: "project",
        bindingId,
        title: "current",
        boundAt: acceptedAt,
      },
      deliveries: [
        delivery("z_waiting", turnA, { intent: "revision" }),
        delivery("a_waiting", turnB),
      ],
    },
    result: undefined,
  }));
}

function delivery(commandId: string, turnId: string, overrides: Record<string, unknown> = {}) {
  return {
    commandId,
    clientId: "client",
    bindingId: deliveryBindingId,
    messageSha256: "0".repeat(64),
    messageBytes: 1,
    threadId: oldThreadId,
    turnId,
    deliveryStatus: "accepted" as const,
    createdAt: acceptedAt,
    updatedAt: acceptedAt,
    ...overrides,
  };
}

function abandonmentDir(): string {
  return path.dirname(abandonmentFile(workspace.id));
}

function clearExecutionFacts(): void {
  fs.rmSync(path.join(stateDir, "executions"), { recursive: true, force: true });
  fs.rmSync(path.join(stateDir, "execution-outputs"), { recursive: true, force: true });
}

function writeLegacyEvidence(kind: "reconciliation" | "retirement", commandId: string): void {
  const file = kind === "reconciliation" ? legacyReconciliationFile(workspace.id) : legacyRetirementFile(workspace.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entry = kind === "reconciliation"
    ? {
      commandId,
      taskId: "legacy-task",
      iteration: 1,
      outputId: 1,
      acceptedAt,
      executionTimestamp: acceptedAt,
      outputTimestamp: acceptedAt,
      proofSha256: "0".repeat(64),
      reconciledAt: acceptedAt,
    }
    : { commandId, deliverySha256: "0".repeat(64), observedMissingAt: acceptedAt };
  fs.writeFileSync(file, JSON.stringify({ version: 1, workspaceId: workspace.id, entries: [entry] }));
  fs.writeFileSync(`${file}.initialized`, "1\n");
}

describe("desktop abandonment", () => {
  it("preview 只读、按 sorted commandIds 绑定精确选择并保留 intent", () => {
    seedDeliveries();
    const result = previewAbandonment(workspace, ["z_waiting", "a_waiting"]);

    expect(result).toEqual({
      commandIds: ["a_waiting", "z_waiting"],
      confirmationSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      notice: "仅停止等待，不代表完成/成功",
    });
    expect(readAbandonments(workspace.id)).toEqual([]);
    expect(fs.existsSync(abandonmentDir())).toBe(false);
  });

  it("批量写入独立证据、保留源状态并可用原 confirmation 幂等重试", async () => {
    seedDeliveries();
    const desktopFile = path.join(stateDir, "desktop-control", `${workspace.id}.json`);
    const desktopBefore = fs.readFileSync(desktopFile, "utf8");
    const preview = previewAbandonment(workspace, ["z_waiting", "a_waiting"]);

    const first = await abandonHistoricalAccepted(workspace, preview.commandIds, preview.confirmationSha256);
    const evidenceFile = abandonmentFile(workspace.id);
    const evidenceBefore = fs.readFileSync(evidenceFile, "utf8");
    const second = await abandonHistoricalAccepted(workspace, preview.commandIds, preview.confirmationSha256);

    expect(first).toMatchObject({ status: "abandoned", commandIds: ["a_waiting", "z_waiting"], confirmationSha256: preview.confirmationSha256 });
    expect(second).toMatchObject({ status: "already_abandoned", commandIds: preview.commandIds, confirmationSha256: preview.confirmationSha256 });
    expect(fs.readFileSync(desktopFile, "utf8")).toBe(desktopBefore);
    expect(fs.readFileSync(evidenceFile, "utf8")).toBe(evidenceBefore);
    expect(readAbandonedCommandIds(workspace.id)).toEqual(new Set(["a_waiting", "z_waiting"]));
    expect(getAbandonedCommandIds(workspace)).toEqual(new Set(["a_waiting", "z_waiting"]));
    expect(readAbandonments(workspace.id)).toMatchObject([
      { commandId: "a_waiting", maintenanceThreadId: currentThreadId, maintenanceTurnId: maintenanceTurn },
      { commandId: "z_waiting", delivery: { intent: "revision" } },
    ]);
    expect(readAbandonments(workspace.id).map(item => item.confirmationSha256)).toEqual([
      preview.confirmationSha256,
      preview.confirmationSha256,
    ]);
    expect(JSON.parse(fs.readFileSync(evidenceFile, "utf8")).batches[0].confirmationSha256)
      .toBe(preview.confirmationSha256);
    expect(vi.mocked(desktopIpc.currentResultContext)).toHaveBeenCalledTimes(4);
  });

  it("拒绝重复 commandId、空选择和 confirmation 变更", async () => {
    seedDeliveries();
    expect(() => previewAbandonment(workspace, ["a_waiting", "a_waiting"])).toThrowError(
      expect.objectContaining({ code: "DESKTOP_ABANDONMENT_INVALID" }),
    );
    expect(() => previewAbandonment(workspace, [])).toThrowError(AbandonmentError);
    const preview = previewAbandonment(workspace, ["a_waiting"]);
    await expect(abandonHistoricalAccepted(workspace, ["a_waiting"], "f".repeat(64))).rejects.toMatchObject({
      code: "DESKTOP_ABANDONMENT_CONFIRMATION_MISMATCH",
    });
  });

  it("拒绝 outcome_unknown、当前 binding thread、可信 receipt 和 command/task 冲突", async () => {
    seedDeliveries();
    updateDesktop(workspace.id, state => ({
      state: { ...state!, deliveries: [...state!.deliveries, delivery("unknown_waiting", turnA, {
        deliveryStatus: "outcome_unknown",
        turnId: undefined,
      })] },
      result: undefined,
    }));
    expect(() => previewAbandonment(workspace, ["a_waiting"])).toThrowError(
      expect.objectContaining({ code: "DESKTOP_ABANDONMENT_NOT_ELIGIBLE" }),
    );

    seedDeliveries();
    updateDesktop(workspace.id, state => ({
      state: { ...state!, deliveries: state!.deliveries.map(item => item.commandId === "a_waiting"
        ? { ...item, threadId: currentThreadId } : item) },
      result: undefined,
    }));
    expect(() => previewAbandonment(workspace, ["a_waiting"])).toThrowError(
      expect.objectContaining({ code: "DESKTOP_ABANDONMENT_CONFLICT" }),
    );

    seedDeliveries();
    clearExecutionFacts();
    appendExecutionRecord(workspace.id, {
      taskId: "desktop_a_waiting", iteration: 1, changedFiles: [], tests: "ok", exitStatus: "ok",
      timestamp: "2026-01-01T00:01:00.000Z", commandId: "a_waiting",
    });
    expect(previewAbandonment(workspace, ["a_waiting"]).commandIds).toEqual(["a_waiting"]);

    seedDeliveries();
    clearExecutionFacts();
    const recordsFile = path.join(stateDir, "executions", `${workspace.id}.jsonl`);
    fs.mkdirSync(path.dirname(recordsFile), { recursive: true });
    fs.appendFileSync(recordsFile, `${JSON.stringify({
      taskId: "desktop_a_waiting", iteration: 1, changedFiles: [], tests: "ok", exitStatus: "ok",
      timestamp: "2026-01-01T00:01:00.000Z", commandId: "a_waiting", desktopReceiptSha256: "0".repeat(64),
    })}\n`, "utf8");
    expect(() => previewAbandonment(workspace, ["a_waiting"])).toThrowError(
      expect.objectContaining({ code: "DESKTOP_ABANDONMENT_CONFLICT" }),
    );

    seedDeliveries();
    clearExecutionFacts();
    appendExecutionRecord(workspace.id, {
      taskId: "desktop_a_waiting", iteration: 1, changedFiles: [], tests: "ok", exitStatus: "ok",
      timestamp: "2026-01-01T00:01:00.000Z", commandId: "other_command",
    });
    expect(() => previewAbandonment(workspace, ["a_waiting"])).toThrowError(
      expect.objectContaining({ code: "DESKTOP_ABANDONMENT_CONFLICT" }),
    );

    seedDeliveries();
    clearExecutionFacts();
    appendExecutionRecord(workspace.id, {
      taskId: "desktop_other_command", iteration: 1, changedFiles: [], tests: "ok", exitStatus: "ok",
      timestamp: "2026-01-01T00:01:00.000Z", commandId: "a_waiting",
    });
    expect(() => previewAbandonment(workspace, ["a_waiting"])).toThrowError(
      expect.objectContaining({ code: "DESKTOP_ABANDONMENT_CONFLICT" }),
    );
  });

  it.each(["reconciliation", "retirement"] as const)("已有 %s 证据时拒绝 abandonment", kind => {
    seedDeliveries();
    writeLegacyEvidence(kind, "a_waiting");

    expect(() => previewAbandonment(workspace, ["a_waiting"])).toThrowError(
      expect.objectContaining({ code: "DESKTOP_ABANDONMENT_CONFLICT" }),
    );
    expect(readAbandonments(workspace.id)).toEqual([]);
  });

  it.each(["reconciliation", "retirement"] as const)("写入后出现 %s 双证据时只读判断拒绝", async kind => {
    seedDeliveries();
    const preview = previewAbandonment(workspace, ["a_waiting"]);
    await abandonHistoricalAccepted(workspace, preview.commandIds, preview.confirmationSha256);
    const before = fs.readFileSync(abandonmentFile(workspace.id), "utf8");
    writeLegacyEvidence(kind, "a_waiting");

    expect(() => getAbandonedCommandIds(workspace)).toThrowError(
      expect.objectContaining({ code: "DESKTOP_ABANDONMENT_CONFLICT" }),
    );
    expect(fs.readFileSync(abandonmentFile(workspace.id), "utf8")).toBe(before);
  });

  it.each(["records", "outputs"] as const)("%s 存储损坏时 fail closed", kind => {
    seedDeliveries();
    const file = kind === "records"
      ? path.join(stateDir, "executions", `${workspace.id}.jsonl`)
      : path.join(stateDir, "execution-outputs", workspace.id, "index.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{");

    expect(() => previewAbandonment(workspace, ["a_waiting"])).toThrowError(expect.objectContaining({
      code: kind === "records" ? "DESKTOP_ABANDONMENT_RECORDS_CORRUPT" : "DESKTOP_ABANDONMENT_OUTPUT_CORRUPT",
    }));
    expect(readAbandonments(workspace.id)).toEqual([]);
  });

  it("duplicate execution records 和 duplicate batch 均 fail closed", async () => {
    seedDeliveries();
    const record = {
      taskId: "desktop_a_waiting", iteration: 1, changedFiles: [], tests: "ordinary", exitStatus: "ok",
      timestamp: "2026-01-01T00:01:00.000Z", commandId: "a_waiting",
    } as const;
    appendExecutionRecord(workspace.id, record);
    appendExecutionRecord(workspace.id, record);
    expect(() => previewAbandonment(workspace, ["a_waiting"])).toThrowError(
      expect.objectContaining({ code: "DESKTOP_ABANDONMENT_CONFLICT" }),
    );

    clearExecutionFacts();
    const preview = previewAbandonment(workspace, ["a_waiting"]);
    await abandonHistoricalAccepted(workspace, preview.commandIds, preview.confirmationSha256);
    const file = abandonmentFile(workspace.id);
    const state = JSON.parse(fs.readFileSync(file, "utf8")) as { batches: unknown[] };
    state.batches.push(state.batches[0]);
    fs.writeFileSync(file, JSON.stringify(state));
    expect(() => readAbandonedCommandIds(workspace.id)).toThrowError(
      expect.objectContaining({ code: "DESKTOP_ABANDONMENT_STORE_CORRUPT" }),
    );
  });

  it("普通唯一 execution record/output 允许，且幂等重试不受无关 abandonment batch 影响", async () => {
    seedDeliveries();
    appendExecutionRecord(workspace.id, {
      taskId: "legacy-task", iteration: 1, changedFiles: [], tests: "记录但不代表完成",
      exitStatus: "ok", timestamp: "2026-01-01T00:01:00.000Z", commandId: "a_waiting",
    });
    saveExecutionOutput(workspace.id, {
      command: "ordinary output", raw: "output retained as an ordinary fact", taskId: "desktop_a_waiting", iteration: 1,
    });
    const firstPreview = previewAbandonment(workspace, ["a_waiting"]);
    await expect(abandonHistoricalAccepted(workspace, firstPreview.commandIds, firstPreview.confirmationSha256))
      .resolves.toMatchObject({ status: "abandoned" });

    updateDesktop(workspace.id, state => ({
      state: { ...state!, deliveries: [...state!.deliveries, delivery("z_later", turnA)] },
      result: undefined,
    }));
    const secondPreview = previewAbandonment(workspace, ["z_later"]);
    await expect(abandonHistoricalAccepted(workspace, secondPreview.commandIds, secondPreview.confirmationSha256))
      .resolves.toMatchObject({ status: "abandoned" });

    await expect(abandonHistoricalAccepted(workspace, firstPreview.commandIds, firstPreview.confirmationSha256))
      .resolves.toMatchObject({ status: "already_abandoned" });
    for (let index = 0; index < MAX_OUTPUT_RECORDS; index += 1) {
      saveExecutionOutput(workspace.id, { command: `retention-${index}`, raw: "unrelated output", taskId: `retention-${index}`, iteration: 1 });
    }
    expect(getAbandonedCommandIds(workspace)).toEqual(new Set(["a_waiting", "z_later"]));
  });

  it.each([
    ["首个 context thread 不匹配", { threadId: oldThreadId }, undefined, "DESKTOP_ABANDONMENT_NOT_ELIGIBLE"],
    ["第二个 context thread 变化", {}, { threadId: oldThreadId }, "DESKTOP_ABANDONMENT_NOT_ELIGIBLE"],
    ["首个 context turn 变化", { resultTurnId: turnA }, {}, "DESKTOP_ABANDONMENT_CONFLICT"],
    ["第二个 context turn 变化", {}, { resultTurnId: turnA }, "DESKTOP_ABANDONMENT_CONFLICT"],
  ] as const)("%s 时拒绝且不落盘", async (_name, firstOverrides, secondOverrides, code) => {
    seedDeliveries();
    const preview = previewAbandonment(workspace, ["a_waiting"]);
    const current = vi.mocked(desktopIpc.currentResultContext);
    current.mockReset();
    const contexts = [
      maintenanceContext(firstOverrides),
      ...(secondOverrides === undefined ? [] : [maintenanceContext(secondOverrides)]),
    ];
    for (const context of contexts) current.mockResolvedValueOnce(context as never);
    if (contexts.length === 1) current.mockResolvedValue(maintenanceContext());

    await expect(abandonHistoricalAccepted(workspace, preview.commandIds, preview.confirmationSha256))
      .rejects.toMatchObject({ code });
    expect(readAbandonments(workspace.id)).toEqual([]);
  });

  it.each([
    ["扩大选择", ["a_waiting"], ["a_waiting", "z_waiting"]],
    ["缩小选择", ["a_waiting", "z_waiting"], ["a_waiting"]],
  ] as const)("preview 后%s不能沿用 confirmation", async (_name, previewIds, changedIds) => {
    seedDeliveries();
    const preview = previewAbandonment(workspace, previewIds);
    await expect(abandonHistoricalAccepted(workspace, changedIds, preview.confirmationSha256)).rejects.toMatchObject({
      code: "DESKTOP_ABANDONMENT_CONFIRMATION_MISMATCH",
    });
    expect(readAbandonments(workspace.id)).toEqual([]);
  });

  it("幂等重试前 selected delivery 变化时拒绝且保留原证据", async () => {
    seedDeliveries();
    const preview = previewAbandonment(workspace, ["a_waiting"]);
    await abandonHistoricalAccepted(workspace, preview.commandIds, preview.confirmationSha256);
    const file = abandonmentFile(workspace.id);
    const before = fs.readFileSync(file, "utf8");
    updateDesktop(workspace.id, state => ({
      state: {
        ...state!,
        deliveries: state!.deliveries.map(item => item.commandId === "a_waiting"
          ? { ...item, messageSha256: "1".repeat(64) } : item),
      },
      result: undefined,
    }));

    await expect(abandonHistoricalAccepted(workspace, preview.commandIds, preview.confirmationSha256)).rejects.toMatchObject({
      code: "DESKTOP_ABANDONMENT_CONFLICT",
    });
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("确认前后 maintenance context 变化时拒绝且不写入", async () => {
    seedDeliveries();
    const preview = previewAbandonment(workspace, ["a_waiting"]);
    vi.mocked(desktopIpc.currentResultContext)
      .mockResolvedValueOnce(maintenanceContext())
      .mockResolvedValueOnce(maintenanceContext({ cwd: "changed" }));

    await expect(abandonHistoricalAccepted(workspace, preview.commandIds, preview.confirmationSha256)).rejects.toMatchObject({
      code: "DESKTOP_ABANDONMENT_CONFLICT",
    });
    expect(readAbandonments(workspace.id)).toEqual([]);
  });

  it("确认前后 selected delivery 或新增 evidence 变化时拒绝", async () => {
    seedDeliveries();
    const preview = previewAbandonment(workspace, ["a_waiting"]);
    vi.mocked(desktopIpc.currentResultContext).mockImplementationOnce(async () => {
      updateDesktop(workspace.id, state => ({
        state: { ...state!, deliveries: state!.deliveries.map(item => item.commandId === "a_waiting"
          ? { ...item, messageSha256: "1".repeat(64) } : item) },
        result: undefined,
      }));
      return maintenanceContext();
    });
    await expect(abandonHistoricalAccepted(workspace, preview.commandIds, preview.confirmationSha256)).rejects.toMatchObject({
      code: "DESKTOP_ABANDONMENT_CONFLICT",
    });
    expect(readAbandonments(workspace.id)).toEqual([]);
  });

  it("getAbandoned 是只读 strict predicate，不要求旧 maintenance turn 仍 active", async () => {
    seedDeliveries();
    const preview = previewAbandonment(workspace, ["a_waiting"]);
    await abandonHistoricalAccepted(workspace, preview.commandIds, preview.confirmationSha256);
    vi.mocked(desktopIpc.currentResultContext).mockRejectedValue(new Error("turn ended"));
    vi.mocked(desktopIpc.currentResultContext).mockClear();

    expect(getAbandonedCommandIds(workspace)).toEqual(new Set(["a_waiting"]));
    expect(desktopIpc.currentResultContext).not.toHaveBeenCalled();
    updateDesktop(workspace.id, state => ({
      state: { ...state!, deliveries: [...state!.deliveries, delivery("new_waiting", turnA)] },
      result: undefined,
    }));
    expect(getAbandonedCommandIds(workspace)).toEqual(new Set(["a_waiting"]));
  });

  it("store marker、temporary、schema 和对应 delivery 损坏均 fail closed", async () => {
    seedDeliveries();
    const preview = previewAbandonment(workspace, ["a_waiting"]);
    await abandonHistoricalAccepted(workspace, preview.commandIds, preview.confirmationSha256);
    const file = abandonmentFile(workspace.id);

    fs.writeFileSync(`${file}.partial.tmp`, "partial");
    expect(() => readAbandonedCommandIds(workspace.id)).toThrowError(
      expect.objectContaining({ code: "DESKTOP_ABANDONMENT_STORE_CORRUPT" }),
    );
    fs.rmSync(`${file}.partial.tmp`);
    const validState = JSON.parse(fs.readFileSync(file, "utf8")) as {
      batches: Array<{ deliveries: Array<Record<string, unknown>> }>;
    };
    validState.batches[0]!.deliveries[0]!.messageSha256 = "1".repeat(64);
    fs.writeFileSync(file, JSON.stringify(validState));
    expect(() => readAbandonedCommandIds(workspace.id)).toThrowError(
      expect.objectContaining({ code: "DESKTOP_ABANDONMENT_STORE_CORRUPT" }),
    );
    fs.writeFileSync(file, JSON.stringify({ version: 2, workspaceId: workspace.id, batches: [] }));
    expect(() => readAbandonments(workspace.id)).toThrowError(
      expect.objectContaining({ code: "DESKTOP_ABANDONMENT_STORE_CORRUPT" }),
    );
  });
});
