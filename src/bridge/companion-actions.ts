import { withEndpointSwitchLock } from "../endpoint-switch/lock.js";
import { inspectCommandCleanupArtifacts } from "../command-cleanup/service.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { getStateDir } from "../config/paths.js";
import { panelActionSchema, FeedbackError } from "../feedback/schema.js";
import { readFeedbackState } from "../feedback/state-store.js";
import { changePanelState, readPanelAuthorization } from "../feedback/panel.js";
import { canCancelMailbox } from "../routing/schema.js";
import { readRouting, resolveWorkspaceIdentity, cancelPendingCommand } from "../routing/store.js";
import { readDesktop } from "../desktop/store.js";
import { readExecutorDispatchState } from "../executor-control/dispatch-store.js";
import { isTrustedDesktopReceipt, readExecutionRecordsStrict } from "../execution/records.js";
import { listResultBusEntries } from "../result-bus/store.js";
import { cancelQueuedResultBusEntry, releaseResultBusReservation } from "../result-bus/delivery-lifecycle.js";
import { previewCommandCleanup, confirmCommandCleanup } from "../command-cleanup/service.js";
import { readCleanupJournal, withCommandOperation } from "../command-cleanup/fence.js";
import { withDeliveryArbiter } from "./delivery-arbiter.js";
import { authenticateOperations } from "./companion-operation-auth.js";
import { resultBusCompanionDeliveryId, reconcileResultBusCutover } from "./result-bus-delivery.js";
import { readActiveWebSinkBinding } from "../web-sink-control/service.js";
import { readAbandonments } from "../desktop/abandonment.js";
import { readLegacyRetirements } from "../desktop/legacy-retirement.js";

export const panelRequestSchema = z.object({
  requestId: z.string().uuid(), commandId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  action: panelActionSchema, eventId: z.string().regex(/^[a-f0-9]{32}$/).optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.action === "cancel_return" || value.action === "requeue_return") !== !!value.eventId)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "回流操作必须指定精确 eventId；其他操作不能带 eventId。" });
});
type PanelRequest = z.infer<typeof panelRequestSchema>;
export type PanelContext = { workspaceId: string; workspaceRoot: string; credential: string; stateDir?: string };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function commandDigest(command: NonNullable<ReturnType<typeof readRouting>>["commands"][number]): string {
  const { deliveryStatus: _status, updatedAt: _updated, cancelledAt: _cancelled, ...identity } = command;
  return digest(identity);
}
function blocked(code: string, message: string): never { throw new FeedbackError(code, message); }

function authorize(input: PanelContext, request: PanelRequest) {
  const identity = resolveWorkspaceIdentity({ id: input.workspaceId, root: input.workspaceRoot });
  const { auth } = authenticateOperations(input);
  const permission = readPanelAuthorization(identity.id, input.stateDir);
  if (!permission.enabled || !permission.actions.includes(request.action))
    blocked("PANEL_LOCAL_AUTHORIZATION_REQUIRED", "请先在本机为当前 Companion 授权操作面板；配对凭据本身不授予清理或取消权限。");
  return { identity, auth, grant: readFeedbackState(identity.id, input.stateDir).panelGrant! };
}

/** Preview is read-only. It never repairs history or turns an unknown into unsent. */
export function previewPanelAction(input: PanelContext, raw: unknown) {
  const request = panelRequestSchema.parse(raw);
  const { identity, auth, grant } = authorize(input, request);
  const stateDir = input.stateDir ?? getStateDir();
  const feedback = readFeedbackState(identity.id, stateDir);
  if (feedback.panelOperations?.some(item => item.status === "pending" && item.commandId === request.commandId))
    blocked("PANEL_OPERATION_PENDING", "此前操作结果待核验；保留其 requestId，禁止换 ID 重试。");
  const routing = readRouting(identity, stateDir);
  const command = routing?.commands.find(item => item.commandId === request.commandId);
  const desktop = readDesktop(identity.id, stateDir)?.deliveries.find(item => item.commandId === request.commandId);
  const dispatchState = readExecutorDispatchState(identity.id, stateDir);
  if (dispatchState && dispatchState.workspaceRoot !== identity.root) blocked("PANEL_WORKSPACE_MISMATCH", "dispatch workspace 身份不一致。");
  const dispatch = dispatchState?.entries.find(item => item.commandId === request.commandId);
  const records = readExecutionRecordsStrict(identity.id, stateDir).filter(item => item.commandId === request.commandId);
  const bus = listResultBusEntries(identity, stateDir).filter(item => item.commandId === request.commandId);
  const events = feedback.events.filter(item => item.commandId === request.commandId);
  let evidence: unknown, cleanupDigest: string | undefined, sourceSha256: string | undefined, reservationId: string | undefined;
  let notice: string;
  if (request.action === "cancel_command") {
    if (!command || command.deliveryStatus !== "pending" || !canCancelMailbox(command.mailbox) || desktop || dispatch || records.length || bus.length || events.length
      || routing?.results.some(item => item.commandId === request.commandId))
      blocked("PANEL_CANCEL_UNSAFE", "无法证明该命令尚未进入外部投递边界；不能取消执行中的或结果不明的任务。");
    evidence = command;
    sourceSha256 = commandDigest(command!);
    notice = "取消这条尚未下发的指令；保留防重放记录，不终止 Codex 进程。";
  } else if (request.action === "cancel_return" || request.action === "requeue_return") {
    const entry = bus.find(item => resultBusCompanionDeliveryId(item.busEntryId) === request.eventId);
    if (!entry || events.some(item => item.eventId === request.eventId)) blocked("PANEL_EVENT_UNSUPPORTED", "回流不是唯一 canonical Result Bus 事件；请使用原投递恢复入口。");
    reconcileResultBusCutover({ identity, stateDir, readOnly: true });
    if (entry.deliveryStatus !== (request.action === "cancel_return" ? "queued" : "reserved"))
      blocked("PANEL_RETURN_ALREADY_BEGUN", "取消仅支持 queued；重新排队仅支持 reserved。已开始或结果不明的发送不能重试。");
    const sink = readActiveWebSinkBinding(identity.id);
    if (request.action === "requeue_return" && (!sink || sink.bindingId !== entry.reservation?.bindingId
      || sink.epoch !== entry.reservation?.epoch || sink.boundAt !== entry.reservation?.boundAt || sink.canonicalUrl !== auth.routeCanonical))
      blocked("PANEL_TARGET_CHANGED", "预约不是当前精确 Web Sink；不能从历史目标重排。");
    evidence = { entry, sink };
    sourceSha256 = entry.resultSha256; reservationId = entry.reservation?.reservationId;
    notice = request.action === "cancel_return" ? "取消尚未开始的结果回流；保留执行结果与防重放记录，不撤回已执行任务。"
      : "释放这次尚未开始发送的预约，按原身份重新排队；不立即点击 Send，不重发 Codex 指令。";
  } else {
    const administrativelyClosed = [...readAbandonments(identity.id, stateDir), ...readLegacyRetirements(identity.id, stateDir)]
      .some(item => item.commandId === request.commandId);
    const trusted = records.some(item => isTrustedDesktopReceipt(item, request.commandId))
      || !!routing?.results.some(item => item.commandId === request.commandId && "machineEvidence" in item);
    if (bus.some(item => ["reserved", "claimed", "outcome_unknown"].includes(item.deliveryStatus))
      || events.some(item => ["reserved", "claimed", "outcome_unknown"].includes(item.status))
      || dispatch?.deliveryStatus === "started" || dispatch?.deliveryStatus === "outcome_unknown"
      || (!administrativelyClosed && (desktop?.deliveryStatus === "outcome_unknown"
        || ((desktop?.deliveryStatus === "accepted" || command?.deliveryStatus === "accepted") && !trusted))))
      blocked("PANEL_CLEANUP_REQUIRES_LOCAL_REVIEW", "仍有在途/结果不明或未结束的已接受任务；请先通过本机精确行政处置协议核验。不会自动删除锁或结束任务。");
    const preview = previewCommandCleanup({ workspaceId: identity.id, workspaceRoot: identity.root, commandId: request.commandId, iteration: 1, stateDir });
    if (preview.status === "not_found") blocked("PANEL_COMMAND_NOT_FOUND", "该任务已不存在；不会重建记录。");
    cleanupDigest = preview.confirmationSha256 ?? undefined;
    evidence = preview;
    notice = "永久清理此任务的本地运行记录及输出。不会撤回外部消息、终止执行、证明成功或授权重新发送。";
  }
  const confirmationSha256 = digest({ version: 1, identity, request, grant, auth, evidence });
  return { request, confirmationSha256, notice, grantExpiresAt: grant.expiresAt, cleanupDigest, sourceSha256, reservationId };
}

/** Arbiter -> exact command -> cleanup/store. The pending marker precedes mutation;
 * an interrupted confirm is visible and never automatically retried under a new ID.
 * Completed exact replay is read-only, even after task cleanup removed the sources.
 */
export function confirmPanelAction(input: PanelContext, raw: unknown, confirmationSha256: string) {
  const request = panelRequestSchema.parse(raw);
  if (!/^[a-f0-9]{64}$/.test(confirmationSha256)) blocked("PANEL_CONFIRMATION_MISMATCH", "确认摘要无效。");
  let mutationStarted = false;
  try { return withDeliveryArbiter(input, identity => {
    const { grant } = authorize(input, request);
    const stateDir = input.stateDir ?? getStateDir();
    const prior = readFeedbackState(identity.id, stateDir).panelOperations?.find(item => item.requestId === request.requestId);
    if (prior) {
      if (prior.grantId !== grant.grantId || prior.confirmationSha256 !== confirmationSha256 || prior.requestSha256 !== digest(request))
        blocked("PANEL_REPLAY_MISMATCH", "操作 ID 已被其他精确请求使用。");
      return { requestId: request.requestId, status: prior.status, replayed: true };
    }
    return withCommandOperation(identity.id, request.commandId, () => {
      const mutate = () => {
      const preview = previewPanelAction(input, request);
      if (preview.confirmationSha256 !== confirmationSha256) blocked("PANEL_CONFIRMATION_MISMATCH", "任务、绑定或授权已经变化；请重新预览。");
      mutationStarted = true;
      changePanelState(identity.id, state => {
        // Keep unresolved markers indefinitely; completed outcomes are short-lived GUI metadata.
        const retained = (state.panelOperations ?? []).filter(item => item.status === "pending" || Date.parse(item.createdAt) > Date.now() - 60 * 60_000);
        if (retained.length >= 100) blocked("PANEL_OPERATION_LIMIT", "近期操作过多；请稍后处理。");
        state.panelOperations = [...retained, { requestId: request.requestId, grantId: grant.grantId,
          action: request.action, commandId: request.commandId, confirmationSha256, requestSha256: digest(request),
          ...(request.eventId ? { eventId: request.eventId } : {}),
          ...(preview.sourceSha256 ? { sourceSha256: preview.sourceSha256 } : {}),
          ...(preview.reservationId ? { reservationId: preview.reservationId } : {}),
          status: "pending", createdAt: new Date().toISOString() }];
      }, stateDir);
      if (request.action === "cleanup") confirmCommandCleanup({ workspaceId: identity.id, workspaceRoot: identity.root, commandId: request.commandId, iteration: 1, stateDir }, preview.cleanupDigest!);
      else if (request.action === "cancel_command") cancelPendingCommand(identity, request.commandId, stateDir);
      else {
        const entry = listResultBusEntries(identity, stateDir).find(item => item.commandId === request.commandId && resultBusCompanionDeliveryId(item.busEntryId) === request.eventId)!;
        if (request.action === "cancel_return") cancelQueuedResultBusEntry(identity, entry.busEntryId, stateDir);
        else releaseResultBusReservation(identity, { busEntryId: entry.busEntryId, reservationId: entry.reservation!.reservationId }, stateDir);
      }
      changePanelState(identity.id, state => {
        const receipt = state.panelOperations?.find(item => item.requestId === request.requestId);
        if (!receipt || receipt.confirmationSha256 !== confirmationSha256) blocked("PANEL_OPERATION_CHANGED", "操作证据发生变化；请本机核验。");
        receipt.status = "completed";
      }, stateDir);
      return { requestId: request.requestId, status: "completed" as const, replayed: false };
      };
      return request.action === "requeue_return" ? withEndpointSwitchLock("web-sink", identity.id, mutate, stateDir) : mutate();
    }, stateDir, request.action === "cleanup");
  }); } catch (error) {
    if (!mutationStarted && error instanceof Error) Object.assign(error, { panelNoMutation: true, panelRequestId: request.requestId });
    throw error;
  }
}

/** Explicit reconciliation proves only the requested local effect; never repeats it. */
export function reconcilePanelAction(input: PanelContext, requestId: string) {
  z.string().uuid().parse(requestId);
  return withDeliveryArbiter(input, identity => {
    authenticateOperations(input);
    const stateDir = input.stateDir ?? getStateDir();
    const receipt = readFeedbackState(identity.id, stateDir).panelOperations?.find(item => item.requestId === requestId);
    if (!receipt) return { requestId, status: "unknown" as const };
    const request = { requestId, commandId: receipt.commandId, action: receipt.action, ...(receipt.eventId ? { eventId: receipt.eventId } : {}) };
    authorize(input, request);
    if (receipt.status === "completed") return { requestId, status: "completed" as const };
    return withCommandOperation(identity.id, receipt.commandId, () => {
      let proven = false;
      if (receipt.action === "cleanup") {
        proven = !readCleanupJournal(identity.id, receipt.commandId, stateDir)
          && inspectCommandCleanupArtifacts({ workspaceId: identity.id, workspaceRoot: identity.root, commandId: receipt.commandId, iteration: 1, stateDir }).length === 0;
      } else if (receipt.action === "cancel_command") {
        const command = readRouting(identity, stateDir)?.commands.find(item => item.commandId === receipt.commandId);
        proven = !!command?.cancelledAt && commandDigest(command) === receipt.sourceSha256;
      } else {
        const entry = listResultBusEntries(identity, stateDir).find(item => item.commandId === receipt.commandId && resultBusCompanionDeliveryId(item.busEntryId) === receipt.eventId);
        proven = !!entry && entry.resultSha256 === receipt.sourceSha256 && (receipt.action === "cancel_return"
          ? entry.deliveryStatus === "cancelled" : !!receipt.reservationId && entry.reservation?.reservationId !== receipt.reservationId);
      }
      if (proven) changePanelState(identity.id, state => {
        const current = state.panelOperations?.find(item => item.requestId === requestId);
        if (!current || current.confirmationSha256 !== receipt.confirmationSha256) blocked("PANEL_OPERATION_CHANGED", "原操作证据漂移。");
        current.status = "completed";
      }, stateDir);
      return { requestId, status: proven ? "completed" as const : "pending" as const, reconciled: proven };
    }, stateDir, receipt.action === "cleanup");
  });
}
