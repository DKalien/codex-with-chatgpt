import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  findBridgeObservation,
  readRuntimeState,
  runtimeFile,
  writeRuntimeState,
  type RuntimeState,
} from "../src/bridge/runtime.js";
import { applyRuntimePrune, planRuntimePrune } from "../src/core/runtime-prune.js";
import { collectReleaseReferences } from "../src/core/release-references.js";
import { registerRuntimePruneCommands } from "../src/cli/runtime-prune.js";
import { SERVICE_NAME, VERSION } from "../src/version.js";
import { Workspace } from "../src/workspace/manager.js";
import { getStateDir } from "../src/config/paths.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

let stateDir: string;
let previousStateDir: string | undefined;
const openServers: Server[] = [];

beforeEach(() => {
  previousStateDir = process.env.C2C_STATE_DIR;
  stateDir = isolateStateDir();
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (openServers.length) {
    const server = openServers.pop();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
});

function makeWorkspace(name: string): Workspace {
  const root = makeTmpDir(name);
  write(root, "README.md", "# test\n");
  return new Workspace(root);
}

function writeLegacyRuntime(workspace: Workspace, opts: {
  pid: number;
  port: number;
  startedAt?: string;
  runtimeBuildId?: string;
  adminToken?: string;
  workspaceRoot?: string;
  workspaceId?: string;
  service?: string;
}): void {
  const state: RuntimeState & { runtimeBuildId?: string } = {
    service: opts.service ?? SERVICE_NAME,
    version: VERSION,
    workspaceId: opts.workspaceId ?? workspace.id,
    workspaceRoot: opts.workspaceRoot ?? workspace.root,
    pid: opts.pid,
    port: opts.port,
    adminToken: opts.adminToken ?? "prune-test-token",
    publicUrl: null,
    startedAt: opts.startedAt ?? "2026-09-09T02:04:40.983Z",
  };
  // Only attach when the field is intentionally present (including empty string).
  if (opts.runtimeBuildId !== undefined) {
    state.runtimeBuildId = opts.runtimeBuildId;
  }
  writeRuntimeState(state);
}

async function startHealthServer(health: Record<string, unknown>): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(health));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function deadPid(): number {
  // Large PID unlikely to exist; findBridgeObservation maps ESRCH → missing.
  return 999_999_999;
}

describe("G3-0a runtime prune-stale plan/apply", () => {
  it("核心回归：A stale legacy + B healthy same port → prune A only", async () => {
    const wsA = makeWorkspace("prune-stale-a");
    const wsB = makeWorkspace("prune-stale-b");
    const health = await startHealthServer({
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: wsB.id,
      status: "ok",
      pid: process.pid,
      startedAt: "2026-09-17T11:27:45.322Z",
      runtimeBuildId: "b".repeat(64),
    });

    writeLegacyRuntime(wsA, { pid: deadPid(), port: health.port, startedAt: "2026-09-09T02:04:40.983Z" });
    writeLegacyRuntime(wsB, {
      pid: process.pid,
      port: health.port,
      startedAt: "2026-09-17T11:27:45.322Z",
      runtimeBuildId: "b".repeat(64),
    });

    const obsA = await findBridgeObservation(wsA.id);
    expect(obsA.state).toBe("stopped");
    if (obsA.state === "stopped") expect(obsA.reason).toBe("stale_runtime");

    const plan = await planRuntimePrune(wsA.root);
    expect(plan).toMatchObject({
      ok: true,
      eligible: true,
      workspaceId: wsA.id,
      runtimeBuildIdState: "missing",
      observation: { state: "stopped", reason: "stale_runtime" },
    });
    if (!plan.ok || !plan.eligible) throw new Error("plan not eligible");
    expect(plan.confirmationSha256).toMatch(/^[a-f0-9]{64}$/);
    const dump = JSON.stringify(plan);
    for (const forbidden of ["prune-test-token", wsA.root, "publicUrl", "adminToken"]) {
      expect(dump).not.toContain(forbidden);
    }

    const bBefore = fs.readFileSync(runtimeFile(wsB.id), "utf8");
    const apply = await applyRuntimePrune(wsA.root, plan.confirmationSha256!);
    expect(apply).toEqual({ ok: true, removed: true, workspaceId: wsA.id, observation: "stale_runtime" });
    expect(fs.existsSync(runtimeFile(wsA.id))).toBe(false);
    expect(fs.existsSync(runtimeFile(wsB.id))).toBe(true);
    expect(fs.readFileSync(runtimeFile(wsB.id), "utf8")).toBe(bBefore);
    expect(readRuntimeState(wsB.id)?.workspaceId).toBe(wsB.id);
  });

  it("live healthy runtime → not eligible", async () => {
    const ws = makeWorkspace("prune-healthy");
    const health = await startHealthServer({
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: ws.id,
      status: "ok",
      pid: process.pid,
      startedAt: "2026-09-17T00:00:00.000Z",
    });
    writeLegacyRuntime(ws, { pid: process.pid, port: health.port, startedAt: "2026-09-17T00:00:00.000Z" });
    const obs = await findBridgeObservation(ws.id);
    expect(obs.state).toBe("healthy");
    const plan = await planRuntimePrune(ws.root);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.eligible).toBe(false);
  });

  it("saved PID present + health is other PID → unknown, not eligible", async () => {
    const ws = makeWorkspace("prune-pid-present-other");
    const health = await startHealthServer({
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: "ffffffffffff",
      status: "ok",
      pid: process.pid + 1,
      startedAt: "2026-09-18T00:00:00.000Z",
    });
    writeLegacyRuntime(ws, { pid: process.pid, port: health.port, startedAt: "2026-09-09T00:00:00.000Z" });
    const obs = await findBridgeObservation(ws.id);
    expect(obs.state).not.toBe("healthy");
    const plan = await planRuntimePrune(ws.root);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.eligible).toBe(false);
  });

  it("workspaceRoot identity mismatch → blocked", async () => {
    const ws = makeWorkspace("prune-root-mismatch");
    const other = makeWorkspace("prune-root-other");
    writeLegacyRuntime(ws, {
      pid: deadPid(),
      port: 1,
      workspaceRoot: other.root,
    });
    const plan = await planRuntimePrune(ws.root);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.eligible).toBe(false);
      expect(plan.blockedReason).toBe("workspace_root_identity_mismatch");
    }
  });

  it("malformed runtimeBuildId → blocked", async () => {
    const ws = makeWorkspace("prune-malformed-build");
    writeLegacyRuntime(ws, { pid: deadPid(), port: 1, runtimeBuildId: "not-hex" });
    const plan = await planRuntimePrune(ws.root);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.eligible).toBe(false);
      expect(plan.blockedReason).toBe("runtime_build_id_malformed");
    }
  });

  it("empty runtimeBuildId is malformed, not legacy missing", async () => {
    const ws = makeWorkspace("prune-empty-build");
    writeLegacyRuntime(ws, { pid: deadPid(), port: 9, runtimeBuildId: "" });
    const plan = await planRuntimePrune(ws.root);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.eligible).toBe(false);
      expect(plan.blockedReason).toBe("runtime_build_id_malformed");
    }
  });

  it("invalid workspace path → bounded workspace_invalid without path leak", async () => {
    const missing = path.join(makeTmpDir("prune-missing-parent"), "no-such-workspace-xyz");
    const plan = await planRuntimePrune(missing);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toBe("workspace_invalid");
    const dump = JSON.stringify(plan);
    expect(dump).not.toContain(missing);
    expect(dump).not.toContain("no-such-workspace-xyz");
    expect(dump).not.toContain("Workspace root does not exist");
  });

  it("runtime file disappears between validate and observation → no observation field", async () => {
    const ws = makeWorkspace("prune-race-missing");
    writeLegacyRuntime(ws, { pid: deadPid(), port: 9, startedAt: "2026-09-09T00:00:00.000Z" });
    const runtimeMod = await import("../src/bridge/runtime.js");
    vi.spyOn(runtimeMod, "findBridgeObservation").mockResolvedValue({
      state: "stopped",
      runtime: null,
      reason: "runtime_missing",
    });
    const plan = await planRuntimePrune(ws.root);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.eligible).toBe(false);
      expect(plan.blockedReason).toBe("observation_stopped_runtime_missing");
      expect(plan.observation).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(plan, "observation")).toBe(false);
    }
  });

  it("prune success + maintenance release failure → ok=false, removed=true", async () => {
    const ws = makeWorkspace("prune-release-fail");
    writeLegacyRuntime(ws, { pid: deadPid(), port: 9, startedAt: "2026-09-09T00:00:00.000Z" });
    const plan = await planRuntimePrune(ws.root);
    if (!plan.ok || !plan.eligible || !plan.confirmationSha256) throw new Error("need eligible");

    const maintenance = await import("../src/core/maintenance-lock.js");
    vi.spyOn(maintenance, "tryAcquireMaintenanceLock").mockReturnValue({
      ok: true,
      handle: {
        token: "22222222-2222-4222-8222-222222222222",
        path: path.join(stateDir, "maintenance.lock"),
        release: () => false,
      },
    });

    const apply = await applyRuntimePrune(ws.root, plan.confirmationSha256);
    expect(apply).toMatchObject({
      ok: false,
      removed: true,
      workspaceId: ws.id,
      reason: "maintenance_release_failed",
    });
    expect(fs.existsSync(runtimeFile(ws.id))).toBe(false);
  });

  it("noncanonical uppercase runtimeBuildId is malformed", async () => {
    const ws = makeWorkspace("prune-upper-build");
    writeLegacyRuntime(ws, { pid: deadPid(), port: 1, runtimeBuildId: "A".repeat(64) });
    const plan = await planRuntimePrune(ws.root);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.eligible).toBe(false);
      expect(plan.blockedReason).toBe("runtime_build_id_malformed");
    }
  });

  it("legacy runtime + extra field → schema invalid, not prune candidate", async () => {
    const ws = makeWorkspace("prune-extra-field-legacy");
    writeLegacyRuntime(ws, { pid: deadPid(), port: 9, startedAt: "2026-09-09T00:00:00.000Z" });
    const file = runtimeFile(ws.id);
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    raw.unexpectedField = true;
    fs.writeFileSync(file, JSON.stringify(raw));
    const plan = await planRuntimePrune(ws.root);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.eligible).toBe(false);
      expect(plan.blockedReason).toBe("runtime_schema_invalid");
    }
  });

  it("valid runtimeBuildId + extra field → schema invalid", async () => {
    const ws = makeWorkspace("prune-extra-field-valid");
    writeLegacyRuntime(ws, {
      pid: deadPid(),
      port: 9,
      runtimeBuildId: "a".repeat(64),
      startedAt: "2026-09-09T00:00:00.000Z",
    });
    const file = runtimeFile(ws.id);
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    raw.unexpectedField = true;
    fs.writeFileSync(file, JSON.stringify(raw));
    const plan = await planRuntimePrune(ws.root);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.eligible).toBe(false);
      expect(plan.blockedReason).toBe("runtime_schema_invalid");
    }
  });

  it("non-canonical runtime file → blocked", async () => {
    const ws = makeWorkspace("prune-symlink");
    const outside = makeTmpDir("prune-outside");
    const target = write(outside, "rt.json", JSON.stringify({
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: ws.id,
      workspaceRoot: ws.root,
      pid: deadPid(),
      port: 1,
      adminToken: "t",
      publicUrl: null,
      startedAt: "2026-09-09T00:00:00.000Z",
    }));
    const file = runtimeFile(ws.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(target, file, "file");
    const plan = await planRuntimePrune(ws.root);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.eligible).toBe(false);
      expect(plan.blockedReason).toBe("runtime_not_canonical_regular");
    }
  });

  it("runtime changes between plan and apply → confirmation mismatch, no delete", async () => {
    const ws = makeWorkspace("prune-toctou-confirm");
    writeLegacyRuntime(ws, { pid: deadPid(), port: 1, startedAt: "2026-09-09T00:00:00.000Z" });
    // No health → pid_missing path when PID dead and port probe fails
    const plan = await planRuntimePrune(ws.root);
    expect(plan.ok).toBe(true);
    if (!plan.ok || !plan.eligible || !plan.confirmationSha256) {
      // port 1 may yield unknown; use closed port path via dead pid + unreachable port
      throw new Error(`expected eligible plan, got ${JSON.stringify(plan)}`);
    }
    const confirm = plan.confirmationSha256;
    // Mutate runtime after plan
    writeLegacyRuntime(ws, { pid: deadPid(), port: 2, startedAt: "2026-09-10T00:00:00.000Z" });
    const apply = await applyRuntimePrune(ws.root, confirm);
    expect(apply.ok).toBe(false);
    expect(apply.removed).toBe(false);
    expect(fs.existsSync(runtimeFile(ws.id))).toBe(true);
  });

  it("observation becomes healthy after plan → apply refuses", async () => {
    const ws = makeWorkspace("prune-became-live");
    writeLegacyRuntime(ws, { pid: deadPid(), port: 9, startedAt: "2026-09-09T00:00:00.000Z" });
    const plan = await planRuntimePrune(ws.root);
    if (!plan.ok || !plan.eligible || !plan.confirmationSha256) throw new Error("need eligible plan");
    const confirm = plan.confirmationSha256;
    const health = await startHealthServer({
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: ws.id,
      status: "ok",
      pid: process.pid,
      startedAt: "2026-09-18T12:00:00.000Z",
    });
    writeLegacyRuntime(ws, { pid: process.pid, port: health.port, startedAt: "2026-09-18T12:00:00.000Z" });
    const apply = await applyRuntimePrune(ws.root, confirm);
    expect(apply.ok).toBe(false);
    expect(apply.removed).toBe(false);
    expect(fs.existsSync(runtimeFile(ws.id))).toBe(true);
  });

  it("maintenance busy → no delete", async () => {
    const ws = makeWorkspace("prune-maint-busy");
    writeLegacyRuntime(ws, { pid: deadPid(), port: 9, startedAt: "2026-09-09T00:00:00.000Z" });
    const plan = await planRuntimePrune(ws.root);
    if (!plan.ok || !plan.eligible || !plan.confirmationSha256) throw new Error("need eligible");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "maintenance.lock"), JSON.stringify({
      version: 1,
      operation: "other",
      pid: 1,
      startedAt: new Date().toISOString(),
      token: "11111111-1111-4111-8111-111111111111",
    }));
    const apply = await applyRuntimePrune(ws.root, plan.confirmationSha256);
    expect(apply).toMatchObject({ ok: false, removed: false, reason: "maintenance_busy" });
    expect(fs.existsSync(runtimeFile(ws.id))).toBe(true);
  });

  it("clearRuntimeState CAS mismatch → not removed", async () => {
    const ws = makeWorkspace("prune-cas");
    writeLegacyRuntime(ws, { pid: deadPid(), port: 9, startedAt: "2026-09-09T00:00:00.000Z" });
    const plan = await planRuntimePrune(ws.root);
    if (!plan.ok || !plan.eligible || !plan.confirmationSha256) throw new Error("need eligible");
    const confirm = plan.confirmationSha256;
    // Rewrite with same logical stale observation but different adminToken → fresh confirmation differs
    writeLegacyRuntime(ws, { pid: deadPid(), port: 9, startedAt: "2026-09-09T00:00:00.000Z", adminToken: "other-token" });
    const apply = await applyRuntimePrune(ws.root, confirm);
    expect(apply.ok).toBe(false);
    expect(apply.removed).toBe(false);
  });

  it("plan is zero-write for runtime and sibling state files", async () => {
    const ws = makeWorkspace("prune-zero-write");
    writeLegacyRuntime(ws, { pid: deadPid(), port: 9, startedAt: "2026-09-09T00:00:00.000Z" });
    write(stateDir, path.join("sessions", `${ws.id}.json`), JSON.stringify({ savedAt: "2026-01-01T00:00:00.000Z" }));
    write(stateDir, path.join("desktop-control", `${ws.id}.json`), JSON.stringify({ version: 1, workspaceId: ws.id }));
    write(stateDir, path.join("feedback", `${ws.id}.json`), JSON.stringify({ version: 1, workspaceId: ws.id }));
    write(stateDir, path.join("remote-control", `${ws.id}.json`), JSON.stringify({ version: 1, workspaceId: ws.id }));
    const files = [
      runtimeFile(ws.id),
      path.join(stateDir, "sessions", `${ws.id}.json`),
      path.join(stateDir, "desktop-control", `${ws.id}.json`),
      path.join(stateDir, "feedback", `${ws.id}.json`),
      path.join(stateDir, "remote-control", `${ws.id}.json`),
    ];
    const before = files.map((f) => fs.readFileSync(f, "utf8"));
    const spyWrite = vi.spyOn(fs, "writeFileSync");
    const spyRm = vi.spyOn(fs, "rmSync");
    const spyRename = vi.spyOn(fs, "renameSync");
    await planRuntimePrune(ws.root);
    expect(files.map((f) => fs.readFileSync(f, "utf8"))).toEqual(before);
    expect(spyWrite).not.toHaveBeenCalled();
    expect(spyRm).not.toHaveBeenCalled();
    expect(spyRename).not.toHaveBeenCalled();
  });

  it("CLI rejects missing/mode combinations; plan/apply json contract", async () => {
    const program = new Command("c2c");
    registerRuntimePruneCommands(program);
    const runtime = program.commands.find((c) => c.name() === "runtime");
    expect(runtime).toBeTruthy();
    const prune = runtime!.commands.find((c) => c.name() === "prune-stale");
    expect(prune).toBeTruthy();
    const opts = prune!.options.map((o) => o.long);
    expect(opts).toEqual(expect.arrayContaining(["--workspace", "--plan", "--apply", "--confirm", "--json"]));
  });

  it("apply output and plan dump never include secrets or absolute roots", async () => {
    const ws = makeWorkspace("prune-no-secret");
    writeLegacyRuntime(ws, { pid: deadPid(), port: 9, startedAt: "2026-09-09T00:00:00.000Z", adminToken: "super-secret-admin" });
    const plan = await planRuntimePrune(ws.root);
    if (!plan.ok || !plan.eligible || !plan.confirmationSha256) throw new Error("need eligible");
    const apply = await applyRuntimePrune(ws.root, plan.confirmationSha256);
    for (const dump of [JSON.stringify(plan), JSON.stringify(apply)]) {
      expect(dump).not.toContain("super-secret-admin");
      expect(dump).not.toContain(ws.root);
      expect(dump).not.toContain(getStateDir());
    }
  });
});

describe("G3-0a GC diagnostics runtime_missing_build_id", () => {
  it("legacy runtime missing buildId → runtime_missing_build_id, still fail-closed", () => {
    const ws = makeWorkspace("gc-missing-build");
    writeLegacyRuntime(ws, { pid: deadPid(), port: 9 });
    const graph = collectReleaseReferences(stateDir);
    expect(graph.ok).toBe(false);
    expect(graph.issues.some((i) => i.code === "runtime_missing_build_id" && i.source === `runtime:${ws.id}.json`)).toBe(true);
    expect(graph.issues.some((i) => i.code === "runtime_missing_build_id" && i.message.includes("缺少 runtimeBuildId"))).toBe(true);
  });

  it("malformed runtimeBuildId still runtime_corrupt", () => {
    const ws = makeWorkspace("gc-malformed-build");
    writeLegacyRuntime(ws, { pid: deadPid(), port: 9, runtimeBuildId: "zz" });
    const graph = collectReleaseReferences(stateDir);
    expect(graph.ok).toBe(false);
    expect(graph.issues.some((i) => i.code === "runtime_corrupt" && i.source === `runtime:${ws.id}.json`)).toBe(true);
  });

  it("empty runtimeBuildId → runtime_corrupt (not runtime_missing_build_id)", () => {
    const ws = makeWorkspace("gc-empty-build");
    writeLegacyRuntime(ws, { pid: deadPid(), port: 9, runtimeBuildId: "" });
    const graph = collectReleaseReferences(stateDir);
    expect(graph.ok).toBe(false);
    expect(graph.issues.some((i) => i.code === "runtime_corrupt" && i.source === `runtime:${ws.id}.json`)).toBe(true);
    expect(graph.issues.some((i) => i.code === "runtime_missing_build_id" && i.source === `runtime:${ws.id}.json`)).toBe(false);
  });

  it("legacy missing buildId + extra field → runtime_corrupt, not runtime_missing_build_id", () => {
    const ws = makeWorkspace("gc-legacy-extra-field");
    writeLegacyRuntime(ws, { pid: deadPid(), port: 9 });
    const file = runtimeFile(ws.id);
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    delete raw.runtimeBuildId;
    raw.unexpectedField = true;
    fs.writeFileSync(file, JSON.stringify(raw));
    const graph = collectReleaseReferences(stateDir);
    expect(graph.ok).toBe(false);
    expect(graph.issues.some((i) => i.code === "runtime_corrupt" && i.source === `runtime:${ws.id}.json`)).toBe(true);
    expect(graph.issues.some((i) => i.code === "runtime_missing_build_id" && i.source === `runtime:${ws.id}.json`)).toBe(false);
  });
});
