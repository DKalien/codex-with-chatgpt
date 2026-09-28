import { randomUUID } from "node:crypto";
import { getStateDir } from "../config/paths.js";
import {
  FeedbackError,
  formatRouteAttestationMessage,
  routeChallengeDigest,
  type CompanionRecord,
  type CompanionRebindIntent,
} from "./schema.js";
import { readFeedbackState } from "./state-store.js";
import { mutateCompanionPairing } from "./companion-state.js";
import {
  assertNoInFlightDelivery,
  attachPendingRouteAttestation,
  CompanionError,
  hashEqual,
  isActiveCompanion,
  isActiveRebindIntent,
  mintCompanionCredential,
  normalizeChatgptRoute,
  sha256Hex,
} from "./companion-common.js";

export function initiateCompanionRebind(input: {
  workspaceId: string;
  credential: string;
  routeCanonical: string;
  stateDir?: string;
  nowMs?: number;
}): {
  companionId: string;
  workspaceId: string;
  bindingId: string;
  epoch: number;
  routeCanonical: string;
  routeVerification: "PENDING";
  routeAttestation: {
    challengeId: string;
    challengeDigest: string;
    expiresAt: string;
    message: string;
  };
} {
  const stateDir = input.stateDir ?? getStateDir();
  const nowMs = input.nowMs ?? Date.now();
  const route = normalizeChatgptRoute(input.routeCanonical);
  return mutateCompanionPairing(input.workspaceId, stateDir, (state) => {
    if (!state.binding || state.binding.status !== "active") {
      throw new FeedbackError("FEEDBACK_NOT_ENABLED", "production feedback 未启用");
    }
    const predecessor = state.companion;
    const eligibility = state.rebindPredecessor;
    if (!isActiveCompanion(predecessor)
      || !hashEqual(predecessor.credentialHash, sha256Hex(input.credential))) {
      throw new CompanionError("COMPANION_UNAUTHORIZED", "旧 companion credential 无效");
    }
    if (!eligibility
      || eligibility.companionId !== predecessor.companionId
      || eligibility.previousBindingId !== predecessor.bindingId
      || eligibility.previousEpoch !== predecessor.epoch
      || eligibility.bindingId !== state.binding.bindingId
      || eligibility.epoch !== state.binding.epoch
      || state.binding.epoch !== predecessor.epoch + 1
      || state.binding.bindingId === predecessor.bindingId) {
      throw new CompanionError("COMPANION_REBIND_NOT_SUCCESSOR", "仅允许立即下一代 binding rebind");
    }
    if (isActiveRebindIntent(state.rebindIntent, nowMs)) {
      throw new CompanionError("COMPANION_REBIND_ALREADY_INITIATED", "旧 companion 的 rebind 已启动");
    }
    assertNoInFlightDelivery(state);
    const companionId = randomUUID();
    const routeAttestation = attachPendingRouteAttestation(
      companionId,
      state.binding.bindingId,
      state.binding.epoch,
      route,
      input.workspaceId,
      nowMs,
    );
    const intent: CompanionRebindIntent = {
      version: 1,
      companionId,
      previousBindingId: predecessor.bindingId,
      previousEpoch: predecessor.epoch,
      bindingId: state.binding.bindingId,
      epoch: state.binding.epoch,
      principalFingerprint: state.binding.principalFingerprint,
      routeCanonical: route,
      initiatedAt: new Date(nowMs).toISOString(),
      expiresAt: routeAttestation.expiresAt,
      routeAttestation,
    };
    return {
      state: { ...state, rebindIntent: intent },
      result: {
        companionId,
        workspaceId: input.workspaceId,
        bindingId: intent.bindingId,
        epoch: intent.epoch,
        routeCanonical: route,
        routeVerification: "PENDING" as const,
        routeAttestation: {
          challengeId: routeAttestation.challengeId,
          challengeDigest: routeAttestation.challengeDigest,
          expiresAt: routeAttestation.expiresAt,
          message: formatRouteAttestationMessage(
            routeAttestation.challengeId,
            routeAttestation.challengeDigest,
          ),
        },
      },
    };
  });
}

/** 只读查询 active predecessor 的 immediate-successor rebind 状态。 */
export function companionRebindStatus(input: {
  workspaceId: string;
  credential: string;
  routeCanonical: string;
  challengeId: string;
  stateDir?: string;
  nowMs?: number;
}): {
  state: "PENDING" | "CONFIRMED" | "EXPIRED";
  workspaceId: string;
  bindingId: string;
  epoch: number;
  companionId: string;
  routeCanonical: string;
  challengeId: string;
} {
  const route = normalizeChatgptRoute(input.routeCanonical);
  const state = readFeedbackState(input.workspaceId, input.stateDir ?? getStateDir());
  const predecessor = state.companion;
  const binding = state.binding;
  const eligibility = state.rebindPredecessor;
  const intent = state.rebindIntent;
  const unauthorized = (): never => {
    throw new CompanionError("COMPANION_UNAUTHORIZED", "旧 companion credential 或 rebind 身份无效");
  };

  if (!isActiveCompanion(predecessor)
    || !hashEqual(predecessor.credentialHash, sha256Hex(input.credential))) {
    return unauthorized();
  }
  if (!binding || binding.status !== "active" || !eligibility || !intent || intent.consumedAt) {
    return unauthorized();
  }
  if (binding.bindingId !== intent.bindingId
    || binding.epoch !== intent.epoch
    || binding.principalFingerprint !== intent.principalFingerprint
    || predecessor.bindingId !== intent.previousBindingId
    || predecessor.epoch !== intent.previousEpoch
    || binding.epoch !== predecessor.epoch + 1
    || binding.bindingId === predecessor.bindingId
    || eligibility.companionId !== predecessor.companionId
    || eligibility.previousBindingId !== predecessor.bindingId
    || eligibility.previousEpoch !== predecessor.epoch
    || eligibility.bindingId !== binding.bindingId
    || eligibility.epoch !== binding.epoch
    || intent.routeCanonical !== route
    || intent.routeAttestation.routeCanonical !== intent.routeCanonical
    || intent.routeAttestation.challengeId !== input.challengeId
    || !hashEqual(intent.routeAttestation.challengeDigest, routeChallengeDigest({
      workspaceId: state.workspaceId,
      bindingId: intent.bindingId,
      epoch: intent.epoch,
      companionId: intent.companionId,
      routeCanonical: intent.routeCanonical,
      challengeId: intent.routeAttestation.challengeId,
    }))) {
    return unauthorized();
  }

  assertNoInFlightDelivery(state);

  const nowMs = input.nowMs ?? Date.now();
  const expired = Date.parse(intent.expiresAt) <= nowMs
    || Date.parse(intent.routeAttestation.expiresAt) <= nowMs;
  return {
    state: expired
      ? "EXPIRED"
      : intent.confirmedAt && intent.routeAttestation.status === "verified"
        ? "CONFIRMED"
        : "PENDING",
    workspaceId: state.workspaceId,
    bindingId: binding.bindingId,
    epoch: binding.epoch,
    companionId: intent.companionId,
    routeCanonical: intent.routeCanonical,
    challengeId: intent.routeAttestation.challengeId,
  };
}

export function completeCompanionRebind(input: {
  workspaceId: string;
  credential: string;
  challengeId: string;
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
  challengeId: string;
  routeVerification: "VERIFIED";
} {
  const stateDir = input.stateDir ?? getStateDir();
  const nowMs = input.nowMs ?? Date.now();
  const route = normalizeChatgptRoute(input.routeCanonical);
  return mutateCompanionPairing(input.workspaceId, stateDir, (state) => {
    const predecessor = state.companion;
    const eligibility = state.rebindPredecessor;
    const intent = state.rebindIntent;
    if (!isActiveCompanion(predecessor)
      || !hashEqual(predecessor.credentialHash, sha256Hex(input.credential))) {
      throw new CompanionError("COMPANION_UNAUTHORIZED", "旧 companion credential 无效");
    }
    if (!intent || intent.consumedAt) {
      throw new CompanionError("COMPANION_REBIND_INVALID", "rebind intent 不存在或已消费");
    }
    if (Date.parse(intent.expiresAt) <= nowMs) {
      throw new CompanionError("COMPANION_REBIND_EXPIRED", "rebind intent 已过期");
    }
    if (intent.routeAttestation.challengeId !== input.challengeId
      || intent.routeCanonical !== route) {
      throw new CompanionError("COMPANION_REBIND_INVALID", "rebind completion 身份不匹配");
    }
    if (!intent.confirmedAt || intent.routeAttestation.status !== "verified") {
      throw new CompanionError("COMPANION_REBIND_NOT_CONFIRMED", "当前 Chat 尚未完成 route attestation");
    }
    if (!eligibility
      || eligibility.companionId !== predecessor.companionId
      || eligibility.previousBindingId !== intent.previousBindingId
      || eligibility.previousEpoch !== intent.previousEpoch
      || eligibility.bindingId !== intent.bindingId
      || eligibility.epoch !== intent.epoch
      || !state.binding || state.binding.status !== "active"
      || state.binding.bindingId !== intent.bindingId
      || state.binding.epoch !== intent.epoch
      || state.binding.principalFingerprint !== intent.principalFingerprint
      || predecessor.bindingId !== intent.previousBindingId
      || predecessor.epoch !== intent.previousEpoch
      || state.binding.epoch !== predecessor.epoch + 1) {
      throw new CompanionError("COMPANION_REBIND_NOT_SUCCESSOR", "rebind binding 已变化");
    }
    assertNoInFlightDelivery(state);
    const { credential, credentialHash } = mintCompanionCredential();
    const nowIso = new Date(nowMs).toISOString();
    const companion: CompanionRecord = {
      version: 1,
      companionId: intent.companionId,
      bindingId: intent.bindingId,
      epoch: intent.epoch,
      principalFingerprint: intent.principalFingerprint,
      credentialHash,
      routeCanonical: intent.routeCanonical,
      pairedAt: nowIso,
      routeAttestation: intent.routeAttestation,
    };
    return {
      state: {
        ...state,
        companion,
        rebindIntent: { ...intent, consumedAt: nowIso },
        rebindPredecessor: null,
      },
      result: {
        companionId: companion.companionId,
        credential,
        workspaceId: input.workspaceId,
        bindingId: companion.bindingId,
        epoch: companion.epoch,
        routeCanonical: companion.routeCanonical,
        challengeId: intent.routeAttestation.challengeId,
        routeVerification: "VERIFIED" as const,
      },
    };
  });
}
