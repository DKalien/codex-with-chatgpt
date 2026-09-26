import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";
import {
  isTrustedDesktopReceipt,
  readExecutionRecordsStrict,
  type StoredExecutionRecord,
} from "../execution/records.js";
import { readExecutionOutputMetadataStrict, type ExecutionOutputMeta } from "../execution/output.js";
import { desktopIpc, type DesktopResultContext } from "./ipc.js";
import {
  DesktopError,
  desktopId,
  readDesktop,
  type DesktopBinding,
  type DesktopDelivery,
  type DesktopState,
} from "./store.js";
import { readLegacyReconciliations, withEvidenceLock, type LegacyReconciliationEvidence } from "./legacy-reconciliation.js";
import { readLegacyRetirements, type LegacyRetirementEvidence } from "./legacy-retirement.js";
import { unresolvedOutcomeUnknownCommandIds } from "./outcome-resolution.js";

const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalTimestamp = z.string().refine(value => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}, "必须为 canonical ISO datetime");
const abandonmentNotice = "仅停止等待，不代表完成/成功";
const MAX_BATCH_COMMANDS = 10_000;
const CURRENT_CONTEXT_ATTEMPTS = 3;
const CURRENT_CONTEXT_RETRY_DELAY_MS = 25;

const deliverySummarySchema = z.object({
  commandId: desktopId,
  deliveryId: uuid.optional(),
  clientId: z.string().min(1).max(256),
  bindingId: uuid,
  intent: z.union([z.literal("development_plan"), z.literal("revision"), z.null()]),
  messageSha256: sha256,
  messageBytes: z.number().int().positive().max(64 * 1024),
  threadId: uuid,
  turnId: uuid,
  deliveryStatus: z.literal("accepted"),
  errorCode: z.null(),
  errorMessage: z.null(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

const abandonmentBatchSchema = z.object({
  commandIds: z.array(desktopId).min(1).max(MAX_BATCH_COMMANDS),
  deliveries: z.array(deliverySummarySchema).min(1).max(MAX_BATCH_COMMANDS),
  selectionSha256: sha256,
  confirmationSha256: sha256,
  abandonedAt: canonicalTimestamp,
  maintenanceThreadId: uuid,
  maintenanceTurnId: uuid,
}).strict().superRefine((batch, ctx) => {
  const sorted = [...batch.commandIds].sort();
  if (sorted.some((id, index) => id !== batch.commandIds[index])) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "abandonment batch commandId 必须按字典序排列" });
  }
  if (new Set(batch.commandIds).size !== batch.commandIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "abandonment batch 含重复 commandId" });
  }
  if (batch.deliveries.length !== batch.commandIds.length ||
      batch.deliveries.some((delivery, index) => delivery.commandId !== batch.commandIds[index])) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "abandonment batch delivery 摘要与 commandId 集合不一致" });
  }
});

const abandonmentStateSchema = z.object({
  version: z.literal(1),
  workspaceId: desktopId,
  batches: z.array(abandonmentBatchSchema).max(MAX_BATCH_COMMANDS),
}).strict().superRefine((state, ctx) => {
  const commandIds = state.batches.flatMap(batch => batch.commandIds);
  if (commandIds.length > MAX_BATCH_COMMANDS) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "abandonment 证据 commandId 总数超过容量" });
  }
  if (new Set(commandIds).size !== commandIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "abandonment 证据含重复 commandId" });
  }
  for (const batch of state.batches) {
    if (batch.selectionSha256 !== selectionDigest(state.workspaceId, batch.commandIds, batch.deliveries)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "abandonment selection 摘要与持久化 commandId/delivery 不一致" });
    }
  }
});

type AbandonmentState = z.infer<typeof abandonmentStateSchema>;
export type AbandonmentBatch = z.infer<typeof abandonmentBatchSchema>;
export type AbandonmentDeliverySummary = z.infer<typeof deliverySummarySchema>;

export interface AbandonmentWorkspace {
  id: string;
  root: string;
}

export type DesktopAbandonmentWorkspace = AbandonmentWorkspace;

export interface AbandonmentPreview {
  commandIds: string[];
  confirmationSha256: string;
  notice: typeof abandonmentNotice;
}

export interface AbandonmentResult {
  status: "abandoned" | "already_abandoned";
  commandIds: string[];
  confirmationSha256: string;
  notice: typeof abandonmentNotice;
}

export interface AbandonmentEntry {
  commandId: string;
  delivery: AbandonmentDeliverySummary;
  selectionSha256: string;
  confirmationSha256: string;
  abandonedAt: string;
  maintenanceThreadId: string;
  maintenanceTurnId: string;
}

export class AbandonmentError extends DesktopError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "AbandonmentError";
  }
}

type MaintenanceContext = {
  threadId: string;
  hostId: string;
  projectId: string;
  workspaceRoot: string;
  title?: string;
  cwd?: string;
  workspaceKind?: string;
  resumeState?: string;
  resultTurnId: string;
  resultTurnStatus: "inProgress";
  runtimeStatus: "active" | "inProgress";
  requestsCount?: number;
  ownerClientId?: string | null;
};

type Snapshot = {
  state: AbandonmentState;
  desktop: DesktopState | null;
  records: StoredExecutionRecord[];
  outputs: ExecutionOutputMeta[];
  reconciliations: LegacyReconciliationEvidence[];
  retirements: LegacyRetirementEvidence[];
};

function invalid(message: string): never {
  throw new AbandonmentError("DESKTOP_ABANDONMENT_INVALID", message);
}

function notEligible(message: string): never {
  throw new AbandonmentError("DESKTOP_ABANDONMENT_NOT_ELIGIBLE", message);
}

function conflict(message: string): never {
  throw new AbandonmentError("DESKTOP_ABANDONMENT_CONFLICT", message);
}

function corrupt(code: string, message: string): never {
  throw new AbandonmentError(code, message);
}

function parseWorkspace(value: AbandonmentWorkspace): AbandonmentWorkspace {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.root !== "string" || !value.root.trim()) {
    return invalid("workspace 参数无效；拒绝 abandonment。");
  }
  let id: string;
  try { id = desktopId.parse(value.id); }
  catch { return invalid("workspaceId 格式无效；拒绝 abandonment。"); }
  return { id, root: value.root };
}

function parseCommandIds(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BATCH_COMMANDS) {
    return invalid("必须明确选择 1 至 10000 个 commandId；拒绝 abandonment。");
  }
  const parsed = value.map(item => {
    try { return desktopId.parse(item); }
    catch { return invalid("commandId 格式无效；拒绝 abandonment。"); }
  });
  if (new Set(parsed).size !== parsed.length) return invalid("commandId 不得重复；拒绝 abandonment。");
  return parsed.sort();
}

function parseConfirmation(value: string): string {
  try { return sha256.parse(value); }
  catch {
    throw new AbandonmentError("DESKTOP_ABANDONMENT_CONFIRMATION_INVALID", "confirmation 摘要必须是 64 位十六进制值；拒绝 abandonment。");
  }
}

function evidenceDir(): string {
  return path.join(getStateDir(), "desktop-abandonment");
}

export function abandonmentFile(workspaceId: string): string {
  return path.join(evidenceDir(), `${desktopId.parse(workspaceId)}.json`);
}

function markerFile(workspaceId: string): string {
  return `${abandonmentFile(workspaceId)}.initialized`;
}

function hasTemporaryEvidence(workspaceId: string): boolean {
  const file = abandonmentFile(workspaceId);
  try {
    return fs.readdirSync(path.dirname(file)).some(name =>
      name.startsWith(`${path.basename(file)}.`) && name.endsWith(".tmp"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return corrupt("DESKTOP_ABANDONMENT_STORE_CORRUPT", "abandonment 目录无法读取；拒绝继续。");
  }
}

function readState(workspaceId: string): AbandonmentState {
  const file = abandonmentFile(workspaceId);
  if (hasTemporaryEvidence(workspaceId)) {
    return corrupt("DESKTOP_ABANDONMENT_STORE_CORRUPT", "abandonment 证据含未完成临时文件；拒绝继续。");
  }
  const exists = fs.existsSync(file);
  const marker = fs.existsSync(markerFile(workspaceId));
  if (!exists) {
    if (marker) return corrupt("DESKTOP_ABANDONMENT_STORE_CORRUPT", "abandonment 主文件缺失；拒绝重置证据。");
    return { version: 1, workspaceId, batches: [] };
  }
  if (!marker) return corrupt("DESKTOP_ABANDONMENT_STORE_CORRUPT", "abandonment 初始化标记缺失；拒绝读取证据。");
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return corrupt("DESKTOP_ABANDONMENT_STORE_CORRUPT", "abandonment 证据损坏；保留文件并人工核对。"); }
  const state = abandonmentStateSchema.safeParse(parsed);
  if (!state.success || state.data.workspaceId !== workspaceId) {
    return corrupt("DESKTOP_ABANDONMENT_STORE_CORRUPT", "abandonment 证据 schema 或 workspaceId 不一致；拒绝继续。");
  }
  return state.data;
}

function writeState(workspaceId: string, state: AbandonmentState): void {
  const file = abandonmentFile(workspaceId);
  const marker = markerFile(workspaceId);
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let prepared = false;
  try {
    const parsed = abandonmentStateSchema.parse(state);
    ensureDir(path.dirname(file));
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(parsed), "utf8");
    fs.fsyncSync(fd);
    prepared = true;
  } catch {
    throw new AbandonmentError("DESKTOP_ABANDONMENT_STORE_WRITE", "abandonment 证据无法写入；保留原文件并人工核对。");
  } finally {
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
  } catch {
    throw new AbandonmentError("DESKTOP_ABANDONMENT_STORE_WRITE", "abandonment 证据提交失败；保留原文件并人工核对。");
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function deliverySummary(delivery: DesktopDelivery): AbandonmentDeliverySummary {
  // Desktop schema 要求 accepted 投递不带 error；这里再次显式断言，避免
  // 摘要把被篡改的 accepted/error 组合静默归一化为合法证据。
  if (delivery.errorCode !== undefined || delivery.errorMessage !== undefined) {
    conflict("accepted Desktop delivery 带 error 字段；拒绝 abandonment。");
  }
  return {
    commandId: delivery.commandId,
    ...(delivery.deliveryId === undefined ? {} : { deliveryId: delivery.deliveryId }),
    clientId: delivery.clientId,
    bindingId: delivery.bindingId,
    intent: delivery.intent ?? null,
    messageSha256: delivery.messageSha256,
    messageBytes: delivery.messageBytes,
    threadId: delivery.threadId,
    turnId: delivery.turnId!,
    deliveryStatus: "accepted",
    errorCode: null,
    errorMessage: null,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function sha256Of(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function selectionDigest(workspaceId: string, commandIds: string[], deliveries: AbandonmentDeliverySummary[]): string {
  return sha256Of({ workspaceId, commandIds, deliveries });
}

function matchesRecord(record: StoredExecutionRecord, commandId: string): boolean {
  return record.commandId === commandId || record.taskId === commandId || record.taskId === `desktop_${commandId}`;
}

function matchesOutput(output: ExecutionOutputMeta, commandId: string): boolean {
  return output.taskId === commandId || output.taskId === `desktop_${commandId}`;
}

function taskOwner(snapshot: Snapshot, taskId: string): string | undefined {
  const owner = snapshot.desktop?.deliveries.find(delivery =>
    taskId === delivery.commandId || taskId === `desktop_${delivery.commandId}`);
  if (owner) return owner.commandId;
  // Desktop result taskId 的 canonical 形式仍能表明另一个 commandId，
  // 即使该 command 的 delivery 已不在当前历史里，也不能把冲突降级为普通 task。
  const prefix = "desktop_";
  const suffix = taskId.startsWith(prefix) ? taskId.slice(prefix.length) : "";
  return suffix && desktopId.safeParse(suffix).success ? suffix : undefined;
}

function readSnapshot(workspace: AbandonmentWorkspace): Snapshot {
  let desktop: DesktopState | null;
  try { desktop = readDesktop(workspace.id); }
  catch { return corrupt("DESKTOP_ABANDONMENT_DESKTOP_CORRUPT", "Desktop 状态损坏；保留文件并人工核对。"); }

  let records: StoredExecutionRecord[];
  try { records = readExecutionRecordsStrict(workspace.id); }
  catch { return corrupt("DESKTOP_ABANDONMENT_RECORDS_CORRUPT", "execution JSONL 损坏或不完整；拒绝 abandonment。"); }

  let outputs: ExecutionOutputMeta[];
  try { outputs = readExecutionOutputMetadataStrict(workspace.id); }
  catch { return corrupt("DESKTOP_ABANDONMENT_OUTPUT_CORRUPT", "execution output index 损坏或不完整；拒绝 abandonment。"); }

  let reconciliations: LegacyReconciliationEvidence[];
  try { reconciliations = readLegacyReconciliations(workspace.id); }
  catch { return corrupt("DESKTOP_ABANDONMENT_RECONCILIATION_CORRUPT", "reconciliation 证据无法安全读取；拒绝 abandonment。"); }

  let retirements: LegacyRetirementEvidence[];
  try { retirements = readLegacyRetirements(workspace.id); }
  catch { return corrupt("DESKTOP_ABANDONMENT_RETIREMENT_CORRUPT", "retirement 证据无法安全读取；拒绝 abandonment。"); }

  return { state: readState(workspace.id), desktop, records, outputs, reconciliations, retirements };
}

function evidenceIds(snapshot: Snapshot): { abandonment: Set<string>; reconciliation: Set<string>; retirement: Set<string> } {
  return {
    abandonment: new Set(snapshot.state.batches.flatMap(batch => batch.commandIds)),
    reconciliation: new Set(snapshot.reconciliations.map(entry => entry.commandId)),
    retirement: new Set(snapshot.retirements.map(entry => entry.commandId)),
  };
}

function assertEvidenceSeparation(snapshot: Snapshot): void {
  const ids = evidenceIds(snapshot);
  for (const id of ids.abandonment) {
    if (ids.reconciliation.has(id) || ids.retirement.has(id)) {
      return conflict("abandonment 与 reconciliation/retirement 存在双证据；拒绝继续。");
    }
  }
  for (const id of ids.reconciliation) {
    if (ids.retirement.has(id)) return conflict("reconciliation 与 retirement 存在双证据；拒绝继续。");
  }
}

function batchFor(snapshot: Snapshot, commandIds: string[]): AbandonmentBatch | undefined {
  const selected = new Set(commandIds);
  const containing = snapshot.state.batches.filter(batch => batch.commandIds.some(id => selected.has(id)));
  if (!containing.length) return undefined;
  if (containing.length !== 1 || !sameJson(containing[0]!.commandIds, commandIds)) {
    return conflict("selected commandId 与已有 abandonment batch 不同；拒绝拆分或合并证据。");
  }
  return containing[0];
}

function currentDeliveries(snapshot: Snapshot, workspace: AbandonmentWorkspace, commandIds: string[], prior?: AbandonmentBatch): AbandonmentDeliverySummary[] {
  const desktop = snapshot.desktop;
  if (!desktop || desktop.workspaceRoot !== workspace.root) {
    return notEligible("没有与当前 workspace 一致的 Desktop 状态；拒绝 abandonment。");
  }
  if (unresolvedOutcomeUnknownCommandIds(workspace, desktop).size > 0) {
    return notEligible("存在 outcome_unknown Desktop 投递；拒绝 abandonment。");
  }
  const binding = desktop.binding;
  if (!binding) return notEligible("当前 workspace 没有 Desktop binding；拒绝 abandonment。");

  const summaries: AbandonmentDeliverySummary[] = [];
  for (const commandId of commandIds) {
    const delivery = desktop.deliveries.find(item => item.commandId === commandId);
    if (!delivery || delivery.deliveryStatus !== "accepted" || !delivery.turnId || !uuid.safeParse(delivery.turnId).success) {
      return notEligible("selected commandId 不是带合法 turnId 的 accepted Desktop 投递；拒绝 abandonment。");
    }
    if (delivery.threadId === binding.threadId) {
      return conflict("当前 binding thread 不能作为历史 abandonment 对象；拒绝继续。");
    }
    const summary = deliverySummary(delivery);
    if (prior) {
      const expected = prior.deliveries.find(item => item.commandId === commandId);
      if (!expected || !sameJson(expected, summary)) {
        return conflict("已有 abandonment 证据与当前 delivery 摘要冲突；不覆盖旧证据。");
      }
    }
    summaries.push(summary);
  }
  return summaries;
}

function assertExecutionFacts(snapshot: Snapshot, commandIds: string[]): void {
  for (const commandId of commandIds) {
    const records = snapshot.records.filter(record => matchesRecord(record, commandId));
    if (records.length > 1) return conflict("selected commandId 存在重复 execution 记录；拒绝猜测或覆盖。");
    if (records.length === 1) {
      const record = records[0]!;
      if (isTrustedDesktopReceipt(record, commandId)) {
        return conflict("selected commandId 已有可信 Desktop receipt；拒绝 abandonment。");
      }
      const owner = taskOwner(snapshot, record.taskId);
      if (owner !== undefined && owner !== commandId) {
        return conflict("selected commandId 的 execution command/task 不一致；拒绝猜测或覆盖。");
      }
      if (owner === commandId && record.commandId !== undefined && record.commandId !== commandId) {
        return conflict("selected commandId 的 execution command/task 不一致；拒绝猜测或覆盖。");
      }
      // 同一 taskId 出现多条记录时无法判断哪条是 selected command 的事实，
      // 即使其中只有一条带 commandId，也必须整体 fail closed。
      if (snapshot.records.filter(item => item.taskId === record.taskId).length > 1) {
        return conflict("selected commandId 存在重复 execution task 记录；拒绝猜测或覆盖。");
      }
    }
    const outputs = snapshot.outputs.filter(output => matchesOutput(output, commandId));
    if (outputs.length > 1) return conflict("selected commandId 存在重复 execution output；拒绝猜测或覆盖。");
  }
}

function assertEligible(snapshot: Snapshot, workspace: AbandonmentWorkspace, commandIds: string[], prior?: AbandonmentBatch): AbandonmentDeliverySummary[] {
  assertEvidenceSeparation(snapshot);
  const ids = evidenceIds(snapshot);
  for (const commandId of commandIds) {
    if (ids.reconciliation.has(commandId) || ids.retirement.has(commandId)) {
      return conflict("selected commandId 已有 reconciliation 或 retirement 证据；拒绝 abandonment。");
    }
    if (ids.abandonment.has(commandId) && !prior) {
      return conflict("selected commandId 已有 abandonment 证据；拒绝重复处置。");
    }
  }
  const summaries = currentDeliveries(snapshot, workspace, commandIds, prior);
  assertExecutionFacts(snapshot, commandIds);
  return summaries;
}

function selectedRecords(snapshot: Snapshot, commandIds: string[]): StoredExecutionRecord[] {
  return snapshot.records.filter(record => commandIds.some(commandId => matchesRecord(record, commandId)));
}

function selectedOutputs(snapshot: Snapshot, commandIds: string[]): ExecutionOutputMeta[] {
  return snapshot.outputs.filter(output => commandIds.some(commandId => matchesOutput(output, commandId)));
}

function digestFor(snapshot: Snapshot, workspace: AbandonmentWorkspace, commandIds: string[], deliveries: AbandonmentDeliverySummary[]): string {
  return sha256Of({
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    binding: snapshot.desktop?.binding ?? null,
    commandIds,
    deliveries,
    execution: selectedRecords(snapshot, commandIds),
    outputs: selectedOutputs(snapshot, commandIds),
    existingEvidence: {
      reconciliation: snapshot.reconciliations,
      retirement: snapshot.retirements,
    },
  });
}

function ipcCode(error: unknown): string | undefined {
  if (error instanceof DesktopError) return error.code;
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return undefined;
}

function waitForCurrentContextRetry(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, CURRENT_CONTEXT_RETRY_DELAY_MS));
}

function normalizedMaintenanceContext(value: unknown, binding: DesktopBinding, workspaceRoot: string): MaintenanceContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return notEligible("当前 Desktop maintenance result context 无效；拒绝 abandonment。");
  }
  const context = value as Partial<DesktopResultContext>;
  if (context.threadId !== binding.threadId || context.hostId !== binding.hostId ||
      context.projectId !== binding.projectId || context.workspaceRoot !== workspaceRoot) {
    return notEligible("当前 Desktop result context 与 binding 身份不一致；拒绝 abandonment。");
  }
  if (typeof context.resultTurnId !== "string" || !uuid.safeParse(context.resultTurnId).success ||
      context.resultTurnStatus !== "inProgress" ||
      (context.runtimeStatus !== "active" && context.runtimeStatus !== "inProgress")) {
    return notEligible("当前 Desktop maintenance turn 不是 active/inProgress；拒绝 abandonment。");
  }
  return {
    threadId: context.threadId,
    hostId: context.hostId,
    projectId: context.projectId,
    workspaceRoot: context.workspaceRoot,
    title: context.title,
    cwd: context.cwd,
    workspaceKind: context.workspaceKind,
    resumeState: context.resumeState,
    resultTurnId: context.resultTurnId,
    resultTurnStatus: "inProgress",
    runtimeStatus: context.runtimeStatus,
    requestsCount: context.requestsCount,
    ownerClientId: context.ownerClientId,
  };
}

function sameMaintenanceContext(a: MaintenanceContext, b: MaintenanceContext): boolean {
  return a.threadId === b.threadId && a.hostId === b.hostId && a.projectId === b.projectId &&
    a.workspaceRoot === b.workspaceRoot && a.title === b.title && a.cwd === b.cwd &&
    a.workspaceKind === b.workspaceKind && a.resumeState === b.resumeState &&
    a.resultTurnId === b.resultTurnId && a.resultTurnStatus === b.resultTurnStatus &&
    a.runtimeStatus === b.runtimeStatus && a.requestsCount === b.requestsCount &&
    a.ownerClientId === b.ownerClientId;
}

async function currentMaintenanceContext(workspace: AbandonmentWorkspace, binding: DesktopBinding): Promise<MaintenanceContext> {
  let failure: unknown;
  let current: DesktopResultContext | undefined;
  for (let attempt = 1; attempt <= CURRENT_CONTEXT_ATTEMPTS; attempt += 1) {
    try {
      current = await desktopIpc.currentResultContext(workspace.root);
      break;
    } catch (error) {
      failure = error;
      if (ipcCode(error) !== "DESKTOP_STATE_UNAVAILABLE" || attempt === CURRENT_CONTEXT_ATTEMPTS) {
        throw new AbandonmentError("DESKTOP_ABANDONMENT_IPC", `当前 Desktop maintenance context 无法安全确认（${ipcCode(error) ?? "unknown"}）；拒绝 abandonment。`);
      }
      await waitForCurrentContextRetry();
    }
  }
  if (!current) {
    throw new AbandonmentError("DESKTOP_ABANDONMENT_IPC", `当前 Desktop maintenance context 无法安全确认（${ipcCode(failure) ?? "unknown"}）；拒绝 abandonment。`);
  }
  return normalizedMaintenanceContext(current, binding, workspace.root);
}

function flatEntries(state: AbandonmentState): AbandonmentEntry[] {
  return state.batches.flatMap(batch => batch.commandIds.map(commandId => ({
    commandId,
    delivery: batch.deliveries.find(item => item.commandId === commandId)!,
    selectionSha256: batch.selectionSha256,
    confirmationSha256: batch.confirmationSha256,
    abandonedAt: batch.abandonedAt,
    maintenanceThreadId: batch.maintenanceThreadId,
    maintenanceTurnId: batch.maintenanceTurnId,
  })));
}

/** 只读读取 abandonment 证据；缺少初始化文件时返回空数组，不创建目录或锁。 */
export function readAbandonments(workspaceId: string): AbandonmentEntry[] {
  let id: string;
  try { id = desktopId.parse(workspaceId); }
  catch { return invalid("workspaceId 格式无效；拒绝读取 abandonment。"); }
  return flatEntries(readState(id));
}

/** 供 reconciliation/retirement 互斥检查使用；只读取本模块 strict store。 */
export function readAbandonedCommandIds(workspaceId: string): Set<string> {
  let id: string;
  try { id = desktopId.parse(workspaceId); }
  catch { return invalid("workspaceId 格式无效；拒绝读取 abandonment。"); }
  return new Set(readState(id).batches.flatMap(batch => batch.commandIds));
}

function evidenceLockError(error: unknown): never {
  if (error instanceof AbandonmentError) throw error;
  if (ipcCode(error) === "LEGACY_RECONCILIATION_BUSY") {
    throw new AbandonmentError("DESKTOP_ABANDONMENT_BUSY", "abandonment/reconciliation 写锁繁忙；请稍后重试。");
  }
  if (error instanceof DesktopError && error.code.startsWith("LEGACY_RECONCILIATION_")) {
    throw new AbandonmentError("DESKTOP_ABANDONMENT_CONFLICT", "reconciliation/retirement 证据无法安全确认；拒绝 abandonment。");
  }
  throw new AbandonmentError("DESKTOP_ABANDONMENT_STORE_WRITE", "abandonment 提交失败；保留原文件并人工核对。");
}

/** 只读预览；commandIds 是唯一授权范围，不会动态扩展为 all。 */
export function previewAbandonment(workspaceRaw: AbandonmentWorkspace, commandIdsRaw: readonly string[]): AbandonmentPreview {
  const workspace = parseWorkspace(workspaceRaw);
  const commandIds = parseCommandIds(commandIdsRaw);
  const snapshot = readSnapshot(workspace);
  const prior = batchFor(snapshot, commandIds);
  if (prior) return conflict("selected commandId 已有 abandonment 证据；请使用原确认摘要重试或重新选择。");
  const deliveries = assertEligible(snapshot, workspace, commandIds);
  return { commandIds, confirmationSha256: digestFor(snapshot, workspace, commandIds, deliveries), notice: abandonmentNotice };
}

/**
 * 本机明确确认后的批量行政处置。只写独立 abandonment 证据，不修改 Desktop
 * delivery、execution records 或 output；currentResultContext 调用不跨持有本地证据锁。
 */
export async function abandonHistoricalAccepted(
  workspaceRaw: AbandonmentWorkspace,
  commandIdsRaw: readonly string[],
  confirmationSha256Raw: string,
): Promise<AbandonmentResult> {
  const workspace = parseWorkspace(workspaceRaw);
  const commandIds = parseCommandIds(commandIdsRaw);
  const confirmationSha256 = parseConfirmation(confirmationSha256Raw);
  const initial = readSnapshot(workspace);
  const initialPrior = batchFor(initial, commandIds);
  if (initialPrior && initialPrior.confirmationSha256 !== confirmationSha256) {
    return conflict("已有 abandonment batch 的 confirmation 摘要不一致；拒绝覆盖或拆分证据。");
  }
  const initialDeliveries = assertEligible(initial, workspace, commandIds, initialPrior);
  const initialDigest = digestFor(initial, workspace, commandIds, initialDeliveries);
  if (initialDigest !== confirmationSha256) {
    throw new AbandonmentError("DESKTOP_ABANDONMENT_CONFIRMATION_MISMATCH", "confirmation 摘要与 workspace、binding、selected delivery 或本地证据不一致；拒绝继续。");
  }
  const binding = initial.desktop?.binding;
  if (!binding) return notEligible("当前 workspace 没有 Desktop binding；拒绝 abandonment。");
  const maintenanceBefore = await currentMaintenanceContext(workspace, binding);

  const after = readSnapshot(workspace);
  const afterPrior = batchFor(after, commandIds);
  if (initialPrior && !sameJson(initialPrior, afterPrior)) {
    return conflict("abandonment batch 在 maintenance 校验期间发生变化；拒绝覆盖或追加。");
  }
  const afterDeliveries = assertEligible(after, workspace, commandIds, afterPrior);
  if (!initialPrior && !sameJson(initial.state.batches, after.state.batches)) {
    return conflict("abandonment batch 在 maintenance 校验期间发生变化；拒绝覆盖或追加。");
  }
  if (digestFor(after, workspace, commandIds, afterDeliveries) !== confirmationSha256) {
    return conflict("confirmation 前后 workspace、binding、selected delivery 或本地证据发生变化；拒绝写入。");
  }
  const afterBinding = after.desktop?.binding;
  if (!afterBinding) return notEligible("当前 workspace 没有 Desktop binding；拒绝 abandonment。");
  const maintenanceAfter = await currentMaintenanceContext(workspace, afterBinding);
  if (!sameMaintenanceContext(maintenanceBefore, maintenanceAfter)) {
    return conflict("当前 Desktop maintenance thread/turn 或 owner/version/cwd 在校验期间发生变化；拒绝写入。");
  }

  try {
    return withEvidenceLock(workspace.id, () => {
      const locked = readSnapshot(workspace);
      const lockedPrior = batchFor(locked, commandIds);
      if (initialPrior && !sameJson(initialPrior, lockedPrior)) {
        return conflict("abandonment batch 在提交前发生变化；拒绝覆盖或追加。");
      }
      if (!initialPrior && lockedPrior) {
        return conflict("selected commandId 在提交前已进入其他 abandonment batch；拒绝猜测或覆盖。");
      }
      if (!initialPrior && !sameJson(initial.state.batches, locked.state.batches)) {
        return conflict("abandonment batch 在提交前发生变化；拒绝覆盖或追加。");
      }
      const lockedDeliveries = assertEligible(locked, workspace, commandIds, lockedPrior);
      if (digestFor(locked, workspace, commandIds, lockedDeliveries) !== confirmationSha256) {
        return conflict("提交前 workspace、binding、selected delivery 或本地证据发生变化；拒绝写入。");
      }
      if (lockedPrior) {
        return {
          status: "already_abandoned" as const,
          commandIds,
          confirmationSha256,
          notice: abandonmentNotice,
        };
      }
      const batch: AbandonmentBatch = {
        commandIds,
        deliveries: lockedDeliveries,
        selectionSha256: selectionDigest(workspace.id, commandIds, lockedDeliveries),
        confirmationSha256,
        abandonedAt: new Date().toISOString(),
        maintenanceThreadId: maintenanceAfter.threadId,
        maintenanceTurnId: maintenanceAfter.resultTurnId,
      };
      writeState(workspace.id, { ...locked.state, batches: [...locked.state.batches, batch] });
      return {
        status: "abandoned" as const,
        commandIds,
        confirmationSha256,
        notice: abandonmentNotice,
      };
    });
  } catch (error) {
    return evidenceLockError(error);
  }
}

/** 严格只读判断；只返回持久化且仍与对应 delivery 一致的 commandId。 */
export function getAbandonedCommandIds(workspaceRaw: AbandonmentWorkspace): Set<string> {
  const workspace = parseWorkspace(workspaceRaw);
  const state = readState(workspace.id);
  const persisted = new Set(state.batches.flatMap(batch => batch.commandIds));
  if (!persisted.size) return persisted;

  const snapshot = readSnapshot(workspace);
  assertEvidenceSeparation(snapshot);
  if (!snapshot.desktop || snapshot.desktop.workspaceRoot !== workspace.root) {
    return conflict("abandonment 证据与当前 workspace 不一致；拒绝忽略冲突。");
  }
  if (unresolvedOutcomeUnknownCommandIds(workspace, snapshot.desktop).size > 0) {
    return conflict("存在 outcome_unknown Desktop 投递；拒绝使用 abandonment 证据。");
  }
  const binding = snapshot.desktop.binding;
  if (!binding) return conflict("当前 workspace 没有 Desktop binding；拒绝使用 abandonment 证据。");

  for (const batch of state.batches) {
    for (const expected of batch.deliveries) {
      const delivery = snapshot.desktop.deliveries.find(item => item.commandId === expected.commandId);
      if (!delivery || delivery.deliveryStatus !== "accepted" || !delivery.turnId ||
          !uuid.safeParse(delivery.turnId).success || delivery.threadId === binding.threadId ||
          !sameJson(deliverySummary(delivery), expected)) {
        return conflict("已有 abandonment 证据与当前对应 delivery 冲突；拒绝忽略。");
      }
      assertExecutionFacts(snapshot, [expected.commandId]);
    }
  }
  return persisted;
}
