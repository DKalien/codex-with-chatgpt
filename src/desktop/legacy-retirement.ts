import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";
import {
  readExecutionRecordsStrict,
  withExecutionRecordsLock,
  type StoredExecutionRecord,
} from "../execution/records.js";
import { readExecutionOutputMetadataStrict, type ExecutionOutputMeta } from "../execution/output.js";
import { desktopIpc, type DesktopResultContext, type DesktopTarget } from "./ipc.js";
import {
  DesktopError,
  desktopId,
  readDesktop,
  type DesktopDelivery,
  type DesktopState,
} from "./store.js";
import { readLegacyReconciliations, withEvidenceLock } from "./legacy-reconciliation.js";
import { readAbandonedCommandIds } from "./abandonment.js";
import { unresolvedOutcomeUnknownCommandIds } from "./outcome-resolution.js";

const uuid = z.string().uuid();
const canonicalTimestamp = z.string().refine(value => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}, "必须为 canonical ISO datetime");
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

const strictRetirementEntrySchema = z.object({
  commandId: desktopId,
  deliverySha256: sha256,
  observedMissingAt: canonicalTimestamp,
}).strict();

const ownerlessRetirementEntrySchema = z.object({
  kind: z.literal("ownerless"),
  commandId: desktopId,
  deliverySha256: sha256,
  observedOwnerlessAt: canonicalTimestamp,
  maintenanceThreadId: uuid,
  maintenanceTurnId: uuid,
}).strict();

const retirementEntrySchema = z.union([strictRetirementEntrySchema, ownerlessRetirementEntrySchema]);

const retirementStateSchema = z.object({
  version: z.literal(1),
  workspaceId: desktopId,
  entries: z.array(retirementEntrySchema).max(10000),
}).strict().superRefine((state, ctx) => {
  const commandIds = new Set(state.entries.map(entry => entry.commandId));
  if (commandIds.size !== state.entries.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "遗留 retirement 证据含重复 commandId" });
  }
});

export type LegacyRetirementEvidence = z.infer<typeof retirementEntrySchema>;
type OwnerlessRetirementEvidence = z.infer<typeof ownerlessRetirementEntrySchema>;

export interface LegacyRetirementWorkspace {
  id: string;
  root: string;
}

export interface LegacyRetirementResult {
  status: "retired" | "already_retired";
  commandId: string;
}

export class LegacyRetirementError extends DesktopError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "LegacyRetirementError";
  }
}

type RetirementSnapshot = {
  desktop: DesktopState | null;
  records: StoredExecutionRecord[];
  outputs: ExecutionOutputMeta[];
};

type RetirementFacts = {
  delivery: DesktopDelivery;
  deliverySha256: string;
};

type OwnerlessContext = {
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

const CURRENT_CONTEXT_ATTEMPTS = 3;
const CURRENT_CONTEXT_RETRY_DELAY_MS = 25;

function invalid(message: string): never {
  throw new LegacyRetirementError("LEGACY_RETIREMENT_INVALID", message);
}

function notEligible(message: string): never {
  throw new LegacyRetirementError("LEGACY_RETIREMENT_NOT_ELIGIBLE", message);
}

function conflict(message: string): never {
  throw new LegacyRetirementError("LEGACY_RETIREMENT_CONFLICT", message);
}

function corrupt(code: "LEGACY_RETIREMENT_STORE_CORRUPT" | "LEGACY_RETIREMENT_DESKTOP_CORRUPT" |
  "LEGACY_RETIREMENT_RECORDS_CORRUPT" | "LEGACY_RETIREMENT_OUTPUT_CORRUPT", message: string): never {
  throw new LegacyRetirementError(code, message);
}

function parseWorkspace(value: LegacyRetirementWorkspace): LegacyRetirementWorkspace {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    typeof value.root !== "string" || !value.root.trim()) {
    return invalid("workspace 参数无效；拒绝 legacy retirement。");
  }
  let id: string;
  try { id = desktopId.parse(value.id); }
  catch { return invalid("workspaceId 格式无效；拒绝 legacy retirement。"); }
  return { id, root: value.root };
}

function parseCommandId(value: string): string {
  try { return desktopId.parse(value); }
  catch { return invalid("commandId 格式无效；拒绝 legacy retirement。"); }
}

function evidenceDir(): string {
  return path.join(getStateDir(), "desktop-legacy-retirement");
}

export function legacyRetirementFile(workspaceId: string): string {
  return path.join(evidenceDir(), `${desktopId.parse(workspaceId)}.json`);
}

function markerFile(workspaceId: string): string {
  return `${legacyRetirementFile(workspaceId)}.initialized`;
}

function hasTemporaryEvidence(workspaceId: string): boolean {
  const file = legacyRetirementFile(workspaceId);
  try {
    return fs.readdirSync(path.dirname(file)).some(name =>
      name.startsWith(`${path.basename(file)}.`) && name.endsWith(".tmp"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return corrupt("LEGACY_RETIREMENT_STORE_CORRUPT", "遗留 retirement 目录无法读取；拒绝继续。");
  }
}

function readState(workspaceId: string): { version: 1; workspaceId: string; entries: LegacyRetirementEvidence[] } {
  const file = legacyRetirementFile(workspaceId);
  if (hasTemporaryEvidence(workspaceId)) {
    return corrupt("LEGACY_RETIREMENT_STORE_CORRUPT", "遗留 retirement 证据含未完成临时文件；拒绝继续。");
  }
  const exists = fs.existsSync(file);
  const marker = fs.existsSync(markerFile(workspaceId));
  if (!exists) {
    if (marker) return corrupt("LEGACY_RETIREMENT_STORE_CORRUPT", "遗留 retirement 主文件缺失；拒绝重置证据。");
    return { version: 1, workspaceId, entries: [] };
  }
  if (!marker) return corrupt("LEGACY_RETIREMENT_STORE_CORRUPT", "遗留 retirement 初始化标记缺失；拒绝读取证据。");
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return corrupt("LEGACY_RETIREMENT_STORE_CORRUPT", "遗留 retirement 证据损坏；保留文件并人工核对。"); }
  const state = retirementStateSchema.safeParse(parsed);
  if (!state.success || state.data.workspaceId !== workspaceId) {
    return corrupt("LEGACY_RETIREMENT_STORE_CORRUPT", "遗留 retirement 证据 schema 或 workspaceId 不一致；拒绝继续。");
  }
  return state.data;
}

function writeState(
  workspaceId: string,
  state: { version: 1; workspaceId: string; entries: LegacyRetirementEvidence[] },
): void {
  const file = legacyRetirementFile(workspaceId);
  const marker = markerFile(workspaceId);
  const temporary = `${file}.${randomUUID()}.tmp`;
  const parsed = retirementStateSchema.parse(state);
  let fd: number | undefined;
  let prepared = false;
  try {
    ensureDir(path.dirname(file));
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(parsed));
    fs.fsyncSync(fd);
    prepared = true;
  } catch {
    throw new LegacyRetirementError("LEGACY_RETIREMENT_STORE_WRITE", "遗留 retirement 证据无法写入；保留原文件并人工核对。");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (!prepared) fs.rmSync(temporary, { force: true });
  }
  try {
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
    if (!fs.existsSync(marker)) {
      const markerFd = fs.openSync(marker, "wx", 0o600);
      try { fs.writeFileSync(markerFd, "1\n"); fs.fsyncSync(markerFd); }
      finally { fs.closeSync(markerFd); }
    }
  } catch {
    throw new LegacyRetirementError("LEGACY_RETIREMENT_STORE_WRITE", "遗留 retirement 证据提交失败；保留原文件并人工核对。");
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** 只读读取；缺少初始化文件时返回空数组，不创建目录或锁。 */
export function readLegacyRetirements(workspaceId: string): LegacyRetirementEvidence[] {
  let id: string;
  try { id = desktopId.parse(workspaceId); }
  catch { return invalid("workspaceId 格式无效；拒绝读取 legacy retirement。"); }
  return readState(id).entries;
}

function deliverySummary(delivery: DesktopDelivery): Record<string, unknown> {
  return {
    commandId: delivery.commandId,
    clientId: delivery.clientId,
    bindingId: delivery.bindingId,
    intent: delivery.intent ?? null,
    messageSha256: delivery.messageSha256,
    messageBytes: delivery.messageBytes,
    threadId: delivery.threadId,
    turnId: delivery.turnId ?? null,
    deliveryStatus: delivery.deliveryStatus,
    errorCode: delivery.errorCode ?? null,
    errorMessage: delivery.errorMessage ?? null,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
  };
}

function deliverySha256(delivery: DesktopDelivery): string {
  return createHash("sha256").update(JSON.stringify(deliverySummary(delivery)), "utf8").digest("hex");
}

function readSnapshot(workspace: LegacyRetirementWorkspace, lockRecords: boolean): RetirementSnapshot {
  let desktop: DesktopState | null;
  try { desktop = readDesktop(workspace.id); }
  catch { return corrupt("LEGACY_RETIREMENT_DESKTOP_CORRUPT", "Desktop 状态损坏；保留文件并人工核对。"); }

  let records: StoredExecutionRecord[];
  try {
    const recordsFile = path.join(getStateDir(), "executions", `${workspace.id}.jsonl`);
    records = lockRecords && fs.existsSync(recordsFile)
      ? withExecutionRecordsLock(workspace.id, () => readExecutionRecordsStrict(workspace.id))
      : readExecutionRecordsStrict(workspace.id);
  } catch {
    return corrupt("LEGACY_RETIREMENT_RECORDS_CORRUPT", "execution JSONL 损坏、繁忙或不完整；拒绝 legacy retirement。");
  }

  let outputs: ExecutionOutputMeta[];
  try { outputs = readExecutionOutputMetadataStrict(workspace.id); }
  catch { return corrupt("LEGACY_RETIREMENT_OUTPUT_CORRUPT", "execution output index 损坏或不完整；拒绝 legacy retirement。"); }
  return { desktop, records, outputs };
}

function snapshotText(snapshot: RetirementSnapshot): string {
  return JSON.stringify({ desktop: snapshot.desktop, records: snapshot.records, outputs: snapshot.outputs });
}

function matchesCommand(record: StoredExecutionRecord, commandId: string): boolean {
  return record.commandId === commandId || record.taskId === commandId || record.taskId === `desktop_${commandId}`;
}

function matchesOutput(output: ExecutionOutputMeta, commandId: string): boolean {
  return output.taskId === commandId || output.taskId === `desktop_${commandId}`;
}

function eligibleFacts(
  workspace: LegacyRetirementWorkspace,
  commandId: string,
  snapshot: RetirementSnapshot,
): RetirementFacts {
  const desktop = snapshot.desktop;
  if (!desktop || desktop.workspaceRoot !== workspace.root) {
    return notEligible("没有与当前 workspace 一致的 Desktop 状态；拒绝 legacy retirement。");
  }
  if (unresolvedOutcomeUnknownCommandIds(workspace, desktop).size > 0) {
    return notEligible("存在 outcome_unknown Desktop 投递；拒绝 legacy retirement。");
  }
  const binding = desktop.binding;
  if (!binding) return notEligible("当前 workspace 没有 Desktop binding；拒绝 legacy retirement。");
  const delivery = desktop.deliveries.find(item => item.commandId === commandId);
  if (!delivery || delivery.deliveryStatus !== "accepted" ||
    !delivery.turnId || !uuid.safeParse(delivery.turnId).success) {
    return notEligible("没有带合法 turnId 的 accepted Desktop 投递；拒绝 legacy retirement。");
  }
  if (delivery.intent !== undefined) {
    return notEligible("当前 Desktop delivery 已有 intent；不能走 legacy retirement。");
  }
  if (delivery.threadId === binding.threadId) {
    return notEligible("旧 accepted delivery 仍属于当前 binding thread；拒绝 legacy retirement。");
  }
  if (snapshot.records.some(record => matchesCommand(record, commandId))) {
    return conflict("commandId/taskId execution 证据已存在；拒绝覆盖或忽略。");
  }
  if (snapshot.outputs.some(output => matchesOutput(output, commandId))) {
    return conflict("对应 commandId/taskId output 证据已存在；拒绝覆盖或忽略。");
  }
  return { delivery, deliverySha256: deliverySha256(delivery) };
}

function readReconciliations(workspaceId: string): ReturnType<typeof readLegacyReconciliations> {
  try {
    return readLegacyReconciliations(workspaceId);
  } catch {
    return conflict("reconciliation 证据无法安全读取；拒绝 legacy retirement。");
  }
}

function hasEvidenceOverlap(
  retirements: LegacyRetirementEvidence[],
  reconciliations: ReturnType<typeof readLegacyReconciliations>,
): boolean {
  const reconciliationIds = new Set(reconciliations.map(entry => entry.commandId));
  return retirements.some(entry => reconciliationIds.has(entry.commandId));
}

function ipcCode(error: unknown): string | undefined {
  if (error instanceof DesktopError) return error.code;
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return undefined;
}

function ipcFailure(phase: "old" | "current", error: unknown): never {
  const code = ipcCode(error);
  throw new LegacyRetirementError("LEGACY_RETIREMENT_IPC",
    `${phase === "old" ? "旧" : "当前"} Desktop target 无法安全确认（${code ?? "unknown"}）；拒绝 legacy retirement。`);
}

function isOwnerlessEvidence(entry: LegacyRetirementEvidence): entry is OwnerlessRetirementEvidence {
  return "kind" in entry && entry.kind === "ownerless";
}

function ownerlessContext(value: unknown, binding: NonNullable<DesktopState["binding"]>, workspaceRoot: string): OwnerlessContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return notEligible("当前 Desktop maintenance result context 无效；拒绝 ownerless retirement。");
  }
  const context = value as Partial<DesktopResultContext>;
  if (context.threadId !== binding.threadId || context.hostId !== binding.hostId ||
      context.projectId !== binding.projectId || context.workspaceRoot !== workspaceRoot) {
    return notEligible("当前 Desktop result context 与 binding 身份不一致；拒绝 ownerless retirement。");
  }
  const resultTurnId = context.resultTurnId;
  const runtimeStatus = context.runtimeStatus;
  if (typeof resultTurnId !== "string" || !uuid.safeParse(resultTurnId).success || context.resultTurnStatus !== "inProgress" ||
      (runtimeStatus !== "active" && runtimeStatus !== "inProgress")) {
    return notEligible("当前 Desktop maintenance turn 不是 active/inProgress；拒绝 ownerless retirement。");
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
    resultTurnId,
    resultTurnStatus: "inProgress",
    runtimeStatus,
    requestsCount: context.requestsCount,
    ownerClientId: context.ownerClientId,
  };
}

function sameOwnerlessContext(a: OwnerlessContext, b: OwnerlessContext): boolean {
  return a.threadId === b.threadId && a.hostId === b.hostId && a.projectId === b.projectId &&
    a.workspaceRoot === b.workspaceRoot && a.title === b.title && a.cwd === b.cwd &&
    a.workspaceKind === b.workspaceKind && a.resumeState === b.resumeState &&
    a.resultTurnId === b.resultTurnId && a.resultTurnStatus === b.resultTurnStatus &&
    a.runtimeStatus === b.runtimeStatus && a.requestsCount === b.requestsCount &&
    a.ownerClientId === b.ownerClientId;
}

function waitForCurrentContextRetry(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, CURRENT_CONTEXT_RETRY_DELAY_MS));
}

async function currentOwnerlessContext(
  workspace: LegacyRetirementWorkspace,
  binding: NonNullable<DesktopState["binding"]>,
): Promise<OwnerlessContext> {
  let failure: unknown;
  let context: DesktopResultContext | undefined;
  for (let attempt = 1; attempt <= CURRENT_CONTEXT_ATTEMPTS; attempt += 1) {
    try {
      context = await desktopIpc.currentResultContext(workspace.root);
      break;
    } catch (error) {
      failure = error;
      if (ipcCode(error) !== "DESKTOP_STATE_UNAVAILABLE" || attempt === CURRENT_CONTEXT_ATTEMPTS) {
        return ipcFailure("current", error);
      }
      await waitForCurrentContextRetry();
    }
  }
  if (!context) return ipcFailure("current", failure);
  return ownerlessContext(context, binding, workspace.root);
}

type TargetConfirmation = {
  observedAt: string;
  maintenance?: OwnerlessContext;
};

async function confirmTargets(
  workspace: LegacyRetirementWorkspace,
  facts: RetirementFacts,
  binding: NonNullable<DesktopState["binding"]>,
  ownerless: boolean,
): Promise<TargetConfirmation> {
  const oldTarget: DesktopTarget = {
    threadId: facts.delivery.threadId,
    hostId: binding.hostId,
    projectId: binding.projectId,
    workspaceRoot: workspace.root,
  };
  let observedMissingAt: string | undefined;
  try {
    await desktopIpc.inspect(oldTarget);
  } catch (error) {
    const code = ipcCode(error);
    if (ownerless) {
      if (code !== "DESKTOP_NO_OWNER") return ipcFailure("old", error);
      observedMissingAt = new Date().toISOString();
    } else {
      if (code !== "DESKTOP_TARGET_NOT_FOUND") return ipcFailure("old", error);
      observedMissingAt = new Date().toISOString();
    }
  }
  if (!observedMissingAt) return notEligible(ownerless
    ? "旧 Desktop target 仍可确认 owner；未观察到明确 DESKTOP_NO_OWNER，拒绝 ownerless retirement。"
    : "旧 Desktop target 仍可访问；未观察到明确缺失，拒绝 retirement。");

  if (ownerless) {
    return { observedAt: observedMissingAt, maintenance: await currentOwnerlessContext(workspace, binding) };
  }

  const currentTarget: DesktopTarget = {
    threadId: binding.threadId,
    hostId: binding.hostId,
    projectId: binding.projectId,
    workspaceRoot: workspace.root,
  };
  let current: Awaited<ReturnType<typeof desktopIpc.inspect>>;
  try { current = await desktopIpc.inspect(currentTarget); }
  catch (error) { return ipcFailure("current", error); }
  if (current.runtimeStatus !== "idle") {
    return notEligible("当前 Desktop binding 不是 idle；拒绝 legacy retirement。");
  }
  return { observedAt: observedMissingAt };
}

function mapEvidenceLockError(error: unknown): never {
  if (error instanceof LegacyRetirementError) throw error;
  if (ipcCode(error) === "LEGACY_RECONCILIATION_BUSY") {
    throw new LegacyRetirementError("LEGACY_RETIREMENT_BUSY", "遗留 retirement/reconciliation 写锁繁忙；请稍后重试。");
  }
  if (error instanceof DesktopError && error.code.startsWith("LEGACY_RECONCILIATION_")) {
    throw new LegacyRetirementError("LEGACY_RETIREMENT_CONFLICT", "reconciliation 证据无法安全确认；拒绝 legacy retirement。");
  }
  throw new LegacyRetirementError("LEGACY_RETIREMENT_STORE_WRITE", "遗留 retirement 提交失败；保留原文件并人工核对。");
}

/**
 * 仅为明确缺失 execution/output 的 pre-receipt accepted 记录保存处置证据。
 * IPC 调用前后不持有任何本地写锁；证据提交使用 reconciliation 共享锁。
 */
export async function retireLegacyAccepted(
  workspaceRaw: LegacyRetirementWorkspace,
  commandIdRaw: string,
  options: { ownerless?: boolean } = {},
): Promise<LegacyRetirementResult> {
  const workspace = parseWorkspace(workspaceRaw);
  const commandId = parseCommandId(commandIdRaw);
  const ownerless = options.ownerless === true;
  const initialState = readState(workspace.id);
  const abandoned = readAbandonedCommandIds(workspace.id);
  if (abandoned.has(commandId) || initialState.entries.some(entry => abandoned.has(entry.commandId))) {
    return conflict("retirement 与 abandonment 互斥；拒绝重复处置或双证据。");
  }
  const initialSnapshot = readSnapshot(workspace, true);
  const initialFacts = eligibleFacts(workspace, commandId, initialSnapshot);
  const initialDesktop = initialSnapshot.desktop;
  if (!initialDesktop?.binding) return notEligible("当前 workspace 没有 Desktop binding；拒绝 legacy retirement。");
  const initialPrior = initialState.entries.find(entry => entry.commandId === commandId);
  if (initialPrior && isOwnerlessEvidence(initialPrior) !== ownerless) {
    return conflict("同一 commandId 已有不同 kind 的 retirement 证据；不覆盖旧证据。");
  }
  const initialReconciliations = readReconciliations(workspace.id);
  if (initialReconciliations.some(entry => entry.commandId === commandId) ||
    hasEvidenceOverlap(initialState.entries, initialReconciliations)) {
    return conflict("同一 commandId 已有 reconciliation 证据；retirement 与 reconciliation 互斥。");
  }

  const confirmation = await confirmTargets(workspace, initialFacts, initialDesktop.binding, ownerless);

  const afterSnapshot = readSnapshot(workspace, true);
  if (snapshotText(afterSnapshot) !== snapshotText(initialSnapshot)) {
    return conflict("Desktop、execution 或 output 事实在 IPC 校验期间发生变化；拒绝写入 retirement 证据。");
  }
  const afterFacts = eligibleFacts(workspace, commandId, afterSnapshot);
  if (afterFacts.deliverySha256 !== initialFacts.deliverySha256) {
    return conflict("accepted delivery 摘要在 IPC 校验期间发生变化；拒绝写入 retirement 证据。");
  }

  let maintenance: OwnerlessContext | undefined;
  if (ownerless) {
    const initialMaintenance = confirmation.maintenance;
    if (!initialMaintenance) return conflict("ownerless retirement 缺少 maintenance context；拒绝写入证据。");
    maintenance = await currentOwnerlessContext(workspace, initialDesktop.binding);
    if (!sameOwnerlessContext(initialMaintenance, maintenance)) {
      return conflict("当前 Desktop maintenance thread/turn 在校验期间发生变化；拒绝写入 retirement 证据。");
    }
  }

  try {
    return withEvidenceLock(workspace.id, () => {
      const state = readState(workspace.id);
      const abandonedNow = readAbandonedCommandIds(workspace.id);
      if (abandonedNow.has(commandId) || state.entries.some(entry => abandonedNow.has(entry.commandId))) {
        return conflict("retirement 与 abandonment 互斥；拒绝重复处置或双证据。");
      }
      if (JSON.stringify(state) !== JSON.stringify(initialState)) {
        return conflict("retirement 证据在 IPC 校验期间发生变化；拒绝覆盖或追加。");
      }
      const reconciliations = readLegacyReconciliations(workspace.id);
      if (reconciliations.some(entry => entry.commandId === commandId) || hasEvidenceOverlap(state.entries, reconciliations)) {
        return conflict("同一 commandId 已有 reconciliation 证据；retirement 与 reconciliation 互斥。");
      }
      const lockedSnapshot = readSnapshot(workspace, true);
      if (snapshotText(lockedSnapshot) !== snapshotText(afterSnapshot)) {
        return conflict("提交前 Desktop、execution 或 output 事实发生变化；拒绝写入 retirement 证据。");
      }
      const lockedFacts = eligibleFacts(workspace, commandId, lockedSnapshot);
      if (lockedFacts.deliverySha256 !== afterFacts.deliverySha256) {
        return conflict("提交前 accepted delivery 摘要发生变化；拒绝写入 retirement 证据。");
      }
      const prior = state.entries.find(entry => entry.commandId === commandId);
      if (prior) {
        if (isOwnerlessEvidence(prior) !== ownerless) {
          return conflict("同一 commandId 已有不同 kind 的 retirement 证据；不覆盖旧证据。");
        }
        if (prior.deliverySha256 !== lockedFacts.deliverySha256) {
          return conflict("已有 retirement 证据与当前 delivery 摘要冲突；不覆盖旧证据。");
        }
        return { status: "already_retired", commandId };
      }
      const evidence: LegacyRetirementEvidence = ownerless ? {
        kind: "ownerless",
        commandId,
        deliverySha256: lockedFacts.deliverySha256,
        observedOwnerlessAt: confirmation.observedAt,
        maintenanceThreadId: maintenance!.threadId,
        maintenanceTurnId: maintenance!.resultTurnId,
      } : {
        commandId,
        deliverySha256: lockedFacts.deliverySha256,
        observedMissingAt: confirmation.observedAt,
      };
      writeState(workspace.id, { ...state, entries: [...state.entries, evidence] });
      return { status: "retired", commandId };
    });
  } catch (error) {
    return mapEvidenceLockError(error);
  }
}

/** 只读严格重验；不做 IPC，也不初始化任何目录或锁。 */
export function getRetiredLegacyCommandIds(workspaceRaw: LegacyRetirementWorkspace): Set<string> {
  const workspace = parseWorkspace(workspaceRaw);
  const state = readState(workspace.id);
  const abandoned = readAbandonedCommandIds(workspace.id);
  if (state.entries.some(entry => abandoned.has(entry.commandId))) {
    return conflict("retirement 与 abandonment 双证据冲突。");
  }
  if (!state.entries.length) return new Set();
  const reconciliations = readReconciliations(workspace.id);
  const reconciliationIds = new Set(reconciliations.map(entry => entry.commandId));
  if (state.entries.some(entry => reconciliationIds.has(entry.commandId))) {
    return conflict("retirement 与 reconciliation 存在双证据；拒绝使用 retirement 证据。");
  }

  const snapshot = readSnapshot(workspace, false);
  const retired = new Set<string>();
  for (const entry of state.entries) {
    let facts: RetirementFacts;
    try { facts = eligibleFacts(workspace, entry.commandId, snapshot); }
    catch (error) {
      if (error instanceof LegacyRetirementError && error.code === "LEGACY_RETIREMENT_STORE_CORRUPT") throw error;
      throw new LegacyRetirementError("LEGACY_RETIREMENT_CONFLICT", "已有 retirement 证据与当前 Desktop 或本地事实冲突；拒绝忽略。");
    }
    // maintenance thread/turn 是创建时的审计事实；当前 binding 的资格由 eligibleFacts 重验。
    if (entry.deliverySha256 !== facts.deliverySha256) {
      return conflict("已有 retirement 证据与当前 delivery 摘要冲突；拒绝忽略。");
    }
    retired.add(entry.commandId);
  }
  return retired;
}
