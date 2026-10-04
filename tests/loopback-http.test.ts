import http from "node:http";
import { once, EventEmitter } from "node:events";
import type { Socket } from "node:net";
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOOPBACK_RESPONSE_LIMIT, requestLoopback } from "../src/bridge/loopback-http.js";
import { adminFetch, probeBridge, type RuntimeState } from "../src/bridge/runtime.js";
import { SERVICE_NAME } from "../src/version.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

async function serve(handler: http.RequestListener) {
  const sockets = new Set<Socket>();
  const server = http.createServer(handler);
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    port: (server.address() as { port: number }).port,
    async drained() {
      await Promise.all([...sockets].map(socket => new Promise<void>(resolve => socket.once("close", () => resolve()))));
      expect(sockets.size).toBe(0);
    },
    async close() {
      const closed = [...sockets].map(socket => new Promise<void>(resolve => socket.once("close", () => resolve())));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await Promise.all(closed);
      expect(server.listening).toBe(false);
      expect(sockets.size).toBe(0);
    },
  };
}

describe("production literal-loopback HTTP", () => {
  it("port 6000 reaches a real port=0 server through production health/admin/doctor requests, never Fetch", async () => {
    const received: unknown[] = [];
    const fixture = await serve((req, res) => {
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        received.push({ method: req.method, path: req.url, auth: req.headers.authorization, body, reason: req.headers["x-c2c-shutdown-reason"] });
        res.setHeader("x-test", "exact");
        res.statusCode = req.url === "/mcp" ? 401 : req.url === "/missing" ? 404 : 200;
        res.end(JSON.stringify({ service: SERVICE_NAME, status: "ok" }));
      });
    });
    try {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Fetch forbidden-port path must not run"));
      const nativeRequest = http.request;
      const request = vi.spyOn(http, "request").mockImplementation(((options: http.RequestOptions, callback: (res: http.IncomingMessage) => void) => {
        expect(options).toMatchObject({ hostname: "127.0.0.1", port: 6000, agent: false });
        // Change only TCP destination, never the path/auth/body/method. No fixed port is bound.
        return nativeRequest({ ...options, port: fixture.port }, callback);
      }) as typeof http.request);
      const runtime = { port: 6000, adminToken: "fixture-token" } as RuntimeState;
      expect(await probeBridge(6000)).toEqual({ service: SERVICE_NAME, status: "ok" });
      expect(await adminFetch(runtime, "GET", "/admin/info")).toHaveProperty("status", "ok");
      expect(await adminFetch(runtime, "POST", "/admin/shutdown", 5000, { shutdownReason: "rollout" })).toHaveProperty("status", "ok");
      const ping = JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 });
      const mcp = await requestLoopback({ port: 6000, path: "/mcp", method: "POST", headers: { "content-type": "application/json" }, body: ping, timeoutMs: 8000 });
      expect(mcp.status).toBe(401); expect(mcp.headers["x-test"]).toBe("exact");
      expect((await requestLoopback({ port: 6000, path: "/missing", timeoutMs: 2000 })).status).toBe(404);
      expect(request).toHaveBeenCalledTimes(5);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(received).toEqual([
        { method: "GET", path: "/health", auth: undefined, body: "", reason: undefined },
        { method: "GET", path: "/admin/info", auth: "Bearer fixture-token", body: "", reason: undefined },
        { method: "POST", path: "/admin/shutdown", auth: "Bearer fixture-token", body: "", reason: "rollout" },
        { method: "POST", path: "/mcp", auth: undefined, body: ping, reason: undefined },
        { method: "GET", path: "/missing", auth: undefined, body: "", reason: undefined },
      ]);
      await fixture.drained();
    } finally { await fixture.close(); }
  });

  it.each([
    [401, '{"message":"unauthorized"}', "unauthorized"],
    [404, "", "Admin request failed (404)"],
    [500, "not-json", "Admin request failed (500)"],
    [302, "", "Admin request failed (302)"],
  ])("preserves admin error semantics and never follows redirect (%s)", async (status, body, message) => {
    let requests = 0;
    const fixture = await serve((_req, res) => {
      requests++; res.writeHead(status, { location: "http://outside.invalid/never" }); res.end(body);
    });
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await expect(adminFetch({ port: fixture.port, adminToken: "secret" } as RuntimeState, "GET", "/admin/info")).rejects.toThrow(message);
      expect(await probeBridge(fixture.port)).toBeNull();
      expect(requests).toBe(2); // one request per caller, no redirect or hidden retry
      await fixture.drained(); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); await fixture.close(); }
  });

  it.each(["{broken", "", "null", '{"service":"foreign"}'])("malformed/foreign health is not healthy (%s)", async body => {
    const fixture = await serve((_req, res) => res.end(body));
    try {
      expect(await probeBridge(fixture.port)).toBeNull();
      if (body === "{broken" || body === "")
        expect(await adminFetch({ port: fixture.port, adminToken: "fixture" } as RuntimeState, "GET", "/admin/info")).toEqual({});
      await fixture.drained();
    } finally { await fixture.close(); }
  });

  it.each(["headers", "partial", "drip"])("health total 2s deadline includes %s and destroys socket/timer", async stage => {
    let ready!: () => void;
    const received = new Promise<void>(resolve => { ready = resolve; });
    let currentResponse!: http.ServerResponse;
    const fixture = await serve((_req, res) => {
      currentResponse = res;
      if (stage !== "headers") { res.writeHead(200); res.write('{"service":'); }
      ready();
    });
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const result = probeBridge(fixture.port); // production default remains 2s
      await received;
      await vi.advanceTimersByTimeAsync(1999);
      if (stage === "drip") currentResponse.write('"'); // data cannot reset the total deadline
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toBeNull();
      await fixture.drained(); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); await fixture.close(); }
  });

  it("deadline also covers a TCP connection that never completes", async () => {
    vi.useFakeTimers();
    const pending = new EventEmitter() as http.ClientRequest;
    pending.end = vi.fn(() => pending);
    pending.destroy = vi.fn(() => { pending.emit("close"); return pending; });
    vi.spyOn(http, "request").mockReturnValue(pending);
    const result = expect(requestLoopback({ port: 6000, path: "/health", timeoutMs: 8000 })).rejects.toThrow("response timeout");
    await vi.advanceTimersByTimeAsync(8000); await result;
    expect(pending.destroy).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("reset/partial response fails and closes resources (partial=%s)", async partial => {
    const fixture = await serve((_req, res) => {
      if (partial) { res.writeHead(200, { "content-length": "100" }); res.write("x", () => res.destroy()); }
      else res.destroy();
    });
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await expect(requestLoopback({ port: fixture.port, path: "/health", timeoutMs: 2000 })).rejects.toThrow(/Loopback HTTP (request failed|response incomplete|response failed)/);
      await fixture.drained(); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); await fixture.close(); }
  });

  it.each([0, 1])("response byte cap is exact and closes the peer (overflow=%s)", async extra => {
    const fixture = await serve((_req, res) => res.end(Buffer.alloc(LOOPBACK_RESPONSE_LIMIT + extra, 120)));
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const response = requestLoopback({ port: fixture.port, path: "/health", timeoutMs: 2000 });
      if (extra) await expect(response).rejects.toThrow("response too large");
      else expect((await response).body.length).toBe(LOOPBACK_RESPONSE_LIMIT);
      await fixture.drained(); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); await fixture.close(); }
  });

  it.each([0, -1, 65536, 1.5, NaN])("rejects invalid port %s before any request", async port => {
    const request = vi.spyOn(http, "request");
    await expect(requestLoopback({ port, path: "/health", timeoutMs: 2000 })).rejects.toThrow("Invalid loopback port");
    expect(request).not.toHaveBeenCalled();
  });
  it.each(["https://outside.invalid", "//outside.invalid", "/x\r\nAuthorization: secret", "/\\outside", "/x#fragment"])("rejects non-origin path %s", async path => {
    const request = vi.spyOn(http, "request");
    await expect(requestLoopback({ port: 6000, path, timeoutMs: 2000 })).rejects.toThrow("Invalid loopback path");
    expect(request).not.toHaveBeenCalled();
  });
  it("synchronous header failures expose no credential and leave no timer", async () => {
    vi.useFakeTimers();
    await expect(requestLoopback({ port: 6000, path: "/admin/info", headers: { Authorization: "secret\r\ninvalid" }, timeoutMs: 2000 })).rejects.toThrow(/^Loopback HTTP request failed$/);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([0, -1, 1.5, Infinity, 2_147_483_648])("rejects unbounded/invalid deadline %s before opening a socket", async timeoutMs => {
    const request = vi.spyOn(http, "request");
    await expect(requestLoopback({ port: 6000, path: "/health", timeoutMs })).rejects.toThrow("Invalid loopback timeout");
    expect(request).not.toHaveBeenCalled();
  });
  it("admin uses its caller deadline through an incomplete body", async () => {
    let ready!: () => void;
    const received = new Promise<void>(resolve => { ready = resolve; });
    const fixture = await serve((_req, res) => { res.writeHead(200); res.write("{"); ready(); });
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const result = expect(adminFetch({ port: fixture.port, adminToken: "fixture" } as RuntimeState, "POST", "/admin/action", 5000)).rejects.toThrow("response timeout");
      await received; await vi.advanceTimersByTimeAsync(4999);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1); await result;
      await fixture.drained(); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); await fixture.close(); }
  });
  it("local doctor uses the bounded helper while public health still uses Fetch", () => {
    const source = fs.readFileSync("src/cli/runtime.ts", "utf8");
    expect(source).toContain('requestLoopback({ port: runtime.port, path: "/mcp", timeoutMs: 8000,');
    expect(source).toContain('ok: response.status === 401');
    expect(source).not.toContain('fetch(`http://127.0.0.1:');
    expect(source).toContain('fetch(`${currentUrl}/health`');
  });
});
