import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";
import { sanitizeExecutionOutput } from "../execution/sanitize.js";
import {
  executionSummarySchema,
  isTrustedDesktopReceipt,
  readExecutionRecordsStrict,
  sanitizeExecutionSummary,
} from "../execution/records.js";
import {
  desktopIpc,
  DESKTOP_RESULT_ACTIVITY_ITEM_TYPES,
  type DesktopResultActivityMarker,
  type DesktopResultTerminalFence,
  type DesktopTarget,
} from "./ipc.js";
import { DesktopError, readDesktop } from "./store.js";
import type { DesktopResultReceipt } from "./result.js";

const UUID = z.string().uuid();
const DESKTOP_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const RECEIPT_FINALIZER_POLL_MS = 1_000;
export const RECEIPT_FINALIZER_MAX_LIFETIME_MS = 15 * 60_000;

const receiptFinalizationInputSchema = z.object({
  commandId: z.string().regex(DESKTOP_ID),
  changedFiles: z.array(z.string().max(4096)).max(10_000),
  tests: z.string().min(1).max(16_384),
  exitStatus: z.enum(["ok", "failed", "blocked"]),
  notes: z.string().max(16_384).optional(),
  // 新 receipt 必须提供；旧 v2 draft 保留缺失字段与原 canonical digest。
  rawSummary: executionSummarySchema.optional(),
  command: z.string().max(16_384).optional(),
  output: z.string().max(256 * 1024).optional(),
  outputRestrictedReason: z.string().max(128).optional(),
  exitCode: z.number().int().safe().optional(),
}).strict();

const receiptFinalizationMarkerSchema = z.object({
  resultTurnId: UUID,
  itemIds: z.array(z.string().min(1).max(512)).min(1).max(4_096),
  itemTypes: z.array(z.enum(DESKTOP_RESULT_ACTIVITY_ITEM_TYPES)).min(1).max(4_096),
  itemCount: z.number().int().nonnegative().safe(),
  itemSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const receiptFinalizationDraftV1Schema = z.object({
  version: z.literal(1),
  draftId: UUID,
  workspaceId: z.string().regex(DESKTOP_ID),
  workspaceRoot: z.string().min(1),
  threadId: UUID,
  originTurnId: UUID,
  resultTurnId: UUID,
  commandId: z.string().regex(DESKTOP_ID),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

const receiptFinalizationDraftV2Schema = z.object({
  version: z.literal(2),
  draftId: UUID,
  workspaceId: z.string().regex(DESKTOP_ID),
  workspaceRoot: z.string().min(1),
  threadId: UUID,
  originTurnId: UUID,
  resultTurnId: UUID,
  commandId: z.string().regex(DESKTOP_ID),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  input: receiptFinalizationInputSchema,
  marker: receiptFinalizationMarkerSchema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

export const receiptFinalizationDraftSchema = z.union([
  receiptFinalizationDraftV1Schema,
  receiptFinalizationDraftV2Schema,
]);

export type ReceiptFinalizationInput = z.infer<typeof receiptFinalizationInputSchema>;
export type ReceiptFinalizationMarker = DesktopResultActivityMarker;
export type ReceiptFinalizationFenceResult = DesktopResultTerminalFence;

type ReceiptFinalizationIpc = typeof desktopIpc;
const markerIpc = desktopIpc as ReceiptFinalizationIpc;

function markerMaterial(marker: { itemIds: string[]; itemTypes: string[] }): string {
  return JSON.stringify(marker.itemIds.map((id, index) => ({ id, type: marker.itemTypes[index] })))
    .replace(/[\u007f-\uffff]/g, character => {
      const code = character.charCodeAt(0).toString(16).padStart(4, "0");
      return `\\u${code}`;
    });
}

export function receiptFinalizationMarkerDigest(marker: { itemIds: string[]; itemTypes: string[] }): string {
  return createHash("sha256").update(markerMaterial(marker), "utf8").digest("hex");
}

function parseMarker(value: unknown): ReceiptFinalizationMarker {
  const marker = receiptFinalizationMarkerSchema.parse(value);
  if (marker.itemIds.length !== marker.itemCount || marker.itemTypes.length !== marker.itemCount ||
      receiptFinalizationMarkerDigest(marker) !== marker.itemSha256) {
    throw new Error("Desktop receipt activity marker 不一致；拒绝继续。 ");
  }
  return marker as unknown as ReceiptFinalizationMarker;
}

function draftMarkerEqual(left: ReceiptFinalizationDraft, right: ReceiptFinalizationDraft): boolean {
  if (left.version !== right.version) return false;
  return left.version === 1 || !("marker" in left) || !("marker" in right) ||
    JSON.stringify(left.marker) === JSON.stringify(right.marker);
}

/** 只把 output 交给现有 sanitizer；draft 永远不落原始敏感输出。 */
export function sanitizeReceiptFinalizationInput(value: unknown): ReceiptFinalizationInput {
  const input = receiptFinalizationInputSchema.parse(value);
  const rawSummary = input.rawSummary === undefined ? undefined : sanitizeExecutionSummary(input.rawSummary);
  if (input.output === undefined) {
    return rawSummary === undefined ? input : { ...input, rawSummary };
  }
  const sanitized = sanitizeExecutionOutput(input.output);
  return {
    ...input,
    ...(rawSummary === undefined ? {} : { rawSummary }),
    ...(sanitized.allowed
      ? { output: sanitized.text, outputRestrictedReason: undefined }
      : { output: undefined, outputRestrictedReason: sanitized.reason }),
  };
}

export function canonicalReceiptFinalizationInput(input: ReceiptFinalizationInput): string {
  return JSON.stringify({
    commandId: input.commandId,
    changedFiles: [...input.changedFiles],
    tests: input.tests,
    exitStatus: input.exitStatus,
    notes: input.notes ?? null,
    ...(input.rawSummary === undefined ? {} : { rawSummary: input.rawSummary }),
    command: input.command ?? null,
    output: input.output ?? null,
    outputRestrictedReason: input.outputRestrictedReason ?? null,
    exitCode: input.exitCode ?? null,
  });
}

export const receiptFinalizationAlertSchema = z.object({
  version: z.literal(1),
  alertId: UUID,
  workspaceId: z.string().regex(DESKTOP_ID),
  commandId: z.string().regex(DESKTOP_ID),
  reason: z.enum([
    "post_record_activity",
    "post_record_activity_unprovable",
    "identity_drift",
    "terminality_unknown",
    "timeout",
    "worker_spawn_failed",
  ]),
  occurredAt: z.string().datetime(),
}).strict();

export type ReceiptFinalizationDraft = z.infer<typeof receiptFinalizationDraftSchema>;
export type ReceiptFinalizationAlert = z.infer<typeof receiptFinalizationAlertSchema>;

function baseDir(stateDir = getStateDir()): string {
  return path.join(path.resolve(stateDir), "desktop-receipt-finalization");
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function receiptFinalizationDraftPath(stateDir: string, workspaceId: string, commandId: string): string {
  return path.join(baseDir(stateDir), "drafts", `${workspaceId}-${safeName(commandId)}.json`);
}

export function receiptFinalizationAlertPath(stateDir: string, workspaceId: string, commandId: string): string {
  return path.join(baseDir(stateDir), "alerts", `${workspaceId}-${safeName(commandId)}.json`);
}

export function receiptFinalizationClaimPath(stateDir: string, workspaceId: string, commandId: string): string {
  return path.join(baseDir(stateDir), "claims", `${workspaceId}-${safeName(commandId)}.claim`);
}

export class ReceiptFinalizationStateError extends Error {
  readonly code = "RECEIPT_FINALIZATION_STATE_CORRUPT";
  constructor(file: string) { super(`receipt finalization state is corrupt: ${file}`); }
}

function readRegular<T>(file: string, schema: z.ZodType<T>): T | null {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ReceiptFinalizationStateError(file);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ReceiptFinalizationStateError(file);
  try {
    if (fs.realpathSync(file) !== file) throw new ReceiptFinalizationStateError(file);
    return schema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    if (error instanceof ReceiptFinalizationStateError) throw error;
    throw new ReceiptFinalizationStateError(file);
  }
}

function writeAtomic(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}

function writeExclusive(file: string, value: unknown): boolean {
  ensureDir(path.dirname(file));
  let fd: number;
  try { fd = fs.openSync(file, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  return true;
}

export function readReceiptFinalizationDraft(
  stateDir: string,
  workspaceId: string,
  commandId: string,
): ReceiptFinalizationDraft | null {
  return readRegular(receiptFinalizationDraftPath(stateDir, workspaceId, commandId), receiptFinalizationDraftSchema);
}

export function readReceiptFinalizationAlert(
  stateDir: string,
  workspaceId: string,
  commandId: string,
): ReceiptFinalizationAlert | null {
  return readRegular(receiptFinalizationAlertPath(stateDir, workspaceId, commandId), receiptFinalizationAlertSchema);
}

export function findReceiptFinalizationDraft(
  stateDir: string,
  workspaceId: string,
  draftId: string,
): ReceiptFinalizationDraft | null {
  const dir = path.join(baseDir(stateDir), "drafts");
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.name.startsWith(`${workspaceId}-`) || !entry.name.endsWith(".json")) continue;
      const draft = readRegular(path.join(dir, entry.name), receiptFinalizationDraftSchema);
      if (draft?.draftId === draftId) return draft;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return null;
}

export function listReceiptFinalizationAlerts(stateDir = getStateDir()): ReceiptFinalizationAlert[] {
  const dir = path.join(baseDir(stateDir), "alerts");
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.name.endsWith(".json"))
      .map(entry => readRegular(path.join(dir, entry.name), receiptFinalizationAlertSchema))
      .filter((item): item is ReceiptFinalizationAlert => item !== null);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function stageReceiptFinalization(
  input: Omit<ReceiptFinalizationDraft, "version" | "draftId" | "createdAt" | "expiresAt" | "inputDigest" | "input" | "marker"> &
    ({ inputMaterial: string } | { input: ReceiptFinalizationInput; marker: ReceiptFinalizationMarker }),
  options: { stateDir?: string; nowMs?: number } = {},
): ReceiptFinalizationDraft {
  const stateDir = options.stateDir ?? getStateDir();
  const now = options.nowMs ?? Date.now();
  const isV2 = !("inputMaterial" in input);
  let sanitizedInput: ReceiptFinalizationInput | undefined;
  let marker: ReceiptFinalizationMarker | undefined;
  let inputMaterial: string;
  if ("inputMaterial" in input) {
    inputMaterial = input.inputMaterial;
  } else {
    sanitizedInput = sanitizeReceiptFinalizationInput(input.input);
    marker = parseMarker(input.marker);
    inputMaterial = canonicalReceiptFinalizationInput(sanitizedInput);
  }
  const digest = createHash("sha256").update(inputMaterial, "utf8").digest("hex");
  const draft = receiptFinalizationDraftSchema.parse({
    version: isV2 ? 2 : 1,
    draftId: randomUUID(),
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    threadId: input.threadId,
    originTurnId: input.originTurnId,
    resultTurnId: input.resultTurnId,
    commandId: input.commandId,
    inputDigest: digest,
    ...(sanitizedInput && marker ? { input: sanitizedInput, marker } : {}),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + RECEIPT_FINALIZER_MAX_LIFETIME_MS).toISOString(),
  });
  const file = receiptFinalizationDraftPath(stateDir, draft.workspaceId, draft.commandId);
  const prior = readRegular(file, receiptFinalizationDraftSchema);
  if (prior) {
    const markerSame = draftMarkerEqual(prior, draft);
    if (prior.inputDigest !== draft.inputDigest || prior.resultTurnId !== draft.resultTurnId ||
        prior.originTurnId !== draft.originTurnId || !markerSame) {
      throw new Error("同一 Desktop command 已有不一致的 pending receipt；拒绝覆盖。");
    }
    return prior;
  }
  if (!writeExclusive(file, draft)) {
    const raced = readRegular(file, receiptFinalizationDraftSchema);
    const markerSame = raced ? draftMarkerEqual(raced, draft) : false;
    if (raced && raced.inputDigest === draft.inputDigest && raced.resultTurnId === draft.resultTurnId && markerSame) return raced;
    throw new Error("并发创建了不一致的 pending receipt；拒绝覆盖。");
  }
  return draft;
}

export function writeReceiptFinalizationAlert(
  draft: ReceiptFinalizationDraft,
  reason: ReceiptFinalizationAlert["reason"],
  options: { stateDir?: string; nowMs?: number } = {},
): ReceiptFinalizationAlert {
  const stateDir = options.stateDir ?? getStateDir();
  const alert = receiptFinalizationAlertSchema.parse({
    version: 1,
    alertId: draft.draftId,
    workspaceId: draft.workspaceId,
    commandId: draft.commandId,
    reason,
    occurredAt: new Date(options.nowMs ?? Date.now()).toISOString(),
  });
  const file = receiptFinalizationAlertPath(stateDir, draft.workspaceId, draft.commandId);
  const prior = readRegular(file, receiptFinalizationAlertSchema);
  if (prior) return prior;
  if (!writeExclusive(file, alert)) return readRegular(file, receiptFinalizationAlertSchema) ?? alert;
  return alert;
}

export function writeReceiptFinalizationWorkerFailureAlert(
  draft: ReceiptFinalizationDraft,
  options: { stateDir?: string } = {},
): ReceiptFinalizationAlert | null {
  const stateDir = options.stateDir ?? getStateDir();
  // Reuse the existing v1 reason so older strict alert readers remain compatible.
  try {
    const records = readExecutionRecordsStrict(draft.workspaceId, stateDir)
      .filter(record => record.commandId === draft.commandId);
    if (records.length === 1 && isTrustedDesktopReceipt(records[0]!, draft.commandId)) return null;
  } catch { /* Unable to prove a receipt; keep the bounded alert. */ }
  return writeReceiptFinalizationAlert(draft, "terminality_unknown", { stateDir });
}

function claimPath(stateDir: string, draft: ReceiptFinalizationDraft): string {
  return receiptFinalizationClaimPath(stateDir, draft.workspaceId, draft.commandId);
}

const claimSchema = z.object({
  version: z.literal(1), draftId: UUID, pid: z.number().int().positive(), claimedAt: z.string().datetime(),
}).strict();

function acquireClaim(stateDir: string, draft: ReceiptFinalizationDraft): boolean {
  const file = claimPath(stateDir, draft);
  const claim = { version: 1, draftId: draft.draftId, pid: process.pid, claimedAt: new Date().toISOString() };
  if (writeExclusive(file, claim)) return true;
  const prior = readRegular(file, claimSchema);
  if (prior && Date.now() - Date.parse(prior.claimedAt) < 2 * 60_000) return false;
  if (prior) {
    fs.rmSync(file, { force: true });
  }
  if (writeExclusive(file, claim)) return true;
  const raced = readRegular(file, claimSchema);
  if (raced && Date.now() - Date.parse(raced.claimedAt) < 2 * 60_000) return false;
  throw new Error("receipt finalization claim changed while acquiring it");
}

function releaseClaim(stateDir: string, draft: ReceiptFinalizationDraft): void {
  const file = claimPath(stateDir, draft);
  const claim = readRegular(file, claimSchema);
  if (claim?.draftId === draft.draftId && claim.pid === process.pid) fs.rmSync(file, { force: true });
}

function finalizerTarget(draft: ReceiptFinalizationDraft): DesktopTarget {
  const state = readDesktop(draft.workspaceId);
  if (!state || state.workspaceRoot !== draft.workspaceRoot || !state.binding ||
      state.binding.threadId !== draft.threadId) {
    throw new DesktopError("DESKTOP_TARGET_NOT_FOUND", "Desktop durable binding no longer matches pending receipt.");
  }
  const deliveries = state.deliveries.filter(delivery =>
    delivery.deliveryStatus === "accepted" &&
    delivery.commandId === draft.commandId &&
    delivery.threadId === draft.threadId &&
    delivery.turnId === draft.originTurnId,
  );
  if (deliveries.length !== 1) {
    throw new DesktopError("DESKTOP_RECONCILIATION_CONFLICT", "pending receipt has no unique accepted delivery.");
  }
  return {
    threadId: state.binding.threadId,
    hostId: state.binding.hostId,
    projectId: state.binding.projectId,
    workspaceRoot: draft.workspaceRoot,
  };
}

function removeDraft(stateDir: string, draft: ReceiptFinalizationDraft): void {
  const file = receiptFinalizationDraftPath(stateDir, draft.workspaceId, draft.commandId);
  const current = readRegular(file, receiptFinalizationDraftSchema);
  if (current?.draftId === draft.draftId) fs.rmSync(file, { force: true });
}

function removeAlert(stateDir: string, draft: ReceiptFinalizationDraft): void {
  const file = receiptFinalizationAlertPath(stateDir, draft.workspaceId, draft.commandId);
  const current = readRegular(file, receiptFinalizationAlertSchema);
  if (current?.alertId === draft.draftId) fs.rmSync(file, { force: true });
}

function isV2Draft(draft: ReceiptFinalizationDraft): draft is Extract<ReceiptFinalizationDraft, { version: 2 }> {
  return draft.version === 2;
}

function assertFenceIdentity(fence: ReceiptFinalizationFenceResult, draft: ReceiptFinalizationDraft, target: DesktopTarget): void {
  if (fence.threadId !== target.threadId || fence.hostId !== target.hostId || fence.projectId !== target.projectId ||
      fence.workspaceRoot !== target.workspaceRoot) {
    throw new DesktopError("DESKTOP_PROCESS_CHANGED", "Desktop receipt terminal fence identity changed.");
  }
  if (!["inProgress", "completed", "failed", "interrupted", "cancelled"].includes(fence.resultTurnStatus)) {
    throw new DesktopError("DESKTOP_STATE_UNAVAILABLE", "Desktop receipt terminal fence status is invalid.");
  }
}

export async function runReceiptFinalizer(
  draft: ReceiptFinalizationDraft,
  options: { stateDir?: string; pollMs?: number; nowMs?: () => number } = {},
): Promise<ReceiptFinalizationAlert | DesktopResultReceipt | null> {
  const stateDir = options.stateDir ?? getStateDir();
  if (!acquireClaim(stateDir, draft)) return null;
  const now = options.nowMs ?? (() => Date.now());
  const pollMs = Math.max(1_000, options.pollMs ?? RECEIPT_FINALIZER_POLL_MS);
  let attemptedObservation = false;
  try {
    // 即使 draft 刚过期也做一次 target/delivery/identity 观察，保证已有 pending
    // draft 能收敛为 bounded alert，而不是因过期直接静默退出。
    while (!attemptedObservation || now() < Date.parse(draft.expiresAt)) {
      attemptedObservation = true;
      try {
        const target = finalizerTarget(draft);
        if (isV2Draft(draft)) {
          const fence = await markerIpc.inspectResultTerminalFence(target, draft.marker);
          assertFenceIdentity(fence, draft, target);
          if (fence.fence === "post_record_activity") {
            return writeReceiptFinalizationAlert(draft, "post_record_activity", { stateDir });
          }
          if (fence.fence === "unprovable") {
            return writeReceiptFinalizationAlert(draft, "post_record_activity_unprovable", { stateDir });
          }
          if (fence.resultTurnId !== draft.resultTurnId) {
            return writeReceiptFinalizationAlert(draft, "identity_drift", { stateDir });
          }
          if (fence.fence === "inProgress") {
            await new Promise(resolve => setTimeout(resolve, pollMs));
            continue;
          }
          if (fence.fence !== "safe_terminal") {
            return writeReceiptFinalizationAlert(draft, "terminality_unknown", { stateDir });
          }
          try {
            const { finalizeReceiptFinalizationDraft } = await import("./result.js");
            const receipt = await finalizeReceiptFinalizationDraft(draft, target, fence);
            removeDraft(stateDir, draft);
            removeAlert(stateDir, draft);
            return receipt;
          } catch {
            return writeReceiptFinalizationAlert(draft, "terminality_unknown", { stateDir });
          }
        }
        const context = await desktopIpc.inspectResultContext(target);
        if (context.threadId !== draft.threadId || context.workspaceRoot !== draft.workspaceRoot ||
            context.projectId !== target.projectId || context.hostId !== target.hostId) {
          return writeReceiptFinalizationAlert(draft, "identity_drift", { stateDir });
        }
        if (context.resultTurnId !== draft.resultTurnId) {
          return writeReceiptFinalizationAlert(draft, "post_record_activity", { stateDir });
        }
        if (context.resultTurnStatus === "inProgress") {
          await new Promise(resolve => setTimeout(resolve, pollMs));
          continue;
        }
        // Legacy v1 drafts have no activity marker, so terminal ordering remains
        // unprovable; v2 drafts use the strict marker fence above.
        return writeReceiptFinalizationAlert(draft, "post_record_activity_unprovable", { stateDir });
      } catch (error) {
        if (!(error instanceof DesktopError) ||
            !["DESKTOP_STATE_UNAVAILABLE", "DESKTOP_IPC_UNAVAILABLE", "DESKTOP_IPC_TIMEOUT"].includes(error.code)) {
          return writeReceiptFinalizationAlert(draft, "identity_drift", { stateDir });
        }
        await new Promise(resolve => setTimeout(resolve, pollMs));
      }
    }
    return writeReceiptFinalizationAlert(draft, "timeout", { stateDir });
  } finally {
    releaseClaim(stateDir, draft);
  }
}

export function spawnReceiptFinalizerWorker(
  draft: ReceiptFinalizationDraft,
  options: { stateDir?: string; spawnImpl?: typeof spawn; entry?: string } = {},
): ChildProcess {
  const stateDir = options.stateDir ?? getStateDir();
  const spawnFn = options.spawnImpl ?? spawn;
  const entry = options.entry ?? process.argv[1];
  if (!entry) throw new Error("无法确定 receipt finalizer worker entry");
  const env = { ...process.env };
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_SESSION_ID;
  delete env.C2C_STARTUP_LEASE;
  env.C2C_RECEIPT_FINALIZER_STATE_DIR = path.resolve(stateDir);
  env.C2C_STATE_DIR = path.resolve(stateDir);
  const runtimeArgs = path.extname(entry).toLowerCase() === ".ts" ? ["--import", "tsx"] : [];
  const child = spawnFn(process.execPath, [...runtimeArgs, entry, "desktop-receipt-finalizer", "run", "-w", draft.workspaceRoot, "--draft", draft.draftId], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env,
  });
  child.once("error", () => { try { writeReceiptFinalizationAlert(draft, "worker_spawn_failed", { stateDir }); } catch { /* bounded fallback */ } });
  child.once("exit", (code, signal) => {
    if (code === 0 && signal === null) return;
    try { writeReceiptFinalizationWorkerFailureAlert(draft, { stateDir }); } catch { /* bounded fallback */ }
  });
  child.unref();
  return child;
}
