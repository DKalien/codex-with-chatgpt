import { randomUUID } from "node:crypto";
import { getStateDir } from "../config/paths.js";
import {
  requireConversationPrincipal,
  type ConversationPrincipal,
} from "../mcp/conversation-principal.js";
import {
  COMPANION_PAIRING_TTL_MS,
  FeedbackError,
  formatRouteAttestationMessage,
  type CompanionRecord,
  type PairingIntent,
} from "./schema.js";
import { mutateCompanionPairing } from "./companion-state.js";
import {
  assertNoInFlightDelivery,
  attachPendingRouteAttestation,
  hashEqual,
  mintCompanionCredential,
  mintPairingSecret,
  normalizeChatgptRoute,
  sha256Hex,
  CompanionError,
} from "./companion-common.js";

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
  routeVerification: "PENDING" | "VERIFIED";
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
    const companionId = randomUUID();
    const routeAttestation = attachPendingRouteAttestation(
      companionId,
      intent.bindingId,
      intent.epoch,
      route,
      input.workspaceId,
      nowMs,
    );
    const companion: CompanionRecord = {
      version: 1,
      companionId,
      bindingId: intent.bindingId,
      epoch: intent.epoch,
      principalFingerprint: intent.principalFingerprint,
      credentialHash,
      routeCanonical: route,
      pairedAt: new Date(nowMs).toISOString(),
      routeAttestation,
    };
    const nowIso = new Date(nowMs).toISOString();
    // 覆盖写入：旧 companion credential hash 立即失效（re-pair supersede）。
    return {
      state: {
        ...state,
        pairingIntent: { ...intent, consumedAt: nowIso },
        companion,
        rebindIntent: null,
        rebindPredecessor: null,
      },
      result: {
        companionId: companion.companionId,
        credential,
        workspaceId: input.workspaceId,
        bindingId: companion.bindingId,
        epoch: companion.epoch,
        routeCanonical: companion.routeCanonical,
        routeVerification: "PENDING" as const,
        routeAttestation: {
          challengeId: routeAttestation.challengeId,
          challengeDigest: routeAttestation.challengeDigest,
          expiresAt: routeAttestation.expiresAt,
          message: formatRouteAttestationMessage(
            routeAttestation.challengeId,
            routeAttestation.challengeDigest,
            input.workspaceId,
          ),
        },
      },
    };
  });
}
