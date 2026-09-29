import { createExecutorPluginRegistry, type ExecutorPlugin } from "../endpoints/executor-contract.js";
import { codexDesktopExecutorPlugin } from "../executor/index.js";

/**
 * Production Executor Plugin Registry。
 * 固定显式注册；当前唯一 production backend：codex-desktop。
 * 不做环境探测、网络发现或文件系统扫描；其他候选工具不进入 production registry。
 */
export const productionExecutorPlugins: readonly ExecutorPlugin[] = Object.freeze([
  codexDesktopExecutorPlugin,
]);

export const productionExecutorPluginRegistry = createExecutorPluginRegistry(productionExecutorPlugins);

export function listProductionExecutorPlugins(): readonly ExecutorPlugin[] {
  return productionExecutorPluginRegistry.list();
}

export function getProductionExecutorPlugin(pluginId: string): ExecutorPlugin {
  return productionExecutorPluginRegistry.get(pluginId);
}

export function hasProductionExecutorPlugin(pluginId: string): boolean {
  return productionExecutorPluginRegistry.has(pluginId);
}
