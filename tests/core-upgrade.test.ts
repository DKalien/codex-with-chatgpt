import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startBridge } from "../src/bridge/server.js";
import { endpointFile, writeLastEndpoint } from "../src/config/endpoint.js";
import { readRuntimeUpgrade, readPending, writePending, clearPending, pendingFile } from "../src/core/upgrade.js";
import { Workspace } from "../src/workspace/manager.js";
import { getCurrentInstall, installCore } from "../src/core/install.js";
import release from "../scripts/core-release.cjs";
import type { RuntimeState } from "../src/bridge/runtime.js";
import { buildCoreFixture, cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(cleanup); });
function fixture() {
  const state = isolateStateDir(); const root = makeTmpDir("core-upgrade");
  dirs.push(state, root);
  write(root, "bin/c2c.js", "// fixture");
  write(root, "dist/cli/index.js", "// fixture runtime");
  write(root, "package.json", '{"type":"module"}');
  fs.mkdirSync(path.join(root, "node_modules"));
  const workspace = new Workspace(root);
  const build = buildCoreFixture(root);
  const installed = installCore(root, build);
  return { state, workspace, build, installed, runtime: { workspaceId: workspace.id, workspaceRoot: root,
    runtimeBuildId: build } as RuntimeState };
}

it("pending 严格无凭据、相同目标幂等，status 只读显示 runtime/current 差异", () => {
  const { workspace, build, runtime } = fixture();
  expect(readRuntimeUpgrade(workspace, runtime, "fast")).toMatchObject({ state: "current", upgradePending: false });
  expect(readRuntimeUpgrade(workspace, { ...runtime, runtimeBuildId: undefined }, "fast")).toMatchObject({
    state: "stale", runtimeBuildId: null, installedBuildId: build, upgradePending: true });
  expect(readPending(workspace)).toBeNull();
  writePending(workspace, build, "busy");
  const bytes = fs.readFileSync(pendingFile(workspace.id));
  writePending(workspace, build, "busy");
  expect(fs.readFileSync(pendingFile(workspace.id))).toEqual(bytes);
  expect(Object.keys(readPending(workspace)!)).toEqual(["workspaceId", "workspaceRoot", "targetBuildId", "reason", "updatedAt"]);
  expect(readRuntimeUpgrade(workspace, runtime, "fast")).toMatchObject({ upgradePending: true, reason: "busy" });
  clearPending(workspace);
  expect(readRuntimeUpgrade(workspace, null, "fast")).toMatchObject({ state: "stopped", upgradePending: false });
});

it("损坏 pending 或 workspace mismatch 不改写；坏 current 不冒充已安装", () => {
  const { state, workspace, build, runtime } = fixture();
  writePending(workspace, build, "busy");
  const file = pendingFile(workspace.id);
  fs.writeFileSync(file, "{}");
  expect(() => writePending(workspace, build, "quick")).toThrow("状态损坏");
  expect(() => clearPending(workspace)).toThrow("状态损坏");
  expect(fs.readFileSync(file, "utf8")).toBe("{}");
  expect(readRuntimeUpgrade(workspace, runtime, "fast")).toMatchObject({ state: "unknown", reason: "pending_corrupt" });
  fs.unlinkSync(file);
  writePending(workspace, build, "busy");
  expect(() => readPending({ ...workspace, root: path.dirname(workspace.root) })).toThrow("身份不匹配");
  fs.writeFileSync(path.join(state, "current.json"), "{}");
  expect(readRuntimeUpgrade(workspace, runtime, "fast")).toMatchObject({ state: "unknown", installedBuildId: null, reason: "install_corrupt" });
});

it("v3 runtimeUpgrade fast 不枚举 release，维护默认 full 仍发现深层篡改", () => {
  const { state, workspace, runtime, installed } = fixture();
  const walk = vi.spyOn(fs, "readdirSync").mockImplementation(() => { throw new Error("unexpected recursive scan"); });
  expect(readRuntimeUpgrade(workspace, runtime, "fast")).toMatchObject({ state: "current" });
  expect(walk).not.toHaveBeenCalled();
  walk.mockRestore();
  write(installed.releaseRoot, "node_modules/deep.txt", "deep tamper");
  expect(readRuntimeUpgrade(workspace, runtime, "fast")).toMatchObject({ state: "current" });
  expect(readRuntimeUpgrade(workspace, runtime, "full")).toMatchObject({ state: "unknown", reason: "install_corrupt" });
  expect(getCurrentInstall(state).status).toBe("corrupt");
  expect(() => release.readCurrent(state)).toThrow(/artifact 校验失败/);
  expect(() => release.protectCurrent(state)).toThrow(/artifact 校验失败/);
});

it.each(["current.json", "release.json", "dist/cli/index.js"])("fast runtimeUpgrade 对损坏的 %s 返回 unknown", file => {
  const { state, workspace, runtime, installed } = fixture();
  fs.appendFileSync(path.join(file === "current.json" ? state : installed.releaseRoot, file), "tampered");
  expect(readRuntimeUpgrade(workspace, runtime, "fast")).toMatchObject({ state: "unknown", installedBuildId: null, reason: "install_corrupt" });
});

it("v2 runtimeUpgrade 的 fast 请求仍 fallback full，深层篡改拒绝", () => {
  const { state, workspace, runtime, installed } = fixture();
  const { manifestSha256: _hash, ...metadata } = installed as typeof installed & { manifestSha256?: string };
  write(state, "current.json", JSON.stringify({ ...metadata, version: 2 }));
  write(installed.releaseRoot, "release.json", JSON.stringify({ version: 1,
    runtimeBuildId: installed.runtimeBuildId, artifactSha256: installed.artifactSha256 }));
  const walk = vi.spyOn(fs, "readdirSync");
  expect(readRuntimeUpgrade(workspace, runtime, "fast")).toMatchObject({ state: "current" });
  expect(walk).toHaveBeenCalled();
  write(installed.releaseRoot, "node_modules/deep.txt", "deep tamper");
  expect(readRuntimeUpgrade(workspace, runtime, "fast")).toMatchObject({ state: "unknown", reason: "install_corrupt" });
});

it("真实 status/doctor JSON 展示 build pending，build mismatch 不触发 Connector 修复", async () => {
  const { state, workspace, build, installed } = fixture();
  const oldBuild = "b".repeat(64);
  const bridge = await startBridge({ workspaceRoot: workspace.root, port: 0, persistRuntime: true,
    runtimeBuildId: oldBuild, authStoreFile: path.join(state, "auth", `${workspace.id}.json`) });
  try {
    writePending(workspace, build, "busy");
    const pendingBytes = fs.readFileSync(pendingFile(workspace.id));
    const cli = path.resolve("src/cli/index.ts");
    const counts = path.join(state, "release-io.json");
    const probe = write(state, "release-io.cjs", `const fs = require("node:fs"), path = require("node:path");
const original = fs.readdirSync, root = ${JSON.stringify(installed.releaseRoot)};
let enumerations = 0;
fs.readdirSync = function(file, ...args) {
  const relative = path.relative(root, String(file));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) enumerations++;
  return original.call(this, file, ...args);
};
process.on("exit", () => fs.writeFileSync(${JSON.stringify(counts)}, JSON.stringify({ enumerations })));
`);
    for (const [command, json] of [["status", true], ["status", false], ["session", true], ["doctor", true], ["doctor", false]] as const) {
      const result = await promisify(execFile)(process.execPath, ["--require", probe, "--import", "tsx/esm", cli, command,
        "-w", workspace.root, ...(json ? ["--json"] : []), ...(command === "doctor" ? ["--no-fix"] : [])],
      { windowsHide: true, env: { ...process.env }, timeout: 15000 }).catch(error => {
        // 文本 doctor 对隔离 state 未在 sandbox 白名单中返回 1，仍检查其真实诊断和 I/O。
        if (command === "doctor" && !json && error.code === 1) return error as { stdout: string };
        throw error;
      });
      const { enumerations } = JSON.parse(fs.readFileSync(counts, "utf8"));
      if (command === "doctor") expect(enumerations).toBeGreaterThan(0);
      else expect(enumerations).toBe(0);
      if (json && command !== "session") {
        const output = JSON.parse(result.stdout);
        expect(output.runtimeUpgrade).toMatchObject({ runtimeBuildId: oldBuild, installedBuildId: build,
          state: "stale", upgradePending: true, reason: "busy" });
        if (command === "doctor") {
          expect(output.report.core.ok).toBe(true);
          expect(output.chatgptRepair).toMatchObject({ needed: false, connectorAction: "none" });
        }
      } else if (command === "doctor") expect(result.stdout).toContain("完整 release 校验通过");
    }
    expect(fs.readFileSync(pendingFile(workspace.id))).toEqual(pendingBytes);
  } finally { await bridge.close(); }
});

it("doctor --no-fix 不写入 Connector endpoint 或生成配对码", async () => {
  const { state, workspace } = fixture();
  const healthServer = createServer((_req, res) => { res.writeHead(200); res.end("ok"); });
  await new Promise<void>((resolve, reject) => {
    healthServer.once("error", reject);
    healthServer.listen(0, "127.0.0.1", resolve);
  });
  const address = healthServer.address();
  if (!address || typeof address === "string") throw new Error("health server did not bind");
  const publicUrl = `http://127.0.0.1:${address.port}`;
  const bridge = await startBridge({
    workspaceRoot: workspace.root,
    port: 0,
    tunnelProvider: {
      name: "fixture",
      async start() { return publicUrl; },
      async stop() {},
      async restart() { return publicUrl; },
      status() { return { running: true, url: publicUrl, provider: "cloudflare-quick" }; },
      getPublicUrl() { return publicUrl; },
      async doctor() {
        return { provider: "cloudflare-quick", binaryFound: true, binaryPath: "fixture",
          running: true, url: publicUrl, problems: [] };
      },
    },
    authStoreFile: path.join(state, "auth", `${workspace.id}.json`),
  });
  try {
    writeLastEndpoint({
      workspaceId: workspace.id,
      port: bridge.port,
      publicUrl: "https://old.example.test",
      mcpUrl: "https://old.example.test/mcp",
      connectorName: "Codex with ChatGPT · fixture",
    });
    const savedEndpoint = fs.readFileSync(endpointFile(workspace.id));
    const cli = path.resolve("src/cli/index.ts");
    const result = await promisify(execFile)(process.execPath,
      ["--import", "tsx/esm", cli, "doctor", "-w", workspace.root, "--no-fix", "--json"],
      { windowsHide: true, env: { ...process.env }, timeout: 15000 }).catch(error => {
        if (error.code === 1 && typeof error.stdout === "string") return error as { stdout: string };
        throw error;
      });
    const output = JSON.parse(result.stdout);
    expect(output.chatgptRepair).toMatchObject({ needed: true, connectorAction: "update" });
    expect(output.chatgptRepair.pairingCode).toBeUndefined();
    expect(fs.readFileSync(endpointFile(workspace.id))).toEqual(savedEndpoint);
    expect(bridge.pairing.hasActiveSession()).toBe(false);
  } finally {
    await bridge.close();
    await new Promise<void>(resolve => healthServer.close(() => resolve()));
  }
});

it("隐藏 rollout result-file 在维护前拒绝覆盖已有文件", async () => {
  const { state, workspace } = fixture();
  const resultFile = write(state, "keep-result.json", "existing evidence");
  await expect(promisify(execFile)(process.execPath, ["--import", "tsx/esm", path.resolve("src/cli/index.ts"),
    "rollout", "-w", workspace.root, "--json", "--result-file", resultFile],
  { windowsHide: true, env: { ...process.env }, timeout: 15000 })).rejects.toMatchObject({ code: 1 });
  expect(fs.readFileSync(resultFile, "utf8")).toBe("existing evidence");
  expect(fs.existsSync(path.join(state, "runtime"))).toBe(false);
});
