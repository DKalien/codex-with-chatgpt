import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AuthStore, DESKTOP_CONTROL_SCOPE, DESKTOP_READ_SCOPE, EXECUTOR_CONTROL_SCOPE } from "../src/auth/store.js";
import { desktopIpc } from "../src/desktop/ipc.js";
import { DesktopError, readDesktop, updateDesktop } from "../src/desktop/store.js";
import { bindDesktop, enableDesktop } from "../src/desktop/service.js";
import type { ExecutorAdapter, ExecutorTarget } from "../src/executor/index.js";
import { bindCurrentExecutor } from "../src/executor-control/service.js";
import { beginExecutorDispatch, hashRequestAuthority, releaseUnsentExecutorPin } from "../src/executor-control/dispatch-service.js";
import { executorDispatchFile, readExecutorDispatchState } from "../src/executor-control/dispatch-store.js";
import { registerDesktopTools } from "../src/mcp/desktop.js";
import { registerExecutorTools } from "../src/mcp/executor-tools.js";
import { resolveConversationPrincipal } from "../src/mcp/conversation-principal.js";
import { createCommandMailbox } from "../src/routing/mailbox.js";
import { cancelPendingCommand, listCommands, listResults, routingFile, setCommandMailbox } from "../src/routing/store.js";
import { cleanupJournalFile } from "../src/command-cleanup/fence.js";
import { Workspace } from "../src/workspace/manager.js";
import { tryAcquireMaintenanceLock } from "../src/core/maintenance-lock.js";
import { cleanup, isolateStateDir } from "./helpers.js";

const THREAD_ID = "01a00000-0000-7000-8000-000000000101";
const OTHER_THREAD_ID = "01a00000-0000-7000-8000-000000000102";
const PROJECT_ID = "project_mailbox";
const CLIENT_ID = "mailbox-client";
const ACCESS_TOKEN = "mailbox-test-access-token";
const ACCESS_TOKEN_HASH = createHash("sha256").update(ACCESS_TOKEN).digest("hex");
const PRINCIPAL = "c".repeat(32);
const PRIVATE_BODY = "MAILBOX_PRIVATE_BODY_34f917";
const RUNTIME_FENCE = {
  desktopPid: 1001,
  desktopExe: "C:\\Program Files\\ChatGPT\\ChatGPT.exe",
  desktopCreation: "1000001",
  appServerPid: 1002,
  appServerExe: "C:\\Program Files\\ChatGPT\\codex.exe",
  appServerCreation: "1000002",
};

type ToolResult = { structuredContent?: Record<string, unknown>; content?: Array<{ text: string }>; isError?: boolean };
type ToolHandler = (input: Record<string, unknown>, extra: { authInfo?: AuthInfo; _meta?: unknown }) => Promise<ToolResult>;

function fakeServer(): { server: McpServer; tools: Map<string, ToolHandler> } {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _definition: unknown, handler: unknown) => tools.set(name, handler as ToolHandler),
  } as unknown as McpServer;
  return { server, tools };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

let stateDir: string;
let previousStateDir: string | undefined;
let workspace: Workspace;
let desktopBindingId: string;
let runtimeStatus: "active" | "idle";
let requestsCount: number;
let adapter: ExecutorAdapter;
let authState: "valid" | "expired" | "revoked";
let authStore: Pick<AuthStore, "verifyAccessTokenHash">;
let send: ReturnType<typeof vi.fn>;

function authInfo(scopes: string[]): AuthInfo {
  return {
    token: ACCESS_TOKEN,
    clientId: CLIENT_ID,
    scopes,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  } as AuthInfo;
}

function executorSession(target: ExecutorTarget) {
  return {
    ...target,
    title: "Mailbox deterministic test target",
    runtimeFence: RUNTIME_FENCE,
    runtimeStatus,
    requestsCount,
  };
}

function input(bindingId: string, commandId: string, message = PRIVATE_BODY) {
  return { workspaceId: workspace.id, bindingId, commandId, intent: "development_plan" as const, message, userConfirmed: true as const };
}

function createMailbox() {
  return createCommandMailbox(workspace, authStore, adapter);
}

function bindGenericExecutor(): string {
  return bindCurrentExecutor(workspace.id, workspace.root, {
    pluginId: "codex-desktop",
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    instanceId: "local",
    sessionId: THREAD_ID,
    locator: { executorProjectId: PROJECT_ID },
  }).binding.bindingId;
}

function registerDesktopMailboxTools(mailbox: ReturnType<typeof createMailbox>) {
  const registered = fakeServer();
  registerDesktopTools(registered.server, workspace, () => {}, mailbox.submit);
  return registered.tools;
}

function registerExecutorMailboxTools(mailbox: ReturnType<typeof createMailbox>) {
  const registered = fakeServer();
  registerExecutorTools(registered.server, workspace, () => {}, mailbox.submit);
  return registered.tools;
}

function conversation(session = "mailbox-session") {
  return { "openai/session": session };
}

function assertPrivateProjection(value: unknown, principal: string): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(PRIVATE_BODY);
  expect(serialized).not.toContain(ACCESS_TOKEN_HASH);
  expect(serialized).not.toContain(principal);
  const keys: string[] = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) { item.forEach(visit); return; }
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) { keys.push(key); visit(child); }
  };
  visit(value);
  const normalizedKeys = keys.map(key => key.toLowerCase());
  for (const key of ["tokenhash", "plannerfingerprint", "ownerid", "mailbox", "author"])
    expect(normalizedKeys).not.toContain(key);
}

beforeEach(async () => {
  previousStateDir = process.env.C2C_STATE_DIR;
  stateDir = isolateStateDir();
  workspace = new Workspace(fs.realpathSync.native(process.cwd()));
  runtimeStatus = "active";
  requestsCount = 1;
  authState = "valid";
  const verifyAccessTokenHash = vi.fn((hash: string) => {
    if (hash !== ACCESS_TOKEN_HASH) return { ok: false as const, reason: "unknown" as const };
    if (authState !== "valid") return { ok: false as const, reason: authState };
    return {
      ok: true as const,
      record: { workspaceId: workspace.id, clientId: CLIENT_ID, scopes: [DESKTOP_CONTROL_SCOPE, EXECUTOR_CONTROL_SCOPE] },
    };
  });
  authStore = { verifyAccessTokenHash } as unknown as Pick<AuthStore, "verifyAccessTokenHash">;
  adapter = {
    inspect: vi.fn(async (target: ExecutorTarget) => executorSession(target)),
  } as unknown as ExecutorAdapter;
  const binding = await bindDesktop(workspace, { threadId: THREAD_ID, hostId: "local", projectId: PROJECT_ID }, adapter);
  desktopBindingId = binding.bindingId;
  enableDesktop(workspace, desktopBindingId);
  vi.mocked(adapter.inspect).mockClear();
  send = vi.fn(async () => ({ threadId: THREAD_ID, turnId: "01a00000-0000-7000-8000-000000000201" }));
  vi.spyOn(desktopIpc, "inspect").mockImplementation(async target => executorSession(target) as never);
  vi.spyOn(desktopIpc, "inspectActiveExecution").mockRejectedValue(new DesktopError("DESKTOP_BUSY", "fixture busy"));
  vi.spyOn(desktopIpc, "prepare").mockImplementation(async () => ({ send, close: vi.fn() }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup(stateDir);
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
});

describe("durable command mailbox", () => {
  it("MCP submit queues while busy, keeps its DTO private, then uses the existing safe sender once when idle", async () => {
    const mailbox = createMailbox();
    const tools = registerDesktopMailboxTools(mailbox);
    const auth = authInfo([DESKTOP_CONTROL_SCOPE]);
    const meta = conversation();
    const principal = resolveConversationPrincipal({ authInfo: auth, _meta: meta }).fingerprint;
    const submitted = await tools.get("codex_desktop_send")!(input(desktopBindingId, "mailbox_busy_then_idle"), {
      authInfo: auth, _meta: meta,
    });
    expect(submitted.structuredContent?.deliveryStatus).toBe("queued");
    expect(submitted.structuredContent?.message).toMatch(/排队|accepted/i);
    expect(send).not.toHaveBeenCalled();
    expect(desktopIpc.prepare).not.toHaveBeenCalled();
    assertPrivateProjection(submitted, principal);

    await mailbox.tick();
    expect(adapter.inspect).toHaveBeenCalledTimes(1);
    expect(desktopIpc.prepare).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    runtimeStatus = "idle";
    requestsCount = 0;
    await mailbox.tick();
    expect(desktopIpc.prepare).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(listCommands(workspace)).toMatchObject([{ commandId: "mailbox_busy_then_idle", deliveryStatus: "accepted" }]);
    expect(listCommands(workspace)[0]?.mailbox).toBeUndefined();
    expect(listResults(workspace)).toHaveLength(0);

    const status = await tools.get("codex_desktop_status")!({ workspaceId: workspace.id, commandId: "mailbox_busy_then_idle" }, {
      authInfo: authInfo([DESKTOP_READ_SCOPE]),
    });
    assertPrivateProjection(status, principal);
    expect(status.structuredContent?.delivery).toMatchObject({ deliveryStatus: "accepted" });
    await mailbox.close();
  });

  it("same ID and body are idempotent, changed body/principal conflict, and cancelling a queued command erases its body", async () => {
    const mailbox = createMailbox();
    const original = input(desktopBindingId, "mailbox_idempotency");
    const first = await mailbox.submit("desktop", original, PRINCIPAL, authInfo([DESKTOP_CONTROL_SCOPE]));
    const replay = await mailbox.submit("desktop", original, PRINCIPAL, authInfo([DESKTOP_CONTROL_SCOPE]));
    expect(replay.commandId).toBe(first.commandId);
    expect(listCommands(workspace)).toHaveLength(1);
    await expect(mailbox.submit("desktop", { ...original, message: "different body" }, PRINCIPAL,
      authInfo([DESKTOP_CONTROL_SCOPE]))).rejects.toMatchObject({ code: "COMMAND_CONFLICT" });
    await expect(mailbox.submit("desktop", original, "d".repeat(32), authInfo([DESKTOP_CONTROL_SCOPE])))
      .rejects.toMatchObject({ code: "COMMAND_CONFLICT" });
    expect(cancelPendingCommand(workspace, original.commandId).deliveryStatus).toBe("rejected");

    const queued = input(desktopBindingId, "mailbox_cancelled");
    await mailbox.submit("desktop", queued, PRINCIPAL, authInfo([DESKTOP_CONTROL_SCOPE]));
    const cancelled = cancelPendingCommand(workspace, queued.commandId);
    expect(cancelled.deliveryStatus).toBe("rejected");
    expect(cancelled.mailbox).toBeUndefined();
    const persisted = JSON.parse(fs.readFileSync(routingFile(workspace.id), "utf8")) as {
      commands: Array<{ commandId: string; mailbox?: unknown }>;
    };
    const cancelledRecord = persisted.commands.find(command => command.commandId === queued.commandId);
    expect(cancelledRecord).not.toHaveProperty("mailbox");
    expect(JSON.stringify(cancelledRecord)).not.toContain(PRIVATE_BODY);
    await mailbox.tick();
    expect(adapter.inspect).not.toHaveBeenCalled();
    expect(desktopIpc.prepare).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    await mailbox.close();
  });

  it.each(["expired", "revoked"] as const)("does not dispatch after queued OAuth is %s", async status => {
    const mailbox = createMailbox();
    await mailbox.submit("desktop", input(desktopBindingId, `mailbox_${status}`), PRINCIPAL, authInfo([DESKTOP_CONTROL_SCOPE]));
    authState = status;
    await mailbox.tick();
    expect(adapter.inspect).not.toHaveBeenCalled();
    expect(desktopIpc.prepare).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(listCommands(workspace)[0]?.mailbox).toMatchObject({ state: "blocked", reason: "UNAUTHORIZED" });
    await mailbox.close();
  });

  it("does not send a queued command after the Desktop target is rebound", async () => {
    const mailbox = createMailbox();
    await mailbox.submit("desktop", input(desktopBindingId, "mailbox_target_changed"), PRINCIPAL,
      authInfo([DESKTOP_CONTROL_SCOPE]));
    const next = await bindDesktop(workspace, { threadId: OTHER_THREAD_ID, hostId: "local", projectId: "project_other" }, adapter);
    enableDesktop(workspace, next.bindingId);
    vi.mocked(adapter.inspect).mockClear();
    await mailbox.tick();
    expect(adapter.inspect).not.toHaveBeenCalled();
    expect(desktopIpc.prepare).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(listCommands(workspace)[0]?.mailbox).toMatchObject({ state: "blocked", reason: "DESKTOP_BINDING_MISMATCH" });
    await mailbox.close();
  });

  it("terminal replay returns the original durable delivery after rebind without sending to the new target", async () => {
    const mailbox = createMailbox();
    const original = input(desktopBindingId, "mailbox_terminal_replay");
    await mailbox.submit("desktop", original, PRINCIPAL, authInfo([DESKTOP_CONTROL_SCOPE]));
    runtimeStatus = "idle";
    requestsCount = 0;
    await mailbox.tick();
    expect(listCommands(workspace)[0]?.deliveryStatus).toBe("accepted");
    expect(desktopIpc.prepare).toHaveBeenCalledTimes(1);

    const next = await bindDesktop(workspace, { threadId: OTHER_THREAD_ID, hostId: "local", projectId: "project_other" }, adapter);
    enableDesktop(workspace, next.bindingId);
    const replay = await mailbox.submit("desktop", original, PRINCIPAL, authInfo([DESKTOP_CONTROL_SCOPE]));
    expect(replay).toMatchObject({ commandId: original.commandId, bindingId: desktopBindingId, deliveryStatus: "accepted" });
    expect(desktopIpc.prepare).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    assertPrivateProjection(replay, PRINCIPAL);
    await mailbox.close();
  });

  it("restart blocks an interrupted dispatch without retrying it, while a later command proceeds", async () => {
    const beforeRestart = createMailbox();
    await beforeRestart.submit("desktop", input(desktopBindingId, "mailbox_interrupted"), PRINCIPAL,
      authInfo([DESKTOP_CONTROL_SCOPE]));
    const interrupted = listCommands(workspace)[0]!;
    setCommandMailbox(workspace, interrupted.commandId, { ...interrupted.mailbox!, state: "dispatching" });

    const afterRestart = createMailbox();
    await afterRestart.tick();
    expect(listCommands(workspace)[0]?.mailbox).toMatchObject({ state: "blocked", reason: "DISPATCH_INTERRUPTED" });
    expect(adapter.inspect).not.toHaveBeenCalled();
    expect(desktopIpc.prepare).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    const interruptedReplay = await afterRestart.submit("desktop", input(desktopBindingId, "mailbox_interrupted"), PRINCIPAL,
      authInfo([DESKTOP_CONTROL_SCOPE]));
    expect(interruptedReplay.deliveryStatus).toBe("outcome_unknown");
    expect(interruptedReplay.queueStatus).toBe("blocked");
    await afterRestart.tick();
    expect(desktopIpc.prepare).not.toHaveBeenCalled();

    runtimeStatus = "idle";
    requestsCount = 0;
    await afterRestart.submit("desktop", input(desktopBindingId, "mailbox_after_interrupted"), PRINCIPAL,
      authInfo([DESKTOP_CONTROL_SCOPE]));
    await afterRestart.tick();
    expect(desktopIpc.prepare).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    await beforeRestart.close();
    await afterRestart.close();
  });

  it("refuses to cancel a dispatching command whose send outcome may be unknown", async () => {
    const mailbox = createMailbox();
    const queued = input(desktopBindingId, "mailbox_cancel_dispatching");
    await mailbox.submit("desktop", queued, PRINCIPAL, authInfo([DESKTOP_CONTROL_SCOPE]));
    const command = listCommands(workspace)[0]!;
    setCommandMailbox(workspace, command.commandId, { ...command.mailbox!, state: "dispatching" });

    expect(() => cancelPendingCommand(workspace, command.commandId)).toThrowError(expect.objectContaining({ code: "ROUTING_CANCEL_UNSAFE" }));
    expect(listCommands(workspace)[0]?.mailbox).toMatchObject({ state: "dispatching", message: PRIVATE_BODY });
    expect(listCommands(workspace)[0]?.deliveryStatus).toBe("pending");
    expect(send).not.toHaveBeenCalled();
    await mailbox.close();
  });

  it("preserves interrupted-send evidence and body when cancellation follows restart", async () => {
    const beforeRestart = createMailbox();
    const queued = input(desktopBindingId, "mailbox_cancel_interrupted");
    await beforeRestart.submit("desktop", queued, PRINCIPAL, authInfo([DESKTOP_CONTROL_SCOPE]));
    const command = listCommands(workspace)[0]!;
    setCommandMailbox(workspace, command.commandId, { ...command.mailbox!, state: "dispatching" });

    const afterRestart = createMailbox();
    await afterRestart.tick();
    expect(listCommands(workspace)[0]?.mailbox).toMatchObject({ state: "blocked", reason: "DISPATCH_INTERRUPTED" });
    expect(() => cancelPendingCommand(workspace, command.commandId)).toThrowError(expect.objectContaining({ code: "ROUTING_CANCEL_UNSAFE" }));
    expect(listCommands(workspace)[0]?.mailbox).toMatchObject({ state: "blocked", reason: "DISPATCH_INTERRUPTED", message: PRIVATE_BODY });
    expect(listCommands(workspace)[0]?.deliveryStatus).toBe("pending");
    expect(send).not.toHaveBeenCalled();
    await beforeRestart.close();
    await afterRestart.close();
  });

  it("refuses cancellation when the matching durable Desktop delivery ledger exists", async () => {
    const mailbox = createMailbox();
    const queued = input(desktopBindingId, "mailbox_cancel_with_delivery_evidence");
    await mailbox.submit("desktop", queued, PRINCIPAL, authInfo([DESKTOP_CONTROL_SCOPE]));
    const now = new Date().toISOString();
    updateDesktop(workspace.id, previous => {
      if (!previous) throw new Error("fixture Desktop state missing");
      previous.deliveries.push({
        commandId: queued.commandId,
        clientId: CLIENT_ID,
        bindingId: desktopBindingId,
        lifecycle: "ephemeral",
        intent: queued.intent,
        messageSha256: createHash("sha256").update(queued.message, "utf8").digest("hex"),
        messageBytes: Buffer.byteLength(queued.message, "utf8"),
        threadId: THREAD_ID,
        deliveryStatus: "outcome_unknown",
        createdAt: now,
        updatedAt: now,
      });
      return { state: previous, result: undefined };
    });

    expect(() => cancelPendingCommand(workspace, queued.commandId)).toThrowError(expect.objectContaining({ code: "ROUTING_CANCEL_UNSAFE" }));
    expect(listCommands(workspace)[0]?.mailbox).toMatchObject({ state: "queued", message: PRIVATE_BODY });
    expect(readDesktop(workspace.id)?.deliveries[0]).toMatchObject({
      commandId: queued.commandId, deliveryStatus: "outcome_unknown",
    });
    expect(listCommands(workspace)[0]?.deliveryStatus).toBe("pending");
    expect(send).not.toHaveBeenCalled();
    await mailbox.close();
  });

  it("two mailbox instances admit only one worker for a queued command", async () => {
    const firstWorker = createMailbox();
    const secondWorker = createMailbox();
    await firstWorker.submit("desktop", input(desktopBindingId, "mailbox_two_workers"), PRINCIPAL,
      authInfo([DESKTOP_CONTROL_SCOPE]));
    runtimeStatus = "idle";
    requestsCount = 0;
    const entered = deferred<void>();
    const inspected = deferred<ReturnType<typeof executorSession>>();
    vi.mocked(adapter.inspect).mockImplementation(async () => {
      entered.resolve();
      return inspected.promise;
    });
    const firstTick = firstWorker.tick();
    await entered.promise;
    const secondTick = secondWorker.tick();
    inspected.resolve(executorSession({ threadId: THREAD_ID, hostId: "local", projectId: PROJECT_ID, workspaceRoot: workspace.root }));
    await Promise.all([firstTick, secondTick]);
    expect(desktopIpc.prepare).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    await firstWorker.close();
    await secondWorker.close();
  });

  it("skips dispatch while machine maintenance owns rollout admission", async () => {
    const mailbox = createMailbox();
    await mailbox.submit("desktop", input(desktopBindingId, "mailbox_rollout_lock"), PRINCIPAL,
      authInfo([DESKTOP_CONTROL_SCOPE]));
    const held = tryAcquireMaintenanceLock(stateDir, "fixture-rollout");
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    await mailbox.tick();
    expect(adapter.inspect).not.toHaveBeenCalled();
    expect(desktopIpc.prepare).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(held.handle.release()).toBe(true);
    await mailbox.close();
  });

  it("skips a command whose lifecycle lock is busy and continues with the next queued command", async () => {
    const mailbox = createMailbox();
    const blockedId = "mailbox_a_lifecycle_busy";
    await mailbox.submit("desktop", input(desktopBindingId, blockedId), PRINCIPAL,
      authInfo([DESKTOP_CONTROL_SCOPE]));
    await mailbox.submit("desktop", input(desktopBindingId, "mailbox_z_after_busy"), PRINCIPAL,
      authInfo([DESKTOP_CONTROL_SCOPE]));
    runtimeStatus = "idle";
    requestsCount = 0;
    const corruptLifecycleLock = `${cleanupJournalFile(workspace.id, blockedId, stateDir)}.lock`;
    fs.writeFileSync(corruptLifecycleLock, "corrupt lifecycle authority");
    await mailbox.tick();
    const commands = listCommands(workspace);
    expect(commands.find(command => command.commandId === blockedId)?.mailbox).toMatchObject({ state: "queued" });
    expect(fs.readFileSync(corruptLifecycleLock, "utf8")).toBe("corrupt lifecycle authority");
    expect(commands.find(command => command.commandId === "mailbox_z_after_busy")?.deliveryStatus).toBe("accepted");
    expect(desktopIpc.prepare).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    await mailbox.close();
  });

  it("close waits for an inspection in flight and prevents the post-inspection send", async () => {
    const mailbox = createMailbox();
    await mailbox.submit("desktop", input(desktopBindingId, "mailbox_close"), PRINCIPAL,
      authInfo([DESKTOP_CONTROL_SCOPE]));
    runtimeStatus = "idle";
    requestsCount = 0;
    const entered = deferred<void>();
    const inspected = deferred<ReturnType<typeof executorSession>>();
    vi.mocked(adapter.inspect).mockImplementation(async () => {
      entered.resolve();
      return inspected.promise;
    });
    const tick = mailbox.tick();
    await entered.promise;
    let closed = false;
    const closing = mailbox.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    inspected.resolve(executorSession({ threadId: THREAD_ID, hostId: "local", projectId: PROJECT_ID, workspaceRoot: workspace.root }));
    await Promise.all([tick, closing]);
    expect(closed).toBe(true);
    expect(desktopIpc.prepare).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["desktop", "executor"] as const)("%s close during prepare keeps a proven-unsent command queued for the next instance", async kind => {
    const bindingId = kind === "desktop" ? desktopBindingId : bindGenericExecutor();
    const scope = kind === "desktop" ? DESKTOP_CONTROL_SCOPE : EXECUTOR_CONTROL_SCOPE;
    const mailbox = createMailbox();
    const queued = input(bindingId, `mailbox_close_prepare_${kind}`);
    await mailbox.submit(kind, queued, PRINCIPAL, authInfo([scope]));
    runtimeStatus = "idle";
    requestsCount = 0;
    const entered = deferred<void>();
    const prepared = deferred<void>();
    vi.mocked(desktopIpc.prepare).mockImplementationOnce(async () => {
      entered.resolve();
      await prepared.promise;
      return { send, close: vi.fn() } as never;
    });
    const tick = mailbox.tick();
    await entered.promise;
    const closing = mailbox.close();
    prepared.resolve();
    await Promise.all([tick, closing]);
    expect(send).not.toHaveBeenCalled();
    expect(listCommands(workspace)[0]?.mailbox).toMatchObject({ state: "queued" });
    expect(readDesktop(workspace.id)?.deliveries).toHaveLength(0);
    expect(readExecutorDispatchState(workspace.id)?.entries ?? []).toHaveLength(0);
    const resumed = createMailbox();
    await resumed.tick();
    expect(send).toHaveBeenCalledTimes(1);
    expect(listCommands(workspace)[0]?.deliveryStatus).toBe("accepted");
    await resumed.close();
  });

  it.each(["desktop", "executor"] as const)("%s close after the send commit waits for the original attempt without requeueing", async kind => {
    const bindingId = kind === "desktop" ? desktopBindingId : bindGenericExecutor();
    const scope = kind === "desktop" ? DESKTOP_CONTROL_SCOPE : EXECUTOR_CONTROL_SCOPE;
    const mailbox = createMailbox();
    const queued = input(bindingId, `mailbox_close_send_${kind}`);
    await mailbox.submit(kind, queued, PRINCIPAL, authInfo([scope]));
    runtimeStatus = "idle";
    requestsCount = 0;
    const entered = deferred<void>();
    const sent = deferred<void>();
    send.mockImplementationOnce(async () => {
      entered.resolve();
      await sent.promise;
      return { threadId: THREAD_ID, turnId: "01a00000-0000-7000-8000-000000000201" };
    });
    const tick = mailbox.tick();
    await entered.promise;
    expect(readDesktop(workspace.id)?.deliveries[0]?.deliveryStatus).toBe("outcome_unknown");
    let closed = false;
    const closing = mailbox.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    sent.resolve();
    await Promise.all([tick, closing]);
    expect(closed).toBe(true);
    expect(listCommands(workspace)[0]?.deliveryStatus).toBe("accepted");
    expect(listCommands(workspace)[0]?.mailbox).toBeUndefined();
    const resumed = createMailbox();
    await resumed.tick();
    expect(send).toHaveBeenCalledTimes(1);
    await resumed.close();
  });

  it("generic executor busy rolls back the unsent pin, then accepted delivery terminalizes the queue once", async () => {
    const bindingId = bindGenericExecutor();
    const mailbox = createMailbox();
    const tools = registerExecutorMailboxTools(mailbox);
    const auth = authInfo([EXECUTOR_CONTROL_SCOPE]);
    const meta = conversation("executor-mailbox-session");
    const principal = resolveConversationPrincipal({ authInfo: auth, _meta: meta }).fingerprint;
    runtimeStatus = "idle";
    requestsCount = 0;
    vi.mocked(desktopIpc.prepare).mockRejectedValueOnce(new DesktopError("DESKTOP_BUSY", "busy before delivery commit"));
    const submitted = await tools.get("executor_send")!(input(bindingId, "mailbox_executor_busy"), { authInfo: auth, _meta: meta });
    expect(submitted.structuredContent?.deliveryStatus).toBe("queued");
    assertPrivateProjection(submitted, principal);

    await mailbox.tick();
    expect(desktopIpc.prepare).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(readExecutorDispatchState(workspace.id)?.entries.some(entry => entry.commandId === "mailbox_executor_busy")).toBe(false);
    expect(readDesktop(workspace.id)?.deliveries.some(delivery => delivery.commandId === "mailbox_executor_busy")).toBe(false);
    expect(listCommands(workspace)[0]?.mailbox).toMatchObject({ state: "queued" });

    await mailbox.tick();
    expect(desktopIpc.prepare).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(readExecutorDispatchState(workspace.id)?.entries).toMatchObject([{ commandId: "mailbox_executor_busy", deliveryStatus: "accepted" }]);
    expect(listCommands(workspace)[0]).toMatchObject({ commandId: "mailbox_executor_busy", deliveryStatus: "accepted" });
    expect(listCommands(workspace)[0]?.mailbox).toBeUndefined();
    expect(listResults(workspace)).toHaveLength(0);
    await mailbox.tick();
    expect(desktopIpc.prepare).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(listCommands(workspace)[0]?.deliveryStatus).toBe("accepted");
    await mailbox.close();
  });

  it("pin rollback rejects generation/owner drift and refuses any matching durable Desktop delivery", () => {
    const bindingId = bindGenericExecutor();
    const commandId = "mailbox_pin_rollback";
    const message = "rollback fixture";
    const pin = beginExecutorDispatch({
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      bindingId,
      commandId,
      intent: "development_plan",
      message,
      requestAuthoritySha256: hashRequestAuthority(PRINCIPAL),
      lifecycle: "ephemeral",
      stateDir,
    });
    const releaseInput = {
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      commandId,
      target: pin.target,
      expectedDispatchGenerationId: pin.entry.dispatchGenerationId,
      stateDir,
    };
    expect(() => releaseUnsentExecutorPin({ ...releaseInput, expectedDispatchGenerationId: randomUUID() }))
      .toThrow(/generation|dispatch/i);
    expect(readExecutorDispatchState(workspace.id, stateDir)?.entries[0]?.deliveryStatus).toBe("started");

    const file = executorDispatchFile(workspace.id, stateDir);
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { entries: Array<{ commandId: string; ownerId?: string }> };
    raw.entries.find(entry => entry.commandId === commandId)!.ownerId = "another-owner";
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(() => releaseUnsentExecutorPin(releaseInput)).toThrow(/pin|transition|owner/i);
    expect(readExecutorDispatchState(workspace.id, stateDir)?.entries[0]?.ownerId).toBe("another-owner");

    const now = new Date().toISOString();
    updateDesktop(workspace.id, previous => {
      if (!previous) throw new Error("fixture Desktop state missing");
      previous.deliveries.push({
        commandId,
        clientId: CLIENT_ID,
        bindingId: desktopBindingId,
        lifecycle: "ephemeral",
        intent: "development_plan",
        messageSha256: createHash("sha256").update(message).digest("hex"),
        messageBytes: Buffer.byteLength(message, "utf8"),
        threadId: THREAD_ID,
        deliveryStatus: "outcome_unknown",
        createdAt: now,
        updatedAt: now,
      });
      return { state: previous, result: undefined };
    });
    expect(() => releaseUnsentExecutorPin(releaseInput)).toThrow(/投递证据|delivery|pin|transition/i);
    expect(readExecutorDispatchState(workspace.id, stateDir)?.entries.some(entry => entry.commandId === commandId)).toBe(true);
  });
});
