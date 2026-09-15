import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { getStateDir } from "../config/paths.js";
import {
  requireConversationPrincipal,
  type ConversationPrincipal,
} from "../mcp/conversation-principal.js";
import {
  beginSend,
  COMPANION_PAIRING_TTL_MS,
  FeedbackError,
  mutateCompanionPairing,
  publicCompanionDeliveryEvent,
  readFeedbackState,
  recoverStaleFeedback,
  releaseReservation,
  reserveNext,
  type CompanionRecord,
  type FeedbackEvent,
  type FeedbackState,
  type PairingIntent,
} from "./store.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CompanionError extends FeedbackError {}

/** 仅接受 https://chatgpt.com/c/<uuid>；存 canonical 小写 uuid。 */
export function normalizeChatgptRoute(raw: string): string {
  if (typeof raw !== "string" || raw.length > 512) {
    throw new CompanionError("ROUTE_INVALID", "delivery route 无效");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CompanionError("ROUTE_INVALID", "delivery route 无效");
  }
  if (url.protocol !== "https:") {
    throw new CompanionError("ROUTE_INVALID", "delivery route 必须使用 https");
  }
  if (url.hostname.toLowerCase() !== "chatgpt.com") {
    throw new CompanionError("ROUTE_INVALID", "delivery route 仅支持 chatgpt.com");
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new CompanionError("ROUTE_INVALID", "delivery route 不得包含 query/hash/凭据");
  }
  const match = /^\/c\/([0-9a-fA-F-]{36})\/?$/.exec(url.pathname);
  if (!match) {
    throw new CompanionError("ROUTE_INVALID", "delivery route 必须为 https://chatgpt.com/c/<id>");
  }
  const id = match[1]!.toLowerCase();
  if (!UUID.test(id)) {
    throw new CompanionError("ROUTE_INVALID", "delivery route conversation id 无效");
  }
  return `https://chatgpt.com/c/${id}`;
}

function sha256Hex(material: string): string {
  return createHash("sha256").update(material, "utf8").digest("hex");
}

function hashEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function mintPairingSecret(): { secret: string; secretHash: string } {
  const secret = `c2c_pair_${randomBytes(24).toString("base64url")}`;
  return { secret, secretHash: sha256Hex(secret) };
}

function mintCompanionCredential(): { credential: string; credentialHash: string } {
  const credential = `c2c_comp_${randomBytes(32).toString("base64url")}`;
  return { credential, credentialHash: sha256Hex(credential) };
}

export type CompanionAuthContext = {
  workspaceId: string;
  companionId: string;
  bindingId: string;
  epoch: number;
  principalFingerprint: string;
  routeCanonical: string;
};

function isActiveCompanion(record: CompanionRecord | null | undefined): record is CompanionRecord {
  return Boolean(record && !record.supersededAt);
}

/**
 * re-pair = transport takeover：存在 reserved/claimed/outcome_unknown 时 fail closed。
 * reserved 须先 explicit release 或等 stale 恢复；claimed/outcome_unknown 禁止换 route。
 */
function assertNoInFlightDelivery(state: FeedbackState): void {
  if (state.events.some((e) =>
    e.status === "reserved" || e.status === "claimed" || e.status === "outcome_unknown")) {
    throw new CompanionError(
      "COMPANION_REPAIR_BLOCKED",
      "存在 reserved/claimed/outcome_unknown 事件；禁止 re-pair 更换 delivery route",
    );
  }
}

function companionMatchesBinding(
  companion: CompanionRecord,
  binding: { bindingId: string; epoch: number; principalFingerprint: string },
): boolean {
  return companion.bindingId === binding.bindingId
    && companion.epoch === binding.epoch
    && companion.principalFingerprint === binding.principalFingerprint;
}

/**
 * Trusted MCP：为当前 active binding 创建 one-time pairing intent。
 * 返回的 secret 只出现一次。
 */
export function createPairingIntent(input: {
  workspaceId: string;
  principal: ConversationPrincipal;
  ttlMs?: number;
  stateDir?: string;
  nowMs?: number;
}): { intentId: string; secret: string; expiresAt: string; bindingId: string; epoch: number } {
  requireConversationPrincipal(input.principal);
  const stateDir = input.stateDir ?? getStateDir();
  const nowMs = input.nowMs ?? Date.now();
  const ttl = input.ttlMs ?? COMPANION_PAIRING_TTL_MS;

  return mutateCompanionPairing(input.workspaceId, stateDir, (state) => {
    if (!state.binding || state.binding.status !== "active") {
      throw new FeedbackError("FEEDBACK_NOT_ENABLED", "production feedback 未启用");
    }
    if (state.binding.principalFingerprint !== input.principal.fingerprint) {
      throw new FeedbackError("FEEDBACK_PRINCIPAL_MISMATCH", "调用主体与当前 receiver 绑定不一致");
    }
    // 已有 in-flight delivery 时禁止创建新 pairing（transport takeover 门禁）。
    assertNoInFlightDelivery(state);
    const { secret, secretHash } = mintPairingSecret();
    const intent: PairingIntent = {
      version: 1,
      intentId: randomUUID(),
      bindingId: state.binding.bindingId,
      epoch: state.binding.epoch,
      principalFingerprint: state.binding.principalFingerprint,
      secretHash,
      expiresAt: new Date(nowMs + ttl).toISOString(),
    };
    return {
      state: { ...state, pairingIntent: intent },
      result: {
        intentId: intent.intentId,
        secret,
        expiresAt: intent.expiresAt,
        bindingId: intent.bindingId,
        epoch: intent.epoch,
      },
    };
  });
}

/** Public：一次性兑换 pairing intent → companion credential（单锁原子）。 */
export function exchangePairingIntent(input: {
  workspaceId: string;
  intentId: string;
  secret: string;
  routeCanonical: string;
  stateDir?: string;
  nowMs?: number;
}): {
  companionId: string;
  credential: string;
  workspaceId: string;
  bindingId: string;
  epoch: number;
  routeCanonical: string;
} {
  const stateDir = input.stateDir ?? getStateDir();
  const nowMs = input.nowMs ?? Date.now();
  const route = normalizeChatgptRoute(input.routeCanonical);

  return mutateCompanionPairing(input.workspaceId, stateDir, (state) => {
    const intent = state.pairingIntent;
    if (!intent || intent.consumedAt) {
      throw new CompanionError("PAIRING_CONSUMED", "pairing intent 不存在或已消费");
    }
    if (intent.intentId !== input.intentId) {
      throw new CompanionError("PAIRING_INVALID", "pairing intent 无效");
    }
    if (Date.parse(intent.expiresAt) <= nowMs) {
      throw new CompanionError("PAIRING_EXPIRED", "pairing intent 已过期");
    }
    if (!hashEqual(intent.secretHash, sha256Hex(input.secret))) {
      throw new CompanionError("PAIRING_INVALID", "pairing secret 无效");
    }
    if (!state.binding || state.binding.status !== "active") {
      throw new FeedbackError("FEEDBACK_NOT_ENABLED", "production feedback 未启用");
    }
    if (
      state.binding.bindingId !== intent.bindingId
      || state.binding.epoch !== intent.epoch
      || state.binding.principalFingerprint !== intent.principalFingerprint
    ) {
      throw new CompanionError("PAIRING_INVALID", "pairing intent 与当前 binding 不一致");
    }
    // exchange 仍二次检查：防止 create 后、exchange 前出现 claimed 等 in-flight。
    assertNoInFlightDelivery(state);
    const { credential, credentialHash } = mintCompanionCredential();
    const companion: CompanionRecord = {
      version: 1,
      companionId: randomUUID(),
      bindingId: intent.bindingId,
      epoch: intent.epoch,
      principalFingerprint: intent.principalFingerprint,
      credentialHash,
      routeCanonical: route,
      pairedAt: new Date(nowMs).toISOString(),
    };
    const nowIso = new Date(nowMs).toISOString();
    // 覆盖写入：旧 companion credential hash 立即失效（re-pair supersede）。
    return {
      state: {
        ...state,
        pairingIntent: { ...intent, consumedAt: nowIso },
        companion,
      },
      result: {
        companionId: companion.companionId,
        credential,
        workspaceId: input.workspaceId,
        bindingId: companion.bindingId,
        epoch: companion.epoch,
        routeCanonical: companion.routeCanonical,
      },
    };
  });
}

/** 用 credential 校验 companion；binding/epoch 必须仍匹配。 */
export function verifyCompanionCredential(input: {
  workspaceId: string;
  credential: string;
  stateDir?: string;
}): CompanionAuthContext {
  const stateDir = input.stateDir ?? getStateDir();
  const state = recoverStaleFeedback(input.workspaceId, stateDir);
  const companion = state.companion;
  if (!isActiveCompanion(companion)) {
    throw new CompanionError("COMPANION_UNAUTHORIZED", "companion 未配对或已撤销");
  }
  if (!hashEqual(companion.credentialHash, sha256Hex(input.credential))) {
    throw new CompanionError("COMPANION_UNAUTHORIZED", "companion credential 无效");
  }
  if (!state.binding || state.binding.status !== "active") {
    throw new FeedbackError("FEEDBACK_NOT_ENABLED", "production feedback 未启用");
  }
  if (
    companion.bindingId !== state.binding.bindingId
    || companion.epoch !== state.binding.epoch
    || companion.principalFingerprint !== state.binding.principalFingerprint
  ) {
    throw new CompanionError("COMPANION_EPOCH_STALE", "companion 绑定代次已失效");
  }
  return {
    workspaceId: state.workspaceId,
    companionId: companion.companionId,
    bindingId: companion.bindingId,
    epoch: companion.epoch,
    principalFingerprint: companion.principalFingerprint,
    routeCanonical: companion.routeCanonical,
  };
}

function requireRouteMatch(ctx: CompanionAuthContext, routeCanonical: string): void {
  const normalized = normalizeChatgptRoute(routeCanonical);
  if (normalized !== ctx.routeCanonical) {
    throw new CompanionError("ROUTE_MISMATCH", "delivery route 与 companion 绑定不一致");
  }
}

function companionAuthInput(ctx: CompanionAuthContext) {
  return {
    bindingId: ctx.bindingId,
    epoch: ctx.epoch,
    principalFingerprint: ctx.principalFingerprint,
    companionId: ctx.companionId,
  };
}

export function companionPublicState(input: {
  workspaceId: string;
  ctx: CompanionAuthContext;
  stateDir?: string;
}): Record<string, unknown> {
  const stateDir = input.stateDir ?? getStateDir();
  const state = recoverStaleFeedback(input.workspaceId, stateDir);
  // 只暴露当前 companion binding/epoch/fingerprint 对应事件；不做全 history 泄露。
  const scoped = state.events.filter((e) =>
    e.targetBindingId === input.ctx.bindingId
    && e.targetEpoch === input.ctx.epoch
    && e.targetPrincipalFingerprint === input.ctx.principalFingerprint);
  const events = scoped.map((e) => publicCompanionDeliveryEvent(e));
  return {
    workspaceId: state.workspaceId,
    bindingId: input.ctx.bindingId,
    epoch: input.ctx.epoch,
    routeCanonical: input.ctx.routeCanonical,
    companionId: input.ctx.companionId,
    enabled: state.binding?.status === "active",
    pendingReady: scoped.filter((e) => e.status === "ready").length,
    reserved: scoped.filter((e) => e.status === "reserved").length,
    claimed: scoped.filter((e) => e.status === "claimed").length,
    outcomeUnknown: scoped.filter((e) => e.status === "outcome_unknown").length,
    events,
  };
}

export function companionReserveNext(input: {
  workspaceId: string;
  ctx: CompanionAuthContext;
  routeCanonical: string;
  stateDir?: string;
}): { delivery: Record<string, unknown>; reservationId: string } {
  requireRouteMatch(input.ctx, input.routeCanonical);
  const result = reserveNext({
    workspaceId: input.workspaceId,
    ...companionAuthInput(input.ctx),
    stateDir: input.stateDir,
  });
  return {
    reservationId: result.reservationId,
    delivery: publicCompanionDeliveryEvent(result.event),
  };
}

export function companionRelease(input: {
  workspaceId: string;
  ctx: CompanionAuthContext;
  routeCanonical: string;
  eventId: string;
  reservationId: string;
  stateDir?: string;
}): FeedbackEvent {
  requireRouteMatch(input.ctx, input.routeCanonical);
  return releaseReservation({
    workspaceId: input.workspaceId,
    bindingId: input.ctx.bindingId,
    epoch: input.ctx.epoch,
    principalFingerprint: input.ctx.principalFingerprint,
    companionId: input.ctx.companionId,
    eventId: input.eventId,
    reservationId: input.reservationId,
    stateDir: input.stateDir,
  });
}

export function companionBeginSend(input: {
  workspaceId: string;
  ctx: CompanionAuthContext;
  routeCanonical: string;
  eventId: string;
  reservationId: string;
  stateDir?: string;
}): { event: FeedbackEvent; attemptId: string } {
  requireRouteMatch(input.ctx, input.routeCanonical);
  return beginSend({
    workspaceId: input.workspaceId,
    ...companionAuthInput(input.ctx),
    eventId: input.eventId,
    reservationId: input.reservationId,
    stateDir: input.stateDir,
  });
}

export function companionAckObserved(input: {
  workspaceId: string;
  ctx: CompanionAuthContext;
  routeCanonical: string;
  eventId: string;
  attemptId: string;
  stateDir?: string;
}): FeedbackEvent {
  requireRouteMatch(input.ctx, input.routeCanonical);
  const stateDir = input.stateDir ?? getStateDir();
  return mutateCompanionPairing(input.workspaceId, stateDir, (state) => {
    const event = state.events.find((e) => e.eventId === input.eventId);
    if (!event) throw new FeedbackError("FEEDBACK_EVENT_NOT_FOUND", "feedback 事件不存在");
    if (
      event.targetBindingId !== input.ctx.bindingId
      || event.targetEpoch !== input.ctx.epoch
      || event.targetPrincipalFingerprint !== input.ctx.principalFingerprint
    ) {
      throw new FeedbackError("FEEDBACK_ACK_MISMATCH", "ack 目标绑定不匹配");
    }
    // companion 只能 ACK 自己 reservedBy 发起的 attempt；MCP 直接 claim 的事件不可冒充 ACK。
    if (event.status === "claimed" || event.status === "observed") {
      if (event.reservedBy !== input.ctx.companionId) {
        throw new FeedbackError(
          "FEEDBACK_ACK_MISMATCH",
          "ack attempt 不属于当前 companion",
        );
      }
    }
    if (event.status === "observed") {
      if (event.attemptId === input.attemptId) return { state, result: event };
      throw new FeedbackError("FEEDBACK_ACK_MISMATCH", "observed 事件 attempt 不匹配");
    }
    if (event.status !== "claimed" || event.attemptId !== input.attemptId) {
      throw new FeedbackError("FEEDBACK_ACK_MISMATCH", "ack 身份与 claimed 事件不匹配");
    }
    const observed: FeedbackEvent = {
      ...event,
      status: "observed",
      updatedAt: new Date().toISOString(),
    };
    return {
      state: {
        ...state,
        events: state.events.map((e) => (e.eventId === input.eventId ? observed : e)),
      },
      result: observed,
    };
  });
}

/** Trusted：读 companion 元数据（无 secret）。 */
export function companionStatusForPrincipal(input: {
  workspaceId: string;
  principal: ConversationPrincipal;
  stateDir?: string;
}): Record<string, unknown> {
  requireConversationPrincipal(input.principal);
  const stateDir = input.stateDir ?? getStateDir();
  const state = recoverStaleFeedback(input.workspaceId, stateDir);
  if (
    !state.binding
    || state.binding.status !== "active"
    || state.binding.principalFingerprint !== input.principal.fingerprint
  ) {
    return {
      workspaceId: state.workspaceId,
      ownsBinding: false,
      companion: null,
      pairingIntentActive: false,
    };
  }
  const companion = isActiveCompanion(state.companion)
    && companionMatchesBinding(state.companion, state.binding)
    ? state.companion
    : null;
  const intent = state.pairingIntent && !state.pairingIntent.consumedAt
    && state.pairingIntent.bindingId === state.binding.bindingId
    && state.pairingIntent.epoch === state.binding.epoch
    ? state.pairingIntent
    : null;
  return {
    workspaceId: state.workspaceId,
    ownsBinding: true,
    companion: companion
      ? {
          companionId: companion.companionId,
          bindingId: companion.bindingId,
          epoch: companion.epoch,
          routeCanonical: companion.routeCanonical,
          pairedAt: companion.pairedAt,
        }
      : null,
    pairingIntentActive: Boolean(intent && Date.parse(intent.expiresAt) > Date.now()),
  };
}

/** Trusted：撤销 companion 与未消费 intent。 */
export function revokeCompanion(input: {
  workspaceId: string;
  principal: ConversationPrincipal;
  stateDir?: string;
}): { revoked: boolean } {
  requireConversationPrincipal(input.principal);
  const stateDir = input.stateDir ?? getStateDir();
  return mutateCompanionPairing(input.workspaceId, stateDir, (state) => {
    if (
      !state.binding
      || state.binding.status !== "active"
      || state.binding.principalFingerprint !== input.principal.fingerprint
    ) {
      throw new FeedbackError("FEEDBACK_PRINCIPAL_MISMATCH", "调用主体与当前 receiver 绑定不一致");
    }
    const nowIso = new Date().toISOString();
    const hadActive = isActiveCompanion(state.companion);
    const companion = hadActive
      ? { ...state.companion!, supersededAt: nowIso }
      : state.companion;
    const intent = state.pairingIntent && !state.pairingIntent.consumedAt
      ? { ...state.pairingIntent, consumedAt: nowIso }
      : state.pairingIntent;
    return {
      state: { ...state, companion, pairingIntent: intent },
      result: { revoked: hadActive },
    };
  });
}

export function readCompanionState(workspaceId: string, stateDir = getStateDir()): FeedbackState {
  return readFeedbackState(workspaceId, stateDir);
}
