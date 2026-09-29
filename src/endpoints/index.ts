/**
 * Generic Endpoint / Plugin Core 入口。
 *
 * dependency rule: 本包不得依赖 desktop / feedback / browser-companion / mcp / cli / remote。
 */

export {
  CANONICAL_URL_MAX,
  DESCRIPTOR_NAME_MAX,
  EPOCH_MAX,
  ENDPOINT_SAFE_ID,
  EndpointSchemaError,
  EVIDENCE_DETAIL_MAX,
  LOCATOR_KEY,
  LOCATOR_MAX_KEYS,
  LOCATOR_VALUE_MAX,
  OPAQUE_IDENTITY,
  REASON_TEXT_MAX,
  WORKSPACE_ID,
  createExecutorBinding,
  createWebSinkBinding,
  endpointBindingIdSchema,
  endpointCanonicalUrlSchema,
  endpointEpochSchema,
  endpointInstantSchema,
  endpointLocatorSchema,
  endpointPluginIdSchema,
  endpointReasonTextSchema,
  endpointWorkspaceIdSchema,
  endpointWorkspaceRootSchema,
  executorBindingCandidateSchema,
  executorBindingSchema,
  executorBindingStampSchema,
  executorDeliveryTargetSnapshotSchema,
  executorExecutionEvidenceSchema,
  executorTargetIdentityEquals,
  freezeExecutorDeliveryTarget,
  freezeWebSinkSendTarget,
  isEndpointSafeId,
  isOpaqueIdentity,
  locatorExactEqual,
  opaqueIdentitySchema,
  parseExecutorBinding,
  parseExecutorBindingCandidate,
  parseExecutorDeliveryTargetSnapshot,
  parseExecutorExecutionEvidence,
  parseWebSinkBinding,
  parseWebSinkBindingCandidate,
  parseWebSinkSendTargetSnapshot,
  webSinkBindingCandidateSchema,
  webSinkBindingSchema,
  webSinkBindingStampSchema,
  webSinkSendIdentityEquals,
  webSinkSendTargetSnapshotSchema,
} from "./schema.js";
export type {
  EndpointLocator,
  ExecutorBinding,
  ExecutorBindingCandidate,
  ExecutorBindingStamp,
  ExecutorDeliveryTargetSnapshot,
  ExecutorExecutionEvidenceRecord,
  WebSinkBinding,
  WebSinkBindingCandidate,
  WebSinkBindingStamp,
  WebSinkSendTargetSnapshot,
} from "./schema.js";

export {
  DELIVERY_REASON_TEXT_MAX,
  EXECUTION_EVIDENCE_DETAIL_MAX,
  assertDeliveryTargetMatchesBinding,
  assertTrustedEvidenceAllowed,
  assertValidExecutorPluginDescriptor,
  createExecutorPluginRegistry,
  executorDeliveryAcceptanceSchema,
  executorDeliveryAcceptedSchema,
  executorDeliveryRejectedSchema,
  executorPluginCapabilitiesSchema,
  executorPluginDescriptorSchema,
  parseExecutionEvidenceList,
  parseExecutorDeliveryAcceptance,
  parseExecutorPluginDescriptor,
  validateExecutorPlugin,
} from "./executor-contract.js";
export type {
  ExecutorActiveExecutionProjection,
  ExecutorDeliveryAcceptance,
  ExecutorDeliveryRequest,
  ExecutorExecutionEvidence,
  ExecutorPlugin,
  ExecutorPluginCapabilities,
  ExecutorPluginDescriptor,
  ExecutorSessionProjection,
} from "./executor-contract.js";

export { assertSendTargetImmutable } from "./web-sink-contract.js";
export type {
  WebSinkPlugin,
  WebSinkPluginCapabilities,
  WebSinkPluginDescriptor,
  WebSinkSendAttempt,
  WebSinkSendOutcome,
} from "./web-sink-contract.js";

export { PluginRegistryError, createPluginRegistry } from "./registry.js";
export type { PluginRegistry, RegistryPluginIdentity } from "./registry.js";
