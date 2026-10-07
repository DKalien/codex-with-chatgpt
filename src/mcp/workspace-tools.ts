import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";
import { CONNECTOR_CONTRACT_VERSION, type DesktopCompatibility } from "../auth/store.js";
import { gitDiff, gitInfo, gitStatus, type DiffMode } from "../workspace/git.js";
import { searchWorkspace } from "../workspace/search.js";
import { collectWorkflowCapabilityFacts } from "../workflow/facts.js";
import {
  remoteRequestCapability,
  requestAuthorization,
  requestConversationAvailable,
  workflowProjectionFailure,
  type WorkflowMcpProjection,
} from "../workflow/request.js";
import { resolveWorkflowReadiness } from "../workflow/readiness-policy.js";
import {
  WORKFLOW_READINESS_SCHEMA_VERSION,
  type WorkflowReadinessInput,
} from "../workflow/readiness-model.js";
import { Workspace } from "../workspace/manager.js";
import { controllerOnline, readRemote, RemoteError } from "../remote/store.js";
import {
  gitDiffOutputSchema,
  gitStatusOutputSchema,
  listDirectoryOutputSchema,
  readFileOutputSchema,
  searchWorkspaceOutputSchema,
  workflowOutputSchema,
  workspaceInfoOutputSchema,
} from "./base-schemas.js";
import {
  mapError,
  okStructured,
  requireScope,
  resolveToolWorkspace,
  UNTRUSTED_NOTE,
  workspaceIdShape,
  type McpContext,
  type WorkspaceSource,
} from "./tool-shared.js";

export { workflowOutputSchema } from "./base-schemas.js";

async function buildWorkspaceInfoWorkflow(
  workspace: Workspace,
  ctx: Pick<McpContext, "runtimeUpgrade">,
  extra: { authInfo?: AuthInfo; sessionId?: string; _meta?: unknown },
  requestDesktopCompatibility: DesktopCompatibility,
): Promise<WorkflowMcpProjection> {
  const conversationAvailable = requestConversationAvailable(extra);
  const capability = await collectWorkflowCapabilityFacts(workspace, {
    kind: "mcp_request",
    conversationAvailable,
  });
  const authorization = requestAuthorization(extra.authInfo);
  const connectorContract = CONNECTOR_CONTRACT_VERSION === 1 ? "current" : "unknown";
  const desktopCompatibility = requestDesktopCompatibility?.status ?? "unknown";
  const remoteCap = remoteRequestCapability(extra.authInfo?.scopes);
  const input: WorkflowReadinessInput = {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    connection: {
      running: "running",
      runtimeUpgrade: ctx.runtimeUpgrade?.() ?? "unknown",
      authorization,
      connectorContract,
      desktopCompatibility: desktopCompatibility as WorkflowReadinessInput["connection"]["desktopCompatibility"],
    },
    conversation: capability.conversation,
    desktop: capability.desktop,
    remote: capability.remote,
  };
  const result = resolveWorkflowReadiness(input, {
    remoteControl: remoteCap,
    currentConversation: conversationAvailable ? "available" : "unavailable",
    // MCP request: reuse persisted Desktop binding; no Bridge current-context identity.
    desktopRoute: "saved_binding",
  });
  return {
    schemaVersion: WORKFLOW_READINESS_SCHEMA_VERSION,
    overall: result.overall,
    nextAction: result.nextAction,
    requestContext: {
      source: "mcp_request",
      conversationIdentity: conversationAvailable ? "available" : "unavailable",
      remote: remoteCap,
    },
    connection: result.connection,
    conversation: result.conversation,
    desktop: result.desktop,
    remote: result.remote,
    blockers: result.blockers,
  };
}

export { buildWorkspaceInfoWorkflow };

type WorkspaceToolsContext = Pick<McpContext, "runtimeUpgrade"> & Partial<Pick<McpContext, "workspace" | "desktopCompatibility">>;

export function registerWorkspaceTools(
  server: McpServer,
  ctx: WorkspaceToolsContext,
  profile: "legacy" | "official" | "gateway" = "legacy",
  source: WorkspaceSource = ctx.workspace!,
): void {
  if (!source) throw new Error("Workspace tools require a workspace or resolver.");
  const workspaceInput = <T extends z.ZodRawShape>(shape: T = {} as T) => ({ ...workspaceIdShape(source), ...shape });
  const scope = (authInfo: AuthInfo | undefined, required: string) => requireScope(authInfo, required, typeof source === "function");
  server.registerTool(
    "workspace_info",
    {
      title: "Workspace info",
      description:
        `Get an overview of the connected workspace: identity, project type, languages, ` +
        `frameworks, git state, available scripts, and request-scoped bounded workflow readiness. ` +
        `Read-only: does not bind Desktop, create Remote threads, send Desktop tasks, or repair connections. ` +
        `Call this first. ${UNTRUSTED_NOTE}`,
      inputSchema: workspaceInput(),
      outputSchema: workspaceInfoOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (_args, extra) => {
      const denied = scope(extra.authInfo, "workspace.read");
      if (denied) return denied;
      try {
        const workspace = resolveToolWorkspace(source, _args, extra.authInfo);
        const project = workspace.detectProject();
        const git = gitInfo(workspace.root);
        const requestDesktopCompatibility = profile !== "legacy"
          ? { status: "unknown" as const }
          : ctx.desktopCompatibility?.(extra.authInfo) ?? { status: "unknown" as const };
        let workflow: WorkflowMcpProjection;
        try {
          workflow = profile !== "legacy"
            ? buildOfficialWorkspaceInfoWorkflow(workspace, extra.authInfo)
            : await buildWorkspaceInfoWorkflow(workspace, ctx, extra, requestDesktopCompatibility);
        } catch {
          // workspace identity is the recovery entry: never fail the whole tool on readiness projection.
          // Fallback must still match workflowOutputSchema (full projection shape).
          let conversationIdentity: "available" | "unavailable" = "unavailable";
          try {
            conversationIdentity = requestConversationAvailable(extra) ? "available" : "unavailable";
          } catch {
            conversationIdentity = "unavailable";
          }
          workflow = workflowProjectionFailure({
            conversationIdentity,
            remoteCapability: remoteRequestCapability(extra.authInfo?.scopes),
            authorization: requestAuthorization(extra.authInfo),
            desktopCompatibility: requestDesktopCompatibility?.status,
            connectorContract: CONNECTOR_CONTRACT_VERSION === 1 ? "current" : "unknown",
          });
        }
        return okStructured({
          connectorContractVersion: CONNECTOR_CONTRACT_VERSION,
          desktopCompatibility: requestDesktopCompatibility,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          rootAlias: "workspace:/",
          ...project,
          git: {
            isRepo: git.isRepo,
            branch: git.branch,
            commit: git.commit,
            dirty: git.dirty,
          },
          workflow,
        });
      } catch (error) {
        return mapError(error);
      }
    },
  );

  server.registerTool(
    "list_directory",
    {
      title: "List directory",
      description:
        `List files and directories under a workspace-relative path. High-noise directories ` +
        `(node_modules, .git, build output) are omitted. Supports pagination. ${UNTRUSTED_NOTE}`,
      inputSchema: workspaceInput({
        path: z.string().default(".").describe("Workspace-relative path, e.g. 'src'"),
        depth: z.number().int().min(1).max(4).default(1).describe("Recursion depth (1-4)"),
        limit: z.number().int().min(1).max(1000).default(200),
        offset: z.number().int().min(0).default(0),
      }),
      outputSchema: listDirectoryOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args, extra) => {
      const denied = scope(extra.authInfo, "workspace.read");
      if (denied) return denied;
      try {
        const workspace = resolveToolWorkspace(source, args, extra.authInfo);
        return okStructured(await workspace.listDirectory(args.path, args));
      } catch (error) {
        return mapError(error);
      }
    },
  );

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description:
        `Read a text file from the workspace with line-range pagination. Defaults to the first ` +
        `400 lines; use start_line/end_line to page through large files. Sensitive files ` +
        `(.env, keys, credentials) are always denied. ${UNTRUSTED_NOTE}`,
      inputSchema: workspaceInput({
        path: z.string().describe("Workspace-relative file path"),
        start_line: z.number().int().min(1).optional().describe("1-based first line to return"),
        end_line: z.number().int().min(1).optional().describe("1-based last line to return"),
      }),
      outputSchema: readFileOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args, extra) => {
      const denied = scope(extra.authInfo, "workspace.read");
      if (denied) return denied;
      try {
        const workspace = resolveToolWorkspace(source, args, extra.authInfo);
        return okStructured(await workspace.readFile(args.path, { startLine: args.start_line, endLine: args.end_line }));
      } catch (error) {
        return mapError(error);
      }
    },
  );

  server.registerTool(
    "search_workspace",
    {
      title: "Search workspace",
      description:
        `Search file contents across the workspace (ripgrep when available). Returns matching ` +
        `lines with file paths and line numbers. ${UNTRUSTED_NOTE}`,
      inputSchema: workspaceInput({
        query: z.string().min(2).describe("Text to search for (literal by default)"),
        path: z.string().optional().describe("Restrict search to this workspace-relative path"),
        glob: z.string().optional().describe("Filename glob filter, e.g. '*.ts'"),
        limit: z.number().int().min(1).max(200).default(50),
        regex: z.boolean().default(false).describe("Treat query as a regular expression"),
      }),
      outputSchema: searchWorkspaceOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args, extra) => {
      const denied = scope(extra.authInfo, "workspace.search");
      if (denied) return denied;
      try {
        const workspace = resolveToolWorkspace(source, args, extra.authInfo);
        return okStructured(await searchWorkspace(workspace, args));
      } catch (error) {
        return mapError(error);
      }
    },
  );

  server.registerTool(
    "git_status",
    {
      title: "Git status",
      description: `Structured git status of the workspace: branch, staged/unstaged/untracked files. ${UNTRUSTED_NOTE}`,
      inputSchema: workspaceInput(),
      outputSchema: gitStatusOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (_args, extra) => {
      const denied = scope(extra.authInfo, "git.read");
      if (denied) return denied;
      try {
        const workspace = resolveToolWorkspace(source, _args, extra.authInfo);
        return okStructured(gitStatus(workspace.root));
      } catch (error) {
        return mapError(error);
      }
    },
  );

  server.registerTool(
    "git_diff",
    {
      title: "Git diff",
      description:
        `Git diff with byte-offset pagination. mode: 'unstaged' (default), 'staged', or 'head' ` +
        `(working tree vs HEAD). When hasMore is true, call again with offset=nextOffset. ${UNTRUSTED_NOTE}`,
      inputSchema: workspaceInput({
        mode: z.enum(["unstaged", "staged", "head"]).default("unstaged"),
        path: z.string().optional().describe("Limit the diff to one workspace-relative path"),
        offset: z.number().int().min(0).default(0).describe("Byte offset for pagination"),
        max_bytes: z.number().int().min(1024).max(262144).default(65536),
      }),
      outputSchema: gitDiffOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args, extra) => {
      const denied = scope(extra.authInfo, "git.read");
      if (denied) return denied;
      try {
        const workspace = resolveToolWorkspace(source, args, extra.authInfo);
        let relPath: string | undefined;
        if (args.path) {
          relPath = workspace.resolve(args.path).rel;
        }
        return okStructured(
          gitDiff(
            workspace,
            { mode: args.mode as DiffMode, offset: args.offset, maxBytes: args.max_bytes },
            relPath,
          ),
        );
      } catch (error) {
        return mapError(error);
      }
    },
  );
}

function buildOfficialWorkspaceInfoWorkflow(workspace: Workspace, authInfo: AuthInfo | undefined): WorkflowMcpProjection {
  const capability = remoteRequestCapability(authInfo?.scopes);
  let remote: WorkflowMcpProjection["remote"] = {
    enabled: false,
    controller: "unknown",
    activeWork: false,
    needsReconciliation: false,
  };
  try {
    const state = readRemote(workspace.id);
    if (state) {
      if (state.workspaceRoot !== workspace.root) throw new RemoteError("UNKNOWN_WORKSPACE");
      const activeStatuses = new Set(["queued", "starting", "running", "awaiting_approval"]);
      remote = {
        enabled: state.enabled,
        controller: !state.controller ? "unknown"
          : !controllerOnline(state) ? "offline"
            : state.controller.appServer === "running" ? "online" : "unknown",
        activeWork: state.tasks.some(task => activeStatuses.has(task.status)),
        needsReconciliation: [...state.tasks, ...state.threads].some(task => task.status === "needs_reconciliation"),
      };
    }
  } catch {
    // Corrupt or mismatched remote state must never turn the official profile Ready.
  }
  const controllerReady = remote.controller === "online";
  const authorizedRemote = capability === "current";
  const overall: WorkflowMcpProjection["overall"] = !remote.enabled || !controllerReady
      ? "needs_connection"
      : !authorizedRemote
        ? "needs_authorization"
        : "ready_remote";
  const nextAction: WorkflowMcpProjection["nextAction"] = !remote.enabled || !controllerReady
      ? "repair_connection"
      : !authorizedRemote
        ? "resume_authorization"
        : "use_remote";
  const blockers: WorkflowMcpProjection["blockers"] = !remote.enabled || !controllerReady
      ? [{ code: "remote_controller_unknown" }]
      : capability === "incomplete"
        ? [{ code: "remote_request_scope_incomplete" }]
        : capability === "none"
          ? [{ code: "remote_request_scope_missing" }]
          : [];
  return {
    schemaVersion: WORKFLOW_READINESS_SCHEMA_VERSION,
    overall,
    nextAction,
    requestContext: {
      source: "mcp_request",
      conversationIdentity: "unavailable",
      remote: capability,
    },
    connection: {
      running: "running",
      runtimeUpgrade: "unknown",
      authorization: requestAuthorization(authInfo),
      connectorContract: CONNECTOR_CONTRACT_VERSION === 1 ? "current" : "unknown",
      desktopCompatibility: "unknown",
    },
    conversation: {
      mode: "unknown",
      projectReady: false,
      chatKnown: false,
      chatBinding: "none",
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
    remote,
    blockers,
  };
}
