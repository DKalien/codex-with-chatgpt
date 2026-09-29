import { randomUUID } from "node:crypto";
import {
  createWebSinkBinding,
  freezeWebSinkSendTarget,
  type WebSinkBinding,
  type WebSinkBindingCandidate,
  type WebSinkSendTargetSnapshot,
} from "../endpoints/schema.js";
import {
  WebSinkControlError,
  isSameWebSinkCandidate,
  type WebSinkPluginSummary,
  type WebSinkStatusProjection,
} from "./schema.js";
import { nextWebSinkEpoch, readWebSinkControl, updateWebSinkControlDetailed } from "./store.js";
import { hasProductionWebSinkSurface, listProductionWebSinkSurfaces } from "./registry.js";

export interface ActiveWebSinkBindingResult {
  readonly binding: WebSinkBinding;
  readonly created: boolean;
  readonly noWrite?: boolean;
}

function pluginSummaries(): readonly WebSinkPluginSummary[] {
  return listProductionWebSinkSurfaces().map(surface => ({
    pluginId: surface.pluginId,
    surfaceId: surface.surfaceId,
    name: surface.name,
    capabilities: { ...surface.capabilities },
  }));
}

export function listWebSinkSurfaces(): readonly WebSinkPluginSummary[] {
  return pluginSummaries();
}

export function readActiveWebSinkBinding(workspaceId: string): WebSinkBinding | null {
  return readWebSinkControl(workspaceId)?.activeBinding ?? null;
}

/**
 * Bridge 盖章绑定 Web Sink candidate。
 * 同一 candidate 幂等 noWrite；canonicalUrl 变化则新 bindingId + epoch+1。
 */
export function bindCurrentWebSink(
  workspaceId: string,
  candidate: WebSinkBindingCandidate,
): ActiveWebSinkBindingResult {
  if (candidate.workspaceId !== workspaceId) {
    throw new WebSinkControlError(
      "WEB_SINK_WORKSPACE_MISMATCH",
      "candidate workspace 与当前 workspace 不一致。",
    );
  }
  if (!hasProductionWebSinkSurface(candidate.pluginId, candidate.surfaceId)) {
    throw new WebSinkControlError(
      "WEB_SINK_UNKNOWN_SURFACE",
      `surface ${candidate.pluginId}/${candidate.surfaceId} 不在 production registry。`,
    );
  }
  return updateWebSinkControlDetailed<ActiveWebSinkBindingResult>(
    workspaceId,
    (previous) => {
      const active = previous?.activeBinding ?? null;
      if (active && previous && isSameWebSinkCandidate(active, candidate)) {
        return {
          state: previous,
          result: { binding: active, created: false, noWrite: true },
          noWrite: true,
        };
      }
      const epoch = active ? nextWebSinkEpoch(active.epoch) : 1;
      const binding = createWebSinkBinding(candidate, {
        bindingId: randomUUID(),
        epoch,
        boundAt: new Date().toISOString(),
      });
      return {
        state: {
          version: 1,
          workspaceId,
          revision: (previous?.revision ?? 0) + 1,
          activeBinding: binding,
        },
        result: { binding, created: true },
      };
    },
  ).result;
}

export async function webSinkStatus(
  workspaceId: string,
  options?: {
    readonly companionRouteCanonical?: string | null;
    readonly companionVerified?: boolean;
    readonly companionAvailable?: boolean;
  },
): Promise<WebSinkStatusProjection> {
  const plugins = pluginSummaries();
  let activeBinding: WebSinkBinding | null = null;
  try {
    activeBinding = readActiveWebSinkBinding(workspaceId);
  } catch {
    return {
      workspaceId,
      activeBinding: null,
      plugins,
      availability: {
        available: false,
        reasonCode: "store_corrupt",
        message: "active web sink binding 状态不可读。",
      },
    };
  }
  if (!activeBinding) {
    return {
      workspaceId,
      activeBinding: null,
      plugins,
      availability: {
        available: false,
        reasonCode: "no_active_binding",
        message: "尚未绑定当前对话 URL。",
      },
    };
  }
  if (!hasProductionWebSinkSurface(activeBinding.pluginId, activeBinding.surfaceId)) {
    return {
      workspaceId,
      activeBinding,
      plugins,
      availability: {
        available: false,
        reasonCode: "plugin_missing",
        message: "active binding surface 不在 production registry。",
      },
    };
  }
  if (options?.companionAvailable === false || options?.companionRouteCanonical == null) {
    return {
      workspaceId,
      activeBinding,
      plugins,
      availability: {
        available: false,
        reasonCode: "companion_unavailable",
        message: "当前没有可用的 Browser Companion。",
      },
    };
  }
  if (options?.companionVerified === false) {
    return {
      workspaceId,
      activeBinding,
      plugins,
      availability: {
        available: false,
        reasonCode: "route_unverified",
        message: "Browser Companion route 尚未 verified。",
      },
    };
  }
  if (options.companionRouteCanonical !== activeBinding.canonicalUrl) {
    return {
      workspaceId,
      activeBinding,
      plugins,
      availability: {
        available: false,
        reasonCode: "binding_stale",
        message: "active Web Sink 与当前 verified route 不一致。",
      },
    };
  }
  return {
    workspaceId,
    activeBinding,
    plugins,
    availability: { available: true },
  };
}

export function freezeActiveWebSinkTarget(binding: WebSinkBinding): WebSinkSendTargetSnapshot {
  return freezeWebSinkSendTarget(binding);
}
