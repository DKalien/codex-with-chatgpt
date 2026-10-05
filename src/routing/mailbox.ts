import { createHash } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { AuthStore, DESKTOP_CONTROL_SCOPE, EXECUTOR_CONTROL_SCOPE } from "../auth/store.js";
import type { Workspace } from "../workspace/manager.js";
import { getExecutor, type ExecutorAdapter } from "../executor/index.js";
import { DesktopError, publicDelivery, readDesktop, sendInput } from "../desktop/store.js";
import { validateDesktopWireMessage } from "../desktop/ipc.js";
import { readActiveExecutorBinding } from "../executor-control/service.js";
import { dispatchExecutorCommand, type ExecutorSendInput } from "../executor-control/send.js";
import { readExecutorDispatchState } from "../executor-control/dispatch-store.js";
import { withCommandOperationAsync } from "../command-cleanup/fence.js";
import { CommandCleanupError } from "../command-cleanup/schema.js";
import { createCurrentCommand } from "./current-command.js";
import { deliverCurrentCommand } from "./current-command-transport.js";
import { listCommands, listRoutes, setCommandMailbox } from "./store.js";
import { RoutingError, type CommandMailbox, type RoutingCommand } from "./schema.js";
import { assertMaintenanceHandle, tryAcquireMaintenanceLock, releaseMaintenanceOrThrow, type MaintenanceLockHandle } from "../core/maintenance-lock.js";
import { getStateDir } from "../config/paths.js";

export type CommandMailboxSubmit = (kind: "desktop" | "executor", input: ExecutorSendInput,
  principal: string, auth: AuthInfo) => Promise<Record<string, unknown>>;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** One workspace inbox, backed by Routing's existing atomic store and command fences.
 * Busy is scheduling information. A crashed dispatch is isolated, never resent.
 * No thread creation/steering protocol is inferred from a busy Desktop snapshot.
 */
export function createCommandMailbox(workspace: Workspace, authStore: Pick<AuthStore, "verifyAccessTokenHash">,
  executor: ExecutorAdapter = getExecutor()) {
  let ticking = false, closed = false;
  let finishTick: (() => void) | undefined, tickFinished: Promise<void> | undefined;
  let maintenance: MaintenanceLockHandle | undefined;
  function authorizeGrant(mailbox: CommandMailbox): void {
    if (closed) throw new RoutingError("ROUTING_MAILBOX_CLOSED", "Bridge 正在关闭。");
    if (maintenance) assertMaintenanceHandle(getStateDir(), maintenance);
    const verdict = authStore.verifyAccessTokenHash(mailbox.tokenHash);
    const scope = mailbox.kind === "desktop" ? DESKTOP_CONTROL_SCOPE : EXECUTOR_CONTROL_SCOPE;
    if (!verdict.ok || verdict.record.workspaceId !== workspace.id || verdict.record.clientId !== mailbox.clientId ||
        !verdict.record.scopes.includes(scope)) throw new DesktopError("UNAUTHORIZED", "排队任务的 OAuth 授权已失效。");
  }
  function authorize(mailbox: CommandMailbox): void {
    authorizeGrant(mailbox);
    const desktop = readDesktop(workspace.id);
    if (!desktop?.enabled || desktop.workspaceRoot !== workspace.root || desktop.binding?.bindingId !== mailbox.desktopBindingId)
      throw new DesktopError("DESKTOP_BINDING_MISMATCH", "排队任务目标已改变；未转投其他会话。");
    if (mailbox.kind === "executor") {
      const active = readActiveExecutorBinding(workspace.id, workspace.root);
      if (active?.bindingId !== mailbox.bindingId || active.pluginId !== "codex-desktop" || active.sessionId !== desktop.binding.threadId)
        throw new DesktopError("DESKTOP_BINDING_MISMATCH", "排队任务的 Executor 目标已改变。");
    }
  }
  function response(command: RoutingCommand, mailbox: CommandMailbox): Record<string, unknown> {
    if (!command.mailbox) {
      const legacy = readDesktop(workspace.id)?.deliveries.find(item => item.commandId === command.commandId);
      if (mailbox.kind === "desktop") {
        if (!legacy || legacy.bindingId !== mailbox.bindingId || legacy.clientId !== mailbox.clientId ||
            legacy.messageSha256 !== command.payloadSha256 || legacy.messageBytes !== command.payloadBytes)
          throw new DesktopError("DESKTOP_COMMAND_CONFLICT", "任务回放缺少原目标的精确投递记录。");
        return publicDelivery(legacy);
      }
      const dispatch = readExecutorDispatchState(workspace.id)?.entries.find(item => item.commandId === command.commandId);
      if (!dispatch || dispatch.target.bindingId !== mailbox.bindingId || dispatch.payloadSha256 !== command.payloadSha256 ||
          dispatch.payloadBytes !== command.payloadBytes || dispatch.requestAuthoritySha256 !== digest(mailbox.plannerFingerprint))
        throw new RoutingError("COMMAND_CONFLICT", "任务回放缺少原 Executor 的精确投递记录。");
      return { commandId: command.commandId, pluginId: dispatch.target.pluginId, bindingId: dispatch.target.bindingId,
        sessionId: dispatch.target.sessionId, deliveryStatus: dispatch.deliveryStatus === "started" ? "outcome_unknown" : dispatch.deliveryStatus,
        ...(dispatch.deliveryId ? { deliveryId: dispatch.deliveryId } : {}), ...(dispatch.errorCode ? { error: dispatch.errorCode } : {}),
        createdAt: dispatch.createdAt, updatedAt: dispatch.updatedAt, message: `已记录：${dispatch.deliveryStatus}` };
    }
    const route = listRoutes(workspace).find(item => item.routeId === command.executorRouteId)!;
    const desktopEvidence = readDesktop(workspace.id)?.deliveries.find(item => item.commandId === command.commandId);
    const dispatchEvidence = readExecutorDispatchState(workspace.id)?.entries.find(item => item.commandId === command.commandId);
    const uncertain = mailbox.state === "dispatching" || mailbox.reason === "DISPATCH_INTERRUPTED" ||
      desktopEvidence?.deliveryStatus === "outcome_unknown" ||
      dispatchEvidence?.deliveryStatus === "outcome_unknown" || dispatchEvidence?.deliveryStatus === "started";
    return { commandId: command.commandId, bindingId: mailbox.bindingId, intent: command.intent,
      ...(mailbox.kind === "executor" ? { pluginId: "codex-desktop", sessionId: route.conversationId } : { threadId: route.conversationId }),
      deliveryStatus: uncertain ? "outcome_unknown" : command.deliveryStatus === "pending" ? "queued" : command.deliveryStatus,
      queueStatus: mailbox.state,
      ...(mailbox.reason ? { error: mailbox.reason } : {}),
      createdAt: command.createdAt, updatedAt: command.updatedAt,
      message: uncertain ? "本条投递结果无法确认；保留证据，不会自动重发。其他任务继续处理。"
        : command.mailbox?.state === "blocked" ? `已接收，待处理：${command.mailbox.reason}`
        : command.deliveryStatus === "pending" ? "Bridge 已接收并排队；Codex 空闲后投递。这不是执行完成。" : `已记录：${command.deliveryStatus}` };
  }
  const submit: CommandMailboxSubmit = async (kind, raw, principal, auth) => {
    if (closed) throw new RoutingError("ROUTING_MAILBOX_CLOSED", "Bridge 正在关闭，未接收任务。");
    const input = sendInput.parse(raw);
    if (input.workspaceId !== workspace.id) throw new DesktopError("DESKTOP_WRONG_WORKSPACE", "请求工作区不匹配。");
    validateDesktopWireMessage(JSON.stringify({ type: "C2C_DESKTOP_TASK", version: 2, workspaceId: workspace.id,
      commandId: input.commandId, intent: input.intent, deliveryId: "00000000-0000-4000-8000-000000000000", message: input.message }));
    return withCommandOperationAsync(workspace.id, input.commandId, async () => {
      const desktop = readDesktop(workspace.id);
      if (!desktop?.binding) throw new DesktopError("DESKTOP_DISABLED", "尚未绑定 Desktop。");
      const mailbox: CommandMailbox = { kind, state: "queued", message: input.message, clientId: auth.clientId,
        tokenHash: digest(auth.token), bindingId: input.bindingId, desktopBindingId: desktop.binding.bindingId, plannerFingerprint: principal };
      authorizeGrant(mailbox);
      const existing = listCommands(workspace).find(item => item.commandId === input.commandId);
      if (existing) {
        const planner = listRoutes(workspace).find(item => item.routeId === existing.plannerRouteId);
        if (planner?.conversationId !== principal || existing.intent !== input.intent ||
            existing.payloadSha256 !== digest(input.message) || existing.payloadBytes !== Buffer.byteLength(input.message))
          throw new RoutingError("COMMAND_CONFLICT", "相同任务 ID 的主体或正文不同，拒绝替换。");
        if (existing.mailbox && (existing.mailbox.bindingId !== input.bindingId || existing.mailbox.clientId !== auth.clientId || existing.mailbox.kind !== kind))
          throw new RoutingError("COMMAND_CONFLICT", "相同任务 ID 的目标或客户端不同。");
        // A pending command without a mailbox belongs to the synchronous transport.
        // Never adopt it as a new send after an interrupted request.
        if (!existing.mailbox && existing.deliveryStatus === "pending") {
          if (kind === "desktop" && input.bindingId !== desktop.binding.bindingId)
            throw new DesktopError("DESKTOP_BINDING_MISMATCH", "Desktop 目标已改变。");
          throw new RoutingError("ROUTING_MAILBOX_CONFLICT", "旧投递尚未收敛；本条不会重新排队。");
        }
        if (existing.mailbox) authorize(existing.mailbox);
        return response(existing, existing.mailbox ?? mailbox);
      }
      if (kind === "desktop" && input.bindingId !== desktop.binding.bindingId)
        throw new DesktopError("DESKTOP_BINDING_MISMATCH", "Desktop 目标已改变。");
      authorize(mailbox);
      const pending = listCommands(workspace).filter(item => item.mailbox).length;
      if (pending >= 100) throw new RoutingError("ROUTING_MAILBOX_FULL", "收件箱达到 100 条待处理任务，请先处理或取消。");
      const command = createCurrentCommand(workspace, principal, { commandId: input.commandId, intent: input.intent, payload: input.message }, mailbox);
      return response(command, mailbox);
    });
  };
  async function tick(): Promise<void> {
    if (closed || ticking) return;
    ticking = true;
    tickFinished = new Promise<void>(resolve => { finishTick = resolve; });
    let actionError: unknown;
    try {
      const candidates = listCommands(workspace).filter(item => item.deliveryStatus === "pending" && item.mailbox && item.mailbox.state !== "blocked")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.commandId.localeCompare(b.commandId));
      if (!candidates.length) return;
      // Order: machine maintenance -> command -> endpoint/store. Installation or
      // rollout wins admission; no queued IPC begins inside its critical section.
      const acquired = tryAcquireMaintenanceLock(getStateDir(), "command-mailbox-dispatch");
      if (!acquired.ok) return;
      maintenance = acquired.handle;
      for (const candidate of candidates) {
      try {
      await withCommandOperationAsync(workspace.id, candidate.commandId, async () => {
        const command = listCommands(workspace).find(item => item.commandId === candidate.commandId);
        if (!command?.mailbox || command.deliveryStatus !== "pending" || command.mailbox.state === "blocked" || closed) return;
        const mailbox = command.mailbox;
        const block = (reason: string) => setCommandMailbox(workspace, command.commandId, { ...mailbox, state: "blocked", reason });
        if (mailbox.state === "dispatching") { block("DISPATCH_INTERRUPTED"); return; }
        try {
          authorize(mailbox);
          const desktop = readDesktop(workspace.id)!;
          const binding = desktop.binding!;
          if (!desktop.runtimeFence) throw new DesktopError("DESKTOP_RUNTIME_FENCE_MISSING", "缺少 Desktop 进程身份。");
          const active = await executor.inspect({ threadId: binding.threadId, hostId: binding.hostId,
            projectId: binding.projectId, workspaceRoot: workspace.root }, desktop.runtimeFence);
          if (closed) return;
          // prepare() remains the final send authority. inspect is only a scheduling hint.
          if (active.runtimeStatus !== "idle" || active.requestsCount !== 0) return;
          authorize(mailbox);
          setCommandMailbox(workspace, command.commandId, { ...mailbox, state: "dispatching" });
          const input: ExecutorSendInput = { workspaceId: workspace.id, bindingId: mailbox.bindingId,
            commandId: command.commandId, intent: command.intent, message: mailbox.message, userConfirmed: true };
          if (mailbox.kind === "executor") await dispatchExecutorCommand(workspace, input, mailbox.plannerFingerprint, mailbox.clientId, () => authorize(mailbox), true);
          else await deliverCurrentCommand(workspace, mailbox.plannerFingerprint, { commandId: command.commandId,
            intent: command.intent, payload: mailbox.message, userConfirmed: true }, mailbox.clientId, () => authorize(mailbox), mailbox.bindingId);
        } catch (error) {
          const latest = listCommands(workspace).find(item => item.commandId === command.commandId);
          if (latest?.deliveryStatus !== "pending" || !latest.mailbox) return;
          const code = (error as { code?: string }).code;
          // BUSY and the local close authorization fence precede the send commit.
          // Generic dispatch owns its own unknown ledger; do not retry that pin.
          if ((code === "DESKTOP_BUSY" || code === "ROUTING_MAILBOX_CLOSED") && !readDesktop(workspace.id)?.deliveries.some(item => item.commandId === command.commandId) &&
              !readExecutorDispatchState(workspace.id)?.entries.some(item => item.commandId === command.commandId))
            setCommandMailbox(workspace, command.commandId, { ...mailbox, state: "queued" });
          else block(code && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : "DISPATCH_UNAVAILABLE");
        }
      });
      return;
      } catch (error) {
        // A command's lifecycle evidence belongs to that command. Never repair,
        // unlink or bypass it; other inbox entries retain independent authority.
        if (error instanceof CommandCleanupError && ["COMMAND_CLEANUP_BUSY", "COMMAND_CLEANUP_IN_PROGRESS", "COMMAND_CLEANUP_CORRUPT"].includes(error.code)) continue;
        throw error;
      }
      }
    } catch (error) { actionError = error; throw error; }
    finally {
      const handle = maintenance;
      maintenance = undefined;
      try { releaseMaintenanceOrThrow(handle, { actionError }); }
      finally { ticking = false; finishTick?.(); finishTick = undefined; }
    }
  }
  return { submit, tick, close: async () => { closed = true; await tickFinished; } };
}
