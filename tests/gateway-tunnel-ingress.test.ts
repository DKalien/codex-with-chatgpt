import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureGatewaySupervisor, buildGatewaySupervisorCommandPlan, writeGatewaySupervisorConfig } from "../src/gateway/supervisor.js";
import { buildGatewayTunnelIngress, writeGatewayTunnelIngress } from "../src/gateway/tunnel-ingress.js";
import { GatewayRegistry, gatewayRegistryFile } from "../src/gateway/registry.js";
import { writeTunnelState, tunnelStateFile } from "../src/tunnel/state.js";
import { withMaintenanceLock } from "../src/core/maintenance-lock.js";
import { cleanup, isolateStateDir } from "./helpers.js";

let stateDir: string;
let oldState: string | undefined;
beforeEach(() => { oldState = process.env.C2C_STATE_DIR; stateDir = isolateStateDir(); });
afterEach(() => {
  cleanup(stateDir);
  if (oldState === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = oldState;
});
function config() {
  return { version: 1 as const, scope: "machine" as const, publicUrl: "https://gateway.example.test/", port: 48766,
    tunnelName: "machine-gateway", tunnelId: "tunnel_12345678", stableLauncher: path.join(stateDir, "bin", "c2c.js"),
    cloudflaredPath: path.join(stateDir, "cloudflared.exe"), tunnelClientPath: path.join(stateDir, "tunnel-client.exe"),
    proxy: null, keyReference: "existing-dpapi-reference", keyFile: path.join(stateDir, "gateway", "key.dpapi") };
}
function register(name: string, hostname: string) {
  const root = path.join(stateDir, name);
  fs.mkdirSync(root);
  const entry = new GatewayRegistry(stateDir).register(root, "fixture-client");
  writeTunnelState({ workspaceId: entry.workspaceId, preference: "named", provider: "cloudflare-named", hostname });
  return entry;
}

describe("共享 Gateway Tunnel ingress", () => {
  it("legacy argv 保持不变，unified config 不扩大 Secure MCP Tunnel trusted origin", () => {
    const legacy = buildGatewaySupervisorCommandPlan(config());
    expect(legacy.cloudflared.args).toEqual(["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:48766", "run", "machine-gateway"]);
    const ingressFile = path.join(stateDir, "logs", "gateway-cloudflared.yml");
    const unified = buildGatewaySupervisorCommandPlan({ ...config(), unified: true }, { ingressFile });
    expect(unified.cloudflared.args).toEqual(["tunnel", "--no-autoupdate", "--config", ingressFile, "run", "machine-gateway"]);
    expect(unified.tunnelClient).toEqual(legacy.tunnelClient);
    expect(() => buildGatewaySupervisorCommandPlan({ ...config(), unified: true })).toThrow(/owner/);
  });

  it("多个已登记规范 workspace 复用一个 loopback origin 并以 404 收尾", () => {
    register("first", "first.example.test");
    register("second", "second.example.test");
    const expected = { ingress: [
      { hostname: "gateway.example.test", service: "http://127.0.0.1:48766" },
      { hostname: "first.example.test", service: "http://127.0.0.1:48766" },
      { hostname: "second.example.test", service: "http://127.0.0.1:48766" }, { service: "http_status:404" },
    ] };
    expect(buildGatewayTunnelIngress(config(), stateDir)).toEqual(expected);
    const file = withMaintenanceLock("ingress-fixture", handle => writeGatewayTunnelIngress(config(), stateDir, handle), stateDir);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(expected);
    expect(fs.readFileSync(file, "utf8")).not.toMatch(/credentials|tunnelId|key|token|secret/i);
  });

  it.each(["gateway.example.test", "https://first.example.test", "*.example.test", "localhost", "FIRST.example.test", "first.example.test."])("冲突或异常 hostname %s fail closed", host => {
    register("first", host);
    expect(() => buildGatewayTunnelIngress(config(), stateDir)).toThrow();
  });

  it("不同 workspace 的相同 hostname fail closed", () => {
    register("first", "same.example.test"); register("second", "same.example.test");
    expect(() => buildGatewayTunnelIngress(config(), stateDir)).toThrow(/冲突/);
  });

  it.each(["missing", "corrupt", "quick", "wrong-id"])("未知或不可信 named state %s fail closed", variant => {
    const entry = register("first", "first.example.test");
    const file = tunnelStateFile(entry.workspaceId);
    if (variant === "missing") fs.unlinkSync(file);
    if (variant === "corrupt") fs.writeFileSync(file, "{");
    if (variant === "quick") fs.writeFileSync(file, JSON.stringify({ workspaceId: entry.workspaceId, preference: "quick", provider: "cloudflare-quick", hostname: "first.example.test" }));
    if (variant === "wrong-id") fs.writeFileSync(file, JSON.stringify({ workspaceId: "a".repeat(12), preference: "named", provider: "cloudflare-named", hostname: "first.example.test" }));
    expect(() => buildGatewayTunnelIngress(config(), stateDir)).toThrow(/named/);
  });

  it("registry root 改到另一个 workspace 时拒绝生成 ingress", () => {
    register("first", "first.example.test");
    const other = path.join(stateDir, "other"); fs.mkdirSync(other);
    const file = gatewayRegistryFile(stateDir);
    const registry = JSON.parse(fs.readFileSync(file, "utf8")); registry.workspaces[0].root = other;
    fs.writeFileSync(file, JSON.stringify(registry));
    expect(() => buildGatewayTunnelIngress(config(), stateDir)).toThrow(/identity/);
  });

  it("机器 ingress 的 hardlink alias 不能被 writeSecureJson 覆盖", () => {
    const directory = path.join(stateDir, "logs"); fs.mkdirSync(directory);
    const original = path.join(directory, "original.json"); fs.writeFileSync(original, "protected");
    fs.linkSync(original, path.join(directory, "gateway-cloudflared.yml"));
    expect(() => withMaintenanceLock("ingress-fixture", handle => writeGatewayTunnelIngress(config(), stateDir, handle), stateDir)).toThrow(/owner/);
    expect(fs.readFileSync(original, "utf8")).toBe("protected");
  });

  it("configure 保留已有 unified 值与 key reference，启用时拒绝替换 hostname/tunnel identity", () => {
    writeGatewaySupervisorConfig({ ...config(), unified: true }, stateDir);
    expect(configureGatewaySupervisor({ ...config(), stateDir })).toMatchObject({ unified: true, keyReference: config().keyReference });
    expect(() => configureGatewaySupervisor({ ...config(), publicUrl: "https://other.example.test/", unified: true, stateDir })).toThrow(/identity/);
    expect(() => configureGatewaySupervisor({ ...config(), tunnelName: "other", unified: true, stateDir })).toThrow(/identity/);
  });
});
