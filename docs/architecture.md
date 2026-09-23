# Architecture

```
             ┌───────────────────────────┐
             │    ChatGPT Web / Sol      │
             │  Reason / Plan / Review   │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Computer Use
            Data Plane  │          │ Control Plane
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │
             │  MCP (RO + gated)   │
             │  OAuth AS + PRM     │
             │  Pairing Manager    │
             │  Tunnel Manager     │
             │  Admin API (local)  │
             └──────────┬──────────┘
                        │  read-only
                        ▼
             ┌─────────────────────┐
             │   Local Workspace   │
             └──────────▲──────────┘
                        │ edit / shell / git / test
             ┌──────────┴──────────┐
             │  Codex Harness      │
             └─────────────────────┘
```

## Principles

- **ChatGPT thinks. Codex works.** The bridge never re-implements a coding harness.
- **Computer Use = control plane**: tiny `[C2C]` state messages (< 1 KB).
- **MCP = data plane**: ChatGPT pulls files/diffs/search results itself.
- **Read-only by default**: the 9 base tools remain read-only. Desktop Control is a separately
  authorized plain-text delivery path to one existing Desktop thread; it is not a workspace
  write, shell or arbitrary RPC tool.
- **Workspace is the security boundary**: one bridge = one workspace = one token audience.

## Components (src/)

| Module | Responsibility |
| --- | --- |
| `bridge/` | Express app assembly, loopback-only listener, port fallback, runtime state, admin API |
| `mcp/` | McpServer with workspace/git/search/session/pairing/feedback/workflow tools (base read-only set + separately guarded Desktop/Remote/feedback schemas); stateless Streamable HTTP transport (fresh server per request, JSON responses) |
| `desktop/` | Local Desktop binding, version-gated IPC delivery, replay-safe state and delivery status |
| `executor/` | Executor Core 的有限适配器契约、固定注册表及当前 Codex Desktop adapter |
| `auth/` | OAuth 2.1 authorization server: discovery metadata (RFC 8414 + Protected Resource Metadata), dynamic client registration (RFC 7591), authorization-code + PKCE (S256 only), refresh rotation, revocation (RFC 7009). Opaque tokens stored as SHA-256 hashes |
| `pairing/` | PairingCode lifecycle: CSPRNG generation, TTL, attempt limits, IP rate limit, one-time use |
| `workspace/` | Canonical-path containment (realpath of deepest existing ancestor), sensitive-file policy, `.c2cignore`, paginated read/list, ripgrep search with Node fallback, git status/diff with pagination |
| `tunnel/` | `TunnelProvider` interface + Cloudflare Quick and workspace-configured Named Tunnel implementations; business logic is vendor-agnostic |
| `execution/` | JSONL execution records plus optional sanitized command output (`execution_output`) |
| `feedback/` | Production feedback outbox + companion transport: pairing/credential, route-principal attestation (challenge → `feedback_companion_route_confirm` → VERIFIED), reserve/begin-send/ack/retire, stale → `outcome_unknown`, exact late-positive ACK |
| `browser-companion/` | MV3 sources → `dist/browser-companion`: SW-only Bridge HTTP + durable send journal + route-attestation fence; content_scripts use classic `*-global.js` (ESM `dom-adapter`/`turn-observer`/`route-attestation*` stay for SW import graph); autonomy default OFF; zero DOM/Send unless explicit production one-shot or armed heartbeat; production Send requires **route VERIFIED**；display-only toolbar indicator uses `C/C!/C×`，低频 `alarms` 只做 `/state` discovery |
| `process/` | Daemon spawn/reuse, health probing, graceful shutdown |
| `core/` | Verified machine install metadata, guarded rollout and per-workspace pending upgrades |
| `cli/` | `c2c` commands; `--json` everywhere for the Skill |
| `config/`, `logger/` | OS-convention state dir, secret-redacting logger |

## Executor Core（H0）

执行链保持清晰分层：ChatGPT 负责规划与 Review → C2C Bridge 负责 executor-agnostic 控制平面 →
本地 executor adapter 负责连接与投递 → 隔离的 workspace。`src/executor/` 只抽取当前 Desktop
控制服务已经需要的绑定、身份确认、准备/发送连接和 active 检查，不复制 IPC、状态存储或回执终结器。

- 当前生产 adapter 是 `codex-desktop`（Codex Desktop）；现有 helper 的版本、hash、owner、project、workspace、审批、busy、单次发送和回执门禁仍是唯一权威。
- Claude Code 是计划中的第一个额外 adapter；H0 只留下扩展接缝，不实现该集成。
- Mimo Desktop 依赖稳定的本机机器接口；仅 GUI 自动化属于较低信任路径，不能自动继承 Codex 的 trusted receipt 语义。
- capability metadata 仅供规划/UI 描述，不能授予权限；注册表固定且拒绝未知 executor，不做插件自动发现、PATH/网络探测或动态加载。
- Browser Companion 与 feedback transport 保持 executor-independent；H0 不新增 generic MCP executor 工具，也不引入第二个 executor。

## Executor E1a — Claude runner contract（2026-09-23）

command83 的本机只读审计确认 Claude Code `2.1.220` 已安装；本地帮助提供非交互
`--print`、显式 `--session-id`、`--resume/--continue/--fork-session`、JSON/stream-JSON
输出和权限模式线索，但尚未证明 C2C command binding、审批事件观察、取消语义或可信终端回执。
MiMo Desktop 仍只有 GUI/Browser Bridge 线索，没有稳定 coding-task 机器接口。

- E1a 只提供 `src/executor/claude/` 的本地 invocation builder、固定 JSON parser、受限
  child-process seam 和 fake-runner 测试；不启动真实 Claude，不把 Claude 加入生产 registry，
  不新增 generic MCP executor 工具，也不改变 Codex Desktop 状态或工具。
- builder 只接受调用方提供的绝对 executable identity（路径/version/可选 hash），生成
  `shell:false` argv，保留 commandId 与生成或校验的 Claude sessionId 本地 correlation；若输出带有
  `command_id` 才执行 mismatch guard，尚未证明跨进程的 C2C command binding。workspaceRoot/cwd 只有
  本地绝对路径与词法 containment 校验，不替代 Bridge 的 canonical workspace security boundary，
  并拒绝绕过审批的 permission mode。candidate capability 只描述观察到的 CLI/实验合同事实。
- terminal result 只保留有界输出的 bytes/hash/truncated/restricted metadata；malformed、身份不匹配、
  `is_error=true`、非零退出、超时、取消、输出超限或进程终态不明均 fail closed，不能宣称 trustedTerminalReceipt。
  AbortSignal 只传给 C2C-owned child；不声称 Claude-native interrupt、descendant cleanup 或 orphan
  证明，也不引入 retry/fallback。
- 下一 gate 是受控、只读的真实 Claude smoke，核对实际 JSON/session/exit 语义；之后还需独立定义
  approval、cancellation 和 receipt evidence 合同，才可评估生产 adapter。Claude 不得自动 fallback
  到 Codex，MiMo 仍是等待稳定任务 API 的低信任候选。

## Request lifecycles

**MCP call**: ChatGPT → tunnel (https) → bridge `/mcp` → bearer middleware
(401/403) → stateless StreamableHTTP transport → tool handler → workspace layer
(path containment → ignore rules → pagination) → JSON result.

**Desktop delivery**: ChatGPT → tunnel (https) → bridge `/mcp` → bearer middleware
and `codex.desktop.control` check → local enable/binding/workspace check → fresh
Desktop process/endpoint/owner/version check → controlled local IPC → bounded
acceptance receipt. The bridge records the delivery before the send attempt and
returns `accepted` only with the real Desktop thread/turn IDs; it never waits for
task completion or exposes raw IPC through the tunnel.

**Desktop execution evidence**: the internal task envelope routes the accepted Desktop turn to
the Skill's local receipt flow. Before its final reply, the verified exact active turn (or the
latest terminal turn with a complete newest history boundary while idle) records
the exact command ID and this turn's test/output evidence. Review resolves that record and its
output ID, never a historical latest test result. See [automatic receipts](desktop-control.md#自动验收记录).

**Production feedback companion**: ChatGPT MCP (trusted principal) enables receiver → one-time pairing → Edge MV3 companion holds scoped credential **only in SW** → **route attestation**: pair mints pending challenge; production `/reserve`/`begin-send` require authenticated `/state` `routeVerification=VERIFIED` via MCP `feedback_companion_route_confirm` (wrong principal does not consume the challenge). `feedback_bootstrap_status` is a bounded request-scoped readiness projection. After a CAS takeover, the predecessor credential remains invalid for all production APIs; it can only call `/rebind/init`, read exact `/rebind/status`, and call `/rebind/complete` for the immediate successor when no in-flight event exists. `Connect this Chat` binds identity through the content-script `MessageSender`, durable-persists autonomy `OFF`, then reuses the G3 one-shot runner/fence; a durable connect fence prevents attestation or completion replay across restart. Read-only status rechecks `reserved|claimed|outcome_unknown` before returning `CONFIRMED`; deterministic pre-mint repair/confirmation rejection rolls back to `ATTEST_REQUESTED`, while ambiguity remains `OUTCOME_UNKNOWN`. Rebind uses a persisted TTL/one-shot challenge and rotates to a fresh credential only after current-principal confirmation; the Browser Companion never receives an MCP principal. Pair/Rebind/Complete/Clear are serialized in SW. Browser durable fence + `PAIRING_TRANSITION` survive restart; non-NONE fence blocks resend until a successful re-pair or rebind writes matching identity. Named URL `/api/companion/v1` reserve/begin-send/ack/rebind. Journal is durable and single-flight; observation timeout becomes `outcome_unknown` (never auto-resend). Late-positive closeout requires exact identity: Companion `/ack` or trusted `feedback_ack_observed` (`claimed|outcome_unknown` + exact attempt → `observed`), SW clear from authenticated `/state` observed proof when `inFlight=null`, or exact message-body DOM observation (parent ATTEMPT + bounded descendant `innerText` equality). Route-attestation observer uses the same bounded descendant style but **challengeId** marker only (no ATTEMPT_ID). Optional autonomy scheduler defaults OFF: shadow is read-only; armed uses exact-owner heartbeat + journal-first recovery + durable cooldown. `retired_unknown` is a manual terminal that never ACKs or resurrects.

**Authorization**: 401 with `WWW-Authenticate: resource_metadata=…` →
`/.well-known/oauth-protected-resource/mcp` → AS metadata → DCR →
`/oauth/authorize` (HTML pairing page) → pairing code verified → 302 with
authorization code → `/oauth/token` (PKCE S256) → access + refresh tokens.

**Ports**: prefer 48765, bind 127.0.0.1 only. On conflict, `/health` identifies
the workspace, PID and Bridge start time. Matching runtime identities are reused;
provably stale records allow a new instance on an available port. Uncertain
identities block recovery and shutdown. Legacy health without process identity
requires matching authenticated `/admin/info` before reusing a live instance.
Configuration follows automatically via
the current workspace's runtime file; other workspace processes are untouched.

**Machine Core**：机器状态目录中的无依赖 Node launcher 严格读取 `current.json`，以相同 Node 和参数
执行 immutable `releases/<buildId>`。`checkoutRoot` 仅记录源码来源，修改或移动 checkout 不影响已安装代码。
新 pointer v3 用 `manifestSha256` 绑定 release manifest v2；manifest 保存 `runtimeBuildId`、完整
`artifactSha256` 与固定 bootstrap 文件的 SHA-256。launcher 显式使用 fast，逐次检查规范路径、
manifest 绑定、build-id 与 bootstrap 内容，不递归扫描完整 dist/node_modules，也不声称完整性全检。
`readCurrent`、`readCurrentInstall`、`getCurrentInstall` 默认 full；安装/publish、protect-current、
rollout 保留完整 dist buildId、release artifact 与依赖链接边界验证。普通 status 显式以 fast
读取 `runtimeUpgrade` 元数据；doctor 的文本与 JSON 输出均显式 full，并通过 `report.core`
报告完整性结果。两者的信任级别在 CLI 调用点指定，不全局切换默认值。
旧 pointer v2 / manifest v1 在新 helper 下 fallback full；旧 bootstrap 快照继续发布 v2。
安装先完整验证新 release，再更新 machine bin helper/launcher，最后原子切 pointer；
中间的新 helper 能读取旧 current，失败保留旧 pointer，已有 release/manifest 不覆盖。
v1 pointer 仍在 install/build 修改 checkout 前冻结到同一旧 build，失败停止安装。
machine bin 和 current pointer 是本机信任根，不是数字签名；fast/full 保证与本轮测量见
[长期开发计划](development-plan.md)。
The deterministic SHA-256 `dist/build-id.txt` hashes runtime artifacts including the Desktop helper and Core installer assets, excluding itself.
The build captures entrypoint/package/installer snapshots and a dependency-content digest. Installation copies these snapshots
and verifies dependency contents before and after copying; post-build edits cannot be published under the earlier build ID.
Each Bridge captures its own `runtimeBuildId` at startup; updating the pointer cannot make an old
process report the new build. Health/admin/runtime expose the ID without changing MCP schemas.

Local `rollout` shares the authenticated shutdown/wait/start-tunnel path with CLI restart. It checks
runtime and authenticated admin identity twice and only restarts healthy named tunnels with the
same workspace hostname/URL, no pairing, no Desktop activity/approval/unresolved outcome, and no
Remote queued/active/uncertain execution. Quick, busy and unknown instances are skipped; stopped
workspaces are never started. Minimal per-workspace pending metadata contains no credentials or
message content. `status/doctor` reads it through `runtimeUpgrade`. Successful rollout rechecks the
build, identity and fixed URL; it never changes Connector/OAuth/session/Project/checkpoint/binding.
Phase 1 has no resident Supervisor or polling loop. Workspace state remains strictly isolated.
Only the process holding the machine rollout lock can update pending state. Concurrent losers report
`rollout_busy` without changing runtime, pending or workspace files.

**Tunnel**: default is a Cloudflare Quick Tunnel (`cloudflared tunnel --url …`).
The URL changes per start, so `c2c doctor` can restart it and tell the Skill to
Delete + recreate that workspace's ChatGPT connector. A workspace may instead
choose a named hostname once (`c2c tunnel choose --mode named`). The Skill asks
before the first public URL exists; `cloudflared tunnel login` is the only extra
user step. Tunnel name, hostname and preference live under the OS state dir
(`tunnels/<workspaceId>.json`), never in the project. Named starts use
`cloudflared tunnel --url … run <name>` so the public URL stays stable. If named
provisioning fails, ordinary setup can fall back to Quick Tunnel. Legacy
Connector migration uses `--require-named`: it preserves the existing state on
failure and stops without rebuilding the Connector or reporting Ready. Its
final named URL must be healthy before Connector authorization. If a named tunnel later
drops, doctor asks for a Cloudflare re-login (`namedRepair`) instead of
rotating the ChatGPT connector.
