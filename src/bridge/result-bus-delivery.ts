import { createHash } from "node:crypto";
import { resolveWorkspaceIdentity, type RoutingWorkspaceIdentity } from "../routing/store.js";
import { areChatgptConversationRoutesEquivalent } from "../chatgpt/route.js";
import {
  listResultBusEntries,
  readResultBus,
} from "../result-bus/store.js";
import { reconcileWorkspaceResultBus } from "../result-bus/service.js";
import type { CanonicalRoutingResult, ResultBusEntry } from "../result-bus/schema.js";
import {
  RESULT_BUS_CLAIMED_STALE_MS,
  RESULT_BUS_RESERVED_STALE_MS,
  ackResultBusObserved,
  beginResultBusSend,
  recoverStaleResultBusEntries,
  releaseResultBusReservation,
  reserveNextResultBusEntry,
  retireResultBusOutcomeUnknown,
} from "../result-bus/delivery-lifecycle.js";
import type { ResultBusCutoverEntry } from "../result-bus/cutover-schema.js";
import {
  ResultBusCutoverError,
  listResultBusCutoverDispositions,
  recordResultBusCutoverDisposition,
} from "../result-bus/cutover-store.js";
import type { FeedbackEvent } from "../feedback/schema.js";
import { recoverStaleFeedback, readFeedbackState } from "../feedback/state-store.js";
import { verifyCompanionCredentialReadOnly } from "../feedback/companion-delivery.js";
import { reconcileFeedbackOutbox } from "../feedback/projector.js";
import {
  formatCanonicalExecutedMessage,
  productionFeedbackDelivery,
  productionFeedbackMessageSha256,
} from "../feedback/message.js";
import { CompanionError, type CompanionAuthContext } from "../feedback/companion-common.js";
import { feedbackEventId, publicCompanionDeliveryEvent } from "../feedback/projection-store.js";
import { assertRouteVerifiedForProduction } from "../feedback/companion-route.js";
import {
  ackObservedForCompanion,
  beginSend,
  releaseReservation,
  reserveNext,
  retireOutcomeUnknown,
} from "../feedback/delivery-lifecycle.js";
import { verifyCompanionCredential } from "../feedback/companion.js";
import { readActiveWebSinkBinding } from "../web-sink-control/service.js";
import {
  verifyCompanionCredentialForWebSink,
  type WebSinkCompanionAuthContext,
} from "../web-sink-control/companion-adapter.js";
import { withDeliveryArbiter } from "./delivery-arbiter.js";

/**
 * R5d3 canonical delivery adapter：Workspace Result Bus → Active Web Sink → Companion。
 *
 * - 认证：Bus canonical 路径只需 R5c Web Sink Companion 边界
 *   （verifyCompanionCredentialForWebSink），不要求 active Feedback receiver
 *   binding/principal；legacy/control 路径 lazy 使用 verifyCompanionCredential。
 * - 目标只来自 readActiveWebSinkBinding / 冻结 sendTarget；不读取 plannerRouteId /
 *   plannerPrincipalFingerprint（历史分类只做存在性检查与 immutable identity 匹配）。
 * - 全局单飞由 withDeliveryArbiter 在写 durable state 之前串行化（含 MCP claim）。
 * - 历史 canonical legacy（R4c pinned 与 pre-R4c exact legacy）经 cutover ledger
 *   精确分类并永久抑制/接管；漂移、重复、歧义、orphan 一律 fail closed。
 */

export { assertNoProductionInFlight, assertNoResultBusInFlight } from "./delivery-arbiter.js";

export class ResultBusDeliveryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ResultBusDeliveryError";
  }
}

/** Browser 兼容投递 ID：确定性 32-hex；不写入 Result Bus 持久化身份。 */
export function resultBusCompanionDeliveryId(busEntryId: string): string {
  return createHash("sha256").update(`result-bus-companion:${busEntryId}`, "utf8").digest("hex").slice(0, 32);
}

const LEGACY_INFLIGHT_STATUSES = new Set(["reserved", "claimed", "outcome_unknown"]);
const BUS_INFLIGHT_STATUSES = new Set(["reserved", "claimed", "outcome_unknown"]);

function identityOf(workspaceId: string, workspaceRoot: string): RoutingWorkspaceIdentity {
  return resolveWorkspaceIdentity({ id: workspaceId, root: workspaceRoot });
}

type CanonicalFeedbackEvent = FeedbackEvent & { resultSha256: string };

function isPinnedCanonicalEvent(event: FeedbackEvent): event is CanonicalFeedbackEvent {
  return "plannerRouteId" in event && "resultSha256" in event;
}

/**
 * R5d3 final-fix：canonical counterpart 分类只考虑 canonical-like 历史候选。
 * control/非 canonical 事件（FINAL_RECEIPT_REQUIRED 等）可与同一 canonical
 * execution 合法共存，不参与 ambiguity/drift 判定，由 legacy/control 路径
 * 按自身生命周期继续投递。
 */
function isCanonicalLikeCandidate(event: FeedbackEvent): boolean {
  if (isPinnedCanonicalEvent(event)) return true;
  return event.kind === "C2C_EXECUTED" && event.source === "desktop";
}

function canonicalOf(entry: ResultBusEntry): CanonicalRoutingResult {
  if (!("machineEvidence" in entry.result) || !("rawSummary" in entry.result)) {
    throw new ResultBusDeliveryError("RESULT_BUS_ENTRY_NOT_CANONICAL", "Bus entry 不含 canonical RoutingResult；fail closed。");
  }
  return entry.result;
}

/** R4c 同语义 normalization/truncation。 */
function truncateSummary(text: string, max = 2000): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** pre-R4c exact legacy 事件的期望 eventId（与 R4c 兼容投影同一派生）。 */
function expectedPreR4cEventId(entry: ResultBusEntry): string {
  const canonical = canonicalOf(entry);
  const evidence = canonical.machineEvidence;
  return feedbackEventId({
    workspaceId: entry.workspaceId,
    commandId: entry.commandId,
    taskId: evidence.taskId,
    iteration: entry.iteration,
    desktopReceiptSha256: evidence.desktopReceiptSha256,
  });
}

/** pre-R4c exact legacy 匹配：同 canonical execution identity、无 planner 元数据。 */
function matchesPreR4cIdentity(entry: ResultBusEntry, event: FeedbackEvent): boolean {
  if (isPinnedCanonicalEvent(event)) return false;
  const canonical = canonicalOf(entry);
  const evidence = canonical.machineEvidence;
  return event.eventId === expectedPreR4cEventId(entry)
    && event.kind === "C2C_EXECUTED"
    && event.source === "desktop"
    && event.workspaceId === entry.workspaceId
    && event.commandId === entry.commandId
    && event.taskId === evidence.taskId
    && event.iteration === entry.iteration
    && event.result === canonical.status
    && JSON.stringify(event.changedFilesSummary) === JSON.stringify(evidence.changedFiles.slice(0, 200))
    && event.testsSummary === truncateSummary(evidence.testsSummary)
    && event.outputAvailable === (evidence.output?.outputAvailable ?? false)
    && event.outputId === evidence.output?.outputId;
}

function legacyInFlightEvents(state: ReturnType<typeof recoverStaleFeedback>): FeedbackEvent[] {
  return state.events.filter(event => LEGACY_INFLIGHT_STATUSES.has(event.status));
}

function busInFlightEntries(entries: readonly ResultBusEntry[]): ResultBusEntry[] {
  return entries.filter(entry => BUS_INFLIGHT_STATUSES.has(entry.deliveryStatus));
}

function busDeliveryDto(entry: ResultBusEntry): Record<string, unknown> {
  const canonical = canonicalOf(entry);
  const evidence = canonical.machineEvidence;
  return {
    eventId: resultBusCompanionDeliveryId(entry.busEntryId),
    kind: "C2C_EXECUTED",
    commandId: entry.commandId,
    taskId: evidence.taskId,
    iteration: entry.iteration,
    result: canonical.status,
    status: entry.deliveryStatus,
    changedFilesSummary: evidence.changedFiles.slice(0, 200),
    testsSummary: evidence.testsSummary,
    outputAvailable: evidence.output?.outputAvailable ?? false,
    ...(evidence.output?.outputId !== undefined ? { outputId: evidence.output.outputId } : {}),
    occurredAt: canonical.createdAt,
    createdAt: entry.createdAt,
    updatedAt: entry.createdAt,
  };
}

/** claimed/outcome_unknown 的确定性 canonical message（server 唯一生成）。 */
export function resultBusDeliveryMessage(entry: ResultBusEntry, attemptId: string): { message: string; messageSha256: string } {
  const canonical = canonicalOf(entry);
  const evidence = canonical.machineEvidence;
  const message = formatCanonicalExecutedMessage({
    workspaceId: entry.workspaceId,
    commandId: entry.commandId,
    taskId: evidence.taskId,
    iteration: entry.iteration,
    result: canonical.status,
    eventId: resultBusCompanionDeliveryId(entry.busEntryId),
    attemptId,
    changedFilesSummary: evidence.changedFiles.slice(0, 200),
    testsSummary: evidence.testsSummary,
    outputAvailable: evidence.output?.outputAvailable ?? false,
    ...(canonical.rawSummary !== undefined ? { rawSummary: canonical.rawSummary } : {}),
    machineEvidence: {
      version: 1,
      source: "codex_desktop_receipt",
      status: canonical.status,
      changedFiles: evidence.changedFiles,
      testsSummary: evidence.testsSummary,
      output: evidence.output,
    },
  });
  return { message, messageSha256: productionFeedbackMessageSha256(message) };
}

function busInFlightDto(entry: ResultBusEntry): Record<string, unknown> {
  const inFlight: Record<string, unknown> = {
    eventId: resultBusCompanionDeliveryId(entry.busEntryId),
    status: entry.deliveryStatus,
    ...(entry.reservation ? { reservationId: entry.reservation.reservationId } : {}),
    ...(entry.attempt ? { attemptId: entry.attempt.attemptId } : {}),
  };
  if ((entry.deliveryStatus === "claimed" || entry.deliveryStatus === "outcome_unknown") && entry.attempt) {
    const delivery = resultBusDeliveryMessage(entry, entry.attempt.attemptId);
    inFlight.message = delivery.message;
    inFlight.messageSha256 = delivery.messageSha256;
  }
  return inFlight;
}

export type ResultBusCutoverReconciliation = {
  projected: number;
  dispositionsWritten: number;
  dispositionsReplayed: number;
  unsafeLegacyInFlight: Array<{ commandId: string; iteration: number; status: string; legacyEventId: string }>;
  cutoverReady: boolean;
  /** 校验通过的抑制集：busEntryId → { disposition, legacyEventId }。 */
  suppressions: ReadonlyMap<string, { disposition: string; legacyEventId: string }>;
  /** 归属 Bus 的历史 legacy eventId（供 legacy lifecycle 排除预约）。 */
  ownedLegacyEventIds: ReadonlySet<string>;
};

/**
 * 校验既有 ledger 行（FIX 7）：每行必须恰一 Bus entry 匹配、resultSha256 一致，
 * 且当历史 source 存在时 legacyEventId/disposition 与分类一致；orphan fail closed。
 */
function validateLedgerRows(input: {
  identity: RoutingWorkspaceIdentity;
  ledger: readonly ResultBusCutoverEntry[];
  busEntries: readonly ResultBusEntry[];
  feedbackEvents: readonly FeedbackEvent[];
  stateDir?: string;
}): Map<string, ResultBusCutoverEntry> {
  const { ledger, busEntries, feedbackEvents } = input;
  const validated = new Map<string, ResultBusCutoverEntry>();
  for (const row of ledger) {
    const matches = busEntries.filter(entry => entry.busEntryId === row.busEntryId);
    if (matches.length !== 1) {
      throw new ResultBusCutoverError(
        "RESULT_BUS_CUTOVER_CONFLICT",
        `cutover ledger 行 busEntryId=${row.busEntryId} 不对应唯一 Bus entry；orphan/future 行 fail closed。`,
      );
    }
    const entry = matches[0]!;
    if (row.resultSha256 !== entry.resultSha256) {
      throw new ResultBusCutoverError(
        "RESULT_BUS_CUTOVER_CONFLICT",
        `cutover ledger resultSha256 与 Bus entry 漂移（${row.busEntryId}）；fail closed。`,
      );
    }
    // R5d3 final-fix：只对 canonical-like counterpart 校验；同 command 的
    // control/非 canonical 事件不使有效 canonical ledger 行歧义或无效。
    const historical = feedbackEvents
      .filter(event => event.commandId === entry.commandId
        && event.iteration === entry.iteration
        && isCanonicalLikeCandidate(event));
    if (historical.length === 1) {
      const source = historical[0]!;
      if (source.eventId !== row.legacyEventId) {
        throw new ResultBusCutoverError(
          "RESULT_BUS_CUTOVER_CONFLICT",
          `cutover ledger legacyEventId 与历史 source 不一致（${row.busEntryId}）；fail closed。`,
        );
      }
      const expected = source.status === "observed"
        ? "legacy_observed"
        : source.status === "retired_unknown"
          ? "legacy_retired"
          : source.status === "ready" || source.status === "queued"
            ? "legacy_unbegun_bus_owned"
            : null;
      if (expected && row.disposition !== expected) {
        throw new ResultBusCutoverError(
          "RESULT_BUS_CUTOVER_CONFLICT",
          `cutover disposition 与历史 source 状态不一致（${row.busEntryId}）；fail closed。`,
        );
      }
    }
    validated.set(row.busEntryId, row);
  }
  return validated;
}

/**
 * R5d3 cutover reconciliation（FIX 1/7/8）：
 * 1. shadow reconcile canonical RoutingResults into Bus；
 * 2. 分类历史 canonical legacy：R4c pinned 与 pre-R4c exact legacy 双类，
 *    按 immutable identity 精确匹配；漂移/重复/歧义 fail closed；
 * 3. 终态写 disposition（observed/retired）；ready/queued 写 legacy_unbegun_bus_owned；
 * 4. ledger 全量自校验（orphan/resultSha/legacyEventId/disposition 一致性）；
 * 5. collision preflight：任何可预约 queued entry 的兼容 eventId 与 legacy 冲突即 fail closed；
 * 6. 报告 unsafe legacy in-flight 与 cutover-ready。
 */
export function reconcileResultBusCutover(input: {
  identity: RoutingWorkspaceIdentity;
  stateDir?: string;
}): ResultBusCutoverReconciliation {
  const { identity, stateDir } = input;
  const projected = reconcileWorkspaceResultBus(identity, stateDir).projected;
  const bus = readResultBus(identity, stateDir);
  const busEntries = bus?.entries ?? [];
  const feedback = recoverStaleFeedback(identity.id, stateDir);
  let ledgerRows = listResultBusCutoverDispositions(identity, stateDir);
  const ledgerByEntry = new Map(ledgerRows.map(row => [row.busEntryId, row]));
  let dispositionsWritten = 0;
  let dispositionsReplayed = 0;
  const unsafeLegacyInFlight: ResultBusCutoverReconciliation["unsafeLegacyInFlight"] = [];

  const classifyStatus = (status: string): "legacy_observed" | "legacy_retired" | "legacy_unbegun_bus_owned" | null =>
    status === "observed"
      ? "legacy_observed"
      : status === "retired_unknown"
        ? "legacy_retired"
        : status === "ready" || status === "queued"
          ? "legacy_unbegun_bus_owned"
          : null;

  for (const entry of busEntries) {
    // R5d3 final-fix：只有 canonical-like 候选参与 ambiguity/drift 规则；
    // control/非 canonical 事件（FINAL_RECEIPT_REQUIRED 等）被忽略，
    // 不构成 counterpart 歧义或身份漂移。
    const candidates = feedback.events.filter(event =>
      event.commandId === entry.commandId
      && event.iteration === entry.iteration
      && isCanonicalLikeCandidate(event));
    if (candidates.length > 1) {
      throw new ResultBusCutoverError(
        "RESULT_BUS_CUTOVER_IDENTITY_CONFLICT",
        `同一 canonical execution 存在多个 canonical-like 历史 counterpart（${entry.commandId}#${entry.iteration}）；fail closed。`,
      );
    }
    const historical = candidates[0];
    if (historical && !isPinnedCanonicalEvent(historical) && !matchesPreR4cIdentity(entry, historical)) {
      throw new ResultBusCutoverError(
        "RESULT_BUS_CUTOVER_IDENTITY_CONFLICT",
        `历史 Feedback 事件与 Bus canonical result 身份漂移（${entry.commandId}#${entry.iteration}）；fail closed。`,
      );
    }
    if (historical && isPinnedCanonicalEvent(historical) && historical.resultSha256 !== entry.resultSha256) {
      throw new ResultBusCutoverError(
        "RESULT_BUS_CUTOVER_IDENTITY_CONFLICT",
        `legacy canonical event 与 Bus entry resultSha256 漂移（${entry.commandId}#${entry.iteration}）；fail closed。`,
      );
    }
    if (!historical) continue;
    const disposition = classifyStatus(historical.status);
    if (disposition === null) {
      unsafeLegacyInFlight.push({
        commandId: entry.commandId,
        iteration: entry.iteration,
        status: historical.status,
        legacyEventId: historical.eventId,
      });
      continue;
    }
    const recorded = ledgerByEntry.get(entry.busEntryId);
    if (recorded) {
      if (recorded.disposition !== disposition || recorded.legacyEventId !== historical.eventId) {
        throw new ResultBusCutoverError(
          "RESULT_BUS_CUTOVER_CONFLICT",
          `busEntryId ${entry.busEntryId} 的 cutover disposition 漂移；fail closed。`,
        );
      }
      dispositionsReplayed += 1;
      continue;
    }
    const written = recordResultBusCutoverDisposition(identity, {
      busEntryId: entry.busEntryId,
      resultSha256: entry.resultSha256,
      legacyEventId: historical.eventId,
      disposition,
    }, stateDir);
    ledgerRows = [...ledgerRows, written.entry];
    ledgerByEntry.set(written.entry.busEntryId, written.entry);
    dispositionsWritten += 1;
  }
  // 无 Bus counterpart 的 legacy canonical in-flight 同样构成全局 fence。
  const matched = new Set(busEntries.map(entry => `${entry.commandId}\u0000${entry.iteration}`));
  for (const event of feedback.events) {
    if (!isPinnedCanonicalEvent(event)) continue;
    if (matched.has(`${event.commandId}\u0000${event.iteration}`)) continue;
    if (LEGACY_INFLIGHT_STATUSES.has(event.status)) {
      unsafeLegacyInFlight.push({
        commandId: event.commandId, iteration: event.iteration, status: event.status, legacyEventId: event.eventId,
      });
    }
  }
  // FIX 7：全量 ledger 自校验（含新写入行）。
  const validated = validateLedgerRows({ identity, ledger: ledgerRows, busEntries, feedbackEvents: feedback.events, stateDir });
  // FIX 8：collision preflight——任何 queued entry 的兼容 eventId 都不得与 legacy 冲突
  // （含 legacy_unbegun_bus_owned：Bus 拥有投递，冲突将使 browser 无法区分来源）。
  for (const entry of busEntries) {
    if (entry.deliveryStatus !== "queued") continue;
    const compatId = resultBusCompanionDeliveryId(entry.busEntryId);
    if (feedback.events.some(event => event.eventId === compatId)) {
      throw new ResultBusDeliveryError(
        "RESULT_BUS_DELIVERY_ID_CONFLICT",
        `Bus entry ${entry.busEntryId} 的兼容 eventId 与 legacy Feedback 事件冲突；保持 queued，fail closed。`,
      );
    }
  }
  const suppressions = new Map(
    [...validated.values()]
      // legacy_unbegun_bus_owned：Bus entry 本身不抑制（Bus 拥有投递），
      // 仅其 legacy counterpart 经 ownedLegacyEventIds 排除预约。
      .filter(row => row.disposition !== "legacy_unbegun_bus_owned")
      .map(row => [row.busEntryId, { disposition: row.disposition, legacyEventId: row.legacyEventId } as const]),
  );
  const ownedLegacyEventIds = new Set([...validated.values()].map(row => row.legacyEventId));
  return {
    projected,
    dispositionsWritten,
    dispositionsReplayed,
    unsafeLegacyInFlight,
    cutoverReady: unsafeLegacyInFlight.length === 0,
    suppressions,
    ownedLegacyEventIds,
  };
}

type DeliverySource =
  | { source: "bus"; entry: ResultBusEntry }
  | { source: "legacy"; event: FeedbackEvent };

/** eventId 精确解析到唯一来源；Bus compat 与 legacy 同时命中 / 多重命中即 fail closed。
 * R5d3 auth-purity：source discovery 严格只读（readFeedbackState），不做 stale transition。 */
function resolveDeliverySource(input: {
  identity: RoutingWorkspaceIdentity;
  eventId: string;
  stateDir?: string;
}): DeliverySource | null {
  const busMatches = listResultBusEntries(input.identity, input.stateDir)
    .filter(entry => resultBusCompanionDeliveryId(entry.busEntryId) === input.eventId);
  const legacyMatches = readFeedbackState(input.identity.id, input.stateDir)
    .events.filter(event => event.eventId === input.eventId);
  if (busMatches.length > 0 && legacyMatches.length > 0) {
    throw new ResultBusDeliveryError(
      "RESULT_BUS_DELIVERY_ID_CONFLICT",
      "eventId 同时命中 Result Bus 兼容 ID 与 legacy Feedback 事件；fail closed。",
    );
  }
  if (busMatches.length > 1 || legacyMatches.length > 1) {
    throw new ResultBusDeliveryError("RESULT_BUS_DELIVERY_ID_CONFLICT", "eventId 解析到多个来源；fail closed。");
  }
  if (busMatches.length === 1) return { source: "bus", entry: busMatches[0]! };
  if (legacyMatches.length === 1) return { source: "legacy", event: legacyMatches[0]! };
  return null;
}

function routesMatch(a: string, b: string): boolean {
  return areChatgptConversationRoutesEquivalent(a, b);
}

function companionRouteMismatch(): CompanionError {
  // 保持既有 Browser wire 契约：route 不匹配 = ROUTE_MISMATCH。
  return new CompanionError("ROUTE_MISMATCH", "delivery route 与 companion 绑定不一致");
}

type WebSinkAuth = WebSinkCompanionAuthContext | { error: unknown };

function tryWebSinkAuth(input: { workspaceId: string; credential: string; stateDir?: string }): WebSinkAuth {
  try {
    return verifyCompanionCredentialForWebSink(input);
  } catch (error) {
    return { error };
  }
}

type FeedbackAuth = CompanionAuthContext | { error: unknown };

/** legacy/control 路径 lazy 使用既有 Feedback receiver 认证。 */
function tryFeedbackAuth(input: { workspaceId: string; credential: string; stateDir?: string }): FeedbackAuth {
  try {
    return verifyCompanionCredential(input);
  } catch (error) {
    return { error };
  }
}

function feedbackAuthOrThrow(input: { workspaceId: string; credential: string; stateDir?: string }): CompanionAuthContext {
  const auth = tryFeedbackAuth(input);
  if ("error" in auth) throw auth.error;
  return auth;
}

function legacyReserve(input: {
  workspaceId: string;
  /** 已建立的 legacy Feedback auth 边界（auth-first：调用前必须完成认证）。 */
  auth: CompanionAuthContext;
  routeCanonical: string;
  ownedLegacyEventIds: ReadonlySet<string>;
  stateDir?: string;
}): { reservationId: string; delivery: Record<string, unknown> } {
  if (!routesMatch(input.auth.routeCanonical, input.routeCanonical)) throw companionRouteMismatch();
  assertRouteVerifiedForProduction(input.workspaceId, input.auth, input.stateDir);
  const result = reserveNext({
    workspaceId: input.workspaceId,
    bindingId: input.auth.bindingId,
    epoch: input.auth.epoch,
    principalFingerprint: input.auth.principalFingerprint,
    companionId: input.auth.companionId,
    excludeEventIds: input.ownedLegacyEventIds,
    stateDir: input.stateDir,
  });
  return { reservationId: result.reservationId, delivery: publicCompanionDeliveryEvent(result.event) };
}

/**
 * /reserve cutover（auth-first；全局单飞在 arbiter 内 pre-mutation 检查）：
 * 0. 认证边界先于一切 reconcile/mutation：Web Sink Companion auth 可用即用之；
 *    否则要求有效 legacy Feedback Companion auth（fallback-only）。无效 credential
 *    直接 401，绝不触发 projector/Bus shadow/cutover ledger/lifecycle 的任何写入。
 * 1. 既有精确 in-flight（Bus 或 legacy；双方并存即 conflict）
 * 2. queued canonical Result Bus（经 validated 抑制集过滤）
 * 3. legacy 非 canonical/control ready 事件（排除 cutover-owned）
 */
export function resultBusCompanionReserve(input: {
  workspaceId: string;
  workspaceRoot: string;
  credential: string;
  routeCanonical: string;
  stateDir?: string;
}): { reservationId: string; delivery: Record<string, unknown> } {
  const stateDir = input.stateDir;
  // R5d3 final-fix：AUTH BEFORE ANY MUTATION。tryWebSinkAuth 只读；
  // legacy Feedback auth 仅在 Web Sink 边界不可用时建立。
  const sinkAuth = tryWebSinkAuth({ workspaceId: input.workspaceId, credential: input.credential, stateDir });
  let legacyCtx: CompanionAuthContext | null = null;
  if ("error" in sinkAuth) {
    const feedbackAuth = tryFeedbackAuth({ workspaceId: input.workspaceId, credential: input.credential, stateDir });
    if ("error" in feedbackAuth) throw feedbackAuth.error;
    legacyCtx = feedbackAuth;
  }
  return withDeliveryArbiter({ workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot, stateDir }, identity => {
    // 已认证：projector reconcile（legacy/control 事件）→ cutover ownership 先于一切获取路径建立。
    reconcileFeedbackOutbox(input.workspaceId, stateDir, input.workspaceRoot);
    const cutover = reconcileResultBusCutover({ identity, stateDir });
    const owned = cutover.ownedLegacyEventIds;
    const activeSink = "error" in sinkAuth ? null : readActiveWebSinkBinding(input.workspaceId);
    if ("error" in sinkAuth || !activeSink) {
      // Web Sink 边界不可用：维持 legacy 非 canonical/control 语义（feedback auth 必需），
      // cutover-owned 历史 legacy 事件经排除集永久不可预约。
      return legacyReserve({
        workspaceId: input.workspaceId,
        auth: legacyCtx
          ?? feedbackAuthOrThrow({ workspaceId: input.workspaceId, credential: input.credential, stateDir }),
        routeCanonical: input.routeCanonical,
        ownedLegacyEventIds: owned,
        stateDir,
      });
    }
    // Bus 路径：请求 route 必须同时等于 companion verified route 与当前 Active Sink。
    if (!routesMatch(input.routeCanonical, sinkAuth.routeCanonical)) throw companionRouteMismatch();
    if (!routesMatch(input.routeCanonical, activeSink.canonicalUrl)) {
      throw new ResultBusDeliveryError(
        "RESULT_BUS_SINK_ROUTE_MISMATCH",
        "请求 route 与当前 Active Web Sink 不一致；拒绝以非当前 Sink 为 canonical 投递目标。",
      );
    }
    recoverStaleResultBusEntries(identity, {
      reservedStaleMs: RESULT_BUS_RESERVED_STALE_MS,
      claimedStaleMs: RESULT_BUS_CLAIMED_STALE_MS,
    });
    const feedbackInFlight = legacyInFlightEvents(recoverStaleFeedback(input.workspaceId, stateDir));
    const busInFlight = busInFlightEntries(readResultBus(identity, stateDir)?.entries ?? []);
    if (feedbackInFlight.length > 0 && busInFlight.length > 0) {
      throw new ResultBusDeliveryError(
        "RESULT_BUS_CUTOVER_INFLIGHT_CONFLICT",
        "legacy Feedback 与 Result Bus 同时存在 durable in-flight；migration 状态冲突，fail closed。",
      );
    }
    if (feedbackInFlight.length > 0) {
      // 既有 legacy in-flight 优先经旧 lifecycle 收敛；NEW canonical 预约不得与其竞争。
      throw new CompanionError("FEEDBACK_INFLIGHT_FENCE", "存在 legacy reserved/claimed/outcome_unknown 事件；禁止并发预占");
    }
    // Bus 自身 in-flight → core reserveNext 返回 in_flight 幂等 DTO（priority 1）。
    const reserved = reserveNextResultBusEntry(
      identity,
      { excludeBusEntryIds: new Set(cutover.suppressions.keys()) },
      stateDir,
    );
    if (reserved.status === "reserved" || reserved.status === "in_flight") {
      return {
        reservationId: reserved.entry.reservation!.reservationId,
        delivery: busDeliveryDto(reserved.entry),
      };
    }
    // Bus 空（或全部被抑制）→ priority 3：legacy 非 canonical/control。
    return legacyReserve({
      workspaceId: input.workspaceId,
      auth: legacyCtx
        ?? feedbackAuthOrThrow({ workspaceId: input.workspaceId, credential: input.credential, stateDir }),
      routeCanonical: input.routeCanonical,
      ownedLegacyEventIds: cutover.ownedLegacyEventIds,
      stateDir,
    });
  });
}

/** /release：Bus compat ID → Bus lifecycle；legacy eventId → legacy release；歧义 fail closed。 */
export function resultBusCompanionRelease(input: {
  workspaceId: string;
  workspaceRoot: string;
  credential: string;
  routeCanonical: string;
  eventId: string;
  reservationId: string;
  stateDir?: string;
}): { eventId: string; status: string } {
  const stateDir = input.stateDir;
  return withDeliveryArbiter({ workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot, stateDir }, identity => {
    // R5d3 auth-purity：只读 credential pre-auth 先于 source resolution 与一切 mutation；
    // 无效/缺失/superseded credential 在此即被拒绝，绝不触碰 Feedback state/Bus/cutover ledger。
    verifyCompanionCredentialReadOnly({ workspaceId: input.workspaceId, credential: input.credential, stateDir });
    const source = resolveDeliverySource({ identity, eventId: input.eventId, stateDir });
    if (source?.source === "bus") {
      const sinkAuth = verifyCompanionCredentialForWebSink({ workspaceId: input.workspaceId, credential: input.credential, stateDir });
      if (!routesMatch(input.routeCanonical, sinkAuth.routeCanonical)) throw companionRouteMismatch();
      const released = releaseResultBusReservation(identity, {
        busEntryId: source.entry.busEntryId,
        reservationId: input.reservationId,
      }, stateDir);
      return { eventId: resultBusCompanionDeliveryId(released.entry.busEntryId), status: released.entry.deliveryStatus };
    }
    if (source?.source === "legacy") {
      const ctx = feedbackAuthOrThrow({ workspaceId: input.workspaceId, credential: input.credential, stateDir });
      if (!routesMatch(ctx.routeCanonical, input.routeCanonical)) throw companionRouteMismatch();
      const event = releaseReservation({
        workspaceId: input.workspaceId,
        bindingId: ctx.bindingId,
        epoch: ctx.epoch,
        principalFingerprint: ctx.principalFingerprint,
        companionId: ctx.companionId,
        eventId: input.eventId,
        reservationId: input.reservationId,
        stateDir,
      });
      return { eventId: event.eventId, status: event.status };
    }
    throw new CompanionError("FEEDBACK_EVENT_NOT_FOUND", "feedback 事件不存在");
  });
}

/** /begin-send：Bus compat → beginResultBusSend（stale → bounded 错误）；claimed 后才返回 message。 */
export function resultBusCompanionBeginSend(input: {
  workspaceId: string;
  workspaceRoot: string;
  credential: string;
  routeCanonical: string;
  eventId: string;
  reservationId: string;
  stateDir?: string;
}): { eventId: string; status: string; attemptId: string; message: string; messageSha256: string } {
  const stateDir = input.stateDir;
  return withDeliveryArbiter({ workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot, stateDir }, identity => {
    // R5d3 auth-purity：只读 credential pre-auth 先于 source resolution 与一切 mutation；
    // 无效/缺失/superseded credential 在此即被拒绝，绝不触碰 Feedback state/Bus/cutover ledger。
    verifyCompanionCredentialReadOnly({ workspaceId: input.workspaceId, credential: input.credential, stateDir });
    const source = resolveDeliverySource({ identity, eventId: input.eventId, stateDir });
    if (source?.source === "bus") {
      const sinkAuth = verifyCompanionCredentialForWebSink({ workspaceId: input.workspaceId, credential: input.credential, stateDir });
      // FIX B：credential verified route 必须与请求 route 一致（独立于 Active Sink 证据）。
      if (!routesMatch(input.routeCanonical, sinkAuth.routeCanonical)) throw companionRouteMismatch();
      // reserved target boundary：若 reservation stamp 仍与当前 Active Sink 一致，
      // 请求 route 必须等于当前 Sink；Sink 已切换时交由 core stale-requeue 安全边界处理。
      const active = readActiveWebSinkBinding(input.workspaceId);
      const reservation = source.entry.reservation;
      if (active && reservation
        && active.bindingId === reservation.bindingId && active.epoch === reservation.epoch
        && active.boundAt === reservation.boundAt
        && !routesMatch(input.routeCanonical, active.canonicalUrl)) {
        throw new ResultBusDeliveryError(
          "RESULT_BUS_SINK_ROUTE_MISMATCH",
          "请求 route 与 reservation 目标（当前 Active Web Sink）不一致。",
        );
      }
      const outcome = beginResultBusSend(identity, {
        busEntryId: source.entry.busEntryId,
        reservationId: input.reservationId,
      }, {}, stateDir);
      if (outcome.status === "stale_reservation") {
        throw new ResultBusDeliveryError(
          "RESULT_BUS_STALE_RESERVATION",
          "Active Web Sink 已切换；reservation 安全回 queued，未铸造 attempt。请重新 reserve。",
        );
      }
      const delivery = resultBusDeliveryMessage(outcome.entry, outcome.attemptId);
      return {
        eventId: resultBusCompanionDeliveryId(outcome.entry.busEntryId),
        status: outcome.entry.deliveryStatus,
        attemptId: outcome.attemptId,
        message: delivery.message,
        messageSha256: delivery.messageSha256,
      };
    }
    if (source?.source === "legacy") {
      const ctx = feedbackAuthOrThrow({ workspaceId: input.workspaceId, credential: input.credential, stateDir });
      if (!routesMatch(ctx.routeCanonical, input.routeCanonical)) throw companionRouteMismatch();
      assertRouteVerifiedForProduction(input.workspaceId, ctx, stateDir);
      const result = beginSend({
        workspaceId: input.workspaceId,
        bindingId: ctx.bindingId,
        epoch: ctx.epoch,
        principalFingerprint: ctx.principalFingerprint,
        companionId: ctx.companionId,
        eventId: input.eventId,
        reservationId: input.reservationId,
        stateDir,
      });
      const delivery = productionFeedbackDelivery(result.event as FeedbackEvent & { attemptId: string });
      return {
        eventId: result.event.eventId,
        status: result.event.status,
        attemptId: result.attemptId,
        message: delivery.message,
        messageSha256: delivery.messageSha256,
      };
    }
    throw new CompanionError("FEEDBACK_EVENT_NOT_FOUND", "feedback 事件不存在");
  });
}

/** /ack：Bus compat + 精确 attemptId → ackResultBusObserved；legacy → 旧 ACK lifecycle。 */
export function resultBusCompanionAck(input: {
  workspaceId: string;
  workspaceRoot: string;
  credential: string;
  routeCanonical: string;
  eventId: string;
  attemptId: string;
  stateDir?: string;
}): { eventId: string; status: string } {
  const stateDir = input.stateDir;
  return withDeliveryArbiter({ workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot, stateDir }, identity => {
    // R5d3 auth-purity：只读 credential pre-auth 先于 source resolution 与一切 mutation；
    // 无效/缺失/superseded credential 在此即被拒绝，绝不触碰 Feedback state/Bus/cutover ledger。
    verifyCompanionCredentialReadOnly({ workspaceId: input.workspaceId, credential: input.credential, stateDir });
    const source = resolveDeliverySource({ identity, eventId: input.eventId, stateDir });
    if (source?.source === "bus") {
      const sinkAuth = verifyCompanionCredentialForWebSink({ workspaceId: input.workspaceId, credential: input.credential, stateDir });
      // FIX B：credential verified route 必须与请求 route 一致，且等于冻结 sendTarget。
      if (!routesMatch(input.routeCanonical, sinkAuth.routeCanonical)) throw companionRouteMismatch();
      // claimed/outcome_unknown/observed：请求 route 必须等于冻结 sendTarget canonicalUrl。
      if (!source.entry.sendTarget || !routesMatch(input.routeCanonical, source.entry.sendTarget.canonicalUrl)) {
        throw new ResultBusDeliveryError(
          "RESULT_BUS_FROZEN_TARGET_MISMATCH",
          "ack route 与冻结 sendTarget 不一致；frozen attempt 不随 Active Sink 迁移。",
        );
      }
      const acked = ackResultBusObserved(identity, {
        busEntryId: source.entry.busEntryId,
        attemptId: input.attemptId,
      }, {}, stateDir);
      return { eventId: resultBusCompanionDeliveryId(acked.entry.busEntryId), status: acked.entry.deliveryStatus };
    }
    if (source?.source === "legacy") {
      const ctx = feedbackAuthOrThrow({ workspaceId: input.workspaceId, credential: input.credential, stateDir });
      if (!routesMatch(ctx.routeCanonical, input.routeCanonical)) throw companionRouteMismatch();
      const event = ackObservedForCompanion({
        workspaceId: input.workspaceId,
        bindingId: ctx.bindingId,
        epoch: ctx.epoch,
        principalFingerprint: ctx.principalFingerprint,
        companionId: ctx.companionId,
        eventId: input.eventId,
        attemptId: input.attemptId,
        stateDir,
      });
      // FIX 6：legacy 终态化与 disposition 写入/新 reserve 串行（同 arbiter 锁），关闭 TOCTOU。
      reconcileResultBusCutover({ identity, stateDir });
      return { eventId: event.eventId, status: event.status };
    }
    throw new CompanionError("FEEDBACK_EVENT_NOT_FOUND", "feedback 事件不存在");
  });
}

/** /retire-unknown：Bus compat → retireResultBusOutcomeUnknown；legacy → 旧 retire。 */
export function resultBusCompanionRetire(input: {
  workspaceId: string;
  workspaceRoot: string;
  credential: string;
  routeCanonical: string;
  eventId: string;
  reservationId: string;
  attemptId: string;
  stateDir?: string;
}): { eventId: string; reservationId: string; attemptId: string; status: string } {
  const stateDir = input.stateDir;
  return withDeliveryArbiter({ workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot, stateDir }, identity => {
    // R5d3 auth-purity：只读 credential pre-auth 先于 source resolution 与一切 mutation；
    // 无效/缺失/superseded credential 在此即被拒绝，绝不触碰 Feedback state/Bus/cutover ledger。
    verifyCompanionCredentialReadOnly({ workspaceId: input.workspaceId, credential: input.credential, stateDir });
    const source = resolveDeliverySource({ identity, eventId: input.eventId, stateDir });
    if (source?.source === "bus") {
      const sinkAuth = verifyCompanionCredentialForWebSink({ workspaceId: input.workspaceId, credential: input.credential, stateDir });
      // FIX B：credential verified route 必须与请求 route 一致，且等于冻结 sendTarget。
      if (!routesMatch(input.routeCanonical, sinkAuth.routeCanonical)) throw companionRouteMismatch();
      if (!source.entry.sendTarget || !routesMatch(input.routeCanonical, source.entry.sendTarget.canonicalUrl)) {
        throw new ResultBusDeliveryError(
          "RESULT_BUS_FROZEN_TARGET_MISMATCH",
          "retire route 与冻结 sendTarget 不一致；frozen attempt 不随 Active Sink 迁移。",
        );
      }
      if (!source.entry.reservation || source.entry.reservation.reservationId !== input.reservationId) {
        throw new ResultBusDeliveryError(
          "RESULT_BUS_RESERVATION_MISMATCH",
          "retire reservationId 与 entry 预约不一致。",
        );
      }
      const retired = retireResultBusOutcomeUnknown(identity, {
        busEntryId: source.entry.busEntryId,
        attemptId: input.attemptId,
      }, {}, stateDir);
      return {
        eventId: resultBusCompanionDeliveryId(retired.entry.busEntryId),
        reservationId: retired.entry.reservation!.reservationId,
        attemptId: retired.entry.attempt!.attemptId,
        status: retired.entry.deliveryStatus,
      };
    }
    if (source?.source === "legacy") {
      const ctx = feedbackAuthOrThrow({ workspaceId: input.workspaceId, credential: input.credential, stateDir });
      if (!routesMatch(ctx.routeCanonical, input.routeCanonical)) throw companionRouteMismatch();
      const event = retireOutcomeUnknown({
        workspaceId: input.workspaceId,
        bindingId: ctx.bindingId,
        epoch: ctx.epoch,
        principalFingerprint: ctx.principalFingerprint,
        companionId: ctx.companionId,
        eventId: input.eventId,
        reservationId: input.reservationId,
        attemptId: input.attemptId,
        stateDir,
      });
      // FIX 6：终态化与 disposition 写入串行。
      reconcileResultBusCutover({ identity, stateDir });
      return {
        eventId: event.eventId,
        reservationId: event.reservationId!,
        attemptId: event.attemptId!,
        status: event.status,
      };
    }
    throw new CompanionError("FEEDBACK_EVENT_NOT_FOUND", "feedback 事件不存在");
  });
}

/**
 * /state arbiter（WebSink-only auth；lazy feedback enrichment）。
 * FIX 4：foreign/pinned in-flight 只暴露 bounded blocking 元数据，不泄露
 * eventId/attemptId/reservationId/message/messageSha256。
 */
export function resultBusCompanionState(input: {
  workspaceId: string;
  workspaceRoot: string;
  credential: string;
  stateDir?: string;
}): Record<string, unknown> {
  const stateDir = input.stateDir;
  const sinkAuth = tryWebSinkAuth({ workspaceId: input.workspaceId, credential: input.credential, stateDir });
  if ("error" in sinkAuth) {
    // Web Sink 边界不可用：仅呈现 legacy 视图（无 production canonical 发送可能）。
    return { legacyOnly: true as const };
  }
  return withDeliveryArbiter({ workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot, stateDir }, identity => {
    const cutover = reconcileResultBusCutover({ identity, stateDir });
    recoverStaleResultBusEntries(identity, {
      reservedStaleMs: RESULT_BUS_RESERVED_STALE_MS,
      claimedStaleMs: RESULT_BUS_CLAIMED_STALE_MS,
    });
    const feedbackState = recoverStaleFeedback(input.workspaceId, stateDir);
    const busEntries = listResultBusEntries(identity, stateDir);
    const feedbackAuth = tryFeedbackAuth({ workspaceId: input.workspaceId, credential: input.credential, stateDir });
    const legacyCtx = "error" in feedbackAuth ? null : feedbackAuth;
    const scoped = legacyCtx
      ? feedbackState.events.filter((e) =>
          e.targetBindingId === legacyCtx.bindingId
          && e.targetEpoch === legacyCtx.epoch
          && e.targetPrincipalFingerprint === legacyCtx.principalFingerprint)
      : [];
    const legacyInFlight = legacyInFlightEvents(feedbackState);
    const busInFlight = busInFlightEntries(busEntries);
    // 双源 in-flight 属于损坏状态：只读诊断 fail closed。
    if (legacyInFlight.length > 0 && busInFlight.length > 0) {
      throw new ResultBusDeliveryError(
        "RESULT_BUS_CUTOVER_INFLIGHT_CONFLICT",
        "legacy Feedback 与 Result Bus 同时存在 durable in-flight；migration 状态冲突，fail closed。",
      );
    }
    const suppressed = cutover.suppressions;
    let inFlight: Record<string, unknown> | null = null;
    let blockedByLegacyInFlight = false;
    if (busInFlight.length === 1) {
      const entry = busInFlight[0]!;
      const pinnedAway = (entry.deliveryStatus === "claimed" || entry.deliveryStatus === "outcome_unknown")
        && entry.sendTarget != null
        && !routesMatch(sinkAuth.routeCanonical, entry.sendTarget.canonicalUrl);
      inFlight = pinnedAway
        ? { status: entry.deliveryStatus, pinnedToOtherRoute: true }
        : busInFlightDto(entry);
    } else if (legacyInFlight.length === 1) {
      const event = legacyInFlight[0]!;
      const owned = legacyCtx != null && event.reservedBy === legacyCtx.companionId;
      if (!owned) {
        // FIX 4：foreign/MCP legacy in-flight 不暴露任何身份/载荷。
        blockedByLegacyInFlight = true;
      } else {
        inFlight = {
          eventId: event.eventId,
          status: event.status,
          ...(event.reservationId ? { reservationId: event.reservationId } : {}),
          ...(event.attemptId ? { attemptId: event.attemptId } : {}),
        };
        if ((event.status === "claimed" || event.status === "outcome_unknown") && event.attemptId) {
          const delivery = productionFeedbackDelivery(event as FeedbackEvent & { attemptId: string });
          inFlight.message = delivery.message;
          inFlight.messageSha256 = delivery.messageSha256;
        }
      }
    }
      // FIX 4：foreign（reservedBy 非本 companion）事件不泄露 attempt/reservation 身份。
      const events = scoped.map((e) => {
        const dto = publicCompanionDeliveryEvent(e);
        if (legacyCtx && e.reservedBy !== undefined && e.reservedBy !== legacyCtx.companionId) {
          const { attemptId: _a, reservationId: _r, ...rest } = dto as Record<string, unknown>;
          return rest;
        }
        return dto;
      });
    return {
      legacyOnly: false as const,
      workspaceId: input.workspaceId,
      companionId: sinkAuth.companionId,
      bindingId: sinkAuth.bindingId,
      epoch: sinkAuth.epoch,
      routeCanonical: sinkAuth.routeCanonical,
      enabled: feedbackState.binding?.status === "active",
      routeVerification: "VERIFIED" as const,
      productionEligible: true,
      cutoverReady: cutover.cutoverReady,
      blockedByLegacyInFlight,
      pendingReady:
        scoped.filter((e) => e.status === "ready" && !isPinnedCanonicalEvent(e)).length
        + busEntries.filter((e) => e.deliveryStatus === "queued" && !suppressed.has(e.busEntryId)).length,
      reserved:
        scoped.filter((e) => e.status === "reserved").length
        + busEntries.filter((e) => e.deliveryStatus === "reserved").length,
      claimed:
        scoped.filter((e) => e.status === "claimed").length
        + busEntries.filter((e) => e.deliveryStatus === "claimed").length,
      outcomeUnknown:
        scoped.filter((e) => e.status === "outcome_unknown").length
        + busEntries.filter((e) => e.deliveryStatus === "outcome_unknown").length,
      retiredUnknown:
        scoped.filter((e) => e.status === "retired_unknown").length
        + busEntries.filter((e) => e.deliveryStatus === "retired_unknown").length,
      inFlight,
      unsafeLegacyInFlight: cutover.unsafeLegacyInFlight,
      events,
    };
  });
}
