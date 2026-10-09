import { codexDesktopAdapter, type ExecutorAdapter } from "../executor/index.js";
import type { DesktopRuntimeFence } from "./ipc-contracts.js";
import { DesktopError, targetInput, type DesktopBinding } from "./store.js";

export function desktopBindingTarget(workspace: { root: string }, binding: Pick<DesktopBinding, "threadId" | "hostId" | "projectId">) {
  return { ...targetInput.parse({ threadId: binding.threadId, hostId: binding.hostId, projectId: binding.projectId }), workspaceRoot: workspace.root };
}

export function requireBindingRuntimeFence(fence: DesktopRuntimeFence | null | undefined): DesktopRuntimeFence {
  if (!fence) throw new DesktopError("DESKTOP_RUNTIME_FENCE_MISSING", "Desktop 绑定缺少运行时身份 fence；请重新绑定当前 Desktop 会话。");
  return fence;
}

/** 只检查保存的精确目标；当前会话、授权及 await 后状态核验仍由入口负责。 */
export async function inspectDesktopBinding(workspace: { root: string }, binding: Pick<DesktopBinding, "threadId" | "hostId" | "projectId">,
  fence: DesktopRuntimeFence | null | undefined, executor: ExecutorAdapter = codexDesktopAdapter) {
  const target = desktopBindingTarget(workspace, binding);
  const session = await executor.inspect(target, requireBindingRuntimeFence(fence));
  if (session.threadId !== target.threadId || session.hostId !== target.hostId ||
      session.projectId !== target.projectId || session.workspaceRoot !== target.workspaceRoot) {
    throw new DesktopError("DESKTOP_BINDING_CHANGED", "检查返回的 Desktop 目标与保存的绑定不一致。");
  }
  return session;
}
