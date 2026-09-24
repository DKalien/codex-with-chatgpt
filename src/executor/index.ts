import { desktopIpc, type DesktopTarget } from "../desktop/ipc.js";

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
  inspect(target: ExecutorTarget): Promise<ExecutorSessionInfo>;
  currentIdentity(workspaceRoot: string): Promise<ExecutorSessionInfo>;
  confirmCurrent(workspaceRoot: string): Promise<ExecutorSessionInfo>;
  prepare(target: ExecutorTarget): Promise<ExecutorConnection>;
  inspectActiveExecution(target: ExecutorTarget): Promise<ExecutorExecutionInfo>;
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

  inspect(target: ExecutorTarget): Promise<ExecutorSessionInfo> {
    return desktopIpc.inspect(target as DesktopTarget);
  }

  currentIdentity(workspaceRoot: string): Promise<ExecutorSessionInfo> {
    return desktopIpc.currentIdentity(workspaceRoot);
  }

  confirmCurrent(workspaceRoot: string): Promise<ExecutorSessionInfo> {
    return desktopIpc.confirmCurrent(workspaceRoot);
  }

  prepare(target: ExecutorTarget): Promise<ExecutorConnection> {
    return desktopIpc.prepare(target as DesktopTarget);
  }

  inspectActiveExecution(target: ExecutorTarget): Promise<ExecutorExecutionInfo> {
    return desktopIpc.inspectActiveExecution(target as DesktopTarget);
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
