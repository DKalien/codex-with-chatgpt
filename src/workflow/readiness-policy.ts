/**
 * G1a unified workflow readiness — pure policy decision layer.
 * Read-only facts in, bounded overall/nextAction out.
 * Never authorizes, binds, enables, repairs, or mutates state.
 */

import {
  WORKFLOW_NEXT_ACTIONS,
  WORKFLOW_OVERALL_STATES,
  WORKFLOW_READINESS_SCHEMA_VERSION,
} from "./readiness-model.js";
import type {
  DesktopRoute,
  WorkflowBlocker,
  WorkflowDesktopProjection,
  WorkflowReadinessInput,
  WorkflowReadinessResult,
  WorkflowRequestPolicy,
  WorkflowConversationProjection,
} from "./readiness-model.js";

const BLOCKED_CONTRACTS = new Set(["unknown", "corrupt"]);

function finish(
  input: WorkflowReadinessInput,
  overall: WorkflowReadinessResult["overall"],
  nextAction: WorkflowReadinessResult["nextAction"],
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

function remoteActiveWork(remote: WorkflowReadinessInput["remote"]): boolean {
  return remote.activeWork === true;
}

function remoteSafelyReady(remote: WorkflowReadinessInput["remote"]): boolean {
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
