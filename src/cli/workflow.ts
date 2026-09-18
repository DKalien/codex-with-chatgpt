/**
 * G2 `c2c workflow status` — collect read-only facts via shared capability layer, run pure resolver.
 * Never binds, enables, pairs, repairs, or writes session/remote/desktop state.
 */
import type { Command } from "commander";
import path from "node:path";
import { Workspace } from "../workspace/manager.js";
import { findBridgeObservation } from "../bridge/runtime.js";
import { adminFetch } from "../process/daemon.js";
import { AuthStore } from "../auth/store.js";
import { readRuntimeUpgrade } from "../core/upgrade.js";
import { collectWorkflowCapabilityFacts } from "../workflow/facts.js";
import { projectRuntimeUpgrade } from "../workflow/request.js";
import {
  formatWorkflowReadinessHuman,
  resolveWorkflowReadiness,
  WORKFLOW_READINESS_SCHEMA_VERSION,
  type ConnectionAuthorization,
  type ConnectionRunning,
  type ConnectionRuntimeUpgrade,
  type ConnectorContractState,
  type DesktopCompatibilityState,
  type WorkflowReadinessInput,
  type WorkflowReadinessResult,
} from "../workflow/readiness.js";

const say = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

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

function mapAuthorization(running: ConnectionRunning, tokenCount: number | undefined): ConnectionAuthorization {
  if (running !== "running") return "unknown";
  if (typeof tokenCount === "number" && tokenCount > 0) return "authorized";
  if (tokenCount === 0) return "missing";
  return "unknown";
}

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
    try {
      const runtimeBuildId =
        observation.state === "healthy" || observation.state === "stopped"
          ? (observation.runtime as { runtimeBuildId?: string } | null)?.runtimeBuildId
          : undefined;
      const upgrade = readRuntimeUpgrade(
        workspace,
        runtimeBuildId ? { runtimeBuildId } : null,
        "fast",
      );
      runtimeUpgrade = projectRuntimeUpgrade(upgrade);
    } catch {
      runtimeUpgrade = "unknown";
    }
    if (running === "running" && authorization === "unknown") {
      try {
        const auth = new AuthStore(workspace.id);
        const count = auth.tokenCount();
        authorization = count > 0 ? "authorized" : "missing";
      } catch {
        authorization = "unknown";
      }
    }
  } catch {
    running = "unknown";
  }

  const capability = await collectWorkflowCapabilityFacts(workspace, { kind: "codex_thread" });

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
    conversation: capability.conversation,
    desktop: capability.desktop,
    remote: capability.remote,
  };
}

export async function workflowStatus(workspaceRoot: string): Promise<WorkflowReadinessResult> {
  const workspace = new Workspace(path.resolve(workspaceRoot));
  const input = await collectWorkflowReadinessInput(workspace);
  return resolveWorkflowReadiness(input);
}

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
        if (opts.json) say(JSON.stringify(workflowFailurePayload()));
        else say("工作流状态读取失败；未修改任何状态。");
        process.exitCode = 1;
      }
    });
}
