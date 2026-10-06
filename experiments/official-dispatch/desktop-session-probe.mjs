import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AppServerClient, AppServerRpcError } from "../../src/remote/app-server.js";
import { ProbeFailure, childCloseWaiter, hasNoTools, reply, requestGuard, schemaCheck, trackedSpawn, verifyCli, watchTurn } from "./probe.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidenceDir = join(repo, ".tooling", "official-dispatch-20261005");
const codexExe = process.env.CODEX_APP_SERVER_EXECUTABLE ??
  join(process.env.LOCALAPPDATA ?? "", "OpenAI", "Codex", "bin", "8aaf1547b825b104", "codex.exe");
const turnTimeoutMs = 120_000;

const object = (value, label) => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label + " must be an object");
  return value;
};

function sourceLabel(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : "unknown";
}

function exactPath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function createRun() {
  const runId = randomUUID();
  const marker = "C2C_DESKTOP_VISIBLE_" + randomBytes(8).toString("hex");
  const title = "官方投递桌面接管测试 " + runId.replaceAll("-", "").slice(0, 8);
  return {
    runId,
    marker,
    title,
    prompt: "这是隔离连通性测试。不要运行任何工具，不要读取或写入文件，不要执行其他任务。请仅回复以下随机码，原样输出且不带其他文字：" + marker,
    status: "running",
    source: "unknown",
    threadId: null,
    turnId: null,
    checks: {
      chatgptAccount: false,
      persistentThread: false,
      approvalNever: false,
      readOnlySandbox: false,
      networkDisabled: false,
      turnCompleted: false,
      exactMarker: false,
      noToolActions: false,
    },
    turn: null,
    threadRead: { status: "not_attempted" },
    child: {
      spawned: false,
      pid: null,
      exit: null,
      close: null,
      clientCloseCompleted: false,
      exitObserved: false,
      closeObserved: false,
    },
  };
}

function failureProjection(error, step) {
  const failure = { step, category: "operation", reason: "operation_failed" };
  if (error instanceof AppServerRpcError) {
    failure.category = "json_rpc";
    failure.reason = "request_rejected";
    failure.rpcCode = error.code;
  } else if (error instanceof ProbeFailure) {
    failure.category = "probe";
    failure.reason = error.reason;
    if (typeof error.turnErrorCode === "string") failure.turnErrorCode = error.turnErrorCode.slice(0, 80);
  } else if (error instanceof Error && error.name === "AssertionError") {
    failure.category = "validation";
    failure.reason = "assertion_failed";
  } else if (error instanceof Error && /timed out/i.test(error.message)) {
    failure.category = "timeout";
    failure.reason = "operation_timeout";
  }
  return failure;
}

function exactUserPrompt(turn, expected) {
  return (Array.isArray(turn?.items) ? turn.items : []).some((item) => item?.type === "userMessage" &&
    Array.isArray(item.content) && item.content.some((part) =>
      part?.type === "text" && typeof part.text === "string" && part.text === expected));
}

function projectHistory(read, run, sourceAtStart) {
  const thread = object(read.thread, "thread/read thread");
  const turns = Array.isArray(thread.turns) ? thread.turns.slice(0, 16) : [];
  const turn = turns.find((item) => item?.id === run.turnId);
  const items = Array.isArray(turn?.items) ? turn.items.slice(0, 64) : [];
  let exactReply = false;
  try {
    exactReply = reply(items) === run.marker;
  } catch {
    exactReply = false;
  }
  const checks = {
    threadId: thread.id === run.threadId,
    persistent: thread.ephemeral === false,
    title: thread.name === run.title,
    source: sourceAtStart !== "unknown" && sourceLabel(thread.source) === sourceAtStart,
    turnFound: Boolean(turn),
    turnCompleted: turn?.status === "completed",
    userPrompt: exactUserPrompt(turn, run.prompt),
    exactMarker: exactReply,
    noToolActions: turn ? hasNoTools(items) : false,
  };
  return {
    status: Object.values(checks).every(Boolean) ? "matched" : "mismatch",
    checks,
  };
}

async function executeCreate(client, schema, result, cwd) {
  const guard = requestGuard(client);
  let step = "initialize";
  client.once("close", (event) => {
    result.child.clientCloseEvent = { code: event.code, signal: event.signal, reason: event.reason };
  });
  try {
    await guard.wait(client.start());

    step = "account/read";
    schema.checkParams("account/read", {});
    const account = object(await guard.wait(client.request("account/read", {})), "account response");
    result.checks.chatgptAccount = account.account?.type === "chatgpt";
    assert.equal(result.checks.chatgptAccount, true, "CLI is not using its ChatGPT login");

    step = "thread/start";
    const threadParams = { approvalPolicy: "never", cwd, ephemeral: false, sandbox: "read-only" };
    schema.checkParams("thread/start", threadParams);
    assert.equal(Object.hasOwn(threadParams, "threadSource"), false);
    const started = object(await guard.wait(client.request("thread/start", threadParams)), "thread response");
    const thread = object(started.thread, "started thread");
    assert.equal(typeof thread.id, "string");
    assert.ok(thread.id.length > 0 && thread.id.length <= 256);
    result.threadId = thread.id;
    result.source = sourceLabel(thread.source);
    result.checks.persistentThread = thread.ephemeral === false && exactPath(thread.cwd, cwd);
    result.checks.approvalNever = started.approvalPolicy === "never";
    result.checks.readOnlySandbox = started.sandbox?.type === "readOnly";
    result.checks.networkDisabled = started.sandbox?.networkAccess === false || started.sandbox?.networkAccess === undefined;
    assert.equal(result.checks.persistentThread, true, "thread is not persistent or cwd mismatched");
    assert.equal(result.checks.approvalNever, true);
    assert.equal(result.checks.readOnlySandbox, true);
    assert.equal(result.checks.networkDisabled, true);

    step = "thread/name/set";
    const nameParams = { name: result.title, threadId: result.threadId };
    schema.checkParams("thread/name/set", nameParams);
    await guard.wait(client.request("thread/name/set", nameParams));

    step = "turn/start";
    const watcher = watchTurn(client, result.threadId, schema.threadItemTypes);
    watcher.setTurnErrorCodes(schema.turnErrorCodes);
    watcher.setTurnStatuses(schema.turnStatuses);
    try {
      const turnParams = {
        approvalPolicy: "never",
        cwd,
        input: [{ type: "text", text: result.prompt }],
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        threadId: result.threadId,
      };
      schema.checkParams("turn/start", turnParams);
      assert.equal(Object.hasOwn(turnParams, "model"), false);
      assert.equal(Object.hasOwn(turnParams, "modelProvider"), false);
      const response = object(await guard.wait(client.request("turn/start", turnParams)), "turn response");
      assert.equal(typeof response.turn?.id, "string");
      result.turnId = response.turn.id;
      const streamed = await guard.wait(watcher.wait(result.turnId));
      const terminal = streamed.terminal;
      const exactMarker = terminal.status === "completed" && reply(streamed.items) === result.marker;
      const noToolActions = hasNoTools(streamed.items);
      result.checks.turnCompleted = terminal.status === "completed";
      result.checks.exactMarker = exactMarker;
      result.checks.noToolActions = noToolActions;
      result.turn = {
        status: terminal.status,
        exactMarker,
        noToolActions,
        itemCount: streamed.items.length,
        duplicateItemEventsDropped: streamed.duplicateItemsDropped,
        invalidEvent: streamed.invalidEvent,
        ...(terminal.turnErrorCode ? { turnErrorCode: terminal.turnErrorCode } : {}),
      };
      if (streamed.invalidEvent) throw new ProbeFailure("item_event_limit_exceeded");
      assert.equal(result.checks.turnCompleted, true, "turn did not complete");
      assert.equal(result.checks.exactMarker, true, "reply did not exactly match marker");
      assert.equal(result.checks.noToolActions, true, "turn used a tool action");
    } finally {
      watcher.close();
    }

    step = "thread/read";
    try {
      const readParams = { includeTurns: true, threadId: result.threadId };
      schema.checkParams("thread/read", readParams);
      result.threadRead = projectHistory(
        object(await guard.wait(client.request("thread/read", readParams)), "thread/read response"),
        result,
        result.source,
      );
    } catch (error) {
      if (error instanceof ProbeFailure && error.reason === "unexpected_server_request") throw error;
      result.threadRead = {
        status: "unavailable",
        reason: error instanceof AppServerRpcError ? "request_rejected" : "history_read_failed",
        ...(error instanceof AppServerRpcError ? { rpcCode: error.code } : {}),
      };
    }
    result.status = "completed";
  } catch (error) {
    result.status = "failed";
    result.failure = failureProjection(error, step);
  } finally {
    guard.close();
    try {
      await client.close();
      result.child.clientCloseCompleted = true;
    } catch {
      result.child.closeFailure = "client_close_failed";
    }
    result.child.closeObserved = await childCloseWaiter(result.child, 1_000);
    result.child.exitObserved = Boolean(result.child.exit);
  }
  return result;
}

async function createLive() {
  const schema = schemaCheck();
  verifyCli();
  const result = createRun();
  const client = new AppServerClient({
    executable: codexExe,
    cwd: repo,
    startupTimeoutMs: 15_000,
    requestTimeoutMs: turnTimeoutMs,
    closeTimeoutMs: 5_000,
    spawnImpl: trackedSpawn(result.child),
  });
  await executeCreate(client, schema, result, repo);
  await mkdir(evidenceDir, { recursive: true });
  const filename = "desktop-session-run-" + result.runId + ".json";
  await writeFile(join(evidenceDir, filename), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ evidenceFile: ".tooling/official-dispatch-20261005/" + filename, ...result }, null, 2));
  if (result.status !== "completed" || !result.child.clientCloseCompleted || !result.child.exitObserved || !result.child.closeObserved) {
    process.exitCode = 1;
  }
}

class FakeProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  calls = [];
  killed = false;
  buffer = "";
  turns = [];
  childEvents = [];

  constructor(cwd, marker, options = {}) {
    super();
    Object.assign(this, { cwd, marker, replyMarker: marker, failThreadRead: false, threadSource: "fake-app-server", email: "private@example.invalid", ...options });
    this.pid = 42;
    this.stdin.on("data", (chunk) => {
      this.buffer += String(chunk);
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const message = JSON.parse(this.buffer.slice(0, newline));
        this.buffer = this.buffer.slice(newline + 1);
        this.receive(message);
      }
    });
  }

  send(value) {
    this.stdout.write(JSON.stringify(value) + "\n");
  }

  respond(id, result) {
    this.send({ jsonrpc: "2.0", id, result });
  }

  receive(message) {
    const { method, params } = message;
    if (method === "initialized") return;
    this.calls.push(method);
    if (method === "initialize") {
      this.respond(message.id, { userAgent: "fake", codexHome: "C:/fake", platformFamily: "windows", platformOs: "windows" });
    } else if (method === "account/read") {
      this.respond(message.id, { account: { type: "chatgpt", email: this.email }, requiresOpenaiAuth: true });
    } else if (method === "thread/start") {
      assert.equal(params.ephemeral, false);
      assert.equal(params.approvalPolicy, "never");
      assert.equal(params.sandbox, "read-only");
      assert.equal(exactPath(params.cwd, this.cwd), true);
      assert.equal(Object.hasOwn(params, "threadSource"), false);
      assert.equal(Object.hasOwn(params, "model"), false);
      assert.equal(Object.hasOwn(params, "modelProvider"), false);
      this.respond(message.id, {
        approvalPolicy: "never",
        sandbox: { type: "readOnly", networkAccess: false },
        thread: { id: "fake-persistent-thread", cwd: this.cwd, ephemeral: false, source: this.threadSource },
      });
    } else if (method === "thread/name/set") {
      assert.equal(params.threadId, "fake-persistent-thread");
      assert.match(params.name, /^官方投递桌面接管测试 [a-f0-9]{8}$/);
      this.title = params.name;
      this.respond(message.id, {});
    } else if (method === "turn/start") {
      assert.equal(params.threadId, "fake-persistent-thread");
      assert.equal(params.approvalPolicy, "never");
      assert.deepEqual(params.sandboxPolicy, { type: "readOnly", networkAccess: false });
      assert.equal(Object.hasOwn(params, "model"), false);
      assert.equal(Object.hasOwn(params, "modelProvider"), false);
      this.prompt = params.input[0].text;
      assert.ok(this.prompt.includes(this.marker));
      const turnId = "fake-persistent-turn";
      const items = [
        { id: "fake-user", type: "userMessage", content: [{ type: "text", text: this.prompt }] },
        { id: "fake-agent", type: "agentMessage", text: this.replyMarker },
      ];
      this.turns.push({ id: turnId, status: "completed", items, itemsView: "full" });
      for (const item of items) {
        this.send({ jsonrpc: "2.0", method: "item/completed", params: { completedAtMs: Date.now(), item, threadId: "fake-persistent-thread", turnId } });
      }
      this.send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "fake-persistent-thread", turn: { id: turnId, status: "completed", items: [], itemsView: "notLoaded" } } });
      this.respond(message.id, { turn: { id: turnId, status: "inProgress" } });
    } else if (method === "thread/read") {
      assert.equal(params.threadId, "fake-persistent-thread");
      assert.equal(params.includeTurns, true);
      if (this.failThreadRead) {
        this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      } else {
        this.respond(message.id, {
          thread: {
            id: "fake-persistent-thread",
            ephemeral: false,
            name: this.title,
            source: this.threadSource,
            turns: this.turns,
            preview: "do not persist this preview",
            path: "C:/private/session.jsonl",
          },
        });
      }
    } else {
      throw new Error("unexpected fake request");
    }
  }

  kill() {
    if (this.killed) return true;
    this.killed = true;
    this.stdin.destroy();
    this.childEvents.push("exit");
    this.emit("exit", 0, null);
    setTimeout(() => {
      this.childEvents.push("close");
      this.emit("close", 0, null);
    }, 20);
    return true;
  }
}

async function fakeRun(schema, cwd, options = {}) {
  const result = createRun();
  const fake = new FakeProcess(cwd, result.marker, options);
  const client = new AppServerClient({
    executable: "fake-codex",
    cwd,
    requestTimeoutMs: 2_000,
    closeTimeoutMs: 2_000,
    spawnImpl: trackedSpawn(result.child, () => fake),
  });
  await executeCreate(client, schema, result, cwd);
  return { result, fake };
}

async function selfTest() {
  const schema = schemaCheck();
  const cwd = resolve(tmpdir(), "codex-desktop-session-probe-fake");
  const success = await fakeRun(schema, cwd);
  assert.equal(success.result.status, "completed");
  assert.match(success.result.marker, /^C2C_DESKTOP_VISIBLE_[0-9a-f]{16}$/);
  assert.equal(success.result.title, "官方投递桌面接管测试 " + success.result.runId.replaceAll("-", "").slice(0, 8));
  assert.equal(success.result.source, "fake-app-server");
  assert.equal(success.result.checks.persistentThread, true);
  assert.equal(success.result.checks.exactMarker, true);
  assert.equal(success.result.checks.noToolActions, true);
  assert.equal(success.result.threadRead.status, "matched");
  assert.equal(success.result.child.clientCloseCompleted, true);
  assert.equal(success.result.child.exitObserved, true);
  assert.equal(success.result.child.closeObserved, true);
  assert.deepEqual(success.fake.childEvents, ["exit", "close"]);
  assert.deepEqual(success.fake.calls, ["initialize", "account/read", "thread/start", "thread/name/set", "turn/start", "thread/read"]);
  assert.ok(!JSON.stringify(success.result).includes("private@example.invalid"));
  assert.ok(!JSON.stringify(success.result).includes("private/session.jsonl"));
  assert.ok(!success.fake.calls.some((method) => ["thread/resume", "turn/steer", "thread/archive", "thread/delete"].includes(method)));

  const wrongMarker = await fakeRun(schema, cwd, { replyMarker: "C2C_DESKTOP_VISIBLE_wrong" });
  assert.equal(wrongMarker.result.status, "failed");
  assert.equal(wrongMarker.result.checks.exactMarker, false);
  assert.equal(wrongMarker.result.threadId, "fake-persistent-thread");
  assert.equal(wrongMarker.result.child.exitObserved, true);
  assert.equal(wrongMarker.result.child.closeObserved, true);

  const readUnavailable = await fakeRun(schema, cwd, { failThreadRead: true });
  assert.equal(readUnavailable.result.status, "completed");
  assert.equal(readUnavailable.result.checks.exactMarker, true);
  assert.equal(readUnavailable.result.threadRead.status, "unavailable");
  assert.equal(readUnavailable.result.threadRead.rpcCode, -32601);
  assert.equal(readUnavailable.result.child.exitObserved, true);
  assert.equal(readUnavailable.result.child.closeObserved, true);
  console.log("desktop session schema/fake RPC checks passed; no persistent real thread created");
}

async function main() {
  const args = process.argv.slice(2);
  assert.deepEqual(args.length, 1, "use --self-test or --create");
  if (args[0] === "--self-test") return selfTest();
  assert.equal(args[0], "--create", "use --self-test or --create");
  return createLive();
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    const safeReason = error instanceof ProbeFailure ? error.reason :
      error instanceof AppServerRpcError ? "request_rejected" : "validation_failed";
    console.error("desktop session probe stopped safely: " + safeReason);
    process.exitCode = 1;
  });
}
