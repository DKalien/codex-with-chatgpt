import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { assessRolloutIdle, currentCodexThread } from "../src/core/rollout-idle.js";
import {
  activeFinalizerPath,
  finalizerRetirementPath,
  retireLegacyFinalizers,
  readFinalizerRetirement,
  readActiveFinalizer,
  readFinalizerResult,
  workerClaimPath,
  type ActiveFinalizer,
} from "../src/core/post-turn-finalizer.js";
import * as finalizerModule from "../src/core/post-turn-finalizer.js";
import { tryAcquireMaintenanceLock } from "../src/core/maintenance-lock.js";
import { registerPostTurnFinalizerCommands } from "../src/cli/post-turn-finalizer.js";
import { collectReleaseReferences } from "../src/core/release-references.js";
import { planGc } from "../src/core/gc-plan.js";
import { desktopIpc } from "../src/desktop/ipc.js";
import { desktopFile } from "../src/desktop/store.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

let stateDir: string;
let wsRoot: string;
let workspace: Workspace;
const THREAD = "01a00000-0000-7000-8000-000000000011";
const runtimeFence = {
  desktopPid: 1001,
  desktopExe: "C:\\Program Files\\ChatGPT\\ChatGPT.exe",
  desktopCreation: "1000001",
  appServerPid: 1002,
  appServerExe: "C:\\Program Files\\ChatGPT\\codex.exe",
  appServerCreation: "1000002",
};

function writeDesktopBinding(threadId = THREAD): void {
  const file = desktopFile(workspace.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1, workspaceId: workspace.id, workspaceRoot: workspace.root, revision: 1, enabled: true,
    runtimeFence,
    binding: { threadId, hostId: "local", projectId: "proj-finalizer", bindingId: randomUUID(), title: "B", boundAt: "2026-09-13T00:00:00.000Z" },
    deliveries: [],
  }));
  fs.writeFileSync(`${file}.initialized`, "1\n");
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

describe("strict legacy reads", () => {
  it("corrupt / extra field / symlink active fail closed", () => {
    const file = activeFinalizerPath(stateDir, workspace.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const raw of ["{broken}", JSON.stringify({ ...job(), extra: 1 })]) {
      fs.writeFileSync(file, raw);
      expect(() => readActiveFinalizer(stateDir, workspace.id)).toThrow();
      expect(collectReleaseReferences(stateDir).ok).toBe(false);
    }
    const target = path.join(wsRoot, "outside.json");
    fs.writeFileSync(target, JSON.stringify(job()));
    fs.unlinkSync(file);
    fs.symlinkSync(target, file);
    expect(() => readActiveFinalizer(stateDir, workspace.id)).toThrow();
  });
  it("corrupt result throws", () => {
    write(stateDir, path.join("post-turn-finalizer-results", `${workspace.id}.json`), "{bad}");
    expect(() => readFinalizerResult(stateDir, workspace.id)).toThrow();
  });
});

describe("strict finalizer reference identity", () => {
  it("workspaceRoot 对应错误 workspaceId → finalizer_corrupt", () => {
    const otherId = "f".repeat(12);
    const j = job({ workspaceId: otherId });
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
describe("retired CLI", () => {
  it("status 只读历史 active/result 并显示 retired", async () => {
    const j = job();
    const activeFile = activeFinalizerPath(stateDir, workspace.id);
    write(stateDir, path.relative(stateDir, activeFile), JSON.stringify(j));
    const result = {
      version: 1, jobId: j.jobId, workspaceId: workspace.id, targetBuildId: j.targetBuildId,
      status: "blocked", reason: "legacy", scheduledAt: j.createdAt,
      startedAt: j.createdAt, finishedAt: j.createdAt,
    };
    const resultFile = path.join(stateDir, "post-turn-finalizer-results", `${workspace.id}.json`);
    write(stateDir, path.relative(stateDir, resultFile), JSON.stringify(result));
    const output: string[] = [];
    const writeOut = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    const cli = new Command();
    registerPostTurnFinalizerCommands(cli);
    await cli.parseAsync(["node", "test", "post-turn-finalizer", "status", "-w", wsRoot]);
    writeOut.mockRestore();
    expect(JSON.parse(output.join("")).mode).toBe("retired");
    expect(readActiveFinalizer(stateDir, workspace.id)).toEqual(j);
    expect(readFinalizerResult(stateDir, workspace.id)).toEqual(result);
  });

  it("run 只读旧状态并明确拒绝，不 claim 或删除文件", async () => {
    const j = job();
    const activeFile = activeFinalizerPath(stateDir, workspace.id);
    const resultFile = path.join(stateDir, "post-turn-finalizer-results", `${workspace.id}.json`);
    const claimFile = workerClaimPath(stateDir, workspace.id);
    const result = {
      version: 1, jobId: j.jobId, workspaceId: workspace.id, targetBuildId: j.targetBuildId,
      status: "blocked", reason: "legacy", scheduledAt: j.createdAt,
      startedAt: j.createdAt, finishedAt: j.createdAt,
    };
    write(stateDir, path.relative(stateDir, activeFile), JSON.stringify(j));
    write(stateDir, path.relative(stateDir, resultFile), JSON.stringify(result));
    write(stateDir, path.relative(stateDir, claimFile), "legacy-claim");
    const before = [activeFile, resultFile, claimFile].map(file => fs.readFileSync(file));
    const writeOut = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const cli = new Command();
    registerPostTurnFinalizerCommands(cli);
    process.exitCode = 0;
    await cli.parseAsync(["node", "test", "post-turn-finalizer", "run", "-w", wsRoot]);
    writeOut.mockRestore();
    expect(process.exitCode).toBe(1);
    [activeFile, resultFile, claimFile].forEach((file, index) => expect(fs.readFileSync(file)).toEqual(before[index]));
    process.exitCode = 0;
  });
});


describe("legacy retirement", () => {
  const dead = () => { throw Object.assign(new Error("dead"), { code: "ESRCH" }); };
  function legacy(expired = true) {
    const j = job({ expiresAt: new Date(Date.now() + (expired ? -60000 : 60000)).toISOString() });
    const claim = { version: 1, jobId: j.jobId, jobToken: j.token, workerToken: randomUUID(), pid: 987654, claimedAt: j.createdAt };
    write(stateDir, path.relative(stateDir, activeFinalizerPath(stateDir, workspace.id)), JSON.stringify(j));
    write(stateDir, path.relative(stateDir, workerClaimPath(stateDir, workspace.id)), JSON.stringify(claim));
    return { j, claim };
  }
  function retire(options: Parameters<typeof retireLegacyFinalizers>[2] = { probeProcess: dead }) {
    const lock = tryAcquireMaintenanceLock(stateDir, "test-retirement");
    if (!lock.ok) throw new Error("test lock busy");
    try { return retireLegacyFinalizers(stateDir, lock.handle, options); }
    finally { lock.handle.release(); }
  }
  it("production surface exposes no legacy mutation helpers", () => {
    for (const key of ["schedulePostTurnFinalizer", "spawnFinalizerWorker", "runFinalizerAttempt", "claimFinalizerWorker", "commitFinalizerResult", "verifyFinalizerPreconditions", "projectFinalizerExecution"])
      expect(key in finalizerModule).toBe(false);
  });
  it("expired exact dead claim retires, keeps result and permanent wx fence", () => {
    const { j, claim } = legacy();
    const resultFile = path.join(stateDir, "post-turn-finalizer-results", `${workspace.id}.json`);
    write(stateDir, path.relative(stateDir, resultFile), "historical evidence");
    expect(retire()).toEqual([j]);
    expect(readActiveFinalizer(stateDir, workspace.id)).toBeNull();
    expect(readFinalizerRetirement(stateDir, workspace.id)).toMatchObject({ active: j, claim });
    expect(JSON.parse(fs.readFileSync(workerClaimPath(stateDir, workspace.id), "utf8"))).toEqual(claim);
    expect(() => fs.openSync(workerClaimPath(stateDir, workspace.id), "wx")).toThrow();
    expect(fs.readFileSync(resultFile, "utf8")).toBe("historical evidence");
    expect(retire()).toEqual([]);
  });
  it.each(["alive", "EPERM", "unknown", "missing", "nonexpired"])("%s remains pinned without ledger", mode => {
    const { j } = legacy(mode !== "nonexpired");
    if (mode === "missing") fs.unlinkSync(workerClaimPath(stateDir, workspace.id));
    const probeProcess = mode === "alive" ? () => {} : mode === "EPERM" ? () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); } : mode === "unknown" ? () => { throw new Error("unknown"); } : dead;
    expect(retire({ probeProcess })).toEqual([]);
    expect(readActiveFinalizer(stateDir, workspace.id)).toEqual(j);
    expect(readFinalizerRetirement(stateDir, workspace.id)).toBeNull();
  });
  it.each(["beforeLedger", "afterLedger", "beforeActiveRemoval"] as const)("crash at %s preserves pin and retry evidence", stage => {
    const { j, claim } = legacy();
    expect(() => retire({ probeProcess: dead, hooks: { [stage]: () => { throw new Error("crash"); } } })).toThrow("crash");
    expect(readActiveFinalizer(stateDir, workspace.id)).toEqual(j);
    expect(JSON.parse(fs.readFileSync(workerClaimPath(stateDir, workspace.id), "utf8"))).toEqual(claim);
    expect(Boolean(readFinalizerRetirement(stateDir, workspace.id))).toBe(stage !== "beforeLedger");
    expect(retire()).toEqual([j]);
    expect(readFinalizerRetirement(stateDir, workspace.id)).not.toBeNull();
  });
  it.each(["jobId", "jobToken"] as const)("claim exact %s mismatch refuses retirement", field => {
    const { j, claim } = legacy();
    write(stateDir, path.relative(stateDir, workerClaimPath(stateDir, workspace.id)), JSON.stringify({ ...claim, [field]: randomUUID() }));
    expect(() => retire()).toThrow();
    expect(readActiveFinalizer(stateDir, workspace.id)).toEqual(j);
  });
  it.each(["active", "claim"] as const)("%s replacement after ledger fails closed", kind => {
    const { j } = legacy();
    const file = kind === "active" ? activeFinalizerPath(stateDir, workspace.id) : workerClaimPath(stateDir, workspace.id);
    expect(() => retire({ probeProcess: dead, hooks: { afterLedger() {
      const content = fs.readFileSync(file); fs.renameSync(file, path.join(wsRoot, "original-evidence")); fs.writeFileSync(file, content);
    } } })).toThrow();
    expect(readActiveFinalizer(stateDir, workspace.id)).toEqual(j);
    expect(() => readFinalizerRetirement(stateDir, workspace.id)).toThrow();
    expect(JSON.parse(fs.readFileSync(finalizerRetirementPath(stateDir, workspace.id), "utf8"))).toMatchObject({ active: j });
  });
  it("corrupt or symlink claim fails closed", () => {
    const { j } = legacy();
    const file = workerClaimPath(stateDir, workspace.id);
    fs.writeFileSync(file, "{bad}");
    expect(() => retire()).toThrow();
    fs.unlinkSync(file);
    const target = path.join(wsRoot, "claim.json"); fs.writeFileSync(target, "{}"); fs.symlinkSync(target, file);
    expect(() => retire()).toThrow();
    expect(readActiveFinalizer(stateDir, workspace.id)).toEqual(j);
  });
  it("corrupt ledger preserves active and prevents retry mutation", () => {
    const { j } = legacy();
    expect(() => retire({ probeProcess: dead, hooks: { afterLedger() { throw new Error("crash"); } } })).toThrow();
    fs.writeFileSync(finalizerRetirementPath(stateDir, workspace.id), "{bad}");
    expect(() => retire()).toThrow();
    expect(readActiveFinalizer(stateDir, workspace.id)).toEqual(j);
    expect(collectReleaseReferences(stateDir).ok).toBe(false);
  });

  it.each(["ledger", "claim"])("retired %s disappearance blocks all reference plans", kind => {
    legacy(); retire();
    fs.unlinkSync(kind === "ledger" ? finalizerRetirementPath(stateDir, workspace.id) : workerClaimPath(stateDir, workspace.id));
    expect(collectReleaseReferences(stateDir).ok).toBe(false);
    expect(planGc(stateDir).ok).toBe(false);
  });

  it("default probe only uses signal 0; reused live PID keeps pin", () => {
    const { j } = legacy();
    const probe = vi.spyOn(process, "kill").mockReturnValue(true);
    expect(retire({})).toEqual([]);
    expect(probe).toHaveBeenCalledWith(987654, 0);
    expect(probe.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    expect(readActiveFinalizer(stateDir, workspace.id)).toEqual(j);
  });
  it.each(["afterLedger", "beforeActiveRemoval"] as const)("ledger replacement at %s preserves pin", stage => {
    const { j } = legacy();
    expect(() => retire({ probeProcess: dead, hooks: { [stage]: () => {
      const file = finalizerRetirementPath(stateDir, workspace.id);
      const content = fs.readFileSync(file); fs.renameSync(file, path.join(wsRoot, "ledger-evidence")); fs.writeFileSync(file, content);
    } } })).toThrow();
    expect(readActiveFinalizer(stateDir, workspace.id)).toEqual(j);
    expect(fs.existsSync(workerClaimPath(stateDir, workspace.id))).toBe(true);
  });

});
