import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerSupervisorCommands } from "../src/cli/supervisor.js";
import { registerRuntimeCommands, registerStartCommands } from "../src/cli/runtime.js";
import * as store from "../src/supervisor/store.js";
import * as tasks from "../src/supervisor/windows-task.js";
import * as daemon from "../src/process/daemon.js";
import { rollout } from "../src/core/rollout.js";
import { Workspace } from "../src/workspace/manager.js";
import { makeTmpDir } from "./helpers.js";
import { cleanupStrict } from "./strict-teardown.js";
import type { SupervisorConfig } from "../src/supervisor/schema.js";

vi.mock("../src/supervisor/store.js", () => ({ hasSupervisorState: vi.fn(), readSupervisorConfig: vi.fn(), readSupervisorRuntime: vi.fn(), withSupervisorOperation: vi.fn() }));
vi.mock("../src/supervisor/run.js", () => ({ runInstalledSupervisor: vi.fn() }));
vi.mock("../src/supervisor/windows-task.js", async original => ({ ...await original<typeof import("../src/supervisor/windows-task.js")>(), inspectWindowsSupervisorTask: vi.fn(), installWindowsSupervisorTask: vi.fn(), uninstallWindowsSupervisorTask: vi.fn() }));
vi.mock("../src/process/daemon.js", () => ({ ensureBridgeAndTunnel: vi.fn(), ensureBridge: vi.fn(), stopBridge: vi.fn(), restartBridge: vi.fn(), adminFetch: vi.fn() }));
vi.mock("../src/core/rollout.js", () => ({ rollout: vi.fn() }));
const dirs: string[] = [];
let root: string, saved: SupervisorConfig | null;
let update: ReturnType<typeof vi.fn>, events: string[];
beforeEach(() => {
  vi.resetAllMocks(); events = [];
  root = makeTmpDir("supervisor-cli"); dirs.push(root);
  vi.stubEnv("C2C_STATE_DIR", root);
  const workspace = new Workspace(root);
  saved = { version: 1, workspaceId: workspace.id, workspaceRoot: root, desiredState: "running", tunnel: true,
    registrationMode: "windows-scheduled-task", revision: 1, updatedAt: new Date().toISOString() };
  update = vi.fn(patch => { events.push(`desired:${patch.desiredState}`); saved = { ...saved!, ...patch }; return saved; });
  vi.mocked(store.readSupervisorConfig).mockImplementation(() => saved);
  vi.mocked(store.hasSupervisorState).mockImplementation(() => saved !== null);
  vi.mocked(store.readSupervisorRuntime).mockReturnValue(null);
  vi.mocked(store.withSupervisorOperation).mockImplementation(async (_root, action) => action({ readConfig: () => saved, updateConfig: update }) as never);
  vi.mocked(tasks.inspectWindowsSupervisorTask).mockReturnValue({ status: "owned" } as never);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.mocked(daemon.ensureBridgeAndTunnel).mockResolvedValue({ runtime: { port: 1234 }, info: { workspaceId: workspace.id, workspaceName: "test" }, mcpUrl: null } as never);
  vi.mocked(daemon.restartBridge).mockResolvedValue({ info: { workspaceName: "test" }, mcpUrl: null } as never);
  vi.mocked(daemon.stopBridge).mockResolvedValue(true);
});
afterEach(async () => { process.exitCode = 0; vi.restoreAllMocks(); vi.unstubAllEnvs(); await cleanupStrict(...dirs.splice(0)); });
async function cli(...args: string[]) {
  const program = new Command(); registerStartCommands(program); registerRuntimeCommands(program); registerSupervisorCommands(program);
  await program.parseAsync([...args, "-w", root], { from: "user" });
}
describe("supervisor CLI and explicit runtime intent", () => {
  it.each(["start", "restart"])("%s resumes before its existing authority and preserves tunnel", async name => {
    saved!.desiredState = "stopped";
    const target = name === "start" ? daemon.ensureBridgeAndTunnel : daemon.restartBridge;
    vi.mocked(target).mockImplementation(async (_root, opts) => {
      expect(saved!.desiredState).toBe("running"); expect(opts.tunnel).toBe(true);
      return { runtime: { port: 1234 }, info: { workspaceId: saved!.workspaceId, workspaceName: "test" }, mcpUrl: null } as never;
    });
    await cli(name); expect(target).toHaveBeenCalledTimes(1); expect(update).toHaveBeenCalledExactlyOnceWith({ desiredState: "running" });
  });
  it("stop writes stopped before authenticated shutdown", async () => {
    vi.mocked(daemon.stopBridge).mockImplementation(async () => { expect(saved!.desiredState).toBe("stopped"); return true; });
    await cli("stop"); expect(daemon.stopBridge).toHaveBeenCalledTimes(1);
    const output = vi.mocked(process.stdout.write).mock.calls.map(([text]) => String(text)).join("");
    expect(output).toContain("已接受关闭请求");
    expect(output).not.toContain("Bridge 已停止");
  });
  it("stop mutation failure refuses shutdown", async () => {
    update.mockImplementation(() => { throw new Error("STORE_WRITE_FAILED"); });
    await expect(cli("stop")).rejects.toThrow("STORE_WRITE_FAILED"); expect(daemon.stopBridge).not.toHaveBeenCalled();
  });
  it("rollout never enters supervisor desired-state mutation", async () => {
    const before = JSON.stringify(saved); vi.mocked(rollout).mockResolvedValue({ counts: {}, workspaces: [] } as never);
    await cli("rollout", "--json"); expect(rollout).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled(); expect(JSON.stringify(saved)).toBe(before);
  });
  it("status is read-only and does not repair an absent task or runtime", async () => {
    vi.mocked(tasks.inspectWindowsSupervisorTask).mockReturnValue({ status: "absent" } as never);
    await cli("supervisor", "status", "--json");
    expect(store.withSupervisorOperation).not.toHaveBeenCalled(); expect(tasks.installWindowsSupervisorTask).not.toHaveBeenCalled();
    const result = JSON.parse(String(vi.mocked(process.stdout.write).mock.calls.at(-1)![0]));
    expect(result.config.registrationMode).toBe("windows-scheduled-task"); expect(result.registration.status).toBe("absent");
  });
  it("install remains paused until exact registration succeeds and never starts a Bridge itself", async () => {
    saved!.tunnel = false;
    vi.mocked(tasks.installWindowsSupervisorTask).mockImplementation(() => { events.push("register"); expect(saved).toMatchObject({ desiredState: "stopped", registrationMode: "none" }); return { status: "installed" } as never; });
    await cli("supervisor", "install", "--json");
    expect(events).toEqual(["desired:stopped", "register", "desired:running"]);
    expect(saved).toMatchObject({ desiredState: "running", registrationMode: "windows-scheduled-task" });
    expect(daemon.ensureBridgeAndTunnel).not.toHaveBeenCalled();
  });
  it("registration failure retains paused state, exposes failure, and does not start", async () => {
    saved!.tunnel = false;
    vi.mocked(tasks.installWindowsSupervisorTask).mockImplementation(() => { throw new tasks.WindowsTaskError("PERMISSION_DENIED"); });
    await cli("supervisor", "install", "--json");
    expect(saved).toMatchObject({ desiredState: "stopped", registrationMode: "none" }); expect(process.exitCode).toBe(1); expect(daemon.ensureBridgeAndTunnel).not.toHaveBeenCalled();
  });
  it("foreign install leaves stopped/none and refuses registration mutation", async () => {
    saved!.tunnel = false;
    vi.mocked(tasks.inspectWindowsSupervisorTask).mockReturnValue({ status: "conflict" } as never);
    await cli("supervisor", "install", "--json");
    expect(process.exitCode).toBe(1); expect(saved).toMatchObject({ desiredState: "stopped", registrationMode: "none" });
    expect(tasks.installWindowsSupervisorTask).not.toHaveBeenCalled(); expect(tasks.uninstallWindowsSupervisorTask).not.toHaveBeenCalled();
  });
  it("uninstall persists stopped before exact removal and leaves the Bridge alone", async () => {
    vi.mocked(tasks.uninstallWindowsSupervisorTask).mockImplementation(() => { events.push("remove"); expect(saved!.desiredState).toBe("stopped"); return { status: "removed", taskName: "owned" }; });
    await cli("supervisor", "uninstall", "--json"); expect(events).toEqual(["desired:stopped", "remove", "desired:stopped"]);
    expect(saved).toMatchObject({ desiredState: "stopped", registrationMode: "none" });
    expect(daemon.stopBridge).not.toHaveBeenCalled(); expect(daemon.restartBridge).not.toHaveBeenCalled();
  });
  it.each(["conflict", "permission"])("uninstall %s leaves recovery paused and retains installed mode", async failure => {
    if (failure === "conflict") vi.mocked(tasks.inspectWindowsSupervisorTask).mockReturnValue({ status: "conflict" } as never);
    else vi.mocked(tasks.uninstallWindowsSupervisorTask).mockImplementation(() => { throw new tasks.WindowsTaskError("PERMISSION_DENIED"); });
    await cli("supervisor", "uninstall", "--json");
    expect(process.exitCode).toBe(1); expect(saved).toMatchObject({ desiredState: "stopped", registrationMode: "windows-scheduled-task" });
    expect(daemon.stopBridge).not.toHaveBeenCalled(); expect(daemon.restartBridge).not.toHaveBeenCalled();
  });
  it("final none write failure reports failure; later uninstall reconciles confirmed absence", async () => {
    update.mockImplementationOnce(patch => saved = { ...saved!, ...patch }).mockImplementationOnce(() => { throw new Error("STORE_WRITE_FAILED"); });
    vi.mocked(tasks.uninstallWindowsSupervisorTask).mockReturnValue({ status: "removed", taskName: "owned" });
    await cli("supervisor", "uninstall", "--json");
    expect(process.exitCode).toBe(1); expect(saved).toMatchObject({ desiredState: "stopped", registrationMode: "windows-scheduled-task" });
    process.exitCode = 0;
    vi.mocked(tasks.inspectWindowsSupervisorTask).mockReturnValue({ status: "absent" } as never);
    vi.mocked(tasks.uninstallWindowsSupervisorTask).mockReturnValue({ status: "absent", taskName: "owned" });
    await cli("supervisor", "uninstall", "--json");
    expect(process.exitCode).toBe(0); expect(saved).toMatchObject({ desiredState: "stopped", registrationMode: "none" });
    expect(daemon.stopBridge).not.toHaveBeenCalled();
  });
  it("already owned registration is finalized only after fresh exact inspection", async () => {
    saved!.tunnel = false;
    vi.mocked(tasks.installWindowsSupervisorTask).mockReturnValue({ status: "already_installed" } as never);
    vi.mocked(tasks.inspectWindowsSupervisorTask).mockReturnValueOnce({ status: "owned" } as never)
      .mockReturnValueOnce({ status: "absent" } as never);
    await cli("supervisor", "install", "--json");
    expect(process.exitCode).toBe(1); expect(saved).toMatchObject({ desiredState: "stopped", registrationMode: "none" });
    expect(daemon.ensureBridgeAndTunnel).not.toHaveBeenCalled();
  });
  it.each(["start", "stop"])("pristine %s has no supervisor store/probe/ScheduledTasks dependency", async name => {
    saved = null;
    vi.mocked(store.withSupervisorOperation).mockRejectedValue(new Error("ACL_OR_PROCESS_PROBE_UNAVAILABLE"));
    vi.mocked(tasks.inspectWindowsSupervisorTask).mockImplementation(() => { throw new Error("NO_SCHEDULED_TASKS"); });
    await cli(name);
    expect(process.exitCode).toBe(0); expect(store.withSupervisorOperation).not.toHaveBeenCalled();
    expect(tasks.inspectWindowsSupervisorTask).not.toHaveBeenCalled(); expect(saved).toBeNull();
    expect(name === "start" ? daemon.ensureBridgeAndTunnel : daemon.stopBridge).toHaveBeenCalledTimes(1);
  });
  it("initial install cannot publish running across an in-flight no-config stop", async () => {
    saved = null;
    let entered!: () => void, finish!: () => void;
    const inside = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { finish = r; });
    vi.mocked(daemon.stopBridge).mockImplementation(async () => { entered(); await gate; return true; });
    const stopping = cli("stop"); await inside;
    await cli("supervisor", "install", "--json");
    expect(process.exitCode).toBe(1); expect(saved).toBeNull(); expect(update).not.toHaveBeenCalled();
    expect(tasks.installWindowsSupervisorTask).not.toHaveBeenCalled();
    finish(); await stopping;
    expect(saved).toBeNull();
  });
  it("stop racing first install cannot report completion; after install it observes and pauses config", async () => {
    saved = null;
    let entered!: () => void, finish!: () => void;
    const inside = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { finish = r; });
    vi.mocked(store.withSupervisorOperation).mockImplementationOnce(async (_root, action) => {
      entered(); await gate; return action({ readConfig: () => saved, updateConfig: update } as never);
    });
    const installing = cli("supervisor", "install", "--json"); await inside;
    await expect(cli("stop")).rejects.toMatchObject({ code: "MAINTENANCE_BUSY" });
    expect(daemon.stopBridge).not.toHaveBeenCalled();
    finish(); await installing;
    expect(saved).toMatchObject({ desiredState: "running" });
    await cli("stop"); expect(saved).toMatchObject({ desiredState: "stopped" });
    expect(daemon.stopBridge).toHaveBeenCalledTimes(1);
  });
});
