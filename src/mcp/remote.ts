import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import type { Workspace } from "../workspace/manager.js";
import { authorized, createInput, enqueueTask, enqueueThread, publicTask, publicThread, readRemote, remoteId, RemoteError, taskInput } from "../remote/store.js";

export function registerRemoteTools(server: McpServer, workspace: Workspace): void {
  try { if (!readRemote(workspace.id)?.enabled) return; }
  catch (error) {
    // 独立远程状态损坏时关闭控制面；原只读数据面仍可用于核对和恢复。
    if (error instanceof RemoteError && error.code === "STATE_CORRUPT") return;
    throw error;
  }
  function guard(workspaceId: string, auth: AuthInfo | undefined, scope: string) {
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
    description: "为当前本地授权工作区排队创建 Codex 线程。requestId 必须唯一，重复调用返回原请求；queued 时用 codex_thread_status 按 requestId 查询 threadId。", inputSchema: createInput,
    ...metadata("codex.control", true),
  }, (input, extra) => result(() => {
    guard(input.workspaceId, extra.authInfo, "codex.control");
    const thread = enqueueThread(workspace.id, input, extra.authInfo!.clientId);
    return { ok: thread.status === "completed", accepted: true, ...publicThread(thread) };
  }, "codex.control"));
  server.registerTool("codex_submit_task", {
    description: "向 C2C 管理的线程提交任务目标，立即持久化排队；commandId 全生命周期幂等。执行由本机 Codex 决定，可能修改文件或请求审批。", inputSchema: taskInput,
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
    if (!task) throw new RemoteError("UNKNOWN_TASK");
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
    const latest = thread.threadId ? state.tasks.filter(t => t.threadId === thread.threadId).at(-1) : undefined;
    return { ...publicThread(thread), latestTask: latest ? publicTask(latest) : null };
  }, "codex.read"));
}
