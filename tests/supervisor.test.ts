import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Workspace } from "../src/workspace/manager.js";
import { ensureBridgeAndTunnel } from "../src/process/daemon.js";
import { findBridgeObservation, runtimeFile } from "../src/bridge/runtime.js";
import { readTunnelState } from "../src/tunnel/state.js";
import { hasSupervisorState, readSupervisorConfig, withSupervisorOperation } from "../src/supervisor/store.js";
import type { SupervisorConfig } from "../src/supervisor/schema.js";
import { observeSupervisorBridge, recoverSupervisorBridge, runSupervisorLoop, withExplicitSupervisorIntent } from "../src/supervisor/lifecycle.js";
import { isolateStateDir, makeTmpDir } from "./helpers.js";
import { cleanupStrict } from "./strict-teardown.js";

vi.mock("../src/process/daemon.js", () => ({ ensureBridgeAndTunnel: vi.fn() }));
vi.mock("../src/bridge/runtime.js", async original => ({ ...await original<typeof import("../src/bridge/runtime.js")>(), findBridgeObservation: vi.fn() }));
vi.mock("../src/tunnel/state.js", async original => ({ ...await original<typeof import("../src/tunnel/state.js")>(), readTunnelState: vi.fn() }));
vi.mock("../src/supervisor/store.js", () => ({ hasSupervisorState: vi.fn(), readSupervisorConfig: vi.fn(), withSupervisorOperation: vi.fn() }));
const dirs: string[] = [];
let state: ReturnType<typeof isolateStateDir>;
let root: string;
const config = (desiredState: "running" | "stopped" = "running", tunnel = true) => ({ desiredState, tunnel, registrationMode: "windows-scheduled-task" } as SupervisorConfig);
beforeEach(() => {
  state = isolateStateDir(); root = makeTmpDir("supervisor-loop"); dirs.push(root, state);
  vi.resetAllMocks();
});
afterEach(async () => { vi.restoreAllMocks(); delete process.env.C2C_STATE_DIR; await cleanupStrict(...dirs.splice(0)); });

async function loop(states: Array<{ state: "healthy" | "stopped" | "unknown" } | Error>, configs = [config()], startError?: Error) {
  const signal = new AbortController(), events: Array<{ reason: string; nextCheckMs: number }> = [];
  let iteration = 0;
  const ensure = vi.fn(async () => { if (startError) throw startError; });
  const observe = vi.fn(async () => { const next = states[Math.min(iteration, states.length - 1)]; if (next instanceof Error) throw next; return next; });
  const cycle = vi.fn(async action => action(configs[Math.min(iteration, configs.length - 1)], () => {}));
  await runSupervisorLoop({ cycle, observe, ensure, now: () => "2026-10-03T00:00:00.000Z",
    report: event => events.push(event), sleep: async () => { if (++iteration >= states.length) signal.abort(); } }, signal.signal);
  return { events, ensure, observe, cycle };
}

describe("independent supervisor decisions", () => {
  it.each(["none", "unsupported"] as const)("registration mode %s retires without Bridge observation, start or sleep", async registrationMode => {
    const run = await loop([{ state: "stopped" }, { state: "stopped" }], [{ ...config(), registrationMode }]);
    expect(run.observe).not.toHaveBeenCalled(); expect(run.ensure).not.toHaveBeenCalled();
    expect(run.cycle).toHaveBeenCalledTimes(1);
    expect(run.events).toEqual([{ observedAt: "2026-10-03T00:00:00.000Z", reason: "retired", nextCheckMs: 0 }]);
  });
  it("paused never observes or starts", async () => {
    const run = await loop([{ state: "stopped" }], [config("stopped")]);
    expect(run.observe).not.toHaveBeenCalled(); expect(run.ensure).not.toHaveBeenCalled();
    expect(run.events).toMatchObject([{ reason: "paused", nextCheckMs: 10000 }]);
  });
  it("healthy never starts", async () => {
    const run = await loop([{ state: "healthy" }]);
    expect(run.ensure).not.toHaveBeenCalled(); expect(run.events[0].reason).toBe("healthy");
  });
  it("reboot fixture recovers a stopped bridge once with its tunnel preference; next cycle observes healthy", async () => {
    const bindings = { desktop: "original", feedback: "original", webSink: "original", executor: "original" };
    const before = JSON.stringify(bindings);
    const run = await loop([{ state: "stopped" }, { state: "healthy" }]);
    expect(run.ensure).toHaveBeenCalledExactlyOnceWith(true); expect(JSON.stringify(bindings)).toBe(before);
  });
  it.each(["probe_failed", "pid_unknown", "application-timeout", "identity_mismatch"])("unknown %s cannot start or kill", async reason => {
    const run = await loop([{ state: "unknown", reason } as { state: "unknown" }]);
    expect(run.ensure).not.toHaveBeenCalled(); expect(run.events[0].reason).toBe("bridge_unknown");
  });
  it("observation error cannot become stopped", async () => {
    const run = await loop([new Error("raw sensitive response must not escape")]);
    expect(run.ensure).not.toHaveBeenCalled(); expect(run.events[0].reason).toBe("observation_failed");
  });
  it.each([Object.assign(new Error(), { code: "MAINTENANCE_BUSY" }), new Error("Bridge start lock 存在或无法取得；未启动重复实例，请稍后重试。")])("busy start uses bounded backoff without an immediate second attempt", async error => {
    const run = await loop([{ state: "stopped" }, { state: "stopped" }], [config()], error);
    expect(run.ensure).toHaveBeenCalledTimes(2);
    expect(run.events.map(x => [x.reason, x.nextCheckMs])).toEqual([["busy", 1000], ["busy", 2000]]);
  });
  it("backoff caps at ten seconds and resets after healthy", async () => {
    const run = await loop(["unknown", "unknown", "unknown", "unknown", "unknown", "healthy", "unknown"].map(state => ({ state })) as Array<{ state: "unknown" | "healthy" }>);
    expect(run.events.map(x => x.nextCheckMs)).toEqual([1000, 2000, 5000, 10000, 10000, 10000, 1000]);
  });
  it("re-reads desired state each iteration and never starts once paused", async () => {
    const run = await loop([{ state: "stopped" }, { state: "stopped" }], [config("running", false), config("stopped")]);
    expect(run.ensure).toHaveBeenCalledExactlyOnceWith(false); expect(run.cycle).toHaveBeenCalledTimes(2);
  });
});

describe("auto-recovery production adapter", () => {
  it("existing malformed runtime is unknown rather than legacy reader's missing", async () => {
    const workspace = new Workspace(root), file = runtimeFile(workspace.id);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "{broken");
    expect((await observeSupervisorBridge(workspace)).state).toBe("unknown");
    expect(findBridgeObservation).not.toHaveBeenCalled();
  });
  it("absent runtime delegates to the existing observation authority", async () => {
    const workspace = new Workspace(root);
    vi.mocked(findBridgeObservation).mockResolvedValue({ state: "stopped", runtime: null, reason: "runtime_missing" });
    expect((await observeSupervisorBridge(workspace)).state).toBe("stopped");
    expect(findBridgeObservation).toHaveBeenCalledExactlyOnceWith(workspace.id);
  });
  it("configured named identity is retained through existing ensure; quick fallback is forbidden", async () => {
    const workspace = new Workspace(root);
    vi.mocked(readTunnelState).mockReturnValue({ workspaceId: workspace.id, preference: "named", provider: "cloudflare-named", tunnelName: "same", hostname: "same.example.com" });
    vi.mocked(ensureBridgeAndTunnel).mockResolvedValue({ info: { publicUrl: "https://same.example.com", tunnel: { provider: "cloudflare-named", url: "https://same.example.com" } } } as never);
    await recoverSupervisorBridge(workspace, true);
    expect(ensureBridgeAndTunnel).toHaveBeenCalledExactlyOnceWith(root, { tunnel: true });
    vi.mocked(readTunnelState).mockReturnValue({ workspaceId: workspace.id, preference: "quick" });
    await expect(recoverSupervisorBridge(workspace, true)).rejects.toThrow("NAMED_TUNNEL_REQUIRED");
    vi.mocked(readTunnelState).mockReturnValue(false as never);
    await expect(recoverSupervisorBridge(workspace, true)).rejects.toThrow("NAMED_TUNNEL_REQUIRED");
    expect(ensureBridgeAndTunnel).toHaveBeenCalledTimes(1);
  });
});

describe("explicit CLI desired-state ordering", () => {
  const setup = (saved = config()) => {
    let value = saved;
    const updateConfig = vi.fn(patch => (value = { ...value, ...patch }));
    vi.mocked(readSupervisorConfig).mockImplementation(() => value);
    vi.mocked(hasSupervisorState).mockReturnValue(true);
    vi.mocked(withSupervisorOperation).mockImplementation(async (_root, action) => action({ readConfig: () => value, updateConfig }) as never);
    return { updateConfig, read: () => value };
  };
  it.each(["running", "stopped"] as const)("persists %s before the explicit action", async desired => {
    const saved = setup(config(desired === "running" ? "stopped" : "running"));
    const action = vi.fn(async tunnel => { expect(saved.read().desiredState).toBe(desired); expect(tunnel).toBe(true); });
    await withExplicitSupervisorIntent(root, desired, undefined, action);
    expect(saved.updateConfig).toHaveBeenCalledExactlyOnceWith({ desiredState: desired }); expect(action).toHaveBeenCalledTimes(1);
  });
  it.each(["running", "stopped"] as const)("mutation failure forbids %s start/shutdown", async desired => {
    const saved = setup(); saved.updateConfig.mockImplementation(() => { throw new Error("disk failure"); });
    const action = vi.fn();
    await expect(withExplicitSupervisorIntent(root, desired, undefined, action)).rejects.toThrow("disk failure");
    expect(action).not.toHaveBeenCalled();
  });
  it("restart intent preserves saved tunnel and only changes an explicit override", async () => {
    const saved = setup(config("stopped", true));
    await withExplicitSupervisorIntent(root, "running", undefined, async tunnel => expect(tunnel).toBe(true));
    await withExplicitSupervisorIntent(root, "running", false, async tunnel => expect(tunnel).toBe(false));
    expect(saved.read()).toMatchObject({ desiredState: "running", tunnel: false });
  });
  it("absent config leaves legacy start/stop behavior and state untouched", async () => {
    vi.mocked(readSupervisorConfig).mockReturnValue(null); const action = vi.fn(async value => value);
    const updateConfig = vi.fn();
    vi.mocked(withSupervisorOperation).mockImplementation(async (_root, callback) => callback({ readConfig: () => null, updateConfig }) as never);
    expect(await withExplicitSupervisorIntent(root, "stopped", undefined, action)).toBe(false);
    expect(updateConfig).not.toHaveBeenCalled(); expect(withSupervisorOperation).not.toHaveBeenCalled();
    expect(fs.readdirSync(state)).toEqual([]);
  });
  it("stop observes a concurrent install inside the operation fence", async () => {
    const saved = setup(config("running"));
    vi.mocked(readSupervisorConfig).mockReturnValue(null);
    await withExplicitSupervisorIntent(root, "stopped", undefined, async () => expect(saved.read().desiredState).toBe("stopped"));
    expect(readSupervisorConfig).not.toHaveBeenCalled();
  });
  it("orphan/corrupt supervisor evidence cannot take the no-config fast path", async () => {
    vi.mocked(hasSupervisorState).mockReturnValue(true);
    vi.mocked(withSupervisorOperation).mockImplementation(async (_root, callback) => callback({ readConfig: () => null } as never));
    const action = vi.fn();
    await expect(withExplicitSupervisorIntent(root, "stopped", undefined, action)).rejects.toThrow("SUPERVISOR_CONFIG_MISSING");
    expect(action).not.toHaveBeenCalled();
  });
});
