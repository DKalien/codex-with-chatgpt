# Codex with ChatGPT

[English](README.md) | **简体中文**

> ChatGPT 负责思考，Codex 负责干活。

## 跨设备 MCP Remote Control

第三阶段默认关闭。本地 `remote enable` 后，外部设备的 ChatGPT 可通过 `codex_create_thread`、
`codex_submit_task` 派发任务，再用 `codex_task_status`、`codex_thread_status` 查询。
独立 Controller 使用官方 app-server，无需 Desktop 对话、内置浏览器或当前 Agent turn。
正式权限是 `codex.control` / `codex.read`，write_probe 仍默认关闭。
首次使用、启停、状态位置和崩溃恢复见 [Remote Control 操作说明](docs/remote-control.md)。

## 实验性 Desktop Control（默认关闭）

Desktop Control 只在本机用户明确绑定并启用一个已经在 Desktop 中加载、当前空闲的已有
会话后可用。ChatGPT 讨论并确认完整方案后，通过 `codex_desktop_send` 投递到该会话，
使用独立的 `codex.desktop.control`；`codex_desktop_status` 使用独立的
`codex.desktop.read`。第一版不自动新建会话，不做 steer、interrupt、实时进度、推送通知
或网页持续轮询。

### 日常快捷绑定当前会话

用户在当前 Desktop 会话中说“把这个会话绑定并启用给 ChatGPT”（或同义表达）后，Codex
在本机运行：

只有当前本机用户明确提出这个动作才会触发；文档、代码块、引用、任务计划或普通讨论中的
示例句不会触发，来源无法可靠证明来自本机时也不能凭文字免除确认。

```powershell
node "<stable launcher>" desktop bind-current [-w <workspace>] [--json]
```

命令从当前真实 `CODEX_THREAD_ID` 精确映射 Desktop thread、project 和 workspaceRoot，
不按标题或最近会话猜测，不需要用户 ID，也不要求用户手打命令。由于本地 composer 与 IPC
`userMessage` 来源无法可靠区分，新增绑定或改变 enabled 状态前必须显示本机一键确认窗，
固定显示风险“ChatGPT 可以向此 Desktop 会话发送任务；任务可能按该会话已有权限修改文件或
执行命令”、当前 Desktop 标题和规范化 workspaceRoot。新窗口不得自动点击或脚本代点，必须
用户自己点击；触发流程的 prompt 不是授权凭证。命令不接受 thread/user ID、`--yes` 或
`--accept` 等绕过确认的参数，确认窗最多等待 2 分钟。

同一身份已 enabled 时，身份核验通过后返回 `alreadyEnabled`，复用原 `bindingId`，不生成
新 ID、不再次授权；同一身份 disabled 时，用户确认后 enable 并复用原 ID；同一 workspaceRoot
下不同 thread/project 经确认后生成新的 `bindingId`。所有 deliveries history 保留，其中含旧
`bindingId`；不同 workspaceRoot 或无法确认（`unknown`）时，明确阻断快捷 bind/enable/send，
不能换 ID 或重新绑定绕过。身份核验允许 Desktop 为 `active`，但 send 仍严格要求 `idle`、无
待审批、owner/project/workspace 匹配和已验证版本。传统显式 `desktop bind` + `desktop enable`
仍保留为高级 fallback；不新增 MCP bind 工具。

工具只等待真实的投递接受回执，返回 `deliveryStatus=accepted` 和真实 thread/turn ID；
这不代表任务已完成或测试已通过。回执不明（`outcome_unknown`）时不要重发、不要更换 `commandId` 或重新绑定，
整个 workspace（包括新绑定）会暂停后续投递；MVP 没有恢复接口，需本机用户先核对 Desktop。
用户随后说“干完了，检查一下”时，ChatGPT 才用现有只读
MCP 检查当次代码、Git 和 record；需要修订时仍发给同一绑定会话。

send 输入还要求 `intent` 必须为 `development_plan` 或 `revision`、`userConfirmed` 必须是字面值
`true`，完整 UTF-8 wire（包含内部 envelope 与 JSON 转义）上限为 64 KiB。只有当前对话用户明确确认后，模型才可填写
`userConfirmed=true`，例如用户说“可以，就按这么做”；它只是模型可填写的语义审计信号，不是授权凭证，不替代
OAuth、本机 enable、binding 或 Desktop 审批，也不承诺能够影响或绕过平台策略；完整计划仍可能
被 Desktop 或平台策略拦截、拒绝或要求审批。`idempotentHint` 仍只表示同一 `commandId` 防止
重复尝试，不代表网络 exactly-once。

本机命令、权限提示、64 KiB 消息限制、崩溃恢复和版本门禁见
[Desktop Control 操作说明](docs/desktop-control.md)。

## 解决什么问题

ChatGPT 付费订阅的网页版额度大量闲置，Codex 却在消耗紧张的 API 额度做
规划和 Review。本项目把"思考"交给你已付费的网页版 ChatGPT，Codex 只负责
执行。不用 API Key、不搞逆向代理——官方网页 + 默认只读 MCP 桥接。

## 这是什么

把 ChatGPT 网页版变成 Codex 编码会话的"规划与审查大脑"，而执行权完全保留在
Codex 手里。你的仓库永远不会被上传——ChatGPT 通过一条安全的、OAuth 保护的
**默认只读** MCP 连接，按需读取当前工作区里它真正需要的那几行代码。

## 本地 Fork 开发版

已配置 C2C 的 Windows 用户，在自己的 Fork checkout 内运行：

```powershell
powershell -NoProfile -File .\scripts\dev-install.ps1
# 需要同时运行测试时加 -Test
```

脚本使用锁定依赖构建 `dist/` 并生成 artifact `runtimeBuildId`，将程序和依赖独立复制到机器级
`releases/<buildId>`，校验后才原子切换 `current.json`，然后安装 Skill、best-effort 执行本机 rollout。
launcher 只运行校验过的已安装 release；重新 build、修改或移动源码 checkout 不会改变运行版本。
入口、安装脚本和依赖摘要随 build 封存；安装只使用构建快照，依赖在 build 后变化则拒绝安装。
旧 checkout pointer 会在依赖安装/构建前先冻结为同一个已安装版本；构建或 pointer 切换失败仍保留旧版。
Skill 使用机器状态目录内的稳定入口（Windows：`%LOCALAPPDATA%/codex-with-chatgpt/bin/c2c.js`），
以后只在要安装新版时重新 dev-install，新 Codex 会话加载新的 Skill。无需修改 PATH。
共享程序版本，隔离 workspace 的 OAuth/Connector/tunnel/session/Project/checkpoint/Desktop/records；
不执行首次配置，不清空状态，不改 Codex 配置。

rollout 只自动重启身份已认证、固定 URL 健康、Desktop/Remote 空闲且无配对/审批/未决结果的 named
workspace；固定 URL 保持不变。quick 永不自动重启，当前执行 turn、busy、unknown/corrupt 均跳过。
停止的 workspace 不启动，下次通过 launcher 启动自然使用当前 build。`status/doctor --json` 的
`runtimeUpgrade` 显示运行/安装 build 与 pending 原因；内部 build 更新不触发 Connector 迁移或重新授权。
单个 workspace 的 skip/error 不回滚安装。第一阶段没有常驻 Supervisor，可在空闲后运行
`node "<稳定 launcher 路径>" rollout --json` 重试（加 `-w <workspace>` 只处理一个工作区）。
并发 rollout 未取得机器锁时只报告 `rollout_busy`，不会写 pending 或其他 workspace 状态。

`origin` 指向自己的 Fork；`upstream` 指向
`https://github.com/XiaoDuoYa/codex-with-chatgpt.git`。正常开发分支继续跟随自己的 Fork。
显式维护源码时，在要检查的 Fork checkout 内运行 `node .\bin\c2c.js update-check --json`，
只读取该 checkout 的本地 Git 状态、必要时 fetch origin，
然后比较当前分支对应的 origin tracking branch。未设置 tracking 时尝试 origin 同名分支，
不会回退到 origin/HEAD；缺失、离线、detached HEAD 或 tracking 属于其他 remote 时明确跳过。

| 提交关系 | updateAvailable | 其他状态 |
| --- | --- | --- |
| 一致 | false | 两侧领先数为 0 |
| 仅 origin 领先 | true | remoteAhead=true，remoteAheadCount |
| 仅本地领先 | false | localAhead=true，localAheadCount |
| 分叉 | false | diverged=true，两侧领先数均报告 |
| 有未提交修改 | 由上述关系决定 | dirty=true，保留全部修改 |

同一 checkout / 分支 / origin 地址且远端引用未变时，当天复用上次 fetch 缓存；
切换后重新检查，缓存命中仍重新计算本地状态。
`--force` 强制刷新 origin；失败不会缓存为成功。只报告状态，禁止自动
pull/stash/merge/rebase/reset/checkout，也不自动部署或访问官方上游。

当前 `update-check` 按执行程序所在目录定位 Git 仓库。不可变 release 不含 `.git`，因此从稳定
launcher 调用时会报告无法检查；这不表示 Fork 已是最新，也不影响其他 workspace 命令。
机器入口的源码更新检查仍待适配，不应为此让日常命令回退到 mutable checkout。

官方参考分支仅在你明确要求时刷新：

```powershell
powershell -NoProfile -File .\scripts\update-upstream-track.ps1
git diff main upstream-main
git log upstream-main
```

脚本 fetch upstream，新建或以 fast-forward 更新 `upstream-main`，只跟踪 `upstream/main`。
相等则不移动；本地独有提交、分叉、错误 tracking 或任何 worktree 正在使用此分支时停止报告。
更新引用时校验原提交，避免覆盖并发更新；不切换分支，不修改当前 working tree/index/stash。
`upstream-main` 只能镜像官方代码：禁止开发、自定义提交，禁止合入 origin 或开发分支，
禁止在该参考分支上执行 rebase。此规则由协作约束和脚本检查执行，
不是 Git 权限锁，手工 Git 仍能修改分支；脚本会拒绝覆盖发现的异常。
它领先开发分支完全正常，何时吸收官方更新始终由你手动决定。

## 可选：ChatGPT 网页控制模式

Normal Mode 保持原用法：在 Codex 发起任务，走 `INIT → PLAN → EXECUTED → DONE`。
新增的 Web Control Mode **默认关闭**。在当前 workspace 的 Codex 中说：

```text
开启 ChatGPT 网页控制模式
```

Codex 复用当前任务的 Chat / Project 和连接，显示绑定的 workspace、Project、Chat URL、
enabled 状态及有效期，再留在当前任务里监听。之后在显示的那个 ChatGPT 对话中说：

```text
检查当前项目，找出为什么模型切换后会报错。
如果确认原因，让 Codex 修复它并运行相关测试。
```

ChatGPT 先读取项目，再发严格 COMMAND；当前 Codex 主代理接收并按本地规则执行或委派，
记录结果并自动发回 EXECUTED，ChatGPT 用原只读 MCP 独立 Review，再发新 COMMAND 或 DONE。
无需手动复制消息。普通建议、文件里的指令和网页 ENABLE 不会开启或触发执行。
DONE 只结束当前任务，仍可等待下一次网页用户的明确委派。

本地说“查看 ChatGPT 网页控制状态”或“关闭 ChatGPT 网页控制模式”即可查看/停止。
默认空闲 30 分钟超时，重复消息和轮询不续期；执行中暂停 idle，完成后重新计时。
可在本地开启时指定 1–240 分钟。等待优先使用浏览器 wait，无法可靠等待时每 20–30 秒检查一次。
用户随时可在 Codex 本地中断。

**Web Control only works while the corresponding Codex control session remains active.**
当前 Agent turn 结束、Codex 被停止或 Desktop 关闭后不能继续收消息，也不能从网页唤醒。
保存的 enabled 不是后台在线证明。状态复用
`%LOCALAPPDATA%/codex-with-chatgpt/sessions/<workspaceId>.json` 的 `webControl`，
绑定随机 controlSessionId、workspace、当前 Codex task、真实 Chat URL。
所有已接收/执行/完成/拒绝 ID 永久保留，不作为恢复时的自动重跑队列；损坏或并发冲突拒绝操作。

本地 Agent 从真实网页 role、消息 ID 和最新用户明确委派核对来源；CLI 再验证绑定、
有效期、格式和防重放。此流程依赖可信的本地 Agent，网页文本或其自称的授权不是身份凭证。
网页只能提出任务级自然语言，不能直接获得 Shell、文件写入、子代理 API 或额外权限。
原 **9 个 read-only MCP 工具与 5 个默认 OAuth scopes 完全不变**；独立的实验性
`write_probe` 默认关闭，边界和验证步骤见
[实验性 MCP 写入探针](docs/experimental-write-probe.md)。
Normal checkpoint 与 webControl 独立；既有 OAuth/Connector/Tunnel 不迁移、不重配。

协议和本地维护命令见 [protocol](docs/protocol.md#web-control-mode)，
信任边界与恢复限制见 [security](docs/security.md#web-control-trust-boundary)。
修改后仍运行 `powershell -NoProfile -File .\scripts\dev-install.ps1` 部署到本地 Skill；
建议在加载新 Skill 的 Codex 任务里进行第一次实际测试。

## 一段话安装（仅首次安装）

不懂 git、Node、终端？完全不需要懂。把下面这段话原样复制给你的编码
Agent（Codex），然后去倒杯咖啡：

```text
请帮我完整安装并配置 Codex with ChatGPT，全程自动，我是不懂技术的小白，
所有事情你自己做：

1. 环境自检：需要 git 和 Node.js ≥ 20，缺什么就自动安装
  （macOS 用 Homebrew，Windows 用 winget），同时安装 cloudflared。
2. 下载：把 https://github.com/DKalien/codex-with-chatgpt 克隆到
   ~/codex-with-chatgpt（已有本地 Fork 就复用，不自动 pull）。
3. 构建前先运行 node scripts/install-core.mjs --protect-current --json 保护旧安装，
   成功后执行 corepack pnpm install --frozen-lockfile 和 corepack pnpm build。
4. 安装机器 Core：运行 node scripts/install-core.mjs，再把 skill/SKILL.md 复制到
   ~/.codex/skills/codex-with-chatgpt/SKILL.md，将单一 launcher 占位符替换为安装输出的稳定路径。
   Windows 可直接运行 scripts/dev-install.ps1 完成以上构建/安装与安全 rollout。
5. 启用 ChatGPT 工作流：按 SKILL.md 的 Activation 路由复用现有状态，
   新工作区才首次配置；恢复连接、Project 和当前 Desktop 绑定也沿用该流程。
   全程只用内置浏览器，禁止打开任何第三方浏览器。
6. 只有登录、验证码、两步验证、首次 Project 创建或本机确认等必要用户动作才叫我，
   而且一次只告诉我一个动作。
7. 完成后给我看 ✓ 清单，并确认文件读取测试通过。我不懂 MCP、OAuth、
   Tunnel、端口这些词，不要向我解释；出了问题先自己修。
```

**更新**：Skill 每天只检查自己的 origin，有远端领先或分叉时报告，不自动更新。
源码部署与官方参考分支刷新见上方“本地 Fork 开发版”。

## 新工作区推荐

新工作区推荐直接对 Codex 说：**“启用 ChatGPT 工作流”**。现有 Skill 会自动复用
`setup`、`repair`、`session` 和 `Project` 流程，必要的用户动作一次只提示一个，完成连接与
工作区校验后最终运行 `desktop bind-current` 绑定当前 Desktop 会话。旧的 **“使用 Codex
with ChatGPT 完成首次配置”**、**“使用 Codex with ChatGPT，帮我实现 XXX”** 和 **“把这个会话
绑定并启用给 ChatGPT”** 话术仍然有效。

旧 Connector 会先检测 OAuth 和实际工具 schema，兼容则不动；不兼容只迁移当前工作区的同名
Connector，保留 Project/session/checkpoint。Desktop 工具始终可发现，调用权限仍受原门禁限制。
legacy 迁移中的 quick 地址会先升级为该工作区独立的 named 固定地址；域名无法唯一确定时只询问一次，
named 配置失败不会降级到 quick 并报告完成。

## 安装 → 配置 → 使用（手动版）

1. 安装机器 Core 与 Codex Skill：按上方开发安装流程部署稳定 launcher 和 Skill。
2. 对 Codex 说：**"启用 ChatGPT 工作流"**。
3. 之后正常使用：**"使用 Codex with ChatGPT，帮我实现 XXX。"**

说明书到此结束。你不需要知道 MCP、OAuth、Tunnel、端口、localhost 是什么——
Codex 会自动完成所有配置，你只会看到：

```
Codex with ChatGPT

✓ 当前项目已识别
✓ ChatGPT 已连接
✓ 当前 Desktop 会话已绑定，空闲时可接收后续任务

Ready.
```

需要你操作时一次只提示一个动作：首次配置/连接偏好选择、本机绑定确认（不会代点），以及登录 ChatGPT（如果要用固定域名，再登录一次 Cloudflare）。**新仓库**还会请你在 ChatGPT 里建一次项目（合集）：名字用仓库名，记忆选「仅限项目记忆」。侧栏如果没有「项目」，把鼠标放在「聊天」上，点右边三个点，选「按项目整理」。之后对话都从合集页开，不用回首页。已经在用的仓库默认还是原来的一条长对话，除非你说要改成 Project。

### 可选的固定域名

默认公网地址是临时的，桥重启后会变。Codex 会删掉这个项目的 ChatGPT 插件再按新地址加回去。

如果你有 Cloudflare 账号，并且域名已经加在 Cloudflare 上，首次配置时（老用户则在下一次编码时问一次）会问你要不要用固定域名，例如 `c2c-<项目>.你的域名`。选是的话，浏览器里授权一次 Cloudflare 即可。之后重启一般不用再改插件。普通配置中没有账号、不想用或登录失败时，可以继续用临时地址，功能一样，只是修复更慢。旧 Connector migration 必须使用 named；失败保留原状态并报告未就绪，不降级回 quick。

凭证放在系统目录，不进项目。

## 工作原理

```
             ┌───────────────────────────┐
             │      ChatGPT 网页版       │
             │   推理 / 规划 / 审查      │
             └──────────┬──────────▲─────┘
                        │          │
               MCP      │          │ Computer Use
              数据面    │          │ 控制面（消息 < 1 KB）
                        ▼          │
             ┌─────────────────────┐
             │      C2C Bridge     │   仅监听本机回环地址
             │  默认只读 MCP       │   OAuth 2.1 + 一次性配对码
             │  OAuth + 配对       │   Cloudflare Quick Tunnel
             │  Tunnel 管理        │
             └──────────┬──────────┘
                        │  只读
                        ▼
             ┌─────────────────────┐          ┌─────────────────────┐
             │     本地工作区      │◀─────────│    Codex Harness    │
             └─────────────────────┘ 编辑/git │  Shell / 测试 / 修复 │
                                              └─────────────────────┘
```

- **控制面（Computer Use）**：Codex 与 ChatGPT 之间只交换极小的结构化 `[C2C]`
  状态消息——`INIT → PLAN → EXECUTED → REVIEW → DONE`。绝不粘贴 diff、日志
  或文件内容。
- **数据面（MCP）**：ChatGPT 缺什么自己拉什么，原有 9 个只读工具：
  `workspace_info`、`list_directory`、`read_file`、`search_workspace`、
  `git_status`、`git_diff`、`test_status`、`execution_summary`、
  `execution_output`。明确授权的 Desktop Control 工具和实验性 `write_probe` 均为独立
  能力，见 [Desktop Control](docs/desktop-control.md) 与
  [实验性 MCP 写入探针](docs/experimental-write-probe.md)。
- **独立审查**：Codex 执行完毕后，ChatGPT 通过 MCP 亲自检查真实的 git diff
  和测试记录——绝不因为 Codex 说"测试全过"就直接相信。

## 安全模型（简版）

- **默认从构造上只读**：原 9 个工具只读取工作区数据。可选的 `write_probe` 只有
  在开启环境变量并取得 `probe.write` scope 时，才会覆盖一条 C2C 状态记录；它不能
  写工作区文件、删除文件、执行 Shell 或提交，提示注入也无法启用这些能力。
- **Desktop 投递单独受限**：`codex_desktop_send` 只有在取得
  `codex.desktop.control` 且本机明确启用绑定后，才能向一个已有 Desktop 会话发送已确认的
  任务正文；它不是直接写文件或执行 Shell 的 RPC。
- **一个工作区 = 一道边界**：每个令牌绑定单一工作区；路径校验基于规范化
  realpath（symlink、`../`、绝对路径逃逸全部被拦截并有测试覆盖）。
- **敏感文件永不外泄**：`.env*`、密钥、SSH、各类凭据默认拒绝
  （`.env.example` 放行）；`.c2cignore` 可追加自定义规则。
- **知道 URL 不等于有权限**：公网 MCP 端点强制 OAuth 2.1（PKCE S256、动态
  客户端注册、refresh token 轮换）。无令牌：401；令牌属于别的工作区：403。
- **模型永远接触不到长期凭据**：唯一会出现在浏览器里的秘密是一次性配对码
  （5 分钟有效、限 5 次尝试、限速、用后即毁）。

完整威胁模型：[docs/security.md](docs/security.md)

## 开发者

```bash
pnpm install --frozen-lockfile
pnpm run build      # 产出 dist/ 与确定性 build ID，不切换已安装 Core
pnpm test --maxWorkers=1 --testTimeout=60000
pnpm run typecheck
git diff --check

# 明确进行源码开发验证时使用当前 checkout：
pnpm dev -- status --json
```

日常 workspace 命令使用 `node "<稳定 launcher 路径>" <命令> -w <workspace>`。
Windows 的 `scripts/dev-install.ps1` 在构建成功后安装 Core 与 Skill；busy/unknown workspace
不会被重启。开发边界见 [AGENTS.md](AGENTS.md)。

环境要求：Node.js >= 20、git；公网连接需要 `cloudflared`
（自动检测，Skill 会替你安装）。

文档：[架构](docs/architecture.md) · [协议](docs/protocol.md) ·
[安全](docs/security.md) · [Desktop Control](docs/desktop-control.md) ·
[故障排查](docs/troubleshooting.md)

## 目录结构

```
src/
  core/       已安装 release 元数据、安全 rollout 与待升级状态
  bridge/     本机回环 HTTP 服务、端口自动恢复、管理 API
  mcp/        9 个只读工具 + 始终可发现但独立鉴权的 Desktop 工具 + 可选 Remote Control/探针
  remote/     持久队列、Controller、官方 app-server 客户端
  desktop/    本机 Desktop 绑定、IPC 投递和防重放状态
  auth/       OAuth 2.1（PKCE、动态注册、refresh 轮换、吊销）
  pairing/    一次性配对码（CSPRNG、TTL、限速）
  workspace/  路径收敛、敏感文件策略、搜索、git
  tunnel/     TunnelProvider 抽象 + Cloudflare Quick/Named Tunnel
  execution/  审查闭环所需的执行记录
  process/    守护进程生命周期
  cli/        c2c 命令行
skill/        Codex Skill（真正的 UX 层）
tests/        单元 + 集成测试
docs/         架构 / 协议 / 安全 / 故障排查
```

## 状态与声明

V1。Setup 与 Activation 自动完成本机可执行步骤；登录、首次 Project 创建和 Desktop 绑定确认
仍需用户操作。本机构建/测试通过不代表所有运行中的 workspace 已使用已安装 Core；
应只读检查 `runtimeUpgrade`，并独立验证目标 workspace 的真实连接。

Desktop Control 仍是实验性功能；假 Desktop/假 IPC 自动化检查不等于真实 Desktop 的人工
端到端验收，不能据此宣称真实会话已经验证。

**非官方社区项目，与 OpenAI 无关联，未获其背书。**

## 许可证

[MIT](LICENSE)
