import { getStateDir } from "../config/paths.js";
import {
  FeedbackError,
  formatRouteAttestationMessage,
  isRouteAttestationVerified,
  type FeedbackEvent,
} from "./schema.js";
import {
  ackObservedForCompanion,
  beginSend,
  releaseReservation,
  reserveNext,
  retireOutcomeUnknown,
} from "./delivery-lifecycle.js";
import { readFeedbackState } from "./state-store.js";
import { publicCompanionDeliveryEvent } from "./projection-store.js";
import { productionFeedbackDelivery } from "./message.js";
import {
  CompanionError,
  hashEqual,
  isActiveCompanion,
  normalizeChatgptRoute,
  sha256Hex,
  type CompanionAuthContext,
} from "./companion-common.js";
import {
  areChatgptConversationRoutesEquivalent,
} from "../chatgpt/route.js";
import { assertRouteVerifiedForProduction } from "./companion-route.js";

/**
 * 只读 Companion credential 预认证边界（R5d3 auth-purity）。
 * 使用 readFeedbackState（零写入/零 stale recovery）证明 credential 属于
 * 当前、未 superseded 的 Companion：workspace 精确、companion 存在、
 * credential hash 精确。不做 binding/principal/epoch 强化检查，不执行任何
 * lifecycle recovery——这些由认证后的 source-specific 路径按原有语义完成。
 * 不暴露 credential/hash/principal 材料。
 */
export function verifyCompanionCredentialReadOnly(input: {
  workspaceId: string;
  credential: string;
  stateDir?: string;
}): CompanionAuthContext {
  const stateDir = input.stateDir ?? getStateDir();
  const state = readFeedbackState(input.workspaceId, stateDir);
  const companion = state.companion;
  if (!isActiveCompanion(companion)) {
    throw new CompanionError("COMPANION_UNAUTHORIZED", "companion 未配对或已撤销");
  }
  if (!hashEqual(companion.credentialHash, sha256Hex(input.credential))) {
    throw new CompanionError("COMPANION_UNAUTHORIZED", "companion credential 无效");
  }
  return {
    workspaceId: state.workspaceId,
    companionId: companion.companionId,
    bindingId: companion.bindingId,
    epoch: companion.epoch,
    principalFingerprint: companion.principalFingerprint,
    routeCanonical: companion.routeCanonical,
    routeVerified: isRouteAttestationVerified(companion),
  };
}

/** 用 credential 校验 companion；binding/epoch 必须仍匹配。 */
export function verifyCompanionCredential(input: {
  workspaceId: string;
  credential: string;
  stateDir?: string;
}): CompanionAuthContext {
  const stateDir = input.stateDir ?? getStateDir();
  // R5d3 auth-purity：先对 raw 只读状态校验 credential 真实性（零写入）；
  // 无效 credential 直接 401，绝不触发 stale recovery 等任何持久化 mutation。
  const raw = readFeedbackState(input.workspaceId, stateDir);
  const rawCompanion = raw.companion;
  if (!isActiveCompanion(rawCompanion)) {
    throw new CompanionError("COMPANION_UNAUTHORIZED", "companion 未配对或已撤销");
  }
  if (!hashEqual(rawCompanion.credentialHash, sha256Hex(input.credential))) {
    throw new CompanionError("COMPANION_UNAUTHORIZED", "companion credential 无效");
  }
  // Authentication is read-only; lifecycle mutations perform their own recovery.
  const state = raw;
  const companion = rawCompanion;
  if (companion.routeAttestation?.proofKind === "local_user") {
    throw new CompanionError("COMPANION_ROUTE_UNVERIFIED", "本机 route 授权不提供 Feedback principal 证明");
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
    routeVerified: isRouteAttestationVerified(companion),
  };
}

function requireRouteMatch(ctx: CompanionAuthContext, routeCanonical: string): void {
  const normalized = normalizeChatgptRoute(routeCanonical);
  if (!areChatgptConversationRoutesEquivalent(normalized, ctx.routeCanonical)) {
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
  const state = readFeedbackState(input.workspaceId, stateDir);
  // 只暴露当前 companion binding/epoch/fingerprint 对应事件；不做全 history 泄露。
  const scoped = state.events.filter((e) =>
    e.targetBindingId === input.ctx.bindingId
    && e.targetEpoch === input.ctx.epoch
    && e.targetPrincipalFingerprint === input.ctx.principalFingerprint);
  const events = scoped.map((e) => publicCompanionDeliveryEvent(e));
  // E1b2/E1b3a crash/recovery: this companion's reserved / claimed / outcome_unknown.
  // Never expose reservedBy / principal fingerprint / credential material.
  // retired_unknown 不是 in-flight：永久退出 single-flight。
  const inflightEvent = scoped.find((e) =>
    (e.status === "reserved" || e.status === "claimed" || e.status === "outcome_unknown")
    && e.reservedBy === input.ctx.companionId);
  let inFlight: Record<string, unknown> | null = null;
  if (inflightEvent) {
    inFlight = {
      eventId: inflightEvent.eventId,
      status: inflightEvent.status,
      ...(inflightEvent.reservationId ? { reservationId: inflightEvent.reservationId } : {}),
      ...(inflightEvent.attemptId ? { attemptId: inflightEvent.attemptId } : {}),
    };
    // claimed / outcome_unknown：提供 deterministic canonical message，extension 无需自行拼装。
    if ((inflightEvent.status === "claimed" || inflightEvent.status === "outcome_unknown")
      && inflightEvent.attemptId) {
      const delivery = productionFeedbackDelivery(inflightEvent);
      inFlight.message = delivery.message;
      inFlight.messageSha256 = delivery.messageSha256;
    }
  }
  return {
    workspaceId: state.workspaceId,
    bindingId: input.ctx.bindingId,
    epoch: input.ctx.epoch,
    routeCanonical: input.ctx.routeCanonical,
    companionId: input.ctx.companionId,
    enabled: state.binding?.status === "active",
    routeVerification: input.ctx.routeVerified ? "VERIFIED" as const : "PENDING" as const,
    productionEligible: input.ctx.routeVerified === true,
    ...(input.ctx.routeVerified
      ? {}
      : (() => {
          const att = state.companion?.companionId === input.ctx.companionId
            ? state.companion.routeAttestation
            : undefined;
          if (!att || att.status !== "pending") return {};
          return {
            routeAttestation: {
              challengeId: att.challengeId,
              challengeDigest: att.challengeDigest,
              expiresAt: att.expiresAt,
              message: formatRouteAttestationMessage(att.challengeId, att.challengeDigest, input.workspaceId),
            },
          };
        })()),
    pendingReady: scoped.filter((e) => e.status === "ready").length,
    reserved: scoped.filter((e) => e.status === "reserved").length,
    claimed: scoped.filter((e) => e.status === "claimed").length,
    outcomeUnknown: scoped.filter((e) => e.status === "outcome_unknown").length,
    retiredUnknown: scoped.filter((e) => e.status === "retired_unknown").length,
    inFlight,
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
  // New irreversible progression requires origin-route principal attestation.
  assertRouteVerifiedForProduction(input.workspaceId, input.ctx, input.stateDir);
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

/**
 * outcome_unknown → retired_unknown：人工显式放弃，永不重发。
 * 身份/binding/epoch/companion 全部来自 credential context，不信任 caller 提交。
 */
export function companionRetireOutcomeUnknown(input: {
  workspaceId: string;
  ctx: CompanionAuthContext;
  routeCanonical: string;
  eventId: string;
  reservationId: string;
  attemptId: string;
  stateDir?: string;
}): FeedbackEvent {
  requireRouteMatch(input.ctx, input.routeCanonical);
  return retireOutcomeUnknown({
    workspaceId: input.workspaceId,
    bindingId: input.ctx.bindingId,
    epoch: input.ctx.epoch,
    principalFingerprint: input.ctx.principalFingerprint,
    companionId: input.ctx.companionId,
    eventId: input.eventId,
    reservationId: input.reservationId,
    attemptId: input.attemptId,
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
}): { event: FeedbackEvent; attemptId: string; message: string; messageSha256: string } {
  requireRouteMatch(input.ctx, input.routeCanonical);
  // Recovery of an existing reservation is still allowed via legacy reserved path only
  // after verification for NEW begin-send; reserved→claimed is irreversible progression.
  assertRouteVerifiedForProduction(input.workspaceId, input.ctx, input.stateDir);
  const result = beginSend({
    workspaceId: input.workspaceId,
    ...companionAuthInput(input.ctx),
    eventId: input.eventId,
    reservationId: input.reservationId,
    stateDir: input.stateDir,
  });
  // claimed 已 durable；message 由 server 唯一生成，browser 不得重拼。
  const delivery = productionFeedbackDelivery(result.event);
  return {
    event: result.event,
    attemptId: result.attemptId,
    message: delivery.message,
    messageSha256: delivery.messageSha256,
  };
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
  return ackObservedForCompanion({
    workspaceId: input.workspaceId,
    bindingId: input.ctx.bindingId,
    epoch: input.ctx.epoch,
    principalFingerprint: input.ctx.principalFingerprint,
    companionId: input.ctx.companionId,
    eventId: input.eventId,
    attemptId: input.attemptId,
    stateDir: input.stateDir,
  });
}
