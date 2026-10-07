import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GatewayRegistry, gatewayRegistryFile } from "../src/gateway/registry.js";
import { registerGatewayTools } from "../src/mcp/gateway.js";
import { readRemote, remoteFile, setRemoteEnabled, updateRemote } from "../src/remote/store.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

type ToolHandler = (input: unknown, extra: unknown) => unknown | Promise<unknown>;
type ToolRegistration = { config: unknown; handler: ToolHandler };

let previousStateDir: string | undefined;
let stateDir: string;
let roots: string[];
let workspaces: Workspace[];
let registry: GatewayRegistry;
let tools: Map<string, ToolRegistration>;

beforeEach(() => {
  previousStateDir = process.env.C2C_STATE_DIR;
  stateDir = makeTmpDir("gateway-tools-state");
  process.env.C2C_STATE_DIR = stateDir;
  roots = [makeTmpDir("gateway-tools-a"), makeTmpDir("gateway-tools-b")];
  workspaces = roots.map(root => new Workspace(root));
  registry = new GatewayRegistry(stateDir);
  tools = new Map();
  const server = {
    registerTool(name: string, config: unknown, handler: (input: never, extra: never) => unknown) {
      tools.set(name, { config, handler: handler as unknown as ToolHandler });
    },
  } as unknown as McpServer;
  registerGatewayTools(server, registry);
});

afterEach(() => {
  for (const root of roots) cleanup(root);
  cleanup(stateDir);
  if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = previousStateDir;
});

function invoke(name: string, input: unknown, clientId?: string, scopes = ["workspace.read", "workspace.search", "git.read", "codex.read", "codex.control"]): Promise<unknown> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return Promise.resolve(tool.handler(input, clientId ? { authInfo: { clientId, scopes } } : {}));
}

function payload(result: unknown): Record<string, unknown> {
  const value = result as { content?: { text?: string }[] };
  return JSON.parse(value.content?.[0]?.text ?? "{}") as Record<string, unknown>;
}

function hasRequiredWorkspaceId(inputSchema: unknown): boolean {
  if (!inputSchema || typeof inputSchema !== "object") return false;
  const schema = inputSchema as { safeParse?: (value: unknown) => { success: boolean; error?: { issues: { path: PropertyKey[] }[] } } };
  if (typeof schema.safeParse === "function") {
    const parsed = schema.safeParse({});
    return !parsed.success && !!parsed.error?.issues.some(issue => issue.path[0] === "workspaceId");
  }
  return Object.hasOwn(inputSchema, "workspaceId");
}

function enableOfficial(workspace: Workspace, clientId: string, targetId = randomUUID()): string {
  setRemoteEnabled(workspace, true, { deliveryMode: "official" });
  const target = {
    targetId,
    hostId: "local" as const,
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    threadId: `thread-${workspace.id}`,
    createdAt: new Date().toISOString(),
    source: "created" as const,
    clientId,
  };
  updateRemote(workspace.id, current => {
    current!.targets = [target];
    return { state: current!, result: undefined };
  });
  return targetId;
}

describe("Gateway MCP tools", () => {
  it("lists only the caller's fresh grants and requires authenticated workspace routing", async () => {
    const [first, second] = workspaces;
    const grantA = registry.register(first!.root, "client-a");
    const grantB = registry.register(second!.root, "client-a");
    registry.register(second!.root, "client-b");

    const listed = payload(await invoke("gateway_list_workspaces", {}, "client-a"));
    expect(listed.clientId).toBe("client-a");
    expect(listed.workspaces).toEqual([
      { workspaceId: grantA.workspaceId, root: first!.root, name: first!.name },
      { workspaceId: grantB.workspaceId, root: second!.root, name: second!.name },
    ]);
    expect(JSON.stringify(listed)).not.toContain("clientIds");
    expect(payload(await invoke("gateway_list_workspaces", {}, "client-b")).workspaces).toEqual([
      { workspaceId: grantB.workspaceId, root: second!.root, name: second!.name },
    ]);
    expect(payload(await invoke("gateway_list_workspaces", {})).error).toBe("AUTH_REQUIRED");
    expect(payload(await invoke("gateway_list_workspaces", {}, "client-a", [])).error).toBe("INSUFFICIENT_SCOPE");
    expect(payload(await invoke("workspace_info", { workspaceId: first!.id })).error).toBe("AUTH_REQUIRED");
    for (const name of ["workspace_info", "list_directory", "read_file", "search_workspace", "git_status", "git_diff",
      "codex_create_thread", "codex_submit_task", "codex_list_targets", "codex_task_result", "codex_cancel_task",
      "feedback_bootstrap_status", "web_sink_status", "execution_output"]) {
      const inputSchema = (tools.get(name)!.config as { inputSchema: unknown }).inputSchema;
      expect(hasRequiredWorkspaceId(inputSchema), name).toBe(true);
    }
    for (const name of ["gateway_list_workspaces", "codex_list_targets", "codex_task_result", "codex_cancel_task", "feedback_bootstrap_status", "web_sink_status", "execution_output"])
      expect(tools.has(name)).toBe(true);
  });

  it("re-reads authorization on every call and isolates roots, targets, and task history", async () => {
    const [first, second] = workspaces;
    const grantA = registry.register(first!.root, "client-a");
    registry.register(second!.root, "client-a");
    registry.register(second!.root, "client-b");
    const auth = { authInfo: { clientId: "client-a", scopes: ["workspace.read", "codex.read", "codex.control"] } };

    write(first!.root, "only-a.txt", "root-a");
    write(second!.root, "only-b.txt", "root-b");
    const readA = await tools.get("read_file")!.handler({ workspaceId: first!.id, path: "only-a.txt" }, auth);
    const readB = await tools.get("read_file")!.handler({ workspaceId: second!.id, path: "only-b.txt" }, auth);
    expect(payload(readA).content).toBe("root-a");
    expect(payload(readB).content).toBe("root-b");
    expect(payload(await invoke("workspace_info", { workspaceId: first!.id }, "client-b")).error).toBe("GATEWAY_CLIENT_NOT_AUTHORIZED");

    registry.revoke(grantA.workspaceId, "client-a");
    const revokedWithSameAuth = await tools.get("workspace_info")!.handler({ workspaceId: first!.id }, auth);
    expect(payload(revokedWithSameAuth).error).toBe("GATEWAY_UNKNOWN_WORKSPACE");

    const targetA = enableOfficial(first!, "client-a");
    enableOfficial(second!, "client-a");
    const now = new Date().toISOString();
    const taskIdA = randomUUID();
    updateRemote(first!.id, current => {
      current!.tasks.push({ taskId: taskIdA, targetId: targetA, threadId: `thread-${first!.id}`,
        workspaceId: first!.id, commandId: "command-a", kind: "ANALYZE", goal: "private root-a task",
        clientId: "client-a", status: "completed", createdAt: now, updatedAt: now });
      return { state: current!, result: undefined };
    });
    const beforeB = fs.readFileSync(remoteFile(second!.id), "utf8");
    const taskStatus = await invoke("codex_task_status", { workspaceId: second!.id, taskId: taskIdA }, "client-a");
    const taskResult = await invoke("codex_task_result", { workspaceId: second!.id, taskId: taskIdA }, "client-a");
    const crossTarget = await invoke("codex_submit_task", { workspaceId: second!.id, targetId: targetA,
      commandId: "cross-root-command", kind: "ANALYZE", goal: "must not enqueue" }, "client-a");
    expect(payload(taskStatus).error).toBe("UNKNOWN_TASK");
    expect(payload(taskResult).error).toBe("UNKNOWN_TASK");
    expect(payload(crossTarget).error).toBe("UNKNOWN_TARGET");
    expect(fs.readFileSync(remoteFile(second!.id), "utf8")).toBe(beforeB);
    expect(readRemote(second!.id)?.tasks).toEqual([]);
    expect(readRemote(first!.id)?.tasks.map(task => task.taskId)).toEqual([taskIdA]);
  });

  it("rejects a changed root identity before reading or writing workspace state", async () => {
    const [first, second] = workspaces;
    const entry = registry.register(first!.root, "client-a");
    const file = gatewayRegistryFile(stateDir);
    const state = JSON.parse(fs.readFileSync(file, "utf8")) as { workspaces: { workspaceId: string; root: string }[] };
    state.workspaces[0]!.root = second!.root;
    fs.writeFileSync(file, JSON.stringify(state));

    const result = await invoke("workspace_info", { workspaceId: entry.workspaceId }, "client-a");
    expect(payload(result).error).toBe("GATEWAY_WORKSPACE_ID_MISMATCH");
    expect(fs.existsSync(remoteFile(first!.id))).toBe(false);
    expect(fs.existsSync(remoteFile(second!.id))).toBe(false);
  });

  it("requires official delivery mode before routing Gateway Remote calls", async () => {
    const [first] = workspaces;
    registry.register(first!.root, "client-a");
    setRemoteEnabled(first!, true);
    const before = fs.readFileSync(remoteFile(first!.id), "utf8");

    const result = await invoke("codex_task_status", { workspaceId: first!.id, taskId: "missing-task" }, "client-a");
    expect(payload(result).error).toBe("OFFICIAL_MODE_REQUIRED");
    expect(fs.readFileSync(remoteFile(first!.id), "utf8")).toBe(before);
  });
});
