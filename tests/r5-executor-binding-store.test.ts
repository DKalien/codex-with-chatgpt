import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ExecutorControlError,
  MAX_EPOCH,
  bindCurrentExecutor,
  executorControlFile,
  executorControlInitializedFile,
  nextEpoch,
  parseExecutorControlState,
  readActiveExecutorBinding,
  readExecutorControl,
  updateExecutorControlDetailed,
} from "../src/executor-control/index.js";
import {
  hasProductionExecutorPlugin,
  listProductionExecutorPlugins,
} from "../src/executor-control/registry.js";
import type { ExecutorBindingCandidate } from "../src/endpoints/schema.js";

const workspaceId = "2582910bf0d2";
const workspaceRoot = "D:\\python\\codex-with-chatgpt";

function candidate(overrides: Partial<ExecutorBindingCandidate> = {}): ExecutorBindingCandidate {
  return {
    pluginId: "codex-desktop",
    workspaceId,
    workspaceRoot,
    instanceId: "local",
    sessionId: "sess-1",
    locator: { executorProjectId: "proj-1" },
    ...overrides,
  };
}

describe("R5b executor control store", () => {
  let stateDir: string;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-exec-control-"));
    previousStateDir = process.env.C2C_STATE_DIR;
    process.env.C2C_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousStateDir;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("initial state has no active binding", () => {
    expect(readActiveExecutorBinding(workspaceId, workspaceRoot)).toBeNull();
    expect(readExecutorControl(workspaceId)).toBeNull();
  });

  it("first bind creates epoch=1 binding and initialized marker", () => {
    const result = bindCurrentExecutor(workspaceId, workspaceRoot, candidate());
    expect(result.created).toBe(true);
    expect(result.binding.epoch).toBe(1);
    expect(fs.existsSync(executorControlInitializedFile(workspaceId))).toBe(true);
    expect(readActiveExecutorBinding(workspaceId, workspaceRoot)?.bindingId).toBe(result.binding.bindingId);
  });

  it("same candidate bind is exact no-op without rewrite", () => {
    const first = bindCurrentExecutor(workspaceId, workspaceRoot, candidate());
    const file = executorControlFile(workspaceId);
    const before = fs.readFileSync(file, "utf8");
    const mtimeBefore = fs.statSync(file).mtimeMs;
    const second = bindCurrentExecutor(workspaceId, workspaceRoot, candidate());
    expect(second.created).toBe(false);
    expect(second.noWrite).toBe(true);
    expect(second.binding).toEqual(first.binding);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.statSync(file).mtimeMs).toBe(mtimeBefore);
  });

  it("TOCTOU: state becomes same candidate after pre-read still noWrite idempotent", () => {
    bindCurrentExecutor(workspaceId, workspaceRoot, candidate());
    // simulate concurrent same-candidate write already applied
    const again = bindCurrentExecutor(workspaceId, workspaceRoot, candidate());
    expect(again.created).toBe(false);
    expect(again.noWrite).toBe(true);
  });

  it("changed session creates new bindingId and epoch+1", () => {
    const first = bindCurrentExecutor(workspaceId, workspaceRoot, candidate());
    const second = bindCurrentExecutor(workspaceId, workspaceRoot, candidate({ sessionId: "sess-2" }));
    expect(second.created).toBe(true);
    expect(second.binding.bindingId).not.toBe(first.binding.bindingId);
    expect(second.binding.epoch).toBe(first.binding.epoch + 1);
  });

  it("changed instance and locator create new bindings", () => {
    const base = bindCurrentExecutor(workspaceId, workspaceRoot, candidate());
    const byInstance = bindCurrentExecutor(workspaceId, workspaceRoot, candidate({ instanceId: "host-2" }));
    expect(byInstance.binding.bindingId).not.toBe(base.binding.bindingId);
    const byLocator = bindCurrentExecutor(
      workspaceId,
      workspaceRoot,
      candidate({ locator: { executorProjectId: "proj-2" } }),
    );
    expect(byLocator.binding.locator.executorProjectId).toBe("proj-2");
    expect(byLocator.binding.epoch).toBe(byInstance.binding.epoch + 1);
  });

  it("workspace mismatch fails closed", () => {
    expect(() =>
      bindCurrentExecutor(workspaceId, "D:\\other\\root", candidate()),
    ).toThrow(ExecutorControlError);
    expect(() =>
      bindCurrentExecutor(workspaceId, workspaceRoot, candidate({ workspaceId: "aaaaaaaaaaaa" })),
    ).toThrow(ExecutorControlError);
  });

  it("malformed file fails closed; initialized file deleted also corrupt", () => {
    bindCurrentExecutor(workspaceId, workspaceRoot, candidate());
    const file = executorControlFile(workspaceId);
    fs.writeFileSync(file, "{ not json", "utf8");
    expect(() => readExecutorControl(workspaceId)).toThrow(/EXECUTOR_CONTROL_STATE_CORRUPT|损坏/);

    // 重新初始化后删除 state 文件，但保留 initialized marker → corrupt not null
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.mkdirSync(stateDir, { recursive: true });
    process.env.C2C_STATE_DIR = stateDir;
    bindCurrentExecutor(workspaceId, workspaceRoot, candidate());
    fs.unlinkSync(executorControlFile(workspaceId));
    expect(() => readExecutorControl(workspaceId)).toThrow(/EXECUTOR_CONTROL_STATE_CORRUPT|损坏/);
  });

  it("activeBinding workspace identity mismatch is corrupt", () => {
    bindCurrentExecutor(workspaceId, workspaceRoot, candidate());
    const file = executorControlFile(workspaceId);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    state.activeBinding.workspaceId = "bbbbbbbbbbbb";
    fs.writeFileSync(file, JSON.stringify(state), "utf8");
    expect(() => readExecutorControl(workspaceId)).toThrow(/损坏/);
  });

  it("activeBinding workspaceRoot mismatch is corrupt", () => {
    bindCurrentExecutor(workspaceId, workspaceRoot, candidate());
    const file = executorControlFile(workspaceId);
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    state.activeBinding.workspaceRoot = "D:\\other\\root";
    fs.writeFileSync(file, JSON.stringify(state), "utf8");
    expect(() => readExecutorControl(workspaceId)).toThrow(/损坏/);
  });

  it("lock busy fails closed", () => {
    const file = executorControlFile(workspaceId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.lock`, "", "utf8");
    expect(() => bindCurrentExecutor(workspaceId, workspaceRoot, candidate())).toThrow(/LOCK_BUSY|锁/);
  });

  it("epoch overflow fails closed", () => {
    expect(() => nextEpoch(MAX_EPOCH)).toThrow(/EPOCH_OVERFLOW|上限/);
  });

  it("rejects unknown plugin and stores no product fields", () => {
    expect(() =>
      bindCurrentExecutor(workspaceId, workspaceRoot, candidate({ pluginId: "claude-code" })),
    ).toThrow(/UNKNOWN_PLUGIN|production/);
    const result = bindCurrentExecutor(workspaceId, workspaceRoot, candidate());
    const raw = fs.readFileSync(executorControlFile(workspaceId), "utf8");
    expect(raw).not.toMatch(/threadId|turnId|hostId|projectId|plannerRouteId|principalFingerprint/);
    expect(raw).toMatch(result.binding.bindingId);
  });

  it("noWrite without previous durable state fails closed", () => {
    expect(() =>
      updateExecutorControlDetailed(workspaceId, workspaceRoot, (previous) => {
        expect(previous).toBeNull();
        return {
          state: {
            version: 1,
            workspaceId,
            workspaceRoot,
            revision: 1,
            activeBinding: null,
          },
          result: { ok: true },
          noWrite: true,
        };
      }),
    ).toThrow(/noWrite|损坏/);
    expect(readExecutorControl(workspaceId)).toBeNull();
  });

  it("file remains readable after normal update", () => {
    const first = bindCurrentExecutor(workspaceId, workspaceRoot, candidate());
    const second = bindCurrentExecutor(workspaceId, workspaceRoot, candidate({ sessionId: "sess-2" }));
    const state = readExecutorControl(workspaceId);
    expect(state?.revision).toBe(2);
    expect(state?.activeBinding?.bindingId).toBe(second.binding.bindingId);
    expect(first.binding.sessionId).toBe("sess-1");
  });
});

describe("R5b production registry", () => {
  it("contains only codex-desktop and rejects Claude", () => {
    const ids = listProductionExecutorPlugins().map(p => p.descriptor.pluginId);
    expect(ids).toEqual(["codex-desktop"]);
    expect(hasProductionExecutorPlugin("codex-desktop")).toBe(true);
    expect(hasProductionExecutorPlugin("claude-code")).toBe(false);
  });

  it("parseExecutorControlState rejects malformed and identity-mismatched state", () => {
    expect(() => parseExecutorControlState({ version: 2 })).toThrow();
    expect(() =>
      parseExecutorControlState({
        version: 1,
        workspaceId,
        workspaceRoot,
        revision: 0,
        activeBinding: null,
      }),
    ).toThrow();
    expect(() =>
      parseExecutorControlState({
        version: 1,
        workspaceId,
        workspaceRoot,
        revision: 1,
        activeBinding: {
          version: 1,
          bindingId: "b1",
          pluginId: "codex-desktop",
          workspaceId: "aaaaaaaaaaaa",
          workspaceRoot,
          instanceId: "i",
          sessionId: "s",
          locator: { executorProjectId: "p" },
          epoch: 1,
          boundAt: "2026-09-29T00:00:00.000Z",
        },
      }),
    ).toThrow();
  });
});
