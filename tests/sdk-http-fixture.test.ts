import http from "node:http";
import { getEventListeners, once } from "node:events";
import type { Socket } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sdkFixtureFetch, StreamableHTTPClientTransport } from "./sdk-http-fixture.js";

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
    url: `http://127.0.0.1:${port}`,
    sockets,
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

afterEach(() => vi.restoreAllMocks());

describe("SDK loopback HTTP fixture", () => {
  it("initializes and preserves auth results through a logical Fetch-forbidden port", async () => {
    const requests: { method?: string; authorization?: string; body: Record<string, any> }[] = [];
    const fixture = await serve((req, res) => {
      let text = "";
      req.setEncoding("utf8");
      req.on("data", chunk => { text += chunk; });
      req.on("end", () => {
        const body = text ? JSON.parse(text) as Record<string, any> : {};
        requests.push({ method: req.method, authorization: req.headers.authorization, body });
        if (req.headers.authorization !== "Bearer fixture-token") {
          res.writeHead(401, {
            "content-type": "application/json",
            "www-authenticate": 'Bearer error="invalid_token"',
          });
          res.end(JSON.stringify({ error: "unauthorized" }));
        } else if (req.method === "GET") {
          res.writeHead(405);
          res.end();
        } else if (body.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fixture-session" });
          res.end(JSON.stringify({
            jsonrpc: "2.0", id: body.id,
            result: { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } },
          }));
        } else if (body.method === "notifications/initialized") {
          res.writeHead(202);
          res.end();
        } else if (body.method === "tools/list") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });
    const nativeRequest = http.request;
    const requestsByNode = vi.spyOn(http, "request").mockImplementation(((url: URL, options: http.RequestOptions, callback: (res: http.IncomingMessage) => void) => {
      const logicalUrl = new URL(url);
      expect(logicalUrl.port).toBe("6000");
      return nativeRequest(`${fixture.url}${logicalUrl.pathname}${logicalUrl.search}`, options, callback);
    }) as typeof http.request);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("global Fetch must not be used"));

    const url = new URL("http://127.0.0.1:6000/mcp");
    const client = new Client({ name: "sdk-http-fixture", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: "Bearer fixture-token" } },
      }));
      expect((await client.listTools()).tools).toEqual([]);
      expect(requests.some(request => request.body.method === "initialize" && request.authorization === "Bearer fixture-token")).toBe(true);
      expect(requests.some(request => request.body.method === "tools/list" && request.authorization === "Bearer fixture-token")).toBe(true);
      expect(client.transport?.sessionId).toBe("fixture-session");
      const denied = await sdkFixtureFetch(url, {
        method: "POST", headers: { authorization: "Bearer stale-token" }, body: "{}",
      });
      expect(denied.status).toBe(401);
      expect(denied.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
      expect(await denied.text()).toContain("unauthorized");
      expect(requests.at(-1)).toMatchObject({ authorization: "Bearer stale-token", body: {} });
      await expect(sdkFixtureFetch("https://127.0.0.1:6000/mcp")).rejects.toThrow("loopback HTTP URLs");
      await expect(sdkFixtureFetch("http://example.test/mcp")).rejects.toThrow("loopback HTTP URLs");
    } finally {
      await client.close();
      await fixture.close();
    }
    expect(requestsByNode).toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("delivers SSE bytes before completion and abort closes the open connection", async () => {
    let clientClosed!: Promise<unknown>;
    let closed = false;
    const fixture = await serve((req, res) => {
      clientClosed = new Promise(resolve => req.socket.once("close", () => { closed = true; resolve(undefined); }));
      res.writeHead(200, { "content-type": "text/event-stream", "x-fixture": "streaming" });
      res.flushHeaders();
      res.write("data: first\n\n");
    });
    const nativeRequest = http.request;
    vi.spyOn(http, "request").mockImplementation(((url: URL, options: http.RequestOptions, callback: (res: http.IncomingMessage) => void) => {
      const logicalUrl = new URL(url);
      expect(logicalUrl.port).toBe("6000");
      return nativeRequest(`${fixture.url}${logicalUrl.pathname}`, options, callback);
    }) as typeof http.request);
    const controller = new AbortController();
    const listenerCountBefore = getEventListeners(controller.signal, "abort").length;

    try {
      const response = await sdkFixtureFetch("http://127.0.0.1:6000/events", { signal: controller.signal });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(response.headers.get("x-fixture")).toBe("streaming");
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("data: first");
      expect(closed).toBe(false);

      controller.abort();
      await expect(reader.read()).rejects.toBeDefined();
      await clientClosed;
      expect(closed).toBe(true);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(listenerCountBefore);
    } finally {
      if (!controller.signal.aborted) controller.abort();
      await fixture.close();
    }
  });
});
