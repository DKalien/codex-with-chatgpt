import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getStateDir } from "../config/paths.js";
import {
  assertCleanupArtifacts,
  cleanupArtifact,
  CommandCleanupError,
  type CleanupArtifact,
  type CommandCleanupTarget,
} from "../command-cleanup/schema.js";
import { assertCleanupPath, readCleanupJournal } from "../command-cleanup/fence.js";
import { withCommandOperation } from "../command-cleanup/fence.js";
import { withEvidenceLock } from "./recovery-evidence.js";
import { abandonmentFile, readAbandonments, pruneAbandonedCommand } from "./abandonment.js";
import { outcomeResolutionFile, readOutcomeResolutions, removeOutcomeResolutionForCommand } from "./outcome-resolution.js";
import { legacyReconciliationFile, readLegacyReconciliations, removeLegacyReconciliationForCommand } from "./legacy-reconciliation.js";
import { legacyRetirementFile, readLegacyRetirements, removeLegacyRetirementForCommand } from "./legacy-retirement.js";
import {
  readReceiptFinalizationAlert,
  readReceiptFinalizationClaim,
  readReceiptFinalizationDraft,
  receiptFinalizationAlertPath,
  receiptFinalizationClaimPath,
  receiptFinalizationDraftPath,
} from "./receipt-finalizer-store.js";
import { desktopId, readDesktop, updateDesktop } from "./store.js";
import { desktopFile } from "./store.js";

const targetSchema = z.object({
  workspaceId: z.string().regex(/^[a-f0-9]{12}$/),
  workspaceRoot: z.string().min(1),
  commandId: desktopId,
  iteration: z.literal(1),
  stateDir: z.string().min(1).optional(),
}).strict();

function parseTarget(raw: CommandCleanupTarget): Required<Omit<CommandCleanupTarget, "stateDir">> & { stateDir: string } {
  const parsed = targetSchema.parse(raw);
  return { ...parsed, stateDir: path.resolve(parsed.stateDir ?? getStateDir()) };
}

function abandonmentArtifactValue(entry: ReturnType<typeof readAbandonments>[number]) {
  // The batch selection digest changes when one member is pruned; these command-owned facts do not.
  return {
    commandId: entry.commandId,
    delivery: entry.delivery,
    confirmationSha256: entry.confirmationSha256,
    abandonedAt: entry.abandonedAt,
    maintenanceThreadId: entry.maintenanceThreadId,
    maintenanceTurnId: entry.maintenanceTurnId,
  };
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLocaleLowerCase("en-US") === b.toLocaleLowerCase("en-US") : a === b;
}

function assertCanonicalStorePath(file: string, stateDir: string, expected: "file" | "directory" = "file"): boolean {
  const root = path.resolve(stateDir);
  const absolute = path.resolve(file);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "Desktop cleanup store path escaped the selected state directory.");
  }
  assertCleanupPath(absolute, root);
  const volumeRoot = path.parse(absolute).root;
  let current = volumeRoot;
  const parts = absolute.slice(volumeRoot.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "Desktop cleanup store path cannot be inspected safely.");
    }
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory()) ||
        (index === parts.length - 1 && (expected === "file" ? !stat.isFile() : !stat.isDirectory()))) {
      throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "Desktop cleanup store path is not a canonical regular path.");
    }
    try {
      if (!samePath(fs.realpathSync(current), current)) {
        throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "Desktop cleanup store path is not canonical.");
      }
    } catch (error) {
      if (error instanceof CommandCleanupError) throw error;
      throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "Desktop cleanup store path cannot be canonicalized.");
    }
  }
  return true;
}

function assertStoreFiles(stateDir: string, files: readonly string[]): void {
  for (const file of files) assertCanonicalStorePath(file, stateDir);
}

function assertDesktopSnapshotIsStable(workspaceId: string, stateDir: string): void {
  const file = desktopFile(workspaceId, stateDir);
  assertStoreFiles(stateDir, [file, `${file}.initialized`]);
  if (fs.existsSync(`${file}.lock`)) {
    throw new CommandCleanupError("COMMAND_CLEANUP_BUSY", "Desktop state is being updated; retry cleanup after its store lock clears.");
  }
  const directory = path.dirname(file);
  if (assertCanonicalStorePath(directory, stateDir, "directory")) {
    const prefix = `${path.basename(file)}.`;
    if (fs.readdirSync(directory).some(name => name.startsWith(prefix) && name.endsWith(".tmp"))) {
      throw new CommandCleanupError("COMMAND_CLEANUP_CORRUPT", "Desktop state has an unfinished atomic update; refusing cleanup.");
    }
  }
}

function assertEvidencePaths(target: ReturnType<typeof parseTarget>): void {
  const { stateDir, workspaceId, commandId } = target;
  assertDesktopSnapshotIsStable(workspaceId, stateDir);
  assertStoreFiles(stateDir, [
    receiptFinalizationDraftPath(stateDir, workspaceId, commandId),
    receiptFinalizationAlertPath(stateDir, workspaceId, commandId),
    receiptFinalizationClaimPath(stateDir, workspaceId, commandId),
    outcomeResolutionFile(workspaceId, stateDir), `${outcomeResolutionFile(workspaceId, stateDir)}.initialized`,
    abandonmentFile(workspaceId, stateDir), `${abandonmentFile(workspaceId, stateDir)}.initialized`,
    legacyReconciliationFile(workspaceId, stateDir), `${legacyReconciliationFile(workspaceId, stateDir)}.initialized`,
    legacyRetirementFile(workspaceId, stateDir), `${legacyRetirementFile(workspaceId, stateDir)}.initialized`,
  ]);
}

function removeExactRegularFile(file: string, stateDir: string): void {
  if (!assertCanonicalStorePath(file, stateDir)) return;
  fs.unlinkSync(file);
}

function listArtifacts(target: ReturnType<typeof parseTarget>): CleanupArtifact[] {
  const { workspaceId, workspaceRoot, commandId, stateDir } = target;
  assertEvidencePaths(target);
  const desktop = readDesktop(workspaceId, stateDir);
  if (desktop && desktop.workspaceRoot !== workspaceRoot) {
    throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "Desktop workspaceRoot changed; refusing command cleanup.");
  }
  const artifacts: CleanupArtifact[] = [];
  const delivery = desktop?.deliveries.find(item => item.commandId === commandId);
  if (delivery) {
    artifacts.push(cleanupArtifact(delivery.lifecycle === "ephemeral" ? "desktop_delivery_ephemeral" : "desktop_delivery_legacy", commandId, delivery));
  }

  const draft = readReceiptFinalizationDraft(stateDir, workspaceId, commandId);
  if (draft) {
    if (draft.workspaceRoot !== workspaceRoot) throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "receipt draft workspaceRoot changed; refusing cleanup.");
    artifacts.push(cleanupArtifact("receipt_draft", commandId, draft));
  }
  const alert = readReceiptFinalizationAlert(stateDir, workspaceId, commandId);
  if (alert) artifacts.push(cleanupArtifact("receipt_alert", commandId, alert));
  const claim = readReceiptFinalizationClaim(stateDir, workspaceId, commandId);
  if (claim) artifacts.push(cleanupArtifact("receipt_claim", commandId, claim));

  const outcome = readOutcomeResolutions(workspaceId, stateDir).find(item => item.commandId === commandId);
  if (outcome) {
    if (outcome.workspaceRoot !== workspaceRoot) throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "outcome resolution workspaceRoot changed; refusing cleanup.");
    artifacts.push(cleanupArtifact("outcome_resolution", commandId, outcome));
  }
  const abandonment = readAbandonments(workspaceId, stateDir).find(item => item.commandId === commandId);
  if (abandonment) artifacts.push(cleanupArtifact("abandonment", commandId, abandonmentArtifactValue(abandonment)));
  const reconciliation = readLegacyReconciliations(workspaceId, stateDir).find(item => item.commandId === commandId);
  if (reconciliation) artifacts.push(cleanupArtifact("legacy_reconciliation", commandId, reconciliation));
  const retirement = readLegacyRetirements(workspaceId, stateDir).find(item => item.commandId === commandId);
  if (retirement) artifacts.push(cleanupArtifact("legacy_retirement", commandId, retirement));
  return artifacts;
}

/** Read-only inventory; the cleanup coordinator owns the lifecycle lock and journal phases. */
export function inspectDesktopCleanupArtifacts(rawTarget: CommandCleanupTarget): CleanupArtifact[] {
  return listArtifacts(parseTarget(rawTarget));
}

function sameArtifacts(left: readonly CleanupArtifact[], right: readonly CleanupArtifact[]): boolean {
  const canonical = (items: readonly CleanupArtifact[]) => JSON.stringify([...items]
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)));
  return canonical(left) === canonical(right);
}

/** Delete only the exact snapshot already fenced in the workspace cleanup journal. */
export function deleteDesktopCleanupArtifacts(rawTarget: CommandCleanupTarget, expected: readonly CleanupArtifact[]): void {
  const target = parseTarget(rawTarget);
  const { workspaceId, workspaceRoot, commandId, stateDir } = target;
  withCommandOperation(workspaceId, commandId, () => {
    const journal = readCleanupJournal(workspaceId, commandId, stateDir);
    if (!journal || journal.workspaceRoot !== workspaceRoot || journal.iteration !== target.iteration ||
        journal.phase === "snapshot_pending" || !sameArtifacts(expected, journal.artifacts)) {
      throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "cleanup journal target/artifact snapshot changed; refusing Desktop deletion.");
    }
    withEvidenceLock(workspaceId, () => {
      const current = listArtifacts(target);
      assertCleanupArtifacts(current, expected);
      const expectedFor = (kind: string) => expected.find(item => item.kind === kind && item.id === commandId);
      const removalKinds = new Set(current.map(item => item.kind));

      if (removalKinds.has("desktop_delivery_ephemeral") || removalKinds.has("desktop_delivery_legacy")) {
        updateDesktop(workspaceId, previous => {
          if (!previous) throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "Desktop state disappeared during cleanup.");
          if (previous.workspaceRoot !== workspaceRoot) {
            throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "Desktop workspaceRoot changed during cleanup.");
          }
          const delivery = previous.deliveries.find(item => item.commandId === commandId);
          if (delivery) {
            const kind = delivery.lifecycle === "ephemeral" ? "desktop_delivery_ephemeral" : "desktop_delivery_legacy";
            const fence = expectedFor(kind);
            if (!fence || cleanupArtifact(kind, commandId, delivery).sha256 !== fence.sha256) {
              throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "Desktop delivery changed during cleanup.");
            }
          }
          return { state: { ...previous, deliveries: previous.deliveries.filter(item => item.commandId !== commandId) }, result: undefined };
        }, stateDir);
      }

      const draft = readReceiptFinalizationDraft(stateDir, workspaceId, commandId);
      if (draft) {
        const fence = expectedFor("receipt_draft");
        if (!fence || cleanupArtifact("receipt_draft", commandId, draft).sha256 !== fence.sha256) {
          throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "receipt draft changed during cleanup.");
        }
        removeExactRegularFile(receiptFinalizationDraftPath(stateDir, workspaceId, commandId), stateDir);
      }
      const alert = readReceiptFinalizationAlert(stateDir, workspaceId, commandId);
      if (alert) {
        const fence = expectedFor("receipt_alert");
        if (!fence || cleanupArtifact("receipt_alert", commandId, alert).sha256 !== fence.sha256) {
          throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "receipt alert changed during cleanup.");
        }
        removeExactRegularFile(receiptFinalizationAlertPath(stateDir, workspaceId, commandId), stateDir);
      }
      const claim = readReceiptFinalizationClaim(stateDir, workspaceId, commandId);
      if (claim) {
        const fence = expectedFor("receipt_claim");
        if (!fence || cleanupArtifact("receipt_claim", commandId, claim).sha256 !== fence.sha256) {
          throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "receipt claim changed during cleanup.");
        }
        removeExactRegularFile(receiptFinalizationClaimPath(stateDir, workspaceId, commandId), stateDir);
      }

      if (removalKinds.has("outcome_resolution")) removeOutcomeResolutionForCommand(workspaceId, commandId, stateDir);
      if (removalKinds.has("abandonment")) pruneAbandonedCommand(workspaceId, commandId, stateDir);
      if (removalKinds.has("legacy_reconciliation")) removeLegacyReconciliationForCommand(workspaceId, commandId, stateDir);
      if (removalKinds.has("legacy_retirement")) removeLegacyRetirementForCommand(workspaceId, commandId, stateDir);

      if (listArtifacts(target).length !== 0) {
        throw new CommandCleanupError("COMMAND_CLEANUP_IDENTITY_CHANGED", "Desktop cleanup left or recreated an artifact; cleanup remains fenced.");
      }
    }, stateDir);
  }, stateDir, true);
}
