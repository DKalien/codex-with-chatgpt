import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopIpc } from "../src/desktop/ipc.js";
import { recordDesktopResult } from "../src/desktop/result.js";
import { reconcileUnknownDesktopDelivery } from "../src/desktop/unknown-reconciliation.js";
import { listExecutionOutputs } from "../src/execution/output.js";
import { readExecutionRecords } from "../src/execution/records.js";
import { desktopFile, readDesktop, updateDesktop } from "../src/desktop/store.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const threadId = "01a00000-0000-7000-8000-000000000001";
const turnId = "01a00000-0000-7000-8000-000000000002";
const secondTurnId = "01a00000-0000-7000-8000-000000000003";
const bindingId = "01a00000-0000-7000-8000-000000000004";
const commandId = "unknown_command";
const message = "[C2C_CONTROL]\nSTATE: COMMAND\n只读检查";

let root: string;
let stateDir: string;
let workspace: Workspace;

function seedDelivery(overrides: Record<string, unknown> = {}): void {
  const now = "2026-09-19T00:00:00.000Z";
  updateDesktop(workspace.id, () => ({
    state: {
      version: 1,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      revision: 1,
      enabled: true,
      binding: {
        threadId,
        hostId: "local" as const,
        projectId: "desktop_project",
        bindingId,
        title: "当前 Desktop 会话",
        boundAt: now,
      },
      deliveries: [{
        commandId,
        clientId: "client",
        bindingId,
        intent: "development_plan" as const,
        messageSha256: createHash("sha256").update(message, "utf8").digest("hex"),
        messageBytes: Buffer.byteLength(message, "utf8"),
        threadId,
        deliveryStatus: "outcome_unknown" as const,
        createdAt: now,
        updatedAt: now,
        ...overrides,
      }],
    },
    result: undefined,
  }));
}

function observation(candidates: string[], overrides: Record<string, unknown> = {}) {
  return {
    threadId,
    hostId: "local" as const,
    projectId: "desktop_project",
    workspaceRoot: workspace.root,
    candidates,
    ...overrides,
  };
}

beforeEach(() => {
  root = makeTmpDir("desktop-unknown-reconcile-workspace");
  stateDir = makeTmpDir("desktop-unknown-reconcile-state");
  workspace = new Workspace(root);
  vi.stubEnv("C2C_STATE_DIR", stateDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  cleanup(root);
  cleanup(stateDir);
});

describe("Desktop outcome_unknown reconciliation", () => {
  it("唯一精确候选只恢复 turnId，不写 execution receipt", async () => {
    seedDelivery();
    vi.spyOn(desktopIpc, "reconcileUnknown").mockResolvedValue(observation([turnId]));

    await expect(reconcileUnknownDesktopDelivery(workspace, commandId)).resolves.toEqual({
      status: "accepted", commandId, deliveryStatus: "accepted", turnId,
    });
    expect(readDesktop(workspace.id)?.deliveries[0]).toMatchObject({ deliveryStatus: "accepted", turnId });
    expect(readExecutionRecords(workspace.id)).toEqual([]);
    expect(listExecutionOutputs(workspace.id)).toEqual([]);
  });

  it("expectedTurnId 不匹配时保持 outcome_unknown 且不修改状态", async () => {
    seedDelivery();
    const before = fs.readFileSync(desktopFile(workspace.id), "utf8");
    vi.spyOn(desktopIpc, "reconcileUnknown").mockResolvedValue(observation([turnId]));

    await expect(reconcileUnknownDesktopDelivery(workspace, commandId, { expectedTurnId: secondTurnId }))
      .resolves.toMatchObject({ status: "unresolved", deliveryStatus: "outcome_unknown" });
    expect(fs.readFileSync(desktopFile(workspace.id), "utf8")).toBe(before);
    expect(readDesktop(workspace.id)?.deliveries[0].deliveryStatus).toBe("outcome_unknown");
  });

  it("恢复 accepted 后仍由 record-result 的 exact result context 门禁决定", async () => {
    seedDelivery();
    vi.spyOn(desktopIpc, "reconcileUnknown").mockResolvedValue(observation([turnId]));
    await reconcileUnknownDesktopDelivery(workspace, commandId);
    vi.stubEnv("CODEX_THREAD_ID", threadId);
    vi.spyOn(desktopIpc, "currentResultContext").mockResolvedValue({
      threadId, hostId: "local", projectId: "desktop_project", workspaceRoot: workspace.root,
      title: "当前 Desktop 会话", cwd: workspace.root, runtimeStatus: "idle",
      resultTurnId: secondTurnId, resultTurnStatus: "completed",
    });

    await expect(recordDesktopResult(workspace, {
      commandId, changedFiles: [], tests: "not run", exitStatus: "ok",
    })).rejects.toMatchObject({ code: "DESKTOP_RESULT_CURRENT_EXECUTION" });
    expect(readExecutionRecords(workspace.id)).toEqual([]);
    expect(listExecutionOutputs(workspace.id)).toEqual([]);
  });

  it("零候选保持 outcome_unknown 且不写状态", async () => {
    seedDelivery();
    const before = fs.readFileSync(desktopFile(workspace.id), "utf8");
    vi.spyOn(desktopIpc, "reconcileUnknown").mockResolvedValue(observation([]));

    await expect(reconcileUnknownDesktopDelivery(workspace, commandId)).resolves.toMatchObject({
      status: "unresolved", deliveryStatus: "outcome_unknown",
    });
    expect(fs.readFileSync(desktopFile(workspace.id), "utf8")).toBe(before);
  });

  it("多个候选、重复 UUID 和非法 UUID 都 fail closed", async () => {
    seedDelivery();
    const reconcile = vi.spyOn(desktopIpc, "reconcileUnknown");
    reconcile.mockResolvedValueOnce(observation([turnId, secondTurnId]));
    await expect(reconcileUnknownDesktopDelivery(workspace, commandId)).rejects.toMatchObject({ code: "DESKTOP_RECONCILIATION_CONFLICT" });

    seedDelivery();
    reconcile.mockResolvedValueOnce(observation([turnId, turnId]));
    await expect(reconcileUnknownDesktopDelivery(workspace, commandId)).rejects.toMatchObject({ code: "DESKTOP_RECONCILIATION_CONFLICT" });

    seedDelivery();
    reconcile.mockResolvedValueOnce(observation(["not-a-uuid"]));
    await expect(reconcileUnknownDesktopDelivery(workspace, commandId)).rejects.toMatchObject({ code: "DESKTOP_RECONCILIATION_CONFLICT" });
    expect(readDesktop(workspace.id)?.deliveries[0].deliveryStatus).toBe("outcome_unknown");
  });

  it("Desktop thread、workspace 或 project 漂移时不恢复", async () => {
    seedDelivery();
    const reconcile = vi.spyOn(desktopIpc, "reconcileUnknown");
    reconcile.mockResolvedValueOnce(observation([turnId], { threadId: secondTurnId }));
    await expect(reconcileUnknownDesktopDelivery(workspace, commandId)).rejects.toMatchObject({ code: "DESKTOP_RECONCILIATION_CONFLICT" });

    seedDelivery();
    reconcile.mockResolvedValueOnce(observation([turnId], { workspaceRoot: path.join(root, "other") }));
    await expect(reconcileUnknownDesktopDelivery(workspace, commandId)).rejects.toMatchObject({ code: "DESKTOP_RECONCILIATION_CONFLICT" });

    seedDelivery();
    reconcile.mockResolvedValueOnce(observation([turnId], { projectId: "other_project" }));
    await expect(reconcileUnknownDesktopDelivery(workspace, commandId)).rejects.toMatchObject({ code: "DESKTOP_RECONCILIATION_CONFLICT" });
  });

  it("binding drift during Desktop observation 不覆盖新状态", async () => {
    seedDelivery();
    vi.spyOn(desktopIpc, "reconcileUnknown").mockImplementation(async target => {
      updateDesktop(workspace.id, current => {
        if (!current) throw new Error("missing state");
        return { state: { ...current, binding: { ...current.binding!, bindingId: randomUUID() } }, result: undefined };
      });
      return observation([turnId], target);
    });

    await expect(reconcileUnknownDesktopDelivery(workspace, commandId)).rejects.toMatchObject({ code: "DESKTOP_RECONCILIATION_CONFLICT" });
    expect(readDesktop(workspace.id)?.deliveries[0].deliveryStatus).toBe("outcome_unknown");
  });

  it.each([
    ["accepted", { deliveryStatus: "accepted", turnId }],
    ["rejected", { deliveryStatus: "rejected", turnId: undefined, errorCode: "DESKTOP_TEST", errorMessage: "rejected" }],
  ] as const)("已有 %s history 不允许再次 reconciliation", async (_name, overrides) => {
    seedDelivery(overrides);
    await expect(reconcileUnknownDesktopDelivery(workspace, commandId)).rejects.toMatchObject({ code: "DESKTOP_RECONCILIATION_NOT_ELIGIBLE" });
    expect(vi.spyOn(desktopIpc, "reconcileUnknown")).not.toHaveBeenCalled();
  });
});
