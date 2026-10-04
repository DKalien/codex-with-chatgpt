import path from "node:path";
import { z } from "zod";

const WORKSPACE_ID = /^[a-f0-9]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CREATION_TIME = /^[a-zA-Z0-9:-]{1,128}$/;
const BUILD_ID = /^[a-f0-9]{64}$/;
const REGISTRATION_MODE = ["windows-scheduled-task", "unsupported", "none"] as const;

function isoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function absoluteNormalized(value: string): boolean {
  return path.isAbsolute(value) && path.normalize(value) === value;
}

export const supervisorConfigSchema = z.object({
  version: z.literal(1),
  workspaceId: z.string().regex(WORKSPACE_ID),
  workspaceRoot: z.string().min(1).max(32768).refine(absoluteNormalized),
  desiredState: z.enum(["running", "stopped"]),
  tunnel: z.boolean(),
  registrationMode: z.enum(REGISTRATION_MODE),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  updatedAt: z.string().refine(isoDate),
}).strict();
export type SupervisorConfig = z.infer<typeof supervisorConfigSchema>;

/** Pure strict schema shared with release-reference inspection. */
export const supervisorRuntimeSchema = z.object({
  version: z.literal(1),
  workspaceId: z.string().regex(WORKSPACE_ID),
  workspaceRoot: z.string().min(1).max(32768).refine(absoluteNormalized),
  pid: z.number().int().positive().max(0xffffffff),
  creationTime: z.string().regex(CREATION_TIME),
  executable: z.string().min(1).max(32768).refine(absoluteNormalized),
  startedAt: z.string().refine(isoDate),
  launcherPath: z.string().min(1).max(32768).refine(absoluteNormalized).nullable(),
  buildId: z.string().regex(BUILD_ID).nullable(),
  registrationMode: z.enum(REGISTRATION_MODE),
  nonce: z.string().regex(UUID),
}).strict();
export type SupervisorRuntime = z.infer<typeof supervisorRuntimeSchema>;

/** Startup fence only; ownership transfers to the durable runtime lease. */
export const supervisorLaunchSchema = z.object({
  version: z.literal(1),
  workspaceId: z.string().regex(WORKSPACE_ID),
  workspaceRoot: z.string().min(1).max(32768).refine(absoluteNormalized),
  buildId: z.string().regex(BUILD_ID),
  nonce: z.string().regex(UUID),
  launcherPath: z.string().min(1).max(32768).refine(absoluteNormalized),
  createdAt: z.string().refine(isoDate),
}).strict();

/** Bounded launcher-to-release proof, no argv, environment or credentials. */
export const supervisorLaunchFileIdentitySchema = z.object({
  dev: z.number().nonnegative(), ino: z.number().nonnegative(),
  size: z.number().int().positive().max(16 * 1024),
  mtimeMs: z.number().nonnegative(), ctimeMs: z.number().nonnegative(),
  sha256: z.string().regex(BUILD_ID),
}).strict();
