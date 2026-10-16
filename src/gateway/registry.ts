import path from "node:path";
import { getStateDir } from "../config/paths.js";
import { C2CError } from "../errors.js";
import { readJson, updateJson } from "../util/json-file.js";
import { Workspace } from "../workspace/manager.js";

export interface WorkspaceEntry { workspaceId: string; root: string; name: string }

// 旧格式：{version:1, workspaces:[{workspaceId, root, clientIds}]}；clientIds 原样保留，不再使用。
interface Stored { workspaceId: string; root: string; clientIds: string[] }
interface File { version: 1; workspaces: Stored[] }

export class Registry {
  private readonly file: string;

  constructor(stateDir = getStateDir()) {
    this.file = path.join(path.resolve(stateDir), "gateway", "workspaces.json");
  }

  private read(): File {
    const data = readJson<Partial<File>>(this.file, {});
    return { version: 1, workspaces: Array.isArray(data.workspaces) ? data.workspaces : [] };
  }

  list(): WorkspaceEntry[] {
    return this.read().workspaces.map(e => {
      let name = path.basename(e.root);
      try { name = new Workspace(e.root).name; } catch { /* root 已不存在，退回目录名 */ }
      return { workspaceId: e.workspaceId, root: e.root, name };
    });
  }

  add(root: string): WorkspaceEntry {
    const ws = new Workspace(root);
    updateJson<File, void>(this.file, this.read(), data => {
      data.version = 1;
      data.workspaces ??= [];
      if (!data.workspaces.some(e => e.workspaceId === ws.id)) {
        data.workspaces.push({ workspaceId: ws.id, root: ws.root, clientIds: [] });
      }
    });
    return { workspaceId: ws.id, root: ws.root, name: ws.name };
  }

  remove(workspaceId: string): boolean {
    return updateJson<File, boolean>(this.file, this.read(), data => {
      const before = data.workspaces.length;
      data.workspaces = data.workspaces.filter(e => e.workspaceId !== workspaceId);
      return data.workspaces.length < before;
    });
  }

  resolve(workspaceId: string): Workspace {
    const entry = this.read().workspaces.find(e => e.workspaceId === workspaceId);
    if (!entry) throw new C2CError("UNKNOWN_WORKSPACE", "workspace 未登记。");
    let ws: Workspace;
    try {
      ws = new Workspace(entry.root);
    } catch {
      throw new C2CError("WORKSPACE_MOVED", `workspace 目录已不存在或被移动：${entry.root}`);
    }
    if (ws.id !== workspaceId) throw new C2CError("WORKSPACE_MOVED", `workspace 目录已变化：${entry.root}`);
    return ws;
  }
}
