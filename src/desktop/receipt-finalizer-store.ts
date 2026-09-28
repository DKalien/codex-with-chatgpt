import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";
import {
  isTrustedDesktopReceipt,
  readExecutionRecordsStrict,
} from "../execution/records.js";
import {
  RECEIPT_FINALIZER_MAX_LIFETIME_MS,
  canonicalReceiptFinalizationInput,
  parseReceiptFinalizationMarker,
  receiptFinalizationAlertSchema,
  receiptFinalizationDraftMarkerEqual,
  receiptFinalizationDraftSchema,
  receiptFinalizationOwnershipSnapshotSchema,
  sanitizeReceiptFinalizationInput,
  type ReceiptFinalizationAlert,
  type ReceiptFinalizationDraft,
  type ReceiptFinalizationInput,
  type ReceiptFinalizationMarker,
  type ReceiptFinalizationOwnershipSnapshot,
} from "./receipt-finalizer-schema.js";

const claimSchema = z.object({
  version: z.literal(1), draftId: z.string().uuid(), pid: z.number().int().positive(), claimedAt: z.string().datetime(),
}).strict();

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

export function readRegular<T>(file: string, schema: z.ZodType<T>): T | null {
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

export function writeExclusive(file: string, value: unknown): boolean {
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
  input: Omit<ReceiptFinalizationDraft, "version" | "draftId" | "createdAt" | "expiresAt" | "inputDigest" | "input" | "marker" | "ownershipSnapshot"> &
    ({ inputMaterial: string } | {
      input: ReceiptFinalizationInput;
      marker: ReceiptFinalizationMarker;
      ownershipSnapshot: ReceiptFinalizationOwnershipSnapshot;
    }),
  options: { stateDir?: string; nowMs?: number } = {},
): ReceiptFinalizationDraft {
  const stateDir = options.stateDir ?? getStateDir();
  const now = options.nowMs ?? Date.now();
  const isV3 = !("inputMaterial" in input);
  let sanitizedInput: ReceiptFinalizationInput | undefined;
  let marker: ReceiptFinalizationMarker | undefined;
  let ownershipSnapshot: ReceiptFinalizationOwnershipSnapshot | undefined;
  let inputMaterial: string;
  if ("inputMaterial" in input) {
    inputMaterial = input.inputMaterial;
  } else {
    sanitizedInput = sanitizeReceiptFinalizationInput(input.input);
    marker = parseReceiptFinalizationMarker(input.marker);
    ownershipSnapshot = receiptFinalizationOwnershipSnapshotSchema.parse(input.ownershipSnapshot);
    inputMaterial = canonicalReceiptFinalizationInput(sanitizedInput);
  }
  const digest = createHash("sha256").update(inputMaterial, "utf8").digest("hex");
  const draft = receiptFinalizationDraftSchema.parse({
    version: isV3 ? 3 : 1,
    draftId: randomUUID(),
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    threadId: input.threadId,
    originTurnId: input.originTurnId,
    resultTurnId: input.resultTurnId,
    commandId: input.commandId,
    inputDigest: digest,
    ...(sanitizedInput && marker && ownershipSnapshot ? { input: sanitizedInput, marker, ownershipSnapshot } : {}),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + RECEIPT_FINALIZER_MAX_LIFETIME_MS).toISOString(),
  });
  const file = receiptFinalizationDraftPath(stateDir, draft.workspaceId, draft.commandId);
  const prior = readRegular(file, receiptFinalizationDraftSchema);
  if (prior) {
    const markerSame = receiptFinalizationDraftMarkerEqual(prior, draft);
    if (prior.inputDigest !== draft.inputDigest || prior.resultTurnId !== draft.resultTurnId ||
        prior.originTurnId !== draft.originTurnId || !markerSame) {
      throw new Error("同一 Desktop command 已有不一致的 pending receipt；拒绝覆盖。");
    }
    return prior;
  }
  if (!writeExclusive(file, draft)) {
    const raced = readRegular(file, receiptFinalizationDraftSchema);
    const markerSame = raced ? receiptFinalizationDraftMarkerEqual(raced, draft) : false;
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

export function acquireReceiptFinalizationClaim(stateDir: string, draft: ReceiptFinalizationDraft): boolean {
  const file = receiptFinalizationClaimPath(stateDir, draft.workspaceId, draft.commandId);
  const claim = { version: 1, draftId: draft.draftId, pid: process.pid, claimedAt: new Date().toISOString() };
  if (writeExclusive(file, claim)) return true;
  const prior = readRegular(file, claimSchema);
  if (prior && Date.now() - Date.parse(prior.claimedAt) < 2 * 60_000) return false;
  if (prior) fs.rmSync(file, { force: true });
  if (writeExclusive(file, claim)) return true;
  const raced = readRegular(file, claimSchema);
  if (raced && Date.now() - Date.parse(raced.claimedAt) < 2 * 60_000) return false;
  throw new Error("receipt finalization claim changed while acquiring it");
}

export function releaseReceiptFinalizationClaim(stateDir: string, draft: ReceiptFinalizationDraft): void {
  const file = receiptFinalizationClaimPath(stateDir, draft.workspaceId, draft.commandId);
  const claim = readRegular(file, claimSchema);
  if (claim?.draftId === draft.draftId && claim.pid === process.pid) fs.rmSync(file, { force: true });
}

export function removeReceiptFinalizationDraft(stateDir: string, draft: ReceiptFinalizationDraft): void {
  const file = receiptFinalizationDraftPath(stateDir, draft.workspaceId, draft.commandId);
  const current = readRegular(file, receiptFinalizationDraftSchema);
  if (current?.draftId === draft.draftId) fs.rmSync(file, { force: true });
}

export function removeReceiptFinalizationAlert(stateDir: string, draft: ReceiptFinalizationDraft): void {
  const file = receiptFinalizationAlertPath(stateDir, draft.workspaceId, draft.commandId);
  const current = readRegular(file, receiptFinalizationAlertSchema);
  if (current?.alertId === draft.draftId) fs.rmSync(file, { force: true });
}
