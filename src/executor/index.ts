import { desktopIpc, type DesktopTarget } from "../desktop/ipc.js";
import type { DesktopRuntimeFence } from "../desktop/ipc-contracts.js";
import { requireDesktopRuntimeFence } from "../desktop/store.js";
import {
  parseExecutorBindingCandidate,
  type ExecutorBinding,
  type ExecutorBindingCandidate,
  type ExecutorDeliveryTargetSnapshot,
} from "../endpoints/schema.js";
import {
  parseExecutorDeliveryAcceptance,
  parseExecutorPluginDescriptor,
  type ExecutorActiveExecutionProjection,
  type ExecutorDeliveryAcceptance,
  type ExecutorDeliveryRequest,
  type ExecutorPlugin,
  type ExecutorPluginCapabilities,
  type ExecutorPluginDescriptor,
  type ExecutorSessionProjection,
} from "../endpoints/executor-contract.js";

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

export interface ExecutorRegistry {
  get(id: string): ExecutorAdapter;
  list(): readonly ExecutorDescriptor[];
}

/** 固定内置注册表；不做插件发现、PATH 探测、网络发现或动态加载。 */
export function createExecutorRegistry(adapters: readonly ExecutorAdapter[] = [codexDesktopAdapter]): ExecutorRegistry {
  const byId = new Map<string, ExecutorAdapter>();
  for (const adapter of adapters) {
    if (byId.has(adapter.descriptor.id)) throw new Error(`Duplicate executor id: ${adapter.descriptor.id}`);
    byId.set(adapter.descriptor.id, adapter);
  }
  return Object.freeze({
    get(id: string): ExecutorAdapter {
      const adapter = byId.get(id);
      if (!adapter) throw new Error(`Unknown executor: ${id}`);
      return adapter;
    },
    list(): readonly ExecutorDescriptor[] {
      return [...byId.values()].map(adapter => adapter.descriptor);
    },
  });
}

export const executorRegistry = createExecutorRegistry();

export function getExecutor(id: string = CODEX_DESKTOP_EXECUTOR_ID): ExecutorAdapter {
  return executorRegistry.get(id);
}

/**
 * 窄翻译边界：generic Codex binding/snapshot → 已校验的 legacy ExecutorTarget。
 * foreign pluginId 或 malformed locator 在调用 Desktop adapter 前 fail closed。
 */
export class CodexTargetTranslationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CodexTargetTranslationError";
  }
}

const CODEX_EXECUTOR_PROJECT_KEY = "executorProjectId";
const CODEX_EXECUTOR_PROJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;

function translateGenericToCodexTarget(input: {
  readonly pluginId: string;
  readonly workspaceRoot: string;
  readonly instanceId: string;
  readonly sessionId: string;
  readonly locator: Readonly<Record<string, string>>;
}): ExecutorTarget {
  if (input.pluginId !== CODEX_DESKTOP_EXECUTOR_ID) {
    throw new CodexTargetTranslationError(
      "FOREIGN_PLUGIN",
      `generic target pluginId ${input.pluginId} 不是 Codex Desktop`,
    );
  }
  const keys = Object.keys(input.locator).sort();
  if (keys.length !== 1 || keys[0] !== CODEX_EXECUTOR_PROJECT_KEY) {
    throw new CodexTargetTranslationError(
      "LOCATOR_INVALID",
      "Codex locator 必须且只包含 executorProjectId",
    );
  }
  const projectId = input.locator[CODEX_EXECUTOR_PROJECT_KEY];
  if (typeof projectId !== "string" || !CODEX_EXECUTOR_PROJECT_ID.test(projectId)) {
    throw new CodexTargetTranslationError(
      "LOCATOR_INVALID",
      "executorProjectId 不是有效 bounded 值",
    );
  }
  return {
    threadId: input.sessionId,
    hostId: input.instanceId,
    projectId,
    workspaceRoot: input.workspaceRoot,
  };
}

function translateBindingToCodexTarget(
  binding: Pick<ExecutorBinding, "pluginId" | "workspaceRoot" | "instanceId" | "sessionId" | "locator">,
): ExecutorTarget {
  return translateGenericToCodexTarget({
    pluginId: binding.pluginId,
    workspaceRoot: binding.workspaceRoot,
    instanceId: binding.instanceId,
    sessionId: binding.sessionId,
    locator: binding.locator,
  });
}

function translateSnapshotToCodexTarget(
  target: Pick<ExecutorDeliveryTargetSnapshot, "pluginId" | "workspaceRoot" | "instanceId" | "sessionId" | "locator">,
): ExecutorTarget {
  return translateGenericToCodexTarget({
    pluginId: target.pluginId,
    workspaceRoot: target.workspaceRoot,
    instanceId: target.instanceId,
    sessionId: target.sessionId,
    locator: target.locator,
  });
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
  bindExistingSession: true,
  createSession: false,
  delivery: true,
  activeExecutionInspection: true,
  approvalVisibility: true,
  trustedTerminalReceipt: true,
  cancellationInterrupt: false,
  resume: false,
});

const CODEX_DESKTOP_PLUGIN_DESCRIPTOR: ExecutorPluginDescriptor = parseExecutorPluginDescriptor(
  Object.freeze({
    pluginId: CODEX_DESKTOP_EXECUTOR_ID,
    kind: CODEX_DESKTOP_EXECUTOR_ID,
    name: "Codex Desktop",
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
      activity: session.requestsCount === undefined ? "unknown"
        : session.requestsCount > 0 ? "approval_required"
          : session.runtimeStatus === "idle" ? "idle"
            : session.runtimeStatus === "active" || session.runtimeStatus === "inProgress" ? "busy" : "unknown",
    };
  }

  async deliver(request: ExecutorDeliveryRequest): Promise<ExecutorDeliveryAcceptance> {
    let target: ExecutorTarget;
    try {
      target = translateSnapshotToCodexTarget(request.target);
    } catch (error) {
      if (error instanceof CodexTargetTranslationError) {
        return parseExecutorDeliveryAcceptance({
          status: "rejected",
          reasonCode: error.code.toLowerCase(),
          reason: "generic target is not a valid Codex Desktop delivery target",
        });
      }
      throw error;
    }
    const connection = await this.adapter.prepare(target, requireDesktopRuntimeFence(request.target.workspaceId, request.target.workspaceRoot));
    try {
      const sent = await connection.send(request.payload);
      if (sent.threadId !== request.target.sessionId) {
        return parseExecutorDeliveryAcceptance({
          status: "rejected",
          reasonCode: "session_mismatch",
          reason: "returned session identity does not match frozen delivery target",
        });
      }
      return parseExecutorDeliveryAcceptance({
        status: "accepted",
        deliveryId: sent.turnId,
      });
    } finally {
      connection.close();
    }
  }

  async inspectActiveExecution(binding: ExecutorBinding): Promise<ExecutorActiveExecutionProjection> {
    const target = translateBindingToCodexTarget(binding);
    const info = await this.adapter.inspectActiveExecution(target, requireDesktopRuntimeFence(binding.workspaceId, binding.workspaceRoot));
    return { active: Boolean(info.activeTurnId), executionId: info.activeTurnId };
  }
}

export const codexDesktopExecutorPlugin = new CodexDesktopExecutorPlugin();
