import http from "node:http";

// Control JSON only, never streaming MCP. Bound memory even for a faulty local peer.
export const LOOPBACK_RESPONSE_LIMIT = 1024 * 1024;

export interface LoopbackResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Literal loopback only: no Fetch forbidden ports, proxy, redirect following or retry. */
export function requestLoopback(options: {
  port: number;
  path: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
}): Promise<LoopbackResponse> {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)
    return Promise.reject(new Error("Invalid loopback port"));
  if (!options.path.startsWith("/") || options.path.startsWith("//") || /[\s\\#]/.test(options.path))
    return Promise.reject(new Error("Invalid loopback path"));
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647)
    return Promise.reject(new Error("Invalid loopback timeout"));

  return new Promise((resolve, reject) => {
    let request: http.ClientRequest | undefined;
    let response: http.IncomingMessage | undefined;
    let settled = false;
    const finish = (error?: Error, result?: LoopbackResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // agent:false plus explicit destruction bounds both successful and failed sockets.
      response?.destroy();
      request?.destroy();
      if (error) reject(error);
      else resolve(result!);
    };
    // A total deadline covers connect, headers and body (not an idle socket timeout).
    const timer = setTimeout(() => finish(new Error("Loopback HTTP response timeout")), options.timeoutMs);
    try {
      request = http.request({
        hostname: "127.0.0.1", port: options.port, path: options.path,
        method: options.method ?? "GET", headers: options.headers, agent: false,
      }, res => {
        response = res;
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > LOOPBACK_RESPONSE_LIMIT) {
            finish(new Error("Loopback HTTP response too large"));
          } else chunks.push(chunk);
        });
        res.once("error", () => finish(new Error("Loopback HTTP response failed")));
        res.once("aborted", () => finish(new Error("Loopback HTTP response incomplete")));
        res.once("end", () => {
          if (!res.complete) return finish(new Error("Loopback HTTP response incomplete"));
          finish(undefined, { status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
        });
      });
      request.once("error", () => finish(new Error("Loopback HTTP request failed")));
      request.once("close", () => {
        if (!settled) finish(new Error("Loopback HTTP response incomplete"));
      });
      request.end(options.body);
    } catch {
      // Do not include raw request options, headers or native error messages.
      finish(new Error("Loopback HTTP request failed"));
    }
  });
}
