// 仅供测试：每次启动真实 CLI 进程，只加载当前探针命令的生产注册。
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
  case "feedback-probe": {
    const { registerFeedbackProbeCommands } = await import("../../src/cli/feedback-probe.js");
    registerFeedbackProbeCommands(program);
    break;
  }
  case "write-probe-status": {
    const { registerSetupCommands } = await import("../../src/cli/setup.js");
    registerSetupCommands(program);
    break;
  }
}
program.parseAsync(process.argv).catch((error: Error) => {
  cross(error.message);
  process.exit(1);
});
