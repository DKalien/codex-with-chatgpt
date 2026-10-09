import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";
import {
  isTrustedDesktopReceipt,
  readExecutionRecordsStrict,
  withExecutionRecordsLock,
  type StoredExecutionRecord,
} from "../execution/records.js";
import { readExecutionOutputIndexStrict, MAX_OUTPUT_RECORDS, type OutputIndex, type ExecutionOutputMeta } from "../execution/output.js";
import { DesktopError, desktopId, readDesktop, type DesktopDelivery } from "./store.js";
import { getRetiredLegacyCommandIds, readLegacyRetirements } from "./legacy-retirement.js";
import { getAbandonedCommandIds, readAbandonedCommandIds } from "./abandonment.js";
import { LegacyReconciliationError, withEvidenceLock } from "./recovery-evidence.js";
import { withCommandOperation } from "../command-cleanup/fence.js";
import {
  readEvidenceState as readSharedEvidenceState,
  writeEvidenceState as writeSharedEvidenceState,
  type EvidenceReadMessages,
} from "../core/evidence-store.js";
export { LegacyReconciliationError, withEvidenceLock } from "./recovery-evidence.js";

const terminalStatuses = new Set(["ok", "failed", "blocked"]);
const uuid = z.string().uuid();
const canonicalTimestamp = z.string().refine(value => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}, "必须为 canonical ISO datetime");

const outputSnapshotSchema = z.object({
  id: z.number().int().positive().safe(), command: z.string(), exitCode: z.number().finite().nullable(),
  timestamp: canonicalTimestamp, taskId: z.string().min(1).max(256),
  iteration: z.number().int().nonnegative().safe(), allowed: z.boolean(), restrictedReason: z.string().optional(),
  truncated: z.boolean(), sizeBytes: z.number().int().nonnegative().safe(),
}).strict();

const evidenceEntrySchema = z.object({
  commandId: desktopId,
  deliveryId: uuid.optional(),
  taskId: z.string().min(1).max(256),
  iteration: z.number().int().nonnegative().safe(),
  outputId: z.number().int().positive().safe(),
  acceptedAt: z.string().datetime(),
  executionTimestamp: canonicalTimestamp,
  outputTimestamp: canonicalTimestamp,
  // 旧证据没有 snapshot 时仍要求原 output 存在，不推断或回填。
  outputSnapshot: outputSnapshotSchema.optional(),
  proofSha256: z.string().regex(/^[a-f0-9]{64}$/),
  reconciledAt: canonicalTimestamp,
}).strict();

const evidenceStateSchema = z.object({
  version: z.literal(1),
  workspaceId: desktopId,
  entries: z.array(evidenceEntrySchema).max(10000),
}).strict().superRefine((state, ctx) => {
  const commandIds = new Set(state.entries.map(entry => entry.commandId));
  if (commandIds.size !== state.entries.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "遗留 reconciliation 证据含重复 commandId" });
  }
});

export type LegacyReconciliationEvidence = z.infer<typeof evidenceEntrySchema>;

export interface LegacyReconciliationWorkspace {
  id: string;
  root: string;
}

export interface LegacyReconciliationResult {
  status: "reconciled" | "already_reconciled";
  commandId: string;
  proofSha256: string;
}

type ReconciliationFacts = {
  delivery: DesktopDelivery;
  record: StoredExecutionRecord;
  output: ExecutionOutputMeta;
  proofSha256: string;
};

type DesktopFactsSources = {
  workspace: LegacyReconciliationWorkspace;
  desktop: ReturnType<typeof readDesktop>;
  records: StoredExecutionRecord[];
  outputIndex: OutputIndex;
};

function evidenceDir(stateDir = getStateDir()): string {
  return path.join(path.resolve(stateDir), "desktop-legacy-reconciliation");
}

export function legacyReconciliationFile(workspaceId: string, stateDir = getStateDir()): string {
  return path.join(evidenceDir(stateDir), `${desktopId.parse(workspaceId)}.json`);
}

function markerFile(workspaceId: string, stateDir = getStateDir()): string {
  return `${legacyReconciliationFile(workspaceId, stateDir)}.initialized`;
}


function corruptStore(message = "遗留 reconciliation 证据损坏或未完成；保留原文件并人工核对。"): never {
  throw new LegacyReconciliationError("LEGACY_RECONCILIATION_STORE_CORRUPT", message);
}

const storeMessages: EvidenceReadMessages = {
  directoryUnreadable: "遗留 reconciliation 目录无法读取；拒绝继续。",
  temporaryFiles: "遗留 reconciliation 证据损坏或未完成；保留原文件并人工核对。",
  missingMainFile: "遗留 reconciliation 主文件缺失；拒绝重置证据。",
  missingMarker: "遗留 reconciliation 初始化标记缺失；拒绝读取证据。",
  bodyCorrupt: "遗留 reconciliation 证据损坏或未完成；保留原文件并人工核对。",
  schemaMismatch: "遗留 reconciliation 证据损坏或未完成；保留原文件并人工核对。",
};

type ReconciliationState = { version: 1; workspaceId: string; entries: LegacyReconciliationEvidence[] };

function readEvidenceState(workspaceId: string, stateDir = getStateDir()): ReconciliationState {
  return readSharedEvidenceState<ReconciliationState>({
    file: legacyReconciliationFile(workspaceId, stateDir),
    marker: markerFile(workspaceId, stateDir),
    workspaceId,
    schema: evidenceStateSchema,
    emptyState: () => ({ version: 1, workspaceId, entries: [] }),
    corrupt: message => corruptStore(message),
    messages: storeMessages,
  });
}

function writeEvidenceState(workspaceId: string, state: ReconciliationState, stateDir = getStateDir()): void {
  // 历史行为：不做 ensureDir、openSync/parse 失败原样外溢、prepare 失败保留 tmp 残片。
  writeSharedEvidenceState<ReconciliationState>({
    file: legacyReconciliationFile(workspaceId, stateDir),
    marker: markerFile(workspaceId, stateDir),
    schema: evidenceStateSchema,
    wrapParseErrors: false,
    openTmpInsideTry: false,
    cleanupTmpOnPrepareFailure: false,
  }, state);
}

function canonical(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validTaskId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001F\u007F]/u.test(value);
}

function parseAcceptedAt(delivery: DesktopDelivery): number {
  const acceptedAt = Date.parse(delivery.updatedAt);
  if (!Number.isFinite(acceptedAt)) {
    throw new LegacyReconciliationError("LEGACY_RECONCILIATION_NOT_ELIGIBLE", "accepted Desktop 投递时间无法确认；拒绝遗留 reconciliation。");
  }
  return acceptedAt;
}

function factsFromSources(sources: DesktopFactsSources, commandId: string, evidence?: LegacyReconciliationEvidence): ReconciliationFacts {
  const { workspace, desktop, records, outputIndex } = sources;
  const outputs = outputIndex.items;
  const requestedId = desktopId.safeParse(commandId);
  if (!requestedId.success) throw new LegacyReconciliationError("LEGACY_RECONCILIATION_INVALID", "commandId 格式无效；拒绝遗留 reconciliation。");

  if (!desktop || desktop.workspaceRoot !== workspace.root) {
    throw new LegacyReconciliationError("LEGACY_RECONCILIATION_NOT_ELIGIBLE", "没有与当前 workspace 一致的 Desktop 状态；拒绝遗留 reconciliation。");
  }
  const delivery = desktop.deliveries.find(item => item.commandId === commandId);
  if (!delivery || delivery.deliveryStatus !== "accepted" || !delivery.turnId || !uuid.safeParse(delivery.turnId).success) {
    throw new LegacyReconciliationError("LEGACY_RECONCILIATION_NOT_ELIGIBLE", "没有带合法 turnId 的 accepted Desktop 投递；拒绝遗留 reconciliation。");
  }
  if (delivery.intent !== undefined) {
    throw new LegacyReconciliationError("LEGACY_RECONCILIATION_NOT_ELIGIBLE", "当前 Desktop delivery 已有 intent；不能走 legacy reconciliation。");
  }
  const acceptedAt = parseAcceptedAt(delivery);
  const byCommand = records.filter(record => record.commandId === commandId);
  if (byCommand.length !== 1) {
    throw new LegacyReconciliationError("LEGACY_RECONCILIATION_CONFLICT", "commandId/taskId execution 记录缺失、重复或冲突；拒绝遗留 reconciliation。",
      byCommand.length === 0 && !records.some(item => item.taskId === `desktop_${commandId}`) ? "missing_execution" : "conflict");
  }
  const record = byCommand[0];
  const byTask = records.filter(item => item.taskId === record.taskId);
  const desktopTaskId = `desktop_${commandId}`;
  const byDesktopTask = records.filter(item => item.taskId === desktopTaskId);
  if (byTask.length !== 1 || byTask[0] !== record ||
      (record.taskId !== desktopTaskId && byDesktopTask.length > 0)) {
    throw new LegacyReconciliationError("LEGACY_RECONCILIATION_CONFLICT", "commandId/taskId execution 记录缺失、重复或冲突；拒绝遗留 reconciliation。");
  }
  if (record.commandId !== commandId || !validTaskId(record.taskId) ||
      !Number.isSafeInteger(record.iteration) || record.iteration < 0 ||
      record.desktopReceiptSha256 !== undefined || !canonical(record.timestamp) || !terminalStatuses.has(record.exitStatus) ||
      (record.outputId !== undefined && (!Number.isSafeInteger(record.outputId) || record.outputId <= 0)) ||
      Date.parse(record.timestamp) <= acceptedAt) {
    throw new LegacyReconciliationError("LEGACY_RECONCILIATION_NOT_ELIGIBLE", "execution 记录不是晚于 accepted 投递的完整终态证据；拒绝遗留 reconciliation。");
  }
  if (record.outputId === undefined) {
    throw new LegacyReconciliationError("LEGACY_RECONCILIATION_NOT_ELIGIBLE", "execution 缺少 outputId；拒绝遗留 reconciliation。", "missing_output");
  }
  let output = outputs.find(item => item.id === record.outputId);
  if (evidence?.outputSnapshot) {
    const snapshot = evidence.outputSnapshot;
    const parsed = output ? outputSnapshotSchema.safeParse(output) : null;
    if (snapshot.id !== evidence.outputId || snapshot.id !== record.outputId ||
        (parsed && (!parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(snapshot)))) {
      throw new LegacyReconciliationError("LEGACY_RECONCILIATION_CONFLICT", "output metadata 与独立证据不一致；拒绝复用。");
    }
    // Allocation distance alone is insufficient: transient outputs may be cleaned
    // before capacity is reached, and orphan body IDs may be skipped. New indexes
    // retain the actual eviction watermark. For legacy indexes, nextId - 1 is the
    // last COMMITTED allocation (even after orphan skipping); all still-retained
    // earlier items coexisted with it. Capacity newer outputs at that commit proves
    // this unowned snapshot had to be evicted. Cleanup never increments nextId.
    const lastAllocated = outputIndex.nextId - 1;
    const newerAtLastCommit = outputs.filter(item => item.id > snapshot.id && item.id < lastAllocated).length + 1;
    const retentionProven = (outputIndex.retentionThrough ?? 0) >= snapshot.id ||
      (lastAllocated > snapshot.id && newerAtLastCommit >= MAX_OUTPUT_RECORDS);
    if (!output && outputIndex.nextId - snapshot.id - 1 >= MAX_OUTPUT_RECORDS &&
      outputs.every(item => item.id > snapshot.id) && retentionProven) {
      output = snapshot;
    }
  }
  if (evidence && !output) {
    throw new LegacyReconciliationError("LEGACY_RECONCILIATION_CONFLICT", "output 缺失且不能证明正常 retention 淘汰；拒绝复用。");
  }
  if (!output) throw new LegacyReconciliationError("LEGACY_RECONCILIATION_NOT_ELIGIBLE", "execution output 缺失；拒绝遗留 reconciliation。", "missing_output");
  if (!output || !validTaskId(output.taskId) || output.taskId !== record.taskId ||
      !Number.isSafeInteger(output.iteration) || output.iteration !== record.iteration || !canonical(output.timestamp) ||
      Date.parse(output.timestamp) <= acceptedAt) {
    throw new LegacyReconciliationError("LEGACY_RECONCILIATION_NOT_ELIGIBLE", "execution output 缺失或与记录不匹配；拒绝遗留 reconciliation。");
  }
  const proofSha256 = legacyReconciliationProof(delivery, record, output);
  return { delivery, record, output, proofSha256 };
}

function readFactsSources(workspace: LegacyReconciliationWorkspace): DesktopFactsSources {
  const desktop = readDesktop(workspace.id);
  let records: StoredExecutionRecord[];
  try { records = readExecutionRecordsStrict(workspace.id); }
  catch { throw new LegacyReconciliationError("LEGACY_RECONCILIATION_RECORDS_CORRUPT", "execution JSONL 损坏或不完整；拒绝遗留 reconciliation。"); }
  let outputIndex: OutputIndex;
  try { outputIndex = readExecutionOutputIndexStrict(workspace.id); }
  catch { throw new LegacyReconciliationError("LEGACY_RECONCILIATION_OUTPUT_CORRUPT", "execution output index 损坏；拒绝遗留 reconciliation。"); }
  return { workspace, desktop, records, outputIndex };
}

function factsFor(workspace: LegacyReconciliationWorkspace, commandId: string, evidence?: LegacyReconciliationEvidence): ReconciliationFacts {
  return factsFromSources(readFactsSources(workspace), commandId, evidence);
}

/** 对当前事实生成独立 reconciliation 摘要；不返回正文或 output command。 */
export function legacyReconciliationProof(
  delivery: DesktopDelivery,
  record: StoredExecutionRecord,
  output: ExecutionOutputMeta,
): string {
  const source = {
    delivery: {
      commandId: delivery.commandId,
      ...(delivery.deliveryId === undefined ? {} : { deliveryId: delivery.deliveryId }),
      clientId: delivery.clientId,
      bindingId: delivery.bindingId,
      messageSha256: delivery.messageSha256,
      messageBytes: delivery.messageBytes,
      threadId: delivery.threadId,
      turnId: delivery.turnId,
      deliveryStatus: delivery.deliveryStatus,
      createdAt: delivery.createdAt,
      updatedAt: delivery.updatedAt,
    },
    record,
    output,
  };
  return createHash("sha256").update(JSON.stringify(source), "utf8").digest("hex");
}

export function readLegacyReconciliations(workspaceId: string, stateDir = getStateDir()): LegacyReconciliationEvidence[] {
  desktopId.parse(workspaceId);
  return readEvidenceState(workspaceId, stateDir).entries;
}

/** Must run under the shared evidence lock; removes only this command's strict evidence. */
export function removeLegacyReconciliationForCommand(workspaceId: string, commandId: string, stateDir = getStateDir()): void {
  const state = readEvidenceState(desktopId.parse(workspaceId), stateDir);
  const entries = state.entries.filter(entry => entry.commandId !== desktopId.parse(commandId));
  if (entries.length !== state.entries.length) writeEvidenceState(workspaceId, { ...state, entries }, stateDir);
}

function verifyEvidence(sources: DesktopFactsSources, entry: LegacyReconciliationEvidence): void {
  const facts = factsFromSources(sources, entry.commandId, entry);
  if (entry.deliveryId !== facts.delivery.deliveryId || entry.taskId !== facts.record.taskId || entry.iteration !== facts.record.iteration ||
      entry.outputId !== facts.record.outputId || entry.acceptedAt !== facts.delivery.updatedAt ||
      entry.executionTimestamp !== facts.record.timestamp || entry.outputTimestamp !== facts.output.timestamp ||
      entry.proofSha256 !== facts.proofSha256) {
    throw new LegacyReconciliationError("LEGACY_RECONCILIATION_CONFLICT", "已有 reconciliation 证据与当前事实冲突；不覆盖或忽略旧证据。");
  }
}

export type LegacyDiscoveryStatus = "reconciled" | "eligible" | "missing_execution" | "missing_output" | "conflict" | "retired" | "abandoned";

/** 只读发现：整体存储损坏抛错；条目事实冲突仅返回固定状态，不返回内部正文。 */
export function listLegacyReconciliations(workspace: LegacyReconciliationWorkspace): Array<{ commandId: string; status: LegacyDiscoveryStatus }> {
  desktopId.parse(workspace.id);
  const abandoned = getAbandonedCommandIds(workspace);
  const evidence = readEvidenceState(workspace.id).entries;
  const retirements = readLegacyRetirements(workspace.id);
  if (retirements.some(item => evidence.some(entry => entry.commandId === item.commandId))) {
    throw new LegacyReconciliationError("LEGACY_RECONCILIATION_CONFLICT", "reconciliation 与 retirement 双证据冲突。");
  }
  let retired = new Set<string>();
  try { if (retirements.length) retired = getRetiredLegacyCommandIds(workspace); }
  catch (error) {
    if (!(error instanceof DesktopError) || !["LEGACY_RETIREMENT_CONFLICT", "LEGACY_RETIREMENT_NOT_ELIGIBLE"].includes(error.code)) throw error;
  }
  const sources = readFactsSources(workspace);
  if (sources.desktop && sources.desktop.workspaceRoot !== workspace.root) {
    throw new LegacyReconciliationError("LEGACY_RECONCILIATION_CONFLICT", "Desktop workspace 不一致；拒绝发现。");
  }
  return (sources.desktop?.deliveries ?? [])
    .filter(delivery => delivery.deliveryStatus === "accepted" && delivery.intent === undefined)
    .filter(delivery => {
      const records = sources.records.filter(record => record.commandId === delivery.commandId || record.taskId === `desktop_${delivery.commandId}`);
      return !(records.length === 1 && isTrustedDesktopReceipt(records[0], delivery.commandId) &&
        !evidence.some(entry => entry.commandId === delivery.commandId) && !retirements.some(entry => entry.commandId === delivery.commandId));
    })
    .map(({ commandId }) => {
      if (abandoned.has(commandId)) return { commandId, status: "abandoned" };
      if (retirements.some(entry => entry.commandId === commandId)) {
        return { commandId, status: retired.has(commandId) ? "retired" : "conflict" };
      }
      const prior = evidence.find(entry => entry.commandId === commandId);
      try {
        if (prior) verifyEvidence(sources, prior);
        else factsFromSources(sources, commandId);
        return { commandId, status: prior ? "reconciled" : "eligible" };
      } catch (error) {
        if (!(error instanceof LegacyReconciliationError)) throw error;
        return { commandId, status: prior ? "conflict" : error.discoveryStatus };
      }
    });
}

/** rollout 使用的严格重验入口；事实或独立证据任一变化都会 fail-closed。 */
export function getReconciledLegacyCommandIds(
  workspaceRaw: LegacyReconciliationWorkspace,
): Set<string> {
  const workspace = { id: desktopId.parse(workspaceRaw.id), root: workspaceRaw.root };
  const evidence = readEvidenceState(workspace.id).entries;
  const retirements = readLegacyRetirements(workspace.id);
  const abandoned = readAbandonedCommandIds(workspace.id);
  if (evidence.some(entry => abandoned.has(entry.commandId))) {
    throw new LegacyReconciliationError("LEGACY_RECONCILIATION_CONFLICT", "reconciliation 与 abandonment 双证据冲突。");
  }
  if (retirements.some(item => evidence.some(entry => entry.commandId === item.commandId))) {
    throw new LegacyReconciliationError("LEGACY_RECONCILIATION_CONFLICT", "reconciliation 与 retirement 双证据冲突。");
  }
  if (!evidence.length) return new Set();
  const sources = readFactsSources(workspace);
  const reconciled = new Set<string>();
  for (const entry of evidence) {
    try { verifyEvidence(sources, entry); }
    catch (error) {
      if (error instanceof LegacyReconciliationError && error.code === "LEGACY_RECONCILIATION_NOT_ELIGIBLE") {
        throw new LegacyReconciliationError("LEGACY_RECONCILIATION_CONFLICT", "已有 reconciliation 证据与当前 Desktop 或执行事实不一致；不忽略冲突。");
      }
      throw error;
    }
    reconciled.add(entry.commandId);
  }
  return reconciled;
}

/** 显式一次性入口；不会修改 Desktop delivery、execution JSONL 或触发 rollout。 */
export function reconcileLegacyAccepted(
  workspaceRaw: LegacyReconciliationWorkspace,
  commandId: string,
): LegacyReconciliationResult {
  const workspace = { id: desktopId.parse(workspaceRaw.id), root: workspaceRaw.root };
  const selected = desktopId.parse(commandId);
  return withCommandOperation(workspace.id, selected, () => reconcileLegacyAcceptedLocked(workspace, selected));
}

function reconcileLegacyAcceptedLocked(workspace: LegacyReconciliationWorkspace, commandId: string): LegacyReconciliationResult {
  const rejectRetired = (): void => {
    if (readLegacyRetirements(workspace.id).some(entry => entry.commandId === commandId) || readAbandonedCommandIds(workspace.id).has(commandId)) {
      throw new LegacyReconciliationError("LEGACY_RECONCILIATION_CONFLICT", "已 retirement/abandonment 的 commandId 不得 reconciliation。");
    }
  };
  rejectRetired();
  const initialEvidence = readEvidenceState(workspace.id).entries.find(entry => entry.commandId === commandId);
  const initial = withExecutionRecordsLock(workspace.id, () => factsFor(workspace, commandId, initialEvidence));
  return withEvidenceLock(workspace.id, () => {
    rejectRetired();
    const state = readEvidenceState(workspace.id);
    const prior = state.entries.find(entry => entry.commandId === commandId);
    const current = withExecutionRecordsLock(workspace.id, () => factsFor(workspace, commandId, prior));
    if (current.proofSha256 !== initial.proofSha256) {
      throw new LegacyReconciliationError("LEGACY_RECONCILIATION_CONFLICT", "reconciliation 输入事实在校验期间发生变化；拒绝写入证据。");
    }
    if (prior) {
      if (prior.deliveryId !== current.delivery.deliveryId || prior.taskId !== current.record.taskId || prior.iteration !== current.record.iteration ||
          prior.outputId !== current.record.outputId || prior.acceptedAt !== current.delivery.updatedAt ||
          prior.executionTimestamp !== current.record.timestamp || prior.outputTimestamp !== current.output.timestamp ||
          prior.proofSha256 !== current.proofSha256) {
        throw new LegacyReconciliationError("LEGACY_RECONCILIATION_CONFLICT", "已有 reconciliation 证据与当前事实冲突；不覆盖旧证据。");
      }
      return { status: "already_reconciled", commandId, proofSha256: prior.proofSha256 };
    }
    const evidence: LegacyReconciliationEvidence = {
      commandId,
      ...(current.delivery.deliveryId === undefined ? {} : { deliveryId: current.delivery.deliveryId }),
      taskId: current.record.taskId,
      iteration: current.record.iteration,
      outputId: current.record.outputId!,
      acceptedAt: current.delivery.updatedAt,
      executionTimestamp: current.record.timestamp,
      outputTimestamp: current.output.timestamp,
      outputSnapshot: outputSnapshotSchema.parse(current.output),
      proofSha256: current.proofSha256,
      reconciledAt: new Date().toISOString(),
    };
    writeEvidenceState(workspace.id, { ...state, entries: [...state.entries, evidence] });
    return { status: "reconciled", commandId, proofSha256: current.proofSha256 };
  });
}
