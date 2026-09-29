import { Command } from "commander";
import { PRODUCT_NAME, VERSION } from "../version.js";
import { cross } from "./shared.js";
import { registerWebControlCommands } from "./web-control.js";
import { registerRemoteCommands } from "./remote.js";
import { registerDesktopCommands } from "./desktop.js";
import { registerWorkflowCommands } from "./workflow.js";
import { registerRuntimePruneCommands } from "./runtime-prune.js";
import { registerFeedbackProbeCommands } from "./feedback-probe.js";
import { registerPostTurnFinalizerCommands } from "./post-turn-finalizer.js";
import { registerDesktopReceiptFinalizerCommands } from "./desktop-receipt-finalizer.js";
import { registerFeedbackControlRepairCommand, registerGcCommand } from "./gc-maintenance.js";
import { registerServerCommand } from "./server.js";
import { registerStartCommands, registerRuntimeCommands } from "./runtime.js";
import { registerSetupCommands } from "./setup.js";
import { registerWorkspaceCommands } from "./workspace.js";
import { registerSandboxAllowCommand, registerUpdateCheckCommand } from "./machine.js";
import { registerSessionCommands, registerPreferencesCommands } from "./session.js";
import { registerRecordCommand } from "./record.js";
import { registerTunnelCommands } from "./tunnel.js";
import { registerExecutorCommands } from "./executor.js";

const program = new Command();
registerWebControlCommands(program);
registerPostTurnFinalizerCommands(program);
registerDesktopReceiptFinalizerCommands(program);
registerFeedbackControlRepairCommand(program);
registerRemoteCommands(program);
registerDesktopCommands(program);
registerExecutorCommands(program);
registerWorkflowCommands(program);
registerRuntimePruneCommands(program);
registerFeedbackProbeCommands(program);
registerGcCommand(program);

program
  .name("c2c")
  .description(`${PRODUCT_NAME} — ChatGPT thinks. Codex works.`)
  .version(VERSION, "-v, --version")
  .configureHelp({ sortSubcommands: true });

registerServerCommand(program);
registerStartCommands(program);
registerSetupCommands(program);
registerRuntimeCommands(program);
registerWorkspaceCommands(program);
registerSandboxAllowCommand(program);
registerUpdateCheckCommand(program);
registerSessionCommands(program);
registerPreferencesCommands(program);
registerRecordCommand(program);
registerTunnelCommands(program);

program.parseAsync(process.argv).catch((error: Error) => {
  cross(error.message);
  process.exit(1);
});
