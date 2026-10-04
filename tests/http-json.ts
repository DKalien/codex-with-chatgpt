import http from "node:http";

/** Buffered HTTP fixture client. No Fetch port filtering or automatic redirects; not an SSE/SDK transport. */
export function requestHttp(url: string | URL, init: {
  method?: string; headers?: Record<string, string>; body?: string | URLSearchParams;
  redirect?: "manual"; timeoutMs?: number;
} = {}) {
  return new Promise<Response>((resolve, reject) => {
    const req = http.request(url, { method: init.method, headers: init.headers, agent: false }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { text += chunk; });
      res.once("error", reject);
      res.once("end", () => {
        try {
          const headers = new Headers();
          for (let index = 0; index < res.rawHeaders.length; index += 2)
            headers.append(res.rawHeaders[index]!, res.rawHeaders[index + 1]!);
          resolve(new Response(text || null, { status: res.statusCode!, headers }));
        }
        catch (error) { reject(error); }
      });
    });
    req.once("error", reject);
    // A total deadline also bounds a peer that connects or drips bytes without completing.
    const timer = setTimeout(() => req.destroy(new Error("test HTTP response timeout")), init.timeoutMs ?? 10_000);
    req.once("close", () => clearTimeout(timer));
    req.end(init.body?.toString());
  });
}

/** JSON callers remain strict: an empty, HTML or malformed body must reject. */
export async function requestJson(url: string | URL, init?: Parameters<typeof requestHttp>[1]) {
  const response = await requestHttp(url, init);
  return { status: response.status, body: await response.json() as any };
}
