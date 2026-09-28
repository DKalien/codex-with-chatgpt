/**
 * Stable workflow readiness facade.
 *
 * The model, pure policy resolver, and human projection live in dedicated
 * modules; existing callers continue importing this public surface. The
 * request policy keeps `currentConversation` request-scoped and non-durable.
 */
export {
  WORKFLOW_READINESS_SCHEMA_VERSION,
  WORKFLOW_OVERALL_STATES,
  WORKFLOW_NEXT_ACTIONS,
  WORKFLOW_CHECKPOINT_STATES,
  WORKFLOW_RUNNING_STATES,
  WORKFLOW_RUNTIME_UPGRADE_STATES,
  WORKFLOW_AUTHORIZATION_STATES,
  WORKFLOW_CONNECTOR_CONTRACT_STATES,
  WORKFLOW_DESKTOP_COMPATIBILITY_STATES,
  WORKFLOW_DESKTOP_CURRENT_TARGETS,
  WORKFLOW_DESKTOP_AVAILABILITY,
  WORKFLOW_REMOTE_CONTROLLER_STATES,
  WORKFLOW_CHAT_BINDING_STATES,
  WORKFLOW_CONVERSATION_MODES,
  WORKFLOW_BLOCKER_CODES,
  WORKFLOW_BLOCKER_DETAIL_MAX,
  WORKFLOW_REQUEST_CONVERSATION_STATES,
  WORKFLOW_DESKTOP_ROUTES,
} from "./readiness-model.js";
export type {
  WorkflowOverallState,
  WorkflowNextAction,
  WorkflowCheckpointState,
  ConnectionRunning,
  ConnectionRuntimeUpgrade,
  ConnectionAuthorization,
  ConnectorContractState,
  DesktopCompatibilityState,
  DesktopCurrentTarget,
  DesktopAvailability,
  RemoteControllerState,
  ProjectChatBindingState,
  WorkflowConversationMode,
  WorkflowBlockerCode,
  RequestConversationState,
  DesktopRoute,
  WorkflowConnectionProjection,
  WorkflowConversationProjection,
  WorkflowDesktopProjection,
  WorkflowRemoteProjection,
  WorkflowBlocker,
  WorkflowReadinessInput,
  WorkflowRequestPolicy,
  WorkflowReadinessResult,
} from "./readiness-model.js";
export { resolveWorkflowReadiness } from "./readiness-policy.js";
export { formatWorkflowReadinessHuman } from "./readiness-projection.js";
