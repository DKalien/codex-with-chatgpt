import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildWindowsSupervisorTaskDefinition,
  inspectWindowsSupervisorTask,
  installWindowsSupervisorTask,
  uninstallWindowsSupervisorTask,
  WindowsTaskError,
  windowsTaskProjection,
  type WindowsSupervisorTaskDefinition,
  type WindowsTaskBackend,
} from "../src/supervisor/windows-task.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanupStrict } from "./strict-teardown.js";
import { makeTmpDir } from "./helpers.js";

const SID = "S-1-5-21-3364093238-1480622596-1616451996-1001";
let workspaceRoot: string;
let stateDir: string;
let fixtureDirs: string[];

function makeInput() { return { workspaceRoot, stateDir }; }

class FakeTaskBackend implements WindowsTaskBackend {
  platform = "win32";
  available = true;
  sid: string | null = SID;
  installed: unknown = null;
  exactOverride: boolean | undefined;
  registerCount = 0;
  removeCount = 0;
  beforeRemove: (() => void) | null = null;
  registerError: WindowsTaskError | null = null;

  capability() {
    return this.available ? { available: true } : { available: false, errorCode: "SCHEDULER_UNAVAILABLE" as const };
  }
  currentUserSid() { return this.sid; }
  read(_taskName: string, expected: WindowsSupervisorTaskDefinition) {
    if (this.installed === null) return { exists: false };
    return {
      exists: true,
      definition: structuredClone(this.installed),
      exact: this.exactOverride ?? isDeepStrictEqual(this.installed, windowsTaskProjection(expected)),
    };
  }
  register(definition: WindowsSupervisorTaskDefinition) {
    this.registerCount++;
    if (this.registerError) throw this.registerError;
    if (this.installed !== null) throw new WindowsTaskError("TASK_CONFLICT");
    this.installed = windowsTaskProjection(definition);
  }
  removeIfExact(definition: WindowsSupervisorTaskDefinition) {
    this.removeCount++;
    this.beforeRemove?.();
    if (!isDeepStrictEqual(this.installed, windowsTaskProjection(definition))) return false;
    this.installed = null;
    return true;
  }
}

beforeEach(() => {
  workspaceRoot = makeTmpDir("supervisor workspace");
  stateDir = makeTmpDir("supervisor state");
  fixtureDirs = [workspaceRoot, stateDir];
  fs.mkdirSync(path.join(stateDir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "bin", "c2c.js"), "// stable launcher fixture\n");
});

afterEach(async () => cleanupStrict(...fixtureDirs));

describe("Windows supervisor scheduled-task definition", () => {
  it("binds exact workspace SID to the stable launcher with least privilege and bounded restart settings", () => {
    const definition = buildWindowsSupervisorTaskDefinition({ ...makeInput(), userSid: SID });
    const workspace = new Workspace(workspaceRoot);
    const expectedArgs = [definition.stableLauncher, "supervisor", "run", "-w", workspace.root, "--state-dir", stateDir];

    expect(definition.workspaceId).toBe(workspace.id);
    expect(definition.taskName).toBe(`CodexWithChatGPT-${workspace.id}`);
    expect(definition.taskPath).toBe("\\");
    expect(definition.workspaceRoot).toBe(workspace.root);
    expect(definition.stableLauncher).toBe(path.join(stateDir, "bin", "c2c.js"));
    expect(definition.action.execute).toBe(fs.realpathSync.native(process.execPath));
    expect(definition.action.arguments).toEqual(expectedArgs);
    expect(definition.action.commandLine).toContain('"supervisor"');
    expect(definition.action.commandLine).toContain('"--state-dir"');
    expect(definition.trigger).toEqual({ type: "AtLogOn", userId: SID, enabled: true });
    expect(definition.principal).toEqual({ userId: SID, logonType: "InteractiveToken", runLevel: "Limited" });
    expect(definition.settings).toEqual({
      startWhenAvailable: true,
      multipleInstances: "IgnoreNew",
      executionTimeLimit: "PT0S",
      restartCount: 3,
      restartInterval: "PT1M",
    });
    expect(JSON.stringify(definition.action.arguments).toLowerCase()).not.toMatch(/oauth|token|credential|secret|conversation/);
  });

  it("rejects invalid SID and a missing/noncanonical stable launcher", () => {
    expect(() => buildWindowsSupervisorTaskDefinition({ ...makeInput(), userSid: "10630" })).toThrow(WindowsTaskError);
    fs.unlinkSync(path.join(stateDir, "bin", "c2c.js"));
    const otherFile = path.join(workspaceRoot, "c2c.js");
    fs.writeFileSync(otherFile, "// not an independent launcher\n");
    fs.linkSync(otherFile, path.join(stateDir, "bin", "c2c.js"));
    expect(() => buildWindowsSupervisorTaskDefinition({ ...makeInput(), userSid: SID })).toThrow(WindowsTaskError);
  });
});

describe("Windows supervisor scheduled-task ownership", () => {
  it("reports unsupported platform, missing capability, and missing current SID without registration", () => {
    const backend = new FakeTaskBackend();
    backend.platform = "linux";
    expect(inspectWindowsSupervisorTask(makeInput(), backend)).toMatchObject({ status: "unsupported", errorCode: "UNSUPPORTED_PLATFORM" });
    backend.platform = "win32";
    backend.available = false;
    expect(inspectWindowsSupervisorTask(makeInput(), backend)).toMatchObject({ status: "unsupported", errorCode: "SCHEDULER_UNAVAILABLE" });
    backend.available = true;
    backend.sid = null;
    expect(inspectWindowsSupervisorTask(makeInput(), backend)).toMatchObject({ status: "unsupported", errorCode: "CURRENT_USER_SID_UNAVAILABLE" });
    expect(backend.registerCount).toBe(0);
  });

  it("installs once, verifies exact replay, and returns only the expected definition", () => {
    const backend = new FakeTaskBackend();
    expect(inspectWindowsSupervisorTask(makeInput(), backend)).toMatchObject({ status: "absent" });
    expect(installWindowsSupervisorTask(makeInput(), backend).status).toBe("installed");
    expect(installWindowsSupervisorTask(makeInput(), backend).status).toBe("already_installed");
    expect(backend.registerCount).toBe(1);
    const status = inspectWindowsSupervisorTask(makeInput(), backend);
    expect(status.status).toBe("owned");
    expect(status.definition?.taskName).toBe(`CodexWithChatGPT-${new Workspace(workspaceRoot).id}`);
    expect(status).not.toHaveProperty("observedDefinition");
    expect(status).not.toHaveProperty("rawArguments");
  });

  it.each([
    ["extra action", (value: ReturnType<typeof windowsTaskProjection>) => value.actions.push({ ...value.actions[0]!, id: "unexpected" })],
    ["changed action", (value: ReturnType<typeof windowsTaskProjection>) => { value.actions[0]!.arguments += " --unexpected"; }],
    ["extra trigger", (value: ReturnType<typeof windowsTaskProjection>) => value.triggers.push({ ...value.triggers[0]!, userId: "S-1-5-18" })],
    ["changed principal", (value: ReturnType<typeof windowsTaskProjection>) => { value.principal.logonType = "Password"; }],
    ["changed setting", (value: ReturnType<typeof windowsTaskProjection>) => { value.settings.startWhenAvailable = false; }],
  ])("treats %s as a conflict and never overwrites it", (_case, mutate) => {
    const backend = new FakeTaskBackend();
    const definition = buildWindowsSupervisorTaskDefinition({ ...makeInput(), userSid: SID });
    const foreign = windowsTaskProjection(definition);
    mutate(foreign);
    backend.installed = foreign;
    expect(inspectWindowsSupervisorTask(makeInput(), backend).status).toBe("conflict");
    expect(() => installWindowsSupervisorTask(makeInput(), backend)).toThrowError(expect.objectContaining({ code: "TASK_CONFLICT" }));
    expect(backend.registerCount).toBe(0);
    expect(backend.installed).toEqual(foreign);
  });

  it("treats drift in an additional Scheduler setting as a conflict", () => {
    const backend = new FakeTaskBackend();
    const definition = buildWindowsSupervisorTaskDefinition({ ...makeInput(), userSid: SID });
    backend.installed = windowsTaskProjection(definition);
    // The real backend compares every CIM setting; this marks an otherwise matching projection as drifted.
    backend.exactOverride = false;
    expect(inspectWindowsSupervisorTask(makeInput(), backend).status).toBe("conflict");
  });

  it("uninstalls only a freshly rechecked exact owned task", () => {
    const backend = new FakeTaskBackend();
    installWindowsSupervisorTask(makeInput(), backend);
    expect(uninstallWindowsSupervisorTask(makeInput(), backend).status).toBe("removed");
    expect(backend.removeCount).toBe(1);
    expect(uninstallWindowsSupervisorTask(makeInput(), backend).status).toBe("absent");

    installWindowsSupervisorTask(makeInput(), backend);
    backend.beforeRemove = () => { (backend.installed as ReturnType<typeof windowsTaskProjection>).settings.hidden = true; };
    expect(() => uninstallWindowsSupervisorTask(makeInput(), backend)).toThrowError(expect.objectContaining({ code: "TASK_CONFLICT" }));
    expect(backend.installed).not.toBeNull();
  });

  it("preserves a foreign same-name task and exposes bounded permission errors", () => {
    const backend = new FakeTaskBackend();
    const definition = buildWindowsSupervisorTaskDefinition({ ...makeInput(), userSid: SID });
    backend.installed = windowsTaskProjection(definition);
    backend.exactOverride = false;
    expect(() => uninstallWindowsSupervisorTask(makeInput(), backend)).toThrowError(expect.objectContaining({ code: "TASK_CONFLICT" }));
    expect(backend.removeCount).toBe(0);

    backend.installed = null;
    backend.registerError = new WindowsTaskError("PERMISSION_DENIED");
    expect(() => installWindowsSupervisorTask(makeInput(), backend)).toThrowError(expect.objectContaining({ code: "PERMISSION_DENIED" }));
    expect(backend.installed).toBeNull();
  });
});
