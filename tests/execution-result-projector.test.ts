import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { updateDesktop } from "../src/desktop/store.js";
import { appendExecutionRecordLocked, isTrustedDesktopReceipt, readExecutionRecordsStrict, withExecutionRecordsLock, type StoredExecutionRecord } from "../src/execution/records.js";
import { saveExecutionOutput, saveRestrictedExecutionOutput } from "../src/execution/output.js";
import { projectTrustedDesktopExecutionResult } from "../src/routing/execution-result-projector.js";
import { createCommand, readRouting, registerRoute, routingFile, transitionCommandDelivery } from "../src/routing/store.js";

const THREAD = "01a00000-0000-7000-8000-000000000101";
const TURN = "01a00000-0000-7000-8000-000000000102";
const BINDING = "01a00000-0000-7000-8000-000000000103";
const DIGEST = "a".repeat(64);
const MESSAGE = "execute R4a";
const COMMAND = "r4a-test-command";
let stateDir: string;
let root: string;
let workspace: { id: string; root: string };
let record: StoredExecutionRecord;
let executorRouteId: string;

function recordsFile(): string { return path.join(stateDir, "executions", `${workspace.id}.jsonl`); }
function desktopFile(): string { return path.join(stateDir, "desktop-control", `${workspace.id}.json`); }
function writeRecord(value: StoredExecutionRecord = record): void {
  withExecutionRecordsLock(workspace.id, () => appendExecutionRecordLocked(workspace.id, value));
}
function project() {
  return projectTrustedDesktopExecutionResult(workspace, { commandId: COMMAND, desktopReceiptSha256: DIGEST });
}
function changeRecord(change: (value: StoredExecutionRecord) => StoredExecutionRecord): void {
  const next = change(record);
  fs.writeFileSync(recordsFile(), `${JSON.stringify(next)}\n`);
}
function changeDesktop(change: (state: Record<string, any>) => void): void {
  const state = JSON.parse(fs.readFileSync(desktopFile(), "utf8"));
  change(state);
  fs.writeFileSync(desktopFile(), JSON.stringify(state));
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-r4a-projector-state-"));
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "c2c-r4a-projector-root-")));
  process.env.C2C_STATE_DIR = stateDir;
  workspace = { id: new Workspace(root).id, root };
  const planner = registerRoute(workspace, { role: "planner", platform: "chatgpt_web", conversationId: "planner-r4a", locator: {} });
  const executor = registerRoute(workspace, { role: "executor", platform: "codex_desktop", conversationId: THREAD,
    locator: { hostId: "local", executorProjectId: "project-r4a" } });
  executorRouteId = executor.routeId;
  createCommand(workspace, { commandId: COMMAND, plannerRouteId: planner.routeId, executorRouteId: executor.routeId,
    intent: "development_plan", payloadBytes: Buffer.byteLength(MESSAGE),
    payloadSha256: createHash("sha256").update(MESSAGE).digest("hex") });
  transitionCommandDelivery(workspace, { commandId: COMMAND, deliveryStatus: "accepted" });
  updateDesktop(workspace.id, () => ({ state: {
    version: 1, workspaceId: workspace.id, workspaceRoot: root, enabled: true,
    binding: { bindingId: BINDING, threadId: THREAD, hostId: "local", projectId: "project-r4a",
      title: "R4a", boundAt: new Date().toISOString() },
    deliveries: [{ commandId: COMMAND, clientId: "client-r4a", bindingId: BINDING,
      intent: "development_plan", messageSha256: createHash("sha256").update(MESSAGE).digest("hex"),
      messageBytes: Buffer.byteLength(MESSAGE), threadId: THREAD, turnId: TURN, deliveryStatus: "accepted",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
  }, result: undefined }));
  record = { taskId: `desktop_${COMMAND}`, iteration: 1, changedFiles: ["src/r4a.ts"], tests: "3 passed",
    exitStatus: "ok", timestamp: new Date().toISOString(), commandId: COMMAND, desktopReceiptSha256: DIGEST,
    rawSummary: "Codex 完成 R4a 实现并验证。", desktopThreadId: THREAD, desktopOriginTurnId: TURN,
    desktopResultTurnId: TURN, desktopBindingId: BINDING };
  writeRecord();
});

afterEach(() => {
  delete process.env.C2C_STATE_DIR;
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

describe("R4a trusted Desktop receipt projector", () => {
  it("只读投影 canonical summary/evidence，不创建 Routing result、feedback 或 Desktop send", () => {
    const routingBefore = JSON.stringify(readRouting(workspace));
    const desktopBefore = fs.readFileSync(desktopFile(), "utf8");
    const recordsBefore = fs.readFileSync(recordsFile(), "utf8");
    expect(project()).toEqual({ commandId: COMMAND, executorRouteId, iteration: 1, status: "ok",
      rawSummary: record.rawSummary, machineEvidence: {
        version: 1, source: "codex_desktop_receipt", desktopReceiptSha256: DIGEST,
        taskId: record.taskId, iteration: 1, status: "ok", threadId: THREAD,
        originTurnId: TURN, resultTurnId: TURN, bindingId: BINDING,
        changedFiles: ["src/r4a.ts"], testsSummary: "3 passed",
      } });
    expect(JSON.stringify(readRouting(workspace))).toBe(routingBefore);
    expect(readRouting(workspace)?.results).toEqual([]);
    expect(fs.readFileSync(desktopFile(), "utf8")).toBe(desktopBefore);
    expect(fs.readFileSync(recordsFile(), "utf8")).toBe(recordsBefore);
    expect(fs.existsSync(path.join(stateDir, "feedback"))).toBe(false);
    const source = fs.readFileSync(path.join(process.cwd(), "src/routing/execution-result-projector.ts"), "utf8");
    expect(source).not.toMatch(/from ["'][^"']*(?:browser|feedback|desktop\/service)/);
    expect(source).not.toMatch(/\b(?:appendResult|sendDesktop|reconcileFeedbackOutbox)\(/);
  });

  it("generic/legacy、缺失或重复的 receipt 均 fail closed", () => {
    changeRecord(value => { const { desktopReceiptSha256: _hash, ...generic } = value; return generic; });
    expect(project).toThrow();
    changeRecord(value => value);
    writeRecord();
    expect(project).toThrow();
    fs.writeFileSync(recordsFile(), "");
    expect(project).toThrow();
  });

  it("缺少 rawSummary 的旧 v2 trusted receipt 不参与 canonical projection", () => {
    changeRecord(value => {
      const legacy = { ...value };
      delete legacy.rawSummary;
      return legacy;
    });
    const [legacy] = readExecutionRecordsStrict(workspace.id);
    expect(isTrustedDesktopReceipt(legacy!, COMMAND)).toBe(true);
    expect(project).toThrow(/可信摘要/);
  });

  it("缺少/重复 accepted delivery、错 executor/thread/turn/binding、摘要不符均拒绝", () => {
    expect(() => projectTrustedDesktopExecutionResult(workspace,
      { commandId: "other-command", desktopReceiptSha256: DIGEST })).toThrow();
    expect(() => projectTrustedDesktopExecutionResult(workspace,
      { commandId: COMMAND, desktopReceiptSha256: "b".repeat(64) })).toThrow();
    changeDesktop(state => { state.deliveries[0].threadId = TURN; });
    expect(project).toThrow();
    changeDesktop(state => { state.deliveries[0].threadId = THREAD; state.deliveries[0].turnId = THREAD; });
    expect(project).toThrow();
    changeDesktop(state => { state.deliveries[0].turnId = TURN; state.deliveries[0].bindingId = THREAD; });
    expect(project).toThrow();
    changeDesktop(state => { state.deliveries = []; });
    expect(project).toThrow();
    changeDesktop(state => { state.deliveries = [state.binding && {
      commandId: COMMAND, clientId: "client-r4a", bindingId: BINDING, intent: "development_plan",
      messageSha256: createHash("sha256").update(MESSAGE).digest("hex"), messageBytes: Buffer.byteLength(MESSAGE),
      threadId: THREAD, turnId: TURN, deliveryStatus: "accepted", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }].filter(Boolean); state.deliveries.push({ ...state.deliveries[0] }); });
    expect(project).toThrow();
  });

  it("Routing Command/executor 改指另一真实 Desktop route 也拒绝，损坏 routing state 保留", () => {
    const other = registerRoute(workspace, { role: "executor", platform: "codex_desktop",
      conversationId: "01a00000-0000-7000-8000-000000000104",
      locator: { hostId: "local", executorProjectId: "project-r4a" } });
    const file = routingFile(workspace.id);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    state.commands[0].executorRouteId = other.routeId;
    fs.writeFileSync(file, JSON.stringify(state));
    expect(project).toThrow();
    state.commands[0].plannerRouteId = other.routeId;
    fs.writeFileSync(file, JSON.stringify(state));
    const corrupt = fs.readFileSync(file, "utf8");
    expect(project).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(corrupt);
  });

  it("receipt task/iteration/provenance 和损坏 JSONL 均拒绝", () => {
    changeRecord(value => ({ ...value, taskId: "desktop_other" }));
    expect(project).toThrow();
    changeRecord(value => ({ ...value, iteration: 2 }));
    expect(project).toThrow();
    changeRecord(value => ({ ...value, desktopResultTurnId: "bad" }));
    expect(project).toThrow();
    fs.writeFileSync(recordsFile(), "{broken\n");
    expect(project).toThrow();
  });

  it("outputId/outputAvailable 必须成对且严格匹配 index；restricted 输出只投元数据", () => {
    changeRecord(value => ({ ...value, outputId: 1 }));
    expect(project).toThrow();
    const meta = saveRestrictedExecutionOutput(workspace.id, { command: "test", reason: "private_key",
      taskId: record.taskId, iteration: 1 });
    changeRecord(value => ({ ...value, outputId: meta.id, outputAvailable: true }));
    expect(project).toThrow();
    changeRecord(value => ({ ...value, outputId: meta.id, outputAvailable: false }));
    expect(project().machineEvidence.output).toEqual({ outputId: meta.id, outputAvailable: false });
    const second = saveExecutionOutput(workspace.id, { command: "other", raw: "safe", taskId: record.taskId, iteration: 1 });
    changeRecord(value => ({ ...value, outputId: second.id, outputAvailable: true }));
    expect(project).toThrow();
  });
});
