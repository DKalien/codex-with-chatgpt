import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_FEEDBACK_SCOPE, enableReceiver, readFeedbackState } from "../src/feedback/store.js";
import { reconcileFeedbackOutbox } from "../src/feedback/projector.js";
import { Workspace } from "../src/workspace/manager.js";
import { createMcpServer } from "../src/mcp/server.js";
import { resolveConversationPrincipal } from "../src/mcp/conversation-principal.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const { findLiveBridgeMock } = vi.hoisted(() => ({ findLiveBridgeMock: vi.fn() }));
vi.mock("../src/bridge/runtime.js", () => ({ findLiveBridge: findLiveBridgeMock }));

let stateDir: string;
let workspaceRoot: string;
let workspace: Workspace;

function principalExtra() {
  return {
    authInfo: { token: "token", clientId: "client-A", scopes: [CODEX_FEEDBACK_SCOPE] },
    _meta: { "openai/session": "session-A" },
  };
}

function runtime(publicUrl: string | null, port = 48765) {
  return {
    service: "c2c-bridge",
    version: "test",
    workspaceId: workspace.id,
    workspaceRoot,
    pid: 123,
    port,
    adminToken: "admin-token-must-not-leak",
    publicUrl,
    startedAt: new Date(0).toISOString(),
    runtimeBuildId: "build-test",
  };
}

function pairHandler() {
  const server = createMcpServer({
    workspace,
    logger: { info() {}, error() {}, warn() {}, debug() {} } as never,
  });
  return (server as unknown as {
    _registeredTools: Record<string, {
      handler: (args: unknown, extra: unknown) => Promise<{
        isError?: boolean;
        content: Array<{ text: string }>;
        structuredContent?: Record<string, unknown>;
      }>;
    }>;
  })._registeredTools.feedback_companion_pair.handler;
}

beforeEach(() => {
  stateDir = isolateStateDir();
  workspaceRoot = makeTmpDir("feedback-pair-ws");
  workspace = new Workspace(workspaceRoot);
  reconcileFeedbackOutbox(workspace.id, stateDir);
  const principal = resolveConversationPrincipal(principalExtra());
  enableReceiver({
    workspaceId: workspace.id,
    principal,
    widgetId: "widget-A",
    stateDir,
  });
  findLiveBridgeMock.mockReset();
});

afterEach(() => {
  cleanup(stateDir);
  cleanup(workspaceRoot);
});

describe("feedback_companion_pair bridge origin bootstrap", () => {
  it("returns canonical HTTPS origin without exposing runtime secrets", async () => {
    findLiveBridgeMock.mockResolvedValue(runtime("https://bridge.example.test/"));
    const result = await pairHandler()({}, principalExtra());
    expect(result.isError, result.content[0]?.text).not.toBe(true);
    expect(result.structuredContent?.bridgeOrigin).toBe("https://bridge.example.test");
    expect(JSON.stringify(result.structuredContent)).not.toContain("admin-token-must-not-leak");
    expect(readFeedbackState(workspace.id, stateDir).pairingIntent).not.toBeNull();
  });

  it("falls back to the authenticated loopback runtime origin", async () => {
    findLiveBridgeMock.mockResolvedValue(runtime(null, 48766));
    const result = await pairHandler()({}, principalExtra());
    expect(result.isError, result.content[0]?.text).not.toBe(true);
    expect(result.structuredContent?.bridgeOrigin).toBe("http://127.0.0.1:48766");
  });

  it.each([
    "https://bridge.example.test/path",
    "https://user:password@bridge.example.test/",
    "http://public.example.test/",
  ])("rejects unsafe runtime origin before minting an intent: %s", async (publicUrl) => {
    findLiveBridgeMock.mockResolvedValue(runtime(publicUrl));
    const result = await pairHandler()({}, principalExtra());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("FEEDBACK_BRIDGE_ORIGIN_UNAVAILABLE");
    expect(readFeedbackState(workspace.id, stateDir).pairingIntent).toBeNull();
  });

  it("fails closed when no healthy runtime can be authenticated", async () => {
    findLiveBridgeMock.mockResolvedValue(null);
    const result = await pairHandler()({}, principalExtra());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("FEEDBACK_BRIDGE_ORIGIN_UNAVAILABLE");
    expect(readFeedbackState(workspace.id, stateDir).pairingIntent).toBeNull();
  });
});
