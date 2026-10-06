import assert from "node:assert/strict";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { publicReport, runOfficialDispatchProbeRaw } from "./probe.mjs";

const MAX_REQUEST_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_DISPATCH_WAIT_MS = 45_000;
const DEFAULT_SHUTDOWN_WAIT_MS = 600_000;
const PORT_ENV = "C2C_OFFICIAL_DISPATCH_PORT";
const TOKEN_ENV = "C2C_OFFICIAL_DISPATCH_TOKEN";

function tokenDigest(token) {
  return createHash("sha256").update(token, "utf8").digest();
}

function authorized(req, expectedDigest) {
  if (req.headers.origin !== undefined) return false;
  const header = req.headers.authorization;
  const candidate = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  return timingSafeEqual(tokenDigest(candidate), expectedDigest);
}

function sendJson(res, statusCode, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function readBody(req, maxBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error("request_too_large");
        error.statusCode = 413;
        finish(error);
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks).toString("utf8"));
    const onError = () => finish(Object.assign(new Error("request_failed"), { statusCode: 400 }));
    const onAborted = () => finish(Object.assign(new Error("request_aborted"), { statusCode: 400 }));
    const timer = setTimeout(() => {
      finish(Object.assign(new Error("request_timeout"), { statusCode: 408 }));
      req.resume();
    }, timeoutMs);
    timer.unref?.();
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
}

function mcpText(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function cleanupProved(report) {
  if (report?.childCleanup?.spawned === false) return true;
  return report?.childCleanup?.spawned === true &&
    report.childCleanup.clientCloseCompleted === true &&
    report.childCleanup.closeObserved === true;
}

function waitBounded(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise.then((value) => ({ completed: true, value })),
    new Promise((resolve) => { timer = setTimeout(() => resolve({ completed: false }), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

export function createOfficialDispatchMcpProbe({
  token,
  port = 0,
  runProbe = runOfficialDispatchProbeRaw,
  dispatchWaitMs = DEFAULT_DISPATCH_WAIT_MS,
  shutdownWaitMs = DEFAULT_SHUTDOWN_WAIT_MS,
} = {}) {
  assert.equal(typeof token, "string");
  assert.ok(token.length >= 32 && token.length <= 256);
  assert.ok(/^[A-Za-z0-9+/=_-]+$/u.test(token));
  assert.ok(Number.isInteger(port) && port >= 0 && port <= 65_535);
  assert.ok(Number.isInteger(dispatchWaitMs) && dispatchWaitMs >= 1 && dispatchWaitMs <= DEFAULT_DISPATCH_WAIT_MS);
  assert.ok(Number.isInteger(shutdownWaitMs) && shutdownWaitMs >= 1 && shutdownWaitMs <= DEFAULT_SHUTDOWN_WAIT_MS);

  const experimentId = randomUUID();
  const expectedTokenDigest = tokenDigest(token);
  let phase = "not_started";
  let report = null;
  let dispatchPromise = null;
  let shutdownRequested = false;
  let closePromise = null;

  function state() {
    return {
      experimentId,
      phase,
      shutdownRequested,
      ...(report && (phase === "completed" || phase === "failed") ? { report } : {}),
    };
  }

  function startDispatch() {
    if (shutdownRequested) return Promise.resolve(null);
    if (!dispatchPromise) {
      phase = "running";
      dispatchPromise = Promise.resolve().then(runProbe).then((value) => {
        report = publicReport(value);
        phase = report.status === "completed" ? "completed" : "failed";
        return report;
      }, () => {
        report = publicReport({
          status: "failed",
          failure: { category: "probe", reason: "operation_failed" },
          child: { spawned: null, clientCloseCompleted: false, closeObserved: false },
        });
        phase = "failed";
        return report;
      }).then((value) => {
        if (shutdownRequested && cleanupProved(report)) setTimeout(() => { void closeServer(); }, 0);
        return value;
      });
    }
    return dispatchPromise;
  }

  async function dispatchResult() {
    if (shutdownRequested) return { ...state(), phase: "shutdown_requested" };
    const pending = startDispatch();
    const outcome = await waitBounded(pending, dispatchWaitMs);
    if (!outcome.completed) return { experimentId, phase: "running" };
    if (outcome.value === null) return { ...state(), phase: "shutdown_requested" };
    return state();
  }

  async function requestShutdown() {
    shutdownRequested = true;
    if (!dispatchPromise) return { status: "stopped", ownedChildCleanup: "not_started" };
    if (phase === "running") {
      const outcome = await waitBounded(dispatchPromise, shutdownWaitMs);
      if (!outcome.completed) return { status: "pending", reason: "dispatch_still_running" };
    }
    if (!cleanupProved(report)) return { status: "pending", reason: "owned_child_cleanup_unconfirmed" };
    return { status: "stopped", ownedChildCleanup: "confirmed", phase };
  }

  async function closeServer() {
    if (closePromise) return closePromise;
    closePromise = new Promise((resolve, reject) => {
      if (!httpServer.listening) return resolve();
      httpServer.close((error) => error ? reject(error) : resolve());
    });
    return closePromise;
  }

  function makeMcpServer() {
    const mcp = new McpServer({ name: "official-dispatch-probe", version: "0.0.0-experiment" });
    mcp.registerTool("run_official_dispatch_probe", {
      title: "Run the fixed official dispatch probe",
      description: "Start or join this experiment's single fixed, read-only, two-turn Codex App Server probe. Pass the exact experiment_id returned by read_official_dispatch_state. A repeated matching call returns the same in-flight or completed result and never starts a second probe.",
      inputSchema: z.object({ experiment_id: z.string().uuid() }).strict(),
      annotations: { readOnlyHint: false, idempotentHint: true },
    }, async ({ experiment_id }) => {
      if (experiment_id !== experimentId) {
        return { ...mcpText({ status: "rejected", reason: "experiment_id_mismatch" }), isError: true };
      }
      return mcpText(await dispatchResult());
    });
    mcp.registerTool("read_official_dispatch_state", {
      title: "Read official dispatch probe state",
      description: "Read this experiment's bounded state. Fixture and turn results are available only after the fixed probe reaches a terminal state.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true },
    }, async () => mcpText(state()));
    return mcp;
  }

  const httpServer = createServer(async (req, res) => {
    if (!authorized(req, expectedTokenDigest)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (req.url === "/status" && req.method === "GET") {
      if (req.headers["content-length"] && req.headers["content-length"] !== "0" || req.headers["transfer-encoding"]) {
        sendJson(res, 400, { error: "empty_body_required" });
        req.resume();
        return;
      }
      sendJson(res, 200, state());
      return;
    }
    if (req.url === "/shutdown" && req.method === "POST") {
      try {
        const body = await readBody(req, 0, REQUEST_TIMEOUT_MS);
        if (body.length !== 0) {
          sendJson(res, 400, { error: "empty_body_required" });
          return;
        }
        const outcome = await requestShutdown();
        sendJson(res, 200, outcome);
        if (outcome.status === "stopped") setTimeout(() => { void closeServer(); }, 0);
      } catch (error) {
        sendJson(res, Number.isInteger(error?.statusCode) ? error.statusCode : 400, {
          error: error?.statusCode === 413 ? "request_too_large" : "request_failed",
        });
      }
      return;
    }
    if (req.url !== "/mcp" || req.method !== "POST") {
      sendJson(res, 404, { error: "not_found" });
      req.resume();
      return;
    }
    const contentType = req.headers["content-type"] ?? "";
    if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
      sendJson(res, 415, { error: "application_json_required" });
      req.resume();
      return;
    }
    try {
      const rawBody = await readBody(req, MAX_REQUEST_BYTES, REQUEST_TIMEOUT_MS);
      const parsedBody = JSON.parse(rawBody);
      if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
        sendJson(res, 400, { error: "json_object_required" });
        return;
      }
      const mcp = makeMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.once("close", () => {
        void transport.close().catch(() => undefined);
        void mcp.close().catch(() => undefined);
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, Number.isInteger(error?.statusCode) ? error.statusCode : 400, {
          error: error?.statusCode === 413 ? "request_too_large"
            : error?.statusCode === 408 ? "request_timeout"
              : "request_failed",
        });
      }
    }
  });
  httpServer.headersTimeout = 10_000;
  httpServer.requestTimeout = 10_000;
  httpServer.keepAliveTimeout = 1_000;

  return {
    experimentId,
    server: httpServer,
    listen() {
      return new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, "127.0.0.1", () => {
          httpServer.off("error", reject);
          resolve(httpServer.address());
        });
      });
    },
    state,
    requestShutdown,
    close: closeServer,
  };
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error("invalid_port");
  return port;
}

function parseResult(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text);
}

async function connectClient(url, token) {
  const client = new Client({ name: "official-dispatch-fake-client", version: "0.0.0-test" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: "Bearer " + token } },
  });
  await client.connect(transport);
  return client;
}

async function waitUntil(predicate, timeoutMs = 1_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition timed out");
}

async function selfTest() {
  const token = "selftest-" + randomUUID() + "-token";
  let invocations = 0;
  let release;
  const fakeRun = new Promise((resolve) => { release = resolve; });
  const probe = createOfficialDispatchMcpProbe({
    token,
    port: 0,
    dispatchWaitMs: 100,
    shutdownWaitMs: 1_000,
    runProbe: () => {
      invocations += 1;
      return fakeRun;
    },
  });
  const address = await probe.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const unauthorized = await fetch(baseUrl + "/status");
    assert.equal(unauthorized.status, 401);

    const first = await connectClient(baseUrl + "/mcp", token);
    const listed = await first.listTools();
    const dispatchTool = listed.tools.find((tool) => tool.name === "run_official_dispatch_probe");
    const stateTool = listed.tools.find((tool) => tool.name === "read_official_dispatch_state");
    assert.ok(dispatchTool && stateTool);
    assert.equal(dispatchTool.annotations?.readOnlyHint, false);
    assert.equal(stateTool.annotations?.readOnlyHint, true);
    const experimentIdSchema = dispatchTool.inputSchema?.properties?.experiment_id;
    assert.equal(experimentIdSchema?.type, "string");
    assert.equal(experimentIdSchema?.format, "uuid");
    assert.ok(!("enum" in experimentIdSchema));
    assert.ok(!("const" in experimentIdSchema));

    const initial = parseResult(await first.callTool({ name: "read_official_dispatch_state", arguments: {} }));
    assert.equal(initial.phase, "not_started");
    assert.ok(!("report" in initial));
    assert.match(initial.experimentId, /^[0-9a-f-]{36}$/u);

    const invalid = await first.callTool({
      name: "run_official_dispatch_probe",
      arguments: { experiment_id: initial.experimentId, prompt: "must not be accepted" },
    });
    assert.equal(invalid.isError, true);
    assert.equal(invocations, 0);
    const staleId = randomUUID();
    const wrongId = randomUUID();
    for (const rejectedId of [staleId, wrongId]) {
      assert.notEqual(rejectedId, initial.experimentId);
      const stale = await first.callTool({
        name: "run_official_dispatch_probe",
        arguments: { experiment_id: rejectedId },
      });
      assert.equal(stale.isError, true);
      assert.equal(parseResult(stale).reason, "experiment_id_mismatch");
      assert.equal(invocations, 0);
    }

    const controller = new AbortController();
    const disconnectedCall = first.callTool(
      { name: "run_official_dispatch_probe", arguments: { experiment_id: initial.experimentId } },
      undefined,
      { signal: controller.signal, timeout: 5_000 },
    );
    await waitUntil(() => invocations === 1);
    controller.abort();
    await disconnectedCall.catch(() => undefined);
    await first.close();

    const second = await connectClient(baseUrl + "/mcp", token);
    const listedAgain = await second.listTools();
    const refreshedDispatchTool = listedAgain.tools.find((tool) => tool.name === "run_official_dispatch_probe");
    const refreshedIdSchema = refreshedDispatchTool?.inputSchema?.properties?.experiment_id;
    assert.equal(refreshedIdSchema?.type, "string");
    assert.equal(refreshedIdSchema?.format, "uuid");
    assert.ok(!("enum" in refreshedIdSchema));
    assert.ok(!("const" in refreshedIdSchema));
    const inFlight = parseResult(await second.callTool({ name: "read_official_dispatch_state", arguments: {} }));
    assert.equal(inFlight.phase, "running");
    assert.ok(!("report" in inFlight));

    const duplicateWhileRunning = parseResult(await second.callTool({
      name: "run_official_dispatch_probe",
      arguments: { experiment_id: initial.experimentId },
    }));
    assert.equal(duplicateWhileRunning.phase, "running");
    assert.ok(!("report" in duplicateWhileRunning));
    assert.equal(invocations, 1);
    release({
      status: "completed",
      authType: "chatgpt",
      requiresOpenaiAuth: true,
      threadId: "fake-thread",
      turns: [
        { turnId: "fake-turn-1", status: "completed", exactReplyMatch: true },
        { turnId: "fake-turn-2", status: "completed", exactReplyMatch: true, noToolActions: true },
      ],
      threadRead: { status: "unavailable", reason: "request_rejected", rpcCode: -32600 },
      child: { spawned: true, clientCloseCompleted: true, closeObserved: true },
      scratchCleanupCompleted: true,
      fixtureValue: "fixture-secret-must-not-escape",
    });
    const completed = parseResult(await second.callTool({
      name: "run_official_dispatch_probe",
      arguments: { experiment_id: initial.experimentId },
    }));
    assert.equal(completed.phase, "completed");
    assert.equal(completed.report.threadId, "fake-thread");
    assert.equal(completed.report.turns.length, 2);
    assert.deepEqual(completed.report.childCleanup, {
      spawned: true,
      clientCloseCompleted: true,
      closeObserved: true,
    });
    assert.ok(!JSON.stringify(completed).includes("fixture-secret-must-not-escape"));
    assert.equal(invocations, 1);

    const repeated = parseResult(await second.callTool({
      name: "run_official_dispatch_probe",
      arguments: { experiment_id: initial.experimentId },
    }));
    assert.deepEqual(repeated, completed);
    const finalState = parseResult(await second.callTool({ name: "read_official_dispatch_state", arguments: {} }));
    assert.deepEqual(finalState.report, completed.report);
    await second.close();

    const stopped = await fetch(baseUrl + "/shutdown", {
      method: "POST",
      headers: { authorization: "Bearer " + token },
    });
    assert.equal((await stopped.json()).status, "stopped");
    await waitUntil(() => !probe.server.listening);

    const failedToken = "selftest-failed-" + randomUUID();
    const failedProbe = createOfficialDispatchMcpProbe({
      token: failedToken,
      port: 0,
      runProbe: async () => ({
        status: "failed",
        failureStep: "child-close",
        failure: { step: "child-close", category: "operation", reason: "operation_failed" },
        turns: [],
        child: { spawned: true, clientCloseCompleted: true, closeObserved: false },
        threadRead: { status: "not_attempted" },
      }),
      dispatchWaitMs: 100,
      shutdownWaitMs: 1_000,
    });
    const failedAddress = await failedProbe.listen();
    const failedClient = await connectClient(`http://127.0.0.1:${failedAddress.port}/mcp`, failedToken);
    const failedState = parseResult(await failedClient.callTool({
      name: "read_official_dispatch_state",
      arguments: {},
    }));
    const failed = parseResult(await failedClient.callTool({
      name: "run_official_dispatch_probe",
      arguments: { experiment_id: failedState.experimentId },
    }));
    assert.equal(failed.phase, "failed");
    assert.deepEqual(failed.report.childCleanup, {
      spawned: true,
      clientCloseCompleted: true,
      closeObserved: false,
    });
    const pendingShutdown = await failedProbe.requestShutdown();
    assert.deepEqual(pendingShutdown, { status: "pending", reason: "owned_child_cleanup_unconfirmed" });
    await failedClient.close();
    await failedProbe.close();
    process.stdout.write("official-dispatch MCP fake protocol checks passed; no app-server turn started\n");
  } finally {
    if (probe.server.listening) {
      await probe.close();
    }
  }
}

async function live() {
  const token = process.env[TOKEN_ENV];
  const port = parsePort(process.env[PORT_ENV] ?? "43872");
  const probe = createOfficialDispatchMcpProbe({ token, port });
  const address = await probe.listen();
  process.stdout.write(JSON.stringify({
    type: "official_dispatch_probe_listening",
    address: "127.0.0.1",
    port: address.port,
    experimentId: probe.experimentId,
    persistence: "memory_only",
  }) + "\n");
  const stop = async () => {
    try {
      const result = await probe.requestShutdown();
      process.stdout.write(JSON.stringify({ type: "official_dispatch_probe_shutdown", status: result.status }) + "\n");
      if (result.status === "stopped") await probe.close();
    } catch {
      process.stdout.write("official_dispatch_probe_shutdown_pending\n");
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function main() {
  const mode = process.argv[2];
  assert.ok(mode === "--self-test" || mode === "--live", "use --self-test or --live");
  if (mode === "--self-test") await selfTest();
  else await live();
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    const reason = error instanceof Error && error.name === "AssertionError" ? "validation_failed" : "probe_start_failed";
    process.stderr.write("official-dispatch MCP probe stopped safely: " + reason + "\n");
    process.exitCode = 1;
  });
}
