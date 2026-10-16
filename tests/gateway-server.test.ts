import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startGatewayServer } from "../src/gateway/server.js";
import { companionToken } from "../src/companion/store.js";
import { getStateDir } from "../src/config/paths.js";

const TOKEN = "runtime-token-for-tests";
const REDIRECT = "http://127.0.0.1:9/callback";
const onShutdown = vi.fn();
let gw: Awaited<ReturnType<typeof startGatewayServer>>;

// fetch 不允许改 Host 头，用 node:http 发原始请求
function raw(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: gw.port, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

const base = () => `http://127.0.0.1:${gw.port}`;
const internal = { "x-c2c-runtime-token": TOKEN };

beforeAll(async () => {
  gw = await startGatewayServer({ port: 0, publicUrl: "https://gw.example.test", runtimeToken: TOKEN, onShutdown });
});
afterAll(() => gw.close());

describe("gateway server", () => {
  it("serves OAuth metadata and challenges /mcp without a bearer", async () => {
    const meta = await (await fetch(`${base()}/.well-known/oauth-authorization-server`)).json() as any;
    expect(meta.issuer).toBe("https://gw.example.test");
    const res = await fetch(`${base()}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }) });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("completes OAuth with the pairing code and lists tools over /mcp", async () => {
    const reg = await fetch(`${base()}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "t", redirect_uris: [REDIRECT] }) });
    const clientId = ((await reg.json()) as any).client_id as string;
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", scope: "workspace.read", state: "xyz" });
    const page = await (await fetch(`${base()}/oauth/authorize?${q}`)).text();
    const requestId = /name="request_id" value="([^"]+)"/.exec(page)![1];

    const { code } = gw.pairingCode();
    const done = await fetch(`${base()}/oauth/authorize`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId, pairing_code: code }),
    });
    expect(done.status).toBe(302);
    const loc = new URL(done.headers.get("location")!);
    expect(loc.searchParams.get("state")).toBe("xyz");

    const tok = await fetch(`${base()}/oauth/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: loc.searchParams.get("code")!, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT }),
    });
    const access = ((await tok.json()) as any).access_token as string;
    expect(access).toBeTruthy();

    const list = await fetch(`${base()}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${access}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(list.status).toBe(200);
    const names = ((await list.json()) as any).result.tools.map((t: any) => t.name);
    expect(names).toContain("gateway_list_workspaces");
  });

  it("rejects proxied or foreign-host requests on companion and internal endpoints", async () => {
    const auth = { authorization: `Bearer ${companionToken()}` };
    expect((await raw("/companion/v1/state", { headers: auth })).status).toBe(200);
    for (const extra of [{ "x-forwarded-for": "1.2.3.4" }, { "cf-connecting-ip": "1.2.3.4" }, { host: "gw.example.test" }, { host: "localhost:1" }]) {
      expect((await raw("/companion/v1/state", { headers: { ...auth, ...extra } })).status).toBe(404);
      expect((await raw("/internal/health", { headers: { ...internal, ...extra } })).status).toBe(404);
    }
    expect((await raw("/nope")).status).toBe(404);
    const denied = await raw("/companion/v1/state", { headers: { ...auth, host: "gw.example.test" } });
    expect(JSON.parse(denied.text)).toMatchObject({ error: "NOT_LOCAL" });
  });

  it("accepts localhost:<port> as a local host", async () => {
    const auth = { authorization: `Bearer ${companionToken()}`, host: `localhost:${gw.port}` };
    expect((await raw("/companion/v1/state", { headers: auth })).status).toBe(200);
  });

  it("caps stored clients and pending authorization requests", async () => {
    const register = async () => ((await (await fetch(`${base()}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) })).json()) as any).client_id as string;
    let last = "";
    for (let i = 0; i < 55; i++) last = await register();
    const saved = JSON.parse(fs.readFileSync(path.join(getStateDir(), "auth", "gateway.json"), "utf8"));
    expect(saved.clients.length).toBeLessThanOrEqual(50);
    expect(saved.clients.some((c: any) => c.clientId === last)).toBe(true);

    const q = new URLSearchParams({ client_id: last, redirect_uri: REDIRECT, response_type: "code", code_challenge: "c", code_challenge_method: "S256" });
    const statuses: number[] = [];
    for (let i = 0; i < 101; i++) statuses.push((await fetch(`${base()}/oauth/authorize?${q}`)).status);
    expect(statuses.slice(0, 100).every((s) => s === 200)).toBe(true);
    expect(statuses[100]).toBe(429);
  });

  it("requires the runtime token on internal endpoints", async () => {
    expect((await raw("/internal/health")).status).toBe(401);
    expect((await raw("/internal/health", { headers: { "x-c2c-runtime-token": "wrong" } })).status).toBe(401);
    const ok = await raw("/internal/health", { headers: internal });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.text)).toMatchObject({ ok: true, port: gw.port });
    expect((await raw("/internal/pairing", { method: "POST" })).status).toBe(401);
    const pair = JSON.parse((await raw("/internal/pairing", { method: "POST", headers: internal })).text);
    expect(pair.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(pair.expiresAt).toBeGreaterThan(Date.now());
  });

  it("calls onShutdown after answering /internal/shutdown", async () => {
    expect((await raw("/internal/shutdown", { method: "POST" })).status).toBe(401);
    expect(onShutdown).not.toHaveBeenCalled();
    const res = await raw("/internal/shutdown", { method: "POST", headers: internal });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(onShutdown).toHaveBeenCalledTimes(1));
  });
});
