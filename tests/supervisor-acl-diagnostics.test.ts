import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFileSync: execFileSyncMock,
}));

import { readSupervisorConfig, SupervisorStoreError } from "../src/supervisor/store.js";
import { makeTmpDir } from "./helpers.js";
import { cleanupStrict } from "./strict-teardown.js";

const roots: string[] = [];
let workspaceRoot: string;
let stateDir: string;

function fixture() {
  stateDir = makeTmpDir("supervisor-acl-state");
  workspaceRoot = makeTmpDir("supervisor-acl-workspace");
  roots.push(stateDir, workspaceRoot);
  fs.mkdirSync(path.join(stateDir, "bridge-supervisor"));
}

function onWindows<T>(action: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (!descriptor) throw new Error("process.platform descriptor missing");
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try { return action(); }
  finally { Object.defineProperty(process, "platform", descriptor); }
}

function captureError(action: () => unknown): Error {
  try { action(); }
  catch (error) { return error as Error; }
  throw new Error("expected supervisor ACL check to fail");
}

type AclError = Error & {
  code: string;
  classification: string;
  durationMs: number;
  exitCode?: number;
  signal?: string;
};

function rawChildFailure(fields: Record<string, unknown> = {}): Error {
  return Object.assign(new Error("RAW_ACL_ERROR_MESSAGE"), {
    code: "RAW_ACL_ERROR_CODE",
    status: null,
    signal: "SIG_CUSTOM_SECRET",
    path: "C:\\private\\RAW_ACL_TARGET_PATH",
    ownerSid: "S-1-5-21-RAW_ACL_SID_SECRET",
    stdout: "RAW_ACL_STDOUT",
    stderr: "RAW_ACL_STDERR",
    env: { RAW_ACL_ENV_SECRET: "RAW_ACL_ENV_VALUE" },
    cause: new Error("RAW_ACL_CAUSE"),
    ...fields,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await cleanupStrict(...roots.splice(0));
});

describe("supervisor Windows ACL diagnostics", () => {
  it("keeps the owner-only script, timeout and child environment contract on the public read path", () => {
    execFileSyncMock.mockReturnValue("OK:S-1-5-21-100-200-300-1000\r\n");
    vi.stubEnv("C2C_ACL_DIAGNOSTICS_SECRET", "RAW_ACL_ENV_SECRET");

    expect(onWindows(() => readSupervisorConfig(workspaceRoot, { stateDir }))).toBeNull();

    const [executable, args, options] = execFileSyncMock.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
    expect(executable).toBe(path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
    expect(args.slice(0, 6)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);
    expect(createHash("sha256").update(args[6]).digest("hex")).toBe("55e3ddeb322922c4c0ee9c4b94a8179377377c050792bdd7ba945b77da65e6bf");
    expect(options).toMatchObject({ encoding: "utf8", windowsHide: true, timeout: 8000, maxBuffer: 16 * 1024, stdio: "pipe" });
    const env = options.env as Record<string, string>;
    expect(Object.keys(env).sort()).toEqual([
      "C2C_SUPERVISOR_ACL_TARGETS", "PATH", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "WINDIR",
    ]);
    expect(JSON.parse(env.C2C_SUPERVISOR_ACL_TARGETS)).toEqual([{ path: path.join(stateDir, "bridge-supervisor"), mode: "verify-directory" }]);
    expect(env).not.toHaveProperty("C2C_ACL_DIAGNOSTICS_SECRET");
  });

  it.each([
    { name: "timeout", fields: { code: "ETIMEDOUT", signal: "SIGTERM", killed: true }, classification: "timeout", signal: "SIGTERM" },
    { name: "nonzero", fields: { status: 9999 }, classification: "nonzero", exitCode: 9999 },
    { name: "spawn failure", fields: { code: "ENOENT" }, classification: "spawn_failure" },
    { name: "interrupted", fields: { code: "EINTR", signal: "SIGINT" }, classification: "interrupted", signal: "SIGINT" },
    { name: "execution failure", fields: { status: "RAW_STATUS", signal: "SIG_CUSTOM_SECRET" }, classification: "execution_failure" },
  ])("classifies $name without exposing child error details", ({ fields, classification, exitCode, signal }) => {
    execFileSyncMock.mockImplementation(() => { throw rawChildFailure(fields); });
    const error = onWindows(() => captureError(() => readSupervisorConfig(workspaceRoot, { stateDir }))) as AclError;
    const safeDetails = `${error.message}\n${JSON.stringify(error)}`;

    expect(error).toBeInstanceOf(SupervisorStoreError);
    expect(error).toMatchObject({ code: "SUPERVISOR_STORE_SECURITY", classification });
    expect(Number.isInteger(error.durationMs)).toBe(true);
    expect(error.durationMs).toBeGreaterThanOrEqual(0);
    expect(error.durationMs).toBeLessThanOrEqual(60_000);
    if (exitCode !== undefined) expect(error.exitCode).toBe(exitCode);
    else expect(error).not.toHaveProperty("exitCode");
    if (signal !== undefined) expect(error.signal).toBe(signal);
    else expect(error).not.toHaveProperty("signal");
    expect(Object.keys(error)).toEqual(expect.arrayContaining(["code", "classification", "durationMs"]));
    for (const secret of [
      "RAW_ACL_ERROR_MESSAGE", "RAW_ACL_ERROR_CODE", "RAW_ACL_TARGET_PATH", "RAW_ACL_SID_SECRET", "RAW_ACL_STDOUT", "RAW_ACL_STDERR",
      "RAW_ACL_ENV_SECRET", "RAW_ACL_ENV_VALUE", "RAW_ACL_CAUSE", "SIG_CUSTOM_SECRET", workspaceRoot, stateDir,
    ]) expect(safeDetails).not.toContain(secret);
    expect(error).not.toHaveProperty("cause");
    expect(error).not.toHaveProperty("stdout");
    expect(error).not.toHaveProperty("stderr");
  });

  it("bounds measured duration without hiding timeout overrun", () => {
    execFileSyncMock.mockImplementation(() => { throw rawChildFailure({ code: "ETIMEDOUT" }); });
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(100_000);
    const error = onWindows(() => captureError(() => readSupervisorConfig(workspaceRoot, { stateDir }))) as AclError;
    expect(error.durationMs).toBe(60_000);
  });

  it("reports the observed overrun separately from the unchanged 8000ms deadline", () => {
    execFileSyncMock.mockImplementation(() => { throw rawChildFailure({ code: "ETIMEDOUT" }); });
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(8027);
    const error = onWindows(() => captureError(() => readSupervisorConfig(workspaceRoot, { stateDir }))) as AclError;
    expect(error.durationMs).toBe(8027);
    expect(execFileSyncMock.mock.calls[0][2]).toMatchObject({ timeout: 8000 });
  });

  it.each(["RAW_INVALID_ACL_OUTPUT", "OK:S-1", "OK:S-1-5-21-100\nextra output"])("fails closed for invalid ACL output %j", output => {
    execFileSyncMock.mockReturnValue(output);
    const error = onWindows(() => captureError(() => readSupervisorConfig(workspaceRoot, { stateDir }))) as AclError;
    const safeDetails = `${error.message}\n${JSON.stringify(error)}`;
    expect(error).toMatchObject({ code: "SUPERVISOR_STORE_SECURITY", classification: "invalid_output" });
    expect(error.message).toContain("supervisor owner-only Windows ACL verification failed");
    expect(safeDetails).not.toContain(output);
    expect(safeDetails).not.toContain(workspaceRoot);
    expect(safeDetails).not.toContain(stateDir);
  });
});
