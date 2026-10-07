import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewayRegistry } from "../src/gateway/registry.js";
import { registerGatewayTools } from "../src/mcp/gateway.js";
import { exchangePairingIntent } from "../src/feedback/companion.js";
import { readFeedbackState } from "../src/feedback/state-store.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const { bridge } = vi.hoisted(() => ({ bridge: vi.fn() }));
vi.mock("../src/bridge/runtime.js", () => ({ findLiveBridge: bridge }));
let oldState: string | undefined, stateDir: string, roots: string[], projects: Workspace[], registry: GatewayRegistry;
const handlers = new Map<string, (args: any, extra: any) => Promise<any>>();
beforeEach(() => {
  oldState = process.env.C2C_STATE_DIR; stateDir = isolateStateDir();
  roots = [makeTmpDir("gateway-feedback-a"), makeTmpDir("gateway-feedback-b")];
  projects = roots.map(root => new Workspace(root)); registry = new GatewayRegistry();
  projects.forEach(project => registry.register(project.root, "client"));
  handlers.clear();
  registerGatewayTools({ registerTool(name: string, _config: unknown, callback: any) { handlers.set(name, callback); } } as never, registry);
  bridge.mockReset().mockImplementation(async (id: string) => ({ workspaceId: id,
    publicUrl: `https://bridge-${id}.example.test`, port: 48765 }));
});
afterEach(() => {
  roots.forEach(cleanup); cleanup(stateDir);
  if (oldState === undefined) delete process.env.C2C_STATE_DIR; else process.env.C2C_STATE_DIR = oldState;
});
async function call(name: string, project: Workspace, args = {}, clientId = "client", session = project.id) {
  const result = await handlers.get(name)!({ workspaceId: project.id, ...args }, {
    authInfo: { clientId, scopes: ["codex.feedback", "workspace.read"] }, _meta: { "openai/session": session },
  });
  return { error: result.isError, data: JSON.parse(result.content[0].text) };
}

it("pairs and verifies each project with its own exact challenge and preserves the other project's proof", async () => {
  const paired = [];
  for (const [index, project] of projects.entries()) {
    await call("feedback_enable", project, { widgetId: `widget-${index}` });
    const pair = await call("feedback_companion_pair", project);
    expect(pair.error).not.toBe(true);
    expect(pair.data.workspaceId).toBe(project.id);
    expect(pair.data.bridgeOrigin).toBe(`https://bridge-${project.id}.example.test`);
    paired.push(exchangePairingIntent({ workspaceId: project.id, intentId: pair.data.intentId, secret: pair.data.secret,
      routeCanonical: `https://chatgpt.com/c/${index === 0 ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222"}` }));
    expect(paired[index]!.routeAttestation.message).toContain(`workspaceId=${project.id}`);
  }
  const bBefore = JSON.stringify(readFeedbackState(projects[1]!.id));
  const wrong = await call("feedback_companion_route_confirm", projects[1]!, {
    challengeId: paired[0]!.routeAttestation.challengeId, challengeDigest: paired[0]!.routeAttestation.challengeDigest,
  });
  expect(wrong.error).toBe(true);
  expect(JSON.stringify(readFeedbackState(projects[1]!.id))).toBe(bBefore);
  for (const [index, project] of projects.entries()) {
    const proof = paired[index]!.routeAttestation;
    expect((await call("feedback_companion_route_confirm", project, {
      challengeId: proof.challengeId, challengeDigest: proof.challengeDigest,
    })).data.verified).toBe(true);
  }
  const bVerified = JSON.stringify(readFeedbackState(projects[1]!.id));
  await call("feedback_companion_revoke", projects[0]!);
  expect(JSON.stringify(readFeedbackState(projects[1]!.id))).toBe(bVerified);
});

it("rechecks a grant after Bridge lookup and rejects a revoked pairing without state changes", async () => {
  const project = projects[0]!;
  await call("feedback_enable", project, { widgetId: "widget" });
  let finish!: (value: unknown) => void;
  bridge.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const before = JSON.stringify(readFeedbackState(project.id));
  const pending = call("feedback_companion_pair", project);
  registry.revoke(project.id);
  finish({ publicUrl: "https://bridge.example.test", port: 48765 });
  expect((await pending).error).toBe(true);
  expect(JSON.stringify(readFeedbackState(project.id))).toBe(before);
});

it("a new Gateway client must explicitly take over only the selected project's binding", async () => {
  for (const project of projects) await call("feedback_enable", project, { widgetId: "old-widget" });
  const a = projects[0]!, b = projects[1]!;
  registry.register(a.root, "new-client");
  const before = JSON.stringify(readFeedbackState(a.id));
  const bBefore = JSON.stringify(readFeedbackState(b.id));
  expect((await call("feedback_enable", a, { widgetId: "new-widget" }, "new-client")).data.error).toBe("FEEDBACK_TAKEOVER_REQUIRED");
  expect(JSON.stringify(readFeedbackState(a.id))).toBe(before);
  const epoch = readFeedbackState(a.id).binding!.epoch;
  expect((await call("feedback_takeover", a, { widgetId: "new-widget", expectedEpoch: epoch - 1 }, "new-client")).error).toBe(true);
  expect(JSON.stringify(readFeedbackState(a.id))).toBe(before);
  expect((await call("feedback_takeover", a, { widgetId: "new-widget", expectedEpoch: epoch }, "new-client")).error).not.toBe(true);
  expect(JSON.stringify(readFeedbackState(b.id))).toBe(bBefore);
});
