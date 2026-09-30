# -*- coding: utf-8 -*-
"""R2 Phase B 手术脚本：ipc.ts 瘦身 + abandonment/legacy-retirement 三处同删。"""
import re

IPC = 'src/desktop/ipc.ts'


def replace_once(text, old, new, label, count=1):
    got = text.count(old)
    if got != count:
        raise SystemExit(f'{label}: expected {count}, got {got}')
    return text.replace(old, new)


def cut_span(text, start_anchor, end_anchor, label, keep_end=True):
    """删除 [start_anchor 起点行, end_anchor 起点行) 的内容；保留 end_anchor 行。"""
    i = text.index(start_anchor)
    j = text.index(end_anchor, i)
    if not keep_end:
        j += len(end_anchor)
    print(f'  {label}: cut {j - i} chars')
    return text[:i] + text[j:]


text = open(IPC, encoding='utf-8').read()
orig_len = len(text)

# ---- B1: DesktopTargetInfo 三字段退出 ----
print('B1: DesktopTargetInfo fields')
text = replace_once(text, '''  requestsCount?: number;
  desktopVersion?: string;
  appServerVersion?: string;
  profile?: string | null;
  /** 内部诊断字段；不会由 MCP 直接返回。 */
  ownerClientId?: string | null;''', '''  requestsCount?: number;
  /** 内部诊断字段；不会由 MCP 直接返回。 */
  ownerClientId?: string | null;''', 'TargetInfo fields')

# ---- B2: compatibility 类型块整体删除（DesktopCompatibilityStatus..DesktopHandshakeAudit）----
print('B2: compatibility type block')
text = cut_span(text, 'export type DesktopCompatibilityStatus =', 'export interface DesktopExecutionInfo', 'compat types')

# ---- B3: SAFE_CODES / ERROR_MESSAGES ----
print('B3: SAFE_CODES / ERROR_MESSAGES')
text = replace_once(text, '  "DESKTOP_VERSION_UNSUPPORTED",\n', '', 'SAFE_CODES entry')
text = replace_once(text, '  DESKTOP_VERSION_UNSUPPORTED: "当前 Desktop/app-server 版本未经过适配验证；没有发送消息。",\n', '', 'ERROR_MESSAGES entry')

# ---- B4: COMPATIBILITY_* 常量块 ----
print('B4: COMPATIBILITY constants')
text = cut_span(text, 'const COMPATIBILITY_VERSION =', 'const ERROR_MESSAGES:', 'compat constants')

# ---- B5: validator 体系（compatibilityVersion..validateDesktopCompatibilityAudit + desktopCompatibilityFromError）----
print('B5: compatibility validators')
# exactKeys 保留（通用工具），从 AUDIT 块中摘出
EXACT_KEYS = '''function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return keys.length >= required.length && keys.length <= allowed.size && keys.every(key => allowed.has(key)) && required.every(key =>
    Object.prototype.hasOwnProperty.call(value, key));
}

'''
text = cut_span(text, 'function compatibilityVersion(value: unknown): string | null {', 'function exactKeys(', 'validators part1')
text = cut_span(text, 'function auditSemanticReason(value: unknown): DesktopSemanticReason {', 'export function desktopCompatibilityFromError(', 'validators part2')
text = cut_span(text, 'export function desktopCompatibilityFromError(value: unknown): DesktopCompatibility | undefined {', 'function error(', 'fromError')
# exactKeys 现在紧跟 error() 之前；把它移到 validateDesktopWireMessage 之前（原 validator 区起点）
text = replace_once(text, '''function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return keys.length >= required.length && keys.length <= allowed.size && keys.every(key => allowed.has(key)) && required.every(key =>
    Object.prototype.hasOwnProperty.call(value, key));
}

function error(''', EXACT_KEYS + 'function error(', 'exactKeys reposition')

# ---- B6: error() 签名简化 ----
print('B6: error() signature')
text = replace_once(text, '''function error(
  code: string,
  options: { notSent?: boolean; compatibility?: DesktopCompatibility } = {},
): DesktopError & { notSent: boolean; compatibility?: DesktopCompatibility } {
  const result = new DesktopError(code, messageFor(code)) as DesktopError & {
    notSent: boolean;
    compatibility?: DesktopCompatibility;
  };
  result.notSent = options.notSent ?? true;
  if (options.compatibility !== undefined) result.compatibility = options.compatibility;
  return result;
}''', '''function error(code: string, options: { notSent?: boolean } = {}): DesktopError & { notSent: boolean } {
  const result = new DesktopError(code, messageFor(code)) as DesktopError & { notSent: boolean };
  result.notSent = options.notSent ?? true;
  return result;
}''', 'error()')

# ---- B7: 精确 key 列表 validator（6 处中的 4 处含 version 字段）----
print('B7: exact key lists')
text = replace_once(text, '''  const keys = [
    "threadId", "hostId", "projectId", "workspaceRoot", "title", "cwd", "workspaceKind", "resumeState",
    "runtimeStatus", "requestsCount", "desktopVersion", "appServerVersion", "profile", "ownerClientId",
    "resultTurnId", "resultTurnStatus",
  ];
  if (Object.keys(input).sort().join(",") !== [...keys].sort().join(",")) throw error("DESKTOP_PROTOCOL_ERROR");
  const context = validateResultContext(value, target);
  if (input.workspaceKind !== "project" || input.resumeState !== "resumed" ||
      !Number.isSafeInteger(input.requestsCount) || (input.requestsCount as number) < 0 ||
      typeof input.desktopVersion !== "string" || !input.desktopVersion.trim() || input.desktopVersion.length > 128 ||
      typeof input.appServerVersion !== "string" || !input.appServerVersion.trim() || input.appServerVersion.length > 128 ||
      (input.profile !== null && (typeof input.profile !== "string" || !/^desktop-ipc-v[1-9]\\d*$/.test(input.profile))) ||
      typeof input.ownerClientId !== "string" || !isUuid(input.ownerClientId)) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }''', '''  const keys = [
    "threadId", "hostId", "projectId", "workspaceRoot", "title", "cwd", "workspaceKind", "resumeState",
    "runtimeStatus", "requestsCount", "ownerClientId", "resultTurnId", "resultTurnStatus",
  ];
  if (Object.keys(input).sort().join(",") !== [...keys].sort().join(",")) throw error("DESKTOP_PROTOCOL_ERROR");
  const context = validateResultContext(value, target);
  if (input.workspaceKind !== "project" || input.resumeState !== "resumed" ||
      !Number.isSafeInteger(input.requestsCount) || (input.requestsCount as number) < 0 ||
      typeof input.ownerClientId !== "string" || !isUuid(input.ownerClientId)) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }''', 'validateTargetScopedResultContext')

text = replace_once(text, '''  if (Object.keys(input).sort().join(",") !==
      "appServerVersion,cwd,desktopVersion,hostId,marker,ownerClientId,profile,projectId,requestsCount,resultTurnId,resultTurnStatus,resumeState,runtimeStatus,threadId,title,workspaceKind,workspaceRoot") {''',
'''  if (Object.keys(input).sort().join(",") !==
      "cwd,hostId,marker,ownerClientId,projectId,requestsCount,resultTurnId,resultTurnStatus,resumeState,runtimeStatus,threadId,title,workspaceKind,workspaceRoot") {''',
'marker observation keys')

text = replace_once(text, '''  if (Object.keys(input).sort().join(",") !==
      "appServerVersion,cwd,desktopVersion,fence,hostId,ownerClientId,profile,projectId,requestsCount,resultTurnId,resultTurnStatus,resumeState,runtimeStatus,threadId,title,workspaceKind,workspaceRoot") {''',
'''  if (Object.keys(input).sort().join(",") !==
      "cwd,fence,hostId,ownerClientId,projectId,requestsCount,resultTurnId,resultTurnStatus,resumeState,runtimeStatus,threadId,title,workspaceKind,workspaceRoot") {''',
'terminal fence keys')

text = replace_once(text, '''  const allowed = new Set([
    "threadId", "hostId", "projectId", "workspaceRoot", "title", "cwd", "workspaceKind", "resumeState",
    "runtimeStatus", "requestsCount", "desktopVersion", "appServerVersion", "profile", "ownerClientId",
    "resultTurnId", "resultTurnStatus", "ownership", "originTurnId", "chainTurnIds", "chainLength", "signature",
  ]);''', '''  const allowed = new Set([
    "threadId", "hostId", "projectId", "workspaceRoot", "title", "cwd", "workspaceKind", "resumeState",
    "runtimeStatus", "requestsCount", "ownerClientId",
    "resultTurnId", "resultTurnStatus", "ownership", "originTurnId", "chainTurnIds", "chainLength", "signature",
  ]);''', 'ownership allowed')

text = replace_once(text, '''  const allowed = new Set([
    "threadId", "hostId", "projectId", "workspaceRoot", "title", "cwd", "workspaceKind", "resumeState",
    "runtimeStatus", "requestsCount", "desktopVersion", "appServerVersion", "profile", "ownerClientId",
    "resultTurnId", "resultTurnStatus", "classification", "workspaceId", "commandId", "intent",
    "messageBytes", "messageSha256", "ownership", "originTurnId", "chainTurnIds", "chainLength", "signature",
  ]);''', '''  const allowed = new Set([
    "threadId", "hostId", "projectId", "workspaceRoot", "title", "cwd", "workspaceKind", "resumeState",
    "runtimeStatus", "requestsCount", "ownerClientId",
    "resultTurnId", "resultTurnStatus", "classification", "workspaceId", "commandId", "intent",
    "messageBytes", "messageSha256", "ownership", "originTurnId", "chainTurnIds", "chainLength", "signature",
  ]);''', 'classification allowed')

# ---- B8: validateDesktopHandshakeAudit -> validateDesktopDiagnosis ----
print('B8: handshake audit -> diagnosis')
text = cut_span(text, 'export function validateDesktopHandshakeAudit(', 'function validateResultOwnershipExpectation(', 'handshake audit validator')
DIAGNOSIS = '''export interface DesktopDiagnosis {
  processStable: true;
  initialize: true;
  ownerDiscovery: boolean;
  followingChangedSent: boolean;
  stateReceived: boolean;
  stateChange: "snapshot" | "patches" | null;
}

export function validateDesktopDiagnosis(value: unknown): DesktopDiagnosis {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error("DESKTOP_PROTOCOL_ERROR");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !==
      "followingChangedSent,initialize,ownerDiscovery,processStable,stateChange,stateReceived") {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  if (input.processStable !== true || input.initialize !== true ||
      typeof input.ownerDiscovery !== "boolean" || typeof input.followingChangedSent !== "boolean" ||
      typeof input.stateReceived !== "boolean" ||
      (input.stateChange !== "snapshot" && input.stateChange !== "patches" && input.stateChange !== null)) {
    throw error("DESKTOP_PROTOCOL_ERROR");
  }
  return input as DesktopDiagnosis;
}

'''
text = replace_once(text, 'function validateResultOwnershipExpectation(', DIAGNOSIS + 'function validateResultOwnershipExpectation(', 'diagnosis insert')

# ---- B9: HelperSession.consume 去 compatibility ----
print('B9: consume() error path')
text = replace_once(text, '''        // 缺失 notSent 不能证明尚未进入真实 start；send 必须保守为 unknown。
        const notSent = response.notSent === true;
        const compatibility = desktopCompatibilityFromError(response);
        pending.reject(error(requestedCode, {
          notSent,
          ...(compatibility ? { compatibility } : {}),
        }));''', '''        // 缺失 notSent 不能证明尚未进入真实 start；send 必须保守为 unknown。
        pending.reject(error(requestedCode, { notSent: response.notSent === true }));''', 'consume error path')

# ---- B10: DesktopIpcClient 方法收敛 ----
print('B10: client methods')
text = cut_span(text, '  async compatibility(): Promise<DesktopCompatibility> {', '  async currentIdentity(', 'compat methods')
DIAGNOSE_METHOD = '''  /** 只读 live handshake 诊断；不做信任分类，也不输出版本或 bundle 信息。 */
  async diagnose(workspaceRoot: string): Promise<DesktopDiagnosis> {
    if (typeof workspaceRoot !== "string" || !workspaceRoot.trim()) throw error("DESKTOP_INVALID_REQUEST");
    const session = this.open();
    try {
      const value = await session.request("diagnose", { workspaceRoot });
      return validateDesktopDiagnosis(value);
    } finally { session.close(); }
  }

'''
text = replace_once(text, '  async currentIdentity(workspaceRoot: string): Promise<DesktopTargetInfo> {',
                    DIAGNOSE_METHOD + '  async currentIdentity(workspaceRoot: string): Promise<DesktopTargetInfo> {', 'diagnose method')

open(IPC, 'w', encoding='utf-8', newline='\n').write(text)
print(f'ipc.ts: {orig_len} -> {len(text)} chars')

# =====================================================================
# abandonment.ts / legacy-retirement.ts 三处同删
# =====================================================================
for path, ctx_type in [('src/desktop/abandonment.ts', 'MaintenanceContext'),
                       ('src/desktop/legacy-retirement.ts', 'OwnerlessContext')]:
    print(f'--- {path}')
    t = open(path, encoding='utf-8').read()
    before = len(t)
    # 1) 类型字段
    t = replace_once(t, '''  requestsCount?: number;
  desktopVersion?: string;
  appServerVersion?: string;
  profile?: string | null;
  ownerClientId?: string | null;''', '''  requestsCount?: number;
  ownerClientId?: string | null;''', f'{ctx_type} type fields')
    # 2) projection
    t = replace_once(t, '''    requestsCount: context.requestsCount,
    desktopVersion: context.desktopVersion,
    appServerVersion: context.appServerVersion,
    profile: context.profile,
    ownerClientId: context.ownerClientId,''', '''    requestsCount: context.requestsCount,
    ownerClientId: context.ownerClientId,''', f'{ctx_type} projection')
    # 3) equality
    t = replace_once(t, '''    a.desktopVersion === b.desktopVersion && a.appServerVersion === b.appServerVersion &&
    a.profile === b.profile && a.ownerClientId === b.ownerClientId;''', '''    a.ownerClientId === b.ownerClientId;''', f'{ctx_type} equality')
    open(path, 'w', encoding='utf-8', newline='\n').write(t)
    print(f'  {before} -> {len(t)} chars')

print('done')
