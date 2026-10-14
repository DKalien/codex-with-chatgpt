// 测试专用入口：独立 CLI 进程只加载真实 GC 注册，保留生产 Commander 设置和错误边界。
import { Command } from "commander";
import { PRODUCT_NAME, VERSION } from "../../src/version.js";
import { cross } from "../../src/cli/shared.js";
import { registerGcCommand } from "../../src/cli/gc-maintenance.js";

const program = new Command();
registerGcCommand(program);
program
  .name("c2c")
  .description(`${PRODUCT_NAME} — ChatGPT thinks. Codex works.`)
  .version(VERSION, "-v, --version")
  .configureHelp({ sortSubcommands: true });
program.parseAsync(process.argv).catch((error: Error) => {
  cross(error.message);
  process.exit(1);
});
