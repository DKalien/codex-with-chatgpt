import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { latestExecutionRecord, readExecutionRecords } from "../execution/records.js";
import { listExecutionOutputs, readExecutionOutput } from "../execution/output.js";
import { executionOutputOutputSchema, executionSummaryOutputSchema, testStatusOutputSchema } from "./base-schemas.js";
import { fail, mapError, okStructured, requireScope, resolveToolWorkspace, workspaceIdShape, UNTRUSTED_NOTE, type McpContext, type WorkspaceResolver } from "./tool-shared.js";

export function registerExecutionTools(server: McpServer, ctx: McpContext | WorkspaceResolver): void {
  const workspaceSource = typeof ctx === "function" ? ctx : ctx.workspace;
  server.registerTool(
    "test_status",
    {
      title: "Test status",
      description:
        `Summary of the most recent test run reported by the Codex harness. This does NOT run ` +
        `tests; it reads the latest execution record. ${UNTRUSTED_NOTE}`,
      inputSchema: { ...workspaceIdShape(workspaceSource) },
      outputSchema: testStatusOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args, extra) => {
      const denied = requireScope(extra.authInfo, "execution.read");
      if (denied) return denied;
      let workspace;
      try { workspace = resolveToolWorkspace(workspaceSource, args, extra.authInfo); }
      catch (error) { return mapError(error); }
      const latest = latestExecutionRecord(workspace.id);
      if (!latest) {
        return okStructured({ available: false, message: "No execution records yet for this workspace." });
      }
      return okStructured({
        available: true,
        taskId: latest.taskId,
        iteration: latest.iteration,
        tests: latest.tests,
        exitStatus: latest.exitStatus,
        timestamp: latest.timestamp,
        outputAvailable: Boolean(latest.outputAvailable),
        outputId: latest.outputId ?? null,
      });
    },
  );

  server.registerTool(
    "execution_summary",
    {
      title: "Execution summary",
      description:
        `Recent Codex execution records for this workspace: task id, iteration, changed files, ` +
        `tests and exit status. For Desktop Review, match the original delivery commandId exactly, then read that record's outputId; ` +
        `a missing record means this task has no execution receipt, never substitute historical test_status. ${UNTRUSTED_NOTE}`,
      inputSchema: {
        ...workspaceIdShape(workspaceSource),
        limit: z.number().int().min(1).max(50).default(5),
      },
      outputSchema: executionSummaryOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args, extra) => {
      const denied = requireScope(extra.authInfo, "execution.read");
      if (denied) return denied;
      let workspace;
      try { workspace = resolveToolWorkspace(workspaceSource, args, extra.authInfo); }
      catch (error) { return mapError(error); }
      return okStructured({ records: readExecutionRecords(workspace.id, args.limit) });
    },
  );

  server.registerTool(
    "execution_output",
    {
      title: "Execution output",
      description:
        `List or read command output that Codex chose to record after a test/build/lint/typecheck ` +
        `run. Call with action=list first, then action=read and an id. Restricted items have no ` +
        `body. This does not run commands. ${UNTRUSTED_NOTE}`,
      inputSchema: {
        ...workspaceIdShape(workspaceSource),
        action: z.enum(["list", "read"]).default("list"),
        id: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(50).default(20),
      },
      outputSchema: executionOutputOutputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args, extra) => {
      const denied = requireScope(extra.authInfo, "execution.read");
      if (denied) return denied;
      let workspace;
      try { workspace = resolveToolWorkspace(workspaceSource, args, extra.authInfo); }
      catch (error) { return mapError(error); }
      const action = args.action ?? "list";
      if (action === "list") {
        const items = listExecutionOutputs(workspace.id, args.limit).map((item) => ({
          id: item.id,
          command: item.command,
          exitCode: item.exitCode,
          timestamp: item.timestamp,
          taskId: item.taskId ?? null,
          iteration: item.iteration ?? null,
          readable: item.allowed,
          status: item.allowed ? "readable" : "restricted",
          truncated: item.truncated,
          sizeBytes: item.sizeBytes,
        }));
        return okStructured({ action: "list", items });
      }
      if (args.id === undefined) {
        return fail("INVALID_ARGUMENTS", "read requires id");
      }
      const result = readExecutionOutput(workspace.id, args.id);
      if (!result.ok) {
        if (result.error === "OUTPUT_RESTRICTED") {
          return fail("OUTPUT_RESTRICTED", "This output was not released for ChatGPT to read.");
        }
        return fail("NOT_FOUND", `No execution output with id ${args.id}.`);
      }
      return okStructured({
        action: "read",
        id: result.meta.id,
        command: result.meta.command,
        exitCode: result.meta.exitCode,
        timestamp: result.meta.timestamp,
        truncated: result.meta.truncated,
        text: result.text,
      });
    },
  );
}
