# Troubleshooting

Use the installed stable launcher for the `c2c` commands below and specify `-w <workspace>` for per-workspace commands. Machine `gateway` commands use the explicit registry or machine state directory instead.
For read-only inspection, start with `c2c status -w <workspace> --json` or `c2c doctor -w <workspace> --no-fix --json`.
For Unified Gateway, `gateway list --client-id <clientId> --json` reads local grants and `gateway supervisor status --json` / `validate --json` inspect its configuration and runtime. These checks do not start services or register Scheduled Tasks. Gateway OAuth authenticates the client, while every project call also needs the explicit workspace grant and canonical root match; `GATEWAY_UNKNOWN_WORKSPACE`, `GATEWAY_CLIENT_NOT_AUTHORIZED` and `GATEWAY_WORKSPACE_ID_MISMATCH` are distinct failures. A discovered tool or healthy Tunnel does not prove project authorization, route VERIFIED or successful task execution. Recheck exact identities before any separately authorized repair; do not remove owner locks or change commandId to bypass uncertainty. See [official route](official-route.md) and [Unified Gateway stages](unified-gateway-plan.md).
When connection repair is intended:

```
c2c doctor -w <workspace>
```

It checks Node, workspace, bridge, MCP, OAuth and tunnel — and repairs what it
can (restarts the bridge, restarts the tunnel) without asking.

### Core installed, but a workspace still reports an older build

Building the checkout only produces artifacts. `scripts/dev-install.ps1` installs an immutable
release, switches the machine pointer, installs the Skill, and attempts safe rollout. Rebuilding
or moving the checkout afterward does not alter that installed release.
Read `runtimeUpgrade` in `status/doctor --json`: `installedBuildId` is the selected release;
`runtimeBuildId` belongs to the running process and may be absent on legacy builds.

`busy`, approval, unresolved outcome, unknown identity, pairing or Remote activity keep the
workspace pending. `quick` is skipped because a restart would change its URL; stopped workspaces
are not started. Once a named workspace is provably healthy and idle, a local
`c2c rollout -w <workspace> --json` can retry. A supervisor foundation now exists, but independent OS recovery requires separately authorized per-user task installation. Read `c2c supervisor status -w <workspace> --json`; installed code alone does not mean the task is registered or running.
A concurrent `rollout_busy` response performs no state writes; it does not create a new pending record.
Do not rebuild a compatible Connector or reauthorize OAuth merely because the Core build differs.
Do not interrupt an active Review Bridge to clear pending status.

### v2rayN 与 Gateway 代理

使用 v2rayN 实际启用的 HTTP / mixed 端口，在完整的 `gateway supervisor configure` 参数中设置 `--proxy <url>`（保留其余原配置参数），配置无凭据的 HTTP(S) URL；不要把 SOCKS 端口当作 HTTP 代理。`http://127.0.0.1:10808` 只是 2026-10-13 本机观察值，不是固定默认端口。Gateway 的 `proxy` 仅传给 tunnel-client 的 `--control-plane.http-proxy`，不控制浏览器、Windows 全局代理或所有 Node 网络请求。

已有 owner 时 configure 拒绝覆盖。修改现有代理需用户授权维护，使用既有身份校验与认证 shutdown 覆盖完整 hosted workspace 集合，确认旧 native 进程退出后，再通过既有配置入口保留原 config 的全部值，仅修改 `proxy`；冷启动只恢复既有 running intent。不要手改配置、删锁或按旧 PID kill，也不要借此改 OAuth、绑定或历史。

验证时分别检查直连、显式代理、公网 `/health` 与 Gateway OAuth metadata，并记录所用客户端和 TLS 结果。curl 代理请求成功不代表 PowerShell 或浏览器成功；本机观察中 curl 显式 `10808` 返回 200、SSL verify 为 0，但 PowerShell 同 URL 显式代理出现 TLS EOF，不能据此宣称全网代理已验证。

### Bridge Supervisor Windows ACL 校验失败

源码中的 owner-only ACL 校验采用固定 15 秒子进程 deadline（包含 PowerShell 启动、ACL 执行与退出），保留 owner SID、精确 DACL 与继承检查；失败继续返回 `SUPERVISOR_STORE_SECURITY`。错误只附带有限的 `classification`、有界单调时钟耗时、退出码和白名单 signal，不返回路径、SID、环境、原始 stdout/stderr 或 cause。`timeout` 表示子进程报告超时，即使同时得到 exit 0 和完整 OK 输出也拒绝；`nonzero` 本身不能证明 ACL mismatch，仍需现场证据。诊断信息不授权重试、提权或放宽校验。

`tests/supervisor-store.test.ts` 失败时先把 exact fixture 内容、原路径 ACL/SDDL 和测试侧子进程记录保存到 ignored `.tooling/supervisor-acl-diagnostics/<uuid>/`，再严格清理；ACL 快照采集失败则保留原 fixture。链接只记元数据，不跟随到其它目录。正常通过仍 strict teardown；单次 PASS 不替代原失败归因或正式门禁，也不代表已部署。

### named rollout 显示 `named_unhealthy`

隧道 `running=true` 或公网 `/health` 返回 HTTP 200 不能单独证明 rollout 安全。命名 tunnel 的 workspace、hostname、publicUrl/provider，以及运行时 PID、startedAt、build identity 必须与本地受认证的 admin/runtime 观察完全一致；任一身份不一致都保持 `named_unhealthy`，不要按旧 PID kill、手工改 pending/finalizer 状态或循环重试。先等待/修复同一 workspace 的身份一致性，再使用稳定 launcher 执行一次 `c2c rollout -w <workspace> --json`。

## Common situations

### 历史诊断：旧网页接管完成，但 Companion 仍未连接（2026-10-13 源码退役）

以下为已退役旧 popup/SW 的历史诊断，不作为现役恢复步骤。本轮只退役源码及专属测试，尚未部署；Bridge 历史状态与恢复合同仍保留。现役流程见下方“日常连接与本机确认”。

旧 popup/SW 的 connectState、recovery、bindingEpoch、routeAttestFence 等字段只属于已退役历史界面，不是现役恢复入口；不要把旧 VERIFIED 快照当成当前页面状态。任务面板与 Bridge 的现役流程见下方“日常连接与本机确认”。

- `OUTCOME_UNKNOWN`：未证明发送结果，不能用“输入框为空”或新代码断言旧尝试未发送；不要反复发送、清除目标或重新配对。当前只按 Bridge 保存的原目标和精确观察规则恢复。

### 日常连接与本机确认

**默认轻量弹窗**

首次使用：在具体 ChatGPT 对话打开弹窗，粘贴配对 JSON，单独点击“授权 Bridge 访问”，再点击“配对并连接当前对话”。JSON 中的项目会自动登记并选中，无需再手工选择。已有配对时选择项目并点“连接当前对话”。在本机确认窗核对 workspace 与完整 URL，确认后自动 commit/bind；不需要第二次点击或发送 route 验证消息。空白首页没有具体对话地址时先建立对话。

`bridge_permission_missing` 表示缺少显式 Bridge origin 权限；Pair 不会代为授权。`PENDING` 表示等待本机确认；`LOCAL_ROUTE_CANCELLED` / `LOCAL_ROUTE_EXPIRED` 表示取消或过期。弹窗每 1.5 秒查询状态，最长约 90 秒后保留待确认说明；关闭弹窗停止等待，可稍后“刷新状态”查询原申请。网络超时不表示操作失败或允许重试，查询原 requestId 并按 Bridge 状态完成提交/绑定，不自动发起新 requestId 或重新配对；DOM 发送只观察、不重复写入/点击。

连接成功不代表旧回流已被观察。`claimed` / `outcome_unknown` 只观察已有正文与 ATTEMPT，不重复写入或点击；自动回流开关仍保留用户选择。浏览器重启后缺少原 tab/document 关联时，显式连接已验证的相同目标恢复关联；不能通过清空记录、改 ID 或重新配对绕过未知结果。

旧 Bridge 不支持本机确认接口时应升级兼容运行时，不静默退回验证消息。build 不等于安装，安装不等于当前 Bridge 已升级或扩展已重载；机器部署和真实网页验证需另外授权。详见[轻量 Companion](companion-lightweight.md)。

### 任务面板显示“无法确认”

分别检查 Codex 绑定与网页状态。Codex 重启后保存的 runtime fence 可能失效，`desktop status` 返回 `DESKTOP_PROCESS_CHANGED`；同目标仍 enabled 时，仅重复 `bind-current` 也会拒绝，不能刷新旧 fence。用户明确授权恢复且无未决投递时，通过已安装稳定 launcher 执行 `desktop disable -w <workspace>`，再在目标 Desktop 会话执行 `desktop bind-current -w <workspace>`，由用户本人核对并点击本机确认窗；同目标保留 bindingId 与投递历史。之后只读复核 status，不能手改 fence、换 ID 或自动重发。`runtimeStatus:active` 可证明身份检查可用，实际发送仍要求 idle。

扩展更新或 Reload 后，刷新实际 ChatGPT 对话页以加载当前 content script，无需重新配对；再查看页面连接、输入框和生成状态。若扩展重启后缺少原 tab/document 关联，按上文显式连接相同已验证目标。面板“可接收结果”只是当前接收条件，不证明已完成 DOM Send 或 observed/ACK；浏览器版本无法直接核验时应保留该验收缺口。

### 历史诊断：已连接，但旧扩展徽标显示 C×（2026-10-13 源码退役）

旧徽标、popup 文案和 `C×` 展示规则仅供历史理解，现役轻量流程见上方“日常连接与本机确认”。当前代码不再提供这组徽标诊断；`OUTCOME_UNKNOWN` 仍不能通过清除日志或重复发送消除。

### 唯一发送标记存在，但回流仍未确认

默认轻量链只观察原 attempt，精确匹配失败不 ACK、不重发。旧高级诊断的 `recoveryDiagnostic`、`richBody*` 与 `richBodyReasonCode` 字段已随 2026-10-13 源码退役；它们不再是可查询的恢复接口。当前仍以 Bridge 保存的目标身份、精确正文观察和 `OUTCOME_UNKNOWN` 门禁为准。


### 清空任务面板的历史显示

点击“清空历史显示”仅在扩展本地保存当前 workspace 的终态 commandId；任务面板按该偏好过滤，轻量 popup 只提供面板链接；可点“恢复已隐藏历史”撤销。新任务、执行中或执行不明任务仍显示，已隐藏任务重新活动也会显示。排队/待确认回流、发送 journal 与结果不明隔离提醒独立保留；隐藏不代表 ACK、不取消发送、不删除后台防重放或 unknown 证据，也不改变自动回流开关。设置读取失败或损坏时显示全部，保存失败时明确报错。仅刷新页面不会写入显示偏好。

### 任务面板 Codex 端显示 inspect_failed

先分别只读核对稳定入口 `desktop status` 与 `executor status` 的 workspace、thread/session、binding 和可用性。generic Executor 仍指旧 thread 时，网页回流连接成功也不会使旧目标可用。仅在用户已授权且真实当前会话与目标精确一致后，走既有 `executor bind-current` 流程；不要手写绑定或把无法确认显示成空闲。正在执行本轮任务显示 busy 是正常状态。

### 普通权限无法停止管理员 Bridge

Windows 普通权限对管理员进程执行 PID 存活探测可能得到 `unknown`。当 `/health` 的
workspace、PID、startedAt 与保存的 runtime 精确一致时，CLI 会使用保存的 loopback
admin token 请求 `/admin/info`，再次核对 workspaceRoot、端口、runtimeBuildId 和身份，
并复查 health 后才允许现有认证 `/admin/shutdown`。认证失败、字段缺失或任一身份变化
仍保持 unknown；不会按 PID kill、猜测端口或跨 workspace 操作。此流程只管理 Bridge
生命周期，不放宽 Desktop IPC 的 `DESKTOP_ELEVATED`，因此正常启动应使用普通权限终端。

### 历史 Desktop delivery 阻塞 rollout

Core rollout 始终检查当前 binding 的实时 idle/approval 状态。历史 accepted delivery
存在本机严格 execution JSONL 中唯一的 Desktop receipt（exact commandId、
`taskId=desktop_<commandId>`、iteration 1、stored-only `desktopReceiptSha256`），或严格重验通过的
reconciliation / 显式 abandonment 时跳过对应旧 thread inspect。retired 仍按其证据类型实时检查。
普通 `c2c record` 不构成完成证明，仍回退到 live inspect；损坏或重复记录 fail-closed。
同一旧 thread 仍有未解决 accepted 时仍需 inspect，无法确认则 `desktop_unknown`。
failed/blocked receipt 只证明该 delivery 已有终态，不表示测试通过；不会改写历史或自动补记。

receipt 机制上线前的旧 accepted delivery 如果旧 thread 已无法安全 inspect，可先人工确认其
`commandId`，再显式运行 `c2c desktop legacy-reconcile -w <workspace> --command-id <id> --json`。
它只核对缺失 `intent` 的历史 delivery，并要求唯一终态 execution record、对应 output index
元数据和晚于 accepted 时间的本机事实；证据写入独立本机存储，失败、冲突或损坏时不覆盖既有证据。
含 `intent` 的当前/未来 delivery、普通 `c2c record`、缺 output 仍不能通过；raw
`outcome_unknown` 仍不能冒充完成，只有独立的 `resolve-unknown` 行政证据才能让 workflow/rollout
停止等待，且不会生成 receipt 或成功结论。

### "Bridge 未运行"
`c2c start -w <workspace>` (or let doctor do it). Bridge logs:
`c2c logs -w <workspace>`, or verbose: `c2c logs -w <workspace> --verbose`.

If doctor says the bridge state is **uncertain** (无法确认), do not start a
second bridge and do not Delete the ChatGPT connector. Wait and run doctor
again. The local process may still be running.

### Everything was quit and ChatGPT can no longer connect
Closing a terminal does not necessarily stop the detached Bridge. Check the actual runtime first.
If a quick tunnel did stop, the next repairing `c2c doctor -w <workspace>` may create a new address and set
`chatgptRepair.needed`. The Skill should tell the
user that the old address expired, then **Delete** THIS workspace's
connector (`chatgptRepair.connectorName`) and create it again with the new
address (never click Reconnect — the old URL is dead). Other workspaces keep
their own connectors so two projects can stay connected at once.

Fixed ChatGPT pages for first-time setup and later repair (do not hunt the UI):

- Developer mode: https://chatgpt.com/#settings/Security
- Plugins hub (manage existing connectors): https://chatgpt.com/plugins
- Add a connector:
  https://chatgpt.com/plugins#settings/Connectors?create-connector=true&redirectAfter=%2Fplugins

### Tunnel URL unreachable / ChatGPT says the connector is broken
Same as above: `c2c doctor -w <workspace>`, then Delete + recreate THIS workspace's
connector if `chatgptRepair.needed`. Fresh pairing code: `c2c pair -w <workspace>`.
If this workspace uses a stable hostname, doctor sets `namedRepair` instead —
re-login to Cloudflare (`c2c tunnel login`) and run `c2c doctor -w <workspace>` again. Do not Delete
the connector; the address did not change.

### Connector was rebuilt, but the old chat says "tool has been disabled"

Do not rebuild the Connector again. After local authorization and the current contract are verified,
Activation uses Conversation Rebind: create a chat inside the saved Project, send boot and any necessary
HANDOFF, and verify `workspace_info` plus current Desktop schemas through the exact connector name.
Only a verified replacement chat updates `session.url`; Project, instructions, checkpoint and task remain.
Legacy long-chat uses the existing switch-chat/HANDOFF flow. Failure stops without claiming Ready.
See [migration and rebind](desktop-control.md).

### I have a Cloudflare domain and want a stable hostname
During first-time setup (or the next coding session, once), say you have a
Cloudflare account and give the domain. Codex opens a browser for Cloudflare
login, then keeps `c2c-<project>.your-domain.com`. To stay on the temporary
address, say you do not have a domain. Switching later: tell Codex you want
the stable hostname; it runs `c2c tunnel choose -w <workspace> --mode named --zone <domain>`.

### "配对码无效/过期"
Pairing codes are one-time and expire after ~5 minutes:

```
c2c pair -w <workspace>
```

generates a fresh one (older codes become invalid immediately).

### ChatGPT gets 401 on every tool call
The access token expired and refresh failed (e.g. after `c2c unpair -w <workspace>` or a
long offline period). Delete THIS workspace's connector if the address also
changed; otherwise run Authorize again in ChatGPT and enter a fresh pairing
code. Never use Reconnect when the public address has been replaced.

### cloudflared is not installed
macOS: `brew install cloudflared`
Windows: `winget install Cloudflare.cloudflared`
Linux: see Cloudflare's package instructions.
The Skill installs this automatically during setup.
If cloudflared is installed in a custom location that is not on `PATH`, set
`C2C_CLOUDFLARED_PATH` to the executable's absolute path before running `c2c`.

### Every new Codex chat “repairs” the connection / cannot write logs
The C2C state directory lives outside the project (macOS:
`~/Library/Application Support/codex-with-chatgpt`; Windows:
`%LOCALAPPDATA%\codex-with-chatgpt`). Codex's default sandbox cannot write
there, so each new chat looks like a health-check failure.

`c2c setup -w <workspace>`, `c2c doctor -w <workspace>` and `c2c sandbox-allow` add that directory to
`[sandbox_workspace_write].writable_roots` in `~/.codex/config.toml`
(`%USERPROFILE%\.codex\config.toml` on Windows). After that, later chats
do not need elevation.

### Port already in use
An existing healthy Bridge is reused only when its workspace and runtime identity
match. If an old runtime points at a port now used by another workspace, recovery
is allowed only when the saved PID is gone, or the same PID has a provably newer
`startedAt`. Legacy health responses without identity fields require a dead saved
PID for stale recovery. A live legacy Bridge can instead be verified only when
health names this workspace and authenticated `/admin/info`, using its saved
admin token, exactly matches the saved service, workspace ID, PID and start time.
Missing fields, failed authentication or identity mismatches remain `unknown`.
Restart requires successful authenticated shutdown and waits for the old runtime
to exit before starting the replacement; it does not claim success by reusing it.
Recovery starts this workspace on an available port and replaces only its runtime
metadata, preserving authorization, tunnel, session, Project and task state.
Stopping uses verified identity and authenticated shutdown; it never kills an
unverified saved PID or shuts down the other workspace.

### Reading a file returns ACCESS_DENIED_SENSITIVE_FILE
Working as intended: `.env`, keys, credentials and anything matched by
`.c2cignore` are never readable through ChatGPT. `.env.example` is allowed.

### I cannot see Projects in the ChatGPT sidebar
Hover **Chats** /「聊天」, click the … that appears, and choose
**Organize by project** /「按项目整理」. Then create a project named after
this workspace, with **project-only memory**. Tell Codex「好了」when the
collection page is open (`https://chatgpt.com/g/g-p-…/project`).

### This workspace opened the wrong ChatGPT Project
Do not pick another project by name automatically. Open the collection that
matches this workspace and tell Codex「已找到」, or say you want the old
long-chat instead. Each workspace has its own Project and its own connector.

### Completely stuck

Inspect `c2c status -w <workspace> --json` and `c2c doctor -w <workspace> --no-fix --json` first. When repair is intended,
`c2c doctor -w <workspace>` can restore eligible local components; `c2c setup -w <workspace>` ensures Bridge/tunnel availability
and generates a fresh pairing code, reusing saved state. Neither is a request to erase
authorization, Connector, session or Project. Unknown identity and active-task upgrade gates
still apply; do not use stop/setup as an automatic reset of a live Review workspace.
