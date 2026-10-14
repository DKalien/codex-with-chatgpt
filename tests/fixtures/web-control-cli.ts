// Test-only entry: real CLI processes, with the same production registrations
// and Commander setup but without unrelated command registration graphs.
import { Command } from "commander";
import { PRODUCT_NAME, VERSION } from "../../src/version.js";
import { cross } from "../../src/cli/shared.js";

const program = new Command();
program
  .name("c2c")
  .description(`${PRODUCT_NAME} — ChatGPT thinks. Codex works.`)
  .version(VERSION, "-v, --version")
  .configureHelp({ sortSubcommands: true });
switch (process.argv[2]) {
  case "web-control": {
    const { registerWebControlCommands } = await import("../../src/cli/web-control.js");
    registerWebControlCommands(program);
    break;
  }
  case "session": {
    const { registerSessionCommands } = await import("../../src/cli/session.js");
    registerSessionCommands(program);
    break;
  }
  case "record": {
    const { registerRecordCommand } = await import("../../src/cli/record.js");
    registerRecordCommand(program);
    break;
  }
}
program.parseAsync(process.argv).catch((error: Error) => {
  cross(error.message);
  process.exit(1);
});
