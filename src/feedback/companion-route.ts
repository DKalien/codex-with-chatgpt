import { getStateDir } from "../config/paths.js";
import {
  requireConversationPrincipal,
  type ConversationPrincipal,
} from "../mcp/conversation-principal.js";
import {
  FeedbackError,
  isRouteAttestationVerified,
  routeChallengeDigest,
  type RouteAttestation,
} from "./schema.js";
import { recoverStaleFeedback } from "./state-store.js";
import { mutateCompanionPairing } from "./companion-state.js";
import {
  CompanionError,
  hashEqual,
  isActiveCompanion,
  type CompanionAuthContext,
} from "./companion-common.js";

/** challengeDigest 双查之一：存档 digest 与提交 digest 常量时间比对。 */
function assertStoredChallengeDigest(att: { challengeDigest: string }, inputChallengeDigest: string): void {
  if (!hashEqual(att.challengeDigest, inputChallengeDigest)) {
    throw new CompanionError("ROUTE_ATTESTATION_INVALID", "challengeDigest 不匹配");
  }
}

/** challengeDigest 双查之二：按绑定事实重算 digest 并比对（防存档篡改）。 */
function assertRecomputedChallengeDigest(
  facts: Parameters<typeof routeChallengeDigest>[0],
  inputChallengeDigest: string,
  mismatchMessage: string,
): void {
  if (!hashEqual(routeChallengeDigest(facts), inputChallengeDigest)) {
    throw new CompanionError("ROUTE_ATTESTATION_INVALID", mismatchMessage);
  }
}

/**
 * Trusted MCP confirm: origin conversation principal proves routeCanonical.
 * Wrong principal rejects WITHOUT consuming the challenge.
 */
export function confirmRouteAttestation(input: {
  workspaceId: string;
  principal: ConversationPrincipal;
  challengeId: string;
  challengeDigest: string;
  stateDir?: string;
  nowMs?: number;
}): {
  verified: true;
  companionId: string;
  routeCanonical: string;
  routeVerifiedAt: string;
} {
  requireConversationPrincipal(input.principal);
  const stateDir = input.stateDir ?? getStateDir();
  const nowMs = input.nowMs ?? Date.now();
  return mutateCompanionPairing(input.workspaceId, stateDir, (state) => {
    if (!state.binding || state.binding.status !== "active") {
      throw new FeedbackError("FEEDBACK_NOT_ENABLED", "production feedback 未启用");
    }
    if (state.binding.principalFingerprint !== input.principal.fingerprint) {
      // 不消费 challenge：真正 originating Chat 仍可完成证明。
      throw new FeedbackError("FEEDBACK_PRINCIPAL_MISMATCH", "route attestation 主体与 binding 不一致");
    }
    const rebind = state.rebindIntent;
    if (rebind?.routeAttestation.challengeId === input.challengeId) {
      const att = rebind.routeAttestation;
      assertStoredChallengeDigest(att, input.challengeDigest);
      if (rebind.consumedAt || rebind.confirmedAt || att.status === "verified" || att.consumedAt) {
        throw new CompanionError("ROUTE_ATTESTATION_INVALID", "challenge 已消费");
      }
      if (Date.parse(rebind.expiresAt) <= nowMs || Date.parse(att.expiresAt) <= nowMs) {
        throw new CompanionError("ROUTE_ATTESTATION_EXPIRED", "route attestation challenge 已过期");
      }
      if (state.binding.bindingId !== rebind.bindingId
        || state.binding.epoch !== rebind.epoch
        || state.binding.principalFingerprint !== rebind.principalFingerprint
        || att.routeCanonical !== rebind.routeCanonical) {
        throw new CompanionError("ROUTE_ATTESTATION_INVALID", "rebind challenge 与当前 binding 不一致");
      }
      assertRecomputedChallengeDigest({
        workspaceId: state.workspaceId,
        bindingId: rebind.bindingId,
        epoch: rebind.epoch,
        companionId: rebind.companionId,
        routeCanonical: rebind.routeCanonical,
        challengeId: att.challengeId,
      }, input.challengeDigest, "challengeDigest 与 rebind 事实不匹配");
      const routeVerifiedAt = new Date(nowMs).toISOString();
      const verifiedAtt: RouteAttestation = {
        ...att,
        status: "verified",
        verifiedAt: routeVerifiedAt,
        consumedAt: routeVerifiedAt,
      };
      return {
        state: {
          ...state,
          rebindIntent: {
            ...rebind,
            confirmedAt: routeVerifiedAt,
            routeAttestation: verifiedAtt,
          },
        },
        result: {
          verified: true as const,
          companionId: rebind.companionId,
          routeCanonical: rebind.routeCanonical,
          routeVerifiedAt,
        },
      };
    }
    const companion = state.companion;
    if (!isActiveCompanion(companion)) {
      throw new CompanionError("COMPANION_UNAUTHORIZED", "companion 未配对或已撤销");
    }
    if (
      companion.bindingId !== state.binding.bindingId
      || companion.epoch !== state.binding.epoch
      || companion.principalFingerprint !== state.binding.principalFingerprint
    ) {
      throw new CompanionError("COMPANION_EPOCH_STALE", "companion 绑定代次已失效");
    }
    const att = companion.routeAttestation;
    if (!att) {
      throw new CompanionError("ROUTE_ATTESTATION_PENDING", "companion route 尚未验证");
    }
    if (att.challengeId !== input.challengeId) {
      throw new CompanionError("ROUTE_ATTESTATION_INVALID", "challengeId 不匹配");
    }
    assertStoredChallengeDigest(att, input.challengeDigest);
    if (att.consumedAt) {
      throw new CompanionError("ROUTE_ATTESTATION_INVALID", "challenge 已消费");
    }
    if (att.status === "verified") {
      throw new CompanionError("ROUTE_ATTESTATION_INVALID", "challenge 已完成验证");
    }
    if (Date.parse(att.expiresAt) <= nowMs) {
      throw new CompanionError("ROUTE_ATTESTATION_EXPIRED", "route attestation challenge 已过期");
    }
    if (att.routeCanonical !== companion.routeCanonical) {
      throw new CompanionError("ROUTE_ATTESTATION_INVALID", "challenge route 与 companion 不一致");
    }
    assertRecomputedChallengeDigest({
      workspaceId: state.workspaceId,
      bindingId: companion.bindingId,
      epoch: companion.epoch,
      companionId: companion.companionId,
      routeCanonical: companion.routeCanonical,
      challengeId: att.challengeId,
    }, input.challengeDigest, "challengeDigest 与绑定事实不匹配");
    const routeVerifiedAt = new Date(nowMs).toISOString();
    const verifiedAtt = {
      ...att,
      status: "verified" as const,
      verifiedAt: routeVerifiedAt,
      consumedAt: routeVerifiedAt,
    };
    return {
      state: {
        ...state,
        companion: { ...companion, routeAttestation: verifiedAtt },
      },
      result: {
        verified: true as const,
        companionId: companion.companionId,
        routeCanonical: companion.routeCanonical,
        routeVerifiedAt,
      },
    };
  });
}

export function assertRouteVerifiedForProduction(
  workspaceId: string,
  ctx: CompanionAuthContext,
  stateDir?: string,
): void {
  const state = recoverStaleFeedback(workspaceId, stateDir ?? getStateDir());
  const companion = state.companion;
  if (!isActiveCompanion(companion) || companion.companionId !== ctx.companionId) {
    throw new CompanionError("COMPANION_UNAUTHORIZED", "companion 未配对或已撤销");
  }
  if (!isRouteAttestationVerified(companion)) {
    throw new CompanionError(
      "COMPANION_ROUTE_UNVERIFIED",
      "delivery route 尚未通过 principal attestation；禁止 production reserve/begin-send",
    );
  }
}
