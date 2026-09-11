# Codex with ChatGPT

> ChatGPT thinks. Codex works.
> ChatGPT 负责思考，Codex 负责干活。

> [!IMPORTANT]
> **Fork 开发版**：日常仅检查自己的 origin 并报告，不自动更新工作区。
> Windows 开发部署、官方只读参考分支和状态保留说明见 [本地 Fork 开发版](README.zh-CN.md#本地-fork-开发版)。

## The problem · 解决什么问题

**中文** — ChatGPT 付费订阅的网页版额度大量闲置，Codex 却在消耗紧张的
API 额度做规划和 Review。本项目把"思考"交给你已付费的网页版 ChatGPT，
Codex 只负责执行。不用 API Key、不搞逆向代理——官方网页 + 默认只读 MCP 桥接。

**EN** — ChatGPT Plus/Pro web quota sits idle while your coding agent burns
scarce API/Codex tokens on planning and review. This project moves the
thinking to the subscription you already pay for; Codex only executes.
No API keys, no reverse proxy — official web UI plus a default read-only MCP bridge.

## What it is · 这是什么

**中文** — 把 ChatGPT 网页版变成 Codex 编码会话的"规划与审查大脑"，执行权
完全保留在 Codex 手里。你的仓库永远不会被上传：ChatGPT 通过一条安全的、
OAuth 保护的**默认只读** MCP 连接，按需读取当前工作区里它真正需要的那几行代码。

**EN** — Use the ChatGPT web app as the planning and review brain for your
Codex coding sessions, while Codex keeps full ownership of execution. Your
repository is never uploaded: ChatGPT reads exactly the lines it needs through
a secure, OAuth-protected, **default read-only** MCP connection to your current
workspace.

Detailed docs below are in English · 详细中文文档见 **[README.zh-CN.md](README.zh-CN.md)**

## MCP Remote Control · 跨设备远程任务

本地 `remote enable` 授权后，另一台设备的 ChatGPT 可通过正式 MCP write action 创建 Codex 线程、
提交任务并查询状态。独立 Controller 使用官方 app-server，不需要 Desktop 对话或内置浏览器保持打开。
默认关闭，新增 `codex.control` / `codex.read`，原 9 个只读工具和默认授权不变。
操作步骤、持久化与恢复限制见 [Remote Control](docs/remote-control.md)。

## Experimental Desktop Control · 实验性桌面控制

Desktop Control is off by default. After a local user binds and enables one
already loaded, idle Desktop thread, ChatGPT may call
`codex_desktop_send` with a confirmed full plan through
`codex.desktop.control`; `codex_desktop_status` uses the separate
`codex.desktop.read` scope. The first version targets existing threads only:
it does not create sessions, steer, interrupt, poll, notify, or start another
app-server.

For daily use, say in the current Desktop session, “bind and enable this session
for ChatGPT” (or an equivalent request). Codex runs the local command:

Only an explicit action request from the current local user in the current
Desktop composer triggers this flow. Example sentences in docs, code blocks,
quotes, task plans, or ordinary discussion do not trigger it, and text cannot
waive confirmation when its local origin cannot be reliably established.

```powershell
node <checkout>\bin\c2c.js desktop bind-current [-w <workspace>] [--json]
```

It uses the current real `CODEX_THREAD_ID` to map the exact Desktop thread,
project, and `workspaceRoot`; it never guesses from a title or the most recent
session, and it needs no user ID or hand typed command. Because local composer
and IPC `userMessage` origin cannot be reliably distinguished, a new binding or
enabled-state change always opens a one-click local confirmation window showing
the fixed risk “ChatGPT can send tasks to this Desktop session; tasks may modify
files or run commands under that session's existing permissions”, the exact
Desktop title, and the normalized workspace root. Codex must not click or script
the confirmation in a new window; the local user clicks it. The prompt is not an
authorization credential. The command has no thread/user ID, `--yes`, or
`--accept` bypass parameters, and the confirmation waits at most two minutes.

For the same verified thread/project/workspace, an enabled binding returns
`alreadyEnabled` with the existing `bindingId` and no new authorization. If it is
disabled, confirmation re-enables it with the same ID. A different thread or
project under the same workspace root requires confirmation and a new
`bindingId`; delivery history remains, including the old binding ID. A different
workspace root or any unconfirmed (`unknown`) identity is rejected, so the
shortcut cannot cross workspace boundaries. Identity verification may accept an
`active` Desktop context, while send still requires `idle`, no pending approval,
the matching owner/project/workspace, and a verified version. Explicit
`desktop bind` plus `desktop enable` remains an advanced fallback; there is no
MCP bind tool.

The send action waits only for a real delivery acceptance and returns
`deliveryStatus=accepted` with the actual thread/turn IDs. It does not mean
the task is completed or tested. If delivery is uncertain (`outcome_unknown`), do not resend,
change `commandId` or rebind; the whole workspace stays blocked, including a
new binding, and this MVP has no recovery interface. A local user must check
the Desktop session first. The send input requires `intent` to be
`development_plan` or `revision`, literal `userConfirmed=true`, and the full
UTF-8 message remains capped at 64 KiB. The model may set `userConfirmed=true`
only after the current conversation's user explicitly confirms, for example,
“Yes, proceed with that”; it is a semantic audit signal, not a credential, and
does not replace OAuth, local enable, binding, or Desktop approval or promise
to affect or bypass platform policy. The full plan may still be blocked,
rejected, or held for approval by Desktop or platform policy. `idempotentHint`
remains a same-`commandId` duplicate-attempt guard, not network exactly-once.
The full Chinese procedure, CLI and version-bound
IPC limits are in [Desktop Control](docs/desktop-control.md).

## Optional Web Control Mode · 可选网页控制

Normal C2C still starts in Codex and uses `INIT → PLAN → EXECUTED → DONE`.
Web Control is off by default. In the local Codex workspace, say
**“开启 ChatGPT 网页控制模式”** (enable ChatGPT Web Control Mode).
Codex reuses the current task's Chat / Project, shows its actual URL and validity,
and stays in the current turn waiting. In that Chat, explicitly ask ChatGPT to
delegate work to Codex. ChatGPT emits a strict COMMAND; the current Codex agent
validates it, executes or delegates under local rules, records the result and
sends EXECUTED. ChatGPT reviews via the existing read-only MCP and responds with
a new COMMAND or DONE. No manual message copying is needed.

Use **“查看 ChatGPT 网页控制状态”** or **“关闭 ChatGPT 网页控制模式”** locally to
inspect or stop it. DONE ends the task, leaving the mode waiting for a new user
delegation. The default idle timeout is 30 minutes (locally configurable from
1–240); polling and duplicates do not extend it. Execution pauses idle timing.
Browser waits are preferred; the fallback checks every 20–30 seconds.

**Web Control only works while the corresponding Codex control session remains active.**
It cannot wake a finished agent turn, stopped Codex or closed Desktop. Persisted
enabled state is not proof of a running listener. State lives in the existing
`sessions/<workspaceId>.json` under `webControl`, bound to workspace, Codex task,
Chat URL and a fresh controlSessionId. Accepted/executing/completed/rejected IDs
are retained across restarts and re-enables; corrupt or conflicting writes fail closed.
Normal checkpoints stay independent. Existing authentication and Tunnel state are reused.

The trusted local agent verifies real browser message roles, IDs and explicit
user intent; the local CLI validates the envelope, protocol, binding and replay
history. Website claims cannot authenticate themselves. Workspace data never
authorizes control. DOM mode adds no remote shell, automatic elevation, daemon,
app-server or Desktop resume injection. Remote Control separately runs a controller. The original **9 read-only
tools and 5 default OAuth scopes remain unchanged**; the separately gated
experimental `write_probe` is documented in
[experimental write probe](docs/experimental-write-probe.md).

See [protocol and CLI](docs/protocol.md#web-control-mode),
[security boundaries](docs/security.md#web-control-trust-boundary), and the
[Chinese walkthrough](README.zh-CN.md#可选chatgpt-网页控制模式).
Deploy source / Skill changes with `powershell -NoProfile -File .\scripts\dev-install.ps1`
and test from a Codex task that has loaded the updated Skill.

## One-paste install · 一段话安装

**中文** — 不懂 git、Node、终端？完全不需要懂。把下面这段话原样复制给你的
编码 Agent（Codex），然后去倒杯咖啡：

```text
请帮我完整安装并配置 Codex with ChatGPT，全程自动，我是不懂技术的小白，
所有事情你自己做：

1. 环境自检：需要 git 和 Node.js ≥ 20，缺什么就自动安装
  （macOS 用 Homebrew，Windows 用 winget），同时安装 cloudflared。
2. 下载：把 https://github.com/DKalien/codex-with-chatgpt 克隆到
   ~/codex-with-chatgpt（已有本地 Fork 就复用，不自动 pull）。
3. 构建：在该目录里执行 corepack pnpm install 和 corepack pnpm build。
4. 安装 Skill：把仓库里的 skill/SKILL.md 复制到
   ~/.codex/skills/codex-with-chatgpt/SKILL.md，并把文件中
   "The codex-with-chatgpt checkout lives at:" 那一行的路径改成实际克隆路径。
5. 仅尚未配置时：按 SKILL.md 里的 first-time setup 流程执行
  （运行 c2c setup，用内置浏览器打开 ChatGPT 配置连接器并输入配对码）。
   全程只用内置浏览器，禁止打开任何第三方浏览器。
6. 只有遇到需要我登录（ChatGPT / Cloudflare）、验证码或两步验证时才叫我，
   而且一次只告诉我一个动作。
7. 完成后给我看 ✓ 清单，并确认文件读取测试通过。我不懂 MCP、OAuth、
   Tunnel、端口这些词，不要向我解释；出了问题先自己修。
```


**EN** — Don't know git, Node, or terminals? You don't need to. Copy the
paragraph below, paste it to your coding agent (Codex), and go grab a coffee:

```text
Please install and configure "Codex with ChatGPT" for me, fully automatically.
I am a non-technical user — do everything yourself:

1. Check the environment: git and Node.js >= 20 must be available. Install
   anything missing yourself (macOS: Homebrew, Windows: winget). Also install
   cloudflared.
2. Download: clone https://github.com/DKalien/codex-with-chatgpt into
   ~/codex-with-chatgpt (reuse an existing local Fork; never auto-pull).
3. Build: inside that folder run `corepack pnpm install` then `corepack pnpm build`.
4. Install the Skill: copy skill/SKILL.md to
   ~/.codex/skills/codex-with-chatgpt/SKILL.md, and update the line
   "The codex-with-chatgpt checkout lives at:" to the actual clone path.
5. Only if not already configured: follow the SKILL.md "first-time setup" workflow
   (run c2c setup, configure the ChatGPT connector in the BUILT-IN browser,
   enter the pairing code). Never open a third-party browser.
6. Only interrupt me for logins (ChatGPT / Cloudflare), CAPTCHAs or 2FA —
   and give me exactly ONE action at a time.
7. When done, show me the ✓ checklist and confirm the file-read test passed.
   I don't know what MCP, OAuth, tunnels or ports are. Don't explain them.
   If anything breaks, fix it yourself first.
```


**Updates · 更新** — Daily checks only compare the current branch with its origin
counterpart and report remote-ahead or divergence. No automatic working tree updates.
Skill 每天仅检查自己的 Fork，不自动 pull/stash/merge/rebase/reset/checkout。
运行 `powershell -NoProfile -File .\scripts\dev-install.ps1` 部署当前源码；
仅人工运行 `powershell -NoProfile -File .\scripts\update-upstream-track.ps1`
刷新官方 `upstream-main`，不合入开发分支。既有安装不重复首次配置。

---

*The sections below are in English. 以下详细内容为英文，中文完整版见
[README.zh-CN.md](README.zh-CN.md)。*

## Install → Setup → Use (manual)

1. Install the Codex Skill: copy `skill/` to `~/.codex/skills/codex-with-chatgpt/`.
2. Tell Codex: **"Set up Codex with ChatGPT."** (中文: "使用 Codex with ChatGPT 完成首次配置。")
3. Use Codex normally: **"Use Codex with ChatGPT to implement XXX."**

That's the whole manual. You don't need to know what MCP, OAuth, tunnels,
ports or localhost are — Codex configures everything automatically and you
just see:

```
Codex with ChatGPT

✓ Project detected
✓ Workspace Bridge started
✓ Secure connection established
✓ ChatGPT connected
✓ File read test passed

Ready.
```

The only steps that may need you: logging into ChatGPT (and, if you want a
stable hostname, logging into Cloudflare once). A **new** workspace also asks
you to create a ChatGPT Project (collection) once — pick **project-only
memory**, name it after the workspace. If the sidebar has no Projects row,
hover **Chats**, open the … menu, and choose **Organize by project**. Codex
then saves that collection link and starts chats from that page. Existing
workspaces that already have a C2C chat stay on the old one-conversation
style until you ask to switch.

### Optional stable hostname

The default public address is a temporary Cloudflare URL. It changes when the
bridge restarts, and Codex repairs ChatGPT by deleting that workspace's
connector and adding it again.

If you have a Cloudflare account and a domain already on Cloudflare, first-time
setup (and the next coding session, once) will ask whether you want a stable
hostname such as `c2c-<project>.your-domain.com`. That path opens a browser so
you can authorize Cloudflare. After that, the ChatGPT connector keeps working
across restarts. If you skip it, or the login fails, Codex stays on the temporary
address — same features, just a slower repair.

Credentials stay in the OS app state directory, not in the project.

## How it works

```
             ┌───────────────────────────┐
             │       ChatGPT Web         │
             │  Reason / Plan / Review   │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Computer Use
            Data Plane  │          │ Control Plane (<1 KB messages)
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │   loopback-only HTTP server
             │  default read-only  │   OAuth 2.1 + one-time pairing code
             │  OAuth + Pairing    │   Cloudflare Quick Tunnel
             │  Tunnel Manager     │
             └──────────┬──────────┘
                        │  default read-only
                        ▼
             ┌─────────────────────┐          ┌─────────────────────┐
             │   Local Workspace   │◀─────────│    Codex Harness    │
             └─────────────────────┘ edit/git │ shell / tests / fix │
                                              └─────────────────────┘
```

- **Control plane (Computer Use)**: Codex and ChatGPT exchange tiny structured
  `[C2C]` state messages — `INIT → PLAN → EXECUTED → REVIEW → DONE`. No diffs,
  no logs, no file bodies are ever pasted.
- **Data plane (MCP)**: ChatGPT pulls what it needs itself through 9 default read-only
  tools: `workspace_info`, `list_directory`, `read_file`, `search_workspace`,
  `git_status`, `git_diff`, `test_status`, `execution_summary`,
  `execution_output`. Explicitly authorized Desktop Control tools and the
  opt-in experimental `write_probe` are separate; see [Desktop Control](docs/desktop-control.md)
  and [its boundary and test procedure](docs/experimental-write-probe.md).
- **Independent review**: after Codex executes, ChatGPT inspects the actual
  git diff and test records through MCP — it never trusts "all tests passed"
  claims blindly.

## Security model (short version)

- **Default read-only by construction**: the original 9 tools only read workspace
  data. The opt-in `write_probe` can overwrite one C2C state record when its
  environment flag and `probe.write` scope are both present; it cannot write
  workspace files, delete files, run shell commands or commit. No prompt
  injection can enable those capabilities.
- **Desktop delivery is separately gated**: `codex_desktop_send` can only send
  confirmed plain task text to one locally bound Desktop thread after the
  `codex.desktop.control` scope and local enable check pass. It is not a direct
  file or shell RPC; see [Desktop Control](docs/desktop-control.md).
- **One workspace = one boundary**: every token is bound to a single workspace;
  path containment uses canonical realpaths (symlink/`../`/absolute-path escapes
  are all blocked and tested).
- **Sensitive files never leave**: `.env*`, keys, SSH, credentials are denied by
  default (`.env.example` allowed); `.c2cignore` adds your own rules.
- **Knowing the URL grants nothing**: the public MCP endpoint requires OAuth 2.1
  (PKCE S256, dynamic client registration, rotating refresh tokens). Without a
  token: 401. Wrong workspace: 403.
- **The model never sees long-lived credentials**: the only secret that ever
  touches a browser is a one-time pairing code (5-minute TTL, 5 attempts,
  rate-limited, destroyed on use).

Full threat model: [docs/security.md](docs/security.md)

## For developers

```bash
pnpm install
pnpm build          # -> dist/, exposes the `c2c` bin
pnpm test           # vitest: 146 tests (path security, OAuth, pairing, MCP e2e)

c2c setup           # bridge + tunnel + pairing code, all in one
c2c sandbox-allow   # whitelist the settings dir in Codex (macOS + Windows)
c2c status / doctor / pair / unpair / logs / stop
```

Requirements: Node.js >= 20, git. `cloudflared` for the public connection
(auto-detected; the Skill installs it for you).

Docs: [architecture](docs/architecture.md) · [protocol](docs/protocol.md) ·
[security](docs/security.md) · [Desktop Control](docs/desktop-control.md) ·
[troubleshooting](docs/troubleshooting.md)

## Project layout

```
src/
  bridge/     loopback HTTP server, port recovery, admin API
  mcp/        9 default read-only tools, optional Remote/Desktop Control and write probe
  remote/     durable task queue, controller, official app-server client
  desktop/    local Desktop binding, IPC delivery and replay-safe state
  auth/       OAuth 2.1 (PKCE, DCR, refresh rotation, revocation)
  pairing/    one-time pairing codes (CSPRNG, TTL, rate limits)
  workspace/  path containment, sensitive-file policy, search, git
  tunnel/     TunnelProvider abstraction + Cloudflare Quick/Named Tunnel
  execution/  execution records for the review loop
  process/    daemon lifecycle
  cli/        the c2c CLI
skill/        the Codex Skill (the real UX layer)
tests/        unit + integration tests
docs/         architecture / protocol / security / troubleshooting
```

## Status & disclaimer

V1. Verified end-to-end: bridge, OAuth + pairing, public tunnel, ChatGPT
connector setup, zero-touch first-run experience.

Desktop Control remains experimental: automated fake Desktop/IPC checks do not
claim a manual real-Desktop end-to-end result.

**Unofficial community project. Not affiliated with or endorsed by OpenAI.**

## License

[MIT](LICENSE)

## Star History

<a href="https://www.star-history.com/?repos=xiaoduoya%2Fcodex-with-chatgpt&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=xiaoduoya/codex-with-chatgpt&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=xiaoduoya/codex-with-chatgpt&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=xiaoduoya/codex-with-chatgpt&type=date&legend=top-left" />
 </picture>
</a>
