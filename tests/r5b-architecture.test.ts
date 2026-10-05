import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(process.cwd());
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g)].map(m => m[1]);
}

describe("R5b architecture fence", () => {
  it("executor-control does not import browser-companion/feedback", () => {
    for (const file of fs.readdirSync(path.join(root, "src/executor-control"))) {
      if (!file.endsWith(".ts")) continue;
      const source = read(`src/executor-control/${file}`);
      for (const specifier of importsOf(source)) {
        expect(specifier, `${file} -> ${specifier}`).not.toMatch(/browser-companion|feedback/i);
      }
    }
  });

  it("generic endpoint core still cannot import executor-control/mcp/desktop", () => {
    for (const file of fs.readdirSync(path.join(root, "src/endpoints"))) {
      if (!file.endsWith(".ts")) continue;
      const source = read(`src/endpoints/${file}`);
      for (const specifier of importsOf(source)) {
        expect(specifier, `${file} -> ${specifier}`).not.toMatch(/executor-control|\/mcp\/|\/desktop\//);
      }
    }
  });

  it("MCP executor tools depend on executor-control service, not Desktop IPC", () => {
    const source = read("src/mcp/executor-tools.ts");
    expect(source).toMatch(/from ["']\.\.\/executor-control\//);
    expect(source).not.toMatch(/from ["']\.\.\/desktop\/ipc/);
    expect(source).not.toMatch(/desktopIpc/);
    expect(source).not.toMatch(/registerTool\(\s*"executor_bind"/);
    expect(source).toMatch(/"executor_list"/);
    expect(source).toMatch(/"executor_status"/);
    expect(source).toMatch(/"executor_send"/);
  });

  it("Codex backend is the only bridge from generic control to Desktop transport", () => {
    const service = read("src/executor-control/service.ts");
    const backend = read("src/executor-control/codex-backend.ts");
    const tools = read("src/mcp/executor-tools.ts");
    const send = read("src/executor-control/send.ts");
    expect(service).toMatch(/createCodexDesktopProductionBackend|resolveProductionBackend/);
    expect(service).not.toMatch(/deliverCurrentCommand/);
    expect(backend).toMatch(/deliverCurrentCommand/);
    expect(backend).not.toMatch(/codexDesktopExecutorPlugin\.deliver|plugin\.deliver\(/);
    expect(tools).not.toMatch(/deliverCurrentCommand/);
    expect(tools).not.toMatch(/plugin\.deliver\(/);
    expect(tools).toMatch(/dispatchExecutorCommand/);
    expect(tools).toMatch(/if \(mailbox\) return mailbox\("executor"/);
    expect(send).toMatch(/resolveProductionBackend\(target\.pluginId\)/);
    expect(send).not.toMatch(/deliverCurrentCommand|desktopIpc|plugin\.deliver\(/);
  });

  it("no Claude production registry and no plugin discovery", () => {
    const registry = read("src/executor-control/registry.ts");
    expect(registry).toMatch(/codexDesktopExecutorPlugin/);
    expect(registry).not.toMatch(/claude-code|ClaudeCode|CLAUDE_CODE/);
    expect(registry).not.toMatch(/readdir|process\.env|PATH|require\(|import\(/);
    const tools = read("src/mcp/executor-tools.ts");
    expect(tools).not.toMatch(/registerTool\(\s*"executor_bind"/);
  });

  it("OAuth scopes include generic executor without removing desktop scopes", () => {
    const store = read("src/auth/store.ts");
    expect(store).toMatch(/codex\.executor\.read/);
    expect(store).toMatch(/codex\.executor\.control/);
    expect(store).toMatch(/codex\.desktop\.read/);
    expect(store).toMatch(/codex\.desktop\.control/);
    const tools = read("src/mcp/executor-tools.ts");
    expect(tools).toMatch(/from ["']\.\.\/auth\/store\.js["']/);
    expect(tools).not.toMatch(/export const EXECUTOR_READ_SCOPE =/);
  });

  it("store enforces initialized marker and identity consistency", () => {
    const store = read("src/executor-control/store.ts");
    expect(store).toMatch(/\.initialized/);
    expect(store).toMatch(/fsyncSync/);
    expect(store).toMatch(/noWrite/);
    expect(store).toMatch(/parseExecutorControlState/);
    const schema = read("src/executor-control/schema.ts");
    expect(schema).toMatch(/activeBinding\.workspaceId/);
    expect(schema).toMatch(/activeBinding\.workspaceRoot/);
  });
});
