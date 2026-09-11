import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { AuthStore, filterScopes, SUPPORTED_SCOPES } from "../src/auth/store.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const BASE_TOOL_NAMES = [
  "execution_output",
  "execution_summary",
  "git_diff",
  "git_status",
  "list_directory",
  "read_file",
  "search_workspace",
  "test_status",
  "workspace_info",
];
const BASE_SCOPES = [...SUPPORTED_SCOPES];
const READ_SCOPES = ["workspace.read", "workspace.search", "git.read", "execution.read"];
const PROBE_LOCATION = "c2c-state/write-probe.json";

type ToolList = Awaited<ReturnType<Client["listTools"]>>["tools"];
type ToolCallResult = Awaited<ReturnType<Client["callTool"]>>;

type ProbeContext = {
  bridge: Bridge;
  root: string;
  stateDir: string;
  connect: (scopes: string[], name?: string) => Promise<{ client: Client; token: string }>;
};

function textOf(result: { content?: unknown }): string {
  const content = result.content as { type?: string; text?: string }[] | undefined;
  return content?.find((item) => item.type === "text")?.text ?? "";
}

function payloadOf<T>(result: { content?: unknown; structuredContent?: unknown }): T {
  const parsed = JSON.parse(textOf(result)) as T;
  expect(result.structuredContent).toEqual(parsed);
  return parsed;
}

function tool(tools: ToolList, name: string): ToolList[number] {
  const found = tools.find((item) => item.name === name);
  expect(found).toBeDefined();
  return found!;
}

function annotationsOf(tools: ToolList): Record<string, unknown> {
  return Object.fromEntries(
    tools.filter((item) => item.name !== "write_probe").map((item) => [item.name, item.annotations ?? null])
  );
}

function expectNoPathLeak(value: unknown, ...paths: string[]): void {
  const serialized = JSON.stringify(value);
  for (const valuePath of paths) {
    expect(serialized).not.toContain(valuePath);
    expect(serialized).not.toContain(valuePath.replaceAll("\\", "\\\\"));
  }
}

async function discoveryScopes(base: string, suffix: string): Promise<unknown> {
  const response = await fetch(`${base}${suffix}`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { scopes_supported?: unknown };
  return body.scopes_supported;
}

async function withBridge<T>(enabled: boolean, fn: (context: ProbeContext) => Promise<T>): Promise<T> {
  const root = makeTmpDir("write-probe-workspace");
  const stateDir = makeTmpDir("write-probe-state");
  write(root, "hello.txt", "probe workspace\n");

  const previousStateDir = process.env.C2C_STATE_DIR;
  const previousFlag = process.env.C2C_ENABLE_WRITE_PROBE;
  process.env.C2C_STATE_DIR = stateDir;
  if (enabled) process.env.C2C_ENABLE_WRITE_PROBE = "1";
  else delete process.env.C2C_ENABLE_WRITE_PROBE;

  const clients: Client[] = [];
  let bridge: Bridge | undefined;
  try {
    bridge = await startBridge({
      workspaceRoot: root,
      port: 0,
      persistRuntime: false,
      authStoreFile: path.join(stateDir, "auth.json"),
    });
    const activeBridge = bridge;
    let clientNumber = 0;
    const connect = async (scopes: string[], name = "write-probe-test"): Promise<{ client: Client; token: string }> => {
      const issued = activeBridge.authStore.issueTokens({
        clientId: `${name}-${++clientNumber}`,
        scopes,
      });
      const client = new Client({ name: `${name}-${clientNumber}`, version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${activeBridge.localBaseUrl()}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${issued.accessToken}` } },
        })
      );
      clients.push(client);
      return { client, token: issued.accessToken };
    };
    return await fn({ bridge: activeBridge, root, stateDir, connect });
  } finally {
    for (const client of clients) await client.close().catch(() => undefined);
    if (bridge) await bridge.close();
    cleanup(root);
    cleanup(stateDir);
    if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousStateDir;
    if (previousFlag === undefined) delete process.env.C2C_ENABLE_WRITE_PROBE;
    else process.env.C2C_ENABLE_WRITE_PROBE = previousFlag;
  }
}

describe("MCP write_probe", () => {
  it("默认关闭时列出9个工具，开启时恰增write_probe且动态advertise probe.write", async () => {
    let readAnnotations: Record<string, unknown> | undefined;
    await withBridge(false, async ({ bridge, connect }) => {
      const { client } = await connect(READ_SCOPES, "default");
      const { tools } = await client.listTools();
      expect(tools.map((item) => item.name).sort()).toEqual([...BASE_TOOL_NAMES].sort());
      expect(tools.every((item) => item.annotations?.readOnlyHint === true)).toBe(true);
      expect(tools.find((item) => item.name === "write_probe")).toBeUndefined();
      readAnnotations = annotationsOf(tools);
      expect(await discoveryScopes(bridge.localBaseUrl(), "/.well-known/oauth-authorization-server/mcp")).toEqual([...BASE_SCOPES, "codex.control", "codex.read", "codex.desktop.control", "codex.desktop.read"]);
      expect(await discoveryScopes(bridge.localBaseUrl(), "/.well-known/oauth-protected-resource/mcp")).toEqual([...BASE_SCOPES, "codex.control", "codex.read", "codex.desktop.control", "codex.desktop.read"]);
    });

    await withBridge(true, async ({ bridge, connect }) => {
      const { client } = await connect([...READ_SCOPES, "probe.write"], "enabled");
      const { tools } = await client.listTools();
      expect(tools.map((item) => item.name).sort()).toEqual([...BASE_TOOL_NAMES, "write_probe"].sort());
      expect(annotationsOf(tools)).toEqual(readAnnotations);
      const probe = tool(tools, "write_probe");
      expect(probe.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      });
      expect(probe._meta).toEqual({ securitySchemes: [{ type: "oauth2", scopes: ["probe.write"] }] });
      const schema = probe.inputSchema as { type?: string; properties?: Record<string, unknown>; required?: string[] };
      expect(schema.type).toBe("object");
      expect(Object.keys(schema.properties ?? {})).toEqual(["nonce"]);
      expect(schema.required).toEqual(["nonce"]);
      expect(await discoveryScopes(bridge.localBaseUrl(), "/.well-known/oauth-authorization-server/mcp")).toEqual([
        ...BASE_SCOPES, "codex.control", "codex.read", "codex.desktop.control", "codex.desktop.read",
        "probe.write",
      ]);
      expect(await discoveryScopes(bridge.localBaseUrl(), "/.well-known/oauth-protected-resource/mcp")).toEqual([
        ...BASE_SCOPES, "codex.control", "codex.read", "codex.desktop.control", "codex.desktop.read",
        "probe.write",
      ]);
    });
  });

  it("旧 read token 没有 probe.write 时拒绝且不创建探针文件，并返回重新授权提示", async () => {
    await withBridge(true, async ({ connect, stateDir }) => {
      const { client } = await connect(READ_SCOPES, "read-only");
      const result = await client.callTool({ name: "write_probe", arguments: { nonce: "read-token" } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("INSUFFICIENT_SCOPE");
      expect((result._meta as Record<string, unknown> | undefined)?.["mcp/www_authenticate"]).toEqual([
        'Bearer error="insufficient_scope", error_description="Reauthorize this connector with probe.write", scope="probe.write"',
      ]);
      expect(fs.existsSync(path.join(stateDir, "write-probe.json"))).toBe(false);
    });
  });

  it("仅 probe.write scope 可以成功写入，但不能读取 workspace", async () => {
    await withBridge(true, async ({ bridge, connect, stateDir, root }) => {
      const { client, token } = await connect(["probe.write"], "write-only");
      const nonce = `${"A".repeat(127)}_`;
      const result = await client.callTool({ name: "write_probe", arguments: { nonce } });
      expect(result.isError ?? false).toBe(false);
      const response = payloadOf<{ ok: true; written: true; nonce: string; timestamp: string; location: string }>(result);
      expect(Object.keys(response).sort()).toEqual(["location", "nonce", "ok", "timestamp", "written"]);
      expect(response).toEqual({
        ok: true,
        written: true,
        nonce,
        timestamp: expect.any(String),
        location: PROBE_LOCATION,
      });
      expect(response.nonce).toHaveLength(128);
      expect(Number.isNaN(Date.parse(response.timestamp))).toBe(false);

      const file = path.join(stateDir, "write-probe.json");
      expect(fs.existsSync(file)).toBe(true);
      const fileText = fs.readFileSync(file, "utf8");
      const record = JSON.parse(fileText) as Record<string, unknown>;
      expect(Object.keys(record).sort()).toEqual(["nonce", "timestamp", "tool", "workspaceId"]);
      expect(record).toEqual({ nonce, timestamp: response.timestamp, workspaceId: bridge.workspace.id, tool: "write_probe" });
      expect(response.location).toBe(PROBE_LOCATION);
      expectNoPathLeak({ result, fileText }, stateDir, root, token);

      const denied = await client.callTool({ name: "workspace_info", arguments: {} });
      expect(denied.isError).toBe(true);
      expect(textOf(denied)).toContain("INSUFFICIENT_SCOPE");
    });
  });

  it("拒绝空值、超长、路径和 shell 字符串 nonce，且严格拒绝额外输入", async () => {
    await withBridge(true, async ({ connect, stateDir, root }) => {
      const { client } = await connect(["probe.write"], "invalid");
      const invalidNonces = ["", "A".repeat(129), "../", "a\\b", "$(echo probe)"];
      for (const nonce of invalidNonces) {
        let result: ToolCallResult | undefined;
        let error: unknown;
        try {
          result = await client.callTool({ name: "write_probe", arguments: { nonce } });
        } catch (caught) {
          error = caught;
        }
        const detail = result ? textOf(result) : String(error);
        expect(detail).toMatch(/invalid|nonce|argument|regex/i);
        if (result) expect(result.isError).toBe(true);
        expectNoPathLeak(detail, stateDir, root);
        expect(fs.existsSync(path.join(stateDir, "write-probe.json"))).toBe(false);
      }

      let extraResult: ToolCallResult | undefined;
      let extraError: unknown;
      try {
        extraResult = await client.callTool({ name: "write_probe", arguments: { nonce: "valid", path: "x" } });
      } catch (caught) {
        extraError = caught;
      }
      const extraDetail = extraResult ? textOf(extraResult) : String(extraError);
      expect(extraDetail).toMatch(/invalid|unknown|unrecognized|path|argument/i);
      if (extraResult) expect(extraResult.isError).toBe(true);
      expect(fs.existsSync(path.join(stateDir, "write-probe.json"))).toBe(false);
    });
  });

  it("关闭后工具消失且不可调用", async () => {
    await withBridge(true, async ({ connect }) => {
      const { client } = await connect(["probe.write"], "before-close");
      expect((await client.listTools()).tools.map((item) => item.name)).toContain("write_probe");
    });
    await withBridge(false, async ({ connect }) => {
      const { client } = await connect(READ_SCOPES, "after-close");
      expect((await client.listTools()).tools.map((item) => item.name)).not.toContain("write_probe");
      const result = await client.callTool({ name: "write_probe", arguments: { nonce: "after-close" } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/not found|unknown/i);
    });
  });

  it("保留 /mcp 的 Bearer 保护", async () => {
    await withBridge(true, async ({ bridge }) => {
      const response = await fetch(`${bridge.localBaseUrl()}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("resource_metadata");
    });
  });

  it("scope 默认不授 probe.write，且旧 refresh token 不会升级", async () => {
    const previousStateDir = process.env.C2C_STATE_DIR;
    const previousFlag = process.env.C2C_ENABLE_WRITE_PROBE;
    const stateDir = makeTmpDir("write-probe-scope-state");
    try {
      process.env.C2C_STATE_DIR = stateDir;
      delete process.env.C2C_ENABLE_WRITE_PROBE;
      expect(filterScopes(undefined)).toEqual(BASE_SCOPES);
      expect(filterScopes("unknown.scope")).toEqual(BASE_SCOPES);
      expect(filterScopes("probe.write")).toEqual(BASE_SCOPES);

      const store = new AuthStore("scope-test", { file: path.join(stateDir, "auth.json") });
      const initial = store.issueTokens({ clientId: "old-client", scopes: BASE_SCOPES });
      expect(initial.refreshToken).toBeTruthy();
      process.env.C2C_ENABLE_WRITE_PROBE = "1";
      expect(filterScopes(undefined)).toEqual(BASE_SCOPES);
      expect(filterScopes("probe.write")).toEqual(["probe.write"]);
      const refreshed = store.refresh(initial.refreshToken!, "old-client");
      expect(refreshed.ok).toBe(true);
      if (refreshed.ok) expect(refreshed.tokens.scopes).toEqual(BASE_SCOPES);
    } finally {
      cleanup(stateDir);
      if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
      else process.env.C2C_STATE_DIR = previousStateDir;
      if (previousFlag === undefined) delete process.env.C2C_ENABLE_WRITE_PROBE;
      else process.env.C2C_ENABLE_WRITE_PROBE = previousFlag;
    }
  });

  it("写入失败时返回固定错误且不泄露绝对路径", async () => {
    await withBridge(true, async ({ connect, stateDir, root }) => {
      const { client } = await connect(["probe.write"], "write-failure");
      cleanup(stateDir);
      fs.writeFileSync(stateDir, "state directory blocked");
      const result = await client.callTool({ name: "write_probe", arguments: { nonce: "write-failure" } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("PROBE_WRITE_FAILED");
      expectNoPathLeak(result, stateDir, root);
    });
  });
});
