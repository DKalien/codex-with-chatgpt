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
  CodexDesktopProductionBackend,
  createCodexDesktopProductionBackend,
} from "./codex-backend.js";
export type {
  ExecutorProductionBackend,
  ProductionSendRequest,
  ProductionSendResult,
} from "./codex-backend.js";
