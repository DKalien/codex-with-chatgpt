import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerCleanupCommands } from "../src/cli/cleanup.js";
import { Workspace } from "../src/workspace/manager.js";
import { readDesktop, updateDesktop, desktopFile } from "../src/desktop/store.js";
import { cleanup, makeTmpDir } from "./helpers.js";

let root: string, stateDir: string, workspace: Workspace;
beforeEach(() => {
  root = makeTmpDir("cleanup-cli-workspace"); stateDir = makeTmpDir("cleanup-cli-state");
  workspace = new Workspace(root); vi.stubEnv("C2C_STATE_DIR", stateDir);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); cleanup(root); cleanup(stateDir); });
async function run(...extra: string[]) {
  const program = new Command().exitOverride(); registerCleanupCommands(program);
  let stdout = "";
  const write = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { stdout += String(chunk); return true; });
  const prior = process.exitCode; process.exitCode = 0;
  try {
    await program.parseAsync(["node", "c2c", "cleanup", "command", "-w", root, "--command-id", "cli_flow", "--json", ...extra]);
    return { exitCode: process.exitCode, value: JSON.parse(stdout) };
  } finally { write.mockRestore(); process.exitCode = prior; }
}

it("CLI nonexistent preview is no-op; exact preview/confirm physically deletes unknown, mismatch writes nothing", async () => {
  expect((await run()).value).toMatchObject({ status: "not_found", confirmationSha256: null });
  expect(fs.readdirSync(stateDir)).toEqual([]);
  const now = new Date().toISOString();
  const binding = { bindingId: randomUUID(), threadId: randomUUID(), hostId: "local" as const, projectId: "cli", title: "fixture", boundAt: now };
  updateDesktop(workspace.id, () => ({ state: {
    version: 1, workspaceId: workspace.id, workspaceRoot: workspace.root, enabled: true, binding, deliveries: [{
      commandId: "cli_flow", deliveryId: randomUUID(), clientId: "cli", bindingId: binding.bindingId,
      threadId: binding.threadId, messageBytes: 1, messageSha256: "a".repeat(64), deliveryStatus: "outcome_unknown",
      lifecycle: "ephemeral", createdAt: now, updatedAt: now,
    }],
  }, result: null }));
  const before = fs.readFileSync(desktopFile(workspace.id), "utf8");
  const preview = (await run()).value;
  expect(preview.notice).toContain("绝不自动重发"); expect(preview.artifacts).toHaveLength(1);
  expect(fs.readFileSync(desktopFile(workspace.id), "utf8")).toBe(before);
  expect(await run("--confirm", "b".repeat(64))).toMatchObject({ exitCode: 1, value: { code: "COMMAND_CLEANUP_CONFIRMATION_MISMATCH" } });
  expect(fs.readFileSync(desktopFile(workspace.id), "utf8")).toBe(before);
  expect(await run("--confirm", preview.confirmationSha256)).toMatchObject({ exitCode: 0, value: { status: "cleaned" } });
  expect(readDesktop(workspace.id)?.deliveries).toEqual([]);
  expect(readDesktop(workspace.id)?.binding).toEqual(binding);
  const program = new Command(); registerCleanupCommands(program);
  expect(program.commands[0]!.commands[0]!.helpInformation()).not.toContain("--all");
});
