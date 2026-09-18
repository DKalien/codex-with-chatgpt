/**
 * G1a `c2c workflow status` — collect read-only facts, run pure resolver.
 * Never binds, enables, pairs, repairs, or writes session/remote/desktop state.
 *
 * ready_local = local machine prerequisites only.
 * It does NOT prove ChatGPT Connector request-scoped scopes/schema — Activation/G2 still required.
 * desktopCompatibility comes from local AuthStore summary, not the live MCP request.
 */
import type { Command } from "commander";
import path from "node:path";
import { Workspace } from "../workspace/manager.js";
import { findBridgeObservation } from "../bridge/runtime.js";
import { adminFetch } from "../process/daemon.js";
import { AuthStore } from "../auth/store.js";
import { readSession, resolveThreadConversation } from "../session/state.js";
import { readRemote, controllerOnline, RemoteError } from "../remote/store.js";
import { readDesktop, DesktopError } from "../desktop/store.js";
import { desktopIpc } from "../desktop/ipc.js";
import {
  formatWorkflowReadinessHuman,
  resolveWorkflowReadiness,
  WORKFLOW_READINESS_SCHEMA_VERSION,
  type ConnectionAuthorization,
  type ConnectionRunning,
  type ConnectionRuntimeUpgrade,
  type ConnectorContractState,
  type DesktopAvailability,
  type DesktopCompatibilityState,
  type ProjectChatBindingState,
  type WorkflowCheckpointState,
  type WorkflowDesktopProjection,
  type WorkflowReadinessInput,
  type WorkflowReadinessResult,
} from "../workflow/readiness.js";

const say = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

/** Allowlisted structured Desktop error codes only. Never classify by error.message. */
const DESKTOP_BUSY_CODES = new Set([
  "DESKTOP_BUSY",
  "DESKTOP_APPROVAL_PENDING",
]);
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
/** Two consecutive read-only observations disagree → identity not stable. */
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

export function desktopErrorCode(error: unknown): string | null {
  if (error instanceof DesktopError) return error.code;
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && code.startsWith("DESKTOP_") ? code : null;
}

type AdminInfoLite = {
  workspaceName?: string;
  tokenCount?: number;
  connectorContractVersion?: number | null;
  desktopCompatibility?: { status?: string } | null;
};

function mapRunning(state: "healthy" | "stopped" | "unknown"): ConnectionRunning {
  if (state === "healthy") return "running";
  if (state === "stopped") return "stopped";
  return "unknown";
}

function mapRuntimeUpgrade(state: string | undefined | null): ConnectionRuntimeUpgrade {
  if (state === "current") return "current";
  if (state === "pending") return "pending";
  return "unknown";
}

function mapAuthorization(running: ConnectionRunning, tokenCount: number | undefined): ConnectionAuthorization {
  if (running !== "running") return "unknown";
  if (typeof tokenCount === "number" && tokenCount > 0) return "authorized";
  if (tokenCount === 0) return "missing";
  return "unknown";
}

/** connectorContractVersion missing/unknown → unknown (blocked). Never "none" authorization. */
function mapConnectorContract(value: number | null | undefined): ConnectorContractState {
  return value === 1 ? "current" : "unknown";
}

function mapDesktopCompatibility(value: string | null | undefined): DesktopCompatibilityState {
  if (value === "current") return "current";
  if (value === "legacy") return "legacy";
  if (value === "incomplete") return "incomplete";
  if (value === "none") return "none";
  if (value === "corrupt") return "corrupt";
  return "unknown";
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

function mapChatBinding(value: ProjectChatBindingState): ProjectChatBindingState {
  return value;
}

export async function collectWorkflowReadinessInput(workspace: Workspace): Promise<WorkflowReadinessInput> {
  let workspaceName = path.basename(workspace.root);
  let running: ConnectionRunning = "unknown";
  let runtimeUpgrade: ConnectionRuntimeUpgrade = "unknown";
  let authorization: ConnectionAuthorization = "unknown";
  let connectorContract: ConnectorContractState = "unknown";
  let desktopCompatibility: DesktopCompatibilityState = "unknown";

  try {
    const observation = await findBridgeObservation(workspace.id);
    running = mapRunning(observation.state);
    if (observation.state === "healthy") {
      try {
        const info = await adminFetch<AdminInfoLite>(observation.runtime, "GET", "/admin/info");
        if (typeof info.workspaceName === "string" && info.workspaceName) workspaceName = info.workspaceName;
        authorization = mapAuthorization(running, info.tokenCount);
        connectorContract = mapConnectorContract(info.connectorContractVersion ?? null);
        desktopCompatibility = mapDesktopCompatibility(info.desktopCompatibility?.status ?? null);
      } catch {
        authorization = "unknown";
        connectorContract = "unknown";
        desktopCompatibility = "unknown";
      }
    } else if (observation.state === "stopped") {
      authorization = "unknown";
      connectorContract = "unknown";
      desktopCompatibility = "unknown";
    }
    if (observation.state === "unknown") {
      runtimeUpgrade = "unknown";
    } else if (observation.state === "healthy") {
      try {
        const { readRuntimeUpgrade } = await import("../core/upgrade.js");
        const upgrade = readRuntimeUpgrade(workspace, observation.runtime, "fast");
        runtimeUpgrade = mapRuntimeUpgrade(upgrade.state);
      } catch {
        runtimeUpgrade = "unknown";
      }
    } else {
      try {
        const { readRuntimeUpgrade } = await import("../core/upgrade.js");
        const upgrade = readRuntimeUpgrade(workspace, null, "fast");
        runtimeUpgrade = mapRuntimeUpgrade(upgrade.state);
      } catch {
        runtimeUpgrade = "unknown";
      }
    }
    if (running === "running" && authorization === "unknown") {
      try {
        const auth = new AuthStore(workspace.id);
        const count = auth.tokenCount();
        if (count > 0) authorization = "authorized";
        else authorization = "missing";
      } catch {
        authorization = "unknown";
      }
    }
  } catch {
    running = "unknown";
  }

  let conversation: WorkflowReadinessInput["conversation"] = {
    mode: "unknown",
    projectReady: false,
    chatKnown: false,
    chatBinding: "none",
    checkpoint: "none",
    sessionCorrupt: false,
  };
  try {
    const session = readSession(workspace.id);
    // Shared safe-URL contract with G1b threadConversation (not binding-only).
    const thread = resolveThreadConversation(session, workspace.id);
    conversation = {
      mode: thread.mode === "project" || thread.mode === "long-chat" ? thread.mode : "unknown",
      projectReady: thread.projectReady,
      chatKnown: thread.reuseChat,
      chatBinding: mapChatBinding(thread.chatBinding),
      checkpoint: mapCheckpointFromSession(session),
      sessionCorrupt: false,
    };
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
    const unresolvedDelivery = Boolean(state?.deliveries.some((item) => item.deliveryStatus === "outcome_unknown"));
    let currentTarget: WorkflowDesktopProjection["currentTarget"] = "unavailable";
    let bindingAvailability: DesktopAvailability = state?.binding ? "unknown" : "unavailable";

    if (configured && state?.binding) {
      const binding = state.binding;
      // currentTarget: identity only. currentIdentity allows active context; ≠ send-idle.
      try {
        const identity = await desktopIpc.currentIdentity(workspace.root);
        const same =
          identity.threadId === binding.threadId
          && identity.hostId === binding.hostId
          && identity.projectId === binding.projectId;
        currentTarget = same ? "exact" : "different";
      } catch (error) {
        const code = desktopErrorCode(error);
        if (code && DESKTOP_CONTEXT_UNAVAILABLE_CODES.has(code)) {
          currentTarget = "unavailable";
        } else {
          // Unknown / identity-unstable / non-allowlisted → fail closed as unknown.
          currentTarget = "unknown";
        }
      }

      // bindingAvailability: structured Desktop inspect codes only.
      try {
        const { targetInput } = await import("../desktop/store.js");
        const target = targetInput.parse({
          threadId: binding.threadId,
          hostId: binding.hostId,
          projectId: binding.projectId,
        });
        await desktopIpc.inspect({ ...target, workspaceRoot: workspace.root });
        bindingAvailability = "available";
      } catch (error) {
        const code = desktopErrorCode(error);
        if (code && DESKTOP_BUSY_CODES.has(code)) {
          bindingAvailability = "busy";
        } else if (code && DESKTOP_IDENTITY_UNSTABLE_CODES.has(code)) {
          // Identity/security fact changed between currentIdentity and inspect.
          currentTarget = "unknown";
          bindingAvailability = "unknown";
        } else if (code && DESKTOP_CONTEXT_UNAVAILABLE_CODES.has(code)) {
          bindingAvailability = "unavailable";
        } else if (code && DESKTOP_FACT_UNCONFIRMED_CODES.has(code)) {
          bindingAvailability = "unknown";
        } else {
          // Null / non-DESKTOP / arbitrary Error → unknown (never classify by message text).
          bindingAvailability = "unknown";
        }
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
        unresolvedDelivery: false,
      };
    }
  }

  let remote: WorkflowReadinessInput["remote"] = {
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

  return {
    workspaceId: workspace.id,
    workspaceName,
    connection: {
      running,
      runtimeUpgrade,
      authorization,
      connectorContract,
      desktopCompatibility,
    },
    conversation,
    desktop,
    remote,
  };
}

export async function workflowStatus(workspaceRoot: string): Promise<WorkflowReadinessResult> {
  const workspace = new Workspace(path.resolve(workspaceRoot));
  const input = await collectWorkflowReadinessInput(workspace);
  return resolveWorkflowReadiness(input);
}

/** Bounded failure JSON — never leak raw error.message / paths / IPC details. */
export function workflowFailurePayload(): {
  schemaVersion: number;
  ok: false;
  overall: "blocked";
  nextAction: "stop_unknown";
  blockers: [{ code: "workflow_status_failed" }];
} {
  return {
    schemaVersion: WORKFLOW_READINESS_SCHEMA_VERSION,
    ok: false,
    overall: "blocked",
    nextAction: "stop_unknown",
    blockers: [{ code: "workflow_status_failed" }],
  };
}

export function registerWorkflowCommands(program: Command): void {
  const workflow = program.command("workflow").description("只读日常工作流 readiness（不执行修复/绑定）");
  workflow
    .command("status", { isDefault: true })
    .description("聚合连接/会话/Desktop/Remote 只读事实并给出 bounded nextAction")
    .option("-w, --workspace <path>")
    .option("--json", "machine-readable output", false)
    .action(async (opts: { workspace?: string; json: boolean }) => {
      try {
        const result = await workflowStatus(opts.workspace ?? process.cwd());
        if (opts.json) {
          say(JSON.stringify(result));
          return;
        }
        say(formatWorkflowReadinessHuman(result));
      } catch {
        if (opts.json) {
          say(JSON.stringify(workflowFailurePayload()));
        } else {
          say("工作流状态读取失败；未修改任何状态。");
        }
        process.exitCode = 1;
      }
    });
}