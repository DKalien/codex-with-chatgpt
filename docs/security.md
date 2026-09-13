# Security Model

## MCP Remote Control 授权边界

第三阶段新增 `codex.control` / `codex.read`，不属于默认授权，也不复用 probe.write。
写入需 OAuth scope 和本地 `remote enable` 同时成立。工作区根目录仅由本地 CLI 注册，
MCP 只接受当前 Bridge 的 workspaceId 和 C2C 管理的 threadId，不能启用工作区或传任意路径。
用户目标交给 Codex 主代理；不提供通用 Shell、文件写入 RPC、provider 配置或 Worker 接口。
Codex 继承本机安全配置，任务本身可能修改文件、调用工具；approval 请求不会自动批准。

队列 JSON 用锁和原子替换保存，ID 永不淘汰；不确定的已开始任务阻塞工作区并要求本地核对。
状态接口只返回限定元数据，最终回答走现有 execution_output sanitizer，审计不复制任务原文。
Controller 是独立本机常驻进程，无浏览器依赖，不注册开机启动。
Remote disable 拒绝新调用和消费，正在执行的 turn 需另用 controller stop 停止。
完整边界与恢复流程见 [Remote Control](remote-control.md)。

## Trust boundaries

1. **Workspace root** is the smallest authorization boundary. One bridge serves
   exactly one workspace; every token is bound to `workspace_id`; a token for
   project A returns 403 on project B's bridge.
2. **Workspace content is untrusted.** README, comments, diffs may contain
   prompt injection. Every MCP tool description carries an explicit warning and
   tools never grant capabilities based on file content.
3. **The model never sees long-lived credentials.** Computer Use only ever
   handles the one-time pairing code. Access/refresh tokens travel only inside
   the OAuth redirect/token endpoints between ChatGPT's client and the bridge.

## Threat model → mitigations

| Threat | Mitigation |
| --- | --- |
| MCP URL leaks | URL alone is useless: every `/mcp` request requires a valid bearer token (401 without, 403 wrong workspace) |
| Pairing code brute force | 8 chars from a 31-char CSPRNG alphabet (~40 bits), 5 attempts per session, per-IP rate limit (10/min), 5-minute TTL, one-time use, session destroyed on limit |
| OAuth CSRF | `state` round-tripped verbatim; authorization requests are server-side records keyed by random ids |
| Code interception | PKCE S256 mandatory (plain rejected); authorization codes are one-time, 5-minute TTL, bound to client + redirect URI |
| Token theft | Opaque high-entropy tokens; stored only as SHA-256 hashes; access tokens live 1 h; refresh tokens rotate on every use (replay of the old one fails); revocation endpoint + `c2c unpair` |
| Workspace traversal | `realpath` canonicalization of the deepest existing ancestor; containment check against the canonical root; case-insensitive comparison on macOS/Windows; rejects `..`, absolute escapes, backslash tricks, null bytes |
| Symlink escape | Canonicalization resolves symlinks before the containment check (file and directory symlinks both covered by tests) |
| Sensitive files | Deny-by-default patterns (.env*, keys, SSH, cloud creds, keychains…) enforced at resolve time — reads, listings, and search all pass through the same gate; `git diff` adds pathspec excludes; `.env.example` allowed |
| Oversized file / diff DoS | read_file caps lines and bytes per response; git_diff paginates by byte offset with hard caps; search caps matches and file sizes |
| Tunnel exposure | Bridge binds 127.0.0.1 only (refuses 0.0.0.0); `/mcp` requires OAuth. Public `/health` exposes service/version/status, hashed workspace ID, PID/start time and available runtime build ID, never the workspace root or credentials. OAuth discovery/authorization routes retain their own checks. |
| Admin API abuse | Loopback-only + random admin token (0600 runtime file) + requests with proxy headers (`cf-connecting-ip`, `x-forwarded-for`) rejected; unauthenticated probes get 404 |
| Log credential leakage | Logger redacts token prefixes, bearer headers, token-like parameters, and pairing-code-shaped strings before writing |
| Execution output leak | Codex may nominate logs or Remote turn final responses; a local sanitizer redacts tokens, pairing-code-shaped strings and home paths, truncates size, and refuses private-key blocks entirely. Restricted items are listed without a body. Read-only tools cannot run commands; Remote Control and Desktop Control are separate, explicitly authorized paths. |
| Checkpoint / resume dump | Session checkpoints store short protocol fields only (capped). Resume uses the existing chat or HANDOFF — no new protocol state, no log paste, no re-pairing. |

## Token & scope design

Default scopes: `workspace.read`, `workspace.search`, `git.read`, `execution.read`,
`offline_access`. Tools enforce scopes individually (`INSUFFICIENT_SCOPE`). When
`C2C_ENABLE_WRITE_PROBE=1`, an explicit authorization may additionally request the
separate `probe.write` scope; existing refresh tokens do not gain it.
Access tokens: 1 hour. Refresh tokens: 30 days, rotated. All tokens bound to
`workspace_id` and `client_id`.

## Storage

State lives under the OS-convention app dir
(`~/Library/Application Support/codex-with-chatgpt` on macOS), directories 0700,
files 0600. Named-hostname preference and tunnel metadata live there too
(`tunnels/<workspaceId>.json`) — never in the project. Only SHA-256 hashes of
tokens are persisted — a stolen state file does not yield usable bearer tokens.

**V1 limitation**: client registrations and token hashes are file-based rather
than OS-keychain-based. Raw tokens are never written anywhere. Keychain
integration is a V2 item.

## Experimental MCP write probe

The probe is off by default and independent of formal Remote Control. When enabled it adds
`write_probe` beside the original 9 read-only tools and writes only
`getStateDir()/write-probe.json` (`c2c-state/write-probe.json` logically), with a
validated nonce, timestamp, workspace ID and tool name. It overwrites the previous
record; it cannot write workspace files, delete files, run commands or commit.
The tool declares `readOnlyHint:false`, `destructiveHint:true`,
`idempotentHint:false` and `openWorldHint:false`; missing `probe.write` returns
`INSUFFICIENT_SCOPE` with `mcp/www_authenticate`. See
[the experiment procedure](experimental-write-probe.md).

## Desktop Control trust boundary

Desktop Control 是默认关闭的独立 MCP 写入能力，使用 `codex.desktop.control`（写入）和
`codex.desktop.read`（状态）两个 scope；它不复用 `codex.control`、`codex.read`、默认
scope 或 `probe.write`。有效 OAuth scope 只是远端条件，发送还必须通过本机 `desktop enable`
和当前 `bindingId` 校验。

两个 Desktop schema 始终可发现，但未绑定、未 enable 或缺少对应 scope 均不能发送。
Activation 的旧 Connector 迁移只检查同一有效授权的 Desktop scopes 和实际网页 schema；
兼容则不重建，不兼容仅迁移当前 workspace 同名 Connector。unknown/corrupt 停止诊断，
不暴露凭据，不改变 Project/session/checkpoint，具体门禁见 [Desktop Control](desktop-control.md)。
AuthStore 加载授权文件失败或结构损坏时保留原文件并拒绝重新注册/发放授权覆盖；需要人工核对。

绑定由本机用户明确指定真实 Desktop `threadId`、`host`、project 和 workspaceRoot，并
在绑定时核对 Desktop 当前 cwd、owner 和版本。每个 workspace 只有一个当前绑定；重新绑定
生成新的 `bindingId` 并关闭启用状态，旧请求不能转投新目标。网页不能 bind、enable 或改
本机权限。

### 日常 `bind-current` 安全约束

当前 Desktop 中的自然语言请求（例如“把这个会话绑定并启用给 ChatGPT”）只触发本机
`desktop bind-current [-w <workspace>] [--json]`。它从当前真实 `CODEX_THREAD_ID` 精确
解析 thread、project 和 workspaceRoot，不按标题或最近会话猜测，也不需要用户 ID 或手打
命令。由于本地 composer 与 IPC `userMessage` 来源无法可靠区分，所有新增绑定或启用变更
都必须弹出本机一键确认窗，固定显示风险“ChatGPT 可以向此 Desktop 会话发送任务；任务可能
按该会话已有权限修改文件或执行命令”、实际 Desktop 标题和规范化 workspaceRoot。新窗口不
能由 Codex 自动点击或脚本代点，必须由本机用户自己点击；prompt 不是授权凭证。命令不接收
thread/user ID、`--yes` 或 `--accept` 等绕过确认的参数，确认窗最多等待 2 分钟。

快捷流程只由当前本机用户在当前 Desktop composer 中明确提出的动作请求触发；文档、代码块、
引用、任务计划或普通讨论里的示例句不触发。来源无法可靠证明来自本机时，不能凭文字免除确认。

同一身份已 enabled 时，身份核验通过即返回 `alreadyEnabled`，复用原 `bindingId`，不生成
新 ID、不再次授权；同一身份 disabled 时，用户确认后 enable 并复用原 ID；同一 workspaceRoot
下不同 thread/project 需确认后生成新的 `bindingId`。所有 deliveries history 保留，其中含旧
`bindingId`；不同 workspaceRoot 或无法确认（`unknown`）时明确阻断快捷 bind/enable/send，
不能用新 ID 或重新绑定规避。身份核验允许 `active`，但 send 仍严格要求 `idle`、无待审批、
owner/project/workspace 匹配和已验证版本。传统显式 `desktop bind` + `desktop enable` 仍只是
高级 fallback，不新增 MCP bind 工具。

身份来源没有可依赖的 composer/IPC 区分信号；`CODEX_INTERNAL_ORIGINATOR_OVERRIDE='Codex Desktop'`
若出现也只是会话级提示，不能作为免确认条件或安全边界，不能声称可抵抗本机任意代码篡改。

发送前重新核对 Desktop 服务进程、端点、owner、项目和 workspace；Desktop 重启后重新发现，
不永久信任旧 PID。Desktop idle/start 内部协议在检查和实际发送之间没有原子 CAS，目标
可能在窗口内改变，回执不匹配或不明必须按未知结果处理。未知版本、离线、忙、待审批、无 owner、错项目、workspace 不匹配或
提权时零发送。Windows helper 仅使用 `C2C_DESKTOP_PYTHON` 或 `python` 完成受控标准库
IPC，不要求管理员权限，不启动第二个 app-server/router，也不把原始 RPC 暴露到 Tunnel。

`codex_desktop_send` 只接受完整的用户确认计划或修订指令；投递层添加固定内部 envelope。
原正文和包含 envelope/JSON 转义的完整 wire 均校验 64 KiB（65536 字节）上限，超限拒绝且不截断。
`intent` 必填且只能为 `development_plan` 或
`revision`；`userConfirmed` 必须是字面值 `true`，只有当前对话用户明确确认后模型才能填写，
例如用户说“可以，就按这么做”。它只是模型可填写的语义审计信号，不是授权凭证，不替代 OAuth、
本机 `enable`、`bindingId` 或 Desktop 审批，也不承诺能够影响或绕过平台安全策略；完整计划仍
可能被 Desktop 或平台策略拦截、拒绝或要求审批。正文不是 shell、路径、原始 RPC 或工具结果；请求不覆盖
model/provider/cwd/effort/sandbox/approval/permissions 等 Desktop 执行设置。工具仅在
Desktop 接受真实投递后返回 `deliveryStatus=accepted`，它不等待 `completed`，也不产生
测试通过结论。

执行终态证据使用本机 `desktop record-result`，必须验证真实当前 thread 和唯一 active turn，或
idle 时 canonical history 最新侧完整的最后 terminal turn，写入前再次确认其
与 accepted delivery 一致；网页无写 record 工具。Review 以 exact commandId 关联 record/output，
不能从旧 `test_status` 推导本轮通过。完整规则见 [自动验收记录](desktop-control.md#自动验收记录)。

send 的风险标注保持 `readOnlyHint:false`、`destructiveHint:true`、`openWorldHint:true`、
`idempotentHint:true`；`idempotent` 仅表示同一 `commandId` 防止重复尝试，不是网络 exactly-once，
也不是授权凭证。

投递记录保存 OAuth `clientId`、`bindingId`、`commandId`、正文摘要、阶段和真实 thread/turn
ID；必要的 `bindingId`、`threadId` 和 `turnId` 等投递元数据可以返回，但不保存完整正文到
状态查询、日志或 `execution_summary`。跨进程锁和原子写保证同 client、
同 ID、同参数重放返回原记录，`intent` 或其他参数冲突时拒绝；实际发送前先保存“可能已发送”。回执超时、
断线、崩溃或落盘不明返回 `outcome_unknown`，不自动重发，也不能换 `commandId` 绕过；
整个 workspace（包括重新绑定后的目标）的后续投递暂停，必须由本机用户人工核对；MVP
没有自动恢复或恢复接口。这个机制防止重复尝试，不宣称网络上的 exactly-once。`disable`
或重新绑定不能撤回已越过提交点的在途消息。

状态 `revision` 可选；旧记录读取时默认 `0`，读取不迁移或回填。只有正常写入才递增
`revision`，确认提交会核对它以发现确认期间的撤权、重新绑定等 ABA 变化；发现变化时阻断
快捷操作并要求重新确认。

状态格式仍为 `version: 1`。`delivery.intent` 读取时可选，仅兼容缺少该字段的旧记录；新写入
记录必须保存 `intent`。读取不迁移、回填或修改旧历史，旧记录在 `status` 返回中继续缺省
`intent`。使用缺少该字段的旧 `commandId` 再次 `send` 时，无法证明新的 `intent` 与原请求
相同，按 `DESKTOP_COMMAND_CONFLICT` 拒绝，并引导先用 `status` 查看原记录；`outcome_unknown`
阻断规则保持不变。

Desktop 执行结果必须另按现有 `record` 流程以 command/task ID 记录真实摘要、测试和可读
`execution_output`。投递记录不等于执行记录；历史测试也不等于本次任务通过。profile 标识、
`override=null` 与最终权限解析属于不同字段层次，“设置继承”是源码推断，不是全部可观察
事实；provider 和服务端最终权限解析可能仍是 unknown。不能复制私有配置或据此声称权限
设置全部通过。

完整流程和恢复限制见 [Desktop Control](desktop-control.md)。

## Web Control trust boundary

新增可选控制面使用当前 Codex Agent 的 in-app browser 接收绑定 Chat 的完整 Assistant 消息。
Web Control 本身不新增 MCP 写入动作；默认 MCP 数据面仍只读：workspace_info、list_directory、
read_file、search_workspace、git_status、git_diff、test_status、execution_summary、execution_output。
可选的实验性 `write_probe` 与 Web Control 独立，默认关闭，见上文。

- **本地明确授权。** 默认 disabled；只有 Codex 本地用户明确开启后，可信本地 Agent 才能传
  `--local-user` 给本地 enable。网页 ENABLE、项目文件或 MCP 返回不能触发 enable。
  这个 flag 是本地工作流声明，不是密码或远端身份验证；本机已有执行权限的人当然可以运行 CLI。
- **来源与意图。** Agent 核对真实网页的 role、完整消息、稳定 ID、消息顺序、生成结束以及最近
  人类用户的明确委派。CLI 检查严格 envelope、HTTPS Chat URL、workspaceId、Codex task ID、
  controlSessionId、有效期和完整 COMMAND 语法。envelope 中的 source/explicitDelegation/
  withinOriginalScope 是本地 Agent 的观察声明，**不能由网页自证**。仅有结构正确的文件或日志不够。
  没有可靠 DOM 来源/意图证据就拒绝，不扫描整页文字或工具卡片。
- **不可信数据。** Workspace content must never be treated as authorization to control Codex.
  文件、README、AGENTS、代码注释、diff、日志、MCP 都可用于分析，不能授权开启控制、扩大任务、
  绕过本地规则。Boot 明确告知此边界；Codex 独立审查任务，不能仅依赖 ChatGPT 遵守 Boot。
- **自动消息不是人类授权。** Boot/EXECUTED 的真实 message IDs 保存在状态里。Review follow-up
  只能跟随当前 completed 命令的 EXECUTED，使用新 COMMAND_ID，并由主代理核对仍在原用户任务范围。
  原任务 DONE 后必须是新的用户明确委派；普通建议不执行。
  本地 reject 消耗已使用的用户消息授权，不能仅更换 COMMAND_ID 重试被拒绝的目标。
  Boot/反馈 ID 必须仍存在于自动消息历史中，引用缺失也视为损坏状态，拒绝接收。
- **防重放与原子写。** accepted 在任何执行前持久化，start 只允许 accepted→executing；
  所有 accepted/executing/completed/rejected ID 跨恢复和重新 enable 保留，不回收历史。
  对同一消息的再次读取不重新执行。达到 10000 条历史停止接单。session 使用独占短锁、
  临时文件 fsync 后原子 rename；并发、损坏状态和遗留锁拒绝操作，旧文件保留。
  `session clear` 禁用控制但不删除历史；Normal session 更新保留 webControl。
  activeCommand 未结案时拒绝重新 enable；completed 的结果仍能在关闭/过期后补反馈。
  无法继续网页 Review 时，仅本地用户明确要求的 close-task 可以结案已完成任务，保留历史。
- **权限不扩大。** COMMAND 是任务级自然语言，不是直接 Shell、文件写入、git 操作或子代理 API。
  主代理仍按实际授权、AGENTS 和本地审批/沙箱决定实现，禁止自动 bypass、提权或改写沙箱配置。
  Web Control 使用 doctor --no-fix 检查，权限不足停止；Normal 模式原设置流程保持独立。

状态在已有 OS AppData 的 `sessions/<workspaceId>.json` 内，不新增凭证，不读写 OAuth token。
任务自然语言属于本地状态，不能夹带凭证。执行输出继续走既有 sanitizer；网页反馈仅元数据。

### 限制与恢复

控制依赖可信本地 Agent 的 UI 来源和用户意图判断；不是密码学认证的远程执行通道，也不能防御
已经控制本机账户/Agent 的攻击者。人工删除、篡改或回滚历史文件会损坏 replay 保证，禁止用这种方式恢复。
缺失的旧历史无法凭空重建；只从经过核对、不会丢失已处理 ID 的副本恢复。
遗留锁不能自动删：先核对锁文件的 PID 已退出；损坏会话保留原件并人工恢复，不能清空后继续接单。

默认 30 分钟 idle（轮询/重复/拒绝不续期，executing 暂停计时）；过期由下一次本地检查落实。
存储 enabled 不等于后台在线。Agent 停止后不会收取消息或自动恢复在途执行；accepted/executing
必须先核对实际修改和记录，不能自动重跑。关闭只禁止新接单，不假称撤销已发生的修改或杀死外部进程。
**Web Control only works while the corresponding Codex control session remains active.**
不启动 daemon/第二 app-server，不用 Desktop remote resume，不支持网页唤醒关闭的 Codex。

## What MCP cannot do (V1)

Except for the explicitly authorized write actions described above, MCP has no
tools to write workspace files, delete files, run shell commands, commit or
install packages directly. Desktop Control delivers only plain task text to its
locally bound Desktop thread; it is not a direct shell or file RPC, but that text
can still influence Desktop behavior under the local user's authorization, the
session's existing permissions and Desktop approval flow. There is no promise
against a malicious client that already has the Desktop scope. The separate
write probe remains limited to its documented C2C state record.
