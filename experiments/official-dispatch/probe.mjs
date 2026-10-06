import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AppServerClient, AppServerRpcError } from "../../src/remote/app-server.js";

const version = "0.160.0";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidenceDir = join(repo, ".tooling", "official-dispatch-20261005");
const schemaDir = join(evidenceDir, "schema-0.160.0-stable");
const codexExe = process.env.CODEX_APP_SERVER_EXECUTABLE ??
  join(process.env.LOCALAPPDATA ?? "", "OpenAI", "Codex", "bin", "8aaf1547b825b104", "codex.exe");
const turnTimeoutMs = 120_000;

const object = (value, label) => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label + " must be an object");
  return value;
};

const readJson = (name) => JSON.parse(readFileSync(join(schemaDir, name), "utf8"));

function schemaCheck() {
  const requests = readJson("ClientRequest.json");
  const notifications = readJson("ServerNotification.json");
  const protocol = readJson("codex_app_server_protocol.v2.schemas.json");
  const params = (method) => {
    const entry = requests.oneOf.find((variant) => variant.properties.method.enum.includes(method));
    assert.ok(entry, "stable schema missing " + method);
    return requests.definitions[entry.properties.params.$ref.split("/").at(-1)];
  };
  const checkParams = (method, value) => {
    const shape = params(method);
    for (const key of Object.keys(value)) assert.ok(key in shape.properties, method + " schema missing " + key);
    for (const key of shape.required ?? []) assert.ok(key in value, method + " missing " + key);
  };

  const threadStart = params("thread/start").properties;
  assert.ok("ephemeral" in threadStart);
  assert.ok(requests.definitions.SandboxMode.enum.includes("read-only"));
  assert.ok(requests.definitions.AskForApproval.oneOf.some((v) => v.enum?.includes("never")));
  assert.ok(!("runtimeWorkspaceRoots" in threadStart));

  const turnStart = params("turn/start").properties;
  const readOnly = requests.definitions.SandboxPolicy.oneOf.find((v) => v.properties.type.enum.includes("readOnly"));
  assert.equal(readOnly.properties.networkAccess.default, false);
  assert.ok(!("runtimeWorkspaceRoots" in turnStart));
  assert.ok(turnStart.sandboxPolicy.anyOf.some((v) => v.$ref?.endsWith("/SandboxPolicy")));

  const completion = notifications.oneOf.find((v) => v.properties.method.enum.includes("turn/completed"));
  const completionParams = notifications.definitions[completion.properties.params.$ref.split("/").at(-1)];
  assert.deepEqual(completionParams.required, ["threadId", "turn"]);
  const itemCompleted = notifications.oneOf.find((v) => v.properties.method.enum.includes("item/completed"));
  const itemParams = notifications.definitions[itemCompleted.properties.params.$ref.split("/").at(-1)];
  assert.deepEqual(itemParams.required, ["completedAtMs", "item", "threadId", "turnId"]);
  assert.equal(params("thread/read").properties.includeTurns.type, "boolean");
  assert.ok(protocol.definitions.TurnStatus.enum.includes("completed"));
  assert.ok(protocol.definitions.Account.oneOf.some((v) => v.properties.type.enum?.includes("chatgpt")));
  assert.ok("account" in protocol.definitions.GetAccountResponse.properties);
  assert.ok("requiresOpenaiAuth" in protocol.definitions.GetAccountResponse.properties);
  assert.ok("isDefault" in protocol.definitions.Model.properties && "id" in protocol.definitions.Model.properties);
  assert.ok("sandbox" in protocol.definitions.ThreadStartResponse.properties);
  assert.ok("ephemeral" in protocol.definitions.Thread.properties);
  assert.ok("items" in protocol.definitions.Turn.properties);
  assert.ok(protocol.definitions.ThreadItem.oneOf.some((v) =>
    v.properties.type.enum?.includes("agentMessage") && "text" in v.properties));
  assert.equal(protocol.definitions.Thread.properties.turns.type, "array");
  assert.ok(protocol.definitions.Turn.properties.itemsView);
  assert.ok(protocol.definitions.TurnItemsView.oneOf.some((v) => v.enum?.includes("notLoaded")));
  const errorInfo = protocol.definitions.CodexErrorInfo.oneOf.flatMap((variant) => [
    ...(variant.enum ?? []),
    ...(variant.required ?? []),
  ]);
  const threadItemTypes = new Set(protocol.definitions.ThreadItem.oneOf.flatMap((variant) =>
    variant.properties?.type?.enum ?? []));
  const accountTypes = new Set(protocol.definitions.Account.oneOf.flatMap((variant) =>
    variant.properties?.type?.enum ?? []));
  return {
    requests,
    checkParams,
    turnErrorCodes: new Set(errorInfo),
    threadItemTypes,
    turnStatuses: new Set(protocol.definitions.TurnStatus.enum),
    accountTypes,
  };
}

function report() {
  return {
    schemaVersion: version,
    status: "running",
    turns: [],
    child: { spawned: false, pid: null, exit: null, close: null, clientCloseCompleted: false, closeObserved: false },
    threadRead: { status: "not_attempted" },
  };
}

function exactPath(a, b) {
  const left = resolve(a);
  const right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

const childClosePromises = new WeakMap();

function observeOwnedChild(child, evidence) {
  evidence.spawned = true;
  evidence.pid = Number.isSafeInteger(child.pid) ? child.pid : null;
  let resolveClose;
  const closePromise = new Promise((resolve) => { resolveClose = resolve; });
  childClosePromises.set(evidence, closePromise);
  child.once("exit", (code, signal) => { evidence.exit = { code, signal }; });
  child.once("close", (code, signal) => {
    evidence.close = { code, signal };
    resolveClose(true);
  });
  return child;
}

function trackedSpawn(evidence, spawnImpl = spawn) {
  return (command, args, options) => {
    const env = { ...(options?.env ?? process.env) };
    for (const name of [
      "C2C_TUNNEL_RUNTIME_KEY",
      "C2C_OFFICIAL_DISPATCH_TOKEN",
      "C2C_OFFICIAL_DISPATCH_AUTHORIZATION",
      "C2C_EVENTS_TOKEN",
      "C2C_EVENTS_AUTHORIZATION",
    ]) delete env[name];
    return observeOwnedChild(spawnImpl(command, args, { ...options, env }), evidence);
  };
}

async function childCloseWaiter(evidence, timeoutMs) {
  const closePromise = childClosePromises.get(evidence);
  if (!closePromise) return false;
  let timer;
  return Promise.race([
    closePromise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

class ProbeFailure extends Error {
  constructor(reason, turnErrorCode) {
    super(reason);
    this.name = "ProbeFailure";
    this.reason = reason;
    this.turnErrorCode = turnErrorCode;
  }
}

function recordFailure(result, error, step) {
  if (result.failure) return;
  const failure = { step, category: "operation", reason: "operation_failed" };
  if (error instanceof AppServerRpcError) {
    failure.category = "json_rpc";
    failure.reason = "request_rejected";
    failure.rpcCode = error.code;
  } else if (error instanceof ProbeFailure) {
    failure.category = "probe";
    failure.reason = error.reason;
    if (error.turnErrorCode) failure.turnErrorCode = error.turnErrorCode;
  } else if (error instanceof Error && error.name === "AssertionError") {
    failure.category = "validation";
    failure.reason = "assertion_failed";
  } else if (error instanceof Error && /timed out/i.test(error.message)) {
    failure.category = "timeout";
    failure.reason = "operation_timeout";
  }
  result.status = "failed";
  result.failureStep = step;
  result.failure = failure;
}

function reply(items) {
  const messages = items.filter((item) => item.type === "agentMessage");
  assert.ok(messages.length > 0, "turn has no assistant message");
  assert.equal(typeof messages.at(-1).text, "string");
  return messages.at(-1).text;
}

function hasNoTools(items) {
  const messageTypes = new Set([
    "userMessage", "hookPrompt", "agentMessage", "plan", "reasoning",
    "contextCompaction", "enteredReviewMode", "exitedReviewMode",
  ]);
  return items.every((item) => messageTypes.has(item.type));
}

function requestGuard(client) {
  let rejectRequest;
  let unexpectedSeen = false;
  const unexpected = new Promise((_, reject) => { rejectRequest = reject; });
  unexpected.catch(() => undefined);
  const onRequest = (request) => {
    void request;
    unexpectedSeen = true;
    rejectRequest(new ProbeFailure("unexpected_server_request"));
    void client.close().catch(() => undefined);
  };
  client.on("request", onRequest);
  return {
    wait: (promise) => Promise.race([
      promise.catch((error) => {
        if (unexpectedSeen) throw new ProbeFailure("unexpected_server_request");
        throw error;
      }),
      unexpected,
    ]),
    close: () => client.off("request", onRequest),
  };
}

function watchTurn(client, threadId, knownItemTypes) {
  const itemsByTurn = new Map();
  const terminalByTurn = new Map();
  let wanted;
  let resolveWait;
  let timer;
  let duplicateItemsDropped = 0;
  let invalidEvent = false;

  const maybeResolve = () => {
    if (!wanted || !terminalByTurn.has(wanted)) return;
    resolveWait?.({
      terminal: terminalByTurn.get(wanted),
      items: [...(itemsByTurn.get(wanted)?.values() ?? [])],
      duplicateItemsDropped,
      invalidEvent,
    });
    resolveWait = undefined;
  };

  const onNotification = (event) => {
    const params = event.params;
    if (params?.threadId !== threadId) return;
    if (event.method === "item/completed") {
      const turnId = params.turnId;
      const item = params.item;
      if (typeof turnId !== "string" || turnId.length > 256 || !item || typeof item !== "object" || Array.isArray(item) ||
          typeof item.id !== "string" || item.id.length > 256 ||
          typeof item.type !== "string" || item.type.length > 80) {
        invalidEvent = true;
        if (wanted && terminalByTurn.has(wanted)) maybeResolve();
        return;
      }
      if (!itemsByTurn.has(turnId) && itemsByTurn.size >= 8) {
        invalidEvent = true;
        return;
      }
      const turnItems = itemsByTurn.get(turnId) ?? new Map();
      if (turnItems.has(item.id)) {
        duplicateItemsDropped = Math.min(duplicateItemsDropped + 1, 1000);
        return;
      }
      if (turnItems.size >= 64) {
        invalidEvent = true;
        return;
      }
      const knownType = knownItemTypes.has(item.type);
      const projected = { id: item.id, type: knownType ? item.type : "unknown" };
      if (item.type === "agentMessage") {
        if (typeof item.text !== "string" || item.text.length > 4096) {
          invalidEvent = true;
          return;
        }
        projected.text = item.text;
      }
      turnItems.set(item.id, projected);
      itemsByTurn.set(turnId, turnItems);
      maybeResolve();
      return;
    }
    if (event.method !== "turn/completed" || !params.turn || typeof params.turn.id !== "string" || params.turn.id.length > 256) return;
    const turn = params.turn;
    if (!terminalByTurn.has(turn.id) && terminalByTurn.size >= 8) {
      invalidEvent = true;
      return;
    }
    if (!terminalByTurn.has(turn.id)) {
      const codexErrorInfo = turn.error?.codexErrorInfo;
      let turnErrorCode;
      if (typeof codexErrorInfo === "string" && schemaTurnErrorCodes.has(codexErrorInfo)) {
        turnErrorCode = codexErrorInfo;
      } else if (codexErrorInfo && typeof codexErrorInfo === "object" && !Array.isArray(codexErrorInfo)) {
        const keys = Object.keys(codexErrorInfo);
        if (keys.length === 1 && schemaTurnErrorCodes.has(keys[0])) turnErrorCode = keys[0];
      }
      const view = turn.itemsView;
      terminalByTurn.set(turn.id, {
        status: schemaTurnStatuses.has(turn.status) ? turn.status : "unknown",
        itemsView: ["notLoaded", "summary", "full"].includes(view) ? view : "unknown",
        reportedItemCount: Array.isArray(turn.items) ? Math.min(turn.items.length, 1000) : 0,
        hasError: Boolean(turn.error),
        ...(turnErrorCode ? { turnErrorCode } : {}),
      });
    }
    maybeResolve();
  };
  let schemaTurnErrorCodes = new Set();
  let schemaTurnStatuses = new Set();
  client.on("notification", onNotification);
  return {
    wait(id) {
      wanted = id;
      if (terminalByTurn.has(id)) return Promise.resolve({
        terminal: terminalByTurn.get(id),
        items: [...(itemsByTurn.get(id)?.values() ?? [])],
        duplicateItemsDropped,
        invalidEvent,
      });
      return new Promise((resolve, reject) => {
        resolveWait = resolve;
        timer = setTimeout(() => reject(new ProbeFailure("turn_timeout")), turnTimeoutMs);
        maybeResolve();
      });
    },
    setTurnErrorCodes(codes) { schemaTurnErrorCodes = codes; },
    setTurnStatuses(statuses) { schemaTurnStatuses = statuses; },
    close() {
      client.off("notification", onNotification);
      if (timer) clearTimeout(timer);
      resolveWait = undefined;
    },
  };
}

async function run(client, cwd, fixturePath, expected, schema, result) {
  const guard = requestGuard(client);
  let step = "initialize";
  client.once("close", (event) => {
    result.child.clientCloseEvent = {
      code: event.code,
      signal: event.signal,
      reason: event.reason,
    };
  });
  try {
    await guard.wait(client.start());

    step = "account/read";
    schema.checkParams("account/read", {});
    const account = object(await guard.wait(client.request("account/read", {})), "account response");
    result.authType = schema.accountTypes.has(account.account?.type) ? account.account.type : "unknown";
    assert.equal(account.account?.type, "chatgpt", "CLI is not using its ChatGPT login");
    assert.equal(typeof account.requiresOpenaiAuth, "boolean", "account response omitted auth mode flag");
    result.requiresOpenaiAuth = account.requiresOpenaiAuth;

    step = "model/list";
    schema.checkParams("model/list", {});
    const models = object(await guard.wait(client.request("model/list", {})), "model response").data;
    assert.ok(Array.isArray(models), "model/list did not return data");
    result.modelCount = Math.min(models.length, 1000);
    result.defaultModelIds = models.filter((model) => model.isDefault)
      .map((model) => model.id)
      .filter((id) => typeof id === "string")
      .slice(0, 5)
      .map((id) => id.slice(0, 128));
    assert.ok(result.defaultModelIds.length, "model/list returned no default model");

    step = "thread/start";
    const threadParams = { approvalPolicy: "never", cwd, ephemeral: true, sandbox: "read-only" };
    schema.checkParams("thread/start", threadParams);
    const started = object(await guard.wait(client.request("thread/start", threadParams)), "thread response");
    const thread = object(started.thread, "started thread");
    result.threadId = thread.id;
    result.ephemeralThread = thread.ephemeral === true;
    result.approvalPolicy = started.approvalPolicy === "never" ? "never" : "unexpected";
    result.sandboxType = started.sandbox?.type === "readOnly" ? "readOnly" : "unexpected";
    assert.equal(started.approvalPolicy, "never");
    assert.equal(result.ephemeralThread, true);
    assert.equal(result.sandboxType, "readOnly");
    assert.ok(started.sandbox.networkAccess === false || started.sandbox.networkAccess === undefined);
    result.networkAccess = false; // readOnly schema default
    assert.ok(exactPath(thread.cwd, cwd), "thread cwd differs from scratch directory");
    result.effectiveModel = typeof started.model === "string" ? started.model.slice(0, 128) : null;
    result.effectiveProvider = typeof started.modelProvider === "string" ? started.modelProvider.slice(0, 80) : null;

    const prompts = [
      "Read the one fixture file at " + JSON.stringify(fixturePath) +
        " with one read-only file read. Do not list directories or inspect any other path. " +
        "Return its one-line content verbatim and nothing else.",
      "Using only the previous turn's conversation context, repeat the exact one-line string you read. " +
        "Do not access files, list directories, run commands, or use network. Return only that string.",
    ];
    for (let i = 0; i < prompts.length; i += 1) {
      step = i === 0 ? "turn/start:first" : "turn/start:second";
      const turnParams = {
        approvalPolicy: "never",
        cwd,
        input: [{ type: "text", text: prompts[i] }],
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        threadId: result.threadId,
      };
      schema.checkParams("turn/start", turnParams);
      const watcher = watchTurn(client, result.threadId, schema.threadItemTypes);
      watcher.setTurnErrorCodes(schema.turnErrorCodes);
      watcher.setTurnStatuses(schema.turnStatuses);
      try {
        const response = object(await guard.wait(client.request("turn/start", turnParams)), "turn response");
        const turnId = response.turn?.id;
        assert.equal(typeof turnId, "string");
        const evidence = { turnId, status: "started", exactReplyMatch: false, itemStreamCount: 0 };
        result.turns.push(evidence);
        const streamed = await guard.wait(watcher.wait(turnId));
        const { terminal, items } = streamed;
        evidence.status = terminal.status;
        evidence.terminalItemsView = terminal.itemsView;
        evidence.terminalReportedItemCount = terminal.reportedItemCount;
        evidence.terminalHasError = terminal.hasError;
        if (terminal.turnErrorCode) evidence.turnErrorCode = terminal.turnErrorCode;
        evidence.itemStreamCount = items.length;
        evidence.duplicateItemEventsDropped = streamed.duplicateItemsDropped;
        evidence.itemTypes = [...new Set(items.map((item) => item.type))].slice(0, 16);
        evidence.agentMessageCount = items.filter((item) => item.type === "agentMessage").length;
        evidence.replyCharacters = items.filter((item) => item.type === "agentMessage").at(-1)?.text.length ?? 0;
        if (streamed.invalidEvent) throw new ProbeFailure("item_event_limit_exceeded");
        if (terminal.status !== "completed") throw new ProbeFailure("turn_not_completed", terminal.turnErrorCode);
        evidence.exactReplyMatch = reply(items) === expected;
        assert.equal(evidence.exactReplyMatch, true, "reply did not exactly match fixture");
        if (i === 1) {
          evidence.noToolActions = hasNoTools(items);
          assert.equal(evidence.noToolActions, true, "second turn used a tool");
        }
      } finally {
        watcher.close();
      }
    }

    step = "thread/read";
    try {
      const readParams = { includeTurns: true, threadId: result.threadId };
      schema.checkParams("thread/read", readParams);
      const read = object(await guard.wait(client.request("thread/read", readParams)), "thread/read response");
      const history = object(read.thread, "thread/read thread");
      const turns = Array.isArray(history.turns) ? history.turns : [];
      const matches = history.id === result.threadId && turns.length === 2 && turns.every((turn, index) =>
        turn.id === result.turns[index].turnId && turn.status === "completed" &&
        reply(turn.items ?? []) === expected && (index !== 1 || hasNoTools(turn.items ?? [])));
      result.threadRead = {
        status: matches ? "available" : "unavailable",
        ...(matches ? {} : { reason: turns.length === 0 ? "empty_history" : "history_did_not_match_stream" }),
        returnedTurns: Math.min(turns.length, 1000),
        ephemeral: history.ephemeral === true,
        ephemeralMayNotPersistHistory: history.ephemeral === true,
        matchesStreamHistory: matches,
      };
    } catch (error) {
      if (error instanceof ProbeFailure && error.reason === "unexpected_server_request") throw error;
      result.threadRead = {
        status: "unavailable",
        reason: error instanceof AppServerRpcError ? "request_rejected" : "history_read_failed",
        ...(error instanceof AppServerRpcError ? { rpcCode: error.code } : {}),
        ephemeral: true,
        ephemeralMayNotPersistHistory: true,
      };
    }
    result.status = "completed";
  } catch (error) {
    recordFailure(result, error, step);
  } finally {
    guard.close();
    try {
      await client.close();
      result.child.clientCloseCompleted = true;
    } catch (error) {
      recordFailure(result, error, "child-close");
    }
    try {
      result.child.closeObserved = result.child.spawned && !result.child.close
        ? await childCloseWaiter(result.child, 1_000)
        : Boolean(result.child.close);
    } catch {
      result.child.closeObserved = false;
    }
  }
  if (result.status !== "completed") throw new ProbeFailure("probe_failed");
}

function verifyCli() {
  const env = { ...process.env };
  for (const name of [
    "C2C_TUNNEL_RUNTIME_KEY",
    "C2C_OFFICIAL_DISPATCH_TOKEN",
    "C2C_OFFICIAL_DISPATCH_AUTHORIZATION",
    "C2C_EVENTS_TOKEN",
    "C2C_EVENTS_AUTHORIZATION",
  ]) delete env[name];
  const output = spawnSync(codexExe, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    env,
  });
  assert.ok(!output.error && output.status === 0, "Codex CLI unavailable");
  assert.ok((output.stdout + output.stderr).includes("codex-cli " + version), "CLI/schema version mismatch");
}

async function live(schema, { announce = true } = {}) {
  const result = report();
  let step = "cli-version";
  let scratchDir;
  let fixturePath;
  try {
    verifyCli();
    step = "scratch-fixture";
    scratchDir = await mkdtemp(join(tmpdir(), "c2c-official-dispatch-"));
    fixturePath = join(scratchDir, "scratchfixture.txt");
    const fixtureValue = "fixture-" + randomUUID();
    await writeFile(fixturePath, fixtureValue + "\n", { flag: "wx", mode: 0o600 });
    step = "protocol";
    const client = new AppServerClient({
      executable: codexExe,
      cwd: scratchDir,
      startupTimeoutMs: 15_000,
      requestTimeoutMs: turnTimeoutMs,
      closeTimeoutMs: 5_000,
      spawnImpl: trackedSpawn(result.child),
    });
    await run(client, scratchDir, fixturePath, fixtureValue, schema, result);
  } catch (error) {
    recordFailure(result, error, step);
  } finally {
    if (scratchDir) {
      try {
        if (fixturePath) await unlink(fixturePath);
        await rmdir(scratchDir);
        result.scratchCleanupCompleted = true;
      } catch {
        result.scratchCleanupCompleted = false;
        if (result.status === "completed") {
          recordFailure(result, new ProbeFailure("scratch_cleanup_failed"), "scratch-cleanup");
        }
      }
    }
    const evidenceFile = join(evidenceDir, "run-" + randomUUID() + ".json");
    const persisted = announce ? result : publicReport(result);
    await writeFile(evidenceFile, JSON.stringify(persisted, null, 2) + "\n", { flag: "wx" });
    if (announce) console.log(JSON.stringify({ evidenceFile, ...result }, null, 2));
  }
  if (result.status !== "completed") {
    const error = new ProbeFailure("probe_failed");
    error.report = result;
    throw error;
  }
  return result;
}

export function publicReport(result) {
  const turns = (Array.isArray(result?.turns) ? result.turns : []).map((turn) => ({
    turnId: turn.turnId,
    status: turn.status,
    exactReplyMatch: turn.exactReplyMatch,
    ...(typeof turn.noToolActions === "boolean" ? { noToolActions: turn.noToolActions } : {}),
  })).slice(0, 2);
  const threadRead = {
    status: result.threadRead?.status === "available" ? "available" : "unavailable",
    ...(typeof result.threadRead?.reason === "string" ? { reason: result.threadRead.reason.slice(0, 80) } : {}),
    ...(Number.isSafeInteger(result.threadRead?.rpcCode) ? { rpcCode: result.threadRead.rpcCode } : {}),
    ...(typeof result.threadRead?.matchesStreamHistory === "boolean"
      ? { matchesStreamHistory: result.threadRead.matchesStreamHistory }
      : {}),
  };
  const failure = result.failure && typeof result.failure === "object" ? {
    ...(typeof result.failure.step === "string" ? { step: result.failure.step.slice(0, 80) } : {}),
    ...(typeof result.failure.category === "string" ? { category: result.failure.category.slice(0, 40) } : {}),
    ...(typeof result.failure.reason === "string" ? { reason: result.failure.reason.slice(0, 80) } : {}),
    ...(Number.isSafeInteger(result.failure.rpcCode) ? { rpcCode: result.failure.rpcCode } : {}),
    ...(typeof result.failure.turnErrorCode === "string" ? { turnErrorCode: result.failure.turnErrorCode.slice(0, 80) } : {}),
  } : undefined;
  return {
    status: result?.status === "completed" ? "completed" : "failed",
    authType: result?.authType === "chatgpt" ? "chatgpt" : "unknown",
    requiresOpenaiAuth: typeof result?.requiresOpenaiAuth === "boolean" ? result.requiresOpenaiAuth : null,
    ...(typeof result?.threadId === "string" ? { threadId: result.threadId.slice(0, 256) } : {}),
    turns,
    threadRead,
    childCleanup: {
      spawned: typeof result?.child?.spawned === "boolean" ? result.child.spawned : null,
      clientCloseCompleted: result?.child?.clientCloseCompleted === true,
      closeObserved: result?.child?.closeObserved === true,
    },
    scratchCleanupCompleted: result?.scratchCleanupCompleted === true,
    ...(failure ? { failure } : {}),
  };
}

export async function runOfficialDispatchProbeRaw() {
  const failed = report();
  let schema;
  try {
    schema = schemaCheck();
  } catch (error) {
    recordFailure(failed, error, "schema");
    return failed;
  }
  try {
    return await live(schema, { announce: false });
  } catch (error) {
    if (error instanceof ProbeFailure && error.report) return error.report;
    const unknown = report();
    unknown.child.spawned = null;
    unknown.child.clientCloseCompleted = false;
    unknown.child.closeObserved = false;
    recordFailure(unknown, error, "probe");
    return unknown;
  }
}

class FakeProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  calls = [];
  turns = [];
  killed = false;
  buffer = "";
  turnNumber = 0;
  pid = 42;

  constructor(cwd, fixturePath, fixtureValue, options = {}) {
    super();
    Object.assign(this, { cwd, fixturePath, fixtureValue, sendApproval: false, threadReadMode: "empty", ...options });
    this.stdin.on("data", (chunk) => {
      this.buffer += String(chunk);
      for (;;) {
        const n = this.buffer.indexOf("\n");
        if (n < 0) break;
        const line = this.buffer.slice(0, n);
        this.buffer = this.buffer.slice(n + 1);
        this.receive(JSON.parse(line));
      }
    });
  }

  kill() {
    if (this.killed) return true;
    this.killed = true;
    this.stdin.destroy();
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
    return true;
  }

  send(value) {
    this.stdout.write(JSON.stringify(value) + "\n");
  }

  respond(id, result) {
    this.send({ jsonrpc: "2.0", id, result });
  }

  receive(message) {
    const { method, params } = message;
    if (typeof method !== "string") {
      this.calls.push("response:" + String(message.id));
      return;
    }
    if (method !== "initialized") this.calls.push(method);
    if (method === "initialize") {
      this.respond(message.id, { userAgent: "fake", codexHome: "C:/fake", platformFamily: "windows", platformOs: "windows" });
    } else if (method === "account/read") {
      if (this.sendApproval) {
        this.send({ jsonrpc: "2.0", id: "fake-approval", method: "item/commandExecution/requestApproval", params: {} });
      } else {
        this.respond(message.id, {
          account: { type: "chatgpt", email: "fake-secret@example.invalid" },
          requiresOpenaiAuth: true,
        });
      }
    } else if (method === "model/list") {
      this.respond(message.id, { data: [{ id: "fake-default", isDefault: true }], nextCursor: null });
    } else if (method === "thread/start") {
      assert.equal(params.sandbox, "read-only");
      assert.equal(params.approvalPolicy, "never");
      assert.equal(params.ephemeral, true);
      assert.ok(!("model" in params) && !("modelProvider" in params));
      this.respond(message.id, {
        approvalPolicy: "never",
        cwd: this.cwd,
        model: "fake-default",
        modelProvider: "openai",
        sandbox: { type: "readOnly", networkAccess: false },
        thread: { id: "fake-thread", cwd: this.cwd, ephemeral: true, turns: [] },
      });
    } else if (method === "turn/start") {
      assert.equal(params.approvalPolicy, "never");
      assert.deepEqual(params.sandboxPolicy, { type: "readOnly", networkAccess: false });
      assert.ok(!("model" in params) && !("modelProvider" in params));
      this.turnNumber += 1;
      const id = "fake-turn-" + this.turnNumber;
      const prompt = params.input[0].text;
      assert.ok(!prompt.includes(this.fixtureValue));
      const items = [
        { id: "user-" + this.turnNumber, type: "userMessage", content: [] },
        ...(this.turnNumber === 1 ? [{
          id: "fixture-read",
          type: "commandExecution",
          command: "Get-Content " + this.fixturePath,
          commandActions: [],
          cwd: this.cwd,
          status: "completed",
          aggregatedOutput: this.fixtureValue,
        }] : []),
        { id: "assistant-" + this.turnNumber, type: "agentMessage", text: this.fixtureValue },
      ];
      const turn = { id, items, status: "completed" };
      this.turns.push(turn);
      for (const item of items) {
        const notification = {
          jsonrpc: "2.0",
          method: "item/completed",
          params: { completedAtMs: Date.now(), item, threadId: "fake-thread", turnId: id },
        };
        this.send(notification);
        if (item.type === "agentMessage") this.send(notification);
      }
      this.send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { threadId: "fake-thread", turn: { ...turn, items: [], itemsView: "notLoaded" } },
      });
      this.respond(message.id, { turn: { id, items: [], status: "inProgress" } });
    } else if (method === "thread/read") {
      assert.equal(params.includeTurns, true);
      if (this.threadReadMode === "rpc-error") {
        this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      } else {
        this.respond(message.id, { thread: { id: "fake-thread", ephemeral: true, turns: [] } });
      }
    } else if (method !== "initialized") {
      throw new Error("unexpected fake request");
    }
  }
}

function fakeClient(fake, cwd, result) {
  return new AppServerClient({
    executable: "fake-codex",
    cwd,
    requestTimeoutMs: 2_000,
    closeTimeoutMs: 2_000,
    spawnImpl: () => observeOwnedChild(fake, result.child),
  });
}

async function selfTest(schema) {
  const cwd = resolve(tmpdir(), "codex-official-dispatch-fake");
  const fixturePath = join(cwd, "scratchfixture.txt");
  const value = "fixture-" + randomUUID();
  const fake = new FakeProcess(cwd, fixturePath, value);
  const success = report();
  try {
    await run(fakeClient(fake, cwd, success), cwd, fixturePath, value, schema, success);
  } catch {
    console.error(JSON.stringify({ failure: success.failure, turns: success.turns, child: success.child }));
    throw new ProbeFailure("self_test_run_failed");
  }
  assert.deepEqual(success.turns.map((turn) => turn.turnId), ["fake-turn-1", "fake-turn-2"]);
  assert.equal(success.requiresOpenaiAuth, true);
  assert.equal(success.turns[0].terminalItemsView, "notLoaded");
  assert.equal(success.turns[0].terminalReportedItemCount, 0);
  assert.equal(success.turns[0].itemStreamCount, 3);
  assert.equal(success.turns[0].duplicateItemEventsDropped, 1);
  assert.equal(success.turns[1].noToolActions, true);
  assert.equal(success.threadRead.status, "unavailable");
  assert.equal(success.threadRead.reason, "empty_history");
  assert.equal(success.threadRead.ephemeralMayNotPersistHistory, true);
  assert.equal(fake.killed, true);
  assert.equal(success.child.pid, 42);
  assert.deepEqual(success.child.exit, { code: 0, signal: null });
  assert.deepEqual(success.child.close, { code: 0, signal: null });
  assert.equal(success.child.clientCloseCompleted, true);
  assert.equal(success.child.closeObserved, true);
  assert.deepEqual(fake.calls, ["initialize", "account/read", "model/list", "thread/start", "turn/start", "turn/start", "thread/read"]);
  assert.ok(!JSON.stringify(success).includes("fake-secret@example.invalid"));
  assert.ok(!JSON.stringify(success).includes(value));

  const unsupportedReadFake = new FakeProcess(cwd, fixturePath, value, { threadReadMode: "rpc-error" });
  const unsupportedRead = report();
  await run(fakeClient(unsupportedReadFake, cwd, unsupportedRead), cwd, fixturePath, value, schema, unsupportedRead);
  assert.equal(unsupportedRead.status, "completed");
  assert.equal(unsupportedRead.threadRead.status, "unavailable");
  assert.equal(unsupportedRead.threadRead.reason, "request_rejected");
  assert.equal(unsupportedRead.threadRead.rpcCode, -32601);
  assert.ok(!JSON.stringify(unsupportedRead).includes("fake-secret@example.invalid"));

  const approvalFake = new FakeProcess(cwd, fixturePath, value, { sendApproval: true });
  const denied = report();
  await assert.rejects(run(fakeClient(approvalFake, cwd, denied), cwd, fixturePath, value, schema, denied), /probe_failed/);
  assert.equal(denied.failureStep, "account/read");
  assert.equal(denied.failure.reason, "unexpected_server_request");
  assert.equal(approvalFake.killed, true);
  assert.ok(!approvalFake.calls.includes("thread/start"));
  assert.ok(!approvalFake.calls.includes("response:fake-approval"));

  const childEvidence = report().child;
  const capturedChild = new EventEmitter();
  capturedChild.pid = 43;
  let capturedOptions;
  trackedSpawn(childEvidence, (_command, _args, options) => {
    capturedOptions = options;
    return capturedChild;
  })("fake-codex", [], { env: {
    C2C_TUNNEL_RUNTIME_KEY: "runtime-secret",
    C2C_OFFICIAL_DISPATCH_TOKEN: "bearer-secret",
    C2C_OFFICIAL_DISPATCH_AUTHORIZATION: "dispatch-header-secret",
    C2C_EVENTS_TOKEN: "events-secret",
    C2C_EVENTS_AUTHORIZATION: "events-header-secret",
    PRESERVED_TEST_VALUE: "yes",
  } });
  assert.equal(capturedOptions.env.C2C_TUNNEL_RUNTIME_KEY, undefined);
  assert.equal(capturedOptions.env.C2C_OFFICIAL_DISPATCH_TOKEN, undefined);
  assert.equal(capturedOptions.env.C2C_OFFICIAL_DISPATCH_AUTHORIZATION, undefined);
  assert.equal(capturedOptions.env.C2C_EVENTS_TOKEN, undefined);
  assert.equal(capturedOptions.env.C2C_EVENTS_AUTHORIZATION, undefined);
  assert.equal(capturedOptions.env.PRESERVED_TEST_VALUE, "yes");
  capturedChild.emit("exit", 0, null);
  capturedChild.emit("close", 0, null);
}

async function main() {
  const mode = process.argv[2];
  assert.ok(mode === "--self-test" || mode === "--live", "use --self-test or --live");
  const schema = schemaCheck();
  if (mode === "--self-test") {
    await selfTest(schema);
    console.log("official-dispatch schema and fake RPC checks passed; no live turn started");
  } else {
    await live(schema);
  }
}

function safeStopReason(error) {
  if (error instanceof ProbeFailure) return error.reason;
  if (error instanceof AppServerRpcError) return "request_rejected";
  if (error instanceof Error && error.name === "AssertionError") return "validation_failed";
  return "operation_failed";
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error("official-dispatch probe stopped safely: " + safeStopReason(error));
    process.exitCode = 1;
  });
}

export { ProbeFailure, childCloseWaiter, hasNoTools, reply, requestGuard, schemaCheck, trackedSpawn, verifyCli, watchTurn };
