import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startBridge } from "../src/bridge/server.js";
import { readRuntimeUpgrade, readPending, writePending, clearPending, pendingFile } from "../src/core/upgrade.js";
import { Workspace } from "../src/workspace/manager.js";
import { installCore } from "../src/core/install.js";
import type { RuntimeState } from "../src/bridge/runtime.js";
import { buildCoreFixture, cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(cleanup); });
function fixture() {
  const state = isolateStateDir(); const root = makeTmpDir("core-upgrade");
  dirs.push(state, root);
  write(root, "bin/c2c.js", "// fixture");
  write(root, "dist/cli/index.js", "// fixture runtime");
  write(root, "package.json", '{"type":"module"}');
  fs.mkdirSync(path.join(root, "node_modules"));
  const workspace = new Workspace(root);
  const build = buildCoreFixture(root);
  installCore(root, build);
  return { state, workspace, build, runtime: { workspaceId: workspace.id, workspaceRoot: root,
    runtimeBuildId: build } as RuntimeState };
}

it("pending 严格无凭据、相同目标幂等，status 只读显示 runtime/current 差异", () => {
  const { workspace, build, runtime } = fixture();
  expect(readRuntimeUpgrade(workspace, runtime)).toMatchObject({ state: "current", upgradePending: false });
  expect(readRuntimeUpgrade(workspace, { ...runtime, runtimeBuildId: undefined })).toMatchObject({
    state: "stale", runtimeBuildId: null, installedBuildId: build, upgradePending: true });
  expect(readPending(workspace)).toBeNull();
  writePending(workspace, build, "busy");
  const bytes = fs.readFileSync(pendingFile(workspace.id));
  writePending(workspace, build, "busy");
  expect(fs.readFileSync(pendingFile(workspace.id))).toEqual(bytes);
  expect(Object.keys(readPending(workspace)!)).toEqual(["workspaceId", "workspaceRoot", "targetBuildId", "reason", "updatedAt"]);
  expect(readRuntimeUpgrade(workspace, runtime)).toMatchObject({ upgradePending: true, reason: "busy" });
  clearPending(workspace);
  expect(readRuntimeUpgrade(workspace, null)).toMatchObject({ state: "stopped", upgradePending: false });
});

it("损坏 pending 或 workspace mismatch 不改写；坏 current 不冒充已安装", () => {
  const { state, workspace, build, runtime } = fixture();
  writePending(workspace, build, "busy");
  const file = pendingFile(workspace.id);
  fs.writeFileSync(file, "{}");
  expect(() => writePending(workspace, build, "quick")).toThrow("状态损坏");
  expect(() => clearPending(workspace)).toThrow("状态损坏");
  expect(fs.readFileSync(file, "utf8")).toBe("{}");
  expect(readRuntimeUpgrade(workspace, runtime)).toMatchObject({ state: "unknown", reason: "pending_corrupt" });
  fs.unlinkSync(file);
  writePending(workspace, build, "busy");
  expect(() => readPending({ ...workspace, root: path.dirname(workspace.root) })).toThrow("身份不匹配");
  fs.writeFileSync(path.join(state, "current.json"), "{}");
  expect(readRuntimeUpgrade(workspace, runtime)).toMatchObject({ state: "unknown", installedBuildId: null, reason: "install_corrupt" });
});

it("真实 status/doctor JSON 展示 build pending，build mismatch 不触发 Connector 修复", async () => {
  const { state, workspace, build } = fixture();
  const oldBuild = "b".repeat(64);
  const bridge = await startBridge({ workspaceRoot: workspace.root, port: 0, persistRuntime: true,
    runtimeBuildId: oldBuild, authStoreFile: path.join(state, "auth", `${workspace.id}.json`) });
  try {
    writePending(workspace, build, "busy");
    const pendingBytes = fs.readFileSync(pendingFile(workspace.id));
    const cli = path.resolve("src/cli/index.ts");
    for (const command of ["status", "doctor"]) {
      const result = await promisify(execFile)(process.execPath, ["--import", "tsx/esm", cli, command,
        "-w", workspace.root, "--json", ...(command === "doctor" ? ["--no-fix"] : [])],
      { windowsHide: true, env: { ...process.env }, timeout: 15000 });
      const output = JSON.parse(result.stdout);
      expect(output.runtimeUpgrade).toMatchObject({ runtimeBuildId: oldBuild, installedBuildId: build,
        state: "stale", upgradePending: true, reason: "busy" });
      if (command === "doctor") expect(output.chatgptRepair).toMatchObject({ needed: false, connectorAction: "none" });
    }
    expect(fs.readFileSync(pendingFile(workspace.id))).toEqual(pendingBytes);
  } finally { await bridge.close(); }
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
