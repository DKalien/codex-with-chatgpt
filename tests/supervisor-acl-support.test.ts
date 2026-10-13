import fs from "node:fs";
import path from "node:path";
import * as childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTmpDir } from "./helpers.js";
import { cleanupStrict } from "./strict-teardown.js";
import { finishSupervisorFixtures, observeSupervisorAclCall, preserveSupervisorFailure, type SupervisorAclCall } from "./supervisor-acl-support.js";
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
