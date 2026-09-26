import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import {
  RoutingError,
  type ResultInput,
} from "../src/routing/schema.js";
import {
  appendResult,
  createCommand,
  readRouting,
  registerRoute,
  routingFile,
  type RoutingWorkspaceIdentity,
} from "../src/routing/store.js";
import {
  enqueueResultOutboxEntry,
  listResultOutboxEntries,
  clearResultReconciliationNeeded,
  listResultReconciliationNeeded,
  markResultReconciliationNeeded,
  resultOutboxFile,
  resultReconciliationQueueFile,
} from "../src/routing/result-outbox-store.js";
import {
  resultOutboxStateSchema,
  resultReconciliationQueueSchema,
  type ResultOutboxState,
  type ResultReconciliationQueue,
} from "../src/routing/result-outbox-schema.js";

const EXECUTOR_THREAD = "01a00000-0000-7000-8000-000000000101";
const RECEIPT_THREAD = "01a00000-0000-7000-8000-000000000102";
const BINDING_ID = "01a00000-0000-7000-8000-000000000103";
const HEX64 = "b".repeat(64);

let tempDir: string;
let stateDir: string;
let identity: RoutingWorkspaceIdentity;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-result-outbox-"));
  stateDir = path.join(tempDir, "state");
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tempDir, "workspace-")));
  identity = { id: new Workspace(root).id, root };
});

afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function planner(conversationId = "planner-one") {
  return registerRoute(identity, {
    role: "planner",
    platform: "chatgpt_web",
    conversationId,
    locator: {},
  }, stateDir);
}

function executor() {
  return registerRoute(identity, {
    role: "executor",
    platform: "codex_desktop",
    conversationId: EXECUTOR_THREAD,
    locator: { hostId: "local", executorProjectId: "proj_alpha" },
  }, stateDir);
}

function commandAndResult(commandId = "cmd-001", plannerRouteId?: string) {
  const plannerRoute = plannerRouteId ?? planner().routeId;
  const executorRoute = executor();
  createCommand(identity, {
    commandId,
    plannerRouteId: plannerRoute,
    executorRouteId: executorRoute.routeId,
    intent: "development_plan",
    payloadBytes: 42,
    payloadSha256: HEX64,
  }, stateDir);
  const input: ResultInput = {
    commandId,
    executorRouteId: executorRoute.routeId,
    iteration: 1,
    status: "ok",
    rawSummary: "本轮实现完成。",
    machineEvidence: {
      version: 1,
      source: "codex_desktop_receipt",
      desktopReceiptSha256: HEX64,
      taskId: `desktop_${commandId}`,
      iteration: 1,
      status: "ok",
      threadId: EXECUTOR_THREAD,
      originTurnId: RECEIPT_THREAD,
      resultTurnId: RECEIPT_THREAD,
      bindingId: BINDING_ID,
      changedFiles: ["src/example.ts"],
      testsSummary: "focused test passed",
    },
  };
  appendResult(identity, input, stateDir);
  return { plannerRouteId: plannerRoute, executorRouteId: executorRoute.routeId };
}

function storedState(): ResultOutboxState {
  return resultOutboxStateSchema.parse(JSON.parse(fs.readFileSync(resultOutboxFile(identity.id, stateDir), "utf8")));
}

function reconciliationState(): ResultReconciliationQueue {
  return resultReconciliationQueueSchema.parse(JSON.parse(fs.readFileSync(resultReconciliationQueueFile(identity.id, stateDir), "utf8")));
}

function mutateRouting(change: (state: NonNullable<ReturnType<typeof readRouting>>) => void): void {
  const file = routingFile(identity.id, stateDir);
  const state = JSON.parse(fs.readFileSync(file, "utf8")) as NonNullable<ReturnType<typeof readRouting>>;
  change(state);
  fs.writeFileSync(file, JSON.stringify(state));
}

function errorCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof RoutingError) return error.code;
    throw error;
  }
  throw new Error("expected RoutingError but none was thrown");
}

describe("routing result outbox", () => {
  it("empty list is read-only and schema is strict, bounded, and workspace-scoped", () => {
    expect(listResultOutboxEntries(identity, stateDir)).toEqual([]);
    expect(listResultReconciliationNeeded(identity, stateDir)).toEqual([]);
    expect(fs.existsSync(path.join(stateDir, "routing"))).toBe(false);

    commandAndResult();
    const { entry } = enqueueResultOutboxEntry(identity, { commandId: "cmd-001", iteration: 1 }, stateDir);
    const valid = storedState();
    expect(() => resultOutboxStateSchema.parse({ ...valid, extra: true })).toThrow();
    expect(() => resultOutboxStateSchema.parse({
      ...valid,
      entries: [{ ...entry, extra: true }],
    })).toThrow();
    expect(() => resultOutboxStateSchema.parse({
      ...valid,
      entries: [{ ...entry, workspaceId: "000000000000" }],
    })).toThrow();
    const tooManyEntries = resultOutboxStateSchema.safeParse({ ...valid, entries: Array(10_001).fill(entry) });
    expect(tooManyEntries.success).toBe(false);
    if (!tooManyEntries.success) {
      expect(tooManyEntries.error.issues.some((issue) => issue.code === "too_big" && issue.path[0] === "entries")).toBe(true);
    }
    const queue = resultReconciliationQueueSchema.parse({
      version: 1, workspaceId: identity.id, workspaceRoot: identity.root,
      revision: 1, entries: [],
    });
    const tooManyIssues = resultReconciliationQueueSchema.safeParse({
      ...queue,
      entries: Array.from({ length: 10_001 }, (_, index) => ({
        commandId: `cmd-${index}`, reasonCode: "RESULT_PENDING", createdAt: new Date().toISOString(),
      })),
    });
    expect(tooManyIssues.success).toBe(false);
    if (!tooManyIssues.success) {
      expect(tooManyIssues.error.issues.some((issue) => issue.code === "too_big" && issue.path[0] === "entries")).toBe(true);
    }
    expect(errorCode(() => listResultOutboxEntries({ ...identity, id: "000000000000" }, stateDir)))
      .toBe("ROUTING_WORKSPACE_IDENTITY_MISMATCH");
  });

  it("stores planner ownership from each persisted Command when multiple planner routes exist", () => {
    const plannerOne = planner("planner-one");
    const plannerTwo = planner("planner-two");
    const executorRoute = executor();
    for (const [commandId, plannerRouteId] of [["cmd-one", plannerOne.routeId], ["cmd-two", plannerTwo.routeId]] as const) {
      createCommand(identity, {
        commandId,
        plannerRouteId,
        executorRouteId: executorRoute.routeId,
        intent: "development_plan",
        payloadBytes: 1,
        payloadSha256: HEX64,
      }, stateDir);
      appendResult(identity, {
        commandId,
        executorRouteId: executorRoute.routeId,
        iteration: 1,
        status: "ok",
        rawSummary: "done",
        machineEvidence: {
          version: 1, source: "codex_desktop_receipt", desktopReceiptSha256: HEX64,
          taskId: `desktop_${commandId}`, iteration: 1, status: "ok",
          threadId: EXECUTOR_THREAD, originTurnId: RECEIPT_THREAD, resultTurnId: RECEIPT_THREAD,
          bindingId: BINDING_ID, changedFiles: [], testsSummary: "passed",
        },
      }, stateDir);
    }
    const first = enqueueResultOutboxEntry(identity, { commandId: "cmd-one", iteration: 1 }, stateDir).entry;
    const second = enqueueResultOutboxEntry(identity, { commandId: "cmd-two", iteration: 1 }, stateDir).entry;
    expect(first.plannerRouteId).toBe(plannerOne.routeId);
    expect(second.plannerRouteId).toBe(plannerTwo.routeId);
    expect(first.plannerRouteId).not.toBe(second.plannerRouteId);
  });

  it("exact replay leaves revision, bytes, and main-file mtime unchanged", () => {
    commandAndResult();
    const first = enqueueResultOutboxEntry(identity, { commandId: "cmd-001", iteration: 1 }, stateDir);
    const file = resultOutboxFile(identity.id, stateDir);
    const before = { bytes: fs.readFileSync(file, "utf8"), mtimeMs: fs.statSync(file).mtimeMs };
    const replay = enqueueResultOutboxEntry(identity, { commandId: "cmd-001", iteration: 1 }, stateDir);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(fs.readFileSync(file, "utf8")).toBe(before.bytes);
    expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(storedState().revision).toBe(1);
  });

  it("enqueues only a reference to the canonical RoutingResult", () => {
    const { plannerRouteId, executorRouteId } = commandAndResult();
    const result = enqueueResultOutboxEntry(identity, { commandId: "cmd-001", iteration: 1 }, stateDir).entry;
    expect(result).toMatchObject({
      workspaceId: identity.id,
      plannerRouteId,
      commandId: "cmd-001",
      executorRouteId,
      iteration: 1,
      status: "ok",
      deliveryStatus: "pending",
    });
    expect(Object.keys(result).sort()).toEqual([
      "commandId", "createdAt", "deliveryStatus", "executorRouteId", "iteration", "outboxEntryId",
      "plannerRouteId", "resultId", "resultSha256", "status", "version", "workspaceId",
    ].sort());
    expect(result).not.toHaveProperty("rawSummary");
    expect(result).not.toHaveProperty("machineEvidence");
    expect(result.outboxEntryId).toBe(createHash("sha256")
      .update(JSON.stringify([identity.id, "cmd-001", 1]), "utf8").digest("hex"));
  });

  it.each(["summary", "evidence", "plannerRouteId", "resultId", "status"] as const)(
    "same command+iteration %s drift returns stable conflict without rewriting the outbox",
    (drift) => {
      const secondPlanner = planner("planner-two");
      commandAndResult("cmd-001");
      enqueueResultOutboxEntry(identity, { commandId: "cmd-001", iteration: 1 }, stateDir);
      const file = resultOutboxFile(identity.id, stateDir);
      const before = fs.readFileSync(file, "utf8");
      mutateRouting((state) => {
        const command = state.commands.find((item) => item.commandId === "cmd-001")!;
        const result = state.results.find((item) => item.commandId === "cmd-001")!;
        if (drift === "summary") result.rawSummary = "different summary";
        if (drift === "evidence" && "machineEvidence" in result) result.machineEvidence.testsSummary = "different evidence";
        if (drift === "plannerRouteId") command.plannerRouteId = secondPlanner.routeId;
        if (drift === "resultId") result.resultId = randomUUID();
        if (drift === "status") {
          result.status = "failed";
          if ("machineEvidence" in result) result.machineEvidence.status = "failed";
        }
      });
      expect(errorCode(() => enqueueResultOutboxEntry(identity, { commandId: "cmd-001", iteration: 1 }, stateDir)))
        .toBe("RESULT_OUTBOX_CONFLICT");
      expect(errorCode(() => listResultOutboxEntries(identity, stateDir))).toBe("RESULT_OUTBOX_CONFLICT");
      expect(fs.readFileSync(file, "utf8")).toBe(before);
    },
  );

  it("dangling and corrupt state fail closed and preserve the outbox file", () => {
    commandAndResult();
    enqueueResultOutboxEntry(identity, { commandId: "cmd-001", iteration: 1 }, stateDir);
    const file = resultOutboxFile(identity.id, stateDir);
    const validBytes = fs.readFileSync(file, "utf8");
    mutateRouting((state) => { state.results = []; });
    expect(errorCode(() => listResultOutboxEntries(identity, stateDir))).toBe("RESULT_OUTBOX_DANGLING");
    expect(fs.readFileSync(file, "utf8")).toBe(validBytes);

    fs.writeFileSync(file, "{ partial");
    const corruptBytes = fs.readFileSync(file, "utf8");
    expect(errorCode(() => enqueueResultOutboxEntry(identity, { commandId: "cmd-001", iteration: 1 }, stateDir)))
      .toBe("RESULT_OUTBOX_CORRUPT");
    expect(fs.readFileSync(file, "utf8")).toBe(corruptBytes);
  });

  it("an interrupted temp write leaves the primary state absent and retryable", () => {
    commandAndResult();
    const file = resultOutboxFile(identity.id, stateDir);
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, "{ partial");
    expect(listResultOutboxEntries(identity, stateDir)).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
    expect(enqueueResultOutboxEntry(identity, { commandId: "cmd-001", iteration: 1 }, stateDir).replayed).toBe(false);
    expect(listResultOutboxEntries(identity, stateDir)).toHaveLength(1);
    expect(fs.readFileSync(temporary, "utf8")).toBe("{ partial");
  });

  it("rejects persisted revision zero and preserves the file", () => {
    commandAndResult();
    enqueueResultOutboxEntry(identity, { commandId: "cmd-001", iteration: 1 }, stateDir);
    const file = resultOutboxFile(identity.id, stateDir);
    const state = JSON.parse(fs.readFileSync(file, "utf8")) as ResultOutboxState;
    fs.writeFileSync(file, JSON.stringify({ ...state, revision: 0 }));
    const bytes = fs.readFileSync(file, "utf8");
    expect(errorCode(() => listResultOutboxEntries(identity, stateDir))).toBe("RESULT_OUTBOX_CORRUPT");
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
  });

  it("rejects legacy results and nonexistent commands without creating entries", () => {
    commandAndResult();
    mutateRouting((state) => {
      const result = state.results[0] as Record<string, unknown>;
      delete result.rawSummary;
      delete result.machineEvidence;
    });
    expect(errorCode(() => enqueueResultOutboxEntry(identity, { commandId: "cmd-001", iteration: 1 }, stateDir)))
      .toBe("RESULT_OUTBOX_LEGACY_RESULT");
    expect(fs.existsSync(resultOutboxFile(identity.id, stateDir))).toBe(false);
    expect(errorCode(() => enqueueResultOutboxEntry(identity, { commandId: "missing-command", iteration: 1 }, stateDir)))
      .toBe("RESULT_OUTBOX_COMMAND_NOT_FOUND");
  });

  it("独立 recovery queue 精确重放不增 revision，恢复后清理且不改 Outbox replay 语义", () => {
    const plannerRoute = planner();
    const executorRoute = executor();
    createCommand(identity, {
      commandId: "cmd-pending",
      plannerRouteId: plannerRoute.routeId,
      executorRouteId: executorRoute.routeId,
      intent: "development_plan",
      payloadBytes: 1,
      payloadSha256: HEX64,
    }, stateDir);
    const issue = markResultReconciliationNeeded(identity, {
      commandId: "cmd-pending",
      reasonCode: "RESULT_RECONCILIATION_FAILED",
    }, stateDir);
    const unchangedRevision = reconciliationState().revision;
    const issueMtime = fs.statSync(resultReconciliationQueueFile(identity.id, stateDir)).mtimeMs;
    expect(markResultReconciliationNeeded(identity, {
      commandId: "cmd-pending",
      reasonCode: "RESULT_RECONCILIATION_FAILED",
    }, stateDir)).toEqual(issue);
    expect(reconciliationState().revision).toBe(unchangedRevision);
    expect(fs.statSync(resultReconciliationQueueFile(identity.id, stateDir)).mtimeMs).toBe(issueMtime);
    expect(listResultOutboxEntries(identity, stateDir)).toEqual([]);
    expect(listResultReconciliationNeeded(identity, stateDir)).toEqual([issue]);

    appendResult(identity, {
      commandId: "cmd-pending", executorRouteId: executorRoute.routeId, iteration: 1,
      status: "ok", rawSummary: "finished",
      machineEvidence: {
        version: 1, source: "codex_desktop_receipt", desktopReceiptSha256: HEX64,
        taskId: "desktop_cmd-pending", iteration: 1, status: "ok", threadId: EXECUTOR_THREAD,
        originTurnId: RECEIPT_THREAD, resultTurnId: RECEIPT_THREAD, bindingId: BINDING_ID,
        changedFiles: [], testsSummary: "passed",
      },
    }, stateDir);
    const first = enqueueResultOutboxEntry(identity, { commandId: "cmd-pending", iteration: 1 }, stateDir);
    expect(first.replayed).toBe(false);
    expect(listResultReconciliationNeeded(identity, stateDir)).toEqual([issue]);
    const replay = enqueueResultOutboxEntry(identity, { commandId: "cmd-pending", iteration: 1 }, stateDir);
    expect(replay.replayed).toBe(true);
    expect(storedState().entries).toEqual([first.entry]);
    expect(clearResultReconciliationNeeded(identity, issue.commandId, stateDir)).toBe(true);
    expect(listResultReconciliationNeeded(identity, stateDir)).toEqual([]);
  });

  it("独立 recovery queue 可查询/清理失败诊断，不创建 outbox entry", () => {
    const issue = markResultReconciliationNeeded(identity, {
      commandId: "cmd-unresolved",
      reasonCode: "RESULT_RECONCILIATION_FAILED",
    }, stateDir);
    expect(clearResultReconciliationNeeded(identity, issue.commandId, stateDir)).toBe(true);
    expect(clearResultReconciliationNeeded(identity, issue.commandId, stateDir)).toBe(false);
    expect(listResultOutboxEntries(identity, stateDir)).toEqual([]);
    expect(reconciliationState()).toMatchObject({ revision: 2, entries: [] });
  });
});
