import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listExecutionOutputs, readExecutionOutput, saveExecutionOutput } from "../src/execution/output.js";
import { appendExecutionRecord, readExecutionRecords } from "../src/execution/records.js";
import { desktopIpc, type DesktopResultClassification, type DesktopResultContext } from "../src/desktop/ipc.js";
import { discoverCurrentDesktopDelivery, recordDesktopResult, type DesktopResultInput } from "../src/desktop/result.js";
import { receiptFinalizationMarkerDigest } from "../src/desktop/receipt-finalizer.js";
import { DesktopError, desktopFile, readDesktop, updateDesktop } from "../src/desktop/store.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const workspace = { id: "desktop_result_test", root: process.cwd() };
const threadId = "01a00000-0000-7000-8000-000000000101";
const otherThreadId = "01a00000-0000-7000-8000-000000000102";
const bindingId = "00000000-0000-4000-8000-000000000101";
const turnId = "00000000-0000-4000-8000-000000000102";
const continuationTurnId = "00000000-0000-4000-8000-000000000103";
const continuationTurnId2 = "00000000-0000-4000-8000-000000000104";
const originTurnId = "00000000-0000-4000-8000-000000000105";
const commandId = "desktop_command_1";
let stateDir: string;
let previousThread: string | undefined;

function validResultContext(overrides: Partial<DesktopResultContext> = {}): DesktopResultContext {
  return {
    threadId,
    hostId: "local",
    projectId: "desktop_result_project",
    workspaceRoot: workspace.root,
    title: "Desktop 结果测试",
    cwd: workspace.root,
    runtimeStatus: "idle",
    resultTurnId: turnId,
    resultTurnStatus: "completed",
    ...overrides,
  };
}

type DeliveryOverride = Partial<{
  commandId: string;
  threadId: string;
  deliveryStatus: "accepted" | "outcome_unknown" | "rejected";
  turnId: string;
  errorCode: string;
  errorMessage: string;
}>;

function delivery(overrides: DeliveryOverride = {}) {
  const status = overrides.deliveryStatus ?? "accepted";
  const base = {
    commandId,
    clientId: "desktop-result-test",
    bindingId,
    threadId,
    messageSha256: "a".repeat(64),
    messageBytes: 10,
    deliveryStatus: status,
    intent: "development_plan",
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
  } as Record<string, unknown>;
  if (status === "accepted") base.turnId = overrides.turnId ?? turnId;
  if (status === "rejected") {
    base.errorCode = overrides.errorCode ?? "DESKTOP_BUSY";
    base.errorMessage = overrides.errorMessage ?? "目标忙";
  }
  return { ...base, ...overrides };
}

function writeDesktopState(options: {
  enabled?: boolean;
  workspaceRoot?: string;
  binding?: unknown;
  deliveries?: unknown[];
} = {}): void {
  const file = desktopFile(workspace.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const binding = options.binding === undefined ? {
    threadId,
    hostId: "local",
    projectId: "desktop_result_project",
    bindingId,
    title: "Desktop 结果测试",
    boundAt: "2026-09-12T00:00:00.000Z",
  } : options.binding;
  const state = {
    version: 1,
    workspaceId: workspace.id,
    workspaceRoot: options.workspaceRoot ?? workspace.root,
    enabled: options.enabled ?? true,
    binding,
    deliveries: options.deliveries ?? [delivery()],
  };
  fs.writeFileSync(file, JSON.stringify(state));
  fs.writeFileSync(`${file}.initialized`, "1\n");
}

function input(overrides: Partial<DesktopResultInput> = {}): DesktopResultInput {
  return {
    commandId,
    changedFiles: ["src/desktop/result.ts"],
    tests: "pnpm vitest run tests/desktop-result.test.ts",
    exitStatus: "ok",
    command: "pnpm test",
    output: "1 passed\n",
    ...overrides,
  };
}

function recordsFile(): string {
  return path.join(stateDir, "executions", `${workspace.id}.jsonl`);
}

interface ChildResult {
  code: number | null;
  stderr: string;
  error?: string;
}

function child(script: string): Promise<ChildResult> {
  return new Promise(resolve => {
    const proc = spawn(process.execPath, ["--import", "tsx", script], {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stdout?.resume();
    proc.stderr.on("data", chunk => { stderr += String(chunk); });
    proc.once("error", error => resolve({ code: null, stderr, error: error.message }));
    proc.once("close", code => resolve({ code, stderr }));
  });
}

beforeEach(() => {
  stateDir = isolateStateDir();
  previousThread = process.env.CODEX_THREAD_ID;
  process.env.CODEX_THREAD_ID = threadId;
  vi.spyOn(desktopIpc, "currentResultContext").mockResolvedValue(validResultContext());
});

afterEach(() => {
  delete process.env.C2C_RECEIPT_FINALIZER_NO_SPAWN;
  if (previousThread === undefined) delete process.env.CODEX_THREAD_ID;
  else process.env.CODEX_THREAD_ID = previousThread;
  vi.restoreAllMocks();
  cleanup(stateDir);
});

describe("Desktop execution result", () => {
  it("自动发现按当前 resultTurn 精确选择历史 accepted delivery", async () => {
    const older = delivery({ commandId: "desktop_command_old", turnId: originTurnId });
    writeDesktopState({ deliveries: [older, delivery()] });
    vi.spyOn(desktopIpc, "currentResultClassification").mockResolvedValue({
      ...validResultContext(), classification: "applicable", workspaceId: workspace.id, commandId,
      intent: "development_plan", messageBytes: 10, messageSha256: "a".repeat(64),
      ownership: "origin", originTurnId: turnId, chainTurnIds: [turnId], chainLength: 0, signature: null,
    } satisfies DesktopResultClassification);
    await expect(discoverCurrentDesktopDelivery(workspace)).resolves.toMatchObject({
      commandId,
      threadId,
      turnId,
      ownership: { ownership: "origin", originTurnId: turnId },
    });
  });

  it("自动发现保留 accepted origin，并映射唯一 native continuation tip", async () => {
    writeDesktopState({ deliveries: [delivery({ turnId: originTurnId })] });
    vi.spyOn(desktopIpc, "currentResultClassification").mockResolvedValue({
      ...validResultContext({ runtimeStatus: "idle", resultTurnId: continuationTurnId, resultTurnStatus: "completed" }),
      classification: "applicable", workspaceId: workspace.id, commandId,
      intent: "development_plan", messageBytes: 10, messageSha256: "a".repeat(64),
      ownership: "native_continuation", originTurnId,
      chainTurnIds: [originTurnId, continuationTurnId], chainLength: 1, signature: "capacity_retry_automatic",
    } satisfies DesktopResultClassification);
    await expect(discoverCurrentDesktopDelivery(workspace)).resolves.toMatchObject({
      commandId, threadId, turnId: continuationTurnId,
      ownership: { ownership: "native_continuation", originTurnId, chainTurnIds: [originTurnId, continuationTurnId] },
    });
  });

  it("accepted 历史超过八条时仍按 self-attestation 精确匹配", async () => {
    const older = Array.from({ length: 8 }, (_, index) => delivery({
      commandId: `desktop_old_${index}`,
      turnId: `00000000-0000-4000-8000-${String(200 + index).padStart(12, "0")}`,
    }));
    writeDesktopState({ deliveries: [...older, delivery()] });
    vi.spyOn(desktopIpc, "currentResultClassification").mockResolvedValue({
      ...validResultContext(), classification: "applicable", workspaceId: workspace.id, commandId,
      intent: "development_plan", messageBytes: 10, messageSha256: "a".repeat(64),
      ownership: "origin", originTurnId: turnId, chainTurnIds: [turnId], chainLength: 0, signature: null,
    } satisfies DesktopResultClassification);

    await expect(discoverCurrentDesktopDelivery(workspace)).resolves.toMatchObject({ commandId, turnId });
  });

  it("self-attestation 的 durable 指纹不一致时 fail closed", async () => {
    writeDesktopState();
    vi.spyOn(desktopIpc, "currentResultClassification").mockResolvedValue({
      ...validResultContext(), classification: "applicable", workspaceId: workspace.id, commandId,
      intent: "development_plan", messageBytes: 10, messageSha256: "b".repeat(64),
      ownership: "origin", originTurnId: turnId, chainTurnIds: [turnId], chainLength: 0, signature: null,
    } satisfies DesktopResultClassification);

    await expect(discoverCurrentDesktopDelivery(workspace))
      .rejects.toMatchObject({ code: "DESKTOP_RESULT_CURRENT_EXECUTION" });
  });

  it("普通当前 turn 的 classification 只允许回退普通记录", async () => {
    writeDesktopState();
    vi.spyOn(desktopIpc, "currentResultClassification").mockResolvedValue({
      ...validResultContext(), classification: "not_applicable",
    } satisfies DesktopResultClassification);
    await expect(discoverCurrentDesktopDelivery(workspace)).rejects.toMatchObject({ code: "DESKTOP_RESULT_NOT_APPLICABLE" });
  });

  it("durable 状态缺失时仍先做 classifier，普通 turn 才能回退", async () => {
    const classify = vi.spyOn(desktopIpc, "currentResultClassification").mockResolvedValue({
      ...validResultContext(), classification: "not_applicable",
    } satisfies DesktopResultClassification);
    await expect(discoverCurrentDesktopDelivery(workspace)).rejects.toMatchObject({ code: "DESKTOP_RESULT_NOT_APPLICABLE" });
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it("durable 状态缺失但 current turn 自证为 Desktop 时 fail closed", async () => {
    vi.spyOn(desktopIpc, "currentResultClassification").mockResolvedValue({
      ...validResultContext(), classification: "applicable", workspaceId: workspace.id, commandId,
      intent: "development_plan", messageBytes: 10, messageSha256: "a".repeat(64),
      ownership: "origin", originTurnId: turnId, chainTurnIds: [turnId], chainLength: 0, signature: null,
    } satisfies DesktopResultClassification);
    await expect(discoverCurrentDesktopDelivery(workspace)).rejects.toMatchObject({ code: "DESKTOP_RESULT_CURRENT_EXECUTION" });
  });

  it("durable 状态根目录漂移时不回退普通记录", async () => {
    writeDesktopState({ workspaceRoot: path.join(workspace.root, "other") });
    const classify = vi.spyOn(desktopIpc, "currentResultClassification");
    await expect(discoverCurrentDesktopDelivery(workspace)).rejects.toMatchObject({ code: "DESKTOP_WRONG_WORKSPACE" });
    expect(classify).not.toHaveBeenCalled();
  });

  it("accepted exact delivery 走现有 receipt 路径且不调用 reconciliation", async () => {
    writeDesktopState();
    const reconcile = vi.spyOn(desktopIpc, "reconcileUnknown");
    const ownership = vi.spyOn(desktopIpc, "currentResultOwnership");

    await expect(recordDesktopResult(workspace, input())).resolves.toMatchObject({
      record: { commandId },
    });
    expect(reconcile).not.toHaveBeenCalled();
    expect(ownership).not.toHaveBeenCalled();
  });

  it("inProgress Desktop result 只暂存 pending，不写 trusted receipt 或 output", async () => {
    process.env.C2C_RECEIPT_FINALIZER_NO_SPAWN = "1";
    writeDesktopState();
    vi.mocked(desktopIpc.currentResultContext).mockResolvedValue(validResultContext({
      runtimeStatus: "active", resultTurnStatus: "inProgress",
    }));
    const marker = {
      resultTurnId: turnId,
      itemIds: ["record-marker"],
      itemTypes: ["userMessage"],
      itemCount: 1,
      itemSha256: "",
    };
    marker.itemSha256 = receiptFinalizationMarkerDigest(marker);
    vi.spyOn(desktopIpc, "inspectResultActivityMarker").mockResolvedValue({
      ...validResultContext({ runtimeStatus: "active", resultTurnStatus: "inProgress" }),
      marker,
    });
    await expect(recordDesktopResult(workspace, input())).rejects.toMatchObject({
      draft: {
        version: 2,
        input: { commandId, output: "1 passed\n" },
        marker: { resultTurnId: turnId, itemCount: 1, itemIds: ["record-marker"], itemTypes: ["userMessage"] },
      },
    });
    expect(readExecutionRecords(workspace.id)).toEqual([]);
    expect(listExecutionOutputs(workspace.id, Number.MAX_SAFE_INTEGER)).toEqual([]);
    delete process.env.C2C_RECEIPT_FINALIZER_NO_SPAWN;
  });

  it("accepted origin 在 capacity-retry continuation tip 上只写一条 receipt，且 origin turn 不变", async () => {
    writeDesktopState({ deliveries: [delivery({ turnId: originTurnId })] });
    vi.mocked(desktopIpc.currentResultContext).mockResolvedValue(validResultContext({
      runtimeStatus: "idle", resultTurnId: continuationTurnId, resultTurnStatus: "completed",
    }));
    const ownership = vi.spyOn(desktopIpc, "currentResultOwnership").mockResolvedValue({
      ...validResultContext({ runtimeStatus: "idle", resultTurnId: continuationTurnId, resultTurnStatus: "completed" }),
      ownership: "native_continuation", originTurnId, chainTurnIds: [originTurnId, continuationTurnId],
      chainLength: 1, signature: "capacity_retry_automatic",
    });

    const result = await recordDesktopResult(workspace, input());

    expect(result.record.commandId).toBe(commandId);
    expect(ownership).toHaveBeenCalledTimes(2);
    expect(readDesktop(workspace.id)?.deliveries[0]).toMatchObject({ deliveryStatus: "accepted", turnId: originTurnId });
    expect(readExecutionRecords(workspace.id)).toHaveLength(1);
    expect(listExecutionOutputs(workspace.id)).toHaveLength(1);
  });

  it("重复 native continuation chain 在 bounded limit 内可写 receipt", async () => {
    writeDesktopState({ deliveries: [delivery({ turnId: originTurnId })] });
    vi.mocked(desktopIpc.currentResultContext).mockResolvedValue(validResultContext({
      runtimeStatus: "idle", resultTurnId: continuationTurnId2, resultTurnStatus: "completed",
    }));
    vi.spyOn(desktopIpc, "currentResultOwnership").mockResolvedValue({
      ...validResultContext({ runtimeStatus: "idle", resultTurnId: continuationTurnId2, resultTurnStatus: "completed" }),
      ownership: "native_continuation", originTurnId,
      chainTurnIds: [originTurnId, continuationTurnId, continuationTurnId2], chainLength: 2,
      signature: "capacity_retry_automatic",
    });

    await expect(recordDesktopResult(workspace, input())).resolves.toMatchObject({ record: { commandId } });
    expect(readExecutionRecords(workspace.id)).toHaveLength(1);
    expect(readDesktop(workspace.id)?.deliveries[0].turnId).toBe(originTurnId);
  });

  it("continuation tip 在第二次证明前漂移时不写 output/record", async () => {
    writeDesktopState({ deliveries: [delivery({ turnId: originTurnId })] });
    vi.mocked(desktopIpc.currentResultContext)
      .mockResolvedValueOnce(validResultContext({ runtimeStatus: "idle", resultTurnId: continuationTurnId, resultTurnStatus: "completed" }))
      .mockResolvedValue(validResultContext({ runtimeStatus: "idle", resultTurnId: continuationTurnId2, resultTurnStatus: "completed" }));
    vi.spyOn(desktopIpc, "currentResultOwnership").mockResolvedValue({
      ...validResultContext({ runtimeStatus: "idle", resultTurnId: continuationTurnId, resultTurnStatus: "completed" }),
      ownership: "native_continuation", originTurnId, chainTurnIds: [originTurnId, continuationTurnId],
      chainLength: 1, signature: "capacity_retry_automatic",
    });

    await expect(recordDesktopResult(workspace, input())).rejects.toMatchObject({ code: "DESKTOP_RESULT_CURRENT_EXECUTION" });
    expect(readExecutionRecords(workspace.id)).toEqual([]);
    expect(listExecutionOutputs(workspace.id)).toEqual([]);
    expect(readDesktop(workspace.id)?.deliveries[0].turnId).toBe(originTurnId);
  });

  it.each(["ordinary successor", "wrong trigger", "user input successor"])("%s 无严格 attestation 时 fail closed", async () => {
    writeDesktopState({ deliveries: [delivery({ turnId: originTurnId })] });
    vi.mocked(desktopIpc.currentResultContext).mockResolvedValue(validResultContext({
      runtimeStatus: "idle", resultTurnId: continuationTurnId, resultTurnStatus: "completed",
    }));
    vi.spyOn(desktopIpc, "currentResultOwnership").mockRejectedValue(
      new DesktopError("DESKTOP_STATE_UNAVAILABLE", "continuation unavailable"),
    );

    await expect(recordDesktopResult(workspace, input())).rejects.toMatchObject({ code: "DESKTOP_RESULT_CURRENT_EXECUTION" });
    expect(readExecutionRecords(workspace.id)).toEqual([]);
    expect(listExecutionOutputs(workspace.id)).toEqual([]);
  });

  it("outcome_unknown 在当前 Desktop turn 唯一匹配时一次调用自助恢复并记录 receipt", async () => {
    writeDesktopState({ deliveries: [delivery({ deliveryStatus: "outcome_unknown" })] });
    const reconcile = vi.spyOn(desktopIpc, "reconcileUnknown").mockResolvedValue({
      threadId,
      hostId: "local",
      projectId: "desktop_result_project",
      workspaceRoot: workspace.root,
      candidates: [turnId],
    });

    const result = await recordDesktopResult(workspace, input());

    expect(result.record.commandId).toBe(commandId);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(readExecutionRecords(workspace.id)).toHaveLength(1);
    expect(listExecutionOutputs(workspace.id)).toHaveLength(1);
    expect(readDesktop(workspace.id)).toMatchObject({
      deliveries: [{ deliveryStatus: "accepted", turnId }],
    });
  });

  it("outcome_unknown 的唯一候选不是当前 result turn 时不恢复也不写 receipt", async () => {
    writeDesktopState({ deliveries: [delivery({ deliveryStatus: "outcome_unknown" })] });
    vi.spyOn(desktopIpc, "reconcileUnknown").mockResolvedValue({
      threadId,
      hostId: "local",
      projectId: "desktop_result_project",
      workspaceRoot: workspace.root,
      candidates: ["00000000-0000-4000-8000-000000000104"],
    });
    const before = fs.readFileSync(desktopFile(workspace.id), "utf8");

    await expect(recordDesktopResult(workspace, input())).rejects.toMatchObject({ code: "DESKTOP_RESULT_THREAD" });

    expect(fs.readFileSync(desktopFile(workspace.id), "utf8")).toBe(before);
    expect(readExecutionRecords(workspace.id)).toEqual([]);
    expect(listExecutionOutputs(workspace.id)).toEqual([]);
  });

  it.each([
    ["zero", []],
    ["multiple", [turnId, "00000000-0000-4000-8000-000000000104"]],
    ["malformed", ["not-a-uuid"]],
  ] as const)("self-reconcile %s candidates 保持 unknown 且不写 receipt", async (_name, candidates) => {
    writeDesktopState({ deliveries: [delivery({ deliveryStatus: "outcome_unknown" })] });
    vi.spyOn(desktopIpc, "reconcileUnknown").mockResolvedValue({
      threadId,
      hostId: "local",
      projectId: "desktop_result_project",
      workspaceRoot: workspace.root,
      candidates: [...candidates],
    });
    const before = fs.readFileSync(desktopFile(workspace.id), "utf8");

    await expect(recordDesktopResult(workspace, input())).rejects.toThrow();

    expect(fs.readFileSync(desktopFile(workspace.id), "utf8")).toBe(before);
    expect(readDesktop(workspace.id)?.deliveries[0].deliveryStatus).toBe("outcome_unknown");
    expect(readExecutionRecords(workspace.id)).toEqual([]);
    expect(listExecutionOutputs(workspace.id)).toEqual([]);
  });

  it.each([
    ["CODEX_THREAD_ID 错误", () => { process.env.CODEX_THREAD_ID = otherThreadId; }],
    ["workspaceRoot 错误", () => vi.mocked(desktopIpc.currentResultContext).mockResolvedValue(validResultContext({ workspaceRoot: path.join(workspace.root, "other") }))],
    ["resultTurnId 缺失", () => vi.mocked(desktopIpc.currentResultContext).mockResolvedValue(validResultContext({ resultTurnId: undefined as unknown as string }))],
    ["runtime/result 不一致", () => vi.mocked(desktopIpc.currentResultContext).mockResolvedValue(validResultContext({ runtimeStatus: "idle", resultTurnStatus: "inProgress" }))],
  ] as const)("outcome_unknown 的 %s 在 reconciliation 前 fail closed", async (_name, setup) => {
    writeDesktopState({ deliveries: [delivery({ deliveryStatus: "outcome_unknown" })] });
    const reconcile = vi.spyOn(desktopIpc, "reconcileUnknown");
    setup();

    await expect(recordDesktopResult(workspace, input())).rejects.toThrow();

    expect(reconcile).not.toHaveBeenCalled();
    expect(readDesktop(workspace.id)?.deliveries[0].deliveryStatus).toBe("outcome_unknown");
    expect(readExecutionRecords(workspace.id)).toEqual([]);
    expect(listExecutionOutputs(workspace.id)).toEqual([]);
  });

  it("reconciliation 后 current result turn 漂移时不写 receipt，后续 turn 也不能代写", async () => {
    writeDesktopState({ deliveries: [delivery({ deliveryStatus: "outcome_unknown" })] });
    vi.spyOn(desktopIpc, "reconcileUnknown").mockResolvedValue({
      threadId,
      hostId: "local",
      projectId: "desktop_result_project",
      workspaceRoot: workspace.root,
      candidates: [turnId],
    });
    vi.mocked(desktopIpc.currentResultContext)
      .mockResolvedValueOnce(validResultContext())
      .mockResolvedValue(validResultContext({ resultTurnId: "00000000-0000-4000-8000-000000000104" }));

    await expect(recordDesktopResult(workspace, input())).rejects.toMatchObject({ code: "DESKTOP_RESULT_CURRENT_EXECUTION" });
    expect(readDesktop(workspace.id)?.deliveries[0]).toMatchObject({ deliveryStatus: "accepted", turnId });
    expect(readExecutionRecords(workspace.id)).toEqual([]);
    expect(listExecutionOutputs(workspace.id)).toEqual([]);
    await expect(recordDesktopResult(workspace, input())).rejects.toMatchObject({ code: "DESKTOP_RESULT_CURRENT_EXECUTION" });
    expect(readExecutionRecords(workspace.id)).toEqual([]);
  });

  it("reconciliation 期间 binding 漂移时保持 unknown 且不写 receipt", async () => {
    writeDesktopState({ deliveries: [delivery({ deliveryStatus: "outcome_unknown" })] });
    vi.spyOn(desktopIpc, "reconcileUnknown").mockImplementation(async target => {
      const current = readDesktop(workspace.id)!;
      const nextBinding = { ...current.binding!, bindingId: "00000000-0000-4000-8000-000000000103" };
      updateDesktop(workspace.id, state => ({ state: { ...state!, binding: nextBinding }, result: undefined }));
      return { ...target, candidates: [turnId] };
    });

    await expect(recordDesktopResult(workspace, input())).rejects.toMatchObject({ code: "DESKTOP_RECONCILIATION_CONFLICT" });
    expect(readDesktop(workspace.id)?.deliveries[0].deliveryStatus).toBe("outcome_unknown");
    expect(readExecutionRecords(workspace.id)).toEqual([]);
    expect(listExecutionOutputs(workspace.id)).toEqual([]);
  });
  it("按 commandId 和 accepted thread 记录结果，disabled 或重绑后仍可收尾", async () => {
    writeDesktopState({ enabled: false, binding: {
      threadId: otherThreadId,
      hostId: "local",
      projectId: "desktop_result_project",
      bindingId: "00000000-0000-4000-8000-000000000103",
      title: "已重绑的 Desktop 会话",
      boundAt: "2026-09-12T00:00:00.000Z",
    } });
    const result = await recordDesktopResult(workspace, input({ tests: "not run", exitStatus: "blocked" }));
    expect(result.record).toMatchObject({
      taskId: `desktop_${commandId}`,
      iteration: 1,
      commandId,
      changedFiles: ["src/desktop/result.ts"],
      tests: "not run",
      exitStatus: "blocked",
    });
    expect(result.record.desktopReceiptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.output).toMatchObject({ allowed: true, taskId: `desktop_${commandId}`, iteration: 1 });
    expect(readExecutionRecords(workspace.id)[0]).toMatchObject({ taskId: `desktop_${commandId}`, commandId });
    expect(readExecutionRecords(workspace.id)[0]).not.toHaveProperty("desktopReceiptSha256");
    expect(fs.readFileSync(recordsFile(), "utf8")).toContain("desktopReceiptSha256");
  });

  it.each([
    ["没有 Desktop 状态", () => undefined],
    ["根目录不一致", () => writeDesktopState({ workspaceRoot: path.join(workspace.root, "other") })],
    ["目标 commandId 缺失", () => writeDesktopState({ deliveries: [delivery({ commandId: "other_command" })] })],
    ["目标投递为 rejected", () => writeDesktopState({ deliveries: [delivery({ deliveryStatus: "rejected" })] })],
    ["目标投递为 outcome_unknown", () => writeDesktopState({ deliveries: [delivery({ deliveryStatus: "outcome_unknown" })] })],
    ["目标投递线程不一致", () => writeDesktopState({ deliveries: [delivery({ threadId: otherThreadId })] })],
  ] as const)("%s 时 fail closed", async (_name, setup) => {
    setup();
    await expect(recordDesktopResult(workspace, input())).rejects.toThrow();
    expect(fs.existsSync(recordsFile())).toBe(false);
    expect(listExecutionOutputs(workspace.id)).toEqual([]);
  });

  it.each(["rejected", "outcome_unknown"] as const)("同线程另有 accepted 但目标为 %s 仍拒绝", async deliveryStatus => {
    writeDesktopState({ deliveries: [delivery({ commandId: "other_command" }), delivery({ deliveryStatus })] });
    await expect(recordDesktopResult(workspace, input())).rejects.toThrow();
    expect(fs.existsSync(recordsFile())).toBe(false);
    expect(listExecutionOutputs(workspace.id)).toEqual([]);
  });

  it("严格读取已有损坏 JSONL，不借空记录继续追加", async () => {
    writeDesktopState();
    fs.mkdirSync(path.dirname(recordsFile()), { recursive: true });
    fs.writeFileSync(recordsFile(), "{\"taskId\":\"partial\"");
    const before = fs.readFileSync(recordsFile(), "utf8");
    await expect(recordDesktopResult(workspace, input())).rejects.toThrow(/执行记录/);
    expect(fs.readFileSync(recordsFile(), "utf8")).toBe(before);
    expect(listExecutionOutputs(workspace.id)).toEqual([]);
  });

  it("缺失或非 UUID CODEX_THREAD_ID 时拒绝且不创建执行输出", async () => {
    writeDesktopState();
    delete process.env.CODEX_THREAD_ID;
    await expect(recordDesktopResult(workspace, input())).rejects.toThrow();
    process.env.CODEX_THREAD_ID = "thread-from-caller";
    await expect(recordDesktopResult(workspace, input({ commandId: "another_command" }))).rejects.toThrow();
    expect(listExecutionOutputs(workspace.id)).toEqual([]);
  });

  it.each([
    ["thread 不一致", { threadId: otherThreadId }],
    ["workspaceRoot 不一致", { workspaceRoot: path.join(workspace.root, "other") }],
    ["result turn 不一致", { resultTurnId: "00000000-0000-4000-8000-000000000104" }],
    ["result turn 缺失", { resultTurnId: undefined as unknown as string }],
  ] as const)("真实 Desktop execution %s 时拒绝且不写入", async (_name, overrides) => {
    writeDesktopState();
    vi.mocked(desktopIpc.currentResultContext).mockResolvedValue(validResultContext(overrides as Partial<DesktopResultContext>));
    await expect(recordDesktopResult(workspace, input())).rejects.toMatchObject({ code: "DESKTOP_RESULT_CURRENT_EXECUTION" });
    expect(fs.existsSync(recordsFile())).toBe(false);
    expect(listExecutionOutputs(workspace.id)).toEqual([]);
  });

  it("current result context 读取失败时拒绝，不把错误当作完成", async () => {
    writeDesktopState();
    vi.mocked(desktopIpc.currentResultContext).mockImplementation(async () => {
      throw new DesktopError("DESKTOP_STATE_UNAVAILABLE", "Desktop 状态不可确认");
    });
    await expect(recordDesktopResult(workspace, input())).rejects.toMatchObject({ code: "DESKTOP_STATE_UNAVAILABLE" });
    expect(desktopIpc.currentResultContext).toHaveBeenCalledTimes(3);
    expect(fs.existsSync(recordsFile())).toBe(false);
    expect(listExecutionOutputs(workspace.id)).toEqual([]);
  });

  it("写入前第二次复核短暂不可用时有界重试并继续要求 exact turn", async () => {
    writeDesktopState();
    vi.mocked(desktopIpc.currentResultContext)
      .mockRejectedValueOnce(new DesktopError("DESKTOP_STATE_UNAVAILABLE", "Desktop 状态短暂不可确认"))
      .mockResolvedValue(validResultContext());
    const result = await recordDesktopResult(workspace, input({ output: undefined }));
    expect(result.record.commandId).toBe(commandId);
    expect(desktopIpc.currentResultContext).toHaveBeenCalledTimes(2);
    expect(readExecutionRecords(workspace.id)).toHaveLength(1);
  });

  it("idle 且 accepted turn 是完整历史中的最新 terminal turn 时允许记录", async () => {
    writeDesktopState();
    vi.mocked(desktopIpc.currentResultContext).mockResolvedValue(validResultContext({
      runtimeStatus: "idle", resultTurnStatus: "completed",
    }));
    const result = await recordDesktopResult(workspace, input({ output: undefined }));
    expect(result.record.commandId).toBe(commandId);
    expect(result.output).toBeNull();
    expect(readExecutionRecords(workspace.id)).toHaveLength(1);
  });

  it("accepted terminal turn 之后已有更晚 turn 时拒绝记录", async () => {
    writeDesktopState();
    vi.mocked(desktopIpc.currentResultContext).mockResolvedValue(validResultContext({
      resultTurnId: "00000000-0000-4000-8000-000000000104",
      runtimeStatus: "idle", resultTurnStatus: "completed",
    }));
    await expect(recordDesktopResult(workspace, input())).rejects.toMatchObject({ code: "DESKTOP_RESULT_CURRENT_EXECUTION" });
    expect(fs.existsSync(recordsFile())).toBe(false);
    expect(listExecutionOutputs(workspace.id)).toEqual([]);
  });

  it("写入前 result context 切换到新 turn 时拒绝且不落盘", async () => {
    writeDesktopState();
    vi.mocked(desktopIpc.currentResultContext)
      .mockResolvedValue(validResultContext({ resultTurnId: "00000000-0000-4000-8000-000000000104" }));
    await expect(recordDesktopResult(workspace, input())).rejects.toMatchObject({ code: "DESKTOP_RESULT_CURRENT_EXECUTION" });
    expect(fs.existsSync(recordsFile())).toBe(false);
    expect(listExecutionOutputs(workspace.id)).toEqual([]);
  });

  it("伪造 CODEX_THREAD_ID 即使是 UUID 也不能借其他 accepted 投递写入", async () => {
    writeDesktopState();
    process.env.CODEX_THREAD_ID = otherThreadId;
    let called = false;
    vi.mocked(desktopIpc.currentResultContext).mockImplementation(async () => { called = true; return validResultContext(); });
    await expect(recordDesktopResult(workspace, input())).rejects.toMatchObject({ code: "DESKTOP_RESULT_THREAD" });
    expect(called).toBe(false);
    expect(fs.existsSync(recordsFile())).toBe(false);
    expect(listExecutionOutputs(workspace.id)).toEqual([]);
  });

  it("相同完整输入重试幂等，但后续 turn 仍拒绝重放", async () => {
    writeDesktopState();
    const first = await recordDesktopResult(workspace, input());
    const recordsBefore = fs.readFileSync(recordsFile(), "utf8");
    const outputsBefore = listExecutionOutputs(workspace.id);
    await expect(recordDesktopResult(workspace, input())).resolves.toEqual(first);
    expect(fs.readFileSync(recordsFile(), "utf8")).toBe(recordsBefore);
    expect(listExecutionOutputs(workspace.id)).toEqual(outputsBefore);
    await expect(recordDesktopResult(workspace, input({ output: "changed" }))).rejects.toThrow(/不一致/);
    await expect(recordDesktopResult(workspace, input({ command: "pnpm lint" }))).rejects.toThrow(/不一致/);
    await expect(recordDesktopResult(workspace, input({ exitCode: 1 }))).rejects.toThrow(/不一致/);
    expect(fs.readFileSync(recordsFile(), "utf8")).toBe(recordsBefore);
    expect(listExecutionOutputs(workspace.id)).toEqual(outputsBefore);

    vi.mocked(desktopIpc.currentResultContext).mockResolvedValue(validResultContext({ resultTurnId: "00000000-0000-4000-8000-000000000104" }));
    await expect(recordDesktopResult(workspace, input())).rejects.toMatchObject({ code: "DESKTOP_RESULT_CURRENT_EXECUTION" });
    expect(fs.readFileSync(recordsFile(), "utf8")).toBe(recordsBefore);
    expect(listExecutionOutputs(workspace.id)).toEqual(outputsBefore);
  });

  it("已有 exact terminal 时 Desktop context 不可用可只读恢复，不改记录", async () => {
    writeDesktopState();
    const first = await recordDesktopResult(workspace, input());
    const recordsBefore = fs.readFileSync(recordsFile(), "utf8");
    vi.mocked(desktopIpc.currentResultContext).mockRejectedValue(
      new DesktopError("DESKTOP_STATE_UNAVAILABLE", "Desktop 已关闭"),
    );
    const recovered = await recordDesktopResult(workspace, input());
    expect(recovered).toEqual(first);
    expect(fs.readFileSync(recordsFile(), "utf8")).toBe(recordsBefore);
    // 首次写入路径仍拒绝；context 消失不能凭空造终态。
    writeDesktopState({ deliveries: [delivery({ commandId: "desktop_late_new" })] });
    await expect(recordDesktopResult(workspace, input({ commandId: "desktop_late_new" })))
      .rejects.toMatchObject({ code: "DESKTOP_STATE_UNAVAILABLE" });
  });

  it("已有同 commandId 的普通记录或孤立 output 时拒绝覆盖", async () => {
    writeDesktopState();
    appendExecutionRecord(workspace.id, {
      taskId: "other_task",
      iteration: 1,
      changedFiles: [],
      tests: null,
      exitStatus: "ok",
      timestamp: "2026-09-12T00:00:00.000Z",
      commandId,
    });
    await expect(recordDesktopResult(workspace, input())).rejects.toThrow(/不匹配|不完整/);

    const secondCommand = "desktop_command_2";
    writeDesktopState({ deliveries: [delivery({ commandId: secondCommand })] });
    const saved = await recordDesktopResult(workspace, input({ commandId: secondCommand }));
    expect(saved.record.commandId).toBe(secondCommand);
  });

  it("普通 record 不能写入 Desktop receipt 内部摘要", async () => {
    writeDesktopState();
    const record = { taskId: `desktop_${commandId}`, commandId, iteration: 1, changedFiles: [],
      tests: "not run", exitStatus: "ok", timestamp: new Date().toISOString(), desktopReceiptSha256: "0".repeat(64) };
    appendExecutionRecord(workspace.id, record);
    expect(fs.readFileSync(recordsFile(), "utf8")).not.toContain("desktopReceiptSha256");
    await expect(recordDesktopResult(workspace, input())).rejects.toThrow(/不匹配|不完整/);
  });

  it("保存 output 前经过 sanitizer，保留 failed、blocked 和 not run 真实状态", async () => {
    const statuses = [
      ["desktop_result_ok", "ok", "pnpm test", "ok\n"],
      ["desktop_result_failed", "failed", "pnpm test", "failed\n"],
      ["desktop_result_blocked", "blocked", undefined, undefined],
    ] as const;
    const deliveries = statuses.map(([id]) => delivery({ commandId: id }));
    writeDesktopState({ deliveries });
    for (const [id, exitStatus, command, output] of statuses) {
      const result = await recordDesktopResult(workspace, input({
        commandId: id,
        exitStatus,
        tests: exitStatus === "blocked" ? "not run" : "1 test",
        command,
        output,
      }));
      expect(result.record.exitStatus).toBe(exitStatus);
    }
    expect(readExecutionRecords(workspace.id).map(record => record.exitStatus)).toEqual(["ok", "failed", "blocked"]);

    const secretCommand = "desktop_result_secret";
    writeDesktopState({ deliveries: [delivery({ commandId: secretCommand })] });
    const secret = await recordDesktopResult(workspace, input({
      commandId: secretCommand,
      output: "Authorization: Bearer c2c_at_abcdefghijklmnopqrstuv\n安全文本",
    }));
    expect(secret.output?.allowed).toBe(true);
    const body = readExecutionOutput(workspace.id, secret.output!.id);
    expect(body.ok).toBe(true);
    if (body.ok) {
      expect(body.text).not.toContain("c2c_at_");
      expect(body.text).toContain("安全文本");
    }
  });

  it("tests 只接受非空摘要；未提供 output 时不创建 output 记录", async () => {
    writeDesktopState();
    await expect(recordDesktopResult(workspace, input({ tests: "   " }))).rejects.toThrow();
    const result = await recordDesktopResult(workspace, input({ output: undefined, command: "pnpm test" }));
    expect(result.output).toBeNull();
    expect(listExecutionOutputs(workspace.id)).toEqual([]);
  });

  it("追加记录中断后识别孤立 output，保留 fail-closed 边界", async () => {
    writeDesktopState();
    saveExecutionOutput(workspace.id, {
      command: "pnpm test",
      raw: input().output!,
      taskId: `desktop_${commandId}`,
      iteration: 1,
    });
    expect(listExecutionOutputs(workspace.id)).toHaveLength(1);
    await expect(recordDesktopResult(workspace, input())).rejects.toThrow(/孤立 output|未完成/);
    expect(readExecutionRecords(workspace.id)).toEqual([]);
  });

  it("并发同一 commandId 只产生一条记录和一个 output", async () => {
    writeDesktopState();
    const moduleUrl = pathToFileURL(path.resolve("src/desktop/result.ts")).href;
    const script = path.join(stateDir, "desktop-result-worker.mjs");
    fs.writeFileSync(script, `import { recordDesktopResult } from ${JSON.stringify(moduleUrl)};
import { desktopIpc } from ${JSON.stringify(pathToFileURL(path.resolve("src/desktop/ipc.ts")).href)};
desktopIpc.currentResultContext = async () => (${JSON.stringify(validResultContext())});
await recordDesktopResult(${JSON.stringify(workspace)}, ${JSON.stringify(input())});
`);
    const results = await Promise.all(Array.from({ length: 6 }, () => child(script)));
    expect(results.some(result => result.code === 0)).toBe(true);
    for (const result of results) {
      if (result.code === 0) continue;
      expect(result.error).toBeUndefined();
      expect(result.stderr).toMatch(/EXECUTION_RECORDS_BUSY|执行记录写锁繁忙/);
    }
    expect(readExecutionRecords(workspace.id)).toHaveLength(1);
    expect(listExecutionOutputs(workspace.id)).toHaveLength(1);
    const retry = await recordDesktopResult(workspace, input());
    expect(retry.record.commandId).toBe(commandId);
    expect(retry.output?.id).toBe(listExecutionOutputs(workspace.id)[0].id);
    expect(readExecutionRecords(workspace.id)).toHaveLength(1);
  }, 60_000);
});
