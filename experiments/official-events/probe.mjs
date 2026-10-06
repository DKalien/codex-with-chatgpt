import { lookup } from "node:dns/promises";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Agent as HttpAgent, createServer, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { pathToFileURL } from "node:url";
import path from "node:path";

const LEGACY_VERSION = "2025-11-25";
const EVENTS_VERSION = "2026-07-28";
const DEFAULT_PORT = 43871;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_CALLBACK_BYTES = 8 * 1024;
const CALLBACK_TIMEOUT_MS = 5_000;
const SUBSCRIPTION_TTL_MS = 5 * 60_000;
const DOH_HOST = "cloudflare-dns.com";
const DOH_BOOTSTRAP_IP = "1.1.1.1";
const MAX_DOH_ANSWERS = 32;
const EVENT_NAME = "probe.completed";
const RESULT_TEXT = "The official MCP Events probe completed.";
const RESULT_ID_SCHEMA = Object.freeze({
  type: "string",
  minLength: 36,
  maxLength: 36,
  description: "Opaque result identifier returned by /status for this probe run.",
});
const RPC_METHODS = new Set(["initialize", "server/discover", "events/list", "events/subscribe", "events/unsubscribe", "tools/list", "tools/call"]);
const RPC_FAULT_REASONS = new Set([
  "rpc_invalid_meta",
  "subscribe_invalid_params", "subscribe_invalid_url", "subscribe_invalid_secret", "subscription_inactive",
  "invalid_url", "address_invalid", "ipv6_unsupported", "payload_too_large", "subscription_expired",
  "challenge_failed", "timeout", "doh_failed", "proxy_rejected", "proxy_connect_failed", "tls_failed",
  "callback_transport_failed",
]);
const CALLBACK_PHASES = new Set([
  "dns", "doh_proxy_connect", "doh_tls", "doh_response_headers", "doh_response_body",
  "callback_connect", "callback_proxy_connect", "callback_tls", "callback_response_headers",
  "callback_response_body",
]);
const SUBSCRIBE_KEYS = ["name", "arguments", "delivery", "cursor", "ttlMs"];
const SUBSCRIBE_REQUIRED_KEYS = ["name", "arguments", "delivery", "cursor"];
const SUBSCRIBE_ARGUMENT_KEYS = ["result_id"];
const SUBSCRIBE_DELIVERY_KEYS = ["mode", "url", "secret"];
const UNSUBSCRIBE_KEYS = ["name", "arguments", "delivery"];
const UNSUBSCRIBE_DELIVERY_KEYS = ["url"];
const blockedIPv4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blockedIPv4.addSubnet(network, prefix, "ipv4");
const globalIPv6 = new BlockList();
globalIPv6.addSubnet("2000::", 3, "ipv6");
const blockedIPv6 = new BlockList();
for (const [network, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20], ["5f00::", 16],
]) blockedIPv6.addSubnet(network, prefix, "ipv6");

class RpcFault extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

class CallbackFault extends Error {
  constructor(reason, phase) {
    super(reason);
    this.reason = reason;
    this.phase = CALLBACK_PHASES.has(phase) ? phase : undefined;
  }
}

function safeEqual(left, right) {
  const bytes = value => Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  const a = createHash("sha256").update(bytes(left)).digest();
  const b = createHash("sha256").update(bytes(right)).digest();
  return timingSafeEqual(a, b);
}

function validateToken(token) {
  if (typeof token !== "string" || token.length < 32 || /[\s\u0000-\u001f]/u.test(token)) {
    throw new Error("C2C_EVENTS_TOKEN must have at least 32 non-space characters");
  }
}

function decodeSecret(secret) {
  if (typeof secret !== "string" || !secret.startsWith("whsec_")) throw new RpcFault(-32602, "Invalid params");
  const encoded = secret.slice(6);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new RpcFault(-32602, "Invalid params");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < 24 || bytes.length > 64 || bytes.toString("base64") !== encoded) {
    throw new RpcFault(-32602, "Invalid params");
  }
  return bytes;
}

function isPublicAddress(address, family = isIP(address)) {
  if (isIP(address) !== family) return false;
  if (family === 4) return !blockedIPv4.check(address, "ipv4");
  return family === 6 && globalIPv6.check(address, "ipv6") && !blockedIPv6.check(address, "ipv6");
}

function subscriptionId(token, identity) {
  return "sub_" + createHmac("sha256", token).update(identity).digest("hex").slice(0, 32);
}

function validateCallbackUrl(value) {
  if (typeof value !== "string" || value.length > 2048) throw new CallbackFault("invalid_url");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CallbackFault("invalid_url");
  }
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || url.hash ||
      !host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.endsWith(".internal") || isIP(host) === 6) {
    throw new CallbackFault("invalid_url");
  }
  return url;
}

function validateProxyUrl(value) {
  const match = typeof value === "string" && /^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/u.exec(value);
  const port = match ? Number(match[1]) : 0;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("callbackProxyUrl must be http://127.0.0.1:<port>");
  }
  return { origin: `http://127.0.0.1:${port}`, port };
}

async function resolvePublicTarget(url, resolve) {
  let records;
  try {
    records = await resolve(url.hostname.replace(/^\[|\]$/gu, ""));
  } catch {
    throw new CallbackFault("address_invalid", "dns");
  }
  if (!Array.isArray(records) || records.length === 0) throw new CallbackFault("address_invalid", "dns");
  for (const record of records) {
    if (!record || typeof record.address !== "string" || record.family !== isIP(record.address) ||
        !isPublicAddress(record.address, record.family)) {
      throw new CallbackFault("address_invalid", "dns");
    }
  }
  const ipv4 = records.find(record => record.family === 4);
  if (!ipv4) throw new CallbackFault("ipv6_unsupported", "dns");
  return ipv4.address;
}

function normalizeDnsName(value) {
  if (typeof value !== "string" || value.length > 254 || /[^a-z0-9.-]/iu.test(value)) return null;
  const name = value.toLowerCase().replace(/\.$/u, "");
  if (!name || name.length > 253 || name.split(".").some(label => !label || label.length > 63)) return null;
  return name;
}

function parseDohAnswer(body, expectedHost) {
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > MAX_CALLBACK_BYTES) {
    throw new CallbackFault("address_invalid", "dns");
  }
  let answer;
  try {
    answer = JSON.parse(body);
  } catch {
    throw new CallbackFault("address_invalid", "dns");
  }
  const host = normalizeDnsName(expectedHost);
  const questions = record(answer) ? answer.Question : null;
  const records = record(answer) ? answer.Answer : null;
  if (!host || !record(answer) || answer.Status !== 0 || answer.TC !== false || !Array.isArray(questions) || questions.length !== 1 ||
      normalizeDnsName(questions[0]?.name) !== host || questions[0]?.type !== 1 ||
      !Array.isArray(records) || records.length === 0 || records.length > MAX_DOH_ANSWERS) {
    throw new CallbackFault("address_invalid", "dns");
  }
  const cnames = new Map();
  for (const record of records) {
    if (record?.type !== 5) continue;
    const owner = normalizeDnsName(record.name);
    const target = normalizeDnsName(record.data);
    if (!owner || !target || (cnames.has(owner) && cnames.get(owner) !== target)) {
      throw new CallbackFault("address_invalid", "dns");
    }
    cnames.set(owner, target);
  }
  const reachable = new Set([host]);
  let current = host;
  for (let depth = 0; cnames.has(current) && depth < 8; depth++) {
    current = cnames.get(current);
    if (reachable.has(current)) throw new CallbackFault("address_invalid", "dns");
    reachable.add(current);
  }
  if (cnames.has(current) || [...cnames.keys()].some(owner => !reachable.has(owner))) {
    throw new CallbackFault("address_invalid", "dns");
  }
  const addresses = [];
  for (const record of records) {
    if (record?.type !== 1) continue;
    const owner = normalizeDnsName(record.name);
    const address = record.data;
    if (!owner || owner !== current || typeof address !== "string" || isIP(address) !== 4 || !isPublicAddress(address, 4)) {
      throw new CallbackFault("address_invalid", "dns");
    }
    addresses.push(address);
  }
  if (!addresses.length) throw new CallbackFault("address_invalid", "dns");
  return [...new Set(addresses)];
}

async function resolveThroughDoh(url, post, proxyUrl, signal, onPhase, transport) {
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (!host || isIP(host) || !isPublicAddress(DOH_BOOTSTRAP_IP, 4)) {
    throw new CallbackFault("address_invalid", "dns");
  }
  const dohUrl = new URL("https://cloudflare-dns.com/dns-query");
  dohUrl.searchParams.set("name", host);
  dohUrl.searchParams.set("type", "A");
  onPhase("doh_proxy_connect");
  const response = await post(dohUrl, {
    method: "GET",
    body: "",
    headers: { accept: "application/dns-json" },
    address: DOH_BOOTSTRAP_IP,
    signal,
    proxyUrl: proxyUrl.origin,
    phasePrefix: "doh",
    onPhase,
  }, undefined, transport);
  if (response.statusCode !== 200) throw new CallbackFault("doh_failed", "doh_response_headers");
  onPhase("dns");
  return parseDohAnswer(response.body, host)[0];
}

function readLimited(response, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    response.on("data", chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("callback_response_too_large"));
        response.destroy();
        return;
      }
      chunks.push(chunk);
    });
    response.on("error", reject);
    response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

export function postHttps(url, {
  body = "",
  headers = {},
  address,
  signal = new AbortController().signal,
  method = "POST",
  proxyUrl,
  onSend = () => {},
  onPhase = () => {},
  phasePrefix = "callback",
}, request = httpsRequest, transport = {}) {
  const proxy = proxyUrl ? validateProxyUrl(proxyUrl) : null;
  if (typeof address !== "string" || isIP(address) !== 4 || !isPublicAddress(address, 4)) {
    return Promise.reject(new CallbackFault("address_invalid", "dns"));
  }
  return new Promise((resolve, reject) => {
    let req;
    let response;
    let settled = false;
    let closed = false;
    const resources = new Set();
    const agent = new HttpsAgent({ keepAlive: false, proxyEnv: {} });
    const phase = value => {
      if (CALLBACK_PHASES.has(value)) onPhase(value);
    };
    const destroy = () => {
      if (closed) return;
      closed = true;
      response?.destroy();
      req?.destroy();
      agent.destroy();
      for (const resource of resources) resource?.destroy?.();
      resources.clear();
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => finish(new Error("callback_cancelled"));
    const requestError = (error, phaseName) => {
      if (signal.aborted) return new Error("callback_cancelled");
      if (error instanceof CallbackFault) return error;
      if (phaseName.endsWith("_proxy_connect")) return new CallbackFault("proxy_connect_failed", phaseName);
      if (phaseName.endsWith("_tls")) return new CallbackFault("tls_failed", phaseName);
      return new CallbackFault(phasePrefix === "doh" ? "doh_failed" : "callback_transport_failed", phaseName);
    };
    const currentPhase = { value: `${phasePrefix}_connect` };
    const setPhase = value => {
      currentPhase.value = value;
      phase(value);
    };
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
      let proxyAgent;
      if (proxy) {
        agent.createConnection = (_options, callback) => {
          let done = false;
          const complete = (error, socket) => {
            if (done) {
              socket?.destroy();
              return;
            }
            done = true;
            callback(error, socket);
          };
          if (closed || signal.aborted) {
            complete(new Error("callback_cancelled"));
            return undefined;
          }
          setPhase(`${phasePrefix}_proxy_connect`);
          proxyAgent = new HttpAgent({ keepAlive: false, proxyEnv: {} });
          const connectReq = (transport.connectRequest ?? httpRequest)({
            hostname: "127.0.0.1",
    port: proxy.port,
            method: "CONNECT",
            path: `${address}:443`,
            headers: { host: `${address}:443` },
            agent: proxyAgent,
          });
          resources.add(proxyAgent);
          resources.add(connectReq);
          connectReq.once("connect", (connectResponse, socket, head) => {
            if (closed || signal.aborted) {
              socket.destroy();
              complete(new Error("callback_cancelled"));
              return;
            }
            resources.add(socket);
            if (connectResponse.statusCode !== 200 || (head && head.length)) {
              socket.destroy();
              complete(new CallbackFault("proxy_rejected", `${phasePrefix}_proxy_connect`));
              return;
            }
            setPhase(`${phasePrefix}_tls`);
            let secureSocket;
            try {
              secureSocket = (transport.tlsConnect ?? tlsConnect)({
                socket,
                servername: url.hostname.replace(/^\[|\]$/gu, ""),
                rejectUnauthorized: true,
                ALPNProtocols: ["http/1.1"],
              });
            } catch {
              complete(new CallbackFault("tls_failed", `${phasePrefix}_tls`));
              return;
            }
            resources.add(secureSocket);
            secureSocket.once("secureConnect", () => {
              if (closed || signal.aborted) {
                secureSocket.destroy();
                complete(new Error("callback_cancelled"));
                return;
              }
              onSend();
              setPhase(`${phasePrefix}_response_headers`);
              complete(null, secureSocket);
            });
            secureSocket.once("error", () => complete(signal.aborted || closed
              ? new Error("callback_cancelled")
              : new CallbackFault("tls_failed", `${phasePrefix}_tls`)));
          });
          connectReq.once("response", connectResponse => {
            connectResponse.resume();
            complete(new CallbackFault("proxy_rejected", `${phasePrefix}_proxy_connect`));
          });
          connectReq.once("error", () => complete(signal.aborted || closed
            ? new Error("callback_cancelled")
            : new CallbackFault("proxy_connect_failed", `${phasePrefix}_proxy_connect`)));
          connectReq.end();
          return undefined;
        };
      }
      setPhase(`${phasePrefix}_connect`);
      const servername = url.hostname.replace(/^\[|\]$/gu, "");
      const requestHeaders = { ...headers, host: servername };
      req = (transport.httpsRequest ?? request)({
        protocol: "https:",
        hostname: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method,
        headers: requestHeaders,
        servername,
        agent,
        rejectUnauthorized: true,
        ...(proxy ? {} : {
          lookup: (_hostname, options, callback) => {
            if (options && options.all) callback(null, [{ address, family: 4 }]);
            else callback(null, address, 4);
          },
        }),
      }, incoming => {
        response = incoming;
        setPhase(`${phasePrefix}_response_body`);
        readLimited(incoming, MAX_CALLBACK_BYTES).then(
          responseBody => finish(null, { statusCode: incoming.statusCode ?? 0, body: responseBody }),
          error => finish(requestError(error, currentPhase.value)),
        );
      });
      req.once("error", error => finish(requestError(error, currentPhase.value)));
      req.once("socket", socket => {
        if (proxy) return;
        setPhase(`${phasePrefix}_tls`);
        const ready = () => {
          if (signal.aborted || settled) return;
          onSend();
          setPhase(`${phasePrefix}_response_headers`);
        };
        if (socket.authorized && !socket.connecting && !socket.secureConnecting) ready();
        else socket.once("secureConnect", ready);
      });
      req.end(body);
    } catch (error) {
      finish(requestError(error, currentPhase.value));
    }
  });
}

function signHeaders(id, secret, body, subscriptionId, now) {
  const timestamp = String(Math.floor(now / 1000));
  const digest = createHmac("sha256", secret).update(id + "." + timestamp + "." + body).digest("base64");
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": "v1," + digest,
    "X-MCP-Subscription-Id": subscriptionId,
  };
}

function timeoutError(phase) {
  const error = new Error("callback_timeout");
  error.code = "CALLBACK_TIMEOUT";
  error.phase = CALLBACK_PHASES.has(phase) ? phase : undefined;
  return error;
}

function boundedOperation(operation, timeoutMs, parentSignal, currentPhase) {
  const controller = new AbortController();
  let timer;
  let onAbort;
  const races = [operation(controller.signal)];
  races.push(new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError(currentPhase?.()));
    }, timeoutMs);
  }));
  if (parentSignal) {
    races.push(new Promise((_, reject) => {
      onAbort = () => {
        controller.abort();
        reject(new Error("callback_cancelled"));
      };
      if (parentSignal.aborted) onAbort();
      else parentSignal.addEventListener("abort", onAbort, { once: true });
    }));
  }
  return Promise.race(races).finally(() => {
    clearTimeout(timer);
    if (parentSignal && onAbort) parentSignal.removeEventListener("abort", onAbort);
  });
}

function readBody(req, limit, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    let size = 0;
    const chunks = [];
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAbort);
      if (error) req.resume();
      if (error) reject(error);
      else resolve(value);
    };
    const onData = chunk => {
      size += chunk.length;
      if (size > limit) finish(Object.assign(new Error("request_too_large"), { statusCode: 413 }));
      else chunks.push(chunk);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks).toString("utf8"));
    const onError = () => finish(Object.assign(new Error("request_failed"), { statusCode: 400 }));
    const onAbort = () => finish(Object.assign(new Error("request_aborted"), { statusCode: 400 }));
    const timer = setTimeout(() => finish(Object.assign(new Error("request_timeout"), { statusCode: 408 })), timeoutMs);
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAbort);
  });
}

function jsonResponse(res, statusCode, value) {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end('{"error":"response_too_large"}');
    return;
  }
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body, "utf8"),
    "cache-control": "no-store",
  });
  res.end(body);
}

function logFact(logger, fact) {
  try {
    logger(Object.freeze(fact));
  } catch {
    // Diagnostic logging must not alter the probe protocol.
  }
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function fieldType(value, key) {
  return record(value) && Object.hasOwn(value, key) ? valueType(value[key]) : "missing";
}

function unknownCount(value, known) {
  return record(value) ? Object.keys(value).filter(key => !known.includes(key)).length : 0;
}

function subscribeShape(params) {
  return {
    fields: {
      params: valueType(params),
      name: fieldType(params, "name"),
      arguments: fieldType(params, "arguments"),
      "arguments.result_id": fieldType(params?.arguments, "result_id"),
      delivery: fieldType(params, "delivery"),
      "delivery.mode": fieldType(params?.delivery, "mode"),
      "delivery.url": fieldType(params?.delivery, "url"),
      "delivery.secret": fieldType(params?.delivery, "secret"),
      cursor: fieldType(params, "cursor"),
      ttlMs: fieldType(params, "ttlMs"),
    },
    unknownFieldCount: Math.min(999,
      unknownCount(params, SUBSCRIBE_KEYS) + unknownCount(params?.arguments, SUBSCRIBE_ARGUMENT_KEYS) +
      unknownCount(params?.delivery, SUBSCRIBE_DELIVERY_KEYS)),
  };
}

function rpcParamsShape(method, params) {
  const subscribe = method === "events/subscribe";
  const knownTop = subscribe ? [...SUBSCRIBE_KEYS, "_meta"] : [...UNSUBSCRIBE_KEYS, "_meta"];
  const knownDelivery = subscribe ? SUBSCRIBE_DELIVERY_KEYS : UNSUBSCRIBE_DELIVERY_KEYS;
  return {
    metaPresent: record(params) && Object.hasOwn(params, "_meta"),
    metaType: fieldType(params, "_meta"),
    fields: {
      params: valueType(params),
      name: fieldType(params, "name"),
      arguments: fieldType(params, "arguments"),
      "arguments.result_id": fieldType(params?.arguments, "result_id"),
      delivery: fieldType(params, "delivery"),
      "delivery.mode": fieldType(params?.delivery, "mode"),
      "delivery.url": fieldType(params?.delivery, "url"),
      "delivery.secret": fieldType(params?.delivery, "secret"),
      cursor: fieldType(params, "cursor"),
      ttlMs: fieldType(params, "ttlMs"),
    },
    unknownFieldCounts: {
      top: Math.min(999, unknownCount(params, knownTop)),
      arguments: Math.min(999, unknownCount(params?.arguments, SUBSCRIBE_ARGUMENT_KEYS)),
      delivery: Math.min(999, unknownCount(params?.delivery, knownDelivery)),
    },
  };
}

function stripRequestMeta(params) {
  if (!record(params) || !Object.hasOwn(params, "_meta")) return params;
  const meta = params._meta;
  if (!record(meta) || (Object.hasOwn(meta, "progressToken") &&
      typeof meta.progressToken !== "string" && !Number.isInteger(meta.progressToken))) {
    throw new RpcFault(-32602, "Invalid params", { reason: "rpc_invalid_meta" });
  }
  const { _meta, ...businessParams } = params;
  return businessParams;
}

function invalidSubscribe(params, reason) {
  return new RpcFault(-32602, "Invalid params", { reason, ...subscribeShape(params) });
}

function rpcFaultReason(fault) {
  const reason = fault.data?.reason;
  if (typeof reason === "string" && RPC_FAULT_REASONS.has(reason)) return reason;
  if (fault.code === -32602) return "rpc_invalid_params";
  if (fault.code === -32603) return "rpc_internal_error";
  if (fault.code === -32015) return "rpc_callback_error";
  return "rpc_error";
}

function parseSubscribe(params, resultId, maxTtlMs) {
  const hasTtl = record(params) && Object.hasOwn(params, "ttlMs");
  if (!record(params) || Object.keys(params).some(key => !SUBSCRIBE_KEYS.includes(key)) ||
      !SUBSCRIBE_REQUIRED_KEYS.every(key => Object.hasOwn(params, key)) ||
      params.name !== EVENT_NAME ||
      !exactKeys(params.arguments, ["result_id"]) || params.arguments.result_id !== resultId || params.cursor !== null ||
      !exactKeys(params.delivery, ["mode", "url", "secret"]) || params.delivery.mode !== "webhook" ||
      (hasTtl && params.ttlMs !== null && (!Number.isSafeInteger(params.ttlMs) || params.ttlMs <= 0))) {
    throw invalidSubscribe(params, "subscribe_invalid_params");
  }
  let url;
  try {
    url = validateCallbackUrl(params.delivery.url);
  } catch {
    throw invalidSubscribe(params, "subscribe_invalid_url");
  }
  let secret;
  try {
    secret = decodeSecret(params.delivery.secret);
  } catch {
    throw invalidSubscribe(params, "subscribe_invalid_secret");
  }
  const requestedTtlMs = hasTtl && params.ttlMs !== null ? params.ttlMs : null;
  return {
    identity: JSON.stringify({ name: params.name, arguments: { result_id: resultId }, url: url.href }),
    url,
    host: url.hostname,
    secret,
    ttlMs: requestedTtlMs === null ? maxTtlMs : Math.min(requestedTtlMs, maxTtlMs),
  };
}

function parseUnsubscribe(params, resultId) {
  if (!exactKeys(params, ["name", "arguments", "delivery"]) || params.name !== EVENT_NAME ||
      !exactKeys(params.arguments, ["result_id"]) || params.arguments.result_id !== resultId ||
      !params.delivery || typeof params.delivery !== "object" || typeof params.delivery.url !== "string") {
    throw new RpcFault(-32602, "Invalid params");
  }
  let url;
  try {
    url = validateCallbackUrl(params.delivery.url);
  } catch {
    throw new RpcFault(-32602, "Invalid params");
  }
  return JSON.stringify({ name: params.name, arguments: { result_id: resultId }, url: url.href });
}

function asCallbackRpcFault(error) {
  const reason = error instanceof CallbackFault ? error.reason
    : error && error.code === "CALLBACK_TIMEOUT" ? "timeout"
      : error && error.message === "callback_cancelled" ? "challenge_failed"
        : "challenge_failed";
  const phase = CALLBACK_PHASES.has(error?.phase) ? error.phase : undefined;
  return new RpcFault(-32015, "CallbackEndpointError", { reason, ...(phase ? { phase } : {}) });
}

export function createProbe({
  token,
  port = DEFAULT_PORT,
  resolve = host => lookup(host, { all: true, verbatim: true }),
  post = postHttps,
  postTransport = {},
  callbackProxyUrl,
  now = Date.now,
  callbackTimeoutMs = CALLBACK_TIMEOUT_MS,
  subscriptionTtlMs = SUBSCRIPTION_TTL_MS,
  logger = fact => process.stdout.write(JSON.stringify(fact) + "\n"),
} = {}) {
  validateToken(token);
  const callbackProxy = callbackProxyUrl === undefined ? null : validateProxyUrl(callbackProxyUrl);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port must be between 0 and 65535");
  if (!Number.isInteger(callbackTimeoutMs) || callbackTimeoutMs < 1 || callbackTimeoutMs > 30_000) {
    throw new Error("callbackTimeoutMs must be between 1 and 30000");
  }
  if (!Number.isInteger(subscriptionTtlMs) || subscriptionTtlMs < 1000 || subscriptionTtlMs > SUBSCRIPTION_TTL_MS) {
    throw new Error("subscriptionTtlMs must be between 1000 and 300000");
  }

  const state = {
    resultId: randomUUID(),
    result: null,
    subscription: null,
    eventAttempt: "none",
    eventHttpStatus: null,
    eventReason: null,
    eventPhase: null,
    eventId: null,
  };

  function expireSubscription(sub) {
    if (!sub || (sub.phase !== "active" && sub.phase !== "verifying") || now() < sub.expiresAt) return;
    sub.phase = "expired";
    sub.active = false;
    clearTimeout(sub.expirationTimer);
    sub.expirationTimer = null;
    sub.controller.abort();
    if (sub.eventController) sub.eventController.abort();
    logFact(logger, { type: "subscription", subscriptionId: sub.id, host: sub.host, state: "expired" });
  }

  function scheduleExpiration(sub) {
    clearTimeout(sub.expirationTimer);
    sub.expirationTimer = setTimeout(() => {
      sub.expirationTimer = null;
      if (now() < sub.expiresAt) scheduleExpiration(sub);
      else expireSubscription(sub);
    }, Math.max(0, sub.expiresAt - now()));
    sub.expirationTimer.unref?.();
  }

  function status() {
    const sub = state.subscription;
    expireSubscription(sub);
    return {
      result_id: state.resultId,
      result: state.result ? "completed" : "pending",
      subscription: sub ? sub.phase : "none",
      refreshBefore: sub ? new Date(sub.expiresAt).toISOString() : null,
      callbackHost: sub && sub.phase !== "verifying" ? sub.host : null,
      eventAttempt: state.eventAttempt,
      eventHttpStatus: state.eventHttpStatus,
      eventReason: state.eventReason,
      eventPhase: state.eventPhase,
      eventId: state.eventId,
    };
  }

  async function postCallback(record, payload, webhookId, controller, onSend) {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body, "utf8") > MAX_CALLBACK_BYTES) throw new CallbackFault("payload_too_large");
    let phase = "dns";
    const setPhase = value => {
      if (CALLBACK_PHASES.has(value)) phase = value;
    };
    return boundedOperation(async signal => {
      const url = validateCallbackUrl(record.url.href);
      const address = callbackProxy
        ? await resolveThroughDoh(url, post, callbackProxy, signal, setPhase, postTransport)
        : await resolvePublicTarget(url, resolve);
      expireSubscription(record);
      if (now() >= record.expiresAt) throw new CallbackFault("subscription_expired");
      if (signal.aborted) throw new Error("callback_cancelled");
      if (controller.signal.aborted) throw new Error("callback_cancelled");
      const headers = signHeaders(webhookId, record.secret, body, record.id, now());
      setPhase(callbackProxy ? "callback_proxy_connect" : "callback_connect");
      return post(url, {
        body,
        headers,
        address,
        signal,
        proxyUrl: callbackProxy?.origin,
        phasePrefix: "callback",
        onSend,
        onPhase: setPhase,
      }, undefined, postTransport);
    }, callbackTimeoutMs, controller.signal, () => phase);
  }

  function subscriptionResult(record) {
    return {
      id: record.id,
      refreshBefore: new Date(record.expiresAt).toISOString(),
      cursor: null,
      truncated: false,
    };
  }

  async function sendEventOnce(record) {
    expireSubscription(record);
    if (!state.result || state.eventAttempt !== "none" || !record.active || now() >= record.expiresAt) return;
    state.eventAttempt = "attempting";
    state.eventId = "evt_" + randomUUID();
    const event = {
      eventId: state.eventId,
      name: EVENT_NAME,
      timestamp: new Date(now()).toISOString(),
      data: { result_id: state.resultId },
      cursor: null,
    };
    const controller = new AbortController();
    record.eventController = controller;
    let sent = false;
    try {
      const response = await postCallback(record, event, event.eventId, controller, () => {
        sent = true;
      });
      state.eventHttpStatus = Number.isInteger(response.statusCode) ? response.statusCode : null;
      state.eventAttempt = response.statusCode >= 200 && response.statusCode < 300 ? "accepted" : "rejected";
      state.eventReason = state.eventAttempt === "rejected" ? "http_status" : null;
      state.eventPhase = null;
    } catch (error) {
      const cancelled = error && error.message === "callback_cancelled";
      state.eventAttempt = sent ? "unknown" : cancelled ? "cancelled" : "not_sent";
      state.eventReason = error instanceof CallbackFault ? error.reason
        : error && error.code === "CALLBACK_TIMEOUT" ? "timeout"
          : cancelled ? "cancelled" : "transport_error";
      state.eventPhase = CALLBACK_PHASES.has(error?.phase) ? error.phase : null;
      state.eventHttpStatus = null;
    } finally {
      logFact(logger, {
        type: "event_attempt",
        eventId: state.eventId,
        subscriptionId: record.id,
        host: record.host,
        outcome: state.eventAttempt,
        reason: state.eventReason,
        phase: state.eventPhase,
        httpStatus: state.eventHttpStatus,
      });
    }
  }

  async function subscribe(params) {
    const parsed = parseSubscribe(params, state.resultId, subscriptionTtlMs);
    let previous = state.subscription;
    if (previous) {
      expireSubscription(previous);
      if (previous.identity !== parsed.identity || !safeEqual(previous.secret, parsed.secret)) {
        throw new RpcFault(-32602, "Invalid params");
      }
      if (previous.phase === "verifying" && previous.promise) return previous.promise;
      if (previous.phase === "active" && now() < previous.expiresAt) {
        previous.expiresAt = Math.min(previous.expiresAt, now() + parsed.ttlMs);
        scheduleExpiration(previous);
        return subscriptionResult(previous);
      }
      if (previous.phase !== "failed") throw new RpcFault(-32015, "CallbackEndpointError", { reason: "subscription_inactive" });
      state.subscription = null;
    }

    const record = {
      id: subscriptionId(token, parsed.identity),
      identity: parsed.identity,
      url: parsed.url,
      host: parsed.host,
      secret: parsed.secret,
      expiresAt: now() + parsed.ttlMs,
      phase: "verifying",
      active: false,
      controller: new AbortController(),
      eventController: null,
      expirationTimer: null,
      promise: null,
    };
    state.subscription = record;
    scheduleExpiration(record);
    record.promise = (async () => {
      try {
        const challenge = randomBytes(32).toString("base64url");
        const challengeId = "msg_verification_" + randomUUID();
        const response = await postCallback(record, { type: "verification", challenge }, challengeId, record.controller, () => {});
        if (response.statusCode < 200 || response.statusCode >= 300) throw new CallbackFault("challenge_failed");
        let echoed;
        try {
          const parsedBody = JSON.parse(response.body);
          echoed = parsedBody && parsedBody.challenge;
        } catch {
          throw new CallbackFault("challenge_failed");
        }
        if (typeof echoed !== "string" || !safeEqual(challenge, echoed)) throw new CallbackFault("challenge_failed");
        if (record.controller.signal.aborted || now() >= record.expiresAt || state.subscription !== record) {
          throw new CallbackFault("challenge_failed");
        }
        record.phase = "active";
        record.active = true;
        logFact(logger, { type: "subscription", subscriptionId: record.id, host: record.host, state: "active" });
        if (state.result) await sendEventOnce(record);
        return subscriptionResult(record);
      } catch (error) {
        if (record.phase !== "unsubscribed") {
          record.phase = now() >= record.expiresAt ? "expired" : "failed";
          record.active = false;
        }
        clearTimeout(record.expirationTimer);
        record.expirationTimer = null;
        logFact(logger, { type: "subscription", subscriptionId: record.id, state: record.phase });
        throw asCallbackRpcFault(error);
      }
    })();
    return record.promise;
  }

  function unsubscribe(params) {
    const identity = parseUnsubscribe(params, state.resultId);
    const record = state.subscription;
    if (!record) return {};
    if (record.identity !== identity) throw new RpcFault(-32602, "Invalid params");
    if (record.phase === "unsubscribed") return {};
    record.active = false;
    record.phase = "unsubscribed";
    clearTimeout(record.expirationTimer);
    record.expirationTimer = null;
    record.controller.abort();
    if (record.eventController) record.eventController.abort();
    logFact(logger, { type: "subscription", subscriptionId: record.id, host: record.host, state: "unsubscribed" });
    return {};
  }

  function readResult(args) {
    if (!exactKeys(args, ["result_id"]) || args.result_id !== state.resultId) {
      throw new RpcFault(-32602, "Invalid params");
    }
    logFact(logger, {
      type: "tool_read",
      tool: "read_result",
      resultId: state.resultId,
      resultStatus: state.result ? "completed" : "pending",
      eventAttempt: state.eventAttempt,
    });
    return state.result
      ? { result_id: state.resultId, result: RESULT_TEXT, proof: state.result.proof }
      : { result_id: state.resultId, status: "pending" };
  }

  async function rpcMethod(method, params) {
    if (method === "server/discover") {
      return {
        resultType: "complete",
        supportedVersions: [EVENTS_VERSION],
        capabilities: { tools: {}, events: {} },
      };
    }
    if (method === "events/list") {
      return {
        events: [{
          name: EVENT_NAME,
          description: "A single local probe result became available.",
          delivery: ["webhook"],
          inputSchema: {
            type: "object",
            properties: { result_id: RESULT_ID_SCHEMA },
            required: ["result_id"],
            additionalProperties: false,
          },
          payloadSchema: {
            type: "object",
            properties: { result_id: RESULT_ID_SCHEMA },
            required: ["result_id"],
            additionalProperties: false,
          },
        }],
      };
    }
    if (method === "events/subscribe") return subscribe(params);
    if (method === "events/unsubscribe") return unsubscribe(params);
    if (method === "tools/list") {
      return {
        tools: [{
          name: "read_result",
          description: "Read the fixed result and proof for this one local probe.",
          annotations: {
            readOnlyHint: true,
            idempotentHint: true,
            destructiveHint: false,
            openWorldHint: false,
          },
          inputSchema: {
            type: "object",
            properties: { result_id: RESULT_ID_SCHEMA },
            required: ["result_id"],
            additionalProperties: false,
          },
        }],
      };
    }
    if (method === "tools/call") {
      if (!params || params.name !== "read_result") throw new RpcFault(-32602, "Invalid params");
      const result = readResult(params.arguments);
      // Basic tools/call envelope is a deliberately narrow slice pending real client wire verification.
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    }
    if (method === "initialize") {
      // Legacy MCP handshake for basic tools compatibility; this does not claim MCP 2 support.
      return {
        protocolVersion: LEGACY_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "official-events-probe", version: "0.0.0-experiment" },
      };
    }
    throw new RpcFault(-32601, "Method not found");
  }

  async function handleRpc(req, res) {
    let request;
    try {
      const body = await readBody(req, MAX_REQUEST_BYTES, 5_000);
      request = JSON.parse(body);
    } catch (error) {
      const statusCode = error && error.statusCode ? error.statusCode : 200;
      jsonResponse(res, statusCode, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }
    if (!request || Array.isArray(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      jsonResponse(res, 200, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      return;
    }
    const method = RPC_METHODS.has(request.method) ? request.method : "unknown";
    const params = Object.hasOwn(request, "params") ? request.params : {};
    const hasEventParams = request.method === "events/subscribe" || request.method === "events/unsubscribe";
    const paramsShape = hasEventParams ? rpcParamsShape(request.method, params) : null;
    logFact(logger, { type: "rpc", method, ...(paramsShape || {}) });
    if (!Object.hasOwn(request, "id")) {
      res.writeHead(202, { "content-length": 0, "cache-control": "no-store" });
      res.end();
      return;
    }
    if (!(typeof request.id === "string" || (typeof request.id === "number" && Number.isSafeInteger(request.id)))) {
      jsonResponse(res, 200, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      return;
    }
    try {
      const result = await rpcMethod(request.method, stripRequestMeta(params));
      jsonResponse(res, 200, { jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      const fault = error instanceof RpcFault ? error : new RpcFault(-32603, "Internal error");
      if (hasEventParams) {
        logFact(logger, {
          type: "rpc_fault",
          method: request.method,
          code: fault.code,
          reason: rpcFaultReason(fault),
          ...(CALLBACK_PHASES.has(fault.data?.phase) ? { phase: fault.data.phase } : {}),
          ...paramsShape,
        });
      }
      const rpcError = { code: fault.code, message: fault.message };
      if (fault.data) rpcError.data = fault.data;
      jsonResponse(res, 200, { jsonrpc: "2.0", id: request.id, error: rpcError });
    }
  }

  async function complete() {
    if (!state.result) state.result = { proof: randomBytes(24).toString("base64url") };
    if (state.subscription && state.subscription.phase === "verifying" && state.subscription.promise) {
      try {
        await state.subscription.promise;
      } catch {
        // A failed challenge never activates delivery.
      }
    }
    if (state.subscription && state.subscription.phase === "active") await sendEventOnce(state.subscription);
    return status();
  }

  const server = createServer(async (req, res) => {
    if (req.headers.origin !== undefined) {
      jsonResponse(res, 403, { error: "origin_forbidden" });
      return;
    }
    const authorization = req.headers.authorization;
    const candidate = typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    if (!safeEqual(candidate, token)) {
      jsonResponse(res, 401, { error: "unauthorized" });
      return;
    }
    try {
      if (req.url === "/status" && req.method === "GET") {
        await readBody(req, 0, 1_000);
        logFact(logger, { type: "http", method: "GET /status" });
        jsonResponse(res, 200, status());
        return;
      }
      if (req.url === "/complete" && req.method === "POST") {
        const body = await readBody(req, 0, 5_000);
        if (body.length !== 0) {
          jsonResponse(res, 400, { error: "empty_body_required" });
          return;
        }
        logFact(logger, { type: "http", method: "POST /complete" });
        jsonResponse(res, 200, await complete());
        return;
      }
      if (req.url === "/mcp" && req.method === "POST") {
        const contentType = req.headers["content-type"] || "";
        if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
          jsonResponse(res, 415, { error: "application_json_required" });
          return;
        }
        await handleRpc(req, res);
        return;
      }
      jsonResponse(res, 404, { error: "not_found" });
    } catch (error) {
      if (!res.headersSent) {
        const statusCode = error && error.statusCode ? error.statusCode : 400;
        jsonResponse(res, statusCode, { error: statusCode === 413 ? "request_too_large" : "request_failed" });
      }
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  let closePromise = null;

  return {
    resultId: state.resultId,
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve(server.address());
        });
      });
    },
    close() {
      if (closePromise) return closePromise;
      const sub = state.subscription;
      if (sub) {
        sub.active = false;
        if (sub.phase === "active" || sub.phase === "verifying") sub.phase = "unsubscribed";
        clearTimeout(sub.expirationTimer);
        sub.expirationTimer = null;
        sub.controller.abort();
        if (sub.eventController) sub.eventController.abort();
      }
      closePromise = new Promise((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close(error => error ? reject(error) : resolve());
        server.closeIdleConnections();
        server.closeAllConnections();
      });
      return closePromise;
    },
    status,
    complete,
  };
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("C2C_EVENTS_PORT must be an integer from 1024 to 65535");
  }
  return port;
}

async function main() {
  const args = process.argv.slice(2);
  let callbackProxyUrl;
  if (args.length) {
    if (args.length !== 2 || args[0] !== "--callback-proxy") throw new Error("Use --callback-proxy http://127.0.0.1:<port>");
    callbackProxyUrl = validateProxyUrl(args[1]).origin;
  }
  const probe = createProbe({
    token: process.env.C2C_EVENTS_TOKEN,
    port: parsePort(process.env.C2C_EVENTS_PORT ?? String(DEFAULT_PORT)),
    callbackProxyUrl,
  });
  const address = await probe.listen();
  process.stdout.write(JSON.stringify({
    type: "probe_listening",
    address: "127.0.0.1",
    port: address.port,
    result_id: probe.resultId,
    persistence: "memory_only",
  }) + "\n");
  const stop = () => probe.close().finally(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write("official MCP Events probe failed to start\n");
    process.exitCode = 1;
  });
}

// Memory-only session experiment: it deliberately cannot establish cross-restart reliability.
