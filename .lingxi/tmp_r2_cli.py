# -*- coding: utf-8 -*-
"""R2.7 CLI 薄层 diagnose：compatibility 命令收敛，audit 体系退休。"""
import ast  # noqa: F401  (仅用于风格一致性检查占位)

P = 'src/cli/desktop.ts'


def replace_once(text, old, new, label):
    got = text.count(old)
    if got != 1:
        raise SystemExit(f'{label}: expected 1, got {got}')
    return text.replace(old, new)


text = open(P, encoding='utf-8').read()
orig = len(text)

# 1) import 行
text = replace_once(text,
    'import { desktopCompatibilityFromError, desktopIpc, DESKTOP_IPC_ERROR_MESSAGES } from "../desktop/ipc.js";',
    'import { desktopIpc, DESKTOP_IPC_ERROR_MESSAGES } from "../desktop/ipc.js";', 'import')

# 2) safeCliError 去 compatibility
text = replace_once(text, '''function safeCliError(error: unknown, fallbackCode: string, fallbackMessage: string): {
  code: string;
  message: string;
  compatibility?: ReturnType<typeof desktopCompatibilityFromError>;
} {
  const candidate = error instanceof DesktopError ? error.code : undefined;
  const known = candidate !== undefined && Object.prototype.hasOwnProperty.call(SAFE_CLI_ERROR_MESSAGES, candidate);
  const message = known ? SAFE_CLI_ERROR_MESSAGES[candidate!] : fallbackMessage;
  const code = known ? candidate! : fallbackCode;
  const compatibility = desktopCompatibilityFromError(error);
  return { code, message, ...(compatibility ? { compatibility } : {}) };
}

function compatibilityMessage(message: string, compatibility?: ReturnType<typeof desktopCompatibilityFromError>): string {
  if (!compatibility) return message;
  return `${message} Desktop：${compatibility.observedDesktopVersion ?? "unknown"}；app-server：${compatibility.observedAppServerVersion ?? "unknown"}；profile：${compatibility.profile ?? "unknown"}。`;
}''', '''function safeCliError(error: unknown, fallbackCode: string, fallbackMessage: string): {
  code: string;
  message: string;
} {
  const candidate = error instanceof DesktopError ? error.code : undefined;
  const known = candidate !== undefined && Object.prototype.hasOwnProperty.call(SAFE_CLI_ERROR_MESSAGES, candidate);
  const message = known ? SAFE_CLI_ERROR_MESSAGES[candidate!] : fallbackMessage;
  const code = known ? candidate! : fallbackCode;
  return { code, message };
}''', 'safeCliError')

# 3) compatibilityAuditMessage 删除
text = replace_once(text, '''function compatibilityAuditMessage(audit: Awaited<ReturnType<typeof desktopIpc.compatibilityAudit>>): string {
  const moduleText = audit.modules.length === 0 ? "无" : audit.modules
    .map(module => `${module.role}=${module.path}（${module.sha256}）`).join("；");
  const candidate = audit.candidateRuntime
    ? `候选运行时：Desktop ${audit.candidateRuntime.desktopVersion}；app-server ${audit.candidateRuntime.appServerVersion}`
    : "候选运行时：无";
  return `Desktop 兼容性审计：${audit.status}；分类：${audit.classification}；Desktop：${audit.observedDesktopVersion ?? "unknown"}；app-server：${audit.observedAppServerVersion ?? "unknown"}；profile：${audit.profile ?? "unknown"}；候选 profile：${audit.candidateProfile ?? "unknown"}；app-server SHA-256：${audit.appServerSha256 ?? "unknown"}；ASAR 头：${audit.asarHeader?.join(",") ?? "unknown"}；${candidate}；模块：${moduleText}。`;
}

''', '', 'compatibilityAuditMessage')

# 4) current-confirm 错误路径简化
text = replace_once(text, '''        const failure = safeCliError(error, "DESKTOP_CURRENT_CONTEXT_INVALID", "无法确认当前 Desktop 会话；未绑定或启用。");
        print({ ok: false, error: failure.code, message: failure.message,
          ...(failure.compatibility ? { compatibility: failure.compatibility } : {}) }, opts.json,
        compatibilityMessage(failure.message, failure.compatibility));
        process.exitCode = 1;''', '''        const failure = safeCliError(error, "DESKTOP_CURRENT_CONTEXT_INVALID", "无法确认当前 Desktop 会话；未绑定或启用。");
        print({ ok: false, error: failure.code, message: failure.message }, opts.json, failure.message);
        process.exitCode = 1;''', 'current-confirm error path')

# 5) compatibility 命令 -> diagnose（保留 compatibility 名一版作 alias）
text = replace_once(text, '''  desktop.command("compatibility")
    .description("只读诊断本机 Desktop/app-server 兼容性")
    .option("-w, --workspace <path>", "审计目标 workspace；handshake 模式读取当前 context")
    .option("--audit", "输出只读兼容性审计详情", false)
    .option("--handshake-audit", "执行受限只读 IPC handshake 审计", false)
    .option("--json", "输出机器可读结果", false)
    .action(async (opts: { workspace?: string; audit: boolean; handshakeAudit: boolean; json: boolean }) => {
      try {
        if (opts.audit && opts.handshakeAudit) {
          throw new DesktopError("DESKTOP_INVALID_REQUEST", "--audit 与 --handshake-audit 不能同时使用。");
        }
        if (opts.handshakeAudit) {
          const result = await desktopIpc.handshakeAudit(new Workspace(workspaceRoot(opts.workspace)).root);
          print({ ok: true, ...result }, opts.json,
            `Desktop handshake audit：${result.protocolClassification}；owner=${result.ownerDiscovery}；state=${result.stateChange}。`);
        } else if (opts.audit) {
          const audit = await desktopIpc.compatibilityAudit();
          print({ ok: true, ...audit }, opts.json, compatibilityAuditMessage(audit));
        } else {
          const compatibility = await desktopIpc.compatibility();
          const observedDesktopVersion = compatibility.observedDesktopVersion ?? "unknown";
          const observedAppServerVersion = compatibility.observedAppServerVersion ?? "unknown";
          const profile = compatibility.profile ?? "unknown";
          print({ ok: true, ...compatibility }, opts.json,
            `Desktop 兼容性：${compatibility.status}；Desktop：${observedDesktopVersion}；app-server：${observedAppServerVersion}；profile：${profile}。`);
        }
      } catch (error) {
        const failure = safeCliError(error, "DESKTOP_IPC_UNAVAILABLE", "无法读取本机 Desktop 兼容性；没有发送消息。");
        print({ ok: false, error: failure.code, message: failure.message,
          ...(failure.compatibility ? { compatibility: failure.compatibility } : {}) }, opts.json,
        compatibilityMessage(failure.message, failure.compatibility));
        process.exitCode = 1;
      }
    });''', '''  desktop.command("diagnose")
    .alias("compatibility")
    .description("只读诊断当前 Desktop live IPC handshake；不做信任分类")
    .option("-w, --workspace <path>", "诊断目标 workspace；读取当前 conversation context")
    .option("--json", "输出机器可读结果", false)
    .action(async (opts: { workspace?: string; json: boolean }) => {
      try {
        const result = await desktopIpc.diagnose(new Workspace(workspaceRoot(opts.workspace)).root);
        print({ ok: true, ...result }, opts.json,
          `Desktop live 诊断：processStable=${result.processStable}；initialize=${result.initialize}；owner=${result.ownerDiscovery}；following=${result.followingChangedSent}；state=${result.stateChange ?? "none"}。`);
      } catch (error) {
        const failure = safeCliError(error, "DESKTOP_IPC_UNAVAILABLE", "无法进行 live conversation diagnosis；没有发送消息。");
        print({ ok: false, error: failure.code, message: failure.message }, opts.json, failure.message);
        process.exitCode = 1;
      }
    });''', 'diagnose command')

open(P, 'w', encoding='utf-8', newline='\n').write(text)
print(f'cli/desktop.ts: {orig} -> {len(text)} chars')
