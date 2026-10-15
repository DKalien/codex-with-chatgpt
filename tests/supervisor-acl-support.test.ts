import fs from "node:fs";
import path from "node:path";
import * as childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTmpDir } from "./helpers.js";
import { cleanupStrict } from "./strict-teardown.js";
import { finishSupervisorFixtures, observeSupervisorAclCall, prepareSupervisorFixtureStore, preserveSupervisorFailure, type SupervisorAclCall } from "./supervisor-acl-support.js";
import { readSupervisorConfig } from "../src/supervisor/store.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), execFileSync: execute,
}));

const roots: string[] = [];
const evidenceDirs: string[] = [];
const diagnosticRoot = path.resolve(".tooling/supervisor-acl-diagnostics");
function fixture(): string { const root = makeTmpDir("supervisor-evidence-support"); roots.push(root); return root; }

afterEach(async () => {
  vi.restoreAllMocks();
  execute.mockReset();
  await cleanupStrict(...roots.splice(0));
  for (const directory of evidenceDirs.splice(0)) {
    if (path.dirname(directory) !== diagnosticRoot) throw new Error("unexpected evidence teardown target");
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("supervisor fixture store initialization", () => {
  it("rejects outside roots, file roots and existing children before executing ACL setup", () => {
    expect(() => prepareSupervisorFixtureStore(path.resolve("src"))).toThrow(/outside test-tmp/);
    const root = fixture(), file = path.join(root, "file");
    fs.writeFileSync(file, "ordinary file");
    expect(() => prepareSupervisorFixtureStore(file)).toThrow(/not canonical/);
    const child = path.join(root, "bridge-supervisor");
    fs.mkdirSync(child);
    expect(() => prepareSupervisorFixtureStore(root)).toThrow(/EEXIST/);
    expect(fs.readdirSync(child)).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses one bounded Windows ACL call and preserves subprocess failures without retry", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      const root = fixture();
      execute.mockReturnValueOnce("OK:S-1-5-21\n");
      prepareSupervisorFixtureStore(root);
      expect(execute).toHaveBeenCalledTimes(1);
      const [executable, args, options] = execute.mock.calls[0];
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
      expect(executable).toBe(path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
      expect(args.slice(0, -1)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
      expect(args.at(-1)).toContain("$acl.SetOwner($identity)");
      expect(args.at(-1)).toContain("Set-Acl -LiteralPath $target -AclObject $acl");
      expect(args.at(-1)).not.toContain("SetAccessControl");
      expect(options).toMatchObject({ timeout: 15_000, maxBuffer: 16 * 1024, windowsHide: true, encoding: "utf8", stdio: "pipe" });
      expect(options.env).toEqual({ SystemRoot: systemRoot, WINDIR: process.env.WINDIR ?? systemRoot,
        PATH: process.env.PATH ?? "", TEMP: process.env.TEMP ?? "", TMP: process.env.TMP ?? "", USERPROFILE: process.env.USERPROFILE ?? "",
        C2C_SUPERVISOR_ACL_TARGETS: JSON.stringify([{ path: path.join(root, "bridge-supervisor"), mode: "set-directory" }]) });
      const original = Object.assign(new Error("raw timeout"), { code: "ETIMEDOUT" });
      execute.mockImplementationOnce(() => { throw original; });
      try { prepareSupervisorFixtureStore(fixture()); throw new Error("did not fail"); }
      catch (error) { expect(error).toBe(original); }
      expect(execute).toHaveBeenCalledTimes(2);
      execute.mockReturnValueOnce("unexpected stdout");
      expect(() => prepareSupervisorFixtureStore(fixture())).toThrow(/invalid fixture ACL output/);
      expect(execute).toHaveBeenCalledTimes(3);
    } finally { Object.defineProperty(process, "platform", platform); }
  });

  it("creates a private non-Windows directory without executing a subprocess", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const realPlatform = process.platform;
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    try {
      const root = fixture();
      prepareSupervisorFixtureStore(root);
      const stat = fs.statSync(path.join(root, "bridge-supervisor"));
      expect(stat.isDirectory()).toBe(true);
      // Windows chmod 不证明 POSIX 权限；mode 仅在真实非 Windows 主机验证。
      if (realPlatform !== "win32") expect(stat.mode & 0o777).toBe(0o700);
      expect(execute).not.toHaveBeenCalled();
    } finally { Object.defineProperty(process, "platform", platform); }
  });
});

describe("supervisor failed fixture evidence", () => {
  it("passes exact subprocess arguments, output and error identity without retry", () => {
    const records: SupervisorAclCall[] = [];
    const original = Object.assign(new Error("raw test failure"), { code: "ETIMEDOUT", status: null, signal: "SIGTERM", stderr: "raw stderr" });
    const call = vi.fn().mockReturnValueOnce("OK:S-1-5").mockImplementationOnce(() => { throw original; });
    const observed = observeSupervisorAclCall(records, call);
    const args = ["-Command", "exact script"];
    const options = { timeout: 8000, env: { C2C_SUPERVISOR_ACL_TARGETS: '[{"path":"fixture","mode":"verify-directory"}]' } };
    expect(observed("powershell.exe", args, options)).toBe("OK:S-1-5");
    try { observed("powershell.exe", args, options); throw new Error("did not fail"); }
    catch (error) { expect(error).toBe(original); }
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0]).toEqual(["powershell.exe", args, options]);
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ success: false, error: { code: "ETIMEDOUT", status: null, signal: "SIGTERM", stderr: "raw stderr" } });
  });

  it("observes the real public store wrapper without replacing its safe failure", () => {
    const root = fixture();
    const workspace = fixture();
    fs.mkdirSync(path.join(root, "bridge-supervisor"));
    const records: SupervisorAclCall[] = [];
    const raw = Object.assign(new Error("only ignored evidence gets this"), { code: "ETIMEDOUT", status: null, signal: "SIGTERM" });
    execute.mockImplementation(observeSupervisorAclCall(records, (() => { throw raw; }) as typeof childProcess.execFileSync));
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try { expect(() => readSupervisorConfig(workspace, { stateDir: root })).toThrow(/classification=timeout/); }
    finally { Object.defineProperty(process, "platform", platform); }
    expect(records).toHaveLength(1);
    expect(records[0].targets).toEqual([{ path: path.join(root, "bridge-supervisor"), mode: "verify-directory" }]);
  });

  it("keeps passing fixtures on strict teardown without a diagnostic subprocess", async () => {
    const root = fixture();
    const spawn = execute;
    expect(await finishSupervisorFixtures(false, "passed", [root], [], [])).toBeNull();
    expect(fs.existsSync(root)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("copies exact failure content and ACL evidence before strict teardown", async () => {
    const root = fixture();
    fs.mkdirSync(path.join(root, "bridge-supervisor"));
    const source = path.join(root, "bridge-supervisor", "config.json");
    fs.writeFileSync(source, '{"original":"exact fixture"}');
    const acl = JSON.stringify({ path: source, ownerSid: "S-1-5-21-test", sddl: "original-sddl", protected: true });
    const spawn = execute.mockReturnValue(acl + "\n");
    const evidence = (await finishSupervisorFixtures(true, "failed case", [root], [], [{ message: "safe error" }]))!;
    evidenceDirs.push(evidence);
    expect(fs.existsSync(root)).toBe(false);
    const metadata = JSON.parse(fs.readFileSync(path.join(evidence, "fixture.json"), "utf8"));
    expect(metadata.roots).toEqual([root]);
    const file = metadata.entries.find((entry: { path: string }) => entry.path === source);
    expect(fs.readFileSync(file.copy, "utf8")).toBe('{"original":"exact fixture"}');
    if (process.platform === "win32") {
      expect(fs.readFileSync(path.join(evidence, "original-acls.jsonl"), "utf8")).toContain("original-sddl");
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0][2]).toMatchObject({ timeout: 15_000, windowsHide: true });
    }
  });

  it("retains originals and saved raw evidence if ACL observation itself fails", async () => {
    if (process.platform !== "win32") return;
    const root = fixture();
    execute.mockImplementation(() => { throw Object.assign(new Error("observer timeout"), { code: "ETIMEDOUT", stderr: "read-only observer" }); });
    const before = new Set(fs.existsSync(diagnosticRoot) ? fs.readdirSync(diagnosticRoot) : []);
    await expect(finishSupervisorFixtures(true, "failed", [root], [], [])).rejects.toThrow(/original fixtures retained/);
    const created = fs.readdirSync(diagnosticRoot).filter(name => !before.has(name)).map(name => path.join(diagnosticRoot, name));
    evidenceDirs.push(...created);
    expect(created).toHaveLength(1);
    expect(fs.existsSync(root)).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(created[0], "acl-capture-error.json"), "utf8"))).toMatchObject({ code: "ETIMEDOUT" });
  });

  it("rejects outside roots before copying or reading ACLs", () => {
    const spawn = execute;
    expect(() => preserveSupervisorFailure("invalid", [path.resolve("src")], [], [])).toThrow(/outside test-tmp/);
    expect(spawn).not.toHaveBeenCalled();
  });
});
