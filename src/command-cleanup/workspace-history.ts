import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { getStateDir } from "../config/paths.js";
import { resolveWorkspaceIdentity, readRouting, type RoutingWorkspaceIdentity } from "../routing/store.js";
import { readDesktop } from "../desktop/store.js";
import { readRemote } from "../remote/store.js";
import { readResultBus } from "../result-bus/store.js";
import { isResultBusInFlight } from "../result-bus/schema.js";
import { readResultBusCutover } from "../result-bus/cutover-store.js";
import { listResultOutboxEntries, listResultReconciliationNeeded } from "../routing/result-outbox-store.js";
import { readExecutorDispatchState } from "../executor-control/dispatch-store.js";
import { readAbandonments } from "../desktop/abandonment.js";
import { readOutcomeResolutions } from "../desktop/outcome-resolution.js";
import { readLegacyRetirements } from "../desktop/legacy-retirement.js";
import { readLegacyReconciliations } from "../desktop/legacy-reconciliation.js";
import { isTrustedDesktopReceipt, readExecutionRecordsStrict } from "../execution/records.js";
import { readExecutionOutputIndexStrict, readExecutionOutputIndexLocked } from "../execution/output.js";
import { validateWebControl, validateProjectChatState, type SavedSession } from "../session/schema.js";
import { feedbackStateSchema } from "../feedback/schema.js";
import { readFeedbackStatusState } from "../feedback/state-store.js";
import { withDeliveryArbiter } from "../bridge/delivery-arbiter.js";
import { assertCleanupPath, withWorkspaceCleanupOperation } from "./fence.js";
import { inspectCompletedRepairHistory } from "./abandonment-repair-store.js";
import { CommandCleanupError } from "./schema.js";
import { fingerprintSchema, fileFingerprint, removeExact, replaceExact } from "./legacy-history.js";
import { legacyHistoryJournalFile, workspaceHistoryJournalFile, withWorkspaceHistoryOwner } from "./legacy-history-fence.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const countsSchema = z.object({ tasks: z.number().int().nonnegative(), records: z.number().int().nonnegative(),
  outputs: z.number().int().nonnegative(), feedback: z.number().int().nonnegative(), resultBus: z.number().int().nonnegative(),
  routing: z.number().int().nonnegative(), desktop: z.number().int().nonnegative(), dispatch: z.number().int().nonnegative(),
  administrative: z.number().int().nonnegative(), repairHistory: z.number().int().nonnegative(), panelOperations: z.number().int().nonnegative(),
  threads: z.number().int().nonnegative(), audit: z.number().int().nonnegative(), cutover: z.number().int().nonnegative(), outbox: z.number().int().nonnegative(),
}).strict();
const artifactSchema = z.object({ relative: z.string().min(1), before: fingerprintSchema.nullable(), after: z.string().nullable() }).strict();
const snapshotSchema = z.object({ version: z.literal(1), workspaceId: z.string().regex(/^[a-f0-9]{12}$/),
  workspaceRoot: z.string().min(1), counts: countsSchema, artifacts: z.array(artifactSchema) }).strict();
const journalSchema = z.object({ snapshot: snapshotSchema, confirmationSha256: hex }).strict()
  .refine(value => hash(JSON.stringify(value.snapshot)) === value.confirmationSha256);
type Snapshot = z.infer<typeof snapshotSchema>;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const RESET = "@FORMAT_CONFIRMATION@";
export const WORKSPACE_HISTORY_NOTICE = "永久清空当前工作区的任务、记录、输出和回流历史；保留连接、配对与当前绑定。不会撤回外部消息、证明执行成功或重发任务。";
function blocked(code = "WORKSPACE_HISTORY_CONFLICT"): never {
  throw new CommandCleanupError(code, "工作区历史仍有活动任务、未隔离发送、锁或证据变化；停止格式化并保留恢复 journal。");
}
function fixedPaths(id: string) {
  return [`remote-control/${id}.json`, `routing/${id}.json`, `desktop-control/${id}.json`,
    `executor-dispatch/${id}.json`, `result-bus/${id}.json`, `result-bus-cutover/${id}.json`,
    `routing/${id}.result-outbox.json`, `routing/${id}.result-reconciliation.json`,
    ...["desktop-abandonment", "desktop-outcome-resolution", "desktop-legacy-retirement", "desktop-legacy-reconciliation"].map(dir => `${dir}/${id}.json`),
    `executions/${id}.jsonl`, `execution-outputs/${id}/index.json`, `feedback/${id}.json`];
}
function artifactFile(relative: string, identity: RoutingWorkspaceIdentity, stateDir: string): string {
  if (!fixedPaths(identity.id).includes(relative)
    && !new RegExp(`^execution-outputs/${identity.id}/bodies/[1-9][0-9]*\\.txt$`).test(relative)
    && !new RegExp(`^desktop-lock-repairs/${identity.id}/[A-Za-z0-9_-]{1,128}\\.json$`).test(relative)
    && !new RegExp(`^desktop-lock-repairs/${identity.id}/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.lock$`).test(relative)) blocked();
  const file = path.join(stateDir, ...relative.split("/")); assertCleanupPath(file, stateDir); return file;
}
function completedRepairArtifacts(identity: RoutingWorkspaceIdentity, stateDir: string): Snapshot["artifacts"] {
  const directory = path.join(stateDir, "desktop-lock-repairs", identity.id); assertCleanupPath(directory, stateDir);
  if (!fs.existsSync(directory)) return [];
  const names = fs.readdirSync(directory), artifacts: Snapshot["artifacts"] = [];
  for (const name of names.filter(name => name.endsWith(".json"))) {
    const commandId = name.slice(0, -5);
    for (const entry of inspectCompletedRepairHistory(identity, commandId, stateDir))
      artifacts.push({ relative: path.relative(stateDir, entry.file).split(path.sep).join("/"), before: entry.fingerprint, after: null });
  }
  if (!same(names.sort(), artifacts.map(artifact => path.basename(artifact.relative)).sort())) blocked("WORKSPACE_HISTORY_BUSY");
  return artifacts;
}
function checkAuxiliary(identity: RoutingWorkspaceIdentity, stateDir: string, expected?: Snapshot["artifacts"]) {
  const sessionFile = path.join(stateDir, "sessions", `${identity.id}.json`), sessionFingerprint = fileFingerprint(sessionFile, stateDir);
  if (sessionFingerprint) {
    const session = JSON.parse(fs.readFileSync(sessionFile, "utf8")) as SavedSession;
    if (!session || typeof session !== "object" || Array.isArray(session) || typeof session.savedAt !== "string") blocked();
    validateWebControl(session); validateProjectChatState(session);
    if (session.webControl?.activeCommand || session.webControl && ["accepted", "executing"].includes(session.webControl.status)) blocked("WORKSPACE_HISTORY_NOT_QUIESCENT");
    if (!same(fileFingerprint(sessionFile, stateDir), sessionFingerprint)) blocked();
  }
  for (const dir of ["command-cleanup"]) {
    const directory = path.join(stateDir, dir, identity.id); assertCleanupPath(directory, stateDir);
    if (fs.existsSync(directory) && fs.readdirSync(directory).length) blocked("WORKSPACE_HISTORY_BUSY");
  }
  const directory = path.join(stateDir, "desktop-lock-repairs", identity.id); assertCleanupPath(directory, stateDir);
  if (expected) {
    const allowed = expected.filter(artifact => artifact.relative.startsWith(`desktop-lock-repairs/${identity.id}/`)).map(artifact => path.basename(artifact.relative));
    if (fs.existsSync(directory) && fs.readdirSync(directory).some(name => !allowed.includes(name))) blocked("WORKSPACE_HISTORY_BUSY");
  } else completedRepairArtifacts(identity, stateDir);
  for (const kind of ["drafts", "claims", "alerts"]) {
    const directory = path.join(stateDir, "desktop-receipt-finalization", kind); assertCleanupPath(directory, stateDir);
    if (fs.existsSync(directory) && fs.readdirSync(directory).some(name => name.startsWith(`${identity.id}-`))) blocked("WORKSPACE_HISTORY_BUSY");
  }
  if (fileFingerprint(legacyHistoryJournalFile(identity.id, stateDir), stateDir)) blocked("WORKSPACE_HISTORY_BUSY");
}
function checkLocks(identity: RoutingWorkspaceIdentity, stateDir: string, owned: ReadonlySet<string> = new Set(), expected?: Snapshot["artifacts"]) {
  checkAuxiliary(identity, stateDir, expected);
  for (const relative of fixedPaths(identity.id)) {
    const file = artifactFile(relative, identity, stateDir), directory = path.dirname(file);
    fileFingerprint(`${file}.initialized`, stateDir);
    for (const suffix of [".lock", ".lock.reclaim"]) {
      const lock = `${file}${suffix}`; assertCleanupPath(lock, stateDir);
      if (!owned.has(lock) && fs.existsSync(lock)) blocked("WORKSPACE_HISTORY_BUSY");
    }
    if (fs.existsSync(directory) && fs.readdirSync(directory).some(name => name.startsWith(`${path.basename(file)}.`)
      && (name.endsWith(".tmp") || name.includes(".tmp-")))) blocked();
  }
}
function snapshot(identity: RoutingWorkspaceIdentity, stateDir: string, owned?: ReadonlySet<string>): Snapshot {
  checkLocks(identity, stateDir, owned);
  const before = new Map(fixedPaths(identity.id).map(relative => [relative, fileFingerprint(artifactFile(relative, identity, stateDir), stateDir)]));
  const remote = readRemote(identity.id, stateDir), routing = readRouting(identity, stateDir), desktop = readDesktop(identity.id, stateDir);
  const bus = readResultBus(identity, stateDir), cutover = readResultBusCutover(identity, stateDir), dispatch = readExecutorDispatchState(identity.id, stateDir);
  const feedback = readFeedbackStatusState(identity.id, stateDir), records = readExecutionRecordsStrict(identity.id, stateDir);
  const output = owned ? readExecutionOutputIndexLocked(identity.id, stateDir) : readExecutionOutputIndexStrict(identity.id, stateDir);
  const closed = new Set([...readAbandonments(identity.id, stateDir), ...readOutcomeResolutions(identity.id, stateDir),
    ...readLegacyRetirements(identity.id, stateDir)].map(item => item.commandId));
  const administrative = closed.size + readLegacyReconciliations(identity.id, stateDir).length;
  const outbox = listResultOutboxEntries(identity, stateDir).length + listResultReconciliationNeeded(identity, stateDir).length;
  for (const store of [remote, routing, desktop, dispatch, bus, cutover])
    if (store && store.workspaceRoot !== identity.root) blocked();
  const terminal = (commandId: string) => closed.has(commandId) || records.some(record => isTrustedDesktopReceipt(record, commandId))
    || !!routing?.results.some(result => result.commandId === commandId && "machineEvidence" in result);
  if (remote?.controller && ["starting", "running", "unknown"].includes(remote.controller.appServer)
    || remote?.tasks.some(task => !["completed", "failed", "cancelled"].includes(task.status))
    || remote?.threads.some(thread => !["completed", "failed", "cancelled"].includes(thread.status))
    || routing?.commands.some(command => command.deliveryStatus === "pending" || command.deliveryStatus === "outcome_unknown" && !closed.has(command.commandId)
      || command.deliveryStatus === "accepted" && !terminal(command.commandId))
    || desktop?.deliveries.some(delivery => delivery.deliveryStatus === "outcome_unknown" && !closed.has(delivery.commandId)
      || delivery.deliveryStatus === "accepted" && !terminal(delivery.commandId))
    || dispatch?.entries.some(entry => entry.deliveryStatus === "started" || entry.deliveryStatus === "outcome_unknown" && !closed.has(entry.commandId)
      || entry.deliveryStatus === "accepted" && !terminal(entry.commandId))
    || bus?.entries.some(isResultBusInFlight)
    || feedback.events.some(event => ["reserved", "claimed", "outcome_unknown"].includes(event.status))
    || feedback.panelOperations?.some(operation => operation.status === "pending") || feedback.cleanupAdjustments?.length)
    blocked("WORKSPACE_HISTORY_NOT_QUIESCENT");
  if (feedback.projectionCursor > records.length) blocked();
  const repairs = completedRepairArtifacts(identity, stateDir);
  const counts = { tasks: remote?.tasks.length ?? 0, records: records.length, outputs: output.items.length,
    feedback: feedback.events.length, resultBus: bus?.entries.length ?? 0, routing: (routing?.commands.length ?? 0) + (routing?.results.length ?? 0),
    desktop: desktop?.deliveries.length ?? 0, dispatch: dispatch?.entries.length ?? 0, administrative, repairHistory: repairs.length / 2,
    panelOperations: feedback.panelOperations?.length ?? 0, threads: remote?.threads.length ?? 0, audit: remote?.audit.length ?? 0,
    cutover: cutover?.entries.length ?? 0, outbox };
  const artifacts: Snapshot["artifacts"] = fixedPaths(identity.id).map(relative => {
    const file = artifactFile(relative, identity, stateDir), fingerprint = before.get(relative)!;
    let after: string | null = null;
    if (fingerprint && !relative.endsWith(".jsonl")) {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (relative.startsWith("remote-control/")) { value.tasks = []; value.threads = []; value.audit = []; }
      else if (relative.startsWith("routing/") && relative === `routing/${identity.id}.json`) { value.commands = []; value.results = []; }
      else if (relative.startsWith("desktop-control/")) value.deliveries = [];
      else if (relative.startsWith("feedback/")) {
        value.events = []; value.projectionCursor = 0; delete value.panelOperations; delete value.cleanupAdjustments;
        value.historyFormatSha256 = RESET;
      } else if (relative.startsWith("execution-outputs/")) value.items = [];
      else if (relative.startsWith("desktop-abandonment/")) value.batches = [];
      else value.entries = [];
      if (typeof value.revision === "number") {
        if (!Number.isSafeInteger(value.revision + 1)) blocked(); value.revision++;
      }
      after = JSON.stringify(value);
    } else if (relative.startsWith("feedback/")) after = JSON.stringify({ ...feedbackStateSchema.parse(feedback), historyFormatSha256: RESET, projectionCursor: 0, events: [] });
    if (!same(fileFingerprint(file, stateDir), fingerprint)) blocked();
    return { relative, before: fingerprint, after };
  });
  const bodies = output.items.filter(item => item.allowed && item.sizeBytes > 0).map(item => {
    const relative = `execution-outputs/${identity.id}/bodies/${item.id}.txt`;
    const fingerprint = fileFingerprint(artifactFile(relative, identity, stateDir), stateDir);
    if (!fingerprint || fingerprint.size !== item.sizeBytes) blocked();
    return { relative, before: fingerprint, after: null };
  });
  const directory = path.join(stateDir, "execution-outputs", identity.id, "bodies"); assertCleanupPath(directory, stateDir);
  if (fs.existsSync(directory) && !same(fs.readdirSync(directory).sort(), bodies.map(body => path.basename(body.relative)).sort())) blocked();
  return snapshotSchema.parse({ version: 1, workspaceId: identity.id, workspaceRoot: identity.root, counts, artifacts: [...artifacts, ...bodies, ...repairs] });
}
function readJournal(identity: RoutingWorkspaceIdentity, stateDir: string) {
  const file = workspaceHistoryJournalFile(identity.id, stateDir), fingerprint = fileFingerprint(file, stateDir);
  if (!fingerprint) return null;
  try {
    const journal = journalSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (journal.snapshot.workspaceId !== identity.id || journal.snapshot.workspaceRoot !== identity.root || !same(fileFingerprint(file, stateDir), fingerprint)) blocked();
    const relatives = journal.snapshot.artifacts.map(artifact => artifact.relative);
    if (new Set(relatives).size !== relatives.length || fixedPaths(identity.id).some(relative => !relatives.includes(relative))) blocked();
    for (const artifact of journal.snapshot.artifacts) artifactFile(artifact.relative, identity, stateDir);
    return { ...journal, fingerprint };
  } catch { return blocked("WORKSPACE_HISTORY_JOURNAL_CORRUPT"); }
}
export function previewWorkspaceHistoryFormat(raw: RoutingWorkspaceIdentity, stateDir = getStateDir()) {
  const identity = resolveWorkspaceIdentity(raw); stateDir = path.resolve(stateDir);
  const prior = readJournal(identity, stateDir), value = prior?.snapshot ?? snapshot(identity, stateDir);
  const present = !!prior || Object.values(value.counts).some(count => count > 0);
  return { status: present ? "preview" as const : "not_found" as const, workspaceId: identity.id,
    confirmationSha256: hash(JSON.stringify(value)), counts: value.counts, notice: WORKSPACE_HISTORY_NOTICE,
    ...(prior ? { pending: true } : {}) };
}
/** Store locks precede durable fence; every writer rechecks that fence after acquiring its own lock. */
// shortcut: 硬崩溃留下 journal 和锁时停止；另行本机精确核验后恢复，不自动回收锁。
function withStoreLocks<T>(identity: RoutingWorkspaceIdentity, stateDir: string, action: (owned: ReadonlySet<string>) => T): T {
  const owned = new Map<string, { fd: number; raw: string }>();
  try {
    for (const relative of fixedPaths(identity.id)) {
      const file = `${artifactFile(relative, identity, stateDir)}.lock`; fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); assertCleanupPath(file, stateDir);
      let fd: number; try { fd = fs.openSync(file, "wx", 0o600); } catch { return blocked("WORKSPACE_HISTORY_BUSY"); }
      const raw = JSON.stringify({ pid: process.pid, nonce: randomUUID() }); owned.set(file, { fd, raw }); fs.writeFileSync(fd, raw); fs.fsyncSync(fd);
    }
    return action(new Set(owned.keys()));
  } finally {
    for (const [file, lock] of [...owned].reverse()) {
      const original = fs.fstatSync(lock.fd); fs.closeSync(lock.fd);
      const current = fs.lstatSync(file); if (!current.isFile() || current.ino !== original.ino || current.dev !== original.dev || fs.readFileSync(file, "utf8") !== lock.raw) blocked();
      fs.unlinkSync(file);
    }
  }
}
function afterBytes(artifact: Snapshot["artifacts"][number], confirmation: string): string | null {
  if (!artifact.after || !artifact.relative.startsWith("feedback/")) return artifact.after;
  return JSON.stringify({ ...JSON.parse(artifact.after), historyFormatSha256: confirmation });
}
export function confirmWorkspaceHistoryFormat(raw: RoutingWorkspaceIdentity, confirmationSha256: string, stateDir = getStateDir(), hook?: (stage: string) => void) {
  const identity = resolveWorkspaceIdentity(raw); stateDir = path.resolve(stateDir);
  const journalFile = workspaceHistoryJournalFile(identity.id, stateDir);
  let journalStarted = fs.existsSync(journalFile);
  try {
  if (!hex.safeParse(confirmationSha256).success || previewWorkspaceHistoryFormat(identity, stateDir).confirmationSha256 !== confirmationSha256)
    blocked("COMMAND_CLEANUP_CONFIRMATION_MISMATCH");
  return withDeliveryArbiter({ workspaceId: identity.id, workspaceRoot: identity.root, stateDir }, () =>
    withWorkspaceHistoryOwner(identity.id, stateDir, () => withWorkspaceCleanupOperation(identity.id, stateDir, () =>
      withStoreLocks(identity, stateDir, owned => {
        const file = workspaceHistoryJournalFile(identity.id, stateDir);
        hook?.("locked");
        let journal = readJournal(identity, stateDir);
        if (!journal) {
          const value = snapshot(identity, stateDir, owned);
          if (hash(JSON.stringify(value)) !== confirmationSha256) blocked("COMMAND_CLEANUP_CONFIRMATION_MISMATCH");
          fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); assertCleanupPath(file, stateDir);
          const fd = fs.openSync(file, "wx", 0o600); journalStarted = true;
          try { fs.writeFileSync(fd, JSON.stringify({ snapshot: value, confirmationSha256 })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          journal = readJournal(identity, stateDir)!;
        }
        // 只缓存已校验相对路径推导的字符串；每轮仍实时核验路径与文件状态。
        const artifacts = journal.snapshot.artifacts.map(artifact => ({ ...artifact, target: path.join(stateDir, ...artifact.relative.split("/")) }));
        const validate = () => {
          checkLocks(identity, stateDir, owned, journal!.snapshot.artifacts);
          if (!same(fileFingerprint(file, stateDir), journal!.fingerprint)) blocked();
          for (const artifact of artifacts) {
            const current = fileFingerprint(artifact.target, stateDir);
            const after = afterBytes(artifact, confirmationSha256);
            if (!same(current, artifact.before) && !(after ? current?.sha256 === hash(after) : current === null)) blocked();
          }
          const directory = path.join(stateDir, "execution-outputs", identity.id, "bodies"); assertCleanupPath(directory, stateDir);
          if (fs.existsSync(directory) && fs.readdirSync(directory).some(name => !journal!.snapshot.artifacts.some(artifact => artifact.relative === `execution-outputs/${identity.id}/bodies/${name}`))) blocked();
        };
        hook?.("journal"); validate();
        // Sources and bodies are emptied before the projection stores; no old-source backfill survives.
        const ordered = [...artifacts].sort((a, b) => Number(a.relative.startsWith("feedback/")) - Number(b.relative.startsWith("feedback/")));
        for (const artifact of ordered) {
          validate();
          if (artifact.after) replaceExact(artifact.target, artifact.before, afterBytes(artifact, confirmationSha256)!, stateDir, confirmationSha256);
          else removeExact(artifact.target, artifact.before, stateDir);
          hook?.(artifact.relative);
        }
        validate();
        for (const artifact of artifacts) {
          const current = fileFingerprint(artifact.target, stateDir), after = afterBytes(artifact, confirmationSha256);
          if (after ? current?.sha256 !== hash(after) : current !== null) blocked();
        }
        removeExact(file, journal.fingerprint, stateDir);
        return { status: "cleaned" as const, workspaceId: identity.id, confirmationSha256, counts: journal.snapshot.counts, notice: WORKSPACE_HISTORY_NOTICE };
      }))));
  } catch (error) {
    if (!journalStarted && !fs.existsSync(journalFile) && error instanceof Error)
      Object.assign(error, { formatNoMutation: true, workspaceId: identity.id, confirmationSha256 });
    throw error;
  }
}
export function workspaceHistoryFormatResult(raw: RoutingWorkspaceIdentity, confirmationSha256: string, stateDir = getStateDir()) {
  const identity = resolveWorkspaceIdentity(raw); hex.parse(confirmationSha256);
  const prior = readJournal(identity, stateDir);
  return { status: prior?.confirmationSha256 === confirmationSha256 ? "pending" as const
    : !prior && readFeedbackStatusState(identity.id, stateDir).historyFormatSha256 === confirmationSha256 ? "cleaned" as const : "not_found" as const,
    workspaceId: identity.id, confirmationSha256, notice: WORKSPACE_HISTORY_NOTICE };
}
