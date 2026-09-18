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

describe("G1a workflow CLI source contracts", () => {
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
    expect(source).not.toMatch(/bindCurrentDesktop\s*\(/);
    expect(source).not.toMatch(/bindDesktop\s*\(/);
    expect(source).not.toMatch(/enableDesktop\s*\(/);
    expect(source).not.toMatch(/disableDesktop\s*\(/);
    expect(source).not.toMatch(/confirmCurrent\s*\(/);
    expect(source).not.toMatch(/setRemoteEnabled\s*\(/);
    expect(source).not.toMatch(/enqueueTask\s*\(/);
    expect(source).not.toMatch(/enqueueThread\s*\(/);
    expect(source).not.toMatch(/updateSession\s*\(/);
    expect(source).not.toMatch(/writeSession\s*\(/);
    expect(source).not.toMatch(/updateDesktop\s*\(/);
    expect(source).not.toMatch(/updateRemote\s*\(/);
    expect(source).not.toMatch(/rollout\s*\(/);
    expect(source).not.toMatch(/ensureBridgeAndTunnel\s*\(/);
    expect(source).not.toMatch(/issueTokens\s*\(/);
  });

  it("workflow status uses readSession / readRemote / readDesktop / findBridgeObservation only as facts", () => {
    const source = readSource("src/cli/workflow.ts");
    expect(source).toMatch(/readSession\(/);
    expect(source).toMatch(/resolveThreadConversation\(/);
    expect(source).toMatch(/readRemote\(/);
    expect(source).toMatch(/readDesktop\(/);
    expect(source).toMatch(/findBridgeObservation\(/);
    expect(source).toMatch(/resolveWorkflowReadiness\(/);
    expect(source).toMatch(/formatWorkflowReadinessHuman\(/);
  });

  it("pure readiness module has no fs/network/IPC write surface", () => {
    const source = readSource("src/workflow/readiness.ts");
    expect(source).not.toMatch(/from "node:fs"/);
    expect(source).not.toMatch(/from "node:child_process"/);
    expect(source).not.toMatch(/fetch\(/);
    expect(source).not.toMatch(/Date\.now\s*\(/);
    expect(source).not.toMatch(/writeFile/);
    expect(source).not.toMatch(/Math\.random/);
  });

  it("index registers workflow commands", () => {
    const source = readSource("src/cli/index.ts");
    expect(source).toMatch(/registerWorkflowCommands/);
    expect(source).toMatch(/from "\.\/workflow\.js"/);
  });

  it("CLI unexpected exception → bounded JSON without raw error.message", () => {
    const payload = workflowFailurePayload();
    const dump = JSON.stringify(payload);
    expect(payload.ok).toBe(false);
    expect(payload.overall).toBe("blocked");
    expect(payload.nextAction).toBe("stop_unknown");
    expect(payload.blockers[0].code).toBe("workflow_status_failed");
    expect(dump).not.toContain("secret token");
    expect(dump).not.toContain("C:\\private\\pipe");
    expect(dump).not.toContain("error");
    expect(dump).not.toMatch(/"message"/);
    const source = readSource("src/cli/workflow.ts");
    expect(source).not.toMatch(/error:\s*message/);
    expect(source).toMatch(/workflowFailurePayload/);
  });

  it("desktop error classification uses structured codes only, not message text", () => {
    const source = readSource("src/cli/workflow.ts");
    expect(source).toMatch(/function desktopErrorCode/);
    expect(source).toMatch(/error instanceof DesktopError\) return error\.code/);
    expect(source).not.toMatch(/message\.includes\(/);
    expect(source).not.toMatch(/error instanceof DesktopError \|\|/);
  });
});
