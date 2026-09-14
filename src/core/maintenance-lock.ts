import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { getStateDir } from "../config/paths.js";

type CoreReleaseHelper = {
  tryAcquireMaintenanceLock(stateDir: string, operation: string):
    | { ok: false; code: "MAINTENANCE_BUSY" }
    | { ok: true; token: string; path: string; release(): boolean };
  withMaintenanceLock<T>(stateDir: string, operation: string, action: (lock: unknown) => T): T;
};

const helper = createRequire(import.meta.url)("../../scripts/core-release.cjs") as CoreReleaseHelper;

export const MAINTENANCE_LOCK_BUSY = "MAINTENANCE_BUSY" as const;
export const MAINTENANCE_RELEASE_FAILED = "MAINTENANCE_RELEASE_FAILED" as const;
export const MAINTENANCE_HANDLE_INVALID = "MAINTENANCE_HANDLE_INVALID" as const;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const META_KEYS = ["version", "operation", "pid", "startedAt", "token"].sort().join(",");

export class MaintenanceBusyError extends Error {
  readonly code = MAINTENANCE_LOCK_BUSY;
  constructor(message = "machine maintenance lock busy") {
    super(message);
    this.name = "MaintenanceBusyError";
  }
}

export class MaintenanceReleaseError extends Error {
  readonly code = MAINTENANCE_RELEASE_FAILED;
  readonly result?: unknown;
  readonly cleanupErrors: Error[];
  constructor(message = "maintenance lock release failed", result?: unknown, cleanupErrors: Error[] = []) {
    super(message);
    this.name = "MaintenanceReleaseError";
    this.result = result;
    this.cleanupErrors = cleanupErrors;
    if (cleanupErrors.length === 1) this.cause = cleanupErrors[0];
  }
}

export class MaintenanceHandleError extends Error {
  readonly code = MAINTENANCE_HANDLE_INVALID;
  constructor(message = "inherited maintenance handle 无效") {
    super(message);
    this.name = "MaintenanceHandleError";
  }
}

export type MaintenanceLockHandle = {
  readonly token: string;
  readonly path: string;
  release(): boolean;
};

export type MaintenanceLockResult =
  | { ok: true; handle: MaintenanceLockHandle }
  | { ok: false; code: typeof MAINTENANCE_LOCK_BUSY };

export type MaintenanceLockMetadata = {
  version: number;
  operation: string;
  pid: number;
  startedAt: string;
  token: string;
};

/** 统一 cleanup 聚合：主 error identity 不变；cleanup 全部可枚举，不覆盖已有 cause。 */
export function appendCleanupError(primary: unknown, cleanup: Error): void {
  if (!primary || typeof primary !== "object") return;
  const holder = primary as { cleanupErrors?: Error[]; cause?: unknown };
  if (!Array.isArray(holder.cleanupErrors)) holder.cleanupErrors = [];
  holder.cleanupErrors.push(cleanup);
  if (holder.cause === undefined) holder.cause = cleanup;
  else if (holder.cause !== cleanup) {
    // 已有 cause 时挂到 cleanupErrors，不覆盖。
  }
}

export function readCleanupErrors(error: unknown): Error[] {
  if (!error || typeof error !== "object") return [];
  const list = (error as { cleanupErrors?: unknown }).cleanupErrors;
  return Array.isArray(list) ? list.filter((item): item is Error => item instanceof Error) : [];
}

export function maintenanceLockPath(stateDir = getStateDir()): string {
  return path.join(path.resolve(stateDir), "maintenance.lock");
}

function parseStrictMetadata(raw: unknown): MaintenanceLockMetadata | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== META_KEYS) return null;
  if (value.version !== 1) return null;
  if (typeof value.operation !== "string" || value.operation.length === 0) return null;
  if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) return null;
  if (typeof value.startedAt !== "string" || !ISO.test(value.startedAt)) return null;
  if (Number.isNaN(Date.parse(value.startedAt)) || new Date(value.startedAt).toISOString() !== value.startedAt) return null;
  if (typeof value.token !== "string" || !TOKEN.test(value.token)) return null;
  return value as unknown as MaintenanceLockMetadata;
}

/** 严格只读；不是 regular file / schema 不合 / symlink 一律 null。 */
export function readMaintenanceLock(stateDir = getStateDir()): MaintenanceLockMetadata | null {
  const file = maintenanceLockPath(stateDir);
  try {
    const lstat = fs.lstatSync(file);
    if (!lstat.isFile() || lstat.isSymbolicLink()) return null;
    if (fs.realpathSync(file) !== file) return null;
    return parseStrictMetadata(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

export function isMaintenanceLockBusy(stateDir = getStateDir()): boolean {
  return fs.existsSync(maintenanceLockPath(stateDir));
}

export function tryAcquireMaintenanceLock(
  stateDir = getStateDir(),
  operation = "unknown",
): MaintenanceLockResult {
  const result = helper.tryAcquireMaintenanceLock(path.resolve(stateDir), operation);
  if (!result.ok) return { ok: false, code: MAINTENANCE_LOCK_BUSY };
  return {
    ok: true,
    handle: {
      token: result.token,
      path: result.path,
      release: () => result.release(),
    },
  };
}

/**
 * 成功 action + release false → MAINTENANCE_RELEASE_FAILED（附 result）。
 * action 失败 + release 失败 → 保留原始 error，cleanup 进入 cleanupErrors，不覆盖已有 cause。
 */
export function releaseMaintenanceOrThrow(
  handle: MaintenanceLockHandle | null | undefined,
  options: { result?: unknown; actionError?: unknown } = {},
): void {
  if (!handle) {
    if (options.actionError) throw options.actionError;
    return;
  }
  const released = handle.release();
  if (options.actionError) {
    if (!released) {
      appendCleanupError(options.actionError, new MaintenanceReleaseError("maintenance lock release failed after action error"));
    }
    throw options.actionError;
  }
  if (!released) throw new MaintenanceReleaseError("maintenance lock release failed", options.result);
}

export function withMaintenanceLock<T>(
  operation: string,
  action: (handle: MaintenanceLockHandle) => T,
  stateDir = getStateDir(),
): T {
  const acquired = tryAcquireMaintenanceLock(stateDir, operation);
  if (!acquired.ok) throw new MaintenanceBusyError();
  let result: T | undefined;
  let actionError: unknown = null;
  try {
    result = action(acquired.handle);
  } catch (error) {
    actionError = error;
  }
  releaseMaintenanceOrThrow(acquired.handle, { result, actionError: actionError ?? undefined });
  return result as T;
}

/** 严格验证 inherited handle 仍是当前 stateDir 的 active owner。 */
export function assertMaintenanceHandle(stateDir: string, handle: MaintenanceLockHandle): void {
  if (!handle || typeof handle.token !== "string" || typeof handle.path !== "string") {
    throw new MaintenanceHandleError("handle 结构无效");
  }
  const expectedPath = maintenanceLockPath(stateDir);
  if (handle.path !== expectedPath) {
    throw new MaintenanceHandleError("handle.path 与当前 stateDir 的 maintenance.lock 不一致");
  }
  const meta = readMaintenanceLock(stateDir);
  if (!meta) throw new MaintenanceHandleError("maintenance.lock 缺失、非 regular file 或 metadata 无效");
  if (meta.token !== handle.token) throw new MaintenanceHandleError("handle.token 与当前 lock 不匹配");
  if (!TOKEN.test(handle.token)) throw new MaintenanceHandleError("handle.token 格式无效");
}

export function legacyRolloutLockPath(stateDir = getStateDir()): string {
  return path.join(path.resolve(stateDir), "rollout.lock");
}

export function hasLegacyRolloutLock(stateDir = getStateDir()): boolean {
  return fs.existsSync(legacyRolloutLockPath(stateDir));
}

export function listBridgeStartLocks(stateDir = getStateDir()): string[] {
  const dir = path.join(path.resolve(stateDir), "runtime");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names.filter((name) => name.endsWith(".start.lock")).sort();
}
