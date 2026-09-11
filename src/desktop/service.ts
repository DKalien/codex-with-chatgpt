import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Workspace } from "../workspace/manager.js";
import { desktopIpc, DESKTOP_IPC_ERROR_MESSAGES } from "./ipc.js";
import { DesktopError, desktopId, publicDelivery, readDesktop, sendInput, targetInput, updateDesktop,
  type DesktopBinding, type DesktopDelivery, type DesktopState } from "./store.js";

type LocalWorkspace = Pick<Workspace, "id" | "root">;
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

export async function bindDesktop(workspace: LocalWorkspace, raw: z.infer<typeof targetInput>): Promise<DesktopBinding> {
  const input = targetInput.parse(raw);
  const observed = await desktopIpc.inspect(target(workspace, input));
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
export async function bindCurrentDesktop(workspace: LocalWorkspace) {
  assertNoUncertainDelivery(checked(workspace, readDesktop(workspace.id)));
  const observed = await desktopIpc.currentIdentity(workspace.root);
  const selected = targetInput.parse({ threadId: observed.threadId, hostId: observed.hostId, projectId: observed.projectId });
  const snapshot = checked(workspace, readDesktop(workspace.id));
  assertNoUncertainDelivery(snapshot);
  const sameTarget = snapshot.binding && snapshot.binding.threadId === selected.threadId &&
    snapshot.binding.hostId === selected.hostId && snapshot.binding.projectId === selected.projectId;
  if (sameTarget && snapshot.enabled) return { alreadyEnabled: true, enabled: true, binding: snapshot.binding! };

  // 普通 userMessage 不能证明来自本地 composer；只接受本机固定确认框，不能由 prompt 免除。
  const confirmed = await desktopIpc.confirmCurrent(workspace.root);
  if (confirmed.threadId !== selected.threadId || confirmed.hostId !== selected.hostId ||
    confirmed.projectId !== selected.projectId || confirmed.title !== observed.title)
    throw new DesktopError("DESKTOP_BINDING_CHANGED", "确认期间目标身份发生变化；未绑定或启用，请重新操作。");
  return updateDesktop(workspace.id, previous => {
    const state = checked(workspace, previous);
    assertNoUncertainDelivery(state);
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
function assertNoUncertainDelivery(state: DesktopState) {
  if (state.deliveries.some(item => item.deliveryStatus === "outcome_unknown"))
    throw new DesktopError("DESKTOP_OUTCOME_UNRESOLVED", "已有结果不明的投递；不要更换 commandId 或重新绑定绕过，须在 Desktop 人工核对。");
  if (state.deliveries.length >= 10000)
    throw new DesktopError("DESKTOP_HISTORY_FULL", "投递历史容量已满；保留 ID，须人工迁移后继续。");
}

export async function sendDesktop(workspace: LocalWorkspace, raw: z.infer<typeof sendInput>, clientId: string,
  authorize: () => void = () => {}): Promise<ReturnType<typeof publicDelivery>> {
  const input = sendInput.parse(raw);
  if (input.workspaceId !== workspace.id) throw new DesktopError("DESKTOP_WRONG_WORKSPACE", "请求工作区不匹配。");
  if (!clientId || clientId.length > 256) throw new DesktopError("INSUFFICIENT_SCOPE", "缺少有效的 OAuth 客户端身份。");
  authorize();
  const snapshot = authorized(workspace, readDesktop(workspace.id), input.bindingId);
  const digest = createHash("sha256").update(input.message, "utf8").digest("hex");
  const prior = replay(snapshot, input, clientId, digest);
  if (prior) return publicDelivery(prior);
  assertNoUncertainDelivery(snapshot);
  const connection = await desktopIpc.prepare(target(workspace, snapshot.binding));
  try {
    // 不跨 IPC 预检持锁；提交点前在短锁内重新读取授权和绑定，防止旧快照越过撤权。
    let committed: { record: DesktopDelivery; attempt: boolean };
    try { committed = updateDesktop<{ record: DesktopDelivery; attempt: boolean }>(workspace.id, previous => {
      authorize();
      const state = authorized(workspace, previous, input.bindingId);
      const existing = replay(state, input, clientId, digest);
      if (existing) return { state, result: { record: existing, attempt: false } };
      assertNoUncertainDelivery(state);
      const now = new Date().toISOString();
      const record: DesktopDelivery = { commandId: input.commandId, clientId, bindingId: input.bindingId,
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
    try {
      // 上面的 fsync/原子替换是本地提交点。此后 disable 不能撤回在途消息，任何不明结果均不重发。
      const receipt = z.object({ threadId: z.string().uuid(), turnId: z.string().uuid() }).strict().parse(await connection.send(input.message));
      if (receipt.threadId !== committed.record.threadId) throw new Error("wrong receipt target");
      const accepted = updateDesktop(workspace.id, previous => {
        const state = checked(workspace, previous);
        const record = replay(state, input, clientId, digest);
        if (!record || record.threadId !== receipt.threadId || record.deliveryStatus !== "outcome_unknown" ||
          state.deliveries.some(item => item.turnId === receipt.turnId))
          throw new Error("delivery history changed");
        record.deliveryStatus = "accepted"; record.turnId = receipt.turnId; record.updatedAt = new Date().toISOString();
        return { state, result: record };
      });
      return publicDelivery(accepted);
    } catch (failure) {
      // 只信受控适配器明确确认尚未进入 start 的白名单错误；任意 IPC 写入后异常均是 unknown。
      if (failure instanceof DesktopError && (failure as DesktopError & { notSent?: boolean }).notSent === true &&
        DESKTOP_IPC_ERROR_MESSAGES[failure.code] && !["DESKTOP_OUTCOME_UNKNOWN", "DESKTOP_PROTOCOL_ERROR", "DESKTOP_IPC_REJECTED"].includes(failure.code)) {
        try {
          const rejected = updateDesktop(workspace.id, previous => {
            const state = checked(workspace, previous);
            const record = replay(state, input, clientId, digest);
            if (!record || record.deliveryStatus !== "outcome_unknown") throw new Error("delivery history changed");
            record.deliveryStatus = "rejected"; record.errorCode = failure.code;
            record.errorMessage = DESKTOP_IPC_ERROR_MESSAGES[failure.code]; record.updatedAt = new Date().toISOString();
            return { state, result: record };
          });
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

export async function desktopStatus(workspace: LocalWorkspace, commandId?: string) {
  if (commandId !== undefined) desktopId.parse(commandId);
  let state = checked(workspace, readDesktop(workspace.id));
  let availability: { available: boolean; error?: string; message?: string } = { available: false };
  if (state.binding) {
    try { await desktopIpc.inspect(target(workspace, state.binding)); availability = { available: true }; }
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
  return { workspaceId: workspace.id, enabled: state.enabled, binding: state.binding, availability,
    unresolvedDelivery: state.deliveries.some(item => item.deliveryStatus === "outcome_unknown"),
    delivery: delivery ? publicDelivery(delivery) : null };
}
