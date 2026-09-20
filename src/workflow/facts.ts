/**
 * G2 shared local capability facts for workflow readiness.
 * Read-only session/desktop/remote observation. Never auth, bind, or write state.
 */
import { Workspace } from "../workspace/manager.js";
import { readSession, resolveConversation, resolveThreadConversation } from "../session/state.js";
import { readRemote, controllerOnline, RemoteError } from "../remote/store.js";
import { readDesktop, DesktopError } from "../desktop/store.js";
import { desktopIpc } from "../desktop/ipc.js";
import { targetInput } from "../desktop/store.js";
import { unresolvedOutcomeUnknownCommandIds } from "../desktop/outcome-resolution.js";
import {
  mapCheckpointFromSession,
  desktopErrorCode,
} from "./request.js";
import type {
  ProjectChatBindingState,
  WorkflowCheckpointState,
  WorkflowConversationProjection,
  WorkflowDesktopProjection,
  WorkflowRemoteProjection,
} from "./readiness.js";

export type ConversationSource =
  | { kind: "codex_thread" }
  | { kind: "mcp_request"; conversationAvailable: boolean };

const DESKTOP_BUSY_CODES = new Set(["DESKTOP_BUSY", "DESKTOP_APPROVAL_PENDING"]);
const DESKTOP_CONTEXT_UNAVAILABLE_CODES = new Set([
  "DESKTOP_CURRENT_CONTEXT_INVALID",
  "DESKTOP_IPC_UNAVAILABLE",
  "DESKTOP_UNSUPPORTED_PLATFORM",
  "DESKTOP_PYTHON_UNAVAILABLE",
  "DESKTOP_PYTHON_UNSUPPORTED",
]);
const DESKTOP_FACT_UNCONFIRMED_CODES = new Set([
  "DESKTOP_STATE_UNAVAILABLE",
  "DESKTOP_PROCESS_CHANGED",
  "DESKTOP_PROTOCOL_ERROR",
  "DESKTOP_IPC_TIMEOUT",
  "DESKTOP_IPC_REJECTED",
  "DESKTOP_INTERNAL_ERROR",
  "DESKTOP_INVALID_REQUEST",
]);
const DESKTOP_IDENTITY_UNSTABLE_CODES = new Set([
  "DESKTOP_NO_OWNER",
  "DESKTOP_OWNER_CHANGED",
  "DESKTOP_PROJECT_MISMATCH",
  "DESKTOP_VERSION_UNSUPPORTED",
  "DESKTOP_ELEVATED",
  "DESKTOP_IPC_SERVER_MISMATCH",
  "DESKTOP_TOKEN_UNVERIFIED",
  "DESKTOP_TOKEN_INTEGRITY",
  "DESKTOP_TARGET_NOT_FOUND",
]);

function remoteActiveWork(state: ReturnType<typeof readRemote>): boolean {
  if (!state) return false;
  const activeStatuses = new Set(["queued", "starting", "running", "awaiting_approval"]);
  return (
    state.tasks.some((task) => activeStatuses.has(task.status))
    || state.threads.some((thread) => activeStatuses.has(thread.status))
  );
}

function remoteNeedsReconciliation(state: ReturnType<typeof readRemote>): boolean {
  if (!state) return false;
  return (
    state.tasks.some((task) => task.status === "needs_reconciliation")
    || state.threads.some((thread) => thread.status === "needs_reconciliation")
  );
}

export function collectConversationFacts(
  workspace: Workspace,
  conversationSource: ConversationSource,
): WorkflowConversationProjection {
  const session = readSession(workspace.id);
  const view = resolveConversation(session);
  const mode = view.mode === "project" || view.mode === "long-chat" ? view.mode : "unknown";
  const projectReady = view.mode === "project" ? view.projectReady : false;
  const checkpoint: WorkflowCheckpointState = mapCheckpointFromSession(session);

  if (conversationSource.kind === "mcp_request") {
    // chatKnown stays durable/local only. Request conversation identity is
    // requestContext.conversationIdentity + requestPolicy.currentConversation —
    // never same_thread, never Project membership.
    return {
      mode,
      projectReady,
      chatKnown: false,
      chatBinding: "none" as ProjectChatBindingState,
      checkpoint,
      sessionCorrupt: false,
    };
  }

  const thread = resolveThreadConversation(session, workspace.id);
  return {
    mode: thread.mode === "project" || thread.mode === "long-chat" ? thread.mode : "unknown",
    projectReady: thread.projectReady,
    chatKnown: thread.reuseChat,
    chatBinding: thread.chatBinding,
    checkpoint,
    sessionCorrupt: false,
  };
}

export async function collectDesktopFacts(
  workspace: Workspace,
  conversationSource?: ConversationSource,
): Promise<WorkflowDesktopProjection> {
  // MCP request has no meaningful Bridge current Desktop thread — skip currentIdentity().
  const skipCurrentIdentity = conversationSource?.kind === "mcp_request";
  let desktop: WorkflowDesktopProjection = {
    configured: false,
    enabled: false,
    currentTarget: "unavailable",
    bindingAvailability: "unavailable",
    unresolvedDelivery: false,
  };
  try {
    const state = readDesktop(workspace.id);
    const configured = Boolean(state?.binding);
    const enabled = state?.enabled === true;
    const unresolvedDelivery = unresolvedOutcomeUnknownCommandIds(workspace, state).size > 0;
    let currentTarget: WorkflowDesktopProjection["currentTarget"] = "unavailable";
    let bindingAvailability: WorkflowDesktopProjection["bindingAvailability"] = state?.binding ? "unknown" : "unavailable";

    if (configured && state?.binding) {
      const binding = state.binding;
      if (skipCurrentIdentity) {
        // Not-current-context: do not fake "exact". Readiness uses saved-binding inspect only.
        currentTarget = "unavailable";
      } else {
        try {
          const identity = await desktopIpc.currentIdentity(workspace.root);
          const same =
            identity.threadId === binding.threadId
            && identity.hostId === binding.hostId
            && identity.projectId === binding.projectId;
          currentTarget = same ? "exact" : "different";
        } catch (error) {
          const code = desktopErrorCode(error);
          if (code && DESKTOP_CONTEXT_UNAVAILABLE_CODES.has(code)) currentTarget = "unavailable";
          else currentTarget = "unknown";
        }
      }
      try {
        const target = targetInput.parse({
          threadId: binding.threadId,
          hostId: binding.hostId,
          projectId: binding.projectId,
        });
        await desktopIpc.inspect({ ...target, workspaceRoot: workspace.root });
        bindingAvailability = "available";
      } catch (error) {
        const code = desktopErrorCode(error);
        if (code && DESKTOP_BUSY_CODES.has(code)) bindingAvailability = "busy";
        else if (code && DESKTOP_IDENTITY_UNSTABLE_CODES.has(code)) {
          currentTarget = "unknown";
          bindingAvailability = "unknown";
        } else if (code && DESKTOP_CONTEXT_UNAVAILABLE_CODES.has(code)) bindingAvailability = "unavailable";
        else if (code && DESKTOP_FACT_UNCONFIRMED_CODES.has(code)) bindingAvailability = "unknown";
        else bindingAvailability = "unknown";
      }
    }
    desktop = { configured, enabled, currentTarget, bindingAvailability, unresolvedDelivery };
  } catch (error) {
    if (error instanceof DesktopError && error.code === "DESKTOP_STATE_CORRUPT") {
      desktop = {
        configured: true,
        enabled: false,
        currentTarget: "unknown",
        bindingAvailability: "unknown",
        unresolvedDelivery: true,
      };
    } else {
      desktop = {
        configured: false,
        enabled: false,
        currentTarget: "unknown",
        bindingAvailability: "unknown",
        unresolvedDelivery: true,
      };
    }
  }
  return desktop;
}

export function collectRemoteFacts(workspace: Workspace): WorkflowRemoteProjection {
  let remote: WorkflowRemoteProjection = {
    enabled: false,
    controller: "offline",
    activeWork: false,
    needsReconciliation: false,
  };
  try {
    const state = readRemote(workspace.id);
    const online = state ? controllerOnline(state) : false;
    remote = {
      enabled: state?.enabled === true,
      controller: state
        ? (online ? "online" : (state.controller?.appServer === "unknown" ? "unknown" : "offline"))
        : "offline",
      activeWork: remoteActiveWork(state),
      needsReconciliation: remoteNeedsReconciliation(state),
    };
  } catch (error) {
    if (error instanceof RemoteError && error.code === "STATE_CORRUPT") {
      remote = { enabled: false, controller: "unknown", activeWork: false, needsReconciliation: true };
    } else {
      remote = { enabled: false, controller: "unknown", activeWork: false, needsReconciliation: false };
    }
  }
  return remote;
}

export async function collectWorkflowCapabilityFacts(
  workspace: Workspace,
  conversationSource: ConversationSource,
): Promise<{
  conversation: WorkflowConversationProjection;
  desktop: WorkflowDesktopProjection;
  remote: WorkflowRemoteProjection;
}> {
  let conversation: WorkflowConversationProjection;
  try {
    conversation = collectConversationFacts(workspace, conversationSource);
  } catch {
    conversation = {
      mode: "unknown",
      projectReady: false,
      chatKnown: false,
      chatBinding: "none",
      checkpoint: "none",
      sessionCorrupt: true,
    };
  }
  return {
    conversation,
    desktop: await collectDesktopFacts(workspace, conversationSource),
    remote: collectRemoteFacts(workspace),
  };
}
