import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDir, getStateDir } from "../config/paths.js";
import { assertMaintenanceHandle, maintenanceLockPath, type MaintenanceLockHandle } from "./maintenance-lock.js";
import { Workspace } from "../workspace/manager.js";

export const STARTUP_LEASE_ENV = "C2C_STARTUP_LEASE" as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const START_META_KEYS = ["version", "workspaceId", "nonce", "pid", "createdAt"].sort().join(",");

export type StartupLease = {
  version: 1;
  stateDir: string;
  workspaceId: string;
  maintenanceToken: string;
  startLockNonce: string;
  leaseNonce: string;
};

export type StartLockHandle = {
  readonly path: string;
  readonly workspaceId: string;
  readonly nonce: string;
  release(): boolean;
};

export class StartupLeaseError extends Error {
  readonly code = "STARTUP_LEASE_INVALID";
  constructor(message = "startup lease 无效") {
    super(message);
    this.name = "StartupLeaseError";
  }
}

export class StartupLeaseReplayError extends Error {
  readonly code = "STARTUP_LEASE_REPLAY";
  constructor(message = "startup lease 已被 claim，禁止重放") {
    super(message);
    this.name = "StartupLeaseReplayError";
  }
}

export function startLockPath(stateDir: string, workspaceId: string): string {
  return path.join(path.resolve(stateDir), "runtime", `${workspaceId}.start.lock`);
}

export function claimPath(stateDir: string, workspaceId: string, leaseNonce: string): string {
  return path.join(path.resolve(stateDir), "startup-leases", `${workspaceId}.${leaseNonce}.claim`);
}

function isCanonicalRegularFile(file: string): boolean {
  try {
    const lstat = fs.lstatSync(file);
    if (!lstat.isFile() || lstat.isSymbolicLink()) return false;
    return fs.realpathSync(file) === file;
  } catch {
    return false;
  }
}

function parseStartMetadata(raw: unknown, workspaceId: string): { nonce: string; pid: number; createdAt: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== START_META_KEYS) return null;
  if (value.version !== 1) return null;
  if (value.workspaceId !== workspaceId || typeof value.workspaceId !== "string") return null;
  if (typeof value.nonce !== "string" || !UUID.test(value.nonce)) return null;
  if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) return null;
  if (typeof value.createdAt !== "string" || !ISO.test(value.createdAt)) return null;
  if (Number.isNaN(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) return null;
  return { nonce: value.nonce, pid: value.pid, createdAt: value.createdAt };
}

export function createStartLock(stateDir: string, workspaceId: string): StartLockHandle {
  const file = startLockPath(stateDir, workspaceId);
  ensureDir(path.dirname(file));
  const nonce = randomUUID();
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Bridge start lock 存在或无法取得；未启动重复实例，请稍后重试。");
    }
    throw error;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({
      version: 1,
      workspaceId,
      nonce,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    }));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  let released = false;
  return {
    path: file,
    workspaceId,
    nonce,
    release() {
      if (released) return true;
      if (!isCanonicalRegularFile(file)) return false;
      let meta: ReturnType<typeof parseStartMetadata>;
      try {
        meta = parseStartMetadata(JSON.parse(fs.readFileSync(file, "utf8")), workspaceId);
      } catch {
        return false;
      }
      if (!meta || meta.nonce !== nonce) return false;
      try {
        fs.unlinkSync(file);
      } catch {
        return false;
      }
      released = true;
      return true;
    },
  };
}

export function readStartLockNonce(stateDir: string, workspaceId: string): string | null {
  const file = startLockPath(stateDir, workspaceId);
  if (!isCanonicalRegularFile(file)) return null;
  try {
    return parseStartMetadata(JSON.parse(fs.readFileSync(file, "utf8")), workspaceId)?.nonce ?? null;
  } catch {
    return null;
  }
}

export function issueStartupLease(options: {
  stateDir?: string;
  workspace: Workspace;
  maintenance: MaintenanceLockHandle;
  startLockNonce: string;
}): StartupLease {
  const stateDir = path.resolve(options.stateDir ?? getStateDir());
  return {
    version: 1,
    stateDir,
    workspaceId: options.workspace.id,
    maintenanceToken: options.maintenance.token,
    startLockNonce: options.startLockNonce,
    leaseNonce: randomUUID(),
  };
}

export function encodeStartupLease(lease: StartupLease): string {
  return Buffer.from(JSON.stringify(lease), "utf8").toString("base64url");
}

export function decodeStartupLease(raw: string): StartupLease {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new StartupLeaseError("lease 不是合法 base64url JSON");
  }
  if (!value || typeof value !== "object") throw new StartupLeaseError("lease 结构无效");
  const lease = value as Partial<StartupLease>;
  if (lease.version !== 1 || typeof lease.stateDir !== "string" || typeof lease.workspaceId !== "string" ||
      typeof lease.maintenanceToken !== "string" || typeof lease.startLockNonce !== "string" ||
      typeof lease.leaseNonce !== "string") {
    throw new StartupLeaseError("lease 字段不完整");
  }
  if (!UUID.test(lease.maintenanceToken) || !UUID.test(lease.startLockNonce) || !UUID.test(lease.leaseNonce)) {
    throw new StartupLeaseError("lease token/nonce 格式无效");
  }
  return lease as StartupLease;
}

/** 读取并立刻从 process.env 删除，避免 grandchild 继承旧 proof。 */
export function consumeStartupLeaseFromEnv(env: NodeJS.ProcessEnv = process.env): StartupLease | null {
  const raw = env[STARTUP_LEASE_ENV];
  if (!raw) return null;
  delete env[STARTUP_LEASE_ENV];
  return decodeStartupLease(raw);
}

export function readStartupLeaseFromEnv(env: NodeJS.ProcessEnv = process.env): StartupLease | null {
  const raw = env[STARTUP_LEASE_ENV];
  if (!raw) return null;
  return decodeStartupLease(raw);
}

/**
 * 验证 parent lease + 跨进程 one-shot claim。
 * 已存在 claim → STARTUP_LEASE_REPLAY fail closed。
 */
export function claimStartupLease(lease: StartupLease, workspace: Workspace): { claimPath: string } {
  const stateDir = path.resolve(lease.stateDir);
  if (stateDir !== path.resolve(getStateDir())) {
    throw new StartupLeaseError("lease.stateDir 与当前 C2C_STATE_DIR 不一致");
  }
  if (lease.workspaceId !== workspace.id) {
    throw new StartupLeaseError("lease.workspaceId 与 workspace 不一致");
  }
  assertMaintenanceHandle(stateDir, {
    token: lease.maintenanceToken,
    path: maintenanceLockPath(stateDir),
    release: () => false,
  });
  const nonce = readStartLockNonce(stateDir, workspace.id);
  if (nonce === null) throw new StartupLeaseError("start.lock 缺失或损坏");
  if (nonce !== lease.startLockNonce) throw new StartupLeaseError("start.lock nonce 与 lease 不匹配");

  const file = claimPath(stateDir, workspace.id, lease.leaseNonce);
  ensureDir(path.dirname(file));
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new StartupLeaseReplayError();
    }
    throw error;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({
      version: 1,
      workspaceId: workspace.id,
      leaseNonce: lease.leaseNonce,
      startLockNonce: lease.startLockNonce,
      maintenanceToken: lease.maintenanceToken,
      claimedAt: new Date().toISOString(),
      pid: process.pid,
    }));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return { claimPath: file };
}

/** parent 在 child ready/failure 后清理自己 nonce 的 claim；不自动 steal 他人的。 */
export function cleanupStartupLeaseClaim(stateDir: string, lease: StartupLease): boolean {
  const file = claimPath(stateDir, lease.workspaceId, lease.leaseNonce);
  try {
    if (!isCanonicalRegularFile(file)) return false;
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { leaseNonce?: string; workspaceId?: string };
    if (raw.leaseNonce !== lease.leaseNonce || raw.workspaceId !== lease.workspaceId) return false;
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** 兼容旧测试/调用：验证但不 claim。 */
export function assertStartupLease(lease: StartupLease, workspace: Workspace): void {
  const stateDir = path.resolve(lease.stateDir);
  if (stateDir !== path.resolve(getStateDir())) {
    throw new StartupLeaseError("lease.stateDir 与当前 C2C_STATE_DIR 不一致");
  }
  if (lease.workspaceId !== workspace.id) {
    throw new StartupLeaseError("lease.workspaceId 与 workspace 不一致");
  }
  assertMaintenanceHandle(stateDir, {
    token: lease.maintenanceToken,
    path: maintenanceLockPath(stateDir),
    release: () => false,
  });
  const nonce = readStartLockNonce(stateDir, workspace.id);
  if (nonce === null) throw new StartupLeaseError("start.lock 缺失或损坏");
  if (nonce !== lease.startLockNonce) throw new StartupLeaseError("start.lock nonce 与 lease 不匹配");
}
