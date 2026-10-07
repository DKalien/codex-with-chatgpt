import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayRegistry, GatewayRegistryError, gatewayRegistryFile } from "../src/gateway/registry.js";
import { cleanup, makeTmpDir } from "./helpers.js";

let stateDir: string;
let roots: string[];
let registry: GatewayRegistry;

beforeEach(() => {
  stateDir = makeTmpDir("gateway-registry-state");
  roots = [makeTmpDir("gateway-registry-a"), makeTmpDir("gateway-registry-b")];
  registry = new GatewayRegistry(stateDir);
});

afterEach(() => {
  for (const root of roots) cleanup(root);
  cleanup(stateDir);
});

function expectRegistryError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected registry error");
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayRegistryError);
    expect((error as GatewayRegistryError).code).toBe(code);
  }
}

describe("GatewayRegistry", () => {
  it("显式登记多个项目并按 client 隔离解析；撤销后 fail closed", () => {
    const first = registry.register(roots[0]!, "client-a");
    const second = registry.register(roots[1]!, "client-a");
    registry.register(roots[1]!, "client-b");

    expect(registry.list("client-a").map(entry => entry.workspaceId)).toEqual([first.workspaceId, second.workspaceId]);
    expect(registry.list("client-b").map(entry => entry.workspaceId)).toEqual([second.workspaceId]);
    expect(registry.resolve(first.workspaceId, "client-a").root).toBe(roots[0]);
    expect(() => registry.resolve(first.workspaceId, "client-b")).toThrow("client 未获准");
    expect(() => registry.resolve("000000000000", "client-a")).toThrow("workspace 未登记");

    expect(registry.revoke(second.workspaceId, "client-a")).toBe(true);
    expect(() => registry.resolve(second.workspaceId, "client-a")).toThrow("client 未获准");
    expect(registry.resolve(second.workspaceId, "client-b").root).toBe(roots[1]);
    expect(registry.revoke(second.workspaceId)).toBe(true);
    expect(() => registry.resolve(second.workspaceId, "client-b")).toThrow("workspace 未登记");
  });

  it("missing 清单视为空；registry 操作不创建 workspace 项目状态", () => {
    expect(registry.list()).toEqual([]);
    expect(fs.existsSync(gatewayRegistryFile(stateDir))).toBe(false);
    expect(fs.readdirSync(roots[0]!)).toEqual([]);

    const entry = registry.register(roots[0]!, "client-a");
    registry.resolve(entry.workspaceId, "client-a");
    expect(registry.list("client-a")).toHaveLength(1);
    expect(fs.readdirSync(roots[0]!)).toEqual([]);
    expect(fs.readdirSync(stateDir)).toEqual(["gateway"]);
  });

  it("root 与 workspaceId 错配时拒绝 resolve", () => {
    const entry = registry.register(roots[0]!, "client-a");
    const file = gatewayRegistryFile(stateDir);
    const state = JSON.parse(fs.readFileSync(file, "utf8")) as { workspaces: { workspaceId: string }[] };
    state.workspaces[0]!.workspaceId = "000000000000";
    fs.writeFileSync(file, JSON.stringify(state));
    expectRegistryError(() => registry.resolve("000000000000", "client-a"), "GATEWAY_WORKSPACE_ID_MISMATCH");
    expect(entry.workspaceId).not.toBe("000000000000");
  });

  it("symlink root 按 canonical root 登记，别名 retarget 不会转移授权", () => {
    const parent = makeTmpDir("gateway-registry-links");
    roots.push(parent);
    const first = path.join(parent, "first"), second = path.join(parent, "second"), alias = path.join(parent, "alias");
    fs.mkdirSync(first); fs.mkdirSync(second);
    fs.symlinkSync(first, alias, process.platform === "win32" ? "junction" : "dir");
    const entry = registry.register(alias, "client-a");
    expect(entry.root).toBe(fs.realpathSync.native(first));
    expect(JSON.parse(fs.readFileSync(gatewayRegistryFile(stateDir), "utf8")).workspaces[0].root).toBe(entry.root);

    try { fs.unlinkSync(alias); } catch { fs.rmdirSync(alias); }
    fs.symlinkSync(second, alias, process.platform === "win32" ? "junction" : "dir");
    expect(registry.resolve(entry.workspaceId, "client-a").root).toBe(entry.root);
  });

  it("登记后的规范 root 被 symlink retarget 时拒绝 resolve", () => {
    const parent = makeTmpDir("gateway-registry-retarget");
    roots.push(parent);
    const original = path.join(parent, "workspace"), moved = path.join(parent, "workspace-old"), other = path.join(parent, "other");
    fs.mkdirSync(original); fs.mkdirSync(other);
    const entry = registry.register(original, "client-a");
    fs.renameSync(original, moved);
    fs.symlinkSync(other, original, process.platform === "win32" ? "junction" : "dir");
    expectRegistryError(() => registry.resolve(entry.workspaceId, "client-a"), "GATEWAY_WORKSPACE_ID_MISMATCH");
  });

  it("corrupt schema/JSON 被拒绝且原文件保留；遗留 lock 不自动删除", () => {
    const file = gatewayRegistryFile(stateDir);
    registry.register(roots[0]!, "client-a");
    fs.writeFileSync(file, JSON.stringify({ version: 2, workspaces: [] }));
    const corruptBytes = fs.readFileSync(file, "utf8");
    expectRegistryError(() => registry.list(), "GATEWAY_REGISTRY_CORRUPT");
    expectRegistryError(() => registry.register(roots[1]!, "client-b"), "GATEWAY_REGISTRY_CORRUPT");
    expect(fs.readFileSync(file, "utf8")).toBe(corruptBytes);

    fs.writeFileSync(file, "broken");
    expectRegistryError(() => registry.list(), "GATEWAY_REGISTRY_CORRUPT");
    expect(fs.readFileSync(file, "utf8")).toBe("broken");

    fs.writeFileSync(file, JSON.stringify({ version: 1, workspaces: [] }));
    const lock = `${file}.lock`;
    fs.writeFileSync(lock, "stale-owner", { mode: 0o600 });
    expectRegistryError(() => registry.register(roots[1]!, "client-b"), "GATEWAY_REGISTRY_BUSY");
    expect(fs.readFileSync(lock, "utf8")).toBe("stale-owner");
  });
});
