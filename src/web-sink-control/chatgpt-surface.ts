import {
  normalizeChatgptConversationRoute,
  ChatGptRouteError,
} from "../chatgpt/route.js";
import {
  WebSinkControlError,
  WEB_SINK_PLUGIN_ID,
  WEB_SINK_SURFACE_ID,
} from "./schema.js";
import type { WebSinkBindingCandidate } from "../endpoints/schema.js";

/**
 * ChatGPT Web surface adapter。
 * ChatGPT URL parser 只存在于本 surface adapter，不进 generic endpoint core。
 */
export function canonicalizeChatgptWebSinkUrl(raw: string): string {
  try {
    return normalizeChatgptConversationRoute(raw);
  } catch (error) {
    if (error instanceof ChatGptRouteError) {
      throw new WebSinkControlError("WEB_SINK_URL_INVALID", error.message);
    }
    throw new WebSinkControlError("WEB_SINK_URL_INVALID", "web sink URL 无效");
  }
}

export function isChatgptWebSinkUrl(raw: string): boolean {
  try {
    canonicalizeChatgptWebSinkUrl(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verified Companion route → Web Sink candidate。
 * 不包含 planner principal / feedback identity。
 */
export function projectChatgptRouteToWebSinkCandidate(input: {
  readonly workspaceId: string;
  readonly routeCanonical: string;
}): WebSinkBindingCandidate {
  const canonicalUrl = canonicalizeChatgptWebSinkUrl(input.routeCanonical);
  return {
    pluginId: WEB_SINK_PLUGIN_ID,
    surfaceId: WEB_SINK_SURFACE_ID,
    workspaceId: input.workspaceId,
    canonicalUrl,
  };
}

export const chatgptWebSinkSurfaceDescriptor = Object.freeze({
  pluginId: WEB_SINK_PLUGIN_ID,
  surfaceId: WEB_SINK_SURFACE_ID,
  name: "ChatGPT Web",
  capabilities: Object.freeze({
    urlBinding: true,
    bindingEpoch: true,
    durableJournal: true,
    reserve: true,
    beginSend: true,
    observation: true,
    ack: true,
    singleFlight: true,
  }),
});
