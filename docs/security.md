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
| Tunnel exposure | Bridge binds 127.0.0.1 only (refuses 0.0.0.0); the only public surface is HTTPS via the tunnel, protected by OAuth; `/health` reveals only a salted workspace hash |
| Admin API abuse | Loopback-only + random admin token (0600 runtime file) + requests with proxy headers (`cf-connecting-ip`, `x-forwarded-for`) rejected; unauthenticated probes get 404 |
| Log credential leakage | Logger redacts token prefixes, bearer headers, token-like parameters, and pairing-code-shaped strings before writing |
| Execution output leak | Codex may nominate logs or Remote turn final responses; a local sanitizer redacts tokens, pairing-code-shaped strings and home paths, truncates size, and refuses private-key blocks entirely. Restricted items are listed without a body. Read-only tools cannot run commands; Remote Control separately authorizes Codex tasks. |
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

Except for the explicitly authorized experimental probe described above, MCP has
no tools to write workspace files, delete files, run shell commands, commit or
install packages directly. Prompt injection, a scope bug or UI confusion cannot
turn the probe into any of those capabilities.
