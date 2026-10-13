import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { getStateDir } from "../config/paths.js";
import { resolveWorkspaceIdentity, readRouting, type RoutingWorkspaceIdentity } from "../routing/store.js";
import { listResultOutboxEntries, listResultReconciliationNeeded } from "../routing/result-outbox-store.js";
import { readDesktop } from "../desktop/store.js";
import { readAbandonments } from "../desktop/abandonment.js";
import { readLegacyRetirements } from "../desktop/legacy-retirement.js";
import { readOutcomeResolutions } from "../desktop/outcome-resolution.js";
import { readLegacyReconciliations } from "../desktop/legacy-reconciliation.js";
import { listResultBusCutoverDispositions } from "../result-bus/cutover-store.js";
import { readResultBus } from "../result-bus/store.js";
import { readExecutorDispatchState } from "../executor-control/dispatch-store.js";
import { readExecutionRecordsStrict, withExecutionRecordsLock } from "../execution/records.js";
import { assertExecutionArtifactPath, readExecutionOutputIndexLocked, readExecutionOutputIndexStrict, withOutputLock } from "../execution/output.js";
import { feedbackStateFile, readFeedbackStatusState, withFeedbackLock } from "../feedback/state-store.js";
import { withDeliveryArbiter } from "../bridge/delivery-arbiter.js";
import { assertCleanupPath, withWorkspaceCleanupOperation } from "./fence.js";
import { CommandCleanupError } from "./schema.js";
import { legacyHistoryJournalFile, withLegacyHistoryOwner } from "./legacy-history-fence.js";

const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const hex = z.string().regex(/^[a-f0-9]{64}$/);
export const fingerprintSchema = z.object({ dev: z.string(), ino: z.string(), size: z.number().int().nonnegative(),
  mtime: z.string(), ctime: z.string(), sha256: hex }).strict();
type Fingerprint = z.infer<typeof fingerprintSchema>;
const snapshotSchema = z.object({ version: z.literal(1), workspaceId: z.string().regex(/^[a-f0-9]{12}$/), workspaceRoot: z.string().min(1),
  records: fingerprintSchema.nullable(), recordCount: z.number().int().nonnegative(),
  index: fingerprintSchema.nullable(), outputCount: z.number().int().min(0).max(40), nextId: z.number().int().positive().safe(), retentionThrough: z.number().int().positive().safe().optional(),
  bodies: z.array(z.object({ id: z.number().int().positive().safe(), fingerprint: fingerprintSchema }).strict()).max(40),
  feedback: fingerprintSchema.nullable(), feedbackAfterSha256: hex.nullable(), cursor: z.number().int().nonnegative(),
}).strict();
const journalSchema = z.object({ version: z.literal(1), snapshot: snapshotSchema, confirmationSha256: hex }).strict()
  .refine(j => digest(JSON.stringify(j.snapshot)) === j.confirmationSha256);
type Snapshot = z.infer<typeof snapshotSchema>;
export const LEGACY_HISTORY_NOTICE = "永久删除本工作区预览中的旧执行记录与输出，重置相应投影游标；保留连接与配对，不撤回外部消息、不证明执行成功、不自动重发。";
type Stage = "journal" | "records" | "bodies" | "index" | "feedback";
function fail(code = "LEGACY_HISTORY_CONFLICT"): never {
  throw new CommandCleanupError(code, "旧记录清理证据不匹配或仍有活动数据；保留现状，不能强行清空。");
}
export function fileFingerprint(file: string, stateDir: string): Fingerprint | null {
  assertCleanupPath(file, stateDir);
  if (!assertExecutionArtifactPath(file, stateDir, "file")) return null;
  const before = fs.lstatSync(file, { bigint: true });
  if (before.nlink !== 1n || path.resolve(fs.realpathSync(file)).toLowerCase() !== path.resolve(file).toLowerCase()) fail();
  const sha256 = digest(fs.readFileSync(file));
  const after = fs.lstatSync(file, { bigint: true });
  for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const) if (before[key] !== after[key]) fail();
  return { dev: String(after.dev), ino: String(after.ino), size: Number(after.size), mtime: String(after.mtimeNs), ctime: String(after.ctimeNs), sha256 };
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function paths(identity: RoutingWorkspaceIdentity, stateDir: string) {
  return { records: path.join(stateDir, "executions", `${identity.id}.jsonl`),
    index: path.join(stateDir, "execution-outputs", identity.id, "index.json"),
    bodies: path.join(stateDir, "execution-outputs", identity.id, "bodies"),
    feedback: feedbackStateFile(identity.id, stateDir), journal: legacyHistoryJournalFile(identity.id, stateDir) };
}
function assertQuiescent(identity: RoutingWorkspaceIdentity, stateDir: string): void {
  const routing = readRouting(identity, stateDir), desktop = readDesktop(identity.id, stateDir);
  const feedback = readFeedbackStatusState(identity.id, stateDir);
  const dispatch = readExecutorDispatchState(identity.id, stateDir);
  if ((desktop && desktop.workspaceRoot !== identity.root) || (dispatch && dispatch.workspaceRoot !== identity.root)) fail();
  if (desktop?.deliveries.length || routing?.commands.length || routing?.results.length ||
      readResultBus(identity, stateDir)?.entries.length || dispatch?.entries.length || feedback.events.length || feedback.cleanupAdjustments?.length) fail("LEGACY_HISTORY_NOT_QUIESCENT");
  if (readAbandonments(identity.id, stateDir).length || readLegacyRetirements(identity.id, stateDir).length ||
      readOutcomeResolutions(identity.id, stateDir).length || readLegacyReconciliations(identity.id, stateDir).length ||
      listResultBusCutoverDispositions(identity, stateDir).length) fail("LEGACY_HISTORY_NOT_QUIESCENT");
  if (listResultOutboxEntries(identity, stateDir).length || listResultReconciliationNeeded(identity, stateDir).length) fail("LEGACY_HISTORY_NOT_QUIESCENT");
  const directories = [path.join(stateDir, "command-cleanup", identity.id),
    ...["drafts", "claims", "alerts"].map(k => path.join(stateDir, "desktop-receipt-finalization", k))];
  for (const [index, directory] of directories.entries()) {
    assertCleanupPath(directory, stateDir);
    if (!fs.existsSync(directory)) continue;
    if (fs.readdirSync(directory).some(name => index === 0 || name.startsWith(`${identity.id}-`))) fail("LEGACY_HISTORY_NOT_QUIESCENT");
  }
}
function readJournal(identity: RoutingWorkspaceIdentity, stateDir: string) {
  const file = legacyHistoryJournalFile(identity.id, stateDir), fingerprint = fileFingerprint(file, stateDir);
  if (!fingerprint) return null;
  try {
    const journal = journalSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (journal.snapshot.workspaceId !== identity.id || journal.snapshot.workspaceRoot !== identity.root ||
        !same(fileFingerprint(file, stateDir), fingerprint)) fail();
    return { ...journal, fingerprint };
  } catch { return fail("LEGACY_HISTORY_JOURNAL_CORRUPT"); }
}
function snapshot(identity: RoutingWorkspaceIdentity, stateDir: string, locked = false): Snapshot {
  assertQuiescent(identity, stateDir);
  const p = paths(identity, stateDir);
  const records = fileFingerprint(p.records, stateDir), index = fileFingerprint(p.index, stateDir), feedback = fileFingerprint(p.feedback, stateDir);
  const entries = readExecutionRecordsStrict(identity.id, stateDir);
  const output = locked ? readExecutionOutputIndexLocked(identity.id, stateDir) : readExecutionOutputIndexStrict(identity.id, stateDir);
  const receiver = readFeedbackStatusState(identity.id, stateDir);
  if (receiver.projectionCursor > entries.length) fail();
  const bodies = output.items.filter(item => item.allowed && item.sizeBytes > 0).map(item => {
    const fingerprint = fileFingerprint(path.join(p.bodies, `${item.id}.txt`), stateDir); if (!fingerprint) fail();
    if (fingerprint.size !== item.sizeBytes) fail();
    return { id: item.id, fingerprint };
  });
  assertCleanupPath(p.bodies, stateDir);
  if (fs.existsSync(p.bodies) && !same(fs.readdirSync(p.bodies).sort(), bodies.map(b => `${b.id}.txt`).sort())) fail();
  for (const [file, expected] of [[p.records, records], [p.index, index], [p.feedback, feedback]] as const)
    if (!same(fileFingerprint(file, stateDir), expected)) fail();
  return snapshotSchema.parse({ version: 1, workspaceId: identity.id, workspaceRoot: identity.root,
    records, recordCount: entries.length, index, outputCount: output.items.length, nextId: output.nextId, ...(output.retentionThrough ? { retentionThrough: output.retentionThrough } : {}), bodies, feedback,
    feedbackAfterSha256: feedback ? digest(JSON.stringify({ ...receiver, projectionCursor: 0 }, null, 2)) : null, cursor: receiver.projectionCursor });
}
export function previewLegacyHistoryCleanup(raw: RoutingWorkspaceIdentity, stateDir = getStateDir()) {
  const identity = resolveWorkspaceIdentity(raw); stateDir = path.resolve(stateDir);
  const prior = readJournal(identity, stateDir), value = prior?.snapshot ?? snapshot(identity, stateDir);
  const present = !!prior || value.recordCount > 0 || value.outputCount > 0;
  return { status: prior ? "pending" as const : present ? "preview" as const : "not_found" as const,
    workspaceId: identity.id, records: value.recordCount, outputs: value.outputCount,
    confirmationSha256: present ? digest(JSON.stringify(value)) : null, notice: LEGACY_HISTORY_NOTICE };
}
/** Fixed paths only. A completed replacement may be replayed; altered/replaced source is never deleted. */
export function removeExact(file: string, expected: Fingerprint | null, stateDir: string) {
  const current = fileFingerprint(file, stateDir);
  if (!current) return;
  if (!same(current, expected)) fail();
  fs.unlinkSync(file);
}
export function replaceExact(file: string, expected: Fingerprint | null, after: string, stateDir: string, confirmation: string) {
  const current = fileFingerprint(file, stateDir), afterDigest = digest(after);
  const temporary = `${file}.${confirmation}.legacy-tmp`;
  const pending = fileFingerprint(temporary, stateDir);
  if (pending && pending.sha256 !== afterDigest) fail();
  if (current?.sha256 === afterDigest) { if (pending) removeExact(temporary, pending, stateDir); return; }
  if (!same(current, expected)) fail();
  if (!pending) {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, after); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  if (!same(fileFingerprint(file, stateDir), expected) || fileFingerprint(temporary, stateDir)?.sha256 !== afterDigest) fail();
  fs.renameSync(temporary, file);
}
/** Arbiter -> workspace cleanup -> records -> output -> Feedback. No endpoint/store lock is held before the outer fences. */
export function confirmLegacyHistoryCleanup(raw: RoutingWorkspaceIdentity, confirmation: string, stateDir = getStateDir(), hook?: (stage: Stage) => void) {
  const identity = resolveWorkspaceIdentity(raw); stateDir = path.resolve(stateDir);
  if (!hex.safeParse(confirmation).success) fail("COMMAND_CLEANUP_CONFIRMATION_MISMATCH");
  // Read-only gate first, including unsafe paths, before any lock directories are created.
  const preview = previewLegacyHistoryCleanup(identity, stateDir);
  if (preview.confirmationSha256 !== confirmation) fail("COMMAND_CLEANUP_CONFIRMATION_MISMATCH");
  return withDeliveryArbiter({ workspaceId: identity.id, workspaceRoot: identity.root, stateDir }, () =>
    withLegacyHistoryOwner(identity.id, stateDir, () => withWorkspaceCleanupOperation(identity.id, stateDir, () =>
      withExecutionRecordsLock(identity.id, () => withOutputLock(identity.id, () => withFeedbackLock(identity.id, stateDir, read => {
        const p = paths(identity, stateDir);
        let journal = readJournal(identity, stateDir);
        assertQuiescent(identity, stateDir);
        if (!journal) {
          const value = snapshot(identity, stateDir, true);
          if (digest(JSON.stringify(value)) !== confirmation) fail("COMMAND_CLEANUP_CONFIRMATION_MISMATCH");
          fs.mkdirSync(path.dirname(p.journal), { recursive: true, mode: 0o700 }); assertCleanupPath(p.journal, stateDir);
          const fd = fs.openSync(p.journal, "wx", 0o600);
          try { fs.writeFileSync(fd, JSON.stringify({ version: 1, snapshot: value, confirmationSha256: confirmation })); fs.fsyncSync(fd); }
          finally { fs.closeSync(fd); }
          journal = readJournal(identity, stateDir)!;
        }
        if (journal.confirmationSha256 !== confirmation) fail();
        const value = journal.snapshot;
        const indexAfter = JSON.stringify({ nextId: value.nextId,
          ...(value.retentionThrough ? { retentionThrough: value.retentionThrough } : {}), items: [] });
        const validate = () => {
          if (!same(fileFingerprint(p.journal, stateDir), journal!.fingerprint)) fail();
          assertQuiescent(identity, stateDir);
          // Validate every remaining source before any additional destructive step.
          for (const [file, original, after] of [[p.records, value.records, null],
            [p.index, value.index, value.index ? digest(indexAfter) : null],
            [p.feedback, value.feedback, value.feedbackAfterSha256],
            ...value.bodies.map(b => [path.join(p.bodies, `${b.id}.txt`), b.fingerprint, null] as const)] as const) {
            const current = fileFingerprint(file, stateDir);
            if (!same(current, original) && !(after ? current?.sha256 === after : current === null)) fail();
            if (after) {
              const temporary = fileFingerprint(`${file}.${confirmation}.legacy-tmp`, stateDir);
              if (temporary && temporary.sha256 !== after) fail();
            }
          }
          if (fs.existsSync(p.bodies) && fs.readdirSync(p.bodies).some(name => !value.bodies.some(b => name === `${b.id}.txt`))) fail();
        };
        hook?.("journal");
        validate();
        removeExact(p.records, value.records, stateDir); hook?.("records");
        validate();
        for (const body of value.bodies) removeExact(path.join(p.bodies, `${body.id}.txt`), body.fingerprint, stateDir);
        hook?.("bodies");
        validate();
        if (value.index) replaceExact(p.index, value.index, indexAfter, stateDir, confirmation);
        hook?.("index");
        validate();
        if (value.feedback) {
          const feedback = read(); if (!feedback) fail();
          const after = JSON.stringify({ ...feedback, projectionCursor: 0 }, null, 2);
          if (digest(after) !== value.feedbackAfterSha256) fail();
          replaceExact(p.feedback, value.feedback, after, stateDir, confirmation);
        }
        hook?.("feedback");
        validate();
        if (fileFingerprint(p.records, stateDir) || readExecutionOutputIndexLocked(identity.id, stateDir).items.length ||
            (fs.existsSync(p.bodies) && fs.readdirSync(p.bodies).length) || (read()?.projectionCursor ?? 0) !== 0) fail();
        removeExact(p.journal, journal.fingerprint, stateDir);
        return { status: "cleaned" as const, workspaceId: identity.id, records: value.recordCount, outputs: value.outputCount };
      }), stateDir), stateDir))));
}
