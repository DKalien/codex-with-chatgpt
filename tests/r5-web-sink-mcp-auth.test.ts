import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import {
  DESKTOP_READ_SCOPE,
  EXECUTOR_READ_SCOPE,
  WEB_SINK_READ_SCOPE,
} from "../src/auth/store.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

describe("R5c real MCP web sink authorization", () => {
  let wsRoot: string;
  let stateDir: string;
  let previousStateDir: string | undefined;
  let bridge: Bridge;

  async function clientFor(scopes: string[], name: string): Promise<Client> {
    const token = bridge.authStore.issueTokens({ clientId: name, scopes });
    const client = new Client({ name, version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token.accessToken}` } },
    }));
    return client;
  }

  beforeEach(async () => {
    previousStateDir = process.env.C2C_STATE_DIR;
    stateDir = isolateStateDir();
    wsRoot = makeTmpDir("r5c-mcp-ws");
    process.env.C2C_STATE_DIR = stateDir;
    bridge = await startBridge({
      workspaceRoot: wsRoot,
      port: 0,
      persistRuntime: false,
      runtimeBuildId: null,
      authStoreFile: stateDir + "/auth.json",
    });
  });

  afterEach(async () => {
    await bridge.close();
    if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousStateDir;
    cleanup(wsRoot);
    cleanup(stateDir);
  });

  it("web_sink_list requires codex.websink.read", async () => {
    for (const [scopes, name] of [
      [["workspace.read"], "ws"],
      [[EXECUTOR_READ_SCOPE], "exec"],
      [[DESKTOP_READ_SCOPE], "desk"],
    ] as [string[], string][]) {
      const client = await clientFor(scopes, name);
      const denied = await client.callTool({ name: "web_sink_list", arguments: {} });
      expect(denied.isError, name).toBe(true);
      await client.close();
    }
    const okClient = await clientFor([WEB_SINK_READ_SCOPE], "sink-read");
    const allowed = await okClient.callTool({ name: "web_sink_list", arguments: {} });
    expect(allowed.isError).not.toBe(true);
    await okClient.close();
  });

  it("web_sink_status rejects wrong scope and workspace; returns generic fields only", async () => {
    const badScope = await clientFor([DESKTOP_READ_SCOPE], "desk-status");
    const denied = await badScope.callTool({
      name: "web_sink_status",
      arguments: { workspaceId: bridge.workspace.id },
    });
    expect(denied.isError).toBe(true);
    await badScope.close();

    const client = await clientFor([WEB_SINK_READ_SCOPE], "sink-status");
    const wrongWs = await client.callTool({
      name: "web_sink_status",
      arguments: { workspaceId: "aaaaaaaaaaaa" },
    });
    expect(wrongWs.isError).toBe(true);

    const status = await client.callTool({
      name: "web_sink_status",
      arguments: { workspaceId: bridge.workspace.id },
    });
    expect(status.isError).not.toBe(true);
    const text = JSON.stringify(status);
    expect(text).not.toMatch(/principalFingerprint|credential|challenge|plannerRouteId/);
    expect(text).toContain("workspaceId");
    await client.close();
  });

  it("has no MCP web_sink_bind tool", async () => {
    const client = await clientFor([WEB_SINK_READ_SCOPE], "sink-list");
    const tools = await client.listTools();
    expect(tools.tools.map(t => t.name)).not.toContain("web_sink_bind");
    expect(tools.tools.map(t => t.name)).not.toContain("web_sink_switch");
    await client.close();
  });
});
