import http from "node:http";
import { once } from "node:events";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestHttp, requestJson } from "./http-json.js";

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
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`, sockets,
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

describe("direct HTTP fixture client", () => {
  it("passes a Fetch-forbidden URL to Node HTTP and preserves real auth/method/body/status", async () => {
    const received: unknown[] = [];
    const fixture = await serve((req, res) => {
      let body = "";
      req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        received.push({ method: req.method, path: req.url, auth: req.headers.authorization, body });
        res.statusCode = req.headers.authorization === "Bearer fixture" ? 201 : 401;
        res.end(JSON.stringify({ authorized: res.statusCode === 201 }));
      });
    });
    try {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Fetch must not be used"));
      const nativeRequest = http.request;
      // Unit seam maps only the TCP destination to our real port=0 server. No fixed port is bound.
      const requests = vi.spyOn(http, "request").mockImplementation(((url: URL, options: http.RequestOptions, callback: (res: http.IncomingMessage) => void) => {
        expect(new URL(url).port).toBe("6000");
        return nativeRequest(`${fixture.url}${new URL(url).pathname}`, options, callback);
      }) as typeof http.request);
      expect(await requestJson("http://127.0.0.1:6000/auth")).toEqual({ status: 401, body: { authorized: false } });
      expect(await requestJson("http://127.0.0.1:6000/auth", {
        method: "POST", headers: { authorization: "Bearer fixture", "content-type": "application/json" }, body: '{"x":1}',
      })).toEqual({ status: 201, body: { authorized: true } });
      expect(requests).toHaveBeenCalledTimes(2);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(received).toEqual([
        { method: "GET", path: "/auth", auth: undefined, body: "" },
        { method: "POST", path: "/auth", auth: "Bearer fixture", body: '{"x":1}' },
      ]);
    } finally { await fixture.close(); }
  });

  it.each([{ status: 200, text: "<html>fixture</html>" }, { status: 204, text: "" }, { status: 200, text: "{broken" }])(
    "preserves text/empty responses but keeps JSON strict (%s)", async ({ status, text }) => {
      const fixture = await serve((_req, res) => { res.statusCode = status; res.setHeader("x-fixture", "exact"); res.end(text); });
      try {
        const response = await requestHttp(fixture.url);
        expect(response.status).toBe(status);
        expect(response.headers.get("x-fixture")).toBe("exact");
        expect(await response.text()).toBe(text);
        await expect(requestJson(fixture.url)).rejects.toThrow(SyntaxError);
      } finally { await fixture.close(); }
    },
  );

  it("keeps redirect responses manual and URLSearchParams unchanged", async () => {
    const received: string[] = [];
    const fixture = await serve((req, res) => {
      let body = ""; req.on("data", chunk => { body += chunk; }); req.on("end", () => {
        received.push(body); res.writeHead(302, { location: "/must-not-follow" }); res.end();
      });
    });
    try {
      const response = await requestHttp(fixture.url, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ value: "a b" }), redirect: "manual",
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/must-not-follow");
      expect(received).toEqual(["value=a+b"]);
    } finally { await fixture.close(); }
  });

  it.each([false, true])("bounds a hung response and closes its socket/timer (partial=%s)", async partial => {
    let ready!: () => void;
    const received = new Promise<void>(resolve => { ready = resolve; });
    let closed!: Promise<unknown>;
    const fixture = await serve((req, res) => {
      // A timeout can reset this exact server socket; wait for close, not the error-rejecting events.once.
      closed = new Promise<void>(resolve => req.socket.once("close", () => resolve()));
      if (partial) { res.writeHead(200); res.write("unfinished"); }
      ready();
    });
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const rejected = expect(requestHttp(fixture.url, { timeoutMs: 100 })).rejects.toThrow("test HTTP response timeout");
      await received;
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      await closed;
      expect(fixture.sockets.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); await fixture.close(); }
  });

  it("clears the deadline after success and releases the client connection", async () => {
    let clientClosed!: Promise<unknown>;
    const nativeRequest = http.request;
    vi.spyOn(http, "request").mockImplementation(((...args: Parameters<typeof http.request>) => {
      const req = nativeRequest(...args); clientClosed = once(req, "close"); return req;
    }) as typeof http.request);
    const fixture = await serve((_req, res) => res.end('{"ok":true}'));
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      expect(await requestJson(fixture.url)).toEqual({ status: 200, body: { ok: true } });
      await clientClosed;
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); await fixture.close(); }
  });
});
