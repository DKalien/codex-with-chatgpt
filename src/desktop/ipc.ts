export type {
  DesktopDiagnosis,
  DesktopExecutionInfo,
  DesktopIpcConnection,
  DesktopIpcOptions,
  DesktopOriginAlias,
  DesktopResultActivityItemType,
  DesktopResultActivityMarker,
  DesktopResultActivityMarkerObservation,
  DesktopResultClassification,
  DesktopResultClassificationKind,
  DesktopResultContext,
  DesktopResultOwnership,
  DesktopResultOwnershipExpectation,
  DesktopResultOwnershipKind,
  DesktopResultTerminalFence,
  DesktopResultTerminalFenceKind,
  DesktopRuntimeFence,
  DesktopResultTurnStatus,
  DesktopTarget,
  DesktopTargetInfo,
  DesktopUnknownReconcileExpectation,
  DesktopUnknownReconcileObservation,
  NativeContinuationSignature,
} from "./ipc-contracts.js";
export {
  DESKTOP_RESULT_ACTIVITY_ITEM_TYPES,
  MAX_RESULT_CONTINUATION_CHAIN,
} from "./ipc-contracts.js";
export { DesktopIpcClient, desktopIpc } from "./ipc-client.js";
export { resolveDesktopHelperPath } from "./ipc-transport.js";
export {
  validateDesktopDiagnosis,
  validateDesktopResultActivityMarker,
  validateDesktopResultActivityMarkerObservation,
  validateDesktopResultTerminalFence,
  validateRuntimeFence,
  validateDesktopWireMessage,
  validateMessage as validateDesktopMessage,
  validateTarget as validateDesktopTarget,
} from "./ipc-validation.js";
export { ERROR_MESSAGES as DESKTOP_IPC_ERROR_MESSAGES } from "./ipc-errors.js";
