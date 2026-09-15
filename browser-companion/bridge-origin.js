/**
 * Bridge origin parser (browser-safe).
 * Production: HTTPS origin only. Dev: loopback HTTP only.
 */

export class BridgeOriginError extends Error {
  constructor(message) {
    super(message);
    this.name = "BridgeOriginError";
    this.code = "BRIDGE_ORIGIN_INVALID";
  }
}

/**
 * @param {string} raw
 * @param {{ allowLoopbackHttp?: boolean }} [opts]
 * @returns {string} canonical origin https://host[:port] or http://127.0.0.1:port
 */
export function parseBridgeOrigin(raw, opts = {}) {
  if (typeof raw !== "string" || !raw || raw.length > 512) {
    throw new BridgeOriginError("Bridge origin 无效");
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new BridgeOriginError("Bridge origin 无效");
  }
  if (url.username || url.password) {
    throw new BridgeOriginError("Bridge origin 不得包含凭据");
  }
  if (url.search || url.hash) {
    throw new BridgeOriginError("Bridge origin 不得包含 query/hash");
  }
  if (url.pathname && url.pathname !== "/") {
    throw new BridgeOriginError("Bridge origin 仅允许 origin，不得包含 path");
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol === "https:") {
    return url.port
      ? `https://${host}:${url.port}`
      : `https://${host}`;
  }
  if (url.protocol === "http:") {
    const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
    if (!loopback || !opts.allowLoopbackHttp) {
      throw new BridgeOriginError("仅允许 HTTPS Bridge origin（开发可显式允许 loopback HTTP）");
    }
    return url.port
      ? `http://${host}:${url.port}`
      : `http://${host}`;
  }
  throw new BridgeOriginError("Bridge origin 协议无效");
}

/** Append companion API path; origin must already be validated. */
export function companionApiUrl(origin, path) {
  const base = parseBridgeOrigin(origin, { allowLoopbackHttp: origin.startsWith("http://") });
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}
