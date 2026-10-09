import { createHash, randomBytes, randomUUID } from "node:crypto";
import { safeEqual } from "../auth/store.js";
import {
  normalizeChatgptConversationRoute,
  ChatGptRouteError,
} from "../chatgpt/route.js";
import {
  COMPANION_ROUTE_ATTEST_TTL_MS,
  FeedbackError,
  routeChallengeDigest,
  type CompanionRecord,
  type CompanionRebindIntent,
  type FeedbackState,
  type RouteAttestation,
} from "./schema.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CompanionError extends FeedbackError {}

/** 统一 route 解析；companion 严格拒绝 query/hash。 */
export function normalizeChatgptRoute(raw: string): string {
  try {
    return normalizeChatgptConversationRoute(raw);
  } catch (error) {
    if (error instanceof ChatGptRouteError) {
      throw new CompanionError("ROUTE_INVALID", error.message);
    }
    throw new CompanionError("ROUTE_INVALID", "delivery route 无效");
  }
}

export function sha256Hex(material: string): string {
  return createHash("sha256").update(material, "utf8").digest("hex");
}

/** 常量时间比较；canonical 实现为 auth/store 的 safeEqual，保留既有导出名。 */
export const hashEqual = safeEqual;

export function mintPairingSecret(): { secret: string; secretHash: string } {
  const secret = `c2c_pair_${randomBytes(24).toString("base64url")}`;
  return { secret, secretHash: sha256Hex(secret) };
}

export function mintCompanionCredential(): { credential: string; credentialHash: string } {
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
  /** paired ≠ origin route verified; production progression requires verified. */
  routeVerified: boolean;
};

export function isActiveCompanion(record: CompanionRecord | null | undefined): record is CompanionRecord {
  return Boolean(record && !record.supersededAt);
}

function mintRouteChallenge(): { challengeId: string } {
  return { challengeId: randomUUID() };
}

/** Server-owned challenge after pair; pairing only registers credential+route. */
export function attachPendingRouteAttestation(
  companionId: string,
  bindingId: string,
  epoch: number,
  routeCanonical: string,
  workspaceId: string,
  nowMs: number,
): RouteAttestation {
  const { challengeId } = mintRouteChallenge();
  const challengeDigest = routeChallengeDigest({
    workspaceId,
    bindingId,
    epoch,
    companionId,
    routeCanonical,
    challengeId,
  });
  return {
    status: "pending",
    challengeId,
    challengeDigest,
    routeCanonical,
    expiresAt: new Date(nowMs + COMPANION_ROUTE_ATTEST_TTL_MS).toISOString(),
  };
}

/**
 * re-pair = transport takeover：存在 reserved/claimed/outcome_unknown 时 fail closed。
 * reserved 须先 explicit release 或等 stale 恢复；claimed/outcome_unknown 禁止换 route。
 */
export function assertNoInFlightDelivery(state: FeedbackState): void {
  if (state.events.some((e) =>
    e.status === "reserved" || e.status === "claimed" || e.status === "outcome_unknown")) {
    throw new CompanionError(
      "COMPANION_REPAIR_BLOCKED",
      "存在 reserved/claimed/outcome_unknown 事件；禁止 re-pair 更换 delivery route",
    );
  }
}

export function companionMatchesBinding(
  companion: CompanionRecord,
  binding: { bindingId: string; epoch: number; principalFingerprint: string },
): boolean {
  return companion.bindingId === binding.bindingId
    && companion.epoch === binding.epoch
    && companion.principalFingerprint === binding.principalFingerprint;
}

export function isActiveRebindIntent(
  intent: CompanionRebindIntent | null | undefined,
  nowMs: number,
): intent is CompanionRebindIntent {
  if (!intent || intent.consumedAt) return false;
  const expiresAt = Date.parse(intent.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > nowMs;
}
