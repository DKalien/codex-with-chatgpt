import http from "node:http";
import { Readable } from "node:stream";
import {
  StreamableHTTPClientTransport as SdkTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Test-only SDK FetchLike subset, not general Fetch: loopback HTTP, string/byte requests, and streaming responses. */
export const sdkFixtureFetch: FetchLike = async (input, init = {}) => {
  const url = input instanceof URL ? input : new URL(input);
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname))
    throw new TypeError("SDK HTTP fixtures only support loopback HTTP URLs");

  const body = init.body;
  if (body != null && typeof body !== "string" && !(body instanceof Uint8Array))
    throw new TypeError("SDK HTTP fixtures only support string or byte request bodies");

  const headers: http.OutgoingHttpHeaders = {};
  new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
  const requestOptions: http.RequestOptions = { method: init.method, headers, agent: false };
  if (init.signal) requestOptions.signal = init.signal;

  return new Promise<Response>((resolve, reject) => {
    const request = http.request(url, requestOptions, response => {
      const responseHeaders = new Headers();
      for (let index = 0; index < response.rawHeaders.length; index += 2)
        responseHeaders.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);

      const status = response.statusCode ?? 500;
      let bodyStream: ReadableStream<Uint8Array> | null = null;
      if ([204, 205, 304].includes(status)) response.resume();
      else bodyStream = Readable.toWeb(response) as ReadableStream<Uint8Array>;
      try {
        resolve(new Response(bodyStream, {
          status,
          statusText: response.statusMessage ?? "",
          headers: responseHeaders,
        }));
      } catch (error) {
        response.destroy(error as Error);
        request.destroy(error as Error);
        reject(error);
      }
    });
    request.once("error", reject);
    if (body == null) request.end();
    else request.end(body as string | Uint8Array);
  });
};

/** SDK fixture transport: avoids Fetch's forbidden-port list while retaining real loopback HTTP streaming. */
export class StreamableHTTPClientTransport extends SdkTransport {
  constructor(url: URL, options: StreamableHTTPClientTransportOptions = {}) {
    super(url, { ...options, fetch: sdkFixtureFetch });
  }
}
