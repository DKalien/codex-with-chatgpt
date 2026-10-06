import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createProbe, postHttps } from "./probe.mjs";

const TOKEN = randomBytes(32).toString("hex");
const SECRET_BYTES = randomBytes(32);
const SECRET = "whsec_" + SECRET_BYTES.toString("base64");
const PUBLIC_V4 = "8.8.8.8";
const CALLBACK_PROXY = "http://127.0.0.1:7897";
const CALLBACK_PIN = "104.18.38.184";
let rpcId = 0;

function echoPost(calls = []) {
  return async (url, request) => {
    request.onSend?.();
    const payload = JSON.parse(request.body);
    calls.push({ url: url.href, address: request.address, headers: request.headers, body: request.body, payload });
    return {
      statusCode: payload.type === "verification" ? 200 : 202,
      body: payload.type === "verification" ? JSON.stringify({ challenge: payload.challenge }) : "",
    };
  };
}

function dohBody(host, addresses = [CALLBACK_PIN, "172.64.149.72"]) {
  const owner = "edge.receiver.example.";
  return JSON.stringify({
    Status: 0,
    TC: false,
    Question: [{ name: host + ".", type: 1 }],
    Answer: [
      { name: host + ".", type: 5, data: owner },
      ...addresses.map(address => ({ name: owner, type: 1, data: address })),
    ],
  });
}

function fakeTunnel({ connectStatus = 200, tlsFailure = false, hangConnect = false, hangResponse = false } = {}) {
  const observed = { connect: [], tls: [], request: null, clientRequest: null, body: null, sockets: [], connectRequests: [] };
  let signalConnectStarted;
  const connectStarted = new Promise(resolve => { signalConnectStarted = resolve; });
  const makeSocket = () => {
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.destroy = () => { socket.destroyed = true; };
    observed.sockets.push(socket);
    return socket;
  };
  const connectRequest = options => {
    observed.connect.push(options);
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = () => { req.destroyed = true; };
    req.end = () => {
      observed.connectRequests.push(req);
      signalConnectStarted();
      if (hangConnect) return;
      queueMicrotask(() => req.emit("connect", { statusCode: connectStatus }, makeSocket(), Buffer.alloc(0)));
    };
    return req;
  };
  const tls = options => {
    observed.tls.push(options);
    const socket = makeSocket();
    queueMicrotask(() => {
      if (tlsFailure) socket.emit("error", new Error("TLS_SECRET_SENTINEL"));
      else socket.emit("secureConnect");
    });
    return socket;
  };
  const request = (options, onResponse) => {
    observed.request = options;
    const req = new EventEmitter();
    observed.clientRequest = req;
    req.destroyed = false;
    req.destroy = () => { req.destroyed = true; };
    req.end = body => {
      observed.body = body;
      options.agent.createConnection(options, (error, socket) => {
        if (error) {
          req.emit("error", error);
          return;
        }
        if (hangResponse) return;
        const response = new PassThrough();
        response.statusCode = 200;
        onResponse(response);
        response.end("accepted");
      });
    };
    return req;
  };
  return { observed, request, connectStarted, transport: { connectRequest, tlsConnect: tls } };
}

async function fixture(t, options = {}) {
  const logs = [];
  const token = options.token || TOKEN;
  const probe = createProbe({
    token,
    port: 0,
    resolve: async () => [{ address: PUBLIC_V4, family: 4 }],
    post: echoPost(),
    callbackTimeoutMs: 500,
    subscriptionTtlMs: 30_000,
    logger: fact => logs.push(fact),
    ...options,
  });
  const address = await probe.listen();
  t.after(() => probe.close());
  return {
    probe,
    logs,
    base: "http://127.0.0.1:" + address.port,
    auth: { authorization: "Bearer " + token },
  };
}

function loopbackHttp(input, { method = "GET", headers = {}, body } = {}, request = httpRequest) {
  const url = new URL(input);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode ?? 0,
          headers: { get: name => response.headers?.[name.toLowerCase()] ?? null },
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
    });
    req.once("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function rpc(fx, method, params = {}, extraHeaders = {}) {
  const response = await loopbackHttp(fx.base + "/mcp", {
    method: "POST",
    headers: {
      ...fx.auth,
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

async function status(fx) {
  const response = await loopbackHttp(fx.base + "/status", { headers: fx.auth });
  return { status: response.status, body: await response.json() };
}

test("loopback test client passes Fetch-disallowed ports to node:http", async () => {
  let requestedPort;
  const response = await loopbackHttp("http://127.0.0.1:6667/status", {}, (url, options, onResponse) => {
    requestedPort = url.port;
    const req = new EventEmitter();
    req.end = () => {
      const incoming = new PassThrough();
      incoming.statusCode = 204;
      incoming.headers = {};
      onResponse(incoming);
      incoming.end();
    };
    return req;
  });
  assert.equal(requestedPort, "6667");
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
});

function subscribeParams(resultId, url = "https://receiver.example/callback", secret = SECRET, ttlMs) {
  const params = {
    name: "probe.completed",
    arguments: { result_id: resultId },
    delivery: { mode: "webhook", url, secret },
    cursor: null,
  };
  if (arguments.length >= 4) params.ttlMs = ttlMs;
  return params;
}

function unsubscribeParams(resultId, url = "https://receiver.example/callback") {
  return { name: "probe.completed", arguments: { result_id: resultId }, delivery: { url } };
}

function assertSignature(call, secretBytes, subscriptionId, webhookId) {
  const timestamp = call.headers["webhook-timestamp"];
  const expected = createHmac("sha256", secretBytes)
    .update(webhookId + "." + timestamp + "." + call.body)
    .digest("base64");
  assert.match(timestamp, /^\d+$/u);
  assert.equal(call.headers["webhook-id"], webhookId);
  assert.equal(call.headers["webhook-signature"], "v1," + expected);
  assert.equal(call.headers["X-MCP-Subscription-Id"], subscriptionId);
  assert.equal(call.headers["content-type"], "application/json");
}

test("loopback HTTP authentication, Origin rejection, and JSON-RPC framing", async t => {
  const fx = await fixture(t);
  assert.equal(fx.probe.server.address().address, "127.0.0.1");

  const noAuth = await loopbackHttp(fx.base + "/status");
  assert.equal(noAuth.status, 401);
  const badMcpAuth = await loopbackHttp(fx.base + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }),
  });
  assert.equal(badMcpAuth.status, 401);
  const browserOrigin = await loopbackHttp(fx.base + "/status", {
    headers: { ...fx.auth, origin: "https://example.test" },
  });
  assert.equal(browserOrigin.status, 403);

  const discovery = await rpc(fx, "server/discover");
  assert.equal(discovery.status, 200);
  assert.match(discovery.headers.get("content-type"), /^application\/json/u);
  assert.deepEqual(discovery.body.result, {
    resultType: "complete",
    supportedVersions: ["2026-07-28"],
    capabilities: { tools: {}, events: {} },
  });
  const legacy = await rpc(fx, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(legacy.body.result.protocolVersion, "2025-11-25");
  assert.deepEqual(legacy.body.result.capabilities, { tools: {} });

  const complete = await loopbackHttp(fx.base + "/complete", { method: "POST", headers: fx.auth });
  assert.equal(complete.status, 200);
  assert.equal((await complete.json()).result, "completed");
  const visible = JSON.stringify((await status(fx)).body);
  assert.match(visible, /result_id/u);
  assert.doesNotMatch(visible, /proof|secret|callbackUrl|receiver\.example/u);
});

test("token validation does not use character variety as an entropy proxy", async t => {
  const fx = await fixture(t, { token: "0123456789abcde0123456789abcde012" });
  assert.equal((await status(fx)).status, 200);
});

test("oversized requests and invalid operator bodies fail without echoing input", async t => {
  const fx = await fixture(t);
  const oversized = "do-not-echo-" + "x".repeat(64 * 1024);
  const response = await loopbackHttp(fx.base + "/mcp", {
    method: "POST",
    headers: { ...fx.auth, "content-type": "application/json" },
    body: oversized,
  });
  assert.equal(response.status, 413);
  assert.doesNotMatch(await response.text(), /do-not-echo|xxxx/u);

  const complete = await loopbackHttp(fx.base + "/complete", {
    method: "POST",
    headers: { ...fx.auth, "content-type": "text/plain" },
    body: "do-not-echo",
  });
  assert.equal(complete.status, 413);
  assert.doesNotMatch(await complete.text(), /do-not-echo/u);
});

test("official event schema, signed verification then result_id-only event, and proof read", async t => {
  const calls = [];
  const hosts = [];
  const fx = await fixture(t, {
    resolve: async host => {
      hosts.push(host);
      return [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
      ];
    },
    post: echoPost(calls),
  });
  const listing = await rpc(fx, "events/list");
  const event = listing.body.result.events[0];
  assert.equal(event.name, "probe.completed");
  assert.deepEqual(event.delivery, ["webhook"]);
  assert.deepEqual(event.inputSchema.required, ["result_id"]);
  assert.deepEqual(event.inputSchema.properties.result_id, {
    type: "string",
    minLength: 36,
    maxLength: 36,
    description: "Opaque result identifier returned by /status for this probe run.",
  });
  assert.deepEqual(event.payloadSchema.required, ["result_id"]);
  assert.deepEqual(event.payloadSchema.properties.result_id, event.inputSchema.properties.result_id);
  assert.equal(event.payloadSchema.additionalProperties, false);

  const toolList = await rpc(fx, "tools/list");
  const tool = toolList.body.result.tools[0];
  assert.equal(tool.name, "read_result");
  assert.deepEqual(tool.annotations, {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  });
  assert.deepEqual(tool.inputSchema.properties.result_id, event.inputSchema.properties.result_id);

  const pendingRead = await rpc(fx, "tools/call", {
    name: "read_result",
    arguments: { result_id: fx.probe.resultId },
  });
  assert.deepEqual(pendingRead.body.result.structuredContent, {
    result_id: fx.probe.resultId,
    status: "pending",
  });

  const subscribe = await rpc(fx, "events/subscribe", subscribeParams(fx.probe.resultId));
  assert.equal(subscribe.body.error, undefined);
  const subscription = subscribe.body.result;
  assert.deepEqual(Object.keys(subscription).sort(), ["cursor", "id", "refreshBefore", "truncated"]);
  assert.equal(subscription.cursor, null);
  assert.equal(subscription.truncated, false);
  assertSignature(calls[0], SECRET_BYTES, subscription.id, calls[0].headers["webhook-id"]);
  assert.match(calls[0].headers["webhook-id"], /^msg_verification_/u);
  assert.deepEqual(calls[0].payload, {
    type: "verification",
    challenge: calls[0].payload.challenge,
  });
  assert.equal(typeof calls[0].payload.challenge, "string");
  assert.equal(hosts[0], "receiver.example");
  assert.equal(calls.length, 1);

  const replay = await rpc(fx, "events/subscribe", subscribeParams(fx.probe.resultId));
  assert.equal(replay.body.result.id, subscription.id);
  assert.equal(calls.length, 1);

  const completeResponse = await loopbackHttp(fx.base + "/complete", { method: "POST", headers: fx.auth });
  const completeBody = await completeResponse.json();
  assert.equal(completeBody.eventAttempt, "accepted");
  assert.equal("proof" in completeBody, false);
  assert.equal(calls.length, 2);
  const sentEvent = calls[1].payload;
  assert.deepEqual(Object.keys(sentEvent).sort(), ["cursor", "data", "eventId", "name", "timestamp"]);
  assert.equal(sentEvent.name, "probe.completed");
  assert.deepEqual(sentEvent.data, { result_id: fx.probe.resultId });
  assert.equal(calls[1].headers["webhook-id"], sentEvent.eventId);
  assertSignature(calls[1], SECRET_BYTES, subscription.id, sentEvent.eventId);
  assert.equal(hosts.length, 2);
  assert.ok(hosts.every(host => host === "receiver.example"));
  assert.equal(JSON.stringify(sentEvent).includes("proof"), false);

  await loopbackHttp(fx.base + "/complete", { method: "POST", headers: fx.auth });
  const replayAfterComplete = await rpc(fx, "events/subscribe", subscribeParams(fx.probe.resultId));
  assert.equal(replayAfterComplete.body.result.id, subscription.id);
  assert.equal(calls.length, 2);
  const read = await rpc(fx, "tools/call", {
    name: "read_result",
    arguments: { result_id: fx.probe.resultId },
  });
  const result = read.body.result.structuredContent;
  assert.equal(result.result_id, fx.probe.resultId);
  assert.equal(result.result, "The official MCP Events probe completed.");
  assert.match(result.proof, /^[A-Za-z0-9_-]{32}$/u);
  assert.equal(JSON.parse(read.body.result.content[0].text).proof, result.proof);

  const serializedLogs = JSON.stringify(fx.logs);
  assert.doesNotMatch(serializedLogs, /whsec_|receiver\.example\/callback|proof/u);
  const reads = fx.logs.filter(item => item.type === "tool_read");
  assert.deepEqual(reads.map(item => [item.resultStatus, item.eventAttempt]), [
    ["pending", "none"],
    ["completed", "accepted"],
  ]);
});

test("metadata is stable across runs while runtime IDs stay scoped to each probe", async t => {
  const firstCalls = [];
  const secondCalls = [];
  const first = await fixture(t, { post: echoPost(firstCalls) });
  const second = await fixture(t, { post: echoPost(secondCalls) });
  assert.notEqual(first.probe.resultId, second.probe.resultId);

  const metadata = async fx => ({
    events: (await rpc(fx, "events/list")).body.result,
    tools: (await rpc(fx, "tools/list")).body.result,
  });
  const firstMetadata = await metadata(first);
  const secondMetadata = await metadata(second);
  assert.deepEqual(firstMetadata, secondMetadata);
  const metadataText = JSON.stringify(firstMetadata);
  assert.equal(metadataText.includes(first.probe.resultId), false);
  assert.equal(metadataText.includes(second.probe.resultId), false);

  const currentRead = await rpc(first, "tools/call", {
    name: "read_result",
    arguments: { result_id: first.probe.resultId },
  });
  assert.deepEqual(currentRead.body.result.structuredContent, {
    result_id: first.probe.resultId,
    status: "pending",
  });
  const currentSubscription = await rpc(first, "events/subscribe", subscribeParams(first.probe.resultId));
  assert.equal(currentSubscription.body.error, undefined);
  assert.equal((await status(first)).body.subscription, "active");
  assert.equal(firstCalls.length, 1);
  assert.equal(secondCalls.length, 0);

  const stableStatus = (await status(first)).body;
  const oldRead = await rpc(first, "tools/call", {
    name: "read_result",
    arguments: { result_id: second.probe.resultId },
  });
  assert.equal(oldRead.body.error.code, -32602);
  const oldSubscription = await rpc(first, "events/subscribe", subscribeParams(second.probe.resultId));
  assert.equal(oldSubscription.body.error.code, -32602);
  const oldUnsubscribe = await rpc(first, "events/unsubscribe", unsubscribeParams(second.probe.resultId));
  assert.equal(oldUnsubscribe.body.error.code, -32602);
  assert.deepEqual((await status(first)).body, stableStatus);
  assert.equal(firstCalls.length, 1);
  assert.equal(secondCalls.length, 0);
});

test("top-level _meta is ignored for identity, routing, and authorization", async t => {
  const calls = [];
  const fx = await fixture(t, { post: echoPost(calls) });
  const firstParams = subscribeParams(fx.probe.resultId);
  firstParams._meta = {
    progressToken: 7,
    result_id: "META_RESULT_ID_SENTINEL",
    url: "https://META_URL_SENTINEL.example/callback",
    authorization: "Bearer META_AUTH_SENTINEL",
  };
  const subscribed = await rpc(fx, "events/subscribe", firstParams);
  assert.equal(subscribed.body.error, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://receiver.example/callback");

  const replayParams = subscribeParams(fx.probe.resultId);
  replayParams._meta = {
    result_id: "META_OTHER_RESULT_ID",
    url: "https://META_OTHER_URL.example/callback",
    secret: "META_SECRET_SENTINEL",
    authorization: "Bearer META_OTHER_AUTH",
  };
  const replay = await rpc(fx, "events/subscribe", replayParams);
  assert.equal(replay.body.result.id, subscribed.body.result.id);
  assert.equal(calls.length, 1);

  const topLevelToolMeta = await rpc(fx, "tools/call", {
    name: "read_result",
    arguments: { result_id: fx.probe.resultId },
    _meta: { progressToken: "META_TOOL_TOKEN" },
  });
  assert.deepEqual(topLevelToolMeta.body.result.structuredContent, {
    result_id: fx.probe.resultId,
    status: "pending",
  });
  const nestedToolMeta = await rpc(fx, "tools/call", {
    name: "read_result",
    arguments: { result_id: fx.probe.resultId, _meta: { progressToken: "META_NESTED_TOKEN" } },
  });
  assert.equal(nestedToolMeta.body.error.code, -32602);

  const unsubscribe = unsubscribeParams(fx.probe.resultId);
  unsubscribe._meta = {
    result_id: "META_UNSUB_RESULT",
    url: "https://META_UNSUB_URL.example/",
    authorization: "Bearer META_UNSUB_AUTH",
  };
  const unsubscribed = await rpc(fx, "events/unsubscribe", unsubscribe);
  assert.deepEqual(unsubscribed.body.result, {});
  assert.equal((await status(fx)).body.subscription, "unsubscribed");
  assert.equal(calls.length, 1);

  const eventLogs = fx.logs.filter(item => item.type === "rpc" &&
    (item.method === "events/subscribe" || item.method === "events/unsubscribe"));
  assert.equal(eventLogs.length, 3);
  assert.ok(eventLogs.every(item => item.metaPresent && item.metaType === "object"));
  assert.ok(eventLogs.every(item => item.unknownFieldCounts.top === 0 &&
    item.unknownFieldCounts.arguments === 0 && item.unknownFieldCounts.delivery === 0));
  const visible = JSON.stringify({ subscribed, replay, topLevelToolMeta, unsubscribed, logs: fx.logs });
  for (const secret of [
    "META_RESULT_ID_SENTINEL", "META_URL_SENTINEL", "META_AUTH_SENTINEL", "META_OTHER_RESULT_ID",
    "META_OTHER_URL", "META_SECRET_SENTINEL", "META_OTHER_AUTH", "META_TOOL_TOKEN", "META_NESTED_TOKEN",
    "META_UNSUB_RESULT", "META_UNSUB_URL", "META_UNSUB_AUTH",
  ]) assert.equal(visible.includes(secret), false, `metadata value leaked: ${secret}`);
});

test("top-level _meta must be an object and invalid values never reach callbacks", async t => {
  for (const [meta, type, name] of [
    [null, "null", "null"],
    [["META_ARRAY_SENTINEL"], "array", "array"],
    ["META_STRING_SENTINEL", "string", "string"],
    [9, "number", "number"],
    [{ progressToken: true, hint: "META_BAD_PROGRESS_BOOLEAN" }, "object", "boolean progressToken"],
    [{ progressToken: 1.5, hint: "META_BAD_PROGRESS_FRACTION" }, "object", "fractional progressToken"],
  ]) {
    await t.test(name, async subtest => {
      const calls = [];
      const fx = await fixture(subtest, { post: echoPost(calls) });
      const params = subscribeParams(fx.probe.resultId);
      params._meta = meta;
      const response = await rpc(fx, "events/subscribe", params);
      assert.equal(response.body.error.code, -32602);
      assert.equal(response.body.error.data.reason, "rpc_invalid_meta");
      assert.equal(calls.length, 0);
      assert.equal((await status(fx)).body.subscription, "none");
      const requestLog = fx.logs.find(item => item.type === "rpc" && item.method === "events/subscribe");
      const faultLog = fx.logs.find(item => item.type === "rpc_fault");
      assert.equal(requestLog.metaPresent, true);
      assert.equal(requestLog.metaType, type);
      assert.equal(faultLog.metaType, type);
      assert.deepEqual(faultLog.unknownFieldCounts, { top: 0, arguments: 0, delivery: 0 });
      assert.doesNotMatch(JSON.stringify({ response: response.body, logs: fx.logs }), /META_(?:ARRAY|STRING)_SENTINEL|META_BAD_PROGRESS_/u);
    });
  }
});

test("subscription ttlMs grants a finite default, caps requests, and honors null", async t => {
  const start = Date.parse("2026-10-05T00:00:00.000Z");
  const cases = [
    { name: "omitted", include: false, expected: 300_000 },
    { name: "positive", include: true, value: 60_000, expected: 60_000 },
    { name: "over server cap", include: true, value: 600_000, expected: 300_000 },
    { name: "null requests infinite but remains bounded", include: true, value: null, expected: 300_000 },
  ];
  for (const item of cases) {
    await t.test(item.name, async subtest => {
      const fx = await fixture(subtest, { now: () => start, subscriptionTtlMs: 300_000 });
      const params = item.include
        ? subscribeParams(fx.probe.resultId, undefined, undefined, item.value)
        : subscribeParams(fx.probe.resultId);
      const response = await rpc(fx, "events/subscribe", params);
      assert.equal(response.body.error, undefined);
      assert.equal(response.body.result.refreshBefore, new Date(start + item.expected).toISOString());
    });
  }
});

test("invalid ttlMs values fail with bounded subscribe diagnostics", async t => {
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1000", false]) {
    await t.test(String(value), async subtest => {
      const fx = await fixture(subtest);
      const params = subscribeParams(fx.probe.resultId, undefined, undefined, value);
      const response = await rpc(fx, "events/subscribe", params);
      assert.equal(response.body.error.code, -32602);
      assert.equal(response.body.error.data.reason, "subscribe_invalid_params");
      assert.equal(response.body.error.data.fields.ttlMs, typeof value);
      const fault = fx.logs.find(item => item.type === "rpc_fault");
      assert.equal(fault.reason, "subscribe_invalid_params");
      assert.equal(fault.fields.ttlMs, typeof value);
      assert.deepEqual(fault.unknownFieldCounts, { top: 0, arguments: 0, delivery: 0 });
    });
  }
});

test("active same-identity subscribe can shorten but never extend its refreshBefore", async t => {
  const start = Date.parse("2026-10-05T00:00:00.000Z");
  let current = start;
  const fx = await fixture(t, { now: () => current, subscriptionTtlMs: 300_000 });
  const first = await rpc(fx, "events/subscribe", subscribeParams(fx.probe.resultId, undefined, undefined, 120_000));
  assert.equal(first.body.result.refreshBefore, new Date(start + 120_000).toISOString());

  current += 1_000;
  const shortened = await rpc(fx, "events/subscribe", subscribeParams(fx.probe.resultId, undefined, undefined, 10_000));
  assert.equal(shortened.body.result.id, first.body.result.id);
  assert.equal(shortened.body.result.refreshBefore, new Date(current + 10_000).toISOString());

  current += 1_000;
  const replay = await rpc(fx, "events/subscribe", subscribeParams(fx.probe.resultId, undefined, undefined, 120_000));
  assert.equal(replay.body.result.refreshBefore, shortened.body.result.refreshBefore);
});

test("finite subscription lease expires on time and suppresses later delivery", async t => {
  const calls = [];
  const fx = await fixture(t, { subscriptionTtlMs: 1_000, post: echoPost(calls) });
  const response = await rpc(fx, "events/subscribe", subscribeParams(fx.probe.resultId));
  assert.equal(response.body.error, undefined);
  await new Promise(resolve => setTimeout(resolve, 1_100));
  assert.ok(fx.logs.some(item => item.type === "subscription" && item.state === "expired"));
  assert.equal((await status(fx)).body.subscription, "expired");
  await loopbackHttp(fx.base + "/complete", { method: "POST", headers: fx.auth });
  assert.equal(calls.length, 1);
  assert.equal((await status(fx)).body.eventAttempt, "none");
});

test("subscribe parse diagnostics expose only known field types and unknown count", async t => {
  const fx = await fixture(t);
  const params = subscribeParams(fx.probe.resultId, "https://private-value.example/never-log", "USER_SECRET_NEVER_LOG", 10_000);
  params._meta = { progressToken: 3, authorization: "META_SECRET_NEVER_LOG" };
  params.arguments.operatorPrompt = "PROMPT_VALUE_NEVER_LOG";
  params.delivery.callbackUrl = "CALLBACK_FIELD_NEVER_LOG";
  params.unrecognizedField = "UNKNOWN_VALUE_NEVER_LOG";
  const response = await rpc(fx, "events/subscribe", params);
  assert.equal(response.body.error.data.reason, "subscribe_invalid_params");
  assert.deepEqual(response.body.error.data.fields, {
    params: "object",
    name: "string",
    arguments: "object",
    "arguments.result_id": "string",
    delivery: "object",
    "delivery.mode": "string",
    "delivery.url": "string",
    "delivery.secret": "string",
    cursor: "null",
    ttlMs: "number",
  });
  assert.equal(response.body.error.data.unknownFieldCount, 3);
  const fault = fx.logs.find(item => item.type === "rpc_fault");
  assert.deepEqual(fault.fields, response.body.error.data.fields);
  assert.equal(fault.metaPresent, true);
  assert.equal(fault.metaType, "object");
  assert.deepEqual(fault.unknownFieldCounts, { top: 1, arguments: 1, delivery: 1 });
  const visible = JSON.stringify({ response: response.body, logs: fx.logs });
  for (const secret of [
    "private-value.example", "USER_SECRET_NEVER_LOG", "PROMPT_VALUE_NEVER_LOG",
    "CALLBACK_FIELD_NEVER_LOG", "UNKNOWN_VALUE_NEVER_LOG", "operatorPrompt", "callbackUrl", "unrecognizedField",
    "META_SECRET_NEVER_LOG", "authorization",
  ]) assert.equal(visible.includes(secret), false);
});

test("a bad challenge never activates the subscriber or sends an event", async t => {
  const calls = [];
  const fx = await fixture(t, {
    post: async (url, request) => {
      calls.push(JSON.parse(request.body));
      return { statusCode: 200, body: JSON.stringify({ challenge: "wrong" }) };
    },
  });
  const response = await rpc(fx, "events/subscribe", subscribeParams(fx.probe.resultId));
  assert.equal(response.body.error.code, -32015);
  assert.equal(response.body.error.data.reason, "challenge_failed");
  const fault = fx.logs.find(item => item.type === "rpc_fault");
  assert.equal(fault.method, "events/subscribe");
  assert.equal(fault.code, -32015);
  assert.equal(fault.reason, "challenge_failed");
  assert.equal(fault.metaPresent, false);
  assert.equal(fault.metaType, "missing");
  assert.deepEqual(fault.unknownFieldCounts, { top: 0, arguments: 0, delivery: 0 });
  assert.equal((await status(fx)).body.subscription, "failed");
  await loopbackHttp(fx.base + "/complete", { method: "POST", headers: fx.auth });
  assert.equal((await status(fx)).body.eventAttempt, "none");
  assert.equal(calls.length, 1);
});

test("a rejected event DNS answer is not_sent and cannot be retried", async t => {
  let lookups = 0;
  const calls = [];
  const fx = await fixture(t, {
    resolve: async () => {
      lookups++;
      return [{ address: lookups === 1 ? PUBLIC_V4 : "127.0.0.1", family: 4 }];
    },
    post: echoPost(calls),
  });
  const sub = await rpc(fx, "events/subscribe", subscribeParams(fx.probe.resultId));
  assert.equal(sub.body.error, undefined);
  await loopbackHttp(fx.base + "/complete", { method: "POST", headers: fx.auth });
  const observed = (await status(fx)).body;
  assert.equal(observed.eventAttempt, "not_sent");
  assert.equal(observed.eventReason, "address_invalid");
  assert.equal(calls.length, 1);
  assert.equal(lookups, 2);
  await loopbackHttp(fx.base + "/complete", { method: "POST", headers: fx.auth });
  assert.equal(calls.length, 1);
  assert.equal(lookups, 2);
});

test("callback URL, DNS address, IPv6-only, and redirect limits fail closed", async t => {
  const invalid = [
    { url: "http://receiver.example/callback", code: -32602 },
    { url: "https://receiver.example:444/callback", code: -32602 },
    { url: "https://localhost/callback", code: -32602 },
    { url: "https://receiver.example/callback", records: [{ address: "127.0.0.1", family: 4 }], reason: "address_invalid" },
    {
      url: "https://receiver.example/callback",
      records: [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }],
      reason: "address_invalid",
    },
    { url: "https://receiver.example/callback", records: [{ address: "2606:4700:4700::1111", family: 6 }], reason: "ipv6_unsupported" },
  ];
  for (const item of invalid) {
    await t.test(item.url + " " + (item.reason || "invalid"), async subtest => {
      let calls = 0;
      const fx = await fixture(subtest, {
        resolve: async () => item.records || [{ address: PUBLIC_V4, family: 4 }],
        post: async () => {
          calls++;
          return { statusCode: 200, body: "{}" };
        },
      });
      const response = await rpc(fx, "events/subscribe", subscribeParams(fx.probe.resultId, item.url));
      if (item.code) assert.equal(response.body.error.code, item.code);
      else {
        assert.equal(response.body.error.code, -32015);
        assert.equal(response.body.error.data.reason, item.reason);
      }
      assert.equal(calls, 0);
    });
  }

  await t.test("redirect is a response, never a second callback request", async subtest => {
    let calls = 0;
    const fx = await fixture(subtest, {
      post: async (url, request) => {
        calls++;
        return { statusCode: 302, body: JSON.stringify({ challenge: JSON.parse(request.body).challenge }) };
      },
    });
    const response = await rpc(fx, "events/subscribe", subscribeParams(fx.probe.resultId));
    assert.equal(response.body.error.data.reason, "challenge_failed");
    assert.equal(calls, 1);
    assert.equal((await status(fx)).body.subscription, "failed");
  });
});

test("pinned public DNS address is passed to HTTPS lookup with the original TLS hostname", async () => {
  let optionsSeen;
  let pinnedAll;
  let pinnedOne;
  let requestCount = 0;
  const fakeRequest = (options, onResponse) => {
    requestCount++;
    optionsSeen = options;
    const req = new EventEmitter();
    req.end = () => {
      options.lookup(options.hostname, { all: true }, (error, addresses) => {
        assert.equal(error, null);
        pinnedAll = addresses;
      });
      options.lookup(options.hostname, { all: false }, (error, address, family) => {
        assert.equal(error, null);
        pinnedOne = { address, family };
      });
      const response = new PassThrough();
      response.statusCode = 202;
      onResponse(response);
      response.end("accepted");
    };
    req.destroy = error => {
      if (error) queueMicrotask(() => req.emit("error", error));
    };
    return req;
  };
  const response = await postHttps(new URL("https://receiver.example/callback"), {
    body: "{}",
    headers: { "content-type": "application/json" },
    address: "93.184.216.34",
    signal: new AbortController().signal,
  }, fakeRequest);
  assert.equal(response.statusCode, 202);
  assert.equal(response.body, "accepted");
  assert.equal(requestCount, 1);
  assert.equal(optionsSeen.hostname, "receiver.example");
  assert.equal(optionsSeen.servername, "receiver.example");
  assert.equal(optionsSeen.port, 443);
  assert.notEqual(optionsSeen.agent, false);
  assert.deepEqual(optionsSeen.agent.options.proxyEnv, {});
  assert.deepEqual(pinnedAll, [{ address: "93.184.216.34", family: 4 }]);
  assert.deepEqual(pinnedOne, { address: "93.184.216.34", family: 4 });
});

test("explicit HTTP proxy CONNECT pins the approved IP while TLS and Host retain the callback name", async () => {
  const tunnel = fakeTunnel();
  const phases = [];
  let sentAfterTls = false;
  const response = await postHttps(new URL("https://receiver.example/callback/secret-path"), {
    body: "CALLBACK_BODY_SECRET_SENTINEL",
    headers: { "content-type": "application/json", "webhook-signature": "CALLBACK_HEADER_SECRET_SENTINEL" },
    address: CALLBACK_PIN,
    signal: new AbortController().signal,
    proxyUrl: CALLBACK_PROXY,
    onSend: () => { sentAfterTls = phases.includes("callback_tls"); },
    onPhase: phase => phases.push(phase),
  }, tunnel.request, tunnel.transport);

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, "accepted");
  assert.equal(tunnel.observed.connect.length, 1);
  assert.deepEqual({
    host: tunnel.observed.connect[0].hostname,
    port: tunnel.observed.connect[0].port,
    method: tunnel.observed.connect[0].method,
    path: tunnel.observed.connect[0].path,
    hostHeader: tunnel.observed.connect[0].headers.host,
  }, {
    host: "127.0.0.1",
    port: 7897,
    method: "CONNECT",
    path: CALLBACK_PIN + ":443",
    hostHeader: CALLBACK_PIN + ":443",
  });
  assert.equal(tunnel.observed.tls[0].servername, "receiver.example");
  assert.equal(tunnel.observed.tls[0].rejectUnauthorized, true);
  assert.equal(tunnel.observed.request.hostname, "receiver.example");
  assert.equal(tunnel.observed.request.servername, "receiver.example");
  assert.equal(tunnel.observed.request.headers.host, "receiver.example");
  assert.equal(tunnel.observed.request.path, "/callback/secret-path");
  assert.equal(sentAfterTls, true);
  const proxyRequestText = JSON.stringify(tunnel.observed.connect[0]);
  assert.doesNotMatch(proxyRequestText, /receiver\.example|secret-path|CALLBACK_.*SECRET_SENTINEL/u);
  assert.ok(phases.includes("callback_response_body"));
});

test("pinned proxy rejects CONNECT errors and TLS failures without sending callback data", async t => {
  for (const scenario of [
    { name: "non-200 CONNECT", options: { connectStatus: 407 }, reason: "proxy_rejected", sent: false },
    { name: "TLS validation", options: { tlsFailure: true }, reason: "tls_failed", sent: false },
  ]) {
    await t.test(scenario.name, async () => {
      const tunnel = fakeTunnel(scenario.options);
      let sent = false;
      await assert.rejects(postHttps(new URL("https://receiver.example/callback"), {
        body: "CALLBACK_BODY_SECRET_SENTINEL",
        headers: { "webhook-signature": "CALLBACK_HEADER_SECRET_SENTINEL" },
        address: CALLBACK_PIN,
        signal: new AbortController().signal,
        proxyUrl: CALLBACK_PROXY,
        onSend: () => { sent = true; },
      }, tunnel.request, tunnel.transport), error => error.message === scenario.reason);
      assert.equal(sent, scenario.sent);
      assert.equal(tunnel.observed.connect.length, 1);
      assert.equal(tunnel.observed.connect[0].path, CALLBACK_PIN + ":443");
      assert.equal(tunnel.observed.body, "CALLBACK_BODY_SECRET_SENTINEL");
    });
  }
});

test("proxied callback resolves only through pinned Cloudflare DoH and keeps secrets out of DNS, proxy and logs", async t => {
  const calls = [];
  const callbackSecret = "whsec_" + randomBytes(32).toString("base64");
  const fx = await fixture(t, {
    callbackProxyUrl: CALLBACK_PROXY,
    resolve: async () => { throw new Error("local DNS must not run in proxy mode"); },
    post: async (url, request) => {
      calls.push({ url, request });
      if (url.hostname === "cloudflare-dns.com") {
        return { statusCode: 200, body: dohBody("receiver.example") };
      }
      request.onSend?.();
      return { statusCode: 200, body: JSON.stringify({ challenge: JSON.parse(request.body).challenge }) };
    },
  });
  const callbackUrl = "https://receiver.example/private-callback-path";
  const response = await rpc(fx, "events/subscribe", subscribeParams(fx.probe.resultId, callbackUrl, callbackSecret));
  assert.equal(response.body.error, undefined);
  assert.equal(calls.length, 2);
  const [dohCall, callbackCall] = calls;
  assert.equal(dohCall.url.origin, "https://cloudflare-dns.com");
  assert.equal(dohCall.url.pathname, "/dns-query");
  assert.equal(dohCall.url.searchParams.get("name"), "receiver.example");
  assert.equal(dohCall.url.searchParams.get("type"), "A");
  assert.equal(dohCall.request.method, "GET");
  assert.equal(dohCall.request.address, "1.1.1.1");
  assert.equal(dohCall.request.proxyUrl, CALLBACK_PROXY);
  assert.equal(dohCall.request.body, "");
  assert.equal(callbackCall.request.address, CALLBACK_PIN);
  assert.equal(callbackCall.request.proxyUrl, CALLBACK_PROXY);
  assert.equal(callbackCall.url.href, callbackUrl);
  const doHAndLogs = JSON.stringify({ call: dohCall, logs: fx.logs });
  assert.equal(doHAndLogs.includes(callbackSecret), false);
  assert.doesNotMatch(doHAndLogs, /private-callback-path|CALLBACK_BODY_SECRET/u);
  assert.doesNotMatch(JSON.stringify(fx.logs), /127\.0\.0\.1:7897|private-callback-path|CALLBACK_SECRET_NEVER_LEAK/u);
});

test("proxied DoH rejects redirects, malformed answers, truncation, private answers, and oversized bodies", async t => {
  const scenarios = [
    { name: "redirect", response: { statusCode: 302, body: dohBody("receiver.example") }, reason: "doh_failed" },
    { name: "malformed JSON", response: { statusCode: 200, body: "{" }, reason: "address_invalid" },
    { name: "null JSON", response: { statusCode: 200, body: "null" }, reason: "address_invalid" },
    { name: "wrong question", response: { statusCode: 200, body: dohBody("other.example") }, reason: "address_invalid" },
    { name: "truncated", response: { statusCode: 200, body: JSON.stringify({ Status: 0, TC: true, Question: [{ name: "receiver.example", type: 1 }], Answer: [{ name: "receiver.example", type: 1, data: CALLBACK_PIN }] }) }, reason: "address_invalid" },
    { name: "mixed public and private answers", response: { statusCode: 200, body: dohBody("receiver.example", [CALLBACK_PIN, "127.0.0.1"]) }, reason: "address_invalid" },
    { name: "oversized body", response: { statusCode: 200, body: "x".repeat(8 * 1024 + 1) }, reason: "address_invalid" },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async subtest => {
      let calls = 0;
      const fx = await fixture(subtest, {
        callbackProxyUrl: CALLBACK_PROXY,
        post: async () => { calls++; return scenario.response; },
      });
      const response = await rpc(fx, "events/subscribe", subscribeParams(fx.probe.resultId));
      assert.equal(response.body.error.code, -32015);
      assert.equal(response.body.error.data.reason, scenario.reason);
      assert.equal(response.body.error.data.phase, scenario.reason === "doh_failed" ? "doh_response_headers" : "dns");
      assert.equal(calls, 1);
      assert.equal((await status(fx)).body.subscription, "failed");
    });
  }
});

test("proxy abort destroys pending tunnel sockets and a single total deadline reports its fixed phase", async t => {
  const cancelled = fakeTunnel({ hangResponse: true });
  const controller = new AbortController();
  const pending = postHttps(new URL("https://receiver.example/callback"), {
    body: "{}",
    headers: {},
    address: CALLBACK_PIN,
    signal: controller.signal,
    proxyUrl: CALLBACK_PROXY,
  }, cancelled.request, cancelled.transport);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, error => error.message === "callback_cancelled");
  assert.ok(cancelled.observed.sockets.length >= 2);
  assert.ok(cancelled.observed.sockets.every(socket => socket.destroyed));

  const deadlineTunnel = fakeTunnel({ hangResponse: true });
  const fx = await fixture(t, {
    callbackProxyUrl: CALLBACK_PROXY,
    callbackTimeoutMs: 80,
    post: postHttps,
    postTransport: {
      ...deadlineTunnel.transport,
      httpsRequest: deadlineTunnel.request,
    },
  });
  const subscription = rpc(fx, "events/subscribe", subscribeParams(fx.probe.resultId));
  await deadlineTunnel.connectStarted;
  const result = await subscription;
  assert.equal(result.body.error.code, -32015);
  assert.equal(result.body.error.data.reason, "timeout");
  assert.equal(result.body.error.data.phase, "doh_response_headers");
  assert.equal(deadlineTunnel.observed.connectRequests[0].destroyed, true);
  assert.equal(deadlineTunnel.observed.clientRequest.destroyed, true);
  assert.ok(deadlineTunnel.observed.sockets.length >= 2);
  assert.ok(deadlineTunnel.observed.sockets.every(socket => socket.destroyed));
  assert.equal((await status(fx)).body.subscription, "failed");
});

test("callback proxy configuration accepts only an explicit loopback HTTP origin", async () => {
  for (const invalid of [
    "https://127.0.0.1:7897", "http://localhost:7897", "http://127.0.0.1",
    "http://127.0.0.1:7897/path", "http://user@127.0.0.1:7897", "http://127.0.0.1:7897?token=x",
    "http://127.0.0.1:7897#fragment", "http://192.168.1.2:7897",
  ]) {
    assert.throws(() => createProbe({ token: TOKEN, callbackProxyUrl: invalid }), /http:\/\/127\.0\.0\.1:<port>/u);
  }
});

test("DNS-to-response timeout marks an event attempt unknown and never retries it", async t => {
  let calls = 0;
  let eventSignal;
  const fx = await fixture(t, {
    callbackTimeoutMs: 30,
    post: async (url, request) => {
      calls++;
      const payload = JSON.parse(request.body);
      if (payload.type === "verification") {
        return { statusCode: 200, body: JSON.stringify({ challenge: payload.challenge }) };
      }
      request.onSend?.();
      eventSignal = request.signal;
      return new Promise(() => {});
    },
  });
  const response = await rpc(fx, "events/subscribe", subscribeParams(fx.probe.resultId));
  assert.equal(response.body.error, undefined);
  await loopbackHttp(fx.base + "/complete", { method: "POST", headers: fx.auth });
  assert.equal((await status(fx)).body.eventAttempt, "unknown");
  assert.equal(eventSignal.aborted, true);
  await loopbackHttp(fx.base + "/complete", { method: "POST", headers: fx.auth });
  assert.equal(calls, 2);
});

test("DNS lookup time is inside the challenge timeout and cannot activate later", async t => {
  let release;
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const dnsGate = new Promise(resolve => { release = resolve; });
  let postCalls = 0;
  const fx = await fixture(t, {
    callbackTimeoutMs: 25,
    resolve: async () => {
      started();
      return dnsGate;
    },
    post: async () => {
      postCalls++;
      return { statusCode: 200, body: "{}" };
    },
  });
  const pendingSubscribe = rpc(fx, "events/subscribe", subscribeParams(fx.probe.resultId));
  await startedPromise;
  const response = await pendingSubscribe;
  assert.equal(response.body.error.code, -32015);
  assert.equal(response.body.error.data.reason, "timeout");
  assert.equal(response.body.error.data.phase, "dns");
  release([{ address: PUBLIC_V4, family: 4 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(postCalls, 0);
  assert.equal((await status(fx)).body.subscription, "failed");
});

test("unsubscribe during callback verification cancels activation and later delivery", async t => {
  let release;
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const dnsGate = new Promise(resolve => { release = resolve; });
  let postCalls = 0;
  const fx = await fixture(t, {
    resolve: async () => {
      started();
      return dnsGate;
    },
    post: async () => {
      postCalls++;
      return { statusCode: 200, body: "{}" };
    },
  });
  const subscriptionRequest = rpc(fx, "events/subscribe", subscribeParams(fx.probe.resultId));
  await startedPromise;
  const removed = await rpc(fx, "events/unsubscribe", unsubscribeParams(fx.probe.resultId));
  assert.deepEqual(removed.body.result, {});
  release([{ address: PUBLIC_V4, family: 4 }]);
  const failedSubscribe = await subscriptionRequest;
  assert.equal(failedSubscribe.body.error.code, -32015);
  await loopbackHttp(fx.base + "/complete", { method: "POST", headers: fx.auth });
  assert.equal((await status(fx)).body.subscription, "unsubscribed");
  assert.equal((await status(fx)).body.eventAttempt, "none");
  assert.equal(postCalls, 0);
});

test("unsubscribe after an event POST starts records unknown and never retries", async t => {
  let started;
  const eventStarted = new Promise(resolve => { started = resolve; });
  let postCalls = 0;
  let eventSignal;
  const fx = await fixture(t, {
    post: async (url, request) => {
      postCalls++;
      const payload = JSON.parse(request.body);
      if (payload.type === "verification") {
        return { statusCode: 200, body: JSON.stringify({ challenge: payload.challenge }) };
      }
      request.onSend?.();
      eventSignal = request.signal;
      started();
      return new Promise((resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("callback_cancelled")), { once: true });
      });
    },
  });
  const subscribed = await rpc(fx, "events/subscribe", subscribeParams(fx.probe.resultId));
  assert.equal(subscribed.body.error, undefined);

  const completing = loopbackHttp(fx.base + "/complete", { method: "POST", headers: fx.auth });
  await eventStarted;
  const removed = await rpc(fx, "events/unsubscribe", unsubscribeParams(fx.probe.resultId));
  assert.deepEqual(removed.body.result, {});
  const completed = await completing;
  assert.equal(completed.status, 200);
  assert.equal(eventSignal.aborted, true);
  assert.equal((await status(fx)).body.eventAttempt, "unknown");
  assert.equal((await status(fx)).body.eventReason, "cancelled");

  await loopbackHttp(fx.base + "/complete", { method: "POST", headers: fx.auth });
  assert.equal(postCalls, 2);
});

test("unsubscribe is idempotent and completion after it sends no event", async t => {
  const calls = [];
  const fx = await fixture(t, { post: echoPost(calls) });
  const response = await rpc(fx, "events/subscribe", subscribeParams(fx.probe.resultId));
  assert.equal(response.body.error, undefined);
  assert.equal(calls.length, 1);
  assert.deepEqual((await rpc(fx, "events/unsubscribe", unsubscribeParams(fx.probe.resultId))).body.result, {});
  assert.deepEqual((await rpc(fx, "events/unsubscribe", unsubscribeParams(fx.probe.resultId))).body.result, {});
  await loopbackHttp(fx.base + "/complete", { method: "POST", headers: fx.auth });
  assert.equal(calls.length, 1);
  assert.equal((await status(fx)).body.eventAttempt, "none");
});

test("invalid unsubscribe logs bounded shapes without request content", async t => {
  const fx = await fixture(t);
  const params = unsubscribeParams(fx.probe.resultId, "https://unsub-private.example/callback?token=UNSUB_URL_SECRET");
  params._meta = { authorization: "META_UNSUB_AUTH_SECRET" };
  params.clientSecret = "UNSUB_SECRET_NEVER_LOG";
  params.operatorNote = "UNSUB_USER_CONTENT_NEVER_LOG";
  const response = await rpc(fx, "events/unsubscribe", params);
  assert.equal(response.body.error.code, -32602);
  assert.equal(response.body.error.data, undefined);
  const fault = fx.logs.find(item => item.type === "rpc_fault");
  assert.equal(fault.method, "events/unsubscribe");
  assert.equal(fault.code, -32602);
  assert.equal(fault.reason, "rpc_invalid_params");
  assert.equal(fault.metaPresent, true);
  assert.equal(fault.metaType, "object");
  assert.deepEqual(fault.unknownFieldCounts, { top: 2, arguments: 0, delivery: 0 });
  const visible = JSON.stringify({ response: response.body, logs: fx.logs });
  for (const value of [
    "unsub-private.example", "UNSUB_URL_SECRET", "UNSUB_SECRET_NEVER_LOG",
    "UNSUB_USER_CONTENT_NEVER_LOG", "META_UNSUB_AUTH_SECRET", "clientSecret", "operatorNote", "authorization",
  ]) assert.equal(visible.includes(value), false);
});
