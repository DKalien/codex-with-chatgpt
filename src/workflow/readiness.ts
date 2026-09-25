/**
 * G1a unified workflow readiness — pure decision layer.
 * Read-only facts in, bounded overall/nextAction out.
 * Never authorizes, binds, enables, repairs, or mutates state.
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

const BLOCKED_CONTRACTS = new Set(["unknown", "corrupt"]);

function finish(
  input: WorkflowReadinessInput,
  overall: WorkflowOverallState,
  nextAction: WorkflowNextAction,
  blockers: WorkflowBlocker[],
): WorkflowReadinessResult {
  return {
    schemaVersion: WORKFLOW_READINESS_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    overall: WORKFLOW_OVERALL_STATES.includes(overall) ? overall : "blocked",
    nextAction: WORKFLOW_NEXT_ACTIONS.includes(nextAction) ? nextAction : "stop_unknown",
    connection: input.connection,
    conversation: input.conversation,
    desktop: input.desktop,
    remote: input.remote,
    blockers,
  };
}

function remoteActiveWork(remote: WorkflowRemoteProjection): boolean {
  return remote.activeWork === true;
}

function remoteSafelyReady(remote: WorkflowRemoteProjection): boolean {
  return (
    remote.enabled === true
    && remote.controller === "online"
    && !remote.activeWork
    && !remote.needsReconciliation
  );
}

/**
 * Local Desktop identity reuse gate (current_context only).
 * ready_local requires fully confirmed delivery inspect (available), not identity alone.
 */
function desktopLocalReady(desktop: WorkflowDesktopProjection): boolean {
  return (
    desktop.configured === true
    && desktop.enabled === true
    && desktop.currentTarget === "exact"
    && desktop.bindingAvailability === "available"
    && !desktop.unresolvedDelivery
  );
}

/**
 * MCP saved_binding route: Bridge has no meaningful current Desktop thread.
 * Reuse the user-confirmed persisted binding via inspect availability; never require exact identity.
 */
function desktopSavedBindingReady(desktop: WorkflowDesktopProjection): boolean {
  return (
    desktop.configured === true
    && desktop.enabled === true
    && desktop.bindingAvailability === "available"
    && !desktop.unresolvedDelivery
  );
}

function desktopRouteOf(requestPolicy?: WorkflowRequestPolicy): DesktopRoute {
  return requestPolicy?.desktopRoute === "saved_binding" ? "saved_binding" : "current_context";
}

function conversationReady(conversation: WorkflowConversationProjection): boolean {
  if (conversation.mode === "project") {
    return conversation.projectReady === true && conversation.chatKnown === true;
  }
  if (conversation.mode === "long-chat") {
    return conversation.chatKnown === true;
  }
  return false;
}

/**
 * Durable chatKnown OR explicit MCP request conversation for this turn.
 * Request conversation never flips chatKnown / chatBinding / Project membership.
 */
function conversationUsable(
  conversation: WorkflowConversationProjection,
  requestPolicy?: WorkflowRequestPolicy,
): { ok: boolean; viaRequest: boolean } {
  if (conversationReady(conversation)) return { ok: true, viaRequest: false };
  if (requestPolicy?.currentConversation === "available") return { ok: true, viaRequest: true };
  return { ok: false, viaRequest: false };
}

/**
 * Pure capability resolver.
 *
 * ready_local / reuse:
 * - current_context (CLI): exact current Desktop identity + enabled + inspect available.
 * - saved_binding (MCP): persisted binding configured+enabled+inspect available; no exact identity.
 * Never rewrites saved binding. MCP still needs request-scoped authorization/compatibility/conversation gates.
 */
export function resolveWorkflowReadiness(
  input: WorkflowReadinessInput,
  requestPolicy?: WorkflowRequestPolicy,
): WorkflowReadinessResult {
  const blockers: WorkflowBlocker[] = [];
  const { connection, conversation, desktop, remote } = input;
  const desktopRoute = desktopRouteOf(requestPolicy);

  // 1) Local durable security blockers first (independent of Bridge)
  if (conversation.sessionCorrupt) {
    blockers.push({ code: "session_corrupt" });
    return finish(input, "blocked", "stop_unknown", blockers);
  }
  if (desktop.unresolvedDelivery) {
    blockers.push({ code: "desktop_unresolved_delivery" });
    return finish(input, "blocked", "resolve_unconfirmed_delivery", blockers);
  }
  if (remote.needsReconciliation) {
    blockers.push({ code: "remote_needs_reconciliation" });
    return finish(input, "blocked", "stop_unknown", blockers);
  }

  // 2) Bridge runtime observation
  if (connection.running === "unknown") {
    blockers.push({ code: "bridge_state_unknown" });
    return finish(input, "blocked", "stop_unknown", blockers);
  }
  // Bridge stopped: downstream admin facts are legitimately unreadable — not corruption.
  if (connection.running === "stopped") {
    blockers.push({ code: "bridge_stopped" });
    return finish(input, "needs_connection", "repair_connection", blockers);
  }

  // 3) Runtime upgrade (only meaningful when Bridge can be observed as running)
  if (connection.runtimeUpgrade === "unknown") {
    blockers.push({ code: "runtime_upgrade_unknown" });
    return finish(input, "blocked", "stop_unknown", blockers);
  }
  if (connection.runtimeUpgrade === "pending") {
    blockers.push({ code: "runtime_upgrade_pending" });
    return finish(input, "needs_connection", "repair_connection", blockers);
  }

  // 4) Bridge running: require readable current admin facts
  if (connection.connectorContract !== "current") {
    blockers.push({ code: "connector_contract_unknown", detail: connection.connectorContract });
    return finish(input, "blocked", "stop_unknown", blockers);
  }
  if (BLOCKED_CONTRACTS.has(connection.desktopCompatibility)) {
    blockers.push({ code: "desktop_compatibility_unknown", detail: connection.desktopCompatibility });
    return finish(input, "blocked", "stop_unknown", blockers);
  }
  if (connection.authorization === "unknown") {
    blockers.push({ code: "authorization_unknown" });
    return finish(input, "blocked", "stop_unknown", blockers);
  }
  if (connection.authorization === "missing") {
    blockers.push({ code: "authorization_missing" });
    return finish(input, "needs_authorization", "resume_authorization", blockers);
  }
  if (connection.desktopCompatibility !== "current") {
    blockers.push({ code: "desktop_compatibility_not_current", detail: connection.desktopCompatibility });
    return finish(input, "needs_authorization", "resume_authorization", blockers);
  }

  // 5) Desktop / Remote identity facts after connection is healthy
  // saved_binding (MCP) has no Bridge current-context identity — do not require currentTarget exact/known.
  if (desktopRoute === "current_context" && desktop.currentTarget === "unknown") {
    blockers.push({ code: "desktop_target_unknown" });
    return finish(input, "blocked", "stop_unknown", blockers);
  }
  if (remote.controller === "unknown") {
    blockers.push({ code: "remote_controller_unknown" });
    return finish(input, "blocked", "stop_unknown", blockers);
  }

  // 6) Existing unfinished checkpoint / active work
  if (conversation.checkpoint === "blocked") {
    blockers.push({ code: "checkpoint_blocked" });
    return finish(input, "blocked", "stop_unknown", blockers);
  }
  if (conversation.checkpoint === "executing" || remoteActiveWork(remote)) {
    blockers.push({
      code: conversation.checkpoint === "executing" ? "checkpoint_executing" : "remote_active_work",
    });
    return finish(input, "busy", "wait_current_task", blockers);
  }
  if (
    conversation.checkpoint === "waiting_gpt_plan"
    || conversation.checkpoint === "waiting_gpt_review"
    || conversation.checkpoint === "waiting_user"
  ) {
    blockers.push({ code: "checkpoint_unfinished", detail: conversation.checkpoint });
    return finish(input, "resume_checkpoint", "resume_checkpoint", blockers);
  }

  // 7) Project / conversation incomplete
  // Request conversation does not prove Project membership — project_not_ready still applies.
  if (conversation.mode === "project" && !conversation.projectReady) {
    blockers.push({ code: "project_not_ready" });
    return finish(input, "needs_project", "bind_project", blockers);
  }

  if (desktopRoute === "current_context" && desktop.currentTarget === "exact") {
    if (desktop.bindingAvailability === "busy") {
      blockers.push({ code: "desktop_binding_busy" });
      return finish(input, "busy", "wait_current_task", blockers);
    }
    if (desktop.bindingAvailability === "unknown") {
      blockers.push({ code: "desktop_delivery_unknown" });
      return finish(input, "blocked", "stop_unknown", blockers);
    }
    if (desktop.bindingAvailability === "unavailable" && !remoteSafelyReady(remote)) {
      blockers.push({ code: "desktop_delivery_unavailable" });
      return finish(input, "blocked", "stop_unknown", blockers);
    }
  }

  const usableConversation = conversationUsable(conversation, requestPolicy);
  // Local Desktop readiness does not require a ChatGPT chat for this thread.
  // Project readiness is still checked above before this local-only shortcut.
  const localDesktopReady = desktopRoute === "current_context" && desktopLocalReady(desktop);
  if (!usableConversation.ok && !localDesktopReady) {
    // Resolve an incomplete local Desktop route before any missing-chat action.
    // MCP saved_binding and safely-ready Remote keep their existing strategies.
    if (desktopRoute === "current_context" && !remoteSafelyReady(remote)) {
      if (!desktop.configured) {
        blockers.push({ code: "desktop_bind_required" });
        return finish(input, "needs_desktop_bind", "bind_current", blockers);
      }
      if (!desktop.enabled) {
        blockers.push({ code: "desktop_not_enabled" });
        return finish(input, "needs_desktop_bind", "bind_current", blockers);
      }
      if (desktop.currentTarget === "different") {
        blockers.push({ code: "desktop_target_mismatch", detail: "different" });
        return finish(input, "needs_desktop_bind", "bind_current", blockers);
      }
      if (desktop.currentTarget === "unavailable") {
        blockers.push({ code: "desktop_unavailable", detail: desktop.bindingAvailability });
        return finish(input, "needs_desktop_bind", "bind_current", blockers);
      }
      if (desktop.currentTarget === "exact") {
        if (desktop.bindingAvailability === "busy") {
          blockers.push({ code: "desktop_binding_busy" });
          return finish(input, "busy", "wait_current_task", blockers);
        }
        if (desktop.bindingAvailability === "unknown") {
          blockers.push({ code: "desktop_delivery_unknown" });
          return finish(input, "blocked", "stop_unknown", blockers);
        }
      }
    }
    if (conversation.mode === "project") {
      blockers.push({ code: "project_chat_not_same_thread", detail: conversation.chatBinding });
    } else {
      blockers.push({ code: "conversation_not_reusable" });
    }
    return finish(input, "needs_conversation", "open_project_chat", blockers);
  }

  // 8) Desktop path — current_context (CLI/local) vs saved_binding (MCP request)
  const finishUnavailableDesktop = (): WorkflowReadinessResult => {
    if (remoteSafelyReady(remote)) {
      const remoteCap = requestPolicy?.remoteControl;
      if (remoteCap !== undefined && remoteCap !== "current") {
        blockers.push({
          code: remoteCap === "none" ? "remote_request_scope_missing" : "remote_request_scope_incomplete",
        });
        return finish(input, "needs_authorization", "resume_authorization", blockers);
      }
      blockers.push({ code: "desktop_delivery_unavailable" });
      return finish(input, "ready_remote", "use_remote", blockers);
    }
    blockers.push({ code: "desktop_delivery_unavailable" });
    return finish(input, "blocked", "stop_unknown", blockers);
  };

  if (desktopRoute === "saved_binding") {
    // Never require currentTarget === "exact". currentTarget=different is irrelevant here.
    if (desktopSavedBindingReady(desktop)) {
      return finish(input, "ready_local", "reuse", []);
    }
    if (desktop.configured && desktop.enabled) {
      if (desktop.bindingAvailability === "busy") {
        blockers.push({ code: "desktop_binding_busy" });
        return finish(input, "busy", "wait_current_task", blockers);
      }
      if (desktop.bindingAvailability === "unknown") {
        blockers.push({ code: "desktop_delivery_unknown" });
        return finish(input, "blocked", "stop_unknown", blockers);
      }
      // unavailable → blocked; Remote fallback only when Remote truly ready + request scopes current
      return finishUnavailableDesktop();
    }
    // not configured / not enabled → fall through to remote then bind_current
  } else if (desktopLocalReady(desktop)) {
    return finish(input, "ready_local", "reuse", []);
  } else if (desktop.currentTarget === "exact" && desktop.enabled && desktop.configured) {
    if (desktop.bindingAvailability === "busy") {
      blockers.push({ code: "desktop_binding_busy" });
      return finish(input, "busy", "wait_current_task", blockers);
    }
    if (desktop.bindingAvailability === "unknown") {
      blockers.push({ code: "desktop_delivery_unknown" });
      return finish(input, "blocked", "stop_unknown", blockers);
    }
    // exact + unavailable: try Remote; else blocked (never soft-ready_local)
    return finishUnavailableDesktop();
  }

  // 9) Remote safely online/idle
  if (remoteSafelyReady(remote)) {
    const remoteCap = requestPolicy?.remoteControl;
    if (remoteCap !== undefined && remoteCap !== "current") {
      blockers.push({
        code: remoteCap === "none" ? "remote_request_scope_missing" : "remote_request_scope_incomplete",
      });
      return finish(input, "needs_authorization", "resume_authorization", blockers);
    }
    if (desktopRoute === "saved_binding") {
      if (!desktop.configured || !desktop.enabled) {
        blockers.push({ code: "desktop_not_bound" });
      } else if (desktop.bindingAvailability !== "available") {
        blockers.push({ code: "desktop_unavailable", detail: desktop.bindingAvailability });
      }
    } else if (desktop.configured && desktop.enabled && desktop.currentTarget !== "exact") {
      blockers.push({ code: "desktop_target_mismatch", detail: desktop.currentTarget });
    } else if (!desktop.configured || !desktop.enabled) {
      blockers.push({ code: "desktop_not_bound" });
    } else if (desktop.bindingAvailability !== "available") {
      blockers.push({ code: "desktop_unavailable", detail: desktop.bindingAvailability });
    }
    return finish(input, "ready_remote", "use_remote", blockers);
  }

  // 10) otherwise → bind current Desktop
  if (desktopRoute === "saved_binding") {
    if (!desktop.configured) {
      blockers.push({ code: "desktop_bind_required" });
    } else if (!desktop.enabled) {
      blockers.push({ code: "desktop_not_enabled" });
    } else {
      blockers.push({ code: "desktop_unavailable", detail: desktop.bindingAvailability });
    }
    return finish(input, "needs_desktop_bind", "bind_current", blockers);
  }
  if (desktop.configured && desktop.enabled && desktop.currentTarget === "different") {
    blockers.push({ code: "desktop_target_mismatch", detail: "different" });
  } else if (!desktop.enabled) {
    blockers.push({ code: "desktop_not_enabled" });
  } else if (desktop.configured && desktop.bindingAvailability === "busy") {
    blockers.push({ code: "desktop_binding_busy" });
  } else if (!desktop.configured) {
    blockers.push({ code: "desktop_bind_required" });
  } else {
    blockers.push({ code: "desktop_unavailable", detail: desktop.bindingAvailability });
  }
  return finish(input, "needs_desktop_bind", "bind_current", blockers);
}

/** Human-facing readiness summary. Never prints UUIDs or raw commands. */
export function formatWorkflowReadinessHuman(result: WorkflowReadinessResult): string {
  const lines: string[] = ["Codex with ChatGPT", ""];

  if (result.overall === "ready_local") {
    lines.push("✓ 当前项目已识别");
    lines.push("✓ ChatGPT 工作流状态可复用");
    lines.push("✓ 当前 Desktop 会话已就绪（identity + inspect 确认）");
    lines.push("");
    lines.push("Ready.（本机执行路径已确认；ChatGPT Connector 请求级校验仍需 Activation/G2）");
    return lines.join("\n");
  }

  if (result.overall === "blocked") {
    lines.push("当前工作流状态无法安全复用。");
    const first = result.blockers[0]?.code;
    if (first === "desktop_unresolved_delivery") {
      lines.push("存在结果不明的 Desktop 投递，需先人工核对。");
    } else if (first === "desktop_delivery_unknown") {
      lines.push("Desktop 投递状态无法确认，不能视为 Ready。");
    } else if (first === "desktop_delivery_unavailable") {
      lines.push("Desktop 投递当前不可用，不能视为 Ready。");
    } else if (first === "authorization_unknown") {
      lines.push("授权状态无法确认，不能当作缺授权或已授权。");
    } else if (first === "connector_contract_unknown") {
      lines.push("Connector/runtime contract 未知，需先诊断，不要仅恢复 OAuth。");
    } else {
      lines.push("请先处理未知或损坏状态，不要强行继续。");
    }
    return lines.join("\n");
  }

  if (result.overall === "ready_remote") {
    lines.push("✓ 当前项目已识别");
    lines.push("✓ Remote Control 在线");
    if (result.desktop.currentTarget !== "exact" || !result.desktop.enabled) {
      lines.push("· 当前 Desktop 会话未绑定");
    } else {
      lines.push("· 当前 Desktop 会话暂不可直接复用");
    }
    lines.push("");
    lines.push("可从 ChatGPT 跨设备继续任务。");
    return lines.join("\n");
  }

  if (result.overall === "resume_checkpoint") {
    lines.push("✓ 当前项目已识别");
    lines.push("存在未完成的会话 checkpoint。");
    lines.push("请继续原任务，不要创建新的 INIT。");
    return lines.join("\n");
  }

  if (result.overall === "busy") {
    lines.push("✓ 当前项目已识别");
    lines.push("当前已有进行中的执行或等待。");
    lines.push("请等待当前任务结束，不要启动第二条。");
    return lines.join("\n");
  }

  if (result.overall === "needs_connection") {
    lines.push("当前连接尚未就绪。");
    lines.push("请先恢复 Bridge / 连接状态，再继续日常工作流。");
    return lines.join("\n");
  }

  if (result.overall === "needs_authorization") {
    lines.push("连接端点已存在，但 ChatGPT 授权需要恢复。");
    lines.push("请先恢复授权，再继续工作流。");
    return lines.join("\n");
  }

  if (result.overall === "needs_project") {
    lines.push("✓ 连接已就绪");
    lines.push("Project 尚未完成绑定。");
    return lines.join("\n");
  }

  if (result.overall === "needs_conversation") {
    lines.push("✓ Project 已就绪");
    lines.push("当前 thread 尚无可复用 Chat（需本线程自己的对话）。");
    lines.push("请先打开或绑定目标对话。");
    return lines.join("\n");
  }

  // needs_desktop_bind
  lines.push("当前连接和 Project 已就绪。");
  lines.push("下一步只需绑定当前 Desktop 会话。");
  return lines.join("\n");
}
