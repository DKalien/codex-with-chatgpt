import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getStateDir } from "../src/config/paths.js";
import { readGatewayConfig, writeGatewayConfig } from "../src/gateway/config.js";

const file = (): string => path.join(getStateDir(), "gateway", "supervisor.json");
const base = {
  publicUrl: "https://example.test",
  port: 8765,
  tunnelName: "c2c",
  tunnelId: "tunnel_abcdef123456",
  cloudflaredPath: "C:\\bin\\cloudflared.exe",
  tunnelClientPath: "C:\\bin\\tunnel-client.exe",
  proxy: null,
  keyFile: path.join("x", "key.dpapi"),
};

describe("gateway config", () => {
  it("没有配置文件时返回 null", () => {
    expect(readGatewayConfig()).toBeNull();
  });

  it("读取旧 supervisor.json：忽略多余字段，keyFile 缺省", () => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify({
      version: 1, scope: "machine", unified: true, stableLauncher: "C:\\c2c.cmd", keyReference: "dpapi-file:file:///x",
      publicUrl: base.publicUrl, port: base.port, tunnelName: base.tunnelName, tunnelId: base.tunnelId,
      cloudflaredPath: base.cloudflaredPath, tunnelClientPath: base.tunnelClientPath, proxy: "http://127.0.0.1:7890",
    }));
    const config = readGatewayConfig()!;
    expect(config.proxy).toBe("http://127.0.0.1:7890");
    expect(config.keyFile).toBe(path.join(getStateDir(), "gateway", "tunnel-runtime-key.dpapi"));
    expect(config).not.toHaveProperty("stableLauncher");
  });

  it("写入后可读回，并带 version/scope", () => {
    writeGatewayConfig(base);
    expect(JSON.parse(fs.readFileSync(file(), "utf8"))).toMatchObject({ version: 1, scope: "machine", port: 8765 });
    expect(readGatewayConfig()).toEqual(base);
  });

  it("publicUrl 必须是 https origin", () => {
    for (const bad of ["http://example.test", "https://example.test/mcp", "https://u:p@example.test", "nope"]) {
      expect(() => writeGatewayConfig({ ...base, publicUrl: bad })).toThrow(expect.objectContaining({ code: "GATEWAY_CONFIG_INVALID" }));
    }
  });
});
