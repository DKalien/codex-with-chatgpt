import { randomUUID } from "node:crypto";
import {
  freezeExecutorDeliveryTarget,
  locatorExactEqual,
  type ExecutorBinding,
  type ExecutorBindingCandidate,
  type ExecutorDeliveryTargetSnapshot,
} from "../endpoints/schema.js";
import {
  ExecutorControlError,
  isSameExecutorCandidate,
  type ExecutorAvailability,
  type ExecutorPluginSummary,
  type ExecutorStatusProjection,
} from "./schema.js";
import { nextEpoch, readExecutorControl, updateExecutorControlDetailed } from "./store.js";
import { withEndpointSwitchLock } from "../endpoint-switch/lock.js";
import {
  getProductionExecutorPlugin,
  hasProductionExecutorPlugin,
  listProductionExecutorPlugins,
} from "./registry.js";
import { createCodexDesktopProductionBackend, type ExecutorProductionBackend } from "./codex-backend.js";

export interface ActiveExecutorBindingResult {
  readonly binding: ExecutorBinding;
  readonly created: boolean;
  readonly noWrite?: boolean;
}

function pluginSummaries(): readonly ExecutorPluginSummary[] {
  return listProductionExecutorPlugins().map(plugin => ({
    pluginId: plugin.descriptor.pluginId,
    kind: plugin.descriptor.kind,
    name: plugin.descriptor.name,
    capabilities: { ...plugin.descriptor.capabilities },
  }));
}

function assertWorkspace(workspaceId: string, workspaceRoot: string): void {
  const state = readExecutorControl(workspaceId);
  if (state && state.workspaceRoot !== workspaceRoot) {
    throw new ExecutorControlError(
      "EXECUTOR_CONTROL_WORKSPACE_MISMATCH",
      "active executor binding 状态不属于当前 workspaceRoot。",
    );
  }
}

export function listExecutorPlugins(): readonly ExecutorPluginSummary[] {
  return pluginSummaries();
}

export function readActiveExecutorBinding(
  workspaceId: string,
  workspaceRoot: string,
): ExecutorBinding | null {
  assertWorkspace(workspaceId, workspaceRoot);
  return readExecutorControl(workspaceId)?.activeBinding ?? null;
}

/**
 * 显式本地 bind-current：只接受已在本地确认过的 candidate。
 * 同一 candidate 在锁内幂等 noWrite；identity 变化则新 bindingId + epoch+1。
 * R5e：全程持有 endpoint switch lock（executor 域），与 dispatch target pin 串行。
 */
export function bindCurrentExecutor(
  workspaceId: string,
  workspaceRoot: string,
  candidate: ExecutorBindingCandidate,
): ActiveExecutorBindingResult {
  if (candidate.workspaceId !== workspaceId || candidate.workspaceRoot !== workspaceRoot) {
    throw new ExecutorControlError(
      "EXECUTOR_CONTROL_WORKSPACE_MISMATCH",
      "candidate workspace 与当前 workspace 不一致。",
    );
  }
  if (!hasProductionExecutorPlugin(candidate.pluginId)) {
    throw new ExecutorControlError(
      "EXECUTOR_CONTROL_UNKNOWN_PLUGIN",
      `plugin ${candidate.pluginId} 不在 production registry。`,
    );
  }
  return withEndpointSwitchLock("executor", workspaceId, () =>
    updateExecutorControlDetailed<ActiveExecutorBindingResult>(
      workspaceId,
      workspaceRoot,
      (previous) => {
        const active = previous?.activeBinding ?? null;
        if (active && previous && isSameExecutorCandidate(active, candidate)) {
          return {
            state: previous,
            result: { binding: active, created: false, noWrite: true },
            noWrite: true,
          };
        }
        const epoch = active ? nextEpoch(active.epoch) : 1;
        const binding: ExecutorBinding = {
          version: 1,
          bindingId: randomUUID(),
          pluginId: candidate.pluginId,
          workspaceId: candidate.workspaceId,
          workspaceRoot: candidate.workspaceRoot,
          instanceId: candidate.instanceId,
          sessionId: candidate.sessionId,
          locator: candidate.locator,
          epoch,
          boundAt: new Date().toISOString(),
        };
        return {
          state: {
            version: 1,
            workspaceId,
            workspaceRoot,
            revision: (previous?.revision ?? 0) + 1,
            activeBinding: binding,
          },
          result: { binding, created: true },
        };
      },
    ).result,
  );
}

export async function executorStatus(
  workspaceId: string,
  workspaceRoot: string,
): Promise<ExecutorStatusProjection> {
  const plugins = pluginSummaries();
  let activeBinding: ExecutorBinding | null = null;
  try {
    activeBinding = readActiveExecutorBinding(workspaceId, workspaceRoot);
  } catch {
    return {
      workspaceId,
      activeBinding: null,
      plugins,
      availability: {
        available: false,
        reasonCode: "store_corrupt",
        message: "active executor binding 状态不可读。",
      },
    };
  }
  if (!activeBinding) {
    return {
      workspaceId,
      activeBinding: null,
      plugins,
      availability: { available: false, reasonCode: "no_active_binding", message: "尚未执行本地 bind-current。" },
    };
  }
  if (!hasProductionExecutorPlugin(activeBinding.pluginId)) {
    return {
      workspaceId,
      activeBinding,
      plugins,
      availability: {
        available: false,
        reasonCode: "plugin_missing",
        message: "active binding 的 plugin 不在 production registry。",
      },
    };
  }
  try {
    const plugin = getProductionExecutorPlugin(activeBinding.pluginId);
    const session = await plugin.inspectSession(activeBinding);
    const stale =
      session.sessionId !== activeBinding.sessionId ||
      session.instanceId !== activeBinding.instanceId ||
      !locatorExactEqual(
        session.locator as Record<string, string>,
        activeBinding.locator,
      );
    if (stale) {
      return {
        workspaceId,
        activeBinding,
        plugins,
        availability: {
          available: false,
          reasonCode: "binding_stale",
          message: "active binding 的 session 已变化；请重新 bind-current。",
        },
      };
    }
    return {
      workspaceId,
      activeBinding,
      plugins,
      availability: { available: true },
      ...(session.activity ? { activity: session.activity } : {}),
    };
  } catch {
    return {
      workspaceId,
      activeBinding,
      plugins,
      availability: {
        available: false,
        reasonCode: "inspect_failed",
        message: "无法检查 active binding 可用性。",
      },
    };
  }
}

export function freezeActiveDeliveryTarget(binding: ExecutorBinding): ExecutorDeliveryTargetSnapshot {
  return freezeExecutorDeliveryTarget(binding);
}

export function resolveProductionBackend(pluginId: string): ExecutorProductionBackend {
  if (pluginId !== "codex-desktop") {
    throw new ExecutorControlError(
      "EXECUTOR_CONTROL_NO_BACKEND",
      `plugin ${pluginId} 没有 production delivery backend。`,
    );
  }
  return createCodexDesktopProductionBackend();
}
