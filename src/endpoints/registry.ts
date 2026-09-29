import { isEndpointSafeId } from "./schema.js";

/**
 * Implementation-neutral Plugin Registry。
 *
 * 约束：
 * - fixed explicit registration only
 * - pluginId 使用 Endpoint Core safe ID 语义（运行时校验）
 * - duplicate plugin ID fail closed
 * - unknown plugin fail closed
 * - 无环境路径发现、无 network discovery、无 dynamic require/import、无 filesystem 扫描
 */

export class PluginRegistryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PluginRegistryError";
  }
}

export interface RegistryPluginIdentity {
  readonly pluginId: string;
}

/** 允许 plugin 直接带 pluginId，或通过 descriptor 暴露 pluginId。 */
function resolvePluginId(plugin: unknown): string {
  if (!plugin || typeof plugin !== "object") return "";
  const direct = (plugin as { pluginId?: unknown }).pluginId;
  if (typeof direct === "string") return direct;
  const descriptor = (plugin as { descriptor?: { pluginId?: unknown } }).descriptor;
  const nested = descriptor?.pluginId;
  return typeof nested === "string" ? nested : "";
}

function resolveDescriptor(plugin: unknown): { pluginId?: unknown } | null {
  if (!plugin || typeof plugin !== "object") return null;
  const descriptor = (plugin as { descriptor?: unknown }).descriptor;
  return descriptor && typeof descriptor === "object" ? (descriptor as { pluginId?: unknown }) : null;
}

export interface PluginRegistry<T> {
  get(pluginId: string): T;
  has(pluginId: string): boolean;
  list(): readonly T[];
  ids(): readonly string[];
}

/**
 * 固定显式注册表。生产默认注册集由调用方常量提供；本函数不做任何发现。
 * 运行时校验 safe plugin ID，以及 descriptor.pluginId 与解析出的 ID 一致。
 */
export function createPluginRegistry<T>(plugins: readonly T[]): PluginRegistry<T> {
  const byId = new Map<string, T>();
  for (const plugin of plugins) {
    const id = resolvePluginId(plugin);
    if (!isEndpointSafeId(id)) {
      throw new PluginRegistryError("PLUGIN_ID_INVALID", "pluginId 必须是 endpoint safe ID");
    }
    const descriptor = resolveDescriptor(plugin);
    if (descriptor && descriptor.pluginId !== id) {
      throw new PluginRegistryError("PLUGIN_ID_INVALID", "descriptor.pluginId 与 pluginId 不一致");
    }
    if (byId.has(id)) {
      throw new PluginRegistryError("PLUGIN_ID_DUPLICATE", `duplicate plugin id: ${id}`);
    }
    byId.set(id, plugin);
  }
  return Object.freeze({
    get(pluginId: string): T {
      const plugin = byId.get(pluginId);
      if (!plugin) {
        throw new PluginRegistryError("PLUGIN_UNKNOWN", `unknown plugin: ${pluginId}`);
      }
      return plugin;
    },
    has(pluginId: string): boolean {
      return byId.has(pluginId);
    },
    list(): readonly T[] {
      return [...byId.values()];
    },
    ids(): readonly string[] {
      return [...byId.keys()];
    },
  });
}
