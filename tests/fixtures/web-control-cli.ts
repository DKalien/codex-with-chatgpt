// Test-only entry: real CLI processes, with the same production registrations
// and Commander setup but without unrelated command registration graphs.
import { Command } from "commander";
import { PRODUCT_NAME, VERSION } from "../../src/version.js";
import { cross } from "../../src/cli/shared.js";
import { registerWebControlCommands } from "../../src/cli/web-control.js";
import { registerSessionCommands } from "../../src/cli/session.js";
import { registerRecordCommand } from "../../src/cli/record.js";

const program = new Command();
registerWebControlCommands(program);
program
  .name("c2c")
  .description(`${PRODUCT_NAME} — ChatGPT thinks. Codex works.`)
  .version(VERSION, "-v, --version")
  .configureHelp({ sortSubcommands: true });
registerSessionCommands(program);
registerRecordCommand(program);
program.parseAsync(process.argv).catch((error: Error) => {
  cross(error.message);
  process.exit(1);
});
