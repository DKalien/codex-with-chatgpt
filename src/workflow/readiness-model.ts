/**
 * G1a unified workflow readiness model.
 * Read-only facts and bounded output types shared by policy/projection layers.
 */

export const WORKFLOW_READINESS_SCHEMA_VERSION = 1 as const;

export const WORKFLOW_OVERALL_STATES = [
  "ready_local",
  "ready_remote",
  "needs_desktop_bind",
  "needs_connection",
  "needs_authorization",
  "needs_project",
  "needs_conversation",
  "resume_checkpoint",
  "busy",
  "blocked",
] as const;
export type WorkflowOverallState = (typeof WORKFLOW_OVERALL_STATES)[number];

export const WORKFLOW_NEXT_ACTIONS = [
  "reuse",
  "resume_checkpoint",
  "bind_current",
  "resume_authorization",
  "repair_connection",
  "bind_project",
  "open_project_chat",
  "use_remote",
  "wait_current_task",
  "resolve_unconfirmed_delivery",
  "stop_unknown",
] as const;
export type WorkflowNextAction = (typeof WORKFLOW_NEXT_ACTIONS)[number];

export const WORKFLOW_CHECKPOINT_STATES = [
  "none",
  "waiting_gpt_plan",
  "waiting_gpt_review",
  "waiting_user",
  "executing",
  "blocked",
  "done",
] as const;
export type WorkflowCheckpointState = (typeof WORKFLOW_CHECKPOINT_STATES)[number];

export const WORKFLOW_RUNNING_STATES = ["running", "stopped", "unknown"] as const;
export type ConnectionRunning = (typeof WORKFLOW_RUNNING_STATES)[number];

export const WORKFLOW_RUNTIME_UPGRADE_STATES = ["current", "pending", "unknown"] as const;
export type ConnectionRuntimeUpgrade = (typeof WORKFLOW_RUNTIME_UPGRADE_STATES)[number];

export const WORKFLOW_AUTHORIZATION_STATES = ["authorized", "missing", "unknown"] as const;
export type ConnectionAuthorization = (typeof WORKFLOW_AUTHORIZATION_STATES)[number];

/** Connector contract: missing/unknown version is NOT "none authorization" — fail closed. */
export const WORKFLOW_CONNECTOR_CONTRACT_STATES = ["current", "unknown"] as const;
export type ConnectorContractState = (typeof WORKFLOW_CONNECTOR_CONTRACT_STATES)[number];

/** Desktop OAuth compatibility from local AuthStore summary (not MCP request-scoped). */
export const WORKFLOW_DESKTOP_COMPATIBILITY_STATES = [
  "current",
  "legacy",
  "incomplete",
  "none",
  "unknown",
  "corrupt",
] as const;
export type DesktopCompatibilityState = (typeof WORKFLOW_DESKTOP_COMPATIBILITY_STATES)[number];

export const WORKFLOW_DESKTOP_CURRENT_TARGETS = ["exact", "different", "unavailable", "unknown"] as const;
export type DesktopCurrentTarget = (typeof WORKFLOW_DESKTOP_CURRENT_TARGETS)[number];

export const WORKFLOW_DESKTOP_AVAILABILITY = ["available", "busy", "unavailable", "unknown"] as const;
export type DesktopAvailability = (typeof WORKFLOW_DESKTOP_AVAILABILITY)[number];

export const WORKFLOW_REMOTE_CONTROLLER_STATES = ["online", "offline", "unknown"] as const;
export type RemoteControllerState = (typeof WORKFLOW_REMOTE_CONTROLLER_STATES)[number];

export const WORKFLOW_CHAT_BINDING_STATES = [
  "same_thread",
  "other_thread",
  "unowned",
  "none",
  "current_thread_unknown",
] as const;
export type ProjectChatBindingState = (typeof WORKFLOW_CHAT_BINDING_STATES)[number];

export const WORKFLOW_CONVERSATION_MODES = ["project", "long-chat", "unknown"] as const;
export type WorkflowConversationMode = (typeof WORKFLOW_CONVERSATION_MODES)[number];

/**
 * Bounded blocker codes for resolver + G2 projection + CLI failure.
 * MCP output schema and runtime projections share this source of truth.
 */
export const WORKFLOW_BLOCKER_CODES = [
  "session_corrupt",
  "desktop_unresolved_delivery",
  "remote_needs_reconciliation",
  "bridge_state_unknown",
  "bridge_stopped",
  "runtime_upgrade_unknown",
  "runtime_upgrade_pending",
  "connector_contract_unknown",
  "desktop_compatibility_unknown",
  "authorization_unknown",
  "authorization_missing",
  "desktop_compatibility_not_current",
  "desktop_target_unknown",
  "remote_controller_unknown",
  "checkpoint_blocked",
  "checkpoint_executing",
  "remote_active_work",
  "checkpoint_unfinished",
  "project_not_ready",
  "project_chat_not_same_thread",
  "conversation_not_reusable",
  "desktop_binding_busy",
  "desktop_delivery_unknown",
  "desktop_delivery_unavailable",
  "remote_request_scope_missing",
  "remote_request_scope_incomplete",
  "desktop_target_mismatch",
  "desktop_not_bound",
  "desktop_unavailable",
  "desktop_not_enabled",
  "desktop_bind_required",
  "workflow_projection_failed",
  "workflow_status_failed",
] as const;
export type WorkflowBlockerCode = (typeof WORKFLOW_BLOCKER_CODES)[number];

/** Blocker detail is enum-derived; keep a hard length bound in MCP schema. */
export const WORKFLOW_BLOCKER_DETAIL_MAX = 64;

/** Request conversation availability for this MCP call only (not durable chatKnown). */
export const WORKFLOW_REQUEST_CONVERSATION_STATES = ["available", "unavailable"] as const;
export type RequestConversationState = (typeof WORKFLOW_REQUEST_CONVERSATION_STATES)[number];

/**
 * Desktop readiness route:
 * - current_context: local CLI — requires currentIdentity === saved binding (exact).
 * - saved_binding: MCP request — no meaningful Bridge current Desktop thread; reuse
 *   persisted binding via configured+enabled+inspect availability.
 */
export const WORKFLOW_DESKTOP_ROUTES = ["current_context", "saved_binding"] as const;
export type DesktopRoute = (typeof WORKFLOW_DESKTOP_ROUTES)[number];

export interface WorkflowConnectionProjection {
  running: ConnectionRunning;
  runtimeUpgrade: ConnectionRuntimeUpgrade;
  authorization: ConnectionAuthorization;
  connectorContract: ConnectorContractState;
  desktopCompatibility: DesktopCompatibilityState;
}

export interface WorkflowConversationProjection {
  mode: WorkflowConversationMode;
  projectReady: boolean;
  /**
   * Durable/local reusable conversation only (G1a/G1b).
   * MCP request conversation identity is requestContext.conversationIdentity — never chatKnown.
   */
  chatKnown: boolean;
  /** Project thread-scoped chat ownership; long-chat uses "none". MCP source always "none". */
  chatBinding: ProjectChatBindingState;
  checkpoint: WorkflowCheckpointState;
  sessionCorrupt: boolean;
}

export interface WorkflowDesktopProjection {
  configured: boolean;
  enabled: boolean;
  /** From currentIdentity vs saved binding. Not send-idle. */
  currentTarget: DesktopCurrentTarget;
  /** From Desktop inspect/status semantics. currentIdentity success ≠ available. */
  bindingAvailability: DesktopAvailability;
  unresolvedDelivery: boolean;
}

export interface WorkflowRemoteProjection {
  enabled: boolean;
  controller: RemoteControllerState;
  activeWork: boolean;
  needsReconciliation: boolean;
}

export interface WorkflowBlocker {
  code: WorkflowBlockerCode;
  detail?: string;
}

export interface WorkflowReadinessInput {
  workspaceId: string;
  workspaceName: string;
  connection: WorkflowConnectionProjection;
  conversation: WorkflowConversationProjection;
  desktop: WorkflowDesktopProjection;
  remote: WorkflowRemoteProjection;
  /** Injected by caller when time is needed; resolver never reads wall-clock itself. */
  now?: number;
}

/**
 * Optional request policy for MCP projection; CLI omits for G1a parity.
 * `currentConversation` is this MCP request only — not Project membership, not same_thread.
 * `desktopRoute` is explicit MCP Desktop route — never inferred from currentConversation.
 */
export interface WorkflowRequestPolicy {
  remoteControl?: "current" | "incomplete" | "none";
  currentConversation?: RequestConversationState;
  /** MCP must pass "saved_binding"; CLI omits → current_context exact-identity gate. */
  desktopRoute?: DesktopRoute;
}

export interface WorkflowReadinessResult {
  schemaVersion: typeof WORKFLOW_READINESS_SCHEMA_VERSION;
  workspaceId: string;
  workspaceName: string;
  overall: WorkflowOverallState;
  nextAction: WorkflowNextAction;
  connection: WorkflowConnectionProjection;
  conversation: WorkflowConversationProjection;
  desktop: WorkflowDesktopProjection;
  remote: WorkflowRemoteProjection;
  blockers: WorkflowBlocker[];
}
