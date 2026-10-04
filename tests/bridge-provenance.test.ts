import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import * as runtimeApi from "../src/bridge/runtime.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { ensureBridge } from "../src/process/daemon.js";
import * as spawnApi from "../src/process/daemon-spawn.js";
import * as probeApi from "../src/process/process-probe.js";
import { bridgeProvenanceFile, persistSpawnProvenance, readBridgeProvenance, recordShutdownIntent } from "../src/process/bridge-provenance.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";
import { requestHttp } from "./http-json.js";
import { collectReleaseReferences } from "../src/core/release-references.js";

let state: ReturnType<typeof isolateStateDir>;
let previousState: string | undefined;
let root: string;
let workspace: Workspace;
let runtime: runtimeApi.RuntimeState;
let spawned: spawnApi.DaemonSpawnResult;
let bridge: Bridge | undefined;
const build = "a".repeat(64);
const probe = (pid = process.pid): probeApi.ProcessProbe => ({ ...probeApi.unknownProcessProbe(pid), status: "identified",
  executable: process.execPath, creationTime: "12345", inAnyJob: true,
  errors: { process: null, executable: null, creationTime: null, inAnyJob: null } });
const launch = () => ({ entryPath: path.join(root, "dist", "cli", "index.js"), buildId: build });
const persist = () => persistSpawnProvenance(runtime, workspace, spawned, launch(), probe());

describe("shared process presence evidence", () => {
  it.each(["PID_MISSING", "PID_EXITED", "WIN32_87", "PROBE_UNAVAILABLE", "IDENTITY_CHANGED", "WIN32_5"])(
    "Windows ESRCH requires native evidence: %s", async reason => {
      vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("probe"), { code: "ESRCH" }); });
      const evidence = { ...probeApi.unknownProcessProbe(123), status: "missing" as const };
      evidence.errors.process = reason;
      const native = vi.fn(async () => evidence);
      const proven = ["PID_MISSING", "PID_EXITED", "WIN32_87"].includes(reason);
      expect(await probeApi.observeProcessPresence(123, "win32", native)).toBe(proven ? "missing" : "unknown");
      expect(native).toHaveBeenCalledExactlyOnceWith(123);
      expect(process.kill).toHaveBeenCalledExactlyOnceWith(123, 0);
    });
  it.each(["unknown", "identified", "wrong_pid", "invalid", "throws"])("Windows native %s does not authorize absence", async kind => {
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("probe"), { code: "ESRCH" }); });
    const native = async () => {
      if (kind === "throws") throw new Error("unavailable");
      if (kind === "identified") return probe(123);
      if (kind === "wrong_pid") return probe(124);
      if (kind === "invalid") return { ...probe(123), extra: "rejected" };
      return probeApi.unknownProcessProbe(123);
    };
    expect(await probeApi.observeProcessPresence(123, "win32", native)).toBe(kind === "identified" ? "present" : "unknown");
  });
  it("positive hint, denied access and POSIX ESRCH keep their existing bounded semantics", async () => {
    const native = vi.fn(async () => probeApi.unknownProcessProbe(123));
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    expect(await probeApi.observeProcessPresence(123, "win32", native)).toBe("present");
    kill.mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    expect(await probeApi.observeProcessPresence(123, "win32", native)).toBe("unknown");
    kill.mockImplementation(() => { throw Object.assign(new Error("missing"), { code: "ESRCH" }); });
    expect(await probeApi.observeProcessPresence(123, "linux", native)).toBe("missing");
    expect(await probeApi.observeProcessPresence(0, "win32", native)).toBe("unknown");
    expect(native).not.toHaveBeenCalled();
  });
});
beforeEach(() => {
  previousState = process.env.C2C_STATE_DIR;
  state = isolateStateDir(); root = makeTmpDir("provenance-workspace"); workspace = new Workspace(root);
  runtime = { service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id, workspaceRoot: workspace.root,
    pid: process.pid, startedAt: "2026-10-02T01:00:00.000Z", runtimeBuildId: build, port: 12345,
    adminToken: "SECRET_SENTINEL", publicUrl: null };
  runtimeApi.writeRuntimeState(runtime);
  spawned = { pid: runtime.pid, mode: "helper-wmi", spawnAttemptId: randomUUID(), helperInJob: true,
    spawner: probe(), helper: probe(333), finalProcess: probe() };
});
afterEach(async () => {
  if (bridge) await bridge.close(); bridge = undefined; vi.restoreAllMocks();
  if (previousState === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = previousState;
  cleanup(state); cleanup(root);
});

describe("bounded non-authoritative Bridge provenance", () => {
  it("persists exact runtime only; absent legacy state never fabricates spawn mode", () => {
    const file = bridgeProvenanceFile(workspace.id);
    expect(readBridgeProvenance(runtime).spawn).toEqual({ status: "absent" });
    expect(fs.existsSync(file)).toBe(false);
    persist();
    expect(readBridgeProvenance(runtime).spawn).toMatchObject({ status: "matching", record: { mode: "helper-wmi", runtime: { pid: process.pid }, helperInJob: true } });
    const raw = fs.readFileSync(file, "utf8");
    for (const secret of ["SECRET_SENTINEL", "adminToken", "commandId", "argv", '"env"']) expect(raw).not.toContain(secret);
    expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
  });
  it.each(["pid", "startedAt", "workspaceRoot", "runtimeBuildId"] as const)("old record never attaches after %s drift", key => {
    persist();
    const changed = { ...runtime, [key]: key === "pid" ? runtime.pid + 1 : key === "startedAt" ? "2026-10-03T01:00:00.000Z" : key === "runtimeBuildId" ? "b".repeat(64) : path.dirname(root) };
    expect(readBridgeProvenance(changed).spawn).toEqual({ status: "conflict" });
  });
  it.each(["pid", "workspace", "build", "creation", "missing", "changed"])("identity %s mismatch does not write", kind => {
    let target = runtime; let expected = workspace; let final = probe(); let entry = launch();
    if (kind === "pid") target = { ...runtime, pid: runtime.pid + 1 };
    if (kind === "workspace") expected = { ...workspace, id: "f".repeat(12) } as Workspace;
    if (kind === "build") entry = { ...entry, buildId: "b".repeat(64) };
    if (kind === "creation") final = { ...final, creationTime: "999" };
    if (kind === "missing") final = { ...probeApi.unknownProcessProbe(runtime.pid), status: "missing" };
    if (kind === "changed") final = { ...probeApi.unknownProcessProbe(runtime.pid), errors: { ...final.errors, process: "IDENTITY_CHANGED" } };
    expect(() => persistSpawnProvenance(target, expected, spawned, entry, final)).toThrow();
    expect(fs.existsSync(bridgeProvenanceFile(workspace.id))).toBe(false);
  });
  it("unknown process fields stay unknown and never mean no Job", () => {
    spawned.finalProcess = probeApi.unknownProcessProbe(runtime.pid);
    persistSpawnProvenance(runtime, workspace, spawned, launch(), probeApi.unknownProcessProbe(runtime.pid));
    expect(readBridgeProvenance(runtime).spawn).toMatchObject({ status: "matching", record: { finalProcess: { status: "unknown", inAnyJob: null } } });
    expect(probeApi.parseProcessProbe({ ...probe(), env: "private" }, runtime.pid).status).toBe("unknown");
    expect(probeApi.parseProcessProbe(probe(runtime.pid + 1), runtime.pid).status).toBe("unknown");
  });
  it.each(["corrupt", "temp", "lock", "symlink"])("%s state is preserved and fails closed for mutation", kind => {
    const file = bridgeProvenanceFile(workspace.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (kind === "corrupt") fs.writeFileSync(file, "broken");
    if (kind === "temp") fs.writeFileSync(`${file}.residue.tmp`, "partial");
    if (kind === "lock") fs.writeFileSync(`${file}.lock`, "unknown-owner");
    if (kind === "symlink") {
      const outside = path.join(root, "outside"); fs.mkdirSync(outside);
      fs.rmdirSync(path.dirname(file)); fs.symlinkSync(outside, path.dirname(file), "junction");
    }
    expect(readBridgeProvenance(runtime).spawn.status).toBe("conflict");
    expect(() => persist()).toThrow();
    if (kind === "corrupt") expect(fs.readFileSync(file, "utf8")).toBe("broken");
    if (kind === "symlink") expect(fs.readdirSync(path.join(root, "outside"))).toEqual([]);
  });
  it("new runtime replaces one spawn record; late old shutdown cannot overwrite new intent", () => {
    persist();
    const older = runtime;
    runtime = { ...runtime, startedAt: "2026-10-03T01:00:00.000Z" };
    runtimeApi.writeRuntimeState(runtime); persist(); recordShutdownIntent(runtime, "SIGTERM");
    const file = bridgeProvenanceFile(workspace.id, "shutdown"); const bytes = fs.readFileSync(file);
    expect(() => recordShutdownIntent(older, "SIGINT")).toThrow();
    expect(fs.readFileSync(file)).toEqual(bytes);
    expect(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith(".json"))).toHaveLength(2);
  });
  it("replacement during atomic commit leaves evidence and never overwrites replacement", () => {
    const file = bridgeProvenanceFile(workspace.id); persist();
    const original = fs.fsyncSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
      original(fd);
      if (fs.readdirSync(path.dirname(file)).some(name => name.endsWith(".tmp"))) {
        runtimeApi.writeRuntimeState({ ...runtime, startedAt: "2026-10-03T01:00:00.000Z" });
      }
    });
    const before = fs.readFileSync(file);
    expect(() => persist()).toThrow();
    expect(fs.readFileSync(file)).toEqual(before);
    expect(readBridgeProvenance(runtime).spawn.status).toBe("conflict");
  });
  it("ensureBridge legacy reuse never calls spawn or writes provenance", async () => {
    vi.spyOn(runtimeApi, "findBridgeObservation").mockResolvedValue({ state: "healthy", runtime });
    const spawn = vi.spyOn(spawnApi, "spawnDetachedDaemon");
    expect((await ensureBridge(root)).spawned).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    expect(readBridgeProvenance(runtime).spawn.status).toBe("absent");
  });
  it.each([true, false])("ensureBridge persists only after authenticated healthy exact PID (match=%s)", async match => {
    const file = bridgeProvenanceFile(workspace.id);
    vi.spyOn(runtimeApi, "findBridgeObservation").mockResolvedValue({ state: "stopped", runtime: null, reason: "runtime_missing" });
    vi.spyOn(spawnApi, "spawnDetachedDaemon").mockImplementation(async () => {
      expect(fs.existsSync(file)).toBe(false); return spawned;
    });
    // ensure's selected dist build is captured independently; use it in the synthetic healthy runtime.
    runtime.runtimeBuildId = fs.readFileSync(path.resolve("dist/build-id.txt"), "utf8").trim(); runtimeApi.writeRuntimeState(runtime);
    vi.spyOn(runtimeApi, "findLiveBridge").mockImplementation(async () => { expect(fs.existsSync(file)).toBe(false); return runtime; });
    vi.spyOn(runtimeApi, "adminFetch").mockResolvedValue({ ...runtime, pid: runtime.pid + (match ? 0 : 1) });
    vi.spyOn(probeApi, "probeProcess").mockResolvedValue(probe());
    expect((await ensureBridge(root)).spawned).toBe(true);
    expect(fs.existsSync(file)).toBe(match);
  });
  it.each(["SIGINT", "SIGTERM", "restart", "rollout", "admin_shutdown"] as const)("process shutdown %s retains runtime and GC pin until externally proven exited", async reason => {
    bridge = await startBridge({ workspaceRoot: root, port: 0, runtimeBuildId: build });
    const live = runtimeApi.readRuntimeState(workspace.id)!;
    await bridge.close(reason);
    expect(runtimeApi.readRuntimeState(workspace.id)).toEqual(live);
    expect(readBridgeProvenance(live).shutdown).toMatchObject({ status: "matching", record: { reason } });
    expect(await runtimeApi.findBridgeObservation(workspace.id)).toMatchObject({ state: "unknown", reason: "probe_failed" });
    expect(collectReleaseReferences(state).references.get(build)).toContainEqual({ kind: "runtime", buildId: build,
      source: `runtime:${workspace.id}`, workspaceId: workspace.id });
  });
  it("authenticated admin info is bounded; authenticated admin shutdown records intent before response", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fixture must use direct HTTP, not Fetch"));
    bridge = await startBridge({ workspaceRoot: root, port: 0, runtimeBuildId: build });
    runtime = runtimeApi.readRuntimeState(workspace.id)!; persist();
    const denied = await requestHttp(`${bridge.localBaseUrl()}/admin/info`); expect(denied.status).toBe(404);
    expect(await denied.text()).toBe("");
    const info = await runtimeApi.adminFetch<{ bridgeProvenance: unknown }>(runtime, "GET", "/admin/info");
    expect(info.bridgeProvenance).toEqual(readBridgeProvenance(runtime));
    expect(JSON.stringify(info)).not.toContain(runtime.adminToken);
    // Intercept the existing delayed process.exit, without changing shutdown behavior in production.
    const realTimeout = setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
      ms === 100 ? { unref() {} } : realTimeout(fn, ms, ...args)) as typeof setTimeout);
    const shutdown = await runtimeApi.adminFetch(runtime, "POST", "/admin/shutdown", 5000, { shutdownReason: "rollout" });
    expect(shutdown).toEqual({ shuttingDown: true });
    expect(readBridgeProvenance(runtime).shutdown).toMatchObject({ status: "matching", record: { reason: "rollout" } });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("diagnostics never enter GC/reference/delivery authority", () => {
    for (const directory of ["src/core", "src/desktop", "src/executor-control", "src/feedback", "src/result-bus", "src/command-cleanup", "src/routing"]) {
      for (const file of fs.readdirSync(directory, { recursive: true })) {
        if (typeof file !== "string" || !file.endsWith(".ts")) continue;
        expect(fs.readFileSync(path.join(directory, file), "utf8"), file).not.toMatch(/(?:bridge-provenance|bridge-spawn-provenance|bridgeProvenance)/);
      }
    }
    expect(fs.readFileSync("src/cli/server.ts", "utf8")).toContain('process.on("SIGINT", () => shutdown("SIGINT"))');
    expect(fs.readFileSync("src/cli/server.ts", "utf8")).toContain('process.on("SIGTERM", () => shutdown("SIGTERM"))');
  });
});
