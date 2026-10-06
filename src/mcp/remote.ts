import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import type { Workspace } from "../workspace/manager.js";
import { authorized, cancelRemoteTask, controllerOnline, createInput, enqueueTask, enqueueThread, isOfficialRemoteMode, publicTask, publicTaskResult, publicThread, readRemote, remoteId, RemoteError, taskInput } from "../remote/store.js";

export function registerRemoteTools(server: McpServer, workspace: Workspace, profile: "legacy" | "official" = "legacy"): void {
  if (profile === "legacy") {
    try { if (!readRemote(workspace.id)?.enabled) return; }
    catch (error) {
      // Legacy behavior keeps its existing registration policy on corrupt state.
      if (error instanceof RemoteError && error.code === "STATE_CORRUPT") return;
      throw error;
    }
  }
  function guard(workspaceId: string, auth: AuthInfo | undefined, scope: string) {
    if (profile === "legacy" && isOfficialRemoteMode(workspace.id)) throw new RemoteError("OFFICIAL_MODE_ACTIVE");
    if (!auth?.scopes.includes(scope)) throw new RemoteError("INSUFFICIENT_SCOPE", scope);
    if (workspaceId !== workspace.id) throw new RemoteError("UNKNOWN_WORKSPACE");
    const state = authorized(readRemote(workspace.id));
    if (state.workspaceRoot !== workspace.root) throw new RemoteError("UNKNOWN_WORKSPACE");
    return state;
  }
  async function result(action: () => unknown | Promise<unknown>, scope: string) {
    try {
      const data = await action();
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    } catch (error) {
      const code = error instanceof RemoteError ? error.code : "REMOTE_STATE_ERROR";
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: code }) }],
        ...(code === "INSUFFICIENT_SCOPE" ? { _meta: { "mcp/www_authenticate": [`Bearer error="insufficient_scope", scope="${scope}"`] } } : {}) };
    }
  }
  const metadata = (scope: string, write: boolean) => ({
    annotations: { readOnlyHint: !write, destructiveHint: write, idempotentHint: true, openWorldHint: write },
    _meta: { securitySchemes: [{ type: "oauth2", scopes: [scope] }] },
  });
  server.registerTool("codex_create_thread", {
    description: "为当前本地授权工作区排队创建 Codex 线程。requestId 必须唯一，重复调用返回原请求；queued 时用 codex_thread_status 按 requestId 查询 threadId。不会隐式选择当前 Chat。", inputSchema: createInput,
    ...metadata("codex.control", true),
  }, (input, extra) => result(() => {
    guard(input.workspaceId, extra.authInfo, "codex.control");
    const thread = enqueueThread(workspace.id, input, extra.authInfo!.clientId);
    return { ok: thread.status === "completed", accepted: true, ...publicThread(thread) };
  }, "codex.control"));
  server.registerTool("codex_submit_task", {
    description: "向明确登记且当前 OAuth 客户端有权访问的本机 Codex target 提交任务；优先传 targetId，threadId 仅作唯一 target 的兼容选择。commandId 全生命周期幂等。执行由本机 Codex 决定，可能修改文件或请求审批。", inputSchema: taskInput,
    ...metadata("codex.control", true),
  }, (input, extra) => result(() => {
    guard(input.workspaceId, extra.authInfo, "codex.control");
    return { accepted: true, ...publicTask(enqueueTask(workspace.id, input, extra.authInfo!.clientId)) };
  }, "codex.control"));
  server.registerTool("codex_task_status", {
    description: "读取当前工作区远程任务的简短状态，不返回完整任务输入或执行日志。",
    inputSchema: z.object({ workspaceId: remoteId, taskId: remoteId }).strict(), ...metadata("codex.read", false),
  }, (input, extra) => result(() => {
    const state = guard(input.workspaceId, extra.authInfo, "codex.read");
    const task = state.tasks.find(t => t.taskId === input.taskId);
    if (!task || (profile === "official" && task.clientId !== extra.authInfo!.clientId)) throw new RemoteError("UNKNOWN_TASK");
    return publicTask(task);
  }, "codex.read"));
  server.registerTool("codex_thread_status", {
    description: "按 requestId 或 threadId 查询当前工作区由 C2C 管理的线程及最近任务。",
    inputSchema: z.object({ workspaceId: remoteId, requestId: remoteId.optional(), threadId: remoteId.optional() }).strict(), ...metadata("codex.read", false),
  }, (input, extra) => result(() => {
    const state = guard(input.workspaceId, extra.authInfo, "codex.read");
    if (!input.requestId && !input.threadId) throw new RemoteError("INVALID_INPUT");
    const thread = state.threads.find(t => (!input.requestId || t.requestId === input.requestId) && (!input.threadId || t.threadId === input.threadId));
    if (!thread) throw new RemoteError("UNKNOWN_THREAD");
    const clientId = extra.authInfo!.clientId;
    const sharedLocalSelection = profile === "official" && thread.source === "selected" && !!thread.threadId &&
      state.targets?.some(target => target.source === "selected" && target.clientId === "local" &&
        target.hostId === "local" && target.workspaceId === workspace.id && target.workspaceRoot === workspace.root &&
        target.threadId === thread.threadId && (!thread.targetId || thread.targetId === target.targetId));
    if (profile === "official" && thread.clientId !== clientId && !sharedLocalSelection) throw new RemoteError("UNKNOWN_THREAD");
    const latest = thread.threadId ? state.tasks.filter(t => t.threadId === thread.threadId &&
      (profile !== "official" || t.clientId === clientId)).at(-1) : undefined;
    return { ...publicThread(thread), latestTask: latest ? publicTask(latest) : null };
  }, "codex.read"));

  if (profile !== "official") return;

  server.registerTool("codex_list_targets", {
    description: "列出此 OAuth 客户端可访问的已登记本机 Codex target，并返回 Controller 状态。hostId 与 workspaceId 必须显式确认；不会推断当前 Chat。",
    inputSchema: z.object({ workspaceId: remoteId, hostId: z.literal("local") }).strict(),
    ...metadata("codex.read", false),
  }, (input, extra) => result(() => {
    const state = guard(input.workspaceId, extra.authInfo, "codex.read");
    const clientId = extra.authInfo!.clientId;
    return {
      hostId: "local",
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      controller: state.controller
        ? controllerOnline(state) ? state.controller.appServer : "offline"
        : "unknown",
      targets: (state.targets ?? []).filter(target => target.clientId === "local" || target.clientId === clientId)
        .map(({ targetId, hostId, workspaceId, workspaceRoot, threadId, createdAt, source }) =>
          ({ targetId, hostId, workspaceId, workspaceRoot, threadId, createdAt, source })),
    };
  }, "codex.read"));

  server.registerTool("codex_task_result", {
    description: "单独读取本机 Codex 已持久化且脱敏的 finalResponse，不读取或返回完整 thread。",
    inputSchema: z.object({ workspaceId: remoteId, taskId: remoteId.optional(), commandId: remoteId.optional() })
      .strict().refine(input => !!input.taskId || !!input.commandId, { message: "taskId 或 commandId 至少提供一个。" }),
    ...metadata("codex.read", false),
  }, (input, extra) => result(() => {
    const state = guard(input.workspaceId, extra.authInfo, "codex.read");
    const matches = state.tasks.filter(task => (!input.taskId || task.taskId === input.taskId) &&
      (!input.commandId || task.commandId === input.commandId));
    if (matches.length !== 1) throw new RemoteError(matches.length ? "AMBIGUOUS_TASK" : "UNKNOWN_TASK");
    const task = matches[0]!;
    if (task.clientId !== extra.authInfo!.clientId) throw new RemoteError("TASK_ACCESS_DENIED");
    return publicTaskResult(task);
  }, "codex.read"));

  server.registerTool("codex_cancel_task", {
    description: "取消尚未派发的 queued 任务。已开始、已结束或结果不明的任务不会被取消或重发。",
    inputSchema: z.object({ workspaceId: remoteId, taskId: remoteId.optional(), commandId: remoteId.optional() })
      .strict().refine(input => !!input.taskId || !!input.commandId, { message: "taskId 或 commandId 至少提供一个。" }),
    ...metadata("codex.control", true),
  }, (input, extra) => result(() => {
    guard(input.workspaceId, extra.authInfo, "codex.control");
    return publicTask(cancelRemoteTask(workspace.id, {
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.commandId ? { commandId: input.commandId } : {}),
    }, extra.authInfo!.clientId));
  }, "codex.control"));
}
