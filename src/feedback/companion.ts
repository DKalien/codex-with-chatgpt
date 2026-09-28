/**
 * Companion 稳定公开 facade。
 * Pairing、rebind、route attestation、delivery 和 projection 分置领域模块，
 * 既有 Bridge/MCP 导入路径保持不变。
 */
export { CompanionError, normalizeChatgptRoute } from "./companion-common.js";
export type { CompanionAuthContext } from "./companion-common.js";
export { createPairingIntent, exchangePairingIntent } from "./companion-pairing.js";
export {
  initiateCompanionRebind,
  companionRebindStatus,
  completeCompanionRebind,
} from "./companion-rebind.js";
export { confirmRouteAttestation } from "./companion-route.js";
export {
  verifyCompanionCredential,
  companionPublicState,
  companionReserveNext,
  companionRelease,
  companionRetireOutcomeUnknown,
  companionBeginSend,
  companionAckObserved,
} from "./companion-delivery.js";
export {
  companionStatusForPrincipal,
  companionBootstrapReadiness,
  revokeCompanion,
  readCompanionState,
} from "./companion-projection.js";
