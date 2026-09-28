import { z } from "zod";
import { executionRecordSchema } from "../execution/records.js";
import { CONNECTOR_CONTRACT_VERSION } from "../auth/store.js";
import {
  WORKFLOW_AUTHORIZATION_STATES,
  WORKFLOW_BLOCKER_CODES,
  WORKFLOW_BLOCKER_DETAIL_MAX,
  WORKFLOW_CHAT_BINDING_STATES,
  WORKFLOW_CHECKPOINT_STATES,
  WORKFLOW_CONNECTOR_CONTRACT_STATES,
  WORKFLOW_CONVERSATION_MODES,
  WORKFLOW_DESKTOP_AVAILABILITY,
  WORKFLOW_DESKTOP_COMPATIBILITY_STATES,
  WORKFLOW_DESKTOP_CURRENT_TARGETS,
  WORKFLOW_NEXT_ACTIONS,
  WORKFLOW_OVERALL_STATES,
  WORKFLOW_READINESS_SCHEMA_VERSION,
  WORKFLOW_REMOTE_CONTROLLER_STATES,
  WORKFLOW_RUNNING_STATES,
  WORKFLOW_RUNTIME_UPGRADE_STATES,
} from "../workflow/readiness-model.js";

export const workflowOutputSchema = z.object({
  schemaVersion: z.literal(WORKFLOW_READINESS_SCHEMA_VERSION),
  overall: z.enum(WORKFLOW_OVERALL_STATES),
  nextAction: z.enum(WORKFLOW_NEXT_ACTIONS),
  requestContext: z.object({
    source: z.literal("mcp_request"),
    conversationIdentity: z.enum(["available", "unavailable"]),
    remote: z.enum(["current", "incomplete", "none"]),
  }),
  connection: z.object({
    running: z.enum(WORKFLOW_RUNNING_STATES),
    runtimeUpgrade: z.enum(WORKFLOW_RUNTIME_UPGRADE_STATES),
    authorization: z.enum(WORKFLOW_AUTHORIZATION_STATES),
    connectorContract: z.enum(WORKFLOW_CONNECTOR_CONTRACT_STATES),
    desktopCompatibility: z.enum(WORKFLOW_DESKTOP_COMPATIBILITY_STATES),
  }),
  conversation: z.object({
    mode: z.enum(WORKFLOW_CONVERSATION_MODES),
    projectReady: z.boolean(),
    chatKnown: z.boolean(),
    chatBinding: z.enum(WORKFLOW_CHAT_BINDING_STATES),
    checkpoint: z.enum(WORKFLOW_CHECKPOINT_STATES),
    sessionCorrupt: z.boolean(),
  }),
  desktop: z.object({
    configured: z.boolean(),
    enabled: z.boolean(),
    currentTarget: z.enum(WORKFLOW_DESKTOP_CURRENT_TARGETS),
    bindingAvailability: z.enum(WORKFLOW_DESKTOP_AVAILABILITY),
    unresolvedDelivery: z.boolean(),
  }),
  remote: z.object({
    enabled: z.boolean(),
    controller: z.enum(WORKFLOW_REMOTE_CONTROLLER_STATES),
    activeWork: z.boolean(),
    needsReconciliation: z.boolean(),
  }),
  blockers: z.array(z.object({
    code: z.enum(WORKFLOW_BLOCKER_CODES),
    detail: z.string().max(WORKFLOW_BLOCKER_DETAIL_MAX).optional(),
  })),
});

export const workspaceInfoOutputSchema = {
  connectorContractVersion: z.literal(CONNECTOR_CONTRACT_VERSION),
  desktopCompatibility: z.object({ status: z.enum(["none", "legacy", "incomplete", "current", "unknown", "corrupt"]) }),
  workspaceId: z.string(),
  workspaceName: z.string(),
  rootAlias: z.string(),
  projectType: z.string(),
  languages: z.array(z.string()),
  frameworks: z.array(z.string()),
  packageManager: z.string().nullable(),
  scripts: z.record(z.string()),
  git: z.object({
    isRepo: z.boolean(),
    branch: z.string().nullable(),
    commit: z.string().nullable(),
    dirty: z.boolean(),
  }),
  workflow: workflowOutputSchema,
};

export const listDirectoryOutputSchema = {
  path: z.string(),
  entries: z.array(z.object({
    path: z.string(),
    type: z.enum(["file", "dir"]),
    sizeBytes: z.number().int().nonnegative().optional(),
  })),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  hasMore: z.boolean(),
};

export const readFileOutputSchema = {
  path: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  totalLines: z.number().int().nonnegative(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().nonnegative(),
  truncated: z.boolean(),
  remainingLines: z.number().int().nonnegative(),
  nextStartLine: z.number().int().positive().nullable(),
  content: z.string(),
};

export const searchWorkspaceOutputSchema = {
  matches: z.array(z.object({
    path: z.string(),
    line: z.number().int().nonnegative(),
    text: z.string(),
  })),
  matchCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  engine: z.enum(["ripgrep", "node"]),
};

export const gitStatusOutputSchema = {
  isRepo: z.boolean(),
  branch: z.string().nullable(),
  upstream: z.string().nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  staged: z.array(z.object({ path: z.string(), change: z.string() })),
  unstaged: z.array(z.object({ path: z.string(), change: z.string() })),
  untracked: z.array(z.string()),
  conflicted: z.array(z.string()),
};

export const gitDiffOutputSchema = {
  isRepo: z.boolean(),
  mode: z.enum(["unstaged", "staged", "head"]),
  totalBytes: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  returnedBytes: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  nextOffset: z.number().int().nonnegative().nullable(),
  diff: z.string(),
};

export const testStatusOutputSchema = {
  available: z.boolean(),
  message: z.string().optional(),
  taskId: z.string().optional(),
  iteration: z.number().int().nonnegative().optional(),
  tests: z.string().nullable().optional(),
  exitStatus: z.string().optional(),
  timestamp: z.string().optional(),
  outputAvailable: z.boolean().optional(),
  outputId: z.number().int().positive().nullable().optional(),
};

export const executionSummaryOutputSchema = {
  records: z.array(executionRecordSchema),
};

export const executionOutputOutputSchema = {
  action: z.enum(["list", "read"]).describe("The operation represented by this result"),
  items: z.array(z.object({
    id: z.number().int().positive(),
    command: z.string(),
    exitCode: z.number().int().nullable(),
    timestamp: z.string(),
    taskId: z.string().nullable(),
    iteration: z.number().int().nullable(),
    readable: z.boolean(),
    status: z.enum(["readable", "restricted"]),
    truncated: z.boolean(),
    sizeBytes: z.number().int().nonnegative(),
  })).optional().describe("Recorded output metadata returned by the list operation"),
  id: z.number().int().positive().optional(),
  command: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
  timestamp: z.string().optional(),
  truncated: z.boolean().optional(),
  text: z.string().optional().describe("Sanitized command output returned by the read operation"),
};
