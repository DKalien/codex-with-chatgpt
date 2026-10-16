import path from "node:path";
import { readJson, updateJson } from "../util/json-file.js";
import { workspaceDir } from "../state.js";

export interface DesktopBinding { threadId: string; title?: string; boundAt: string }
export type DeliveryStatus = "sending" | "accepted" | "rejected" | "unknown";
export interface DesktopDelivery {
  commandId: string;
  status: DeliveryStatus;
  messageSha256: string;
  turnId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
export interface DesktopState { binding: DesktopBinding | null; deliveries: DesktopDelivery[] }

const MAX_DELIVERIES = 500;
const emptyState = (): DesktopState => ({ binding: null, deliveries: [] });
const file = (workspaceId: string) => path.join(workspaceDir(workspaceId), "desktop.json");

export function readDesktop(workspaceId: string): DesktopState {
  return readJson(file(workspaceId), emptyState());
}

/** 加锁读改写；只保留最近 500 条投递记录。 */
export function updateDesktop<R>(workspaceId: string, fn: (state: DesktopState) => R): R {
  return updateJson(file(workspaceId), emptyState(), (state) => {
    const result = fn(state);
    if (state.deliveries.length > MAX_DELIVERIES) state.deliveries = state.deliveries.slice(-MAX_DELIVERIES);
    return result;
  });
}
