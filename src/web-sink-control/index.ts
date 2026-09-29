/**
 * R5c Web Sink Control Plane。
 * Bridge-owned Active Web Sink Binding（URL-based，非 planner-principal-based）。
 */

export {
  WebSinkControlError,
  parseWebSinkControlState,
  webSinkControlStateSchema,
  isSameWebSinkCandidate,
  WEB_SINK_PLUGIN_ID,
  WEB_SINK_SURFACE_ID,
} from "./schema.js";
export type {
  WebSinkAvailability,
  WebSinkControlState,
  WebSinkPluginSummary,
  WebSinkStatusProjection,
} from "./schema.js";

export {
  WEB_SINK_MAX_EPOCH,
  nextWebSinkEpoch,
  readWebSinkControl,
  updateWebSinkControlDetailed,
  webSinkControlFile,
  webSinkControlInitializedFile,
} from "./store.js";

export {
  hasProductionWebSinkSurface,
  listProductionWebSinkSurfaces,
  productionWebSinkSurfaces,
} from "./registry.js";

export {
  bindCurrentWebSink,
  freezeActiveWebSinkTarget,
  listWebSinkSurfaces,
  readActiveWebSinkBinding,
  webSinkStatus,
} from "./service.js";
export type { ActiveWebSinkBindingResult } from "./service.js";

export {
  canonicalizeChatgptWebSinkUrl,
  chatgptWebSinkSurfaceDescriptor,
  isChatgptWebSinkUrl,
  projectChatgptRouteToWebSinkCandidate,
} from "./chatgpt-surface.js";

export {
  bindCurrentWebSinkFromDurableCompanion,
  bindCurrentWebSinkFromVerifiedCompanionRoute,
  verifyCompanionCredentialForWebSink,
} from "./companion-adapter.js";
