import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const runFile = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let root: string;
let stateDir: string;
let bridge: Bridge | undefined;

beforeEach(() => {
  root = makeTmpDir("probe-cli");
  stateDir = path.join(root, "state");
  vi.stubEnv("C2C_STATE_DIR", stateDir);
  vi.stubEnv("C2C_ENABLE_WRITE_PROBE", "");
});

afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
  vi.unstubAllEnvs();
  cleanup(root);
});

async function status(flag = "") {
  const result = await runFile(process.execPath, [
    "--import", "tsx", path.join(projectRoot, "src/cli/index.ts"),
    "write-probe-status", "-w", root, "--json",
  ], { cwd: projectRoot, env: { ...process.env, C2C_ENABLE_WRITE_PROBE: flag }, windowsHide: true });
  return JSON.parse(result.stdout);
}

it("状态读取不创建 AppData 目录，也不把终端开关当作已运行工具", async () => {
  expect(await status("1")).toMatchObject({ enabled: false, configured: true, bridgeState: "stopped", exists: false, nonce: null });
  expect(fs.existsSync(stateDir)).toBe(false);
});

it("以运行中的 Bridge 开关为准，并只读返回最后一次固定文件记录", async () => {
  vi.stubEnv("C2C_ENABLE_WRITE_PROBE", "1");
  bridge = await startBridge({ workspaceRoot: root, port: 0 });
  const file = path.join(stateDir, "write-probe.json");
  const saved = JSON.stringify({ nonce: "from-chatgpt", timestamp: "2026-09-10T12:00:00.000Z", workspaceId: bridge.workspace.id, tool: "write_probe" });
  fs.writeFileSync(file, saved);
  expect(await status()).toMatchObject({ enabled: true, configured: false, bridgeState: "healthy", exists: true, nonce: "from-chatgpt", workspaceId: bridge.workspace.id });
  expect(fs.readFileSync(file, "utf8")).toBe(saved);
});

it("损坏的探针记录明确报错而不覆盖文件或泄漏其内容", async () => {
  fs.mkdirSync(stateDir);
  const file = path.join(stateDir, "write-probe.json");
  fs.writeFileSync(file, "broken-sensitive-content");
  await expect(status()).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining("文件损坏或不可访问") });
  expect(fs.readFileSync(file, "utf8")).toBe("broken-sensitive-content");
});
