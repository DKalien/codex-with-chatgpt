import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enableProbe,
  readProbeState,
  resolveTrustedPrincipal,
} from "../src/feedback/probe-store.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const runFile = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const entry = path.join(projectRoot, "tests/fixtures/probe-cli.ts");
const productionEntry = path.join(projectRoot, "src/cli/index.ts");

let wsRoot: string;
let stateDir: string;
let workspace: Workspace;

beforeEach(() => {
  stateDir = isolateStateDir();
  wsRoot = makeTmpDir("probe-cli-ws");
  workspace = new Workspace(wsRoot);
  process.env.C2C_ENABLE_FEEDBACK_PROBE = "1";
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.C2C_ENABLE_FEEDBACK_PROBE;
  cleanup(stateDir);
  cleanup(wsRoot);
});

function principalA() {
  return resolveTrustedPrincipal({
    authInfo: { token: "t", clientId: "client-A", scopes: ["feedback.probe"] } as never,
    sessionId: "session-A",
    _meta: { "openai/session": "sess-A" },
  });
}

async function cli(...args: string[]): Promise<{ stdout: string; code: number }> {
  return runCli(entry, ...args);
}

async function runCli(cliEntry: string, ...args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const result = await runFile(process.execPath, [
      "--import", "tsx", cliEntry,
      "feedback-probe", ...args, "-w", wsRoot, "--json",
    ], { cwd: projectRoot, env: { ...process.env, C2C_STATE_DIR: stateDir }, windowsHide: true });
    return { stdout: result.stdout, code: 0 };
  } catch (error) {
    const e = error as { stdout?: string; code?: number };
    return { stdout: e.stdout ?? "", code: typeof e.code === "number" ? e.code : 1 };
  }
}

describe("本机 feedback-probe CLI", () => {
  it("轻量探针入口复用生产注册与 Commander 设置", () => {
    const production = fs.readFileSync(productionEntry, "utf8");
    const fixture = fs.readFileSync(entry, "utf8");
    for (const [command, registration, module] of [
      ["feedback-probe", "registerFeedbackProbeCommands", "feedback-probe"],
      ["write-probe-status", "registerSetupCommands", "setup"],
    ]) {
      expect(production).toMatch(new RegExp(`import\\s+\\{[^}]*\\b${registration}\\b[^}]*\\}\\s+from "\\./${module}\\.js"`));
      expect(production).toContain(`${registration}(program);`);
      expect(fixture).toContain(`case "${command}": {`);
      expect(fixture).toMatch(new RegExp(`const\\s+\\{\\s*${registration}\\s*\\}\\s*=\\s*await import\\("\\.\\./\\.\\./src/cli/${module}\\.js"\\);\\s*${registration}\\(program\\);\\s*break;`));
    }
    expect(fixture.match(/register\w+\(program\);/g)).toHaveLength(2);
    expect(fixture.match(/case "[^"]+":/g)).toHaveLength(2);
    expect(fixture).toContain("switch (process.argv[2])");
    for (const setting of [
      'import { Command } from "commander";',
      'const program = new Command();',
      '.name("c2c")',
      '.description(`${PRODUCT_NAME} — ChatGPT thinks. Codex works.`)',
      '.version(VERSION, "-v, --version")',
      '.configureHelp({ sortSubcommands: true });',
      'program.parseAsync(process.argv).catch((error: Error) => {',
      'cross(error.message);',
      'process.exit(1);',
    ]) {
      expect(production).toContain(setting);
      expect(fixture).toContain(setting);
    }
  });

  it("status 未启用时可见空状态；emit 未启用拒绝", async () => {
    const st = JSON.parse((await runCli(productionEntry, "status")).stdout);
    expect(st.enabled).toBe(false);
    expect(st.binding).toBeNull();

    const emit = await cli("emit");
    expect(emit.code).not.toBe(0);
    const body = JSON.parse(emit.stdout);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("PROBE_NOT_ENABLED");
  });

  it("local CLI emit 创建 event，不需要 Chat principal", async () => {
    enableProbe({ workspaceId: workspace.id, principal: principalA(), widgetId: "w", stateDir });

    const emit = await cli("emit", "--label", "cli");
    expect(emit.code).toBe(0);
    const created = JSON.parse(emit.stdout);
    expect(created.probeId).toMatch(/^probe_/);
    expect(created.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(created.status).toBe("ready");
    expect(created.epoch).toBe(1);
    expect(created.workspaceId).toBe(workspace.id);

    const state = readProbeState(workspace.id, stateDir);
    expect(state.events).toHaveLength(1);
    expect(state.events[0].probeId).toBe(created.probeId);
    // 事件目标固定为 binding principal，而不是某个 Chat caller
    expect(state.events[0].principalFingerprint).toBe(state.binding!.principalFingerprint);

    const st = JSON.parse((await cli("status")).stdout);
    expect(st.enabled).toBe(true);
    expect(st.ownsBinding).toBe(false); // CLI 无 caller fingerprint
    expect(st.events[0].probeId).toBe(created.probeId);
  });

  it("MCP 开关关闭时 CLI 仍可 status/emit 本地状态", async () => {
    process.env.C2C_ENABLE_FEEDBACK_PROBE = "";
    enableProbe({ workspaceId: workspace.id, principal: principalA(), widgetId: "w", stateDir });
    const st = JSON.parse((await cli("status")).stdout);
    expect(st.mcpConfigured).toBe(false);
    expect(st.enabled).toBe(true);
    const emit = await cli("emit");
    expect(emit.code).toBe(0);
    expect(JSON.parse(emit.stdout).status).toBe("ready");
  });
});
