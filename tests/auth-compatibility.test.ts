import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import fs from "node:fs";
import path from "node:path";
import { startBridge } from "../src/bridge/server.js";
import {
  DESKTOP_CONTROL_SCOPE,
  DESKTOP_READ_SCOPE,
  SUPPORTED_SCOPES,
  AuthStore,
} from "../src/auth/store.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) cleanup(dir);
});

function makeStore(workspaceId = "compat-workspace"): AuthStore {
  const dir = makeTmpDir("auth-compat");
  dirs.push(dir);
  return new AuthStore(workspaceId, { file: path.join(dir, "auth.json") });
}

describe("Desktop OAuth compatibility", () => {
  it("旧五个 scope 的授权报告为 legacy", () => {
    const store = makeStore();
    const token = store.issueTokens({ clientId: "legacy", scopes: [...SUPPORTED_SCOPES] });

    expect(store.desktopCompatibility(token.accessToken)).toEqual({ status: "legacy" });
    expect(store.desktopCompatibility()).toEqual({ status: "legacy" });
  });

  it.each([DESKTOP_READ_SCOPE, DESKTOP_CONTROL_SCOPE])("单个 Desktop scope 报告为 incomplete：%s", (scope) => {
    const store = makeStore();
    const token = store.issueTokens({ clientId: "partial", scopes: [scope] });

    expect(store.desktopCompatibility(token.accessToken)).toEqual({ status: "incomplete" });
    expect(store.desktopCompatibility()).toEqual({ status: "incomplete" });
  });

  it.each([
    ["same-client", "same-client"],
    ["read-client", "control-client"],
  ])("不同 token 不拼接 scope（clientId：%s / %s）", (readClient, controlClient) => {
    const store = makeStore();
    const read = store.issueTokens({ clientId: readClient, scopes: [DESKTOP_READ_SCOPE] });
    const control = store.issueTokens({ clientId: controlClient, scopes: [DESKTOP_CONTROL_SCOPE] });

    expect(store.desktopCompatibility(read.accessToken)).toEqual({ status: "incomplete" });
    expect(store.desktopCompatibility(control.accessToken)).toEqual({ status: "incomplete" });
    expect(store.desktopCompatibility()).toEqual({ status: "unknown" });
  });

  it("同一授权记录包含两个 Desktop scope 时报告为 current", () => {
    const store = makeStore();
    const legacy = store.issueTokens({ clientId: "old-client", scopes: [...SUPPORTED_SCOPES] });
    const token = store.issueTokens({
      clientId: "current",
      scopes: [...SUPPORTED_SCOPES, DESKTOP_READ_SCOPE, DESKTOP_CONTROL_SCOPE],
    });

    expect(store.desktopCompatibility(legacy.accessToken)).toEqual({ status: "legacy" });
    expect(store.desktopCompatibility(token.accessToken)).toEqual({ status: "current" });
    expect(store.desktopCompatibility()).toEqual({ status: "current" });
  });

  it("忽略过期和撤销的 access 授权记录", () => {
    const store = makeStore();
    const expired = store.issueTokens({
      clientId: "expired",
      scopes: [DESKTOP_READ_SCOPE, DESKTOP_CONTROL_SCOPE],
      accessTtlMs: -1,
    });
    expect(store.desktopCompatibility()).toEqual({ status: "none" });
    expect(store.desktopCompatibility(expired.accessToken)).toEqual({ status: "unknown" });

    const revoked = store.issueTokens({ clientId: "revoked", scopes: [DESKTOP_READ_SCOPE, DESKTOP_CONTROL_SCOPE] });
    expect(store.revokeToken(revoked.accessToken)).toBe(true);
    expect(store.desktopCompatibility()).toEqual({ status: "none" });
  });

  it("access 过期时保留有效 refresh grant 的 admin 兼容性", () => {
    const store = makeStore();
    const expired = store.issueTokens({
      clientId: "refresh-client",
      scopes: ["offline_access", DESKTOP_READ_SCOPE, DESKTOP_CONTROL_SCOPE],
      accessTtlMs: -1,
    });

    expect(expired.refreshToken).not.toBeNull();
    expect(store.desktopCompatibility(expired.accessToken)).toEqual({ status: "unknown" });
    expect(store.desktopCompatibility()).toEqual({ status: "current" });

    const refreshed = store.refresh(expired.refreshToken!, "refresh-client");
    expect(refreshed.ok).toBe(true);
    if (refreshed.ok) expect(store.desktopCompatibility(refreshed.tokens.accessToken)).toEqual({ status: "current" });
  });

  it("没有有效 access 授权时报告为 none", () => {
    expect(makeStore().desktopCompatibility()).toEqual({ status: "none" });
  });

  it.each([
    "{broken",
    JSON.stringify({ clients: [], tokens: {} }),
  ])("损坏的授权状态报告为 corrupt 并保持 fail closed：%s", (content) => {
    const dir = makeTmpDir("auth-corrupt");
    dirs.push(dir);
    const file = path.join(dir, "auth.json");
    fs.writeFileSync(file, content);
    const store = new AuthStore("compat-workspace", { file });

    expect(store.desktopCompatibility()).toEqual({ status: "corrupt" });
    expect(store.tokenCount()).toBe(0);
    expect(store.verifyAccessToken("c2c_at_not-a-token")).toMatchObject({ ok: false });
    expect(() => store.issueTokens({ clientId: "new", scopes: [DESKTOP_READ_SCOPE, DESKTOP_CONTROL_SCOPE] })).toThrow(/授权状态损坏/);
    expect(() => store.registerClient({ redirectUris: [] })).toThrow(/授权状态损坏/);
    expect(() => store.revokeAll()).toThrow(/授权状态损坏/);
    expect(fs.readFileSync(file, "utf8")).toBe(content);
  });

  it("无效 clientId 不能报告为 current", () => {
    const store = makeStore();
    const token = store.issueTokens({ clientId: "", scopes: [DESKTOP_READ_SCOPE, DESKTOP_CONTROL_SCOPE] });

    expect(store.desktopCompatibility(token.accessToken)).toEqual({ status: "unknown" });
    expect(store.desktopCompatibility()).toEqual({ status: "unknown" });
  });

  it("兼容性只属于 AuthStore 对应 workspace", () => {
    const store = makeStore("workspace-a");
    const foreign = store.issueTokens({
      clientId: "foreign",
      workspaceId: "workspace-b",
      scopes: [DESKTOP_READ_SCOPE, DESKTOP_CONTROL_SCOPE],
    });

    expect(store.desktopCompatibility()).toEqual({ status: "none" });
    expect(store.desktopCompatibility(foreign.accessToken)).toEqual({ status: "unknown" });
  });

  it("admin info 只暴露契约版本和兼容性状态", async () => {
    const root = makeTmpDir("auth-admin-workspace");
    const authDir = makeTmpDir("auth-admin-state");
    dirs.push(root, authDir);
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(authDir, "auth.json"),
    });
    try {
      const token = bridge.authStore.issueTokens({
        clientId: "current",
        scopes: [DESKTOP_READ_SCOPE, DESKTOP_CONTROL_SCOPE],
      });
      const response = await fetch(`${bridge.localBaseUrl()}/admin/info`, {
        headers: { authorization: `Bearer ${bridge.adminToken}` },
      });
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body.connectorContractVersion).toBe(1);
      expect(body.feedbackControlEventVersion).toBe(1);
      expect(body.desktopCompatibility).toEqual({ status: "current" });
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(token.accessToken);
      expect(serialized).not.toContain(token.refreshToken ?? "__no_refresh_token__");
      expect(serialized).not.toContain("hash");
      expect(serialized).not.toContain("clientSecret");
    } finally {
      await bridge.close();
    }
  });

  it("workspace_info 按当前请求 token 分别报告新旧兼容性且不泄露 token", async () => {
    const root = makeTmpDir("auth-mcp-workspace");
    const authDir = makeTmpDir("auth-mcp-state");
    dirs.push(root, authDir);
    const bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(authDir, "auth.json"),
    });
    const old = bridge.authStore.issueTokens({ clientId: "old-client", scopes: [...SUPPORTED_SCOPES] });
    const current = bridge.authStore.issueTokens({
      clientId: "current-client",
      scopes: ["workspace.read", DESKTOP_READ_SCOPE, DESKTOP_CONTROL_SCOPE],
    });

    async function infoFor(accessToken: string): Promise<Record<string, unknown>> {
      const client = new Client({ name: "auth-compatibility-test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
      }));
      try {
        const result = await client.callTool({ name: "workspace_info", arguments: {} });
        const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
        return JSON.parse(text) as Record<string, unknown>;
      } finally {
        await client.close();
      }
    }

    try {
      const oldInfo = await infoFor(old.accessToken);
      const currentInfo = await infoFor(current.accessToken);
      expect(oldInfo.desktopCompatibility).toEqual({ status: "legacy" });
      expect(currentInfo.desktopCompatibility).toEqual({ status: "current" });
      expect(oldInfo.connectorContractVersion).toBe(1);
      expect(currentInfo.connectorContractVersion).toBe(1);
      expect(JSON.stringify(oldInfo)).not.toContain(old.accessToken);
      expect(JSON.stringify(currentInfo)).not.toContain(current.accessToken);
    } finally {
      await bridge.close();
    }
  });
});
