import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runCli } from "../src/cli/index.js";
import { companionToken } from "../src/companion/store.js";
import { DesktopClient } from "../src/desktop/ipc.js";
import { updateDesktop } from "../src/desktop/store.js";
import { Registry } from "../src/gateway/registry.js";
import { startGatewayServer } from "../src/gateway/server.js";
import { createMcpServer } from "../src/mcp/server.js";
import { cleanup, makeGitRepo, makeTmpDir } from "./helpers.js";
import { FakeDesktop } from "./fake-desktop.js";

let root: string;
let fake: FakeDesktop;
let gw: Awaited<ReturnType<typeof startGatewayServer>>;
let client: Client;

beforeAll(async () => {
  root = makeTmpDir("e2e-ws");
  makeGitRepo(root);
  fake = await new FakeDesktop().start();
  gw = await startGatewayServer({ port: 0, publicUrl: "https://gw.example.test", runtimeToken: "t" });
  const pipe = fake.pipe;
  const server = createMcpServer({ registry: new Registry(), desktop: { connect: () => DesktopClient.connect({ pipe }), busyWaitMs: 200, pollMs: 10 } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "e2e", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});
afterAll(async () => {
  await client.close();
  await gw.close();
  await fake.stop();
  cleanup(root);
});

const tool = async (name: string, args: Record<string, unknown>) =>
  JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text);
const api = async (path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${gw.port}/companion/v1${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${companionToken()}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await res.json()) as any;
};

it("workspace -> send -> record -> notification -> claim -> ack -> task result", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  expect(await runCli(["node", "c2c", "workspace", "add", "-w", root])).toBe(0);
  const { workspaces } = await tool("gateway_list_workspaces", {});
  const workspaceId = workspaces[0].workspaceId as string;
  updateDesktop(workspaceId, (s) => { s.binding = { threadId: randomUUID(), boundAt: new Date().toISOString() }; });

  expect((await tool("codex_desktop_send", { workspaceId, commandId: "e2e-1", message: "do it" })).status).toBe("accepted");
  expect(fake.startTurnCount).toBe(1);

  expect(await runCli(["node", "c2c", "record", "-w", root, "--command-id", "e2e-1", "--status", "ok", "--summary", "all done"])).toBe(0);

  const pending = (await api("/state")).workspaces.find((w: any) => w.workspaceId === workspaceId).notifications;
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ commandId: "e2e-1", state: "pending" });
  expect(pending[0].text).toContain(`ATTEMPT_ID: ${pending[0].id}`);

  const { notification } = await api("/claim", { workspaceId, id: pending[0].id });
  expect(notification.state).toBe("claimed");
  expect((await api("/ack", { workspaceId, id: pending[0].id })).notification.state).toBe("delivered");
  expect((await api("/state")).workspaces.find((w: any) => w.workspaceId === workspaceId).notifications).toHaveLength(0);

  const { result } = await tool("codex_task_result", { workspaceId, commandId: "e2e-1" });
  expect(result).toMatchObject({ commandId: "e2e-1", status: "ok", summary: "all done" });
});
