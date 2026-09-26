import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Workspace } from "../workspace/manager.js";
import { isTrustedDesktopReceipt, readExecutionRecordsStrict } from "../execution/records.js";
import { getExecutor, type ExecutorAdapter, type ExecutorConnection, type ExecutorExecutionInfo } from "../executor/index.js";
import { DESKTOP_IPC_ERROR_MESSAGES, validateDesktopWireMessage } from "./ipc.js";
import { DesktopError, desktopId, publicDelivery, readDesktop, sendInput, targetInput, updateDesktop,
  type DesktopBinding, type DesktopDelivery, type DesktopState } from "./store.js";
import { unresolvedOutcomeUnknownCommandIds, isOutcomeUnknownAdministrativelyResolved, assertNoOutcomeResolutionForCommand } from "./outcome-resolution.js";
import { withEvidenceLock } from "./legacy-reconciliation.js";

type LocalWorkspace = Pick<Workspace, "id" | "root">;
const POST_RESULT_SETTLE_TIMEOUT_MS = 30_000;
const POST_RESULT_SETTLE_POLL_MS = 1_000;
// 同步且有界；必须始终短于有效的外层 tool/request budget，不得演变为后台续跑或队列。
interface PostResultSettleOptions {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
}
function initial(workspace: LocalWorkspace): DesktopState {
  return { version: 1, workspaceId: workspace.id, workspaceRoot: workspace.root, enabled: false, binding: null, deliveries: [] };
}
function checked(workspace: LocalWorkspace, state: DesktopState | null): DesktopState {
  if (state && state.workspaceRoot !== workspace.root)
    throw new DesktopError("DESKTOP_WRONG_WORKSPACE", "当前工作区与保存的绑定根目录不一致。");
  return state ?? initial(workspace);
}
function authorized(workspace: LocalWorkspace, state: DesktopState | null, bindingId: string): DesktopState & { binding: DesktopBinding } {
  const current = checked(workspace, state);
  if (!current.enabled) throw new DesktopError("DESKTOP_DISABLED", "本机 Desktop Control 未启用或已撤权。");
  if (!current.binding || current.binding.bindingId !== bindingId)
    throw new DesktopError("DESKTOP_BINDING_MISMATCH", "bindingId 已失效；不能自动切换到新的投递目标。");
  return current as DesktopState & { binding: DesktopBinding };
}
function target(workspace: LocalWorkspace, binding: z.infer<typeof targetInput>) {
  return { threadId: binding.threadId, hostId: binding.hostId, projectId: binding.projectId, workspaceRoot: workspace.root };
}

export async function bindDesktop(workspace: LocalWorkspace, raw: z.infer<typeof targetInput>, executor: ExecutorAdapter = getExecutor()): Promise<DesktopBinding> {
  const input = targetInput.parse(raw);
  const observed = await executor.inspect(target(workspace, input));
  const binding: DesktopBinding = { ...input, bindingId: randomUUID(), title: observed.title, boundAt: new Date().toISOString() };
  return updateDesktop(workspace.id, previous => {
    const state = checked(workspace, previous);
    state.enabled = false; state.binding = binding;
    return { state, result: binding };
  });
}
export function enableDesktop(workspace: LocalWorkspace, bindingId: string): void {
  updateDesktop(workspace.id, previous => {
    const state = checked(workspace, previous);
    if (!state.binding || state.binding.bindingId !== bindingId)
      throw new DesktopError("DESKTOP_BINDING_MISMATCH", "先明确绑定真实 Desktop 会话，并使用其当前 bindingId 启用。");
    state.enabled = true;
    return { state, result: undefined };
  });
}
export function disableDesktop(workspace: LocalWorkspace): void {
  updateDesktop(workspace.id, previous => {
    const state = checked(workspace, previous); state.enabled = false;
    return { state, result: undefined };
  });
}

/** 本地快捷路径：无 target 参数、无免确认标志；网页 MCP 不注册此操作。 */
export async function bindCurrentDesktop(workspace: LocalWorkspace, executor: ExecutorAdapter = getExecutor()) {
  assertNoUncertainDelivery(workspace, checked(workspace, readDesktop(workspace.id)));
  const observed = await executor.currentIdentity(workspace.root);
  const selected = targetInput.parse({ threadId: observed.threadId, hostId: observed.hostId, projectId: observed.projectId });
  const snapshot = checked(workspace, readDesktop(workspace.id));
  assertNoUncertainDelivery(workspace, snapshot);
  const sameTarget = snapshot.binding && snapshot.binding.threadId === selected.threadId &&
    snapshot.binding.hostId === selected.hostId && snapshot.binding.projectId === selected.projectId;
  if (sameTarget && snapshot.enabled) return { alreadyEnabled: true, enabled: true, binding: snapshot.binding! };

  // 普通 userMessage 不能证明来自本地 composer；只接受本机固定确认框，不能由 prompt 免除。
  const confirmed = await executor.confirmCurrent(workspace.root);
  if (confirmed.threadId !== selected.threadId || confirmed.hostId !== selected.hostId ||
    confirmed.projectId !== selected.projectId || confirmed.title !== observed.title)
    throw new DesktopError("DESKTOP_BINDING_CHANGED", "确认期间目标身份发生变化；未绑定或启用，请重新操作。");
  return updateDesktop(workspace.id, previous => {
    const state = checked(workspace, previous);
    assertNoUncertainDelivery(workspace, state);
    // revision 同样捕获 disable→enable 或重复 disable 的 ABA，不能使用确认前的旧授权快照。
    if ((state.revision ?? 0) !== (snapshot.revision ?? 0))
      throw new DesktopError("DESKTOP_BINDING_CHANGED", "确认期间本机状态发生变化；未覆盖撤权或重新绑定，请重新操作。");
    const binding: DesktopBinding = sameTarget ? { ...state.binding!, title: confirmed.title } :
      { ...selected, bindingId: randomUUID(), title: confirmed.title, boundAt: new Date().toISOString() };
    state.binding = binding; state.enabled = true;
    return { state, result: { alreadyEnabled: false, enabled: true, binding } };
  });
}

function replay(state: DesktopState, input: z.infer<typeof sendInput>, clientId: string, digest: string): DesktopDelivery | undefined {
  const prior = state.deliveries.find(item => item.commandId === input.commandId);
  if (prior && (prior.intent !== input.intent || prior.clientId !== clientId || prior.bindingId !== input.bindingId || prior.messageSha256 !== digest ||
    prior.messageBytes !== Buffer.byteLength(input.message, "utf8")))
    throw new DesktopError("DESKTOP_COMMAND_CONFLICT", "commandId 的意图、客户端、目标或正文不一致，或旧记录未保存意图；拒绝投递，请通过 status 查询原记录。");
  return prior;
}

function desktopTaskEnvelope(input: z.infer<typeof sendInput>, deliveryId: string): string {
  return JSON.stringify({
    type: "C2C_DESKTOP_TASK",
    version: 2,
    workspaceId: input.workspaceId,
    commandId: input.commandId,
    intent: input.intent,
    deliveryId,
    message: input.message,
  });
}

function assertNoUncertainDelivery(workspace: LocalWorkspace, state: DesktopState) {
  if (unresolvedOutcomeUnknownCommandIds(workspace, state).size > 0)
    throw new DesktopError("DESKTOP_OUTCOME_UNRESOLVED", "已有结果不明的投递；不要更换 commandId 或重新绑定绕过，须在 Desktop 人工核对。");
  if (state.deliveries.length >= 10000)
    throw new DesktopError("DESKTOP_HISTORY_FULL", "投递历史容量已满；保留 ID，须人工迁移后继续。");
}

function sameTarget(left: ExecutorExecutionInfo, right: ReturnType<typeof target>): boolean {
  return left.threadId === right.threadId && left.hostId === right.hostId &&
    left.projectId === right.projectId && left.workspaceRoot === right.workspaceRoot;
}

function receiptBackedTail(workspace: LocalWorkspace, binding: DesktopBinding, active: ExecutorExecutionInfo): boolean {
  if (!sameTarget(active, target(workspace, binding))) return false;
  let records;
  try { records = readExecutionRecordsStrict(workspace.id); } catch { return false; }
  const state = readDesktop(workspace.id);
  if (!state || state.workspaceRoot !== workspace.root || !state.enabled ||
      !state.binding || state.binding.bindingId !== binding.bindingId ||
      unresolvedOutcomeUnknownCommandIds(workspace, state).size > 0) return false;
  const deliveries = state.deliveries.filter(item => item.bindingId === binding.bindingId &&
    item.threadId === binding.threadId && item.deliveryStatus === "accepted" && item.turnId === active.activeTurnId);
  if (deliveries.length !== 1) return false;
  const delivery = deliveries[0];
  const matches = records.filter(record => record.commandId === delivery.commandId || record.taskId === `desktop_${delivery.commandId}`);
  return matches.length === 1 && isTrustedDesktopReceipt(matches[0], delivery.commandId);
}

async function prepareWithPostResultSettle(
  workspace: LocalWorkspace,
  binding: DesktopBinding,
  authorize: () => void,
  options: PostResultSettleOptions = {},
  executor: ExecutorAdapter,
): Promise<ExecutorConnection> {
  try {
    return await executor.prepare(target(workspace, binding));
  } catch (failure) {
    if (!(failure instanceof DesktopError) || failure.code !== "DESKTOP_BUSY") throw failure;
    let active: ExecutorExecutionInfo;
    try { active = await executor.inspectActiveExecution(target(workspace, binding)); }
    catch { throw failure; }
    if (!receiptBackedTail(workspace, binding, active)) throw failure;

    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
    const timeoutMs = options.timeoutMs ?? POST_RESULT_SETTLE_TIMEOUT_MS;
    const pollMs = options.pollMs ?? POST_RESULT_SETTLE_POLL_MS;
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
      authorize();
      const state = authorized(workspace, readDesktop(workspace.id), binding.bindingId);
      assertNoUncertainDelivery(workspace, state);
      try {
        return await executor.prepare(target(workspace, binding));
      } catch (retryFailure) {
        if (!(retryFailure instanceof DesktopError) || retryFailure.code !== "DESKTOP_BUSY") throw retryFailure;
      }
      let current: ExecutorExecutionInfo;
      try { current = await executor.inspectActiveExecution(target(workspace, binding)); }
      catch (error) {
        if (error instanceof DesktopError && error.code === "DESKTOP_BUSY") throw error;
        throw error;
      }
      if (!receiptBackedTail(workspace, binding, current) || current.activeTurnId !== active.activeTurnId) throw failure;
    }
    throw failure;
  }
}

export async function sendDesktop(workspace: LocalWorkspace, raw: z.infer<typeof sendInput>, clientId: string,
  authorize: () => void = () => {}, settleOptions?: PostResultSettleOptions,
  executor: ExecutorAdapter = getExecutor()): Promise<ReturnType<typeof publicDelivery>> {
  const input = sendInput.parse(raw);
  if (input.workspaceId !== workspace.id) throw new DesktopError("DESKTOP_WRONG_WORKSPACE", "请求工作区不匹配。");
  if (!clientId || clientId.length > 256) throw new DesktopError("INSUFFICIENT_SCOPE", "缺少有效的 OAuth 客户端身份。");
  authorize();
  const snapshot = authorized(workspace, readDesktop(workspace.id), input.bindingId);
  const digest = createHash("sha256").update(input.message, "utf8").digest("hex");
  const prior = replay(snapshot, input, clientId, digest);
  if (prior) return publicDelivery(prior);
  // UUID is fixed-width, so this validates the exact envelope byte size before the send commit.
  validateDesktopWireMessage(desktopTaskEnvelope(input, "00000000-0000-4000-8000-000000000000"));
  assertNoUncertainDelivery(workspace, snapshot);
  const connection = await prepareWithPostResultSettle(workspace, snapshot.binding, authorize, settleOptions, executor);
  try {
    // 不跨 IPC 预检持锁；提交点前在短锁内重新读取授权和绑定，防止旧快照越过撤权。
    let committed: { record: DesktopDelivery; attempt: boolean };
    try { committed = updateDesktop<{ record: DesktopDelivery; attempt: boolean }>(workspace.id, previous => {
      authorize();
      const state = authorized(workspace, previous, input.bindingId);
      const existing = replay(state, input, clientId, digest);
      if (existing) return { state, result: { record: existing, attempt: false } };
      assertNoUncertainDelivery(workspace, state);
      const now = new Date().toISOString();
      const record: DesktopDelivery = { commandId: input.commandId, deliveryId: randomUUID(), clientId, bindingId: input.bindingId,
        intent: input.intent,
        messageSha256: digest, messageBytes: Buffer.byteLength(input.message, "utf8"), threadId: state.binding.threadId,
        deliveryStatus: "outcome_unknown", createdAt: now, updatedAt: now };
      state.deliveries.push(record);
      return { state, result: { record, attempt: true } };
    }); } catch (failure) {
      // 原子替换之后的锁清理失败不能导致丢失已保存的 unknown，也不能继续发送。
      if (!(failure instanceof DesktopError)) {
        try {
          const saved = readDesktop(workspace.id);
          const record = saved && replay(saved, input, clientId, digest);
          if (record?.deliveryStatus === "outcome_unknown") return publicDelivery(record);
        } catch { /* 无法核实落盘结果时保留原错误，绝不发送 */ }
      }
      throw failure;
    }
    if (!committed.attempt) return publicDelivery(committed.record);
    const wireMessage = validateDesktopWireMessage(desktopTaskEnvelope(input, committed.record.deliveryId!));
    try {
      // 上面的 fsync/原子替换是本地提交点。此后 disable 不能撤回在途消息，任何不明结果均不重发。
      const receipt = z.object({ threadId: z.string().uuid(), turnId: z.string().uuid() }).strict().parse(await connection.send(wireMessage));
      if (receipt.threadId !== committed.record.threadId) throw new Error("wrong receipt target");
      const accepted = withEvidenceLock(workspace.id, () => updateDesktop(workspace.id, previous => {
        const state = checked(workspace, previous);
        const record = replay(state, input, clientId, digest);
        if (!record || record.threadId !== receipt.threadId || record.deliveryStatus !== "outcome_unknown" ||
          state.deliveries.some(item => item.turnId === receipt.turnId))
          throw new Error("delivery history changed");
        assertNoOutcomeResolutionForCommand(workspace.id, input.commandId);
        record.deliveryStatus = "accepted"; record.turnId = receipt.turnId; record.updatedAt = new Date().toISOString();
        return { state, result: record };
      }));
      return publicDelivery(accepted);
    } catch (failure) {
      // 只信受控适配器明确确认尚未进入 start 的白名单错误；任意 IPC 写入后异常均是 unknown。
      // R2 合同：helper 在 mutation boundary 后已把 protocol error 统一转成
      // OUTCOME_UNKNOWN/notSent=false，因此 PROTOCOL_ERROR+notSent=true 是 pre-start 证据。
      if (failure instanceof DesktopError && (failure as DesktopError & { notSent?: boolean }).notSent === true &&
        DESKTOP_IPC_ERROR_MESSAGES[failure.code] && !["DESKTOP_OUTCOME_UNKNOWN", "DESKTOP_IPC_REJECTED"].includes(failure.code)) {
        try {
          const rejected = withEvidenceLock(workspace.id, () => updateDesktop(workspace.id, previous => {
            const state = checked(workspace, previous);
            const record = replay(state, input, clientId, digest);
            if (!record || record.deliveryStatus !== "outcome_unknown") throw new Error("delivery history changed");
            assertNoOutcomeResolutionForCommand(workspace.id, input.commandId);
            record.deliveryStatus = "rejected"; record.errorCode = failure.code;
            record.errorMessage = DESKTOP_IPC_ERROR_MESSAGES[failure.code]; record.updatedAt = new Date().toISOString();
            return { state, result: record };
          }));
          return publicDelivery(rejected);
        } catch { /* 拒绝结果无法落盘，继续保留 unknown；不重发 */ }
      }
      // 包含回执不匹配、helper 超时/崩溃以及 accepted 无法落盘；不输出可能含正文的底层异常。
      return publicDelivery(committed.record);
    }
  } finally {
    // 清理连接失败不能覆盖已持久化的投递结果，也不能触发重发。
    try { connection.close(); } catch { /* helper 自身另有有界生命周期 */ }
  }
}

export async function desktopStatus(workspace: LocalWorkspace, commandId?: string, executor: ExecutorAdapter = getExecutor()) {
  if (commandId !== undefined) desktopId.parse(commandId);
  let state = checked(workspace, readDesktop(workspace.id));
  let availability: { available: boolean; error?: string; message?: string } = { available: false };
  if (state.binding) {
    try { await executor.inspect(target(workspace, state.binding)); availability = { available: true }; }
    catch (error) {
      availability = { available: false, error: error instanceof DesktopError ? error.code : "DESKTOP_UNAVAILABLE",
        message: error instanceof DesktopError ? error.message : "Desktop 当前不可用；没有发送消息。" };
    }
    const latest = checked(workspace, readDesktop(workspace.id));
    if (latest.binding?.bindingId !== state.binding.bindingId)
      availability = { available: false, error: "DESKTOP_BINDING_CHANGED", message: "查询期间绑定已改变，请重新读取状态。" };
    state = latest;
  }
  const delivery = commandId ? state.deliveries.find(item => item.commandId === commandId) : undefined;
  const unresolved = unresolvedOutcomeUnknownCommandIds(workspace, state);
  const resolutionStatus = delivery && delivery.deliveryStatus === "outcome_unknown" &&
    isOutcomeUnknownAdministrativelyResolved(workspace, delivery.commandId) ? "administratively_resolved" as const : undefined;
  return { workspaceId: workspace.id, enabled: state.enabled, binding: state.binding, availability,
    unresolvedDelivery: unresolved.size > 0,
    delivery: delivery ? { ...publicDelivery(delivery), ...(resolutionStatus ? { resolutionStatus } : {}) } : null };
}
