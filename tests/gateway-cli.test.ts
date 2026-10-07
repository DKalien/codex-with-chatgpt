import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerGatewayCommands } from "../src/cli/gateway.js";
import { cleanup, makeTmpDir } from "./helpers.js";
import { readGatewaySupervisorConfig } from "../src/gateway/supervisor.js";

let stateDir: string;
let root: string;

beforeEach(() => {
  stateDir = makeTmpDir("gateway-cli-state");
  root = makeTmpDir("gateway-cli-workspace");
  vi.stubEnv("C2C_STATE_DIR", stateDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  cleanup(root);
  cleanup(stateDir);
});

async function runCli(args: string[]): Promise<string> {
  const program = new Command().exitOverride();
  registerGatewayCommands(program);
  const output: string[] = [];
  const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  try {
    await program.parseAsync(["node", "c2c", ...args]);
    return output.join("");
  } finally {
    write.mockRestore();
  }
}

describe("gateway CLI", () => {
  it("configure 完成首次配置且不写入 key、注册任务或启动服务", async () => {
    const args = ["gateway", "supervisor", "configure", "--public-url", "https://gateway.example.test",
      "--port", "48766", "--tunnel-name", "gateway-origin", "--tunnel-id", "tunnel_12345678",
      "--stable-launcher", path.join(stateDir, "bin", "c2c.js"),
      "--cloudflared", path.join(stateDir, "cloudflared.exe"), "--tunnel-client", path.join(stateDir, "tunnel-client.exe"),
      "--state-dir", stateDir, "--json"];
    const result = JSON.parse(await runCli(args));
    expect(result.ok).toBe(true);
    expect(readGatewaySupervisorConfig(stateDir)).toEqual(result.config);
    expect(fs.readdirSync(path.join(stateDir, "gateway"))).toEqual(["supervisor.json"]);
    const before = fs.readFileSync(path.join(stateDir, "gateway", "supervisor.json"));
    await expect(runCli([...args, "--port", "0"])).rejects.toThrow(/1 to 65535/);
    expect(fs.readFileSync(path.join(stateDir, "gateway", "supervisor.json"))).toEqual(before);
  });
  it("register/list/revoke 是显式本机授权流程并支持 client 过滤", async () => {
    await runCli(["gateway", "register", "--workspace", root, "--client-id", "client-a"]);
    const all = JSON.parse(await runCli(["gateway", "list", "--json"])) as { workspaceId: string; clientIds: string[] }[];
    expect(all).toHaveLength(1);
    expect(all[0]!.clientIds).toEqual(["client-a"]);

    const filtered = JSON.parse(await runCli(["gateway", "list", "--client-id", "other", "--json"])) as unknown[];
    expect(filtered).toEqual([]);
    const revoked = await runCli(["gateway", "revoke", "--workspace-id", all[0]!.workspaceId, "--client-id", "client-a"]);
    expect(revoked).toContain("已撤销");
    expect(JSON.parse(await runCli(["gateway", "list", "--json"]))).toEqual([]);
  });

  it("serve 暴露明确的 loopback port 与 public URL 参数，不在测试中启动实例", () => {
    const program = new Command();
    registerGatewayCommands(program);
    const gateway = program.commands.find(command => command.name() === "gateway")!;
    const serve = gateway.commands.find(command => command.name() === "serve")!;
    expect(serve.options.map(option => option.long)).toContain("--port");
    expect(serve.options.map(option => option.long)).toContain("--public-url");
    expect(fs.readdirSync(stateDir)).toEqual([]);
  });
});
