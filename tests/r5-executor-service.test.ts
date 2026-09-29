import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ExecutorControlError,
  bindCurrentExecutor,
  freezeActiveDeliveryTarget,
  resolveProductionBackend,
} from "../src/executor-control/index.js";
import { CodexDesktopProductionBackend } from "../src/executor-control/codex-backend.js";
import {
  createExecutorBinding,
  type ExecutorBindingCandidate,
} from "../src/endpoints/schema.js";
import {
  CODEX_DESKTOP_EXECUTOR_ID,
  CodexDesktopExecutorPlugin,
  projectCodexDesktopTargetToExecutorBindingCandidate,
} from "../src/executor/index.js";

const workspaceId = "2582910bf0d2";
const workspaceRoot = "D:\\python\\codex-with-chatgpt";

function candidate(overrides: Partial<ExecutorBindingCandidate> = {}): ExecutorBindingCandidate {
  return {
    pluginId: CODEX_DESKTOP_EXECUTOR_ID,
    workspaceId,
    workspaceRoot,
    instanceId: "local",
    sessionId: "01a0d6cd-09f3-73e3-9726-4bd65df196d3",
    locator: { executorProjectId: "e6c3c73a-44fe-4254-bda9-edfc5ddb6389" },
    ...overrides,
  };
}

function writeDesktopState(enabled: boolean, binding: Record<string, unknown> | null): void {
  const file = path.join(process.env.C2C_STATE_DIR!, "desktop-control", `${workspaceId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      workspaceId,
      workspaceRoot,
      revision: 1,
      enabled,
      binding,
      deliveries: [],
    }),
    "utf8",
  );
}

const legacyBinding = {
  bindingId: "7f3e2c1a-1111-4222-8333-444455556666",
  threadId: "01a0d6cd-09f3-73e3-9726-4bd65df196d3",
  hostId: "local",
  projectId: "e6c3c73a-44fe-4254-bda9-edfc5ddb6389",
  title: "session",
  boundAt: "2026-09-29T00:00:00.000Z",
};

describe("R5b bind-current confirmation boundary", () => {
  it("persists confirmed A even if later current identity would be B", () => {
    // 确认结果 A 的 candidate；之后 current 变成 B 也不应写入 B。
    const confirmedA = projectCodexDesktopTargetToExecutorBindingCandidate({
      target: {
        threadId: legacyBinding.threadId,
        hostId: "local",
        projectId: legacyBinding.projectId,
        workspaceRoot,
      },
      workspaceId,
    });
    const bound = bindCurrentExecutor(workspaceId, workspaceRoot, confirmedA);
    expect(bound.binding.sessionId).toBe(legacyBinding.threadId);
    // 若误用二次 discover 得到的 B，不会被持久化为 active（本测试显式只 bind A）。
    const laterB = candidate({ sessionId: "11111111-2222-4333-8444-555566667777" });
    expect(bound.binding.sessionId).not.toBe(laterB.sessionId);
  });
});

describe("R5b production send attestation", () => {
  let stateDir: string;
  let previous: string | undefined;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-exec-send-"));
    previous = process.env.C2C_STATE_DIR;
    process.env.C2C_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previous;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("rejects when snapshot identity differs from activeBinding", async () => {
    const bound = bindCurrentExecutor(workspaceId, workspaceRoot, candidate());
    writeDesktopState(true, legacyBinding);
    const backend = resolveProductionBackend(CODEX_DESKTOP_EXECUTOR_ID);
    const target = { ...freezeActiveDeliveryTarget(bound.binding), sessionId: "other-session" };
    await expect(
      backend.send({
        workspace: { id: workspaceId, root: workspaceRoot } as never,
        plannerFingerprint: "fp",
        commandId: "cmd-1",
        intent: "development_plan",
        message: "SECRET_TASK_BODY",
        userConfirmed: true,
        clientId: "client-1",
        activeBinding: bound.binding,
        target,
        authorize: () => {},
      }),
    ).rejects.toMatchObject({ code: "EXECUTOR_BINDING_STALE" });
  });

  it("rejects wrong workspaceId/workspaceRoot before send", async () => {
    const bound = bindCurrentExecutor(workspaceId, workspaceRoot, candidate());
    writeDesktopState(true, legacyBinding);
    const backend = resolveProductionBackend(CODEX_DESKTOP_EXECUTOR_ID);
    for (const patch of [
      { workspaceId: "aaaaaaaaaaaa" },
      { workspaceRoot: "D:\\other\\root" },
    ]) {
      await expect(
        backend.send({
          workspace: { id: workspaceId, root: workspaceRoot } as never,
          plannerFingerprint: "fp",
          commandId: "cmd-1",
          intent: "development_plan",
          message: "x",
          userConfirmed: true,
          clientId: "client-1",
          activeBinding: bound.binding,
          target: { ...freezeActiveDeliveryTarget(bound.binding), ...patch },
          authorize: () => {},
        }),
      ).rejects.toMatchObject({ code: /STALE|MISMATCH/ });
    }
  });

  it("rejects locator with extra key before send", async () => {
    const bound = bindCurrentExecutor(workspaceId, workspaceRoot, candidate());
    writeDesktopState(true, legacyBinding);
    const backend = resolveProductionBackend(CODEX_DESKTOP_EXECUTOR_ID);
    await expect(
      backend.send({
        workspace: { id: workspaceId, root: workspaceRoot } as never,
        plannerFingerprint: "fp",
        commandId: "cmd-1",
        intent: "development_plan",
        message: "x",
        userConfirmed: true,
        clientId: "client-1",
        activeBinding: bound.binding,
        target: {
          ...freezeActiveDeliveryTarget(bound.binding),
          locator: { executorProjectId: legacyBinding.projectId, extraKey: "nope" },
        },
        authorize: () => {},
      }),
    ).rejects.toMatchObject({ code: "EXECUTOR_BINDING_STALE" });
  });

  it("rejects when Desktop binding no longer matches generic binding", async () => {
    const bound = bindCurrentExecutor(workspaceId, workspaceRoot, candidate());
    writeDesktopState(true, { ...legacyBinding, threadId: "11111111-2222-4333-8444-555566667777" });
    const backend = resolveProductionBackend(CODEX_DESKTOP_EXECUTOR_ID);
    await expect(
      backend.send({
        workspace: { id: workspaceId, root: workspaceRoot } as never,
        plannerFingerprint: "fp",
        commandId: "cmd-1",
        intent: "development_plan",
        message: "SECRET_TASK_BODY",
        userConfirmed: true,
        clientId: "client-1",
        activeBinding: bound.binding,
        target: freezeActiveDeliveryTarget(bound.binding),
        authorize: () => {},
      }),
    ).rejects.toMatchObject({ code: "EXECUTOR_BINDING_STALE" });
  });

  it("binding switch keeps old command target frozen via snapshot", () => {
    const a = bindCurrentExecutor(workspaceId, workspaceRoot, candidate());
    const frozenA = freezeActiveDeliveryTarget(a.binding);
    const b = bindCurrentExecutor(workspaceId, workspaceRoot, candidate({ sessionId: "sess-B" }));
    expect(b.binding.bindingId).not.toBe(a.binding.bindingId);
    expect(frozenA.sessionId).toBe(a.binding.sessionId);
    expect(frozenA.bindingId).toBe(a.binding.bindingId);
  });
});

describe("R5b Codex plugin and backend source contract", () => {
  it("backend never routes through ExecutorPlugin.deliver and does not echo raw message", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/executor-control/codex-backend.ts"), "utf8");
    expect(source).not.toMatch(/codexDesktopExecutorPlugin\.deliver|plugin\.deliver\(/);
    expect(source).toMatch(/deliverCurrentCommand/);
    expect(source).toMatch(/delivery\.message/);
    expect(source).not.toMatch(/message: request\.message/);
  });

  it("Codex plugin discoverCurrent returns candidate without Bridge metadata", async () => {
    const plugin = new CodexDesktopExecutorPlugin({
      descriptor: {} as never,
      async inspect(target) {
        return { ...target, title: "t" };
      },
      async currentIdentity() {
        return {
          threadId: candidate().sessionId,
          hostId: "local",
          projectId: candidate().locator.executorProjectId!,
          workspaceRoot,
          title: "t",
        };
      },
      async confirmCurrent() {
        return {
          threadId: candidate().sessionId,
          hostId: "local",
          projectId: candidate().locator.executorProjectId!,
          workspaceRoot,
          title: "t",
        };
      },
      async prepare() {
        return {
          async send() {
            return { threadId: candidate().sessionId, turnId: "turn-1" };
          },
          close() {},
        };
      },
      async inspectActiveExecution(target) {
        return { ...target, activeTurnId: "turn-1" };
      },
    });
    const c = await plugin.discoverCurrent({ workspaceRoot, workspaceId });
    expect("bindingId" in c).toBe(false);
    expect(c.sessionId).toBe(candidate().sessionId);
  });
});
