import path from "node:path";
import { Command } from "commander";
import { Workspace } from "../workspace/manager.js";
import {
  emitProbeEventLocal,
  isFeedbackProbeEnabled,
  probeStatusSummary,
  readProbeState,
  ProbeError,
} from "../feedback/probe-store.js";

interface Options {
  workspace?: string;
  label?: string;
  json?: boolean;
}

/**
 * 本机 CLI；不注册到 Bridge/MCP。emit 只读 active binding 并创建固定模板事件，
 * 不经过 Chat principal——真实验收要求 Chat 完全不碰 emit。
 * C2C_ENABLE_FEEDBACK_PROBE 只门禁 MCP 工具注册；CLI status/emit 始终可读写本地状态。
 */
export function registerFeedbackProbeCommands(program: Command): void {
  const group = program
    .command("feedback-probe")
    .description("本机反馈探针维护（emit 不经 Chat principal）");

  group
    .command("status")
    .description("只读查看本 workspace 的探针绑定与事件（不依赖 MCP 开关）")
    .option("-w, --workspace <path>")
    .option("--json", "机器可读输出", false)
    .action((opts: Options) => {
      try {
        const workspace = new Workspace(path.resolve(opts.workspace ?? process.cwd()));
        const state = readProbeState(workspace.id);
        emitJson({
          mcpConfigured: isFeedbackProbeEnabled(),
          ...probeStatusSummary(state),
        });
      } catch (error) {
        failJson(error);
      }
    });

  group
    .command("emit")
    .description("本机向当前 active binding emit 固定模板探针事件；不接受自由正文，不经过 Chat principal")
    .option("-w, --workspace <path>")
    .option("--label <label>", "很窄的可选 label（A-Za-z0-9_-，最多 64）")
    .option("--json", "机器可读输出", false)
    .action((opts: Options) => {
      try {
        const workspace = new Workspace(path.resolve(opts.workspace ?? process.cwd()));
        const event = emitProbeEventLocal({
          workspaceId: workspace.id,
          ...(opts.label ? { label: opts.label } : {}),
        });
        emitJson({
          probeId: event.probeId,
          payloadDigest: event.payloadDigest,
          status: event.status,
          epoch: event.epoch,
          bindingId: event.bindingId,
          principalFingerprint: event.principalFingerprint,
          workspaceId: event.workspaceId,
        });
      } catch (error) {
        failJson(error);
      }
    });
}

function emitJson(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

function failJson(error: unknown): void {
  const code = error instanceof ProbeError ? error.code : "PROBE_CLI_ERROR";
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(JSON.stringify({ ok: false, error: code, message }) + "\n");
  process.exitCode = 1;
}
