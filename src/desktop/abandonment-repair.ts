import { isDeepStrictEqual } from "node:util";
import { Workspace } from "../workspace/manager.js";
import { getStateDir } from "../config/paths.js";
import { assertNoCommandOperationInherited, withCommandOperationAsync, withRepairedCommandOperation } from "../command-cleanup/fence.js";
import { assertMaintenanceHandle, MaintenanceBusyError, releaseMaintenanceOrThrow, tryAcquireMaintenanceLock,
  type MaintenanceLockHandle } from "../core/maintenance-lock.js";
import { acquireAbandonmentRepair, inspectRepair, repairAssert, repairDigest, repairProofSchema,
  type RepairOptions, type RepairProof } from "../command-cleanup/abandonment-repair-store.js";
import { abandonHistoricalAccepted, validateRepairAbandonment, readAbandonments, type AbandonmentWorkspace } from "./abandonment.js";
import { desktopIpc } from "./ipc.js";
import { listResultBusEntries } from "../result-bus/store.js";
import { listResultOutboxEntries } from "../routing/result-outbox-store.js";
import { readRouting } from "../routing/store.js";
import { readReceiptFinalizationDraft, readReceiptFinalizationClaim, readReceiptFinalizationAlert } from "./receipt-finalizer-store.js";

const NOTICE = "仅对明确历史 ownerless 投递作行政损坏恢复；不证明旧锁 owner 已死亡，不代表执行完成或成功。";
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function selection(workspace: AbandonmentWorkspace, commandIds: readonly string[], repairCommandIds: readonly string[]) {
  const exact = new Workspace(workspace.root);
  repairAssert(exact.id === workspace.id && exact.root === workspace.root);
  for (const ids of [commandIds, repairCommandIds]) repairAssert(Array.isArray(ids) && ids.length > 0 && ids.length <= 100 &&
    new Set(ids).size === ids.length && ids.every(x => /^[A-Za-z0-9_-]{1,128}$/.test(x)));
  repairAssert(repairCommandIds.length <= 10 && repairCommandIds.every(x => commandIds.includes(x)));
  return { commandIds: [...commandIds].sort(), repairCommandIds: [...repairCommandIds].sort() };
}
function noResultAuthority(workspace: AbandonmentWorkspace, ids: string[]): void {
  const state = getStateDir();
  repairAssert(!listResultBusEntries(workspace).some(x => ids.includes(x.commandId)) &&
    !listResultOutboxEntries(workspace).some(x => ids.includes(x.commandId)) &&
    !readRouting(workspace)?.results.some(x => ids.includes(x.commandId)));
  for (const id of ids) repairAssert(!readReceiptFinalizationDraft(state, workspace.id, id) &&
    !readReceiptFinalizationClaim(state, workspace.id, id) && !readReceiptFinalizationAlert(state, workspace.id, id));
}
async function ownerless(facts: Awaited<ReturnType<typeof validateRepairAbandonment>>, repairIds: string[], root: string): Promise<void> {
  repairAssert(facts.runtimeFence);
  const threads = new Set(facts.deliveries.filter(x => repairIds.includes(x.commandId)).map(x => x.threadId));
  for (const threadId of threads) {
    repairAssert(threadId !== facts.binding.threadId);
    let code: string | undefined;
    try { await desktopIpc.inspect({ threadId, hostId: facts.binding.hostId, projectId: facts.binding.projectId, workspaceRoot: root }, facts.runtimeFence); }
    catch (e) { code = (e as { code?: string }).code; }
    repairAssert(code === "DESKTOP_NO_OWNER");
  }
}
function matchProof(proof: RepairProof, facts: Awaited<ReturnType<typeof validateRepairAbandonment>>): void {
  repairAssert(proof.confirmationSha256 === facts.confirmationSha256 && proof.bindingSha256 === facts.bindingSha256 &&
    proof.deliveriesSha256 === facts.deliveriesSha256 && proof.contextSha256 === facts.contextSha256 && isDeepStrictEqual(proof.commandIds, facts.commandIds));
}

/** Zero-write preview. Caller saves the bounded proof; timestamps are covered by its second digest. */
export async function previewCorruptLockAbandonment(workspace: AbandonmentWorkspace, commands: readonly string[], repairs: readonly string[], options: RepairOptions = {}) {
  const selected = selection(workspace, commands, repairs);
  const observedAt = new Date().toISOString();
  const first = await Promise.all(selected.repairCommandIds.map(id => inspectRepair(workspace.id, id, options)));
  const existing = first.find(x => x.proof)?.proof;
  if (existing) repairAssert(existing.workspaceRoot === workspace.root && isDeepStrictEqual(existing.commandIds, selected.commandIds) &&
    isDeepStrictEqual(existing.repairCommandIds, selected.repairCommandIds) && first.every((x, i) => x.proof ? isDeepStrictEqual(x.proof, existing) :
      isDeepStrictEqual(x.fingerprint, existing.observations[i]!.fingerprint)));
  const before = await validateRepairAbandonment(workspace, selected.commandIds, existing?.confirmationSha256);
  noResultAuthority(workspace, selected.repairCommandIds);
  await ownerless(before, selected.repairCommandIds, workspace.root);
  await (options.sleep ?? sleep)(150);
  await ownerless(before, selected.repairCommandIds, workspace.root);
  const after = await validateRepairAbandonment(workspace, selected.commandIds, before.confirmationSha256);
  repairAssert(before.contextSha256 === after.contextSha256);
  noResultAuthority(workspace, selected.repairCommandIds);
  const second = await Promise.all(selected.repairCommandIds.map(id => inspectRepair(workspace.id, id, options)));
  repairAssert(isDeepStrictEqual(first, second));
  const proof = existing ?? repairProofSchema.parse({ version: 1, workspaceId: workspace.id, workspaceRoot: workspace.root, ...selected,
    confirmationSha256: before.confirmationSha256, bindingSha256: before.bindingSha256, deliveriesSha256: before.deliveriesSha256, contextSha256: before.contextSha256,
    observations: selected.repairCommandIds.map((commandId, i) => ({ commandId, fingerprint: first[i]!.fingerprint,
      observedAt, confirmedAt: new Date().toISOString(), reason: "ZERO_BYTE_OWNER_UNKNOWN" })) });
  matchProof(proof, after);
  return { commandIds: selected.commandIds, repairCommandIds: selected.repairCommandIds, confirmationSha256: proof.confirmationSha256,
    repairConfirmationSha256: repairDigest(proof), proof, notice: NOTICE };
}

/** One sorted lifecycle transaction; neither the repair fence nor adopted lock is released on pending failure. */
export async function confirmCorruptLockAbandonment(workspace: AbandonmentWorkspace, commands: readonly string[], repairs: readonly string[],
  proofRaw: unknown, confirmationSha256: string, repairConfirmationSha256: string, options: RepairOptions = {}) {
  const selected = selection(workspace, commands, repairs), proof = repairProofSchema.parse(proofRaw);
  repairAssert(proof.workspaceId === workspace.id && proof.workspaceRoot === workspace.root &&
    isDeepStrictEqual(proof.commandIds, selected.commandIds) && isDeepStrictEqual(proof.repairCommandIds, selected.repairCommandIds) &&
    confirmationSha256 === proof.confirmationSha256 && repairConfirmationSha256 === repairDigest(proof));
  // Global order: machine maintenance -> sorted command authorities -> abandonment evidence/store locks.
  assertNoCommandOperationInherited();
  const acquired = tryAcquireMaintenanceLock(getStateDir(), "desktop-abandonment-repair");
  if (!acquired.ok) throw new MaintenanceBusyError();
  let actionError: unknown;
  try { return await confirmUnderMaintenance(workspace, selected, proof, confirmationSha256, repairConfirmationSha256, acquired.handle, options); }
  catch (error) { actionError = error; throw error; }
  finally { releaseMaintenanceOrThrow(acquired.handle, { actionError }); }
}

async function confirmUnderMaintenance(workspace: AbandonmentWorkspace, selected: ReturnType<typeof selection>, proof: RepairProof,
  confirmationSha256: string, repairConfirmationSha256: string, maintenance: MaintenanceLockHandle, options: RepairOptions) {
  const assertMaintenance = () => assertMaintenanceHandle(getStateDir(), maintenance);
  assertMaintenance();
  const initial = await validateRepairAbandonment(workspace, selected.commandIds, confirmationSha256);
  matchProof(proof, initial); noResultAuthority(workspace, selected.repairCommandIds);
  await ownerless(initial, selected.repairCommandIds, workspace.root);
  await (options.sleep ?? sleep)(150);
  await ownerless(initial, selected.repairCommandIds, workspace.root);
  const revalidate = async () => {
    assertMaintenance();
    const fresh = await validateRepairAbandonment(workspace, selected.commandIds, confirmationSha256);
    matchProof(proof, fresh); repairAssert(fresh.contextSha256 === initial.contextSha256);
    noResultAuthority(workspace, selected.repairCommandIds); await ownerless(fresh, selected.repairCommandIds, workspace.root);
  };
  const inspections = await Promise.all(selected.repairCommandIds.map(id => inspectRepair(workspace.id, id, options)));
  repairAssert(inspections.every((x, i) => x.proof ? isDeepStrictEqual(x.proof, proof) : isDeepStrictEqual(x.fingerprint, proof.observations[i]!.fingerprint)));
  if (inspections.some(x => x.completed)) {
    const batch = readAbandonments(workspace.id).filter(x => selected.commandIds.includes(x.commandId));
    repairAssert(initial.prior?.confirmationSha256 === confirmationSha256 && batch.length === selected.commandIds.length &&
      inspections.every(x => !x.completed || x.batchSha256 === repairDigest(batch)));
  }
  if (inspections.every(x => x.completed && !x.fence)) {
    repairAssert(initial.prior?.confirmationSha256 === confirmationSha256);
    return { status: "already_abandoned" as const, ...selected, confirmationSha256, repairConfirmationSha256, notice: NOTICE };
  }
  const owned: Awaited<ReturnType<typeof acquireAbandonmentRepair>>[] = [];
  const run = async (index: number): Promise<Awaited<ReturnType<typeof abandonHistoricalAccepted>>> => {
    if (index === selected.commandIds.length) {
      await revalidate();
      options.checkpoint?.("before_abandonment_write", selected.repairCommandIds[0]!);
      assertMaintenance();
      const result = await abandonHistoricalAccepted(workspace, selected.commandIds, confirmationSha256);
      options.checkpoint?.("after_abandonment_write", selected.repairCommandIds[0]!);
      const batch = readAbandonments(workspace.id).filter(x => selected.commandIds.includes(x.commandId));
      repairAssert(batch.length === selected.commandIds.length && batch.every(x => x.confirmationSha256 === confirmationSha256));
      for (const authority of owned) authority.complete(repairDigest(batch));
      return result;
    }
    const commandId = selected.commandIds[index]!;
    if (!selected.repairCommandIds.includes(commandId)) return withCommandOperationAsync(workspace.id, commandId, () => run(index + 1));
    const inspected = inspections[selected.repairCommandIds.indexOf(commandId)]!;
    // A completed member from a previous partial release needs no new destructive authority.
    if (inspected.completed && !inspected.fence) return withCommandOperationAsync(workspace.id, commandId, () => run(index + 1));
    const authority = await acquireAbandonmentRepair(proof, commandId, revalidate, maintenance, options); owned.push(authority);
    return withRepairedCommandOperation(workspace.id, commandId, authority.capability, () => run(index + 1));
  };
  try {
    const result = await run(0);
    for (const authority of [...owned].reverse()) authority.release();
    return { ...result, repairCommandIds: selected.repairCommandIds, repairConfirmationSha256, notice: NOTICE };
  } finally { for (const authority of owned) authority.invalidate(); }
}
