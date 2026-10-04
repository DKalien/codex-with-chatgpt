/**
 * R5b Executor Control Plane。
 * Bridge-owned active Executor Binding + production backend delegation。
 */

export {
  EXECUTOR_MESSAGE_MAX_BYTES,
  ExecutorControlError,
  executorControlStateSchema,
  executorMessageSchema,
  isSameExecutorCandidate,
  parseExecutorControlState,
} from "./schema.js";
export type {
  ExecutorAvailability,
  ExecutorControlState,
  ExecutorPluginSummary,
  ExecutorStatusProjection,
} from "./schema.js";

export {
  MAX_EPOCH,
  executorControlFile,
  executorControlInitializedFile,
  nextEpoch,
  readExecutorControl,
  updateExecutorControl,
  updateExecutorControlDetailed,
} from "./store.js";

export {
  getProductionExecutorPlugin,
  hasProductionExecutorPlugin,
  listProductionExecutorPlugins,
  productionExecutorPluginRegistry,
  productionExecutorPlugins,
} from "./registry.js";

export {
  bindCurrentExecutor,
  executorStatus,
  freezeActiveDeliveryTarget,
  listExecutorPlugins,
  readActiveExecutorBinding,
  resolveProductionBackend,
} from "./service.js";
export type { ActiveExecutorBindingResult } from "./service.js";

export {
  EXECUTOR_DISPATCH_MAX_ENTRIES,
  ExecutorDispatchError,
  executorDispatchEntrySchema,
  executorDispatchStateSchema,
  executorDispatchStatusSchema,
  parseExecutorDispatchEntry,
  parseExecutorDispatchState,
} from "./dispatch-schema.js";
export type {
  ExecutorDispatchEntry,
  ExecutorDispatchIntent,
  ExecutorDispatchState,
  ExecutorDispatchStatus,
} from "./dispatch-schema.js";

export {
  executorDispatchFile,
  executorDispatchInitializedFile,
  readExecutorDispatchState,
  updateExecutorDispatchDetailed,
} from "./dispatch-store.js";

export {
  beginExecutorDispatch,
  finalizeExecutorDispatch,
  getProcessDispatchOwnerId,
  hashRequestAuthority,
  markExecutorDispatchOutcomeUnknown,
  readExecutorDispatchEntry,
} from "./dispatch-service.js";
export type {
  BeginExecutorDispatchInput,
  BeginExecutorDispatchResult,
  FinalizeExecutorDispatchInput,
  MarkExecutorDispatchOutcomeUnknownInput,
} from "./dispatch-service.js";

export {
  EndpointSwitchLockError,
  acquireEndpointSwitchLock,
  endpointSwitchLockFile,
  withEndpointSwitchLock,
} from "../endpoint-switch/lock.js";
export type { EndpointSwitchDomain, EndpointSwitchLockHandle, EndpointSwitchReleaseOutcome } from "../endpoint-switch/lock.js";

export {
  CodexDesktopProductionBackend,
  createCodexDesktopProductionBackend,
} from "./codex-backend.js";
export type {
  ExecutorProductionBackend,
  ProductionSendRequest,
  ProductionSendResult,
} from "./codex-backend.js";
