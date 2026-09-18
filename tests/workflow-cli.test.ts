import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerWorkflowCommands, workflowFailurePayload } from "../src/cli/workflow.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readSource(rel: string): string {
  return fs.readFileSync(path.join(projectRoot, rel), "utf8");
}

describe("G1a/G2 workflow CLI source contracts", () => {
  it("registers workflow status with -w and --json only (read path)", () => {
    const program = new Command("c2c");
    registerWorkflowCommands(program);
    const workflow = program.commands.find((cmd) => cmd.name() === "workflow");
    expect(workflow).toBeTruthy();
    const status = workflow!.commands.find((cmd) => cmd.name() === "status");
    expect(status).toBeTruthy();
    const optionNames = status!.options.map((opt) => opt.long);
    expect(optionNames).toContain("--workspace");
    expect(optionNames).toContain("--json");
  });

  it("workflow module does not call mutating Desktop/Remote/pair/session paths", () => {
    const source = readSource("src/cli/workflow.ts");
    const facts = readSource("src/workflow/facts.ts");
    const request = readSource("src/workflow/request.ts");
    for (const s of [source, facts, request]) {
      expect(s).not.toMatch(/bindCurrentDesktop\s*\(/);
      expect(s).not.toMatch(/enableDesktop\s*\(/);
      expect(s).not.toMatch(/setRemoteEnabled\s*\(/);
      expect(s).not.toMatch(/enqueueTask\s*\(/);
      expect(s).not.toMatch(/updateSession\s*\(/);
      expect(s).not.toMatch(/writeSession\s*\(/);
      expect(s).not.toMatch(/rollout\s*\(/);
    }
  });

  it("CLI uses shared capability facts + request helpers", () => {
    const source = readSource("src/cli/workflow.ts");
    const facts = readSource("src/workflow/facts.ts");
    const request = readSource("src/workflow/request.ts");
    expect(source).toMatch(/collectWorkflowCapabilityFacts\(/);
    expect(source).toMatch(/projectRuntimeUpgrade\(/);
    expect(source).toMatch(/findBridgeObservation\(/);
    expect(source).toMatch(/codex_thread/);
    expect(facts).toMatch(/readSession\(/);
    expect(facts).toMatch(/resolveThreadConversation\(/);
    expect(facts).toMatch(/readRemote\(/);
    expect(facts).toMatch(/readDesktop\(/);
    expect(facts).toMatch(/mcp_request/);
    expect(request).toMatch(/resolveConversationPrincipal/);
    expect(request).toMatch(/projectRuntimeUpgrade/);
  });

  it("pure readiness module has no fs/network/IPC write surface", () => {
    const source = readSource("src/workflow/readiness.ts");
    expect(source).not.toMatch(/from "node:fs"/);
    expect(source).not.toMatch(/fetch\(/);
    expect(source).not.toMatch(/Date\.now\s*\(/);
  });

  it("index registers workflow commands", () => {
    const source = readSource("src/cli/index.ts");
    expect(source).toMatch(/registerWorkflowCommands/);
  });

  it("CLI unexpected exception → bounded JSON without raw error.message", () => {
    const payload = workflowFailurePayload();
    const dump = JSON.stringify(payload);
    expect(payload.ok).toBe(false);
    expect(payload.nextAction).toBe("stop_unknown");
    expect(dump).not.toContain("secret");
    expect(dump).not.toMatch(/"message"/);
  });

  it("desktop error classification structured only; no message text", () => {
    const request = readSource("src/workflow/request.ts");
    const facts = readSource("src/workflow/facts.ts");
    expect(request).toMatch(/function desktopErrorCode/);
    expect(request).toMatch(/error instanceof DesktopError\) return error\.code/);
    expect(request).not.toMatch(/message\.includes\(/);
    expect(facts).not.toMatch(/message\.includes\(/);
  });

  it("MCP workspace_info includes workflow projection schema", () => {
    const mcp = readSource("src/mcp/server.ts");
    const request = readSource("src/workflow/request.ts");
    expect(mcp).toMatch(/workflowOutputSchema/);
    expect(mcp).toMatch(/conversationIdentity/);
    expect(mcp).toMatch(/remoteRequestCapability/);
    expect(mcp).toMatch(/workflowProjectionFailure/);
    expect(mcp).toMatch(/WORKFLOW_BLOCKER_CODES/);
    expect(mcp).toMatch(/WORKFLOW_OVERALL_STATES/);
    expect(mcp).toMatch(/currentConversation/);
    expect(mcp).not.toMatch(/collectWorkflowReadinessInput\(/);
    expect(request).toMatch(/workflow_projection_failed/);
  });

  it("MCP projection keeps chatKnown durable-only; request identity separate", () => {
    const facts = readSource("src/workflow/facts.ts");
    const request = readSource("src/workflow/request.ts");
    const readiness = readSource("src/workflow/readiness.ts");
    expect(facts).toMatch(/chatKnown: false/);
    expect(facts).not.toMatch(/chatKnown: conversationSource/);
    expect(request).toMatch(/workflowProjectionFailure/);
    expect(request).toMatch(/requestContext/);
    expect(readiness).toMatch(/currentConversation/);
    expect(readiness).toMatch(/WORKFLOW_BLOCKER_CODES/);
  });

  it("runtime mapper classifies state before pending marker", () => {
    const request = readSource("src/workflow/request.ts");
    expect(request).toMatch(/upgrade\.state === "unknown" \|\| upgrade\.state === "stopped"/);
  });
});
