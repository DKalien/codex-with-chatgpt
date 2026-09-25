import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";
import { isTrustedDesktopReceipt, readExecutionRecordsStrict, type StoredExecutionRecord } from "../execution/records.js";
import { readExecutionOutputMetadataStrict, type ExecutionOutputMeta } from "../execution/output.js";
import { readAbandonments } from "./abandonment.js";
import { readLegacyReconciliations, withEvidenceLock } from "./legacy-reconciliation.js";
import { readLegacyRetirements } from "./legacy-retirement.js";
import { DesktopError, desktopId, readDesktop, type DesktopDelivery, type DesktopState } from "./store.js";

const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const notice = "仅停止等待并接受结果不明；不代表已投递、已接受、已完成或成功。";

const deliverySchema = z.object({
  commandId: desktopId,
  clientId: z.string().min(1).max(256),
  bindingId: uuid,
  intent: z.union([z.literal("development_plan"), z.literal("revision"), z.null()]),
  messageSha256: sha256,
  messageBytes: z.number().int().positive().max(64 * 1024),
  threadId: uuid,
  deliveryStatus: z.literal("outcome_unknown"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

const entrySchema = z.object({
  commandId: desktopId,
  workspaceRoot: z.string().min(1),
  delivery: deliverySchema,
  confirmationSha256: sha256,
  resolvedAt: z.string().datetime(),
}).strict();

const stateSchema = z.object({
  version: z.literal(1),
  workspaceId: desktopId,
  entries: z.array(entrySchema).max(10_000),
}).strict().superRefine((state, ctx) => {
  const ids = state.entries.map(entry => entry.commandId);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "行政 resolution 含重复 commandId" });
  for (const entry of state.entries) {
    if (entry.delivery.commandId !== entry.commandId || entry.confirmationSha256 !== confirmationDigest(state.workspaceId, entry.workspaceRoot, entry.delivery)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "行政 resolution 摘要与事实不一致" });
    }
  }
});

type ResolutionState = z.infer<typeof stateSchema>;
export type OutcomeResolutionEntry = z.infer<typeof entrySchema>;

export interface OutcomeResolutionWorkspace { id: string; root: string }
export interface OutcomeResolutionPreview {
  commandId: string;
  confirmationSha256: string;
  notice: typeof notice;
}
export interface OutcomeResolutionResult extends OutcomeResolutionPreview {
  status: "resolved_unknown" | "already_resolved_unknown";
}

export class OutcomeResolutionError extends DesktopError {
  constructor(code: string, message: string) { super(code, message); this.name = "OutcomeResolutionError"; }
}

function invalid(message: string): never {
  throw new OutcomeResolutionError("DESKTOP_OUTCOME_RESOLUTION_INVALID", message);
}
function notEligible(message: string): never {
  throw new OutcomeResolutionError("DESKTOP_OUTCOME_RESOLUTION_NOT_ELIGIBLE", message);
}
function conflict(message: string): never {
  throw new OutcomeResolutionError("DESKTOP_OUTCOME_RESOLUTION_CONFLICT", message);
}
function corrupt(message: string): never {
  throw new OutcomeResolutionError("DESKTOP_OUTCOME_RESOLUTION_STORE_CORRUPT", message);
}

function workspaceOf(raw: OutcomeResolutionWorkspace): OutcomeResolutionWorkspace {
  if (!raw || typeof raw.root !== "string" || !raw.root.trim()) return invalid("workspace 根目录无效；拒绝行政 resolution。");
  try { return { id: desktopId.parse(raw.id), root: raw.root }; }
  catch { return invalid("workspaceId 无效；拒绝行政 resolution。"); }
}

function resolutionFile(workspaceId: string): string {
  return path.join(getStateDir(), "desktop-outcome-resolution", `${desktopId.parse(workspaceId)}.json`);
}
export function outcomeResolutionFile(workspaceId: string): string { return resolutionFile(workspaceId); }
function markerFile(workspaceId: string): string { return `${resolutionFile(workspaceId)}.initialized`; }
function hasTemp(workspaceId: string): boolean {
  const file = resolutionFile(workspaceId);
  try {
    return fs.readdirSync(path.dirname(file)).some(name => name.startsWith(`${path.basename(file)}.`) && name.endsWith(".tmp"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return corrupt("行政 resolution 目录无法读取；拒绝继续。");
  }
}

function readState(workspaceId: string): ResolutionState {
  const file = resolutionFile(workspaceId);
  if (hasTemp(workspaceId)) return corrupt("行政 resolution 含未完成临时文件；拒绝继续。");
  const exists = fs.existsSync(file);
  const marker = fs.existsSync(markerFile(workspaceId));
  if (!exists) {
    if (marker) return corrupt("行政 resolution 主文件缺失；拒绝重置证据。");
    return { version: 1, workspaceId, entries: [] };
  }
  if (!marker) return corrupt("行政 resolution 初始化标记缺失；拒绝读取证据。");
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return corrupt("行政 resolution 证据损坏；保留文件并人工核对。"); }
  const state = stateSchema.safeParse(parsed);
  if (!state.success || state.data.workspaceId !== workspaceId) return corrupt("行政 resolution schema 或 workspaceId 不一致；拒绝继续。");
  return state.data;
}

function writeState(workspaceId: string, state: ResolutionState): void {
  const file = resolutionFile(workspaceId);
  const marker = markerFile(workspaceId);
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let prepared = false;
  try {
    const parsed = stateSchema.parse(state);
    ensureDir(path.dirname(file));
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(parsed), "utf8");
    fs.fsyncSync(fd);
    prepared = true;
  } catch { return corrupt("行政 resolution 证据无法写入；保留原文件并人工核对。"); }
  finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (!prepared) fs.rmSync(temporary, { force: true });
  }
  try {
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
    if (!fs.existsSync(marker)) {
      const markerFd = fs.openSync(marker, "wx", 0o600);
      try { fs.writeFileSync(markerFd, "1\n", "utf8"); fs.fsyncSync(markerFd); }
      finally { fs.closeSync(markerFd); }
    }
  } catch { return corrupt("行政 resolution 证据提交失败；保留原文件并人工核对。"); }
  finally { fs.rmSync(temporary, { force: true }); }
}

function canonicalDelivery(delivery: DesktopDelivery): z.infer<typeof deliverySchema> {
  if (delivery.deliveryStatus !== "outcome_unknown" || delivery.errorCode !== undefined || delivery.errorMessage !== undefined) {
    return conflict("指定 delivery 不是无错误的 outcome_unknown；拒绝行政 resolution。");
  }
  return deliverySchema.parse({
    commandId: delivery.commandId, clientId: delivery.clientId, bindingId: delivery.bindingId,
    intent: delivery.intent ?? null, messageSha256: delivery.messageSha256, messageBytes: delivery.messageBytes,
    threadId: delivery.threadId, deliveryStatus: "outcome_unknown", createdAt: delivery.createdAt, updatedAt: delivery.updatedAt,
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
function confirmationDigest(workspaceId: string, workspaceRoot: string, delivery: z.infer<typeof deliverySchema>): string {
  return createHash("sha256").update(canonicalJson({ purpose: "desktop-outcome-resolution-v1", workspaceId, workspaceRoot, delivery }), "utf8").digest("hex");
}

function matchingRecord(records: StoredExecutionRecord[], commandId: string): StoredExecutionRecord[] {
  return records.filter(record => record.commandId === commandId || record.taskId === `desktop_${commandId}`);
}

function matchingOutput(outputs: ExecutionOutputMeta[], commandId: string): ExecutionOutputMeta[] {
  return outputs.filter(output => output.taskId === commandId || output.taskId === `desktop_${commandId}`);
}

function checkConflictingEvidence(workspaceId: string, commandId: string): void {
  let records: StoredExecutionRecord[];
  try { records = readExecutionRecordsStrict(workspaceId); }
  catch { return corrupt("execution JSONL 损坏或不完整；拒绝行政 resolution。"); }
  const matches = matchingRecord(records, commandId);
  if (matches.length > 1 || (matches.length === 1 && isTrustedDesktopReceipt(matches[0]!, commandId))) {
    return conflict("指定 commandId 已有可信 Desktop receipt；拒绝行政 resolution。");
  }
  if (matches.length === 1) {
    return conflict("指定 commandId 已有 execution record；拒绝行政 resolution。");
  }
  let outputs: ExecutionOutputMeta[];
  try { outputs = readExecutionOutputMetadataStrict(workspaceId); }
  catch { return corrupt("execution output index 损坏或不完整；拒绝行政 resolution。"); }
  if (matchingOutput(outputs, commandId).length > 0) {
    return conflict("指定 commandId 已有 execution output 证据；拒绝行政 resolution。");
  }
  let reconciliations: ReturnType<typeof readLegacyReconciliations>;
  let retirements: ReturnType<typeof readLegacyRetirements>;
  let abandonments: ReturnType<typeof readAbandonments>;
  try {
    reconciliations = readLegacyReconciliations(workspaceId);
    retirements = readLegacyRetirements(workspaceId);
    abandonments = readAbandonments(workspaceId);
  } catch { return corrupt("既有 reconciliation/retirement/abandonment 证据无法安全读取；拒绝行政 resolution。"); }
  if (reconciliations.some(entry => entry.commandId === commandId) ||
      retirements.some(entry => entry.commandId === commandId) ||
      abandonments.some(entry => entry.commandId === commandId)) {
    return conflict("指定 commandId 已有其他行政或对账证据；拒绝追加 resolution。");
  }
}

function facts(workspace: OutcomeResolutionWorkspace, commandIdRaw: string, state: ResolutionState, desktopOverride?: DesktopState | null): { delivery: z.infer<typeof deliverySchema>; existing?: OutcomeResolutionEntry } {
  let commandId: string;
  try { commandId = desktopId.parse(commandIdRaw); }
  catch { return invalid("commandId 无效；拒绝行政 resolution。"); }
  const desktop = desktopOverride === undefined ? readDesktop(workspace.id) : desktopOverride;
  if (!desktop || desktop.workspaceRoot !== workspace.root) return notEligible("没有与当前 workspace 根目录一致的 Desktop 状态；拒绝行政 resolution。");
  const delivery = desktop.deliveries.find(item => item.commandId === commandId);
  if (!delivery || delivery.deliveryStatus !== "outcome_unknown") return notEligible("指定 commandId 不存在 outcome_unknown delivery；拒绝行政 resolution。");
  const summary = canonicalDelivery(delivery);
  const existing = state.entries.find(entry => entry.commandId === commandId);
  if (state.entries.some(entry => entry.workspaceRoot !== workspace.root && entry.commandId === commandId)) return conflict("已有行政 resolution workspace 根目录冲突；拒绝继续。");
  if (existing && (existing.workspaceRoot !== workspace.root || existing.confirmationSha256 !== confirmationDigest(workspace.id, workspace.root, summary) || canonicalJson(existing.delivery) !== canonicalJson(summary))) {
    return conflict("已有行政 resolution 与当前 outcome_unknown delivery 不一致；拒绝覆盖。");
  }
  checkConflictingEvidence(workspace.id, commandId);
  return { delivery: summary, existing };
}

function parseConfirmation(value: string): string {
  try { return sha256.parse(value); }
  catch { throw new OutcomeResolutionError("DESKTOP_OUTCOME_RESOLUTION_CONFIRMATION_INVALID", "confirmation 摘要必须是 64 位小写十六进制值。"); }
}

export function readOutcomeResolutions(workspaceId: string): OutcomeResolutionEntry[] {
  try { return readState(desktopId.parse(workspaceId)).entries; }
  catch (error) { if (error instanceof OutcomeResolutionError) throw error; return corrupt("行政 resolution 证据无法安全读取；拒绝继续。"); }
}

/** reconciliation 不能把已有的独立行政决定改写成 accepted。 */
export function assertNoOutcomeResolutionForCommand(workspaceId: string, commandId: string): void {
  const entries = readOutcomeResolutions(workspaceId);
  if (entries.some(entry => entry.commandId === commandId)) {
    throw new OutcomeResolutionError("DESKTOP_OUTCOME_RESOLUTION_CONFLICT", "该 commandId 已有行政 resolution；不得再通过 Desktop reconciliation 改写原 delivery。");
  }
}

export function previewOutcomeResolution(workspaceRaw: OutcomeResolutionWorkspace, commandIdRaw: string): OutcomeResolutionPreview {
  const workspace = workspaceOf(workspaceRaw);
  const state = readState(workspace.id);
  const { delivery, existing } = facts(workspace, commandIdRaw, state);
  const confirmationSha256 = confirmationDigest(workspace.id, workspace.root, delivery);
  if (existing && existing.confirmationSha256 !== confirmationSha256) return conflict("已有行政 resolution confirmation 摘要不一致；拒绝继续。");
  return { commandId: delivery.commandId, confirmationSha256, notice };
}

export function resolveOutcomeUnknown(
  workspaceRaw: OutcomeResolutionWorkspace,
  commandIdRaw: string,
  confirmationRaw: string,
): OutcomeResolutionResult {
  const workspace = workspaceOf(workspaceRaw);
  const confirmationSha256 = parseConfirmation(confirmationRaw);
  const initial = readState(workspace.id);
  const initialFacts = facts(workspace, commandIdRaw, initial);
  const expected = confirmationDigest(workspace.id, workspace.root, initialFacts.delivery);
  if (expected !== confirmationSha256) throw new OutcomeResolutionError("DESKTOP_OUTCOME_RESOLUTION_CONFIRMATION_MISMATCH", "confirmation 摘要与当前 workspace、delivery 或本地证据不一致；拒绝写入。");
  try {
    return withEvidenceLock(workspace.id, () => {
      const locked = readState(workspace.id);
      const lockedFacts = facts(workspace, commandIdRaw, locked);
      const digest = confirmationDigest(workspace.id, workspace.root, lockedFacts.delivery);
      if (digest !== confirmationSha256) return conflict("确认期间 workspace、delivery 或既有证据发生变化；拒绝写入。");
      if (lockedFacts.existing) return { status: "already_resolved_unknown", commandId: lockedFacts.delivery.commandId, confirmationSha256, notice };
      const entry: OutcomeResolutionEntry = {
        commandId: lockedFacts.delivery.commandId,
        workspaceRoot: workspace.root,
        delivery: lockedFacts.delivery,
        confirmationSha256,
        resolvedAt: new Date().toISOString(),
      };
      writeState(workspace.id, { ...locked, entries: [...locked.entries, entry] });
      return { status: "resolved_unknown", commandId: entry.commandId, confirmationSha256, notice };
    });
  } catch (error) {
    if (error instanceof OutcomeResolutionError) throw error;
    if (error instanceof DesktopError && error.code.startsWith("LEGACY_RECONCILIATION_")) {
      throw new OutcomeResolutionError("DESKTOP_OUTCOME_RESOLUTION_BUSY", "行政 resolution/reconciliation 写锁繁忙或无法安全确认；请稍后重试。");
    }
    throw new OutcomeResolutionError("DESKTOP_OUTCOME_RESOLUTION_STORE_WRITE", "行政 resolution 提交失败；保留原文件并人工核对。");
  }
}

/** 严格验证并返回仍对应当前 raw outcome_unknown 的行政解决 commandId。 */
export function getResolvedUnknownCommandIds(workspaceRaw: OutcomeResolutionWorkspace, desktopOverride?: DesktopState | null): Set<string> {
  const workspace = workspaceOf(workspaceRaw);
  const state = readState(workspace.id);
  if (!state.entries.length) return new Set();
  const desktop = desktopOverride === undefined ? readDesktop(workspace.id) : desktopOverride;
  if (!desktop || desktop.workspaceRoot !== workspace.root) return conflict("行政 resolution 与当前 workspace 状态不一致；拒绝忽略未知结果。");
  const resolved = new Set<string>();
  for (const entry of state.entries) {
    const current = facts(workspace, entry.commandId, state, desktop);
    if (entry.workspaceRoot !== workspace.root || canonicalJson(entry.delivery) !== canonicalJson(current.delivery) ||
        entry.confirmationSha256 !== confirmationDigest(workspace.id, workspace.root, current.delivery)) {
      return conflict("已有行政 resolution 与当前 delivery 事实冲突；拒绝忽略证据。");
    }
    resolved.add(entry.commandId);
  }
  return resolved;
}

export function unresolvedOutcomeUnknownCommandIds(workspaceRaw: OutcomeResolutionWorkspace, state?: DesktopState | null): Set<string> {
  const workspace = workspaceOf(workspaceRaw);
  const desktop = readDesktop(workspace.id);
  if (state !== undefined) {
    const emptyState = { version: 1 as const, workspaceId: workspace.id, workspaceRoot: workspace.root,
      enabled: false, binding: null, deliveries: [] };
    const matchesDisk = state === null && desktop === null ||
      state !== null && desktop !== null && JSON.stringify(state) === JSON.stringify(desktop) ||
      state !== null && desktop === null && JSON.stringify(state) === JSON.stringify(emptyState);
    if (!matchesDisk) {
      if (desktop && (desktop.revision ?? 0) > (state?.revision ?? 0))
        throw new DesktopError("DESKTOP_STORE_BUSY", "Desktop 状态在 unresolved 检查期间发生变化；请重试。");
      return conflict("Desktop 状态与 unresolved 检查快照不一致；拒绝忽略未知结果。");
    }
  }
  if (desktop && desktop.workspaceRoot !== workspace.root) return conflict("Desktop workspace 根目录不一致；拒绝忽略未知结果。");
  const unknown = new Set((desktop?.deliveries ?? []).filter(item => item.deliveryStatus === "outcome_unknown").map(item => item.commandId));
  const resolved = getResolvedUnknownCommandIds(workspace, desktop);
  return new Set([...unknown].filter(commandId => !resolved.has(commandId)));
}

export function isOutcomeUnknownAdministrativelyResolved(workspaceRaw: OutcomeResolutionWorkspace, commandId: string): boolean {
  return getResolvedUnknownCommandIds(workspaceRaw).has(desktopId.parse(commandId));
}
