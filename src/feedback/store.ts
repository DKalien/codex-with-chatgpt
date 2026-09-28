/**
 * Feedback 稳定公开 facade。
 *
 * Domain implementations live in schema/state-store/receiver/projection-store/
 * 领域实现位于 schema/state-store/receiver/projection-store/delivery-lifecycle，
 * 既有调用方继续从本模块导入。
 */
export {
  CODEX_FEEDBACK_SCOPE,
  FEEDBACK_EVENT_KIND,
  FINAL_RECEIPT_REQUIRED_EVENT_KIND,
  FEEDBACK_CONTROL_EVENT_VERSION,
  FINAL_RECEIPT_REQUIRED_REASONS,
  FEEDBACK_CLAIM_STALE_MS,
  FEEDBACK_RESERVATION_STALE_MS,
  COMPANION_PAIRING_TTL_MS,
  COMPANION_ROUTE_ATTEST_TTL_MS,
  FeedbackError,
  feedbackBindingSchema,
  c2cExecutedEventSchema,
  finalReceiptRequiredInputSchema,
  finalReceiptRequiredEventSchema,
  feedbackEventSchema,
  pairingIntentSchema,
  routeAttestationSchema,
  companionRecordSchema,
  companionRebindIntentSchema,
  companionRebindPredecessorSchema,
  feedbackStateSchema,
  routeChallengeDigest,
  formatRouteAttestationMessage,
  isRouteAttestationVerified,
} from "./schema.js";
export type {
  FeedbackBinding,
  C2CExecutedFeedbackEvent,
  FinalReceiptRequiredEvent,
  FeedbackEvent,
  FeedbackState,
  PairingIntent,
  CompanionRecord,
  RouteAttestation,
  CompanionRebindIntent,
} from "./schema.js";
export {
  feedbackStateFile,
  readFeedbackState,
  ensureFeedbackState,
  recoverStaleInMemory,
  recoverStaleFeedback,
} from "./state-store.js";
export { putPairingIntent, mutateCompanionPairing } from "./companion-state.js";
export {
  feedbackEventId,
  finalReceiptRequiredEventId,
  repairFinalReceiptRequired,
  repairForwardFeedbackControlEvents,
} from "./projection-store.js";
export { enableReceiver, takeoverReceiver, stopReceiver } from "./receiver.js";
export {
  applyProjection,
  publicFeedbackEvent,
  publicCompanionDeliveryEvent,
  feedbackStatusSummary,
} from "./projection-store.js";
export {
  claimNext,
  ackObserved,
  reserveNext,
  releaseReservation,
  beginSend,
  retireOutcomeUnknown,
} from "./delivery-lifecycle.js";
export type { FinalReceiptRepairResult } from "./projection-store.js";
