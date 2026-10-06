import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { probeProcess, unknownProcessProbe } from "../src/process/process-probe.js";
import { resolveDaemonSpawnHelperPath, resolveDaemonSpawnPython } from "../src/process/daemon-spawn.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectedTests, hashFile, identifyRunner, machineLeaks, treeSnapshot, validateCoverage, validateInventory, validateReport } from "../scripts/test-full-candidate.mjs";
import { cleanupStrict, fixtureProcessIdentity, stopFixtureProcess, waitForFixtureChildExit } from "./strict-teardown.js";
import { makeTmpDir, write } from "./helpers.js";

const dirs: string[] = [];
function tmp() { const dir = makeTmpDir("candidate-runner"); dirs.push(dir); return dir; }
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await cleanupStrict(...dirs.splice(0)); });
const manifest = () => JSON.parse(fs.readFileSync("scripts/test-full-candidate-manifest.json", "utf8"));

describe("experimental full partition guards", () => {
  it("exhaustively classifies the current suite with an exclusive writer and OS serial fence", () => {
    const groups = validateInventory(process.cwd(), manifest());
    expect(groups.packaging).toEqual(["tests/desktop-helper-packaging.test.ts"]);
    expect(groups.serial).toEqual(["bridge-parent-death", "daemon-parent-death", "daemon-spawn", "runtime", "web-control-cli", "windows-process"].map(name => `tests/${name}.test.ts`));
    expect(groups.parallel).toHaveLength(157);
    expect(Object.values(groups).flat()).toHaveLength(164);
    expect(expectedTests).toBe(3435);
    expect(() => validateCoverage(164, 3435, 164)).not.toThrow();
    for (const [files, tests] of [[163, 3435], [165, 3435], [164, 3200], [164, 3434], [164, 3436]]) {
      expect(() => validateCoverage(files, tests, 164)).toThrow("coverage");
    }
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    expect(pkg.scripts.test).toBe("vitest run");
    expect(pkg.scripts["test:full:candidate"]).toBe("node scripts/test-full-candidate.mjs");
  });
  it.each(["missing", "duplicate", "new"])("rejects %s classification", kind => {
    const value = manifest();
    if (kind === "missing") value.files.pop();
    if (kind === "duplicate") value.files.push(value.files[0]);
    if (kind === "new") value.files.push({ ...value.files[0], file: "tests/unclassified.test.ts" });
    expect(() => validateInventory(process.cwd(), value)).toThrow("classification");
  });
  it("changed tests/shared helper scripts require explicit reaudit; a new writer cannot silently join parallel", () => {
    for (const kind of ["test", "support", "writer", "serial"]) {
      const value = manifest();
      if (kind === "test") value.files[0].sha256 = "0".repeat(64);
      if (kind === "support") value.support["tests/helpers.ts"] = "0".repeat(64);
      if (kind === "writer") value.files.find(entry => entry.group === "parallel").dist = "write";
      if (kind === "serial") value.files.find(entry => entry.file === "tests/runtime.test.ts").group = "parallel";
      expect(() => validateInventory(process.cwd(), value)).toThrow();
    }
  });
  it("counts actual files/cases; missing/duplicate/extra execution and skipped/error results fail", () => {
    const good = { reason: "passed", errors: 0, files: [{ file: "tests/a.test.ts", state: "passed", tests: [{ state: "passed" }, { state: "passed" }] }] };
    expect(validateReport(good, ["tests/a.test.ts"])).toBe(2);
    expect(() => validateReport(good, [])).toThrow();
    expect(() => validateReport({ ...good, files: [...good.files, ...good.files] }, ["tests/a.test.ts"])).toThrow();
    expect(() => validateReport({ ...good, errors: 1 }, ["tests/a.test.ts"])).toThrow();
    for (const state of ["skipped", "pending", "failed"]) {
      expect(() => validateReport({ ...good, files: [{ ...good.files[0], tests: [{ state }] }] }, ["tests/a.test.ts"])).toThrow();
    }
  });
  it("dist fingerprint includes publication ID, every artifact and empty directories", () => {
    const dir = tmp(); write(dir, "build-id.txt", "id"); write(dir, "browser-companion/content.js", "one");
    const original = treeSnapshot(dir);
    expect(treeSnapshot(dir)).toEqual(original);
    write(dir, "browser-companion/content.js", "two"); expect(treeSnapshot(dir)).not.toEqual(original);
    write(dir, "browser-companion/content.js", "one"); write(dir, "build-id.txt", "other"); expect(treeSnapshot(dir)).not.toEqual(original);
    write(dir, "build-id.txt", "id"); fs.mkdirSync(path.join(dir, "extra")); expect(treeSnapshot(dir)).not.toEqual(original);
    expect(hashFile(path.join(dir, "build-id.txt"))).toMatch(/^[a-f0-9]{64}$/);
  });
  it("process audit distinguishes existing/PID reuse/new fixture processes and their listeners", () => {
    const proc = (pid: number, parent: number, second: number, name = "node.exe") => ({
      ProcessId: pid, ParentProcessId: parent, Name: name,
      Created: `2026-10-03T00:00:${String(second).padStart(2, "0")}.0000000Z`,
    });
    const runner = proc(10, 1, 10), unrelated = proc(20, 1, 5, "arbitrary.exe");
    const before = { processes: [runner, unrelated], listeners: [] };
    const audit = (processes: ReturnType<typeof proc>[], owner?: number) => machineLeaks(before,
      { processes, listeners: owner === undefined ? [] : [{ OwningProcess: owner, LocalPort: 123 }] }, 10);
    expect(identifyRunner(before, 10)).toEqual({ ProcessId: 10, Created: runner.Created });
    expect(audit(before.processes)).toMatchObject({ processes: [], listeners: [], globalNewProcessCount: 0 });
    const child = proc(11, 10, 11), grandchild = proc(12, 11, 12);
    expect(audit([...before.processes, child], 11)).toMatchObject({
      processes: [child], listeners: [{ OwningProcess: 11, LocalPort: 123 }], attributedProcessCount: 1, ambiguousProcessCount: 0,
    });
    expect(audit([...before.processes, grandchild, child])).toMatchObject({ processes: [grandchild, child], attributedProcessCount: 2 });
    const otherChild = proc(21, 20, 11), otherGrandchild = proc(22, 21, 12);
    expect(audit([...before.processes, otherChild, otherGrandchild], 22)).toMatchObject({
      processes: [], listeners: [], globalNewProcessCount: 2, unrelatedProcessCount: 2,
    });
    const missing = proc(31, 99, 13);
    expect(audit([...before.processes, missing], 31)).toMatchObject({
      processes: [missing], ambiguousProcessCount: 1, listeners: [{ OwningProcess: 31, LocalPort: 123 }],
    });
    // A disappeared pre-run parent alone cannot prove it owned a later child.
    expect(audit([runner, otherChild])).toMatchObject({ processes: [otherChild], ambiguousProcessCount: 1 });
    const reused = proc(20, 1, 15, "arbitrary.exe");
    expect(audit([runner, reused, otherChild])).toMatchObject({ processes: [otherChild], ambiguousProcessCount: 1 });
    const laterBy100ns = { ...unrelated, Created: otherChild.Created.replace("0000000Z", "0000001Z") };
    expect(audit([runner, laterBy100ns, otherChild])).toMatchObject({ processes: [otherChild], ambiguousProcessCount: 1 });
    const reusedRunner = proc(10, 1, 15);
    expect(audit([reusedRunner, unrelated], 10)).toMatchObject({
      processes: [reusedRunner], listeners: [{ OwningProcess: 10, LocalPort: 123 }], ambiguousProcessCount: 1,
    });
    expect(audit([...before.processes, { ...unrelated }, otherChild])).toMatchObject({ processes: [otherChild], ambiguousProcessCount: 1 });
    const cycleA = proc(41, 42, 13), cycleB = proc(42, 41, 13);
    expect(audit([...before.processes, cycleA, cycleB])).toMatchObject({ processes: [cycleA, cycleB], ambiguousProcessCount: 2 });
    for (const processes of [[], [runner, runner], [{ ...runner, Created: "unknown" }]]) {
      expect(() => identifyRunner({ processes, listeners: [] }, 10)).toThrow("runner exact identity");
      expect(() => machineLeaks({ processes, listeners: [] }, before, 10)).toThrow("runner exact identity");
    }
  });
});

describe("strict fixture teardown", () => {
  it("deletes every explicitly tracked directory, including multiple auth/state directories", async () => {
    const a = tmp(), b = tmp(); write(a, "state", "x"); write(b, "auth", "x");
    await cleanupStrict(a, b);
    expect(fs.existsSync(a)).toBe(false); expect(fs.existsSync(b)).toBe(false);
  });
  it("refuses containment escape and link roots", async () => {
    await expect(cleanupStrict(process.cwd())).rejects.toThrow("outside");
    const parent = tmp(), target = tmp(); const link = path.join(parent, "link");
    fs.symlinkSync(target, link, "junction");
    try { await expect(cleanupStrict(link)).rejects.toThrow("link"); }
    finally { fs.unlinkSync(link); }
    expect(fs.existsSync(target)).toBe(true);
  });
  it("persistent sharing failure is surfaced with finite native retry options", async () => {
    const dir = tmp();
    const failure = Object.assign(new Error("persistent fixture holder"), { code: "EBUSY" });
    const remove = vi.spyOn(fs.promises, "rm").mockRejectedValue(failure);
    await expect(cleanupStrict(dir)).rejects.toBe(failure);
    expect(remove).toHaveBeenCalledExactlyOnceWith(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  it("unknown spawn evidence and current runner never acquire teardown authority", async () => {
    const evidence = unknownProcessProbe(99999999);
    expect(() => fixtureProcessIdentity(evidence)).toThrow("unknown");
    expect(() => fixtureProcessIdentity({ ...evidence, pid: process.pid })).toThrow("invalid");
    await expect(stopFixtureProcess({ pid: process.pid, creationTime: "1", executable: process.execPath })).rejects.toThrow("invalid");
    const kill = vi.spyOn(process, "kill");
    expect(() => fixtureProcessIdentity({ ...evidence, status: "missing" })).toThrow("unknown");
    const missing = fixtureProcessIdentity({ ...evidence, status: "missing", errors: { ...evidence.errors, process: "PID_MISSING" } });
    expect(missing).toBeNull();
    await stopFixtureProcess(missing);
    expect(kill).not.toHaveBeenCalled();
  });
  it("exact HANDLE regression: reuse, mismatch, permission ambiguity and bounded waits", () => {
    const run = spawnSync(resolveDaemonSpawnPython(), ["-I", "-B", "-X", "utf8", "tests/fixture_process_teardown_test.py"],
      { windowsHide: true, encoding: "utf8", timeout: 10_000 });
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr + run.stdout).toBe(0);
    expect(run.stderr).toContain("Ran 14 tests");
  });
  it("terminates a real identified fixture and observes its own ChildProcess exit", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
    const exited = waitForFixtureChildExit(child);
    void exited.catch(() => {});
    const identity = fixtureProcessIdentity(await probeProcess(child.pid!, resolveDaemonSpawnPython(), resolveDaemonSpawnHelperPath()));
    expect(identity).not.toBeNull();
    await stopFixtureProcess(identity);
    await exited;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
  it.each(["exit", "error", "timeout"])("ChildProcess %s releases timer and listeners without PID kill", async kind => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) as ChildProcess;
    const kill = vi.spyOn(process, "kill");
    const waiting = waitForFixtureChildExit(child, 100);
    const observed = kind === "exit" ? expect(waiting).resolves.toBeUndefined() : expect(waiting).rejects.toThrow();
    if (kind === "exit") child.emit("exit", 0);
    if (kind === "error") child.emit("error", new Error("fixture spawn failed"));
    if (kind === "timeout") await vi.advanceTimersByTimeAsync(100);
    await observed;
    expect(vi.getTimerCount()).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });
});
