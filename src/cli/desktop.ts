import type { Command } from "commander";
import fs from "node:fs";
import { Workspace } from "../workspace/manager.js";
import { bindCurrentDesktop, bindDesktop, desktopStatus, disableDesktop, enableDesktop } from "../desktop/service.js";
import { desktopIpc, DESKTOP_IPC_ERROR_MESSAGES } from "../desktop/ipc.js";
import { DesktopError, targetInput } from "../desktop/store.js";
import { recordDesktopResult } from "../desktop/result.js";
import { reconcileUnknownDesktopDelivery } from "../desktop/unknown-reconciliation.js";
import { LegacyReconciliationError, listLegacyReconciliations, reconcileLegacyAccepted } from "../desktop/legacy-reconciliation.js";
import { retireLegacyAccepted } from "../desktop/legacy-retirement.js";
import { abandonHistoricalAccepted, previewAbandonment } from "../desktop/abandonment.js";
import { listDesktopHistory } from "../desktop/history.js";
import { previewOutcomeResolution, resolveOutcomeUnknown } from "../desktop/outcome-resolution.js";

const say = (message: string): void => { process.stdout.write(`${message}\n`); };

function workspaceRoot(option?: string): string {
  return option ? option : process.cwd();
}

function print(payload: unknown, json: boolean, message: string): void {
  if (json) say(JSON.stringify(payload));
  else say(message);
}

const SAFE_CLI_ERROR_MESSAGES: Record<string, string> = {
  ...DESKTOP_IPC_ERROR_MESSAGES,
  DESKTOP_BINDING_CHANGED: "确认期间本机状态发生变化；未覆盖撤权或重新绑定，请重新操作。",
  DESKTOP_OUTCOME_UNRESOLVED: "已有结果不明的投递；不要更换 commandId 或重新绑定绕过，须在 Desktop 人工核对。",
  DESKTOP_HISTORY_FULL: "投递历史容量已满；保留 ID，须人工迁移后继续。",
  DESKTOP_STATE_CORRUPT: "Desktop 状态损坏或已初始化的历史缺失；保留文件并人工核对，不能重置投递 ID。",
  DESKTOP_STORE_BUSY: "Desktop 状态写锁繁忙；遗留锁须人工核对进程和历史后恢复，不要删除投递记录。",
  DESKTOP_DISABLED: "本机 Desktop Control 未启用或已撤权。",
  DESKTOP_BINDING_MISMATCH: "bindingId 已失效；不能自动切换到新的投递目标。",
  DESKTOP_WRONG_WORKSPACE: "当前工作区与保存的绑定根目录不一致。",
  DESKTOP_RECONCILIATION_NOT_ELIGIBLE: "该 Desktop outcome_unknown delivery 不满足严格对账条件。",
  DESKTOP_RECONCILIATION_CONFLICT: "Desktop 历史无法唯一核对；未恢复结果或修改投递状态。",
  LEGACY_RECONCILIATION_INVALID: "legacy accepted reconciliation 的 commandId 无效。",
  LEGACY_RECONCILIATION_NOT_ELIGIBLE: "该历史 Desktop delivery 不满足严格 legacy reconciliation 条件。",
  LEGACY_RECONCILIATION_CONFLICT: "legacy reconciliation 事实存在冲突；未覆盖原证据。",
  LEGACY_RECONCILIATION_RECORDS_CORRUPT: "execution JSONL 损坏或不完整；未写入 legacy reconciliation 证据。",
  LEGACY_RECONCILIATION_OUTPUT_CORRUPT: "execution output index 损坏；未写入 legacy reconciliation 证据。",
  LEGACY_RECONCILIATION_STORE_CORRUPT: "legacy reconciliation 证据存储损坏或未完成；未覆盖原证据。",
  LEGACY_RECONCILIATION_BUSY: "legacy reconciliation 写锁繁忙；请稍后重试。",
  LEGACY_RETIREMENT_INVALID: "legacy retirement 参数无效；未修改状态。",
  LEGACY_RETIREMENT_NOT_ELIGIBLE: "该历史 Desktop delivery 不满足严格 legacy retirement 条件。",
  LEGACY_RETIREMENT_CONFLICT: "legacy retirement 事实存在冲突；未覆盖原证据。",
  LEGACY_RETIREMENT_DESKTOP_CORRUPT: "Desktop 状态损坏；未写入 legacy retirement 证据。",
  LEGACY_RETIREMENT_RECORDS_CORRUPT: "execution JSONL 损坏或不完整；未写入 legacy retirement 证据。",
  LEGACY_RETIREMENT_OUTPUT_CORRUPT: "execution output index 损坏；未写入 legacy retirement 证据。",
  LEGACY_RETIREMENT_STORE_CORRUPT: "legacy retirement 证据存储损坏或未完成；未覆盖原证据。",
  LEGACY_RETIREMENT_STORE_WRITE: "legacy retirement 证据提交失败；保留原文件并人工核对。",
  LEGACY_RETIREMENT_IPC: "无法安全确认当前 Desktop maintenance context；未写入 legacy retirement 证据。",
  LEGACY_RETIREMENT_BUSY: "legacy retirement 写锁繁忙；请稍后重试。",
  DESKTOP_ABANDONMENT_INVALID: "abandonment 参数无效；未修改状态。",
  DESKTOP_ABANDONMENT_NOT_ELIGIBLE: "指定 Desktop 投递不满足 abandonment 条件；未修改状态。",
  DESKTOP_ABANDONMENT_CONFLICT: "abandonment 事实存在冲突；未覆盖原证据。",
  DESKTOP_ABANDONMENT_CONFIRMATION_INVALID: "confirmation 摘要必须是 64 位十六进制值；未修改状态。",
  DESKTOP_ABANDONMENT_CONFIRMATION_MISMATCH: "confirmation 摘要不匹配；未修改状态。",
  DESKTOP_ABANDONMENT_STORE_CORRUPT: "abandonment 证据存储损坏；未覆盖原证据。",
  DESKTOP_ABANDONMENT_STORE_WRITE: "abandonment 证据提交失败；保留原文件并人工核对。",
  DESKTOP_ABANDONMENT_DESKTOP_CORRUPT: "Desktop 状态损坏；保留文件并人工核对。",
  DESKTOP_ABANDONMENT_RECORDS_CORRUPT: "execution JSONL 损坏或不完整；未写入 abandonment 证据。",
  DESKTOP_ABANDONMENT_OUTPUT_CORRUPT: "execution output index 损坏或不完整；未写入 abandonment 证据。",
  DESKTOP_ABANDONMENT_RECONCILIATION_CORRUPT: "reconciliation 证据无法安全读取；未写入 abandonment 证据。",
  DESKTOP_ABANDONMENT_RETIREMENT_CORRUPT: "retirement 证据无法安全读取；未写入 abandonment 证据。",
  DESKTOP_ABANDONMENT_IPC: "无法安全确认当前 Desktop maintenance context；未写入 abandonment 证据。",
  DESKTOP_ABANDONMENT_BUSY: "abandonment 写锁繁忙；请稍后重试。",
  DESKTOP_HISTORY_CONFLICT: "Desktop 历史存在冲突；未修改状态。",
  DESKTOP_HISTORY_CORRUPT: "Desktop 历史损坏或不完整；未修改状态。",
  DESKTOP_OUTCOME_RESOLUTION_INVALID: "行政 resolution 参数无效；未修改状态。",
  DESKTOP_OUTCOME_RESOLUTION_NOT_ELIGIBLE: "指定 Desktop 投递不满足行政 resolution 条件；未修改原 delivery。",
  DESKTOP_OUTCOME_RESOLUTION_CONFLICT: "行政 resolution 事实存在冲突；未覆盖原证据或 delivery。",
  DESKTOP_OUTCOME_RESOLUTION_CONFIRMATION_INVALID: "confirmation 摘要必须是 64 位小写十六进制值；未修改状态。",
  DESKTOP_OUTCOME_RESOLUTION_CONFIRMATION_MISMATCH: "confirmation 摘要不匹配；未修改状态。",
  DESKTOP_OUTCOME_RESOLUTION_STORE_CORRUPT: "行政 resolution 证据存储损坏；保留原文件并人工核对。",
  DESKTOP_OUTCOME_RESOLUTION_STORE_WRITE: "行政 resolution 证据提交失败；保留原文件并人工核对。",
  DESKTOP_OUTCOME_RESOLUTION_BUSY: "行政 resolution/reconciliation 写锁繁忙；请稍后重试。",
};

const ABANDONMENT_NOTICE = "仅停止等待，不代表完成/成功";

function parseAbandonmentCommandIds(value: string): string[] {
  const commandIds = value.split(",");
  if (commandIds.some(commandId => commandId.length === 0 || commandId.trim() !== commandId ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(commandId))) {
    throw new DesktopError("DESKTOP_ABANDONMENT_INVALID", "commandIds 必须是逗号分隔的非空 commandId，不能含空白。" );
  }
  if (new Set(commandIds).size !== commandIds.length) {
    throw new DesktopError("DESKTOP_ABANDONMENT_INVALID", "commandIds 不能重复；未自动去重。" );
  }
  return commandIds;
}

function parseAbandonmentConfirmation(value?: string): string | undefined {
  if (value !== undefined && !/^[a-f0-9]{64}$/u.test(value)) {
    throw new DesktopError("DESKTOP_ABANDONMENT_CONFIRMATION_INVALID", "confirmation 摘要必须是 64 位十六进制值。" );
  }
  return value;
}

function safeCliError(error: unknown, fallbackCode: string, fallbackMessage: string): {
  code: string;
  message: string;
} {
  const candidate = error instanceof DesktopError ? error.code : undefined;
  const known = candidate !== undefined && Object.prototype.hasOwnProperty.call(SAFE_CLI_ERROR_MESSAGES, candidate);
  const message = known ? SAFE_CLI_ERROR_MESSAGES[candidate!] : fallbackMessage;
  const code = known ? candidate! : fallbackCode;
  return { code, message };
}

function parseOutcomeResolutionConfirmation(value?: string): string | undefined {
  if (value !== undefined && !/^[a-f0-9]{64}$/u.test(value)) {
    throw new DesktopError("DESKTOP_OUTCOME_RESOLUTION_CONFIRMATION_INVALID", "confirmation 摘要必须是 64 位小写十六进制值。" );
  }
  return value;
}

export function registerDesktopCommands(program: Command): void {
  const desktop = program.command("desktop").description("管理本机已绑定的 Desktop Control 会话");

  desktop.command("record-result", { hidden: true })
    .description("记录当前 Desktop turn 的执行结果（仅本机）")
    .option("-w, --workspace <path>", "workspace 根目录")
    .requiredOption("--command-id <id>", "原 accepted commandId")
    .requiredOption("--changed-files <files>", "本轮实际修改文件，逗号分隔；无修改传空字符串")
    .requiredOption("--tests <summary>", "本轮测试摘要；未运行填 not run")
    .requiredOption("--exit-status <status>", "ok / failed / blocked")
    .requiredOption("--raw-summary <text>", "Codex 本轮明确最终执行摘要，最多 8192 UTF-8 bytes；不得传 transcript")
    .option("--notes <text>", "本轮说明")
    .option("--command <text>", "已执行命令的描述，不执行此文本")
    .option("--output <text>", "已执行命令的输出")
    .option("--output-file <path>", "已执行命令的 UTF-8 汇总输出文件，最多 256 KiB")
    .option("--exit-code <code>", "已执行命令的退出码")
    .option("--json", "输出机器可读结果", false)
  .action(async (opts: { workspace?: string; commandId: string; changedFiles: string; tests: string;
      exitStatus: "ok" | "failed" | "blocked"; rawSummary: string; notes?: string; command?: string; output?: string;
      outputFile?: string; exitCode?: string; json: boolean }) => {
      try {
        if (opts.output !== undefined && opts.outputFile !== undefined) {
          throw new DesktopError("DESKTOP_RESULT_INVALID", "output 与 output-file 不能同时指定。");
        }
        let output = opts.output;
        if (opts.outputFile !== undefined) {
          const fd = fs.openSync(opts.outputFile, "r");
          try {
            const buffer = Buffer.alloc(256 * 1024 + 1);
            const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
            if (count === buffer.length) throw new DesktopError("DESKTOP_RESULT_INVALID", "输出文件超过 256 KiB；请先生成本轮汇总，不会截断证据。");
            output = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count));
          } finally { fs.closeSync(fd); }
        }
        if (opts.exitCode !== undefined && (!/^-?\d+$/.test(opts.exitCode) || !Number.isSafeInteger(Number(opts.exitCode)))) {
          throw new DesktopError("DESKTOP_RESULT_INVALID", "exit-code 必须为安全整数。");
        }
        const result = await recordDesktopResult(new Workspace(workspaceRoot(opts.workspace)), {
          commandId: opts.commandId, changedFiles: opts.changedFiles.split(",").map(file => file.trim()).filter(Boolean),
          tests: opts.tests, exitStatus: opts.exitStatus, rawSummary: opts.rawSummary, notes: opts.notes, command: opts.command,
          output, exitCode: opts.exitCode === undefined ? undefined : Number(opts.exitCode),
        }, { allowInProgress: true });
        print({ ok: true, ...result }, opts.json, "本轮 Desktop execution receipt 已记录。");
      } catch (error) {
        const code = error instanceof DesktopError ? error.code : "DESKTOP_RESULT_INVALID";
        const message = error instanceof DesktopError ? error.message : "执行结果记录失败；未确认验收闭环完成。";
        print({ ok: false, error: code, message }, opts.json, message);
        process.exitCode = 1;
      }
    });

  desktop.command("reconcile-unknown")
    .description("严格核对唯一真实 Desktop turn 并恢复 outcome_unknown 投递")
    .option("-w, --workspace <path>", "workspace 根目录")
    .requiredOption("--command-id <id>", "要核对的 outcome_unknown commandId")
    .option("--json", "输出机器可读结果", false)
    .action(async (opts: { workspace?: string; commandId: string; json: boolean }) => {
      try {
        const result = await reconcileUnknownDesktopDelivery(new Workspace(workspaceRoot(opts.workspace)), opts.commandId);
        print({ ok: true, ...result }, opts.json,
          result.status === "accepted" ? `已恢复唯一真实 Desktop turn（${result.turnId}）；未写入 execution receipt。` :
            "未找到唯一匹配的 Desktop turn；仍保持 outcome_unknown，未写入 execution receipt。");
      } catch (error) {
        const failure = safeCliError(error, "DESKTOP_RECONCILIATION_NOT_ELIGIBLE", "Desktop outcome_unknown 对账失败；未修改投递状态或 execution receipt。" );
        print({ ok: false, error: failure.code, message: failure.message }, opts.json, failure.message);
        process.exitCode = 1;
      }
    });

  desktop.command("legacy-reconcile")
    .description("一次性核对 receipt 上线前的历史 accepted Desktop delivery（不会触发 rollout）")
    .option("-w, --workspace <path>", "workspace 根目录")
    .option("--command-id <id>", "要核对的历史 accepted commandId；与 --list 互斥")
    .option("--list", "只读列出 legacy accepted 的核对状态", false)
    .option("--json", "输出机器可读结果", false)
    .action((opts: { workspace?: string; commandId?: string; list: boolean; json: boolean }) => {
      try {
        if (opts.list === (opts.commandId !== undefined)) {
          throw new LegacyReconciliationError("LEGACY_RECONCILIATION_INVALID", "必须且只能选择 --list 或 --command-id。");
        }
        const workspace = new Workspace(workspaceRoot(opts.workspace));
        if (opts.list) {
          const items = listLegacyReconciliations(workspace);
          print({ ok: true, items }, opts.json, items.map(item => `${item.commandId}: ${item.status}`).join("\n") || "没有 legacy accepted 候选。");
          return;
        }
        const result = reconcileLegacyAccepted(workspace, opts.commandId!);
        print({ ok: true, ...result }, opts.json,
          result.status === "already_reconciled" ? "legacy reconciliation 证据已存在且重新核对一致。" : "已写入 legacy reconciliation 证据；未修改 Desktop delivery。" );
      } catch (error) {
        const code = error instanceof DesktopError ? error.code : "LEGACY_RECONCILIATION_INVALID";
        const message = opts.list ? (SAFE_CLI_ERROR_MESSAGES[code] ?? "legacy 发现失败；未修改状态。") :
          error instanceof LegacyReconciliationError ? error.message : "legacy reconciliation 失败；未写入证据。";
        print({ ok: false, error: code, message }, opts.json, message);
        process.exitCode = 1;
      }
    });

  desktop.command("legacy-retire")
    .description("处置缺失执行证据的旧 accepted 等待项；不表示任务完成或成功")
    .option("-w, --workspace <path>", "workspace 根目录")
    .requiredOption("--command-id <id>", "明确要处置的历史 accepted commandId")
    .option("--ownerless", "明确处置没有可确认 owner 的历史 accepted 投递", false)
    .option("--json", "输出机器可读结果", false)
    .action(async (opts: { workspace?: string; commandId: string; ownerless: boolean; json: boolean }) => {
      try {
        const workspace = new Workspace(workspaceRoot(opts.workspace));
        const result = opts.ownerless
          ? await retireLegacyAccepted(workspace, opts.commandId, { ownerless: true })
          : await retireLegacyAccepted(workspace, opts.commandId);
        print({ ok: true, ...result }, opts.json, "已核对历史等待处置证据；不代表完成或成功，rollout 仍需实时检查。");
      } catch (error) {
        const code = error instanceof DesktopError ? error.code : "LEGACY_RETIREMENT_INVALID";
        print({ ok: false, error: code, message: "历史等待处置被拒绝；未覆盖证据，不表示完成或成功。" }, opts.json, "历史等待处置被拒绝；请保留证据并核对。");
        process.exitCode = 1;
      }
    });

  desktop.command("abandon")
    .description(`行政处置明确指定的历史 accepted Desktop delivery；${ABANDONMENT_NOTICE}`)
    .option("-w, --workspace <path>", "workspace 根目录")
    .requiredOption("--command-ids <ids>", "逗号分隔的精确 commandId 列表；禁止重复或空白项")
    .option("--confirm <sha256>", "preview 返回的 64 位 confirmationSha256；省略则只读预览")
    .option("--json", "输出机器可读结果", false)
    .action(async (opts: { workspace?: string; commandIds: string; confirm?: string; json: boolean }) => {
      try {
        const commandIds = parseAbandonmentCommandIds(opts.commandIds);
        const confirmationSha256 = parseAbandonmentConfirmation(opts.confirm);
        const workspace = new Workspace(workspaceRoot(opts.workspace));
        if (confirmationSha256 === undefined) {
          const preview = await previewAbandonment(workspace, commandIds);
          print({ ok: true, ...preview }, opts.json,
            `${preview.notice || ABANDONMENT_NOTICE}\ncommandIds: ${preview.commandIds.join(",")}\n--confirm ${preview.confirmationSha256}`);
          return;
        }
        const result = await abandonHistoricalAccepted(workspace, commandIds, confirmationSha256);
        print({ ok: true, ...result }, opts.json, `已写入 abandonment 证据；${ABANDONMENT_NOTICE}`);
      } catch (error) {
        const failure = safeCliError(error, "DESKTOP_ABANDONMENT_FAILED", "abandonment 操作失败；未覆盖原证据。" );
        print({ ok: false, error: failure.code, message: failure.message }, opts.json, failure.message);
        process.exitCode = 1;
      }
    });

  desktop.command("resolve-unknown")
    .description("为明确的 outcome_unknown 投递写入独立行政 resolution 证据；不修改原 delivery")
    .option("-w, --workspace <path>", "workspace 根目录")
    .requiredOption("--command-id <id>", "要解决的唯一 outcome_unknown commandId")
    .option("--confirm <sha256>", "preview 返回的 64 位 confirmationSha256；省略则只读预览")
    .option("--json", "输出机器可读结果", false)
    .action((opts: { workspace?: string; commandId: string; confirm?: string; json: boolean }) => {
      try {
        const confirmationSha256 = parseOutcomeResolutionConfirmation(opts.confirm);
        const workspace = new Workspace(workspaceRoot(opts.workspace));
        if (confirmationSha256 === undefined) {
          const preview = previewOutcomeResolution(workspace, opts.commandId);
          print({ ok: true, ...preview }, opts.json,
            `${preview.notice}\ncommandId: ${preview.commandId}\n--confirm ${preview.confirmationSha256}`);
          return;
        }
        const result = resolveOutcomeUnknown(workspace, opts.commandId, confirmationSha256);
        print({ ok: true, ...result }, opts.json, `${result.notice} 行政 resolution 状态：${result.status}。`);
      } catch (error) {
        const failure = safeCliError(error, "DESKTOP_OUTCOME_RESOLUTION_INVALID", "行政 resolution 失败；未修改原 delivery 或 execution receipt。" );
        print({ ok: false, error: failure.code, message: failure.message }, opts.json, failure.message);
        process.exitCode = 1;
      }
    });

  desktop.command("bind-current")
    .description("识别当前 Desktop 会话，经本机确认后绑定并启用")
    .option("-w, --workspace <path>", "workspace 根目录")
    .option("--json", "输出机器可读结果", false)
    .action(async (opts: { workspace?: string; json: boolean }) => {
      try {
        const result = await bindCurrentDesktop(new Workspace(workspaceRoot(opts.workspace)));
        print({ ok: true, ...result }, opts.json, result.alreadyEnabled ?
          "当前会话已绑定并启用，ChatGPT 可以向这里发送任务。" : "已绑定并启用当前会话，ChatGPT 现在可以向这里发送任务。");
      } catch (error) {
        const failure = safeCliError(error, "DESKTOP_CURRENT_CONTEXT_INVALID", "无法确认当前 Desktop 会话；未绑定或启用。");
        print({ ok: false, error: failure.code, message: failure.message }, opts.json, failure.message);
        process.exitCode = 1;
      }
    });

  desktop.command("bind")
    .description("绑定一个由本机用户明确指定的 Desktop 会话")
    .option("-w, --workspace <path>", "workspace 根目录")
    .requiredOption("--thread <threadId>", "Desktop threadId")
    .requiredOption("--host <hostId>", "Desktop hostId")
    .requiredOption("--project <projectId>", "Desktop projectId")
    .option("--json", "machine-readable output", false)
    .action(async (opts: { workspace?: string; thread: string; host: string; project: string; json: boolean }) => {
      const workspace = new Workspace(workspaceRoot(opts.workspace));
      const target = targetInput.parse({
        threadId: opts.thread,
        hostId: opts.host,
        projectId: opts.project,
      });
      const binding = await bindDesktop(workspace, target);
      print({ ok: true, binding }, opts.json, `已绑定 Desktop 会话「${binding.title}」（threadId：${binding.threadId}，bindingId：${binding.bindingId}）。重新绑定后须重新启用。`);
    });

  desktop.command("enable")
    .description("启用当前 Desktop 绑定；必须明确接受 Desktop 权限风险")
    .option("-w, --workspace <path>", "workspace 根目录")
    .requiredOption("--binding <bindingId>", "当前绑定 ID")
    .option("--accept-desktop-permissions", "确认任务可能按 Desktop 会话权限修改文件或执行命令", false)
    .option("--json", "machine-readable output", false)
    .action((opts: { workspace?: string; binding: string; acceptDesktopPermissions: boolean; json: boolean }) => {
      if (!opts.acceptDesktopPermissions) {
        throw new DesktopError("DESKTOP_PERMISSION_CONFIRMATION_REQUIRED", "启用 Desktop Control 前必须指定 --accept-desktop-permissions，并确认任务可能按该 Desktop 会话的现有权限修改文件或执行命令。" );
      }
      const workspace = new Workspace(workspaceRoot(opts.workspace));
      enableDesktop(workspace, opts.binding);
      const notice = "启用期间，获授权客户端可向此绑定会话发送任务；任务可能按该 Desktop 会话现有权限修改文件或执行命令，可随时使用 desktop disable 撤权。";
      print({ ok: true, enabled: true, bindingId: opts.binding, notice }, opts.json, `Desktop Control 已启用（bindingId：${opts.binding}）。${notice}`);
    });

  desktop.command("disable")
    .description("撤销本机 Desktop Control 授权")
    .option("-w, --workspace <path>", "workspace 根目录")
    .option("--json", "machine-readable output", false)
    .action((opts: { workspace?: string; json: boolean }) => {
      const workspace = new Workspace(workspaceRoot(opts.workspace));
      disableDesktop(workspace);
      print({ ok: true, enabled: false }, opts.json, "Desktop Control 已撤权；绑定和投递历史仍保留。" );
    });

  desktop.command("status")
    .description("查看 Desktop 绑定、可用性和投递状态")
    .option("-w, --workspace <path>", "workspace 根目录")
    .option("--command-id <commandId>", "只查看指定投递")
    .option("--json", "machine-readable output", false)
    .action(async (opts: { workspace?: string; commandId?: string; json: boolean }) => {
      const workspace = new Workspace(workspaceRoot(opts.workspace));
      const status = await desktopStatus(workspace, opts.commandId);
      print({ ok: true, ...status }, opts.json, `Desktop Control：${status.enabled ? "已启用" : "未启用"}；绑定：${status.binding?.title ?? "无"}；可用性：${status.availability.available ? "可用" : "不可用"}。`);
    });

  desktop.command("history")
    .description("只读列出 Desktop delivery 的统一历史状态")
    .option("-w, --workspace <path>", "workspace 根目录")
    .option("--json", "输出机器可读结果", false)
    .action((opts: { workspace?: string; json: boolean }) => {
      try {
        const items = listDesktopHistory(new Workspace(workspaceRoot(opts.workspace)))
          .map(({ commandId, status }) => ({ commandId, status }));
        print({ ok: true, items }, opts.json,
          items.map(item => `${item.commandId}: ${item.status}`).join("\n") || "没有 Desktop history 条目。");
      } catch (error) {
        const failure = safeCliError(error, "DESKTOP_HISTORY_INVALID", "无法读取 Desktop 历史；未修改状态。" );
        print({ ok: false, error: failure.code, message: failure.message }, opts.json, failure.message);
        process.exitCode = 1;
      }
    });

  desktop.command("diagnose")
    .alias("compatibility")
    .description("只读诊断当前 Desktop live IPC handshake；不做信任分类")
    .option("-w, --workspace <path>", "诊断目标 workspace；读取当前 conversation context")
    .option("--json", "输出机器可读结果", false)
    .action(async (opts: { workspace?: string; json: boolean }) => {
      try {
        const result = await desktopIpc.diagnose(new Workspace(workspaceRoot(opts.workspace)).root);
        print({ ok: true, ...result }, opts.json,
          `Desktop live 诊断（mode=${result.mode}）：processStable=${result.processStable}；initialize=${result.initialize}；owner=${result.ownerDiscovery}；following=${result.followingChangedSent}；state=${result.stateChange ?? "none"}。`);
      } catch (error) {
        const failure = safeCliError(error, "DESKTOP_IPC_UNAVAILABLE", "无法进行 live conversation diagnosis；没有发送消息。");
        print({ ok: false, error: failure.code, message: failure.message }, opts.json, failure.message);
        process.exitCode = 1;
      }
    });
}
