import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { readDesktop, updateDesktop } from "../src/desktop/store.js";
import { appendExecutionRecordLocked, withExecutionRecordsLock, type StoredExecutionRecord } from "../src/execution/records.js";
import { appendResult, createCommand, readRouting, registerRoute, routingFile, transitionCommandDelivery } from "../src/routing/store.js";
import { projectTrustedDesktopExecutionResult } from "../src/routing/execution-result-projector.js";
import { reconcileTrustedDesktopExecutionResult } from "../src/routing/execution-result-reconciler.js";
import {
  listResultOutboxEntries,
  listResultReconciliationNeeded,
  prepareResultReconciliation,
  resultOutboxFile,
  resultReconciliationQueueFile,
} from "../src/routing/result-outbox-store.js";

const THREAD = "01a00000-0000-7000-8000-000000000101";
const TURN = "01a00000-0000-7000-8000-000000000102";
const BINDING = "01a00000-0000-7000-8000-000000000103";
const CURRENT_THREAD = "01a00000-0000-7000-8000-000000000104";
const CURRENT_TURN = "01a00000-0000-7000-8000-000000000105";
const CURRENT_BINDING = "01a00000-0000-7000-8000-000000000106";
const COMMAND = "r4b-original-command";
const MESSAGE = "execute R4b";
const DIGEST = "a".repeat(64);
const TURN_2 = "01a00000-0000-7000-8000-000000000107";
const BINDING_2 = "01a00000-0000-7000-8000-000000000108";

let stateDir: string;
let root: string;
let workspace: { id: string; root: string };
let plannerRouteId: string;
let executorRouteId: string;
let record: StoredExecutionRecord;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function recordsFile(): string {
  return path.join(stateDir, "executions", `${workspace.id}.jsonl`);
}

function outboxFile(): string {
  return resultOutboxFile(workspace.id);
}

function appendRecord(value: StoredExecutionRecord): void {
  withExecutionRecordsLock(workspace.id, () => appendExecutionRecordLocked(workspace.id, value));
}

function writeRecord(value: StoredExecutionRecord): void {
  fs.writeFileSync(recordsFile(), `${JSON.stringify(value)}\n`);
}

function changeRecord(change: (value: StoredExecutionRecord) => StoredExecutionRecord): void {
  writeRecord(change(record));
}

function receipt(options: {
  commandId: string;
  summary: string;
  threadId: string;
  turnId: string;
  bindingId: string;
  desktopReceiptSha256?: string;
}): StoredExecutionRecord {
  return {
    taskId: `desktop_${options.commandId}`,
    iteration: 1,
    changedFiles: ["src/r4b.ts"],
    tests: "3 passed",
    exitStatus: "ok",
    timestamp: new Date().toISOString(),
    commandId: options.commandId,
    desktopReceiptSha256: options.desktopReceiptSha256 ?? sha256(`receipt:${options.commandId}`),
    rawSummary: options.summary,
    desktopThreadId: options.threadId,
    desktopOriginTurnId: options.turnId,
    desktopResultTurnId: options.turnId,
    desktopBindingId: options.bindingId,
  };
}

function createAcceptedCommand(options: {
  commandId: string;
  plannerRouteId: string;
  executorRouteId: string;
  message: string;
  threadId: string;
  turnId: string;
  bindingId: string;
  intent?: "development_plan" | "revision";
  currentBinding?: {
    bindingId: string;
    threadId: string;
    hostId: "local";
    projectId: string;
    title: string;
    boundAt: string;
  };
}): StoredExecutionRecord {
  createCommand(workspace, {
    commandId: options.commandId,
    plannerRouteId: options.plannerRouteId,
    executorRouteId: options.executorRouteId,
    intent: options.intent ?? "development_plan",
    payloadBytes: Buffer.byteLength(options.message),
    payloadSha256: sha256(options.message),
  });
  transitionCommandDelivery(workspace, { commandId: options.commandId, deliveryStatus: "accepted" });

  const now = new Date().toISOString();
  updateDesktop(workspace.id, previous => ({
    state: {
      ...previous!,
      ...(options.currentBinding ? { enabled: true, binding: options.currentBinding } : {}),
      deliveries: [...previous!.deliveries, {
        commandId: options.commandId,
        clientId: "client-r4b",
        bindingId: options.bindingId,
        intent: options.intent ?? "development_plan",
        messageSha256: sha256(options.message),
        messageBytes: Buffer.byteLength(options.message),
        threadId: options.threadId,
        turnId: options.turnId,
        deliveryStatus: "accepted",
        createdAt: now,
        updatedAt: now,
      }],
    },
    result: undefined,
  }));

  const stored = receipt({
    commandId: options.commandId,
    summary: `Codex completed ${options.commandId}.`,
    threadId: options.threadId,
    turnId: options.turnId,
    bindingId: options.bindingId,
  });
  appendRecord(stored);
  return stored;
}

function reconcile(commandId = COMMAND) {
  return reconcileTrustedDesktopExecutionResult(workspace, commandId);
}

function fileSnapshot(file: string) {
  const content = fs.readFileSync(file, "utf8");
  const state = JSON.parse(content) as { revision: number };
  return { content, revision: state.revision, mtimeMs: fs.statSync(file).mtimeMs };
}

function outboxState(): { revision: number } {
  return JSON.parse(fs.readFileSync(outboxFile(), "utf8")) as { revision: number };
}

function reconciliationState(): { revision: number; entries: Array<{ commandId: string; reasonCode: string }> } {
  return JSON.parse(fs.readFileSync(resultReconciliationQueueFile(workspace.id), "utf8")) as {
    revision: number;
    entries: Array<{ commandId: string; reasonCode: string }>;
  };
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-r4b-reconciler-state-"));
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "c2c-r4b-reconciler-root-")));
  process.env.C2C_STATE_DIR = stateDir;
  workspace = { id: new Workspace(root).id, root };
  const planner = registerRoute(workspace, {
    role: "planner", platform: "chatgpt_web", conversationId: "planner-r4b-original", locator: {},
  });
  const executor = registerRoute(workspace, {
    role: "executor", platform: "codex_desktop", conversationId: THREAD,
    locator: { hostId: "local", executorProjectId: "project-r4b" },
  });
  plannerRouteId = planner.routeId;
  executorRouteId = executor.routeId;
  updateDesktop(workspace.id, () => ({
    state: {
      version: 1, workspaceId: workspace.id, workspaceRoot: root, enabled: true,
      binding: {
        bindingId: BINDING, threadId: THREAD, hostId: "local", projectId: "project-r4b",
        title: "R4b", boundAt: new Date().toISOString(),
      },
      deliveries: [],
    },
    result: undefined,
  }));
  record = createAcceptedCommand({
    commandId: COMMAND, plannerRouteId, executorRouteId, message: MESSAGE,
    threadId: THREAD, turnId: TURN, bindingId: BINDING,
  });
});

afterEach(() => {
  delete process.env.C2C_STATE_DIR;
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

describe("R4b trusted Desktop execution result reconciliation", () => {
  it("accepted Command 与可信 Desktop receipt 生成 canonical result 和原 planner route 的 outbox", () => {
    const result = reconcile();
    const routing = readRouting(workspace);
    const canonical = routing?.results[0];
    const entries = listResultOutboxEntries(workspace);

    expect(result).toMatchObject({ status: "reconciled", plannerRouteId, outboxReplayed: false });
    expect(canonical).toMatchObject({
      commandId: COMMAND,
      executorRouteId,
      iteration: 1,
      status: "ok",
      rawSummary: record.rawSummary,
      machineEvidence: {
        source: "codex_desktop_receipt",
        desktopReceiptSha256: record.desktopReceiptSha256,
        taskId: `desktop_${COMMAND}`,
        threadId: THREAD,
        originTurnId: TURN,
        resultTurnId: TURN,
        bindingId: BINDING,
      },
    });
    expect(result).toMatchObject({ status: "reconciled", resultId: canonical?.resultId });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      commandId: COMMAND,
      plannerRouteId,
      resultId: canonical?.resultId,
      executorRouteId,
      iteration: 1,
      status: "ok",
      deliveryStatus: "pending",
    });
  });

  it("Desktop 已禁用且 binding=null 时仍按历史 accepted delivery 对账", () => {
    updateDesktop(workspace.id, previous => ({
      state: { ...previous!, enabled: false, binding: null },
      result: undefined,
    }));

    expect(readDesktop(workspace.id)).toMatchObject({ enabled: false, binding: null });
    expect(reconcile()).toMatchObject({ status: "reconciled", plannerRouteId });
    expect(readRouting(workspace)?.results).toHaveLength(1);
    expect(listResultOutboxEntries(workspace)).toHaveLength(1);
    expect(fs.existsSync(path.join(stateDir, "feedback"))).toBe(false);
  });

  it("不同 Command 使用各自持久化的 plannerRouteId", () => {
    const secondPlanner = registerRoute(workspace, {
      role: "planner", platform: "chatgpt_web", conversationId: "planner-r4b-second", locator: {},
    });
    const second = createAcceptedCommand({
      commandId: "r4b-second-command",
      plannerRouteId: secondPlanner.routeId,
      executorRouteId,
      message: "execute a second R4b request",
      threadId: THREAD,
      turnId: TURN_2,
      bindingId: BINDING_2,
    });

    const firstResult = reconcile(COMMAND);
    const secondResult = reconcile("r4b-second-command");
    const entries = listResultOutboxEntries(workspace);

    expect(firstResult).toMatchObject({ status: "reconciled", plannerRouteId });
    expect(secondResult).toMatchObject({ status: "reconciled", plannerRouteId: secondPlanner.routeId });
    expect(second.desktopReceiptSha256).not.toBe(record.desktopReceiptSha256);
    expect(entries).toHaveLength(2);
    expect(entries.find(entry => entry.commandId === COMMAND)?.plannerRouteId).toBe(plannerRouteId);
    expect(entries.find(entry => entry.commandId === "r4b-second-command")?.plannerRouteId).toBe(secondPlanner.routeId);
  });

  it("完全重放不增加 Routing/Outbox revision，也不改写文件 mtime", () => {
    const first = reconcile();
    const routingBefore = fileSnapshot(routingFile(workspace.id));
    const outboxBefore = fileSnapshot(outboxFile());
    const queueBefore = fileSnapshot(resultReconciliationQueueFile(workspace.id));
    expect(listResultReconciliationNeeded(workspace)).toEqual([]);

    const replay = reconcile();

    expect(first).toMatchObject({ status: "reconciled", outboxReplayed: false });
    expect(replay).toMatchObject({
      status: "reconciled", resultId: first.status === "reconciled" ? first.resultId : "",
      outboxEntryId: first.status === "reconciled" ? first.outboxEntryId : "",
      outboxReplayed: true,
    });
    expect(fileSnapshot(routingFile(workspace.id))).toEqual(routingBefore);
    expect(fileSnapshot(outboxFile())).toEqual(outboxBefore);
    expect(fileSnapshot(resultReconciliationQueueFile(workspace.id))).toEqual(queueBefore);
    expect(listResultReconciliationNeeded(workspace)).toEqual([]);
    expect(routingBefore.revision).toBe(readRouting(workspace)?.revision);
    expect(outboxBefore.revision).toBe(outboxState().revision);
  });

  it("收据提交前的 intent 在无收据时可安全清理，后续 writer 会重新发布", () => {
    fs.rmSync(recordsFile());
    prepareResultReconciliation(workspace, COMMAND);
    expect(listResultReconciliationNeeded(workspace)).toMatchObject([
      { commandId: COMMAND, reasonCode: "RESULT_RECONCILIATION_PENDING" },
    ]);

    expect(reconcile()).toMatchObject({ status: "not_canonical" });
    expect(listResultReconciliationNeeded(workspace)).toEqual([]);

    prepareResultReconciliation(workspace, COMMAND);
    appendRecord(record);
    expect(reconcile()).toMatchObject({ status: "reconciled" });
    expect(listResultReconciliationNeeded(workspace)).toEqual([]);
  });

  it("已有 canonical result 但缺少 outbox 时补建一次", () => {
    const candidate = projectTrustedDesktopExecutionResult(workspace, {
      commandId: COMMAND,
      desktopReceiptSha256: record.desktopReceiptSha256!,
    });
    const stored = appendResult(workspace, candidate);
    expect(listResultOutboxEntries(workspace)).toEqual([]);
    expect(fs.existsSync(outboxFile())).toBe(false);

    const repaired = reconcile();
    const afterRepair = fileSnapshot(outboxFile());
    const replay = reconcile();

    expect(repaired).toMatchObject({ status: "reconciled", resultId: stored.resultId, outboxReplayed: false });
    expect(replay).toMatchObject({ status: "reconciled", resultId: stored.resultId, outboxReplayed: true });
    expect(readRouting(workspace)?.results).toHaveLength(1);
    expect(listResultOutboxEntries(workspace)).toHaveLength(1);
    expect(outboxState().revision).toBe(1);
    expect(fileSnapshot(outboxFile())).toEqual(afterRepair);
  });

  it("缺少 rawSummary 的历史 receipt 与 generic record 都不生成 canonical result/outbox", () => {
    changeRecord(value => {
      const legacy = { ...value };
      delete legacy.rawSummary;
      return legacy;
    });

    expect(reconcile()).toEqual({ status: "not_canonical", reason: "receipt_not_trusted_or_legacy" });
    expect(readRouting(workspace)?.results).toEqual([]);
    expect(listResultOutboxEntries(workspace)).toEqual([]);
    expect(fs.existsSync(outboxFile())).toBe(false);

    changeRecord(value => {
      const { desktopReceiptSha256: _hash, desktopThreadId: _thread, desktopOriginTurnId: _origin,
        desktopResultTurnId: _result, desktopBindingId: _binding, ...generic } = value;
      return generic;
    });
    expect(reconcile()).toEqual({ status: "not_canonical", reason: "receipt_not_trusted_or_legacy" });
    expect(readRouting(workspace)?.results).toEqual([]);
    expect(listResultOutboxEntries(workspace)).toEqual([]);
    expect(fs.existsSync(outboxFile())).toBe(false);
  });

  it("当前 planner/request 和 Desktop target 改变后仍使用历史 Command 的 route", () => {
    const currentPlanner = registerRoute(workspace, {
      role: "planner", platform: "chatgpt_web", conversationId: "planner-r4b-current", locator: {},
    });
    const currentExecutor = registerRoute(workspace, {
      role: "executor", platform: "codex_desktop", conversationId: CURRENT_THREAD,
      locator: { hostId: "local", executorProjectId: "project-r4b-current" },
    });
    const currentBinding = {
      bindingId: CURRENT_BINDING,
      threadId: CURRENT_THREAD,
      hostId: "local" as const,
      projectId: "project-r4b-current",
      title: "Current R4b target",
      boundAt: new Date().toISOString(),
    };
    createAcceptedCommand({
      commandId: "r4b-current-request",
      plannerRouteId: currentPlanner.routeId,
      executorRouteId: currentExecutor.routeId,
      message: "a newer request on the current target",
      intent: "revision",
      threadId: CURRENT_THREAD,
      turnId: CURRENT_TURN,
      bindingId: CURRENT_BINDING,
      currentBinding,
    });

    expect(readDesktop(workspace.id)?.binding).toMatchObject({ bindingId: CURRENT_BINDING, threadId: CURRENT_THREAD });
    expect(reconcile()).toMatchObject({ status: "reconciled", plannerRouteId });
    expect(listResultOutboxEntries(workspace)).toMatchObject([
      { commandId: COMMAND, plannerRouteId },
    ]);
    expect(readRouting(workspace)?.commands.find(command => command.commandId === "r4b-current-request"))
      .toMatchObject({ plannerRouteId: currentPlanner.routeId, executorRouteId: currentExecutor.routeId, intent: "revision" });
  });

  it("缺失 Command 不适用；未 accepted 或 receipt provenance 不符均 fail closed", () => {
    expect(reconcile("r4b-missing-command")).toEqual({
      status: "not_applicable", reason: "routing_command_missing",
    });
    expect(fs.existsSync(outboxFile())).toBe(false);

    createCommand(workspace, {
      commandId: "r4b-pending-command",
      plannerRouteId,
      executorRouteId,
      intent: "development_plan",
      payloadBytes: 1,
      payloadSha256: sha256("x"),
    });
    const pending = reconcile("r4b-pending-command");
    expect(pending).toMatchObject({
      status: "reconciliation_needed", reasonCode: "ROUTING_COMMAND_NOT_ACCEPTED", issuePersisted: true,
    });
    expect(readRouting(workspace)?.results).toEqual([]);
    expect(listResultOutboxEntries(workspace)).toEqual([]);
    expect(reconciliationState().entries).toContainEqual(expect.objectContaining({
      commandId: "r4b-pending-command", reasonCode: "ROUTING_COMMAND_NOT_ACCEPTED",
    }));
    expect(listResultReconciliationNeeded(workspace)).toEqual(expect.arrayContaining([
      expect.objectContaining({ commandId: "r4b-pending-command", reasonCode: "ROUTING_COMMAND_NOT_ACCEPTED" }),
    ]));

    updateDesktop(workspace.id, previous => ({
      state: {
        ...previous!,
        deliveries: previous!.deliveries.map(delivery => delivery.commandId === COMMAND
          ? { ...delivery, messageSha256: sha256("different accepted request") }
          : delivery),
      },
      result: undefined,
    }));
    const mismatch = reconcile();
    expect(mismatch).toMatchObject({
      status: "reconciliation_needed", reasonCode: "ROUTING_RESULT_EVIDENCE_CONFLICT", issuePersisted: true,
    });
    expect(readRouting(workspace)?.results).toEqual([]);
    expect(listResultOutboxEntries(workspace)).toEqual([]);
    expect(reconciliationState().entries).toContainEqual(expect.objectContaining({
      commandId: COMMAND, reasonCode: "ROUTING_RESULT_EVIDENCE_CONFLICT",
    }));
  });

  it("重复 receipt 作为歧义持久化为 reconciliation-needed，且不生成 result/outbox", () => {
    appendRecord(record);

    expect(reconcile()).toMatchObject({
      status: "reconciliation_needed", reasonCode: "ROUTING_RESULT_RECEIPT_AMBIGUOUS", issuePersisted: true,
    });
    expect(readRouting(workspace)?.results).toEqual([]);
    expect(listResultOutboxEntries(workspace)).toEqual([]);
    expect(reconciliationState().entries).toContainEqual(expect.objectContaining({
      commandId: COMMAND, reasonCode: "ROUTING_RESULT_RECEIPT_AMBIGUOUS",
    }));
  });
});
