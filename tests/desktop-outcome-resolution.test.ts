import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { desktopFile, DesktopError, readDesktop, updateDesktop } from "../src/desktop/store.js";
import {
  getResolvedUnknownCommandIds,
  outcomeResolutionFile,
  previewOutcomeResolution,
  readOutcomeResolutions,
  resolveOutcomeUnknown,
  unresolvedOutcomeUnknownCommandIds,
} from "../src/desktop/outcome-resolution.js";
import * as outcomeResolution from "../src/desktop/outcome-resolution.js";
import { registerDesktopCommands } from "../src/cli/desktop.js";
import { desktopStatus, sendDesktop } from "../src/desktop/service.js";
import { desktopIpc } from "../src/desktop/ipc.js";
import { listDesktopHistory } from "../src/desktop/history.js";
import { reconcileUnknownDesktopDelivery } from "../src/desktop/unknown-reconciliation.js";
import { saveExecutionOutput } from "../src/execution/output.js";
import { assessRolloutIdle } from "../src/core/rollout-idle.js";
import { collectDesktopFacts } from "../src/workflow/facts.js";
import { legacyRetirementFile } from "../src/desktop/legacy-retirement.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const threadId = "01a00000-0000-7000-8000-000000000001";
const bindingId = "01a00000-0000-7000-8000-000000000002";
const turnId = "01a00000-0000-7000-8000-000000000003";
const now = "2026-09-20T00:00:00.000Z";

let root: string;
let stateDir: string;
let workspace: Workspace;

beforeEach(() => {
  root = makeTmpDir("desktop-outcome-resolution-workspace");
  stateDir = makeTmpDir("desktop-outcome-resolution-state");
  process.env.C2C_STATE_DIR = stateDir;
  workspace = new Workspace(root);
  vi.spyOn(desktopIpc, "inspect").mockResolvedValue({ title: "test" } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.C2C_STATE_DIR;
  cleanup(root);
  cleanup(stateDir);
});

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string }> {
  const program = new Command().exitOverride();
  registerDesktopCommands(program);
  const chunks: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  const previous = process.exitCode;
  process.exitCode = 0;
  try {
    await program.parseAsync(["node", "c2c", ...args]);
    return { exitCode: process.exitCode ?? 0, stdout: chunks.join("") };
  } finally {
    write.mockRestore();
    process.exitCode = previous;
  }
}

function seedUnknown(commandId = "unknown_one", status: "outcome_unknown" | "accepted" = "outcome_unknown"): void {
  updateDesktop(workspace.id, () => ({
    state: {
      version: 1,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      enabled: true,
      binding: { threadId, hostId: "local" as const, projectId: "project", bindingId, title: "bound", boundAt: now },
      deliveries: [{ commandId, clientId: "client", bindingId, intent: "development_plan" as const,
        messageSha256: "a".repeat(64), messageBytes: 1, threadId,
        ...(status === "accepted" ? { turnId, deliveryStatus: "accepted" as const } : { deliveryStatus: "outcome_unknown" as const }),
        createdAt: now, updatedAt: now }],
    }, result: undefined,
  }));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe("Desktop outcome_unknown administrative resolution", () => {
  it("preview 只读且返回确定 confirmation；confirm 保留 raw delivery 且幂等", () => {
    seedUnknown();
    const before = fs.readFileSync(desktopFile(workspace.id), "utf8");
    const preview = previewOutcomeResolution(workspace, "unknown_one");
    expect(fs.readFileSync(desktopFile(workspace.id), "utf8")).toBe(before);
    expect(fs.existsSync(outcomeResolutionFile(workspace.id))).toBe(false);

    const first = resolveOutcomeUnknown(workspace, "unknown_one", preview.confirmationSha256);
    const second = resolveOutcomeUnknown(workspace, "unknown_one", preview.confirmationSha256);
    expect(first.status).toBe("resolved_unknown");
    expect(second.status).toBe("already_resolved_unknown");
    expect(readDesktop(workspace.id)?.deliveries[0]).toMatchObject({ deliveryStatus: "outcome_unknown" });
    expect(readDesktop(workspace.id)?.deliveries[0]).not.toHaveProperty("turnId");
    expect(readOutcomeResolutions(workspace.id)).toHaveLength(1);
    expect(getResolvedUnknownCommandIds(workspace)).toEqual(new Set(["unknown_one"]));
    expect(fs.existsSync(path.join(stateDir, "executions"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "execution-outputs"))).toBe(false);
  });

  it("错误 confirmation、错误 command、非 unknown 和 corrupt evidence 都 fail closed", () => {
    seedUnknown();
    const preview = previewOutcomeResolution(workspace, "unknown_one");
    expect(() => resolveOutcomeUnknown(workspace, "unknown_one", "f".repeat(64))).toThrow(/confirmation/);
    expect(() => previewOutcomeResolution(workspace, "missing")).toThrow();
    expect(() => previewOutcomeResolution({ id: workspace.id, root: `${workspace.root}-other` }, "unknown_one")).toThrow();
    seedUnknown("accepted_one", "accepted");
    expect(() => previewOutcomeResolution(workspace, "accepted_one")).toThrow();
    fs.mkdirSync(path.dirname(outcomeResolutionFile(workspace.id)), { recursive: true });
    fs.writeFileSync(outcomeResolutionFile(workspace.id), "broken");
    fs.writeFileSync(`${outcomeResolutionFile(workspace.id)}.initialized`, "1\n");
    expect(() => previewOutcomeResolution(workspace, "unknown_one")).toThrow(/损坏|schema|行政/);
    expect(preview.confirmationSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("已有可信 Desktop receipt 时不允许追加行政 resolution", () => {
    seedUnknown();
    const recordsDir = path.join(stateDir, "executions");
    fs.mkdirSync(recordsDir, { recursive: true });
    fs.writeFileSync(path.join(recordsDir, `${workspace.id}.jsonl`), `${JSON.stringify({
      taskId: `desktop_unknown_one`, commandId: "unknown_one", iteration: 1, changedFiles: [], tests: "not run",
      exitStatus: "ok", timestamp: now, desktopReceiptSha256: "d".repeat(64),
    })}\n`);
    expect(() => previewOutcomeResolution(workspace, "unknown_one")).toThrow(/可信 Desktop receipt|冲突/);
  });

  it("已有行政 resolution 时禁止后续 reconciliation 改写 raw delivery", async () => {
    seedUnknown();
    const preview = previewOutcomeResolution(workspace, "unknown_one");
    resolveOutcomeUnknown(workspace, "unknown_one", preview.confirmationSha256);
    const reconcile = vi.spyOn(desktopIpc, "reconcileUnknown").mockResolvedValue({
      threadId, hostId: "local", projectId: "project", workspaceRoot: workspace.root, candidates: [turnId],
    });
    await expect(reconcileUnknownDesktopDelivery(workspace, "unknown_one"))
      .rejects.toMatchObject({ code: "DESKTOP_RECONCILIATION_CONFLICT" });
    expect(reconcile).not.toHaveBeenCalled();
    expect(readDesktop(workspace.id)?.deliveries[0]).toMatchObject({ deliveryStatus: "outcome_unknown" });
  });

  it("reconciliation 已完成 Desktop 观察后与行政 resolution 交错时仍拒绝改写", async () => {
    seedUnknown();
    const observed = deferred<void>();
    const release = deferred<{
      threadId: string; hostId: "local"; projectId: string; workspaceRoot: string; candidates: string[];
    }>();
    const reconcile = vi.spyOn(desktopIpc, "reconcileUnknown").mockImplementation(async target => {
      observed.resolve();
      return release.promise;
    });
    const pendingReconciliation = reconcileUnknownDesktopDelivery(workspace, "unknown_one");
    await observed.promise;

    const preview = previewOutcomeResolution(workspace, "unknown_one");
    resolveOutcomeUnknown(workspace, "unknown_one", preview.confirmationSha256);
    release.resolve({ threadId, hostId: "local", projectId: "project", workspaceRoot: workspace.root, candidates: [turnId] });

    await expect(pendingReconciliation).rejects.toMatchObject({ code: "DESKTOP_RECONCILIATION_CONFLICT" });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(readDesktop(workspace.id)?.deliveries[0]).toMatchObject({ deliveryStatus: "outcome_unknown" });
    expect(getResolvedUnknownCommandIds(workspace)).toEqual(new Set(["unknown_one"]));
  });

  it("accepted transition 先提交时，后续行政 resolution 拒绝且保留 accepted", async () => {
    seedUnknown();
    vi.spyOn(desktopIpc, "reconcileUnknown").mockResolvedValue({
      threadId, hostId: "local", projectId: "project", workspaceRoot: workspace.root, candidates: [turnId],
    });
    const preview = previewOutcomeResolution(workspace, "unknown_one");
    const reconciled = await reconcileUnknownDesktopDelivery(workspace, "unknown_one");
    expect(reconciled).toMatchObject({ status: "accepted", turnId });
    expect(() => resolveOutcomeUnknown(workspace, "unknown_one", preview.confirmationSha256))
      .toThrow(/outcome_unknown|不满足|不存在|冲突/);
    expect(readOutcomeResolutions(workspace.id)).toHaveLength(0);
    expect(readDesktop(workspace.id)?.deliveries[0]).toMatchObject({ deliveryStatus: "accepted", turnId });
  });

  it("孤立 execution output 也构成冲突证据", () => {
    seedUnknown();
    saveExecutionOutput(workspace.id, {
      command: "desktop result",
      raw: "partial",
      taskId: "desktop_unknown_one",
      iteration: 1,
    });
    expect(() => previewOutcomeResolution(workspace, "unknown_one")).toThrow(/execution output|冲突/);
  });

  it("传入的 Desktop 快照发生 revision 漂移时 fail closed", () => {
    seedUnknown();
    const before = readDesktop(workspace.id);
    updateDesktop(workspace.id, current => {
      if (!current) throw new Error("missing state");
      current.deliveries.push({ commandId: "unknown_two", clientId: "client", bindingId, intent: "revision",
        messageSha256: "b".repeat(64), messageBytes: 1, threadId, deliveryStatus: "outcome_unknown", createdAt: now, updatedAt: now });
      return { state: current, result: undefined };
    });
    let failure: unknown;
    try { unresolvedOutcomeUnknownCommandIds(workspace, before); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(DesktopError);
    expect(failure).toMatchObject({ code: "DESKTOP_STORE_BUSY" });
  });

  it("同 revision 的稳定快照冲突仍保留 outcome-resolution conflict", () => {
    seedUnknown();
    const before = readDesktop(workspace.id);
    if (!before) throw new Error("missing snapshot");
    const disk = readDesktop(workspace.id);
    if (!disk) throw new Error("missing disk state");
    disk.deliveries[0].messageSha256 = "b".repeat(64);
    fs.writeFileSync(desktopFile(workspace.id), JSON.stringify(disk));

    let failure: unknown;
    try { unresolvedOutcomeUnknownCommandIds(workspace, before); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(outcomeResolution.OutcomeResolutionError);
    expect(failure).toMatchObject({ code: "DESKTOP_OUTCOME_RESOLUTION_CONFLICT" });
  });

  it("已有行政 resolution 与 delivery 事实冲突仍保留 outcome-resolution conflict", () => {
    seedUnknown();
    const preview = previewOutcomeResolution(workspace, "unknown_one");
    resolveOutcomeUnknown(workspace, "unknown_one", preview.confirmationSha256);
    updateDesktop(workspace.id, state => {
      if (!state) throw new Error("missing state");
      state.deliveries[0].messageSha256 = "b".repeat(64);
      return { state, result: undefined };
    });

    let failure: unknown;
    try { getResolvedUnknownCommandIds(workspace); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(outcomeResolution.OutcomeResolutionError);
    expect(failure).toMatchObject({ code: "DESKTOP_OUTCOME_RESOLUTION_CONFLICT" });
  });

  it("已有 retirement 证据时 fail closed，不覆盖既有证据", () => {
    seedUnknown();
    const file = legacyRetirementFile(workspace.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, workspaceId: workspace.id, entries: [{
      commandId: "unknown_one", deliverySha256: "e".repeat(64), observedMissingAt: now,
    }] }));
    fs.writeFileSync(`${file}.initialized`, "1\n");
    expect(() => previewOutcomeResolution(workspace, "unknown_one")).toThrow(/冲突|已有/);
    expect(readOutcomeResolutions(workspace.id)).toEqual([]);
  });

  it("history/status 使用 distinct resolved_unknown，workflow 门禁不再把已解决 unknown 当 unresolved", async () => {
    seedUnknown();
    const preview = previewOutcomeResolution(workspace, "unknown_one");
    resolveOutcomeUnknown(workspace, "unknown_one", preview.confirmationSha256);
    expect(listDesktopHistory(workspace)).toContainEqual({ commandId: "unknown_one", status: "resolved_unknown" });
    vi.mocked(desktopIpc.inspect).mockResolvedValue({ title: "bound" } as never);
    const status = await desktopStatus(workspace, "unknown_one");
    expect(status.unresolvedDelivery).toBe(false);
    expect(status.delivery).toMatchObject({ deliveryStatus: "outcome_unknown", resolutionStatus: "administratively_resolved" });
    expect((await collectDesktopFacts(workspace)).unresolvedDelivery).toBe(false);
  });

  it("第二个 raw unknown 仍阻断发送，原 commandId 仍不可重发", async () => {
    seedUnknown();
    const preview = previewOutcomeResolution(workspace, "unknown_one");
    resolveOutcomeUnknown(workspace, "unknown_one", preview.confirmationSha256);
    updateDesktop(workspace.id, state => {
      if (!state) throw new Error("missing state");
      state.deliveries.push({ commandId: "unknown_two", clientId: "client", bindingId, intent: "revision",
        messageSha256: "b".repeat(64), messageBytes: 1, threadId, deliveryStatus: "outcome_unknown", createdAt: now, updatedAt: now });
      return { state, result: undefined };
    });
    await expect(sendDesktop(workspace, { workspaceId: workspace.id, bindingId, commandId: "unknown_one", intent: "development_plan", userConfirmed: true, message: "x" }, "client"))
      .rejects.toMatchObject({ code: "DESKTOP_COMMAND_CONFLICT" });
    await expect(sendDesktop(workspace, { workspaceId: workspace.id, bindingId, commandId: "new_command", intent: "development_plan", userConfirmed: true, message: "x" }, "client"))
      .rejects.toMatchObject({ code: "DESKTOP_OUTCOME_UNRESOLVED" });
  });

  it("rollout idle 只绕过已有行政 resolution，仍阻断第二个 unresolved unknown", async () => {
    seedUnknown();
    const preview = previewOutcomeResolution(workspace, "unknown_one");
    resolveOutcomeUnknown(workspace, "unknown_one", preview.confirmationSha256);
    vi.mocked(desktopIpc.inspect).mockResolvedValue({ threadId, hostId: "local", projectId: "project", workspaceRoot: workspace.root,
      title: "bound", runtimeStatus: "idle" } as never);
    const firstAssessment = await assessRolloutIdle(workspace, null);
    expect(firstAssessment.idle).toBe(true);
    updateDesktop(workspace.id, state => {
      if (!state) throw new Error("missing state");
      state.deliveries.push({ commandId: "unknown_two", clientId: "client", bindingId, intent: "revision",
        messageSha256: "b".repeat(64), messageBytes: 1, threadId, deliveryStatus: "outcome_unknown", createdAt: now, updatedAt: now });
      return { state, result: undefined };
    });
    const assessment = await assessRolloutIdle(workspace, null);
    expect(assessment.idle).toBe(false);
    expect(assessment.blockers).toContainEqual({ kind: "desktop_unresolved" });
  });

  it("CLI resolve-unknown preview 不写证据，confirm 只调用明确 commandId", async () => {
    const preview = vi.spyOn(outcomeResolution, "previewOutcomeResolution").mockReturnValue({
      commandId: "unknown_one", confirmationSha256: "c".repeat(64), notice: "仅停止等待并接受结果不明；不代表已投递、已接受、已完成或成功。",
    });
    const resolve = vi.spyOn(outcomeResolution, "resolveOutcomeUnknown").mockReturnValue({
      status: "resolved_unknown", commandId: "unknown_one", confirmationSha256: "c".repeat(64), notice: "仅停止等待并接受结果不明；不代表已投递、已接受、已完成或成功。",
    });
    const first = await runCli(["desktop", "resolve-unknown", "-w", root, "--command-id", "unknown_one", "--json"]);
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ ok: true, commandId: "unknown_one", confirmationSha256: "c".repeat(64) });
    expect(resolve).not.toHaveBeenCalled();
    const second = await runCli(["desktop", "resolve-unknown", "-w", root, "--command-id", "unknown_one", "--confirm", "c".repeat(64), "--json"]);
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ ok: true, status: "resolved_unknown" });
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ id: workspace.id, root: workspace.root }), "unknown_one");
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ id: workspace.id, root: workspace.root }), "unknown_one", "c".repeat(64));
  });
});
