import path from "node:path";
import { ensureDir, getStateDir } from "./config/paths.js";

/** 每个 workspace 的独立状态目录：<stateDir>/workspaces/<workspaceId>。 */
export function workspaceDir(workspaceId: string): string {
  if (!/^[a-f0-9]{12}$/.test(workspaceId)) throw new Error(`invalid workspaceId: ${workspaceId}`);
  return ensureDir(path.join(getStateDir(), "workspaces", workspaceId));
}
