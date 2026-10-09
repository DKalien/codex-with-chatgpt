import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { readDesktop, updateDesktop } from "../src/desktop/store.js";
import { appendExecutionRecordLocked, withExecutionRecordsLock, type StoredExecutionRecord } from "../src/execution/records.js";
import { appendResult, createCommand, readRouting, registerRoute, routingFile, transitionCommandDelivery } from "../src/routing/store.js";
import { projectTrustedDesktopExecutionResult } from "../src/routing/execution-result-projector.js";
import { reconcileTrustedDesktopExecutionResult } from "../src/routing/execution-result-reconciler.js";
import {
  listResultOutboxEntries,
  enqueueResultOutboxEntry,
  listResultReconciliationNeeded,
  prepareResultReconciliation,
  resultOutboxFile,
  resultReconciliationQueueFile,
} from "../src/routing/result-outbox-store.js";
import * as routingStore from "../src/routing/store.js";
import * as busService from "../src/result-bus/service.js";
import * as outboxStore from "../src/routing/result-outbox-store.js";
import * as lifecycleFence from "../src/command-cleanup/fence.js";
import { canonicalRoutingResultDigest } from "../src/routing/execution-result-digest.js";
import { enqueueResultBusEntry, listResultBusEntries, readResultBus, resultBusFile } from "../src/result-bus/store.js";

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
const runtimeFence = {
  desktopPid: 1001,
  desktopExe: "C:\\Program Files\\ChatGPT\\ChatGPT.exe",
  desktopCreation: "1000001",
  appServerPid: 1002,
  appServerExe: "C:\\Program Files\\ChatGPT\\codex.exe",
  appServerCreation: "1000002",
};

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

function createOutcomeUnknownCommand(options: {
  commandId: string;
  message: string;
  deliveryStatus?: "accepted" | "outcome_unknown";
  messageSha256?: string;
}) {
  createCommand(workspace, {
    commandId: options.commandId,
    plannerRouteId,
    executorRouteId,
    intent: "development_plan",
    payloadBytes: Buffer.byteLength(options.message),
    payloadSha256: sha256(options.message),
  });
  transitionCommandDelivery(workspace, {
    commandId: options.commandId,
    deliveryStatus: "outcome_unknown",
  });
  if (options.deliveryStatus === "accepted") {
    const now = new Date().toISOString();
    updateDesktop(workspace.id, previous => ({
      state: {
        ...previous!,
        deliveries: [...previous!.deliveries, {
          commandId: options.commandId,
          clientId: "client-r4c3",
          bindingId: BINDING,
          intent: "development_plan",
          messageSha256: options.messageSha256 ?? sha256(options.message),
          messageBytes: Buffer.byteLength(options.message),
          threadId: THREAD,
          turnId: TURN_2,
          deliveryStatus: "accepted",
          createdAt: now,
          updatedAt: now,
        }],
      },
      result: undefined,
    }));
    appendRecord(receipt({
      commandId: options.commandId,
      summary: `Codex completed ${options.commandId}.`,
      threadId: THREAD,
      turnId: TURN_2,
      bindingId: BINDING,
    }));
  }
}

function reconcile(commandId = COMMAND) {
  return reconcileTrustedDesktopExecutionResult(workspace, commandId);
}

function fileSnapshot(file: string) {
  const content = fs.readFileSync(file, "utf8");
  const state = JSON.parse(content) as { revision: number };
  return { content, revision: state.revision, mtimeMs: fs.statSync(file).mtimeMs };
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
      version: 1, workspaceId: workspace.id, workspaceRoot: root, enabled: true, runtimeFence,
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
  vi.restoreAllMocks();
  delete process.env.C2C_STATE_DIR;
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

describe("R4b trusted Desktop execution result reconciliation", () => {
  it("outcome_unknown Command 在唯一 Desktop accepted proof 后收敛并生成 canonical result/Bus", () => {
    const commandId = "r4c3-outcome-unknown-recovery";
    createOutcomeUnknownCommand({ commandId, message: "recover R4c3" , deliveryStatus: "accepted" });

    expect(reconcile(commandId)).toMatchObject({ status: "reconciled", plannerRouteId });
    expect(readRouting(workspace)?.commands.find(command => command.commandId === commandId)?.deliveryStatus)
      .toBe("accepted");
    expect(readRouting(workspace)?.results.filter(result => result.commandId === commandId)).toHaveLength(1);
    expect(listResultBusEntries(workspace).filter(entry => entry.commandId === commandId)).toHaveLength(1);
    expect(reconcile(commandId)).toMatchObject({ status: "reconciled", resultReplayed: true, resultBus: { projected: 0, replayed: 1 } });
  });

  it("Desktop 仍为 outcome_unknown 时不改写 Routing Command", () => {
    const commandId = "r4c3-outcome-unknown-still-unknown";
    createOutcomeUnknownCommand({ commandId, message: "still unknown" });
    expect(reconcile(commandId)).toMatchObject({
      status: "reconciliation_needed", reasonCode: "ROUTING_COMMAND_DESKTOP_PROOF_CONFLICT", issuePersisted: true,
    });
    expect(readRouting(workspace)?.commands.find(command => command.commandId === commandId)?.deliveryStatus)
      .toBe("outcome_unknown");
  });

  it("Desktop accepted proof 的 payload 漂移 fail closed 且不改写 Routing Command", () => {
    const commandId = "r4c3-outcome-unknown-digest-drift";
    createOutcomeUnknownCommand({ commandId, message: "digest drift", deliveryStatus: "accepted", messageSha256: sha256("other") });
    expect(reconcile(commandId)).toMatchObject({
      status: "reconciliation_needed", reasonCode: "ROUTING_COMMAND_DESKTOP_PROOF_CONFLICT", issuePersisted: true,
    });
    expect(readRouting(workspace)?.commands.find(command => command.commandId === commandId)?.deliveryStatus)
      .toBe("outcome_unknown");
  });

  it("accepted Command 与可信 Desktop receipt 生成 canonical result 和 Result Bus", () => {
    const result = reconcile();
    const routing = readRouting(workspace);
    const canonical = routing?.results[0];
    const entries = listResultBusEntries(workspace);

    expect(result).toMatchObject({ status: "reconciled", plannerRouteId, resultBus: { projected: 1, replayed: 0 } });
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
      resultId: canonical?.resultId,
      iteration: 1,
      deliveryStatus: "queued",
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
    expect(listResultOutboxEntries(workspace)).toEqual([]);
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
    const entries = listResultBusEntries(workspace);

    expect(firstResult).toMatchObject({ status: "reconciled", plannerRouteId });
    expect(secondResult).toMatchObject({ status: "reconciled", plannerRouteId: secondPlanner.routeId });
    expect(second.desktopReceiptSha256).not.toBe(record.desktopReceiptSha256);
    expect(entries).toHaveLength(2);
    expect(entries.find(entry => entry.commandId === COMMAND)?.result.commandId).toBe(COMMAND);
    expect(entries.find(entry => entry.commandId === "r4b-second-command")?.result.commandId).toBe("r4b-second-command");
  });

  it("完全重放不增加 Routing/Bus revision，也不改写文件 mtime", () => {
    const first = reconcile();
    const routingBefore = fileSnapshot(routingFile(workspace.id));
    const busBefore = fileSnapshot(resultBusFile(workspace.id));
    const queueBefore = fileSnapshot(resultReconciliationQueueFile(workspace.id));
    expect(listResultReconciliationNeeded(workspace)).toEqual([]);

    const replay = reconcile();

    expect(first).toMatchObject({ status: "reconciled", resultBus: { projected: 1, replayed: 0 } });
    expect(replay).toMatchObject({
      status: "reconciled", resultId: first.status === "reconciled" ? first.resultId : "",
      resultBus: { projected: 0, replayed: 1 },
    });
    expect(fileSnapshot(routingFile(workspace.id))).toEqual(routingBefore);
    expect(fileSnapshot(resultBusFile(workspace.id))).toEqual(busBefore);
    expect(fs.existsSync(outboxFile())).toBe(false);
    expect(fileSnapshot(resultReconciliationQueueFile(workspace.id))).toEqual(queueBefore);
    expect(listResultReconciliationNeeded(workspace)).toEqual([]);
    expect(routingBefore.revision).toBe(readRouting(workspace)?.revision);
    expect(busBefore.revision).toBe(readResultBus(workspace)?.revision);
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

  it("已有 canonical result 但缺少 Bus 时补建一次", () => {
    const candidate = projectTrustedDesktopExecutionResult(workspace, {
      commandId: COMMAND,
      desktopReceiptSha256: record.desktopReceiptSha256!,
    });
    const stored = appendResult(workspace, candidate);
    expect(listResultOutboxEntries(workspace)).toEqual([]);
    expect(fs.existsSync(outboxFile())).toBe(false);

    const repaired = reconcile();
    const afterRepair = fileSnapshot(resultBusFile(workspace.id));
    const replay = reconcile();

    expect(repaired).toMatchObject({ status: "reconciled", resultId: stored.resultId, resultBus: { projected: 1, replayed: 0 } });
    expect(replay).toMatchObject({ status: "reconciled", resultId: stored.resultId, resultBus: { projected: 0, replayed: 1 } });
    expect(readRouting(workspace)?.results).toHaveLength(1);
    expect(listResultOutboxEntries(workspace)).toEqual([]);
    expect(readResultBus(workspace)?.revision).toBe(1);
    expect(fileSnapshot(resultBusFile(workspace.id))).toEqual(afterRepair);
  });

  it("缺少 rawSummary 的历史 receipt 与 generic record 都不生成 canonical result/Bus", () => {
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
    expect(listResultBusEntries(workspace)).toMatchObject([
      { commandId: COMMAND },
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

describe("Desktop canonical Result Bus reconciliation", () => {
  it("canonical result 通过生产 seam 进入唯一 Result Bus", () => {
    const outcome = reconcile();
    expect(outcome).toMatchObject({
      status: "reconciled",
      resultBus: { projected: 1, replayed: 0 },
    });
    const entries = listResultBusEntries(workspace);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ commandId: COMMAND, iteration: 1, deliveryStatus: "queued", sendTarget: null });
    const persisted = readRouting(workspace)?.results.find(result => result.commandId === COMMAND);
    expect(persisted).toBeTruthy();
    expect(entries[0]!.resultSha256).toBe(canonicalRoutingResultDigest(persisted!));
    expect(reconcile()).toMatchObject({
      status: "reconciled", resultReplayed: true,
      resultBus: { projected: 0, replayed: 1 },
    });
  });

  it("crash gap：canonical result 已存在而 Bus 缺失时，后续生产对账补建且不重新执行 (B)", () => {
    const first = reconcile();
    expect(first).toMatchObject({ status: "reconciled", resultBus: { projected: 1, replayed: 0 } });
    fs.rmSync(resultBusFile(workspace.id));
    fs.rmSync(`${resultBusFile(workspace.id)}.initialized`);
    const repaired = reconcile();
    expect(repaired).toMatchObject({
      status: "reconciled", resultReplayed: true,
      resultBus: { projected: 1, replayed: 0 },
    });
    expect(listResultBusEntries(workspace)).toHaveLength(1);
    expect(repaired.status === "reconciled" ? repaired.resultId : "").toBe(
      first.status === "reconciled" ? first.resultId : "",
    );
    expect(readResultBus(workspace)?.revision).toBe(1);
  });

  it("Bus 故障保留 canonical result 和 durable pending，不能报告成功", () => {
    expect(reconcile()).toMatchObject({ status: "reconciled", resultBus: { projected: 1, replayed: 0 } });
    fs.writeFileSync(resultBusFile(workspace.id), "{}\n");
    const outcome = reconcile();
    expect(outcome).toMatchObject({
      status: "reconciliation_needed", reasonCode: "RESULT_BUS_STATE_CORRUPT", issuePersisted: true,
    });
    expect(readRouting(workspace)?.results.filter(result => result.commandId === COMMAND)).toHaveLength(1);
    expect(listResultOutboxEntries(workspace)).toEqual([]);
    expect(fs.readFileSync(resultBusFile(workspace.id), "utf8")).toBe("{}\n");
  });
});


describe("Desktop Result Bus durable recovery", () => {
  it("receipt/result 已落盘而 Bus 写锁繁忙时保留 pending，重试只补当前 command", () => {
    const lock = `${resultBusFile(workspace.id)}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "held");
    prepareResultReconciliation(workspace, COMMAND);
    expect(reconcile()).toMatchObject({ status: "reconciliation_needed", reasonCode: "RESULT_BUS_BUSY", issuePersisted: true });
    expect(readRouting(workspace)?.results).toHaveLength(1);
    expect(listResultReconciliationNeeded(workspace)).toMatchObject([{ commandId: COMMAND, reasonCode: "RESULT_BUS_BUSY" }]);
    expect(fs.existsSync(outboxFile())).toBe(false);
    fs.unlinkSync(lock);
    expect(reconcile()).toMatchObject({ status: "reconciled", resultReplayed: true, resultBus: { projected: 1, replayed: 0 } });
    expect(listResultReconciliationNeeded(workspace)).toEqual([]);
  });

  it("Bus 已提交但响应丢失时保留 pending，重放不改 Bus 或 Routing", () => {
    const project = busService.reconcileCommandResultBus;
    vi.spyOn(busService, "reconcileCommandResultBus").mockImplementationOnce((...args) => {
      project(...args);
      throw new Error("committed response lost");
    });
    expect(reconcile()).toMatchObject({ status: "reconciliation_needed", issuePersisted: true });
    const busBefore = fileSnapshot(resultBusFile(workspace.id));
    const routingBefore = fileSnapshot(routingFile(workspace.id));
    expect(listResultReconciliationNeeded(workspace)).toHaveLength(1);
    prepareResultReconciliation(workspace, COMMAND, true);
    expect(listResultReconciliationNeeded(workspace)).toHaveLength(1);
    expect(reconcile()).toMatchObject({ status: "reconciled", resultReplayed: true, resultBus: { projected: 0, replayed: 1 } });
    expect(fileSnapshot(resultBusFile(workspace.id))).toEqual(busBefore);
    expect(fileSnapshot(routingFile(workspace.id))).toEqual(routingBefore);
    expect(listResultReconciliationNeeded(workspace)).toEqual([]);
  });

  it("同 command 的 receipt digest 冲突不覆盖 canonical result 或 Bus", () => {
    expect(reconcile().status).toBe("reconciled");
    const busBefore = fileSnapshot(resultBusFile(workspace.id));
    const routingBefore = fileSnapshot(routingFile(workspace.id));
    changeRecord(value => ({ ...value, desktopReceiptSha256: "b".repeat(64), rawSummary: "conflicting receipt" }));
    expect(reconcile()).toMatchObject({ status: "reconciliation_needed", reasonCode: "RESULT_CONFLICT", issuePersisted: true });
    expect(fileSnapshot(resultBusFile(workspace.id))).toEqual(busBefore);
    expect(fileSnapshot(routingFile(workspace.id))).toEqual(routingBefore);
    expect(listResultReconciliationNeeded(workspace)).toHaveLength(1);
  });

  it("Bus 同 command/iteration 的 digest 冲突保留原文件和 durable pending", () => {
    const persisted = appendResult(workspace, projectTrustedDesktopExecutionResult(workspace, {
      commandId: COMMAND, desktopReceiptSha256: record.desktopReceiptSha256!,
    }));
    enqueueResultBusEntry(workspace, { ...persisted, rawSummary: "different canonical summary" });
    const before = fileSnapshot(resultBusFile(workspace.id));
    expect(reconcile()).toMatchObject({ status: "reconciliation_needed", reasonCode: "RESULT_BUS_CONFLICT", issuePersisted: true });
    expect(fileSnapshot(resultBusFile(workspace.id))).toEqual(before);
    expect(listResultReconciliationNeeded(workspace)).toMatchObject([{ commandId: COMMAND, reasonCode: "RESULT_BUS_CONFLICT" }]);
  });

  it("单 command 投影不读取或获取无关 command 的 lifecycle authority", () => {
    const other = createAcceptedCommand({ commandId: "a-unrelated", plannerRouteId, executorRouteId,
      message: "unrelated", threadId: THREAD, turnId: TURN_2, bindingId: BINDING_2 });
    appendResult(workspace, projectTrustedDesktopExecutionResult(workspace, {
      commandId: "a-unrelated", desktopReceiptSha256: other.desktopReceiptSha256!,
    }));
    const lock = `${lifecycleFence.cleanupJournalFile(workspace.id, "a-unrelated")}.lock`;
    fs.writeFileSync(lock, "held");
    expect(reconcile()).toMatchObject({ status: "reconciled", resultBus: { projected: 1, replayed: 0 } });
    expect(listResultBusEntries(workspace).map(item => item.commandId)).toEqual([COMMAND]);
    expect(fs.readFileSync(lock, "utf8")).toBe("held");
    fs.unlinkSync(lock);
    expect(busService.reconcileWorkspaceResultBus(workspace)).toEqual({ projected: 1, replayed: 1 });
  });

  it("投影先释放原 command/records 锁，再在新 command 锁内重读 enqueue", () => {
    const append = routingStore.appendResultWithReplay;
    const project = busService.reconcileCommandResultBus;
    const lock = `${lifecycleFence.cleanupJournalFile(workspace.id, COMMAND)}.lock`;
    let producerLock = "";
    vi.spyOn(routingStore, "appendResultWithReplay").mockImplementationOnce((...args) => {
      producerLock = fs.readFileSync(lock, "utf8");
      expect(fs.existsSync(`${recordsFile()}.lock`)).toBe(true);
      return append(...args);
    });
    const projected = vi.spyOn(busService, "reconcileCommandResultBus").mockImplementationOnce((...args) => {
      expect(fs.existsSync(`${recordsFile()}.lock`)).toBe(false);
      expect(fs.readFileSync(lock, "utf8")).not.toBe(producerLock);
      return project(...args);
    });
    expect(reconcile().status).toBe("reconciled");
    expect(projected).toHaveBeenCalledExactlyOnceWith(workspace, COMMAND);
  });

  it("历史 R4 outbox 不替代 Bus 完成，新结果保留历史文件字节", () => {
    const candidate = projectTrustedDesktopExecutionResult(workspace, {
      commandId: COMMAND, desktopReceiptSha256: record.desktopReceiptSha256!,
    });
    appendResult(workspace, candidate);
    enqueueResultOutboxEntry(workspace, { commandId: COMMAND, iteration: 1 });
    const history = fileSnapshot(outboxFile());
    prepareResultReconciliation(workspace, COMMAND, true);
    expect(listResultReconciliationNeeded(workspace)).toHaveLength(1);
    expect(reconcile()).toMatchObject({ status: "reconciled", resultBus: { projected: 1, replayed: 0 } });
    expect(fileSnapshot(outboxFile())).toEqual(history);
    const queue = fileSnapshot(resultReconciliationQueueFile(workspace.id));
    prepareResultReconciliation(workspace, COMMAND, true);
    expect(fileSnapshot(resultReconciliationQueueFile(workspace.id))).toEqual(queue);
  });

  it("Bus 成功而 pending 清理失败时仍报告未收敛，恢复后不重复投影", () => {
    vi.spyOn(outboxStore, "clearResultReconciliationNeeded").mockImplementationOnce(() => {
      throw Object.assign(new Error("queue locked"), { code: "RESULT_RECONCILIATION_BUSY" });
    });
    expect(reconcile()).toMatchObject({ status: "reconciliation_needed", reasonCode: "RESULT_RECONCILIATION_BUSY" });
    expect(listResultBusEntries(workspace)).toHaveLength(1);
    expect(listResultReconciliationNeeded(workspace)).toHaveLength(1);
    expect(reconcile()).toMatchObject({ status: "reconciled", resultBus: { projected: 0, replayed: 1 } });
    expect(listResultReconciliationNeeded(workspace)).toEqual([]);
  });
});
