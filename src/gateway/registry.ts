import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";
import { Workspace } from "../workspace/manager.js";

const workspaceIdSchema = z.string().regex(/^[a-f0-9]{12}$/);
const clientIdSchema = z.string().min(1).max(256);
const registrationSchema = z.object({
  workspaceId: workspaceIdSchema,
  root: z.string().min(1).refine(value => path.isAbsolute(value)),
  clientIds: z.array(clientIdSchema).min(1).max(10000),
}).strict().superRefine((entry, context) => {
  if (new Set(entry.clientIds).size !== entry.clientIds.length) {
    context.addIssue({ code: "custom", message: "duplicate clientId", path: ["clientIds"] });
  }
});
const registrySchema = z.object({
  version: z.literal(1),
  workspaces: z.array(registrationSchema).max(10000),
}).strict().superRefine((state, context) => {
  const ids = new Set<string>();
  for (const [index, entry] of state.workspaces.entries()) {
    if (ids.has(entry.workspaceId)) context.addIssue({ code: "custom", message: "duplicate workspaceId", path: ["workspaces", index, "workspaceId"] });
    ids.add(entry.workspaceId);
  }
});

export type WorkspaceRegistration = z.infer<typeof registrationSchema>;
type RegistryState = z.infer<typeof registrySchema>;

export class GatewayRegistryError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "GatewayRegistryError";
  }
}

export function gatewayRegistryFile(stateDir = getStateDir()): string {
  return path.join(path.resolve(stateDir), "gateway", "workspaces.json");
}

function corrupt(): GatewayRegistryError {
  return new GatewayRegistryError("GATEWAY_REGISTRY_CORRUPT", "Gateway 项目授权清单损坏；保留原文件并人工核对。");
}

function readRegistry(file: string): RegistryState {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, workspaces: [] };
    throw corrupt();
  }
  try {
    return registrySchema.parse(JSON.parse(raw));
  } catch {
    throw corrupt();
  }
}

function checkedClientId(clientId: string): string {
  const parsed = clientIdSchema.safeParse(clientId);
  if (!parsed.success) throw new GatewayRegistryError("GATEWAY_INVALID_CLIENT_ID", "clientId 必须为 1–256 个字符。");
  return parsed.data;
}

function checkedWorkspaceId(workspaceId: string): string {
  const parsed = workspaceIdSchema.safeParse(workspaceId);
  if (!parsed.success) throw new GatewayRegistryError("GATEWAY_INVALID_WORKSPACE_ID", "workspaceId 格式无效。");
  return parsed.data;
}

export class GatewayRegistry {
  private readonly file: string;

  constructor(stateDir = getStateDir()) {
    this.file = gatewayRegistryFile(stateDir);
  }

  register(root: string, clientId: string): WorkspaceRegistration {
    checkedClientId(clientId);
    const workspace = new Workspace(root);
    return this.update(state => {
      const existing = state.workspaces.find(entry => entry.workspaceId === workspace.id);
      if (existing) {
        if (existing.root !== workspace.root) {
          throw new GatewayRegistryError("GATEWAY_WORKSPACE_ID_MISMATCH", "workspaceId 与已登记 root 不匹配。");
        }
        if (!existing.clientIds.includes(clientId)) existing.clientIds.push(clientId);
        return { state, result: { ...existing, clientIds: [...existing.clientIds] } };
      }
      const entry = { workspaceId: workspace.id, root: workspace.root, clientIds: [clientId] };
      state.workspaces.push(entry);
      return { state, result: { ...entry, clientIds: [...entry.clientIds] } };
    });
  }

  list(clientId?: string): WorkspaceRegistration[] {
    const requestedClient = clientId === undefined ? undefined : checkedClientId(clientId);
    return readRegistry(this.file).workspaces
      .filter(entry => requestedClient === undefined || entry.clientIds.includes(requestedClient))
      .map(entry => ({ ...entry, clientIds: [...entry.clientIds] }));
  }

  revoke(workspaceId: string, clientId?: string): boolean {
    const id = checkedWorkspaceId(workspaceId);
    const requestedClient = clientId === undefined ? undefined : checkedClientId(clientId);
    return this.update(state => {
      const index = state.workspaces.findIndex(entry => entry.workspaceId === id);
      if (index < 0) return { state, result: false };
      if (requestedClient === undefined) {
        state.workspaces.splice(index, 1);
        return { state, result: true };
      }
      const entry = state.workspaces[index]!;
      const remaining = entry.clientIds.filter(value => value !== requestedClient);
      if (remaining.length === entry.clientIds.length) return { state, result: false };
      if (remaining.length === 0) state.workspaces.splice(index, 1);
      else entry.clientIds = remaining;
      return { state, result: true };
    });
  }

  resolve(workspaceId: string, clientId: string): Workspace {
    const id = checkedWorkspaceId(workspaceId);
    const client = checkedClientId(clientId);
    const entry = readRegistry(this.file).workspaces.find(item => item.workspaceId === id);
    if (!entry) throw new GatewayRegistryError("GATEWAY_UNKNOWN_WORKSPACE", "workspace 未登记。");
    if (!entry.clientIds.includes(client)) throw new GatewayRegistryError("GATEWAY_CLIENT_NOT_AUTHORIZED", "client 未获准访问此 workspace。");
    let workspace: Workspace;
    try {
      workspace = new Workspace(entry.root);
    } catch {
      throw new GatewayRegistryError("GATEWAY_WORKSPACE_ID_MISMATCH", "workspace root 不可用或身份已变化。");
    }
    if (workspace.id !== id || workspace.root !== entry.root) {
      throw new GatewayRegistryError("GATEWAY_WORKSPACE_ID_MISMATCH", "workspaceId 与规范 root 不匹配。");
    }
    return workspace;
  }

  private update<T>(change: (state: RegistryState) => { state: RegistryState; result: T }): T {
    const directory = path.dirname(this.file);
    ensureDir(directory);
    const lockFile = `${this.file}.lock`;
    let lock: number;
    try {
      lock = fs.openSync(lockFile, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new GatewayRegistryError("GATEWAY_REGISTRY_BUSY", "Gateway 授权清单锁已存在；遗留锁需人工核对，不会自动删除。");
      }
      throw error;
    }

    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      fs.fsyncSync(lock);
      const next = change(readRegistry(this.file));
      const valid = registrySchema.parse(next.state);
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(valid));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, this.file);
      return next.result;
    } finally {
      fs.rmSync(temporary, { force: true });
      fs.closeSync(lock);
      fs.unlinkSync(lockFile);
    }
  }
}
