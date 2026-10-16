import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DesktopClient } from "../src/desktop/ipc.js";
import { updateDesktop } from "../src/desktop/store.js";
import { Registry } from "../src/gateway/registry.js";
import { createMcpServer } from "../src/mcp/server.js";
import { recordResult } from "../src/results/store.js";
import { cleanup, makeGitRepo, makeTmpDir, write } from "./helpers.js";
import { FakeDesktop } from "./fake-desktop.js";

const THREAD = randomUUID();
let root: string;
let registry: Registry;
let workspaceId: string;
let fake: FakeDesktop | undefined;
const clients: Client[] = [];

beforeAll(() => {
  root = makeTmpDir("mcp-ws");
  makeGitRepo(root);
  registry = new Registry();
  workspaceId = registry.add(root).workspaceId;
});
afterAll(() => cleanup(root));
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await fake?.stop();
  fake = undefined;
});

async function connect() {
  fake = await new FakeDesktop().start();
  const pipe = fake.pipe;
  const server = createMcpServer({ registry, desktop: { connect: () => DesktopClient.connect({ pipe }), busyWaitMs: 200, pollMs: 10 } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  clients.push(client);
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { text: string }[])[0].text;
  return { isError: res.isError === true, data: JSON.parse(text) as any, structured: res.structuredContent as any };
}

const bind = () => updateDesktop(workspaceId, (s) => { s.binding = { threadId: THREAD, boundAt: "2026-01-01T00:00:00.000Z" }; s.deliveries = []; });

describe("mcp tools", () => {
  it("lists tools with the right annotations", async () => {
    const { tools } = await (await connect()).listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual([
      "codex_desktop_send", "codex_desktop_status", "codex_task_result", "gateway_list_workspaces",
      "git_diff", "git_status", "list_directory", "read_file", "search_workspace", "workspace_info",
    ]);
    for (const [name, tool] of Object.entries(byName)) {
      if (name === "codex_desktop_send") expect(tool.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
      else expect(tool.annotations?.readOnlyHint).toBe(true);
    }
    expect(byName.codex_desktop_send.description).toContain("codex_task_result");
  });

  it("reads the workspace", async () => {
    const client = await connect();
    const list = await call(client, "gateway_list_workspaces");
    expect(list.data.workspaces).toEqual([{ workspaceId, name: expect.any(String) }]);

    const info = await call(client, "workspace_info", { workspaceId });
    expect(info.structured.workspaceId).toBe(workspaceId);
    expect(info.structured.git).toMatchObject({ isRepo: true, branch: "main", dirty: false });

    const dir = await call(client, "list_directory", { workspaceId });
    expect(dir.data.entries.map((e: any) => e.path)).toContain("hello.txt");

    const file = await call(client, "read_file", { workspaceId, path: "hello.txt" });
    expect(file.data.content).toContain("Hello from Codex");

    const found = await call(client, "search_workspace", { workspaceId, query: "answer" });
    expect(found.data.matches[0].path).toBe("src/index.ts");

    write(root, "hello.txt", "changed\n");
    const status = await call(client, "git_status", { workspaceId });
    expect(JSON.stringify(status.data)).toContain("hello.txt");
    const diff = await call(client, "git_diff", { workspaceId, path: "hello.txt" });
    expect(diff.data.diff).toContain("+changed");
  });

  it("maps errors to {error, message}", async () => {
    const client = await connect();
    write(root, ".env", "SECRET=1\n");
    const denied = await call(client, "read_file", { workspaceId, path: ".env" });
    expect(denied.isError).toBe(true);
    expect(denied.data.error).toBe("ACCESS_DENIED_SENSITIVE_FILE");

    const outside = await call(client, "read_file", { workspaceId, path: "../x" });
    expect(outside.data.error).toBe("PATH_OUTSIDE_WORKSPACE");

    const unknown = await call(client, "workspace_info", { workspaceId: "000000000000" });
    expect(unknown).toMatchObject({ isError: true, data: { error: "UNKNOWN_WORKSPACE" } });

    // schema validation errors also come back as tool errors
    expect((await call(client, "git_status", { workspaceId: "bad" }).catch(() => ({ isError: true }))).isError).toBe(true);
  });

  it("sends to Desktop once per commandId and returns the result", async () => {
    const client = await connect();
    const empty = await call(client, "codex_desktop_status", { workspaceId });
    expect(empty.data).toMatchObject({ binding: null, available: false });
    expect((await call(client, "codex_desktop_send", { workspaceId, commandId: "t1", message: "do it" })).data.error).toBe("DESKTOP_NOT_BOUND");

    bind();
    const status = await call(client, "codex_desktop_status", { workspaceId, commandId: "t1" });
    expect(status.data).toMatchObject({ available: true, busy: false, delivery: null, result: null });

    const sent = await call(client, "codex_desktop_send", { workspaceId, commandId: "t1", message: "do it" });
    expect(sent.isError).toBe(false);
    expect(sent.structured).toMatchObject({ commandId: "t1", status: "accepted" });
    expect(fake!.startTurnCount).toBe(1);

    const again = await call(client, "codex_desktop_send", { workspaceId, commandId: "t1", message: "do it" });
    expect(again.structured.status).toBe("accepted");
    expect(fake!.startTurnCount).toBe(1);

    const conflict = await call(client, "codex_desktop_send", { workspaceId, commandId: "t1", message: "other" });
    expect(conflict.data.error).toBe("COMMAND_CONFLICT");

    expect((await call(client, "codex_task_result", { workspaceId, commandId: "t1" })).data.result).toBeNull();
    expect((await call(client, "codex_task_result", { workspaceId })).data.result).toBeNull();

    recordResult({ workspaceId, commandId: "t1", status: "ok", summary: "done", changedFiles: ["a.ts"] });
    const result = await call(client, "codex_task_result", { workspaceId, commandId: "t1" });
    expect(result.data.result).toMatchObject({ commandId: "t1", status: "ok", summary: "done" });
    expect((await call(client, "codex_task_result", { workspaceId })).data.result.commandId).toBe("t1");

    const final = await call(client, "codex_desktop_status", { workspaceId, commandId: "t1" });
    expect(final.data.delivery.status).toBe("accepted");
    expect(final.data.result.summary).toBe("done");
  });
});
