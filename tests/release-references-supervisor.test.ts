import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyGc } from "../src/core/gc-apply.js";
import { planGc } from "../src/core/gc-plan.js";
import { installCore } from "../src/core/install.js";
import { Workspace } from "../src/workspace/manager.js";
import { buildCoreFixture, cleanup, makeTmpDir, write } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach(cleanup);
  vi.unstubAllEnvs();
});

function fixture() {
  const state = makeTmpDir("gc-supervisor-state");
  const root = makeTmpDir("gc-supervisor-checkout");
  dirs.push(state, root);
  vi.stubEnv("C2C_STATE_DIR", state);
  write(root, "bin/c2c.js", "// fixture");
  write(root, "dist/cli/index.js", "// fixture");
  write(root, "package.json", '{"type":"module"}');
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  const releases = ["A", "B", "C"].map(marker => {
    write(root, "dist/cli/index.js", `// ${marker}`);
    return installCore(root, buildCoreFixture(root));
  });
  const workspace = new Workspace(root);
  const folder = path.join(state, "bridge-supervisor");
  fs.mkdirSync(folder, { recursive: true });
  return { state, root, releases, workspace, folder };
}

function runtimeRecord(workspace: Workspace, buildId: string, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    pid: 1,
    creationTime: "1",
    executable: process.execPath,
    startedAt: "2026-10-03T00:00:00.000Z",
    launcherPath: null,
    buildId,
    registrationMode: "none",
    nonce: randomUUID(),
    ...overrides,
  };
}

function launchPin(workspace: Workspace, buildId: string, nonce = randomUUID(), overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    buildId,
    nonce,
    launcherPath: path.join(workspace.root, "bin", "c2c.js"),
    createdAt: "2026-10-03T00:00:00.000Z",
    ...overrides,
  };
}

function gatewayRuntime(buildId: string, overrides: Record<string, unknown> = {}) {
  return { pid: 1234, creationTime: "fixture-creation:1", executable: process.execPath, buildId, ports: [48765], ...overrides };
}

function gatewayLaunch(stateDir: string, buildId: string, overrides: Record<string, unknown> = {}) {
  return { version: 1, scope: "machine", buildId, nonce: randomUUID(),
    launcherPath: path.join(stateDir, "bin", "c2c.js"), createdAt: "2026-10-03T00:00:00.000Z", ...overrides };
}

function remoteState(workspace: Workspace, controller?: Record<string, unknown>) {
  return { version: 1, workspaceId: workspace.id, workspaceRoot: workspace.root, enabled: true,
    threads: [], tasks: [], ...(controller ? { controller } : {}), audit: [] };
}

describe("supervisor release references", () => {
  it("post-handoff runtime alone protects the executing old release without a permanent startup pin", () => {
    const { state, workspace, releases, folder } = fixture();
    const oldBuild = releases[0].runtimeBuildId;
    fs.writeFileSync(path.join(folder, `${workspace.id}.runtime.json`), JSON.stringify(runtimeRecord(workspace, oldBuild,
      { pid: process.pid, registrationMode: "windows-scheduled-task" })));
    expect(fs.readdirSync(folder).filter(name => name.endsWith(".launch.json"))).toEqual([]);
    const plan = planGc(state);
    expect(plan.globalBlockerCount).toBe(0);
    expect(plan.releases.find(item => item.buildId === oldBuild)?.disposition).toBe("keep");
    const result = applyGc({ stateDir: state });
    expect(result).toMatchObject({ ok: true, totals: { deletedCount: 1 } });
    expect(fs.existsSync(releases[0].releaseRoot)).toBe(true);
    expect(fs.existsSync(releases[1].releaseRoot)).toBe(false);
  });
  it("pins stale supervisor runtime and launcher builds while ignoring canonical config and lock files", () => {
    const { state, workspace, releases, folder } = fixture();
    const oldBuild = releases[0].runtimeBuildId;
    const supervisorDir = path.join(folder, `${workspace.id}.runtime.json`);
    fs.writeFileSync(supervisorDir, JSON.stringify(runtimeRecord(workspace, oldBuild)));
    const nonce = randomUUID();
    fs.writeFileSync(path.join(folder, `${workspace.id}.${nonce}.launch.json`), JSON.stringify(launchPin(workspace, oldBuild, nonce)));

    for (const name of [
      `${workspace.id}.json`,
      `${workspace.id}.lock`,
      `${workspace.id}.operation.lock`,
      `${workspace.id}.lock.reclaim.lock`,
      `${workspace.id}.operation.lock.reclaim.lock`,
    ]) fs.writeFileSync(path.join(folder, name), "known non-reference file");

    const plan = planGc(state);
    expect(plan.globalBlockerCount).toBe(0);
    expect(plan.releases.find(item => item.buildId === oldBuild)?.disposition).toBe("keep");
    expect(plan.releases.find(item => item.buildId === releases[1].runtimeBuildId)?.disposition).toBe("delete-candidate");

    const result = applyGc({ stateDir: state });
    expect(result).toMatchObject({ ok: true, status: "success", globalBlockerCount: 0, totals: { deletedCount: 1 } });
    expect(fs.existsSync(releases[0].releaseRoot)).toBe(true);
    expect(fs.existsSync(releases[1].releaseRoot)).toBe(false);
    expect(fs.existsSync(releases[2].releaseRoot)).toBe(true);
  });

  it("treats missing runtime build identity as a global blocker and performs no deletion", () => {
    const { state, workspace, releases, folder } = fixture();
    fs.writeFileSync(path.join(folder, `${workspace.id}.runtime.json`), JSON.stringify(runtimeRecord(workspace, releases[0].runtimeBuildId, { buildId: null })));

    const plan = planGc(state);
    expect(plan.safety).toBe("blocked");
    expect(plan.globalBlockerCount).toBeGreaterThan(0);

    const result = applyGc({ stateDir: state });
    expect(result).toMatchObject({ ok: false, status: "blocked", totals: { deletedCount: 0 } });
    for (const release of releases) expect(fs.existsSync(release.releaseRoot)).toBe(true);
  });

  it("treats a launch pin with mismatched filename nonce as a global blocker", () => {
    const { state, workspace, releases, folder } = fixture();
    const filenameNonce = randomUUID();
    fs.writeFileSync(path.join(folder, `${workspace.id}.${filenameNonce}.launch.json`), JSON.stringify(
      launchPin(workspace, releases[0].runtimeBuildId, randomUUID()),
    ));

    const plan = planGc(state);
    expect(plan.safety).toBe("blocked");
    expect(plan.globalBlockerCount).toBeGreaterThan(0);
    expect(plan.releases.every(item => item.disposition !== "delete-candidate")).toBe(true);

    const result = applyGc({ stateDir: state });
    expect(result).toMatchObject({ ok: false, status: "blocked", totals: { deletedCount: 0 } });
    for (const release of releases) expect(fs.existsSync(release.releaseRoot)).toBe(true);
  });

  it("globally blocks on interrupted temporary or unknown supervisor entries", () => {
    const { state, workspace, folder } = fixture();
    fs.writeFileSync(path.join(folder, `${workspace.id}.runtime.${randomUUID()}.tmp`), "interrupted");

    const plan = planGc(state);
    expect(plan.safety).toBe("blocked");
    expect(plan.globalBlockerCount).toBeGreaterThan(0);
    expect(plan.issues.some(message => message.includes("unknown supervisor entry"))).toBe(true);
  });

  it("Gateway runtime and multiple nonce pins protect the machine release and allow known config temp files", () => {
    const { state, releases } = fixture();
    const folder = path.join(state, "gateway");
    fs.mkdirSync(folder, { recursive: true });
    const oldBuild = releases[0].runtimeBuildId;
    const nonces = [randomUUID(), randomUUID()];
    fs.writeFileSync(path.join(folder, "supervisor.runtime.json"), JSON.stringify(gatewayRuntime(oldBuild)));
    for (const nonce of nonces) {
      fs.writeFileSync(path.join(folder, `supervisor.${nonce}.launch.json`), JSON.stringify(gatewayLaunch(state, oldBuild, { nonce })));
    }
    for (const name of ["supervisor.json", "supervisor.lock", "server.lock", "workspaces.json",
      "workspaces.json.lock", "tunnel-runtime-key.dpapi", `workspaces.json.${randomUUID()}.tmp`, `supervisor.json.${randomUUID()}.tmp`]) {
      fs.writeFileSync(path.join(folder, name), "valid local Gateway state");
    }

    const plan = planGc(state);
    expect(plan.globalBlockerCount).toBe(0);
    expect(plan.releases.find(item => item.buildId === oldBuild)?.disposition).toBe("keep");
    expect(plan.releases.find(item => item.buildId === oldBuild)?.reasons).toEqual(expect.arrayContaining([
      "gateway-runtime", ...nonces.map(nonce => `gateway-launch:${nonce}`),
    ]));
    expect(plan.releases.find(item => item.buildId === releases[1].runtimeBuildId)?.disposition).toBe("delete-candidate");

    const result = applyGc({ stateDir: state });
    expect(result).toMatchObject({ ok: true, status: "success", globalBlockerCount: 0, totals: { deletedCount: 1 } });
    expect(fs.existsSync(releases[0].releaseRoot)).toBe(true);
    expect(fs.existsSync(releases[1].releaseRoot)).toBe(false);
    expect(fs.existsSync(releases[2].releaseRoot)).toBe(true);
  });

  it("blocks GC on corrupt Gateway runtime, mismatched launch identity, or unknown entries", () => {
    const { state, releases } = fixture();
    const folder = path.join(state, "gateway");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "supervisor.runtime.json"), JSON.stringify(gatewayRuntime(releases[0].runtimeBuildId, { buildId: null })));
    const filenameNonce = randomUUID();
    fs.writeFileSync(path.join(folder, `supervisor.${filenameNonce}.launch.json`), JSON.stringify(gatewayLaunch(state, releases[0].runtimeBuildId,
      { nonce: randomUUID() })));
    const identityNonce = randomUUID();
    fs.writeFileSync(path.join(folder, `supervisor.${identityNonce}.launch.json`), JSON.stringify(gatewayLaunch(state, releases[0].runtimeBuildId,
      { nonce: identityNonce, launcherPath: path.join(state, "other", "c2c.js") })));
    fs.writeFileSync(path.join(folder, `supervisor.runtime.${randomUUID()}.tmp`), "interrupted runtime write");
    fs.writeFileSync(path.join(folder, "unrecognized-entry"), "preserve");

    const plan = planGc(state);
    expect(plan.safety).toBe("blocked");
    expect(plan.globalBlockerCount).toBeGreaterThan(0);
    expect(plan.issues.some(message => message.includes("gateway runtime or launch pin"))).toBe(true);
    expect(plan.issues.some(message => message.includes("launch pin filename nonce"))).toBe(true);
    expect(plan.issues.some(message => message.includes("stable launcher path"))).toBe(true);
    expect(plan.issues.some(message => message.includes("unknown gateway entry"))).toBe(true);

    const result = applyGc({ stateDir: state });
    expect(result).toMatchObject({ ok: false, status: "blocked", totals: { deletedCount: 0 } });
    for (const release of releases) expect(fs.existsSync(release.releaseRoot)).toBe(true);
  });
});

describe("remote Controller release references", () => {
  it("keeps the current Bridge build and a different registered Controller build", () => {
    const { state, workspace, releases } = fixture();
    const bridgeBuild = releases[2]!.runtimeBuildId;
    const controllerBuild = releases[0]!.runtimeBuildId;
    fs.mkdirSync(path.join(state, "runtime"), { recursive: true });
    fs.writeFileSync(path.join(state, "runtime", `${workspace.id}.json`), JSON.stringify({
      workspaceId: workspace.id, workspaceRoot: workspace.root, runtimeBuildId: bridgeBuild,
    }));
    const remoteDir = path.join(state, "remote-control");
    fs.mkdirSync(remoteDir, { recursive: true });
    fs.writeFileSync(path.join(remoteDir, `${workspace.id}.json`), JSON.stringify(remoteState(workspace, {
      pid: 1234, instanceId: randomUUID(), heartbeatAt: 0, appServer: "running", buildId: controllerBuild,
    })));

    const plan = planGc(state);
    expect(plan.globalBlockerCount).toBe(0);
    expect(plan.releases.find(item => item.buildId === bridgeBuild)).toMatchObject({ disposition: "keep" });
    expect(plan.releases.find(item => item.buildId === controllerBuild)).toMatchObject({
      disposition: "keep", reasons: [`remote-controller:${workspace.id}`],
    });
    expect(plan.releases.find(item => item.buildId === releases[1]!.runtimeBuildId)?.disposition).toBe("delete-candidate");
  });

  it.each(["missing", "null"] as const)("blocks GC when a legacy/source Controller has %s buildId", missing => {
    const { state, workspace, releases } = fixture();
    const folder = path.join(state, "remote-control");
    fs.mkdirSync(folder, { recursive: true });
    const controller: Record<string, unknown> = { pid: 1234, instanceId: randomUUID(), heartbeatAt: 0, appServer: "running" };
    if (missing === "null") controller.buildId = null;
    fs.writeFileSync(path.join(folder, `${workspace.id}.json`), JSON.stringify(remoteState(workspace, controller)));

    const plan = planGc(state);
    expect(plan.safety).toBe("blocked");
    expect(plan.globalBlockerCount).toBeGreaterThan(0);
    expect(plan.issueDetails.some(item => item.code === "remote_missing_build_id")).toBe(true);
    expect(plan.releases.every(item => item.disposition !== "delete-candidate")).toBe(true);
    const result = applyGc({ stateDir: state });
    expect(result).toMatchObject({ ok: false, status: "blocked", totals: { deletedCount: 0 } });
    for (const release of releases) expect(fs.existsSync(release.releaseRoot)).toBe(true);
  });

  it("does not reference a release after a valid stopped state has no Controller runtime", () => {
    const { state, workspace, releases } = fixture();
    const folder = path.join(state, "remote-control");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `${workspace.id}.json`), JSON.stringify(remoteState(workspace)));

    const plan = planGc(state);
    expect(plan.globalBlockerCount).toBe(0);
    expect(plan.releases.find(item => item.buildId === releases[0]!.runtimeBuildId)?.disposition).toBe("delete-candidate");
  });

  it("blocks GC on invalid remote state", () => {
    const { state, workspace, releases } = fixture();
    const folder = path.join(state, "remote-control");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `${workspace.id}.json`), "{broken");

    const plan = planGc(state);
    expect(plan.safety).toBe("blocked");
    expect(plan.globalBlockerCount).toBeGreaterThan(0);
    expect(plan.issueDetails.some(item => item.code === "remote_corrupt")).toBe(true);
    const result = applyGc({ stateDir: state });
    expect(result).toMatchObject({ ok: false, status: "blocked", totals: { deletedCount: 0 } });
    for (const release of releases) expect(fs.existsSync(release.releaseRoot)).toBe(true);
  });
});
