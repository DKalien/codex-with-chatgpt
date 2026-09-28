import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(process.cwd());
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const exportsOf = (source: string) => {
  const names = new Set<string>();
  for (const block of source.matchAll(/export\s+(?:type\s+)?\{([\s\S]*?)\}\s+from/g)) {
    for (const item of block[1].split(",")) {
      const name = item.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
      if (name) names.add(name);
    }
  }
  for (const match of source.matchAll(/export\s+(?:async\s+)?(?:function|const|class|interface|type)\s+([A-Za-z0-9_]+)/g)) {
    names.add(match[1]);
  }
  return [...names].sort();
};

describe("R4.5f structural boundaries", () => {
  it("preserves exact session/readiness/MCP facade exports", () => {
    expect(exportsOf(read("src/session/state.ts"))).toEqual([
      "ConversationMode", "ConversationReason", "ConversationView", "PROJECT_CHATS_MAX", "PROTOCOL_STATES",
      "ProjectChatBinding", "ProjectChatEntry", "ProtocolState", "SavedSession", "SessionPatch", "TaskCheckpoint", "ThreadConversationProjection",
      "WAITING_FOR", "WaitingFor", "WebControlState", "conversationChatKnown", "currentCodexThreadId", "mergeSession",
      "normalizeProjectChatEntry", "normalizeProjectChats", "normalizeProjectUrl", "parsePersistedProjectChats", "projectChatBinding",
      "projectChatForCurrentThread", "projectChatOwnerFingerprint", "projectIdFromUrl", "readSession", "removeProjectChatForFingerprint",
      "resolveConversation", "resolveThreadConversation", "sessionFile", "upsertProjectChat", "updateSession", "validateProjectChatState",
      "webControlStateSchema", "writeSession", "clearChatPointer",
    ].sort());
    expect(exportsOf(read("src/workflow/readiness.ts"))).toEqual([
      "ConnectionAuthorization", "ConnectionRunning", "ConnectionRuntimeUpgrade", "ConnectorContractState", "DesktopAvailability",
      "DesktopCompatibilityState", "DesktopCurrentTarget", "DesktopRoute", "ProjectChatBindingState", "RemoteControllerState", "RequestConversationState",
      "WORKFLOW_AUTHORIZATION_STATES", "WORKFLOW_BLOCKER_CODES", "WORKFLOW_BLOCKER_DETAIL_MAX", "WORKFLOW_CHAT_BINDING_STATES",
      "WORKFLOW_CHECKPOINT_STATES", "WORKFLOW_CONNECTOR_CONTRACT_STATES", "WORKFLOW_CONVERSATION_MODES", "WORKFLOW_DESKTOP_AVAILABILITY",
      "WORKFLOW_DESKTOP_COMPATIBILITY_STATES", "WORKFLOW_DESKTOP_CURRENT_TARGETS", "WORKFLOW_DESKTOP_ROUTES", "WORKFLOW_NEXT_ACTIONS",
      "WORKFLOW_OVERALL_STATES", "WORKFLOW_READINESS_SCHEMA_VERSION", "WORKFLOW_REMOTE_CONTROLLER_STATES", "WORKFLOW_REQUEST_CONVERSATION_STATES",
      "WORKFLOW_RUNNING_STATES", "WORKFLOW_RUNTIME_UPGRADE_STATES", "WorkflowBlocker", "WorkflowBlockerCode", "WorkflowCheckpointState",
      "WorkflowConnectionProjection", "WorkflowConversationMode", "WorkflowConversationProjection", "WorkflowDesktopProjection", "WorkflowReadinessInput",
      "WorkflowReadinessResult", "WorkflowRemoteProjection", "WorkflowRequestPolicy", "WorkflowNextAction", "WorkflowOverallState",
      "formatWorkflowReadinessHuman", "resolveWorkflowReadiness",
    ].sort());
    expect(exportsOf(read("src/mcp/server.ts"))).toEqual(["McpContext", "buildWorkspaceInfoWorkflow", "createMcpServer", "workflowOutputSchema"].sort());
  });

  it("keeps persistence and domain dependency boundaries explicit", () => {
    const sessionNames = fs.readdirSync(path.join(root, "src/session")).filter(name => name.endsWith(".ts"));
    const sessionFiles = Object.fromEntries(sessionNames.map(name => [name, read(`src/session/${name}`)]));
    for (const [name, source] of Object.entries(sessionFiles)) {
      if (name === "store.ts") continue;
      expect(source).not.toMatch(/from ["']node:fs|from ["']\.\.\/config\/paths/);
      expect(source).not.toMatch(/openSync\(|renameSync\(|writeFileSync\(|readFileSync\(/);
    }
    expect(sessionFiles["store.ts"]).toMatch(/openSync\([^)]*\.lock|openSync\(lock/);
    expect((sessionFiles["store.ts"].match(/renameSync\(/g) ?? []).length).toBe(1);
    expect((Object.values(sessionFiles).join("\n").match(/export function updateSession\(/g) ?? []).length).toBe(1);
    expect((Object.values(sessionFiles).join("\n").match(/openSync\([^\n]*\.lock|openSync\(lock/g) ?? []).length).toBe(1);
    expect(read("src/session/schema.ts")).not.toMatch(/node:crypto|process\.env|config\/paths/);
    expect(read("src/session/conversation.ts")).toMatch(/function projectChatOwnerFingerprint|function currentCodexThreadId/);
    expect(read("src/session/operations.ts")).not.toMatch(/\^\[a-f0-9\]\{64\}\$|PROJECT_CHAT_FP/);
    expect(read("src/workflow/readiness-policy.ts")).not.toMatch(/from ["'].*(?:session|mcp|cli|browser|node:fs|config\/paths)/);
    expect(read("src/workflow/readiness-policy.ts")).toMatch(/from ["']\.\/readiness-model\.js["']/);
    for (const file of ["base-schemas.ts", "tool-shared.ts", "workspace-tools.ts"]) {
      expect(read(`src/mcp/${file}`)).not.toContain("../workflow/readiness.js");
    }
    expect(read("src/mcp/server.ts")).not.toMatch(/server\.registerTool\s*\(/);
    const server = read("src/mcp/server.ts");
    let previousGroup = -1;
    for (const group of [
      "registerWorkspaceTools", "registerExecutionTools", "registerWriteProbeTools",
      "registerRemoteTools", "registerDesktopTools", "registerFeedbackProbeTools", "registerFeedbackTools",
    ]) {
      const index = server.indexOf(`${group}(`);
      expect(index).toBeGreaterThan(previousGroup);
      previousGroup = index;
    }
    const toolOrder = ["src/mcp/workspace-tools.ts", "src/mcp/execution-tools.ts", "src/mcp/write-probe-tools.ts"]
      .map(file => read(file)).join("\n");
    let previous = -1;
    for (const name of ["workspace_info", "list_directory", "read_file", "search_workspace", "git_status", "git_diff", "test_status", "execution_summary", "execution_output", "write_probe"]) {
      const index = toolOrder.indexOf(`\"${name}\"`);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
    expect(read("src/session/store.ts")).toMatch(/withFileLock|renameSync|writeFileSync/);
    expect((read("src/session/store.ts").match(/export function (?:updateSession|writeSession)/g) ?? []).length).toBe(2);
    expect(read("src/mcp/server.ts")).not.toMatch(/from ["'].*(?:cli|browser-companion)/);
    for (const file of ["tool-shared.ts", "base-schemas.ts", "workspace-tools.ts", "execution-tools.ts", "write-probe-tools.ts"]) {
      expect(read(`src/mcp/${file}`)).not.toMatch(/from ["'].*(?:cli|browser-companion)/);
    }
    const domainFiles = ["src/session", "src/workflow", "src/feedback", "src/desktop", "src/routing"]
      .flatMap(dir => fs.readdirSync(path.join(root, dir)).filter(name => name.endsWith(".ts")).map(name => path.join(dir, name)));
    for (const file of domainFiles) expect(read(file)).not.toMatch(/from ["'].*\/cli\//);
    for (const file of ["src/routing/execution-result-projector.ts", "src/routing/result-outbox-store.ts"]) {
      expect(read(file)).not.toMatch(/from ["'].*(?:feedback|browser-companion)/);
    }
    const companion = fs.readdirSync(path.join(root, "src/feedback")).filter(name => name.startsWith("companion") && name.endsWith(".ts"));
    for (const file of companion) expect(read(`src/feedback/${file}`)).not.toMatch(/from ["'].*(?:executor|routing-command|desktop\/service|desktop\/ipc)/);
  });
});
