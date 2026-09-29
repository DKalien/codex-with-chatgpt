import { chatgptWebSinkSurfaceDescriptor } from "./chatgpt-surface.js";
import { WEB_SINK_PLUGIN_ID, WEB_SINK_SURFACE_ID } from "./schema.js";

/**
 * Production Web Sink surface registry。
 * 当前唯一 production surface：browser-companion / chatgpt-web。
 * 无动态发现；不注册其他 AI 网页 production surface。
 */
export const productionWebSinkSurfaces = Object.freeze([
  chatgptWebSinkSurfaceDescriptor,
]);

export function listProductionWebSinkSurfaces() {
  return productionWebSinkSurfaces;
}

export function hasProductionWebSinkSurface(pluginId: string, surfaceId: string): boolean {
  return (
    pluginId === WEB_SINK_PLUGIN_ID &&
    surfaceId === WEB_SINK_SURFACE_ID
  );
}
