import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startGatewayServer, type GatewayServer } from "../src/remote/server.js";
import { cleanup, isolateStateDir } from "./helpers.js";
import { requestHttp } from "./http-json.js";

let previousStateDir: string | undefined;
let stateDir: string;
let server: GatewayServer | undefined;

beforeEach(() => {
  previousStateDir = process.env.C2C_STATE_DIR;
  stateDir = isolateStateDir();
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  cleanup(stateDir);
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
});

describe("Gateway request diagnostics", () => {
  it("records only method, fixed path and status for MCP and refresh requests", async () => {
    server = await startGatewayServer({ port: 0, publicUrl: "https://gateway.example.test" });
    const baseUrl = server.localBaseUrl();
    const querySecret = "QUERY_DIAGNOSTIC_SECRET_4fc4";
    const bodySecret = "BODY_DIAGNOSTIC_SECRET_2a2a";
    const refreshSecret = "REFRESH_DIAGNOSTIC_SECRET_7b7b";

    const discovery = await requestHttp(`${baseUrl}/mcp?probe=${querySecret}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: bodySecret, version: "1" },
      } }),
    });
    const protectedCall = await requestHttp(`${baseUrl}/mcp?probe=${querySecret}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer c2c_at_DIAGNOSTIC_HEADER_SECRET_123456",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
        name: "gateway_list_workspaces", arguments: { marker: bodySecret },
      } }),
    });
    const refresh = await requestHttp(`${baseUrl}/oauth/token?probe=${querySecret}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token", refresh_token: refreshSecret, client_id: "diagnostic-client",
      }),
    });

    expect(discovery.status).toBe(200);
    expect(protectedCall.status).toBe(401);
    expect(refresh.status).toBe(400);

    const log = fs.readFileSync(path.join(stateDir, "logs", "remote-mcp-machine-gateway.log"), "utf8");
    const entries = log.trim().split(/\r?\n/).map(line => JSON.parse(line.slice(line.indexOf("{"))));
    expect(entries).toEqual([
      { method: "POST", path: "/mcp", statusCode: 200 },
      { method: "POST", path: "/mcp", statusCode: 401 },
      { method: "POST", path: "/oauth/token", statusCode: 400 },
    ]);
    for (const secret of [querySecret, bodySecret, refreshSecret, "DIAGNOSTIC_HEADER_SECRET_123456"])
      expect(log).not.toContain(secret);
  });
});
