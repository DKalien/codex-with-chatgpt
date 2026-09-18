/**
 * G2 request-scoped helpers for workflow readiness.
 * Request identity/scopes only; never local AuthStore aggregate substitution.
 */
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { resolveConversationPrincipal } from "../mcp/conversation-principal.js";
import { DesktopError } from "../desktop/store.js";
import type {
  ConnectionAuthorization,
  ConnectionRuntimeUpgrade,
  ConnectorContractState,
  DesktopCompatibilityState,
  RequestConversationState,
  WorkflowBlockerCode,
  WorkflowCheckpointState,
  WorkflowConversationMode,
  WorkflowReadinessResult,
  ProjectChatBindingState,
} from "./readiness.js";
import { WORKFLOW_READINESS_SCHEMA_VERSION } from "./readiness.js";
import type { readSession } from "../session/state.js";

export type RemoteRequestCapability = "current" | "incomplete" | "none";

export interface WorkflowRequestContext {
  source: "mcp_request";
  conversationIdentity: RequestConversationState;
  remote: RemoteRequestCapability;
}

/** MCP `workspace_info.workflow` object (readiness projections + requestContext). */
export interface WorkflowMcpProjection {
  schemaVersion: typeof WORKFLOW_READINESS_SCHEMA_VERSION;
  overall: WorkflowReadinessResult["overall"];
  nextAction: WorkflowReadinessResult["nextAction"];
  requestContext: WorkflowRequestContext;
  connection: WorkflowReadinessResult["connection"];
  conversation: WorkflowReadinessResult["conversation"];
  desktop: WorkflowReadinessResult["desktop"];
  remote: WorkflowReadinessResult["remote"];
  blockers: { code: WorkflowBlockerCode; detail?: string }[];
}

export function mapCheckpointFromSession(session: ReturnType<typeof readSession>): WorkflowCheckpointState {
  const checkpoint = session?.checkpoint;
  if (!checkpoint) return "none";
  const protocolState = checkpoint.protocolState;
  if (protocolState === "DONE") return "done";
  if (protocolState === "BLOCKED") return "blocked";
  if (protocolState === "EXECUTING") return "executing";
  if (checkpoint.waitingFor === "GPT_PLAN") return "waiting_gpt_plan";
  if (checkpoint.waitingFor === "GPT_REVIEW") return "waiting_gpt_review";
  if (checkpoint.waitingFor === "USER") return "waiting_user";
  return "executing";
}

/** Allowlisted Desktop error codes only. Never classify by message text. */
export function desktopErrorCode(error: unknown): string | null {
  if (error instanceof DesktopError) return error.code;
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && code.startsWith("DESKTOP_") ? code : null;
}

/**
 * Shared runtime upgrade projection.
 * State classification first: unknown/stopped/corrupt → unknown even if a pending marker exists.
 * stale → pending; current + upgradePending → pending; current → current.
 */
export function projectRuntimeUpgrade(
  upgrade: { state?: string | null; upgradePending?: boolean } | null | undefined,
): ConnectionRuntimeUpgrade {
  if (!upgrade || typeof upgrade.state !== "string") return "unknown";
  if (upgrade.state === "unknown" || upgrade.state === "stopped") return "unknown";
  if (upgrade.state === "stale") return "pending";
  if (upgrade.state === "current") {
    return upgrade.upgradePending === true ? "pending" : "current";
  }
  return "unknown";
}

export function remoteRequestCapability(scopes: readonly string[] | undefined | null): RemoteRequestCapability {
  if (!scopes || scopes.length === 0) return "none";
  const hasRead = scopes.includes("codex.read");
  const hasControl = scopes.includes("codex.control");
  if (hasRead && hasControl) return "current";
  if (hasRead || hasControl) return "incomplete";
  return "none";
}

/**
 * Request conversation availability from official openai/session only.
 * Does not use MCP sessionId, tool args, or CODEX_THREAD_ID.
 */
export function requestConversationAvailable(extra: {
  authInfo?: AuthInfo | undefined;
  sessionId?: string;
  _meta?: unknown;
}): boolean {
  try {
    const principal = resolveConversationPrincipal(extra);
    return typeof principal.conversationKey === "string" && principal.conversationKey.length > 0;
  } catch {
    return false;
  }
}

export function requestAuthorization(authInfo: AuthInfo | undefined): ConnectionAuthorization {
  // workspace.read gate already passed when workspace_info handler runs.
  // authInfo present = current request authorized for this MCP surface.
  return authInfo ? "authorized" : "unknown";
}

function normalizeAuthorization(value: ConnectionAuthorization | "authorized" | "unknown"): ConnectionAuthorization {
  return value === "authorized" ? "authorized" : "unknown";
}

function normalizeDesktopCompatibility(value: DesktopCompatibilityState | string | null | undefined): DesktopCompatibilityState {
  const allowed: DesktopCompatibilityState[] = ["current", "legacy", "incomplete", "none", "unknown", "corrupt"];
  return (allowed as string[]).includes(value as string) ? (value as DesktopCompatibilityState) : "unknown";
}

/**
 * Fail-closed MCP workflow projection when capability/runtime collection throws.
 * Returns the full output-schema shape so workspace_info identity never fails validation.
 */
export function workflowProjectionFailure(params: {
  conversationIdentity?: RequestConversationState;
  remoteCapability?: RemoteRequestCapability;
  authorization?: ConnectionAuthorization | "authorized" | "unknown";
  desktopCompatibility?: DesktopCompatibilityState | string | null | undefined;
  connectorContract?: ConnectorContractState;
}): WorkflowMcpProjection {
  const conversationMode: WorkflowConversationMode = "unknown";
  const chatBinding: ProjectChatBindingState = "none";
  return {
    schemaVersion: WORKFLOW_READINESS_SCHEMA_VERSION,
    overall: "blocked",
    nextAction: "stop_unknown",
    requestContext: {
      source: "mcp_request",
      conversationIdentity: params.conversationIdentity === "available" ? "available" : "unavailable",
      remote: params.remoteCapability ?? "none",
    },
    connection: {
      running: "running",
      runtimeUpgrade: "unknown",
      authorization: normalizeAuthorization(params.authorization ?? "unknown"),
      connectorContract: params.connectorContract ?? "current",
      desktopCompatibility: normalizeDesktopCompatibility(params.desktopCompatibility),
    },
    conversation: {
      mode: conversationMode,
      projectReady: false,
      chatKnown: false,
      chatBinding,
      checkpoint: "none",
      sessionCorrupt: false,
    },
    desktop: {
      configured: false,
      enabled: false,
      currentTarget: "unknown",
      bindingAvailability: "unknown",
      unresolvedDelivery: false,
    },
    remote: {
      enabled: false,
      controller: "unknown",
      activeWork: false,
      needsReconciliation: false,
    },
    blockers: [{ code: "workflow_projection_failed" }],
  };
}
