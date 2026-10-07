import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";
import * as childProcess from "node:child_process";

vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFileSync: vi.fn(original.execFileSync) };
});
import {
  acquireSupervisorLease,
  hasSupervisorState,
  readSupervisorLaunch,
  readSupervisorConfig,
  readSupervisorRuntime,
  supervisorConfigFile,
  supervisorLeaseFile,
  supervisorOperationLockFile,
  supervisorRuntimeFile,
  updateSupervisorConfig,
  withSupervisorOperation,
  withSupervisorLaunch,
  SupervisorStoreError,
  type SupervisorStoreOptions,
} from "../src/supervisor/store.js";
import { Workspace } from "../src/workspace/manager.js";
import { makeTmpDir } from "./helpers.js";
import { finishSupervisorFixtures, observeSupervisorAclCall, type SupervisorAclCall } from "./supervisor-acl-support.js";
import { validateSupervisorLaunch } from "../src/supervisor/run.js";
import { runSupervisorLoop } from "../src/supervisor/lifecycle.js";

const roots: string[] = [];
const aclCalls: SupervisorAclCall[] = [];
let stateDir: string;
let workspaceRoot: string;
let workspace: Workspace;
let options: SupervisorStoreOptions;

function processResult(pid: number, status: "identified" | "missing" | "unknown", creationTime?: string, error?: string) {
  const identified = status === "identified";
  return {
    pid,
    status,
    executable: identified ? process.execPath : null,
    creationTime: identified ? creationTime ?? "fixture-creation:1" : null,
    inAnyJob: identified ? false : null,
    errors: {
      process: identified ? null : error ?? (status === "missing" ? "PID_MISSING" : "PROBE_UNAVAILABLE"),
      executable: identified ? null : "PROBE_UNAVAILABLE",
      creationTime: identified ? null : "PROBE_UNAVAILABLE",
      inAnyJob: identified ? null : "PROBE_UNAVAILABLE",
    },
    observedAt: new Date().toISOString(),
  } as const;
}

function fakeProbe(missing = new Set<number>(), unknown = new Set<number>()) {
  return async (pid: number, expected?: string) => {
    if (pid === process.pid) {
      if (expected && expected !== "fixture-creation:1") return processResult(pid, "unknown", undefined, "IDENTITY_CHANGED");
      return processResult(pid, "identified", "fixture-creation:1");
    }
    if (missing.has(pid)) return processResult(pid, "missing");
    if (unknown.has(pid) || expected) return processResult(pid, "unknown", undefined, "IDENTITY_CHANGED");
    return processResult(pid, "unknown");
  };
}

function optionsWithProbe(probe = fakeProbe()): SupervisorStoreOptions {
  return { stateDir, probeProcess: probe };
}

async function createConfig(desiredState: "running" | "stopped" = "running") {
  return updateSupervisorConfig(workspaceRoot, { desiredState, tunnel: true }, options);
}

function seedLock(file: string, kind: "operation" | "supervisor", identity: { pid: number; creationTime?: string; nonce?: string }) {
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    kind,
    pid: identity.pid,
    creationTime: identity.creationTime ?? "dead-owner:123",
    executable: process.execPath,
    nonce: identity.nonce ?? randomUUID(),
  }), { mode: 0o600 });
}

beforeEach(async () => {
  stateDir = makeTmpDir("supervisor-state"); roots.push(stateDir);
  workspaceRoot = makeTmpDir("supervisor-workspace"); roots.push(workspaceRoot);
  workspace = new Workspace(workspaceRoot);
  options = optionsWithProbe();
  aclCalls.length = 0;
  const { execFileSync: execute } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  vi.mocked(childProcess.execFileSync).mockImplementation(observeSupervisorAclCall(aclCalls, execute));
});

afterEach(async ({ task }) => {
  vi.restoreAllMocks();
  const evidence = await finishSupervisorFixtures(task.result?.state === "fail", task.name, roots.splice(0), aclCalls, task.result?.errors);
  if (evidence) console.error(`supervisor failed fixture evidence: ${evidence}`);
});

describe("supervisor durable config", () => {
  it("pristine presence detection creates nothing and rejects orphan/linked evidence", () => {
    expect(hasSupervisorState(workspaceRoot, stateDir)).toBe(false);
    expect(fs.readdirSync(stateDir)).toEqual([]);
    const folder = path.dirname(supervisorConfigFile(workspace.id, stateDir));
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, `${workspace.id.toUpperCase()}.interrupted.tmp`), "partial");
    expect(hasSupervisorState(workspaceRoot, stateDir)).toBe(true);
  });
  it("read of missing config is read-only and operation preserves absence", async () => {
    const missingState = path.join(stateDir, "not-created");
    expect(readSupervisorConfig(workspaceRoot, { stateDir: missingState })).toBeNull();
    expect(fs.existsSync(missingState)).toBe(false);
    const missingOptions = { ...options, stateDir: missingState };
    await expect(withSupervisorOperation(workspaceRoot, operation => operation.readConfig(), missingOptions)).resolves.toBeNull();
    expect(fs.existsSync(supervisorConfigFile(workspace.id, missingState))).toBe(false);
  });

  it("updates are strict and revisioned while preserving the tunnel preference", async () => {
    const first = await createConfig("running");
    const second = await updateSupervisorConfig(workspaceRoot, { desiredState: "stopped" }, options);
    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(second).toMatchObject({ desiredState: "stopped", tunnel: true, workspaceId: workspace.id, workspaceRoot: workspace.root });
    expect(readSupervisorConfig(workspaceRoot, options)).toEqual(second);
  });

  it("rejects a config whose workspace root does not match its identity", async () => {
    await createConfig();
    const file = supervisorConfigFile(workspace.id, stateDir);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    const otherRoot = makeTmpDir("other-root"); roots.push(otherRoot);
    fs.writeFileSync(file, JSON.stringify({ ...saved, workspaceRoot: otherRoot }));
    expect(() => readSupervisorConfig(workspaceRoot, options)).toThrow(SupervisorStoreError);
  });

  it("corrupt schemas, extra keys, hardlinks, links and interrupted temps fail closed", async () => {
    await createConfig();
    const file = supervisorConfigFile(workspace.id, stateDir);
    const saved = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(saved), extra: true }));
    expect(() => readSupervisorConfig(workspaceRoot, options)).toThrow(/schema|JSON/i);
    fs.writeFileSync(file, saved);

    const hardlink = path.join(stateDir, "config-hardlink.json");
    fs.linkSync(file, hardlink);
    expect(() => readSupervisorConfig(workspaceRoot, options)).toThrow(/canonical|hardlink/i);
    fs.unlinkSync(hardlink);

    const temp = path.join(path.dirname(file), `${workspace.id}.runtime.interrupted.tmp`);
    fs.writeFileSync(temp, "partial", { mode: 0o600 });
    expect(() => readSupervisorConfig(workspaceRoot, options)).toThrow(/temporary/i);
    fs.unlinkSync(temp);

    const target = path.join(path.dirname(file), "linked-config.json");
    fs.writeFileSync(target, saved);
    fs.unlinkSync(file);
    try { fs.symlinkSync(target, file, "file"); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(code ?? "")) throw error;
      return;
    }
    expect(() => readSupervisorConfig(workspaceRoot, options)).toThrow(/canonical/i);
    fs.unlinkSync(file);
  });

  it("refuses an existing config when the store directory is no longer owner-only", async () => {
    if (process.platform === "win32") return;
    await createConfig();
    const dir = path.dirname(supervisorConfigFile(workspace.id, stateDir));
    fs.chmodSync(dir, 0o777);
    try { expect(() => readSupervisorConfig(workspaceRoot, options)).toThrow(/permissions/i); }
    finally { fs.chmodSync(dir, 0o700); }
  });
});

function seedLaunch() {
  const buildId = "a".repeat(64), nonce = randomUUID(), launcherPath = path.join(stateDir, "bin", "c2c.js");
  const file = path.join(stateDir, "bridge-supervisor", `${workspace.id}.${nonce}.launch.json`);
  fs.writeFileSync(file, JSON.stringify({ version: 1, workspaceId: workspace.id, workspaceRoot,
    buildId, nonce, launcherPath, createdAt: new Date().toISOString() }), { mode: 0o600 });
  const { dev, ino, size, mtimeMs, ctimeMs } = fs.statSync(file);
  const identity = { dev, ino, size, mtimeMs, ctimeMs, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
  return { file, buildId, launcherPath, identity };
}

describe("supervisor startup pin handoff", () => {
  it("validates the exact launch identity and installed release before handoff", async () => {
    await createConfig();
    const pin = seedLaunch();
    const moduleUrl = pathToFileURL(path.join(stateDir, "releases", pin.buildId, "dist/supervisor/run.js")).href;
    const launch = validateSupervisorLaunch(workspace, stateDir, pin.file, pin.buildId, pin.identity, moduleUrl);
    expect(launch).toEqual({ launcherPath: pin.launcherPath, buildId: pin.buildId });
    expect(() => validateSupervisorLaunch(workspace, stateDir, pin.file, "b".repeat(64), pin.identity, moduleUrl)).toThrow();
    expect(() => validateSupervisorLaunch(workspace, stateDir, undefined, pin.buildId, pin.identity, moduleUrl)).toThrow();
    expect(() => validateSupervisorLaunch(workspace, stateDir, pin.file, pin.buildId, pin.identity, import.meta.url)).toThrow();
    expect(() => validateSupervisorLaunch(workspace, stateDir, pin.file, pin.buildId, undefined, moduleUrl)).toThrow();
  });

  it("publishes runtime before consuming exact startup pin and retains it for a long session", async () => {
    // The independent validation/retirement cases retain the config writes.
    // This launch-only fixture still creates and verifies the real private
    // store through its operation lock, ACL and exact process-identity path.
    await withSupervisorOperation(workspaceRoot, () => {}, options);
    const pin = seedLaunch();
    const moduleUrl = pathToFileURL(path.join(stateDir, "releases", pin.buildId, "dist/supervisor/run.js")).href;
    const launch = validateSupervisorLaunch(workspace, stateDir, pin.file, pin.buildId, pin.identity, moduleUrl);
    const unlink = fs.unlinkSync;
    let observedDurableRuntime = false;
    vi.spyOn(fs, "unlinkSync").mockImplementation(file => {
      if (file === pin.file) {
        const runtime = JSON.parse(fs.readFileSync(supervisorRuntimeFile(workspace.id, stateDir), "utf8"));
        expect(runtime).toMatchObject({ pid: process.pid, buildId: pin.buildId, creationTime: "fixture-creation:1" });
        expect(fs.existsSync(supervisorLeaseFile(workspace.id, stateDir))).toBe(true);
        observedDurableRuntime = true;
      }
      unlink(file);
    });
    let entered!: () => void, finish!: () => void;
    const inside = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { finish = r; });
    const session = withSupervisorLaunch(workspaceRoot, launch, async () => {
      entered(); await gate;
    }, options);
    await inside;
    expect(observedDurableRuntime).toBe(true); expect(fs.existsSync(pin.file)).toBe(false);
    expect(fs.existsSync(supervisorRuntimeFile(workspace.id, stateDir))).toBe(true);
    finish(); await session;
    expect(fs.existsSync(supervisorRuntimeFile(workspace.id, stateDir))).toBe(false);
    expect(fs.existsSync(supervisorLeaseFile(workspace.id, stateDir))).toBe(false);
  });

  it("terminal self-retirement releases the runtime lease without touching Bridge or sleeping", async () => {
    await createConfig();
    const info = { launcherPath: path.join(stateDir, "bin", "c2c.js"), buildId: "a".repeat(64), registrationMode: "windows-scheduled-task" as const };
    const lease = await acquireSupervisorLease(workspaceRoot, info, options);
    const ensure = vi.fn(), observe = vi.fn(), sleep = vi.fn();
    try {
      const retired = { ...readSupervisorConfig(workspaceRoot, options)!, desiredState: "stopped" as const, registrationMode: "none" as const };
      await runSupervisorLoop({ cycle: async action => action(retired, () => {}), observe, ensure, sleep,
        now: () => new Date().toISOString(), report: () => {} }, new AbortController().signal);
    } finally { expect(await lease.release()).toBe(true); }
    expect(ensure).not.toHaveBeenCalled(); expect(observe).not.toHaveBeenCalled(); expect(sleep).not.toHaveBeenCalled();
    expect(fs.existsSync(supervisorRuntimeFile(workspace.id, stateDir))).toBe(false);
    expect(fs.existsSync(supervisorLeaseFile(workspace.id, stateDir))).toBe(false);
  });

  it("failure before acquiring the exact runtime leaves the startup pin intact", async () => {
    await createConfig(); const pin = seedLaunch(), raw = fs.readFileSync(pin.file, "utf8");
    const launch = readSupervisorLaunch(workspaceRoot, pin.file, pin.buildId, pin.identity, options), action = vi.fn();
    await expect(withSupervisorLaunch(workspaceRoot, launch, action, { ...options,
      probeProcess: async pid => processResult(pid, "unknown") })).rejects.toMatchObject({ code: "SUPERVISOR_IDENTITY_UNAVAILABLE" });
    expect(action).not.toHaveBeenCalled(); expect(fs.readFileSync(pin.file, "utf8")).toBe(raw);
    expect(fs.existsSync(supervisorRuntimeFile(workspace.id, stateDir))).toBe(false);
  });

  it("identical-content replacement between validation and handoff is retained and fails closed", async () => {
    // The pre-read replacement case below owns the original config fixture;
    // initialize this independent launch store through the same real authority.
    await withSupervisorOperation(workspaceRoot, () => {}, options);
    const pin = seedLaunch(), raw = fs.readFileSync(pin.file, "utf8");
    const launch = readSupervisorLaunch(workspaceRoot, pin.file, pin.buildId, pin.identity, options), action = vi.fn();
    let replaced = false;
    await expect(withSupervisorLaunch(workspaceRoot, launch, action, { ...options,
      probeProcess: async (pid, expected) => {
        if (!replaced) {
          replaced = true; fs.renameSync(pin.file, `${pin.file}.original`);
          fs.writeFileSync(pin.file, raw, { mode: 0o600 });
        }
        return fakeProbe()(pid, expected);
      } })).rejects.toMatchObject({ code: "SUPERVISOR_OWNERSHIP_LOST" });
    expect(action).not.toHaveBeenCalled(); expect(fs.readFileSync(pin.file, "utf8")).toBe(raw);
    expect(fs.existsSync(supervisorRuntimeFile(workspace.id, stateDir))).toBe(false);
  });

  it("identical-content replacement before the child reads the pin fails the original launcher proof", async () => {
    await createConfig(); const pin = seedLaunch(), raw = fs.readFileSync(pin.file, "utf8");
    fs.renameSync(pin.file, `${pin.file}.original`);
    fs.writeFileSync(pin.file, raw, { mode: 0o600 });
    expect(() => readSupervisorLaunch(workspaceRoot, pin.file, pin.buildId, pin.identity, options))
      .toThrow("differs from launcher identity");
  });

  it("successful handoff leaves only the runtime and lease for a subsequent crash", async () => {
    // Config mutation is covered above; this fixture needs only the real private
    // runtime store. Avoid an unrelated config transaction in the reboot model.
    const info = { launcherPath: path.join(stateDir, "bin", "c2c.js"), buildId: "a".repeat(64), registrationMode: "windows-scheduled-task" as const };
    const lease = await acquireSupervisorLease(workspaceRoot, info, options);
    const pin = seedLaunch(), launch = readSupervisorLaunch(workspaceRoot, pin.file, pin.buildId, pin.identity, options);
    lease.handoffLaunch(launch);
    expect(fs.existsSync(pin.file)).toBe(false);
    expect(fs.existsSync(supervisorRuntimeFile(workspace.id, stateDir))).toBe(true);
    expect(fs.existsSync(supervisorLeaseFile(workspace.id, stateDir))).toBe(true);
    expect(fs.readdirSync(path.dirname(pin.file)).filter(name => name.endsWith(".launch.json"))).toEqual([]);
    // Deliberately leave the exact records as a crash would; strict fixture
    // teardown removes this independent workspace after its assertions.
  });

  it("only exact process-missing proof reclaims the post-crash runtime and lease", async () => {
    const info = { launcherPath: path.join(stateDir, "bin", "c2c.js"), buildId: "a".repeat(64), registrationMode: "windows-scheduled-task" as const };
    const lease = await acquireSupervisorLease(workspaceRoot, info, options);
    const deadPid = 424242;
    const runtime = { ...lease.runtime, pid: deadPid, creationTime: "dead-owner:123" };
    // Model reboot: preserve exact on-disk records of a process now proven absent.
    fs.writeFileSync(supervisorRuntimeFile(workspace.id, stateDir), JSON.stringify(runtime), { mode: 0o600 });
    seedLock(supervisorLeaseFile(workspace.id, stateDir), "supervisor", runtime);
    expect(fs.existsSync(supervisorRuntimeFile(workspace.id, stateDir))).toBe(true);
    // Unknown/reused owners remain covered by the singleton/operation cases.
    const missing = fakeProbe(new Set([deadPid]));
    let exactMissingProbes = 0;
    const next = await acquireSupervisorLease(workspaceRoot, info, optionsWithProbe(async (pid, expected) => {
      if (pid === deadPid) { expect(expected).toBe(runtime.creationTime); exactMissingProbes++; }
      return missing(pid, expected);
    }));
    expect(exactMissingProbes).toBeGreaterThanOrEqual(2);
    expect(next.runtime.pid).toBe(process.pid); expect(next.runtime.nonce).not.toBe(runtime.nonce);
    expect(fs.readdirSync(path.dirname(supervisorRuntimeFile(workspace.id, stateDir))).filter(name => name.endsWith(".launch.json"))).toEqual([]);
    expect(await next.release()).toBe(true);
  });
});

describe("supervisor operation lock", () => {
  it("serializes config mutation across the complete async action and fails busy without running a rival action", async () => {
    let entered!: () => void;
    let finish!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const running = withSupervisorOperation(workspaceRoot, async operation => {
      operation.updateConfig({ desiredState: "running" });
      entered();
      await gate;
    }, options);
    await inside;
    let rivalActionRan = false;
    await expect(withSupervisorOperation(workspaceRoot, operation => {
      rivalActionRan = true;
      operation.updateConfig({ desiredState: "stopped" });
    }, options)).rejects.toMatchObject({ code: "SUPERVISOR_BUSY" });
    expect(rivalActionRan).toBe(false);
    expect(readSupervisorConfig(workspaceRoot, options)?.desiredState).toBe("running");
    finish();
    await running;
    expect(fs.existsSync(supervisorOperationLockFile(workspace.id, stateDir))).toBe(false);
  });

  it("reclaims an exactly proven dead operation owner", async () => {
    await createConfig();
    const file = supervisorOperationLockFile(workspace.id, stateDir);
    const deadPid = process.pid === 424242 ? 424243 : 424242;
    seedLock(file, "operation", { pid: deadPid });
    const probe = fakeProbe(new Set([deadPid]));
    const result = await withSupervisorOperation(workspaceRoot, operation => operation.readConfig()?.desiredState, { ...options, probeProcess: probe });
    expect(result).toBe("running");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("refuses an unknown or reused operation owner", async () => {
    await createConfig();
    const file = supervisorOperationLockFile(workspace.id, stateDir);
    const deadPid = process.pid === 424242 ? 424243 : 424242;
    const probe = fakeProbe(new Set([deadPid]));
    seedLock(file, "operation", { pid: deadPid });
    await expect(withSupervisorOperation(workspaceRoot, () => "must-not-run", {
      ...options,
      probeProcess: async (pid, expected) => pid === deadPid
        ? processResult(pid, "unknown", undefined, "IDENTITY_CHANGED")
        : (await probe(pid, expected)),
    })).rejects.toMatchObject({ code: "SUPERVISOR_BUSY" });
    expect(fs.existsSync(file)).toBe(true);
  });

  it("rechecks operation lock identity before unlink and preserves a replacement", async () => {
    await createConfig();
    const file = supervisorOperationLockFile(workspace.id, stateDir);
    const deadPid = process.pid === 424242 ? 424243 : 424242;
    const probe = fakeProbe(new Set([deadPid]));
    const originalNonce = randomUUID();
    seedLock(file, "operation", { pid: deadPid, nonce: originalNonce });
    let changed = false;
    const mutatingProbe = async (pid: number, expected?: string) => {
      if (pid === deadPid && !changed) {
        changed = true;
        seedLock(file, "operation", { pid: deadPid, nonce: randomUUID() });
        return processResult(pid, "missing");
      }
      if (pid === deadPid) return processResult(pid, "missing");
      return probe(pid, expected);
    };
    await expect(withSupervisorOperation(workspaceRoot, () => "must-not-run", { ...options, probeProcess: mutatingProbe }))
      .rejects.toMatchObject({ code: "SUPERVISOR_BUSY" });
    expect(changed).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).nonce).not.toBe(originalNonce);
  });

  it("corrupt owner is busy and preserved", async () => {
    await createConfig();
    const file = supervisorOperationLockFile(workspace.id, stateDir);
    fs.writeFileSync(file, "{broken", { mode: 0o600 });
    await expect(withSupervisorOperation(workspaceRoot, () => "must-not-run", options)).rejects.toMatchObject({ code: "SUPERVISOR_BUSY" });
    expect(fs.readFileSync(file, "utf8")).toBe("{broken");
  });

  it("asserts operation ownership after a lock path is replaced", async () => {
    const file = supervisorOperationLockFile(workspace.id, stateDir);
    await expect(withSupervisorOperation(workspaceRoot, operation => {
      fs.unlinkSync(file);
      seedLock(file, "operation", { pid: process.pid, creationTime: "fixture-creation:1" });
      operation.assertOwned();
    }, options)).rejects.toMatchObject({ code: "SUPERVISOR_OWNERSHIP_LOST" });
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe("supervisor singleton lease", () => {
  it("persists exact runtime provenance, refuses a second live lease and releases only its own record", async () => {
    const info = { launcherPath: path.join(stateDir, "bin", "c2c.js"), buildId: "a".repeat(64), registrationMode: "windows-scheduled-task" as const };
    const lease = await acquireSupervisorLease(workspaceRoot, info, options);
    expect(readSupervisorRuntime(workspaceRoot, options)).toEqual(lease.runtime);
    expect(lease.runtime).toMatchObject({ workspaceId: workspace.id, workspaceRoot: workspace.root, pid: process.pid, launcherPath: info.launcherPath, buildId: info.buildId });
    await expect(acquireSupervisorLease(workspaceRoot, info, options)).rejects.toMatchObject({ code: "SUPERVISOR_BUSY" });
    expect(await lease.release()).toBe(true);
    expect(readSupervisorRuntime(workspaceRoot, options)).toBeNull();
    expect(fs.existsSync(supervisorLeaseFile(workspace.id, stateDir))).toBe(false);
  });

  it("will not overwrite an orphan runtime unless its exact recorded process is proven missing", async () => {
    const info = { launcherPath: null, buildId: null, registrationMode: "none" as const };
    const deadPid = process.pid === 515151 ? 515152 : 515151;
    const liveLease = await acquireSupervisorLease(workspaceRoot, info, options);
    const oldRuntime = { ...liveLease.runtime, pid: deadPid, creationTime: "dead-owner:123", nonce: randomUUID() };
    fs.writeFileSync(supervisorRuntimeFile(workspace.id, stateDir), JSON.stringify(oldRuntime), { mode: 0o600 });
    expect(await liveLease.release()).toBe(false);

    await expect(acquireSupervisorLease(workspaceRoot, info, {
      ...options,
      probeProcess: async pid => pid === process.pid
        ? processResult(pid, "identified", "fixture-creation:1")
        : processResult(pid, "unknown"),
    })).rejects.toMatchObject({ code: "SUPERVISOR_BUSY" });
    expect(readSupervisorRuntime(workspaceRoot, options)?.pid).toBe(deadPid);
  });

  it("binds lease ownership to the complete runtime provenance and file identity", async () => {
    const info = { launcherPath: path.join(stateDir, "bin", "c2c.js"), buildId: "a".repeat(64), registrationMode: "windows-scheduled-task" as const };
    const lease = await acquireSupervisorLease(workspaceRoot, info, options);
    const runtimeFile = supervisorRuntimeFile(workspace.id, stateDir);
    const replaced = { ...lease.runtime, buildId: "b".repeat(64) };
    fs.writeFileSync(runtimeFile, JSON.stringify(replaced), { mode: 0o600 });
    expect(() => lease.assertOwned()).toThrow(/runtime provenance/i);
    expect(await lease.release()).toBe(false);
    expect(readSupervisorRuntime(workspaceRoot, options)).toEqual(replaced);
    expect(fs.existsSync(supervisorLeaseFile(workspace.id, stateDir))).toBe(true);
  });
});
