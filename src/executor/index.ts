import { desktopIpc, type DesktopTarget } from "../desktop/ipc.js";
import type { DesktopRuntimeFence } from "../desktop/ipc-contracts.js";
import { requireDesktopRuntimeFence } from "../desktop/store.js";
import {
  parseExecutorBindingCandidate,
  type ExecutorBinding,
  type ExecutorBindingCandidate,
} from "../endpoints/schema.js";
import {
  parseExecutorPluginDescriptor,
  type ExecutorActiveExecutionProjection,
  type ExecutorPlugin,
  type ExecutorPluginCapabilities,
  type ExecutorPluginDescriptor,
  type ExecutorSessionProjection,
} from "../endpoints/executor-contract.js";

import { codexExecutorProjectId, CodexTargetTranslationError } from "./codex-target.js";
export { CodexTargetTranslationError } from "./codex-target.js";

export const CODEX_DESKTOP_EXECUTOR_ID = "codex-desktop" as const;

export interface ExecutorCapabilities {
  readonly existingSessionBinding: boolean;
  readonly createSession: boolean;
  readonly delivery: boolean;
  readonly busyActiveInspection: boolean;
  readonly approvalVisibility: boolean;
  readonly trustedTerminalReceipt: boolean;
  readonly cancellationInterrupt: boolean;
}

export interface ExecutorDescriptor {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly capabilities: ExecutorCapabilities;
}

export interface ExecutorTarget {
  readonly threadId: string;
  readonly hostId: string;
  readonly projectId: string;
  readonly workspaceRoot: string;
}

export interface ExecutorSessionInfo extends ExecutorTarget {
  readonly title: string;
  readonly runtimeStatus?: string;
  readonly requestsCount?: number;
  /** Internal Desktop process fence; omitted from generic projections. */
  readonly runtimeFence?: DesktopRuntimeFence;
}

/** 连接可用不代表空闲；缺少审批或运行状态时保守返回 unknown。 */
export function projectDesktopActivity(session: ExecutorSessionInfo): ExecutorSessionProjection["activity"] {
  return session.requestsCount === undefined ? "unknown"
    : session.requestsCount > 0 ? "approval_required"
      : session.runtimeStatus === "idle" ? "idle"
        : session.runtimeStatus === "active" || session.runtimeStatus === "inProgress" ? "busy" : "unknown";
}

export interface ExecutorExecutionInfo extends ExecutorTarget {
  readonly activeTurnId: string;
}

export interface ExecutorConnection {
  send(message: string): Promise<{ threadId: string; turnId: string }>;
  close(): void;
}

export interface ExecutorAdapter {
  readonly descriptor: ExecutorDescriptor;
  /** 首次显式绑定专用 discovery；不接受 runtime fence。 */
  discoverForBinding?(target: ExecutorTarget): Promise<ExecutorSessionInfo>;
  inspect(target: ExecutorTarget, runtimeFence?: DesktopRuntimeFence): Promise<ExecutorSessionInfo>;
  currentIdentity(workspaceRoot: string): Promise<ExecutorSessionInfo>;
  confirmCurrent(workspaceRoot: string): Promise<ExecutorSessionInfo>;
  prepare(target: ExecutorTarget, runtimeFence?: DesktopRuntimeFence): Promise<ExecutorConnection>;
  inspectActiveExecution(target: ExecutorTarget, runtimeFence?: DesktopRuntimeFence): Promise<ExecutorExecutionInfo>;
}

const CODEX_DESKTOP_CAPABILITIES: ExecutorCapabilities = Object.freeze({
  existingSessionBinding: true,
  createSession: false,
  delivery: true,
  busyActiveInspection: true,
  approvalVisibility: true,
  trustedTerminalReceipt: true,
  cancellationInterrupt: false,
});

const CODEX_DESKTOP_DESCRIPTOR: ExecutorDescriptor = Object.freeze({
  id: CODEX_DESKTOP_EXECUTOR_ID,
  kind: CODEX_DESKTOP_EXECUTOR_ID,
  name: "Codex Desktop",
  capabilities: CODEX_DESKTOP_CAPABILITIES,
});

/** 只包装现有 IPC；身份、owner、审批和 busy 校验仍由 desktopIpc/helper 负责。 */
export class CodexDesktopAdapter implements ExecutorAdapter {
  readonly descriptor = CODEX_DESKTOP_DESCRIPTOR;

  discoverForBinding(target: ExecutorTarget): Promise<ExecutorSessionInfo> {
    return desktopIpc.discoverForBinding(target as DesktopTarget) as Promise<ExecutorSessionInfo>;
  }

  inspect(target: ExecutorTarget, runtimeFence?: DesktopRuntimeFence): Promise<ExecutorSessionInfo> {
    return desktopIpc.inspect(target as DesktopTarget, runtimeFence) as Promise<ExecutorSessionInfo>;
  }

  currentIdentity(workspaceRoot: string): Promise<ExecutorSessionInfo> {
    return desktopIpc.currentIdentity(workspaceRoot);
  }

  confirmCurrent(workspaceRoot: string): Promise<ExecutorSessionInfo> {
    return desktopIpc.confirmCurrent(workspaceRoot);
  }

  prepare(target: ExecutorTarget, runtimeFence?: DesktopRuntimeFence): Promise<ExecutorConnection> {
    return desktopIpc.prepare(target as DesktopTarget, runtimeFence);
  }

  inspectActiveExecution(target: ExecutorTarget, runtimeFence?: DesktopRuntimeFence): Promise<ExecutorExecutionInfo> {
    return desktopIpc.inspectActiveExecution(target as DesktopTarget, runtimeFence);
  }
}

export const codexDesktopAdapter = new CodexDesktopAdapter();

/** foreign plugin 或 malformed locator 在调用 Desktop adapter 前拒绝。 */
function translateBindingToCodexTarget(
  input: Pick<ExecutorBinding, "pluginId" | "workspaceRoot" | "instanceId" | "sessionId" | "locator">,
): ExecutorTarget {
  if (input.pluginId !== CODEX_DESKTOP_EXECUTOR_ID) {
    throw new CodexTargetTranslationError(
      "FOREIGN_PLUGIN",
      `generic target pluginId ${input.pluginId} 不是 Codex Desktop`,
    );
  }
  const projectId = codexExecutorProjectId(input.locator);
  return {
    threadId: input.sessionId,
    hostId: input.instanceId,
    projectId,
    workspaceRoot: input.workspaceRoot,
  };
}

/**
 * R5a projection：Codex Desktop target → generic ExecutorBindingCandidate。
 * 只投影 session identity；不铸造 bindingId/epoch/boundAt（Bridge 所有）。
 * 不修改 desktop persisted state。
 */
export function projectCodexDesktopTargetToExecutorBindingCandidate(input: {
  readonly target: ExecutorTarget;
  readonly workspaceId: string;
  readonly instanceId?: string;
}): ExecutorBindingCandidate {
  return parseExecutorBindingCandidate({
    pluginId: CODEX_DESKTOP_EXECUTOR_ID,
    workspaceId: input.workspaceId,
    workspaceRoot: input.target.workspaceRoot,
    instanceId: input.instanceId ?? input.target.hostId,
    sessionId: input.target.threadId,
    locator: { executorProjectId: input.target.projectId },
  });
}

const CODEX_DESKTOP_PLUGIN_CAPABILITIES: ExecutorPluginCapabilities = Object.freeze({
  bindExistingSession: CODEX_DESKTOP_CAPABILITIES.existingSessionBinding,
  createSession: CODEX_DESKTOP_CAPABILITIES.createSession,
  delivery: CODEX_DESKTOP_CAPABILITIES.delivery,
  activeExecutionInspection: CODEX_DESKTOP_CAPABILITIES.busyActiveInspection,
  approvalVisibility: CODEX_DESKTOP_CAPABILITIES.approvalVisibility,
  trustedTerminalReceipt: CODEX_DESKTOP_CAPABILITIES.trustedTerminalReceipt,
  cancellationInterrupt: CODEX_DESKTOP_CAPABILITIES.cancellationInterrupt,
  resume: false,
});

const CODEX_DESKTOP_PLUGIN_DESCRIPTOR: ExecutorPluginDescriptor = parseExecutorPluginDescriptor(
  Object.freeze({
    pluginId: CODEX_DESKTOP_DESCRIPTOR.id,
    kind: CODEX_DESKTOP_DESCRIPTOR.kind,
    name: CODEX_DESKTOP_DESCRIPTOR.name,
    capabilities: CODEX_DESKTOP_PLUGIN_CAPABILITIES,
  }),
);

/**
 * Codex Desktop 作为第一个 production Executor Plugin。
 * Codex-specific identity/evidence 仍留在 Desktop domain；这里只做 generic contract 适配。
 */
export class CodexDesktopExecutorPlugin implements ExecutorPlugin {
  readonly descriptor = CODEX_DESKTOP_PLUGIN_DESCRIPTOR;
  private readonly adapter: ExecutorAdapter;

  constructor(adapter: ExecutorAdapter = codexDesktopAdapter) {
    this.adapter = adapter;
  }

  async discoverCurrent(context: {
    readonly workspaceRoot: string;
    readonly workspaceId: string;
  }): Promise<ExecutorBindingCandidate> {
    const session = await this.adapter.currentIdentity(context.workspaceRoot);
    return projectCodexDesktopTargetToExecutorBindingCandidate({
      target: session,
      workspaceId: context.workspaceId,
    });
  }

  async inspectSession(binding: ExecutorBinding): Promise<ExecutorSessionProjection> {
    const target = translateBindingToCodexTarget(binding);
    const session = await this.adapter.inspect(target, requireDesktopRuntimeFence(binding.workspaceId, binding.workspaceRoot));
    return {
      sessionId: session.threadId,
      instanceId: session.hostId,
      locator: { executorProjectId: session.projectId },
      activity: projectDesktopActivity(session),
    };
  }

  async inspectActiveExecution(binding: ExecutorBinding): Promise<ExecutorActiveExecutionProjection> {
    const target = translateBindingToCodexTarget(binding);
    const info = await this.adapter.inspectActiveExecution(target, requireDesktopRuntimeFence(binding.workspaceId, binding.workspaceRoot));
    return { active: Boolean(info.activeTurnId), executionId: info.activeTurnId };
  }
}

export const codexDesktopExecutorPlugin = new CodexDesktopExecutorPlugin();
