import { readExecutorDispatchState } from "../executor-control/dispatch-store.js";
import { readRemote, controllerOnline } from "../remote/store.js";
import { isOfficialResult } from "../result-bus/official-result.js";
import { authenticateOperations as authenticate } from "./companion-operation-auth.js";
import { readPanelAuthorization } from "../feedback/panel.js";
import { readFeedbackState } from "../feedback/state-store.js";
import { readRouting } from "../routing/store.js";
import { canCancelMailbox } from "../routing/schema.js";
import { readDesktop } from "../desktop/store.js";
import { inspectDesktopBinding } from "../desktop/binding-inspection.js";
import { projectDesktopActivity } from "../executor/index.js";
import { listResultBusEntries } from "../result-bus/store.js";
import { resultBusCompanionDeliveryId } from "./result-bus-delivery.js";
import { areChatgptConversationRoutesEquivalent } from "../chatgpt/route.js";
import { executorStatus, readActiveExecutorBinding } from "../executor-control/service.js";
import { CompanionError } from "../feedback/companion-common.js";
import type { ExecutorStatusProjection } from "../executor-control/schema.js";
import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "../config/paths.js";
import { assertCleanupPath, cleanupJournalFile, readCleanupJournal } from "../command-cleanup/fence.js";
import { readAbandonments } from "../desktop/abandonment.js";
import { readOutcomeResolutions } from "../desktop/outcome-resolution.js";
import { readLegacyRetirements } from "../desktop/legacy-retirement.js";
import { isTrustedDesktopReceipt, readExecutionRecordsStrict } from "../execution/records.js";


function groupByCommand<T extends { commandId: string }>(items: readonly T[]) {
  const groups = new Map<string, T[]>();
  for (const item of items) { const group = groups.get(item.commandId) ?? []; group.push(item); groups.set(item.commandId, group); }
  return groups;
}

function cleanupInventory(workspaceId: string, stateDir: string) {
  const directory = path.dirname(cleanupJournalFile(workspaceId, "probe", stateDir));
  assertCleanupPath(directory, stateDir);
  try { return [...new Set(fs.readdirSync(directory).flatMap(name => {
    const match = /^([A-Za-z0-9_-]{1,128})\.json(?:$|\.lock(?:$|\.)|\..*\.tmp$)/.exec(name);
    return match ? [match[1]!] : [];
  }))]; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

function lifecycleDiagnostics(workspaceId: string, commandId: string, stateDir: string) {
  const issues: string[] = [];
  try {
    if (readCleanupJournal(workspaceId, commandId, stateDir)) issues.push("cleanup_pending");
    const file = cleanupJournalFile(workspaceId, commandId, stateDir);
    for (const suffix of [".lock", ".lock.repair", ".lock.repair.reclaim", ".lock.repair.tmp"]) {
      const target = `${file}${suffix}`;
      assertCleanupPath(target, stateDir);
      try {
        const stat = fs.lstatSync(target);
        if (!stat.isFile() || stat.nlink !== 1) issues.push("lifecycle_state_unreadable");
        else issues.push(suffix === ".lock" ? (stat.size === 0 ? "empty_lifecycle_lock" : "lifecycle_lock_present") : "repair_fence_present");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  } catch { issues.push("lifecycle_state_unreadable"); }
  return [...new Set(issues)];
}

/** Authenticated metadata projection. No reconciliation, lifecycle locks, repair or history cache. */
export async function readCompanionOperations(input: {
  workspaceId: string; workspaceRoot: string; credential: string; stateDir?: string;
}, inspect: typeof executorStatus = executorStatus) {
  const { auth, ctx } = authenticate(input);
  const stateDir = input.stateDir ?? getStateDir();
  const identity = { id: input.workspaceId, root: input.workspaceRoot };
  const remote = readRemote(identity.id, stateDir);
  if (remote && remote.workspaceRoot !== identity.root) throw new CompanionError("COMPANION_WORKSPACE_MISMATCH", "official workspace 身份不一致。");
  const desktopSnapshot = readDesktop(identity.id, stateDir);
  if (desktopSnapshot && desktopSnapshot.workspaceRoot !== identity.root) {
    throw new CompanionError("COMPANION_WORKSPACE_MISMATCH", "workspace 身份不一致。");
  }
  const desktopBinding = !remote?.enabled && desktopSnapshot?.enabled ? desktopSnapshot.binding : null;
  const officialMode = remote?.deliveryMode === "official" && !desktopBinding;
  let endpoint: ExecutorStatusProjection;
  try {
    if (desktopBinding) {
      const session = await inspectDesktopBinding(identity, desktopBinding, desktopSnapshot!.runtimeFence);
      endpoint = { workspaceId: identity.id, activeBinding: null, plugins: [],
        availability: { available: true }, activity: projectDesktopActivity(session) };
    } else endpoint = officialMode
    ? { workspaceId: identity.id, activeBinding: null, plugins: [], availability: { available: false, reasonCode: "official_mode", message: "Official App Server" } }
    : await inspect(identity.id, identity.root); }
  catch { endpoint = { workspaceId: identity.id, activeBinding: null, plugins: [],
    availability: { available: false, reasonCode: "inspect_failed", message: "无法核验" } }; }
  // IPC awaits may race a re-pair/rebind. Never return old-scope observations to a new caller.
  if (JSON.stringify(authenticate(input)) !== JSON.stringify({ auth, ctx })) {
    throw new CompanionError("COMPANION_EPOCH_STALE", "查询期间连接身份改变；请刷新。");
  }
  const routing = readRouting(identity, input.stateDir);
  const desktop = readDesktop(identity.id, input.stateDir);
  if (desktop && desktop.workspaceRoot !== identity.root) {
    throw new CompanionError("COMPANION_WORKSPACE_MISMATCH", "workspace 身份不一致。");
  }
  const latestRemote = readRemote(identity.id, stateDir);
  if (latestRemote && latestRemote.workspaceRoot !== identity.root) throw new CompanionError("COMPANION_WORKSPACE_MISMATCH", "official workspace 身份不一致。");
  const modeStable = remote?.enabled === latestRemote?.enabled && remote?.deliveryMode === latestRemote?.deliveryMode;
  const bindingStable = modeStable && JSON.stringify(desktopSnapshot) === JSON.stringify(desktop)
    && (!!desktopBinding || officialMode
      || JSON.stringify(readActiveExecutorBinding(identity.id, identity.root)) === JSON.stringify(endpoint.activeBinding));
  const feedback = readFeedbackState(identity.id, input.stateDir);
  const pendingPanelCommandIds = new Set((feedback.panelOperations ?? [])
    .filter(operation => operation.status === "pending").map(operation => operation.commandId));
  // Current-command transport stores the authenticated principal fingerprint as planner identity,
  // never a caller-supplied URL or a guessed timestamp/body match.
  const plannerIds = new Set(routing?.routes.filter(route => route.role === "planner"
    && route.platform === "chatgpt_web" && route.conversationId === ctx.principalFingerprint
    && Object.keys(route.locator).length === 0).map(route => route.routeId));
  const commands = routing?.commands ?? [];
  const bus = listResultBusEntries(identity, input.stateDir);
  const dispatchState = readExecutorDispatchState(identity.id, stateDir);
  if (dispatchState && dispatchState.workspaceRoot !== identity.root) throw new CompanionError("COMPANION_WORKSPACE_MISMATCH", "dispatch workspace 身份不一致。");
  const dispatches = dispatchState?.entries ?? [];
  const records = readExecutionRecordsStrict(identity.id, stateDir).filter(record => record.commandId != null);
  const abandoned = readAbandonments(identity.id, stateDir);
  const retired = readLegacyRetirements(identity.id, stateDir);
  const resolved = readOutcomeResolutions(identity.id, stateDir);
  const ids = [...new Set([...commands, ...dispatches, ...(desktop?.deliveries ?? []), ...feedback.events, ...bus,
    ...abandoned, ...retired, ...resolved, ...(remote?.tasks ?? [])].map(item => item.commandId).concat(records.map(record => record.commandId!), cleanupInventory(identity.id, stateDir)))];
  const commandMap = new Map(commands.map(command => [command.commandId, command]));
  const deliveryMap = new Map(desktop?.deliveries.map(delivery => [delivery.commandId, delivery]));
  const resultMap = groupByCommand(routing?.results ?? []);
  const eventMap = groupByCommand(feedback.events);
  const busMap = groupByCommand(bus);
  const recordsMap = groupByCommand(records.map(record => ({ ...record, commandId: record.commandId! })));
  const abandonedIds = new Set(abandoned.map(item => item.commandId)), retiredIds = new Set(retired.map(item => item.commandId)), resolvedIds = new Set(resolved.map(item => item.commandId));
  const rows = ids.map(commandId => {
    const official = remote?.tasks.find(task => task.commandId === commandId);
    const command = commandMap.get(commandId);
    const dispatch = dispatches.find(item => item.commandId === commandId);
    const candidate = deliveryMap.get(commandId);
    const route = command && routing?.routes.find(item => item.routeId === command.executorRouteId);
    const delivery = candidate && (!command || (route?.platform === "codex_desktop"
      && candidate.threadId === route.conversationId && candidate.messageSha256 === command.payloadSha256
      && candidate.messageBytes === command.payloadBytes && candidate.intent === command.intent)) ? candidate : null;
    const results = command ? (resultMap.get(commandId)?.filter(result =>
      result.executorRouteId === command.executorRouteId) ?? []) : [];
    const events = eventMap.get(commandId) ?? [];
    const returns = (busMap.get(commandId) ?? [])
      .map(entry => ({ source: "result_bus", eventId: resultBusCompanionDeliveryId(entry.busEntryId),
        iteration: entry.iteration, status: entry.deliveryStatus, result: entry.result.status,
        resultId: entry.resultId, attemptId: entry.attempt?.attemptId ?? null,
        ...(entry.isolatedAt != null ? { isolated: true as const } : {}),
        target: entry.sendTarget ? (areChatgptConversationRoutesEquivalent(entry.sendTarget.canonicalUrl, auth.routeCanonical) ? "current" : "historical") : "unassigned",
        createdAt: entry.createdAt, updatedAt: entry.observedAt ?? entry.outcomeUnknownAt ?? entry.attempt?.claimedAt ?? entry.createdAt }));
    const executions = results.flatMap(result => "machineEvidence" in result ? [{ iteration: result.iteration, status: result.status, resultId: result.resultId as string | null,
      outputId: result.machineEvidence.output?.outputId ?? null, createdAt: result.createdAt }] : []);
    for (const record of recordsMap.get(commandId) ?? []) {
      if (candidate?.deliveryStatus === "accepted" && isTrustedDesktopReceipt(record, commandId)
        && !executions.some(result => result.iteration === record.iteration)) executions.push({ iteration: record.iteration, status: record.exitStatus as "ok" | "failed" | "blocked", resultId: null,
          outputId: record.outputId ?? null, createdAt: record.timestamp });
    }
    const issues = lifecycleDiagnostics(identity.id, commandId, stateDir);
    if (official && (command || candidate || dispatch)) issues.push("delivery_identity_conflict");
    if (candidate && command && !delivery) issues.push("delivery_identity_conflict");
    const queueStatus = command?.deliveryStatus === "pending" ? command.mailbox?.state : undefined;
    const queueReason = queueStatus === "blocked" ? command?.mailbox?.reason?.slice(0, 80) ?? null : undefined;
    const pendingPanelOperation = pendingPanelCommandIds.has(commandId);
    const cancelable = !!command && command.deliveryStatus === "pending" && !command.cancelledAt
      && canCancelMailbox(command.mailbox) && !candidate && !dispatch
      && !(recordsMap.get(commandId)?.length) && !(busMap.get(commandId)?.length) && !events.length
      && !(routing?.results.some(result => result.commandId === commandId))
      && !pendingPanelOperation;
    const cancelReason = cancelable ? undefined : pendingPanelOperation ? "PANEL_OPERATION_PENDING" : "PANEL_CANCEL_UNSAFE";
    return {
      ...(official ? { appServerTurn: { taskId: official.taskId, targetId: official.targetId ?? null,
        threadId: official.threadId, turnId: official.turnId ?? null, status: official.status,
        reason: official.error ?? null, updatedAt: official.updatedAt,
        resultId: (busMap.get(commandId) ?? []).find(entry => isOfficialResult(entry.result))?.resultId ?? null } } : {}),
      commandId, intent: command?.intent ?? candidate?.intent ?? dispatch?.intent ?? null,
      scope: official ? "current_target" : command ? (plannerIds.has(command.plannerRouteId) ? "current" : "historical")
        : candidate && candidate.bindingId === desktop?.binding?.bindingId ? "current_target" : "historical",
      issues, administrative: abandonedIds.has(commandId) ? "abandoned" : retiredIds.has(commandId) ? "retired" : resolvedIds.has(commandId) ? "resolved_unknown" : null,
      delivery: { status: command?.cancelledAt ? "cancelled" : delivery?.deliveryStatus ?? command?.deliveryStatus ?? (dispatch?.deliveryStatus === "started" ? "outcome_unknown" : dispatch?.deliveryStatus) ?? "unknown", deliveryId: delivery?.deliveryId ?? null,
        cancelable, ...(!cancelable ? { cancelReason } : {}),
        ...(queueStatus ? { queueStatus, ...(queueStatus === "blocked" ? { queueReason: queueReason ?? null } : {}) } : {}),
        updatedAt: delivery?.updatedAt ?? command?.updatedAt ?? dispatch?.updatedAt ?? null, reason: delivery?.errorCode ?? null },
      // Routing results have canonical trusted machineEvidence. Generic record drafts are never read here.
      executions,
      feedback: [...returns, ...events.map(event => ({ source: "legacy", eventId: event.eventId,
        iteration: event.iteration, status: event.status, result: event.result,
        resultId: null, attemptId: event.attemptId ?? null,
        target: event.targetBindingId === ctx.bindingId && event.targetEpoch === ctx.epoch && event.targetPrincipalFingerprint === ctx.principalFingerprint ? "current" : "historical",
        createdAt: event.createdAt, updatedAt: event.updatedAt }))],
      updatedAt: official?.updatedAt ?? command?.updatedAt ?? candidate?.updatedAt ?? dispatch?.updatedAt ?? events.at(-1)?.updatedAt ?? executions.at(-1)?.createdAt ?? null,
    };
  }).sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.commandId.localeCompare(b.commandId));
  return {
    schemaVersion: 1, ...auth, panelAuthorization: readPanelAuthorization(identity.id, stateDir), observedAt: new Date().toISOString(), readOnly: true,
    executor: officialMode ? { source: "codex_app_server", state: !remote.enabled || !controllerOnline(remote) || remote.controller?.appServer !== "running" ? "unknown"
      : remote.tasks.some(task => task.status === "awaiting_approval") ? "approval_required"
        : remote.tasks.some(task => ["starting", "running"].includes(task.status)) ? "busy" : "idle",
      reason: !remote.enabled ? "REMOTE_CONTROL_DISABLED" : !controllerOnline(remote) ? "CONTROLLER_OFFLINE"
        : remote.controller?.appServer !== "running" ? "APP_SERVER_NOT_READY" : null,
      observedAt: new Date().toISOString(), sessionId: null }
    : { state: bindingStable && endpoint.availability.available ? endpoint.activity ?? "unknown" : "unknown",
      reason: !bindingStable ? "binding_changed" : endpoint.availability.available ? null : endpoint.availability.reasonCode,
      observedAt: bindingStable && endpoint.availability.available ? new Date().toISOString() : null,
      ...(desktopBinding ? { source: "codex_desktop" } : {}),
      sessionId: desktopBinding ? (bindingStable ? desktopBinding.threadId : null) : endpoint.activeBinding?.sessionId ?? null },
    scope: "workspace_metadata", commands: rows, total: rows.length,
  };
}
