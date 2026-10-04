import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Workspace } from "../src/workspace/manager.js";
import { makeTmpDir } from "./helpers.js";
import { cleanupStrict } from "./strict-teardown.js";

const dirs: string[] = [];
afterEach(async () => { await cleanupStrict(...dirs.splice(0)); });
function fixture() {
  const root = makeTmpDir("supervisor-launcher"); dirs.push(root);
  const workspace = new Workspace(root), stateDir = path.join(root, "state"), buildId = "a".repeat(64);
  const bin = path.join(stateDir, "bin"), folder = path.join(stateDir, "bridge-supervisor");
  const releaseRoot = path.join(stateDir, "releases", buildId);
  for (const dir of [bin, folder, path.join(releaseRoot, "bin")]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "package.json"), JSON.stringify({ type: "commonjs" }));
  const launcher = path.join(bin, "c2c.js");
  fs.copyFileSync("scripts/core-launcher.cjs", launcher);
  fs.writeFileSync(path.join(folder, `${workspace.id}.json`), JSON.stringify({ workspaceId: workspace.id, workspaceRoot: root }));
  fs.writeFileSync(path.join(stateDir, "current.json"), JSON.stringify({ releaseRoot, runtimeBuildId: buildId }));
  fs.writeFileSync(path.join(bin, "core-release.cjs"), `const fs=require('node:fs'),path=require('node:path');
module.exports={readCurrent(state){if(!fs.existsSync(path.join(state,'maintenance.lock')))throw Error('READ_WITHOUT_MAINTENANCE');return JSON.parse(fs.readFileSync(path.join(state,'current.json'),'utf8'));},
tryAcquireMaintenanceLock(state){const file=path.join(state,'maintenance.lock');if(fs.existsSync(file))return {ok:false};fs.writeFileSync(file,'lock',{flag:'wx'});return {ok:true,release(){fs.unlinkSync(file);return true;}};}};`);
  const child = path.join(releaseRoot, "bin", "c2c.js");
  fs.writeFileSync(child, `const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const pin=process.env.C2C_SUPERVISOR_LAUNCH_PIN,info=JSON.parse(fs.readFileSync(pin,'utf8'));
const identity=JSON.parse(process.env.C2C_SUPERVISOR_LAUNCH_IDENTITY),stat=fs.statSync(pin);
for(const key of ['dev','ino','size','mtimeMs','ctimeMs']) assert.equal(identity[key],stat[key]);
assert.equal(identity.sha256,crypto.createHash('sha256').update(fs.readFileSync(pin)).digest('hex'));
if(fs.existsSync(path.join(path.dirname(path.dirname(pin)),'maintenance.lock')))throw Error('LOCK_HELD_DURING_CHILD');
fs.writeFileSync(path.join(path.dirname(pin),'observed.txt'),JSON.stringify(info));`);
  const run = () => spawnSync(process.execPath, [launcher, "supervisor", "run", "-w", root, "--state-dir", stateDir], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  return { root, workspace, stateDir, folder, launcher, child, releaseRoot, buildId, run };
}
describe("stable launcher supervisor release pin", () => {
  it("pins selected code before release execution; a child exit without runtime handoff retains the startup pin", () => {
    const f = fixture(); const result = f.run();
    expect(result.status, result.stderr).toBe(0);
    const observed = JSON.parse(fs.readFileSync(path.join(f.folder, "observed.txt"), "utf8"));
    expect(observed).toMatchObject({ workspaceId: f.workspace.id, workspaceRoot: f.root, buildId: f.buildId, launcherPath: f.launcher });
    expect(fs.readdirSync(f.folder).filter(name => name.endsWith(".launch.json"))).toHaveLength(1);
    expect(fs.existsSync(path.join(f.stateDir, "maintenance.lock"))).toBe(false);
  });
  it("maintenance busy means no release execution and no launch reference creation", () => {
    const f = fixture(); fs.writeFileSync(path.join(f.stateDir, "maintenance.lock"), "other");
    const result = f.run(); expect(result.status).toBe(1); expect(result.stderr).toContain("MAINTENANCE_BUSY");
    expect(fs.existsSync(path.join(f.folder, "observed.txt"))).toBe(false);
    expect(fs.readdirSync(f.folder).filter(name => name.endsWith(".launch.json"))).toEqual([]);
  });
  it("child failure before handoff retains the pin and propagates the failure", () => {
    const f = fixture(); fs.appendFileSync(f.child, "\nfs.appendFileSync(pin,' '); process.exitCode=7;");
    const result = f.run(); expect(result.status).toBe(7);
    expect(fs.readdirSync(f.folder).filter(name => name.endsWith(".launch.json"))).toHaveLength(1);
  });
  it("does not require the pin to survive a successful child handoff", () => {
    const f = fixture();
    // Real store handoff and durable runtime ownership are exercised by store tests.
    fs.appendFileSync(f.child, "\nfs.unlinkSync(pin); process.exitCode=0;");
    const result = f.run(); expect(result.status, result.stderr).toBe(0);
    expect(fs.readdirSync(f.folder).filter(name => name.endsWith(".launch.json"))).toEqual([]);
  });
});
