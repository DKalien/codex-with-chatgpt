import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendExecutionRecord } from "../src/execution/records.js";
import { saveExecutionOutput } from "../src/execution/output.js";
import { desktopIpc } from "../src/desktop/ipc.js";
import {
  getRetiredLegacyCommandIds,
  legacyRetirementFile,
  readLegacyRetirements,
  retireLegacyAccepted,
  LegacyRetirementError,
} from "../src/desktop/legacy-retirement.js";
import { DesktopError, updateDesktop } from "../src/desktop/store.js";
import { reconcileLegacyAccepted, legacyReconciliationFile, listLegacyReconciliations, getReconciledLegacyCommandIds } from "../src/desktop/legacy-reconciliation.js";
import { registerDesktopCommands } from "../src/cli/desktop.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const oldThreadId = "01a00000-0000-7000-8000-000000000001";
const currentThreadId = "01a00000-0000-7000-8000-000000000002";
const turnId = "01a00000-0000-7000-8000-000000000003";
const bindingId = "01a00000-0000-7000-8000-000000000004";
const maintenanceTurnId = "01a00000-0000-7000-8000-000000000006";
const commandId = "legacy_waiting_command";
const acceptedAt = "2026-01-01T00:00:00.000Z";

let root: string;
let stateDir: string;
let workspace: Workspace;

beforeEach(() => {
  root = makeTmpDir("legacy-retirement-workspace");
  stateDir = makeTmpDir("legacy-retirement-state");
  workspace = new Workspace(root);
  process.env.C2C_STATE_DIR = stateDir;
  vi.spyOn(desktopIpc, "inspect").mockImplementation(async target => {
    if (target.threadId === oldThreadId) {
      throw Object.assign(new Error("old thread missing"), { code: "DESKTOP_TARGET_NOT_FOUND" });
    }
    return { ...target, title: "current", cwd: target.workspaceRoot, runtimeStatus: "idle" } as never;
  });
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
        threadId: currentThreadId,
        hostId: "local" as const,
        projectId: "legacy-project",
        bindingId,
        title: "current",
        boundAt: acceptedAt,
      },
      deliveries: [{
        commandId,
        clientId: "legacy-client",
        bindingId: "01a00000-0000-7000-8000-000000000005",
        messageSha256: "0".repeat(64),
        messageBytes: 1,
        threadId: oldThreadId,
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

function addRecord(overrides: Record<string, unknown> = {}): void {
  appendExecutionRecord(workspace.id, {
    taskId: `other-${commandId}`,
    iteration: 1,
    changedFiles: [],
    tests: "not run",
    exitStatus: "ok",
    timestamp: "2026-01-01T00:01:00.000Z",
    commandId: "other-command",
    ...overrides,
  });
}

function ownerlessContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    threadId: currentThreadId,
    hostId: "local",
    projectId: "legacy-project",
    workspaceRoot: workspace.root,
    title: "maintenance",
    cwd: workspace.root,
    runtimeStatus: "active",
    resultTurnId: maintenanceTurnId,
    resultTurnStatus: "inProgress",
    ...overrides,
  };
}

async function runRetireCli(args: string[]): Promise<{ output: string; exitCode: number | undefined }> {
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
  try {
    await program.parseAsync(["node", "c2c", ...args]);
    return { output: output.join(""), exitCode: process.exitCode };
  } finally {
    process.stdout.write = write;
    process.exitCode = previousExitCode;
  }
}

describe("legacy accepted retirement", () => {
  it.each(["records", "outputs"])("%s 损坏时在 IPC 前拒绝", async source => {
    seedDelivery();
    const file = source === "records" ? path.join(stateDir, "executions", `${workspace.id}.jsonl`) :
      path.join(stateDir, "execution-outputs", workspace.id, "index.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{");
    await expect(retireLegacyAccepted(workspace, commandId)).rejects.toMatchObject({
      code: source === "records" ? "LEGACY_RETIREMENT_RECORDS_CORRUPT" : "LEGACY_RETIREMENT_OUTPUT_CORRUPT",
    });
    expect(desktopIpc.inspect).not.toHaveBeenCalled();
    expect(readLegacyRetirements(workspace.id)).toEqual([]);
  });

  it("已有 reconciliation 即使执行文件后来缺失也不能 retire；双证据整体拒绝", async () => {
    seedDelivery();
    await retireLegacyAccepted(workspace, commandId);
    const retiredFile = legacyRetirementFile(workspace.id);
    const retirement = fs.readFileSync(retiredFile, "utf8");
    fs.rmSync(retiredFile);
    fs.rmSync(`${retiredFile}.initialized`);
    const output = saveExecutionOutput(workspace.id, { command: "fixture", raw: "evidence", taskId: commandId, iteration: 1 });
    addRecord({ commandId, taskId: commandId, timestamp: new Date().toISOString(), outputId: output.id });
    reconcileLegacyAccepted(workspace, commandId);
    const recFile = legacyReconciliationFile(workspace.id);
    const before = fs.readFileSync(recFile, "utf8");
    fs.rmSync(path.join(stateDir, "executions", `${workspace.id}.jsonl`));
    const indexFile = path.join(stateDir, "execution-outputs", workspace.id, "index.json");
    const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
    index.items = [];
    fs.writeFileSync(indexFile, JSON.stringify(index));
    vi.mocked(desktopIpc.inspect).mockClear();
    await expect(retireLegacyAccepted(workspace, commandId)).rejects.toMatchObject({ code: "LEGACY_RETIREMENT_CONFLICT" });
    expect(desktopIpc.inspect).not.toHaveBeenCalled();
    expect(fs.readFileSync(recFile, "utf8")).toBe(before);
    fs.writeFileSync(retiredFile, retirement);
    fs.writeFileSync(`${retiredFile}.initialized`, "1\n");
    expect(() => getRetiredLegacyCommandIds(workspace)).toThrow();
    expect(() => getReconciledLegacyCommandIds(workspace)).toThrow();
    expect(() => listLegacyReconciliations(workspace)).toThrow();
  });

  it("IPC 时不持共享锁，源数据保持原字节", async () => {
    seedDelivery();
    const file = path.join(stateDir, "desktop-control", `${workspace.id}.json`);
    const before = fs.readFileSync(file, "utf8");
    const original = vi.mocked(desktopIpc.inspect).getMockImplementation()!;
    vi.mocked(desktopIpc.inspect).mockImplementation(async target => {
      expect(fs.existsSync(`${legacyReconciliationFile(workspace.id)}.lock`)).toBe(false);
      expect(fs.existsSync(path.join(stateDir, "executions", `${workspace.id}.jsonl.lock`))).toBe(false);
      return original(target);
    });
    await retireLegacyAccepted(workspace, commandId);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.existsSync(path.join(stateDir, "executions", `${workspace.id}.jsonl`))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "execution-outputs", workspace.id, "index.json"))).toBe(false);
  });
  it("only accepts a missing old target and idle current binding, then is idempotent", async () => {
    seedDelivery();

    const first = await retireLegacyAccepted(workspace, commandId);
    const file = legacyRetirementFile(workspace.id);
    const before = fs.readFileSync(file, "utf8");
    const second = await retireLegacyAccepted(workspace, commandId);

    expect(first).toEqual({ status: "retired", commandId });
    expect(second).toEqual({ status: "already_retired", commandId });
    expect(readLegacyRetirements(workspace.id)).toMatchObject([{
      commandId,
      deliverySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      observedMissingAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    }]);
    expect(getRetiredLegacyCommandIds(workspace)).toEqual(new Set([commandId]));
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(vi.mocked(desktopIpc.inspect).mock.calls.map(([target]) => target.threadId)).toEqual([
      oldThreadId, currentThreadId, oldThreadId, currentThreadId,
    ]);
  });

  it("ownerless 只接受明确 NO_OWNER，并记录 maintenance thread/turn；重试幂等", async () => {
    seedDelivery();
    vi.mocked(desktopIpc.inspect).mockRejectedValue(Object.assign(new Error("owner missing"), { code: "DESKTOP_NO_OWNER" }));
    vi.spyOn(desktopIpc, "currentResultContext").mockResolvedValue(ownerlessContext() as never);

    const first = await retireLegacyAccepted(workspace, commandId, { ownerless: true });
    const file = legacyRetirementFile(workspace.id);
    const before = fs.readFileSync(file, "utf8");
    const second = await retireLegacyAccepted(workspace, commandId, { ownerless: true });

    expect(first).toEqual({ status: "retired", commandId });
    expect(second).toEqual({ status: "already_retired", commandId });
    expect(readLegacyRetirements(workspace.id)).toMatchObject([{
      kind: "ownerless",
      commandId,
      deliverySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      observedOwnerlessAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      maintenanceThreadId: currentThreadId,
      maintenanceTurnId,
    }]);
    expect(getRetiredLegacyCommandIds(workspace)).toEqual(new Set([commandId]));
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(vi.mocked(desktopIpc.currentResultContext).mock.calls).toEqual([
      [workspace.root], [workspace.root], [workspace.root], [workspace.root],
    ]);
    expect(fs.existsSync(path.join(stateDir, "executions", `${workspace.id}.jsonl`))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "execution-outputs", workspace.id, "index.json"))).toBe(false);
  });

  it("CLI --ownerless 转发显式模式并保持非完成语义", async () => {
    seedDelivery();
    vi.mocked(desktopIpc.inspect).mockRejectedValue(Object.assign(new Error("owner missing"), { code: "DESKTOP_NO_OWNER" }));
    vi.spyOn(desktopIpc, "currentResultContext").mockResolvedValue(ownerlessContext() as never);

    const result = await runRetireCli([
      "desktop", "legacy-retire", "-w", root, "--command-id", commandId, "--ownerless", "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({ ok: true, status: "retired", commandId });
    expect(readLegacyRetirements(workspace.id)[0]).toMatchObject({ kind: "ownerless", commandId });
  });

  it("ownerless maintenance context 仅对短暂 STATE_UNAVAILABLE 有界重试", async () => {
    seedDelivery();
    vi.mocked(desktopIpc.inspect).mockRejectedValue(Object.assign(new Error("owner missing"), { code: "DESKTOP_NO_OWNER" }));
    const current = vi.spyOn(desktopIpc, "currentResultContext")
      .mockRejectedValueOnce(new DesktopError("DESKTOP_STATE_UNAVAILABLE", "暂时不可确认"))
      .mockResolvedValue(ownerlessContext() as never);

    await expect(retireLegacyAccepted(workspace, commandId, { ownerless: true })).resolves.toMatchObject({ status: "retired" });
    expect(current).toHaveBeenCalledTimes(3);
  });

  it("不同 retirement kind 互斥，旧 strict entry 不会被改写为 ownerless", async () => {
    seedDelivery();
    await retireLegacyAccepted(workspace, commandId);
    const file = legacyRetirementFile(workspace.id);
    const before = fs.readFileSync(file, "utf8");
    vi.mocked(desktopIpc.inspect).mockRejectedValue(Object.assign(new Error("owner missing"), { code: "DESKTOP_NO_OWNER" }));
    vi.spyOn(desktopIpc, "currentResultContext").mockResolvedValue(ownerlessContext() as never);

    await expect(retireLegacyAccepted(workspace, commandId, { ownerless: true })).rejects.toMatchObject({
      code: "LEGACY_RETIREMENT_CONFLICT",
    });
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(readLegacyRetirements(workspace.id)[0]).not.toHaveProperty("kind");
  });

  it("getRetired 对 ownerless 只重验历史摘要，不要求 maintenance turn 仍活跃", async () => {
    seedDelivery();
    vi.mocked(desktopIpc.inspect).mockRejectedValue(Object.assign(new Error("owner missing"), { code: "DESKTOP_NO_OWNER" }));
    const current = vi.spyOn(desktopIpc, "currentResultContext").mockResolvedValue(ownerlessContext() as never);
    await retireLegacyAccepted(workspace, commandId, { ownerless: true });
    current.mockRejectedValue(new DesktopError("DESKTOP_STATE_UNAVAILABLE", "maintenance turn 已结束") as never);
    current.mockClear();

    expect(getRetiredLegacyCommandIds(workspace)).toEqual(new Set([commandId]));
    expect(current).not.toHaveBeenCalled();
    const evidenceBefore = readLegacyRetirements(workspace.id);
    updateDesktop(workspace.id, state => ({
      state: { ...state!, binding: { ...state!.binding!, threadId: "01a00000-0000-7000-8000-000000000099" } },
      result: undefined,
    }));
    expect(getRetiredLegacyCommandIds(workspace)).toEqual(new Set([commandId]));
    expect(readLegacyRetirements(workspace.id)).toEqual(evidenceBefore);
    updateDesktop(workspace.id, state => ({
      state: { ...state!, binding: { ...state!.binding!, threadId: oldThreadId } }, result: undefined,
    }));
    expect(() => getRetiredLegacyCommandIds(workspace)).toThrowError(
      expect.objectContaining({ code: "LEGACY_RETIREMENT_CONFLICT" }),
    );
  });

  it.each([
    ["result turn", { resultTurnId: "01a00000-0000-7000-8000-000000000007" }],
    ["thread", { threadId: oldThreadId }],
  ] as const)("ownerless 写入前 current context %s 变化时拒绝且不写入", async (_name, changed) => {
    seedDelivery();
    vi.mocked(desktopIpc.inspect).mockRejectedValue(Object.assign(new Error("owner missing"), { code: "DESKTOP_NO_OWNER" }));
    vi.spyOn(desktopIpc, "currentResultContext")
      .mockResolvedValueOnce(ownerlessContext())
      .mockResolvedValueOnce(ownerlessContext(changed) as never);

    await expect(retireLegacyAccepted(workspace, commandId, { ownerless: true })).rejects.toMatchObject({
      code: _name === "result turn" ? "LEGACY_RETIREMENT_CONFLICT" : "LEGACY_RETIREMENT_NOT_ELIGIBLE",
    });
    expect(readLegacyRetirements(workspace.id)).toEqual([]);
  });

  it.each([
    ["owner", { ownerClientId: "other-owner" }],
    ["version", { desktopVersion: "9.9.9" }],
    ["cwd", { cwd: "other-cwd" }],
  ] as const)("ownerless 写入前 current context %s 变化时拒绝且不写入", async (_name, changed) => {
    seedDelivery();
    vi.mocked(desktopIpc.inspect).mockRejectedValue(Object.assign(new Error("owner missing"), { code: "DESKTOP_NO_OWNER" }));
    vi.spyOn(desktopIpc, "currentResultContext")
      .mockResolvedValueOnce(ownerlessContext())
      .mockResolvedValueOnce(ownerlessContext(changed) as never);

    await expect(retireLegacyAccepted(workspace, commandId, { ownerless: true })).rejects.toMatchObject({
      code: "LEGACY_RETIREMENT_CONFLICT",
    });
    expect(readLegacyRetirements(workspace.id)).toEqual([]);
  });

  it.each([
    ["thread", { threadId: oldThreadId }],
    ["project", { projectId: "wrong-project" }],
    ["host", { hostId: "remote" }],
    ["workspace", { workspaceRoot: "wrong-workspace-root" }],
    ["turn id", { resultTurnId: "not-a-uuid" }],
    ["turn status", { resultTurnStatus: "completed" }],
    ["runtime status", { runtimeStatus: "idle" }],
  ] as const)("ownerless 拒绝错误的当前 binding/result context：%s", async (_name, changed) => {
    seedDelivery();
    vi.mocked(desktopIpc.inspect).mockRejectedValue(Object.assign(new Error("owner missing"), { code: "DESKTOP_NO_OWNER" }));
    vi.spyOn(desktopIpc, "currentResultContext").mockResolvedValue(ownerlessContext(changed) as never);

    await expect(retireLegacyAccepted(workspace, commandId, { ownerless: true })).rejects.toMatchObject({
      code: "LEGACY_RETIREMENT_NOT_ELIGIBLE",
    });
    expect(readLegacyRetirements(workspace.id)).toEqual([]);
    expect(vi.mocked(desktopIpc.currentResultContext)).toHaveBeenCalledWith(workspace.root);
  });

  it.each(["DESKTOP_TARGET_NOT_FOUND", "DESKTOP_BUSY", "DESKTOP_STATE_UNAVAILABLE"] as const)(
    "ownerless 只接受 DESKTOP_NO_OWNER；历史 target %s 拒绝且不读取当前 context", async code => {
      seedDelivery();
      vi.mocked(desktopIpc.inspect).mockRejectedValue(Object.assign(new Error("fixture"), { code }));
      const current = vi.spyOn(desktopIpc, "currentResultContext").mockResolvedValue(ownerlessContext() as never);

      await expect(retireLegacyAccepted(workspace, commandId, { ownerless: true })).rejects.toMatchObject({
        code: "LEGACY_RETIREMENT_IPC",
      });
      expect(current).not.toHaveBeenCalled();
      expect(readLegacyRetirements(workspace.id)).toEqual([]);
    },
  );

  it.each(["idle", "active"] as const)("ownerless 历史 target 返回 %s 也拒绝", async runtimeStatus => {
    seedDelivery();
    vi.mocked(desktopIpc.inspect).mockResolvedValue({
      threadId: oldThreadId, hostId: "local", projectId: "legacy-project", workspaceRoot: workspace.root,
      title: "old", cwd: workspace.root, runtimeStatus,
    });
    const current = vi.spyOn(desktopIpc, "currentResultContext").mockResolvedValue(ownerlessContext() as never);

    await expect(retireLegacyAccepted(workspace, commandId, { ownerless: true })).rejects.toMatchObject({
      code: "LEGACY_RETIREMENT_NOT_ELIGIBLE",
    });
    expect(current).not.toHaveBeenCalled();
    expect(readLegacyRetirements(workspace.id)).toEqual([]);
  });

  it.each([
    ["modern intent", { intent: "revision" }],
    ["outcome unknown", { commandId: "other-command", deliveryStatus: "outcome_unknown", turnId: undefined }],
  ] as const)("ownerless 继续拒绝 %s", async (_name, overrides) => {
    seedDelivery(overrides);
    vi.mocked(desktopIpc.inspect).mockRejectedValue(Object.assign(new Error("owner missing"), { code: "DESKTOP_NO_OWNER" }));
    const current = vi.spyOn(desktopIpc, "currentResultContext").mockResolvedValue(ownerlessContext() as never);

    await expect(retireLegacyAccepted(workspace, commandId, { ownerless: true })).rejects.toMatchObject({
      code: "LEGACY_RETIREMENT_NOT_ELIGIBLE",
    });
    expect(current).not.toHaveBeenCalled();
    expect(readLegacyRetirements(workspace.id)).toEqual([]);
  });

  it("read API is pure on a fresh state", () => {
    const file = legacyRetirementFile(workspace.id);
    expect(readLegacyRetirements(workspace.id)).toEqual([]);
    expect(fs.existsSync(path.dirname(file))).toBe(false);
  });

  it.each([
    ["intent", { intent: "revision" }],
    ["same current thread", { threadId: currentThreadId }],
  ] as const)("rejects %s", async (_name, overrides) => {
    seedDelivery(overrides);
    await expect(retireLegacyAccepted(workspace, commandId)).rejects.toMatchObject({
      code: "LEGACY_RETIREMENT_NOT_ELIGIBLE",
    });
    expect(readLegacyRetirements(workspace.id)).toEqual([]);
    expect(desktopIpc.inspect).not.toHaveBeenCalled();
  });

  it("rejects outcome_unknown before any IPC", async () => {
    seedDelivery();
    updateDesktop(workspace.id, state => ({
      state: {
        ...state!,
        deliveries: [...state!.deliveries, {
          ...state!.deliveries[0]!,
          commandId: "unknown-command",
          turnId: undefined,
          deliveryStatus: "outcome_unknown" as const,
        }],
      },
      result: undefined,
    }));
    await expect(retireLegacyAccepted(workspace, commandId)).rejects.toMatchObject({ code: "LEGACY_RETIREMENT_NOT_ELIGIBLE" });
    expect(desktopIpc.inspect).not.toHaveBeenCalled();
  });

  it("rejects a missing binding before any IPC", async () => {
    seedDelivery();
    updateDesktop(workspace.id, state => ({ state: { ...state!, binding: null }, result: undefined }));
    await expect(retireLegacyAccepted(workspace, commandId)).rejects.toMatchObject({ code: "LEGACY_RETIREMENT_NOT_ELIGIBLE" });
    expect(desktopIpc.inspect).not.toHaveBeenCalled();
  });

  it.each([
    ["commandId", { commandId }],
    ["taskId equal to commandId", { commandId: "other-command", taskId: commandId }],
    ["desktop taskId", { commandId: "other-command", taskId: `desktop_${commandId}` }],
  ] as const)("rejects an existing execution record matched by %s", async (_name, overrides) => {
    seedDelivery();
    addRecord(overrides);
    await expect(retireLegacyAccepted(workspace, commandId)).rejects.toMatchObject({ code: "LEGACY_RETIREMENT_CONFLICT" });
    expect(desktopIpc.inspect).not.toHaveBeenCalled();
  });

  it.each([commandId, `desktop_${commandId}`])("rejects an orphan output with taskId %s", async taskId => {
    seedDelivery();
    saveExecutionOutput(workspace.id, { command: "orphan", raw: "output", taskId, iteration: 1 });
    await expect(retireLegacyAccepted(workspace, commandId)).rejects.toMatchObject({ code: "LEGACY_RETIREMENT_CONFLICT" });
    expect(desktopIpc.inspect).not.toHaveBeenCalled();
  });

  it.each(["idle", "active"] as const)("rejects an old target that is returned as %s", async oldStatus => {
    seedDelivery();
    vi.mocked(desktopIpc.inspect).mockImplementation(async target => {
      if (target.threadId === oldThreadId) return { ...target, title: "old", cwd: target.workspaceRoot, runtimeStatus: oldStatus } as never;
      return { ...target, title: "current", cwd: target.workspaceRoot, runtimeStatus: "idle" } as never;
    });
    await expect(retireLegacyAccepted(workspace, commandId)).rejects.toMatchObject({ code: "LEGACY_RETIREMENT_NOT_ELIGIBLE" });
    expect(readLegacyRetirements(workspace.id)).toEqual([]);
    expect(desktopIpc.inspect).toHaveBeenCalledTimes(1);
  });

  it.each(["active", "inProgress", "awaiting_approval", "unknown"] as const)("requires the current binding to be idle (%s)", async currentStatus => {
    seedDelivery();
    vi.mocked(desktopIpc.inspect).mockImplementation(async target => {
      if (target.threadId === oldThreadId) {
        throw Object.assign(new Error("old thread missing"), { code: "DESKTOP_TARGET_NOT_FOUND" });
      }
      return { ...target, title: "current", cwd: target.workspaceRoot, runtimeStatus: currentStatus } as never;
    });
    await expect(retireLegacyAccepted(workspace, commandId)).rejects.toMatchObject({ code: "LEGACY_RETIREMENT_NOT_ELIGIBLE" });
    expect(desktopIpc.inspect).toHaveBeenCalledTimes(2);
    expect(readLegacyRetirements(workspace.id)).toEqual([]);
  });

  it.each(["DESKTOP_BUSY", "DESKTOP_NO_OWNER", "DESKTOP_STATE_UNAVAILABLE"] as const)("rejects old IPC status %s and does not inspect current", async code => {
    seedDelivery();
    vi.mocked(desktopIpc.inspect).mockRejectedValue(Object.assign(new Error("fixture"), { code }));
    await expect(retireLegacyAccepted(workspace, commandId)).rejects.toMatchObject({ code: "LEGACY_RETIREMENT_IPC" });
    expect(desktopIpc.inspect).toHaveBeenCalledTimes(1);
  });

  it.each(["DESKTOP_BUSY", "DESKTOP_NO_OWNER", "DESKTOP_STATE_UNAVAILABLE"] as const)("rejects current IPC status %s", async code => {
    seedDelivery();
    vi.mocked(desktopIpc.inspect).mockImplementation(async target => {
      if (target.threadId === oldThreadId) {
        throw Object.assign(new Error("old thread missing"), { code: "DESKTOP_TARGET_NOT_FOUND" });
      }
      throw Object.assign(new Error("fixture"), { code });
    });
    await expect(retireLegacyAccepted(workspace, commandId)).rejects.toMatchObject({ code: "LEGACY_RETIREMENT_IPC" });
    expect(desktopIpc.inspect).toHaveBeenCalledTimes(2);
  });

  it("rejects any Desktop, records, or output change across IPC", async () => {
    seedDelivery();
    vi.mocked(desktopIpc.inspect).mockImplementation(async target => {
      if (target.threadId === oldThreadId) {
        updateDesktop(workspace.id, state => ({
          state: { ...state!, deliveries: state!.deliveries.map(item => ({ ...item, updatedAt: "2026-01-01T00:00:01.000Z" })) },
          result: undefined,
        }));
        throw Object.assign(new Error("old thread missing"), { code: "DESKTOP_TARGET_NOT_FOUND" });
      }
      return { ...target, title: "current", cwd: target.workspaceRoot, runtimeStatus: "idle" } as never;
    });

    await expect(retireLegacyAccepted(workspace, commandId)).rejects.toMatchObject({ code: "LEGACY_RETIREMENT_CONFLICT" });
    expect(readLegacyRetirements(workspace.id)).toEqual([]);
  });

  it.each(["record", "output"] as const)("rejects a %s added during IPC", async kind => {
    seedDelivery();
    vi.mocked(desktopIpc.inspect).mockImplementation(async target => {
      if (target.threadId === oldThreadId) {
        if (kind === "record") addRecord({ commandId });
        else saveExecutionOutput(workspace.id, { command: "orphan", raw: "output", taskId: `desktop_${commandId}`, iteration: 1 });
        throw Object.assign(new Error("old thread missing"), { code: "DESKTOP_TARGET_NOT_FOUND" });
      }
      return { ...target, title: "current", cwd: target.workspaceRoot, runtimeStatus: "idle" } as never;
    });

    await expect(retireLegacyAccepted(workspace, commandId)).rejects.toMatchObject({ code: "LEGACY_RETIREMENT_CONFLICT" });
    expect(readLegacyRetirements(workspace.id)).toEqual([]);
  });

  it("strict revalidation is read-only and rejects changed facts without IPC", async () => {
    seedDelivery();
    await retireLegacyAccepted(workspace, commandId);
    vi.mocked(desktopIpc.inspect).mockClear();
    updateDesktop(workspace.id, state => ({
      state: { ...state!, binding: { ...state!.binding!, threadId: oldThreadId } },
      result: undefined,
    }));

    expect(() => getRetiredLegacyCommandIds(workspace)).toThrowError(
      expect.objectContaining({ code: "LEGACY_RETIREMENT_CONFLICT" }),
    );
    expect(desktopIpc.inspect).not.toHaveBeenCalled();
  });

  it("corrupt or unfinished retirement evidence fails closed", async () => {
    seedDelivery();
    await retireLegacyAccepted(workspace, commandId);
    const file = legacyRetirementFile(workspace.id);
    fs.writeFileSync(`${file}.partial.tmp`, "partial");
    expect(() => readLegacyRetirements(workspace.id)).toThrowError(
      expect.objectContaining({ code: "LEGACY_RETIREMENT_STORE_CORRUPT" }),
    );
  });

  it("invalid IDs use a safe retirement code", async () => {
    await expect(retireLegacyAccepted(workspace, "bad id")).rejects.toBeInstanceOf(LegacyRetirementError);
    await expect(retireLegacyAccepted(workspace, "bad id")).rejects.toMatchObject({ code: "LEGACY_RETIREMENT_INVALID" });
  });
});
