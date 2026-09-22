import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assessRolloutIdle, currentCodexThread } from "../src/core/rollout-idle.js";
import {
  activeFinalizerPath,
  assertCanonicalTargetEntry,
  claimFinalizerWorker,
  commitFinalizerResult,
  projectFinalizerExecution,
  readActiveFinalizer,
  readFinalizerResult,
  releaseFinalizerWorkerClaim,
  runFinalizerAttempt,
  schedulePostTurnFinalizer,
  FinalizerActiveReleaseError,
  spawnFinalizerWorker,
  stripWorkerEnv,
  workerClaimPath,
  type ActiveFinalizer,
} from "../src/core/post-turn-finalizer.js";
import { collectReleaseReferences } from "../src/core/release-references.js";
import { planGc } from "../src/core/gc-plan.js";
import { installCore } from "../src/core/install.js";
import * as installModule from "../src/core/install.js";
import { desktopIpc } from "../src/desktop/ipc.js";
import { desktopFile } from "../src/desktop/store.js";
import { Workspace } from "../src/workspace/manager.js";
import { rollout } from "../src/core/rollout.js";
import { getRuntimeBuildId } from "../src/build-id.js";
import * as runtimeModule from "../src/bridge/runtime.js";
import * as daemon from "../src/process/daemon.js";
import { buildCoreFixture, cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

let stateDir: string;
let wsRoot: string;
let workspace: Workspace;
const THREAD = "01a00000-0000-7000-8000-000000000011";

function writeDesktopBinding(threadId = THREAD): void {
  const file = desktopFile(workspace.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1, workspaceId: workspace.id, workspaceRoot: workspace.root, revision: 1, enabled: true,
    binding: { threadId, hostId: "local", projectId: "proj-finalizer", bindingId: randomUUID(), title: "B", boundAt: "2026-09-13T00:00:00.000Z" },
    deliveries: [],
  }));
  fs.writeFileSync(`${file}.initialized`, "1\n");
}

function installTwo(): { oldId: string; newId: string } {
  write(wsRoot, "bin/c2c.js", "// f");
  write(wsRoot, "dist/cli/index.js", "// f");
  write(wsRoot, "package.json", '{"type":"module"}');
  fs.mkdirSync(path.join(wsRoot, "node_modules"), { recursive: true });
  const oldId = installCore(wsRoot, buildCoreFixture(wsRoot)).runtimeBuildId;
  write(wsRoot, "dist/cli/index.js", "// newer");
  const newId = installCore(wsRoot, buildCoreFixture(wsRoot)).runtimeBuildId;
  return { oldId, newId };
}

function proofAssessment() {
  return {
    idle: false,
    blockers: [{ kind: "self_turn" as const, threadId: THREAD }],
    selfBusyProof: {
      threadId: THREAD, hostId: "local", projectId: "proj-finalizer",
      workspaceRoot: wsRoot, runtimeStatus: "active" as const,
    },
  };
}

function job(overrides: Partial<ActiveFinalizer> = {}): ActiveFinalizer {
  return {
    version: 1, jobId: randomUUID(), token: randomUUID(),
    workspaceId: workspace.id, workspaceRoot: workspace.root,
    targetBuildId: "c".repeat(64),
    originThreadId: THREAD, originHostId: "local", originProjectId: "proj-finalizer",
    expectedRuntime: {},
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    status: "scheduled",
    ...overrides,
  };
}

beforeEach(() => {
  stateDir = isolateStateDir();
  wsRoot = makeTmpDir("ptf-ws");
  workspace = new Workspace(wsRoot);
  process.env.CODEX_THREAD_ID = THREAD;
  vi.spyOn(process, "cwd").mockReturnValue(wsRoot);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup(stateDir);
  cleanup(wsRoot);
  delete process.env.C2C_STATE_DIR;
  delete process.env.CODEX_THREAD_ID;
});

describe("self-busy proof", () => {
  it("CODEX_THREAD_ID alone 不能 schedule", async () => {
    const assessment = await assessRolloutIdle(workspace, { pairingActive: false });
    expect(assessment.selfBusyProof).toBeUndefined();
  });

  it("pairing active 时不 schedule", async () => {
    writeDesktopBinding();
    vi.spyOn(desktopIpc, "inspect").mockResolvedValue({ runtimeStatus: "active" } as never);
    const assessment = await assessRolloutIdle(workspace, { pairingActive: true });
    expect(assessment.blockers[0]!.kind).toBe("pairing_active");
  });

  it("exact Desktop self-turn active → proof 成功", async () => {
    writeDesktopBinding();
    vi.spyOn(desktopIpc, "inspect").mockRejectedValue(Object.assign(new Error("busy"), { code: "DESKTOP_BUSY" }));
    vi.spyOn(desktopIpc, "currentExecution").mockResolvedValue({
      threadId: THREAD, hostId: "local", projectId: "proj-finalizer",
      workspaceRoot: wsRoot, title: "当前执行会话", cwd: wsRoot,
      runtimeStatus: "active", activeTurnId: randomUUID(),
    } as never);
    const assessment = await assessRolloutIdle(workspace, { pairingActive: false });
    expect(assessment.blockers).toEqual([{ kind: "self_turn", threadId: THREAD }]);
    expect(assessment.selfBusyProof).toMatchObject({ threadId: THREAD, runtimeStatus: "active" });
    expect(desktopIpc.currentExecution).toHaveBeenCalledWith(wsRoot);
  });

  it("current execution 与 binding 任一身份不一致不能 proof", async () => {
    writeDesktopBinding();
    vi.spyOn(desktopIpc, "inspect").mockRejectedValue(Object.assign(new Error("busy"), { code: "DESKTOP_BUSY" }));
    const currentExecution = vi.spyOn(desktopIpc, "currentExecution");
    const base = {
      threadId: THREAD, hostId: "local", projectId: "proj-finalizer",
      workspaceRoot: wsRoot, title: "当前执行会话", cwd: wsRoot,
      runtimeStatus: "active", activeTurnId: randomUUID(),
    };
    for (const [field, value] of [
      ["threadId", randomUUID()], ["hostId", "other-host"],
      ["projectId", "other-project"], ["workspaceRoot", path.join(wsRoot, "other")],
      ["runtimeStatus", "idle"], ["runtimeStatus", "unknown"],
    ] as const) {
      currentExecution.mockResolvedValue({ ...base, [field]: value } as never);
      const assessment = await assessRolloutIdle(workspace, { pairingActive: false });
      expect(assessment.selfBusyProof).toBeUndefined();
      expect(assessment.blockers).toEqual([{ kind: "busy", detail: "self_turn_unproven" }]);
    }
  });

  it("currentExecution rejection 不授予 proof", async () => {
    writeDesktopBinding();
    vi.spyOn(desktopIpc, "inspect").mockRejectedValue(Object.assign(new Error("busy"), { code: "DESKTOP_BUSY" }));
    vi.spyOn(desktopIpc, "currentExecution").mockRejectedValue(new Error("unavailable"));
    const assessment = await assessRolloutIdle(workspace, { pairingActive: false });
    expect(assessment).toEqual({ idle: false, blockers: [{ kind: "busy", detail: "self_turn_unproven" }] });
    expect(readActiveFinalizer(stateDir, workspace.id)).toBeNull();
  });

  it("non-self DESKTOP_BUSY 无 proof", async () => {
    writeDesktopBinding(randomUUID());
    vi.spyOn(desktopIpc, "inspect").mockRejectedValue(Object.assign(new Error("busy"), { code: "DESKTOP_BUSY" }));
    const current = vi.spyOn(desktopIpc, "currentExecution");
    const assessment = await assessRolloutIdle(workspace, { pairingActive: false });
    expect(assessment.blockers[0].kind).toBe("desktop_busy");
    expect(assessment.selfBusyProof).toBeUndefined();
    expect(current).not.toHaveBeenCalled();
  });

  it("currentCodexThread 要求 cwd 同 workspace", () => {
    vi.spyOn(process, "cwd").mockReturnValue(wsRoot);
    expect(currentCodexThread(workspace)).toBe(THREAD);
    vi.spyOn(process, "cwd").mockReturnValue(path.dirname(wsRoot));
    expect(currentCodexThread(workspace)).toBeNull();
  });
});

describe("schedule / no-clobber / launch", () => {
  it("新 job scheduled 自动 spawn 一次；existing 不再 spawn", async () => {
    const { newId } = installTwo();
    let spawnCount = 0;
    const spawnImpl = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
      spawnCount += 1;
      expect(args[0]).toContain("releases");
      expect(opts.detached).toBe(true);
      return { pid: 111, unref() {} } as never;
    }) as never;
    const first = await schedulePostTurnFinalizer(workspace, newId, {
      stateDir, assessment: proofAssessment() as never, runtime: null, spawnImpl,
    });
    expect(first.ok && first.status).toBe("scheduled");
    expect(spawnCount).toBe(1);
    const second = await schedulePostTurnFinalizer(workspace, newId, {
      stateDir, assessment: proofAssessment() as never, runtime: null, spawnImpl,
    });
    expect(second.ok && second.status).toBe("existing");
    expect(spawnCount).toBe(1);
  });

  it("origin/runtime identity 不同即使同 target 也 conflict", async () => {
    const { newId } = installTwo();
    const spawnImpl = (() => ({ pid: 1, unref() {} })) as never;
    const first = await schedulePostTurnFinalizer(workspace, newId, {
      stateDir, assessment: proofAssessment() as never, runtime: { pid: 1, startedAt: "2026-09-13T00:00:00.000Z", runtimeBuildId: newId } as never, spawnImpl,
    });
    expect(first.ok).toBe(true);
    const conflict = await schedulePostTurnFinalizer(workspace, newId, {
      stateDir, assessment: proofAssessment() as never, runtime: { pid: 2, startedAt: "2026-09-13T00:00:00.000Z", runtimeBuildId: newId } as never, spawnImpl,
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe("FINALIZER_CONFLICT");
  });

  it("spawn 失败写 worker_spawn_failed，不留 scheduled 空壳", async () => {
    const { newId } = installTwo();
    const result = await schedulePostTurnFinalizer(workspace, newId, {
      stateDir, assessment: proofAssessment() as never, runtime: null,
      spawnImpl: (() => { throw new Error("spawn boom"); }) as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FINALIZER_SPAWN_FAILED");
    expect(readActiveFinalizer(stateDir, workspace.id)).toBeNull();
    expect(readFinalizerResult(stateDir, workspace.id)?.reason).toBe("worker_spawn_failed");
  });

  it("corrupt active fail closed；strict reference / symlink / extra field", () => {
    const file = activeFinalizerPath(stateDir, workspace.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{broken}");
    expect(() => readActiveFinalizer(stateDir, workspace.id)).toThrow();
    expect(collectReleaseReferences(stateDir).ok).toBe(false);

    const good = job({ targetBuildId: "a".repeat(64) });
    fs.writeFileSync(file, JSON.stringify({ ...good, extra: 1 }));
    expect(collectReleaseReferences(stateDir).ok).toBe(false);

    fs.writeFileSync(file, JSON.stringify(good));
    const outside = makeTmpDir("ptf-outside");
    dirsPush(outside);
    fs.unlinkSync(file);
    fs.symlinkSync(path.join(outside, "x.json"), file);
    expect(collectReleaseReferences(stateDir).ok).toBe(false);
  });

  it("stripWorkerEnv 只清允许字段", () => {
    const env = stripWorkerEnv({
      CODEX_THREAD_ID: "x", CODEX_SESSION_ID: "y", C2C_STARTUP_LEASE: "z",
      C2C_STATE_DIR: "/state", KEEP: "1",
    } as NodeJS.ProcessEnv);
    expect(env.CODEX_THREAD_ID).toBeUndefined();
    expect(env.C2C_STATE_DIR).toBe("/state");
    expect(env.KEEP).toBe("1");
  });
});

const extraDirs: string[] = [];
function dirsPush(dir: string) { extraDirs.push(dir); }
afterEach(() => { extraDirs.splice(0).forEach(cleanup); });

describe("worker claim / ownership", () => {
  it("duplicate claim fail closed；wrong token 不释放", () => {
    const j = job();
    const file = activeFinalizerPath(stateDir, workspace.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(j));
    const claim = claimFinalizerWorker(stateDir, j);
    expect(() => claimFinalizerWorker(stateDir, j)).toThrow();
    expect(releaseFinalizerWorkerClaim(stateDir, j, { ...claim, workerToken: randomUUID() })).toBe(false);
    expect(fs.existsSync(workerClaimPath(stateDir, workspace.id))).toBe(true);
    expect(releaseFinalizerWorkerClaim(stateDir, j, claim)).toBe(true);
  });

  it("stale worker 不能覆盖 newer result", () => {
    const j = job();
    const file = activeFinalizerPath(stateDir, workspace.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(j));
    commitFinalizerResult(stateDir, j, {
      status: "ok", reason: "already_converged",
      scheduledAt: j.createdAt, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    });
    expect(() => commitFinalizerResult(stateDir, j, {
      status: "failed", reason: "should_not_overwrite",
      scheduledAt: j.createdAt, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    })).toThrow();
    expect(readFinalizerResult(stateDir, workspace.id)?.reason).toBe("already_converged");
  });

  it("result corrupt 明确报错，不当 null", () => {
    const file = path.join(stateDir, "post-turn-finalizer-results", `${workspace.id}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{bad}");
    expect(() => readFinalizerResult(stateDir, workspace.id)).toThrow(/FINALIZER_RESULT_CORRUPT|finalizer result/);
  });
});

describe("worker attempts", () => {
  it("origin active/DESKTOP_BUSY → wait；absolute expiry → timeout_self_busy", async () => {
    const j = job({ expiresAt: new Date(Date.now() - 1).toISOString() });
    const file = activeFinalizerPath(stateDir, workspace.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(j));
    const expired = await runFinalizerAttempt(j, stateDir, {
      inspect: async () => ({ runtimeStatus: "idle" } as never),
    });
    expect(expired.kind).toBe("terminal");
    if (expired.kind === "terminal") expect(expired.result.reason).toBe("timeout_self_busy");

    const fresh = job();
    fs.writeFileSync(activeFinalizerPath(stateDir, workspace.id), JSON.stringify(fresh));
    const active = await runFinalizerAttempt(fresh, stateDir, {
      inspect: async () => ({ runtimeStatus: "active" } as never),
    });
    expect(active.kind).toBe("wait");

    const busy = job();
    fs.writeFileSync(activeFinalizerPath(stateDir, workspace.id), JSON.stringify(busy));
    const busyError = await runFinalizerAttempt(busy, stateDir, {
      inspect: async () => { throw Object.assign(new Error("busy"), { code: "DESKTOP_BUSY" }); },
    });
    expect(busyError).toEqual({ kind: "wait", reason: "origin_still_active" });
    expect(readFinalizerResult(stateDir, workspace.id)).toBeNull();
  });

  it.each(["DESKTOP_TARGET_NOT_FOUND", "DESKTOP_STATE_UNAVAILABLE", "DESKTOP_APPROVAL_PENDING", "DESKTOP_IDENTITY_MISMATCH"])("origin %s → blocked 不 rollout", async (code) => {
    let rolled = false;
    const j = job();
    fs.mkdirSync(path.dirname(activeFinalizerPath(stateDir, workspace.id)), { recursive: true });
    fs.writeFileSync(activeFinalizerPath(stateDir, workspace.id), JSON.stringify(j));
    const result = await runFinalizerAttempt(j, stateDir, {
      inspect: async () => { throw Object.assign(new Error("x"), { code }); },
      rollout: async () => { rolled = true; return { targetBuildId: "c".repeat(64), workspaces: [] }; },
    });
    expect(result.kind).toBe("terminal");
    if (result.kind === "terminal") expect(result.result.reason).toBe("origin_unknown");
    expect(rolled).toBe(false);
  });

  it("precondition 期间 ownership 丢失 → 不 rollout", async () => {
    const { newId } = installTwo();
    const j = job({ targetBuildId: newId });
    const file = activeFinalizerPath(stateDir, workspace.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(j));
    write(stateDir, path.join("runtime-upgrades", `${workspace.id}.json`), JSON.stringify({
      workspaceId: workspace.id, workspaceRoot: wsRoot, targetBuildId: newId, reason: "busy",
      updatedAt: new Date().toISOString(),
    }));
    let rolled = 0;
    vi.spyOn(await import("../src/bridge/runtime.js"), "findBridgeObservation").mockImplementation(async () => {
      // verifyFinalizerPreconditions 读 runtime：此处替换 active ownership
      fs.writeFileSync(file, JSON.stringify({ ...j, token: randomUUID() }));
      return {
        state: "healthy",
        runtime: {
          service: "c2c-bridge", version: "t", workspaceId: workspace.id, workspaceRoot: wsRoot,
          pid: 1, port: 1, adminToken: "t", publicUrl: null,
          startedAt: "2026-09-13T00:00:00.000Z", runtimeBuildId: "d".repeat(64),
        },
      } as never;
    });
    const result = await runFinalizerAttempt(j, stateDir, {
      inspect: async () => ({ runtimeStatus: "idle" } as never),
      rollout: async () => { rolled += 1; return { targetBuildId: newId, workspaces: [] }; },
    });
    expect(result.kind).toBe("terminal");
    if (result.kind === "terminal") expect(result.result.reason).toBe("owner_lost");
    expect(rolled).toBe(0);
  });

  it("already_converged + pending missing 仍可 ok", async () => {
    const { newId } = installTwo();
    vi.spyOn(await import("../src/bridge/runtime.js"), "findBridgeObservation").mockResolvedValue({
      state: "healthy",
      runtime: {
        service: "codex-with-chatgpt", version: "t", workspaceId: workspace.id, workspaceRoot: wsRoot,
        pid: process.pid, port: 48001, adminToken: "t", publicUrl: null,
        startedAt: "2026-09-13T00:00:00.000Z", runtimeBuildId: newId,
      },
    } as never);
    const j = job({ targetBuildId: newId });
    fs.mkdirSync(path.dirname(activeFinalizerPath(stateDir, workspace.id)), { recursive: true });
    fs.writeFileSync(activeFinalizerPath(stateDir, workspace.id), JSON.stringify(j));
    const result = await runFinalizerAttempt(j, stateDir, {
      inspect: async () => ({ runtimeStatus: "idle" } as never),
    });
    expect(result.kind).toBe("terminal");
    if (result.kind === "terminal") {
      expect(result.result.status).toBe("ok");
      expect(result.result.reason).toBe("already_converged");
    }
  });

  it("expectedRuntime pid/startedAt/build 变化 → runtime_replaced", async () => {
    const { newId } = installTwo();
    vi.spyOn(await import("../src/bridge/runtime.js"), "findBridgeObservation").mockResolvedValue({
      state: "healthy",
      runtime: {
        service: "codex-with-chatgpt", version: "t", workspaceId: workspace.id, workspaceRoot: wsRoot,
        pid: 999, port: 48001, adminToken: "t", publicUrl: null,
        startedAt: "2026-09-13T01:00:00.000Z", runtimeBuildId: "d".repeat(64),
      },
    } as never);
    write(stateDir, path.join("runtime-upgrades", `${workspace.id}.json`), JSON.stringify({
      workspaceId: workspace.id, workspaceRoot: wsRoot, targetBuildId: newId, reason: "busy",
      updatedAt: new Date().toISOString(),
    }));
    const j = job({
      targetBuildId: newId,
      expectedRuntime: { runtimeBuildId: newId, pid: 1, startedAt: "2026-09-13T00:00:00.000Z" },
    });
    fs.mkdirSync(path.dirname(activeFinalizerPath(stateDir, workspace.id)), { recursive: true });
    fs.writeFileSync(activeFinalizerPath(stateDir, workspace.id), JSON.stringify(j));
    const result = await runFinalizerAttempt(j, stateDir, {
      inspect: async () => ({ runtimeStatus: "idle" } as never),
    });
    expect(result.kind).toBe("terminal");
    if (result.kind === "terminal") expect(result.result.reason).toBe("runtime_replaced");
  });

  it("assertCanonicalTargetEntry 拒绝缺失/symlink/非 current", () => {
    const { oldId, newId } = installTwo();
    expect(() => assertCanonicalTargetEntry(stateDir, oldId)).toThrow();
    // old is not current → target_changed; new is current and canonical
    expect(assertCanonicalTargetEntry(stateDir, newId)).toContain(newId);
  });

  it("projection 无 fake commandId", () => {
    const { newId } = installTwo();
    const j = job({ targetBuildId: newId });
    const file = activeFinalizerPath(stateDir, workspace.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(j));
    const committed = commitFinalizerResult(stateDir, j, {
      status: "ok", reason: "already_converged",
      scheduledAt: j.createdAt, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    });
    projectFinalizerExecution(workspace.id, j, committed);
    const records = fs.readFileSync(path.join(stateDir, "executions", `${workspace.id}.jsonl`), "utf8");
    expect(records).toContain(`post_turn_${j.jobId}`);
    expect(records).not.toContain("commandId");
  });
});

describe("real self-busy integration", () => {
  it("rollout busy + schedule + launch once；idle 后 upgraded → durable ok", async () => {
    const { oldId, newId } = installTwo();
    writeDesktopBinding();
    // runtime stale (old build)
    write(stateDir, path.join("runtime", `${workspace.id}.json`), JSON.stringify({
      service: "codex-with-chatgpt", version: "t", workspaceId: workspace.id, workspaceRoot: wsRoot,
      pid: 12345, port: 48100, adminToken: "t", publicUrl: null,
      startedAt: "2026-09-13T00:00:00.000Z", runtimeBuildId: oldId,
    }));
    vi.spyOn(desktopIpc, "inspect").mockRejectedValue(Object.assign(new Error("busy"), { code: "DESKTOP_BUSY" }));
    vi.spyOn(desktopIpc, "currentExecution").mockResolvedValue({
      threadId: THREAD, hostId: "local", projectId: "proj-finalizer",
      workspaceRoot: wsRoot, title: "当前执行会话", cwd: wsRoot,
      runtimeStatus: "active", activeTurnId: randomUUID(),
    } as never);
    const assessment = await assessRolloutIdle(workspace, { pairingActive: false });
    expect(assessment.selfBusyProof).toBeDefined();
    let spawnCount = 0;
    const spawnImpl = (() => { spawnCount += 1; return { pid: 9, unref() {} }; }) as never;
    const scheduled = await schedulePostTurnFinalizer(workspace, newId, {
      stateDir, assessment: assessment as never, runtime: null, spawnImpl,
    });
    expect(scheduled.ok && scheduled.status).toBe("scheduled");
    expect(spawnCount).toBe(1);

    // pending written as busy by first rollout path
    write(stateDir, path.join("runtime-upgrades", `${workspace.id}.json`), JSON.stringify({
      workspaceId: workspace.id, workspaceRoot: wsRoot, targetBuildId: newId, reason: "busy",
      updatedAt: new Date().toISOString(),
    }));
    vi.mocked(desktopIpc.inspect).mockResolvedValue({ runtimeStatus: "idle" } as never);
    vi.spyOn(await import("../src/bridge/runtime.js"), "findBridgeObservation").mockResolvedValue({
      state: "healthy",
      runtime: {
        service: "codex-with-chatgpt", version: "t", workspaceId: workspace.id, workspaceRoot: wsRoot,
        pid: 12345, port: 48100, adminToken: "t", publicUrl: null,
        startedAt: "2026-09-13T00:00:00.000Z", runtimeBuildId: oldId,
      },
    } as never);
    const j = scheduled.ok ? scheduled.job : job();
    const attempt = await runFinalizerAttempt(j, stateDir, {
      inspect: async () => ({ runtimeStatus: "idle" } as never),
      rollout: async () => ({ targetBuildId: newId, workspaces: [{ workspaceId: workspace.id, status: "upgraded" }] }),
    });
    expect(attempt.kind).toBe("terminal");
    if (attempt.kind !== "terminal") return;
    expect(attempt.result.status).toBe("ok");
    const committed = commitFinalizerResult(stateDir, j, { ...attempt.result, startedAt: new Date().toISOString() });
    expect(committed.status).toBe("ok");
    expect(readActiveFinalizer(stateDir, workspace.id)).toBeNull();
    const graph = collectReleaseReferences(stateDir);
    expect([...graph.references.values()].flat().some(r => r.kind === "finalizer")).toBe(false);
  });
});


describe("cleanup failure strictness", () => {
  it("active unlink failure 抛 FINALIZER_ACTIVE_RELEASE_FAILED 且 result 可读", () => {
    const { newId } = installTwo();
    const j = job({ targetBuildId: newId });
    const file = activeFinalizerPath(stateDir, workspace.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(j));
    const realUnlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
      if (String(target) === file) throw new Error("simulated unlink failure");
      return realUnlink(target as fs.PathLike);
    });
    let thrown: unknown;
    try {
      commitFinalizerResult(stateDir, j, {
        status: "ok", reason: "already_converged",
        scheduledAt: j.createdAt, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      thrown = error;
    }
    vi.restoreAllMocks();
    expect(thrown).toBeInstanceOf(FinalizerActiveReleaseError);
    expect((thrown as FinalizerActiveReleaseError).result.reason).toBe("already_converged");
    expect(readFinalizerResult(stateDir, workspace.id)?.reason).toBe("already_converged");
    expect(fs.existsSync(file)).toBe(true);
  });

  it("worker claim release mismatch 仍可观察 failure", () => {
    const j = job();
    const file = activeFinalizerPath(stateDir, workspace.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(j));
    const claim = claimFinalizerWorker(stateDir, j);
    expect(releaseFinalizerWorkerClaim(stateDir, j, { ...claim, workerToken: randomUUID() })).toBe(false);
    fs.unlinkSync(workerClaimPath(stateDir, workspace.id));
  });
});

describe("strict finalizer reference identity", () => {
  it("workspaceRoot 对应错误 workspaceId → finalizer_corrupt", () => {
    const other = new Workspace(makeTmpDir("ptf-other-ws"));
    const j = job({ workspaceId: other.id });
    const file = activeFinalizerPath(stateDir, workspace.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(j));
    const graph = collectReleaseReferences(stateDir);
    expect(graph.ok).toBe(false);
    expect(graph.issues.some(i => i.code === "finalizer_corrupt")).toBe(true);
    expect(planGc(stateDir).totals.bytesCandidateReclaimable).toBe(0);
  });

  it("dangling finalizer target → global block；result alone 不产生引用", () => {
    const j = job({ targetBuildId: "e".repeat(64) });
    const file = activeFinalizerPath(stateDir, workspace.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(j));
    const plan = planGc(stateDir);
    expect(plan.ok).toBe(false);
    expect(plan.totals.bytesCandidateReclaimable).toBe(0);

    fs.unlinkSync(file);
    const resultFile = path.join(stateDir, "post-turn-finalizer-results", `${workspace.id}.json`);
    fs.mkdirSync(path.dirname(resultFile), { recursive: true });
    fs.writeFileSync(resultFile, JSON.stringify({
      version: 1, jobId: j.jobId, workspaceId: workspace.id, targetBuildId: "e".repeat(64),
      status: "ok", reason: "already_converged",
      scheduledAt: j.createdAt, startedAt: j.createdAt, finishedAt: j.createdAt,
    }));
    const graph = collectReleaseReferences(stateDir);
    expect([...graph.references.values()].flat().some(r => r.kind === "finalizer")).toBe(false);
  });
});


describe("real rollout integration", () => {
  it("rollout busy schedules worker once；second existing 不 spawn；idle upgraded → ok", async () => {
    const { oldId, newId } = installTwo();
    writeDesktopBinding();
    const startedAt = "2026-09-13T00:00:00.000Z";
    const runtime = {
      service: "c2c-bridge", version: "t", workspaceId: workspace.id, workspaceRoot: wsRoot,
      pid: 4242, port: 48200, adminToken: "t", publicUrl: null, startedAt, runtimeBuildId: oldId,
    };
    write(stateDir, path.join("runtime", `${workspace.id}.json`), JSON.stringify(runtime));
    vi.spyOn(await import("../src/build-id.js"), "getRuntimeBuildId").mockReturnValue(newId);
    vi.spyOn(installModule, "readCurrentInstall").mockReturnValue({
      version: 3, checkoutRoot: wsRoot, releaseRoot: path.join(stateDir, "releases", newId),
      runtimeBuildId: newId, artifactSha256: "a".repeat(64), manifestSha256: "b".repeat(64),
      installedAt: startedAt,
    } as never);
    vi.spyOn(runtimeModule, "findBridgeObservation").mockResolvedValue({ state: "healthy", runtime } as never);
    vi.spyOn(runtimeModule, "adminFetch").mockResolvedValue({
      service: "c2c-bridge", workspaceId: workspace.id, workspaceName: "w", workspaceRoot: wsRoot,
      pid: runtime.pid, startedAt, port: runtime.port, runtimeBuildId: oldId,
      publicUrl: null, tunnel: { running: false, url: null, provider: "cloudflare-named" },
      tokenCount: 0, pairingActive: false,
    } as never);
    vi.spyOn(daemon, "restartBridge").mockResolvedValue({
      runtime: { ...runtime, runtimeBuildId: newId }, info: { runtimeBuildId: newId } as never, mcpUrl: "https://x/mcp",
    });
    vi.spyOn(desktopIpc, "inspect").mockRejectedValue(Object.assign(new Error("busy"), { code: "DESKTOP_BUSY" }));
    const currentExecution = vi.spyOn(desktopIpc, "currentExecution").mockResolvedValueOnce({
      threadId: THREAD, hostId: "local", projectId: "proj-finalizer",
      workspaceRoot: wsRoot, title: "当前执行会话", cwd: wsRoot,
      runtimeStatus: "active", activeTurnId: randomUUID(),
    } as never);
    currentExecution.mockRejectedValueOnce(Object.assign(new Error("unavailable"), { code: "DESKTOP_STATE_UNAVAILABLE" }));

    let spawnCount = 0;
    const finalizerSpawnImpl = (() => {
      spawnCount += 1;
      return { pid: 7, unref() {} };
    }) as never;

    const summary = await rollout({ workspaceRoot: wsRoot, finalizerSpawnImpl });
    const item = summary.workspaces.find(w => w.workspaceId === workspace.id)!;
    expect(item.status).toBe("pending_busy");
    expect(item.reason).toBe("busy");
    expect(item.finalizer?.status).toBe("scheduled");
    expect(spawnCount).toBe(1);
    expect(currentExecution).toHaveBeenCalledTimes(1);
    expect(daemon.restartBridge).not.toHaveBeenCalled();
    expect(readActiveFinalizer(stateDir, workspace.id)).toBeTruthy();

    currentExecution.mockReset().mockResolvedValue({
      threadId: THREAD, hostId: "local", projectId: "proj-finalizer",
      workspaceRoot: wsRoot, title: "当前执行会话", cwd: wsRoot,
      runtimeStatus: "active", activeTurnId: randomUUID(),
    } as never);
    const summary2 = await rollout({ workspaceRoot: wsRoot, finalizerSpawnImpl });
    const item2 = summary2.workspaces.find(w => w.workspaceId === workspace.id)!;
    expect(item2.finalizer?.status).toBe("existing");
    expect(spawnCount).toBe(1);

    const active = readActiveFinalizer(stateDir, workspace.id)!;
    write(stateDir, path.join("runtime-upgrades", `${workspace.id}.json`), JSON.stringify({
      workspaceId: workspace.id, workspaceRoot: wsRoot, targetBuildId: newId, reason: "busy",
      updatedAt: new Date().toISOString(),
    }));
    const workerRollout = vi.fn(async () => ({ targetBuildId: newId, workspaces: [{ workspaceId: workspace.id, status: "upgraded" as const }] }));
    const waiting = await runFinalizerAttempt(active, stateDir, {
      inspect: async () => { throw Object.assign(new Error("busy"), { code: "DESKTOP_BUSY" }); },
      rollout: workerRollout,
    });
    expect(waiting).toEqual({ kind: "wait", reason: "origin_still_active" });
    expect(readFinalizerResult(stateDir, workspace.id)).toBeNull();
    expect(readActiveFinalizer(stateDir, workspace.id)?.jobId).toBe(active.jobId);
    expect(workerRollout).not.toHaveBeenCalled();
    const attempt = await runFinalizerAttempt(active, stateDir, {
      inspect: async () => ({ runtimeStatus: "idle" } as never),
      rollout: workerRollout,
    });
    expect(attempt.kind).toBe("terminal");
    if (attempt.kind !== "terminal") return;
    expect(attempt.result.status).toBe("ok");
    const committed = commitFinalizerResult(stateDir, active, { ...attempt.result, startedAt: new Date().toISOString() });
    expect(committed.status).toBe("ok");
    expect(readActiveFinalizer(stateDir, workspace.id)).toBeNull();
  }, 60000);
});
